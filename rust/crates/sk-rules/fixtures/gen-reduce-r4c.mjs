import '../../../fixtures-env.mjs'
// Эталоны Р4в на синтетических состояниях: ветки мира NPC (`NpcPlaced`,
// `NpcMoved`, `NpcHarmed`, `NpcDied`, `NpcStanceChanged`) и реестры-выводы
// таверны, благословений и зверей (`applyTavernEvent`, `applyBlessingEvent`,
// `applyBeastEvent` после `switch`).
//
// Корпус (`gen-reduce-r4a-corpus.mjs`) даёт правдоподобные события; здесь —
// мусор в payload: чужие и пустые id, ключи прототипа, дробные и строковые
// числа, `null` вместо объектов, отсутствующий и пустой `temporary_hp_after`.
// Состояния заранее несут реестры: несколько настоящих событий применяются
// движком JS до нормализации к неподвижной точке.
//
// Эталон — sha256 `JSON.stringify` состояния после `applyGameEvent` без
// производных полей героя, без закона (читает летопись `world_deeds`) и без
// неперенесённых реестров; событие, на котором JS бросает, помечено `throws`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-reduce-r4c.mjs
// Отладка: … gen-reduce-r4c.mjs --dump <номер случая> — полное состояние JS.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

let seed = 0x4a4a0c04
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p
const maybe = (p, value) => (chance(p) ? value : undefined)

// --- состояния --------------------------------------------------------------

function tavernCells() {
  const cells = []
  for (let y = 0; y < 12; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      const border = x === 0 || y === 0 || x === 11 || y === 11
      const cell = { x, y, type: border ? 'wall' : 'floor', revealed: true }
      if (x === 5 && y === 0) cell.type = 'door'
      if (x === 3 && y === 3) cell.feature = 'table'
      cells.push(cell)
    }
  }
  return cells
}

const heroes = () => [
  { id: 'hero', name: 'Герой', characterClass: 'fighter', level: 3, hp: 20, maxHp: 28, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, inventory: [{ id: 'rations', name: 'Сухой паёк, 1 день', type: 'gear', quantity: 3 }], currency: { gold: 3, silver: 2 } },
  { id: 'hero-2', name: 'Второй', characterClass: 'cleric', level: 2, hp: 12, maxHp: 14, inventory: [], currency: { copper: 40 } },
]

const npcs = [
  { id: 'barkeep', name: 'Трактирщик Бажен', role: 'трактирщик', location_id: 'inn', available: true },
  { id: 'npc-guard', name: 'Страж Бран', role: 'стражник', tags: ['guard'], location_id: 'inn' },
  { id: 'father', name: 'Отец Никодим', role: 'жрец', tags: ['priest'], location: 'Трактир' },
  { id: 'npc-far', name: 'Дальний', location_id: 'elsewhere' },
  { id: 'constructor', name: 'Ключ прототипа', location_id: 'inn' },
]

const raws = [
  {
    sessionCode: 'R4C-A', campaign: 'Трактир', partyMemberIds: ['hero', 'hero-2'], activePlayerId: 'hero', players: heroes(),
    enemies: [{ id: 'enemy-wolf', name: 'Волк 1', hp: 11, maxHp: 11, x: 8, y: 8, stat_block_id: 'srd_5_2_1:wolf', challenge_rating: '1/4' }],
    scene: { location_id: 'inn', location: 'Трактир', title: 'Трактир', objective: 'Отдохнуть', turn: 1, cells: tavernCells(), tags: ['tavern'] },
    social: { npcs },
    npc_world: {
      placements: [{ npc_id: 'barkeep', location_id: 'inn', x: 3, y: 4 }, { npc_id: 'npc-guard', location_id: 'inn', x: 6, y: 6, footprint: { version: 1, size: 2 } }, { npc_id: 'npc-far', location_id: 'elsewhere', x: 1, y: 1 }],
      vitals: { 'npc-guard': { hp: 9, max_hp: 11, alive: true } },
      stances: { barkeep: { stance: 'guarded', reason: 'test', source_event_id: 'e-0', propagation_depth: 0 } },
      inventories: { barkeep: [{ id: 'mug', name: 'Кружка', quantity: 2 }] },
    },
    mechanics: { positions: { hero: { x: 2, y: 2 }, 'hero-2': { x: 2, y: 3 }, 'enemy-wolf': { x: 8, y: 8 } }, temporary_hp: { hero: 2, barkeep: 1 } },
  },
  {
    sessionCode: 'R4C-B', campaign: 'Бой', partyMemberIds: ['hero'], activePlayerId: 'hero', players: heroes(),
    scene: { location_id: 'inn', location: 'Трактир', title: 'Трактир', cells: tavernCells() },
    social: { npcs },
    npc_world: { placements: [{ npc_id: 'barkeep', location_id: 'inn', x: 3, y: 4 }], vitals: { barkeep: { hp: 2, max_hp: 4, alive: true }, father: { hp: 0, max_hp: 7, alive: false } } },
    mechanics: { combat: { active: true, round: 2, initiative: [{ actor_id: 'hero' }], active_index: 0 } },
  },
  { sessionCode: 'R4C-C', campaign: 'Пусто', players: [{ id: 'solo', name: 'Один', hp: 5, maxHp: 5 }] },
]

