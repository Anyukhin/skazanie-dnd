// Правило «удар как в BG3» по умолчанию в идущих кампаниях.
//
// При старте сервер дописывает кампаниям событие включения правила
// (`enableDefaultHouseRules`, server/index.mjs). Здесь — то, что видно только
// через настоящий рестарт: выбор ведущего «выключено» переживает перезапуск, а
// повторный старт ничего не дописывает в журнал. Решение «кого включать» само
// по себе сторожит `test/campaign-ruleset.test.mjs`.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaign, expectStatus, login, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const bg3 = (body) => body?.ruleset?.houseRules?.find((rule) => rule.id === 'house:bg3-opening-strike')

const campaignState = (code) => ({
  sessionCode: code, campaign: code, partyName: 'Отряд', partyMemberIds: ['hero'], activePlayerId: 'hero',
  isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
  players: [{
    id: 'hero', name: 'Игрок', character: 'Астер', hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], online: true, x: 0, y: 0,
  }],
  enemies: [],
  scene: {
    title: 'Привал', location: 'Привал', mood: 'Тихо', objective: 'Проверка', turn: 1,
    cells: [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y, type: 'floor', revealed: true }))),
  },
  adventure: { chapter: 1, history: [], visitedLocations: ['Привал'] },
  engine_mode: 'enforce',
})

test('выключенное ведущим правило BG3 переживает рестарт, а старт ничего не дублирует', { timeout: runnerTimeout(40_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-house-rule-default-' })
  const credentials = { email: 'admin@house-rule.test', password: 'very-secure-admin-password' }
  const admin = await setupAdmin(server, { name: 'Admin', ...credentials })
  for (const code of ['HR-ON', 'HR-OFF']) {
    await createCampaign(admin.client, { code, name: code, state: campaignState(code) })
  }
  expectStatus(await admin.client.patch('/api/campaigns/HR-OFF/settings', {
    idempotency_key: 'hr-off', houseRules: { 'house:bg3-opening-strike': false },
  }), 200)
  const versions = {}
  for (const code of ['HR-ON', 'HR-OFF']) {
    versions[code] = (await admin.client.get(`/api/rooms/${code}`)).body.state.state_version
  }

  await server.restart()
  const client = await login(server, credentials)
  // Проверка правил идёт фоном через 250 мс после старта — даём ей пройти.
  await new Promise((resolve) => setTimeout(resolve, 1_500))

  assert.equal(bg3((await client.get('/api/campaigns/HR-ON/settings')).body)?.enabled, true, 'новая кампания играет с ударом как в BG3')
  assert.equal(bg3((await client.get('/api/campaigns/HR-OFF/settings')).body)?.enabled, false, 'выбор ведущего важнее умолчания')
  for (const code of ['HR-ON', 'HR-OFF']) {
    const room = await client.get(`/api/rooms/${code}`)
    assert.equal(room.body.state.state_version, versions[code], `${code}: рестарт ничего не дописал в журнал`)
  }
})
