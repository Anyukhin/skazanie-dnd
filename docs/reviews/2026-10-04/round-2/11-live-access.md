# Второй проход: живой доступ SSE, session и смена героя

**Срез:** `e1d927f5aa68dc9eca912b527cccf3974ba3e9e7` (4 октября 2026); ссылки на
исходный код ниже закреплены на этот SHA.
**Scope:** срок жизни SSE-соединения, logout/session expiry, live membership и
переназначение героя, приватность потоковой проекции. Runtime-код и штатные
тесты не менялись.

В репозитории нет отдельного `server/auth-store.mjs`: session, пользователи и
membership лежат в `server/store.mjs`. Это важно для чтения доказательств ниже:
каждый новый HTTP-запрос получает свежий public user через этот модуль, а SSE
после handshake хранит снимок пользователя в памяти процесса.

## Результат

Проблема с живым доступом подтверждена реальным HTTP-проходом на loopback:

```powershell
node docs/reviews/2026-10-04/round-2/live-access-probe.mjs
```

Проба поднимает отдельный Node-сервер на свободном порту, использует временный
`DND_STORAGE_DIR`, пустой `DOTENV_CONFIG_PATH` и `ROUTERAI_API_KEY=''`. Внешний
провайдер не вызывается. Получен следующий результат:

```json
{
  "logout": {
    "auth_me_user_after_logout": null,
    "stale_stream_received_room": true,
    "stale_stream_online_hero_ids": ["hero-1"]
  },
  "expiry": {
    "auth_me_user_after_expiry": null,
    "stale_stream_received_room": true,
    "stale_stream_online_hero_ids": ["hero-1"]
  },
  "hero_reassignment": {
    "auth_me_hero_ids_after_reassign": ["hero-2"],
    "fresh_projection_private_origin": null,
    "stale_stream_private_origin": "stolen",
    "stale_stream_online_hero_ids": ["hero-1"]
  }
}
```

Это не нагрузочная проба и не изменение продукта. Она проверяет только один
процесс, три независимых временных кампании и следующий кадр `room` после
административного коммита.

## LIVE-01 — P1: logout и истечение session не отзывают уже открытый SSE

**Доказательство.** При открытии потока сервер делает `requireUser` и проверяет
ACL комнаты только один раз: [handshake `/stream`](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3678-L3684).
Затем в объект connection кладутся `user`, `userId`, `heroIds` и `actorId`:
[снимок контекста соединения](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3692-L3709). После
этого поток удаляется из реестра только по `req.close`/`req.aborted`:
[lifecycle закрытия](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3716-L3729). Heartbeat пишет
в response без auth-проверки [здесь](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3713-L3715), а
снимок комнаты для каждого соединения строится из сохранённого
`connection.user` [здесь](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2421-L2443).

