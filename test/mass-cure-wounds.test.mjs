import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, spellTargetsAt } from '../server/rules-engine.mjs'

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `mass-cure-roll-${++id}`,
    now: () => '2026-09-22T12:00:00.000Z',
  })
}

const options = (values) => ({
  diceService: dice(values),
  context: { isAdmin: true, serverAuthoritativeCombat: true },
})

const authoritative = (command) => ({ ...command, server_authoritative: true })

function actor(id, x, y, hp = 10, extra = {}) {
  return {
    id,
    character: id,
    characterClass: id === 'caster' ? 'cleric' : 'fighter',
    level: 9,
    hp,
    maxHp: 40,
    armor: 12,
    speed: 30,
    proficiency: 4,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: id === 'caster' ? 18 : 10, cha: 10 },
    inventory: [],
    x,
    y,
    alive: true,
    ...extra,
  }
}

function field() {
  const cells = Array.from({ length: 32 * 4 }, (_, index) => ({
    x: index % 32,
    y: Math.floor(index / 32),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'MASS-CURE-WOUNDS',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: ['caster', 'ally-1', 'ally-2', 'ally-3', 'ally-4', 'ally-5', 'dying', 'blocked', 'outside', 'edge'],
    players: [
      actor('caster', 1, 1, 40),
      actor('ally-1', 11, 1),
      actor('ally-2', 13, 1, 25),
      actor('ally-3', 15, 1),
      actor('ally-4', 13, 2),
      actor('ally-5', 13, 0),
      actor('dying', 12, 1, 0),
      actor('blocked', 14, 2),
      actor('outside', 20, 1),
      actor('edge', 19, 1),
      actor('undead', 16, 1, 20, { creature_type: 'undead' }),
      actor('construct', 16, 2, 20, { creature_type: 'construct' }),
    ],
    actors: [{
      id: 'summon',
      name: 'Призванный зверь',
      kind: 'summon',
      faction: 'party',
      ownerId: 'caster',
      hp: 10,
      maxHp: 30,
      armor: 12,
      speed: 30,
      abilities: { str: 14, dex: 12, con: 12 },
      x: 14,
      y: 1,
      alive: true,
    }],
    enemies: [actor('foe', 17, 0, 20)],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: {
        spell_slots_5: { current: 2, max: 2 },
        spell_slots_6: { current: 1, max: 1 },
      } },
      conditions: { blocked: [{ id: 'healing-blocked' }] },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function cast(state, targetIds, values = [2, 5, 7], extra = {}) {
  return resolveCommand(authoritative({
    command_type: 'CastSpell',
    command_id: extra.command_id ?? 'mass-cure-wounds-cast',
    actor_id: 'caster',
    spell_id: 'mass-cure-wounds',
    to: { x: 13, y: 1 },
    target_ids: targetIds,
    slot_level: extra.slot_level ?? 5,
    casting_resource: extra.casting_resource ?? 'spell_slots_5',
    ...extra,
  }), state, options(values))
}

test('Mass Cure Wounds лечит выбранных союзников одним общим броском, включая dying и summon', () => {
  const state = field()
  const result = cast(state, ['ally-1', 'ally-2', 'ally-3', 'ally-4', 'dying', 'summon'])
  const healing = result.events.filter((event) => event.event_type === 'HealingApplied')
  const roll = result.rolls.find((entry) => entry.purpose === 'spell_healing:mass-cure-wounds')
  assert.equal(healing.length, 6)
  assert.equal(result.rolls.filter((entry) => entry.purpose === 'spell_healing:mass-cure-wounds').length, 1)
  assert.equal(roll.expression, '3d8+4')
  assert.equal(roll.total, 18)
  assert.deepEqual(healing.map((event) => event.target_ids[0]), ['ally-1', 'ally-2', 'ally-3', 'ally-4', 'dying', 'summon'])
  assert.equal(healing.find((event) => event.target_ids[0] === 'ally-2').payload.applied_amount, 15)
  assert.equal(healing.find((event) => event.target_ids[0] === 'dying').payload.hp_after, 18)
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.events.find((event) => event.event_type === 'ResourceSpent').payload.after, 1)
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.resources.caster.spell_slots_5.current, 1)
  assert.equal(after.mechanics.combat.action_economy.caster.action, false)
  assert.deepEqual(result.events.reduce((next, event) => applyGameEvent(next, event), state), after)
})

test('ячейка шестого круга добавляет одну кость, но не добавляет цель; край сферы допустим', () => {
  const state = field()
  const result = cast(state, ['ally-1', 'ally-2', 'ally-3', 'ally-4', 'edge', 'summon'], [2, 5, 7, 3], {
    command_id: 'mass-cure-wounds-upcast',
    slot_level: 6,
    casting_resource: 'spell_slots_6',
  })
  const healing = result.events.filter((event) => event.event_type === 'HealingApplied')
  const roll = result.rolls.find((entry) => entry.purpose === 'spell_healing:mass-cure-wounds')
  assert.equal(healing.length, 6)
  assert.equal(roll.expression, '4d8+4')
  assert.equal(roll.total, 21)
  assert.deepEqual(result.events.find((event) => event.event_type === 'SpellCast').target_ids,
    ['ally-1', 'ally-2', 'ally-3', 'ally-4', 'edge', 'summon'])
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, 'spell_slots_6')
})

