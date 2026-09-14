import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { footprintCellsFor, footprintMetadataForSize } from '../server/actor-footprint.mjs'
import {
  RulesEngine,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  createTacticalMap,
  legacyCellsFromTacticalMap,
  serializeTacticalMap,
  setCell,
  setEdge,
} from '../server/tactical-map.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `footprint-event-roll-${++id}`,
    now: () => '2026-09-12T12:00:00.000Z',
  })
}

function options(values = []) {
  return { diceService: dice(values), context: { serverAuthoritativeCombat: true, isAdmin: true } }
}

function openMap(width = 8, height = 6, mutate = null) {
  const map = createTacticalMap({
    width,
    height,
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  mutate?.(map)
  return map
}

function actorState({
  map = openMap(),
  largeAt = { x: 1, y: 1 },
  heroAt = { x: 6, y: 4 },
  combat = true,
  includeLarge = true,
} = {}) {
  const large = {
    id: 'ogre',
    name: 'Огр',
    creature_type: 'giant',
    hp: 59,
    maxHp: 59,
    armor: 11,
    speed: 30,
    level: 7,
    size: 'large',
    footprint: { version: 1, size: 2 },
    abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    action_profiles: [{
      id: 'greatclub',
      name: 'Палица',
      kind: 'melee',
      attack_modifier: 6,
      damage_expression: '2d8+4',
      damage_type: 'bludgeoning',
      range_feet: 5,
    }],
    alive: true,
    ...largeAt,
  }
  const hero = {
    id: 'hero',
    character: 'Герой',
    hp: 40,
    maxHp: 40,
    armor: 14,
    speed: 30,
    level: 5,
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
    ...heroAt,
  }
  const initiative = includeLarge
    ? [{ actor_id: 'ogre', total: 20 }, { actor_id: 'hero', total: 10 }]
    : [{ actor_id: 'hero', total: 20 }]
  return normalizeCampaignState({
    sessionCode: 'FOOTPRINT-EVENTS',
    partyMemberIds: ['hero'],
    activePlayerId: includeLarge ? 'ogre' : 'hero',
    players: [hero],
    enemies: includeLarge ? [large] : [],
    scene: {
      title: 'Каменный зал',
      location: 'Каменный зал',
      turn: 1,
      map: serializeTacticalMap(map),
      cells: legacyCellsFromTacticalMap(map),
    },
    mechanics: {
      positions: {
        hero: { x: hero.x, y: hero.y },
        ...(includeLarge ? { ogre: { x: large.x, y: large.y } } : {}),
      },
      combat: {
        active: combat,
        round: 1,
        active_index: 0,
        initiative,
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ...(includeLarge ? { ogre: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } : {}),
        },
      },
    },
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function rejectsWithCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `ожидался отказ ${code}`)
}

test('большой актор проходит открытый шаг, а commit и replay сохраняют весь event-поток', () => {
  const initial = actorState({ largeAt: { x: 1, y: 1 }, heroAt: { x: 6, y: 4 } })
  const result = resolveCommand({
    command_type: 'MoveActor',
    command_id: 'large-step',
    actor_id: 'ogre',
    to: { x: 2, y: 1 },
    server_authoritative: true,
  }, initial, options())

  const moved = result.events.find((event) => event.event_type === 'ActorMoved')
  assert.ok(moved)
  assert.deepEqual(moved.payload.to, { x: 2, y: 1 })
  assert.deepEqual(moved.payload.path, [{ x: 2, y: 1 }])

  const applied = applyAll(initial, result.events)
  assert.deepEqual(applied.mechanics.positions.ogre, { x: 2, y: 1 })
  assert.deepEqual(replayEvents(initial, result.events), applied)
})

test('2×2 тело отвергает узкий проход, внутреннюю стену и занятый угол', () => {
  const narrow = actorState({
    largeAt: { x: 1, y: 1 },
    heroAt: { x: 6, y: 4 },
    map: openMap(8, 6, (map) => setCell(map, 3, 2, { passable: false, type: 'wall' })),
  })
  rejectsWithCode(() => resolveCommand({
    command_type: 'MoveActor', command_id: 'large-narrow', actor_id: 'ogre',
    to: { x: 2, y: 1 }, server_authoritative: true,
  }, narrow, options()), 'INVALID_DESTINATION')

  const internalWall = actorState({
    largeAt: { x: 1, y: 1 },
    heroAt: { x: 6, y: 4 },
    map: openMap(8, 6, (map) => setEdge(map, 2, 1, 3, 1, { kind: 'wall' })),
  })
  rejectsWithCode(() => resolveCommand({
    command_type: 'MoveActor', command_id: 'large-internal-wall', actor_id: 'ogre',
    to: { x: 2, y: 1 }, server_authoritative: true,
  }, internalWall, options()), 'INVALID_DESTINATION')

  const occupiedCorner = actorState({
    largeAt: { x: 1, y: 1 },
    heroAt: { x: 3, y: 2 },
  })
  rejectsWithCode(() => resolveCommand({
    command_type: 'MoveActor', command_id: 'large-occupied-corner', actor_id: 'ogre',
    to: { x: 2, y: 1 }, server_authoritative: true,
  }, occupiedCorner, options()), 'INVALID_DESTINATION')
})

test('ближняя атака большого существа считает расстояние от края площади как 5 футов', () => {
  const initial = actorState({ largeAt: { x: 1, y: 1 }, heroAt: { x: 3, y: 1 } })
  const result = resolveCommand({
    command_type: 'MakeAttack',
    command_id: 'large-edge-melee',
    actor_id: 'ogre',
    target_id: 'hero',
    action_id: 'greatclub',
    server_authoritative: true,
  }, initial, options([15, 4, 4]))

  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.ok(attack)
  assert.equal(attack.payload.distance_feet, 5)
  assert.equal(attack.payload.hit, true)
  assert.deepEqual(attack.payload.trajectory[0], { x: 1, y: 1 }, 'визуальная траектория начинается с anchor тела')
  assert.deepEqual(attack.payload.trajectory.at(-1), { x: 3, y: 1 }, 'визуальная траектория заканчивается anchor цели')
  const applied = applyAll(initial, result.events)
  assert.deepEqual(applied.battleLog.at(-1).from, { x: 1, y: 1 })
  assert.deepEqual(applied.battleLog.at(-1).to, { x: 3, y: 1 })
  assert.deepEqual(replayEvents(initial, result.events), applied)
})

test('площадное заклинание попадает в угол 2×2 ровно одним спасброском и уроном', () => {
  const map = openMap(10, 10)
  const initial = normalizeCampaignState({
    ...actorState({ map, includeLarge: false, combat: true, heroAt: { x: 0, y: 9 } }),
    players: [{
      id: 'caster',
      character: 'Волшебник',
      characterClass: 'wizard',
      level: 5,
      hp: 40,
      maxHp: 40,
      armor: 12,
      speed: 30,
      proficiency: 3,
      abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
      knownSpellIds: ['fireball'],
      preparedSpellIds: ['fireball'],
      inventory: [],
      x: 0,
      y: 9,
    }],
    partyMemberIds: ['caster'],
    activePlayerId: 'caster',
    enemies: [{
      id: 'ogre', name: 'Огр', creature_type: 'giant', hp: 100, maxHp: 100,
      armor: 11, speed: 30, level: 7, size: 'large', footprint: { version: 1, size: 2 },
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
      alive: true, x: 3, y: 3,
    }],
    mechanics: {
      positions: { caster: { x: 0, y: 9 }, ogre: { x: 3, y: 3 } },
      resources: { caster: { spell_slots_3: { current: 1, max: 1 } } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'ogre', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ogre: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  const result = resolveCommand({
    command_type: 'CastSpell',
    command_id: 'fireball-large-corner',
    actor_id: 'caster',
    spell_id: 'fireball',
    to: { x: 4, y: 4 },
    slot_level: 3,
    server_authoritative: true,
  }, initial, options([4, 4, 4, 4, 4, 4, 4, 4, 1]))

  const saves = result.events.filter((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('ogre'))
  const damage = result.events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('ogre'))
  assert.equal(saves.length, 1, 'одна площадь не должна дать два спасброска одной цели')
  assert.equal(damage.length, 1, 'угол footprint не должен умножать урон')
  const applied = applyAll(initial, result.events)
  assert.equal(applied.enemies.find((actor) => actor.id === 'ogre').hp, 68)
  assert.deepEqual(replayEvents(initial, result.events), applied)
})

test('призыв и встреча получают footprint из серверного профиля, а forged metadata клиента игнорируется', () => {
  const summonInitial = normalizeCampaignState({
    ...actorState({ map: openMap(10, 6), includeLarge: true, largeAt: { x: 8, y: 4 }, heroAt: { x: 1, y: 1 } }),
    players: [{
      id: 'caster', character: 'Зов', characterClass: 'wizard', level: 9, hp: 40, maxHp: 40,
      armor: 13, speed: 30, proficiency: 4,
      abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 18 },
      knownSpellIds: ['summon-undead'], preparedSpellIds: ['summon-undead'], inventory: [], x: 1, y: 1,
    }],
    partyMemberIds: ['caster'],
    activePlayerId: 'caster',
    enemies: [{
      id: 'foe', name: 'Враг', hp: 60, maxHp: 60, armor: 12, speed: 30, abilities: { str: 12, dex: 12, con: 12 },
      alive: true, x: 8, y: 4,
    }],
    mechanics: {
      positions: { caster: { x: 1, y: 1 }, foe: { x: 8, y: 4 } },
      resources: { caster: { spell_slots_3: { current: 1, max: 1 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'foe', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  const summonResult = resolveCommand({
    command_type: 'CastSpell', command_id: 'summon-forged-footprint', actor_id: 'caster',
    spell_id: 'summon-undead', to: { x: 5, y: 1 }, size: 'gargantuan',
    footprint: { version: 1, size: 4 }, server_authoritative: true,
  }, summonInitial, options())
  const summonEvent = summonResult.events.find((event) => event.event_type === 'SummonedCreatureCreated')
  assert.ok(summonEvent)
  const summon = summonEvent.payload.summon
  assert.notEqual(summon.footprint?.size, 4, 'размер призыва не берётся из тела команды клиента')
  assert.deepEqual(summon.footprint, footprintMetadataForSize(summon.size ?? 'medium'))
  const summoned = applyAll(summonInitial, summonResult.events)
  assert.deepEqual(replayEvents(summonInitial, summonResult.events), summoned)

  const encounterInitial = actorState({ map: openMap(12, 12), includeLarge: false, combat: false, heroAt: { x: 0, y: 0 } })
  const encounterResult = resolveCommand({
    command_type: 'CreateEncounter', command_id: 'encounter-forged-footprint',
    difficulty: 'hard', theme: 'raiders', seed: 'server-owned-encounter',
    encounter: {
      proposal_id: 'forged-proposal',
      enemies: [{ id: 'forged-enemy', size: 'gargantuan', footprint: { version: 1, size: 4 } }],
    },
  }, encounterInitial, options())
  const encounterEvent = encounterResult.events.find((event) => event.event_type === 'EncounterCreated')
  assert.ok(encounterEvent)
  const encounter = encounterEvent.payload.encounter
  assert.notEqual(encounter.proposal_id, 'forged-proposal')
  assert.ok(encounter.enemies.length > 0)
  assert.equal(encounter.enemies.some((enemy) => enemy.id === 'forged-enemy'), false)
  assert.ok(encounter.enemies.every((enemy) => enemy.footprint?.version === 1 && enemy.footprint.size >= 1 && enemy.footprint.size <= 4))
  const encountered = applyAll(encounterInitial, encounterResult.events)
  assert.deepEqual(replayEvents(encounterInitial, encounterResult.events), encountered)
})

test('коммит перемещения большого актора идемпотентен во временном event store', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-footprint-events-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const campaignId = 'FOOTPRINT-IDEMPOTENCY'
  const initial = actorState({ largeAt: { x: 1, y: 1 }, heroAt: { x: 6, y: 4 } })
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: campaignId, initial_state: initial })
  const executor = new AuthoritativeExecutor({
    eventStore: store,
    rulesEngine: new RulesEngine({ diceService: dice() }),
  })
  const input = {
    campaignId,
    idempotencyKey: 'large-move-once',
    context: { serverAuthoritativeCombat: true, isAdmin: true },
    commands: [{
      command_type: 'MoveActor', command_id: 'large-move-once', actor_id: 'ogre',
      to: { x: 2, y: 1 }, server_authoritative: true,
    }],
  }
  const first = await executor.executeCommands(input)
  const second = await executor.executeCommands(input)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)

  const loaded = await store.load(campaignId)
  const replayed = await store.replay(campaignId, { useSnapshots: false })
  assert.deepEqual(replayed.state, loaded.state)
  assert.deepEqual(loaded.state.mechanics.positions.ogre, { x: 2, y: 1 })
})

test('сценовый переход создаёт событие, которое переживает apply и replay', () => {
  const initial = actorState({ map: openMap(6, 6), includeLarge: false, combat: false, heroAt: { x: 1, y: 1 } })
  const result = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'footprint-scene-transition',
    scene_args: { title: 'Новый зал', location: 'Новый зал', objective: 'Идти дальше' },
  }, initial, { diceService: dice(), context: { isAdmin: true } })
  const sceneEvent = result.events.find((event) => event.event_type === 'SceneAdvanced')
  assert.ok(sceneEvent)
  assert.equal(sceneEvent.payload.scene.title, 'Новый зал')
  const applied = applyAll(initial, result.events)
  assert.equal(applied.scene.title, 'Новый зал')
  assert.deepEqual(replayEvents(initial, result.events), applied)
})

test('AdvanceScene размещает трёх крупных членов партии без перекрытия и сохраняет это в replay', () => {
  const map = openMap(6, 6)
  const party = Array.from({ length: 3 }, (_, index) => ({
    id: `large-hero-${index + 1}`,
    character: `Крупный герой ${index + 1}`,
    hp: 30,
    maxHp: 30,
    armor: 14,
    speed: 30,
    level: 5,
    size: 'large',
    footprint: footprintMetadataForSize('large'),
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
    x: index,
    y: 0,
  }))
  const initial = normalizeCampaignState({
    sessionCode: 'FOOTPRINT-SCENE-PARTY',
    partyMemberIds: party.map((actor) => actor.id),
    activePlayerId: party[0].id,
    players: party,
    enemies: [],
    scene: {
      title: 'Старый зал',
      location: 'Старый зал',
      turn: 1,
      map: serializeTacticalMap(map),
      cells: legacyCellsFromTacticalMap(map),
    },
    mechanics: {
      positions: Object.fromEntries(party.map((actor) => [actor.id, { x: actor.x, y: actor.y }])),
      combat: { active: false, round: 1, active_index: 0, initiative: [], action_economy: {} },
    },
  })
  const result = resolveCommand({
    command_type: 'AdvanceScene',
    command_id: 'large-party-scene-transition',
    scene_args: { title: 'Новый зал', location: 'Новый зал', objective: 'Идти дальше' },
  }, initial, { diceService: dice(), context: { isAdmin: true } })
  const sceneEvent = result.events.find((event) => event.event_type === 'SceneAdvanced')
  assert.ok(sceneEvent)
  assert.equal(sceneEvent.payload.party_positions.length, party.length)

  const cells = new Map(sceneEvent.payload.scene.cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
  const occupied = new Set()
  for (const position of sceneEvent.payload.party_positions) {
    const actor = party.find((candidate) => candidate.id === position.actor_id)
    assert.ok(actor)
    const footprint = footprintCellsFor(actor, position)
    assert.equal(footprint.length, 4)
    for (const cell of footprint) {
      const key = `${cell.x},${cell.y}`
      assert.equal(occupied.has(key), false, `клетка ${key} выдана двум крупным героям`)
      occupied.add(key)
      assert.ok(['floor', 'door'].includes(String(cells.get(key)?.type ?? '')), `площадь ${key} не помещается на входе`)
    }
  }

  const applied = applyAll(initial, result.events)
  assert.deepEqual(replayEvents(initial, result.events), applied)
  for (const position of sceneEvent.payload.party_positions) {
    assert.deepEqual(applied.mechanics.positions[position.actor_id], { x: position.x, y: position.y })
  }
})
