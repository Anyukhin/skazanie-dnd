// @ts-check
/**
 * Сценарий авторской кампании — сюжет, который движок исполняет без модели.
 *
 * Данные — `data/campaign-scenarios-v1.json`, сюжет для людей —
 * `docs/astohan-scenario.md`. Сценарий состоит из двух частей:
 *
 * - **карточки мест** — заголовок, настроение, цель, приход и тайны сцены.
 *   Переход сцены (`AdvanceScene`) накладывает карточку на аргументы перехода,
 *   какой бы путь его ни породил: голосование, Режиссёр или карта мира.
 *   Тайны получают стабильные id, поэтому находку можно узнать по факту;
 * - **узлы сюжета** — пролог, глава, линии и финал. Их состояние не хранится
 *   отдельно, а выводится из состояния кампании: посещённых мест, находок,
 *   павших NPC и исхода боя с главным противником. Поэтому replay сходится
 *   без новых типов событий, а сохранённые кампании без сценария не меняются.
 *
 * Модуль — лист графа импортов: он читает состояние, но не импортирует ни
 * Rules Engine, ни политику Режиссёра.
 */
import { readFileSync } from 'node:fs'

export const SCENARIO_ARC_VERSION = 'skazanie:scenario-arc-v1'
export const SCENARIO_ARC_PRESET = 'scenario'
const SCENARIO_CATALOG_URL = new URL('../data/campaign-scenarios-v1.json', import.meta.url)
const SCENARIO_SCHEMA_VERSION = 1

const BEAT_KINDS = new Set(['prologue', 'chapter', 'line', 'finale'])
const SECRET_SKILLS = new Set(['investigation', 'perception', 'survival', 'insight', 'history', 'arcana', 'religion', 'nature', 'medicine'])
const ENCOUNTER_THEMES = new Set(['goblinoids', 'undead', 'beasts', 'raiders', 'warband', 'law', 'vermin', 'ambush', 'crypt', 'cave', 'wilderness', 'generic'])
const ENCOUNTER_DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'deadly'])
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/u

/** @param {unknown} value @param {number} [maximum] */
const clean = (value, maximum = 240) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** @param {string} message @returns {never} */
function invalid(message) {
  throw new Error(`Сценарий кампании: ${message}`)
}

/**
 * Условие завершения узла. Листья: `clue` — найдена тайна сценария, `left` —
 * отряд побывал в месте и ушёл из него, `visited` — побывал, `npc_defeated` —
 * NPC выбыл. Составные: `any`, `all`, `count` + `of`.
 * @param {any} condition
 * @param {string} where
 * @param {Set<string>} clueIds
 */
function validateCondition(condition, where, clueIds) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) invalid(`${where}: условие должно быть объектом`)
  const keys = Object.keys(condition)
  if (keys.includes('any') || keys.includes('all')) {
    const list = condition.any ?? condition.all
    if (!Array.isArray(list) || !list.length) invalid(`${where}: пустой список условий`)
    list.forEach((entry, index) => validateCondition(entry, `${where}[${index}]`, clueIds))
    return
  }
  if (keys.includes('count')) {
    if (!Number.isSafeInteger(condition.count) || condition.count < 1 || !Array.isArray(condition.of) || condition.of.length < condition.count) {
      invalid(`${where}: count должен быть не больше длины of`)
    }
    condition.of.forEach((/** @type {any} */ entry, /** @type {number} */ index) => validateCondition(entry, `${where}.of[${index}]`, clueIds))
    return
  }
  if (keys.length !== 1) invalid(`${where}: лист условия — ровно одно поле`)
  const [key] = keys
  if (key === 'clue') {
    if (!clueIds.has(condition.clue)) invalid(`${where}: неизвестная тайна ${condition.clue}`)
    return
  }
  if (['left', 'visited', 'npc_defeated'].includes(key)) {
    if (!ID_PATTERN.test(String(condition[key] ?? ''))) invalid(`${where}: ${key} — идентификатор`)
    return
  }
  invalid(`${where}: неизвестное условие ${key}`)
}

const SAVE_ABILITIES = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const DAMAGE_TYPES = new Set(['fire', 'cold', 'acid', 'lightning', 'poison', 'thunder', 'necrotic', 'radiant', 'force', 'psychic'])

