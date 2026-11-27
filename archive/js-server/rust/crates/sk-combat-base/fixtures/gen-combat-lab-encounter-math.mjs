// Эталон combat-lab-encounter-math для Rust: пороги, множители, ПО и
// сотни подборов состава по настоящему бестиарию 2014 и по синтетическим
// записям (повторы опыта, id-числа, дробный опыт, пустая ПО).
//
//   node rust/crates/sk-combat-base/fixtures/gen-combat-lab-encounter-math.mjs
//
// Пишет combat-lab-encounter-math.json рядом с собой. У подобранного состава
// записи заменены их id — Rust сверяет id по порядку и всё остальное целиком.
import './force-en-collation.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  COMBAT_LAB_XP_THRESHOLDS_2014,
  assessEncounterRoster,
  challengeRatingValue,
  encounterInterval,
  encounterMultiplier,
  partyThresholds2014,
  selectEncounterRoster,
} from '../../../../server/combat-lab-encounter-math.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const monsters = JSON.parse(readFileSync(here('../../../../data/compendia/dnd_5e_2014/monsters.json'), 'utf8')).monsters
const bestiary = monsters.map(({ id, xp, challenge_rating }) => ({ id, xp, challenge_rating }))

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
const random = mulberry32(14102026)
const pick = (items) => items[Math.floor(random() * items.length)]

function outcome(run) {
  try {
    return { ok: run() }
  } catch (error) {
    return { error: error.message }
  }
}

const thresholdsTable = COMBAT_LAB_XP_THRESHOLDS_2014
const levelCases = [[1], [3, 3, 3, 2], [20], [5, 5, 5, 5, 5, 5], ['3'], [0], [21], [2.5], [null], ['x'], [true], [], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], [' 4 '], ['0x3'], [[2]]]
const thresholds = levelCases.map((levels) => ({ levels, result: outcome(() => partyThresholds2014(levels)) }))

const multipliers = []
for (const count of [-1, 0, 0.5, 1, 2, 3, 6, 7, 10, 11, 14, 15, 20, 100, 1e20, null, '3']) {
  for (const size of [-2, 0, 1, 2, 3, 5, 6, 8, 1.5, null]) {
    multipliers.push({ count, size, multiplier: encounterMultiplier(count, size) })
  }
}

const challengeRatings = ['1/4', '1/8', '1/2', '0', '30', ' 3 ', '1/0', '0/4', '/4', '1/', 'x/2', '3/2/1', '', null, 2, '2.5', 'Infinity', '1e1', '-1/2', '1/-2', true, '0x10']
  .map((value) => ({ value, result: challengeRatingValue(value) }))

const intervals = []
for (const difficulty of ['easy', 'medium', 'hard', 'deadly', 'trivial', '']) {
  for (const levels of [[1], [3, 3, 3, 2], [20, 20]]) {
    const row = partyThresholds2014(levels)
    intervals.push({ difficulty, thresholds: row, result: outcome(() => encounterInterval(difficulty, row)) })
  }
}

const synthetic = [
  { id: 'a', xp: 50, challenge_rating: '1/4' },
  { id: 'b', xp: 50, challenge_rating: '1/4' },
  { id: 'c', xp: 75, challenge_rating: '1/2' },
  { id: 7, xp: 120, challenge_rating: 1 },
  { id: 'd', xp: '200', challenge_rating: '1' },
  { id: 'e', xp: 12.5, challenge_rating: '0' },
  { id: 'f', xp: 0, challenge_rating: '0' },
  { id: 'g', xp: 400, challenge_rating: '' },
  { id: 'h', xp: 1800, challenge_rating: '5' },
  { id: 'i', xp: 33, challenge_rating: null },
  { xp: 90, challenge_rating: '1' },
  { id: 'ё', xp: 66, challenge_rating: '1/8' },
]
const recordSets = {
  bestiary,
  low: bestiary.filter((record) => ['0', '1/8', '1/4', '1/2', '1'].includes(record.challenge_rating)),
  mid: bestiary.filter((record) => ['2', '3', '4'].includes(record.challenge_rating)),
  synthetic,
  single: [bestiary.find((record) => record.challenge_rating === '1/4')],
  mixed: [...bestiary.slice(0, 12), ...synthetic.slice(0, 6)],
}

