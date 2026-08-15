import assert from 'node:assert/strict'
import test from 'node:test'

import { suggestedActionsFor } from '../server/action-hints.mjs'
import {
  BEAST_APPROACH_MINUTES,
  BEAST_APPROACH_REACH_FEET,
  BEAST_SCARE_COOLDOWN_MINUTES,
  beastChallengeRating,
  beastDietFor,
  beastFoodItemFor,
  beastIdFor,
  beastList,
  beastScareLine,
  beastTamingPolicy,
  beastWatchSwing,
  beastsForViewer,
  isTameableBeast,
  normalizeBeastState,
  tameableBeasts,
} from '../server/beast-taming.mjs'
import { isSkillProficient, normalizedClassSkillProficiencies, skillAbility } from '../server/character-progression.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import {
  normalizeCampaignState,
  previewD20Check,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const GLADE = 'Волчья прогалина'

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

function ration(quantity = 2) {
  return {
    id: 'item-rations',
    catalog_id: 'srd_5_2_1:rations-one-day',
    name: 'Сухой паёк, 1 день',
    type: 'consumable',
    quantity,
    weight: 2,
  }
}

/**
 * Волк стоит вплотную к герою (1,1) намеренно: уговор и кормление требуют
 * протянутой руки, и сцена по умолчанию — та, в которой к зверю уже подошли.
 * Дальний волк заводится точечно, в тесте про досягаемость.
 */
function wolf(id = 'enemy-wolf', overrides = {}) {
  return {
    id,
    name: 'Волк 1',
    hp: 11,
    maxHp: 11,
    armor: 12,
    creature_type: 'beast',
    stat_block_id: 'srd_5_2_1:wolf',
    provenance: { challenge_rating: '1/4', xp: 50 },
    x: 2,
    y: 1,
    alive: true,
    ...overrides,
  }
}

function boar(id = 'enemy-boar', overrides = {}) {
  return {
    id,
    name: 'Гигантский кабан 1',
    hp: 42,
    maxHp: 42,
    armor: 13,
    creature_type: 'beast',
    stat_block_id: 'srd_5_2_1:giant-boar',
    provenance: { challenge_rating: '2', xp: 450 },
    x: 2,
    y: 2,
    alive: true,
    ...overrides,
  }
}

/**
 * Прогалина после боя: волк цел и стоит рядом, боя нет. Всё остальное
 * (мораль, рана, бой) добавляется точечно в самих тестах.
 */
function campaign({
  minutes = 0,
  enemies = [wolf()],
  conditions = {},
  combatActive = false,
  inventory = [ration()],
  beasts = undefined,
  resting = {},
  scene = {},
} = {}) {
  return normalizeCampaignState({
    sessionCode: 'BEAST',
    campaign: 'Волк у костра',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: {
      title: 'Прогалина',
      location: GLADE,
      location_id: 'glade',
      grid: { width: 6, height: 6 },
      cells: cells(),
      ...scene,
    },
    players: [{
      id: 'hero',
      character: 'Ловчий Влад',
      hp: 14,
      maxHp: 14,
      x: 1,
      y: 1,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 16, cha: 10 },
      proficiency: 2,
      backgroundSkillProficiencies: ['animal_handling'],
      inventory,
    }],
    worldMap: {
      seed: 'beast-seed',
      locations: [
        { id: 'glade', name: GLADE, kind: 'wilderness', x: 100, y: 100 },
        { id: 'village', name: 'Тихий Брод', kind: 'village', x: 130, y: 100 },
      ],
      routes: [],
    },
    enemies,
    ...(beasts ? { beasts } : {}),
    mechanics: {
      world_time: { elapsed_minutes: minutes },
      combat: combatActive
        ? { active: true, round: 2, initiative: [{ actor_id: 'hero', total: 15 }], active_index: 0, action_economy: {} }
        : { active: false },
      conditions,
      resting,
    },
  })
}

function run(state, command, { rng = [], context = {} } = {}) {
  return resolveCommands([{
    command_id: 'cmd-beast',
    campaign_id: 'BEAST',
    actor_id: 'hero',
    ...command,
  }], state, { diceService: dice(rng), context: { allowedActorIds: ['hero'], ...context } })
}

function beastId(state, actorId = 'enemy-wolf') {
  return beastIdFor(state, actorId)
}

// ---------------------------------------------------------------------------
// Кого можно уговаривать и по какой СЛ
// ---------------------------------------------------------------------------

