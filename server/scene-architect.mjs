import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { publicAdventureMemory } from './adventure-director.mjs'
import { classifyPartyDecision } from './party-exit-intent.mjs'
import { normalizeDeclaredLevels } from './level-generator.mjs'
import { defaultSceneShopIntent, normalizeSceneShopIntent } from './scene-commerce.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { worldLocationById } from './world-map.mjs'

/**
 * Один идентификатор роли на код и на новые трассы. Прежнее имя
 * `AgentCartographer` остаётся в уже сохранённых трассах и читается
 * совместимо: переписывать историю без миграции нельзя (шаг 8 плана,
 * `docs/agent-architecture-plan.md`).
 */
export const SCENE_ARCHITECT_AGENT_ID = 'scene_architect'
export const LEGACY_SCENE_ARCHITECT_AGENT_ID = 'AgentCartographer'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/map_architect/v5.txt', import.meta.url)), 'utf8')

function clean(value, maximum = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

const MAP_SCALES = new Set(['room', 'site', 'stronghold', 'region'])
const MAP_PATTERNS = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])
const MAP_MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])

function scaleDimensions(scale) {
  if (scale === 'room') return { width: 9, height: 7, minimumWidth: 7, minimumHeight: 7 }
  if (scale === 'stronghold') return { width: 23, height: 17, minimumWidth: 19, minimumHeight: 13 }
  if (scale === 'region') return { width: 25, height: 19, minimumWidth: 21, minimumHeight: 15 }
  return { width: 15, height: 11, minimumWidth: 11, minimumHeight: 9 }
}

/** Builds a data-only, public context for the external Scene Architect. */
export function buildDirectorPlanningBrief(state = {}) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {}
  const scene = source.scene && typeof source.scene === 'object' && !Array.isArray(source.scene) ? source.scene : {}
  const currentScene = {
    title: clean(scene.title, 80),
    location: clean(scene.location, 120),
    mood: clean(scene.mood, 160),
    objective: clean(scene.objective, 160),
    turn: clampInteger(scene.turn, 0, 0, 1_000_000),
    ...(typeof scene.theme === 'string' ? { theme: clean(scene.theme, 80) } : {}),
    ...(['низкая', 'средняя', 'высокая'].includes(scene.danger) ? { danger: scene.danger } : {}),
    ...(['settlement', 'wilderness', 'dungeon', 'road', 'other'].includes(scene.scene_kind) ? { scene_kind: scene.scene_kind } : {}),
    ...(['village', 'town', 'city', 'outpost', 'traveling'].includes(scene.settlement_type) ? { settlement_type: scene.settlement_type } : {}),
  }
  return {
    current_scene: currentScene,
    adventure_memory: publicAdventureMemory(source.adventure),
    campaign_premise: campaignConceptForAgent(source),
    heroes: (source.players ?? []).map((hero) => ({
      id: clean(hero?.id, 40),
      name: clean(hero?.character ?? hero?.name, 80),
      role: clean(hero?.role, 100),
      species: clean(hero?.species, 80),
      background: clean(hero?.background, 100),
      backstory: clean(hero?.backstory, 400),
      traits: clean(hero?.traits, 200),
    })).slice(0, 12),
    visible_enemies: (source.enemies ?? []).filter((enemy) => enemy?.alive !== false).map((enemy) => ({
      id: clean(enemy?.id, 40),
      name: clean(enemy?.name, 80),
      kind: clean(enemy?.kind ?? enemy?.type, 80),
    })).slice(0, 16),
    // Соседи по карте мира: картограф обязан знать, куда отсюда ведут дороги,
    // иначе отряд, ушедший «куда-нибудь», раз за разом выходил на выдуманную
    // дорогу, а Вейр и Чащоба Рун оставались точками на карте.
    known_destinations: knownDestinationsFrom(source).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      days: entry.days,
      danger: entry.danger,
      visited: entry.visited,
    })),
  }
}

function selectedDecision(action, state = {}) {
  const interaction = state.agentInteraction ?? {}
  const option = Array.isArray(interaction.options)
    ? interaction.options.find((candidate) => candidate?.id === interaction.resolvedOptionId)
    : null
  return clean(option?.label || action, 500)
}

/**
 * Разбор подтверждённого решения группы. Словарь ухода живёт в
 * `server/party-exit-intent.mjs` — том же, по которому Режиссёр решал, предлагать
 * ли это голосование. Два независимых списка расходились, и вариант, за который
 * отряд уже проголосовал, мог не опознаться как уход.
 */
