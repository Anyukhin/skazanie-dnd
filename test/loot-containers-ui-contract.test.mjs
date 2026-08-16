import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Сторож обещания «действие доступно живому игроку через основной сайт».
 *
 * Механика без двери в интерфейсе — это не реализация, а намерение
 * (`AGENTS.md`, критерий готовности, пункт 1). Тест читает исходники клиента и
 * падает, если панель добычи, метка тела на доске, послебоевая сводка или
 * проводка команды исчезли. Браузерной автоматизации в проекте нет — поэтому
 * контракт держится по исходникам, как и у остальных панелей.
 *
 * **Границу этого сторожа стоит назвать вслух.** Текст файла не отличает
 * заблокированную кнопку от работающей: `disabled: true → false` исходник не
 * меняет. Поэтому поведение чистой половины панели проверяется прогоном —
 * `test/loot-panel-rules.test.mjs` над `src/loot-panel-rules.mjs`, — а здесь
 * остаётся только то, что прогоном не выражается: разметка, размещение и то,
 * что каждая ступень лестницы вообще доезжает до экрана.
 */

const panel = readFileSync(new URL('../src/LootPanel.tsx', import.meta.url), 'utf8')
const rules = readFileSync(new URL('../src/loot-panel-rules.mjs', import.meta.url), 'utf8')
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

test('чистые правила панели лежат в исполняемом модуле, а не внутри компонента', () => {
  // Пока лестница состояний и прогноз перегруза сидели в `.tsx`, их сторожем
  // был только этот файл — и ни одна поведенческая правка им не ловилась.
  for (const symbol of ['lootTakeButtonState', 'lootWeightForecast', 'lootPickedWeight', 'vanishedLootFrom', 'lootAftermath']) {
    assert.ok(rules.includes(`export function ${symbol}`), `в src/loot-panel-rules.mjs нет ${symbol}`)
    assert.equal(panel.includes(`function ${symbol}`), false, `${symbol} вернулся в компонент и снова остался без прогона`)
  }
  assert.match(panel, /from '\.\/loot-panel-rules\.mjs'/u)
  // Правила не имеют права утащить в себя JSX: модуль обязан оставаться
  // загружаемым обычным `node --test`.
  assert.equal(/<[A-Za-z]/u.test(rules.replace(/=>/gu, '')), false, 'в модуле правил появилась разметка')
})

test('панель добычи есть в сцене и называет каждый вид контейнера', () => {
  assert.match(panel, /className="loot-panel"/u)
  assert.match(panel, /ДОБЫЧА · \{containers\.length\}/u)
  // Сами подписи проверены прогоном (`loot-panel-rules.test.mjs`) — здесь
  // важно, что карточка их действительно печатает.
  assert.match(panel, /LOOT_KIND_LABELS\[container\.kind\]/u)
  assert.match(panel, /LOOT_KIND_NOUNS\[container\.kind\]/u)
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

test('каждая ступень лестницы доезжает до экрана', () => {
  // Сами подписи, их порядок и `disabled` проверены прогоном
  // (`loot-panel-rules.test.mjs`). Здесь — только достижимость: строка действий
  // стоит и у далёкого контейнера, и у опустевшего, иначе половина состояний
  // остаётся мёртвым кодом, который ни один игрок не увидит.
  const card = panel.slice(panel.indexOf('{containers.map((container) =>'), panel.indexOf('{shownGhosts.map('))
  assert.equal(card.split('className="loot-actions"').length - 1, 1, 'строка действий обязана быть одна на карточку')
  assert.match(card, /\{!container\.can_inspect && <p className="loot-far">/u, 'далёкая карточка обязана оставаться со строкой действий')
  assert.match(card, /lootTakeButtonState\(\{/u, 'кнопка карточки обязана брать состояние из общих правил')
  assert.match(card, /disabled=\{picksLocked\}/u, 'выбор запирается тем же, чем и кнопка')
  const ghost = panel.slice(panel.indexOf('{shownGhosts.map('))
  assert.match(ghost, /takenBy: ghost\.takenBy/u, 'опустевшая карточка обязана проходить ту же лестницу')
  // Кнопка одна на оба случая: две формы разошлись бы состояниями.
  assert.match(panel, /disabled=\{state\.disabled\}/u)
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
  // Предел переноски героя считает сервер (`inventoryLoad`), правила только
  // складывают выбранное — иначе обещание разошлось бы с отказом движка.
  assert.match(rules, /recipient\?\.inventoryLoad\?\.capacity/u)
  assert.match(panel, /forecast\.overloaded/u)
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
  // Признак «его больше нет» приходит из проекции, подтверждение — из летописи,
  // и подтверждает оно именно опустошение: неполный обыск пишет ту же запись.
  assert.ok(rules.includes('export function vanishedLootFrom'))
  assert.ok(rules.includes("event.type === 'loot-taken'"))
  assert.ok(rules.includes("event.statusAfter === 'emptied' || event.remainingCount === 0"), 'призрак обязан требовать нулевой остаток')
  assert.ok(rules.includes('takenBy: actorName(record.recipientId ?? record.actorId)'), 'имя успевшего берётся из летописи')
  assert.ok(rules.includes('Уже забрал ${input.takenBy}'), 'подпись «уже забрал» обязана называть героя')
  assert.ok(board.includes('useVanishedLoot(sceneLoot, state.battleLog, actorNameById)'))
})

test('метка добычи на доске закрыта туманом наравне с остальными украшениями клетки', () => {
  // `.board-cell.loot-here` рисуется поверх тумана, поэтому без `cell.revealed`
  // нераскрытый угол зала светился бы рамкой ровно там, где лежит тело.
  assert.match(board, /cell\.revealed && lootHere \? 'loot-here' : ''/u)
  assert.match(board, /cell\.revealed && lootHere && focusedLootId === lootHere\.id \? 'loot-focused' : ''/u)
  assert.match(board, /const hasLootLayer = Boolean\(cell\.revealed && \(lootHere \|\| lootGhostHere\)\)/u)
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
