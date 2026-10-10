// Заявка из нескольких шагов и ручной бросок первого шага.
//
// Живая партия 2026-10-10: «Мирель подходит к двери маяка, прислушивается, а
// потом поднимается…» сервер разбил на шаги, игрок ответил «Да», получил
// карточку Восприятия — и бросок упал `ROLL_CONTEXT_MISMATCH`. Карточка
// регистрировалась под текстом первого шага, а ответ сервера не называл этот
// текст (`resolved_action`), и клиент слал с костью свой ответ «Да». Заодно
// первый шаг обрывался на союзе: «…прислушивается, а».
import assert from 'node:assert/strict'
import test from 'node:test'

import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { actionSequence } from '../server/intent-parser.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, normalizeCampaignState } from '../server/rules-engine.mjs'
import { dice } from './kit/dice.mjs'
import { createTestStore } from './kit/engine.mjs'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'STEP-ROLL'
const HERO = 'hero-slot-1'
const PLAN = 'Мирель подходит к двери маяка, прислушивается, а потом осторожно поднимается по винтовой лестнице наверх, к фонарю — посмотреть, что там горит по ночам.'
const FIRST_STEP = 'Мирель подходит к двери маяка, прислушивается'
const SECOND_STEP = 'осторожно поднимается по винтовой лестнице наверх, к фонарю — посмотреть, что там горит по ночам.'

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

test('шаги заявки делятся по «а потом / и затем» без обрывка союза', () => {
  assert.deepEqual(actionSequence(PLAN), [FIRST_STEP, SECOND_STEP])
  assert.deepEqual(actionSequence('Открываю сундук и затем забираю свиток'), ['Открываю сундук', 'забираю свиток'])
  assert.deepEqual(actionSequence('Стучу в дверь. А после этого жду ответа'), ['Стучу в дверь', 'жду ответа'])
  // Прежнее деление не изменилось.
  assert.deepEqual(actionSequence('Сначала подбрасываю монету; затем сматываю верёвку'), ['подбрасываю монету', 'сматываю верёвку'])
  assert.deepEqual(actionSequence('Подхожу к стражнику, потом спрашиваю о дороге'), ['Подхожу к стражнику', 'спрашиваю о дороге'])
  // «а» и «и» внутри шага — не связка шагов: делить их без «потом» нельзя.
  assert.deepEqual(actionSequence('Подхожу к двери и прислушиваюсь, а Борис ждёт'), [])
})

test('ручной бросок первого шага исполняет проверку, и план идёт к следующему шагу', async (t) => {
  const initial = normalizeCampaignState(campaignState())
  const eventStore = createTestStore(t, { prefix: 'skazanie-step-roll-' })
  await eventStore.initializeCampaign({ campaign_id: SESSION, initial_state: initial })
  // Игрок выбрасывает 18: с модификатором Мудрости +1 это успех против СЛ 15.
  const rollRegistry = new RollRegistry({ diceService: dice([18], { prefix: 'step-roll' }) })
  const game = new GameOrchestrator({
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
    eventStore,
    narrator: { render: async () => ({ narration: 'За дверью тихо.', provider: 'deterministic-test' }) },
    rollRegistry,
  })
  const send = async (message, options) => game.handle({
    state: (await eventStore.load(SESSION)).state, campaignId: SESSION, playerId: HERO, allowedActorIds: [HERO],
    message, requestKind: 'action', ...options,
  })

  const planned = await send(PLAN, { idempotencyKey: 'plan', manualRoll: true })
  assert.equal(planned.action_kind, 'clarification')
  assert.match(planned.narration, new RegExp(`Сначала: «${FIRST_STEP}»\\.`, 'u'))

  const offer = await send('Да', { idempotencyKey: 'confirm', manualRoll: true, clarificationId: planned.clarification.id })
  assert.ok(offer.check?.check_id, JSON.stringify(offer))
  assert.equal(offer.check.clarification_id, planned.clarification.id)
  assert.equal(offer.resolved_action, FIRST_STEP, 'карточка называет шаг, под которым зарегистрирован бросок')

  const issued = rollRegistry.issue({ checkId: offer.check.check_id, campaignId: SESSION, actorId: HERO })
  const verifiedRoll = rollRegistry.consume(issued.roll_id, { campaignId: SESSION, actorId: HERO, idempotencyKey: 'resolve' })
  const resolved = await send(offer.resolved_action, { idempotencyKey: 'resolve', clarificationId: offer.check.clarification_id, verifiedRoll })
  const ability = (resolved.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
  assert.ok(ability, JSON.stringify(resolved))
  assert.equal(ability.payload.roll_id, issued.roll_id)
  assert.equal(ability.payload.success, true)
  assert.equal(resolved.clarification?.question, `Первый шаг завершён. Далее: «${SECOND_STEP}». Продолжить или изменить план?`)
})

test('бросок первого шага по HTTP принимается под текстом, который назвал сервер', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-step-roll-api-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: SESSION, state: campaignState() })
  const { client: player } = await addPlayer(server, gm, SESSION, { heroIds: [HERO] })
  // Тело — как у клиента (`src/ai-client.ts`): ручной бросок, уточнение по id.
  const narrate = (key, action, extra = {}) => player.post('/api/narrate', {
    campaignId: SESSION, actor_id: HERO, action, idempotency_key: key, request_kind: 'action', manual_roll: true, ...extra,
  })

  const planned = expectStatus(await narrate('plan', PLAN))
  assert.equal(planned.action_kind, 'clarification', JSON.stringify(planned))
  assert.equal(planned.narration, `В заявке 2 последовательных шага. Сначала: «${FIRST_STEP}». Выполнить первый шаг? Остальные обсудим после его результата.`)

  const offer = expectStatus(await narrate('confirm', 'Да', { clarification_id: planned.clarification.id }))
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
  // Исход зависит от кости сервера, но план в любом случае не теряется.
  assert.match(response.body.clarification?.question ?? '', ability.payload.success
    ? /^Первый шаг завершён\. Далее: «осторожно поднимается/u
    : /^Первый шаг не удался/u)
})
