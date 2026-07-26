import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMBAT_BOUNDS_MARGIN_CELLS,
  applyCombatBounds,
  combatBoundsContain,
  combatBoundsCoverage,
  combatBoundsUseful,
  computeCombatBounds,
  expandCombatBounds,
} from '../server/combat-bounds.mjs'
import { assembleEncounter } from '../server/encounter-assembler.mjs'
import {
  applyRevealDelta,
  revealDelta,
  revealDeltaEmpty,
  revealDeltaSize,
  revealUpdateFor,
} from '../server/reveal-delta.mjs'
import {
  cellAt,
  createTacticalMap,
  deserializeTacticalMap,
  serializeTacticalMap,
  setCell,
  tacticalMapHash,
} from '../server/tactical-map.mjs'

const region = () => createTacticalMap({ width: 100, height: 100, sizeClass: 'region', fill: { passable: true } })

test('подрайон строится вокруг участников с запасом на манёвр', () => {
  const map = region()
  const bounds = computeCombatBounds(map, [{ x: 50, y: 50 }, { x: 56, y: 54 }])
  assert.ok(bounds)
  assert.equal(bounds.minX, 50 - COMBAT_BOUNDS_MARGIN_CELLS)
  assert.equal(bounds.maxX, 56 + COMBAT_BOUNDS_MARGIN_CELLS)
  assert.equal(bounds.minY, 50 - COMBAT_BOUNDS_MARGIN_CELLS)
  assert.equal(bounds.maxY, 54 + COMBAT_BOUNDS_MARGIN_CELLS)
  // Запас обязан покрывать дальность заклинаний 60–120 футов, то есть 12–24
  // клетки: иначе половина отряда будет идти к противнику несколько ходов.
  assert.ok(bounds.maxX - bounds.minX >= 24)
})

test('подрайон обрезается границами карты', () => {
  const map = region()
  const bounds = computeCombatBounds(map, [{ x: 1, y: 1 }])
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: 13, maxY: 13 })
  const far = computeCombatBounds(map, [{ x: 99, y: 99 }])
  assert.equal(far.maxX, 99)
  assert.equal(far.maxY, 99)
})

test('без участников подрайона нет', () => {
  assert.equal(computeCombatBounds(region(), []), null)
  assert.equal(combatBoundsContain(null, 5, 5), true, 'без подрайона ограничений нет')
})

test('выход за границу расширяет подрайон, а не блокируется', () => {
  const map = region()
  const bounds = computeCombatBounds(map, [{ x: 50, y: 50 }])
  assert.equal(combatBoundsContain(bounds, 70, 50), false)

  const wider = expandCombatBounds(map, bounds, 70, 50)
  assert.equal(combatBoundsContain(wider, 70, 50), true, 'после выхода точка обязана оказаться внутри')
  assert.ok(wider.maxX > bounds.maxX, 'граница обязана раздвинуться')
  assert.equal(wider.minX, bounds.minX, 'противоположная сторона не двигается')
  // Невидимой стены быть не должно: расширение — единственная реакция.
  assert.equal(combatBoundsContain(expandCombatBounds(map, wider, 99, 99), 99, 99), true)
})

test('точка внутри подрайона его не меняет', () => {
  const map = region()
  const bounds = computeCombatBounds(map, [{ x: 50, y: 50 }])
  assert.deepEqual(expandCombatBounds(map, bounds, 52, 51), bounds)
})

test('подрайон садится на карту и переживает сериализацию', () => {
  const map = applyCombatBounds(region(), [{ x: 40, y: 40 }, { x: 44, y: 42 }])
  assert.ok(map.combatBounds)
  const restored = deserializeTacticalMap(serializeTacticalMap(map))
  assert.deepEqual(restored.combatBounds, map.combatBounds)
})

test('охват подрайона считается, чтобы поймать вырождение в стену', () => {
  const map = region()
  for (let y = 30; y <= 60; y += 1) setCell(map, 45, y, { passable: false })
  const bounds = computeCombatBounds(map, [{ x: 44, y: 45 }, { x: 46, y: 45 }])
  const coverage = combatBoundsCoverage(map, bounds)
  assert.ok(coverage.cells > 0)
  assert.ok(coverage.passable < coverage.cells, 'стена внутри подрайона обязана быть видна в охвате')
})

