import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { createSceneTransition, rememberCurrentSceneMap } from '../server/adventure-director.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'
import { buildAuthoredLocationMap, buildAuthoredLocationMaps, revealInitialArea } from '../tools/build-authored-location-maps.mjs'
import {
  authoredLocationMapCount,
  authoredLocationMapIds,
  authoredLocationMapFor,
  normalizeAuthoredLocationMapCatalog,
} from '../server/authored-location-maps.mjs'
import { getWorldTemplate, listWorldTemplates } from '../server/world-template-catalog.mjs'
import { cellAt, edgeBetween, serializeTacticalMap, deserializeTacticalMap, setCell, setDoor, validateTacticalMap } from '../server/tactical-map.mjs'

const hero = (id) => ({
  id,
  character: 'Аудитор',
  name: 'Игрок',
  role: 'Воин · ур. 1',
  species: 'Человек',
  background: 'Странник',
  maxHp: 12,
})

function fixtureMap(locationId = 'fixture-location') {
  const map = buildThemedScene({
    location: 'площадь',
    theme: 'городские улицы',
    themeId: 'settlement',
    locationId,
    seed: `fixture:${locationId}`,
    width: 20,
    height: 20,
  }).map
  map.tilesetId = `authored-location:${locationId}:v1`
  return serializeTacticalMap(map)
}

function fixtureLayout(door) {
  return {
    location_id: 'fixture-builder', width: 4, height: 4, source_width: 40, source_height: 40,
    theme: 'settlement', default_material: 'stone', default_zone: 'yard',
    zones: [{ id: 'yard', kind: 'exterior', material: 'stone', label: 'Двор' }],
    terrain: [{ rect: [0, 0, 40, 40], zone: 'yard', passable: true, material: 'stone', surface: 'none', elevation: 0 }],
    doors: [door],
    props: [{ id: 'painted:table', assetId: 'table_long', rect: [20, 10, 10, 10] }],
    spawns: [{ id: 'party-entrance', role: 'party', point: [5, 20] }],
    checks: [{ name: 'exit', point: [35, 20] }],
  }
}

test('catalog accepts a valid serialized map and returns an isolated copy', () => {
  const raw = fixtureMap()
  const catalog = normalizeAuthoredLocationMapCatalog({ schema_version: 1, maps: [raw] })
  assert.equal(catalog.size, 1)
  const first = deserializeTacticalMap(catalog.get('fixture-location'))
  const second = deserializeTacticalMap(catalog.get('fixture-location'))
  assert.deepEqual(serializeTacticalMap(first), serializeTacticalMap(second))
  first.props.length = 0
  assert.notEqual(first.props.length, second.props.length)
  assert.equal(validateTacticalMap(second).ok, true)
})

test('catalog rejects fake IDs, marker mismatches and broken geometry', () => {
  const valid = fixtureMap()
  assert.throws(
    () => normalizeAuthoredLocationMapCatalog({ schema_version: 1, maps: [{ location_id: 'fixture-location', map: { ...valid, locationId: 'other-location' } }] }),
    /locationId не совпадает/u,
  )
  assert.throws(
    () => normalizeAuthoredLocationMapCatalog({ schema_version: 1, maps: [{ ...valid, tilesetId: 'authored-location:other-location:v1' }] }),
    /authored tilesetId/u,
  )
  assert.throws(
    () => normalizeAuthoredLocationMapCatalog({ schema_version: 1, maps: [{ ...valid, locationId: '../fake' }] }),
    /неверный идентификатор/u,
  )
})

test('pixel door must map to adjacent passable cells and never moves silently', () => {
  const valid = buildAuthoredLocationMap(fixtureLayout({ id: 'fixture-door', from: [10, 20], to: [20, 20], state: 'open' }))
  assert.equal(valid.doors.length, 1)
  assert.equal(valid.doors[0].state, 'open')
  assert.throws(
    () => buildAuthoredLocationMap(fixtureLayout({ id: 'too-wide', from: [10, 20], to: [30, 20], state: 'open' })),
    /too-wide.*соседние клетки/u,
  )
})

