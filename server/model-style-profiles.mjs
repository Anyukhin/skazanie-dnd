/**
 * Поправки системного промпта под конкретную модель.
 *
 * Замер 2026-07-31 (`docs/model-benchmark-2026-07-31.md`) показал, что
 * `openai/gpt-5.6-luna` дешевле GLM-5.2 в 8,6 раза, но проваливает две метрики
 * стола: реплики NPC сжимаются до одного факта (голоса неразличимы), а факты
 * прошлых сцен теряются. Оба провала — про краткость, а не про способность:
 * маркеры речи модель сохраняет всегда.
 *
 * Здесь лежат измеренные компенсации промптом. Luna получает общую добавку
 * формы, а GLM-5.3-Flash — отдельный контракт только для Рассказчика: он не
 * протекает в социальный контроллер, где GLM и без него различает голоса.
 * Для незнакомых моделей добавка остаётся пустой.
 */

const LUNA_ADDENDUM = `
ДОПОЛНИТЕЛЬНЫЕ ТРЕБОВАНИЯ К ФОРМЕ ОТВЕТА (обязательные):
- Реплики и описания пиши развёрнуто: 2–4 полных предложения, не меньше 220
  символов. Однострочный ответ — ошибка, даже если факт передан верно.
- Говорящий обязан звучать как живой человек со своим словарём: используй его
  speech_profile целиком — темп, лексикон и манеру, а не только вводное слово.
  Добавь деталь от себя в его характере: присказку, отступление, оценку.
- Не сводись к голому факту. Факт оберни в наблюдение, воспоминание или
  отношение персонажа к происходящему.
- Прежде чем отвечать, найди в переданных данных факты прошлых сцен (обещания,
  прошлые разговоры, памятные детали) и вплети хотя бы один в текст дословно
  узнаваемым образом.`

const GLM_NARRATOR_ADDENDUM = `
РЕЖИМ ТОЧНОСТИ GLM ДЛЯ РАССКАЗЧИКА:
- Обычный исход — ровно 1–2 предложения о видимом результате и его пределах.
  Не описывай процесс, которым герой получил результат. Для обычной проверки
  вообще не упоминай героя по имени: подлежащим пусть будет известная деталь.
- AbilityCheckResolved и success=true подтверждают проверку, а не социальный
  исход. Принятие довода, новые ответы NPC и изменение отношения требуют
  отдельного события или соответствующего permitted_npc_reactions.
- open_promises остаются обещаниями. До подтверждённого исполнения сообщай
  только, кто и что обещал; ни наличие вещи в сцене, ни её получение не следуют
  из цели героя. recent_interactions явно называй прошлыми разговорами.
- Используй не более одного memory_focus и только при прямой связи с текущим
  результатом. Совпадение двух деталей не доказывает причину или виновника.
- Пустой permitted_npc_reactions означает отсутствие новых действий NPC.
  mood и sensory_anchors дают статическую атмосферу, не события.
- Примеры стиля описывают другие сцены: сохраняй только их ритм, не их события.
  В каждом предложении оставь лишь слова, для которых есть основание во входе.
- После неудачи назови предел результата, сохранив неизвестное неизвестным.
  При бедном brief одна короткая точная фраза лучше выдуманного продолжения.`

const MODEL_ADDENDA = new Map([
  ['openai/gpt-5.6-luna', LUNA_ADDENDUM],
  ['openai/gpt-5.6-luna-pro', LUNA_ADDENDUM],
])

/**
 * @param {string | null | undefined} modelId
 * @returns {string} добавка к системному промпту или пустая строка
 */
export function styleAddendumFor(modelId) {
  return MODEL_ADDENDA.get(String(modelId ?? '')) ?? ''
}

/**
 * @param {string} basePrompt
 * @param {{ model?: string } | null | undefined} llmClient
 * @returns {string}
 */
export function promptForModel(basePrompt, llmClient) {
  const addendum = styleAddendumFor(llmClient?.model)
  return addendum ? `${basePrompt}\n${addendum}` : basePrompt
}

/**
 * Ролевой слой не должен протекать между агентами: ограничения Рассказчика
 * сделали бы живой ответ NPC формально неправильным.
 *
 * @param {string} basePrompt
 * @param {{ model?: string } | null | undefined} llmClient
 * @param {'narrator' | 'shared'} [role]
 * @returns {string}
 */
export function promptForModelRole(basePrompt, llmClient, role = 'shared') {
  const shared = promptForModel(basePrompt, llmClient)
  if (role === 'narrator' && String(llmClient?.model ?? '') === 'z-ai/glm-5.3-flash') {
    return `${shared}\n${GLM_NARRATOR_ADDENDUM}`
  }
  const npcAddendum = role === 'npc' ? NPC_ROLE_ADDENDA.get(String(llmClient?.model ?? '')) : ''
  return npcAddendum ? `${shared}\n${npcAddendum}` : shared
}

