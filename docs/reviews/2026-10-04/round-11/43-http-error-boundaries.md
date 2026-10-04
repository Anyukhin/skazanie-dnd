# Раунд 11: HTTP async error boundaries

Дата аудита: 2026-10-04. Проверен runtime commit
`cb045a8466f35696ff24abe9020d6f39dee89462`; audit head на старте
`873c946df44b716c40a74d395471e33ddb1ef1c2`. Изменены только этот отчёт и
изолированная probe; runtime, `data/`, `storage/`, `.env` и зависимости не
затрагивались.

## Вывод

Подтверждённая в раунде 10 ошибка `POST /api/campaigns/:id/map-import` с
JSON `null` не локальна для импорта карт. Follow-up подтвердил ещё две
доступные ветки с разными границами прав: unauthenticated `POST
/api/auth/login` с валидным JSON `null` и `PUT
/api/campaigns/:id/presence/typing` от реально присоединённого non-owner
игрока. Во всех случаях общий корень один: callback `createServer` возвращает
Promise без верхнего rejection boundary, а synchronous preamble до
`runWithCampaignAiSettings` также находится вне защиты.

Три наблюдения не являются тремя независимыми транспортными реализациями:
это три входа, которые показывают, что одна общая boundary отсутствует. Их
права и фактические доказательства различаются:

| ID | Приоритет | Реальная поверхность | Доказательство |
| --- | --- | --- | --- |
| HTTP-BOUNDARY-01 | P1 | Любой unauthenticated клиент: `POST /api/auth/login` с валидным JSON `null` | свежий реальный HTTP probe, exit code 1 |
| HTTP-BOUNDARY-02 | P1 | Реально присоединённый non-owner player: `PUT .../presence/typing` с `null` | свежий реальный HTTP probe, member role `player`, exit code 1 |
| MAP-BOUNDARY-03 | P1 | Ведущий своей кампании или admin: `POST .../map-import` с `null` | baseline из round 10, повторён в общей probe |

`MAP-BOUNDARY-03` здесь не дублируется как новый дефект: он нужен как
контроль общей boundary и сравнение с новыми поверхностями login и presence.

## HTTP-BOUNDARY-01 — valid JSON null в login (P1)

Маршрут login намеренно доступен без auth. Для malformed JSON он делает
`readBody(req).catch(() => ({}))`, поэтому `{` возвращает контролируемый 401.
Но валидное JSON `null` не бросает исключение: `readBody` возвращает `null`,
после чего `body.email` на следующей строке вызывает `TypeError` до проверки
учётных данных. Реальный loopback probe получил от клиента `TypeError` без
HTTP-статуса, а child завершился с кодом 1.

`[]` остаётся контролируемым 401, поэтому это shape boundary для конкретного
`null`, а не утверждение о любом не-объектном JSON.

## HTTP-BOUNDARY-02 — необработанное тело в presence typing (P1)

Маршрут проверяет пользователя, существование кампании и доступ к комнате,
после чего выполняет `await readBody(req)` и сразу обращается к
`body.actor_id`. Для реально зарегистрированного второго пользователя,
присоединившегося по приглашению к свободному `hero-2`, запрос с телом
`null` доходит до этой строки и бросает `TypeError`. Предпосылка владения
героем не нужна: падение происходит до `canUseHero`; probe подтверждает именно
роль `player` и доступ к комнате. Тот же участник с телом `[]` получает
контролируемый 403, что разделяет shape-control и null crash.

Симптом в реальном HTTP: `fetch` получает `TypeError` без статуса, дочерний
сервер завершается с exit code 1. Это не только некорректный ответ одной
комнаты: process-wide HTTP listener больше не принимает запросы. Доступ к
маршруту подтверждён обычным зарегистрированным non-owner player, без
admin-полномочий и без LLM key.

Рекомендация: малый общий boundary должен начинаться до синхронного preamble
(`new URL`, извлечение campaign settings) и охватывать весь async dispatch:
например, превратить весь callback в одну async operation и повесить один
`.catch`, не оставляя синхронную часть до `runWithCampaignAiSettings` снаружи.
Он должен переводить только ещё не начавшиеся ответы в стабильный 500, а
ошибку логировать безопасно (код/тип, без тела запроса, cookies, токенов,
сырого stack trace и текста, который может содержать секреты). Известные
ошибки должны продолжить использовать существующие явные классы/`status`
mapping маршрутов; случайный `error.code` нельзя автоматически считать
клиентской ошибкой и превращать в 400. Если `res.headersSent` или
`res.writableEnded`, boundary не должен второй раз вызывать `json`: для SSE
уже отправленный поток нужно закрыть/abort существующим владельцем транспорта.
Это транспортная страховка, а не повод переносить правила из маршрутов в
новый framework.

