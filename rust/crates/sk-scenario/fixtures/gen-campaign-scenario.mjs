// Эталоны `server/campaign-scenario.mjs` для Rust-переноса (`sk-scenario`).
//
// Состояния кампании Асстохана собираются настоящим движком, как в
// `test/campaign-scenario.test.mjs`: создание кампании, переходы через план
// Архитектора и `AdvanceScene`, находки тайн фактом `discovery`. Затем на них
// накладываются правки: исход боя с Саргатом, договор, счёт внимания, павшие
// NPC, сцена только по имени, сброшенные открытия карты. Каждое состояние
// сводится к полям, которые читает модуль, и прогоняется через все его
// функции; выход JS пишется рядом.
//
// Отдельно — проверка формы каталога: `validateScenario` не экспортируется,
// поэтому генератор берёт копию модуля во временном каталоге и открывает её.
//
// Запуск: node rust/crates/sk-scenario/fixtures/gen-campaign-scenario.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('../../../../', import.meta.url)
const modulePath = new URL('server/campaign-scenario.mjs', root)
const S = await import(modulePath.href)
const { CampaignBootstrapper } = await import(new URL('server/campaign-bootstrap.mjs', root).href)
const { normalizeCampaignState, resolveCommands } = await import(new URL('server/rules-engine.mjs', root).href)
const { SceneArchitectAgent } = await import(new URL('server/scene-architect.mjs', root).href)
const { DiceService, SequenceDiceRng } = await import(new URL('server/dice-service.mjs', root).href)

function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(1013)
const pick = (list) => list[Math.floor(random() * list.length)]
const clone = (value) => JSON.parse(JSON.stringify(value))

// ---------- состояния настоящим движком ----------

const hero = { id: 'scenario-hero', character: 'Испытатель', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странник', level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30 }
const dice = () => new DiceService({ rng: new SequenceDiceRng([]) })

async function campaign(worldTemplateId, code) {
  return normalizeCampaignState(await new CampaignBootstrapper().create({ code, worldTemplateId, players: [hero] }))
}

let commandSeq = 0
async function travel(state, locationId) {
  commandSeq += 1
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
  const result = resolveCommands([{ command_type: 'AdvanceScene', command_id: `fixture-travel-${commandSeq}`, scene_args: sceneArgs }], state,
    { diceService: dice(), context: { isAdmin: true } })
  return normalizeCampaignState(result.state)
}

function discover(state, clueId) {
  const scenario = S.campaignScenario(state)
  const secretId = S.scenarioClueFactId(scenario, clueId)
  const secret = state.worldMemory.facts.find((fact) => fact.id === secretId)
  if (!secret) return null
  commandSeq += 1
  try {
    const result = resolveCommands([{ command_type: 'RecordWorldFact', command_id: `fixture-find-${commandSeq}`, fact: {
      id: `fact-secret-found-${clueId}`,
      subject_id: secret.subject_id,
      predicate: 'discovery',
      object: 'clue',
      summary: secret.summary,
      visibility: 'party',
      source_event_ids: [],
      supersedes_fact_id: secretId,
    } }], state, { diceService: dice(), context: { isAdmin: true } })
    return normalizeCampaignState(result.state)
  } catch {
    // Тайна уже найдена: второй факт с тем же id движок не примет.
    return null
  }
}

/** Поля, которые читает модуль; прочее состояние кампании к делу не относится. */
function project(state) {
  const only = (value, keys) => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))
    : value)
  const result = {}
  if ('campaignConcept' in state) result.campaignConcept = only(state.campaignConcept, ['arc', 'campaign_mode'])
  if ('worldMap' in state) {
    const map = state.worldMap
    result.worldMap = {
      ...only(map, ['currentLocationId']),
      locations: (map?.locations ?? []).map((entry) => only(entry, ['id', 'name', 'known', 'visited', 'hidden'])),
      routes: (map?.routes ?? []).map((entry) => only(entry, ['from', 'to', 'discovered'])),
    }
  }
  if ('scene' in state) result.scene = only(state.scene, ['location', 'location_id', 'locationId'])
  if ('adventure' in state) {
    result.adventure = {
      ...only(state.adventure, ['visitedLocationIds']),
      history: (state.adventure?.history ?? []).map((entry) => only(entry, ['location', 'location_id'])),
    }
  }
  if ('worldMemory' in state) {
    result.worldMemory = {
      // Модуль смотрит только на находки (`discovery`); прочих фактов хватит трёх.
      facts: (state.worldMemory?.facts ?? [])
        .filter((fact, index, list) => fact?.predicate === 'discovery' || list.slice(0, index).filter((other) => other?.predicate !== 'discovery').length < 3)
        .map((fact) => only(fact, ['id', 'predicate', 'supersedes_fact_id', 'summary', 'visibility'])),
      ...only(state.worldMemory, ['knowledge_revealed']),
    }
  }
  if (state.npc_world) result.npc_world = only(state.npc_world, ['vitals'])
  if (state.mechanics) result.mechanics = only(state.mechanics, ['encounter', 'conditions'])
  if (state.autonomy) result.autonomy = only(state.autonomy, ['encounter_outcomes'])
  if ('scenario_attention' in state) result.scenario_attention = state.scenario_attention
  return clone(result)
}

