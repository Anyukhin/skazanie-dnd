import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

const LIVE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const FIXED_NOW = '2026-09-16T12:00:00.000Z'
const FIXED_NOW_MS = Date.parse(FIXED_NOW)
const REPLAY_VARIANTS = Object.freeze([
  ['v14', 14],
  ['absent_legacy', null],
  ['v15', 15],
])

const WORLD_LIMITS = Object.freeze({
  entities: 500,
  facts: 2_000,
  relationships: 2_000,
  quests: 300,
  threads: 500,
  epistemic_claims: 2_000,
  summaries: 1_000,
  knowledge_ledger: 5_000,
})

const SCENARIO_NAMES = Object.freeze([
  'smallordinarymove',
  'heal',
  'item',
  'malformed',
  'refusal',
  'npcdeath',
  'longworldmemory',
])

function clone(value) {
  return structuredClone(value)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value)) ?? 'undefined'
}

function preview(value) {
  let encoded
  try { encoded = stableJson(value) } catch { encoded = String(value) }
  return encoded.length > 1_000 ? `${encoded.slice(0, 1_000)}…` : encoded
}

function firstDiff(left, right, path = '$') {
  if (Object.is(left, right)) return null
  if (left === null || right === null || typeof left !== typeof right) {
    return { path, baseline: preview(left), live: preview(right) }
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return { path, baseline: preview(left), live: preview(right) }
    if (left.length !== right.length) return { path: `${path}.length`, baseline: left.length, live: right.length }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDiff(left[index], right[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return null
  }
  if (typeof left === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    for (const key of keys) {
      if (!(key in left) || !(key in right)) return { path: `${path}.${key}`, baseline: preview(left[key]), live: preview(right[key]) }
      const difference = firstDiff(left[key], right[key], `${path}.${key}`)
      if (difference) return difference
    }
    return null
  }
  return { path, baseline: preview(left), live: preview(right) }
}

function compare(id, baseline, live) {
  const baselineJson = stableJson(baseline)
  const liveJson = stableJson(live)
  const equal = baselineJson === liveJson
  return {
    id,
    equal,
    baseline_sha256: createHash('sha256').update(baselineJson).digest('hex'),
    live_sha256: createHash('sha256').update(liveJson).digest('hex'),
    baseline_bytes: Buffer.byteLength(baselineJson, 'utf8'),
    live_bytes: Buffer.byteLength(liveJson, 'utf8'),
    ...(equal ? {} : { first_diff: firstDiff(baseline, live) }),
  }
}

function capture(operation) {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        code: error?.code ?? null,
        message: String(error?.message ?? error),
      },
    }
  }
}

function moduleUrl(root, relativePath) {
  return pathToFileURL(resolve(root, relativePath)).href
}

function assertRoot(root, label) {
  const resolved = resolve(root)
  if (!existsSync(resolve(resolved, 'server/rules-engine.mjs'))) {
    throw new Error(`${label} не содержит server/rules-engine.mjs: ${resolved}`)
  }
  return resolved
}

async function loadRuntime(root, label) {
  const resolved = assertRoot(root, label)
  const [rules, dice, items, viewer, world, fixture] = await Promise.all([
    import(moduleUrl(resolved, 'server/rules-engine.mjs')),
    import(moduleUrl(resolved, 'server/dice-service.mjs')),
    import(moduleUrl(resolved, 'server/item-catalog.mjs')),
    import(moduleUrl(resolved, 'server/viewer-projection.mjs')),
    import(moduleUrl(resolved, 'server/world-memory.mjs')),
    import(moduleUrl(resolved, 'test/shared-npc-consequence-fixture.mjs')),
  ])
  return { label, root: resolved, rules, dice, items, viewer, world, fixture }
}

