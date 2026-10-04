import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Подпись, число здоровья и значки состояний живут внутри фишки врага и висят
// под ней. С июля 2026 у кнопки фишки стоял clip-path в форме щита: он
// обрезает всех потомков, и под фишкой врага не было видно ничего. А там, где
// подпись всё-таки выходила, её закрывала соседняя фишка — у каждой фишки свой
// слой, и подпись выше него не поднимается.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const styles = read('src/styles.css')
const board = read('src/tactical-board.css')
const map = read('src/DungeonMap.tsx')
const rule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = new RegExp(`^${escaped} \\{[^}]*\\}`, 'mu').exec(css)
  assert.ok(found, `нет правила ${selector}`)
  return found[0]
}
const zIndex = (css, selector) => Number(/z-index:\s*(-?\d+)/u.exec(rule(css, selector))?.[1])

test('щит фишки врага — у подложки, а кнопка ничего не обрезает', () => {
  assert.doesNotMatch(rule(styles, '.enemy-token'), /clip-path:\s*polygon/u, 'clip-path на кнопке обрезал подпись, здоровье и состояния')
  assert.match(rule(styles, '.enemy-token::before'), /clip-path:\s*var\(--enemy-shield\)/u)
  assert.match(rule(styles, '.enemy-emblem'), /clip-path:\s*var\(--enemy-shield\)/u)
  // Прямоугольной тени у щита нет: прежде её срезал тот же clip-path.
  assert.match(rule(styles, '.board-cell .enemy-token'), /box-shadow:\s*none !important/u)
})

test('подпись врага не прячется под соседней фишкой', () => {
  const effects = zIndex(styles, '.board-effects-canvas')
  const targetable = zIndex(board, '.tactical-scroll .board-cell .enemy-token.targetable')
  const hovered = zIndex(board, '.tactical-scroll .board-cell :is(.map-token, .enemy-token):is(:hover, :focus-visible, .initiative-focus)')
  assert.ok(zIndex(styles, '.enemy-token') < targetable && targetable < hovered, 'доступная цель выше прочих фишек, фишка под курсором — выше всех')
  assert.ok(hovered < effects, 'фишки остаются под эффектами заклинаний')
  // Если под врагом кто-то стоит, подпись встаёт над фишкой: верхний ряд
  // рисуется раньше и её не закроет.
  assert.match(rule(board, '.tactical-scroll .enemy-token.nameplate-above .enemy-nameplate'), /bottom:/u)
  assert.match(map, /enemyNameplateAbove \? ' nameplate-above' : ''/u)
  assert.match(map, /const below = actorByCell\.get\(boardPositionKey\(x, bottom \+ 1\)\)/u)
})

test('значки состояний — у края своей фишки, а не в соседней клетке', () => {
  assert.match(rule(board, '.tactical-scroll .board-cell :is(.map-token, .enemy-token) .token-conditions'), /top: auto; bottom: 0;/u)
})