export function interpretResolvedPartyDecision(action, state = {}) {
  const text = clean(action, 2000).normalize('NFKC')
  if (!/^\[РЕШЕНИЕ ГРУППЫ\]/iu.test(text)) return null
  const decision = selectedDecision(text, state)
  const classified = classifyPartyDecision(decision)
  if (classified.kind === 'move') {
    const destinationLocationId = clean(
      state.agentInteraction?.destinationLocationId ?? state.agentInteraction?.destination_location_id,
      120,
    )
    return {
      kind: 'move',
      decision,
      destinationHint: classified.destinationHint,
      abandonsQuest: classified.abandonsQuest,
      ...(destinationLocationId ? { destinationLocationId } : {}),
    }
  }
  return { kind: classified.kind, decision, abandonsQuest: classified.abandonsQuest }
}

function themeFor(destination, action) {
  const destinationValue = String(destination ?? '').toLocaleLowerCase('ru')
  const hasExplicitDestinationKind = /крепост|замок|цитадел|дом|хижин|комнат|кабинет|зал|камор|спальн|таверн|город|деревн|порт|рынок|улиц|лес|чащ|болот|роща|мост|тракт|дорог|путь|перевал|руин|развал|храм|пещер|подзем|склеп|архив|шахт|арен|круг|кольц|башн/u.test(destinationValue)
  // The explicit destination must win over the source location mentioned in
  // a resolved vote (for example, "leave the city and go to the forest").
  const value = hasExplicitDestinationKind
    ? destinationValue
    : `${destinationValue} ${String(action ?? '').toLocaleLowerCase('ru')}`
  if (/крепост|замок|цитадел/u.test(value)) return { theme: 'крепость', layout: 'rooms', scale: 'stronghold', pattern: 'keep', material: 'stone', width: 23, height: 17, openness: 0.62, water: 0.02, featureCount: 10, danger: 'высокая' }
  if (/дом|хижин|комнат|кабинет|небольш.*зал|камор|спальн|таверн/u.test(value)) return { theme: /таверн/u.test(value) ? 'уютная таверна' : 'жилой дом', layout: 'rooms', scale: 'room', pattern: 'small-room', material: 'wood', width: 9, height: 7, openness: 0.82, water: 0, featureCount: 9, danger: 'низкая' }
  if (/город|деревн|порт|рынок|таверн|улиц/u.test(value)) return { theme: 'городские улицы', layout: 'streets', scale: 'site', pattern: 'village', material: 'stone', width: 17, height: 11, openness: 0.68, water: /порт|канал/u.test(value) ? 0.12 : 0.02, featureCount: 7, danger: 'низкая' }
  if (/лес|чащ|болот|роща/u.test(value)) return { theme: 'дикая местность', layout: 'winding', scale: 'site', pattern: 'natural', material: 'grass', width: 15, height: 11, openness: 0.62, water: /болот/u.test(value) ? 0.22 : 0.06, featureCount: 10, danger: 'средняя' }
  if (/мост/u.test(value)) return { theme: 'мост и подступы', layout: 'winding', scale: 'site', pattern: 'bridge', material: 'wood', width: 17, height: 9, openness: 0.7, water: 0.2, featureCount: 5, danger: 'средняя' }
  if (/тракт|дорог|путь|перевал/u.test(value)) return { theme: 'дорога', layout: 'winding', scale: 'site', pattern: 'natural', material: 'earth', width: 15, height: 9, openness: 0.58, water: 0.03, featureCount: 5, danger: 'средняя' }
  if (/руин|развал|храм/u.test(value)) return { theme: 'древние руины', layout: 'ruins', scale: 'site', pattern: 'courtyard', material: /храм/u.test(value) ? 'marble' : 'stone', width: 15, height: 11, openness: 0.58, water: 0.05, featureCount: 6, danger: 'средняя' }
  if (/пещер|подзем|склеп|архив|шахт/u.test(value)) return { theme: /склеп/u.test(value) ? 'древний склеп' : 'подземные пещеры', layout: 'cavern', scale: 'site', pattern: /склеп|архив/u.test(value) ? 'crypt' : 'cave-cluster', material: 'earth', width: 15, height: 11, openness: 0.62, water: 0.08, featureCount: 10, danger: 'средняя' }
  if (/арен|круг|кольц|башн/u.test(value)) return { theme: 'радиальная локация', layout: 'radial', scale: 'site', pattern: 'great-hall', material: 'stone', width: 15, height: 15, openness: 0.58, water: 0.02, featureCount: 6, danger: 'средняя' }
  return { theme: 'новая местность', layout: 'open', scale: 'site', pattern: 'natural', material: 'earth', width: 15, height: 11, openness: 0.64, water: 0.05, featureCount: 5, danger: 'средняя' }
}

