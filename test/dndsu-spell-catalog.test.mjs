import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { auditDndsuSpellCatalog, EXPECTED_SPELL_COUNT } from '../tools/verify-dndsu-spell-catalog.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const dictionary = JSON.parse(readFileSync(new URL('../data/spell-descriptions-ru.json', import.meta.url), 'utf8'))

const CURRENT_GEOMETRY_GAPS = new Set([
  'thunderclap', 'word-of-radiance', 'hail-of-thorns', 'earth-tremor',
  'arms-of-hadar', 'flaming-sphere', 'heat-metal',
  'melf-s-minute-meteors', 'lightning-arrow',
  'wind-wall', 'mordenkainen-s-faithful-hound',
  'wall-of-fire', 'guardian-of-faith', 'destructive-wave',
  'holy-weapon', 'wall-of-thorns',
])

test('все 439 карточек имеют единый структурный контракт и ID полного прохода', () => {
  const report = auditDndsuSpellCatalog({ catalog, dictionary })
  assert.equal(report.ok, true, JSON.stringify(report.problems))
  assert.equal(report.total, EXPECTED_SPELL_COUNT)
  assert.equal(report.uniqueIds, EXPECTED_SPELL_COUNT)
  assert.ok(Object.values(report.fieldCounts).every((count) => count === EXPECTED_SPELL_COUNT))
  assert.deepEqual(new Set(report.semanticGaps.map((entry) => entry.id)), CURRENT_GEOMETRY_GAPS)
  assert.equal(report.semanticGapCounts.AREA_GEOMETRY_UNREPRESENTED, CURRENT_GEOMETRY_GAPS.size)
  assert.deepEqual(report.effectiveSemanticGaps.map((entry) => entry.id), ['guardian-of-faith'])
  assert.equal(report.effectiveSemanticComplete, false)
  assert.equal(report.provenance.perCardRevision, 'present')
  assert.equal(report.provenance.unversionedSourceIds.length, 0)
})

test('аудит не принимает потерю источника, компонентов, словаря или уровня ячейки', () => {
  const changed = structuredClone(catalog)
  const spell = changed.spells[0]
  delete spell.sourceUrl
  delete spell.components
  spell.slotResource = 'spell_slots_1'
  spell.level = 0
  const report = auditDndsuSpellCatalog({ catalog: changed, dictionary })
  const codes = new Set(report.problems.map((problem) => problem.code))
  assert.ok(codes.has('FIELD_MISSING'))
  assert.ok(codes.has('COMPONENTS_MISSING'))
  assert.ok(codes.has('INVALID_SLOT_RESOURCE'))
  assert.ok(codes.has('INVALID_SOURCE_URL'))
})

test('аудит не позволяет расхождению словаря скрыться под корректным каталогом', () => {
  const changed = structuredClone(dictionary)
  changed.descriptions['acid-splash'] = 'Короткий текст'
  const report = auditDndsuSpellCatalog({ catalog, dictionary: changed })
  assert.ok(report.problems.some((problem) => problem.code === 'DESCRIPTION_DRIFT' && problem.id === 'acid-splash'))
})

test('читательские поля не смешиваются с серверным каталогом', () => {
  const changedCatalog = structuredClone(catalog)
  changedCatalog.spells[0].details = 'Подробный текст не должен попасть в серверную карточку.'
  const changedDictionary = structuredClone(dictionary)
  changedDictionary.details = Object.fromEntries(catalog.spells.map((spell) => [spell.id, 'Подробный текст заклинания.']))
  changedDictionary.higherLevels = Object.fromEntries(catalog.spells.map((spell) => [spell.id, spell.higherLevels ?? null]))
  const report = auditDndsuSpellCatalog({ catalog: changedCatalog, dictionary: changedDictionary })
  assert.ok(report.problems.some((problem) => problem.code === 'DETAILS_IN_SERVER_CATALOG' && problem.id === catalog.spells[0].id))
})
