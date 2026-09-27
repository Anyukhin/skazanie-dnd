import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { auditSourceRows, auditSourceSemanticFields, mergeSourceAuditRows, normalizeSourceSchool, sourceBookTitleFromRow } from '../tools/audit-dndsu-spell-sources.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const spell = catalog.spells[0]

function observedRow(overrides = {}) {
  return {
    id: spell.id,
    sourceUrl: spell.sourceUrl,
    fetchedAt: '2026-09-19T00:22:30.203Z',
    status: 'observed',
    sourceHashFnv1a64: '978ca2d9fa66d4bb',
    sourceTitle: `${spell.name} / Заклинания D&D 5 / Player's Handbook`,
    sourceFacts: {
      level: spell.level,
      school: normalizeSourceSchool(spell.school),
      castingTime: spell.castingTime,
      rangeText: spell.rangeText,
      duration: spell.duration,
      classes: 'волшебник, чародей',
      descriptionText: 'Короткое временное содержимое source cache.',
    },
    ...overrides,
  }
}

test('кэш source-аудита проверяет каждый ID и source metadata без вывода полного текста', () => {
  const report = auditSourceRows({ rows: [observedRow()], manifest: { total: 1 }, catalog: { spells: [spell] } })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.total, 1)
  assert.deepEqual(report.factsMissing, [])
  assert.deepEqual(report.metadataMismatches, [])
  assert.deepEqual(report.sourceObservationGaps, [])
  assert.deepEqual(report.optionalFactsMissing, [{ id: spell.id, fields: ['sourceBooks'] }])
  assert.deepEqual(report.sourceBookTitleMissing, [])
  assert.equal(sourceBookTitleFromRow(observedRow()), "Player's Handbook")
})

test('source-аудит сообщает ID с неполными фактами и расхождением карточки', () => {
  const row = observedRow({ sourceFacts: { level: spell.level, school: 'другая школа' } })
  const report = auditSourceRows({ rows: [row], manifest: { total: 1 }, catalog: { spells: [spell] } })
  assert.equal(report.ok, false)
  assert.ok(report.factsMissing[0].fields.includes('castingTime'))
  assert.ok(report.factsMissing[0].fields.includes('descriptionText'))
  assert.ok(report.metadataMismatches.some((entry) => entry.field === 'school'))
})

test('canonical retry заменяет только запись того же ID и сохраняет остальные строки', () => {
  const second = { ...observedRow(), id: 'other', sourceUrl: 'https://www.dnd.su/spells/999-other/' }
  const merged = mergeSourceAuditRows([observedRow(), second], [{ ...observedRow({ status: 'observed' }), fetchedAt: '2026-09-20T00:00:00.000Z' }])
  assert.equal(merged.length, 2)
  assert.equal(merged.find((row) => row.id === spell.id).fetchedAt, '2026-09-20T00:00:00.000Z')
  assert.equal(merged.find((row) => row.id === 'other').id, 'other')
})

test('semantic source-аудит находит пропущенное повышение уровня по source facts, не копируя текст', () => {
  const row = observedRow({ sourceFacts: {
    ...observedRow().sourceFacts,
    descriptionText: 'На больших уровнях. При использовании ячейки 2-го уровня урон увеличивается на 1к6.',
  } })
  const report = auditSourceSemanticFields({ rows: [row], catalog: { spells: [spell] }, descriptions: { [spell.id]: 'Существо получает 1к6 урона.' } })
  assert.deepEqual(report.counts, { HIGHER_LEVEL_SUMMARY_MISSING: 1 })
  assert.deepEqual(report.gaps, [{ id: spell.id, code: 'HIGHER_LEVEL_SUMMARY_MISSING', fields: ['higherLevels'] }])
})

test('semantic source-аудит не теряет trigger реакции и duration metadata', () => {
  const reactionRow = observedRow({ sourceFacts: {
    ...observedRow().sourceFacts,
    castingTime: '1 реакция, когда цель получает урон',
    duration: '1 минута',
  } })
  const changed = { ...spell, castingTime: '1 действие', duration: null }
  const report = auditSourceSemanticFields({ rows: [reactionRow], catalog: { spells: [changed] }, descriptions: { [spell.id]: changed.description } })
  assert.deepEqual(new Set(report.gaps.map((entry) => entry.code)), new Set(['REACTION_TRIGGER_MISSING', 'DURATION_METADATA_MISSING']))
})
