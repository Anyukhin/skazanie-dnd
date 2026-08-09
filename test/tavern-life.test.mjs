import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  TAVERN_CHEAT_BONUS,
  TAVERN_DRINK_PRICE_CP,
  TAVERN_DRUNK_CONDITION,
  TAVERN_SCANDALS_BEFORE_EJECTION,
  TAVERN_SOBER_DRINKS,
  TAVERN_STAKES_CP,
  isTavernScene,
  tavernDrinksFor,
  tavernEjected,
  tavernGamblerFor,
  tavernNextDrinkDc,
  tavernOpponents,
  tavernRoundFor,
  tavernSocialBonus,
} from '../server/tavern-life.mjs'
import {
  normalizeCampaignState,
  previewD20Check,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { suggestedActionsFor } from '../server/action-hints.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'
import { combatNarration } from '../server/combat-narration.mjs'
import { worldDeedsFeed } from '../server/world-deeds.mjs'
import { wantedFeed } from '../server/law-and-order.mjs'

const CAMPAIGN = 'TAVERN'
const INN = 'Трактир «У моста»'

/**
 * Соперники подобраны сидом кампании, а не выдумкой теста: на `TAVERN`
 * `hunter` выходит шулером, а `barkeep` — честным. Проверяется это первым же
 * тестом, поэтому при смене сида падает он, а не десять тестов ниже.
 */
const CROOK = 'hunter'
const HONEST = 'barkeep'

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

/**
 * Общий зал трактира. Кошелёк героя — ровно 1 зм: так и «не хватает на ставку»,
 * и «кошелёк не ушёл в минус» проверяются числами, а не приблизительно.
 */
function campaign({ scene = {}, currency = { copper: 0, silver: 0, gold: 1, platinum: 0 }, abilities = {}, minutes = 0 } = {}) {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN,
    campaign: 'Жизнь таверны',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: {
      title: INN,
      location: INN,
      location_id: 'inn',
      grid: { width: 6, height: 6 },
      cells: cells(),
      ...scene,
    },
    players: [{
      id: 'hero',
      character: 'Ада',
      hp: 12,
      maxHp: 12,
      x: 1,
      y: 1,
      speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...abilities },
      proficiency: 2,
      // Владения задаются явно: без списка движок считает героя владеющим любым
      // навыком, и модификатор проверки в тесте перестал бы быть предсказуемым.
      classSkillProficiencies: [],
      savingThrowProficiencies: [],
      backgroundSkillProficiencies: [],
      currency,
      inventory: [],
    }],
    worldMap: {
      seed: 'tavern-seed',
      regions: [{ id: 'north', name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 }],
      locations: [{ id: 'inn', name: INN, kind: 'village', x: 200, y: 200, regionId: 'north' }],
      routes: [],
    },
    enemies: [],
    social: {
      npcs: [
        { id: HONEST, name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' },
        { id: CROOK, name: 'Охотник Кривой', role: 'охотник', location: INN, visibility: 'party', public_summary: 'Сидит у окна.' },
      ],
    },
    mechanics: { world_time: { elapsed_minutes: minutes } },
  })
}

function run(state, commands, { diceValues = [], context = {} } = {}) {
  return resolveCommands(
    commands.map((command, index) => ({ campaign_id: CAMPAIGN, command_id: `cmd-${index + 1}`, ...command })),
    state,
    { diceService: dice(diceValues), context: { allowedActorIds: ['hero'], ...context } },
  )
}

const open = (npcId = HONEST, stakeCp = TAVERN_STAKES_CP[0]) => ({
  command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: npcId, stake_cp: stakeCp,
})
const answer = (approach = 'fair') => ({ command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach })
const drink = () => ({ command_type: 'OrderTavernDrink', actor_id: 'hero' })

function purseCp(state, heroId = 'hero') {
  const currency = state.players.find((player) => player.id === heroId)?.currency ?? {}
  return (Number(currency.copper) || 0)
    + (Number(currency.silver) || 0) * 10
    + (Number(currency.gold) || 0) * 100
    + (Number(currency.platinum) || 0) * 1_000
}

function eventOf(result, type) {
  return result.events.find((event) => event.event_type === type) ?? null
}

function rejects(state, commands, code, options = {}) {
  assert.throws(() => run(state, commands, options), (error) => {
    assert.equal(error.code, code, `ожидался отказ ${code}, пришёл ${error.code}: ${error.message}`)
    return true
  })
}