const at = (minutes) => ({ at_minutes: minutes, policy_id: 'skazanie:tavern-life-v1' })
// Настоящие события, после которых у состояния есть реестры.
const warmup = [
  { event_type: 'TavernDiceRoundOpened', payload: { round: { id: 'tavern-round:w-1', hero_id: 'hero', npc_id: 'barkeep', npc_name: 'Трактирщик Бажен', stake_cp: 10, npc_total: 6, target: 7, opened_at_minutes: 0 }, hero_id: 'hero', npc_id: 'barkeep', stake_cp: 10, npc_total: 6, ...at(0) } },
  { event_type: 'TavernDrinkOrdered', payload: { hero_id: 'hero-2', drinks: 1, price_cp: 4, ...at(5) } },
  { event_type: 'ShrinePrayerResolved', payload: { hero_id: 'hero', prop_id: 'prop-altar', place_name: 'Часовня', outcome: 'blessed', skill: 'religion', difficulty: 12, total: 15, condition: 'minor-blessing', attack_bonus: 1, duration: 'until-long-rest', at_minutes: 0, policy_id: 'skazanie:blessings-v1' } },
  { event_type: 'BeastEncountered', payload: { beast: { id: 'beast:w', actor_id: 'enemy-wolf', name: 'Волк 1', diet: 'predator', stat_block_id: 'srd_5_2_1:wolf', challenge_rating: '1/4', stage: 'wary', status: 'wild', attempts: 0, bites: 0, location_id: 'inn', location_name: 'Трактир', met_at_minutes: 0, calmed_at_minutes: null, fed_at_minutes: null, tamed_at_minutes: null, scared_at_minutes: null, policy_id: 'skazanie:beast-taming-v1' } } },
]

function fixedPoint(raw) {
  let state = E.normalizeCampaignState(json(raw))
  for (let pass = 0; pass < 6; pass += 1) {
    const next = E.normalizeCampaignState(state)
    if (JSON.stringify(next) === JSON.stringify(state)) return state
    state = next
  }
  throw new Error('нормализация не сходится')
}
const bases = raws.map((raw, index) => {
  let state = fixedPoint(raw)
  if (index < 2) for (const [n, event] of warmup.entries()) state = E.applyGameEvent(state, { event_id: `warm-${n}`, actor_id: 'hero', target_ids: [], ...event })
  return fixedPoint(state)
})

// --- события ----------------------------------------------------------------

const npcIds = ['barkeep', 'npc-guard', 'father', 'npc-far', 'ghost', ' barkeep ', 'constructor', '__proto__', 'toString', '', null, undefined, 7]
const heroIds = ['hero', 'hero-2', 'solo', 'ghost', '', null, undefined, 5, 'constructor']
const texts = ['', '  Текст  с\tпробелами ', 'x'.repeat(200), 'обычный', null, undefined, 42, true]
const numbers = [0, 1, 2, 3, -1, '2', 'x', null, undefined, 1.5, 9e15, 40, 600]
const bools = [true, false, 'true', 1, null, undefined]
const locations = ['inn', 'elsewhere', '', '  inn ', null, undefined, 5]
const footprints = [{ version: 1, size: 2 }, { version: 1, size: 9 }, { size: 2 }, null, undefined, 'x']
const vitalities = [{ hp: 3, max_hp: 5, alive: true }, { hp: 'x', max_hp: 900 }, { alive: false }, { hp: -4, max_hp: 0 }, null, undefined, 5, ['a']]
const stances = ['neutral', 'guarded', 'frightened', 'hostile', 'fleeing', 'dead', 'странная', null, undefined, 3]
const beastIds = ['beast:w', 'beast:none', '', null, undefined]

const placement = () => ({
  npc_id: pick(npcIds), npc_name: maybe(0.5, 'Имя'), location_id: pick(locations), x: pick(numbers), y: pick(numbers),
  footprint: pick(footprints), anchor_prop_id: pick(texts), placement_reason: pick(['role-suitable-post', '', undefined, 'x'.repeat(100), 3]),
  source_event_id: maybe(0.3, pick(texts)), vitality: pick(vitalities), from: maybe(0.3, { x: 1, y: 1 }),
})

