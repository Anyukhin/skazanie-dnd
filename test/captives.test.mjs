import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTIVE_FEED_INTERVAL_MINUTES,
  captiveBountyCp,
  captiveInterrogationPolicy,
  captivePersona,
  captiveSettlementFor,
  captivesForViewer,
  heldCaptives,
  planCaptiveNeglectCommands,
} from '../server/captives.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { currencyToCopper } from '../server/merchant-economy.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { worldDeedsFeed } from '../server/world-deeds.mjs'

const VILLAGE = 'Тихий Брод'

function dice(values = []) {
  return new DiceService({ rng: new SequenceDiceRng(values) })
}

function cells(width = 6, height = 6) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

function bandit(id, overrides = {}) {
  return {
    id,
    name: `Бандит ${id.slice(-1)}`,
    hp: 0,
    maxHp: 11,
    armor: 12,
    creature_type: 'humanoid',
    stat_block_id: 'srd_5_2_1:bandit',
    provenance: { xp: 25 },
    x: 4,
    y: 1,
    alive: false,
    ...overrides,
  }
}

function villager(id, name, faction = 'brod-watch') {
  return {
    id,
    name,
    role: 'житель',
    location: VILLAGE,
    visibility: 'party',
    public_summary: `${name} живёт в «${VILLAGE}».`,
    tags: [`faction:${faction}`],
  }
}

/**
 * Сцена сразу после победы: бой ещё активен, один разбойник сдался, второй
 * лежит нокаутнутым и стабилизированным, волк убит — он в плен не идёт.
 */
function campaign({ minutes = 0, npcs = [], sceneKind = 'village', currency } = {}) {
  return normalizeCampaignState({
    sessionCode: 'CAPTIVE',
    campaign: 'Пленные и пощада',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: {
      title: 'Околица',
      location: VILLAGE,
      location_id: 'village',
      grid: { width: 6, height: 6 },
      cells: cells(),
    },
    players: [{
      id: 'hero',
      character: 'Ада',
      hp: 12,
      maxHp: 12,
      x: 1,
      y: 1,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 12, cha: 16 },
      proficiency: 2,
      backgroundSkillProficiencies: ['intimidation'],
      inventory: [],
      ...(currency ? { currency } : {}),
    }],
    worldMap: {
      seed: 'captive-seed',
      locations: [{ id: 'village', name: VILLAGE, kind: sceneKind, x: 100, y: 100 }],
      routes: [],
    },
    enemies: [
      bandit('enemy-surrendered', { x: 4, y: 1 }),
      bandit('enemy-knocked', { x: 4, y: 3 }),
      { id: 'enemy-wolf', name: 'Волк 1', hp: 0, maxHp: 11, creature_type: 'beast', stat_block_id: 'srd_5_2_1:wolf', x: 2, y: 4, alive: false },
    ],
    social: { npcs },
    mechanics: {
      world_time: { elapsed_minutes: minutes },
      combat: {
        active: true,
        round: 3,
        initiative: [{ actor_id: 'hero', total: 18 }],
        active_index: 0,
        action_economy: {},
      },
      conditions: {
        'enemy-surrendered': [{ id: 'surrendered' }],
        'enemy-knocked': [{ id: 'unconscious' }],
        'enemy-wolf': [{ id: 'surrendered' }],
      },
      resting: { 'enemy-knocked': { kind: 'short', reason: 'knockout', recovery_minutes_remaining: 60 } },
    },
  })
}

