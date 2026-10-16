import '../../../fixtures-env.mjs'
// Эталоны задачи Р2: состояния, проверки и спасброски, урон и защиты, смерть
// и нулевые хиты, отдых, взлом, «Несгибаемый»; блоки `validateCommand` 57, 58,
// 61, 62, 70; ветки разбора ReduceHitPointMaximum, ResolveHeroDeath,
// Spend/RestoreResource, IdentifyEnemy, Add/RemoveCondition, StartRest,
// SpendHitPointDie, CompleteRest.
//
// Состояния двух родов: синтетические (герои всех классов и видов, противники
// с провенансом 2014 и чертами, состояния таблицы и особые — благословение,
// страх, порча, истощение, аура жизни, противоядие, «Меткий удар», скрытность;
// предметы с пассивными эффектами; клетки сцены со стенами) и корпус
// (`tmp/corpus-v1/states`, без `scene.map` — линия обзора идёт по клеткам).
//
// Вызов — `{ f, s, a, o }`: функция, индекс состояния, аргументы (`U` —
// `undefined`, `{ "$actor": id }` — участник из состояния по ссылке), выход
// (`{ ok }`, `{ err: [code, message] }`, `{ fault: name }`; длинный JSON —
// `sha256:` строки `JSON.stringify`). У бросков — ещё `v` (значения костей) и
// `t` (стенограмма). Блоки проверки и ветки разбора — строки движка в области
// имён открытой копии.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-vitals.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeCatalogItem } from '../../../../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { buildScenarioArcPlan, scenarioForWorldTemplate } from '../../../../server/campaign-scenario.mjs'
import { blockFunction, loadOpenCopy, SOURCE_URL, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0002_5eed
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

function out(value) {
  if (value === undefined) return U
  if (value instanceof Set) value = [...value].sort()
  const text = JSON.stringify(value)
  if (text === undefined) return U
  return text.length > 160 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function attempt(fn) {
  try {
    return { ok: out(fn()) }
  } catch (error) {
    if (error?.name !== 'RulesValidationError') return { fault: String(error?.name), message: String(error?.message ?? '') }
    return { err: [error.code, error.message] }
  }
}

// --- синтетические состояния ----------------------------------------------------

const TABLE = Object.keys(E.CONDITION_EFFECTS)
const SPECIAL = [
  'bless-d4', 'bane-d4', 'beacon-of-hope', 'hidden', 'frightened', 'hexed:wis', 'hexed:dex', 'exhaustion:1', 'exhaustion:3', 'exhaustion:6', 'exhaustion:x',
  'aid-hit-point-maximum:5', 'aid-hit-point-maximum:10', 'aura-of-life', 'antitoxin', 'true-strike', 'borrowed-knowledge:arcana', 'skill-empowerment:stealth',
  'mage-armor', 'light', 'pass-without-trace', 'raging', 'uncanny-dodge', 'absorbing-element:fire', 'blade-ward', 'death-ward',
  'species-trait-used:relentless-endurance', 'freedom-of-movement', 'prone', 'invisible', 'magical-darkness', 'unconscious', 'incapacitated', 'dead',
  'charm-immune', 'immune:charmed', 'stunned', 'paralyzed', 'blinded', 'restrained', 'poisoned', 'next-save-minus-d4',
]
const CLASSES = ['barbarian', 'fighter', 'fighter', 'fighter', 'rogue', 'monk', 'paladin', 'warlock', 'cleric', 'wizard', 'bard', 'druid', 'ranger', 'sorcerer', 'artificer', '']
const SKILLS = ['athletics', 'acrobatics', 'stealth', 'perception', 'arcana', 'religion', 'nature', 'sleight_of_hand', 'sleight-of-hand', 'persuasion', 'insight', 'Perception ', '', 'unknown']
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const DAMAGE = ['fire', 'cold', 'necrotic', 'bludgeoning', 'piercing', 'slashing', 'force', 'poison', 'psychic', 'radiant', 'untyped', 'FIRE']
const ITEMS = ['srd_5_2_1:shield', 'srd_5_2_1:chain-mail', 'srd_5_2_1:leather-armor', 'srd_5_2_1:ring-of-protection', 'srd_5_2_1:cloak-of-protection', 'srd_5_2_1:ring-of-fire-resistance', 'srd_5_2_1:brooch-of-shielding', 'srd_5_2_1:longsword']

function abilities() {
  return Object.fromEntries(ABILITIES.map((ability) => [ability, pick([8, 10, 12, 14, 16, 18, 20, 3, '15', null])]))
}
function inventory(ownerId) {
  const items = []
  for (let n = int(4); n > 0; n -= 1) {
    const item = materializeCatalogItem(pick(ITEMS), { id: `item-${ownerId}-${n}`, quantity: pick([1, 1, 1, 0]), equipped: chance(0.7) })
    if (chance(0.6)) item.attuned_to = pick([ownerId, 'other'])
    if (chance(0.15)) item.passive_effects = [{ schema_version: 1, effect_id: 'fake', group: 'fake', armor_class_bonus: 2, saving_throw_bonus: 1 }]
    items.push(item)
  }
  return items
}
function hero(index, ruleset) {
  const id = `hero-${index}`
  const classKey = pick(CLASSES)
  const maxHp = pick([8, 12, 20, 33, 1])
  const actor = {
    id,
    name: pick([`Герой ${index}`, null, undefined]),
    character: pick([`Персонаж ${index}`, undefined, null]),
    class: classKey,
    characterClass: classKey,
    level: pick([1, 2, 5, 6, 7, 9, 10, 12, 18, '9', 0]),
    proficiency: pick([2, 3, 4, '3', -1, undefined]),
    hp: pick([0, 0, 1, maxHp, Math.floor(maxHp / 2), maxHp - 1]),
    maxHp,
    abilities: abilities(),
    inventory: inventory(id),
    x: int(10), y: int(10),
  }
  if (chance(0.5)) actor.speciesBenefits = { mechanics: {
    ...(chance(0.4) ? { reroll_natural_one: true } : {}),
    ...(chance(0.3) ? { long_rest_hours: pick([4, 6, 7.5, 8, 2, '5']) } : {}),
    ...(chance(0.3) ? { save_advantage_conditions: pick([['frightened'], ['poisoned', 'charmed'], 'poisoned']) } : {}),
    ...(chance(0.3) ? { magic_save_advantage_abilities: pick([['int', 'wis', 'cha'], ['wis']]) } : {}),
    ...(chance(0.3) ? { relentless_endurance: true } : {}),
    ...(chance(0.2) ? { condition_immunities: ['magical-sleep'] } : {}),
    ...(chance(0.3) ? { damage_resistances: pick([['fire'], ['Poison', 'necrotic']]) } : {}),
  } }
  if (chance(0.6)) actor.classSkillProficiencies = Array.from({ length: int(4) }, () => pick(SKILLS))
  if (chance(0.3)) actor.backgroundSkillProficiencies = [pick(SKILLS)]
  if (chance(0.2)) actor.speciesSkillProficiencies = [pick(SKILLS)]
  if (chance(0.2)) actor.skillExpertiseIds = [pick(SKILLS)]
  if (chance(0.3)) actor.characterSheet = {
    skills: Object.fromEntries(Array.from({ length: 2 }, () => [pick(SKILLS), { proficient: chance(0.5), expertise: chance(0.3) }])),
    armor_class: { value: pick([12, 15, 18]), item_effect_bonus: pick([0, 1, 2]) },
  }
  if (chance(0.3)) actor.creationBenefits = { saving_throw_proficiencies: pick([['wis'], 'dex', ['con', 'str']]), passive_skill_bonuses: { perception: pick([5, '2', 'x', null]) } }
  if (chance(0.2)) actor.savingThrowProficiencies = pick([['STR', 'dex'], ['wis']])
  if (chance(0.3)) actor.armor = pick([10, 14, 16, '13', null])
  if (classKey === 'warlock' && chance(0.6)) actor.selectedFeatureIds = ['devils-sight']
  if (chance(0.15)) Object.assign(actor, { origin: { kind: 'authored-npc', npc_id: id, profile_id: 'p1' }, stat_block_id: 'p1', skillModifiers: { perception: pick([5, '7', null]), sleight_of_hand: 4 }, savingThrowModifiers: { dex: pick([3, null, 'x']) } })
  if (chance(0.15)) actor.persuasionModifier = pick([5, '25', null])
  if (chance(0.15)) actor.skills = { persuasion_bonus: pick([2, 'x']) }
  return actor
}
function foe(index, ruleset) {
  const id = `foe-${index}`
  const maxHp = pick([7, 15, 40])
  const statBlockId = pick([`dnd_5e_2014:monster:goblin`, 'dnd_5e_2014:monster:orc', 'srd:goblin'])
  const actor = {
    id,
    name: `Враг ${index}`,
    hp: pick([0, 3, maxHp, Math.floor(maxHp / 2)]),
    maxHp,
    abilities: abilities(),
    creature_type: pick(['undead', 'Нежить', 'beast', 'humanoid', 'fiend', 'plant', 'ooze', undefined, 'celestial']),
    challenge_rating: pick(['1/8', '1/2', '3', 5, '10', ' 2 / 4 ', 'x', undefined, '0/0']),
    x: int(10), y: int(10),
    stat_block_id: statBlockId,
    ...(chance(0.5) ? { provenance: { kind: 'server-owned-dnd-2014-stat-block', ruleset_id: 'dnd_5e_2014', stat_block_id: statBlockId } } : {}),
    ...(chance(0.5) ? { skills: { Stealth: pick([6, '4']), perception: 2, 'Sleight of Hand': 3 } } : {}),
    ...(chance(0.5) ? { saving_throws: { dex: pick([4, 'x', null]), wis: 1 } } : {}),
    ...(chance(0.4) ? { damage_resistances: pick([['fire'], [{ types: ['bludgeoning', 'piercing', 'slashing'], condition: 'nonmagical-attacks' }], ['Cold', { types: ['slashing'], condition: 'nonmagical-attacks-except-silvered' }]]) } : {}),
    ...(chance(0.3) ? { damage_immunities: pick([['poison'], [{ types: ['piercing'], condition: 'nonmagical-attacks-except-adamantine' }]]) } : {}),
    ...(chance(0.3) ? { damage_vulnerabilities: pick([['fire'], ['Radiant']]) } : {}),
    ...(chance(0.4) ? { condition_immunities: pick([['Poisoned', 'charmed'], ['frightened'], ['prone']]) } : {}),
    ...(chance(0.5) ? { traits: pick([['bloodied-frenzy'], [{ id: 'bloodied-frenzy', saving_throws: false }], [{ id: 'evasion' }], ['nimble-escape'], []]) } : {}),
    ...(chance(0.2) ? { cannot_breathe: true } : {}),
    ...(chance(0.2) ? { kind: 'beast' } : {}),
  }
  return actor
}
function conditionEntry(id, actors) {
  const entry = { id }
  if (id === 'bless-d4' && chance(0.4)) entry.bonus_enabled = pick([false, true])
  if (id === 'hidden' && chance(0.6)) entry.check_total = pick([5, 15, 25, '18'])
  if (id === 'frightened') Object.assign(entry, { source_actor: pick(actors), ...(chance(0.2) ? { spell_id: 'phantasmal-killer' } : {}) })
  if (id.startsWith('hexed:')) entry.spell_option = id.slice(6)
  if (id === 'aura-of-life') entry.effect_id = pick(['eff-life', 'other'])
  if (id === 'antitoxin') entry.expires_at_minutes = pick([50, 200, 'x'])
  if (id === 'true-strike') Object.assign(entry, pick([{}, { true_strike_version: 1, true_strike_armed: true, target_actor_id: pick(actors), effect_id: 'eff-ts' }, { true_strike_version: 1, true_strike_armed: false }]))
  if (id.startsWith('borrowed-knowledge:') || id.startsWith('skill-empowerment:')) Object.assign(entry, { skill_buff_version: pick([1, 1, 2]), spell_id: id.split(':')[0], ...(chance(0.4) ? { expires_at_minutes: pick([50, 200]) } : {}), ...(chance(0.3) ? { expires_at_seconds: pick([100, 99999]) } : {}) })
  if (id === 'prone' && chance(0.2)) return 'prone'
  if (chance(0.1)) entry.effect_id = pick(['eff-a', 'eff-life'])
  if (chance(0.1)) entry.source_actor = pick(actors)
  return entry
}
function syntheticState(index) {
  const ruleset = pick(['srd_5_2_1', 'dnd_5e_2014'])
  const players = Array.from({ length: 1 + int(3) }, (_, n) => hero(`${index}-${n}`, ruleset))
  const enemies = Array.from({ length: int(4) }, (_, n) => foe(`${index}-${n}`, ruleset))
  // Проклятый рыцарь сценария: неуязвим до возвращения головы, потом сопротивляется.
  const knight = enemies.length > 0 && chance(0.2)
  if (knight) enemies[0].id = 'astohan-kaelan'
  const actors = chance(0.3) ? [{ id: `summon-${index}`, kind: 'summon', faction: pick(['party', 'hostile']), untargetable: chance(0.5), hp: 5, maxHp: 5, owner_id: players[0].id, x: 1, y: 1 }] : []
  const ids = [...players, ...enemies, ...actors].map((actor) => actor.id)
  const conditions = {}
  const positions = {}
  for (const id of ids) {
    if (chance(0.85)) conditions[id] = Array.from({ length: int(5) }, () => conditionEntry(pick(chance(0.5) ? SPECIAL : TABLE), ids))
    if (chance(0.8)) positions[id] = { x: int(10), y: int(10) }
  }
  const cells = []
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) cells.push({ x, y, type: chance(0.15) ? 'wall' : 'floor' })
  const hero0 = players[0].id
  return json({
    ruleset_id: ruleset,
    state_version: 3,
    players,
    enemies,
    actors,
    partyMemberIds: players.map((player) => player.id),
    ...(knight ? { campaignConcept: { arc: buildScenarioArcPlan(scenarioForWorldTemplate('astohan-plains')) }, scenario_knight: { head_returned: chance(0.5), released: chance(0.15) } } : {}),
    scene: chance(0.7) ? { turn: 1, cells } : { turn: 1 },
    mechanics: {
      conditions,
      positions,
      defenses: Object.fromEntries(ids.filter(() => chance(0.3)).map((id) => [id, { resistances: [pick(DAMAGE)], vulnerabilities: chance(0.3) ? [pick(DAMAGE)] : [], immunities: chance(0.3) ? [pick(DAMAGE)] : [] }])),
      temporary_hp: Object.fromEntries(ids.filter(() => chance(0.3)).map((id) => [id, pick([3, 10, '4', -2])])),
      concentration: Object.fromEntries(ids.filter(() => chance(0.3)).map((id) => [id, { effect_id: pick(['eff-life', 'eff-ts', 'eff-x']), spell_id: 'x' }])),
      death: {
        heroes: Object.fromEntries(players.filter(() => chance(0.4)).map((player) => [player.id, pick([
          { status: 'dead', died_round: pick([1, 3, '2', undefined]), died_world_minutes: pick([100, 90, undefined]) }, { status: 'alive' }, { status: 'dead' },
        ])])),
        saving_throws: Object.fromEntries(players.filter(() => chance(0.5)).map((player) => [player.id, { successes: pick([0, 1, 2, 5]), failures: pick([0, 1, 2, '2']), stable: chance(0.2) }])),
      },
      resting: chance(0.5) ? { [hero0]: pick([
        { rest_id: 'rest-1', kind: 'short', schema_version: 2, started_at_minutes: pick([0, 50, 100]) },
        { rest_id: 'rest-1', kind: 'long', schema_version: 2, started_at_minutes: 0, minimum_duration_minutes: pick([240, 480, undefined, 'x']) },
        { kind: 'short', schema_version: 1, started_at_minutes: 0 },
        { rest_id: 'ko', kind: 'short', reason: 'knockout', schema_version: 2, started_at_minutes: 0 },
      ]) } : {},
      hit_point_dice: chance(0.5) ? { [hero0]: { spent: pick([0, 1, 3, 20, '2']) } } : {},
      world_time: pick([{ elapsed_minutes: 100 }, { elapsed_minutes: 600, elapsed_seconds: 36000 }, {}, { elapsed_minutes: '61' }]),
      combat: { active: chance(0.5), round: pick([1, 2, 5, '3']), action_economy: Object.fromEntries(ids.map((id) => [id, { action: true, bonus_action: pick([true, false]), reaction: true }])), initiative: ids.map((id) => ({ actor_id: id })) },
      shapes: chance(0.2) ? { [pick(ids)]: { effect_id: 'eff-shape', concentration_actor_id: hero0, shape_contract_version: pick([2, 1]) } } : {},
      enemy_knowledge: chance(0.4) ? { party: Object.fromEntries(enemies.map((enemy) => [enemy.id, pick([{ health: 'exact', armor_class: 'exact' }, { health: 'exact' }, {}])])) } : {},
      resources: Object.fromEntries(players.map((player) => [player.id, { indomitable: { current: pick([0, 1, 2]), max: 2 }, ki: { current: pick([0, 3, 5]), max: pick([5, 'x']) } }])),
    },
  })
}

const states = []
for (let index = 0; index < 70; index += 1) states.push({ kind: 'synthetic', state: syntheticState(index) })
// Отдых, опознание и судьба погибшего: вне боя, герой жив и ранен, отдых начат.
for (let index = 90; index < 130; index += 1) {
  const state = syntheticState(index)
  const hero0 = state.players[0]
  hero0.hp = Math.max(1, hero0.maxHp - 1 - int(5))
  state.mechanics.combat.active = chance(0.2)
  state.mechanics.world_time = { elapsed_minutes: pick([600, 61, 30, 1000]) }
  state.mechanics.resting = chance(0.8) ? { [hero0.id]: pick([
    { rest_id: 'rest-1', kind: 'short', schema_version: 2, started_at_minutes: pick([0, 500, 590]), minimum_duration_minutes: 60 },
    { rest_id: 'rest-1', kind: 'long', schema_version: 2, started_at_minutes: pick([0, 200]), minimum_duration_minutes: pick([240, 480, undefined]) },
    { rest_id: 'rest-1', kind: 'short', schema_version: 1, started_at_minutes: 0 },
  ]) } : {}
  state.mechanics.hit_point_dice = { [hero0.id]: { spent: pick([0, 1, 2, 12]) } }
  for (const enemy of state.enemies) enemy.hp = Math.max(1, enemy.hp)
  if (chance(0.4) && state.players[1]) {
    state.players[1].hp = 0
    state.mechanics.death.heroes[state.players[1].id] = { status: 'dead', died_round: 1, died_world_minutes: 590 }
  }
  states.push({ kind: 'synthetic', state })
}

const strip = (state) => {
  const copy = json(state)
  if (copy.scene) delete copy.scene.map
  return copy
}
if (existsSync(join(corpusDir, 'states'))) {
  const files = readdirSync(join(corpusDir, 'states')).sort()
  let taken = 0
  for (const file of files) {
    if (taken >= 40) break
    const path = join(corpusDir, 'states', file)
    if (statSync(path).size > 40_000) continue
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (!(state.players ?? []).length) continue
    if (int(3) !== 0) continue
    states.push({ kind: 'corpus', state: strip(state) })
    taken += 1
  }
}

// --- вызовы ---------------------------------------------------------------------

const snapshots = states.map((entry) => JSON.stringify(entry.state))
const calls = []
const actorArg = (id) => ({ $actor: id })
/** `U` внутри объекта — поле со значением `undefined` (в Rust поля нет). */
function deepUndefined(value) {
  if (value === U) return undefined
  if (Array.isArray(value)) return value.map(deepUndefined)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, deepUndefined(field)]))
  return value
}
function resolveArg(state, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$actor === 'string' && Object.keys(value).length === 1) return E.findActor(state, value.$actor)
  return deepUndefined(value)
}
function call(f, s, args, fn) {
  const state = states[s]?.state
  const resolved = args.map((arg) => resolveArg(state, arg))
  calls.push({ f, s, a: args, o: attempt(() => fn(state, ...resolved)) })
}
function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
const diceCalls = []
function diceCall(f, s, args, fn) {
  const state = states[s].state
  const values = Array.from({ length: 6 }, () => pick([1, 1, 2, 3, 4, 2, 4, 1, 10, 15, 20, 20, 19]))
  const transcript = []
  const dice = E.recordingDiceService(service(values), transcript)
  const resolved = args.map((arg) => resolveArg(state, arg))
  const o = attempt(() => fn(state, dice, ...resolved))
  diceCalls.push({ f, s, a: args, v: values, o, t: json(transcript) })
}

