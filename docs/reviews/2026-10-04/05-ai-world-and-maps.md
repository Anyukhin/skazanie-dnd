# AI, автономный мир и карты: ревью 2026-10-04

Ревью выполнено на baseline `c7efdca614cc33f706258d036e86f01c1f189404` в
границах оркестрации творческих ролей, автономного цикла, памяти мира, NPC-
политик и генерации тактических карт. Ориентиры продукта — свобода ввода,
серверный авторитет, причинность мира и карта как структурированное состояние
(`docs/product-principles.md:48-65,91-97,226-247,262-275`). Проверены фактические
callsite, тесты и существующие eval-артефакты. `.env`, `storage/` и реальные
запросы к модели не использовались; полный `pnpm verify` не запускался. Для
подтверждения AI-06 выполнен только временный детерминированный repro с
`MapLibrary`.

Метки означают: `defect` — поведение подтверждено кодом и repro или прямым
нарушением контракта; `limitation` — граница уже существующей реализации;
`hypothesis` — направление, требующее отдельного замера. Severity — риск для
игры или эксплуатации, effort — оценка минимального изменения.

| ID | Суть | Метка | Severity | Effort |
| --- | --- | --- | --- | --- |
| AI-01 | Каталог автономных eval не является исполняемым gate | limitation | P1 | M |
| AI-02 | Токены и расходы не восстанавливаются по роли и ходу | defect/limitation | P1 | M |
| AI-03 | Два оркестратора дублируют commit/retry и narration pipeline | hypothesis | P2 | M/L |
| AI-04 | JSON-схемы и prompt-contract покрывают только часть ролей | limitation | P2 | M |
| AI-06 | В библиотеке карт проверяется только этаж входа | defect | P1 | S/M |
| AI-07 | Best-effort map quality требует отдельного gate-замера | hypothesis | P2 | M |
| AI-08 | Память и большой HTTP-state всё ещё дают секунды задержки | limitation | P1 | M/L |
| AI-09 | Verifier детерминированный и лексический, его версия не трассируется | limitation | P2 | M/L |

## AI-01. Eval автономного мира считает переданные результаты, но не запускает сценарии

