import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

test('одноразовая удача расходует адресуемый экземпляр, сохраняя legacy-эффект при проверке и атаке', () => {
  const cases = [
    { command_type: 'MakeAbilityCheck', ability: 'wis', difficulty: 12 },
    { command_type: 'MakeSavingThrow', ability: 'wis', difficulty: 12 },
    { command_type: 'MakeAttack', target_id: 'enemy' },
    { command_type: 'CastSpell', spell_id: 'ray-of-frost', target_id: 'enemy' },
    { command_type: 'CastSpell', spell_id: 'acid-splash', target_id: 'enemy' },
  ]
  for (const [index, command] of cases.entries()) {
    const targetId = command.spell_id === 'acid-splash' ? 'enemy' : 'caster'
    const initial = normalizeCampaignState({
      sessionCode: 'FORTUNE-INSTANCE', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['caster'],
      players: [{ id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30,
        armor: 12, speed: 30, proficiency: 3, abilities: { str: 10, dex: 12, con: 12, int: 16, wis: 12, cha: 10 },
        inventory: [], knownSpellIds: ['acid-splash', 'ray-of-frost'], preparedSpellIds: [], x: 1, y: 1 }],
      enemies: [{ id: 'enemy', name: 'Цель', hp: 100, maxHp: 100, armor: 10, speed: 30, alive: true,
        abilities: { str: 10, dex: 10, con: 10 }, x: 2, y: 1 }],
      scene: { turn: 1, cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4), type: 'floor', revealed: true })) },
      mechanics: { combat: { active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      }, conditions: { [targetId]: [
        { id: 'silvery-fortune', source_actor: 'legacy' },
        { id: 'silvery-fortune', source_actor: 'other', effect_id: 'fortune-addressed' },
      ] } },
    })
    let rollId = 0
    const result = resolveCommand({ ...command, command_id: `fortune-${index}`, actor_id: 'caster', server_authoritative: true }, initial, {
      diceService: new DiceService({ rng: new SequenceDiceRng(Array(30).fill(1)), idFactory: () => `fortune-${index}-${++rollId}` }),
      context: { isAdmin: true, serverAuthoritativeCombat: true },
    })
    const removed = result.events.filter((entry) => entry.event_type === 'ConditionRemoved' && entry.payload.condition === 'silvery-fortune')
    assert.equal(removed.length, 1, command.command_type)
    assert.equal(removed[0].payload.effect_id, 'fortune-addressed')
    const after = replayEvents(initial, result.events)
    assert.deepEqual(after.mechanics.conditions[targetId].filter((entry) => entry.id === 'silvery-fortune').map((entry) => entry.source_actor), ['legacy'])
    const duplicateRemoval = applyGameEvent(after, removed[0])
    assert.deepEqual(duplicateRemoval.mechanics.conditions[targetId], after.mechanics.conditions[targetId])
  }
})

function concentrationState() {
  return normalizeCampaignState({
    sessionCode: 'SPELL-INTERACTIONS-AUDIT',
    partyMemberIds: ['caster'],
    players: [{ id: 'caster', character: 'Мира', characterClass: 'wizard', hp: 1, maxHp: 20, armor: 12, speed: 30, abilities: { con: 10, int: 16 }, x: 1, y: 1 }],
    enemies: [],
    scene: { turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }] },
    mechanics: {
      concentration: { caster: { effect_id: 'spell:web' } },
      conditions: { caster: [{ id: 'restrained', effect_id: 'spell:web', duration: 'concentration' }] },
      active_effects: [{ id: 'spell:web', effect_id: 'spell:web', concentration: true }],
      temporary_hp: { caster: 4 },
    },
  })
}

test('HeroDied очищает концентрацию, её condition и active effect одним lifecycle', () => {
  const event = {
    event_id: 'audit-hero-died', command_id: 'audit-hero-died', event_type: 'HeroDied', actor_id: 'system', target_ids: ['caster'],
    payload: {}, visibility: 'public',
  }
  const state = concentrationState()
  const after = applyGameEvent(state, event)
  assert.deepEqual(replayEvents(state, [event]), after)
  assert.equal(after.mechanics.concentration.caster, undefined)
  assert.equal(after.mechanics.conditions.caster.some((condition) => condition.effect_id === 'spell:web'), false)
  assert.equal(after.mechanics.active_effects.some((effect) => effect.effect_id === 'spell:web'), false)
  assert.equal(after.mechanics.temporary_hp.caster, undefined)
})

