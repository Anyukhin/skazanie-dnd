import assert from 'node:assert/strict'
import test from 'node:test'

import { registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import { authoredLocationMapFor } from '../server/authored-location-maps.mjs'
import { cellAt } from '../server/tactical-map.mjs'

const SESSION = 'AUTHORED-MAP-MOVE'

function hero(index) {
  return {
    id: `map-hero-${index}`,
    name: `Игрок ${index}`,
    character: `Герой ${index}`,
    role: 'Воин · ур. 1',
    species: 'Человек',
    background: 'Странник',
    backstory: 'Проверяет, можно ли пройти по королевскому замку.',
    level: 1,
    hp: 30,
    maxHp: 30,
    armor: 18,
    speed: 30,
    proficiency: 2,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
    online: true,
    attackBonus: 5,
    damageDice: 8,
    damageBonus: 3,
    damageType: 'slashing',
    attackRange: 5,
  }
}

function commandBody(key, actorId, to) {
  return {
    idempotency_key: key,
    message: 'Проверка движения по authored-карте',
    command: { command_type: 'MoveActor', actor_id: actorId, to },
  }
}

function characterDocument(character) {
  const abilities = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character,
      name: character,
      role: 'Воин · ур. 1',
      characterClass: 'barbarian',
      species: 'Человек',
      background: 'Солдат',
      level: 1,
      experience: 0,
      abilities,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores: abilities,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: [],
      knownSpellIds: [],
      preparedSpellIds: [],
    },
  }
}

function statePosition(room, actorId) {
  return room.body.state.players.find((player) => player.id === actorId)
}

