import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { createSceneTransition, generateSceneCells, rememberCurrentSceneMap } from '../server/adventure-director.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import { getWorldTemplate } from '../server/world-template-catalog.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { resolveSceneTheme } from '../server/scene-themes.mjs'
import { serializeTacticalMap, tacticalMapFromLegacyCells } from '../server/tactical-map.mjs'
import { isIndoors, weatherForViewer } from '../server/weather.mjs'

const hero = { id: 'hero-generated-map', character: 'Аудитор', name: 'Игрок', role: 'Воин · ур. 1', species: 'Человек', background: 'Странник', maxHp: 12 }
const galleryMap = { layout: 'rooms', scale: 'site', pattern: 'great-hall', material: 'stone', width: 17, height: 11, openness: .38, water: 0, featureCount: 6 }

test('capital does not override a generated indoor gallery, while courtyard and quay remain outdoors', () => {
  assert.equal(resolveSceneTheme({
    location: 'Штормберг', theme: 'военная галерея приморской цитадели', worldKind: 'capital', request: galleryMap,
  }).id, 'authored-palace')
  assert.equal(resolveSceneTheme({
    location: 'Двор замка Ареса', theme: 'двор замка', worldKind: 'capital',
    request: { layout: 'open', pattern: 'natural', material: 'stone' },
  }).id, 'settlement')
  assert.equal(resolveSceneTheme({
    location: 'Пристань Штормберга', theme: 'портовая пристань', worldKind: 'capital',
    request: { layout: 'streets', pattern: 'village', material: 'stone' },
  }).id, 'settlement')
  assert.equal(resolveSceneTheme({
    location: 'Дворец Ареса', theme: 'тронный зал дворца', worldKind: 'capital', request: galleryMap,
  }).id, 'building')
  assert.equal(resolveSceneTheme({
    location: 'Замок Ареса', theme: 'каменная крепость', worldKind: 'fortress',
    request: { layout: 'rooms', pattern: 'keep', material: 'stone' },
  }).id, 'authored-palace')
})

test('generated bootstrap keeps the resolved indoor theme in tactical metadata', async () => {
  const opening = {
    campaignName: 'Галерея без шаблона', partyName: 'Проверяющие',
    worldSummary: 'Столица с военной галереей.', openingNarration: 'Король ждёт героев в военной галерее.',
    scene: { title: 'Приём у короля', location: 'Штормберг', mood: 'Камень и карты', objective: 'Получить поручение', theme: 'военная галерея приморской цитадели', danger: 'низкая', map: galleryMap },
    hook: 'Поручение короля',
    worldMap: {
      name: 'Валедор', regions: [{ id: 'coast', name: 'Берег', biome: 'coast', x: 500, y: 300, radius: 300 }],
      locations: [{ id: 'capital', name: 'Штормберг', kind: 'capital', x: 500, y: 300, regionId: 'coast', known: true, visited: true }],
      routes: [],
    },
    npcs: [{ id: 'king', name: 'Король', role: 'правитель', location: 'Штормберг', summary: 'Правитель', goals: [], beliefs: [] }],
  }
  const state = await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(opening) }]) }).create({
    code: 'GENERATED-GALLERY', name: 'Галерея без шаблона', world: { startingLocation: 'Штормберг' }, players: [hero],
  })
  assert.equal(state.scene.map.theme, 'building')
  assert.equal(isIndoors(state), true)
  assert.equal(weatherForViewer(state).indoors, true)
  assert.deepEqual(weatherForViewer(state).effects, [])
  assert.ok(state.scene.cells.some((cell) => cell.material === 'stone'))
  assert.equal(state.scene.cells.some((cell) => cell.feature === 'market_stall'), false)
})

