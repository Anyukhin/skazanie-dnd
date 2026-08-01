import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { buildNarrationBrief, verifyNarration } from '../server/security.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

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

async function setup(initialState = campaign(), { rollRegistry = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-free-action-'))
  const dice = new DiceService({ rng: new SequenceDiceRng([18, 3, 18, 3, 18, 3, 18, 3]), idFactory: (() => { let id = 0; return () => `free-roll-${++id}` })() })
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    idFactory: (() => { let id = 0; return () => `free-event-${++id}` })(),
  })
  const rulesEngine = new RulesEngine({ diceService: dice })
  let narratorCalls = 0
  const orchestrator = new GameOrchestrator({
    rulesEngine,
    eventStore,
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Свободное действие не должно вызывать Narrator') } },
    rollRegistry,
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
    ['ActionDeclared', 'AbilityCheckResolved', 'RulingRecorded', 'TimeAdvanced', 'ObjectiveUpdated'])
  assert.equal(result.ruling.status, 'applied')
  assert.equal(result.ruling.world_change, true)
  assert.equal(result.stakes.difficulty, 15)
  assert.equal(result.stakes.ability, 'str')
  assert.ok(result.stakes.on_failure.length > 0)
  assert.match(result.authoritative_state.scene.objective, /баррикад|дверь/u)
  assert.match(result.narration, /Следующая цель отряда/u)
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
  assert.match(invited.narration, /Бросьте d20/u)
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

test('без manualRoll свободное действие разрешается прежним серверным броском', async () => {
  const registry = new RollRegistry({
    diceService: new DiceService({ rng: new SequenceDiceRng([9]), idFactory: () => 'manual-roll-x' }),
  })
  const { orchestrator } = await setup(campaign(), { rollRegistry: registry })
  const result = await orchestrator.handle(actionInput('Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи', 'free-auto-1', campaign()))
  assert.equal(result.free_action_outcome, 'check_success')
  assert.ok(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'))
})
