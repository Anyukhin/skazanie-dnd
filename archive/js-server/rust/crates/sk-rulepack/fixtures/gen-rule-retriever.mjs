// Эталон rule-retriever для Rust: нормализация, стемы, Левенштейн, локальные
// векторы и сотни поисковых запросов к настоящим пакетам data/rule_packs.
//
//   node rust/crates/sk-rulepack/fixtures/gen-rule-retriever.mjs
//
// Пишет rule-retriever.json рядом с собой. У результатов поиска убраны
// `rule`, `text_en` и `text_ru` — Rust сверяет их с правилом пакета по
// `rule_id`, остальное сравнивается целиком.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadRulePack } from '../../../../server/rule-pack.mjs'
import {
  RuleRetriever,
  deterministicLocalVector,
  levenshteinDistance,
  normalizeForSearch,
  stemSearchToken,
  tokenizeForSearch,
} from '../../../../server/rule-retriever.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))

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
const random = mulberry32(20261014)
const pick = (items) => items[Math.floor(random() * items.length)]

const srd = await loadRulePack('srd_5_2_1')
const classic = await loadRulePack('dnd_5e_2014')

function foreignPack() {
  const rulesetId = 'foreign_edition'
  return {
    manifest: {
      ruleset_id: rulesetId, pack_id: rulesetId, edition_family: 'foreign', version: '1.0.0', canonical_language: 'en',
      display_languages: ['ru', 'en'], license_id: 'ORIGINAL-PARAPHRASE', created_at: '2026-07-11T00:00:00Z', verified_at: '2026-07-11T00:00:00Z',
    },
    rules: [{
      id: `${rulesetId}:core:quantum-flumph`, ruleset_id: rulesetId, version: '1.0.0', kind: 'rule', section_path: ['Core'],
      title_en: 'Quantum Flumph Protocol', title_ru: 'Квантовый протокол флумфа',
      text_en: 'Invoke the quantum flumph protocol.', text_ru: 'Примените квантовый протокол флумфа.',
      tags: ['foreign'], entity_refs: ['term:quantum-flumph'], aliases_en: ['quantum flumph'], aliases_ru: ['квантовый флумф'],
      formalization_level: 'retrieval_only', source_page_start: 0, source_page_end: 0, source_hash: 'orig-foreign', license_id: 'ORIGINAL-PARAPHRASE',
    }, {
      id: `${rulesetId}:core:second`, ruleset_id: rulesetId, version: '1.0.0', kind: 'variant', section_path: ['Core', 'Other'],
      title_en: 'Second Flumph Rule', title_ru: 'Второе правило флумфа',
      text_en: 'A flumph floats 10 feet above the ground.', text_ru: 'Флумф парит в 10 футах над землёй.',
      tags: ['foreign', 'movement'], entity_refs: [], aliases_en: [], aliases_ru: ['парение'],
      formalization_level: 'structured', source_page_start: 1, source_page_end: 2, source_hash: 'orig-foreign-2', license_id: 'ORIGINAL-PARAPHRASE',
    }],
    glossary: [{ canonical_id: 'term:quantum-flumph', term_en: 'quantum flumph', term_ru: 'квантовый флумф', aliases_ru: ['флумф'], notes: '' }],
    ontologyEdges: [{ ruleset_id: rulesetId, from_id: `${rulesetId}:core:quantum-flumph`, to_id: `${rulesetId}:core:second`, relation: 'related', weight: 0.5, bidirectional: true }],
    coverage: { ruleset_id: rulesetId, rule_count: 2, glossary_term_count: 1, ontology_edge_count: 1 },
  }
}

// --- текстовые помощники --------------------------------------------------
const allRules = [...srd.rules, ...classic.rules]
const words = new Set()
for (const rule of allRules) {
  for (const text of [rule.title_en, rule.title_ru, rule.text_en, rule.text_ru, ...rule.aliases_en, ...rule.aliases_ru]) {
    for (const word of text.split(/\s+/u)) if (word) words.add(word)
  }
}
for (const entry of [...srd.glossary, ...classic.glossary]) for (const term of [entry.term_en, entry.term_ru, ...entry.aliases_ru]) words.add(term)
const wordList = [...words]
const tricky = [
  '', '   ', 'Ёлка ЁЖ ёж', "it's d'Artagnan’s `quote`", 'ﬁre ＡＢＣ ①②', 'a+b-c +5 -3 ++', 'Ⅻ ½ ²',
  'ПОМЕХОЙ, Reaction!', 'с помехой и помеха reaction reactions', 'abilities flies studies running jumped happily',
  'концентрацией концентрации', 'спасбросков спасброска', '𝔄𝔅 𝒳 emoji 😀 test', 'İstanbul ΣΟΦΙΑ', 'tab\there\nnew line',
  'и или на в', 'the and of to', 'work works working',
]
const textCases = [...tricky, ...wordList.filter((_, index) => index % 3 === 0)]
const texts = textCases.map((text) => ({
  text,
  normalized: normalizeForSearch(text),
  stem: stemSearchToken(text),
  tokens: tokenizeForSearch(text).map(({ raw, stem }) => [raw, stem]),
  tokens_all: tokenizeForSearch(text, { keepStopWords: true }).map(({ raw, stem }) => [raw, stem]),
}))

