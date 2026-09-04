import assert from 'node:assert/strict'
import test from 'node:test'

import { publicWorldMapFor } from '../server/viewer-projection.mjs'
import {
  createCampaignWorldMap,
  ensureCampaignWorldMap,
  normalizeCityOverview,
  reconcileWorldMap,
  safeCityOverviewImageUrl,
  safeWorldMapBackgroundUrl,
} from '../server/world-map.mjs'

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

test('стартовая сцена добавляется на авторскую карту вместо подмены первой точкой', () => {
  const map = createCampaignWorldMap({
    seed: 'MISMATCH-1',
    campaignName: 'Несогласованный мир',
    startingLocation: 'Несуществующий старт',
    source: {
      locations: [
        { id: 'foreign-fort', name: 'Чужой форт', kind: 'fortress', known: true },
        { id: 'foreign-port', name: 'Чужой порт', kind: 'port', known: true },
      ],
    },
  })
  const current = map.locations.find((location) => location.id === map.currentLocationId)
  assert.equal(current?.name, 'Несуществующий старт')
  assert.equal(current?.kind, 'landmark', 'вид отсутствующей точки нельзя выдумывать из первой записи карты')
  assert.equal(current?.visited, true)
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

test('повторный визит обновляет summary канонической локации', () => {
  const initial = createCampaignWorldMap({ seed: 'SUMMARY-1', campaignName: 'Хроника', startingLocation: 'Норвин' })
  const locationId = initial.currentLocationId
  const updated = reconcileWorldMap(initial, {
    seed: initial.seed,
    campaignName: 'Хроника',
    currentLocationId: locationId,
    currentLocation: 'Норвин',
    scene: { objective: 'После пожара площадь стала непроходимой.' },
  })
  assert.equal(updated.locations.find((location) => location.id === locationId)?.summary, 'После пожара площадь стала непроходимой.')
})

test('авторский фон и lore точек сохраняются при создании и reconcile', () => {
  const source = {
    name: 'Море стекла',
    backgroundImage: '/assets/maps/world/skazanie/sea-of-glass-v2.webp',
    backgroundAlt: 'Побережье, пустыня и горные проходы Мира стекла',
    regions: [
      { id: 'coast', name: 'Янтарный берег', biome: 'coast', x: 200, y: 180, radius: 180 },
      { id: 'desert', name: 'Море стекла', biome: 'desert', x: 500, y: 320, radius: 220 },
      { id: 'mountains', name: 'Горный венец', biome: 'mountains', x: 800, y: 480, radius: 180 },
    ],
    locations: [{
      id: 'city-lumen', name: 'Люмен', kind: 'city', region: 'Море стекла', x: 500, y: 320,
      summary: 'Город на месте древней обсерватории.', known: true, visited: true,
      history: 'Люмен вырос вокруг обломка небесного маяка и пережил три осады.',
      storyHooks: ['Пропавший астроном оставил карту под старой башней.', 'Городская вода мутнеет каждое новолуние.'],
    }],
  }
  const created = createCampaignWorldMap({
    seed: 'WORLD-LORE-1', campaignName: 'Стеклянный путь', startingLocation: 'Люмен', source,
  })
  assert.equal(created.backgroundImage, source.backgroundImage)
  assert.equal(created.backgroundAlt, source.backgroundAlt)
  assert.deepEqual(created.locations.find((location) => location.id === 'city-lumen')?.storyHooks, source.locations[0].storyHooks)
  assert.equal(created.locations.find((location) => location.id === 'city-lumen')?.history, source.locations[0].history)

  const reconciled = reconcileWorldMap(created, {
    seed: created.seed, campaignName: 'Стеклянный путь', currentLocation: 'Люмен', currentLocationId: 'city-lumen',
    scene: { objective: 'Вернуться к обсерватории.' },
  })
  assert.equal(reconciled.backgroundImage, source.backgroundImage)
  assert.equal(reconciled.backgroundAlt, source.backgroundAlt)
  assert.equal(reconciled.locations.find((location) => location.id === 'city-lumen')?.history, source.locations[0].history)
  assert.deepEqual(reconciled.locations.find((location) => location.id === 'city-lumen')?.storyHooks, source.locations[0].storyHooks)
})

test('фон карты принимает только versioned внутренний WebP URL', () => {
  const valid = [
    '/assets/maps/world/skazanie/ashen-coast-v1.webp',
    '/assets/maps/world/skazanie/map-42-v12.webp',
  ]
  const invalid = [
    'https://example.test/assets/maps/world/skazanie/ashen-coast-v1.webp',
    '//cdn.example.test/map-v1.webp',
    '/assets/maps/world/skazanie/ashen-coast.webp',
    '/assets/maps/world/skazanie/ashen-coast-v1.png',
    '/assets/maps/world/skazanie/../secret-v1.webp',
    '/assets/maps/world/skazanie/Ashen-coast-v1.webp?cache=1',
    '/assets/maps/world/skazanie/ashen_coast-v1.webp',
    '/assets/maps/world/skazanie/ashen-coast-v0.webp',
  ]
  for (const candidate of valid) assert.equal(safeWorldMapBackgroundUrl(candidate), candidate)
  for (const candidate of invalid) assert.equal(safeWorldMapBackgroundUrl(candidate), '', candidate)

  const map = createCampaignWorldMap({
    seed: 'WORLD-UNSAFE-BACKGROUND', campaignName: 'Безопасная карта', startingLocation: 'Старт',
    source: { backgroundImage: invalid[0], backgroundAlt: 'Не должен пройти' },
  })
  assert.equal(Object.hasOwn(map, 'backgroundImage'), false)
  assert.equal(Object.hasOwn(map, 'backgroundAlt'), false)
})

test('lore ограничивается на входе и не пропускает нестроковые hooks', () => {
  const longHistory = 'история '.repeat(300)
  const sourceHooks = ['первая', 42, { text: 'нет' }, 'вторая', 'третья', 'лишняя']
  const map = createCampaignWorldMap({
    seed: 'WORLD-LORE-BOUNDS', campaignName: 'Границы', startingLocation: 'Город',
    source: {
      locations: [{
        id: 'city', name: 'Город', kind: 'city', x: 500, y: 320, history: longHistory,
        storyHooks: sourceHooks, known: true, visited: true,
      }],
    },
  })
  const location = map.locations.find((entry) => entry.id === 'city')
  assert.equal(location.history.length, 1_200)
  assert.deepEqual(location.storyHooks, ['первая', 'вторая', 'третья'])
})

test('publicWorldMapFor сохраняет lore и отбрасывает unsafe background', () => {
  const location = {
    id: 'city', name: 'Город', kind: 'city', x: 500, y: 320, regionId: 'region',
    summary: 'Старый город', known: true, visited: true,
    history: 'История города', storyHooks: ['Тайна колодца', 'Долг купца'],
  }
  const projected = publicWorldMapFor({
    backgroundImage: '/assets/maps/world/skazanie/ashen-coast-v1.webp', backgroundAlt: 'Безопасный фон',
    regions: [{ id: 'region', name: 'Регион', biome: 'coast', x: 500, y: 320, radius: 180 }],
    locations: [location], routes: [], currentLocationId: 'city',
  })
  assert.equal(projected.backgroundImage, '/assets/maps/world/skazanie/ashen-coast-v1.webp')
  assert.equal(projected.backgroundAlt, 'Безопасный фон')
  assert.equal(projected.locations[0].history, location.history)
  assert.deepEqual(projected.locations[0].storyHooks, location.storyHooks)

  const unsafe = publicWorldMapFor({
    backgroundImage: 'https://example.test/world.webp', backgroundAlt: 'Внешний источник',
    regions: [{ id: 'region', name: 'Регион', biome: 'coast', x: 500, y: 320, radius: 180 }],
    locations: [location], routes: [], currentLocationId: 'city',
  })
  assert.equal(Object.hasOwn(unsafe, 'backgroundImage'), false)
  assert.equal(Object.hasOwn(unsafe, 'backgroundAlt'), false)
})

test('городской обзор сохраняется через create/reconcile/projection и остаётся только презентацией', () => {
  const cityOverview = {
    version: 1,
    name: 'План города',
    summary: 'Шесть кварталов вокруг старой площади.',
    image: '/assets/maps/city/skazanie/test-city-v1.webp',
    imageAlt: 'Город сверху',
    width: 1000,
    height: 640,
    districts: [{
      id: 'old-quarter', name: 'Старый квартал', x: 300, y: 220,
      bounds: { x: 100, y: 80, width: 350, height: 260 },
      summary: 'Каменные дома.', history: 'Первый район города.', storyHooks: ['Пропал ключ.', 'Звонит колокол.'],
      secret: 'не проецировать',
    }],
    places: [{
      id: 'old-tower', name: 'Старая башня', kind: 'tower', districtId: 'old-quarter', x: 260, y: 180,
      summary: 'Башня над площадью.', history: 'Стоит три века.', storyHooks: ['Погас огонь.', 'Открылась дверь.'],
      destinationLocationId: 'forged', danger: 'высокая',
    }],
    routes: [{ from: 'old-quarter', to: 'old-tower' }],
    currentLocationId: 'old-tower',
  }
  const map = createCampaignWorldMap({
    seed: 'CITY-OVERVIEW', campaignName: 'Город', startingLocation: 'Столица',
    source: { locations: [{ id: 'capital', name: 'Столица', kind: 'capital', x: 500, y: 320, known: true, visited: true, cityOverview }] },
  })
  const overview = map.locations.find((location) => location.id === 'capital')?.cityOverview
  assert.equal(overview.image, cityOverview.image)
  assert.equal(overview.districts[0].name, 'Старый квартал')
  assert.equal(Object.hasOwn(overview.districts[0], 'secret'), false)
  assert.equal(Object.hasOwn(overview.places[0], 'destinationLocationId'), false)
  assert.equal(Object.hasOwn(overview, 'routes'), false)
  assert.equal(Object.hasOwn(overview, 'currentLocationId'), false)

  const reconciled = reconcileWorldMap(map, { campaignName: 'Город', currentLocation: 'Столица', currentLocationId: 'capital' })
  assert.deepEqual(reconciled.locations.find((location) => location.id === 'capital')?.cityOverview, overview)
  const projected = publicWorldMapFor(reconciled)
  assert.deepEqual(projected.locations.find((location) => location.id === 'capital')?.cityOverview, overview)
})

test('городской обзор принимает только versioned внутренний WebP и валидные ссылки районов', () => {
  assert.equal(safeCityOverviewImageUrl('/assets/maps/city/skazanie/veld-burg-v1.webp'), '/assets/maps/city/skazanie/veld-burg-v1.webp')
  for (const unsafe of ['https://example.test/city.webp', '/assets/maps/city/skazanie/city.png', '/assets/maps/city/skazanie/../city-v1.webp']) {
    assert.equal(safeCityOverviewImageUrl(unsafe), '')
  }
  assert.equal(normalizeCityOverview({
    name: 'Подмена', summary: 'Подмена', image: 'https://example.test/city.webp', width: 1000, height: 640,
    districts: [], places: [],
  }), null)
  assert.equal(normalizeCityOverview({
    name: 'Город', summary: 'Город', image: '/assets/maps/city/skazanie/city-v1.webp', width: 1000, height: 640,
    districts: [{ id: 'district', name: 'Район', x: 100, y: 100, bounds: { x: 20, y: 20, width: 200, height: 200 } }],
    places: [{ id: 'place', name: 'Место', districtId: 'missing', x: 100, y: 100 }],
  }), null)
})
