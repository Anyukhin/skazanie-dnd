# Долгая память и русский Рассказчик: deep-dive

Дата: 2026-10-04. Baseline: `cb045a84`, ветка `codex/bg3-experience-roadmap`.
Объём: только исследование и офлайн-проверки; runtime, `data/`, `storage/`, промпты и `.env` не менялись. Предыдущий контекст — [аудит архитектуры Рассказчика](narrator-architecture-audit-2026-10-04.md).

## Решение для roadmap

У проекта уже есть долговечная каноническая память, а не только история чата: факты, связи, поручения, нити, убеждения, сводки, видимость, время, provenance и ledger личного раскрытия живут в `world-memory`. Нужен корпус проверок вокруг границы `retrieval → NarrationBrief → русский текст`, а не новая vector DB.

Для каждого кейса следует сохранять три независимых вердикта:

1. **Retrieval:** найдено ли правильное server-owned доказательство с нужной видимостью, временем, текущим статусом и `source_event_ids`.
2. **Brief selection:** дошло ли retrieved-доказательство до фактического model input после сборки `NarrationBrief`, включая лимиты и `memory_focus`.
3. **Generation:** упомянул ли принятый текст доказательство, которое реально было в model input,
   корректно, не добавил ли ложную причинность, устаревший факт, смерть или личное знание.

`retrieval_miss`, `brief_selection_miss` и `generation_miss` — разные причины. `generation_miss` разрешено ставить только если ожидаемый факт был в фактическом model input; если он исчез при сборке brief, это `brief_selection_miss`. `safe_abstention` — исход генерации на отсутствии разрешённого evidence, а не успех retrieval. Эти исходы нельзя смешивать в одну «память рассказчика».

