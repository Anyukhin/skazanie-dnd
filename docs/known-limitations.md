# Известные ограничения

## Главный статус

Runtime переведён на единственный режим `enforce`. `server/index.mjs` подключает Rule Pack/Retriever, Dice Service, Roll Registry, Rules Engine, FileEventStore, Game Orchestrator, Narrator, Verifier и Trace Store. Legacy/shadow execution, browser gameplay fallback и broad room `PUT` удалены.

Compatibility room пока остаётся server-owned read-моделью для UI. Кодовый cutover завершён, однако production data cutover не завершён: `cutover:verify` обнаруживает расхождения существующих room/snapshot/replay и поэтому останавливается без изменения данных.

## Покрытие правил и механики

Карточки боевых заклинаний и действий теперь имеют явный статус механической готовности: `verified`, `partial`, `heuristic` или `ruling-only`. Интерфейс показывает неполные статусы, а `heuristic` и `ruling-only` блокируются и на клиенте, и Rules Engine до расхода ресурсов или экономики хода. `partial` разрешён только для уже исполняемой безопасной части и сопровождается описанием ограничения. Это сохраняет полный каталог как справочник, но не выдаёт автоматически сгенерированную карточку за готовую механику.

Текущий статус не означает полного покрытия: большая часть импортированного каталога заклинаний и множество сгенерированных классовых особенностей остаются `heuristic` или `ruling-only`. Для их включения нужны отдельный серверный handler, события/reducer, проверки replay/idempotency и изменение статуса на `verified` либо честно ограниченный `partial`.

Rules Engine доступен через typed `/api/campaigns/:id/commands` и orchestrated `/api/narrate` path. Обычному игроку endpoint разрешает безопасный боевой набор, включая `MakeAttack`, `MakeAreaAttack` и `ChangeWeapon`, за назначенного героя; admin имеет расширенный диагностический набор. Реализованы базовые checks/saves/attacks, damage/healing/temp HP, modifiers, generic resources/conditions, initiative, часть action/movement economy, автоматические проверки концентрации и базовый zero-HP lifecycle. Ограничения:

### Critical hits

Новый Engine для атаки трактует natural 1 как промах, natural 20 как critical и преобразует, например, `1d8+2` в `2d8+2`: удваиваются только кости, не модификатор. Для структурированных ranged-предметов используется DEX, normal/long range и помеха в дальнем диапазоне или рядом с противником; старые луки, арбалеты, гранаты и динамит распознаются по названию. Остаточное ограничение — нет полного справочника всех оружейных свойств, cover, сложных damage riders и учёта боеприпасов; гранаты/динамит являются явно заданным правилом кампании, а не общей гарантией SRD.

### Action economy

Action расходуется для attack/spell; combat spell с casting time `bonus_action` отдельно расходует бонусное действие. В server-authoritative combat перемещение учитывается по пройденному ортогональному пути и сбрасывается при начале следующего хода. Реакция отображается и восстанавливается вместе с экономикой хода. Есть проверяемые окна для ряда защитных реакций и атаки по возможности; универсальные `Ready`, произвольные триггеры и одновременные конкурирующие окна пока отсутствуют.

### Conditions

Engine хранит generic condition ID/duration, но не применяет индивидуальные эффекты blinded, prone, stunned, poisoned и остальных состояний.

### Concentration

Единый post-damage pipeline обрабатывает урон от атак, заклинаний, реакций, областей и периодических эффектов. После фактически полученного урона он программно считает СЛ `max(10, floor(damage / 2))`, добавляет модификатор Телосложения, классовое владение спасброском, Bless/Bane, Mind Sliver, Silvery Fortune и Aura of Protection, затем сохраняет бросок и исход событиями. Провал очищает связанный концентрационный эффект; падение до 0 ОЗ завершает его без броска, а полностью поглощённый временными HP урон всё равно требует save. Остаточно не закрыты все внешние причины прекращения концентрации и полный каталог эффектов/состояний.

