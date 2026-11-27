import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'

function dice(values = []) {
  let index = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `npc-consequence-roll-${++index}`,
    now: () => '2026-09-16T12:00:00.000Z',
  })
}

function allowed(fixture) {
  return { allowedActorIds: [fixture.heroId] }
}

function independentQuest() {
  return {
    id: 'quest:independent-road',
    title: 'Самостоятельный путь',
    summary: 'Независимая цель отряда.',
    status: 'active',
    visibility: 'party',
    entity_ids: [],
    objectives: ['Найти безопасную дорогу на юг.'],
    clock: { current: 1, max: 4, label: 'Поиск дороги' },
  }
}

async function combatFixture(options = {}) {
  const fixture = await palaceFixture(options)
  if (options.extraOfficeQuest) {
    const officeQuest = fixture.state.worldMemory.quests.find((quest) => quest.responsibility?.type === 'office')
    fixture.state.worldMemory.quests.push({ ...structuredClone(officeQuest), id: 'quest:second-office-task' })
  }
  if (options.inventory) fixture.state.npc_world.inventories[fixture.kingId] = structuredClone(options.inventory)
  fixture.state = normalizeCampaignState({
    ...fixture.state,
    worldMemory: {
      ...fixture.state.worldMemory,
      quests: [...fixture.state.worldMemory.quests, independentQuest(), {
        ...independentQuest(), id: 'quest:discover-king-fate', title: 'Установить судьбу короля',
        entity_ids: [fixture.kingId], objectives: ['Получить подтверждение судьбы короля'],
      }],
    },
  })
  const random = dice([20, 1, 1, 1, ...Array(200).fill(1)])
  const started = resolveCommand({
    command_type: 'AttackNpc', command_id: `attack-${options.kingHp ?? 20}`, actor_id: fixture.heroId, npc_id: fixture.kingId,
  }, fixture.state, { diceService: random, context: allowed(fixture) })
  const active = replayEvents(fixture.state, started.events)
  const beforeClock = structuredClone(active.worldMemory.quests.find((quest) => quest.responsibility?.type === 'npc')?.clock)
  const cast = resolveCommand({
    command_type: 'CastSpell', command_id: `fireball-${options.kingHp ?? 20}`, actor_id: fixture.heroId,
    spell_id: 'fireball', to: fixture.kingPoint, server_authoritative: true,
  }, active, { diceService: random, context: { ...allowed(fixture), serverAuthoritativeCombat: true } })
  const after = replayEvents(active, cast.events)
  return { fixture, initial: fixture.state, started, active, beforeClock, cast, after, diceService: random }
}

test('у последствий двух поручений одной должности разные устойчивые ID и ссылки на причину', async () => {
  const { cast } = await combatFixture({ kingHp: 1, extraOfficeQuest: true })
  const changed = cast.events.filter((event) => event.event_type === 'QuestAssignmentChanged')
  assert.equal(changed.length, 2)
  assert.equal(new Set(changed.map((event) => event.event_id)).size, 2)
  for (const event of changed) {
    assert.ok(event.payload.dependency_id.includes(event.payload.quest_id))
    assert.equal(event.payload.policy_id, 'skazanie:quest-consequences-v2')
    assert.ok(event.payload.source_event_ids.every((id) => cast.events.some((cause) => cause.event_id === id)))
  }
})