/**
 * Заявка картографа по виду точки карты мира. Когда отряд идёт в известное
 * место, его вид знает карта, а не слова в названии: «Мормар» — порт, и
 * рисовать его надо улицами, а не полем.
 *
 * @param {string} kind
 * @returns {ReturnType<typeof themeFor>|null}
 */
function themeForWorldKind(kind) {
  switch (String(kind ?? '')) {
    case 'capital':
    case 'city':
    case 'town':
    case 'village':
    case 'port':
      return { theme: kind === 'village' ? 'деревенские улицы' : 'городские улицы', layout: 'streets', scale: 'site', pattern: 'village', material: 'stone', width: 17, height: 11, openness: 0.68, water: kind === 'port' ? 0.12 : 0.02, featureCount: 7, danger: 'низкая' }
    case 'wilds':
      return { theme: 'дикая местность', layout: 'winding', scale: 'site', pattern: 'natural', material: 'grass', width: 15, height: 11, openness: 0.62, water: 0.06, featureCount: 10, danger: 'средняя' }
    case 'fortress':
      return { theme: 'крепость', layout: 'rooms', scale: 'stronghold', pattern: 'keep', material: 'stone', width: 23, height: 17, openness: 0.62, water: 0.02, featureCount: 10, danger: 'высокая' }
    case 'ruin':
      return { theme: 'древние руины', layout: 'ruins', scale: 'site', pattern: 'courtyard', material: 'stone', width: 15, height: 11, openness: 0.58, water: 0.05, featureCount: 6, danger: 'средняя' }
    case 'dungeon':
      return { theme: 'подземные пещеры', layout: 'cavern', scale: 'site', pattern: 'cave-cluster', material: 'earth', width: 15, height: 11, openness: 0.62, water: 0.08, featureCount: 10, danger: 'средняя' }
    default:
      return null
  }
}

/**
 * География известной точки иногда важнее её общего `kind=landmark`: озеро,
 * берег и горный кряж не должны сводиться к сухому процедурному лесу.
 * Возвращается только bounded заявка уже существующих генераторов; числа
 * правил и состояние мира здесь не вычисляются.
 *
 * @param {{name?: string, kind?: string, summary?: string, history?: string, biome?: string}|null} destination
 * @returns {ReturnType<typeof themeFor>|null}
 */
function themeForWorldDescription(destination) {
  if (!destination) return null
  const value = `${destination.name ?? ''} ${destination.summary ?? ''} ${destination.history ?? ''} ${destination.biome ?? ''}`.toLocaleLowerCase('ru')
  if (/озер|водо[её]м|пруд|залив/iu.test(value)) {
    return { theme: 'озеро и отмели', layout: 'open', scale: 'site', pattern: 'natural', material: 'grass', width: 17, height: 11, openness: 0.55, water: 0.72, featureCount: 8, danger: 'средняя' }
  }
  if (/река|слияни[ея]\s+рек|берег|отмел|переправ|пристан|гаван|побереж/iu.test(value)) {
    return { theme: 'берег реки', layout: 'winding', scale: 'site', pattern: 'bridge', material: 'earth', width: 17, height: 11, openness: 0.62, water: 0.42, featureCount: 7, danger: 'средняя' }
  }
  if (/горн|кряж|пик|скал|перевал|ущел/iu.test(value) || destination.biome === 'mountains') {
    return { theme: 'горный рубеж', layout: 'winding', scale: 'site', pattern: 'bridge', material: 'earth', width: 17, height: 11, openness: 0.55, water: 0.02, featureCount: 7, danger: 'высокая' }
  }
  if (/лес|чащ|рощ|дубрав|пущ|wild/iu.test(value) || destination.biome === 'forest') {
    return { theme: 'лесная окраина', layout: 'open', scale: 'site', pattern: 'natural', material: 'grass', width: 15, height: 11, openness: 0.62, water: 0.04, featureCount: 9, danger: 'средняя' }
  }
  if (/крепост|замок|цитадел|твердын|fortress/iu.test(value) || destination.kind === 'fortress') {
    return { theme: 'каменная крепость', layout: 'rooms', scale: 'stronghold', pattern: 'keep', material: 'stone', width: 23, height: 17, openness: 0.62, water: 0.02, featureCount: 10, danger: 'высокая' }
  }
  return null
}

