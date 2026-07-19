import { createHash } from 'node:crypto'

const WIDTH = 1000
const HEIGHT = 640
const KINDS = new Set(['capital', 'city', 'town', 'village', 'port', 'fortress', 'ruin', 'dungeon', 'landmark', 'wilds'])
const BIOMES = new Set(['plains', 'forest', 'mountains', 'marsh', 'desert', 'tundra', 'coast', 'wastes'])
const ROUTE_KINDS = new Set(['road', 'trail', 'river', 'sea', 'pass'])

function text(value, maximum = 180) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function key(value) {
  return text(value, 180).toLocaleLowerCase('ru')
}

function number(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback
}

function slug(value, fallback = 'place') {
  const normalized = text(value, 120).toLocaleLowerCase('ru')
    .replace(/[^a-zа-яё0-9]+/giu, '-')
    .replace(/^-+|-+$/gu, '')
  return (normalized || fallback).slice(0, 80)
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function uniqueId(base, used) {
  let id = base
  let suffix = 2
  while (used.has(id)) id = `${base.slice(0, 72)}-${suffix++}`
  used.add(id)
  return id
}

function generatedPlaceName(random, kind) {
  const starts = ['Айр', 'Валь', 'Эл', 'Нор', 'Кер', 'Тар', 'Рун', 'Мор', 'Силь', 'Эст', 'Дор', 'Каль']
  const ends = kind === 'wilds'
    ? ['ская чаща', 'ские топи', 'ская пустошь', 'ские равнины']
    : kind === 'ruin' || kind === 'dungeon'
      ? ['ские руины', 'ский курган', 'ская башня', 'ский склеп']
      : kind === 'fortress'
        ? ['ская твердыня', 'ский дозор', 'ская цитадель']
        : ['хольм', 'вуд', 'гард', 'мир', 'форд', 'мар', 'вель']
  return `${starts[Math.floor(random() * starts.length)]}${ends[Math.floor(random() * ends.length)]}`
}

function generatedRegionName(random, biome) {
  const adjectives = ['Серебряные', 'Пепельные', 'Туманные', 'Зелёные', 'Сумеречные', 'Северные', 'Забытые', 'Багряные']
  const nouns = biome === 'mountains' ? ['Пределы', 'Кряжи', 'Высоты']
    : biome === 'forest' ? ['Леса', 'Чащи', 'Пущи']
      : biome === 'coast' ? ['Берега', 'Побережья', 'Фьорды']
        : biome === 'marsh' ? ['Низины', 'Топи', 'Плавни']
          : ['Земли', 'Долины', 'Равнины']
  return `${adjectives[Math.floor(random() * adjectives.length)]} ${nouns[Math.floor(random() * nouns.length)]}`
}

function fallbackRegions(seed, concept = {}) {
  const random = seededRandom(`${seed}:regions`)
  const signature = `${concept.preset ?? ''} ${concept.genre ?? ''} ${concept.worldSummary ?? ''}`.toLocaleLowerCase('ru')
  const arid = /пустын|пустош|постапок/iu.test(signature)
  const cold = /лед|север|тундр|арктик/iu.test(signature)
  const biomes = arid
    ? ['wastes', 'desert', 'mountains', 'plains', 'coast']
    : cold ? ['tundra', 'mountains', 'forest', 'plains', 'coast']
      : ['forest', 'mountains', 'plains', 'marsh', 'coast']
  const centers = [[235, 185], [760, 155], [515, 330], [225, 495], [785, 485]]
  return centers.map(([x, y], index) => ({
    id: `region-${index + 1}`,
    name: generatedRegionName(random, biomes[index]),
    biome: biomes[index],
    x: x + Math.round((random() - .5) * 55),
    y: y + Math.round((random() - .5) * 42),
    radius: index === 2 ? 245 : 205,
  }))
}

function fallbackLocations(seed, startingLocation, regions) {
  const random = seededRandom(`${seed}:locations`)
  const positions = [[500, 360], [300, 280], [690, 270], [170, 450], [830, 440], [410, 125], [625, 510], [845, 130], [125, 145]]
  const kinds = ['town', 'village', 'city', 'wilds', 'fortress', 'ruin', 'port', 'dungeon', 'landmark']
  return positions.map(([baseX, baseY], index) => {
    const x = baseX + Math.round((random() - .5) * 60)
    const y = baseY + Math.round((random() - .5) * 46)
    const nearest = [...regions].sort((left, right) => Math.hypot(x - left.x, y - left.y) - Math.hypot(x - right.x, y - right.y))[0]
    const name = index === 0 && text(startingLocation) ? text(startingLocation) : generatedPlaceName(random, kinds[index])
    return {
      id: `location-${index + 1}-${slug(name)}`,
      name,
      kind: kinds[index],
      x,
      y,
      regionId: nearest?.id ?? regions[0]?.id ?? '',
      summary: index === 0 ? 'Здесь начинается история отряда.' : `Известное место региона «${nearest?.name ?? 'Неизведанные земли'}».`,
      known: true,
      visited: index === 0,
    }
  })
}

function fallbackRoutes(locations) {
  const sorted = [...locations].sort((left, right) => left.x - right.x)
  const pairs = []
  for (let index = 1; index < sorted.length; index += 1) pairs.push([sorted[index - 1], sorted[index]])
  for (const location of locations) {
    const nearest = locations
      .filter((candidate) => candidate.id !== location.id)
      .sort((left, right) => Math.hypot(location.x - left.x, location.y - left.y) - Math.hypot(location.x - right.x, location.y - right.y))[0]
    if (nearest) pairs.push([location, nearest])
  }
  const seen = new Set()
  return pairs.flatMap(([from, to], index) => {
    const signature = [from.id, to.id].sort().join(':')
    if (seen.has(signature)) return []
    seen.add(signature)
    const distance = Math.max(1, Math.round(Math.hypot(from.x - to.x, from.y - to.y) / 48))
    return [{ id: `route-${index + 1}-${hash(signature).slice(0, 8)}`, from: from.id, to: to.id, kind: 'road', distance, danger: distance > 7 ? 'средняя' : 'низкая', discovered: true }]
  })
}

function normalizeRegions(rawRegions, fallback) {
  const used = new Set()
  const regions = (Array.isArray(rawRegions) ? rawRegions : []).slice(0, 12).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const name = text(raw.name, 100)
    if (!name) return []
    const base = slug(raw.id || name, `region-${index + 1}`)
    return [{
      id: uniqueId(base, used), name,
      biome: BIOMES.has(raw.biome) ? raw.biome : fallback[index % fallback.length]?.biome ?? 'plains',
      x: number(raw.x, fallback[index % fallback.length]?.x ?? WIDTH / 2, 60, WIDTH - 60),
      y: number(raw.y, fallback[index % fallback.length]?.y ?? HEIGHT / 2, 55, HEIGHT - 55),
      radius: number(raw.radius, 205, 120, 300),
    }]
  })
  return regions.length >= 3 ? regions : fallback
}