### Zero HP и смерть

Базовый lifecycle SRD 5.2 реализован событиями: при 0 ОЗ герой получает `unconscious`, в начале своего хода автоматически бросает серверный d20, три успеха стабилизируют, три провала убивают, натуральная 1 даёт два провала, а натуральная 20 возвращает 1 ОЗ. Урон при 0 ОЗ снимает стабильность и добавляет один либо два провала при критическом попадании; массивный урон убивает сразу. Действие «Стабилизировать» делает Wisdom (Medicine) СЛ 10, настоящее лечение снимает бессознательность и сбрасывает счётчики, а бой нельзя завершить с нестабильным героем. Стабильный герой получает event-sourced таймер `1d4` часа; `AdvanceTime` уменьшает его, а полностью бессознательный стабильный отряд автоматически проматывает время только после безопасной победы без живых врагов, до пробуждения первого героя на 1 ОЗ. При исходе `party_incapacitated` с живыми врагами сервер не предполагает, что противники будут ждать: дальнейший исход должен разрешить рассказчик. Смерть и восстановление остаются replay-safe; смерть требует выбора «воскресить» или «заменить», а гибель всей группы завершает кампанию. Nonlethal knockout реализован отдельным явным выбором: сервер допускает его только для trusted melee-профиля оружия или проверенной ближней атаки заклинанием, оставляет цели 1 ОЗ, накладывает `unconscious`, начинает короткий отдых на 60 минут и завершает состояние после отдыха, лечения или успешной Wisdom (Medicine) СЛ 10. Нокаутированная цель остаётся живой, но не получает ход и считается выбывшей при определении конца боя.

Bless и Bane теперь программно добавляют/вычитают 1к4 из итогового death save, сохраняя особое значение натуральной 1/20. Beacon of Hope допускает целью героя с 0 ОЗ, даёт преимущество на death save и максимизирует кости любого получаемого лечения; броски, источники модификаторов и итог сохраняются в событиях и журнале. Death Ward один раз перехватывает любое серверное повреждение, которое опустило бы цель до 0 ОЗ, оставляет 1 ОЗ и расходует эффект; отдельного generic instant-death-without-damage пути в движке пока нет. Aura of Life действует как позиционная 30-футовая аура концентрации: для заклинателя и союзников внутри радиуса она даёт сопротивление некротическому урону, блокирует доверенное уменьшение максимума ОЗ и перед death save восстанавливает 1 ОЗ существу, начавшему ход с 0 ОЗ; перемещение, потеря сознания и завершение концентрации сразу меняют результат. Aura of Protection доступна паладину с 6-го уровня: его бонус Харизмы (минимум +1) применяется к нему и союзникам в 10 футах, отключается при недееспособности, выбирает сильнейшую из пересекающихся аур и участвует в обычных, заклинательных, death и concentration saves. Fighter Indomitable доступен на уровнях 9–12 один раз за Long Rest и атомарно перебрасывает любой проваленный save с бонусом уровня воина; внутренний dice transcript скрыт публичной проекцией. Resistance приведён к редакции 2024: игрок выбирает один из 11 типов, а общий damage pipeline уменьшает первый подходящий урон каждого хода на серверный 1к4, не расходуя концентрационный эффект. До полного набора исключений 1–12 уровней всё ещё не хватает Heroic/Bardic Inspiration и предметных эффектов.

### Initiative и turns

Есть сортировка, active index/round и команда/event `EndCombat`/`CombatEnded`; собранная встреча дополнительно получает `EncounterEnded`. Bounded scheduler автоматически пропускает побеждённых и завершает базовый бой, когда не осталось живых героев либо врагов. Автономный completion применяет ограниченные XP/loot и последствия ровно один раз. Tie policy упрощена; отсутствуют surprise, held/delayed turns, групповые ходы союзников с одинаковой инициативой и полноценные objective/morale outcome policies.

### Карта, дальность и NPC scheduler