const start = await campaign('astohan-plains', 'FIXTURE-SCENARIO')
const free = await campaign('league-nine-tides', 'FIXTURE-FREE')
const scenario = S.campaignScenario(start)
const locationIds = scenario.locations.map((location) => location.location_id)
const clueIds = scenario.locations.flatMap((location) => (location.secrets ?? []).map((secret) => secret.id))

const bases = [project(start), project(free)]
// Путь по сюжету из теста и случайные прогулки по дорогам карты.
{
  let state = await travel(start, 'astohan-ash-watch')
  bases.push(project(state))
  state = discover(state, 'ash-gate') ?? state
  bases.push(project(state))
  state = await travel(state, 'astohan-obsidian-pass')
  bases.push(project(state))
  state = await travel(state, 'astohan-vulkanis-brazier')
  bases.push(project(state))
}
for (let walk = 0; walk < 3; walk += 1) {
  let state = start
  for (let step = 0; step < 10; step += 1) {
    const here = S.scenarioLocationId(state)
    const routes = (state.worldMap.routes ?? []).filter((route) => route.discovered !== false && (route.from === here || route.to === here))
    const neighbours = routes.map((route) => (route.from === here ? route.to : route.from))
      .filter((id) => state.worldMap.locations.some((location) => location.id === id && location.known !== false))
    const secrets = (scenario.locations.find((location) => location.location_id === here)?.secrets ?? []).map((secret) => secret.id)
    if (secrets.length && random() < 0.6) {
      const found = discover(state, pick(secrets))
      if (found) {
        state = found
        bases.push(project(state))
        continue
      }
    }
    if (!neighbours.length) break
    try {
      state = await travel(state, pick(neighbours))
      bases.push(project(state))
    } catch (error) {
      console.error('переход не удался:', error.message)
    }
  }
}

// ---------- правки поверх состояний ----------

const BOSS = 'astohan-sargat'
const lairName = start.worldMap.locations.find((location) => location.id === 'astohan-vulkanis-brazier').name
const names = Object.fromEntries(start.worldMap.locations.map((location) => [location.id, location.name]))
const outcomes = ['enemies_defeated', 'fled', 'parley', 'party_incapacitated', 'victory', 'surrendered', 'truce', 'party_defeated', 'stalemate']