const SPELLS_2014 = ['bless', 'bane', 'mage-armor', 'shield-of-faith', 'barkskin', 'aid', 'haste', 'fly', 'blur', 'mirror-image', 'enlarge-reduce', 'longstrider', 'heroism', 'invisibility', 'protection-from-energy', 'hold-person', 'light']
const spellCards = SPELLS_2014.map((id) => E.canonicalCombatSpellFor(id, { rulesetId: 'dnd_5e_2014' })).filter(Boolean)
const syntheticSpells = [
  { level: 2, conditionExpiryPolicy: 'dnd2014-timed-buff/v1', conditionDurationSeconds: 600 },
  { level: 1, conditionExpiryPolicy: 'dnd2014-timed-buff/v1', conditionDurationSecondsBySlotLevel: { 3: 3600 }, conditionDurationSeconds: 60, concentration: true },
  { level: '2', conditionExpiryPolicy: 'dnd2014-timed-buff/v1', conditionDurationSeconds: 'x' },
  { level: 3, conditionExpiryPolicy: 'other', conditionDurationSeconds: 60 },
  { level: 1, conditionExpiryPolicy: 'dnd2014-timed-buff/v1', conditionDurationSeconds: 90000 },
]
const purposes = ['spell_save:hold-person', 'spell_area_save:web', 'spell_ongoing_save:hold-monster', 'spell_save:sleep', 'trap', 'spell', 'spell_save:nonexistent', U, 'monster_save']
const effects = [
  { skip_already_affected: true, condition: 'restrained', effect_id: 'eff-a' }, { skip_already_affected: true, condition: 'prone', id: 'eff-life' },
  { unaffected_actor_ids: ['hero-1-0', 3, 'foe-2-0'] }, { condition: 'Poisoned', save_damage_type: 'Poison', requires_breathing: true }, { condition: '', save_damage_type: 'fire' },
  { requires_breathing: true }, null, U, { condition: 'frightened', skip_already_affected: true },
]