const partyChoices = [[1], [1, 1], [2, 3], [3, 3, 3, 2], [4, 4, 4, 4], [5, 5, 5, 5], [1, 1, 1, 1, 1, 1], [6, 7, 5], [8, 8, 8, 8], [10, 9], [2, 2, 2, 2, 2, 2, 2], ['3', 3], [1, 2, 3, 4, 5]]
const seeds = ['combat-lab', 'same-seed', 'proposal-abc', 17, 0, 'Ёж', '', undefined, null, 'x'.repeat(40)]
const selections = []
for (let index = 0; index < 360; index += 1) {
  const setName = index < 40 ? 'bestiary' : pick(Object.keys(recordSets))
  const request = {
    set: setName,
    partyLevels: pick(partyChoices),
    difficulty: pick(['easy', 'medium', 'hard', 'deadly', 'deadly', 'hard']),
  }
  const seed = pick(seeds)
  if (seed !== undefined) request.seed = seed
  const cap = random()
  if (cap < 0.4) request.maximumCreatures = pick([1, 2, 3, 4, 6, 8, 12, 0, null, '3', 100])
  const result = outcome(() => selectEncounterRoster({ ...request, records: recordSets[setName] }))
  if (result.ok) result.ok = { ...result.ok, records: result.ok.records.map((record) => record?.id ?? null) }
  selections.push({ request, result: JSON.parse(JSON.stringify(result)) })
}
for (const request of [
  { set: 'empty', partyLevels: [1], difficulty: 'easy' },
  { set: 'bestiary', partyLevels: [], difficulty: 'easy' },
  { set: 'bestiary', partyLevels: [1], difficulty: 'trivial' },
  { set: 'bestiary', partyLevels: [0], difficulty: 'easy' },
  { set: 'zero', partyLevels: [1], difficulty: 'easy' },
  { set: 'tooStrong', partyLevels: [1], difficulty: 'easy' },
]) {
  const sets = { empty: [], zero: [{ id: 'z', xp: 0, challenge_rating: '0' }], tooStrong: [{ id: 's', xp: 5900, challenge_rating: '10' }] }
  const result = outcome(() => selectEncounterRoster({ ...request, records: sets[request.set] ?? recordSets[request.set] }))
  selections.push({ request, result })
}

const assessments = []
for (let index = 0; index < 160; index += 1) {
  const count = Math.floor(random() * 7)
  const records = Array.from({ length: count }, () => pick(random() < 0.8 ? bestiary : synthetic))
  const request = { records, partyLevels: pick(partyChoices), difficulty: pick(['easy', 'medium', 'hard', 'deadly']) }
  const seed = pick(seeds)
  if (seed !== undefined) request.seed = seed
  assessments.push({ request, result: outcome(() => assessEncounterRoster(request)) })
}
assessments.push({ request: { records: [], partyLevels: [1], difficulty: 'trivial' }, result: outcome(() => assessEncounterRoster({ records: [], partyLevels: [1], difficulty: 'trivial' })) })
assessments.push({ request: { records: [], partyLevels: [], difficulty: 'easy' }, result: outcome(() => assessEncounterRoster({ records: [], partyLevels: [], difficulty: 'easy' })) })

const fixture = { thresholdsTable, thresholds, multipliers, challengeRatings, intervals, recordSets, selections, assessments }
const lines = Object.entries(fixture).map(([key, value]) => Array.isArray(value)
  ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  : `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
writeFileSync(here('combat-lab-encounter-math.json'), `{\n${lines.join(',\n')}\n}\n`)
console.log(`combat-lab-encounter-math.json: ${selections.length} подборов (${selections.filter((entry) => entry.result.error).length} отказов), ${assessments.length} оценок, ${multipliers.length} множителей`)