test('приручаемость закрыта списком, а не типом существа', () => {
  assert.equal(isTameableBeast(wolf()), true)
  assert.equal(beastDietFor(wolf()), 'predator')
  assert.equal(beastDietFor(boar()), 'herbivore')
  // Формально `beast`, но с руки его не кормят.
  assert.equal(isTameableBeast({ creature_type: 'beast', stat_block_id: 'srd_5_2_1:giant-spider' }), false)
  // Человек и нежить сюда не попадают вовсе.
  assert.equal(isTameableBeast({ creature_type: 'humanoid', stat_block_id: 'srd_5_2_1:bandit' }), false)
})

test('CR читается и дробью, и целым числом', () => {
  assert.equal(beastChallengeRating(wolf()), 0.25)
  assert.equal(beastChallengeRating(boar()), 2)
  assert.equal(beastChallengeRating({}), 0)
})

test('СЛ честно разная: хищник дороже травоядного, раненый — целого', () => {
  const state = campaign({ enemies: [wolf(), boar()] })
  const wholeWolf = beastTamingPolicy(state, wolf()).difficulty
  const wholeBoar = beastTamingPolicy(state, boar()).difficulty
  const hurtWolf = beastTamingPolicy(state, wolf('enemy-wolf', { hp: 4 })).difficulty
  // Волк CR 1/4 хищник: 10 + 0 + 3 = 13. Кабан CR 2 травоядный: 10 + 5 = 15.
  assert.equal(wholeWolf, 13)
  assert.equal(wholeBoar, 15)
  // Раненый пугливее целого — ровно на объявленную поправку.
  assert.equal(hurtWolf, wholeWolf + 2)
  // Хищник дороже травоядного при равном CR: сравниваем сдвиг, а не итог.
  const predatorShift = beastTamingPolicy(state, wolf()).parts.find((part) => part.id === 'predator')
  assert.equal(predatorShift.shift, 3)
  assert.equal(beastTamingPolicy(state, boar()).parts.some((part) => part.id === 'predator'), false)
})

test('сломленная мораль и еда с руки снижают СЛ, неудачи её поднимают', () => {
  const fled = campaign({ conditions: { 'enemy-wolf': [{ id: 'fled' }] } })
  assert.equal(beastTamingPolicy(fled, wolf()).difficulty, 11)
  const state = campaign()
  const fedPolicy = beastTamingPolicy(state, wolf(), { stage: 'fed', attempts: 0, diet: 'predator' })
  assert.equal(fedPolicy.difficulty, 9)
  assert.equal(fedPolicy.stage_after, 'tamed')
  // Потолок прибавки за неудачи не даёт скатиться в тупик.
  assert.equal(beastTamingPolicy(state, wolf(), { stage: 'wary', attempts: 9, diet: 'predator' }).difficulty, 16)
})

test('в бою зверя не уговаривают, пока не сломается мораль', () => {
  const fighting = campaign({ combatActive: true })
  assert.equal(tameableBeasts(fighting)[0].blocked_reason, 'combat_active')
  const broken = campaign({ combatActive: true, conditions: { 'enemy-wolf': [{ id: 'fled' }] } })
  assert.equal(broken.mechanics.combat.active, true)
  assert.equal(tameableBeasts(broken)[0].blocked_reason, null)
  // Мёртвого зверя не приручают.
  const dead = campaign({ enemies: [wolf('enemy-wolf', { hp: 0, alive: false })] })
  assert.equal(tameableBeasts(dead)[0].blocked_reason, 'beast_down')
})

test('команда отказывается, пока зверь дерётся, и проходит после морали', () => {
  const fighting = campaign({ combatActive: true })
  assert.throws(
    () => run(fighting, { command_type: 'CalmBeast', beast_id: beastId(fighting) }, { rng: [15] }),
    (error) => error.code === 'BEAST_DURING_COMBAT',
  )
  const broken = campaign({ combatActive: true, conditions: { 'enemy-wolf': [{ id: 'fled' }] } })
  const result = run(broken, { command_type: 'CalmBeast', beast_id: beastId(broken) }, { rng: [18] })
  assert.equal(result.events.some((event) => event.event_type === 'BeastSoothingResolved'), true)
  // Посреди боя уговор стоит действия — тем же правилом, что и окрик о
  // переговорах. Вне боя цены нет.
  const spent = result.events.find((event) => event.event_type === 'CombatActionUsed')
  assert.equal(spent?.payload.action_id, 'calm-beast')
  const peaceful = campaign()
  assert.equal(
    run(peaceful, { command_type: 'CalmBeast', beast_id: beastId(peaceful) }, { rng: [18] })
      .events.some((event) => event.event_type === 'CombatActionUsed'),
    false,
  )
})

