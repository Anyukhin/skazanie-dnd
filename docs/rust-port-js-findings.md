# Ошибки JS, найденные при переносе на Rust

Сводка разделов «Замечено в JS» из отчётов исполнителей переноса
(`docs/rust-rewrite-plan.md` §10). При переносе поведение повторяется **как
есть** — иначе сверка с корпусом JS перестаёт отличать «улучшил» от
«сломал». Каждая находка закреплена тестом крейта, где это возможно.

Решение по плану (D6): исправление ошибки — в JS сразу вместе с обновлением
корпуса, затем Rust повторяет новое поведение; где меняется журнал — новой
версией события. Колонка «Влияние» — что видит стол.

## P1 — влияет на живую игру

| Модуль | Ошибка | Влияние |
| --- | --- | --- |
| `npc-social`, `world-memory` | одно значение `null` в коллекции старого сохранения (`npcs`, разговоры, обещания, торговцы, сущности памяти) или `clock: null` роняет нормализацию | **кампания не загружается** |
| `world-memory` | `AdvanceQuestClock` с `proof_fact_ids` вида `['', ' ']`: сырые поля команды остаются в событии, редьюсер помечает чужие источники использованными без доказательства | дыра в доказательствах для часов поручения |
| `character-progression`, `combat-actions`, `starter-kit` | образец `маг\b`: `\b` в JS — только ASCII | роль «Маг», «Маг огня» не распознаётся как волшебник |
| `starter-kit` | герой 2014 без `characterClass`, но с узнаваемой ролью — «Для класса нет стартового набора 2014» | создание героя падает |
| `starter-kit` | полный набор солдата — два предмета с одинаковым id `…-starter-background-choice-1` | возможна путаница вещей в инвентаре |
| `npc-social` | `NpcRelationshipAdjusted` меняет счёт, но не `relationship_tiers`; пишет отношение для неизвестного NPC и пустого героя | ступень отношения устаревает до следующей нормализации |
| `npc-social` | `ensureNpcSocialState` при первой нормализации теряет разговоры, обещания и отношения NPC, известных только как торговцы или сущности памяти | тихая потеря памяти разговоров |
| `npc-social` | `promiseDueOffsetMinutes('нескоро')` — 240 минут («скоро» внутри «нескоро») | обещание «нескоро» созревает через 4 часа |
| `law-and-order` | `applyLawEvent` пропускает сырой `state.law` без нормализации при `schema_version: 1` и массиве `crimes` | мусор старых сохранений доживает: `escape_attempts: "2"` после побега — `"21"` |
| `encounter-assembler` (найдено сценарием внимания) | `CreateEncounter` (`raiders`, `easy`) при повторном визите отряда из двух героев в Редстоуновку — `NO_SAFE_PLACEMENT_CELLS` на всех шести сидах | встреча не собирается |
| `scene-graph` | `reachableZones`: ключ, найденный в том же обходе после проверки запертой двери, её не открывает | ложный `GOAL_UNREACHABLE` при проверке карты |
| `backup-service` | путь вида `storage/..имя` считается «снаружи» хранилища | копия пишется внутрь `storage` |
| `room-floors`, `map-store` | генератор пишет `zone.wall` раньше `zone.floor`, а чтение карты — наоборот: 14 из 56 сгенерированных карт после круга «чтение → запись» дают другой JSON | у одной карты два адреса в `map-store`; хеш с сортировкой ключей этого не видит |
| `tactical-map` | отказ `setCell` посреди заплатки уже ставит бит существования клетки, но не расширяет охват | после отказа карта не проходит проверку `BOUNDS_MISMATCH` |
| `prop-placement` | веса добора `(1 + n) ** 1.6` V8 считает `pow` платформы: UCRT на Windows и glibc в Docker могут округлять по-разному | расстановка предметов в принципе зависит от ОС (на практике основания такого размера не встречаются; Rust считает верно округлённо) |
| `prop-placement` | `placeRequiredProps`: внутренний `attachPropSupports` может снять утварь в другом месте карты — счёт поставленного уходит в ноль или минус, переименование задевает не тот предмет | обязательный предмет сцены может пропасть или получить чужое имя |
| `combat-lab-maps` | арена «пещерный мост»: уступы по краям моста затирает проход стен вокруг воды, мост идёт между двумя стенами, закрывающими обзор | арена играется не так, как задумана |
| `settlement-generator` | город у реки: русло встаёт на южную кольцевую улицу (`height − 4`), а не в середину — `horizontals.find` по несортированному списку | река всегда у южного края города |
| `level-generator` | собранные этажи почти все проваливают аудит играбельности: на 725 этажах `PASSAGE_OFF_MAP` ~15 на карту, `UNREACHABLE_FLOOR` 145, `SPAWN_CRAMPED` 72, `PARTY_SPAWN_BLOCKED` 29; генератор проверяет только `validateTacticalMap` и достижимость перехода | второй этаж, подвал и пещерный ярус с недостижимым полом и проходами за край |
| `adventure-director` | `outsideEntranceFor`: проверка `door.locked === true` не срабатывает никогда (у двери есть только `state`) | запертая дверь выбирается выходом наружу |
| `loot-containers` | `coordinate(null)` → 0: контейнер выбывшего, которого не было на доске, встаёт на клетку 0:0; карточка без расстояния показывает `distance_feet: 0` | тело «в углу карты», обыск недоступен там, где задумано «досягаемо по сцене» |
| `world-offices` | в `officesForViewer` ведущему читается `projected.holder`, которого у записи нет | ведущий не видит держателя должности |
| `offscreen-world`, `captives`, `courier-letters`, `world-deeds`, `world-memory` | `null` внутри сохранённых реестров (`steps`, `entries`, пленные, письма, летопись) или `clock: null` у задания роняет нормализацию | **кампания не загружается** (тот же класс, что у `npc-social`) |
| `campaign-lifecycle` | `npcs.filter(visibleToParty)` передаёт номер элемента как запасную видимость | NPC и записи без поля видимости не попадают в эпилог |
| `world-deeds` | дробная поправка репутации (2.5) после нормализации обнуляет репутацию; вид поступка — ключ прототипа роняет такт молвы | слух и репутация пропадают |
| `combat-narration`, `scene-summary` | `QuestResolved` без `summary` — «квест завершён: undefined»; условие атаки без двоеточия — «атакующий undefined» | служебный мусор в тексте ведущего |
| `weather` | `weatherCheckSwing`/`weatherRangedPenalty` без героя не подставляют активного, а шапка подставляет | на смешанной карте шапка и бросок расходятся |
| `rules-engine` (Р2) | `litByLightCantrip`: носитель «Света» без позиции (`null <= радиус`) освещает всех | свет заговора на всю карту |
| все модули с `localeCompare()` без локали | порядок зависит от локали процесса: Windows владельца — ru-RU, Docker — en-US | при равной цене выбор легендарного действия, порядок кандидатов встречи, лента розыска, поиск по справочнику **различаются между машиной разработки и боевым сервером** |