## Что фактически проверено

Изолированная probe
[`43-http-error-probe.mjs`](./43-http-error-probe.mjs) для каждого опасного
случая поднимает отдельный дочерний `server/index.mjs`, loopback-порт и
временный `DND_STORAGE_DIR`. В окружение переданы пустые
`ROUTERAI_API_KEY`/dotenv; значения секретов в output и в отчёт не попадают.

Положительные controls в том же запуске:

- register — HTTP 201;
- login — HTTP 200;
- malformed JSON register — HTTP 400, процесс жив;
- malformed JSON login — HTTP 401, процесс жив;
- JSON-массив login — HTTP 401, процесс жив;
- unauthenticated `map-import` с `null` — HTTP 401 до `readBody`, процесс жив.

Опасные cases:

- unauthenticated `POST /api/auth/login` с валидным JSON `null`: `status: null`,
  client `TypeError`, child exit code 1;
- owner `POST /api/campaigns/BOUNDARY/map-import` с `null`: `status: null`,
  client `TypeError`, child exit code 1;
- присоединённый non-owner player `PUT /api/campaigns/BOUNDARY/presence/typing`
  с `[]`: HTTP 403, процесс жив; с `null`: `status: null`, client
  `TypeError`, child exit code 1.

Probe сообщает только node version, статусы, тип ошибки и exit code; сырые
stdout/stderr дочерних процессов не печатает.

Запуск:

```text
node docs/reviews/2026-10-04/round-11/43-http-error-probe.mjs
```

Фактический результат: Node `v24.19.0`; controls `201/200/400/401/401/401`,
login-null, map-import-null и typing-null получили `status: null`,
`error: TypeError`, `child_exit_code: 1`; typing-array получил 403.

## Actual HTTP и static-only границы

Actual HTTP evidence выше покрывает три ветки, где конкретная форма body
достигает строки и приводит к процессному exit. Статически тот же верхний
callback не ждёт возвращённый Promise: `runWithCampaignAiSettings(..., async
() => ...)` замыкает весь dispatch, но у `createServer` нет общего rejection
handler; синхронные исключения в вычислении URL/settings происходят ещё до
этого вызова. Поэтому маршруты `GET /api/campaigns/:id/stream` и `GET
/api/rooms/:id`, где `reconcileCampaignProjection` вызывается без локального
`try/catch`, также заслуживают покрытия общей boundary при сбое persistence,
но probe не подменяла storage и не объявляет это отдельным подтверждённым
HTTP finding. Их проблема — fault injection/storage failure, а не
доказанный malformed request.

Не проверялись malformed huge bodies, stress, OOM, live production, гонки
SSE или повреждение сохранений. `readBody` уже ограничивает тело одним
миллионом символов; этот аудит не меняет тот предел.

## Источники на pinned runtime commit

- [`server/index.mjs#L3416-L3424`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3416-L3424) — async HTTP callback без верхнего rejection boundary.
- [`server/index.mjs#L3490-L3495`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3490-L3495) — malformed JSON fallback в login, но valid `null` проходит до `body.email`.
- [`server/index.mjs#L3660-L3680`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3660-L3680) — presence typing: auth/access до body, затем unguarded `readBody` и `body.actor_id`.
- [`server/index.mjs#L2588-L2597`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L2588-L2597) — JSON parser и request-size limit.
- [`server/index.mjs#L425-L440`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L425-L440) — существующий JSON response owner.
- [`server/routes/map-import-routes.mjs#L57-L71`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/routes/map-import-routes.mjs#L57-L71) и [`#L177-L185`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/routes/map-import-routes.mjs#L177-L185) — baseline map-import auth/body path и rethrow неизвестной ошибки.
- [`docs/reviews/2026-10-04/round-10/40-map-import-boundaries.md`](../round-10/40-map-import-boundaries.md) — исходное доказательство MAP-BOUNDARY-03.
