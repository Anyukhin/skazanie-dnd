import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCENE_THEMES,
  buildThemedScene,
  fallbackThemeFor,
  isLiveTheme,
  layoutOrganicCave,
  layoutOpenTerrain,
  layoutSettlement,
  matchTheme,
  sceneGraphForTheme,
  themeFor,
  themeFromMapRequest,
} from '../server/scene-themes.mjs'
import { validateSceneGraph } from '../server/scene-graph.mjs'
import { assetsForTheme } from '../server/asset-registry.mjs'
import { cellAt, edgeList, edgeNeighbor, reachableCells, serializeTacticalMap, setEdge, validateTacticalMap } from '../server/tactical-map.mjs'

const THEMES = ['building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement']

test('план требует шесть тем сверх здания — все объявлены', () => {
  assert.deepEqual(SCENE_THEMES.map((theme) => theme.id).sort(), [...THEMES].sort())
  for (const theme of SCENE_THEMES) {
    assert.ok(['building', 'graph', 'open', 'settlement'].includes(theme.kind), `${theme.id}: неизвестный способ сборки`)
    assert.ok(theme.label, `${theme.id}: нет подписи`)
  }
})

test('тема опознаётся по названию локации', () => {
  const cases = [
    ['Таверна «Сломанное колесо»', 'building'],
    ['Храм Утренней Звезды', 'temple'],
    ['Склеп Норвин', 'crypt'],
    ['Пещера у водопада', 'cave'],
    ['Тёмный лес', 'forest'],
    ['Северный тракт', 'road'],
    ['Деревня Заречье', 'settlement'],
  ]
  for (const [location, expected] of cases) {
    assert.equal(themeFor({ location }).id, expected, `«${location}» опознан неверно`)
  }
})

test('постоялый двор под любым именем — здание', () => {
  // Караван-сарай стоял в игре как «keep»: серый лабиринт вместо двора с
  // постройкой. Слово в названии есть, а темы у него не было.
  for (const location of [
    'Заброшенный караван-сарай', 'Вход в древний караван-сарай на торговом пути',
    'Подворье у переправы', 'Ночлежка на окраине', 'Особняк наместника', 'Терем воеводы',
  ]) {
    assert.equal(themeFor({ location }).id, 'building', `«${location}» опознан неверно`)
  }
  // Торговый караван в пути постройкой не является. Спрашиваем `matchTheme`:
  // `themeFor` подставляет здание как тему по умолчанию и на этот вопрос не
  // отвечает.
  assert.equal(matchTheme({ location: 'Разграбленный караван' }), null)
})

test('к живой игре отдаются только темы с готовой геометрией', () => {
  const live = SCENE_THEMES.filter(isLiveTheme).map((theme) => theme.id).sort()
  assert.deepEqual(live, [...THEMES].sort())
  for (const theme of SCENE_THEMES) {
    assert.equal(typeof theme.live, 'boolean', `${theme.id}: готовность не объявлена`)
  }
})

