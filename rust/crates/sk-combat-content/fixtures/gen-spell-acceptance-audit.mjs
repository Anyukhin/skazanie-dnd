import '../../../fixtures-env.mjs'
// Эталон server/spell-acceptance-audit.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-spell-acceptance-audit.mjs
//
// Отчёт приёмки по настоящим файлам и доказательствам; с явным null;
// с актуальным, устаревшим, ожидающим и неполным receipt «Скорохода»; с
// актуальным и испорченным receipt первой партии; без истории Git. Паспорта
// заклинаний — хешами (полностью — в основном отчёте), прочее целиком.
// Проверка схемы над изменёнными отчётами записывается по имени изменения:
// Rust применяет то же изменение к своему отчёту.
//
// `revision` и `workingTreeSha256` зависят от момента снятия (коммит, дерево):
// Rust сверяет их форму и подставляет значения эталона перед сравнением.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalCombatSpellFor } from '../../../../server/combat-spells.mjs'
import * as m from '../../../../server/spell-acceptance-audit.mjs'
import { hash, writeFixture } from './common.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const catalog = JSON.parse(readFileSync(new URL('../../../../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const compact = (report) => ({ ...report, spells: report.spells.map((card) => [card.spellId, hash(card)]) })

const report = m.auditSpellAcceptance({ longstriderEvidence: null })