/**
 * GPT-6 Luna без добавки отвечает NPC одной фразой, и голоса неразличимы; с
 * добавкой формы — 6/6 (`docs/model-benchmark-2026-10-01-gpt-6-luna.md`).
 * Рассказчику та же добавка не нужна: без неё Luna уже не выдумывает фактов,
 * поэтому она подключается только к репликам NPC.
 */
const NPC_ROLE_ADDENDA = new Map([
  ['openai/gpt-6-luna', LUNA_ADDENDUM],
  ['openai/gpt-6-luna-pro', LUNA_ADDENDUM],
])

/**
 * Горячий путь хода работает без «размышлений» там, где провайдер разрешает
 * их выключить. У Luna замер 2026-07-31 показал, что с добавкой формы reasoning
 * не даёт качества, а хвост задержки без него исчезает. Для GLM-5.3-Flash
 * оставлен проверенный в живых запросах effort `low`; это настройка нашего
 * маршрута, а не утверждение, что провайдер запрещает другие режимы.
 * Muse Spark 1.3 использует low из сравнительного прогона 2026-09-11.
 * GPT-6 Luna на умолчании провайдера тратит лимит ответа на рассуждения:
 * арбитр вернул валидный JSON 1 раз из 3, без них — 6 из 6 (замер 2026-10-01).
 * Незнакомая модель остаётся на умолчании провайдера.
 *
 * @param {string | null | undefined} modelId
 * @returns {{ enabled: false } | { effort: 'low' } | null}
 */
export function reasoningProfileFor(modelId) {
  if (['z-ai/glm-5.3-flash', 'meta/muse-spark-1.3'].includes(String(modelId ?? ''))) return { effort: 'low' }
  const known = new Set([
    'z-ai/glm-5.2',
    'deepseek/deepseek-v4-flash',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-luna-pro',
    'openai/gpt-6-luna',
    'openai/gpt-6-luna-pro',
  ])
  return known.has(String(modelId ?? '')) ? { enabled: false } : null
}

/**
 * Профили рассуждений, которые лидер кампании может выбрать, и их раскладка по
 * ролям. Источник — перебор уровней 2026-10-01
 * (`docs/model-reasoning-sweep-2026-10-01.md`, `eval/model-presets-2026-10-01.json`).
 * Все жёсткие ограничения во всех ролях прошла только GPT-6 Luna без
 * размышлений; размышления не повысили точность ни в одной роли. Поэтому:
 * - профиль трогает только творческие роли — рассказчика, Режиссёра и NPC;
 *   арбитр свободного действия и создание мира на высоких уровнях ломаются
 *   (4 и 1 валидный ответ из 6, мир не пишется) и всегда идут по
 *   `reasoningProfileFor`;
 * - профили есть только у Luna: у GLM `enabled: false` размышления не
 *   выключает, у DeepSeek `low` равен полному размышлению, у Gemini `low`
 *   ломает JSON-роли — честного выбора уровня у них нет, только «Авто».
 */
export const REASONING_PROFILES = Object.freeze({
  'openai/gpt-6-luna': Object.freeze({
    thoughtful: Object.freeze({ director: Object.freeze({ effort: 'low' }), npc: Object.freeze({ effort: 'minimal' }) }),
    deep: Object.freeze({
      narrator: Object.freeze({ effort: 'high' }),
      director: Object.freeze({ effort: 'high' }),
      npc: Object.freeze({ effort: 'medium' }),
    }),
  }),
})

/**
 * Рассуждения для роли при профиле кампании или `null` — тогда действует
 * `reasoningProfileFor`. Непомеченная роль (`role` не передан) всегда `null`.
 *
 * @param {string} modelId
 * @param {string} level
 * @param {string} [role]
 */
export function campaignRoleReasoning(modelId, level, role = '') {
  const reasoning = REASONING_PROFILES[String(modelId ?? '')]?.[String(level ?? '')]?.[String(role ?? '')]
  return reasoning ? { ...reasoning } : null
}

/**
 * Модели, которые лидер кампании может выбрать в настройках. Подписи и
 * описания — для игрока: что он получит за столом, по замерам 2026-10-01.
 */