## P2 — мусор старых сохранений и ключи прототипа

- **Ключи `Object.prototype`** (`constructor`, `toString`, `__proto__`) как id,
  код каталога, навык, тактика, класс: таблицы-объекты находят функции.
  Примеры: `catalogItem('constructor')` возвращает функцию;
  `itemVisualForCatalogId('constructor')` — `{}`, вещь пропадает из `loadout`;
  `NUMERALS['constructor']` — количество `NaN`; `tacticLead('toString')` —
  исходник функции; NPC с id `toString` считается «предзаготовленным» и
  получает портрет без `url`; `IMPROVISED_EFFECTS['constructor']` — функция
  `Object` вместо эффекта (закрыто только проверкой в `action-adjudicator`).
  `sizeClass: 'constructor'` у тактической карты отключает проверку
  бюджетов размера.
  Лечение — `Object.hasOwn` или `Map` во всех таблицах.
- **Падения `TypeError` на не-массивах и `null`** в: брифах сценария (`null` в
  `worldMap.locations`), карте мира (`null` вместо концепта, источника, сцены,
  `knownLocations`), `improvised-effects` (списки участников), `clean()` в
  `scenario-attention` (объект с ключом `toString`), `questDecisionEvents`
  (нестроковый `questId`), `selectEncounterRoster` (дробный
  `maximumCreatures`), `mapOnHit` (`damage_expression` без типа урона),
  `campaignRulesetCanChange` (`null` в журнале перед блокирующим событием
  разрешает смену редакции).
