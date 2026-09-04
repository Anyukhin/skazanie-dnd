import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился с кодом ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Тестовый сервер не запустился')
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

test('владелец выбирает 2014/2024 при создании и меняет редакцию только до первого игрового события', { timeout: runnerTimeout(30_000) }, async (t) => {
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-ruleset-api-'))
  let logs = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'ruleset-setup-token', COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(() => { if (child.exitCode == null) child.kill() })
  await waitForHealth(baseUrl, child)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Owner', email: 'ruleset@example.test', password: 'very-secure-password', setupToken: 'ruleset-setup-token' },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${logs}`)
  const rawSetup = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ruleset@example.test', password: 'very-secure-password' }),
  })
  assert.equal(rawSetup.status, 200)
  const cookie = rawSetup.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie)

  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Guest', email: 'ruleset-guest@example.test', password: 'very-secure-guest-password' },
  })
  assert.equal(guest.status, 201, guest.text)
  const guestCookie = guest.response.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(guestCookie)

  const classic = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'RULES-2014', name: 'Классика', bootstrap: { partyName: 'Отряд', slotCount: 2, world: {}, rulesetId: 'dnd_5e_2014' } },
  })
  assert.equal(classic.status, 201, `${classic.text}\n${logs}`)
  assert.equal(classic.body.state.ruleset_id, 'dnd_5e_2014')
  assert.equal(classic.body.state.ruleset_version, '2014.1.0')
  assert.deepEqual(classic.body.state.enabled_rule_packs, ['dnd_5e_2014'])
  assert.ok(classic.body.state.enabled_house_rules.includes('skazanie:2014-preview-legacy-catalogs-v1'))

  const initialSettings = await request(baseUrl, '/api/campaigns/RULES-2014/settings', { cookie })
  assert.equal(initialSettings.status, 200)
  assert.equal(initialSettings.body.ruleset.current.id, 'dnd_5e_2014')
  assert.equal(initialSettings.body.ruleset.canChange, true)

  const invite = await request(baseUrl, '/api/campaigns/RULES-2014/invites', {
    method: 'POST', cookie, body: { hero_ids: [classic.body.state.partyMemberIds[1]] },
  })
  assert.equal(invite.status, 201, invite.text)
  const joined = await request(baseUrl, '/api/campaigns/RULES-2014/join', {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)
  const guestSettings = await request(baseUrl, '/api/campaigns/RULES-2014/settings', { cookie: guestCookie })
  assert.equal(guestSettings.status, 200, guestSettings.text)
  assert.equal(guestSettings.body.canManage, false)
  assert.equal(guestSettings.body.ruleset.canChange, false)
  const guestSwitch = await request(baseUrl, '/api/campaigns/RULES-2014/settings', {
    method: 'PATCH', cookie: guestCookie,
    body: { rulesetId: 'srd_5_2_1', idempotency_key: 'ruleset-guest-switch' },
  })
  assert.equal(guestSwitch.status, 403, guestSwitch.text)

  const switched = await request(baseUrl, '/api/campaigns/RULES-2014/settings', {
    method: 'PATCH', cookie,
    body: { rulesetId: 'srd_5_2_1', idempotency_key: 'ruleset-switch-1' },
  })
  assert.equal(switched.status, 200, switched.text)
  assert.equal(switched.body.ruleset.current.id, 'srd_5_2_1')
  assert.equal(switched.body.ruleset.canChange, true)

  const switchedBack = await request(baseUrl, '/api/campaigns/RULES-2014/settings', {
    method: 'PATCH', cookie,
    body: { rulesetId: 'dnd_5e_2014', idempotency_key: 'ruleset-switch-2' },
  })
  assert.equal(switchedBack.status, 200, switchedBack.text)
  assert.equal(switchedBack.body.ruleset.current.id, 'dnd_5e_2014')

  const replayedOldSwitch = await request(baseUrl, '/api/campaigns/RULES-2014/settings', {
    method: 'PATCH', cookie,
    body: { rulesetId: 'srd_5_2_1', idempotency_key: 'ruleset-switch-1' },
  })
  assert.equal(replayedOldSwitch.status, 200, replayedOldSwitch.text)
  assert.equal(replayedOldSwitch.body.ruleset.current.id, 'dnd_5e_2014', 'retry старого ключа не возвращает историческое состояние')

  const paused = await request(baseUrl, '/api/campaigns/RULES-2014/lifecycle', {
    method: 'POST', cookie, body: { action: 'pause', idempotency_key: 'ruleset-lock-gameplay' },
  })
  assert.equal(paused.status, 200, paused.text)
  const locked = await request(baseUrl, '/api/campaigns/RULES-2014/settings', {
    method: 'PATCH', cookie,
    body: { rulesetId: 'srd_5_2_1', idempotency_key: 'ruleset-switch-locked' },
  })
  assert.equal(locked.status, 409)
  assert.equal(locked.body.code, 'CAMPAIGN_RULESET_LOCKED')

  const current = await request(baseUrl, '/api/campaigns/RULES-2014/settings', { cookie })
  assert.equal(current.body.ruleset.current.id, 'dnd_5e_2014')
  assert.equal(current.body.ruleset.locked, true)

  const revised = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'RULES-2024', name: 'Ревизия', bootstrap: { partyName: 'Отряд', slotCount: 1, world: {}, rulesetId: 'srd_5_2_1' } },
  })
  assert.equal(revised.status, 201, revised.text)
  assert.equal(revised.body.state.ruleset_id, 'srd_5_2_1')

  const unknown = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'RULES-BAD', name: 'Ошибка', bootstrap: { partyName: 'Отряд', slotCount: 1, world: {}, rulesetId: 'invented' } },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'RULESET_INVALID')

  const forged = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'RULES-FORGE', name: 'Подмена', bootstrap: { partyName: 'Отряд', slotCount: 1, world: {}, rulesetId: 'dnd_5e_2014', rulesetVersion: '999' } },
  })
  assert.equal(forged.status, 400)
  assert.equal(forged.body.code, 'RULESET_FIELDS_SERVER_OWNED')

  const imported = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: {
      code: 'RULES-IMPORT', name: 'Импорт',
      state: {
        ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
        enabled_rule_packs: ['dnd_5e_2014'], players: [], messages: [],
      },
    },
  })
  assert.equal(imported.status, 201, imported.text)
  assert.equal(imported.body.state.ruleset_selection_locked, true)
  const importedSettings = await request(baseUrl, '/api/campaigns/RULES-IMPORT/settings', { cookie })
  assert.equal(importedSettings.status, 200, importedSettings.text)
  assert.equal(importedSettings.body.ruleset.locked, true)
  assert.equal(importedSettings.body.ruleset.canChange, false)

  const forgedImport = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: {
      code: 'RULES-IMPORT-BAD', name: 'Подмена импорта',
      state: { ruleset_id: 'dnd_5e_2014', ruleset_version: '999', enabled_rule_packs: ['srd_5_2_1'] },
    },
  })
  assert.equal(forgedImport.status, 400)
  assert.equal(forgedImport.body.code, 'RULESET_FIELDS_SERVER_OWNED')

  const campaigns = await request(baseUrl, '/api/campaigns', { cookie })
  const summary = campaigns.body.campaigns.find((campaign) => campaign.code === 'RULES-2014')
  assert.equal(summary.rulesetId, 'dnd_5e_2014')
  assert.equal(summary.rulesetVersion, '2014.1.0')
})
