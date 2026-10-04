# Клиент, синхронизация и рендеринг: ревью baseline c7efdca

## Объём и критерии

Проверены `src/App.tsx`, `src/useGameSession.ts`, `src/DungeonMap.tsx`,
`src/TacticalBoard.tsx`, `src/TacticalBoard3D.tsx`, `src/board-render.ts`,
`src/board3d-scene.ts`, `src/tactical-map-client.ts`, `src/types.ts`, клиентские
API-модули и CSS-точки входа. Снимок — baseline `c7efdca`, поэтому выводы не
переносят на него незавершённые изменения из dirty исходной ветки. Сводный
сравнительный фон находится в [обзоре похожих проектов](01-comparable-projects.md).

Главная граница выбрана правильно: клиент получает проекцию, строит preview и
отправляет намерение, а допустимость, путь, дальность и экономика хода повторно
проверяются сервером ([product-principles.md:L80-L119](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/product-principles.md#L80-L119)).
Тактическая карта также остаётся структурированной моделью, для которой canvas и
3D являются проекциями ([product-principles.md:L226-L247](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/docs/product-principles.md#L226-L247)).
Ниже перечислены места, где эту границу стоит сохранить, но сделать клиент
дешевле для измерения и проще для расширения.

## Что уже является хорошей основой

2D-режим кэширует поверхности тайлов и рисует только окно с запасом; 3D-режим
имеет lazy-загрузку, отдельный fallback на 2D, отмену асинхронных моделей и
освобождение GPU-ресурсов при уходе со сцены. `scene-map-cache` уже различает
полную карту, дельту и неизменившуюся карту, поэтому отдельная передача reveal
дельт здесь не является предложением. Доступность не забыта: активные клетки 2D
получают настоящие `button`, у поля есть подпись, а камера и режимы имеют
клавиатурные команды. Следующие PR должны усиливать эти решения, а не переносить
механику в браузер.

## UI-01. Сессионный state и команды собраны в одном фасаде

`GameApp` получает из `useGameSession` почти весь публичный API игры одним
длинным destructuring ([App.tsx:L812-L817](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/App.tsx#L812-L817)), а
сам hook возвращает состояние, синхронизацию, recovery, бой, торговлю,
персонажей, путешествие и автономного ведущего в одном объекте
([useGameSession.ts:L2317-L2403](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L2317-L2403)). Это
не дефект из-за размера файла: проблема в том, что добавление новой области
должно знать о общих `busy`-флагах, epochs, `stateRef`, idempotency и правилах
слияния снимка. Ошибка в одной ветке легко выглядит как конфликт другой.

Предлагаемый путь — сохранить этот фасад для `GameApp`, но сначала вынести
узкие чистые функции: применение room snapshot, merge authoritative state,
селекторы busy/conflict и таблицу описаний команд. Они должны получать обычные
данные и callbacks `getState/applySnapshot`, а не импортировать React-компоненты.
Группировать команды или делить hook на модули стоит только после профиля; это
снизит риск построить ещё один слой обёрток поверх текущего.

Приоритет P2, усилие M/L. Первый безопасный PR — выделить несколько чистых
функций с прежними тестами idempotency и conflict: применение snapshot, merge
authoritative state и нормализацию ошибки. Общий hook-фасад и владение refs пока
сохранить; новый слой обёрток появится только если профиль это оправдает. До и
после нужен
профиль React на сценариях «снимок комнаты», «движение указателя», «ход боя»:
число commit-ов `GameApp/DungeonMap`, длительность p95 и количество сетевых
обработчиков. Без этого нельзя утверждать, что декомпозиция ускорила UI.

## UI-02. SSE и периодический запрос комнаты работают одновременно

Для выбранной комнаты hook открывает `EventSource`, принимает room/presence и
переподключается с backoff ([useGameSession.ts:L619-L751](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L619-L751)).
Отдельный эффект сразу делает запрос и продолжает `setInterval(sync, 15_000)`
([useGameSession.ts:L762-L792](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L762-L792)). Это
может быть сознательным repair-механизмом, но в здоровом SSE-сеансе каждый
клиент всё равно будит сервер ещё четыре раза в минуту, включая скрытую вкладку.
При нескольких игроках это лишняя работа и дополнительное окно гонки между
снимком и локальной командой; это гипотеза до измерения.

Вариант расширения — один coordinator транспорта: polling включается при
отсутствии открытого SSE, пропущенном heartbeat или после восстановления вкладки;
при `visibilitychange` достаточно сделать один full/hash-aware sync. Очередь
снимков и защита `roomVersion` должны остаться. Приоритет P2, усилие M.
Безопасный первый PR — добавить счётчики `sse_events`, `poll_requests`,
`snapshot_applied`, `snapshot_queued` и latency от `version` до применения,
затем сравнить активную и скрытую вкладку. Только после этого менять политику.

## UI-03. Наведение по клетке поднимает состояние в большой экран

2D-доска уже хранит `hovered` локально и отсекает повтор той же клетки, но на
каждом переходе в другую клетку вызывает `setHoverCell` и внешний `onCellHover`
([TacticalBoard.tsx:L1409-L1423](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard.tsx#L1409-L1423)). В
`DungeonMap` режим прицеливания принимает callback и меняет `aimCell`
([DungeonMap.tsx:L2800-L2804](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/DungeonMap.tsx#L2800-L2804)). Это
нормальная реакция на реальное изменение preview, поэтому дополнительная проверка
«те же координаты» сама по себе проблему не решит. Гипотеза состоит в границе:
при переходе по множеству разных клеток родитель пересобирает большой экран,
хотя часть вычислений нужна только board-controller.

Сначала стоит вынести вычисление aim/area preview в чистую функцию и передавать
родителю только итог, который действительно нужен действию; не менять серверную
валидацию и не обещать оптимизацию до профиля. Приоритет P2, усилие M.
Безопасная проверка — React Profiler плюс записанный pointer trace:
сравнить commits и p95 времени кадра для 32×32 и 96×64, отдельно при обычном
перемещении и при area spell.

## UI-04. Board view model делает линейные поиски внутри каждой клетки

`DungeonMap` собирает `boardCells` прямо в render: после индексов акторов цикл по
всем `state.scene.cells` всё ещё вызывает `players.find`, `enemies.find`,
`actors.find`, `sceneNpcs.find`, social lookup и дополнительные проверки
([DungeonMap.tsx:L1746-L1803](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/DungeonMap.tsx#L1746-L1803)). В
продолжении цикла вычисляются цели, причины блокировки, forecast, эффекты и
feedback ([DungeonMap.tsx:L1874-L2025](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/DungeonMap.tsx#L1874-L2025)).
Комментарий говорит, что перебор занимает доли миллисекунды
([DungeonMap.tsx:L1741-L1745](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/DungeonMap.tsx#L1741-L1745)), но это
измерение не видно в baseline и не учитывает текущие карты из другой ветки.

Для расширяемости лучше ввести узкую чистую функцию `createBoardCellContext` и
индексы рядом с уже существующими `actorByCell`:
индексы `actorById`, `actorByCell`, `npcById`, `npcByCell`, `socialById`,
`feedbackByCell` строятся один раз; результат клетки содержит уже вычисленные
`target`, `label`, `blockedReason`, `classes`, `children`. Серверные проверки и
недоверенные координаты при этом не переносятся на клиент. P2, усилие M.
Первый PR — только индексы и тест равенства старого/нового view model. Измерить
React commit time и CPU для карт 32×32, 96×64 и карты с 1000 props/100 NPC; это
отдельный клиентский benchmark, серверный [large-campaign performance harness](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/eval/large-campaign-performance.mjs)
его не заменяет.

## UI-05. Тайловый кэш защищает canvas, но не весь hot path

`paint` вызывается при изменении pan/zoom и каждый раз получает visible tiles,
синхронизирует кэш и заново композит их на основной canvas
([TacticalBoard.tsx:L744-L775](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard.tsx#L744-L775)). Сам
`syncTileCache` переиспользует поверхности, но для каждого видимого тайла
строит ключ; `tileRevealSignature` проходит окно 24×24 клетки
([board-render.ts:L543-L580](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/board-render.ts#L543-L580)). Ещё дороже
`propsInTile`: он вызывает `visiblePropsOnBoard(map)`, то есть фильтрует весь
список props заново для каждого тайла ([board-render.ts:L592-L608](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/board-render.ts#L592-L608)).
На пустых картах это незаметно, на библиотечной сцене с большим числом деталей
может стать CPU-гипотезой.

Вариант — индексировать props по тайлу в `BoardScene` и держать reveal signature
по `(map object, tile)` до следующего изменения карты; invalidate должен
учитывать приходящую reveal-карту, двери и props. Удалять тайловый кэш ради
простоты нельзя: он уже ограничивает стоимость размером окна. P2, усилие M.
Безопасный первый PR — экспортировать счётчики `tile_keys`, `tile_cache_hits`,
`props_scanned` и benchmark pan/zoom/reveal с 10, 100 и 1000 props; оптимизацию
делать только при подтверждённом p95.

## UI-06. 3D preview области создаёт mesh на каждую клетку

При каждом изменении прицела `paintTargetPreview` очищает группу, создаёт общие
geometry/material, а затем добавляет отдельный `Mesh` для каждой клетки
([TacticalBoard3D.tsx:L536-L570](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard3D.tsx#L536-L570)).
Контур уже собирается одной геометрией ниже по функции, поэтому заливка является
лишним числом draw calls для большой области. Это не ошибка механики и не повод
ограничивать размер заклинания; это гипотеза GPU/CPU, которую нужно проверить.

Для первого варианта собрать все квадраты в один `BufferGeometry` с высотой
каждой клетки, для второго использовать `InstancedMesh`, если цвет и материал
останутся едиными. Очистка должна освобождать старые GPU-ресурсы, как сейчас.
Приоритет P3, усилие M: это непроверенная GPU-гипотеза. Benchmark: 1/16/64/256 cells, измерять `renderer.info.render.calls`,
triangles, `renderP95Ms` и memory после десяти смен preview; имеющиеся DOM
diagnostics уже предоставляют почти все нужные поля.

## UI-07. Проверка счётчиков Three.js: ложное срабатывание снято

На первый взгляд `renderer.info.autoReset = false`
([TacticalBoard3D.tsx:L224-L226](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard3D.tsx#L224-L226))
выглядело как накопление `drawCalls` и `triangles`. Проверка установленного
Three `0.186.0` показала контракт `Info`: при `autoReset=false` библиотека
ожидает ручной `info.reset()` на границе кадра; сам `RenderPipeline` Three не
является автоматическим источником такого reset. В коде проекта граница уже
есть: `createBoardRenderPipeline.render()` вызывает `renderer.info.reset()` перед
composer/direct render, а затем рисует UI-слой; `TacticalBoard3D` вызывает этот
pipeline на каждом кадре ([board3d-graphics.ts:L262-L369](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/board3d-graphics.ts#L262-L369)).
Публикация counters находится после этого пути
([TacticalBoard3D.tsx:L786-L828](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard3D.tsx#L786-L828)).

Это не дефект и не самостоятельный PR. Остаточная рекомендация P3 — оставить
комментарий рядом с reset или контрактный тест pipeline, чтобы будущая замена
EffectComposer не убрала важную границу. Browser benchmark счётчиков в этой
ветке не запускался.

## UI-08. Граница API держится на TypeScript casts, а не на одном decoder

`ai-client` возвращает `response.json()` как заранее обещанный `AiHealth`,
`AiTurnResult` или `SharedDiceRollResponse` ([ai-client.ts:L59-L75](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/ai-client.ts#L59-L75),
[ai-client.ts:L193-L243](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/ai-client.ts#L193-L243)). В `useGameSession`
повторяются inline-формы ответа и casts для room, SSE, tactical и merchant
([useGameSession.ts:L543-L577](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L543-L577),
[useGameSession.ts:L1239-L1318](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L1239-L1318),
[useGameSession.ts:L2015-L2172](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/useGameSession.ts#L2015-L2172)).
Серверный authority от этого не нарушен, но новый endpoint может компилироваться
при несовместимом JSON и сломаться только при render или merge.

Нужны небольшие pure decoders рядом с существующими API-функциями: нормализация
ошибок и runtime guards для обязательных полей (`version`, `state`, `code`,
command result). Полные схемы не требуют новой зависимости: достаточно
проверок формы и `unknown` до narrowing. Приоритет P2, усилие M. Первый PR —
мигрировать room и tactical endpoints, добавить фикстуры неполного/старого ответа
и сохранить проверки conflict/idempotency; отдельный generic transport layer
пока не нужен.

## UI-09. Стили и доступность имеют разные точки владения в 2D и 3D

Почти все feature styles импортируются глобально из `main.tsx`
([main.tsx:L1-L16](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/main.tsx#L1-L16)), а `TacticalBoard` отдельно
импортирует `tactical-board.css` и `board3d.css` ([TacticalBoard.tsx:L37-L42](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard.tsx#L37-L42)).
При этом токены и базовые правила живут в 3219-строчном `styles.css`
([styles.css:L6-L65](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/styles.css#L6-L65)). Это не доказательство
лишнего CSS в bundle, но слабая граница владения: новый компонент может случайно
перебить глобальный селектор. Безопасное направление — `@layer` для reset/tokens,
layout, components и feature, затем перенос по одной вертикальной срезке и
проверка итогового CSS размера/специфичности.

Доступность нужно закрепить общей моделью взаимодействия. В 2D DOM получает
только активные клетки и их кнопки ([TacticalBoard.tsx:L115-L123](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard.tsx#L115-L123)),
в 3D фокус получает один canvas с динамической подписью, а overlay-кнопки
намеренно исключены из Tab ([TacticalBoard3D.tsx:L231-L233](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard3D.tsx#L231-L233),
[TacticalBoard3D.tsx:L1162-L1188](https://github.com/Anyukhin/skazanie-dnd/blob/c7efdca614cc33f706258d036e86f01c1f189404/src/TacticalBoard3D.tsx#L1162-L1188)). Визуально
режимы близки, но добавление нового типа hotspot может потребовать две разные
реализации клавиатуры и объявления состояния. Предлагаю общий
`BoardInteractionSnapshot` с focus cell, action label, target status и
`aria-live`-announcement, который питают оба renderer. P2, усилие M. Первый PR —
только контракт и keyboard acceptance matrix для 2D/3D, без изменения механики.
Для любого UI PR применим критерий из `AGENTS.md`: кроме `pnpm build` нужны
реальный HTTP-путь и ручной основной браузерный сценарий с двумя игроками;
включая проверку видимости, хода, отказа stale-команды и возврата фокуса.

## Очерёдность безопасных PR

1. UI-03: измерить границу aim preview и вынести чистую функцию (M).
2. UI-02: измерить SSE/poll traffic и только затем менять policy (M).
3. UI-04 и UI-05: добавить узкие индексы/counters и оптимизировать подтверждённые
   CPU hot paths (M).
4. UI-01: выделить pure snapshot/command helpers, сохранив прежний facade (M/L).
5. UI-08 и UI-09: укрепить API decoders и общий interaction/style contract (M).
6. UI-06: рассматривать после GPU benchmark; это P3, а не blocking issue (M).
7. UI-07: изменений не требуется; reset pipeline уже проверен.

До измерений нельзя обещать ускорение рендера. Метод проверок: агент направления
не запускал benchmark, browser или verify; общие результаты root находятся в
отчёте 08. Реальный критерий готовности для каждого клиентского PR — `pnpm build`,
соответствующие unit/contract checks, реальный HTTP-путь, ручной основной
браузерный сценарий с двумя игроками, профиль с зафиксированным сценарием и
ручная проверка 2D/3D клавиатуры.
