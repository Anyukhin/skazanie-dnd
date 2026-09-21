import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { auditSpellAcceptance, readSpellAcceptanceBaseline, SPELL_ACCEPTANCE_DIMENSIONS, validateSpellAcceptanceReport } from '../server/spell-acceptance-audit.mjs'

const report = auditSpellAcceptance()
const issues = (value) => validateSpellAcceptanceReport(value).map((problem) => problem.code)

test('матрица поимённо покрывает рабочий каталог, сохраняя доступность отдельно от полной приёмки', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
  assert.equal(report.ok, true, JSON.stringify(report.problems))
  assert.equal(report.spells.length, 439)
  assert.deepEqual(report.spells.map((spell) => spell.spellId).sort(), catalog.spells.map((spell) => spell.id).sort())
  assert.equal(report.summary.accepted, 0)
  assert.equal(report.summary.specifications['pilot-draft'], 4)
  assert.equal(report.summary.specifications['inventory-only'], 435)
  for (const card of report.spells) {
    const runtime = canonicalCombatSpellFor(card.spellId, { rulesetId: 'dnd_5e_2014' })
    assert.equal(card.availability.supportStatus, runtime.mechanicsSupport)
    assert.equal(card.accepted, false)
    assert.equal(card.source.acceptedRevision, null)
    for (const dimension of SPELL_ACCEPTANCE_DIMENSIONS) assert.equal(card.readiness[dimension], 'pending')
    assert.ok(card.scenarios.every((scenario) => scenario.status === 'pending' && scenario.evidence.length === 0))
  }
})

test('исходные группы относятся к зафиксированному коммиту, а не к будущему состоянию карточек', () => {
  if (report.baseline.status === 'available') {
    assert.deepEqual(report.baseline.counts, { heuristic: 191, partial: 240, 'ruling-only': 8 })
    assert.deepEqual(report.summary.initialGroups, { blocked: 199, partial: 240 })
    assert.equal(report.spells.find((spell) => spell.spellId === 'longstrider').baseline.supportStatus, 'heuristic')
  } else {
    assert.ok(report.warnings.length)
    assert.ok(report.spells.every((spell) => spell.baseline.supportStatus === null))
  }
  const changed = structuredClone(report)
  changed.spells[0].availability = { supportStatus: 'partial', blocked: false, actorEligibilityChecked: false }
  assert.equal(changed.spells[0].baseline.supportStatus, report.spells[0].baseline.supportStatus)
  assert.equal(changed.spells[0].accepted, false)
})