function installDeterminism() {
  const NativeDate = globalThis.Date
  const previousApiKey = process.env.ROUTERAI_API_KEY
  const previousBaseUrl = process.env.ROUTERAI_BASE_URL
  class FixedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [FIXED_NOW_MS]))
    }

    static now() {
      return FIXED_NOW_MS
    }
  }
  globalThis.Date = FixedDate
  // dotenv не перезаписывает заданное значение. Пустой ключ дополнительно
  // исключает случайный вызов провайдера при загрузке фикстуры.
  process.env.ROUTERAI_API_KEY = ''
  process.env.ROUTERAI_BASE_URL = ''
  return () => {
    globalThis.Date = NativeDate
    if (previousApiKey === undefined) delete process.env.ROUTERAI_API_KEY
    else process.env.ROUTERAI_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.ROUTERAI_BASE_URL
    else process.env.ROUTERAI_BASE_URL = previousBaseUrl
  }
}

function diceFor(runtime, values, prefix) {
  let id = 0
  return new runtime.dice.DiceService({
    rng: new runtime.dice.SequenceDiceRng(values),
    idFactory: () => `${prefix}-${++id}`,
    now: () => FIXED_NOW,
  })
}

function taggedEvents(events, marker, stateVersion) {
  return events.map((event, index) => {
    const tagged = clone(event)
    tagged.state_version_before = stateVersion + index
    tagged.state_version_after = stateVersion + index + 1
    // Старый commit хранит границы версий событий, но не хранит marker на
    // каждом событии. Для чистого reducer replay это и есть сигнал legacy.
    if (marker == null) delete tagged.reducer_version
    else tagged.reducer_version = marker
    return tagged
  })
}

function memoryProbe() {
  return {
    schema_version: 2,
    entities: [
      { id: 'memory-public', kind: 'npc', name: 'Публичный свидетель', summary: 'Видимая запись.', visibility: 'party' },
      { id: 'memory-secret', kind: 'npc', name: 'Тайный свидетель', summary: 'Закрытая запись.', visibility: 'gm_only' },
    ],
    facts: [
      { id: 'memory-public-fact', subject_id: 'memory-public', predicate: 'present', object: 'Он был на площади.', summary: 'Свидетель был на площади.', visibility: 'party', source_event_ids: ['memory-seed'], source_command_id: 'memory-seed' },
      { id: 'memory-secret-fact', subject_id: 'memory-secret', predicate: 'secret', object: 'Он видел тайный знак.', summary: 'Тайный свидетель видел знак.', visibility: 'gm_only', source_event_ids: ['memory-secret-seed'], source_command_id: 'memory-secret-seed' },
    ],
    relationships: [], quests: [], threads: [], epistemic_claims: [], summaries: [],
    knowledge_ledger: [{ id: 'memory-knowledge-a', hero_id: 'hero-a', fact_id: 'memory-secret-fact', summary: 'Герой видел этот факт.', source_event_ids: ['memory-reveal'], source_command_id: 'memory-reveal', source_kind: 'knowledge_revealed', recorded_at_minutes: 0 }],
    knowledge: { 'hero-a': ['memory-secret-fact'] },
  }
}

