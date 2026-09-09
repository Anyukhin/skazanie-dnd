import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AuthoredNpcValidationError,
  authoredNpcCombatant,
  normalizeAuthoredNpcMechanics,
  safeAuthoredNpcMechanics,
} from '../server/authored-npc.mjs'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { monsterSpellcastingIssues } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { freezeEncounterOutcomePlan } from '../server/encounter-rewards.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { legendaryProfileFor } from '../server/legendary-actions.mjs'
import {
  applyNpcWorldEvent,
  npcInteractionTargetForViewer,
  npcMechanicsFor,
  npcVitalFor,
  normalizeNpcWorldState,
  planSceneNpcPlacementEvents,
  presentSceneNpcs,
  sceneNpcsForViewer,
} from '../server/npc-positioning.mjs'
import { buildNpcSocialCheckPolicy } from '../server/npc-social-check.mjs'
import { NPC_PORTRAIT_CHARACTER_ASSETS } from '../server/npc-portraits.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, npcCombatRequestFingerprint, previewD20Check, replayEvents, resolveCommand, resolveCommands } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { getWorldTemplate } from '../server/world-template-catalog.mjs'

const NPC_IDS = [
  'astohan-ares', 'astohan-ivara', 'astohan-oren', 'astohan-mira',
  'astohan-lomar', 'astohan-eldrin', 'astohan-kaelan', 'astohan-sargat',
]

const REQUIRED_INVENTORY_NAMES = Object.freeze({
  'astohan-ares': ['Клятвенный клинок', 'Сапфировый венец Валедора', 'Сине-золотая мантия короля', 'Гравированный латный доспех'],
  'astohan-ivara': ['Меч маршала', 'Тяжёлый арбалет', 'Арбалетные болты', 'Стальной полудоспех маршала', 'Синий военный плащ'],
  'astohan-oren': ['Архивный кинжал', 'Архивная мантия', 'Круглые архивные очки'],
  'astohan-mira': ['Дорожный лук', 'Короткий меч', 'Дорожный кожаный доспех', 'Колчан стрел'],
  'astohan-lomar': ['Рунический посох', 'Сине-зелёная мантия чародея'],
  'astohan-kaelan': ['Лунный Судья', 'Потёртые чёрно-серебряные латы'],
})

const PHYSICAL_ACTION_INVENTORY_NAMES = Object.freeze({
  'astohan-ares': ['Клятвенный клинок'],
  'astohan-ivara': ['Меч маршала', 'Тяжёлый арбалет'],
  'astohan-oren': ['Архивный кинжал'],
  'astohan-mira': ['Дорожный лук', 'Короткий меч'],
  'astohan-lomar': ['Рунический посох'],
  'astohan-kaelan': ['Лунный Судья'],
})

const hero = {
  id: 'hero', character: 'Испытатель', name: 'Игрок', role: 'Воин · ур. 8',
  characterClass: 'fighter', level: 8, hp: 72, maxHp: 72, armor: 18, speed: 30,
  proficiency: 3, abilities: { str: 18, dex: 14, con: 16, int: 10, wis: 12, cha: 10 },
  inventory: [], x: 3, y: 2,
}

async function campaign() {
  return new CampaignBootstrapper().create({
    code: 'ASTOHAN-NPCS', worldTemplateId: 'astohan-plains', players: [hero],
  })
}

function combatActor(npc, mechanics) {
  return authoredNpcCombatant({ npc, mechanics, position: { x: 4, y: 2 } })
}

function dice(values) {
  let index = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `authored-npc-roll-${++index}`,
    now: () => '2026-09-03T12:00:00.000Z',
  })
}