Старые восемь ошибок моделей от 11 сентября здесь не используются как текущая уязвимость: они были повторно отклонены 12 сентября, активный контракт уже `narrator/v12` ([историческая запись исправлений](../narrator-craft.md#L1)).

## Что говорят первичные источники

Источники ниже нужны как формы вопросов, не как обещание качества в RPG.

- [LongMemEval, Wu et al., 2024](https://arxiv.org/abs/2410.10813) разделяет information extraction, multi-session reasoning, temporal reasoning, knowledge updates и abstention. Авторы дают 500 вопросов; [страница benchmark](https://xiaowu0162.github.io/long-mem-eval/) описывает варианты примерно на 115 тысяч и 1,5 миллиона токенов и подчёркивает, что retrieval и чтение найденного — разные стадии.
- [LoCoMo, Maharana et al., ACL 2024](https://aclanthology.org/2024.acl-long.747/) строит диалоги до 600 ходов, до 32 сессий и в среднем около 16 тысяч токенов; задачи включают QA, event summarization и мультимодальный диалог, а дальние временные и причинные связи остаются трудными.
- [Lost in the Middle, Liu et al., TACL 2024](https://aclanthology.org/2024.tacl-1.9/) показывает, что одна и та же релевантная запись может читаться хуже в середине длинного входа, чем в начале или конце. Для нас это метод контроля позиции, а не доказательство, что конкретная модель обязательно «забудет» середину.
- [LoCoMo-Plus, Li et al., ACL 2026](https://aclanthology.org/2026.acl-long.1150/) добавляет semantic disconnect: cue и применяемое позже ограничение могут быть разными словами. Это близко к скрытому мотиву NPC или обещанию, но не заменяет проверку авторитетных событий игры.

Из этих работ безопасно перенести пять идей: тестировать отсутствие факта, изменение факта, несколько сессий, порядок времени и место evidence в бюджете. Нельзя переносить опубликованные проценты на русский нарратив, event-sourced состояние или конкретный RouterAI provider. Для RPG gold должен быть server-owned event/record, а качество прозы — отдельной ручной или детерминированной проверкой claim-to-evidence.

## Фактическая поверхность памяти в baseline

`world-memory` нормализует `entities`, `facts`, `relationships`, `quests`, `threads`, `epistemic_claims`, `summaries` и append-only `knowledge_ledger`. Факт имеет visibility, `recorded_at_minutes`, `status`, supersession и `source_event_ids`; личное раскрытие связывает `hero_id` с `fact_id`. [Схема и reducer](../../server/world-memory.mjs#L495) сохраняют канон и replay, а [event handler](../../server/world-memory.mjs#L1097) помечает superseded-факт, не удаляя историю.

`worldMemoryForViewer` сначала режет projection по visibility и `asOfMinutes`, затем игроку оставляет только активные факты, которые либо normally visible, либо известны именно этому герою; superseded-факт не проходит одним лишь наличием knowledge entry. Скрытое знание не должно попадать в ranking через соседнюю запись. [Проекция](../../server/world-memory.mjs#L1209) и [player-facing retrieval](../../server/world-memory.mjs#L1465) сохраняют provenance только уже разрешённых записей.

`retrieveWorldMemory` — детерминированный lexical/stem/synonym/cosine поиск с одним графовым переходом по видимым отношениям, поручениям и нитям. `whenUnmatched: 'none'` даёт честный пустой результат; старый контракт `'all'` по умолчанию возвращает первые записи по ID для NPC и разговорных вызовов. Это полезная совместимость, но отрицательные narrator-кейсы должны явно проверять, какой режим был вызван ([retrieval](../../server/world-memory.mjs#L1428)).

Оркестратор строит запрос из сообщения, сцены и сводок событий, затем ограничивает мировые facts тремя публичными/party-записями; в `NarrationBrief` они уже без личных и GM-only значений ([сборка facts](../../server/game-orchestrator.mjs#L86), [brief после commit](../../server/game-orchestrator.mjs#L2770)). `narrationStoryContext` добавляет bounded-срез: две активные задачи, две нити, две сводки, два решения, до шести героев, четырёх NPC, обещаний и взаимодействий. `known_dead_npcs` выводится из party-visible активных фактов с predicate `died` ([story context](../../server/game-orchestrator.mjs#L153)).

`Narrator` использует `narrator/v12`, а `briefForNarratorPrompt` оставляет при релевантной связи только один `memory_focus`; короткий mechanical result может вообще отключить память и сценальную деталь ([focus](../../server/narrator.mjs#L538), [prompt projection](../../server/narrator.mjs#L618)). Полный brief остаётся у verifier, но генератор видит не весь retrieved set.

Три последних текста и quality feedback держатся в process-local ограниченных картах; после restart оркестратор один раз поднимает recent narration из trace. Это контур повторов и craft, не durable memory facts ([Narrator](../../server/narrator.mjs#L2056), [warm buffer](../../server/game-orchestrator.mjs#L1029)).

`CampaignRecapService` — отдельный resume-путь: после gap по умолчанию 8 часов он берёт party-safe сводки, открытые задачи/нити/обещания, кеширует по campaign и state version, а без модели делает deterministic fallback ([recap cache](../../server/campaign-recap.mjs#L46), [service](../../server/campaign-recap.mjs#L179)). Повторяющийся заголовок вроде «Пока вас не было...» дедуплицируется до самой свежей строки; это защищает место, но может скрыть важную промежуточную веху.

В имеющемся [autonomy evaluator](../../server/autonomy-eval.mjs#L11) есть `forgotten_facts` и `invented_facts`, а длинные прогоны заданы на 36, 42 и 48 ходов ([scenarios](../../eval/autonomous-scenarios.mjs#L35)). Эти counters не различают retrieval miss, omission принятого текста и безопасное воздержание; новый corpus должен оставить общий отчёт совместимым и добавить разрезы ниже.

## Failure modes длинной кампании

1. **Lexical retrieval miss.** Факт существует, но игрок говорит синонимом,
   редким падежом, прозвищем, косвенным cue или использует связь глубже одного
   графового шага.
2. **Retrieved hit → brief selection miss.** Нужная запись попала в top-3, но
   единственный `memory_focus` не выбран и она не попала в фактический model input.
3. **Model-input hit → generation omission.** Доказательство уже в model input,
   но accepted output его не называет.
4. **Hit → stale generation.** В brief одновременно видна старая summary, старый
   NPC dossier или прежний outcome; текст возвращает их после supersede/resolve.
5. **Historical cutoff ambiguity.** `asOfMinutes` ограничивает время, но текущий
   `fact.status` уже финально `superseded`. Исторический вопрос «что было тогда»
   и обычный cutoff — разные контракты; baseline не следует считать поддержанным
   replay исторического состояния без отдельного теста.
6. **Dead NPC resurrection.** Текущий факт смерти найден, но prose использует
   старый profile, indirect voice или неразрешённую социальную реакцию. Прямое
   имя + глагол уже guard-ится; перифразы должны быть отдельным corpus.
7. **False memory on no-match.** Вызов с режимом `whenUnmatched: 'all'` может
   вернуть первые записи по ID. Для NPC это намеренная совместимость, для
   narrator unknown-query это должен быть измеренный negative case.
8. **Abstention failure.** У игрока нет факта, но текст отвечает уверенно из
   похожего имени, соседнего NPC или шаблонной сводки.
9. **Session boundary loss.** Resume recap выбирает несколько свежих summary,
   а arc recap в `Narrator` имеет другой trigger, лимит и process-local dedupe.
10. **Personal/common mix-up.** Факт, известный одному герою, либо исчезает из
   его targeted answer, либо попадает в общий party narrator.
11. **Position and budget confound.** Важная запись вытеснена лимитом facts,
    story slots или стоит в середине длинного prompt. Это надо измерять на одном
    и том же corpus при контролируемом размере/позиции, не приписывая эффект
    модели без такого контроля.
12. **Restart divergence.** Канон и recap cache переживают restart, а recent
    narration/feedback и arc dedupe — только через bounded trace/RAM. Повторная
    сцена может быть безопасной, но художественно другой; это отдельный outcome.
13. **Provenance drop.** Retrieval знает `source_event_ids`, но narrator-facing
    world facts сокращаются до id, subject, predicate и summary. Оценщик должен
    сохранить candidate IDs до генерации, иначе причинную ошибку нельзя разобрать.

## Контракт оценки

Одна запись corpus — это JSON-файл/объект вне `storage/`:

```json
{
  "id": "N06-currentness",
  "viewer": {"playerId": "hero-a", "isPartyMember": true},
  "as_of_minutes": 180,
  "memory": "fixture or replay state",
  "query": "что сейчас у северных ворот?",
  "expected": {"evidence_ids": ["fact:gate-open"], "allow_empty": false,
    "audience": "party", "claims": ["gate-open"]}
}
```

Проба должна писать `retrieval` и `generation` независимо. Для retrieval:

- `evidence_recall_at_k`: нужный ID в top-k;
- `visibility_precision` и `visibility_leak_count`;
- `currentness_precision`: нет superseded/future записи;
- `temporal_recall`: факт попал в правильное `as_of` окно;
- `source_provenance_exact`: source event/knowledge entry совпал;
- `abstention_retrieval_precision`: unknown query вернул пусто.

Для generation, только после фиксации retrieval output:

- `supported_claim_recall`: ожидаемая мысль передана без расширения;
- `unsupported_claim_rate`: claim не выводится из event/fact/scene canon;
- `stale_claim_rate` и `dead_npc_resurrection_rate`;
- `visibility_leak_rate`: personal/GM/NPC-private в party тексте;
- `safe_abstention_rate`: отсутствие факта честно названо отсутствием;
- `resume_coverage` и `restart_semantic_consistency`;
- `position_delta`: worst/best при перестановке одной evidence-записи;
- `budget_delta`: изменение recall/omission при фиксированных малом и большом
  context budgets.

Между двумя списками нужен ещё `brief_selection_recall`: доля retrieved evidence,
которая действительно присутствует в model input. Критический report должен
различать пять исходов: `retrieval_miss`, `brief_selection_miss`,
`generation_miss`, `generation_unsupported` и `safe_abstention`.
`deterministic-fallback` не считать model success: сохранять ветку отдельно,
как уже требует [live narrator eval](../live-narrator-eval.md).

## Corpus: 16 минимальных сценариев

N01–N16 здесь — локальные номера случаев оценки, а не номера задач основного
плана. Таблица задаёт ожидаемое поведение будущего стенда; весь этот корпус
ещё не реализован и не прогнан с моделью. В частности, `fallback_unmatched`
ниже — предлагаемая классификация стенда, не существующее поле retrieval API.

| ID | Setup / вопрос | Retrieval expected | Generation expected | Ошибка/метрика |
|---|---|---|---|---|
| N01 | Свежий party fact о печати, прямое имя | fact в top-3, active | назвать находку и источник смысла | baseline recall + claim recall |
| N02 | Тот же факт через падеж, alias и синоним | тот же ID, не соседний | не подменить объект похожим | lexical miss, top-k |
| N03 | Вопрос о NPC, ответ в party-visible relation/quest-соседе | один graph hop | связать только разрешённых сущностей | graph recall |
| N04 | В вопросе есть GM-only NPC и party факт | GM-only не в ranking | текст не раскрывает NPC/факт | visibility precision |
| N05 | `fact:secret` открыт только `hero-a` | targeted retrieval даёт fact + ledger citation | ответ `hero-a` может знать; общий narrator — нет | personal/common leak |
| N06 | `gate-closed` superseded `gate-open`, вопрос «сейчас» | только active `gate-open` | не вернуть закрытые ворота | stale claim rate |
| N07 | Тот же state, `asOfMinutes` до replacement | контракт явно `historical` или `cutoff` | при historical — старый active на тот момент; при cutoff — пусто допустимо | temporal contract; не считать дефектом без решения |
| N08 | NPC имеет active party fact `died` и остался в старом dossier | death fact и known-dead ID | не описывать текущую жизнь/реплику погибшего | death retrieval + generation |
| N09 | Смерть названа косвенно, без имени в prose | death evidence доступно | indirect resurrection тоже отклоняется/уходит fallback | guard escape rate |
| N10 | Вопрос о незнакомом драконе | `whenUnmatched:'none'` → `[]` | «этого факта нет» без соседней легенды | abstention precision |
| N11 | Unknown query на пути с default `'all'` | результат помечен `fallback_unmatched`, не evidence | narrator не считает первые ID фактом | false-memory rate |
| N12 | 8+ часов перерыва, open quest/thread/promise | recap sources party-safe | коротко вернуть актуальную нить | resume coverage, leak |
| N13 | три summary одного title, между ними смерть/изменение | newest current + test fixture keeps event | не потерять значимое consequence ради дедупа | summary retention |
| N14 | restart после commit и после recap cache | same IDs, same citation, same cache text | безопасный текст; variation отдельно отмечена | replay/restart identity |
| N15 | Один evidence record по очереди first/middle/last в одинаковом budget | retrieval set одинаков | mention должен сохраняться | `position_delta`, Lost-in-Middle probe |
| N16 | top-3 содержит правильный fact и два distractor, FakeLLM молчит о fact | hit должен быть зафиксирован до LLM | omission = generation miss, не retrieval miss | hit→mention recall |

N01–N07 проверяются без внешнего LLM через `world-memory`; N08–N14 можно
подавать в `buildNarrationBrief`, deterministic narrator и verifier. N15 —
контролируемая prompt/brief проба; N16 — FakeLLM с заранее заданным output,
чтобы измерять seam и не покупать provider calls. Для N16 harness обязан сохранить
фактический model input: без этого omission нельзя назвать `generation_miss`.
Для N15 нельзя менять сразу позицию, число токенов, k и output budget: один фактор за прогон, затем
factorial/paired summary.

## Две выполненные офлайн-пробы

### P1: projection, time и личное знание

Inline fixture создал `fact:old` (superseded в 10 мин), `fact:new` (active в 40),
GM-only `fact:secret` и future fact в 90 мин; временный каталог не использовался.
`worldMemoryForViewer` при `asOfMinutes:30` вернул только ранее раскрытый secret:
old superseded не вернулся, new/future ещё не дошли до времени; текущая проекция
вернула `new`, `secret`, `future`, retrieval по «ворота» — `fact:new`, а
`retrieveKnownWorldMemory` — `fact:secret` с `event:secret`.

Это подтверждает visibility/time/knowledge boundary и одновременно фиксирует N07
как незакрытый контракт: projection использует финальный `status === 'active'`
вместе с cutoff. Проба не доказывает баг, пока не решено, должен ли `asOfMinutes`
означать исторический snapshot или только «не показывать будущее».

Минимальный воспроизводимый P1 (Node 20, без зависимостей и записи в `storage`):

```powershell
$source = @'
import { retrieveWorldMemory, retrieveKnownWorldMemory, worldMemoryForViewer } from './server/world-memory.mjs'
const memory = { schema_version: 2, entities: [{id:'loc:gate',kind:'location',name:'Северные ворота',visibility:'party'},{id:'npc:secret',kind:'npc',name:'Скрытый свидетель',visibility:'gm_only'},{id:'npc:lara',kind:'npc',name:'Лара',visibility:'party'}], facts: [{id:'fact:old',subject_id:'loc:gate',predicate:'condition',summary:'Старые ворота закрыты',visibility:'party',source_event_ids:['event:old'],status:'superseded',recorded_at_minutes:10},{id:'fact:new',subject_id:'loc:gate',predicate:'condition',summary:'Северные ворота открыты',visibility:'party',source_event_ids:['event:new'],status:'active',recorded_at_minutes:40},{id:'fact:secret',subject_id:'npc:secret',predicate:'knows',summary:'Скрытый свидетель знает имя предателя',visibility:'gm_only',source_event_ids:['event:secret'],status:'active',recorded_at_minutes:15},{id:'fact:future',subject_id:'npc:lara',predicate:'promise',summary:'Лара вернётся после заката',visibility:'party',source_event_ids:['event:future'],status:'active',recorded_at_minutes:90}], relationships:[], quests:[], threads:[], epistemic_claims:[], summaries:[], knowledge_ledger:[{id:'know:secret',hero_id:'hero:ada',fact_id:'fact:secret',source_event_ids:['event:reveal'],recorded_at_minutes:20}] }
const viewer = { playerId:'hero:ada', isPartyMember:true }
console.log({ current: worldMemoryForViewer(memory, viewer).facts.map(x => x.id), as_of_30: worldMemoryForViewer(memory, {...viewer, asOfMinutes:30}).facts.map(x => x.id), retrieval: retrieveWorldMemory(memory, viewer, {query:'ворота',whenUnmatched:'none'}).map(x => x.id), known: retrieveKnownWorldMemory(memory, {viewer, query:'свидетель предателя'}).map(x => x.id) })
'@
$source | node --input-type=module -
```

### P2: party-safe recap и reload cache

Временная fixture содержала публичные summaries, две строки с заголовком
«Пока вас не было...», GM-only summary/fact и активный квест. `recapSources`
оставил публичную последнюю строку и отфильтровал скрытое; deterministic text
содержал след, свежую offscreen новость и открытый квест. `CampaignRecapService`
без LLM выбрал `deterministic`, а новый `RecapCacheStore` на том же временном
файле после reload вернул записанный текст.

Проверены существующие 102 targeted tests командой:

```powershell
$env:ROUTERAI_API_KEY=''; $env:ROUTERAI_BASE_URL='http://127.0.0.1'; node --test test/world-memory-graph-retrieval.test.mjs test/world-memory.test.mjs test/campaign-recap.test.mjs test/narrator-craft.test.mjs test/narrator-evidence-regression.test.mjs
```

Это world-memory graph, visibility/knowledge, event/replay, campaign recap и narrator craft/evidence; все 102 прошли.
Сеть и `storage/` в пробах не использовались. Результаты P1/P2 — characterization baseline, не benchmark score и не обещание качества модели.

## Как запускать следующий corpus

1. Фикстуры хранить в `eval/` или временном каталоге, не в `storage/`; каждый
   case должен иметь state version, viewer, `as_of_minutes`, evidence IDs и
   expected audience.
2. Сначала вызывать `worldMemoryForViewer`/`retrieveWorldMemory` и сохранять
   полный ranked result с режимом `whenUnmatched`, затем строить brief.
3. Передавать FakeLLM заранее выбранный accepted output и запускать текущие
   `verifyNarration`/`verifyNarratorCraft`; production provider нужен только для
   отдельного, явно оплаченного quality sample.
4. Считать model output и deterministic fallback раздельно; report должен
   включать branch, prompt version, context budget и candidate IDs.
5. Для каждого miss сохранять минимальный counterexample: evidence ID,
   visibility, timestamp, query, rank, focus kind, output claim и guard code.

Начальные критерии smoke: ноль visibility/death/personal leaks; ноль
`unsupported_claim` на deterministic corpus; 100% replay/cache identity; по
N10–N11 safe abstention без ложного top-ID; N15 публиковать как delta и sample
size, без заранее обещанного порога. Для художественного model-only corpus
нужна ручная разметка claim equivalence на русском; string match недостаточен.

## Что делать дальше

Сначала добавить corpus и нормализованный trace/eval-разрезы в существующий
pipeline. Затем уточнить historical meaning `asOfMinutes`, retention важных
summary при одинаковом title и поведение narrator path при no-match. Alias/query
нормализацию и двухступенчатую проверку можно расширять только после наблюдения
конкретного miss.

Не добавлять отдельную vector DB, второй memory coordinator или ещё один
долговечный store для этой задачи. Они не решают visibility, supersession,
личное знание и claim verification; сначала измеряется уже имеющийся
deterministic retrieval и bounded NarrationBrief. Любой будущий retrieval upgrade
должен сохранить server-owned source IDs, viewer projection и безопасный fallback.
