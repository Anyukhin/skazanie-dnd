# Контракт предпросмотра движения — проход 5

Дата проверки: 2026-10-04. Код сопоставлен с baseline `88c620e6011ae607913efb224cb8f850b4ee5028` (merge PR #134, «Предпросмотр хода»). Проверены production caller `DungeonMap` → `buildMovementPaths`/`moveRiskPoint` и authoritative `MoveActor` в Rules Engine. Probe компилирует только production helpers `tactical-ui.ts` и `move-preview.ts`; React-компонент целиком не запускается. Предикат списка угроз в probe переписан по production caller, чтобы отдельно сравнить его результат с Rules Engine. Браузерный сценарий в этом проходе не объявляется проверенным.

## Результат

Новый визуальный слой получает маршрут и зону досягаемости из существующего клиентского pathfinder. Самая существенная новая ошибка — метка атаки по возможности считает объединение зон угрозы, тогда как сервер проверяет каждую угрозу отдельно. В результате переход из зоны врага A в зону врага B может быть показан безопасным, хотя сервер уже включает реакцию A.

Кроме этого, новый ценник маршрута наследует два старых расхождения клиентского pathfinder с Rules Engine: множители трудной местности выше ×2 и добровольные ограничения направления движения. Сервер остаётся авторитетным и безопасно отклоняет команду, но интерфейс сначала обещает маршрут, стоимость или безопасность, которых нет.

## Mv01 — P2: объединённая зона угрозы скрывает атаку по возможности

Новый caller передаёт в `moveRiskPoint` предикат `threatened`, который возвращает `true`, если точка находится в зоне **любого** врага: [`DungeonMap.tsx:1510`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/DungeonMap.tsx#L1510). Новый helper ищет только переход `true → false` между соседними точками маршрута: [`move-preview.ts:129`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/move-preview.ts#L129).

Серверная политика иная: `opportunityAttackers` проверяет каждого противника отдельно и требует, чтобы именно его досягаемость была покинута на одном из шагов: [`rules-engine.mjs:4176`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L4176). Probe ставит героя в `(1,0)`, A в `(0,0)`, B в `(2,1)` и ведёт его в `(1,2)`. На первом шаге герой остаётся в обеих зонах; на втором выходит из A, но остаётся в B. Поэтому клиент получает `risk: null`, а Rules Engine создаёт `CombatActionUsed(action_id: opportunity-attack, actor_id: threat-a)`.

Положительный контроль с одной зоной даёт одинаковый результат: клиент ставит маркер `{x:1,y:1.5}`, сервер запускает OA. Контроль движения, которое остаётся рядом с A, не даёт ни маркера, ни OA. Результат воспроизводится командой:

```text
node docs/reviews/2026-10-04/round-5/25-movement-contract-probe.mjs
```

Исправление: считать риск как множество пересечений по каждому угрожающему actor id, например `Map<actorId, threatened>` и возвращать первый шаг, на котором хотя бы одна конкретная зона меняется с `true` на `false`. Для UI можно оставить один общий знак, но его источник должен быть списком actor id; это также позволит объяснить игроку «из зоны A» и не потерять несколько реакций. Не следует вычислять риск из общего `some()`-предиката.

Есть ещё два ограничения существующего списка угроз, которые нужно закрыть тем же контрактом, прежде чем расширять предупреждение: caller берёт только `state.enemies` и только начальную дистанцию ровно 5 футов [`DungeonMap.tsx:1240`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/DungeonMap.tsx#L1240), а сервер учитывает всех противоположных живых actors, площадь footprint и дальность экипированного melee-оружия [`rules-engine.mjs:4182`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L4182). Поэтому reach-оружие, крупные существа и actor из другого массива также могут не получить предупреждение. Это отдельные случаи того же parity gap, но приоритет остаётся P2: команда всё равно проверяется и исполняется сервером.

## Mv02 — P2: существующий parity gap, цена ×3/×4 показывается как ×2

Существующий `buildMovementPaths` превращает любую трудную клетку в одну доплату `cellFeet` [`tactical-ui.ts:379`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/tactical-ui.ts#L379). `isDifficultTerrain` возвращает только boolean, поэтому `movement_cost_multiplier` теряется. Новая плашка повторяет `route.costFeet` как итоговую цену [`DungeonMap.tsx:1518`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/DungeonMap.tsx#L1518), но источник расхождения старый: прежний `cellLabel` уже показывал ту же рассчитанную цену при наведении [`DungeonMap.tsx:2023`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/src/DungeonMap.tsx#L2023). Это не дефект геометрического helper-а `move-preview.ts`.

Rules Engine хранит единую формулу `movementStepCostFor`: она учитывает множитель до ×4 и ползание [`rules-engine.mjs:9294`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L9294), а `MoveActor` применяет эту цену к выбранному пути и проверяет скорость [`rules-engine.mjs:17226`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L17226). Такие эффекты реально создаются: например, `wall-of-sand` с `movement_cost_multiplier: 3` покрыт серверным тестом [`spell-review-minor-fixes.test.mjs:81`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/test/spell-review-minor-fixes.test.mjs#L81).

Probe с маршрутом через одну клетку `movement_cost_multiplier: 2` даёт client/server `20/20`; тот же маршрут с multiplier `3` даёт `20/25`. Следовательно, это не округление и не визуальная неточность. На длинном маршруте клиент может показать остаток скорости, которого сервер не признает, а на границе скорости клик завершится `SPEED_EXCEEDED`.

Исправление: вынести чистый serializable preview adapter рядом с `movementStepCostFor` или вернуть из server-owned projection нормализованный `movement_cost_multiplier` по клеткам. Клиентский `MovementPath` должен хранить фактическую `stepCosts`/`terrainCostFeet`, а не boolean `difficult`. Дублировать формулу в React дальше не стоит: для тяжёлой карты это уже второй Rules Engine.

## Mv03 — P2: существующий parity gap, маршрут строится поверх запретов добровольного движения

`buildMovementPaths` проверяет клетки, рёбра, занятость и стоимость местности; остатком движения результат ограничивает caller `DungeonMap`. Предикаты `assertVoluntaryMovementPath` в этот расчёт не входят. Сервер отдельно запрещает испуганному существу приближаться к источнику страха и проверяет `command:approach`/`command:flee`: [`rules-engine.mjs:3529`](https://github.com/Anyukhin/skazanie-dnd/blob/88c620e6011ae607913efb224cb8f850b4ee5028/server/rules-engine.mjs#L3529).

Probe ставит `frightened(source_actor: fear-source)`, строит клиентский маршрут `(1,0) → (2,0)` и получает обычную цену `5 фт`; тот же `MoveActor` сервер отклоняет с `FRIGHTENED_CLOSER`. Поэтому новая линия и итоговая плашка могут появиться для команды, которую нельзя выполнить. Это не риск произвольного обхода: authoritative gate находится в `MoveActor`, но отказ после клика ухудшает предсказуемость UI.

Исправление: сделать `movementLegalityPreview(state, actor, path)` общим чистым контрактом, возвращающим `allowed`, `reason` и `cost`; включить в него добровольные directional predicates. Если сервер намеренно не хочет раскрывать источник страха, UI может получить только `allowed:false` и безопасную подпись «маршрут запрещён текущим состоянием», не копируя скрытые детали.

## Предлагаемый порядок обобщения

1. Первым шагом вынести узкий общий ESM leaf для чистых предикатов движения: стоимость шага с множителем, footprint-distance, границу каждой зоны угрозы и directional legality. Сервер и клиент уже переиспользуют такой leaf для footprint; не стоит сразу превращать каждый hover в HTTP-запрос.
2. Подключить эти предикаты к существующему `buildMovementPaths` и сборке риска, сохранив поиск пути и текущий внешний интерфейс там, где они подходят. `move-preview.ts` оставить геометрическим модулем. Не требуется заменять весь pathfinder, чтобы исправить формулу цены или проверку каждой угрозы.
3. Если после leaf останутся поля, недоступные клиентской проекции, добавить bounded read-only preview для подтверждения команды с `canonical path`, `step_costs`, `remaining movement`, `opportunity_attackers` и `rejection_code`. Это должно учитывать stale-state и туман: неизвестную клиенту клетку нельзя превращать в точную подсказку или раскрывать скрытую карту. Перед commit команда всё равно обязана пересчитать правила.
4. Покрыть контракт таблицей сценариев: одна угроза, переход A→B, reach 10/15, footprint 2×2, multiplier 2/3/4, frightened и command approach/flee. Для каждого проверять preview против `MoveActor`, а не только форму SVG.

## Границы проверки

Проверены исходники на полном SHA baseline и детерминированный probe, который завершился с exit 0. Probe не запускает браузер, не меняет server/test/data/storage и не требует сети или новых зависимостей. Существующие test-файлы не изменялись. Итог общего `pnpm verify` приведён в [сводке прохода](README.md).