test('на маленькой карте подрайон бессмыслен', () => {
  assert.equal(combatBoundsUseful(createTacticalMap({ width: 20, height: 20 })), false)
  assert.equal(combatBoundsUseful(createTacticalMap({ width: 60, height: 60 })), true)
})

test('дельта раскрытия хранит интервалы, а не список координат', () => {
  const before = createTacticalMap({ width: 100, height: 100, fill: { passable: true, revealed: false } })
  const after = deserializeTacticalMap(serializeTacticalMap(before))
  let opened = 0
  for (let y = 44; y <= 56; y += 1) {
    for (let x = 44; x <= 56; x += 1) {
      if (Math.hypot(x - 50, y - 50) > 6) continue
      setCell(after, x, y, { revealed: true })
      opened += 1
    }
  }
  const delta = revealDelta(before, after, tacticalMapHash(before))
  assert.equal(revealDeltaSize(delta), opened)
  assert.ok(delta.revealed.length < opened / 4,
    `интервалов ${delta.revealed.length} на ${opened} клеток — упаковка не работает`)
  const size = Buffer.byteLength(JSON.stringify(delta)) / 1024
  console.log(`  дельта на ${opened} клеток: ${delta.revealed.length} интервалов, ${size.toFixed(2)} КБ`)
  assert.ok(size <= 4, `дельта ${size.toFixed(2)} КБ, порог плана — 4 КБ`)
})

test('наложение дельты даёт то же состояние, что и прямое раскрытие', () => {
  const before = createTacticalMap({ width: 40, height: 40, fill: { passable: true, revealed: false } })
  const after = deserializeTacticalMap(serializeTacticalMap(before))
  for (let x = 10; x < 20; x += 1) setCell(after, x, 10, { revealed: true })
  setCell(after, 5, 5, { revealed: true })

  const delta = revealDelta(before, after, 'base')
  const rebuilt = applyRevealDelta(deserializeTacticalMap(serializeTacticalMap(before)), delta)
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      assert.equal(cellAt(rebuilt, x, y)?.revealed, cellAt(after, x, y)?.revealed, `клетка ${x},${y}`)
    }
  }
})

test('дельта умеет скрывать обратно', () => {
  const before = createTacticalMap({ width: 10, height: 10, fill: { passable: true, revealed: true } })
  const after = deserializeTacticalMap(serializeTacticalMap(before))
  setCell(after, 3, 3, { revealed: false })
  const delta = revealDelta(before, after, 'base')
  assert.equal(delta.hidden.length, 1)
  const rebuilt = applyRevealDelta(deserializeTacticalMap(serializeTacticalMap(before)), delta)
  assert.equal(cellAt(rebuilt, 3, 3)?.revealed, false)
})

test('пустая дельта распознаётся и не отправляется', () => {
  const map = createTacticalMap({ width: 10, height: 10, fill: { passable: true, revealed: true } })
  const same = deserializeTacticalMap(serializeTacticalMap(map))
  assert.equal(revealDeltaEmpty(revealDelta(map, same, 'base')), true)
})

test('клиенту с другой картой уходит карта целиком, с той же — дельта', () => {
  const map = createTacticalMap({ width: 20, height: 20, fill: { passable: true, revealed: false } })
  const serialized = serializeTacticalMap(map)
  const hash = tacticalMapHash(map)

  const cold = revealUpdateFor({ serializedMap: serialized, currentHash: hash })
  assert.equal(cold.kind, 'full', 'клиент без карты обязан получить её целиком')

  const next = deserializeTacticalMap(serializeTacticalMap(map))
  setCell(next, 5, 5, { revealed: true })
  const warm = revealUpdateFor({
    serializedMap: serializeTacticalMap(next),
    currentHash: hash,
    clientHash: hash,
    clientMap: serialized,
  })
  assert.equal(warm.kind, 'delta')
  assert.equal(revealDeltaSize(warm.delta), 1)

  const stale = revealUpdateFor({
    serializedMap: serialized, currentHash: hash, clientHash: 'другая', clientMap: serialized,
  })
  assert.equal(stale.kind, 'full', 'при чужом хеше дельту слать нельзя')
})

