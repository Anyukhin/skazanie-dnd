# Раунд 11: lifecycle membership и hero slot

Срез runtime: `cb045a8466f35696ff24abe9020d6f39dee89462` (полный SHA; текущий
checkout `HEAD=873c946df44b716c40a74d395471e33ddb1ef1c2` содержит только
документационные проходы). Проверены `server/store.mjs`, ACL и маршруты
`server/index.mjs`, character lifecycle на границе команд и профильные тесты.
`pnpm verify` не запускался по `AGENTS.md`; рабочие `storage/`, `.env`
и внешний LLM не использовались. Каталоги `data/` читались штатными модулями
без изменений.

## Вывод

Обычный self-service create/invite/join уже покрыт штатным API-тестом
([`authored-map-movement.test.mjs:184-228`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/authored-map-movement.test.mjs#L184-L228)).
Membership хранится отдельно, выдача свободного места идёт под auth lock,
повтор той же ссылки для того же аккаунта возвращает прежний slot. Это также
проверено прямыми store-тестами и bounded HTTP probe.

Найден один условный lifecycle-риск (P2, future integrity risk). Если когда-либо
уже выданная ссылка переживёт удаление/изменение slot в состоянии кампании,
`POST /join` сначала запишет membership и redemption в `auth.json`, а затем
обнаружит, что выбранного hero нет в комнате. Ответ будет `409`, но orphan
membership останется активным и переживёт restart. В текущем runtime штатной
HTTP-операции удаления party slot не найдено, поэтому это не обычный exploit
сегодняшнего игрока и не расширение известного SSE/reassignment finding.

## Static: владельцы и порядок commit

- `redeemCampaignInvite` выбирает свободный hero, добавляет membership и
  redemption, затем атомарно пишет `auth.json`
  ([`store.mjs:294-353`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/store.mjs#L294-L353)).
  Lock сериализует участвующие в нём redemption при общем локальном storage;
  он не связывает этот commit с room projection. Это не доказательство
  произвольной межпроцессной надёжности: lock старше 30 секунд удаляется как
  stale. Если его живой владелец был надолго приостановлен, такой takeover
  может нарушить исключительность. Этот сценарий здесь не воспроизводился
  ([`withAuthLock`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/store.mjs#L52-L86)).
- HTTP join вызывает redemption на строке 4274 и лишь после этого проверяет
  `partyIds` комнаты на строках 4275-4277
  ([`index.mjs:4263-4283`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L4263-L4283)).
  Ветка ошибки не удаляет уже созданные membership/redemption.
- Действующее создание invite проверяет `hero_ids` по `partyIds` и занятости.
  Ссылка по умолчанию исключает готовых героев, но явная ссылка на один
  существующий готовый неназначенный slot допустима
  ([`index.mjs:4232-4243`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L4232-L4243)). Поэтому probe вынужден
  моделировать ранее выданную ссылку через внутренний store API. Это ограничивает
  finding будущим stale-state/slot-mutation сценарием.
- `campaignHeroIds` читает hero IDs из campaign-scoped membership, а
  `canUseHero` сравнивает actor с этим списком
  ([`index.mjs:466-482`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L466-L482));
  character lifecycle дополнительно требует membership-owned actor и реального
  `state.players` (`index.mjs:1402-1419`). Поэтому orphan membership после
  ответа `409` даёт доступ к комнате, но не превращает несуществующий actor в
  исполнимого героя.
- Найденный `HeroReplaced` меняет имя/HP существующего actor ID и не удаляет
  party slot ([`rules-engine.mjs:22861-22884`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L22861-L22884));
  отдельного HTTP удаления/reassignment slot в этом scope нет.

Рекомендуемая граница для будущего изменения: сначала в том же контракте
проверять выбранный hero против актуального versioned набора campaign slots, а
durable membership/redemption писать только после успешной проверки. Если появится
реальная операция удаления slot, нужен общий optimistic version/transaction
guard между этой операцией и redemption; одного последующего `partyIds` check
недостаточно.

## Direct store и HTTP positives

Профильные store-тесты уже проверяют scoped single-use invite, повтор того же
аккаунта, последовательную выдачу двух разных мест и пропуск готового creator seat
([`store-regression.test.mjs:84-157`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/store-regression.test.mjs#L84-L157)).
Character API test проходит полный `ImportCharacter` в назначенный slot с
replay/restart для серверных бросков; ownership и character lifecycle отдельно
проверяются в sanitization и Rules Engine.

Probe [`45-membership-lifecycle-probe.mjs`](./45-membership-lifecycle-probe.mjs)
запускает настоящий `server/index.mjs` на loopback, временном `DND_STORAGE_DIR`,
пустом dotenv и `ROUTERAI_API_KEY=''`. Сводка результата (поля сгруппированы):

```json
{
  "stale_simulation": {
    "join_status": 409,
    "persisted_orphan_hero_id": "missing-hero",
    "persisted_orphan_status": "active",
    "persisted_redemption_count": 1,
    "campaigns_after_restart_status": 200,
    "stale_room_after_restart_status": 200
  },
  "normal_http_flow": {
    "first_join": { "status": 200, "hero_ids": ["hero-1"] },
    "same_account_retry": { "status": 200, "duplicate": true },
    "second_account_last_slot": { "status": 200, "hero_ids": ["hero-2"] },
    "positive_room_after_restart": { "status": 200, "assigned_hero_ids": ["hero-1"] }
  }
}
```

`stale_simulation` не выдаётся штатным endpoint создания invite: это проверка
того, что при появлении удаления/дрейфа slot текущий порядок commit оставит
несогласованную связь. `normal_http_flow` — штатная положительная проверка
join, idempotent retry и последнего свободного места. После restart API
`/auth/me` дополнительно подтверждает membership на `hero-1`; простое наличие
героя в публичной карте комнаты само по себе не доказывало бы владение.
Выдача двум аккаунтам в этой пробе последовательная. Межпроцессная гонка двух
одновременных redemption здесь не воспроизводилась; роль файлового lock
прослежена отдельно по коду.

## Проверки

```text
node --test test/store-regression.test.mjs
8 passed, 0 failed

node --test test/character-creation-api.test.mjs
1 passed, 0 failed

node --test test/character-lifecycle-engine.test.mjs test/character-lifecycle.test.mjs test/security.test.mjs
47 passed, 0 failed

node docs/reviews/2026-10-04/round-11/45-membership-lifecycle-probe.mjs
stale simulation + normal HTTP flow: passed
```

Полный `pnpm verify`, реальное persistent storage и внешние сервисы в этом
bounded audit не запускались. Отдельный revoke API не предлагается и не
оценивается: его нет в текущей поверхности.
