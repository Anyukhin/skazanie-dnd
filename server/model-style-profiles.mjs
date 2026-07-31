/**
 * Поправки системного промпта под конкретную модель.
 *
 * Замер 2026-07-31 (`docs/model-benchmark-2026-07-31.md`) показал, что
 * `openai/gpt-5.6-luna` дешевле GLM-5.2 в 8,6 раза, но проваливает две метрики
 * стола: реплики NPC сжимаются до одного факта (голоса неразличимы), а факты
 * прошлых сцен теряются. Оба провала — про краткость, а не про способность:
 * маркеры речи модель сохраняет всегда.
 *
 * Здесь лежит компенсация промптом. Ключ — точный идентификатор модели; для
 * незнакомых моделей добавка пустая, то есть поведение GLM не меняется вовсе.
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
 * Горячий путь хода работает без «размышлений» у всех известных моделей: у
 * GLM и DeepSeek это было всегда, у Luna замер 2026-07-31 показал, что с
 * добавкой формы reasoning не даёт качества, а хвост задержки без него
 * исчезает (медиана 3,3 с и максимум 5,4 с против 7,3 и 9,2 с). Незнакомая
 * модель остаётся на умолчании провайдера.
 *
 * @param {string | null | undefined} modelId
 * @returns {{ enabled: false } | null}
 */
export function reasoningProfileFor(modelId) {
  const known = new Set([
    'z-ai/glm-5.2',
    'deepseek/deepseek-v4-flash',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-luna-pro',
  ])
  return known.has(String(modelId ?? '')) ? { enabled: false } : null
}
