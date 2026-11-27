// Общая часть эталона server/campaign-loop-policy.mjs: урезание состояний,
// кодирование аргументов и исхода вызова.
//
// Урезание проверяется исходом: вызов на урезанном входе обязан ответить так
// же, как на полном (`sameOutcome`), иначе берётся ступень слабее, а при
// расхождении и на ней — случай отбрасывается.

/** Аргумент `undefined` в JSON: та же метка, что `sk_core::js::UNDEFINED`. */
export const UNDEF = '\u0000undefined'

export const encodeArgs = (args) => args.map((arg) => (arg === undefined ? UNDEF : arg))
export const decodeArgs = (args) => args.map((arg) => (arg === UNDEF ? undefined : arg))

/** Функции модуля и номер аргумента-состояния (или `-1`). */
export const FUNCTIONS = {
  abandonedQuestsForDirector: 0,
  directorObjectiveAfterQuestAbandonment: 0,
  questWasAbandonedInPlace: -1,
  affirmativePlayerAction: -1,
  arcSeedFor: -1,
  buildCampaignArcPlan: -1,
  campaignArcPlan: 0,
  confirmedQuestProgress: 0,
  mainQuestFor: 0,
  campaignArcClimaxSatisfied: 0,
  campaignArcPosition: 0,
  scenarioEncounterIntent: 0,
  authorizeDirectorIntent: 0,
  directorProgressFingerprint: 0,
  pacingForDirectorIntent: 0,
  nextWorldMapDestination: 0,
  planServerTravel: 0,
  assembleSocialNpc: 0,
  completedDowntime: 0,
}

/** Экспорты-объявления функций: их можно обернуть в хуке загрузки. */
export const HOOKABLE = Object.keys(FUNCTIONS).filter((name) => name !== 'arcSeedFor')

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const pick = (value, keys) => {
  if (!plain(value)) return value
  const out = {}
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key]
  return out
}

const mapList = (value, fn) => (Array.isArray(value) ? value.map(fn) : value)

/** Клетки сцены: модуль считает только раскрытые. */
const markCells = (cells) => (Array.isArray(cells) ? cells.filter((cell) => cell?.revealed === true).map(() => ({ revealed: true })) : cells)

/** Слабая ступень: убрать только тяжёлое (карты, клетки, лавки). */
export function slimLight(state) {
  if (!plain(state)) return state
  const out = { ...state }
  for (const key of ['locationMaps', 'merchants', 'battleLog', 'economyLog', 'mapFeedback', 'rulings', 'messages']) delete out[key]
  if (plain(state.scene)) {
    out.scene = { ...state.scene }
    delete out.scene.map
    if (Object.hasOwn(state.scene, 'cells')) out.scene.cells = markCells(state.scene.cells)
  }
  return out
}

const NPC_KEYS = ['id', 'name', 'role', 'location', 'location_id', 'locationId', 'available', 'visibility', 'tags', 'known_fact_ids', 'faction_id']

/** Сильная ступень: только поля, которые читают модуль и его соседи. */
export function slimStrong(state) {
  if (!plain(state)) return state
  const out = pick(state, ['sessionCode', 'campaign_id', 'partyMemberIds', 'adventure', 'worldMap', 'scenario_attention'])
  if (state.players !== undefined) out.players = mapList(state.players, (hero) => pick(hero, ['id', 'name']))
  if (state.enemies !== undefined) out.enemies = mapList(state.enemies, (enemy) => pick(enemy, ['id', 'alive', 'hp']))
  if (state.scene !== undefined) {
    out.scene = pick(state.scene, ['title', 'location', 'location_id', 'locationId', 'objective', 'scene_kind', 'cells'])
    if (plain(out.scene) && Object.hasOwn(out.scene, 'cells')) out.scene.cells = markCells(out.scene.cells)
  }
  if (state.mechanics !== undefined) {
    out.mechanics = pick(state.mechanics, ['combat', 'encounter', 'campaign_lifecycle', 'world_time', 'death'])
    if (plain(out.mechanics) && plain(out.mechanics.combat)) out.mechanics.combat = pick(out.mechanics.combat, ['active'])
  }
  if (state.worldMemory !== undefined) out.worldMemory = pick(state.worldMemory, ['quests', 'facts', 'entities'])
  if (state.autonomy !== undefined) {
    out.autonomy = pick(state.autonomy, ['pacing', 'director_history', 'director_outcomes', 'encounter_outcomes', 'travel_history', 'scene_resolutions'])
  }
  if (state.campaignConcept !== undefined) out.campaignConcept = pick(state.campaignConcept, ['arc', 'campaign_mode', 'story_quest_id'])
  if (state.social !== undefined) {
    out.social = plain(state.social) ? pick({ ...state.social, npcs: mapList(state.social.npcs, (npc) => pick(npc, NPC_KEYS)) }, ['npcs']) : state.social
  }
  if (state.npc_world !== undefined) out.npc_world = pick(state.npc_world, ['vitals'])
  return out
}

/** Исход вызова в форме эталона. */
export function outcome(fn, args) {
  try {
    const value = fn(...args)
    return value === undefined ? { undef: true } : { out: JSON.parse(JSON.stringify(value)) }
  } catch (error) {
    if (error?.name === 'DirectorIntentError') return { error: { code: error.code, message: error.message } }
    return { throws: error?.name ?? 'Error' }
  }
}

export const sameOutcome = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/**
 * Урезанные аргументы с тем же исходом, что у полных, или `null`.
 * Возвращает `{ args, result }`, где `result` — исход на урезанных.
 */
export function slimmedCase(fn, args, stateIndex, full = outcome(fn, structuredClone(args))) {
  if (stateIndex < 0 || !plain(args[stateIndex])) return { args, result: full }
  for (const slim of [slimStrong, slimLight]) {
    const candidate = args.slice()
    candidate[stateIndex] = slim(args[stateIndex])
    const result = outcome(fn, structuredClone(candidate))
    if (sameOutcome(result, full)) return { args: candidate, result }
  }
  return null
}
