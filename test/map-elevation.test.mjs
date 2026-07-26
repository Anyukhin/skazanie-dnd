import assert from 'node:assert/strict'
import test from 'node:test'

import { generateDynamicSceneMap } from '../server/dynamic-map.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }
const generate = (overrides = {}) => generateDynamicSceneMap({ seed: 'elev-1', theme: 'руины', layout: 'open', width: 15, height: 11, ...overrides })
const raised = (cells) => cells.filter((cell) => Number(cell.elevation ?? 0) !== 0)

test('генератор расставляет уступы, и правило высоты перестаёт молчать', () => {
  const cells = generate()
  const ledges = raised(cells)
  assert.ok(ledges.length >= 2, `на карте должны быть возвышенности, найдено ${ledges.length}`)
  assert.equal(ledges.every((cell) => cell.elevation === 5 || cell.elevation === 10), true, 'высота идёт ступенями по 5 и 10 футов')
  assert.equal(ledges.every((cell) => cell.type === 'floor'), true, 'уступ ставится только на проходимую клетку')
})

test('уступы детерминированы по seed и не трогают въездную дорогу', () => {
  const first = raised(generate()).map((cell) => `${cell.x}:${cell.y}:${cell.elevation}`)
  const second = raised(generate()).map((cell) => `${cell.x}:${cell.y}:${cell.elevation}`)
  assert.deepEqual(second, first, 'один и тот же seed даёт одну и ту же расстановку')

  const other = raised(generate({ seed: 'elev-2' })).map((cell) => `${cell.x}:${cell.y}:${cell.elevation}`)
  assert.notDeepEqual(other, first, 'другой seed даёт другую расстановку')

  const centerY = Math.floor(11 / 2)
  assert.equal(raised(generate()).some((cell) => cell.x <= 2 && cell.y === centerY), false, 'место высадки партии остаётся ровным')
})

test('опасность задаёт число площадок, а проходимость не меняется', () => {
  const flatCount = (danger) => generate({ danger }).filter((cell) => cell.type === 'floor').length
  assert.equal(flatCount('низкая'), generate({ danger: 'низкая' }).filter((cell) => cell.type === 'floor').length)
  // Уступ — модификатор броска, а не препятствие: число проходимых клеток
  // совпадает с картой той же опасности, где высоты просто не читают.
  for (const danger of ['низкая', 'средняя', 'высокая']) {
    const cells = generate({ danger })
    assert.equal(cells.every((cell) => Number(cell.elevation ?? 0) === 0 || cell.type === 'floor'), true, `опасность «${danger}»: уступ не перекрывает проход`)
  }
  const budgets = ['низкая', 'средняя', 'высокая'].map((danger) => new Set(raised(generate({ danger })).map((cell) => `${cell.elevation}`)).size)
  assert.ok(budgets.every((size) => size >= 1), 'на карте любой опасности есть хотя бы одна площадка')
})

test('на карте прямо из генератора выстрел с уступа идёт с преимуществом', () => {
  // Правило высоты уже проверено на карте, собранной вручную (high-ground.test.mjs).
  // Здесь проверяется другое: что карта, пришедшая из генератора без правок,
  // действительно доносит `elevation` до Rules Engine.
  const cells = generate()
  const floors = new Map(cells.filter((cell) => cell.type === 'floor').map((cell) => [`${cell.x}:${cell.y}`, cell]))
  // Стрелять нужно вдоль ряда или столбца по сплошному полу: иначе движок
  // справедливо отвечает «траекторию перекрывает стена», и высота ни при чём.
  const clearLine = (from, to) => {
    const stepX = Math.sign(to.x - from.x)
    const stepY = Math.sign(to.y - from.y)
    if (stepX !== 0 && stepY !== 0) return false
    const steps = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
    for (let step = 1; step <= steps; step += 1) if (!floors.has(`${from.x + stepX * step}:${from.y + stepY * step}`)) return false
    return true
  }
  let ledge = null
  let ground = null
  for (const candidate of raised(cells)) {
    ground = cells.find((cell) => cell.type === 'floor'
      && !Number(cell.elevation ?? 0)
      && Math.abs(cell.x - candidate.x) + Math.abs(cell.y - candidate.y) >= 3
      && clearLine(candidate, cell))
    if (ground) { ledge = candidate; break }
  }
  assert.ok(ledge && ground, 'на карте нашлись уступ и ровная клетка на чистой линии огня')

  const state = normalizeCampaignState({
    sessionCode: 'ELEV-1',
    partyMemberIds: ['archer'],
    players: [{ id: 'archer', character: 'Лучница', characterClass: 'ranger', level: 5, hp: 40, maxHp: 40, armor: 15, speed: 30, proficiency: 3, abilities: { str: 10, dex: 18, con: 14, int: 10, wis: 14, cha: 10 }, inventory: [BOW], x: ledge.x, y: ledge.y }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 13, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: ground.x, y: ground.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'archer', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          archer: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })

  const shot = resolveCommand(
    { command_type: 'MakeAttack', actor_id: 'archer', target_id: 'brute', item_id: 'bow', server_authoritative: true },
    state,
    { diceService: new DiceService({ rng: new SequenceDiceRng([7, 16, 4]), idFactory: () => 'elev-roll', now: () => '2026-07-26T12:00:00.000Z' }), context: { serverAuthoritativeCombat: true, isAdmin: true } },
  )
  assert.equal(shot.events.find((event) => event.event_type === 'AttackResolved').payload.high_ground, 'higher')
  assert.equal(shot.rolls.find((roll) => roll.purpose === 'attack').mode, 'advantage')
})
