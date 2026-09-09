import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  bindFreeActionReadingToState,
  freeActionResolutionPolicy,
  resolveHazardContact,
} from '../server/free-action-adjudication.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { addProp, createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

function state({ withFire = true, fireX = 1, fireRevealed = true } = {}) {
  const map = createTacticalMap({
    width: 4,
    height: 1,
    locationId: 'hazard-test',
    seed: 'hazard-test',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  if (withFire) {
    addProp(map, {
      id: 'campfire-1',
      assetId: 'campfire',
      x: fireX + 0.5,
      y: 0.5,
      footprint: [{ x: fireX, y: 0 }],
    })
    if (!fireRevealed) setCell(map, fireX, 0, { revealed: false })
  }
  return normalizeCampaignState({
    sessionCode: 'HAZARD-TEST',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Ада', hp: 20, maxHp: 20, speed: 30, x: 0, y: 0,
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [],
    }],
    scene: { title: 'Огонь', location: 'Огонь', cells: [], map: serializeTacticalMap(map) },
  })
}

test('контакт с подтверждённым огнём использует огненный, а не дробящий урон', () => {
  const text = 'Сажусь жопой в огонь'
  const reading = bindFreeActionReadingToState(state(), 'hero', text, {
    activity_kind: 'stunt', ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous',
    risk: 'serious', consequence_type: 'injury', hazard: 'fire',
  })
  const policy = freeActionResolutionPolicy(reading)
  assert.equal(policy.failure.damage_expression, '2d6')
  assert.equal(policy.failure.damage_type, 'fire')
  const contact = resolveHazardContact(state(), 'hero', text, reading)
  assert.equal(contact.status, 'contact')
  assert.equal(contact.hazard_id, 'fire')
})

test('явный контакт с огнём сохраняет direct self hazard даже при чтении модели hazard_damage', async () => {
  for (const fields of [
    { target_id: 'hero' },
    { effect_target: 'hero' },
    { effect_target: 'campfire-1' },
  ]) {
    const initial = state()
    const { orchestrator, eventStore } = await setupOrchestrator(initial, {
      goal_summary: 'Сесть в огонь', approach_summary: 'Герой садится на горящий костёр',
      ability: 'str', skill: 'athletics', activity_kind: 'environmental', duration_class: 'instant',
      plausibility: 'plausible', risk: 'serious', effect: 'hazard_damage', hazard: 'fire',
      consequence_type: 'injury', action_cost: 'action', ...fields,
    })
    const result = await orchestrator.handle({
      state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
      message: 'Сажусь жопой на огонь', idempotencyKey: `fire-model-self-${Object.keys(fields)[0]}`,
    })
    assert.equal(result.free_action_outcome, 'hazard_contact')
    assert.match(result.narration, /Ожог: Ада получает 7 огненного урона/u)
    assert.equal(result.verification.valid, true)
    assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
    assert.equal(result.mechanics.find((event) => event.event_type === 'DamageApplied').payload.damage_type, 'fire')
    assert.equal((await eventStore.load('HAZARD-TEST')).state.players.find((entry) => entry.id === 'hero').hp, 13)
  }
})

test('чужая цель и посадка рядом с огнём не становятся самоуроном', () => {
  const base = state()
  const foreign = resolveHazardContact(base, 'hero', 'Сажусь жопой на огонь', {
    effect: 'hazard_damage', hazard: 'fire', effect_target: 'other', target_id: 'other', risk: 'serious',
  })
  assert.equal(foreign, null)
  const near = resolveHazardContact(base, 'hero', 'Сажусь рядом с огнём', {
    effect: 'hazard_damage', hazard: 'fire', effect_target: 'hero', risk: 'serious',
  })
  assert.equal(near, null)
  for (const text of ['Не сажусь в огонь', 'Не сяду на огонь', 'Сажусь в огонь?', 'Если я сажусь в огонь']) {
    assert.equal(resolveHazardContact(base, 'hero', text, { hazard: 'fire', risk: 'minor' }), null, text)
  }
})

