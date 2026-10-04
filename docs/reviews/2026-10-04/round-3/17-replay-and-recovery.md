# Третий проход: lifecycle сохранённой кампании, replay и восстановление

Аудит выполнен на production baseline
`e1d927f5aa68dc9eca912b527cccf3974ba3e9e7`. Проверялись только временные
каталоги, созданные probe-скриптом; рабочие `storage/`, `.env` и настоящие
backup не читались и не изменялись. Runtime-код не менялся.

RCV-01 и RCV-02 требуют потери или рассогласования файлов на диске: это
операционный recovery-риск, а не обход игрового API из внешнего запроса. RCV-03
относится к целостности внешнего map storage после такой операции. Здоровый
HTTP backup/restore path отдельно принят существующей restore rehearsal.

Проба запускается так:

```powershell
node --check docs/reviews/2026-10-04/round-3/replay-recovery-probe.mjs
node docs/reviews/2026-10-04/round-3/replay-recovery-probe.mjs
```

Она создаёт synthetic `FileEventStore`, карты и зашифрованные backup в
`%TEMP%`, после чего удаляет временные каталоги. Последний запуск завершился с
кодом 0. Важные результаты:

| Сценарий | Наблюдение |
| --- | --- |
| удалён единственный event commit при сохранённых snapshot и metadata | `load()` вернул версию `0`, `counter=0`, `pendingProjection=null`; файл metadata при этом сохранял `state_version=1` |
| удалён snapshot версии 0 новой кампании | `load()` завершился успешно, но вернул только `{state_version: 0}` вместо исходной кампании |
| изменён JSON map blob при прежнем имени hash-файла | `missing=[]`, checksum snapshot прошёл, `load()` получил `terrain=lava`, а replay от исходного seed — `floor` |
| повреждён snapshot версии 1 при наличии корректного snapshot 0 | обычный `load()` выбросил `CORRUPT_EVENT_LOG`, а `replay({use_snapshots:false})` вернул правильный `counter=1` |
| backup содержит room, опережающую event stream | byte reconciliation успешна, но `auditLegacyCutover` после restore сообщил `PROJECTION_DIVERGENCE` и `PROJECTION_VERSION_DIVERGENCE` |
| authenticated backup с конфликтующими путями `a` и `a/b` | restore оставил частичный target с `a`, повтор получил `RESTORE_TARGET_NOT_EMPTY` |

## Находки

### RCV-01 — P1 operational storage-loss — потеря хвостового event-файла молча откатывает кампанию к нулевой версии

Тип: confirmed · confidence: high.

`FileEventStore._readCommits` начинает проверку с версии 0 и проверяет
непрерывность только найденных имён файлов
([`event-store.mjs#L401-L430`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L401-L430)).
Если последний файл исчез, `readdir` возвращает пустой список, а не запись о
пропуске. `_exists` всё ещё считает кампанию существующей по одному
`metadata.json` или snapshot
([`event-store.mjs#L293-L299`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L293-L299)).
Затем `_load` принимает `currentVersion=0`, выбирает snapshot 0 и возвращает
его как голову потока
([`event-store.mjs#L541-L581`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L541-L581)).

Probe создаёт кампанию с `counter=0`, коммитит `Increment(1)` и получает оба
snapshot — версии 0 и 1. После удаления единственного event-файла обычный
`load()` возвращает:

```json
{
  "loaded_state_version": 0,
  "loaded_counter": 0,
  "metadata_state_version": 0,
  "metadata_file_state_version": 1,
  "pending_projection": null
}
```

Последняя строка важна: обычный путь восстановления не видит, что проекция
потеряла подтверждённый commit. `_readMetadata` переписывает сохранённые
`state_version` и `current_version` значением, вычисленным из найденного
журнала
([`event-store.mjs#L434-L447`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L434-L447)).
Если compatibility room ещё содержит версию 1, последующий reconcile получает
версию 0 и может принять старое состояние за authoritative. Если room уже
удалена, ошибка вообще не видна до следующего пользовательского действия.

Это отдельный случай от уже проверяемого разрыва *между двумя существующими*
event-файлами: если после пропуска остаётся более новый файл, текущая проверка
непрерывности корректно выбрасывает `CORRUPT_EVENT_LOG`. Дефект относится к
неразличимому окончанию потока, когда следующего имени файла нет.