function nearestRegionId(regions, x, y) {
  return [...regions].sort((left, right) => Math.hypot(x - left.x, y - left.y) - Math.hypot(x - right.x, y - right.y))[0]?.id ?? ''
}

function normalizeLocations(rawLocations, fallback, regions, currentLocation) {
  const used = new Set()
  const regionByName = new Map(regions.map((region) => [key(region.name), region.id]))
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : fallback
  const locations = source.slice(0, 40).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const name = text(raw.name, 120)
    if (!name) return []
    const x = number(raw.x, fallback[index % fallback.length]?.x ?? WIDTH / 2, 45, WIDTH - 45)
    const y = number(raw.y, fallback[index % fallback.length]?.y ?? HEIGHT / 2, 45, HEIGHT - 45)
    const regionId = regions.some((region) => region.id === raw.regionId) ? raw.regionId
      : regionByName.get(key(raw.region)) ?? nearestRegionId(regions, x, y)
    const id = uniqueId(slug(raw.id || name, `location-${index + 1}`), used)
    return [{
      id, name,
      kind: KINDS.has(raw.kind) ? raw.kind : 'landmark',
      x, y, regionId,
      summary: text(raw.summary || raw.description, 320),
      known: raw.known !== false,
      visited: raw.visited === true || key(name) === key(currentLocation),
    }]
  })
  return locations
}

