import assert from 'node:assert/strict'

import { spellRuntimeFixture } from '../../../../eval/spell-runtime-audit.mjs'
import { combatSpellFor } from '../../../../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../../../../server/rules-engine.mjs'

const combatContext = { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] }

function deterministicDice(values = null) {
  return new DiceService({
    rng: values ? new SequenceDiceRng(values) : { randint: (_minimum, maximum) => maximum },
    idFactory: (() => {
      let ordinal = 0
      return () => `support-contract-probe-${++ordinal}`
    })(),
    now: () => '2026-10-04T00:00:00.000Z',
  })
}

function srdFixture(spellId) {
  const fixture = spellRuntimeFixture(spellId)
  const state = normalizeCampaignState({
    ...structuredClone(fixture.state),
    ruleset_id: 'srd_5_2_1',
    ruleset_version: undefined,
    enabled_house_rules: [],
  })
  return {
    fixture,
    state,
    runtime: combatSpellFor(state.players[0], spellId, { rulesetId: state.ruleset_id }),
    command: { ...fixture.command, command_id: `support-contract:${spellId}:srd`, server_authoritative: true },
  }
}

function runInfestationSrd() {
  const { state, runtime, command } = srdFixture('infestation')
  assert.equal(runtime?.mechanicsSupport, 'partial')
  assert.match(String(runtime?.supportNote), /формализованную часть/u)
  const result = resolveCommand(command, state, { diceService: deterministicDice([1, 1, 1, 1, 4, 4, 4]), context: combatContext })
  const after = result.events.reduce(applyGameEvent, state)
  const condition = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload?.condition === 'forced-random-move-5')
  const randomRoll = result.events.find((event) => event.event_type === 'DieRolled' && event.payload?.purpose === 'spell_random_move:infestation')
  const movement = result.events.find((event) => event.event_type === 'ActorMoved' && event.payload?.forced_movement === true)
  assert.ok(condition, 'partial infestation should expose the current marker')
  assert.equal(randomRoll, undefined, 'the SRD profile has no random movement handler')
  assert.equal(movement, undefined, 'the SRD profile must not silently invent movement')
  assert.deepEqual(after.mechanics.positions.enemy, state.mechanics.positions.enemy)
  return {
    spell: 'infestation',
    ruleset: state.ruleset_id,
    support: runtime.mechanicsSupport,
    events: result.events.map((event) => event.event_type),
    marker: condition.payload.condition,
    randomMovement: false,
    positionChanged: false,
  }
}

function runGreenFlameBladeTargeting() {
  const fixture = spellRuntimeFixture('green-flame-blade')
  const state = structuredClone(fixture.state)
  state.mechanics.positions.enemy = { x: 4, y: 2 }
  state.enemies[0].x = 4
  state.enemies.push({ ...structuredClone(state.enemies[0]), id: 'enemy-2', name: 'Вторая цель', x: 3, y: 2 })
  state.mechanics.positions['enemy-2'] = { x: 3, y: 2 }
  const runtime = combatSpellFor(state.players[0], 'green-flame-blade', { rulesetId: state.ruleset_id })
  assert.equal(runtime?.mechanicsSupport, 'partial')
  assert.match(String(runtime?.supportNote), /формализованную часть/u)
  const result = resolveCommand({
    ...fixture.command,
    command_id: 'support-contract:green-flame-blade',
    target_id: 'enemy-2',
    target_ids: ['enemy-2'],
    server_authoritative: true,
  }, state, { diceService: deterministicDice(), context: combatContext })
  const secondary = result.events.find((event) => event.event_type === 'DamageApplied' && event.payload?.secondary === true)
  assert.ok(secondary, 'green-flame-blade should emit its current secondary rider')
  assert.deepEqual(secondary.target_ids, ['enemy'], 'the rider currently chooses the first sorted nearby enemy')
  return {
    spell: 'green-flame-blade',
    ruleset: state.ruleset_id,
    support: runtime.mechanicsSupport,
    requestedPrimary: 'enemy-2',
    secondaryTarget: secondary.target_ids[0],
    targetSelection: 'server-first-sorted-nearby-enemy',
  }
}

function runWitchBoltResourceBoundary() {
  const fixture = spellRuntimeFixture('witch-bolt')
  const runtime = combatSpellFor(fixture.state.players[0], 'witch-bolt', { rulesetId: fixture.state.ruleset_id })
  assert.equal(runtime?.mechanicsSupport, 'partial')
  assert.match(String(runtime?.supportNote), /повторяет 1к12/u)
  const result = resolveCommand(fixture.command, fixture.state, { diceService: deterministicDice(), context: combatContext })
  const after = result.events.reduce(applyGameEvent, fixture.state)
  const spent = result.events.filter((event) => event.event_type === 'ResourceSpent' && event.payload?.resource === 'spell_slots_1')
  const continuation = (after.players.find((actor) => actor.id === 'caster')?.combatActions ?? [])
    .some((action) => String(action.id).includes('witch-bolt'))
  assert.equal(spent.length, 1)
  assert.equal(continuation, false)
  return {
    spell: 'witch-bolt',
    ruleset: fixture.state.ruleset_id,
    support: runtime.mechanicsSupport,
    resourcesSpent: spent.map((event) => event.payload.resource),
    continuationActionPublished: continuation,
    limitationIsExplicitInSupportNote: true,
  }
}

function runBlockedSpellControl(spellId, expectedCode) {
  const fixture = spellRuntimeFixture(spellId)
  const runtime = combatSpellFor(fixture.state.players[0], spellId, { rulesetId: fixture.state.ruleset_id })
  assert.equal(runtime?.mechanicsSupport, spellId === 'feather-fall' ? 'ruling-only' : 'heuristic')
  let code = null
  assert.throws(() => resolveCommand(fixture.command, fixture.state, {
    diceService: deterministicDice(),
    context: combatContext,
  }), (error) => {
    code = error?.code ?? null
    return code === expectedCode
  })
  return { spell: spellId, support: runtime.mechanicsSupport, blocked: true, code }
}

const report = {
  schemaVersion: 'support-contract-probe/v1',
  sourceCommit: '88c620e6011ae607913efb224cb8f850b4ee5028',
  checks: [
    runInfestationSrd(),
    runGreenFlameBladeTargeting(),
    runWitchBoltResourceBoundary(),
    runBlockedSpellControl('mage-hand', 'MECHANICS_NOT_VERIFIED'),
    runBlockedSpellControl('feather-fall', 'RULING_REQUIRED'),
  ],
}

console.log(JSON.stringify(report, null, 2))
