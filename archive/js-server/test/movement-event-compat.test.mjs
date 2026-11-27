import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, movementForActor, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function field(conditions = [], spent = 0) {
  return normalizeCampaignState({
    sessionCode: 'MOVEMENT-COMPAT', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'], activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Мира', characterClass: 'wizard', level: 3, hp: 20, maxHp: 20,
      speed: 30, baseSpeed: 30, proficiency: 2, x: 0, y: 0,
      abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 12, cha: 8 },
      knownSpellIds: ['longstrider'], preparedSpellIds: ['longstrider'],
      inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'pouch', quantity: 1 })],
    }],
    scene: { turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: { world_time: { elapsed_minutes: 0 }, conditions: { hero: conditions },
      resources: { hero: { spell_slots_1: { current: 2, max: 2 } } },
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 20 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: spent, movement_bonus: 0 } },
      },
    },
  })
}

const spentEvent = (amount, version) => ({
  event_id: 'recorded-stand-up', event_type: 'CombatActionUsed', actor_id: 'hero', target_ids: ['hero'], state_version_after: 1,
  payload: { action_id: 'stand-up', action_type: 'free', movement_spent: amount,
    ...(version == null ? {} : { movement_contract_version: version }),
  },
})

for (const [condition, spent, amount, legacyAvailable, currentAvailable] of [
  ['hasted', 15, 15, false, true],
  ['slowed', 10, 5, true, false],
]) {
  test(`старый CombatActionUsed сохраняет прежний результат при ${condition}`, () => {
    const initial = field([{ id: condition }], spent)
    const event = spentEvent(amount)
    const direct = applyGameEvent(initial, event)
    const replayed = replayEvents(initial, [event])
    assert.deepEqual(replayed, direct)
    assert.equal(direct.mechanics.combat.action_economy.hero.movement_spent, spent + amount)
    assert.equal(direct.mechanics.combat.action_economy.hero.movement, legacyAvailable)
    assert.equal(initial.mechanics.combat.action_economy.hero.movement_spent, spent)
  })

  test(`CombatActionUsed v2 рассчитывает доступность по текущей скорости при ${condition}`, () => {
    const after = applyGameEvent(field([{ id: condition }], spent), spentEvent(amount, 2))
    assert.equal(after.mechanics.combat.action_economy.hero.movement, currentAvailable)
    assert.equal(after.mechanics.combat.action_economy.hero.movement_spent, spent + amount)
  })
}

test('настоящее вставание после Скорохода расходует половину текущих 40 футов и пишет v2', () => {
  const initial = field([{ id: 'prone' }])
  const execute = (state, input) => resolveCommand({ actor_id: 'hero', server_authoritative: true, ...input }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([10]) }),
    context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true },
  })
  const cast = execute(initial, { command_id: 'cast-speed', command_type: 'CastSpell', spell_id: 'longstrider', target_id: 'hero', slot_level: 1, casting_resource: 'spell_slots_1' })
  const buffed = replayEvents(initial, cast.events)
  assert.equal(movementForActor(buffed, 'hero').current_speed, 40)
  const stand = execute(buffed, { command_id: 'stand-current-speed', command_type: 'UseCombatAction', action_id: 'stand-up' })
  const event = stand.events.find((entry) => entry.event_type === 'CombatActionUsed')
  assert.equal(event.payload.movement_contract_version, 2)
  assert.equal(event.payload.movement_spent, 20)
  const after = replayEvents(buffed, stand.events)
  assert.equal(movementForActor(after, 'hero').movement_remaining, 20)
  assert.equal(after.mechanics.conditions.hero.some((entry) => entry.id === 'prone'), false)
  assert.equal(after.players[0].speed, 30)
  assert.deepEqual(replayEvents(initial, [...cast.events, ...stand.events]), after)
})

test('старый Рывок хранит плоскую прибавку, v2 пересчитывает её после истечения Скорохода', () => {
  const initial = field([{ id: 'longstrider', spell_id: 'longstrider', effect_id: 'speed-instance', started_at_seconds: 0, expires_at_seconds: 60 }])
  const dash = { event_type: 'CombatActionUsed', actor_id: 'hero', target_ids: ['hero'], payload: { action_id: 'dash', action_type: 'action', movement_bonus: 40 } }
  const expire = { event_type: 'TimeAdvanced', payload: { amount: 1, unit: 'minute', elapsed_minutes: 1 } }
  const legacy = replayEvents(initial, [dash, expire])
  assert.equal(movementForActor(legacy, 'hero').current_speed, 30)
  assert.equal(movementForActor(legacy, 'hero').movement_remaining, 70)
  const current = replayEvents(initial, [{ ...dash, payload: { ...dash.payload, movement_contract_version: 2, dash_count: 1 } }, expire])
  assert.equal(movementForActor(current, 'hero').current_speed, 30)
  assert.equal(movementForActor(current, 'hero').movement_remaining, 60)
  assert.equal(current.mechanics.combat.action_economy.hero.movement_bonus, 40, 'сохранённый совместимый credit не переписывается')
})
