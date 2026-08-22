import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

/**
 * Тройной контракт карточки босса, по образцу `blessings-ui-contract`:
 *
 * 1. **данные** — признак босса и полосу запаса считает сервер, клиент их не
 *    выводит; иначе рамка появлялась бы там, где действий вне хода нет;
 * 2. **разметка** — рамка и корона стоят там, где стол их ищет: в ленте
 *    инициативы и на карточке цели;
 * 3. **граница** — ни СЛ заклинаний, ни список магии, ни бухгалтерия запаса в
 *    интерфейс не приходят вовсе, поэтому показать их клиенту нечем.
 *
 * Проверка текстовая: браузерной автоматизации в проекте нет, а компонент,
 * переехавший в соседний файл, молча обезоружил бы сторожа — поэтому исходники
 * доски и общего слоя читаются одной строкой.
 */
const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const board = source('src/DungeonMap.tsx')
const types = source('src/types.ts')
const styles = source('src/styles.css')
const ui = ['src/App.tsx', 'src/AppViews.tsx', 'src/DungeonMap.tsx', 'src/app-shared.tsx'].map(source).join('\n')

function bossState() {
  return normalizeCampaignState({
    sessionCode: 'BOSS-UI',
    partyMemberIds: ['hero'],
    members: [{ user_id: 'user-1', hero_id: 'hero', role: 'player' }],
    players: [{ id: 'hero', hp: 40, maxHp: 40, armor: 16, speed: 30, abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, x: 1, y: 1 }],
    enemies: [{
      id: 'boss', name: 'Владыка кургана', hp: 120, maxHp: 120, armor: 18, speed: 30, x: 3, y: 1, alive: true,
      abilities: { str: 20, dex: 14, con: 18, int: 16, wis: 15, cha: 19 },
      spellcasting: { ability: 'cha', save_dc: 17, attack_bonus: 9, spells: [{ id: 'fire-bolt', uses: 'at-will' }] },
      legendary: { uses: 3, resistance: 2, actions: [{ id: 'tail', name: 'Удар хвостом', cost: 1, kind: 'attack', attack_modifier: 9, damage_expression: '2d8+5', damage_type: 'bludgeoning', range_feet: 15 }] },
      action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 9, damage_expression: '2d6+5', damage_type: 'slashing', range_feet: 5 }],
    }],
    scene: { turn: 1, cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })) },
    mechanics: {
      conditions: { boss: [{ id: 'legendary-action-used:1:r1i0' }, { id: 'monster-spell-used:fire-bolt#1' }] },
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'boss', total: 11 }] },
    },
  })
}

test('признак босса и полосу запаса считает сервер, а клиент только рисует', () => {
  const enemy = campaignStateForViewer(bossState(), { id: 'user-1', role: 'player' }, 'hero').enemies[0]
  assert.equal(enemy.boss, true, 'без серверного признака клиент рамку не нарисует')
  assert.deepEqual(enemy.legendary, { uses: 3, used: 1 }, 'потраченное считается по маркерам, а не по памяти клиента')

  // Клиент читает готовое поле и ничего не выводит сам: ни из `legendary` в
  // стат-блоке (его у него нет), ни из состояний (их у него тоже нет).
  assert.match(types, /boss\?: boolean/u)
  assert.match(types, /legendary\?: \{ uses: number; used: number \}/u)
  assert.match(board, /const boss = enemy\?\.boss === true/u)
  assert.doesNotMatch(board, /legendary-action-used/u, 'служебный маркер интерфейсу не принадлежит')
  assert.doesNotMatch(ui, /spellcasting/u, 'блока заклинаний существа у клиента нет вовсе')
})

test('рамка, корона и пипсы стоят в ленте инициативы и на карточке цели', () => {
  assert.match(board, /className=\{`\$\{kind\} \$\{activeNow \? 'active' : ''\}[^`]*\$\{boss \? ' boss' : ''\}`\}/u)
  assert.match(board, /initiative-boss-badge/u)
  assert.match(board, /\{boss && enemy\?\.legendary && !defeated && <LegendaryPips legendary=\{enemy\.legendary\} compact \/>\}/u)
  assert.match(board, /activeEnemy\?\.boss \? ' boss' : ''/u)
  assert.match(board, /const inspectedBoss = inspectedTarget\?\.team === 'enemy'/u)
  assert.match(board, /combat-target-portrait/u)
  // Подпись «БОСС» читается с экрана: `aria-hidden` висит на короне, а не на
  // самой подписи — иначе слепой игрок не узнал бы о боссе вовсе.
  assert.match(board, /<b><Crown size=\{11\} aria-hidden="true" \/>Босс<\/b>/u)
  assert.doesNotMatch(board, /<span className="combat-target-portrait" aria-hidden/u)

  // Пипс — та же форма, что у часов квеста: `<i>` строка, `<u>` пипс.
  assert.match(board, /export function LegendaryPips/u)
  assert.match(board, /<u key=\{index\} className=\{index < used \? 'spent' : ''\} \/>/u)
  for (const rule of ['.initiative-ribbon li.boss', '.initiative-boss-badge', '.legendary-pips', '.combat-target-portrait']) {
    assert.ok(styles.includes(rule), `нет правила ${rule}`)
  }
})

test('полоса объявляет остаток словами, а не только точками', () => {
  // Пипсы — качественная величина, но слепой игрок обязан узнать то же самое:
  // подпись называет остаток и в `title`, и в `aria-label`.
  assert.match(board, /Легендарные действия: осталось \$\{total - used\} из \$\{total\}/u)
  assert.match(board, /aria-label=\{`Выделить на карте: \$\{name\}\$\{boss \? ', босс' : ''\}/u)
  // Предел в пять пипсов — не украшение: полоса не должна разъезжаться на
  // существе с выдуманным запасом в тридцать действий.
  assert.match(board, /Math\.max\(0, Math\.min\(5, legendary\.uses\)\)/u)
})
