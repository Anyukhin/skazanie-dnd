// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Каталог заранее написанных миров. В отличие от `campaign-inspiration.mjs`
 * это не источник случайных ориентиров и не ответ модели: записи здесь —
 * versioned content, которое сервер выбирает только по allowlist-идентификатору.
 * Карта остаётся в форме `server/world-map.mjs`, а этот модуль владеет только
 * комплектом «мир + история + стартовая сцена».
 */

export const WORLD_TEMPLATE_SCHEMA_VERSION = 1
export const WORLD_TEMPLATE_IMAGE_PATTERN = /^\/assets\/maps\/world\/skazanie\/[a-z0-9][a-z0-9-]*-v[1-9][0-9]*\.webp$/u
export const CITY_OVERVIEW_IMAGE_PATTERN = /^\/assets\/maps\/city\/skazanie\/[a-z0-9][a-z0-9-]*-v[1-9][0-9]*\.webp$/u

const WORLD_TEMPLATE_COUNT = 3
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DATA_FILE = fileURLToPath(new URL('../data/campaign-worlds-v1.json', import.meta.url))

const WORLD_KINDS = new Set(['capital', 'city', 'town', 'village', 'port', 'fortress', 'ruin', 'dungeon', 'landmark', 'wilds'])
// Крепость — тоже населённый узел карты: она входит в minimum settlement
// coverage, хотя в UI остаётся отдельным видом POI.
const SETTLEMENT_KINDS = new Set(['capital', 'city', 'town', 'village', 'port', 'fortress'])
const WORLD_BIOMES = new Set(['plains', 'forest', 'mountains', 'marsh', 'desert', 'tundra', 'coast', 'wastes'])
const ROUTE_KINDS = new Set(['road', 'trail', 'river', 'sea', 'pass'])
const DANGERS = new Set(['низкая', 'средняя', 'высокая'])
const CITY_PLACE_KINDS = new Set(['civic', 'harbor', 'market', 'temple', 'archive', 'gate', 'tower', 'garden', 'workshop', 'infrastructure', 'inn', 'other'])
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u
const TEXT_LIMITS = Object.freeze({
  id: 80,
  name: 160,
  short: 360,
  description: 2_000,
  history: 12_000,
  world: 1_200,
})

export class WorldTemplateCatalogError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'WORLD_TEMPLATE_INVALID') {
    super(message)
    this.name = 'WorldTemplateCatalogError'
    this.code = code
  }
}

function clone(value) {
  return structuredClone(value)
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorldTemplateCatalogError(`${path} должен быть объектом`)
  }
  return /** @type {Record<string, any>} */ (value)
}

function array(value, path, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new WorldTemplateCatalogError(`${path} должен содержать не менее ${minimum} записей`)
  }
  return value
}

function text(value, path, maximum = TEXT_LIMITS.short) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorldTemplateCatalogError(`${path} должен быть непустым текстом`)
  }
  const result = value.normalize('NFKC').replace(/\r/gu, '').trim()
  if (result.length > maximum) throw new WorldTemplateCatalogError(`${path} длиннее ${maximum} символов`)
  return result
}

function optionalText(value, path, maximum = TEXT_LIMITS.short) {
  if (value == null || value === '') return ''
  return text(value, path, maximum)
}

function integer(value, path, minimum, maximum, fallback = undefined) {
  if (value == null && fallback !== undefined) return fallback
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new WorldTemplateCatalogError(`${path} должен быть целым числом от ${minimum} до ${maximum}`)
  }
  return result
}

