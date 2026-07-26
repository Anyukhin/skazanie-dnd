import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  PROJECTED_MAP_CACHE_LIMIT,
  compactSceneFor,
  compactStateForTransport,
  forgetProjectedMaps,
  sceneMapUpdateFor,
} from '../server/reveal-transport.mjs'
import { publicSceneFor, publicTacticalMapWithHashFor } from '../server/viewer-projection.mjs'
import {
  addProp,
  cellAt,
  createTacticalMap,
  deserializeTacticalMap,
  serializeTacticalMap,
  setCell,
} from '../server/tactical-map.mjs'

/**
 * Транспорт дельт раскрытия — раздел 11.2 `docs/tactical-map-plan.md`.
 *
 * Проверяется именно то, что нельзя проверить в `reveal-delta.mjs`: решение,
 * что отправить, и поведение клиента, который карту потерял.
 */

// --- клиентский разбор компилируется тем же приёмом, что и board-render ---

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-reveal-transport-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/scene-map-cache.ts', '../src/tactical-map-client.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith('.js')) continue
  const source = readFileSync(join(buildDir, name), 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(buildDir, name.replace(/\.js$/, '.mjs')), source)
  rmSync(join(buildDir, name))
}
// Клиентский модуль пересобирает слой в base64 через `btoa`/`atob`: под Node их
// нет в глобальной области ровно так, как в браузере, но реализация есть.
globalThis.atob ??= (value) => Buffer.from(value, 'base64').toString('binary')
globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64')
const cache = await import(pathToFileURL(join(buildDir, 'scene-map-cache.mjs')).href)
const client = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

/** Однородная карта: раскрытие на ней — единственное, что видит проекция. */
function plainMap({ width = 30, height = 30, revealed = false } = {}) {
  return createTacticalMap({ width, height, seed: 'transport', fill: { passable: true, revealed } })
}

/**
 * Правдоподобная карта: материал полосами по местности, вариант тайла — на
 * каждой клетке свой, как его ставят настоящие генераторы
 * (`Math.floor(random() * 6)` в `building-generator.mjs`, `dynamic-map.mjs`,
 * `graph-layout.mjs`, `scene-themes.mjs`).
 *
 * Замерять объём дельты на однородной карте нельзя: у неё однородны все слои,
 * каждый сжимается в одно число, и полная карта 100×100 весит 2.23 КБ — с ней
 * не сравнится никакая дельта, и порог перестаёт что-либо ловить.
 *
 * Полосы материала намеренно шире раскрываемой области: так материал и
 * поверхность внутри неё однородны и стоят в дельте одно число, а по карте в
 * целом различаются.
 */
function plausibleMap({ width = 100, height = 100 } = {}) {
  const map = createTacticalMap({ width, height, seed: 'plausible', fill: { passable: true, revealed: false } })
  let seed = 20260726
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let y = 0; y < height; y += 1) {
    const material = y < height / 4 ? 'grass' : y < (height * 3) / 4 ? 'earth' : 'sand'
    for (let x = 0; x < width; x += 1) setCell(map, x, y, { material, variant: Math.floor(random() * 6) })
  }
  return map
}

/** Проекция карты вместе с хешем — ровно то, что уходит игроку. */
function project(map) {
  const projected = publicTacticalMapWithHashFor(serializeTacticalMap(map))
  assert.ok(projected, 'проекция карты обязана состояться')
  return projected
}

function revealCircle(map, cx, cy, radius) {
  let opened = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!cellAt(map, x, y) || Math.hypot(x - cx, y - cy) > radius) continue
      if (cellAt(map, x, y)?.revealed) continue
      setCell(map, x, y, { revealed: true })
      opened += 1
    }
  }
  return opened
}

test.beforeEach(() => {
  forgetProjectedMaps()
  cache.forgetSceneMaps()
})

// --- сервер ---------------------------------------------------------------

