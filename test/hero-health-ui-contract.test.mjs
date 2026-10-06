import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

/**
 * Полоска хитов раненого героя на фишке, как в BG3:
 *
 * 1. **данные** — хиты союзника по отряду приходят и другому игроку, поэтому
 *    полоску рисовать есть из чего;
 * 2. **разметка** — полоска стоит соседом фишки и появляется только в бою и
 *    только у раненого: здоровый отряд фишки не загромождает (PR #7);
 * 3. **3D** — над фигуркой, на той же высоте, что полоска врага.
 *
 * Проверка текстовая, по образцу `boss-card-ui-contract`: браузерной
 * автоматизации в проекте нет.
 */
const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const board = source('src/DungeonMap.tsx')
const styles = source('src/styles.css')
const board3d = source('src/board3d.css')

test('хиты союзника по отряду видны другому игроку', () => {
  const state = normalizeCampaignState({
    sessionCode: 'HERO-HP',
    partyMemberIds: ['hero', 'ally'],
    members: [
      { user_id: 'user-1', hero_id: 'hero', role: 'player' },
      { user_id: 'user-2', hero_id: 'ally', role: 'player' },
    ],
    players: [
      { id: 'hero', hp: 40, maxHp: 40, armor: 16, speed: 30, x: 1, y: 1 },
      { id: 'ally', hp: 9, maxHp: 38, armor: 15, speed: 30, x: 2, y: 1 },
    ],
  })
  const room = campaignStateForViewer(state, { id: 'user-1', role: 'player' }, 'hero')
  const ally = room.players.find((player) => player.id === 'ally')
  assert.deepEqual([ally.hp, ally.maxHp], [9, 38])
})

test('полоска героя — только в бою и только у раненого, ступень цветом', () => {
  const bar = board.slice(board.indexOf('className={`hero-health'), board.indexOf('className={`hero-health') + 400)
  assert.ok(bar.length > 0, 'полоска героя размечена')
  const guard = board.slice(board.lastIndexOf('{player && cell.revealed', board.indexOf('className={`hero-health')), board.indexOf('className={`hero-health'))
  assert.match(guard, /combatActive/u, 'вне боя полоски нет')
  assert.match(guard, /player\.hp < player\.maxHp/u, 'у здорового героя полоски нет')
  assert.match(guard, /<TokenHealthBar/u)
  for (const status of ['downed', 'critical', 'bloodied']) assert.match(bar, new RegExp(`'${status}'`, 'u'), status)
  assert.match(styles, /\.map-token-hp\.hero-health \{/u)
  assert.match(styles, /\.map-token-hp\.hero-health\.downed \{ animation/u)
  assert.match(styles, /prefers-reduced-motion: reduce\) \{ \.map-token-hp\.hero-health\.downed \{ animation: none/u, 'мигание уважает уменьшение движения')
  assert.match(board3d, /\.board3d-cell \.enemy-health, \.board3d-cell \.hero-health \{/u, 'в 3D — над фигуркой, как у врага')
})
