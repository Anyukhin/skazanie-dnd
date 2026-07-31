import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился с кодом ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response
    } catch { /* сервер ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Тестовый сервер не запустился')
}

test('совместимый API создаёт кампанию, исполняет enforce-команду, ищет правила и объясняет /why', { timeout: 20_000 }, async (t) => {
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-api-'))
  let logs = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'integration-setup-token', GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(() => { if (child.exitCode == null) child.kill() })

  const health = await waitForHealth(baseUrl, child)
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
  const healthBody = await health.json()
  assert.equal(healthBody.rulesetId, 'srd_5_2_1')
  assert.equal(healthBody.ruleCount, 23)
  assert.equal('usage' in healthBody, false, 'public health must not expose cost or quota telemetry')
  const anonymousUsage = await fetch(`${baseUrl}/api/admin/usage`)
  assert.equal(anonymousUsage.status, 401)

  const setup = await fetch(`${baseUrl}/api/auth/setup-admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', email: 'admin@example.test', password: 'very-secure-password', setupToken: 'integration-setup-token' }),
  })
  assert.equal(setup.status, 201, logs)
  const cookie = setup.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const headers = { 'Content-Type': 'application/json', Cookie: cookie }
  const usageResponse = await fetch(`${baseUrl}/api/admin/usage`, { headers: { Cookie: cookie } })
  assert.equal(usageResponse.status, 200)
  const usage = await usageResponse.json()
  assert.equal(usage.usage.daily_token_limit, 2_000_000)
  assert.equal(usage.usage.committed_tokens, 0)

  const state = {
    sessionCode: 'API-TEST', campaign: 'API test', activePlayerId: 'hero', isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
    players: [
      { id: 'hero', character: 'Герой', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true },
      { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], online: true },
    ],
    scene: { title: 'Зал', location: 'Hall', mood: '', objective: '', turn: 0, cells: [] },
    social: {
      npcs: [
        { id: 'marta', name: 'Marta', role: 'keeper', location: 'Hall', public_summary: 'Keeps the hall.', voice: 'Calm.', visibility: 'party', available: true },
        { id: 'borin', name: 'Borin', role: 'guard', location: 'Hall', public_summary: 'Guards the hall.', voice: 'Brief.', visibility: 'party', available: true },
        { id: 'far-npc', name: 'Far NPC', role: 'scout', location: 'Road', public_summary: 'Walks the road.', voice: 'Quiet.', visibility: 'party', available: true },
        { id: 'unavailable-npc', name: 'Unavailable NPC', role: 'scribe', location: 'Hall', public_summary: 'Is occupied.', voice: 'Quiet.', visibility: 'party', available: false },
      ],
      relationships: {},
      conversations: [],
      promises: [],
    },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce', state_version: 0,
  }
  const created = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers, body: JSON.stringify({ code: 'API-TEST', name: 'API test', state }) })
  const createdText = await created.text()
  assert.equal(created.status, 201, createdText)
  const modeResponse = await fetch(`${baseUrl}/api/campaigns/API-TEST/engine-mode`, { method: 'PATCH', headers, body: JSON.stringify({ mode: 'legacy' }) })
  assert.equal(modeResponse.status, 410)
  assert.equal((await modeResponse.json()).code, 'ENGINE_MODE_RETIRED')

  const ruleSearch = await fetch(`${baseUrl}/api/rules/search?q=${encodeURIComponent('Как работает помеха?')}&ruleset_id=srd_5_2_1`, { headers: { Cookie: cookie } })
  assert.equal(ruleSearch.status, 200)
  const searchResult = await ruleSearch.json()
  assert.equal(searchResult.results[0].rule_id, 'srd_5_2_1:core:advantage-disadvantage')
  assert.ok(searchResult.results[0].matched_by.length > 0)

  const commandBody = JSON.stringify({
    idempotency_key: 'api-damage-1', message: 'Нанести урон',
    command: { command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 3, damage_type: 'slashing' },
  })
  const first = await fetch(`${baseUrl}/api/campaigns/API-TEST/commands`, { method: 'POST', headers, body: commandBody })
  const firstText = await first.text()
  assert.equal(first.status, 200, firstText)
  const firstResult = JSON.parse(firstText)
  assert.equal(firstResult.authoritative_state.players[1].hp, 5)
  assert.equal(firstResult.mechanics[0].event_type, 'DamageApplied')

  const duplicate = await fetch(`${baseUrl}/api/campaigns/API-TEST/commands`, { method: 'POST', headers, body: commandBody })
  assert.equal(duplicate.status, 200)
  const duplicateResult = await duplicate.json()
  assert.equal(duplicateResult.authoritative_state.players[1].hp, 5)
  assert.equal(duplicateResult.idempotent_replay, true)

  const explanation = await fetch(`${baseUrl}${firstResult.explanation_url}`, { headers: { Cookie: cookie } })
  assert.equal(explanation.status, 200)
  const why = await explanation.json()
  assert.ok(why.rules_used.includes('srd_5_2_1:combat:damage'))
  assert.equal(why.events[0].event_type, 'DamageApplied')

  for (const [label, payload, code] of [
    ['state', { campaignId: 'API-TEST', action: '/why', idempotency_key: 'api-why-state', state: { sessionCode: 'API-TEST' } }, 'LEGACY_PAYLOAD_RETIRED'],
    ['player', { campaignId: 'API-TEST', action: '/why', idempotency_key: 'api-why-player', player: 'forged narrator' }, 'LEGACY_PAYLOAD_RETIRED'],
    ['mode', { campaignId: 'API-TEST', action: '/why', idempotency_key: 'api-why-mode', mode: 'legacy' }, 'LEGACY_PAYLOAD_RETIRED'],
    ['raw roll', { campaignId: 'API-TEST', action: '/why', idempotency_key: 'api-why-roll', roll: { value: 20, total: 999 } }, 'UNVERIFIED_ROLL'],
  ]) {
    const rejected = await fetch(`${baseUrl}/api/narrate`, { method: 'POST', headers, body: JSON.stringify(payload) })
    assert.equal(rejected.status, 400, label)
    assert.equal((await rejected.json()).code, code, label)
  }

  const validNarrate = await fetch(`${baseUrl}/api/narrate`, {
    method: 'POST', headers,
    body: JSON.stringify({ campaignId: 'API-TEST', action: '/why', idempotency_key: 'api-why-1' }),
  })
  assert.equal(validNarrate.status, 200)
  const compatibleResult = await validNarrate.json()
  assert.equal(compatibleResult.turn_consumed, false)
  assert.doesNotMatch(compatibleResult.narration, /999/)
  assert.match(compatibleResult.narration, /8 → 5/)

  const explicitSocialBody = {
    campaignId: 'API-TEST',
    action: 'Hello there.',
    actor_id: 'hero',
    npc_id: 'marta',
    idempotency_key: 'api-explicit-social',
  }
  const explicitSocial = await fetch(`${baseUrl}/api/narrate`, {
    method: 'POST', headers, body: JSON.stringify(explicitSocialBody),
  })
  const explicitSocialText = await explicitSocial.text()
  assert.equal(explicitSocial.status, 200, explicitSocialText)
  const explicitSocialResult = JSON.parse(explicitSocialText)
  assert.equal(explicitSocialResult.action_kind, 'social')
  assert.equal(explicitSocialResult.mechanics.some((event) => event.payload?.conversation?.npc_id === 'marta'), true)

  const explicitReplay = await fetch(`${baseUrl}/api/narrate`, {
    method: 'POST', headers, body: JSON.stringify(explicitSocialBody),
  })
  assert.equal(explicitReplay.status, 200)
  const explicitReplayResult = await explicitReplay.json()
  assert.equal(explicitReplayResult.idempotent_replay, true)
  assert.equal(explicitReplayResult.turn_id, explicitSocialResult.turn_id)

  for (const [label, body, status, code] of [
    ['different npc', { ...explicitSocialBody, npc_id: 'borin' }, 409, 'IDEMPOTENCY_CONFLICT'],
    ['different message', { ...explicitSocialBody, action: 'A different request.' }, 409, 'IDEMPOTENCY_CONFLICT'],
    ['forged npc', { ...explicitSocialBody, idempotency_key: 'forged-npc', npc_id: 'missing-npc' }, 400, 'NPC_NOT_VISIBLE'],
    ['wrong location', { ...explicitSocialBody, idempotency_key: 'far-npc', npc_id: 'far-npc' }, 400, 'NPC_WRONG_LOCATION'],
    ['unavailable', { ...explicitSocialBody, idempotency_key: 'unavailable-npc', npc_id: 'unavailable-npc' }, 400, 'NPC_UNAVAILABLE'],
    ['invalid id', { ...explicitSocialBody, idempotency_key: 'invalid-npc', npc_id: 'x'.repeat(121) }, 400, 'NPC_ID_INVALID'],
  ]) {
    const response = await fetch(`${baseUrl}/api/narrate`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    assert.equal(response.status, status, label)
    assert.equal((await response.json()).code, code, label)
  }

  const unknown = await fetch(`${baseUrl}/api/does-not-exist`, { headers: { Cookie: cookie } })
  assert.equal(unknown.status, 404)
})
