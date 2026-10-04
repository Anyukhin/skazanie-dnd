# Паттерны из других RPG и интерактивных рассказчиков

Дата: 2026-10-04.

Назначение: приложение к `docs/bg3-experience-roadmap-2026-10-04.md`.

Объект: «Сказание» — single-writer ESM, файловый event store, Rules Engine,
React/Vite и централизованные LLM-контракты. Метод: первичные материалы,
официальная документация и исходный код; закрытая архитектура продуктов не
предполагается.

Ниже перечислены варианты адаптации. Общая очередь и границы реализации —
в [основном плане](../bg3-experience-roadmap-2026-10-04.md); локальные оценки
не означают согласования новых функций.

## Вывод для проекта

Самый полезный общий паттерн — не копировать целую игру, а взять маленькие
контракты на границе уже существующих модулей:

1. Контекстные действия и состояния должны вычисляться сервером и показываться
   рядом с выбранной клеткой, фишкой или предметом.
2. Сцену удобно описывать отдельной программой: входы, условия, наблюдаемые
   улики, варианты ответа и разрешённые команды. Рассказчик пишет текст поверх
   этой программы, но не заменяет её.
3. Долгая память должна иметь несколько полос: постоянные факты, краткий
   сюжетный итог, активированные карточки и последние события. Канон кампании
   уже получает `source_event_ids`, visibility и время записи.
4. Карта должна хранить не только стены и клетки, но также области поведения,
   перепады высоты, точки перехода и видимые подсказки. Срабатывание области
   становится обычной серверной командой с replay/idempotency.
5. Для NPC полезнее редкие планы и расписания вокруг текущей сцены, чем
   непрерывная симуляция всех жителей. Это сохраняет бюджет и повторяемость.

Все предложения совместимы с правилом «команда → Rules Engine → события →
reducer → проекция» и не требуют новых зависимостей: внешние рантаймы здесь
только источники идей и форматов.

## Сравнительная матрица

