import { createHash } from 'node:crypto'

import { normalizeDirectorIntent } from './autonomous-campaign.mjs'
import { CLOSED_QUEST_STATUSES } from './world-memory.mjs'

const clean = (value, maximum = 240) => String(value ?? '')
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, maximum)

const hashNumber = (value) => Number.parseInt(
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8),
  16,
)

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0))

export const ONE_EVENING_ARC_VERSION = 'skazanie:campaign-arc-v1'
export const ONE_EVENING_PRESET = 'one_evening'

/**
 * Потолок длины цепочки арок. Он не художественный, а инженерный: номер арки
 * входит в seed и в идентификаторы глав, и неограниченный счётчик означал бы
 * неограниченно растущее состояние кампании без единой точки, где его смотрят.
 */
export const MAX_CAMPAIGN_ARCS = 12

const ONE_EVENING_CHAPTER_CLOCK_MAX = 2
const ONE_EVENING_FORCE_AFTER_BEATS = 2
const ONE_EVENING_MAX_DIRECTOR_BEATS = 5

const PHASE_BY_TENSION = Object.freeze([
  [75, 'climax'],
  [50, 'escalation'],
  [25, 'development'],
  [0, 'breather'],
])

const PACING_DELTAS = Object.freeze({
  continue_exploration: 12,
  open_social_scene: 8,
  advance_quest_clock: 14,
  request_encounter: 24,
  end_scene: -30,
  offer_next_hook: 6,
})

const PHASE_INTENT_TYPES = Object.freeze({
  breather: Object.freeze(['continue_exploration', 'open_social_scene', 'advance_quest_clock', 'offer_next_hook']),
  development: Object.freeze(['advance_quest_clock', 'continue_exploration', 'open_social_scene', 'request_encounter', 'offer_next_hook']),
  escalation: Object.freeze(['advance_quest_clock', 'request_encounter', 'end_scene', 'continue_exploration']),
  climax: Object.freeze(['advance_quest_clock', 'end_scene', 'request_encounter']),
})

function phaseForEveningScene(sceneNumber, targetScenes) {
  if (sceneNumber >= targetScenes) return 'climax'
  if (sceneNumber === 1) return 'breather'
  if (sceneNumber === targetScenes - 1) return 'escalation'
  return 'development'
}

/** Номер арки — часть seed, поэтому вторая арка тех же героев не повторяет первую. */
export const arcSeedFor = (seed, arcNumber) => (
  Math.max(1, Number(arcNumber) || 1) <= 1
    ? clean(seed, 200)
    : `${clean(seed, 200)}#arc${Math.max(1, Number(arcNumber) || 1)}`
)

export function buildCampaignArcPlan(seed = '', arcNumber = 1) {
  const number = Math.max(1, Math.min(MAX_CAMPAIGN_ARCS, Math.floor(Number(arcNumber) || 1)))
  const normalizedSeed = clean(seed, 240) || 'one-evening'
  const chainedSeed = arcSeedFor(normalizedSeed, number)
  const targetScenes = 3 + (hashNumber(`${ONE_EVENING_ARC_VERSION}:${chainedSeed}`) % 3)
  return Object.freeze({
    version: ONE_EVENING_ARC_VERSION,
    preset: ONE_EVENING_PRESET,
    seed: normalizedSeed,
    arc_number: number,
    target_scenes: targetScenes,
    chapter_clock_max: ONE_EVENING_CHAPTER_CLOCK_MAX,
    force_after_beats: ONE_EVENING_FORCE_AFTER_BEATS,
    max_director_beats: ONE_EVENING_MAX_DIRECTOR_BEATS,
    climax: 'combat',
  })
}

export function campaignArcPlan(state = {}) {
  const raw = state.campaignConcept?.arc
  if (!raw || raw.version !== ONE_EVENING_ARC_VERSION || raw.preset !== ONE_EVENING_PRESET) return null
  // Арка без номера — сохранение до цепочки арок: это первая арка по определению.
  const canonical = buildCampaignArcPlan(raw.seed, raw.arc_number ?? 1)
  return raw.target_scenes === canonical.target_scenes ? canonical : null
}

function currentPhase(state = {}) {
  const arc = campaignArcPosition(state)
  if (arc) return arc.phase
  const stored = clean(state.autonomy?.pacing?.phase, 30)
  if (PHASE_INTENT_TYPES[stored]) return stored
  const tension = clamp(state.autonomy?.pacing?.tension, 0, 100)
  return PHASE_BY_TENSION.find(([threshold]) => tension >= threshold)?.[1] ?? 'breather'
}

