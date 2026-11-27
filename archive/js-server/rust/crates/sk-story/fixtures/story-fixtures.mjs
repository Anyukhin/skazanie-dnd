// Общая часть генераторов эталонов sk-story для диалогов кампании и разбора
// намерения: таблица функций, урезание состояний и вызов JS.
//
// Писатель эталона, ГПСЧ и чтение корпуса — общие с sk-world-story
// (`../../sk-world-story/fixtures/story-lib.mjs`, только чтение).
//
// Состояние урезается до полей, которые читает модуль; JS исполняется на
// урезанном входе и сверяется с исходом на полном — в эталон идёт урезанный
// вход, только если исход тот же. Не сошлось ни на одном уровне — случай
// отбрасывается (полное состояние кампании в эталон не кладётся).
import { viaJson, same, pickKeys } from '../../sk-world-story/fixtures/story-lib.mjs'

export * from '../../sk-world-story/fixtures/story-lib.mjs'

const root = new URL('../../../../', import.meta.url)
export const D = await import(new URL('server/campaign-dialogues.mjs', root).href)
export const P = await import(new URL('server/intent-parser.mjs', root).href)

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const parser = new P.IntentParser()

/** Вызов функции модуля по имени эталона; аргументы — как в эталоне. */
export const RUNNERS = {
  dialogueActionChecks: (action) => D.dialogueActionChecks(action),
  normalizeDialogues: (raw) => D.normalizeDialogues(raw),
  dialogueFor: (state, npcId) => D.dialogueFor(state, npcId),
  dialogueProgress: (state, id) => D.dialogueProgress(state, id),
  dialogueFlags: (state) => D.dialogueFlags(state),
  dialogueRevealFactId: (state, result) => D.dialogueRevealFactId(state, result),
  dialogueGrantedFactIds: (state) => D.dialogueGrantedFactIds(state),
  // Диалог и вариант — из каталога: в эталоне они записаны по id.
  dialogueOptionUnlocked: (state, dialogueId, optionId) => {
    const dialogue = D.DIALOGUES.find((entry) => entry.id === dialogueId)
    return D.dialogueOptionUnlocked(state, dialogue, dialogue.options.find((entry) => entry.id === optionId))
  },
  dialogueOptionsFor: (state, npcId, heroId) => D.dialogueOptionsFor(state, npcId, heroId),
  normalizeDialogueState: (value) => D.normalizeDialogueState(value),
  applyDialogueEvent: (value, event) => D.applyDialogueEvent(value, event),
  sceneDialoguesForViewer: (state, viewer) => D.sceneDialoguesForViewer(state, viewer),
  dialogueCheckLine: (check) => D.dialogueCheckLine(check),

  normalizeRequestKind: (value) => P.normalizeRequestKind(value),
  inferRequestKind: (value) => P.inferRequestKind(value),
  isSceneObservationRequest: (value) => P.isSceneObservationRequest(value),
  waitTargetFromText: (value) => P.waitTargetFromText(value),
  classifyFreeActionKind: (value) => P.classifyFreeActionKind(value),
  actionSequence: (value) => P.actionSequence(value),
  sameNameToken: (left, right) => P.sameNameToken(left, right),
  resolvePresentSocialActors: (message, state) => P.resolvePresentSocialActors(message, state),
  namedKnownSpell: (text, state, playerId) => P.namedKnownSpell(text, state, playerId),
  buildRuleQueries: (intent, state) => P.buildRuleQueries(intent, state),
  'IntentParser.parse': (message, playerId, visibleState) => parser.__parseSync({ message, playerId, visibleState }),
}

/** Индексы аргументов-состояний и вид урезания. */
export const STATE_ARGS = {
  dialogueFor: [0], dialogueProgress: [0], dialogueFlags: [0], dialogueRevealFactId: [0], dialogueGrantedFactIds: [0],
  dialogueOptionUnlocked: [0], dialogueOptionsFor: [0], sceneDialoguesForViewer: [0],
  resolvePresentSocialActors: [1], namedKnownSpell: [1], buildRuleQueries: [1], 'IntentParser.parse': [2],
}
export const MODULE_OF = Object.fromEntries(Object.keys(RUNNERS).map((name) => [name, name in D || name === 'dialogueOptionUnlocked' ? 'campaign-dialogues' : 'intent-parser']))

const SCENARIO_FACT = /^fact:secret:scenario:/u
function slimMemory(memory) {
  if (!isObject(memory)) return memory
  const out = {}
  if (memory.facts !== undefined) {
    out.facts = Array.isArray(memory.facts)
      ? memory.facts.filter((fact) => !isObject(fact) || ['discovery', 'gm_secret'].includes(fact.predicate) || SCENARIO_FACT.test(String(fact.id ?? '')))
        .map((fact) => pickKeys(fact, fact?.predicate === 'gm_secret' ? ['id', 'predicate', 'object'] : ['id', 'predicate', 'supersedes_fact_id']))
      : memory.facts
  }
  if (memory.knowledge_revealed !== undefined) {
    out.knowledge_revealed = Array.isArray(memory.knowledge_revealed) ? memory.knowledge_revealed.map((entry) => pickKeys(entry, ['fact_id'])) : memory.knowledge_revealed
  }
  return out
}
function slimConcept(concept) {
  if (!isObject(concept)) return concept
  const out = pickKeys(concept, ['campaign_mode', 'arc'])
  if (isObject(out.arc)) out.arc = pickKeys(out.arc, ['version', 'scenario_id', 'scenario_version'])
  return out
}
const ACTOR_KEYS = ['id', 'name', 'character', 'label', 'aliases', 'role', 'tags', 'available', 'location', 'knownSpellIds', 'preparedSpellIds', 'visibility', 'reveal_on_presence']
const list = (value, keys) => (Array.isArray(value) ? value.map((entry) => pickKeys(entry, keys)) : value)

