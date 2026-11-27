import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENCOUNTER_COINS_POLICY_ID,
  ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
  MAX_ENCOUNTER_COINS_CP,
  MAX_HERO_REWARD_INVENTORY_ITEMS,
  applyEncounterRewardsDistribution,
  assertEncounterDistributionPreconditions,
  assertEncounterRewardRecipients,
  distributeEncounterRewards,
  encounterCoinUnitsForXp,
  freezeEncounterOutcomePlan,
  lootForEncounterOutcome,
  rollEncounterCoins,
} from '../server/encounter-rewards.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_CATALOG, materializeCatalogItem } from '../server/item-catalog.mjs'
import { MAX_CURRENCY_CP, copperToCurrency, currencyToCopper } from '../server/merchant-economy.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'

const id = (slug) => `srd_5_2_1:${slug}`

function enemy(enemyId, statBlockId = id('giant-rat'), overrides = {}) {
  const xp = ITEM_XP[statBlockId]
  return {
    id: enemyId,
    stat_block_id: statBlockId,
    hp: 0,
    alive: false,
    provenance: { xp },
    ...overrides,
  }
}

const ITEM_XP = {
  [id('giant-rat')]: 25,
  [id('goblin-warrior')]: 50,
  [id('ogre')]: 450,
}

function rewardState({
  enemies = [enemy('rat-1')],
  party = ['hero-a', 'hero-b'],
  deaths = {},
  outcome = 'enemies_defeated',
  extraEnemies = [],
} = {}) {
  return {
    partyMemberIds: party,
    players: party.map((heroId) => ({
      id: heroId,
      hp: heroId.includes('stable') ? 0 : 10,
      maxHp: 10,
      currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
      inventory: [],
    })),
    enemies: [...enemies, ...extraEnemies],
    mechanics: {
      death: { heroes: deaths },
      encounter: {
        id: 'encounter-reward-v2',
        encounter_id: 'encounter-reward-v2',
        status: 'ended',
        outcome,
        theme: 'generic',
        difficulty: 'hard',
        enemy_ids: enemies.map((entry) => entry.id),
        enemies: enemies.map((entry) => ({ id: entry.id, stat_block_id: entry.stat_block_id })),
      },
    },
  }
}

function throwsCode(action, code) {
  assert.throws(action, (error) => error?.code === code, code)
}

test('frozen outcome берёт XP только из stat block и игнорирует постороннего мёртвого enemy', () => {
  const rat = enemy('rat', id('giant-rat'), { xp: Number.MAX_SAFE_INTEGER })
  const goblin = enemy('goblin', id('goblin-warrior'), { xp: -999 })
  const outsider = enemy('outsider', id('ogre'))
  const state = rewardState({ enemies: [rat, goblin], extraEnemies: [outsider] })
  const plan = freezeEncounterOutcomePlan(state, 'enemies_defeated')

  assert.equal(Object.isFrozen(plan), true)
  assert.equal(plan.total_xp, 75)
  assert.deepEqual(plan.enemies, [
    { enemy_id: 'rat', stat_block_id: id('giant-rat'), xp: 25 },
    { enemy_id: 'goblin', stat_block_id: id('goblin-warrior'), xp: 50 },
  ])
  assert.equal(plan.enemies.some((entry) => entry.enemy_id === 'outsider'), false)
})

test('dead исключён из recipients, но stable герой с 0 HP остаётся', () => {
  const state = rewardState({
    party: ['hero-a', 'hero-dead', 'hero-stable'],
    deaths: {
      'hero-dead': { status: 'dead' },
      'hero-stable': { status: 'stable' },
    },
  })
  assert.deepEqual(freezeEncounterOutcomePlan(state).recipients, ['hero-a', 'hero-stable'])
})

