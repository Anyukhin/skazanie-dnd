// Эталон rule-pack для Rust: загруженные пакеты, токены механических чисел,
// разбор YAML/CSV/JSONL и отказы проверки на сотнях правок настоящих пакетов.
//
//   node rust/crates/sk-rulepack/fixtures/gen-rule-pack.mjs
//
// Пишет rule-pack.json рядом с собой. Правка — путь в пакете и новое
// значение (`set`) или удаление поля (`delete`); Rust применяет ту же правку и
// сверяет текст отказа или сводку.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  checkTranslationNumericIntegrity,
  extractMechanicalTokens,
  loadRulePack,
  parseGlossaryCsv,
  parseJsonLines,
  parseMetadataYaml,
  validateRulePack,
} from '../../../../server/rule-pack.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const RULESETS = ['srd_5_2_1', 'dnd_5e_2014']

function packJson(pack) {
  const { directory, ...rest } = pack
  return JSON.parse(JSON.stringify(rest))
}

const packs = {}
for (const id of RULESETS) packs[id] = packJson(await loadRulePack(id))

function outcome(run) {
  try {
    return { ok: run() }
  } catch (error) {
    return { error: error.message, ...(error.details && Object.keys(error.details).length ? { details: JSON.parse(JSON.stringify(error.details)) } : {}) }
  }
}

// --- токены механических чисел -------------------------------------------
const tokenTexts = [
  'Roll 2d6 + 3, compare DC 10, then apply 1/2 or 50%.',
  'Бросьте 2d8 − 1 и 1d4–2; урон ×2, дальность 1,5 м.',
  'Speed 30 ft., +5 to hit, -2 penalty, 3x damage, 2 × 4',
  'd20 D20 d 20 + 1 1d20+5 10d10-10 1 / 3 12.5% 0.5 x',
  'abc5 5abc _5 5_ ５ ５０％ ⅓ 2²',
  'СЛ 15, 1к6, 2 к 8 — не кости; 3—4 через тире',
  '',
  'nothing numeric here',
  '1,000 gold and 1,5,7 items',
  '+-3 -+4 ++5 --6',
]
for (const pack of Object.values(packs)) {
  for (const rule of pack.rules) {
    tokenTexts.push(`${rule.title_en}\n${rule.text_en}`, `${rule.title_ru}\n${rule.text_ru}`)
  }
}
const tokens = tokenTexts.map((text) => ({ text, tokens: extractMechanicalTokens(text) }))

const integrity = [
  ['Roll 2d6 + 3 and compare the total with DC 10.', 'Бросьте 2d6 + 3 и сравните итог со СЛ 10.'],
  ['Roll 2d6 + 3 and compare the total with DC 10.', 'Бросьте 2d8 + 3 и сравните итог со СЛ 10.'],
  ['1 1 2 3', '1 2 2 4'],
  ['', '5'],
  ['50% 1/2', '1/2 50 %'],
].map(([source, translated]) => ({ source, translated, check: checkTranslationNumericIntegrity(source, translated) }))

// --- разбор метаданных, глоссария, JSONL ------------------------------------
const yamlCases = [
  'ruleset_id: demo\nlanguages:\n  - ru\n  - en\ncount: 2\n',
  'root:\n  nested: value\n',
  '\uFEFFa: 1\r\nb: "two"\r\n# comment\n\n  # indented comment\nc:\n  - 1\n  - true\n  - ~\n  - \'it\'\'s\'\n',
  'a: 1\na: 2\n',
  '  - orphan\n',
  'key without colon\n',
  'x: "bad\\q"\n',
  'x: -0.25\ny: 007\nz: 1.\nw: .5\nv: 1e3\nu: "\\u00e9"\n',
  'list:\nnext: 1\n  - late\n',
  'a:b\nc:\td\ne: \t \n',
  'k: value # not a comment\nl: \'unterminated\nm: "q"x\n',
  '\tindented: 1\n',
  'a: 1\n\u00a0b: 2\n',
  'items:\n\t- tab\n',
  'items:\n  -  \n  -   \n',
  'r: a\rb\n',
]
const yaml = yamlCases.map((source) => ({ source, result: outcome(() => parseMetadataYaml(source, 'case.yaml')) }))

const header = 'canonical_id,term_en,term_ru,aliases_ru,notes\n'
const csvCases = [
  `${header}term:test,check,проверка,"чек|тест",note\n`,
  `${header}a,b,c,,\n\n,,,,\n"x,y",z,"q""uote",|a| |b|,\r\n`,
  '',
  'canonical_id,term_en\n',
  `${header}a,b\n`,
  `${header}a,b"c,d,e,f\n`,
  `${header}"a,b,c,d,e\n`,
  `\uFEFF ${header.trim()} \nx,y,z,w,v`,
  `${header}a,b,c,"d\ne",f\n`,
  `${header}"a"b,c,d,e,f\n`,
]
const csv = csvCases.map((source) => ({ source, result: outcome(() => parseGlossaryCsv(source, 'case.csv')) }))

