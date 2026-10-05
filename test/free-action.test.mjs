import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { Adjudicator } from '../server/adjudicator.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { freeActionGoalIsPassage, freeActionPassageDestination, freeActionPassagePlan } from '../server/free-action-adjudication.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { createItemInstance } from '../server/item-instances.mjs'
import { Narrator } from '../server/narrator.mjs'
import { buildNarrationBrief, verifyNarration } from '../server/security.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, addZone, createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'

function hero(id, character = id) {
  return {
    id, character, name: character, hp: 10, maxHp: 10, armor: 14,
    abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [],
  }
}

function campaign(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'FREE-ACTION',
    activePlayerId: 'hero',
    scene: { title: 'Зал', location: 'Старый трактир', objective: 'Осмотреть зал', cells: [] },
    players: [hero('hero', 'Ада'), hero('other', 'Бор')],
    ...overrides,
  })
}

function passageCampaign(doorState = 'open') {
  const map = createTacticalMap({ width: 5, height: 3, locationId: 'passage-fixture', seed: 'passage-fixture', sizeClass: 'arena' })
  addZone(map, { id: 'outside', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Снаружи' })
  addZone(map, { id: 'inside', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Монастырь' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 5; x += 1) {
    setCell(map, x, y, { passable: y === 1, revealed: true, zone: x < 2 ? 'outside' : 'inside' })
  }
  setDoor(map, { id: 'passage-door', x: 1, y: 1, dir: 'e', state: doorState })
  return campaign({
    scene: {
      title: 'Вход', location: 'Монастырь', objective: 'Войти внутрь',
      cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map),
    },
    players: [hero('hero', 'Ада'), hero('other', 'Бор')],
    mechanics: { combat: { active: false }, positions: { hero: { x: 0, y: 1 }, other: { x: 4, y: 1 } } },
  })
}

function porchPassageCampaign(doorState = 'open') {
  const map = createTacticalMap({ width: 6, height: 3, locationId: 'porch-fixture', seed: 'porch-fixture', sizeClass: 'arena' })
  addZone(map, { id: 'outside', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Снаружи' })
  addZone(map, { id: 'porch', kind: 'interior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Крыльцо' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Зал' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 6; x += 1) {
    setCell(map, x, y, { passable: y === 1, revealed: true, zone: x === 0 ? 'outside' : x < 3 ? 'porch' : 'hall' })
  }
  setDoor(map, { id: 'porch-door', x: 2, y: 1, dir: 'e', state: doorState })
  return campaign({
    scene: { title: 'Монастырь', location: 'Монастырь', objective: 'Войти внутрь', cells: legacyCellsFromTacticalMap(map), map: serializeTacticalMap(map) },
    mechanics: { combat: { active: false }, positions: { hero: { x: 0, y: 1 }, other: { x: 5, y: 1 } } },
  })
}

async function setup(initialState = campaign(), { rollRegistry = null, narrator = null, diceRolls = [18, 3, 18, 3, 18, 3, 18, 3], reading = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-free-action-'))
  const dice = new DiceService({ rng: new SequenceDiceRng(diceRolls), idFactory: (() => { let id = 0; return () => `free-roll-${++id}` })() })
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    idFactory: (() => { let id = 0; return () => `free-event-${++id}` })(),
  })
  const rulesEngine = new RulesEngine({ diceService: dice })
  let narratorCalls = 0
  // Прочтение заявки задаётся тестом: судья свободных действий без ключа модели
  // таких фраз не разбирает, а проверяется здесь ответ после commit.
  const unknownActionHandler = reading
    ? new AutonomousCampaignOrchestrator({
      eventStore, rulesEngine, rollRegistry,
      actionAdjudicator: new ActionAdjudicator({ llmClient: { completeJson: async () => reading } }),
    })
    : null
  const orchestrator = new GameOrchestrator({
    rulesEngine,
    eventStore,
    narrator: narrator ?? { render: async () => { narratorCalls += 1; throw new Error('Свободное действие не должно вызывать Narrator') } },
    rollRegistry,
    unknownActionHandler,
    idFactory: (() => { let id = 0; return () => `free-turn-${++id}` })(),
  })
  await eventStore.initializeCampaign({ campaign_id: 'FREE-ACTION', initial_state: initialState })
  return { orchestrator, eventStore, dice, narratorCalls: () => narratorCalls, initialState }
}

function actionInput(message, idempotencyKey, state) {
  return {
    state,
    campaignId: 'FREE-ACTION',
    playerId: 'hero',
    allowedActorIds: ['hero'],
    message,
    idempotencyKey,
  }
}

test('неудачное сальто наносит серверный 1d4 урона без десяти минут и повторного применения', async () => {
  const initial = campaign()
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([1]) }) })
  const { orchestrator, eventStore } = await setup(initial, {
    rollRegistry: registry, diceRolls: [3],
    narrator: { render: async () => ({ narration: 'Запасное описание.', provider: 'deterministic-test' }) },
  })
  // Воспроизводим прочтение из реальной карточки: Акробатика, strenuous, minor.
  orchestrator.unknownActionHandler.actionAdjudicator = { read: async () => ({
    goal_summary: 'Сделать сальто', approach_summary: 'Сальто на месте',
    ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous', risk: 'minor',
    effect: 'none', consequence_type: 'time', source: 'regression-fixture',
  }) }
  const text = 'он делает сальто'
  const offered = await orchestrator.handle(actionInput(text, 'flip-offer', initial))
  assert.equal(offered.free_action_outcome, 'check_required')
  assert.deepEqual(offered.mechanics, [])
  const rolled = registry.issue({ checkId: offered.check.check_id, campaignId: 'FREE-ACTION', actorId: 'hero' })
  const verifiedRoll = registry.consume(rolled.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'flip-resolve' })
  const input = { ...actionInput(text, 'flip-resolve', initial), verifiedRoll }
  const result = await orchestrator.handle(input)
  const damage = result.mechanics.filter(event => event.event_type === 'DamageApplied')
  assert.equal(damage.length, 1)
  assert.equal(damage[0].payload.applied_amount, 3)
  assert.equal(damage[0].payload.damage_type, 'bludgeoning')
  assert.match(result.narration, /Дробящий удар: Ада получает 3 урона/u)
  assert.doesNotMatch(result.narration, /Подтверждено: подтверждённый|урон нанесён цели/u)
  assert.deepEqual(damage[0].target_ids, ['hero'])
  const ruling = result.mechanics.find(event => event.event_type === 'RulingRecorded').payload.ruling
  assert.equal(damage[0].ruling_id, ruling.id)
  assert.equal(ruling.interpretation.activity_kind, 'stunt')
  assert.equal(ruling.interpretation.duration_class, 'instant')
  assert.equal(ruling.interpretation.policy_version, 'free-action-resolution/v2')
  const persisted = await eventStore.load('FREE-ACTION')
  assert.equal(persisted.state.players.find(player => player.id === 'hero').hp, 7)
  assert.equal(persisted.state.players.find(player => player.id === 'other').hp, 10)
  assert.equal(result.mechanics.some(event => ['TimeAdvanced', 'QuestClockAdvanced'].includes(event.event_type)), false)
  assert.equal(offered.check.difficulty, 20)
  assert.match(offered.check.proposal.cost, /секунд/u)
  assert.match(offered.check.proposal.on_failure, /1d4/u)
  const repeated = await orchestrator.handle(input)
  assert.equal(repeated.idempotent_replay, true)
  assert.equal((await eventStore.load('FREE-ACTION')).state_version, persisted.state_version)
  assert.deepEqual((await eventStore.replay('FREE-ACTION')).state, persisted.state)
})

