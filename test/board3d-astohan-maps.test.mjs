// Карты мест «Асстоханских равнин» в 3D: сцена собирается из каталога без
// ошибок, у каждого предмета есть объёмная модель (не заглушка «unknown»), у
// каждой двери — полотно, а объём геометрии укладывается в бюджет кадра.
// Карты рисуются вручную (`data/authored-maps/`), и 2D-аудит `map-quality` не
// видит, как предмет выглядит в объёме, — этот тест и есть проверка в 3D.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'
import { cellAt, deserializeTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const build = await compileClientModules(['src/board3d-scene.ts', 'src/tactical-map-client.ts'])
const [scene3d, mapClient] = build.modules

const CATALOG = JSON.parse(readFileSync(new URL('../data/authored-location-maps-v1.json', import.meta.url), 'utf8'))
const ASTOHAN = CATALOG.maps.filter((map) => String(map.locationId).startsWith('astohan-'))

/**
 * Треугольники полностью раскрытой карты без теней. Замер 2026-10-06: карты
 * 50–56×40–44 дают 0,33–0,56 млн; карта до 100×100 (решение владельца — у
 * игроков сильные ПК) укладывается в 3 млн. В игре строится только раскрытое,
 * так что кадр на деле легче. Превышение — сигнал, что карта стала неподъёмной.
 */
const TRIANGLE_BUDGET = 3_000_000

/** Карта клиента с раскрытыми клетками: в 3D строится только раскрытое. */
function revealedClientMap(raw) {
  const map = deserializeTacticalMap(structuredClone(raw))
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
  }
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

function triangles(root) {
  let total = 0
  root.traverse((object) => {
    const geometry = object.geometry
    if (!object.isMesh || !geometry) return
    const count = geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count ?? 0
    total += (count / 3) * (object.isInstancedMesh ? object.count : 1)
  })
  return Math.round(total)
}

test('каталог содержит все 14 мест Асстохана', () => {
  assert.equal(ASTOHAN.length, 14)
})

for (const raw of ASTOHAN) {
  test(`3D: ${raw.locationId} собирается, предметы и двери на месте, геометрия в бюджете`, () => {
    const map = revealedClientMap(raw)
    const scene = scene3d.createBoard3DScene(map)
    try {
      const props = new Map()
      scene.group.traverse((object) => { if (object.name.startsWith('prop:')) props.set(object.name.slice('prop:'.length), object) })
      const missing = map.props.filter((prop) => !props.has(prop.id)).map((prop) => `${prop.assetId}@${prop.id}`)
      assert.deepEqual(missing, [], `${raw.locationId}: предметы без 3D-объекта`)
      const unknown = [...props.values()].filter((object) => object.userData.modelKind === 'unknown').map((object) => object.userData.assetId)
      assert.deepEqual([...new Set(unknown)], [], `${raw.locationId}: предметы без объёмной модели рисуются заглушкой`)
      const leaves = new Set()
      scene.group.traverse((object) => {
        const match = /^door-leaf:(\d+,\d+,[es])/u.exec(object.name)
        if (match) leaves.add(match[1])
      })
      const doors = map.doors.filter((door) => door.state !== 'broken').map((door) => `${door.x},${door.y},${door.dir}`)
      assert.deepEqual(doors.filter((key) => !leaves.has(key)), [], `${raw.locationId}: двери без полотна в 3D`)
      const total = triangles(scene.group)
      assert.ok(total > 0, `${raw.locationId}: пустая сцена`)
      assert.ok(total <= TRIANGLE_BUDGET, `${raw.locationId}: ${total} треугольников больше бюджета ${TRIANGLE_BUDGET}`)
    } finally {
      scene.dispose()
    }
  })
}
