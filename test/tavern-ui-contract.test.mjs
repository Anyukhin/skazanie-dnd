import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TAVERN_STAKES_CP, TAVERN_STAKE_LABELS, tavernForViewer, tavernMaxStakeFor } from '../server/tavern-life.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
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