test('общий профиль трюка не травмирует при успехе и использует обычные последствия нуля хитов', async () => {
  for (const [kept, hp, expectedHp] of [[20, 10, 10], [1, 1, 0]]) {
    const initial = campaign({ players: [{ ...hero('hero', 'Ада'), hp }, hero('other', 'Бор')] })
    const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([kept]) }) })
    const { orchestrator, eventStore } = await setup(initial, { rollRegistry: registry, diceRolls: kept === 20 ? [] : [3] })
    const text = 'Балансирую на узкой опоре'
    const offered = await orchestrator.handle(actionInput(text, 'balance-offer', initial))
    assert.equal(offered.free_action_outcome, 'check_required')
    const rolled = registry.issue({ checkId: offered.check.check_id, campaignId: 'FREE-ACTION', actorId: 'hero' })
    const verifiedRoll = registry.consume(rolled.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'balance-resolve' })
    const result = await orchestrator.handle({ ...actionInput(text, 'balance-resolve', initial), verifiedRoll })
    const persisted = await eventStore.load('FREE-ACTION')
    assert.equal(persisted.state.players.find(player => player.id === 'hero').hp, expectedHp)
    assert.equal(result.mechanics.some(event => event.event_type === 'HitPointsReducedToZero'), kept === 1)
    assert.equal(result.mechanics.some(event => event.event_type === 'DamageApplied'), kept === 1)
    assert.equal(result.mechanics.some(event => ['TimeAdvanced', 'HeroDied'].includes(event.event_type)), false)
    assert.deepEqual((await eventStore.replay('FREE-ACTION')).state, persisted.state)
  }
})

test('старая карточка без версии профиля завершается по прежним согласованным условиям', async () => {
  const initial = campaign()
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([1]) }) })
  const { orchestrator, eventStore } = await setup(initial, { rollRegistry: registry, diceRolls: [] })
  const text = 'Выполняю акробатический трюк'
  const offered = await orchestrator.handle(actionInput(text, 'old-offer', initial))
  const current = registry.getCheck(offered.check.check_id, { campaignId: 'FREE-ACTION', actorId: 'hero', includeContext: true })
  const legacy = registry.registerCheck({
    campaignId: 'FREE-ACTION', actorId: 'hero', label: current.label,
    ability: 'dex', modifier: current.modifier, difficulty: current.difficulty,
    context: { ...current.context, reading: {
      ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous', risk: 'minor',
      consequence_type: 'time', source: 'agent-adjudicator', effect: 'none',
      goal_summary: text, approach_summary: text,
    }, proposal: { cost: '5 минут при успехе', on_failure: 'Пройдёт 10 минут.' } },
  })
  const rolled = registry.issue({ checkId: legacy.check_id, campaignId: 'FREE-ACTION', actorId: 'hero' })
  const verifiedRoll = registry.consume(rolled.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'old-resolve' })
  const result = await orchestrator.handle({ ...actionInput(text, 'old-resolve', initial), verifiedRoll })
  assert.equal(result.mechanics.some(event => event.event_type === 'DamageApplied'), false)
  assert.equal((await eventStore.load('FREE-ACTION')).state.players[0].hp, 10)
  assert.equal((await eventStore.load('FREE-ACTION')).state.mechanics.world_time.elapsed_minutes - initial.mechanics.world_time.elapsed_minutes, 10)
})

test('пустой ввод получает уточнение, фиксируется без расхода хода и не показывает служебное имя поля', async () => {
  const { orchestrator, eventStore, narratorCalls } = await setup()
  const result = await orchestrator.handle(actionInput('', 'free-empty', campaign()))

  assert.match(result.narration, /Опишите действие подробнее/u)
  assert.doesNotMatch(result.narration, /message|Нужно уточнение|RulingRecorded/u)
  assert.equal(result.turn_consumed, false)
  assert.deepEqual(result.mechanics.map((event) => event.event_type), ['ActionDeclared'])
  assert.equal(narratorCalls(), 0)
  assert.ok((await eventStore.load('FREE-ACTION')).state_version > 0)
})

test('мусорный ввод не становится ruling или случайной проверкой', async () => {
  const { orchestrator } = await setup()
  const result = await orchestrator.handle(actionInput('asdkjhasdf', 'free-noise', campaign()))

  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /Опишите действие подробнее/u)
  assert.equal(result.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal(result.turn_consumed, false)
})

