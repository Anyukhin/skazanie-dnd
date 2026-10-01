// Сторож онтологии памяти мира: предикаты и отношения, которые пишут и читают
// модули server/*.mjs, обязаны быть описаны в server/world-ontology.mjs, а
// каждый читаемый предикат — иметь производителя. Именно такой разрыв был у
// `discovery`: questProgressEvidenceFor его ждал, но никто не создавал.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  auditOntology,
  EXTERNAL_ONLY_PREDICATES,
  GENERIC_PREDICATE_CONSUMERS,
  PREDICATES,
  RELATIONS,
  scanOntologyUsage,
} from '../server/world-ontology.mjs'

const serverDir = resolve(import.meta.dirname, '..', 'server')
const files = readdirSync(serverDir)
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => ({ file: name.replace(/\.mjs$/u, ''), source: readFileSync(join(serverDir, name), 'utf8') }))
const audit = auditOntology(files)

const registeredPredicate = (name) => Object.hasOwn(PREDICATES, name)

test('каждый предикат, который пишет код сервера, описан в реестре', () => {
  const produced = Object.entries(audit.predicates).filter(([, entry]) => entry.producers.length)
  assert.ok(produced.length >= 20, `сканер нашёл подозрительно мало предикатов: ${produced.length}`)
  const missing = produced.filter(([name]) => !registeredPredicate(name)).map(([name, entry]) => `${name} (${entry.sites.join(', ')})`)
  assert.deepEqual(missing, [], 'новый предикат нужно описать в server/world-ontology.mjs')
  for (const [name, entry] of produced) {
    assert.equal(PREDICATES[name].family === true, entry.family, `${name}: семейство с суффиксом описывается ключом с двоеточием`)
    assert.deepEqual([PREDICATES[name].record], entry.record, `${name}: факт или утверждение`)
  }
})

test('каждое отношение, которое пишет код сервера, описано в реестре', () => {
  const missing = Object.keys(audit.relations).filter((name) => !Object.hasOwn(RELATIONS, name))
  assert.deepEqual(missing, [])
})

test('у каждого читаемого предиката есть производитель в коде, кроме закрытого списка внешних', () => {
  const consumed = Object.entries(audit.predicates).filter(([, entry]) => entry.consumers.length)
  assert.ok(consumed.some(([name]) => name === 'died'), 'сканер обязан видеть чтение died')
  const orphan = consumed.filter(([name, entry]) => !entry.producers.length && !EXTERNAL_ONLY_PREDICATES.includes(name))
    .map(([name, entry]) => `${name} (${entry.sites.join(', ')})`)
  assert.deepEqual(orphan, [], 'предикат читается, но его никто не пишет')
  // Внешний список закрыт: в нём ровно то, у чего в реестре нет производителя в коде.
  const declaredExternal = Object.entries(PREDICATES).filter(([, entry]) => !entry.producers.length).map(([name]) => name).sort()
  assert.deepEqual(declaredExternal, [...EXTERNAL_ONLY_PREDICATES].sort())
  for (const name of EXTERNAL_ONLY_PREDICATES) {
    assert.ok(PREDICATES[name].external_producers?.length, `${name}: внешний производитель должен быть назван`)
    assert.ok(PREDICATES[name].consumers.length, `${name}: внешний предикат без читателя не нужен в списке`)
  }
})

