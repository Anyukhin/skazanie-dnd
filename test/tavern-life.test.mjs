import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  TAVERN_CHEAT_BONUS,
  TAVERN_DRINK_PRICE_CP,
  TAVERN_DRUNK_CONDITION,
  TAVERN_GAMBLER_PURSE_BASE_CP,
  TAVERN_SCANDALS_BEFORE_EJECTION,
  TAVERN_SOBER_DRINKS,
  TAVERN_STAKES_CP,
  isTavernScene,
  normalizeTavernState,
  tavernDrinksFor,
  tavernEjected,
  tavernGamblerFor,
  tavernGamblerPurseFor,
  tavernMaxStakeFor,
  tavernNextDrinkDc,
  tavernOpenRoundsAgainst,
  tavernOpponents,
  tavernRoundFor,
  tavernRoundUnanswerableReason,
  tavernSocialBonus,
} from '../server/tavern-life.mjs'
import {
  normalizeCampaignState,
  previewD20Check,
  previewTavernDiceRoll,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { suggestedActionsFor } from '../server/action-hints.mjs'
import { eventsToClientEffects } from '../server/game-orchestrator.mjs'
import { campaignStateForViewer, mechanicsForViewer, turnResultForViewer } from '../server/viewer-projection.mjs'
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
 *
 * `heroIds` сажает за стол не одного игрока, а нескольких: формат игры — стол
 * на пятерых, и проверять поведение раунда на одиночке значило бы не проверять
 * его вовсе.
 */
function campaign({
  scene = {},
  currency = { copper: 0, silver: 0, gold: 1, platinum: 0 },
  abilities = {},
  minutes = 0,
  heroIds = ['hero'],
} = {}) {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN,
    campaign: 'Жизнь таверны',
    activePlayerId: heroIds[0],
    partyMemberIds: [...heroIds],
    partyName: 'Отряд героев',
    scene: {
      title: INN,
      location: INN,
      location_id: 'inn',
      grid: { width: 6, height: 6 },
      cells: cells(),
      ...scene,
    },
    players: heroIds.map((heroId, index) => ({
      id: heroId,
      character: index === 0 ? 'Ада' : `Спутник ${index}`,
      hp: 12,
      maxHp: 12,
      x: 1 + index,
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
    })),
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
    {
      diceService: dice(diceValues),
      context: { allowedActorIds: commands.map((command) => String(command.actor_id ?? 'hero')), ...context },
    },
  )
}

/** Героя уронили в 0 ОЗ — отвечать на брошенную кость он больше не может. */
function downed(state, heroId = 'hero') {
  return normalizeCampaignState({
    ...state,
    players: state.players.map((player) => (player.id === heroId ? { ...player, hp: 0 } : player)),
  })
}

const open = (npcId = HONEST, stakeCp = TAVERN_STAKES_CP[0]) => ({
  command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: npcId, stake_cp: stakeCp,
})
const answer = (approach = 'fair') => ({ command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach })
const leave = (actorId = 'hero') => ({ command_type: 'LeaveTavernDiceRound', actor_id: actorId })
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
  assert.equal(isTavernScene(campaign({ scene: { title: 'Постоялый двор у брода', location: 'Постоялый двор у брода' } })), true)
  assert.equal(isTavernScene(campaign({ scene: { title: 'Тёмный лес', location: 'Тёмный лес' } })), false)
  // Тема застройки берёт и дом, и лавку, и терем: своей, более узкой проверки
  // здесь заводили именно ради этого.
  assert.equal(isTavernScene(campaign({ scene: { title: 'Лавка старьёвщика', location: 'Лавка старьёвщика' } })), false)
})

/**
 * Зонды ревью дословно. Название сцены сочиняет модель, и голая основа ловила
 * в нём глагол и признак: «Отряд постоял у ворот» открывал заведение посреди
 * дороги, а «Пивная бочка в подвале» — в подвале.
 *
 * Второй заход ревью добрал то, что первый пропустил: `постоял[ыо]` отсекал
 * мужской и женский род и **не** отсекал средний, а короткие основы сидели
 * внутри чужих слов — `шинок` в «машинок», `inn` в «Finn». Оба следствия
 * одинаковы: панель костей и выпивки открывается посреди дороги.
 */