test('поселение содержит дома-зоны, двери и непрерывную главную улицу', () => {
  const settlement = SCENE_THEMES.find((theme) => theme.id === 'settlement')
  for (const seed of ['village-a', 'village-b']) {
    const map = layoutSettlement(settlement, { seed, width: 28, height: 24 })
    assert.deepEqual(validateTacticalMap(map).errors, [], `${seed}: поселение невалидно`)
    const houses = map.zones.filter((zone) => zone.id.startsWith('house-'))
    assert.equal(houses.length, 4, `${seed}: домов ${houses.length}`)
    assert.equal(map.doors.filter((door) => door.id.startsWith('house-door-')).length, houses.length,
      `${seed}: не у каждого дома есть дверь`)

    const spawn = map.spawnPoints.find((point) => point.role === 'party')
    const reached = reachableCells(map, spawn.x, spawn.y)
    for (const house of houses) {
      const interior = []
      let adjacentWalls = 0
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const cell = cellAt(map, x, y)
          if (cell?.passable && cell.zone === house.id) {
            interior.push({ x, y })
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const neighbor = cellAt(map, x + dx, y + dy)
              if (neighbor && !neighbor.passable && neighbor.material === 'wood') adjacentWalls += 1
            }
          }
        }
      }
      assert.ok(interior.length >= 10, `${seed}/${house.id}: дом не имеет читаемого интерьера`)
      assert.ok(adjacentWalls >= 6, `${seed}/${house.id}: дом не окружён стенами`)
      assert.ok(interior.some((cell) => reached.has(`${cell.x},${cell.y}`)),
        `${seed}/${house.id}: из улицы нельзя войти в дом`)
    }

    const streetStart = []
    for (let y = 0; y < map.height; y += 1) {
      if (cellAt(map, 0, y)?.zone === 'street') streetStart.push({ x: 0, y })
    }
    const streetReached = new Set(streetStart.map((cell) => `${cell.x},${cell.y}`))
    const queue = [...streetStart]
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = current.x + dx
        const y = current.y + dy
        const key = `${x},${y}`
        const cell = cellAt(map, x, y)
        if (!streetReached.has(key) && cell?.passable && cell.zone === 'street') {
          streetReached.add(key)
          queue.push({ x, y })
        }
      }
    }
    assert.ok([...streetReached].some((key) => key.startsWith(`${map.width - 1},`)),
      `${seed}: главная улица не пересекает карту`)
  }

  const built = buildThemedScene({ location: 'Деревня Заречье', seed: 'village-props', width: 28, height: 24 }).map
  const assets = new Set(built.props.map((prop) => prop.assetId))
  for (const asset of ['market_stall', 'well', 'cart']) {
    assert.ok(assets.has(asset), `в поселении нет ${asset}`)
  }
})

test('пещера — одна связная органическая полость, а не прямоугольные палаты', () => {
  const cave = SCENE_THEMES.find((theme) => theme.id === 'cave')
  for (const seed of ['organic-a', 'organic-b', 'organic-c']) {
    const map = layoutOrganicCave(cave, { seed, width: 28, height: 24 })
    const floor = []
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (cellAt(map, x, y)?.passable) floor.push({ x, y })
      }
    }
    const spawn = map.spawnPoints.find((point) => point.role === 'party')
    assert.ok(spawn, `${seed}: нет устья`)
    assert.equal(reachableCells(map, spawn.x, spawn.y).size, floor.length,
      `${seed}: внутри полости есть отрезанный участок`)

    const minX = Math.min(...floor.map((cell) => cell.x))
    const maxX = Math.max(...floor.map((cell) => cell.x))
    const minY = Math.min(...floor.map((cell) => cell.y))
    const maxY = Math.max(...floor.map((cell) => cell.y))
    const boundingArea = (maxX - minX + 1) * (maxY - minY + 1)
    assert.ok(floor.length / boundingArea < 0.72,
      `${seed}: полость заполняет ${(floor.length / boundingArea).toFixed(2)} своего прямоугольника`)

    const rowWidths = new Set()
    for (let y = minY; y <= maxY; y += 1) {
      rowWidths.add(floor.filter((cell) => cell.y === y).length)
    }
    assert.ok(rowWidths.size >= 6, `${seed}: контур имеет всего ${rowWidths.size} разных ширин`)

    const occupiedZones = new Set(floor.map((cell) => cellAt(map, cell.x, cell.y)?.zone).filter(Boolean))
    assert.equal(occupiedZones.size, map.zones.length, `${seed}: один из залов графа не получил геометрию`)
  }
})

test('узор из заявки картографа называет тему, когда название молчит', () => {
  assert.equal(themeFromMapRequest({ pattern: 'crypt' })?.id, 'crypt')
  assert.equal(themeFromMapRequest({ pattern: 'crypt', layout: 'cavern' })?.id, 'crypt')
  assert.equal(themeFromMapRequest({ pattern: 'cave-cluster' })?.id, 'cave')
  assert.equal(themeFromMapRequest({ pattern: 'village' })?.id, 'settlement')
  assert.equal(themeFromMapRequest({ pattern: 'bridge' })?.id, 'road')
  assert.equal(themeFromMapRequest({ layout: 'cavern' })?.id, 'cave')
  assert.equal(themeFromMapRequest({ layout: 'streets' })?.id, 'settlement')
  // Неоднозначные узоры сами тему не называют: для них отдельно работает
  // fallback по сочетанию kind/layout/pattern.
  for (const pattern of ['keep', 'great-hall', 'courtyard', 'natural', 'small-room']) {
    assert.equal(themeFromMapRequest({ pattern }), null, `${pattern}: подменён темой`)
  }
  assert.equal(themeFromMapRequest(), null)
})

