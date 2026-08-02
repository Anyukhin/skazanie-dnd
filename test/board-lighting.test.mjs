import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  addProp, addZone, createTacticalMap, serializeTacticalMap, setCell, setDoor, setEdge,
} from '../server/tactical-map.mjs'

/**
 * Сетка освещённости — этап L5 (`docs/multilevel-map-plan.md`, раздел 7.1).
 *
 * Проверяется чистая функция, а не рисование: свет обязан быть
 * детерминированным, зависеть от темы, вида зоны и этажа, не проходить сквозь
 * стены и никогда не опускаться ниже минимума читаемости.
 *
 * Клиентский TypeScript компилируется тем же приёмом, что и в
 * `test/board-render.test.mjs`: сборка во временный каталог и импорт.
 */
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-board-lighting-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board-lighting.ts', '../src/tactical-map-client.ts']
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
const lighting = await import(pathToFileURL(join(buildDir, 'board-lighting.mjs')).href)
const client = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function decoded(map) {
  const clientMap = client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  assert.ok(clientMap, 'карта должна декодироваться')
  return clientMap
}

/** Комната одной зоны: всё проходимо и раскрыто. */
function roomMap({ width = 9, height = 5, theme = 'building', kind = 'interior', levelIndex = 0 } = {}) {
  const map = createTacticalMap({ width, height, locationId: 'loc', seed: 'light', theme, levelIndex })
  addZone(map, { id: 'room', kind, material: 'wood', lightLevel: 'dim', label: 'Комната' })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setCell(map, x, y, { passable: true, revealed: true, zone: 'room' })
  }
  return map
}

function lightOf(map, x, y) {
  const clientMap = decoded(map)
  return lighting.computeLightGrid(clientMap)[y * clientMap.width + x]
}

test('сетка освещённости детерминирована', () => {
  const map = roomMap({ theme: 'crypt' })
  addProp(map, { id: 'fire', assetId: 'campfire', x: 4.5, y: 2.5, footprint: [{ x: 4, y: 2 }] })
  setEdge(map, 6, 2, 7, 2, { kind: 'wall', blocksMove: true, blocksSight: true })

  const first = lighting.computeLightGrid(decoded(map))
  const second = lighting.computeLightGrid(decoded(map))
  assert.deepEqual(Array.from(first), Array.from(second), 'два прогона обязаны дать ту же сетку')
  assert.equal(first.length, map.width * map.height)
})

test('амбиент зависит от темы и вида зоны', () => {
  const crypt = lightOf(roomMap({ theme: 'crypt' }), 0, 0)
  const cave = lightOf(roomMap({ theme: 'cave' }), 0, 0)
  const building = lightOf(roomMap({ theme: 'building' }), 0, 0)
  const temple = lightOf(roomMap({ theme: 'temple' }), 0, 0)
  const yard = lightOf(roomMap({ theme: 'building', kind: 'exterior' }), 0, 0)

  assert.ok(crypt < building, `склеп ${crypt} обязан быть темнее здания ${building}`)
  assert.ok(cave < building, `пещера ${cave} обязана быть темнее здания ${building}`)
  assert.ok(temple < building, `храм ${temple} обязан быть темнее жилого дома ${building}`)
  assert.ok(yard > building, `двор ${yard} обязан быть светлее интерьера ${building}`)
  assert.equal(yard, lighting.AMBIENT_DAYLIGHT, 'снаружи днём — верх шкалы амбиента')
})

test('этаж без зон получает амбиент темы целиком', () => {
  // Пещера зон не размечает: свет обязан взяться из темы, а не из умолчания.
  const map = createTacticalMap({ width: 6, height: 4, seed: 'cave', theme: 'cave' })
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 6; x += 1) setCell(map, x, y, { passable: true, revealed: true })
  const grid = lighting.computeLightGrid(decoded(map))
  const zoned = lightOf(roomMap({ theme: 'cave' }), 0, 0)
  assert.ok(grid.every((value) => value === zoned), 'без зон карта светится ровно амбиентом темы')
})

test('огонь поднимает свет рядом с собой и не светит сквозь стену-ребро', () => {
  const map = roomMap({ theme: 'crypt', width: 9, height: 3 })
  // Стена на всю высоту комнаты: обойти её нельзя ни одним путём.
  for (let y = 0; y < 3; y += 1) {
    setEdge(map, 5, y, 6, y, { kind: 'wall', blocksMove: true, blocksSight: true })
  }
  const ambient = lightOf(map, 8, 1)
  addProp(map, { id: 'torch', assetId: 'torch_wall', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })

  const atSource = lightOf(map, 1, 1)
  const near = lightOf(map, 3, 1)
  const behindWall = lightOf(map, 6, 1)

  assert.ok(atSource > near, `в клетке факела ${atSource} обязано быть светлее, чем в трёх шагах ${near}`)
  assert.ok(near > ambient, `рядом с факелом ${near} обязано быть светлее амбиента ${ambient}`)
  assert.equal(behindWall, ambient, 'за стеной-ребром свет факела остаться не должен')
})

