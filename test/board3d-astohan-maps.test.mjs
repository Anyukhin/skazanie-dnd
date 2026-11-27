// Карты мест «Асстоханских равнин» в 3D: сцена собирается из каталога без
// ошибок, у каждого предмета есть объёмная модель (не заглушка «unknown»), у
// каждой двери — полотно, а объём геометрии укладывается в бюджет кадра.
// Карты рисуются вручную (`data/authored-maps/`), и 2D-аудит `map-quality` не
// видит, как предмет выглядит в объёме, — этот тест и есть проверка в 3D.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as THREE from 'three'

import { compileClientModules } from './kit/client-ts.mjs'
import { cellAt, deserializeTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const build = await compileClientModules(['src/board3d-scene.ts', 'src/tactical-map-client.ts'])
const [scene3d, mapClient] = build.modules
const props3d = await build.load('src/board3d-props.ts')
const boardRender = await build.load('src/board-render.ts')

const CATALOG = JSON.parse(readFileSync(new URL('../data/authored-location-maps-v1.json', import.meta.url), 'utf8'))
const ASTOHAN = CATALOG.maps.filter((map) => String(map.locationId).startsWith('astohan-'))

test('модели походного стола, мастерской и скелета привязаны к авторским экземплярам', () => {
  const library = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE)
  try {
    for (const [place, suffix, kind] of [
      ['quiet-watch-camp', 'gedrik-war-table', 'story-gedrik-table'],
      ['lomar-tower', 'lab-alchemy-table', 'story-lomar-bench'],
      ['vulkanis-brazier', 'vulkanis-skull', 'story-vulkanis-skull'],
      ['vulkanis-brazier', 'vulkanis-chest', 'fossil-chest'],
      ['vulkanis-brazier', 'vulkanis-wing', 'fossil-wing'],
    ]) {
      const location = 'astohan-' + place
      const map = mapClient.decodeTacticalMap(ASTOHAN.find(raw => raw.locationId === location))
      const prop = map.props.find(p => p.id === location + ':' + suffix)
      const model = library.create(prop)
      assert.equal(model.userData.modelKind, kind)
      assert.equal(model.userData.modelSource, 'procedural-story')
      assert.notEqual(library.create({ ...prop, id: 'ordinary' }).userData.modelKind, kind)
      if (['war_table','alchemy_table'].includes(prop.assetId)) assert.ok(model.userData.surfaceHeight > .5)
      const bounds = new THREE.Box3().setFromObject(model, true)
      const size = bounds.getSize(new THREE.Vector3())
      const spanX = new Set(prop.footprint.map(cell => cell.x)).size
      const spanZ = new Set(prop.footprint.map(cell => cell.y)).size
      assert.ok(size.x > .6 && size.x <= spanX && size.z > .3 && size.z <= spanZ, prop.id)
    }
  } finally { library.dispose() }
})

test('круг клятв занимает отведённую поляну и остаётся низкой вымосткой', () => {
  const map = mapClient.decodeTacticalMap(ASTOHAN.find(m => m.locationId === 'astohan-cursed-woods'))
  const prop = map.props.find(p => p.id === 'astohan-cursed-woods:oath-ritual-circle')
  const library = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE)
  try {
    const model = library.create(prop)
    const stone = model.getObjectByName('oath-circle-paving')
    assert.ok(stone)
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
    assert.ok(size.x > 2.5 && size.x <= 3 && size.z > 2.5 && size.z <= 3)
    assert.ok(size.y < .15 && stone.geometry.attributes.position.count < 12000)
    assert.equal(library.create({ ...prop, id: 'another-circle' }).getObjectByName('oath-circle-paving'), undefined)
  } finally { library.dispose() }
})

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

test('дневник палача остаётся объёмной книгой после загрузки атласа рассыпанных листов', () => {
  const map = revealedClientMap(ASTOHAN.find(raw => raw.locationId === 'astohan-forgotten-cliffs'))
  const diary = map.props.find(prop => prop.id === 'astohan-forgotten-cliffs:executioner-diary')
  const loosePaper = map.props.find(prop => prop.assetId === 'paper_scatter' && prop !== diary)
  const stamp = new THREE.Texture({ width: 96, height: 92 })
  const models = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE, {
    catalog: { models: [] }, models: new Map(), stamps: new Map([['paper_scatter', stamp]]),
  })
  try {
    const book = models.create(diary)
    const size = new THREE.Box3().setFromObject(book).getSize(new THREE.Vector3())
    assert.equal(models.create(loosePaper).userData.modelSource, 'stamp')
    assert.ok(size.y > .035 && size.y < .08 && size.x < .5 && size.z < .5, 'закрытая книга помещается в свою клетку')
    assert.ok(book.getObjectByName('diary-bound-cover') && book.getObjectByName('diary-clasp') && book.getObjectByName('diary-gathering'))
    assert.ok(triangles(book) < 5000, 'бюджет уникального реквизита')
  } finally {
    models.dispose()
    stamp.dispose()
  }
})

