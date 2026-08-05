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
    baseCostFeet: 15,
    difficultTerrainFeet: 0,
    crawlingFeet: 0,
    costFeet: 15,
  })
  assert.equal(paths.has('1,1'), false, 'занятая союзником клетка не входит в маршруты')
})

test('труднопроходимая область удваивает только затронутые шаги и объясняет стоимость', () => {
  const current = state()
  current.mechanics = {
    active_effects: [{
      id: 'web',
      center: { x: 1, y: 0 },
      radius_feet: 0,
      difficult_terrain: true,
    }],
  }
  const paths = tacticalUi.buildMovementPaths(current, current.players[0], 5)
  const route = paths.get('2,0')

  assert.deepEqual(route, {
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    baseCostFeet: 15,
    difficultTerrainFeet: 5,
    crawlingFeet: 0,
    costFeet: 20,
  })
  assert.equal(tacticalUi.movementCostLabel(route), '20 фт (15 фт пути + 5 фт за трудную местность)')
  assert.equal(
    tacticalUi.movementCellReason(current, current.players[0], current.scene.cells.find((cell) => cell.x === 2 && cell.y === 0), 15, paths),
    'Нужно 20 фт, осталось 15 фт',
  )
})

test('клеточный moveCost карты также считается труднопроходимым без двойной доплаты', () => {
  const current = state()
  current.mechanics = {
    active_effects: [{
      id: 'mud',
      center: { x: 1, y: 0 },
      radius_feet: 0,
      difficult_terrain: true,
    }],
  }
  const map = {
    width: 5,
    height: 3,
    layers: {
      present: Uint8Array.from({ length: 15 }, () => 1),
      passable: Uint8Array.from({ length: 15 }, () => 1),
      revealed: Uint8Array.from({ length: 15 }, () => 1),
      moveCost: Uint8Array.from({ length: 15 }, (_, index) => index === 1 ? 2 : 1),
      surface: new Uint8Array(15),
      material: new Uint8Array(15),
      variant: new Uint8Array(15),
      elevation: new Int8Array(15),
      zoneId: new Uint8Array(15),
    },
    hazards: {}, edges: {}, doors: [], zones: [],
  }
  const route = tacticalUi.buildMovementPaths(current, current.players[0], 5, map).get('2,0')
  assert.equal(route.costFeet, 20, 'одна клетка остаётся x2, даже если оба источника совпали')
  assert.equal(route.difficultTerrainFeet, 5)
})

test('предпросмотр учитывает ползание и Свободу перемещения по серверной формуле', () => {
  const current = state()
  current.mechanics = {
    conditions: { hero: [{ id: 'prone' }] },
    active_effects: [{
      id: 'mud',
      center: { x: 1, y: 0 },
      radius_feet: 0,
      difficult_terrain: true,
    }],
  }
  const crawling = tacticalUi.buildMovementPaths(current, current.players[0], 5).get('2,0')
  assert.deepEqual(crawling, {
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    baseCostFeet: 15,
    difficultTerrainFeet: 5,
    crawlingFeet: 15,
    costFeet: 35,
  })
  assert.equal(
    tacticalUi.movementCostLabel(crawling),
    '35 фт (15 фт пути + 5 фт за трудную местность + 15 фт ползком)',
  )

  current.mechanics.conditions.hero.push({ id: 'freedom-of-movement' })
  const free = tacticalUi.buildMovementPaths(current, current.players[0], 5).get('2,0')
  assert.equal(free.difficultTerrainFeet, 0)
  assert.equal(free.crawlingFeet, 15)
  assert.equal(free.costFeet, 30)
  assert.equal(tacticalUi.movementCostLabel(free), '30 фт (15 фт пути + 15 фт ползком)')
})

