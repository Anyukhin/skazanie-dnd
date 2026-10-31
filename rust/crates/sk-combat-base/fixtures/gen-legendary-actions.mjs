// Эталон legendary-actions для Rust: профили настоящих стат-блоков
// (data/campaign-worlds-v1.json) и сотен случайных, в том числе с мусором в
// полях; ключи окна, счёт маркеров, решения о сопротивлении и выбор действия.
//
//   node rust/crates/sk-combat-base/fixtures/gen-legendary-actions.mjs
//
// Пишет legendary-actions.json рядом с собой.
import './force-en-collation.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  chooseLegendaryAction,
  legendaryActionFor,
  legendaryProfileFor,
  legendaryResistanceDecision,
  legendaryResistanceSpent,
  legendaryUsesSpent,
  legendaryWindowKey,
  legendaryWindowSpent,
} from '../../../../server/legendary-actions.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(31337)
const pick = (items) => items[Math.floor(random() * items.length)]
const maybe = (probability, make) => (random() < probability ? make() : undefined)

const real = []
const walk = (value) => {
  if (Array.isArray(value)) value.forEach(walk)
  else if (value && typeof value === 'object') {
    if (value.legendary && typeof value.legendary === 'object') real.push(value)
    Object.values(value).forEach(walk)
  }
}
walk(JSON.parse(readFileSync(here('../../../../data/campaign-worlds-v1.json'), 'utf8')))

const NUMBERS = [0, 1, 2, 3, 5, 6, 7, -1, 2.5, 0.4, '3', 'x', null, 'Infinity', '', true, 1e9, 600, 601, 120, 121, 9.99]
const ID = ['tail', 'wing', 'bite', 'roar', '', null, 5, 'b', 'a', 'Ёж', 'z'.repeat(5)]
function randomAction() {
  const action = {}
  const put = (key, make) => {
    const value = maybe(0.75, make)
    if (value !== undefined) action[key] = value
  }
  put('id', () => pick(ID))
  put('name', () => pick(['Удар хвостом', 'x'.repeat(130), 7, null, '']))
  put('cost', () => pick(NUMBERS))
  put('kind', () => pick(['attack', 'save', 'teleport', null, 'ATTACK']))
  put(pick(['attack_modifier', 'attackModifier']), () => pick(NUMBERS))
  put('damage_expression', () => pick(['2d8+5', null, 3, '']))
  put('damage_type', () => pick(['fire', null, 4]))
  put('save_ability', () => pick(['str', 'dex', 'wis', 'luck', null, 3]))
  put('save_dc', () => pick(NUMBERS))
  put('half_on_save', () => pick([true, false, 'true', 1]))
  put('condition', () => pick(['prone', null, 0]))
  put(pick(['range_feet', 'rangeFeet']), () => pick(NUMBERS))
  put(pick(['radius_feet', 'radiusFeet']), () => pick(NUMBERS))
  put(pick(['area_shape', 'areaShape']), () => pick(['cone', 'sphere', 'line', null]))
  put(pick(['cooldown_turns', 'cooldownTurns']), () => pick(NUMBERS))
  return action
}
function randomActor() {
  const legendary = {}
  if (random() < 0.85) legendary.uses = pick(NUMBERS)
  if (random() < 0.6) legendary[pick(['resistance', 'legendary_resistance'])] = pick(NUMBERS)
  const count = Math.floor(random() * 9)
  if (random() < 0.95) legendary.actions = random() < 0.05 ? 'x' : Array.from({ length: count }, () => (random() < 0.05 ? null : randomAction()))
  const actor = { id: 'boss' }
  const roll = random()
  actor.legendary = roll < 0.04 ? null : roll < 0.07 ? [legendary] : roll < 0.09 ? 'x' : legendary
  return actor
}
const actors = [...real, ...Array.from({ length: 500 }, randomActor), { id: 'none' }]

