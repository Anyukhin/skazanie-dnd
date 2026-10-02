// Маршрутизация свободного текста игрока: какой путь сервера выбирает реплика.
// Сторожится детерминированный слой (`inferRequestKind` → карточка ухода →
// `IntentParser`) и маршрут судьи свободных действий (action_adjudicator/v7),
// который ничего не коммитит, а только возвращает заявку в существующие пути.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { interpretFreeAction } from '../server/free-action-adjudication.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { IntentParser, inferRequestKind } from '../server/intent-parser.mjs'
import { classifyPartyDecision, detectPartyExitRequest, exitContextFromState, travelDestinationIsPlace } from '../server/party-exit-intent.mjs'
import { proposeRoutedTravel } from '../server/player-request-router.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { GOLD_ROUTES, fixtureState, routeDeterministic, runDeterministic } from '../eval/intent-routing-eval-2026-10-01.mjs'

const cases = JSON.parse(readFileSync(new URL('../eval/intent-routing-cases-2026-10-01.json', import.meta.url), 'utf8')).cases

test('набор реплик: детерминированный слой не уводит из сцены и узнаёт уход по карте мира', async () => {
  const results = await runDeterministic(cases)
  const correct = results.filter((row) => row.correct).length
  // Порог ниже текущего результата (135 из 136) с запасом на одну-две
  // осознанные правки эталона; падение ниже — регресс маршрутизации.
  assert.ok(correct / results.length >= 0.95, `точность ${correct}/${results.length}`)
  // Ложный уход дороже пропуска: он подменяет ход героя голосованием отряда.
  assert.deepEqual(results.filter((row) => row.predicted === 'travel_exit' && row.gold !== 'travel_exit').map((row) => row.text), [])
  for (const row of results) assert.ok(GOLD_ROUTES[row.gold], row.id)
})

test('живой провал 2026-10-01 и его соседи разбираются как уход', async () => {
  for (const text of [
    'Иду в таверну «Морской Змей» расспрашивать о сыне Финна',
    'Иду в Каменный Град',
    'Добираемся до Каменного Града',
    'Двигаемся к Мглистым Топям',
    'иду в тавернку морской змей',
    'Я иду искать сына Финна в Пепельный Лес',
    'Давайте пойдём в порт',
    'Покидаем Ржавый Якорь',
    'Уходим.',
  ]) {
    assert.equal((await routeDeterministic(text)).route, 'travel_exit', text)
  }
})

test('шаг внутри сцены и подстроки-ловушки не становятся уходом', () => {
  const context = exitContextFromState(fixtureState())
  for (const text of [
    'Иду в дальний угол таверны',
    'Иду к трактирщице',
    'Иду к хозяйке таверны',
    // `лес\w*` раньше находил «лес» в «лестнице» и «лесничему».
    'Иду к старой лестнице в подвал',
    'Иду к лесничему у камина',
    'Возвращаюсь на своё место у стола',
    'Иду в другой конец таверны',
    'Иду к Марте',
    'Уходим в тень',
  ]) {
    assert.equal(detectPartyExitRequest(text, context), null, text)
  }
  // Имя присутствующего — собственное слово, а не «старый» из «Старого Финна».
  assert.ok(detectPartyExitRequest('Идём в старую крепость', context))
})

test('название точки карты узнаётся в падеже, а родовое слово не спорит с картой', () => {
  const context = exitContextFromState(fixtureState())
  assert.equal(detectPartyExitRequest('Иду в Солеварню', context)?.destination, 'Солеварню')
  assert.ok(detectPartyExitRequest('Выдвигаемся к Северному форту', context))
  // Без контекста имени карты не знает никто: «Солеварня» не родовое слово.
  assert.equal(detectPartyExitRequest('Иду в Солеварню'), null)
  // Скрытая точка карты не узнаётся — фраза не работает оракулом.
  assert.equal(detectPartyExitRequest('Иду в Ведьмину Падь', context), null)
  assert.equal(context.knownPlaces.includes('Ведьмина Падь'), false)
  // Прямые кавычки сразу после предлога — тоже название места.
  assert.deepEqual(detectPartyExitRequest('Отправляемся в "Морской Змей"'), { destination: 'Морской Змей', source: 'text' })
})