test('клиент подключился в середине боя — карты у него нет, уходит целиком', () => {
  const map = plainMap()
  revealCircle(map, 15, 15, 5)
  const { map: projected, hash } = project(map)

  const cold = sceneMapUpdateFor(projected, hash)
  assert.equal(cold.kind, 'full', 'без хеша клиент обязан получить карту целиком')
  assert.equal(cold.hash, hash)
  assert.deepEqual(cold.map, projected)

  const unknown = sceneMapUpdateFor(projected, hash, 'ниоткуда')
  assert.equal(unknown.kind, 'full', 'неизвестный хеш — это отсутствие карты')
})

test('карта не менялась — обновление о ней молчит', () => {
  const { map: projected, hash } = project(plainMap())
  sceneMapUpdateFor(projected, hash)
  const again = sceneMapUpdateFor(projected, hash, hash)
  assert.equal(again.kind, 'unchanged')
  assert.equal(again.hash, hash)
})

test('раскрытие за ход уходит дельтой, а не картой', () => {
  const map = plausibleMap({ width: 100, height: 100 })
  revealCircle(map, 50, 50, 12)
  const before = project(map)
  sceneMapUpdateFor(before.map, before.hash)

  const opened = revealCircle(map, 50, 50, 18)
  const after = project(map)
  const update = sceneMapUpdateFor(after.map, after.hash, before.hash)

  assert.equal(update.kind, 'delta')
  assert.equal(update.delta.baseHash, before.hash, 'дельта обязана назвать карту, к которой применима')
  assert.notEqual(update.hash, before.hash, 'хеш результата обязан отличаться от базового')

  const deltaSize = Buffer.byteLength(JSON.stringify(update.delta)) / 1024
  const fullSize = Buffer.byteLength(JSON.stringify(after.map)) / 1024
  console.log(`  раскрыто ${opened} клеток: дельта ${deltaSize.toFixed(2)} КБ против карты ${fullSize.toFixed(2)} КБ`)
  assert.ok(deltaSize <= 4, `дельта ${deltaSize.toFixed(2)} КБ, порог раздела 13 — 4 КБ`)
  assert.ok(deltaSize < fullSize / 10, 'дельта обязана быть на порядок дешевле карты')
})

test('дельта не раскрывает больше, чем полная проекция', () => {
  const map = plainMap({ width: 40, height: 40 })
  revealCircle(map, 20, 20, 6)
  const before = project(map)
  sceneMapUpdateFor(before.map, before.hash)
  revealCircle(map, 20, 20, 10)
  const after = project(map)

  const update = sceneMapUpdateFor(after.map, after.hash, before.hash)
  assert.equal(update.kind, 'delta')

  // Инвариант `AGENTS.md` §5: клиент с дельтой обязан прийти ровно к той карте,
  // которую отдала бы полная проекция. Ни клеткой больше.
  const authoritative = deserializeTacticalMap(after.map)
  const restored = deserializeTacticalMap(
    client.applySerializedRevealDelta(before.map, update.delta),
  )
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      assert.equal(
        cellAt(restored, x, y)?.revealed,
        cellAt(authoritative, x, y)?.revealed,
        `клетка ${x},${y} раскрыта по-разному`,
      )
    }
  }
  const raw = deserializeTacticalMap(serializeTacticalMap(map))
  for (const [start, length] of update.delta.revealed) {
    for (let index = start; index < start + length; index += 1) {
      const x = index % 40
      const y = Math.floor(index / 40)
      assert.equal(cellAt(raw, x, y)?.revealed, true,
        `дельта раскрывает клетку ${x},${y}, которая в состоянии не раскрыта`)
    }
  }
})