Сценарий требует доступа к storage или неудачного восстановления backup;
обычный клиентский command route не может удалить event-файл или изменить
metadata.

Минимальное исправление — перед загрузкой сравнивать фактический head журнала с
доказательствами более новой версии: как минимум с `metadata.state_version` и
максимальным пригодным snapshot. Если metadata или snapshot старше найденного
event head, обычная игровая загрузка должна вернуть typed
`CAMPAIGN_RECOVERY_REQUIRED`/`CORRUPT_EVENT_LOG`, а не нормализованный state 0.
Для crash между event commit и metadata write сравнение должно быть
односторонним: более новый event head при старой metadata допустим, но более
старая найденная голова относительно metadata — нет. Дополнительный durable
head marker с `last_commit_id` и диапазоном версии упростит это правило, но не
должен подменять проверку самих файлов.

Нужен regression, который удаляет только последний commit после успешной
команды и проверяет, что `load`, `pendingProjection`, `getMetadata` и
`reconcileCampaignProjection` не принимают откат. Восстановление из backup должно
оставаться отдельной операцией с явным результатом, а не побочным эффектом
первого GET комнаты.

### RCV-02 — P1 operational storage-loss — snapshot версии 0 является единственным seed новых кампаний, но его потеря выглядит как пустая валидная кампания

Тип: confirmed · confidence: high.

`initializeCampaign` нормализует исходное состояние и пишет его только в
snapshot версии 0, затем создаёт metadata; `CampaignInitialized` события в
журнал не добавляется
([`event-store.mjs#L620-L652`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L620-L652)).
По умолчанию `initialStateFactory` возвращает `{}`
([`event-store.mjs#L191-L223`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L191-L223));
production instance в `index.mjs` factory не переопределяет
([`index.mjs#L294-L305`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L294-L305)).
Когда snapshot не найден, `_load` считает factory доверенным исходным состоянием
и спокойно применяет поверх него оставшиеся события
([`event-store.mjs#L559-L575`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L559-L575)).

Probe инициализирует `{campaign: "Seed only in snapshot", counter: 7,
players: [...]}`, удаляет `0000000000000000.json`, затем открывает новую
экземпляром production-shaped store. Ответ не содержит ошибки:

```json
{
  "snapshot_files": [],
  "loaded_without_error": true,
  "original_campaign": "Seed only in snapshot",
  "loaded_campaign": null,
  "loaded_counter": null,
  "loaded_state_keys": ["state_version"]
}
```

Таким образом, snapshot — одновременно cache и единственная запись исходного
состояния. При его потере общий recovery path не может отличить «кампания
пустая» от «seed потерян». `replay({from_initial:true})` не исправляет это для
новой кампании: production factory также возвращает `{}`. Legacy import
устроен лучше, потому что исходное состояние лежит в `LegacyStateImported`, но
это не покрывает обычный путь создания кампании.

Есть и отдельная асимметрия выбора snapshot. При checksum mismatch свежего
snapshot `_readSnapshot` сразу выбрасывает typed `CORRUPT_EVENT_LOG`
([`event-store.mjs#L475-L503`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L475-L503)),
хотя корректный snapshot 0 и event stream позволяют получить ту же версию:
probe получил `CORRUPT_EVENT_LOG` от обычного `load()`, но
`replay({use_snapshots:false})` восстановил `counter=1`. В отличие от этого,
отсутствующий map blob и snapshot с устаревшим `projector_version` переходят к
предыдущему кандидату. Само fail-closed поведение для checksum mismatch не
считаю дефектом: повреждение может означать tampering, и обычный игровой путь
вправе остановиться. Восстановление из старого seed/snapshot или replay должно
быть отдельной maintenance-операцией с журналом выбранного источника, а не
неявным fallback внутри `load()`.

Название `use_snapshots:false` также шире фактической гарантии: фильтр оставляет
snapshot версии 0
([`event-store.mjs#L475-L480`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L475-L480)).
В probe изменённый map blob поэтому сохранился и в обычном «полном replay»;
только `fromInitial:true` использовал factory с исходной картой. Такой replay
нельзя считать независимой проверкой snapshot 0 для production кампаний; это
ограничение названия и maintenance semantics, а не требование автоматически
принимать подозрительный snapshot.