const builders = {
  NpcPlaced: placement,
  NpcMoved: placement,
  NpcHarmed: () => {
    const payload = {
      npc_id: pick(npcIds), hp_after: pick(numbers), max_hp: pick(numbers), schema_version: pick([2, 1, '2', undefined]),
      non_lethal: pick(bools), alive: pick(bools), hp_before: pick(numbers), damage_type: pick(['fire', undefined]),
    }
    if (chance(0.6)) payload.temporary_hp_after = pick([0, 3, -2, '4', 'x', null, 1.5, undefined])
    return payload
  },
  NpcDied: () => ({ npc_id: pick(npcIds), location_id: pick(locations), source_event_id: pick(texts) }),
  NpcStanceChanged: () => ({ npc_id: pick(npcIds), stance: pick(stances), reason: pick(texts), source_event_id: pick(texts), propagation_depth: pick(numbers) }),
  TavernDiceRoundOpened: () => ({
    round: pick([{ id: pick(['tavern-round:g-1', '', undefined]), hero_id: pick(heroIds), npc_id: pick(npcIds), npc_name: pick(texts), stake_cp: pick([10, 50, 200, 7, 'x']), npc_total: pick(numbers), target: pick(numbers), opened_at_minutes: pick(numbers) }, null, undefined, 'x']),
    hero_id: pick(heroIds), npc_id: pick(npcIds), stake_cp: pick(numbers), at_minutes: pick(numbers), currency_after: maybe(0.3, { gold: 1 }),
  }),
  TavernDiceRoundResolved: () => ({
    round_id: pick(['tavern-round:w-1', 'tavern-round:g-1', '', undefined]), hero_id: pick(heroIds), npc_id: pick(npcIds), approach: pick(['fair', 'cheat', 'watch', 'x', undefined]),
    stake_cp: pick(numbers), outcome: pick(['win', 'loss', 'tie', 'exposed', undefined]), cheated: pick(bools), exposed: pick(bools), delta_cp: pick(numbers), net_cp: pick(numbers),
    npc_purse_before_cp: pick(numbers), npc_purse_after_cp: pick(numbers), at_minutes: pick(numbers),
  }),
  TavernDiceRoundCancelled: () => ({ round_id: pick(['tavern-round:w-1', '', undefined]), hero_id: pick(heroIds), npc_id: pick(npcIds), forfeited_cp: pick(numbers), reason: pick(['surrendered', 'left', undefined]), npc_purse_after_cp: pick(numbers), at_minutes: pick(numbers) }),
  TavernDrinkOrdered: () => ({ hero_id: pick(heroIds), drinks: pick(numbers), price_cp: pick(numbers), at_minutes: pick(numbers), currency_after: maybe(0.3, { copper: 3 }) }),
  TavernPatronEjected: () => ({ hero_id: pick(heroIds), npc_id: pick(npcIds), reason: pick(['cheating', undefined]), scandal_count: pick(numbers), at_minutes: pick(numbers) }),
  ShrinePrayerResolved: () => ({ hero_id: pick(heroIds), prop_id: pick(['prop-altar', '', undefined]), place_name: pick(texts), outcome: pick(['blessed', 'silence', 'omen', 'x', undefined]), total: pick(numbers), difficulty: pick(numbers), attack_bonus: pick(numbers), at_minutes: pick(numbers) }),
  NpcBlessingGranted: () => ({ hero_id: pick(heroIds), npc_id: pick(npcIds), npc_name: pick(texts), place_name: pick(texts), donation_cp: pick(numbers), attack_bonus: pick(numbers), at_minutes: pick(numbers), currency_after: maybe(0.4, pick([{ gold: 1 }, null, 0])) }),
  BeastEncountered: () => ({ beast: pick([{ id: pick(beastIds), actor_id: pick(['enemy-wolf', 'ghost', '', undefined]), name: pick(texts), diet: pick(['predator', 'herbivore', 'x', undefined]), stage: pick(['wary', 'calmed', 'fed', 'tamed', 'x', undefined]), status: pick(['wild', 'companion', 'x']), attempts: pick(numbers), bites: pick(numbers), location_id: pick(locations), met_at_minutes: pick(numbers) }, null, undefined, 'x']) }),
  BeastSoothingResolved: () => ({ beast_id: pick(beastIds), hero_id: pick(heroIds), stage_before: pick(['wary', 'calmed', undefined]), stage_after: pick(['calmed', 'fed', 'tamed', 'wary', 'x', undefined]), success: pick(bools), at_minutes: pick(numbers), difficulty: pick(numbers) }),
  BeastFed: () => ({ beast_id: pick(beastIds), hero_id: pick(heroIds), item_id: pick(['rations', undefined]), at_minutes: pick(numbers) }),
  BeastBit: () => ({ beast_id: pick(beastIds), hero_id: pick(heroIds), amount: pick(numbers), at_minutes: pick(numbers) }),
  BeastMoved: () => ({ beast_id: pick(beastIds), location_id: pick(locations), location_name: pick(texts) }),
  BeastScaredThreat: () => ({ beast_id: pick(beastIds), hero_id: pick(heroIds), line: pick(texts), at_minutes: pick(numbers) }),
  BeastTamed: () => ({ actor_id: pick(['enemy-wolf', '', undefined]), beast_id: pick(beastIds), diet: pick(['predator', null, undefined]), at_minutes: pick(numbers) }),
}