function combatState(actor) {
  const cells = []
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 9; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'ASTOHAN-COMBAT',
    partyMemberIds: ['hero'],
    players: [hero],
    enemies: [actor],
    scene: { title: 'Проверка', location: 'Проверка', cells },
    mechanics: {
      positions: { hero: { x: 3, y: 2 }, [actor.id]: { x: 4, y: 2 } },
      combat: {
        active: true, round: 1,
        initiative: [{ actor_id: actor.id, total: 20 }, { actor_id: 'hero', total: 10 }],
        active_index: 0,
        action_economy: {
          [actor.id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('Асстоханские равнины содержат восемь стабильных и механически разных NPC', () => {
  const npcs = getWorldTemplate('astohan-plains').opening.npcs
  assert.deepEqual(npcs.map((npc) => npc.id), NPC_IDS)
  assert.equal(new Set(npcs.map((npc) => npc.mechanics.profile_id)).size, NPC_IDS.length)
  assert.equal(new Set(npcs.map((npc) => JSON.stringify(npc.social_dcs))).size, NPC_IDS.length)
  assert.equal(new Set(npcs.map((npc) => JSON.stringify(npc.speech_profile))).size, NPC_IDS.length)
  for (const npc of npcs) {
    assert.deepEqual(normalizeAuthoredNpcMechanics(npc.mechanics), npc.mechanics)
    assert.ok(Object.keys(npc.mechanics.skills).length >= 4, npc.name)
    assert.ok(npc.mechanics.action_profiles.length >= 1, npc.name)
    assert.ok(npc.mechanics.features.every((feature) => ['verified', 'partial', 'ruling-only'].includes(feature.status)), npc.name)
    assert.ok(npc.inventory.length >= 1, npc.name)
  }
})

test('инвентарь авторских NPC называет видимое снаряжение и не объявляет природных атак оружием', () => {
  const npcs = getWorldTemplate('astohan-plains').opening.npcs
  for (const [npcId, names] of Object.entries(REQUIRED_INVENTORY_NAMES)) {
    const npc = npcs.find((candidate) => candidate.id === npcId)
    assert.ok(npc, npcId)
    const inventoryNames = new Set(npc.inventory.map((item) => item.name))
    for (const name of names) assert.ok(inventoryNames.has(name), `${npc.name}: нет «${name}»`)
  }
  for (const [npcId, names] of Object.entries(PHYSICAL_ACTION_INVENTORY_NAMES)) {
    const npc = npcs.find((candidate) => candidate.id === npcId)
    const inventoryNames = new Set(npc.inventory.map((item) => item.name))
    for (const name of names) assert.ok(inventoryNames.has(name), `${npc.name}: action fallback не совпадает с «${name}»`)
  }
  for (const npcId of ['astohan-eldrin', 'astohan-sargat']) {
    const npc = npcs.find((candidate) => candidate.id === npcId)
    assert.ok(npc)
    assert.equal(
      npc.inventory.some((item) => /меч|арбалет|кинжал|лук|копь[её]|клинок|оруж/iu.test(item.name)),
      false,
      `${npc.name}: природный stat block не должен получать искусственное оружие`,
    )
  }
})

test('неподдержанное поле, trait и заклинание не становятся авторской механикой', () => {
  const valid = getWorldTemplate('astohan-plains').opening.npcs[0].mechanics
  assert.throws(
    () => normalizeAuthoredNpcMechanics({ ...valid, damage_multiplier: 99 }),
    (error) => error instanceof AuthoredNpcValidationError && error.code === 'AUTHORED_NPC_INVALID',
  )
  assert.throws(
    () => normalizeAuthoredNpcMechanics({ ...valid, traits: [{ id: 'instant-victory', name: 'Победа' }] }),
    /не исполняется планировщиком/u,
  )
  assert.throws(
    () => normalizeAuthoredNpcMechanics({ ...valid, action_profiles: [valid.action_profiles[0], valid.action_profiles[0]] }),
    /повторяющийся id/u,
  )
  assert.throws(
    () => normalizeAuthoredNpcMechanics({ ...valid, spellcasting: { ability: 'int', save_dc: 15, attack_bonus: 7, spells: [{ id: 'detect-magic', uses: 1 }] } }),
    /не имеет исполнимой серверной механики/u,
  )
  assert.equal(safeAuthoredNpcMechanics({ profile_id: 'broken' }), null)
})

test('bootstrap размещает только четырёх героев первой сцены и сохраняет остальных дома', async () => {
  const state = await campaign()
  assert.deepEqual(state.social.npcs.map((npc) => npc.id), NPC_IDS)
  assert.deepEqual(state.npc_world.placements.map((entry) => entry.npc_id).sort(), [
    'astohan-ares', 'astohan-ivara', 'astohan-mira', 'astohan-oren',
  ])
  assert.deepEqual(presentSceneNpcs(state).map((npc) => npc.id).sort(), [
    'astohan-ares', 'astohan-ivara', 'astohan-mira', 'astohan-oren',
  ])
  const projected = sceneNpcsForViewer(state)
  assert.equal(projected.length, 4)
  assert.ok(projected.every((npc) => npc.can_start_combat === true), 'все четыре NPC первой сцены имеют готовый боевой профиль')
  assert.equal(npcVitalFor(state, 'astohan-ares').max_hp, 168)
  assert.equal(npcVitalFor(state, 'astohan-sargat').max_hp, 189)
  const atTower = {
    ...state,
    scene: { ...state.scene, location: 'Башня Ломара', location_id: 'astohan-lomar-tower' },
  }
  assert.deepEqual(presentSceneNpcs(atTower).map((npc) => npc.id), ['astohan-lomar'])
  const placement = planSceneNpcPlacementEvents(atTower).find((event) => event.payload.npc_id === 'astohan-lomar')
  assert.equal(placement?.event_type, 'NpcPlaced')
  const placed = { ...atTower, npc_world: applyNpcWorldEvent(atTower.npc_world, placement) }
  assert.deepEqual(sceneNpcsForViewer(placed).map((npc) => npc.id), ['astohan-lomar'])
  assert.equal(npcInteractionTargetForViewer(placed, 'astohan-lomar')?.npc.id, 'astohan-lomar')
  assert.equal(npcInteractionTargetForViewer(state, 'astohan-lomar'), null)
})

test('у каждого персонажа действуют собственные социальные СЛ', async () => {
  const state = await campaign()
  for (const npc of state.social.npcs) {
    const policy = buildNpcSocialCheckPolicy({
      state, npcId: npc.id, heroId: 'hero', message: `Убеждаю ${npc.name} помочь`, turnId: `turn-${npc.id}`,
    })
    assert.equal(policy.skill, 'persuasion')
    assert.equal(policy.difficulty, npc.social_dcs.persuasion, npc.name)
  }
})

test('закрытые листы не попадают игроку, но переживают полный replay', async (t) => {
  const state = await campaign()
  const projected = campaignStateForViewer(state, { role: 'player' }, 'hero')
  assert.equal(projected.npc_world, undefined)
  assert.deepEqual(projected.social.npcs.map((npc) => npc.id), [
    'astohan-ares', 'astohan-ivara', 'astohan-oren', 'astohan-mira',
  ])
  assert.doesNotMatch(JSON.stringify(projected), /astohan:sargat-v1|challenge_rating|action_profiles|saving_throws/u)
  assert.doesNotMatch(JSON.stringify(projected.social), /astohan-sargat|Жаровня Вулканиса/u)
  const atLomar = campaignStateForViewer({
    ...state,
    scene: { ...state.scene, location: 'Башня Ломара', location_id: 'astohan-lomar-tower' },
  }, { role: 'player' }, 'hero')
  assert.ok(atLomar.social.npcs.some((npc) => npc.id === 'astohan-lomar'))
  assert.ok(!atLomar.social.npcs.some((npc) => npc.id === 'astohan-sargat'))

  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-authored-npcs-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent })
  await store.initializeCampaign({
    campaign_id: state.sessionCode,
    initial_state: state,
    ruleset_id: state.ruleset_id,
    ruleset_version: state.ruleset_version,
    enabled_rule_packs: state.enabled_rule_packs,
    enabled_house_rules: state.enabled_house_rules,
  })
  const replayed = await new FileEventStore({ rootDir, reducer: applyGameEvent }).replay(state.sessionCode, { use_snapshots: false })
  assert.deepEqual(replayed.state.npc_world.profiles, state.npc_world.profiles)
  assert.deepEqual(replayed.state.social.npcs, state.social.npcs)
  const fromSnapshot = await new FileEventStore({ rootDir, reducer: applyGameEvent }).replay(state.sessionCode)
  assert.deepEqual(fromSnapshot.state.npc_world.profiles, state.npc_world.profiles)
  assert.deepEqual(fromSnapshot.state.social.npcs, state.social.npcs)
})

test('все восемь боевых профилей понятны существующему планировщику', async () => {
  const state = await campaign()
  for (const npc of state.social.npcs) {
    const mechanics = npcMechanicsFor(state, npc.id)
    const actor = combatActor(npc, mechanics)
    assert.equal(actor.image, NPC_PORTRAIT_CHARACTER_ASSETS[npc.id], npc.name)
    assert.deepEqual(monsterSpellcastingIssues(actor), [], npc.name)
    if (mechanics.legendary) assert.ok(legendaryProfileFor(actor), npc.name)
    const plan = planNpcTurn(combatState(actor), actor.id)
    assert.ok(plan.some((command) => ['MakeAttack', 'CastSpell'].includes(command.command_type)), `${npc.name}: ${JSON.stringify(plan)}`)
  }
})

test('повреждённый сохранённый профиль отбрасывается без поломки кампании', () => {
  const world = normalizeNpcWorldState({
    schema_version: 3,
    profiles: {
      good: getWorldTemplate('astohan-plains').opening.npcs[0].mechanics,
      bad: { profile_id: '../../outside', hp: 999999 },
    },
  })
  assert.deepEqual(Object.keys(world.profiles), ['good'])
  assert.equal(world.schema_version, 3)
})

test('Режиссёр материализует присутствующего Саргата в обычный encounter и инициативу', async () => {
  const initial = await campaign()
  const sargatPlacement = {
    npc_id: 'astohan-sargat', location_id: 'astohan-vulkanis-brazier',
    x: 4, y: 2, anchor_prop_id: '', placement_reason: 'authored-test',
    policy_id: 'skazanie:npc-world-v1', source_event_id: '',
  }
  const state = normalizeCampaignState({
    ...initial,
    scene: {
      ...initial.scene,
      title: 'Жаровня Вулканиса', location: 'Жаровня Вулканиса',
      location_id: 'astohan-vulkanis-brazier', locationId: 'astohan-vulkanis-brazier',
    },
    npc_world: {
      ...initial.npc_world,
      placements: [...initial.npc_world.placements, sargatPlacement],
    },
    players: initial.players.map((player) => ({ ...player, x: 3, y: 2 })),
    mechanics: { ...initial.mechanics, positions: { ...initial.mechanics.positions, hero: { x: 3, y: 2 } } },
  })
  const result = resolveCommands([
    {
      command_type: 'CreateEncounter', command_id: 'create-sargat', npc_id: 'astohan-sargat',
      theme: 'beasts', difficulty: 'easy', seed: 'sargat-test', request_fingerprint: 'sargat-fingerprint',
    },
    { command_type: 'StartCombat', command_id: 'start-sargat', actor_id: 'hero', server_authoritative: true },
  ], state, {
    diceService: dice([1, 20]),
    context: { isDirector: true, serverAuthoritativeCombat: true },
  })
  assert.deepEqual(result.events.slice(0, 2).map((event) => event.event_type), ['EncounterCreated', 'CombatStarted'])
  const created = result.events[0].payload.encounter
  assert.equal(created.difficulty, 'deadly', 'сложность берётся из листа, а не из intent')
  assert.equal(created.theme, 'generic')
  assert.equal(created.enemies[0].image, NPC_PORTRAIT_CHARACTER_ASSETS['astohan-sargat'])
  assert.equal(created.enemies[0].stat_block_id, 'astohan:sargat-v1')
  assert.equal(created.enemies[0].hp, 189)
  assert.equal(created.enemies[0].legendary.actions.length, 3)

  const active = result.events.reduce(applyGameEvent, state)
  assert.equal(active.mechanics.combat.active, true)
  assert.equal(active.enemies[0].id, 'astohan-sargat')
  assert.equal(active.social.npcs.find((npc) => npc.id === 'astohan-sargat').available, false)
  assert.equal(previewD20Check(active, { actorId: 'astohan-sargat', kind: 'check', skill: 'perception', difficulty: 10 }).modifier, 9)
  assert.equal(previewD20Check(active, { actorId: 'astohan-sargat', kind: 'save', ability: 'con', difficulty: 10 }).modifier, 9)
  const perception = resolveCommand({
    command_type: 'MakeAbilityCheck', actor_id: 'astohan-sargat', skill: 'perception', difficulty: 10,
  }, active, { diceService: dice([10]) })
  assert.equal(perception.rolls[0].modifier, 9)
  const constitution = resolveCommand({
    command_type: 'MakeSavingThrow', actor_id: 'astohan-sargat', ability: 'con', difficulty: 10,
  }, active, { diceService: dice([10]) })
  assert.equal(constitution.rolls[0].modifier, 9)

  const playerEvents = mechanicsForViewer(result.events, { role: 'player' }, 'hero', active)
  const playerEncounter = playerEvents.find((event) => event.event_type === 'EncounterCreated').payload.encounter
  assert.deepEqual(playerEncounter.enemies[0].legendary, { uses: 3, used: 0 })
  assert.doesNotMatch(
    JSON.stringify(playerEncounter),
    /astohan:sargat-v1|action_profiles|authored_features|authored_tactics|savingThrowModifiers|skillModifiers|origin|provenance/u,
  )

  const wounded = applyGameEvent(active, {
    event_type: 'DamageApplied', actor_id: 'hero', target_ids: ['astohan-sargat'],
    payload: { hp_before: 189, hp_after: 150, applied_amount: 39, damage_type: 'slashing' },
  })
  assert.deepEqual(wounded.npc_world.vitals['astohan-sargat'], { hp: 150, max_hp: 189, alive: true })

  const defeated = structuredClone(active)
  defeated.enemies[0].hp = 0
  defeated.enemies[0].alive = false
  defeated.mechanics.encounter.status = 'ended'
  defeated.mechanics.encounter.outcome = 'enemies_defeated'
  const reward = freezeEncounterOutcomePlan(defeated, 'enemies_defeated')
  assert.equal(reward.total_xp, 5900)
  assert.equal(reward.enemies[0].stat_block_id, 'astohan:sargat-v1')
})

test('именованный encounter закрыт для игрока и для NPC из другой локации', async () => {
  const state = await campaign()
  const command = {
    command_type: 'CreateEncounter', command_id: 'forbidden-sargat', npc_id: 'astohan-sargat',
    theme: 'generic', difficulty: 'deadly', seed: 'forbidden',
  }
  assert.throws(
    () => resolveCommand(command, state, { diceService: dice([]) }),
    (error) => error.code === 'ENCOUNTER_MANAGEMENT_FORBIDDEN',
  )
  assert.throws(
    () => resolveCommand(command, state, { diceService: dice([]), context: { isDirector: true } }),
    (error) => error.code === 'AUTHORED_NPC_NOT_PRESENT',
  )
})

test('игрок может начать бой с видимым авторским NPC без подмены профиля и позиции', async () => {
  const initial = await campaign()
  const beforeMap = structuredClone(initial.scene.map)
  const beforeHeroPosition = structuredClone(initial.mechanics?.positions?.hero ?? { x: initial.players[0].x, y: initial.players[0].y })
  const beforeNpcPosition = structuredClone(initial.npc_world.placements.find((entry) => entry.npc_id === 'astohan-ares'))
  const command = { command_type: 'AttackNpc', command_id: 'attack-ares', actor_id: 'hero', npc_id: 'astohan-ares' }
  const result = resolveCommands([command], initial, {
    diceService: dice([1, 20]),
    context: { allowedActorIds: ['hero'] },
  })

  assert.deepEqual(result.events.slice(0, 2).map((event) => event.event_type), ['EncounterCreated', 'CombatStarted'])
  const encounter = result.events.find((event) => event.event_type === 'EncounterCreated')
  assert.equal(encounter?.payload?.request_fingerprint, npcCombatRequestFingerprint(command))
  assert.equal(encounter?.payload?.encounter?.enemies?.[0]?.id, 'astohan-ares')
  assert.equal(encounter?.payload?.encounter?.enemies?.[0]?.stat_block_id, 'astohan:ares-v1')

  assert.equal(result.state.mechanics.combat.active, true)
  assert.deepEqual(result.state.mechanics.positions.hero, beforeHeroPosition)
  assert.deepEqual(result.state.mechanics.positions['astohan-ares'], { x: beforeNpcPosition.x, y: beforeNpcPosition.y })
  assert.deepEqual(result.state.scene.map, beforeMap)
  assert.equal(result.state.social.npcs.find((npc) => npc.id === 'astohan-ares')?.available, false)

  const visibleEvents = mechanicsForViewer(result.events, { role: 'player' }, 'hero', result.state)
  const visibleEncounter = visibleEvents.find((event) => event.event_type === 'EncounterCreated')?.payload?.encounter
  assert.doesNotMatch(JSON.stringify(visibleEncounter), /stat_block_id|action_profiles|authored_features|provenance/u)
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})

test('вход в бой с NPC проверяет героя, видимость, живость и наличие боевого профиля', async () => {
  const initial = await campaign()
  const command = { command_type: 'AttackNpc', command_id: 'attack-ares-validation', actor_id: 'hero', npc_id: 'astohan-ares' }
  const reject = (state, context, code) => assert.throws(
    () => resolveCommand(command, state, { diceService: dice([]), context }),
    (error) => error.code === code,
  )

  reject(initial, { allowedActorIds: ['other'] }, 'ACTOR_FORBIDDEN')
  reject(normalizeCampaignState({
    ...initial,
    social: { ...initial.social, npcs: initial.social.npcs.map((npc) => npc.id === 'astohan-ares' ? { ...npc, visibility: 'gm_only', reveal_on_presence: false } : npc) },
  }), { allowedActorIds: ['hero'] }, 'AUTHORED_NPC_NOT_VISIBLE')
  reject(normalizeCampaignState({
    ...initial,
    npc_world: { ...initial.npc_world, vitals: { ...initial.npc_world.vitals, 'astohan-ares': { hp: 0, max_hp: 168, alive: false } } },
  }), { allowedActorIds: ['hero'] }, 'AUTHORED_NPC_NOT_ALIVE')
  reject(normalizeCampaignState({
    ...initial,
    npc_world: { ...initial.npc_world, profiles: Object.fromEntries(Object.entries(initial.npc_world.profiles).filter(([id]) => id !== 'astohan-ares')) },
  }), { allowedActorIds: ['hero'] }, 'AUTHORED_NPC_PROFILE_MISSING')
  const rulingOnly = normalizeCampaignState({
    ...initial,
    npc_world: {
      ...initial.npc_world,
      profiles: { ...initial.npc_world.profiles, 'astohan-ares': { ...initial.npc_world.profiles['astohan-ares'], status: 'ruling-only' } },
    },
  })
  assert.equal(sceneNpcsForViewer(rulingOnly).find((npc) => npc.id === 'astohan-ares')?.can_start_combat, false)
  reject(rulingOnly, { allowedActorIds: ['hero'] }, 'AUTHORED_NPC_PROFILE_UNVERIFIED')

  const active = resolveCommands([command], initial, { diceService: dice([1, 20]), context: { allowedActorIds: ['hero'] } }).state
  reject(active, { allowedActorIds: ['hero'] }, 'ENCOUNTER_DURING_COMBAT')
})

test('модель свободного мира не может подделать авторский ID, СЛ или боевой лист', async () => {
  const forged = getWorldTemplate('astohan-plains').opening.npcs[0].mechanics
  const state = await new CampaignBootstrapper({
    llmClient: {
      async completeJson() {
        return {
          npcs: [{
            id: 'forged-king', name: 'Поддельный король', role: 'правитель',
            summary: 'Пытается получить доверенный профиль.', voice: 'Приказывает.',
            goals: ['победить'], beliefs: ['ему можно всё'],
            social_dcs: { persuasion: 25 }, mechanics: forged,
          }],
        }
      },
    },
  }).create({ code: 'NPC-FORGE', world: {}, players: [hero] })
  assert.deepEqual(Object.keys(state.npc_world.profiles), [])
  assert.notEqual(state.social.npcs[0].id, 'forged-king')
  assert.equal(state.social.npcs[0].social_dcs, undefined)
})