В `enforce` ортогональный BFS проверяет проходимые клетки, стены, occupancy, скорость и уже потраченное movement; дальняя атака использует сеточную дистанцию, проверяет прямую траекторию через стены, а метательный предмет — серверную область. Присланные клиентом distance/path/range не считаются источником истины. Выход из соседней зоны досягаемости вызывает атаку по возможности, расходует реакцию, учитывает `Отход` и обездвиживающие состояния; для хода героя сервер разрешает её автоматически, для хода NPC открывает игроку окно выбора. Ограничения: нет difficult terrain, размерности существ и reach больше 5 футов, forced movement, cover, высоты/трёхмерной LOS и per-player vision.

NPC scheduler представляет bounded deterministic policy: оценивает допустимые пары «цель + действие», дальность и ожидаемый урон, добивание, КД цели, контроль, поддержку союзников и безопасную позицию для дальнего боя. Он выбирает ближнюю или дальнюю атаку, умеет один раз применять паутину, использует ловкое отступление и агрессивный рывок, а также учитывает тактику стаи и воинское преимущество. Это не `npc_controller` и не LLM Tactical Controller: нет полноценного планирования на несколько ходов, spellcasting, multiattack, сложных реакций, cover/высоты и взаимодействия с окружением.

### EncounterAssembler и mini-compendium

Director flow и диагностический Admin UI/API в `enforce` умеют собрать и сразу начать встречу. Обычный клиент вызывает только `/autonomy/advance`, не выбирая stat blocks или координаты. Сервер принимает allowlisted difficulty/theme, считает официальный XP Budget per Character SRD 5.2.1 и выбирает противников из 12 server-owned profiles. Spawn ограничен раскрытыми проходимыми клетками без feature/occupancy и минимум в 10 футах от каждого героя; `EncounterCreated` и `CombatStarted` входят в один commit.

Это не полный encounter/monster subsystem. 12 записей поддерживают несколько профилей атак и ограниченный набор исполняемых traits/особых действий, но не образуют полный monster corpus: нет полной модели saves/skills, resistances/immunities, multiattack, spellcasting, legendary/lair actions, recharge и большинства реакций. Loot/rewards ограничены небольшой server-owned таблицей; два клиента сходятся через campaign-scoped SSE, а редкий пропуск восстанавливается фоновым polling, но multi-process coordination и длительного soak-теста пока нет.

### Resources, rest и spells

Generic и классовые resource pools восстанавливаются по server-owned short/long
rest policy; level-up пересчитывает maxima и добавляет открывшиеся ресурсы.
Основная доска использует bounded server-owned combat spell catalog: spell
attack/save, области, upcast для поддержанных профилей, лечение, summons,
дальность и концентрация. Это всё ещё не полный spellcasting corpus: для всех
439 карточек не формализованы components, редкие class interactions и сложные
эффекты. Неподдержанные карточки помечаются partial/ruling-only, а не выдаются
за точную механику.

Выбор развития, `LevelUp`, versioned importer и предметные
equip/use/consume/transfer/weight/attunement теперь event-sourced и проверяются
сервером. Ограничение находится в ширине контента: item-use profiles пока
охватывают bounded каталог (включая healing potion/rations и базовую
экипировку), а не все mundane/magic items D&D.

### Worldkeeper и персональная память

Canonical entities/facts/quests и quest clocks дополняются персональным `knowledge_ledger`. Подтверждённое раскрытие факта NPC создаёт `KnowledgeRevealed` только для героя-собеседника; старые массивы `knowledge` мигрируют при нормализации. Worldkeeper фильтрует видимость и время действия факта до поиска, а `/explanation` проецирует private events для запрашивающего героя.

В горячем пути Narrator получает не весь канон, а максимум три релевантных
public/party-факта через deterministic retrieval; личные `gm_only` факты не
попадают в его brief даже если герой их знает. Director получает bounded
выборку незакрытых нитей и завершённых обещаний, а NPC social controller —
релевантную выборку из отдельного server-owned allowlist. Входы всех трёх
контуров передаются модели как `UNTRUSTED_DATA`; измеренный рост среднего
размера Narrator-подсказки для трёх фактов — 1,43× на фиксированном наборе из 10
репрезентативных brief.

