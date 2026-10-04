# RCV-05 — согласованность backup при живом commit

Дата проверки: 2026-10-04. Runtime-источник для выводов зафиксирован на
`e1d927f5aa68dc9eca912b527cccf3974ba3e9e7`. Проверялся вопрос: может ли
штатный `createStorageBackup` получить архив из согласованных по отдельности
файлов, но из разных версий одного production `FileEventStore`, если commit
идёт одновременно.

## Итог

Да. Ограниченный двухпроцессный probe воспроизвёл живой interleave и получил
аутентичный backup, который `verifyStorageBackup` и `restoreStorageBackup`
приняли по байтам, но после восстановления оказался доменно несогласованным:
event log заканчивался на версии 1, а `metadata.json` уже указывал версию 2.
Восстановленное состояние совпало с состоянием до конкурентного commit, тогда
как metadata пришла от состояния после него.

Это не означает, что штатный backup уже обещает live-backup safety. В
документации описаны формат архива, verify/compare и ограничения restore, но
для обычного `backup create` явное требование остановить writer не закреплено;
CLI также не проверяет эту предпосылку. Архитектура называет file adapter
single-writer, а остановка записи явно упомянута в процедурах миграции и
отдельного recovery preview, но это не то же самое, что общий offline-контракт
для backup. Поэтому подтверждённый результат — operational boundary gap:
если будущий scheduler, оператор или отдельный процесс вызовет helper рядом с
живым writer, helper не откажет и не проверит согласованность домена. Пока
граница не уточнена и не координируется, live backup нельзя считать
поддержанным безопасным режимом.

## Почему interleave возможен