test('в бою уговор и кормление стоят действия: лестница в один ход не укладывается', () => {
  // Обещанное правило было реализовано наполовину: резолв помечал действие
  // потраченным (`CombatActionUsed`), но экономику никто не проверял — и весь
  // подход (уговор → корм → уговор) проходил одним ходом бесплатно.
  const broken = campaign({ combatActive: true, conditions: { 'enemy-wolf': [{ id: 'fled' }] } })
  const missed = run(broken, { command_type: 'CalmBeast', beast_id: beastId(broken) }, { rng: [1, 3] })
  assert.equal(missed.state.mechanics.combat.action_economy.hero.action, false, 'уговор обязан потратить действие')
  assert.throws(
    () => run(missed.state, { command_type: 'CalmBeast', beast_id: beastId(missed.state), command_id: 'cmd-again' }, { rng: [18] }),
    (error) => error.code === 'ACTION_SPENT',
  )
  // Кормление платит тем же слотом: протянуть зверю паёк посреди боя — это ход.
  const calmed = run(broken, { command_type: 'CalmBeast', beast_id: beastId(broken), command_id: 'cmd-calm' }, { rng: [18] })
  assert.equal(calmed.state.mechanics.combat.action_economy.hero.action, false)
  assert.throws(
    () => run(calmed.state, { command_type: 'FeedBeast', beast_id: beastId(calmed.state), command_id: 'cmd-feed' }),
    (error) => error.code === 'ACTION_SPENT',
  )
})

test('вне боя попытка уговора стоит игрового времени, а не действия', () => {
  // Провал у травоядного не стоит ничего, а прибавка за неудачи упирается в
  // потолок: без цены приручение было формальностью — жать кнопку, пока не
  // выпадет. Платит мир, тем же путём, что круг за костями и письмо.
  const state = campaign()
  const attempt = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [1, 2] })
  const advanced = attempt.events.find((event) => event.event_type === 'TimeAdvanced')
  assert.ok(advanced, 'попытка вне боя обязана сдвинуть часы мира')
  assert.equal(advanced.payload.elapsed_minutes, BEAST_APPROACH_MINUTES)
  assert.equal(attempt.state.mechanics.world_time.elapsed_minutes, BEAST_APPROACH_MINUTES)
  // В бою минут не тратят: раунд длится шесть секунд, и там цена — действие.
  const broken = campaign({ combatActive: true, conditions: { 'enemy-wolf': [{ id: 'fled' }] } })
  const fighting = run(broken, { command_type: 'CalmBeast', beast_id: beastId(broken) }, { rng: [18] })
  assert.equal(fighting.events.some((event) => event.event_type === 'TimeAdvanced'), false)
})

test('до зверя нужно дойти: уговор и корм требуют вытянутой руки', () => {
  // Прецедент в проекте один и тот же у двери, объекта сцены и лестницы:
  // встать вплотную. Без него зверя уводили с собой через полкарты, ни разу к
  // нему не подойдя, а укус при провале летел герою на четыре клетки.
  const far = campaign({ enemies: [wolf('enemy-wolf', { x: 5, y: 5 })] })
  assert.throws(
    () => run(far, { command_type: 'CalmBeast', beast_id: beastId(far) }, { rng: [18] }),
    (error) => error.code === 'BEAST_OUT_OF_REACH',
  )
  const farId = beastId(far)
  const calmedFar = campaign({
    enemies: [wolf('enemy-wolf', { x: 5, y: 5 })],
    beasts: {
      beasts: [{
        id: farId, actor_id: 'enemy-wolf', name: 'Волк 1', diet: 'predator', stage: 'calmed', status: 'wild',
      }],
    },
  })
  assert.throws(
    () => run(calmedFar, { command_type: 'FeedBeast', beast_id: farId, command_id: 'cmd-feed-far' }),
    (error) => error.code === 'BEAST_OUT_OF_REACH',
  )
  // Панель не прячет такого зверя, а гасит его и называет расстояние.
  const distant = beastsForViewer(far, {}).candidates[0]
  assert.equal(distant.out_of_reach, true)
  assert.equal(distant.distance_feet, 20)
  assert.equal(distant.reach_feet, BEAST_APPROACH_REACH_FEET)
  assert.equal(distant.blocked_reason, undefined, 'карточка обязана остаться на панели')
  // Подсказка зовёт подойти, а не молчит о звере.
  const hints = suggestedActionsFor(campaignStateForViewer(far, { role: 'player' }, 'hero'))
  assert.ok(hints.some((hint) => hint.text.includes('подойти вплотную')), JSON.stringify(hints))
  // Вплотную — можно, и это тот же зверь.
  const near = beastsForViewer(campaign(), {}).candidates[0]
  assert.equal(near.out_of_reach, false)
  assert.equal(near.distance_feet, 5)
})

