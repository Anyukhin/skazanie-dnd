import '../../../fixtures-env.mjs'
// Эталоны задачи Р9: заклинание `CastSpell` (авторитетный и прежний путь),
// концентрация (`StartConcentration`, `EndConcentration`), блоки проверки 30
// и 69 — полным путём `resolveCommand` движка JS.
//
// Состояния — записи корпуса с командами `CastSpell` (`tmp/corpus-v1`, без
// `scene.map`). Команды — команды корпуса и их синтетические варианты:
// другие заклинания героя (`combatSpellsFor`), противник-заклинатель с блоком
// `spellcasting` из любых заклинаний каталога, другие цели, точки, круги
// ячеек, варианты эффекта, метамагия, концентрация, «Благословение» и «Порча»
// на целях, горючие области, заготовленные реакции, продолжения
// (`additionalBeam`, `readiedRelease`, выбор защитной реакции) и мусор.
//
// Исход — `{ ok: { command, events, rolls } }` (длинный — sha256 строки
// `JSON.stringify`), отказ `{ err: [code, message] }`, пауза или ошибка JS.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-r9.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DiceService } from '../../../../server/dice-service.mjs'
import { canonicalCombatSpellFor, combatSpellsFor } from '../../../../server/combat-spells.mjs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0009_5eed
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
// Последовательность, которая не выходит за кость: значение сворачивается в
// диапазон `min + (v - 1) mod (max - min + 1)` (в Rust — тот же генератор теста).
class WrappingRng {
  constructor(values) { this.values = [...values]; this.index = 0 }
  randint(minimum, maximum) {
    if (this.index >= this.values.length) throw new RangeError("Тестовая последовательность бросков закончилась")
    const value = this.values[this.index++]
    return minimum + ((value - 1) % (maximum - minimum + 1))
  }
}
function service(values) {
  let counter = 0
  return new DiceService({ rng: new WrappingRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const diceValues = (n = 80) => Array.from({ length: n }, () => 1 + int(20))
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}

// --- корпус: записи CastSpell и их состояния ------------------------------------------

const records = []
for (const file of readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line.includes('"CastSpell"') && !line.includes('Concentration"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!['CastSpell', 'StartConcentration', 'EndConcentration'].includes(entry.command?.command_type)) continue
    records.push(entry)
  }
}
const byState = new Map()
for (const record of records) {
  if (!byState.has(record.state)) byState.set(record.state, [])
  byState.get(record.state).push(record)
}
const hashes = [...byState.keys()].sort()
const states = []
const stateRecords = []
const strip = (state) => {
  const copy = json(state)
  if (copy.scene) delete copy.scene.map
  return copy
}
for (const hash of hashes) {
  if (states.length >= 70) break
  const path = join(corpusDir, 'states', `${hash}.json`)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  if (text.length > 160_000) continue
  if (int(3) === 0) continue
  states.push(strip(JSON.parse(text)))
  stateRecords.push(byState.get(hash))
}
if (!states.length) throw new Error(`нет корпуса в ${corpusDir}`)
const snapshots = states.map((state) => JSON.stringify(state))

// --- каталог заклинаний -------------------------------------------------------------

const catalog = JSON.parse(readFileSync(new URL('../../../../data/dndsu-spells-0-6.json', import.meta.url), 'utf8')).spells.map((spell) => spell.id)
function supportedSpells(rulesetId) {
  return catalog.filter((id) => ['verified', 'partial'].includes(canonicalCombatSpellFor(id, { rulesetId })?.mechanicsSupport))
}
const supported = new Map()
const supportedFor = (rulesetId) => {
  const key = String(rulesetId ?? '')
  if (!supported.has(key)) supported.set(key, supportedSpells(rulesetId))
  return supported.get(key)
}

// --- синтетические варианты ---------------------------------------------------------

const CONDITIONS = ['bless-d4', 'bane-d4', 'next-save-minus-d4', 'silvery-fortune', 'shielded', 'blinded', 'invisible', 'heroism', 'deafened', 'faerie-fire', 'guiding-bolt-advantage', 'disadvantage-next-attack',
  'healing-blocked', 'freedom-of-movement', 'unconscious', 'prone', 'magical-darkness', 'cannot-understand-language', 'true-strike']
const METAMAGIC = ['metamagic-careful', 'metamagic-distant', 'metamagic-empowered', 'metamagic-extended', 'metamagic-heightened', 'metamagic-quickened', 'metamagic-seeking', 'metamagic-subtle', 'metamagic-transmuted', 'metamagic-twinned']
const AREAS = [
  { spell_id: 'web', condition: 'restrained', save_ability: 'dex', save_dc: 12, trigger_on_enter: true, trigger_on_turn_start: true, flammable: { damage: '2d4', damageType: 'fire' } },
  { spell_id: 'grease', trigger_on_enter: true, flammable: { damage: null }, ignites_into: { damage_amount: 5, damage_type: 'fire', rounds: 2 } },
  { spell_id: 'create-bonfire', damage: '1d8', damage_type: 'fire', open_flame: true, trigger_on_enter: true },
  { spell_id: 'moonbeam', damage: '2d10', damage_type: 'radiant', save_ability: 'con', save_dc: 13, half_on_save: true, trigger_on_enter: true },
]

function cellsNear(state, at, radius) {
  const cells = (state.scene?.cells ?? []).filter((cell) => Math.abs(Number(cell.x) - at.x) <= radius && Math.abs(Number(cell.y) - at.y) <= radius)
  return cells.length ? cells : state.scene?.cells ?? []
}

function mutate(raw, casterId, ids) {
  const state = json(raw)
  state.mechanics ??= {}
  state.mechanics.conditions ??= {}
  const add = (id, condition) => { (state.mechanics.conditions[id] ??= []).push(condition) }
  if (chance(0.35)) for (let n = 1 + int(2); n > 0; n -= 1) add(casterId, { id: pick(METAMAGIC) })
  if (chance(0.4)) for (let n = 1 + int(3); n > 0; n -= 1) add(pick(ids), chance(0.2) ? pick(CONDITIONS) : { id: pick(CONDITIONS), source_actor: pick(ids) })
  if (chance(0.15)) add(casterId, { id: 'spirit-shroud', spell_option: pick(['radiant', 'cold', 'x']) })
  if (chance(0.1)) add(casterId, { id: 'absorbing-element-rider:fire', absorb_elements_rider_armed: true, rider_damage_type: 'fire', slot_level: pick([1, 2]) })
  if (chance(0.25)) {
    state.mechanics.concentration ??= {}
    state.mechanics.concentration[casterId] = { effect_id: pick(['old-effect', 'bless:old']), spell_id: 'bless' }
  }
  if (chance(0.2)) {
    const at = E.actorPosition(state, pick(ids)) ?? { x: 5, y: 5 }
    const area = pick(AREAS)
    state.mechanics.active_effects = [...(state.mechanics.active_effects ?? []), { ...json(area), id: `area-${int(99)}`, effect_id: `area-${int(99)}`, center: at, radius_feet: pick([5, 10, 20]), area_shape: 'sphere', source_actor: pick(ids), expires_round: 99 }]
  }
  if (chance(0.15) && state.mechanics.combat?.active) {
    const ready = pick(ids)
    state.mechanics.combat.readied = { ...(state.mechanics.combat.readied ?? {}), [ready]: { trigger: 'enemy-casts-spell', action_id: 'attack', ...(chance(0.5) ? { spell_id: 'fire-bolt' } : {}) } }
  }
  if (chance(0.1) && state.mechanics.combat) state.mechanics.combat.active = !state.mechanics.combat.active
  if (chance(0.15)) state.ruleset_id = pick(['dnd_5e_2014', 'srd_5_2_1', U])
  if (state.ruleset_id === U) delete state.ruleset_id
  if (chance(0.9) && state.mechanics.combat?.active && Array.isArray(state.mechanics.combat.initiative)) {
    const index = state.mechanics.combat.initiative.findIndex((entry) => String(entry.actor_id) === casterId)
    if (index >= 0) state.mechanics.combat.active_index = index
    if (chance(0.7) && state.mechanics.combat.action_economy) delete state.mechanics.combat.action_economy[casterId]
  }
  return state
}

function monsterCaster(state, enemyId, spellIds) {
  const enemy = [...(state.enemies ?? []), ...(state.players ?? []), ...(state.actors ?? [])].find((candidate) => String(candidate.id) === enemyId)
  if (!enemy) return
  enemy.spellcasting = {
    ability: pick(['int', 'wis', 'cha']), save_dc: pick([12, 14, 16]), attack_bonus: pick([4, 6, 8]), caster_level: pick([3, 7, 11]),
    spells: spellIds.map((id) => ({ id, uses: pick(['at-will', 1, 3]) })),
    ...(chance(0.3) ? { spell_slots: [{ level: 1, slots: 2, spells: spellIds.slice(0, 2) }, { level: 3, slots: 1, spells: spellIds.slice(2, 3) }] } : {}),
  }
}

function syntheticCommand(raw, base, n) {
  const normalized = E.normalizeCampaignState(json(raw))
  const ids = E.listActors(normalized).map((actor) => E.actorId(actor))
  const heroes = (normalized.players ?? []).map((actor) => E.actorId(actor))
  const enemies = (normalized.enemies ?? []).map((actor) => E.actorId(actor))
  const npcIds = (normalized.social?.npcs ?? normalized.npc_world?.npcs ?? []).map((npc) => String(npc.id)).slice(0, 4)
  const enemyCaster = enemies.length && chance(0.45)
  const casters = heroes.filter((id) => combatSpellsFor(E.findActor(normalized, id), { rulesetId: normalized.ruleset_id }).length)
  const casterId = enemyCaster ? pick(enemies) : base?.actor_id && chance(0.5) ? String(base.actor_id) : pick(casters.length ? casters : heroes.length ? heroes : ids)
  const state = mutate(raw, casterId, ids.length ? ids : [casterId])
  let spellId
  let context = { serverAuthoritativeCombat: true, isAdmin: true }
  const rulesetId = state.ruleset_id
  if (enemyCaster) {
    const spells = Array.from({ length: 3 }, () => pick(supportedFor(rulesetId)))
    monsterCaster(state, casterId, spells)
    spellId = pick(spells)
    context = { serverAuthoritativeCombat: true, isNpcScheduler: true }
  } else {
    const own = combatSpellsFor(E.findActor(E.normalizeCampaignState(json(state)), casterId), { rulesetId }).map((spell) => spell.id)
    if (!own.length && chance(0.75)) {
      // Герой без своей магии творит блоком стат-блока: так в эталон попадает весь каталог.
      const spells = Array.from({ length: 3 }, () => pick(supportedFor(rulesetId)))
      monsterCaster(state, casterId, spells)
      spellId = pick(spells)
      context = { serverAuthoritativeCombat: true, isNpcScheduler: true, isAdmin: chance(0.5) }
    } else spellId = base?.spell_id && chance(0.35) ? base.spell_id : own.length && chance(0.85) ? pick(own) : pick(supportedFor(rulesetId))
  }
  const spell = canonicalCombatSpellFor(spellId, { rulesetId })
  const at = E.actorPosition(E.normalizeCampaignState(json(state)), pick(ids.length ? ids : [casterId])) ?? { x: 4, y: 4 }
  const cell = pick(cellsNear(state, at, 3)) ?? at
  const input = { command_type: 'CastSpell', command_id: `r9-${n}`, campaign_id: base?.campaign_id ?? 'camp', actor_id: casterId, spell_id: spellId, server_authoritative: chance(0.9) ? true : U }
  if (state.state_version != null && chance(0.8)) input.expected_state_version = state.state_version
  const targetCount = spell?.target === 'self' && !spell?.selectTargetsInArea ? 0 : 1 + int(3)
  const targets = Array.from({ length: targetCount }, () => (chance(0.04) ? 'ghost' : npcIds.length && chance(0.1) ? pick(npcIds) : pick(ids)))
  if (targets.length) {
    input.target_id = targets[0]
    input.target_ids = chance(0.8) ? targets : [targets[0]]
  }
  if (spell?.target === 'point' || chance(0.15)) input.to = chance(0.92) ? { x: Number(cell.x), y: Number(cell.y) } : pick([{ x: 'a', y: 1 }, null, { x: 1.5, y: 2 }])
  if (chance(0.4)) input.slot_level = pick([1, 2, 3, 4, 5, '3', 9, 0])
  if (Array.isArray(spell?.spellOptions) && spell.spellOptions.length) input.spell_option = chance(0.85) ? pick(spell.spellOptions) : pick(['bogus', U])
  else if (chance(0.1)) input.spell_option = pick(['fire', 'cold', 'athletics', 'arcana'])
  if (chance(0.1)) input.transmuted_damage_type = pick(['cold', 'acid', 'psychic'])
  if (chance(0.05)) input.knock_out = true
  if (chance(0.15)) input.visibility = pick(['party', 'gm_only'])
  if (chance(0.1)) input.item_id = pick([...(E.findActor(state, casterId)?.inventory ?? []).map((item) => item.id), 'nothing'])
  if (input.server_authoritative === U) {
    delete input.server_authoritative
    context = chance(0.5) ? { isAdmin: true } : context
    if (chance(0.5)) Object.assign(input, { resource: 'spell_slots_1', cost: pick([1, 2]), max: 3 })
    if (chance(0.4)) Object.assign(input, { concentration: true, name: 'Заклинание' })
  }
  const extra = pick([null, null, null, null, { additionalBeam: true }, { readiedRelease: true },
    { protectiveReactionChoice: { key: `attack:r9-${n}:${input.target_id}`, use: true, kind: pick(['shield', 'uncanny-dodge', 'absorb-elements']), damage_type: 'fire' } },
    { protectiveReactionChoices: [{ key: `attack:r9-${n}:${input.target_id}`, use: chance(0.5), kind: 'shield' }] },
    { elementalDamageChoices: [{ damage_key: `r9-${n}:${input.target_id}:fire`, use: true }] }])
  if (extra) Object.assign(context, extra)
  return { state, input, context }
}

// --- разборы ------------------------------------------------------------------------

const resolves = []
const seen = new Map()
const outcomes = new Map()
const note = (events) => { for (const event of events ?? []) seen.set(event.event_type, (seen.get(event.event_type) ?? 0) + 1) }
// Синтетические состояния хранятся заплатками к состоянию корпуса: список
// `[путь, значение]` (значение `U` — удалить ключ). Новые ключи дописываются
// в конец объекта, изменённые остаются на месте — как присваивание в JS.
function diff(base, next, path, ops) {
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  if (plain(base) && plain(next)) {
    for (const key of Object.keys(base)) if (!(key in next)) ops.push([[...path, key], U])
    for (const key of Object.keys(next)) {
      if (!(key in base)) ops.push([[...path, key], next[key]])
      else diff(base[key], next[key], [...path, key], ops)
    }
    return ops
  }
  if (Array.isArray(base) && Array.isArray(next) && base.length === next.length) {
    next.forEach((item, index) => diff(base[index], item, [...path, String(index)], ops))
    return ops
  }
  if (JSON.stringify(base) !== JSON.stringify(next)) ops.push([path, next])
  return ops
}
function applyPatch(base, ops) {
  const state = json(base)
  for (const [path, value] of ops) {
    let parent = state
    for (const key of path.slice(0, -1)) parent = parent[key]
    if (value === U) delete parent[path.at(-1)]
    else parent[path.at(-1)] = json(value)
  }
  return state
}

function run(stateIndex, raw, input, context, patch) {
  const values = diceValues(60)
  uuidCounter = 0
  const o = attempt(() => {
    const result = E.resolveCommand(json(deepUndefined(input)), json(raw), { diceService: service(values), context: json(context) })
    note(result.events)
    return { command: result.command, events: result.events, rolls: result.rolls }
  })
  const kind = o.ok !== undefined ? 'ok' : o.err ? `err:${o.err[0]}` : o.pause ? `pause:${o.pause}` : `fault:${o.fault}`
  outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1)
  return { s: stateIndex, ...(patch?.length ? { p: patch } : {}), input, context, v: values, o }
}

const baseStates = states.length
for (let s = 0; s < baseStates; s += 1) {
  for (const record of stateRecords[s].slice(0, 4)) resolves.push(run(s, states[s], record.command, record.context ?? {}))
}
for (let n = 0; n < 3200; n += 1) {
  const s = int(baseStates)
  const base = pick(stateRecords[s]).command
  let generated
  try {
    generated = syntheticCommand(states[s], base, n)
  } catch {
    continue
  }
  const patch = diff(states[s], strip(generated.state), [], [])
  const patched = applyPatch(states[s], patch)
  if (JSON.stringify(patched) !== JSON.stringify(strip(generated.state))) throw new Error('эталон: заплатка не воспроизводит состояние')
  resolves.push(run(s, patched, generated.input, generated.context, patch))
}
for (let n = 0; n < 120; n += 1) {
  const s = int(baseStates)
  const normalized = E.normalizeCampaignState(json(states[s]))
  const actorId = pick((normalized.players ?? []).map((actor) => E.actorId(actor)))
  const type = pick(['StartConcentration', 'EndConcentration'])
  const input = { command_type: type, command_id: `c-${n}`, actor_id: actorId, ...(chance(0.5) ? { effect_id: pick(['eff-1', '', 7]) } : chance(0.3) ? { effectId: 'eff-2' } : {}), ...(type === 'EndConcentration' && chance(0.5) ? { reason: pick(['damage', '']) } : {}) }
  resolves.push(run(s, states[s], input, { isAdmin: true }))
}

const mutated = snapshots.map((snapshot, index) => (JSON.stringify(states[index]) === snapshot ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(', ')}`)
const output = { source_sha256: sourceSha256(), states, resolves }
const text = `${JSON.stringify(output)}\n`
const gz = gzipSync(text, { level: 9 })
writeFileSync(new URL('r9.json.gz', import.meta.url), gz)
console.log([...outcomes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log([...seen].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log(`r9.json.gz: ${(gz.length / 1e6).toFixed(2)} МБ (JSON ${(text.length / 1e6).toFixed(1)} МБ), состояний ${states.length}, разборов ${resolves.length}`)
