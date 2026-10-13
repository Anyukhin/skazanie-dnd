// Заявка из нескольких шагов и ручной бросок первого шага. Ведущий исполняет
// шаги без вопроса «выполнить первый шаг?»; если первому шагу нужна проверка,
// карточка называет его текст (`resolved_action`) и уточнение плана
// (`check.clarification_id`) — с ними клиент шлёт кость, и после броска план
// идёт дальше сам. Замер 2026-10-10: стенд слал кость с полным текстом плана и
// получал ROLL_CONTEXT_MISMATCH — ход оставался без ответа.
import assert from 'node:assert/strict'
import test from 'node:test'

import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { actionSequence } from '../server/intent-parser.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, normalizeCampaignState } from '../server/rules-engine.mjs'
import { dice } from './kit/dice.mjs'
import { createTestStore } from './kit/engine.mjs'

const SESSION = 'STEP-ROLL'
const HERO = 'hero-slot-1'
const PLAN = 'Мирель подходит к двери маяка, прислушивается, а потом осторожно поднимается по винтовой лестнице наверх, к фонарю — посмотреть, что там горит по ночам.'
const FIRST_STEP = 'Мирель подходит к двери маяка, прислушивается'

function campaignState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Маяк',
    activePlayerId: HERO,
    partyMemberIds: [HERO],
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

test('ручной бросок первого шага разрешается под текстом шага, и план сам идёт дальше', async (t) => {
  assert.equal(actionSequence(PLAN)[0], FIRST_STEP)
  const initial = normalizeCampaignState(campaignState())
  const eventStore = createTestStore(t, { prefix: 'skazanie-step-roll-' })
  await eventStore.initializeCampaign({ campaign_id: SESSION, initial_state: initial })
  // Игрок выбрасывает 18: с модификатором Мудрости это успех против СЛ 15.
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

  const offer = await send(PLAN, { idempotencyKey: 'plan', manualRoll: true })
  assert.doesNotMatch(String(offer.narration ?? ''), /Выполнить первый шаг/u)
  assert.ok(offer.check?.check_id, JSON.stringify(offer))
  assert.ok(offer.check.clarification_id, 'карточка несёт уточнение плана')
  assert.equal(offer.resolved_action, FIRST_STEP, 'карточка называет шаг, под которым зарегистрирован бросок')

  const issued = rollRegistry.issue({ checkId: offer.check.check_id, campaignId: SESSION, actorId: HERO })
  const verifiedRoll = rollRegistry.consume(issued.roll_id, { campaignId: SESSION, actorId: HERO, idempotencyKey: 'resolve' })
  const resolved = await send(offer.resolved_action, { idempotencyKey: 'resolve', clarificationId: offer.check.clarification_id, verifiedRoll })
  const ability = (resolved.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
  assert.ok(ability, JSON.stringify(resolved))
  assert.equal(ability.payload.roll_id, issued.roll_id)
  assert.equal(ability.payload.success, true)
  // Без модели второй шаг получает запасное уточнение — важно, что план до
  // него дошёл, а не оборвался на первом.
  assert.match(String(resolved.clarification?.action ?? resolved.narration), /лестниц/u, 'второй шаг плана начат')
})
