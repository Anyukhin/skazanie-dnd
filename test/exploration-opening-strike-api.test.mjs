// Удар из исследования по настоящему HTTP-пути.
//
// Движок разворачивает удар вне боя в «инициатива + удар»
// (test/exploration-opening-strike.test.mjs). Здесь проверяется то, что
// живёт над движком: обычный игрок шлёт свою команду атаки без кнопки
// «Начать бой», ответ проходит сверку отпечатка атаки даже тогда, когда удар
// отложен до хода героя, ходы NPC после такого старта проходят, как после
// «Начать бой», а повтор с тем же ключом возвращает прежний коммит.
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { palaceFixture } from './shared-npc-consequence-fixture.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function startServer({ port, storage, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: setupToken,
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* сообщение ниже покажет сырое тело */ }
  return { response, status: response.status, body: json, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)
}

function cells() {
  const result = []
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 9; x += 1) result.push({ x, y, type: 'floor', revealed: true })
  }
  return result
}

const currentActor = (state) => state?.mechanics?.combat?.initiative?.[state.mechanics.combat.active_index]?.actor_id ?? null
const eventOf = (result, type) => (result?.mechanics ?? []).find((candidate) => candidate.event_type === type)

test('удар из исследования открывает бой по HTTP-пути игрока', { timeout: runnerTimeout(30_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-opening-strike-'))
  const setupToken = 'opening-strike-setup-token'
  let logs = ''
  const log = () => logs
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Admin', email: 'admin@opening-strike.test', password: 'very-secure-admin-password', setupToken },
  })
  assertStatus(setup, 201, log)
  const adminCookie = sessionCookie(setup)
  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Player', email: 'player@opening-strike.test', password: 'very-secure-player-password' },
  })
  assertStatus(registered, 201, log)
  const playerCookie = sessionCookie(registered)

  const state = {
    sessionCode: 'OPEN-STRIKE',
    campaign: 'Opening strike',
    partyName: 'HTTP party',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero', name: 'Player', character: 'Aster', hp: 60, maxHp: 60, armor: 18, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], online: true, x: 0, y: 1,
      attackBonus: 7, damageDice: 6, damageBonus: 2, damageType: 'slashing', attackRange: 5,
    }],
    enemies: [{
      id: 'sentinel', name: 'Stone Sentinel', hp: 60, maxHp: 60, armor: 11, speed: 30,
      attackBonus: 4, damageDice: 4, damageBonus: 1, damageType: 'bludgeoning', attackRange: 5,
      abilities: { str: 14, dex: 12, con: 14, int: 6, wis: 10, cha: 5 }, proficiency: 2, x: 1, y: 1, alive: true,
    }],
    scene: { title: 'Привал', location: 'Привал', mood: 'Тихо', objective: 'Проверка', turn: 1, cells: cells() },
    tacticalTurn: { sceneTurn: 1, actorId: 'hero', movementSpent: 0, actionUsed: false },
    adventure: { chapter: 1, history: [], visitedLocations: ['Привал'] },
    engine_mode: 'enforce',
  }
  for (const code of ['OPEN-STRIKE', 'OPEN-BG3']) {
    assertStatus(await request(baseUrl, '/api/campaigns', {
      method: 'POST', cookie: adminCookie, body: { code, name: state.campaign, state: { ...state, sessionCode: code } },
    }), 201, log)
  }
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const player = users.body.users.find((candidate) => candidate.email === 'player@opening-strike.test')
  assertStatus(await request(baseUrl, `/api/admin/users/${player.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  }), 200, log)

  const strike = (key, targetId = 'sentinel', code = 'OPEN-STRIKE') => request(baseUrl, `/api/campaigns/${code}/commands`, {
    method: 'POST',
    cookie: playerCookie,
    body: { idempotency_key: key, message: 'Атаковать выбранную цель', command: { command_type: 'MakeAttack', actor_id: 'hero', target_id: targetId } },
  })
  const bg3Rule = (body) => body?.ruleset?.houseRules?.find((rule) => rule.id === 'house:bg3-opening-strike')
  const setBg3 = (cookie, key, enabled, code = 'OPEN-STRIKE') => request(baseUrl, `/api/campaigns/${code}/settings`, {
    method: 'PATCH', cookie, body: { idempotency_key: key, houseRules: { 'house:bg3-opening-strike': enabled } },
  })

  // Новая кампания получает правило BG3 по умолчанию; переключает его только
  // ведущий, событием в журнале кампании.
  const settings = await request(baseUrl, '/api/campaigns/OPEN-STRIKE/settings', { cookie: adminCookie })
  assertStatus(settings, 200, log)
  assert.equal(bg3Rule(settings.body)?.enabled, true, 'новая кампания играет с ударом как в BG3')
  assert.equal((await setBg3(playerCookie, 'bg3-off-player', false)).status, 403, 'игрок правило не переключает')
  const disabled = await setBg3(adminCookie, 'bg3-off', false)
  assertStatus(disabled, 200, log)
  assert.equal(bg3Rule(disabled.body)?.enabled, false)
  const repeated = await setBg3(adminCookie, 'bg3-off', false)
  assertStatus(repeated, 200, log)
  const exploringRoom = await request(baseUrl, '/api/rooms/OPEN-STRIKE', { cookie: playerCookie })
  assert.ok(!exploringRoom.body.state.enabled_house_rules.includes('house:bg3-opening-strike'), 'выключение дошло до состояния')
  const unknownRule = await request(baseUrl, '/api/campaigns/OPEN-STRIKE/settings', {
    method: 'PATCH', cookie: adminCookie, body: { idempotency_key: 'bad-rule', houseRules: { 'house:no-such-rule': true } },
  })
  assert.equal(unknownRule.status, 400)
  assert.equal(unknownRule.body.code, 'HOUSE_RULE_NOT_TOGGLEABLE', 'переключаются только объявленные правила')

  const opened = await strike('opening-strike-1')
  assertStatus(opened, 200, log)
  const combatStarted = eventOf(opened.body, 'CombatStarted')
  assert.ok(combatStarted, 'удар из исследования обязан открыть бой')
  const opening = combatStarted.payload.opening_action
  assert.equal(opening.actor_id, 'hero')
  assert.equal(opening.command_type, 'MakeAttack')
  assert.ok(['resolved', 'deferred'].includes(opening.status))
  t.diagnostic(`opening_action.status: ${opening.status}`)
  const attack = eventOf(opened.body, 'AttackResolved')
  if (opening.status === 'resolved') {
    assert.equal(attack?.actor_id, 'hero', 'герой первый — удар исполнен сразу')
  } else {
    assert.notEqual(attack?.actor_id, 'hero', 'враг первый — удар героя ждёт его хода')
  }
  const after = opened.body.authoritative_state
  assert.equal(after.mechanics.combat.active, true)
  assert.equal(currentActor(after), 'hero', 'ходы NPC после старта проходят, и управление возвращается герою')

  // Повтор с тем же ключом — тот же коммит, второго боя и второго удара нет.
  const replay = await strike('opening-strike-1')
  assertStatus(replay, 200, log)
  const room = await request(baseUrl, '/api/rooms/OPEN-STRIKE', { cookie: playerCookie })
  assert.equal(room.body.state.state_version, after.state_version, 'повтор ничего не дописал')

  // Тот же ключ с другой целью — конфликт, а не новый удар.
  const conflict = await strike('opening-strike-1', 'hero')
  assert.notEqual(conflict.status, 200)

  // Посреди боя правила боя не меняют.
  const midCombat = await setBg3(adminCookie, 'bg3-on-mid-combat', true)
  assert.equal(midCombat.status, 409)
  assert.equal(midCombat.body.code, 'HOUSE_RULE_DURING_COMBAT')

  // Кампания с правилом BG3: удар проходит сразу при любой инициативе.
  const free = await strike('bg3-strike-1', 'sentinel', 'OPEN-BG3')
  assertStatus(free, 200, log)
  const freeStart = eventOf(free.body, 'CombatStarted')
  assert.equal(freeStart.payload.opening_action.free_strike, true)
  assert.equal(freeStart.payload.opening_action.status, 'resolved')
  t.diagnostic(`BG3: первым ходит ${freeStart.payload.opening_action.first_actor_id}`)
  const freeAttack = (free.body.mechanics ?? []).find((candidate) => candidate.event_type === 'AttackResolved' && candidate.actor_id === 'hero')
  assert.ok(freeAttack, 'удар героя состоялся до чьего-либо хода')
  assert.equal(freeAttack.house_rule_id, 'house:bg3-opening-strike')
  assert.equal(currentActor(free.body.authoritative_state), 'hero', 'ход возвращается герою')
  assert.notEqual(free.body.authoritative_state.mechanics.combat.action_economy.hero?.action, false, 'и он целый')

  // Нейтральный NPC: та же команда атаки игрока, цель — король из авторской
  // сцены. HTTP пропускает NPC сцены как цель, остальное решает движок.
  const palace = await palaceFixture({ kingHp: 20, witnesses: false })
  const cellsByKey = new Map(palace.state.scene.cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
  const near = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: palace.kingPoint.x + dx, y: palace.kingPoint.y + dy }))
    .find((point) => cellsByKey.get(`${point.x},${point.y}`)?.type === 'floor')
  const palaceState = {
    ...palace.state,
    sessionCode: 'OPEN-NPC',
    players: palace.state.players.map((hero) => hero.id === palace.heroId ? { ...hero, ...near } : hero),
    mechanics: { ...palace.state.mechanics, positions: { ...palace.state.mechanics.positions, [palace.heroId]: near } },
  }
  assertStatus(await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'OPEN-NPC', name: 'Дворец', state: palaceState },
  }), 201, log)
  assertStatus(await request(baseUrl, `/api/admin/users/${player.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero', palace.heroId] },
  }), 200, log)
  const npcStrike = await request(baseUrl, '/api/campaigns/OPEN-NPC/commands', {
    method: 'POST',
    cookie: playerCookie,
    body: { idempotency_key: 'npc-strike-1', message: 'Атаковать короля', command: { command_type: 'MakeAttack', actor_id: palace.heroId, target_id: palace.kingId } },
  })
  assertStatus(npcStrike, 200, log)
  assert.ok(eventOf(npcStrike.body, 'EncounterCreated'), 'король становится участником встречи')
  const npcStart = eventOf(npcStrike.body, 'CombatStarted')
  assert.equal(npcStart.payload.opening_action.npc_id, palace.kingId)
  assert.ok((npcStrike.body.mechanics ?? []).some((candidate) => candidate.event_type === 'AttackResolved' && candidate.target_ids?.[0] === palace.kingId),
    'удар по королю состоялся сразу — правило BG3 включено в новой кампании')
  // Чужой NPC, которого в кампании нет, — по-прежнему отказ политики игрока.
  const ghost = await request(baseUrl, '/api/campaigns/OPEN-NPC/commands', {
    method: 'POST',
    cookie: playerCookie,
    body: { idempotency_key: 'npc-strike-ghost', message: 'Атаковать', command: { command_type: 'MakeAttack', actor_id: palace.heroId, target_id: 'no-such-npc' } },
  })
  assert.equal(ghost.body?.code, 'INVALID_ATTACK_TARGET')
})