test('подпись варианта голосования по-прежнему разбирается как уход', () => {
  const card = proposeRoutedTravel({ route: 'travel', destination: 'Каменный Град' }, fixtureState())
  assert.equal(card.type, 'vote')
  assert.equal(classifyPartyDecision(card.options[0]).kind, 'move')
  assert.equal(classifyPartyDecision(card.options[0]).destinationHint, 'Каменный Град')
  assert.equal(classifyPartyDecision(card.options.at(-1)).kind, 'stay')
})

test('вид реплики: вопрос, вне игры и обсуждение отряда отделены от заявки', () => {
  assert.equal(inferRequestKind('Где находится таверна «Морской Змей»?'), 'question')
  assert.equal(inferRequestKind('Какое сейчас время суток?'), 'question')
  assert.equal(inferRequestKind('(ooc) мне надо отойти'), 'discussion')
  assert.equal(inferRequestKind('((сделаю чай))'), 'discussion')
  assert.equal(inferRequestKind('Ребята, я за то, чтобы сначала выспаться'), 'discussion')
  assert.equal(inferRequestKind('Торвальд, ты со мной?'), 'discussion')
  // Предложение пойти — заявка: её рассудит карточка ухода.
  assert.equal(inferRequestKind('Давайте пойдём в порт'), 'action')
  assert.equal(inferRequestKind('Может, нам стоит вернуться в Аквилон?'), 'action')
  // Обращение на «ты» — реплика собеседнику, а не вопрос ведущему.
  assert.equal(inferRequestKind('Где ты последний раз видел сына?'), 'action')
  // Вопрос о знаниях героя Хранитель мира закрывает прямо в ходе.
  assert.equal(inferRequestKind('Что мы знаем о Храме Приливов?'), 'action')
  assert.equal(inferRequestKind('Узнаю у Марты, не видела ли она сына'), 'action')
})

test('разбор намерения: разговор, заклинание и ложные срабатывания подстрок', async () => {
  const parser = new IntentParser()
  const state = fixtureState()
  const intentOf = async (message) => (await parser.parse({ message, playerId: 'hero-1', visibleState: state })).intent
  for (const text of ['Разговариваю с Борисом о патрулях', 'Узнаю у Марты, не видела ли она сына Финна', 'Здороваюсь с Финном', 'Покупаю у Ильсы моток верёвки']) {
    assert.equal(await intentOf(text), 'social', text)
  }
  // «вручаю» содержит «вру», «долгую» — «лгу»: это не Обман.
  assert.notEqual(await intentOf('Вручаю Марте письмо от Финна'), 'social')
  assert.equal(await intentOf('Делаем долгую передышку перед дорогой'), 'rest')
  assert.equal(await intentOf('Колдую Волшебную стрелу в крысу'), 'cast_spell')
  assert.equal(await intentOf('Накладываю на Финна заклинание Лечение ран'), 'cast_spell')
  assert.equal(await intentOf('Бью кулаком по столу, чтобы все замолчали'), 'improvised_action')
  assert.equal(await intentOf('Бью стражника кулаком'), 'attack')
  assert.equal(await intentOf('Прислушиваюсь к разговору за соседним столом'), 'ability_check')
  // Инфинитив — команда пропса сцены на пути свободного действия; проверкой
  // навыка её перехватывать нельзя.
  assert.equal(await intentOf('Обыскать сундук'), 'improvised_action')
  assert.equal(await intentOf('Хочу отдохнуть на кровати'), 'improvised_action')
})

// ---------- маршрут судьи (action_adjudicator/v7) ----------

const reading = {
  goal_summary: 'Добраться до места', approach_summary: 'Пешком', obstacle: 'дорога',
  activity_kind: 'routine', duration_class: 'brief', ability: 'wis', skill: 'survival',
  plausibility: 'plausible', risk: 'minor', required_means: [], action_cost: 'action',
  effect: 'none', effect_target: '', hazard: '', prop_id: '', target_id: '', item_id: '',
  proficiency: 'none', consequence_type: 'time',
}

