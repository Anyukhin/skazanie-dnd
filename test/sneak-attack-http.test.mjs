import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { MapStore } from '../server/map-store.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
} from '../server/rules-engine.mjs'
import { registerUser, setupAdmin, startTestServer } from './kit/http.mjs'

function initialState(code) {
  return {
    state_version: 0,
    sessionCode: code,
    campaign: 'Проверка Скрытой атаки',
    activePlayerId: 'rogue',
    partyMemberIds: ['rogue', 'ally'],
    players: [
      {
        id: 'rogue',
        character: 'Тень',
        characterClass: 'rogue',
        level: 5,
        proficiency: 3,
        hp: 30,
        maxHp: 30,
        armor: 15,
        speed: 30,
        x: 1,
        y: 1,
        abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 12, cha: 10 },
        inventory: [materializeCatalogItem('srd_5_2_1:rapier', { id: 'rapier', quantity: 1, equipped: true })],
      },
      {
        id: 'ally',
        character: 'Союзник',
        characterClass: 'fighter',
        level: 5,
        proficiency: 3,
        hp: 30,
        maxHp: 30,
        armor: 16,
        speed: 30,
        x: 2,
        y: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [],
      },
    ],
    enemies: [{
      id: 'enemy',
      name: 'Цель',
      hp: 100,
      maxHp: 100,
      armor: 1,
      speed: 30,
      alive: true,
      creature_type: 'beast',
      x: 2,
      y: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    }],
    scene: {
      title: 'Полигон',
      location: 'Полигон',
      turn: 1,
      cells: Array.from({ length: 16 }, (_, index) => ({
        x: index % 4,
        y: Math.floor(index / 4),
        type: 'floor',
        revealed: true,
      })),
    },
    mechanics: {
      positions: { rogue: { x: 1, y: 1 }, ally: { x: 2, y: 2 }, enemy: { x: 2, y: 1 } },
      conditions: {},
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'rogue', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          rogue: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
        },
      },
    },
  }
}

function attackCommand(key, sneakAttack = true) {
  return {
    idempotency_key: key,
    command: {
      command_type: 'MakeAttack',
      actor_id: 'rogue',
      target_id: 'enemy',
      item_id: 'rapier',
      attack_ability: 'dex',
      sneak_attack: sneakAttack,
    },
  }
}

test('HTTP MakeAttack игрока применяет Скрытую атаку плута, защищает ключ и переживает рестарт', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-sneak-attack-http-' })
  const { client: admin } = await setupAdmin(server, { name: 'GM', email: 'gm@sneak-attack.test', password: 'secure-admin-password' })
  const { client: owner } = await registerUser(server, { name: 'Owner', email: 'owner@sneak-attack.test', password: 'secure-owner-password' })
  const { client: foreign } = await registerUser(server, { name: 'Foreign', email: 'foreign@sneak-attack.test', password: 'secure-foreign-password' })

  const users = await admin.get('/api/admin/users')
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@sneak-attack.test')
  const ownership = await admin.patch(`/api/admin/users/${ownerUser.id}`, { heroIds: ['rogue'] })
  assert.equal(ownership.status, 200, `${ownership.text}\n${server.output()}`)

  let selected = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const campaignId = `SNEAK-HTTP-${attempt}`
    const created = await admin.post('/api/campaigns', { code: campaignId, name: 'Проверка Скрытой атаки', state: initialState(campaignId) })
    assert.equal(created.status, 201, `${created.text}\n${server.output()}`)

    const forbidden = await foreign.post(`/api/campaigns/${campaignId}/commands`, attackCommand(`sneak-forbidden-${attempt}`), { idempotencyKey: `sneak-forbidden-${attempt}` })
    assert.equal(forbidden.status, 403, `${forbidden.text}\n${server.output()}`)

    const key = `sneak-attack-${attempt}`
    const command = attackCommand(key)
    const result = await owner.post(`/api/campaigns/${campaignId}/commands`, command, { idempotencyKey: key })
    assert.equal(result.status, 200, `${result.text}\n${server.output()}`)
    if (result.body.mechanics.some((event) => event.event_type === 'SneakAttackApplied')) {
      selected = { campaignId, key, command, result }
      break
    }
  }
  assert.ok(selected, 'пять атак по КД 1 не должны все выпасть натуральной единицей')

  const { campaignId, key, command, result: first } = selected
  const attack = first.body.mechanics.find((event) => event.event_type === 'AttackResolved')
  const sneak = first.body.mechanics.find((event) => event.event_type === 'SneakAttackApplied')
  assert.equal(attack.payload.hit, true)
  assert.equal(attack.payload.sneak_attack_eligible_by, 'ally')
  assert.equal(attack.payload.sneak_attack_supporter_id, 'ally')
  // Боевой API использует настоящую случайность: натуральная 20 удваивает и
  // кости Скрытой атаки. Без этой развилки тест примерно раз в двадцать запусков
  // принимал корректные 6d6 за регрессию.
  assert.equal(sneak.payload.expression, attack.payload.critical ? '6d6' : '3d6')
  assert.equal(sneak.payload.supporter_id, 'ally')

  const duplicate = await owner.post(`/api/campaigns/${campaignId}/commands`, command, { idempotencyKey: key })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${server.output()}`)
  assert.equal(duplicate.body.idempotent_replay, true)

  const conflict = await owner.post(`/api/campaigns/${campaignId}/commands`, attackCommand(key, false), { idempotencyKey: key })
  assert.equal(conflict.status, 409, `${conflict.text}\n${server.output()}`)
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')

  await server.stop()

  const eventStore = new FileEventStore({
    rootDir: join(server.storageDir, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    mapStore: new MapStore({ rootDir: join(server.storageDir, 'engine') }),
  })
  const durable = await eventStore.load(campaignId)
  const enemyHp = durable.state.enemies.find((enemy) => enemy.id === 'enemy').hp
  assert.ok(enemyHp < 100)
  assert.equal(durable.state.mechanics.combat.action_economy.rogue.sneak_attack_turn_key, 'combat:1:rogue')
  const storedEvents = await eventStore.getEvents(campaignId)
  assert.equal(storedEvents.filter((event) => event.event_type === 'AttackResolved').length, 1)
  assert.equal(storedEvents.filter((event) => event.event_type === 'SneakAttackApplied').length, 1)

  await server.start()

  const afterRestart = await owner.post(`/api/campaigns/${campaignId}/commands`, command, { idempotencyKey: key })
  assert.equal(afterRestart.status, 200, `${afterRestart.text}\n${server.output()}`)
  assert.equal(afterRestart.body.idempotent_replay, true)
})