test('штатный wizard CastSpell fireball повреждает короля и сохраняет его живым при достаточном HP', async () => {
  const result = await combatFixture({ kingHp: 20, witnesses: true })
  const damage = result.cast.events.find((event) => event.event_type === 'DamageApplied' && event.target_ids?.[0] === result.fixture.kingId)
  assert.ok(damage)
  assert.equal(damage.payload.hp_before, 20)
  assert.equal(damage.payload.hp_after, 12)
  assert.equal(result.cast.events.some((event) => event.event_type === 'NpcDied'), false)
  assert.equal(result.after.npc_world.vitals[result.fixture.kingId].alive, true)
  assert.equal(result.after.world_offices.offices[0].holder_npc_id, result.fixture.kingId)
  assert.equal(result.after.mechanics.resources[result.fixture.heroId].spell_slots_3.current, 1)
  assert.equal(result.cast.events.filter((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'spell_slots_3').length, 1)
})

test('смерть короля через fireball инвалидирует личное поручение и освобождает должность', async () => {
  const result = await combatFixture({ kingHp: 1, witnesses: false })
  const invalidated = result.cast.events.find((event) => event.event_type === 'QuestInvalidated')
  const vacancy = result.cast.events.find((event) => event.event_type === 'OfficeVacated')
  assert.ok(result.cast.events.some((event) => event.event_type === 'NpcDied'))
  assert.ok(invalidated)
  assert.ok(vacancy)
  assert.equal(invalidated.payload.quest_id, result.after.worldMemory.quests.find((quest) => quest.responsibility?.type === 'npc')?.id)
  assert.deepEqual(result.after.worldMemory.quests.find((quest) => quest.responsibility?.type === 'npc')?.clock, result.beforeClock)
  assert.equal(result.after.worldMemory.quests.find((quest) => quest.id === 'quest:independent-road')?.status, 'active')
  assert.equal(result.after.worldMemory.quests.find((quest) => quest.id === 'quest:discover-king-fate')?.status, 'active')
  assert.equal(result.after.worldMemory.quests.find((quest) => quest.id === 'quest:discover-king-fate')?.clock.current, 1)
  assert.deepEqual(result.after.worldMemory.quests.find((quest) => quest.id === 'quest:independent-road')?.clock, {
    ...independentQuest().clock,
    triggered: false,
  })
  assert.equal(result.after.npc_world.vitals[result.fixture.kingId].alive, false)
  assert.equal(result.after.world_offices.offices[0].status, 'vacant')
  assert.equal(result.after.world_offices.offices[0].holder_npc_id, null)
})

test('без свидетелей убийство остаётся тайным и не назначает публичную вину', async () => {
  const result = await combatFixture({ kingHp: 1, witnesses: false })
  const deeds = result.after.world_deeds.deeds.filter((deed) => deed.subject === 'Король Арес')
  assert.equal(deeds.length, 1)
  assert.deepEqual(deeds[0].witness_ids, [])
  assert.equal(deeds[0].secret, true)
  assert.equal(result.cast.events.some((event) => event.event_type === 'FactionReputationAdjusted'), false)
  assert.ok(result.cast.events.filter((event) => event.event_type === 'WitnessConsequencePropagated').every((event) => event.payload.witness_ids.length === 0))
})

test('после обычного окончания боя через сутки живой кандидат получает должность, мёртвый пропускается', async () => {
  const result = await combatFixture({ kingHp: 1, witnesses: false })
  const ended = resolveCommand({
    command_type: 'EndCombat', command_id: 'end-office-combat', actor_id: result.fixture.heroId, server_authoritative: true,
  }, result.after, { diceService: result.diceService, context: { ...allowed(result.fixture), serverAuthoritativeCombat: true } })
  const afterEnd = replayEvents(result.after, ended.events)
  const candidateDead = normalizeCampaignState({
    ...afterEnd,
    npc_world: {
      ...afterEnd.npc_world,
      vitals: { ...afterEnd.npc_world.vitals, 'astohan-ivara': { hp: 0, max_hp: 132, alive: false } },
    },
  })
  const skipped = resolveCommand({
    command_type: 'AdvanceTime', command_id: 'advance-dead-candidate', amount: 1_440, unit: 'minute', server_authoritative: true,
  }, candidateDead, { diceService: result.diceService, context: allowed(result.fixture) })
  const skippedState = replayEvents(candidateDead, skipped.events)
  assert.equal(skipped.events.find((event) => event.event_type === 'OfficeSuccessionSkipped')?.payload.reason, 'candidate_dead')
  assert.equal(skippedState.world_offices.offices[0].status, 'vacant')
  assert.equal(skippedState.world_offices.offices[0].holder_npc_id, null)

  const live = await combatFixture({ kingHp: 1, witnesses: false })
  const liveEnd = resolveCommand({
    command_type: 'EndCombat', command_id: 'end-live-office-combat', actor_id: live.fixture.heroId, server_authoritative: true,
  }, live.after, { diceService: live.diceService, context: { ...allowed(live.fixture), serverAuthoritativeCombat: true } })
  const liveAfterEnd = replayEvents(live.after, liveEnd.events)
  const advanced = resolveCommand({
    command_type: 'AdvanceTime', command_id: 'advance-live-candidate', amount: 1_440, unit: 'minute', server_authoritative: true,
  }, liveAfterEnd, { diceService: live.diceService, context: allowed(live.fixture) })
  const advancedState = replayEvents(liveAfterEnd, advanced.events)
  assert.equal(advanced.events.find((event) => event.event_type === 'OfficeHolderInstalled')?.payload.holder_npc_id, 'astohan-ivara')
  assert.equal(advancedState.world_offices.offices[0].holder_npc_id, 'astohan-ivara')
  assert.equal(advancedState.worldMemory.quests.find((quest) => quest.id === 'quest:astohan-crown-report')?.giver_npc_id, 'astohan-ivara')
  assert.equal(advancedState.worldMemory.quests.find((quest) => quest.id === 'quest:independent-road')?.status, 'active')
})

test('смерть, должность и квесты совпадают после replay полного потока', async () => {
  const result = await combatFixture({ kingHp: 1, witnesses: false })
  const ended = resolveCommand({
    command_type: 'EndCombat', command_id: 'end-replay-combat', actor_id: result.fixture.heroId, server_authoritative: true,
  }, result.after, { diceService: result.diceService, context: { ...allowed(result.fixture), serverAuthoritativeCombat: true } })
  const afterEnd = replayEvents(result.after, ended.events)
  const advanced = resolveCommand({
    command_type: 'AdvanceTime', command_id: 'advance-replay', amount: 1_440, unit: 'minute', server_authoritative: true,
  }, afterEnd, { diceService: result.diceService, context: allowed(result.fixture) })
  const finalState = replayEvents(afterEnd, advanced.events)
  const replayed = replayEvents(result.initial, [...result.started.events, ...result.cast.events, ...ended.events, ...advanced.events])
  assert.deepEqual(replayed, finalState)
})

test('огненный шар затрагивает социального NPC через его авторские спасброски и сопротивления', async () => {
  for (const kingHp of [1, 20]) {
    const fixture = await palaceFixture({ kingHp, witnesses: false })
    // Защита объявлена до действия в листе фикстуры; исход от неё не подгоняется.
    fixture.state.npc_world.profiles[fixture.kingId].damage_resistances = ['fire']
    fixture.state.npc_world.profiles[fixture.kingId].saving_throws.dex = 5
    const initial = normalizeCampaignState({ ...fixture.state,
      enemies: [{ id: 'other-enemy', name: 'Противник', hp: 50, maxHp: 50, armor: 12, alive: true, x: 7, y: 6 }],
      mechanics: { ...fixture.state.mechanics,
        positions: { ...fixture.state.mechanics.positions, 'other-enemy': { x: 7, y: 6 } },
        combat: { active: true, round: 1, active_index: 0,
          initiative: [{ actor_id: fixture.heroId, total: 20 }, { actor_id: 'other-enemy', total: 5 }],
        },
      },
    })
    const result = resolveCommand({ command_type: 'CastSpell', actor_id: fixture.heroId,
      command_id: `social-fireball-${kingHp}`, spell_id: 'fireball', to: fixture.kingPoint, server_authoritative: true,
    }, initial, { diceService: dice(Array(20).fill(1)), context: allowed(fixture) })
    const save = result.events.find((event) => event.event_type === 'NpcSavingThrowResolved' && event.payload.npc_id === fixture.kingId)
    assert.equal(save.payload.modifier, initial.npc_world.profiles[fixture.kingId].saving_throws.dex)
    const after = replayEvents(initial, result.events)
    assert.equal(after.npc_world.vitals[fixture.kingId].hp, Math.max(0, kingHp - 4))
    assert.equal(result.events.filter((event) => event.event_type === 'NpcHarmed').length, 1)
    assert.equal(result.events.filter((event) => event.event_type === 'NpcDied').length, kingHp === 1 ? 1 : 0)
    assert.equal(after.mechanics.resources[fixture.heroId].spell_slots_3.current, 1)
  }
})

test('уход, отдых, возврат и амнистия сохраняют судьбу NPC и не дублируют имущество', async () => {
  const result = await combatFixture({ kingHp: 1, witnesses: true, inventory: [{
    id: 'royal-gift', name: 'Подаренный факел', catalog_id: 'srd_5_2_1:torch', quantity: 2, type: 'gear', origin: 'gifted',
  }] })
  let state = result.after
  const events = []
  const apply = (command, context = { isAdmin: true }) => {
    const resolved = resolveCommand({ command_id: `return:${events.length}`, ...command }, state,
      { diceService: result.diceService, context })
    events.push(...resolved.events)
    state = replayEvents(state, resolved.events)
    return resolved.events
  }
  apply({ command_type: 'EndCombat', actor_id: result.fixture.heroId, server_authoritative: true }, { ...allowed(result.fixture), serverAuthoritativeCombat: true })
  const originalLocation = result.initial.scene.location
  const originalLocationId = result.initial.scene.location_id
  const sceneArgs = { title: 'Стоянка', location: 'Стоянка', location_id: 'consequence-camp', mood: 'Тихо', objective: 'Отдохнуть',
    transition: 'Отряд покидает город.', arrival: 'Отряд добирается до стоянки.', hook: 'Можно отдохнуть.', theme: 'camp', danger: 'низкая',
    scene_kind: 'wilderness', seed: 'consequence-camp', map: { layout: 'streets', width: 9, height: 9, openness: 0.8, water: 0, featureCount: 2 } }
  apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
  apply({ command_type: 'StartRest', actor_id: result.fixture.heroId, kind: 'short' }, allowed(result.fixture))
  apply({ command_type: 'AdvanceTime', amount: 60, unit: 'minute' })
  apply({ command_type: 'CompleteRest', actor_id: result.fixture.heroId, kind: 'short' }, allowed(result.fixture))
  apply({ command_type: 'AdvanceScene', scene_args: { ...sceneArgs, title: 'Возвращение в галерею', location: originalLocation,
    location_id: originalLocationId, transition: 'Отряд возвращается.', arrival: 'Галерея изменилась.', hook: 'Правитель погиб.', theme: 'town' } })
  apply({ command_type: 'ClearWantedLevel', reason: 'amnesty' }, { isAdmin: true })
  assert.equal(state.npc_world.vitals[result.fixture.kingId].alive, false)
  assert.equal(state.enemies.some((enemy) => enemy.id === result.fixture.kingId && enemy.hp > 0), false)
  assert.equal(state.worldMemory.quests.find((quest) => quest.responsibility?.type === 'npc').status, 'failed')
  assert.equal(state.campaignConcept.story_history.length, 1)
  assert.equal(events.some((event) => event.event_type === 'NpcDied'), false)
  assert.equal(events.some((event) => event.event_type === 'LootContainerCreated'), false)
  assert.equal(result.after.loot_containers.containers.length, 1)
  assert.deepEqual(state.loot_containers, result.after.loot_containers)
  assert.deepEqual(replayEvents(result.after, events), state)
})