test('свободный текст про объект сцены использует ту же OperateSceneObject, что кнопка', async () => {
  const map = createTacticalMap({
    width: 4,
    height: 3,
    seed: 'free-object-scene',
    locationId: 'free-object-room',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  addProp(map, {
    id: 'prop-barrel',
    assetId: 'barrel',
    x: 1.5,
    y: 0.5,
    footprint: [{ x: 1, y: 0 }],
  })
  const initialState = campaign({
    players: [
      { ...hero('hero', 'Ада'), x: 0, y: 0 },
      { ...hero('other', 'Бор'), x: 3, y: 2 },
    ],
    scene: {
      title: 'Кладовая',
      location: 'Старый трактир',
      objective: 'Осмотреть кладовую',
      cells: [],
      map: serializeTacticalMap(map),
    },
    mechanics: { positions: { hero: { x: 0, y: 0 }, other: { x: 3, y: 2 } } },
  })
  const { orchestrator, eventStore } = await setup(initialState)
  const input = actionInput('Разбить бочку топором', 'free-scene-object', initialState)
  const first = await orchestrator.handle(input)
  const second = await orchestrator.handle(input)

  assert.equal(first.free_action_outcome, 'scene_interaction')
  assert.ok(first.mechanics.some((event) => event.event_type === 'SceneObjectOperated'))
  assert.ok(first.mechanics.some((event) => event.event_type === 'SceneObjectStateChanged'))
  assert.equal(first.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(first.mechanics.some((event) => event.event_type === 'ObjectiveUpdated'), false)
  assert.ok(first.mechanics.every((event) => (
    event.event_type !== 'SceneObjectOperated' || event.payload.approach === 'force'
  )))
  assert.equal(second.idempotent_replay, true)
  assert.deepEqual(second.mechanics, first.mechanics)
  assert.equal((await eventStore.load('FREE-ACTION')).state.scene.map.props.find((prop) => prop.id === 'prop-barrel').state, 'open')
})

test('физически невозможное действие просит подтверждённый способ вместо нерелевантной проверки', async () => {
  const { orchestrator } = await setup()
  const result = await orchestrator.handle(actionInput('Взлетаю под облака и осматриваю всю долину с высоты', 'free-impossible', campaign()))

  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /заклинание|предмет|способность/u)
  assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(result.turn_consumed, false)
})

test('разумное импровизированное действие получает bounded consequence через единственный живой путь', async () => {
  const { orchestrator } = await setup()
  const result = await orchestrator.handle(actionInput('Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи', 'free-door', campaign()))

  // Судейство: подпереть дверь — это проверка Силы с серверной СЛ, а не молчаливый ruling.
  assert.equal(result.free_action_outcome, 'check_success')
  assert.deepEqual(result.mechanics.map((event) => event.event_type),
    ['ActionDeclared', 'AbilityCheckResolved', 'RulingRecorded', 'TimeAdvanced'])
  assert.equal(result.ruling.status, 'applied')
  assert.equal(result.ruling.world_change, false)
  assert.equal(result.stakes.difficulty, 15)
  assert.equal(result.stakes.ability, 'str')
  assert.ok(result.stakes.on_failure.length > 0)
  assert.equal(result.authoritative_state.scene.objective, campaign().scene.objective)
  assert.match(result.narration, /Проверка пройдена|Задумка/u)
  assert.doesNotMatch(result.narration, /RulingRecorded|решени[ея]\s+ведущего/u)
  assert.equal(result.turn_consumed, false)
})

test('свободная проверка использует реальную expertise листа и контекстную СЛ', async () => {
  const initialState = campaign({
    players: [{
      ...hero('hero', 'Ада'),
      characterClass: 'rogue',
      level: 1,
      abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 },
      classSkillProficiencies: ['stealth'],
      skillExpertiseIds: ['stealth'],
    }, hero('other', 'Бор')],
    scene: {
      title: 'Двор',
      location: 'Старый трактир',
      objective: 'Пробраться незаметно',
      cells: [{ x: 0, y: 0, type: 'floor', revealed: true }],
    },
  })
  const { orchestrator } = await setup(initialState)
  const result = await orchestrator.handle(actionInput('Прячусь за телегой и жду у ворот', 'free-stealth-expertise', initialState))
  const check = result.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')

  assert.equal(result.free_action_outcome, 'check_success')
  assert.equal(check.payload.skill, 'stealth')
  assert.equal(check.payload.proficient, true)
  assert.equal(check.payload.expertise, true)
  assert.equal(check.payload.proficiency_bonus, 4)
  assert.equal(check.payload.modifier, 7)
  assert.equal(check.payload.difficulty, 10)
  assert.equal(result.stakes.proficiency, 'expertise')
  assert.deepEqual(result.stakes.difficulty_factors, ['scene_cover'])
})

test('свободное действие вне очереди фиксирует отказ, но не меняет цель и не тратит ход', async () => {
  const initialState = campaign({
    activePlayerId: 'other',
    mechanics: {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'other' }, { actor_id: 'hero' }],
        active_index: 0,
        action_economy: {},
      },
    },
  })
  const { orchestrator } = await setup(initialState)
  const result = await orchestrator.handle(actionInput('Подпираю дверь скамьёй', 'free-out-of-turn', initialState))

  assert.equal(result.rejected, true)
  assert.match(result.narration, /Сейчас действует другой участник/u)
  assert.equal(result.turn_consumed, false)
  assert.deepEqual(result.mechanics.map((event) => event.event_type), ['ActionDeclared'])
  assert.equal(result.authoritative_state.scene.objective, initialState.scene.objective)
  assert.equal(result.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'ObjectiveUpdated'), false)
})

test('повтор свободного действия с тем же idempotency_key возвращает прежний commit и replay совпадает', async () => {
  const { orchestrator, eventStore } = await setup()
  const input = actionInput('Кричу страже у ворот, что видел вора в переулке', 'free-idempotent', campaign())
  const first = await orchestrator.handle(input)
  const afterFirst = await eventStore.load('FREE-ACTION')
  const second = await orchestrator.handle(input)
  const afterSecond = await eventStore.load('FREE-ACTION')
  const replay = await eventStore.replay('FREE-ACTION')

  assert.equal(second.idempotent_replay, true)
  assert.equal(second.turn_id, first.turn_id)
  assert.equal(second.state_version, first.state_version)
  assert.deepEqual(second.mechanics, first.mechanics)
  assert.equal(afterSecond.state_version, afterFirst.state_version)
  assert.deepEqual(replay.state, afterSecond.state)
})