function currentReceipt() {
  const card = report.spells.find((spell) => spell.spellId === 'longstrider')
  return {
    schemaVersion: 'spell-evidence/v1', spellId: 'longstrider', status: 'recorded',
    testedRevision: 'a'.repeat(40), observedAt: '2026-09-21T14:00:00.000Z',
    dependencyFingerprints: m.longstriderDependencyFingerprints(),
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

const longstrider = { current: currentReceipt() }
for (const path of ['server/rules-engine.mjs', 'data/dndsu-spell-mechanics-overrides.json', 'src/DungeonMap.tsx', 'test/longstrider-api.test.mjs', 'server/spell-acceptance-audit.mjs', 'test/spell-acceptance-audit.test.mjs']) {
  const record = currentReceipt()
  record.dependencyFingerprints[path] = '0'.repeat(64)
  longstrider[`stale:${path}`] = record
}
longstrider.dropped = currentReceipt()
delete longstrider.dropped.dependencyFingerprints['server/rules-engine.mjs']
longstrider.pending = { ...currentReceipt(), status: 'pending' }
longstrider.noReceipt = currentReceipt()
delete longstrider.noReceipt.runs[0].receipt
longstrider.filenameOnly = currentReceipt()
longstrider.filenameOnly.runs[0].command = 'test/longstrider.test.mjs'
longstrider.missingRun = currentReceipt()
longstrider.missingRun.scenarios[0].runIds = []
longstrider.manual = currentReceipt()
Object.assign(longstrider.manual.scenarios.find((scenario) => scenario.id === 'two-player-2d-3d-av'), { status: 'passed', runIds: ['final-gate'] })
longstrider.onlyHttp = currentReceipt()
Object.assign(longstrider.onlyHttp.scenarios.find((scenario) => scenario.id === 'normal-acquisition-and-cast'), { status: 'passed', runIds: ['final-gate'] })
longstrider.wrongSchema = { ...currentReceipt(), schemaVersion: 'spell-evidence/v0' }
longstrider.duplicateRuns = currentReceipt()
longstrider.duplicateRuns.runs.push({ ...longstrider.duplicateRuns.runs[0] }, { id: 'manual', kind: 'manual-run', status: 'passed', command: 'двое игроков', receipt: { reference: 'docs/acceptance/x.md', artifact: 'log', sha256: 'c'.repeat(64) } })
longstrider.badDate = { ...currentReceipt(), observedAt: 'вчера', testedRevision: 'abc' }
longstrider.badScenario = currentReceipt()
longstrider.badScenario.scenarios[1] = { id: longstrider.badScenario.scenarios[1].id, status: 'done' }
longstrider.allPassedManual = currentReceipt()
longstrider.allPassedManual.runs.push({ id: 'manual', kind: 'manual-run', status: 'passed', command: 'двое игроков', receipt: { reference: 'docs/acceptance/manual.md', artifact: 'video', sha256: 'd'.repeat(64) } })
for (const scenario of longstrider.allPassedManual.scenarios) Object.assign(scenario, { status: 'passed', runIds: ['final-gate', 'manual'] })
longstrider.invalidFile = { status: 'invalid', error: 'Файл evidence не является читаемым JSON.' }

// Первая партия: актуальный receipt и испорченные варианты.
const basicIds = catalog.spells.filter((raw) => canonicalCombatSpellFor(raw.id, { rulesetId: 'dnd_5e_2014' }).mechanicsSupport === 'verified').map((raw) => raw.id)
const scenarioIds = report.spells.find((spell) => spell.spellId === basicIds[0]).scenarios.map((scenario) => scenario.id)
const basicScenarioIds = [...scenarioIds, 'effect-and-exceptions', 'lifecycle-and-upcast'].filter((id, index, list) => list.indexOf(id) === index)
function basicReceipt() {
  return {
    schemaVersion: 'spell-batch-evidence/v1', status: 'recorded', testedRevision: 'e'.repeat(40), observedAt: '2026-09-30T12:00:00.000Z',
    dependencyFingerprints: m.basicSpellDependencyFingerprints(),
    runs: [
      { id: 'verify', kind: 'test-run', status: 'passed', command: 'pnpm verify', receipt: { reference: 'docs/acceptance/basic-verify.md', artifact: 'ci-log', sha256: 'f'.repeat(64) } },
      { id: 'browser', kind: 'manual-run', status: 'passed', command: 'двое игроков, 2D/3D', receipt: { reference: 'docs/acceptance/basic-browser.md', artifact: 'video', sha256: '1'.repeat(64) } },
    ],
    spells: basicIds.map((spellId) => ({
      spellId,
      source: { rulesetId: 'dnd_5e_2014', publication: 'PHB 2014', acceptedRevision: 'r1', htmlSha256: '2'.repeat(64), descriptionSha256: '3'.repeat(64), cardSha256: sha256(JSON.stringify(catalog.spells.find((spell) => spell.id === spellId))) },
      specification: ['урон', 'спасбросок'], choices: ['цель'], lifecycle: ['наложение'],
      scenarios: basicScenarioIds.map((id) => ({ id, status: 'passed', runIds: ['verify', 'browser'] })),
    })),
  }
}
const basic = { current: basicReceipt() }
basic.pending = { ...basicReceipt(), status: 'pending' }
basic.wrongSchema = { ...basicReceipt(), schemaVersion: 'x' }
basic.stale = basicReceipt()
basic.stale.dependencyFingerprints['src/App.tsx'] = '0'.repeat(64)
basic.badCard = basicReceipt()
basic.badCard.spells[0].source.cardSha256 = '4'.repeat(64)
basic.badCard.spells[1].scenarios.pop()
basic.badCard.spells[2].scenarios[0].runIds = ['nope']
basic.badCard.runs.push({ id: 'verify', kind: 'other' })
basic.missingIds = basicReceipt()
basic.missingIds.spells.pop()
basic.noManual = basicReceipt()
for (const card of basic.noManual.spells) for (const scenario of card.scenarios) scenario.runIds = ['verify']
basic.invalidFile = { status: 'invalid' }

const audits = [{ name: 'default', options: null, report: m.auditSpellAcceptance() }]
audits.push({ name: 'nullEvidence', options: { longstriderEvidence: null }, report })
for (const [name, record] of Object.entries(longstrider)) audits.push({ name: `longstrider:${name}`, options: { longstriderEvidence: record }, report: m.auditSpellAcceptance({ longstriderEvidence: record }) })
for (const [name, record] of Object.entries(basic)) audits.push({ name: `basic:${name}`, options: { longstriderEvidence: null, basicEvidence: record }, report: m.auditSpellAcceptance({ longstriderEvidence: null, basicEvidence: record }) })
const directory = mkdtempSync(join(tmpdir(), 'skazanie-spell-baseline-'))
let unavailable
try {
  unavailable = m.readSpellAcceptanceBaseline(directory)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
audits.push({ name: 'unavailableBaseline', options: { baseline: unavailable }, report: m.auditSpellAcceptance({ baseline: unavailable }) })

// Изменения отчёта для проверки схемы — те же применяет Rust.
const MUTATIONS = {
  duplicate: (value) => { value.spells[1].spellId = value.spells[0].spellId },
  missing: (value) => { value.spells.pop() },
  unknown: (value) => { value.spells[0].spellId = 'not-in-the-catalog' },
  unproved: (value) => {
    value.spells[0].readiness.rules = 'verified'
    value.spells[0].accepted = true
    value.spells[0].scenarios[0].status = 'passed'
    value.spells[0].baseline.group = 'verified'
  },
  otherTree: (value) => {
    value.spells[0].scenarios[0] = { ...value.spells[0].scenarios[0], status: 'passed', evidence: [{ kind: 'test-run', reference: 'test/example.test.mjs', observedAt: '2026-09-21T10:00:00Z', treeSha256: '0'.repeat(64) }] }
    value.spells[0].scenarios[1].status = 'not-applicable'
  },
  sameTree: (value) => {
    value.spells[0].scenarios[0] = { ...value.spells[0].scenarios[0], status: 'passed', evidence: [{ kind: 'manual-run', reference: 'docs/x.md', observedAt: '2026-09-21', treeSha256: value.workingTreeSha256 }] }
  },
  nullScenario: (value) => { value.spells[0].scenarios = [null] },
  allNotApplicable: (value) => {
    const card = value.spells[0]
    for (const scenario of card.scenarios) Object.assign(scenario, { status: 'not-applicable', reason: 'Общий обработчик уже проверен.' })
    for (const dimension of m.SPELL_ACCEPTANCE_DIMENSIONS) card.readiness[dimension] = 'verified'
    card.accepted = true
    value.summary.accepted = 1
  },
  badSchema: (value) => { value.schemaVersion = 'spell-acceptance/v0' },
  spellsNotArray: (value) => { value.spells = 'x' },
  badBaseline: (value) => { value.baseline.commit = 'x'; value.baseline.status = 'lost' },
  nullCard: (value) => { value.spells[0] = null; value.spells[1] = [] },
  identity: (value) => {
    value.spells[0].level = 2.5
    value.spells[0].name = ''
    value.spells[1].availability = { supportStatus: 'partial', blocked: true }
    value.spells[2].baseline = {}
    value.spells[3].source = { cardSha256: 'x', rulesetId: 'srd_5_2_1' }
    value.spells[4].specification = { status: 'done' }
    value.spells[5].remaining = []
    value.spells[6].dependencies = { items: [] }
  },
  scenarioShape: (value) => {
    const scenarios = value.spells[0].scenarios
    scenarios[0].dimension = 'fun'
    scenarios[1].status = 'maybe'
    scenarios[2].evidence = 'x'
    scenarios[3] = { ...scenarios[3], status: 'passed', dimension: 'presentation', evidence: [{ kind: 'test-run', reference: 'r', observedAt: 'x' }, null] }
    scenarios.push({ ...scenarios[4] }, { id: '', dimension: 'rules', description: '' })
  },
}
const reportFor = (name) => audits.find((entry) => entry.name === name).report
const validations = []
for (const [name, mutate] of Object.entries(MUTATIONS)) {
  for (const base of ['nullEvidence', 'unavailableBaseline']) {
    const value = structuredClone(reportFor(base))
    mutate(value)
    validations.push({ name, base, problems: m.validateSpellAcceptanceReport(value) })
  }
}
const exported = structuredClone(reportFor('unavailableBaseline'))
exported.spells[0].baseline = { supportStatus: 'partial', group: 'partial' }
validations.push({ name: 'exportedBaselineEdited', base: 'unavailableBaseline', problems: m.validateSpellAcceptanceReport(exported) })
validations.push({ name: 'notObject', base: null, problems: m.validateSpellAcceptanceReport(null) })

writeFixture(new URL('spell-acceptance-audit.json', import.meta.url), {
  constants: {
    LONGSTRIDER_EVIDENCE_PATH: m.LONGSTRIDER_EVIDENCE_PATH,
    BASIC_SPELL_EVIDENCE_PATH: m.BASIC_SPELL_EVIDENCE_PATH,
    BASIC_SPELL_EVIDENCE_DEPENDENCIES: m.BASIC_SPELL_EVIDENCE_DEPENDENCIES,
    LONGSTRIDER_EVIDENCE_DEPENDENCIES: m.LONGSTRIDER_EVIDENCE_DEPENDENCIES,
    SPELL_ACCEPTANCE_BASELINE: m.SPELL_ACCEPTANCE_BASELINE,
    SPELL_ACCEPTANCE_DIMENSIONS: m.SPELL_ACCEPTANCE_DIMENSIONS,
  },
  textHashes: ['const speed = 30\nconst bonus = 10\n', 'const speed = 30\r\nconst bonus = 10\r\n', '', 'а\r\nб\r', '\r\n\r\n'].map((text) => [text, m.spellEvidenceTextSha256(text)]),
  baselineAvailable: m.readSpellAcceptanceBaseline(),
  baselineUnavailable: unavailable,
  longstriderFingerprints: m.longstriderDependencyFingerprints(),
  basicFingerprints: m.basicSpellDependencyFingerprints(),
  fullSpells: reportFor('default').spells,
  audits: audits.map(({ name, options, report: value }) => ({ name, options, report: compact(value) })),
  validations,
})