test('stale ConcentrationEnded не снимает более новую концентрацию', () => {
  const state = concentrationState()
  state.mechanics.concentration.caster = { effect_id: 'spell:moonbeam' }
  state.mechanics.active_effects = [
    { id: 'spell:web', effect_id: 'spell:web', concentration: true },
    { id: 'spell:moonbeam', effect_id: 'spell:moonbeam', concentration: true },
  ]
  const event = {
    event_id: 'audit-stale-end', command_id: 'audit-stale-end', event_type: 'ConcentrationEnded', actor_id: 'system', target_ids: ['caster'],
    payload: { effect_id: 'spell:web', reason: 'stale' }, visibility: 'public',
  }
  const after = applyGameEvent(state, event)
  assert.deepEqual(replayEvents(state, [event]), after)
  assert.deepEqual(after.mechanics.concentration.caster, { effect_id: 'spell:moonbeam' })
  assert.ok(after.mechanics.active_effects.some((effect) => effect.effect_id === 'spell:moonbeam'))
})

test('снятие состояния с явным effect_id сохраняет другой источник и совместимо с legacy-снятием', () => {
  const state = concentrationState()
  state.mechanics.conditions.caster = [
    { id: 'restrained', effect_id: 'web:one' },
    { id: 'restrained', effect_id: 'web:two' },
    { id: 'bless-d4', effect_id: 'bless:three' },
  ]
  const remove = { event_type: 'ConditionRemoved', actor_id: 'system', target_ids: ['caster'],
    payload: { condition: 'restrained', effect_id: 'web:one' } }
  const after = applyGameEvent(state, remove)
  assert.deepEqual(after.mechanics.conditions.caster.map((entry) => entry.effect_id), ['web:two', 'bless:three'])
  assert.deepEqual(replayEvents(state, [remove]), after)
  assert.deepEqual(applyGameEvent(after, remove).mechanics.conditions.caster, after.mechanics.conditions.caster)
  const legacy = applyGameEvent(after, { ...remove, payload: { condition: 'restrained' } })
  assert.deepEqual(legacy.mechanics.conditions.caster.map((entry) => entry.id), ['bless-d4'])
})

test('boolean condition сохраняет независимые источники, обновляет только тот же effect и снимается по источнику', () => {
  const state = normalizeCampaignState({
    sessionCode: 'SPELL-INTERACTIONS-AUDIT-REFRESH',
    partyMemberIds: ['caster'],
    players: [{ id: 'caster', character: 'Мира', characterClass: 'wizard', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { con: 10, int: 16 }, x: 1, y: 1 }],
    enemies: [{ id: 'target', name: 'Цель', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { con: 10, wis: 10 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }, { x: 2, y: 1, type: 'floor', revealed: true }] },
    mechanics: { conditions: { target: [{ id: 'blinded', effect_id: 'blindness-old', duration: 'rounds:1' }] } },
  })
  const first = {
    event_id: 'audit-refresh-blindness', command_id: 'audit-refresh-blindness', event_type: 'ConditionAdded', actor_id: 'caster', target_ids: ['target'],
    payload: { condition: 'blinded', effect_id: 'blindness-new', duration: 'rounds:10', source_actor: 'caster', spell_id: 'blindness-deafness' }, visibility: 'public',
  }
  const refresh = {
    ...first,
    event_id: 'audit-refresh-blindness-2', command_id: 'audit-refresh-blindness-2',
    payload: { ...first.payload, duration: 'rounds:20' },
  }
  const otherSource = {
    ...first,
    event_id: 'audit-refresh-blindness-other', command_id: 'audit-refresh-blindness-other', actor_id: 'other-caster',
    payload: { ...first.payload, effect_id: 'blindness-other', duration: 'rounds:2', source_actor: 'other-caster' },
  }
  const removeOld = {
    event_id: 'audit-remove-blindness-old', command_id: 'audit-remove-blindness-old', event_type: 'ConditionRemoved', actor_id: 'system', target_ids: ['target'],
    payload: { condition: 'blinded', effect_id: 'blindness-old' }, visibility: 'public',
  }
  const removeNew = {
    event_id: 'audit-remove-blindness-new', command_id: 'audit-remove-blindness-new', event_type: 'ConditionRemoved', actor_id: 'system', target_ids: ['target'],
    payload: { condition: 'blinded', effect_id: 'blindness-new' }, visibility: 'public',
  }
  const events = [first, otherSource, refresh, removeOld, removeNew]
  const afterFirst = applyGameEvent(state, first)
  assert.deepEqual(afterFirst.mechanics.conditions.target.map((entry) => [entry.id, entry.effect_id, entry.duration]), [
    ['blinded', 'blindness-old', 'rounds:1'],
    ['blinded', 'blindness-new', 'rounds:10'],
  ])
  const afterRefresh = applyGameEvent(applyGameEvent(afterFirst, otherSource), refresh)
  assert.deepEqual(afterRefresh.mechanics.conditions.target.map((entry) => [entry.effect_id, entry.duration]), [
    ['blindness-old', 'rounds:1'],
    ['blindness-new', 'rounds:20'],
    ['blindness-other', 'rounds:2'],
  ])
  const afterOld = applyGameEvent(afterRefresh, removeOld)
  assert.deepEqual(afterOld.mechanics.conditions.target.map((entry) => entry.effect_id), ['blindness-new', 'blindness-other'])
  const afterNew = applyGameEvent(afterOld, removeNew)
  assert.deepEqual(afterNew.mechanics.conditions.target.map((entry) => entry.effect_id), ['blindness-other'])
  assert.deepEqual(replayEvents(state, events), afterNew)
})

