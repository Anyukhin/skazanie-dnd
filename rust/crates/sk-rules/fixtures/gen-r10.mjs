import '../../../fixtures-env.mjs'
// Эталоны задачи Р10: блоки проверки 71–73 (`UseCombatAction`, `MoveActor`)
// строками движка в области имён открытой копии, полный `resolveCommand` на
// ветках `UseCombatAction`, `MoveActor`, `EndTurn` и цепочки «пауза →
// ответ на окно реакции» (возобновление сохранённой команды по стенограмме
// костей).
//
// Состояния: состояния записей корпуса с командами Р10 и их синтетические
// варианты — к участникам добавлены состояния (сбит с ног, опутан, горит,
// «Гневная кара», «Сопротивление», повторные спасброски и счёт «Окаменения»,
// отложенный урон, «Героизм», «Приказ», дуэль, «Громовой клинок»),
// заготовки и окна реакции (атака по возможности, «Щит», «Поглощение
// стихий», «Адское возмездие», «Искусная острота», контрзаклинание,
// парирование, увёртливость, заготовленные действия).
//
// Разбор — `{ s, input, context, v, o }`: состояние, команда, контекст,
// кости (по кругу значений, приведённых к грани), исход. Цепочка — `{ from, input, context, v, o }`:
// `from` — номер разбора, после событий которого (полный список
// `events_full`) отвечают на окно.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-r10.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DiceService } from '../../../../server/dice-service.mjs'
import { blockFunction, loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0010_5eed
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const U = '__undefined__'

let uuidCounter = 0
globalThis.__SK_OPEN_COPY_UUID__ = () => `uuid-${++uuidCounter}`

function out(value) {
  if (value === undefined) return U
  const text = JSON.stringify(value)
  if (text === undefined) return U
  return text.length > 160 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function failure(error) {
  if (E.isCombatPause(error)) return { pause: error.constructor.name, window: out(error.windowEvent), command: out(error.command), prefix: out(error.prefixEvents ?? []) }
  if (error?.name !== 'RulesValidationError') return { fault: String(error?.name), message: String(error?.message ?? '') }
  return { err: [error.code, error.message] }
}
function attempt(fn) {
  try {
    return { ok: out(fn()) }
  } catch (error) {
    return failure(error)
  }
}
/** Кости по кругу значений, приведённые к грани: `min + (v − 1) mod (max − min + 1)`. */
class WrapRng {
  constructor(values) {
    this.values = values
    this.index = 0
  }

  randint(minimum, maximum) {
    const value = this.values[this.index++ % this.values.length]
    return minimum + ((value - 1) % (maximum - minimum + 1))
  }
}
function service(values) {
  let counter = 0
  return new DiceService({ rng: new WrapRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const diceValues = (n = 40) => Array.from({ length: n }, () => pick([1, 2, 3, 4, 5, 6, 2, 3, 4, 8, 10, 12, 15, 18, 20, 1, 3, 5, 7, 9]))
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}

// --- состояния корпуса ---------------------------------------------------------------

const TYPES = new Set(['UseCombatAction', 'MoveActor', 'EndTurn'])
const recordsByState = new Map()
for (const file of readdirSync(corpusDir).filter((name) => /^corpus-.*\.jsonl$/.test(name)).sort()) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (!TYPES.has(record?.command?.command_type)) continue
    if (!recordsByState.has(record.state)) recordsByState.set(record.state, [])
    recordsByState.get(record.state).push(record)
  }
}
const hashes = [...recordsByState.keys()].sort()
const corpusStates = []
const corpusCommands = []
for (const hash of hashes) {
  if (corpusStates.length >= 90) break
  const path = join(corpusDir, 'states', `${hash}.json`)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  if (text.length > 70_000) continue
  const state = JSON.parse(text)
  if (!(state.players ?? []).length) continue
  if (int(3) === 0 && corpusStates.length > 30) continue
  corpusStates.push(state)
  corpusCommands.push(recordsByState.get(hash).map((record) => ({ command: record.command, context: record.context ?? {} })))
}
if (!corpusStates.length) throw new Error(`нет корпуса в ${corpusDir}`)

// --- синтетика -----------------------------------------------------------------------

const ids = (state) => E.listActors(E.normalizeCampaignState(state)).map((actor) => E.actorId(actor))
function addCondition(state, id, condition) {
  state.mechanics ??= {}
  state.mechanics.conditions ??= {}
  state.mechanics.conditions[id] = [...(state.mechanics.conditions[id] ?? []), condition]
}
function conditionFor(source) {
  return pick([
    'prone', { id: 'prone' }, { id: 'restrained', source_actor: source, effect_id: pick(['eff-web', 'eff-c']), escape_dc: pick([12, 15, U]), ...(chance(0.2) ? { no_escape: true } : {}) },
    { id: 'rime-encased', source_actor: source }, { id: 'wrathful-smite-frightened', source_actor: source, effect_id: pick(['eff-ws', 'eff-c']), save_dc: 13 },
    { id: 'otto-dance', action_save_ability: 'wis', save_dc: 14, spell_id: 'otto', source_actor: source, effect_id: pick(['eff-ot', 'eff-c']) },
    { id: 'searing-smite-flames', source_actor: source, effect_id: pick(['eff-ss', 'eff-c']) }, { id: 'alchemists-fire-flames' },
    { id: 'expeditious-retreat' }, { id: 'pass-without-trace' }, { id: 'silvery-fortune', effect_id: 'eff-sf' },
    { id: pick(['frightened', 'paralyzed', 'poisoned', 'charmed']), repeat_save_timing: 'turn-end', save_ability: pick(['wis', 'con', '']), save_dc: pick([12, 15, '14']), spell_id: pick(['hold-person', 'fear', 'tasha']), source_actor: source, effect_id: pick(['eff-c', 'eff-r', U]), ...(chance(0.3) ? { repeat_save_ends_concentration: false } : {}), ...(chance(0.25) ? { repeat_save_tally: 3, tally_successes: int(3), tally_failures: int(3), tally_failure_condition: 'petrified' } : {}) },
    { id: 'acid-arrow', recurring_damage: '2d4', recurring_damage_type: 'acid', recurring_damage_timing: 'turn-end', spell_id: 'melfs-acid-arrow', source_actor: source, recurring_once: true, effect_id: 'eff-aa' },
    { id: 'burning', recurring_damage: pick(['1d10', '2d6']), recurring_damage_type: 'fire', spell_id: 'searing', source_actor: source, ...(chance(0.5) ? { start_turn_save: 'con', save_dc: 13 } : {}), effect_id: pick(['eff-c', 'eff-b']), ...(chance(0.3) ? { recurring_once: true } : {}) },
    { id: 'heroism', temporary_hp_amount: pick([3, 4, 0]), source_actor: source }, { id: pick(['command:grovel', 'command:halt', 'command:flee']), source_actor: source, effect_id: 'eff-cmd' },
    { id: 'compelled-duel', source_actor: source, effect_id: 'eff-duel' }, { id: 'booming-blade-move:2d8', source_actor: source },
    { id: 'resistance-d4', source_actor: source, ...(chance(0.5) ? { effect_id: 'eff-res' } : {}) }, { id: 'disengaged' }, { id: 'raging' }, { id: 'hunters-mark:x' },
    { id: 'unconscious' }, { id: 'expeditious-retreat' },
  ])
}
function windowFor(state, hero, enemy) {
  const kind = pick(['opportunity', 'shield', 'absorb', 'rebuke', 'barbs', 'counter', 'parry', 'dodge', 'readied', 'riposte', 'resistance', 'indomitable', 'bare'])
  const base = { id: `window-${kind}-${int(1000)}`, actor_id: hero, source_actor_id: enemy, target_id: hero, damage: chance(0.7) ? { applied_amount: pick([0, 4, 9]), temporary_hp_absorbed: pick([0, 2]), damage_type: pick(['fire', 'slashing', 'cold']), hp_before: 20, hp_after: 11, ...(chance(0.2) ? { resistant: true } : {}) } : null }
  const option = (id, extra = {}) => ({ id, name: id, resource: null, cost: 1, ...extra })
  switch (kind) {
    case 'opportunity': return { ...base, trigger: 'enemy-left-reach', source_previous_position: { x: 1, y: 1 }, action_ids: ['opportunity-attack'], action_options: [option('opportunity-attack')] }
    case 'shield': return { ...base, trigger: 'attack-shield-choice', action_ids: ['cast:shield'], action_options: [option('cast:shield', { resource: 'spell_slots_1', slot_level: 1 })], trigger_roll: { kept: pick([11, 20, 15]), modifier: 3, total: 14, armor_class: 13, critical: chance(0.2) } }
    case 'absorb': return { ...base, trigger: 'elemental-damage', action_ids: ['cast:absorb-elements'], action_options: [option('cast:absorb-elements', { resource: 'spell_slots_1', slot_level: 1 })] }
    case 'rebuke': return { ...base, trigger: 'damaged-by-creature', action_ids: ['cast:hellish-rebuke'], action_options: [option('cast:hellish-rebuke', { resource: 'spell_slots_1', slot_level: 1 })] }
    case 'barbs': return { ...base, trigger: 'enemy-attack-hit', action_ids: ['cast:silvery-barbs'], action_options: [option('cast:silvery-barbs', { resource: 'spell_slots_1', slot_level: 1 })], trigger_roll: { kept: pick([12, 20, 1]), modifier: 4, total: 16, armor_class: pick([14, 17]) } }
    case 'counter': return { ...base, trigger: 'enemy-casts-spell', action_ids: ['cast:counterspell'], action_options: [option('cast:counterspell', { resource: 'spell_slots_3', slot_level: 3 })], pending_spell_command: { command_type: 'CastSpell', command_id: 'enemy-spell', actor_id: enemy, spell_id: pick(['fire-bolt', 'fireball', 'hold-person']), slot_level: pick([1, 3, 5, U]), target_ids: [hero], spell_slot_resource: pick(['spell_slots_3', U]) } }
    case 'parry': return { ...base, trigger: 'melee-hit', action_ids: ['parry'], action_options: [option('parry')] }
    case 'dodge': return { ...base, trigger: 'attack-hit', action_ids: ['uncanny-dodge'], action_options: [option('uncanny-dodge')] }
    case 'riposte': return { ...base, trigger: 'enemy-missed', action_ids: ['riposte'], action_options: [option('riposte', { resource: 'superiority_dice' })] }
    case 'readied': return { ...base, trigger: 'readied', readied_trigger: 'enemy-approaches', action_ids: [pick(['readied-attack', 'readied-spell'])], action_options: [option('readied-attack')] }
    case 'resistance': return { ...base, trigger: 'saving-throw-bonus-choice', action_ids: ['use-resistance', 'roll-first-resistance', 'skip-resistance'], action_options: [], pending_resistance_choice: { target_id: hero, save_key: `${hero}:spell_repeat_save:x:wis:1`, phase: pick(['before-roll', 'after-roll']) }, pending_command: { command_type: 'EndTurn', command_id: 'pending-end', actor_id: hero }, pending_dice_transcript: [] }
    case 'indomitable': return { ...base, trigger: 'failed-saving-throw', action_ids: ['indomitable'], action_options: [option('indomitable')], failed_roll_id: 'roll-x', trigger_roll: { total: 9 }, pending_command: { command_type: 'EndTurn', command_id: 'pending-end', actor_id: hero }, pending_dice_transcript: [], ...(chance(0.4) ? { pending_indomitable_queue: [{ target_id: hero, fighter_level: 9, failed_event: { event_type: 'SavingThrowResolved', payload: { roll_id: 'r2', kept: 4, modifier: 1, total: 5, difficulty: 13, ability: 'wis' } } }] } : {}) }
    default: return { ...base, trigger: 'bare', action_ids: ['decline-reaction'], action_options: [] }
  }
}
function variant(base) {
  const state = json(base)
  const all = ids(state)
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  for (let n = int(4); n > 0; n -= 1) addCondition(state, pick(all), conditionFor(pick(all)))
  state.mechanics ??= {}
  if (chance(0.4) && state.mechanics.combat?.active) {
    state.mechanics.combat.readied = { ...(state.mechanics.combat.readied ?? {}), [pick(all)]: chance(0.5) ? { trigger: 'enemy-approaches', item_id: null } : { trigger: pick(['enemy-approaches', 'enemy-casts-spell']), spell_id: 'fire-bolt', spell_name: 'Огненный снаряд', slot_level: 1, effect_id: 'readied:x' } }
  }
  if (chance(0.45) && state.mechanics.combat?.active && heroes.length) {
    const enemies = all.filter((id) => !heroes.includes(id))
    state.mechanics.combat.reaction_window = windowFor(state, pick(heroes), pick(enemies.length ? enemies : all))
  }
  if (chance(0.3)) state.ruleset_id = pick(['dnd_5e_2014', 'srd_5_2_1'])
  if (chance(0.3)) {
    state.mechanics.concentration ??= {}
    state.mechanics.concentration[pick(all)] = { effect_id: pick(['eff-c', 'eff-r', 'eff-web', 'eff-ws']), spell_id: 'x' }
  }
  if (chance(0.3)) {
    state.mechanics.resources ??= {}
    const id = pick(all)
    state.mechanics.resources[id] = { ...(state.mechanics.resources[id] ?? {}), spell_slots_1: { current: pick([0, 2]), max: 2 }, spell_slots_3: { current: pick([0, 1]), max: 2 }, superiority_dice: { current: pick([0, 3]), max: 4 }, indomitable: { current: 1, max: 1 }, ki: { current: 3, max: 3 } }
  }
  return state
}
const states = [...corpusStates]
const commandsFor = [...corpusCommands]
for (let index = 0; index < corpusStates.length * 2; index += 1) {
  const base = int(corpusStates.length)
  try {
    const state = variant(corpusStates[base])
    E.normalizeCampaignState(state)
    states.push(state)
    commandsFor.push(corpusCommands[base])
  } catch { /* вариант не нормализуется */ }
}
// «Мастерская»: тот же бой, но ход у выбранного участника, экономика хода
// свежая, окна реакции нет (или синтетическое), на участнике — состояния
// под проверяемый приём. Так доходят до своих веток приёмы, которые в
// случайных командах отсекает проверка хода.
const ECONOMY = { action: true, bonus_action: true, reaction: true, movement: true, object_interaction: true, movement_spent: 0, movement_path: [], movement_bonus: 0, extra_actions: 0, surged_action_only: false, attacks_used: 0, attacks_allowed: 1, loading_weapon_item_ids: { action: [], bonus_action: [], reaction: [] } }
const workshopActors = []
function workshop(base) {
  const state = json(base)
  const combat = state.mechanics?.combat
  if (!combat?.active || !combat.initiative?.length) return null
  const index = int(combat.initiative.length)
  const actor = String(combat.initiative[index].actor_id)
  combat.active_index = index
  combat.turn_completed = []
  combat.action_economy = Object.fromEntries(combat.initiative.map((entry) => [String(entry.actor_id), json(ECONOMY)]))
  combat.reaction_window = null
  const all = ids(state)
  const heroes = (state.players ?? []).map((hero) => E.actorId(hero))
  for (let n = int(4); n > 0; n -= 1) addCondition(state, chance(0.6) ? actor : pick(all), conditionFor(pick(all)))
  if (chance(0.25)) {
    state.ruleset_id = 'dnd_5e_2014'
    addCondition(state, actor, { id: 'resistance-d4', source_actor: pick(all), effect_id: 'eff-res' })
    addCondition(state, actor, { id: 'frightened', repeat_save_timing: 'turn-end', save_ability: 'wis', save_dc: 15, spell_id: 'cause-fear', source_actor: pick(all), effect_id: 'eff-c' })
  }
  state.mechanics.resources ??= {}
  state.mechanics.resources[actor] = { ...(state.mechanics.resources[actor] ?? {}), spell_slots_1: { current: 2, max: 2 }, spell_slots_2: { current: 1, max: 1 }, spell_slots_3: { current: 1, max: 2 }, superiority_dice: { current: 3, max: 4 }, indomitable: { current: 1, max: 1 }, second_wind: { current: 1, max: 1 }, action_surge: { current: 1, max: 1 }, ki: { current: 3, max: 3 }, rage: { current: 2, max: 3 } }
  if (chance(0.3) && heroes.length) {
    const hero = pick(heroes)
    const enemies = all.filter((id) => !heroes.includes(id))
    combat.reaction_window = windowFor(state, hero, pick(enemies.length ? enemies : all))
    state.mechanics.resources[hero] = { ...(state.mechanics.resources[hero] ?? {}), spell_slots_1: { current: 2, max: 2 }, spell_slots_3: { current: 1, max: 2 }, superiority_dice: { current: 2, max: 4 } }
  }
  return { state, actor }
}
for (let index = 0; index < corpusStates.length * 3; index += 1) {
  const base = int(corpusStates.length)
  try {
    const made = workshop(corpusStates[base])
    if (!made) continue
    E.normalizeCampaignState(made.state)
    workshopActors[states.length] = made.actor
    states.push(made.state)
    commandsFor.push(corpusCommands[base])
  } catch { /* вариант не нормализуется */ }
}
const snapshots = states.map((state) => JSON.stringify(state))

// --- блоки проверки 71–73 --------------------------------------------------------------

const block = await blockFunction([[7609, 7824]], ["if (command.command_type === 'UseCombatAction' && (command.server_authoritative || context.serverAuthoritativeCombat)) {"], ['state', 'command', 'context'], 'return command')
const ACTIONS = ['dash', 'disengage', 'dodge', 'hide', 'help', 'stabilize', 'first-aid', 'shove', 'grapple', 'second-wind', 'action-surge', 'stand-up', 'break-free', 'steady-nerves', 'extinguish-self', 'extinguish-ally',
  'ready-action', 'readied-attack', 'readied-spell', 'opportunity-attack', 'decline-reaction', 'indomitable', 'use-resistance', 'roll-first-resistance', 'skip-resistance', 'cast:shield', 'cast:absorb-elements', 'cast:hellish-rebuke',
  'cast:silvery-barbs', 'cast:counterspell', 'parry', 'riposte', 'uncanny-dodge', 'rage', 'flurry-of-blows', 'martial-arts-strike', 'trip-attack', 'menacing-attack', 'hunters-mark', 'divine-spark', 'divine-smite', 'lay-on-hands',
  'font-of-magic', 'wild-shape', 'turn-undead', 'enervation-repeat', 'expeditious-retreat-dash', 'breath-weapon', 'cunning-action-dash', 'x-unknown']
function actionIdsFor(state, id) {
  const actor = E.findActor(state, id)
  return [...(actor?.combatActions ?? []).map((action) => action.id), ...ACTIONS]
}
/** Ближайший к участнику другой участник (приёмы вплотную: толчок, захват, помощь). */
function nearest(state, actor, all) {
  const at = E.actorPosition(state, actor)
  if (!at) return pick(all)
  let best = null
  let bestDistance = Infinity
  for (const id of all) {
    if (id === actor) continue
    const other = E.actorPosition(state, id)
    if (!other) continue
    const distance = Math.max(Math.abs(other.x - at.x), Math.abs(other.y - at.y))
    if (distance < bestDistance) { best = id; bestDistance = distance }
  }
  return best ?? pick(all)
}
function combatInput(state, n, base, forced) {
  const all = E.listActors(state).map((actor) => E.actorId(actor))
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  const window = state.mechanics.combat.reaction_window
  const actor = window && chance(0.5) ? String(window.actor_id) : forced && chance(0.9) ? forced : chance(0.75) && base?.actor_id ? base.actor_id : pick(chance(0.8) ? heroes : all)
  const input = {
    command_type: 'UseCombatAction', command_id: `r10-${n}`, campaign_id: 'camp', actor_id: actor, expected_state_version: state.state_version,
    action_id: window && chance(0.4) ? pick([...(window.action_ids ?? []), 'decline-reaction']) : chance(0.3) && base?.action_id ? base.action_id : pick(actionIdsFor(state, actor)),
  }
  if (chance(0.85)) input.server_authoritative = true
  if (chance(0.6)) input.target_id = chance(0.5) ? nearest(state, actor, all) : pick(all)
  if (chance(0.15)) input.shove_mode = pick(['push', 'prone', 'x'])
  if (chance(0.2)) input.readied_trigger = pick(['enemy-approaches', 'enemy-casts-spell', 'x', 'constructor'])
  if (chance(0.15)) input.readied_spell_id = pick(['fire-bolt', 'magic-missile', 'shield', 'fireball'])
  if (chance(0.15)) input.slot_level = pick([1, 2, 3, 4])
  if (chance(0.1)) input.beneficiary_id = pick(all)
  if (chance(0.1)) input.auto_skip_reason = pick(['turn-timeout', 'reaction-preference'])
  if (chance(0.1)) input.visibility = pick(['party', 'gm_only'])
  return input
}
function moveInput(state, n, base, forced) {
  const all = E.listActors(state).map((actor) => E.actorId(actor))
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  const actor = forced && chance(0.9) ? forced : chance(0.6) && base?.actor_id ? base.actor_id : pick(chance(0.6) ? heroes : all)
  const at = E.actorPosition(state, actor) ?? { x: 3, y: 3 }
  const reach = pick([1, 1, 2, 3, 6, 10])
  const input = {
    command_type: 'MoveActor', command_id: `r10-${n}`, campaign_id: 'camp', actor_id: actor, expected_state_version: state.state_version,
    to: chance(0.3) && base?.to ? base.to : { x: at.x + int(2 * reach + 1) - reach, y: at.y + int(2 * reach + 1) - reach },
  }
  if (chance(0.7)) input.server_authoritative = true
  if (chance(0.1)) input.reaction_movement = true
  if (chance(0.1)) input.movement_mode = pick(['long_jump', 'swing', 'fly'])
  if (chance(0.1)) input.jump_running_start = true
  if (chance(0.1)) input.monster_ability = 'aggressive'
  if (chance(0.05)) input.to = pick([{ x: 'a', y: 1 }, { x: 1.5, y: 2 }])
  if (chance(0.1)) input.from = { x: at.x, y: at.y }
  if (chance(0.1)) input.distance = pick([10, '15', 'x'])
  return input
}
function endInput(state, n) {
  const combat = state.mechanics.combat
  const active = combat.initiative?.[combat.active_index]?.actor_id ?? (state.players?.[0] && E.actorId(state.players[0]))
  const input = { command_type: 'EndTurn', command_id: `r10-${n}`, campaign_id: 'camp', actor_id: chance(0.9) ? active : E.actorId(pick(E.listActors(state))), expected_state_version: state.state_version }
  if (chance(0.3)) input.server_authoritative = true
  if (chance(0.2)) input.auto_skip_reason = 'turn-timeout'
  return input
}
const CONTEXTS = [{ isAdmin: true }, { isAdmin: true, serverAuthoritativeCombat: true }, { isAdmin: true, serverAuthoritativeCombat: true, isNpcScheduler: true }, { isAdmin: true, indomitableResume: true }, {}]

const blocks = []
for (let n = 0; n < 1400; n += 1) {
  const s = int(states.length)
  const state = E.normalizeCampaignState(states[s])
  const raw = chance(0.6) ? combatInput(state, n, pick(commandsFor[s]).command) : moveInput(state, n, pick(commandsFor[s]).command)
  let command
  try {
    command = E.normalizeCommand(json(raw), state)
  } catch { continue }
  const context = pick(CONTEXTS)
  blocks.push({ s, command: json(command), context, o: attempt(() => block(state, structuredClone(command), context)) })
}

// --- разбор целиком ----------------------------------------------------------------

const resolves = []
const seen = new Map()
const note = (events) => { for (const event of events ?? []) seen.set(event.event_type, (seen.get(event.event_type) ?? 0) + 1) }
function resolveCase(s, input, context, values, keepEvents) {
  uuidCounter = 0
  let full = null
  const o = attempt(() => {
    const result = E.resolveCommand(json(input), json(states[s]), { diceService: service(values), context: json(context) })
    note(result.events)
    if (keepEvents) full = json(result.events)
    return { command: result.command, events: result.events, rolls: result.rolls }
  })
  return { o, full }
}
const chainSources = []
for (let n = 0; n < 40000 && resolves.length < 4200; n += 1) {
  const s = n % 2 === 0 && workshopActors.length ? pick(Object.keys(workshopActors).map(Number)) : int(states.length)
  const forced = workshopActors[s]
  const state = E.normalizeCampaignState(states[s])
  const base = pick(commandsFor[s])
  const roll = random()
  const type = base && chance(0.35) ? base.command.command_type : roll < 0.45 ? 'UseCombatAction' : roll < 0.75 ? 'MoveActor' : 'EndTurn'
  let input
  if (base && chance(0.12)) input = { ...json(base.command), command_id: `r10-${n}` }
  else if (type === 'UseCombatAction') input = combatInput(state, n, base?.command, forced)
  else if (type === 'MoveActor') input = moveInput(state, n, base?.command, forced)
  else {
    if (!state.mechanics.combat?.active && chance(0.8)) continue
    input = endInput(state, n)
  }
  const context = base && chance(0.5) ? base.context : pick(CONTEXTS)
  const values = diceValues()
  const { o, full } = resolveCase(s, input, context, values, true)
  const windowOpened = full?.some((event) => event.event_type === 'ReactionWindowOpened')
  const entry = { s, input, context, v: values, o }
  if (windowOpened) {
    entry.events_full = full
    chainSources.push(resolves.length)
  }
  resolves.push(entry)
}

// Обход приёмов: каждый приём участника, у которого ход, по ближайшей цели.
{
  const shops = Object.keys(workshopActors).map(Number)
  let added = 0
  for (const s of shops) {
    if (added >= 2600) break
    const state = E.normalizeCampaignState(states[s])
    const actor = workshopActors[s]
    const all = E.listActors(state).map((entry) => E.actorId(entry))
    for (const actionId of [...new Set(actionIdsFor(state, actor))]) {
      if (chance(0.45)) continue
      const input = { command_type: 'UseCombatAction', command_id: `sweep-${added}`, campaign_id: 'camp', actor_id: actor, expected_state_version: state.state_version, action_id: actionId, server_authoritative: true,
        target_id: chance(0.7) ? nearest(state, actor, all) : pick(all), ...(chance(0.3) ? { shove_mode: pick(['push', 'prone']) } : {}), ...(chance(0.3) ? { readied_trigger: 'enemy-approaches' } : {}) }
      const context = { isAdmin: true, serverAuthoritativeCombat: true, ...(chance(0.3) ? { isNpcScheduler: true } : {}) }
      const values = diceValues()
      const { o, full } = resolveCase(s, input, context, values, true)
      const entry = { s, input, context, v: values, o }
      if (full?.some((event) => event.event_type === 'ReactionWindowOpened')) {
        entry.events_full = full
        chainSources.push(resolves.length)
      }
      resolves.push(entry)
      added += 1
    }
  }
}

// --- цепочки: ответ на окно (до трёх ответов подряд) -----------------------------------

const chains = []
function answerWindow(after, origin, depth) {
  const window = after.mechanics.combat?.reaction_window
  if (!window) return
  const answers = [...new Set(['decline-reaction', ...(window.action_ids ?? [])])]
  for (const actionId of answers) {
    for (let rep = 0; rep < (actionId === 'decline-reaction' ? 2 : 1); rep += 1) {
      const input = {
        command_type: 'UseCombatAction', command_id: `chain-${chains.length}-${actionId}-${rep}`, campaign_id: 'camp', actor_id: String(window.actor_id), action_id: actionId,
        server_authoritative: true, expected_state_version: after.state_version,
        ...(window.source_actor_id && actionId !== 'decline-reaction' ? { target_id: String(window.source_actor_id) } : {}),
        ...(actionId === 'decline-reaction' && rep === 1 ? { auto_skip_reason: pick(['turn-timeout', 'reaction-preference']) } : {}),
      }
      const context = { isAdmin: true, serverAuthoritativeCombat: true }
      const values = diceValues()
      uuidCounter = 0
      let full = null
      const o = attempt(() => {
        const result = E.resolveCommand(json(input), json(after), { diceService: service(values), context: json(context) })
        note(result.events)
        full = json(result.events)
        return { command: result.command, events: result.events, rolls: result.rolls }
      })
      const entry = { ...origin, input, context, v: values, o }
      const opened = full?.some((event) => event.event_type === 'ReactionWindowOpened')
      if (opened && depth < 3) entry.events_full = full
      const index = chains.length
      chains.push(entry)
      if (opened && depth < 3) {
        let next
        try { next = full.reduce(E.applyGameEvent, after) } catch { continue }
        answerWindow(next, { chain: index }, depth + 1)
      }
    }
  }
}
for (const index of chainSources) {
  const source = resolves[index]
  let after
  try {
    after = source.events_full.reduce(E.applyGameEvent, E.normalizeCampaignState(json(states[source.s])))
  } catch { continue }
  answerWindow(after, { from: index }, 1)
}

const mutated = states.map((state, index) => (JSON.stringify(state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(', ')}`)
const output = { source_sha256: sourceSha256(), states, blocks, resolves, chains }
const text = `${JSON.stringify(output)}\n`
const gz = gzipSync(text, { level: 9 })
writeFileSync(new URL('r10.json.gz', import.meta.url), gz)
const count = (list) => list.filter((entry) => entry.o.ok !== undefined).length
const pauses = (list) => list.filter((entry) => entry.o.pause !== undefined).length
console.log([...seen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log(`r10.json.gz: ${(gz.length / 1e6).toFixed(2)} МБ (JSON ${(text.length / 1e6).toFixed(1)} МБ), состояний ${states.length}, блоков ${blocks.length} (ok ${count(blocks)}), разборов ${resolves.length} (ok ${count(resolves)}, пауз ${pauses(resolves)}, с окном ${chainSources.length}), цепочек ${chains.length} (ok ${count(chains)}, пауз ${pauses(chains)})`)