/**
 * Счётчик внимания главного противника (`server/scenario-attention.mjs`):
 * пороги, места, где за отрядом следят, основы слов темы и незнакомец, который
 * приходит на пороге `stranger_at`.
 * @param {any} attention
 * @param {string} scenarioId
 * @param {Set<string>} locationIds
 */
function validateAttention(attention, scenarioId, locationIds) {
  const where = `${scenarioId}/attention`
  const { maximum, stranger_at: strangerAt, ready_at: readyAt } = attention
  if (![maximum, strangerAt, readyAt].every((value) => Number.isSafeInteger(value) && value > 0)
    || strangerAt >= readyAt || readyAt > maximum) invalid(`${where}: пороги 0 < stranger_at < ready_at ≤ maximum`)
  const watched = Array.isArray(attention.watched_location_ids) ? attention.watched_location_ids : []
  if (!watched.length || watched.some((/** @type {string} */ id) => !locationIds.has(id))) invalid(`${where}: места наблюдения должны быть карточками`)
  const stems = Array.isArray(attention.topic_stems) ? attention.topic_stems : []
  if (!stems.length || stems.some((/** @type {unknown} */ stem) => typeof stem !== 'string' || stem.length < 4 || stem !== stem.toLocaleLowerCase('ru'))) {
    invalid(`${where}: основы темы — строчные, не короче четырёх букв`)
  }
  const stranger = attention.stranger
  if (!stranger || !ID_PATTERN.test(String(stranger.npc_id ?? '')) || !clean(stranger.name, 120) || !clean(stranger.role, 80)
    || !clean(stranger.summary, 400) || !clean(stranger.voice, 240)) invalid(`${where}: незнакомцу нужны id, имя, роль, облик и голос`)
  const places = Array.isArray(stranger.location_ids) ? stranger.location_ids : []
  if (!places.length || places.some((/** @type {string} */ id) => !locationIds.has(id))) invalid(`${where}: места незнакомца должны быть карточками`)
  if (!Array.isArray(stranger.goals) || !stranger.goals.length) invalid(`${where}: цели незнакомца`)
  for (const field of ['arrival_text', 'reveal_text', 'departure_text']) {
    if (clean(stranger[field], 1_000).length < 40) invalid(`${where}: текст незнакомца ${field}`)
  }
  const breath = stranger.breath
  if (!/^\d{1,2}d(4|6|8|10|12)$/u.test(String(breath?.expression ?? '')) || !SAVE_ABILITIES.has(breath?.ability)
    || !Number.isSafeInteger(breath?.dc) || breath.dc < 5 || breath.dc > 30 || !DAMAGE_TYPES.has(breath?.damage_type)) {
    invalid(`${where}: выдох — кости, спасбросок, СЛ 5–30 и вид урона`)
  }
}

/**
 * Структура сценария. Ссылки на места и NPC мира проверяет тест каталога —
 * здесь только форма, чтобы модуль не зависел от каталога миров.
 * @param {any} scenario
 */