for (let s = 0; s < states.length; s += 1) {
  const state = states[s].state
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  const someId = () => pick([...ids, ...ids, 'ghost', ''])
  for (let rep = 0; rep < 2; rep += 1) {
    const id = someId()
    const other = someId()
    const ability = pick([...ABILITIES, 'DEX', null, U, '', 'x'])
    // conditions.rs
    call('freedomBlocksSpellCondition', s, [id, pick(['paralyzed', 'restrained', 'prone', 'rime-encased'])], (st, a, b) => E.freedomBlocksSpellCondition(st, a, b))
    const effect = pick(effects)
    call('areaEffectSparesActor', s, [effect, id], (st, a, b) => E.areaEffectSparesActor(a, b))
    call('areaEffectAlreadyHolds', s, [effect, id], (st, a, b) => E.areaEffectAlreadyHolds(st, a, b))
    call('actorDoesNotNeedBreathing', s, [actorArg(id)], (st, a) => E.actorDoesNotNeedBreathing(a))
    call('areaEffectAutomaticSave', s, [id, effect], (st, a, b) => E.areaEffectAutomaticSave(st, a, b))
    call('blessBonusEnabled', s, [id], (st, a) => E.blessBonusEnabled(st, a))
    call('checkAdvantageConditionFor', s, [id, ability], (st, a, b) => E.checkAdvantageConditionFor(st, a, b))
    call('autoFailedSaveConditionFor', s, [id, ability], (st, a, b) => E.autoFailedSaveConditionFor(st, a, b))
    call('conditionNumericBonus', s, [id, pick(['attackBonus', 'armorClassBonus', 'damageBonus', 'speedBonusFeet'])], (st, a, b) => E.conditionNumericBonus(st, a, b))
    call('conditionWeaponDamageDice', s, [id, pick([null, 5, 10, 40])], (st, a, b) => E.conditionWeaponDamageDice(st, a, b))
    call('saveAdvantageConditionFor', s, [id, ability], (st, a, b) => E.saveAdvantageConditionFor(st, a, b))
    call('conditionSaveBonusFor', s, [id, ability], (st, a, b) => E.conditionSaveBonusFor(st, a, b))
    call('saveDisadvantageConditionFor', s, [id, ability], (st, a, b) => E.saveDisadvantageConditionFor(st, a, b))
    const condition = pick(['poisoned', 'frightened', 'charmed:x', '', null, U, 'restrained'])
    const purpose = pick(purposes)
    call('savingThrowAgainstCondition', s, [condition, purpose], (st, a, b) => E.savingThrowAgainstCondition(a, b))
    call('saveAdvantageAgainstConditionFor', s, [id, condition, purpose], (st, a, b, c) => E.saveAdvantageAgainstConditionFor(st, a, { condition: b, purpose: c }))
    const spell = pick([...spellCards, ...syntheticSpells])
    call('spellTimedConditionPayload', s, [{ slot_level: pick([1, 2, 3, 5, U, 'x']) }, spell, chance(0.5)], (st, a, b, c) => E.spellTimedConditionPayload(st, a, b, { extended: c }))
    call('exhaustionLevelOf', s, [id], (st, a) => E.exhaustionLevelOf(st, a))
    const command = { command_id: 'cmd', campaign_id: 'c', actor_id: id, ruleset_id: state.ruleset_id, source_rule_ids: [], target_ids: [], visibility: pick(['public', 'party', undefined]) }
    call('exhaustionStepDownEvents', s, [json(command), id, pick([null, 'greater-restoration', U])], (st, a, b, c) => E.exhaustionStepDownEvents(st, a, b, c))
    call('exhaustionStepUpEvents', s, [json(command), id, pick([U, 'hero-x']), pick([U, 'eff']), pick([U, 'sickening-radiance']), pick([U, 'area-turn'])], (st, a, b, c, d, e, g) => E.exhaustionStepUpEvents(st, a, b, { sourceActor: c, effectId: d, spellId: e, trigger: g }))
    call('hitPointMaximumBonusOf', s, [id], (st, a) => E.hitPointMaximumBonusOf(st, a))
    // skills.rs
    call('enemyLoreCheckFor', s, [actorArg(id)], (st, a) => E.enemyLoreCheckFor(a))
    const skill = pick(SKILLS)
    call('skillProficiencyForActor', s, [actorArg(id), skill, chance(0.8)], (st, a, b, c) => E.skillProficiencyForActor(a, b, c ? st : null))
    call('savingThrowModifierForActor', s, [actorArg(id), ability, pick([U, 2, null, '3', 'x', 1.5]), chance(0.8), chance(0.8)], (st, a, b, c, d, e) => E.savingThrowModifierForActor(a, b, c, d ? st : null, { includeProficiency: e }))
    call('persuasionCheckModifier', s, [actorArg(id)], (st, a) => E.persuasionCheckModifier(a))
    call('serverOwned2014StatBlockFor', s, [actorArg(id)], (st, a) => Boolean(E.serverOwned2014StatBlockFor(a, st)))
    // saves.rs
    call('seesInMagicalDarkness', s, [actorArg(id)], (st, a) => E.seesInMagicalDarkness(a))
    call('speciesSaveAdvantageFor', s, [id, ability, condition, purpose], (st, a, b, c, d) => E.speciesSaveAdvantageFor(st, a, { ability: b, condition: c, purpose: d }))
    call('checkDisadvantageConditionFor', s, [id, ability], (st, a, b) => E.checkDisadvantageConditionFor(st, a, b))
    call('fearSourceInSight', s, [id, other], (st, a, b) => E.fearSourceInSight(st, a, b))
    call('frightenedSourceInSight', s, [id], (st, a) => E.frightenedSourceInSight(st, a))
    call('contestDefenseCheck', s, [actorArg(id)], (st, a) => E.contestDefenseCheck(st, a))
    call('passivePerception', s, [actorArg(id), chance(0.8)], (st, a, b) => E.passivePerception(a, b ? st : null))
    call('hiddenStealthTotal', s, [id], (st, a) => E.hiddenStealthTotal(st, a))
    const party = (state.players ?? []).map((p) => E.actorId(p))
    const foes = (state.enemies ?? []).map((p) => E.actorId(p))
    call('surprisedParticipants', s, [party, foes], (st, a, b) => E.surprisedParticipants(st, { party: a, enemies: b }))
    call('activeTrueStrikeFor', s, [id, other], (st, a, b) => E.activeTrueStrikeFor(st, a, b))
    call('conditionAttackModifiers', s, [id, other, pick([null, 5, 10, 30]), pick([null, 'ranged', 'melee']), pick([U, 10, null, 'x']), pick([true, false])], (st, a, b, c, d, e, g) => E.conditionAttackModifiers(st, a, b, { distanceFeet: c, profileKind: d, meleeReachFeet: e, weaponAttack: g }))
    call('activeAuraOfLifeSource', s, [id], (st, a) => E.activeAuraOfLifeSource(st, a))
    call('activeAuraOfProtection', s, [id], (st, a) => E.activeAuraOfProtection(st, a))
    call('savingThrowModifierWithAura', s, [id, pick([0, 3, '2', U])], (st, a, b) => E.savingThrowModifierWithAura(st, a, b))
    call('isSavingThrowProficient', s, [actorArg(id), ability], (st, a, b) => E.isSavingThrowProficient(a, b))
    call('bloodiedFrenzySaveAdvantage', s, [id], (st, a) => E.bloodiedFrenzySaveAdvantage(st, a))
    call('activeAntitoxinSaveAdvantage', s, [id, pick(['poisoned', 'Poisoned', 'frightened', U])], (st, a, b) => E.activeAntitoxinSaveAdvantage(st, a, b))
    call('litByLightCantrip', s, [id], (st, a) => E.litByLightCantrip(st, a))
    call('weatherCheckSwingFor', s, [pick(['perception', 'survival', 'stealth', 'athletics', U]), id], (st, a, b) => E.weatherCheckSwingFor(st, a, b))
    call('hasEvasion', s, [id], (st, a) => E.hasEvasion(st, a))
    call('savedDamageAmount', s, [id, pick(['dex', 'con', U]), chance(0.5), chance(0.6), pick([0, 7, 13, '9', -3, U])], (st, a, b, c, d, e) => E.savedDamageAmount(st, a, { ability: b, saved: c, halfOnSave: d, total: e }))
    call('dangerSenseAdvantage', s, [id, ability], (st, a, b) => E.dangerSenseAdvantage(st, a, b))
    // damage.rs
    call('resolvedHealingRoll', s, [id, pick(['2d4+2', '1d8', 'x', U, 0, '3d6-10']), pick([5, '3', -1, U])], (st, a, b, c) => E.resolvedHealingRoll(st, a, b, c))
    call('effectiveArmorClass', s, [actorArg(id), id], (st, a, b) => E.effectiveArmorClass(st, a, b))
    call('immuneToMagicalSleep', s, [actorArg(id)], (st, a) => E.immuneToMagicalSleep(st, a))
    call('statBlockConditionImmunities', s, [id], (st, a) => E.statBlockConditionImmunities(st, a))
    call('defenseFor', s, [id], (st, a) => E.defenseFor(st, a))
    const source = pick([null, U, { kind: 'weapon', magical: chance(0.5), properties: pick([['Silvered'], ['adamantine'], []]) }, { kind: 'spell' }, { kind: 'weapon', ignore_resistance: true }])
    const cantrip = pick([null, U, { reduction: pick([2, 4, 0, '3']), condition_id: 'resistance', turn_key: 't1', roll_id: pick(['r1', U]) }])
    call('damagePayload', s, [id, pick([0, 5, 12, 40, '9', 'x', -4, 7.8, 200]), pick([...DAMAGE, U]), cantrip, source], (st, a, b, c, d, e) => E.damagePayload(st, a, b, c, d, e))
    call('conditionArmorClassBonus', s, [id], (st, a) => E.conditionArmorClassBonus(st, a))
    // death.rs
    call('fallsProneEvents', s, [json(command), id], (st, a, b) => E.fallsProneEvents(st, a, b))
    const payload = pick([
      { applied_amount: 5, hp_after: 0, hp_before: 5 }, { applied_amount: 50, hp_after: 0, hp_before: 3 }, { applied_amount: 4, hp_after: 0, hp_before: 0 },
      { applied_amount: 40, hp_after: 0, hp_before: 0 }, { applied_amount: 0, hp_after: 0 }, { applied_amount: 3, hp_after: 2 }, { applied_amount: 3, hp_after: 0 },
    ])
    call('zeroHitPointDamageConsequences', s, [json(command), id, payload, chance(0.3)], (st, a, b, c, d) => E.zeroHitPointDamageConsequences(st, a, b, c, { critical: d }))
    call('assertRevivableHero', s, [id, pick([{}, { reviveWindowRounds: 2, reviveWindowMinutes: 0 }, { reviveWindowMinutes: 'x' }])], (st, a, b) => E.assertRevivableHero(st, a, b))
    // rest.rs
    call('restMinimumMinutesFor', s, [id, pick(['long', 'short', 'x'])], (st, a, b) => E.restMinimumMinutesFor(st, a, b))
    call('hitPointDicePoolForActor', s, [id], (st, a) => E.hitPointDicePoolForActor(st, a))
    call('elapsedRestMinutes', s, [pick([{ started_at_minutes: 30 }, { started_at_minutes: 'x' }, null, U, { started_at_minutes: 9999 }])], (st, a) => E.elapsedRestMinutes(st, a))
    // lockpick.rs
    call('lockpickCheckModifier', s, [actorArg(id)], (st, a) => E.lockpickCheckModifier(a))
    call('lockpickNoticeEvents', s, [json(command), pick(['door', 'container', U]), pick(['door-1', U, 42]), pick(['Дверь', U]), pick([{ success: true }, { success: false, kept: 1 }, { success: false, die: 7 }, U]), pick([U, null, { reason: 'x', severity: 'minor', loud: 1 }])],
      (st, a, b, c, d, e, g) => E.lockpickNoticeEvents(st, a, { targetKind: b, targetId: c, targetLabel: d, check: e, notice: g }))
  }
  // Несгибаемый: события провалов
  const failed = (state.players ?? []).flatMap((player) => [
    { event_type: 'SavingThrowResolved', target_ids: [player.id], payload: { roll_id: 'r', success: false, ...(chance(0.2) ? { auto_failed: true } : {}) } },
    { event_type: 'SpellSavingThrowResolved', target_ids: [player.id], payload: { roll_id: 'r2', saved: false } },
    { event_type: 'DeathSavingThrowRolled', target_ids: [player.id], payload: { roll_id: 'r3', success: true } },
  ])
  call('indomitableOpportunitiesFor', s, [failed, pick([U, [(state.players ?? [])[0]?.id], 'x'])], (st, a, b) => E.indomitableOpportunitiesFor(st, a, b))
  call('withoutImmuneConditions', s, [{ command_id: 'cmd', campaign_id: 'c', actor_id: 'x', ruleset_id: state.ruleset_id, source_rule_ids: [], visibility: pick(['party', undefined]) }, E.listActors(state).slice(0, 3).map((actor) => ({
    event_type: pick(['ConditionAdded', 'ConditionAdded', 'DamageApplied']), target_ids: [E.actorId(actor), ...(chance(0.4) ? ['hero-x'] : [])], visibility: pick(['private', U, null]),
    payload: { condition: pick(['poisoned', 'Charmed', 'frightened', 'prone']), ...(chance(0.5) ? { source_actor: pick([1, 'hero']) } : {}), ...(chance(0.3) ? { spell_id: 'x' } : {}) },
  }))], (st, a, b) => E.withoutImmuneConditions(st, a, b))
}

