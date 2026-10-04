# Ревью persistence, конкурентности и security

Аудит выполнен на baseline `c7efdca614cc33f706258d036e86f01c1f189404`. Я
сверил `docs/security-model.md`, `docs/current-architecture.md`,
`docs/target-architecture.md`, `docs/product-principles.md`,
`docs/known-limitations.md` и соответствующие тесты. Рабочий `storage`, `.env`
и секреты не читались; runtime не менялся и `pnpm verify` не запускался.

Общий вывод: event log и optimistic versioning уже образуют хороший авторитетный
контур для одного процесса, но несколько границ всё ещё закрываются
договорённостями между модулями. Ниже приведены случаи, где такой договор можно
нарушить конкретным запросом, сбоем или расширением схемы. Общий single-writer
статус сам по себе не считаю новой находкой; замечания ниже относятся к
неполному протоколу даже при штатном single-writer runtime либо к конкретным
поверхностям, которые уже выглядят доступными из HTTP.

Severity означает практический приоритет исправления: P1 может нарушить
авторитет механики, приватность или восстановление принятого хода; P2 требует
неблагоприятного сбоя, медленного клиента либо будущего расширения, но уже имеет
понятный путь к потере доступности или целостности. Для P1/P2 ниже указаны
минимальные изменения, которые можно сделать отдельными маленькими задачами и
проверить изолированными тестами.

## Находки

### SEC-01 — P1 — `/api/roll` выпускает ничем не связанный бросок, а `/api/narrate` его принимает

Тип: risk · confidence: high (in-memory path; HTTP отдельно не прогонялся).