function smallRawState(runtime, { targetX = 1, item = null } = {}) {
  const cells = Array.from({ length: 8 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const hero = {
    id: 'hero-a', character: 'Бранн', role: 'Воин · ур. 3', characterClass: 'fighter', level: 3,
    hp: 12, maxHp: 20, armor: 16, speed: 30, proficiency: 2,
    abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, x: 0, y: 0,
    inventory: item ? [item] : [],
  }
  const ally = {
    id: 'hero-b', character: 'Лира', role: 'Жрец · ур. 3', characterClass: 'cleric', level: 3,
    hp: 8, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 16, cha: 12 }, x: targetX, y: 0,
    inventory: [],
  }
  const foe = { id: 'training-foe', name: 'Учебный гоблин', hp: 20, maxHp: 20, armor: 12, speed: 30, abilities: { dex: 14 }, x: 6, y: 0, alive: true }
  return {
    sessionCode: 'EQUIVALENCE-SMALL', ruleset_id: 'srd_5_2_1', partyMemberIds: ['hero-a', 'hero-b'], activePlayerId: 'hero-a',
    players: [hero, ally], enemies: [foe], scene: { turn: 1, cells }, worldMemory: memoryProbe(),
    mechanics: {
      positions: { 'hero-a': { x: 0, y: 0 }, 'hero-b': { x: targetX, y: 0 }, 'training-foe': { x: 6, y: 0 } },
      conditions: {}, death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero-a', total: 18 }, { actor_id: 'hero-b', total: 12 }, { actor_id: 'training-foe', total: 8 }],
        action_economy: {
          'hero-a': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'hero-b': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'training-foe': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  }
}

function smallState(runtime, options = {}) {
  return runtime.rules.normalizeCampaignState(smallRawState(runtime, options))
}

function viewerIdsForSmall() {
  return ['hero-a', 'hero-b']
}

function viewers(runtime, state, actorIds) {
  return Object.fromEntries(actorIds.map((actorId) => [actorId, runtime.viewer.campaignStateForViewer(
    state,
    { role: 'player', heroIds: [actorId] },
    actorId,
  )]))
}

function privateVisibility(runtime, viewMap) {
  return Object.fromEntries(Object.entries(viewMap).map(([actorId, view]) => [actorId, {
    secret_fact_visible: (view.worldMemory?.facts ?? []).some((fact) => fact.id === 'memory-secret-fact'),
    secret_entity_visible: (view.worldMemory?.entities ?? []).some((entity) => entity.id === 'memory-secret'),
  }]))
}

function independentQuest() {
  return {
    id: 'quest:equivalence-independent-road', title: 'Самостоятельная дорога', summary: 'Независимая цель отряда.', status: 'active', visibility: 'party', entity_ids: [],
    objectives: ['Найти безопасную дорогу на юг.'], clock: { current: 1, max: 4, label: 'Поиск дороги' },
  }
}

function discoverQuest(kingId) {
  return {
    id: 'quest:equivalence-discover-fate', title: 'Установить судьбу правителя', summary: 'Нужно подтвердить судьбу правителя.', status: 'active', visibility: 'party', entity_ids: [kingId],
    objectives: ['Получить подтверждение судьбы правителя'], clock: { current: 1, max: 4, label: 'Судьба правителя' },
  }
}

function addObserver(runtime, state, anchor) {
  const observer = {
    id: 'hero-b', character: 'Наблюдатель', role: 'Следопыт · ур. 3', characterClass: 'ranger', level: 3,
    hp: 18, maxHp: 18, armor: 14, speed: 30, proficiency: 2,
    abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, x: anchor.x, y: anchor.y, inventory: [],
  }
  return runtime.rules.normalizeCampaignState({
    ...clone(state),
    partyMemberIds: [...new Set([...(state.partyMemberIds ?? []), observer.id])],
    players: [...(state.players ?? []), observer],
    mechanics: {
      ...(state.mechanics ?? {}),
      positions: { ...(state.mechanics?.positions ?? {}), [observer.id]: { ...anchor } },
      combat: state.mechanics?.combat ? {
        ...state.mechanics.combat,
        action_economy: { ...(state.mechanics.combat.action_economy ?? {}), [observer.id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      } : state.mechanics?.combat,
    },
  })
}

function largeWorldMemory() {
  const count = (name) => WORLD_LIMITS[name] + 1
  const entities = Array.from({ length: count('entities') }, (_, index) => ({
    id: `entity-long-${String(index).padStart(4, '0')}`, kind: index % 3 === 0 ? 'npc' : 'concept', name: `Долгая сущность ${index}`, summary: `Сущность длинной кампании ${index}.`, visibility: 'party', aliases: [], tags: [],
  }))
  const facts = Array.from({ length: count('facts') }, (_, index) => ({
    id: `fact-long-${String(index).padStart(5, '0')}`, subject_id: entities[index % entities.length].id, predicate: 'long_history', object: `Подтверждённая запись ${index}.`, summary: `Запись длинной истории ${index}.`, visibility: 'party', source_event_ids: [`long-event-${index}`], source_command_id: `long-command-${index}`, status: 'active', recorded_at_minutes: index,
  }))
  const relationships = Array.from({ length: count('relationships') }, (_, index) => ({
    id: `relationship-long-${String(index).padStart(5, '0')}`, from_entity_id: entities[index % entities.length].id, relation: 'knows', to_entity_id: entities[(index + 1) % entities.length].id, summary: `Связь ${index}.`, visibility: 'party', source_event_ids: [`long-relation-event-${index}`], source_command_id: `long-relation-command-${index}`, status: 'active', recorded_at_minutes: index,
  }))
  const quests = Array.from({ length: count('quests') }, (_, index) => ({
    id: `quest-long-${String(index).padStart(4, '0')}`, title: `Задание ${index}`, summary: `Длинное задание ${index}.`, status: 'active', visibility: 'party', entity_ids: [entities[index % entities.length].id], objectives: [`Цель ${index}`], clock: { current: 0, max: 4, label: `Часы ${index}` }, recorded_at_minutes: index,
  }))
  const threads = Array.from({ length: count('threads') }, (_, index) => ({
    id: `thread-long-${String(index).padStart(4, '0')}`, title: `Нить ${index}`, summary: `Длинная нить ${index}.`, status: 'active', visibility: 'party', entity_ids: [entities[index % entities.length].id], quest_ids: [quests[index % quests.length].id], clock: { current: 0, max: 4, label: `Нить ${index}` }, source_event_ids: [`long-thread-event-${index}`], source_command_id: `long-thread-command-${index}`, recorded_at_minutes: index,
  }))
  const epistemicClaims = Array.from({ length: count('epistemic_claims') }, (_, index) => ({
    id: `claim-long-${String(index).padStart(5, '0')}`, kind: 'belief', holder_entity_id: entities[index % entities.length].id, subject_entity_id: entities[(index + 1) % entities.length].id, predicate: 'believes', claim: `Убеждение ${index}.`, summary: `Убеждение ${index}.`, visibility: 'party', truth_status: 'unknown', source_event_ids: [`long-claim-event-${index}`], source_command_id: `long-claim-command-${index}`, recorded_at_minutes: index,
  }))
  const summaries = Array.from({ length: count('summaries') }, (_, index) => ({
    id: `summary-long-${String(index).padStart(4, '0')}`, kind: 'scene', title: `Сводка ${index}`, summary: `Сводка длинной кампании ${index}.`, visibility: 'party', entity_ids: [entities[index % entities.length].id], thread_ids: [threads[index % threads.length].id], source_event_ids: [`long-summary-event-${index}`], source_command_id: `long-summary-command-${index}`, recorded_at_minutes: index,
  }))
  const knowledgeLedger = Array.from({ length: WORLD_LIMITS.knowledge_ledger + 1 }, (_, index) => ({
    id: `knowledge-long-${String(index).padStart(5, '0')}`, hero_id: index % 2 ? 'hero-a' : 'hero-b', fact_id: facts[index % facts.length].id, summary: `Знание ${index}.`, source_event_ids: [`long-knowledge-event-${index}`], source_command_id: `long-knowledge-command-${index}`, source_kind: 'knowledge_revealed', recorded_at_minutes: index,
  }))
  return {
    schema_version: 2, entities, facts, relationships, quests, threads, epistemic_claims: epistemicClaims, summaries,
    knowledge_ledger: knowledgeLedger,
    knowledge: { 'hero-a': facts.slice(0, 20).map((fact) => fact.id), 'hero-b': facts.slice(20, 40).map((fact) => fact.id) },
  }
}

function longStateRaw(runtime) {
  const raw = smallRawState(runtime, { targetX: 1 })
  raw.sessionCode = 'EQUIVALENCE-LONG'
  raw.worldMemory = largeWorldMemory()
  return raw
}

function scenarioFor(runtime, name) {
  switch (name) {
    case 'smallordinarymove':
      return {
        name, initial: smallState(runtime, { targetX: 3 }), viewerIds: viewerIdsForSmall(),
        steps: [{ command: { command_type: 'MoveActor', command_id: 'equivalence-move', actor_id: 'hero-a', to: { x: 1, y: 0 }, server_authoritative: true }, context: { allowedActorIds: ['hero-a'], serverAuthoritativeCombat: true } }],
      }
    case 'heal':
      return {
        name, initial: smallState(runtime), viewerIds: viewerIdsForSmall(),
        steps: [{ command: { command_type: 'ApplyHealing', command_id: 'equivalence-heal', actor_id: 'hero-a', target_id: 'hero-b', expression: '1d4+1', server_authoritative: true }, context: { allowedActorIds: ['hero-a'], serverAuthoritativeCombat: true } }], dice: [3],
      }
    case 'item': {
      const potion = runtime.items.materializeCatalogItem('srd_5_2_1:potion-of-healing', { id: 'equivalence-potion', quantity: 1 })
      return {
        name, initial: smallState(runtime, { item: potion }), viewerIds: viewerIdsForSmall(),
        steps: [{ command: { command_type: 'UseItem', command_id: 'equivalence-item', actor_id: 'hero-a', target_id: 'hero-b', item_id: potion.id, server_authoritative: true }, context: { allowedActorIds: ['hero-a'], serverAuthoritativeCombat: true } }], dice: [2, 4],
      }
    }
    case 'malformed':
      return {
        name, initial: smallState(runtime), viewerIds: viewerIdsForSmall(),
        steps: [{ command: { command_type: 'MoveActor', command_id: 'equivalence-malformed', actor_id: 'hero-a', to: { x: 'wrong', y: 0 }, server_authoritative: true }, context: { allowedActorIds: ['hero-a'], serverAuthoritativeCombat: true } }],
      }
    case 'refusal':
      return {
        name, initial: smallState(runtime), viewerIds: viewerIdsForSmall(),
        steps: [{ command: { command_type: 'UseCombatAction', command_id: 'equivalence-refusal', actor_id: 'hero-a', action_id: 'use-object', server_authoritative: true }, context: { allowedActorIds: ['hero-a'], serverAuthoritativeCombat: true } }],
      }
    case 'npcdeath':
      return null
    case 'longworldmemory':
      return null
    default:
      throw new Error(`Неизвестный сценарий: ${name}`)
  }
}

async function npcDeathScenario(runtime) {
  const fixture = await runtime.fixture.palaceFixture({ kingHp: 1, witnesses: false })
  const base = clone(fixture.state)
  const questWithConsequences = runtime.rules.normalizeCampaignState({
    ...base,
    partyMemberIds: [fixture.heroId],
    worldMemory: {
      ...base.worldMemory,
      quests: [...(base.worldMemory?.quests ?? []), independentQuest(), discoverQuest(fixture.kingId)],
    },
  })
  // Бой остаётся в одной сцене. Второй герой позволяет проверить обе личные
  // проекции на том же потоке событий.
  const initial = addObserver(runtime, questWithConsequences, { x: 0, y: 0 })
  const random = diceFor(runtime, [20, 1, 1, 1, ...Array(300).fill(1)], 'equivalence-npc-roll')
  return {
    name: 'npcdeath', initial, viewerIds: [fixture.heroId, 'hero-b'], diceService: random,
    steps: [
      { command: { command_type: 'AttackNpc', command_id: 'equivalence-attack-npc', actor_id: fixture.heroId, npc_id: fixture.kingId }, context: { allowedActorIds: [fixture.heroId] } },
      { command: { command_type: 'CastSpell', command_id: 'equivalence-fireball', actor_id: fixture.heroId, spell_id: 'fireball', to: fixture.kingPoint, server_authoritative: true }, context: { allowedActorIds: [fixture.heroId], serverAuthoritativeCombat: true } },
    ],
  }
}

async function executeCommandScenario(runtime, scenario) {
  let state = clone(scenario.initial)
  const normalizedInitial = runtime.rules.normalizeCampaignState(state)
  state = normalizedInitial
  const steps = []
  const diceService = scenario.diceService ?? diceFor(runtime, scenario.dice ?? [], `equivalence-${scenario.name}-roll`)
  for (const specification of scenario.steps) {
    const before = clone(state)
    const resolved = capture(() => runtime.rules.resolveCommand(
      clone(specification.command),
      state,
      { diceService, context: clone(specification.context ?? {}) },
    ))
    const stateUnmodified = stableJson(state) === stableJson(before)
    if (!stateUnmodified) state = before
    if (!resolved.ok) {
      steps.push({ command: specification.command, result: resolved, state_unmodified: stateUnmodified })
      break
    }
    const result = resolved.value
    const replay = {}
    for (const [id, marker] of REPLAY_VARIANTS) {
      replay[id] = runtime.rules.replayEvents(
        state,
        taggedEvents(result.events, marker, state.state_version),
      )
    }
    state = replay.v15
    steps.push({
      command: result.command,
      events: clone(result.events),
      rolls: clone(result.rolls ?? []),
      replay,
      state_unmodified: stateUnmodified,
    })
  }
  const viewMap = scenario.viewerIds ? viewers(runtime, state, scenario.viewerIds) : {}
  return {
    normalized_initial: normalizedInitial,
    steps,
    final: state,
    private_views: viewMap,
    private_visibility: privateVisibility(runtime, viewMap),
  }
}

function worldCounts(memory) {
  return Object.fromEntries(Object.keys(WORLD_LIMITS).map((key) => [key, Array.isArray(memory?.[key]) ? memory[key].length : 0]))
}

async function executeLongScenario(runtime) {
  const rawMemory = largeWorldMemory()
  const normalizedMemory = runtime.world.normalizeWorldMemory(rawMemory)
  const initial = runtime.rules.normalizeCampaignState(longStateRaw(runtime))
  const tailEvent = {
    event_type: 'WorldFactRecorded', event_id: 'equivalence-long-tail-event', command_id: 'equivalence-long-tail-command', actor_id: null, target_ids: [],
    payload: { fact: { id: 'fact-long-tail', subject_id: 'entity-long-0000', predicate: 'tail_fact', object: 'Хвост длинной истории.', summary: 'Хвост длинной истории.', visibility: 'party', source_event_ids: ['equivalence-long-tail-event'], source_command_id: 'equivalence-long-tail-command', recorded_at_minutes: 99_999 } },
  }
  const replay = {}
  for (const [id, marker] of REPLAY_VARIANTS) replay[id] = runtime.rules.replayEvents(initial, taggedEvents([tailEvent], marker, initial.state_version))
  return {
    normalized_memory: normalizedMemory,
    normalized_state: initial,
    replay,
    counts: { normalized_memory: worldCounts(normalizedMemory), normalized_state: worldCounts(initial.worldMemory), replay: Object.fromEntries(Object.entries(replay).map(([id, state]) => [id, worldCounts(state.worldMemory)])) },
  }
}

async function executeScenario(runtime, name) {
  if (name === 'npcdeath') return executeCommandScenario(runtime, await npcDeathScenario(runtime))
  if (name === 'longworldmemory') return executeLongScenario(runtime)
  return executeCommandScenario(runtime, scenarioFor(runtime, name))
}

function checkPrivacy(id, visibility) {
  const expected = {
    'hero-a': { secret_fact_visible: true, secret_entity_visible: true },
    'hero-b': { secret_fact_visible: false, secret_entity_visible: false },
  }
  if (!Object.keys(expected).every((actorId) => visibility[actorId] && stableJson(visibility[actorId]) === stableJson(expected[actorId]))) {
    return { id, equal: false, expected, actual: visibility }
  }
  return { id, equal: true, expected }
}

function compareCommandResults(name, baseline, live) {
  const checks = [compare(`${name}.normalized_initial`, baseline.normalized_initial, live.normalized_initial)]
  if (baseline.steps.length !== live.steps.length) {
    checks.push({ id: `${name}.step_count`, equal: false, baseline: baseline.steps.length, live: live.steps.length })
  }
  for (let index = 0; index < Math.max(baseline.steps.length, live.steps.length); index += 1) {
    const left = baseline.steps[index]
    const right = live.steps[index]
    if (!left || !right) continue
    checks.push(compare(`${name}.step${index}.outcome`, left.result ?? { ok: true }, right.result ?? { ok: true }))
    checks.push(compare(`${name}.step${index}.state_unmodified`, left.state_unmodified, right.state_unmodified))
    if (left.events || right.events) {
      checks.push(compare(`${name}.step${index}.command`, left.command, right.command))
      checks.push(compare(`${name}.step${index}.events`, left.events ?? [], right.events ?? []))
      checks.push(compare(`${name}.step${index}.rolls`, left.rolls ?? [], right.rolls ?? []))
      for (const [variant] of REPLAY_VARIANTS) checks.push(compare(`${name}.step${index}.replay.${variant}`, left.replay?.[variant], right.replay?.[variant]))
    }
  }
  checks.push(compare(`${name}.final`, baseline.final, live.final))
  checks.push(compare(`${name}.private_views`, baseline.private_views, live.private_views))
  checks.push(compare(`${name}.private_visibility`, baseline.private_visibility, live.private_visibility))
  if (name !== 'npcdeath') {
    checks.push(checkPrivacy(`${name}.privacy_contract`, baseline.private_visibility))
    checks.push(checkPrivacy(`${name}.privacy_contract_live`, live.private_visibility))
  }
  return checks
}

function compareLongResults(baseline, live) {
  return [
    compare('longworldmemory.normalized_memory', baseline.normalized_memory, live.normalized_memory),
    compare('longworldmemory.normalized_state', baseline.normalized_state, live.normalized_state),
    compare('longworldmemory.replay', baseline.replay, live.replay),
    compare('longworldmemory.counts', baseline.counts, live.counts),
  ]
}

function parseArgs(argv) {
  const options = { scenarios: [...SCENARIO_NAMES] }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--baseline-root=')) options.baselineRoot = arg.slice('--baseline-root='.length)
    else if (arg.startsWith('--live-root=')) options.liveRoot = arg.slice('--live-root='.length)
    else if (arg.startsWith('--scenario=')) {
      const requested = arg.slice('--scenario='.length).split(',').map((item) => item.trim().toLocaleLowerCase('en')).filter(Boolean)
      options.scenarios = requested
    } else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length)
    else throw new Error(`Неизвестный аргумент: ${arg}`)
  }
  return options
}

function usage() {
  return [
    'Usage: node eval/large-campaign-equivalence.mjs --baseline-root=<path> [options]',
    '  --live-root=<path>       live tree (default: repository root)',
    '  --scenario=a,b           bounded subset; default: all scenarios',
    '  --output=<path>          write the JSON report',
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (!options.baselineRoot) throw new Error(`Нужен --baseline-root=<path>\n${usage()}`)
  const generatedAt = new Date().toISOString()
  const restore = installDeterminism()
  try {
    const [baseline, live] = await Promise.all([
      loadRuntime(options.baselineRoot, 'baseline root'),
      loadRuntime(options.liveRoot ?? LIVE_ROOT, 'live root'),
    ])
    if (baseline.root.toLocaleLowerCase() === live.root.toLocaleLowerCase()) throw new Error('baseline и live должны указывать на разные деревья')
    const unknown = options.scenarios.filter((name) => !SCENARIO_NAMES.includes(name))
    if (unknown.length) throw new Error(`Неизвестные сценарии: ${unknown.join(', ')}`)
    if (!options.scenarios.length) throw new Error('Нужен хотя бы один сценарий')
    const scenarios = []
    for (const name of options.scenarios) {
      const started = performance.now()
      const baselineResult = await executeScenario(baseline, name)
      const liveResult = await executeScenario(live, name)
      const checks = name === 'longworldmemory' ? compareLongResults(baselineResult, liveResult) : compareCommandResults(name, baselineResult, liveResult)
      scenarios.push({
        name,
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
        ok: checks.every((check) => check.equal),
        checks,
        ...(name === 'longworldmemory' ? { baseline_counts: baselineResult.counts, live_counts: liveResult.counts } : {}),
      })
    }
    const report = {
      schema_version: 1,
      generated_at: generatedAt,
      fixture_clock: FIXED_NOW,
      command: process.argv.slice(2),
      baseline_root: baseline.root,
      live_root: live.root,
      guarantees: { no_llm: true, no_storage: true, fixed_clock: FIXED_NOW, replay_markers: ['v14', 'absent_legacy', 'v15'], world_limits_exceeded_once: options.scenarios.includes('longworldmemory') },
      scenarios,
      ok: scenarios.every((scenario) => scenario.ok),
    }
    const encoded = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) writeFileSync(resolve(options.output), encoded, 'utf8')
    process.stdout.write(encoded)
    return report.ok ? 0 : 1
  } finally {
    restore()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  }
}

export {
  REPLAY_VARIANTS,
  WORLD_LIMITS,
  compare,
  executeScenario,
  largeWorldMemory,
  parseArgs,
  taggedEvents,
}