function endpointId(value, locations) {
  const expected = key(value)
  return locations.find((location) => location.id === value || key(location.name) === expected)?.id ?? ''
}

function normalizeRoutes(rawRoutes, fallback, locations) {
  const source = Array.isArray(rawRoutes) && rawRoutes.length ? rawRoutes : fallback
  const seen = new Set()
  return source.slice(0, 80).flatMap((raw, index) => {
    const from = endpointId(raw?.from, locations)
    const to = endpointId(raw?.to, locations)
    const signature = [from, to].sort().join(':')
    if (!from || !to || from === to || seen.has(signature)) return []
    seen.add(signature)
    const fromNode = locations.find((location) => location.id === from)
    const toNode = locations.find((location) => location.id === to)
    const estimated = Math.max(1, Math.round(Math.hypot(fromNode.x - toNode.x, fromNode.y - toNode.y) / 48))
    return [{
      id: text(raw.id, 100) || `route-${index + 1}-${hash(signature).slice(0, 8)}`,
      from, to,
      kind: ROUTE_KINDS.has(raw.kind) ? raw.kind : 'road',
      distance: number(raw.distance, estimated, 1, 30),
      danger: ['низкая', 'средняя', 'высокая'].includes(raw.danger) ? raw.danger : estimated > 7 ? 'средняя' : 'низкая',
      discovered: raw.discovered !== false,
    }]
  })
}

export function createCampaignWorldMap({ seed, campaignName, concept = {}, source = {}, startingLocation = '' } = {}) {
  const safeSeed = text(seed, 120) || hash(`${campaignName}:${startingLocation}`).slice(0, 24)
  const regionFallback = fallbackRegions(safeSeed, concept)
  const regions = normalizeRegions(source.regions, regionFallback)
  const locationFallback = fallbackLocations(safeSeed, startingLocation, regions)
  const locations = normalizeLocations(source.locations, locationFallback, regions, startingLocation)
  const routeFallback = fallbackRoutes(locations)
  const routes = normalizeRoutes([...(Array.isArray(source.routes) ? source.routes : []), ...routeFallback], routeFallback, locations)
  const current = locations.find((location) => key(location.name) === key(startingLocation)) ?? locations[0]
  if (current) current.visited = true
  return {
    version: 1,
    seed: safeSeed,
    name: text(source.name, 120) || `Карта мира «${text(campaignName, 100) || 'Безымянная кампания'}»`,
    width: WIDTH,
    height: HEIGHT,
    currentLocationId: current?.id ?? '',
    regions,
    locations,
    routes,
  }
}

function freePosition(map, name, anchor) {
  const random = seededRandom(`${map.seed}:place:${name}`)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const angle = random() * Math.PI * 2
    const radius = 105 + random() * 120
    const x = number(anchor.x + Math.cos(angle) * radius, WIDTH / 2, 55, WIDTH - 55)
    const y = number(anchor.y + Math.sin(angle) * radius, HEIGHT / 2, 55, HEIGHT - 55)
    if (map.locations.every((location) => Math.hypot(location.x - x, location.y - y) > 68)) return { x, y }
  }
  return { x: number(anchor.x + 110, WIDTH / 2, 55, WIDTH - 55), y: number(anchor.y + 70, HEIGHT / 2, 55, HEIGHT - 55) }
}

