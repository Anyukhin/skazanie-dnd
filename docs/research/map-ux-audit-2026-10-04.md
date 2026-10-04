# Аудит карты и UX «Сказания» — 4 октября 2026

## Область и вывод

Это приложение содержит варианты развития. Общая очередь — в
[основном плане](../bg3-experience-roadmap-2026-10-04.md); расширения сверх
текущих путей, включая мобильную переработку, требуют отдельного выбора.

Аудит выполнен по baseline `cb045a84` в worktree PR-ветки: `App`, `DungeonMap`,
`TacticalBoard` 2D/3D, HUD, Spellbook, мировая карта, серверная карта/проекция,
генераторы и существующие сторожа. Untracked-файл `docs/map-generation-plan.md`
в выводы не включался.

PR #133 уже слит в baseline. Нижний HUD в духе BG3 уже включает портрет/здоровье,
условия, инициативу, ресурсы хода, секции хотбара, реакции, кольцо движения,
свободное действие и 2D/3D переключатель ([bg3-hud.css:1-9](../../src/bg3-hud.css#L1),
[DungeonMap.tsx:3815-3850](../../src/DungeonMap.tsx#L3815)). Повторно предлагать
эти элементы не нужно.

Главный вывод: локальная карта уже показывает подтверждённое состояние, но остаётся
преимущественно «полем для клика». Следующий прирост опыта даст связка «план →
прогноз → подтверждение → результат», навигация по большим/многоэтажным сценам и
единый граф пути между глобальной и тактической картой.

## Матрица текущего состояния

| Область | Есть | Частично/нет | Приоритет |
| --- | --- | --- | --- |
| Действия | Серверные цели, движение, двери, props, NPC, добыча, заклинания | Есть одно pending-предложение; multi-action plan/waypoint — отдельная продуктовая гипотеза | Исследование |
| Видимость | Туман, projection скрытых клеток, partial footprint, LOS/edges, cover/elevation | Обзор общий на отряд; персональный режим не задан правилами кампании | Исследование |
| Камера | 2D zoom/pan/focus, память по локации/этажу, minimap; 3D orbit/fit | `combatBounds` не используется camera code; нет полного touch/keyboard camera UX | P1 |
| Этажи | `UseLevelTransition`, стек, кэш, кроссфейд | Стек пассивный, нет preview соседнего этажа | P1 |
| Планировка | `TacticalMap`, рёбра, двери, props, зоны, `combatBounds`; Rules Engine читает geometry | Нужно лучше показать уже рассчитанные причины и program/camera hints | P1 |
| Мир | SVG, discovery, routes, список мест, city overview, travel vote | Путь показывается переходами, нет вариантов маршрута/событий | P1 |
| Мобильный UX | Пять вкладок и stacked layout | Большие вертикальные блоки, требуется проверка touch-сценария | Переработка отложена; текущие пути проверять |
| Accessibility | ARIA, keyboard cells, text fallback, reduced motion | 3D не даёт screen reader список целей; focus диалогов неполон | P1 |

## 1. Локальная карта и командный поток — P1 / отдельный scope

`DungeonMap` собирает единый `TacticalMap` и читает серверные дальность, экономику,
траектории и доступность цели ([DungeonMap.tsx:579-626](../../src/DungeonMap.tsx#L579)).
Первый клик строит маршрут, второй подтверждает движение; план манёвра показан
отдельным overlay ([App.tsx:1912-1927](../../src/App.tsx#L1912)). Это уже правильный
BG3-паттерн: намерение видно до расхода ресурса.

Разрыв появляется у составного действия: текущая модель хранит одно pending-предложение;
multi-action queue, waypoint и сравнение «подойти → атаковать»/«атаковать →
отступить» в коде не заявлены. Свободный ввод и готовая команда связаны текстом
([DungeonMap.tsx:3753-3812](../../src/DungeonMap.tsx#L3753)).

Если продукт подтвердит такой UX, ввести временный режим `План` с очередью
`move/target/object` поверх `buildMovementPaths`; на каждом шаге показывать цену
движения, action/bonus/reaction, opportunity attack и причину блокировки; добавить
сценарии «подойти и ударить», «подойти и поговорить», «бросить в точку»; подтверждать
через единый server dry-run для 2D/3D. Это отдельный scope, а не исправление
текущей серверной геометрии.

Acceptance для отдельного scope: план доступен мышью, клавиатурой и touch, не
расходует ход до commit, один idempotent commit повторяется безопасно, replay
совпадает; существующие `OUT_OF_TURN`, `ACTION_SPENT`, закрытая дверь и
`TRAJECTORY_BLOCKED` не должны регрессировать. Тесты: расширить
`test/tactical-ui.test.mjs`, `test/tactical-command-guard.test.mjs`, добавить
preview contract и HTTP idempotency test.

## 2. Видимость, LOS и интеракции — P1 feedback / отдельный scope

Публичная проекция не выдаёт скрытые props и partial footprint
([viewer-projection.mjs:198-249](../../server/viewer-projection.mjs#L198)), а клиент
уменьшает крупного актора до видимого anchor
([DungeonMap.tsx:1860-1889](../../src/DungeonMap.tsx#L1860)).

Текущая серверная геометрия уже авторитетна: `shortestTacticalPath` проверяет
`movementStepBlocked`/edges ([tactical-geometry.mjs:291-395](../../server/rules/tactical-geometry.mjs#L291)),
траектория учитывает стены и thin walls ([tactical-geometry.mjs:492-510](../../server/rules/tactical-geometry.mjs#L492)),
а `coverBetween` участвует в КД атаки и пишет `cover_bonus`
([tactical-geometry.mjs:588-634](../../server/rules/tactical-geometry.mjs#L588),
[rules-engine.mjs:12654-12674](../../server/rules-engine.mjs#L12654)). Это уже
проверяют [cover-from-creatures.test.mjs:50-73](../../test/cover-from-creatures.test.mjs#L50),
`test/free-action-wall-contact.test.mjs` и `test/tactical-ui.test.mjs`.

Высота тоже не «молчит»: генератор и Rules Engine имеют тест с реальным выстрелом
([map-elevation.test.mjs:45-101](../../test/map-elevation.test.mjs#L45)), а
`highGroundBetween` специально возвращает `level` для D&D 2014 и использует
higher/lower только в профиле, где это правило включено
([tactical-geometry.mjs:569-586](../../server/rules/tactical-geometry.mjs#L569)).
Нельзя обобщать «elevation даёт advantage» на все rulesets.

Доказанные UX gaps: forecast уже содержит cover/high-ground reasons, но их можно
сделать заметнее и единообразнее для атаки/заклинания/движения; контекст prop/двери
открывается через hotspot, а не через общий inspect layer. Обзор `revealed` общий
на отряд; персональная видимость — отдельная продуктовая гипотеза, требующая
решения о правилах кампании и хранении данных, не обязательный P0.

Доработка feedback слоя: показывать server-owned `cover_label`, `cover_bonus`,
`advantage_sources`, `disadvantage_sources`, blocked trajectory и edge reason в
одном tooltip; подсвечивать обе клетки двери/тонкой стены; добавить общий
context layer для имени, состояния, дистанции и доступных действий. Отдельно,
если выбран personal FOW, сначала сделать design/contract audit, затем projection.

Acceptance: значения feedback совпадают с `AttackResolved`/forecast и не меняются
от client fields; D&D 2014 не получает домашнее преимущество высоты; скрытый prop
не раскрывается tooltip. Тесты: `test/tactical-ui.test.mjs`,
`test/map-elevation.test.mjs`, `test/cover-from-creatures.test.mjs`,
`test/free-action-wall-contact.test.mjs`, `test/viewer-projection.test.mjs`;
новый UI contract нужен только для feedback layer.

## 3. Камера и навигация — P1

2D хранит zoom/pan по «кампания + локация + этаж», поддерживает wheel, drag,
double-click reset и focus героя ([TacticalBoard.tsx:435-451](../../src/TacticalBoard.tsx#L435),
[TacticalBoard.tsx:1388-1493](../../src/TacticalBoard.tsx#L1388)). 3D использует
ортографическую камеру, OrbitControls и кнопки поворота/zoom/fit
([TacticalBoard3D.tsx:248-260](../../src/TacticalBoard3D.tsx#L248),
[TacticalBoard3D.tsx:1324-1382](../../src/TacticalBoard3D.tsx#L1324)).

Сервер уже создаёт и расширяет `combatBounds` вокруг участников
([rules-engine.mjs:2797-2828](../../server/rules-engine.mjs#L2797)); проекция и
кэш передают его клиенту ([combat-bounds.test.mjs:384-420](../../test/combat-bounds.test.mjs#L384)).
Однако camera code его не читает: 3D `reset()` обходит все раскрытые клетки и
центрирует полную карту ([TacticalBoard3D.tsx:911-929](../../src/TacticalBoard3D.tsx#L911)),
а 2D имеет только общие zoom/pan/reset. Это доказанный UX gap. Историческое
замечание плейтеста о focus/minimap нужно воспроизвести браузером, а не считать
текущим дефектом без новой проверки.

План: сделать `combatBounds` camera target; добавить «Вся карта», «К бою»,
«К герою», «К цели» и bookmarks; поддержать pinch/trackpad, `+/-`, стрелки,
`Home`, `F`; синхронизировать 2D/3D через общий `BoardCameraIntent`; после
ResizeObserver повторить auto-focus один раз; зарезервировать safe area под rail
и initiative ribbon.

Acceptance: 20×20, 60×60 и multi-floor карта открываются с читаемым активным
участником, `К бою` центрирует `combatBounds`, смена 2D/3D сохраняет цель, pinch
не скроллит страницу, возврат из журнала сохраняет камеру. Тесты:
`test/board3d-camera.test.mjs`, `test/board3d-ui.test.mjs`, новый
`board-camera-intent`; ручной прогон 390×844, 1280×720, 2560×1440, reduced motion.

## 4. Этажи и 3D — P1

`TacticalMap` хранит `levelIndex/levelLabel`, сцена публикует активный и известные
этажи ([types.ts:1219-1246](../../src/types.ts#L1219),
[types.ts:1523-1532](../../src/types.ts#L1523)); сервер лениво строит этаж и
сохраняет сущности покинутого этажа ([known-limitations.md:3881-3891](../known-limitations.md#L3881)).

Стек этажей намеренно некликабельный, переход появляется только у лестницы. Это
честно для правил, но плохо для планирования: игрок не видит соседний раскрытый
этаж, взаимные лестницы и жителей до перехода.

Доработка: клик по известному этажу открывает read-only preview без смены партии;
на preview показывать входы, выходы, лестницы и раскрытие; у активной лестницы
показывать направление/дистанцию; в 3D добавить cutaway и Ghost floor только для
раскрытой геометрии; проецировать NPC по `location + level` (текущий долг:
[known-limitations.md:3988-3995](../known-limitations.md#L3988)).

Acceptance: preview не меняет actors, initiative, ресурсы или события; смена партии
возможна только через `UseLevelTransition`; 3D не показывает скрытую геометрию.
Тесты: `test/level-transition.test.mjs`, `test/tactical-ui.test.mjs`, новые
`known-level-preview` и level-scoped NPC projection.

## 5. Генерация карт и сценарное планирование — P1

`TacticalMap` уже имеет слои, рёбра, двери, props, зоны, spawn points и
`combatBounds` ([types.ts:1204-1246](../../src/types.ts#L1204)); генератор выбирает
library/procedural geometry и применяет программу сцены
([adventure-director.mjs:366-472](../../server/adventure-director.mjs#L366)), а
`scene-program-layout` ставит центр, посты, платформы и обязательные точки
([scene-program-layout.mjs:191-224](../../server/scene-program-layout.mjs#L191)).

Rules Engine уже исполняет edge movement, LOS, cover и включённое ruleset-ом
high-ground; генератор и corpus tests передают эти поля в карту. Доказанный
следующий gap — программа сцены не имеет отдельного публичного camera/program
contract, поэтому UI не может объяснить «почему здесь бой» и «куда смотреть».

Расширить `SceneProgram` (если это подтвердит продукт) полями `combatFocus`,
`combatBounds`, `cameraHints`,
`landmarkPriority`, `coverAnchors`, `verticalLinks`; валидировать доступность,
видимость, входную дистанцию и несколько решений там, где их требует программа сцены; генерировать
сценарный слой (засада, безопасная линия, обход, опасная поверхность, interactive
object); дать темам свои prop/terrain coverage и при провале сохранять fallback с
конкретными warnings.

Приёмка: сценарий имеет заявленные программой вход, центр, альтернативный путь
и интерактивный объект; кладовая не обязана иметь второй вход.
`combatBounds` включает встречу и вход; seed детерминирован; fallback
совпадает после replay. Тесты: `map-quality`, `scene-program-layout`,
`scene-program-corpus`, `scene-entry-road`, `map-library`; добавить
`scene-camera-hints`.

## 6. Карта мира и переходы — P1

Глобальный экран уже скрывает seed проекцией, рисует regions/routes/locations,
дублирует места списком и открывает city overview
([WorldMapView.tsx:155-235](../../src/WorldMapView.tsx#L155),
[world-map-render.test.mjs:35-56](../../test/world-map-render.test.mjs#L35)).
`world-travel.ts` умеет считать distance в днях
([world-travel.ts:77-100](../../src/world-travel.ts#L77)).

Но view показывает число переходов и агрегированную опасность, а не время, biome,
припасы или лагерь ([WorldMapView.tsx:248-264](../../src/WorldMapView.tsx#L248));
выбор маршрута — BFS по числу рёбер ([world-travel.ts:24-49](../../src/world-travel.ts#L24)),
хотя route хранит distance/danger/kind. Разрыв уже отмечен в
[world-map-plan.md:38-62](../world-map-plan.md#L38).

Перевести route selection на server-owned weighted estimates с вариантами короткий/
безопасный/быстрый/сюжетный; до голосования показывать дни/часы, остановку, biome,
риск, припасы, погоду и события пути; разрешить промежуточную остановку, лагерь,
обход и отмену до сегмента; связать `location_id` с scene, entrance focus и camera
bookmark. План города должен менять только navigation intent.

Acceptance: один server estimate совпадает во всех экранах, голосование хранит
`destination_location_id` и route snapshot, неизвестная точка не появляется,
многосегментный путь не превращается в прямую дорогу. Тесты: `world-travel-graph`,
`world-travel`, `party-exit-intent`, `world-map-render`, новый `route-estimate`.

## 7. Карта, рассказчик и HUD — P1

Status/objective/weather/wanted signs/illustration собраны вокруг карты
([App.tsx:1831-1834](../../src/App.tsx#L1831)); `PartyQuestHud` показывает квесты,
обещания, нити и часы ([dungeon-map-parts.tsx:791-839](../../src/dungeon-map-parts.tsx#L791)).
Но landmarks, quest objective и tactical props не образуют один интерактивный список:
«Общий план» знает только первую playable zone
([LocationOverview.tsx:5-24](../../src/LocationOverview.tsx#L5)), а хроника не
умеет центрировать карту на известном anchor.

Добавить server-owned `sceneAnchors`: id, публичное имя, тип, карта/этаж, клетка
при раскрытии, `known/confirmed/absent`. Клиент связывает anchor с квестом,
сообщением, world marker и camera focus; рассказчик не создаёт anchor после commit.
Acceptance: mention не создаёт фальшивый target, подтверждённый anchor совпадает
на всех поверхностях, `landmarks_absent` не кликабелен. Тесты: `narrator`,
`scene-narration`, `viewer-projection`, новый `scene-anchor-ui-contract`.

## 8. Книга заклинаний — P1

Spellbook уже ищет, разделяет героя/каталог, фильтрует круг, закрепляет и маркирует
недоступную механику ([Spellbook.tsx:29-87](../../src/Spellbook.tsx#L29)); детали
показывают runtime rows, компоненты, upcast и ограничения
([SpellDetail.tsx:216-310](../../src/SpellDetail.tsx#L216)).

Плейтест сообщает о непонятном разделении книги героя и каталога, хотя переключатель
в коде есть; сначала воспроизвести конкретный вход и экран. Потеря черновика
также записана в [known-limitations.md:30-43](../known-limitations.md#L30).
Уточнить существующие режимы `подготовлено/известно/каталог`, фильтр action/concentration,
сравнение ячеек и upcast, area preview без расхода и versioned server-owned
draft/pinned. Acceptance: `heuristic` не выглядит исполняемым, отказ объяснён до
клика, keyboard focus не теряется. Тесты: `spell-components-ui`,
`multi-target-spell-ui`, новый `spellbook-focus`.

## 9. Мобильный режим — вариант после отдельного решения

Есть пять вкладок и unread badge ([MobileTabBar.tsx:18-47](../../src/MobileTabBar.tsx#L18));
до 900px layout становится status → board → rail → server → composer
([table-layout.css:212-228](../../src/table-layout.css#L212)), Spellbook имеет
mobile fallback ([spellbook.css:68-77](../../src/spellbook.css#L68)).

На коротком экране карта и хроника занимают большие блоки; 2D уже имеет view/
minimap/focus controls, но отдельного touch zoom toolbar нет, а 3D controls/help
сжимаются. Safe-area явно не выделен. Полная мобильная переработка была отложена
владельцем; сейчас проверять существующие пути. Если направление будет выбрано,
рассмотреть mobile scene «карта + action
drawer», хронику bottom sheet, постоянный touch toolbar `К герою/К бою/Вся
карта/этаж/легенда`, pinch/pan без клика по фишке, landscape и safe-area; при
смене панели сохранять выбранную цель.

Acceptance: ход на 390×844 не требует горизонтального scroll и не теряет target,
back/Escape закрывает sheet, drag карты не отправляет действие, fixed controls не
закрывают composer. Нужен ручной matrix, автоматизации браузера нет.

## 10. Accessibility и наблюдаемость — P1

2D клетки имеют ARIA/focus/стрелки ([TacticalBoard.tsx:1519-1544](../../src/TacticalBoard.tsx#L1519));
3D обновляет canvas aria label, но DOM labels имеют `tabIndex=-1`
([TacticalBoard3D.tsx:1227-1253](../../src/TacticalBoard3D.tsx#L1227)); SVG locations
поддерживают Enter/Space ([WorldMapView.tsx:70-91](../../src/WorldMapView.tsx#L70)).

Добавить hidden semantic list доступных клеток/целей, roving tabindex для 3D,
единый `useDialogFocusReturn` contract для Spellbook/overview, один live region для active turn/blocked reason/target/floor,
контраст terrain/danger без цвета. Reduced motion уже есть
([tactical-board.css:170-187](../../src/tactical-board.css#L170)). Acceptance:
NVDA/Windows Narrator проходит бой без мыши, Enter/Space запускают действия,
reduced motion убирает camera/level transition. Тесты: `board3d-ui`,
`ui-player-screens-contract`, новые `dialog-focus` и `accessibility-map-contract`.

## Приоритетный порядок

P0: регрессии уже работающих edge/LOS/cover/high-ground правил не допускать.
P1: camera `combatBounds`, feedback layer, floor preview, weighted world routes,
scene anchors и focus. Mobile drawer — после отдельного решения о мобильной версии.
P2: multi-action plan, personal fog-of-war, region maps, 3D Ghost floors, route
events и prop atlas — после отдельного product/design scope.

Каждый этап требует fixture, штатный путь, отказ/права, idempotency, replay,
projection visibility, keyboard/touch acceptance и ручной двухигровой прогон.
Полный `pnpm verify` не запускался: это read-only аудит, изменён только этот файл.