test('стартовое раскрытие останавливается у закрытой двери и оставляет pure builder обратно совместимым', () => {
  const layout = fixtureLayout({ id: 'fixture-closed-door', from: [10, 25], to: [20, 25], state: 'closed' })
  layout.location_id = 'fixture-closed-door'
  layout.terrain = [
    { rect: [0, 0, 40, 40], present: false },
    { rect: [0, 20, 40, 10], present: true, zone: 'yard', passable: true, material: 'stone', surface: 'none', elevation: 0 },
  ]
  layout.spawns = [{ id: 'party-entrance', role: 'party', point: [5, 25] }]
  layout.checks = [{ name: 'exit', point: [35, 25] }]
  layout.props = []
  const map = buildAuthoredLocationMap(layout)
  assert.equal(cellAt(map, 0, 2)?.revealed, true)
  assert.equal(cellAt(map, 1, 2)?.revealed, true)
  assert.equal(cellAt(map, 2, 2)?.revealed, false, 'закрытая дверь не должна раскрывать дальнюю сторону')
  assert.equal(cellAt(map, 3, 2)?.revealed, false)

  const openMap = buildAuthoredLocationMap({ ...layout, location_id: 'fixture-reveal-direct', doors: [{ ...layout.doors[0], state: 'open' }] })
  for (let y = 0; y < openMap.height; y += 1) for (let x = 0; x < openMap.width; x += 1) if (cellAt(openMap, x, y)) setCell(openMap, x, y, { revealed: false })
  revealInitialArea(openMap, { x: 0, y: 2 }, 1)
  assert.equal(cellAt(openMap, 0, 2)?.revealed, true)
  assert.equal(cellAt(openMap, 1, 2)?.revealed, true)
  assert.equal(cellAt(openMap, 2, 2)?.revealed, false, 'раскрытие должно соблюдать заданный радиус')
})

test('well и stairs без verbs не получают пустое interactive-меню, переход сохраняет интерактивность', () => {
  const layout = fixtureLayout({ id: 'fixture-prop-interaction', from: [10, 20], to: [20, 20], state: 'open' })
  layout.props = [
    { id: 'well', assetId: 'well', point: [5, 20], interactive: true },
    { id: 'stairs', assetId: 'stairs_down', point: [15, 20], interactive: true },
    { id: 'stairs-transition', assetId: 'stairs_up', point: [25, 20], transition: { toLevel: 1, label: 'Верхняя галерея' } },
    { id: 'chest', assetId: 'chest', point: [35, 20], interactive: true },
  ]
  const map = buildAuthoredLocationMap(layout)
  assert.equal(map.props.find((prop) => prop.id === 'well')?.interactive, false)
  assert.equal(map.props.find((prop) => prop.id === 'stairs')?.interactive, false)
  assert.equal(map.props.find((prop) => prop.id === 'stairs-transition')?.interactive, true)
  assert.equal(map.props.find((prop) => prop.id === 'chest')?.interactive, true)
})