test('производители и читатели в реестре совпадают с кодом (описание не устарело)', () => {
  const stale = []
  for (const [name, entry] of Object.entries(PREDICATES)) {
    const scanned = audit.predicates[name] ?? { producers: [], consumers: [] }
    if (JSON.stringify([...entry.producers].sort()) !== JSON.stringify(scanned.producers)) stale.push(`${name}.producers: реестр ${entry.producers} / код ${scanned.producers}`)
    if (JSON.stringify([...entry.consumers].sort()) !== JSON.stringify(scanned.consumers)) stale.push(`${name}.consumers: реестр ${entry.consumers} / код ${scanned.consumers}`)
    for (const module of [...entry.producers, ...entry.consumers]) {
      const source = files.find((candidate) => candidate.file === module)?.source
      assert.ok(source, `${name}: модуль ${module} не существует`)
      const needle = entry.family ? `${name}\${` : `'${name}'`
      assert.ok(source.includes(needle), `${name}: в ${module}.mjs нет литерала ${needle}`)
    }
  }
  for (const [name, entry] of Object.entries(RELATIONS)) {
    const scanned = audit.relations[name] ?? { producers: [], consumers: [] }
    if (JSON.stringify([...entry.producers].sort()) !== JSON.stringify(scanned.producers)) stale.push(`relation ${name}.producers`)
  }
  assert.deepEqual(stale, [])
})

test('общие читатели действительно читают предикат как есть', () => {
  for (const module of Object.keys(GENERIC_PREDICATE_CONSUMERS)) {
    const source = files.find((candidate) => candidate.file === module)?.source
    assert.ok(source, `${module}.mjs не найден`)
    assert.match(source, /\.predicate\b/u, `${module}.mjs не обращается к .predicate`)
  }
})

test('сканер ловит разрыв discovery: читатель есть, производителя нет', () => {
  const consumer = {
    file: 'world-memory',
    source: [
      "const QUEST_PROGRESS_PREDICATES = new Set(['discovery', 'quest_progress'])",
      'const facts = memory.facts.filter((fact) => QUEST_PROGRESS_PREDICATES.has(fact.predicate))',
    ].join('\n'),
  }
  const producer = {
    file: 'free-action',
    source: [
      "commands.push({ command_type: 'RecordWorldFact', fact: {",
      "  id: 'x', subject_id: 'npc', predicate: 'discovery', object: 'clue',",
      '} })',
    ].join('\n'),
  }
  const before = auditOntology([consumer])
  assert.deepEqual(before.gaps.consumed_but_never_produced.predicates, ['discovery', 'quest_progress'])
  const after = auditOntology([consumer, producer])
  assert.deepEqual(after.gaps.consumed_but_never_produced.predicates, ['quest_progress'])
})

test('сканер различает запись, образец сравнения, тернарник, семейство и утверждение', () => {
  const scan = scanOntologyUsage('sample', [
    "const requiredFact = event.event_type === 'NpcDied' ? { subject_id: id, predicate: 'died' } : null",
    "const blessing = { predicate: source === 'priest' ? 'blessed_by_priest' : 'blessed_at_shrine' }",
    "commands.push({ command_type: 'RecordRumor', claim: {",
    '  predicate: `party_deed:${kind}`,',
    '} })',
    "if (String(event.payload?.fact?.predicate ?? '') === 'died') return",
    "const known = (fact) => fact.predicate.startsWith('faction_offscreen_move:')",
    'const copy = { predicate: template.predicate }',
    "const ignored = traceStore.latest(id, { predicate: isMechanicalTrace })",
  ].join('\n'))
  assert.deepEqual(scan.produced.predicates.map((entry) => [entry.name, entry.record]), [
    ['blessed_by_priest', 'fact'], ['blessed_at_shrine', 'fact'], ['party_deed:', 'claim'],
  ])
  assert.deepEqual(scan.consumed.predicates.map((entry) => entry.name), ['died', 'died', 'faction_offscreen_move:'])
  assert.deepEqual(scan.dynamic.produced.map((entry) => entry.kind), ['passthrough'])
})

test('отношение считается записью памяти только рядом с from_entity_id', () => {
  const scan = scanOntologyUsage('sample', [
    "return { hazard_id: hazardId, relation: 'contact' }",
    '',
    '',
    '',
    '',
    '',
    "relationship: { id: 'r1', from_entity_id: 'a', relation: 'serves', to_entity_id: 'b' }",
  ].join('\n'))
  assert.deepEqual(scan.produced.relations.map((entry) => entry.name), ['serves'])
})
