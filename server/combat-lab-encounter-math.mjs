// Правила оценки боевой сцены из Basic Rules 2014. Этот модуль не знает о
// состоянии кампании и потому остаётся детерминированным и пригодным для
// предпросмотра в боевом стенде.

export const COMBAT_LAB_ENCOUNTER_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'deadly'])

export const COMBAT_LAB_XP_THRESHOLDS_2014 = Object.freeze({
  1: Object.freeze({ easy: 25, medium: 50, hard: 75, deadly: 100 }),
  2: Object.freeze({ easy: 50, medium: 100, hard: 150, deadly: 200 }),
  3: Object.freeze({ easy: 75, medium: 150, hard: 225, deadly: 400 }),
  4: Object.freeze({ easy: 125, medium: 250, hard: 375, deadly: 500 }),
  5: Object.freeze({ easy: 250, medium: 500, hard: 750, deadly: 1_100 }),
  6: Object.freeze({ easy: 300, medium: 600, hard: 900, deadly: 1_400 }),
  7: Object.freeze({ easy: 350, medium: 750, hard: 1_100, deadly: 1_700 }),
  8: Object.freeze({ easy: 450, medium: 900, hard: 1_400, deadly: 2_100 }),
  9: Object.freeze({ easy: 550, medium: 1_100, hard: 1_600, deadly: 2_400 }),
  10: Object.freeze({ easy: 600, medium: 1_200, hard: 1_900, deadly: 2_800 }),
  11: Object.freeze({ easy: 800, medium: 1_600, hard: 2_400, deadly: 3_600 }),
  12: Object.freeze({ easy: 1_000, medium: 2_000, hard: 3_000, deadly: 4_500 }),
  13: Object.freeze({ easy: 1_100, medium: 2_200, hard: 3_400, deadly: 5_100 }),
  14: Object.freeze({ easy: 1_250, medium: 2_500, hard: 3_800, deadly: 5_700 }),
  15: Object.freeze({ easy: 1_400, medium: 2_800, hard: 4_300, deadly: 6_400 }),
  16: Object.freeze({ easy: 1_600, medium: 3_200, hard: 4_800, deadly: 7_200 }),
  17: Object.freeze({ easy: 2_000, medium: 3_900, hard: 5_900, deadly: 8_800 }),
  18: Object.freeze({ easy: 2_100, medium: 4_200, hard: 6_300, deadly: 9_500 }),
  19: Object.freeze({ easy: 2_400, medium: 4_900, hard: 7_300, deadly: 10_900 }),
  20: Object.freeze({ easy: 2_800, medium: 5_700, hard: 8_500, deadly: 12_700 }),
})

const MULTIPLIER_RANGES = Object.freeze([
  Object.freeze({ maximum: 1, multiplier: 1 }),
  Object.freeze({ maximum: 2, multiplier: 1.5 }),
  Object.freeze({ maximum: 6, multiplier: 2 }),
  Object.freeze({ maximum: 10, multiplier: 2.5 }),
  Object.freeze({ maximum: 14, multiplier: 3 }),
  Object.freeze({ maximum: Number.POSITIVE_INFINITY, multiplier: 4 }),
])

export const COMBAT_LAB_RULES_SOURCE_2014 = Object.freeze({
  title: 'D&D Basic Rules 2014 — Building Combat Encounters',
  url: 'https://www.dndbeyond.com/sources/dnd/basic-rules-2014/building-combat-encounters',
  dndsu_url: 'https://dnd.su/articles/mechanics/119-combat-encounter-difficulty/',
  edition: '2014',
})

function clampInteger(value, minimum, maximum) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return null
  return Math.max(minimum, Math.min(maximum, number))
}

/** Числовая ПО для ограничения подбора противников низкоуровневой группе. */
export function challengeRatingValue(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (text.includes('/')) {
    const [numerator, denominator] = text.split('/').map(Number)
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) return numerator / denominator
  }
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function baseMultiplierIndex(monsterCount) {
  const count = Math.max(1, Number(monsterCount) || 1)
  return MULTIPLIER_RANGES.findIndex((range) => count <= range.maximum)
}

/**
 * Множитель 2014 с поправкой на размер отряда: на строку выше для 1–2 героев
 * и на строку ниже для группы из шести и более.
 */
export function encounterMultiplier(monsterCount, partySize) {
  const count = clampInteger(monsterCount, 1, Number.MAX_SAFE_INTEGER) ?? 1
  const size = clampInteger(partySize, 1, Number.MAX_SAFE_INTEGER) ?? 1
  const index = baseMultiplierIndex(count)
  const offset = size < 3 ? 1 : size >= 6 ? -1 : 0
  const adjustedIndex = index + offset
  if (adjustedIndex < 0) return 0.5
  if (adjustedIndex >= MULTIPLIER_RANGES.length) return size < 3 ? 5 : size >= 6 ? 3 : 4
  return MULTIPLIER_RANGES[adjustedIndex].multiplier
}