test('свободный текст передаёт собственный предмет через TransferItem и переживает replay/idempotency', async () => {
  const initialState = campaign({
    players: [
      {
        ...hero('hero', 'Ада'),
        characterClass: 'fighter',
        level: 1,
        classSkillProficiencies: [],
        inventory: [{ id: 'rope', name: 'Верёвка', type: 'tool', quantity: 2, weight: 1 }],
      },
      {
        ...hero('other', 'Бор'),
        characterClass: 'fighter',
        level: 1,
        classSkillProficiencies: [],
        inventory: [],
      },
    ],
    partyMemberIds: ['hero', 'other'],
  })
  const { orchestrator, eventStore } = await setup(initialState)
  const input = actionInput('Передаю Бору верёвку', 'free-transfer', initialState)
  const first = await orchestrator.handle(input)
  const second = await orchestrator.handle(input)
  const persisted = await eventStore.load('FREE-ACTION')
  const replay = await eventStore.replay('FREE-ACTION')

  assert.equal(first.free_action_outcome, 'item_transfer')
  assert.deepEqual(first.mechanics.map((event) => event.event_type), ['ActionDeclared', 'ItemTransferred'])
  assert.equal(first.authoritative_state.players.find((entry) => entry.id === 'hero').inventory[0].quantity, 1)
  assert.equal(first.authoritative_state.players.find((entry) => entry.id === 'other').inventory[0].quantity, 1)
  assert.equal(second.idempotent_replay, true)
  assert.equal(second.state_version, first.state_version)
  assert.deepEqual(replay.state, persisted.state)
})

test('свободный текст не даёт взять чужую вещь и не пишет даже декларацию до согласия владельца', async () => {
  const initialState = campaign({
    players: [
      { ...hero('hero', 'Ада'), inventory: [] },
      { ...hero('other', 'Бор'), inventory: [{ id: 'rope', name: 'Верёвка', type: 'tool', quantity: 1, weight: 1 }] },
    ],
    partyMemberIds: ['hero', 'other'],
  })
  const { orchestrator, eventStore } = await setup(initialState)
  const before = await eventStore.load('FREE-ACTION')
  const result = await orchestrator.handle(actionInput('Беру у Бора верёвку', 'free-take-forbidden', initialState))
  const after = await eventStore.load('FREE-ACTION')

  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /владелец/u)
  assert.deepEqual(result.mechanics, [])
  assert.equal(result.turn_consumed, false)
  assert.equal(after.state_version, before.state_version)
  assert.deepEqual(after.state.players, before.state.players)
})

test('явный npc_id не превращает карманную кражу в социальный разговор', async () => {
  const initialState = campaign({
    scene: {
      ...campaign().scene,
      location_id: 'old-tavern',
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
      ],
    },
    players: [{ ...hero('hero', 'Ада'), x: 0, y: 0 }],
    mechanics: { positions: { hero: { x: 0, y: 0 } } },
    social: { npcs: [{ id: 'mira', name: 'Мира', role: 'merchant', location: 'Старый трактир', available: true }] },
    npc_world: { placements: [{ npc_id: 'mira', location_id: 'old-tavern', x: 1, y: 0 }] },
  })
  const { orchestrator } = await setup(initialState)
  const result = await orchestrator.handle({
    ...actionInput('Незаметно обчищаю карманы: Мира', 'free-pickpocket-explicit-npc', initialState),
    npcId: 'mira',
  })

  assert.equal(result.free_action_outcome, 'pickpocket')
  assert.ok(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'))
  assert.equal(result.mechanics.some((event) => event.event_type === 'NpcConversationRecorded'), false)
})

test('неоднозначные предмет или союзник требуют уточнения без мутации', async () => {
  const initialState = campaign({
    players: [
      {
        ...hero('hero', 'Ада'),
        inventory: [
          { id: 'rope-a', name: 'Верёвка', type: 'tool', quantity: 1 },
          { id: 'rope-b', name: 'Верёвочная лестница', type: 'tool', quantity: 1 },
        ],
      },
      hero('other', 'Бор'),
      hero('third', 'Вика'),
    ],
    partyMemberIds: ['hero', 'other', 'third'],
  })
  const { orchestrator, eventStore } = await setup(initialState)
  const before = await eventStore.load('FREE-ACTION')
  const result = await orchestrator.handle(actionInput('Передаю товарищу верёвку', 'free-transfer-ambiguous', initialState))
  const after = await eventStore.load('FREE-ACTION')

  assert.equal(result.free_action_outcome, 'clarification')
  assert.deepEqual(result.mechanics, [])
  assert.equal(after.state_version, before.state_version)
  assert.deepEqual(after.state.players, before.state.players)
})

test('обыск тела без серверного содержимого не бросает кубик и не меняет состояние', async () => {
  const initialState = campaign({
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 0, maxHp: 7, armor: 12, alive: false }],
  })
  const { orchestrator, eventStore } = await setup(initialState)
  const before = await eventStore.load('FREE-ACTION')
  const result = await orchestrator.handle(actionInput('Осматриваю и обыскиваю тело гоблина', 'free-search-corpse', initialState))
  const after = await eventStore.load('FREE-ACTION')

  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /нет заданного сервером содержимого|не буду выдумывать/u)
  assert.deepEqual(result.mechanics, [])
  assert.equal(result.mechanics.some((event) => event.event_type === 'DieRolled'), false)
  assert.equal(after.state_version, before.state_version)
  assert.deepEqual(after.state, before.state)
})