// ---------------------------------------------------------------------------
// Где всё это происходит
// ---------------------------------------------------------------------------

test('таверна опознаётся сценой, а поле и лес — нет', () => {
  assert.equal(isTavernScene(campaign()), true)
  assert.equal(isTavernScene(campaign({ scene: { title: 'Корчма на развилке', location: 'Корчма на развилке' } })), true)
  assert.equal(isTavernScene(campaign({ scene: { title: 'Тёмный лес', location: 'Тёмный лес' } })), false)
  // Тема застройки берёт и дом, и лавку, и терем: своей, более узкой проверки
  // здесь заводили именно ради этого.
  assert.equal(isTavernScene(campaign({ scene: { title: 'Лавка старьёвщика', location: 'Лавка старьёвщика' } })), false)
})

test('ни костей, ни выпивки вне таверны и посреди боя', () => {
  const forest = campaign({ scene: { title: 'Тёмный лес', location: 'Тёмный лес' } })
  rejects(forest, [open()], 'TAVERN_SCENE_REQUIRED')
  rejects(forest, [drink()], 'TAVERN_SCENE_REQUIRED')

  const fight = normalizeCampaignState({
    ...campaign(),
    mechanics: {
      ...campaign().mechanics,
      combat: { active: true, round: 1, initiative: [{ actor_id: 'hero', total: 12 }], active_index: 0 },
    },
  })
  rejects(fight, [open()], 'TAVERN_DURING_COMBAT')
  rejects(fight, [drink()], 'TAVERN_DURING_COMBAT')
})

