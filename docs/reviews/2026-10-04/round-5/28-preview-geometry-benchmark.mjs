// Измеряется только генерация строк геометрии, без React, SVG/Canvas и GPU.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const build = mkdtempSync(join(tmpdir(), 'skazanie-preview-geometry-'))
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--strict', '--skipLibCheck',
    '--outDir', build, join(root, 'src/move-preview.ts')], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
  const source = readFileSync(join(build, 'move-preview.js'), 'utf8')
  const geometry = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const cases = [
    { width: 32, height: 32, movement_feet: 30 },
    { width: 96, height: 64, movement_feet: 30 },
    { width: 96, height: 64, movement_feet: 60 },
    { width: 96, height: 64, movement_feet: 150 },
    { width: 96, height: 64, movement_feet: null },
  ]
  const results = cases.map(input => {
    const start = { x: Math.floor(input.width / 2), y: Math.floor(input.height / 2) }
    const reach = []
    for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
      const distance = Math.abs(x - start.x) + Math.abs(y - start.y)
      if (distance && (input.movement_feet == null || distance * 5 <= input.movement_feet)) reach.push(`${x},${y}`)
    }
    const preview = { start, reach, path: [{ x: start.x + 1, y: start.y }, { x: start.x + 2, y: start.y }] }
    const generate = () => [geometry.moveReachFill(preview), geometry.moveReachOutline(preview),
      geometry.moveRoutePath(preview), geometry.moveDifficultPath(preview)]
    for (let index = 0; index < 30; index++) generate()
    const times = []
    let output
    for (let index = 0; index < 200; index++) {
      const began = performance.now()
      output = generate()
      times.push(performance.now() - began)
    }
    times.sort((a, b) => a - b)
    return { ...input, stress_only: input.movement_feet == null, reach_cells: reach.length,
      generated_characters: output.reduce((total, value) => total + value.length, 0),
      samples: times.length, p50_ms: Number(times[100].toFixed(4)), p95_ms: Number(times[189].toFixed(4)) }
  })
  assert.equal(results[0].reach_cells, 84)
  assert.equal(results[1].reach_cells, 84)
  process.stdout.write(`${JSON.stringify({
    baseline: '88c620e6011ae607913efb224cb8f850b4ee5028', node: process.version,
    platform: process.platform, cpu: cpus()[0]?.model,
    scope: 'Только строки четырёх функций move-preview; не FPS, не время React или Canvas.',
    results,
  }, null, 2)}\n`)
} finally {
  rmSync(build, { recursive: true, force: true })
}
