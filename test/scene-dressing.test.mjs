import assert from 'node:assert/strict'
import test from 'node:test'

import { assetById } from '../server/asset-registry.mjs'
import { auditTacticalMap } from '../server/map-quality.mjs'
import { VIGNETTES, placeRuins, placeVignettes, roughenGround } from '../server/scene-dressing.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'
import { addSpawnPoint, addZone, cellAt, createTacticalMap, edgeList, reachableCells, setCell } from '../server/tactical-map.mjs'

/**
 * Поле 24×18: трава, дорога по средней строке, пруд в углу, вход слева.
 * Обстановка обязана обходить воду, дорогу и окрестность входа.
 */
function field() {
  const map = createTacticalMap({ width: 24, height: 18, seed: 'dressing', theme: 'forest' })
  addZone(map, { id: 'field', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Поляна' })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const road = y === 9
      const pond = x >= 19 && y <= 3
      setCell(map, x, y, {
        passable: !pond, revealed: true, zone: 'field',
        material: road ? 'earth' : 'grass', surface: pond ? 'water' : 'none',
      })
    }
  }
  addSpawnPoint(map, { id: 'party', role: 'party', x: 1, y: 9 })
  return map
}

const reachableFromSpawn = (map) => reachableCells(map, 1, 9)
const passableCount = (map) => {
  let count = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.passable) count += 1
  return count
}

test('рецепты виньеток собраны из предметов реестра и не ломают интерактивное состоянием', () => {
  for (const [set, recipes] of Object.entries(VIGNETTES)) {
    for (const recipe of recipes) {
      for (const part of recipe.parts) {
        const asset = assetById(part.asset)
        assert.ok(asset, `${set}/${recipe.id}: ${part.asset} нет в реестре`)
        // Состояние интерактивного предмета — событие правил, не декор.
        if (part.state) assert.equal(asset.interactive, false, `${set}/${recipe.id}: ${part.asset} интерактивен, а стоит «${part.state}»`)
      }
    }
  }
})

test('виньетка встаёт целиком на сухую землю, мимо дороги, воды и входа, и детерминирована', () => {
  const first = field()
  const placed = placeVignettes(first, { seed: 'v1', set: 'wild', zones: ['field'], limit: 2 })
  assert.equal(placed.length, 2, 'на просторном поле встают обе виньетки')
  const props = first.props.filter((prop) => prop.id.startsWith('vignette-'))
  for (const prop of props) {
    const cells = prop.footprint.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const point of cells) {
      const cell = cellAt(first, point.x, point.y)
      assert.ok(cell?.passable && cell.surface !== 'water', `${prop.id}: на воде или скале`)
      assert.notEqual(cell.material, 'earth', `${prop.id}: на дороге`)
      assert.ok(Math.abs(point.x - 1) > 3 || Math.abs(point.y - 9) > 3, `${prop.id}: у входа`)
    }
  }
  // Части одной виньетки не делят клетку.
  const cells = props.filter((prop) => prop.footprint.length).flatMap((prop) => prop.footprint.map((point) => `${point.x},${point.y}`))
  assert.equal(new Set(cells).size, cells.length)
  const second = field()
  placeVignettes(second, { seed: 'v1', set: 'wild', zones: ['field'], limit: 2 })
  assert.deepEqual(second.props.map((prop) => [prop.id, prop.x, prop.y]), first.props.map((prop) => [prop.id, prop.x, prop.y]), 'тот же сид — та же обстановка')
})

test('подлесок — трудная местность пятнами: дорога, вода и вход остаются лёгкими', () => {
  const map = field()
  const changed = roughenGround(map, { seed: 'r1', kind: 'undergrowth', zones: ['field'], patches: 3 })
  assert.ok(changed >= 9, `трудных клеток ${changed}`)
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell.moveCost <= 1) continue
      assert.ok(cell.passable, 'трудная клетка остаётся проходимой')
      assert.notEqual(cell.material, 'earth', 'дорога не дорожает')
      assert.ok(Math.abs(x - 1) > 4 || Math.abs(y - 9) > 4, 'у входа шаг не дорожает')
    }
  }
  assert.ok(map.props.some((prop) => prop.id.startsWith('rough-undergrowth-')), 'подлесок отмечен папоротником и листвой')
  assert.equal(reachableFromSpawn(map).size, passableCount(map), 'досягаемость не меняется')
})

test('завал кладёт щебень на пол и тоже не перекрывает проход', () => {
  const map = field()
  roughenGround(map, { seed: 'r2', kind: 'rubble', zones: ['field'], patches: 2 })
  const rubble = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y).surface === 'rubble') rubble.push(cellAt(map, x, y))
  assert.ok(rubble.length >= 6)
  assert.ok(rubble.every((cell) => cell.moveCost === 2))
})

