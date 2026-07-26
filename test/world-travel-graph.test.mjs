import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { planServerTravel } from '../server/campaign-loop-policy.mjs'

const region = (id, biome) => ({ id, name: `Регион ${id}`, biome, x: 500, y: 320, radius: 205 })

const place = (id, name, regionId, x = 500, y = 320) => ({
  id, name, kind: 'landmark', x, y, regionId, summary: '', known: true, visited: false,
})

const road = (id, from, to, overrides = {}) => ({
  id, from, to, kind: 'road', distance: 3, danger: 'низкая', discovered: true, ...overrides,
})

const worldMap = ({ regions, locations, routes, currentLocationId = 'loc-start' }) => ({
  version: 1,
  seed: 'GRAPH-1',
  name: 'Карта мира «Проверка»',
  width: 1000,
  height: 640,
  currentLocationId,
  regions,
  locations,
  routes,
})

/** Отряд стоит в «Тихой заставе»; напряжение нулевое, чтобы риск читался явно. */
const travelState = (map, extra = {}) => ({
  sessionCode: 'GRAPH-1',
  scene: { location: 'Тихая застава', scene_kind: 'settlement' },
  adventure: { chapter: 2 },
  worldMap: map,
  ...extra,
})

/** Две локации на равнине, соединённые дорогой заданной длины. */
const plainsPair = (distance, overrides = {}) => worldMap({
  regions: [region('reg-plains', 'plains')],
  locations: [
    place('loc-start', 'Тихая застава', 'reg-plains', 200, 300),
    place('loc-target', 'Дальний рубеж', 'reg-plains', 600, 300),
  ],
  routes: [road('route-main', 'loc-start', 'loc-target', { distance, ...overrides })],
})

const options = { campaignId: 'GRAPH-1', destination: 'Дальний рубеж', idempotencyKey: 'travel-1' }

test('расстояние берётся из маршрута графа, а не из названия локации', () => {
  const far = planServerTravel(travelState(plainsPair(7)), options)
  const near = planServerTravel(travelState(plainsPair(1)), options)

  assert.equal(far.source, 'graph')
  assert.equal(far.distance_band, 'far')
  assert.equal(far.duration_minutes, 240)
  assert.equal(far.route_id, 'route-main')
  assert.equal(far.no_route, false)

  assert.equal(near.source, 'graph')
  assert.equal(near.distance_band, 'near')
  assert.equal(near.duration_minutes, 45)

  // Названия локаций в обоих случаях одинаковые — решает только граф.
  assert.equal(far.from, near.from)
  assert.equal(far.to, near.to)
})

test('среднее расстояние даёт региональную полосу', () => {
  const regional = planServerTravel(travelState(plainsPair(4)), options)
  assert.equal(regional.distance_band, 'regional')
  assert.equal(regional.duration_minutes, 120)
})

test('название «Тёмный лес» не делает короткую дорогу по равнине дикой местностью', () => {
  const map = worldMap({
    regions: [region('reg-plains', 'plains')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 200, 300),
      place('loc-target', 'Тёмный лес', 'reg-plains', 300, 300),
    ],
    routes: [road('route-main', 'loc-start', 'loc-target', { distance: 2 })],
  })

  const travel = planServerTravel(travelState(map), { ...options, destination: 'Тёмный лес' })

  assert.equal(travel.source, 'graph')
  assert.equal(travel.distance_band, 'near')
  assert.equal(travel.duration_minutes, 45, 'надбавки за дикую местность быть не должно')
  assert.equal(travel.risk_score, 10, 'обжитая местность даёт 5 плюс 5 за низкую опасность дороги')
})

test('тропа через лесной биом остаётся дикой местностью', () => {
  const map = worldMap({
    regions: [region('reg-plains', 'plains'), region('reg-forest', 'forest')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 200, 300),
      place('loc-target', 'Дальний рубеж', 'reg-forest', 300, 300),
    ],
    routes: [road('route-main', 'loc-start', 'loc-target', { kind: 'trail', distance: 2 })],
  })

  const travel = planServerTravel(travelState(map), options)

  assert.equal(travel.duration_minutes, 75)
  assert.equal(travel.risk_score, 25)
})

test('опасность маршрута меняет риск при прочих равных', () => {
  const low = planServerTravel(travelState(plainsPair(3, { danger: 'низкая' })), options)
  const high = planServerTravel(travelState(plainsPair(3, { danger: 'высокая' })), options)
  const unknown = planServerTravel(travelState(plainsPair(3, { danger: 'непонятная' })), options)

  assert.equal(low.risk_score, 10)
  assert.equal(high.risk_score, 25)
  assert.equal(unknown.risk_score, 5, 'неизвестная опасность даёт 0 и не ломает расчёт')
  assert.equal(low.duration_minutes, high.duration_minutes)
})