test('authored Ares map enforces walls, table occupancy, routes around props, ACL, idempotency and replay', { timeout: runnerTimeout(45_000) }, async (t) => {
  const map = authoredLocationMapFor('astohan-stormberg')
  assert.ok(map, 'для HTTP movement test нужен опубликованный Ares map')
  assert.deepEqual([map.width, map.height], [24, 18])
  assert.equal(cellAt(map, 6, 4)?.passable ?? false, false)
  assert.ok(map.props.some((prop) => prop.id === 'war-table' && prop.footprint.some((cell) => cell.x === 11 && cell.y === 8)))
  const server = await startTestServer(t, { storagePrefix: 'skazanie-authored-map-movement-' })

  const { client: admin } = await setupAdmin(server, { name: 'Map test admin', email: 'authored-map-admin@example.test', password: 'secure-map-admin-password' })
  const { client: owner } = await registerUser(server, { name: 'Map owner', email: 'authored-map-owner@example.test', password: 'secure-map-owner-password' })
  const { client: guest } = await registerUser(server, { name: 'Map guest', email: 'authored-map-guest@example.test', password: 'secure-map-guest-password' })
  const move = (client, key, actorId, to) => client.post(`/api/campaigns/${SESSION}/commands`, commandBody(key, actorId, to), { idempotencyKey: key })

  const created = await owner.post('/api/campaigns', {
    code: SESSION,
    name: 'Авторитетное движение по замку',
    bootstrap: { partyName: 'Два картографа', worldTemplateId: 'astohan-plains', players: [hero(1), hero(2)] },
  })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.state.scene.map.locationId, 'astohan-stormberg')
  assert.equal(created.body.state.scene.map.tilesetId, 'authored-tactical:astohan-stormberg:v1')
  const initial = await owner.get(`/api/rooms/${SESSION}`)
  assert.equal(initial.status, 200, initial.text)
  assert.deepEqual(statePosition(initial, 'map-hero-1') && [statePosition(initial, 'map-hero-1').x, statePosition(initial, 'map-hero-1').y], [9, 9])
  assert.deepEqual(statePosition(initial, 'map-hero-2') && [statePosition(initial, 'map-hero-2').x, statePosition(initial, 'map-hero-2').y], [8, 9])

  const users = await admin.get('/api/admin/users')
  assert.equal(users.status, 200, users.text)
  const guestUser = users.body.users.find((user) => user.email === 'authored-map-guest@example.test')
  assert.ok(guestUser)
  const invite = await owner.post(`/api/campaigns/${SESSION}/invites`, { hero_ids: ['map-hero-2'] })
  assert.equal(invite.status, 201, invite.text)
  const joined = await guest.post(`/api/campaigns/${SESSION}/join`, { invite_token: invite.body.token })
  assert.equal(joined.status, 200, joined.text)
  assert.deepEqual(joined.body.hero_ids, ['map-hero-2'])

  for (const [index, client] of [[1, owner], [2, guest]]) {
    const imported = await client.post(`/api/campaigns/${SESSION}/commands`, {
      idempotency_key: `ares-import-${index}`,
      message: 'Завершить лист героя для теста карты',
      command: { command_type: 'ImportCharacter', actor_id: `map-hero-${index}`, document: characterDocument(`Герой ${index}`) },
    }, { idempotencyKey: `ares-import-${index}` })
    assert.equal(imported.status, 200, imported.text)
  }

  const wall = await move(owner, 'ares-move-wall', 'map-hero-1', { x: 6, y: 4 })
  assert.equal(wall.status, 400, String(wall.body?.code ?? wall.text.slice(0, 240)))
  assert.match(String(wall.body?.code), /PATH|DESTINATION|MOVE/u)

  const table = await move(owner, 'ares-move-table', 'map-hero-1', { x: 11, y: 8 })
  assert.equal(table.status, 400, String(table.body?.code ?? table.text.slice(0, 240)))
  assert.match(String(table.body?.code), /PROP|OCCUP|DESTINATION|PATH|MOVE/u)

  const closedStudy = await move(owner, 'ares-closed-study', 'map-hero-1', { x: 5, y: 8 })
  assert.equal(closedStudy.status, 400, closedStudy.text)
  const approachDoor = await move(owner, 'ares-approach-door', 'map-hero-1', { x: 7, y: 8 })
  assert.equal(approachDoor.status, 200, approachDoor.text)
  const opened = await owner.post(`/api/campaigns/${SESSION}/commands`, {
    idempotency_key: 'ares-open-study', message: 'Открыть дверь кабинета',
    command: { command_type: 'OperateDoor', actor_id: 'map-hero-1', door_id: 'ares-west-study', intent: 'open' },
  }, { idempotencyKey: 'ares-open-study' })
  assert.equal(opened.status, 200, opened.text)
  const enteredStudy = await move(owner, 'ares-enter-study', 'map-hero-1', { x: 5, y: 8 })
  assert.equal(enteredStudy.status, 200, enteredStudy.text)

  const aroundTable = await move(owner, 'ares-move-around-table', 'map-hero-1', { x: 14, y: 7 })
  assert.equal(aroundTable.status, 200, aroundTable.text)
  const aroundTableActor = aroundTable.body.authoritative_state.players.find((player) => player.id === 'map-hero-1')
  assert.deepEqual([aroundTableActor.x, aroundTableActor.y], [14, 7])
  const aroundTableEvent = aroundTable.body.mechanics.find((event) => event.event_type === 'ActorMoved' && event.actor_id === 'map-hero-1')
  assert.ok(aroundTableEvent?.payload?.path?.length, 'маршрут вокруг стола должен быть записан в ActorMoved')
  const tableFootprint = new Set(map.props.find((prop) => prop.id === 'war-table').footprint.map((cell) => `${cell.x},${cell.y}`))
  assert.ok(aroundTableEvent.payload.path.every((cell) => !tableFootprint.has(`${cell.x},${cell.y}`)), 'серверный путь не должен проходить по footprint стола')

  const foreign = await move(guest, 'ares-foreign-actor', 'map-hero-1', { x: 10, y: 9 })
  assert.equal(foreign.status, 403, String(foreign.body?.code ?? foreign.text.slice(0, 240)))
  assert.match(String(foreign.body?.code), /ACTOR|COMMAND|FORBIDDEN/u)

  const moved = await move(owner, 'ares-move-success', 'map-hero-1', { x: 10, y: 9 })
  assert.equal(moved.status, 200, moved.text)
  assert.deepEqual(
    [moved.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').x, moved.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').y],
    [10, 9],
  )
  const movedVersion = moved.body.authoritative_state.state_version
  const replay = await move(owner, 'ares-move-success', 'map-hero-1', { x: 10, y: 9 })
  assert.equal(replay.status, 200, replay.text)
  assert.equal(replay.body.idempotent_replay, true)
  assert.equal(replay.body.authoritative_state.state_version, movedVersion)
  assert.deepEqual(
    [replay.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').x, replay.body.authoritative_state.players.find((player) => player.id === 'map-hero-1').y],
    [10, 9],
  )

  const beforeRestart = await owner.get(`/api/rooms/${SESSION}`)
  assert.equal(beforeRestart.status, 200, beforeRestart.text)
  const mapBeforeRestart = beforeRestart.body.state.scene.map
  const versionBeforeRestart = beforeRestart.body.version
  await server.restart()
  const afterRestart = await owner.get(`/api/rooms/${SESSION}`)
  assert.equal(afterRestart.status, 200, afterRestart.text)
  assert.equal(afterRestart.body.version, versionBeforeRestart)
  assert.deepEqual(afterRestart.body.state.scene.map, mapBeforeRestart)
  assert.deepEqual([statePosition(afterRestart, 'map-hero-1').x, statePosition(afterRestart, 'map-hero-1').y], [10, 9])
  assert.equal(server.output().includes('skazanie_session='), false, 'тестовый лог не должен содержать cookies')
})
