const WORD_PATTERN = /[a-zа-яё0-9]+/giu

/**
 * Каталог составлен по сохранённому прогону
 * `eval/live-narrator-report.json` от 2026-07-28 и живому baseline Wave 1.
 * Это не абстрактный список «плохих слов»: у каждой записи, кроме двух
 * обязательных примеров из брифа, есть дословно наблюдавшийся фрагмент.
 */
export const NARRATOR_CLICHE_CATALOG = Object.freeze([
  { id: 'air-thickens', label: 'воздух густеет', source: 'обязательный пример из брифа S', pattern: 'воздух\\s+густе' },
  { id: 'silence-hangs', label: 'повисает тишина', source: 'обязательный пример из брифа S', pattern: 'повиса(?:ет|ла)\\s+тишин' },
  { id: 'moment-freeze', label: 'на мгновение замирает', source: 'на мгновение замирает', pattern: 'на\\s+(?:одно\\s+)?мгновени[ея]\\s+(?:замира|засты)' },
  { id: 'eyes-flash', label: 'в глазах мелькает', source: 'в глазах мелькает узнавание', pattern: 'в\\s+глазах\\s+(?:мелька|вспых)' },
  { id: 'pulls-together', label: 'берёт себя в руки', source: 'быстро берёт себя в руки', pattern: 'бер[её]т\\s+себя\\s+в\\s+руки' },
  { id: 'legs-buckle', label: 'ноги подкашиваются', source: 'ноги подкашиваются', pattern: 'ноги\\s+подкашива' },
  { id: 'world-swims', label: 'мир плывёт', source: 'мир плывёт', pattern: 'мир\\s+плыв[её]т' },
  { id: 'air-smells', label: 'в воздухе пахнет', source: 'в воздухе пахнет пылью и дымом', pattern: 'в\\s+воздухе\\s+пахн' },
  { id: 'sun-declines', label: 'солнце клонится к закату', source: 'солнце клонится к закату', pattern: 'солнце\\s+клонится\\s+к\\s+закату' },
  { id: 'crimson-sky', label: 'багровые тона', source: 'окрашивая небо в багровые тона', pattern: 'небо.{0,24}багров|багров.{0,24}небо' },
  { id: 'cuts-through-din', label: 'перекрывает гул', source: 'голос перекрывает гул трактира', pattern: 'перекрыва[ею]т\\s+гул' },
  { id: 'last-lunge', label: 'в последнем рывке', source: 'извернувшись в последнем рывке', pattern: 'в\\s+последн(?:ем|ий)\\s+рывк' },
  { id: 'wariness-melts', label: 'настороженность тает', source: 'Мирина настороженность тает', pattern: 'настороженн[а-яё]*\\s+та[её]т' },
  { id: 'casts-a-glance', label: 'бросает взгляд', source: 'бросает взгляд на Северные ворота', pattern: 'броса[а-яё]*\\s+взгляд' },
  { id: 'thought-spins', label: 'в голове крутится', source: 'в голове крутится та же синяя нить', pattern: 'в\\s+голове\\s+крут' },
  { id: 'silence-stands', label: 'тишина стоит такая', source: 'тишина стоит такая, будто телега растворилась', pattern: 'тишина\\s+стоит\\s+так' },
  { id: 'threads-one-knot', label: 'нити одного узла', source: 'две нити одного узла', pattern: 'нит[ьи]\\s+одного\\s+узла' },
])

export const NARRATOR_CRAFT_THRESHOLDS = Object.freeze({
  ngram_overlap_max_pct: 5,
  cliche_max_occurrences: 0,
  memory_min_pct: 90,
  voice_distinct_min_pct: 80,
})

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/gu, ' ').trim()
}

function words(value) {
  return normalized(value).match(WORD_PATTERN) ?? []
}

function ngrams(value, size = 3) {
  const tokens = words(value)
  const result = new Set()
  for (let index = 0; index + size <= tokens.length; index += 1) {
    result.add(tokens.slice(index, index + size).join(' '))
  }
  return result
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function roundPercent(value) {
  return Math.round(value * 10_000) / 100
}

function patternMatches(text, pattern) {
  try {
    return new RegExp(pattern, 'iu').test(String(text ?? ''))
  } catch {
    return false
  }
}

function matchesAny(text, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => patternMatches(text, pattern))
}