function mutations(base) {
  const patch = {}
  const mechanics = () => (patch.mechanics ??= clone(base.mechanics ?? {}))
  const choices = [
    () => {
      const outcome = pick(outcomes)
      mechanics().encounter = { id: pick(['encounter-boss', 'e2', '']), status: pick(['ended', 'ended', 'active']), outcome, enemy_ids: pick([[BOSS], ['astohan-lomar', BOSS], ['x'], [5]]), ...(random() < 0.3 ? { location: pick([lairName, names['astohan-redstone'], 'Нигде']) } : {}) }
      patch.autonomy = { encounter_outcomes: random() < 0.8 ? [{ encounter_id: mechanics().encounter.id, outcome }] : [{ outcome }] }
    },
    () => {
      patch.scenario_attention = { value: pick([0, 1, 3, 5, 6, 7, '6', null, 'много']), ...(random() < 0.4 ? { treaty: { concluded: pick([true, false, 'да']) } } : {}) }
    },
    () => {
      patch.npc_world = { vitals: { [pick([BOSS, 'astohan-lomar', 'astohan-kaelan', 'astohan-trent'])]: { alive: pick([false, true, null]) } } }
    },
    () => {
      mechanics().encounter = { id: 'side', status: 'ended', outcome: pick(['enemies_defeated', 'fled']), enemy_ids: [pick(['astohan-lomar', 'astohan-kaelan', BOSS])] }
    },
    () => {
      mechanics().conditions = { [BOSS]: pick([[{ id: 'fled' }], ['fled'], [{ id: 'prone' }], [null], 'fled']) }
      mechanics().encounter ??= { id: 'boss', status: 'active', enemy_ids: [BOSS] }
    },
    () => {
      const id = pick(locationIds)
      patch.scene = pick([{ location: names[id] }, { location: names[id].toUpperCase().replace(/Е/gu, 'Ё') }, { locationId: id }, { location: 'Неизвестное место' }, null, { location_id: null, location: names[id] }])
    },
    () => {
      patch.adventure = clone(base.adventure ?? {})
      patch.adventure.history = [...(patch.adventure.history ?? []), pick([{ location: names[pick(locationIds)] }, { location_id: pick(locationIds) }, { location: 'Нигде' }, null])]
      if (random() < 0.3) patch.adventure.visitedLocationIds = locationIds.filter(() => random() < 0.5)
    },
    () => {
      const memory = clone(base.worldMemory ?? {})
      memory.knowledge_revealed = clueIds.filter(() => random() < 0.25).map((clue) => ({ fact_id: S.scenarioClueFactId(scenario, clue) }))
      if (random() < 0.5) memory.knowledge_revealed.push({ fact_id: '' }, null)
      patch.worldMemory = memory
    },
    () => {
      const memory = clone(base.worldMemory ?? { facts: [] })
      memory.facts = [...(memory.facts ?? []), ...clueIds.filter(() => random() < 0.4).map((clue, index) => ({
        id: `found-${clue}`,
        predicate: 'discovery',
        supersedes_fact_id: pick([S.scenarioClueFactId(scenario, clue), ` ${S.scenarioClueFactId(scenario, clue)} `]),
        summary: pick([`Найдено: ${clue}`, '', `  Улика   номер ${index} `]),
        ...(random() < 0.7 ? { visibility: pick(['party', 'public', 'gm_only', null]) } : {}),
      }))]
      patch.worldMemory = memory
    },
    () => {
      patch.campaignConcept = clone(base.campaignConcept ?? {})
      const variant = Math.floor(random() * 5)
      if (variant === 0) patch.campaignConcept.campaign_mode = 'persistent'
      else if (variant === 1) patch.campaignConcept.arc = { ...patch.campaignConcept.arc, scenario_version: 2 }
      else if (variant === 2) patch.campaignConcept.arc = { ...patch.campaignConcept.arc, version: 'skazanie:evening-arc-v1' }
      else if (variant === 3) patch.campaignConcept.arc = null
      else patch.campaignConcept.arc = { ...patch.campaignConcept.arc, scenario_version: 1.0, scenario_id: 'astohan-dragon-hunt' }
    },
    () => {
      const map = clone(base.worldMap ?? { locations: [], routes: [] })
      for (const location of map.locations) if (random() < 0.4) location.known = pick([false, true, undefined])
      for (const route of map.routes) if (random() < 0.4) route.discovered = pick([false, true, undefined])
      for (const location of map.locations) if (random() < 0.2) location.visited = pick([true, false, 'да'])
      patch.worldMap = map
    },
    () => {
      const map = clone(base.worldMap ?? { locations: [], routes: [] })
      for (const route of map.routes) {
        if ([route.from, route.to].sort().join() === ['astohan-smugglers-cave', 'astohan-vulkanis-brazier'].sort().join()) route.discovered = pick([true, false, undefined])
      }
      patch.worldMap = map
      patch.scenario_attention = { value: pick([5, 6, 9]) }
    },
  ]
  const count = 1 + Math.floor(random() * 3)
  for (let index = 0; index < count; index += 1) pick(choices)()
  return patch
}