// прицельно: чаще живые участники, а не призраки
for (let s = 0; s < states.length; s += 1) {
  const state = states[s].state
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  if (!ids.length) continue
  for (let rep = 0; rep < 4; rep += 1) {
    const id = pick(ids)
    const other = pick(ids)
    call('damagePayload', s, [id, pick([5, 12, 40, 3]), pick(DAMAGE), pick([null, { reduction: 3, condition_id: 'resistance', turn_key: 't', roll_id: 'r' }]), pick([null, { kind: 'weapon', magical: chance(0.5) }])], (st, a, b, c, d, e) => E.damagePayload(st, a, b, c, d, e))
    call('activeAuraOfLifeSource', s, [id], (st, a) => E.activeAuraOfLifeSource(st, a))
    call('activeAuraOfProtection', s, [id], (st, a) => E.activeAuraOfProtection(st, a))
    call('litByLightCantrip', s, [id], (st, a) => E.litByLightCantrip(st, a))
    call('activeTrueStrikeFor', s, [id, other], (st, a, b) => E.activeTrueStrikeFor(st, a, b))
    call('skillProficiencyForActor', s, [actorArg(id), pick(['arcana', 'stealth', 'perception', 'Stealth']), true], (st, a, b, c) => E.skillProficiencyForActor(a, b, c ? st : null))
    call('savingThrowModifierForActor', s, [actorArg(id), pick(ABILITIES), pick([U, 1]), true, true], (st, a, b, c, d, e) => E.savingThrowModifierForActor(a, b, c, d ? st : null, { includeProficiency: e }))
    call('effectiveArmorClass', s, [actorArg(id), id], (st, a, b) => E.effectiveArmorClass(st, a, b))
  }
}