test('английские значения опасности из ненормализованной карты тоже читаются', () => {
  const low = planServerTravel(travelState(plainsPair(3, { danger: 'low' })), options)
  const high = planServerTravel(travelState(plainsPair(3, { danger: 'high' })), options)
  assert.notEqual(low.risk_score, high.risk_score)
})

test('путь через промежуточную локацию складывает расстояние и берёт худшую опасность', () => {
  const map = worldMap({
    regions: [region('reg-plains', 'plains')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 200, 300),
      place('loc-middle', 'Брод', 'reg-plains', 400, 300),
      place('loc-target', 'Дальний рубеж', 'reg-plains', 600, 300),
    ],
    routes: [
      road('route-a', 'loc-start', 'loc-middle', { distance: 2, danger: 'низкая' }),
      road('route-b', 'loc-middle', 'loc-target', { distance: 4, danger: 'высокая' }),
    ],
  })

  const travel = planServerTravel(travelState(map), options)

  assert.equal(travel.source, 'graph')
  assert.equal(travel.no_route, false)
  assert.equal(travel.distance_band, 'far', 'сумма 2 + 4 = 6 попадает в дальнюю полосу')
  assert.equal(travel.duration_minutes, 240)
  assert.equal(travel.risk_score, 25, 'опасность — максимум по сегментам')
  assert.equal(travel.route_id, null, 'составной путь не выдаёт себя за один маршрут')
})

test('неоткрытый маршрут не используется как путь', () => {
  const hidden = plainsPair(1, { discovered: false })
  const travel = planServerTravel(travelState(hidden), options)
  assert.equal(travel.no_route, true)
})

test('изолированная локация честно возвращает отсутствие пути и не бросает', () => {
  const map = worldMap({
    regions: [region('reg-plains', 'plains')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 100, 100),
      place('loc-target', 'Дальний рубеж', 'reg-plains', 900, 600),
    ],
    routes: [],
  })

  const travel = planServerTravel(travelState(map), options)

  assert.equal(travel.source, 'graph')
  assert.equal(travel.no_route, true)
  assert.equal(travel.route_id, null)
  assert.equal(travel.distance_band, 'far', 'оценка напрямик по сетке 1000×640')
  assert.equal(travel.duration_minutes, 270)
  assert.equal(travel.risk_score, 35)
})

test('маршрут в графе не создаётся: планировщик не меняет worldMap', () => {
  const map = worldMap({
    regions: [region('reg-plains', 'plains')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 100, 100),
      place('loc-target', 'Дальний рубеж', 'reg-plains', 900, 600),
    ],
    routes: [],
  })
  const state = travelState(map)
  const before = structuredClone(state)

  planServerTravel(state, options)

  assert.deepEqual(state, before)
})

test('цель определяется по destinationLocationId раньше, чем по названию', () => {
  const map = worldMap({
    regions: [region('reg-plains', 'plains')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 200, 300),
      place('loc-near', 'Дальний рубеж', 'reg-plains', 300, 300),
      place('loc-far', 'Пограничный камень', 'reg-plains', 800, 300),
    ],
    routes: [
      road('route-near', 'loc-start', 'loc-near', { distance: 1 }),
      road('route-far', 'loc-start', 'loc-far', { distance: 9 }),
    ],
  })

  const byName = planServerTravel(travelState(map), options)
  const byId = planServerTravel(travelState(map), { ...options, destinationLocationId: 'loc-far' })

  assert.equal(byName.route_id, 'route-near')
  assert.equal(byName.distance_band, 'near')
  assert.equal(byId.route_id, 'route-far')
  assert.equal(byId.distance_band, 'far')
  assert.equal(byId.to, 'Дальний рубеж', 'отпечаток пути считается по тем же текстовым полям')
})

