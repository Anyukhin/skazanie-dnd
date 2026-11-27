// Поиск по памяти мира с одним шагом по графу: вопрос называет сущность, а
// ответ лежит в записи о её соседе (по отношению или по общему поручению).
// Сторож трёх свойств: шаг находит соседа; скрытое ребро игроку шага не даёт;
// пустой ответ — только по явной просьбе, прежний контракт не сломан.
import assert from 'node:assert/strict'
import test from 'node:test'

import { knownWorldLore, retrieveKnownWorldMemory, retrieveWorldMemory } from '../server/world-memory.mjs'

const PLAYER = { playerId: 'hero', isPartyMember: true }
const GM = { isAdmin: true }

function memory() {
  const entity = (id, kind, name, visibility, aliases = []) => ({ id, kind, name, summary: '', aliases, visibility, tags: [] })
  const fact = (id, subject_id, summary, visibility = 'party') => ({
    id, subject_id, predicate: 'note', object: summary.slice(0, 40), summary, visibility,
    source_event_ids: [`event:${id}`], status: 'active', recorded_at_minutes: 0,
  })
  const relationship = (id, from_entity_id, relation, to_entity_id, visibility = 'party') => ({
    id, from_entity_id, relation, to_entity_id, summary: `${from_entity_id} ${relation} ${to_entity_id}`, visibility,
    source_event_ids: [`event:${id}`], status: 'active', recorded_at_minutes: 0,
  })
  return {
    schema_version: 2,
    entities: [
      entity('npc:grig', 'npc', 'Григ Одноглазый', 'party', ['Григ']),
      entity('faction:crows', 'faction', 'Братство Ворона', 'party'),
      entity('npc:lord', 'npc', 'лорд Воронов', 'public'),
      entity('npc:tom', 'npc', 'Том Рыбак', 'public', ['Том']),
      entity('location:caves', 'location', 'Пещеры Шёпота', 'party'),
      entity('location:inn', 'location', 'Таверна у моста', 'public'),
    ],
    facts: [
      fact('fact:grig-eye', 'npc:grig', 'Потерял глаз в поножовщине на причале.'),
      fact('fact:crows-wine', 'faction:crows', 'Возят контрабандное вино мимо таможни по ночам.'),
      fact('fact:lord-tax', 'npc:lord', 'Поднял пошлину на улов вдвое.', 'public'),
      fact('fact:caves-tracks', 'location:caves', 'У входа следы волочения и обрывок сети.'),
      fact('fact:inn-price', 'location:inn', 'Комната на ночь стоит серебряную монету.', 'public'),
      fact('fact:storm-rumor', 'location:inn', 'Жрец твердит, что буря была карой за жадность.', 'public'),
    ],
    relationships: [
      relationship('rel:grig-crows', 'npc:grig', 'member_of', 'faction:crows'),
      relationship('rel:grig-lord', 'npc:grig', 'secretly_serves', 'npc:lord', 'gm_only'),
    ],
    quests: [{
      id: 'quest:fishers', title: 'Пропавшие рыбаки', summary: 'Найти тех, кто не вернулся с промысла.',
      status: 'active', visibility: 'party', entity_ids: ['npc:tom', 'location:caves'], objectives: [],
      clock: { current: 0, max: 4, label: '' }, recorded_at_minutes: 0,
    }],
    threads: [], epistemic_claims: [], summaries: [], knowledge_ledger: [],
  }
}

const ids = (records) => records.map((record) => record.id)

test('один шаг по отношению: вопрос о Григе находит промысел его Братства', () => {
  const before = ids(retrieveWorldMemory(memory(), PLAYER, { query: 'Чем промышляет Григ?', limit: 5, neighbours: false }))
  assert.equal(before.includes('fact:crows-wine'), false, 'без шага по графу ответа нет — иначе тест ничего не доказывает')
  const after = ids(retrieveWorldMemory(memory(), PLAYER, { query: 'Чем промышляет Григ?', limit: 5 }))
  assert.ok(after.includes('fact:crows-wine'), after.join(', '))
  // Записи о самой названной сущности идут раньше записей о соседе.
  assert.ok(after.indexOf('fact:grig-eye') < after.indexOf('fact:crows-wine'))
})

test('скрытое от игрока ребро шага не даёт, а ведущему даёт', () => {
  const player = ids(retrieveWorldMemory(memory(), PLAYER, { query: 'Чем промышляет Григ?', limit: 10 }))
  assert.equal(player.includes('fact:lord-tax'), false, 'gm_only-связь Грига с лордом не должна приводить игрока к фактам лорда')
  assert.equal(player.includes('rel:grig-lord'), false)
  const gm = ids(retrieveWorldMemory(memory(), GM, { query: 'Чем промышляет Григ?', limit: 10 }))
  assert.ok(gm.includes('fact:lord-tax'), gm.join(', '))
})

test('совпавшее поручение передаёт силу своим сущностям', () => {
  const result = ids(retrieveWorldMemory(memory(), PLAYER, { query: 'новости по делу о пропавших рыбаках', limit: 5 }))
  assert.equal(result[0], 'quest:fishers')
  assert.ok(result.includes('fact:caves-tracks'), result.join(', '))
})

test('служебные слова вопроса не совпадают с записями', () => {
  const result = ids(retrieveWorldMemory(memory(), PLAYER, { query: 'что это?', limit: 5, whenUnmatched: 'none' }))
  // «что» и «это» — служебные; значимых слов нет, поэтому это пустой вопрос.
  assert.deepEqual(result, ids(retrieveWorldMemory(memory(), PLAYER, { query: '', limit: 5 })))
  const unknown = retrieveWorldMemory(memory(), PLAYER, { query: 'Что известно о драконах?', limit: 5, whenUnmatched: 'none' })
  assert.deepEqual(unknown, [], '«что» больше не находит слух о буре')
})

test('без совпадений: прежний контракт по умолчанию, пустой ответ по просьбе', () => {
  const fallback = retrieveWorldMemory(memory(), PLAYER, { query: 'боевой грифон', limit: 3 })
  assert.equal(fallback.length, 3)
  assert.deepEqual(ids(fallback), [...ids(fallback)].sort())
  assert.ok(fallback.every((record) => record.score === 0))
  assert.deepEqual(retrieveWorldMemory(memory(), PLAYER, { query: 'боевой грифон', limit: 3, whenUnmatched: 'none' }), [])
  assert.deepEqual(retrieveKnownWorldMemory(memory(), { viewer: PLAYER, query: 'боевой грифон' }), [])
  assert.deepEqual(knownWorldLore(memory(), 'боевой грифон', PLAYER), [])
})

test('порядок детерминирован, предел соблюдается, форма записи прежняя', () => {
  const first = retrieveWorldMemory(memory(), GM, { query: 'Григ Братство Ворона лорд', limit: 2 })
  const second = retrieveWorldMemory(memory(), GM, { query: 'Григ Братство Ворона лорд', limit: 2 })
  assert.deepEqual(first, second)
  assert.equal(first.length, 2)
  for (const record of first) {
    assert.deepEqual(Object.keys(record).filter((key) => ['anchors', 'hub', 'search', 'lexical', 'exact'].includes(key)), [])
    assert.equal(typeof record.score, 'number')
  }
})
