import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, skillProficiencyForActor, spellComponentAvailabilityFor } from '../server/rules-engine.mjs'
import { combatSpellFor } from '../server/combat-spells.mjs'

const cells = Array.from({ length: 8 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
const book = { id: 'book', catalog_id: 'phb_2014:equipment:book', name: 'Книга', type: 'book', quantity: 1, price_cp: 2_500, base_price_cp: 2_500 }

function fixture({ inventory = [book], classSkills = ['arcana'], expertise = [], worldMinutes = 0, worldSeconds = 0, resources = { spell_slots_2: { current: 2, max: 2 }, spell_slots_5: { current: 2, max: 2 } } } = {}) {
  return normalizeCampaignState({
    sessionCode: 'SKILL-BUFFS', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [
      { id: 'caster', character: 'Заклинатель', characterClass: 'wizard', level: 9, proficiency: 4, hp: 40, maxHp: 40, armor: 14, x: 1, y: 0,
        abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory,
        classSkillProficiencies: classSkills, skillExpertiseIds: expertise,
        knownSpellIds: ['borrowed-knowledge', 'skill-empowerment'], preparedSpellIds: ['borrowed-knowledge', 'skill-empowerment'] },
      { id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 9, proficiency: 4, hp: 40, maxHp: 40, armor: 14, x: 2, y: 0,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], classSkillProficiencies: ['athletics'], skillExpertiseIds: [] },
    ],
    scene: { cells },
    mechanics: {
      world_time: { amount: worldMinutes, unit: 'minute', elapsed_minutes: worldMinutes, second_remainder: worldSeconds },
      resources: { caster: resources },
      conditions: {}, concentration: {},
      combat: { active: false, round: 1, active_index: 0, initiative: [], action_economy: {} },
    },
  })
}

function dice(values = [10]) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `skill-buff-roll:${++id}` })
}