test('неопознанная локация получает тематический fallback по топологии заявки', () => {
  const cases = [
    [{ sceneKind: 'dungeon', request: { layout: 'rooms', pattern: 'natural' } }, 'crypt'],
    [{ request: { layout: 'cavern', pattern: 'natural' } }, 'cave'],
    [{ request: { layout: 'streets', pattern: 'natural' } }, 'settlement'],
    [{ sceneKind: 'wilderness', request: { layout: 'open', pattern: 'natural' } }, 'forest'],
    [{ request: { layout: 'rooms', pattern: 'keep', material: 'stone' } }, 'crypt'],
    [{ request: { layout: 'rooms', pattern: 'small-room', material: 'wood' } }, 'building'],
    [{ request: {} }, 'road'],
  ]
  for (const [input, expected] of cases) {
    const fallback = fallbackThemeFor(input)
    assert.equal(fallback.id, expected)
    assert.equal(isLiveTheme(fallback), true, `${expected}: fallback не готов к живой игре`)
  }
})

test('дикая местность не становится зданием, даже если в названии есть дом', () => {
  assert.equal(themeFor({ location: 'Дом у дороги', sceneKind: 'wilderness' }).id !== 'building', true)
  assert.equal(themeFor({ location: 'Дом травницы' }).id, 'building')
  // Неопознанная дикая местность — лес, а не таверна.
  assert.equal(themeFor({ location: 'Безымянная пустошь', sceneKind: 'wilderness' }).id, 'forest')
})

test('у каждой темы есть предметы в реестре и они ей принадлежат', () => {
  for (const theme of SCENE_THEMES) {
    if (theme.kind === 'building') continue
    const assets = assetsForTheme(theme.id)
    assert.ok(assets.length >= 5, `у темы ${theme.id} нет набора предметов`)
    for (const id of theme.require ?? []) {
      assert.ok(assets.some((record) => record.id === id),
        `обязательный предмет ${id} темы ${theme.id} не принадлежит ей в реестре`)
    }
  }
})

test('граф темы проходит проверку стадии 1, включая порядок ключей', () => {
  for (const theme of SCENE_THEMES.filter((entry) => entry.kind === 'graph')) {
    for (const seed of ['a', 'b', 'c']) {
      const graph = sceneGraphForTheme(theme, seed)
      const report = validateSceneGraph(graph)
      assert.deepEqual(report.errors, [],
        `${theme.id}/${seed}: ${report.errors.map((issue) => issue.code).join(', ')}`)
    }
  }
})

test('склеп запирает последнюю дверь, а ключ кладёт до неё', () => {
  const graph = sceneGraphForTheme(SCENE_THEMES.find((theme) => theme.id === 'crypt'), 'locked')
  const locked = graph.links.filter((link) => link.kind === 'locked')
  assert.equal(locked.length, 1, 'у склепа обязана быть ровно одна запертая дверь')
  assert.equal(locked[0].keyId, 'goal-key')
  assert.deepEqual(validateSceneGraph(graph).errors, [], 'ключ обязан быть доступен до своей двери')
})

test('каждая тема собирается в валидную связную карту', () => {
  for (const theme of SCENE_THEMES) {
    const built = buildThemedScene({ location: theme.label, seed: `build-${theme.id}`, width: 28, height: 28 })
    assert.equal(built.theme, theme.id)
    assert.deepEqual(validateTacticalMap(built.map).errors, [], `${theme.id}: карта не прошла валидацию`)
    assert.deepEqual(built.warnings, [], `${theme.id}: предупреждения ${built.warnings.join('; ')}`)

    const spawn = built.map.spawnPoints.find((point) => point.role === 'party')
    assert.ok(spawn, `${theme.id}: нет точки появления`)
    const reached = reachableCells(built.map, spawn.x, spawn.y)
    assert.ok(reached.size > 20, `${theme.id}: от точки появления достижимо всего ${reached.size} клеток`)
    assert.ok(built.map.props.length > 5, `${theme.id}: предметов всего ${built.map.props.length}`)
  }
})