test('invalid outcome plans отклоняются до единого DiceService roll', () => {
  let calls = 0
  const dice = { roll() { calls += 1; throw new Error('roll must not happen') } }
  const run = (state) => rollEncounterCoins(freezeEncounterOutcomePlan(state), dice)
  const base = rewardState()

  const duplicate = structuredClone(base)
  duplicate.mechanics.encounter.enemy_ids.push('rat-1')
  throwsCode(() => run(duplicate), 'ENCOUNTER_ENEMY_DUPLICATE')

  const thirteenEnemies = Array.from({ length: 13 }, (_, index) => enemy(`rat-${index + 1}`))
  throwsCode(() => run(rewardState({ enemies: thirteenEnemies })), 'ENCOUNTER_ENEMY_COUNT_INVALID')

  const unknown = structuredClone(base)
  unknown.enemies = []
  throwsCode(() => run(unknown), 'ENCOUNTER_ENEMY_UNKNOWN')

  const living = rewardState({ enemies: [enemy('rat-1', id('giant-rat'), { hp: 1, alive: true })] })
  throwsCode(() => run(living), 'ENCOUNTER_ENEMY_LIVING')

  const missingHp = rewardState({ enemies: [enemy('rat-1')] })
  delete missingHp.enemies[0].hp
  delete missingHp.enemies[0].alive
  throwsCode(() => run(missingHp), 'ENCOUNTER_ENEMY_LIVING')

  const nanHp = rewardState({ enemies: [enemy('rat-1', id('giant-rat'), { hp: Number.NaN, alive: true })] })
  throwsCode(() => run(nanHp), 'ENCOUNTER_ENEMY_LIVING')

  const foreign = structuredClone(base)
  foreign.mechanics.encounter.enemies[0].stat_block_id = id('ogre')
  throwsCode(() => run(foreign), 'ENCOUNTER_ENEMY_FOREIGN')

  const mismatch = structuredClone(base)
  mismatch.enemies[0].provenance.xp = 9_999
  throwsCode(() => run(mismatch), 'ENCOUNTER_ENEMY_XP_MISMATCH')

  const outsiderPromoted = structuredClone(base)
  outsiderPromoted.mechanics.encounter.enemy_ids.push('foreign')
  outsiderPromoted.enemies.push(enemy('foreign'))
  throwsCode(() => run(outsiderPromoted), 'ENCOUNTER_ENEMY_FOREIGN')

  assert.equal(calls, 0)
})

test('coins rat/goblin/ogre: sorted, один 1d6 на enemy и полная provenance', () => {
  const state = rewardState({
    enemies: [
      enemy('z-rat', id('giant-rat')),
      enemy('a-ogre', id('ogre')),
      enemy('m-goblin', id('goblin-warrior')),
    ],
  })
  let nextId = 0
  const dice = new DiceService({
    rng: new SequenceDiceRng([6, 3, 2]),
    idFactory: () => `coin-roll-${++nextId}`,
    now: () => '2026-07-31T00:00:00.000Z',
  })
  const coins = rollEncounterCoins(freezeEncounterOutcomePlan(state), dice)

  assert.equal(coins.policy, ENCOUNTER_COINS_POLICY_ID)
  assert.deepEqual(coins.rolls.map((roll) => roll.enemy_id), ['a-ogre', 'm-goblin', 'z-rat'])
  assert.deepEqual(coins.rolls.map((roll) => roll.expression), ['1d6', '1d6', '1d6'])
  assert.deepEqual(coins.rolls.map((roll) => roll.dice), [[6], [3], [2]])
  assert.deepEqual(coins.rolls.map((roll) => roll.xp_units), [18, 2, 1])
  assert.deepEqual(coins.rolls.map((roll) => roll.amount_cp), [108, 6, 2])
  assert.equal(coins.total_cp, 116)
  assert.deepEqual(coins.rolls.map((roll) => roll.roll_id), ['coin-roll-1', 'coin-roll-2', 'coin-roll-3'])
})

test('coin cap держит 12 malicious MAX_SAFE enemies в пределах 288000 cp', () => {
  assert.equal(encounterCoinUnitsForXp(Number.MAX_SAFE_INTEGER), 4_000)
  assert.equal(encounterCoinUnitsForXp(Number.POSITIVE_INFINITY), 4_000)
  const plan = {
    rewards_eligible: true,
    encounter_id: 'malicious-max',
    enemies: Array.from({ length: 12 }, (_, index) => ({
      enemy_id: `enemy-${String(index).padStart(2, '0')}`,
      stat_block_id: id('ogre'),
      xp: Number.MAX_SAFE_INTEGER,
    })),
  }
  const dice = new DiceService({
    rng: new SequenceDiceRng(Array(12).fill(6)),
    idFactory: (() => { let value = 0; return () => `max-roll-${++value}` })(),
  })
  const result = rollEncounterCoins(plan, dice)
  assert.equal(result.total_cp, MAX_ENCOUNTER_COINS_CP)
  assert.equal(result.rolls.length, 12)
  assert.ok(result.rolls.every((roll) => roll.amount_cp === 24_000))
})

