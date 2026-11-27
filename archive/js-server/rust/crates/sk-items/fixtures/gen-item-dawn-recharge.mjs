import '../../../fixtures-env.mjs'
// Эталоны `server/item-dawn-recharge.mjs` для Rust-переноса (`sk-items`).
//
// Перезарядка бросает «1к6+1» через DiceService. Каждый случай несёт свою
// последовательность костей (`SequenceDiceRng`), фабрику id `<prefix>-N` и
// неподвижное время — ровно то, что в Rust даёт
// `DiceService::deterministic(SequenceRng, prefix)`. Состояния — сотни отрядов
// с каталожными, самодельными, поддельными и мусорными вещами, часы — от нуля
// до границы безопасного целого. Затем payload каждого случая прогоняется
// через редьюсер вместе с неверсионированными и мусорными событиями.
//
// Запуск: node rust/crates/sk-items/fixtures/gen-item-dawn-recharge.mjs
import { recorder, rng } from './record.mjs'
import { junkFactory } from './junk.mjs'

const root = new URL('../../../../', import.meta.url)
const D = await import(new URL('server/item-dawn-recharge.mjs', root).href)
const { DiceService, SequenceDiceRng } = await import(new URL('server/dice-service.mjs', root).href)

const random = rng(1_440)
const J = junkFactory(random, ['srd_5_2_1:wand-of-magic-missiles', 'scenario_astohan:kaelan-tear', 'srd_5_2_1:healers-kit', 'srd_5_2_1:ring-of-protection'])
const { pick, int, chance } = J
const NOW = '2026-01-01T00:00:00.000Z'
const MAX = Number.MAX_SAFE_INTEGER
const RECHARGE = { schema_version: 1, trigger: 'dawn', formula: '1d6+1' }

const r = recorder('server/item-dawn-recharge.mjs')
for (const name of ['DAWN_PERIOD_MINUTES', 'MAX_DAWN_RECHARGE_ITEMS_PER_EVENT', 'MAX_DAWN_RECHARGE_ROLLS_PER_ITEM', 'ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION']) {
  r.constant(name, D[name])
}

const MINUTES = [0, 1, 439, 1_000, 1_439, 1_440, 1_441, 2_880, 2_881, 1_440 * 100, 1_440 * 1_000_000, MAX - 1_000, MAX, -5, 2.5]
for (const before of MINUTES) {
  for (const elapsed of MINUTES) r.call('dawnCrossings', D.dawnCrossings, before, elapsed)
}

const OWNERS = ['alpha', 'zeta', 'Beta', 'бета', 'ёж', 'ель', 'a-1', 'a10', 'a2', '', '  gamma ', 'Ω', 'hero']

function rechargeable(index) {
  const roll = random()
  const id = pick([`item-${String(index).padStart(3, '0')}`, `Z-${index}`, `ж-${index}`, ` spaced-${index} `, '', `item-${index % 3}`])
  if (roll < 0.25) return { id, catalog_id: pick(['srd_5_2_1:wand-of-magic-missiles', 'scenario_astohan:kaelan-tear']), quantity: pick([1, 1, 0, 2]), charges: { current: pick([0, 1, 2, 5, 6, 7, 9, '3', null]), max: pick([7, 99, 1]) }, ...(chance(0.2) ? { recharge: J.rechargeProfile() } : {}) }
  if (roll < 0.6) return { id, name: id, type: 'other', quantity: pick([1, 1, 1, 0, -1, '1', null]), charges: { current: pick([0, 1, 2, 3, 6, 7, 20, -4, 2.5, null]), max: pick([7, 20, 2, 1, 0, 1_000_001, 2.5, '7']) }, recharge: chance(0.8) ? RECHARGE : J.rechargeProfile() }
  if (roll < 0.7) return { id, catalog_id: 'srd_5_2_1:ring-of-protection', charges: { current: 0, max: 7 }, recharge: RECHARGE }
  if (roll < 0.8) return { id, catalog_id: 'srd_5_2_1:healers-kit', charges: { current: 2, max: 10 } }
  if (roll < 0.85) return { item_id: `legacy-${index}`, charges: { current: 0, max: 7 }, recharge: RECHARGE, catalogId: chance(0.5) ? 'constructor' : 'custom:x' }
  return J.inventoryItem(index)
}

