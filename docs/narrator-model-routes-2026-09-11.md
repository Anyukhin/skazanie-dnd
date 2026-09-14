# Маршруты моделей для сравнения рассказчика

Проверено **11 сентября 2026 года** (Europe/Moscow). Это карта доступности и
контрактов, а не рейтинг качества русского D&D-текста. Снимок каталога без
ключа сохранён в [`eval/routerai-catalog-2026-09-11.json`](../eval/routerai-catalog-2026-09-11.json).
Поля `reasoning` и `supported_parameters` в каталоге доказывают, что шлюз
принимает параметр, но не доказывают фактический уровень рассуждений модели.

## Короткий вывод

- Для RouterAI можно запускать `meta/muse-spark-1.3`,
  `meta/muse-spark-1.3-contributor`, `z-ai/glm-5.3-flash` и
  `deepseek/deepseek-v4.1-flash`.
- Вложенное имя `Qwen3.8-Flash-Next` нельзя без оговорки заменить на
  `qwen/qwen3.8-flash`: это разные варианты. RouterAI публикует только
  `qwen/qwen3.8-flash`; официальная публикация Qwen описывает Flash-Next как
  открытые веса, а production API как `qwen3.8-flash`.
- Для общего первого сравнения лучше зафиксировать `low`: это единственный
  запрошенный уровень, который имеет прямой смысл у всех четырёх доступных
  семейств. `medium` и `off` не являются общей шкалой.
- Не использовать RouterAI-алиасы в основном сравнении и не разрешать
  незаметный fallback провайдера: сохранять точный `model`, фактический
  `provider` и `usage`, а для воспроизводимого теста указывать
  `provider.only` вместе с `allow_fallbacks: false`.

## Матрица ID и уровней

Обозначения: **да** — подтверждено официальным контрактом; **нет** — режим
запрещён; **условно** — шлюз или документация допускает форму, но уровень либо
не является нативным, либо требует smoke-теста.

| Кандидат | ID upstream / опубликованный API | Точный ID RouterAI | `low` | `medium` | `off` | Существенное ограничение |
|---|---|---|---|---|---|---|
| Muse Spark 1.3 Standard | `muse-spark-1.3` | `meta/muse-spark-1.3` | да | да | условно | `none` описан как переключатель, но официальная recipe предупреждает, что на публичном endpoint он пока ненадёжен |
| Muse Spark 1.3 Contributor | `muse-spark-1.3-contributor` | `meta/muse-spark-1.3-contributor` | условно | условно | условно | RouterAI карточка подтверждает `reasoning`, но отдельный официальный пример уровней Contributor не опубликован |
| GLM-5.3-Flash | `glm-5.3-flash` | `z-ai/glm-5.3-flash` | да | условно | нет | Z.AI требует включённое thinking; нативные уровни только `low`, `high`, `max`, отключение отклоняется |
| DeepSeek V4.1 Flash | `deepseek-flash` | `deepseek/deepseek-v4.1-flash` | да | условно | да | `medium` у DeepSeek отображается как `high`; thinking с tools требует полного возврата `reasoning_content` |
| Qwen3.8-Flash-Next | open weights: `Qwen/Qwen3.8-Flash-Next`; QwenCloud production: `qwen3.8-flash` | **нет** | — | — | — | На `GET /api/v1/models/qwen/qwen3.8-flash-next/endpoints` RouterAI возвращает 404 |
| Qwen3.8 Flash (доступный заменитель) | `qwen3.8-flash` | `qwen/qwen3.8-flash` | да | да | условно | Это hosted production Flash, а не открытые веса Flash-Next; уровни `high`/`max` мапятся в `xhigh`, off через gateway не считать доказанным без проверки |

## Muse Spark 1.3

Meta сообщает, что Muse Spark 1.3 с максимальным reasoning доступна в Meta
Model API, но для точной формы параметра полезнее официальная recipe API:
`reasoning_effort` принимает `minimal`, `low`, `medium`, `high`; `xhigh`
принимается и сводится к силе `high`. Та же recipe перечисляет `none` как
выключение, но прямо предупреждает, что значение пока ненадёжно на публичном
endpoint. Reasoning-токены входят в `completion_tokens` и расходуют общий
лимит вывода; в Chat Completions поле `reasoning_content` сегодня пустое, а
Responses API возвращает зашифрованный reasoning, который нельзя использовать
как читаемый текст.