function cast(state, spellId, extra = {}, commandId = `${spellId}:cast`) {
  return resolveCommand({ command_type: 'CastSpell', command_id: commandId, actor_id: 'caster', spell_id: spellId, server_authoritative: true, ...extra }, state, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
}

const replay = (state, events) => events.reduce(applyGameEvent, state)
const check = (state, actorId, skill) => resolveCommand({ command_type: 'MakeAbilityCheck', command_id: `check:${actorId}:${skill}`, actor_id: actorId, skill, difficulty: 10 }, state, { diceService: dice([10]) })

test('каталожные метаданные дают UI выбор навыка и точные компоненты', () => {
  const state = fixture()
  const borrowed = combatSpellFor(state.players[0], 'borrowed-knowledge', { rulesetId: state.ruleset_id })
  const empowerment = combatSpellFor(state.players[0], 'skill-empowerment', { rulesetId: state.ruleset_id })
  assert.equal(borrowed.mechanicsSupport, 'partial')
  assert.deepEqual(borrowed.components.material, { description: 'книга стоимостью не менее 25 зм', costGp: 25, consumed: false, focusSubstitutable: false })
  assert.equal(borrowed.spellOptions.length, 18)
  assert.deepEqual(empowerment.spellOptions, borrowed.spellOptions)
  assert.equal(empowerment.concentration, true)
})

test('Borrowed Knowledge требует неосвоенный навык, даёт владение на час и не расходует книгу', () => {
  const initial = fixture({ worldSeconds: 59 })
  assert.equal(spellComponentAvailabilityFor(initial, initial.players[0], combatSpellFor(initial.players[0], 'borrowed-knowledge', { rulesetId: initial.ruleset_id })).available, true)
  const result = cast(initial, 'borrowed-knowledge', { spell_option: 'athletics' })
  const after = replay(initial, result.events)
  const condition = after.mechanics.conditions.caster.find((entry) => entry.id === 'borrowed-knowledge:athletics')
  assert.equal(condition.skill_buff_version, 1)
  assert.equal(condition.duration, 'minutes:60')
  assert.equal(condition.timing_version, 2)
  assert.equal(condition.started_at_seconds, 59)
  assert.equal(condition.expires_at_seconds, 3_659)
  assert.equal(after.players[0].inventory.find((item) => item.catalog_id === 'phb_2014:equipment:book').quantity, 1)
  assert.equal(result.events.some((event) => event.event_type === 'ItemConsumed'), false)
  assert.equal(skillProficiencyForActor(after.players[0], 'athletics', after).bonus, 4)
  assert.equal(check(after, 'caster', 'athletics').events.find((event) => event.event_type === 'AbilityCheckResolved').payload.proficiency_bonus, 4)
  const at3658 = replay(after, [{ event_type: 'TimeAdvanced', event_id: 'time:borrowed:almost', actor_id: null, target_ids: [], payload: { clock_version: 2, elapsed_seconds: 3_599 } }])
  assert.equal(skillProficiencyForActor(at3658.players[0], 'athletics', at3658).bonus, 4)
  const at3659 = replay(at3658, [{ event_type: 'TimeAdvanced', event_id: 'time:borrowed:expired', actor_id: null, target_ids: [], payload: { clock_version: 2, elapsed_seconds: 1 } }])
  assert.equal(skillProficiencyForActor(at3659.players[0], 'athletics', at3659).bonus, 0)
  const legacyMarker = fixture()
  legacyMarker.mechanics.conditions.caster = [{ id: 'borrowed-knowledge:athletics', spell_id: 'borrowed-knowledge', expires_at_minutes: 60 }]
  assert.equal(skillProficiencyForActor(legacyMarker.players[0], 'athletics', legacyMarker).bonus, 0)
  assert.throws(() => cast(initial, 'borrowed-knowledge', { spell_option: 'arcana' }, 'borrowed-proficient'), error => error.code === 'BORROWED_KNOWLEDGE_SKILL_ALREADY_PROFICIENT')
  assert.throws(() => cast(fixture({ inventory: [] }), 'borrowed-knowledge', { spell_option: 'athletics' }, 'borrowed-no-book'), error => error.code === 'SPELL_MATERIAL_COMPONENT_REQUIRED')
  assert.throws(() => cast(fixture({ inventory: [{ id: 'fake-book', name: 'Книга', type: 'book', quantity: 1, price_cp: 2_500 }] }), 'borrowed-knowledge', { spell_option: 'athletics' }, 'borrowed-forged-book'), error => error.code === 'SPELL_MATERIAL_COMPONENT_REQUIRED')
})

test('Borrowed Knowledge expires, replaces its old choice, and replays identically', () => {
  const first = fixture()
  const firstCast = cast(first, 'borrowed-knowledge', { spell_option: 'athletics' }, 'borrowed-one')
  const withFirst = replay(first, firstCast.events)
  const secondCast = cast(withFirst, 'borrowed-knowledge', { spell_option: 'history' }, 'borrowed-two')
  const replaced = replay(withFirst, secondCast.events)
  assert.equal(replaced.mechanics.conditions.caster.some((entry) => entry.id === 'borrowed-knowledge:athletics'), false)
  assert.equal(skillProficiencyForActor(replaced.players[0], 'history', replaced).bonus, 4)
  const expired = replay(replaced, [{ event_type: 'TimeAdvanced', event_id: 'time:borrowed', actor_id: null, target_ids: [], payload: { elapsed_minutes: 60 } }])
  assert.equal(skillProficiencyForActor(expired.players[0], 'history', expired).bonus, 0)
  assert.deepEqual(replay(withFirst, secondCast.events), replay(withFirst, JSON.parse(JSON.stringify(secondCast.events))))
})

test('Skill Empowerment требует владения без expertise, удваивает один раз и держится концентрацией', () => {
  const initial = fixture()
  const result = cast(initial, 'skill-empowerment', { target_id: 'ally', target_ids: ['ally'], spell_option: 'athletics' })
  const after = replay(initial, result.events)
  const condition = after.mechanics.conditions.ally.find((entry) => entry.id === 'skill-empowerment:athletics')
  assert.equal(condition.duration, 'concentration')
  assert.equal(condition.timing_version, 2)
  assert.equal(condition.started_at_seconds, 0)
  assert.equal(condition.expires_at_seconds, 3_600)
  assert.equal(after.mechanics.concentration.caster.effect_id, 'skill-empowerment:skill-empowerment:cast')
  assert.equal(skillProficiencyForActor(after.players[1], 'athletics', after).bonus, 8)
  assert.equal(check(after, 'ally', 'athletics').events.find((event) => event.event_type === 'AbilityCheckResolved').payload.proficiency_bonus, 8)
  assert.throws(() => cast(fixture({ expertise: ['athletics'] }), 'skill-empowerment', { target_id: 'caster', target_ids: ['caster'], spell_option: 'athletics' }, 'empower-expertise'), error => error.code === 'SKILL_EMPOWERMENT_EXPERTISE_BLOCKED')
  assert.throws(() => cast(initial, 'skill-empowerment', { target_id: 'ally', target_ids: ['ally'], spell_option: 'arcana' }, 'empower-untrained'), error => error.code === 'SKILL_EMPOWERMENT_REQUIRES_PROFICIENCY')
  assert.throws(() => cast(after, 'skill-empowerment', { target_id: 'ally', target_ids: ['ally'], spell_option: 'athletics' }, 'empower-double'), error => error.code === 'SKILL_EMPOWERMENT_ALREADY_DOUBLED')
  const advanced = resolveCommand({
    command_type: 'AdvanceTime', command_id: 'time:empowerment', actor_id: 'caster', amount: 60, unit: 'minute', server_authoritative: true,
  }, after, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const expired = replay(after, advanced.events)
  assert.equal(skillProficiencyForActor(expired.players[1], 'athletics', expired).bonus, 4)
  assert.equal(expired.mechanics.concentration.caster, undefined)
  const ends = advanced.events.filter((event) => event.event_type === 'ConcentrationEnded')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].payload.reason, 'duration-expired')
  assert.equal(ends[0].payload.effect_id, 'skill-empowerment:skill-empowerment:cast')
  assert.equal(ends[0].payload.spell_id, 'skill-empowerment')
  assert.equal(ends[0].payload.skill_buff_version, 1)
  assert.equal(ends[0].payload.summon_lifecycle_version, 2)
  assert.deepEqual(replayEvents(after, advanced.events), expired)
})

