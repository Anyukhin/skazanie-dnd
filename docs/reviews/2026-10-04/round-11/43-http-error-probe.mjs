import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { freePort } from '../../../../test/free-port.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startServer(label) {
  const storage = mkdtempSync(join(tmpdir(), `skazanie-http-boundary-${label}-`))
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
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: `http-boundary-${label}`,
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      if (child.exitCode != null) throw new Error(`Сервер завершился при запуске (${label})`)
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return { child, baseUrl, logs: () => logs, storage, stop }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Сервер завершился')) {
        await stop()
        rmSync(storage, { recursive: true, force: true })
        throw error
      }
      /* Сервер ещё поднимается. */
    }
    await wait(50)
  }
  await stop()
  rmSync(storage, { recursive: true, force: true })
  throw new Error(`Сервер не стал доступен (${label})`)
}

async function registerUser(baseUrl, suffix, name = 'HTTP boundary owner') {
  const email = `http-boundary-${suffix}@test.local`
  const password = 'secure-http-boundary-password'
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })
  assert.equal(register.status, 201)
  const cookie = register.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return { cookie, email, password }
}

async function registerOwner(baseUrl, suffix) {
  const { cookie, email, password } = await registerUser(baseUrl, suffix)
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(login.status, 200)
  const campaign = await fetch(`${baseUrl}/api/campaigns`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      code: 'BOUNDARY',
      name: 'HTTP boundary campaign',
      bootstrap: { partyName: 'Probe', slotCount: 2, players: [{ id: 'hero-1' }, { id: 'hero-2' }] },
    }),
  })
  assert.equal(campaign.status, 201)
  return { cookie, email, password }
}

async function joinAsMember(baseUrl, ownerCookie) {
  const member = await registerUser(baseUrl, 'member', 'HTTP boundary member')
  const invite = await fetch(`${baseUrl}/api/campaigns/BOUNDARY/invites`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ hero_ids: ['hero-2'] }),
  })
  assert.equal(invite.status, 201)
  const inviteBody = await invite.json()
  assert.equal(typeof inviteBody.token, 'string')
  const joined = await fetch(`${baseUrl}/api/campaigns/BOUNDARY/join`, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: member.cookie },
    body: JSON.stringify({ invite_token: inviteBody.token }),
  })
  assert.equal(joined.status, 200)
  const joinedBody = await joined.json()
  assert.equal(joinedBody.user?.role, 'player')
  const membership = joinedBody.user.campaignMemberships.find((entry) => entry.campaignId === 'BOUNDARY')
  assert.equal(membership?.role, 'player')
  const room = await fetch(`${baseUrl}/api/rooms/BOUNDARY`, {
    signal: AbortSignal.timeout(10_000),
    headers: { Cookie: member.cookie },
  })
  assert.equal(room.status, 200)
  return { cookie: member.cookie, role: membership.role }
}

async function request(baseUrl, path, options = {}) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(2_000), ...options })
    await response.text()
    return { status: response.status, error: null }
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.name : String(error) }
  }
}

async function controlsProbe() {
  const server = await startServer('controls')
  try {
    const badRegister = await request(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    assert.equal(badRegister.status, 400)

    const loginBadJson = await request(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    assert.equal(loginBadJson.status, 401)

    const loginArray = await request(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    assert.equal(loginArray.status, 401)

    const unauthenticatedMap = await request(server.baseUrl, '/api/campaigns/BOUNDARY/map-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    assert.equal(unauthenticatedMap.status, 401)

    const owner = await registerOwner(server.baseUrl, 'controls')
    return {
      bad_register_json: badRegister,
      bad_login_json: loginBadJson,
      login_array: loginArray,
      unauthenticated_map_null: unauthenticatedMap,
      register: { status: 201 },
      login: { status: 200 },
      owner_cookie_present: Boolean(owner.cookie),
      child_alive_after_controls: server.child.exitCode == null,
    }
  } finally {
    await server.stop()
    rmSync(server.storage, { recursive: true, force: true })
  }
}

async function crashingRouteProbe({ label, path, method, body, expectedLog }) {
  const server = await startServer(label)
  try {
    const { cookie } = await registerOwner(server.baseUrl, label)
    const http = await request(server.baseUrl, path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body,
    })
    await wait(150)
    assert.equal(http.status, null)
    assert.equal(server.child.exitCode, 1)
    assert.match(server.logs(), expectedLog)
    return { http, child_exit_code: server.child.exitCode, route_error_logged: true }
  } finally {
    await server.stop()
    rmSync(server.storage, { recursive: true, force: true })
  }
}

async function loginNullProbe() {
  const server = await startServer('login-null')
  try {
    const http = await request(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    await wait(150)
    assert.equal(http.status, null)
    assert.equal(server.child.exitCode, 1)
    assert.match(server.logs(), /TypeError: Cannot read properties of null[\s\S]*server[\\/]index\.mjs:3493/)
    return { http, child_exit_code: server.child.exitCode, route_error_logged: true }
  } finally {
    await server.stop()
    rmSync(server.storage, { recursive: true, force: true })
  }
}

async function typingMemberProbe() {
  const server = await startServer('typing-member')
  try {
    const owner = await registerOwner(server.baseUrl, 'typing-member-owner')
    const member = await joinAsMember(server.baseUrl, owner.cookie)
    const arrayBody = await request(server.baseUrl, '/api/campaigns/BOUNDARY/presence/typing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: member.cookie },
      body: '[]',
    })
    assert.equal(arrayBody.status, 403)
    assert.equal(server.child.exitCode, null)
    const nullBody = await request(server.baseUrl, '/api/campaigns/BOUNDARY/presence/typing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: member.cookie },
      body: 'null',
    })
    await wait(150)
    assert.equal(nullBody.status, null)
    assert.equal(server.child.exitCode, 1)
    assert.match(server.logs(), /TypeError: Cannot read properties of null[\s\S]*server[\\/]index\.mjs:3668/)
    return {
      member_role: member.role,
      array_body: arrayBody,
      null_body: { http: nullBody, child_exit_code: server.child.exitCode, route_error_logged: true },
    }
  } finally {
    await server.stop()
    rmSync(server.storage, { recursive: true, force: true })
  }
}

const controls = await controlsProbe()
const loginNull = await loginNullProbe()
const mapImportNull = await crashingRouteProbe({
  label: 'map',
  path: '/api/campaigns/BOUNDARY/map-import',
  method: 'POST',
  body: 'null',
  expectedLog: /TypeError: Cannot read properties of null[\s\S]*map-import-routes\.mjs:71/,
})
const typingMember = await typingMemberProbe()

console.log(JSON.stringify({
  node: process.version,
  controls,
  crashing_routes: { login_null: loginNull, map_import_null: mapImportNull, typing_member: typingMember },
}, null, 2))