const jsonlCases = [
  '{"a":1}\n\n  {"b":[1,2]}  \r\n',
  '\uFEFF{"x":"y"}',
  '{"a":1}\n[1]\n',
  '{"a":1}\n"text"\n',
  '{"a":1}\nnull\n',
  '{"a":1,"a":2,"b":{"c":1.5}}\n',
]
const jsonl = jsonlCases.map((source) => ({ source, result: outcome(() => parseJsonLines(source, 'case.jsonl')) }))

// --- правки пакетов -------------------------------------------------------
const VALUES = ['', ' ', 5, null, [], {}, 'xx', true, ['ru'], ['ru', 'en', ''], ['en', 'ru']]
const mutations = []
const add = (pack, patch, expected = pack) => mutations.push({ pack, patch, expected })

for (const pack of RULESETS) {
  add(pack, [])
  add(pack, [], null)
  add(pack, [], 'other_edition')
  add(pack, [], '')
  for (const value of [null, 5, [], 'x', {}]) add(pack, [{ op: 'set', path: ['manifest'], value }])
  add(pack, [{ op: 'delete', path: ['manifest'] }])
  for (const field of ['ruleset_id', 'pack_id', 'edition_family', 'version', 'canonical_language', 'license_id', 'created_at', 'verified_at', 'display_languages', 'source_registry']) {
    add(pack, [{ op: 'delete', path: ['manifest', field] }])
    for (const value of VALUES) add(pack, [{ op: 'set', path: ['manifest', field], value }])
  }
  for (const value of ['../x', 'UPPER_ok', 'a'.repeat(81), 'ſrd', 'srd 5']) add(pack, [{ op: 'set', path: ['manifest', 'ruleset_id'], value }])
  for (const value of ['Sources.JSON', 'sources.yaml', '../sources.json', 'a.json']) add(pack, [{ op: 'set', path: ['manifest', 'source_registry'], value }])
  for (const value of [{}, { schema_version: 1 }, 'x', 0]) add(pack, [{ op: 'set', path: ['sourceRegistry'], value }])
  add(pack, [{ op: 'delete', path: ['sourceRegistry'] }])

  const rules = packs[pack].rules
  for (const field of Object.keys(rules[0])) {
    add(pack, [{ op: 'delete', path: ['rules', 0, field] }])
    for (const value of [null, '', 5, [], ['x'], [''], 'x']) add(pack, [{ op: 'set', path: ['rules', 3, field], value }])
  }
  add(pack, [{ op: 'set', path: ['rules', 2, 'id'], value: rules[1].id }])
  add(pack, [{ op: 'set', path: ['rules', 0, 'id'], value: 'other:x' }])
  add(pack, [{ op: 'set', path: ['rules', 0, 'id'], value: `${pack}x:y` }])
  add(pack, [{ op: 'set', path: ['rules', 0, 'ruleset_id'], value: 'other_edition' }])
  for (const value of [-1, 1.5, '0', 3]) add(pack, [{ op: 'set', path: ['rules', 1, 'source_page_start'], value }])
  add(pack, [{ op: 'set', path: ['rules', 1, 'source_page_start'], value: 3 }, { op: 'set', path: ['rules', 1, 'source_page_end'], value: 2 }])
  add(pack, [{ op: 'set', path: ['rules', 1, 'source_page_start'], value: 3 }, { op: 'set', path: ['rules', 1, 'source_page_end'], value: 3 }])
  for (let index = 0; index < rules.length; index += 4) {
    add(pack, [{ op: 'set', path: ['rules', index, 'text_ru'], value: `${rules[index].text_ru} 9999` }])
    add(pack, [{ op: 'set', path: ['rules', index, 'text_en'], value: rules[index].text_en.replace(/\d/u, '7') }])
    add(pack, [{ op: 'set', path: ['rules', index, 'title_en'], value: `${rules[index].title_en} 2d6` }])
  }
  for (const value of [null, 'x', [], {}]) add(pack, [{ op: 'set', path: ['rules'], value }])
  add(pack, [{ op: 'set', path: ['rules', 0], value: 'string rule' }])
  add(pack, [{ op: 'set', path: ['rules', 0], value: [] }])

  for (const field of ['canonical_id', 'term_en', 'term_ru', 'aliases_ru']) {
    add(pack, [{ op: 'delete', path: ['glossary', 1, field] }])
    for (const value of [null, '', ['ok', ' '], 5]) add(pack, [{ op: 'set', path: ['glossary', 2, field], value }])
  }
  add(pack, [{ op: 'set', path: ['glossary', 3, 'canonical_id'], value: packs[pack].glossary[0].canonical_id }])
  for (const value of [null, {}, 'x']) add(pack, [{ op: 'set', path: ['glossary'], value }])
  add(pack, [{ op: 'set', path: ['glossary', 0], value: 5 }])

  for (const [field, values] of [
    ['ruleset_id', ['other_edition', null]],
    ['from_id', ['missing', 5]],
    ['to_id', ['missing', null]],
    ['relation', ['', 5, null]],
    ['weight', [0, 1.5, '0.5', null, 1, -0.1, 0.0001]],
  ]) {
    add(pack, [{ op: 'delete', path: ['ontologyEdges', 0, field] }])
    for (const value of values) add(pack, [{ op: 'set', path: ['ontologyEdges', 1, field], value }])
  }
  for (const value of [null, {}, 'x']) add(pack, [{ op: 'set', path: ['ontologyEdges'], value }])

  for (const value of [null, 5, 'x', []]) add(pack, [{ op: 'set', path: ['coverage'], value }])
  for (const field of ['ruleset_id', 'rule_count', 'glossary_term_count', 'ontology_edge_count']) {
    add(pack, [{ op: 'delete', path: ['coverage', field] }])
    for (const value of ['other', 0, '23', 1e3]) add(pack, [{ op: 'set', path: ['coverage', field], value }])
  }
}
// Реестр источников есть только у пакета 2014.
const registry = packs.dnd_5e_2014.sourceRegistry
for (const value of [2, '1', null]) add('dnd_5e_2014', [{ op: 'set', path: ['sourceRegistry', 'schema_version'], value }])
for (const value of ['other', null, '']) add('dnd_5e_2014', [{ op: 'set', path: ['sourceRegistry', 'ruleset_id'], value }])
for (const value of [[], null, 'x', {}]) add('dnd_5e_2014', [{ op: 'set', path: ['sourceRegistry', 'sources'], value }])
for (const field of ['id', 'title', 'url', 'edition_family', 'revision_id', 'accessed_at', 'rights_status', 'bundled']) {
  add('dnd_5e_2014', [{ op: 'delete', path: ['sourceRegistry', 'sources', 0, field] }])
  for (const value of ['', 'http://x', 5, false, null]) add('dnd_5e_2014', [{ op: 'set', path: ['sourceRegistry', 'sources', 1, field], value }])
}
add('dnd_5e_2014', [{ op: 'set', path: ['sourceRegistry', 'sources', 2, 'id'], value: registry.sources[0].id }])
add('dnd_5e_2014', [{ op: 'set', path: ['sourceRegistry', 'sources', 0], value: 'x' }])
add('dnd_5e_2014', [{ op: 'set', path: ['rules', 0, 'source_ref'], value: 'dndsu-2014-unknown' }])
add('dnd_5e_2014', [{ op: 'set', path: ['rules', 0, 'source_hash'], value: 'another-revision' }])
add('dnd_5e_2014', [{ op: 'delete', path: ['rules', 0, 'source_ref'] }])
add('dnd_5e_2014', [{ op: 'set', path: ['rules', 0, 'source_ref'], value: 5 }])
add('dnd_5e_2014', [{ op: 'delete', path: ['manifest', 'source_registry'] }])
add('srd_5_2_1', [{ op: 'set', path: ['manifest', 'source_registry'], value: 'sources.json' }, { op: 'set', path: ['sourceRegistry'], value: registry }])

