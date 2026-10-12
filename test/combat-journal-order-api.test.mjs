import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'

// Плейтест 2026-10-10. Мирель отступила от огра, атака по возможности свалила
// её, а в хронике:
//  * строки атаки не было вовсе — маршрут команды ждал реплику рассказчика,
//    комнату за это время обогнала проекция хода огра, и устаревшая проекция
//    молча выбрасывала и лог, и реплику;
//  * реплика «Палица огра сбивает Мирель с ног…» пришла после хода огра и
//    только в браузере — после перезагрузки её не было;
//  * слова игрока к действию терялись.
// Теперь: реплика игрока → строка хода → реплика рассказчика → ход огра, и
// всё это переживает перезапуск сервера.

const NARRATION_DELAY_MS = 1_500
const assertStatus = (result, expected, log) => assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-3000)}`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function battleState() {
  const cells = []
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 10; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  const hero = (id, character, hp, x, extra = {}) => ({
    id, name: character, character, characterClass: 'fighter', level: 3, hp, maxHp: 24, armor: 12, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x, y: 1, ...extra,
  })
  return {
    sessionCode: 'JOURNAL-ORDER', campaign: 'Порядок хроники', partyMemberIds: ['mirel', 'borin'], activePlayerId: 'mirel',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [hero('mirel', 'Мирель', 3, 1), hero('borin', 'Борин', 24, 8)],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 59, maxHp: 59, armor: 11, speed: 40, attackBonus: 6, damageDice: 8, damageBonus: 4,
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, title: 'Причал', location: 'journal-order', cells },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'mirel', total: 20 }, { actor_id: 'ogre', total: 12 }, { actor_id: 'borin', total: 5 }],
      action_economy: Object.fromEntries(['mirel', 'ogre', 'borin'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) } },
    engine_mode: 'enforce',
  }
}

test('атака по возможности валит героя: реплика игрока, строка удара, рассказчик, ход огра — и всё переживает перезапуск', { timeout: runnerTimeout(60_000) }, async (t) => {
  // Рассказчик отвечает медленно: ровно то окно, в котором координатор раньше
  // успевал сыграть ход огра. Ответ — отказ, и реплику пишет запасной путь
  // рассказчика; важна не модель, а порядок и сохранность.
  const provider = await startFakeProvider(t, async (request) => {
    const system = String(request.body?.messages?.[0]?.content ?? '')
    if (/Health check|"ok":true/u.test(system) || /Health check/u.test(String(request.body?.messages?.[1]?.content ?? ''))) return chatCompletion({ ok: true })
    if (request.body?.stream === true) await wait(NARRATION_DELAY_MS)
    return { status: 503, json: { error: 'combat journal test: model disabled' } }
  })
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-combat-journal-order-',
    preload: 'test/fixtures/combat-journal-deterministic-dice.mjs',
    env: { ...provider.env, DND_AI_MODEL: 'test/text-model', DND_AI_FALLBACK_MODELS: '' },
  })
  const log = () => server.output()
  const { client: admin } = await setupAdmin(server, { name: 'Мастер стенда', email: 'admin@journal-order.test', password: 'journal-order-admin-password' })
  const { client: player } = await registerUser(server, { name: 'Игрок стенда', email: 'player@journal-order.test', password: 'journal-order-player-password' })
  assertStatus(await admin.post('/api/campaigns', { code: 'JOURNAL-ORDER', name: 'Порядок хроники', state: battleState() }), 201, log)
  const users = await admin.get('/api/admin/users')
  const playerUser = users.body.users.find((entry) => entry.email === 'player@journal-order.test')
  assertStatus(await admin.patch(`/api/admin/users/${playerUser.id}`, { heroIds: ['mirel', 'borin'] }), 200, log)

  const note = 'Мирель кричит «Держись, Борин!» и пятится от огра'
  const pending = player.post('/api/campaigns/JOURNAL-ORDER/commands', {
    idempotency_key: 'mirel-retreats', message: 'Переместить героя на клетку 0, 1', player_note: note,
    command: { command_type: 'MoveActor', actor_id: 'mirel', to: { x: 0, y: 1 } },
  })
  // Браузер в это время опрашивает комнату — именно такой опрос раньше будил
  // координатор, пока маршрут ждал рассказчика.
  await wait(400)
  assertStatus(await player.get('/api/rooms/JOURNAL-ORDER'), 200, log)
  const moved = await pending
  assertStatus(moved, 200, log)
  assert.ok(moved.body.mechanics.some((event) => event.event_type === 'AttackResolved' && event.actor_id === 'ogre'), 'огр бьёт вдогонку')
  assert.ok(moved.body.mechanics.some((event) => event.event_type === 'HitPointsReducedToZero'), 'атака валит Мирель')
  assert.equal(moved.body.narration_author, 'Рассказчик', 'падение героя — реплика рассказчика')
  assert.equal(moved.body.creative_trigger?.kind, 'hero_fallen')

  // Ход огра координатор играет сам, после реплики.
  let messages = []
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const room = await player.get('/api/rooms/JOURNAL-ORDER')
    messages = room.body.state.messages
    const narratorIndex = messages.findIndex((message) => message.id === moved.body.narration_message_id)
    if (narratorIndex >= 0 && messages.slice(narratorIndex + 1).some((message) => message.author === 'Система боя')) break
    await wait(250)
  }
  const order = (list) => {
    const noteIndex = list.findIndex((message) => message.speaker === 'player' && message.text === note)
    const logIndex = list.findIndex((message) => message.author === 'Система боя' && /Огр/u.test(message.text) && /вдогонку|Отступая|на отходе/u.test(message.text))
    const narratorIndex = list.findIndex((message) => message.id === moved.body.narration_message_id)
    const enemyTurnIndex = list.findIndex((message, index) => index > narratorIndex && message.author === 'Система боя')
    return { noteIndex, logIndex, narratorIndex, enemyTurnIndex }
  }
  const before = order(messages)
  const dump = JSON.stringify(messages.map((message) => [message.speaker, message.author, message.text]), null, 1)
  assert.ok(before.noteIndex >= 0, `реплика игрока в хронике: ${dump}`)
  assert.equal(messages[before.noteIndex].author, 'Мирель', 'подпись реплики — герой')
  assert.ok(before.logIndex > before.noteIndex, `строка удара после слов игрока: ${dump}`)
  assert.doesNotMatch(messages[before.logIndex].text, /Держись/u, 'слова игрока не вклеены в строку результата')
  assert.match(messages[before.logIndex].text, /попадание, \d+ урона\./u, 'урон удара — в той же строке')
  // Числа КД и ОЗ в летописи видит ведущий; игроку их снимает проекция
  // (`publicCombatMessageFor`, server/viewer-projection.mjs), как и прежде.
  const adminLog = (await admin.get('/api/rooms/JOURNAL-ORDER')).body.state.messages
    .find((message) => message.id === messages[before.logIndex].id)
  assert.match(adminLog?.text ?? '', /против КД 12 — попадание, \d+ урона; ОЗ 3 → 0\./u)
  assert.ok(before.narratorIndex > before.logIndex, `реплика рассказчика после строки удара: ${dump}`)
  assert.equal(messages[before.narratorIndex].author, 'Рассказчик')
  assert.ok(before.enemyTurnIndex > before.narratorIndex, `ход огра после реплики рассказчика: ${dump}`)

  // Ничего не теряется после перезапуска: летопись — часть снимка комнаты.
  await server.restart()
  const reloaded = (await player.get('/api/rooms/JOURNAL-ORDER')).body.state.messages
  const after = order(reloaded)
  for (const key of ['noteIndex', 'logIndex', 'narratorIndex', 'enemyTurnIndex']) assert.ok(after[key] >= 0, `${key} пропал после перезапуска`)
  assert.ok(after.noteIndex < after.logIndex && after.logIndex < after.narratorIndex && after.narratorIndex < after.enemyTurnIndex, JSON.stringify(after))

  // Повтор того же ключа ничего не удваивает и второй раз рассказчика не зовёт.
  const streamedBefore = provider.requests.filter((request) => request.body?.stream === true).length
  const replay = await player.post('/api/campaigns/JOURNAL-ORDER/commands', {
    idempotency_key: 'mirel-retreats', message: 'Переместить героя на клетку 0, 1', player_note: note,
    command: { command_type: 'MoveActor', actor_id: 'mirel', to: { x: 0, y: 1 } },
  })
  assertStatus(replay, 200, log)
  assert.equal(replay.body.narration, messages[before.narratorIndex].text, 'повтор отдаёт записанную реплику')
  assert.equal(provider.requests.filter((request) => request.body?.stream === true).length, streamedBefore)
  const final = (await player.get('/api/rooms/JOURNAL-ORDER')).body.state.messages
  assert.equal(final.filter((message) => message.speaker === 'player' && message.text === note).length, 1)
  assert.equal(final.filter((message) => message.id === moved.body.narration_message_id).length, 1)
})
