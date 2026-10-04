import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { freePort } from '../../../../test/free-port.mjs'
import { createMapImportRoutes } from '../../../../server/routes/map-import-routes.mjs'
import { decodeSlab, SLAB_MAX_PACKED_BYTES, SLAB_MAX_TEXT_LENGTH, TaleSpireSlabError } from '../../../../server/talespire-slab.mjs'
import { taleSpireAssetTable, worldBoxesForSlab } from '../../../../server/talespire-import.mjs'

function guidBytes(guid) {
  const bytes = Buffer.from(guid.replace(/-/gu, ''), 'hex')
  return Buffer.concat([
    Buffer.from([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6]]),
    bytes.subarray(8, 16),
  ])
}

function oneV1(assetId, values) {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0xD1CEFACE, 0)
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(1, 6)
  const layout = Buffer.alloc(20)
  guidBytes(assetId).copy(layout)
  layout.writeUInt16LE(1, 16)
  const instance = Buffer.alloc(28)
  for (const [index, value] of [values.x, values.y, values.z, values.ex, values.ey, values.ez].entries()) {
    instance.writeFloatLE(value, index * 4)
  }
  return gzipSync(Buffer.concat([header, layout, instance])).toString('base64')
}

const errors = []
const expectCode = (fn, code) => {
  assert.throws(fn, (error) => error instanceof TaleSpireSlabError && error.code === code)
  errors.push(code)
}

expectCode(() => decodeSlab('A'.repeat(SLAB_MAX_TEXT_LENGTH + 1)), 'SLAB_TOO_LARGE')
expectCode(() => decodeSlab(Buffer.from('not gzip').toString('base64')), 'SLAB_NOT_GZIP')
expectCode(() => decodeSlab(gzipSync(Buffer.from([0xCE, 0xFA, 0xCE, 0xD1, 1, 0, 1, 0])).toString('base64')), 'SLAB_TRUNCATED')

const floorId = [...taleSpireAssetTable().entries()].find(([, row]) => row[0] === 't' && row[1] === 'floor')?.[0]
assert.ok(floorId)
const extremeFinite = oneV1(floorId, {
  x: 1e30, y: 0, z: 0, ex: 0.5, ey: 0.25, ez: 0.5,
})
const decodedExtreme = decodeSlab(extremeFinite)
assert.equal(decodedExtreme.instances.length, 1)
assert.equal(Number.isFinite(decodedExtreme.instances[0].center.x), true)
assert.ok(decodedExtreme.instances[0].center.x > 9e29)

const largeExtentSlab = decodeSlab(oneV1(floorId, {
  x: 1_000, y: 0, z: 1_000, ex: 100_000, ey: 0.25, ez: 100_000,
}))
const largeBox = worldBoxesForSlab(largeExtentSlab, taleSpireAssetTable()).boxes[0]
assert.ok(largeBox.maxX > 100_000)
assert.ok(Number.isFinite(largeBox.maxX))

let bodyRead = 0
let response = null
const handler = createMapImportRoutes({
  requireUser: () => ({ id: 'player', role: 'player' }),
  getRoom: () => ({ state: {} }),
  campaignMembershipFor: () => ({ role: 'player' }),
  readBody: async () => { bodyRead += 1; throw new Error('readBody не должен вызываться без прав владельца') },
  json: (_res, status, body) => { response = { status, body } },
})
await handler({ method: 'POST', headers: {} }, {}, '/api/campaigns/BOUNDARY/map-import')
assert.equal(bodyRead, 0)
assert.equal(response.status, 403)
assert.equal(response.body.code, 'MAP_IMPORT_FORBIDDEN')

async function realNullBodyProbe() {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-map-boundary-'))
  const dotenv = join(storage, 'empty.env')
  writeFileSync(dotenv, '')
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let logs = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: dotenv,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'map-boundary-probe',
      GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += String(chunk) })
  child.stderr.on('data', (chunk) => { logs += String(chunk) })
  const stop = async () => {
    if (child.exitCode != null) return
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
  try {
    let healthy = false
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (child.exitCode != null) break
      try {
        const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })
        if (health.ok) { healthy = true; break }
      } catch { /* сервер ещё поднимается */ }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(healthy, true)
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      signal: AbortSignal.timeout(10_000),
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Boundary owner', email: 'boundary-owner@test.local', password: 'secure-boundary-password' }),
    })
    assert.equal(register.status, 201)
    const cookie = register.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const campaign = await fetch(`${baseUrl}/api/campaigns`, {
      signal: AbortSignal.timeout(10_000),
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: 'BOUNDARY', name: 'Boundary campaign', bootstrap: { partyName: 'Probe', players: [{ id: 'hero-1' }] } }),
    })
    assert.equal(campaign.status, 201)
    let http = { status: null, error: null }
    try {
      const response = await fetch(`${baseUrl}/api/campaigns/BOUNDARY/map-import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: 'null', signal: AbortSignal.timeout(2_000),
      })
      http.status = response.status
      await response.text()
    } catch (error) {
      http.error = error instanceof Error ? error.name : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const routeTypeError = /TypeError: Cannot read properties of null/.test(logs)
      && /map-import-routes\.mjs:71/.test(logs)
    assert.equal(http.status, null)
    assert.equal(child.exitCode, 1)
    assert.equal(routeTypeError, true)
    return { http, child_exit_code: child.exitCode, route_null_type_error: routeTypeError, node: process.version }
  } finally {
    await stop()
    rmSync(storage, { recursive: true, force: true })
  }
}

const realNullBody = await realNullBodyProbe()

console.log(JSON.stringify({
  limits: { text: SLAB_MAX_TEXT_LENGTH, packed: SLAB_MAX_PACKED_BYTES },
  malformed_codes: errors,
  extreme_v1_finite_coordinate: decodedExtreme.instances[0].center.x,
  large_v1_box: { maxX: largeBox.maxX, maxZ: largeBox.maxZ },
  forbidden_route: { status: response.status, body_read: bodyRead },
  real_http_null_body: realNullBody,
}, null, 2))
