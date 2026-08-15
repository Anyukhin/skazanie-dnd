import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BEAST_PLAYER_COMMAND_TYPES, beastChronicleEntry } from '../server/beast-taming.mjs'

const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('зверь виден на панели отряда с меткой повадки и объявленной СЛ', () => {
  assert.match(board, /className="beast-panel"/u)
  assert.match(board, /ЗВЕРИ · \{beastCandidates\.length \+ beastCompanions\.length\}/u)
  assert.match(board, /className=\{`beast-tag\$\{candidate\.diet === 'predator' \? ' predator' : ''\}`\}/u)
  assert.match(board, /Уход за животными, СЛ \{candidate\.difficulty\}/u)
  for (const label of ['Успокоить', 'Приручить', 'Покормить', 'Отогнать']) {
    assert.ok(board.includes(`${label}`), `в меню зверя нет кнопки «${label}»`)
  }
  // Кнопка меняет подпись на последней ступени: «приручить», а не «успокоить».
  assert.match(board, /candidate\.stage === 'fed' \? 'Приручить' : 'Успокоить'/u)
})

test('спутник помечен отдельно и честно объявляет, что в бой не идёт', () => {
  assert.match(board, /className="beast-tag companion">СПУТНИК</u)
  assert.match(board, /идёт с отрядом · в бой не вводится/u)
  assert.match(board, /Восприятие лагеря идёт с преимуществом/u)
  // Повод отказа приходит с сервера полем, а откат — числом: доска не решает
  // за него ни «в бою нельзя», ни «ещё не остыл».
  assert.match(board, /disabled=\{beastActionsBlocked \|\| Boolean\(companion\.blocked_reason\)\}/u)
  assert.match(board, /companion\.scare_cooldown_minutes\} мин/u)
  assert.doesNotMatch(board, /BEAST_SCARE_COOLDOWN/u)
})