const DIALOGUE_NPC_KEYS = ['id', 'available', 'location', 'visibility', 'reveal_on_presence']

function slimCommon(state, dialogue = false) {
  const out = pickKeys(state, ['dialogues', 'scenario_knight', 'scenario_attention', 'partyMemberIds', 'ruleset_id'])
  if (state.campaignConcept !== undefined) out.campaignConcept = slimConcept(state.campaignConcept)
  if (state.worldMemory !== undefined) out.worldMemory = slimMemory(state.worldMemory)
  if (state.scene !== undefined) out.scene = pickKeys(state.scene, ['location', 'location_id', 'locationId', 'id', 'name'])
  if (state.mechanics !== undefined) {
    const mechanics = state.mechanics
    out.mechanics = isObject(mechanics)
      ? Object.fromEntries([['world_time', isObject(mechanics.world_time) ? pickKeys(mechanics.world_time, ['elapsed_minutes']) : mechanics.world_time], ['combat', isObject(mechanics.combat) ? pickKeys(mechanics.combat, ['active']) : mechanics.combat]].filter(([key]) => mechanics[key] !== undefined))
      : mechanics
  }
  if (state.npc_world !== undefined) out.npc_world = isObject(state.npc_world) ? pickKeys(state.npc_world, ['vitals']) : state.npc_world
  if (state.social !== undefined) out.social = isObject(state.social) ? { ...(state.social.npcs !== undefined ? { npcs: list(state.social.npcs, dialogue ? DIALOGUE_NPC_KEYS : ACTOR_KEYS) } : {}) } : state.social
  if (!dialogue) for (const key of ['players', 'actors', 'enemies', 'merchants']) if (state[key] !== undefined) out[key] = list(state[key], ACTOR_KEYS)
  return out
}
function slimWide(state) {
  const out = slimCommon(state)
  for (const key of ['worldMap', 'adventure', 'autonomy', 'worldMemory', 'scene', 'mechanics', 'social', 'players', 'actors', 'enemies', 'merchants']) if (state[key] !== undefined) out[key] = state[key]
  return out
}
const STRIPS = [(state) => (isObject(state) ? slimCommon(state) : state), (state) => (isObject(state) ? slimWide(state) : state)]
const DIALOGUE_STRIPS = [(state) => (isObject(state) ? slimCommon(state, true) : state), ...STRIPS]

export function outcome(name, args) {
  try {
    return { value: viaJson(RUNNERS[name](...args.map(viaJson))) }
  } catch (error) {
    return { error: String(error?.name) + String(error?.message) }
  }
}

export const stats = { stripped: 0, widened: 0, dropped: 0 }

/** Урезанные аргументы с тем же исходом или `null`. */
export function prepare(name, args, quietly = (fn) => fn()) {
  if (name === 'applyDialogueEvent' && isObject(args[1])) {
    // Событие свёртки — до полей, которые читает редьюсер разговоров.
    const event = pickKeys(args[1], ['event_type', 'payload'])
    if (isObject(event.payload)) event.payload = pickKeys(event.payload, ['dialogue_id', 'option_id', 'hero_id', 'sets', 'check', 'granted_fact_id'])
    const candidate = [viaJson(args[0]), viaJson(event)]
    if (same(quietly(() => outcome(name, candidate)), quietly(() => outcome(name, args)))) return candidate
  }
  const indexes = STATE_ARGS[name] ?? []
  if (!indexes.length) return args.map(viaJson)
  const expected = quietly(() => outcome(name, args))
  const strips = MODULE_OF[name] === 'campaign-dialogues' ? DIALOGUE_STRIPS : STRIPS
  for (const [level, strip] of strips.entries()) {
    const candidate = args.map((arg, i) => viaJson(indexes.includes(i) ? strip(arg) : arg))
    if (same(quietly(() => outcome(name, candidate)), expected)) {
      stats[level === 0 ? 'stripped' : 'widened'] += 1
      return candidate
    }
  }
  stats.dropped += 1
  return null
}

/** Перехваченный вызов в аргументы эталона (`null` — не записывать). */
export function captureArgs(module, name, args) {
  if (module === 'server/intent-parser.mjs' && name === 'IntentParser.parse') {
    const input = args[0] ?? {}
    return ['IntentParser.parse', [input.message, input.playerId, input.visibleState]]
  }
  if (name === 'dialogueOptionUnlocked') {
    const [state, dialogue, item] = args
    if (!D.DIALOGUES.includes(dialogue) || !dialogue.options.includes(item)) return null
    return [name, [state, dialogue.id, item.id]]
  }
  return RUNNERS[name] ? [name, args] : null
}

export { isObject }