test('решётка склепа и бойница храма стоят на карте и не открывают прохода', () => {
  const cases = [['Склеп Норвин', 'crypt', 'grate'], ['Храм Утренней Звезды', 'temple', 'loophole']]
  for (const [location, themeId, kind] of cases) {
    const built = buildThemedScene({ location, seed: `pierce-${themeId}`, width: 28, height: 28 })
    assert.equal(built.theme, themeId)
    const pierced = edgeList(built.map).filter((edge) => edge.kind === kind)
    assert.ok(pierced.length > 0, `${themeId}: проёмов вида ${kind} на карте нет`)

    for (const edge of pierced) {
      // Проём заменяет глухую стену, а не проход: шаг сквозь него по-прежнему
      // невозможен. Обзор и укрытие записаны в карте — в бою движок их пока не
      // спрашивает (`docs/known-limitations.md`).
      assert.equal(edge.blocksMove, true, `${themeId}: ${kind} открыл проход сквозь стену`)
      assert.equal(edge.blocksSight, false, `${themeId}: сквозь ${kind} не видно`)
      assert.notEqual(edge.cover, 'none', `${themeId}: ${kind} перестал давать укрытие`)
    }

    // Достижимость считается по тем же рёбрам, поэтому сцена обязана остаться
    // ровно такой же связной, как до замены.
    const spawn = built.map.spawnPoints.find((point) => point.role === 'party')
    const reached = reachableCells(built.map, spawn.x, spawn.y)
    const solid = buildThemedScene({ location, seed: `pierce-${themeId}`, width: 28, height: 28 }).map
    for (const edge of edgeList(solid).filter((candidate) => candidate.kind === kind)) {
      const neighbor = edgeNeighbor(edge)
      setEdge(solid, edge.x, edge.y, neighbor.x, neighbor.y, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
    }
    assert.equal(reached.size, reachableCells(solid, spawn.x, spawn.y).size,
      `${themeId}: замена стены на ${kind} изменила проходимость`)
  }
})

test('сборка темы детерминирована от seed', () => {
  for (const theme of SCENE_THEMES) {
    const one = JSON.stringify(serializeTacticalMap(buildThemedScene({ location: theme.label, seed: 'same' }).map))
    const two = JSON.stringify(serializeTacticalMap(buildThemedScene({ location: theme.label, seed: 'same' }).map))
    assert.equal(one, two, `${theme.id}: сборка недетерминирована`)
  }
})

test('предметы темы не протекают на карту другой темы', () => {
  const cave = buildThemedScene({ location: 'Пещера у водопада', seed: 'leak' }).map
  const tavernOnly = new Set(['bar_counter', 'table_round', 'bed', 'sarcophagus'])
  for (const prop of cave.props) {
    assert.equal(tavernOnly.has(prop.assetId), false, `${prop.assetId} оказался в пещере`)
  }
  const temple = buildThemedScene({ location: 'Храм Утренней Звезды', seed: 'leak' }).map
  for (const prop of temple.props) {
    assert.equal(prop.assetId === 'stalagmite', false, 'сталагмит оказался в храме')
  }
})

test('у дороги полоса утоптанной земли идёт через всю карту', () => {
  const road = SCENE_THEMES.find((theme) => theme.id === 'road')
  const map = layoutOpenTerrain(road, { seed: 'road', width: 30, height: 20 })
  const columnsWithEarth = new Set()
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.material === 'earth') columnsWithEarth.add(x)
    }
  }
  assert.equal(columnsWithEarth.size, map.width, 'дорога обязана пересекать карту целиком')
})

test('у открытой местности край непроходим, а у дороги открыт по бокам', () => {
  const forest = layoutOpenTerrain(SCENE_THEMES.find((theme) => theme.id === 'forest'), { seed: 'f', width: 20, height: 20 })
  assert.equal(cellAt(forest, 0, 10)?.passable, false, 'у леса опушка обязана быть непроходима')

  const road = layoutOpenTerrain(SCENE_THEMES.find((theme) => theme.id === 'road'), { seed: 'r', width: 20, height: 20 })
  let openSide = 0
  for (let y = 0; y < road.height; y += 1) if (cellAt(road, 0, y)?.passable) openSide += 1
  assert.ok(openSide > 0, 'дорога обязана вести за пределы карты')
})
