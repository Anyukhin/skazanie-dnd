# Контракт торговли и экономики

Дата фиксации: 13 июля 2026 года.

## Решение по ценообразованию

Торговля использует гибридную модель:

1. Серверный каталог задаёт неизменяемую базовую цену известного предмета и её происхождение.
2. Versioned server appraisal policy задаёт базовую цену нестандартного предмета по ограниченным категории, редкости и состоянию. Клиент и агент не передают цену или выбранную policy в игровой команде.
3. Политика конкретного торговца задаёт наценку покупки, долю выкупа, СЛ торга и ограничение агентской поправки.
4. `ShopAssembler` детерминированно выбирает личность NPC, ассортимент и стартовую кассу из серверных правил. Persona, stock, `purse_cp` и pricing policy проходят lifecycle validator и сохраняются событиями; магазин может создать администратор вручную либо Директор в одном commit с переходом в поселение.
5. Rules Engine бросает проверку торга, вычисляет итог в целых медных монетах и одним событием меняет валюту героя, кассу торговца, инвентарь и склад.

LLM, браузер и текст реплики не являются источником цены, остатка, результата броска или изменения валюты.

## Источник базовых цен

`server/merchant-economy.mjs` содержит небольшой allowlist SRD 5.2.1. Сейчас в него входят dagger, longsword, longbow, shortbow, leather armor, shield, explorer’s pack, potion of healing, rations, hempen rope, torch и 20 arrows.

Используется официальный System Reference Document 5.2.1:

- монеты и продажа снаряжения — печатная страница 89;
- оружие — страница 91;
- доспехи и щит — страница 92;
- снаряжение — страница 95.

Проверенный PDF: <https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf>. SHA-256: `8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87`. Обязательная атрибуция находится в `ATTRIBUTION.md`.

Каталожный `catalog_id` всегда выигрывает у сохранённого `base_price_cp`: игрок не может повысить или понизить цену известного предмета поддельным запросом. Для нестандартного предмета простой `base_price_cp`, `price_provenance`, `appraisal_policy_id` или вложенный объект `appraisal` из snapshot также не являются доказательством цены. Торговая цена появляется только после server-authoritative `MerchantItemAppraised`, записанного в event stream.

## Серверная оценка нестандартных предметов

`AppraiseItem` принимает от игрока только `actor_id`, `merchant_id`, `item_id`, просмотренную `expected_state_version` и внешний idempotency key. Сервер заново находит предмет в авторитетном инвентаре, проверяет владельца, текущую локацию, доступность торговца, отсутствие боя и то, что предмет не каталожный, не сюжетный и ещё не оценён. Надетый предмет можно оценить, но нельзя продать, пока герой его не снимет. Поля цены, provenance, policy и произвольный descriptor из запроса отбрасываются на HTTP-границе.

Модуль `server/item-appraisal.mjs` публикует контракт `skazanie:item-appraisal:v1` и allowlisted policy `skazanie:item-appraisal:category-rarity-condition:v1`. Формула детерминирована:

```text
base_price_cp = round(category_base_cp × rarity_multiplier_bps × condition_multiplier_bps / 100000000)
```

- категории: `miscellaneous`, `consumable`, `tool`, `treasure`, `weapon`, `armor` с базой от 25 до 1000 CP;
- редкость: `common`, `uncommon`, `rare`, `very_rare`, `legendary` с множителем от ×1 до ×500;
- состояние: `broken`, `damaged`, `worn`, `serviceable`, `fine`, `pristine` с множителем от ×0,1 до ×1,5;
- результат ограничен диапазоном 1–10 000 000 CP.

Текущий merchant workflow выводит категорию из server-owned `item.type`, редкость — из ограниченного RU/EN словаря, а состояние пока фиксирует как `serviceable`; отдельной механики осмотра повреждений ещё нет. Это policy проекта, а не правило SRD о цене magic/homebrew items.

`MerchantItemAppraised` содержит policy/formula provenance и SHA-256 `appraisal_fingerprint`. Reducer записывает аттестацию в `mechanics.item_appraisals[actor_id][item_id]`; доверенная запись дополнительно связана с `actor_id`, `merchant_id` и каноническим `item_stack_key`. Изменившийся descriptor/stack key инвалидирует старую оценку. Полная продажа удаляет запись героя, но переносит аттестацию в resale stock; при обратной покупке она снова привязывается к получателю. Поэтому replay восстанавливает ту же цену без обращения к LLM.

## Валюта и округление

Расчёты идут только в целых CP:

```text
1 SP = 10 CP
1 GP = 100 CP
1 PP = 1000 CP
```

SRD также содержит EP = 50 CP, но текущий `Currency` ещё не хранит electrum. Существующий корректный кошелёк сохраняет свои номиналы при загрузке; после операции остаток вычисляется в CP и раскладывается обратно только по поддерживаемым CP/SP/GP/PP.