function boolean(value, path, fallback = undefined) {
  if (value == null && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') throw new WorldTemplateCatalogError(`${path} должен быть boolean`)
  return value
}

function id(value, path, maximum = TEXT_LIMITS.id) {
  const result = text(value, path, maximum)
  if (!ID_PATTERN.test(result)) throw new WorldTemplateCatalogError(`${path} должен быть безопасным ASCII-идентификатором`)
  return result
}

function field(source, ...names) {
  for (const name of names) if (source?.[name] !== undefined) return source[name]
  return undefined
}

function normalizeThemes(value, path) {
  if (Array.isArray(value)) {
    const values = value.map((entry, index) => text(entry, `${path}[${index}]`, 160))
    if (!values.length) throw new WorldTemplateCatalogError(`${path} не должен быть пустым`)
    return values
  }
  return text(value, path, TEXT_LIMITS.world)
}

function resolveName(entries, value, path) {
  const wanted = text(value, path, TEXT_LIMITS.name)
  const exact = entries.find((entry) => entry.id === wanted)
  if (exact) return exact.id
  const byName = entries.find((entry) => entry.name === wanted)
  if (byName) return byName.id
  throw new WorldTemplateCatalogError(`${path} ссылается на неизвестную запись «${wanted}»`)
}

function richTextFor(value, path) {
  if (typeof value === 'string') return text(value, path, TEXT_LIMITS.history)
  const source = object(value, path)
  const candidate = field(source, 'summary', 'description', 'text', 'details', 'detail', 'title', 'name', 'label', 'hook', 'objective', 'event', 'impact', 'consequence', 'used_for')
  if (candidate == null) throw new WorldTemplateCatalogError(`${path} не содержит текста истории`)
  return text(candidate, `${path}.summary`, TEXT_LIMITS.history)
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {boolean} requireIds
 */
function validateRichCollection(value, path, requireIds = false) {
  const source = array(value, path)
  const seen = new Set()
  return source.map((entry, index) => {
    const itemPath = `${path}[${index}]`
    if (typeof entry === 'string') {
      richTextFor(entry, itemPath)
      if (requireIds) throw new WorldTemplateCatalogError(`${itemPath} должен иметь id`)
      return entry
    }
    const item = object(entry, itemPath)
    const candidateId = field(item, 'id', 'arc_id', 'hook_id', 'faction_id')
    if (candidateId != null) {
      const itemId = id(candidateId, `${itemPath}.id`)
      if (seen.has(itemId)) throw new WorldTemplateCatalogError(`${path} содержит повторяющийся id «${itemId}»`)
      seen.add(itemId)
    } else if (requireIds) {
      throw new WorldTemplateCatalogError(`${itemPath}.id обязателен`)
    }
    richTextFor(item, itemPath)
    return clone(item)
  })
}

function validateImage(value, path) {
  const image = text(value, path, 240)
  if (!WORLD_TEMPLATE_IMAGE_PATTERN.test(image)) {
    throw new WorldTemplateCatalogError(`${path} должен быть внутренним WebP-путём карты мира`)
  }
  const relative = image.slice(1).split('/').join(sep)
  const file = join(PROJECT_ROOT, 'public', relative)
  if (!existsSync(file)) throw new WorldTemplateCatalogError(`${path} указывает на отсутствующий файл ${image}`)
  return image
}

function validateCityImage(value, path) {
  const image = text(value, path, 240)
  if (!CITY_OVERVIEW_IMAGE_PATTERN.test(image)) {
    throw new WorldTemplateCatalogError(`${path} должен быть внутренним WebP-путём городского плана`)
  }
  const relative = image.slice(1).split('/').join(sep)
  const file = join(PROJECT_ROOT, 'public', relative)
  if (!existsSync(file)) throw new WorldTemplateCatalogError(`${path} указывает на отсутствующий файл ${image}`)
  return image
}

function validateCityHooks(value, path) {
  const hooks = array(value, path, 2)
  if (hooks.length !== 2) throw new WorldTemplateCatalogError(`${path} должен содержать ровно две зацепки`)
  return hooks.map((entry, index) => text(entry, `${path}[${index}]`, 320))
}

function validateCityOverview(raw, path) {
  const source = object(raw, path)
  const version = integer(source.version, `${path}.version`, 1, 99)
  const width = integer(source.width, `${path}.width`, 320, 2_000)
  const height = integer(source.height, `${path}.height`, 240, 1_200)
  const image = validateCityImage(source.image, `${path}.image`)
  const imageAlt = text(field(source, 'imageAlt', 'image_alt'), `${path}.imageAlt`, 300)
  const districtIds = new Set()
  const districtsSource = array(source.districts, `${path}.districts`, 6)
  if (districtsSource.length !== 6) throw new WorldTemplateCatalogError(`${path}.districts должен содержать ровно шесть районов`)
  const districts = districtsSource.map((rawDistrict, index) => {
    const itemPath = `${path}.districts[${index}]`
    const district = object(rawDistrict, itemPath)
    const districtId = id(district.id, `${itemPath}.id`)
    if (districtIds.has(districtId)) throw new WorldTemplateCatalogError(`${path}.districts содержит повторяющийся id «${districtId}»`)
    districtIds.add(districtId)
    const x = integer(district.x, `${itemPath}.x`, 35, width - 35)
    const y = integer(district.y, `${itemPath}.y`, 35, height - 35)
    const rawBounds = object(district.bounds, `${itemPath}.bounds`)
    const boundsX = integer(rawBounds.x, `${itemPath}.bounds.x`, 20, width - 80)
    const boundsY = integer(rawBounds.y, `${itemPath}.bounds.y`, 20, height - 80)
    const boundsWidth = integer(rawBounds.width, `${itemPath}.bounds.width`, 80, width - boundsX)
    const boundsHeight = integer(rawBounds.height, `${itemPath}.bounds.height`, 80, height - boundsY)
    if (boundsX + boundsWidth > width || boundsY + boundsHeight > height) throw new WorldTemplateCatalogError(`${itemPath}.bounds выходит за карту`)
    return {
      id: districtId,
      name: text(district.name, `${itemPath}.name`, 120),
      x,
      y,
      bounds: { x: boundsX, y: boundsY, width: boundsWidth, height: boundsHeight },
      summary: text(district.summary, `${itemPath}.summary`, 500),
      history: text(district.history, `${itemPath}.history`, 1_200),
      storyHooks: validateCityHooks(field(district, 'storyHooks', 'story_hooks'), `${itemPath}.storyHooks`),
    }
  })
  const placeIds = new Set()
  const placesSource = array(source.places, `${path}.places`, 10)
  if (placesSource.length !== 10) throw new WorldTemplateCatalogError(`${path}.places должен содержать ровно десять мест`)
  const places = placesSource.map((rawPlace, index) => {
    const itemPath = `${path}.places[${index}]`
    const place = object(rawPlace, itemPath)
    const placeId = id(place.id, `${itemPath}.id`)
    if (placeIds.has(placeId)) throw new WorldTemplateCatalogError(`${path}.places содержит повторяющийся id «${placeId}»`)
    placeIds.add(placeId)
    const districtId = id(field(place, 'districtId', 'district_id'), `${itemPath}.districtId`)
    if (!districtIds.has(districtId)) throw new WorldTemplateCatalogError(`${itemPath}.districtId ссылается на неизвестный район`)
    const kind = text(place.kind, `${itemPath}.kind`, 40)
    if (!CITY_PLACE_KINDS.has(kind)) throw new WorldTemplateCatalogError(`${itemPath}.kind имеет недопустимое значение`)
    return {
      id: placeId,
      name: text(place.name, `${itemPath}.name`, 120),
      kind,
      districtId,
      x: integer(place.x, `${itemPath}.x`, 25, width - 25),
      y: integer(place.y, `${itemPath}.y`, 25, height - 25),
      summary: text(place.summary, `${itemPath}.summary`, 500),
      history: text(place.history, `${itemPath}.history`, 1_200),
      storyHooks: validateCityHooks(field(place, 'storyHooks', 'story_hooks'), `${itemPath}.storyHooks`),
    }
  })
  return {
    version,
    name: text(source.name, `${path}.name`, TEXT_LIMITS.name),
    summary: text(source.summary, `${path}.summary`, TEXT_LIMITS.description),
    image,
    imageAlt,
    width,
    height,
    districts,
    places,
  }
}

function validateMetadata(raw, index) {
  const path = `templates[${index}]`
  const template = object(raw, path)
  const templateId = id(template.id, `${path}.id`)
  const version = Number.isSafeInteger(template.version) && template.version >= 1
    ? template.version
    : text(template.version, `${path}.version`, 40)
  if (typeof version === 'string' && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new WorldTemplateCatalogError(`${path}.version должен быть положительным числом или semver-строкой`)
  }
  const name = text(template.name, `${path}.name`, TEXT_LIMITS.name)
  const tagline = text(template.tagline, `${path}.tagline`, TEXT_LIMITS.short)
  const description = text(template.description, `${path}.description`, TEXT_LIMITS.description)
  const image = validateImage(template.image, `${path}.image`)
  const imageAlt = text(field(template, 'imageAlt', 'image_alt'), `${path}.imageAlt`, TEXT_LIMITS.short)
  const accent = text(template.accent, `${path}.accent`, 80)
  const focus = Array.isArray(template.focus)
    ? template.focus.map((entry, entryIndex) => text(entry, `${path}.focus[${entryIndex}]`, 120)).slice(0, 8)
    : [text(template.focus, `${path}.focus`, TEXT_LIMITS.short)]
  if (!focus.length) throw new WorldTemplateCatalogError(`${path}.focus не должен быть пустым`)
  const recommendedLevels = field(template, 'recommendedLevels', 'recommended_levels')
  if (typeof recommendedLevels === 'string') text(recommendedLevels, `${path}.recommendedLevels`, 80)
  else if (Array.isArray(recommendedLevels)) {
    if (!recommendedLevels.length) throw new WorldTemplateCatalogError(`${path}.recommendedLevels не должен быть пустым`)
    recommendedLevels.forEach((entry, entryIndex) => integer(entry, `${path}.recommendedLevels[${entryIndex}]`, 1, 20))
  } else if (recommendedLevels && typeof recommendedLevels === 'object') {
    integer(recommendedLevels.min, `${path}.recommendedLevels.min`, 1, 20)
    integer(recommendedLevels.max, `${path}.recommendedLevels.max`, 1, 20)
    if (recommendedLevels.max < recommendedLevels.min) throw new WorldTemplateCatalogError(`${path}.recommendedLevels задан неверно`)
  } else throw new WorldTemplateCatalogError(`${path}.recommendedLevels должен быть строкой, массивом или диапазоном`)
  return { template, templateId, version, name, tagline, description, image, imageAlt, accent, focus, recommendedLevels }
}

function validateWorld(raw, path, startName) {
  const source = object(raw, path)
  const world = {
    ...clone(source),
    preset: optionalText(field(source, 'preset', 'setting'), `${path}.preset`, 240),
    era: text(source.era, `${path}.era`, TEXT_LIMITS.world),
    genre: text(source.genre, `${path}.genre`, TEXT_LIMITS.world),
    tone: text(source.tone, `${path}.tone`, TEXT_LIMITS.world),
    themes: normalizeThemes(source.themes, `${path}.themes`),
    premise: optionalText(source.premise, `${path}.premise`, TEXT_LIMITS.description),
    boundaries: optionalText(source.boundaries, `${path}.boundaries`, TEXT_LIMITS.short),
    magicLevel: optionalText(field(source, 'magicLevel', 'magic_level'), `${path}.magicLevel`, 120),
    technologyLevel: optionalText(field(source, 'technologyLevel', 'technology_level'), `${path}.technologyLevel`, 120),
    startingLocation: text(field(source, 'startingLocation', 'starting_location') ?? startName, `${path}.startingLocation`, TEXT_LIMITS.name),
  }
  return world
}

function validateWorldMap(raw, path) {
  const source = object(raw, path)
  const width = integer(source.width, `${path}.width`, 320, 2_000, 1_000)
  const height = integer(source.height, `${path}.height`, 240, 1_200, 640)
  const routesComplete = boolean(source.routesComplete, `${path}.routesComplete`, false)
  const backgroundValue = field(source, 'backgroundImage', 'background_image')
  const backgroundImage = backgroundValue == null ? '' : validateImage(backgroundValue, `${path}.backgroundImage`)
  const backgroundAlt = backgroundImage
    ? optionalText(field(source, 'backgroundAlt', 'background_alt'), `${path}.backgroundAlt`, TEXT_LIMITS.short)
    : ''
  const rawRegions = array(source.regions, `${path}.regions`, 5)
  const regionIds = new Set()
  const regions = rawRegions.map((rawRegion, index) => {
    const itemPath = `${path}.regions[${index}]`
    const rawItem = object(rawRegion, itemPath)
    const regionId = id(rawItem.id, `${itemPath}.id`)
    if (regionIds.has(regionId)) throw new WorldTemplateCatalogError(`${path}.regions содержит повторяющийся id «${regionId}»`)
    regionIds.add(regionId)
    const biome = text(rawItem.biome, `${itemPath}.biome`, 40)
    if (!WORLD_BIOMES.has(biome)) throw new WorldTemplateCatalogError(`${itemPath}.biome имеет недопустимое значение`)
    return {
      ...clone(rawItem), id: regionId,
      name: text(rawItem.name, `${itemPath}.name`, TEXT_LIMITS.name), biome,
      x: integer(rawItem.x, `${itemPath}.x`, 45, Math.min(955, width - 45)),
      y: integer(rawItem.y, `${itemPath}.y`, 45, Math.min(595, height - 45)),
      radius: integer(rawItem.radius, `${itemPath}.radius`, 60, 500),
    }
  })

  const rawLocations = array(source.locations, `${path}.locations`, 12)
  const locationIds = new Set()
  const locations = rawLocations.map((rawLocation, index) => {
    const itemPath = `${path}.locations[${index}]`
    const rawItem = object(rawLocation, itemPath)
    const locationId = id(rawItem.id, `${itemPath}.id`)
    if (locationIds.has(locationId)) throw new WorldTemplateCatalogError(`${path}.locations содержит повторяющийся id «${locationId}»`)
    locationIds.add(locationId)
    const kind = text(rawItem.kind, `${itemPath}.kind`, 40)
    if (!WORLD_KINDS.has(kind)) throw new WorldTemplateCatalogError(`${itemPath}.kind имеет недопустимое значение`)
    const regionReference = field(rawItem, 'regionId', 'region_id', 'region')
    const regionId = resolveName(regions, regionReference, `${itemPath}.regionId`)
    const summary = text(field(rawItem, 'summary', 'description', 'lore'), `${itemPath}.summary`, TEXT_LIMITS.description)
    const history = text(rawItem.history, `${itemPath}.history`, TEXT_LIMITS.history)
    const storyHooks = array(rawItem.storyHooks ?? rawItem.story_hooks, `${itemPath}.storyHooks`, 1)
      .map((entry, hookIndex) => text(entry, `${itemPath}.storyHooks[${hookIndex}]`, TEXT_LIMITS.short))
    const rawCityOverview = field(rawItem, 'cityOverview', 'city_overview')
    const cityOverview = rawCityOverview == null ? null : validateCityOverview(rawCityOverview, `${itemPath}.cityOverview`)
    return {
      ...clone(rawItem), id: locationId,
      name: text(rawItem.name, `${itemPath}.name`, TEXT_LIMITS.name), kind, regionId,
      x: integer(rawItem.x, `${itemPath}.x`, 45, Math.min(955, width - 45)),
      y: integer(rawItem.y, `${itemPath}.y`, 45, Math.min(595, height - 45)),
      summary,
      history,
      storyHooks,
      ...(cityOverview ? { cityOverview } : {}),
      known: boolean(rawItem.known, `${itemPath}.known`, true),
      visited: boolean(rawItem.visited, `${itemPath}.visited`, false),
    }
  })
  const settlements = locations.filter((location) => SETTLEMENT_KINDS.has(location.kind))
  if (settlements.length < 5) throw new WorldTemplateCatalogError(`${path}.locations должен содержать не менее пяти поселений`)

  const rawRoutes = array(source.routes, `${path}.routes`, locations.length - 1)
  const routeIds = new Set()
  const routes = rawRoutes.map((rawRoute, index) => {
    const itemPath = `${path}.routes[${index}]`
    const rawItem = object(rawRoute, itemPath)
    const routeId = id(rawItem.id, `${itemPath}.id`)
    if (routeIds.has(routeId)) throw new WorldTemplateCatalogError(`${path}.routes содержит повторяющийся id «${routeId}»`)
    routeIds.add(routeId)
    const from = resolveName(locations, field(rawItem, 'from', 'fromId', 'from_id'), `${itemPath}.from`)
    const to = resolveName(locations, field(rawItem, 'to', 'toId', 'to_id'), `${itemPath}.to`)
    if (from === to) throw new WorldTemplateCatalogError(`${itemPath} не может соединять место с самим собой`)
    const kind = text(rawItem.kind, `${itemPath}.kind`, 40)
    if (!ROUTE_KINDS.has(kind)) throw new WorldTemplateCatalogError(`${itemPath}.kind имеет недопустимое значение`)
    const danger = text(rawItem.danger, `${itemPath}.danger`, 40)
    if (!DANGERS.has(danger)) throw new WorldTemplateCatalogError(`${itemPath}.danger имеет недопустимое значение`)
    return {
      ...clone(rawItem), id: routeId, from, to, kind,
      distance: integer(rawItem.distance, `${itemPath}.distance`, 1, 30),
      danger,
      discovered: boolean(rawItem.discovered, `${itemPath}.discovered`, true),
    }
  })
  return {
    ...clone(source),
    version: integer(source.version, `${path}.version`, 1, 999_999, 1), routesComplete,
    name: text(source.name, `${path}.name`, TEXT_LIMITS.name), width, height, regions, locations, routes,
    ...(backgroundImage ? { backgroundImage, ...(backgroundAlt ? { backgroundAlt } : {}) } : {}),
  }
}

function validateOpening(raw, path, worldMap, defaults = {}) {
  const source = object(raw, path)
  const scene = object(source.scene, `${path}.scene`)
  const locationId = id(field(scene, 'locationId', 'location_id'), `${path}.scene.locationId`)
  const start = worldMap.locations.find((location) => location.id === locationId)
  if (!start) throw new WorldTemplateCatalogError(`${path}.scene.locationId не найден на карте`)
  const location = text(scene.location, `${path}.scene.location`, TEXT_LIMITS.name)
  if (location !== start.name) throw new WorldTemplateCatalogError(`${path}.scene.location не совпадает с locationId`)
  if (start.visited !== true) throw new WorldTemplateCatalogError(`${path}.scene.locationId должен указывать на посещённую стартовую точку`)
  const sceneMap = object(scene.map, `${path}.scene.map`)
  const layouts = new Set(['rooms', 'streets', 'open', 'winding', 'cavern', 'ruins', 'radial'])
  if (sceneMap.layout != null && !layouts.has(text(sceneMap.layout, `${path}.scene.map.layout`, 40))) {
    throw new WorldTemplateCatalogError(`${path}.scene.map.layout имеет недопустимое значение`)
  }
  const danger = text(scene.danger, `${path}.scene.danger`, 40)
  if (!DANGERS.has(danger)) throw new WorldTemplateCatalogError(`${path}.scene.danger имеет недопустимое значение`)
  const npcs = array(source.npcs, `${path}.npcs`, 1)
  if (npcs.length > 5) throw new WorldTemplateCatalogError(`${path}.npcs не должен содержать больше пяти записей`)
  const normalizedNpcs = npcs.map((rawNpc, index) => {
    const npcPath = `${path}.npcs[${index}]`
    const npc = object(rawNpc, npcPath)
    const goals = Array.isArray(npc.goals) ? npc.goals.map((entry, goalIndex) => text(entry, `${npcPath}.goals[${goalIndex}]`, 240)).slice(0, 4) : []
    const beliefs = Array.isArray(npc.beliefs) ? npc.beliefs.map((entry, beliefIndex) => text(entry, `${npcPath}.beliefs[${beliefIndex}]`, 240)).slice(0, 4) : []
    return {
      ...clone(npc),
      name: text(npc.name, `${npcPath}.name`, TEXT_LIMITS.name),
      role: optionalText(npc.role, `${npcPath}.role`, TEXT_LIMITS.short),
      summary: text(field(npc, 'summary', 'description', 'lore'), `${npcPath}.summary`, TEXT_LIMITS.short),
      voice: optionalText(npc.voice, `${npcPath}.voice`, TEXT_LIMITS.short),
      goals,
      beliefs,
    }
  })
  return {
    ...clone(source),
    campaignName: text(field(source, 'campaignName', 'campaign_name', 'name') ?? defaults.campaignName, `${path}.campaignName`, TEXT_LIMITS.name),
    partyName: optionalText(field(source, 'partyName', 'party_name'), `${path}.partyName`, TEXT_LIMITS.name),
    worldSummary: text(field(source, 'worldSummary', 'world_summary') ?? defaults.worldSummary, `${path}.worldSummary`, TEXT_LIMITS.description),
    worldHistory: text(field(source, 'worldHistory', 'world_history') ?? defaults.worldHistory, `${path}.worldHistory`, TEXT_LIMITS.history),
    openingNarration: text(field(source, 'openingNarration', 'opening_narration', 'narration'), `${path}.openingNarration`, TEXT_LIMITS.history),
    scene: {
      ...clone(scene),
      locationId,
      location_id: locationId,
      location,
      title: text(scene.title, `${path}.scene.title`, TEXT_LIMITS.name),
      mood: text(scene.mood, `${path}.scene.mood`, TEXT_LIMITS.short),
      objective: text(scene.objective, `${path}.scene.objective`, TEXT_LIMITS.short),
      theme: text(scene.theme, `${path}.scene.theme`, TEXT_LIMITS.short),
      danger,
      map: clone(sceneMap),
    },
    hook: text(source.hook, `${path}.hook`, TEXT_LIMITS.short),
    npcs: normalizedNpcs,
  }
}

function validateGraph(worldMap, startId, path) {
  const adjacency = new Map(worldMap.locations.map((location) => [location.id, new Set()]))
  for (const route of worldMap.routes) {
    adjacency.get(route.from).add(route.to)
    adjacency.get(route.to).add(route.from)
  }
  const seen = new Set([startId])
  const queue = [startId]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  if (seen.size !== worldMap.locations.length) {
    const missing = worldMap.locations.filter((location) => !seen.has(location.id)).map((location) => location.id).join(', ')
    throw new WorldTemplateCatalogError(`${path} не связана со стартовой точкой; недостижимы: ${missing}`)
  }
}

function validateTemplate(raw, index) {
  const metadata = validateMetadata(raw, index)
  const source = metadata.template
  const path = `templates[${index}]`
  const rawMap = field(source, 'world_map', 'worldMap')
  const worldMap = validateWorldMap(rawMap, `${path}.world_map`)
  const rawOpening = object(source.opening, `${path}.opening`)
  const rawOpeningScene = object(rawOpening.scene, `${path}.opening.scene`)
  const openingLocation = field(rawOpeningScene, 'location', 'location_name')
  const world = validateWorld(field(source, 'world', 'world_concept') ?? {}, `${path}.world`, openingLocation)
  const opening = validateOpening(source.opening, `${path}.opening`, worldMap, {
    campaignName: metadata.name,
    worldSummary: field(source, 'worldSummary', 'world_summary') ?? world.worldSummary ?? metadata.description,
    worldHistory: field(source, 'worldHistory', 'world_history') ?? world.worldHistory ?? metadata.description,
  })
  const overviewLocations = worldMap.locations.filter((location) => location.cityOverview)
  if (overviewLocations.length !== 1 || overviewLocations[0].id !== opening.scene.locationId) {
    throw new WorldTemplateCatalogError(`${path}.world_map должен содержать один городской план только у стартовой точки`)
  }
  if (world.startingLocation !== opening.scene.location) throw new WorldTemplateCatalogError(`${path}.world.startingLocation не совпадает со стартовой сценой`)
  const histories = worldMap.locations.map((location) => ({
    id: location.id,
    locationId: location.id,
    title: location.name,
    summary: location.history,
  }))
  const storyHooks = worldMap.locations.flatMap((location) => location.storyHooks.map((hook, hookIndex) => ({
    id: `${location.id}-hook-${hookIndex + 1}`,
    locationId: location.id,
    title: location.name,
    summary: hook,
  })))
  const timeline = validateRichCollection(source.timeline, `${path}.timeline`)
  const factions = validateRichCollection(source.factions, `${path}.factions`, true)
  const storyArcs = validateRichCollection(field(source, 'story_arcs', 'storyArcs'), `${path}.story_arcs`)
  return {
    ...clone(source),
    id: metadata.templateId,
    version: metadata.version,
    name: metadata.name,
    tagline: metadata.tagline,
    description: metadata.description,
    image: metadata.image,
    imageAlt: metadata.imageAlt,
    image_alt: metadata.imageAlt,
    accent: metadata.accent,
    focus: clone(metadata.focus),
    recommendedLevels: clone(metadata.recommendedLevels),
    recommended_levels: clone(metadata.recommendedLevels),
    world,
    world_map: worldMap,
    opening,
    histories,
    storyHooks,
    timeline,
    factions,
    story_arcs: storyArcs,
  }
}

function loadCatalog() {
  let payload
  try {
    payload = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
  } catch (error) {
    throw new WorldTemplateCatalogError(`Не удалось загрузить каталог миров: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = object(payload, 'catalog')
  if (root.schema_version !== WORLD_TEMPLATE_SCHEMA_VERSION) throw new WorldTemplateCatalogError(`catalog.schema_version должен быть ${WORLD_TEMPLATE_SCHEMA_VERSION}`)
  validateRichCollection(root.inspiration_sources, 'catalog.inspiration_sources')
  const templates = array(root.templates, 'catalog.templates', WORLD_TEMPLATE_COUNT)
  if (templates.length !== WORLD_TEMPLATE_COUNT) throw new WorldTemplateCatalogError(`Каталог должен содержать ровно ${WORLD_TEMPLATE_COUNT} шаблона`)
  const seen = new Set()
  const normalized = templates.map((entry, index) => {
    const template = validateTemplate(entry, index)
    if (seen.has(template.id)) throw new WorldTemplateCatalogError(`Каталог содержит повторяющийся template id «${template.id}»`)
    seen.add(template.id)
    validateGraph(template.world_map, template.opening.scene.locationId, `templates[${index}].world_map`)
    return template
  })
  return Object.freeze(normalized)
}

const WORLD_TEMPLATES = loadCatalog()
const WORLD_TEMPLATES_BY_ID = new Map(WORLD_TEMPLATES.map((template) => [template.id, template]))

function templateFor(value) {
  const requested = typeof value === 'string' ? value : value?.id
  const key = String(requested ?? '').trim()
  const template = WORLD_TEMPLATES_BY_ID.get(key)
  if (!template) throw new WorldTemplateCatalogError(`Неизвестный шаблон мира «${key || '(пусто)'}»`)
  return template
}

function historyTeaser(template) {
  const explicit = field(template, 'historyTeaser', 'history_teaser')
  if (explicit) return text(explicit, 'historyTeaser', 360)
  const first = template.histories[0]
  return richTextFor(first, 'histories[0]').slice(0, 360)
}

function versionLabel(value) {
  return typeof value === 'number' ? `${value}.0.0` : String(value)
}

function publicPreview(template) {
  const settlements = template.world_map.locations.filter((location) => SETTLEMENT_KINDS.has(location.kind))
  const cityNames = settlements.map((location) => location.name).slice(0, 24)
  const mapCounts = {
    regions: template.world_map.regions.length,
    locations: template.world_map.locations.length,
    routes: template.world_map.routes.length,
    settlements: settlements.length,
  }
  return {
    id: template.id,
    version: versionLabel(template.version),
    name: template.name,
    tagline: template.tagline,
    description: template.description.slice(0, TEXT_LIMITS.description),
    image: template.image,
    imageAlt: template.imageAlt,
    accent: template.accent,
    focus: clone(template.focus),
    recommendedLevels: clone(template.recommendedLevels),
    world: {
      era: template.world.era,
      genre: template.world.genre,
      tone: template.world.tone,
      themes: clone(template.world.themes),
      startingLocation: template.world.startingLocation,
    },
    cities: cityNames,
    cityNames,
    cityCount: settlements.length,
    regionCount: mapCounts.regions,
    locationCount: mapCounts.locations,
    routeCount: mapCounts.routes,
    mapCounts,
    historyTeaser: historyTeaser(template),
    cityOverviewCount: template.world_map.locations.filter((location) => location.cityOverview).length,
  }
}

export function listWorldTemplates() {
  return clone(WORLD_TEMPLATES.map(publicPreview))
}

export function getWorldTemplate(idValue) {
  return clone(templateFor(idValue))
}

/**
 * @param {unknown} templateValue
 * @param {{campaignName?: string, partyName?: string, campaign?: string, party?: string}} [overrides]
 */
export function worldTemplateOpening(templateValue, overrides = {}) {
  const template = templateFor(templateValue)
  const opening = template.opening
  const campaignOverride = optionalText(overrides.campaignName ?? overrides.campaign, 'campaignName', TEXT_LIMITS.name)
  const partyOverride = optionalText(overrides.partyName ?? overrides.party, 'partyName', TEXT_LIMITS.name)
  // Эти два значения — placeholders самого CampaignBootstrapper. Они не
  // должны затереть название выбранного авторского мира, когда владелец оставил
  // поля пустыми и bootstrap передал сюда уже нормализованные defaults.
  const campaignName = campaignOverride && campaignOverride !== 'Новая кампания'
    ? campaignOverride : opening.campaignName || template.name
  const partyName = partyOverride && partyOverride !== 'Новый отряд'
    ? partyOverride : opening.partyName || 'Новый отряд'
  const scene = clone(opening.scene)
  scene.locationId = template.world_map.locations.find((location) => location.id === scene.locationId)?.id ?? scene.locationId
  scene.location_id = scene.locationId
  scene.location = template.world_map.locations.find((location) => location.id === scene.locationId)?.name ?? scene.location
  return {
    campaignName,
    partyName,
    worldSummary: opening.worldSummary,
    worldHistory: opening.worldHistory,
    worldMap: clone(template.world_map),
    openingNarration: opening.openingNarration,
    scene,
    hook: opening.hook,
    npcs: clone(opening.npcs),
  }
}

export function worldTemplateConcept(templateValue) {
  const template = templateFor(templateValue)
  const opening = worldTemplateOpening(template)
  return {
    ...clone(template.world),
    worldSummary: opening.worldSummary,
    worldHistory: opening.worldHistory,
    world_template_id: template.id,
    world_template_version: versionLabel(template.version),
    template: {
      id: template.id,
      version: versionLabel(template.version),
      name: template.name,
      tagline: template.tagline,
      description: template.description,
      image: template.image,
      imageAlt: template.imageAlt,
      accent: template.accent,
      focus: template.focus,
      recommendedLevels: clone(template.recommendedLevels),
    },
    histories: clone(template.histories),
    storyHooks: clone(template.storyHooks),
    timeline: clone(template.timeline),
    factions: clone(template.factions),
    story_arcs: clone(template.story_arcs),
  }
}

export { WORLD_TEMPLATE_COUNT }