| Проект или подход | Что подтверждено первоисточником | Что взять в «Сказание» | Стоимость адаптации | Что не копировать |
| --- | --- | --- | --- | --- |
| Foundry VTT: Token HUD и Active Effects | HUD быстро меняет ресурсы, статусы, цель и другие свойства токена; Active Effects накладываются поверх исходного Actor и могут истекать. [Tokens](https://foundryvtt.com/article/tokens/), [Active Effects](https://foundryvtt.com/article/active-effects/) | Контекстную панель выбранного героя/пропса: доступные команды, причины блокировки, статус и ожидаемая цена хода. Эффекты хранить как typed payload событий, не как мутацию базового листа. | Низкая–средняя: React-карточка и проекция уже есть; нужны компактный action catalog и тесты. | Универсальные скриптовые макросы, ручное редактирование скрытых свойств и огромный набор настроек VTT. |
| Foundry PF2e: режимы действий | Лист действий делится на Encounter, Exploration и Downtime; действие может иметь варианты и контекстную проверку цели. [Making a PC](https://github.com/foundryvtt/pf2e/wiki/Making-a-PC), [Style Guide](https://github.com/foundryvtt/pf2e/wiki/Style-Guide) | Один фильтр `available_actions` для режима сцены: бой, исследование, путешествие, отдых. Отображать 2–4 релевантных действия и явную причину отказа, а не полный каталог. | Средняя: контракт проекции + UI; механика остаётся в Rules Engine. | Копирование PF2e-терминов и всех вариантов действий без соответствующего ruleset; скрытая логика в клиенте. |
| Solasta: вертикальность | Разработчики называют вертикальность ключевой опорой: полёт, лазание, толчок и перемещение в трёхмерной сетке относятся к обычным тактическим действиям. [Dev Diary: Verticality](https://www.solasta-game.com/solasta-crown-of-the-magister/news/9-dev-diary-2-what-is-verticality) | Довести до ясного MVP уже имеющиеся этажи: `elevation`, видимость, дальность, падение/толкание и переходы. На доске показывать слой высоты и предупреждение о недоступной траектории. | Средняя–высокая: геометрия и правила сложны, поэтому начинать с двух уровней и тестов линии видимости. | Полную 3D-физику и свободное лазание по каждой поверхности; это не оправдывает текущую стоимость. |
| Solasta: Dungeon Maker и World Map | Редактор соединяет карты в кампанию, добавляет квесты, диалоги, лут-таблицы и гаджеты перехода; World Map связывает места путями и событиями. [Dungeon Maker](https://www.solasta-game.com/solasta-crown-of-the-magister/news/118-dungeon-maker-showcase-create-your-own-dungeons), [Patch Notes](https://www.solasta-game.com/solasta-crown-of-the-magister/news/152-lost-valley-patch-notes), [World Map](https://www.solasta-game.com/solasta-crown-of-the-magister/news/174-palace-of-ice-full-release-patch-notes) | Продолжить текущие `scene.map_requirements`, `map.design.landmarks`, `SCENE_PROGRAM_LAYOUT_VERSION` и существующие переходы. Генератор проверяет уже обещанные роли места; новую параллельную программу не вводить. | Низкая–средняя: расширение существующей проверки и admin preview; map-library остаётся владельцем готовых карт. | Полноценный пользовательский редактор кампаний и marketplace: он резко увеличит поверхность прав и миграций. |
| ink | Сценарий состоит из knots/stitches, choices, diverts, условий, переменных, tags и threads; состояние сериализуется отдельно от текста. [Writing with ink](https://github.com/inkle/ink/blob/master/Documentation/WritingWithInk.md), [Running Your Ink](https://github.com/inkle/ink/blob/master/Documentation/RunningYourInk.md), [StoryState](https://github.com/inkle/ink/blob/master/ink-engine-runtime/StoryState.cs) | Взять vocabulary для существующих scene/narration contracts: адресуемый beat, выбор, условие, повторяемость и UI tag. Выбранный beat/факт писать тем же event store, без нового DSL. | Низкая–средняя: расширение bounded JSON-ответов и текущего линтера; полный ink-runtime был бы высокой стоимостью. | Подключение C# runtime и произвольных функций сценария к серверу; это обходит Rules Engine. |
| Yarn Spinner | Узлы дают lines/options/commands, переменные управляют ветвлением; Dialogue Presenter отделяет строки, варианты и звук от сценария. [Fundamentals](https://yarnspinner.dev/docs/yarn/02-fundamentals/), [Custom Dialogue Views](https://www.yarnspinner.dev/docs/unity/10-components/02-dialogue-view/04-custom-dialogue-views/), [Commands](https://www.yarnspinner.dev/docs/unity/06-creating-commands-functions/) | Разделить выдачу Narrator на `line`, `option`, `command_hint`, `voice_text`. Одна и та же реплика кормит чат, TTS и журнал; option получает typed command preview до подтверждения. | Низкая–средняя: это контракт ответа и три React-presenter-а, без Yarn runtime. | Вызывать игру напрямую из текста команды и хранить последствия только в переменных диалога. |
| AI Dungeon: Plot Components и Story Cards | Важные сведения делятся на всегда включаемые Plot Essentials/Summary и карточки, которые попадают в контекст по триггерам; система показывает состав контекста и ограничивает бюджет. [Story Cards](https://help.aidungeon.com/faq/story-cards), [Plot Essentials](https://help.aidungeon.com/faq/plot-essentials), [Context](https://help.aidungeon.com/faq/what-goes-into-the-context-sent-to-the-ai) | Проекцию памяти сделать видимой и объяснимой: `always`, `scene`, `triggered`, `recent`. Показывать ведущему, какие карточки попали в brief, почему и сколько места заняли. | Низкая–средняя: детерминированные aliases/keywords поверх `world-memory`; семантический поиск оставить будущим расширением. | Пускать свободный текст игрока прямо в канон, отдавать модели неограниченную историю и считать совпадение слова доказательством факта. |
| Generative Agents | Архитектура соединяет observations, retrieval, reflection и planning; абляция авторов показывает вклад каждого компонента в правдоподобие поведения. [Paper](https://arxiv.org/abs/2304.03442), [Reference implementation](https://github.com/StanfordHCI/genagents) | Добавить NPC `goal`, короткий `next_intent` и редкую reflection-карточку после значимого события. Retrieval делать по текущей локации, отношениям и свежести, а исполнение — через существующие typed commands. | Средняя–высокая: полезен урезанный event-driven слой; полная фоновая симуляция дорогая и недетерминированная. | Постоянные LLM-вызовы каждого NPC, скрытая генерация планов с правом менять state и симуляция жителей вне видимого радиуса. |
| Twine | История строится из passages и links, а story formats добавляют variables/conditions; источник можно публиковать как HTML. [Twine](https://www.twinery.org/?page=Home), [Passages](https://www.twinery.org/cookbook/introduction/passages.html), [Variables](https://www.twinery.org/cookbook/terms/terms_variables.html) | Дать single-writer визуальный graph preview: список узлов, входящие/исходящие переходы, недостижимые узлы, циклы без выхода и отсутствующие условия. Markdown/JSON остаётся source-controlled. | Низкая–средняя: preview и lint можно написать на текущем стеке. | Встраивать HTML/JavaScript из пользовательского сценария в сервер и превращать каждую фразу в отдельную runtime-механику. |

## Карта и тактическая доска

### Области поведения вместо специальных исключений

Foundry Scene Regions показывают полезный UX-паттерн: область имеет форму,
события входа/выхода и несколько typed behaviours вроде телепорта, затемнения,
подавления погоды или одноразовой ловушки. [Scene Regions](https://foundryvtt.com/article/scene-regions/)
В «Сказании» это нужно выразить расширением существующих owners, а не новым
`scene_region`-реестром: постоянные площадные эффекты уже живут в
`mechanics.active_effects` и проходят `SpellAreaCreated`/`SpellAreaTriggered`/
`SpellAreaRemoved`; статические клетки используют `map.hazards`/`cell.hazardId`,
а пропсы — `scene-hazards.mjs` и `OperateSceneObject`.

Практическое продолжение — добавить в существующий payload только нужные
метаданные trigger/visibility/once и переиспользовать текущие area consequences.
Не вводить `RegionEntered`/`RegionExited` или исполняемый JavaScript. UI может
показывать viewer-safe cue; тесты должны проверить скрытую опасность, повтор,
idempotency и replay тех же `SpellArea*`/object events.

### Вертикальность малым шагом

Solasta подтверждает ценность высоты, но не требует копировать 3D-движок.
Сначала закрыть уже намеченный паритет этажей M04: `UseLevelTransition` и
`prop.transition` владеют лестницами/этажами, а `MoveActor` с
`movement_mode: 'long_jump'` — существующим горизонтальным прыжком. Push пока
концептуален: доступный аналог — `push_feet` у площадного эффекта или
`OperateSceneObject`; отдельной универсальной команды `Climb` нет и её нельзя
обещать UI. `elevation` уже есть в клетке, но не доказывает свободное лазание,
полёт или полную вертикальную line of sight.

Критерий качества для этого среза — лестница/балкон, видимый `UseLevelTransition`,
корректный long jump, существующий push effect и replay. Полёты и свободное
лазание оставить за пределами текущего контракта; детали перехода описаны в
[`multilevel-map-plan.md`](../multilevel-map-plan.md).

### Программа сцены и world map

Паттерн Solasta с последовательностью связанных карт полезнее случайной
генерации. В текущем коде владельцем программы уже является
`scene.map_requirements`: `items`, `focus`, `posts`, `clues`, `missing`; входные
якоря живут в `map.design.landmarks`, а карта и переходы — в существующих
`map-quality`, `map-library` и level/world-map контрактах. Расширять следует
этот путь точечно, не хранить `scene_program` рядом вторым источником истины.

В UI ведущего полезен предпросмотр уже нормализованного `map_requirements` рядом
с картой и связями локаций. Так видна «улика есть в программе, но не достижима
на карте» до игры; игрок получает только раскрытую карту и известные переходы.

## Рассказчик и авторский поток

### Без нового runtime

ink, Yarn и Twine сходятся в идее адресуемых узлов, условий и выборов. Для ESM-
проекта это нужно отражать в существующем `narratorResponsePlan`, scene
requirements и trace-контрактах, без нового DSL. Presentation/typed intent
можно расширять только versioned полями текущего JSON-ответа; `requires` читает
viewer-safe проекцию, но сервер повторяет проверки, а choice сохраняется в trace.

### Три presenter-а

Паттерн Yarn Spinner хорошо переносится в текущий React:

- `NarrationLine`: текст рассказчика с раскрываемым каноном сцены;
- `ChoiceList`: уже существующие серверные варианты группового решения или
  действия, стоимость и причина блокировки;
- `NarrationCommandHint`: звук, TTS, подсветка карты или переход, если событие
  уже подтверждено сервером.

Текст, option и hint должны приходить из одного versioned narration payload.
Это улучшит TTS и журнал без нового источника истины. Вариант «command hint» не
должен быть скрытой записью в state: он либо ссылается на уже созданное событие,
либо только поясняет доступное действие. Возвращать выключенные suggestions
Рассказчика не требуется; свободный ввод остаётся доступным.

### Линтер для автора

В духе Twine стоит расширить существующие `scene-program-layout`/`map-quality`
проверки без сетевых вызовов:

- отсутствующие `focus`/`posts`/`clues` и дублирующиеся IDs;
- landmarks/clues, которые не покрывает карта, и недостижимые переходы;
- choices без server command или без `clarify` fallback;
- stale prompt/contract versions.

Линтер должен выдавать ошибки до загрузки кампании. Для single-writer это
дешевле и надёжнее, чем полноценный редактор.

## Память, NPC и AI-ведущий

### Четыре полосы памяти

AI Dungeon разделяет постоянные инструкции, общий итог и условно активные
карточки. В «Сказании» это можно реализовать поверх существующих событий:

1. `always`: ruleset, тон кампании, живые герои и неизменные факты;
2. `scene`: текущая цель, канон времени/погоды, видимые NPC и landmarks;
3. `triggered`: карточки NPC/мест/клятв с aliases и областью видимости;
4. `recent`: последние подтверждённые события и короткий recap.

В текущем `world-memory` такие записи уже разделены на facts, relationships,
quests, threads и summaries с `id`, `source_event_ids`, visibility и
`recorded_at_minutes`. `worldMemoryForViewer` фильтрует видимость/время до
retrieval, а `retrieveWorldMemory` уже делает lexical/stem/synonym поиск и один
шаг по графу. Поэтому добавлять отдельный memory store не нужно: приоритеты и
триггеры следует выражать через существующие aliases, anchors и query.

Context Viewer раскрывает ведущему cards, event IDs, ruleset и бюджет; игроку
остаётся viewer-safe recap. Память, противоречащая событию или канону сцены,
отбрасывается verifier-ом.

### NPC без фоновой симуляции

Из Generative Agents стоит взять цикл `observe → retrieve → choose next_intent
→ execute typed command → remember`. Рядом с игроком достаточно одного
`next_intent` и времени следующей проверки; за пределами сцены часы мира дают
только детерминированные последствия. LLM предлагает реплику или bounded
intent, а reflection-карточка создаётся после значимого события и проходит
visibility/provenance-проверку.

## Приоритет и цена

### P0 — малый риск, высокий эффект

- контекстная `available_actions` для режимов боя/исследования/отдыха;
- три presenter-а Narrator и server-safe choice payload;
- четыре полосы памяти и Context Viewer для владельца;
- preview/проверка существующих `scene.map_requirements` и `map.design.landmarks`.

Ориентир: 2–4 небольших изменения в существующих проекциях, UI и тестах;
новых runtime и зависимостей нет.

### P1 — средняя цена

- расширение существующих `active_effects`/hazards и area triggers;
- локальные карточки условий и одноразовых улик;
- завершение паритета уже существующих двухэтажных сцен в 2D/3D;
- `next_intent` NPC вокруг активной сцены.

Каждый пункт должен идти отдельной командой, событием, reducer-тестом и
replay/idempotency тестом. Глобальный рефакторинг `rules-engine.mjs` не нужен.

### P2 — только после измерений

Семантическое ранжирование памяти, сложные threads/tunnels из ink, свободное
лазание/полёт и пользовательский редактор кампаний — следующий слой после
метрик, а не часть первой реализации.

Многоуровневые карты уже реализованы; ранняя заморозка L3+ была отменена
([история решения](../experience-upgrade-plan.md)). Новую свободную 3D-физику,
дорогую фоновую симуляцию или обязательный вызов LLM в каждый ход эти идеи
не подразумевают.

## Не переносить в ближайшую работу

- NPC-спутник, музыка и рантайм-генерация изображений: эти решения отложены
  владельцем; выше предложены только позиционные/социальные NPC и заранее
  подготовленные ассеты.
- Установка ink/Yarn/Twine runtime или vector database: новые зависимости не
  нужны для проверяемых первых шагов.
- Модель как исполнитель правил: ни Story Card, ни reflection, ни dialogue
  command не создаёт факт без server command и commit.

## Источники

- Foundry VTT: [Tokens](https://foundryvtt.com/article/tokens/), [Active Effects](https://foundryvtt.com/article/active-effects/), [Scene Regions](https://foundryvtt.com/article/scene-regions/).
- Foundry PF2e: [режимы действий](https://github.com/foundryvtt/pf2e/wiki/Making-a-PC), [inline actions и варианты](https://github.com/foundryvtt/pf2e/wiki/Style-Guide).
- Solasta: [verticality](https://www.solasta-game.com/solasta-crown-of-the-magister/news/9-dev-diary-2-what-is-verticality), [Dungeon Maker](https://www.solasta-game.com/solasta-crown-of-the-magister/news/118-dungeon-maker-showcase-create-your-own-dungeons), [dialog/quest/loot editor](https://www.solasta-game.com/solasta-crown-of-the-magister/news/152-lost-valley-patch-notes), [World Map](https://www.solasta-game.com/solasta-crown-of-the-magister/news/174-palace-of-ice-full-release-patch-notes).
- ink: [Writing with ink](https://github.com/inkle/ink/blob/master/Documentation/WritingWithInk.md), [running and tags](https://github.com/inkle/ink/blob/master/Documentation/RunningYourInk.md), [serializable StoryState](https://github.com/inkle/ink/blob/master/ink-engine-runtime/StoryState.cs).
- Yarn Spinner: [fundamentals](https://yarnspinner.dev/docs/yarn/02-fundamentals/), [dialogue presenters](https://www.yarnspinner.dev/docs/unity/10-components/02-dialogue-view/04-custom-dialogue-views/), [commands](https://www.yarnspinner.dev/docs/unity/06-creating-commands-functions/).
- AI Dungeon: [Story Cards](https://help.aidungeon.com/faq/story-cards), [Plot Essentials](https://help.aidungeon.com/faq/plot-essentials), [memory system](https://help.aidungeon.com/faq/the-memory-system), [context assembly](https://help.aidungeon.com/faq/what-goes-into-the-context-sent-to-the-ai).
- Generative Agents: [paper](https://arxiv.org/abs/2304.03442), [Stanford reference code](https://github.com/StanfordHCI/genagents).
- Twine: [official site](https://www.twinery.org/?page=Home), [passages](https://www.twinery.org/cookbook/introduction/passages.html), [variables](https://www.twinery.org/cookbook/terms/terms_variables.html), [story formats](https://www.twinery.org/cookbook/starting/twine2/storyformat.html).
