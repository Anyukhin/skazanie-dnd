# Ревью повторов HTTP-команд: request fingerprint и область idempotency

Аудит выполнен на фиксированном baseline `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7` (`origin/main`). Проверялась только семантика повторов в HTTP-путях: изменение команды при том же ключе, повтор ключа между `/commands` и `/narrate`, а также смена актора. Runtime не менялся, рабочие `storage/` и `.env` не использовались.

Реальный HTTP probe [`command-retry-probe.mjs`](./command-retry-probe.mjs) поднимает отдельный сервер с временным `DND_STORAGE_DIR`, пустым `ROUTERAI_API_KEY`, создаёт тестовую кампанию и обычного player-пользователя с двумя героями. Все команды проходят через HTTP; после завершения временный каталог удаляется. Повторный запуск:

```text
node docs/reviews/2026-10-04/round-2/command-retry-probe.mjs
```

В probe для каждого сценария используются разные ключи и цели. Это существенно
для отрицательной проверки актора: более ранняя версия повторно использовала
`goblin-a`, и случайный успешный первый `IdentifyEnemy` успевал открыть знания
об этой цели. Тогда следующий независимый запрос закономерно получал
`ENEMY_ALREADY_IDENTIFIED` (`400`) ещё до проверки idempotency. Это была ошибка
конструкции probe, а не новое поведение runtime; текущая версия использует
свежую цель `goblin-c` и проверяет одновременно `status`, `code` и ограниченный
текст `error`.

## Как устроен текущий контракт