export const MODEL_OPTIONS = Object.freeze({
  'openai/gpt-6-luna': {
    label: 'GPT-6 Luna',
    description: 'точнее всех с фактами, быстро решает в бою и дешевле всех; текст суше',
  },
  'openai/gpt-6-luna-pro': {
    label: 'GPT-6 Luna Pro',
    description: 'чуть богаче новый мир, но каждый ход на секунду медленнее и в 3–5 раз дороже',
  },
  'z-ai/glm-5.3-flash': {
    label: 'GLM-5.3 Flash',
    description: 'живой текст, но часто досочиняет детали и не успевает создать мир',
  },
  'google/gemini-2.5-flash-lite': {
    label: 'Gemini 2.5 Flash Lite',
    description: 'быстро создаёт мир и аккуратна в тексте, но хуже держит решения Режиссёра',
  },
  'deepseek/deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash',
    description: 'дёшево, но досочиняет и изредка выдаёт служебный текст вместо ответа',
  },
  'z-ai/glm-5.2': {
    label: 'GLM-5.2',
    description: 'прежняя основная модель; дороже и медленнее новых',
  },
  'openai/gpt-4.1-nano': {
    label: 'GPT-4.1 Nano',
    description: 'последний резерв: очень быстро, но бедный текст',
  },
  'meta/muse-spark-1.3': {
    label: 'Muse Spark 1.3',
    description: 'экспериментальная модель для ручного выбора',
  },
})

/** Модель, которую настройки помечают «рекомендуется» (перебор 2026-10-01). */
export const RECOMMENDED_MODEL = 'openai/gpt-6-luna'

/** Модели, которые можно выбрать вручную, даже если их нет в цепочке `.env`. */
export const SELECTABLE_EXTRA_MODELS = Object.freeze(['openai/gpt-6-luna', 'openai/gpt-6-luna-pro', 'meta/muse-spark-1.3'])

/**
 * Карточка модели для настроек. Незнакомая модель (например, добавленная в
 * `.env` позже этого списка) показывается по своему ID и только с `auto`.
 *
 * @param {string} modelId
 * @param {{ recommended?: string }} [options]
 */
export function modelOptionFor(modelId, { recommended = '' } = {}) {
  const id = String(modelId ?? '')
  const known = MODEL_OPTIONS[id]
  return {
    id,
    label: known?.label ?? id,
    description: known?.description ?? '',
    reasoningLevels: ['auto', ...Object.keys(REASONING_PROFILES[id] ?? {})],
    recommended: Boolean(recommended) && id === recommended,
  }
}

/** Допустим ли профиль рассуждений для модели. `auto` допустим всегда. */
export function reasoningLevelAllowedFor(modelId, level) {
  return level === 'auto' || modelOptionFor(modelId).reasoningLevels.includes(String(level ?? ''))
}

/**
 * Модели, которым `RouterAIClient` отправляет `response_format: json_schema`
 * со `strict: true`, если роль приложила схему ответа.
 *
 * Проба 2026-10-01 (`eval/structured-outputs-probe-2026-10-01.json`): маршрут
 * исполняет схему у всех восьми проверенных моделей — при промпте, требующем
 * других ключей, ответ всё равно шёл по схеме. Но включена схема только там,
 * где замер ролей (`eval/structured-outputs-{before,after}-2026-10-01.json`,
 * `docs/agent-improvements/d-structured-outputs.md`) не показал вреда:
 * - GPT-4.1 Nano: валидный Director 1/10 → 9/10; Gemini 2.5 Flash Lite: 8/10 → 10/10;
 * - GPT-6 Luna: 10/10 и 12/12 без изменений, задержка в пределах шума;
 * - Luna Pro и GPT-5.6 Luna — та же семья OpenAI, на пробе схема соблюдалась.
 * Не включены, хотя схему исполняют: DeepSeek V4 Flash — у Режиссёра 3 ответа
 * из 10 вышли за боевой тайм-аут 12 с (до схемы 0 из 10), валидность 10 → 9;
 * GLM-5.3 Flash — валидность и без схемы 100 %, а хвост задержки вырос
 * (p95 Режиссёра 6,2 → 10,7 с, NPC 6,0 → 18,0 с); GLM-5.2 по ролям не мерили.
 * Muse Spark 1.3: на пробе рассуждения съели лимит ответа, вывода нет.
 * Остальные модели остаются на `json_object` (у GLM-5.3 Flash — на директиве в промпте).
 */
export const STRUCTURED_OUTPUT_MODELS = Object.freeze([
  'openai/gpt-6-luna',
  'openai/gpt-6-luna-pro',
  'openai/gpt-5.6-luna',
  'openai/gpt-4.1-nano',
  'google/gemini-2.5-flash-lite',
])

/**
 * @param {string | null | undefined} modelId
 * @returns {boolean} можно ли отправить этой модели strict json_schema
 */
export function supportsJsonSchema(modelId) {
  return STRUCTURED_OUTPUT_MODELS.includes(String(modelId ?? ''))
}