test('returning to a generated location reuses the cached tactical map and metadata', () => {
  const startCells = generateSceneCells({
    location: 'Штормберг', theme: 'военная галерея приморской цитадели', worldKind: 'capital',
    seed: 'revisit:gallery', locationId: 'capital', map: galleryMap,
  })
  const startMap = tacticalMapFromLegacyCells(startCells, { locationId: 'capital', seed: 'revisit:gallery' })
  startMap.theme = 'building'
  const initial = {
    sessionCode: 'REVISIT-GENERATED', campaign: 'Проверка возврата', worldMap: {
      seed: 'revisit-world', currentLocationId: 'capital',
      regions: [{ id: 'coast', name: 'Берег', biome: 'coast', x: 500, y: 300, radius: 300 }],
      locations: [
        { id: 'capital', name: 'Штормберг', kind: 'capital', x: 500, y: 300, regionId: 'coast', known: true, visited: true },
        { id: 'road', name: 'Южная дорога', kind: 'landmark', x: 700, y: 300, regionId: 'coast', known: true, visited: false },
      ],
      routes: [{ id: 'route', from: 'capital', to: 'road', kind: 'road', distance: 2, danger: 'низкая', discovered: true }],
    },
    scene: { title: 'Приём у короля', location: 'Штормберг', location_id: 'capital', objective: 'Поручение', turn: 1, cells: startCells, map: serializeTacticalMap(startMap) },
    adventure: { chapter: 1, currentHook: 'Поручение', visitedLocations: ['Штормберг'], visitedLocationIds: ['capital'], history: [] },
    locationMaps: {},
  }
  rememberCurrentSceneMap(initial)
  const road = createSceneTransition({
    title: 'Южная дорога', location: 'Южная дорога', location_id: 'road', theme: 'дорога', scene_kind: 'road',
    map: { layout: 'winding', pattern: 'bridge', material: 'earth', width: 17, height: 11 },
  }, initial)
  const away = { ...initial, scene: road.scene, worldMap: road.worldMap, adventure: road.adventure }
  rememberCurrentSceneMap(away)
  const back = createSceneTransition({
    title: 'Приём у короля', location: 'Штормберг', location_id: 'capital', theme: 'военная галерея приморской цитадели',
    map: galleryMap,
  }, away)
  assert.deepEqual(back.scene.cells, startCells)
  assert.equal(back.scene.map.theme, 'building')
})

test('known Astohan lake keeps water and an accessible entrance through the fallback architect path', async () => {
  const template = getWorldTemplate('astohan-plains')
  const state = {
    sessionCode: 'LAKE-AUDIT', campaign: template.name, campaignConcept: template.world,
    worldMap: template.world_map,
    scene: { title: 'Старая охота возвращается', location: 'Штормберг', location_id: 'astohan-stormberg', objective: 'Найти след', turn: 1, cells: [] },
    adventure: { chapter: 1, currentHook: 'След дракона', visitedLocations: ['Штормберг'], history: [] },
  }
  const plan = await new SceneArchitectAgent().plan({
    action: 'Идём к Озеру Двух Отражений', decision: '[РЕШЕНИЕ ГРУППЫ] Идём к Озеру Двух Отражений',
    destinationHint: 'Озеро Двух Отражений', destinationLocationId: 'astohan-mirror-lake', state,
  })
  assert.equal(plan.sceneArgs.location, 'Озеро Двух Отражений')
  assert.ok(Number(plan.sceneArgs.map.water) >= 0.35)

  const transition = createSceneTransition(plan.sceneArgs, state)
  const water = transition.scene.cells.filter((cell) => cell.type === 'water')
  assert.ok(water.length > 0, 'озеро должно иметь водную поверхность')
  assert.ok(['forest', 'road', 'settlement'].includes(transition.scene.map.theme), transition.scene.map.theme)
  assert.ok(['floor', 'door'].includes(transition.scene.cells.find((cell) => cell.x === transition.entrance.x && cell.y === transition.entrance.y)?.type),
    'вход на берегу должен оставаться доступным')
})
