import assert from 'node:assert/strict'
import test from 'node:test'

import { merchantViewFor } from '../server/merchant-economy.mjs'
import { MILESTONES_PER_LEVEL, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

/**
 * Контракт данных для экранов игрока.
 *
 * Компонентных тестов в проекте нет — нет и DOM-раннера, — поэтому UI
 * проверяется с той стороны, где ошибка реально возникает: сервер перестал
 * присылать поле, и экран молча опустел. Здесь закреплены **ровно те пути**,
 * которые читают три экрана из P4.2. Меняете форму проекции — этот тест
 * падает и напоминает поправить интерфейс.
 */

function campaign({ milestones = 0, reputations = {}, quests = [], threads = [], summaries = [] } = {}) {
  let state = normalizeCampaignState({
    sessionCode: 'UI-CONTRACT',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    scene: { title: 'Рынок', location: 'Рынок', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, currency: { gold: 50 }, inventory: [] }],
    autonomy: { reputations, pacing: { beat: 2, phase: 'development', tension: 30 }, travel_history: [] },
    worldMemory: {
      entities: [{ id: 'location:market', kind: 'location', name: 'Рынок', summary: '', visibility: 'party' }],
      facts: [], relationships: [], epistemic_claims: [], knowledge_ledger: [],
      quests, threads, summaries,
    },
  })
  for (let index = 1; index <= milestones; index += 1) {
    state = applyGameEvent(state, {
      event_id: `m-${index}`, event_type: 'MilestoneAwarded', actor_id: 'hero', target_ids: [],
      payload: { milestone: 'encounter-resolved', encounter_id: `e-${index}` }, visibility: 'party', source_rule_ids: [],
    })
  }
  return state
}

const asPlayer = (state) => campaignStateForViewer(state, { role: 'player', id: 'u1' }, 'hero')

test('чип прогрессии: экран читает mechanics.progression и получает все нужные поля', () => {
  const projected = asPlayer(campaign({ milestones: MILESTONES_PER_LEVEL - 1 }))
  const progression = projected.mechanics?.progression

  assert.ok(progression, 'mechanics.progression обязан доезжать до игрока')
  assert.equal(typeof progression.milestones_since_level, 'number')
  assert.equal(typeof progression.milestones_per_level, 'number')
  assert.equal(progression.level_up_available, false)

  const earned = asPlayer(campaign({ milestones: MILESTONES_PER_LEVEL })).mechanics.progression
  assert.equal(earned.level_up_available, true, 'после порога экран обязан показать заслуженный уровень')
})

test('чип славы: экран читает autonomy.reputation_standing со ступенями, а не числом', () => {
  const standing = asPlayer(campaign({ reputations: { guild: -80, watch: 30 } })).autonomy?.reputation_standing

  assert.ok(Array.isArray(standing))
  assert.deepEqual(standing.map((entry) => entry.tier), ['reviled', 'respected'])
  for (const entry of standing) {
    assert.equal(typeof entry.faction_id, 'string')
    assert.ok(['reviled', 'distrusted', 'unknown', 'respected', 'honoured'].includes(entry.tier), `неизвестная ступень ${entry.tier}`)
  }
})

test('журнал задач: экран читает worldMemory.quests с целями и часами', () => {
  const projected = asPlayer(campaign({
    quests: [{
      id: 'quest:caravan', title: 'Пропавший караван', summary: 'Караван не дошёл.', status: 'active',
      visibility: 'party', entity_ids: [], objectives: ['Опросить очевидцев'], clock: { current: 1, max: 4, label: 'След остывает' },
    }],
    threads: [{ id: 'thread:smugglers', title: 'Контрабандисты', summary: 'Кто-то платит страже.', status: 'active', visibility: 'party', entity_ids: [], quest_ids: [] }],
    summaries: [{ id: 'summary:1', kind: 'scene', title: 'Прибытие', summary: 'Отряд прибыл в город.', visibility: 'party', entity_ids: [], thread_ids: [], source_event_ids: ['e1'] }],
  }))
  const quest = projected.worldMemory?.quests?.find((entry) => entry.id === 'quest:caravan')

  assert.ok(quest, 'квест обязан доезжать до игрока')
  assert.equal(quest.title, 'Пропавший караван')
  assert.deepEqual(quest.objectives, ['Опросить очевидцев'])
  assert.equal(quest.clock.current, 1)
  assert.equal(quest.clock.max, 4)
  assert.equal(projected.worldMemory.threads[0].title, 'Контрабандисты')
  assert.equal(projected.worldMemory.summaries[0].summary, 'Отряд прибыл в город.')
})

test('окно торговца: расшифровка несёт поправку славы и причину отказа в услуге', () => {
  const state = campaign({ reputations: { guild: -80 } })
  state.merchants = [{
    id: 'merchant-1', name: 'Марта', location: 'Рынок', available: true,
    pricing: { mode: 'catalog_with_agent_adjustment' }, purse_cp: 100_000,
    tags: ['faction:guild'],
    stock: [{ stock_id: 's1', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: 3, base_price_cp: 5_000 }],
    services: [{ service_id: 'svc-room', name: 'Ночлег', kind: 'lodging', base_price_cp: 100, available: true }],
  }]
  state.social = {
    npcs: [{ id: 'merchant-1', name: 'Марта', role: 'торговка', location: 'Рынок', public_summary: '', voice: '', visibility: 'party', available: true, tags: ['faction:guild'] }],
    relationships: {}, promises: [], conversations: [],
  }

  const view = merchantViewFor(state, 'merchant-1', 'hero')
  const buy = view.buy_quotes[0]
  assert.equal(typeof buy.breakdown.reputation_adjustment_percent, 'number')
  assert.ok(buy.breakdown.reputation_adjustment_percent > 0, 'дурная слава обязана удорожать покупку')

  const service = view.service_quotes[0]
  assert.equal(service.available, false)
  assert.equal(typeof service.unavailable_reason, 'string')
  assert.ok(service.unavailable_reason.length > 5, 'причина отказа обязана быть читаемой фразой, а не кодом')
})
