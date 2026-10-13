// @ts-check
/**
 * Корпус «команда → исход» для переноса движка на Rust
 * (`docs/rust-rewrite-plan.md`, §5).
 *
 * Включается переменной среды `DND_CORPUS_DIR`. Без неё модуль не делает
 * ничего: `corpusRecordingEnabled()` — единственная проверка на горячем пути.
 *
 * Пишется только команда верхнего уровня `resolveCommand`: вложенные команды —
 * часть родительской. Запись — строка JSON в `<dir>/corpus-<pid>.jsonl`:
 *
 * - `state` — sha256 нормализованного состояния до команды; само состояние
 *   лежит один раз в `<dir>/states/<sha>.json`. Производные поля героя
 *   (`combatSpells`, `combatActions`, `characterSheet`, `inventoryLoad`)
 *   выброшены: их пересчитывает любой движок, а размер они раздувают в разы;
 * - `command`, `context` — вход команды и сериализуемая часть контекста;
 * - `dice` — броски по порядку: метод, аргументы, результат;
 * - `outcome` — `{ ok: true, events, extract }` или `{ ok: false, code }`.
 *   `extract` — выжимка состояния после: то, по чему Rust сверяется, не
 *   повторяя форму JS-состояния.
 *
 * Модуль — лист: ничего не импортирует из `server/`, редьюсер и нормализацию
 * получает аргументами.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CORPUS_DIR = process.env.DND_CORPUS_DIR ? String(process.env.DND_CORPUS_DIR) : ''
const DERIVED_PLAYER_FIELDS = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
const CONTEXT_KEYS = ['isAdmin', 'isDirector', 'isNpcScheduler', 'serverAuthoritativeCombat', 'allowBlindTarget', 'allowedActorIds', 'reactionResolution', 'readiedRelease', 'additionalBeam']

export const CORPUS_SCHEMA_VERSION = 1

/** @returns {boolean} */
export function corpusRecordingEnabled() {
  return CORPUS_DIR !== ''
}

/** @param {unknown} value */
const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

/** @param {any} state */
function withoutDerived(state) {
  const copy = plain(state)
  if (Array.isArray(copy?.players)) {
    for (const player of copy.players) for (const field of DERIVED_PLAYER_FIELDS) delete player?.[field]
  }
  return copy
}

/** @param {any} context */
function serializableContext(context) {
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const key of CONTEXT_KEYS) if (context && Object.hasOwn(context, key)) result[key] = plain(context[key])
  return result
}

/**
 * Выжимка состояния: хиты, позиции, состояния, ресурсы, экономика хода,
 * смерть, концентрация, инвентарь и монеты, сцена. Порядок ключей устойчив.
 * @param {any} state
 */