const levenshtein = []
for (let index = 0; index < 300; index += 1) {
  const left = stemSearchToken(pick(wordList))
  const right = random() < 0.3 ? left.slice(0, -1) + pick(['а', 'e', '']) : stemSearchToken(pick(wordList))
  const maximum = pick([undefined, 0, 1, 2, 3])
  levenshtein.push({ left, right, maximum: maximum ?? null, distance: levenshteinDistance(left, right, maximum) })
}
levenshtein.push({ left: '𝒳a', right: 'a', maximum: null, distance: levenshteinDistance('𝒳a', 'a') })

const vectorTexts = ['проверка concentration', 'урон damage', '', 'a', ...tricky.slice(0, 8), ...allRules.slice(0, 10).map((rule) => `${rule.title_en} ${rule.text_ru}`)]
const vectors = vectorTexts.map((text) => ({ text, vector: [...deterministicLocalVector(text)] }))
const vectors64 = ['проверка concentration', 'урон damage'].map((text) => ({ text, vector: [...deterministicLocalVector(text, 64)] }))

// --- поиск ----------------------------------------------------------------
const retriever = new RuleRetriever([srd, classic, foreignPack()])
const requests = []
const base = [
  ['Как работает помеха?', 'srd_5_2_1'], ['Можно ли сделать реакцию?', 'srd_5_2_1'], ['Что происходит при нуле хитов?', 'srd_5_2_1'],
  ['Нужно ли держать концентрацию?', 'srd_5_2_1'], ['У меня преимущество на атаку?', 'srd_5_2_1'], ['Без помехи на броске атаки', 'srd_5_2_1'],
  ['Помехха на атаке', 'srd_5_2_1'], ['Концентрацыя', 'srd_5_2_1'], ['How do death saving throws work at zero hp?', 'srd_5_2_1'],
  ['Can I use a reaction after an attack?', 'srd_5_2_1'], ['Можно use reaction after attack?', 'srd_5_2_1'], ['Бросаю два d20 и беру худший', 'srd_5_2_1'],
  ['Пытаюсь выплыть из бурной воды', 'srd_5_2_1'], ['Сколько герой может задерживать дыхание до удушья?', 'srd_5_2_1'],
  ['Сколько серебряных монет в одной золотой?', 'srd_5_2_1'], ['За сколько торговец выкупает обычное снаряжение?', 'srd_5_2_1'],
  ['Как работает Аура защиты паладина?', 'srd_5_2_1'], ['Как воин использует Несгибаемого после провала спасброска?', 'srd_5_2_1'],
  ['Сколько раундов можно дышать после задержки дыхания?', 'dnd_5e_2014'], ['концентрация', 'srd_5_2_1'], ['quantum flumph', 'foreign_edition'],
  ['quantum flumph помеха', 'srd_5_2_1'], ['флумф парит', 'foreign_edition'],
]
for (const [query, ruleset] of base) requests.push({ queries: [query], ruleset_id: ruleset, enabled_packs: [ruleset], limit: 5 })
requests.push({ queries: ['атака с преимуществом', 'advantage on attack'], ruleset_id: 'srd_5_2_1', enabled_packs: ['srd_5_2_1'], limit: 8 })
requests.push({ query: 'концентрация', rulesetId: 'srd_5_2_1', limit: 5 })
requests.push({ queries: 'удушье', ruleset_id: 'dnd_5e_2014' })

