import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const authoredNpcProfile = (creatureType) => ({
  profile_id: 'test-villager', status: 'verified', level: 1, challenge_rating: '1', xp: 200,
  encounter_difficulty: 'easy', hp: 11, armor: 12, speed: 30, initiative_bonus: 0,
  proficiency_bonus: 2, size: 'medium', creature_type: creatureType,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, skills: {}, saving_throws: {},
  damage_vulnerabilities: [], damage_resistances: [], damage_immunities: [], condition_immunities: [],
  traits: [],
  action_profiles: [{ id: 'club', name: 'Дубинка', kind: 'melee', attack_modifier: 2, damage_expression: '1d6', damage_type: 'bludgeoning', range_feet: 5 }],
  features: [{ id: 'feature', name: 'Особенность', status: 'verified', description: 'Тестовый профиль.' }],
  tactics: ['держится рядом'],
})

function field({ npcHp = 3, npcAlive = true, npcBlocked = false, npcProfile = false, npcSize = null, npcX = 3, npcY = 1 } = {}) {
  const cells = Array.from({ length: 12 * 6 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  const profile = npcProfile ? authoredNpcProfile(npcProfile) : null
  return normalizeCampaignState({
    sessionCode: 'MCW-NPC', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['caster', 'ally'],
    players: [
      { id: 'caster', character: 'Иара', characterClass: 'cleric', level: 9, hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 4, abilities: { wis: 18, str: 10, dex: 10, con: 14, int: 10, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'ally', character: 'Бор', characterClass: 'fighter', level: 9, hp: 10, maxHp: 40, armor: 14, speed: 30, proficiency: 4, abilities: { str: 16, dex: 12, con: 14 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [], actors: [],
    scene: { location: 'Рынок', location_id: 'market', turn: 1, cells },
    social: { npcs: [{ id: 'villager', name: 'Страж Бран', role: 'guard', location: 'Рынок', location_id: 'market', visibility: 'party', available: true }] },
    npc_world: {
      placements: [{ npc_id: 'villager', location_id: 'market', x: npcX, y: npcY, placement_reason: 'test', ...(npcSize ? { footprint: { version: 1, size: npcSize } } : {}) }],
      vitals: { villager: { hp: npcHp, max_hp: profile?.hp ?? 11, alive: npcAlive } }, profiles: profile ? { villager: profile } : {}, stances: {}, inventories: {},
    },
    mechanics: {
      resources: { caster: { spell_slots_5: { current: 1, max: 1 } } },
      conditions: npcBlocked ? { villager: [{ id: 'healing-blocked' }] } : {},
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'caster', total: 20 }], action_economy: { caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
    },
  })
}

function dice() { return new DiceService({ rng: new SequenceDiceRng([2, 5, 7]), idFactory: (() => { let id = 0; return () => `mcw-npc-${++id}` })() }) }

function cast(state, targetIds = ['villager'], { pointX = 3, pointY = 1 } = {}) {
  const result = resolveCommand({ command_type: 'CastSpell', command_id: 'mcw-npc-cast', actor_id: 'caster', spell_id: 'mass-cure-wounds', to: { x: pointX, y: pointY }, target_ids: targetIds, slot_level: 5, casting_resource: 'spell_slots_5', server_authoritative: true }, state, { diceService: dice(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  return { ...result, state: replayEvents(state, result.events) }
}

test('Mass Cure лечит мирного scene NPC общим HealingApplied и сохраняет vitality при replay', () => {
  const initial = field()
  const result = cast(initial)
  const healing = result.events.find((event) => event.event_type === 'HealingApplied' && event.target_ids.includes('villager'))
  assert.ok(healing)
  assert.equal(healing.payload.npc_id, 'villager')
  assert.equal(result.events.filter((event) => event.event_type === 'DieRolled').length, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.state.npc_world.vitals.villager.hp, 11)
  assert.equal(result.state.actors.some((actor) => actor.id === 'villager'), false)
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})

test('Mass Cure не воскрешает truly-dead NPC и не списывает ячейку', () => {
  const initial = field({ npcHp: 0, npcAlive: false })
  assert.throws(() => cast(initial), { code: 'INVALID_SPELL_TARGET' })
  assert.equal(initial.mechanics.resources.caster.spell_slots_5.current, 1)
})

test('Mass Cure сохраняет общий roll и лимит целей для NPC вместе с героем', () => {
  const initial = field()
  const result = cast(initial, ['villager', 'ally'])
  const healing = result.events.filter((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.length, 2)
  assert.equal(new Set(healing.map((event) => event.payload.amount)).size, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'DieRolled').length, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
})

test('Mass Cure выбирает large NPC по любой клетке footprint на краю сферы', () => {
  const initial = field({ npcSize: 2, npcX: 1, npcY: 2 })
  const result = cast(initial, ['villager'], { pointX: 8, pointY: 2 })
  const healing = result.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healing?.target_ids?.[0], 'villager')
  assert.equal(result.state.npc_world.vitals.villager.hp, 11)
})

test('Mass Cure сохраняет healing-blocked для NPC в общем healing loop', () => {
  const initial = field({ npcBlocked: true })
  const result = cast(initial)
  const healing = result.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.payload.applied_amount, 0)
  assert.equal(result.state.npc_world.vitals.villager.hp, 3)
})

test('Mass Cure применяет immuneCreatureTypes к authored NPC без HealingApplied', () => {
  const initial = field({ npcProfile: 'undead' })
  const result = cast(initial)
  assert.equal(result.events.some((event) => event.event_type === 'HealingApplied'), false)
  assert.equal(result.state.npc_world.vitals.villager.hp, 3)
})

test('старый HealingApplied без npc_id не меняет vitality социального NPC при replay', () => {
  const initial = field()
  const replayed = replayEvents(initial, [{
    event_type: 'HealingApplied', event_id: 'legacy-healing', actor_id: 'caster', target_ids: ['villager'], visibility: 'public',
    payload: { spell_id: 'cure-wounds', requested_amount: 8, applied_amount: 8, hp_before: 3, hp_after: 11 },
  }])
  assert.equal(replayed.npc_world.vitals.villager.hp, 3)
  assert.equal(replayed.actors.some((actor) => actor.id === 'villager'), false)
})

test('видимый social NPC не раскрывает HP в механике и battleLog после replay', () => {
  const initial = field()
  const result = cast(initial)
  const healing = result.events.find((event) => event.event_type === 'HealingApplied' && event.payload.npc_id === 'villager')
  assert.ok(healing)
  const [visibleMechanic] = mechanicsForViewer([healing], { role: 'player', heroIds: ['caster'] }, 'caster', result.state)
  assert.equal(visibleMechanic.payload.npc_id, 'villager')
  assert.equal(visibleMechanic.payload.hp_before, undefined)
  assert.equal(visibleMechanic.payload.hp_after, undefined)
  assert.equal(visibleMechanic.payload.maximum_hp_after, undefined)
  assert.equal(visibleMechanic.payload.requested_amount, undefined)
  assert.equal(visibleMechanic.payload.amount, undefined)
  assert.equal(visibleMechanic.payload.applied_amount, healing.payload.applied_amount)

  const reconnected = replayEvents(initial, result.events)
  const projected = campaignStateForViewer(reconnected, { role: 'player' }, 'caster')
  const battle = projected.battleLog.find((entry) => entry.targetId === 'villager' && entry.type === 'healing')
  assert.ok(battle)
  assert.equal(battle.hpBefore, undefined)
  assert.equal(battle.hpAfter, undefined)
  assert.equal(battle.maximumHpAfter, undefined)
  assert.equal(battle.healing, healing.payload.applied_amount)
})

test('HealingApplied скрытого NPC не раскрывает npc_id в публичной проекции', () => {
  const state = normalizeCampaignState({
    partyMemberIds: ['hero'], players: [{ id: 'hero', hp: 10, maxHp: 10, inventory: [] }], actors: [], enemies: [],
    scene: { location: 'Скрытая комната', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    social: { npcs: [{ id: 'hidden-npc', name: 'Тайный NPC', role: 'guard', location: 'Скрытая комната', visibility: 'gm_only', available: true }] },
    npc_world: { placements: [{ npc_id: 'hidden-npc', location_id: 'Скрытая комната', x: 0, y: 0 }], vitals: { 'hidden-npc': { hp: 2, max_hp: 4, alive: true } } },
  })
  const [visible] = mechanicsForViewer([{
    event_type: 'HealingApplied', actor_id: 'hero', target_ids: ['hidden-npc'], visibility: 'public',
    payload: { spell_id: 'mass-cure-wounds', npc_id: 'hidden-npc', requested_amount: 10, applied_amount: 2, hp_before: 2, hp_after: 4 },
  }], { role: 'player', heroIds: ['hero'] }, 'hero', state)
  assert.equal(visible, undefined)
  assert.doesNotMatch(JSON.stringify(mechanicsForViewer([{
    event_type: 'SpellCast', actor_id: 'hero', target_ids: ['hidden-npc'], visibility: 'public',
    payload: { spell_id: 'mass-cure-wounds', to: { x: 0, y: 0 } },
  }], { role: 'player', heroIds: ['hero'] }, 'hero', state)), /hidden-npc/u)
})

test('старое лечение видимого NPC без npc_id скрывает точные хиты в событиях и журнале', () => {
  const initial = field()
  const event = {
    event_type: 'HealingApplied', event_id: 'legacy-npc-healing', actor_id: 'caster', target_ids: ['villager'], visibility: 'public',
    payload: { spell_id: 'cure-wounds', requested_amount: 10, applied_amount: 8, hp_before: 3, hp_after: 11 },
  }
  const replayed = replayEvents(initial, [event])
  const [visible] = mechanicsForViewer([event], { role: 'player', heroIds: ['caster'] }, 'caster', replayed)
  assert.equal(visible.payload.hp_before, undefined)
  assert.equal(visible.payload.hp_after, undefined)
  assert.equal(visible.payload.requested_amount, undefined)
  assert.equal(visible.payload.applied_amount, 8)
  const projected = campaignStateForViewer(replayed, { role: 'player', heroIds: ['caster'] }, 'caster')
  const battle = projected.battleLog.find((entry) => entry.type === 'healing')
  assert.equal(battle.hpBefore, undefined)
  assert.equal(battle.hpAfter, undefined)
  assert.equal(replayed.npc_world.vitals.villager.hp, 3, 'приватность проекции не меняет исторический replay')
})