test('основной catalog нельзя перезаписать legacy bigpixel layout без явного другого out', () => {
  const temp = mkdtempSync(join(process.cwd(), 'tmp-authored-builder-test-'))
  try {
    const layoutPath = join(temp, 'legacy.json')
    const legacyLayout = fixtureLayout({ id: 'fixture-legacy', from: [10, 20], to: [20, 20], state: 'open' })
    legacyLayout.location_id = 'fixture-legacy'
    writeFileSync(layoutPath, JSON.stringify({ schema_version: 1, layouts: [legacyLayout] }))
    const mainPath = resolve(process.cwd(), 'data/authored-location-maps-v1.json')
    const before = readFileSync(mainPath, 'utf8')
    assert.throws(
      () => buildAuthoredLocationMaps({ layoutPaths: [layoutPath], outputPath: mainPath, exportDir: join(temp, 'main-export') }),
      /native_grid=true/u,
    )
    assert.equal(readFileSync(mainPath, 'utf8'), before)

    const legacyOutput = join(temp, 'legacy-catalog.json')
    const result = buildAuthoredLocationMaps({ layoutPaths: [layoutPath], outputPath: legacyOutput, exportDir: join(temp, 'legacy-export') })
    assert.equal(result.maps.length, 1)
    assert.match(result.maps[0].tilesetId, /^authored-location:fixture-legacy:v1$/u)
    assert.equal(existsSync(join(temp, 'legacy-export', 'fixture-legacy.json')), true)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Ares pixel layout produces the wide royal map and keeps the council table in gallery', (t) => {
  const path = new URL('../data/authored-location-layouts-ares-v1.json', import.meta.url)
  if (!existsSync(path)) {
    t.skip('Ares layout ещё не опубликован')
    return
  }
  const source = JSON.parse(readFileSync(path, 'utf8'))
  const map = buildAuthoredLocationMap(source.layouts[0])
  assert.deepEqual([map.width, map.height], [96, 64])
  assert.ok(map.props.every((prop) => prop.id.startsWith('painted:')))
  const table = map.props.find((prop) => prop.id === 'painted:war-table')
  assert.ok(table)
  assert.equal(table.assetId, 'table_long')
  assert.equal(cellAt(map, Math.floor(table.x), Math.floor(table.y))?.zone, 'gallery')
  assert.ok(map.spawnPoints.some((point) => point.role === 'party'))
  assert.equal(validateTacticalMap(map).ok, true)
})

test('native Ares map keeps four blocking boundaries, canonical props and doors', () => {
  const path = new URL('../data/authored-tactical-ares-v1.json', import.meta.url)
  assert.equal(existsSync(path), true, 'native Ares layout должен быть опубликован')
  const source = JSON.parse(readFileSync(path, 'utf8'))
  const map = buildAuthoredLocationMap(source.layouts[0])
  assert.deepEqual([map.width, map.height], [24, 18])
  assert.equal(map.seed, 'authored-tactical:astohan-stormberg:v1')
  assert.equal(map.tilesetId, 'authored-tactical:astohan-stormberg:v1')
  assert.equal(map.generator.id, 'authored-tactical-scene')

  const sides = {
    north: Array.from({ length: map.width }, (_, x) => [x, 0]),
    south: Array.from({ length: map.width }, (_, x) => [x, map.height - 1]),
    west: Array.from({ length: map.height }, (_, y) => [0, y]),
    east: Array.from({ length: map.height }, (_, y) => [map.width - 1, y]),
  }
  for (const [side, cells] of Object.entries(sides)) {
    assert.ok(cells.every(([x, y]) => cellAt(map, x, y)?.passable !== true), `${side}: native map boundary must block leaving the scene`)
  }

  const table = map.props.find((prop) => prop.id === 'war-table')
  assert.ok(table)
  assert.equal(table.assetId, 'table_royal')
  assert.deepEqual(
    table.footprint.map(({ x, y }) => `${x},${y}`),
    ['11,6', '12,6', '11,7', '12,7', '11,8', '12,8', '11,9', '12,9', '11,10', '12,10'],
  )
  assert.ok(table.footprint.every(({ x, y }) => cellAt(map, x, y)?.passable === true), 'table footprint must sit on floor cells')
  for (const [id, assetId] of [['throne', 'royal_throne'], ['council-table', 'table_round'], ['archive-desk', 'table_small']]) {
    const prop = map.props.find((candidate) => candidate.id === id)
    assert.equal(prop?.assetId, assetId, id)
    assert.ok(prop?.footprint.length, `${id}: footprint is required`)
  }

  assert.deepEqual(
    map.doors.map((door) => door.id).sort(),
    ['ares-east-archive', 'ares-gallery-entrance-east', 'ares-gallery-entrance-west', 'ares-west-study'],
  )
  for (const door of map.doors) {
    const neighbor = door.dir === 'e' ? { x: door.x + 1, y: door.y } : { x: door.x, y: door.y + 1 }
    assert.equal(cellAt(map, door.x, door.y)?.passable, true, `${door.id}: first side must be floor`)
    assert.equal(cellAt(map, neighbor.x, neighbor.y)?.passable, true, `${door.id}: second side must be floor`)
    assert.equal(edgeBetween(map, door.x, door.y, neighbor.x, neighbor.y)?.doorId, door.id, `${door.id}: door and edge must agree`)
  }
  assert.ok(map.spawnPoints.some((point) => point.role === 'party'))
  assert.equal(validateTacticalMap(map).ok, true)
})

test('catalog contains exactly 56 native-grid maps and every published map validates', () => {
  const ids = authoredLocationMapIds()
  const expectedIds = listWorldTemplates().flatMap((preview) => getWorldTemplate(preview.id).world_map.locations.map((location) => location.id))
  assert.equal(new Set(expectedIds).size, 56, 'в авторских мирах должно быть ровно 56 локаций')
  assert.equal(ids.length, 56, `catalog должен содержать ровно 56 карт, получено ${ids.length}`)
  assert.deepEqual([...ids].sort(), [...expectedIds].sort(), 'catalog должен покрывать ровно все локации авторских миров')
  assert.equal(authoredLocationMapCount(), 56)
  for (const id of ids) {
    const map = authoredLocationMapFor(id)
    assert.ok(map)
    assert.equal(map.locationId, id)
    assert.equal(map.seed, `authored-tactical:${id}:v1`)
    assert.match(map.tilesetId, new RegExp(`^authored-tactical:${id}:v1$`, 'u'))
    assert.equal(map.generator.id, 'authored-tactical-scene')
    assert.ok(map.width <= 30 && map.height <= 24, `${id}: native map exceeds 30×24`)
    assert.equal(validateTacticalMap(map).ok, true)
    assert.ok(map.spawnPoints.some((point) => point.role === 'party'))
    assert.ok(map.props.length > 0)
  }
})

test('known authored location uses the same map in no-LLM campaigns and unknown IDs keep legacy generation', async () => {
  const template = getWorldTemplate('astohan-plains')
  const make = (code) => new CampaignBootstrapper().create({ code, worldTemplateId: template.id, players: [hero(`hero-${code}`)] })
  const first = await make('AUTHORED-MAP-A')
  const second = await make('AUTHORED-MAP-B')
  assert.deepEqual(first.scene.map, second.scene.map)

  const fake = createSceneTransition({
    title: 'Случайная поляна',
    location: 'Случайная поляна',
    location_id: 'fake-location-id',
    theme: 'лесная окраина',
    scene_kind: 'wilderness',
    map: { layout: 'open', pattern: 'natural', material: 'grass', width: 15, height: 15 },
  }, first)
  assert.doesNotMatch(fake.scene.map.tilesetId, /^authored-location:/u)
  assert.equal(fake.scene.map.locationId, fake.scene.location_id)
})

test('authored destination is resolved before the LLM call', async () => {
  assert.ok(authoredLocationMapFor('astohan-stormberg'), 'Ares native map должен быть опубликован')
  const template = getWorldTemplate('astohan-plains')
  const campaign = await new CampaignBootstrapper().create({
    code: 'AUTHORED-MAP-LLM',
    worldTemplateId: template.id,
    players: [hero('hero-authored-llm')],
  })
  const ashWatch = template.world_map.locations.find((location) => location.id === 'astohan-ash-watch')
  assert.ok(ashWatch)
  const state = {
    ...campaign,
    worldMap: { ...campaign.worldMap, currentLocationId: ashWatch.id },
    scene: { ...campaign.scene, location: ashWatch.name, location_id: ashWatch.id },
  }
  let calls = 0
  const architect = new SceneArchitectAgent({
    llmClient: { async completeJson() { calls += 1; return {} } },
  })
  const planned = await architect.plan({
    action: '[ГЛОБАЛЬНАЯ КАРТА] Идём в Штормберг',
    state,
    decision: 'Идём в Штормберг',
    destinationHint: 'Штормберг',
    destinationLocationId: 'astohan-stormberg',
  })
  assert.equal(calls, 0)
  assert.equal(planned.trace.mode, 'authored-catalog')
  assert.equal(planned.sceneArgs.location_id, 'astohan-stormberg')
  assert.equal(planned.sceneArgs.map.theme_id, 'building')
})

test('every published authored destination bypasses the LLM', async () => {
  const ids = authoredLocationMapIds()
  assert.equal(ids.length, 56, 'authored catalog должен быть полным до проверки маршрутов')
  for (const templatePreview of listWorldTemplates()) {
    const template = getWorldTemplate(templatePreview.id)
    const start = template.world_map.locations.find((location) => location.id === template.opening.scene.locationId)
    if (!start) continue
    for (const id of ids.filter((locationId) => template.world_map.locations.some((location) => location.id === locationId))) {
      const target = template.world_map.locations.find((location) => location.id === id)
      assert.ok(target)
      let calls = 0
      const architect = new SceneArchitectAgent({ llmClient: { async completeJson() { calls += 1; return {} } } })
      const planned = await architect.plan({
        action: `[ГЛОБАЛЬНАЯ КАРТА] Идём в «${target.name}»`,
        destinationHint: target.name,
        destinationLocationId: target.id,
        decision: `Идём в «${target.name}»`,
        state: {
          // Для скрытых authored-точек это сценарий после раскрытия узла:
          // проверяем все 56 карт, не разрешая Архитектору телепортировать
          // партию к месту, которое карта мира ещё скрывает.
          worldMap: {
            ...template.world_map,
            currentLocationId: start.id,
            locations: template.world_map.locations.map((location) => ({ ...location, known: true })),
          },
          scene: { location: start.name, location_id: start.id, title: start.name, objective: 'Путь' },
          adventure: { chapter: 1, visitedLocations: [start.name], history: [], currentHook: 'Путь' },
        },
      })
      assert.equal(calls, 0, `${template.id}/${id}: fixed destination не должен вызывать LLM`)
      assert.equal(planned.trace.mode, 'authored-catalog')
    }
  }
})

test('переход к Грунвику идёт через Солёные Ворота без вызова LLM', async () => {
  const template = getWorldTemplate('league-nine-tides')
  const state = await new CampaignBootstrapper().create({
    code: 'AUTHORED-GRUNVIK-ROUTE',
    worldTemplateId: template.id,
    players: [hero('hero-grunvik')],
  })
  let calls = 0
  const architect = new SceneArchitectAgent({ llmClient: { async completeJson() { calls += 1; return {} } } })
  const plannedSaltGates = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в Грунвик',
    decision: 'Идём в Грунвик',
    destinationHint: 'Грунвик',
    destinationLocationId: 'tides-grunvik',
    state,
  })
  assert.equal(calls, 0)
  assert.equal(plannedSaltGates.trace.mode, 'authored-catalog')
  assert.equal(plannedSaltGates.sceneArgs.location_id, 'tides-salt-gates')
  const saltGatesTransition = createSceneTransition(plannedSaltGates.sceneArgs, state)
  assert.equal(saltGatesTransition.scene.location_id, 'tides-salt-gates')

  const atSaltGates = { ...state, ...saltGatesTransition }
  const plannedGrunvik = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Продолжаем в Грунвик',
    decision: 'Продолжаем в Грунвик',
    destinationHint: 'Грунвик',
    destinationLocationId: 'tides-grunvik',
    state: atSaltGates,
  })
  assert.equal(calls, 0)
  assert.equal(plannedGrunvik.trace.mode, 'authored-catalog')
  assert.equal(plannedGrunvik.sceneArgs.location_id, 'tides-grunvik')
  const grunvikTransition = createSceneTransition(plannedGrunvik.sceneArgs, atSaltGates)
  assert.equal(grunvikTransition.scene.location_id, 'tides-grunvik')
  assert.equal(grunvikTransition.scene.map.tilesetId, 'authored-tactical:tides-grunvik:v1')
})