test('repeat-save заканчивает только тот boolean source, который прошёл свой спасбросок', () => {
  const state = normalizeCampaignState({
    sessionCode: 'SPELL-INTERACTIONS-AUDIT-REPEAT',
    partyMemberIds: ['target', 'caster-one', 'caster-two'],
    players: [
      { id: 'target', character: 'Цель', characterClass: 'fighter', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { con: 12, wis: 10 }, x: 1, y: 1 },
      { id: 'caster-one', character: 'Первый', characterClass: 'wizard', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { int: 16 }, x: 2, y: 1 },
      { id: 'caster-two', character: 'Второй', characterClass: 'wizard', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { int: 16 }, x: 3, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }, { x: 2, y: 1, type: 'floor', revealed: true }, { x: 3, y: 1, type: 'floor', revealed: true }] },
    mechanics: {
      conditions: {
        target: [
          { id: 'blinded', effect_id: 'blindness-one', source_actor: 'caster-one', duration: 'concentration', repeat_save_timing: 'turn-end', save_ability: 'con', save_dc: 1, spell_id: 'blindness-deafness' },
          { id: 'blinded', effect_id: 'blindness-two', source_actor: 'caster-two', duration: 'concentration', repeat_save_timing: 'turn-end', save_ability: 'con', save_dc: 30, spell_id: 'blindness-deafness' },
        ],
      },
      concentration: {
        'caster-one': { effect_id: 'blindness-one' },
        'caster-two': { effect_id: 'blindness-two' },
      },
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'target', total: 10 }, { actor_id: 'caster-one', total: 9 }, { actor_id: 'caster-two', total: 8 }],
        active_index: 0,
        action_economy: { target: { action: true, bonus_action: true, reaction: true, movement: true } },
      },
    },
  })
  let rollId = 0
  const resolved = resolveCommand({ command_type: 'EndTurn', actor_id: 'target' }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([20, 1]), idFactory: () => `repeat-audit-${++rollId}`, now: () => '2026-09-19T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['target'] },
  })
  const after = resolved.events.reduce((next, event) => applyGameEvent(next, event), state)
  assert.ok(resolved.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.effect_id === 'blindness-one'))
  assert.equal(resolved.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.effect_id === 'blindness-two'), false)
  assert.deepEqual(after.mechanics.conditions.target.map((condition) => condition.effect_id), ['blindness-two'])
  assert.deepEqual(replayEvents(state, resolved.events), after)
})
