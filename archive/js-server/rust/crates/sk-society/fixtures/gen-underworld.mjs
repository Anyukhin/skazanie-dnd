// Эталон `server/underworld.mjs` для sk-society: `node gen-underworld.mjs`.
//
// Свойства «скупщик» и «неподкупный» выводятся из сида кампании, поселения и
// человека — эталон покрывает тысячи сочетаний, теги автора и мусор; ступени
// подкупа — на опорных суммах от нуля до огромных.
import { JUNK, collector, rng, server, write } from './lib.mjs'

const underworld = await import(server('underworld'))
const random = rng(777)
const c = collector()

const constants = {
  UNDERWORLD_POLICY_ID: underworld.UNDERWORLD_POLICY_ID,
  FENCE_TAG: underworld.FENCE_TAG,
  INCORRUPTIBLE_TAG: underworld.INCORRUPTIBLE_TAG,
  UNDERWORLD_PRIVATE_TAGS: underworld.UNDERWORLD_PRIVATE_TAGS,
  FENCE_SHARE: underworld.FENCE_SHARE,
  INCORRUPTIBLE_SHARE: underworld.INCORRUPTIBLE_SHARE,
  STOLEN_DISCOUNT_BPS: underworld.STOLEN_DISCOUNT_BPS,
  BRIBE_TIERS: underworld.BRIBE_TIERS,
  MIN_BRIBE_CP: underworld.MIN_BRIBE_CP,
  INCORRUPTIBLE_DC_PENALTY: underworld.INCORRUPTIBLE_DC_PENALTY,
  DENUNCIATION_WANTED_LEVEL: underworld.DENUNCIATION_WANTED_LEVEL,
  DENUNCIATION_SHARE: underworld.DENUNCIATION_SHARE,
}

const SESSIONS = ['UNDER-0', 'UNDER-1', 'LAW', 'Ｕｎｄｅｒ', '  spaced  ', '', null, undefined, 42]
const LOCATIONS = ['market', 'Рынок', ' market ', '', null, undefined, 9, 'x'.repeat(200)]
const NPC_IDS = ['merchant-1', 'npc-7', '  merchant-1  ', 'Ｍerchant', 'торговец', '', null, undefined, 13, 'y'.repeat(130)]
const TAGS = [undefined, [], ['скупщик'], [' скупщик '], ['неподкупный'], ['скупщик', 'неподкупный'], ['faction:guild'], 'скупщик', [null, 5], ['СКУПЩИК']]

for (let index = 0; index < 900; index += 1) {
  const state = random.chance(0.95)
    ? {
        sessionCode: random.pick(SESSIONS),
        worldMap: random.chance(0.8) ? { currentLocationId: random.pick(LOCATIONS) } : random.pick([undefined, null, 'x']),
        scene: random.chance(0.5) ? { location: random.pick(LOCATIONS) } : undefined,
      }
    : random.pick(JUNK)
  const npc = random.chance(0.95) ? { id: random.chance(0.5) ? `npc-${index}` : random.pick(NPC_IDS), tags: random.pick(TAGS) } : random.pick(JUNK)
  c.call('npcIsFence', underworld.npcIsFence, [state, npc])
  c.call('npcIsIncorruptible', underworld.npcIsIncorruptible, [state, npc])
  if (index % 3 === 0) {
    const options = random.chance(0.9)
      ? { wantedLevel: random.pick([undefined, null, 0, 1, 2, 3, '2', 2.5, 'x']), itemId: random.pick([undefined, `item-${index}`, 'loot-1', null, 7, '  loot-1 ']) }
      : undefined
    c.call('fenceDenunciationFor', underworld.fenceDenunciationFor, [state, npc, options])
  }
}

for (const reference of [...JUNK, 0, 1, 10, 99, 100, 199, 200, 201, 1_000, 10_000, 12_345, 99_999, 2 ** 40, 2 ** 52, -500]) {
  c.call('bribeTierAmounts', underworld.bribeTierAmounts, [reference])
  for (const tierId of ['coin', 'purse', 'generous', ' purse ', 'bogus', null, undefined]) c.call('bribeTierById', underworld.bribeTierById, [tierId, reference])
}
c.call('bribeTierAmounts', underworld.bribeTierAmounts, [])

const TIERS = [null, undefined, underworld.BRIBE_TIERS[0], underworld.BRIBE_TIERS[2], {}, { dc_shift: 5 }, { dc_shift: null }, 'coin', 0, 1]
for (const tier of TIERS) {
  for (const incorruptible of [undefined, false, true, 'yes', 0, null]) {
    c.call('bribeOutcomeFor', underworld.bribeOutcomeFor, [{ incorruptible, tier }])
  }
}
c.call('bribeOutcomeFor', underworld.bribeOutcomeFor, [])

write('underworld.json', { generator: 'gen-underworld.mjs', constants, values: c.values, cases: c.cases, skipped: c.skipped })
