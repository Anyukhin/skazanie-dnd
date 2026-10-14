// Эталон `server/reputation-policy.mjs` для sk-society: `node gen-reputation-policy.mjs`.
//
// Репутация фракций с мусором в реестре и в тегах NPC, вместе с розыском
// (`law-and-order`), который приходит в ту же наценку и умеет закрыть лавку.
import { JUNK, collector, rng, server, write } from './lib.mjs'

const reputation = await import(server('reputation-policy'))
const random = rng(31337)
const c = collector()

const constants = {
  REPUTATION_PRICE_BPS: reputation.REPUTATION_PRICE_BPS,
  REPUTATION_SOCIAL_DC_SHIFT: reputation.REPUTATION_SOCIAL_DC_SHIFT,
}

const FACTIONS = ['guild', 'watch', 'brod-folk', 'Гильдия', '', 'guild']
const SCORES = [undefined, null, 0, 19, 20, 49, 50, 80, 100, 150, -19, -20, -49, -50, -80, -100, -150, '60', '-30', 1.5, 'abc', true, 2 ** 60]

function tags() {
  if (random.chance(0.1)) return random.pick([undefined, null, 'faction:guild', [null], [7]])
  return random.some([...FACTIONS.map((id) => `faction:${id}`), 'faction:', 'merchant', 'Faction:guild', 'faction:watch'], 4)
}

function crimes() {
  return Array.from({ length: random.int(0, 3) }, (_, index) => ({
    id: `crime:${index}`, kind: random.pick(['theft', 'murder', 'arson', 'violence']), region_id: random.pick(['north', 'east']), at_minutes: 0,
  }))
}

function state() {
  const reputations = {}
  for (const id of random.some(FACTIONS, 4)) reputations[id] = random.pick(SCORES)
  const npcs = Array.from({ length: random.int(0, 3) }, (_, index) => ({ id: random.pick(['merchant-1', 'npc-2', `npc-${index}`, 7, null]), tags: tags() }))
  return {
    autonomy: random.chance(0.9) ? { reputations: random.chance(0.95) ? reputations : random.pick(JUNK) } : random.pick(JUNK),
    social: random.chance(0.9) ? { npcs: random.chance(0.95) ? npcs : random.pick([undefined, null]) } : undefined,
    worldMap: {
      regions: [{ id: 'north', name: 'Север' }, { id: 'east', name: 'Восток' }],
      locations: [{ id: 'village', name: 'Брод', kind: 'village', regionId: 'north' }, { id: 'farcity', name: 'Град', kind: 'city', regionId: 'east' }],
      currentLocationId: random.pick(['village', 'farcity', 'nowhere', undefined]),
    },
    law: random.chance(0.6) ? { crimes: crimes() } : undefined,
    mechanics: { world_time: { elapsed_minutes: random.pick([0, 1_440, 5_000]) } },
  }
}

for (let index = 0; index < 400; index += 1) {
  const s = state()
  for (const npcId of random.some(['merchant-1', 'npc-2', 'npc-0', 'unknown', 7, null, undefined, ''], 3)) {
    c.call('reputationStandingFor', reputation.reputationStandingFor, [s, npcId])
    c.call('reputationPriceBps', reputation.reputationPriceBps, [s, npcId])
  }
  const npc = s.social?.npcs?.[0]
  c.call('factionIdsForNpc', reputation.factionIdsForNpc, [npc])
  c.call('reputationScoreFor', reputation.reputationScoreFor, [s, npc])
}
for (const score of [...SCORES, ...JUNK]) c.call('reputationTier', reputation.reputationTier, [score])

write('reputation-policy.json', { generator: 'gen-reputation-policy.mjs', constants, values: c.values, cases: c.cases, skipped: c.skipped })