Canonical narrative threads, entity relationships, beliefs/rumors с
truth/provenance и scene/session summaries реализованы. Retrieval использует
visibility/time-first deterministic semantic-like ranking, но не внешнюю
обученную embedding model и не production vector database; синонимы и stemming
остаются bounded и могут давать false negatives.

### Торговля и предметы

В `enforce` есть server-authoritative витрина, команды `BargainWithMerchant`, `AppraiseItem`, `BuyItem`, `SellItem` и `PurchaseMerchantService`, целочисленная валюта, server catalog, versioned appraisal policy, bounded merchant pricing/purse, canonical `location_id`, проверка владельца/локации/версии и атомарные event commits. Клиент не передаёт цену, appraisal policy или результат броска и не делает optimistic mutation.

Это узкий economy slice. Ручной `RestockMerchant`, deterministic economy clock,
услуги и persistent NPC relationships/диалог есть, но нет полного item corpus,
EP, supply/demand, taxes, theft, debts, crafting, механических эффектов
специализированных услуг и magic-item economy.
Текущий appraisal — bounded формула категории/редкости/состояния; magic-item
identification не реализован. Купленные базовые armor/shield/healing potion
связаны с lifecycle предметов, но произвольные magic properties пока не
компилируются в исполняемые эффекты.

### Переходы сцен и автоматическая лавка

В `enforce` resolved решение группы может вызвать server-owned `AdvanceScene`. `SceneAdvanced` атомарно создаёт карту для нового `location_id` или переиспользует сохранённые структурированные клетки уже посещённой локации, переносит отряд, обновляет adventure history и очищает прежний encounter. `AreaRevealed`, `EntitySpawned` и изменения клетки при выбытии противника обновляют тот же event-sourced снимок, поэтому изменение переживает уход, возврат и replay. Для распознанного поселения bounded `ShopAssembler` добавляет `MerchantCreated` в тот же commit. Wilderness не получает постоянную лавку по умолчанию. Решение связано с `interaction_id + resolved_option_id`, исполняется exactly once при конкурентных запросах, а retry победившего ключа воспроизводится из committed event batch без повторного вызова модели.

Выбран полный снимок структурированных клеток на уровне локации, а не только повторная генерация по seed: при лимите генератора в 500 клеток это ориентировочно десятки килобайт JSON на заполненную карту, но уже существующий `SceneAdvanced` и так несёт снимок новой сцены. Разреженные delta-события могли бы уменьшить log, однако потребовали бы нового versioned контракта для каждого изменения клетки и миграции старых replay; для текущего bounded формата полный снимок даёт более простой и проверяемый replay.

Индекс `locationMaps` добавляется как необязательное поле состояния, схема событий не меняется. Версия проектора состояния повышена до 3: старые snapshots ненулевой версии переигрываются от snapshot версии 0, а отсутствие индекса нормализуется в пустой объект без изменения `storage/`.

Оставшееся ограничение: выход за текущую границу тактической карты всё ещё исполняется как полный `AdvanceScene` в новую сцену. Событийного `MapExpanded` с совместимой соседней геометрией, сохранением перехода и валидацией стыка пока нет; поэтому расширение уже исследованной карты не заявляется закрытым.

Это ограниченный autonomous Director vertical slice, а не бесконечный генератор кампаний. Кнопка игрока запускает bounded intent, а серверная `director-intent-policy-v1` проверяет допустимость по текущей фазе и заменяет подряд повторённый либо не изменивший состояние тип. Темп монотонно растёт внутри главы до `climax`; подтверждённый `end_scene` снимает часть напряжения для следующей главы. Заполненные часы прогресса закрываются успехом, а часы, явно помеченные как угроза/опасность/дедлайн, — провалом; оба исхода создают `QuestResolved`, party/GM-факт согласно видимости исходного квеста и новую цель. Основной нитью для автоматического финала считается первый квест, чей id не имеет служебного префикса `quest:chapter:`; для старых потоков используется первый квест. Это совместимый, но пока упрощённый способ отличать кампанийную нить от сценических.