// ---------- прогон функций ----------

const safe = (fn) => {
  try {
    const value = fn()
    return value instanceof Set ? [...value] : value === undefined ? '__undefined__' : value
  } catch (error) {
    return { throws: String(error?.message ?? error) }
  }
}
const informantDigest = (list) => (Array.isArray(list) ? list.map((entry) => ({ id: entry.id, revealed: entry.revealed })) : list)
const treatyDigest = (treaty) => (treaty && typeof treaty === 'object' && !('throws' in treaty) ? { truth_revealed: treaty.truth_revealed, concluded: treaty.concluded } : treaty)
function revealDigest(result, input) {
  if (result === input) return { same: true }
  if (!result || typeof result !== 'object') return { value: result }
  // Изменённые точки и дороги: индекс и новый флаг.
  const changed = (after, before, flag) => (Array.isArray(after) ? after : [])
    .flatMap((entry, index) => (entry === (Array.isArray(before) ? before : [])[index] ? [] : [[index, entry?.[flag] ?? null]]))
  return {
    keys: Object.keys(result),
    locations: changed(result.locations, input?.locations, 'known'),
    routes: changed(result.routes, input?.routes, 'discovered'),
  }
}

// Тексты карточек и узлов одинаковы во всех состояниях: целиком они пишутся
// у первых случаев (`full`), у остальных — сводка того, что меняется.
const progressDigest = (progress) => (progress && typeof progress === 'object' && !('throws' in progress)
  ? {
    ...progress,
    scenario_id: undefined,
    scenario_version: undefined,
    boss: undefined,
    beats: progress.beats.map((beat) => [beat.id, beat.completed]),
    clues: progress.clues.map((clue) => [clue.id, clue.found]),
  }
  : progress)
const narratorDigest = (brief) => (brief && typeof brief === 'object' && !('throws' in brief) ? { ...brief, campaign: undefined, premise: undefined } : brief)
const directorDigest = (brief) => (brief && typeof brief === 'object' && !('throws' in brief)
  ? { ...brief, beats: brief.beats.map((beat) => beat.completed) }
  : brief)
const FULL_CASES = 40

const cases = []
let fullReveals = 0
function run(baseIndex, rawPatch) {
  // Как JSON: `undefined` в правке не должно отличать JS от Rust.
  const patch = clone(rawPatch)
  const state = { ...bases[baseIndex], ...patch }
  const full = cases.length < FULL_CASES
  const out = {
    scenario_id: safe(() => S.campaignScenario(state)?.id ?? null),
    location_id: safe(() => S.scenarioLocationId(state)),
    previous_location_id: safe(() => S.scenarioPreviousLocationId(state)),
    progress: safe(() => (full ? S.scenarioProgress(state) : progressDigest(S.scenarioProgress(state)))),
    phase: safe(() => S.scenarioPhase(state)),
    destinations: safe(() => S.scenarioDestinationIds(state)),
    encounter_for: safe(() => S.scenarioEncounterFor(state)),
    ending: safe(() => S.scenarioEnding(state)),
    narrator: safe(() => (full ? S.scenarioNarratorBrief(state) : narratorDigest(S.scenarioNarratorBrief(state)))),
    director: safe(() => (full ? S.scenarioDirectorBrief(state) : directorDigest(S.scenarioDirectorBrief(state)))),
    milestone: safe(() => S.scenarioMilestoneLevel(state)),
    informants: safe(() => informantDigest(S.scenarioInformantRules(state))),
    treaty: safe(() => treatyDigest(S.scenarioTreatyRules(state))),
    end_reason: safe(() => S.scenarioEncounterEndReason(state)),
    boss_morale: safe(() => S.scenarioBossMorale(state, BOSS)),
    other_morale: safe(() => S.scenarioBossMorale(state, 'astohan-lomar')),
    attention_ready: safe(() => S.scenarioAttentionReady(state)),
    found_clue_ids: safe(() => S.scenarioFoundClueIds(state)),
    reveals: safe(() => revealDigest(S.applyScenarioMapReveals(state, state.worldMap), state.worldMap)),
  }
  if (out.reveals && !out.reveals.same && fullReveals < 6) {
    fullReveals += 1
    out.reveals_full = safe(() => S.applyScenarioMapReveals(state, state.worldMap))
  }
  if (full || random() < 0.15) {
    const id = pick(locationIds)
    out.scene_args = [
      { location_id: id },
      pick([{ locationId: id, title: 'старое' }, { location: names[id], hook: 'x' }, { location: 'нет такого' }, { location_id: null, locationId: id }, { location_id: 'bad', location: names[id] }]),
    ].map((args) => ({ args, result: safe(() => S.scenarioSceneArgs(state, args)) }))
  }
  cases.push({ base: baseIndex, patch, full, out })
}