test('дельта между картами разного размера отклоняется', () => {
  const small = createTacticalMap({ width: 10, height: 10, fill: { passable: true } })
  const big = createTacticalMap({ width: 20, height: 20, fill: { passable: true } })
  assert.throws(() => revealDelta(small, big, 'base'), /одной карты/u)
  assert.throws(() => applyRevealDelta(small, { version: 'skazanie:reveal-delta-v1', width: 20, revealed: [], hidden: [] }), /другая ширина/u)
})

test('подрайон ставится при начале боя и раздвигается ходом за границу', async () => {
  const { applyGameEvent, normalizeCampaignState } = await import('../server/rules-engine.mjs')
  const { buildThemedScene } = await import('../server/scene-themes.mjs')
  const { legacyCellsFromTacticalMap } = await import('../server/tactical-map.mjs')

  // Подрайон имеет смысл только на большой карте: на маленькой он совпал бы с ней.
  const built = buildThemedScene({ location: 'Тёмный лес', seed: 'bounds', width: 60, height: 60 })
  const state = normalizeCampaignState({
    sessionCode: 'BOUNDS',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: 20, y: 20, level: 1 }],
    enemies: [{ id: 'wolf', name: 'Волк', hp: 5, maxHp: 5, alive: true, x: 24, y: 22 }],
    scene: { title: 'Сцена', location: 'Тёмный лес', cells: legacyCellsFromTacticalMap(built.map) },
    mechanics: { positions: { hero: { x: 20, y: 20 }, wolf: { x: 24, y: 22 } } },
  })
  assert.equal(deserializeTacticalMap(state.scene.map).combatBounds, null, 'до боя подрайона нет')

  const started = applyGameEvent(state, {
    event_type: 'CombatStarted',
    payload: { round: 1, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'wolf' }] },
    actor_id: '', target_ids: ['hero', 'wolf'], source_rule_ids: [],
  })
  const bounds = deserializeTacticalMap(started.scene.map).combatBounds
  assert.ok(bounds, 'начало боя обязано поставить подрайон')
  assert.equal(combatBoundsContain(bounds, 20, 20), true)
  assert.equal(combatBoundsContain(bounds, 24, 22), true)

  const outside = { x: Math.min(59, bounds.maxX + 5), y: 20 }
  assert.equal(combatBoundsContain(bounds, outside.x, outside.y), false, 'точка обязана быть вне подрайона')

  const moved = applyGameEvent(started, {
    event_type: 'ActorMoved',
    payload: { to: outside, distance: 25 },
    actor_id: 'hero', target_ids: ['hero'], source_rule_ids: [],
  })
  const wider = deserializeTacticalMap(moved.scene.map).combatBounds
  assert.equal(combatBoundsContain(wider, outside.x, outside.y), true,
    'выход за границу обязан раздвинуть подрайон, а не быть запрещённым')
  assert.ok(wider.maxX >= bounds.maxX)
})

// --- Расстановка противников (`server/encounter-assembler.mjs`) -------------
// Появление обязано происходить внутри подрайона: на карте 100×100 клетка
// «где-нибудь» — это до двадцати ходов ходьбы, и боя не происходит.

const gridCells = (width, height) => Array.from({ length: width * height }, (_, index) => ({
  x: index % width,
  y: Math.floor(index / width),
  type: 'floor',
  revealed: true,
}))

/**
 * Коридор, у которого свободны только клетки за границей будущего подрайона:
 * ближняя часть занята предметами. Предмет не мешает пройти, но запрещает
 * появление — так проверяется, куда именно смотрит расстановка.
 */
const blockedCorridor = (width) => Array.from({ length: width }, (_, x) => ({
  x,
  y: 0,
  type: 'floor',
  revealed: true,
  ...(x >= 3 && x <= 13 ? { feature: 'barrel' } : {}),
}))

const corridorParty = () => [
  { id: 'hero-1', level: 1, x: 0, y: 0 },
  { id: 'hero-2', level: 1, x: 1, y: 0 },
]

