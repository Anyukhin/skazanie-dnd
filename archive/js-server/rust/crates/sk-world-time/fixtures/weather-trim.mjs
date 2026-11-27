// Урезание состояния кампании до полей, которые читает `server/weather.mjs`.
//
// Состояния корпуса паритета весят мегабайты; погоде из них нужны часы,
// закрепления неба, карта мира (сид, текущее место, края), позиции героев и
// сцена (название, тема, вид, тактическая карта с зонами). Генератор эталона
// проверяет, что на урезанном состоянии исход каждой функции тот же, что на
// полном, — урезание не меняет ответа.

const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key]
  return out
}

const actorTrim = (actor) => pickKeys(actor, ['id', 'actor_id', 'x', 'y'])

/** Карта сцены: богатая (зоны и слои) — целиком, иначе только тема. */
function mapTrim(map) {
  if (!map || typeof map !== 'object') return map
  if (Array.isArray(map.zones) && map.layers) return map
  return pickKeys(map, ['theme'])
}

export function trimState(state) {
  if (!state || typeof state !== 'object') return state
  const out = pickKeys(state, ['sessionCode', 'activePlayerId'])
  for (const key of ['players', 'actors', 'enemies']) {
    if (Object.hasOwn(state, key)) out[key] = Array.isArray(state[key]) ? state[key].map(actorTrim) : state[key]
  }
  if (Object.hasOwn(state, 'worldMap')) {
    const map = state.worldMap
    out.worldMap = map && typeof map === 'object' && !Array.isArray(map)
      ? {
          ...pickKeys(map, ['seed', 'currentLocationId']),
          ...(Object.hasOwn(map, 'regions') ? { regions: Array.isArray(map.regions) ? map.regions.map((region) => pickKeys(region, ['id', 'name', 'biome'])) : map.regions } : {}),
          ...(Object.hasOwn(map, 'locations') ? { locations: Array.isArray(map.locations) ? map.locations.map((location) => pickKeys(location, ['id', 'regionId'])) : map.locations } : {}),
        }
      : map
  }
  if (Object.hasOwn(state, 'mechanics')) {
    const mechanics = state.mechanics
    out.mechanics = mechanics && typeof mechanics === 'object' && !Array.isArray(mechanics)
      ? pickKeys(mechanics, ['world_time', 'weather_pins', 'positions'])
      : mechanics
    if (out.mechanics?.world_time && typeof out.mechanics.world_time === 'object') {
      out.mechanics.world_time = pickKeys(out.mechanics.world_time, ['elapsed_minutes'])
    }
  }
  if (Object.hasOwn(state, 'scene')) {
    const scene = state.scene
    out.scene = scene && typeof scene === 'object' && !Array.isArray(scene)
      ? { ...pickKeys(scene, ['location', 'theme', 'scene_kind']), ...(Object.hasOwn(scene, 'map') ? { map: mapTrim(scene.map) } : {}) }
      : scene
  }
  return out
}
