import '../../../fixtures-env.mjs'
// Эталон server/campaign-loop-policy.mjs для Rust:
//
//   node rust/crates/sk-story/fixtures/gen-campaign-loop-policy.mjs [каталог корпуса]
//
// Источники входов:
//
// 1. настоящие вызовы модуля при прогоне тестов JS (Режиссёр, оркестратор,
//    сценарий, переходы, вечерняя арка) — перехват `loop-policy-capture.mjs`
//    в дочернем процессе `node --test` на каждый файл;
// 2. корпус паритета (`tmp/corpus-v1/states`): выборка состояний, в том числе
//    все попавшие в выборку кампании по сценарию;
// 3. прогон «Асстоханских равнин» через Rules Engine: создание кампании,
//    переходы туда, куда зовёт `nextWorldMapDestination`, находки улик,
//    внимание дракона, бой с Саргатом и все развязки;
// 4. сотни случайных состояний с мусором старых сохранений (`null` в списках,
//    строки вместо чисел, ключи прототипа как фаза и тип намерения) и
//    кампании без сценария по вечерней арке;
// 5. вызовы без состояния: прямые команды игрока, seed и план арки.
//
// Состояния урезаются (`loop-policy-lib.mjs`) с проверкой исхода. Эталон —
// `campaign-loop-policy.json.gz`: таблица состояний и случаи
// `{ fn, state, args, out | undef | error | throws }`; аргумент-состояние в
// `args` — `null`, его подставляет тест по номеру `state`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

import { mulberry32 } from './common.mjs'
import { FUNCTIONS, UNDEF, decodeArgs, encodeArgs, outcome, slimmedCase } from './loop-policy-lib.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const root = here('../../../../')
const P = await import('../../../../server/campaign-loop-policy.mjs')

// ---------------------------------------------------------------------------
// Таблица состояний и случаев
// ---------------------------------------------------------------------------

const states = []
const stateIndex = new Map()
const cases = []
const caseKeys = new Set()
const stats = { capture: 0, corpus: 0, astohan: 0, random: 0, stateless: 0, dropped: 0, throws: 0 }

function addState(state) {
  const text = JSON.stringify(state)
  const key = createHash('sha256').update(text).digest('hex')
  if (!stateIndex.has(key)) {
    stateIndex.set(key, states.length)
    states.push(JSON.parse(text))
  }
  return stateIndex.get(key)
}

/** Записать случай: исход считается на урезанных аргументах, сверенных с полными. */
function addCase(source, name, args) {
  const fn = P[name]
  const position = FUNCTIONS[name]
  let slim
  try {
    slim = slimmedCase(fn, args, position)
  } catch {
    slim = null
  }
  if (!slim) {
    stats.dropped += 1
    return
  }
  const encoded = encodeArgs(slim.args)
  let state = null
  if (position >= 0) {
    const value = encoded[position]
    if (value === UNDEF || value === null || typeof value !== 'object' || Array.isArray(value)) {
      state = null
    } else {
      state = addState(value)
      encoded[position] = null
    }
  }
  const record = { fn: name, state, args: encoded, ...slim.result }
  const key = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  if (caseKeys.has(key)) return
  caseKeys.add(key)
  if (record.throws) stats.throws += 1
  stats[source] += 1
  cases.push(record)
}

// ---------------------------------------------------------------------------
// Набор вызовов для одного состояния
// ---------------------------------------------------------------------------

const INTENT_TYPES = ['continue_exploration', 'open_social_scene', 'advance_quest_clock', 'request_encounter', 'resolve_scene', 'end_scene', 'offer_next_hook']
const THEMES = ['beasts', 'undead', 'raiders', 'goblinoids', 'generic', 'dragons', 'nope']
const PHRASES = [
  'Атакуем!', 'мы атакуем', 'Мы ищем бой', 'начинаем бой.', 'нападаем', 'не нападаем', 'если что, атакуем', 'Сражаемся,', 'атакуемся',
  'Перейти дальше', 'уйти', 'Продолжить путь', 'продолжить подтверждённый переход', 'продолжить подтвержденный переход', 'Продолжить приключение',
  'я не хочу уйти', 'без боя уйти', '  ПЕРЕЙТИ  ', 'вступаем в бой!', '', null, undefined, 42,
]