- **Нормализация.** `normalizeCampaignState` не идемпотентна на 12 % состояний
  корпуса (`turn_started_at`, сводка мест карты мира, `origin`/`stack_key` вещей,
  `group_initiative`, ресурсы врагов и призывов) — `rust/RULES-ENGINE-PLAN.md`
  §5. `normalizeNpcSocialState` не убирает повторы NPC (это делает только
  `ensure`); `NpcSocialProfileUpserted` вставляет профиль с пустым id.
- **Rules Engine, разбор команды.** Тип команды — ключ прототипа
  (`constructor`, `toString`) роняет `normalizeCommand` с `TypeError` вместо
  `COMMAND_NOT_ALLOWED`; `safeInteger(x, undefined)` даёт 0 — у состояния без
  `state_version` команда получает `expected_state_version: 0`; `action_ids`
  окна реакции строкой проверяется поиском подстроки, объектом роняет
  `TypeError`; повтор целей заклинания `['', 'x']` считается повтором;
  `visibility` команды не проверяется — произвольная строка доходит до
  событий; `eventJournalId` при строковой версии склеивает `"5" + 1` → `"51"`;
  у `ResistanceAfterRollPause` имя `ResistanceChoicePause`.
- **Редьюсер (Р4а).** `DoorBarricadeCleared` без `restored_state` делает
  дверь открытой, а её ребро по-прежнему закрывает проход и обзор;
  `SceneObjectKnowledgeRevealed` без `knowledge_id` добавляет строку
  `"undefined"`, при `actor_id: null` в `inspection_attempted_by`/`used_by`
  попадает `"null"`; `ItemUsed` схемы 2 тратит экономику хода без проверки боя
  и героя (`action_economy["null"]`); `CaptiveTaken` с `captive: null` роняет
  реестр пленных. Геометрия (Р1): `npcSpellTargetsAt` в конусе и кубе «от
  себя» берёт всех NPC сцены, а не выбранных; клетка с признаком
  `constructor`/`toString` даёт половинное укрытие (`TERRAIN_COVER`);
  «Подойди»/«Убегай» без позиции заклинателя (`null >= null`) отклоняют любой
  шаг.
- **Тактическая карта.** Ребро без `x` проходит `canonicalEdge`
  (`undefined === undefined`), сохраняется под ключом `"undefined,2,s"`, а
  при упаковке съезжает в клетку (0, 0); `hazards: "ab"` становится
  опасностями клеток 0 и 1; `applyRevealDelta` падает на пустой дельте без
  `values`.
- **Генераторы карт.** `map-quality`: угловая клетка у края карты даёт
  `BUILDING_CUT_BY_EDGE`/`PASSAGE_OFF_MAP` дважды; клетка проёма без зоны,
  присоединённая только через дверь, считается отдельной комнатой и может
  скрыть `BUILDING_SINGLE_ROOM`; `stats.props_outside` считает клетки следа,
  а не предметы; опция `wallMaterial` у `thinWalls` не читается.
  `graph-layout`: склеп с необъявленной зоной входа, на которую ссылаются
  связи, падает `TypeError` (`minX`); `bypassLinks` не учитывает односторонние
  связи. `settlement-generator`: `sizeFor` берёт сдвиг по списку из 7 размеров,
  а списки плотной и редкой застройки — из 6 (первый размер выпадает вдвое
  чаще); `design: null` роняет генерацию целиком. Развалины неизвестной формы
  (`castle`) строятся как дом, а в ответе остаётся `castle`.
