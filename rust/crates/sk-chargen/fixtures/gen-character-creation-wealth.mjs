import '../../../fixtures-env.mjs'
// Эталоны `server/character-creation-wealth.mjs` для Rust-переноса (`sk-chargen`).
//
// Модуль сам костей не бросает: бросок делает Rules Engine (`RollCharacterWealth`)
// через DiceService по формуле `PHB_STARTING_WEALTH`. Здесь бросок повторён так
// же — `SequenceDiceRng`, id `wealth-N`, неподвижное время (в Rust —
// `DiceService::deterministic(SequenceRng, "wealth")`), — и подтверждённое
// богатство каждого броска тратится на случайные, дорогие, поддельные и
// мусорные покупки.
//
// Запуск: node rust/crates/sk-chargen/fixtures/gen-character-creation-wealth.mjs
import { PROTOTYPE_KEYS, chooser, recorder, rng } from './record.mjs'

const root = new URL('../../../../', import.meta.url)
const W = await import(new URL('server/character-creation-wealth.mjs', root).href)
const { DiceService, SequenceDiceRng } = await import(new URL('server/dice-service.mjs', root).href)
const { PHB_2014_TOOL_CATALOG } = await import(new URL('server/character-creation-class-options.mjs', root).href)

const random = rng(1_402_014)
const { pick, int, chance } = chooser(random)
const r = recorder('server/character-creation-wealth.mjs')

r.constant('PHB_STARTING_WEALTH', W.PHB_STARTING_WEALTH)
r.constant('PHB_STARTING_WEALTH_PROVENANCE', W.PHB_STARTING_WEALTH_PROVENANCE)
r.call('startingPurchaseCatalog', W.startingPurchaseCatalog)

const CATALOG = W.startingPurchaseCatalog()
const PURCHASE_IDS = [
  ...CATALOG.map((entry) => entry.id),
  ...CATALOG.map((entry) => entry.catalog_id).filter(Boolean),
  ...PHB_2014_TOOL_CATALOG.map((tool) => tool.id),
  'component-pouch', 'crystal', 'orb', 'rod', 'staff', 'wand', 'sprig-of-mistletoe', 'totem', 'wooden-staff', 'yew-wand', 'amulet', 'emblem', 'reliquary', 'diamond', 'diamond-50gp',
]
const BAD_IDS = ['', 'unknown', 'srd_5_2_1:ring-of-protection', 'srd_5_2_1:longsword-plus-1', ' lute ', 'LUTE', 'undefined', 'vehicles_land', ...PROTOTYPE_KEYS.slice(0, 4), null, 5]
const CLASSES = Object.keys(W.PHB_STARTING_WEALTH)