const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
// `law` перенесён, но читает летопись `world_deeds`, которой ещё нет в Rust.
const REGISTRIES = ['law', 'world_deeds', 'offscreen_world', 'courier_letters', 'captives', 'scenario_knight', 'dialogues', 'autonomy']
function comparable(state) {
  const copy = JSON.parse(JSON.stringify(state))
  for (const player of copy.players ?? []) for (const field of DERIVED) delete player[field]
  for (const key of REGISTRIES) delete copy[key]
  return copy
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const PER_TYPE = 48
const cases = []
const dumps = []
let index = 0
for (const [type, build] of Object.entries(builders)) {
  for (let n = 0; n < PER_TYPE; n += 1) {
    const base = n % bases.length
    const event = json({
      event_type: type,
      command_id: maybe(0.8, `cmd-${index}`),
      event_id: maybe(0.6, `evt-${index}`),
      created_at: maybe(0.6, '2026-10-15T12:00:00.000Z'),
      actor_id: pick(['hero', 'hero-2', 'solo', null]),
      target_ids: pick([['hero'], ['barkeep'], [], undefined]),
      payload: build(),
      ...(chance(0.2) ? { state_version_after: 40 + n } : {}),
    })
    const mode = Number.isSafeInteger(event.state_version_after) ? 'legacy' : 'current'
    let expected = null
    let throws = false
    try {
      expected = comparable(E.applyGameEvent(bases[base], event))
    } catch {
      throws = true
    }
    cases.push({ base, mode, event, ...(throws ? { throws: true } : { sha256: sha(expected) }) })
    dumps.push(expected)
    index += 1
  }
}

// Явные края, которые случайный выбор может не задеть: ключи прототипа в
// `mechanics.temporary_hp` и `npc_world`, `null` и отсутствие поля.
const explicit = []
for (const npcId of ['__proto__', 'constructor', 'toString', 'barkeep', ' barkeep ', '']) {
  for (const temporary of [3, null, undefined]) {
    explicit.push({ event_type: 'NpcHarmed', payload: { npc_id: npcId, hp_after: 1, max_hp: 4, ...(temporary === undefined ? {} : { temporary_hp_after: temporary }) } })
  }
  explicit.push({ event_type: 'NpcDied', payload: { npc_id: npcId } })
  explicit.push({ event_type: 'NpcStanceChanged', payload: { npc_id: npcId, stance: 'hostile' } })
  explicit.push({ event_type: 'NpcPlaced', payload: { npc_id: npcId, location_id: 'inn', x: 2, y: 9, vitality: { hp: 2, max_hp: 3 } } })
}
explicit.push({ event_type: 'NpcHarmed', payload: null })
explicit.push({ event_type: 'NpcPlaced', payload: 'строка' })
explicit.push({ event_type: 'BeastEncountered', payload: null })
explicit.push({ event_type: 'BeastEncountered', payload: {} })
for (const raw of explicit) {
  for (let base = 0; base < bases.length; base += 1) {
    const event = json({ event_id: `edge-${index}`, actor_id: 'hero', target_ids: [], ...raw })
    let expected = null
    let throws = false
    try {
      expected = comparable(E.applyGameEvent(bases[base], event))
    } catch {
      throws = true
    }
    cases.push({ base, mode: 'current', event, ...(throws ? { throws: true } : { sha256: sha(expected) }) })
    dumps.push(expected)
    index += 1
  }
}

const dump = process.argv.indexOf('--dump')
if (dump >= 0) {
  const at = Number(process.argv[dump + 1])
  console.log(JSON.stringify({ case: cases[at], expected: dumps[at] }, null, 1))
} else {
  const path = new URL('reduce-r4c.json', import.meta.url)
  writeFileSync(path, `${JSON.stringify({ source_sha256: sourceSha256(), bases, cases })}\n`)
  console.log(`состояний: ${bases.length}, случаев: ${cases.length}, бросает JS: ${cases.filter((entry) => entry.throws).length}`)
}