test('глагол в названии сцены таверной не делает', () => {
  const notTavern = [
    'Отряд постоял у ворот',
    'Стража постояла и разошлась',
    'Войско постояло у брода',
    'Солнце постояло в зените',
    'Пивная бочка в подвале',
    'Пивной погреб под лестницей',
    'Полка со швейных машинок',
    'Finn у костра',
    'Republic Square',
  ]
  for (const title of notTavern) {
    assert.equal(isTavernScene(campaign({ scene: { title, location: title } })), false, `«${title}» опознано таверной`)
  }
  // И то же самое с другой стороны: заведения из списка опознаются во всех
  // падежах, ради которых основы вообще закреплены окончаниями.
  const tavern = ['Постоялый двор у брода', 'Ночь у постоялого двора', 'Шинок у дороги', 'The Broken Inn', 'Old Alehouse']
  for (const title of tavern) {
    assert.equal(isTavernScene(campaign({ scene: { title, location: title } })), true, `«${title}» таверной не опознано`)
  }
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

test('соперник мечет первым, и ставка героя тем же событием уходит из кошелька на стол', () => {
  const state = campaign()
  const result = run(state, [open(HONEST, 50)], { diceValues: [14] })
  const opened = eventOf(result, 'TavernDiceRoundOpened')

  assert.ok(opened, 'раунд обязан открыться событием')
  assert.equal(opened.payload.round.npc_total, 14)
  assert.equal(opened.payload.round.target, 15, 'перебить — значит показать больше')
  assert.equal(opened.payload.round.stake_cp, 50)
  // Эскроу: ставка уходит из кошелька в банк стола вместе с костью соперника, а
  // не после расчёта. Ровно на этом держится вся цена ухода из раунда.
  assert.equal(opened.payload.balance_before_cp, 100)
  assert.equal(opened.payload.balance_after_cp, 50)
  assert.equal(purseCp(result.state), 50, 'кость легла — ставка уплачена')
  assert.equal(tavernRoundFor(result.state, 'hero').hero_id, 'hero')

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
  assert.equal(tavernRoundFor(win.state, 'hero'), null)
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

/**
 * Зонд ревью: герой открыл раунд и тут же получил по голове. Пока раунд был
 * одним слотом на всё заведение, отвечать на брошенную кость было некому
 * (`ACTOR_DEFEATED`), снять её нечем, а сесть за стол другому — нельзя
 * (`TAVERN_ROUND_ALREADY_OPEN`): кости умирали для всего зала до смены сцены.
 */
test('раунд ключуется героем: упавший за столом не запирает кости всему залу', () => {
  const table = campaign({ heroIds: ['hero', 'hero-2'], currency: { copper: 0, silver: 0, gold: 2, platinum: 0 } })
  const opened = run(table, [open(HONEST, 10)], { diceValues: [12] }).state
  const fallen = downed(opened, 'hero')
  rejects(fallen, [answer()], 'ACTOR_DEFEATED')

  const second = run(fallen, [{ ...open(CROOK, 10), actor_id: 'hero-2' }], { diceValues: [8] })
  assert.equal(tavernRoundFor(second.state, 'hero-2').npc_id, CROOK, 'второй герой садится за свой стол')
  assert.equal(tavernRoundFor(second.state, 'hero').npc_id, HONEST, 'чужой раунд при этом остался нетронутым')

  const answered = run(second.state, [{ ...answer(), actor_id: 'hero-2' }], { diceValues: [20] })
  assert.equal(eventOf(answered, 'TavernDiceRoundResolved').payload.hero_id, 'hero-2')
  assert.equal(tavernRoundFor(answered.state, 'hero-2'), null, 'свой раунд закрыт')
  assert.ok(tavernRoundFor(answered.state, 'hero'), 'а чужой ждёт своего героя')

  // Каждый видит за столом только свой раунд: чужая кость в его карточке не
  // появляется и кнопки ему не блокирует.
  const cardFor = (heroId) => campaignStateForViewer(answered.state, { id: 'user-1', role: 'player', heroIds: [heroId] }, heroId).tavern
  assert.equal(cardFor('hero').round.npc_id, HONEST)
  assert.equal(cardFor('hero-2').round, null)

  // Поднявшийся на ноги герой доигрывает свой раунд там, где его прервали.
  const healed = normalizeCampaignState({
    ...answered.state,
    players: answered.state.players.map((player) => (player.id === 'hero' ? { ...player, hp: 9 } : player)),
  })
  const revived = run(healed, [answer()], { diceValues: [19] })
  assert.equal(eventOf(revived, 'TavernDiceRoundResolved').payload.npc_id, HONEST)
})

/**
 * Банк не берётся из ниоткуда. Зонд ревью: `delta_cp 200`, а ни один кошелёк
 * NPC при этом не худел — стол на 200 мм был печатным станком, тем более что
 * скандалы и запрет входа обнуляются уходом из зала.
 */
test('выигранный банк приходит из кармана соперника и когда-нибудь кончается', () => {
  const rich = { copper: 0, silver: 0, gold: 100, platinum: 0 }
  const start = tavernGamblerPurseFor(campaign({ currency: rich }), HONEST)
  assert.ok(start >= TAVERN_GAMBLER_PURSE_BASE_CP, 'вечерняя касса соседа выводится из сида кампании')

  const opened = run(campaign({ currency: rich }), [open(HONEST, 200)], { diceValues: [5] })
  const win = run(opened.state, [answer()], { diceValues: [19] })
  const resolved = eventOf(win, 'TavernDiceRoundResolved')
  assert.equal(resolved.payload.outcome, 'win')
  // Сверяется `net_cp`, а не `delta_cp`, и разница между ними — это и есть
  // эскроу: в кошелёк приходит весь банк (обе ставки), а у соперника убывает
  // только его половина. Своя ставка ушла из кармана ещё на открытии раунда.
  assert.equal(resolved.payload.delta_cp, 400, 'со стола в кошелёк приходит банк целиком')
  assert.equal(resolved.payload.net_cp, 200, 'а раунд принёс ровно одну ставку')
  assert.equal(resolved.payload.npc_purse_before_cp - resolved.payload.npc_purse_after_cp, resolved.payload.net_cp,
    'сколько выиграл герой, столько и ушло у соперника')
  assert.equal(tavernGamblerPurseFor(win.state, HONEST), start - 200)

  // Проигрыш едет в ту же кассу обратно: деньги переезжают, а не появляются.
  const lost = run(run(win.state, [open(HONEST, 200)], { diceValues: [18] }).state, [answer()], { diceValues: [3] })
  assert.equal(tavernGamblerPurseFor(lost.state, HONEST), start)

  // До дна касса доходит за считаные раунды, и дальше играть с соседом не о чем.
  let state = campaign({ currency: rich })
  let rounds = 0
  while (tavernMaxStakeFor(state, HONEST) >= 200 && rounds < 12) {
    state = run(state, [open(HONEST, 200)], { diceValues: [5] }).state
    state = run(state, [answer()], { diceValues: [19] }).state
    rounds += 1
  }
  assert.equal(rounds, Math.floor(start / 200), 'касса кончается ровно на своём числе раундов')
  rejects(state, [open(HONEST, 200)], 'TAVERN_OPPONENT_BROKE')

  // Уход из зала и возврат обратно кассу не воскрешают — иначе предела бы не
  // было: скандалы и запрет входа сменой сцены как раз обнуляются.
  const moved = replayEvents(state, [{
    event_id: 'evt-scene', command_id: 'cmd-scene', event_type: 'SceneAdvanced', actor_id: null,
    target_ids: [], visibility: 'party',
    payload: { scene: { title: INN, location: INN, location_id: 'inn' } },
    state_version_after: state.state_version + 1,
  }])
  assert.equal(tavernGamblerPurseFor(moved, HONEST), tavernGamblerPurseFor(state, HONEST))
  rejects(moved, [open(HONEST, 200)], 'TAVERN_OPPONENT_BROKE')

  // Игроку это видно кнопкой, а не отказом после клика.
  const card = campaignStateForViewer(moved, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero').tavern
  assert.ok(card.opponents.find((npc) => npc.id === HONEST).max_stake_cp < 200)
  assert.equal(JSON.stringify(card).includes('purse'), false, 'чужая бухгалтерия игроку не уезжает')
})

/**
 * Зонд ревью: «печатный станок» с другой стороны. Карта касс резалась срезом
 * (`Object.entries(...).slice(0, MAX_GAMBLERS)`), и записи после двадцать
 * четвёртой молча выпадали — а записи, которой нет, не существует: кошелёк
 * соседа воскресал из сида полным. Достаточно было пересидеть за столом с
 * двумя дюжинами соседей, чтобы обыгранный дочиста первый снова стал богат.
 */
test('касса вытесняется по последней игре, а не срезом: двадцать пятый выбивает первого', () => {
  const stale = {}
  for (let index = 0; index < 24; index += 1) {
    stale[`patron-${index}`] = { purse_cp: 500 + index, last_played_at_minutes: 100 + index }
  }
  const crowded = normalizeTavernState({
    gamblers: { ...stale, 'patron-24': { purse_cp: 7, last_played_at_minutes: 900 } },
  })
  assert.equal(Object.keys(crowded.gamblers).length, 24, 'предел у карты касс остаётся')
  assert.equal(crowded.gamblers['patron-24']?.purse_cp, 7, 'новая запись обязана остаться: с этим соседом играли только что')
  assert.equal(crowded.gamblers['patron-0'], undefined, 'уходит тот, с кем не играли дольше всех')
  assert.equal(crowded.gamblers['patron-1']?.purse_cp, 501, 'остальные остаются нетронутыми')

  // Порядок появления к вытеснению отношения не имеет: последним в карту может
  // попасть тот, с кем сыграли давно.
  const oldestIsLast = normalizeTavernState({
    gamblers: {
      ...Object.fromEntries(Object.entries(stale).map(([id, gambler]) => [id, { ...gambler, last_played_at_minutes: 500 }])),
      'patron-late': { purse_cp: 3, last_played_at_minutes: 1 },
      'patron-now': { purse_cp: 9, last_played_at_minutes: 900 },
    },
  })
  assert.equal(oldestIsLast.gamblers['patron-late'], undefined, 'вытесняется самая старая, а не последняя добавленная')
  assert.equal(oldestIsLast.gamblers['patron-now']?.purse_cp, 9)

  // И то, ради чего всё это: обыгранный дочиста сосед деньги из сида не
  // воскрешает, даже когда зал за вечер перебрал больше соседей, чем помнит.
  const drained = normalizeCampaignState({
    ...campaign(),
    tavern: { patrons: {}, gamblers: { ...stale, [HONEST]: { purse_cp: 0, last_played_at_minutes: 900 } } },
  })
  assert.equal(tavernGamblerPurseFor(drained, HONEST), 0, 'касса того, с кем играли последним, не возрождается')
  assert.equal(tavernMaxStakeFor(drained, HONEST), 0)
  rejects(drained, [open(HONEST, 10)], 'TAVERN_OPPONENT_BROKE')
})

/**
 * Тот же класс дыры, что у касс, и с худшим следствием: посетители резались
 * срезом (`Object.entries(...).slice(0, MAX_PATRONS)`), а выпавшая запись
 * обнуляет герою кружки, скандалы и запрет входа — выставленный за дверь шулер
 * снова становится желанным гостем и садится за стол.
 *
 * Практически недостижимо (записи заводятся только на героев отряда), но защита
 * от роста дырой быть не должна и в недостижимой ветке.
 */
test('посетители вытесняются по весу записи, а не срезом: пустые уходят первыми', () => {
  const empty = {}
  for (let index = 0; index < 12; index += 1) empty[`walker-${index}`] = { drinks: 0, scandals: 0, ejected: false }
  const crowded = normalizeTavernState({
    patrons: { barred: { drinks: 0, scandals: 2, ejected: true }, ...empty },
  })
  assert.equal(Object.keys(crowded.patrons).length, 12, 'предел у карты посетителей остаётся')
  assert.equal(crowded.patrons.barred?.ejected, true, 'выставленный за дверь не возвращается в зал вытеснением')
  assert.equal(crowded.patrons['walker-0'], undefined, 'уходит запись, которой всё равно что нет')

  // Порядок появления к вытеснению отношения не имеет, а вес — имеет: пустая
  // запись уходит и тогда, когда попала в снимок первой.
  const weighted = normalizeTavernState({
    patrons: {
      ...empty,
      drinker: { drinks: 3, scandals: 0, ejected: false },
      scandalous: { drinks: 0, scandals: 1, ejected: false },
    },
  })
  assert.equal(weighted.patrons.drinker?.drinks, 3)
  assert.equal(weighted.patrons.scandalous?.scandals, 1)
  assert.equal(Object.keys(weighted.patrons).length, 12)

  // Переезд легаси-раунда идёт до предела, а не после: тринадцатой записи
  // сверх него не появляется.
  const legacy = normalizeTavernState({
    patrons: empty,
    round: { id: 'r-1', hero_id: 'latecomer', npc_id: HONEST, stake_cp: 10, npc_total: 12 },
  })
  assert.equal(Object.keys(legacy.patrons).length, 12)
  assert.equal(legacy.patrons.latecomer?.round?.id, 'r-1', 'легаси-раунд переезжает, а не теряется')
})

test('минута последней игры приезжает событием, а не часами машины', () => {
  const opened = run(campaign({ minutes: 40 }), [open(HONEST, 10)], { diceValues: [11] })
  const settled = run(opened.state, [answer()], { diceValues: [17] })
  const resolved = eventOf(settled, 'TavernDiceRoundResolved')
  assert.equal(
    normalizeTavernState(settled.state.tavern).gamblers[HONEST].last_played_at_minutes,
    resolved.payload.at_minutes,
    'ключ вытеснения выводится из журнала, поэтому replay вытесняет тех же',
  )
})

// ---------------------------------------------------------------------------
// Раунд без броска: отмена и автозакрытие
// ---------------------------------------------------------------------------

/**
 * Зонд ревью: тупик открытого раунда. Раунд ключуется героем, а касса у соседа
 * общая — обыграть его дочиста может один игрок, пока второй ещё думает над
 * своей костью. Второму после этого ответить нечем (`TAVERN_OPPONENT_BROKE`),
 * а команды закрыть раунд не было: кости для него запирались до конца сцены.
 */
test('обыгранный дочиста соперник закрывает чужой раунд, а не запирает его', () => {
  const rich = { copper: 0, silver: 0, gold: 100, platinum: 0 }
  // Касса ровно в одну крупную ставку: закрыть банк соперник может один раз.
  const table = normalizeCampaignState({
    ...campaign({ heroIds: ['hero', 'hero-2'], currency: rich }),
    tavern: { patrons: {}, gamblers: { [HONEST]: { purse_cp: 200, last_played_at_minutes: 0 } } },
  })
  const first = run(table, [open(HONEST, 200)], { diceValues: [7] }).state
  const second = run(first, [{ ...open(HONEST, 200), actor_id: 'hero-2' }], { diceValues: [6] }).state
  assert.equal(tavernOpenRoundsAgainst(second, HONEST).length, 2, 'за одним соседом сидят оба героя')

  const purseBefore = purseCp(second, 'hero')
  const won = run(second, [{ ...answer(), actor_id: 'hero-2' }], { diceValues: [19] })
  assert.equal(eventOf(won, 'TavernDiceRoundResolved').payload.outcome, 'win')
  assert.equal(tavernGamblerPurseFor(won.state, HONEST), 0, 'сосед выгреб карманы')

  const cancelled = eventOf(won, 'TavernDiceRoundCancelled')
  assert.ok(cancelled, 'чужой раунд обязан закрыться событием, а не остаться висеть')
  assert.equal(cancelled.payload.hero_id, 'hero', 'закрылся раунд того, кто ответить уже не может')
  assert.equal(cancelled.actor_id, 'hero', 'в летописи стоит владелец раунда, а не тот, чья команда его закрыла')
  assert.equal(cancelled.payload.reason, 'opponent-broke')
  assert.equal(cancelled.payload.returned_cp, 200, 'тупик устроил не герой — эскроу возвращается')
  assert.equal(cancelled.payload.forfeited_cp, 0)
  assert.equal(tavernRoundFor(won.state, 'hero'), null, 'раунд снят')
  assert.equal(purseCp(won.state, 'hero'), purseBefore + 200, 'зарезервированная ставка вернулась в кошелёк')
  // И вернулась она со стола, а не из кармана соседа: тот и так на нуле.
  assert.equal(tavernGamblerPurseFor(won.state, HONEST), 0)

  // И за стол можно сесть заново — с тем, у кого ещё есть деньги.
  const again = run(won.state, [open(CROOK, 10)], { diceValues: [9] })
  assert.equal(tavernRoundFor(again.state, 'hero').npc_id, CROOK)
})

test('раунд закрывается только у тех, чью ставку соперник уже не тянет', () => {
  const rich = { copper: 0, silver: 0, gold: 100, platinum: 0 }
  const table = normalizeCampaignState({
    ...campaign({ heroIds: ['hero', 'hero-2'], currency: rich }),
    tavern: { patrons: {}, gamblers: { [HONEST]: { purse_cp: 250, last_played_at_minutes: 0 } } },
  })
  // Мелкая ставка первого героя соседу по карману и после проигрыша: у него
  // остаётся 50 мм, а поставлено 10.
  const first = run(table, [open(HONEST, 10)], { diceValues: [7] }).state
  const second = run(first, [{ ...open(HONEST, 200), actor_id: 'hero-2' }], { diceValues: [6] }).state
  const won = run(second, [{ ...answer(), actor_id: 'hero-2' }], { diceValues: [19] })

  assert.equal(eventOf(won, 'TavernDiceRoundCancelled'), null, 'чужой раунд по карману — и закрывать его нечего')
  assert.ok(tavernRoundFor(won.state, 'hero'), 'мелкая игра продолжается')
  const answered = run(won.state, [answer()], { diceValues: [20] })
  assert.equal(eventOf(answered, 'TavernDiceRoundResolved').payload.outcome, 'win')
})

/**
 * Зонд ревью с зубами, и он пережил одну заплату: «встать из-за стола» было
 * бесплатным перебросом чужой кости, и стол становился ровно тем печатным
 * станком, против которого заводили кассу соперника.
 *
 * Число соперника видно **до** решения — оно и в проекции, и в событии, и на
 * панели доски прямым текстом, — а уход не стоил ни монеты, ни мировой минуты,
 * ни счётчика. Зонд: шесть подряд «открыл — встал» отдали чужие кости 20, 17,
 * 14, 11, 8, 5 при неподвижном кошельке; цикл «увидел много — встал, увидел
 * мало — ответил» приносил чистую прибыль при нулевом риске.
 *
 * Первая заплата была запретом (уйти можно только из тупика), и второе ревью
 * прошло сквозь неё за один ход — см. тест про кружку эля ниже. Держит цикл не
 * запрет, а цена: ставка уходит из кошелька вместе с костью на столе, поэтому
 * уход стоит ровно столько же, сколько проигрыш. Здесь проверяется сам цикл, а
 * не одна команда.
 */
test('чужую кость нельзя перебросить, встав из-за стола: цикл стоит ставки за круг', () => {
  const rich = { copper: 0, silver: 0, gold: 100, platinum: 0 }
  let state = campaign({ currency: rich })
  const purseBefore = purseCp(state)
  // Соперник мечет высоко раз за разом — ровно тот случай, ради которого зонд
  // и вставал из-за стола. Теперь он встаёт, и каждый раз это стоит ставки.
  for (const die of [20, 17, 14, 11, 8, 5]) {
    state = run(state, [open(HONEST, 10)], { diceValues: [die] }).state
    assert.equal(tavernRoundUnanswerableReason(state, tavernRoundFor(state, 'hero')), null, 'кость жива, тупика нет')
    const left = run(state, [leave()])
    const cancelled = eventOf(left, 'TavernDiceRoundCancelled')
    assert.equal(cancelled.payload.reason, 'surrendered', 'уход от живой кости — это сдача')
    assert.equal(cancelled.payload.returned_cp, 0, 'и возвращать за неё нечего')
    assert.equal(cancelled.payload.forfeited_cp, 10)
    state = left.state
  }
  assert.equal(purseCp(state), purseBefore - 6 * 10, 'шесть побегов от кости стоили шести ставок')
  // Ставка сдавшегося уезжает в карман соседа, а не растворяется: деньги за этим
  // столом переезжают.
  assert.equal(tavernGamblerPurseFor(state, HONEST), tavernGamblerPurseFor(campaign({ currency: rich }), HONEST) + 6 * 10)

  // И тот же цикл, доигранный до конца, стоит ровно столько же: выбор между
  // «встать» и «ответить и проиграть» деньгами больше не отличается.
  let played = campaign({ currency: rich })
  for (const die of [20, 17, 14, 11, 8, 5]) {
    played = run(played, [open(HONEST, 10)], { diceValues: [die] }).state
    played = run(played, [answer()], { diceValues: [1] }).state
  }
  assert.equal(purseCp(played), purseCp(state), 'сдача и проигрыш стоят одного')
})

test('из-за стола встают там, где отвечать уже нечем, и ставка возвращается со стола', () => {
  const opened = run(campaign(), [open(HONEST, 50)], { diceValues: [14] })
  assert.equal(purseCp(opened.state), 50, 'ставка уже на столе')
  // Пока герой думал, соперника обыграл дочиста товарищ по отряду: банк ему уже
  // не закрыть, и раунд стал тупиком — ровно тем, ради которого команда есть.
  const stuck = normalizeCampaignState({
    ...opened.state,
    tavern: { ...opened.state.tavern, gamblers: { [HONEST]: { purse_cp: 0, last_played_at_minutes: 1 } } },
  })
  assert.equal(tavernRoundUnanswerableReason(stuck, tavernRoundFor(stuck, 'hero')), 'opponent-broke')
  const left = run(stuck, [leave()])

  const cancelled = eventOf(left, 'TavernDiceRoundCancelled')
  assert.ok(cancelled, 'встать из-за стола — это событие, а не молчаливая правка состояния')
  assert.equal(cancelled.payload.reason, 'opponent-broke', 'повод называет сервер, а не команда')
  assert.equal(cancelled.payload.returned_cp, 50)
  assert.equal(cancelled.payload.forfeited_cp, 0)
  assert.equal(cancelled.visibility, 'party')
  assert.equal(left.rolls.length, 0, 'броска здесь нет')
  assert.equal(tavernRoundFor(left.state, 'hero'), null)
  assert.equal(purseCp(left.state), 100, 'тупик устроил не герой — эскроу вернулся целиком')

  rejects(left.state, [leave()], 'TAVERN_ROUND_NOT_OPEN')
  const again = run(left.state, [open(CROOK, 10)], { diceValues: [9] })
  assert.equal(tavernRoundFor(again.state, 'hero').npc_id, CROOK, 'за стол можно сесть заново')
})

/**
 * Находка второго ревью, и она проходила ровно сквозь заплату первого: кружка
 * эля за 4 мм покупала бесплатный выход из проигрышного раунда.
 *
 * При ставке 200 и кошельке 200 герой видел чужие 19, заказывал выпивку, ронял
 * кошелёк до 196 — и раунд становился «неотвечаемым по бедности» (`hero-broke`),
 * то есть законным тупиком, из которого выход был даром. Цена такой отмены — 4
 * мм вместо 200.
 *
 * Лечится это не запретом, а эскроу: ставка уже уплачена, отвечать можно с
 * пустым кошельком, и бедность поводом тупика быть не может по построению.
 */
test('кружка эля больше не выкупает выход из проигрышного раунда', () => {
  // Кошелёк подобран под сам зонд: 204 мм — это ставка в 200 и ровно одна
  // кружка сверху. Тем и брали: заказал, уронил остаток ниже ставки, встал.
  const probe = { copper: 4, silver: 0, gold: 2, platinum: 0 }
  const opened = run(campaign({ currency: probe }), [open(HONEST, 200)], { diceValues: [19] })
  assert.equal(purseCp(opened.state), 4, 'ставка ушла на стол, в кармане — на кружку')

  const drunk = run(opened.state, [drink()])
  assert.equal(purseCp(drunk.state), 0, 'кружка выпита, кошелёк ниже ставки — та самая подстановка зонда')
  // И это больше не тупик: ставка уплачена, а бедность отвечать не мешает.
  assert.equal(tavernRoundUnanswerableReason(drunk.state, tavernRoundFor(drunk.state, 'hero')), null)

  // Отвечать пустой кошелёк не мешает — раньше здесь стоял INSUFFICIENT_FUNDS.
  const answered = run(drunk.state, [answer()], { diceValues: [20] })
  assert.equal(eventOf(answered, 'TavernDiceRoundResolved').payload.outcome, 'win')
  assert.equal(purseCp(answered.state), 400, 'банк целиком: своя ставка со стола и выигранная')

  // А уход от той же кости стоит ставки — за это эскроу и заводился. Цена зонда
  // была 4 мм, стала 200.
  const left = run(drunk.state, [leave()])
  assert.equal(eventOf(left, 'TavernDiceRoundCancelled').payload.reason, 'surrendered')
  assert.equal(purseCp(left.state), 0, 'ставка осталась на столе')
  assert.equal(tavernGamblerPurseFor(left.state, HONEST), tavernGamblerPurseFor(campaign(), HONEST) + 200)
})

/**
 * Второй тупик того же раунда, и единственный, до которого правило добирается не
 * деньгами: героя выставили за дверь. Отвечать ему запрещено
 * (`TAVERN_PATRON_EJECTED`), значит выход из-за стола обязан остаться открытым —
 * иначе запрет входа запирал бы раунд до конца сцены, а вместе с ним и ставку.
 *
 * Ставка при этом возвращается: выставил героя не он сам, и это не сдача.
 */
test('выставленный за дверь встаёт из-за стола, и ставка возвращается ему со стола', () => {
  const opened = run(campaign(), [open(HONEST, 10)], { diceValues: [12] }).state
  const barred = normalizeCampaignState({
    ...opened,
    tavern: {
      ...opened.tavern,
      patrons: { ...opened.tavern.patrons, hero: { ...opened.tavern.patrons.hero, ejected: true } },
    },
  })
  rejects(barred, [answer()], 'TAVERN_PATRON_EJECTED')
  assert.equal(tavernRoundUnanswerableReason(barred, tavernRoundFor(barred, 'hero')), 'patron-ejected')
  const purseBefore = purseCp(barred)
  const left = run(barred, [leave()])
  const cancelled = eventOf(left, 'TavernDiceRoundCancelled')
  assert.equal(cancelled.payload.reason, 'patron-ejected')
  assert.equal(cancelled.payload.returned_cp, 10)
  assert.equal(tavernRoundFor(left.state, 'hero'), null)
  assert.equal(purseCp(left.state), purseBefore + 10, 'выставленному ставку возвращают')

  // И путь к этой кнопке у выставленного есть: подсказка зовёт закрыть раунд, а
  // не молчит. До ревью запрет входа обрывал подсказки первой же строкой.
  const hints = suggestedActionsFor(campaignStateForViewer(barred, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero'))
  assert.ok(hints.some((hint) => /встать из-за стола|раунд остаётся закрыть/iu.test(hint.text)), 'выставленному нужен выход из раунда')
})

// ---------------------------------------------------------------------------
// Шулерство в обе стороны
// ---------------------------------------------------------------------------

/**
 * Зонд ревью: СЛ обеих проверок стола уезжает игроку в `AbilityCheckResolved`
 * с видимостью `party` и рисуется на карточке броска. Пока к ней прибавлялись
 * два очка за шулерство, диапазоны честного (10–14) и краплёного (12–16) не
 * совпадали на краях: СЛ 10 доказывала, что сосед чист, СЛ 16 — что нет. Это
 * 40% соперников, опознанных бесплатно.
 */
test('СЛ проверок за столом одна и та же у честного и у шулера', () => {
  const state = campaign()
  const honest = { insight: new Set(), tell: new Set() }
  const crooked = { insight: new Set(), tell: new Set() }
  for (let index = 0; index < 300; index += 1) {
    const gambler = tavernGamblerFor(state, `patron-${index}`)
    const bucket = gambler.crooked ? crooked : honest
    bucket.insight.add(gambler.insight_passive)
    bucket.tell.add(gambler.tell_dc)
  }
  assert.ok(crooked.insight.size > 1 && honest.insight.size > 1, 'выборка обязана взять и честных, и шулеров')
  const sorted = (values) => [...values].sort((left, right) => left - right)
  assert.deepEqual(sorted(crooked.insight), sorted(honest.insight), 'по СЛ Ловкости рук шулер не отличим')
  assert.deepEqual(sorted(crooked.tell), sorted(honest.tell), 'и по СЛ Проницательности тоже')

  // То же самое на живом пути: число, которое видит игрок, лежит в общем
  // диапазоне независимо от того, с кем он сел играть.
  const shownDc = (npcId) => {
    const opened = run(campaign(), [open(npcId, 10)], { diceValues: [12] })
    const watched = run(opened.state, [answer('watch')], { diceValues: [10, 5] })
    return eventOf(watched, 'AbilityCheckResolved').payload.difficulty
  }
  const shared = sorted(honest.tell)
  for (const npcId of [HONEST, CROOK]) {
    assert.ok(shared.includes(shownDc(npcId)), `СЛ ${shownDc(npcId)} вне общего диапазона ${shared.join('/')}`)
  }
})

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

/**
 * Зонд ревью: карточка ручного броска печатала «модификатор +0», а исполнение
 * считало с `+5` — игрок видел «нужно 16», а хватало 11. Числа сходятся только
 * если надбавка известна до карточки, и она известна: подход герой называет
 * сам, а проверка Ловкости рук решает не размер надбавки, а то, поймают ли за
 * руку.
 */
test('подкрутка считается одним числом и в карточке броска, и в исполнении', () => {
  const opened = run(campaign(), [open(HONEST, 50)], { diceValues: [14] }).state
  assert.equal(previewTavernDiceRoll(opened, 'hero', 'cheat').modifier, TAVERN_CHEAT_BONUS)
  assert.equal(previewTavernDiceRoll(opened, 'hero', 'fair').modifier, 0)
  assert.equal(previewTavernDiceRoll(opened, 'hero', 'watch').modifier, 0)
  // Неизвестный подход движок приводит к честному броску — предпросмотр тоже.
  assert.equal(previewTavernDiceRoll(opened, 'hero', 'подкрутить').modifier, 0)
  assert.equal(previewTavernDiceRoll(opened, 'hero', 'cheat').difficulty, 15)

  // Пойманный за руку считается по тому же модификатору: кость он подменить
  // успел, ставку у него забирают не за это.
  const caught = run(opened, [answer('cheat')], { diceValues: [1, 9] })
  const resolved = eventOf(caught, 'TavernDiceRoundResolved')
  assert.equal(resolved.payload.hero_total, 9 + TAVERN_CHEAT_BONUS)
  assert.equal(resolved.payload.outcome, 'caught')
  assert.equal(resolved.payload.cheated, false, '«подкрутил» в летописи — это «подкрутил и не попался»')
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

/**
 * Зонд ревью, и он с зубами: настоящая кость шулера уезжала игроку в ответе на
 * его же команду.
 *
 * Каналов у ответа два — массив `rolls` и `effects.roll`, — и защита стояла
 * ровно на одном. `rollForClient` (`server/game-orchestrator.mjs`) не переносил
 * `visibility`, поэтому фильтр `rollVisibleFor` читал `undefined`, подставлял
 * `public` и пропускал бросок насквозь: столу объявлено 12, а в `effects.roll`
 * того же ответа лежали выпавшие 7 — разница ровно в надбавке шулера, которую
 * игрок обязан искать Проницательностью, а не вычитанием.
 *
 * Сторожа молчали потому, что `mechanicsForViewer` смотрит только канал событий,
 * а сквозные пробы шага ходят администратором — ему `turnResultForViewer`
 * отдаёт результат сырым первой же строкой. Поэтому проба здесь идёт глазами
 * игрока и через оба канала сразу.
 */
test('выпавшая кость соперника не уезжает игроку ни массивом бросков, ни effects.roll', () => {
  const crooked = run(campaign(), [open(CROOK, 10)], { diceValues: [7] })
  const shown = eventOf(crooked, 'TavernDiceRoundOpened').payload.round.npc_total
  assert.equal(shown, 7 + TAVERN_CHEAT_BONUS, 'на стол легло подменённое число')

  const result = {
    narration: '',
    effects: eventsToClientEffects(crooked.events, crooked.rolls),
    mechanics: crooked.events,
    rolls: crooked.rolls,
    visible_state_changes: [],
    authoritative_state: crooked.state,
  }
  // Ведущему правда остаётся: gm_only — это его канал, он и судит по числам.
  const master = turnResultForViewer(result, { id: 'gm-1', role: 'admin' }, 'hero')
  assert.equal(master.effects.roll.value, 7, 'ведущий видит выпавшее, а не показанное')

  const player = turnResultForViewer(result, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  assert.equal(player.effects.roll, undefined, 'кубик соперника игроку не уезжает лотком')
  assert.deepEqual(player.rolls, [], 'и массивом бросков — тоже')
  const serialized = JSON.stringify(player)
  assert.equal(serialized.includes('tavern-dice:opponent'), false, 'броска соперника в ответе игрока нет вовсе')
  // Показанное число при этом на месте: скрывается разница, а не игра.
  assert.equal(
    player.mechanics.find((event) => event.event_type === 'PublicDieRolled').payload.roll.value,
    shown,
  )
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
  assert.equal(tavernRoundFor(moved, 'hero'), null)
})

// ---------------------------------------------------------------------------
// Replay и проекция
// ---------------------------------------------------------------------------

test('replay журнала даёт тот же счёт заведения и тот же кошелёк', () => {
  // Кошелёк подобран числом, а не на глаз: 73 мм закрывают ставку в 50, после
  // потерянной ставки остаётся 23 — хватает на ставку в 10 и на две кружки
  // сверху. Журнал проходит через все четыре денежных события стола: резерв
  // ставки, расчёт, цену кружки и отмену раунда сдачей. Попасть туда журналом,
  // а не правкой снимка, важно: этот тест как раз про то, что счёт выводится из
  // событий.
  const start = campaign({ currency: { copper: 3, silver: 7, gold: 0, platinum: 0 } })
  const opened = run(start, [open(CROOK, 50)], { diceValues: [9] })
  const answered = run(opened.state, [answer('cheat')], { diceValues: [1, 14] })
  // Раунд, закрытый без броска, в журнале живёт наравне с остальными: снятый
  // стол обязан воспроизводиться, а не оставаться открытым при реплее.
  const abandoned = run(answered.state, [open(HONEST, 10)], { diceValues: [13] })
  const sober = run(abandoned.state, [drink()])
  const stoodUp = run(sober.state, [leave()])
  const drunkRun = run(stoodUp.state, [drink()])
  const events = [...opened.events, ...answered.events, ...abandoned.events, ...sober.events, ...stoodUp.events, ...drunkRun.events].map((event, index) => ({
    ...event,
    event_id: event.event_id ?? `evt-${index + 1}`,
    state_version_after: index + 2,
  }))
  const replayed = replayEvents(start, events)

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

/**
 * Зонд ревью: та же дыра с другой стороны стола. Карточка заведения кассу
 * соседа прячет намеренно — игроку уезжает `max_stake_cp`, доступная ставка, а
 * не сумма в кармане, — а расчёт раунда нёс `npc_purse_before_cp` и
 * `npc_purse_after_cp` в party-канале. Состояние и канал событий расходились
 * молча, ровно как у профиля NPC и реестра закона до ревью 2026-08-09.
 */
test('точные суммы чужой кассы не уезжают игроку и событием расчёта', () => {
  const viewer = { id: 'user-1', role: 'player', heroIds: ['hero'] }
  const opened = run(campaign(), [open(HONEST, 50)], { diceValues: [9] })
  const won = run(opened.state, [answer()], { diceValues: [18] })

  const raw = eventOf(won, 'TavernDiceRoundResolved')
  assert.ok(Number.isInteger(raw.payload.npc_purse_after_cp), 'движку и редьюсеру касса нужна: она едет журналом')

  const projected = mechanicsForViewer(won.events, viewer, 'hero', won.state)
    .find((event) => event.event_type === 'TavernDiceRoundResolved')
  assert.ok(projected, 'расчёт раунда игроку виден: это его деньги')
  assert.equal(projected.payload.npc_purse_before_cp, undefined)
  assert.equal(projected.payload.npc_purse_after_cp, undefined)
  assert.equal(JSON.stringify(projected.payload).includes('purse'), false, 'чужая бухгалтерия игроку не уезжает ничем')
  // Свой кошелёк при этом остаётся на месте: режется чужая касса, а не расчёт.
  assert.equal(projected.payload.delta_cp, raw.payload.delta_cp)
  assert.equal(projected.payload.balance_after_cp, raw.payload.balance_after_cp)

  // Доступную ставку соседа игрок узнаёт из проекции состояния тем же числом,
  // что и до расчёта, — отказ движка обязан быть виден кнопкой.
  const card = campaignStateForViewer(won.state, viewer, 'hero').tavern
  assert.equal(card.opponents.find((npc) => npc.id === HONEST).max_stake_cp, tavernMaxStakeFor(won.state, HONEST))

  // Та же дыра с третьей стороны: с эскроу деньги двигает и **отмена** раунда —
  // ставка сдавшегося уезжает в карман соседа. Значит и это событие обязано
  // резаться тем же списком, иначе бухгалтерия соседа утекла бы новым путём.
  const left = run(run(campaign(), [open(HONEST, 50)], { diceValues: [17] }).state, [leave()])
  const rawCancel = eventOf(left, 'TavernDiceRoundCancelled')
  assert.equal(rawCancel.payload.reason, 'surrendered')
  assert.ok(Number.isInteger(rawCancel.payload.npc_purse_after_cp), 'движку и редьюсеру касса нужна: она едет журналом')
  const projectedCancel = mechanicsForViewer(left.events, viewer, 'hero', left.state)
    .find((event) => event.event_type === 'TavernDiceRoundCancelled')
  assert.ok(projectedCancel, 'закрытие раунда игроку видно: это его деньги')
  assert.equal(JSON.stringify(projectedCancel.payload).includes('purse'), false, 'чужая бухгалтерия игроку не уезжает ничем')
  assert.equal(projectedCancel.payload.forfeited_cp, 50, 'а своя ставка со стола названа прямо')
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

  // А если отвечать уже нечем — зовёт из-за стола, а не на бросок, которого не
  // будет. Доступная ставка соседа приезжает карточкой готовым числом.
  const broke = normalizeCampaignState({
    ...opened.state,
    tavern: { ...opened.state.tavern, gamblers: { [HONEST]: { purse_cp: 0, last_played_at_minutes: 1 } } },
  })
  const stuck = suggestedActionsFor(campaignStateForViewer(broke, viewer, 'hero'))
  assert.ok(stuck.some((hint) => /встать из-за стола/iu.test(hint.text)))
  assert.equal(stuck.some((hint) => /ответить на бросок/iu.test(hint.text)), false)
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

  // Ставка в летописи ложится на стол сразу: событие открытия само говорит,
  // что деньги ушли из кошелька.
  assert.match(openedText, /легли на стол|ставку сделал/iu)

  // Снятый раунд тоже говорит по-русски, и говорит про деньги разное: тупик
  // возвращает ставку, сдача её отдаёт.
  const abandoned = run(win.state, [open(HONEST, 10)], { diceValues: [8] }).state
  const stuck = normalizeCampaignState({
    ...abandoned,
    tavern: { ...abandoned.tavern, gamblers: { [HONEST]: { purse_cp: 0, last_played_at_minutes: 1 } } },
  })
  const stoodUp = run(stuck, [leave()])
  const leaveText = combatNarration(stoodUp.events, stoodUp.state)
  assert.match(leaveText, /возвращается/iu)
  assert.equal(/Tavern[A-Z]/u.test(leaveText), false)

  const surrendered = run(abandoned, [leave()])
  const surrenderText = combatNarration(surrendered.events, surrendered.state)
  assert.match(surrenderText, /встаёт, не ответив/iu)
  assert.match(surrenderText, /10 мм со стола забирает/iu)
  assert.equal(/Tavern[A-Z]/u.test(surrenderText), false)
})
