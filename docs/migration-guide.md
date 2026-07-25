# Руководство по миграции кампаний

> **Статус после этапа 8 (25 июля 2026):** live lazy import, mode switch и
> `LegacyStateSynchronized` удалены. Описанные ниже прежние runtime-шаги
> сохранены только как история перехода и не должны запускаться над рабочим
> storage. Актуальный безопасный процесс: backup → read-only
> `pnpm cutover:verify` → явный выбор канонического состояния → reconciliation
> на копии. См. `docs/legacy-retirement.md`.

## Историческая схема до этапа 8

Миграция состоит из двух разных шагов, и их нельзя смешивать:

1. `server/migrations/001-event-engine.mjs` добавляет в legacy room JSON ruleset/event metadata, сохраняя прежний room CAS `version`. Runner поддерживает `--dry-run`, создаёт точную `.bak` копию перед записью и идемпотентно пропускает уже мигрированный файл.
2. `FileEventStore.importLegacySnapshot` создаёт `LegacyStateImported` event, snapshot и event-store metadata.
3. Рабочий `server/index.mjs` импортирует новую кампанию сразу при `POST /api/campaigns`. Для существующей кампании `GameOrchestrator.ensureCampaign` делает ленивый идемпотентный import при первом обращении в `shadow` или `enforce`. Администратор может менять режим через `PATCH /api/campaigns/:id/engine-mode`; перед переходом в `enforce` runtime записывает `LegacyStateSynchronized`.

При этом общего bulk import/reconciliation CLI нет. Metadata migration и runtime import остаются разными операциями: runner устанавливает `event_engine.legacy_import_required: true`, а ленивый import не обновляет этот marker обратно в room. Event commit, переключение mode и legacy room projection не образуют одну filesystem-транзакцию.

Поэтому техническая возможность per-campaign `shadow/enforce` уже есть, но для ценных существующих данных безопаснее выполнить описанные ниже backup, dry-run, явную проверку import/replay и только затем включать режим. Автоматическое переключение всех rooms не предполагается.

## Критически важное решение о ruleset

Runner использует defaults `srd_5_2_1`/`5.2.1`, если в room ещё нет metadata. Это технический default, а не автоматическое доказательство редакции кампании.

До записи владелец должен явно подтвердить:

```text
ruleset_id
ruleset_version
enabled_rule_packs
enabled_house_rules
```

Если редакция неизвестна или существующая кампания использует другой набор правил, остановитесь. Нельзя присвоить `srd_5_2_1` только потому, что это единственный pack в репозитории.

## Шаг 1. Подготовка

1. Завершите активный ход и прекратите writes.
2. Остановите сервер и tunnel:

```powershell
docker compose --profile public down --remove-orphans
```

3. Убедитесь, что 8787/4173 не слушаются.
4. Зафиксируйте commit/tag приложения. На момент аудита репозиторий не имел commit history; без этого rollback кода невоспроизводим.
5. Зафиксируйте подтверждённый ruleset отдельно от данных.

## Шаг 2. Полный backup до migrator

Per-room `.bak` от migrator полезен, но не заменяет backup auth/generated/tunnel и всех rooms.

```powershell
$project = (Resolve-Path .).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $env:USERPROFILE "DnD-backups\skazanie-$stamp"

New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'storage') -Destination (Join-Path $backup 'storage') -Recurse

if (Test-Path -LiteralPath (Join-Path $project '.env')) {
  Copy-Item -LiteralPath (Join-Path $project '.env') -Destination (Join-Path $backup '.env')
}

Get-ChildItem -LiteralPath (Join-Path $backup 'storage') -File -Recurse |
  Get-FileHash -Algorithm SHA256 |
  Select-Object Path, Hash |
  Export-Csv -LiteralPath (Join-Path $backup 'checksums.csv') -NoTypeInformation -Encoding UTF8

$backup
```

Требования:

- backup находится вне OneDrive project tree;
- `.env` остаётся секретом и не попадает в Git/общий доступ;
- абсолютный `$backup` записан в change ticket/журнал;
- для важной кампании есть вторая независимая копия;
- каждый room JSON читается JSON parser-ом из backup.

## Шаг 3. Настройка Node и окружения

Используйте Node, совместимый с Vite/runtime. В окружении разработки применялся bundled Node:

```powershell
$node = 'C:\Users\anton\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:DND_STORAGE_DIR = (Resolve-Path .\storage).Path
```

После решения владельца задайте ruleset явно. Пример ниже допустим только для подтверждённой кампании:

```powershell
$env:DND_DEFAULT_RULESET_ID = 'srd_5_2_1'
$env:DND_DEFAULT_RULESET_VERSION = '5.2.1'
```

Не сохраняйте эти значения глобально на машине, если разные кампании используют разные editions.

## Шаг 4. Dry-run metadata migration

Краткий runner:

```powershell
& $node server\migrations\run.mjs --dry-run
if ($LASTEXITCODE -ne 0) { throw 'Dry-run migration failed' }
```

Для полного JSON report без записи:

```powershell
& $node --input-type=module -e "import { runMigrations } from './server/migrations/run.mjs'; const result=runMigrations({dryRun:true,logger:null}); console.log(JSON.stringify(result,null,2)); if(result.failed) process.exitCode=1"
```

Ожидается:

- `planned` для ещё не мигрированных корректных rooms;
- `skipped` для уже идентичных мигрированных rooms;
- `failed > 0` и non-zero exit при повреждённом room;
- отсутствие изменений в `storage` и отсутствие новых `.bak` на dry-run.

Проверьте в report каждый `ruleset_id`. Любая неожиданная редакция блокирует запись.

## Шаг 5. Metadata migration

Только после успешного backup и dry-run:

```powershell
& $node server\migrations\run.mjs
if ($LASTEXITCODE -ne 0) { throw 'Migration completed with failed rooms; do not start the server' }
```

Для каждого изменённого room migrator:

- сохраняет оригинальные bytes в `storage/rooms/.backups/001-event-engine/<room>.json.bak`;
- не меняет top-level room `version`;
- сохраняет legacy state fields;
- добавляет `state_version`, ruleset lock и enabled lists;
- добавляет migration marker;
- устанавливает `legacy_room_version` и `legacy_import_required`;
- пишет JSON через temporary file + fsync + rename.

Повторите dry-run. Все успешно мигрированные rooms должны стать `skipped`. Не удаляйте `.backups`.

## Шаг 6. Проверка после metadata migration

Проверьте:

- room `version` равен исходному;
- players/messages/scene/inventories не исчезли;
- `state_version` неотрицателен;
- ruleset fields соответствуют решению владельца;
- backup file byte-for-byte равен исходному room из полного backup;
- `legacy_import_required` остаётся `true` до отдельного import;
- legacy server может загрузить room на локальном тестовом порту.

Metadata migration обратно совместима по форме, но этот smoke test ещё не проверяет event replay.

## Шаг 7. Проверяемый import в FileEventStore

`FileEventStore.importLegacySnapshot` используется runtime, однако общего runner-а для всех rooms нет. Автоматический lazy import удобен для новой/тестовой кампании, но для существующей важной комнаты сначала воспроизведите import в отдельном target через контролируемый script и сравните replay. Не запускайте пробный import в том же каталоге `storage/engine`, который обслуживает работающий сервер.

Требуемый adapter configuration:

```js
const store = new FileEventStore({
  rootDir: targetDirectory,
  reducer: applyGameEvent,
  normalizeState: normalizeCampaignState,
})
```

Для каждой комнаты integration tool должен:

1. выбрать стабильный `campaign_id`;
2. передать полный legacy state;
3. использовать стабильный import `idempotency_key`;
4. передать подтверждённые ruleset metadata;
5. для rehearsal сохранить результат только в отдельном target;
6. replay-нуть с `use_snapshots: false`;
7. сравнить normalized legacy projection и replay state, учитывая ожидаемое изменение `state_version` с 0 на 1;
8. повторить import и получить `duplicate: true`, а не второе событие;
9. записать mapping legacy room → event campaign directory.

До прохождения этой процедуры `legacy_import_required` нельзя сбрасывать. Текущий runtime не сбрасывает marker автоматически даже после успешного ленивого import: его reconciliation требует отдельной проверенной операции.

## Шаг 8. Per-campaign cutover

Рабочий runtime поддерживает per-campaign переключение режима, но не предоставляет атомарный массовый cutover. Один узкий HTTP integration-тест подтверждает создание временной shadow-кампании, admin switch в enforce, команду, идемпотентный повтор и explanation; он не проверяет рабочий storage, metadata runner, browser или rollback.

