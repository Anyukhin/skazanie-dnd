# Раунд 10, границы импорта TaleSpire

Дата аудита: 2026-10-04. Проверен runtime commit
`cb045a8466f35696ff24abe9020d6f39dee89462`; audit head
`ecf5069283e4665731caef4f08a41256d177de60`. Изменены только этот отчёт и
изолированная проба; runtime, `data/`, `storage/`, `.env`, зависимости и LLM
не затрагивались.

## Вывод

Основные синтаксические границы уже закрыты: текст ограничен 48 KiB, сжатый
слэб — 30 KiB, `gunzipSync` получает предел распаковки 4 MiB, заголовок и
каждый layout проверяются на достаточное число байтов, v1 отбрасывает
`NaN`/`Infinity`, а v2 кодирует координаты конечными 18-битными полями.
Маршрут проверяет пользователя и членство владельца **до** чтения тела и до
разбора слэба; общий `/commands` не может подделать capability
`mapImportAuthorized`.

Найдены две границы, которые не закрыты до начала тяжёлой геометрии, и один
malformed-body gap:

| ID | Приоритет | Граница |
| --- | --- | --- |
| MAP-BOUNDARY-01 | P2 | Нет отдельного лимита числа экземпляров и бюджета CPU до материализации и обхода геометрии; итоговый `SIZE_CLASSES` ограничивает карту, но не промежуточную работу импортёра |
| MAP-BOUNDARY-02 | P2 | v1 принимает любые конечные размеры коробки; `coveredCells` может начать огромный целочисленный обход до проверки размера карты |
| MAP-BOUNDARY-03 | P1 | Реальный HTTP JSON `null` от владельца своей кампании приводит к необработанному `TypeError` и завершению общего процесса вместо контролируемого 400 |

Все три наблюдения относятся к аутентифицированному owner/admin входу.
Участник чужой кампании без прав владельца получает 403 до `readBody`, и
команда `ImportLocationMap` в Rules Engine требует серверный флаг. При этом
владелец — роль в кампании: HTTP probe регистрирует обычный аккаунт и создаёт
свою кампанию, глобальные права администратора ему не нужны.

## MAP-BOUNDARY-01 — предел распаковки есть, но нет source-instance budget (P2)

`decodeSlab` ограничивает packed/text и распаковку, однако `layoutCount` и
`count` читаются из 16-битных полей, после чего каждый экземпляр добавляется в
массив `instances`. В худшем допустимом распакованном буфере это всё ещё сотни
тысяч v2 экземпляров или десятки/сотни тысяч v1 экземпляров. Предел 4 MiB
ограничивает память буфера и косвенно число записей, но не задаёт отдельного
практического бюджета JS-объектов, `WorldBox` и списков поверхностей.

`importTaleSpireSlab` сначала строит `boxes`, затем для каждого пола вызывает
`coveredCells`. Только после этих обходов рассчитываются `spanX/spanZ` и
выбирается класс карты. Лимиты класса ограничивают ширину, высоту, props и
wall edges конечной карты; они не ограничивают число source instances,
стоимость `coveredCells`, сортировки и повторные посещения поверхностей.
Компрессия позволяет упаковать повторяющийся malformed payload значительно
меньше 30 KiB, поэтому packed-size check не является таким бюджетом.

Рекомендация: ввести независимые константы `MAX_LAYOUTS`, `MAX_INSTANCES` и
лимит source boxes/footprints, считать количество до создания массива и
отклонять слэб до `worldBoxesForSlab`; для v1 проверять безопасные числовые
границы и площадь footprint до `coveredCells`. Повторяемость дорогих preview
следует сначала измерить; отдельный owner/admin rate или concurrency budget —
последующий вариант защиты, если метрика покажет необходимость. Исправление
должно оставаться в существующем парсере/маршруте, не в UI.

## MAP-BOUNDARY-02 — finite не означает bounded (P2)

v1 проверяет только `Number.isFinite` шести float32 значений. Значение вроде
`1e30` проходит эту проверку и становится координатой `WorldBox`; v2 такой
ветки не имеет, потому что его координаты извлекаются из 18-битных полей.
Само принятие большого абсолютного смещения доски не обязательно является
дефектом: безопасная проверка должна ограничивать арифметику и footprint, а не
искусственно привязывать начало координат к размеру карты. Опаснее большой
конечный `extent`: `coveredCells` итерирует от
`floor(minX)` до `ceil(maxX)` и аналогично по Z **до** проверки итогового
размера карты. Предел `TALESPIRE_MAP_TOO_LARGE` на строках 372–376 поэтому не
защищает от огромного source footprint, если работа уже потрачена на его обход.

Проба намеренно использует маленькие fixtures: v1 с конечным `center.x = 1e30`
успешно декодируется, а коробка с `extent = 100000` материализуется через
`worldBoxesForSlab`; `coveredCells` для неё не вызывается. Это разделяет
доказательство принятия входа от гипотезы о дорогом обходе. Нужны безопасные
числовые границы для суммы/разности и ранняя проверка footprint/span до
вычисления `WorldBox` и `coveredCells`; абсолютное смещение центра следует
разрешать, если оно не делает коробку или её арифметику небезопасной. Ошибка
должна быть отдельным контролируемым кодом,
а не `RangeError`, зависанием или необработанным исключением.