## Создание персонажей

Новая self-service кампания всегда получает четыре серверных слота. Создатель владеет одним слотом, а одно приглашение передаёт ровно один следующий свободный слот. Пока владелец не завершил обязательный мастер, Rules Engine отклоняет от имени этого героя все команды, кроме `ImportCharacter`.

Мастер покрывает только создание первого уровня. Характеристики обязаны быть перестановкой standard array `15, 14, 13, 12, 10, 8`; policy и выбранный вид сохраняются в событии, а скорость и итоговые значения повторно проверяются сервером. В первой версии policy числовой бонус происхождения равен нулю для всех видов: вид влияет на имя выбора и авторитетную базовую скорость, но полноценные видовые особенности и альтернативные бонусы происхождения ещё не подключены.

Выбор уровней 2+, мультиклассирование, черты, ASI и полный конструктор происхождения не входят в мастер создания. Дальнейшее развитие выполняется существующими server-owned командами. Старые `CharacterImported` без новой ability-policy продолжают replay для совместимости, но новый сетевой импорт без неё отклоняется.

## Rule Pack и Retrieval

- В corpus только 22 коротких оригинальных RU/EN пересказа базовой механики, включая 2 economy rules и Aura of Protection, а не полный SRD или rulebook.
- Нет полного spell, monster, item, class, feat, encounter или economy corpus; отдельно от Rule Pack существуют 12 monster-профилей с ограниченным набором исполняемых действий и небольшой server catalog стартового снаряжения.
- Local vector использует deterministic feature hashing, не обученную semantic embedding model.
- Russian stemming и fuzzy matching эвристические; возможны false positives/negatives.
- Ontology expansion ограничен одним bounded шагом.
- Нет production relevance metrics, feedback loop или benchmark для большого pack.

Retriever подключён к search API и orchestrator и строго фильтрует ruleset. Referential IDs Rules Engine согласованы с текущим pack; риск находится не в известном mismatch, а в малом покрытии corpus и необходимости сохранять integrity gate при расширении.

## Intent Parser, Adjudicator и Narrator