- **Встречи и подсказки.** `encounterDifficultyLabel('__proto__')` возвращает
  базовый объект; вид добычи — ключ прототипа даёт подсказку «Можно function
  Object() { [native code] }: Волк»; `null` первым адресатом почты роняет
  `suggestedActionsFor`; герой с id `__proto__` считает зверя досягаемым.
- **Base64.** `Buffer.from(text, 'base64')` читает младший байт каждой
  единицы UTF-16: кириллическая «н» (U+043D) для Node — `=`, разбор
  обрывается. Rust повторяет (`sk_core::js::buffer_from_base64`).
- **Строки `"undefined"`/`"null"`**: `String(undefined)` в причине блокировки
  смены редакции и в `tool_proficiencies`; `serverEncounterLoot({ encounterId:
  null })` — id `"null"`; `bossEncounterOutcome` без `encounter_id` — `"undefined"`;
  команда с `actor_id: "undefined"` находит героя без `id`.

## P3 — мелочи и мёртвый код

- `legendaryWindowKey`: `Math.trunc(Number(x) ?? -1)` — `??` не срабатывает,
  ключ окна без `active_index` — `r…iNaN`.
- `explorationUseFor` считает эффект с `duration: null` («Книга Теней»,
  «Талисман договора») действием «только в бою».
- Дробный уровень героя нигде не округляется (лимит подготовки 3,5, «Наложение
  рук» 12,5); запас `ability:<x>` без характеристики — `NaN` (в JSON `null`).
- `applyAbilityIncreases` опускает характеристику выше 20 до 20, если она есть
  в прибавках черты; ограничения стат-блока 2014 проверяются по профилю
  `srd_5_2_1`; два одинаковых врождённых заклинания делят `fallbackSlotResource`.
- В имени офицера стражи «Бориcлав» буква «c» латинская.
- Стоп-основа `'своё'` в `SECRET_STOP_STEMS` не срабатывает (ё→е раньше);
  `namesPresentPerson` ищет собеседника в 160 знаках, место — в 240;
  `campaignRewindEvent` раскладывает строковый `mechanics` по символам.
- `isWebp`/`validateSpeechWav`: `toString('ascii')` снимает старший бит —
  байты `0xD2…` проходят как «RIFF».
- `ClarificationRegistry.complete` ищет по обрезанному id, отмечает по
  необрезанному — id с пробелами даёт `TypeError`; запись без числового
  `expires_at` не истекает.
- `normalizeMerchant` резервирует номер позиции склада за отвергнутой;
  событие с `event_type: ['MerchantCreated']` озвучивается как продажа;
  `invalidateProposal('')` совпадает со всеми карточками без `proposal_id`.
- Недостижимые проверки: `PURCHASE_TOTAL_INVALID`, `catalog_id` в
  `homebrewAppraisal`; два разных помощника `mechanicalTokens` и
  `extractMechanicalTokens` с разной обработкой тире и знака ×.

## HTTP-маршруты (С6–С16, 2026-10-23)

- **P2.** Домашнее правило меняется в завершённой кампании, а `rewind_turn`
  затем откатывает и его (С8). Окно попыток распознавания речи общее со входом
  — голос отнимает попытки входа (С4).
- **P3.** `persist` с уже записанной репликой двигает `room.version` (С1).

## Свободное действие и социальные сцены (А3, А4, 2026-10-21)

- **P2.** `bindFreeActionReadingToState` зовёт проекцию без `try`: на сломанной
  карте падают `bind` и `read`. Неверная форма ответа модели социальной роли
  теряет код ошибки (`provider_error: 'Error'`). `door.locked === true` в
  `closedDoorEntry` недостижимо.
- **P3.** Нет пояснений проверки для Природы, Медицины, Религии; пропущенный
  пробел «Разбойник 1 —Скимитар»; `ensureNpcSocialState` пересчитывается ~10 раз
  за ответ.

## Проекция зрителя (П1, 2026-10-21) — утечки закрытого

