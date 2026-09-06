import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('два игрока обсуждают и спрашивают вне своего хода без бросков, перехода и изменения механики', { timeout: runnerTimeout(30_000) }, async (t) => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'skazanie-dialogue-api-')), ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'dialogue-test-setup', COOKIE_SECURE: 'false', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => { logs += String(chunk) })
  child.stderr.on('data', (chunk) => { logs += String(chunk) })
  t.after(() => { if (child.exitCode == null) child.kill() })
  let ready = false
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break } } catch { /* Сервер ещё запускается. */ }
    if (child.exitCode != null) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(ready, logs)
  const request = async (path, cookie, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const admin = await request('/api/auth/setup-admin', null, { name: 'Ведущий', email: 'gm@dialogue.test', password: 'dialogue-test-password', setupToken: 'dialogue-test-setup' })
  assert.equal(admin.status, 201, JSON.stringify(admin.body))
  const users = []
  for (const [id, name] of [['hero1', 'Лира'], ['hero2', 'Борин']]) {
    const registered = await request('/api/auth/register', null, { name, email: `${id}@dialogue.test`, password: 'dialogue-test-password' })
    assert.equal(registered.status, 201)
    const accounts = await request('/api/admin/users', admin.cookie)
    const user = accounts.body.users.find((entry) => entry.email === `${id}@dialogue.test`)
    assert.equal((await request(`/api/admin/users/${user.id}`, admin.cookie, { heroIds: [id] }, 'PATCH')).status, 200)
    users.push({ id, name, cookie: registered.cookie })
  }
  const state = {
    sessionCode: 'DIALOGUE-API', campaign: 'Разговор за столом', activePlayerId: 'hero1', partyMemberIds: ['hero1', 'hero2'],
    isNarrating: false, pendingCheck: null, suggestions: [], messages: [], enemies: [{ id: 'guard', name: 'Страж', hp: 20, maxHp: 20, armor: 14, alive: true, x: 2, y: 0 }], entities: [], merchants: [], economyLog: [],
    players: users.map(({ id, name }, i) => ({ id, name, character: name, role: 'Воин', characterClass: 'fighter', level: 1, hp: 12, maxHp: 12, armor: 14, speed: 30, x: i, y: 0, abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], currency: { gold: 5 }, online: true })),
    scene: { title: 'Караульная', location: 'Караульная', mood: 'Тихо', objective: 'Поговорить', turn: 0, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }, { x: 2, y: 0, type: 'floor', revealed: true }] },
    mechanics: { combat: { active: true, initiative: [{ actor_id: 'hero1', total: 20 }, { actor_id: 'hero2', total: 10 }, { actor_id: 'guard', total: 5 }], active_index: 0, round: 1 } },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], state_version: 0,
  }
  const created = await request('/api/campaigns', admin.cookie, { code: state.sessionCode, name: state.campaign, state })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const before = await request('/api/rooms/DIALOGUE-API', users[1].cookie)
  assert.equal(before.status, 200)
  assert.equal(before.body.state.mechanics.combat.active, true)
  const send = (user, body) => request('/api/narrate', user.cookie, { campaign_id: state.sessionCode, actor_id: user.id, ...body })

  const question = await send(users[1], { action: 'Могу ли я атаковать?', idempotency_key: 'off-turn-question' })
  assert.equal(question.status, 200, JSON.stringify(question.body))
  assert.equal(question.body.request_kind, 'question')
  assert.equal(question.body.turn_consumed, false)
  assert.equal(question.body.check ?? null, null)
  assert.deepEqual(question.body.mechanics, [])
  const discussionBody = { action: 'Давайте подождём товарища', idempotency_key: 'party-discussion' }
  const discussion = await send(users[1], discussionBody)
  assert.equal(discussion.status, 200, JSON.stringify(discussion.body))
  assert.equal(discussion.body.request_kind, 'discussion')
  assert.equal(discussion.body.narration, '', 'Ведущий не повторяет обсуждение от имени мира')
  assert.equal((await send(users[1], discussionBody)).status, 200)
  const travelQuestion = await send(users[1], { action: 'Предлагаю покинуть локацию', request_kind: 'question', idempotency_key: 'question-not-travel' })
  assert.equal(travelQuestion.status, 200, JSON.stringify(travelQuestion.body))
  assert.equal(travelQuestion.body.effects.interaction ?? null, null)
  assert.deepEqual(travelQuestion.body.mechanics, [])

  const unauthorized = await send(users[1], { actor_id: 'hero1', action: 'Что я знаю?', request_kind: 'question', idempotency_key: 'foreign-hero-question' })
  assert.equal(unauthorized.status, 403)
  const injectedRoll = await send(users[1], { action: 'Вопрос', request_kind: 'question', roll: { roll_id: 'must-not-consume' }, idempotency_key: 'question-with-roll' })
  assert.equal(injectedRoll.status, 400)
  assert.equal(injectedRoll.body.code, 'NON_ACTION_EXECUTION_FORBIDDEN')
  const actualAction = await send(users[1], { action: 'Атакую', request_kind: 'action', idempotency_key: 'off-turn-action' })
  assert.equal(actualAction.status, 409)
  assert.equal(actualAction.body.code, 'NOT_ACTIVE_ACTOR')

  const after = await request('/api/rooms/DIALOGUE-API', users[1].cookie)
  assert.equal(after.body.state.state_version, before.body.state.state_version)
  assert.deepEqual(after.body.state.mechanics, before.body.state.mechanics)
  assert.deepEqual(after.body.state.scene, before.body.state.scene)
  for (const user of users) {
    const room = await request('/api/rooms/DIALOGUE-API', user.cookie)
    assert.equal(room.body.state.messages.filter((message) => message.text === discussionBody.action).length, 1, 'Повтор сообщения не создаёт дубль у другого игрока')
    assert.ok(room.body.state.messages.some((message) => message.text === 'Могу ли я атаковать?'))
  }
})