const mangle = (text) => {
  const letters = [...text]
  if (letters.length < 4) return text
  const index = 1 + Math.floor(random() * (letters.length - 2))
  const kind = random()
  if (kind < 0.33) letters.splice(index, 1)
  else if (kind < 0.66) letters.splice(index, 0, letters[index])
  else [letters[index], letters[index - 1]] = [letters[index - 1], letters[index]]
  return letters.join('')
}
for (const rule of allRules) {
  const ruleset = rule.ruleset_id
  const limit = 1 + Math.floor(random() * 10)
  requests.push({ queries: [rule.title_ru], ruleset_id: ruleset, limit })
  requests.push({ queries: [rule.title_en], ruleset_id: ruleset, enabled_packs: [ruleset], limit })
  if (rule.aliases_ru[0]) requests.push({ queries: [mangle(rule.aliases_ru[0])], ruleset_id: ruleset, limit: 6 })
  if (rule.aliases_en[0]) requests.push({ queries: [rule.aliases_en[0].toUpperCase()], ruleset_id: ruleset, limit: 4 })
  const longest = rule.title_ru.split(/\s+/u).sort((a, b) => b.length - a.length)[0]
  requests.push({ queries: [mangle(longest), mangle(rule.text_ru.split(/\s+/u).slice(0, 5).join(' '))], ruleset_id: ruleset, limit: 7 })
}
for (let index = 0; index < 120; index += 1) {
  const ruleset = pick(['srd_5_2_1', 'dnd_5e_2014', 'srd_5_2_1', 'dnd_5e_2014', 'foreign_edition'])
  const count = 1 + Math.floor(random() * 4)
  const phrase = Array.from({ length: count }, () => (random() < 0.25 ? mangle(pick(wordList)) : pick(wordList))).join(' ')
  const request = { queries: random() < 0.2 ? [phrase, pick(wordList)] : [phrase], ruleset_id: ruleset }
  const limitKind = random()
  if (limitKind < 0.15) request.limit = pick([0, -3, 100, 2.5, '5', null, 50, 51, 1])
  else if (limitKind < 0.8) request.limit = 1 + Math.floor(random() * 12)
  if (random() < 0.2) request.entity_types = pick([['rule'], ['p0'], ['combat'], ['nonexistent'], ['condition', 'rule'], [], ['variant']])
  requests.push(request)
}
// Отказы.
requests.push({ queries: [], ruleset_id: 'srd_5_2_1' })
requests.push({ queries: ['  ', 5, null], ruleset_id: 'srd_5_2_1' })
requests.push({ queries: ['помеха'] })
requests.push({ queries: ['помеха'], ruleset_id: '' })
requests.push({ queries: ['помеха'], ruleset_id: 5 })
requests.push({ queries: ['помеха'], ruleset_id: 'missing' })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', enabled_packs: ['foreign_edition'] })
requests.push({ queries: ['удушье'], ruleset_id: 'dnd_5e_2014', enabled_packs: ['srd_5_2_1'] })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', enabled_packs: [] })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', enabled_packs: [5] })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', enabled_packs: null })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', enabled_packs: ['missing'] })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', enabled_packs: ['srd_5_2_1', 'srd_5_2_1'] })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', entity_types: 'rule' })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', entity_types: null })
requests.push({ queries: ['помеха'], ruleset_id: 'srd_5_2_1', entityTypes: null, entity_types: ['rule'] })
requests.push({ query: null, queries: ['реакция'], ruleset_id: 'srd_5_2_1', rulesetId: null })

function strip(result) {
  return {
    ...result,
    results: result.results.map(({ rule, text_en, text_ru, ...rest }) => rest),
  }
}
const searches = []
for (const request of requests) {
  try {
    searches.push({ request, result: strip(await retriever.search(request)) })
  } catch (error) {
    searches.push({ request, error: { name: error.name, message: error.message } })
  }
}

const constructors = []
for (const [label, run] of [
  ['empty', () => new RuleRetriever([])],
  ['null-pack', () => new RuleRetriever([srd, null])],
  ['dimensions', () => new RuleRetriever([srd], { vectorDimensions: 128 })],
  ['duplicate', () => new RuleRetriever([srd, structuredClone(srd)])],
  ['invalid', () => new RuleRetriever([{ ...structuredClone(srd), coverage: null }])],
]) {
  try {
    run()
    constructors.push({ label, ok: true })
  } catch (error) {
    constructors.push({ label, error: { name: error.name, message: error.message } })
  }
}

const fixture = { foreign: foreignPack(), texts, levenshtein, vectors, vectors64, searches, constructors }
const lines = Object.entries(fixture).map(([key, value]) => Array.isArray(value)
  ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  : `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
writeFileSync(here('rule-retriever.json'), `{\n${lines.join(',\n')}\n}\n`)
console.log(`rule-retriever.json: ${texts.length} текстов, ${levenshtein.length} пар, ${vectors.length + vectors64.length} векторов, ${searches.length} запросов (${searches.filter((entry) => entry.error).length} отказов), результатов ${searches.reduce((sum, entry) => sum + (entry.result?.results.length ?? 0), 0)}`)
