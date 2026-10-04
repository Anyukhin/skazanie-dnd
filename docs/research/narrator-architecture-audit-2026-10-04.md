# Аудит архитектуры Рассказчика и вариантов развития

Дата: 2026-10-04. Baseline: `cb045a84`. Объём: серверный pipeline повествования, память, режимы ответа, режиссёр, социальный контроллер, trace и потоковая доставка.

Отчёт read-only; `storage/`, `data/` и код не изменялись.

Локальные приоритеты и порядок ниже ориентировочны; общий порядок реализации задаётся главным roadmap в `docs/bg3-experience-roadmap-2026-10-04.md`.

## Вывод для roadmap

У «Сказания» уже есть правильная граница: Rules Engine и Event Store принимают решение, а Рассказчик получает viewer-safe проекцию после commit.

Visibility, идемпотентный replay, детерминированные запасные тексты, проверка механики и поток только законченных безопасных предложений уже работают.

Минимальный следующий шаг — расширить существующие deterministic registry и trace: добавить явный channel/branch и нормализованный provenance. Отдельный внутренний `NarrationCoordinator` остаётся опциональным seam, если после этого дублирование между ветками не исчезнет.

Сейчас эта логика разделена между `Narrator`, `GameOrchestrator`, `NpcSocialController`, боевой веткой и маршрутами `index.mjs`.

Приоритеты: наблюдаемость и актуальная документация; минимальное расширение registry/trace; затем typed response plan. Durable quality read model и полноценный coordinator — варианты после characterisation tests; scene program и claims ontology — эксперименты после N06.

## Фактический pipeline

```text
request_kind + idempotency key
  -> viewer projection / request router
  -> IntentParser / ActionAdjudicator / rule retrieval
  -> Rules Engine + Dice Service
  -> Event Store commit
  -> public events + StoryContext + NarrationBrief
  -> deterministic narrator OR mechanics log OR Narrator.render
  -> synchronous verifier
  -> response + trace + optional sentence stream
```