// чистые функции без состояния
for (let n = 0; n < 200; n += 1) {
  call('canonicalSkillId', -1, [pick([...SKILLS, null, U, 5, ' Sleight_Of_Hand '])], (st, a) => E.canonicalSkillId(a))
  call('challengeRatingValue', -1, [pick([{ challenge_rating: pick(['1/8', '1/0', '3', ' 2 ', '-1', 'x', '0x10', '1e1', 2]) }, { provenance: { challenge_rating: '1/4' }, challengeRating: 9 }, null])], (st, a) => E.challengeRatingValue(a))
  call('listedSkill', -1, [pick([[' Arcana', 'stealth'], 'arcana', null, ['sleight-of-hand']]), pick(SKILLS)], (st, a, b) => E.listedSkill(a, b))
  call('skillFromCondition', -1, [pick([{ id: 'borrowed-knowledge:arcana', skill_buff_version: 1, spell_id: 'borrowed-knowledge' }, { id: 'borrowed-knowledge:Sleight_Of_Hand', skill_buff_version: 1, spell_id: 'borrowed-knowledge' }, { id: 'borrowed-knowledge:xyz', skill_buff_version: 1, spell_id: 'borrowed-knowledge' }, { id: 'skill-empowerment:stealth', skill_buff_version: '1', spell_id: 'skill-empowerment' }, {}]), pick(['borrowed-knowledge:', 'skill-empowerment:'])], (st, a, b) => E.skillFromCondition(a, b))
  const verified = pick([{ roll_id: 'r1', dice: [12], created_at: 't' }, { dice: [3, 18, 25, 0, '7'] }, { dice: 'x' }, null, { roll_id: 7, dice: [20, 1] }])
  call('checkRollFromVerified', -1, [verified, pick([{}, { modifier: 3, difficulty: 15, purpose: 'save', actorId: 'hero', advantage: true }, { modifier: -2, disadvantage: true, visibility: 'party', purpose: '' }, { difficulty: null, actorId: null, visibility: 'secret' }, { advantage: true, disadvantage: true, modifier: '4' }])], (st, a, b) => E.checkRollFromVerified(a, b))
  call('statBlockDamageList', -1, [pick([['Fire', ' cold ', 'fire'], 'x', null, [1, null]])], (st, a) => E.statBlockDamageList(a))
  call('conditionalDamageDefenseApplies', -1, [pick([[{ types: ['Slashing'], condition: 'Nonmagical-Attacks' }], [{ types: ['piercing'], condition: 'nonmagical-attacks-except-silvered' }], 'x', [null, 5]]), pick(['slashing', 'piercing', U, 'SLASHING']), pick([{ kind: 'weapon' }, { kind: 'weapon', magical: true }, { kind: 'weapon', properties: ['Silvered'] }, null])], (st, a, b, c) => E.conditionalDamageDefenseApplies(a, b, c))
  call('damagePayloadWithHpFloor', -1, [{ hp_before: pick([10, 3, 0, '8']), hp_after: pick([0, 2, 5]), applied_amount: 7, damage_type: 'x' }, pick([1, 4, 0, U, '2', -1])], (st, a, b) => E.damagePayloadWithHpFloor(a, b))
  call('spellHpPoolExpression', -1, [pick(['2d8', '1d6+1', 'x', '3d8']), pick(['1d8', '2d8-1', '1d6', 'y']), pick([1, 2, '2', U, null]), pick([3, 5, U, 'x', 9])], (st, a, b, c, d) => E.spellHpPoolExpression(a, b, c, d))
  call('savingThrowSucceeded', -1, [pick([{ total: 12 }, { total: 12, auto_failed: true }, { total: '15' }, null]), pick([10, 12, 15, 12.5])], (st, a, b) => E.savingThrowSucceeded(a, b))
}

