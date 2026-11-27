// Заявка из нескольких шагов и ручной бросок первого шага.
//
// Живая партия 2026-10-10: «Мирель подходит к двери маяка, прислушивается, а
// потом поднимается…» сервер разбил на шаги, игрок ответил «Да», получил
// карточку Восприятия — и бросок упал `ROLL_CONTEXT_MISMATCH`. Карточка
// регистрировалась под текстом первого шага, а ответ сервера не называл этот
// текст (`resolved_action`), и клиент слал с костью свой ответ «Да». Заодно
// первый шаг обрывался на союзе: «…прислушивается, а».
//
// Деление шагов и оркестратор JS в процессе — action-sequence-roll-api-library.test.mjs.
import assert from 'node:assert/strict'
import test from 'node:test'

import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'STEP-ROLL'
const HERO = 'hero-slot-1'
const PLAN = 'Мирель подходит к двери маяка, прислушивается, а потом осторожно поднимается по винтовой лестнице наверх, к фонарю — посмотреть, что там горит по ночам.'

function campaignState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Маяк',
    activePlayerId: HERO,
    partyMemberIds: [HERO],
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: HERO, character: 'Мирель', name: 'Мирель', className: 'wizard', hp: 8, maxHp: 8,
      armor: 12, proficiency: 2,
      abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
      inventory: [], online: true,
    }],
    enemies: [],
    scene: { title: 'Маяк', location: 'Маяк', mood: 'Ночь', objective: 'Узнать, что горит в фонаре', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

test('бросок первого шага по HTTP принимается под текстом, который назвал сервер', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-step-roll-api-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: SESSION, state: campaignState() })
  const { client: player } = await addPlayer(server, gm, SESSION, { heroIds: [HERO] })
  // Тело — как у клиента (`src/ai-client.ts`): ручной бросок, уточнение по id.
  const narrate = (key, action, extra = {}) => player.post('/api/narrate', {
    campaignId: SESSION, actor_id: HERO, action, idempotency_key: key, request_kind: 'action', manual_roll: true, ...extra,
  })

  const offer = expectStatus(await narrate('plan', PLAN))
  assert.ok(offer.check?.check_id, JSON.stringify(offer))
  assert.deepEqual(offer.mechanics ?? [], [])

  const rolled = expectStatus(await player.post('/api/roll', { campaignId: SESSION, playerId: HERO, checkId: offer.check.check_id }))
  assert.ok(rolled.roll_id)

  // Клиент держит у карточки `resolved_action ?? текст ответа`
  // (`src/useGameSession.ts`) и с костью шлёт именно его.
  const cardAction = offer.resolved_action ?? 'Да'
  const response = await narrate('resolve', cardAction, { clarification_id: offer.check.clarification_id, roll: { roll_id: rolled.roll_id } })
  assert.equal(response.status, 200, response.text)
  const ability = (response.body.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
  assert.ok(ability, response.text)
  assert.equal(ability.payload.roll_id, rolled.roll_id)
  assert.equal(ability.payload.kept, rolled.value)
  assert.equal(ability.payload.player_rolled, true)
})