function currentChapterIntents(state = {}) {
  const history = Array.isArray(state.autonomy?.director_history) ? state.autonomy.director_history : []
  const intents = history.map((entry) => entry?.intent ?? entry).filter((entry) => entry && typeof entry === 'object')
  const lastSceneEnd = intents.map((intent) => intent.type).lastIndexOf('end_scene')
  return intents.slice(lastSceneEnd + 1)
}

function mainQuestFor(state = {}) {
  const quests = state.worldMemory?.quests ?? []
  return quests.find((quest) => !String(quest.id || '').startsWith('quest:chapter:')) ?? quests[0] ?? null
}

function chapterQuestFor(state = {}, chapter = Math.max(1, Number(state.adventure?.chapter) || 1)) {
  return (state.worldMemory?.quests ?? []).find((quest) => String(quest.id) === `quest:chapter:${chapter}`) ?? null
}

function encounterOutcomeRecorded(state = {}, encounter = state.mechanics?.encounter) {
  if (!encounter?.id) return false
  return (state.autonomy?.encounter_outcomes ?? []).some((entry) => entry.encounter_id === encounter.id)
}

export function campaignArcClimaxSatisfied(state = {}) {
  const position = campaignArcPosition(state)
  if (!position?.is_final) return false
  const encounter = state.mechanics?.encounter
  return Boolean(encounter
    && encounter.status === 'ended'
    && encounter.difficulty === 'hard'
    && Number(encounter.created_in_chapter) === position.target_scenes
    && encounterOutcomeRecorded(state, encounter))
}

export function campaignArcPosition(state = {}) {
  const plan = campaignArcPlan(state)
  if (!plan) return null
  const sceneNumber = Math.max(1, Number(state.adventure?.chapter) || 1)
  const boundedScene = Math.min(plan.target_scenes, sceneNumber)
  const sceneBeat = currentChapterIntents(state).length
  const chapterQuest = chapterQuestFor(state, sceneNumber)
  const mainQuest = mainQuestFor(state)
  return Object.freeze({
    ...plan,
    scene_number: sceneNumber,
    bounded_scene_number: boundedScene,
    scene_beat: sceneBeat,
    remaining_beats: Math.max(0, plan.max_director_beats - sceneBeat),
    phase: phaseForEveningScene(boundedScene, plan.target_scenes),
    is_final: sceneNumber >= plan.target_scenes,
    chapter_quest_id: chapterQuest?.id ?? null,
    chapter_quest_status: chapterQuest?.status ?? null,
    main_quest_id: mainQuest?.id ?? null,
    main_quest_status: mainQuest?.status ?? null,
  })
}

function firstOpenQuest(state = {}) {
  return (state.worldMemory?.quests ?? []).find((quest) => quest.status === 'active' && !quest.clock?.triggered) ?? null
}

function availableIntentTypes(state = {}) {
  const phase = currentPhase(state)
  const arc = campaignArcPosition(state)
  const openQuest = firstOpenQuest(state)
  const encounter = state.mechanics?.encounter
  const encounterOutcomes = Array.isArray(state.autonomy?.encounter_outcomes) ? state.autonomy.encounter_outcomes : []
  const encounterResolved = encounter?.status === 'ended'
    && encounterOutcomes.some((entry) => entry.encounter_id === encounter.id)
  const quests = state.worldMemory?.quests ?? []
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1)
  const chapterQuest = chapterQuestFor(state, chapter)
  // Брошенный квест главы закрыт: сцену после него завершать можно, иначе отказ
  // отряда останавливал бы Режиссёра на этой главе навсегда.
  const chapterQuestResolved = Boolean(chapterQuest && CLOSED_QUEST_STATUSES.includes(chapterQuest.status))
  const mainQuest = quests.find((quest) => !String(quest.id || '').startsWith('quest:chapter:')) ?? quests[0]
  const mainQuestOpen = Boolean(mainQuest && ['active', 'hidden'].includes(mainQuest.status))
  const chapterHistory = currentChapterIntents(state)
  const peacefulSecondChapterExit = chapter === 2
    && encounterOutcomes.length > 0
    && chapterHistory.some((intent) => intent.type === 'advance_quest_clock')
  const endSceneAvailable = arc
    ? !arc.is_final && chapterQuestResolved
    : encounterResolved
      || peacefulSecondChapterExit
      || (chapterQuestResolved && !mainQuestOpen)
  const phaseTypes = endSceneAvailable
    ? [...new Set([...PHASE_INTENT_TYPES[phase], 'end_scene'])]
    : PHASE_INTENT_TYPES[phase]
  const types = phaseTypes.filter((type) => {
    if (type === 'advance_quest_clock') return Boolean(openQuest)
    if (type === 'request_encounter') {
      if (arc?.is_final && !chapterQuestResolved) return false
      const replaceResolvedFinalEncounter = Boolean(arc?.is_final
        && encounter?.status === 'ended'
        && encounterOutcomeRecorded(state, encounter)
        && !campaignArcClimaxSatisfied(state))
      return !state.mechanics?.combat?.active
        && (!encounter || replaceResolvedFinalEncounter)
        && !(state.enemies ?? []).some((enemy) => enemy.alive !== false && Number(enemy.hp ?? 1) > 0)
    }
    if (type === 'end_scene') return !state.mechanics?.combat?.active && endSceneAvailable
    return true
  })
  return { phase, arc, chapterQuest, mainQuest, openQuest, types }
}

