import assert from 'node:assert/strict'
import test from 'node:test'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('ведущий вспоминает обещание отсутствующей Миры и называет источник показания после перезапуска', {
  timeout: runnerTimeout(90_000),
}, async (t) => {
  const code = 'PARTY-RECOLLECTION'
  const server = await startTestServer(t, { storagePrefix: 'skazanie-recollection-' })
  const { client: admin } = await setupAdmin(server)
  const promiseText = 'Оставить карту старых троп под медной кружкой'
  const testimony = 'Я видела баркас у каменной мельницы.'
  const secret = 'Личный тайник у третьей опоры'
  await createCampaign(admin, { code, state: {
    sessionCode: code, scene: { location: 'Северные ворота' }, activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Мирель', role: 'Воин', hp: 12, maxHp: 12, inventory: [], characterSetupRequired: false }],
    social: {
      npcs: [{ id: 'mira', name: 'Мира', role: 'хозяйка', location: 'Старый трактир', visibility: 'party' }],
      conversations: [
        { id: 'seen-boat', npc_id: 'mira', hero_id: 'hero', visibility: 'party', npc_reply: testimony },
        { id: 'heard-private', npc_id: 'mira', hero_id: 'other', visibility: 'specific_player', npc_reply: secret },
      ],
      promises: [
        { id: 'mira-map', npc_id: 'mira', hero_id: 'hero', direction: 'npc_to_party', text: promiseText, status: 'open', visibility: 'party' },
        { id: 'private-promise', npc_id: 'mira', hero_id: 'other', direction: 'npc_to_party', text: secret, status: 'open', visibility: 'specific_player' },
      ],
    },
  } })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: ['hero'] })
  const ask = async (action, key) => {
    const answer = expectStatus(await player.post('/api/narrate', {
      campaign_id: code, actor_id: 'hero', action, idempotency_key: key,
    }))
    assert.equal(answer.provider, 'AgentWorldkeeper')
    assert.equal(answer.turn_consumed, false)
    assert.ok(!JSON.stringify(answer).includes(secret))
    return answer.narration
  }
  const promise = await ask('Что нам обещала Мира?', 'promise-before-restart')
  assert.match(promise, /Мир[аы]/u)
  assert.match(promise, /карту старых троп под медной кружкой/u)
  await server.restart()
  assert.equal(await ask('Что нам обещала Мира?', 'promise-after-restart'), promise)
  const recalled = await ask('Кто видел баркас у каменной мельницы?', 'boat-witness')
  assert.match(recalled, /Мир[аы]/u)
  assert.ok(recalled.includes(testimony.slice(0, -1)))
})