В pinned runtime `collectFiles` рекурсивно получает имена и размеры через
`readdirSync`, но lock event store не читает. После полного списка
`createStorageBackup` отдельным проходом открывает каждый файл и строит
payload. См. [backup-service.mjs#L68-L81](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L68-L81)
и [backup-service.mjs#L199-L218](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L199-L218).

Коммит `FileEventStore` удерживает только свой campaign lock. Сначала он
публикует новый immutable event file, затем при необходимости snapshot и в
конце обновляет metadata. См. [event-store.mjs#L308-L341](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L308-L341)
и [event-store.mjs#L832-L839](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L832-L839).
Этот lock не является общей точкой синхронизации с backup.

Probe останавливал только чтение каталога `events` после того, как backup
получил список старых файлов. Пока backup был на этой паузе, второй процесс с
тем же production-shaped `FileEventStore` завершал commit версии 2. После
этого backup продолжал штатное чтение байтов. Такой interleave даёт старый
список event files и новое `metadata.json`, не требуя повреждать или вручную
создавать архив.

## Методика и границы

Использован [bounded-live-backup-probe.mjs](./bounded-live-backup-probe.mjs).
Он запускает два дочерних Node-процесса в новом каталоге ОС:

1. writer создаёт кампанию через production-конфигурацию `FileEventStore` из
   `server/index.mjs`: `engine` root, `applyGameEvent`,
   `normalizeCampaignState`, текущие reducer/projector versions и `MapStore`;
2. writer делает baseline commit и сам проверяет `load`, replay без snapshot,
   event log, metadata, snapshot checksum и map refs;
3. backup вызывает настоящий `createStorageBackup`, а единственная
   instrumentation hook ставит барьер после реального `readdirSync(events)`;
4. writer делает обычный второй commit, снова проходит те же проверки, после
   чего backup продолжается;
5. настоящий `verifyStorageBackup` запускается и в backup-процессе, и в parent;
6. настоящий `restoreStorageBackup` восстанавливает архив в новый временный
   каталог, после чего новый production-shaped store проверяет load/replay и
   сырые metadata/log/snapshot/map файлы.

Probe не импортирует рабочий `.env`, не использует рабочий `storage/`,
production key, новые зависимости или изменения runtime. Архив не
подделывается: он создан штатным API. После отчёта временный каталог удаляется.

## Наблюдения

| Проверка | Результат |
| --- | --- |
| Healthy source до гонки | `event_head=1`, metadata `1/1`, snapshot `0`, checksums и 2 map refs валидны; `load` и replay совпадают |
| Каталог events, увиденный backup | только commit версии `0→1` |
| Healthy source после writer commit | `event_head=2`, metadata `2/2`, два contiguous commit-а; `load` и replay совпадают |
| Новый event, отсутствующий в уже собранном backup listing | commit версии `1→2` |
| Свежий primary backup | `file_count=5`, `total_bytes=11287`, encrypted; verify успешен в двух процессах |
| Byte compare backup с уже продвинувшимся source | `identical=false`, только новый event file в `unexpected`; metadata совпала с post-commit bytes |
| Restore byte reconciliation | `identical=true`; все 5 файлов восстановлены без расхождения |
| Restore domain check | `event_head=1`, raw metadata `state_version=2/current_version=2`; `load/replay=1`; `snapshot=0`, map refs валидны; `healthy=false` |
| Состояние restore относительно healthy источников | fingerprint совпал с состоянием **до** commit и не совпал с состоянием **после** commit |

Ключевое доказательство — не сам `unexpected` файл после compare: он лишь
показывает, что source продолжил жить. Сильнее то, что authenticated archive
восстанавливается byte-for-byte, но `metadata_state_version > event_head`.
Низкоуровневый verifier не видит этой границы, потому что он проверяет
envelope, размеры и SHA-256 entries. `restoreStorageBackup` после записи делает
такой же file compare; domain replay/audit в него не входит. См.
[backup-service.mjs#L240-L252](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L240-L252)
и [backup-service.mjs#L259-L289](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/backup-service.mjs#L259-L289).

## Операционная классификация

Источники задают здесь разные уровни требований. [production-readiness.md#L53-L74](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/docs/production-readiness.md#L53-L74)
описывает ключ, формат архива, verify/compare и границы restore, но не требует
остановить writer перед обычным backup. [README.md#L734-L766](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/README.md#L734-L766)
требует остановить запись перед миграцией и отдельной проверкой отсечённой
памяти; эти указания не сформулированы как общий запрет на живой `pnpm backup`.
CLI usage в [storage-backup.mjs#L28-L41](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/tools/storage-backup.mjs#L28-L41)
также не сообщает об offline-предпосылке и не устанавливает runtime guard.
Архитектура прямо называет file adapter single-writer и offline import:
[current-architecture.md#L190-L202](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/docs/current-architecture.md#L190-L202),
[current-architecture.md#L237](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/docs/current-architecture.md#L237).

Следовательно, правильный вывод такой:

- probe подтверждает, что live backup может собрать аутентично
  зашифрованный, но доменно несогласованный срез;
- текущие документы и CLI не дают явного общего offline-контракта для
  `backup create`, поэтому ответственность за границу между writer и helper
  сейчас не закреплена и не проверяется автоматически;
- live backup нельзя считать безопасным только потому, что архив
  криптографически проверяется; поддержанный режим должен быть отдельно
  объявлен и согласован с реализацией;
- проверка не является finding-ом про повреждение AES-GCM, path traversal,
  forged archive или обычный healthy stopped source.

## Варианты улучшения

1. **Явно выбрать offline режим как единственный обещанный контракт.** В CLI и
   runbook назвать backup maintenance/offline-only, описать остановку writer и
   не подключать scheduler к `createStorageBackup` без этой координации. Это
   минимальное изменение и честно соответствует текущей single-writer
   архитектуре; сейчас такая граница для обычного backup не закреплена явно.

2. **Добавить fail-closed lease для maintenance.** Сервер и backup helper
   должны договариваться через общий storage-level marker/lock: перед backup
   сервер прекращает новые commits, дожидается уже взятых commit locks, а backup
   удерживает lease до окончания перечисления и чтения. Нужны stale-owner,
   crash recovery и отдельные тесты для всех кампаний, потому что campaign lock
   сам по себе недостаточен.

3. **Проверять доменную согласованность на staging restore.** После byte
   restore запускать read-only audit по каждому campaign: contiguous event head,
   metadata head, snapshot checksum/projector version и map content hashes;
   затем проверять replay/projection. Статус `restored: true` должен означать
   только byte restore, а `ready_for_activation: true` — ещё и успешный domain
   audit. Смешанный архив должен оставаться в staging и явно сообщать typed
   recovery failure.

4. **Для будущего live backup перейти на согласованный снимок файловой системы
   или database adapter.** Простое повторение `compare` после backup не делает
   snapshot атомарным: source может продвинуться снова. Нужен FS snapshot,
   copy-on-write слой либо transaction/consistent export, а для multi-process
   deployment — отдельный adapter с documented recovery protocol.

До реализации одного из вариантов не следует объявлять live backup
поддержанным режимом или подключать helper к живому writer без координации; не
следует и считать зелёный `verifyStorageBackup` доказательством играбельного
recovery.

## Проверка probe

```text
node --check docs/reviews/2026-10-04/round-4/bounded-live-backup-probe.mjs  # exit 0
node docs/reviews/2026-10-04/round-4/bounded-live-backup-probe.mjs        # exit 0
```

Runtime, `.env`, рабочий `storage/` и зависимости не изменялись. Итог общего
`pnpm verify` указан в [сводке прохода](README.md).