- **P3.** `publicEncounterFor` без встречи отдаёт пустую встречу
  `{ id: '', status: 'staged', … }`; `CampaignStoryCompleted` без
  `story_number` стирает поле из события.

## Права и проверка рассказчика (Т1, 2026-10-21)

- **Аудит переключения в Rust** проверяет replay и отметки проекции; виды
  расхождений комнаты против снимка там невозможны по устройству (нет файла
  комнаты). Форма записи кампании в отчёте стала без полей комнаты — при
  переключении поднять `schema_version` отчёта до 3.

## Автотактика и стенд боёв (Т2, Т3, 2026-10-21)

- **P1-кандидат. `planHeroTurn` строит атаку при уже потраченном действии**
  (около 200 случаев эталона — движок отклоняет `ACTION_SPENT`); запасной
  ответ `planHeroCombatCommand` → `planHeroReaction` идёт без `validate`.
  Планировщик считает по проекции игрока (скрытые хиты врага), а исполнение —
  по сырому состоянию: удар по «живому» на проекции врагу отклоняется
  (`TARGET_DEFEATED`, `INVALID_SPELL_TARGET`). Влияние: автоход героя и бот
  прогонов теряют ход на отказе.
- **P2.** `abilityForApproach`/`skillForApproach` находят методы прототипа
  (`toString`) — в команду попадает функция. Стенд боёв: класс или тема
  `constructor`/`__proto__` проходят проверку и падают `TypeError`; фигура
  героя 2×2 не считается занятой целиком при расстановке врагов.
- **Rust быстрее и здесь:** самый тяжёлый ход автотактики (волшебник 11 ур.)
  — 7,4 с против 10,9 с в JS: копия состояния нормализуется один раз, а не на
  каждого кандидата.

## Rules Engine, волны 2–3 (Р5–Р11, 2026-10-20)

Перенесено как есть, закреплено эталонами `sk-rules/fixtures/r5…r11`.

- **P1-кандидаты.** `PickpocketNpc`: неизвестное расстояние (`null > 5` —
  ложь) разрешает кражу издалека. `MerchantSaleCompleted` убирает из
  инвентаря **все** вещи с количеством ≤ 0, а не только проданную.
  `ReceiveScenarioPurse` с дробным `gold_per_point` теряет монеты.
  Неизвестное расстояние (`null`) в `MakeAttack` — отказ «вне дальности»,
  а во взрыве заготовленного удара, вторичном взрыве заклинания, громе
  телепорта и радиусе легендарного действия — цель **в** области.
  Пауза внутри удара вдогонку в `MoveActor` теряет записанные события
  (включая `CombatActionUsed` атакующего).
- **P2.** Поиск по объекту-литералу находит ключи `Object.prototype`:
  `eventSummary` (`unit: "constructor"` → «Проходит 2 function Object()…»),
  триггер «Готовности» `constructor` падает `DataCloneError` вместо отказа.
  CalmBeast: `...roll` после полей `BeastSoothingResolved` подменяет
  `actor_id` зверя id героя. Нечисловой `initiative_bonus` роняет StartCombat.
  `closeFinishedSpellBuffs` у состояний без `effect_id` не закрывает усиление.
  «Поглощение стихий» в ударе: шаблон не совпадает с id `absorbing-element-rider:`.
  Оборона без `reactor_id` тратит реакцию без помехи.
- **P3.** Мёртвый код в `MakeAttack` (`enemyAdjacent`, `dodging`, `reckless`…),
  в «Встать», `purpose` у `areaSaveModifierFor`; фильтр люстры по этажу никогда
  не срабатывает; недостижимая запасная формула урона заклинания.

## Дельта main: обстановка карт и кукла героя (#184, #188, 2026-10-25)