// Тот же вопрос, но у тела есть настоящий контейнер (волна 3). Ответ обязан
// сойтись с панелью: содержимое названо, потому что герой стоит вплотную, — и
// при этом ни одна вещь не переехала в сумку. Осмотр бесплатен, и хода он не
// стоит: событий фиксация не оставляет вовсе.
test('обыск тела вплотную называет добычу контейнера, но ничего не берёт и хода не тратит', async () => {
  const dagger = createItemInstance({
    instanceId: 'inst-dagger',
    catalogId: 'srd_5_2_1:dagger',
    owner: { kind: 'container', actor_id: 'loot:corpse:free-action' },
    origin: { kind: 'enemy_loadout' },
    quantity: 1,
    lootable: true,
  })
  const initialState = campaign({
    scene: { title: 'Зал', location: 'Старый трактир', location_id: 'tavern', objective: 'Осмотреть зал', cells: [] },
    players: [{ ...hero('hero', 'Ада'), x: 1, y: 0 }, { ...hero('other', 'Бор'), x: 5, y: 0 }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 0, maxHp: 7, armor: 12, alive: false, x: 1, y: 1 }],
    mechanics: { positions: { hero: { x: 1, y: 0 }, other: { x: 5, y: 0 } } },
    loot_containers: {
      containers: [{
        id: 'loot:corpse:free-action',
        kind: 'corpse',
        source_enemy_id: 'goblin',
        name: 'Тело: Гоблин',
        location_id: 'tavern',
        x: 1,
        y: 1,
        status: 'available',
        items: [dagger],
      }],
    },
  })
  const { orchestrator, eventStore } = await setup(initialState)
  const before = await eventStore.load('FREE-ACTION')
  const result = await orchestrator.handle(actionInput('Осматриваю и обыскиваю тело гоблина', 'free-search-container', initialState))
  const after = await eventStore.load('FREE-ACTION')

  assert.equal(result.free_action_outcome, 'clarification')
  assert.ok(result.narration.includes('Кинжал'), result.narration)
  assert.match(result.narration, /панель добычи/u)
  assert.deepEqual(result.mechanics, [])
  assert.equal(result.turn_consumed, false)
  assert.equal(after.state_version, before.state_version)
  assert.deepEqual(after.state, before.state)
  // Молчаливого «взял» не случилось: вещь по-прежнему в контейнере.
  assert.deepEqual(after.state.players.find((player) => player.id === 'hero').inventory, [])
  assert.equal(after.state.loot_containers.containers[0].items.length, 1)
})

test('таблица сложности выбирает только серверные значения 10, 15 и 20', async () => {
  const state = campaign()
  const adjudicator = new Adjudicator()
  const make = (intent) => adjudicator.createPlan({ intent, state, retrievedRules: { results: [], confidence: 1 } })

  assert.equal((await make({ actor_id: 'hero', intent: 'ability_check', approach: 'strength', difficulty_category: 'easy', raw_message: 'проверяю дверь' })).proposed_commands[0].difficulty, 10)
  assert.equal((await make({ actor_id: 'hero', intent: 'ability_check', approach: 'strength', difficulty_category: 'hard', raw_message: 'проверяю дверь' })).proposed_commands[0].difficulty, 20)
  assert.equal((await make({ actor_id: 'hero', intent: 'ability_check', approach: 'strength', difficulty_category: '999', raw_message: 'проверяю дверь' })).proposed_commands[0].difficulty, 15)
  assert.equal((await make({ actor_id: 'hero', intent: 'saving_throw', approach: 'constitution', raw_message: 'спасбросок от ловушки' })).proposed_commands[0].difficulty, 15)
})

test('обычный ability_check тоже передаёт навык, а Rules Engine заново считает expertise', async () => {
  const state = campaign({
    players: [{
      ...hero('hero', 'Ада'),
      characterClass: 'rogue',
      level: 1,
      abilities: { str: 10, dex: 16, con: 10, int: 10, wis: 10, cha: 10 },
      classSkillProficiencies: ['stealth'],
      skillExpertiseIds: ['stealth'],
    }, hero('other', 'Бор')],
  })
  const plan = await new Adjudicator().createPlan({
    intent: {
      actor_id: 'hero',
      intent: 'ability_check',
      approach: 'stealth',
      difficulty_category: 'medium',
      raw_message: 'Крадусь вдоль стены',
      confidence: 1,
    },
    state,
    retrievedRules: { results: [], confidence: 1 },
  })
  assert.equal(plan.proposed_commands[0].skill, 'stealth')
  assert.equal(plan.proposed_commands[0].expertise, true)
  const resolved = new RulesEngine({
    diceService: new DiceService({ rng: new SequenceDiceRng([10]) }),
  }).resolvePlan(plan, state, { allowedActorIds: ['hero'] })
  const check = resolved.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.modifier, 7)
  assert.equal(check.payload.expertise, true)
  assert.equal(check.payload.proficiency_bonus, 4)
})

test('свободный текст в кампании 2014 использует только provenance своей редакции', async () => {
  const state = campaign({
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_rule_packs: ['dnd_5e_2014'],
  })
  const adjudicator = new Adjudicator()
  const plan = await adjudicator.createPlan({
    intent: {
      actor_id: 'hero', intent: 'ability_check', approach: 'perception',
      difficulty_category: 'medium', raw_message: 'Осматриваю зал', confidence: 1,
    },
    state,
    retrievedRules: { results: [], confidence: 1 },
  })

  assert.ok(plan.rule_ids.length > 0)
  assert.ok(plan.rule_ids.every((id) => id.startsWith('dnd_5e_2014:')), plan.rule_ids)
  assert.ok(plan.proposed_commands[0].source_rule_ids.every((id) => id.startsWith('dnd_5e_2014:')))
  const resolved = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([10]) }) })
    .resolvePlan(plan, state, { allowedActorIds: ['hero'] })
  assert.ok(resolved.events.length > 0)
  assert.ok(resolved.events.every((event) => event.source_rule_ids.every((id) => id.startsWith('dnd_5e_2014:'))))

  const { orchestrator } = await setup(state, { narrator: {
    render: async () => ({
      narration: 'Ада внимательно осматривает зал.',
      verification: { valid: true, violations: [] },
      prompt_version: 'test/narrator',
      provider: 'test',
    }),
  } })
  const turn = await orchestrator.handle(actionInput('Внимательно осматриваю зал', 'free-2014', state))
  assert.ok(turn.mechanics.length > 0)
  assert.ok(turn.mechanics.every((event) => event.source_rule_ids.every((id) => id.startsWith('dnd_5e_2014:'))))
})

test('Verifier блокирует утверждение изменения мира без подтверждённого события', () => {
  const brief = buildNarrationBrief({
    visible_events: [{ event_type: 'RulingRecorded', visibility: 'public', payload: { ruling: { world_change: false } } }],
    visible_state_changes: [],
    known_environment: { scene: { location: 'Зал' } },
    permitted_npc_reactions: [],
    narration_constraints: ['no-unconfirmed-world-changes'],
  })
  const rejected = verifyNarration('Занавес мгновенно вспыхивает, и зал заполняет дым.', brief)
  assert.equal(rejected.valid, false)
  assert.ok(rejected.violations.some((violation) => violation.code === 'WORLD_CHANGE_NOT_IN_BRIEF'))
  assert.equal(verifyNarration('Ситуация остаётся открытой.', brief).valid, true)
})

