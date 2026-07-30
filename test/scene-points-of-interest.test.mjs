import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSceneCells } from '../server/adventure-director.mjs'
import { generateDynamicSceneMap } from '../server/dynamic-map.mjs'
import {
  interactionMetadataForProp,
  sceneInteractionCatalogEntry,
} from '../server/scene-interactions.mjs'
import {
  deserializeTacticalMap,
  serializeTacticalMap,
  tacticalMapFromLegacyCells,
} from '../server/tactical-map.mjs'
import { SCENE_THEMES } from '../server/scene-themes.mjs'

const DICTIONARY_ASSETS = Object.freeze([
  'chest', 'barrel', 'barrel_stack', 'crate', 'crate_stack', 'sarcophagus', 'urn', 'crypt_niche',
  'altar', 'rune', 'statue', 'roadside_shrine',
  'campfire',
  'bookshelf', 'table', 'table_round', 'table_long', 'table_small', 'fallen_log', 'tree_stump', 'boulder', 'rubble_heap', 'milestone',
  'bones', 'bone_pile', 'grave', 'corpse',
])

function generatedMap(seed, options = {}) {
  const cells = generateDynamicSceneMap({
    seed,
    theme: 'древний склеп',
    danger: 'средняя',
    layout: 'cavern',
    pattern: 'crypt',
    material: 'earth',
    featureCount: 8,
    ...options,
  })
  return tacticalMapFromLegacyCells(cells, { seed })
}

test('каждая генерируемая сцена получает 2–4 детерминированные точки интереса', () => {
  for (const seed of ['poi:crypt:one', 'poi:crypt:two', 'poi:crypt:three']) {
    const first = generatedMap(seed)
    const second = generatedMap(seed)
    const points = first.props.filter((prop) => prop.interaction?.pointOfInterest)
    assert.ok(points.length >= 2 && points.length <= 4, `${seed}: получено ${points.length} POI`)
    assert.deepEqual(
      first.props.map((prop) => ({ id: prop.id, interaction: prop.interaction })),
      second.props.map((prop) => ({ id: prop.id, interaction: prop.interaction })),
      `${seed}: метаданные должны повторяться по тому же seed`,
    )
  }
})

test('словарные объекты интерактивны, а metadata назначена только серверным каталогом', () => {
  const cells = DICTIONARY_ASSETS.map((feature, x) => ({
    x,
    y: 0,
    type: 'floor',
    revealed: true,
    material: 'stone',
    variant: 0,
    pattern: 'crypt',
    feature,
  }))
  const map = tacticalMapFromLegacyCells(cells, { seed: 'poi:dictionary' })

  for (const prop of map.props) {
    const catalog = sceneInteractionCatalogEntry(prop.assetId)
    assert.ok(catalog, `${prop.assetId}: объект отсутствует в серверном каталоге`)
    assert.equal(prop.interactive, true, `${prop.assetId}: объект должен быть интерактивным`)
    assert.ok(prop.interaction)
    assert.deepEqual(
      prop.interaction,
      interactionMetadataForProp({
        mapSeed: map.seed,
        prop,
        pointOfInterest: prop.interaction.pointOfInterest,
      }),
      `${prop.assetId}: metadata должна целиком происходить из server-owned таблиц`,
    )
  }
  assert.ok(map.props.filter((prop) => prop.interaction?.pointOfInterest).length <= 4)
})

test('скрытые ключи POI переживают serialize/deserialize без потерь', () => {
  const map = generatedMap('poi:round-trip')
  const before = map.props.filter((prop) => prop.interaction?.pointOfInterest)
  assert.ok(before.every((prop) => prop.interaction.detailKey && prop.interaction.rewardKey))

  const serialized = serializeTacticalMap(map)
  const restored = deserializeTacticalMap(JSON.parse(JSON.stringify(serialized)))
  assert.deepEqual(serializeTacticalMap(restored), serialized)
  assert.deepEqual(
    restored.props.filter((prop) => prop.interaction?.pointOfInterest).map((prop) => prop.interaction),
    before.map((prop) => prop.interaction),
  )
})

test('малый бюджет сохраняет число feature и отдаёт два места существующим словарным объектам', () => {
  const cells = generateDynamicSceneMap({
    seed: 'poi:small-budget',
    theme: 'дорога',
    layout: 'winding',
    pattern: 'bridge',
    material: 'earth',
    featureCount: 3,
  })
  const features = cells.map((cell) => cell.feature).filter(Boolean)
  assert.equal(features.length, 3)
  assert.ok(features.filter((feature) => sceneInteractionCatalogEntry(feature)).length >= 2)
  assert.ok(features.includes('stairs'), 'обязательный выход нельзя вытеснять точками интереса')
})

test('все live-темы получают POI только в свежем output без роста бюджета props', () => {
  for (const theme of SCENE_THEMES.filter((entry) => entry.live)) {
    const seed = `poi:live-theme:${theme.id}`
    const generatedCells = generateSceneCells({
      theme: theme.label,
      location: theme.label,
      seed,
      locationId: `loc-${theme.id}`,
      map: { width: 26, height: 26 },
    })
    const retry = generateSceneCells({
      theme: theme.label,
      location: theme.label,
      seed,
      locationId: `loc-${theme.id}`,
      map: { width: 26, height: 26 },
    })
    assert.deepEqual(generatedCells, retry, `${theme.id}: fresh output должен быть детерминирован`)
    const map = tacticalMapFromLegacyCells(generatedCells, { seed })
    const points = map.props.filter((prop) => prop.interaction?.pointOfInterest)
    assert.ok(points.length >= 2 && points.length <= 4, `${theme.id}: получено ${points.length} POI`)
    if (['crypt', 'cave', 'forest', 'road'].includes(theme.id)) {
      const palette = new Set([...(theme.require ?? []), ...(theme.prefer ?? [])])
      assert.ok(
        points.some((prop) => palette.has(prop.assetId)),
        `${theme.id}: хотя бы одна интерактивная точка должна происходить из тематической палитры`,
      )
    }
    if (theme.id === 'forest') {
      assert.ok(
        new Set(points.map((prop) => prop.assetId)).size >= 2,
        'лес должен получать разные интерактивные объекты из своей палитры',
      )
    }
  }
})