test('предпросмотр выбирает более длинный, но дешёвый путь вокруг трудной местности', () => {
  const current = state()
  current.scene.cells = Array.from({ length: 2 }, (_, y) => (
    Array.from({ length: 5 }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
  current.players = [current.players[0]]
  current.enemies = []
  current.players[0].x = 0
  current.players[0].y = 1
  current.mechanics = {
    active_effects: [{
      id: 'mud-strip',
      difficult_terrain: true,
      cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
    }],
  }

  const route = tacticalUi.buildMovementPaths(current, current.players[0]).get('4,1')
  assert.ok(route)
  assert.equal(route.costFeet, 30)
  assert.equal(route.baseCostFeet, 30)
  assert.equal(route.difficultTerrainFeet, 0)
  assert.equal(route.crawlingFeet, 0)
  assert.ok(route.path.some((cell) => cell.y === 0))
})

test('серверный дедлайн превращается только в отображаемый обратный отсчёт', () => {
  const clock = {
    turn_id: 'event:turn-1',
    actor_ids: ['hero'],
    round: 1,
    active_index: 0,
    started_at: '2026-07-30T12:00:00.000Z',
    deadline_at: '2026-07-30T12:02:00.000Z',
    duration_ms: 120_000,
  }
  assert.deepEqual(tacticalUi.turnClockPresentation(clock, Date.parse('2026-07-30T12:01:45.100Z')), {
    remainingMs: 14_900,
    remainingSeconds: 15,
    label: '0:15',
    remainingRatio: 14_900 / 120_000,
    urgent: true,
    expired: false,
  })
  assert.equal(
    tacticalUi.turnClockPresentation(clock, Date.parse('2026-07-30T12:03:00.000Z')).label,
    '0:00',
  )
  assert.equal(tacticalUi.turnClockPresentation(null), null)
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
    natural: 14, modifier: 5, modifierText: '+5', total: 19, difficulty: 16, difficultyLabel: 'КД', success: true, outcome: 'попадание',
  })
  const save = tacticalUi.battleRollPresentation({
    id: 'save', type: 'spell-save', result: 'failure', roll: { die: 7, modifier: -1, total: 6, difficulty: 13, hit: false },
  })
  assert.equal(save.modifierText, '−1')
  assert.equal(save.difficultyLabel, 'СЛ')
  assert.equal(save.success, false)
  assert.equal(save.outcome, 'неудача')
  assert.deepEqual(tacticalUi.battleRollPresentation({
    id: 'npc', type: 'attack', roll: { total: 21, hit: true },
  }), {
    natural: null, modifier: null, modifierText: 'скрыт', total: 21, difficulty: undefined, difficultyLabel: 'КД', success: true, outcome: 'попадание',
  })
  assert.equal(tacticalUi.battleRollPresentation({ id: 'move', type: 'move' }), null)
})

test('причины преимущества и помехи берутся только из подтверждённого события атаки', () => {
  const shown = {
    id: 'attack', type: 'attack', actorId: 'hero', targetId: 'enemy',
    roll: { die: 17, modifier: 5, total: 22, difficulty: 15, hit: true },
  }
  const advantage = tacticalUi.battleRollContext([{
    event_type: 'AttackResolved',
    actor_id: 'hero',
    target_ids: ['enemy'],
    payload: {
      kept: 17, total: 22, dice: [9, 17], mode: 'advantage',
      condition_advantage: ['target:paralyzed'],
      high_ground: 'higher',
    },
  }], shown)
  assert.deepEqual(advantage, {
    mode: 'advantage',
    dice: [9, 17],
    advantageReasons: ['цель парализована', 'позиция выше цели'],
    disadvantageReasons: [],
  })

  const disadvantage = tacticalUi.battleRollContext([{
    event_type: 'AttackResolved',
    actor_id: 'hero',
    target_ids: ['enemy'],
    payload: {
      kept: 4, total: 9, dice: [13, 4], mode: 'disadvantage',
      condition_disadvantage: ['attacker:poisoned'],
      long_range: true,
    },
  }], { ...shown, roll: { die: 4, modifier: 5, total: 9, difficulty: 15, hit: false } })
  assert.deepEqual(disadvantage.disadvantageReasons, ['атакующий отравлен', 'дальний диапазон'])
  assert.equal(tacticalUi.battleRollContext([], shown), null, 'клиент не должен додумывать причину без server event')

  const durable = tacticalUi.battleRollContext([], {
    ...shown,
    rollMode: 'advantage',
    rollDice: [9, 17],
    advantageReasons: ['цель парализована', 'позиция выше цели'],
    disadvantageReasons: [],
  })
  assert.deepEqual(durable, advantage, 'контекст из журнала обязан работать после SSE и replay без локального visualBatch')
})

test('камера доски помнится по этажу, а этаж входа не меняет прежний ключ', () => {
  assert.equal(tacticalUi.boardCameraKey('taverna'), 'taverna', 'ключ этажа входа обязан совпасть со старым — иначе камера сбросится у всех сохранённых кампаний')
  assert.equal(tacticalUi.boardCameraKey('taverna', 0), 'taverna')
  assert.equal(tacticalUi.boardCameraKey('taverna', 2), 'taverna@L2')
  assert.equal(tacticalUi.boardCameraKey('taverna', -1), 'taverna@L-1')
  assert.notEqual(tacticalUi.boardCameraKey('taverna', 1), tacticalUi.boardCameraKey('taverna', -1), 'спальни и погреб не должны делить камеру')
  assert.equal(tacticalUi.boardCameraKey('', 0), 'нет карты')
})

test('кнопка перехода называет направление и подпись этажа, а отказ объясняет причину', () => {
  const levels = [{ index: 0, label: 'Общий зал' }, { index: 1, label: 'Спальни' }, { index: -1, label: 'Винный погреб' }]
  const up = tacticalUi.levelTransitionPresentation({
    transition: { toLevel: 1, label: 'Спальни' }, currentLevel: 0, levels, atHand: true, combatActive: false,
  })
  assert.deepEqual(up, { label: 'Подняться: Спальни', direction: 'up', disabled: false, title: 'Подняться: Спальни' })

  const down = tacticalUi.levelTransitionPresentation({
    transition: { toLevel: -1 }, currentLevel: 0, levels, atHand: true, combatActive: false,
  })
  assert.equal(down.label, 'Спуститься: Винный погреб', 'пустая подпись перехода обязана подхватываться из известных этажей')
  assert.equal(down.direction, 'down')

  const unknown = tacticalUi.levelTransitionPresentation({
    transition: { toLevel: 2 }, currentLevel: 1, levels: [], atHand: true, combatActive: false,
  })
  assert.equal(unknown.label, 'Подняться: этаж 2', 'без подписи кнопка всё равно обязана называть цель')

  const far = tacticalUi.levelTransitionPresentation({
    transition: { toLevel: 1, label: 'Спальни' }, currentLevel: 0, levels, atHand: false, combatActive: false,
  })
  assert.equal(far.disabled, true)
  assert.equal(far.title, 'Подойдите вплотную')

  const inCombat = tacticalUi.levelTransitionPresentation({
    transition: { toLevel: 1, label: 'Спальни' }, currentLevel: 0, levels, atHand: true, combatActive: true,
  })
  assert.equal(inCombat.disabled, true)
  assert.equal(inCombat.title, 'Сначала завершите бой', 'бой важнее расстояния: сервер откажет именно по нему')
})

test('тултип лестницы называет этаж и молчит на обычном предмете', () => {
  const levels = [{ index: 0, label: 'Общий зал' }, { index: -1, label: 'Винный погреб' }]
  assert.equal(tacticalUi.levelTransitionHint({ toLevel: 1, label: 'Спальни' }, levels), 'Ведёт: Спальни')
  assert.equal(tacticalUi.levelTransitionHint({ toLevel: -1 }, levels), 'Ведёт: Винный погреб',
    'подпись обязана подхватываться из известных этажей — та же лестница подписей, что у кнопки')
  assert.equal(tacticalUi.levelTransitionHint({ toLevel: 2 }, []), 'Ведёт: этаж 2')
  // Подсказка живёт до кнопки: она нужна и в бою, и с другого конца зала.
  assert.equal(tacticalUi.levelTransitionHint(null), null)
  assert.equal(tacticalUi.levelTransitionHint(undefined), null)
  assert.equal(tacticalUi.levelTransitionHint({ toLevel: 'подвал' }), null, 'мусор не должен превращаться в подсказку')
})

test('индикатор этажей строится сверху вниз и молчит на одноэтажной локации', () => {
  const rows = tacticalUi.levelIndicatorRows([
    { index: 0, label: 'Общий зал' },
    { index: -1, label: 'Винный погреб' },
    { index: 1, label: 'Спальни' },
  ], -1)
  assert.deepEqual(rows.map((row) => row.index), [1, 0, -1], 'верхний этаж обязан стоять сверху')
  assert.deepEqual(rows.filter((row) => row.active).map((row) => row.label), ['Винный погреб'])

  assert.deepEqual(tacticalUi.levelIndicatorRows([{ index: 0, label: 'Общий зал' }], 0), [], 'один этаж — не выбор, индикатор не рисуется')
  assert.deepEqual(tacticalUi.levelIndicatorRows(undefined, 0), [], 'старая проекция без этажей не должна ломать доску')

  const noisy = tacticalUi.levelIndicatorRows([
    { index: 0, label: 'Общий зал' },
    { index: 0, label: 'Дубль' },
    { index: 'подвал' },
    { index: 1, label: '' },
  ], 0)
  assert.deepEqual(noisy.map((row) => row.label), ['этаж 1', 'Общий зал'], 'дубли и мусор отбрасываются, пустая подпись заменяется номером')
})