test('материал и вариант тайла доезжают дельтой, а не откатом на полную карту', () => {
  // Проекция обезличивает материал, вариант тайла и поверхность нераскрытой
  // клетки, а при раскрытии возвращает их. Формат v2 несёт эти значения, и
  // разнородная карта больше не заставляет отправлять сетку целиком.
  const map = plainMap({ width: 20, height: 20 })
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      setCell(map, x, y, { material: y < 10 ? 'wood' : 'marble', variant: (x * 3 + y) % 6 })
    }
  }
  for (let x = 6; x < 14; x += 1) setCell(map, x, 12, { surface: 'water' })
  revealCircle(map, 10, 10, 3)
  const before = project(map)
  sceneMapUpdateFor(before.map, before.hash)
  revealCircle(map, 10, 10, 6)
  const after = project(map)

  const update = sceneMapUpdateFor(after.map, after.hash, before.hash)
  assert.equal(update.kind, 'delta', 'значения слоёв обязаны уехать дельтой')

  // Сторож видимости всё равно проверяется буквально: собранная карта обязана
  // совпасть с проекцией по каждой клетке, а не только по туману.
  const authoritative = deserializeTacticalMap(after.map)
  const restored = deserializeTacticalMap(client.applySerializedRevealDelta(before.map, update.delta))
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      const expected = cellAt(authoritative, x, y)
      const actual = cellAt(restored, x, y)
      assert.equal(actual?.revealed, expected?.revealed, `клетка ${x},${y} раскрыта по-разному`)
      assert.equal(actual?.material, expected?.material, `клетка ${x},${y}: материал разошёлся`)
      assert.equal(actual?.variant, expected?.variant, `клетка ${x},${y}: вариант тайла разошёлся`)
      assert.equal(actual?.surface, expected?.surface, `клетка ${x},${y}: поверхность разошлась`)
    }
  }
})

test('раскрытие, которое открывает предмет, уходит картой целиком', () => {
  // Дельта несёт слои клеток, но не предметы, рёбра и двери: проекция прячет
  // предмет до раскрытия его клетки, и собрать его из дельты не из чего.
  // Сторож обязан это поймать и отдать карту целиком, а не пустое место.
  const map = plainMap({ width: 20, height: 20 })
  addProp(map, { id: 'well', assetId: 'well', x: 10.5, y: 15.5, footprint: [{ x: 10, y: 15 }] })
  revealCircle(map, 10, 10, 3)
  const before = project(map)
  sceneMapUpdateFor(before.map, before.hash)
  revealCircle(map, 10, 10, 6)
  const after = project(map)

  const update = sceneMapUpdateFor(after.map, after.hash, before.hash)
  assert.equal(update.kind, 'full', 'дельта, расходящаяся с полной проекцией, отправляться не должна')
  assert.deepEqual(update.map, after.map)
})

test('карта сменилась под игроком — дельта от прежней не применяется', () => {
  const first = plainMap({ width: 20, height: 20 })
  revealCircle(first, 10, 10, 4)
  const before = project(first)
  sceneMapUpdateFor(before.map, before.hash)

  // Другая сцена: другой размер сетки.
  const second = plainMap({ width: 30, height: 30 })
  revealCircle(second, 15, 15, 4)
  const resized = project(second)
  assert.equal(sceneMapUpdateFor(resized.map, resized.hash, before.hash).kind, 'full',
    'дельта между картами разного размера отправляться не должна')

  // Другая сцена того же размера: подмена содержимого дельтой не покрывается.
  const sameSize = plainMap({ width: 20, height: 20 })
  for (let y = 0; y < 20; y += 1) setCell(sameSize, 5, y, { passable: false })
  revealCircle(sameSize, 10, 10, 8)
  const swapped = project(sameSize)
  assert.equal(sceneMapUpdateFor(swapped.map, swapped.hash, before.hash).kind, 'full',
    'другая карта того же размера обязана уйти целиком')
})