/**
 * Известные места, куда из текущей точки ведёт открытый путь. Это то, что
 * видит игрок на глобальной карте, — и то, что картограф обязан учитывать:
 * отряд, уходящий «куда-нибудь», скорее выйдет к соседней деревне, чем к
 * «окрестностям окрестностей».
 *
 * Порядок — сначала непосещённые, затем ближние. Маршрут считается по одному
 * сегменту: многодневные переходы через несколько точек планирует карта мира.
 *
 * @param {Record<string, any>} [state]
 * @returns {Array<{id: string, name: string, kind: string, days: number, danger: string, visited: boolean}>}
 */
export function knownDestinationsFrom(state = {}) {
  const map = state?.worldMap
  if (!map || typeof map !== 'object' || !Array.isArray(map.locations)) return []
  const byId = new Map(map.locations.filter((location) => location?.id).map((location) => [String(location.id), location]))
  const sceneLocation = clean(state?.scene?.location, 120).toLocaleLowerCase('ru')
  const current = byId.get(String(map.currentLocationId ?? ''))
    ?? map.locations.find((location) => clean(location?.name, 120).toLocaleLowerCase('ru') === sceneLocation)
  if (!current) return []
  const reachable = []
  for (const route of Array.isArray(map.routes) ? map.routes : []) {
    if (!route || route.discovered === false) continue
    const otherId = String(route.from) === String(current.id) ? String(route.to)
      : String(route.to) === String(current.id) ? String(route.from) : ''
    const other = otherId ? byId.get(otherId) : null
    if (!other || other.known === false || reachable.some((entry) => entry.id === other.id)) continue
    reachable.push({
      id: String(other.id),
      name: clean(other.name, 120),
      kind: clean(other.kind, 40) || 'landmark',
      days: Math.max(1, Number(route.distance) || 1),
      danger: ['низкая', 'средняя', 'высокая'].includes(route.danger) ? route.danger : 'средняя',
      visited: other.visited === true,
    })
  }
  return reachable
    .filter((entry) => entry.name)
    .sort((left, right) => Number(left.visited) - Number(right.visited) || left.days - right.days || left.name.localeCompare(right.name, 'ru'))
    .slice(0, 8)
}

/** Известная точка карты по каноническому имени, включая дальний маршрут. */
function knownWorldDestinationByName(state, name) {
  const key = locationKey(name)
  if (!key || !Array.isArray(state?.worldMap?.locations)) return null
  const location = state.worldMap.locations.find((entry) => (
    entry?.id && entry.known !== false && locationKey(entry.name) === key
  ))
  if (!location) return null
  const region = Array.isArray(state?.worldMap?.regions)
    ? state.worldMap.regions.find((candidate) => String(candidate?.id ?? '') === String(location.regionId ?? location.region_id ?? ''))
    : null
  return {
    id: String(location.id),
    name: clean(location.name, 120),
    kind: clean(location.kind, 40) || 'landmark',
    summary: clean(location.summary, 500),
    history: clean(location.history, 700),
    biome: clean(region?.biome, 40),
  }
}

/** Известная точка карты по авторитетному идентификатору. */
function knownWorldDestinationById(state, locationId) {
  const location = worldLocationById(state?.worldMap, clean(locationId, 120))
  if (!location?.id || location.known === false) return null
  const region = Array.isArray(state?.worldMap?.regions)
    ? state.worldMap.regions.find((candidate) => String(candidate?.id ?? '') === String(location.regionId ?? location.region_id ?? ''))
    : null
  return {
    id: String(location.id),
    name: clean(location.name, 120),
    kind: clean(location.kind, 40) || 'landmark',
    summary: clean(location.summary, 500),
    history: clean(location.history, 700),
    biome: clean(region?.biome, 40),
  }
}