test('hard loot materialized stack разворачивается в physical units и делится round-robin', () => {
  const state = rewardState({ party: ['hero-a', 'hero-b', 'hero-c'] })
  const plan = { encounter_id: 'unit-split', total_xp: 0, recipients: state.partyMemberIds }
  const loot = [materializeCatalogItem(id('torch'), { quantity: 3 })]
  const distribution = distributeEncounterRewards(state, {
    plan,
    coins: { total_cp: 5 },
    loot,
  })

  assert.equal(distribution.allocations.length, 3)
  assert.deepEqual(distribution.allocations.map((allocation) => allocation.items.length), [1, 1, 1])
  assert.ok(distribution.allocations.flatMap((allocation) => allocation.items).every((item) => item.quantity === 1))
  assert.equal(new Set(distribution.allocations.flatMap((allocation) => allocation.items.map((item) => item.id))).size, 3)
  assert.equal(distribution.allocations.reduce((sum, allocation) => sum + allocation.coins_cp, 0), 5)
  assert.ok(Math.max(...distribution.allocations.map((allocation) => allocation.coins_cp))
    - Math.min(...distribution.allocations.map((allocation) => allocation.coins_cp)) <= 1)
})

test('без living recipients XP, coins и physical loot сохраняются unassigned', () => {
  const state = rewardState({
    party: ['hero-dead'],
    deaths: { 'hero-dead': { status: 'dead' } },
  })
  const plan = freezeEncounterOutcomePlan(state)
  const loot = [materializeCatalogItem(id('rations-one-day'), { quantity: 4 })]
  const distribution = distributeEncounterRewards(state, { plan, coins: { total_cp: 17 }, loot })
  assert.deepEqual(distribution.allocations, [])
  assert.equal(distribution.unassigned.xp, plan.total_xp)
  assert.equal(distribution.unassigned.coins_cp, 17)
  assert.equal(distribution.unassigned.items.length, 4)
  assert.ok(distribution.unassigned.items.every((item) => item.quantity === 1))
})

test('distribution reducer additive: unrelated wallet change не теряется, replay точен', () => {
  const initial = normalizeCampaignState(rewardState({ party: ['hero-a'] }))
  const plan = freezeEncounterOutcomePlan(initial)
  const loot = lootForEncounterOutcome(plan)
  const distribution = distributeEncounterRewards(initial, { plan, coins: { total_cp: 7 }, loot })
  const changed = normalizeCampaignState({
    ...initial,
    players: initial.players.map((player) => ({ ...player, currency: copperToCurrency(100) })),
  })
  assert.equal(assertEncounterDistributionPreconditions(changed, distribution), true)
  const event = {
    event_type: 'EncounterRewardsDistributed',
    event_schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
    payload: distribution,
    target_ids: ['hero-a'],
    state_version_after: 1,
  }
  const applied = applyGameEvent(changed, event)
  assert.equal(currencyToCopper(applied.players[0].currency), 107)
  assert.equal(applied.players[0].inventory.length, distribution.allocations[0].items.length)
  assert.deepEqual(replayEvents(changed, [event]), applied)
})

test('overflow отклоняет весь distribution до mutation, reducer malformed payload не применяет частично', () => {
  const state = rewardState({ party: ['hero-a'] })
  state.players[0].currency = copperToCurrency(MAX_CURRENCY_CP)
  const distribution = {
    schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
    encounter_id: 'overflow',
    allocations: [{ recipient_id: 'hero-a', xp: 0, coins_cp: 1, items: [{ id: 'never-added', quantity: 1 }] }],
    unassigned: { xp: 0, coins_cp: 0, items: [] },
  }
  throwsCode(() => assertEncounterDistributionPreconditions(state, distribution), 'CURRENCY_LIMIT_EXCEEDED')

  const normalized = normalizeCampaignState(state)
  const before = structuredClone(normalized.players)
  const recipients = applyEncounterRewardsDistribution(normalized, {
    event_type: 'EncounterRewardsDistributed',
    event_schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
    payload: distribution,
  })
  assert.deepEqual(recipients, [])
  assert.deepEqual(normalized.players, before)
})

test('legacy ServerLootGenerated остаётся payload-only, unknown distribution version — no-op', () => {
  const initial = normalizeCampaignState(rewardState({ party: ['hero-a'] }))
  const legacy = applyGameEvent(initial, {
    event_type: 'ServerLootGenerated',
    event_schema_version: 1,
    payload: { loot: [{ catalog_id: id('potion-of-healing'), quantity: 9 }] },
    state_version_after: 1,
  })
  assert.deepEqual(legacy.players, initial.players)

  const unknown = normalizeCampaignState(initial)
  const before = structuredClone(unknown.players)
  assert.deepEqual(applyEncounterRewardsDistribution(unknown, {
    event_type: 'EncounterRewardsDistributed',
    event_schema_version: 2,
    payload: { schema_version: 2, allocations: [] },
  }), [])
  assert.deepEqual(unknown.players, before)
})