bases.forEach((_, index) => run(index, {}))
// Финал: каждый исход боя в логове — записанный и нет, договор до боя.
const lairIndex = bases.findIndex((base) => S.scenarioLocationId(base) === 'astohan-vulkanis-brazier')
for (const outcome of outcomes) {
  for (const recorded of [true, false]) {
    run(lairIndex, {
      mechanics: { ...bases[lairIndex].mechanics, encounter: { id: 'encounter-boss', status: 'ended', outcome, enemy_ids: [BOSS], difficulty: 'deadly' } },
      autonomy: { encounter_outcomes: recorded ? [{ encounter_id: 'encounter-boss', outcome }] : [] },
    })
  }
}
run(lairIndex, { scenario_attention: { value: 2, treaty: { concluded: true } } })
run(2, { mechanics: { encounter: { id: 'far', status: 'ended', outcome: 'enemies_defeated', enemy_ids: [BOSS], location: lairName } }, autonomy: { encounter_outcomes: [{ encounter_id: 'far' }] } })
for (let index = 0; index < 160; index += 1) {
  const baseIndex = index % 13 === 12 ? 1 : 2 + Math.floor(random() * (bases.length - 2))
  run(baseIndex, mutations(bases[baseIndex]))
}
// Полные правила (тексты) — на нескольких состояниях; остальные — по сводке.
const rules = [0, 2, 3, bases.length - 1].map((index) => ({
  base: index,
  purse: safe(() => S.scenarioPurseRules(bases[index])),
  armory: safe(() => S.scenarioArmoryRules(bases[index])),
  informants: safe(() => S.scenarioInformantRules(bases[index])),
  treaty: safe(() => S.scenarioTreatyRules(bases[index])),
}))

// Функции карточек мест: зависят только от сценария.
const scenarioState = bases[0]
const freeState = bases[1]
const junk = ['', '  astohan-redstone  ', 'unknown', 'ASTOHAN-REDSTONE']
const npcIds = [...new Set(scenario.locations.flatMap((location) => [...(location.npcs ?? []).map((npc) => npc.id), ...(location.secrets ?? []).flatMap((secret) => secret.holders ?? [])]))]
const cards = [...locationIds, ...junk].map((id) => ({
  id,
  npcs: safe(() => S.scenarioLocationNpcs(scenarioState, id)),
  npcs_free: safe(() => S.scenarioLocationNpcs(freeState, id)),
  secrets: safe(() => S.scenarioSecretsFor(scenarioState, id)),
  secrets_free: safe(() => S.scenarioSecretsFor(freeState, id)),
}))
const rewards = [...clueIds.map((clue) => S.scenarioClueFactId(scenario, clue)), 'fact:secret:scenario:x:y', ''].map((factId) => ({
  fact_id: factId,
  catalog_id: safe(() => S.scenarioClueRewardCatalogId(scenarioState, factId)),
  catalog_id_free: safe(() => S.scenarioClueRewardCatalogId(freeState, factId)),
}))
const holders = [...npcIds, 'nobody', ''].map((npcId) => ({ npc_id: npcId, fact_ids: safe(() => S.scenarioClueFactIdsKnownBy(scenario, npcId)), fact_ids_null: safe(() => S.scenarioClueFactIdsKnownBy(null, npcId)) }))
const templates = ['astohan-plains', ' astohan-plains ', 'league-nine-tides', '', 'astohan-plains\n'].map((id) => ({ id, scenario_id: safe(() => S.scenarioForWorldTemplate(id)?.id ?? null) }))
const sceneArgsOdd = ['строка', [1, 2], null, 5].map((args) => ({ args, result: safe(() => S.scenarioSceneArgs(scenarioState, args)), result_free: safe(() => S.scenarioSceneArgs(freeState, args)) }))

