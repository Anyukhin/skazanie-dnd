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
    env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'integration-setup-token', GAME_ENGINE_MODE: 'shadow', COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(() => { if (child.exitCode == null) child.kill() })

  const health = await waitForHealth(baseUrl, child)
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
  const healthBody = await health.json()
  assert.equal(healthBody.rulesetId, 'srd_5_2_1')
  assert.equal(healthBody.ruleCount, 21)

  const setup = await fetch(`${baseUrl}/api/auth/setup-admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', email: 'admin@example.test', password: 'very-secure-password', setupToken: 'integration-setup-token' }),
  })
  assert.equal(setup.status, 201, logs)
  const cookie = setup.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const headers = { 'Content-Type': 'application/json', Cookie: cookie }

  const state = {
    sessionCode: 'API-TEST', campaign: 'API test', activePlayerId: 'hero', isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
    players: [
      { id: 'hero', character: 'Герой', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true },
      { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], online: true },
    ],
    scene: { title: 'Зал', location: '', mood: '', objective: '', turn: 0, cells: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'shadow', state_version: 0,
  }
  const created = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers, body: JSON.stringify({ code: 'API-TEST', name: 'API test', state }) })
  const createdText = await created.text()
  assert.equal(created.status, 201, createdText)
  const modeResponse = await fetch(`${baseUrl}/api/campaigns/API-TEST/engine-mode`, { method: 'PATCH', headers, body: JSON.stringify({ mode: 'enforce' }) })
  assert.equal(modeResponse.status, 200)

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

  const compatibleNarrate = await fetch(`${baseUrl}/api/narrate`, {
    method: 'POST', headers,
    body: JSON.stringify({ campaignId: 'API-TEST', action: '/why', idempotency_key: 'api-why-1', state: { sessionCode: 'API-TEST', activePlayerId: 'hero', players: [{ id: 'goblin', hp: 999 }] } }),
  })
  assert.equal(compatibleNarrate.status, 200)
  const compatibleResult = await compatibleNarrate.json()
  assert.equal(compatibleResult.turn_consumed, false)
  assert.doesNotMatch(compatibleResult.narration, /999/)
  assert.match(compatibleResult.narration, /8 → 5/)

  const unknown = await fetch(`${baseUrl}/api/does-not-exist`, { headers: { Cookie: cookie } })
  assert.equal(unknown.status, 404)
})