test('physical loot обходит перегруженного героя и сохраняет честный round-robin', () => {
  const state = rewardState({ party: ['hero-full', 'hero-free'] })
  state.players[0].abilities = { str: 1 }
  state.players[0].inventory = [{ id: 'load', name: 'Груз', weight: 15, quantity: 1 }]
  const plan = { encounter_id: 'capacity-skip', total_xp: 0, recipients: state.partyMemberIds }
  const distribution = distributeEncounterRewards(state, {
    plan,
    coins: { total_cp: 2 },
    loot: [materializeCatalogItem(id('torch'), { quantity: 3 })],
  })
  const full = distribution.allocations.find((entry) => entry.recipient_id === 'hero-full')
  const free = distribution.allocations.find((entry) => entry.recipient_id === 'hero-free')
  assert.deepEqual(full.items, [])
  assert.equal(free.items.length, 3)
  assert.deepEqual(distribution.unassigned.items, [])
})

test('loot остаётся unassigned, когда capacity или 200 inventory slots исчерпаны', () => {
  const capacityState = rewardState({ party: ['hero-full'] })
  capacityState.players[0].abilities = { str: 1 }
  capacityState.players[0].inventory = [{ id: 'load', name: 'Груз', weight: 15, quantity: 1 }]
  const capacityDistribution = distributeEncounterRewards(capacityState, {
    plan: { encounter_id: 'capacity-none', total_xp: 0, recipients: ['hero-full'] },
    coins: { total_cp: 1 },
    loot: [materializeCatalogItem(id('torch'), { quantity: 3 })],
  })
  assert.deepEqual(capacityDistribution.allocations[0].items, [])
  assert.equal(capacityDistribution.unassigned.items.length, 3)
  assert.equal(capacityDistribution.allocations[0].coins_cp, 1)

  const slotState = rewardState({ party: ['hero-slots'] })
  slotState.players[0].inventory = Array.from({ length: MAX_HERO_REWARD_INVENTORY_ITEMS }, (_, index) => ({
    id: `filler-${index}`,
    name: 'Лёгкий предмет',
    weight: 0,
    quantity: 1,
  }))
  const slotDistribution = distributeEncounterRewards(slotState, {
    plan: { encounter_id: 'slots-none', total_xp: 0, recipients: ['hero-slots'] },
    coins: { total_cp: 0 },
    loot: [materializeCatalogItem(id('torch'), { quantity: 1 })],
  })
  assert.deepEqual(slotDistribution.allocations[0].items, [])
  assert.equal(slotDistribution.unassigned.items.length, 1)
})

test('distribution precondition и reducer зеркально отклоняют negative/fractional coins', () => {
  for (const coinsCp of [-1, 0.5]) {
    const state = normalizeCampaignState(rewardState({ party: ['hero-a'] }))
    const distribution = {
      schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
      encounter_id: `bad-coins-${coinsCp}`,
      allocations: [{ recipient_id: 'hero-a', xp: 0, coins_cp: coinsCp, items: [] }],
      unassigned: { xp: 0, coins_cp: 0, items: [] },
    }
    throwsCode(() => assertEncounterDistributionPreconditions(state, distribution), 'CURRENCY_LIMIT_EXCEEDED')
    const before = structuredClone(state.players)
    assert.deepEqual(applyEncounterRewardsDistribution(state, {
      event_type: 'EncounterRewardsDistributed',
      event_schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
      payload: distribution,
    }), [])
    assert.deepEqual(state.players, before)
  }
})

test('capacity, изменившаяся после frozen allocation, не финализирует silent no-op', () => {
  const initial = rewardState({ party: ['hero-a'] })
  const distribution = distributeEncounterRewards(initial, {
    plan: { encounter_id: 'capacity-race', total_xp: 0, recipients: ['hero-a'] },
    coins: { total_cp: 0 },
    loot: [materializeCatalogItem(id('torch'), { quantity: 1 })],
  })
  assert.equal(distribution.allocations[0].items.length, 1)

  const changed = normalizeCampaignState(rewardState({ party: ['hero-a'] }))
  changed.players[0].abilities = { str: 1 }
  changed.players[0].inventory = [{ id: 'late-load', name: 'Груз', weight: 15, quantity: 1 }]
  throwsCode(() => assertEncounterDistributionPreconditions(changed, distribution), 'ENCOUNTER_REWARD_STATE_CHANGED')
  const before = structuredClone(changed.players)
  assert.deepEqual(applyEncounterRewardsDistribution(changed, {
    event_type: 'EncounterRewardsDistributed',
    event_schema_version: ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION,
    payload: distribution,
  }), [])
  assert.deepEqual(changed.players, before)
})