/** Сумма четырёх порогов для группы с разными уровнями. */
export function partyThresholds2014(levels) {
  if (!Array.isArray(levels) || levels.length < 1) throw new TypeError('levels must be a non-empty array')
  const result = { easy: 0, medium: 0, hard: 0, deadly: 0 }
  for (const rawLevel of levels) {
    const level = clampInteger(rawLevel, 1, 20)
    if (level == null || level !== Number(rawLevel)) throw new TypeError('character level must be an integer from 1 to 20')
    const row = COMBAT_LAB_XP_THRESHOLDS_2014[level]
    for (const difficulty of COMBAT_LAB_ENCOUNTER_DIFFICULTIES) result[difficulty] += row[difficulty]
  }
  return Object.freeze(result)
}

function difficultyForAdjustedXp(adjustedXp, thresholds) {
  if (adjustedXp < thresholds.easy) return 'trivial'
  if (adjustedXp < thresholds.medium) return 'easy'
  if (adjustedXp < thresholds.hard) return 'medium'
  if (adjustedXp < thresholds.deadly) return 'hard'
  return 'deadly'
}

export function encounterInterval(difficulty, thresholds) {
  if (!COMBAT_LAB_ENCOUNTER_DIFFICULTIES.includes(difficulty)) throw new TypeError('unknown encounter difficulty')
  const index = COMBAT_LAB_ENCOUNTER_DIFFICULTIES.indexOf(difficulty)
  const lower = thresholds[difficulty]
  const upper = index + 1 < COMBAT_LAB_ENCOUNTER_DIFFICULTIES.length
    ? thresholds[COMBAT_LAB_ENCOUNTER_DIFFICULTIES[index + 1]] - 1
    : Number.POSITIVE_INFINITY
  return { lower, upper }
}