Основная сборка `NarrationBrief` находится в [server/game-orchestrator.mjs:2771](../../server/game-orchestrator.mjs#L2771). Она использует видимые события, изменения состояния, `scene_canon`, мировые часы, world-memory, story context и разрешённые реакции NPC.

Это правильная последовательность: prose не создаёт событие и не меняет commit.

Доступ к модели внедряется в [server/index.mjs:362](../../server/index.mjs#L362), а `GameOrchestrator` получает `Narrator` через конструктор [server/game-orchestrator.mjs:986](../../server/game-orchestrator.mjs#L986).

Входы `action`, `question` и `discussion` уже разделены. Вопрос и обсуждение не попадают в Rules Engine; `nonActionResponse` отвечает worldkeeper, clarification registry или action adjudicator ([server/game-orchestrator.mjs:1682](../../server/game-orchestrator.mjs#L1682)).

## Что уже сделано хорошо

### Контракт и prompt

Активный код грузит `narrator/v12`, few-shot `v2`, ограничивает окно недавних текстов тремя ответами и задаёт общий deadline 12 секунд ([server/narrator.mjs:21](../../server/narrator.mjs#L21)).

Prompt явно разделяет подтверждённые события, известную обстановку, намерение героя, обещания и недоверенные данные ([prompts/narrator/v12.txt:1](../../prompts/narrator/v12.txt#L1)).

`narratorResponsePlan` строится кодом и различает `acknowledge_intent`, `report_result` и `describe_scene`, а также включает или выключает память и сценическую деталь ([server/narrator.mjs:220](../../server/narrator.mjs#L220)).

Короткие технические исходы не обязаны получать атмосферный абзац, что полезно для темпа боевой игры.

Модель получает отфильтрованный `briefForNarratorPrompt`, а нерелевантная память удаляется до вызова; полный brief остаётся у verifier ([server/narrator.mjs:618](../../server/narrator.mjs#L618)).

В запрос входят `scene_canon`, сенсорные якоря, NPC dossiers и русские `confirmed_event_summaries` ([server/narrator.mjs:2250](../../server/narrator.mjs#L2250)).

### Безопасность и replay

`buildNarrationBrief` рекурсивно применяет viewer projection и исключает `gm_only`, `npc_private`, secret и внутренние поля ([server/security.mjs:117](../../server/security.mjs#L117), [server/security.mjs:189](../../server/security.mjs#L189)).

`verifyNarration` проверяет неподтверждённое движение, социальный исход, двери, предметы, HP, ресурсы, броски, rule IDs, скрытую информацию и противоречия физическому канону ([server/security.mjs:642](../../server/security.mjs#L642)).

При ошибке провайдера, пустом ответе, нарушении guard или deadline возвращается детерминированный текст. Текущий путь намеренно делает одну генерацию и не выполняет repair-вызов ([server/narrator.mjs:2056](../../server/narrator.mjs#L2056), [server/narrator.mjs:2185](../../server/narrator.mjs#L2185)).

События боя, торговли, встречи и перехода сцены имеют детерминированные адаптеры с общим контрактом и числовым приоритетом ([server/deterministic-narration.mjs:44](../../server/deterministic-narration.mjs#L44)).

Replay с тем же idempotency key берёт сохранённую реплику или replay-fallback ([server/game-orchestrator.mjs:680](../../server/game-orchestrator.mjs#L680)).

Стриминг передаёт только публичный снимок текста, ограниченный по UTF-8 и размеру; commit уже произошёл до `narration.start` ([server/narration-stream.mjs:53](../../server/narration-stream.mjs#L53), [server/game-orchestrator.mjs:2820](../../server/game-orchestrator.mjs#L2820)).

Клиент умеет финал `complete`, замену `replaced` и replay ([src/ai-client.ts:94](../../src/ai-client.ts#L94), [src/ai-client.ts:198](../../src/ai-client.ts#L198)).

### Память и режиссура

`narrationStoryContext` отдаёт bounded-контекст: активные квесты, нити, сводки, решения, героев, присутствующих NPC, обещания, разговоры и досье ([server/game-orchestrator.mjs:140](../../server/game-orchestrator.mjs#L140)).

World memory фильтруется до retrieval и поддерживает видимость, время, knowledge ledger и один графовый шаг ([server/world-memory.mjs:1209](../../server/world-memory.mjs#L1209), [server/world-memory.mjs:1428](../../server/world-memory.mjs#L1428)).

Режиссёр получает отдельный bounded brief и режим `story | chaos`; fallback полностью серверный ([server/director-agent.mjs:145](../../server/director-agent.mjs#L145), [server/director-agent.mjs:198](../../server/director-agent.mjs#L198)). Он предлагает `DirectorIntent`, а не пишет HP, позиции или квест напрямую.

`CampaignRecapService` имеет durable cache, viewer-safe sources и детерминированный fallback ([server/campaign-recap.mjs:46](../../server/campaign-recap.mjs#L46), [server/campaign-recap.mjs:179](../../server/campaign-recap.mjs#L179)). Это образец для quality feedback.

Социальный контроллер ограничивает факты, слухи, обещания, видимость и релевантную память до вызова модели ([server/npc-social-controller.mjs:146](../../server/npc-social-controller.mjs#L146), [server/npc-social-controller.mjs:179](../../server/npc-social-controller.mjs#L179)).

Его результат нормализуется в разговор, stance, disclosure IDs, relationship delta и promise ([server/npc-social-controller.mjs:294](../../server/npc-social-controller.mjs#L294)).

## Архитектурные пробелы

### 1. Одна роль имеет несколько маршрутов

Основной ход, `freeActionResponse`, structured combat, social reply, critical moment и scene/merchant/encounter narration строят близкие, но разные результаты.

В основном маршруте выбор идёт через registry; составной combat и mechanics log обходят его ([server/game-orchestrator.mjs:2810](../../server/game-orchestrator.mjs#L2810)).

Боевой рассказчик имеет общий контракт, но намеренно не зарегистрирован и вызывается отдельным потоком ([server/combat-narration.mjs:699](../../server/combat-narration.mjs#L699)).

Это разумная историческая граница, но для новых правил означает вторую selection policy. Нужен coordinator с явным `channel: combat | world | social | critical`, а не немедленная глобальная регистрация combat.

### 2. Priority покрывает только часть runtime

Зарегистрированные адаптеры сортируются по priority, но `combatNarrator` остаётся вне реестра. Тесты фиксируют обе модели поведения ([test/deterministic-narration.test.mjs:23](../../test/deterministic-narration.test.mjs#L23)).

Нужно либо формально описать два канала в интерфейсе, либо добавить `NarrationChannel` в coordinator и проверить пересечения событий одним тестом.

### 3. Quality feedback живёт только в RAM

`verifyNarratorFeedback` вычисляет клише, пропущенную память, повтор, сенсорные якоря, тон и границы, но не переписывает текущий текст и хранится в `Narrator.feedbackMemory` ([server/narrator.mjs:1438](../../server/narrator.mjs#L1438), [server/narrator.mjs:2075](../../server/narrator.mjs#L2075)).

После рестарта, смены процесса или вытеснения карты кампании feedback исчезает.

В trace уже сохраняются `verification.origin.source/reason/elapsed_ms`, provider fallback reason и provider; пробел в том, что branch, attempt count, first-safe-sentence, guard codes и usage не вынесены в нормализованные top-level поля ([server/game-orchestrator.mjs:2930](../../server/game-orchestrator.mjs#L2930), [server/trace-store.mjs:62](../../server/trace-store.mjs#L62)).

Минимум — расширить существующий redacted trace этими полями и сохранять feedback по `campaign_id + turn_id`; отдельный `NarrationQualityRecord` нужен только если объём/retention превысит trace. Полноценное новое хранилище не является обязательным первым PR.

### 4. Недостаточно provenance для свободного смысла

Verifier знает event types и часть payload, prompt получает summaries, но активного `approved_claims` с `source_refs` нет. Claims ontology не назначать обязательным runtime-рефакторингом: это эксперимент после N06.

Модель может выбрать правильное событие и неверно связать его с причинностью. В старом сравнении восемь существенных ошибок моделей прошли существующий guard ([docs/narrator-comparison-2026-09-11.md:60](../narrator-comparison-2026-09-11.md#L60)). Это historical baseline до последующего исправления: 12 сентября повторная обработка отклонила все восемь отмеченных ошибок; результат сохранён в [docs/narrator-craft.md:40](../narrator-craft.md#L40) и [eval/narrator-fixes-replay-2026-09-12.json](../../eval/narrator-fixes-replay-2026-09-12.json). Вывод относится к ограниченности прежней выборки и не утверждает текущую доказанную дыру.

Тесты закрывают известные русские формы, но документация сама отмечает конечность лексических шаблонов ([docs/narrator-craft.md:40](../narrator-craft.md#L40)).

Нужен server-owned список claims `{ id, text, category, source_event_ids, visibility, allowed_audience }`. Модель выбирает форму и порядок claims; новые IDs от модели не являются источником истины.

### 5. Bounded memory не равна долговечной narration memory

`GameOrchestrator` держит три последних текста в process-local buffer и один раз поднимает их из trace при cold start ([server/game-orchestrator.mjs:1029](../../server/game-orchestrator.mjs#L1029), [server/game-orchestrator.mjs:1045](../../server/game-orchestrator.mjs#L1045)).

Это хороший performance fix против O(N²), но не память истории: нет durable связи feedback с turn, персональной retention policy и проверки параллельных процессов.

Оставлять художественный текст в event stream не следует. Достаточно durable quality record и чтения последних public traces через read model. Личные NPC факты уже принадлежат world-memory/social projection; новая vector memory преждевременна.

### 6. Два recap могут расходиться

`CampaignRecapService` строит «в прошлой серии» при длительном перерыве и кеширует по state version ([server/campaign-recap.mjs:216](../../server/campaign-recap.mjs#L216)).

Обычный `Narrator.render` отдельно подмешивает recap арки из `campaign_premise.arc_history` и держит `arcRecapMemory` в RAM ([server/narrator.mjs:2129](../../server/narrator.mjs#L2129)).

У механизмов разные триггеры, лимиты и provenance. Нужны `recap_kind: session_resume | arc_transition` и общий durable dedupe key, при раздельных источниках.

### 7. Social path не имеет общего речевого envelope

`NpcSocialController` правильно владеет мотивацией и знаниями, но deterministic fallback содержит англоязычные строки ([server/npc-social-controller.mjs:262](../../server/npc-social-controller.mjs#L262)), хотя язык продукта русский.

Social reply записывается как готовая реплика и обычно минует общий Narrator. Нужен envelope `speech_act`, `audience`, `claim_ids`, `stance`, `reply`, но второй художественный вызов по умолчанию не нужен.

### 8. Trace годится для `/why`, но слаб для эксплуатации качества

Trace уже содержит `prompt_versions`, provider, verification, events и latency ([server/game-orchestrator.mjs:2930](../../server/game-orchestrator.mjs#L2930)). `verification.origin` уже различает `llm`/`template` и причины; недостаёт единого top-level представления для агрегации.

Но `token_usage: {}` в этом пути не заполняется, а `request_kind`, branch (`deterministic`, `llm`, `provider_fallback`, `replay`), количество вызовов, first-safe-sentence, guard/rejection codes и audience не вынесены в единый top-level формат. Это пробел агрегации, а не отсутствие provenance.

Без этого benchmark смешивает принятые model outputs и fallback.

### 9. Документация отстаёт от runtime

Активный код и prompt descriptor называют `narrator/v12` ([server/prompt-descriptors.mjs:35](../../server/prompt-descriptors.mjs#L35)).

Но [docs/narrator-craft.md:1](../narrator-craft.md#L1) всё ещё говорит «Ремесло Рассказчика v9», [docs/narrator-craft.md:58](../narrator-craft.md#L58) называет plan `v1`, а код возвращает `v2` ([server/narrator.mjs:245](../../server/narrator.mjs#L245)).

Соседний review опирается на v8 ([docs/narrator-dialogue-plan-review-2026-09-09.md:8](../narrator-dialogue-plan-review-2026-09-09.md#L8)). Старые benchmark нужно оставить историей и явно ограничить их применимость к v12.

## Варианты развития

### A. Минимальное расширение registry и trace — приоритетный путь

Добавить в текущий registry явный `channel`/`response_kind`, оставить numeric priority и расширить adapters для `QuestResolved`, `WorldFactRecorded`, condition changes, death saves, weather/transition и результата свободного действия.

В trace добавить нормализованные `branch`, `attempt_count`, `fallback_reason`, `guard_codes`, usage и audience, сохранив существующий `verification.origin` и совместимый API.

Плюсы: малая поверхность изменений, низкая задержка, точный replay и меньше риска регрессии. Это лучший первый путь для боя, экономики, ресурсов и коротких проверок.

Отдельный `NarrationCoordinator` вводить только после characterisation tests, если selection policy по-прежнему дублируется в нескольких ветках.

### B. Hybrid ResponsePlan + approved claims

Coordinator строит versioned `response-plan/v3`: `speech_act`, `channel`, `must_answer`, `stop_after`, `audience`, `approved_claims`, `memory_refs`, `max_questions`.

Claims получают только server IDs и source event IDs. Модель выбирает порядок, связки и стиль; verifier проверяет category и audience.

Плюсы: живой русский текст сохраняется, причинная галлюцинация уменьшается, один план подходит world narration, critical narration и NPC envelope.

Минусы: понадобится claim ontology для движения, знания, эмоции, обещания, предмета и причинности. ID не заменяет semantic guard.

Это рекомендуемый следующий архитектурный вариант.

### C. Director scene program / beat layer

Режиссёр после подтверждённого trigger предлагает bounded program: `focus`, `available_beats`, `foreshadowing`, `npc_intents`, `map_landmark_ids`, `exit_conditions`.

Это не команда и не механическое событие. Server policy проверяет IDs, visibility, присутствие NPC и достижимость карты; program попадает в brief как творческая опора.

Плюсы: последовательная сцена ощущается реактивной кампанией с темпом, развилками и foreshadowing.

Минусы: появляется планировщик рядом с `DirectorIntent`, `ActionAdjudicator` и `scene-architect`; нужны state/version/idempotency правила. Сначала хранить program в trace/read model, не в authoritative state.

### D. Character voice/social envelope

Оставить `NpcSocialController` владельцем мотивации, знаний, отношений и promises. Его результат сделать envelope с `speech_act`, `stance`, `claim_ids`, `disclosed_fact_ids`, `audience`, `voice_profile` и `reply`.

Общий Narrator получает только подтверждённый social result, а не private dossier. Плюсы: стабильные голоса, attribution и отдельное измерение NPC quality.

Минусы: две творческие роли увеличат latency/cost, если запускать их последовательно. Второй вызов — только под feature flag и только для public prose.

Сейчас стоит добавить envelope и русские fallbacks; художественный перерендер отложить до измерения пользы.

## Порядок работ

### P0 — наблюдаемость и контракт

- Добавить в trace `narration_branch`, `request_kind`, `audience`, `attempt_count`, `fallback_reason`, `first_safe_sentence_ms`, `guard_codes`, фактические provider/model и usage. Секреты и полный prompt не сохранять.
- Обновить `docs/narrator-craft.md`, dialogue review и prompt registry под `v12`, `few-shot/v2`, `response-plan/v2`; старые benchmarks пометить historical.
- Не объявлять модель вечным победителем: старые стенды были короткими синтетическими сериями и не покрывали v12.
- Добавить тест на соответствие `freeActionResponse` и основного хода одному envelope и тест на combat channel.

### P1 — registry/trace и compatibility envelope

- Сначала расширить текущий registry и trace, добавить characterisation tests для выбора ветки, replay и fallback.
- Если дублирование остаётся, вынести чистый `narration-coordinator.mjs` с интерфейсом `prepare`, `render`, `verify`, `replayFallback` за feature flag.
- `approved_claims` и claims ontology оставить экспериментом после N06; client ID никогда не является claim source. Любое включение claims в prompt считать поведенческим изменением и проверять отдельным corpus.

### P1 — минимальная запись quality в существующий trace

- После commit расширить redacted trace: turn, state version, branch, fallback reason, guard codes, craft feedback, prompt version, provider, model, latency и usage.
- При следующем ходе читать только party-visible feedback текущей кампании; NPC/private traces не смешивать с общей художественной памятью.
- Отдельный quality read model добавлять только после измерения retention/объёма; при рестарте feedback не меняет прошлый текст, но доступен следующему prompt как data-only hint.

### P2 — social envelope и recap dedupe

- Исправить русские social fallbacks и добавить тесты для `insight`, failed social check, rumor и private audience.
- Развести `session_resume` и `arc_transition`, сохранить источники раздельно, но использовать общий dedupe key и provenance.
- Не возвращать LLM suggestions как следующий ход: это решение активного контракта ([docs/narrator-craft.md:258](../narrator-craft.md#L258)); закрываемые hints остаются UX-слоем ([src/AppViews.tsx:547](../../src/AppViews.tsx#L547)).

### P3 — scene program после измерений

- Включать только для `story | chaos` и deterministic triggers: переход сцены, закрытие встречи, unresolved thread, critical outcome.
- Проверять каждую опору по map/world-memory projection и сохранять program с version/state version.
- При недоступности Director использовать policy fallback без изменения механики.

## Проверки и метрики

Для точечной проверки использовалась команда: `node --test test/narrator-response-plan.test.mjs test/deterministic-narration.test.mjs test/narrator-evidence-regression.test.mjs test/narrator-grounding-regression.test.mjs test/campaign-recap.test.mjs test/narration-stream.test.mjs`. В этом рабочем дереве прошли 125 тестов; тест recap не смог импортировать отсутствующий `dotenv`. В исходной копии на `cb045a84` те же 10/10 тестов recap прошли с пустым ключом и FakeLLM.

Реестр и приоритеты проверяются в [test/deterministic-narration.test.mjs:23](../../test/deterministic-narration.test.mjs#L23), grounding и replay — в [test/narrator-evidence-regression.test.mjs:47](../../test/narrator-evidence-regression.test.mjs#L47), security/visibility — в [test/security.test.mjs:149](../../test/security.test.mjs#L149), stream — в [test/narration-stream.test.mjs:1](../../test/narration-stream.test.mjs#L1), recap — в [test/campaign-recap.test.mjs:62](../../test/campaign-recap.test.mjs#L62).

Новые тесты должны проверять seam, а не повторять шаблон реализации:

- `test/narration-coordinator.test.mjs`: channels, priority, fallback, replay и отсутствие второго commit;
- `test/narration-claims.test.mjs`: source refs, visibility, negative claims, causal links и неизвестные IDs;
- `test/narrator-quality-store.test.mjs`: restart, retention, dedupe, private/public separation;
- `test/narrator-social-envelope.test.mjs`: русский fallback, attribution, promise/rumor и audience;
- `test/narrator-scene-program.test.mjs`: bounded beats, state version, landmark reachability и fallback.

Метрики считать отдельно для `world`, `combat`, `social`, `critical`, `question` и `replay`:

- critical grounding/visibility errors и guard codes;
- deterministic, accepted model и аварийный provider fallback;
- p50/p95 до первого безопасного предложения и полного финала;
- фактические provider/model, prompt version, input/output/reasoning tokens и стоимость;
- repetition 3-gram, linked-memory recall, scene-canon consistency и human pairwise preference на длинной цепочке;
- recap/feedback duplicates после рестарта и параллельных запросов.

Критерии выхода P1: ноль новых критических ошибок в regression corpus, 100% idempotent replay с тем же финалом, visibility invariants без исключений, trace с branch/fallback/usage и latency p95 не хуже текущего бюджета 12 секунд.

Для P2/P3 нужен длинный offline corpus; старые 12-сценочные сравнения годятся как smoke, но не как доказательство качества кампании.

## Итоговое решение

Оставить Rules Engine, Event Store, viewer projection, `NpcSocialController`, `DirectorIntent` и текущий deterministic fallback.

На первом этапе расширить registry/trace и добавить characterisation tests. Coordinator вводить только при доказанном дублировании selection policy; approved claims и claims ontology оставить после N06, а durable quality feedback добавлять по результатам измерения объёма и retention.

Scene program и claims ontology добавлять только после N06 и отдельного corpus; character voice — после измерений social envelope, чтобы новый агент не стал вторым источником механики и не разнёс ответственность по дополнительным модулям.