function intentForType(type, state, openQuest) {
  if (type === 'open_social_scene') {
    const location = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
    const npc = (state.social?.npcs ?? []).find((entry) => entry.available !== false
      && (!entry.location || !location || clean(entry.location, 180).toLocaleLowerCase('ru') === location))
    return normalizeDirectorIntent({
      type,
      ...(npc?.id ? { npc_id: npc.id } : {}),
      reason: 'Серверная политика темпа открывает содержательную социальную сцену.',
    })
  }
  if (type === 'advance_quest_clock') {
    return normalizeDirectorIntent({
      type,
      quest_id: openQuest.id,
      reason: 'Серверная политика темпа продвигает подтверждённую активную цель.',
    })
  }
  if (type === 'request_encounter') {
    return normalizeDirectorIntent({
      type,
      theme: 'beasts',
      difficulty: currentPhase(state) === 'climax' ? 'hard' : 'medium',
      reason: 'Серверная политика темпа требует препятствия, разрешаемого правилами.',
    })
  }
  if (type === 'end_scene') {
    const chapter = Math.max(1, Number(state.adventure?.chapter) || 1)
    return normalizeDirectorIntent({
      type,
      destination: `След главы ${chapter + 1}`,
      reason: 'Подтверждённая развязка позволяет перейти к следующей главе.',
    })
  }
  if (type === 'offer_next_hook') {
    return normalizeDirectorIntent({
      type,
      hook: clean(state.scene?.objective, 300) || 'Найти следующую подтверждаемую зацепку',
      reason: 'Сервер сохраняет доступный следующий шаг.',
    })
  }
  return normalizeDirectorIntent({
    type: 'continue_exploration',
    reason: 'Серверная политика темпа требует нового наблюдаемого шага.',
  })
}

/**
 * Server-owned Director boundary. The model may propose only a bounded intent;
 * phase compatibility and anti-stall replacement are decided here.
 */
