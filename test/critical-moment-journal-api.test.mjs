import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUser, setupAdmin, startTestServer } from './kit/http.mjs'

// Боевой плейтест 2026-10-03: свой удар, сваливший врага, игрок видел в хронике
// без единого числа, а удары врага — с числами. Критический момент рассказчика
// заменял строку системы боя целиком. Теперь лог ложится перед рассказчиком.

const assertStatus = (result, expected, log) => assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)

test('враг, сваленный своим ударом: в хронике и лог системы боя, и рассказчик', { timeout: runnerTimeout(30_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-critical-journal-' })
  const log = () => server.output()
  const { client: admin } = await setupAdmin(server, { name: 'Мастер стенда', email: 'admin@critical-journal.test', password: 'critical-journal-admin-password' })
  const { client: player } = await registerUser(server, { name: 'Игрок стенда', email: 'player@critical-journal.test', password: 'critical-journal-player-password' })
  const cells = []
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 9; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  const initial = {
    sessionCode: 'CRIT-JOURNAL', campaign: 'Хроника удара', partyMemberIds: ['hero'], activePlayerId: 'hero',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [{ id: 'hero', name: 'Маг', character: 'Маг', characterClass: 'wizard', level: 5,
      hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1,
      knownSpellIds: ['magic-missile'], preparedSpellIds: ['magic-missile'] }],
    enemies: [{ id: 'raider', name: 'Налётчик', hp: 1, maxHp: 11, armor: 12, speed: 30, attackBonus: 3, damageDice: 6, damageBonus: 1,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 5, y: 1, alive: true }],
    scene: { turn: 1, title: 'Полигон', location: 'critical-journal', cells },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'raider', total: 5 }],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
    engine_mode: 'enforce',
  }
  const created = await admin.post('/api/campaigns', { code: 'CRIT-JOURNAL', name: initial.campaign, state: initial })
  assertStatus(created, 201, log)
  // Импорт состояния без журнала получает пустой журнал: клиент перебирает его
  // на первом рендере и падал на «messages is not iterable».
  assert.deepEqual(created.body.state.messages, [])
  const users = await admin.get('/api/admin/users')
  const playerUser = users.body.users.find((entry) => entry.email === 'player@critical-journal.test')
  assertStatus(await admin.patch(`/api/admin/users/${playerUser.id}`, { heroIds: ['hero'] }), 200, log)

  const cast = await player.post('/api/campaigns/CRIT-JOURNAL/commands', {
    idempotency_key: 'missile-kill', message: 'Волшебная стрела',
    command: { command_type: 'CastSpell', actor_id: 'hero', spell_id: 'magic-missile', target_id: 'raider', slot_level: 1 },
  })
  assertStatus(cast, 200, log)
  assert.ok(cast.body.mechanics.some((entry) => entry.event_type === 'HitPointsReducedToZero'), 'стрела валит налётчика')
  assert.equal(cast.body.narration_author, 'Рассказчик', 'враг повержен — говорит рассказчик')

  const room = await player.get('/api/rooms/CRIT-JOURNAL')
  assertStatus(room, 200, log)
  const messages = room.body.state.messages
  const narrator = messages.findIndex((message) => message.id === cast.body.narration_message_id)
  assert.ok(narrator >= 0, 'текст рассказчика в хронике')
  assert.equal(messages[narrator].author, 'Рассказчик')
  const combatLog = messages.findIndex((message) => message.author === 'Система боя' && /Налётчик/u.test(message.text))
  assert.ok(combatLog >= 0, `строка системы боя в хронике: ${JSON.stringify(messages.map((message) => [message.author, message.text]))}`)
  assert.ok(combatLog < narrator, 'лог идёт перед рассказчиком')
  assert.match(messages[combatLog].text, /\d/u, 'у своей стрелы видно число')

  // Повтор того же ключа хронику не удваивает.
  const replay = await player.post('/api/campaigns/CRIT-JOURNAL/commands', {
    idempotency_key: 'missile-kill', message: 'Волшебная стрела',
    command: { command_type: 'CastSpell', actor_id: 'hero', spell_id: 'magic-missile', target_id: 'raider', slot_level: 1 },
  })
  assertStatus(replay, 200, log)
  const after = await player.get('/api/rooms/CRIT-JOURNAL')
  assert.equal(after.body.state.messages.filter((message) => message.author === 'Система боя' && message.text === messages[combatLog].text).length, 1)
})
