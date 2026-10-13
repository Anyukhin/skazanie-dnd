// Эталон для `campaign_inspiration.rs`: зёрна на разных мастерах и бросках.
//
//   node rust/crates/sk-narration-base/fixtures/gen-campaign-inspiration.mjs
import { writeFileSync } from 'node:fs'

import {
  CAMPAIGN_INSPIRATION_POLICY_ID,
  INSPIRATION_DETAILS,
  INSPIRATION_GENRE_LEANS,
  INSPIRATION_HOOKS,
  INSPIRATION_REGIONS,
  drawCampaignInspiration,
  inspirationPromptSeed,
} from '../../../../server/campaign-inspiration.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'

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
const random = mulberry32(42)
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const choice = (list) => list[Math.floor(random() * list.length)]

const FIELDS = ['genre', 'preset', 'startingLocation', 'premise', 'openingSituation', 'themes']
const VALUES = ['нуар', '', '   ', null, 0, 'Портовый город Тир', false, ['x'], []]
const cases = []
for (let index = 0; index < 160; index += 1) {
  const world = {}
  for (const field of FIELDS) if (random() < 0.35) world[field] = choice(VALUES)
  // Жанров 12, прочих пулов 14: значение выше 12 у жанра — отказ генератора костей.
  const values = Array.from({ length: 4 }, () => (random() < 0.95 ? int(1, 12) : int(13, 14)))
  const useDice = random() < 0.9
  let id = 0
  const diceService = useDice ? new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `inspiration-roll-${++id}`, now: () => '2026-08-03T12:00:00.000Z' }) : null
  try {
    const inspiration = drawCampaignInspiration({ world, diceService })
    cases.push({ world, dice: useDice ? values : null, inspiration, seed: inspirationPromptSeed(inspiration) })
  } catch (error) {
    cases.push({ world, dice: values, error: error.message })
  }
}
const fixture = {
  policy: CAMPAIGN_INSPIRATION_POLICY_ID,
  pools: { genre: INSPIRATION_GENRE_LEANS, regions: INSPIRATION_REGIONS, hooks: INSPIRATION_HOOKS, details: INSPIRATION_DETAILS },
  cases,
}
writeFileSync(new URL('./campaign-inspiration.json', import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`)
console.log(`зёрен ${cases.length}, применено ${cases.filter((item) => item.inspiration?.applied).length}, отказов ${cases.filter((item) => item.error).length}`)
