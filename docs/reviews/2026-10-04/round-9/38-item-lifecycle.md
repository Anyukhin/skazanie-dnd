# Жизненный цикл предмета: экземпляр, частичный обыск и передача

Дата среза: 2026-10-04. Проверен runtime checkout
`cb045a8466f35696ff24abe9020d6f39dee89462`. Scope ограничен тремя
вертикалями: создание server-owned экземпляра и его уход в контейнер при
выбытии владельца, частичный обыск с replay/idempotency, а также обычный
`TransferItem` между героем и NPC. Runtime, тесты, данные, storage и
зависимости не менялись.

## Результат

Существенного обхода прав или двойной выдачи предметов в проверенном срезе не
нашел. Границы действия стоят в правильных местах: loadout врага создаётся
через `createItemInstance` с замороженным snapshot, `owner` и `origin`
([`enemyLoadoutFor`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/enemy-loadouts.mjs#L264-L301));
смерть, плен и tribute планируют контейнер в том же commit, что и событие
выбытия ([`resolveCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L21395-L21412),
[`planLootContainerDrafts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L671-L760));
частичный обыск проверяет весь набор до выпуска одного события
([`validateLootContainerCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L928-L1043));
состояние после replay восстанавливается reducer-ом контейнера
([`applyLootContainerEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L1134-L1207)).

Найдена одна важная граница расширения, а не доказанный runtime-баг: после
подъёма экземпляр превращается в legacy-запись `hero.inventory` с новым
`id`. Прямой `item_instance_id` и полная структура `origin` в этой записи не
сохраняются, но категориальная строка происхождения сохраняется: мост
переносит `origin.kind` в значения вроде `looted`/`stolen` и сознательно не
выдаёт закрытые `template_id`/`source_id`. Функция
[`inventoryItemFromInstance`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L895-L914)
явно строит `normalizeInventoryItem` из snapshot, переводит допустимое
происхождение в категориальную строку и задаёт `id` аргументом; при команде
обыска этот id вычисляется как `loot:<digest>`
([`lootedItemId`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L916-L918),
[`validateLootContainerCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L988-L992)).
Исходная связь всё же остаётся восстанавливаемой из журнала: `LootContainerCreated`
содержит закрытый экземпляр, а `LootContainerTaken.lines` сохраняет исходные
`item_instance_id` вместе с новым inventory payload. Ограничение относится к
текущему снимку после выдачи и к последующим merge/split: в `hero.inventory`
нельзя напрямую сопоставить запись с экземпляром, а при слиянии стопок
детерминированный `loot:<digest>` может исчезнуть. Если понадобится lifecycle
«какой экземпляр продан/починен/передан», потребуется сохранять такую связь и
в inventory-контракте, не объявляя нынешнюю журнальную трассу потерянной.

## Вертикаль 1: создание экземпляра и выбытие владельца

У врага путь начинается в `enemyLoadoutFor`: каждый предмет получает
детерминированный `item_instance_id` (`<owner>-item-N`), каталожный snapshot,
количество, owner вида `enemy` и origin `enemy_loadout`; заряды и
`lootable` входят в тот же объект экземпляра. При загрузке старой кампании
`normalizeEnemyLoadout` принимает только нормализуемые экземпляры и не
материализует каталог заново ([`normalizeEnemyLoadout`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/enemy-loadouts.mjs#L343-L358)).
Это сохраняет snapshot для replay и отделяет каталог (`catalog_id`) от
конкретной вещи.

В конце верхнего `resolveCommand` сервер сначала применяет обычные события,
получает проекцию `after`, затем один раз вызывает
`planLootContainerDrafts`. Планировщик читает inventory **до** очистки,
позицию из состояния **после**, и выпускает `LootContainerCreated` в тот же
поток. Для пленного, сбежавшего по tribute и умершего NPC действуют отдельные
ветви, но контейнерный владелец везде становится `{kind: 'container',
actor_id: containerId}`; исходный `origin` не переписывается
([`npcLootDrafts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L539-L615),
[`planLootContainerDrafts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L739-L816)).

Reducer создания контейнера переносит item instances из `enemy.loadout.items`,
удаляя только совпавшие instance IDs; для NPC-world inventory он удаляет
закрытый inventory только при первом фактическом применении события
([`applyLootContainerEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L1134-L1172)).
Поэтому текущие контроли действительно различают «остаток вещи» и каталожный
шаблон: потраченные болты не воскресают, а снятый скимитар не дублируется в
кармане врага.

Охват подтверждён тестами `loot-containers.test.mjs` и
`npc-loot-containers.test.mjs`: смерть/NPC death/captive/tribute, повторный
container id после опустошения, разбиение количества `2500` на `999/999/502`,
неизвестная raw-вещь, сохранение потраченных зарядов и replay создания.

## Вертикаль 2: частичный обыск, количество и повтор события

`LootContainer` принимает только `container_id`, строки
`{item_instance_id, quantity}`, получателя и версию. Сервер последовательно
проверяет ACL героя, отряд, состояние контейнера, этаж, расстояние, уникальность
строк и доступное количество; затем целиком проверяет capacity, stack limit и
weight. Ошибка любой проверки не выпускает событие и не расходует действие.
В событии остаются одновременно выбранные `items`, точный
`remaining_items`, `remaining_count` и `status_after`
([`lootContainerCommandEvents`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L1045-L1070)).

Reducer намеренно сравнивает контейнер с `remaining_items` до выдачи вещей.
Если событие применилось второй раз, контейнер уже стоит на том же остатке и
инвентарь получателя не меняется. Если добыча слилась с существующей стопкой
и её `id` исчез из inventory, этот же guard всё равно удерживает количество от
повторного увеличения. Дополнительный `addLootedItem` распознаёт детерминированный
`id` поднятой вещи там, где стопка не слилась
([`addLootedItem`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L1085-L1101),
[`applyLootContainerEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L1174-L1206)).
В Rules Engine это единственный владелец физики обыска: case `LootContainer`
только оборачивает уже проверенный результат в событие
([`Rules Engine`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L19759-L19769)),
а reducer подключает контейнерный модуль и списывает боевое действие
([`LootContainerTaken reducer`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L24754-L24769)).

Положительные контроли: штатный и частичный обыск, перегрузка «всё или
ничего», недостижимый контейнер, дубль строки, неверное количество, пустой
контейнер, stale `expected_state_version`, повтор поверх уже слитой стопки,
полный replay потока и повтор HTTP-запроса с тем же ключом. На срезе
`node --test test/loot-containers.test.mjs test/npc-loot-containers.test.mjs`
выполнено `50/50` тестов; HTTP-сценарий
`test/loot-containers-api.test.mjs` — `5/5`.

## Вертикаль 3: обычный `TransferItem` и граница legacy inventory

Для героя/NPC `TransferItem` работает с `item.id`, разрешает передачу только
вне боя, запрещает экипированный/настроенный предмет и проверяет видимость,
жизнь и доступность NPC. Количество ограничено исходной стопкой, получатель
проверяется по вместимости, весу и лимиту стопки
([`validateItemLifecycleCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/item-lifecycle.mjs#L472-L542)).
Сервер строит новый `transferred_item` с детерминированным id, а событие
содержит обе стороны, количество и полный item payload
([`itemLifecycleEvents`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/item-lifecycle.mjs#L593-L628)).
Reducer атомарно уменьшает источник, удаляет нулевой остаток и либо добавляет
получателю, либо сливает с совместимой стопкой
([`applyItemLifecycleEventToPlayers`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/item-lifecycle.mjs#L681-L708)).

Это даёт хорошие текущие свойства: частичная передача сохраняет сумму
количеств, отказ не мутирует состояние, NPC inventory не раскрывается игроку,
replay совпадает, а durable idempotency не передаёт вещь NPC дважды. Unit
наборы `item-lifecycle.test.mjs` и `npc-item-transfer.test.mjs` покрывают
`TransferItem`, ACL, combat denial, recipient checks, stack merge, capacity и
replay; HTTP `test/npc-item-transfer-api.test.mjs` покрывает ACL,
idempotency и restart projection.

Но этот путь не является продолжением `item_instance_id`: исходный
`item_instance_id` не поле команды и не поле `transferred_item`, а новый id
вычисляется из `command_id`, старого `item.id` и recipient. Поэтому прямое
сопоставление экземпляра теряется в текущем снимке при цепочке «NPC/враг →
контейнер → герой → NPC/герой», хотя исходные шаги остаются в журнале.
Проверка текущей функции на синтетическом экземпляре дала ограниченный
результат `{id: "loot:child", quantity: 1, origin: "looted"}` без
`item_instance_id`; это подтверждает форму кода и не является отдельным
runtime-дефектом.

## Минимальный seam для будущего расширения

Если нужна только справка об истории вещи, сначала можно использовать уже
сохранённые события или производный read-model по ним, с прежними ограничениями
видимости. Это не второй авторитетный инвентарь. После слияния одинаковых
стопок такая справка должна честно описывать известные источники, а не
выдумывать индивидуальную историю каждой взаимозаменяемой единицы.

Если продукт потребует постоянную provenance после подъёма, самый маленький
срез находится в существующем контракте inventory и мосте, а не в новом
реестре.

Начать можно с именованной вещи, для которой существенна индивидуальная
история, а количество равно единице. Политика происхождения смешанной стопки
при разделении — отдельный выбор; запретить любое слияние обычных предметов
значило бы изменить вместимость и поведение инвентаря без такого требования.

1. Ввести опциональное поле `item_instance_id` (и, при необходимости,
   `source_item_instance_id`) в legacy inventory item. Это поле должно пройти
   существующие whitelist/normalizer/materializer границы:
   `normalizeInventoryItem` ([`merchant-economy.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/merchant-economy.mjs#L290-L360)),
   `INSTANCE_FIELDS`/`materializeCatalogItem` ([`item-catalog.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/item-catalog.mjs#L1936-L2002)),
   `InventoryItem` и связанные client types ([`src/types.ts`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/types.ts#L733-L762)).
   При полном подъёме переносить исходный ID, при частичном количестве
   оставлять source ID за остатком и выдавать детерминированный child ID для
   переехавшей части. Та же политика уже есть у NPC loot segments: первый
   сегмент сохраняет исходный ID, дополнительные получают детерминированные IDs
   ([`npcLootInstanceId`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/loot-containers.mjs#L525-L537)).
2. Протянуть поле через существующие projection/client и input boundaries с
   сохранением приватности. `lootItemForViewer` уже выдаёт отдельную
   безопасную карточку, а `viewer-projection` снимает закрытые origin-поля;
   direct `item_instance_id` в публичный inventory projection добавлять только
   если UI реально его использует. `sanitizePlayerItemCommand` должен по-прежнему
   принимать только `item_id`/`quantity` и выводить instance ID из server state,
   а не доверять присланному provenance
   ([`sanitizePlayerItemCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L1858-L1937)).
   Это правило нужно проверить и на остальных публичных путях создания/импорта
   вещей. Клиентские типы требуют новой ссылки только если она входит в
   публичный контракт; приватную связь не обязательно отправлять в UI.
3. Изменить существующие `inventoryItemFromInstance`, `addLootedItem` и ветку
   `TransferItem`/её reducer. Для provenance-bearing экземпляров не сливать
   записи без явного lineage; старые hero items без поля оставить на прежнем
   `item.id` контракте. Событие должно нести source/child ID и quantity, а
   replay/idempotency — проверять контейнерный остаток и детерминированный child
   ID так же, как сейчас. Добавить точечные проверки полной передачи, partial
   split, stack merge denial, replay и повторного commit после restart. Это не
   создаёт второй inventory/registry framework.

До появления требования на ремонт/продажу/историю конкретной вещи текущая
граница приемлема: закрытый `origin` живёт в контейнере и событии, игрокская
проекция не раскрывает его, а количество и выдача защищены. Не следует
подменять это расширение переписыванием всего inventory или введением второго
реестра экземпляров.

## Проверки

Запущены только сфокусированные проверки:

```text
node --test test/item-lifecycle.test.mjs test/loot-containers.test.mjs \
  test/npc-loot-containers.test.mjs test/npc-item-transfer.test.mjs
# 67/67 passed

node --test test/loot-containers-api.test.mjs test/npc-item-transfer-api.test.mjs
# 6/6 passed
```

Полный `pnpm verify` не запускался по правилам аудита. Дополнительный probe-файл
не нужен: единственная обнаруженная граница подтверждена трассировкой
production-кода и bounded one-line проверкой формы `inventoryItemFromInstance`;
исправление в рамках этого отчёта не вносилось.