test('frozen XP recipients запрещают missing или duplicate перераспределение', () => {
  const state = rewardState({ party: ['hero-a', 'hero-b'] })
  assert.equal(assertEncounterRewardRecipients(state, ['hero-a', 'hero-b']), true)
  throwsCode(
    () => assertEncounterRewardRecipients(state, ['hero-a', 'missing']),
    'ENCOUNTER_REWARD_RECIPIENT_CHANGED',
  )
  throwsCode(
    () => assertEncounterRewardRecipients(state, ['hero-a', 'hero-a']),
    'ENCOUNTER_REWARD_RECIPIENT_CHANGED',
  )
})

class RewardStageRaceStore {
  constructor() {
    this.state = normalizeCampaignState(rewardState({ party: ['hero-a'] }))
    this.commits = new Map()
    this.commitCalls = 0
  }

  async load() {
    return { state: structuredClone(this.state), state_version: this.state.state_version }
  }

  async getByIdempotencyKey(_campaignId, key) {
    return structuredClone(this.commits.get(key) ?? null)
  }

  async commit(request) {
    this.commitCalls += 1
    await Promise.resolve()
    const stored = this.commits.get(request.idempotency_key)
    if (stored) {
      const error = new Error('simulated concurrent idempotency race')
      error.code = 'IDEMPOTENCY_CONFLICT'
      throw error
    }
    if (request.expected_state_version !== this.state.state_version) {
      const error = new Error('simulated state race')
      error.code = 'STATE_VERSION_CONFLICT'
      throw error
    }
    const events = request.events.map((entry, index) => ({
      ...structuredClone(entry),
      event_id: `race-event-${index + 1}`,
      state_version_before: this.state.state_version + index,
      state_version_after: this.state.state_version + index + 1,
    }))
    this.state.state_version += events.length
    const result = {
      duplicate: false,
      events,
      state: structuredClone(this.state),
      state_version: this.state.state_version,
    }
    this.commits.set(request.idempotency_key, structuredClone(result))
    return result
  }
}

test('два orchestrator instances принимают один canonical stage, loser перечитывает сохранённый payload', async () => {
  const store = new RewardStageRaceStore()
  const first = new AutonomousCampaignOrchestrator({ eventStore: store, rulesEngine: {} })
  const second = new AutonomousCampaignOrchestrator({ eventStore: store, rulesEngine: {} })
  const key = 'encounter-completion:race:coins'
  const stage = [{
    event_type: 'EncounterCoinsRolled',
    event_schema_version: 1,
    payload: {
      schema_version: 1,
      encounter_id: 'race',
      policy: ENCOUNTER_COINS_POLICY_ID,
      rolls: [],
      total_cp: 0,
    },
  }]
  const [left, right] = await Promise.all([
    first.commitEventsWithRetry('RACE', key, stage),
    second.commitEventsWithRetry('RACE', key, stage),
  ])
  assert.equal(store.commitCalls, 2)
  assert.equal([left, right].filter((result) => result.duplicate).length, 1)
  assert.deepEqual(left.events, right.events)
  assert.equal(store.commits.size, 1)
})

test('state-version retry повторно проверяет актуальное состояние перед commit', async () => {
  const store = new RewardStageRaceStore()
  const originalCommit = store.commit.bind(store)
  let conflictInjected = false
  store.commit = async (request) => {
    if (!conflictInjected) {
      conflictInjected = true
      store.state.state_version += 1
      const error = new Error('simulated unrelated commit')
      error.code = 'STATE_VERSION_CONFLICT'
      throw error
    }
    return originalCommit(request)
  }
  const orchestrator = new AutonomousCampaignOrchestrator({ eventStore: store, rulesEngine: {} })
  const validatedVersions = []
  const result = await orchestrator.commitEventsWithRetry('RACE', 'encounter-completion:race:loot', [{
    event_type: 'ServerLootGenerated',
    event_schema_version: 2,
    payload: { schema_version: 2, encounter_id: 'race', loot: [] },
  }], {
    validateState: (state) => validatedVersions.push(state.state_version),
  })
  assert.deepEqual(validatedVersions, [0, 1])
  assert.equal(result.duplicate, false)
  assert.equal(result.state_version, 2)
})