Безопасная последовательность:

1. остановить writes;
2. создать второй свежий backup;
3. убедиться, что room versions не изменились после test import;
4. выполнить import в новый чистый target;
5. проверить replay, snapshots, ruleset lock и idempotency;
6. запустить сервер локально и убедиться, что кампания разрешается в `shadow`;
7. проверить trace/divergence, `/why` и legacy compatibility projection;
8. переключить только эту кампанию в `enforce` через admin endpoint;
9. выполнить идемпотентную тестовую команду, replay и сверку legacy room projection;
10. не разрешать стороннему legacy instance одновременно писать ту же кампанию.

Важно: admin switch сначала может записать synchronization event, а затем отдельно сохранить `engine_mode` в room. Enforce commit также отдельно проецируется обратно через `saveRoom`. При конфликте/сбое между этими шагами немедленно остановите writes и выполните reconciliation event state ↔ room state; HTTP success или наличие event сами по себе не доказывают согласованность обеих проекций.

## Rollback metadata migration

Условия rollback:

- неверный ruleset;
- повреждённый/нечитаемый room;
- пропажа legacy fields;
- несовместимость существующего UI/API;
- migration report содержит failures.

Предпочтительный rollback — восстановление полного backup. Сначала сохраните неуспешное состояние для анализа:

```powershell
$project = (Resolve-Path .).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$failed = Join-Path $project "storage.failed-$stamp"

docker compose --profile public down --remove-orphans
Move-Item -LiteralPath (Join-Path $project 'storage') -Destination $failed
Copy-Item -LiteralPath (Join-Path $backup 'storage') -Destination (Join-Path $project 'storage') -Recurse
```

Затем сравните restored files с `checksums.csv`, запустите только локально и проверьте auth/room state до возврата tunnel.

Per-room `.bak` можно использовать для точечного восстановления только при остановленном сервере и после сохранения текущего повреждённого файла. Полный backup надёжнее, потому что фиксирует согласованный срез всего storage.

## Rollback event-store cutover

В enforce выбранные авторитетные поля (HP, отдельные inventory/movement/scene/ruling изменения, mechanics и ruleset metadata) проецируются обратно в legacy room. Это частичная compatibility projection, а не общий reverse migrator, и event commit с `saveRoom` не атомарны.

1. Остановить writes и сохранить копии `storage/engine`, `storage/rooms` и turn traces.
2. Сравнить event `state_version`, последний commit и room `state_version`/`version`; зафиксировать divergence.
3. Если projection подтверждён для всех post-cutover events, переключить кампанию в `legacy` только после локального smoke test этой room-копии.
4. Если projection неполон, восстановить согласованный backup либо вручную воспроизвести события через контролируемый reconciliation tool; заранее зафиксировать возможную потерю post-backup ходов.
5. Восстановить compatible code commit/tag, если rollback включает код.
6. Сохранить event target и divergence report read-only для расследования; не удалять commits.

Если были одновременные writers или сбой между commit и projection, автоматический rollback небезопасен. Нельзя просто скопировать event state поверх legacy JSON без проверяемого mapping.

## Что проверено тестами, а что нет

Temp-only tests подтверждают:

- точный backup bytes;
- сохранение legacy room CAS version;
- идемпотентный повтор metadata migration;
- изоляцию повреждённого room;
- одноразовый legacy import;
- immutable event batches;
- idempotency/version conflicts;
- snapshots и replay после открытия нового store instance.

Отдельный узкий real-HTTP integration test на временном storage подтверждает:

- создание кампании и исходный import;
- переключение campaign mode администратором;
- enforce `ApplyDamage` и отсутствие второго commit при повторе idempotency key;
- получение explanation и совместимый `/api/narrate /why`.

Не проверены на рабочих данных:

- фактический `storage/rooms/RUNE-742.json`;
- metadata migration и import/cutover фактической комнаты;
- browser/UI после import/cutover;
- crash/failure injection;
- multi-process competition;
- Docker/Pinggy;
- настоящий RouterAI turn и `/why` после restart;
- reverse migration.

## После успешного будущего cutover

- храните full backup, per-room backups, migration report, ruleset decision и code tag весь rollback window;
- отслеживайте idempotency conflicts, version conflicts, replay mismatch и verifier failures;
- удаляйте legacy data/code только отдельным решением после миграции всех кампаний.
