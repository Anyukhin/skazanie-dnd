import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { LOOT_CONTAINER_KINDS } from '../server/loot-containers.mjs'

/**
 * Сторож обещания «действие доступно живому игроку через основной сайт».
 *
 * Механика без двери в интерфейсе — это не реализация, а намерение
 * (`AGENTS.md`, критерий готовности, пункт 1). Тест читает исходники клиента и
 * падает, если панель добычи, метка тела на доске, послебоевая сводка или
 * проводка команды исчезли. Браузерной автоматизации в проекте нет — поэтому
 * контракт держится по исходникам, как и у остальных панелей.
 */

const panel = readFileSync(new URL('../src/LootPanel.tsx', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../src/app-shared.tsx', import.meta.url), 'utf8')

test('добыча живёт своим компонентом, а не очередным куском доски', () => {
  // Панель, метка и сводка вынесены из монолита; доска их только размещает.
  for (const symbol of ['export function LootPanel', 'export function LootCellMarker', 'export function PostCombatLootSummary']) {
    assert.ok(panel.includes(symbol), `в src/LootPanel.tsx нет ${symbol}`)
  }
  assert.match(board, /import \{ LootCellMarker, LootPanel, PostCombatLootSummary, useVanishedLoot \} from '\.\/LootPanel'/u)
  assert.match(board, /<LootPanel/u)
  assert.doesNotMatch(board, /className="loot-panel"/u, 'разметка панели обязана остаться в своём модуле')
})

test('панель добычи есть в сцене и называет каждый вид контейнера', () => {
  assert.match(panel, /className="loot-panel"/u)
  assert.match(panel, /ДОБЫЧА · \{containers\.length\}/u)
  for (const kind of LOOT_CONTAINER_KINDS) {
    assert.ok(new RegExp(`\\b${kind}:`, 'u').test(panel), `у вида ${kind} нет подписи в LOOT_KIND_LABELS`)
  }
  for (const label of ['Выбрать всё', 'Снять выбор']) {
    assert.ok(panel.includes(`'${label}'`), `в панели добычи нет кнопки «${label}»`)
  }
  assert.match(panel, /className=\{`loot-take tone-\$\{state\.tone\}`\}/u)
})

test('карточка вещи показывает картинку, вес, количество и редкость', () => {
  assert.match(panel, /itemImageFor\(\{ catalog_id: item\.catalog_id, type: item\.type, image: item\.image \}\)/u)
  assert.match(panel, /aria-label=\{`Сколько взять: \$\{item\.name\}`\}/u)
  assert.match(panel, /\{item\.weight\} фнт/u)
  assert.match(panel, /className=\{`rarity \$\{item\.rarity/u)
  // Портрет источника — по ключу павшего из проекции, а не по стат-блоку.
  assert.match(panel, /container\.source_enemy_id/u)
})

test('кнопка обыска называет все четыре честных состояния', () => {
  for (const label of ['Взять — действие', 'Подойдите ближе', 'Не ваш ход', 'Уже забрал ']) {
    assert.ok(panel.includes(label), `у кнопки нет состояния «${label}»`)
  }
  // Порядок ступеней повторяет порядок проверок правила: сначала «уже забрали»
  // и очередь, затем досягаемость, и только потом вес и выбор.
  const order = ['Уже забрал ', 'Не ваш ход', 'Подойдите ближе', 'Не унести — перегруз', 'Выберите, что взять', 'Взять — действие']
  const positions = order.map((label) => panel.indexOf(label))
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'лестница состояний перепутана')
  assert.ok(positions.every((position) => position > 0))
  // Каждое состояние обязано быть достижимым: строка действий стоит и у
  // далёкого контейнера, и у опустевшего, иначе половина подписей — мёртвый код.
  const card = panel.slice(panel.indexOf('{containers.map((container) =>'), panel.indexOf('{shownGhosts.map('))
  assert.equal(card.split('className="loot-actions"').length - 1, 1, 'строка действий обязана быть одна на карточку')
  assert.match(card, /\{!container\.can_inspect && <p className="loot-far">/u, 'далёкая карточка обязана оставаться со строкой действий')
  const ghost = panel.slice(panel.indexOf('{shownGhosts.map('))
  assert.match(ghost, /takenBy: ghost\.takenBy/u, 'опустевшая карточка обязана проходить ту же лестницу')
})

test('досягаемость, цена хода и перегруз приходят с сервера, а не считаются в браузере', () => {
  assert.match(panel, /Отсюда не дотянуться/u)
  assert.match(panel, /\{reachFeet\} футов/u)
  assert.match(panel, /В бою обыск стоит действия/u)
  // Признак «можно ли смотреть», футы и цена хода — серверные поля проекции.
  assert.match(panel, /container\.can_inspect/u)
  assert.match(panel, /container\.distance_feet/u)
  assert.match(panel, /actionCost === 'action'/u)
  assert.doesNotMatch(panel, /can_inspect\s*=\s*/u)
  // Предел переноски героя считает сервер (`inventoryLoad`), панель только
  // складывает выбранное — иначе обещание разошлось бы с отказом движка.
  assert.match(panel, /recipient\?\.inventoryLoad\?\.capacity/u)
  assert.match(panel, /overloaded/u)
})

test('после ответа сервера состояние берётся из авторитета, без локального оптимизма', () => {
  const take = panel.slice(panel.indexOf('const take = async'), panel.indexOf('const liveIds'))
  assert.match(take, /const outcome = await onLoot\(/u)
  assert.match(take, /if \(outcome\.ok\)/u)
  // Отказ не трогает выбор и не убирает вещь из контейнера — он только
  // показывает причину сервера.
  assert.match(take, /setRefusals\(\(current\) => \(\{ \.\.\.current, \[container\.id\]: outcome\.error \}\)\)/u)
  assert.equal(take.includes('setContainers'), false, 'панель не имеет права переписывать серверный список')
})

test('метка тела рисуется слоем клетки, а не в ядре board-render', () => {
  assert.match(panel, /className="fallen-token"/u)
  assert.match(panel, /className="loot-pin"/u)
  assert.match(board, /<LootCellMarker/u)
  assert.match(board, /const fallenEnemy = /u)
  const render = readFileSync(new URL('../src/board-render.ts', import.meta.url), 'utf8')
  assert.equal(/loot/iu.test(render), false, 'холст доски про добычу знать не обязан')
  assert.match(styles, /\.loot-cell-mark \{/u)
  assert.match(styles, /\.fallen-token \{/u)
  assert.match(styles, /@keyframes loot-fade/u)
})

test('опустевший контейнер гаснет и объясняет, кто успел раньше', () => {
  // Признак «его больше нет» приходит из проекции, подтверждение — из летописи.
  assert.ok(panel.includes('export function vanishedLootFrom'))
  assert.ok(panel.includes("event.type === 'loot-taken' && event.containerId === container.id"))
  assert.ok(panel.includes('takenBy: actorName(record.recipientId ?? record.actorId)'), 'имя успевшего берётся из летописи')
  assert.ok(panel.includes('Уже забрал ${input.takenBy}'), 'подпись «уже забрал» обязана называть героя')
  assert.ok(board.includes('useVanishedLoot(sceneLoot, state.battleLog, actorNameById)'))
})

test('послебоевая сводка называет тела, тайники и невзятое', () => {
  assert.match(panel, /ПОБЕДА · ЧТО ОСТАЛОСЬ/u)
  assert.match(panel, /Тел не обыскано/u)
  assert.match(panel, /Тайники и тюки/u)
  assert.match(panel, /Уйдёте с этажа/u)
  // Открывает её запись летописи о победе, а не догадка клиента.
  assert.match(board, /reason === 'enemies_defeated'/u)
  assert.match(board, /<PostCombatLootSummary/u)
  assert.match(styles, /\.loot-aftermath \{/u)
})

test('клиент называет только ключи: контейнер, экземпляры и количества', () => {
  assert.match(session, /command_type: 'LootContainer'/u)
  assert.match(session, /lootContainer = useCallback/u)
  assert.match(app, /onLootContainer=\{\(containerId, lines, recipientId\) => lootContainer\(activePlayer\.id, containerId, lines, recipientId\)\}/u)
  // Ни имени, ни веса, ни цены вещи в команде быть не должно.
  for (const forbidden of ['catalog_id', 'base_price_cp', 'weight:'] ) {
    const command = session.slice(session.indexOf("command_type: 'LootContainer'"), session.indexOf("command_type: 'LootContainer'") + 400)
    assert.equal(command.includes(forbidden), false, `клиент присылает ${forbidden} вместе с обыском`)
  }
})

test('отказ на гонке перерисовывает карточку, а не оставляет взятую вещь', () => {
  // Сервер прикладывает свежий список к отказу (`server/index.mjs`), и клиент
  // обязан его применить: без этой ветки проигравший гонку видел бы уже взятый
  // кинжал до следующего опроса комнаты и бил бы в ту же стену.
  const refusal = session.slice(session.indexOf('const result = await response.json().catch(() => null) as TacticalCommandResult'))
    .slice(0, 900)
  assert.match(refusal, /result\?\.loot_containers/u)
  assert.match(refusal, /loot_containers: staleLoot/u)
})

test('журнал называет добычу и обыск, но не содержимое', () => {
  assert.match(shared, /event\.type === 'loot-container'/u)
  assert.match(shared, /event\.type === 'loot-taken'/u)
  assert.match(shared, /можно обыскать/u)
})

test('панель добычи оформлена и отличает вид контейнера', () => {
  assert.match(styles, /\.loot-panel \{/u)
  assert.match(styles, /\.loot-card\.kind-captive \{/u)
  assert.match(styles, /\.loot-items li\.picked > button \{/u)
  assert.match(styles, /\.loot-actions button\.loot-take \{/u)
  assert.match(styles, /\.loot-load\.overloaded \{/u)
  assert.match(styles, /\.loot-card\.taken \{/u)
})