test('Великое Древо занимает свою поляну и сохраняет особый силуэт при загруженном каталоге дубов', () => {
  const map = revealedClientMap(ASTOHAN.find(raw => raw.locationId === 'astohan-eldrin-heart'))
  const eldrin = map.props.find(prop => prop.id.endsWith(':great-tree-eldrin'))
  const sapling = map.props.find(prop => prop.id.endsWith(':eldrin-sapling-oak'))
  const template = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  const catalog = { models: [{ key: 'test-oak', assetIds: ['tree_oak'], yaw: 0 }] }
  const models = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['test-oak', template]]) })
  try {
    const oak = models.create(eldrin)
    assert.equal(models.create(sapling).userData.modelSource, 'glb')
    assert.equal(oak.userData.modelKind, 'story-eldrin')
    const bounds = new THREE.Box3().setFromObject(oak)
    const footprint = boardRender.propVisualLayout(eldrin)
    assert.ok(bounds.min.x >= footprint.x - footprint.width / 2 && bounds.max.x <= footprint.x + footprint.width / 2)
    assert.ok(bounds.min.z >= footprint.y - footprint.depth / 2 && bounds.max.z <= footprint.y + footprint.depth / 2)
    assert.ok(bounds.max.y >= 4 && bounds.max.y <= 5, 'Древо высотой в четыре-пять клеток')
    assert.ok(triangles(oak) <= 60_000, 'бюджет уникального дерева на карте')
  } finally {
    models.dispose()
    template.geometry.dispose()
    template.material.dispose()
  }
})

for (const storyProp of [
  { locationId: 'astohan-ash-watch', propId: 'astohan-ash-watch:burnt-journal', kind: 'story-journal', parts: ['journal-cover', 'journal-page-block', 'journal-charred-page-edge', 'journal-written-leaf', 'journal-clasp'] },
  { locationId: 'astohan-forgotten-cliffs', propId: 'astohan-forgotten-cliffs:fresco-1', kind: 'story-fresco-crown', parts: ['fresco-panel', 'fresco-knight-presenting-crown', 'fresco-knight-shield', 'fresco-dragon-profile', 'fresco-dragon-wing', 'fresco-presented-crown'] },
  { locationId: 'astohan-forgotten-cliffs', propId: 'astohan-forgotten-cliffs:fresco-2', kind: 'story-fresco-execution', parts: ['fresco-panel', 'fresco-execution-knight', 'fresco-cursed-sword', 'fresco-cursed-blood'] },
  { locationId: 'astohan-forgotten-cliffs', propId: 'astohan-forgotten-cliffs:fresco-3', kind: 'story-fresco-head', parts: ['fresco-panel', 'fresco-stone-arch', 'fresco-head-stone', 'fresco-head-face'] },
]) {
  test(`3D: авторский предмет ${storyProp.propId} имеет сюжетный рельеф`, () => {
    const map = revealedClientMap(ASTOHAN.find((raw) => raw.locationId === storyProp.locationId))
    const storyMapProp = map.props.find((prop) => prop.id === storyProp.propId)
    assert.ok(storyMapProp, `${storyProp.propId}: карта не содержит проп`)
    storyMapProp.interactive = true
    const scene = scene3d.createBoard3DScene(map)
    const models = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE)
    try {
      const object = scene.group.getObjectByName(`prop:${storyProp.propId}`)
      assert.ok(object, `${storyProp.propId}: нет объекта`)
      assert.equal(object.userData.modelKind, storyProp.kind)
      assert.equal(object.userData.modelSource, 'procedural-story')
      if (storyProp.kind.startsWith('story-fresco-')) {
        assert.equal(object.userData.storyWallMount, true)
        assert.equal(object.userData.storyWallNormal, 'south')
      }
      const rawProp = map.props.find((prop) => prop.id === storyProp.propId)
      assert.ok(rawProp, `${storyProp.propId}: нет исходного пропа`)
      const unbatched = models.create(rawProp)
      for (const part of storyProp.parts) assert.ok(unbatched.getObjectByName(part), `${storyProp.propId}: нет ${part}`)
      const localBounds = new THREE.Box3().setFromObject(unbatched)
      if (storyProp.kind === 'story-journal') {
        assert.ok(localBounds.min.y < .01 && localBounds.max.y > .03 && localBounds.max.y < .095, 'книга лежит на полу, страницы имеют объём')
      } else {
        assert.ok(localBounds.max.y > .09, 'настенный рельеф имеет объём')
      }
      if (storyProp.kind.startsWith('story-fresco-')) assert.ok(unbatched.getObjectByName('fresco-panel')?.position.z < -0.2, `${storyProp.propId}: панель не прижата к северной стене`)
      const storyTriangles = triangles(unbatched)
      assert.ok(storyTriangles >= 100, `${storyProp.propId}: рельеф слишком простой (${storyTriangles} треугольников)`)
      assert.ok(storyTriangles <= 5_000, `${storyProp.propId}: рельеф слишком тяжёлый (${storyTriangles} треугольников)`)
      if (storyProp.kind.startsWith('story-fresco-')) {
        const atlas = new THREE.Texture()
        const atlasModels = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE, undefined, { storyFrescoAtlas: atlas })
        const atlasModel = atlasModels.create(rawProp)
        const atlasFront = atlasModel.getObjectByName('fresco-atlas-front')
        assert.ok(atlasFront, `${storyProp.propId}: нет лицевой панели атласа`)
        assert.ok(!Array.isArray(atlasFront.material), `${storyProp.propId}: лицевая панель имеет несколько материалов`)
        const atlasMap = atlasFront.material.map
        assert.ok(atlasMap, `${storyProp.propId}: атлас не привязан к материалу`)
        assert.equal(atlasMap, atlas, 'у панелей одна текстура')
        const column = storyProp.kind === 'story-fresco-crown' ? 0 : storyProp.kind === 'story-fresco-execution' ? 1 : 2
        const uv = atlasFront.geometry.attributes.uv
        for (let i = 0; i < uv.count; i += 1) assert.ok(uv.getX(i) > column / 3 && uv.getX(i) < (column + 1) / 3)
        atlasModels.dispose()
        atlas.dispose()
      }
      assert.ok(scene.getPropPickTargets().some((target) => target.propId === storyProp.propId && !target.bounds.isEmpty()), `${storyProp.propId}: нет pick-границы`)
    } finally {
      models.dispose()
      scene.dispose()
    }
  })
}