test('неизвестный или далёкий огонь не даёт списать урон только словами', () => {
  const text = 'Сажусь жопой в огонь'
  const reading = bindFreeActionReadingToState(state({ withFire: false }), 'hero', text, {
    activity_kind: 'stunt', ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous',
    risk: 'serious', consequence_type: 'injury', hazard: 'fire',
  })
  assert.equal(resolveHazardContact(state({ withFire: false }), 'hero', text, reading).status, 'unavailable')
  assert.equal(resolveHazardContact(state({ fireX: 3 }), 'hero', text, reading).status, 'unavailable')
  assert.equal(resolveHazardContact(state({ fireRevealed: false }), 'hero', text, reading).status, 'unavailable')
})

async function setupOrchestrator(initialState, adjudication = {
  goal_summary: 'Осознанно сесть в огонь', approach_summary: 'Сажусь рядом с огнём',
  ability: 'dex', skill: 'acrobatics', activity_kind: 'stunt', duration_class: 'instant',
  plausibility: 'strenuous', risk: 'serious', effect: 'none', hazard: 'fire',
  consequence_type: 'injury', action_cost: 'action',
}, diceRolls = [3, 4, 20]) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-hazard-contact-'))
  let eventId = 0
  const dice = new DiceService({ rng: new SequenceDiceRng(diceRolls), idFactory: () => `hazard-roll-${++eventId}` })
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
    idFactory: () => `hazard-event-${++eventId}`,
  })
  const orchestrator = new GameOrchestrator({
    rulesEngine: new RulesEngine({ diceService: dice }), eventStore,
    rollRegistry: new RollRegistry({ diceService: dice }),
    narrator: { render: async () => { throw new Error('hazard contact should not call narrator') } },
    idFactory: () => `hazard-turn-${++eventId}`,
  })
  orchestrator.unknownActionHandler.actionAdjudicator = {
    read: async () => ({ ...adjudication }),
  }
  await eventStore.initializeCampaign({ campaign_id: 'HAZARD-TEST', initial_state: initialState })
  return { orchestrator, eventStore, rollRegistry: orchestrator.rollRegistry }
}

test('огонь наносит самоурон напрямую, переживает replay и не бьёт второго героя', async () => {
  const initial = state()
  const { orchestrator, eventStore } = await setupOrchestrator(initial)
  const input = {
    state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
    message: 'Сажусь жопой в огонь', idempotencyKey: 'fire-contact-once',
  }
  const first = await orchestrator.handle(input)
  const damage = first.mechanics.filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.length, 1)
  assert.equal(damage[0].payload.damage_type, 'fire')
  assert.deepEqual(damage[0].target_ids, ['hero'])
  assert.equal(first.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal((await eventStore.load('HAZARD-TEST')).state.players.find((entry) => entry.id === 'hero').hp, 13)
  const beforeReplay = await eventStore.load('HAZARD-TEST')
  const replay = await orchestrator.handle(input)
  assert.equal(replay.idempotent_replay, true)
  assert.equal((await eventStore.load('HAZARD-TEST')).state_version, beforeReplay.state_version)
  assert.deepEqual((await eventStore.replay('HAZARD-TEST')).state, beforeReplay.state)
})

test('дальний или отсутствующий hazard в orchestrator не превращается в урон', async () => {
  const initial = state({ withFire: false })
  const { orchestrator, eventStore } = await setupOrchestrator(initial)
  const result = await orchestrator.handle({
    state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
    message: 'Сажусь жопой в огонь', idempotencyKey: 'fire-contact-unknown',
  })
  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /нет доступного источника этой опасности/u)
  assert.equal(result.verification.valid, true)
  assert.equal(result.mechanics.some((event) => event.event_type === 'DamageApplied'), false)
  assert.equal((await eventStore.load('HAZARD-TEST')).state.players.find((entry) => entry.id === 'hero').hp, 20)
})

test('неподтверждённое средство останавливает контакт с опасностью до ApplyDamage', async () => {
  const initial = state()
  const { orchestrator, eventStore } = await setupOrchestrator(initial, {
    goal_summary: 'Сесть в огонь', approach_summary: 'Сажусь в огонь с крыльями',
    ability: 'dex', skill: 'acrobatics', activity_kind: 'stunt', duration_class: 'instant',
    plausibility: 'impossible_without_means', risk: 'serious', required_means: ['крылья'],
    effect: 'none', hazard: 'fire', consequence_type: 'injury', action_cost: 'action',
  })
  const result = await orchestrator.handle({
    state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
    message: 'Сажусь жопой в огонь', idempotencyKey: 'fire-contact-missing-means',
  })
  assert.equal(result.free_action_outcome, 'counter_offer')
  assert.equal(result.mechanics.some((event) => event.event_type === 'DamageApplied'), false)
  assert.equal((await eventStore.load('HAZARD-TEST')).state.players.find((entry) => entry.id === 'hero').hp, 20)
})

