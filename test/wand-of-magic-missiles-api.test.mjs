import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { resolveCommand } from '../server/rules-engine.mjs'
import { appendJournal, readJournal, startTestServer } from './kit/index.mjs'

const WAND_ID = 'srd_5_2_1:wand-of-magic-missiles'

async function request(baseUrl, path, {
  method = 'GET',
  cookie = '',
  body,
  key = '',
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

function campaign(code, charges) {
  return {
    state_version: 0,
    sessionCode: code,
    campaign: 'Проверка жезла',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Воин',
      characterClass: 'fighter',
      level: 3,
      hp: 30,
      maxHp: 30,
      armor: 16,
      proficiency: 2,
      x: 0,
      y: 0,
      abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
      inventory: [materializeCatalogItem(WAND_ID, {
        id: 'wand',
        quantity: 1,
        equipped: true,
        charges: { current: charges, max: 7 },
      })],
    }],
    enemies: [{
      id: 'foe',
      name: 'Огр',
      hp: 50,
      maxHp: 50,
      armor: 12,
      speed: 30,
      x: 2,
      y: 0,
      alive: true,
      abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    }],
    scene: {
      title: 'Арена',
      location: 'Арена',
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        { x: 2, y: 0, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 2, y: 0 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  }
}

function commandBody(key, chargesToSpend, extra = {}) {
  return {
    idempotency_key: key,
    command: {
      command_type: 'UseItem',
      actor_id: 'hero',
      item_id: 'wand',
      target_id: 'foe',
      charges_to_spend: chargesToSpend,
      ...extra,
    },
  }
}

function itemFingerprint(chargesToSpend) {
  return createHash('sha256').update(JSON.stringify({
    type: 'UseItem',
    actor_id: 'hero',
    item_id: 'wand',
    target_id: 'foe',
    charges_to_spend: chargesToSpend,
    to: null,
    use_mode: '',
    weapon_id: '',
  })).digest('hex')
}

test('HTTP жезла защищает поля и charges_to_spend idempotency, включая retry после уничтожения', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-wand-api-', setupToken: 'wand-api-setup' })
  let baseUrl = server.baseUrl

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'GM',
      email: 'gm@wand-api.test',
      password: 'secure-admin-password',
      setupToken: 'wand-api-setup',
    },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${server.output()}`)
  const cookie = admin.response.headers.get('set-cookie')?.split(';')[0]

  for (const [code, charges] of [['WAND-API', 7], ['WAND-DESTROY', 1]]) {
    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      cookie,
      body: { code, name: 'Проверка жезла', state: campaign(code, charges) },
    })
    assert.equal(created.status, 201, `${created.text}\n${server.output()}`)
  }

  for (const forged of [
    { spell_id: 'fireball' },
    { formula: '99d99' },
    { projectile_count: 99 },
  ]) {
    const rejected = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
      method: 'POST',
      cookie,
      key: `forged-${Object.keys(forged)[0]}`,
      body: commandBody(`forged-${Object.keys(forged)[0]}`, 1, forged),
    })
    assert.equal(rejected.status, 400, `${rejected.text}\n${server.output()}`)
    assert.equal(rejected.body.code, 'ITEM_COMMAND_UNKNOWN_FIELD')
  }

  const key = 'wand-spend-one'
  const first = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
    method: 'POST',
    cookie,
    key,
    body: commandBody(key, 1),
  })
  assert.equal(first.status, 200, `${first.text}\n${server.output()}`)
  assert.ok(first.body.mechanics.some((event) => event.event_type === 'SpellCast'
    && event.payload.source?.kind === 'magic-item'))
  assert.equal(first.body.mechanics.some((event) => event.event_type === 'ResourceSpent'), false)
  assert.deepEqual(
    first.body.authoritative_state.players[0].inventory.find((item) => item.id === 'wand').charges,
    { current: 6, max: 7 },
  )

  const duplicate = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
    method: 'POST',
    cookie,
    key,
    body: commandBody(key, 1),
  })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${server.output()}`)
  assert.equal(duplicate.body.idempotent_replay, true)

  const conflictingSpend = await request(baseUrl, '/api/campaigns/WAND-API/commands', {
    method: 'POST',
    cookie,
    key,
    body: commandBody(key, 2),
  })
  assert.equal(conflictingSpend.status, 409, `${conflictingSpend.text}\n${server.output()}`)
  assert.equal(conflictingSpend.body.code, 'IDEMPOTENCY_CONFLICT')

  await server.stop()

  const before = await readJournal(server, 'WAND-DESTROY')
  const destroyKey = 'wand-destroyed-retry'
  const fingerprint = itemFingerprint(1)
  const resolved = resolveCommand({
    command_type: 'UseItem',
    command_id: destroyKey,
    campaign_id: 'WAND-DESTROY',
    actor_id: 'hero',
    item_id: 'wand',
    target_id: 'foe',
    charges_to_spend: 1,
    request_fingerprint: fingerprint,
    server_authoritative: true,
  }, before.state, {
    diceService: new DiceService({
      rng: new SequenceDiceRng([2, 1]),
      idFactory: (() => {
        let id = 0
        return () => `destroy-roll-${++id}`
      })(),
      now: () => '2026-07-31T12:00:00.000Z',
    }),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const committed = await appendJournal(server, 'WAND-DESTROY', {
    expected_state_version: before.state_version,
    idempotency_key: destroyKey,
    command_id: destroyKey,
    events: resolved.events,
  })
  assert.equal(committed.state.players[0].inventory.some((item) => item.id === 'wand'), false)
  assert.ok(committed.events.some((event) => event.event_type === 'ItemDestroyed'))

  await server.start()
  baseUrl = server.baseUrl

  const replayAfterDestruction = await request(baseUrl, '/api/campaigns/WAND-DESTROY/commands', {
    method: 'POST',
    cookie,
    key: destroyKey,
    body: commandBody(destroyKey, 1),
  })
  assert.equal(replayAfterDestruction.status, 200, `${replayAfterDestruction.text}\n${server.output()}`)
  assert.equal(replayAfterDestruction.body.idempotent_replay, true)
  assert.equal(replayAfterDestruction.body.authoritative_state.players[0].inventory.some((item) => item.id === 'wand'), false)

  const conflictAfterDestruction = await request(baseUrl, '/api/campaigns/WAND-DESTROY/commands', {
    method: 'POST',
    cookie,
    key: destroyKey,
    body: commandBody(destroyKey, 2),
  })
  assert.equal(conflictAfterDestruction.status, 409, `${conflictAfterDestruction.text}\n${server.output()}`)
  assert.equal(conflictAfterDestruction.body.code, 'IDEMPOTENCY_CONFLICT')
})