// --- броски ---------------------------------------------------------------------

for (let s = 0; s < states.length; s += 1) {
  const state = states[s].state
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  for (let rep = 0; rep < 3; rep += 1) {
    const id = pick(ids)
    const other = pick(ids)
    const ability = pick([...ABILITIES, U])
    diceCall('rollD20WithSpeciesLuck', s, [id, pick([{ modifier: 2, purpose: 'x', actorId: id, visibility: 'party' }, { modifier: 0, advantage: true, actorId: id }, { disadvantage: true, purpose: null }]), pick(['rollD20', 'rollCheck'])], (st, d, a, b, c) => E.rollD20WithSpeciesLuck(st, d, a, c === 'rollCheck' ? { ...b, difficulty: 12 } : b, c))
    diceCall('rollAbilityCheckWithConditions', s, [id, ability, { modifier: 1, difficulty: 13, purpose: 'check', actorId: id, ...(chance(0.3) ? { advantage: true } : {}) }, pick(['rollD20', 'rollCheck'])], (st, d, a, b, c, e) => E.rollAbilityCheckWithConditions(st, d, a, b, c, e))
    diceCall('grappleContest', s, [{ actor_id: id, action_id: pick(['grapple', 'shove']), visibility: pick(['public', undefined]) }, other], (st, d, a, b) => { const rolls = []; const result = E.grappleContest(st, d, a, b, rolls); return { result, rolls } })
    const options = { ability, modifier: pick([U, 2, null, '1']), purpose: pick(purposes), difficulty: 14, actorId: 'ignored', visibility: pick(['public', 'private', U]), ...(chance(0.3) ? { advantage: true } : {}), ...(chance(0.2) ? { disadvantage: true } : {}), ...(chance(0.4) ? { avoid_or_end_condition: pick(['poisoned', 'frightened', 'charmed']) } : {}) }
    diceCall('rollSavingThrowD20', s, [id, json(options)], (st, d, a, b) => E.rollSavingThrowD20(st, d, a, b))
    diceCall('rollSavingThrowCheck', s, [id, json(options)], (st, d, a, b) => E.rollSavingThrowCheck(st, d, a, b))
    const command = { command_id: 'cmd', campaign_id: 'c', actor_id: 'x', ruleset_id: state.ruleset_id, source_rule_ids: [], target_ids: [], visibility: pick(['party', undefined]) }
    diceCall('deathSavingThrowAtTurnStart', s, [json(command), pick((state.players ?? []).map((p) => p.id))], (st, d, a, b) => { const result = E.deathSavingThrowAtTurnStart(st, a, b, d); return { events: result.events, rolls: result.rolls } })
  }
}