test('IntentParser отделяет невозможный полёт от проверки наблюдательности', async () => {
  const intent = await new IntentParser().parse({
    message: 'Взлетаю под облака и осматриваю долину',
    playerId: 'hero',
    visibleState: { players: [{ id: 'hero' }] },
  })
  assert.equal(intent.intent, 'improvised_action')
  assert.equal(intent.free_action_kind, 'physically_impossible')
})

test('IntentParser разрешает присутствующего NPC по роли и aliases, но не выбирает из двух молча', async () => {
  const parser = new IntentParser()
  const visibleState = {
    scene: { location: 'Трактир' },
    social: {
      npcs: [
        { id: 'mira', name: 'Мира', role: 'innkeeper', tags: ['хозяйка'], location: 'Трактир', available: true },
        { id: 'far', name: 'Торн', role: 'guard', tags: ['стражник'], location: 'Застава', available: true },
      ],
    },
  }
  const byRole = await parser.parse({ message: 'Спрашиваю трактирщика о караване', playerId: 'hero', visibleState })
  assert.equal(byRole.intent, 'social')
  assert.deepEqual(byRole.targets, ['mira'])
  assert.equal(byRole.requires_clarification, false)

  const byAlias = await parser.parse({ message: 'Говорю с хозяйкой', playerId: 'hero', visibleState })
  assert.deepEqual(byAlias.targets, ['mira'])

  const ambiguous = await parser.parse({
    message: 'Спрашиваю стражника о воротах',
    playerId: 'hero',
    visibleState: {
      ...visibleState,
      social: {
        npcs: [
          { id: 'guard-a', name: 'Арн', role: 'guard', location: 'Трактир', available: true },
          { id: 'guard-b', name: 'Бел', role: 'guard', location: 'Трактир', available: true },
        ],
      },
    },
  })
  assert.equal(ambiguous.requires_clarification, true)
  assert.deepEqual(ambiguous.missing_information, ['ambiguous_npc'])
  assert.deepEqual(ambiguous.targets.sort(), ['guard-a', 'guard-b'])
})

test('ручной бросок: сервер объявляет проверку, ничего не коммитит и завершает ход именно выпавшей костью', async () => {
  const registry = new RollRegistry({
    diceService: new DiceService({ rng: new SequenceDiceRng([18]), idFactory: () => 'manual-roll-1' }),
    checkIdFactory: () => 'manual-check-1',
  })
  const { orchestrator, eventStore } = await setup(campaign(), { rollRegistry: registry })

  // Фаза 1: проверка объявлена, кубик остаётся за игроком, событий нет.
  const invited = await orchestrator.handle({
    ...actionInput('Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи', 'free-manual-1', campaign()),
    manualRoll: true,
  })
  assert.equal(invited.free_action_outcome, 'check_required')
  assert.equal(invited.turn_consumed, false)
  assert.equal(invited.check.check_id, 'manual-check-1')
  assert.equal(invited.check.difficulty, 15)
  assert.equal(invited.check.ability, 'str')
  assert.match(invited.check.label, /Сила/u)
  assert.match(invited.narration, /Бросаете или попробуете иначе/u)
  assert.equal(invited.check.proposal.cost, 'займёт 5 минут')
  assert.match(invited.check.proposal.on_failure, /время/u)
  assert.deepEqual(invited.mechanics, [])
  assert.equal((await eventStore.load('FREE-ACTION')).state_version, 0)

  // Игрок бросает через реестр: та же математика, что показывалась на карточке.
  const issued = registry.issue({ checkId: 'manual-check-1', campaignId: 'FREE-ACTION', actorId: 'hero' })
  assert.equal(issued.kept, 18)
  // Сила +2 и владение Атлетикой +2 — ровно то, что показывала карточка.
  assert.equal(issued.modifier, 4)
  assert.equal(issued.success, true)

  const consumed = registry.consume(issued.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'free-manual-2' })
  assert.equal(consumed.context.kind, 'free_action')

  // Фаза 2: движок берёт кости игрока, пересчитывает итог и коммитит ход.
  const resolved = await orchestrator.handle({
    ...actionInput('Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи', 'free-manual-2', campaign()),
    manualRoll: true,
    verifiedRoll: consumed,
  })
  assert.equal(resolved.free_action_outcome, 'check_success')
  const check = resolved.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.roll_id, 'manual-roll-1')
  assert.equal(check.payload.kept, 18)
  assert.equal(check.payload.player_rolled, true)
  assert.equal(check.payload.success, true)
  assert.ok((await eventStore.load('FREE-ACTION')).state_version > 0)
})

test('автобросок не отменяет согласование рискованной импровизации', async () => {
  const registry = new RollRegistry({
    diceService: new DiceService({ rng: new SequenceDiceRng([9]), idFactory: () => 'manual-roll-x' }),
  })
  const { orchestrator, eventStore } = await setup(campaign(), { rollRegistry: registry })
  const result = await orchestrator.handle(actionInput('Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи', 'free-auto-1', campaign()))
  assert.equal(result.free_action_outcome, 'check_required')
  assert.ok(result.check.proposal)
  assert.deepEqual(result.mechanics, [])
  assert.equal((await eventStore.load('FREE-ACTION')).state_version, 0)
})

test('подтверждение нельзя перенести на другую заявку или изменившуюся сцену', async () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  const { orchestrator, eventStore } = await setup(campaign(), { rollRegistry: registry })
  const text = 'Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи'
  const offered = await orchestrator.handle(actionInput(text, 'proposal', campaign()))
  const rolled = registry.issue({ checkId: offered.check.check_id, campaignId: 'FREE-ACTION', actorId: 'hero' })
  const verifiedRoll = registry.consume(rolled.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'confirm' })
  await assert.rejects(orchestrator.handle({
    ...actionInput('Подпираю дверь верёвкой', 'confirm-other', campaign()), verifiedRoll,
  }), { code: 'ROLL_CONTEXT_MISMATCH' })
  assert.equal((await eventStore.load('FREE-ACTION')).state_version, 0)

  await eventStore.commit({ campaignId: 'FREE-ACTION', expectedStateVersion: 0, idempotencyKey: 'world-changed', events: [
    { event_type: 'ActionDeclared', actor_id: 'other', payload: { action: 'В мире произошло другое действие' } },
  ] })
  const changed = await eventStore.load('FREE-ACTION')
  await assert.rejects(orchestrator.handle({
    ...actionInput(text, 'confirm', changed.state), verifiedRoll,
  }), { code: 'STATE_VERSION_CONFLICT' })
  assert.equal((await eventStore.load('FREE-ACTION')).state_version, changed.state_version)
})

