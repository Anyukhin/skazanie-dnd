# Продуктовый и Spec-аудит «Сказания»

Срез выполнен на `c7efdca614cc33f706258d036e86f01c1f189404` (4 октября 2026
года). Проверены `docs/product-principles.md`, `README.md`,
`docs/current-architecture.md`, `docs/target-architecture.md`,
`docs/known-limitations.md`, `docs/rules-coverage.md`, `docs/ROADMAP.md`,
`docs/playability-plan-2026-09-27.md`, связанные спецификации, серверные
маршруты и профильные тесты. Внешнее сравнение похожих проектов отражено в
[соседнем обзоре](./01-comparable-projects.md); ниже важен перенос полезных
идей в проверяемые вертикальные срезы самого проекта.

## Spec

Продуктовая цель сформулирована правильно: группа должна без человека-ведущего
создать, пройти и завершить связную кампанию, сохранив свободу действий,
причинность, серверную честность и тактический бой
([product-principles.md:18](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/product-principles.md#L18),
[product-principles.md:48](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/product-principles.md#L48)). Это цель
продукта, а не утверждение, что текущий runtime уже её выполняет целиком.

Уже доказаны следующие части. Обычный аккаунт может создать кампанию через
проверенный `bootstrap`, получить первый слот и выпустить приглашение; сервер
сам создаёт 1–5 слотов и не принимает от игрока авторитетный raw state
([index.mjs:3934](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L3934),
[README.md:778](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/README.md#L778)). Membership хранится отдельно от
глобального списка героев, приглашения hashed и выдача следующего свободного
слота идемпотентна ([store.mjs:209](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/store.mjs#L209),
[store.mjs:228](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/store.mjs#L228)). Обычный участник вызывает
`/autonomy/advance`, а сервер ограничивает actor ownership, состояние кампании,
голосование и повтор ключа ([index.mjs:4480](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/index.mjs#L4480));
это подтверждено HTTP-сценарием с двумя аккаунтами, restart и resume по
`interaction_id` ([director-player-entry-api.test.mjs:103](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/director-player-entry-api.test.mjs#L103)).

Серверная причинность тоже не фиктивна: world memory хранит source event IDs,
прогресс квеста требует подтверждённых facts, а lifecycle и эпилог проходят
Rules Engine ([world-memory.mjs:930](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/world-memory.mjs#L930),
[campaign-lifecycle.mjs:350](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/campaign-lifecycle.mjs#L350)).
Автономный тест проверяет 30+ шагов, бой, награды, расписание NPC, replay и
restart ([autonomous-campaign.test.mjs:374](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/autonomous-campaign.test.mjs#L374)).
Однако этот тест напрямую вызывает `runIntent`, `runCommands`, `runCombat` и
`completeEncounter`, а не проводит группу через основной браузерный UI. Он
доказывает доменный контур, но не полную замену ведущего для игроков.

Есть четыре настоящих продуктовых границы.

- Свободный текст пока bounded: модель выбирает прочтение и маршрут, а
  `travel/talk/clarify` либо открывают существующий путь, либо возвращают
  уточнение ([action-adjudicator.mjs:34](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/action-adjudicator.mjs#L34),
  [autonomous-orchestrator.mjs:845](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomous-orchestrator.mjs#L845)).
  Универсальный физический эффект не создаёт новый факт мира; причинные факты
  автоматически materialize только для узкого набора дверей и scene props
  ([autonomous-orchestrator.mjs:199](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/autonomous-orchestrator.mjs#L199),
  [known-limitations.md:2734](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/known-limitations.md#L2734)). Это
  принятое ограничение, пока каталог эффектов явно ограничен; нарушением будет
  выдавать такой текст за общую настольную свободу.
- Финал уже event-sourced, включая мирную развязку, но выбор главной нити и
  допуск к автоматическому финалу всё ещё упрощены: берётся первая активная
  не-сценическая цель, а для арки используются bounded `target_scenes`, clock и
  `campaignArcClimaxSatisfied` ([campaign-loop-policy.mjs:182](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/campaign-loop-policy.mjs#L182),
  [campaign-lifecycle.mjs:350](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/campaign-lifecycle.mjs#L350)).
  Ограниченная арка `one_evening` — осознанная политика, а эвристика выбора
  основной нити — следующий доменный долг.
- Правила честно маркируются `verified/partial/heuristic/ruling-only`, но 439
  карточек заклинаний остаются частичным каталогом; наличие карточки или
  VFX не равно исполняемому правилу ([rules-coverage.md:416](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/rules-coverage.md#L416),
  [known-limitations.md:1704](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/known-limitations.md#L1704)).
  Следующий результат должен закрывать маленький именованный пакет от
  источника до UI, а не расширять каталог без runtime-пути.
- Persistence годится для single-writer deployment, но summary перечитывает
  весь event log, а multi-process и production restore не доказаны
  ([known-limitations.md:3100](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/known-limitations.md#L3100)).
  Это эксплуатационное ограничение, не повод сейчас менять Node/FileEventStore
  на другую платформу.

Документация заметно дрейфует относительно baseline и не должна служить
основанием для нового продукта без сверки с кодом. `current-architecture.md`
всё ещё называет `POST /api/campaigns` admin-only
([current-architecture.md:89](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/current-architecture.md#L89)), хотя
сам маршрут и README поддерживают self-service. Там же остались утверждения о
hero assignment вместо отдельного membership, отсутствии visibility-фильтра у
explanation и отсутствии durable token quota
([current-architecture.md:286](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/current-architecture.md#L286));
фактически membership реализован, `turnExplanationForViewer` фильтрует команды,
rolls и events ([viewer-projection.mjs:2530](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/viewer-projection.mjs#L2530)),
а `DurableUsageLedger` пишет резервирование и расход токенов на диск
([usage-ledger.mjs:95](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/server/usage-ledger.mjs#L95)). Клиент использует
SSE с 15-секундным polling fallback, а не старый polling раз в 1,5 секунды
([useGameSession.ts:619](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L619),
[useGameSession.ts:762](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L762)). Запись о том, что
level-up UI отсутствует, также устарела: header chip и окно подтверждённого
уровня уже есть ([App.tsx:299](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/App.tsx#L299),
[App.tsx:334](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/App.tsx#L334)); аналогично stale-заметка о том, что
ставки свободной проверки не показываются, противоречит карточке proposal
([App.tsx:492](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/App.tsx#L492),
[known-limitations.md:2740](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/known-limitations.md#L2740)).
`stack-plan.md` описывает зависимости как `latest`, хотя `package.json` уже
закреплён диапазонами `^` ([stack-plan.md:38](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/stack-plan.md#L38),
[package.json:53](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/package.json#L53)); `agent-architecture-plan.md`
ссылается на baseline июля и старые prompt versions
([agent-architecture-plan.md:7](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/agent-architecture-plan.md#L7)).
Это документационный дефект, который следует закрыть отдельным reconciliation
проходом, а не трактовать как runtime-регрессию.

## Следующие продуктовые вертикали

Эти IDs — кандидаты для обсуждения, а не согласованные спецификации. Приоритеты
P1/P2 ниже являются рекомендацией этой проверки; окончательный порядок остаётся
за общей дорожной картой root.

### SPEC-01 — Приёмка «обычные игроки проходят вечер» — P1 candidate

Базовый HTTP MVP уже проходит обычный пользовательский цикл: Director встреча,
полный бой, server-owned награда, отдых, restart и три связанные сцены
([README.md:720](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/README.md#L720),
[mvp-player-cycle-api.test.mjs:979](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/test/mvp-player-cycle-api.test.mjs#L979));
`/autonomy/advance` остаётся
обычным игровым запросом ([README.md:787](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/README.md#L787)). Кандидат
закрывает оставшуюся приёмку: свежие две браузерные сессии, отдельный smoke
впятером с отключением участника и свободно заданная сюжетная цель. Для этой
приёмки запрещены admin endpoint, `runCommands`, ручные кости и редактирование
storage. Волна 2 именно так обозначена в плане: частично принята, а партия из
пяти и свободная цель ещё не закрыты
([playability-plan-2026-09-27.md:23](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/playability-plan-2026-09-27.md#L23),
[playability-plan-2026-09-27.md:49](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/playability-plan-2026-09-27.md#L49)).
Критерий: две независимые браузерные сессии и отдельный smoke впятером;
100% переходов и наград восстанавливаются тем же idempotency key, после restart
состояние и журнал совпадают, в логах `admin_commands: 0`.

### SPEC-02 — Явная цель кампании и причинный финал — P1 candidate

Ввести в campaign concept версионированный `campaign_goal_id` и server-owned
набор evidence predicates/зависимостей. `QuestResolved`, `WorldFactRecorded`,
отношения NPC, обещания и решения группы должны ссылаться на цель или её
подцель; `CampaignCompleted` обязан содержать доказательство цели, а не только
первую подходящую запись квеста. Сохранить bounded `one_evening` и
`persistent` режимы: расширяется причинность, не обещается бесконечный
генератор. Критерий: минимум три seeded сценария — успех через бой, успех через
переговоры и провал/отказ с продолжением — дают разные исходы; unrelated quest
не закрывает цель; каждый финальный факт имеет source event IDs; replay и
повтор ключа идентичны. Это адресует зафиксированный приоритет связать цель с
реальными событиями, а не только устранить ложный успех
([playability-plan-2026-09-27.md:39](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/playability-plan-2026-09-27.md#L39)).

### SPEC-03 — Свободное действие → наблюдаемое последствие — P2 candidate

Выбрать один расширяемый bounded vocabulary: `ignite/topple/take`, двери,
видимые опасности и передача предмета. Для него сделать общий capability
контракт `reading → proposal → typed command → event → world fact → viewer
projection`; UI до броска показывает цену и провал, а успех меняет карту или
отношение только через известное событие. Не разрешать модели сочинять
произвольные числовые эффекты. Критерий: 20 русских/английских формулировок
проходят в один из разрешённых типизированных маршрутов, неоднозначные ссылки
возвращают уточнение без расхода, каждая успешная материальная смена имеет
fact/source IDs и видна после reconnect, а 100% `heuristic/ruling-only` отказов
происходят до ресурса и экономики. Это превращает принцип свободы в
расширяемый каталог, сохраняя принятое ограничение на универсальный homebrew.

### SPEC-04 — Один поимённый пакет правил до `verified` — P2 candidate

Взять следующий dependency-safe срез из v3 (например, один классический
spell-family и связанное окно реакции или item/attunement profile) и довести
его по цепочке source → ruleset → handler → events/reducer → projection → 2D/3D
UI. Capability должна приходить серверной проекцией, чтобы UI не дублировал
таблицу статусов. Критерий: у каждого выбранного ID есть source/provenance,
`verified` либо честный `partial`, HTTP/UI-путь для обычного игрока, отказ до
расхода ресурса, replay/idempotency и две вкладки; `spells:verify` и профильный
acceptance gate зелёные. Расширять все 439 карточек до этого результата
неэффективно: текущая дорожная карта уже требует пилоты в фиксированном порядке
([playability-plan-2026-09-27.md:53](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/playability-plan-2026-09-27.md#L53)).

### SPEC-05 — Автономная тактика партии — P2 candidate

Уточнить server-owned policy для автономных героев: к текущим перемещению,
базовой атаке и зелью добавить один проверенный выбор class action/spell с
ресурсом, целью и реакцией. Director encounter path уже покрыт обычным MVP;
это предложение касается глубины тактики, а не недостающего подключения UI.
Поскольку продуктовый принцип запрещает агенту принимать решение за героя
([product-principles.md:61](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/product-principles.md#L61)),
автономная тактика должна быть явным opt-in владельца для каждого героя,
видимым в кампании, обратимым и выключенным по умолчанию; игрок сохраняет
ручное управление. Критерий: 3 класса, 2 spell/resource cases и один
multi-target сценарий; решения одинаковы при replay, NPC и opt-in policy
используют одни typed commands; бой завершается наградой через обычный
`/autonomy/advance`; LLM не вызывается в горячем боевом ходу. Текущая граница
тактики прямо зафиксирована как «три правила, но не заклинания»
([known-limitations.md:2844](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/known-limitations.md#L2844)).

### SPEC-06 — Долгая кампания и восстановление — P1 candidate

Текущий performance-срез показывает, что проблема измеряется не только длиной
event log: expanded HTTP отвечает примерно 6,17 MB, p50 — 4 501 ms, p95 —
7 327 ms, тогда как small fixture имеет p50 87 ms и p95 111 ms
([performance-current.json:1792](./performance-current.json#L1792)). Поэтому
сначала нужно разложить expanded path на payload size, clone/serialization,
normalization, projection, response transfer и чтение журнала; выбор индекса
или ограничения event log делать только после этого профиля. Затем провести
принудительный crash между commit и projection, backup/restore и 1000+ событий
на 2–5 игроков. Критерий: один опубликованный порог p95 по команде и reconnect,
replay/hash совпадают до и после restore, нет потерянного или удвоенного
события; multi-process либо остаётся явно single-writer режимом, либо получает
отдельный storage adapter. Это соответствует незавершённой волне долгой игры,
а не абстрактной миграции стека
([playability-plan-2026-09-27.md:55](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/playability-plan-2026-09-27.md#L55)).

## Порядок и обновление спецификаций

Сначала принять срез 1 и цель из среза 2, затем срезы 3–5, после чего срез 6.
Каждый срез должен иметь одну короткую спецификацию с owner-модулями,
event/schema version, browser acceptance и таблицей `verified/partial`.
Отдельным малым коммитом нужно синхронизировать корневой `README.md`, `current-architecture.md`,
`known-limitations.md`, `rules-coverage.md`, `stack-plan.md` и
`agent-architecture-plan.md` с baseline; устаревший текст не должен оставаться
источником приоритета. В дорожной карте уже закреплено правило переносить в
«Доставлено» только доказанную реализацию и оставлять отложенное явно
([ROADMAP.md:48](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/ROADMAP.md#L48)).
