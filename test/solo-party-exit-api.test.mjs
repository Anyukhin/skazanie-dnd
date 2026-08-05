import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error('Тестовый сервер завершился')
    try {
      const response = await fetch(baseUrl + '/api/health')
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Тестовый сервер не запустился')
}

function cookie(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

async function soloCampaign(t, { code, quests = [] }) {
  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = 'http://127.0.0.1:' + port
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-solo-'))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: 'deterministic-policy-test', ADMIN_SETUP_TOKEN: 'solo-setup-token', COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode == null) child.kill() })
  await waitForHealth(baseUrl, child)

  const setup = await fetch(baseUrl + '/api/auth/setup-admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Solo', email: 'solo@exit.test', password: 'very-secure-password', setupToken: 'solo-setup-token' }),
  })
  assert.equal(setup.status, 201)
  const adminCookie = cookie(setup)

  const created = await fetch(baseUrl + '/api/campaigns', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      code,
      state: {
        sessionCode: code, campaign: 'Solo test', activePlayerId: 'lira', isNarrating: false,
        pendingCheck: null, agentInteraction: null, suggestions: [], messages: [],
        // Один герой — один голосующий. Ровно тот случай, ради которого карточка
        // и пропускается.
        players: [{ id: 'lira', character: 'Лира', hp: 10, maxHp: 10, armor: 14, abilities: {}, proficiency: 2, inventory: [], online: true }],
        scene: { title: 'Подземелье', location: 'Нижний зал', mood: '', objective: 'Найти выход', turn: 4, cells: [] },
        adventure: { chapter: 1, visitedLocations: ['Нижний зал'], history: [] },
        ...(quests.length ? { worldMemory: { quests } } : {}),
      },
    }),
  })
  assert.equal(created.status, 201)
  return { baseUrl, adminCookie }
}

test('соло-стол уходит из локации без карточки голосования', { timeout: runnerTimeout(60_000) }, async (t) => {
  const { baseUrl, adminCookie } = await soloCampaign(t, { code: 'SOLO-EXIT' })

  const narrated = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ campaignId: 'SOLO-EXIT', action: 'Предлагаю покинуть локацию «Нижний зал»', idempotency_key: 'solo-exit-1' }),
  })
  assert.equal(narrated.status, 200)
  const result = await narrated.json()

  // Карточки нет, а сцена уже сменилась: решение исполнено тем же запросом.
  assert.ok(!result.effects.interaction, 'соло-столу карточка голосования не открывается')
  assert.equal(result.turn_consumed, true)
  assert.notEqual(result.effects.scene.scene.location, 'Нижний зал')
  assert.equal(result.effects.scene.adventure.chapter, 2)

  const room = await (await fetch(baseUrl + '/api/rooms/SOLO-EXIT', { headers: { Cookie: adminCookie } })).json()
  // Решение записано и потреблено переходом: висящей карточки в состоянии нет.
  assert.equal(room.state.agentInteraction, null)
  assert.notEqual(room.state.scene.location, 'Нижний зал')

  // Повтор того же ключа не открывает второе решение и не уводит отряд дважды.
  const repeated = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ campaignId: 'SOLO-EXIT', action: 'Предлагаю покинуть локацию «Нижний зал»', idempotency_key: 'solo-exit-1' }),
  })
  assert.equal(repeated.status, 200)
  const afterRepeat = await (await fetch(baseUrl + '/api/rooms/SOLO-EXIT', { headers: { Cookie: adminCookie } })).json()
  assert.equal(afterRepeat.state.agentInteraction, null)
  assert.equal(afterRepeat.state.scene.location, room.state.scene.location)
  assert.equal(afterRepeat.state.adventure.chapter, room.state.adventure.chapter)
})

test('соло-стол бросает задание своими словами, без третьего варианта в карточке', { timeout: runnerTimeout(60_000) }, async (t) => {
  const { baseUrl, adminCookie } = await soloCampaign(t, {
    code: 'SOLO-DROP',
    quests: [{
      id: 'quest:main', title: 'Найти печать архивариуса', summary: 'Печать пропала из архива.',
      status: 'active', visibility: 'party', objectives: ['Найти печать'], clock: { current: 1, max: 6, label: 'Соперники' },
    }],
  })

  const narrated = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ campaignId: 'SOLO-DROP', action: 'Уходим отсюда и бросаем задание', idempotency_key: 'solo-drop-1' }),
  })
  assert.equal(narrated.status, 200)
  const result = await narrated.json()
  assert.ok(!result.effects.interaction, 'соло-столу карточка голосования не открывается')
  assert.equal(result.turn_consumed, true)
  assert.equal(result.director_transition.abandoned_quest_id, 'quest:main')

  const room = await (await fetch(baseUrl + '/api/rooms/SOLO-DROP', { headers: { Cookie: adminCookie } })).json()
  const quest = room.state.worldMemory.quests.find((item) => item.id === 'quest:main')
  // Часы стояли на 1 из 6: обычная развязка здесь запрещена, а отказ разрешён.
  assert.equal(quest.status, 'abandoned')
  assert.notEqual(room.state.scene.location, 'Нижний зал')
})

test('уйти без слов об отказе не закрывает задание', { timeout: runnerTimeout(60_000) }, async (t) => {
  const { baseUrl, adminCookie } = await soloCampaign(t, {
    code: 'SOLO-KEEP',
    quests: [{
      id: 'quest:main', title: 'Найти печать архивариуса', summary: 'Печать пропала из архива.',
      status: 'active', visibility: 'party', objectives: ['Найти печать'], clock: { current: 1, max: 6, label: 'Соперники' },
    }],
  })

  const narrated = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ campaignId: 'SOLO-KEEP', action: 'Уходим отсюда', idempotency_key: 'solo-keep-1' }),
  })
  assert.equal(narrated.status, 200)
  const result = await narrated.json()
  assert.ok(!result.effects.interaction, 'соло-столу карточка голосования не открывается')
  assert.equal(result.director_transition.abandoned_quest_id, null)

  const room = await (await fetch(baseUrl + '/api/rooms/SOLO-KEEP', { headers: { Cookie: adminCookie } })).json()
  assert.equal(room.state.worldMemory.quests.find((item) => item.id === 'quest:main').status, 'active')
  assert.notEqual(room.state.scene.location, 'Нижний зал')
})