test('Skill Empowerment может удвоить временное владение, но не создаёт его после Borrowed Knowledge истёк', () => {
  const initial = fixture()
  const borrowed = replay(initial, cast(initial, 'borrowed-knowledge', { spell_option: 'athletics' }, 'borrowed-for-empower').events)
  const empowered = replay(borrowed, cast(borrowed, 'skill-empowerment', { target_id: 'caster', target_ids: ['caster'], spell_option: 'athletics' }, 'empower-borrowed').events)
  assert.equal(skillProficiencyForActor(empowered.players[0], 'athletics', empowered).bonus, 8)
  const expiredBorrowed = replay(empowered, [{ event_type: 'TimeAdvanced', event_id: 'time:borrowed-before-empowerment', actor_id: null, target_ids: [], payload: { elapsed_minutes: 60 } }])
  assert.equal(skillProficiencyForActor(expiredBorrowed.players[0], 'athletics', expiredBorrowed).bonus, 0)
})

test('ошибка ресурса происходит до событий и не меняет состояние', () => {
  const initial = fixture()
  for (const pool of Object.values(initial.mechanics.resources.caster)) pool.current = 0
  const before = structuredClone(initial)
  assert.throws(() => cast(initial, 'borrowed-knowledge', { spell_option: 'arcana' }, 'resource-borrowed'), error => error.code === 'INSUFFICIENT_RESOURCE')
  assert.deepEqual(initial, before)
})