export function corpusExtract(state) {
  const mechanics = state?.mechanics ?? {}
  /** @param {any} actor */
  const actorExtract = (actor) => {
    const id = String(actor?.id ?? '')
    return {
      id,
      hp: actor?.hp ?? null,
      max_hp: actor?.maxHp ?? null,
      alive: actor?.alive ?? null,
      position: mechanics.positions?.[id] ?? null,
      conditions: (mechanics.conditions?.[id] ?? []).map((/** @type {any} */ condition) => String(condition?.id ?? condition)).sort(),
      temporary_hp: mechanics.temporary_hp?.[id] ?? null,
      level: actor?.level ?? null,
      inventory: Array.isArray(actor?.inventory)
        ? actor.inventory.map((/** @type {any} */ item) => ({ id: String(item?.id ?? ''), quantity: item?.quantity ?? null, equipped: item?.equipped === true })).sort((/** @type {any} */ a, /** @type {any} */ b) => a.id.localeCompare(b.id))
        : null,
      currency: actor?.currency ?? null,
    }
  }
  const combat = mechanics.combat ?? {}
  return {
    players: (state?.players ?? []).map(actorExtract),
    enemies: (state?.enemies ?? []).map(actorExtract),
    resources: mechanics.resources ?? {},
    death: mechanics.death ?? null,
    concentration: Object.fromEntries(Object.entries(mechanics.concentration ?? {}).map(([id, value]) => [id, String(/** @type {any} */ (value)?.effect_id ?? '')])),
    combat: {
      active: combat.active === true,
      round: combat.round ?? null,
      active_index: combat.active_index ?? null,
      initiative: (combat.initiative ?? []).map((/** @type {any} */ entry) => String(entry?.actor_id ?? '')),
      action_economy: Object.fromEntries(Object.entries(combat.action_economy ?? {}).map(([id, economy]) => {
        const value = /** @type {any} */ (economy) ?? {}
        return [id, { action: value.action !== false, bonus_action: value.bonus_action !== false, reaction: value.reaction !== false, movement_spent: value.movement_spent ?? 0, attacks_used: value.attacks_used ?? 0 }]
      })),
      reaction_window: combat.reaction_window ? { trigger: combat.reaction_window.trigger ?? null, actor_id: combat.reaction_window.actor_id ?? null, action_ids: combat.reaction_window.action_ids ?? [] } : null,
    },
    scene: { location: state?.scene?.location ?? null, location_id: state?.scene?.location_id ?? null },
    state_version: state?.state_version ?? null,
  }
}

/**
 * Запись одной команды. `run` получает обёрнутый сервис костей и возвращает
 * результат `resolveCommand`; ошибка записывается кодом и пробрасывается.
 * @param {{ input: any, rawState: any, context: any, diceService: any, normalize: (state: any) => any, reduce: (state: any, event: any) => any, run: (dice: any) => any }} options
 */
export function recordCorpusCommand({ input, rawState, context, diceService, normalize, reduce, run }) {
  /** @type {Array<{ method: string, args: unknown, result: unknown }>} */
  const dice = []
  /** @param {string} method @param {unknown[]} args @param {unknown} result */
  const note = (method, args, result) => { dice.push({ method, args: plain(args), result: plain(result) }); return result }
  const recordingDice = {
    roll: (/** @type {any[]} */ ...args) => note('roll', args, diceService.roll(...args)),
    rollD20: (/** @type {any} */ options) => note('rollD20', [options], diceService.rollD20(options)),
    rollCheck: (/** @type {any} */ options) => note('rollCheck', [options], diceService.rollCheck(options)),
  }
  const before = normalize(rawState)
  const stateText = JSON.stringify(withoutDerived(before))
  const stateHash = createHash('sha256').update(stateText).digest('hex')
  const entry = { v: CORPUS_SCHEMA_VERSION, state: stateHash, command: plain(input), context: serializableContext(context), dice, outcome: /** @type {any} */ (null) }
  let result
  try {
    result = run(recordingDice)
  } catch (error) {
    entry.outcome = { ok: false, code: String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.name ?? 'ERROR') }
    write(entry, stateHash, stateText)
    throw error
  }
  try {
    const after = (result?.events ?? []).reduce(reduce, before)
    entry.outcome = { ok: true, events: plain(result?.events ?? []), extract: corpusExtract(after) }
  } catch (error) {
    entry.outcome = { ok: true, events: plain(result?.events ?? []), extract: null, extract_error: String(/** @type {any} */ (error)?.message ?? error).slice(0, 300) }
  }
  write(entry, stateHash, stateText)
  return result
}

/** @param {any} entry @param {string} stateHash @param {string} stateText */
function write(entry, stateHash, stateText) {
  try {
    const states = join(CORPUS_DIR, 'states')
    mkdirSync(states, { recursive: true })
    const stateFile = join(states, `${stateHash}.json`)
    if (!existsSync(stateFile)) writeFileSync(stateFile, stateText)
    appendFileSync(join(CORPUS_DIR, `corpus-${process.pid}.jsonl`), `${JSON.stringify(entry)}\n`)
  } catch { /* запись корпуса — лучшее усилие, на исход команды она не влияет */ }
}