export function authorizeDirectorIntent(state = {}, proposedIntent = {}) {
  const proposed = normalizeDirectorIntent(proposedIntent)
  const availability = availableIntentTypes(state)
  const history = currentChapterIntents(state)
  const lastType = clean(history.at(-1)?.type, 40)
  const lastOutcome = (state.autonomy?.director_outcomes ?? []).at(-1) ?? null
  const stalledType = lastOutcome?.state_changed === false ? clean(lastOutcome.intent_type, 40) : ''
  const blocked = new Set([lastType, stalledType].filter(Boolean))
  const arc = availability.arc
  if (arc && (arc.is_final || arc.scene_beat >= arc.force_after_beats)) {
    const chapterQuest = availability.chapterQuest
    const openingEncounterAvailable = arc.scene_number === 1
      && !arc.is_final
      && Number(chapterQuest?.clock?.current) >= 1
      && !state.mechanics?.encounter
      && !state.mechanics?.combat?.active
    if (openingEncounterAvailable && proposed.type === 'request_encounter') {
      return {
        intent: normalizeDirectorIntent({
          ...proposed,
          difficulty: proposed.difficulty === 'hard' ? 'hard' : 'medium',
        }),
        proposed_intent: proposed,
        replaced: proposed.difficulty === 'easy',
        phase: availability.phase,
        allowed_types: [...new Set([...availability.types, 'request_encounter'])],
        reason: 'one_evening_opening_encounter',
        policy: 'director-intent-policy-one-evening-v1',
      }
    }
    if (chapterQuest?.status === 'active' && chapterQuest.clock?.triggered !== true) {
      return {
        intent: normalizeDirectorIntent({
          type: 'advance_quest_clock',
          quest_id: chapterQuest.id,
          reason: 'Бюджет вечерней сцены требует разрешить её подтверждённую цель.',
        }),
        proposed_intent: proposed,
        replaced: proposed.type !== 'advance_quest_clock' || proposed.quest_id !== chapterQuest.id,
        phase: availability.phase,
        allowed_types: availability.types,
        reason: 'one_evening_scene_clock',
        policy: 'director-intent-policy-one-evening-v1',
      }
    }
    if (chapterQuest && CLOSED_QUEST_STATUSES.includes(chapterQuest.status)) {
      if (!arc.is_final) {
        const intent = intentForType('end_scene', state, availability.openQuest)
        return {
          intent,
          proposed_intent: proposed,
          replaced: proposed.type !== 'end_scene',
          phase: availability.phase,
          allowed_types: availability.types,
          reason: 'one_evening_scene_transition',
          policy: 'director-intent-policy-one-evening-v1',
        }
      }
      if (!campaignArcClimaxSatisfied(state)
        && availability.types.includes('request_encounter')
        && !state.mechanics?.combat?.active) {
        const theme = proposed.type === 'request_encounter' ? proposed.theme : 'beasts'
        return {
          intent: normalizeDirectorIntent({
            type: 'request_encounter',
            theme,
            difficulty: 'hard',
            reason: 'Финальная сцена вечерней кампании требует полноценного серверного боя.',
          }),
          proposed_intent: proposed,
          replaced: proposed.type !== 'request_encounter' || proposed.difficulty !== 'hard',
          phase: availability.phase,
          allowed_types: availability.types,
          reason: 'one_evening_climax_encounter',
          policy: 'director-intent-policy-one-evening-v1',
        }
      }
      const mainQuest = availability.mainQuest
      if (campaignArcClimaxSatisfied(state) && mainQuest?.status === 'active' && mainQuest.clock?.triggered !== true) {
        return {
          intent: normalizeDirectorIntent({
            type: 'advance_quest_clock',
            quest_id: mainQuest.id,
            reason: 'Подтверждённый исход кульминации разрешает главную нить.',
          }),
          proposed_intent: proposed,
          replaced: proposed.type !== 'advance_quest_clock' || proposed.quest_id !== mainQuest.id,
          phase: availability.phase,
          allowed_types: availability.types,
          reason: 'one_evening_main_thread',
          policy: 'director-intent-policy-one-evening-v1',
        }
      }
    }
  }
  const allowed = availability.types.filter((type) => !blocked.has(type))
  const candidates = allowed.length ? allowed : availability.types
  const accepted = candidates.includes(proposed.type)
  const replacementType = accepted ? proposed.type : candidates[0] ?? 'continue_exploration'
  let intent = accepted ? proposed : intentForType(replacementType, state, availability.openQuest)
  if (arc?.is_final && intent.type === 'request_encounter' && intent.difficulty !== 'hard') {
    intent = normalizeDirectorIntent({ ...intent, difficulty: 'hard' })
  }
  return {
    intent,
    proposed_intent: proposed,
    replaced: !accepted,
    phase: availability.phase,
    allowed_types: availability.types,
    reason: accepted
      ? 'intent_allowed'
      : blocked.has(proposed.type)
        ? 'anti_stall_replacement'
        : 'phase_incompatible_replacement',
    policy: arc ? 'director-intent-policy-one-evening-v1' : 'director-intent-policy-v1',
  }
}

export function directorProgressFingerprint(state = {}) {
  return createHash('sha256').update(JSON.stringify({
    chapter: Math.max(1, Number(state.adventure?.chapter) || 1),
    scene: {
      location: clean(state.scene?.location, 180),
      objective: clean(state.scene?.objective, 300),
      revealed_cells: (state.scene?.cells ?? []).filter((cell) => cell.revealed === true).length,
    },
    quests: (state.worldMemory?.quests ?? []).map((quest) => ({
      id: clean(quest.id, 120),
      status: clean(quest.status, 30),
      current: Number(quest.clock?.current) || 0,
      triggered: quest.clock?.triggered === true,
    })),
    encounter: state.mechanics?.encounter ? {
      id: clean(state.mechanics.encounter.id, 120),
      status: clean(state.mechanics.encounter.status, 40),
      outcome: clean(state.mechanics.encounter.outcome, 80),
    } : null,
    lifecycle: clean(state.mechanics?.campaign_lifecycle?.status, 30),
  })).digest('hex').slice(0, 24)
}