- **P2, ключи прототипа.** `coreCenterpiece` берёт `CORE_CENTERPIECES[purpose]`
  без проверки собственного ключа: назначение `constructor`, `hasOwnProperty`,
  `isPrototypeOf`, `__lookupGetter__` (функция с `length ≥ 1`) в помещении от
  30 клеток с пустой серединой роняет `placeProps` — `TypeError: choices is not
  iterable` (`toString`, `valueOf`, `__proto__` — просто без середины).
  Назначение приходит из замысла сцены (Архитектор). Так же
  `COMPACT_ROOM_CELLS[theme]` в `compactArea` (тема `constructor` — корпус из
  NaN) и `COMPANIONS[assetId]` в `seatSpecFor` (`seatAroundSurface` у
  поверхности с видом `constructor` — `TypeError`). Rust считает такие ключи
  неизвестными: середины нет, корпус — вся карта, сидений нет.
- **P3.** `furnishEmptyQuarters` после стола четверти делает `break`, даже если
  `seatAroundSurface` не поставил ни одного сиденья, — стол остаётся без
  стульев, а прежний спутник рядом уже не ставится. Сиденья четверти
  закрывают только клетки у дверей, но не сквозной проход (`passageClearance`)
  и пороги — их потом снимает ремонт доступа. Проверка прохода в
  `coreCenterpiece` считает досягаемость только из первой свободной клетки
  зоны: стол, отрезающий другой карман, проверку проходит. Скамья без пары
  соседних мест в `arrangeSeats` перебирает оставшиеся `count` впустую.

## Онтология записи и импорт героя (#189, #190, 2026-10-25)

- **P3, мёртвая ветка.** `ontologyViolation` для утверждения сверяет вид
  держателя слуха, но `normalizeEpistemicClaimInput` пропускает к проверке
  только держателя-NPC (`WORLD_NPC_BELIEF_HOLDER_INVALID` раньше), а у всех
  статей-утверждений `subject_kinds: ['npc']` — отказ
  `WORLD_PREDICATE_SUBJECT_KIND_INVALID` для слуха недостижим.
- **P3.** `predicateEntryFor('party_deed')` возвращает отдельную статью-факт
  `party_deed`, а `party_deed:кража` — статью-утверждение семейства: одно имя
  с двоеточием и без него — разные виды записи. Повторено как есть.
- **P2, старые кампании.** `CHARACTER_ALREADY_CREATED` проверяет
  `characterSetupRequired !== true`: герой старого сохранения без этого поля
  (и с `'yes'` или `1`) считается готовым — его лист теперь заменяет только
  ведущий, хотя игрок мог ещё не закончить создание.
- **P3.** Полноту выборов (`IMPORT_CHOICES_INCOMPLETE`) проверка импорта
  считает прогоном редьюсера (`applyCharacterLifecycleEvent`): его отказ
  (повторный разбор листа) выходит из проверки команды с кодом редьюсера, а
  не импорта. Повторено как есть.

## Пробелы самого переноса (Rust, не JS)

- **Слот `undefined` в командах.** JS-спред `{ ...command, action_id: undefined }`
  оставляет ключ на прежнем месте, и следующая запись поля не сдвигает его.
  Rust-нормализатор команды (Р0) и сборка вложенных команд удаляют такие
  ключи, поэтому порядок ключей `pending_command` расходится: 1 запись
  корпуса (заготовленная атака с окном «Щита»). Р6 обходит то же в блоке
  `AdvanceScene`. Чинить в `command/normalize.rs` единым способом (метка
  `js::UNDEFINED` до сериализации), не по местам.
- **Сверка корпуса.** 7 записей `MakeAbilityCheck` и 3 `AdvanceScene`
  расходятся из-за корпуса: он не пишет поля социальной проверки и не
  содержит библиотеку карт JS-прогона. Дописать в `rules-corpus.mjs`.

## Что уже лучше в Rust (не меняет правил)

- Мусор старых сохранений, на котором JS падал с `TypeError`, читается как
  пустой — кампания загружается (каждый такой случай отмечен в тестах крейта).
- Сортировка `localeCompare` — одна и та же везде (en-US, как боевой Docker).
- Хранилище: коммит, снимок и метаданные — одна транзакция SQLite; нет файла
  комнаты; карты по хешу; аккаунты в той же базе.


