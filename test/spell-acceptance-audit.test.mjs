import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { auditSpellAcceptance, longstriderDependencyFingerprints, LONGSTRIDER_EVIDENCE_DEPENDENCIES, readLongstriderEvidence, readSpellAcceptanceBaseline, spellEvidenceTextSha256, SPELL_ACCEPTANCE_DIMENSIONS, validateSpellAcceptanceReport } from '../server/spell-acceptance-audit.mjs'

const report = auditSpellAcceptance({ longstriderEvidence: null })
const issues = (value) => validateSpellAcceptanceReport(value).map((problem) => problem.code)

test('отпечаток доказательства одинаков после Windows autocrlf и Linux checkout, но меняется вместе с содержимым', () => {
  const unix = 'const speed = 30\nconst bonus = 10\n'
  const windows = 'const speed = 30\r\nconst bonus = 10\r\n'
  assert.equal(spellEvidenceTextSha256(unix), spellEvidenceTextSha256(windows))
  assert.notEqual(spellEvidenceTextSha256(unix), spellEvidenceTextSha256('const speed = 30\nconst bonus = 20\n'))
  assert.ok(LONGSTRIDER_EVIDENCE_DEPENDENCIES.includes('test/longstrider-projection.test.mjs'))
  assert.ok(LONGSTRIDER_EVIDENCE_DEPENDENCIES.includes('test/rules-engine.test.mjs'))
})

test('матрица поимённо покрывает рабочий каталог, сохраняя доступность отдельно от полной приёмки', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
  assert.equal(report.ok, true, JSON.stringify(report.problems))
  assert.equal(report.spells.length, 439)
  assert.deepEqual(report.spells.map((spell) => spell.spellId).sort(), catalog.spells.map((spell) => spell.id).sort())
  assert.equal(report.summary.accepted, 0)
  assert.deepEqual(report.summary.support, { heuristic: 189, partial: 242, 'ruling-only': 8 })
  assert.equal(report.summary.blocked, 197)
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

function currentReceipt() {
  const card = report.spells.find((spell) => spell.spellId === 'longstrider')
  return {
    schemaVersion: 'spell-evidence/v1', spellId: 'longstrider', status: 'recorded',
    testedRevision: 'a'.repeat(40), observedAt: '2026-09-21T14:00:00.000Z',
    dependencyFingerprints: longstriderDependencyFingerprints(),
    runs: [{
      id: 'final-gate', kind: 'test-run', status: 'passed', command: 'pnpm verify',
      receipt: { reference: 'docs/acceptance/longstrider-run-receipt.md', artifact: 'external:test-fixture-log', sha256: 'b'.repeat(64) },
    }],
    scenarios: card.scenarios.map((scenario) => ({
      id: scenario.id, status: scenario.dimension === 'presentation' || scenario.id === 'normal-acquisition-and-cast' ? 'pending' : 'passed',
      runIds: scenario.dimension === 'presentation' || scenario.id === 'normal-acquisition-and-cast' ? [] : ['final-gate'],
    })),
  }
}

test('только сохранённый актуальный receipt подтверждает отдельные измерения partial-пилота', () => {
  const evidence = currentReceipt()
  const actual = auditSpellAcceptance({ longstriderEvidence: evidence })
  assert.equal(actual.ok, true, JSON.stringify(actual.problems))
  const card = actual.spells.find((spell) => spell.spellId === 'longstrider')
  assert.equal(card.availability.supportStatus, 'partial')
  assert.equal(card.evidenceRecord.status, 'current')
  assert.equal(card.readiness.rules, 'verified')
  assert.equal(card.readiness.resilience, 'verified')
  assert.equal(card.readiness.playerPath, 'pending')
  assert.equal(card.readiness.presentation, 'pending')
  assert.equal(card.accepted, false)
  assert.equal(actual.summary.accepted, 0)
  assert.ok(actual.spells.filter((spell) => spell.spellId !== 'longstrider').every((spell) => spell.scenarios.every((scenario) => scenario.status === 'pending')))
  assert.notEqual(actual.revision, evidence.testedRevision, 'commit служит происхождением; актуальность зависит от содержимого файлов')
  assert.equal(readLongstriderEvidence().spellId, 'longstrider')
})

test('старое доказательство любого обязательного файла или неполный набор зависимостей возвращает сценарии в pending', () => {
  for (const path of ['server/rules-engine.mjs', 'data/dndsu-spell-mechanics-overrides.json', 'src/DungeonMap.tsx', 'test/longstrider-api.test.mjs', 'server/spell-acceptance-audit.mjs', 'test/spell-acceptance-audit.test.mjs']) {
    const record = currentReceipt()
    record.dependencyFingerprints[path] = '0'.repeat(64)
    const stale = auditSpellAcceptance({ longstriderEvidence: record })
    assert.equal(stale.ok, true)
    assert.equal(stale.evidence.longstrider.status, 'stale', path)
    assert.ok(stale.warnings.length)
    assert.ok(stale.spells.find((spell) => spell.spellId === 'longstrider').scenarios.every((scenario) => scenario.status === 'pending'))
    assert.equal(stale.summary.accepted, 0)
  }
  const dropped = currentReceipt()
  delete dropped.dependencyFingerprints['server/rules-engine.mjs']
  assert.equal(auditSpellAcceptance({ longstriderEvidence: dropped }).evidence.longstrider.status, 'stale')
  assert.ok(!LONGSTRIDER_EVIDENCE_DEPENDENCIES.some((path) => path.startsWith('docs/') || path === 'README.md'), 'тексты и сам receipt не создают самохеш')
})

test('имена тестов, pending-запись и декларация passed без receipt не являются пройденным прогоном', () => {
  const pending = currentReceipt()
  pending.status = 'pending'
  assert.equal(auditSpellAcceptance({ longstriderEvidence: pending }).evidence.longstrider.status, 'pending')
  const missing = currentReceipt()
  delete missing.runs[0].receipt
  const noReceipt = auditSpellAcceptance({ longstriderEvidence: missing })
  assert.equal(noReceipt.ok, false)
  assert.ok(noReceipt.problems.some((problem) => problem.code === 'INVALID_PERSISTED_EVIDENCE'))
  const filenameOnly = currentReceipt()
  filenameOnly.runs[0].command = 'test/longstrider.test.mjs'
  assert.equal(auditSpellAcceptance({ longstriderEvidence: filenameOnly }).ok, false, 'нет успешного итогового pnpm verify')
  const missingRun = currentReceipt()
  missingRun.scenarios[0].runIds = []
  assert.equal(auditSpellAcceptance({ longstriderEvidence: missingRun }).ok, false)
  const manual = currentReceipt()
  const presentation = manual.scenarios.find((scenario) => scenario.id === 'two-player-2d-3d-av')
  Object.assign(presentation, { status: 'passed', runIds: ['final-gate'] })
  assert.equal(auditSpellAcceptance({ longstriderEvidence: manual }).ok, false, 'unit/API-run не подменяет ручную приёмку')
  const onlyHttp = currentReceipt()
  Object.assign(onlyHttp.scenarios.find((scenario) => scenario.id === 'normal-acquisition-and-cast'), { status: 'passed', runIds: ['final-gate'] })
  assert.equal(auditSpellAcceptance({ longstriderEvidence: onlyHttp }).ok, false, 'HTTP-run не подтверждает ручной путь основного сайта')
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
