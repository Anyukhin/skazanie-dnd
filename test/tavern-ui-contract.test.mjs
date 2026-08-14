import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TAVERN_STAKES_CP, TAVERN_STAKE_LABELS, tavernForViewer, tavernMaxStakeFor } from '../server/tavern-life.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const INN = 'Трактир «У моста»'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'TAVERN-UI',
    campaign: 'Жизнь таверны',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: { title: INN, location: INN, location_id: 'inn', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [], currency: { copper: 0, silver: 0, gold: 5, platinum: 0 } }],
    social: {
      npcs: [
        { id: 'barkeep', name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' },
        { id: 'shadow', name: 'Тень у очага', role: 'никто', location: INN, visibility: 'gm_only', public_summary: 'Ведущему.' },
      ],
    },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
}

test('карточка заведения доезжает игроку готовой: соперники, ставки и цена кружки', () => {
  const player = campaignStateForViewer(campaign(), { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  const card = player.tavern

  assert.ok(card, 'в таверне карточка обязана быть')
  assert.deepEqual(card.opponents.map((npc) => npc.id), ['barkeep'], 'закрытый NPC за стол не садится')
  assert.deepEqual(card.stakes.map((stake) => stake.stake_cp), [...TAVERN_STAKES_CP])
  for (const stake of card.stakes) assert.equal(stake.label, TAVERN_STAKE_LABELS[stake.stake_cp])
  assert.ok(card.drink_price_cp > 0)
  assert.equal(card.round, null)
  assert.equal(card.next_drink_dc, null, 'первая кружка ещё безопасна')
  // Доступная ставка соседа приезжает готовым числом: банк берётся из его
  // кошелька, и клиент не должен ни считать его, ни узнавать о нём отказом.
  assert.equal(card.opponents[0].max_stake_cp, tavernMaxStakeFor(campaign(), 'barkeep'))
  assert.ok(TAVERN_STAKES_CP.includes(card.opponents[0].max_stake_cp))
  // Подписи ставок серверные: клиент их не сочиняет.
  assert.deepEqual(tavernForViewer(campaign(), { playerId: 'hero' }).stakes, card.stakes)
})

test('таверна живёт на доске отдельной панелью с костями и кружкой', () => {
  assert.match(board, /className="tavern-panel"/u)
  assert.match(board, /aria-label="Жизнь таверны"/u)
  assert.match(board, /state\.tavern \?\? null/u)
  assert.match(board, /onOpenTavernDiceRound\(chosenTavernOpponentId, chosenTavernStakeCp\)/u)
  assert.match(board, /onAnswerTavernDiceRound\(approach\.id\)/u)
  assert.match(board, /onOrderTavernDrink\(\)/u)
  // Три подхода к ответному броску — ровно те, что объявил сервер.
  assert.match(board, /id: 'fair' as const/u)
  assert.match(board, /id: 'cheat' as const/u)
  assert.match(board, /id: 'watch' as const/u)
  assert.match(board, /tavern-approach approach-\$\{approach\.id\}/u)
  // Ставка ограничена и чужим кошельком: сервер прислал доступный предел, и
  // кнопка обязана погаснуть до клика, а не после отказа.
  assert.match(board, /max_stake_cp/u)
  assert.match(board, /tavernOpponentMaxStakeCp < stake\.stake_cp/u)
  assert.match(board, /Соперник такую ставку не закроет/u)
  // Своей таблицы цен, ставок и СЛ у доски быть не должно.
  assert.doesNotMatch(board, /TAVERN_STAKES/u)
  assert.doesNotMatch(board, /DRINK_PRICE/u)
})

test('клиент называет только соперника, ставку и подход, а кубик берёт двухфазным', () => {
  assert.match(session, /command_type: 'OpenTavernDiceRound'/u)
  assert.match(session, /command_type: 'AnswerTavernDiceRound'/u)
  assert.match(session, /command_type: 'OrderTavernDrink'/u)
  // Ответный бросок идёт ручным кубиком, если автобросок выключен.
  assert.match(session, /\{ command_type: 'AnswerTavernDiceRound', actor_id: actorId, approach \},[\s\S]{0,160}manualRoll: !autoRollEnabled\(\)/u)
  assert.match(app, /onOpenTavernDiceRound=\{/u)
  assert.match(app, /onOrderTavernDrink=\{/u)
})

/**
 * Зонд ревью, и он с зубами: карточка ручного броска таверны не доходила до
 * игрока вовсе.
 *
 * Ветка `result?.check` была закрыта условием `command_type === 'ProposeParley'`,
 * а `answerTavernDiceRound` шлёт `manual_roll` — автобросок в проекте выключен
 * по умолчанию. Сервер возвращал карточку, клиент её отбрасывал, ниже начинался
 * разбор `authoritative_state`, которого у неоткоммиченной первой фазы нет, — и
 * раунд было нечем доиграть из интерфейса. Тем же условием молча терялась
 * карточка побега от стражи.
 *
 * Проверка идёт от причины, а не от списка: каждая команда, которую клиент
 * отправляет с ручным кубиком, обязана быть в развилке двухфазных. Забыть
 * четвёртую такую команду теперь нельзя — тест назовёт её сам.
 */
test('каждая команда с ручным кубиком доводит карточку броска до игрока', () => {
  // Тело функции берётся до закрывающей скобки нулевого отступа: вложенный
  // `switch` закрывается отступом, а сама функция — нет.
  const twoPhase = /function twoPhaseCheckCommandFor[\s\S]*?\r?\n\}/u.exec(session)?.[0] ?? ''
  const handled = new Set([...twoPhase.matchAll(/case '([A-Za-z]+)':/gu)].map((match) => match[1]))
  assert.ok(handled.size >= 3, `развилка двухфазных команд подозрительно пуста: ${[...handled].join(', ')}`)

  const chunks = session.split('manualRoll: !autoRollEnabled()')
  assert.ok(chunks.length > 1, 'ручной кубик из клиента никуда не делся')
  for (const chunk of chunks.slice(0, -1)) {
    const declared = [...chunk.matchAll(/command_type: '([A-Za-z]+)'/gu)].at(-1)?.[1]
    assert.ok(declared, 'команда с ручным кубиком обязана называть свой тип рядом с вызовом')
    assert.ok(
      handled.has(declared),
      `${declared} просит у сервера карточку броска, но клиент её не показывает: добавьте команду в twoPhaseCheckCommandFor`,
    )
  }
  // Три карточки на сервере — три ветки здесь: парлей, побег и кости.
  assert.deepEqual([...handled].sort(), ['AnswerTavernDiceRound', 'ProposeParley', 'ResolveGuardEncounter'])
})

test('открытый раунд можно закрыть без броска, и кнопка для этого есть', () => {
  assert.match(session, /command_type: 'LeaveTavernDiceRound'/u)
  assert.match(session, /leaveTavernDiceRound,/u)
  assert.match(app, /onLeaveTavernDiceRound=\{/u)
  assert.match(board, /onLeaveTavernDiceRound\(\)/u)
  assert.match(board, /Встать из-за стола/u)
  // Ответ гасит ровно одно положение — запрет входа: с выставленным за дверь не
  // садятся. Кнопки обязаны гаснуть до клика, а не приносить отказ после него.
  assert.match(board, /const tavernPatronEjected = tavern\?\.ejected === true/u)
  assert.match(board, /disabled=\{tavernActionsBlocked \|\| tavernPatronEjected\}/u)
  assert.match(styles, /\.tavern-leave \{/u)
  // Сама кнопка «встать» при этом горит всегда: ставка уже на столе, и уход от
  // кости — это сдача, а не запрещённый ход. Цену обязана называть подпись, а не
  // отказ сервера.
  assert.match(board, /className="tavern-action action-leave"[\s\S]{0,120}disabled=\{tavernActionsBlocked\}/u)
  assert.match(board, /ставку заберёт/u)
  // Ни своей арифметики чужой кассы, ни своего кошелька: возвратов у сдачи нет
  // ни одного, и обещать их доска не имеет права ни при каком счёте.
  assert.doesNotMatch(board, /activeHeroPurseCp < tavernRound/u)
  assert.doesNotMatch(board, /unanswerable/u, 'тупиков не бывает — читать доске нечего')
  assert.doesNotMatch(board, /вернётся в кошелёк|возвращаются со стола/u, 'ставка со стола не возвращается ничем')
})

/**
 * Находка ревью: «встать из-за стола» стала необратимой кнопкой в один клик.
 *
 * Раньше она была `disabled` вне тупика и стоила ноль; с эскроу один промах
 * отдаёт сопернику до 200 мм навсегда, а цена была названа только в `title` и в
 * подписи под кнопкой — то есть в тексте, который читают после клика, а не до.
 * Рядом на этой же панели уже есть штатный порядок для необратимых команд
 * (`combat-command-confirmation`): цель фиксируется, а команда ждёт
 * подтверждения.
 *
 * Спрашивается подтверждение **всегда**: цена у сдачи одна и возвратов нет, а
 * значит нет и положения, из которого терять нечего.
 */
test('сдача уходит вторым щелчком, и спрашивают об этом всегда', () => {
  // Подтверждение ключуется раундом, а не флагом: пока игрок думает, раунд
  // может закрыться и открыться заново уже против другого числа.
  assert.match(board, /const \[tavernSurrenderRoundId, setTavernSurrenderRoundId\] = useState\(''\)/u)
  assert.match(board, /tavernSurrenderPending = Boolean\(tavernRound && tavernSurrenderRoundId === tavernRound\.id\)/u)
  // Путь один, и он через подтверждение: второго ответа на «что делает эта
  // кнопка» быть не должно.
  assert.match(board, /if \(!tavernSurrenderPending\) \{ setTavernSurrenderRoundId\(tavernRound\.id\); return \}/u)
  // Цена стоит на самой кнопке подтверждения, а не только в подписи под ней.
  assert.match(board, /Подтвердить сдачу · −\$\{tavernRound\.stake_cp\} мм/u)
  assert.match(board, /Остаться за столом/u)
  assert.match(styles, /\.tavern-leave\.confirming \{/u)
  assert.match(styles, /\.tavern-action\.action-leave-cancel \{/u)
})

/**
 * Зонд повторного ревью: у выставленного за дверь не было пути с экрана.
 *
 * Панель рисовала ему **только** заметку — блок раунда стоял в другой ветке того
 * же тернарника и до него не доходил, — поэтому кнопки «Встать из-за стола» он
 * не видел, хотя движок её ему разрешает и деньги у него на столе. Подсказки
 * молчали тем же условием (`server/action-hints.mjs`).
 *
 * Проверяется структура, а не текст: заметка о запрете входа и блок раунда
 * обязаны стоять рядом, а не через «или».
 */
test('выставленному за дверь панель показывает его открытый раунд, а не одну заметку', () => {
  assert.match(board, /\{tavern\.ejected && <p className="tavern-note">/u, 'заметка о запрете входа — отдельная строка панели')
  assert.match(board, /\{tavernRound\s*\r?\n\s*\? </u, 'блок раунда решает сам за себя, а не после запрета входа')
  // Стол для новой игры выставленному по-прежнему не накрывают: заказать
  // выпивку и сесть за кости ему нельзя.
  assert.match(board, /: tavern\.ejected\s*\r?\n\s*\? null/u)
})

/**
 * Карточка раунда рассказывает только про стол: чужая кость, ставка и число,
 * которое надо перебить. Поля «почему раунд уже не доиграть» у неё нет, и это не
 * пропуск — тупиков не бывает: касса соперника закрепляет выплату за раундом с
 * самого открытия, а запрет входа приезжает своим полем карточки.
 *
 * Три положения проверяются разом, потому что все три когда-то давали доске
 * повод погасить кнопку ответа или пообещать возврат ставки.
 */
test('карточка раунда не обещает ни тупика, ни возврата ставки', () => {
  const round = { id: 'r-1', hero_id: 'hero', npc_id: 'barkeep', npc_name: 'Трактирщик Бажен', stake_cp: 200, npc_total: 17 }
  const state = normalizeCampaignState({
    ...campaign(),
    tavern: { patrons: { hero: { drinks: 0, scandals: 0, ejected: false, round } }, gamblers: {} },
  })
  const viewer = { id: 'user-1', role: 'player', heroIds: ['hero'] }
  const cardFor = (candidate) => campaignStateForViewer(candidate, viewer, 'hero').tavern
  assert.equal(cardFor(state).round.target, 18, 'карточка называет число, которое надо перебить')
  assert.equal(Object.hasOwn(cardFor(state).round, 'unanswerable_reason'), false, 'поводов у неё больше нет')

  // Пустая касса соседа карточку не меняет: банк по этому раунду закреплён за
  // ним с открытия, и доиграть его можно при любом счёте соседа.
  const broke = normalizeCampaignState({
    ...state,
    tavern: { ...state.tavern, gamblers: { barkeep: { purse_cp: 0, last_played_at_minutes: 1 } } },
  })
  assert.equal(cardFor(broke).round.id, 'r-1')
  assert.equal(JSON.stringify(cardFor(broke)).includes('unanswerable'), false)

  // Запрет входа приезжает своим полем — по нему доска и гасит кнопки ответа.
  const barred = normalizeCampaignState({
    ...state,
    tavern: { ...state.tavern, patrons: { hero: { ...state.tavern.patrons.hero, ejected: true } } },
  })
  assert.equal(cardFor(barred).ejected, true)
  assert.ok(cardFor(barred).round, 'а раунд у выставленного остаётся: его ещё надо закрыть')

  // Пустой кошелёк тупиком не считается: ставка ушла на стол при открытии
  // раунда, и отвечать бедность не мешает. Пока считался — кружка эля за 4 мм
  // выкупала бесплатный выход из проигрышного раунда.
  const poor = normalizeCampaignState({
    ...state,
    players: state.players.map((player) => ({ ...player, currency: { copper: 1, silver: 0, gold: 0, platinum: 0 } })),
  })
  assert.equal(cardFor(poor).round.id, 'r-1')
})

test('панель таверны оформлена и не ломает узкий экран', () => {
  assert.match(styles, /\.tavern-panel \{/u)
  assert.match(styles, /\.tavern-approach \{/u)
  assert.match(styles, /\.tavern-approach\.approach-cheat \{/u)
  assert.match(styles, /\.tavern-stakes button\.active \{/u)
  assert.match(styles, /\.tavern-drink \{/u)
  assert.match(styles, /\.tavern-approach \{ grid-template-columns: 1fr; \}/u)
})