export function reconcileWorldMap(rawMap, { seed, campaignName, concept = {}, currentLocation = '', previousLocation = '', knownLocations = [], transition = '', scene = {} } = {}) {
  const map = createCampaignWorldMap({
    seed: rawMap?.seed || seed,
    campaignName,
    concept,
    source: rawMap && typeof rawMap === 'object' ? rawMap : {},
    startingLocation: currentLocation,
  })
  const allNames = [...new Set([...knownLocations, previousLocation, currentLocation].map((name) => text(name, 120)).filter(Boolean))]
  for (const name of allNames) {
    let node = map.locations.find((location) => key(location.name) === key(name))
    if (!node) {
      const anchor = map.locations.find((location) => key(location.name) === key(previousLocation))
        ?? map.locations.find((location) => location.id === map.currentLocationId)
        ?? map.locations[0]
        ?? { x: WIDTH / 2, y: HEIGHT / 2, id: '' }
      const position = freePosition(map, name, anchor)
      const id = uniqueId(slug(name), new Set(map.locations.map((location) => location.id)))
      node = {
        id, name,
        kind: scene.scene_kind === 'settlement' ? 'town' : scene.scene_kind === 'dungeon' ? 'dungeon' : 'landmark',
        ...position,
        regionId: nearestRegionId(map.regions, position.x, position.y),
        summary: key(name) === key(currentLocation) ? text(scene.objective || transition, 320) : 'Место, сохранённое в хронике кампании.',
        known: true,
        visited: true,
      }
      map.locations.push(node)
    }
    if (knownLocations.some((known) => key(known) === key(name)) || key(name) === key(currentLocation)) node.visited = true
  }
  const previous = map.locations.find((location) => key(location.name) === key(previousLocation))
  const current = map.locations.find((location) => key(location.name) === key(currentLocation))
  if (current) {
    current.visited = true
    current.known = true
    if (text(scene.objective)) current.summary ||= text(scene.objective, 320)
    map.currentLocationId = current.id
  }
  if (previous && current && previous.id !== current.id) {
    const signature = [previous.id, current.id].sort().join(':')
    if (!map.routes.some((route) => [route.from, route.to].sort().join(':') === signature)) {
      map.routes.push({
        id: `route-${hash(signature).slice(0, 10)}`,
        from: previous.id,
        to: current.id,
        kind: /река|river/iu.test(transition) ? 'river' : /перевал|pass/iu.test(transition) ? 'pass' : 'road',
        distance: Math.max(1, Math.round(Math.hypot(previous.x - current.x, previous.y - current.y) / 48)),
        danger: scene.danger === 'высокая' ? 'высокая' : scene.danger === 'низкая' ? 'низкая' : 'средняя',
        discovered: true,
      })
    }
  }
  map.locations = map.locations.slice(0, 50)
  const validIds = new Set(map.locations.map((location) => location.id))
  map.routes = map.routes.filter((route) => validIds.has(route.from) && validIds.has(route.to)).slice(0, 100)
  return map
}

export function ensureCampaignWorldMap(state = {}) {
  const adventure = state.adventure && typeof state.adventure === 'object' ? state.adventure : {}
  const historyLocations = (Array.isArray(adventure.history) ? adventure.history : []).map((entry) => entry?.location)
  const knownLocations = [...(Array.isArray(adventure.visitedLocations) ? adventure.visitedLocations : []), ...historyLocations]
  const seed = state.worldMap?.seed || hash(JSON.stringify({ code: state.sessionCode, campaign: state.campaign, concept: state.campaignConcept })).slice(0, 24)
  return reconcileWorldMap(state.worldMap, {
    seed,
    campaignName: state.campaign,
    concept: state.campaignConcept,
    currentLocation: state.scene?.location,
    previousLocation: adventure.history?.at?.(-1)?.location,
    knownLocations,
    transition: adventure.lastTransition,
    scene: state.scene,
  })
}