test('развалины: обрывки стен с двумя проломами, внутрь можно войти', () => {
  const map = field()
  const ruins = placeRuins(map, { seed: 'ruins-1' })
  assert.ok(ruins, 'на просторном поле остов встаёт')
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
  const perimeter = 2 * (ruins.width + ruins.height)
  assert.ok(walls.length >= 6 && walls.length <= perimeter - 4, `стен ${walls.length} из ${perimeter}: не глухой короб и не пустое место`)
  assert.equal(reachableFromSpawn(map).size, passableCount(map), 'каждая клетка, и внутри остова, досягаема от входа')
  const inside = cellAt(map, ruins.x + 1, ruins.y + 1)
  assert.equal(inside.zone, 'field', 'остов — не дом: зона остаётся наружной')
  assert.ok(map.props.some((prop) => prop.id === 'ruins-pillar-1'), 'уцелевшая колонна')
})

test('общий зал трактира помнит драку, а горница жилого дома — нет', () => {
  for (const seed of ['brawl-a', 'brawl-b']) {
    const { map } = buildThemedScene({ seed, width: 36, height: 30, location: 'Трактир трёх дорог', theme: 'таверна', design: { building_use: 'tavern', architecture: 'wood' } })
    const brawl = map.props.filter((prop) => prop.id.startsWith('vignette-after-brawl'))
    assert.ok(brawl.length >= 3, `${seed}: от драки осталось ${brawl.length}`)
    assert.ok(brawl.every((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'hall'), 'драка — в общем зале')
    assert.ok(brawl.some((prop) => prop.state === 'toppled'), 'стулья опрокинуты')
    assert.deepEqual(auditTacticalMap(map).problems, [])
  }
  const { map: house } = buildThemedScene({ seed: 'brawl-a', width: 36, height: 30, location: 'Дом лесничего', theme: 'жилой дом', design: { building_use: 'dwelling', architecture: 'wood' } })
  assert.equal(house.props.some((prop) => prop.id.startsWith('vignette-')), false)
})

test('в пещерном зале — каменный уступ в пять футов со ступенями', () => {
  for (const seed of ['ledge-a', 'ledge-b']) {
    const { map } = buildThemedScene({ seed, width: 36, height: 30, location: 'Пещера контрабандистов', theme: 'пещера', design: {} })
    const hall = map.zones.find((zone) => zone.label === 'Зал')
    let raised = 0
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.zone === hall.id && cell.elevation >= 5) raised += 1
    }
    assert.ok(raised >= 6, `${seed}: на уступе ${raised} клеток`)
    assert.deepEqual(auditTacticalMap(map).problems, [], `${seed}: уступ не отрезает зал`)
  }
})

test('лес, тракт, пещера и склеп получают обстановку и проходят проверку карты', () => {
  const scenes = [
    { location: 'Поляна в Чернолесье', theme: 'лесная поляна', vignette: true, rough: true },
    { location: 'Развалины старой заставы', theme: 'руины у дороги', vignette: true, rough: true, ruins: true },
    { location: 'Пещера контрабандистов', theme: 'пещера', vignette: true, rough: true },
    { location: 'Фамильный склеп', theme: 'склеп', vignette: true },
    // Глубокий снег и сыпучий песок — тоже трудная местность.
    { location: 'Снежный перевал', theme: 'зимний лес в глубоком снегу', design: { climate: 'cold' }, rough: true },
    { location: 'Красные барханы', theme: 'дорога через пустыню', design: { climate: 'arid' }, rough: true },
  ]
  for (const scene of scenes) {
    for (const seed of ['dress-a', 'dress-b']) {
      const { map } = buildThemedScene({ seed, width: 36, height: 30, location: scene.location, theme: scene.theme, design: scene.design ?? {} })
      const label = `${scene.location}/${seed}`
      if (scene.vignette) assert.ok(map.props.some((prop) => prop.id.startsWith('vignette-')), `${label}: нет виньетки`)
      if (scene.rough) {
        let rough = 0
        for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if ((cellAt(map, x, y)?.moveCost ?? 1) > 1) rough += 1
        assert.ok(rough >= 4, `${label}: трудных клеток ${rough}`)
      }
      if (scene.ruins) assert.ok(map.props.some((prop) => prop.id.startsWith('ruins-')), `${label}: развалины обещаны названием`)
      assert.deepEqual(auditTacticalMap(map).problems, [], `${label}: проверка карты`)
    }
  }
})
