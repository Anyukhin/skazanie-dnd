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
  // Отвечать на кость бывает нечем: соперника обыграл дочиста товарищ по
  // отряду или свои монеты ушли другой командой. Кнопки ответа обязаны гаснуть
  // до клика, а не приносить отказ после него.
  assert.match(board, /tavernRoundUnanswerable/u)
  assert.match(board, /Соперник спустил всё/u)
  assert.match(styles, /\.tavern-leave \{/u)
})

test('панель таверны оформлена и не ломает узкий экран', () => {
  assert.match(styles, /\.tavern-panel \{/u)
  assert.match(styles, /\.tavern-approach \{/u)
  assert.match(styles, /\.tavern-approach\.approach-cheat \{/u)
  assert.match(styles, /\.tavern-stakes button\.active \{/u)
  assert.match(styles, /\.tavern-drink \{/u)
  assert.match(styles, /\.tavern-approach \{ grid-template-columns: 1fr; \}/u)
})