/**
 * Плейтест 2026-10-04, MAP2-02: «Вхожу через дверь башни внутрь маяка» стало
 * проверкой Атлетики СЛ 15, бросок 18 прошёл, решение записалось с
 * `world_change: false`, время сдвинулось на минуту — и ведущий ответил
 * «Вышло: войти внутрь маяка», хотя отряд остался во дворе.
 */
const passageReading = (overrides = {}) => ({
  goal_summary: 'Войти внутрь маяка',
  approach_summary: 'Через дверь башни, следуя за найденным рычагом',
  obstacle: 'запертая дверь башни',
  ability: 'str',
  skill: 'athletics',
  plausibility: 'plausible',
  risk: 'minor',
  required_means: [],
  action_cost: 'action',
  effect: 'none',
  effect_target: '',
  hazard: '',
  prop_id: '',
  target_id: '',
  item_id: '',
  proficiency: 'none',
  consequence_type: 'time',
  duration_class: 'brief',
  ...overrides,
})
const PASSAGE_TEXT = 'Вхожу через дверь башни внутрь маяка, следуя за найденным рычагом.'

test('заявка «войти внутрь» без подтверждённой карты уточняется до броска — MAP2-02', async () => {
  let renderCalls = 0
  const { orchestrator } = await setup(campaign(), {
    reading: passageReading(),
    // Модель описала бы вход: ей велено показать, «как герой делает заявленное».
    narrator: { render: async () => { renderCalls += 1; return { narration: 'Ада толкает дверь и оказывается внутри маяка.', provider: 'test-llm' } } },
  })
  const result = await orchestrator.handle(actionInput(PASSAGE_TEXT, 'free-passage', campaign()))

  assert.equal(result.free_action_outcome, 'clarification')
  assert.deepEqual(result.mechanics, [])
  assert.match(result.narration, /названного здания|место/u)
  assert.equal(renderCalls, 0, 'заблокированный вход не вызывает Narrator')
})

test('успешное «протиснуться внутрь» двигает героя через открытую дверь одним commit и replay — MAP2-03', async () => {
  const initial = passageCampaign('open')
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  const { orchestrator, eventStore } = await setup(initial, {
    rollRegistry: registry,
    reading: passageReading({
      goal_summary: 'Протиснуться внутрь монастыря',
      approach_summary: 'Протиснуться через открытый вход',
      obstacle: 'вход в монастырь',
    }),
  })
  const text = 'Я протискиваусь внутрь монастыря'
  const offered = await orchestrator.handle(actionInput(text, 'free-passage-move-offer', initial))
  assert.equal(offered.free_action_outcome, 'check_required')
  assert.match(offered.check.proposal.on_success, /протиснется внутрь/u)
  const issued = registry.issue({ checkId: offered.check.check_id, campaignId: 'FREE-ACTION', actorId: 'hero' })
  const verifiedRoll = registry.consume(issued.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'free-passage-move-resolve' })
  const input = { ...actionInput(text, 'free-passage-move-resolve', initial), verifiedRoll }
  const result = await orchestrator.handle(input)
  const moved = result.mechanics.find((event) => event.event_type === 'ActorMoved')
  assert.equal(result.free_action_outcome, 'check_success')
  assert.ok(moved)
  assert.deepEqual(moved.payload.to, { x: 2, y: 1 })
  assert.equal(result.ruling.world_change, true)
  assert.doesNotMatch(result.narration, /прежнем месте|сцена от этого не изменилась/u)
  assert.deepEqual((await eventStore.load('FREE-ACTION')).state.mechanics.positions.hero, { x: 2, y: 1 })
  const replay = await orchestrator.handle(input)
  assert.equal(replay.idempotent_replay, true)
  assert.deepEqual(replay.mechanics, result.mechanics)
  assert.deepEqual((await eventStore.replay('FREE-ACTION')).state, (await eventStore.load('FREE-ACTION')).state)
})

test('успешное «протиснуться внутрь» не телепортирует через закрытую дверь', async () => {
  const initial = passageCampaign('closed')
  const { orchestrator, eventStore, narratorCalls } = await setup(initial)
  const text = 'Я протискиваусь внутрь монастыря'
  const result = await orchestrator.handle(actionInput(text, 'free-passage-closed', initial))
  assert.equal(result.free_action_outcome, 'clarification')
  assert.deepEqual(result.mechanics, [])
  assert.match(result.narration, /открыт|карт/u)
  assert.equal(narratorCalls(), 0)
  assert.deepEqual((await eventStore.load('FREE-ACTION')).state.mechanics.positions.hero, { x: 0, y: 1 })
})

test('провал «протиснуться внутрь» не двигает героя даже при открытой двери', async () => {
  const initial = passageCampaign('open')
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([1]) }) })
  const { orchestrator, eventStore } = await setup(initial, {
    rollRegistry: registry,
    diceRolls: [3],
    reading: passageReading({
      goal_summary: 'Протиснуться внутрь монастыря',
      ability: 'dex', skill: 'acrobatics', activity_kind: 'stunt',
    }),
  })
  const text = 'Я протискиваусь внутрь монастыря'
  const offered = await orchestrator.handle(actionInput(text, 'free-passage-fail-offer', initial))
  const issued = registry.issue({ checkId: offered.check.check_id, campaignId: 'FREE-ACTION', actorId: 'hero' })
  const verifiedRoll = registry.consume(issued.roll_id, { campaignId: 'FREE-ACTION', actorId: 'hero', idempotencyKey: 'free-passage-fail-resolve' })
  const result = await orchestrator.handle({ ...actionInput(text, 'free-passage-fail-resolve', initial), verifiedRoll })
  assert.equal(result.free_action_outcome, 'check_failure')
  assert.equal(result.mechanics.some((event) => event.event_type === 'ActorMoved'), false)
  assert.equal(result.ruling.world_change, false)
  assert.deepEqual((await eventStore.load('FREE-ACTION')).state.mechanics.positions.hero, { x: 0, y: 1 })
})

