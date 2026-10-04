# Последствия сцены: закрытая дверь, провал переговоров и исчезнувший свидетель

Дата: 2026-10-04. Срез: `cb045a84`, ветка `codex/bg3-experience-roadmap`.
Статус: исследование дизайна, не реализация. Рассматриваются только три сцены;
NPC-companion, музыка, новые зависимости и LLM в обычном ходе не добавляются.

## Рамка

**Факт.** Продуктовые принципы требуют, чтобы продолжение возникало из
подтверждённых действий, мир сохранял причинность, а провал развивал игру
([`docs/product-principles.md#L48`](../product-principles.md#L48), [`docs/product-principles.md#L56`](../product-principles.md#L56)).

**Факт.** Цикл уже разделяет ввод, авторизацию/видимость, серверную проверку,
события, commit, reducer, проекцию и повествование
([`docs/product-principles.md#L91`](../product-principles.md#L91)). Текст не может
сам открыть дверь, найти свидетеля или смягчить отказ.

**Внешнее наблюдение.** Failbetter разделяет выбор, участие и то, что происходит
позже; последствие не даёт выбору стать пустым, но его стоимость растёт вместе
со сложностью ([Choice, Complicity and Consequence](https://www.failbettergames.com/news/choice-complicity-and-consequence)).
Для «Сказания» это аргумент в пользу локальных последствий с одним источником.

**Внешнее наблюдение.** Emily Short описывает storylet как контент с
предусловиями и эффектами над состоянием мира; такие фрагменты можно связывать
с другими системами ([Storylets: You Want Them](https://emshort.blog/2019/11/29/storylets-you-want-them/)).
Текущие `worldMemory` и bounded-политики уже позволяют выразить такой узел.

**Внешнее наблюдение.** Для advancement move полезны «yes, but» и «no, but»:
цель может не быть достигнута, но попытка должна изменить мир так, чтобы
следующий шаг был осмысленным; постоянное «no, but» превращает героя в
беспомощного наблюдателя ([Expectation Gap in Interactive Story](https://emshort.blog/2019/02/05/story-robert-mckee/)).
Здесь «но» не означает автоматический успех и не раскрывает секрет.

**Внешнее наблюдение.** Официальная сессия GDC описывает разработку BG3 как
работу с масштабом и реактивностью, заставлявшую менять инструменты и подход
([Larian, The Secrets of Baldur's Gate 3](https://gdcvault.com/play/1034610/The-Secrets-of-Baldur-s)).
Для проекта это довод за маленький проверяемый контракт, а не за полный граф
реактивности BG3.

**Внешнее наблюдение.** Документация ink показывает ветвление, схождение и
переменные состояния, но отдельно оговаривает, что ink не является полной
моделью объектов и мира ([Writing with ink](https://github.com/inkle/ink/blob/master/Documentation/WritingWithInk.md#5-branching-the-flow)).
Значит, условия и эффекты остаются в Rules Engine, а нарративный слой лишь
показывает подтверждённый результат.

## Текущий срез кода

**Факт.** World Memory хранит сущности, факты, отношения, квесты, нити,
убеждения/слухи, summaries и личный ledger знаний; видимость и provenance —
часть записей ([`server/world-memory.mjs#L13`](../../server/world-memory.mjs#L13), [`server/world-memory.mjs#L466`](../../server/world-memory.mjs#L466)).
Команды уже включают `RecordWorldFact`, `UpsertQuest`, `AdvanceQuestClock`,
`ResolveQuest`, `InvalidateQuest`, `UpsertNarrativeThread` и слухи
([`server/world-memory.mjs#L343`](../../server/world-memory.mjs#L343)).

**Факт.** Прогресс активного квеста принимает только свежий `discovery` или
`quest_progress` по его сущности с `source_event_ids`; совпадение текста не
является доказательством ([`server/world-memory.mjs#L24`](../../server/world-memory.mjs#L24)).
Познавательная свободная проверка может записать такую улику отдельным commit
после события проверки ([`server/world-memory.mjs#L257`](../../server/world-memory.mjs#L257)).

**Факт.** `AdvanceQuestClock` проверяет улику, а `ResolveQuest` запрещает
success/failure до срабатывания часов; `abandoned` закрывает активный квест
решением отряда без часов ([`server/world-memory.mjs#L955`](../../server/world-memory.mjs#L955), [`server/world-memory.mjs#L974`](../../server/world-memory.mjs#L974)).
Редьюсер сохраняет часы, исход и proof IDs для replay
([`server/world-memory.mjs#L1128`](../../server/world-memory.mjs#L1128)).

**Факт.** Director принимает bounded intent-ы: исследование, социальная сцена,
квестовые часы, встреча, развязка, уход и зацепка
([`server/autonomous-campaign.mjs#L8`](../../server/autonomous-campaign.mjs#L8)).
Политика заменяет stale или stalled intent, но не придумывает механический
результат ([`server/campaign-loop-policy.mjs#L338`](../../server/campaign-loop-policy.mjs#L338)).

**Факт.** Заполненные часы дают `QuestResolved`, факт `quest_outcome` и новую
цель; это уже fail-forward для bounded clock, но не обработчик любого провала
сцены ([`server/autonomous-orchestrator.mjs#L319`](../../server/autonomous-orchestrator.mjs#L319), [`server/autonomous-orchestrator.mjs#L473`](../../server/autonomous-orchestrator.mjs#L473)).

**Факт.** Смерть обязательного NPC имеет proof-aware `QuestInvalidated`, а
   смена держателя должности — `QuestAssignmentChanged`; временное отсутствие NPC
   в эту политику не входит ([`server/quest-consequences.mjs#L158`](../../server/quest-consequences.mjs#L158), [`server/quest-consequences.mjs#L187`](../../server/quest-consequences.mjs#L187)).
## 1. Закрытая дверь

**Сцена.** Отряд приходит к запертой двери архива. Возможны `open`, `lockpick`,
`force`, баррикада и снятие баррикады. За дверью может быть цель, но до открытия
её нельзя показывать.

**Факт.** `OperateDoor` проверяет состояние, расстояние и баррикаду. `force` и
`lockpick` бросают серверную проверку и тратят действие; успешный `DoorForced`
делает дверь `broken`, успешный `DoorLockpicked` — `open`; провал оставляет её
без изменения ([`server/rules-engine.mjs#L17651`](../../server/rules-engine.mjs#L17651), [`server/rules-engine.mjs#L17683`](../../server/rules-engine.mjs#L17683), [`server/rules-engine.mjs#L17724`](../../server/rules-engine.mjs#L17724)).

**Факт.** Услышанный или замеченный взлом даёт `LockpickNoticed` с witness IDs;
пустая сцена молчит ([`server/rules-engine.mjs#L2725`](../../server/rules-engine.mjs#L2725)).
Успешное выламывание становится `destruction` только при свидетелях, а неудачный
бросок разрушением не считается ([`server/world-deeds.mjs#L312`](../../server/world-deeds.mjs#L312), [`server/world-deeds.mjs#L497`](../../server/world-deeds.mjs#L497)).

**Факт.** `materialConsequenceCommands` распознаёт `DoorStateChanged`,
`DoorBarricaded`, `DoorBarricadeCleared` и успешный `SceneObjectStateChanged`.
`DoorForced` и `DoorLockpicked` в этот отбор не входят даже при успехе:
дверь меняется reducer-ом, но этот helper не создаёт ей `scene_change`
в World Memory
([`server/autonomous-orchestrator.mjs#L199`](../../server/autonomous-orchestrator.mjs#L199)).
Состояние двери и долговременный пересказ её изменения — разные поверхности.
В пилоте нужно проверять обе, не заявляя, что каждое успешное изменение уже
становится отдельным фактом памяти. Сервер фиксирует и неудачную проверку,
но безлюдный провал сам по себе не выбирает нового сюжетного шага.
**Предложение.** Различать `unchanged_failure`, `noticed_failure` и
`opened_or_broken`. Первый ничего не открывает и не раскрывает; второй добавляет
только подтверждённый шум через существующие `LockpickNoticed`, `world-deeds` и
rumor tick; третий меняет карту обычными door events.

**Предложение.** Для authored-последствия можно записать существующим
`RecordWorldFact` один `door_attempt`, ссылающийся на `DoorForced`/`DoorLockpicked`
и `AbilityCheckResolved`, если этот факт нужен последующему правилу сцены.
Само журналирование попытки уже обеспечено событиями; дублировать каждую
проверку в World Memory не требуется. Устойчивая тревога или изменение маршрута всё равно
сначала требуют отдельного события и reducer, как говорит G02
([основной план, G02](../bg3-experience-roadmap-2026-10-04.md)).

**Предложение.** Следующий выбор — ключ, инструмент, другая дверь, обход,
ожидание, возвращение или отказ от цели — строится из видимой карты и памяти.
Если обхода нет, интерфейс честно сообщает тупик; повторный бросок не становится
бесплатным и провал не выдаёт секретную комнату.

**Критерии.**

1. Один commit содержит бросок, расход действия и door event; replay/idempotency
   не создают второй шум, факт или изменение карты.
2. При `success: false` нет `AreaRevealed` и сведений за дверью; `Door.state`
   остаётся прежним.
3. Свидетель существует только в момент попытки; без witness IDs не возникает
   rumor.
4. Authored-тревога имеет источник, порог и следующий наблюдаемый шаг, но не
   открывает дверь сама.

## 2. Провал переговоров

**Сцена.** Страж у ворот должен пропустить отряд к архиву. Игрок убеждает,
обманывает или запугивает его; после провала можно искать другой вход или
вернуться с новым аргументом.

**Факт.** Social policy выбирает навык, способность, СЛ, `check_id`, fingerprint
и visibility, а исход различает failure/severe_failure
([`server/npc-social-check.mjs#L7`](../../server/npc-social-check.mjs#L7), [`server/npc-social-check.mjs#L103`](../../server/npc-social-check.mjs#L103), [`server/npc-social-check.mjs#L140`](../../server/npc-social-check.mjs#L140)).

**Факт.** `RecordNpcSocialTurn` требует canonical check; при провале отношение
может ухудшиться, promise не создаётся, а NPC не раскрывает неизвестный факт или
слух ([`server/npc-social.mjs#L679`](../../server/npc-social.mjs#L679)). Commit
содержит `NpcConversationRecorded`, relation event и только разрешённый
`NpcPromiseRecorded` ([`server/npc-social.mjs#L822`](../../server/npc-social.mjs#L822)).

**Факт.** Такой отказ не становится автоматически `quest_progress`, нитью или
состоянием доступа: квестовый evidence path принимает только подтверждённые
`discovery`/`quest_progress` ([`server/world-memory.mjs#L24`](../../server/world-memory.mjs#L24)).
Во время боя отдельный `ProposeParley` создаёт `ParleyRejected`, и бой продолжается;
это нельзя смешивать с мирным разговором
([`server/rules-engine.mjs#L19544`](../../server/rules-engine.mjs#L19544)).

**Предложение.** Authored social node выбирает одну bounded-политику: `refusal`
(доступ закрыт, отношение хуже), `cost` (доступ после цены/времени/условия) или
`redirect` (публичный следующий адрес). Она исполняется после check event;
модель формулирует реплику только по выбранной политике.

**Предложение.** `refusal` может использовать `RecordWorldFact` и обычный
социальный командный путь: событие `NpcRelationshipAdjusted` выводится
из `RecordNpcSocialTurn`, а не отправляется клиентом как команда.
`cost` создаёт promise только после подтверждённого
согласия; `redirect` указывает существующую карту, активную нить или authored
зацепку. Провал не создаёт обещание и не раскрывает секрет.

**Критерии.**

1. Игрок видит check и отказ, но не получает несуществующие
   `disclosed_fact_ids`, `disclosed_claim_ids` или promise.
2. Меняется хотя бы одно подтверждённое поле: отношение, цена/время, доступ,
   публичная молва или оставленная нить; пустая реплика не называется
   fail-forward.
3. Следующий шаг не требует повторять ту же проверку до успеха: обход, другой
   NPC, доказательство, ресурс, бой или явный отказ от задания.
4. Репутация требует witness/provenance; private conversation не становится
общей молвой. `ParleyRejected` не превращается в скрытый договор.
## 3. Исчезнувший свидетель

**Сцена.** Квест требует показаний смотрителя. Отряд приходит после его ухода по
расписанию; он в другом месте или временно недоступен. Возможны pursuit, другой
источник или честное закрытие дела.

**Факт.** `registerNpcSchedule` сохраняет расписание фактом памяти и событием
`NpcScheduleRegistered` с `entries`. Реальный `executeNpcSchedules` читает
факты `npc_schedule`; для `depart` он вызывает `UpsertNpcSocialProfile` с
`available: false` и `RecordWorldFact` с predicate
`npc_scheduled_action_executed`. Этот путь вызывается при продвижении времени
([регистрация](../../server/autonomous-orchestrator.mjs#L2202),
[исполнение](../../server/autonomous-orchestrator.mjs#L2227),
[часы](../../server/autonomous-orchestrator.mjs#L2257)).
Событие `NpcScheduledActionExecuted` создаёт отдельный `scheduledNpcEvents`,
у которого не найден подключённый серверный вызов. Дополнительно
`applyAutonomyEvent` читает `payload.schedule`, хотя регистрация передаёт
`entries` ([второй контур](../../server/autonomous-campaign.mjs#L165),
[reducer](../../server/autonomous-campaign.mjs#L215)). Это несогласованность
двух представлений расписания, а не доказательство отказа действующего пути
через World Memory. Пилот следует строить на реально записанном факте и профиле.
Профиль по времени также не возвращает мёртвого NPC на смену
([`server/npc-social.mjs#L503`](../../server/npc-social.mjs#L503)).

**Факт.** Разговор с отсутствующим NPC отклоняется как
`NPC_SOCIAL_NPC_UNAVAILABLE`; `NpcConversationRecorded` и раскрытие знания не
появляются ([`server/npc-social.mjs#L679`](../../server/npc-social.mjs#L679)).
Однако `questInvalidationDraft` доказывает невозможность личного поручения
только смертью, а не `depart`/временной недоступностью
([`server/quest-consequences.mjs#L158`](../../server/quest-consequences.mjs#L158)).

**Факт.** Свидетели поступка фиксируются в момент действия; rumor tick требует
непустого witness set и идёт по графу мира
([`server/world-deeds.mjs#L291`](../../server/world-deeds.mjs#L291), [`server/world-deeds.mjs#L747`](../../server/world-deeds.mjs#L747)).
`propagateWitnesses` сейчас используется для исхода встречи, не для исчезновения
NPC ([`server/autonomous-orchestrator.mjs#L2144`](../../server/autonomous-orchestrator.mjs#L2144)).

**Предложение.** Разделить зависимости на `required_npc_dead` и
`required_witness_unavailable`. Второй статус срабатывает только по
party-visible `WorldFactRecorded` о выполненном расписании и серверной связи
с конкретным NPC; новый `witness_id` — лишь возможное поле будущего контракта.
Пустой список
NPC и догадка модели не считаются доказательством.

**Предложение.** У недоступного свидетеля выбрать ровно одно authored
продолжение: `pursue` (публичное место), `alternate` (другой источник) или
`close` (законно завершить дело). `pursue` использует существующий
`AdvanceScene`/голосование, `alternate` — `open_social_scene` и свежую
`discovery`, `close` — `ResolveQuest` с причиной и `next_objective`.
Для текущего `ResolveQuest` исход `failure` допустим только при сработавших
часах; временное отсутствие свидетеля их не заполняет. До этого момента
возможен подтверждённый отрядом `abandoned` или продолжение ожидания/поиска.
Новый автоматический провал по сроку потребует отдельного проверенного правила.
Ни один путь не переносит показания автоматически.

**Предложение.** Смерть сохраняет текущий proof-aware `QuestInvalidated` с
death fact; уход не маскируется под смерть. Journal и NarrationBrief различают
временную недоступность, постоянную потерю и продолжение по другой нитке.

**Критерии.**

1. При отсутствии нет разговора, disclosure или fake testimony; replay повторяет
   ту же availability/location проекцию.
2. Квест получает причину только из server-owned dependency и подтверждающего
   события; пустой профиль не считается смертью.
3. Публичное расписание даёт маршрут, private/GM расписание остаётся скрытым.
4. После `pursue`/`alternate`/`close` есть наблюдаемый commit; закрытый квест
   больше не двигает часы и не выдаёт скрытый успех.
## Решение для будущего PR

**Факт.** G02 уже требует ограниченную таблицу последствий: цена/время,
отношение, другой свидетель, опасный путь или плен; новое последствие сначала
получает событие и reducer. N05 требует provenance, субъекта знания и visibility
([основной план, G02 и N05](../bg3-experience-roadmap-2026-10-04.md)).

**Предложение.** Первые три тестовых среза: неудачный lockpick без свидетелей,
провал убеждения стражи и уход свидетеля по расписанию. Для каждого фиксируются
вход, один commit, новое состояние, следующий шаг, party/private/GM projection,
replay и idempotency. Это малые storylet-подобные узлы с server-owned
предусловиями/эффектами, не новый универсальный storylet-движок.

**Предложение.** Проверяемый brief каждого исхода должен иметь
`attempt_result`, `material_change`, `next_options`, `knowledge_boundary`. Пустой
`material_change` означает обычный отказ и не называется развитием; нарушение
`knowledge_boundary` ведёт к детерминированному безопасному тексту. Сервер
остаётся ESM, тесты — `node:test`, механика не уходит в LLM.

Эти названия — предлагаемые диагностические поля пилота, а не существующая
схема или обязательный новый DSL. Не всякий неудачный бросок требует нового
сюжетного факта: расход действия и сохранённая преграда могут быть достаточным
честным исходом. Дополнительное продолжение нужно прежде всего там, где
основная сцена иначе становится тупиком без доступного игрокам решения.
