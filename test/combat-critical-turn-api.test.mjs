import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUser, setupAdmin, startTestServer } from './kit/http.mjs'

// Полный прогон 2026-10-13: `authoritative-combat-api` раз в двадцать запусков
// падал на «ход завершён» — враг выбрасывал натуральную 20. Критический удар
// зовёт рассказчика, без модели тот молчит, а конец хода стоял только на его
// реплике. Строка боя оставалась с `turnConsumed: false`, и в кампании без
// ключа ход терялся на каждом критическом ударе. Сцена критического удара —
// добавка к строке боя, а не её замена.

const assertStatus = (result, expected, log) => assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-3000)}`)

function battleState() {
  const cells = []
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 10; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  const hero = (id, character, x) => ({
    id, name: character, character, characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x, y: 1,
  })
  return {
    sessionCode: 'CRITICAL-TURN', campaign: 'Критический удар', partyMemberIds: ['mirel', 'borin'], activePlayerId: 'mirel',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [hero('mirel', 'Мирель', 1), hero('borin', 'Борин', 8)],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 59, maxHp: 59, armor: 11, speed: 40, attackBonus: 6, damageDice: 8, damageBonus: 4,
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, title: 'Причал', location: 'critical-turn', cells },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'mirel', total: 20 }, { actor_id: 'ogre', total: 12 }, { actor_id: 'borin', total: 5 }],
      action_economy: Object.fromEntries(['mirel', 'ogre', 'borin'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) } },
    engine_mode: 'enforce',
  }
}

test('критический удар врага без модели: конец хода остаётся на строке боя', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-combat-critical-turn-',
    preload: 'test/fixtures/combat-critical-deterministic-dice.mjs',
  })
  const log = () => server.output()
  const { client: admin } = await setupAdmin(server, { name: 'Мастер стенда', email: 'admin@critical-turn.test', password: 'critical-turn-admin-password' })
  const { client: player } = await registerUser(server, { name: 'Игрок стенда', email: 'player@critical-turn.test', password: 'critical-turn-player-password' })
  assertStatus(await admin.post('/api/campaigns', { code: 'CRITICAL-TURN', name: 'Критический удар', state: battleState() }), 201, log)
  const users = await admin.get('/api/admin/users')
  const playerUser = users.body.users.find((entry) => entry.email === 'player@critical-turn.test')
  assertStatus(await admin.patch(`/api/admin/users/${playerUser.id}`, { heroIds: ['mirel', 'borin'] }), 200, log)

  const ended = await player.post('/api/campaigns/CRITICAL-TURN/commands', {
    idempotency_key: 'mirel-ends-turn', command: { command_type: 'EndTurn', actor_id: 'mirel' },
  })
  assertStatus(ended, 200, log)
  const strike = ended.body.mechanics.find((event) => event.event_type === 'AttackResolved' && event.actor_id === 'ogre')
  assert.equal(strike?.payload?.critical, true, 'огр бьёт критом — так задано костями')
  assert.equal(ended.body.creative_trigger?.kind, 'critical_hit')
  assert.equal(ended.body.narration_author, 'Система боя', 'без модели рассказчик молчит — ход читается строкой боя')

  const messages = ended.body.authoritative_state.messages
  const line = messages.find((message) => message.id === ended.body.narration_message_id)
  assert.ok(line, 'строка боя в летописи')
  assert.match(line.text, /Огр/u)
  assert.equal(line.turnConsumed, true, 'конец хода — на строке боя')
  assert.ok(!messages.some((message) => message.speaker === 'narrator' && message.author === 'Рассказчик' && message.id !== line.id && message.turnConsumed),
    'вторая отметка конца хода не появилась')
})
