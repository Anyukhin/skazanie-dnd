import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import {
  CITY_OVERVIEW_IMAGE_PATTERN,
  WORLD_TEMPLATE_IMAGE_PATTERN,
  getWorldTemplate,
  listWorldTemplates,
  worldTemplateConcept,
  worldTemplateOpening,
} from '../server/world-template-catalog.mjs'

test('каталог содержит ровно три заранее написанных мира с bounded preview', () => {
  const previews = listWorldTemplates()
  assert.equal(previews.length, 3)
  assert.equal(new Set(previews.map((entry) => entry.id)).size, 3)
  for (const preview of previews) {
    assert.ok(preview.id)
    assert.match(preview.version, /^\d+\.\d+\.\d+/u)
    assert.ok(preview.name && preview.tagline && preview.description)
    assert.match(preview.image, WORLD_TEMPLATE_IMAGE_PATTERN)
    assert.ok(preview.world.era && preview.world.genre && preview.world.tone && preview.world.startingLocation)
    assert.ok(preview.cities.length >= 5)
    assert.equal(preview.cities.length, preview.cityCount)
    assert.ok(preview.regionCount >= 5)
    assert.ok(preview.locationCount >= 12)
    assert.ok(preview.routeCount >= preview.locationCount - 1)
    assert.ok(preview.historyTeaser.length > 40)
    assert.equal('worldMap' in preview, false, 'preview не должен тащить полную карту')
    assert.equal(preview.cityOverviewCount, 1)
    assert.equal('cityOverview' in preview, false, 'preview не должен тащить городской план')
  }
})

test('публичные previews и полные шаблоны возвращаются deep clone', () => {
  const first = listWorldTemplates()
  const second = listWorldTemplates()
  first[0].world.themes = Array.isArray(first[0].world.themes) ? ['изменено'] : 'изменено'
  first[0].cities[0] = 'изменено'
  assert.notEqual(first[0].world.themes, second[0].world.themes)
  assert.notEqual(first[0].cities[0], second[0].cities[0])

  const template = getWorldTemplate(second[0].id)
  const opening = worldTemplateOpening(template)
  opening.worldMap.locations[0].name = 'изменено'
  opening.worldMap.locations[0].cityOverview.districts[0].name = 'изменено'
  opening.npcs[0].name = 'изменено'
  const again = getWorldTemplate(second[0].id)
  assert.notEqual(opening.worldMap.locations[0].name, again.world_map.locations[0].name)
  assert.notEqual(opening.npcs[0].name, again.opening.npcs[0].name)
  assert.notEqual(opening.worldMap.locations[0].cityOverview.districts[0].name, again.world_map.locations[0].cityOverview.districts[0].name)
})

test('неизвестный шаблон отклоняется с кодом WORLD_TEMPLATE_INVALID', () => {
  assert.throws(
    () => getWorldTemplate('missing-template'),
    (error) => error?.code === 'WORLD_TEMPLATE_INVALID',
  )
})

test('каждая карта имеет связный граф от стартовой точки, валидные поселения и изображения', () => {
  for (const preview of listWorldTemplates()) {
    const template = getWorldTemplate(preview.id)
    const locations = template.world_map.locations
    const byId = new Map(locations.map((location) => [location.id, location]))
    const startId = template.opening.scene.locationId
    const start = byId.get(startId)
    assert.ok(start)
    assert.equal(start.name, template.opening.scene.location)
    assert.equal(start.name, template.world.startingLocation)
    assert.equal(start.visited, true)
    assert.ok(existsSync(new URL(`../public${template.image}`, import.meta.url)))

    const seen = new Set([startId])
    const queue = [startId]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]
      for (const route of template.world_map.routes) {
        const next = route.from === current ? route.to : route.to === current ? route.from : ''
        if (next && !seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    assert.equal(seen.size, locations.length, `${preview.id}: карта должна быть связной`)
  }
})

test('opening и concept содержат богатую авторскую историю и metadata шаблона', () => {
  for (const preview of listWorldTemplates()) {
    const template = getWorldTemplate(preview.id)
    assert.ok(template.histories.length > 0)
    assert.ok(template.storyHooks.length > 0)
    assert.ok(template.timeline.length > 0)
    assert.ok(template.factions.length > 0)
    assert.ok(template.story_arcs.length > 0)
    assert.ok(template.world_map.locations.every((location) => location.history && location.storyHooks.length >= 1))
    assert.equal(template.world_map.backgroundImage, template.image)
    const opening = worldTemplateOpening(template, { campaignName: 'Моя кампания', partyName: 'Мой отряд' })
    assert.equal(opening.campaignName, 'Моя кампания')
    assert.equal(opening.partyName, 'Мой отряд')
    assert.equal(opening.scene.locationId, template.opening.scene.locationId)
    assert.equal(opening.scene.location, template.opening.scene.location)
    assert.equal(opening.worldHistory, template.opening.worldHistory)
    assert.ok(opening.npcs.length >= 1)
    const concept = worldTemplateConcept(template)
    assert.equal(concept.world_template_id, template.id)
    assert.equal(concept.world_template_version, typeof template.version === 'number' ? `${template.version}.0.0` : template.version)
    assert.equal(concept.worldHistory, template.opening.worldHistory)
    assert.deepEqual(concept.timeline, template.timeline)
    assert.deepEqual(concept.factions, template.factions)
    assert.deepEqual(concept.story_arcs, template.story_arcs)

    const defaultNames = worldTemplateOpening(template, { campaignName: 'Новая кампания' })
    assert.equal(defaultNames.campaignName, template.name)
  }
})

test('каждый стартовый город имеет один строгий обзор из шести районов и десяти мест', () => {
  for (const preview of listWorldTemplates()) {
    const template = getWorldTemplate(preview.id)
    const overviewLocations = template.world_map.locations.filter((location) => location.cityOverview)
    assert.equal(overviewLocations.length, 1)
    assert.equal(overviewLocations[0].id, template.opening.scene.locationId)
    const overview = overviewLocations[0].cityOverview
    assert.match(overview.image, CITY_OVERVIEW_IMAGE_PATTERN)
    assert.ok(existsSync(new URL(`../public${overview.image}`, import.meta.url)))
    assert.equal(overview.districts.length, 6)
    assert.equal(overview.places.length, 10)
    assert.equal(new Set(overview.districts.map((district) => district.id)).size, 6)
    assert.equal(new Set(overview.places.map((place) => place.id)).size, 10)
    const districtIds = new Set(overview.districts.map((district) => district.id))
    assert.ok(overview.districts.every((district) => district.history && district.storyHooks.length === 2))
    assert.ok(overview.places.every((place) => districtIds.has(place.districtId) && place.history && place.storyHooks.length === 2))
  }
})
