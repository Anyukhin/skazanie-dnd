import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCENE_THEMES,
  buildThemedScene,
  layoutOpenTerrain,
  sceneGraphForTheme,
  themeFor,
} from '../server/scene-themes.mjs'
import { validateSceneGraph } from '../server/scene-graph.mjs'
import { assetsForTheme } from '../server/asset-registry.mjs'
import { cellAt, reachableCells, serializeTacticalMap, validateTacticalMap } from '../server/tactical-map.mjs'

const THEMES = ['building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement']

test('план требует шесть тем сверх здания — все объявлены', () => {
  assert.deepEqual(SCENE_THEMES.map((theme) => theme.id).sort(), [...THEMES].sort())
  for (const theme of SCENE_THEMES) {
    assert.ok(['building', 'graph', 'open'].includes(theme.kind), `${theme.id}: неизвестный способ сборки`)
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
