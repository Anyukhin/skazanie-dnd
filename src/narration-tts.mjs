/**
 * Озвучка нарратива в браузере — задача 4.1 плана `docs/experience-upgrade-plan.md`.
 *
 * Решение владельца: голос звучит у каждого игрока в его вкладке, а не через
 * бота в голосовом канале. Поэтому здесь нет ни серверного пути, ни запроса к
 * модели: всё делает бесплатный `speechSynthesis` браузера.
 *
 * В этом файле только чистые функции — подготовка текста и выбор голоса. Они
 * не трогают DOM, принимают обычные объекты и покрыты `node:test`. Всё, что
 * умеет говорить и отменять сказанное, живёт в `narration-tts.ts` рядом: без
 * такого разделения проверить логику было бы нечем, браузерных тестов в
 * проекте нет.
 */

export const NARRATION_VOICE_MODES = Object.freeze(['off', 'button', 'auto'])

/** Нечитаемая вслух разметка: звёздочки, решётки, подчёркивания, обратные кавычки. */
const MARKDOWN_NOISE = /[*_`#>~|]+/gu

/**
 * Служебные строки, которые в ленте помогают, а вслух только мешают: пометки
 * о ходе, ярлыки бросков и сырые идентификаторы правил.
 */
const SERVICE_LINE = /^(?:ход передан|действие засчитано|можно продолжить ход|d20\b|срд?\s|сл\s*\d|бросок\b|srd_5_2_1:)/iu

/**
 * Текст, пригодный для произнесения: без разметки, без служебных строк и без
 * повторных пробелов. Пустая строка означает «озвучивать нечего» — так вызов
 * молча ничего не делает, вместо того чтобы произносить тишину.
 *
 * @param {unknown} value
 * @param {number} [maximum]
 */
export function speakableNarration(value, maximum = 4_000) {
  return String(value ?? '')
    .split(/\r?\n/u)
    .map((line) => line.replace(MARKDOWN_NOISE, ' ').trim())
    .filter((line) => line.length > 0 && !SERVICE_LINE.test(line))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum)
}

/**
 * Разбиение на предложения. Браузеры обрывают слишком длинные реплики, поэтому
 * длинный абзац произносится частями, а очередь между ними не рвётся.
 *
 * Куски режутся по границе предложения, а если предложение само длиннее
 * предела — по последнему пробелу: рвать слово посреди звучит как сбой.
 *
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string[]}
 */
export function narrationSpeechChunks(value, limit = 220) {
  const text = speakableNarration(value)
  if (!text) return []
  const bound = Math.max(40, Math.floor(limit))
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+|$)/gu) ?? [text]
  const chunks = []
  let current = ''
  const push = () => {
    const trimmed = current.trim()
    if (trimmed) chunks.push(trimmed)
    current = ''
  }
  for (const raw of sentences) {
    let sentence = raw.trim()
    if (!sentence) continue
    while (sentence.length > bound) {
      const head = sentence.slice(0, bound)
      const cut = head.lastIndexOf(' ')
      const take = cut > bound / 2 ? cut : bound
      push()
      chunks.push(sentence.slice(0, take).trim())
      sentence = sentence.slice(take).trim()
    }
    if (!sentence) continue
    if ((`${current} ${sentence}`).trim().length > bound) push()
    current = current ? `${current} ${sentence}` : sentence
  }
  push()
  return chunks.filter(Boolean)
}

const russianLanguage = (voice) => String(voice?.lang ?? '').toLowerCase().replace('_', '-')

/**
 * Выбор голоса. Порядок предпочтений закрыт и детерминирован: точный `ru-RU`
 * важнее любого другого русского, локальный голос важнее облачного (он не
 * зависит от сети), голос по умолчанию важнее прочих равных, а при полном
 * равенстве решает имя — иначе список голосов у одного игрока менялся бы от
 * запуска к запуску.
 *
 * `null` означает, что русского голоса в системе нет. Это не ошибка: фича в
 * таком случае честно скрывается, а не читает русский текст английским голосом.
 *
 * @param {Array<{ name?: string, lang?: string, localService?: boolean, default?: boolean }>} voices
 * @param {string} [preferredName]
 */
export function pickNarrationVoice(voices, preferredName = '') {
  const russian = (Array.isArray(voices) ? voices : []).filter((voice) => russianLanguage(voice).startsWith('ru'))
  if (!russian.length) return null
  const requested = String(preferredName ?? '').trim()
  if (requested) {
    const exact = russian.find((voice) => String(voice?.name ?? '') === requested)
    if (exact) return exact
  }
  return [...russian].sort((left, right) => (
    Number(russianLanguage(right) === 'ru-ru') - Number(russianLanguage(left) === 'ru-ru')
    || Number(right?.localService === true) - Number(left?.localService === true)
    || Number(right?.default === true) - Number(left?.default === true)
    || String(left?.name ?? '').localeCompare(String(right?.name ?? ''))
  ))[0]
}

/**
 * Режим озвучки из локального хранилища. Значение чужое и недоверенное:
 * всё, чего нет в списке, читается как «выключено».
 *
 * @param {unknown} value
 * @returns {'off' | 'button' | 'auto'}
 */
export function normalizeVoiceMode(value) {
  const mode = String(value ?? '').trim()
  return NARRATION_VOICE_MODES.includes(mode) ? /** @type {'off' | 'button' | 'auto'} */ (mode) : 'off'
}

/**
 * Нужно ли произносить это сообщение само, без нажатия кнопки. Автоозвучка
 * читает только завершённый текст рассказчика: стриминговые куски по мере
 * прихода дали бы заикание, а реплики игроков и системные строки за столом и
 * так звучат живыми голосами.
 *
 * @param {{ speaker?: string, text?: string, streaming?: boolean }} message
 * @param {'off' | 'button' | 'auto'} mode
 */
export function shouldAutoSpeak(message, mode) {
  if (mode !== 'auto') return false
  if (String(message?.speaker ?? '') !== 'narrator') return false
  if (message?.streaming === true) return false
  return speakableNarration(message?.text).length > 0
}