/** Кратчайший по числу открытых сегментов путь до известной точки. */
function knownWorldRouteTo(state, target) {
  const map = state?.worldMap
  if (!map || !Array.isArray(map.locations) || !Array.isArray(map.routes) || !target?.id) return []
  const byId = new Map(map.locations.filter((entry) => entry?.id).map((entry) => [String(entry.id), entry]))
  const sceneLocation = locationKey(state?.scene?.location)
  const current = byId.get(String(map.currentLocationId ?? ''))
    ?? map.locations.find((entry) => locationKey(entry?.name) === sceneLocation)
  if (!current?.id) return []
  const startId = String(current.id)
  const targetId = String(target.id)
  const queue = [startId]
  const previous = new Map([[startId, null]])
  for (let cursor = 0; cursor < queue.length && !previous.has(targetId); cursor += 1) {
    const currentId = queue[cursor]
    for (const route of map.routes) {
      if (!route || route.discovered === false) continue
      const nextId = String(route.from) === currentId ? String(route.to)
        : String(route.to) === currentId ? String(route.from) : ''
      const next = nextId ? byId.get(nextId) : null
      if (!next || next.known === false || previous.has(nextId)) continue
      previous.set(nextId, currentId)
      queue.push(nextId)
    }
  }
  if (!previous.has(targetId)) return []
  const ids = [targetId]
  for (let currentId = targetId; currentId !== startId;) {
    const parent = previous.get(currentId)
    if (!parent) return []
    ids.unshift(parent)
    currentId = parent
  }
  return ids.map((id) => {
    const entry = byId.get(id)
    return {
      id,
      name: clean(entry?.name, 120),
      kind: clean(entry?.kind, 40) || 'landmark',
      summary: clean(entry?.summary, 500),
      history: clean(entry?.history, 700),
      biome: clean(byId.get(id)?.regionId ? map.regions?.find((region) => String(region?.id ?? '') === String(byId.get(id)?.regionId))?.biome : '', 40),
    }
  })
}

/**
 * Куда идёт отряд, когда места не назвал никто. Раньше это были «Окрестности
 * X», а после второго ухода — «Окрестности Окрестности X»: карта мира с
 * соседними деревнями и руинами при этом стояла без дела.
 *
 * @param {Record<string, any>} state
 * @param {string} from
 * @returns {{name: string, kind: string}}
 */
function fallbackDestination(state, from) {
  const [known] = knownDestinationsFrom(state)
  if (known) return { name: known.name, kind: known.kind }
  const base = from.replace(/^(?:окрестности|тракт за|дальние земли за)\s+/iu, '').trim() || from
  if (/^окрестности\s/iu.test(from)) return { name: `Тракт за ${base}`, kind: 'landmark' }
  if (/^тракт за\s/iu.test(from)) return { name: `Дальние земли за ${base}`, kind: 'landmark' }
  return { name: `Окрестности ${from}`, kind: 'landmark' }
}