`FileEventStore.commit` вычисляет `request_hash` из `command_id` и нормализованных `events`, затем ищет уже записанный `idempotency_key` и выбрасывает `IDEMPOTENCY_CONFLICT`, если hash отличается ([`event-store.mjs#L776`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L776), [`event-store.mjs#L785`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/event-store.mjs#L785)). Это полезная защита, но она действует только если запрос дошёл до `commit`.

HTTP-маршрут `/api/campaigns/:id/commands` принимает `command` или массив `commands`, извлекает ключ и имеет отдельные preflight-проверки только для некоторых семейств (`AttackNpc`, `MakeAttack`, торговля, предметы, отдых, loot и т. п.) ([`index.mjs#L4905`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L4905), [`index.mjs#L4918`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L4918), [`index.mjs#L5106`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L5106)). Затем он передаёт оркестратору `commands`, `message`, actor и ключ ([`index.mjs#L5102`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L5102)). Универсальной проверки отпечатка всего нормализованного command batch в этом месте нет.

Оркестратор сначала ищет commit по кампании и ключу ([`game-orchestrator.mjs#L2106`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L2106)), а при найденном duplicate возвращает его как результат, не вызывая новый `resolvePlan`/`eventStore.commit` ([`game-orchestrator.mjs#L2723`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L2723)). Его общий `narrationRequestFingerprint` включает campaign, player, текст, NPC и несколько полей продолжения, но не endpoint и не `commands` ([`game-orchestrator.mjs#L572`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L572), [`game-orchestrator.mjs#L584`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L584)). Поэтому event-store hash не успевает защитить часть повторов.

Общий namespace сам по себе не является дефектом, если ключ обозначает одну logical operation и разные endpoint-пути строят один и тот же нормализованный запрос. Дефект ниже в том, что несовместимый normalized request получает `200` как replay старого результата.

## Находки

### CMD-01 — P2 — изменённая структурированная команда с тем же ключом и текстом молча становится replay старой команды

Тип: confirmed · confidence: high · real HTTP.

Probe от имени обычного player отправляет на `/api/campaigns/RETRY-PROBE/commands`:

1. `same-command-key`, текст `same message`, `IdentifyEnemy(actor_id=hero-a, target_id=goblin-a)`;
2. тот же ключ и тот же текст, но `IdentifyEnemy(actor_id=hero-a, target_id=goblin-b)`.

Оба ответа имеют HTTP `200`. Второй помечен `idempotent_replay: true`, а его событие по-прежнему содержит `enemy_lore.enemy_id = goblin-a` и тот же `roll_id`, что первый ответ. Запрошенный во второй попытке `goblin-b` не сравнивается и не исполняется. На уровне HTTP это подтверждает, что route-level actor/command sanitization не образует request fingerprint: для этого типа нет отдельного `assert*Idempotency`, а duplicate lookup в оркестраторе срабатывает раньше нового commit.

Это не повторная запись второго события и не повреждение event log: состояние остаётся результатом первой команды. Нарушается контракт клиента — ответ сообщает успешный replay для другой команды. Для UI с повторно использованным ключом это выглядит как подтверждение неверного действия; для административных и будущих player-команд это также оставляет обход новых semantic guards, если они стоят только после duplicate lookup.

Минимальное направление исправления: передавать в общий idempotency слой канонический envelope всего уже санитизированного batch (`operation` либо единый semantic identity, `actor_id`, normalized commands, semantic request fields) и сохранять его hash в commit. При duplicate сравнивать этот hash до возврата результата. Специализированные fingerprint-проверки для атак, торговли и loot можно оставить как более узкие сообщения об ошибке, но они не должны быть единственной защитой.

### CMD-02 — P2 — несовместимый запрос через другой endpoint возвращает `200` replay старого commit

Тип: confirmed · confidence: high · real HTTP.

Probe сначала отправляет через `/commands` с ключом `cross-endpoint-key` текст `Атакую goblin-b` и явную команду `IdentifyEnemy(hero-a, goblin-b)`. Затем тот же player отправляет через `/api/narrate` тот же ключ и тот же текст, но это уже другой публичный контракт: свободное действие с намерением атаки, без структурированной `IdentifyEnemy` команды.

Оба ответа имеют HTTP `200`. Второй ответ `/api/narrate` имеет `idempotent_replay: true` и возвращает старый `AbilityCheckResolved` (а при удачном броске также `EnemyKnowledgeRevealed`) от `/commands`, с тем же `roll_id`. Новый endpoint не выполняет собственный смысл текста. Причина прослеживается в двух местах: `structuredCommandTurnId` адресует trace только парой `(campaignId, idempotencyKey)` ([`game-orchestrator.mjs#L562`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L562)), а fingerprint запроса не содержит endpoint или command batch. Оба маршрута поэтому видят один и тот же duplicate commit; общий hash event-store уже не проверяется.

Проблема особенно заметна при восстановлении после сетевой ошибки: клиент, который сменил маршрут или тип отправки, может получить `200` и механику предыдущего маршрута, считая новую заявку подтверждённой. Это contract ambiguity между свободным вводом и структурированной командой. Если в будущем оба endpoint будут канонизировать действительно одинаковую операцию в один semantic hash, их общий namespace можно сохранить; изоляция endpoint сама по себе не обязательна.

Минимальное направление исправления: выбрать документированную область ключа и сравнивать полный semantic request до replay. Поле `operation` (`narrate`/`commands`) — один из вариантов envelope; другой вариант — единый нормализованный semantic hash, общий для endpoint-ов, когда они действительно выражают одну операцию. В обоих случаях несовместимые normalized requests под одним ключом должны получать `409 IDEMPOTENCY_CONFLICT`, даже если текст совпадает. Отдельные префиксы endpoint-ов тоже возможны, но их следует хранить и сравнивать как часть durable request envelope.

### CMD-03 — смена актора в том же `/commands` ключе: подтверждённый отказ, новая дыра не найдена

Тип: negative finding · confidence: high · real HTTP.

Probe сначала отправляет `IdentifyEnemy(actor_id=hero-a, target_id=goblin-a)` с ключом `cross-actor-key`, затем тем же player и ключом — команду с `actor_id=hero-b`. Первый запрос получает `200`, второй — `409 IDEMPOTENCY_CONFLICT`.

Это ожидаемый результат текущей защиты: `playerId` входит в `narrationRequestFingerprint`, а `assertNarrationRequestIdempotency` сравнивает fingerprint сохранённого trace ([`game-orchestrator.mjs#L619`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L619), [`game-orchestrator.mjs#L633`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/game-orchestrator.mjs#L633)). Изменение actor не считать самостоятельной подтверждённой дырой. Универсальный envelope из CMD-01 всё равно должен сохранять actor явно, чтобы защита не зависела от наличия trace и одинаково работала на новых endpoint.

## Предлагаемый порядок закрытия

1. Ввести один `request_envelope`/`request_hash` для `AuthoritativeExecutor` и всех HTTP command routes после санитизации. В envelope должны входить operation либо единый cross-endpoint semantic identity, actor, normalized command list и versioned semantic fields; не включать произвольные поля, которые не участвуют в механике.
2. Сделать duplicate lookup возвращающим старый commit только после сравнения durable hash. Для старых commit без envelope нужно выбрать и явно задокументировать compatibility-режим; переписывать историю или добавлять обязательную миграцию без отдельного решения о legacy-семантике не требуется.
3. Добавить три изолированных HTTP теста по probe: изменённая команда при том же key, cross-endpoint reuse несовместимой операции и смена actor. Для первых двух ожидаем `409 IDEMPOTENCY_CONFLICT`; третий фиксирует уже существующую защиту.
4. Зафиксировать область ключа в API-документации: campaign-wide или actor/operation-scoped. Сейчас `getByIdempotencyKey(campaignId, key)` задаёт campaign-wide namespace, а trace и routes добавляют несимметричные частичные проверки.

Probe не добавлен в `pnpm test`: это одноразовая безопасная HTTP-воспроизводимость без правок runtime и без новых зависимостей. Его результат достаточен для отдельной задачи по контракту повторов; `pnpm verify` для документационного аудита не запускался.
