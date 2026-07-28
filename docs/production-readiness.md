# Production readiness и release gates

> **Статус этапа 8 (2026-07-28):** legacy/shadow runtime удалён, `pnpm
> cutover:verify` зелёный, репетиция восстановления и soak с принудительными
> остановками проходят в обычном прогоне (см. раздел ниже). Release gate для
> существующих данных остаётся закрыт по **правам и лицензии**, а не по
> целостности: `pnpm release:verify` держат неподтверждённые права на
> dnd.su-каталог и визуальные assets, невыбранная лицензия собственного кода,
> незакреплённые container digests и непройденное rollback window.

## Контентный шлюз

Обычная проверка целостности:

```powershell
pnpm content:verify
```

Команда проверяет:

- SHA-256 и размер каждого зарегистрированного content artifact;
- полноту реестра всех файлов `public/assets`;
- Rule Pack, ontology и ссылки `rule.entity_refs → glossary`;
- formalization counts из `coverage.yaml`;
- ссылки spell overrides, spells, classes и character-build catalog;
- runtime-счётчики classes/subclasses/spells/monsters/equipment/glossary;
- наличие обязательного SRD 5.2.1 attribution statement.

Строгий release gate:

```powershell
pnpm release:verify
```

Он выполняет те же проверки и возвращает ненулевой код, пока существует хотя
бы один content, licensing или provenance blocker. Текущий отказ ожидаем:
корпус SRD неполон, лицензия проекта не выбрана, права на dnd.su compatibility
catalog и визуальные assets не подтверждены, fonts/container digests не
зафиксированы. Эти блокеры нельзя закрывать предположением.

Источники истины:

- `data/rules-coverage-matrix.json`;
- `data/content-provenance.json`;
- `data/asset-rights.json`;
- `ATTRIBUTION.md`;
- `THIRD_PARTY_NOTICES.md`.

Изменение зарегистрированного файла требует осознанного обновления его hash,
размера, источника и rights status. Обновлять hash без проверки происхождения
нельзя.

## Зашифрованные backup и restore rehearsal

Ключ передаётся только через environment и должен иметь не менее 32 UTF-8
байт:

```powershell
$env:DND_BACKUP_KEY='<secret from deployment secret manager>'
pnpm backup -- create .\storage D:\backups\skazanie-2026-07-24.skzbackup
pnpm backup -- verify D:\backups\skazanie-2026-07-24.skzbackup
pnpm backup -- compare .\storage D:\backups\skazanie-2026-07-24.skzbackup
pnpm backup -- restore D:\backups\skazanie-2026-07-24.skzbackup D:\restore-rehearsal\empty
```

Формат использует `scrypt` и `AES-256-GCM`, не пишет ключ или открытые данные в
manifest, проверяет authenticated envelope и SHA-256 каждого файла. Backup
создаётся только вне исходного storage и не перезаписывает существующий файл.
Restore разрешён только в отсутствующий или пустой каталог; замена рабочего
storage выполняется отдельно после успешного compare/rehearsal.

Необходимо хранить ключ отдельно от backup, проверять восстановление по
расписанию и применять retention policy средствами deployment. Автоматическое
удаление старых backup намеренно не включено в приложение.

## Quota и cost observability

`DND_AI_DAILY_TOKEN_LIMIT` задаёт дневной предел, по умолчанию `2000000`.
Перед запросом резервируется оценка input + максимального output; после ответа
записываются фактические provider tokens/cost. Ledger находится в
`storage/engine/llm-usage.json`, не содержит prompts и переживает restart.
Зависшие reservations освобождаются через 15 минут, записи старше 31 дня
удаляются при следующей операции.

Администратор читает агрегаты через `GET /api/admin/usage`. Публичный
`/api/health` не раскрывает стоимость и квоту. Fallback client сохраняет
ограничение tool calls/timeouts и circuit-breaker cooldown для проблемных
моделей.

## Закрыто 2026-07-28: cutover, soak и репетиция восстановления

**`pnpm cutover:verify` зелёный.** Он был красным у любой кампании с вынесенной
из снимка картой — то есть у всех, — и причина оказалась не в данных, а в самой
проверке: `server/cutover-audit.mjs` создавал `FileEventStore` **без**
`MapStore`. Снимок хранит карту ссылкой (`skazanie:map-ref-v1` + хеш), комната —
клетками; без хранилища карт ссылка не разворачивалась, и сверка сцены
сравнивала ссылку с клетками. Совпасть это не могло никогда. Данные всё это
время были целы: после правки `projection_matched` и `replay_matched` сходятся
на живой кампании.

Заодно уточнён критерий `PROJECTION_CHECKPOINT_HASH_MISMATCH`. Контрольная
точка хранит хеш, посчитанный кодом того дня, поэтому любое изменение
`normalizeCampaignState` делает старую отметку несовпадающей, хотя на диске всё
цело. Теперь это блокер только когда о беде говорит что-то ещё — расхождение
проекции или неподтверждённая запись; иначе замечание
(`STALE_CHECKPOINT_AFTER_SCHEMA_CHANGE`), и сервер обновит отметку при
следующей записи проекции. Настоящая защита держится на `projection_matched` и
`pending_projection`, а не на исторической отметке.

**Soak с принудительными остановками.** `test/soak-crash-recovery-api.test.mjs`
трижды убивает сервер `SIGKILL` посреди волны конкурентных команд от двух
героев, причём убивает по факту первого подтверждения, а не по таймеру — так
авария гарантированно приходится на промежуток между подтверждённым событием и
записанной проекцией. После каждой аварии проверяются три инварианта: поток
переигрывается в то же состояние без снимков, каждая подтверждённая команда
осталась ровно одной записью, а поднявшийся сервер сам приводит проекцию в
согласие (аудит без блокеров). В конце — повтор ключа: идемпотентность
переживает падение.

**Репетиция восстановления.** `test/restore-rehearsal-api.test.mjs` проводит
полный цикл: живая кампания с подтверждёнными командами → архив → verify →
сверка с источником → восстановление в чистый каталог → **новый сервер на
нём** → вход тем же аккаунтом, та же версия состояния, продолжение игры новой
командой, аудит целостности без блокеров. Чужой ключ архив не открывает.
Прежние юнит-тесты доказывали честность формата; эта проверка доказывает, что
из архива поднимается работающая игра.

## Незакрытые production gates

- заменить partial compatibility catalogs полным разрешённым SRD 5.2.1
  corpus и deterministic/structured coverage;
- принять лицензию собственного кода и подтвердить права на assets/fonts;
- закрепить container images digest-ами и сформировать полный SBOM;
- выполнить реальный provider E2E под нагрузкой и multi-process coordination
  (single-process soak и restore rehearsal закрыты, см. раздел выше);
- провести canary/rollback window;
- определить deployment-level encryption at rest, backup retention и key
  rotation.
