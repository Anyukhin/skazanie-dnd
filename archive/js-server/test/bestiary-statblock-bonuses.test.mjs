import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  previewD20Check,
  replayEvents,
  resolveCommand,
  skillProficiencyForActor,
} from '../server/rules-engine.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const record = (slug) => records.find((candidate) => candidate.id.endsWith(`:${slug}`))
const NPC_CONTEXT = Object.freeze({ isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })

function dice(values = [10]) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(Array.isArray(values) ? values : [values]),
    idFactory: () => `bestiary-statblock-${++id}`,
    now: () => '2026-09-08T00:00:00.000Z',
  })
}

function stateWith(enemy, player = null) {
  const hero = player ?? {
    id: 'hero', name: 'Герой', hp: 100, maxHp: 100, armor: 10, speed: 30, proficiency: 2,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 0, y: 0, alive: true,
  }
  return normalizeCampaignState({
    sessionCode: 'BESTIARY-STATBLOCK',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: [hero.id],
    players: [hero],
    enemies: [enemy],
    scene: {
      turn: 1,
      cells: Array.from({ length: 18 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: enemy.id, total: 20 }, { actor_id: hero.id, total: 10 }],
        action_economy: {
          [enemy.id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          [hero.id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function enemy(slug, position = { x: 1, y: 0 }) {
  const source = record(slug)
  const result = enemyFrom2014(source, position, 0)
  assert.equal(result.provenance.kind, 'server-owned-dnd-2014-stat-block')
  assert.equal(result.provenance.stat_block_id, source.id)
  return result
}

test('2014 stat-block skills and saves override ability fallbacks only for the runtime enemy', () => {
  const goblinState = stateWith(enemy('goblin'))
  const goblin = goblinState.enemies[0]
  assert.equal(skillProficiencyForActor(goblin, 'stealth', goblinState).explicit_total, 6)
  assert.equal(previewD20Check(goblinState, { actorId: goblin.id, kind: 'check', skill: 'stealth' }).modifier, 6)
  assert.equal(previewD20Check(goblinState, { actorId: goblin.id, kind: 'check', skill: 'acrobatics' }).modifier, 2)

  const mageState = stateWith(enemy('mage'))
  const mage = mageState.enemies[0]
  assert.equal(previewD20Check(mageState, { actorId: mage.id, kind: 'save', ability: 'int' }).modifier, 6)
  assert.equal(previewD20Check(mageState, { actorId: mage.id, kind: 'save', ability: 'wis' }).modifier, 4)

  const zeroState = stateWith(enemy('zombie'))
  assert.equal(previewD20Check(zeroState, { actorId: zeroState.enemies[0].id, kind: 'save', ability: 'wis' }).modifier, 0)

  const negative = enemy('goblin')
  negative.skills = { stealth: -1 }
  negative.saving_throws = { wis: 0 }
  const negativeState = stateWith(negative)
  assert.equal(previewD20Check(negativeState, { actorId: negativeState.enemies[0].id, kind: 'check', skill: 'stealth' }).modifier, -1)
  assert.equal(previewD20Check(negativeState, { actorId: negativeState.enemies[0].id, kind: 'save', ability: 'wis' }).modifier, 0)

  const forgedPlayer = {
    id: 'hero', name: 'Подделка', hp: 100, maxHp: 100, armor: 10, speed: 30, proficiency: 2,
    classSkillProficiencies: [],
    abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, x: 0, y: 0, alive: true,
    skills: { stealth: 99 }, saving_throws: { dex: 99 }, stat_block_id: 'dnd_5e_2014:monster:goblin',
    provenance: { kind: 'server-owned-dnd-2014-stat-block', ruleset_id: 'dnd_5e_2014', stat_block_id: 'dnd_5e_2014:monster:goblin' },
  }
  const forgedState = stateWith(enemy('goblin'), forgedPlayer)
  assert.equal(previewD20Check(forgedState, { actorId: 'hero', kind: 'check', skill: 'stealth' }).modifier, 2)
  assert.equal(previewD20Check(forgedState, { actorId: 'hero', kind: 'save', ability: 'dex' }).modifier, 2)
})

test('stat-block totals reach authoritative commands and survive replay', () => {
  const state = stateWith(enemy('mage'))
  const mage = state.enemies[0]
  const check = resolveCommand({
    command_type: 'MakeAbilityCheck', command_id: 'mage-stealth-check', actor_id: mage.id,
    skill: 'arcana', difficulty: 10, server_authoritative: true,
  }, state, { diceService: dice(), context: NPC_CONTEXT })
  assert.equal(check.rolls[0].modifier, 6)
  assert.equal(check.events.find((event) => event.event_type === 'AbilityCheckResolved').payload.total, 16)

  const save = resolveCommand({
    command_type: 'MakeSavingThrow', command_id: 'mage-int-save', actor_id: mage.id,
    ability: 'int', difficulty: 10, server_authoritative: true,
  }, state, { diceService: dice(), context: NPC_CONTEXT })
  assert.equal(save.rolls[0].modifier, 6)
  assert.equal(save.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 16)
  const applied = save.events.reduce(applyGameEvent, state)
  assert.deepEqual(replayEvents(state, save.events), applied)
})

test('действие Спрятаться использует полный бонус Скрытности гоблина', () => {
  const state = stateWith(enemy('goblin'))
  const goblin = state.enemies[0]
  const result = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'goblin-hide', actor_id: goblin.id,
    action_id: 'hide', server_authoritative: true,
  }, state, { diceService: dice([10]), context: NPC_CONTEXT })
  const check = result.events.find(event => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.modifier, 6)
  assert.equal(check.payload.total, 16)
  assert.ok(result.events.some(event => event.event_type === 'ConditionAdded' && event.payload.condition === 'hidden'))
})

test('stat-block Stealth is used when the engine decides surprise', () => {
  const enemyActor = enemy('goblin')
  const base = stateWith(enemyActor, {
    id: 'hero', name: 'Наблюдатель', hp: 100, maxHp: 100, armor: 10, speed: 30, proficiency: 2,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 }, x: 0, y: 0, alive: true,
  })
  const state = normalizeCampaignState({
    ...base,
    mechanics: {
      ...base.mechanics,
      conditions: { [enemyActor.id]: [{ id: 'hidden' }] },
      combat: { active: false },
    },
  })
  const result = resolveCommand({
    command_type: 'StartCombat', command_id: 'surprise-from-statblock', actor_id: 'hero', server_authoritative: true,
  }, state, { diceService: dice([10, 10]), context: NPC_CONTEXT })
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded'
    && event.payload.condition === 'surprised' && event.target_ids.includes('hero')))
})