export function pacingForDirectorIntent(state = {}, intent = {}) {
  const previous = state.autonomy?.pacing ?? {}
  const arc = campaignArcPosition(state)
  const before = clamp(previous.tension, 0, 100)
  const delta = PACING_DELTAS[intent.type] ?? 0
  const after = clamp(before + delta, 0, 100)
  const phase = arc
    ? phaseForEveningScene(
        Math.min(arc.target_scenes, arc.scene_number + (intent.type === 'end_scene' ? 1 : 0)),
        arc.target_scenes,
      )
    : PHASE_BY_TENSION.find(([threshold]) => after >= threshold)?.[1] ?? 'breather'
  return {
    beat: Math.max(0, Number(previous.beat) || 0) + 1,
    phase,
    tension_before: before,
    tension_after: after,
    delta,
    intent_type: clean(intent.type, 40),
    policy: arc ? 'campaign-pacing-one-evening-v1' : 'campaign-pacing-v1',
  }
}

function recentEncounterResolved(state = {}) {
  const outcomes = state.autonomy?.encounter_outcomes ?? []
  const travels = state.autonomy?.travel_history ?? []
  return outcomes.length > travels.length
}

/* --- Путешествие по графу мира -------------------------------------------
 *
 * Единственный источник расстояния, местности и опасности — `state.worldMap`
 * (`server/world-map.mjs`). Ветка на текстовых названиях ниже оставлена только
 * для совместимости со старыми кампаниями и явно помечена.
 */

/**
 * Полосы расстояния и базовые длительности. Числа те же, что были до перехода
 * на граф: сменился источник факта, а не баланс.
 */
const TRAVEL_DISTANCE_BANDS = Object.freeze([
  Object.freeze({ band: 'near', maxDistance: 2, minutes: 45 }),
  Object.freeze({ band: 'regional', maxDistance: 5, minutes: 120 }),
  Object.freeze({ band: 'far', maxDistance: Number.POSITIVE_INFINITY, minutes: 240 }),
])

const TRAVEL_BASE_MINUTES = Object.freeze(Object.fromEntries(
  TRAVEL_DISTANCE_BANDS.map((entry) => [entry.band, entry.minutes]),
))

/**
 * Перевод `route.danger` в надбавку к риску. Таблица покрывает все значения,
 * которые допускает `normalizeRoutes`, плюс английские синонимы для карт,
 * пришедших от модели до нормализации. Неизвестное значение даёт 0.
 */
const ROUTE_DANGER_RISK = Object.freeze({
  низкая: 5,
  средняя: 12,
  высокая: 20,
  low: 5,
  medium: 12,
  high: 20,
})

/**
 * Дикая местность. Из `route.kind` дикими считаются все, кроме `road`; из
 * биомов — четыре, перечисленные в плане (`docs/world-map-plan.md`, Ш1).
 * `desert` и `tundra` намеренно не входят: их пересмотр — отдельная задача.
 */
const WILD_ROUTE_KINDS = Object.freeze(new Set(['trail', 'pass', 'river', 'sea']))
const WILD_BIOMES = Object.freeze(new Set(['forest', 'marsh', 'mountains', 'wastes']))

/**
 * Порядок «опаснее» для выбора региона на маршруте. Правило произвольное, но
 * обязано быть детерминированным: у маршрута два конца с разными `regionId`,
 * берётся более опасный биом, при равенстве — регион цели.
 */
const BIOME_DANGER_RANK = Object.freeze({
  plains: 0,
  coast: 1,
  tundra: 2,
  desert: 3,
  forest: 4,
  marsh: 5,
  mountains: 6,
  wastes: 7,
})

/** Тема будущей стычки — от биома региона на маршруте, а не от названия. */
const ENCOUNTER_THEMES_BY_BIOME = Object.freeze({
  plains: Object.freeze(['raiders', 'goblinoids']),
  coast: Object.freeze(['raiders', 'goblinoids']),
  tundra: Object.freeze(['beasts', 'raiders']),
  desert: Object.freeze(['raiders', 'beasts']),
  forest: Object.freeze(['beasts', 'goblinoids']),
  marsh: Object.freeze(['undead', 'beasts']),
  mountains: Object.freeze(['goblinoids', 'beasts']),
  wastes: Object.freeze(['undead', 'raiders']),
})

const DEFAULT_ENCOUNTER_THEMES = Object.freeze(['raiders', 'goblinoids'])

/** Столько единиц логической сетки 1000×640 приходится на единицу `distance`. */
const WORLD_GRID_DISTANCE_UNIT = 48

/** Надбавка за путь напрямик, когда известной дороги между локациями нет. */
const NO_ROUTE_DANGER_RISK = 15

const nameKey = (value) => clean(value, 180).toLocaleLowerCase('ru')

/** Только собственные ключи таблиц: чужое значение не должно попасть в расчёт. */
const tableValue = (table, key, fallback) => (Object.hasOwn(table, key) ? table[key] : fallback)

