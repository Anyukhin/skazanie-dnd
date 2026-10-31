// Повтор осмотра с тем же ключом отвечает той же версией, что и первый ответ.
//
// Прогон Асстохана без модели 2026-10-12 (сид 2): «Внимательно осматриваю всё
// вокруг» записало проверку (1198 → 1199) и следом под ключом `:discovery` —
// сдвиг времени тщательного поиска (1199 → 1200). Первый ответ сообщал 1200,
// повтор — 1199: на повторе план проверки не строится, и коммит находки не
// подмешивался.
import assert from 'node:assert/strict'
import test from 'node:test'

import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RulesEngine, normalizeCampaignState } from '../server/rules-engine.mjs'
import { dice } from './kit/dice.mjs'
import { createTestStore } from './kit/engine.mjs'

const SESSION = 'CHECK-REPLAY'
const HERO = 'hero-1'

function campaignState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Застава',
    activePlayerId: HERO,
    partyMemberIds: [HERO],
    messages: [],
    players: [{
      id: HERO, character: 'Ильва', name: 'Ильва', className: 'cleric', hp: 20, maxHp: 20, armor: 14, proficiency: 2,
      abilities: { str: 10, dex: 10, con: 12, int: 10, wis: 14, cha: 10 }, inventory: [], online: true,
    }],
    enemies: [],
    scene: { title: 'Застава', location: 'Пепельная застава', mood: 'Пепел', objective: 'Понять, кто впустил дракона', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

test('повтор осмотра с тем же ключом возвращает версию вместе с коммитом находки', async (t) => {
  const eventStore = createTestStore(t, { prefix: 'skazanie-check-replay-' })
  await eventStore.initializeCampaign({ campaign_id: SESSION, initial_state: normalizeCampaignState(campaignState()) })
  const game = new GameOrchestrator({
    // Провал броска: тщательный поиск вне спешки стоит времени отдельным коммитом.
    rulesEngine: new RulesEngine({ diceService: dice([2, 2, 2, 2]) }),
    eventStore,
    narrator: { render: async () => ({ narration: 'Пепел и обломки.', provider: 'deterministic-test' }) },
  })
  const send = async () => game.handle({
    state: (await eventStore.load(SESSION)).state, campaignId: SESSION, playerId: HERO, allowedActorIds: [HERO],
    message: 'Внимательно осматриваю всё вокруг, ищу следы и тайники', requestKind: 'action', idempotencyKey: 'idem-search',
  })
  const first = await send()
  const types = (first.mechanics ?? []).map((event) => event.event_type)
  assert.ok(types.includes('AbilityCheckResolved'), JSON.stringify(types))
  const discovery = await eventStore.getByIdempotencyKey(SESSION, 'idem-search:discovery')
  assert.ok(discovery, 'у осмотра есть второй коммит — находка или время поиска')
  const second = await send()
  assert.equal(second.state_version, first.state_version, 'повтор не отстаёт на коммит находки')
  assert.equal((await eventStore.load(SESSION)).state_version, first.state_version, 'повтор ничего не дописал')
})
