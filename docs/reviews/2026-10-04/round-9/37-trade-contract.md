# Раунд 9, аудит торгового контракта

Дата аудита: 2026-10-04. Проверен код runtime commit
`cb045a8466f35696ff24abe9020d6f39dee89462`; `auditHEAD=eef3fb39a5be8f8da89e41011bc9dda2071cf468`
— отдельная вершина ветки аудита.

## Вывод

По проверенному контракту конкретной уязвимости не найдено. Цена, количество,
остаток и валюта вычисляются и проверяются сервером в Rules Engine; HTTP слой
принимает только идентификаторы и количество, а `expected_state_version` связывает
операцию с котировкой. Клиентские `price_cp`, `base_price_cp`, `item` и `roll`
не являются входом в расчёт.

Для last-unit есть отдельная детерминированная проба границы хранения: два
обычных героя с одинаковой свежей версией одновременно покупают единственный
товар. В `37-trade-probe.mjs` оба сначала получают серверную котировку, затем
готовят серверную команду с `expected_state_version: 0`; прямой вызов
`RulesEngine` строит обе операции, а реальный `FileEventStore` коммитит ровно
одну, вторая получает `STATE_VERSION_CONFLICT`, итоговый склад равен `0`, и
предмет оказывается ровно у одного героя. Это проба Rules Engine + FileEventStore,
не HTTP-проверка двух отдельных пользователей. Запуск:

```text
node docs/reviews/2026-10-04/round-9/37-trade-probe.mjs
```

Проба использует только временный каталог и удаляет его в `finally`; `storage/`,
`data/`, `.env` и LLM не затрагиваются.

## Что проверено

1. **Котировка → покупка.** `merchantViewFor` строит `buy_quotes` из серверного
   каталога, политики торговца, торга и репутации; `resolveCommand` повторно
   строит котировку из текущего состояния перед созданием
   `MerchantPurchaseCompleted`. В событии сохраняются `unit_price_cp`,
   `total_price_cp`, балансы до/после, источник цены и policy id. Поэтому
   присланная цена не участвует в расчёте. Пользователь согласует цену,
   показанную серверной витриной; `expected_state_version` проверяет, что
   команда относится к свежей версии условий, а сервер сам получает итоговую
   цену из этой версии.

2. **Количество и остаток.** До события сервер проверяет положительное целое
   количество, `MAX_TRANSACTION_QUANTITY`, наличие `stock.quantity`, вес,
   вместимость инвентаря и пределы стека. Редьюсер уменьшает именно выбранный
   `stock_id` на подтверждённое количество. При параллельной покупке optimistic
   version проверяется атомарно в event store; устаревшая команда не получает
   повторной продажи последней единицы.

3. **Два игрока и права.** HTTP `sanitizeMerchantCommand` требует владельца
   героя и свежий `expected_state_version`; подстановка чужого `actor_id`
   отклоняется до Rules Engine. Выделенный endpoint и общий
   `/api/campaigns/:id/commands` оба прогоняют торговую команду через этот
   санитайзер и требуют одну атомарную операцию.

4. **Каноническая валюта и атомарность.** Деноминации нормализуются в copper
   (1 мм = 1 cp, 1 см = 10 cp, 1 зм = 100 cp, 1 пл = 1,000 cp), затем сумма
   проверяется на безопасный предел и списывается/зачисляется одним событием.
   Покупка одновременно меняет монеты героя, кошелёк торговца, инвентарь и
   склад; продажа делает обратное. Отказ до коммита не меняет ни одну сторону.

5. **Idempotency и replay.** HTTP тест проверяет повтор той же операции после
   коммита и после перезапуска, а другой payload с тем же ключом получает
   `IDEMPOTENCY_CONFLICT`. Это отдельный контроль от известного
   `CMD01`-класса коллизий fingerprint; здесь он не переименовывается и не
   заявляется как новая находка.

## Запущенные проверки

```text
node --test test/merchant-economy.test.mjs test/merchant-api.test.mjs
21 passed, 0 failed
```

HTTP-тест проверяет реальный endpoint, включая ownership, forged-price fields,
stale quote и idempotency. Его параллельный сценарий — один герой, один ключ
идемпотентности и два разных `stock_id`; это concurrency/idempotency-проверка
HTTP-маршрута, а не last-unit для двух героев. Отдельная прямая проба last-unit
дала один `fulfilled`,
один `STATE_VERSION_CONFLICT`, `final_stock: 0` и одного покупателя.

## Дизайнерская граница

Котировка не является отдельным долговечным объектом: сервер не принимает
`quote_id` или клиентскую цену как платёжное обязательство. Цена, которую игрок
видит и принимает, привязана к `expected_state_version`; при изменении состояния
между GET и POST старая версия непригодна и требует новой котировки. В момент
коммита сервер снова вычисляет цену из этой версии (включая уже записанный
`bargain`), поэтому клиент не может подменить согласованные условия числом из
запроса.

Также merchant economy clock/ресток остаётся документированным атомарным
исключением проекта: этот аудит не трактует его наличие как дефект торгового
контракта.

## Источники на pinned commit

- [server/merchant-economy.mjs#L922-L978](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/merchant-economy.mjs#L922-L978) — серверные buy/sell quote.
- [server/merchant-economy.mjs#L1053-L1204](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/merchant-economy.mjs#L1053-L1204) — merchant view и котировки.
- [server/rules-engine.mjs#L5022-L5047](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L5022-L5047) — stock lookup и проверка transaction total.
- [server/rules-engine.mjs#L6382-L6478](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L6382-L6478) — preconditions цены, stock, средств, вместимости и purse.
- [server/rules-engine.mjs#L18825-L18870](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L18825-L18870) — authoritative purchase event.
- [server/rules-engine.mjs#L23468-L23515](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L23468-L23515) — purchase reducer.
- [server/index.mjs#L1940-L1972](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L1940-L1972) — HTTP command sanitizer and fingerprint input.
- [server/index.mjs#L4835-L4890](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L4835-L4890) — dedicated merchant GET/POST route.
- [server/event-store.mjs#L740-L810](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/event-store.mjs#L740-L810) — optimistic version and idempotent commit.
- [test/merchant-api.test.mjs#L210-L277](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/merchant-api.test.mjs#L210-L277) — HTTP race (один герой, один ключ, два разных `stock_id`), forged price fields, ownership и idempotency.
- [test/merchant-api.test.mjs#L291-L325](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/merchant-api.test.mjs#L291-L325) — stale quote after bargain and agreed-price result.
- [test/merchant-economy.test.mjs#L100-L126](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/merchant-economy.test.mjs#L100-L126) — canonical currency and server-derived view.
- [test/merchant-economy.test.mjs#L184-L230](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/merchant-economy.test.mjs#L184-L230) — atomic buy, replay and server price.