## Исправлено (2026-10-26)

HTTP-маршруты и живой поток (ветка `rs/fix-http`): JS и Rust одинаково,
контракт — `test/http-route-fixes-api.test.mjs` в обоих режимах.

- `POST /lifecycle`: повтор ключа с другим действием или ключ коммита другого
  маршрута — 409 `IDEMPOTENCY_CONFLICT` (`lifecycleActionForCommit`); `action`
  `constructor`/`__proto__` — 409 `INVALID_CAMPAIGN_TRANSITION`. Тесты:
  `http-route-fixes-api`, эталон С8 (`c8.json`).
- `EquipItem` с `equip_slot: 'off_hand'` проходит через `/commands` (белый
  список предмета). Тест: `http-route-fixes-api`, эталон Г (`command-guard.json`).
- `narration-stream`: кадр больше 16 КБ отклоняется самим `progress`
  (`NARRATION_STREAM_EVENT_TOO_LARGE` вызывающему, у клиента остаётся прежний
  снимок), таймер не бросает; повторный `start` того же сообщения отменяет
  отложенный снимок. Тесты: `narration-stream.test.mjs`,
  `sk-infra/tests/narration_stream.rs`, эталон `narration-stream.json`.
- `broadcastCampaignRoom` из микрозадачи и часов боя — через
  `broadcastCampaignRoomSafely` (ошибка в лог); `streamConnections` больше не
  заводит пустые записи реестра (только подключение потока). В Rust этих
  ошибок не было. Без отдельного теста: внутреннее состояние `index.mjs`.
- `POST /api/campaigns`: второй из одновременных запросов с одним кодом — 409
  «Кампания с таким кодом уже существует»: журнал уже создан первым — тем же
  состоянием (`initialized: false`) или своим (`CAMPAIGN_ALREADY_INITIALIZED`,
  прежде 400 с английским текстом хранилища). Тест: `http-route-fixes-api`
  (в JS гонка без модели не воспроизводится: создание идёт без ожиданий; в
  Rust тест был красным — 201 и 400).
- `join`: герой приглашения сверяется с отрядом до записи членства
  (`INVITE_HERO_NOT_IN_PARTY` → 409, тот же текст). Тесты:
  `store-regression.test.mjs`, `sk-store/tests/accounts.rs`.
- `PATCH /settings`: все домашние правила проверяются до первой записи
  (редакции и правил); повтор ключа правила с другим значением — 409
  `IDEMPOTENCY_CONFLICT`; id строки летописи — по версии события. Тест:
  `http-route-fixes-api`.
- `/commands`: `null` в `players`/`actors`/`enemies` пропускается санитайзерами,
  враг без `id` целью не становится (по HTTP такой список до санитайзера не
  доходит — его не пропускает нормализация состояния); `expected_state_version:
  null` у торговца — `EXPECTED_STATE_VERSION_REQUIRED`. Тесты: эталон Г,
  `http-route-fixes-api`.
- `POST /api/rooms/:id/dice`: код комнаты приводится к верхнему регистру. Тест:
  `http-route-fixes-api`.
- `/api/health`: каталог создания героя строится один раз на процесс.

Клиент модели и учёт расхода (ветка `rs/fix-llm`): JS и Rust одинаково.

- `llm-client`: `MeteredLLMClient` показывает `timeoutMs` обёрнутого клиента
  (Rust — `LlmClient::model_timeout_ms`, `FallbackMember::new` берёт его сам).
  Каскад за обёрткой видит тот же лимит модели, что без неё. Оговорка: по
  правилу 568af070 явный срок вызова длиннее лимита модели лимитом не
  обрезается, а короче лимита — обрезан самим сроком, так что при явном
  `timeoutMs` лимит модели в каскаде на бюджет попытки не влияет ни в одном
  сервере; без срока он действует внутри клиента. Решение владельца
  2026-10-28: так и оставить, явный срок вызова главнее лимита. Тесты:
  `llm-client-timers.test.mjs`, `cascade_sees_model_limit_through_usage_wrapper`.