Покупка округляется вверх после политики торговца. Продажа округляется вниз; минимальный выкуп 1 CP является явным правилом кампании `skazanie:economy:merchant-policy-v1`, а не правилом SRD. Базовая продажа обычного снаряжения за половину покупной цены зафиксирована правилом `srd_5_2_1:economy:selling-equipment`.

### Касса торговца

`merchant.purse_cp` — server-authoritative целое число CP в диапазоне 0–9 000 000 000. Новый `ShopAssembler` выдаёт лавке ограниченную стартовую кассу `clamp(floor(budget_cp / 4), 100, 100000)`; для старых snapshot без поля используется детерминированный compatibility reserve 100 000 CP. Администратор/Директор может задать кассу через проверяемые `CreateMerchant` и `ConfigureMerchant`.

Покупка героем атомарно уменьшает его баланс и увеличивает кассу торговца; продажа делает обратное. Rules Engine до события отклоняет выкуп дороже кассы (`INSUFFICIENT_MERCHANT_FUNDS`) и покупку, которая переполнит её верхнюю границу (`MERCHANT_PURSE_LIMIT_EXCEEDED`). Sell quote показывает `can_afford` и ограничивает `max_quantity` значением `floor(purse_cp / unit_price_cp)`. В `MerchantPurchaseCompleted` и `MerchantSaleCompleted` записаны `merchant_purse_before_cp` и `merchant_purse_after_cp`, поэтому при отказе не меняется ни один участник, а replay не создаёт и не теряет деньги.

## Команды и события

Игроку разрешены четыре торговые команды:

- `BargainWithMerchant` — одна серверная проверка Харизмы для пары герой–торговец. Сохранённый безопасный modifier поддерживается, но полная derivation proficiency/expertise и situational bonuses из листа персонажа ещё не реализована;
- `AppraiseItem` — server-derived оценка нестандартного предмета без изменения валюты или stock;
- `BuyItem` — списание валюты, уменьшение stock и выдача/stack предмета;
- `SellItem` — уменьшение/удаление предмета, пополнение stock и начисление валюты.

Они создают `MerchantBargainResolved`, `MerchantItemAppraised`, `MerchantPurchaseCompleted` и `MerchantSaleCompleted`. Каждый результат содержит соответствующий request fingerprint и policy/catalog/appraisal provenance и сохраняется в FileEventStore. Reducer воспроизводит одинаковые кошельки героя и торговца, appraisal registry, инвентарь, склад, условия торга и ограниченный журнал экономики после restart/replay. Повтор того же idempotency key допустим только для того же семантического fingerprint команды; другой предмет или операция дают конфликт.

Административный/системный lifecycle дополнительно использует `CreateMerchant`, `ConfigureMerchant`, `RestockMerchant`, `MoveMerchant` и `SetMerchantAvailability`. Системная команда `AdvanceScene` может нести нормализованный `scene_commerce`; для нового поселения Rules Engine коммитит `SceneAdvanced` и `MerchantCreated` одним batch, поэтому сцена не может сохраниться отдельно от автоматически собранной лавки.

Нельзя продавать надетый, сюжетный, явно `sellable: false` или неоценённый предмет. Нельзя торговать во время боя, с отсутствующим NPC либо из другой локации.

## Граница доверия при cutover

В `enforce` новые bargain/appraisal/buy/sell фиксируются событиями и воспроизводятся replay. Но переход из `shadow` не переоценивает автоматически исходные кошельки героя и торговца, инвентарь, stock или policy: импортированный snapshot становится принятой начальной точкой. Если до cutover эти данные менялись legacy-клиентом, LLM-tool или broad admin write, последующая event-sourcing не доказывает их происхождение.

Перед production-cutover нужна сверка стартового economy snapshot и явное административное подтверждение. После cutover создание, настройка кассы/pricing/persona, пополнение, перемещение и доступность магазина изменяются событиями `MerchantCreated`, `MerchantConfigured`, `MerchantRestocked`, `MerchantMoved`, `MerchantAvailabilityChanged`; новые оценки — только `MerchantItemAppraised`.

## HTTP-контракт

```text
GET /api/campaigns/:campaignId/merchants/:merchantId?actor_id=:actorId
POST /api/campaigns/:campaignId/merchants/:merchantId/commands
POST /api/campaigns/:campaignId/merchants/commands
POST /api/campaigns/:campaignId/merchants/assemble
```

GET возвращает только публичную карточку торговца, `merchant_purse_cp`, серверные buy/sell/service quotes, кошелёк выбранного героя и `expected_state_version`. Для неоценённого допустимого предмета sell quote содержит `appraisal_required: true`/`can_appraise: true`; после события он получает цену с `price_provenance: server_appraisal_policy`. `PurchaseMerchantService` принимает только `service_id`: сервер повторно проверяет доступность/присутствие, рассчитывает цену и атомарно создаёт `MerchantServicePurchased`. POST принимает одну команду и `idempotency_key`. Клиент обязан передать версию просмотренной котировки; при изменившемся состоянии получает `409` и должен запросить витрину заново.

Минимальная форма оценки через merchant command endpoint:

```json
{
  "command": {
    "command_type": "AppraiseItem",
    "actor_id": "hero-id",
    "item_id": "inventory-item-id",
    "expected_state_version": 42
  },
  "idempotency_key": "appraise:hero-id:inventory-item-id:42"
}
```

POST не принимает цену, итог, валютную дельту, appraisal policy/descriptor, предметный шаблон, остаток, модификатор проверки или результат d20. Владение героем, доступ к кампании, режим `enforce`, доступность NPC, локация, бой, количество, обе кассы, stock и версия проверяются сервером.

Lifecycle endpoint доступен только администратору/системному агенту и принимает одну из `CreateMerchant`, `ConfigureMerchant`, `RestockMerchant`, `MoveMerchant`, `SetMerchantAvailability`. ShopAssembler получает только текущую серверную локацию, тип поселения, тему, seed, бюджет и необязательный allowlisted director intent `{catalog_id, quantity, agent_adjustment_bps}`. Произвольные цены, persona, секретные поля и custom catalog ID он отклоняет; proposal затем проходит тот же lifecycle validator и event commit.

## Автоматическая лавка при переходе сцены

В `enforce` после разрешённого группового решения сервер загружает event state, вызывает `SceneArchitect`, канонизирует переход и строит только server-derived команды. Клиентский `/api/narrate` не может передать `commands` или подделать capability Директора. `AdvanceScene` запрещён через общий typed-command endpoint, доступен только admin/director context и отклоняется до завершения активного боя.

`scene_commerce` имеет фиксированный контракт `skazanie:scene-commerce-plan-v1`: action `create|none`, settlement type `village|town|city|outpost|traveling`, theme `general|provisions|arms|healing`, ограниченный бюджет, краткую причину, outcome `created|reused|not-requested` и nullable `merchant_id`. Локацию, seed, merchant ID, persona, stock и цены Директор не задаёт: они выводятся сервером из канонического перехода, устойчивой ссылки на resolved party decision и каталога. Произвольный suffix клиентского action не меняет seed лавки.

Для распознанного поселения default policy создаёт одну базовую лавку. Для wilderness постоянная лавка по умолчанию не создаётся. Если в целевой локации уже есть торговец, переход помечается `reused`, а его stock и история сделок сохраняются. `scene.location_id` и `merchant.location_id` выводятся из канонической глобальной карты и имеют приоритет над отображаемым названием; если один из ID отсутствует в старом snapshot, применяется нормализованный строковый fallback.

## Услуги и часы пополнения

`merchant.services` — bounded список публичных услуг с серверной базовой ценой, длительностью, доступностью и признаком обязательного присутствия. Покупка услуги фиксирует коммерческое исполнение и перевод монет; специализированный механический эффект (например, реальный ремонт предмета или перемещение транспортом) должен выполняться отдельной доменной командой и пока не выводится из текста услуги.

`merchant.restock_policy` использует только время кампании `mechanics.world_time.elapsed_minutes`. Она может довести существующие catalog-attested позиции до заданного target, но не создаёт новый SKU и не меняет `catalog_id`. `POST /api/campaigns/:id/system-tick` коммитит `MerchantRestocked` и `MerchantEconomyClockAdvanced` атомарно; checkpoint делает повторный тик и restart идемпотентными.

## Интерфейс

Экран «Торговец» показывает:

- личность, приветствие и местоположение NPC;
- кошелёк героя;
- кассу торговца и ограниченное ею количество выкупа;
- вкладки покупки и продажи;
- фактический остаток и допустимое количество;
- цепочку «база каталога → политика торговца → результат торга → итог»;
- явный итог `серверная цена за единицу × выбранное количество` для покупки и продажи;
- отказ для надетых и сюжетных предметов, а для допустимого нестандартного предмета — действие «Оценить» и обновлённую серверную котировку;
- read-only предупреждение вне `enforce`.

Клиент не применяет optimistic mutation денег, предметов или склада. После сделки он принимает только `authoritative_state` и новую серверную витрину.

## Что ещё не реализовано

- автоматический Director → event-sourced party decision → `SceneAdvanced` → `ShopAssembler` готов для подтверждённого перехода в распознанное поселение;
- нет устойчивого `location_id`: повторное использование торговца пока основано на строке локации;
- касса ограничивает ликвидность, но не моделирует спрос: нет лимита потребности в конкретном товаре, репутации, налогов, кражи, долгов, услуг, устойчивого диалога и автоматических restock/economy clocks;
- нет durable signed quote с временем истечения; вместо него действует optimistic `state_version`;
- appraisal не идентифицирует магические свойства, не бросает отдельную проверку знания и пока считает состояние `serviceable`; это bounded price policy, а не полноценная экспертиза сокровищ;
- нет EP, полной базы предметов, полного skill/proficiency/expertise derivation для торга, crafting и magic-item economy;
- купленные armor, shield и potion ещё не подключены к полному equip/use engine;
- FileEventStore и legacy room projection пока не образуют одну транзакцию.