Варианты исправления:

1. Добавить в журнал versioned seed event (`CampaignInitialized`) или отдельный
   immutable seed artifact с checksum и campaign id. Это делает восстановление
   из событий независимым от snapshot 0; смену нумерации событий нужно оформить
   схемой/миграцией.
2. До такой миграции считать отсутствие snapshot 0 при отсутствии seed
   доказанной потерей и возвращать `CAMPAIGN_RECOVERY_REQUIRED`, даже если
   metadata существует. Не создавать «пустое» состояние и не продолжать игру.
3. В recovery CLI выбирать последний checksum-valid snapshot или replay из
   seed, писать подробный manifest выбранного источника и оставлять обычный
   gameplay path fail-closed. Добавить тесты для явной maintenance-команды:
   повреждённый latest snapshot, повреждённый v0, удалённый v0 и
   legacy/current mixed replay.

Нельзя лечить это простым `initialStateFactory: () => ({})` заменой на чтение
комнаты: compatibility room — производная запись, а чтение её как seed
создаст второй источник истины и снова сломает replay.

### RCV-03 — P2 — MapStore не проверяет content hash при чтении, поэтому повреждённый blob проходит snapshot checksum

Тип: confirmed · confidence: high.

`MapStore.put` адресует файл digest содержимого, но `MapStore.get` после
`JSON.parse` только кладёт результат в cache и возвращает его
([`map-store.mjs#L91-L128`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/map-store.mjs#L91-L128)).
При чтении ссылки `internalizeMaps` считает любой непустой parsed object
успешным восстановлением
([`map-store.mjs#L250-L299`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/map-store.mjs#L250-L299)).
Контрольная сумма snapshot при этом считается по externalized state — по самой
ссылке, включая старый hash, а не по байтам map blob
([`event-store.mjs#L513-L526`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L513-L526)).

Probe записывает нормальную карту, затем заменяет тот же файл валидным JSON с
`terrain=lava`, очищает cache и открывает новый `MapStore`. Результат:

```json
{
  "map_hash_matches_ref": false,
  "missing_refs": [],
  "snapshot_checksum_still_valid": true,
  "loaded_terrain": "lava",
  "replay_terrain": "lava",
  "from_initial_replay_terrain": "floor"
}
```

Повреждение не вызывает fallback: для event store ссылка считается найденной,
snapshot — checksum-valid, а карта после restart уже другая. В работающем
процессе cache может временно скрывать повреждение; после restart тот же диск
даёт другой мир. Это делает результат зависимым от времени чтения и особенно
опасным для recovery rehearsal.

Рекомендация — в `MapStore.get` после parse вычислять тот же digest и при
несовпадении возвращать typed `MAP_BLOB_HASH_MISMATCH`/`null` с отдельным
диагностическим кодом. `internalizeMaps` тогда сможет использовать уже
существующий безопасный fallback на предыдущий snapshot или event replay.
Проверка должна выполняться и для cache entries либо cache должен хранить только
неизменяемые копии; иначе caller может испортить объект, который будущий load
получит без чтения диска. Нужны тесты для valid JSON с неверным hash,
потерянного файла, cache hit до/после restart и byte-for-byte replay.

Не следует считать достаточной проверку SHA-256 backup entry: она доказывает,
что backup восстановил тот же повреждённый blob, но не то, что blob
соответствует map reference в snapshot.

### RCV-04 — P2/P3 — граница domain-аудита restore и защита от вручную созданного архива с конфликтом путей

Тип: confirmed boundary · confidence: high for byte/domain gap, medium for
malformed archive path case.

`restoreStorageBackup` проверяет authenticated envelope, размер и hash каждого
файла, пишет entries прямо в target, а затем вызывает только
`compareStorageToBackup`
([`backup-service.mjs#L149-L190`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L149-L190),
[`backup-service.mjs#L259-L289`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L259-L289)).
`validatePayload` запрещает абсолютные и `..` пути и дубликаты, но не запрещает
один path быть префиксом другого
([`backup-service.mjs#L49-L65`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L49-L65),
[`backup-service.mjs#L149-L174`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L149-L174)).

В первом synthetic сценарии source намеренно содержит room версии 1 и
event-stream версии 0. `createStorageBackup` и `restoreStorageBackup` проходят,
`reconciliation.identical=true`, но `auditLegacyCutover` на restored каталоге
возвращает `ready=false` с блокерами
`PROJECTION_DIVERGENCE` и `PROJECTION_VERSION_DIVERGENCE`. Это ожидаемо для
архива, снятого с уже рассогласованного источника, однако API сообщает
`restored: true`, не предлагая domain-level проверку. Здоровый остановленный
source проходит существующий `test/restore-rehearsal-api.test.mjs`; находка
относится к границе обещания инструмента, а не к поломке happy path.

Во втором synthetic сценарии probe вручную создаёт корректно зашифрованный
payload с entries `a` и `a/b`. Такой payload проходит текущую валидацию, первая
запись создаёт файл `a`, затем `mkdir(target/a)` падает с `EEXIST`. Target
остаётся частично заполненным, а повтор restore получает
`RESTORE_TARGET_NOT_EMPTY`. У реальной файловой системы source не может
содержать одновременно файл `a` и каталог `a`, поэтому это не утверждение, что
штатный `createStorageBackup` генерирует такой архив. Это недостающая проверка
границы доверенного или повреждённого backup и плохая уборка после ошибки.

Для restore полезны два независимых шага:

1. Валидировать namespace manifest как дерево: после сортировки entries
   отклонять `a/b`, если раньше встречен файл `a`, с детерминированным
   `BACKUP_PAYLOAD_INVALID`. Это дешёвый fail-closed guard.
2. Писать в новый staging sibling, закрывать и сверять его, затем запускать
   `auditLegacyCutover`/replay-проверку до выдачи статуса «готово к активации».
   При любой ошибке удалять только известный staging каталог; исходный target
   не должен превращаться в частичную рабочую копию. Семантический аудит лучше
   оставить отдельным от низкоуровневого `restoreStorageBackup`, но CLI должен
   предложить его штатным флагом или отдельной командой.

Следует сохранить текущую операционную оговорку: backup снимается после
остановки записи, а замена рабочего storage выполняется отдельно после
rehearsal. Эта оговорка закрывает гонку между файлами на штатном пути, но не
проверяет уже рассогласованный источник и не делает restore атомарным.

## Что проверено и не стало новой находкой

- При потере map blob текущий `_readSnapshot` действительно пропускает
  непригодный snapshot и переходит к предыдущему, затем к replay. Это уже
  существующий robust fallback; новая находка RCV-03 касается только валидного,
  но изменённого JSON, который fallback не распознаёт.
- Snapshot с несовпавшим `projector_version` версии выше нуля пропускается, и
  mixed old/current event markers продолжают обрабатываться per-event. Поэтому
  отдельную ошибку «старый projector всегда ломает recovery» не заявляю.
- Разрыв между двумя существующими event commits уже обнаруживается как
  `CORRUPT_EVENT_LOG`; RCV-01 относится только к отсутствующему хвостовому
  marker, который нечем сравнить внутри `_readCommits`.
- Healthy stopped backup проходит byte compare, restore rehearsal, новый запуск
  сервера и продолжение команды. Это подтверждено существующим
  `test/restore-rehearsal-api.test.mjs`, поэтому finding RCV-04 не предлагает
  переписывать формат шифрования или успешный путь.

## Следующий порядок работ

1. Ввести typed recovery-required состояние для metadata/snapshot, которые
   показывают более высокую версию, чем найденный event head; исключить тихий
   откат и пустую кампанию.
2. Зафиксировать durable seed обычной кампании в событии либо отдельном
   checksum-артефакте, затем добавить честный replay-from-seed. До миграции
   `fromInitial` не считать универсальным recovery для production data.
3. Проверять content hash map blob при каждом cache miss и покрыть это проверками
   restart/replay.
4. Разделить file restore и domain validation; добавить staging restore,
   path-prefix validation и тест рассогласованного room/event stream.

Probe-only проверка не запускала полный `pnpm verify` и не меняла runtime. Для
этого прохода достаточно `node --check` probe и её exit 0; перед реализацией
исправлений нужны отдельные focused tests на event-store, map-store, backup и
recovery CLI, затем обязательный общий gate.