function endCombat(state, options = {}) {
  return resolveCommands([{
    command_type: 'EndCombat',
    actor_id: 'hero',
    reason: 'enemies_defeated',
    command_id: 'cmd-end-combat',
    campaign_id: 'CAPTIVE',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'], ...options } })
}

test('сдача и нелетальный нокаут превращаются в пленных, зверь — нет', () => {
  const result = endCombat(campaign())
  const captives = heldCaptives(result.state)
  assert.deepEqual(captives.map((captive) => captive.actor_id).sort(), ['enemy-knocked', 'enemy-surrendered'])
  assert.deepEqual(
    captives.map((captive) => captive.origin).sort(),
    ['knocked_out', 'surrendered'],
  )
  // Волк сдался по морали, но связать и допросить его нельзя.
  assert.equal(captives.some((captive) => captive.actor_id === 'enemy-wolf'), false)

  const taken = result.events.filter((event) => event.event_type === 'CaptiveTaken')
  assert.equal(taken.length, 2)
  assert.equal(taken.every((event) => event.visibility === 'party'), true)

  // Пленный перестаёт быть боевым актором, и бухгалтерия нокаута снимается:
  // связанный в сознании, иначе допрашивать было бы некого.
  const knocked = result.state.enemies.find((enemy) => enemy.id === 'enemy-knocked')
  assert.equal(knocked.alive, false)
  assert.equal(knocked.captive, true)
  assert.equal(result.state.mechanics.resting['enemy-knocked'], undefined)
  assert.equal((result.state.mechanics.conditions['enemy-knocked'] ?? []).some((condition) => condition.id === 'unconscious'), false)
})

test('у безымянного врага появляется детерминированный профиль и пост в сцене', () => {
  const first = endCombat(campaign()).state
  const second = endCombat(campaign()).state
  const profile = first.social.npcs.find((npc) => npc.id === 'enemy-surrendered')
  assert.ok(profile, 'у пленного обязан появиться социальный профиль')
  assert.equal(profile.visibility, 'party')
  assert.ok(profile.tags.includes('captive'))
  assert.ok(profile.tags.some((tag) => tag.startsWith('faction:band:')))
  assert.equal(profile.location, VILLAGE)
  assert.equal(
    profile.name,
    second.social.npcs.find((npc) => npc.id === 'enemy-surrendered').name,
    'имя обязано быть детерминированным от сида кампании',
  )
  assert.equal(profile.name, captivePersona(campaign(), { id: 'enemy-surrendered', name: 'Бандит 1' }).name)

  const placement = first.npc_world.placements.find((entry) => entry.npc_id === 'enemy-surrendered')
  assert.ok(placement, 'пленный обязан занять клетку, где его взяли')
  assert.deepEqual({ x: placement.x, y: placement.y }, { x: 4, y: 1 })

  // Профиль, который уже был у NPC, не переписывается сгенерированным.
  const named = endCombat(campaign({
    npcs: [{ ...villager('enemy-surrendered', 'Ждан Прозвище'), location: VILLAGE }],
  })).state
  assert.equal(named.social.npcs.find((npc) => npc.id === 'enemy-surrendered').name, 'Ждан Прозвище')
  assert.equal(
    heldCaptives(named).find((captive) => captive.actor_id === 'enemy-surrendered').name,
    'Ждан Прозвище',
  )
})

function withCaptives(options = {}) {
  const after = endCombat(campaign(options))
  return after.state
}

function captiveOf(state, actorId = 'enemy-surrendered') {
  return heldCaptives(state).find((captive) => captive.actor_id === actorId)
}

function interrogate(state, { roll = 19, skill = 'intimidation', commandId = 'cmd-interrogate' } = {}) {
  return resolveCommands([{
    command_type: 'InterrogateCaptive',
    actor_id: 'hero',
    captive_id: captiveOf(state).id,
    skill,
    command_id: commandId,
    campaign_id: 'CAPTIVE',
  }], state, { diceService: dice([roll]), context: { allowedActorIds: ['hero'] } })
}

test('пленный после разгрома сговорчивее: страх снижает СЛ допроса', () => {
  const state = withCaptives()
  const captive = captiveOf(state)
  const policy = captiveInterrogationPolicy(state, captive, { skill: 'intimidation' })
  assert.ok(policy.difficulty >= 5 && policy.difficulty <= 25)
  assert.equal(policy.fear_shift, -3)
  assert.ok(policy.fact_id, 'пленному обязано быть что рассказать')

  // Каждый вытянутый факт делает следующий разговор труднее.
  const afterOne = captiveInterrogationPolicy(state, { ...captive, revealed_fact_ids: [policy.fact_id] }, { skill: 'intimidation' })
  assert.ok(afterOne.difficulty > policy.difficulty)
})

test('удачный допрос раскрывает факт памяти мира именно тому, кто допрашивал', () => {
  const state = withCaptives()
  const captive = captiveOf(state)
  const hidden = state.worldMemory.facts.find((fact) => fact.id === captive.known_fact_ids[0])
  assert.ok(hidden, 'зацепка пленного обязана лежать в памяти мира')
  assert.equal(hidden.visibility, 'gm_only')

  const before = campaignStateForViewer(state, { role: 'player' }, 'hero')
  assert.equal(before.worldMemory.facts.some((fact) => fact.id === hidden.id), false)

  const result = interrogate(state)
  const interrogated = result.events.find((event) => event.event_type === 'CaptiveInterrogated')
  assert.equal(interrogated.payload.success, true)
  assert.equal(interrogated.payload.fact_id, hidden.id)
  const revealed = result.events.find((event) => event.event_type === 'KnowledgeRevealed')
  assert.equal(revealed.payload.hero_id, 'hero')
  assert.equal(revealed.payload.fact_id, hidden.id)
  assert.equal(revealed.visibility, 'specific_player')

  const after = campaignStateForViewer(result.state, { role: 'player' }, 'hero')
  assert.equal(after.worldMemory.facts.some((fact) => fact.id === hidden.id), true)
  assert.deepEqual(captiveOf(result.state).revealed_fact_ids, [hidden.id])
  assert.equal(captiveOf(result.state).interrogations, 1)
})

test('проваленный допрос ничего не раскрывает, а исчерпанного пленного не допрашивают', () => {
  const state = withCaptives()
  const failed = interrogate(state, { roll: 1 })
  assert.equal(failed.events.find((event) => event.event_type === 'CaptiveInterrogated').payload.success, false)
  assert.equal(failed.events.some((event) => event.event_type === 'KnowledgeRevealed'), false)
  assert.deepEqual(captiveOf(failed.state).revealed_fact_ids, [])

  const told = interrogate(state).state
  assert.throws(
    () => interrogate(told, { commandId: 'cmd-interrogate-2' }),
    (error) => error.code === 'CAPTIVE_KNOWLEDGE_EXHAUSTED',
  )
})

test('отпущенный помнит пощаду: отношение, стойка и запись в памяти мира', () => {
  const state = withCaptives()
  const captive = captiveOf(state)
  const result = resolveCommands([{
    command_type: 'ReleaseCaptive',
    actor_id: 'hero',
    captive_id: captive.id,
    command_id: 'cmd-release',
    campaign_id: 'CAPTIVE',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  const released = result.events.find((event) => event.event_type === 'CaptiveReleased')
  assert.ok(['ally', 'informant', 'none'].includes(released.payload.disposition))
  const relationship = result.events.find((event) => event.event_type === 'NpcRelationshipAdjusted')
  assert.equal(relationship.payload.reason, 'captive-spared')
  assert.equal(result.state.social.relationships[captive.npc_id].hero, 12)
  assert.equal(result.state.npc_world.stances[captive.npc_id].stance, 'guarded')
  const fact = result.state.worldMemory.facts.find((entry) => entry.predicate === 'spared_by_party')
  assert.ok(fact)
  assert.equal(fact.visibility, 'gm_only')

  const stored = result.state.captives.captives.find((entry) => entry.id === captive.id)
  assert.equal(stored.status, 'released')
  assert.equal(stored.disposition, released.payload.disposition)
  assert.equal(heldCaptives(result.state).some((entry) => entry.id === captive.id), false)
})

test('сдача страже даёт награду и славу закона только в поселении', () => {
  const state = withCaptives({ npcs: [villager('watchman', 'Страж Бран')] })
  const captive = captiveOf(state)
  assert.ok(captiveSettlementFor(state))
  const result = resolveCommands([{
    command_type: 'HandCaptiveToGuards',
    actor_id: 'hero',
    captive_id: captive.id,
    command_id: 'cmd-handover',
    campaign_id: 'CAPTIVE',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  const handed = result.events.find((event) => event.event_type === 'CaptiveHandedOver')
  assert.equal(handed.payload.settlement_name, VILLAGE)
  assert.equal(handed.payload.bounty_cp, captiveBountyCp(captive))
  assert.ok(handed.payload.bounty_cp > 0)
  const hero = result.state.players.find((player) => player.id === 'hero')
  assert.equal(currencyToCopper(hero.currency), handed.payload.balance_after_cp)
  const reputation = result.events.filter((event) => event.event_type === 'FactionReputationAdjusted')
  assert.deepEqual(reputation.map((event) => event.payload.faction_id), ['brod-watch'])
  assert.equal(reputation[0].payload.delta, 3)
  assert.equal(result.state.captives.captives.find((entry) => entry.id === captive.id).status, 'handed_over')

  // В глуши сдавать некому.
  const wilds = withCaptives({ sceneKind: 'wilds' })
  assert.equal(captiveSettlementFor(wilds), null)
  assert.throws(() => resolveCommands([{
    command_type: 'HandCaptiveToGuards',
    actor_id: 'hero',
    captive_id: captiveOf(wilds).id,
    command_id: 'cmd-handover-wilds',
    campaign_id: 'CAPTIVE',
  }], wilds, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), (error) => error.code === 'CAPTIVE_NO_SETTLEMENT')
})

test('связанного надо кормить: сутки без еды — поступок жестокости', () => {
  const state = withCaptives({ npcs: [villager('watchman', 'Страж Бран')] })
  const captive = captiveOf(state)
  assert.deepEqual(planCaptiveNeglectCommands(state, { worldMinute: CAPTIVE_FEED_INTERVAL_MINUTES - 1 }), [])
  const due = planCaptiveNeglectCommands(state, { worldMinute: CAPTIVE_FEED_INTERVAL_MINUTES })
  assert.equal(due.length, 2)
  assert.equal(due[0].command_type, 'NeglectCaptive')

  const hungry = applyGameEvent(state, { event_type: 'TimeAdvanced', payload: { amount: 24, unit: 'hour', elapsed_minutes: CAPTIVE_FEED_INTERVAL_MINUTES }, target_ids: [], visibility: 'party' })
  const neglected = resolveCommands([{
    command_type: 'NeglectCaptive',
    captive_id: captive.id,
    command_id: 'cmd-neglect',
    campaign_id: 'CAPTIVE',
  }], hungry, { diceService: dice(), context: { isDirector: true } })
  const deed = worldDeedsFeed(neglected.state)[0]
  assert.equal(deed.kind, 'cruelty')
  assert.equal(deed.label, 'Жестокость')
  // Свидетели — живые NPC сцены: житель и второй пленник, который всё видел.
  // Сам голодающий свидетелем собственного мучения не считается.
  assert.deepEqual(deed.witness_ids, ['enemy-knocked', 'watchman'])

  // Кормёжка сдвигает отсчёт, и следующий такт молчит.
  const fed = resolveCommands([{
    command_type: 'FeedCaptive',
    actor_id: 'hero',
    captive_id: captive.id,
    command_id: 'cmd-feed',
    campaign_id: 'CAPTIVE',
  }], hungry, { diceService: dice(), context: { allowedActorIds: ['hero'] } })
  assert.equal(
    planCaptiveNeglectCommands(fed.state, { worldMinute: CAPTIVE_FEED_INTERVAL_MINUTES })
      .some((command) => command.captive_id === captive.id),
    false,
  )
  assert.equal(
    fed.state.captives.captives.find((entry) => entry.id === captive.id).last_fed_at_minutes,
    CAPTIVE_FEED_INTERVAL_MINUTES,
  )

  // Голод отмечают только часы кампании: у отряда такой кнопки нет.
  assert.throws(() => resolveCommands([{
    command_type: 'NeglectCaptive',
    captive_id: captive.id,
    command_id: 'cmd-neglect-player',
    campaign_id: 'CAPTIVE',
  }], hungry, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), (error) => error.code === 'CAPTIVE_NEGLECT_FORBIDDEN')
})

test('убийство пленного — жестокость, а не рядовое убийство; свидетели те же', () => {
  const state = withCaptives({ npcs: [villager('watchman', 'Страж Бран')] })
  const captive = captiveOf(state)
  const result = resolveCommands([{
    command_type: 'ExecuteCaptive',
    actor_id: 'hero',
    captive_id: captive.id,
    command_id: 'cmd-execute',
    campaign_id: 'CAPTIVE',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  assert.ok(result.events.some((event) => event.event_type === 'NpcDied'))
  assert.ok(result.events.some((event) => event.event_type === 'CaptiveExecuted'))
  const kinds = worldDeedsFeed(result.state).map((deed) => deed.kind)
  assert.deepEqual(kinds, ['cruelty'], 'один нож — один поступок, и это жестокость')
  const [deed] = worldDeedsFeed(result.state)
  assert.deepEqual(deed.actor_names, ['Ада'])
  // Свидетели — живые NPC сцены, а не сам отряд: житель и второй пленник.
  assert.deepEqual(deed.witness_ids, ['enemy-knocked', 'watchman'])
  assert.equal(result.state.captives.captives.find((entry) => entry.id === captive.id).status, 'dead')
})

test('казнь пленного без поста в сцене всё равно объявляет смерть и жестокость', () => {
  const state = withCaptives()
  const captive = captiveOf(state)
  // Карта могла измениться так, что поста у пленного не осталось. Мир обязан
  // узнать о смерти и в этом случае — иначе связанный остался бы живым NPC.
  const postless = normalizeCampaignState({ ...state, npc_world: { ...state.npc_world, placements: [] } })
  const result = resolveCommands([{
    command_type: 'ExecuteCaptive',
    actor_id: 'hero',
    captive_id: captive.id,
    command_id: 'cmd-execute-postless',
    campaign_id: 'CAPTIVE',
  }], postless, { diceService: dice(), context: { allowedActorIds: ['hero'] } })
  assert.ok(result.events.some((event) => event.event_type === 'NpcDied'))
  assert.equal(result.state.npc_world.vitals[captive.npc_id].alive, false)
  assert.deepEqual(worldDeedsFeed(result.state).map((deed) => deed.kind), ['cruelty'])
})

test('пленный уходит с отрядом при смене сцены', () => {
  const state = withCaptives()
  const captive = captiveOf(state)
  const result = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-advance',
    campaign_id: 'CAPTIVE',
    scene_args: { location: 'Старый тракт', title: 'Дорога', objective: 'Идти дальше' },
  }], state, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })

  const moved = result.events.find((event) => event.event_type === 'CaptiveMoved')
  assert.ok(moved, 'связанного уводят с собой')
  assert.equal(result.state.captives.captives.find((entry) => entry.id === captive.id).location_name, 'Старый тракт')
  assert.equal(result.state.social.npcs.find((npc) => npc.id === captive.npc_id).location, 'Старый тракт')
})

test('во время боя пленным не распоряжаются', () => {
  const state = withCaptives()
  const fighting = applyGameEvent(state, {
    event_type: 'CombatStarted',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { round: 1, initiative: [{ actor_id: 'hero', total: 15 }], active_index: 0, party_ids: ['hero'], enemy_ids: [] },
    visibility: 'public',
  })
  assert.throws(() => resolveCommands([{
    command_type: 'ReleaseCaptive',
    actor_id: 'hero',
    captive_id: captiveOf(state).id,
    command_id: 'cmd-release-combat',
    campaign_id: 'CAPTIVE',
  }], fighting, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), (error) => error.code === 'CAPTIVE_DURING_COMBAT')
})

test('реестр пленных переживает replay и не течёт игроку сверх положенного', () => {
  const state = withCaptives()
  const told = interrogate(state)
  const replayed = replayEvents(campaign(), [...endCombat(campaign()).events, ...told.events])
  assert.deepEqual(replayed.captives, told.state.captives)

  const captive = captiveOf(told.state)
  const player = campaignStateForViewer(told.state, { role: 'player' }, 'hero')
  const visible = player.captives.captives.find((entry) => entry.id === captive.id)
  assert.ok(visible, 'отряд обязан видеть своего пленника')
  assert.equal(visible.known_fact_ids, undefined, 'нераскрытое знание принадлежит ведущему')
  assert.equal(visible.pending_knowledge, 0)
  assert.deepEqual(visible.revealed_fact_ids, captive.revealed_fact_ids)

  const gm = campaignStateForViewer(told.state, { role: 'admin' }, 'hero')
  assert.deepEqual(gm.captives.captives.find((entry) => entry.id === captive.id).known_fact_ids, captive.known_fact_ids)

  // До допроса игрок видит только счётчик «есть что вытянуть», а не сам факт.
  const untouched = captivesForViewer(state, { isAdmin: false }).captives
    .find((entry) => entry.actor_id === 'enemy-surrendered')
  assert.equal(untouched.pending_knowledge, 1)
  assert.equal(untouched.known_fact_ids, undefined)
})