- Rule-based parser распознаёт ограниченный набор русских/английских формулировок и типов намерений.
- Target lookup зависит от доступных actor names и текущей projection.
- Некоторые DC, weapon и action defaults остаются упрощёнными.
- Свободное действие судится сервером: намерение разбирается на подход, характеристику и навык, заявленные средства сверяются с листом героя, а режим разрешения выбирает серверная таблица — автоуспех без броска при нулевых ставках, проверка со СЛ 10/15/20 либо встречное предложение вместо отказа. Провал даёт непустое последствие: идёт время, а серьёзный риск двигает часы квеста. Ставки (характеристика, СЛ, цена провала) возвращаются в поле `stakes` до применения исхода. Повтор того же подхода к тому же препятствию в неизменившейся обстановке нового броска не даёт. Отдельный ручной approval-шаг этим путём не предусмотрен.
- Разбор свободного текста остаётся **детерминированным**: классификация идёт по серверным шаблонам, вызова модели для понимания намерения нет. Нераспознанный текст получает безопасные значения по умолчанию (правдоподобно, риск minor), поэтому тонкие формулировки различаются грубее, чем у живого ведущего.
- **Автоматический урон за проваленную импровизацию намеренно не реализован.** Уровень риска `deadly` даёт самое тяжёлое из неуронных последствий; без настоящей модели опасностей урон был бы произвольным наказанием.
- Ставки объявляются в ответе API, но **интерфейс их пока не показывает**: игрок видит исход, а не цену провала до броска.
- Универсальные произвольные физические эффекты пока не исполняются: bounded ruling фиксирует только подтверждённый следующий шаг/цель, а не создаёт неподтверждённые факты о мире. Классификация свободного текста для этого пути остаётся детерминированной.
- Versioned role prompts и Verifier подключены; удалённый legacy handler больше не участвует в ходе.
- **Контрактная проверка промптов покрывает не все загружаемые промпты.** `test/security.test.mjs` требует `PROMPT_ID` и явного объявления `UNTRUSTED_DATA` от `director`, `narrator` и `npc_controller`. `prompts/campaign_creator/v1.txt` не содержит ни `PROMPT_ID`, ни блока `UNTRUSTED_DATA`; `prompts/map_architect/v1.txt` объявляет `PROMPT_ID`, но не `UNTRUSTED_DATA`. Привести их к контракту — это правка текста промпта, то есть изменение поведения модели, и делается отдельной задачей.
- **Ярлыки версий промптов в трассах не соответствуют реальности.** `server/game-orchestrator.mjs` записывает в `prompt_versions` строки `intent_parser/v1`, `adjudicator/v1` и `verifier/v1`, хотя все три роли исполняются детерминированно (`intent-parser.mjs`, `adjudicator.mjs`, `DeterministicNarrationVerifier` в `security.mjs`), а сами промпты удалены 2026-07-26 как контракты без потребителя. Ярлыки уже лежат в сохранённых трассах, поэтому исправляются только вместе с версионированием схемы трасс — трогать их в отрыве от миграции нельзя.
- Deterministic narration позволяет работать без RouterAI key, но не заменяет тестирование реального provider response и отказов.

## Runtime и compatibility layer

FileEventStore commit авторитетен, после чего полная каноническая read-модель проецируется в compatibility room. Commit содержит projection-outbox marker, metadata — monotonic checkpoint и projection hash, а startup и room GET выполняют reconciliation. Event и room-файл не являются одной физической транзакцией, но checkpoint не подтверждается без совпадения SHA-256.

Lifecycle кампании (`active`, `paused`, `completed`, `failed`, `archived`) хранится событиями, а terminal/archive блокируют игровые записи. При `climax` и разрешённой основной нити серверная команда `CompleteCampaign` автоматически создаёт `CampaignCompleted`; повтор ключа возвращает тот же финал, replay — то же состояние. Эпилог проходит через существующего Рассказчика с `buildDataOnlyContext` и brief только из party/public-квестов, фактов и истории сцен; при отсутствии или отказе модели используется `buildDeterministicEpilogue`. Остаточное ограничение: художественный эпилог опирается на bounded-проекцию подтверждённой истории, а не на отдельную полную семантическую свёртку всего event stream. Общая смерть отряда приводит к `failed` согласно текущей продуктовой политике без альтернативного сценария плена/спасения.

`GET /api/rooms/:id` не запускает NPC, но восстанавливает отставшую compatibility
projection по durable checkpoint. Ходы NPC выполняет явный
`POST /api/campaigns/:id/system-tick`; основной UI использует authenticated SSE,
а редкий polling остаётся fallback для восстановления через proxy. SSE-клиент
показывает состояние соединения, переподключается с экспоненциальной задержкой и
дожидается накопленных room-обновлений после занятого интерфейса.

Решение группы имеет campaign-visible `partyDecisionPolicy`: по умолчанию это
один голос на аккаунт, отключение фиксируется как `abstain`, кворум пересчитывается
по активным аккаунтам, а через 120 секунд создаётся durable `PartyDecisionExpired`
с выбором самого популярного варианта и разрешением ничьей в пользу первого.
Истечение проверяется на запросах и при восстановлении после перезапуска, а не
таймером в памяти. Старые кампании без membership сохраняют fallback «один герой —
один голос». `auth.json` защищён файловым lock вокруг всех read-modify-write
операций; это не превращает JSON-хранилище в транзакционную базу данных.

## Client state и presentation writes