test('повторный commit Mass Cure Wounds идемпотентен и replay сохраняет расход и лечение', async (t) => {
  const initial = field()
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-mass-cure-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    initialStateFactory: () => structuredClone(initial),
    snapshotEvery: 0,
    clock: () => new Date('2026-09-22T12:00:00.000Z'),
  })
  await store.initializeCampaign({ campaign_id: 'mass-cure', initial_state: initial })
  const result = cast(initial, ['ally-1', 'ally-2', 'ally-3', 'ally-4', 'dying', 'summon'], [2, 5, 7], { command_id: 'mass-cure-idempotent' })
  const request = {
    campaign_id: 'mass-cure',
    expected_state_version: 0,
    idempotency_key: 'mass-cure-once',
    command_id: 'mass-cure-idempotent',
    events: result.events,
  }
  const first = await store.commit(request)
  const retry = await store.commit(request)
  assert.equal(first.duplicate, false)
  assert.equal(retry.duplicate, true)
  assert.equal(first.state.mechanics.resources.caster.spell_slots_5.current, 1)
  assert.equal(retry.state.mechanics.resources.caster.spell_slots_5.current, 1)
  assert.equal((await store.getEvents('mass-cure')).length, result.events.length)
  assert.deepEqual((await store.replay('mass-cure', { use_snapshots: false })).state, first.state)
})

test('нежить, конструкт и healing-blocked не получают исцеление, но выбранная валидная цель получает общий бросок', () => {
  const result = cast(field(), ['undead', 'construct', 'blocked', 'ally-1'])
  const healing = result.events.filter((event) => event.event_type === 'HealingApplied')
  assert.deepEqual(healing.map((event) => event.target_ids[0]).sort(), ['blocked', 'ally-1'].sort())
  assert.equal(healing.find((event) => event.target_ids[0] === 'blocked').payload.applied_amount, 0)
  assert.equal(result.rolls.filter((entry) => entry.purpose === 'spell_healing:mass-cure-wounds').length, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
})

test('выбранное существо не обязано быть союзником или видимым, если его ID уже передан серверу', () => {
  const state = field()
  state.scene.cells.find((cell) => cell.x === 17 && cell.y === 0).revealed = false
  const preview = spellTargetsAt(state, { actor_id: 'caster', to: { x: 13, y: 1 } }, canonicalCombatSpellFor('mass-cure-wounds'))
  assert.equal(preview.some((target) => target.id === 'foe'), false)
  const result = cast(state, ['foe'])
  assert.equal(result.events.filter((event) => event.event_type === 'HealingApplied').length, 1)
  assert.equal(result.events.find((event) => event.event_type === 'HealingApplied').target_ids[0], 'foe')
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
})

for (const [label, setup, code] of [
  ['дубликат', (state) => cast(state, ['ally-1', 'ally-1']), 'INVALID_SPELL_TARGETS'],
  ['седьмую цель', (state) => cast(state, ['ally-1', 'ally-2', 'ally-3', 'ally-4', 'ally-5', 'dying', 'summon']), 'TOO_MANY_SPELL_TARGETS'],
  ['цель вне сферы', (state) => cast(state, ['outside']), 'INVALID_SPELL_TARGET'],
  ['точку дальше 60 футов', (state) => cast(state, ['ally-1'], [2, 5, 7], { to: { x: 14, y: 1 } }), 'TARGET_OUT_OF_RANGE'],
  ['пустой список целей', (state) => cast(state, []), 'SPELL_TARGET_REQUIRED'],
]) test(`не расходует ячейку при отказе: ${label}`, () => {
  const state = field()
  const before = structuredClone(state)
  assert.throws(() => setup(state), { code })
  assert.deepEqual(state, before)
})