test('CR стат-блока не уезжает игроку слагаемым СЛ ни одним из двух каналов', () => {
  // Опознание врага закрыто знанием отряда (`publicEnemyFor`), и приручение не
  // имеет права быть дверью в обход него. Метка «сила зверя (CR 1/4)» была
  // сырой строкой провенанса и пробивала контракт сразу двумя путями.
  const state = campaign()
  const challenge = beastTamingPolicy(state, wolf()).parts.find((part) => part.id === 'challenge')
  assert.equal(challenge.label, 'сила зверя')
  const result = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [1, 2] })
  const leaks = (parts) => parts.filter((part) => /CR/u.test(part.label) || part.label.includes('1/4'))
  // Канал первый: проекция состояния.
  const room = campaignStateForViewer(result.state, { role: 'player' }, 'hero')
  assert.deepEqual(leaks(room.beasts.candidates[0].parts), [])
  // Канал второй: событие уговора — его санитайзер не трогал вовсе.
  const resolved = result.events.find((event) => event.event_type === 'BeastSoothingResolved')
  const projected = mechanicsForViewer([resolved], { role: 'player', heroIds: ['hero'] }, 'hero', result.state)[0]
  assert.deepEqual(leaks(projected.payload.difficulty_parts), [])
  assert.equal(projected.payload.challenge_rating, undefined)
  // Слагаемое при этом остаётся числом: игрок обязан видеть, из чего СЛ.
  assert.equal(room.beasts.candidates[0].parts.find((part) => part.id === 'challenge').shift, 0)
})

test('карточка уговора исполняется только против объявленной СЛ', () => {
  // Сторож двух фаз сверял ступень, но СЛ едет ещё от раны, морали и числа
  // неудач: карточка, объявившая 13, исполнялась против 14 на той же ступени.
  const guard = Object.create(GameOrchestrator.prototype)
  const state = campaign()
  const id = beastId(state)
  const declared = beastTamingPolicy(state, wolf()).difficulty
  const card = { kind: 'beast-taming', beast_id: id, stage: 'wary', difficulty: declared }
  assert.doesNotThrow(() => guard.assertBeastRollContext(state, { beast_id: id }, card))
  const missed = run(state, { command_type: 'CalmBeast', beast_id: id }, { rng: [1, 2] }).state
  assert.equal(beastList(missed)[0].stage, 'wary', 'ступень обязана остаться прежней')
  assert.equal(beastTamingPolicy(missed, missed.enemies[0], beastList(missed)[0]).difficulty, declared + 1)
  assert.throws(
    () => guard.assertBeastRollContext(missed, { beast_id: id }, card),
    (error) => error.code === 'ROLL_CONTEXT_MISMATCH',
  )
  // Чужой бросок и чужой зверь отказываются тем же кодом.
  assert.throws(
    () => guard.assertBeastRollContext(state, { beast_id: id }, { ...card, kind: 'parley' }),
    (error) => error.code === 'ROLL_CONTEXT_MISMATCH',
  )
  assert.throws(
    () => guard.assertBeastRollContext(state, { beast_id: id }, { ...card, beast_id: 'beast:other' }),
    (error) => error.code === 'ROLL_CONTEXT_MISMATCH',
  )
})

// ---------------------------------------------------------------------------
// Лестница: успокоен → накормлен → приручён
// ---------------------------------------------------------------------------

test('удачный уговор заводит запись и переводит зверя в «успокоен»', () => {
  const state = campaign()
  const result = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [18] })
  const encountered = result.events.find((event) => event.event_type === 'BeastEncountered')
  assert.ok(encountered, 'первый подход обязан завести запись реестра')
  const resolved = result.events.find((event) => event.event_type === 'BeastSoothingResolved')
  assert.equal(resolved.payload.success, true)
  assert.equal(resolved.payload.stage_before, 'wary')
  assert.equal(resolved.payload.stage_after, 'calmed')
  assert.equal(resolved.payload.difficulty, 13)
  const beast = beastList(result.state)[0]
  assert.equal(beast.stage, 'calmed')
  assert.equal(beast.status, 'wild')
  assert.equal(beast.diet, 'predator')
})