`/api/narrate` отклоняет клиентские `state`, `player`, engine mode и raw roll. `/commands` принимает typed allowlisted commands и проверяет actor ownership/version; `AdvanceScene` через generic endpoint запрещён. В player combat path сервер самостоятельно выводит participants, attack profile, AC, damage, advantage/disadvantage и range, а также валидирует turn/path/walls/occupancy/speed/action economy. Party decision открывается, голосуется, разрешается и потребляется через FileEventStore; политика решения выбирает account-level voting, потому что один игрок может владеть несколькими героями и не должен получать несколько голосов. Для старого snapshot без campaign membership применяется детерминированный hero fallback.

Compatibility room `PUT` возвращает `410`. Механика и RNG в browser fallback удалены. Остаточное функциональное ограничение: редактируемые presentation-поля листа и кампании пока не имеют полного набора отдельных persistent-команд, поэтому часть таких изменений остаётся локальной.

## Rolls

- `/api/roll` и room dice path используют Dice Service; выданные броски регистрируются в Roll Registry.
- Registry сохраняет checks/rolls/consume-key в отдельном durable JSON и
  переживает restart одного Node process; между несколькими instances он не
  координируется.
- Roll consume не объединён атомарно с event commit и trace write.
- Idempotency event command и lifecycle выданного roll token durable в
  single-writer deployment.

## Persistence, migration и масштабирование

- FileEventStore активен для всех новых кампаний: immutable commits, snapshots/checksums, stream versions, replay и durable idempotency.
- Compatibility room JSON остаётся read-моделью; auth и rooms используют синхронный file I/O.
- Новая кампания инициализируется непосредственно в Event Store; live lazy import удалён.
- Старый metadata migrator не является cutover tool. Перед offline import обязательны backup, replay/hash audit и явное решение о каноническом источнике.
- Event stream и room read-модель связаны hash-verified outbox/checkpoint protocol; roll consume и turn trace всё ещё не входят в ту же транзакцию.
- Текущий рабочий storage не проходит `cutover:verify`; автоматическая перезапись намеренно запрещена.
- FileEventStore и compatibility room рассчитаны на single-writer deployment; auth.json отдельно защищён межпроцессным lock вокруг read-modify-write. OneDrive sync может создавать внешние конфликты.
- Нет PostgreSQL adapter, multi-process coordination, scheduled backup/retention и production restore verification.

## Security

- Self-registration остаётся открытой при публикации tunnel.
- Новые кампании используют explicit owner/player membership и одноразовые hashed invite tokens. Старые комнаты без membership временно используют legacy hero assignment до отдельной миграции; этот fallback нужно удалить после переноса существующих данных.
- Глобальная карта фильтруется на сервере: неизвестные locations/routes/regions и исходный seed не передаются игроку.
- Broad compatibility PUT retired; не хватает отдельных persistent presentation-команд.
- Security headers, включая CSP, активны; Origin check допускает same-host/localhost, но запрос без `Origin` также разрешён.
- CSRF token или double-submit mechanism отсутствует.

## Визуальная карта

- Наклон, вращение, объём стен и приподнятые фишки реализованы как браузерная
  3D-проекция структурированной карты. Это не отдельный WebGL-мир с произвольной
  камерой, мешами и физикой; авторитетными остаются серверные клетки, высоты,
  границы и объекты.
- Пять CC0-иллюстраций Dyson Logos дают согласованный визуальный язык для
  деревни, интерьера/таверны, пещеры, храма и подземелья. Они проецируются через
  серверную сетку и не определяют коллизии: нарисованный на иллюстрации проход
  сам по себе не становится доступным, если его нет в структурированной карте.
  Подробности источника и маршрутизации находятся в `docs/map-library.md`.
- Полностью нарисованные top-down ассеты пока подключены для сундука и лестницы
  руин. Остальные типы реквизита используют тематически окрашенный SVG fallback,
  пока для них не подготовлен лицензированный или сгенерированный набор.
