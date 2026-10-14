import '../../../fixtures-env.mjs'
// Эталоны `server/architect-usage.mjs` для `sk-agents-base`: сценарии над
// файлом учёта (запись, чтение, смена дня, мусор в файле) — результаты
// вызовов и точное содержимое файла после каждого шага. Запуск из этого
// каталога: node gen-architect-usage.mjs → architect-usage.json
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `architect-usage.mjs` берёт `atomicWrite` из `store.mjs`, а тот при импорте
// читает `.env` (`dotenv/config`) и создаёт каталоги хранилища. Для эталона
// `.env` не нужен: импорт подменяется пустым модулем, хранилище — временное.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const storageRoot = mkdtempSync(join(tmpdir(), 'skazanie-architect-storage-'))
process.env.DND_STORAGE_DIR = storageRoot
const { ArchitectUsageStore, architectAlertText } = await import('../../../../server/architect-usage.mjs')

const here = dirname(fileURLToPath(import.meta.url))
const DAY_1 = Date.parse('2026-08-02T21:00:00.000Z')
const DAY_1_LATE = Date.parse('2026-08-02T23:59:59.999Z')
const DAY_2 = Date.parse('2026-08-03T00:00:00.000Z')

const IDS = ['ALFA', 'alfa', 'beta-1', 'Кампания 7', 'ß-straße', 'x'.repeat(30), '', '  ', '123', '7', 'constructor', '__proto__', 'a_b.c', 'ﬁle', 'Ω-9']

const state = (day, campaigns, extra = {}) => JSON.stringify({ schema_version: 1, day, campaigns, ...extra })

const scenarios = [
  { threshold: 3, steps: [{ op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'today', id: 'ALFA' }, { op: 'today', id: 'BETA' }, { op: 'record', id: 'BETA' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'report' }] },
  { threshold: 2, steps: [{ op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'now', value: DAY_1_LATE }, { op: 'record', id: 'ALFA' }, { op: 'now', value: DAY_2 }, { op: 'today', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'report' }] },
  { threshold: 1, steps: IDS.flatMap((id) => [{ op: 'record', id }, { op: 'today', id }]).concat([{ op: 'report' }]) },
  { threshold: 2, steps: [{ op: 'record', id: 'ZED' }, { op: 'record', id: '123' }, { op: 'record', id: '7' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: '00' }, { op: 'report' }] },
  { threshold: 3, steps: [{ op: 'write', content: '{ это не json' }, { op: 'today', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'report' }] },
  { threshold: 3, steps: [{ op: 'write', content: '﻿' + state('2026-08-02', { ALFA: { generations: 2 } }) }, { op: 'today', id: 'ALFA' }, { op: 'record', id: 'ALFA' }] },
  { threshold: 3, steps: [{ op: 'write', content: state('2026-08-01', { ALFA: { generations: 9 } }) }, { op: 'today', id: 'ALFA' }, { op: 'report' }, { op: 'record', id: 'ALFA' }] },
  { threshold: 3, steps: [{ op: 'write', content: JSON.stringify({ schema_version: 2, day: '2026-08-02', campaigns: { ALFA: { generations: 2 } } }) }, { op: 'today', id: 'ALFA' }, { op: 'record', id: 'ALFA' }] },
  { threshold: 3, steps: [{ op: 'write', content: JSON.stringify({ schema_version: '1', day: '2026-08-02', campaigns: {} }) }, { op: 'report' }] },
  { threshold: 3, steps: [{ op: 'write', content: JSON.stringify({ schema_version: 1.0, day: '2026-08-02', campaigns: [] }) }, { op: 'report' }, { op: 'record', id: 'A' }] },
  { threshold: 3, steps: [{ op: 'write', content: JSON.stringify({ schema_version: 1, day: '2026-08-02', campaigns: null }) }, { op: 'report' }] },
  { threshold: 3, steps: [{ op: 'write', content: 'null' }, { op: 'report' }, { op: 'write', content: '[]' }, { op: 'report' }, { op: 'write', content: '' }, { op: 'report' }] },
  {
    threshold: 3,
    steps: [
      { op: 'write', content: state('2026-08-02', { ALFA: { generations: '5', lab_generations: -1, alerted: 'yes', extra: { x: 1 } }, BETA: null, GAMMA: 7, DELTA: [1, 2], EPS: { generations: 2.5, lab_generations: 1e21 }, ZETA: { generations: 2, alerted: true, note: 'оставить' }, '42': { generations: 1 } }, { extra_top: [1, { a: null }] }) },
      { op: 'report' },
      ...['ALFA', 'BETA', 'GAMMA', 'DELTA', 'EPS', 'ZETA', '42'].map((id) => ({ op: 'today', id })),
      { op: 'record', id: 'ALFA' },
      { op: 'record', id: 'BETA' },
      { op: 'record', id: 'GAMMA' },
      { op: 'record', id: 'DELTA' },
      { op: 'record', id: 'EPS' },
      { op: 'record', id: 'ZETA' },
      { op: 'record', id: '42' },
      { op: 'record', id: 'NEW' },
      { op: 'report' },
    ],
  },
  { threshold: 2, steps: [{ op: 'write', content: state('2026-08-02', { ALFA: { generations: 0, lab_generations: 2, alerted: false } }) }, { op: 'today', id: 'ALFA' }, { op: 'report' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }] },
  { threshold: 3, steps: [{ op: 'write', content: state('2026-08-02', { ALFA: { generations: 'много' }, BETA: { generations: '0x10' }, GAMMA: { generations: true }, DELTA: { generations: 9007199254740993 } }) }, { op: 'report' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: 'BETA' }, { op: 'record', id: 'GAMMA' }, { op: 'record', id: 'DELTA' }] },
  { threshold: 3, steps: [{ op: 'write', content: state('2026-08-02', { 'ALFA': { generations: 1 }, '\u0000': { generations: 1 }, 'с кириллицей': { generations: 3, alerted: true } }) }, { op: 'report' }, { op: 'record', id: 'alfa' }, { op: 'delete' }, { op: 'report' }] },
]

