import assert from 'node:assert/strict'
import test from 'node:test'

import { assetById } from '../server/asset-registry.mjs'
import { auditTacticalMap } from '../server/map-quality.mjs'
import { VIGNETTES, markLowFurniture, placeRuins, placeRuinsField, placeVignettes, roughenGround, vignettesNamedBy } from '../server/scene-dressing.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'
import { addProp, addSpawnPoint, addZone, cellAt, createTacticalMap, edgeList, reachableCells, setCell } from '../server/tactical-map.mjs'

/**
 * Поле 24×18: трава, дорога по средней строке, пруд в углу, вход слева.
 * Обстановка обязана обходить воду, дорогу и окрестность входа.
 */
function field(width = 24, height = 18) {
  const map = createTacticalMap({ width, height, seed: 'dressing', theme: 'forest' })
  addZone(map, { id: 'field', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Поляна' })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const road = y === 9
      const pond = x >= width - 5 && y <= 3
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
const roughCount = (map, zone = null) => {
  let count = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if ((cell?.moveCost ?? 1) > 1 && (!zone || cell.zone === zone)) count += 1
  }
  return count
}
const vignettesOn = (map) => [...new Set(map.props.filter((prop) => prop.id.startsWith('vignette-')).map((prop) => prop.id.replace(/^vignette-(.*)-\d+-\d+$/u, '$1')))]
const ruinsOn = (map) => new Set(map.props.filter((prop) => prop.id.startsWith('ruins-')).map((prop) => prop.id.split('-')[1])).size

test('рецепты виньеток собраны из реестра, а у события без примет есть слова, по которым его узнают', () => {
  for (const [set, recipes] of Object.entries(VIGNETTES)) {
    for (const recipe of recipes) {
      // Событие без слов не ставится, значит слова у него обязаны быть.
      assert.ok(recipe.ambient || recipe.cue, `${set}/${recipe.id}: ни слов, ни тихой приметы — не встанет никогда`)
      for (const part of recipe.parts) {
        const asset = assetById(part.asset)
        assert.ok(asset, `${set}/${recipe.id}: ${part.asset} нет в реестре`)
        // Состояние интерактивного предмета — событие правил, не декор.
        if (part.state) assert.equal(asset.interactive, false, `${set}/${recipe.id}: ${part.asset} интерактивен, а стоит «${part.state}»`)
      }
    }
  }
  assert.deepEqual(vignettesNamedBy('wild', 'Остывшее кострище, а вокруг волчьи следы').sort(), ['abandoned-camp', 'beast-lair'])
  assert.deepEqual(vignettesNamedBy('wild', 'Обломки стен и следы чужого привала'), ['abandoned-camp'])
  assert.deepEqual(vignettesNamedBy('tavern', 'После вчерашней драки'), ['after-brawl'])
  assert.deepEqual(vignettesNamedBy('wild', 'Тихая поляна'), [])
})

test('событие встаёт только по слову описания, тихая примета — и без слов', () => {
  const silent = field()
  const placedSilently = placeVignettes(silent, { seed: 'v1', set: 'wild', zones: ['field'], limit: 2 })
  for (const id of placedSilently) {
    assert.equal(VIGNETTES.wild.find((recipe) => recipe.id === id)?.ambient, true, `без слов встало событие ${id}`)
  }
  const told = field()
  const placed = placeVignettes(told, { seed: 'v1', set: 'wild', zones: ['field'], limit: 0, text: 'У обочины опрокинута телега, рядом кострище' })
  assert.deepEqual(placed.sort(), ['abandoned-camp', 'cart-wreck'], 'названное встаёт сверх предела')
  for (const prop of told.props.filter((entry) => entry.id.startsWith('vignette-'))) {
    const cells = prop.footprint.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const point of cells) {
      const cell = cellAt(told, point.x, point.y)
      assert.ok(cell?.passable && cell.surface !== 'water', `${prop.id}: на воде или скале`)
      assert.notEqual(cell.material, 'earth', `${prop.id}: на дороге`)
      assert.ok(Math.abs(point.x - 1) > 3 || Math.abs(point.y - 9) > 3, `${prop.id}: у входа`)
    }
  }
  const again = field()
  placeVignettes(again, { seed: 'v1', set: 'wild', zones: ['field'], limit: 0, text: 'У обочины опрокинута телега, рядом кострище' })
  assert.deepEqual(again.props.map((prop) => [prop.id, prop.x, prop.y]), told.props.map((prop) => [prop.id, prop.x, prop.y]), 'тот же сид и текст — та же обстановка')
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

test('завал и грязь меняют покрытие клетки, низкая мебель дорожает под собой', () => {
  const rubble = field()
  roughenGround(rubble, { seed: 'r2', kind: 'rubble', zones: ['field'], patches: 2 })
  const mud = field()
  roughenGround(mud, { seed: 'r3', kind: 'mud', zones: ['field'], patches: 2 })
  for (const [map, surface] of [[rubble, 'rubble'], [mud, 'mud']]) {
    const cells = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y).surface === surface) cells.push(cellAt(map, x, y))
    assert.ok(cells.length >= 6, `${surface}: клеток ${cells.length}`)
    assert.ok(cells.every((cell) => cell.moveCost === 2))
  }
  const hall = field()
  addProp(hall, { id: 'bench', assetId: 'prayer_bench', x: 12, y: 13.5, footprint: [{ x: 11, y: 13 }, { x: 12, y: 13 }] })
  addProp(hall, { id: 'crate', assetId: 'crate', x: 15.5, y: 13.5, footprint: [{ x: 15, y: 13 }], blocksMove: true })
  assert.equal(markLowFurniture(hall, ['prayer_bench', 'crate']), 2, 'дорожают две клетки скамьи, а не ящик, который держит шаг')
  assert.equal(cellAt(hall, 11, 13).moveCost, 2)
  assert.equal(cellAt(hall, 15, 13).moveCost, 1)
})

test('развалины трёх форм: в каждую можно войти, остов не дом', () => {
  for (const shape of ['house', 'tower', 'wall']) {
    const map = field(30, 22)
    const ruins = placeRuins(map, { seed: `ruins-${shape}`, shape })
    assert.ok(ruins, `${shape}: на просторном поле встаёт`)
    assert.equal(ruins.shape, shape)
    const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
    const length = shape === 'wall' ? Math.max(ruins.width, ruins.height) : 2 * (ruins.width + ruins.height)
    assert.ok(walls.length >= 4 && walls.length <= length - 2, `${shape}: стен ${walls.length} из ${length} — не глухой короб и не пустое место`)
    assert.equal(reachableFromSpawn(map).size, passableCount(map), `${shape}: каждая клетка досягаема от входа`)
    assert.equal(cellAt(map, ruins.x, ruins.y).zone, 'field', `${shape}: зона остаётся наружной`)
  }
  // По слову — хотя бы один остов; на большой карте их бывает несколько, и
  // второй не встаёт на первый.
  const wide = field(48, 40)
  assert.ok(placeRuinsField(wide, { seed: 'field-1', asked: true }) >= 1)
  assert.equal(reachableFromSpawn(wide).size, passableCount(wide))
  const quiet = field(24, 18)
  assert.equal(placeRuinsField(quiet, { seed: 'field-2', asked: false, chance: 0 }), 0, 'без слов и без случая остова нет')
})

test('трактир помнит драку, только если о ней сказано', () => {
  const tavern = { width: 36, height: 30, location: 'Трактир трёх дорог', theme: 'таверна', design: { building_use: 'tavern', architecture: 'wood' } }
  for (const seed of ['brawl-a', 'brawl-b']) {
    const { map: told } = buildThemedScene({ ...tavern, seed, description: 'После вчерашней драки трактирщик ещё не прибрался.' })
    const brawl = told.props.filter((prop) => prop.id.startsWith('vignette-after-brawl'))
    assert.ok(brawl.length >= 3, `${seed}: от драки осталось ${brawl.length}`)
    assert.ok(brawl.every((prop) => cellAt(told, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'hall'), 'драка — в общем зале')
    assert.ok(brawl.some((prop) => prop.state === 'toppled'), 'стулья опрокинуты')
    assert.deepEqual(auditTacticalMap(told).problems, [])
    const { map: silent } = buildThemedScene({ ...tavern, seed })
    assert.deepEqual(vignettesOn(silent), [], `${seed}: драки без слов нет`)
  }
})

test('храм: скамьи и подушки — низкая мебель, заброшенный храм — с обвалами', () => {
  const temple = { width: 36, height: 30, location: 'Храм Утренней звезды', theme: 'храм', design: {} }
  for (const seed of ['temple-a', 'temple-b']) {
    const { map } = buildThemedScene({ ...temple, seed })
    const low = map.props.filter((prop) => ['prayer_bench', 'kneeling_cushions'].includes(prop.assetId))
    assert.ok(low.length > 0, `${seed}: в храме нет скамей`)
    for (const prop of low) for (const point of prop.footprint) assert.equal(cellAt(map, point.x, point.y).moveCost, 2, `${seed}: ${prop.id} не дорожает`)
    const { map: ruined } = buildThemedScene({ ...temple, seed, description: 'Заброшенный храм, свод местами обвалился.' })
    let rubble = 0
    for (let y = 0; y < ruined.height; y += 1) for (let x = 0; x < ruined.width; x += 1) if (cellAt(ruined, x, y)?.surface === 'rubble') rubble += 1
    assert.ok(rubble >= 6, `${seed}: обвалов ${rubble}`)
    assert.ok(reachableCells(ruined, ruined.spawnPoints[0].x, ruined.spawnPoints[0].y).size > 0)
  }
})

test('деревня: грязь во дворах, не на улице; пепелище по слову', () => {
  const village = { width: 44, height: 38, location: 'Деревня Кленовка', theme: 'деревня', design: { topology: 'organic', architecture: 'wood' } }
  for (const seed of ['village-a', 'village-b']) {
    const { map } = buildThemedScene({ ...village, seed })
    assert.ok(roughCount(map, 'common') >= 6, `${seed}: грязи во дворах ${roughCount(map, 'common')}`)
    assert.equal(roughCount(map, 'street'), 0, 'улица остаётся лёгкой')
    assert.equal(roughCount(map, 'square'), 0, 'площадь остаётся лёгкой')
    const { map: burned } = buildThemedScene({ ...village, seed, description: 'На краю деревни — пепелище сгоревшего двора.' })
    assert.ok(ruinsOn(burned) >= 1, `${seed}: пепелище названо, а остова нет`)
  }
  const { map: winter } = buildThemedScene({ ...village, seed: 'village-a', design: { ...village.design, climate: 'cold' } })
  assert.ok(winter.props.some((prop) => prop.id.startsWith('rough-snow-')), 'зимой во дворах — снег, а не грязь')
})

test('лес, тракт, кладбище, пещера, склеп, зима и пустыня получают обстановку и проходят проверку карты', () => {
  const scenes = [
    { location: 'Поляна в Чернолесье', theme: 'лесная поляна', rough: true, quiet: true },
    { location: 'Поляна в Чернолесье', theme: 'лесная поляна', description: 'Остывшее кострище, вокруг волчьи следы.', named: ['abandoned-camp', 'beast-lair'], rough: true },
    { location: 'Развалины старой заставы', theme: 'руины у дороги', rough: true, ruins: true },
    { location: 'Старое кладбище', theme: 'кладбище', rough: true },
    { location: 'Пещера контрабандистов', theme: 'пещера', named: ['smuggler-cache'], rough: true },
    { location: 'Фамильный склеп', theme: 'склеп', description: 'Сектанты проводили здесь обряд.', named: ['ritual-site'] },
    { location: 'Снежный перевал', theme: 'зимний лес', design: { climate: 'cold' }, description: 'Древние руины сторожевой башни.', rough: true, ruins: true },
    { location: 'Красные барханы', theme: 'дорога через пустыню', design: { climate: 'arid' }, rough: true },
  ]
  for (const scene of scenes) {
    for (const seed of ['dress-a', 'dress-b']) {
      const { map } = buildThemedScene({ seed, width: 36, height: 30, location: scene.location, theme: scene.theme, design: scene.design ?? {}, description: scene.description ?? '' })
      const label = `${scene.location}/${seed}`
      const placed = vignettesOn(map)
      for (const id of scene.named ?? []) assert.ok(placed.includes(id), `${label}: названная сцена ${id} не встала (${placed})`)
      // Без слов — только тихие приметы, событий карта не выдумывает.
      if (scene.quiet) {
        const events = placed.filter((id) => !Object.values(VIGNETTES).flat().find((recipe) => recipe.id === id)?.ambient)
        assert.deepEqual(events, [], `${label}: событие без слов`)
      }
      if (scene.rough) assert.ok(roughCount(map) >= 4, `${label}: трудных клеток ${roughCount(map)}`)
      if (scene.ruins) assert.ok(ruinsOn(map) >= 1, `${label}: развалины обещаны текстом`)
      assert.deepEqual(auditTacticalMap(map).problems, [], `${label}: проверка карты`)
    }
  }
})