function adjudicatorState() {
  const fixture = fixtureState()
  return normalizeCampaignState({
    ...fixture,
    players: [{ id: 'hero-1', character: 'Эйра', hp: 10, maxHp: 10, armor: 12, x: 0, y: 0, abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 12, cha: 12 }, inventory: [] }],
  })
}

const stub = (payload) => new ActionAdjudicator({ llmClient: { completeJson: async () => payload } })

test('v7: маршрут и пункт назначения проходят строгую сверку', async () => {
  const state = adjudicatorState()
  const text = 'Хочу наведаться туда, где делают соль'
  const travel = await stub({ ...reading, route: 'travel', destination: '«Солеварня» [карта]', npc_hint: '' })
    .read(state, 'hero-1', text, interpretFreeAction(text))
  assert.equal(travel.route, 'travel')
  assert.equal(travel.destination, 'Солеварня карта')
  assert.equal(travel.source, 'agent-adjudicator')

  // npc_hint — только id присутствующего NPC из брифа.
  const talk = await stub({ ...reading, route: 'talk', npc_hint: 'npc:ghost' }).read(state, 'hero-1', text, interpretFreeAction(text))
  assert.equal(talk.route, 'talk')
  assert.equal(talk.npc_hint, '')
  const marta = await stub({ ...reading, route: 'talk', npc_hint: 'npc:marta' }).read(state, 'hero-1', text, interpretFreeAction(text))
  assert.equal(marta.npc_hint, 'npc:marta')

  // Выдуманный маршрут — сломанный ответ: детерминированный разбор вместо него.
  const broken = await stub({ ...reading, route: 'teleport' }).read(state, 'hero-1', text, interpretFreeAction(text))
  assert.equal(broken.route, undefined)
  assert.match(String(broken.source), /after-agent-error/u)

  // Ответ в форме v6 остаётся допустимым и судится как проверка.
  const legacy = await stub(reading).read(state, 'hero-1', text, interpretFreeAction(text))
  assert.equal(legacy.route, undefined)
  assert.equal(legacy.source, 'agent-adjudicator')
})

test('карточка по маршруту судьи: место проверяется словарём, занятый стол не перебивается', () => {
  const state = fixtureState()
  assert.equal(proposeRoutedTravel({ route: 'travel', destination: 'угол таверны' }, state), null)
  assert.equal(proposeRoutedTravel({ route: 'travel', destination: 'Марта' }, state), null)
  assert.equal(proposeRoutedTravel({ route: 'travel', destination: 'Каменный Град' }, { ...state, agentInteraction: { id: 'open' } }), null)
  assert.equal(proposeRoutedTravel({ route: 'talk', destination: 'Каменный Град' }, state), null)
  const leave = proposeRoutedTravel({ route: 'travel', destination: '' }, state)
  assert.equal(leave.options[0], 'Покинуть «Таверна «Ржавый Якорь»»')
  assert.equal(travelDestinationIsPlace('таверна «Морской Змей»', exitContextFromState(state)), true)
})

test('место из цели сцены открывает голосование без «бросаем задание»', () => {
  // Живой прогон 2026-10-02: «Идём к смотровой дамбе» при цели «Добраться до
  // смотровой дамбы» отвечало «напишите «Отправляемся в…»», а голосование
  // предлагало уйти туда, бросив то самое задание.
  const base = fixtureState()
  const state = { ...base, scene: { ...base.scene, objective: 'Добраться до смотровой дамбы и понять источник звона' } }
  const card = proposeRoutedTravel({ route: 'travel', destination: 'смотровая дамба' }, state, 'Идём к смотровой дамбе')
  assert.equal(card?.type, 'vote')
  assert.equal(card.options.some((option) => /бросаем задание/u.test(option)), false)
  assert.equal(classifyPartyDecision(card.options[0]).kind, 'move')
  // Слово цели без места — по-прежнему не пункт назначения.
  assert.equal(proposeRoutedTravel({ route: 'travel', destination: 'источник звона у камина' }, state), null)
  // Текущее место, даже если цель его называет, уходом не становится.
  const here = { ...state, scene: { ...state.scene, location: 'Смотровая дамба', objective: 'Удержать смотровую дамбу' } }
  assert.equal(proposeRoutedTravel({ route: 'travel', destination: 'смотровая дамба' }, here), null)
})

