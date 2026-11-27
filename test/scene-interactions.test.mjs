import assert from 'node:assert/strict'
import test from 'node:test'

import { startTestServer } from './kit/http.mjs'
import { normalizeCampaignState, tacticalMap } from './kit/fixtures.mjs'

// Объекты сцены по HTTP. Входы готовит Rust (`kit/fixtures.mjs`); metadata,
// разбор текста и движок JS в процессе — scene-interactions-library.test.mjs.

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch {}
  return { status: response.status, body: parsed, text, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

/**
 * `thief` — предыстория с владением воровскими инструментами. Замок вскрывает
 * только владеющий (`server/lockpicking.mjs`), и без этого признака запертый
 * сундук отвечает отказом до всякого броска.
 */
async function sceneState({ assetId = 'chest', seed = 'scene-seed', propX = 1, propY = 0, combat = false, thief = false } = {}) {
  const { map } = await tacticalMap({
    width: 5,
    height: 3,
    locationId: 'test-scene',
    seed,
    fill: { passable: true, revealed: true, material: 'stone' },
  }).prop({
    id: `prop-${assetId}`,
    assetId,
    x: propX + 0.5,
    y: propY + 0.5,
    footprint: [{ x: propX, y: propY }],
    interactive: true,
  }).build()
  return normalizeCampaignState({
    sessionCode: 'SCENE-T',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      hp: 12,
      maxHp: 12,
      proficiency: 2,
      abilities: { str: 16, dex: 14, int: 14, wis: 14, cha: 10, con: 12 },
      classSkillProficiencies: ['athletics', 'arcana', 'religion', 'investigation', 'perception', 'sleight_of_hand'],
      ...(thief ? { backgroundId: 'criminal' } : {}),
      inventory: [],
      x: 0,
      y: 0,
    }],
    scene: { map, turn: 1 },
    mechanics: {
      positions: { hero: { x: 0, y: 0 } },
      combat: combat ? {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero' }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true } },
      } : undefined,
    },
  })
}

// Сид карты, на котором сундук без замка и ловушки. Подбирается функцией
// `sceneInteractionDefinition` (Rust — `sk_tactical::scene_interactions::scene_interaction_definition`),
// которой в `kit/fixtures.mjs` нет; первый подходящий сид перебора `container-<n>`
// — `container-0`. Если сундук на нём окажется запертым, случай ниже упадёт на
// открытии рукой, а не пройдёт молча.
const UNLOCKED_UNTRAPPED_CHEST_SEED = 'container-0'

test('HTTP sanitizer сохраняет владельца героя и не принимает force от кнопки игрока', { timeout: 20_000 }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-scene-http-', setupToken: 'scene-http-setup-token' })
  // Сервер не перезапускается: адрес постоянен до конца теста.
  const { baseUrl } = server

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Scene Admin',
      email: 'admin@scene-http.test',
      password: 'secure-scene-admin-password',
      setupToken: 'scene-http-setup-token',
    },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${server.output()}`)
  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Scene Player',
      email: 'player@scene-http.test',
      password: 'secure-scene-player-password',
    },
  })
  assert.equal(registered.status, 201, `${registered.text}\n${server.output()}`)

  const initial = await sceneState({ seed: UNLOCKED_UNTRAPPED_CHEST_SEED })
  initial.sessionCode = 'SCENE-HTTP'
  initial.campaign = 'Живая сцена HTTP'
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: setup.cookie,
    body: { code: initial.sessionCode, name: initial.campaign, state: initial },
  })
  assert.equal(created.status, 201, `${created.text}\n${server.output()}`)
  const users = await request(baseUrl, '/api/admin/users', { cookie: setup.cookie })
  const player = users.body.users.find((candidate) => candidate.email === 'player@scene-http.test')
  assert.ok(player)
  const assigned = await request(baseUrl, `/api/admin/users/${player.id}`, {
    method: 'PATCH',
    cookie: setup.cookie,
    body: { heroIds: ['hero'] },
  })
  assert.equal(assigned.status, 200, assigned.text)

  const landmark = await request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: registered.cookie,
    body: {
      campaignId: 'SCENE-HTTP',
      action: 'Открыть дверь рядом с сундуком',
      actor_id: 'hero',
      idempotency_key: 'scene-http-landmark',
    },
  })
  assert.equal(landmark.status, 200, landmark.text)
  assert.equal(landmark.body.mechanics.some((event) => event.event_type.startsWith('SceneObject')), false, landmark.text)

  const forgedForce = await request(baseUrl, '/api/campaigns/SCENE-HTTP/commands', {
    method: 'POST',
    cookie: registered.cookie,
    body: {
      idempotency_key: 'scene-http-open',
      command: {
        command_type: 'OperateSceneObject',
        actor_id: 'hero',
        prop_id: 'prop-chest',
        intent: 'open',
        approach: 'force',
      },
    },
  })
  assert.equal(forgedForce.status, 200, `${forgedForce.text}\n${server.output()}`)
  const operated = forgedForce.body.mechanics.find((event) => event.event_type === 'SceneObjectOperated')
  assert.equal(operated.payload.approach, 'hand')
  // Плейтест 2026-10-10: осмотр бочки вне боя подписывался «Система боя» и
  // звучал квитанцией «Внутри обнаружено: …». Вне боя строку говорит
  // рассказчик, а находка названа у своего предмета.
  assert.equal(forgedForce.body.narration_author, 'Рассказчик')
  assert.match(forgedForce.body.narration, /^Под крышкой сундука — /u)
  const sceneRoom = await request(baseUrl, '/api/rooms/SCENE-HTTP', { cookie: registered.cookie })
  const sceneLine = sceneRoom.body.state.messages.find((message) => message.id === forgedForce.body.narration_message_id)
  assert.equal(sceneLine?.author, 'Рассказчик')
  assert.equal(sceneLine?.speaker, 'narrator')

  const foreignActor = await request(baseUrl, '/api/campaigns/SCENE-HTTP/commands', {
    method: 'POST',
    cookie: registered.cookie,
    body: {
      idempotency_key: 'scene-http-foreign',
      command: {
        command_type: 'OperateSceneObject',
        actor_id: 'other-hero',
        prop_id: 'prop-chest',
        intent: 'inspect',
      },
    },
  })
  assert.notEqual(foreignActor.status, 200)
  assert.equal(foreignActor.body.code, 'ACTOR_FORBIDDEN')
})
