# Продолжение боя после CI `TARGET_OUT_OF_RANGE`

Дата среза: 2026-10-04. Проверялся checkout `cb045a8466f35696ff24abe9020d6f39dee89462` с документационными коммитами round-7 поверх него. Целью было установить, может ли параллельное продолжение боя дважды продвинуть одного NPC и тем самым оставить HTTP-стенду устаревшую цель.

## Результат

Причинная связь с двойным продвижением NPC не подтверждена. Фокусный HTTP-сценарий `test/combat-lab-api.test.mjs` прошёл в четырёх ограниченных запусках: `1/1` каждый раз, без изменённых runtime-файлов. Дополнительно прошли `70/70` тестов из `test/authoritative-executor.test.mjs`, `test/npc-turn-scheduler.test.mjs` и `test/post-commit-coordinator.test.mjs`.

Сама гипотеза не выдумана: после `saveRoom` обработчик [`onRoomSaved`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L2561-L2567) ставит `combatTurnCoordinator.nudge(campaignId)`, а HTTP-маршрут боевой команды отдельно вызывает [`settleCombatContinuation`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L5116-L5127), который запускает ту же стадию через [`PostCommitCoordinator`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3009-L3020). У этих путей нет общей in-process блокировки. `CombatTurnCoordinator` сериализует только свои `nudge` через [`entry.running`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/combat-turn-coordinator.mjs#L289-L302), [`PostCommitCoordinator` не запоминает loop-ключ](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/post-commit-coordinator.mjs#L159-L210).

Однако фактическая запись NPC защищена на следующем уровне. Оба пути снова читают `eventStore`, строят план через `runNpcTurnScheduler`, а [`schedulerKey`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-turn-scheduler.mjs#L1460-L1475) использует кампанию, экземпляр боя, раунд, индекс инициативы, NPC и фазу его экономики. [`FileEventStore._withLock`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L308-L340) сериализует запись кампании, а повтор с тем же ключом возвращает исходный commit ([`commit`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L778-L800)). [`AuthoritativeExecutor`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/authoritative-executor.mjs#L183-L223) при конфликте версии перечитывает состояние и при idempotency-конфликте возвращает уже записанный commit как `replayed`. [`duplicateWithoutProgress`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-turn-scheduler.mjs#L1478-L1481) останавливает replay без прогресса. Поэтому два планировщика могут лишний раз вычислить один и тот же шаг, но текущие guards показывают только, что один и тот же scheduler key не запишет один и тот же NPC-событийный пакет второй раз; они не доказывают, что разные keys не могут быть семантическим дублем.

Это покрыто исполняемыми контролями: тест гонки `AuthoritativeExecutor` проверяет один commit при одинаковом ключе; тест планировщика проверяет выход на replay без прогресса; тесты multiattack проверяют разные ключи для фаз одной атаки и replay-сходимость. Эти проверки не моделируют полную связку `onRoomSaved` плюс HTTP `settle`, поэтому они закрывают durable-commit guard, но не подтверждают свежесть состояния, возвращённого HTTP-клиенту.

## Что остаётся возможным

Есть узкое окно согласованности ответа. После того как HTTP-маршрут получил `latest` из `eventStore`, другой продолжатель может записать следующий NPC-коммит до `persistAuthoritativeProjection` или сразу после него. В таком случае ответ может содержать состояние на одну фазу старше durable-журнала; следующий запрос сам перечитает журнал через `latestCampaignState` внутри [`GameOrchestrator`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/game-orchestrator.mjs#L2022-L2023), но тест сохраняет `target` из предыдущего ответа. Если за это время NPC действительно изменил позицию, следующий `MakeAttack` закономерно получит `TARGET_OUT_OF_RANGE`. Это объясняет форму CI-отказа лучше, чем гипотеза о двойной записи, но координаты и версии из неудачного запуска отсутствуют, поэтому это остаётся суженной гипотезой.

Ошибку нельзя устранить дополнительным GET перед атакой: чтение и команда всё равно разделены. Контракт версии уже существует: HTTP сохраняет присланный `expected_state_version` ([санитайзер](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L656-L663)), но цикл этого стенда передаёт атаку без него ([тест](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/combat-lab-api.test.mjs#L280-L287)). Сначала следует проверить использование существующего guard и явную обработку `STATE_VERSION_CONFLICT`, а не вводить новый API. Это всё ещё не доказанный fix конкретного CI-отказа. Следующий запрос не должен слепо повторять уже недопустимую атаку и не должен принимать любой `400` за успех; при неизвестном исходе повтор с тем же ключом, напротив, остаётся защитой от двойного применения.

## Минимальный диагностический следующий шаг

При следующем CI-отказе достаточно изменить только диагностическую ветку теста. Вместе с `TARGET_OUT_OF_RANGE` записать ограниченную квитанцию:

- номер шага и исходный `state.state_version`;
- `actor_id`, `target_id`, позиции актёра и цели из состояния предыдущего ответа;
- `state_version`, round/index и позиции из свежего `GET /api/rooms/:campaign`;
- список `event_id`, `event_type`, `idempotency_key` и версии только после исходной версии; для движения нужен `ActorMoved`, а не имя команды `MoveActor` (рядом полезно сохранить `TurnEnded`).

Если между двумя версиями окажется один `TurnEnded`/`ActorMoved` от NPC и уникальный scheduler key, это будет рассинхронизация ответа/команды, а не duplicate advancement. Если один и тот же scheduler key встретится в журнале дважды с разными версиями, тогда потребуется отдельная исправляющая задача; текущий `FileEventStore` и `AuthoritativeExecutor` такого пути не показывают. Семантический дубль с разными keys этой квитанцией не исключается — для него понадобится отдельный разбор планов и координат.

## Точность доказательства

Повтор `test/combat-lab-api.test.mjs` четыре раза — это bounded regression check существующего HTTP-сценария, а не causal HTTP probe: он не ставит барьеры между `onRoomSaved` и маршрутом и не сохраняет журнал при отказе. Поэтому scope результата остаётся hypothesis: duplicate advancement не воспроизведён и не доказан невозможным для разных scheduler keys.

Команды проверки:

```text
node --test test/combat-lab-api.test.mjs
node --test test/authoritative-executor.test.mjs test/npc-turn-scheduler.test.mjs test/post-commit-coordinator.test.mjs
```
