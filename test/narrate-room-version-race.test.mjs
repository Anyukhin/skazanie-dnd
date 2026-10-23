import assert from 'node:assert/strict'
import test from 'node:test'
import { startTestServer } from './kit/http.mjs'
import { startFakeProvider } from './kit/llm.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion below reports the raw body */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, status, log) {
  assert.equal(result.status, status, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object')
}

test('/api/narrate keeps its event projection authoritative while broad room PUT is retired', { timeout: 20_000 }, async (t) => {
  const setupToken = 'narrate-version-race-setup-token'
  let releaseProvider
  let providerStarted
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const providerRequest = new Promise((resolve) => { providerStarted = resolve })

  // Первым: отпустить задержанный ответ провайдера раньше остановки серверов.
  t.after(() => { releaseProvider() })

  // Прочие пути провайдера — 404 (обработчик возвращает undefined).
  const provider = await startFakeProvider(t, async (incoming) => {
    if (incoming.method !== 'POST' || incoming.url !== '/api/v1/chat/completions') return undefined
    providerStarted()
    await providerGate
    return {
      model: 'fake-room-version-model',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            narration: 'Бранн внимательно осматривает место встречи, отмечая следы недавнего присутствия.',
            suggestions: ['Проверить следы у входа'],
            turn_consumed: true,
            action_kind: 'substantive',
          }),
        },
      }],
    }
  })

  const server = await startTestServer(t, {
    setupToken,
    storagePrefix: 'skazanie-narrate-version-race-',
    env: provider.env,
  })
  const { baseUrl } = server
  const log = server.output

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Version Race Admin',
      email: 'admin@narrate-version-race.test',
      password: 'very-secure-admin-password',
      setupToken,
    },
  })
  assertStatus(setup, 201, log)
  const adminCookie = cookie(setup)

  const state = {
    sessionCode: 'VERSION-RACE',
    campaign: 'Narration version race',
    activePlayerId: 'brann',
    isNarrating: false,
    pendingCheck: null,
    agentInteraction: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'brann', character: 'Бранн', hp: 12, maxHp: 12, armor: 16,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 14, cha: 10 },
      proficiency: 2, inventory: [], online: true,
    }],
    scene: { title: 'Место встречи', location: 'Кольцевая станция «Гелиос»', mood: '', objective: '', turn: 1, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Кольцевая станция «Гелиос»'], history: [] },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'VERSION-RACE', state },
  })
  assertStatus(created, 201, log)
  const initialVersion = created.body.version

  const narrationPromise = request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: adminCookie,
    body: {
      campaignId: 'VERSION-RACE',
      action: 'Осмотреть место встречи',
      idempotency_key: 'narrate-room-version-race-1',
    },
  })

  await providerRequest

  const roomBeforePending = await request(baseUrl, '/api/rooms/VERSION-RACE', { cookie: adminCookie })
  assertStatus(roomBeforePending, 200, log)
  assert.ok(roomBeforePending.body.version >= initialVersion,
    'recovery projection may advance the compatibility-room version while narration is pending')

  const retiredWrite = await request(baseUrl, '/api/rooms/VERSION-RACE', {
    method: 'PUT', cookie: adminCookie,
    body: { state: roomBeforePending.body.state, baseVersion: roomBeforePending.body.version },
  })
  assertStatus(retiredWrite, 410, log)
  assert.equal(retiredWrite.body.code, 'ROOM_MUTATION_RETIRED')

  releaseProvider()
  const narrated = await narrationPromise
  assertStatus(narrated, 200, log)
  const finalRoom = await request(baseUrl, '/api/rooms/VERSION-RACE', { cookie: adminCookie })
  assertStatus(finalRoom, 200, log)
  assert.ok(narrated.body.room_version >= roomBeforePending.body.version,
    'narrate must return an authoritative projection at least as recent as the read before it committed')
  assert.equal(narrated.body.room_version, finalRoom.body.version,
    'narrate must return the version of its final authoritative state')
})
