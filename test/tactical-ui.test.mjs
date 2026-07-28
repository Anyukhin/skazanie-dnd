import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-tactical-ui-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/tactical-ui.ts', import.meta.url))
// Предпросмотр маршрута спрашивает у карты состояние дверей, поэтому её чтение
// компилируется рядом: без второго модуля импорт из собранного файла не
// разрешится, и тест упадёт ещё до первой проверки.
const mapClientSource = fileURLToPath(new URL('../src/tactical-map-client.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', buildDir, source, mapClientSource], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const jsFile = join(buildDir, 'tactical-ui.js')
const moduleFile = join(buildDir, 'tactical-ui.mjs')
// Импорт внутри собранного файла указывает на './tactical-map-client' без
// расширения — Node такой путь не разрешает, поэтому сосед переименовывается в
// точности под него.
renameSync(join(buildDir, 'tactical-map-client.js'), join(buildDir, 'tactical-map-client'))
renameSync(jsFile, moduleFile)
const tacticalUi = await import(pathToFileURL(moduleFile).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function state() {
  const cells = Array.from({ length: 15 }, (_, index) => ({
    x: index % 5,
    y: Math.floor(index / 5),
    type: 'floor',
    revealed: true,
  }))
  cells.find((cell) => cell.x === 2 && cell.y === 1).type = 'wall'
  return {
    players: [
      { id: 'hero', x: 0, y: 1, hp: 10 },
      { id: 'ally', x: 1, y: 1, hp: 10 },
    ],
    enemies: [{ id: 'enemy', x: 3, y: 1, alive: true }],
    actors: [],
    scene: { cells },
  }
}

test('предпросмотр строит кратчайший легальный маршрут и считает стоимость до отправки команды', () => {
  const current = state()
  const paths = tacticalUi.buildMovementPaths(current, current.players[0], 5)
  const route = paths.get('2,0')

  assert.deepEqual(route, {
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    costFeet: 15,
  })
  assert.equal(paths.has('1,1'), false, 'занятая союзником клетка не входит в маршруты')
})

test('недоступные клетки получают конкретную причину', () => {
  const current = state()
  const actor = current.players[0]
  const paths = tacticalUi.buildMovementPaths(current, actor, 5)
  const cell = (x, y) => current.scene.cells.find((item) => item.x === x && item.y === y)

  assert.equal(tacticalUi.movementCellReason(current, actor, cell(1, 1), 30, paths), 'Клетка занята')
  assert.equal(tacticalUi.movementCellReason(current, actor, cell(2, 1), 30, paths), 'Клетка непроходима')
  assert.equal(tacticalUi.movementCellReason(current, actor, cell(4, 0), 15, paths), 'Нужно 25 фт, осталось 15 фт')
  assert.equal(tacticalUi.movementCellReason(current, actor, cell(2, 0), 15, paths), null)
})

test('проверка цели блокирует ошибочную UI-команду и объясняет причину', () => {
  const base = {
    selected: true,
    economyReady: true,
    targetAlive: true,
    targetTeam: 'enemy',
    acceptedTarget: 'enemy',
    distanceFeet: 20,
    rangeFeet: 30,
    clearTrajectory: true,
  }

  assert.deepEqual(tacticalUi.evaluateCombatTarget(base), { allowed: true, reason: null })
  assert.match(tacticalUi.evaluateCombatTarget({ ...base, economyReady: false }).reason, /экономики хода/)
  assert.equal(tacticalUi.evaluateCombatTarget({ ...base, distanceFeet: 35 }).reason, 'Цель в 35 фт: дальность 30 фт')
  assert.equal(tacticalUi.evaluateCombatTarget({ ...base, clearTrajectory: false }).reason, 'Линию до цели перекрывает стена')
  assert.equal(tacticalUi.evaluateCombatTarget({ ...base, targetTeam: 'ally' }).reason, 'Это действие требует противника')
})

test('состояния честно помечаются как работающие, частичные или marker-only', () => {
  assert.equal(tacticalUi.conditionPresentation({ id: 'unconscious' }).status, 'implemented')
  assert.equal(tacticalUi.conditionPresentation({ id: 'prone' }).status, 'partial')
  const unknown = tacticalUi.conditionPresentation({ id: 'homebrew-omen', duration: 'rounds:3' })
  assert.equal(unknown.status, 'marker')
  assert.match(unknown.explanation, /пока не применяются/)
  assert.equal(unknown.duration, 'раундов: 3')
  assert.equal(tacticalUi.conditionPresentation('disengaged').label, 'Отход')
})

test('поддержка механики честно блокирует эвристику и ruling-only карточки', () => {
  assert.deepEqual(tacticalUi.mechanicsSupportPresentation('verified'), {
    status: 'verified',
    label: 'Проверенная механика',
    shortLabel: 'ПРОВЕРЕНО',
    explanation: 'Эффект сверён с источником, исполняется сервером и покрыт проверками.',
    blocked: false,
  })
  assert.equal(tacticalUi.mechanicsSupportPresentation('partial').blocked, false)
  assert.equal(tacticalUi.mechanicsSupportPresentation('heuristic').blocked, true)
  assert.equal(tacticalUi.mechanicsSupportPresentation('ruling-only').blocked, true)
  assert.equal(tacticalUi.mechanicsSupportPresentation(undefined).status, 'ruling-only')
  assert.equal(tacticalUi.mechanicsSupportPresentation('partial', 'Работает только базовый эффект.').explanation, 'Работает только базовый эффект.')
})

test('карточка броска показывает натуральный d20, модификатор и порог D&D', () => {
  assert.deepEqual(tacticalUi.battleRollPresentation({
    id: 'attack', type: 'attack', roll: { die: 14, modifier: 5, total: 19, difficulty: 16, hit: true },
  }), {
    natural: 14, modifier: 5, modifierText: '+5', total: 19, difficulty: 16, difficultyLabel: 'КД', success: true,
  })
  const save = tacticalUi.battleRollPresentation({
    id: 'save', type: 'spell-save', result: 'failure', roll: { die: 7, modifier: -1, total: 6, difficulty: 13, hit: false },
  })
  assert.equal(save.modifierText, '−1')
  assert.equal(save.difficultyLabel, 'СЛ')
  assert.equal(save.success, false)
  assert.equal(tacticalUi.battleRollPresentation({ id: 'move', type: 'move' }), null)
})