test('доска не гасит зверя своим «идёт бой»: доступность объявляет сервер', () => {
  // Сервер принимает уговор к сломленному моралью зверю прямо посреди боя, а
  // слепой гейт по бою гасил кнопки там, где команда проходит. Поводы доски —
  // только её собственные: рассказ, летящая команда, недееспособный герой.
  assert.match(board, /const beastActionsBlocked = Boolean\(narrating \|\| tacticalBusy \|\| !canAct \|\| beastOffTurn\)/u)
  assert.doesNotMatch(board, /const beastActionsBlocked = Boolean\(combatActive/u)
})

test('в бою кнопки зверя гаснут на чужом ходу, и доска говорит почему', () => {
  // Доступность считается по действующему герою (`turnActorId`), а команда
  // уходит от выбранного в сайдбаре (`typingActorId`, см. `onBeastAction` в
  // App.tsx). У аккаунта с двумя героями и у ведущего это разные герои: на ходу
  // героя Б при выбранном герое А кнопки горели, а сервер отбивал команду
  // `OUT_OF_TURN`. Пока весь класс был скрыт боевым гейтом, тупика не было
  // видно; сняв гейт, надо назвать настоящую причину.
  assert.match(board, /const beastOffTurn = Boolean\(combatActive && turnActorId !== typingActorId\)/u)
  // Молчаливо неактивной кнопки в проекте нет: причина едет подписью, и она
  // одна на обе кнопки лестницы.
  assert.match(board, /const beastOffTurnTitle = 'Сейчас ход другого героя/u)
  assert.equal((board.match(/\? beastOffTurnTitle/gu) ?? []).length, 2, 'причина обязана стоять на обеих кнопках лестницы')
  // И команда действительно уходит от выбранного героя, а не от действующего:
  // если это когда-нибудь сойдётся, гейт можно будет снять — но не раньше.
  assert.match(app, /onBeastAction=\{\(beastId, action\) => beastAction\(activePlayer\.id, beastId, action\)\}/u)
})

test('клиент называет только зверя: СЛ, навык и паёк остаются серверными', () => {
  for (const type of BEAST_PLAYER_COMMAND_TYPES) {
    assert.ok(session.includes(`command_type: '${type}'`), `клиент не умеет отправлять ${type}`)
  }
  assert.match(session, /beastAction = useCallback/u)
  assert.match(app, /onBeastAction=\{\(beastId, action\) => beastAction\(activePlayer\.id, beastId, action\)\}/u)
  // Ни навыка, ни СЛ, ни выбранного предмета в клиентской команде быть не должно.
  assert.doesNotMatch(session, /beast_id[^\n]*(difficulty|skill|item_id)/u)
})

test('уговор зверя стоит в списке двухфазных команд на обеих сторонах', () => {
  // Забыть одну строку здесь уже удавалось: карточка приходит с сервера,
  // клиент её не показывает, и ход зависает без ошибки в консоли.
  assert.match(session, /case 'CalmBeast':\r?\n {6}return command/u)
  assert.match(session, /manualRoll: !autoRollEnabled\(\)/u)
})

test('ступень приручения приезжает в летопись карточкой, а не голой строкой', () => {
  const card = beastChronicleEntry({
    event_type: 'BeastTamed',
    payload: { beast_id: 'beast:abc', beast_name: 'Волк 1', diet: 'predator' },
  })
  assert.equal(card.id, 'chronicle:beast:abc:tamed')
  assert.equal(card.beast.kind, 'tamed')
  assert.match(card.beast.text, /в строй не встаёт/u)
  assert.equal(card.beast.diet_label, 'хищник')
  // Провал и укус карточки не получают: рамка вокруг «волк не подпустил»
  // превратила бы летопись в ленту уведомлений.
  assert.equal(beastChronicleEntry({ event_type: 'BeastBit', payload: { beast_id: 'beast:abc' } }), null)
  assert.equal(beastChronicleEntry({
    event_type: 'BeastSoothingResolved',
    payload: { beast_id: 'beast:abc', success: false, stage_after: 'calmed' },
  }), null)
  // И тот же путь в летопись, что у конверта почты, — иначе карточка не дойдёт.
  assert.match(server, /eventsForChronicle\.map\(beastChronicleEntry\)/u)
  assert.match(views, /export function BeastChronicleEntry/u)
  assert.match(views, /message\.beast \?/u)
})

test('панель и карточка зверя оформлены', () => {
  assert.match(styles, /\.beast-panel \{/u)
  assert.match(styles, /\.beast-card\.companion \{/u)
  assert.match(styles, /\.beast-tag\.predator \{/u)
  assert.match(styles, /\.beast-chronicle-card \{/u)
  assert.match(styles, /\.beast-card\.out-of-reach \{/u)
})

test('далёкий зверь остаётся на панели, но с погашенными кнопками', () => {
  // Досягаемость приезжает отдельным полем, а не `blocked_reason`: карточка с
  // причиной из панели исчезает, а «до зверя ещё идти» — приглашение подойти.
  assert.match(board, /outOfReach \? ' out-of-reach' : ''/u)
  assert.match(board, /До зверя ещё идти/u)
  assert.match(board, /outOfReach \|\| candidate\.stage === 'calmed'/u)
  assert.match(board, /outOfReach \|\| candidate\.stage !== 'calmed'/u)
  // Мерка одна и она серверная, а герой — тот, которым жмут кнопку: строка
  // берётся по действующему герою, а не по ближайшему в отряде.
  assert.match(board, /const reach = candidate\.reach_by_hero\?\.\[typingActorId\]/u)
  assert.match(board, /reach\?\.distance_feet/u)
  assert.doesNotMatch(board, /BEAST_APPROACH_REACH_FEET/u)
  // Умолчание развёрнуто в безопасную сторону: нет строки — считаем «далеко».
  // Старая вкладка после выкладки не знает про `reach_by_hero`, и фейл-опен
  // здесь означал горящую кнопку под серверную отбивку `BEAST_OUT_OF_REACH`.
  assert.match(board, /const outOfReach = reach\?\.out_of_reach !== false/u)
  assert.doesNotMatch(board, /reach\?\.out_of_reach === true/u)
})