test('экспорт без истории сохраняет инвентаризацию и явно не восстанавливает исходные статусы из текущих', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-spell-baseline-'))
  try {
    const baseline = readSpellAcceptanceBaseline(directory)
    assert.equal(baseline.status, 'unavailable')
    const exported = auditSpellAcceptance({ baseline })
    assert.equal(exported.ok, true)
    assert.equal(exported.spells.length, 439)
    assert.deepEqual(exported.summary.initialGroups, { unavailable: 439 })
    assert.ok(exported.warnings.length)
    assert.ok(exported.spells.every((spell) => spell.baseline.supportStatus === null))
    exported.spells[0].baseline = { supportStatus: 'partial', group: 'partial' }
    assert.ok(issues(exported).includes('UNPROVEN_BASELINE'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('схема отвергает дубликат, потерю ID, подмену группы и повышение готовности без доказательств', () => {
  const duplicate = structuredClone(report)
  duplicate.spells[1].spellId = duplicate.spells[0].spellId
  assert.ok(issues(duplicate).includes('INVALID_SPELL_ID'))
  const missing = structuredClone(report)
  missing.spells.pop()
  assert.ok(issues(missing).includes('CATALOG_SCOPE_MISMATCH'))
  const unknown = structuredClone(report)
  unknown.spells[0].spellId = 'not-in-the-catalog'
  assert.ok(issues(unknown).includes('UNKNOWN_SPELL_ID'))
  const unproved = structuredClone(report)
  unproved.spells[0].readiness.rules = 'verified'
  unproved.spells[0].accepted = true
  unproved.spells[0].scenarios[0].status = 'passed'
  unproved.spells[0].baseline.group = 'verified'
  const codes = issues(unproved)
  for (const code of ['READINESS_MISMATCH', 'UNPROVEN_ACCEPTANCE', 'UNPROVEN_SCENARIO', 'BASELINE_GROUP_MISMATCH', 'SUMMARY_MISMATCH']) assert.ok(codes.includes(code), code)
})

test('доказательство другого дерева и необъяснённая неприменимость не проходят проверку', () => {
  const changed = structuredClone(report)
  changed.spells[0].scenarios[0] = {
    ...changed.spells[0].scenarios[0], status: 'passed',
    evidence: [{ kind: 'test-run', reference: 'test/example.test.mjs', observedAt: '2026-09-21T10:00:00Z', treeSha256: '0'.repeat(64) }],
  }
  changed.spells[0].scenarios[1].status = 'not-applicable'
  assert.ok(issues(changed).includes('INVALID_EVIDENCE'))
  assert.ok(issues(changed).includes('MISSING_NOT_APPLICABLE_REASON'))
  assert.ok(issues(changed).includes('REQUIRED_SCENARIO_NOT_APPLICABLE'))
  changed.spells[0].scenarios = [null]
  assert.ok(issues(changed).includes('INVALID_SCENARIO'))
  assert.ok(issues(changed).includes('MISSING_REQUIRED_SCENARIO'))
})

test('обязательные ветки приёмки нельзя объявить неприменимыми даже с объяснением', () => {
  const changed = structuredClone(report)
  const card = changed.spells[0]
  for (const scenario of card.scenarios) Object.assign(scenario, { status: 'not-applicable', reason: 'Общий обработчик уже проверен.' })
  for (const dimension of SPELL_ACCEPTANCE_DIMENSIONS) card.readiness[dimension] = 'verified'
  card.accepted = true
  changed.summary.accepted = 1
  const codes = issues(changed)
  assert.ok(codes.includes('REQUIRED_SCENARIO_NOT_APPLICABLE'))
  assert.ok(codes.includes('UNPROVEN_ACCEPTANCE'))
})

test('сложные компоненты выводятся из карточек вместе с конкретными требованиями и зависимостями', () => {
  const unresolved = report.spells.filter((spell) => spell.componentRequirements?.material?.unresolved)
  assert.equal(unresolved.length, 13)
  assert.deepEqual(report.summary.components.unresolvedMaterialIds, unresolved.map((spell) => spell.spellId))
  assert.equal(report.componentGaps.unresolvedMaterial.length, 13)
  assert.deepEqual([...report.summary.components.royaltyIds].sort(), ['gift-of-gab', 'jims-glowing-coin', 'jims-magic-missile'])
  for (const spell of unresolved) assert.ok(spell.dependencies.items.includes('unresolved-material-requirement'))
  for (const id of report.summary.components.royaltyIds) {
    const spell = report.spells.find((candidate) => candidate.spellId === id)
    assert.ok(spell.dependencies.items.includes('royalty-payment'))
    assert.equal(spell.accepted, false)
  }
})

test('четыре пилота сохраняют индивидуальные выборы и сценарии; остальные паспорта явно требуют разбора', () => {
  const get = (id) => report.spells.find((spell) => spell.spellId === id)
  assert.ok(get('longstrider').scenarios.some((scenario) => scenario.id === 'hour-and-sources'))
  assert.ok(get('mass-cure-wounds').scenarios.some((scenario) => scenario.id === 'point-and-six-targets'))
  assert.ok(get('protection-from-energy').dependencies.items.includes('willing-target-policy'))
  assert.ok(get('destructive-wave').scenarios.some((scenario) => scenario.id === 'legal-level-twelve-path'))
  for (const spell of report.spells.filter((spell) => spell.specification.status === 'inventory-only')) {
    assert.equal(spell.specification.individuallyReviewed, false)
    assert.equal(spell.dependencies.status, 'candidates')
    assert.equal(spell.choices.status, 'unreviewed')
  }
})