test('на карте класса region противник появляется только внутри подрайона', () => {
  const cells = gridCells(100, 100)
  const party = [{ id: 'hero-1', level: 1, x: 50, y: 50 }, { id: 'hero-2', level: 1, x: 51, y: 50 }]
  const proposal = assembleEncounter({
    scene: { cells }, party, difficulty: 'hard', theme: 'beasts', seed: 'region-spawn',
  })
  const bounds = computeCombatBounds({ width: 100, height: 100 }, party)

  assert.ok(proposal.enemies.length > 0, 'столкновение обязано собраться')
  for (const enemy of proposal.enemies) {
    assert.equal(combatBoundsContain(bounds, enemy.x, enemy.y), true,
      `противник появился в ${enemy.x},${enemy.y} — вне подрайона ${JSON.stringify(bounds)}`)
    assert.ok(Math.max(Math.abs(enemy.x - 50), Math.abs(enemy.y - 50)) <= COMBAT_BOUNDS_MARGIN_CELLS,
      'появление дальше двух ходов от отряда превращает бой в долгий подход')
  }
  // Правило обязано быть заметным: вне подрайона свободных клеток на порядок
  // больше, и раньше расстановка брала их наравне с ближними.
  const inside = cells.filter((cell) => combatBoundsContain(bounds, cell.x, cell.y)).length
  assert.ok(cells.length - inside > inside * 10,
    `вне подрайона ${cells.length - inside} клеток против ${inside} внутри — проверка ничего не доказывает`)
})

test('на карте меньше порога расстановка остаётся прежней', () => {
  const cells = blockedCorridor(28)
  const party = corridorParty()
  assert.equal(combatBoundsUseful({ width: 28, height: 1 }), false, 'на такой карте подрайон бессмыслен')

  const proposal = assembleEncounter({
    scene: { cells }, party, difficulty: 'hard', theme: 'undead', seed: 'small-map-spawn',
  })
  const wouldBeBounds = computeCombatBounds({ width: 28, height: 1 }, party)

  assert.ok(proposal.enemies.length > 0)
  for (const enemy of proposal.enemies) {
    assert.ok(enemy.x >= 14, `противник появился в ${enemy.x},${enemy.y}, а свободны только клетки с x ≥ 14`)
    assert.equal(combatBoundsContain(wouldBeBounds, enemy.x, enemy.y), false,
      'на маленькой карте подрайон не ставится, и расстановка обязана дотягиваться до дальних клеток')
  }
})

test('подрайон без свободной клетки отказывает, а не расставляет за границей', () => {
  // Тот же коридор, что и выше, длиннее на одну клетку: карта переходит порог,
  // подрайон появляется, и внутри него все клетки заняты предметами.
  assert.equal(combatBoundsUseful({ width: 29, height: 1 }), true)
  assert.throws(
    () => assembleEncounter({
      scene: { cells: blockedCorridor(29) },
      party: corridorParty(),
      difficulty: 'hard',
      theme: 'undead',
      seed: 'small-map-spawn',
    }),
    (error) => error?.name === 'EncounterAssemblyError' && error.code === 'NO_SAFE_PLACEMENT_CELLS',
  )
})

test('подрайон расстановки нельзя подсказать входом сборщика', () => {
  const base = {
    scene: { cells: blockedCorridor(29) },
    party: corridorParty(),
    difficulty: 'hard',
    theme: 'undead',
    seed: 'small-map-spawn',
  }
  const forged = { minX: 0, minY: 0, maxX: 99, maxY: 99 }
  const rejected = (code) => (error) => error?.name === 'EncounterAssemblyError' && error.code === code

  assert.throws(() => assembleEncounter({ ...base, combat_bounds: forged }), rejected('UNEXPECTED_ENCOUNTER_FIELD'))
  assert.throws(() => assembleEncounter({ ...base, bounds: forged }), rejected('UNEXPECTED_ENCOUNTER_FIELD'))
  assert.throws(
    () => assembleEncounter({ ...base, scene: { cells: blockedCorridor(29), combat_bounds: forged } }),
    rejected('UNEXPECTED_SCENE_FIELD'),
  )
})

test('расстановка в подрайоне детерминирована и не зависит от порядка входа', () => {
  const cells = gridCells(100, 100)
  const party = [{ id: 'hero-1', level: 1, x: 50, y: 50 }, { id: 'hero-2', level: 1, x: 51, y: 50 }]
  const input = { scene: { cells }, party, difficulty: 'hard', theme: 'beasts', seed: 'region-spawn' }

  const first = assembleEncounter(input)
  const second = assembleEncounter(input)
  const reversed = assembleEncounter({
    ...input,
    scene: { cells: [...cells].reverse() },
    party: [...party].reverse(),
  })

  assert.deepEqual(second, first, 'повтор с тем же входом обязан дать то же предложение')
  assert.deepEqual(reversed, first, 'порядок входа не должен влиять на клетку появления')
})