function fallbackPlan({ action, state, decision, destinationHint, destinationLocationId = '', abandonsQuest = false }) {
  const from = clean(state.scene?.location || state.scene?.title, 120) || 'прежняя локация'
  const hinted = clean(destinationHint, 120)
  const destinationById = knownWorldDestinationById(state, destinationLocationId)
  const chosen = hinted || destinationById ? null : fallbackDestination(state, from)
  const intendedKnownDestination = destinationById ?? (hinted ? knownWorldDestinationByName(state, hinted) : null)
  const route = intendedKnownDestination ? knownWorldRouteTo(state, intendedKnownDestination) : []
  // Многосегментный путь исполняется по одному ребру за сцену. Иначе переход
  // сразу в конечную точку заставлял reconcileWorldMap дорисовать ложную прямую
  // дорогу поверх выбранного маршрута. Если известная точка пока недостижима,
  // создаётся промежуточный тракт к ней, а не телепорт через закрытую карту.
  const routedDestination = route.length > 1 ? route[1] : route.length === 1 ? route[0] : null
  const unreachableKnownDestination = Boolean(intendedKnownDestination && !route.length)
  const destination = routedDestination?.name
    || (unreachableKnownDestination ? `Тракт к ${intendedKnownDestination.name}` : intendedKnownDestination?.name || hinted || chosen.name)
  // Вид известного места — с карты мира: по названию «Мормар» ни порт, ни
  // деревня не угадываются, а карта это знает.
  const knownDestination = routedDestination ?? knownWorldDestinationByName(state, destination)
  const onwardDestination = intendedKnownDestination && intendedKnownDestination.id !== knownDestination?.id
    ? intendedKnownDestination.name
    : ''
  const knownKind = knownDestination?.kind ?? chosen?.kind ?? ''
  const location = destination.charAt(0).toLocaleUpperCase('ru') + destination.slice(1)
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1) + 1
  const oldHook = clean(state.adventure?.currentHook, 240)
  const oldObjective = clean(state.scene?.objective, 160)
  const requestedHook = /печат[ьи]\s+архивариуса/iu.test(action) ? 'Печать архивариуса остаётся незавершённой нитью и может открыть другой путь.' : ''
  // Отряд отказался от задания — новая цель не должна вести обратно к нему.
  // Прежняя зацепка не переезжает ни в цель, ни в незавершённые нити: отказ
  // именно тем и отличается от «ушли, не закрыв», что нить закрыта решением.
  const hook = abandonsQuest
    ? `В ${location} найдётся дело, не связанное с оставленным заданием.`
    : requestedHook || oldHook || oldObjective || `В ${location} обнаружится связь с оставленным позади путём.`
  // Слова в названии уступают виду известной точки карты мира. Для нового
  // места, которого на карте нет, явная «Таверна в Мормаре» по-прежнему
  // распознаётся как таверна, а не как город по словам исходной сцены.
  // Для уже известной точки вид карты авторитетнее слов в тексте решения.
  // Иначе маршрут «из Тихого Брода в Эствуд» цеплялся за слово «брод» в
  // исходной точке и рисовал мост вместо деревенских улиц.
  const byWorldKind = knownDestination ? themeForWorldKind(knownKind) : null
  // Узел карты остаётся авторитетом для поселений, лесов и подземелий:
  // описание деревни может упомянуть лес, но отряд всё равно прибывает на
  // улицы деревни. Описание уточняет географию только для landmark/fortress,
  // где `kind` сам по себе не различает озеро, перевал и дворец.
  const byWorldDescription = knownDestination && ['landmark', 'fortress'].includes(knownKind)
    ? themeForWorldDescription(knownDestination)
    : null
  const map = themeFor(location, hinted && !knownDestination ? action : '')
  const plannedMap = byWorldDescription ?? byWorldKind ?? map
  const streets = plannedMap.layout === 'streets'
  return {
    title: `Глава ${chapter} · ${location}`,
    location,
    ...(knownDestination?.id ? { location_id: knownDestination.id } : {}),
    mood: streets ? 'Шумная передышка за городскими стенами, где опасность прячется среди людей' : 'Неизведанное место, в котором путь ещё предстоит найти',
    objective: onwardDestination
      ? `Продолжить путь из ${location} к «${onwardDestination}»`
      : abandonsQuest
      ? `Осмотреться в ${location} и найти новую цель`
      : oldHook ? `Найти в ${location} другой путь к разгадке: ${oldHook}` : `Осмотреться в ${location} и найти другой путь`,
    transition: `Отряд отступает из «${from}» и следует принятому решению: ${clean(decision, 220)}.`,
    arrival: streets ? `Дорога выводит героев к воротам. За ними открываются улицы локации «${location}» — с площадями, переулками и местами, где можно искать сведения.` : `Путь из «${from}» приводит героев в новую локацию — «${location}».`,
    hook,
    theme: plannedMap.theme,
    danger: plannedMap.danger,
    outcome: abandonsQuest
      ? `Отряд покинул «${from}», отказавшись от прежнего задания.`
      : `Отряд покинул «${from}», не закрыв прежнюю сюжетную нить.`,
    objective_status: abandonsQuest ? 'abandoned' : 'unresolved',
    carry_unresolved: !abandonsQuest,
    map: { layout: plannedMap.layout, scale: plannedMap.scale, pattern: plannedMap.pattern, material: plannedMap.material, width: plannedMap.width, height: plannedMap.height, openness: plannedMap.openness, water: plannedMap.water, featureCount: plannedMap.featureCount },
  }
}