## MAP-BOUNDARY-03 — `null` body завершает серверный процесс (P1)

После успешной проверки owner/admin маршрут делает `body.mode` сразу после
`await readBody(req)`. `readBody` корректно принимает JSON `null`, но обращение
к `body.mode` бросает `TypeError`; catch маршрута повторно бросает неизвестную
ошибку вместо ответа 400. Отдельный реальный HTTP probe с временным сервером
получил от клиента `TypeError` без HTTP-статуса, а дочерний `server/index.mjs`
завершился с exit code 1; stderr указывает на `map-import-routes.mjs:71`.
Проверка членства уже произошла, но malformed request владельца своей кампании
завершает общий процесс. Поэтому приоритет выше обычной ошибки валидации:
граница воздействия — доступность сервера, а не только одна карта. Повреждение
сохранений или поведение production supervisor этой пробой не проверялись.

Первый небольшой PR: до чтения полей проверять `body && typeof body === 'object'
&& !Array.isArray(body)` и при отказе возвращать стабильный
`INVALID_JSON_BODY`/400. Отдельно замкнуть верхнюю async-границу HTTP: unexpected
rejection должен регистрироваться без секретов и завершать запрос управляемым
500, если заголовки ещё не отправлены; если ответ уже начат, закрыть его
корректно. Простое подавление process-level `unhandledRejection` не исправляет
жизненный цикл ответа. Проверить, что после null-запроса health и запрос другой
кампании продолжают работать. Это транспортная защита, не новый формат слэба.

## Что проверено

Проба [`40-map-import-probe.mjs`](./40-map-import-probe.mjs) использует только
короткие синтетические буферы и реальную таблицу ассетов. Она подтверждает
отказы за encoded-size, bad gzip и truncation, принимает finite-v1 fixture с
`1e30`, материализует большую коробку только до `worldBoxesForSlab`, подтверждает,
что 403 owner check выполняется до `readBody` для обычного player, и проверяет
реальный HTTP JSON `null`. Она не строит 4-MiB payload, не запускает
OOM/huge-coordinate stress и не утверждает время полного `coveredCells` обхода.

Запуски:

```text
node --test test/talespire-import.test.mjs test/map-import-command.test.mjs test/map-import-api.test.mjs
21 passed, 0 failed

node docs/reviews/2026-10-04/round-10/40-map-import-probe.mjs
```

Probe для JSON `null` сообщает `http.status: null`, `http.error: "TypeError"`,
`child_exit_code: 1`; этот результат получен на отдельном дочернем сервере с
временным `DND_STORAGE_DIR`, пустым dotenv и пустым `ROUTERAI_API_KEY`, после
чего каталог удалён. Версия Node включена в результат; произвольные логи
дочернего сервера не печатаются.

Существующие тесты дополнительно подтверждают preview/apply/idempotency,
ownership и запрет обходного `/commands`. Полный `pnpm verify` не запускался.

## Источники на pinned commit

- [`server/talespire-slab.mjs#L108-L171`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/talespire-slab.mjs#L108-L171) — text/packed/decompression bounds, header/count parsing и v1 finite check.
- [`server/talespire-import.mjs#L170-L249`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/talespire-import.mjs#L170-L249) — материализация boxes и unbounded `coveredCells` loops.
- [`server/talespire-import.mjs#L323-L386`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/talespire-import.mjs#L323-L386) — порядок дорогой геометрии перед map span/class check.
- [`server/tactical-map.mjs#L63-L67`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/tactical-map.mjs#L63-L67) — конечные class limits.
- [`server/routes/map-import-routes.mjs#L57-L127`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/routes/map-import-routes.mjs#L57-L127) — auth-before-body, preview path и `body.mode` boundary.
- [`server/routes/map-import-routes.mjs#L174-L185`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/routes/map-import-routes.mjs#L174-L185) — неизвестные ошибки rethrow.
- [`server/index.mjs#L3416-L3424`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3416-L3424) и [`server/index.mjs#L3452-L3457`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3452-L3457) — async createServer callback и вызов map-import без отдельного catch для необработанной ошибки.
- [`server/rules-engine.mjs#L4441-L4445`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L4441-L4445) — command slab boundary.
- [`server/rules-engine.mjs#L6169-L6189`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L6169-L6189) — capability and combat/location authorization.
- [`server/index.mjs#L2588-L2596`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L2588-L2596) — global 1,000,000-character body cap.
- [`test/talespire-import.test.mjs#L58-L81`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/talespire-import.test.mjs#L58-L81) — malformed slab regressions.
- [`test/map-import-api.test.mjs#L89-L124`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/map-import-api.test.mjs#L89-L124) — HTTP ownership, preview and apply path.