`POST /api/auth/logout` удаляет session и очищает cookie, но не обращается к
`campaignStreams`: [logout route](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3496-L3499).
Для последующих HTTP-запросов session действительно исчезает: `userForToken`
читает session из auth-файла и возвращает `null`, если записи нет:
[store lookup](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/store.mjs#L42-L49),
[userForToken](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/store.mjs#L163-L169). Это и проверено пробой:
`auth/me` после logout вернул `user: null`, затем тот же открытый поток получил
новый `room` кадр. Тот же результат получен после записи прошедшего
`expiresAt`; это закрывает именно expiry, а не только явный logout.

**Воздействие.** Внешний или истёкший session продолжает получать новые
состояния комнаты, боевые сообщения и потоковую narration: реестр narration
передаёт broadcast всем `streamConnections` [на входе сервера](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L246-L255)
и [в модуле потока](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/narration-stream.mjs#L103-L105). Это
продолжается, пока TCP-соединение не закроется само. Одновременно сервер считает
такой connection живым для presence. Обычный logout в той же вкладке сейчас частично маскируется клиентом:
`useAuth.logout` сбрасывает account, после чего `GameApp` размонтирует
`useGameSession`; это не защита от logout в другой вкладке, административного
отзыва, истечения session или зависшего клиента.

**Минимальное исправление.** Нужен server-owned lifecycle access, а не только
проверка на handshake:

1. Хранить в connection непрозрачный идентификатор конкретной session — её
   `tokenHash` или отдельный `sessionId`, но никогда raw cookie — и индексировать
   потоки по этому ключу. Logout должен закрывать только connections этой
   отозванной session; другой активный login того же пользователя нельзя
   аннулировать побочным эффектом.
2. На heartbeat и перед каждым broadcast повторно проверять, что конкретная
   session жива и ACL кампании всё ещё разрешает чтение. Истечение session должно
   закрывать только её connections. Проверку можно кэшировать на короткий
   bounded interval, но нельзя навсегда полагаться на snapshot.
3. При смене роли, membership или assignment применять отдельный access epoch
   и закрывать затронутые campaign connections пользователя; это уже user/access
   change, а не logout одной session.
4. На клиенте считать `access.revoked` терминальным состоянием: закрывать
   `EventSource`, останавливать reconnect и обновлять `/api/auth/me`.

**Регрессии.** В изолированном HTTP-тесте должны быть отдельные проверки:

- открыть SSE, выполнить logout, дождаться следующего коммита от второго
  аккаунта и убедиться, что поток закрыт и новый `room`/`narration` кадр не
  приходит;
- открыть SSE, истечь session в изолированном auth store, повторить коммит и
  получить тот же отказ;
- убедиться, что `connected_users`, `online_hero_ids` и typing исчезают после
  отзыва доступа.

## LIVE-02 — P1: переназначение героя оставляет старый actor/privacy snapshot

**Доказательство.** Административный PATCH меняет `user.heroIds` и сохраняет
его, но не трогает открытые streams: [updateUserAccess](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/store.mjs#L180-L197).
Новый HTTP-запрос после этого строит actor из актуального `campaignHeroIds`
([выбор героя](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L466-L482)) и проверяет доступ по
текущему user/room [здесь](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2154-L2165). Живой SSE
использует старые `connection.user` и `connection.actorId`:
[projection broadcast](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2427-L2443).

Проба создала legacy-кампанию с двумя героями, открыла поток для аккаунта с
`hero-1`, затем через реальный admin HTTP route назначила аккаунту `hero-2`.
`auth/me` уже вернул `heroIds: ["hero-2"]`. Свежая `/api/rooms` проекция скрыла
`origin: "stolen"` у прежнего `hero-1`, потому что этот герой больше не был
собственным. В следующий `room` кадр старого потока приехало то же private
поле `origin: "stolen"`. Это различие следует из серверного правила: чужое
stolen-происхождение удаляется, своё остаётся [в projection](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/viewer-projection.mjs#L1590-L1615).
Проба использует заранее записанную в fixture строку `stolen`: она доказывает
расхождение политики доступа и старого actor snapshot, но не утверждает, что
после reassign был создан или впервые раскрыт новый секрет.

**Воздействие.** Владелец нового места получает в живом канале данные,
разрешённые прежнему actor, и продолжает числиться online за старым героем.
Командный HTTP-путь не становится от этого авторитетным обходом: после
переназначения он снова читает свежий user и должен отклонить команду за
`hero-1`. Утечка относится к уже открытому read-stream и приватной проекции,
что достаточно для отдельного security finding.

Проба использует текущий legacy-путь `user.heroIds`, потому что для explicit
campaign membership сейчас нет HTTP-операции переназначения/отзыва. В
`store.mjs` уже есть фильтр `status !== 'revoked'`, но он не меняет живой
connection snapshot. Поэтому для будущего endpoint revoke действуют те же
требования, однако проба не заявляет, что такого endpoint уже существует.

**Минимальное исправление.** В connection нужен versioned access context:

- при изменении hero assignment или membership увеличивать auth/access epoch;
- передавать epoch и actor assignment в connection и закрывать поток при
  несовпадении;
- если политика продукта допускает мягкое обновление вместо закрытия, сначала
  отправлять новую полную разрешённую проекцию с `actorId: hero-2`, сбрасывать
  `mapHash` и только потом возобновлять дельты;
- пересчитывать presence по актуальному assignment, а не по старому
  `connection.heroIds`.

Для этого finding не требуется вводить общий permission framework: достаточно
узкого lifecycle-helper для session key и access epoch поверх уже существующих
`canAccessRoom`/`canUseHero`. Авторитетные проверки команд должны остаться на
своих HTTP-маршрутах.

**Регрессии.** После `hero-1 → hero-2` тест должен одновременно подтвердить:

- свежий GET видит только политику `hero-2`;
- старый поток либо закрыт/помечен `access.changed`, либо не содержит private
  поля `hero-1` и присылает полную проекцию нового actor;
- `online_hero_ids` больше не содержит `hero-1` для этого аккаунта.

## Следствие для party decision

Presence — не только косметика. [connectedHeroIdsForCampaign](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2203-L2211)
берёт героев из всех объектов connection, включая отозванные snapshots.
`stateWithLivePresence` затем ставит им `online: true` и публикует их в
`online_hero_ids` [здесь](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L2367-L2390). При открытии
решения отряда тот же набор используется для выбора eligible voters:
[voter snapshot](https://github.com/Anyukhin/skazanie-dnd/blob/e1d927f5aa68dc9eca912b527cccf3974ba3e9e7/server/index.mjs#L3158-L3166). Поэтому LIVE-01
может не только показывать устаревшую presence, но и удерживать вышедшего героя
в списке ожидаемых голосов. HTTP-проба подтверждает первый шаг (`hero-1`
остаётся online после logout/expiry); end-to-end голосование в этот bounded
probe намеренно не добавлялось, поэтому влияние на срок конкретного решения
нужно закрыть отдельным тестом.

## Гарантии и ограничения

- Все три сценария выполнялись на настоящем `server/index.mjs` через HTTP и
  loopback; использовались временные файлы и отдельные свободные порты.
- `ROUTERAI_API_KEY` был явно пустым, `DOTENV_CONFIG_PATH` указывал на созданный
  пустой файл; LLM и рабочие `.env`/`storage/` не использовались.
- Проба не меняет runtime и штатный `test/`; она сама завершается после
  `child` exit и удаляет свой временный каталог при штатном запуске.
- Это не production load test и не проверка нескольких Node writers, браузерного
  reconnect или power-loss. SSE backpressure уже описан в первом проходе и здесь
  повторно не оценивался.
- Для explicit membership revoke проверен только статический контракт: текущего
  HTTP endpoint для такой операции нет. Подтверждены реальные logout, expiry и
  legacy hero reassignment — именно те access changes, которые уже доступны
  текущему HTTP API. `expiry` — контролируемая инъекция прошедшего `expiresAt`
  только во временный auth-файл пробника; это не подмена системных часов и не
  тест power-loss.