// ---------- форма каталога: копия модуля с открытой проверкой ----------

const source = readFileSync(modulePath, 'utf8')
const catalogUrl = new URL('data/campaign-scenarios-v1.json', root).href
let patched = source.replace("new URL('../data/campaign-scenarios-v1.json', import.meta.url)", `new URL(${JSON.stringify(catalogUrl)})`)
// Рабочая копия может хранить исходник с CRLF.
patched = patched.replace(
  /function loadScenarios\(\) \{\r?\n {2}const raw = JSON\.parse\(readFileSync\(SCENARIO_CATALOG_URL, 'utf8'\)\)/u,
  "function loadScenarios(raw = JSON.parse(readFileSync(SCENARIO_CATALOG_URL, 'utf8'))) {",
)
if (patched === source || !patched.includes('function loadScenarios(raw =')) throw new Error('копия модуля не открылась: поменялся исходник')
patched += '\nexport { validateScenario, loadScenarios }\n'
const temp = mkdtempSync(join(tmpdir(), 'sk-scenario-'))
const copy = join(temp, 'campaign-scenario-open.mjs')
writeFileSync(copy, patched)
const open = await import(pathToFileURL(copy).href)
rmSync(temp, { recursive: true, force: true })

const catalog = JSON.parse(readFileSync(new URL('data/campaign-scenarios-v1.json', root), 'utf8'))
const original = catalog.scenarios[0]
const validate = (value) => {
  try {
    open.validateScenario(value)
    return 'ok'
  } catch (error) {
    return `${error?.name === 'Error' ? '' : `${error?.name}: `}${error?.message ?? error}`
  }
}
/** Все пути объекта до глубины 6. */
function paths(value, prefix = [], out = []) {
  if (prefix.length) out.push(prefix)
  if (prefix.length >= 6 || !value || typeof value !== 'object') return out
  for (const [key, entry] of Object.entries(value)) paths(entry, [...prefix, Array.isArray(value) ? Number(key) : key], out)
  return out
}
const allPaths = paths(original)
const replacements = [null, '', 'X', 'bad id', 0, 1.5, -1, 999, true, [], {}, ['x'], { any: [] }, 'astohan-redstone', 'ash-gate', 'Ab', 'ab', 'deadly', 'goblinoids', 'persuasion', 'fire', 'str', '1d20', 'scenario_x:y-z', 'дракон', 'короткий', 'x'.repeat(50), '__delete__']
function mutate(value, path, replacement) {
  const copyValue = clone(value)
  let target = copyValue
  for (const key of path.slice(0, -1)) target = target[key]
  const last = path.at(-1)
  if (replacement === '__delete__') {
    if (Array.isArray(target)) target.splice(last, 1)
    else delete target[last]
  } else target[last] = replacement
  return copyValue
}
const validation = []
for (const path of allPaths) {
  const tries = path.length <= 2 ? 6 : 2
  for (let index = 0; index < tries; index += 1) {
    if (random() < 0.55) continue
    const replacement = pick(replacements)
    validation.push({ path, replacement, message: validate(mutate(original, path, replacement)) })
  }
}
// Составные условия и дороги — нарочно.
const finaleIndex = original.beats.findIndex((beat) => beat.kind === 'finale')
for (const [path, replacement] of [
  [['beats', 1, 'complete_when'], { count: 3, of: [{ clue: 'ash-gate' }, { clue: 'ash-seal' }] }],
  [['beats', 1, 'complete_when'], { count: 1, of: [{ clue: 'nope' }] }],
  [['beats', 1, 'complete_when'], { left: 'astohan-stormberg', visited: 'astohan-stormberg' }],
  [['beats', 1, 'complete_when'], { foo: 'x' }],
  [['beats', 1, 'complete_when'], { any: null, all: [{ left: 'ok-id' }] }],
  [['beats', 1, 'complete_when'], { all: [{ npc_defeated: 'Bad' }] }],
  [['beats', 1, 'complete_when'], { '0': 'x', left: 'y' }],
  [['beats', 1, 'complete_when'], []],
  [['beats', finaleIndex, 'boss', 'morale'], { threshold: 1 }],
  [['beats', finaleIndex, 'treaty', 'wounded_ratio'], 1],
  [['beats', finaleIndex, 'treaty', 'truth'], { clue: 'nope' }],
  [['map_reveals', 0, 'routes'], [['astohan-redstone']]],
  [['map_reveals', 0, 'routes'], ['astohan-redstone']],
  [['map_reveals', 0, 'routes'], [['astohan-redstone', 'nowhere']]],
  [['map_reveals', 0, 'locations'], []],
  [['endings', 1, 'outcomes'], ['victory']],
  [['endings', 1, 'outcomes'], 'fled'],
  [['attention', 'informants'], 'ab'],
  [['attention', 'informants'], 5],
  [['attention', 'informants', 0, 'name_stems'], ['Тобан']],
  [['attention', 'topic_stems'], ['дра']],
  [['knight', 'night'], { from_minute: 60, to_minute: 60 }],
  [['progression', 'armory', 'catalog_ids'], ['srd_5_2_1:A', 'b']],
  [['progression', 'purse', 'dice'], '1d100'],
  [['locations', 1, 'secrets', 0, 'id'], 'stormberg-journal-page'],
  [['locations', 1, 'location_id'], 'astohan-stormberg'],
  [['beats', 0, 'id'], 'ash-watch'],
  [['beats', 0], { ...original.beats[0], kind: 'chapter' }],
  [['version'], '1'],
  [['id'], 12],
]) validation.push({ path, replacement, message: validate(mutate(original, path, replacement)) })
validation.push({ path: [], replacement: null, message: validate(null) })
validation.push({ path: [], replacement: [], message: validate([]) })
validation.push({ path: [], replacement: 'строка', message: validate('строка') })

// Сценарий в каталоге записан ссылкой `{ "$scenario": правка }`: настоящий
// сценарий с наложенной правкой, чтобы эталон не повторял каталог.
const loads = [
  { schema_version: 2, scenarios: [] },
  { schema_version: 1 },
  { schema_version: '1', scenarios: [] },
  { schema_version: 1.0, scenarios: [] },
  { schema_version: 1, scenarios: [{ $scenario: {} }, { $scenario: {} }] },
  { schema_version: 1, scenarios: [{ $scenario: {} }, { $scenario: { id: 'other-scenario' } }] },
  { schema_version: 1, scenarios: [{ $scenario: {} }, { $scenario: { id: 'other-scenario', world_template_id: 'other-world' } }] },
  { schema_version: 1, scenarios: [{ $scenario: { version: 0 } }] },
].map((raw) => {
  const expanded = { ...raw, ...(raw.scenarios ? { scenarios: raw.scenarios.map((entry) => ({ ...clone(original), ...entry.$scenario })) } : {}) }
  try {
    return { raw, message: `ok:${open.loadScenarios(expanded).length}` }
  } catch (error) {
    return { raw, message: String(error?.message ?? error) }
  }
})

const fixture = {
  generated_by: 'rust/crates/sk-scenario/fixtures/gen-campaign-scenario.mjs',
  arc_version: S.SCENARIO_ARC_VERSION,
  arc_preset: S.SCENARIO_ARC_PRESET,
  arc_plan: S.buildScenarioArcPlan(scenario),
  clue_fact_id: S.scenarioClueFactId(scenario, 'ash-gate'),
  bases,
  cases,
  rules,
  cards,
  rewards,
  holders,
  templates,
  scene_args_odd: sceneArgsOdd,
  validation,
  loads,
}
writeFileSync(new URL('campaign-scenario.json', import.meta.url), `${JSON.stringify(fixture)}\n`)
const throws = JSON.stringify(cases).split('"throws"').length - 1
const endings = new Set(cases.map((entry) => entry.out.ending?.id).filter(Boolean))
const phases = new Set(cases.map((entry) => entry.out.phase))
console.log(`состояний ${bases.length}, случаев ${cases.length}, исключений JS ${throws}, развязки ${[...endings]}, фазы ${[...phases]}, проверок формы ${validation.length}`)