function normalizePlan(value, fallback) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const mapSource = source.map && typeof source.map === 'object' && !Array.isArray(source.map) ? source.map : {}
  const layouts = new Set(['rooms', 'streets', 'open', 'winding', 'cavern', 'ruins', 'radial'])
  const danger = new Set(['низкая', 'средняя', 'высокая'])
  const scale = MAP_SCALES.has(mapSource.scale) ? mapSource.scale : fallback.map.scale
  const dimensions = scaleDimensions(scale)
  // Этажи необязательны, и их отсутствие — самый частый и совершенно нормальный
  // ответ. Поэтому поле не подставляется из fallback и не появляется в заявке
  // пустым массивом: одноэтажная локация обязана выглядеть ровно так же, как до
  // появления многоуровневых карт.
  const levels = normalizeDeclaredLevels(source.levels)
  return {
    title: clean(source.title, 80) || fallback.title,
    location: clean(source.location, 120) || fallback.location,
    mood: clean(source.mood, 160) || fallback.mood,
    objective: clean(source.objective, 160) || fallback.objective,
    transition: clean(source.transition, 500) || fallback.transition,
    arrival: clean(source.arrival, 500) || fallback.arrival,
    hook: clean(source.hook, 240) || fallback.hook,
    theme: clean(source.theme, 80) || fallback.theme,
    danger: danger.has(source.danger) ? source.danger : fallback.danger,
    outcome: clean(source.outcome, 240) || fallback.outcome,
    // Это следствие подтверждённого решения группы, а не творческая часть
    // ответа модели. Уход не может превратиться в «цель завершена», а явный
    // отказ — снова открыть оставленную нить.
    objective_status: fallback.objective_status,
    carry_unresolved: fallback.carry_unresolved,
    ...(levels.length ? { levels } : {}),
    map: {
      layout: layouts.has(mapSource.layout) ? mapSource.layout : fallback.map.layout,
      scale,
      pattern: MAP_PATTERNS.has(mapSource.pattern) ? mapSource.pattern : fallback.map.pattern,
      material: MAP_MATERIALS.has(mapSource.material) ? mapSource.material : fallback.map.material,
      width: clampInteger(mapSource.width, dimensions.width, dimensions.minimumWidth, 25),
      height: clampInteger(mapSource.height, dimensions.height, dimensions.minimumHeight, 19),
      openness: Math.max(0.35, Math.min(0.85, Number(mapSource.openness) || fallback.map.openness)),
      water: Math.max(0, Math.min(0.3, Number(mapSource.water) || fallback.map.water)),
      featureCount: clampInteger(mapSource.featureCount, fallback.map.featureCount, 2, 12),
    },
  }
}

function locationKey(value) {
  return clean(value, 120).normalize('NFKC').toLocaleLowerCase('ru')
}

function genericDestinationHint(value) {
  return /^(?:подземель|локац|мест|город|деревн|сел|пос[её]л|лес|чащ|рощ|болот|пустош|пустын|порт|гаван|пристан|зам|крепост|цитадел|форт|застав|лагер|храм|святилищ|монастыр|пещер|руин|архив|склеп|катакомб|шахт|башн|таверн|трактир|корчм|усадьб|поместь|особняк|здани|район|улиц|площад|рынок|тракт|дорог|перевал|ущель|долин|остров|берег|станци|пол)[а-яё]*$/iu.test(locationKey(value))
}

/**
 * Известная точка назначения — серверный инвариант. Промпт объясняет его
 * модели ради хорошего ответа, но не является проверкой: идентификатор, имя и
 * вид карты всё равно закрепляются по worldMap после ответа.
 */
function knownDestinationConstraint({ state, destinationHint, destinationLocationId, modelLocation, fallbackLocation, fallbackLocationId }) {
  const known = knownDestinationsFrom(state)
  const hinted = locationKey(destinationHint)
  const intendedById = knownWorldDestinationById(state, destinationLocationId)
  if (intendedById) {
    // Имя не является идентификатором: на карте законны две «Рыночные
    // площади». Первый сегмент fallback закрепляется по ID, а не повторным
    // поиском первой локации с тем же названием.
    const destination = knownWorldDestinationById(state, fallbackLocationId)
    const exactLocation = destination ? '' : clean(fallbackLocation, 120)
    const modeled = locationKey(modelLocation)
    return {
      destination,
      exactLocation,
      rejected: Boolean(modeled && modeled !== locationKey(destination?.name ?? exactLocation)),
    }
  }
  if (hinted) {
    // Для дальней известной точки fallback уже выбрал первый сегмент маршрута.
    // Неизвестное собственное имя тоже фиксируется; обобщённое «город» или
    // «лес» оставляет модели право придумать конкретное место.
    const intended = knownWorldDestinationByName(state, destinationHint)
    if (!intended && genericDestinationHint(destinationHint)) return { destination: null, exactLocation: '', rejected: false }
    const destination = knownWorldDestinationByName(state, fallbackLocation)
    const exactLocation = destination ? '' : clean(fallbackLocation, 120)
    const modeled = locationKey(modelLocation)
    return {
      destination,
      exactLocation,
      rejected: Boolean(modeled && modeled !== locationKey(destination?.name ?? exactLocation)),
    }
  }
  if (!known.length) return { destination: null, exactLocation: '', rejected: false }
  const modeled = locationKey(modelLocation)
  if (modeled) {
    const destination = known.find((entry) => locationKey(entry.name) === modeled) ?? null
    return { destination, exactLocation: '', rejected: !destination }
  }
  const fallbackKey = locationKey(fallbackLocation)
  return {
    destination: known.find((entry) => locationKey(entry.name) === fallbackKey) ?? known[0] ?? null,
    exactLocation: '',
    rejected: false,
  }
}