function intentsFor(state, random) {
  const quests = Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : []
  const questIds = quests.map((quest) => quest?.id).filter((id) => typeof id === 'string')
  const npcIds = (Array.isArray(state?.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id).filter((id) => typeof id === 'string')
  const pick = (list) => list[Math.floor(random() * list.length)]
  const list = INTENT_TYPES.map((type) => {
    if (type === 'request_encounter') return { type, theme: pick(THEMES.slice(0, 4)), difficulty: pick(['easy', 'medium', 'hard', 'deadly']) }
    if (type === 'advance_quest_clock') return { type, quest_id: questIds.length ? pick(questIds) : 'quest-x' }
    if (type === 'open_social_scene') return npcIds.length && random() < 0.6 ? { type, npc_id: pick(npcIds) } : { type }
    if (type === 'offer_next_hook') return { type, hook: 'Следы у колодца' }
    if (type === 'end_scene') return { type, destination: random() < 0.5 ? 'Пепельная застава' : '' }
    if (type === 'resolve_scene') return { type, resolution: pick(['negotiation', 'objective', 'decision']) }
    return { type, reason: 'Модель предлагает осмотреться.' }
  })
  if (random() < 0.3) list.push({ type: 'request_encounter', theme: 'beasts', difficulty: 'medium', hp: 5 })
  if (random() < 0.2) list.push({ type: 'teleport' })
  if (random() < 0.15) list.push(null)
  if (random() < 0.1) list.push({ type: 'advance_quest_clock', quest_id: 'квест с пробелом' })
  return list
}

function callsForState(source, state, random) {
  const run = (name, ...args) => addCase(source, name, [state, ...args])
  run('abandonedQuestsForDirector')
  run('directorObjectiveAfterQuestAbandonment')
  if (random() < 0.3) run('directorObjectiveAfterQuestAbandonment', '  Свой  запас ')
  run('mainQuestFor')
  run('campaignArcPlan')
  run('campaignArcPosition')
  run('campaignArcClimaxSatisfied')
  run('directorProgressFingerprint')
  run('nextWorldMapDestination')
  const quests = Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : []
  for (const quest of quests.slice(0, 4)) run('confirmedQuestProgress', quest?.id)
  run('confirmedQuestProgress', 'quest-none')
  for (const intent of intentsFor(state, random)) {
    const phrase = PHRASES[Math.floor(random() * PHRASES.length)]
    run('authorizeDirectorIntent', intent, random() < 0.7 ? { playerAction: phrase } : undefined)
  }
  run('scenarioEncounterIntent', { type: 'request_encounter', theme: 'beasts', difficulty: 'medium', reason: 'тест' })
  for (const type of ['continue_exploration', 'end_scene', 'request_encounter', 'advance_quest_clock']) run('pacingForDirectorIntent', { type })
  const locations = Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []
  const target = locations.length ? locations[Math.floor(random() * locations.length)] : null
  run('planServerTravel', { campaignId: 'LOOP', destination: target?.name ?? 'Заброшенный склеп', idempotencyKey: `k-${Math.floor(random() * 1000)}` })
  run('planServerTravel', { campaignId: 'LOOP', destinationLocationId: target?.id, idempotencyKey: 'by-id' })
  run('planServerTravel', { campaignId: 'LOOP', destination: 'Новая башня у реки', idempotencyKey: 'new-place' })
  const npcIds = (Array.isArray(state?.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id)
  run('assembleSocialNpc', { campaignId: 'LOOP', idempotencyKey: 'social', requestedId: random() < 0.5 && npcIds.length ? npcIds[0] : 'npc-wanted' })
  run('assembleSocialNpc', { campaignId: 'LOOP', idempotencyKey: `s-${Math.floor(random() * 99)}` })
  run('completedDowntime')
  run('completedDowntime', { kind: 'short_rest', durationMinutes: '60', reason: 'привал' })
}

// ---------------------------------------------------------------------------
// 1. Перехват при прогоне тестов JS
// ---------------------------------------------------------------------------

const TEST_FILES = [
  'campaign-loop-policy', 'campaign-arc-chain', 'campaign-scenario', 'director-agent', 'director-freedom-regression',
  'director-three-scenes', 'evening-campaign', 'scenario-attention', 'scenario-finale', 'scenario-progression',
  'world-travel-graph', 'world-travel', 'autonomous-campaign', 'persistent-campaign', 'game-orchestrator',
  'quest-progress-evidence', 'campaign-lifecycle', 'post-combat-recovery', 'scenario-knight', 'game-flow-integration',
]
const node = process.execPath
const work = mkdtempSync(join(tmpdir(), 'loop-policy-'))
let captureDropped = 0
for (const file of TEST_FILES) {
  const out = join(work, `${file}.jsonl`)
  const run = spawnSync(node, [
    '--import', pathToFileURL(here('../../../fixtures-env.mjs')).href,
    '--import', pathToFileURL(here('./loop-policy-capture.mjs')).href,
    '--test', '--test-isolation=none', '--test-reporter=dot',
    join(root, 'test', `${file}.test.mjs`),
  ], { cwd: root, env: { ...process.env, LOOP_POLICY_CAPTURE_OUT: out, LOOP_POLICY_CAPTURE_LIMIT: '60', ROUTERAI_API_KEY: '' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) console.log(`  тест ${file}: код ${run.status}`, String(run.stderr).slice(0, 400))
  if (!existsSync(out)) continue
  let count = 0
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    if (record.dropped) {
      captureDropped += record.dropped
      continue
    }
    addCase('capture', record.fn, decodeArgs(record.args))
    count += 1
  }
  console.log(`  перехват ${file}: ${count}`)
}
rmSync(work, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 2. Корпус паритета
// ---------------------------------------------------------------------------

const corpus = process.argv[2] ?? process.env.SK_STORY_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
if (existsSync(join(corpus, 'states'))) {
  const random = mulberry32(2026_10_16)
  const files = readdirSync(join(corpus, 'states')).filter((name) => name.endsWith('.json')).sort()
  let scenarioStates = 0
  let otherStates = 0
  for (const [index, file] of files.entries()) {
    const text = readFileSync(join(corpus, 'states', file), 'utf8')
    const scenario = text.includes('"skazanie:scenario-arc-v1"')
    if (scenario ? scenarioStates >= 40 || index % 9 !== 0 : otherStates >= 60 || index % 97 !== 0) continue
    if (scenario) scenarioStates += 1
    else otherStates += 1
    callsForState('corpus', JSON.parse(text), random)
  }
  console.log(`  корпус: ${scenarioStates} по сценарию, ${otherStates} прочих`)
} else {
  console.log(`  корпуса нет: ${corpus}`)
}

// ---------------------------------------------------------------------------
// 3. Прогон «Асстоханских равнин»
// ---------------------------------------------------------------------------

{
  const { CampaignBootstrapper } = await import('../../../../server/campaign-bootstrap.mjs')
  const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
  const { normalizeCampaignState, resolveCommands } = await import('../../../../server/rules-engine.mjs')
  const { SceneArchitectAgent } = await import('../../../../server/scene-architect.mjs')
  const { campaignScenario, scenarioClueFactId } = await import('../../../../server/campaign-scenario.mjs')
  const random = mulberry32(2026_10_05)
  const hero = { id: 'scenario-hero', character: 'Испытатель', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странник', level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30 }
  const dice = () => new DiceService({ rng: new SequenceDiceRng([]) })
  let step = 0
  const travel = async (state, locationId) => {
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
    const result = resolveCommands([{ command_type: 'AdvanceScene', command_id: `astohan-${step += 1}`, scene_args: sceneArgs }], state, { diceService: dice(), context: { isAdmin: true } })
    return normalizeCampaignState(result.state)
  }
  const discover = (state, clueId) => {
    const scenario = campaignScenario(state)
    const secret = state.worldMemory.facts.find((fact) => fact.id === scenarioClueFactId(scenario, clueId))
    if (!secret) return state
    const result = resolveCommands([{ command_type: 'RecordWorldFact', command_id: `astohan-${step += 1}`, fact: {
      id: `fact-secret-found-${clueId}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
      summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secret.id,
    } }], state, { diceService: dice(), context: { isAdmin: true } })
    return normalizeCampaignState(result.state)
  }
  const withAttention = (state, value) => ({ ...state, scenario_attention: { ...(state.scenario_attention ?? {}), value } })
  const afterBoss = (state, outcomeName) => ({
    ...state,
    mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active: false },
      encounter: { id: 'encounter-boss', status: 'ended', outcome: outcomeName, enemy_ids: ['astohan-sargat'], difficulty: 'deadly' } },
    autonomy: { ...state.autonomy, encounter_outcomes: [{ encounter_id: 'encounter-boss', outcome: outcomeName }] },
  })
  const snapshot = (state) => {
    callsForState('astohan', state, random)
    if (random() < 0.5) callsForState('astohan', withAttention(state, 3 + Math.floor(random() * 7)), random)
  }
  for (const route of ['story', 'wander']) {
    let state = normalizeCampaignState(await new CampaignBootstrapper().create({ code: `ASTOHAN-${route}`, worldTemplateId: 'astohan-plains', players: [hero] }))
    const scenario = campaignScenario(state)
    snapshot(state)
    const order = route === 'story' ? null : scenario.locations.map((card) => card.location_id)
    for (let hop = 0; hop < 16; hop += 1) {
      let nextId
      if (order) {
        nextId = order[(hop + 1) % order.length]
      } else {
        const name = P.nextWorldMapDestination(state)
        nextId = state.worldMap.locations.find((location) => location.name === name)?.id
        if (!nextId) break
      }
      state = await travel(state, nextId)
      snapshot(state)
      const card = scenario.locations.find((entry) => entry.location_id === nextId)
      for (const secret of card?.secrets ?? []) {
        state = discover(state, secret.id)
        snapshot(state)
      }
      if (nextId === 'astohan-vulkanis-brazier') break
    }
    if (state.scene.location_id !== 'astohan-vulkanis-brazier') state = await travel(state, 'astohan-vulkanis-brazier')
    snapshot(state)
    for (const outcomeName of ['enemies_defeated', 'boss_fled', 'party_defeated', 'party_incapacitated', 'parley']) snapshot(afterBoss(state, outcomeName))
    snapshot({ ...state, scenario_attention: { ...(state.scenario_attention ?? {}), treaty: { concluded: true } } })
    snapshot({ ...state, mechanics: { ...state.mechanics, combat: { active: true } } })
  }
  console.log(`  Асстохан: ${stats.astohan} случаев`)
}

// ---------------------------------------------------------------------------
// 4. Случайные состояния
// ---------------------------------------------------------------------------

{
  const random = mulberry32(2026_10_17)
  const int = (n) => Math.floor(random() * n)
  const pick = (list) => list[int(list.length)]
  const chance = (p) => random() < p
  const PROTO = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']
  const NAMES = ['Застава', 'Перевал', 'Озеро', 'Старый лес', 'Болото', 'Mill', 'Ruins', 'Склеп', 'Город', 'тракт', 'Башня', 'ЗАСТАВА', 'Áстра', 'Пещера']
  const BIOMES = ['plains', 'coast', 'tundra', 'desert', 'forest', 'marsh', 'mountains', 'wastes', 'swamp', '', null]
  const garbage = () => pick([null, '', 'строка', 3, -1, '7', true, [], {}, ['5'], 'Infinity', 0])
  const num = () => (chance(0.8) ? int(8) : garbage())

  function worldMap() {
    if (chance(0.15)) return pick([null, [], 'map', { locations: [] }, { locations: 'x' }])
    const count = 2 + int(8)
    const regions = Array.from({ length: 1 + int(4) }, (_, index) => (chance(0.08) ? pick([null, [], 'r']) : {
      ...(chance(0.9) ? { id: `r${index}` } : {}), biome: pick(BIOMES),
    }))
    const locations = Array.from({ length: count }, (_, index) => (chance(0.05) ? pick([null, 'loc', [], { name: 'Без id' }]) : {
      id: chance(0.95) ? `loc-${index}` : `loc-${index - 1}`,
      name: chance(0.9) ? `${pick(NAMES)}${chance(0.5) ? '' : ` ${index}`}` : pick(['', null, '  ']),
      ...(chance(0.85) ? { regionId: `r${int(regions.length + 1)}` } : {}),
      x: chance(0.9) ? int(1000) : garbage(), y: chance(0.9) ? int(640) : garbage(),
      visited: chance(0.4) ? true : pick([false, undefined, 'true', 1]),
    }))
    const routes = Array.from({ length: int(count * 2) }, (_, index) => (chance(0.05) ? pick([null, 'r', []]) : {
      id: chance(0.85) ? `route-${index}` : pick(['', null]),
      from: `loc-${int(count + 1)}`, to: `loc-${int(count)}`,
      ...(chance(0.75) ? { distance: chance(0.8) ? int(9) : pick(['3', null, 'Infinity', 'x', -2, 2.5, true, [4]]) } : {}),
      danger: pick(['низкая', 'средняя', 'высокая', 'High', 'LOW', 'жуткая', null, 'constructor']),
      kind: pick(['road', 'trail', 'pass', 'river', 'sea', 'ROAD', 'Trail', null]),
      ...(chance(0.15) ? { discovered: pick([false, true, 0]) } : {}),
    }))
    return {
      locations, routes, regions,
      ...(chance(0.85) ? { currentLocationId: chance(0.9) ? `loc-${int(count)}` : pick(['nowhere', '', null]) } : {}),
    }
  }

  function quests() {
    const statuses = ['active', 'active', 'completed', 'failed', 'abandoned', 'hidden', 'weird', null]
    return Array.from({ length: int(6) }, (_, index) => {
      if (chance(0.03)) return pick([null, 'quest', []])
      const id = pick([`quest-${index}`, `quest:chapter:${1 + int(5)}`, `quest:main`, index, null])
      return {
        ...(id !== null ? { id } : {}),
        title: chance(0.9) ? pick(['Найти след', 'Старая цель', '  Спасти   мельника  ', '']) : garbage(),
        summary: chance(0.5) ? 'Краткое описание задания.' : undefined,
        status: pick(statuses),
        ...(chance(0.15) ? { stay_in_location: pick([true, false, 'true']) } : {}),
        ...(chance(0.7) ? { entity_ids: [pick(['wardens', 'loc:road', 'npc-1'])] } : {}),
        ...(chance(0.85) ? { clock: chance(0.9) ? { current: num(), max: num(), ...(chance(0.4) ? { triggered: pick([true, false, 'yes']) } : {}) } : garbage() } : {}),
      }
    })
  }

  function facts() {
    return Array.from({ length: int(5) }, (_, index) => (chance(0.03) ? null : {
      id: `fact-${index}`, predicate: pick(['discovery', 'local_lore', 'gm_secret']),
      subject_id: pick(['wardens', 'loc:road', 'npc-1', 'loc:pier']), source_event_ids: chance(0.7) ? [`event-${int(4)}`] : [],
      status: pick(['active', 'active', 'superseded']), visibility: pick(['party', 'public', 'gm_only']),
      ...(chance(0.4) ? { recorded_at_minutes: int(200) } : {}),
    }))
  }

  function history() {
    const types = [...INTENT_TYPES, 'end_scene', 'end_scene', 'weird']
    return Array.from({ length: int(7) }, () => {
      const intent = { type: pick(types) }
      return pick([{ intent }, intent, { intent: null, type: pick(types) }, null, 'str', [intent]])
    })
  }

  function arc() {
    const roll = random()
    if (roll < 0.35) return P.buildCampaignArcPlan(pick(['evening', 'seed-2', '', 'Длинный сид кампании']), pick([1, 2, 3, undefined, '4', 13]))
    if (roll < 0.45) return { ...P.buildCampaignArcPlan('broken'), target_scenes: 9 }
    if (roll < 0.5) return { version: 'skazanie:campaign-arc-v1', preset: 'one_evening', seed: 'old-save' }
    if (roll < 0.62) return { version: 'skazanie:scenario-arc-v1', preset: 'scenario', scenario_id: 'astohan-dragon-hunt', scenario_version: pick([1, 1, 2]) }
    return pick([undefined, null, 'arc', {}])
  }

  for (let index = 0; index < 500; index += 1) {
    const chapter = pick([1, 2, 3, 4, 5, 6, '2', null, 0, 2.5, garbage()])
    const map = worldMap()
    const mapLocations = Array.isArray(map?.locations) ? map.locations.filter((entry) => entry && typeof entry === 'object') : []
    const sceneLocation = chance(0.8) && mapLocations.length ? pick(mapLocations).name : pick(['Северный тракт', 'Таверна', '', null])
    const encounterId = pick(['enc-1', 'enc-2', '', null, undefined])
    const state = {
      sessionCode: chance(0.8) ? `RND-${index}` : undefined,
      ...(chance(0.2) ? { campaign_id: pick(['camp', null]) } : {}),
      partyMemberIds: chance(0.9) ? ['hero-a', 'hero-b', 'hero-c'].slice(0, 1 + int(3)) : garbage(),
      players: [{ id: 'hero-a' }, { id: 'hero-b' }, { id: 'hero-c' }, ...(chance(0.1) ? [{ id: 5 }] : [])],
      ...(chance(0.6) ? { enemies: Array.from({ length: int(3) }, () => ({ id: 'e', alive: pick([true, false, undefined]), hp: pick([0, 5, null, undefined, '3', -1]) })) } : {}),
      scene: chance(0.95) ? {
        location: sceneLocation,
        ...(chance(0.3) ? { location_id: chance(0.7) ? `loc-${int(5)}` : null } : {}),
        objective: pick(['Осмотреть заставу', '', undefined, '  Найти   след ']),
        scene_kind: pick(['wilderness', 'Wilderness', 'settlement', undefined]),
        ...(chance(0.3) ? { cells: Array.from({ length: int(6) }, () => ({ revealed: pick([true, false, 'true']) })) } : {}),
      } : garbage(),
      adventure: { chapter, ...(chance(0.2) ? { visitedLocationIds: ['loc-0'] } : {}) },
      mechanics: {
        ...(chance(0.3) ? { combat: { active: chance(0.3) } } : {}),
        ...(chance(0.6) ? { encounter: {
          ...(encounterId !== undefined ? { id: encounterId } : {}), status: pick(['ended', 'active', 'planned']),
          difficulty: pick(['hard', 'medium', 'deadly']), created_in_chapter: pick([1, 2, 3, 4, 5, '5', null]),
          ...(chance(0.4) ? { outcome: pick(['enemies_defeated', 'party_defeated']) } : {}),
        } } : {}),
        ...(chance(0.3) ? { campaign_lifecycle: { status: pick(['active', 'completed']) } } : {}),
        world_time: chance(0.8) ? { elapsed_minutes: int(2000) } : {},
        death: { heroes: chance(0.3) ? { 'hero-b': { status: 'dead' } } : {} },
      },
      worldMemory: chance(0.95) ? {
        entities: [{ id: 'wardens', kind: 'faction' }, { id: 'loc:road', kind: 'location', name: sceneLocation ?? 'Северный тракт' }, ...(chance(0.1) ? [null] : [])],
        facts: facts(),
        quests: chance(0.97) ? quests() : garbage(),
      } : garbage(),
      autonomy: {
        ...(chance(0.8) ? { pacing: chance(0.9) ? { beat: num(), tension: pick([0, 10, 30, 55, 70, 82, 99, 150, -5, '60', null]), ...(chance(0.5) ? { phase: pick(['breather', 'development', 'escalation', 'climax', 'chaos', ...PROTO]) } : {}) } : garbage() } : {}),
        director_history: chance(0.95) ? history() : garbage(),
        ...(chance(0.6) ? { director_outcomes: chance(0.9) ? Array.from({ length: int(3) }, () => ({ intent_type: pick(INTENT_TYPES), state_changed: pick([true, false, undefined]) })) : garbage() } : {}),
        ...(chance(0.6) ? { encounter_outcomes: Array.from({ length: int(3) }, () => ({ encounter_id: pick(['enc-1', 'enc-2', undefined]), outcome: pick(['enemies_defeated', 'party_defeated', 'party_incapacitated', 'fled']) })) } : {}),
        ...(chance(0.4) ? { travel_history: chance(0.9) ? Array.from({ length: int(3) }, () => ({})) : garbage() } : {}),
        ...(chance(0.3) ? { scene_resolutions: [{ status: pick(['confirmed', 'proposed']), chapter: pick([3, 4, 5, '5']), resolution: pick(['negotiation', 'objective', 'decision', 'combat']) }] } : {}),
      },
      ...(chance(0.85) ? { campaignConcept: { arc: arc(), ...(chance(0.1) ? { campaign_mode: pick(['persistent', 'adventure']) } : {}) } } : {}),
      ...(chance(0.7) ? { social: { npcs: Array.from({ length: int(4) }, (_, n) => (chance(0.05) ? null : {
        id: pick([`npc-${n}`, 'npc-wanted', 'npc с пробелом', '']), name: 'Жилец', available: pick([true, false, undefined]),
        ...(chance(0.6) ? { location: chance(0.6) ? sceneLocation : 'Где-то ещё' } : {}),
      })) } } : {}),
      ...(chance(0.5) ? { worldMap: map } : {}),
    }
    callsForState('random', JSON.parse(JSON.stringify(state)), random)
  }
}

// ---------------------------------------------------------------------------
// 5. Вызовы без состояния
// ---------------------------------------------------------------------------

{
  const random = mulberry32(2026_10_18)
  for (const phrase of PHRASES) for (const kind of ['encounter', 'transition', '', 'other']) addCase('stateless', 'affirmativePlayerAction', [phrase, kind])
  const seeds = ['evening-seed', '', null, undefined, 'stall-probe', '  пробелы   внутри  ', 'x'.repeat(260), 42, 'Сид😀эмодзи']
  const arcs = [1, 2, 3, 12, 13, 0, -1, 2.5, '3', null, undefined, 'abc', 'Infinity', 1e9]
  for (const seed of seeds) {
    for (const arcNumber of arcs) {
      addCase('stateless', 'arcSeedFor', [seed, arcNumber])
      addCase('stateless', 'buildCampaignArcPlan', [seed, arcNumber])
    }
  }
  for (let index = 0; index < 120; index += 1) addCase('stateless', 'buildCampaignArcPlan', [`seed-${index}-${Math.floor(random() * 1e6)}`, 1 + (index % 13)])
  for (const quest of [{ status: 'abandoned', stay_in_location: true }, { status: 'abandoned' }, { status: 'active', stay_in_location: true }, { status: 'abandoned', stay_in_location: 'true' }, null, undefined, 'abandoned']) {
    addCase('stateless', 'questWasAbandonedInPlace', [quest])
  }
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

const lines = [
  '{',
  `"states": [\n${states.map((state) => JSON.stringify(state)).join(',\n')}\n],`,
  `"cases": [\n${cases.map((record) => JSON.stringify(record)).join(',\n')}\n]`,
  '}',
]
const text = `${lines.join('\n')}\n`
const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
writeFileSync(here('./campaign-loop-policy.json.gz'), gz)
console.log(`campaign-loop-policy.json.gz: состояний ${states.length}, случаев ${cases.length}, ${text.length} байт → ${gz.length} gzip`)
console.log(`  по источникам: ${JSON.stringify(stats)}; отброшено в перехвате: ${captureDropped}`)