test('бой на большой карте: противники в подрайоне, replay даёт то же состояние', async () => {
  const { normalizeCampaignState, replayEvents, resolveCommands } = await import('../server/rules-engine.mjs')
  const { DiceService, SequenceDiceRng } = await import('../server/dice-service.mjs')

  const size = 60
  const initial = normalizeCampaignState({
    sessionCode: 'REGION-ENCOUNTER',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Герой', level: 1, hp: 24, maxHp: 24, armor: 15, speed: 30,
      abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 30, y: 30,
    }],
    enemies: [],
    scene: { title: 'Равнина', location: 'Равнина', objective: 'Выжить', turn: 1, cells: gridCells(size, size) },
    mechanics: { positions: { hero: { x: 30, y: 30 } } },
  })

  let rollId = 0
  const result = resolveCommands([
    {
      command_type: 'CreateEncounter',
      expected_state_version: initial.state_version,
      difficulty: 'easy',
      theme: 'beasts',
      seed: 'region-encounter',
      request_fingerprint: 'f'.repeat(64),
    },
    { command_type: 'StartCombat', actor_id: 'hero', server_authoritative: true },
  ], initial, {
    diceService: new DiceService({
      rng: new SequenceDiceRng([17, 12, 9, 6, 4, 2, 11, 8]),
      idFactory: () => `region-roll-${++rollId}`,
      now: () => '2026-07-26T12:00:00.000Z',
    }),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })

  const bounds = deserializeTacticalMap(result.state.scene.map).combatBounds
  assert.ok(bounds, 'бой на карте 60×60 обязан поставить подрайон')
  assert.ok(bounds.minX > 0 && bounds.minY > 0 && bounds.maxX < size - 1 && bounds.maxY < size - 1,
    `подрайон ${JSON.stringify(bounds)} совпал с картой — тогда он ничего не значит`)
  assert.ok(result.state.enemies.length > 0)
  for (const enemy of result.state.enemies) {
    assert.equal(combatBoundsContain(bounds, enemy.x, enemy.y), true)
    assert.ok(Math.max(Math.abs(enemy.x - 30), Math.abs(enemy.y - 30)) <= COMBAT_BOUNDS_MARGIN_CELLS,
      `противник появился в ${enemy.x},${enemy.y} — это дальше двух ходов от отряда`)
  }
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})

test('подрайон доходит до игрока и не открывает нераскрытую часть карты', async () => {
  const { campaignStateForViewer, publicTacticalMapFor } = await import('../server/viewer-projection.mjs')

  const map = createTacticalMap({ width: 100, height: 100, sizeClass: 'region', fill: { passable: true, revealed: false } })
  for (let y = 45; y <= 55; y += 1) {
    for (let x = 45; x <= 55; x += 1) setCell(map, x, y, { revealed: true, material: 'marble', variant: 3 })
  }
  setCell(map, 10, 10, { material: 'marble', variant: 3 })
  applyCombatBounds(map, [{ x: 50, y: 50 }, { x: 52, y: 51 }])
  const serialized = serializeTacticalMap(map)

  const projected = deserializeTacticalMap(publicTacticalMapFor(serialized))
  assert.deepEqual(projected.combatBounds, map.combatBounds, 'камера не соберётся без подрайона в проекции')
  assert.equal(cellAt(projected, 50, 50)?.material, 'marble')
  assert.equal(cellAt(projected, 10, 10)?.material, 'stone', 'нераскрытая клетка не отдаёт материал')
  assert.equal(cellAt(projected, 10, 10)?.variant, 0)

  const viewer = campaignStateForViewer({
    sessionCode: 'REGION-VIEW',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', inventory: [] }],
    scene: { title: 'Равнина', location: 'Равнина', cells: [], map: serialized },
  }, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.deepEqual(viewer.scene.map.combatBounds, map.combatBounds,
    'подрайон обязан дойти до игрока целиком: доска показывает поле боя по нему')
})
