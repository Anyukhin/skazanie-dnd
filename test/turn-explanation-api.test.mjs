import assert from 'node:assert/strict'
import test from 'node:test'
import { addPlayer, createCampaign, registerUser, sendCommand, setupAdmin, startTestServer, createClient } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

function campaignState() {
  return {
    sessionCode: 'WHY-1', campaign: 'Разбор хода', activePlayerId: 'hero', isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
    partyMemberIds: ['hero'],
    players: [
      { id: 'hero', character: 'Герой', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true },
    ],
    enemies: [
      { id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, alive: true, x: 1, y: 0 },
    ],
    scene: { title: 'Зал', location: 'Hall', mood: '', objective: '', turn: 0, cells: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce', state_version: 0,
  }
}

test('разбор хода: трасса по id и последняя механическая, права и проекция зрителя', { timeout: runnerTimeout(20_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-turn-explanation-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: 'WHY-1', state: campaignState() })
  const { client: player } = await addPlayer(server, gm, 'WHY-1', { heroIds: ['hero'] })
  const { client: outsider } = await registerUser(server)
  const anon = createClient(server)

  // Нет ни одной трассы — 404 и по `latest`.
  const empty = await player.get('/api/campaigns/WHY-1/turns/latest/explanation')
  assert.equal(empty.status, 404)
  assert.deepEqual(empty.body, { error: 'Трассировка хода не найдена' })

  const own = await sendCommand(gm, 'WHY-1', 'why-damage-1', { command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'wolf', amount: 3, damage_type: 'slashing' }, { message: 'Рублю волка' })
  assert.equal(own.status, 200, own.text)
  assert.match(own.body.explanation_url, /^\/api\/campaigns\/WHY-1\/turns\/[A-Za-z0-9._-]+\/explanation$/)
  const enemyTurn = await sendCommand(gm, 'WHY-1', 'why-damage-2', { command_type: 'ApplyDamage', actor_id: 'wolf', target_id: 'hero', amount: 2, damage_type: 'piercing' })
  assert.equal(enemyTurn.status, 200, enemyTurn.text)

  // Свой ход по id: правило и событие на месте.
  const why = await player.get(own.body.explanation_url)
  assert.equal(why.status, 200, why.text)
  assert.ok(why.body.rules_used.includes('srd_5_2_1:combat:damage'))
  assert.equal(why.body.events[0].event_type, 'DamageApplied')

  // `latest` — последний механический ход (удар волка); команду врага игрок
  // видит только в общих чертах, ведущий — целиком.
  const latestForPlayer = await player.get('/api/campaigns/WHY-1/turns/latest/explanation')
  assert.equal(latestForPlayer.status, 200, latestForPlayer.text)
  assert.equal(latestForPlayer.body.turn_id, enemyTurn.body.explanation_url.split('/')[5])
  assert.deepEqual(latestForPlayer.body.commands, [{ type: 'ApplyDamage', actor_id: 'wolf', target_id: 'hero' }])
  const latestForGm = await gm.get('/api/campaigns/WHY-1/turns/latest/explanation')
  assert.equal(latestForGm.status, 200)
  assert.equal(latestForGm.body.commands[0].amount, 2)
  assert.equal(latestForGm.body.commands[0].damage_type, 'piercing')

  // Права: без входа — 401, чужой — 403, неизвестный ход — 404.
  assert.equal((await anon.get(own.body.explanation_url)).status, 401)
  const foreign = await outsider.get(own.body.explanation_url)
  assert.equal(foreign.status, 403)
  assert.deepEqual(foreign.body, { error: 'Нет доступа к этой кампании' })
  const missing = await player.get('/api/campaigns/WHY-1/turns/no-such-turn/explanation')
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.body, { error: 'Трассировка хода не найдена' })

  // Кампании нет: комната не проверяется — ведущему 404 трассы, игроку 403.
  assert.equal((await gm.get('/api/campaigns/NOPE-1/turns/latest/explanation')).status, 404)
  assert.equal((await player.get('/api/campaigns/NOPE-1/turns/latest/explanation')).status, 403)
  // Только GET.
  assert.equal((await player.post(own.body.explanation_url, {})).status, 404)
})
