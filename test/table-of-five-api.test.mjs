import assert from 'node:assert/strict'
import test from 'node:test'
import { startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0] ?? ''

test('стол на пятерых получает пять слотов, отдельные герои и эфемерный typing', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-table-five-', setupToken: 'table-five-setup' })
  const baseUrl = server.baseUrl

  assert.equal((await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Setup', email: 'setup@table.test', password: 'secure-setup-password', setupToken: 'table-five-setup',
  } })).status, 201)

  const accounts = []
  for (let index = 1; index <= 6; index += 1) {
    const registered = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
      name: `Игрок ${index}`, email: `player-${index}@table.test`, password: `secure-player-${index}-password`,
    } })
    assert.equal(registered.status, 201, registered.text)
    accounts.push(sessionCookie(registered))
  }

  const rejectedSix = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: accounts[0],
    body: { code: 'TOO-MANY', name: 'Лишнее место', bootstrap: { slotCount: 6, partyName: 'Шестеро', world: {} } },
  })
  assert.equal(rejectedSix.status, 400, rejectedSix.text)
  assert.match(rejectedSix.body.error, /от 1 до 5/u)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: accounts[0],
    body: { code: 'TABLE-FIVE', name: 'Стол на пятерых', bootstrap: { slotCount: 5, partyName: 'Пять огней', world: { preset: 'Классическое фэнтези' } } },
  })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.body.state.players.length, 5)
  assert.deepEqual(created.body.user.campaignMemberships[0].heroIds, ['hero-slot-1'])

  const invite = await request(baseUrl, '/api/campaigns/TABLE-FIVE/invites', {
    method: 'POST', cookie: accounts[0], body: {},
  })
  assert.equal(invite.status, 201, invite.text)
  assert.deepEqual(invite.body.hero_ids, ['hero-slot-2', 'hero-slot-3', 'hero-slot-4', 'hero-slot-5'])

  for (let index = 1; index < 5; index += 1) {
    const joined = await request(baseUrl, '/api/campaigns/TABLE-FIVE/join', {
      method: 'POST', cookie: accounts[index], body: { invite_token: invite.body.token },
    })
    assert.equal(joined.status, 200, joined.text)
    assert.deepEqual(joined.body.hero_ids, [`hero-slot-${index + 1}`])
  }

  const duplicateJoin = await request(baseUrl, '/api/campaigns/TABLE-FIVE/join', {
    method: 'POST', cookie: accounts[1], body: { invite_token: invite.body.token },
  })
  assert.equal(duplicateJoin.status, 200, duplicateJoin.text)
  assert.equal(duplicateJoin.body.duplicate, true)

  const fullInvite = await request(baseUrl, '/api/campaigns/TABLE-FIVE/join', {
    method: 'POST', cookie: accounts[5], body: { invite_token: invite.body.token },
  })
  assert.equal(fullInvite.status, 409, fullInvite.text)
  assert.match(fullInvite.body.error, /не осталось свободных героев/u)

  const noSeat = await request(baseUrl, '/api/campaigns/TABLE-FIVE/invites', {
    method: 'POST', cookie: accounts[0], body: {},
  })
  assert.equal(noSeat.status, 409, noSeat.text)
  assert.match(noSeat.body.error, /не осталось свободных героев/u)

  const typing = await request(baseUrl, '/api/campaigns/TABLE-FIVE/presence/typing', {
    method: 'PUT', cookie: accounts[4], body: { actor_id: 'hero-slot-5', typing: true },
  })
  assert.equal(typing.status, 200, typing.text)
  assert.equal(typing.body.ttl_ms, 4_000)
  let ownerRoom = await request(baseUrl, '/api/rooms/TABLE-FIVE', { cookie: accounts[0] })
  assert.deepEqual(ownerRoom.body.state.presence.typing_actor_ids, ['hero-slot-5'])

  const stoppedTyping = await request(baseUrl, '/api/campaigns/TABLE-FIVE/presence/typing', {
    method: 'PUT', cookie: accounts[4], body: { actor_id: 'hero-slot-5', typing: false },
  })
  assert.equal(stoppedTyping.status, 200, stoppedTyping.text)
  ownerRoom = await request(baseUrl, '/api/rooms/TABLE-FIVE', { cookie: accounts[0] })
  assert.deepEqual(ownerRoom.body.state.presence.typing_actor_ids, [])

  const baseScores = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }
  const imported = await request(baseUrl, '/api/campaigns/TABLE-FIVE/commands', {
    method: 'POST',
    cookie: accounts[4],
    body: {
      idempotency_key: 'table-five-import',
      message: 'Создание пятого героя',
      command: {
        command_type: 'ImportCharacter',
        actor_id: 'hero-slot-5',
        document: {
          schema: 'skazanie.character',
          schema_version: 1,
          character: {
            character: 'Пятый герой', name: 'Пятый герой', role: 'Варвар · ур. 1',
            characterClass: 'barbarian', species: 'Человек', background: 'Солдат',
            level: 1, experience: 0, abilities: baseScores, baseSpeed: 30,
            hitPointIncreases: [], classSkillProficiencies: ['athletics', 'perception'],
            selectedFeatureIds: [], knownSpellIds: [], preparedSpellIds: [],
            abilityGeneration: {
              policyId: 'skazanie.character-abilities.standard-array',
              policyVersion: 1, method: 'standard_array', baseScores,
              originBonusProfileId: 'none',
              originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
              speciesOptionId: 'human',
            },
          },
        },
      },
    },
  })
  assert.equal(imported.status, 200, imported.text)

  const proposed = await request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: accounts[4],
    body: {
      campaign_id: 'TABLE-FIVE',
      actor_id: 'hero-slot-5',
      action: 'Предлагаю отряду выбрать: идти к башне или остаться в лагере',
      idempotency_key: 'table-five-proposal',
    },
  })
  assert.equal(proposed.status, 200, proposed.text)
  const afterProposal = await request(baseUrl, '/api/rooms/TABLE-FIVE', { cookie: accounts[4] })
  const playerMessage = [...afterProposal.body.state.messages].reverse().find((message) => message.speaker === 'player')
  assert.equal(playerMessage.author, 'Пятый герой')
})