function countPattern(text, pattern) {
  try {
    return [...String(text ?? '').matchAll(new RegExp(pattern, 'giu'))].length
  } catch {
    return 0
  }
}

function pairwiseAverage(values, score) {
  let total = 0
  let pairs = 0
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      total += score(values[left], values[right])
      pairs += 1
    }
  }
  return pairs ? total / pairs : 0
}

function memoryMeasurement(samples) {
  const eligible = samples.filter((sample) => Array.isArray(sample.memory_anchors) && sample.memory_anchors.length)
  const rows = eligible.map((sample) => ({
    id: sample.id,
    recalled: matchesAny(sample.text, sample.memory_anchors),
  }))
  return {
    eligible: eligible.length,
    recalled: rows.filter((row) => row.recalled).length,
    recall_pct: roundPercent(rows.filter((row) => row.recalled).length / Math.max(1, eligible.length)),
    rows,
  }
}

function voiceMeasurement(samples) {
  const grouped = new Map()
  for (const sample of samples.filter((entry) => entry.voice_pair)) {
    grouped.set(sample.voice_pair, [...(grouped.get(sample.voice_pair) ?? []), sample])
  }
  const rows = []
  for (const [pair, entries] of grouped) {
    if (entries.length !== 2) continue
    const [left, right] = entries
    const leftOwn = matchesAny(left.text, left.voice_markers)
    const rightOwn = matchesAny(right.text, right.voice_markers)
    const lexicalDistance = 1 - jaccard(new Set(words(left.text)), new Set(words(right.text)))
    rows.push({
      pair,
      ids: [left.id, right.id],
      own_markers: [leftOwn, rightOwn],
      lexical_distance_pct: roundPercent(lexicalDistance),
      distinct: leftOwn && rightOwn && lexicalDistance >= 0.55,
    })
  }
  return {
    eligible_pairs: rows.length,
    distinct_pairs: rows.filter((row) => row.distinct).length,
    distinct_pct: roundPercent(rows.filter((row) => row.distinct).length / Math.max(1, rows.length)),
    rows,
  }
}

function suggestionMeasurement(samples) {
  const turns = samples.filter((sample) => sample.kind === 'narrator')
  const suggestions = turns.flatMap((sample) => (Array.isArray(sample.suggestions) ? sample.suggestions : [])
    .map((text) => ({ sample, text: String(text) })))
  const specific = suggestions.filter(({ sample, text }) => matchesAny(text, sample.specific_anchors))
  const forwardTurns = turns.filter((sample) => sample.suggestions.some((text) => matchesAny(text, sample.forward_anchors)))
  const personalTurns = turns.filter((sample) => sample.suggestions.some((text) => matchesAny(text, sample.personal_anchors)))
  const boundedTurns = turns.filter((sample) => sample.suggestions.length <= 3
    && sample.suggestions.every((text) => String(text).length <= 120))
  return {
    total: suggestions.length,
    specific: specific.length,
    specific_pct: roundPercent(specific.length / Math.max(1, suggestions.length)),
    forward_turns: forwardTurns.length,
    forward_coverage_pct: roundPercent(forwardTurns.length / Math.max(1, turns.length)),
    personal_turns: personalTurns.length,
    personal_coverage_pct: roundPercent(personalTurns.length / Math.max(1, turns.length)),
    bounded_turns: boundedTurns.length,
    bounded_pct: roundPercent(boundedTurns.length / Math.max(1, turns.length)),
    rows: turns.map((sample) => ({
      id: sample.id,
      suggestions: sample.suggestions,
      specific: sample.suggestions.map((text) => matchesAny(text, sample.specific_anchors)),
      forward: sample.suggestions.some((text) => matchesAny(text, sample.forward_anchors)),
      personal: sample.suggestions.some((text) => matchesAny(text, sample.personal_anchors)),
    })),
  }
}

