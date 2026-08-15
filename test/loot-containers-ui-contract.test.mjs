import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { LOOT_CONTAINER_KINDS } from '../server/loot-containers.mjs'

/**
 * Сторож обещания «действие доступно живому игроку через основной сайт».
 *
 * Механика без двери в интерфейсе — это не реализация, а намерение
 * (`AGENTS.md`, критерий готовности, пункт 1). Тест читает исходники клиента и
 * падает, если панель добычи, её кнопки или проводка команды исчезли.
 */

const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../src/app-shared.tsx', import.meta.url), 'utf8')

test('панель добычи есть в сцене и называет каждый вид контейнера', () => {
  assert.match(board, /className="loot-panel"/u)
  assert.match(board, /ДОБЫЧА · \{sceneLoot\.length\}/u)
  for (const kind of LOOT_CONTAINER_KINDS) {
    assert.ok(new RegExp(`\\b${kind}:`, 'u').test(board), `у вида ${kind} нет подписи в LOOT_KIND_LABELS`)
  }
  for (const label of ['Выбрать всё']) {
    assert.ok(board.includes(`>${label}</button>`), `в панели добычи нет кнопки «${label}»`)
  }
  assert.match(board, /className="loot-take"/u)
})

test('досягаемость и цена хода объяснены игроку, а не оставлены на догадку', () => {
  assert.match(board, /Отсюда не дотянуться/u)
  assert.match(board, /\{lootReachFeet\} футов/u)
  assert.match(board, /В бою обыск стоит действия/u)
  // Признак «можно ли смотреть» приходит с сервера; браузер расстояние не считает.
  assert.match(board, /container\.can_inspect/u)
  assert.doesNotMatch(board, /can_inspect\s*=\s*/u)
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
})