- `llm-client`: дельты попытки после её окончания (снята по сроку, гонка
  проиграна) в живой поток не идут; сигнал снятой попытки отменён. В Rust
  гонка и прежде снимала будущее попытки, ошибки не было — добавлена та же
  защита для работы клиента, пережившей попытку. Тесты:
  `llm-client-timers.test.mjs`,
  `late_delta_of_attempt_cut_by_deadline_does_not_reach_live_stream`.
- `llm-client`: таймеры срока запроса ограничены 2^31−1 мс (`timerDelay`,
  Rust — `llm_timer_delay`), а не превращаются в 1 мс. Тесты:
  `llm-client-timers.test.mjs`,
  `deadline_beyond_node_timer_is_not_a_one_millisecond_timer`.
- `npc-portraits`: формат и размер — до списания, брак закрывает бронь
  неудачей `IMAGE_FORMAT_REJECTED` (как у иллюстраций мест). Тесты:
  `npc-portraits.test.mjs`, `sk-chargen/tests/npc_portraits.rs`, эталон
  `npc-portraits.json` (4 html-сценария: `completed` → `failed`).
- `usage-ledger`: повтор `reserve` сравнивается с записанными `scope`/`model`
  (`'global'`/`'unknown'` вместо пустых). Тесты: `usage-ledger.test.mjs`,
  `sk-infra/tests/usage_ledger.rs`, эталон `usage-ledger.json` (4 повтора:
  `USAGE_IDEMPOTENCY_CONFLICT` → прежняя запись).
- **П1, `locationLevels` сырым ключом** — комната игрока собирается белым списком `PROJECTED_STATE_KEYS` (JS и `sk-projection`, в список добавлен `world_offices`); `test/viewer-projection.test.mjs` («белый список ключей»), `sk-projection` `p1::closed_fields_do_not_leak` без исключения `SECRET-level`, эталон `p1.json.gz` пересоздан.
- **П1, `turnResultForViewer`** — броски берутся из спроецированного результата, механика не массивом — тоже; `test/viewer-projection.test.mjs` («итог хода»), новый строгий случай в `gen-p1.mjs`.
- **Т1, `verifyNarration`** — кириллические маркеры хитов, ресурса и броска с границей `(?<!\p{L})…(?!\p{L})` и хвостом `\p{L}*` вместо `\w*` (цифра вплотную по-прежнему маркер: «7хп»; глаголы «бросил» и «выпал» без числа — не маркер броска); JS и `sk-tactics` `security.rs`; событие `EnemyKnowledgeRevealed` с `facts.health` подтверждает упоминание ОЗ (иначе строка движка «отряд знает точные ОЗ и КД» стала бы нарушением); `test/security.test.mjs` и `sk-tactics` `security::cyrillic_markers_use_unicode_word_boundaries` («кириллические маркеры»), эталоны `t1.json.gz` и `a5.json.gz` пересозданы.
- **Т1, враг `__proto__` в `attackForecast`** — `conditionIdsFor` читает только собственный ключ; `test/combat-forecast-disclosure.test.mjs`, в `t1` снята метка `known`.
- **А3, `nearestHazardAt`** — закрытость предмета читается из сырой записи `scene.map.props`; `test/free-action-hazard-contact.test.mjs` («скрытый ведущим костёр»), состояние `hazard-gm-only` в `gen-a3.mjs`.
- **А3, `\w` в шаблонах подхода и «окликa»** — `\p{L}` и кириллическая «а»; `test/free-action.test.mjs` («шаблоны подхода»), эталон `a3.json.gz` пересоздан.
- **А4, `conversationLeads`** — `asked_before` только по беседам, видимым герою-собеседнику (новый довод `playerId`); стоп-слово «нибудь» вместо «кто-нибудь»/«что-нибудь»; `test/npc-knowledge-leads.test.mjs`, случаи `leads` в `a4.json.gz` с `playerId`.
