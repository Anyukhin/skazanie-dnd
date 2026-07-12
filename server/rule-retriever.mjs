import { validateRulePack } from './rule-pack.mjs'

const DEFAULT_VECTOR_DIMENSIONS = 384
const MAX_LIMIT = 50

const STOP_WORDS = new Set([
  'а', 'без', 'бы', 'в', 'во', 'вы', 'для', 'до', 'его', 'ее', 'её', 'если', 'и', 'или', 'из', 'как', 'ко', 'ли', 'мне', 'можно', 'мой', 'мы', 'на', 'над', 'не', 'нужно', 'о', 'об', 'от', 'по', 'под', 'после', 'при', 'про', 'с', 'со', 'у', 'что', 'я',
  'a', 'an', 'and', 'are', 'at', 'be', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it', 'may', 'my', 'of', 'on', 'or', 'the', 'to', 'when', 'with', 'work', 'works',
])

const RUSSIAN_SUFFIXES = [
  'иями', 'ями', 'ами', 'иями', 'его', 'ого', 'ему', 'ому', 'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой', 'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею',
  'ение', 'ения', 'ению', 'ением', 'ениях', 'ация', 'ации', 'ацию', 'ацией', 'ость', 'ости', 'остью',
  'ировать', 'ировать', 'овать', 'евать', 'ившись', 'ывшись', 'ивши', 'ывши', 'ив', 'ыв', 'иться', 'аться', 'яться',
  'ешь', 'ете', 'ить', 'ыть', 'ать', 'ять', 'еть', 'уть', 'ют', 'уют', 'ят', 'ают', 'ен', 'ила', 'ыла', 'ена', 'ейте', 'уйте', 'ите', 'или', 'ыли', 'ей', 'уй', 'ил', 'ыл', 'им', 'ым', 'ен', 'ило', 'ыло', 'ено', 'ят', 'ует', 'уют', 'ит', 'ыт', 'ены', 'ить', 'ыть', 'ишь', 'ую', 'ю',
  'ов', 'ев', 'ей', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ами', 'ями', 'ия', 'ью', 'ию', 'ии', 'иям', 'ием', 'иях', 'а', 'я', 'ы', 'и', 'ь', 'й', 'у', 'ю', 'о', 'е',
].sort((left, right) => right.length - left.length)

export function normalizeForSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}+-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function stemRussian(token) {
  if (!/[а-я]/u.test(token) || token.length < 4) return token
  for (const suffix of RUSSIAN_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length)
  }
  return token
}