function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') invalid('запись должна быть объектом')
  if (!ID_PATTERN.test(String(scenario.id ?? ''))) invalid('id сценария')
  if (!Number.isSafeInteger(scenario.version) || scenario.version < 1) invalid(`${scenario.id}: версия`)
  if (!ID_PATTERN.test(String(scenario.world_template_id ?? ''))) invalid(`${scenario.id}: world_template_id`)
  const locations = Array.isArray(scenario.locations) ? scenario.locations : invalid(`${scenario.id}: locations`)
  const locationIds = new Set()
  const clueIds = new Set()
  for (const location of locations) {
    const id = String(location?.location_id ?? '')
    if (!ID_PATTERN.test(id) || locationIds.has(id)) invalid(`${scenario.id}: место ${id}`)
    locationIds.add(id)
    for (const field of ['title', 'mood', 'arrival', 'objective']) {
      if (!clean(location[field], 600)) invalid(`${scenario.id}/${id}: пустое поле ${field}`)
    }
    if (location.encounter) {
      if (!ENCOUNTER_THEMES.has(location.encounter.theme) || !ENCOUNTER_DIFFICULTIES.has(location.encounter.difficulty)) {
        invalid(`${scenario.id}/${id}: встреча вне словаря сборщика`)
      }
    }
    for (const secret of Array.isArray(location.secrets) ? location.secrets : []) {
      const secretId = String(secret?.id ?? '')
      if (!ID_PATTERN.test(secretId) || clueIds.has(secretId)) invalid(`${scenario.id}/${id}: тайна ${secretId}`)
      clueIds.add(secretId)
      if (clean(secret.clue, 600).length < 12 || !clean(secret.topic, 160)) invalid(`${scenario.id}/${secretId}: текст тайны`)
      if (!Array.isArray(secret.skills) || !secret.skills.length || secret.skills.some((/** @type {string} */ skill) => !SECRET_SKILLS.has(skill))) {
        invalid(`${scenario.id}/${secretId}: навыки тайны`)
      }
    }
  }
  const beats = Array.isArray(scenario.beats) ? scenario.beats : invalid(`${scenario.id}: beats`)
  const beatIds = new Set()
  for (const beat of beats) {
    const id = String(beat?.id ?? '')
    if (!ID_PATTERN.test(id) || beatIds.has(id)) invalid(`${scenario.id}: узел ${id}`)
    beatIds.add(id)
    if (!BEAT_KINDS.has(beat.kind)) invalid(`${scenario.id}/${id}: вид узла`)
    if (!clean(beat.title, 160)) invalid(`${scenario.id}/${id}: название`)
    if (!Array.isArray(beat.location_ids) || !beat.location_ids.length
      || beat.location_ids.some((/** @type {string} */ locationId) => !locationIds.has(locationId))) {
      invalid(`${scenario.id}/${id}: места узла должны быть карточками сценария`)
    }
    if (beat.kind === 'finale') {
      if (!ID_PATTERN.test(String(beat.boss?.npc_id ?? '')) || !locationIds.has(beat.boss?.location_id)
        || !ENCOUNTER_DIFFICULTIES.has(beat.boss?.difficulty)) {
        invalid(`${scenario.id}/${id}: финалу нужен главный противник с местом и сложностью`)
      }
    } else validateCondition(beat.complete_when, `${scenario.id}/${id}`, clueIds)
  }
  for (const reveal of Array.isArray(scenario.map_reveals) ? scenario.map_reveals : []) {
    if (!ID_PATTERN.test(String(reveal?.id ?? ''))) invalid(`${scenario.id}: открытие карты ${reveal?.id}`)
    validateCondition(reveal.when, `${scenario.id}/${reveal.id}`, clueIds)
    const places = Array.isArray(reveal.locations) ? reveal.locations : []
    const routes = Array.isArray(reveal.routes) ? reveal.routes : []
    if (!places.length && !routes.length) invalid(`${scenario.id}/${reveal.id}: открывать нечего`)
    for (const locationId of [...places, ...routes.flat()]) {
      if (!locationIds.has(locationId)) invalid(`${scenario.id}/${reveal.id}: место ${locationId} без карточки`)
    }
    if (routes.some((/** @type {unknown} */ route) => !Array.isArray(route) || route.length !== 2)) invalid(`${scenario.id}/${reveal.id}: дорога — пара мест`)
  }
  if (scenario.attention != null) validateAttention(scenario.attention, scenario.id, locationIds)
  if (beats.filter((/** @type {any} */ beat) => beat.kind === 'finale').length !== 1) invalid(`${scenario.id}: финал должен быть ровно один`)
  if (beats[0]?.kind !== 'prologue') invalid(`${scenario.id}: первый узел — пролог`)
  const endings = Array.isArray(scenario.endings) ? scenario.endings : invalid(`${scenario.id}: endings`)
  const outcomes = new Set()
  for (const ending of endings) {
    if (!ID_PATTERN.test(String(ending?.id ?? '')) || !clean(ending.title, 160) || clean(ending.epilogue, 4_000).length < 40) {
      invalid(`${scenario.id}: развязка ${ending?.id}`)
    }
    for (const outcome of Array.isArray(ending.outcomes) ? ending.outcomes : invalid(`${scenario.id}/${ending.id}: outcomes`)) {
      if (outcomes.has(outcome)) invalid(`${scenario.id}: исход ${outcome} у двух развязок`)
      outcomes.add(outcome)
    }
  }
  return scenario
}