export class SceneArchitectAgent {
  constructor({ llmClient = null } = {}) {
    this.llmClient = llmClient
  }

  async plan({ action, state = {}, decision = '', destinationHint = '', destinationLocationId = '', abandonsQuest = false } = {}) {
    // ID приходит от клиента, но доверенным становится только после точного
    // совпадения с известным узлом server-owned worldMap. При успехе каноническое
    // имя по ID важнее текста; неизвестный ID оставляет прежний разбор по имени.
    const authoritativeDestination = knownWorldDestinationById(state, destinationLocationId)
    const resolvedDestinationHint = authoritativeDestination?.name || clean(destinationHint, 120)
    const fallback = fallbackPlan({
      action: clean(action, 2000), state, decision: clean(decision, 500),
      destinationHint: resolvedDestinationHint,
      destinationLocationId: authoritativeDestination?.id ?? '',
      abandonsQuest,
    })
    const fallbackShopIntent = defaultSceneShopIntent(fallback)
    if (!this.llmClient) return {
      sceneArgs: fallback,
      shopIntent: fallbackShopIntent,
      trace: { agent: SCENE_ARCHITECT_AGENT_ID, mode: 'deterministic-fallback', reason: 'LLM is not configured' },
    }
    try {
      const planningBrief = buildDirectorPlanningBrief(state)
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          // Решение партии и текст разрешения — свободный текст игроков; память
          // кампании тоже могла быть записана из их слов. Всё уходит только
          // внутри UNTRUSTED_DATA, снаружи не остаётся ни одной их строки.
          { role: 'user', content: buildDataOnlyContext({ scene_planning: { selected_party_decision: clean(decision, 500), destination_hint: resolvedDestinationHint, destination_location_id: authoritativeDestination?.id ?? null, quest_abandoned: abandonsQuest === true, ...planningBrief, full_resolution_context: clean(action, 2000) } }) },
        ],
        temperature: 0.45,
        maxTokens: 1000,
      })
      const constraint = knownDestinationConstraint({
        state,
        destinationHint: resolvedDestinationHint,
        destinationLocationId: authoritativeDestination?.id ?? '',
        modelLocation: result?.location,
        fallbackLocation: fallback.location,
        fallbackLocationId: fallback.location_id,
      })
      // Если модель при наличии известных дорог придумала третье место или
      // подменила явно выбранное, её творческий план отбрасывается целиком:
      // отдельные строки arrival/hook тоже могли бы ссылаться на ложную точку.
      const constrainedFallback = constraint.destination
        ? fallbackPlan({
          action: clean(action, 2000), state, decision: clean(decision, 500),
          destinationHint: constraint.destination.name,
          destinationLocationId: constraint.destination.id,
          abandonsQuest,
        })
        : fallback
      const sceneArgs = constraint.rejected ? fallback : normalizePlan(result, constrainedFallback)
      if (constraint.destination && !constraint.rejected) {
        sceneArgs.location = constraint.destination.name
        sceneArgs.location_id = constraint.destination.id
        sceneArgs.theme = constrainedFallback.theme
        sceneArgs.danger = constrainedFallback.danger
        sceneArgs.map = constrainedFallback.map
      }
      if (constraint.exactLocation && !constraint.rejected) sceneArgs.location = constraint.exactLocation
      return {
        sceneArgs,
        shopIntent: constraint.rejected ? fallbackShopIntent : normalizeSceneShopIntent(result?.shop_intent, sceneArgs),
        trace: {
          agent: SCENE_ARCHITECT_AGENT_ID,
          mode: 'model',
          model: this.llmClient.model ?? null,
          ...(constraint.rejected ? { constraint: 'known_destination_fallback' } : {}),
        },
      }
    } catch (error) {
      return {
        sceneArgs: fallback,
        shopIntent: fallbackShopIntent,
        trace: { agent: SCENE_ARCHITECT_AGENT_ID, mode: 'deterministic-fallback', reason: error instanceof Error ? error.message : 'unknown error' },
      }
    }
  }
}

