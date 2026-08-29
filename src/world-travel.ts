import type { GameState, WorldMapLocation, WorldMapRoute, WorldMapState } from './types'

/**
 * Путь по карте мира — общая часть глобальной карты (`WorldMapView`) и
 * выбора пункта назначения на доске (`DungeonMap`, «Покинуть локацию»).
 *
 * Формат предложения — договор с сервером, а не проза: `detectPartyExitRequest`
 * (`server/party-exit-intent.mjs`) читает маркер `[ГЛОБАЛЬНАЯ КАРТА]` и берёт
 * из кавычек первое место как исходное, а второе — как пункт назначения.
 * Сторож на обе стороны — `test/party-exit-intent.test.mjs`.
 */

export const KIND_LABELS: Record<WorldMapLocation['kind'], string> = {
  capital: 'Столица', city: 'Город', town: 'Городок', village: 'Поселение', port: 'Порт', fortress: 'Крепость',
  ruin: 'Руины', dungeon: 'Подземелье', landmark: 'Ориентир', wilds: 'Дикая местность',
}

export const ROUTE_LABELS: Record<WorldMapRoute['kind'], string> = {
  road: 'тракт', trail: 'тропа', river: 'река', sea: 'морской путь', pass: 'перевал',
}

export type WorldRouteSelection = { locationIds: string[]; routes: WorldMapRoute[] }

/** Кратчайший по числу переходов путь по открытым маршрутам. */
export function shortestRoute(start: string, target: string, routes: WorldMapRoute[]): WorldRouteSelection {
  if (!start || !target || start === target) return { locationIds: start ? [start] : [], routes: [] }
  const queue = [start]
  const previous = new Map<string, { locationId: string; route: WorldMapRoute } | null>([[start, null]])
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    if (current === target) break
    for (const route of routes.filter((candidate) => candidate.discovered && (candidate.from === current || candidate.to === current))) {
      const next = route.from === current ? route.to : route.from
      if (previous.has(next)) continue
      previous.set(next, { locationId: current, route })
      queue.push(next)
    }
  }
  if (!previous.has(target)) return { locationIds: [], routes: [] }
  const locationIds = [target]
  const selectedRoutes: WorldMapRoute[] = []
  for (let current = target; current !== start;) {
    const step = previous.get(current)
    if (!step) break
    selectedRoutes.unshift(step.route)
    locationIds.unshift(step.locationId)
    current = step.locationId
  }
  return { locationIds, routes: selectedRoutes }
}

/** Точка карты, где стоит отряд: по идентификатору, иначе по названию сцены. */
export function currentWorldLocation(state: Pick<GameState, 'scene' | 'worldMap'>): WorldMapLocation | null {
  const map = state.worldMap
  if (!map) return null
  const byId = map.locations.find((location) => location.id === map.currentLocationId)
  if (byId) return byId
  const sceneName = String(state.scene.location ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru')
  const known = map.locations.filter((location) => location.known || location.visited)
  return known.find((location) => location.name.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru') === sceneName)
    ?? null
}

export type TravelDestination = {
  location: WorldMapLocation
  routeNames: string[]
  days: number
  danger: WorldMapRoute['danger']
}

/**
 * Куда отсюда можно дойти по открытым путям. Сначала непосещённые, затем
 * ближние: это тот же порядок, в котором сервер подбирает пункт назначения,
 * когда отряд уходит, никого не назвав (`knownDestinationsFrom`,
 * `server/scene-architect.mjs`).
 */
export function reachableDestinations(state: Pick<GameState, 'scene' | 'worldMap'>, limit = 6): TravelDestination[] {
  const map = state.worldMap
  const current = currentWorldLocation(state)
  if (!map || !current) return []
  const known = map.locations.filter((location) => location.known || location.visited)
  const byId = new Map(known.map((location) => [location.id, location]))
  const destinations: TravelDestination[] = []
  for (const location of known) {
    if (location.id === current.id) continue
    const route = shortestRoute(current.id, location.id, map.routes)
    if (!route.routes.length) continue
    destinations.push({
      location,
      routeNames: route.locationIds.map((id) => byId.get(id)?.name ?? '').filter(Boolean),
      days: route.routes.reduce((sum, item) => sum + item.distance, 0),
      danger: routeDanger(route.routes),
    })
  }
  return destinations
    .sort((left, right) => Number(left.location.visited) - Number(right.location.visited)
      || left.routeNames.length - right.routeNames.length
      || left.days - right.days
      || left.location.name.localeCompare(right.location.name, 'ru'))
    .slice(0, limit)
}

/**
 * Соседи для быстрого выхода с тактической доски. Дальние точки остаются на
 * глобальной карте: там игрок видит весь маршрут и осознанно выбирает несколько
 * сегментов, а здесь один клик означает ровно один открытый путь.
 */
export function neighboringDestinations(state: Pick<GameState, 'scene' | 'worldMap'>, limit = 8): TravelDestination[] {
  const map = state.worldMap
  const current = currentWorldLocation(state)
  if (!map || !current) return []
  const known = map.locations.filter((location) => location.known || location.visited || location.id === current.id)
  const byId = new Map(known.map((location) => [location.id, location]))
  const destinations = new Map<string, TravelDestination>()
  for (const route of map.routes) {
    if (route.discovered === false) continue
    const otherId = route.from === current.id ? route.to : route.to === current.id ? route.from : ''
    const location = otherId ? byId.get(otherId) : undefined
    if (!location || destinations.has(location.id)) continue
    destinations.set(location.id, {
      location,
      routeNames: [current.name, location.name],
      days: Math.max(1, Number(route.distance) || 1),
      danger: ['низкая', 'средняя', 'высокая'].includes(route.danger) ? route.danger : 'средняя',
    })
  }
  return [...destinations.values()]
    .sort((left, right) => Number(left.location.visited) - Number(right.location.visited)
      || left.days - right.days
      || left.location.name.localeCompare(right.location.name, 'ru'))
    .slice(0, limit)
}

export function routeDanger(routes: WorldMapRoute[]): WorldMapRoute['danger'] {
  if (routes.some((item) => item.danger === 'высокая')) return 'высокая'
  if (routes.some((item) => item.danger === 'средняя')) return 'средняя'
  return 'низкая'
}

/** Предложение маршрута в формате, который понимает сервер. */
export function travelProposalText(current: WorldMapLocation, selected: WorldMapLocation, routeNames: string[]) {
  return `[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «${current.name}» в «${selected.name}». Выбранный путь: ${routeNames.join(' → ')}.`
}

export function worldMapHasRoutes(map: WorldMapState | undefined): boolean {
  return Boolean(map && map.routes.some((route) => route.discovered))
}