test('закрытая дверь свет держит, открытая — пропускает', () => {
  const closed = roomMap({ theme: 'crypt', width: 9, height: 3 })
  for (let y = 0; y < 3; y += 1) {
    if (y === 1) continue
    setEdge(closed, 5, y, 6, y, { kind: 'wall', blocksMove: true, blocksSight: true })
  }
  setDoor(closed, { id: 'door', x: 5, y: 1, dir: 'e', state: 'closed' })
  addProp(closed, { id: 'fire', assetId: 'campfire', x: 4.5, y: 1.5, footprint: [{ x: 4, y: 1 }] })
  const shut = lightOf(closed, 6, 1)

  const open = roomMap({ theme: 'crypt', width: 9, height: 3 })
  for (let y = 0; y < 3; y += 1) {
    if (y === 1) continue
    setEdge(open, 5, y, 6, y, { kind: 'wall', blocksMove: true, blocksSight: true })
  }
  setDoor(open, { id: 'door', x: 5, y: 1, dir: 'e', state: 'open' })
  addProp(open, { id: 'fire', assetId: 'campfire', x: 4.5, y: 1.5, footprint: [{ x: 4, y: 1 }] })
  const ajar = lightOf(open, 6, 1)

  assert.ok(ajar > shut, `сквозь открытую дверь ${ajar} обязано светить сильнее, чем сквозь закрытую ${shut}`)
})

test('окно даёт свет внутрь помещения', () => {
  const width = 10
  const map = createTacticalMap({ width, height: 3, seed: 'window', theme: 'building' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Двор' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Зал' })
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, zone: x < 3 ? 'yard' : 'hall' })
    }
  }
  setEdge(map, 2, 1, 3, 1, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'half' })

  const inside = lightOf(map, 3, 1)
  const deepInside = lightOf(map, 9, 1)
  const outside = lightOf(map, 2, 1)
  const plainInterior = lightOf(roomMap({ theme: 'building' }), 0, 0)

  assert.ok(inside > deepInside, `у окна ${inside} обязано быть светлее, чем в глубине зала ${deepInside}`)
  assert.ok(inside > plainInterior, `у окна ${inside} обязано быть светлее ровного интерьера ${plainInterior}`)
  assert.equal(deepInside, plainInterior, 'в глубине зала окно не достаёт — там чистый амбиент темы')
  assert.ok(outside >= lighting.AMBIENT_DAYLIGHT, 'на улице и так день, темнее от окна там не становится')
})

test('подвал темнее первого этажа, верхний этаж — как первый', () => {
  const ground = lightOf(roomMap({ theme: 'building', levelIndex: 0 }), 0, 0)
  const cellar = lightOf(roomMap({ theme: 'building', levelIndex: -1 }), 0, 0)
  const upper = lightOf(roomMap({ theme: 'building', levelIndex: 1 }), 0, 0)

  assert.ok(cellar < ground, `подвал ${cellar} обязан быть темнее первого этажа ${ground}`)
  assert.equal(upper, ground, 'верхний этаж света не теряет')
})

test('свет клампится минимумом читаемости и дневным потолком', () => {
  // Подвал склепа — самый тёмный случай контракта: без клампа он ушёл бы в 70,
  // и карта в раскрытой области стала бы чёрным прямоугольником.
  const dark = lighting.computeLightGrid(decoded(roomMap({ theme: 'crypt', levelIndex: -1 })))
  assert.ok(dark.every((value) => value === lighting.LIGHT_MIN_READABLE),
    'подвал склепа обязан лежать ровно на минимуме читаемости, а не ниже')

  const map = roomMap({ theme: 'crypt', levelIndex: -1 })
  addProp(map, { id: 'fire', assetId: 'campfire', x: 4.5, y: 2.5, footprint: [{ x: 4, y: 2 }] })
  addProp(map, { id: 'fire2', assetId: 'fireplace', x: 4.5, y: 2.5, footprint: [{ x: 4, y: 2 }] })
  const grid = lighting.computeLightGrid(decoded(map))

  assert.ok(grid.every((value) => value >= lighting.LIGHT_MIN_READABLE),
    'раскрытая карта не имеет права быть чернее минимума читаемости')
  assert.ok(grid.every((value) => value <= lighting.LIGHT_FULL))
  assert.equal(grid[2 * map.width + 4], lighting.LIGHT_FULL, 'два костра в одной клетке упираются в потолок')
})

test('сетка запоминается по карте и пересчитывается при смене источника', () => {
  const map = roomMap({ theme: 'crypt' })
  addProp(map, { id: 'torch', assetId: 'torch_wall', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
  const clientMap = decoded(map)

  const first = lighting.lightGridFor(clientMap)
  assert.equal(lighting.lightGridFor(clientMap), first, 'та же карта — та же сетка, без пересчёта')

  // Панорама и зум карту не меняют, поэтому и отпечаток обязан остаться прежним.
  const signature = lighting.lightSignature(clientMap)
  assert.equal(lighting.lightSignature(decoded(map)), signature, 'копия той же карты даёт тот же отпечаток')

  addProp(map, { id: 'fire', assetId: 'campfire', x: 6.5, y: 2.5, footprint: [{ x: 6, y: 2 }] })
  const withFire = decoded(map)
  assert.notEqual(lighting.lightSignature(withFire), signature, 'новый источник обязан обесценить сетку')
  assert.ok(lighting.lightGridFor(withFire)[2 * withFire.width + 6] > first[2 * clientMap.width + 6],
    'у нового костра обязано стать светлее')
})

test('источниками света считаются только огненные предметы, включая старые записи', () => {
  assert.equal(lighting.lightSourceAssetId('barrel'), null)
  assert.equal(lighting.lightSourceAssetId('campfire'), 'campfire')
  assert.equal(lighting.lightSourceAssetId('torch'), 'torch_wall', 'старое значение feature обязано светиться')
  const sources = lighting.lightSourcesOf(decoded((() => {
    const map = roomMap()
    addProp(map, { id: 'barrel', assetId: 'barrel', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
    addProp(map, { id: 'torch', assetId: 'torch', x: 3.5, y: 1.5, footprint: [{ x: 3, y: 1 }] })
    return map
  })()))
  assert.deepEqual(sources.map((source) => [source.x, source.y]), [[3, 1]], 'бочка светиться не обязана')
})