Источники: [релиз Muse Spark 1.3 от Meta](https://research.meta.ai/blog/introducing-muse-spark-1-3),
[официальный cookbook Meta](https://github.com/meta-models/meta-model-cookbook),
[recipe про reasoning tokens](https://github.com/meta-models/meta-model-cookbook/blob/main/01_api_fundamentals/06_reasoning_tokens.ipynb),
[Standard на RouterAI](https://routerai.ru/models/meta/muse-spark-1.3),
[Contributor на RouterAI](https://routerai.ru/models/meta/muse-spark-1.3-contributor).

Оба ID существуют на RouterAI и имеют одинаковое окно 1M. Contributor нельзя
считать просто более дешёвым дублем: RouterAI прямо предупреждает, что prompts
и results могут использоваться для улучшения продуктов Meta. Для реального
содержимого кампаний этот маршрут требует отдельного согласия; для синтетических
сцен он пригоден как экономичный эксперимент. Цена и условия не переносятся из
вложенного текста автоматически.

## GLM-5.3-Flash

Официальный код Z.AI — `glm-5.3-flash`; модель имеет 1M контекст, максимум
128K output, инструменты и мультимодальный вход. Z.AI указывает только
`low`, `high`, `max`, по умолчанию `max`; `thinking.type` допускает только
`enabled`, а отключение thinking для GLM-5.3-Flash невозможно. Поэтому
`reasoning: { enabled: false }` не годится как production-профиль. `medium`
не является нативным уровнем Z.AI. Если RouterAI принимает его как общий
параметр, это нужно считать маппингом шлюза, а не сопоставимым средним режимом.

Источники: [карточка GLM-5.3-Flash Z.AI](https://docs.z.ai/guides/vlm/glm-5.3-flash),
[контракт GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3),
[официальная документация thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode),
[карточка RouterAI](https://routerai.ru/models/z-ai/glm-5.3-flash),
[endpoint metadata RouterAI](https://routerai.ru/api/v1/models/z-ai/glm-5.3-flash/endpoints).

Текущий публичный endpoint RouterAI объявляет generic-поле `reasoning`, но не
перечисляет значения уровней. В проектном live-прогоне низкий режим уже
проходил; это подтверждает работоспособность данного запроса через шлюз, но не
доказывает, что все провайдеры и все уровни дают одинаковое reasoning.

## DeepSeek V4.1 Flash

DeepSeek после релиза 10 сентября рекомендует официальный API ID
`deepseek-flash`. Старые `deepseek-v4-flash` и
`deepseek-v4-flash-vision-exp` временно принимаются и маршрутизируются на
V4.1-Flash, поэтому в RouterAI для фиксации именно новой записи следует
использовать `deepseek/deepseek-v4.1-flash`. RouterAI также публикует alias
`~deepseek/deepseek-v4-flash-latest`, но alias следует оставлять только для
ручных проверок.

Нативная шкала DeepSeek — `low`, `high`, `max`; официальный mapping переводит
`minimal` и `low` в `low`, `medium`/`high`/`xhigh` в `high`, а `max` и `ultra`
в `max`. Выключение — `thinking.type: disabled` в Chat Completions или
`reasoning.effort: none` в Responses API. В thinking mode параметры
`temperature`, `presence_penalty` и `frequency_penalty` не действуют; `top_p`
не может быть ниже 0.95. Если в запросе есть tools, каждый последующий запрос
обязан вернуть полный неизменённый `reasoning_content`, иначе DeepSeek отвечает
ошибкой 400.

Источники: [официальный релиз V4.1-Flash](https://deepseek.com/en/news/deepseek-v4-1-flash/),
[первый API-вызов и текущий ID](https://api-docs.deepseek.com/),
[модели и цены](https://api-docs.deepseek.com/quick_start/pricing/),
[thinking mode и mapping уровней](https://api-docs.deepseek.com/guides/thinking_mode/),
[карточка RouterAI](https://routerai.ru/models/deepseek/deepseek-v4.1-flash),
[endpoint metadata RouterAI](https://routerai.ru/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints).

Официальная модель имеет окно 1M и максимум 384K output. RouterAI показывает
несколько провайдеров и переменные peak/off-peak цены; не смешивать их в одном
ценовом сравнении без фиксации endpoint.

## Qwen3.8-Flash-Next и доступный Qwen3.8 Flash

Qwen официально выпустил `Qwen/Qwen3.8-Flash-Next` как открытые веса. Его
локальный quickstart использует inference frameworks с контекстом 262K и
`reasoning-parser qwen3`; модель можно расширить до 1M через YaRN. В той же
официальной публикации отдельно сказано, что production version с контекстом
1M и встроенными tools подаётся в QwenCloud как **`qwen3.8-flash`**. Это не
доказывает тождество open-weight Flash-Next и hosted Flash.

На RouterAI есть только `qwen/qwen3.8-flash`, с primary endpoint Alibaba,
контекстом 1M и максимумом 131072 output; точный Flash-Next отсутствует
(публичный endpoint URL возвращает 404). Поэтому результат теста
`qwen/qwen3.8-flash` должен называться именно Qwen3.8 Flash, а строку
`Qwen3.8-Flash-Next` в отчёте следует пометить как незапущенную.

Официальная Alibaba документация для hosted Qwen3.8 указывает нативные уровни
`low`, `medium`, `xhigh`; `high` и `max` мапятся в `xhigh`, `minimal` в
`low`. В общей таблице Responses `none` мапится в `enable_thinking=false`, но
для Qwen3.8 документация одновременно задаёт thinking по умолчанию и не
показывает надёжного отдельного off-примера. Поэтому off через RouterAI нужно
проверять smoke-тестом и не считать тем же самым, что отсутствие reasoning у
обычной модели. `reasoning_effort` и `thinking_budget` для Qwen3.8 нельзя
передавать одновременно.

Источники: [официальный репозиторий Flash-Next](https://github.com/QwenLM/Qwen3.8-Flash-Next),
[официальная публикация Qwen](https://qwen.ai/blog?id=qwen3.8-flash-next),
[карточка hosted Qwen3.8 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash),
[Alibaba API mapping reasoning](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions),
[Alibaba deep thinking guide](https://www.alibabacloud.com/help/en/model-studio/deep-thinking),
[карточка RouterAI](https://routerai.ru/models/qwen/qwen3.8-flash),
[endpoint metadata RouterAI](https://routerai.ru/api/v1/models/qwen/qwen3.8-flash/endpoints).

## Что фиксировать в сравнительном прогоне

1. Сравнивать одинаковые сцены и промпты, но хранить отдельно `model_id`,
   `reasoning` в отправленном теле, `response.model`, фактический `provider`,
   `prompt_tokens`, `completion_tokens`, `reasoning_tokens`, время до первого
   видимого текста и полное время.
2. Для общей серии использовать `low` и явно отметить, что у DeepSeek
   `medium` был бы фактически `high`, у GLM native `medium` отсутствует, а у
   Qwen `medium` является самостоятельным уровнем.
3. Отдельную серию `off` запускать только для DeepSeek. Для GLM это запрещено;
   для Muse и Qwen текущая документация или gateway mapping не дают достаточно
   надёжного основания считать off подтверждённым.
4. Для RouterAI provider pinning использовать documented
   `provider.only` + `allow_fallbacks: false`. Иначе маршрут может незаметно
   сменить backend, контекст, лимит, цену или обработку reasoning: [выбор
   провайдера RouterAI](https://routerai.ru/docs/guides/overview/provider-selection).
5. Не выдавать рейтинг по внешним benchmark/index и не переносить тарифы из
   вложенного текста: это исследование подтверждает возможность маршрута, а
   качество рассказчика, полезность reasoning и фактический расход надо
   оценивать по сохранённым ответам текущего прогона.