[`eval/autonomous-scenarios.mjs:1-43`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/eval/autonomous-scenarios.mjs#L1-L43) объявляет 36 сценариев, а строки `40-43`
задают три длинные кампании на 36, 42 и 48 ходов. Это хороший каталог
покрытия, но не runner. [`server/autonomy-eval.mjs:11-37`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomy-eval.mjs#L11-L37) принимает готовые
`runs` и только суммирует counters, не проверяя, что каждый сценарий реально
исполнялся, не задаёт пороги и не возвращает gate. Тест
`test/autonomous-campaign.test.mjs:501-520` это явно демонстрирует: он строит
успешные `runs` простым `map` по каталогу и проверяет форму отчёта. В
`package.json` нет отдельной команды, которая запускает автономный corpus,
сохраняет сырой результат и завершает процесс с ненулевым кодом при регрессии.

Следствие: отчёт может выглядеть идеально при нулевом фактическом прогоне.
Нельзя отличить «сценарий не запускался» от «сценарий дал ноль ошибок», а
latency/cost не связаны с конкретной ролью или seed. Это особенно опасно для
свободного перехода, отказа провайдера, replay и длинных кампаний.

Минимальный вариант — `eval/autonomy-runner.mjs` с детерминированными fixtures,
`FakeLLM`, seed и отдельной функцией `assertAutonomyThresholds`. Runner должен
возвращать `missing_scenarios`, фактически исполненные IDs, версии контрактов,
latency и normalized token usage. Команда `pnpm autonomy:eval` может быть
ночным/ручным gate без сетевого доступа; в обычный `pnpm verify` достаточно
включить маленький smoke corpus. Acceptance: каждый ID каталога имеет один
реальный run; пропущенный ID, replay mismatch, mechanical error или превышение
порога делают exit code ненулевым; длинный сценарий действительно проходит
заявленное число ходов.

## AI-02. Общий лимит LLM не покрывает летописца, а trace намеренно теряет usage

Основные модели создаются через `MeteredLLMClient` в
[`server/index.mjs:263-276`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L263-L276), и [`server/usage-ledger.mjs:251-279`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/usage-ledger.mjs#L251-L279) резервирует и
закрывает квоту вокруг `client.complete`. Но `LoreAuthor` подключён напрямую к
`new RouterAIClient` в [`server/index.mjs:373-376`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L373-L376). Пролог и хроника вызываются
из [`server/campaign-bootstrap.mjs:495-503`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/campaign-bootstrap.mjs#L495-L503) и
[`server/autonomous-orchestrator.mjs:553-571`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomous-orchestrator.mjs#L553-L571), поэтому эти запросы обходят
дневной ledger и не имеют общего `usageScope`.

Ещё один такой путь — `generateItemImage` в
[`server/index.mjs:2633-2650`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L2633-L2650): он сам вызывает `fetch(${baseUrl}/images)` и
возвращает provider cost, не проходя через `usageLedger`; маршрут использует
его в [`server/index.mjs:5394`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L5394). Это отдельный image budget, но для владельца
он выглядит как тот же расход AI и должен иметь единый отчёт либо явную
границу бюджетов.

Даже для metered горячего пути `GameOrchestrator.saveTrace` пишет литерал
`token_usage: {}` ([`server/game-orchestrator.mjs:2930-2965`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/game-orchestrator.mjs#L2930-L2965)). `RouterAIClient`
получает provider usage, а trace и автономный Director его не сохраняют.
`/autonomy/advance` возвращает `decision.trace` только в HTTP-ответе
([`server/index.mjs:4550-4578`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L4550-L4578)); после перезапуска связь между моделью,
промптом, ролью и расходом исчезает. Это не утечка секрета, но делает
бюджет и eval непроверяемыми по ходу.

Минимальная реализация: прокинуть общий metered wrapper в `LoreAuthor`, а для
image route переиспользовать существующий `createRouterImageGenerator`
([`server/image-generation.mjs:68-110`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/image-generation.mjs#L68-L110)) и тот же `usageLedger`-reservation pattern,
который уже используют location illustrations и NPC portraits. Добавить
`usageRequestId`, `usageScope=campaign:<id>:<turn>` и
единый observer завершений для всех creative roles. В trace хранить только нормализованные
`input_tokens/output_tokens/total_tokens`, `role`, `model`, `provider` и
`contract_version`; raw request/ключи не сохранять. Для Director добавить
durable trace или минимальный provenance в событие `DirectorIntentRecorded`.
Acceptance: пролог и хроника учитываются в daily quota; ledger accounting для
повтора с тем же `usageRequestId` не удваивает reservation/settlement;
FakeLLM с synthetic usage даёт непустой trace; для каждого model call видны роль
и контракт, но секретов нет. Это гарантирует идемпотентность учёта, а не
external exactly-once: повтор provider call при неизвестном исходе требует
отдельного provider idempotency key или durable result protocol и в эту задачу
не входит.

## AI-03. Commit/retry и повествование раздвоены между двумя оркестраторами

`AutonomousCampaignOrchestrator` имеет собственные `commitEvents`,
`commitEventsWithRetry` и `runCommands` ([`server/autonomous-orchestrator.mjs:380-470`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomous-orchestrator.mjs#L380-L470)).
В основном `GameOrchestrator` повторяется другой цикл `resolvePlan → commit →
STATE_VERSION_CONFLICT/IDEMPOTENCY_CONFLICT` ([`server/game-orchestrator.mjs:2723-2753`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/game-orchestrator.mjs#L2723-L2753)),
а отдельный discovery снова содержит ручной retry ([`server/game-orchestrator.mjs:2891-2925`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/game-orchestrator.mjs#L2891-L2925)). Правила
слегка различаются: один путь ограничивает попытки, другой особым образом
обрабатывает maneuver и social state. Такая разница легко превращается в
расхождение replay или гонки.

Та же граница повторяется в тексте: `freeActionResponse` собирает brief,
вызывает Narrator, проверяет и ремонтирует результат
([`server/game-orchestrator.mjs:1392-1660`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/game-orchestrator.mjs#L1392-L1660)), а обычный commit-ход делает почти ту же
лестницу после commit ([`server/game-orchestrator.mjs:2760-2868`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/game-orchestrator.mjs#L2760-L2868)). Тесты race и refusal показывают, что
сегодня оба пути защищены, поэтому это пока `hypothesis`, а не найденная
ошибка.

Минимальный вариант — мигрировать только совместимые прямые commit-пути на уже
существующий `AuthoritativeExecutor`: `executeCommands` для Rules Engine-команд и
`commitDerived` для событий его derived allowlist
([`server/authoritative-executor.mjs:142-326`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/authoritative-executor.mjs#L142-L326)).
Новый второй authoritative runner здесь не нужен. Reward stages с
`ExperienceAwarded`, coins и inventory/loot нельзя проталкивать в
`commitDerived`: для них сначала нужна типизированная reward command, которую
существующий executor сможет провести атомарно; текущая последовательность reward commits видна в
[`server/autonomous-orchestrator.mjs:1991-2074`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomous-orchestrator.mjs#L1991-L2074). Capability allowlist расширять наугад нельзя. После этого можно
вынести чистый helper для общей narration brief/fallback лестницы, принимающий
committed events и viewer projection. Автономный и игровой слой должны строить
только команды/brief, не копировать transport policy. Acceptance: существующие
`test/narrate-room-version-race.test.mjs`, idempotency/replay и free-action
refusal проходят; injected conflict даёт одинаковый commit во всех путях;
новый совместимый caller не содержит собственной лестницы retry; reward paths
остаются typed/atomic и имеют отдельные idempotency/replay тесты.

## AI-04. Реестр prompt есть, но типизированный output-contract подключён лишь к части ролей

[`server/prompt-descriptors.mjs:31-50`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/prompt-descriptors.mjs#L31-L50) знает девять загружаемых prompt IDs, а
[`server/llm-json-schemas.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/llm-json-schemas.mjs) описывает только Director, NPC social и
campaign creation. При этом production-вызов создателя кампании в
[`server/campaign-bootstrap.mjs:460-490`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/campaign-bootstrap.mjs#L460-L490) не передаёт `jsonSchema`, и вызов
Scene Architect в [`server/scene-architect.mjs:743-759`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/scene-architect.mjs#L743-L759) тоже полагается на
ручной `normalizePlan`. Action Adjudicator в
[`server/action-adjudicator.mjs:455-489`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/action-adjudicator.mjs#L455-L489) проверяет структуру и references после
ответа, но не имеет provider-side schema. Комментарий схемы campaign creation
ещё ссылается на `campaign_creator/v5`, тогда как загрузчик уже v8 — пример
дрейфа описания рядом с живым контрактом.

Нормализаторы и fallback делают систему безопасной, поэтому это limitation, а
не повод включать модель в Rules Engine. Но при расширении map design, NPC
social или свободного действия модель может начать регулярно присылать поле,
которое тихо вырежется, и качество упадёт без наблюдаемой причины.

Минимальная обобщаемая форма — реестр `{role, prompt_id, input_schema,
output_schema, normalizer, fallback}`. Для каждой роли schema передаётся только
совместимым моделям, затем результат всё равно проходит server normalizer.
Acceptance: активный loader, prompt ID, schema и normalizer сверяются одним
тестом; production calls передают `role` и `contract_version`; malformed,
лишние и механические поля приводят к тому же fallback, что и отсутствие LLM.

Бывший кандидат AI-05 исключён из findings как false positive. Подсказка
`route_hint` действительно хранится в process-local `Map`, но это намеренный
транспорт внутри одного `/api/narrate`: `routedFreeAction` сохраняет её
([`server/autonomous-orchestrator.mjs:903-925`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomous-orchestrator.mjs#L903-L925)), а тот же маршрут сразу забирает
её в [`server/index.mjs:5597-5608`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L5597-L5608). Сам переход не коммитится из model output,
а карточка решения группы уже durable. Отдельное упрощение (вернуть
`route_hint` напрямую вместо промежуточного Map) возможно как P3, но restart
дефектом это не является и в roadmap не включено.

## AI-06. Подтверждённый defect: MapLibrary проверяет только ground floor

В [`server/map-library.mjs:476-490`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/map-library.mjs#L476-L490) `MapLibrary.pick` получает все уровни, но
вызывает `playable` и дополнительный `check` только для `ground` с
`index === 0`. Сам `playable` ([`server/map-library.mjs:500-513`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/map-library.mjs#L500-L513)) запускает `auditTacticalMap` только на
переданной карте. Затем [`server/adventure-director.mjs:395-407`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/adventure-director.mjs#L395-L407) добавляет к ground ещё
`programReport`; `librarySceneGeometry` сохраняет остальные этажи без новой
проверки ([`server/adventure-director.mjs:475-503`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/adventure-director.mjs#L475-L503)).

Safe repro во временном каталоге оставил импортированный ground валидным и
добавил на верхний этаж prop с footprint `[-1,-1]`. Аудит верхнего этажа дал
`PROP_OUT_OF_BOUNDS`, однако `library.pick(...)` вернул `picked: true` и
сохранил дефектный уровень. Воспроизводимый probe — [`map-library-probe.mjs`](./map-library-probe.mjs).
Штатный тест
`test/map-library.test.mjs:112-123` ломает только ground (нет spawn point), а
многоэтажный smoke-тест `140-169` проверяет перенос, но не качество каждого
этажа.

Минимальный fix — валидировать каждый уровень перед выбором. Для этажей выше
нулевого разрешить отсутствие party spawn, если есть допустимый переход/лестница,
но блокировать структурные ошибки (`PROP_OUT_OF_BOUNDS`, `DOOR_TO_NOWHERE`,
`PROP_ON_SOLID_CELL`, повреждённые ссылки) и программу для тех якорей, которые
обещает именно этот этаж. Acceptance: repro с плохим upper level не выбирается;
валидный `HOUSE_SLAB` с level 0/1 выбирается; тест проверяет обе карты и
replay перехода между этажами.

## AI-07. Проверяемая гипотеза: best-effort генерация карты требует отдельного quality gate

В [`server/adventure-director.mjs:416-463`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/adventure-director.mjs#L416-L463) генератор делает до четырёх попыток,
сохраняет `best` с минимальным числом `programReport.problems` и возвращает его
даже если проблемы остались. [`server/map-quality.mjs:603-718`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/map-quality.mjs#L603-L718) различает
blocking problems (`PROGRAM_ANCHOR_UNREACHABLE`, `SCENE_TOO_SMALL`,
`OPEN_SCENE_CLUTTERED`, `UNREACHABLE_POCKET`) и warnings, но caller наружу
передаёт только `missing` (`adventure-director.mjs:461-462`). Поэтому клиент и
трасса не знают, что `programReport` выбрал последнюю неидеальную попытку;
`missing` покрывает только обещанные anchors. При этом полный `auditTacticalMap`
не является одним общим top-level gate: он вызывается внутри отдельных
генераторов ([`server/building-generator.mjs:934-936`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/building-generator.mjs#L934-L936), [`server/building-generator.mjs:1760-1772`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/building-generator.mjs#L1760-L1772)) и библиотеки,
а `generateSceneGeometryFor` после `applyScenePlan` вызывает именно
`programReport` ([`server/adventure-director.mjs:438-447`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/adventure-director.mjs#L438-L447)).

Существующий corpus из 20 мест проверяет чистый результат
(`test/scene-program-corpus.test.mjs:40-45`), а ручной test `scene-program-layout`
проверяет сам `programReport`, но нет проверки «все попытки плохи → карта
отклонена или quality reason сохранён». Это пока hypothesis: часть тем имеет
свои внутренние аудиты, а policy может сознательно предпочитать лучший
доступный fallback, чтобы не блокировать переход.

Сначала нужен safe measurement: для всех тем и seed записывать
`programReport`, внутренние `auditTacticalMap`-warnings и выбранную попытку.
После замера минимальный вариант — возвращать `quality: {status, problems,
warnings, attempts, selected_seed}` и выбрать policy: deterministic repair,
структурированный fallback без обещанного anchor или отказ перехода с понятным
сообщением. Acceptance: искусственно неудовлетворимая программа не теряет
`problems`; clean corpus остаётся byte-stable; в событии сохраняются quality
version и seed выбранной попытки. Блокировать игру следует только после
отдельного порога и regression corpus.

## AI-08. Большая память мира остаётся узким местом полного HTTP-пути

`retrieveWorldMemory` на каждом вызове сначала строит viewer projection, затем
пересоздаёт `retrievalRecords`, токенизирует и stem-профилирует каждую запись
([`server/world-memory.mjs:1428-1457`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/world-memory.mjs#L1428-L1457)). Это корректно по visibility, но при
нескольких вызовах Director/Narrator/NPC за один ход означает повторные обходы
одного и того же snapshot. Кэш Event Store уже снял часть восстановления, но
свежий benchmark без LLM и SSE показывает expanded state 8,6 MB, response около
6,17 MB, `p50=4501 мс`, `p95=7327 мс`
([`performance-current.json`](performance-current.json)). Это
примерно 4,5 и 7,3 секунды, а не 4,5 и 7,3 миллисекунды. Исторический committed
стенд также фиксирует ту же проблему (`docs/large-campaign-performance.md:127-147`).

Это confirmed performance limitation, а не доказательство, что виноват только
retriever: benchmark отдельно должен разложить wall time на load, projection,
retrieval и serialization.

Минимальная последовательность: добавить request-scope cache keyed by
`campaign/state_version/viewer/asOfMinutes` для projection и retrieval index;
precompute token/stem profiles при изменении памяти; отделить authoritative
state от дублирующей полной выдачи и отдавать bounded projection/delta. Сначала
снять stage profile, затем закрепить benchmark на 600/2,500/6,001 records.
Acceptance: в пределах одного запроса нормализация и stem index строятся один
раз, cache invalidation происходит по state version, visibility tests остаются
зелёными, а benchmark показывает отдельные budget на load, projection,
retrieval и serialization. Нельзя возвращать retention truncation только ради
скорости: память остаётся канонической, а сокращается лишь read projection и
сериализуемый ответ с сохранением персональных прав.

## AI-09. Verifier защищает известные классы ошибок, но остаётся лексическим и не версионируется как контракт

`verifyNarration` в [`server/security.mjs:642-790`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/security.mjs#L642-L790) сверяет числа, rule IDs,
перемещение, социальные утверждения, скрытые факты и несколько сценических
противоречий регулярными выражениями. `Narrator.render` использует этот
детерминированный verifier и асинхронную craft-проверку
([`server/narrator.mjs:2060-2363`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/narrator.mjs#L2060-L2363)). Сторожевые тесты
`test/security.test.mjs:149-184` полезны и ловят реальные регрессии, но это
закрытый набор языковых паттернов, а не универсальное доказательство
соответствия произвольной прозы событиям.

`turnPromptVersions` прямо возвращает `verifier: null` и `intent_parser: null`
([`server/game-orchestrator.mjs:973-986`](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/game-orchestrator.mjs#L973-L986)). Это не defect: правила проекта
запрещают выдумывать prompt ID для детерминированного алгоритма. Ограничение в
другом: версия самого алгоритма проверки не фиксируется, поэтому после
изменения словаря или regex старый результат нельзя воспроизвести как
«проверенный версией vN». Отдельный LLM verifier в hot path добавлять не
следует, потому что он ухудшит стоимость и детерминизм.

Минимальный следующий слой — формальный `NarrationEvidence` из Rules Engine и
поле `verifier_algorithm_version` в trace:
для каждого события перечислить разрешённые claims (actor, target, movement,
resource, value, visibility), а regex оставить только как defence-in-depth.
Версионировать `deterministic-narration-verifier/vN` именно как алгоритм, а не
как prompt, и добавить mutation corpus,
который подставляет неподтверждённые claims в русские фразы. Acceptance: все
mechanical claims из corpus отвергаются, допустимые paraphrase проходят,
visibility/hidden facts не меняются, версия verifier попадает в trace.

## Рекомендуемый порядок расширения

Сначала закрыть AI-06 и AI-02: верхний этаж уже может пронести повреждённую
геометрию, а летописец может выйти за общий лимит. Следом сделать AI-01 и AI-07,
чтобы изменения автономного цикла и генератора имели настоящий gate и не теряли
причину деградации. Затем мигрировать оставшиеся callers на существующий
`AuthoritativeExecutor` (AI-03) и добавить schema registry (AI-04). AI-08 требует отдельного
профилирования полного HTTP-пути; AI-09 — отдельного corpus, но оба должны
войти в roadmap до существенного расширения мира.