test('published map survives a real same-world transition and revisit with canonical location ID', async () => {
  const template = listWorldTemplates().find((entry) => entry.id === 'astohan-plains')
  assert.ok(template)
  const state = await new CampaignBootstrapper().create({
    code: 'AUTHORED-MAP-REVISIT',
    worldTemplateId: template.id,
    players: [hero('hero-revisit')],
  })
  const targetId = 'astohan-ash-watch'
  assert.ok(authoredLocationMapFor(targetId), 'revisit должен использовать authored map того же мира')
  const target = getWorldTemplate(template.id).world_map.locations.find((location) => location.id === targetId)
  assert.ok(target)
  const arrival = createSceneTransition({
    title: `Переход · ${target.name}`,
    location: target.name,
    location_id: target.id,
    theme: 'известное место',
    map: {},
  }, state)
  const atTarget = { ...state, ...arrival }
  const changedMap = deserializeTacticalMap(atTarget.scene.map)
  const changedDoor = changedMap.doors.find((door) => door.state === 'closed') ?? changedMap.doors[0]
  assert.ok(changedDoor, 'target map must contain a door to mutate')
  setDoor(changedMap, { ...changedDoor, state: changedDoor.state === 'open' ? 'closed' : 'open' })
  const changedProp = changedMap.props.find((prop) => prop.interactive || prop.destructible)
  assert.ok(changedProp, 'target map must contain a prop to mutate')
  changedProp.state = 'broken'
  atTarget.scene = { ...atTarget.scene, map: serializeTacticalMap(changedMap) }
  rememberCurrentSceneMap(atTarget)

  const away = createSceneTransition({
    title: 'Возвращение в Штормберг', location: 'Штормберг', location_id: 'astohan-stormberg', theme: 'известное место', map: {},
  }, atTarget)
  const awayState = { ...atTarget, ...away }
  const returned = createSceneTransition({
    title: `Повторный вход · ${target.name}`,
    location: 'Подменённая подпись не должна менять ID',
    location_id: target.id,
    theme: 'совсем другая геометрия',
    map: { layout: 'open', width: 25, height: 19 },
  }, awayState)
  const returnedMap = deserializeTacticalMap(returned.scene.map)
  assert.equal(returned.scene.location_id, target.id)
  assert.equal(returnedMap.tilesetId, `authored-tactical:${target.id}:v1`)
  assert.equal(returnedMap.doors.find((door) => door.id === changedDoor.id)?.state, changedMap.doors.find((door) => door.id === changedDoor.id)?.state)
  assert.equal(returnedMap.props.find((prop) => prop.id === changedProp.id)?.state, 'broken')
  assert.deepEqual(returnedMap.props.find((prop) => prop.id === changedProp.id)?.footprint, changedProp.footprint)
})
