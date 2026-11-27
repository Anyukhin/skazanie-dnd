// Эталон `server/world-ontology.mjs` для sk-society: `node gen-world-ontology.mjs`.
//
// Реестр предикатов целиком; разбор каждого модуля `server/*.mjs` с хешем его
// текста (тест Rust сверяет только модули, чей текст не изменился с момента
// снятия эталона); полный аудит; и синтетические строки из обрывков записи,
// сравнения, тернарников и семейств — чтобы сканер проверялся и там, где в
// исходниках сервера примеров нет.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { collector, rng, write } from './lib.mjs'

const ontology = await import(new URL('../../../../server/world-ontology.mjs', import.meta.url).href)
const serverDir = fileURLToPath(new URL('../../../../server/', import.meta.url))
const random = rng(1717)
const c = collector()

const files = readdirSync(serverDir)
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => ({ file: name.replace(/\.mjs$/u, ''), source: readFileSync(`${serverDir}${name}`, 'utf8') }))

const sources = files.map(({ file, source }) => ({
  file,
  sha256: createHash('sha256').update(source).digest('hex'),
  scan: ontology.scanOntologyUsage(file, source),
}))

const constants = {
  PREDICATES: ontology.PREDICATES,
  RELATIONS: ontology.RELATIONS,
  GENERIC_PREDICATE_CONSUMERS: ontology.GENERIC_PREDICATE_CONSUMERS,
  EXTERNAL_ONLY_PREDICATES: ontology.EXTERNAL_ONLY_PREDICATES,
}

const audit = ontology.auditOntology(files)

const FRAGMENTS = [
  "predicate: 'died'", 'predicate: "discovery"', 'predicate: `party_deed:${kind}`', "predicate: cond ? 'blessed_by_priest' : 'blessed_at_shrine'",
  'predicate: template.predicate', 'predicate: dynamicValue', 'predicate,', '  predicate,  ', "relation: 'serves'", 'from_entity_id: a', "relation: 'contact'",
  "if (fact.predicate === 'died')", "fact.predicate !== 'noise'", "String(event.payload?.fact?.predicate ?? '') === 'died'", "'died' === fact.predicate",
  "fact.predicate.startsWith('faction_offscreen_move:')", "fact.predicate?.startsWith('party_deed:')", 'QUEST_PREDICATES.has(fact.predicate)', 'UNKNOWN_SET.has(fact.predicate)',
  "['died', 'gm_secret'].includes(fact.predicate)", '/^band_/u.test(fact.predicate)', 'fact.predicate === other', "requiredFact = { predicate: 'died' }",
  "const match = { predicate: 'gm_secret' }", "commands.push({ command_type: 'RecordRumor', claim: {", "commands.push({ command_type: 'RecordWorldFact', fact: {",
  'traceStore.find({ predicate: isTrace })', '{ predicate: isMechanical }', '// predicate: commented', '* predicate: doc', '/* predicate: block */',
  "const QUEST_PREDICATES = new Set(['discovery', 'quest_progress'])", "const OTHER = Object.freeze(new Set(['died']))", 'relation.to_entity_id',
  "predicate: 'Mixed_Case'", "predicate: 'ok', relation: 'x'", "x.predicate == 'loose'", 'обычная строка без предикатов', '}', '{', '',
  "predicate : 'spaced'", "subject.predicate: 'dotted'", "my_predicate: 'prefixed'", "fact.relation === 'serves'", "\tpredicate: 'tab'",
]

for (let index = 0; index < 400; index += 1) {
  const lines = Array.from({ length: random.int(1, 14) }, () => {
    const parts = Array.from({ length: random.int(1, 3) }, () => random.pick(FRAGMENTS))
    return `${' '.repeat(random.int(0, 4))}${parts.join(random.pick([' ', ', ', ' && ', '; ']))}`
  })
  const source = lines.join(random.pick(['\n', '\r\n']))
  const file = random.pick(['sample', 'world-memory', 'trace-store', 'rules-engine'])
  c.call('scanOntologyUsage', ontology.scanOntologyUsage, [file, source])
  if (index % 4 === 0) {
    const other = { file: random.pick(['free-action', 'captives']), source: lines.slice().reverse().join('\n') }
    c.call('auditOntology', ontology.auditOntology, [[{ file, source }, other]])
  }
}

// Проверка записи (#189): статья словаря по имени предиката и нарушение записи
// для каждого вида записи и подлежащего, включая семейства, голое имя
// семейства, ключи прототипа и пустой вид.
const names = Object.keys(ontology.PREDICATES)
const PROBES = [
  ...names, ...names.filter((name) => name.endsWith(':')).flatMap((name) => [`${name}x`, `${name}кража`, `${name}a:b`]),
  'knows', '', ':', ':x', 'died:', 'died:twice', 'party_deed', 'party_deed:', 'Died', ' died', 'died ', 'constructor', '__proto__', 'toString',
  'hasOwnProperty:', 'constructor:x', 'событие', 'lore', 'quest_progress', 'faction_offscreen_move:raid',
]
for (const probe of [...PROBES, null, undefined, 5]) c.call('predicateEntryFor', ontology.predicateEntryFor, [probe])
const KINDS = ['npc', 'faction', 'location', 'item', 'event', 'concept', '', 'person']
for (const record of ['fact', 'claim', 'other']) {
  for (const probe of PROBES) {
    for (const subjectKind of KINDS) c.call('ontologyViolation', ontology.ontologyViolation, [{ record, predicate: probe, subjectKind }])
  }
  c.call('ontologyViolation', ontology.ontologyViolation, [{ record, predicate: 'died' }])
}

write('world-ontology.json', { generator: 'gen-world-ontology.mjs', constants, sources, audit, values: c.values, cases: c.cases, skipped: c.skipped })
