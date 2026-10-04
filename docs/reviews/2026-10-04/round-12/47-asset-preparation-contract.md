# Раунд 12 — подготовка ассетов и контракт генерации

Проверен фиксированный `HEAD 737784b1cc76cf2b2fab15216755617f914bb1d0` в worktree
`C:\Users\anton\.codex\worktrees\project-review-2026-10-04\Dnd` (родительский
аудит указывает baseline `cb045a8466f35696ff24abe9020d6f39dee89462`).
Это только аудит: runtime, `data/`, `.env`, настоящие сохранения и зависимости
не изменялись; реальные provider/LLM вызовы не выполнялись.

## Что проверено

`server/asset-preparation.mjs` держит общий потолок `20`, схлопывает дубли,
проверяет неизвестные id, пропускает готовое без `regenerate` и возвращает
готовое обратно при явном `regenerate`. `server/index.mjs` требует сессию и
разрешает подготовку администратору или владельцу кампании; участник получает
`403`. Генерация выполняется последовательно, а отдельный элемент ошибки не
прерывает остальные элементы пачки.

Успешный focused прогон:

```text
node --test test/asset-preparation.test.mjs test/location-illustrations-api.test.mjs test/npc-portraits-api.test.mjs test/enemy-portrait-tool.test.mjs
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

Тесты покрывают выключенный runtime-флаг, кеш, usage-леджер, пропуск готового,
перегенерацию, общий cap, HTTP `401/403`, видимость, ETag и отсутствие вызова
модели в игровом пути. Владелец кампании отдельно в HTTP тесте не создаётся;
эта ветка разрешения пока подтверждена чтением `canManageCampaignAssets`, но не
исполняемым positive-тестом.

Список подготовки строится из `viewerStateFor` с административной ролью,
после чего применяются `publicNpcPortraitProfile` и `visibleCampaignLocations`.
Это отдельный контракт управляющего инвентаря. Проверки скрытых сущностей в
обычных image GET не доказывают границы этого списка для владельца кампании.
Утечка через него здесь не воспроизводилась; перед изменением прав подготовки
нужен отдельный owner-сценарий и явный выбор доступных ему сведений
([построение списка](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3591-L3614)).

## Статические/direct находки

### AP-01 — [P2] envelope ответа провайдера не ограничен до `response.json()`

В `server/image-generation.mjs:83-108` проверяется только `encoded.length` уже
после `await response.json()` (`:101`). Поэтому envelope может быть больше
лимита декодированного изображения, даже если сам `b64_json` мал: тело сначала
материализуется в памяти, а лимит 8 MiB применяется лишь к декодированным
байтам. Это статический ресурсный риск; стресс/OOM воспроизведением не
проверялся. `Content-Length` не проверяется, поток не читается ограниченным
reader-ом.

Источник: [server/image-generation.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L83-L108](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/image-generation.mjs#L83-L108).

Предложение владельцу существующего image-generation клиента: ограничить тело
ответа до небольшого envelope budget (с запасом над лимитом base64), отклонять
известный превышенный `Content-Length` и прекращать чтение при превышении; затем
разбирать JSON. Это не требует нового сервиса или очереди.

### AP-02 — [P2] сигнатура не гарантирует декодируемое изображение

`isWebp` (`server/image-generation.mjs:22-26`) принимает любой буфер длиной
12 байт с `RIFF....WEBP`; `isPng` (`:32-35`) проверяет только PNG signature.
Размер и сигнатура отсекают HTML/JSON, но не проверяют полную структуру формата.
Probe подтверждает только принятие signature-only буфера; он не доказывает
валидность декодирования или рендеринга.
Дополнительно `NpcPortraitService.generateAndCache` (`server/npc-portraits.mjs:443-458`)
вызывает `usageLedger.settle` на строке `455` до собственной проверки байтов на
`456-458`; при injected/custom generator artifact может не записаться, хотя
provider usage уже отмечен как completed. Location service валидирует артефакт до
settle (`location-illustrations.mjs:323-342`).

Источники: [server/image-generation.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L22-L40](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/image-generation.mjs#L22-L40), [server/npc-portraits.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L443-L458](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-portraits.mjs#L443-L458), [server/location-illustrations.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L323-L342](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/location-illustrations.mjs#L323-L342).

Локальный probe с synthetic 12-byte stub действительно получил
`magicOnlyAccepted: true` и `cached: true`. Узкий ремонт: общий validator должен
проверять минимальную структуру выбранного формата (или декодировать в
поддерживаемом библиотекой пути). При этом usage провайдера нельзя стирать или
откладывать до `rename`: модель уже отработала и могла быть оплачена. `settle`
сам по себе не доказывает готовность файла; её уже показывают inventory и
per-item `prepared` status. Если потребуется долговечная история результата,
её следует хранить отдельно от известного provider usage, а не переносить
учёт расхода за успешную запись. Это дополняет существующий
[разбор usage/COST-01](../round-2/15-llm-accounting.md), а не объявляет ещё одну
доказанную двойную оплату или требует новых полей ledger без потребителя.

### AP-03 — [P2] не определён concurrency/retry contract для явных `prepare`

`NpcPortraitService.resolve` использует `this.inflight` (`server/npc-portraits.mjs:391-406`),
но `prepare` напрямую вызывает `generateAndCache` (`:421-424`); у
`LocationIllustrationService.prepare` аналогичного lock нет. HTTP маршрут
`server/index.mjs:3632-3655` сериализует только элементы **одного** POST. Два
одновременных вызова `prepare` запускают один и тот же id дважды, а последний
`rename` молча побеждает. Это не доказывает двойную оплату одного намерения:
текущий `prepare` намеренно означает новую генерацию, probe делает два явных
вызова сервиса без HTTP и без ledger. Это выбор контракта concurrency/retry,
а не подтверждённый P1 дефект.

Источники: [server/npc-portraits.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L391-L424](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/npc-portraits.mjs#L391-L424), [server/location-illustrations.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L302-L342](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/location-illustrations.mjs#L302-L342), [server/index.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L3632-L3655](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3632-L3655).

Повторяемый temp probe дал `concurrentPrepareCalls: 2` для двух одновременных
явных вызовов одного NPC. Если продукт хочет схлопывать повтор клика/retry,
нужен общий key намерения и keyed in-flight guard в существующих сервисах;
явный `regenerate` при этом не следует подавлять без отдельной политики. Новый
queue framework для этого не нужен. Не дублировать этот пункт с отдельным
аудитом ownership/inflight кэша.

### AP-04 — контрактная особенность cap, не подтверждённый дефект

В `server/asset-preparation.mjs:123-130` `total` увеличивается до фильтра
`selected` (`:126`). Поэтому 20 уже готовых id плюс один отсутствующий дают
`BATCH_TOO_LARGE`, хотя реальная работа — одна генерация; запрос из 20 готовых
проходит с пустым `prepared: []`. Это соответствует текущему контракту «cap
пользовательского списка за запуск», а не доказанной ошибке лимита расходов.
Probe дал `readyPlusPending: "BATCH_TOO_LARGE"`.

Источник: [server/asset-preparation.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L115-L142](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/asset-preparation.mjs#L115-L142).

Если требования изменятся и cap должен ограничивать именно оплачиваемые
генерации, UX можно пересмотреть отдельно: считать после skip-ready и явно
показывать, что запрос содержит только готовые позиции. Нового кода или нового
`REQUEST_SIZE` кода для текущего контракта не требуется.

## HTTP/операционный контракт

### AP-05 — [P3] нет live progress или durable receipt для пачки

`POST /api/campaigns/:id/asset-preparation` (`server/index.mjs:3628-3655`)
остаётся открытым на весь последовательный цикл. Пер-item partial report уже
есть: ответ содержит `prepared[]` со `status: ready|failed`; `GET` inventory
после обрыва показывает текущую готовность. Но нет live progress, `run_id`,
started/completed counters, poll endpoint или durable receipt. Это gap
операционного UX, а не доказанный таймаут/зависание.

Источник: [server/index.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L3628-L3657](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3628-L3657).

Существующий итоговый report можно дополнить `processed/total` и стабильными
error codes. Для проверки текущей готовности использовать GET inventory,
а не повторный POST: пока исход предыдущей генерации неизвестен, такой повтор
может начать ещё одну операцию. Готовый старый файл также не доказывает
завершение текущей перегенерации. Если нужен progress именно одного запуска,
сначала определить его идентичность и небольшой campaign-scoped run/receipt
контракт. Idempotency должен предотвращать повторный provider call, а не
только повторную запись расхода в ledger; граница последнего уже разобрана в
[COST-02](../round-2/15-llm-accounting.md). Новый общий queue framework из этого
не следует.

### AP-06 — [P3] partial failure возвращает внутренний `error.message`

На `server/index.mjs:3641-3652` в JSON уходит `error.message` каждого
исключения. Сейчас штатный provider-клиент в основном формирует общие сообщения;
утечка секрета или filesystem path этим аудитом не доказана. Но ошибки usage
ledger, файловой системы и будущих adapters могут включать детали реализации.

Источник: [server/index.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L3638-L3655](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3638-L3655).

Hardening: публичный ответ должен выдавать стабильный error code, а подробности
оставлять в серверном журнале без ключей/секретов. Новые зависимости не нужны.

## Положительное и граница

Права HTTP проверяются до построения списка ([server/index.mjs@cb045a8466f35696ff24abe9020d6f39dee89462#L3591-L3596](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3591-L3596)),
unknown ids не доходят до генератора, подготовка игнорирует runtime-флаг как и
заявлено контрактом, генерация провайдера через injected stub не требует сети,
а готовый кеш выдаётся с ETag и приватной ревалидацией. Путь предметов и
известная находка о raw item provider usage (`COST01`, `doc15`) в этот отчёт
намеренно не переименовываются и не дублируются.

## Повторяемый probe

```text
node docs/reviews/2026-10-04/round-12/47-asset-preparation-probe.mjs
{"readyPlusPending":"BATCH_TOO_LARGE","concurrentPrepareCalls":2,"magicOnlyAccepted":true}
```

Probe использует только `mkdtemp`/`rm` и injected generator; дочерних серверов,
внешней сети, ключей и реального `storage/` нет.
