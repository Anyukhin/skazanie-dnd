import assert from 'node:assert/strict'

import { authoredLocationMapFor } from '../../../../server/authored-location-maps.mjs'
import { generateSceneGeometry } from '../../../../server/adventure-director.mjs'
import { sceneMapRequirementsFor } from '../../../../server/scene-requirements.mjs'
import { cellAt, serializeTacticalMap } from '../../../../server/tactical-map.mjs'

const countZone = (map, zone) => {
  let count = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.zone === zone) count += 1
    }
  }
  return count
}

const propsByAsset = (map, assetId) => map.props.filter((prop) => prop.assetId === assetId).length

// Проверяемый срез e1d927f5aa68dc9eca912b527cccf3974ba3e9e7, 2026-10-04.
// Проба фиксирует поведение среза. После исправления проверки нужно заменить
// на ожидаемое поведение; это не постоянная проверка сборки.

const ruins = generateSceneGeometry({
  location: 'Поляна',
  theme: 'лес',
  description: 'Древние руины разрушенной заставы.',
  seed: 'ruins-16-0',
  map: { width: 16, height: 16 },
  useLibrary: false,
}).map
const ruinsResult = {
  generator: ruins.generator,
  size: [ruins.width, ruins.height],
  requested: true,
  placed: ruins.props.filter((prop) => prop.id.startsWith('ruins-')).length,
}
assert.equal(ruinsResult.placed, 0, 'baseline probe expects the small-map ruin omission')

const descriptionInput = {
  location: 'Поляна',
  theme: 'лесная поляна',
  description: 'Мост через ущелье ведёт к старой дороге.',
  seed: 'bridge-desc-1',
  map: { width: 36, height: 30 },
  useLibrary: false,
}
const bridgeFromDescription = generateSceneGeometry(descriptionInput).map
const campFromDescription = generateSceneGeometry({
  location: 'Поляна',
  theme: 'лесная поляна',
  description: 'Разбитый лагерь разбойников.',
  seed: 'bridge-desc-1',
  map: { width: 36, height: 30 },
  useLibrary: false,
}).map
const bridgeControl = generateSceneGeometry({
  location: 'Мост через ущелье',
  theme: 'дорога',
  seed: 'bridge-desc-1',
  map: { width: 36, height: 30 },
  useLibrary: false,
}).map
const campControl = generateSceneGeometry({
  location: 'Лагерь разбойников',
  theme: 'лес',
  seed: 'bridge-desc-1',
  map: { width: 36, height: 30 },
  useLibrary: false,
}).map
const bridgeWithStructuredPlatform = generateSceneGeometry({
  ...descriptionInput,
  program: { version: 'scene-requirements/v3', items: [{ id: 'platform', count: 1 }] },
}).map
let structuredPlatformWoodCells = 0
for (let y = 0; y < bridgeWithStructuredPlatform.height; y += 1) {
  for (let x = 0; x < bridgeWithStructuredPlatform.width; x += 1) {
    if (cellAt(bridgeWithStructuredPlatform, x, y)?.material === 'wood') structuredPlatformWoodCells += 1
  }
}
const bridgeResult = {
  generator: bridgeFromDescription.generator,
  scene_requirements: sceneMapRequirementsFor([descriptionInput.description]),
  crossing_cells: countZone(bridgeFromDescription, 'crossing'),
  camp_description_tents: propsByAsset(campFromDescription, 'scout_tent'),
  camp_description_bedrolls: propsByAsset(campFromDescription, 'bedroll_cluster'),
  bridge_control_crossing_cells: countZone(bridgeControl, 'crossing'),
  camp_control_tents: propsByAsset(campControl, 'scout_tent'),
  camp_control_bedrolls: propsByAsset(campControl, 'bedroll_cluster'),
  structured_platform_crossing_cells: countZone(bridgeWithStructuredPlatform, 'crossing'),
  structured_platform_wood_cells: structuredPlatformWoodCells,
}
assert.equal(bridgeResult.crossing_cells, 0, 'baseline probe expects description-only bridge to be absent')
assert.equal(bridgeResult.camp_description_tents, 0, 'baseline probe expects description-only camp mode to be absent')
assert.equal(bridgeResult.scene_requirements, null, 'baseline structured requirement catalog has no bridge/camp topology item')
assert.ok(bridgeResult.bridge_control_crossing_cells > 0, 'control location cue must build a crossing')
assert.ok(bridgeResult.camp_control_tents > 0 && bridgeResult.camp_control_bedrolls > 0, 'control location cue must build a camp')
assert.equal(bridgeResult.structured_platform_crossing_cells, 0, 'platform landmark does not repair a missing gorge crossing')
assert.ok(bridgeResult.structured_platform_wood_cells > 0, 'platform landmark is applied as terrain')

const authoredBefore = authoredLocationMapFor('tides-whisper-forest')
assert.ok(authoredBefore, 'authored fixture must exist')
const authoredSnapshot = serializeTacticalMap(authoredBefore)
const authoredAfter = generateSceneGeometry({
  locationId: 'tides-whisper-forest',
  location: 'Лесная поляна',
  theme: 'лес',
  description: 'Остывшее кострище и следы лагеря.',
  seed: 'authored-desc',
  useLibrary: false,
}).map
const authoredReloaded = authoredLocationMapFor('tides-whisper-forest')
assert.ok(authoredReloaded, 'authored fixture must still be loadable')
const authoredResult = {
  generator: authoredAfter.generator,
  vignette_props: authoredAfter.props.filter((prop) => prop.id.startsWith('vignette-')).length,
  campfires: propsByAsset(authoredAfter, 'campfire'),
  source_unchanged: JSON.stringify(serializeTacticalMap(authoredReloaded)) === JSON.stringify(authoredSnapshot),
}
assert.equal(authoredResult.vignette_props, 0, 'baseline probe expects authored maps to skip dressing')
assert.equal(authoredResult.source_unchanged, true, 'authored map source must not be mutated')

console.log(JSON.stringify({ ruins: ruinsResult, description_topology: bridgeResult, authored: authoredResult }, null, 2))