- Narration/image generation имеют in-memory per-user limits, но они сбрасываются после restart, не работают между процессами и не учитывают token/cost budget.
- Auth rate limit in-memory и основан на socket IP; proxy может объединить нескольких пользователей.
- Generated items требуют аутентификации.
- NarrationBrief, visibility projection, Verifier и trace redaction активны.
- Explanation route проверяет доступ и применяет viewer-specific projection к командам, броскам и событиям; новые типы trace payload нужно явно добавлять в allowlist.
- `x-forwarded-proto`/trusted proxy configuration требует отдельной production проверки.

Подробнее — `security-model.md`.

## Deployment

- Compose может публиковать порт 8787 на всех host interfaces; безопасная binding policy зависит от deployment.
- Tunnel URL и доступность зависят от внешнего сервиса.
- Docker daemon, public tunnel path и real HTTPS/proxy headers не покрыты end-to-end test.
- Base images не закреплены digest-ами. Dependency specs закреплены диапазонами `^X.Y.Z` (2026-07-26); мажорное обновление больше не приходит молча, но минорные и патч-версии по-прежнему подвижны при регенерации лока.
- Frontend запрашивает Google Fonts, тогда как активная CSP может блокировать внешний stylesheet/fonts. Offline и deployed presentation могут отличаться.

## Тестирование

Актуальный suite включает unit tests доменных компонентов. Отдельный domain integration test проходит Orchestrator→Rules Engine→FileEventStore→reopen/replay для исследования, social ruling, check/save, spell/resource/concentration, боя, лечения, condition, явного `EndCombat`, rest и `/why`.

Real-HTTP integration scenarios поднимают `server/index.mjs` во временном storage и проверяют:

- создание enforce-кампании и отказ retired engine-mode/room-write endpoints;
- strict rules search;
- `enforce` damage command и отсутствие повторного применения по idempotency key;
- turn explanation;
- `/api/narrate /why` и отказ от forged/retired client state;
- JSON 404 для неизвестного API;
- боевые команды обычного игрока, ownership/allowlist и запрет прямого `ApplyDamage`;
- игнорирование поддельных attack modifier/AC/damage/advantage fields;
- path/walls/occupancy/speed/action economy и очередь хода;
- bounded Tactical Controller/NPC turns, persistent `battleLog`/`mapFeedback`,
  idempotent retry, restart после committed атаки, полный бой 4 PC + 3 NPC,
  provenance бросков/HP и loot;
- authenticated SSE, живой presence двух пользователей, concurrent independent
  commands без lost update и crash-between-commit/projection recovery;
- Director → `SceneAdvanced` → optional `MerchantCreated`: атомарный городской переход, отсутствие стационарной лавки в wilderness, forged system command, semantic idempotency conflict, room projection и replay после HTTP restart;
- merchant lifecycle/ShopAssembler, bargain/appraise/buy/sell, forged price/appraisal policy, ограниченную кассу, stale quote, appraisal registry и persistent `economyLog`.

Этот тест узкий. Не доказаны:

- полная UI/browser regression;
- real RouterAI behavior и provider failures;
- Docker/Pinggy/HTTPS end-to-end;
- production migration, rollback и restore существующего storage;
- multi-process concurrency и load;
- успешный data cutover существующего storage и rollback rehearsal;
- security penetration testing и обход quotas/visibility.

Не проверены полный monster corpus с legendary/lair и широким spellcasting,
высоты/difficult terrain/cover, полный набор spells/conditions и настоящий
browser-automation прогон нескольких окон. Поэтому завершение runtime-cutover
относится к single-writer multiplayer и bounded combat vertical slice, а не к
production data cutover или полной замене всего D&D-стола.

## Provenance и assets

Происхождение и условия распространения трёх PNG assets в `public/assets` не зафиксированы в доступных metadata. До публичной дистрибуции их следует документировать либо заменить ассетами с подтверждёнными правами. Подробности — `ATTRIBUTION.md` и `THIRD_PARTY_NOTICES.md`.