test('провал у хищника стоит укуса, у травоядного — нет', () => {
  const state = campaign()
  // 1 на d20 — провал против СЛ 13; следом кость укуса.
  const bitten = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [1, 3] })
  const bite = bitten.events.find((event) => event.event_type === 'BeastBit')
  assert.ok(bite, 'хищник при провале обязан укусить')
  assert.equal(bite.payload.expression, '1d4')
  const damage = bitten.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(damage, 'укус обязан пройти обычным путём урона')
  assert.equal(bitten.state.players[0].hp < 14, true)
  assert.equal(beastList(bitten.state)[0].bites, 1)
  assert.equal(beastList(bitten.state)[0].attempts, 1)

  const herbivore = campaign({ enemies: [boar()] })
  const missed = run(herbivore, { command_type: 'CalmBeast', beast_id: beastId(herbivore, 'enemy-boar') }, { rng: [1] })
  assert.equal(missed.events.some((event) => event.event_type === 'BeastBit'), false)
  assert.equal(missed.state.players[0].hp, 14)
})

test('кормление списывает паёк и требует успокоенного зверя', () => {
  const state = campaign()
  const calmed = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [18] }).state
  const fed = run(calmed, { command_type: 'FeedBeast', beast_id: beastId(calmed), command_id: 'cmd-feed' })
  const fedEvent = fed.events.find((event) => event.event_type === 'BeastFed')
  assert.equal(fedEvent.payload.item_name, 'Сухой паёк, 1 день')
  assert.equal(fed.events.some((event) => event.event_type === 'ItemConsumed'), true)
  assert.equal(fed.state.players[0].inventory[0].quantity, 1, 'паёк обязан списаться, а не «как будто»')
  assert.equal(beastList(fed.state)[0].stage, 'fed')

  // Сторожащегося не кормят с руки.
  assert.throws(
    () => run(state, { command_type: 'FeedBeast', beast_id: beastId(state) }),
    (error) => error.code === 'BEAST_STAGE_MISMATCH',
  )
  // Пустой рюкзак — честный отказ, а не бесплатная еда.
  const hungry = normalizeCampaignState({ ...calmed, players: [{ ...calmed.players[0], inventory: [] }] })
  assert.throws(
    () => run(hungry, { command_type: 'FeedBeast', beast_id: beastId(hungry) }),
    (error) => error.code === 'BEAST_NO_FOOD',
  )
})

test('накормленного приручают вторым броском, и он перестаёт быть врагом', () => {
  const state = campaign()
  const calmed = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [18] }).state
  const fed = run(calmed, { command_type: 'FeedBeast', beast_id: beastId(calmed), command_id: 'cmd-feed' }).state
  // СЛ после еды — 9; 12 хватает.
  const tamed = run(fed, { command_type: 'CalmBeast', beast_id: beastId(fed), command_id: 'cmd-tame' }, { rng: [12] })
  const tamedEvent = tamed.events.find((event) => event.event_type === 'BeastTamed')
  assert.ok(tamedEvent, 'третья ступень обязана дать своё событие')
  assert.equal(tamedEvent.payload.combat_companion, false, 'спутник в бой не вводится — и это подписано в событии')
  const beast = beastList(tamed.state)[0]
  assert.equal(beast.stage, 'tamed')
  assert.equal(beast.status, 'companion')
  const actor = tamed.state.enemies.find((enemy) => enemy.id === 'enemy-wolf')
  assert.equal(actor.alive, false)
  assert.equal(actor.tamed, true)
  // Приручённый уходит из списка кандидатов: уговаривать его больше не надо.
  assert.equal(tameableBeasts(tamed.state).length, 0)
})

test('успех обнуляет счётчик неудач, и следующая ступень не платит за прошлые', () => {
  const state = campaign()
  const missed = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [1, 2] }).state
  assert.equal(beastList(missed).find((beast) => beast.actor_id === 'enemy-wolf').attempts, 1)
  const calmed = run(missed, { command_type: 'CalmBeast', beast_id: beastId(missed), command_id: 'cmd-again' }, { rng: [20] }).state
  assert.equal(beastList(calmed)[0].attempts, 0)
})

// ---------------------------------------------------------------------------
// Спутник
// ---------------------------------------------------------------------------

function tamedCampaign(extra = {}) {
  const state = campaign(extra)
  const calmed = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [18] }).state
  const fed = run(calmed, { command_type: 'FeedBeast', beast_id: beastId(calmed), command_id: 'cmd-feed' }).state
  return run(fed, { command_type: 'CalmBeast', beast_id: beastId(fed), command_id: 'cmd-tame' }, { rng: [12] }).state
}