// --- блоки проверки ----------------------------------------------------------------

const blocks = {
  b57: await blockFunction([[6981, 6981], [6985, 6992]], ['const actorFate', "if (command.command_type === 'ResolveHeroDeath')"], ['state', 'command', 'context'], 'return command'),
  b58: await blockFunction([[6994, 7042]], ["if (['StartRest', 'SpendHitPointDie', 'CompleteRest']"], ['state', 'command', 'context'], 'return command'),
  b61: await blockFunction([[7058, 7060]], ["if (command.command_type === 'ApplyHealing'"], ['state', 'command', 'context'], 'return command'),
  b62: await blockFunction([[7061, 7063]], ["if (command.command_type === 'ReduceHitPointMaximum'"], ['state', 'command', 'context'], 'return command'),
  b70: await blockFunction([[7569, 7585]], ["if (command.command_type === 'IdentifyEnemy')"], ['state', 'command', 'context'], 'return command'),
}
const TYPES = ['ResolveHeroDeath', 'StartRest', 'SpendHitPointDie', 'SpendHitPointDie', 'CompleteRest', 'CompleteRest', 'ApplyHealing', 'ReduceHitPointMaximum', 'IdentifyEnemy', 'IdentifyEnemy', 'SpendResource', 'RestoreResource', 'AddCondition', 'RemoveCondition']
const contexts = [{}, { isAdmin: true }, { serverAuthoritativeCombat: 1 }, { isNpcScheduler: true, isAdmin: true }, { isAdmin: 'yes' }]
function randomCommand(state) {
  const ids = E.listActors(state).map((actor) => E.actorId(actor))
  const type = pick(TYPES)
  const heroes = (state.players ?? []).map((actor) => E.actorId(actor))
  const foes = (state.enemies ?? []).map((actor) => E.actorId(actor))
  const focused = chance(0.7) && heroes.length
  const actor = focused ? (type === 'ResolveHeroDeath' ? pick(heroes.slice(1).length ? heroes.slice(1) : heroes) : heroes[0]) : pick([...ids, ...ids, 'ghost'])
  const input = { command_type: type, command_id: `cmd-${int(1000)}`, campaign_id: 'camp', actor_id: actor, source_rule_ids: ['srd_5_2_1:combat:damage'] }
  if (focused && type === 'IdentifyEnemy' && foes.length) input.target_id = pick(foes)
  else if (chance(0.7)) input.target_id = pick([...ids, 'ghost', ''])
  if (chance(0.5)) input.kind = pick(['long', 'short', 'x'])
  if (chance(0.4)) input.rest_id = pick(['rest-1', 'rest-1', 'other', 'ko'])
  if (chance(0.6)) input.resolution = pick(['resurrect', 'replace', 'x'])
  if (chance(0.6)) input.replacement_name = pick(['Новый герой', 'A', ' Б ', ''])
  if (chance(0.6)) input.amount = pick([1, 3, 5, 20, '2'])
  if (chance(0.5)) input.resource = pick(['ki', 'indomitable', 'rage'])
  if (chance(0.3)) input.max = pick([5, 'x', 2])
  if (chance(0.5)) input.condition = pick(['prone', 'disengaged', 'poisoned', 'frightened'])
  if (chance(0.3)) input.duration = pick(['1-round', 'until-removed'])
  if (chance(0.3)) input.monster_ability = 'nimble-escape'
  if (chance(0.3)) input.advantage = true
  if (chance(0.2)) input.disadvantage = true
  if (chance(0.3)) input.visibility = pick(['party', 'private'])
  if (chance(0.3)) input.request_fingerprint = 'fp-1'
  return E.normalizeCommand(json(input), state)
}
const blockCases = []
const commands = []
for (let n = 0; n < 1500; n += 1) {
  const s = int(states.length)
  const state = states[s].state
  let command
  try { command = randomCommand(state) } catch { continue }
  const context = pick(contexts)
  const input = commands.push({ s, command: json(command), context }) - 1
  for (const [name, run] of Object.entries(blocks)) {
    const copy = structuredClone(command)
    blockCases.push({ block: name, input, ...attempt(() => run(state, copy, context)) })
  }
}

