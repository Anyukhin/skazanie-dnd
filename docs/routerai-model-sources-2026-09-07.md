# RouterAI: источники каталога и shortlist моделей для рассказчика

Дата проверки: **2026-09-07** (Europe/Moscow).

Это исследование только официальных материалов RouterAI. Платные вызовы к
моделям не выполнялись; качество русского D&D-повествования, задержка,
надёжность и фактический формат ответа должны быть проверены отдельным live
eval. Рабочий снимок публичного каталога: [`eval/routerai-catalog-2026-09-07.json`](../eval/routerai-catalog-2026-09-07.json),
`retrieved_at = 2026-09-07T20:52:45.797Z`, 491 запись.

## Что подтверждено про RouterAI

- Базовый URL API — `https://routerai.ru/api/v1`; RouterAI заявляет совместимость
  с OpenAI API и показывает вызов `/chat/completions` в официальном quickstart:
  [quickstart](https://routerai.ru/docs/guides/overview/quickstart).
- Публичный каталог моделей доступен без ключа через
  [`GET /api/v1/models`](https://routerai.ru/api/v1/models). Для проверки
  конкретного провайдера RouterAI документирует
  [`GET /api/v1/models/{author}/{slug}/endpoints`](https://routerai.ru/docs/guides/overview/provider-selection).
- В документации выбора провайдера поле `pricing` определено как **цены в
  рублях за токен** (либо за соответствующую единицу для изображений, секунд и
  т. п.). Поэтому значение `pricing.prompt = 0.000008822...` означает
  `8.822... ₽ / 1M` входных токенов. Точные цены зависят от фактического
  провайдера, а стандартная маршрутизация предпочитает стабильный дешёвый
  endpoint и может переключиться на fallback: [выбор провайдера и
  тарификация](https://routerai.ru/docs/guides/overview/provider-selection).
- `response_format: {"type":"json_object"}` документирован как JSON mode;
  RouterAI отдельно предупреждает, что в системном или пользовательском
  сообщении нужно попросить модель генерировать JSON. `structured_outputs`
  означает поддержку `json_schema`: [параметры API](https://routerai.ru/docs/guides/overview/parameters).
- Страницы моделей описывают `/chat/completions` и `/responses` как обычный и
  потоковый режимы; поток передаётся через SSE: [описание streaming](https://routerai.ru/pages/response-streaming).
  Это подтверждает возможность стриминга на уровне RouterAI API, но не
  является измерением задержки или гарантией одинакового поведения каждого
  провайдера.
- Для текста RouterAI не нашёл в опубликованной документации явного контракта
  `usage.cost` с указанием валюты. На странице генерации изображений поле
  `usage.cost` прямо названо стоимостью в рублях, но это не доказывает единицу
  для Chat Completions: [пример ответа с `usage.cost`](https://routerai.ru/docs/guides/overview/multimodal/image-generation).
  Для текстового live eval следует сохранять сырое значение `usage.cost` и
  сверять его с расчётом по фактическим токенам и фактической цене endpoint;
  до такой сверки его валюта помечается **неподтверждённой**.

## Shortlist из снимка `GET /models`

Значения ниже взяты из поля `pricing` снимка API и умножены на 1 000 000.
Единица — рубли за 1M токенов. Это более точная цифра на момент снимка, чем
округлённая карточка сайта. `cache_read` и `internal_reasoning` показаны только
там, где RouterAI вернул соответствующее поле.

| Модель / ID | Контекст | Input ₽/1M | Output ₽/1M | Cache read ₽/1M | Reasoning / JSON / tools по каталогу | Роль в eval |
|---|---:|---:|---:|---:|---|---|
| [Mercury 2.5 Preview](https://routerai.ru/models/inception/mercury-2.5-preview) — `inception/mercury-2.5-preview` | 260K | 4.502 | 16.884 | 0.450 | `reasoning`, `reasoning_effort`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`; `seed` не заявлен | Самый дешёвый эксперимент; preview и короткий контекст требуют проверки |
| [Qwen3.5-Flash](https://routerai.ru/models/qwen/qwen3.5-flash-02-23) — `qwen/qwen3.5-flash-02-23` | 1M | 7.316 | 29.266 | — | `reasoning`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`, `seed` | Дешёвый мультимодальный кандидат |
| [GLM 5.3 Flash](https://routerai.ru/models/z-ai/glm-5.3-flash) — `z-ai/glm-5.3-flash` | 1.31M | 8.822 | 29.407 | 1.764 | `reasoning`, `reasoning_effort`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`, `seed` | Главный дешёвый кандидат для рассказчика |
| [DeepSeek V4 Flash](https://routerai.ru/models/deepseek/deepseek-v4-flash) — `deepseek/deepseek-v4-flash` | 1M | 8.789 | 21.747 | 2.175 | `reasoning`, `reasoning_effort`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`, `seed` | Очень дешёвый текстовый кандидат; проверить русский стиль и дисциплину |
| [Gemini 2.5 Flash Lite](https://routerai.ru/models/google/gemini-2.5-flash-lite) — `google/gemini-2.5-flash-lite` | 1M | 11.256 | 45.025 | 1.126 | `reasoning`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`, `seed`; `internal_reasoning` 45.025 | Контрольный мультимодальный кандидат; включённое reasoning может добавить стоимость |
| [GPT-4.1 Nano](https://routerai.ru/models/openai/gpt-4.1-nano) — `openai/gpt-4.1-nano` | 1.048M | 11.256 | 45.025 | 2.814 | `response_format`, `structured_outputs`, `tools`, `tool_choice`, `seed`; reasoning в каталоге не заявлен | Стабильный дешёвый контроль без reasoning API |
| [GPT-5.6 Luna](https://routerai.ru/models/openai/gpt-5.6-luna) — `openai/gpt-5.6-luna` | 1.05M | 22.512 | 135.074 | 2.251 | `reasoning`, `reasoning_effort`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`, `seed` | Более дорогой контроль качества |
| [GLM 5.2](https://routerai.ru/models/z-ai/glm-5.2) — `z-ai/glm-5.2` | 1.048M | 47.276 | 148.581 | 8.780 | `reasoning`, `reasoning_effort`, `include_reasoning`, `response_format`, `structured_outputs`, `tools`, `tool_choice`, `parallel_tool_calls`, `seed` | Контроль старшей GLM; цена сильно выше Flash |

Для Gemini 2.5 Flash Lite в этой проверке поля взяты из публичного снимка
`GET /models`; карточка по прямому URL не отдала содержимое в web-проверке.
Наличие записи и её параметры подтверждены API-снимком, доступность отдельной
страницы нужно перепроверить перед публикацией отчёта.

## Обязательная проверка GLM 5.3 Flash

RouterAI подтверждает ID `z-ai/glm-5.3-flash`, алиас `~z-ai/glm-flash-latest`,
контекст 1M на карточке сайта (1 310 720 в API-снимке), входы text/image/video
и текстовый выход: [карточка GLM 5.3 Flash](https://routerai.ru/models/z-ai/glm-5.3-flash).
Карточка показывает округлённые тарифы 8 ₽/1M input и 29 ₽/1M output, а API
снимок на время проверки даёт 8.822 и 29.407 ₽/1M. Карточка также перечисляет
`reasoning`, `include_reasoning`, `response_format`, `structured_outputs`,
`tools` и `tool_choice`; значения уровней reasoning RouterAI для этой модели
явно не перечисляет.

Для narrator-запроса разумный первый вариант live eval — `z-ai/glm-5.3-flash`
с обычным `stream: true`, ограничением `max_tokens`, без включения
`include_reasoning` и с отдельным тестом `response_format`. Не следует
делать вывод о качестве D&D по маркетинговому описанию «кодирование и агенты»:
русский художественный стиль, соблюдение состояния сцены, отсутствие выдуманных
механических результатов и стабильность JSON остаются **неподтверждёнными**.

## Что проверять в live eval

1. Отправлять одинаковый русский набор из короткой сцены, боя после commit,
   свободного действия, NPC-диалога, критического результата и длинного
   контекста. Оценивать отдельно литературность и сохранение фактов сцены.
2. Для каждой модели делать два прогона: свободный текст и JSON/structured
   output там, где это заявлено в `supported_parameters`. Проверять JSON парсером,
   схему, наличие только подтверждённых полей и отсутствие рассуждений в
   пользовательском тексте.
3. Замерять TTFT, полное время, скорость вывода, `prompt_tokens`,
   `completion_tokens`, `total_tokens`, `usage.cost`, `model` и, если RouterAI
   возвращает его, фактический provider. Стриминг проверять отдельно от
   нестримингового ответа.
4. Чтобы сравнение цены было воспроизводимым, фиксировать провайдера через
   `provider.only` вместе с `allow_fallbacks: false`; без этого один и тот же
   ID может быть обработан разными endpoint’ами с разными тарифами. Сам выбор
   провайдера RouterAI считает предпочтением, а не жёстким ограничением, пока
   `allow_fallbacks` не отключён: [официальное описание routing](https://routerai.ru/docs/guides/overview/provider-selection).
5. На дату проверки не считать подтверждёнными: реальную стоимость
   `usage.cost` текстового запроса, точные значения `reasoning` для GLM/Qwen/
   DeepSeek, одинаковую поддержку `json_schema` у всех провайдеров, отсутствие
   модерационных различий между endpoints, русскую D&D-манеру и качество
   streaming.

## Замечание о расхождении цен

Для `z-ai/glm-5.2` карточка RouterAI при просмотре показывала около 38 ₽/1M
input и 121 ₽/1M output, тогда как сохранённый в тот же день снимок
`GET /models` содержит 47.276 и 148.581 ₽/1M. Это не следует молча считать
округлением. Для бюджета и отчёта live eval нужно использовать цену из свежего
API/endpoint-ответа, сохранять timestamp и фактический provider; веб-карточка
может быть кэширована или отражать другую маршрутизацию.

## Наблюдения телеметрии

Сверка выполнена только по локальным снимкам: каталог получен в
`20:52:45.797Z`, benchmark начат в `20:55:54.438Z` и последний sample записан в
`21:01:55.754Z`, endpoint snapshot получен в `20:59:11.587Z`.

`catalog_cost_rub` в benchmark математически совпадает с формулой
`prompt_tokens × catalog.pricing.prompt + completion_tokens × catalog.pricing.completion`.
Эта величина не вычитает `cached_tokens`, поэтому для cache-hit является
стоимостью полного промпта по каталогу, а не фактическим списанием. Для endpoint
с cache read проверка должна использовать
`(prompt_tokens − cached_tokens) × endpoint.prompt + cached_tokens × endpoint.input_cache_read + completion_tokens × endpoint.completion`.

| Модель | Что совпало с endpoint rates | Что это объясняет |
|---|---|---|
| GLM 5.3 Flash | `usage.cost` совпал с тарифами группы endpoint’ов Z.AI `9.286316325e-6 / 30.95438775e-6` в 5 из 8 samples; один из них совпал после тарификации 640 cached tokens по `input_cache_read`. В трёх последних samples остаток составляет примерно `+0.000051 ₽`. | Каталог модели использует более дешёвый Relace `8.822... / 29.407...`, а usage отражает конкретный более дорогой endpoint. |
| GLM 5.2 | В 2 samples с ненулевым usage точное совпадение с группой Z.AI `157.585974e-6 / 495.270204e-6`. В 6 из 8 samples ответ непустой, но `prompt_tokens`, `completion_tokens`, `total_tokens` равны 0 и `cost` равен `null`. | Нельзя считать эти 6 вызовов бесплатными: телеметрия не пришла. Цена endpoint Z.AI примерно в 3.33 раза выше записи StreamLake из каталога `47.2757922e-6 / 148.5810612e-6`. |
| DeepSeek V4 Flash | Точное совпадение с DeepInfra `11.650... / 23.300...` в 5 из 8 samples; два из них используют cache read. В трёх последних cache samples остаток `+0.000039…0.000044 ₽`. | Каталоговая запись использует более дешёвый DigitalOcean `8.789... / 21.747...`; фактическое списание может быть по DeepInfra. |
| GPT-5.6 Luna | 4 из 5 samples с usage точно совпали со стандартным OpenAI endpoint; cache sample совпал после `input_cache_read`. Один sample отличается на `+0.0001696 ₽`; ещё 3 samples не имеют usage. | `openai/flex` в endpoint snapshot дешевле, но эти ответы математически соответствуют стандартному OpenAI rate. |

Для остальных моделей в endpoint snapshot не было соответствующих записей:
Gemini 2.5 Flash Lite совпал с каталоговой формулой в 6/8 samples, Qwen3.5 Flash
в 5/8, Mercury 2.5 Preview в 6/8, GPT-4.1 Nano в 7/8. Отклонения в
оставшихся samples малы — примерно `0.000024…0.000063 ₽` — и могут быть
следствием разнесённых по времени snapshots, округления или деталей биллинга,
которые не представлены в `usage`; конкретную причину по этим файлам установить
нельзя.

Таким образом, значения `usage.cost` в benchmark **эмпирически согласуются** с
рублёвыми тарифами конкретных endpoint’ов и с рублёвой единицей каталога, но
RouterAI не публикует в текстовом response-контракте отдельное поле валюты.
Следует сохранять сырое `usage.cost`, цену endpoint и timestamp; не подменять
пропущенный `null` нулём и не умножать usage повторно на курс или на 1 000 000.
