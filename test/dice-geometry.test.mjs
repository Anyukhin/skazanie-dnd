import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'skazanie-dice-geometry-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', directory, fileURLToPath(new URL('../src/dice-geometry.ts', import.meta.url))], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const { dieMesh, drawDie } = await import(`data:text/javascript;base64,${Buffer.from(readFileSync(join(directory, 'dice-geometry.js'))).toString('base64')}`)
rmSync(directory, { recursive: true, force: true })

test('кости замкнуты, имеют нужное число плоских граней и обращены результатом к зрителю', () => {
  for (const sides of [4, 6, 10, 20, 100]) {
    const { vertices, faces } = dieMesh(sides)
    assert.equal(faces.length, sides === 100 ? 10 : sides)
    const edges = new Map()
    for (const face of faces) {
      const [a,b,c] = face.map(i => vertices[i])
      const ab = b.map((v,i) => v-a[i]), ac = c.map((v,i) => v-a[i])
      const normal = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
      assert.ok(normal.reduce((sum,v,i) => sum+v*a[i],0) > 0)
      for (const index of face) assert.ok(Math.abs(normal.reduce((sum,v,i) => sum+v*(vertices[index][i]-a[i]),0)) < 1e-8)
      face.forEach((v,i) => {
        const edge = [v,face[(i+1)%face.length]].sort((x,y) => x-y).join(',')
        edges.set(edge,(edges.get(edge) ?? 0)+1)
      })
    }
    assert.ok([...edges.values()].every(count => count === 2))
    assert.equal(vertices.length - edges.size + faces.length, 2)
    const front = faces[0].map(i => vertices[i][2])
    assert.ok(front.every(z => z > 0 && Math.abs(z-front[0]) < 1e-8))
  }
})

test('передняя грань показывает серверное значение, включая 00 + 0 для сотни', () => {
  const labels = []
  const ctx = new Proxy({ fillText: text => labels.push(text), createLinearGradient: () => ({ addColorStop() {} }) }, { get: (target,key) => target[key] ?? (() => {}) })
  for (const sides of [4,6,10,20]) for (const value of [1,sides]) {
    labels.length = 0
    drawDie(ctx,dieMesh(sides),0,value,sides,300,140)
    assert.equal(labels.at(-1),String(value))
  }
  labels.length = 0
  drawDie(ctx,dieMesh(100),0,10,100,190,105,true)
  assert.equal(labels.at(-1),'00')
  drawDie(ctx,dieMesh(100),0,10,100,410,105)
  assert.equal(labels.at(-1),'0')
})
