// Приглушение атмосферной петли под громким боевым звуком (ducking).
//
// Это обработка записи на шине фона, а не синтез: петля остаётся загруженным
// файлом, меняется только множитель громкости на время удара.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(repositoryRoot, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(repositoryRoot, 'tmp', 'atmosphere-audio-'))
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [
  join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck',
  '--rootDir', join(repositoryRoot, 'src'), '--outDir', buildDir, join(repositoryRoot, 'src/atmosphere-audio.ts'),
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
renameSync(join(buildDir, 'atmosphere-audio.js'), join(buildDir, 'atmosphere-audio.mjs'))
const { atmosphereDuckScale, createAtmosphereAudio } = await import(pathToFileURL(join(buildDir, 'atmosphere-audio.mjs')).href)

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = [] }
  cancelScheduledValues(at) { this.events.push(['cancel', at]) }
  setValueAtTime(value, at) { this.value = value; this.events.push(['set', value, at]) }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]) }
  setTargetAtTime(value, at, constant) { this.events.push(['target', value, at, constant]) }
}

class FakeNode {
  constructor() { this.gain = new FakeParam() }
  connect(destination) { return destination }
  disconnect() {}
}

class FakeContext {
  constructor() { this.state = 'suspended'; this.currentTime = 5; this.destination = {}; this.gains = [] }
  createGain() { const gain = new FakeNode(); this.gains.push(gain); return gain }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}

// Петля в тесте не грузится: место без записи молчит, а сеть не нужна.
globalThis.fetch = async () => ({ ok: false, status: 404 })

const memoryStorage = () => {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('atmosphereDuckScale: множитель только пока приглушение держится', () => {
  assert.equal(atmosphereDuckScale(.35, 10, 9), .65)
  assert.equal(atmosphereDuckScale(.35, 10, 10), 1, 'истёкшее приглушение не действует')
  assert.equal(atmosphereDuckScale(0, 10, 9), 1)
  assert.equal(atmosphereDuckScale(Number.NaN, 10, 9), 1)
  assert.ok(Math.abs(atmosphereDuckScale(.95, 10, 9) - .2) < 1e-9, 'фон не пропадает целиком')
})

test('duck приглушает шину фона и возвращает её после удержания', async () => {
  const context = new FakeContext()
  const audio = createAtmosphereAudio({
    settings: { ambientVolume: .5, muted: false },
    storage: memoryStorage(),
    audioContextFactory: () => context,
  })
  assert.equal(await audio.unlock(), true)
  const bus = context.gains[0]
  bus.gain.events.length = 0
  audio.duck(.4, .6)
  const targets = bus.gain.events.filter((event) => event[0] === 'target')
  assert.equal(targets.length, 2)
  assert.ok(Math.abs(targets[0][1] - .5 * .6) < 1e-9, 'на удар фон тише на 40 %')
  assert.equal(targets[0][2], 5)
  assert.ok(Math.abs(targets[1][1] - .5) < 1e-9, 'после удержания возвращается громкость игрока')
  assert.ok(Math.abs(targets[1][2] - 5.6) < 1e-9)

  // Повтор во время приглушения продлевает его и не делает мельче.
  bus.gain.events.length = 0
  context.currentTime = 5.3
  audio.duck(.2, .6)
  const extended = bus.gain.events.filter((event) => event[0] === 'target')
  assert.ok(Math.abs(extended[0][1] - .5 * .6) < 1e-9)
  assert.ok(Math.abs(extended[1][2] - 5.9) < 1e-9)

  // Ожидание рассказчика во время приглушения не снимает его раньше времени.
  bus.gain.events.length = 0
  audio.setWaiting(true)
  const waiting = bus.gain.events.filter((event) => event[0] === 'target')
  assert.ok(Math.abs(waiting[0][1] - .5 * .62 * .6) < 1e-9)
  assert.ok(Math.abs(waiting[1][1] - .5 * .62) < 1e-9)
  await audio.dispose()
})

test('duck ничего не делает в mute, до unlock и с пустыми значениями', async () => {
  const context = new FakeContext()
  const audio = createAtmosphereAudio({
    settings: { ambientVolume: .5, muted: true },
    storage: memoryStorage(),
    audioContextFactory: () => context,
  })
  audio.duck(.5, 1)
  await audio.unlock()
  const bus = context.gains[0]
  bus.gain.events.length = 0
  audio.duck(.5, 1)
  assert.deepEqual(bus.gain.events, [], 'в mute фон не трогается')
  audio.setMuted(false)
  bus.gain.events.length = 0
  audio.duck(0, 1)
  audio.duck(.5, 0)
  audio.duck(Number.NaN, 1)
  assert.deepEqual(bus.gain.events, [])
  await audio.dispose()
})