function hash32(value) {
  let hash = 2_166_136_261
  for (const character of String(value)) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

function rosterKey(ids) {
  return [...ids].sort().join('|')
}

function candidateOrder(records, seed) {
  return [...records].sort((left, right) => (
    hash32(`${seed}:candidate:${left.id}`) - hash32(`${seed}:candidate:${right.id}`)
    || String(left.id).localeCompare(String(right.id))
  ))
}

function isBetterPath(next, previous, seed) {
  if (!previous) return true
  const nextKey = rosterKey(next)
  const previousKey = rosterKey(previous)
  return hash32(`${seed}:roster:${nextKey}`) < hash32(`${seed}:roster:${previousKey}`)
    || (nextKey === previousKey && next.length < previous.length)
}

function scoreLess(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return true
    if (left[index] > right[index]) return false
  }
  return false
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(Number(left) || 0)
  let b = Math.abs(Number(right) || 0)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function buildRosterStates(records, maximumCount, maximumRaw, seed) {
  const xpUnit = records.reduce((unit, record) => greatestCommonDivisor(unit, Number(record.xp)), 0) || 1
  const maximumRawUnits = Math.floor(maximumRaw / xpUnit)
  const states = Array.from({ length: maximumCount + 1 }, () => new Map())
  states[0].set(0, [])
  const ordered = candidateOrder(records, seed)
  for (let quantity = 0; quantity < maximumCount; quantity += 1) {
    for (const [spent, path] of states[quantity]) {
      for (const record of ordered) {
        const xp = Number(record.xp)
        const xpUnits = xp / xpUnit
        const nextSpent = spent + xpUnits
        if (!Number.isSafeInteger(xp) || xp <= 0 || !Number.isSafeInteger(xpUnits) || nextSpent > maximumRawUnits) continue
        const nextPath = [...path, record.id]
        const previous = states[quantity + 1].get(nextSpent)
        if (isBetterPath(nextPath, previous, seed)) states[quantity + 1].set(nextSpent, nextPath)
      }
    }
  }
  return { states, xpUnit }
}

function bestRosterForCount(states, xpUnit, count, multiplier, interval, seed, targetAdjusted) {
  let best = null
  for (const [spent, path] of states[count]) {
    const rawSpent = Number(spent) * xpUnit
    const adjusted = rawSpent * multiplier
    const distance = adjusted < interval.lower
      ? interval.lower - adjusted
      : adjusted > interval.upper
        ? adjusted - interval.upper
        : Math.abs(adjusted - targetAdjusted)
    const inInterval = adjusted >= interval.lower && adjusted <= interval.upper
    const score = [inInterval ? 0 : 1, distance, Math.abs(adjusted - targetAdjusted), -new Set(path).size]
    const tie = hash32(`${seed}:selection:${rosterKey(path)}`)
    if (!best || scoreLess(score, best.score) || (score.every((value, index) => value === best.score[index]) && tie < best.tie)) {
      best = { path, spent: rawSpent, adjusted, quantity: count, score, tie }
    }
  }
  return best
}

/**
 * Подбор ограниченного состава из серверных записей существ. Перенос полей
 * статблока в боевое состояние и расстановку выполняет модуль настройки.
 */
export function selectEncounterRoster({ records, partyLevels, difficulty, seed = 'combat-lab', maximumCreatures = 12 } = {}) {
  if (!Array.isArray(records) || !records.length) throw new TypeError('records must be a non-empty array')
  if (!Array.isArray(partyLevels) || !partyLevels.length) throw new TypeError('partyLevels must be a non-empty array')
  if (!COMBAT_LAB_ENCOUNTER_DIFFICULTIES.includes(difficulty)) throw new TypeError('unknown encounter difficulty')
  const thresholds = partyThresholds2014(partyLevels)
  const interval = encounterInterval(difficulty, thresholds)
  const maxPartyLevel = Math.max(...partyLevels.map(Number))
  const maxChallengeRating = Math.max(1, Math.ceil(maxPartyLevel))
  const suitable = records.filter((record) => (
    Number(record?.xp) > 0
    && (challengeRatingValue(record?.challenge_rating) ?? Number.POSITIVE_INFINITY) <= maxChallengeRating
  ))
  if (!suitable.length) throw new TypeError('no suitable monster records')
  // Для расчёта записи с одинаковым опытом взаимозаменяемы. Представитель
  // каждого значения выбирается по seed: рост справочника не раздувает поиск,
  // а реальные составы сохраняют разнообразие.
  const candidates = []
  for (const record of candidateOrder(suitable, String(seed))) {
    if (!candidates.some((candidate) => Number(candidate.xp) === Number(record.xp))) candidates.push(record)
  }
  const cap = Math.max(1, Math.min(Number(maximumCreatures) || 12, partyLevels.length * 2))
  const targetSpan = interval.upper === Number.POSITIVE_INFINITY
    ? Math.max(100, interval.lower)
    : interval.upper - interval.lower + 1
  const targetAdjusted = interval.lower + hash32(`${seed}:target:${difficulty}`) % targetSpan

  const minimumMultiplier = Math.min(...Array.from({ length: cap }, (_, index) => encounterMultiplier(index + 1, partyLevels.length)))
  const maximumXp = candidates.reduce((maximum, record) => Math.max(maximum, Number(record.xp) || 0), 0)
  const maximumRaw = interval.upper === Number.POSITIVE_INFINITY
    ? Math.ceil(targetAdjusted / minimumMultiplier + maximumXp)
    : Math.max(
      Math.floor(interval.upper / minimumMultiplier),
      Math.ceil(interval.lower / minimumMultiplier + maximumXp),
    )
  const { states, xpUnit } = buildRosterStates(candidates, cap, maximumRaw, String(seed))

  let best = null
  for (let count = 1; count <= cap; count += 1) {
    const multiplier = encounterMultiplier(count, partyLevels.length)
    const candidate = bestRosterForCount(states, xpUnit, count, multiplier, interval, String(seed), targetAdjusted)
    if (!candidate) continue
    const score = [candidate.score[0], candidate.score[1], Math.abs(candidate.adjusted - targetAdjusted), Math.abs(count - Math.min(partyLevels.length, 4))]
    const tie = hash32(`${seed}:count:${rosterKey(candidate.path)}`)
    if (!best || scoreLess(score, best.score) || (score.every((value, index) => value === best.score[index]) && tie < best.tie)) {
      best = { ...candidate, multiplier, score, tie }
    }
  }
  if (!best) throw new TypeError('no roster fits the encounter bounds')
  const byId = new Map(candidates.map((record) => [String(record.id), record]))
  return {
    records: best.path.map((id) => byId.get(String(id))),
    target_adjusted_xp: targetAdjusted,
    raw_xp: best.spent,
    adjusted_xp: best.adjusted,
    multiplier: best.multiplier,
    thresholds,
    interval,
  }
}

export function assessEncounterRoster({ records, partyLevels, difficulty, seed = 'combat-lab' } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array')
  if (!COMBAT_LAB_ENCOUNTER_DIFFICULTIES.includes(difficulty)) throw new TypeError('unknown encounter difficulty')
  const thresholds = partyThresholds2014(partyLevels)
  const rawXp = records.reduce((sum, record) => sum + (Number(record?.xp) || 0), 0)
  const multiplier = records.length ? encounterMultiplier(records.length, partyLevels.length) : 1
  const adjustedXp = rawXp * multiplier
  const interval = encounterInterval(difficulty, thresholds)
  const resultingDifficulty = difficultyForAdjustedXp(adjustedXp, thresholds)
  return {
    difficulty: resultingDifficulty,
    requestedDifficulty: difficulty,
    rawXp,
    adjustedXp,
    multiplier,
    thresholds,
    partyLevels: [...partyLevels],
    monsterCount: records.length,
    matched: records.length > 0 && adjustedXp >= interval.lower && adjustedXp <= interval.upper,
    seed: String(seed),
  }
}