test('спутник даёт преимущество на Восприятие только на привале', () => {
  // Сцена под крышей намеренно: небо тоже двигает Восприятие (дождь и ночь
  // дают помеху, `weatherCheckSwing`), и под открытым небом тест мерил бы не
  // зверя, а погоду этого сида.
  const camped = tamedCampaign({ scene: { scene_kind: 'dungeon' }, resting: { hero: { kind: 'long', started_at_minutes: 0 } } })
  assert.ok(beastWatchSwing(camped, 'perception', 'hero'))
  // На ходу зверь ничего не даёт: он сторож лагеря, а не постоянный бонус.
  const marching = tamedCampaign({ scene: { scene_kind: 'dungeon' } })
  assert.equal(beastWatchSwing(marching, 'perception', 'hero'), null)
  // И только Восприятию — не любому навыку.
  assert.equal(beastWatchSwing(camped, 'stealth', 'hero'), null)

  // Карточка ручного броска и исполнение обязаны сойтись.
  assert.equal(previewD20Check(camped, { actorId: 'hero', kind: 'check', skill: 'perception', difficulty: 12 }).advantage, true)
  const check = run(camped, {
    command_type: 'MakeAbilityCheck', skill: 'perception', difficulty: 12, command_id: 'cmd-watch',
  }, { rng: [4, 17] })
  const resolved = check.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(resolved.payload.mode, 'advantage')
  assert.ok(resolved.payload.beast_watch_advantage)
})

test('стража спутника партийная: чужому Восприятию волк отряда не помогает', () => {
  // Форма поправки скопирована с погоды, но погода мировая и правомерно общая,
  // а страж лагеря принадлежит отряду. Без проверки актора преимущество
  // получал бы любой, кто бросает Восприятие, пока отдыхает хоть один герой, —
  // включая вражеского разведчика, который ищет этот самый отряд.
  const camped = tamedCampaign({
    scene: { scene_kind: 'dungeon' },
    resting: { hero: { kind: 'long', started_at_minutes: 0 } },
    enemies: [wolf(), { id: 'enemy-scout', name: 'Разведчик', hp: 9, maxHp: 9, armor: 12, x: 5, y: 5, alive: true }],
  })
  assert.ok(beastWatchSwing(camped, 'perception', 'hero'), 'герой отряда стражу зверя получает')
  assert.equal(beastWatchSwing(camped, 'perception', 'enemy-scout'), null)
  // Без актора поправки нет вовсе: «чьё Восприятие» — обязательный вопрос.
  assert.equal(beastWatchSwing(camped, 'perception'), null)
  const preview = previewD20Check(camped, { actorId: 'enemy-scout', kind: 'check', skill: 'perception', difficulty: 12 })
  assert.equal(preview.advantage, false)
  assert.equal(preview.beast_watch_reason, undefined)
  // Панель при этом честно говорит, что страж стоит: вопрос лагеря, а не броска.
  assert.equal(beastsForViewer(camped, {}).watch_advantage, true)
})

test('спутник не вытесняется из реестра сорок первой записью', () => {
  // Реестр вытесняет самую старую запись, а первый прирученный зверь — как раз
  // она. Без исключения спутников отряд, встретивший за кампанию четыре
  // десятка волков, терял бы питомца молча: панель пустеет, страж перестаёт
  // давать преимущество, события об уходе зверя нет.
  const companion = {
    id: 'beast:companion', actor_id: 'enemy-wolf', name: 'Волк 1', diet: 'predator',
    stage: 'tamed', status: 'companion',
  }
  const crowd = Array.from({ length: 44 }, (unused, index) => ({
    id: `beast:wild-${index}`, actor_id: `enemy-wild-${index}`, name: `Волк ${index}`, diet: 'predator', stage: 'wary',
  }))
  const normalized = normalizeBeastState({ beasts: [companion, ...crowd] })
  assert.equal(normalized.beasts.length, 40)
  assert.ok(normalized.beasts.some((beast) => beast.id === 'beast:companion'), 'спутник обязан пережить вытеснение')
  // Вытесняются именно старые дикие записи, а свежие остаются.
  assert.equal(normalized.beasts.some((beast) => beast.id === 'beast:wild-0'), false)
  assert.ok(normalized.beasts.some((beast) => beast.id === 'beast:wild-43'))
})

