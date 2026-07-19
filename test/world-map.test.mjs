import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaignWorldMap, ensureCampaignWorldMap, reconcileWorldMap } from '../server/world-map.mjs'

test('глобальная карта кампании детерминирована и содержит связную стартовую географию', () => {
  const input = { seed: 'WORLD-42', campaignName: 'Пепельный рубеж', concept: { genre: 'тёмное фэнтези' }, startingLocation: 'Норвин' }
  const first = createCampaignWorldMap(input)
  const second = createCampaignWorldMap(input)
  assert.deepEqual(first, second)
  assert.ok(first.regions.length >= 3)
  assert.ok(first.locations.length >= 8)
  assert.ok(first.routes.length >= first.locations.length - 1)
  const start = first.locations.find((location) => location.name === 'Норвин')
  assert.equal(first.currentLocationId, start.id)
  assert.equal(start.visited, true)
})

test('новая сцена становится канонической точкой карты и соединяется с предыдущей', () => {
  const initial = createCampaignWorldMap({ seed: 'ROUTE-1', campaignName: 'Дороги', startingLocation: 'Старый порт' })
  const updated = reconcileWorldMap(initial, {
    campaignName: 'Дороги', currentLocation: 'Башня у перевала', previousLocation: 'Старый порт',
    knownLocations: ['Старый порт', 'Башня у перевала'], transition: 'Дорога поднимается к перевалу.',
    scene: { objective: 'Зажечь маяк', scene_kind: 'dungeon', danger: 'высокая' },
  })
  const destination = updated.locations.find((location) => location.name === 'Башня у перевала')
  const origin = updated.locations.find((location) => location.name === 'Старый порт')
  assert.equal(updated.currentLocationId, destination.id)
  assert.equal(destination.kind, 'dungeon')
  assert.ok(updated.routes.some((route) => new Set([route.from, route.to]).has(origin.id) && new Set([route.from, route.to]).has(destination.id)))
  assert.ok(updated.routes.length >= updated.locations.length - 1)
})

test('места из хроники старой кампании автоматически появляются на карте', () => {
  const worldMap = ensureCampaignWorldMap({
    sessionCode: 'LEGACY-MAP', campaign: 'Старая хроника', campaignConcept: { worldSummary: 'Мир старых дорог.' },
    scene: { location: 'Серебряный монастырь', objective: 'Найти колокол' },
    adventure: {
      visitedLocations: ['Пепельный брод', 'Серебряный монастырь'],
      history: [{ location: 'Пепельный брод' }, { location: 'Рыночная площадь' }],
    },
  })
  const names = new Set(worldMap.locations.map((location) => location.name))
  assert.ok(names.has('Пепельный брод'))
  assert.ok(names.has('Рыночная площадь'))
  assert.ok(names.has('Серебряный монастырь'))
})