function stemEnglish(token) {
  if (!/^[a-z]+$/.test(token) || token.length < 4) return token
  if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`
  for (const suffix of ['ingly', 'edly', 'ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length)
  }
  return token
}

export function stemSearchToken(token) {
  const normalized = normalizeForSearch(token)
  if (!normalized || normalized.includes(' ')) return normalized
  return stemEnglish(stemRussian(normalized))
}

export function tokenizeForSearch(value, { keepStopWords = false } = {}) {
  const normalized = normalizeForSearch(value)
  if (!normalized) return []
  const result = []
  for (const raw of normalized.split(' ')) {
    if (!raw || (!keepStopWords && STOP_WORDS.has(raw))) continue
    const stem = stemSearchToken(raw)
    if (!stem || (!keepStopWords && STOP_WORDS.has(stem))) continue
    result.push({ raw, stem })
  }
  return result
}

export function levenshteinDistance(leftValue, rightValue, maximum = Number.POSITIVE_INFINITY) {
  const left = String(leftValue)
  const right = String(rightValue)
  if (left === right) return 0
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1
  if (!left.length) return right.length
  if (!right.length) return left.length

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    let rowMinimum = row
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost,
      )
      current.push(value)
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > maximum) return maximum + 1
    previous = current
  }
  return previous[right.length]
}

function hashFeature(feature) {
  let hash = 0x811c9dc5
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function vectorFeatures(value) {
  const normalized = normalizeForSearch(value)
  const tokens = tokenizeForSearch(normalized)
  const features = []
  for (const token of tokens) {
    features.push([`w:${token.stem}`, 2.5])
    const padded = `^${token.stem}$`
    for (let size = 3; size <= 4; size += 1) {
      for (let index = 0; index <= padded.length - size; index += 1) {
        features.push([`c${size}:${padded.slice(index, index + size)}`, 0.55])
      }
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    features.push([`b:${tokens[index].stem}_${tokens[index + 1].stem}`, 1.4])
  }
  return features
}

/** A deterministic, dependency-free local feature-hashing vector. */
export function deterministicLocalVector(value, dimensions = DEFAULT_VECTOR_DIMENSIONS) {
  if (!Number.isInteger(dimensions) || dimensions < 32) throw new TypeError('dimensions must be an integer >= 32')
  const vector = new Float64Array(dimensions)
  for (const [feature, weight] of vectorFeatures(value)) {
    const hash = hashFeature(feature)
    const position = hash % dimensions
    const sign = (hash & 0x80000000) === 0 ? 1 : -1
    vector[position] += sign * weight
  }
  let magnitude = 0
  for (const valueAtPosition of vector) magnitude += valueAtPosition * valueAtPosition
  magnitude = Math.sqrt(magnitude)
  if (magnitude > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude
  return vector
}

function cosineSimilarity(left, right) {
  let result = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) result += left[index] * right[index]
  return Math.max(0, Math.min(1, result))
}

function addWeightedTokens(weights, value, weight) {
  for (const token of tokenizeForSearch(value)) {
    weights.set(token.stem, Math.max(weights.get(token.stem) || 0, weight))
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
}

function buildDocument(pack, rule) {
  const glossaryEntries = pack.glossary.filter((entry) => rule.entity_refs.includes(entry.canonical_id))
  const glossaryPhrases = glossaryEntries.flatMap((entry) => [entry.term_en, entry.term_ru, ...entry.aliases_ru])
  const directAliases = uniqueStrings([...rule.aliases_en, ...rule.aliases_ru])
  const aliases = uniqueStrings([...directAliases, ...glossaryPhrases])
  const titles = uniqueStrings([rule.title_en, rule.title_ru])
  const weights = new Map()
  for (const title of titles) addWeightedTokens(weights, title, 5)
  for (const alias of directAliases) addWeightedTokens(weights, alias, 6)
  for (const phrase of glossaryPhrases) addWeightedTokens(weights, phrase, 4.5)
  addWeightedTokens(weights, rule.tags.join(' '), 3.5)
  addWeightedTokens(weights, rule.section_path.join(' '), 2.5)
  addWeightedTokens(weights, `${rule.text_en} ${rule.text_ru}`, 1.5)
  const directPhraseSet = new Set([...titles, ...directAliases].map(normalizeForSearch))
  const phrases = uniqueStrings([...titles, ...aliases]).map((phrase) => {
    const normalized = normalizeForSearch(phrase)
    return {
      original: phrase,
      normalized,
      stems: tokenizeForSearch(phrase).map((token) => token.stem),
      sourceWeight: directPhraseSet.has(normalized) ? 1 : 0.72,
    }
  }).filter((phrase) => phrase.normalized)
  const vectorText = [
    ...titles, ...titles,
    ...aliases, ...aliases, ...aliases,
    rule.tags.join(' '),
    rule.text_en,
    rule.text_ru,
  ].join(' ')
  return {
    id: rule.id,
    rulesetId: rule.ruleset_id,
    packId: pack.manifest.pack_id,
    rule,
    weights,
    phrases,
    vector: deterministicLocalVector(vectorText),
  }
}

function buildInverseDocumentFrequency(documents) {
  const frequencies = new Map()
  for (const document of documents) {
    for (const stem of document.weights.keys()) frequencies.set(stem, (frequencies.get(stem) || 0) + 1)
  }
  const idf = new Map()
  for (const [stem, frequency] of frequencies) {
    idf.set(stem, Math.log((documents.length + 1) / (frequency + 1)) + 1)
  }
  return idf
}

function fuzzyThreshold(token) {
  if (token.length >= 9) return 2
  if (token.length >= 5) return 1
  return 0
}

function lexicalScore(document, queryTokens, idf) {
  if (!queryTokens.length) return { score: 0, matched: [] }
  let total = 0
  const matched = []
  const uniqueQueryTokens = [...new Set(queryTokens.map((token) => token.stem))]
  for (const queryStem of uniqueQueryTokens) {
    const exactWeight = document.weights.get(queryStem)
    if (exactWeight) {
      total += exactWeight * (idf.get(queryStem) || 1)
      matched.push(queryStem)
      continue
    }
    const threshold = fuzzyThreshold(queryStem)
    if (!threshold) continue
    let best = null
    for (const [documentStem, weight] of document.weights) {
      if (Math.abs(documentStem.length - queryStem.length) > threshold) continue
      const distance = levenshteinDistance(queryStem, documentStem, threshold)
      if (distance <= threshold && (!best || distance < best.distance || (distance === best.distance && weight > best.weight))) {
        best = { documentStem, distance, weight }
      }
    }
    if (best) {
      const fuzzyFactor = best.distance === 1 ? 0.68 : 0.42
      total += best.weight * (idf.get(best.documentStem) || 1) * fuzzyFactor
      matched.push(`${queryStem}~${best.documentStem}`)
    }
  }
  const maximum = Math.max(1, uniqueQueryTokens.length * 7)
  return { score: Math.min(1, total / maximum), matched }
}

function phraseScore(document, normalizedQueries, queryStemSet) {
  let best = 0
  const matchedAliases = []
  for (const phrase of document.phrases) {
    if (phrase.normalized.length < 2) continue
    if (normalizedQueries.some((query) => query.includes(phrase.normalized))) {
      best = Math.max(best, (phrase.stems.length > 1 ? 1 : 0.9) * phrase.sourceWeight)
      matchedAliases.push(phrase.original)
      continue
    }
    if (phrase.stems.length > 0 && phrase.stems.every((stem) => queryStemSet.has(stem))) {
      best = Math.max(best, (phrase.stems.length > 1 ? 0.8 : 0.9) * phrase.sourceWeight)
      matchedAliases.push(phrase.original)
      continue
    }
    if (phrase.stems.length === 1) {
      const phraseStem = phrase.stems[0]
      const threshold = fuzzyThreshold(phraseStem)
      if (threshold && [...queryStemSet].some((queryStem) => levenshteinDistance(queryStem, phraseStem, threshold) <= threshold)) {
        best = Math.max(best, 0.9 * phrase.sourceWeight)
        matchedAliases.push(`${phrase.original} (fuzzy)`)
      }
    }
  }
  return { score: best, matchedAliases: uniqueStrings(matchedAliases) }
}

function roundScore(value) {
  return Number(Math.max(0, value).toFixed(6))
}

function buildGraph(rulePacks) {
  const graphByRuleset = new Map()
  const add = (rulesetId, from, to, edge) => {
    if (!graphByRuleset.has(rulesetId)) graphByRuleset.set(rulesetId, new Map())
    const graph = graphByRuleset.get(rulesetId)
    if (!graph.has(from)) graph.set(from, [])
    graph.get(from).push({ id: to, relation: edge.relation, weight: edge.weight })
  }
  for (const pack of rulePacks) {
    for (const edge of pack.ontologyEdges) {
      add(edge.ruleset_id, edge.from_id, edge.to_id, edge)
      if (edge.bidirectional) add(edge.ruleset_id, edge.to_id, edge.from_id, edge)
    }
  }
  return graphByRuleset
}

export class RuleRetriever {
  constructor(rulePacks, { vectorDimensions = DEFAULT_VECTOR_DIMENSIONS } = {}) {
    if (vectorDimensions !== DEFAULT_VECTOR_DIMENSIONS) {
      throw new TypeError(`This retriever index uses fixed ${DEFAULT_VECTOR_DIMENSIONS}-dimension local vectors`)
    }
    const packs = Array.isArray(rulePacks) ? rulePacks : [rulePacks]
    if (!packs.length || packs.some((pack) => !pack)) throw new TypeError('RuleRetriever needs at least one rule pack')
    this.packs = [...packs]
    this.packRulesets = new Map()
    this.documentsByRuleset = new Map()

    for (const pack of packs) {
      validateRulePack(pack, { expectedRulesetId: pack.manifest?.ruleset_id })
      const packId = pack.manifest.pack_id
      if (this.packRulesets.has(packId)) throw new TypeError(`Duplicate pack_id ${packId}`)
      this.packRulesets.set(packId, pack.manifest.ruleset_id)
      if (!this.documentsByRuleset.has(pack.manifest.ruleset_id)) this.documentsByRuleset.set(pack.manifest.ruleset_id, [])
      this.documentsByRuleset.get(pack.manifest.ruleset_id).push(...pack.rules.map((rule) => buildDocument(pack, rule)))
    }

    this.idfByRuleset = new Map([...this.documentsByRuleset].map(([rulesetId, documents]) => [rulesetId, buildInverseDocumentFrequency(documents)]))
    this.graphByRuleset = buildGraph(packs)
  }

  async search(input = {}) {
    const queriesInput = input.queries ?? input.query
    const queries = (Array.isArray(queriesInput) ? queriesInput : [queriesInput])
      .filter((query) => typeof query === 'string' && query.trim())
      .map((query) => query.trim())
    if (!queries.length) throw new TypeError('queries must contain at least one non-empty string')

    const rulesetId = input.rulesetId ?? input.ruleset_id
    if (typeof rulesetId !== 'string' || !rulesetId) throw new TypeError('ruleset_id is required')
    const allDocuments = this.documentsByRuleset.get(rulesetId)
    if (!allDocuments) throw new RangeError(`Unknown ruleset_id ${rulesetId}`)

    const requestedPacks = input.enabledPacks ?? input.enabled_packs
    const enabledPacks = requestedPacks === undefined
      ? [...this.packRulesets].filter(([, packRuleset]) => packRuleset === rulesetId).map(([packId]) => packId)
      : requestedPacks
    if (!Array.isArray(enabledPacks) || enabledPacks.length === 0 || enabledPacks.some((packId) => typeof packId !== 'string')) {
      throw new TypeError('enabled_packs must be a non-empty array of pack ids')
    }
    for (const packId of enabledPacks) {
      const packRuleset = this.packRulesets.get(packId)
      if (!packRuleset) throw new RangeError(`Unknown enabled pack ${packId}`)
      if (packRuleset !== rulesetId) {
        throw new RangeError(`Enabled pack ${packId} belongs to ${packRuleset}, not requested ${rulesetId}`)
      }
    }

    const enabledSet = new Set(enabledPacks)
    const entityTypesInput = input.entityTypes ?? input.entity_types
    const entityTypes = entityTypesInput == null ? null : new Set(entityTypesInput)
    if (entityTypesInput != null && !Array.isArray(entityTypesInput)) throw new TypeError('entity_types must be an array when provided')
    const documents = allDocuments.filter((document) => {
      if (document.rulesetId !== rulesetId || !enabledSet.has(document.packId)) return false
      if (!entityTypes) return true
      return entityTypes.has(document.rule.kind) || document.rule.tags.some((tag) => entityTypes.has(tag))
    })
    if (!documents.length) return { ruleset_id: rulesetId, queries, enabled_packs: [...enabledSet], count: 0, confidence: 0, results: [] }

    const normalizedQueries = queries.map(normalizeForSearch)
    const queryText = normalizedQueries.join(' ')
    const queryTokens = tokenizeForSearch(queryText)
    const queryStemSet = new Set(queryTokens.map((token) => token.stem))
    const queryVector = deterministicLocalVector(queryText)
    const idf = this.idfByRuleset.get(rulesetId)
    const scored = new Map()

    for (const document of documents) {
      const lexical = lexicalScore(document, queryTokens, idf)
      const phrase = phraseScore(document, normalizedQueries, queryStemSet)
      const vector = cosineSimilarity(queryVector, document.vector)
      const directScore = 0.57 * lexical.score + 0.25 * vector + 0.18 * phrase.score
      scored.set(document.id, {
        document,
        directScore,
        lexical: lexical.score,
        vector,
        alias: phrase.score,
        ontology: 0,
        matchedTerms: lexical.matched,
        matchedAliases: phrase.matchedAliases,
        ontologyReasons: [],
      })
    }

    const seeds = [...scored.values()]
      .filter((entry) => entry.directScore >= 0.04)
      .sort((left, right) => right.directScore - left.directScore || left.document.id.localeCompare(right.document.id, 'en'))
      .slice(0, 2)
    const graph = this.graphByRuleset.get(rulesetId) || new Map()
    for (const seed of seeds) {
      for (const neighbor of graph.get(seed.document.id) || []) {
        const target = scored.get(neighbor.id)
        if (!target || target.document.rulesetId !== rulesetId) continue
        const contribution = seed.directScore * neighbor.weight * 0.12
        target.ontology = Math.min(0.18, target.ontology + contribution)
        target.ontologyReasons.push({ from_rule_id: seed.document.id, relation: neighbor.relation, contribution: roundScore(contribution) })
      }
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(input.limit) ? input.limit : 10))
    const results = [...scored.values()]
      .map((entry) => ({ ...entry, score: entry.directScore + entry.ontology }))
      .filter((entry) => entry.score >= 0.035)
      .sort((left, right) => right.score - left.score || right.directScore - left.directScore || left.document.id.localeCompare(right.document.id, 'en'))
      .slice(0, limit)
      .map((entry) => ({
        rule_id: entry.document.rule.id,
        ruleset_id: entry.document.rule.ruleset_id,
        pack_id: entry.document.packId,
        title_en: entry.document.rule.title_en,
        title_ru: entry.document.rule.title_ru,
        text_en: entry.document.rule.text_en,
        text_ru: entry.document.rule.text_ru,
        formalization_level: entry.document.rule.formalization_level,
        source_page: entry.document.rule.source_page_start,
        score: roundScore(entry.score),
        matched_by: [
          entry.lexical > 0 ? 'lexical' : null,
          entry.vector > 0 ? 'vector' : null,
          entry.alias > 0 ? 'aliases' : null,
          entry.ontology > 0 ? 'ontology' : null,
        ].filter(Boolean),
        score_breakdown: {
          lexical: roundScore(entry.lexical),
          local_vector: roundScore(entry.vector),
          aliases: roundScore(entry.alias),
          ontology: roundScore(entry.ontology),
        },
        matched_terms: uniqueStrings(entry.matchedTerms),
        matched_aliases: entry.matchedAliases,
        ontology_reasons: entry.ontologyReasons,
        rule: entry.document.rule,
      }))

    return {
      ruleset_id: rulesetId,
      queries,
      enabled_packs: [...enabledSet],
      count: results.length,
      confidence: results.length ? roundScore(Math.min(1, results[0].score)) : 0,
      results,
    }
  }
}

export function createRuleRetriever(rulePacks, options) {
  return new RuleRetriever(rulePacks, options)
}