test('за костями сидят только видимые живые соседи по залу', () => {
  assert.deepEqual(tavernOpponents(campaign()).map((npc) => npc.id).sort(), [HONEST, CROOK].sort())
  rejects(campaign(), [open('someone-else')], 'TAVERN_OPPONENT_NOT_FOUND')
  // Ставка — из закрытого серверного набора, а не любое число из запроса.
  rejects(campaign(), [{ ...open(), stake_cp: 37 }], 'TAVERN_STAKE_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// Банк
// ---------------------------------------------------------------------------

test('соперник мечет первым, ставка при этом ещё не тронута', () => {
  const state = campaign()
  const result = run(state, [open(HONEST, 50)], { diceValues: [14] })
  const opened = eventOf(result, 'TavernDiceRoundOpened')

  assert.ok(opened, 'раунд обязан открыться событием')
  assert.equal(opened.payload.round.npc_total, 14)
  assert.equal(opened.payload.round.target, 15, 'перебить — значит показать больше')
  assert.equal(opened.payload.round.stake_cp, 50)
  assert.equal(purseCp(result.state), 100, 'до ответа деньги на месте')
  assert.equal(tavernRoundFor(result.state).hero_id, 'hero')

  // Общий бросок стола переиспользован, а не заведён заново: кость соперника
  // ложится в тот же лоток, где стол видит любой ручной кубик.
  const publicRoll = eventOf(result, 'PublicDieRolled')
  assert.ok(publicRoll)
  assert.equal(publicRoll.payload.roll.value, 14)
  assert.equal(publicRoll.payload.roll.sides, 20)
  assert.equal(result.state.lastDiceRoll.value, 14)
})

test('банк переходит честно: победа, поражение и ничья двигают кошелёк ровно на ставку', () => {
  const win = run(run(campaign(), [open(HONEST, 50)], { diceValues: [10] }).state, [answer()], { diceValues: [15] })
  assert.equal(eventOf(win, 'TavernDiceRoundResolved').payload.outcome, 'win')
  assert.equal(purseCp(win.state), 150, 'победа приносит ставку соперника')

  const loss = run(run(campaign(), [open(HONEST, 50)], { diceValues: [15] }).state, [answer()], { diceValues: [10] })
  assert.equal(eventOf(loss, 'TavernDiceRoundResolved').payload.outcome, 'loss')
  assert.equal(purseCp(loss.state), 50, 'поражение отдаёт свою')

  const push = run(run(campaign(), [open(HONEST, 50)], { diceValues: [12] }).state, [answer()], { diceValues: [12] })
  assert.equal(eventOf(push, 'TavernDiceRoundResolved').payload.outcome, 'push')
  assert.equal(purseCp(push.state), 100, 'ничья не двигает ничего')

  // Раунд закрыт в любом исходе: второй ответ на тот же бросок невозможен.
  assert.equal(tavernRoundFor(win.state), null)
  rejects(win.state, [answer()], 'TAVERN_ROUND_NOT_OPEN')
})

test('кошелёк не уходит в минус: на ставку сверх кошелька движок не соглашается', () => {
  const poor = campaign({ currency: { copper: 0, silver: 2, gold: 0, platinum: 0 } })
  assert.equal(purseCp(poor), 20)
  rejects(poor, [open(HONEST, 200)], 'INSUFFICIENT_FUNDS')

  // Проигранная ставка ровно в размер кошелька оставляет ноль, а не минус.
  const opened = run(campaign({ currency: { copper: 0, silver: 1, gold: 0, platinum: 0 } }), [open(HONEST, 10)], { diceValues: [18] })
  const lost = run(opened.state, [answer()], { diceValues: [3] })
  assert.equal(purseCp(lost.state), 0)
  assert.equal(lost.state.players[0].currency.copper >= 0, true)
})

test('второй раунд не открыть, пока не отвечено на первый', () => {
  const opened = run(campaign(), [open(HONEST, 10)], { diceValues: [11] })
  rejects(opened.state, [open(HONEST, 10)], 'TAVERN_ROUND_ALREADY_OPEN')
})

// ---------------------------------------------------------------------------
// Шулерство в обе стороны
// ---------------------------------------------------------------------------

test('характер соперника детерминирован сидом и в состояние не попадает', () => {
  const state = campaign()
  assert.equal(tavernGamblerFor(state, CROOK).crooked, true, 'сид кампании TAVERN сажает шулера в охотника')
  assert.equal(tavernGamblerFor(state, HONEST).crooked, false)
  // Тот же вход — тот же человек: replay сажает за стол того же соперника.
  assert.deepEqual(tavernGamblerFor(campaign(), CROOK), tavernGamblerFor(campaign(), CROOK))
  assert.equal(JSON.stringify(state.tavern).includes('crooked'), false)
})

test('шулер подменяет кость, а не сумму: на столе лежит уже другое число', () => {
  const crooked = run(campaign(), [open(CROOK, 10)], { diceValues: [7] })
  const opened = eventOf(crooked, 'TavernDiceRoundOpened')
  assert.equal(opened.payload.round.npc_total, 7 + TAVERN_CHEAT_BONUS, 'краплёная кость показывает больше')
  // Разницу между выпавшим и показанным игрок увидеть не должен: настоящий
  // бросок уходит с видимостью ведущего.
  const opponentRoll = crooked.rolls.find((roll) => roll.purpose === 'tavern-dice:opponent')
  assert.equal(opponentRoll.visibility, 'gm_only')
  assert.equal(eventOf(crooked, 'PublicDieRolled').payload.roll.value, 12, 'стол видит только подменённое число')

  const honest = run(campaign(), [open(HONEST, 10)], { diceValues: [7] })
  assert.equal(eventOf(honest, 'TavernDiceRoundOpened').payload.round.npc_total, 7)
})

test('удачное жульничество героя добавляет к его броску и забирает банк', () => {
  const gambler = tavernGamblerFor(campaign(), HONEST)
  const opened = run(campaign(), [open(HONEST, 50)], { diceValues: [15] })
  // Первая кость — Ловкость рук против пассивной Проницательности соседа,
  // вторая — сам бросок. Без надбавки 12 против 15 было бы поражением.
  const result = run(opened.state, [answer('cheat')], { diceValues: [gambler.insight_passive, 12] })
  const resolved = eventOf(result, 'TavernDiceRoundResolved')

  assert.equal(resolved.payload.cheated, true)
  assert.equal(resolved.payload.hero_total, 12 + TAVERN_CHEAT_BONUS)
  assert.equal(resolved.payload.outcome, 'win')
  assert.equal(purseCp(result.state), 150)
  assert.equal(eventOf(result, 'TavernCheatCaught'), null)
})

test('провал жульничества — скандал: поступок свидетелям, отношение вниз, ставка потеряна', () => {
  const opened = run(campaign(), [open(HONEST, 50)], { diceValues: [5] })
  const result = run(opened.state, [answer('cheat')], { diceValues: [1, 20] })
  const resolved = eventOf(result, 'TavernDiceRoundResolved')

  assert.equal(resolved.payload.outcome, 'caught', 'пойманного за руку двадцатка не спасает')
  assert.equal(resolved.payload.cheated, false)
  assert.equal(purseCp(result.state), 50, 'ставку забирает стол')

  const caught = eventOf(result, 'TavernCheatCaught')
  assert.ok(caught, 'скандал обязан остаться отдельным событием')
  assert.equal(caught.payload.scandal_count, 1)

  // Стыковка со свидетелями: поступок в летописи со свидетелями и с местом.
  const deeds = worldDeedsFeed(result.state)
  const deed = deeds.find((entry) => entry.kind === 'cheating')
  assert.ok(deed, 'шулерство обязано попасть в летопись поступков')
  assert.ok(deed.witness_count >= 1, 'обыгранный сосед — свидетель сам по себе')
  assert.equal(result.state.world_deeds.deeds.at(-1).secret, false)

  // Отношение обманутого падает и делает это существующим событием.
  const relationship = eventOf(result, 'NpcRelationshipAdjusted')
  assert.ok(relationship)
  assert.equal(relationship.payload.npc_id, HONEST)
  assert.ok(relationship.payload.delta < 0)
  assert.equal(result.state.social.relationships[HONEST].hero, relationship.payload.score_after)

  // Стража за кости не приходит: шулерство — дело хозяина, а не закона.
  assert.equal(wantedFeed(result.state).some((region) => region.level > 0), false)
})

test('второй скандал выставляет за дверь, и за стол больше не сесть', () => {
  let state = campaign({ currency: { copper: 0, silver: 0, gold: 5, platinum: 0 } })
  for (let attempt = 0; attempt < TAVERN_SCANDALS_BEFORE_EJECTION; attempt += 1) {
    state = run(state, [open(HONEST, 10)], { diceValues: [11] }).state
    state = run(state, [answer('cheat')], { diceValues: [1, 11] }).state
  }
  assert.equal(tavernEjected(state, 'hero'), true)
  rejects(state, [open(HONEST, 10)], 'TAVERN_PATRON_EJECTED')
  rejects(state, [drink()], 'TAVERN_PATRON_EJECTED')
})

test('шулера ловят Проницательностью, и разоблачение оставляет ставку герою', () => {
  const gambler = tavernGamblerFor(campaign(), CROOK)
  const opened = run(campaign(), [open(CROOK, 50)], { diceValues: [15] })
  const exposedRun = run(opened.state, [answer('watch')], { diceValues: [gambler.tell_dc, 3] })
  const resolved = eventOf(exposedRun, 'TavernDiceRoundResolved')

  assert.equal(resolved.payload.outcome, 'exposed')
  assert.equal(resolved.payload.watch_result, 'exposed')
  assert.equal(purseCp(exposedRun.state), 100, 'разоблачённый раунд ставку не забирает')
  assert.ok(eventOf(exposedRun, 'TavernCheatExposed'))
  // Ссора уходит в социальный контур: отношение вниз и настороженная стойка.
  assert.ok(eventOf(exposedRun, 'NpcRelationshipAdjusted').payload.delta < 0)
  assert.equal(eventOf(exposedRun, 'NpcStanceChanged').payload.stance, 'guarded')

  // Провалили проверку — раунд играется как обычный.
  const missed = run(opened.state, [answer('watch')], { diceValues: [1, 3] })
  assert.equal(eventOf(missed, 'TavernDiceRoundResolved').payload.watch_result, 'missed')
  assert.equal(eventOf(missed, 'TavernDiceRoundResolved').payload.outcome, 'loss')
})

test('честного соперника не разоблачить даже двадцаткой', () => {
  const opened = run(campaign(), [open(HONEST, 10)], { diceValues: [4] })
  const result = run(opened.state, [answer('watch')], { diceValues: [20, 18] })
  const resolved = eventOf(result, 'TavernDiceRoundResolved')

  assert.equal(resolved.payload.watch_result, 'clean', 'разглядеть можно только то, что есть')
  assert.equal(resolved.payload.outcome, 'win')
  assert.equal(eventOf(result, 'TavernCheatExposed'), null)
})

// ---------------------------------------------------------------------------
// Выпивка
// ---------------------------------------------------------------------------

test('первые кружки платят монетой и развязывают язык', () => {
  const first = run(campaign(), [drink()], { diceValues: [] })
  const ordered = eventOf(first, 'TavernDrinkOrdered')

  assert.equal(ordered.payload.drinks, 1)
  assert.equal(ordered.payload.price_cp, TAVERN_DRINK_PRICE_CP)
  assert.equal(purseCp(first.state), 100 - TAVERN_DRINK_PRICE_CP)
  assert.equal(ordered.payload.social_bonus, 1)
  assert.equal(eventOf(first, 'SavingThrowResolved'), null, 'за первую кружку спасброска нет')
  assert.equal(tavernSocialBonus(first.state, 'hero', 'persuasion'), 1)
  assert.equal(tavernSocialBonus(first.state, 'hero', 'stealth'), 0, 'кружка помогает разговору, а не всему подряд')

  // Прибавка обязана быть в том же предпросмотре, который видит игрок на
  // карточке ручного броска, и в самой проверке.
  const preview = previewD20Check(first.state, { actorId: 'hero', kind: 'check', skill: 'persuasion', difficulty: 12 })
  assert.equal(preview.modifier, 1)
  const check = run(first.state, [{ command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'persuasion', difficulty: 12 }], { diceValues: [10] })
  assert.equal(eventOf(check, 'AbilityCheckResolved').payload.modifier, 1)
})

test('перебор идёт через спасбросок Телосложения по нарастающей СЛ', () => {
  let state = campaign({ currency: { copper: 0, silver: 0, gold: 1, platinum: 0 } })
  for (let index = 0; index < TAVERN_SOBER_DRINKS; index += 1) state = run(state, [drink()]).state
  assert.equal(tavernDrinksFor(state, 'hero'), TAVERN_SOBER_DRINKS)
  assert.equal(tavernNextDrinkDc(state, 'hero'), 11, 'третья кружка — первая опасная')

  const withstood = run(state, [drink()], { diceValues: [20] })
  assert.equal(eventOf(withstood, 'SavingThrowResolved').payload.difficulty, 11)
  assert.equal(eventOf(withstood, 'ConditionAdded'), null, 'устоявший на ногах остаётся трезвым')
  assert.equal(tavernSocialBonus(withstood.state, 'hero', 'persuasion'), 0, 'после перебора язык уже не развязывается, а заплетается')
  assert.equal(tavernNextDrinkDc(withstood.state, 'hero'), 12, 'СЛ растёт с каждой кружкой')

  const failed = run(state, [drink()], { diceValues: [1] })
  const condition = eventOf(failed, 'ConditionAdded')
  assert.ok(condition, 'провал спасброска обязан повесить состояние')
  assert.equal(condition.payload.condition, TAVERN_DRUNK_CONDITION)
  assert.equal(condition.payload.source, 'tavern-drink')

  // Помеха действует на любую проверку — тем же механизмом, что и истощение.
  assert.equal(previewD20Check(failed.state, { actorId: 'hero', kind: 'check', skill: 'perception', difficulty: 12 }).disadvantage, true)
})

test('опьянение снимается продолжительным отдыхом, а не концом сцены', () => {
  let state = campaign()
  for (let index = 0; index < TAVERN_SOBER_DRINKS; index += 1) state = run(state, [drink()]).state
  const drunk = run(state, [drink()], { diceValues: [1] }).state
  assert.equal(drunk.mechanics.conditions.hero.some((condition) => condition.id === TAVERN_DRUNK_CONDITION), true)

  // Отдых берётся событием: проверяется здесь не lifecycle привала, а то, что
  // срок опьянения объявлен так, чтобы `RestCompleted` его смёл.
  const rested = replayEvents(drunk, [{
    event_id: 'evt-rest', command_id: 'cmd-rest', event_type: 'RestCompleted', actor_id: 'hero',
    target_ids: ['hero'], visibility: 'party', payload: { kind: 'long' },
    state_version_after: drunk.state_version + 1,
  }])
  assert.equal((rested.mechanics.conditions.hero ?? []).some((condition) => condition.id === TAVERN_DRUNK_CONDITION), false)
})

test('счёт кружек и скандалов остаётся в сцене и обнуляется с переходом', () => {
  const drunk = run(campaign(), [drink()]).state
  assert.equal(tavernDrinksFor(drunk, 'hero'), 1)
  const moved = replayEvents(drunk, [{
    event_id: 'evt-scene', command_id: 'cmd-scene', event_type: 'SceneAdvanced', actor_id: null,
    target_ids: [], visibility: 'party',
    payload: { scene: { title: 'Дорога', location: 'Дорога', location_id: 'road' } },
    state_version_after: drunk.state_version + 1,
  }])
  assert.equal(tavernDrinksFor(moved, 'hero'), 0)
  assert.equal(tavernRoundFor(moved), null)
})

// ---------------------------------------------------------------------------
// Replay и проекция
// ---------------------------------------------------------------------------

test('replay журнала даёт тот же счёт заведения и тот же кошелёк', () => {
  const opened = run(campaign(), [open(CROOK, 50)], { diceValues: [9] })
  const answered = run(opened.state, [answer('cheat')], { diceValues: [1, 14] })
  const drunkRun = run(answered.state, [drink()])
  const events = [...opened.events, ...answered.events, ...drunkRun.events].map((event, index) => ({
    ...event,
    event_id: event.event_id ?? `evt-${index + 1}`,
    state_version_after: index + 2,
  }))
  const replayed = replayEvents(campaign(), events)

  assert.deepEqual(replayed.tavern, drunkRun.state.tavern)
  assert.equal(purseCp(replayed), purseCp(drunkRun.state))
  assert.deepEqual(
    worldDeedsFeed(replayed).map((deed) => deed.kind),
    worldDeedsFeed(drunkRun.state).map((deed) => deed.kind),
  )
})

test('игроку уезжает карточка заведения без характера соперника и без чужого счёта', () => {
  const opened = run(campaign(), [open(CROOK, 50)], { diceValues: [9] })
  const viewer = { id: 'user-1', role: 'player', heroIds: ['hero'] }
  const player = campaignStateForViewer(opened.state, viewer, 'hero')

  assert.ok(player.tavern, 'в таверне карточка обязана быть')
  assert.equal(player.tavern.round.npc_total, 14)
  assert.equal(player.tavern.round.target, 15)
  assert.equal(player.tavern.drink_price_cp, TAVERN_DRINK_PRICE_CP)
  const serialized = JSON.stringify(player.tavern)
  assert.equal(serialized.includes('crooked'), false)
  assert.equal(serialized.includes('insight_passive'), false)
  assert.equal(serialized.includes('tell_dc'), false)
  assert.equal(serialized.includes('scandals'), false)

  // Канал событий чистится тем же санитайзером, что и проекция состояния.
  const projectedEvents = mechanicsForViewer(opened.events, viewer, 'hero', opened.state)
  const openedEvent = projectedEvents.find((event) => event.event_type === 'TavernDiceRoundOpened')
  assert.ok(openedEvent)
  assert.equal(JSON.stringify(openedEvent.payload).includes('crooked'), false)
  assert.equal(openedEvent.payload.round.opened_at_minutes, undefined)

  // Вне таверны карточки нет вовсе.
  const road = campaignStateForViewer(campaign({ scene: { title: 'Дорога', location: 'Дорога' } }), viewer, 'hero')
  assert.equal(road.tavern, null)
})

test('подсказки зовут за стол, а с открытой костью — отвечать', () => {
  const viewer = { id: 'user-1', role: 'player', heroIds: ['hero'] }
  const idle = campaignStateForViewer(campaign(), viewer, 'hero')
  assert.ok(idle.suggested_actions.some((hint) => /сыграть в кости/iu.test(hint.text)))
  assert.ok(idle.suggested_actions.some((hint) => /заказать выпивку/iu.test(hint.text)))

  const opened = run(campaign(), [open(HONEST, 10)], { diceValues: [16] })
  const hints = suggestedActionsFor(campaignStateForViewer(opened.state, viewer, 'hero'))
  assert.ok(hints.some((hint) => /ответить на бросок/iu.test(hint.text)))
  assert.ok(hints.some((hint) => /16/u.test(hint.text)), 'подсказка называет число, которое надо перебить')
})

test('летопись говорит о раунде живой строкой, а не идентификатором события', () => {
  const opened = run(campaign(), [open(HONEST, 50)], { diceValues: [10] })
  const win = run(opened.state, [answer()], { diceValues: [17] })

  const openedText = combatNarration(opened.events, opened.state)
  assert.match(openedText, /мечет кости/iu)
  assert.match(openedText, /10/u)

  const winText = combatNarration(win.events, win.state)
  assert.match(winText, /банк/iu)
  assert.equal(/Tavern[A-Z]/u.test(winText), false, 'в летописи не должно быть латинских имён событий')
})
