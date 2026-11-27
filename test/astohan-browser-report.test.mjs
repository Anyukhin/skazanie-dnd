import assert from 'node:assert/strict'
import test from 'node:test'
import { finishBrowserReport } from '../eval/browser-report.mjs'

function reportFor(requestedThrough = 12, completed = requestedThrough) {
  return {
    mode: requestedThrough === 12 ? 'full' : 'partial', requestedThrough,
    steps: Array.from({ length: completed }, (_, index) => ({ id: `${index + 1}`, coverage: 'completed' })),
    failures: [], network: [], console: [], shaders: [], compilerWarnings: [],
  }
}

test('полный гейт проверяет наличие всех 12 шагов и отделяет частичный прогон', () => {
  const absent = reportFor(12, 5)
  assert.equal(finishBrowserReport(absent), 1)
  assert.deepEqual(absent.missing, [6, 7, 8, 9, 10, 11, 12])
  assert.equal(absent.reached, 5)
  const partial = reportFor(5)
  assert.equal(finishBrowserReport(partial), 0)
  assert.equal(partial.gate, 'partial-pass')
  assert.equal(partial.reached, 5)
  const full = reportFor()
  assert.equal(finishBrowserReport(full), 0)
  assert.equal(full.gate, 'passed')
})

test('4xx, 5xx, исключение и перекрытие по отдельности делают прогон красным', () => {
  for (const issue of [
    { network: [{ step: 'Ш1', status: 403 }] },
    { network: [{ step: 'Ш1', status: 500 }] },
    { console: [{ step: 'Ш1', type: 'exception' }] },
    { steps: [{ id: '01', coverage: 'completed', seats: [{ overlaps: [{ text: 'Состояние' }] }] }] },
  ]) {
    const report = { ...reportFor(1), ...issue }
    assert.equal(finishBrowserReport(report), 1)
    assert.equal(report.gate, 'failed')
    assert.equal(report.steps[0].gate, 'failed')
  }
})

test('известное предупреждение подтверждается линковкой и кадром с GLB', () => {
  const report = reportFor(1)
  const log = '(210,91-147): warning X4122: sum cannot be represented accurately'
  report.console.push({ step: 'Ш1', seat: 'guest', type: 'warning', text: log })
  report.shaders.push({ seat: 'guest', linked: true, log, stages: [{ name: 'PMREMGGXConvolution' }] })
  report.steps[0].seats = [{ seat: 'guest', overlaps: [], browser: { canvas: { frames: '2' }, actors: [{ source: 'glb' }] } }]
  const insufficient = structuredClone(report)
  insufficient.shaders[0].linked = false
  assert.equal(finishBrowserReport(insufficient), 1)
  assert.equal(insufficient.compilerWarnings.length, 0)
  assert.equal(finishBrowserReport(report), 0)
  assert.equal(report.compilerWarnings.length, 1)
  assert.deepEqual(report.console, [])
})