const biomeRank = (biome) => tableValue(BIOME_DANGER_RANK, biome, -1)

/**
 * Граф мира из состояния. `null` означает, что карты нет или она не
 * нормализована — тогда работает ветка совместимости.
 */
function worldTravelGraph(state = {}) {
  const map = state.worldMap
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  const locations = (Array.isArray(map.locations) ? map.locations : [])
    .filter((location) => location && typeof location === 'object' && clean(location.id, 120))
  if (!locations.length) return null
  const byId = new Map(locations.map((location) => [clean(location.id, 120), location]))
  // Неоткрытые дороги отряду ещё не известны, поэтому в поиске пути не участвуют.
  const routes = (Array.isArray(map.routes) ? map.routes : []).filter((route) => route
    && typeof route === 'object'
    && byId.has(clean(route.from, 120))
    && byId.has(clean(route.to, 120))
    && clean(route.from, 120) !== clean(route.to, 120)
    && route.discovered !== false)
  const biomeByRegionId = new Map((Array.isArray(map.regions) ? map.regions : [])
    .filter((region) => region && typeof region === 'object')
    .map((region) => [clean(region.id, 120), clean(region.biome, 40)]))
  return { locations, byId, routes, biomeByRegionId, currentLocationId: clean(map.currentLocationId, 120) }
}

/** Локация графа: сначала по идентификатору, затем по имени без учёта регистра. */
function graphLocation(graph, { locationId = '', name = '' } = {}) {
  const byId = graph.byId.get(clean(locationId, 120))
  if (byId) return byId
  const expected = nameKey(name)
  return expected ? graph.locations.find((location) => nameKey(location.name) === expected) ?? null : null
}

const routeEndpoints = (graph, route) => [
  graph.byId.get(clean(route.from, 120)),
  graph.byId.get(clean(route.to, 120)),
].filter(Boolean)

const locationBiome = (graph, location) => graph.biomeByRegionId.get(clean(location?.regionId, 120)) ?? ''

/** Оценка длины сегмента по координатам — тот же масштаб, что в `world-map.mjs`. */
function straightDistance(from, to) {
  const dx = (Number(from?.x) || 0) - (Number(to?.x) || 0)
  const dy = (Number(from?.y) || 0) - (Number(to?.y) || 0)
  return Math.max(1, Math.round(Math.hypot(dx, dy) / WORLD_GRID_DISTANCE_UNIT))
}

function segmentDistance(graph, route) {
  const parsed = Number(route?.distance)
  if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed))
  const [from, to] = routeEndpoints(graph, route)
  return straightDistance(from, to)
}

/**
 * Поиск пути: обычный BFS по известным маршрутам, кратчайший по числу
 * сегментов. Порядок обхода задан порядком `routes`, поэтому результат
 * детерминирован.
 */
function routePath(graph, fromId, toId) {
  if (fromId === toId) return []
  const neighbours = new Map()
  for (const route of graph.routes) {
    const from = clean(route.from, 120)
    const to = clean(route.to, 120)
    if (!neighbours.has(from)) neighbours.set(from, [])
    if (!neighbours.has(to)) neighbours.set(to, [])
    neighbours.get(from).push({ route, next: to })
    neighbours.get(to).push({ route, next: from })
  }
  const visited = new Set([fromId])
  const queue = [{ id: fromId, path: [] }]
  while (queue.length) {
    const node = queue.shift()
    if (node.id === toId) return node.path
    for (const edge of neighbours.get(node.id) ?? []) {
      if (visited.has(edge.next)) continue
      visited.add(edge.next)
      queue.push({ id: edge.next, path: [...node.path, edge.route] })
    }
  }
  return null
}

/** Более опасный биом из встреченных; при равенстве — регион цели. */
function pathBiome(graph, locations, destination) {
  let biome = locationBiome(graph, destination)
  for (const location of locations) {
    const candidate = locationBiome(graph, location)
    if (biomeRank(candidate) > biomeRank(biome)) biome = candidate
  }
  return biome
}

const distanceBandFor = (distance) => (TRAVEL_DISTANCE_BANDS.find((entry) => distance <= entry.maxDistance)
  ?? TRAVEL_DISTANCE_BANDS.at(-1)).band

const encounterThemesFor = (biome) => tableValue(ENCOUNTER_THEMES_BY_BIOME, biome, DEFAULT_ENCOUNTER_THEMES)

