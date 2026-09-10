import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { decodePng, encodePng } from '../tools/png-codec.mjs'
import { startPropModelAtlas } from '../tools/render-prop-model-atlas.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function imageWithAlpha(points = []) {
  const image = { width: 2048, height: 256, data: new Uint8Array(2048 * 256 * 4) }
  for (const [x, y] of points) image.data[(y * image.width + x) * 4 + 3] = 255
  return image
}

async function makeCandidate({ schema = 'environment-candidate/v1' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'skazanie-prop-atlas-candidate-'))
  await mkdir(join(directory, 'quaternius'))
  await writeFile(join(directory, 'quaternius', 'one.glb'), Buffer.from('one'))
  await writeFile(join(directory, 'quaternius', 'two.glb'), Buffer.from('two'))
  const manifest = {
    version: 1,
    build: { schema, generatedBy: 'test' },
    sources: [{ author: 'fixture' }],
    keep: { value: 'untouched' },
    models: [
      { key: 'one', label: 'Один', url: '/assets/models/environment/quaternius/one.glb', extra: { keep: true }, preview: { old: true } },
      { key: 'two', label: 'Два', url: '/assets/models/environment/quaternius/two.glb' },
    ],
    atlas: { prior: true },
  }
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { directory, manifest }
}

test('staged renderer serves candidate and atomically saves validated output', async (t) => {
  const { directory, manifest } = await makeCandidate()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const oldImage = encodePng(imageWithAlpha([[2, 2], [3, 3]]))
  await writeFile(join(directory, 'topdown.png'), oldImage)
  const oldManifest = await readFile(join(directory, 'manifest.json'))
  let saved = null
  const started = await startPropModelAtlas({ directory, port: 0, onSaved: (details) => { saved = details } })
  t.after(() => started.close())

  const home = await fetch(started.url)
  assert.equal(home.status, 200)
  const html = await home.text()
  assert.match(html, /Создать 2D-виды/u)
  assert.match(html, /quaternius\/one\.glb/u)
  const savePath = html.match(/fetch\('\/save\/([^']+)'/u)?.[1]
  assert.ok(savePath)
  const saveUrl = `${started.url}/save/${savePath}`

  const model = await fetch(`${started.url}/assets/models/environment/quaternius/one.glb`)
  assert.equal(model.status, 200)
  assert.deepEqual(Buffer.from(await model.arrayBuffer()), Buffer.from('one'))
  const three = await fetch(`${started.url}/three/build/three.module.js`)
  assert.equal(three.status, 200)
  assert.match(await three.text(), /THREE/u)
  assert.equal((await fetch(`${started.url}/assets/models/environment/..%2f..%2f..%2fdata%2fasset-rights.json`)).status, 400)

  const validImage = encodePng(imageWithAlpha([[0, 0], [256, 0]]))
  const invalid = {
    image: `data:image/png;base64,${validImage.toString('base64')}`,
    frames: { one: { x: 0, y: 0, w: 1, h: 1 }, two: { x: 256, y: 0, w: 1, h: 1 }, unknown: { x: 0, y: 0, w: 1, h: 1 } },
  }
  const forbidden = await fetch(saveUrl, { method: 'POST', headers: { Origin: started.url, 'Content-Type': 'application/json' }, body: JSON.stringify(invalid) })
  assert.equal(forbidden.status, 400)
  assert.deepEqual(await readFile(join(directory, 'topdown.png')), oldImage)
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), oldManifest)

  const wrongOrigin = await fetch(saveUrl, { method: 'POST', headers: { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
  assert.equal(wrongOrigin.status, 403)
  const payload = {
    image: `data:image/png;base64,${validImage.toString('base64')}`,
    frames: { one: { x: 0, y: 0, w: 1, h: 1 }, two: { x: 256, y: 0, w: 1, h: 1 } },
  }
  const accepted = await fetch(saveUrl, { method: 'POST', headers: { Origin: started.url, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal(accepted.status, 200)
  assert.equal(saved?.directory, directory)
  assert.equal(saved?.imagePath, join(directory, 'topdown.png'))
  const resultManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.deepEqual(resultManifest.keep, manifest.keep)
  assert.deepEqual({ schema: resultManifest.build.schema, generatedBy: resultManifest.build.generatedBy }, manifest.build)
  assert.equal(resultManifest.build.atlasRendererVersion, 1)
  assert.match(resultManifest.build.threeVersion, /^\d+\.\d+\.\d+/u)
  assert.deepEqual(resultManifest.sources, manifest.sources)
  assert.deepEqual(resultManifest.models[0].extra, manifest.models[0].extra)
  assert.equal(resultManifest.models[0].preview.old, true)
  assert.deepEqual(resultManifest.models[0].preview, { old: true, x: 0, y: 0, w: 1, h: 1 })
  assert.equal(resultManifest.atlas.prior, true)
  assert.equal(resultManifest.atlas.image, '/assets/models/environment/topdown.png')
  assert.equal(resultManifest.atlas.key.length, 64)
  const resultImage = decodePng(await readFile(join(directory, 'topdown.png')))
  assert.equal(resultImage.width, 2048)
  assert.equal(resultImage.height, 256)
  assert.deepEqual(await readdir(directory), ['manifest.json', 'quaternius', 'topdown.png'])
})

test('renderer не затирает manifest, изменённый после запуска', async (t) => {
  const { directory } = await makeCandidate()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const started = await startPropModelAtlas({ directory, port: 0 })
  t.after(() => started.close())
  const html = await (await fetch(started.url)).text()
  const savePath = html.match(/fetch\('\/save\/([^']+)'/u)?.[1]
  assert.ok(savePath)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ build: { schema: 'environment-candidate/v1' }, models: [] })}\n`)
  const response = await fetch(`${started.url}/save/${savePath}`, {
    method: 'POST', headers: { Origin: started.url, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(response.status, 409)
  assert.match(await response.text(), /изменился/u)
  assert.equal((await readdir(directory)).some((name) => name.includes('.tmp')), false)
})

test('renderer rejects non-candidates and protected directories before listening', async (t) => {
  const nonCandidate = await makeCandidate({ schema: 'other/v1' })
  t.after(() => rm(nonCandidate.directory, { recursive: true, force: true }))
  await assert.rejects(() => startPropModelAtlas({ directory: nonCandidate.directory, port: 0 }), /environment-candidate\/v1/u)
  await assert.rejects(() => startPropModelAtlas({ directory: join(ROOT, 'public', 'assets'), port: 0 }), /public\/assets/u)
  await assert.rejects(() => startPropModelAtlas({ directory: join(ROOT, 'data'), port: 0 }), /data/u)
  await assert.rejects(() => startPropModelAtlas({ directory: join(ROOT, 'storage'), port: 0 }), /storage/u)
})
