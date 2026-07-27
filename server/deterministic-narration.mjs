/**
 * Общий контракт детерминированных рассказчиков.
 *
 * До 2026-07-27 модули `scene-`, `encounter-` и `merchant-narration` были тремя
 * несвязанными наборами функций с разными сигнатурами — `AGENTS.md` §4 держал
 * это как незакрытый долг и просил не расширять. Оркестратор платил за это
 * трижды: тремя обёртками и дважды повторённой лестницей из тернарных
 * операторов, которую приходилось править в двух местах при каждом новом
 * рассказчике.
 *
 * Контракт ниже — минимальный: рассказчик умеет узнать свои события и превратить
 * их в текст. Порядок в реестре и есть приоритет; он был и раньше, но жил в
 * форме вложенных `?:` и нигде не назывался.
 *
 * @typedef {object} DeterministicNarrator
 * @property {string} id                     короткое имя для меток трассы
 * @property {string} promptVersion          что писать в `prompt_version`
 * @property {string} provider               что писать в `provider`
 * @property {number} priority               меньше — раньше; см. ниже
 * @property {(events: any[]) => boolean} matches   его ли это события
 * @property {(events: any[], state: any) => string | null} narrate
 * @property {((events: any[]) => string[]) | undefined} [suggestions]
 *
 * Все рассказчики здесь **не обращаются к модели**: текст собирается из уже
 * закоммиченных событий. Это и есть их назначение — там, где механика уже
 * решена, свободный ответ модели способен только разойтись с ней.
 */

/** Единственная нормализация текста на все рассказчики. */
export function cleanNarrationText(value, maximum = 1_000) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

/** То же, но с запасным значением: пустая строка не должна доезжать до игрока. */
export function narrationTextOr(value, fallback, maximum = 120) {
  return cleanNarrationText(value, maximum) || fallback
}

/**
 * Порядок значим и повторяет прежнее поведение лестницы `?:`: смена сцены
 * перекрывает торговлю, торговля — появление противников. Он задан **числом в
 * самом рассказчике**, а не порядком регистрации: иначе приоритет зависел бы от
 * порядка импортов, то есть от того, кто кого случайно подтянул первым.
 */
export const NARRATOR_PRIORITY = Object.freeze({ scene: 10, merchant: 20, encounter: 30, combat: 40 })

const NARRATORS = []

export function registerDeterministicNarrator(narrator) {
  assertNarratorContract(narrator)
  if (NARRATORS.some((known) => known.id === narrator.id)) {
    throw new TypeError(`Рассказчик ${narrator.id} уже зарегистрирован`)
  }
  NARRATORS.push(narrator)
  NARRATORS.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  return narrator
}

export function deterministicNarrators() {
  return [...NARRATORS]
}

export function assertNarratorContract(narrator) {
  const label = narrator?.id ? `рассказчик ${narrator.id}` : 'рассказчик без id'
  if (!narrator || typeof narrator !== 'object') throw new TypeError('Рассказчик должен быть объектом')
  for (const field of ['id', 'promptVersion', 'provider']) {
    if (!narrator[field] || typeof narrator[field] !== 'string') throw new TypeError(`${label}: поле ${field} обязательно`)
  }
  if (!Number.isFinite(narrator.priority)) throw new TypeError(`${label}: приоритет обязан быть числом`)
  for (const method of ['matches', 'narrate']) {
    if (typeof narrator[method] !== 'function') throw new TypeError(`${label}: метод ${method} обязателен`)
  }
  if (narrator.suggestions != null && typeof narrator.suggestions !== 'function') {
    throw new TypeError(`${label}: suggestions, если объявлен, обязан быть функцией`)
  }
  return narrator
}

/** Первый рассказчик, узнавший свои события, либо `null`. */
export function deterministicNarratorFor(events) {
  const list = Array.isArray(events) ? events : []
  return NARRATORS.find((narrator) => narrator.matches(list)) ?? null
}

/**
 * Готовый ответ в том виде, в каком его ждёт оркестратор. `fallbackNarration`
 * подставляется, когда рассказчик узнал события, но текста не собрал: молчание
 * игроку не показывают.
 */
export function renderDeterministicNarration(narrator, { events, state, fallbackNarration = '', suggestions = null } = {}) {
  const narration = narrator.narrate(events, state) ?? fallbackNarration
  return {
    narration,
    suggestions: suggestions ?? (narrator.suggestions ? narrator.suggestions(events) : []),
    prompt_version: narrator.promptVersion,
    provider: narrator.provider,
  }
}