test('спутник идёт за отрядом при смене сцены', () => {
  const camp = tamedCampaign()
  const moved = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-scene',
    campaign_id: 'BEAST',
    scene_args: { title: 'Тихий Брод', location: 'Тихий Брод', location_id: 'village', grid: { width: 6, height: 6 }, cells: cells() },
  }], camp, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })
  assert.equal(moved.events.some((event) => event.event_type === 'BeastMoved'), true)
  assert.equal(beastList(moved.state)[0].location_name, 'Тихий Брод')
})

test('отпугивание — строка нарратива с откатом и без механики', () => {
  const camp = tamedCampaign()
  const id = beastId(camp)
  const scared = run(camp, { command_type: 'ScareWithBeast', beast_id: id, command_id: 'cmd-scare' })
  const event = scared.events.find((entry) => entry.event_type === 'BeastScaredThreat')
  assert.equal(event.payload.mechanical_effect, false)
  assert.ok(event.payload.line.includes('Волк'))
  assert.equal(event.payload.line, beastScareLine(beastList(camp)[0], 0))
  // Второй раз подряд — отказ: у зверя откат.
  assert.throws(
    () => run(scared.state, { command_type: 'ScareWithBeast', beast_id: id, command_id: 'cmd-scare-2' }),
    (error) => error.code === 'BEAST_SCARE_COOLDOWN',
  )
  // Не прирученным зверем не отгоняют.
  const wild = campaign()
  assert.throws(
    () => run(wild, { command_type: 'ScareWithBeast', beast_id: beastId(wild), command_id: 'cmd-scare-3' }),
    (error) => error.code === 'BEAST_NOT_COMPANION',
  )
  assert.equal(BEAST_SCARE_COOLDOWN_MINUTES, 60)
})

// ---------------------------------------------------------------------------
// Проекция, replay и подсказки
// ---------------------------------------------------------------------------

test('игроку не уезжают стат-блок и CR — ни состоянием, ни событием', () => {
  const state = campaign()
  const result = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [18] })
  const room = campaignStateForViewer(result.state, { role: 'player' }, 'hero')
  const visible = room.beasts.beasts[0]
  assert.equal(visible.stat_block_id, undefined)
  assert.equal(visible.challenge_rating, undefined)
  assert.equal(visible.diet, 'predator')
  assert.equal(visible.diet_label, 'хищник')
  assert.equal(visible.stage_label, 'успокоен')
  // Тот же отбор во втором канале — в самом событии.
  const encountered = result.events.find((event) => event.event_type === 'BeastEncountered')
  const projected = mechanicsForViewer([encountered], { role: 'player', heroIds: ['hero'] }, 'hero', result.state)[0]
  assert.equal(projected.payload.beast.stat_block_id, undefined)
  assert.equal(projected.payload.beast.challenge_rating, undefined)
  // Ведущий видит запись целиком: из неё сложилась объявленная СЛ.
  const gmRoom = campaignStateForViewer(result.state, { role: 'admin' }, 'hero')
  assert.equal(gmRoom.beasts.beasts[0].stat_block_id, 'srd_5_2_1:wolf')
})

test('карточка кандидата приезжает с объявленной СЛ и её слагаемыми', () => {
  const state = campaign()
  const view = beastsForViewer(state, {})
  const candidate = view.candidates[0]
  assert.equal(candidate.difficulty, 13)
  assert.deepEqual(candidate.parts.map((part) => part.id), ['base', 'challenge', 'predator'])
  assert.equal(candidate.bites_on_failure, true)
  assert.equal(candidate.skill, 'animal-handling')
  assert.equal(candidate.ability, 'wis')
})

test('реестр зверей восстанавливается replay-ем без снимка', () => {
  const state = campaign()
  const first = run(state, { command_type: 'CalmBeast', beast_id: beastId(state) }, { rng: [18] })
  const second = run(first.state, { command_type: 'FeedBeast', beast_id: beastId(first.state), command_id: 'cmd-feed' })
  const third = run(second.state, { command_type: 'CalmBeast', beast_id: beastId(second.state), command_id: 'cmd-tame' }, { rng: [12] })
  const replayed = replayEvents(state, [...first.events, ...second.events, ...third.events])
  assert.deepEqual(replayed.beasts, third.state.beasts)
  assert.equal(replayed.enemies.find((enemy) => enemy.id === 'enemy-wolf').tamed, true)
})