test('вытесненная из кэша карта означает полную отправку, а не расхождение', () => {
  const map = plainMap({ width: 10, height: 10 })
  revealCircle(map, 5, 5, 2)
  const before = project(map)
  sceneMapUpdateFor(before.map, before.hash)

  // Заполнители обязаны быть попарно разными: кэш адресуется содержимым, и
  // повтор той же карты занимает не новое место, а прежнее — вытеснения бы не
  // случилось и тест проверял бы не то, что заявляет.
  const hashes = new Set()
  for (let index = 0; index < PROJECTED_MAP_CACHE_LIMIT + 1; index += 1) {
    const filler = plainMap({ width: 10, height: 10 })
    revealCircle(filler, index % 10, Math.floor(index / 10), 1)
    const projected = project(filler)
    hashes.add(projected.hash)
    sceneMapUpdateFor(projected.map, projected.hash)
  }
  assert.equal(hashes.size, PROJECTED_MAP_CACHE_LIMIT + 1, 'заполнители обязаны быть разными картами')

  revealCircle(map, 5, 5, 4)
  const after = project(map)
  assert.equal(sceneMapUpdateFor(after.map, after.hash, before.hash).kind, 'full')
})

test('сцена собирается в один из трёх видов и не теряет остальных полей', () => {
  const map = plainMap({ width: 16, height: 16 })
  revealCircle(map, 8, 8, 3)
  const scene = publicSceneFor({ title: 'Зал', location: 'Крепость', map: serializeTacticalMap(map) })
  assert.ok(scene.map_hash, 'проекция обязана назвать карту хешем')

  const cold = compactSceneFor(scene, '')
  assert.equal(cold.scene.map != null, true, 'без кэша уходит карта целиком')
  assert.equal(cold.hash, scene.map_hash)

  const warm = compactSceneFor(scene, scene.map_hash)
  assert.equal(warm.scene.map, undefined)
  assert.equal(warm.scene.map_unchanged, true)
  assert.equal(warm.scene.map_hash, scene.map_hash)
  assert.equal(warm.scene.title, 'Зал', 'остальные поля сцены обязаны уцелеть')

  revealCircle(map, 8, 8, 6)
  const next = publicSceneFor({ title: 'Зал', location: 'Крепость', map: serializeTacticalMap(map) })
  const delta = compactSceneFor(next, scene.map_hash)
  assert.equal(delta.scene.map, undefined)
  assert.equal(delta.scene.map_delta?.baseHash, scene.map_hash)
  assert.equal(delta.hash, next.map_hash)
})

test('состояние без карты и состояние администратора проходят без изменений', () => {
  const plain = { scene: { title: 'Без карты', cells: [] } }
  assert.equal(compactStateForTransport(plain, 'что-нибудь').state, plain)
  assert.equal(compactStateForTransport(null, '').state, null)
})

test('хеш считается от проекции, а не от исходной карты', () => {
  // Две карты, различающиеся только в нераскрытой части, для игрока одинаковы:
  // проекция обезличивает её. Хеш обязан это отражать, иначе клиент будет
  // перекачивать карту после каждого изменения невидимого угла.
  const left = plainMap({ width: 12, height: 12 })
  const right = plainMap({ width: 12, height: 12 })
  revealCircle(left, 6, 6, 3)
  revealCircle(right, 6, 6, 3)
  setCell(left, 0, 0, { material: 'wood', variant: 5 })
  setCell(right, 0, 0, { material: 'ice', variant: 1 })
  assert.equal(cellAt(left, 0, 0)?.revealed, false, 'подменённая клетка обязана быть нераскрытой')
  assert.equal(project(left).hash, project(right).hash)
})

// --- клиент ---------------------------------------------------------------

test('клиент накладывает дельту на закэшированную карту', () => {
  const map = plainMap({ width: 24, height: 24 })
  revealCircle(map, 12, 12, 4)
  const before = project(map)
  sceneMapUpdateFor(before.map, before.hash)
  revealCircle(map, 12, 12, 8)
  const after = project(map)
  const update = sceneMapUpdateFor(after.map, after.hash, before.hash)
  assert.equal(update.kind, 'delta')

  const first = cache.resolveSceneMap({ map: before.map, map_hash: before.hash })
  assert.ok(first?.map, 'карта целиком обязана осесть в кэше')
  assert.equal(cache.latestSceneMapHash(), before.hash)

  const second = cache.resolveSceneMap({ map_hash: after.hash, map_delta: update.delta })
  assert.ok(second, 'дельта поверх закэшированной карты обязана примениться')
  assert.equal(second.map_delta, undefined, 'до доски доходит карта, а не дельта')

  const authoritative = deserializeTacticalMap(after.map)
  const restored = deserializeTacticalMap(second.map)
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      assert.equal(client.revealedAt(restored, x, y), cellAt(authoritative, x, y)?.revealed === true,
        `клетка ${x},${y} раскрыта по-разному`)
    }
  }
})