test('перепрыгивание через подтверждённый огонь остаётся проверкой: успех не наносит урон, провал использует fire-профиль', async () => {
  const adjudication = {
    goal_summary: 'Перепрыгнуть через костёр', approach_summary: 'Прыгаю через костёр',
    ability: 'dex', skill: 'acrobatics', activity_kind: 'stunt', duration_class: 'brief',
    plausibility: 'strenuous', risk: 'minor', effect: 'none', hazard: 'fire',
    consequence_type: 'injury', action_cost: 'action',
  }
  for (const [diceRolls, expectedDamage] of [[[20], false], [[1, 3, 4], true]]) {
    const initial = state()
    const { orchestrator, eventStore, rollRegistry } = await setupOrchestrator(initial, adjudication, diceRolls)
    const text = 'Перепрыгиваю через костёр'
    const offered = await orchestrator.handle({
      state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
      message: text, idempotencyKey: `jump-offer-${expectedDamage}`,
    })
    assert.equal(offered.free_action_outcome, 'check_required')
    assert.match(offered.check.proposal.on_failure, /огненного|fire/u)
    const rolled = rollRegistry.issue({ checkId: offered.check.check_id, campaignId: 'HAZARD-TEST', actorId: 'hero' })
    const verifiedRoll = rollRegistry.consume(rolled.roll_id, { campaignId: 'HAZARD-TEST', actorId: 'hero', idempotencyKey: `jump-roll-${expectedDamage}` })
    const result = await orchestrator.handle({
      state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
      message: text, idempotencyKey: `jump-resolve-${expectedDamage}`, verifiedRoll,
    })
    const damage = result.mechanics.filter((event) => event.event_type === 'DamageApplied')
    assert.equal(damage.length > 0, expectedDamage)
    if (expectedDamage) assert.equal(damage[0].payload.damage_type, 'fire')
    assert.equal((await eventStore.load('HAZARD-TEST')).state.players.find((entry) => entry.id === 'hero').hp, expectedDamage ? 17 : 20)
  }
})

test('недееспособный герой не может намеренно коснуться опасности', async () => {
  const initial = state()
  initial.players[0] = { ...initial.players[0], hp: 0, alive: false }
  const { orchestrator, eventStore } = await setupOrchestrator(initial)
  const result = await orchestrator.handle({
    state: initial, campaignId: 'HAZARD-TEST', playerId: 'hero', allowedActorIds: ['hero'],
    message: 'Сажусь жопой в огонь', idempotencyKey: 'fire-contact-unconscious',
  })
  assert.equal(result.free_action_outcome, 'rejected')
  assert.equal(result.mechanics.some((event) => event.event_type === 'DamageApplied'), false)
  assert.equal((await eventStore.load('HAZARD-TEST')).state.players.find((entry) => entry.id === 'hero').hp, 0)
})

test('контакт с опасностью не может выбрать другого участника целью', () => {
  const base = state()
  const text = 'Сажусь жопой в огонь'
  const reading = bindFreeActionReadingToState(base, 'hero', text, {
    activity_kind: 'stunt', ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous',
    risk: 'serious', consequence_type: 'injury', hazard: 'fire', effect_target: 'other',
  })
  assert.equal(resolveHazardContact(base, 'hero', text, reading)?.status, 'unavailable')
})

test('причина травмы выбирает канонический тип урона', () => {
  for (const [hazard, damageType] of [['caustic', 'acid'], ['fall', 'bludgeoning'], ['crush', 'bludgeoning'], ['shards', 'piercing']]) {
    const text = hazard === 'caustic' ? 'Касаюсь кислоты' : hazard === 'fall' ? 'Падаю с обрыва' : hazard === 'crush' ? 'Врезаюсь в обвал' : 'Касаюсь осколков'
    const reading = bindFreeActionReadingToState(state(), 'hero', text, {
      activity_kind: 'stunt', ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous',
      risk: 'serious', consequence_type: 'injury', hazard,
    })
    assert.equal(freeActionResolutionPolicy(reading).failure.damage_type, damageType, hazard)
  }
})
