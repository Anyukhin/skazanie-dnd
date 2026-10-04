// @ts-check
/**
 * Режимы реакций героя: «спрашивать», «сразу», «никогда» — как в Baldur's Gate 3.
 *
 * Модуль — **лист**: он ничего не импортирует из `server/` и только отвечает на
 * два вопроса. Какие реакции вообще настраиваются, и что делать с открытым
 * окном реакции, если хозяин героя уже решил за себя заранее. Само окно, его
 * варианты и их цену по-прежнему собирает Rules Engine — здесь нет ни одной
 * собственной проверки правил. Политика выбирает только из `action_ids`,
 * которые движок положил в окно теми же условиями, какими рисует кнопки
 * игроку, поэтому «сразу» не может сделать больше, чем сделал бы щелчок.
 *
 * Настраиваются только реакции, у которых в движке есть исполнитель. Окна
 * выбора, которые реакцией не являются (бонус Сопротивления, «Несгибаемый»),
 * и заготовленные действия всегда спрашивают: заготовку игрок сделал сам и
 * ровно для этого триггера, а у бонуса спасброска нет цены в реакции.
 */

/** @typedef {'ask' | 'auto' | 'never'} ReactionMode */
/** @typedef {Record<string, Record<string, ReactionMode>>} ReactionPreferences */

export const REACTION_MODE_SCHEMA_VERSION = 1

/** @type {readonly ReactionMode[]} */
export const REACTION_MODES = Object.freeze(['ask', 'auto', 'never'])

/**
 * Реакции, которым можно задать режим, — в том порядке, в каком «сразу»
 * выбирает между несколькими сразу предложенными. Сначала то, что отменяет уже
 * случившееся (вражеское заклинание, попадание), затем то, что уменьшает урон,
 * и только потом ответные удары: реакция в раунде одна, и потратить её на удар
 * вдогонку, когда можно было не получить урон, — худший из выборов.
 */
export const REACTION_PREFERENCE_IDS = Object.freeze([
  'cast:counterspell',
  'cast:shield',
  'cast:absorb-elements',
  'uncanny-dodge',
  'parry',
  'cast:hellish-rebuke',
  'riposte',
  'cast:silvery-barbs',
  'opportunity-attack',
])

const PREFERENCE_IDS = new Set(REACTION_PREFERENCE_IDS)
const MODES = new Set(REACTION_MODES)
// Окна выбора, которые не расходуют реакцию: здесь режимов нет.
const FREE_CHOICE_TRIGGERS = new Set(['failed-saving-throw', 'saving-throw-bonus-choice'])

/**
 * @param {unknown} value
 * @returns {value is ReactionMode}
 */
export function isReactionMode(value) {
  return typeof value === 'string' && MODES.has(/** @type {ReactionMode} */ (value))
}

/**
 * @param {unknown} reactionId
 * @returns {boolean}
 */
export function isConfigurableReaction(reactionId) {
  return typeof reactionId === 'string' && PREFERENCE_IDS.has(reactionId)
}

/**
 * Сохранённые режимы без мусора: только известные реакции и режимы. «Спрашивать»
 * — значение по умолчанию и не хранится, поэтому пустой герой выпадает целиком.
 *
 * @param {unknown} raw
 * @returns {ReactionPreferences}
 */
export function normalizeReactionPreferences(raw) {
  /** @type {ReactionPreferences} */
  const result = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [actorId, entries] of Object.entries(raw)) {
    if (!actorId || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue
    /** @type {Record<string, ReactionMode>} */
    const modes = {}
    for (const [reactionId, mode] of Object.entries(entries)) {
      if (isConfigurableReaction(reactionId) && isReactionMode(mode) && mode !== 'ask') modes[reactionId] = mode
    }
    if (Object.keys(modes).length) result[String(actorId)] = modes
  }
  return result
}

/**
 * @param {unknown} preferences
 * @param {string} actorId
 * @param {string} reactionId
 * @returns {ReactionMode}
 */
export function reactionModeFor(preferences, actorId, reactionId) {
  const entries = preferences && typeof preferences === 'object'
    ? /** @type {Record<string, unknown>} */ (preferences)[String(actorId)]
    : null
  const mode = entries && typeof entries === 'object'
    ? /** @type {Record<string, unknown>} */ (entries)[String(reactionId)]
    : null
  return isReactionMode(mode) ? mode : 'ask'
}

/**
 * Что сервер делает с окном реакции вместо вопроса. `null` — спрашивать: окно
 * остаётся открытым и ждёт игрока (или часов хода).
 *
 * - есть вариант в режиме «сразу» — выбирается он (первый по порядку
 *   `REACTION_PREFERENCE_IDS`, если таких несколько);
 * - все варианты окна в режиме «никогда» — отказ;
 * - иначе спрашивать. Один вариант «никогда» и другой «спрашивать» — всё ещё
 *   вопрос: отказаться за игрока от того, о чём он просил спросить, нельзя.
 *
 * Окно с вариантом без режима (заготовка, «Несгибаемый», выбор бонуса) не
 * трогается вовсе: решать за игрока часть окна значило бы молча снять с него
 * остальные варианты.
 *
 * @param {unknown} preferences `mechanics.reaction_preferences`
 * @param {Record<string, any> | null | undefined} window открытое окно реакции
 * @returns {{ mode: 'auto', action_id: string } | { mode: 'never', action_id: 'decline-reaction' } | null}
 */
export function planReactionByPreference(preferences, window) {
  if (!window || typeof window !== 'object') return null
  const actorId = String(window.actor_id ?? '')
  if (!actorId || window.free_choice === true || FREE_CHOICE_TRIGGERS.has(String(window.trigger ?? ''))) return null
  const offered = (Array.isArray(window.action_ids) ? window.action_ids : []).map(String)
  if (!offered.length || offered.some((id) => !PREFERENCE_IDS.has(id))) return null
  const modes = offered.map((id) => reactionModeFor(preferences, actorId, id))
  const automatic = REACTION_PREFERENCE_IDS.find((id) => offered.includes(id) && reactionModeFor(preferences, actorId, id) === 'auto')
  if (automatic) return { mode: 'auto', action_id: automatic }
  if (modes.every((mode) => mode === 'never')) return { mode: 'never', action_id: 'decline-reaction' }
  return null
}