test('тема стычки приходит от биома региона на маршруте', () => {
  const wastesMap = worldMap({
    regions: [region('reg-plains', 'plains'), region('reg-wastes', 'wastes')],
    locations: [
      place('loc-start', 'Тихая застава', 'reg-plains', 200, 300),
      place('loc-target', 'Дальний рубеж', 'reg-wastes', 600, 300),
    ],
    routes: [road('route-main', 'loc-start', 'loc-target', { distance: 3, danger: 'высокая' })],
  })
  const state = travelState(wastesMap, { autonomy: { pacing: { tension: 95 } } })

  const encounters = Array.from({ length: 60 }, (_, index) => planServerTravel(state, {
    ...options,
    idempotencyKey: `travel-theme-${index}`,
  })).filter((travel) => travel.random_encounter)

  assert.ok(encounters.length > 0, 'высокий риск обязан уметь порождать стычку')
  for (const travel of encounters) assert.ok(['undead', 'raiders'].includes(travel.encounter.theme))
})

test('тот же ключ идемпотентности даёт тот же путь, в том числе после сериализации', () => {
  const state = travelState(plainsPair(5, { danger: 'средняя' }))
  const first = planServerTravel(state, options)
  const second = planServerTravel(state, options)
  const afterSerialization = planServerTravel(JSON.parse(JSON.stringify(state)), options)

  assert.deepEqual(first, second)
  assert.deepEqual(first, afterSerialization)
  assert.match(first.travel_id, /^travel-[a-f0-9]{20}$/u)

  const otherKey = planServerTravel(state, { ...options, idempotencyKey: 'travel-2' })
  assert.notEqual(otherKey.travel_id, first.travel_id)
  assert.equal(otherKey.duration_minutes, first.duration_minutes, 'длительность не зависит от ключа')
})

test('кампания без карты мира считается по прежней текстовой ветке', () => {
  const legacyState = {
    scene: { location: 'Северный тракт', scene_kind: 'wilderness' },
    adventure: { chapter: 2 },
    autonomy: { pacing: { tension: 82 } },
    worldMemory: { quests: [{ id: 'quest-1', status: 'active', clock: { current: 5, max: 6 } }] },
  }

  assert.deepEqual(planServerTravel(legacyState, {
    campaignId: 'LOOP-1',
    destination: 'Заброшенный склеп',
    idempotencyKey: 'travel-1',
  }), {
    travel_id: 'travel-567461638ff84e234453',
    from: 'Северный тракт',
    to: 'Заброшенный склеп',
    distance_band: 'regional',
    duration_minutes: 150,
    risk_score: 100,
    random_encounter: false,
    encounter: null,
    source: 'legacy_text',
    route_id: null,
    no_route: false,
    policy: 'server-travel-v2',
  })

  assert.deepEqual(planServerTravel(legacyState, {
    campaignId: 'LOOP-1',
    destination: 'Рыночная площадь',
    idempotencyKey: 'travel-7',
  }), {
    travel_id: 'travel-25f3605a5b5cf0583eee',
    from: 'Северный тракт',
    to: 'Рыночная площадь',
    distance_band: 'near',
    duration_minutes: 75,
    risk_score: 100,
    random_encounter: true,
    encounter: { theme: 'beasts', difficulty: 'hard' },
    source: 'legacy_text',
    route_id: null,
    no_route: false,
    policy: 'server-travel-v2',
  })
})

test('пустая или ненормализованная карта тоже уходит в ветку совместимости', () => {
  const base = { scene: { location: 'Северный тракт' }, adventure: { chapter: 1 } }
  const call = (worldMapValue) => planServerTravel({ ...base, worldMap: worldMapValue }, {
    campaignId: 'LOOP-1', destination: 'Рыночная площадь', idempotencyKey: 'travel-9',
  })

  assert.equal(call(undefined).source, 'legacy_text')
  assert.equal(call({}).source, 'legacy_text')
  assert.equal(call({ locations: [] }).source, 'legacy_text')
  assert.equal(call({ locations: [{ name: 'Без идентификатора' }] }).source, 'legacy_text')
  // Карта есть, но целевой локации в ней нет — считать по графу нечего.
  assert.equal(call(plainsPair(3)).source, 'legacy_text')
})

test('в теле planServerTravel не осталось регулярных выражений по названиям', () => {
  const source = readFileSync(new URL('../server/campaign-loop-policy.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export function planServerTravel')
  assert.ok(start > 0, 'функция planServerTravel обязана существовать')
  const body = source.slice(start, source.indexOf('\n}\n', start))

  assert.doesNotMatch(body, /\/\([^\n]+\)\/[a-z]*/u, 'литералов регулярных выражений в теле быть не должно')
  assert.doesNotMatch(body, /лес|тракт|болот|пустош|ущель|перевал|пещер|forest|marsh|mountain|crypt|склеп|кладбищ/iu)
  assert.doesNotMatch(body, /\.test\(/u)
})