const profiles = actors.map((actor, index) => ({ actor: index, profile: legendaryProfileFor(actor) }))
const bosses = actors.map((actor, index) => index).filter((index) => profiles[index].profile)
const pickActor = () => (random() < 0.8 ? pick(bosses) : Math.floor(random() * actors.length))
const lookups = []
for (let index = 0; index < 200; index += 1) {
  const actor = pickActor()
  const id = pick([...ID, undefined, 'tail'])
  lookups.push({ actor, id: id ?? null, missing: id === undefined, action: legendaryActionFor(actors[actor], id) })
}

const combats = [null, {}, { round: 1, active_index: 0 }, { round: 2 }, { round: '3', active_index: '2' }, { round: -1, active_index: -1 }, { round: 2.7, active_index: 1.9 },
  { round: 'x', active_index: null }, { round: 'Infinity', active_index: 'Infinity' }, { round: null, active_index: -0.5 }, { active_index: true }]
const windows = combats.map((combat) => ({ combat, key: legendaryWindowKey(combat ?? undefined), missing: combat === null }))

const markerPool = ['legendary-action-used:1:r1i0', 'legendary-action-used:2:r1i0', 'legendary-action-used:1:r1i1', 'legendary-resistance-used:1', 'legendary-resistance-used:2',
  'legendary-cooldown:tail', 'legendary-cooldown:wing', 'prone', 'legendary-action-used:3:r2iNaN', 'legendary-action-used:', 'xlegendary-action-used:1:r1i0']
const counts = Array.from({ length: 80 }, () => {
  const conditions = Array.from({ length: Math.floor(random() * 6) }, () => pick(markerPool))
  const windowKey = pick(['r1i0', 'r1i1', 'r2iNaN', ''])
  return { conditions, windowKey, uses: legendaryUsesSpent(conditions), window: legendaryWindowSpent(conditions, windowKey), resistance: legendaryResistanceSpent(conditions) }
})

const CONDITIONS = ['paralyzed', 'stunned:boss', 'prone', 'frightened:x:y', 'charmed', 'poisoned', 'restrained', 'grappled', 5, null, 'banished']
const decisions = []
for (let index = 0; index < 300; index += 1) {
  const actor = pickActor()
  const input = {
    actor: actors[actor],
    spentUses: pick([0, 1, 2, 3, -1, 1.5, 'x', null, '1']),
    conditions: random() < 0.05 ? 'paralyzed' : Array.from({ length: Math.floor(random() * 3) }, () => pick(CONDITIONS)),
    damage: pick([0, 9, 120, 130, -5, 2.5, null, 'x', '200']),
    hpBefore: pick([0, 120, 9, 130, -1, null, 'x']),
  }
  decisions.push({ input: { ...input, actor }, decision: legendaryResistanceDecision(input) })
}

const choices = []
for (let index = 0; index < 400; index += 1) {
  const actor = pickActor()
  const targets = Array.from({ length: Math.floor(random() * 5) }, () => ({ id: pick(['a', 'b', 'c', 'hero', 'Ёж', 7]), distanceFeet: pick([0, 5, 10, 15, 20, 30, 60, 120, 600, 601, 7.5]) }))
  const cooling = Array.from({ length: Math.floor(random() * 3) }, () => pick(['legendary-cooldown:tail', 'legendary-cooldown:wing', 'legendary-cooldown:bite', 'legendary-cooldown:a', 'tail']))
  const remainingUses = pick([0, 1, 2, 3, 5, -1, 2.5, 'x', null])
  const choice = chooseLegendaryAction({ actor: actors[actor], remainingUses, targets, coolingDown: new Set(cooling) })
  choices.push({ actor, remainingUses, targets, cooling, choice })
}

const fixture = { actors, profiles, lookups, windows, counts, decisions, choices }
const lines = Object.entries(fixture).map(([key, value]) => `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
writeFileSync(here('legendary-actions.json'), `{\n${lines.join(',\n')}\n}\n`)
console.log(`legendary-actions.json: ${real.length} настоящих стат-блоков, ${profiles.filter((entry) => entry.profile).length}/${profiles.length} профилей, ${decisions.filter((entry) => entry.decision).length}/${decisions.length} решений, ${choices.filter((entry) => entry.choice).length}/${choices.length} выборов`)