const thresholds = [7, 0, -3, 'NaN', 'много', 1.5, '4', null, undefined, true, [2], '  6  ']
for (const threshold of thresholds) scenarios.push({ threshold, steps: [{ op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'record', id: 'ALFA' }, { op: 'report' }] })

const directory = mkdtempSync(join(tmpdir(), 'skazanie-architect-fixture-'))
try {
  for (const [index, scenario] of scenarios.entries()) {
    const storageFile = join(directory, `usage-${index}.json`)
    let now = DAY_1
    const threshold = scenario.threshold === 'NaN' ? Number.NaN : scenario.threshold
    const store = new ArchitectUsageStore({ storageFile, ...(threshold !== undefined ? { alertThreshold: threshold } : {}), now: () => now })
    scenario.alertThreshold = store.alertThreshold
    for (const step of scenario.steps) {
      if (step.op === 'write') writeFileSync(storageFile, step.content, 'utf8')
      else if (step.op === 'delete') rmSync(storageFile, { force: true })
      else if (step.op === 'now') now = step.value
      else if (step.op === 'record') step.out = store.recordGeneration(step.id)
      else if (step.op === 'today') step.out = store.generationsToday(step.id)
      else if (step.op === 'report') step.out = store.report()
      if (step.op === 'record' || step.op === 'today' || step.op === 'report') step.file = existsSync(storageFile) ? readFileSync(storageFile, 'utf8') : null
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
  rmSync(storageRoot, { recursive: true, force: true })
}

const alertTexts = [0, 1, 3, 4, 21, 100].map((generations) => ({ generations, text: architectAlertText(generations) }))
writeFileSync(join(here, 'architect-usage.json'), `${JSON.stringify({ start: DAY_1, scenarios, alertTexts }, null, 1)}\n`, 'utf8')
const steps = scenarios.reduce((total, scenario) => total + scenario.steps.length, 0)
console.log(`architect-usage.json: ${scenarios.length} сценариев, ${steps} шагов`)