for (const id of ['astohan-vulkanis-brazier', 'astohan-obsidian-pass']) {
  test(`3D: лава ${id} светится и течёт, валунов на ней нет`, () => {
    const map = revealedClientMap(ASTOHAN.find((raw) => raw.locationId === id))
    const lavaCells = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = mapClient.cellAt(map, x, y)
      if (/lava/u.test(cell?.hazardId ?? '')) {
        lavaCells.push(cell)
        // Для правил лава — огонь за непроходимой кромкой.
        assert.equal(cell.passable, false)
      }
    }
    assert.ok(lavaCells.length >= 20, `${id}: клеток лавы ${lavaCells.length}`)
    const scene = scene3d.createBoard3DScene(map, { landscapeDetail: 'full' })
    try {
      const lava = scene.group.getObjectByName('lava-surface')
      assert.ok(lava, `${id}: нет глади лавы`)
      assert.equal(lava.geometry.index.count / 6, lavaCells.length, 'гладь — по квадрату на клетку лавы')
      assert.ok(lava.material.emissiveIntensity > 0)
      const lights = []
      scene.group.traverse((object) => { if (object.name === 'lava-light') lights.push(object) })
      assert.ok(lights.length > 0 && lights.length <= 6, `${id}: огней лавы ${lights.length}`)
      assert.ok(lights.every((light) => !light.castShadow), 'отсвет лавы без теней')
      // Валуны скал стоят по своим клеткам; центр ни одного — не в клетке лавы.
      const lavaKeys = new Set(lavaCells.map((cell) => `${cell.x},${cell.y}`))
      const rocks = scene.group.getObjectByName('landscape-rocks')
      const onLava = []
      rocks?.updateMatrixWorld(true)
      rocks?.traverse((object) => {
        if (!object.isInstancedMesh) return
        const matrix = new object.matrix.constructor()
        for (let index = 0; index < object.count; index += 1) {
          object.getMatrixAt(index, matrix)
          matrix.premultiply(object.matrixWorld)
          const x = matrix.elements[12], z = matrix.elements[14]
          const fx = x - Math.floor(x), fz = z - Math.floor(z)
          if (fx > .3 && fx < .7 && fz > .3 && fz < .7 && lavaKeys.has(`${Math.floor(x)},${Math.floor(z)}`)) onLava.push(`${x.toFixed(1)},${z.toFixed(1)}`)
        }
      })
      assert.deepEqual(onLava, [], `${id}: валуны посреди лавы`)
      assert.equal(scene.animated, true)
      scene.animate(4000)
      assert.equal(lava.material.userData.time.value, 4)
    } finally {
      scene.dispose()
    }
    const economy = scene3d.createBoard3DScene(map, { landscapeDetail: 'minimal' })
    try {
      let lights = 0
      economy.group.traverse((object) => { if (object.name === 'lava-light') lights += 1 })
      assert.equal(lights, 0, 'на «Экономном» отсвета нет, гладь светится сама')
      assert.ok(economy.group.getObjectByName('lava-surface'))
    } finally {
      economy.dispose()
    }
  })
}