test('подсказка зовёт к зверю только тогда, когда к нему можно подойти', () => {
  const state = campaign()
  const room = campaignStateForViewer(state, { role: 'player' }, 'hero')
  const hints = suggestedActionsFor(room)
  assert.ok(hints.some((hint) => hint.text.includes('успокоить')), JSON.stringify(hints))
  // В бою подсказок нет вовсе — это общий закон панели.
  const fighting = campaignStateForViewer(campaign({ combatActive: true }), { role: 'player' }, 'hero')
  assert.deepEqual(suggestedActionsFor(fighting), [])
})

test('владение Уходом за животными доходит до броска в обоих написаниях', () => {
  // Каталог правил хранит `animal_handling`, движок говорит дефисами. Пока
  // сравнение шло буквальным, эти два навыка — и только они — молча теряли и
  // характеристику, и бонус владения: ловчий бросал уговор без него.
  assert.equal(skillAbility('animal-handling'), 'wis')
  assert.equal(skillAbility('animal_handling'), 'wis')
  assert.equal(skillAbility('sleight-of-hand'), 'dex')
  const ranger = { classSkillProficiencies: ['animal_handling'], role: 'следопыт', class: 'ranger', level: 3 }
  assert.equal(isSkillProficient(ranger, 'animal-handling'), true)
  assert.equal(isSkillProficient(ranger, 'stealth'), false)
  // И в обратную сторону: лист героя может хранить дефисы. Пока нормализация
  // стояла только в сравнении, фильтр разрешённых навыков класса отбрасывал
  // значение раньше — и владение терялось в обоих написаниях сразу.
  const dashed = { classSkillProficiencies: ['animal-handling'], role: 'следопыт', class: 'ranger', level: 3 }
  assert.deepEqual(normalizedClassSkillProficiencies(dashed), ['animal-handling'])
  assert.equal(isSkillProficient(dashed, 'animal-handling'), true)
  assert.equal(isSkillProficient(dashed, 'animal_handling'), true)
  // И то же самое доезжает до карточки ручного броска: +3 Мудрость и +2 владение.
  const state = campaign()
  assert.equal(previewD20Check(state, { actorId: 'hero', kind: 'check', ability: 'wis', skill: 'animal-handling', difficulty: 13 }).modifier, 5)
})

test('еда ищется по каталогу, идентификатору и по имени', () => {
  const resolver = (catalogId) => catalogId === 'custom:jerky' ? { use: { kind: 'ration' } } : null
  assert.equal(beastFoodItemFor({ inventory: [ration()] }, () => null)?.id, 'item-rations')
  assert.equal(beastFoodItemFor({ inventory: [{ id: 'i1', catalog_id: 'custom:jerky', name: 'Вяленое', quantity: 1 }] }, resolver)?.id, 'i1')
  assert.equal(beastFoodItemFor({ inventory: [{ id: 'i2', name: 'Копчёное мясо', quantity: 1 }] })?.id, 'i2')
  // Кончившийся паёк едой не считается.
  assert.equal(beastFoodItemFor({ inventory: [ration(0)] }), null)
  assert.equal(beastFoodItemFor({ inventory: [{ id: 'i3', name: 'Верёвка пеньковая', quantity: 1 }] }), null)
})

test('волку достаётся паёк, а не находка режиссёра с тем же словом в названии', () => {
  // `GrantItem` заводит предметы свободными именами, а свободный regex берёт
  // первый подходящий слот: «Вяленое сердце вепря» в нулевом слоте уходило
  // зверю раньше настоящих пайков, лежащих ниже в рюкзаке.
  const trophy = { id: 'i-trophy', name: 'Вяленое сердце вепря', quantity: 1, rarity: 'редкий' }
  assert.equal(beastFoodItemFor({ inventory: [trophy, ration()] })?.id, 'item-rations')
  // Обычный паёк предпочитается свободному имени просто потому, что он паёк.
  const jerky = { id: 'i-jerky', name: 'Копчёное мясо', quantity: 1 }
  assert.equal(beastFoodItemFor({ inventory: [jerky, ration()] })?.id, 'item-rations')
  // Настроечное и сюжетное не еда вовсе, даже если больше нечего дать.
  assert.equal(beastFoodItemFor({ inventory: [trophy] }), null)
  assert.equal(beastFoodItemFor({ inventory: [{ id: 'i-quest', name: 'Вяленое мясо', quantity: 1, quest_item: true }] }), null)
  assert.equal(beastFoodItemFor({ inventory: [{ id: 'i-att', name: 'Вяленое мясо', quantity: 1, requires_attunement: true }] }), null)
  // Но обычное мясо без метки — по-прежнему еда: правило режет находки, а не снедь.
  assert.equal(beastFoodItemFor({ inventory: [jerky] })?.id, 'i-jerky')
})