/**
 * Пять основных метрик ремесла рассказчика. Вход — уже полученные ответы,
 * поэтому тот же расчёт можно воспроизвести без нового платного вызова модели.
 */
export function measureNarratorCraft(samples = []) {
  const safeSamples = (Array.isArray(samples) ? samples : []).map((sample) => ({
    ...sample,
    text: String(sample?.text ?? ''),
    suggestions: Array.isArray(sample?.suggestions) ? sample.suggestions.map(String).slice(0, 3) : [],
  }))
  const narratorTexts = safeSamples.filter((sample) => sample.kind === 'narrator').map((sample) => sample.text)
  const allText = safeSamples.map((sample) => sample.text).join('\n')
  const pairwiseNgram = pairwiseAverage(narratorTexts.map((text) => ngrams(text, 3)), jaccard)
  const clicheRows = NARRATOR_CLICHE_CATALOG.map((entry) => ({
    id: entry.id,
    label: entry.label,
    source: entry.source,
    count: countPattern(allText, entry.pattern),
  }))
  const clicheCount = clicheRows.reduce((sum, entry) => sum + entry.count, 0)
  const tokenCount = words(allText).length
  const metrics = {
    ngram_overlap: {
      n: 3,
      narrator_samples: narratorTexts.length,
      pairwise_jaccard_pct: roundPercent(pairwiseNgram),
    },
    cliches: {
      occurrences: clicheCount,
      per_1000_tokens: Math.round((clicheCount / Math.max(1, tokenCount)) * 100_000) / 100,
      tokens: tokenCount,
      catalog: clicheRows,
    },
    memory: memoryMeasurement(safeSamples),
    voices: voiceMeasurement(safeSamples),
    suggestions: suggestionMeasurement(safeSamples),
  }
  const gates = {
    ngram_overlap: metrics.ngram_overlap.pairwise_jaccard_pct <= NARRATOR_CRAFT_THRESHOLDS.ngram_overlap_max_pct,
    cliches: metrics.cliches.occurrences <= NARRATOR_CRAFT_THRESHOLDS.cliche_max_occurrences,
    memory: metrics.memory.recall_pct >= NARRATOR_CRAFT_THRESHOLDS.memory_min_pct,
    voices: metrics.voices.distinct_pct >= NARRATOR_CRAFT_THRESHOLDS.voice_distinct_min_pct,
  }
  return {
    ...metrics,
    quality_gate: {
      thresholds: NARRATOR_CRAFT_THRESHOLDS,
      checks: gates,
      passed: Object.values(gates).every(Boolean),
    },
  }
}

export function compareNarratorCraftReports(before, after) {
  const beforeMetrics = before?.metrics ?? measureNarratorCraft(before?.samples ?? [])
  const afterMetrics = after?.metrics ?? measureNarratorCraft(after?.samples ?? [])
  const delta = {
    ngram_overlap_pct: Math.round((afterMetrics.ngram_overlap.pairwise_jaccard_pct - beforeMetrics.ngram_overlap.pairwise_jaccard_pct) * 100) / 100,
    cliche_occurrences: afterMetrics.cliches.occurrences - beforeMetrics.cliches.occurrences,
    memory_recall_pct: Math.round((afterMetrics.memory.recall_pct - beforeMetrics.memory.recall_pct) * 100) / 100,
    voice_distinct_pct: Math.round((afterMetrics.voices.distinct_pct - beforeMetrics.voices.distinct_pct) * 100) / 100,
    suggestion_specific_pct: Math.round((afterMetrics.suggestions.specific_pct - beforeMetrics.suggestions.specific_pct) * 100) / 100,
  }
  return {
    before: beforeMetrics,
    after: afterMetrics,
    delta,
    trend: {
      ngram_overlap_improved: delta.ngram_overlap_pct < 0,
      cliches_improved: delta.cliche_occurrences < 0,
      memory_improved: delta.memory_recall_pct > 0,
      voices_improved: delta.voice_distinct_pct > 0,
      suggestion_specific_improved: delta.suggestion_specific_pct > 0,
    },
  }
}