function party(size, itemsPerOwner) {
  let serial = 0
  return Array.from({ length: size }, () => {
    const owner = chance(0.9)
      ? { id: pick(OWNERS), character: 'Герой', inventory: Array.from({ length: int(0, itemsPerOwner) }, () => rechargeable(serial++)) }
      : pick([{ actor_id: pick(OWNERS), inventory: [rechargeable(serial++)] }, { id: 'no-inventory' }, { id: 'bad-inventory', inventory: 'нет' }, null, 'строка'])
    return owner
  })
}

function diceFor(values, prefix) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `${prefix}-${++id}`, now: () => NOW })
}

const payloads = []
for (let index = 0; index < 360; index += 1) {
  const players = chance(0.05) ? pick([null, 'нет', {}]) : party(int(1, 4), 6)
  const worldMinute = pick([0, 1_000, 1_439, 1_439, 1_440, 2_879, MAX - 1_000, '1439', null, 'abc', 2.5])
  const state = { players, mechanics: chance(0.95) ? { world_time: { elapsed_minutes: worldMinute } } : null }
  const elapsed = pick([0, 1, 1, 1, 439, 1_441, 2_881, 1_440 * 3, 1_440 * 100, 2_000, '1', null, -1, 2.5])
  const values = Array.from({ length: index % 23 === 0 ? int(0, 2) : 200 }, () => int(1, 6))
  const prefix = `dawn-${index}`
  r.call('resolveItemDawnRecharge', (s, e, dice) => D.resolveItemDawnRecharge(s, e, diceFor(dice.values, dice.prefix)), state, elapsed, { values, prefix })
  const last = r.cases.at(-1)
  if (last.result?.payload) payloads.push({ players, payload: last.result.payload })
}
// Больше 64 предметов — отказ до первого броска.
{
  const inventory = Array.from({ length: 65 }, (_, index) => ({ id: `item-${String(index).padStart(3, '0')}`, quantity: 1, charges: { current: 0, max: 7 }, recharge: RECHARGE }))
  const state = { players: [{ id: 'hero', inventory }], mechanics: { world_time: { elapsed_minutes: 1_439 } } }
  r.call('resolveItemDawnRecharge', (s, e, dice) => D.resolveItemDawnRecharge(s, e, diceFor(dice.values, dice.prefix)), state, 1, { values: [], prefix: 'limit' })
}

for (const { players, payload } of payloads) {
  r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, players, { event_type: 'ItemDawnRechargeResolved', event_schema_version: 1, payload })
  if (chance(0.3)) r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, players, { payload })
  if (chance(0.3)) r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, players, { event_schema_version: '1', payload: { ...payload, schema_version: 2 } })
  if (chance(0.5)) {
    const items = payload.items.map((item) => ({ ...item, owner_id: chance(0.2) ? J.junk() : item.owner_id, item_id: chance(0.2) ? J.junk() : item.item_id, max: chance(0.3) ? pick([0, -1, 2_000_000, '7', null, 2.5]) : item.max, after: chance(0.3) ? pick([-3, 99, '4', null, 2.5]) : item.after }))
    r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, players, { event_schema_version: 1, payload: { ...payload, items } })
  }
}
for (const event of [undefined, null, {}, { event_schema_version: 1 }, { event_schema_version: 1, payload: { schema_version: 1, items: [] } }, { event_schema_version: 1, payload: { schema_version: 1, items: 'нет' } }]) {
  r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, [{ id: 'hero', inventory: [{ id: 'x', charges: { current: 1, max: 7 } }] }], event)
}
r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, 'нет', { event_schema_version: 1, payload: { schema_version: 1, items: [{ owner_id: 'hero', item_id: 'x', max: 7, after: 7 }] } })
{
  const items = Array.from({ length: 70 }, (_, index) => ({ owner_id: 'hero', item_id: `item-${index}`, max: 7, after: 7 }))
  const inventory = Array.from({ length: 70 }, (_, index) => ({ id: `item-${index}`, charges: { current: 0, max: 7 } }))
  r.call('applyItemDawnRechargeToPlayers', D.applyItemDawnRechargeToPlayers, [{ id: 'hero', inventory }], { event_schema_version: 1, payload: { schema_version: 1, items } })
}
r.write('item-dawn-recharge.json')