function applyPatch(base, patch) {
  const pack = structuredClone(base)
  let root = { pack }
  for (const step of patch) {
    let target = root
    const path = ['pack', ...step.path]
    for (const key of path.slice(0, -1)) target = target[key]
    const last = path.at(-1)
    if (step.op === 'delete') delete target[last]
    else target[last] = structuredClone(step.value)
  }
  return root.pack
}

const validation = mutations.map((mutation) => {
  const pack = applyPatch(packs[mutation.pack], mutation.patch)
  return { ...mutation, result: outcome(() => validateRulePack(pack, { expectedRulesetId: mutation.expected ?? undefined })) }
})
validation.push({ pack: null, patch: [], expected: null, value: null, result: outcome(() => validateRulePack(null)) })
validation.push({ pack: null, patch: [], expected: null, value: 5, result: outcome(() => validateRulePack(5)) })
validation.push({ pack: null, patch: [], expected: null, value: [], result: outcome(() => validateRulePack([])) })

// --- загрузчик ------------------------------------------------------------
const loads = []
for (const id of ['../srd_5_2_1', '', 'not_installed_ruleset', 'a'.repeat(81), 'srd_5_2_1', 'dnd_5e_2014', 'bad id', 'ok.id']) {
  try {
    const pack = await loadRulePack(id)
    loads.push({ id, summary: pack.summary })
  } catch (error) {
    loads.push({ id, error: error.message.split(':').slice(0, 1).join(':') })
  }
}

const fixture = { packs, tokens, integrity, yaml, csv, jsonl, validation, loads }
writeFileSync(here('rule-pack.json'), `${JSON.stringify(fixture, null, 1)}\n`)
console.log(`rule-pack.json: ${tokens.length} текстов, ${yaml.length + csv.length + jsonl.length} разборов, ${validation.length} правок, ${loads.length} загрузок`)
