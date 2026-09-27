import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { combatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, worldTimeSeconds } from '../server/rules-engine.mjs'

let sequence = 0

function dice(values = []) {
  let roll = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `pfe-roll-${++roll}`,
    now: () => '2026-09-26T12:00:00.000Z',
  })
}

function field({ slot3 = 2, allyX = 2, temporaryHp = 0 } = {}) {
  const cells = Array.from({ length: 100 }, (_, index) => ({
    x: index % 20,
    y: Math.floor(index / 20),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'PROTECTION-FROM-ENERGY',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    partyMemberIds: ['caster', 'caster-b', 'ally'],
    players: [
      {
        id: 'caster', character: 'Мира', characterClass: 'wizard', level: 5,
        hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
        knownSpellIds: ['protection-from-energy'], preparedSpellIds: ['protection-from-energy'],
        inventory: [], x: 1, y: 1,
      },
      {
        id: 'caster-b', character: 'Лада', characterClass: 'wizard', level: 5,
        hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
        knownSpellIds: ['protection-from-energy'], preparedSpellIds: ['protection-from-energy'],
        inventory: [], x: 1, y: 2,
      },
      {
        id: 'ally', character: 'Бор', characterClass: 'fighter', level: 5,
        hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 3,
        abilities: { str: 16, dex: 12, con: 14 },
        inventory: [], x: allyX, y: 1,
      },
    ],
    enemies: [{
      id: 'enemy', name: 'Противник', hp: 40, maxHp: 40, armor: 12, speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      x: 10, y: 1, alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: {
        caster: { spell_slots_3: { current: slot3, max: slot3 } },
        'caster-b': { spell_slots_3: { current: 2, max: 2 } },
      },
      temporary_hp: temporaryHp ? { ally: temporaryHp } : {},
      combat: { active: false },
    },
  })
}

function run(state, command, context = {}) {
  const result = resolveCommand({
    command_id: `pfe-command-${++sequence}`,
    server_authoritative: true,
    ...command,
  }, state, {
    diceService: dice(),
    context: {
      serverAuthoritativeCombat: true,
      allowedActorIds: ['caster', 'caster-b', 'ally', 'enemy'],
      ...context,
    },
  })
  const replayed = replayEvents(state, result.events)
  const reduced = result.events.reduce((next, event) => applyGameEvent(next, event), state)
  assert.deepEqual(replayed, reduced, 'replay должен совпадать с прямым reducer-путём')
  return { ...result, state: replayed }
}

function cast(state, { casterId = 'caster', targetId = 'ally', option = 'fire', context, commandId = null, ...extra } = {}) {
  const targetContext = context ?? {}
  return run(state, {
    command_type: 'CastSpell',
    ...(commandId ? { command_id: commandId } : {}),
    actor_id: casterId,
    spell_id: 'protection-from-energy',
    target_id: targetId,
    spell_option: option,
    ...extra,
  }, targetContext)
}

function advance(state, amount, unit = 'second') {
  return run(state, { command_type: 'AdvanceTime', actor_id: 'caster', amount, unit }, { isAdmin: true })
}

function pfeConditions(state, target = 'ally') {
  return (state.mechanics.conditions[target] ?? []).filter((condition) => String(condition.id ?? '').startsWith('protected-from-energy:'))
}

function damage(state, amount = 11, damageType = 'fire') {
  return run(state, { command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'ally', amount, damage_type: damageType }, { isAdmin: true })
}

test('обычное наложение сохраняет V/S, 3-й круг, эффект и срок в секундах', () => {
  const initial = field()
  const spell = combatSpellFor(initial.players[0], 'protection-from-energy', { rulesetId: initial.ruleset_id })
  assert.deepEqual(spell.components, { verbal: true, somatic: true, material: null })
  assert.deepEqual(spell.spellOptions, ['acid', 'cold', 'fire', 'lightning', 'thunder'])
  assert.equal(spell.level, 3)
  assert.equal(spell.concentration, true)
  assert.equal(spell.conditionDurationSeconds, 3600)

  const result = cast(initial, { targetId: 'ally', option: 'fire', commandId: 'normal-cast' })
  const condition = pfeConditions(result.state, 'ally')[0]
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.state.mechanics.resources.caster.spell_slots_3.current, 1)
  assert.equal(condition.id, 'protected-from-energy:fire')
  assert.equal(condition.expires_at_seconds - condition.started_at_seconds, 3600)
  assert.equal(condition.effect_id, 'protection-from-energy:normal-cast')
  assert.equal(result.state.mechanics.concentration.caster.effect_id, condition.effect_id)
  assert.equal(condition.expiry_policy, 'protection-from-energy/v1')
})

for (const option of ['acid', 'cold', 'fire', 'lightning', 'thunder']) {
  test(`выбор ${option} создаёт сопротивление только выбранному типу`, () => {
    const result = cast(field(), { targetId: 'caster', option })
    assert.deepEqual(pfeConditions(result.state, 'caster').map((condition) => condition.id), [`protected-from-energy:${option}`])
  })
}

test('сопротивление действует с временными хитами и не складывается в четверть урона', () => {
  const first = cast(field({ temporaryHp: 3 }), { option: 'fire', commandId: 'first-source' })
  const second = cast(first.state, { casterId: 'caster-b', option: 'fire', commandId: 'second-source' })
  const effects = pfeConditions(second.state)
  assert.equal(effects.length, 2)
  assert.deepEqual(new Set(effects.map((condition) => condition.effect_id)), new Set([
    'protection-from-energy:first-source', 'protection-from-energy:second-source',
  ]))

  const hit = damage(second.state)
  const payload = hit.events.find((event) => event.event_type === 'DamageApplied').payload
  assert.equal(payload.resistant, true)
  assert.equal(payload.applied_amount, 2, '11 → 5 после resistance, затем 3 временных хита')
  assert.equal(payload.temporary_hp_absorbed, 3)

  const withoutTemp = structuredClone(second.state)
  withoutTemp.mechanics.temporary_hp.ally = 0
  const noTemp = damage(withoutTemp, 11, 'fire')
  assert.equal(noTemp.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 5, 'два resistance одного типа дают половину, не четверть')
  const cold = damage(withoutTemp, 11, 'cold')
  assert.equal(cold.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 11)

  const ended = run(second.state, {
    command_type: 'EndConcentration', actor_id: 'caster', effect_id: 'protection-from-energy:first-source', reason: 'voluntary',
  }, { isAdmin: true })
  assert.deepEqual(pfeConditions(ended.state).map((condition) => condition.effect_id), ['protection-from-energy:second-source'])
  assert.equal(ended.state.mechanics.concentration.caster, undefined)
  assert.equal(ended.state.mechanics.concentration['caster-b'].effect_id, 'protection-from-energy:second-source')
  const endedWithoutTemp = structuredClone(ended.state)
  endedWithoutTemp.mechanics.temporary_hp.ally = 0
  assert.equal(damage(endedWithoutTemp).events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 5)
})

test('часовой срок очищает состояние и концентрацию ровно на 3600-й секунде', () => {
  const castResult = cast(field(), { targetId: 'caster', option: 'lightning', commandId: 'expiry-source' })
  const beforeExpiry = advance(castResult.state, 3_599)
  assert.equal(worldTimeSeconds(beforeExpiry.state), 3_599)
  assert.equal(pfeConditions(beforeExpiry.state, 'caster').length, 1)
  assert.equal(beforeExpiry.state.mechanics.concentration.caster.effect_id, 'protection-from-energy:expiry-source')
  assert.equal(beforeExpiry.events.some((event) => event.event_type === 'ConcentrationEnded'), false)

  const expired = advance(beforeExpiry.state, 1)
  assert.equal(worldTimeSeconds(expired.state), 3_600)
  assert.equal(pfeConditions(expired.state, 'caster').length, 0)
  assert.equal(expired.state.mechanics.concentration.caster, undefined)
  const ends = expired.events.filter((event) => event.event_type === 'ConcentrationEnded')
  assert.equal(ends.length, 1)
  assert.deepEqual(ends[0].payload, {
    reason: 'duration-expired',
    effect_id: 'protection-from-energy:expiry-source',
    spell_id: 'protection-from-energy',
    expiry_policy: 'protection-from-energy/v1',
    summon_lifecycle_version: 2,
  })
  assert.deepEqual(replayEvents(beforeExpiry.state, expired.events), expired.state)
  assert.equal(expired.events.filter((event) => event.event_type === 'ConcentrationEnded').length, 1)
  assert.deepEqual(normalizeCampaignState(JSON.parse(JSON.stringify(expired.state))), expired.state)
})

test('старый секундный condition без PFE expiry policy не очищает концентрацию', () => {
  const legacy = field({})
  legacy.mechanics.conditions.caster = [{
    id: 'legacy-timed-condition', duration: 'seconds:1', effect_id: 'legacy-effect',
    timing_version: 2, started_at_seconds: 0, expires_at_seconds: 1,
  }]
  legacy.mechanics.concentration.caster = { effect_id: 'legacy-effect' }
  const after = advance(legacy, 1)
  assert.equal(after.state.mechanics.conditions.caster.length, 0)
  assert.equal(after.state.mechanics.concentration.caster.effect_id, 'legacy-effect')
  assert.equal(after.events.some((event) => event.event_type === 'ConcentrationEnded'), false)
})

test('неизвестный тип и чужой actor отклоняются атомарно', () => {
  const initial = field()
  const before = structuredClone(initial)
  assert.throws(() => cast(initial, { targetId: 'caster', option: 'force', commandId: 'unsupported' }), { code: 'SPELL_OPTION_REQUIRED' })
  assert.deepEqual(initial, before)

  assert.throws(() => resolveCommand({
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'protection-from-energy', target_id: 'caster', spell_option: 'fire', server_authoritative: true,
  }, initial, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['ally'] },
  }), { code: 'ACTOR_FORBIDDEN' })
})

test('record/replay и повтор того же idempotency key возвращают один commit', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-pfe-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 0 })
  const initial = field()
  await store.initializeCampaign({ campaignId: 'pfe-record', initialState: initial, rulesetId: 'dnd_5e_2014', rulesetVersion: '2014.1.0' })
  const resolved = cast(initial, { targetId: 'caster', option: 'acid', commandId: 'record-cast' })
  const request = {
    campaignId: 'pfe-record', expectedStateVersion: 0, idempotencyKey: 'pfe-cast-once', commandId: 'record-cast', events: resolved.events,
  }
  const committed = await store.commit(request)
  const replayed = await store.replay('pfe-record', { useSnapshots: false })
  assert.deepEqual(replayed.state, committed.state)
  const duplicate = await store.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, committed.state)
  assert.equal((await store.getEvents('pfe-record')).length, resolved.events.length)
})
