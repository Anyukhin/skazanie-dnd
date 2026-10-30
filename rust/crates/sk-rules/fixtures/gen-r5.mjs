import '../../../fixtures-env.mjs'
// Эталоны задачи Р5: заклинания-помощники (компоненты, ячейки, лучи,
// «Обессиливание»), реакции, последствия областей, замыкания
// `resolveCommandInternal` (через строки движка в области имён открытой
// копии), хвост последствий и обёртки на ветках Р5 (`resolveCommand`,
// `resolveCommands`), удар-открытие (`openingStrikeFor`,
// `openingStrikeTurnState`), блок проверки 8 (социальная проверка).
//
// Состояния: записи корпуса (`tmp/corpus-v1/states`, без `scene.map`) и их
// синтетические варианты — к героям и противникам корпуса добавлены
// состояния, концентрация, длящиеся области, ресурсы и снаряжение.
//
// Вызов — `{ f, s, a, o }`, как у `gen-vitals.mjs` (`U` — `undefined`,
// `{ "$actor": id }` — участник состояния, `{ "$spell": [id, spellId] }` —
// заклинание героя `combatSpellFor`, `{ "$canon": spellId }` — карточка
// `canonicalCombatSpellFor` в редакции состояния). Замыкания — `probes`:
// команда после `validateCommand`, контекст, кости, вызов, исход, события,
// броски и стенограмма.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-r5.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { materializeCatalogItem } from '../../../../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { blockFunction, loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0005_5eed
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
/** Состояние без производных полей героя (как запись корпуса). */
function stripDerived(state) {
  const copy = json(state)
  for (const player of copy?.players ?? []) for (const field of ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']) delete player[field]
  return copy
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const U = '__undefined__'

let uuidCounter = 0
globalThis.__SK_OPEN_COPY_UUID__ = () => `uuid-${++uuidCounter}`

function out(value) {
  if (value === undefined) return U
  if (value instanceof Set) value = [...value].sort()
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
function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const diceValues = (n = 30) => Array.from({ length: n }, () => pick([1, 2, 3, 4, 1, 2, 3, 4, 2, 3, 4, 3, 4, 1, 2, 3, 4, 15, 20, 18]))

// --- состояния ----------------------------------------------------------------------

const strip = (state) => {
  const copy = json(state)
  if (copy.scene) delete copy.scene.map
  return copy
}
const corpusStates = []
if (existsSync(join(corpusDir, 'states'))) {
  const files = readdirSync(join(corpusDir, 'states')).sort()
  for (const file of files) {
    if (corpusStates.length >= 60) break
    const path = join(corpusDir, 'states', file)
    if (statSync(path).size > 45_000) continue
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (!(state.players ?? []).length) continue
    if (int(4) !== 0) continue
    corpusStates.push(strip(state))
  }
}
if (!corpusStates.length) throw new Error(`нет корпуса в ${corpusDir}`)

const ITEMS = ['srd_5_2_1:component-pouch', 'srd_5_2_1:arcane-focus-wand', 'srd_5_2_1:holy-symbol-amulet', 'srd_5_2_1:holy-symbol-emblem', 'srd_5_2_1:druidic-focus-totem', 'srd_5_2_1:lute',
  'srd_5_2_1:diamond-50gp', 'srd_5_2_1:longsword', 'srd_5_2_1:shield', 'srd_5_2_1:greatsword', 'srd_5_2_1:chain-mail', 'srd_5_2_1:dagger', 'srd_5_2_1:material-diamond-dust-100gp']
function gear(ownerId) {
  const items = []
  for (let n = int(4); n > 0; n -= 1) {
    try {
      items.push(materializeCatalogItem(pick(ITEMS), { id: `gear-${ownerId}-${n}`, quantity: pick([1, 1, 2, 6, 0]), equipped: chance(0.6) }))
    } catch { /* предмет вне каталога */ }
  }
  return items
}
const CONDITIONS = ['bless-d4', 'bane-d4', 'next-save-minus-d4', 'guidance-d4', 'silvery-fortune', 'shielded', 'blinded', 'paralyzed', 'stunned', 'unconscious', 'invisible', 'disengaged', 'metamagic-subtle',
  'silenced', 'healing-blocked', 'freedom-of-movement', 'beacon-of-hope', 'raging', 'uncanny-dodge', 'fled', 'prone', 'poisoned', 'zephyr-strike']
function conditionFor(id, ids) {
  const kind = pick([...CONDITIONS, 'resistance-d4', 'bardic-inspiration', 'resistance-damage:fire', 'oil', 'invisibility', 'duel', 'repeat', 'break', 'allies'])
  const source = pick(ids)
  switch (kind) {
    case 'resistance-d4': return { id: 'resistance-d4', source_actor: source, ...(chance(0.6) ? { effect_id: pick(['eff-res', 'eff-x']) } : {}) }
    case 'bardic-inspiration': return { id: 'bardic-inspiration', source_actor: source }
    case 'resistance-damage:fire': return { id: pick(['resistance-damage:fire', 'resistance-damage:cold']), ...(chance(0.3) ? { last_used_turn: 'combat:1:x' } : {}) }
    case 'oil': return { id: 'oiled', fire_damage_bonus: pick([5, '3', 0]) }
    case 'invisibility': return { id: 'invisible', spell_id: 'invisibility', ...(chance(0.5) ? { effect_id: 'eff-inv' } : {}) }
    case 'duel': return { id: 'compelled-duel', source_actor: source, effect_id: pick(['eff-duel', 'eff-x']), break_on_damage_from_source_allies: chance(0.5) }
    case 'repeat': return { id: pick(['frightened', 'poisoned', 'charmed']), repeat_save_on_damage: true, save_ability: pick(['wis', 'con', '']), save_dc: pick([12, 15, '14', U]), spell_id: 'tasha', source_actor: source, effect_id: pick(['eff-r', U]), damage_save_advantage: chance(0.3) }
    case 'break': return { id: 'charmed', break_on_any_damage: true, spell_id: 'hypnotic-pattern', ...(chance(0.5) ? { effect_id: 'eff-hp' } : {}) }
    case 'allies': return { id: 'restrained', break_on_damage_from_source_allies: true, source_actor: source, effect_id: pick(['eff-a', U]), spell_id: 'x' }
    case 'silvery-fortune': return chance(0.5) ? { id: 'silvery-fortune', effect_id: 'eff-sf' } : { id: 'silvery-fortune' }
    case 'bless-d4': return chance(0.3) ? { id: 'bless-d4', bonus_enabled: false } : { id: 'bless-d4' }
    case 'next-save-minus-d4': return chance(0.5) ? { id: 'next-save-minus-d4', effect_id: 'eff-ms' } : { id: 'next-save-minus-d4' }
    default: return chance(0.15) ? kind : { id: kind }
  }
}
const AREAS = [
  { spell_id: 'cloud-of-daggers', damage: '4d4', damage_type: 'slashing', trigger_on_enter: true, trigger_on_turn_start: true, once_per_turn: true },
  { spell_id: 'moonbeam', damage: '2d10', damage_type: 'radiant', save_ability: 'con', save_dc: 13, half_on_save: true, trigger_on_enter: true, trigger_on_turn_start: true, once_per_turn: true },
  { spell_id: 'web', condition: 'restrained', save_ability: 'dex', save_dc: 12, trigger_on_enter: true, trigger_on_turn_start: true, skip_already_affected: true },
  { spell_id: 'stinking-cloud', save_ability: 'con', save_dc: 14, spend_action_on_fail: true, failed_action_name: 'Тошнота', trigger_on_turn_start: true, condition: 'poisoned' },
  { spell_id: 'sleet-storm', save_ability: 'dex', save_dc: 15, condition: 'prone', trigger_on_turn_start: true, concentration_save_on_turn_start: true, trigger_on_enter: true },
  { spell_id: 'spirit-guardians', damage: '3d8', damage_type: 'radiant', save_ability: 'wis', save_dc: 14, half_on_save: true, trigger_on_enter: true, trigger_on_turn_start: true, follows_source: true },
  { spell_id: 'healing-spirit', healing: '1d6', trigger_on_enter: true, trigger_on_turn_start: true },
  { spell_id: 'caltrops', damage_amount: 1, damage_type: 'piercing', trigger_on_enter: true, save_ability: 'dex', save_dc: 15 },
  { spell_id: 'gust', save_ability: 'str', save_dc: 13, push_feet: 10, trigger_on_turn_end: true },
  { spell_id: 'sickening-radiance', damage: '4d10', damage_type: 'radiant', save_ability: 'con', save_dc: 15, condition: 'exhaustion', trigger_on_turn_start: true, trigger_on_enter: true },
  { spell_id: 'blizzard', damage: '2d6', damage_type: 'cold', turn_start_profile: { save_ability: 'con', save_dc: 13, condition: 'slowed', condition_duration: '1-round' }, trigger_on_turn_end: true },
]
function area(center, sourceId, index) {
  const base = pick(AREAS)
  return {
    effect_id: `area-${index}`, ...base, source_actor: sourceId, center, shape: pick(['sphere', 'cube']), radius: pick([10, 15, 20]),
    ...(chance(0.2) ? { triggered_turns: { [sourceId]: '1:0' } } : {}),
    ...(chance(0.15) ? { unaffected_actor_ids: [sourceId] } : {}),
  }
}
function variant(base, index) {
  const state = json(base)
  state.mechanics ??= {}
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  if (!ids.length) return state
  if (chance(0.5)) state.ruleset_id = pick(['dnd_5e_2014', 'srd_5_2_1'])
  const conditions = state.mechanics.conditions ?? {}
  for (const id of ids) if (chance(0.6)) conditions[id] = [...(conditions[id] ?? []), ...Array.from({ length: 1 + int(3) }, () => conditionFor(id, ids))]
  state.mechanics.conditions = conditions
  state.mechanics.concentration ??= {}
  for (const id of ids) if (chance(0.25)) state.mechanics.concentration[id] = { effect_id: pick(['eff-res', 'eff-duel', 'eff-r', 'eff-a', 'eff-x', 'eff-hp']) }
  state.mechanics.positions ??= {}
  for (const id of ids) if (chance(0.7) || !state.mechanics.positions[id]) state.mechanics.positions[id] = { x: int(8), y: int(8) }
  const anchor = state.mechanics.positions[pick(ids)]
  state.mechanics.active_effects = [...(state.mechanics.active_effects ?? []), ...Array.from({ length: int(3) }, (_, n) => area({ x: anchor.x + int(3) - 1, y: anchor.y + int(3) - 1 }, pick(ids), `${index}-${n}`))]
  state.mechanics.combat ??= {}
  const combat = state.mechanics.combat
  if (chance(0.5)) {
    combat.active = true
    combat.round = pick([1, 2, 3])
    combat.initiative = ids.map((id) => ({ actor_id: id }))
    combat.active_index = int(ids.length)
    combat.action_economy = Object.fromEntries(ids.map((id) => [id, { action: true, bonus_action: chance(0.7), reaction: chance(0.8), ...(chance(0.2) ? { bonus_spell_cast_2014: true } : {}), ...(chance(0.2) ? { other_spell_cast_2014: true } : {}), ...(chance(0.2) ? { slot_spell_cast_2024: true } : {}) }]))
    if (chance(0.3)) combat.turn_started_event_id = 'turn-evt-1'
  }
  state.mechanics.resources ??= {}
  for (const player of state.players ?? []) {
    if (chance(0.5)) player.inventory = [...(Array.isArray(player.inventory) ? player.inventory : []), ...gear(player.id)]
    if (chance(0.3)) player.selectedFeatureIds = [...(player.selectedFeatureIds ?? []), pick(['war-caster', 'agonizing-blast', 'fighting-style-protection'])]
    const pools = state.mechanics.resources[player.id] ?? {}
    for (let level = 1; level <= 6; level += 1) if (chance(0.4)) pools[`spell_slots_${level}`] = { current: pick([0, 1, 2]), max: 2 }
    if (chance(0.3)) pools.pact_slots = { current: pick([0, 1]), max: 2 }
    if (chance(0.3)) pools.bardic_inspiration = { current: pick([0, 1, 3]), max: 3 }
    if (chance(0.3)) pools.indomitable = { current: pick([0, 1]), max: 1 }
    state.mechanics.resources[player.id] = pools
  }
  if (chance(0.3) && (state.enemies ?? []).length) state.enemies[0].legendary = { uses: 3, resistance: pick([1, 3]), actions: [{ id: 'tail', name: 'Хвост', cost: 1 }] }
  for (const player of state.players ?? []) {
    if (chance(0.2)) Object.assign(player, { class: 'bard', characterClass: 'bard', subclass: 'Коллегия знаний', level: pick([3, 5, 10]) })
    else if (chance(0.15)) {
      Object.assign(player, { class: 'fighter', characterClass: 'fighter', level: pick([2, 9]), selectedFeatureIds: [...(player.selectedFeatureIds ?? []), 'fighting-style-protection'] })
      player.inventory = [...(Array.isArray(player.inventory) ? player.inventory : []), materializeCatalogItem('srd_5_2_1:shield', { id: `shield-${player.id}`, quantity: 1, equipped: true })]
    }
  }
  if (chance(0.2)) state.mechanics.reaction_preferences = Object.fromEntries((state.players ?? []).slice(0, 1).map((player) => [player.id, { 'cast:shield': pick(['auto', 'never', 'ask']), 'opportunity-attack': 'never' }]))
  if (chance(0.25)) {
    const [caster, target] = [pick(ids), pick(ids)]
    state.mechanics.concentration[caster] = { effect_id: 'eff-en' }
    state.mechanics.conditions[target] = [...(state.mechanics.conditions[target] ?? []), { id: 'enervated', source_actor: caster, effect_id: 'eff-en', continuation_version: 1, spell_id: 'enervation', ...(chance(0.4) ? { expires_at_seconds: pick([0, 99999]) } : {}) }]
  }
  if (chance(0.3)) state.enabled_house_rules = pick([[], ['house:bg3-spell-hands'], ['house:bg3-opening-strike']])
  return state
}
const states = [...corpusStates]
for (let index = 0; index < 110; index += 1) {
  const state = variant(pick(corpusStates), index)
  try { E.normalizeCampaignState(state) } catch { continue }
  states.push(state)
}
const snapshots = states.map((state) => JSON.stringify(state))

// --- аргументы ---------------------------------------------------------------------

function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}
function resolveArg(state, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1) {
    if (typeof value.$actor === 'string') return E.findActor(state, value.$actor)
    if (Array.isArray(value.$spell)) return E.combatSpellFor(E.findActor(state, value.$spell[0]), value.$spell[1], { rulesetId: state.ruleset_id })
    if (typeof value.$canon === 'string') return E.canonicalCombatSpellFor(value.$canon, { rulesetId: state.ruleset_id })
  }
  return deepUndefined(value)
}
const calls = []
function call(f, s, args, fn) {
  const state = states[s]
  const normalized = E.normalizeCampaignState(state)
  const resolved = args.map((arg) => resolveArg(normalized, arg))
  calls.push({ f, s, a: args, o: attempt(() => fn(normalized, ...resolved)) })
}

const SPELL_IDS = ['shield', 'absorb-elements', 'hellish-rebuke', 'counterspell', 'silvery-barbs', 'magic-missile', 'eldritch-blast', 'fire-bolt', 'scorching-ray', 'chromatic-orb', 'booming-blade',
  'green-flame-blade', 'revivify', 'borrowed-knowledge', 'fireball', 'cure-wounds', 'healing-word', 'bless', 'hold-person', 'spirit-guardians', 'cloud-of-daggers', 'moonbeam', 'web', 'sleet-storm',
  'enervation', 'melfs-acid-arrow', 'spiritual-weapon', 'mind-sliver', 'resistance', 'guidance', 'toll-the-dead', 'sacred-flame', 'ice-knife', 'shatter', 'thunderwave', 'burning-hands', 'mage-armor',
  'heroism', 'aid', 'elemental-weapon', 'spirit-shroud', 'transmute-rock', 'bones-of-the-earth', 'steel-wind-strike', 'witch-bolt', 'vampiric-touch', 'phantasmal-killer', 'sleep', 'tashas-hideous-laughter']
const command = (state, actorId, extra = {}) => ({ command_id: `cmd-${int(100)}`, campaign_id: 'camp', command_type: 'DeclareAction', actor_id: actorId, ruleset_id: state.ruleset_id ?? 'srd_5_2_1', source_rule_ids: [], target_ids: [], visibility: pick(['public', 'party', undefined]), ...extra })

for (let s = 0; s < states.length; s += 1) {
  const state = E.normalizeCampaignState(states[s])
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  const someId = () => pick([...ids, ...ids, ...heroes, 'ghost'])
  const heroSpells = (state.players ?? []).flatMap((player) => (player.combatSpells ?? []).map((spell) => [E.actorId(player), spell.id]))
  const spellRef = () => (heroSpells.length && chance(0.6) ? { $spell: pick(heroSpells) } : { $canon: pick(SPELL_IDS) })
  for (let rep = 0; rep < 6; rep += 1) {
    const id = someId()
    const other = someId()
    const hero = pick(heroes)
    const spell = spellRef()
    // slots.rs
    call('creatureTypeFor', s, [{ $actor: id }], (st, a) => E.creatureTypeFor(a))
    call('understandsSpellLanguage', s, [{ $actor: id }], (st, a) => E.understandsSpellLanguage(a))
    call('sculptSpellsLimit', s, [{ $actor: hero }, spell, pick([U, 1, 3, 5, '4'])], (st, a, b, c) => b ? E.sculptSpellsLimit(a, b, c) : null)
    call('chooseSpellSlot', s, [hero, spell, pick([U, U, null, 1, 2, 3, 6, 7, '2', 1.5, 'x']), pick([U, null, 'spell_slots_2', 'pact_slots', 'BAD!', 7, 'spell_slots_9', 'species_spell_x'])], (st, a, b, c, d) => E.chooseSpellSlot(st, a, b, c, d))
    call('scaledSpellDice', s, [spell, { $actor: hero }, pick([U, 1, 2, 3, 5, null])], (st, a, b, c) => E.scaledSpellDice(a, b, c))
    call('scaledDiceExpression', s, [pick(['2d6', '1d8+2', '3d4-1', 'x', '10d10']), pick([U, 0, 1, 3, -2, '2']), pick([U, 1, 2, 'x']), pick([U, 5, 100, 0])], (st, a, b, c, d) => E.scaledDiceExpression(a, b, c, d))
    call('reactionSlotChoice', s, [hero, spell, pick([{ resource: 'spell_slots_1', slot_level: 1 }, { slot_level: 3 }, {}, null]), pick([U, 1, 2, 3, 9, 10, '2'])], (st, a, b, c, d) => b ? E.reactionSlotChoice(st, a, b, c, d) : null)
    call('withSpellOptionOverrides', s, [pick([{ id: 'x', spellOptionOverrides: { mud: { condition: 'restrained' }, list: [1, 2] } }, { id: 'y' }]), pick(['mud', 'list', 'none', U, null])], (st, a, b) => E.withSpellOptionOverrides(a, b))
    call('conditionsForSlotLevel', s, [pick([{ level: 2, conditionsBySlotLevel: { 2: ['a'], 5: ['b', 3] } }, { level: 1, conditionsBySlotLevel: 'x' }, { level: 3 }, { level: 1, conditionsBySlotLevel: { '05': ['z'], 9: 'x' } }]), pick([U, 1, 2, 4, 5, 9])], (st, a, b) => E.conditionsForSlotLevel(a, b))
    call('delayedSpellDamageExpression', s, [pick([{ level: 2, delayedDamage: '2d4', delayedDamageUpcastDicePerLevel: 1 }, { level: 3, delayedDamage: 'x' }, { level: 1, delayedDamage: '1d6' }]), pick([U, 2, 4, 9])], (st, a, b) => E.delayedSpellDamageExpression(a, b))
    call('concentrationSaveAdvantageFor', s, [{ $actor: id }], (st, a) => E.concentrationSaveAdvantageFor(a))
    call('lifeDomainCaster', s, [{ $actor: id }], (st, a) => E.lifeDomainCaster(a))
    call('assertBonusActionSpellAllowed', s, [id, spell, pick(['action', 'bonus_action', 'reaction', U])], (st, a, b, c) => b ? E.assertBonusActionSpellAllowed(st, a, b, c) : null)
    call('beamCountFor', s, [{ $actor: hero }, spell, pick([U, null, 1, 3, 5])], (st, a, b, c) => E.beamCountFor(a, b, c))
    call('hasMultipleBeams', s, [spell], (st, a) => E.hasMultipleBeams(a))
    call('spellProjectileCount', s, [spell, pick([U, 1, 3, 5])], (st, a, b) => (a ? E.spellProjectileCount(a, b) : null))
    call('spellDamageEstimate', s, [{ $actor: hero }, spell, pick([U, 1, 3, 5])], (st, a, b, c) => E.spellDamageEstimate(a, b, c))
    // components.rs
    call('spellInventoryFor', s, [{ $actor: id }], (st, a) => a ? E.spellInventoryFor(st, a) : null)
    call('spellMaterialPaymentFor', s, [{ $actor: id }, spell], (st, a, b) => (a && b ? E.spellMaterialPaymentFor(st, a, b) : null))
    call('spellComponentCostEvents', s, [command(st0(s), id), spell, pick([{}, { additionalBeam: true }, { readiedRelease: 1 }])], (st, a, b, c) => E.spellComponentCostEvents(st, a, b, c))
    call('spellComponentAvailabilityFor', s, [{ $actor: id }, spell], (st, a, b) => E.spellComponentAvailabilityFor(st, a, b))
    call('assertSpellComponentsAllowed', s, [{ $actor: id }, spell, pick([{}, { additionalBeam: true }])], (st, a, b, c) => E.assertSpellComponentsAllowed(st, a, b, c))
    // enervation.rs
    call('silveryFortuneFor', s, [id], (st, a) => E.silveryFortuneFor(st, a))
    call('removeSilveryFortuneEvent', s, [command(st0(s), id), id, pick([U, null, 'turn-start'])], (st, a, b, c) => E.removeSilveryFortuneEvent(a, st, b, c))
    call('hasEnervationContinuation', s, [], (st) => E.hasEnervationContinuation(states[s]))
    call('enervationReasons', s, [id], (st, a) => {
      const link = E.enervationLinkFor(st, a)
      return link ? [E.enervationContinuationInvalidReason(st, link), E.enervationTriggerReason(st, link)] : null
    })
    // reactions.rs
    const path = Array.from({ length: 1 + int(3) }, () => ({ x: int(8), y: int(8) }))
    call('opportunityAttackers', s, [id, pick([{ x: int(8), y: int(8) }, null]), path], (st, a, b, c) => E.opportunityAttackers(st, a, b, c).map(E.actorId))
    const damage = pick([null, { applied_amount: pick([0, 3, 8]), temporary_hp_absorbed: pick([0, 2, U]), damage_type: pick(['fire', 'cold', 'slashing', 'FIRE', U]) }])
    call('reactionOptionsAfterAttack', s, [{ $actor: id }, chance(0.7), chance(0.2), pick([10, 14, 18, 22]), pick([10, 13, 16]), damage, pick([U, null, 30, 90]), chance(0.5), chance(0.5)], (st, a, b, c, d, e, g, h, i, j) => a ? E.reactionOptionsAfterAttack(st, a, { hit: b, critical: c, attackTotal: d, armorClass: e, damage: g, distanceFeet: h, allowParry: i, allowRiposte: j }) : null)
    call('reactionOptionsAfterElementalDamage', s, [{ $actor: id }, damage], (st, a, b) => E.reactionOptionsAfterElementalDamage(st, a, b))
    call('protectiveAttackReactionOptions', s, [{ $actor: id }, chance(0.8), chance(0.2), pick([12, 16, 20]), pick([14, 16]), pick(['fire', 'piercing', U]), pick([U, 20, 80])], (st, a, b, c, d, e, g, h) => E.protectiveAttackReactionOptions(st, a, { hit: b, critical: c, attackTotal: d, armorClass: e, damageType: g, distanceFeet: h }))
    call('allyAttackReactionFor', s, [other, id, pick(['cutting-words', 'protection'])], (st, a, b, c) => {
      const reactor = E.allyAttackReactionFor(st, a, b, c)
      return reactor ? E.allyAttackReactionOption(reactor) : null
    })
    call('shieldReactionOption', s, [{ $actor: id }], (st, a) => E.shieldReactionOption(st, a))
    call('shieldConditionEvent', s, [command(st0(s), other), id], (st, a, b) => E.shieldConditionEvent(a, b))
    call('absorbElementsConditionEvents', s, [command(st0(s), other), id, pick(['fire', 'cold', U]), pick([U, 1, 3, 'x'])], (st, a, b, c, d) => E.absorbElementsConditionEvents(a, b, c, d))
    const payload = pick([{ applied_amount: 6, temporary_hp_absorbed: 2, temporary_hp_before: 2, temporary_hp_after: 0, hp_before: 10, hp_after: 4, raw_amount: 8, damage_type: 'fire' },
      { applied_amount: 3, temporary_hp_absorbed: 0, hp_before: 3, hp_after: 0, raw_amount: 3, damage_type: 'cold', death_ward_triggered: true, resistance_cantrip_reduction: 2, resistance_cantrip_condition: 'resistance-damage:cold', resistance_cantrip_turn: 't', resistance_cantrip_roll_id: 'r' },
      { applied_amount: 5, resistant: true, damage_type: 'acid', raw_amount: 10 }, { applied_amount: 9, temporary_hp_absorbed: 1, hp_before: 9, hp_after: 0, temporary_hp_before: 1, temporary_hp_after: 0, raw_amount: 10, damage_type: 'lightning', relentless_endurance_triggered: true }])
    call('absorbElementsDamagePayload', s, [payload, id], (st, a, b) => E.absorbElementsDamagePayload(a, st, b))
    call('uncannyDodgeDamagePayload', s, [payload], (st, a) => E.uncannyDodgeDamagePayload(a))
    call('reducedReactionDamage', s, [payload, pick([0, 2, 5, 100, U, '3'])], (st, a, b) => E.reducedReactionDamage(a, b))
    call('counterspellReactionFor', s, [id], (st, a) => {
      const reaction = E.counterspellReactionFor(st, a)
      return reaction ? [E.actorId(reaction.actor), reaction.spell.id, reaction.slot] : null
    })
    call('silveryBarbsReactionFor', s, [id, pick([U, null, hero])], (st, a, b) => {
      const reaction = E.silveryBarbsReactionFor(st, a, b)
      return reaction ? [E.actorId(reaction.actor), reaction.spell.id, reaction.slot] : null
    })
    call('counterspellWindowFor', s, [command(st0(s), id, { slot_level: pick([U, 3]), counterspell_bypassed: chance(0.1) }), spell], (st, a, b) => b ? E.counterspellWindowFor(st, a, b) : null)
    call('heroReactionModesFor', s, [hero], (st, a) => E.heroReactionModesFor(st, a))
    // areas/consequences.rs
    const effects = state.mechanics.active_effects ?? []
    call('areaTriggerTurnKey', s, [], (st) => E.areaTriggerTurnKey(st))
    call('areaEffectTriggeredThisTurn', s, [effects.length ? pick(effects) : null, id], (st, a, b) => E.areaEffectTriggeredThisTurn(st, a, b))
    call('areaTriggerMarkEvent', s, [command(st0(s), id), effects.length ? pick(effects) : { once_per_turn: true, id: 'z' }, id, pick(['area-enter', 'turn-start'])], (st, a, b, c, d) => E.areaTriggerMarkEvent(st, a, b, c, d))
    call('wearsMetalArmor', s, [{ $actor: id }], (st, a) => E.wearsMetalArmor(a))
    // opening_strike.rs
    const enemiesList = (state.enemies ?? []).map(E.actorId)
    const npcs = (state.social?.npcs ?? []).map((npc) => npc.id)
    const strikeInput = { command_type: pick(['MakeAttack', 'MakeAreaAttack', 'CastSpell', 'UseCombatAction', 'MoveActor']), actor_id: hero, target_ids: pick([[pick([...enemiesList, ...npcs, 'ghost'])], [], U]), target_id: pick([U, pick([...enemiesList, 'ghost'])]), spell_id: pick(SPELL_IDS), action_id: pick(['shove', 'grapple', 'dash', 'help']) }
    call('openingStrikeFor', s, [strikeInput, pick([{}, { isDirector: true }, { __resolve_depth: 1 }])], (st, a, b) => E.openingStrikeFor(a, states[s], b))
  }
}
function st0(s) { return states[s] }

// --- мусор: значения не той формы ------------------------------------------------------

const JUNK = [null, U, 5, 'x', [], {}, { level: '2' }, { level: 0 }, { beams: '3', level: 1, upcastBeamsPerLevel: 1 }, { beamScaling: true, monsterSpell: { casterLevel: '11' } },
  { damage: 5 }, { damage: '1d6', projectileCount: '2', level: 1, upcastProjectilesPerLevel: 2 }, { id: 'eldritch-blast', damage: '1d10', level: 0 }, { conditions: [{ id: 'cannot-understand-language' }] },
  { creature_type: 'Конструкт' }, { creatureType: 'UNDEAD' }, { character: 'Имя' }, { inventory: [{ equipped: true, catalog_id: 'srd_5_2_1:chain-mail' }, { equipped: true, catalogId: 'x:plate' }] },
  { creationBenefits: { static: { concentration_save_advantage: true } } }, { selected_feature_ids: ['war-caster'] }, { class: 'cleric', level: 3, subclass: 'Домен жизни' },
  { level: 2, slotResource: 'spell_slots_2', components: { verbal: true } }, { level: 1, slotResource: 'pact_slots' }, { damage: '2d6', upcastDicePerLevel: '1', level: 1, addAbilityModifier: true },
  { spellOptionOverrides: { a: 'x', b: null } }, { conditionsBySlotLevel: [['x'], ['y']], level: 0 }, { applied_amount: '4', temporary_hp_absorbed: 'x', hp_before: -3, temporary_hp_before: '2' }]
for (let n = 0; n < 2400; n += 1) {
  const s = int(states.length)
  const junk = () => pick(JUNK)
  const [x, y, z] = [junk(), junk(), junk()]
  const f = pick(['creatureTypeFor', 'understandsSpellLanguage', 'concentrationSaveAdvantageFor', 'lifeDomainCaster', 'beamCountFor', 'hasMultipleBeams', 'spellDamageEstimate', 'scaledSpellDice',
    'withSpellOptionOverrides', 'conditionsForSlotLevel', 'uncannyDodgeDamagePayload', 'reducedReactionDamage', 'wearsMetalArmor', 'spellProjectileCount', 'chooseSpellSlot', 'spellComponentAvailabilityFor'])
  const fns = {
    creatureTypeFor: (st, a) => E.creatureTypeFor(a),
    understandsSpellLanguage: (st, a) => E.understandsSpellLanguage(a),
    concentrationSaveAdvantageFor: (st, a) => E.concentrationSaveAdvantageFor(a),
    lifeDomainCaster: (st, a) => E.lifeDomainCaster(a),
    beamCountFor: (st, a, b, c) => E.beamCountFor(a, b, c),
    hasMultipleBeams: (st, a) => E.hasMultipleBeams(a),
    spellDamageEstimate: (st, a, b, c) => E.spellDamageEstimate(a, b, c),
    scaledSpellDice: (st, a, b, c) => E.scaledSpellDice(a, b, c),
    withSpellOptionOverrides: (st, a, b) => E.withSpellOptionOverrides(a, b),
    conditionsForSlotLevel: (st, a, b) => E.conditionsForSlotLevel(a, b),
    uncannyDodgeDamagePayload: (st, a) => E.uncannyDodgeDamagePayload(a),
    reducedReactionDamage: (st, a, b) => E.reducedReactionDamage(a, b),
    wearsMetalArmor: (st, a) => E.wearsMetalArmor(a),
    spellProjectileCount: (st, a, b) => (a ? E.spellProjectileCount(a, b) : null),
    chooseSpellSlot: (st, a, b, c, d) => E.chooseSpellSlot(st, a, b, c, d),
    spellComponentAvailabilityFor: (st, a, b) => E.spellComponentAvailabilityFor(st, a, b),
  }
  const args = f === 'chooseSpellSlot' ? [pick(['hero', 'ghost']), x, pick([U, null, 2, 'x']), pick([U, null, 'pact_slots'])]
    : f === 'withSpellOptionOverrides' ? [x, pick(['a', 'b', U])]
    : f === 'conditionsForSlotLevel' ? [x, pick([U, 0, 1, 5])]
    : [x, y, z]
  calls.push({ f, s, a: args, o: attempt(() => fns[f](E.normalizeCampaignState(states[s]), ...args.map(deepUndefined))) })
}

// --- закрытие «Обессиливания», сверка концентрации, удар-открытие: ход ---------------

for (let s = 0; s < states.length; s += 1) {
  const state = E.normalizeCampaignState(states[s])
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  for (let rep = 0; rep < 3; rep += 1) {
    const actor = pick(ids)
    const target = pick(ids)
    const base = command(states[s], actor, { command_type: pick(['MakeAttack', 'CastSpell', 'UseCombatAction', 'MoveActor']), action_id: pick([U, 'enervation-repeat', 'dash']) })
    const events = [
      ...(chance(0.5) ? [E.eventFrom(base, pick(['CombatActionUsed', 'SpellCast', 'AttackResolved', 'ItemUsed', 'DoorForced', 'SceneObjectOperated']), { action_type: pick(['action', 'bonus_action']), combat_action: 'action', action_spent: chance(0.5), economy: { action: chance(0.8) } }, [target])] : []),
      ...(chance(0.3) ? [E.eventFrom(base, 'ConcentrationEnded', { effect_id: pick(['eff-en', 'eff-x', 'eff-res']) }, [actor])] : []),
      ...(chance(0.3) ? [E.eventFrom(base, 'ConditionRemoved', { condition: pick(['enervated', 'resistance-d4', 'silvery-fortune']) }, [target])] : []),
      ...(chance(0.3) ? [E.eventFrom(base, 'ActorMoved', { from: { x: 0, y: 0 }, to: { x: int(30), y: int(30) }, path: [{ x: 1, y: 1 }], distance: 5 }, [target])] : []),
      ...(chance(0.2) ? [E.eventFrom(base, 'ConditionAdded', { condition: 'enervated', continuation_version: 1, source_actor: actor, effect_id: 'eff-en2' }, [target])] : []),
      ...(chance(0.3) ? [E.eventFrom(base, 'ConditionAdded', { condition: pick(['stunned', 'unconscious', 'prone']), duration: '1-round' }, [actor])] : []),
    ]
    const result = { command: json(base), events: json(events), rolls: [] }
    call('closeEnervationAfterOtherAction', s, [result], (st, a) => E.closeEnervationAfterOtherAction(a, states[s]))
    call('closeEnervationAfterTriggers', s, [result], (st, a) => E.closeEnervationAfterTriggers(a, states[s]))
    call('closeFinishedSpellBuffs', s, [result], (st, a) => E.closeFinishedSpellBuffs(a, states[s]))
    call('concentrationReconciliationEvents', s, [json(base), result.events], (st, a, b) => E.concentrationReconciliationEvents(st, a, b))
    const started = E.normalizeCampaignState(states[s])
    if (started.mechanics.combat.active && started.mechanics.combat.initiative?.length) {
      const turnStarted = chance(0.7) ? json(E.eventFrom(base, 'TurnStarted', { active_index: 0, round: 1 }, [actor])) : U
      call('openingStrikeTurnState', s, [actor, turnStarted], (st, a, b) => stripDerived(E.openingStrikeTurnState(st, states[s], a, b)))
    }
  }
}

// --- замыкания resolveCommandInternal --------------------------------------------------

const prologue = await blockFunction([[13082, 13749]], ["if (!diceService) throw new TypeError('RulesEngine требует DiceService')"], ['input', 'rawState', 'diceService', 'context', '__probe'],
  'return __probe({ state, command, events, rolls, diceTranscript, diceService, spendBardicInspiration, damageTurnKey, consumeResistanceBonus, resistanceSaveState, rollSavingThrow, areaSaveModifierFor, legendaryResistanceFor, resolveDamagePayload, prepareElementalReactionDamage, resolveDamageWithReactions, appendMagicMissileResolution, rollAmount })')
const probes = []
const PROBE_CONTEXTS = [
  {}, { isAdmin: true }, { resistanceChoices: [{ save_key: 'x:saving-throw:1', mode: 'decline' }] }, { elementalDamageChoices: { 'k-1': true } }, { protectiveReactionChoices: [{ key: 'magic-missile:cmd:x', use: true }] },
]
function probeContext(state, ids) {
  const base = pick(PROBE_CONTEXTS)
  const target = pick(ids)
  if (chance(0.3)) return { ...base, resistanceChoice: { save_key: `${target}:${pick(['saving-throw', 'spell_save:x'])}:${1 + int(2)}`, target_id: target, use: pick([true, false, 'after', 'after-use', 'before-roll']) } }
  if (chance(0.2)) return { ...base, elementalDamageChoice: { damage_key: pick(['k-1', `cmd:elemental:${target}:fire:1`]), target_id: target, use: chance(0.6), slot_level: pick([U, 2]), damage_type: pick([U, 'fire']), resource: pick([U, 'spell_slots_2']) } }
  if (chance(0.2)) return { ...base, resistanceChoices: { [`${target}:saving-throw:1`]: pick([true, 'after', 'after-use', { mode: 'decline' }]) } }
  return base
}
for (let n = 0; n < 6000 && probes.length < 1600; n += 1) {
  const s = int(states.length)
  const raw = states[s]
  const state = E.normalizeCampaignState(raw)
  if (E.truceFor(state)) continue
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  if (!heroes.length) continue
  const kind = pick(['DeclareAction', 'DeclareAction', 'ApplyDamage', 'MakeSavingThrow'])
  const input = { command_type: kind, command_id: `probe-${n}`, campaign_id: 'camp', actor_id: pick(heroes), expected_state_version: state.state_version, action: 'Осматриваюсь',
    ...(kind === 'ApplyDamage' ? { target_id: pick(ids), ...(chance(0.6) ? { expression: pick(['2d6', '1d10+2', '3d4']) } : { amount: pick([3, 7, '5', 0]) }) } : {}),
    ...(chance(0.3) ? { visibility: pick(['party', 'public']) } : {}) }
  const context = probeContext(state, ids)
  const values = diceValues()
  const resistant = ids.filter((id) => (state.mechanics.conditions?.[id] ?? []).some((condition) => condition?.id === 'resistance-d4'))
  const shielders = heroes.filter((id) => E.shieldReactionOption(state, E.findActor(state, id)))
  const absorbers = heroes.filter((id) => (E.findActor(state, id)?.combatSpells ?? []).some((spell) => spell.id === 'absorb-elements'))
  const target = resistant.length && chance(0.4) ? pick(resistant) : shielders.length && chance(0.4) ? pick(shielders) : absorbers.length && chance(0.4) ? pick(absorbers) : pick([...ids, 'ghost'])
  const call = pick(['spendBardicInspiration', 'damageTurnKey', 'consumeResistanceBonus', 'resistanceSaveState', 'rollSavingThrow', 'rollSavingThrow', 'areaSaveModifierFor', 'legendaryResistanceFor',
    'resolveDamagePayload', 'resolveDamagePayload', 'prepareElementalReactionDamage', 'resolveDamageWithReactions', 'appendMagicMissileResolution', 'rollAmount', 'areaEntryConsequences', 'areaTurnConsequences', 'areaTurnConsequences'])
  const ability = pick(['con', 'dex', 'wis', 'str', U])
  const options = { ability, modifier: pick([U, 0, 2, 5]), purpose: pick([U, 'saving-throw', 'spell_save:x']), ...(chance(0.6) ? { difficulty: pick([10, 13, 15, 18]) } : {}), ...(chance(0.3) ? { resistanceEligible: chance(0.5) } : {}), ...(chance(0.4) ? { advantage: true } : {}), visibility: pick([U, 'party']), ...(chance(0.2) ? { avoid_or_end_condition: 'poisoned' } : {}) }
  const args = {
    spendBardicInspiration: [target, pick(['ability-check', 'saving-throw'])],
    damageTurnKey: [],
    consumeResistanceBonus: [target, pick([{ id: 'resistance-d4', source_actor: pick(ids), effect_id: 'eff-res' }, { id: 'resistance-d4' }, { source_actor: pick(ids) }])],
    resistanceSaveState: [target, options],
    rollSavingThrow: [target, options],
    areaSaveModifierFor: [target],
    legendaryResistanceFor: [target, pick([[], ['restrained'], ['paralyzed', 'prone']]), pick([0, 5, 30])],
    resolveDamagePayload: [target, pick([0, 4, 9, 20, '7']), pick(['fire', 'cold', 'slashing', 'radiant']), pick([null, { reduction: 2, condition_id: 'resistance-damage:fire', turn_key: 't', roll_id: 'r' }]), pick([null, { kind: 'weapon', magical: true }])],
    prepareElementalReactionDamage: [target, { applied_amount: pick([0, 5]), temporary_hp_absorbed: 0, hp_before: 10, hp_after: 5, raw_amount: 5, damage_type: pick(['fire', 'acid', 'necrotic']) }, pick([null, 'k-1'])],
    resolveDamageWithReactions: [target, pick([3, 8, 15]), pick(['fire', 'cold', 'thunder', 'piercing'])],
    appendMagicMissileResolution: [target, pick([U, 1, 2, 4]), pick([U, { id: 'wand-1', name: 'Жезл' }])],
    rollAmount: [pick(['damage', 'healing']), pick([U, 0, 3])],
    areaEntryConsequences: [target, pick([{ x: int(8), y: int(8) }, null]), { x: int(8), y: int(8) }, pick([U, 'area-enter', 'forced-entry'])],
    areaTurnConsequences: [target, pick(['turn-start', 'turn-end'])],
  }[call]
  let o
  let probe = null
  let after = null
  uuidCounter = 0
  try {
    E.normalizeCampaignState(raw)
    probe = prologue(json(input), json(raw), service(values), json(deepUndefined(context)), (closures) => closures)
  } catch {
    continue
  }
  const a = args.map((value) => deepUndefined(value))
  try {
    const st = probe.state
    switch (call) {
      case 'spendBardicInspiration': o = probe.spendBardicInspiration(st, a[0], a[1]); break
      case 'damageTurnKey': o = probe.damageTurnKey(st); break
      case 'consumeResistanceBonus': o = probe.consumeResistanceBonus(st, String(a[0] ?? ''), a[1]); break
      case 'resistanceSaveState': o = probe.resistanceSaveState(st, a[0], a[1]); break
      case 'rollSavingThrow': o = probe.rollSavingThrow(st, a[0], a[1]); break
      case 'areaSaveModifierFor': o = probe.areaSaveModifierFor(st, a[0]); break
      case 'legendaryResistanceFor': o = probe.legendaryResistanceFor(st, a[0], { conditions: a[1], damage: a[2] })?.events ?? null; break
      case 'resolveDamagePayload': o = probe.resolveDamagePayload(st, a[0], a[1], a[2], a[3], a[4]); break
      case 'prepareElementalReactionDamage': o = probe.prepareElementalReactionDamage(st, a[0], a[1], a[2]); break
      case 'resolveDamageWithReactions': o = probe.resolveDamageWithReactions(st, a[0], a[1], a[2]); break
      case 'appendMagicMissileResolution': {
        const targetActor = E.findActor(st, a[0])
        if (!targetActor) { o = 'no-target'; break }
        const spell = E.canonicalCombatSpellFor('magic-missile', { rulesetId: st.ruleset_id })
        o = probe.appendMagicMissileResolution({ sourceCommand: probe.command, spell, target: targetActor, slotLevel: a[1], damageType: 'force', sourceItem: a[2] ?? null })
        break
      }
      case 'rollAmount': o = probe.rollAmount(a[0], a[1]); break
      case 'areaEntryConsequences': o = E.areaEntryConsequences(st, probe.command, a[0], a[1], a[2], { diceService: probe.diceService, rolls: probe.rolls, resolveDamage: probe.resolveDamageWithReactions, rollSavingThrow: probe.rollSavingThrow, saveModifierFor: probe.areaSaveModifierFor, ...(a[3] ? { trigger: a[3] } : {}) }); break
      case 'areaTurnConsequences': o = E.areaTurnConsequences(st, probe.command, a[0], { diceService: probe.diceService, rolls: probe.rolls, resolveDamage: probe.resolveDamageWithReactions, rollSavingThrow: probe.rollSavingThrow, saveModifierFor: probe.areaSaveModifierFor, trigger: a[1] }); break
    }
    after = { ok: out(o) }
  } catch (error) {
    after = failure(error)
  }
  probes.push({ s, command: json(probe.command), context, v: values, f: call, a: args, o: after, events: out(probe.events), rolls: out(probe.rolls), t: out(probe.diceTranscript) })
}

// --- разбор веток Р5 целиком: resolveCommand и resolveCommands ------------------------

const resolves = []
const seen = new Map()
const note = (events) => { for (const event of events ?? []) seen.set(event.event_type, (seen.get(event.event_type) ?? 0) + 1) }
const TYPES = ['DeclareAction', 'MakeAbilityCheck', 'MakeAbilityCheck', 'MakeSavingThrow', 'MakeSavingThrow', 'ApplyDamage', 'ApplyDamage', 'ApplyHealing', 'GrantTemporaryHitPoints', 'SetSpellBonusPreference', 'SetReactionPreference', 'RecordRuling']
const SKILLS = ['athletics', 'stealth', 'perception', 'persuasion', 'arcana', U, 'Sleight_of_Hand']
function randomInput(state, n) {
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  const type = pick(TYPES)
  const input = { command_type: type, command_id: `r5-${n}`, campaign_id: 'camp', actor_id: chance(0.85) ? pick(heroes) : pick(ids), expected_state_version: state.state_version }
  if (chance(0.3)) input.visibility = pick(['party', 'public', 'gm_only'])
  switch (type) {
    case 'DeclareAction': input.action = pick(['Осматриваюсь вокруг', '', 'x'.repeat(1100)]); break
    case 'MakeAbilityCheck': Object.assign(input, { skill: pick(SKILLS), ability: pick([U, 'dex', 'WIS']), difficulty: pick([U, 10, 15, 25]), ...(chance(0.2) ? { modifier: pick([3, '2', null]) } : {}), ...(chance(0.2) ? { advantage: true } : {}), ...(chance(0.2) ? { proficient: true } : {}) }); break
    case 'MakeSavingThrow': Object.assign(input, { ability: pick(['con', 'dex', 'wis', 'STR', U]), difficulty: pick([U, 12, 16, 22]), ...(chance(0.2) ? { modifier: pick([1, '4']) } : {}), ...(chance(0.2) ? { proficient: true } : {}), ...(chance(0.2) ? { disadvantage: true } : {}) }); break
    case 'ApplyDamage': Object.assign(input, { target_id: pick(ids), damage_type: pick(['fire', 'cold', 'slashing', 'necrotic', U]), ...(chance(0.5) ? { expression: pick(['2d6', '4d8', '1d4+1', '10d10']) } : { amount: pick([1, 5, 12, 40, 200]) }), ...(chance(0.2) ? { critical_hit: true } : {}) }); break
    case 'ApplyHealing': Object.assign(input, { target_id: pick(ids), ...(chance(0.5) ? { expression: pick(['1d8+3', '2d4']) } : { amount: pick([2, 10]) }) }); break
    case 'GrantTemporaryHitPoints': Object.assign(input, { target_id: pick(ids), amount: pick([3, 8]) }); break
    case 'SetSpellBonusPreference': Object.assign(input, { spell_id: pick(['bless', 'bane']), enabled: pick([true, false, 'yes']) }); break
    case 'SetReactionPreference': Object.assign(input, { reaction_id: pick(['opportunity-attack', 'cast:shield', 'uncanny-dodge', 'x']), mode: pick(['ask', 'never', 'sometimes']) }); break
    case 'RecordRuling': input.ruling = pick([{ text: 'Решение ведущего', kind: 'house' }, U]); break
  }
  return input
}
const CONTEXTS = [{ isAdmin: true }, { isAdmin: true }, {}, { isAdmin: true, indomitableResume: true }, { isAdmin: true, finalizeFleeActorId: 'x' }]
for (let n = 0; n < 9000 && resolves.length < 1100; n += 1) {
  const s = int(states.length)
  const raw = states[s]
  const state = E.normalizeCampaignState(raw)
  if (!(state.players ?? []).length) continue
  const input = randomInput(state, n)
  const context = pick(CONTEXTS)
  const values = diceValues(40)
  uuidCounter = 0
  const o = attempt(() => {
    const result = E.resolveCommand(json(deepUndefined(input)), json(raw), { diceService: service(values), context: json(context) })
    note(result.events)
    return { command: result.command, events: result.events, rolls: result.rolls }
  })
  resolves.push({ s, input, context, v: values, o })
}
const plans = []
for (let n = 0; n < 400; n += 1) {
  const s = int(states.length)
  const state = E.normalizeCampaignState(states[s])
  if (!(state.players ?? []).length) continue
  const commands = Array.from({ length: 1 + int(3) }, (_, index) => {
    const input = randomInput(state, `${n}-${index}`)
    if (index > 0 || chance(0.5)) delete input.expected_state_version
    return input
  })
  const values = diceValues(40)
  uuidCounter = 0
  plans.push({ s, commands, v: values, o: attempt(() => {
    const result = E.resolveCommands(deepUndefined(json(commands)), json(states[s]), { diceService: service(values), context: { isAdmin: true } })
    return { commands: result.commands, events: result.events, rolls: result.rolls, state: stripDerived(result.state) }
  }) })
}

// --- блок проверки 8 -------------------------------------------------------------------

const block8 = await blockFunction([[6174, 6205]], ["if (command.command_type === 'MakeAbilityCheck' && command.social_check != null)"], ['state', 'command', 'context'], 'return command')
const blocks = []
for (let n = 0; n < 500; n += 1) {
  const s = int(states.length)
  const state = E.normalizeCampaignState(states[s])
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  const command = E.normalizeCommand({ command_type: pick(['MakeAbilityCheck', 'MakeAbilityCheck', 'DeclareAction']), command_id: `b-${n}`, actor_id: pick([...heroes, 'ghost']), skill: 'persuasion', modifier: 4, advantage: true, ...(chance(0.8) ? { social_check: pick([{ check_id: 'c' }, null, true]) } : {}) }, state)
  const expected = { hero_id: pick([...heroes, 'ghost']), skill: pick(['persuasion', 'intimidation']), ability: 'cha', difficulty: pick([12, '15', 'x']), visibility: pick(['specific_player', 'public', U]), check_id: 'chk-1', npc_id: 'npc-1', request_fingerprint: 'fp',
    ...(chance(0.4) ? { bribe: { tier_id: 'gold', amount_cp: pick([0, 500, 50_000_000]), insulted: chance(0.3) } } : {}), ...(chance(0.3) ? { advantage: 1 } : {}), ...(chance(0.3) ? { disadvantage: true } : {}) }
  const context = pick([{ isSocialController: true, socialCheck: expected }, { socialCheck: expected }, { isSocialController: true }, { isSocialController: 'yes', socialCheck: expected }])
  blocks.push({ s, command: json(command), context: json(deepUndefined(context)), o: attempt(() => block8(state, structuredClone(command), deepUndefined(context))) })
}

const mutated = states.map((state, index) => (JSON.stringify(state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(', ')}`)
const output = { source_sha256: sourceSha256(), states, calls, probes, resolves, plans, blocks }
const text = `${JSON.stringify(output)}\n`
writeFileSync(new URL('r5.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
const count = (list) => list.filter((entry) => entry.o.ok !== undefined).length
console.log([...seen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log(`r5.json.gz: ${(text.length / 1e6).toFixed(1)} МБ JSON, состояний ${states.length}, вызовов ${calls.length}, замыканий ${probes.length} (исход ok ${count(probes)}), разборов ${resolves.length} (ok ${count(resolves)}), планов ${plans.length}, блоков ${blocks.length}`)
