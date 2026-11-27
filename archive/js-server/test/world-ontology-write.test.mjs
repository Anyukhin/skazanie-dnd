// Онтология мира проверяет запись памяти: команда факта, убеждения или слуха
// проходит, только если её предикат есть в server/world-ontology.mjs для этого
// вида записи и подлежащего. Уже записанные события replay читает как есть.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { ontologyViolation, predicateEntryFor, PREDICATES } from '../server/world-ontology.mjs'

const diceService = new DiceService({ rng: new SequenceDiceRng([]) })

const initial = () => normalizeCampaignState({
  sessionCode: 'ONTOLOGY-WRITE',
  partyMemberIds: ['hero'],
  players: [{ id: 'hero', character: 'Hero', role: 'Воин', level: 1, hp: 10, maxHp: 10, abilities: { str: 14 }, inventory: [] }],
})

const entities = [
  { command_type: 'UpsertWorldEntity', entity: { id: 'npc:vela', kind: 'npc', name: 'Вела', visibility: 'party' } },
  { command_type: 'UpsertWorldEntity', entity: { id: 'location:mill', kind: 'location', name: 'Мельница', visibility: 'party' } },
]

const run = (commands, context = { isDirector: true }) => resolveCommands([...entities, ...commands], initial(), { diceService, context })

const fact = (predicate, subjectId = 'npc:vela') => ({ command_type: 'RecordWorldFact', fact: {
  id: `fact:${predicate}:${subjectId}`, subject_id: subjectId, predicate, object: 'location:mill', summary: 'Запись', visibility: 'party',
} })

const rumor = (predicate) => ({ command_type: 'RecordRumor', claim: {
  id: `rumor:${predicate || 'none'}`, holder_entity_id: 'npc:vela', predicate, claim: 'Говорят, отряд обокрал мельницу.', visibility: 'gm_only',
} })

test('статья словаря: точное имя, семейство с суффиксом, но не голое имя семейства', () => {
  assert.equal(predicateEntryFor('died'), PREDICATES.died)
  assert.equal(predicateEntryFor('party_deed'), PREDICATES.party_deed)
  assert.equal(predicateEntryFor('party_deed:theft'), PREDICATES['party_deed:'])
  assert.equal(predicateEntryFor('faction_offscreen_move:raid'), PREDICATES['faction_offscreen_move:'])
  assert.equal(predicateEntryFor('party_deed:'), null)
  assert.equal(predicateEntryFor('died:twice'), null)
  assert.equal(predicateEntryFor('knows'), null)
  assert.equal(ontologyViolation({ record: 'fact', predicate: 'died', subjectKind: 'npc' }), null)
})

test('факт с предикатом из словаря записывается и сходится при replay', () => {
  const result = run([fact('died')])
  assert.equal(result.events.at(-1).event_type, 'WorldFactRecorded')
  assert.equal(result.state.worldMemory.facts.at(-1).predicate, 'died')
  assert.deepEqual(replayEvents(initial(), result.events), result.state)
})

test('неизвестный предикат факта отклоняется до события', () => {
  assert.throws(() => run([fact('knows')]), { code: 'WORLD_PREDICATE_UNKNOWN' })
})

test('подлежащее не того вида отклоняется: погибнуть может только NPC', () => {
  assert.throws(() => run([fact('died', 'location:mill')]), { code: 'WORLD_PREDICATE_SUBJECT_KIND_INVALID' })
})

test('вид записи сверяется: слух не пишется фактом, факт — слухом', () => {
  assert.throws(() => run([fact('party_deed:theft')]), { code: 'WORLD_PREDICATE_RECORD_MISMATCH' })
  assert.throws(() => run([rumor('discovery')]), { code: 'WORLD_PREDICATE_RECORD_MISMATCH' })
})

test('слух семейства записывается; утверждение без предиката словарь не ограничивает', () => {
  const result = run([rumor('party_deed:theft'), rumor('')])
  assert.deepEqual(result.state.worldMemory.epistemic_claims.map((claim) => claim.predicate), ['party_deed:theft', ''])
  assert.deepEqual(replayEvents(initial(), result.events), result.state)
})

test('каждый вид подлежащего из словаря принимается записью', () => {
  for (const [name, entry] of Object.entries(PREDICATES)) {
    if (entry.record !== 'fact') continue
    const predicate = entry.family ? `${name}probe` : name
    for (const kind of entry.subject_kinds) {
      const subject = { command_type: 'UpsertWorldEntity', entity: { id: `${kind}:probe`, kind, name: 'Проба', visibility: 'party' } }
      assert.doesNotThrow(() => run([subject, fact(predicate, `${kind}:probe`)]), `${predicate} о сущности вида ${kind}`)
    }
  }
})

test('проверка не мешает правам: игрок не пишет память и с верным предикатом', () => {
  assert.throws(() => run([fact('died')], { isAdmin: false, actorId: 'hero' }), { code: 'WORLD_MEMORY_FORBIDDEN' })
})

test('replay принимает уже записанный факт с предикатом вне словаря', () => {
  const recorded = run([])
  const legacy = { event_type: 'WorldFactRecorded', event_id: 'event:legacy', command_id: 'command:legacy', visibility: 'party', payload: { fact: {
    id: 'fact:legacy', subject_id: 'npc:vela', predicate: 'knows', object: 'тайну мельницы', summary: 'Вела знает тайну мельницы.',
    visibility: 'party', source_event_ids: [], status: 'active',
  } } }
  const state = replayEvents(initial(), [...recorded.events, legacy])
  assert.equal(state.worldMemory.facts.at(-1).predicate, 'knows')
})