/** Факты пути из графа мира: расстояние, местность, опасность и тема стычки. */
function graphTravelFacts(graph, origin, destination) {
  const segments = routePath(graph, clean(origin.id, 120), clean(destination.id, 120))
  if (!segments) {
    // Известной дороги нет. Маршрут здесь не выдумывается и `worldMap` не
    // меняется: честная оценка «идти напрямик» по координатам плюс надбавка.
    const biome = pathBiome(graph, [origin, destination], destination)
    return {
      source: 'graph',
      band: distanceBandFor(straightDistance(origin, destination)),
      wilderness: true,
      dangerRisk: NO_ROUTE_DANGER_RISK,
      themeOptions: encounterThemesFor(biome),
      routeId: null,
      noRoute: true,
    }
  }
  const distance = segments.reduce((total, route) => total + segmentDistance(graph, route), 0)
  const dangerRisk = segments.reduce((worst, route) => Math.max(
    worst,
    tableValue(ROUTE_DANGER_RISK, clean(route.danger, 40).toLocaleLowerCase('ru'), 0),
  ), 0)
  const wilderness = segments.some((route) => WILD_ROUTE_KINDS.has(clean(route.kind, 30).toLowerCase())
    || routeEndpoints(graph, route).some((location) => WILD_BIOMES.has(locationBiome(graph, location))))
  const biome = pathBiome(graph, segments.flatMap((route) => routeEndpoints(graph, route)), destination)
  return {
    source: 'graph',
    band: distanceBandFor(distance),
    wilderness,
    dangerRisk,
    themeOptions: encounterThemesFor(biome),
    routeId: segments.length === 1 ? clean(segments[0].id, 100) || null : null,
    noRoute: false,
  }
}

const LEGACY_WILDERNESS_NAME = /(лес|тракт|дорог|пустош|болот|гор|ущель|перевал|пещер|road|forest|wild|marsh|mountain)/iu
const LEGACY_GRAVE_NAME = /(кладбищ|склеп|руин|grave|crypt|ruin)/iu

/**
 * ПУТЬ СОВМЕСТИМОСТИ для кампаний без графа мира: `state.worldMap` пуст, не
 * нормализован или в нём нет исходной либо целевой локации. Это не второй
 * способ считать расстояние — считать здесь просто нечем, а числа обязаны
 * совпадать с прежним поведением, иначе у сохранённых кампаний изменится
 * длительность пути. Новую логику сюда не добавлять.
 */
function legacyTextTravelFacts(state, from, to, entropy) {
  const sceneKind = clean(state.scene?.scene_kind, 40).toLowerCase()
  const wilderness = sceneKind === 'wilderness' || LEGACY_WILDERNESS_NAME.test(`${from} ${to}`)
  return {
    source: 'legacy_text',
    band: ['near', 'regional', 'far'][entropy % 3],
    wilderness,
    dangerRisk: 0,
    themeOptions: LEGACY_GRAVE_NAME.test(`${from} ${to}`)
      ? ['undead', 'raiders']
      : wilderness
        ? ['beasts', 'goblinoids', 'raiders']
        : ['raiders', 'goblinoids'],
    routeId: null,
    noRoute: false,
  }
}

export function planServerTravel(state = {}, {
  campaignId = '',
  destination = '',
  destinationLocationId = '',
  idempotencyKey = '',
} = {}) {
  const graph = worldTravelGraph(state)
  const origin = graph
    ? graphLocation(graph, { locationId: graph.currentLocationId, name: state.scene?.location })
    : null
  const target = graph
    ? graphLocation(graph, { locationId: destinationLocationId, name: destination })
    : null
  const from = clean(state.scene?.location, 180) || clean(origin?.name, 180) || 'Текущая локация'
  const to = clean(destination, 180) || clean(target?.name, 180) || `${from} — следующая сцена`
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1)
  const fingerprint = `${campaignId}:${idempotencyKey}:${from}:${to}:${chapter}`
  const entropy = hashNumber(fingerprint)
  const facts = origin && target
    ? graphTravelFacts(graph, origin, target)
    : legacyTextTravelFacts(state, from, to, entropy)
  const durationMinutes = TRAVEL_BASE_MINUTES[facts.band] + (facts.wilderness ? 30 : 0)
  const pacingTension = clamp(state.autonomy?.pacing?.tension, 0, 100)
  const activeQuestPressure = (state.worldMemory?.quests ?? []).some((quest) => (
    quest.status === 'active' && Number(quest.clock?.current) >= Math.max(1, Number(quest.clock?.max) - 2)
  )) ? 15 : 0
  const afterEncounterRecovery = recentEncounterResolved(state)
  const recoveryDiscount = afterEncounterRecovery ? 35 : 0
  const riskScore = clamp(
    pacingTension + (facts.wilderness ? 20 : 5) + activeQuestPressure - recoveryDiscount + facts.dangerRisk,
    0,
    100,
  )
  const threshold = clamp(riskScore - 35, 0, 55)
  const roll = (entropy >>> 8) % 100
  const randomEncounter = !afterEncounterRecovery && riskScore >= 65 && roll < threshold
  const theme = facts.themeOptions[(entropy >>> 16) % facts.themeOptions.length]
  const difficulty = riskScore >= 90 ? 'hard' : riskScore >= 72 ? 'medium' : 'easy'
  return {
    travel_id: `travel-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 20)}`,
    from,
    to,
    distance_band: facts.band,
    duration_minutes: durationMinutes,
    risk_score: riskScore,
    random_encounter: randomEncounter,
    encounter: randomEncounter ? { theme, difficulty } : null,
    source: facts.source,
    route_id: facts.routeId,
    no_route: facts.noRoute,
    policy: 'server-travel-v2',
  }
}