function rollWealth(classId, values) {
  let counter = 0
  const dice = new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `wealth-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
  const formula = W.PHB_STARTING_WEALTH[classId]
  const roll = dice.roll(formula.expression, 'character-starting-wealth', 'hero', 'party')
  return { schema_version: 1, id: roll.roll_id, class_id: classId, roll, total_gp: roll.total * formula.multiplier }
}

function randomPurchases(budgetCp) {
  const purchases = []
  const count = int(0, 6)
  for (let index = 0; index < count; index += 1) {
    const id = chance(0.92) ? pick(PURCHASE_IDS) : pick(BAD_IDS)
    const quantity = chance(0.9) ? int(1, 3) : pick([0, -1, 1.5, '2', 100_000, 100_001, null, undefined, 'x', 2 ** 53])
    purchases.push(chance(0.97) ? { id, quantity } : pick([null, 'lute', [id], 7]))
  }
  if (chance(0.15) && budgetCp > 0) purchases.push({ id: 'srd_5_2_1:plate-armor', quantity: 1 })
  return purchases
}

for (const classId of CLASSES) {
  const count = Number(W.PHB_STARTING_WEALTH[classId].expression[0])
  for (let sample = 0; sample < 12; sample += 1) {
    const values = Array.from({ length: count }, () => int(1, 4))
    const event = r.call('rollCharacterWealth', rollWealth, classId, values).result
    const wealthRoll = { id: event.id, class_id: event.class_id, total_gp: event.total_gp }
    for (let index = 0; index < 4; index += 1) {
      r.call('resolveStartingPurchases', W.resolveStartingPurchases, classId, wealthRoll, randomPurchases(event.total_gp * 100))
    }
  }
}

// Явные случаи: имущество, верёвка, алиасы, бюджет, мусорный бросок.
const ROLLS = [
  { id: 'owned-assets-roll', class_id: 'fighter', total_gp: 100 },
  { id: 'wealth-roll-1', class_id: ' FIGHTER ', total_gp: '100' },
  { id: 'r5', class_id: 'wizard', total_gp: 100 },
  { id: '  id with spaces  ', class_id: 'monk', total_gp: 12 },
  { id: 'Роль-ёж/../x', class_id: 'monk', total_gp: 12 },
  { id: '---', class_id: 'monk', total_gp: 12 },
  { id: 'x'.repeat(200), class_id: 'monk', total_gp: 12 },
  { id: 'big', class_id: 'monk', total_gp: 2 ** 53 - 1 },
  { id: 'neg', class_id: 'monk', total_gp: -1 },
  { id: 'frac', class_id: 'monk', total_gp: 1.5 },
  { id: '', class_id: 'monk', total_gp: 12 },
  { id: null, class_id: 'monk', total_gp: 12 },
  { id: 7, class_id: 'monk', total_gp: 0 },
  { class_id: 'monk', total_gp: 12 },
  null,
  [],
  'roll',
]
const PURCHASE_LISTS = [
  [],
  [{ id: 'mount:mule', quantity: 1 }, { id: 'vehicle:cart', quantity: 1 }],
  [{ id: 'mount:warhorse', quantity: 1 }, { id: 'lute', quantity: 1 }, { id: 'vehicle:galley', quantity: 1 }],
  [{ id: 'srd_5_2_1:longsword', quantity: 1 }, { id: 'lute', quantity: 1 }],
  [{ id: 'srd_5_2_1:rope-hempen-50-feet', quantity: 1 }],
  [{ id: 'cobblers_tools', quantity: 1 }],
  [{ id: 'dice_set', quantity: 1 }],
  [{ id: 'component-pouch', quantity: 1 }, { id: 'diamond', quantity: 1 }],
  [{ id: 'srd_5_2_1:material-diamond-dust-100gp', quantity: 2 }],
  [{ id: 'barding:srd_5_2_1:chain-mail', quantity: 1 }],
  [{ id: 'saddle-exotic', quantity: 1 }, { id: 'abacus', quantity: 3 }, { id: 'net', quantity: 2 }],
  [{ id: 'srd_5_2_1:plate-armor', quantity: 1 }],
  [{ id: 'spyglass', quantity: 100_000 }],
  [{ id: 'candle', quantity: 100_000 }, { id: 'candle', quantity: 100_000 }],
  [{ id: 'lute', quantity: 0 }],
  [{ id: 'lute', quantity: 1.5 }],
  [{ id: 'lute' }],
  [null],
  [{ id: 'unknown', quantity: 1 }],
  'lute',
  null,
  undefined,
]
for (const roll of ROLLS) {
  for (const purchases of PURCHASE_LISTS) {
    const classId = roll && typeof roll === 'object' && !Array.isArray(roll) ? roll.class_id : 'monk'
    r.call('resolveStartingPurchases', W.resolveStartingPurchases, classId, roll, purchases)
  }
}
for (const classId of [...CLASSES, 'Wizard', ' bard ', 'artificer', '', null, undefined, 5, ...PROTOTYPE_KEYS.slice(0, 3)]) {
  r.call('resolveStartingPurchases', W.resolveStartingPurchases, classId, { id: 'c', class_id: classId, total_gp: 50 }, [{ id: 'dagger', quantity: 1 }, { id: 'srd_5_2_1:dagger', quantity: 1 }])
  r.call('resolveStartingPurchases', W.resolveStartingPurchases, classId, { id: 'c', class_id: 'fighter', total_gp: 50 }, [])
}

r.write('character-creation-wealth.json')