[`server/index.mjs#L5355`](../../../server/index.mjs#L5355) принимает `POST /api/roll` от владельца героя и
не требует `checkId`/`check_id`. Ветка `RollRegistry.issue` с необязательным
`registeredId` ([`roll-registry.mjs#L145`](../../../server/roll-registry.mjs#L145)) создаёт запись с
`context = null`, при этом клиент задаёт `modifier` и `difficulty` в допустимых
границах. Для этого endpoint нет вызова `exceedsRate`.

Дальше `POST /api/narrate` потребляет такой `roll_id`, проверяя только campaign,
actor и callback контекста ([`index.mjs#L5473`](../../../server/index.mjs#L5473)). В
`GameOrchestrator` при распознанной обычной проверке `planCheckCommand` получает
`verifiedRoll` и добавляет его в команду ([`game-orchestrator.mjs#L2611`](../../../server/game-orchestrator.mjs#L2611)),
хотя обязательной проверки, что запись была зарегистрирована как эта проверка,
нет. Специальный `assertFreeActionConfirmation` защищает один путь свободного
действия ([`autonomous-orchestrator.mjs#L1185`](../../../server/autonomous-orchestrator.mjs#L1185)), но не закрывает
обычную ветку `MakeAbilityCheck`.

`checkRollFromVerified` берёт из записи только выпавшие кости и пересчитывает
модификатор и СЛ ([`rules-engine.mjs#L10744`](../../../server/rules-engine.mjs#L10744)). Поэтому игрок не
подделывает итог напрямую, но может без лимита выпускать серверные d20, выбрать
удачный `roll_id` и подать его в следующую проверку. Это обходит смысл
двухфазной карточки «сначала объявить проверку, затем бросить именно её» и
одновременно создаёт файловую нагрузку: каждая выдача синхронно переписывает
весь registry.

Изолированный probe через `RollRegistry` и `GameOrchestrator` подтвердил
практическую часть цепочки: generic roll без `checkId` с выпавшим `20` даёт
`kept: 20`, `success: true` и проходит в обычную проверку. Это не real-HTTP
тест; HTTP-маршрут выше прослежен статически.

Минимальное исправление — запретить issue без существующего `check_id`; для
публичных костей оставить отдельный endpoint, который никогда не принимает
`roll_id` в механической команде. При `consume` проверять `kind`, action или
command fingerprint и `state_version`, а выпуск ограничить на пользователя и
кампанию. Проверка: интеграционный тест с `/api/roll` без `check_id` должен
получать 4xx; ранее выданный для другой проверки `roll_id` и повторный выпуск
серии бросков не должны завершать способность.

### SEC-02 — P2 — быстрый путь projection подтверждает совпадение по одной версии без hash-check

Тип: confirmed · confidence: high.

`persistAuthoritativeProjection` сначала читает compatibility room и сравнивает
только `state_version` ([`index.mjs#L3019`](../../../server/index.mjs#L3019)). Если версия комнаты равна
предложенной и нет journal message, функция сразу вызывает
`acknowledgeProjection` и возвращает room ([`index.mjs#L3033`](../../../server/index.mjs#L3033)); сравнения
`compareProjection` в этой ветке нет. Сам `FileEventStore.acknowledgeProjection`
принимает переданный `projectionHash` как есть ([`event-store.mjs#L941`](../../../server/event-store.mjs#L941))
и не вычисляет hash заново.

Проба [`projection-trace-probes.mjs#L24`](./projection-trace-probes.mjs#L24),
описанная также в [методике аудита](./08-evidence-and-method.md), принимает
caller-supplied hash и снимает pending checkpoint. Реальный HTTP lifecycle на
искусственно испорченном temporary room затем восстановил canonical state на
следующем GET; это подтверждает gap подтверждения, но не потерю authoritative
event state и не обычный путь возникновения drift.

Сценарий: после частичного сбоя или ручного дрейфа canonical-поле комнаты стало
неверным, но `state_version` осталась той же. Следующая команда, системный такт
или повторная проекция с той же версией попадает в быстрый путь, продвигает
checkpoint и оставляет расхождение без `pendingProjection`. На старте и GET есть
reconcile, но этот fast path вызывается из нескольких обычных маршрутов и сам
объявляет проекцию подтверждённой.

Исправление: перед любым ack вычислять `compareProjection(authoritative, room)`
и передавать именно вычисленный hash; при mismatch писать полную projection даже
при равной версии. `acknowledgeProjection` должен требовать непустой hash и
проверять монотонность версии, но повторный replay под lock для каждого ack здесь
не нужен: дорогая сверка уже выполнена в reconcile/projection path.
Тест должен сначала испортить canonical field при той же `state_version`, затем
вызвать обычный путь projection и убедиться, что checkpoint не продвинулся до
исправления.

### SEC-03 — P2 — event commit и trace `/why` не образуют восстановимый outbox

Тип: confirmed · confidence: high.

Состояние фиксируется раньше trace: `GameOrchestrator` делает
`eventStore.commit` ([`game-orchestrator.mjs#L2735`](../../../server/game-orchestrator.mjs#L2735)), а
`saveTrace` вызывается только после построения narration
([`game-orchestrator.mjs#L2871`](../../../server/game-orchestrator.mjs#L2871); запись выполняется [`trace-store.mjs#L57`](../../../server/trace-store.mjs#L57)). Trace —
отдельный атомарный JSON-файл, но не часть event commit и не durable outbox.

Проба [`projection-trace-probes.mjs#L47`](./projection-trace-probes.mjs#L47),
описанная в [методике аудита](./08-evidence-and-method.md), инъецирует отказ
`saveTrace` после commit: commit переживает отказ, retry остаётся idempotent, но
trace не создаётся повторно. Если процесс остановится, закончится место или
trace-файл станет недоступен
между этими шагами, событие уже есть, а HTTP может вернуть 500. Повтор с тем же
idempotency key читается как duplicate: `replayTrace` берётся из существующего
файла ([`game-orchestrator.mjs#L2794`](../../../server/game-orchestrator.mjs#L2794)), а новый trace сохраняется только при
`!idempotentReplay` ([`game-orchestrator.mjs#L2871`](../../../server/game-orchestrator.mjs#L2871)). Следовательно, retry исправляет narration/state,
но не восстанавливает `/why`; запись может отсутствовать навсегда. Event log и
механический retry при этом сохраняются; ущерб относится к объяснимости принятого
хода, а не к потере mechanics. Существующий
`projection-postcommit-error-api` проверяет crash между event и room projection;
отдельная probe выше подтверждает именно post-commit trace failure.

Минимальный вариант — добавить в commit компактную trace-outbox запись с
`turn_id`, idempotency и ссылкой на события, а отдельному восстановителю дописывать
redacted trace. Более простой вариант для текущего single-writer — при duplicate
без trace реконструировать минимальную трассу из commit и сохранить её через
O_EXCL. Проверка: fault после commit перед `saveTrace`, затем retry и GET
`/turns/:id/explanation` должны вернуть запись без повторного event.

### SEC-04 — P2 — consume roll отделён от event commit и может иметь разные исходы

Тип: limitation · confidence: high.

В `/api/narrate` roll потребляется до вызова orchestrator
([`index.mjs#L5473`](../../../server/index.mjs#L5473)); сам механический event commit происходит позднее
([`game-orchestrator.mjs#L2735`](../../../server/game-orchestrator.mjs#L2735)). `RollRegistry.consume` сразу меняет
`consumed_by` и переписывает registry ([`roll-registry.mjs#L184`](../../../server/roll-registry.mjs#L184)).
Общей транзакции с event store нет — это прямо отмечено в целевой архитектуре
как оставшаяся граница ([`target-architecture.md#L146`](../../../docs/target-architecture.md#L146)). Если после
consume commit не состоялся, durable registry уже не знает, был ли у команды
успешный event commit. Валидатор с принудительным `STATE_VERSION_CONFLICT`
подтвердил orphan pre-commit consume: `consumed_by` остаётся; повтор с тем же
ключом допускается registry, а другой ключ получает `ROLL_ALREADY_USED`.
Callback контекста всё ещё может отклонить same-key retry после изменения
`state_version`, поэтому recovery зависит от точки сбоя, а не от одного
устойчивого протокола. Это limitation восстановления, а не доказанная потеря
карточки и не сценарий «event commit, затем registry write».
Последовательность «event commit, затем registry write» для текущего HTTP-пути
не заявляется: порядок в коде обратный.

Минимально для текущего формата — сохранять исходный request и ключ рядом с
reservation, а после restart сверять `eventStore.getByIdempotencyKey`: same-key
retry должен либо продолжать именно этот запрос, либо получить однозначный
статус orphan. Full transactional redesign нужен только если такой recovery
protocol не покрывает выбранную гарантию. Fault-тест должен отдельно
останавливать процесс после consume и после commit и проверять, что roll нельзя
применить другим ключом и что same-key retry получает объяснимый результат.

### SEC-05 — P2 — crash-durability разных файловых хранилищ не выдержана единообразно

Тип: limitation · confidence: high.

`event-store.atomicWrite` делает `fsyncSync` временного файла до `renameSync`
([`event-store.mjs#L144`](../../../server/event-store.mjs#L144)), но не fsync каталога после rename. В более
критичных вспомогательных хранилищах нет даже fsync файла: registry закрывает
descriptor и переименовывает ([`roll-registry.mjs#L48`](../../../server/roll-registry.mjs#L48)), trace делает
`writeFileSync` и `renameSync` ([`trace-store.mjs#L38`](../../../server/trace-store.mjs#L38)), backup — то же
([`backup-service.mjs#L84`](../../../server/backup-service.mjs#L84)). Это ограничение именно power-loss
durability: атомарный rename защищает от полуписанного JSON, но без fsync
каталога нельзя обещать, что новый directory entry, consumed marker, trace или
backup переживут потерю питания. Процессный crash-тест сам по себе это не
доказывает.

Это отличается от обычной ошибки atomic rename: readers не увидят полуписанный
JSON, но могут увидеть прежнюю версию или потерянный файл. При потере питания
это может повлиять на replay event stream и exactly-once marker roll; для backup
ломается обещание восстановления.

Сначала нужно явно зафиксировать требуемый durability contract отдельно для
event log, roll registry, trace и backup. После этого выбрать минимальную
реализацию для каждого артефакта; общий helper не следует вводить заранее.
Проверка — controlled power-loss experiment там, где это поддерживает среда,
или документированное ограничение плюс reopen/replay и byte-for-byte backup
verification для process-crash сценария.

### SEC-06 — P2 — SSE backpressure применяется только к narration

Тип: confirmed · confidence: high.

Изолированная проба и границы доказательства приведены в
[`08-evidence-and-method.md#изолированная-проверка-sse-backpressure`](./08-evidence-and-method.md#изолированная-проверка-sse-backpressure).
`writeCampaignStream` отмечает `narrationBackpressured`, когда
`res.write` вернул `false`, но сам продолжает писать следующий frame
([`index.mjs#L2405`](../../../server/index.mjs#L2405)). Только `NarrationStream._deliver` уважает этот
флаг и складывает последний текст в pending map
([`narration-stream.mjs#L93`](../../../server/narration-stream.mjs#L93)). Presence и room broadcasts вызывают
`writeCampaignStream` напрямую ([`index.mjs#L2413`](../../../server/index.mjs#L2413), [`index.mjs#L2421`](../../../server/index.mjs#L2421)), а
heartbeat пишет напрямую раз в 20 секунд ([`index.mjs#L3713`](../../../server/index.mjs#L3713)).

Медленный аутентифицированный SSE-клиент, который не читает socket, получает
неограниченную очередь room/presence кадров при боевых обновлениях или частом
typing. Это риск памяти и event-loop latency для кампании; нагрузочный сценарий
в тестах явно не доказан. Исправление обязано учитывать `connection.mapHash`:
если coalescing выбросит промежуточные room-кадры, нельзя оставить клиенту hash
карты, соответствующий кадру, который фактически не дошёл.

Исправление: единая bounded queue на connection с coalescing room/presence до
последнего состояния, heartbeat через тот же queue, а при превышении размера —
закрытие соединения с последующей полной синхронизацией. Тест — fake
`ServerResponse.write` с постоянным `false`, серия broadcast и проверка, что
буфер ограничен и клиент закрывается/получает последний snapshot.

### SEC-07 — P2 — миграция room не имеет lock или CAS относительно живого сервера

Тип: limitation · confidence: high.

`migrateRoomFile` читает исходный файл ([`001-event-engine.mjs#L81`](../../../server/migrations/001-event-engine.mjs#L81)),
строит новый JSON и позже без проверки исходного hash пишет backup и room
([`001-event-engine.mjs#L123`](../../../server/migrations/001-event-engine.mjs#L123)).
`migrateRoomsDirectory` последовательно обходит файлы
([`001-event-engine.mjs#L150`](../../../server/migrations/001-event-engine.mjs#L150)), но не устанавливает lock, который понимает `store.saveRoom`.
Если сервер или второй migrator запишет room между чтением и `atomicWriteRaw`,
миграция молча перезапишет более свежие messages/state.

Документация справедливо требует offline import, однако код и CLI не делают это
условие проверяемым. Минимально нужен общий maintenance lock либо проверка
`sha256(original)` непосредственно перед записью с отказом `SOURCE_CHANGED`;
для каждого файла отчёт должен сохранять исходный и фактический hash. Тест
должен имитировать изменение между read и write и проверять отсутствие
перезаписи.

### SEC-08 — P1/P2 — ручные allowlist projection создают тихий дрейф при расширении схемы

Тип: risk · confidence: medium.

`projection-integrity.canonicalProjection` сравнивает только статический массив
полей ([`projection-integrity.mjs#L3`](../../../server/projection-integrity.mjs#L3), [`projection-integrity.mjs#L50`](../../../server/projection-integrity.mjs#L50)). Аналогично
`viewer-projection` держит отдельный список `PROJECTED_STATE_KEYS`
([`viewer-projection.mjs#L1462`](../../../server/viewer-projection.mjs#L1462)), а общий security projector по
умолчанию пропускает незнакомый ключ ([`security.mjs#L117`](../../../server/security.mjs#L117)); private
имена перечислены вручную ([`security.mjs#L86`](../../../server/security.mjs#L86)).

При добавлении нового authoritative поля забытый `CANONICAL_FIELDS` означает,
что room hash совпадёт даже при отсутствии поля. Забытый `PROJECTED_STATE_KEYS`
молча лишит игрока механики. Если же новое private поле попадёт только в
generic `NarrationBrief`/trace и не получит известный visibility bucket, оно
может пройти allow-by-default. Это не утверждение, что конкретное текущее поле
уже раскрывается; это проверяемый риск расширения, который сейчас ловится лишь
памятью автора.

Прежде чем проектировать единую большую schema classification, нужны
отдельные allowlist-формы для каждого public payload и отрицательные тесты:
намеренно неизвестное private-поле должно быть отброшено из room, NarrationBrief
и `/why`, а неизвестное authoritative-поле должно останавливать audit. Для
`/why` стоит выдавать отдельную форму вместо целого `verification`/`ruling`
объекта. Если позже понадобится общая versioned классификация, её можно вывести
из этих контрактов; сейчас достаточно fail-closed сторожей на границах.

## Приоритет следующего шага

Сначала закрыть generic roll endpoint и projection ack: это внешние пути к
целостности игры. Затем добавить recovery protocol для roll и trace поверх уже
защищённого event-store same-key idempotency: event retry уже имеет устойчивую
семантику, но внешние side records могут остаться orphan. После этого вынести
общую durable write и bounded SSE queue. Миграционный CAS и schema classification
сильно упростят дальнейшее расширение и сделают новые поля проверяемыми тестом,
а не ручным аудитом.

## Просмотренные области

Проверены `server/event-store.mjs`, `store.mjs`, `security.mjs`,
`viewer-projection.mjs`, `projection-integrity.mjs`, `roll-registry.mjs`,
`trace-store.mjs`, `backup-service.mjs`, `migrations/001-event-engine.mjs`,
`migrations/run.mjs`, релевантные участки `index.mjs`,
`game-orchestrator.mjs`, `rules-engine.mjs`, `narration-stream.mjs`, а также
тесты event store, projection recovery/equivalence, security, viewer projection,
trace v2, roll registry, backup, migration, store regression и SSE isolation.