/** @returns {any[]} */
function loadScenarios() {
  const raw = JSON.parse(readFileSync(SCENARIO_CATALOG_URL, 'utf8'))
  if (raw?.schema_version !== SCENARIO_SCHEMA_VERSION || !Array.isArray(raw.scenarios)) invalid('неизвестная версия каталога')
  const ids = new Set()
  const worlds = new Set()
  return raw.scenarios.map((/** @type {any} */ entry) => {
    const scenario = deepFreeze(validateScenario(entry))
    if (ids.has(scenario.id)) invalid(`повтор id ${scenario.id}`)
    if (worlds.has(scenario.world_template_id)) invalid(`второй сценарий мира ${scenario.world_template_id}`)
    ids.add(scenario.id)
    worlds.add(scenario.world_template_id)
    return scenario
  })
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

const SCENARIOS = Object.freeze(loadScenarios())

/** Все сценарии каталога — для тестов и аудита. */
export function listCampaignScenarios() {
  return SCENARIOS
}

/** @param {string} worldTemplateId */
export function scenarioForWorldTemplate(worldTemplateId) {
  return SCENARIOS.find((scenario) => scenario.world_template_id === clean(worldTemplateId, 80)) ?? null
}

/**
 * План арки по сценарию. Числа темпа те же, что у вечерней арки: Режиссёр
 * получает те же ограничения шагов, а длину истории задают узлы, а не хеш.
 * @param {any} scenario
 */
export function buildScenarioArcPlan(scenario) {
  return Object.freeze({
    version: SCENARIO_ARC_VERSION,
    preset: SCENARIO_ARC_PRESET,
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    seed: scenario.id,
    arc_number: 1,
    target_scenes: scenario.beats.length,
    chapter_clock_max: 2,
    force_after_beats: 2,
    max_director_beats: 5,
    climax: 'resolution',
  })
}

/**
 * Сценарий кампании или `null`. Версия сценария записана в арке при создании
 * кампании; другая версия каталога не подменяет историю, начатую по старой.
 * @param {any} state
 */
export function campaignScenario(state = {}) {
  const arc = state?.campaignConcept?.arc
  if (!arc || arc.version !== SCENARIO_ARC_VERSION) return null
  if (state?.campaignConcept?.campaign_mode === 'persistent') return null
  const scenario = SCENARIOS.find((entry) => entry.id === arc.scenario_id) ?? null
  return scenario && scenario.version === arc.scenario_version ? scenario : null
}

/** @param {any} scenario @param {string} clueId */
export function scenarioClueFactId(scenario, clueId) {
  return `fact:secret:scenario:${scenario.id}:${clueId}`
}

/** @param {any} scenario @param {string} locationId */
function locationCard(scenario, locationId) {
  return scenario.locations.find((/** @type {any} */ entry) => entry.location_id === locationId) ?? null
}

/** @param {any} state */
function worldLocations(state) {
  return Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []
}

/** @param {unknown} value */
const nameKey = (value) => clean(value, 180).toLocaleLowerCase('ru').replace(/ё/gu, 'е')

/**
 * Точка карты мира по id или имени — так же, как переход находит место.
 * @param {any} state
 * @param {{ locationId?: unknown, name?: unknown }} input
 */
function worldLocationFor(state, { locationId = '', name = '' } = {}) {
  const id = clean(locationId, 120)
  const locations = worldLocations(state)
  return (id && locations.find((/** @type {any} */ entry) => clean(entry?.id, 120) === id))
    || (nameKey(name) && locations.find((/** @type {any} */ entry) => nameKey(entry?.name) === nameKey(name)))
    || null
}

/**
 * Карточка места для аргументов перехода. Место определяется так же, как в
 * переходе: по id, а без него — по имени точки карты мира.
 * @param {any} state
 * @param {any} sceneArgs
 */
export function scenarioSceneArgs(state, sceneArgs) {
  const scenario = campaignScenario(state)
  const args = sceneArgs && typeof sceneArgs === 'object' && !Array.isArray(sceneArgs) ? sceneArgs : {}
  if (!scenario) return args
  const location = worldLocationFor(state, { locationId: args.location_id ?? args.locationId, name: args.location })
  const card = location ? locationCard(scenario, clean(location.id, 120)) : null
  if (!card) return args
  return {
    ...args,
    location: clean(location.name, 120) || args.location,
    location_id: card.location_id,
    title: card.title,
    mood: card.mood,
    arrival: card.arrival,
    objective: card.objective,
    hook: card.objective,
  }
}

/**
 * Тайны карточки места со стабильными id. Их пишет переход сцены (`gm_only`);
 * находка заменяет тайну фактом `discovery`, и по нему узел узнаёт улику.
 * @param {any} state
 * @param {string} locationId
 * @returns {Array<{ fact_id: string, clue_id: string, clue: string, topic: string, skills: string[] }>}
 */
export function scenarioSecretsFor(state, locationId) {
  const scenario = campaignScenario(state)
  const card = scenario ? locationCard(scenario, clean(locationId, 120)) : null
  if (!card) return []
  return (card.secrets ?? []).map((/** @type {any} */ secret) => ({
    fact_id: scenarioClueFactId(scenario, secret.id),
    clue_id: secret.id,
    clue: secret.clue,
    topic: secret.topic,
    skills: [...secret.skills],
  }))
}

/** @param {any} state */
function foundClueFactIds(state) {
  const facts = Array.isArray(state?.worldMemory?.facts) ? state.worldMemory.facts : []
  return new Set(facts
    .filter((/** @type {any} */ fact) => fact?.predicate === 'discovery' && clean(fact.supersedes_fact_id, 200))
    .map((/** @type {any} */ fact) => clean(fact.supersedes_fact_id, 200)))
}

/** @param {any} state */
function visitedLocationIds(state) {
  const ids = new Set((Array.isArray(state?.adventure?.visitedLocationIds) ? state.adventure.visitedLocationIds : []).map((/** @type {unknown} */ id) => clean(id, 120)))
  for (const location of worldLocations(state)) if (location?.visited === true) ids.add(clean(location.id, 120))
  const current = currentLocationId(state)
  if (current) ids.add(current)
  ids.delete('')
  return ids
}

/** @param {any} state */
function leftLocationIds(state) {
  const history = Array.isArray(state?.adventure?.history) ? state.adventure.history : []
  const ids = new Set()
  for (const entry of history) {
    const byId = clean(entry?.location_id, 120)
    if (byId) ids.add(byId)
    else {
      const byName = worldLocationFor(state, { name: entry?.location })
      if (byName) ids.add(clean(byName.id, 120))
    }
  }
  return ids
}

/**
 * Место текущей сцены — id узла карты мира, даже если сцена знает его только
 * по имени.
 * @param {any} state
 */
export function scenarioLocationId(state) {
  return currentLocationId(state)
}

/** @param {any} state */
function currentLocationId(state) {
  const scene = state?.scene ?? {}
  return clean(scene.location_id ?? scene.locationId, 120)
    || clean(worldLocationFor(state, { name: scene.location })?.id, 120)
}

/** @param {any} state @param {string} npcId */
function npcDefeated(state, npcId) {
  if (state?.npc_world?.vitals?.[npcId]?.alive === false) return true
  const encounter = state?.mechanics?.encounter
  return Boolean(encounter?.status === 'ended'
    && encounter.outcome === 'enemies_defeated'
    && Array.isArray(encounter.enemy_ids) && encounter.enemy_ids.map(String).includes(npcId))
}

/**
 * @param {any} condition
 * @param {{ scenario: any, found: Set<string>, visited: Set<string>, left: Set<string>, state: any }} facts
 * @returns {boolean}
 */
function conditionMet(condition, facts) {
  if (Array.isArray(condition?.any)) return condition.any.some((/** @type {any} */ entry) => conditionMet(entry, facts))
  if (Array.isArray(condition?.all)) return condition.all.every((/** @type {any} */ entry) => conditionMet(entry, facts))
  if (Number.isSafeInteger(condition?.count)) {
    return condition.of.filter((/** @type {any} */ entry) => conditionMet(entry, facts)).length >= condition.count
  }
  if (condition?.clue) return facts.found.has(scenarioClueFactId(facts.scenario, condition.clue))
  if (condition?.left) return facts.left.has(condition.left)
  if (condition?.visited) return facts.visited.has(condition.visited)
  if (condition?.npc_defeated) return npcDefeated(facts.state, condition.npc_defeated)
  return false
}

/**
 * Встреча с главным противником финала — последняя записанная. Исход берётся
 * только у завершённой встречи в месте финала с записанным
 * `EncounterOutcomeRecorded`.
 * @param {any} state
 * @param {any} scenario
 */
function bossEncounterOutcome(state, scenario) {
  const finale = scenario.beats.find((/** @type {any} */ beat) => beat.kind === 'finale')
  const encounter = state?.mechanics?.encounter
  if (!finale || !encounter?.id || encounter.status !== 'ended') return ''
  if (!Array.isArray(encounter.enemy_ids) || !encounter.enemy_ids.map(String).includes(finale.boss.npc_id)) return ''
  // Развязку решает только бой в логове: стычка с ним в другом месте —
  // эпизод, а не финал кампании.
  const encounterLocationId = clean(worldLocationFor(state, { name: encounter.location })?.id, 120) || currentLocationId(state)
  if (encounterLocationId !== finale.boss.location_id) return ''
  const recorded = (Array.isArray(state?.autonomy?.encounter_outcomes) ? state.autonomy.encounter_outcomes : [])
    .some((/** @type {any} */ entry) => String(entry?.encounter_id) === String(encounter.id))
  return recorded ? clean(encounter.outcome, 60) : ''
}

/** @param {any} state @param {any} scenario */
function conditionFacts(state, scenario) {
  return {
    scenario,
    state,
    found: foundClueFactIds(state),
    visited: visitedLocationIds(state),
    left: leftLocationIds(state),
  }
}

/**
 * Карта мира с открытыми сюжетом местами и дорогами. Скрытое логово, тропа к
 * Древу и пещера контрабандистов становятся известны, когда отряд дошёл до
 * перевала, вошёл в лес или вышел на осведомителей. Открытие выводится из
 * состояния при нормализации, поэтому replay его повторяет, а переход сцены
 * записывает уже открытую карту в `SceneAdvanced`. Закрыть открытое оно не
 * может: условие считается только в сторону «известно».
 * @param {any} state
 * @param {any} worldMap
 */
export function applyScenarioMapReveals(state, worldMap) {
  const scenario = campaignScenario(state)
  if (!scenario || !Array.isArray(scenario.map_reveals) || !worldMap || typeof worldMap !== 'object') return worldMap
  const facts = conditionFacts({ ...state, worldMap }, scenario)
  const places = new Set()
  const roads = new Set()
  for (const reveal of scenario.map_reveals) {
    if (!conditionMet(reveal.when, facts)) continue
    for (const locationId of reveal.locations ?? []) places.add(locationId)
    for (const [from, to] of reveal.routes ?? []) roads.add([from, to].sort().join('\u0000'))
  }
  if (!places.size && !roads.size) return worldMap
  const locations = Array.isArray(worldMap.locations) ? worldMap.locations : []
  const routes = Array.isArray(worldMap.routes) ? worldMap.routes : []
  const needsChange = locations.some((/** @type {any} */ location) => places.has(location?.id) && location.known === false)
    || routes.some((/** @type {any} */ route) => roads.has([route?.from, route?.to].sort().join('\u0000')) && route.discovered === false)
  if (!needsChange) return worldMap
  return {
    ...worldMap,
    locations: locations.map((/** @type {any} */ location) => (places.has(location?.id) && location.known === false
      ? { ...location, known: true }
      : location)),
    routes: routes.map((/** @type {any} */ route) => (roads.has([route?.from, route?.to].sort().join('\u0000')) && route.discovered === false
      ? { ...route, discovered: true }
      : route)),
  }
}

/**
 * @typedef {{ id: string, kind: string, title: string, summary: string, location_ids: string[], completed: boolean }} ScenarioBeatProgress
 * @typedef {{ id: string, location_id: string, found: boolean }} ScenarioClueProgress
 * @typedef {{
 *   scenario_id: string,
 *   scenario_version: number,
 *   current_location_id: string,
 *   at_finale_approach: boolean,
 *   at_boss_location: boolean,
 *   boss: { npc_id: string, location_id: string, difficulty: string },
 *   boss_outcome: string,
 *   ending: { id: string, title: string, outcome: string } | null,
 *   beats: ScenarioBeatProgress[],
 *   clues: ScenarioClueProgress[],
 *   lines_completed: number,
 *   lines_total: number,
 * }} ScenarioProgress
 */

/**
 * Где отряд в сюжете. Всё выводится из состояния — отдельного счётчика нет.
 * @param {any} state
 * @returns {Readonly<ScenarioProgress> | null}
 */
export function scenarioProgress(state = {}) {
  const scenario = campaignScenario(state)
  if (!scenario) return null
  const facts = conditionFacts(state, scenario)
  const finale = scenario.beats.find((/** @type {any} */ beat) => beat.kind === 'finale')
  const bossOutcome = bossEncounterOutcome(state, scenario)
  const ending = bossOutcome
    ? scenario.endings.find((/** @type {any} */ entry) => entry.outcomes.includes(bossOutcome)) ?? null
    : null
  const beats = scenario.beats.map((/** @type {any} */ beat) => ({
    id: beat.id,
    kind: beat.kind,
    title: beat.title,
    summary: beat.summary ?? '',
    location_ids: [...beat.location_ids],
    completed: beat.kind === 'finale' ? Boolean(ending) : conditionMet(beat.complete_when, facts),
  }))
  const clues = scenario.locations.flatMap((/** @type {any} */ location) => (location.secrets ?? []).map((/** @type {any} */ secret) => ({
    id: secret.id,
    location_id: location.location_id,
    found: facts.found.has(scenarioClueFactId(scenario, secret.id)),
  })))
  const here = currentLocationId(state)
  return Object.freeze({
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    current_location_id: here,
    at_finale_approach: finale.location_ids.includes(here) && here !== finale.boss.location_id,
    at_boss_location: here === finale.boss.location_id,
    boss: { npc_id: finale.boss.npc_id, location_id: finale.boss.location_id, difficulty: finale.boss.difficulty },
    boss_outcome: bossOutcome,
    ending: ending ? { id: ending.id, title: ending.title, outcome: bossOutcome } : null,
    beats,
    clues,
    lines_completed: beats.filter((/** @type {any} */ beat) => beat.kind === 'line' && beat.completed).length,
    lines_total: beats.filter((/** @type {any} */ beat) => beat.kind === 'line').length,
  })
}

/**
 * Фаза темпа по сюжету: пролог и первая глава — передышка, линии — развитие,
 * подход к логову — нарастание, логово — кульминация.
 * @param {any} state
 */
export function scenarioPhase(state = {}) {
  const progress = scenarioProgress(state)
  if (!progress) return null
  if (progress.at_boss_location) return 'climax'
  if (progress.at_finale_approach) return 'escalation'
  const opening = progress.beats.filter((beat) => beat.kind === 'prologue' || beat.kind === 'chapter')
  return opening.every((beat) => beat.completed) ? 'development' : 'breather'
}

/**
 * Места, куда сюжет зовёт дальше, в порядке предпочтения. Сначала — места
 * незавершённых узлов, где отряд ещё не был; затем — места, где остались
 * ненайденные улики незавершённых узлов; финал — когда закрыто не меньше двух
 * линий или открытых линий не осталось. Выбор ближайшего по дорогам — за
 * политикой Режиссёра, у которой есть граф карты мира.
 * @param {any} state
 * @returns {string[]}
 */
export function scenarioDestinationIds(state = {}) {
  const scenario = campaignScenario(state)
  const progress = scenarioProgress(state)
  if (!scenario || !progress || progress.ending) return []
  const here = progress.current_location_id
  const visited = visitedLocationIds(state)
  const pending = progress.beats.filter((beat) => !beat.completed && beat.kind !== 'finale')
  const finale = scenario.beats.find((/** @type {any} */ beat) => beat.kind === 'finale')
  const unvisited = []
  const revisit = []
  for (const beat of pending) {
    for (const locationId of beat.location_ids) {
      if (locationId === here) continue
      const hasOpenClue = progress.clues.some((clue) => clue.location_id === locationId && !clue.found)
      if (!visited.has(locationId)) unvisited.push(locationId)
      else if (hasOpenClue) revisit.push(locationId)
    }
  }
  const opening = pending.filter((beat) => beat.kind !== 'line').flatMap((beat) => beat.location_ids)
  // Финал зовёт, когда закрыты две линии или когда в открытых линиях не
  // осталось мест, где отряд ещё не был: возвращаться за пропущенной уликой —
  // выбор стола, а не Режиссёра. Прогон Асстохана 2026-10-06 без этого
  // правила тринадцать сцен ходил между Миттлайдом, лагерем, Редстоуновкой и
  // башней и так и не дошёл до логова.
  const lineUnvisited = pending.filter((beat) => beat.kind === 'line')
    .flatMap((beat) => beat.location_ids)
    .filter((id) => id !== here && !visited.has(id))
  const finaleReady = progress.lines_completed >= Math.min(2, progress.lines_total) || !lineUnvisited.length
  const finaleIds = here !== finale.boss.location_id ? [finale.boss.location_id] : []
  // Пролог и первая глава не открыты — сначала они: финал до заставы — это
  // не свобода, а пропущенная завязка.
  if (opening.some((id) => id !== here)) {
    return [...new Set([...unvisited.filter((id) => opening.includes(id)), ...unvisited])]
  }
  if (finaleReady) return [...new Set([...finaleIds, ...unvisited])]
  return [...new Set(unvisited.length ? unvisited : [...revisit, ...finaleIds])]
}

/**
 * Встреча, которую Режиссёр собирает в текущем месте: главный противник в
 * логове, пока он жив и бой с ним не завершён, иначе — встреча карточки места.
 * `null` — у места нет своей встречи.
 * @param {any} state
 * @returns {{ npc_id: string, difficulty: string } | { theme: string, difficulty: string } | null}
 */
export function scenarioEncounterFor(state = {}) {
  const scenario = campaignScenario(state)
  const progress = scenarioProgress(state)
  if (!scenario || !progress) return null
  if (progress.at_boss_location && !progress.boss_outcome
    && state?.npc_world?.vitals?.[progress.boss.npc_id]?.alive !== false) {
    return { npc_id: progress.boss.npc_id, difficulty: progress.boss.difficulty }
  }
  const card = locationCard(scenario, progress.current_location_id)
  return card?.encounter ? { theme: card.encounter.theme, difficulty: card.encounter.difficulty } : null
}

/**
 * Развязка кампании по сценарию: исход боя с главным противником. Текст
 * эпилога — авторский; модель может его переписать, но не выбрать другой исход.
 * @param {any} state
 * @returns {{ id: string, title: string, outcome: string, epilogue: string } | null}
 */
export function scenarioEnding(state = {}) {
  const scenario = campaignScenario(state)
  const progress = scenarioProgress(state)
  if (!scenario || !progress?.ending) return null
  const ending = scenario.endings.find((/** @type {any} */ entry) => entry.id === progress.ending?.id)
  return ending ? { id: ending.id, title: ending.title, outcome: progress.boss_outcome, epilogue: ending.epilogue } : null
}

/**
 * Что Режиссёр-модель знает о сюжете: узлы, найденные улики и куда звать.
 * Тексты тайн сюда не входят — их видит только хранитель находки.
 * @param {any} state
 */
export function scenarioDirectorBrief(state = {}) {
  const scenario = campaignScenario(state)
  const progress = scenarioProgress(state)
  if (!scenario || !progress) return null
  const names = new Map(worldLocations(state).map((/** @type {any} */ entry) => [clean(entry.id, 120), clean(entry.name, 120)]))
  return {
    scenario: scenario.title,
    beats: progress.beats.map((beat) => ({ title: beat.title, kind: beat.kind, completed: beat.completed })),
    clues_found: progress.clues.filter((clue) => clue.found).length,
    clues_total: progress.clues.length,
    next_destinations: scenarioDestinationIds(state).map((id) => names.get(id) || id).slice(0, 4),
    at_boss_location: progress.at_boss_location,
  }
}