const NPC_NAMES = Object.freeze([
  'Арина Медный Лист',
  'Борен Серый Плащ',
  'Вея Тихая Река',
  'Гален Фонарщик',
  'Дара Каменная Пыль',
  'Еремей Следопыт',
])

const NPC_ROLES = Object.freeze([
  'местный проводник',
  'очевидец',
  'хранитель дороги',
  'ремесленник',
  'посыльный',
  'исследователь руин',
])

export function assembleSocialNpc(state = {}, {
  campaignId = '',
  requestedId = '',
  idempotencyKey = '',
} = {}) {
  const location = clean(state.scene?.location, 180) || 'Текущая локация'
  const entropy = hashNumber(`${campaignId}:${idempotencyKey}:${location}:${requestedId}`)
  const name = NPC_NAMES[entropy % NPC_NAMES.length]
  const role = NPC_ROLES[(entropy >>> 8) % NPC_ROLES.length]
  const generatedId = `npc-${createHash('sha256').update(`${campaignId}:${location}:${name}`).digest('hex').slice(0, 16)}`
  const knownFactIds = (state.worldMemory?.facts ?? [])
    .filter((fact) => fact.status === 'active' && ['public', 'party'].includes(fact.visibility))
    .map((fact) => clean(fact.id, 120))
    .filter(Boolean)
    .slice(0, 20)
  const faction = (state.worldMemory?.entities ?? []).find((entity) => entity.kind === 'faction')
  // Запрошенный идентификатор принимается, только если такого NPC ещё нет.
  // Иначе собранный профиль уехал бы в `UpsertNpcSocialProfile` под чужим id и
  // переписал бы настоящего NPC: другое имя, другая роль, пустое расписание, —
  // а обещания и разговоры остались бы привязаны к этому id. Директор просит
  // недоступного собеседника — сервер приводит другого, а не подменяет этого.
  const requested = clean(requestedId, 120)
  const taken = (state.social?.npcs ?? []).some((npc) => String(npc?.id) === requested)
  return {
    id: requested && !taken ? requested : generatedId,
    name,
    role,
    location,
    public_summary: `${name} — ${role}, которого можно встретить в локации «${location}».`,
    voice: 'Говорит ясно, отвечает только на то, что действительно знает.',
    goals: ['Сохранить безопасность своей общины', 'Понять намерения отряда'],
    beliefs: ['Поступки важнее обещаний'],
    known_fact_ids: knownFactIds,
    visibility: 'party',
    available: true,
    tags: faction?.id ? [`faction:${clean(faction.id, 120)}`] : [],
    schedule: [],
    inventory: [],
  }
}

export function completedDowntime(state = {}, {
  kind = 'long_rest',
  durationMinutes = 480,
  reason = 'post_encounter_recovery',
} = {}) {
  const partyIds = new Set((state.partyMemberIds ?? []).map(String))
  const participants = (state.players ?? [])
    .filter((hero) => partyIds.has(String(hero.id)) && state.mechanics?.death?.heroes?.[hero.id]?.status !== 'dead')
    .map((hero) => String(hero.id))
    .sort()
  return {
    downtime_id: `downtime-${createHash('sha256').update(JSON.stringify({
      campaign: state.sessionCode ?? state.campaign_id,
      at: state.mechanics?.world_time?.elapsed_minutes,
      participants,
      reason,
    })).digest('hex').slice(0, 20)}`,
    kind,
    duration_minutes: Math.max(0, Number(durationMinutes) || 0),
    participant_ids: participants,
    reason: clean(reason, 120),
    policy: 'server-downtime-v1',
  }
}