// Высота клетки авторской карты (`elevation` легенды) рисуется так же, как у
// сгенерированной: пол площадки поднят на футы/5 клетки, у обрыва — стенки
// скалы, предмет стоит на своей площадке.
for (const [id, propId, feet] of [
  ['astohan-vulkanis-brazier', 'sargath-kin-statue', 15],
  ['astohan-forgotten-cliffs', 'throne', 15],
  ['astohan-obsidian-pass', 'cattle-bones', 15],
]) {
  test(`3D: ${id} показывает перепад высот, предметы стоят на площадках`, () => {
    const map = revealedClientMap(ASTOHAN.find((raw) => raw.locationId === id))
    let highest = 0
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) highest = Math.max(highest, mapClient.cellAt(map, x, y)?.elevation ?? 0)
    assert.equal(highest, feet, `${id}: самая высокая площадка`)
    const scene = scene3d.createBoard3DScene(map)
    try {
      const sides = scene.group.getObjectByName('terrain-sides')
      assert.ok(sides, `${id}: у перепада нет стенок скалы`)
      sides.geometry.computeBoundingBox()
      assert.ok(sides.geometry.boundingBox.max.y >= feet / 5 - 0.01, `${id}: стенки ниже площадки`)
      const prop = scene.group.getObjectByName(`prop:${id}:${propId}`)
      assert.ok(prop, `${id}: нет ${propId}`)
      const lift = new prop.position.constructor()
      prop.getWorldPosition(lift)
      assert.ok(lift.y >= feet / 5 - 0.01, `${id}: ${propId} стоит на ${lift.y}, а не на площадке`)
    } finally {
      scene.dispose()
    }
  })
}

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

test('3D: клетки Тобана читаются как птичьи клетки с жердью и кормушкой', () => {
  const map = revealedClientMap(ASTOHAN.find((raw) => raw.locationId === 'astohan-redstone'))
  const models = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE)
  try {
    for (const propId of ['astohan-redstone:toban-swift-cage', 'astohan-redstone:toban-swift-cage-2']) {
      const prop = map.props.find((entry) => entry.id === propId)
      assert.ok(prop, `${propId}: клетка не найдена на авторской карте`)
      const object = models.create(prop)
      assert.equal(object.userData.modelKind, 'story-swift-cage')
      assert.equal(object.userData.modelSource, 'procedural-story')
      assert.ok(object.getObjectByName('swift-cage-perch'), `${propId}: нет жерди`)
      assert.ok(object.getObjectByName('swift-cage-feed-cup'), `${propId}: нет кормушки`)
      assert.ok(object.getObjectByName('swift-cage-wireframe'), `${propId}: нет закрытого каркаса купола`)
      assert.ok(object.getObjectByName('swift-cage-door-frame'), `${propId}: нет дверцы`)
      assert.ok(triangles(object) >= 500, `${propId}: клетка недостаточно детальна`)
      assert.ok(triangles(object) <= 5_000, `${propId}: клетка вышла за бюджет`)
      object.traverse((child) => {
        if (child.isMesh) assert.ok(child.castShadow || child.name === 'swift-cage-straw', `${propId}: деталь без тени ${child.name}`)
      })
    }
  } finally {
    models.dispose()
  }
})

test('3D: тюремные iron_cage остаются решёткой, а не закрытым ящиком', () => {
  const map = revealedClientMap(ASTOHAN.find((raw) => raw.locationId === 'astohan-forgotten-cliffs'))
  const prop = map.props.find((entry) => entry.assetId === 'iron_cage')
  assert.ok(prop, 'на карте замка нет тюремной клетки')
  const models = props3d.createEnvironmentModels(boardRender.DEFAULT_BOARD_PALETTE)
  try {
    const object = models.create(prop)
    assert.equal(object.userData.modelKind, 'iron-cage')
    assert.ok(object.getObjectByName('iron-cage-bar'))
    assert.ok(triangles(object) >= 300)
    const bounds = new THREE.Box3().setFromObject(object)
    assert.ok(bounds.max.y > .72 && bounds.max.y < .80, 'резервная клеть совпадает по высоте с игровым cage_small')
    assert.ok(!object.getObjectByName('swift-cage-feed-cup'))
  } finally {
    models.dispose()
  }
})