async function orchestratorWith(read, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-intent-routing-'))
  const initialState = normalizeCampaignState({
    ...fixtureState(),
    sessionCode: 'ROUTING',
    players: [{ id: 'hero-1', character: 'Эйра', name: 'Эйра', hp: 10, maxHp: 10, armor: 12, abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 12, cha: 12 }, inventory: [] }],
    ...overrides,
  })
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
    idFactory: (() => { let id = 0; return () => `routing-event-${++id}` })(),
  })
  const orchestrator = new GameOrchestrator({
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([10, 10, 10]) }) }),
    eventStore,
    narrator: { render: async () => { throw new Error('маршрут не рассказывается') } },
    idFactory: (() => { let id = 0; return () => `routing-turn-${++id}` })(),
  })
  orchestrator.unknownActionHandler.actionAdjudicator = { read }
  await eventStore.initializeCampaign({ campaign_id: 'ROUTING', initial_state: initialState })
  const handle = (message, idempotencyKey) => orchestrator.handle({
    state: initialState, campaignId: 'ROUTING', playerId: 'hero-1', allowedActorIds: ['hero-1'], message, idempotencyKey,
  })
  return { orchestrator, eventStore, handle }
}

test('маршрут travel ничего не коммитит и отдаёт пункт назначения ровно один раз', async () => {
  const { orchestrator, eventStore, handle } = await orchestratorWith(async () => ({ ...reading, route: 'travel', destination: 'Каменный Град' }))
  const before = (await eventStore.load('ROUTING')).state_version
  const text = 'Хочу наведаться к каменщикам на север'
  const result = await handle(text, 'route-travel-1')
  assert.equal(result.free_action_outcome, 'route_travel')
  assert.deepEqual(result.mechanics, [])
  assert.equal(result.check, undefined)
  assert.match(result.narration, /Каменный Град/u)
  assert.match(result.narration, /голосованием/u)
  assert.equal((await eventStore.load('ROUTING')).state_version, before)
  assert.deepEqual(orchestrator.unknownActionHandler.takeRouteHint('ROUTING', 'route-travel-1'), { route: 'travel', destination: 'Каменный Град', actor_id: 'hero-1' })
  assert.equal(orchestrator.unknownActionHandler.takeRouteHint('ROUTING', 'route-travel-1'), null)
})

test('маршрут talk и clarify переспрашивают без проверки навыка', async () => {
  const talk = await orchestratorWith(async () => ({ ...reading, route: 'talk', npc_hint: 'npc:marta' }))
  const spoken = await talk.handle('Хочу выведать у хозяйки, кто тут чужой', 'route-talk-1')
  assert.equal(spoken.free_action_outcome, 'clarification')
  assert.equal(spoken.check, undefined)
  assert.match(spoken.narration, /«Марта, …»/u)
  assert.ok(spoken.clarification)

  const clarify = await orchestratorWith(async () => ({ ...reading, route: 'clarify' }))
  const unclear = await clarify.handle('Ну и что теперь будем делать', 'route-clarify-1')
  assert.equal(unclear.free_action_outcome, 'clarification')
  assert.equal(unclear.check, undefined)
  assert.deepEqual(unclear.mechanics, [])
})

test('в бою маршрут travel не предлагается: заявка судится как обычная попытка', async () => {
  const { orchestrator, handle } = await orchestratorWith(async () => ({ ...reading, route: 'travel', destination: 'Каменный Град' }), {
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero-1' }], action_economy: { 'hero-1': { action: true, bonus_action: true, movement: true } } } },
  })
  const result = await handle('Хочу наведаться к каменщикам на север', 'route-combat-1')
  assert.notEqual(result.free_action_outcome, 'route_travel')
  assert.equal(orchestrator.unknownActionHandler.takeRouteHint('ROUTING', 'route-combat-1'), null)
})