// --- ветки разбора ------------------------------------------------------------------

const engineLines = readFileSync(SOURCE_URL, 'utf8').split(/\r?\n/)
const RANGES = [[15167, 15237], [15241, 15283], [15295, 15313], [15341, 15343], [22605, 22738]]
const ANCHORS = ["case 'ReduceHitPointMaximum'", "case 'IdentifyEnemy'", "case 'AddCondition'", "case 'RemoveCondition'", "case 'StartRest'"]
RANGES.forEach(([from], index) => { if (!engineLines[from - 1].trimStart().startsWith(ANCHORS[index])) throw new Error(`строка ${from} не «${ANCHORS[index]}»`) })
const body = RANGES.map(([from, to]) => engineLines.slice(from - 1, to).join('\n')).join('\n')
// eslint-disable-next-line no-new-func -- нестрогий режим нужен ради `with`
const branchFn = new Function('__engine', 'state', 'command', 'context', 'targetId', 'events', 'rolls', 'diceService', `with (__engine) {\nswitch (command.command_type) {\n${body}\n}\nreturn { events, rolls }\n}`)
const validators = [blocks.b57, blocks.b58, blocks.b62, blocks.b70]
const branchCases = []
const perType = new Map()
for (let n = 0; n < 40000 && branchCases.length < 900; n += 1) {
  const s = int(states.length)
  const state = states[s].state
  if (E.truceFor(state)) continue
  let command
  try { command = randomCommand(state) } catch { continue }
  const context = pick(contexts)
  if (command.command_type === 'ApplyHealing' || (perType.get(command.command_type) ?? 0) >= 90) continue
  try { for (const run of validators) command = run(state, command, context) } catch { continue }
  const values = Array.from({ length: 4 }, () => pick(command.command_type === 'IdentifyEnemy' ? [1, 2, 5, 10, 15, 19, 20] : [1, 2, 3, 4, 5, 6]))
  const o = attempt(() => branchFn(E, structuredClone(state), command, context, E.targetFor(command), [], [], service(values)))
  perType.set(command.command_type, (perType.get(command.command_type) ?? 0) + 1)
  branchCases.push({ s, command: json(command), context, v: values, o })
}

const mutated = states.map((entry, index) => (JSON.stringify(entry.state) === snapshots[index] ? null : index)).filter((index) => index != null)
if (mutated.length) throw new Error(`эталон: вызовы JS изменили состояния ${mutated.join(", ")}`)
const output = { source_sha256: sourceSha256(), states: states.map((entry) => entry.state), calls, dice: diceCalls, commands, blocks: blockCases, branches: branchCases }
writeFileSync(new URL('vitals.json', import.meta.url), `${JSON.stringify(output)}\n`)
const errors = calls.filter((entry) => entry.o.err || entry.o.fault).length
console.log(`vitals.json: состояний ${states.length}, вызовов ${calls.length} (ошибок ${errors}), бросков ${diceCalls.length}, блоков ${blockCases.length}, веток ${branchCases.length}`)