test('клиент потерял дельту — обнаруживает это, а не рисует расхождение', () => {
  const map = plainMap({ width: 20, height: 20 })
  revealCircle(map, 10, 10, 3)
  const first = project(map)
  sceneMapUpdateFor(first.map, first.hash)
  cache.resolveSceneMap({ map: first.map, map_hash: first.hash })

  revealCircle(map, 10, 10, 5)
  const second = project(map)
  const missed = sceneMapUpdateFor(second.map, second.hash, first.hash)
  assert.equal(missed.kind, 'delta')

  revealCircle(map, 10, 10, 7)
  const third = project(map)
  const next = sceneMapUpdateFor(third.map, third.hash, second.hash)
  assert.equal(next.kind, 'delta')

  // Обновление со второй дельтой потеряно: базовой карты в кэше нет.
  assert.equal(cache.resolveSceneMap({ map_hash: third.hash, map_delta: next.delta }), null,
    'дельта от карты, которой нет, обязана быть отвергнута')

  // И карта, о которой сервер промолчал, тоже не выдумывается.
  assert.equal(cache.resolveSceneMap({ map_hash: third.hash, map_unchanged: true }), null)

  // Восстановление: карта целиком снова делает кэш пригодным.
  assert.ok(cache.resolveSceneMap({ map: third.map, map_hash: third.hash })?.map)
  assert.ok(cache.resolveSceneMap({ map_hash: third.hash, map_unchanged: true })?.map)
})

test('клиент отвергает дельту от карты другого размера и чужой версии формата', () => {
  const small = plainMap({ width: 10, height: 10 })
  const projected = project(small)
  const values = { material: 0, variant: 0, surface: 0 }
  const delta = { version: client.REVEAL_DELTA_VERSION, baseHash: projected.hash, width: 20, revealed: [[0, 1]], hidden: [], values }
  assert.equal(client.applySerializedRevealDelta(projected.map, delta), null, 'другая ширина — наложить нельзя')
  assert.equal(client.applySerializedRevealDelta(projected.map, { ...delta, width: 10, version: 'другая' }), null)
  assert.equal(client.applySerializedRevealDelta(projected.map, {
    ...delta, width: 10, revealed: [[95, 20]],
  }), null, 'интервал за пределами карты обязан быть отвергнут')

  // Годная дельта того же вида накладывается: проверки выше отвергают именно
  // испорченное, а не всё подряд.
  assert.ok(client.applySerializedRevealDelta(projected.map, { ...delta, width: 10 }),
    'дельта нужной ширины и версии обязана примениться')

  // Значения слоёв обязаны покрывать затронутые клетки ровно один раз.
  assert.equal(client.applySerializedRevealDelta(projected.map, { ...delta, width: 10, values: {} }), null,
    'дельта без значений слоёв обязана быть отвергнута')
  assert.equal(client.applySerializedRevealDelta(projected.map, {
    ...delta, width: 10, revealed: [[0, 4]], values: { ...values, variant: btoa('') },
  }), null, 'значений меньше, чем клеток, — дорисовывать нельзя')
  assert.equal(client.applySerializedRevealDelta(projected.map, {
    ...delta, width: 10, values: { ...values, material: client.MATERIALS.length },
  }), null, 'материал вне перечисления обязан быть отвергнут')
})

test('сцена без карты доходит до доски как есть', () => {
  const scene = { title: 'Старый формат', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] }
  assert.equal(cache.resolveSceneMap(scene), scene)
})
