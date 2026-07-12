import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-tactical-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/tactical-engine.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', buildDir, source], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const jsFile = join(buildDir, 'tactical-engine.js')
const moduleFile = join(buildDir, 'tactical-engine.mjs')
renameSync(jsFile, moduleFile)
const tactical = await import(pathToFileURL(moduleFile).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function state(overrides = {}) {
  const cells = Array.from({ length: 30 }, (_, index) => ({
    x: index % 10,
    y: Math.floor(index / 10),
    type: 'floor',
    revealed: true,
  }))
  const hero = {
    id: 'hero', name: 'Игрок', character: 'Адара', role: 'Воин', color: '#fff', initials: 'АД',
    portrait: '', portraitPosition: '', level: 3, species: 'Человек', background: 'Солдат', alignment: 'Добрый',
    experience: 900, speed: 30, proficiency: 2,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    traits: '', ideals: '', bonds: '', flaws: '', backstory: '', features: '', notes: '',
    currency: { copper: 0, silver: 0, gold: 0, platinum: 0 }, inventory: [],
    hp: 20, maxHp: 20, armor: 15, online: true, x: 0, y: 1,
  }
  return {
    sessionCode: 'TACTIC-1', campaign: 'Тест', partyName: 'Отряд', partyMemberIds: ['hero'],
    players: [hero], enemies: [], messages: [], activePlayerId: 'hero', isNarrating: false,
    pendingCheck: null, suggestions: [], scene: { title: 'Поле', location: 'Тест', mood: '', objective: '', turn: 1, cells },
    ...overrides,
  }
}

test('размер сетки карты вычисляется из координат для динамических сцен', () => {
  const cells = Array.from({ length: 17 * 11 }, (_, index) => ({
    x: index % 17,
    y: Math.floor(index / 17),
    type: 'floor',
    revealed: true,
  }))

  assert.deepEqual(tactical.mapGridDimensions(cells), { columns: 17, rows: 11 })
  assert.deepEqual(tactical.mapGridDimensions([]), { columns: 1, rows: 1 })
})

test('скорость 30 футов разрешает ровно шесть клеток и записывает перемещение в журнал', () => {
  const initial = state()
  const reachable = tactical.reachableCells(initial, 'hero')
  assert.equal(reachable.has('6,1'), true)
  assert.equal(reachable.has('7,1'), false)

  const moved = tactical.movePlayerOnMap(initial, 'hero', 6, 1)
  assert.deepEqual([moved.players[0].x, moved.players[0].y], [6, 1])
  assert.equal(moved.tacticalTurn.movementSpent, 30)
  assert.match(moved.messages.at(-1).text, /30 футов/)
  assert.equal(tactical.reachableCells(moved, 'hero').size, 0)
})

test('атака по соседней иконке тратит действие, уменьшает ОЗ и создаёт отметку урона', () => {
  const initial = state({
    players: [{ ...state().players[0], x: 6, y: 1 }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 10, maxHp: 10, armor: 13, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 2, x: 7, y: 1, alive: true }],
  })
  const rolls = [0.95, 0]
  const attacked = tactical.attackEnemyOnMap(initial, 'hero', 'goblin', () => rolls.shift() ?? 0)

  assert.equal(attacked.enemies[0].hp, 7)
  assert.equal(attacked.tacticalTurn.actionUsed, true)
  assert.equal(attacked.mapFeedback.at(-1).text, '−3')
  assert.equal(attacked.messages.at(-1).roll.success, true)
  assert.equal(tactical.attackEnemyOnMap(attacked, 'hero', 'goblin', () => 0), attacked)
})

test('враг проходит до шести клеток, атакует ближайшего участника и пишет результат в историю', () => {
  const initial = state({
    enemies: [{ id: 'wolf', name: 'Волк', hp: 8, maxHp: 8, armor: 12, speed: 30, attackBonus: 5, damageDice: 6, damageBonus: 2, x: 7, y: 1, alive: true }],
  })
  const rolls = [0.95, 0]
  const resolved = tactical.finishTacticalTurn(initial, () => rolls.shift() ?? 0)

  assert.deepEqual([resolved.enemies[0].x, resolved.enemies[0].y], [1, 1])
  assert.equal(resolved.players[0].hp, 17)
  assert.equal(resolved.scene.turn, 2)
  assert.match(resolved.messages.map((message) => message.text).join(' '), /перемещается на 30 футов/)
  assert.match(resolved.messages.at(-1).text, /урон 3/)
})

test('полный локальный раунд двигает фишки, меняет ОЗ и сохраняет факты для рассказчика', () => {
  const initial = state({
    enemies: [{ id: 'wolf', name: 'Волк', hp: 10, maxHp: 10, armor: 13, speed: 30, attackBonus: 5, damageDice: 6, damageBonus: 2, x: 7, y: 1, alive: true }],
    battleLog: [],
  })

  const moved = tactical.movePlayerOnMap(initial, 'hero', 6, 1)
  const playerRolls = [0.95, 0]
  const attacked = tactical.attackEnemyOnMap(moved, 'hero', 'wolf', () => playerRolls.shift() ?? 0)
  const enemyRolls = [0.95, 0]
  const finished = tactical.finishTacticalTurn(attacked, () => enemyRolls.shift() ?? 0)

  assert.deepEqual([finished.players[0].x, finished.players[0].y], [6, 1])
  assert.deepEqual([finished.enemies[0].x, finished.enemies[0].y], [7, 1])
  assert.equal(finished.enemies[0].hp, 7)
  assert.equal(finished.players[0].hp, 17)
  assert.deepEqual(finished.battleLog.map((event) => event.type), ['move', 'attack', 'attack', 'turn-end'])
  assert.deepEqual(finished.battleLog[0].to, { x: 6, y: 1 })
  assert.deepEqual(
    finished.battleLog.filter((event) => event.type === 'attack').map((event) => ({ actor: event.actorId, target: event.targetId, damage: event.damage, hpAfter: event.hpAfter })),
    [
      { actor: 'hero', target: 'wolf', damage: 3, hpAfter: 7 },
      { actor: 'wolf', target: 'hero', damage: 3, hpAfter: 17 },
    ],
  )
  assert.equal(finished.messages.some((message) => message.speaker === 'narrator'), false)
})