test('название другого здания не выбирает ближайший интерьер молча', () => {
  const state = passageCampaign('open')
  state.scene.location = 'Старый трактир'
  assert.equal(freeActionPassageDestination(state, 'hero', 'Я протискиваусь внутрь монастыря', 'Протиснуться внутрь монастыря'), null)
})

test('крыльцо с interior-меткой считается внешним подходом до следующей двери', () => {
  const open = freeActionPassagePlan(porchPassageCampaign('open'), 'hero', 'Я протискиваюсь внутрь монастыря')
  assert.equal(open.status, 'ready')
  assert.equal(open.door_id, 'porch-door')
  assert.deepEqual(open.destination.to, { x: 3, y: 1 })
  const closed = freeActionPassagePlan(porchPassageCampaign('closed'), 'hero', 'Я протискиваюсь внутрь монастыря')
  assert.deepEqual(closed, { status: 'blocked', reason: 'no_open_path' })
})

test('произнесённый или вопросительный passage-текст не авторизует перемещение', () => {
  const state = passageCampaign('open')
  const goal = 'Протиснуться внутрь монастыря'
  assert.equal(freeActionPassageDestination(state, 'hero', 'Говорю: «Я протискиваюсь внутрь монастыря»', goal), null)
  assert.equal(freeActionPassageDestination(state, 'hero', 'Можно протиснуться внутрь монастыря?', goal), null)
  assert.equal(freeActionPassageDestination(state, 'hero', 'Осматриваюсь у двери', goal), null)
  assert.equal(freeActionPassageDestination(state, 'hero', 'Я протискиваюсь внутрь через окно', goal), null)
})

test('запасной рассказчик не меняет «Вышло: …» у цели без перемещения и у провала — MAP2-02', async () => {
  const shout = await setup(campaign(), {
    narrator: new Narrator(),
    reading: passageReading({ goal_summary: 'Крикнуть «Пожар!» на весь двор', approach_summary: 'во весь голос', ability: 'cha', skill: 'performance' }),
  })
  const shouted = await shout.orchestrator.handle(actionInput('Кричу «Пожар!» на весь двор', 'free-shout', campaign()))
  assert.equal(shouted.free_action_outcome, 'check_success')
  assert.match(shouted.narration, /^Вышло: крикнуть «Пожар!» на весь двор\./u)

})

test('карточка броска на перемещение сулит вход только для открытого короткого пути — MAP2-02', async () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  const initial = passageCampaign('open')
  const text = 'Я протискиваюсь внутрь монастыря'
  const { orchestrator } = await setup(initial, {
    rollRegistry: registry,
    reading: passageReading({ goal_summary: 'Протиснуться внутрь монастыря' }),
  })
  const offered = await orchestrator.handle(actionInput(text, 'free-passage-card', initial))
  assert.equal(offered.free_action_outcome, 'check_required')
  assert.match(offered.check.proposal.on_success, /протиснется внутрь/u)

  assert.equal(freeActionGoalIsPassage('Перебраться через стену во двор'), true)
  assert.equal(freeActionGoalIsPassage('Пройти мимо стражи незамеченным'), true)
  for (const goal of ['Забрать кинжал со стола', 'Пройти проверку', 'Попасть камнем в гоблина', 'Подпереть дверь скамьёй']) {
    assert.equal(freeActionGoalIsPassage(goal), false, goal)
  }
})

test('прыжок с люстры получает честный отказ без расхода хода', async () => {
  const initial = campaign({ enemies: [{ id: 'ogre', name: 'Огр', hp: 10, maxHp: 10, armor: 12, alive: true }] })
  const { orchestrator, eventStore } = await setup(initial)
  for (const [text, expected] of [
    ['Хочу вспрыгнуть с люстры и попасть по врагу во время боя', /Уточните цель действия/u],
    ['Вспрыгиваю с люстры и бью огра', /точки опоры и высоты|люстр/iu],
  ]) {
    const result = await orchestrator.handle(actionInput(text, text, initial))
    assert.equal(result.free_action_outcome, undefined)
    assert.match(result.narration, expected)
    assert.deepEqual(result.mechanics, [])
    assert.equal(result.turn_consumed, false)
  }
  assert.equal((await eventStore.load('FREE-ACTION')).state_version, 0)
})

test('разбор сохраняет обычную атаку и отличает составной манёвр', async () => {
  const parser = new IntentParser()
  const parse = (message) => parser.parse({ message, playerId: 'hero', visibleState: campaign() })
  assert.equal((await parse('Бью огра')).intent, 'attack')
  assert.equal((await parse('Вспрыгиваю с люстры и бью огра')).intent, 'compound_maneuver')
  assert.equal((await parse('Вспрыгиваю с люстры и бью огра')).free_action_kind, 'compound_maneuver')
  assert.equal((await parse('Прыгаю через канаву')).free_action_kind, null)
})

test('дефисное имя врага сохраняет номер и не смешивает двух одинаковых гоблинов', async () => {
  const parser = new IntentParser()
  const visibleState = {
    players: [{ id: 'hero', character: 'Ада' }],
    enemies: [
      { id: 'enemy1', name: 'Гоблин-воин 1' },
      { id: 'enemy2', name: 'Гоблин-воин 2' },
    ],
  }
  const selected = await parser.parse({
    message: 'Прыгаю вперёд и бью гоблина-воина 1 длинным мечом',
    playerId: 'hero', visibleState,
  })
  assert.deepEqual(selected.targets, ['enemy1'])
  assert.equal(selected.requires_clarification, false)

  const missingNumber = await parser.parse({
    message: 'Прыгаю вперёд и бью гоблина-воина длинным мечом',
    playerId: 'hero', visibleState,
  })
  assert.deepEqual(missingNumber.targets, [])
  assert.deepEqual(missingNumber.missing_information, ['target_id'])
  assert.equal(missingNumber.requires_clarification, true)
})
