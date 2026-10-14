import '../../../fixtures-env.mjs'
// Эталоны `server/scenario-attention.mjs` для Rust-переноса (`sk-attention`).
//
// 1. Цепочки событий кампании «Асстоханские равнины», собранные настоящим
//    движком (`resolveCommands`), как в `test/scenario-attention.test.mjs`:
//    расспросы, тихие проверки, бои, незнакомец (приход и выдох), осведомители,
//    кошель и оружейная, договор в логове, плюс случайные блуждания по карте.
//    Затем журнал переигрывается `applyGameEvent`: на каждом событии берутся
//    реестр до, событие и реестр после. Состояние, которое видит свёртка,
//    сводится к полям, которые она читает; генератор проверяет, что на
//    сведённом состоянии и на сведённом событии JS даёт тот же реестр, что
//    настоящий редьюсер.
// 2. Свёртка на мусорных реестрах и событиях, нормализация мусорных реестров.
// 3. Читатели состояния (внимание, шаг незнакомца, профиль, выдох, финал,
//    двор короля) на состояниях из цепочек и их правках; текст сцены
//    незнакомца; узнавание намерений в тексте игрока.
//
// Запуск: node rust/crates/sk-attention/fixtures/gen-scenario-attention.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

const root = new URL('../../../../', import.meta.url)
const A = await import(new URL('server/scenario-attention.mjs', root).href)
const S = await import(new URL('server/campaign-scenario.mjs', root).href)
const { catalogItem } = await import(new URL('server/item-catalog.mjs', root).href)
const { CampaignBootstrapper } = await import(new URL('server/campaign-bootstrap.mjs', root).href)
const { normalizeCampaignState, resolveCommands, applyGameEvent } = await import(new URL('server/rules-engine.mjs', root).href)
const { SceneArchitectAgent } = await import(new URL('server/scene-architect.mjs', root).href)
const { dice, fixedDice, maxDice, minDice } = await import(new URL('test/kit/dice.mjs', root).href)

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
// Сборка журналов и случаи — разные генераторы: кэш журналов (`ATTENTION_RUNS_CACHE`)
// не сдвигает случаи.
let random = rng(7)
const pick = (list) => list[Math.floor(random() * list.length)]
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const chance = (p) => random() < p
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u

/** Есть ли в значении половина суррогатной пары: такую строку Rust не представит. */
function hasLoneSurrogate(value) {
  if (typeof value === 'string') return LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.some(hasLoneSurrogate)
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => LONE_SURROGATE.test(key) || hasLoneSurrogate(item))
  return false
}
const jsonSafe = (value) => !hasLoneSurrogate(value)

function pickKeys(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return object
  const result = {}
  for (const key of keys) if (Object.hasOwn(object, key)) result[key] = object[key]
  return result
}

// ---------- кампании настоящим движком ----------

const HERO_TEMPLATE = { role: 'Воин · ур. 7', species: 'Человек', background: 'Странник', level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30 }
const heroes = [
  { id: 'attention-hero', character: 'Ирма', name: 'Игрок', ...HERO_TEMPLATE },
  { id: 'attention-mage', character: 'Олвин', name: 'Второй', ...HERO_TEMPLATE, hp: 40, maxHp: 40, armor: 12 },
  { id: 'attention-rogue', character: 'Тень', name: 'Третий', ...HERO_TEMPLATE, hp: 9, maxHp: 30 },
]
const admin = { isAdmin: true }
const director = { isDirector: true }

async function campaign(code, party = heroes.slice(0, 1)) {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({ code, worldTemplateId: 'astohan-plains', players: party }))
  const run = { code, party, initial, state: initial, events: [], step: 0, errors: 0 }
  run.apply = (commands, context = admin, diceService = fixedDice(10)) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `${code}-${run.step}-${index}`, ...command }))
    try {
      const result = resolveCommands(list, run.state, { diceService, context })
      run.state = normalizeCampaignState(result.state)
      run.events.push(...result.events)
      return result
    } catch (error) {
      if (process.env.ATTENTION_DEBUG) console.error(code, list[0].command_type, error.code ?? '', error.message)
      run.errors += 1
      return null
    }
  }
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && S.scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
      if (!run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })) break
    }
  }
  // Один переход в сторону цели: блуждание не ждёт прихода.
  run.hop = async (locationId) => {
    if (S.scenarioLocationId(run.state) === locationId) return
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
    run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
  }
  run.ask = (message, npcId = 'attention-villager', heroId = party[0].id, check = null) => {
    if (!run.state.social.npcs.some((npc) => npc.id === npcId && npc.location === run.state.scene.location)) {
      run.apply({ command_type: 'UpsertNpcSocialProfile', npc: {
        id: npcId, name: 'Старый Хельм', role: 'житель', location: run.state.scene.location,
        public_summary: 'Местный житель.', visibility: 'party', available: true,
      } })
    }
    const checkOutcome = check ? { check_id: `check-${run.step}`, npc_id: npcId, skill: check.skill, ability: 'cha', roll_id: `roll-${run.step}`, total: 14, modifier: 2, success: check.success !== false } : null
    return run.apply({ command_type: 'RecordNpcSocialTurn', actor_id: heroId, conversation: {
      id: `conversation:${run.step}`, npc_id: npcId, hero_id: heroId, player_message: message,
      npc_reply: 'Житель пожимает плечами.', stance: 'neutral', disclosed_fact_ids: [], relationship_delta: 0, visibility: 'party',
      ...(checkOutcome ? { check: checkOutcome } : {}),
    } }, { isSocialController: true, ...(checkOutcome ? { socialCheckOutcome: checkOutcome } : {}) })
  }
  run.ruling = (question, skill, kind = 'social') => {
    const id = `ruling-${code}-${run.step}`
    return run.apply({ command_type: 'RecordRuling', ruling_id: id, ruling: {
      id, status: 'applied', scope: 'single-action', question, interpretation: { activity_kind: kind, skill }, outcome: 'applied',
    } })
  }
  run.reveal = (clueId) => {
    const scenario = S.campaignScenario(run.state)
    const secretId = S.scenarioClueFactId(scenario, clueId)
    const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
    if (!secret) return null
    return run.apply({ command_type: 'RecordWorldFact', fact: {
      id: `fact-found-${clueId}-${run.step}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
      summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
    } })
  }
  // Встреча с запасными сидами: на тесной карте сборщик может не найти клеток
  // (`NO_SAFE_PLACEMENT_CELLS`), и тогда пробуется следующий сид.
  run.fight = (seed) => {
    for (const suffix of ['', '-b', '-c', '-d', '-e', '-f']) {
      if (run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: `${seed}${suffix}` }, director)) return true
    }
    return false
  }
  run.withAttention = (value) => {
    run.state = normalizeCampaignState({ ...run.state, scenario_attention: { ...run.state.scenario_attention, value } })
  }
  /** Начать журнал с текущего состояния (после прямой правки реестра). */
  run.restart = () => {
    run.initial = run.state
    run.events = []
  }
  return run
}

const snapshots = []
const snapshot = (run, label) => snapshots.push({ label: `${run.code}:${label}`, state: clone(run.state) })
const narrationEvents = []
const chains = []

const TOPIC_QUESTIONS = ['Что вы знаете о драконе?', 'Расскажите про Саргата, куда он летает?', 'А драконье логово далеко?', 'Видели дракона в последние дни?',
  'Говорят, огнедышащий зверь жжёт заставы', 'Кто такой Вулканис?', 'ДРАКОНЫ над холмами?', 'Слыхал про Саргатовых слуг?']
const OTHER_QUESTIONS = ['Где здесь можно купить хлеба?', 'Как пройти к мельнице?', 'Сколько стоит ночлег?', 'Кто здесь староста?', 'Адраконовы леса далеко?']

async function scriptedRuns() {
  // Расспросы, тихие проверки, бой и незнакомец.
  {
    const run = await campaign('ATT-Q', heroes.slice(0, 2))
    snapshot(run, 'start')
    await run.travel('astohan-ash-watch')
    run.ask('Что вы знаете о драконе?')
    await run.travel('astohan-redstone')
    snapshot(run, 'redstone-first')
    run.ask('Где здесь можно купить хлеба?')
    run.ask('Расскажите про Саргата, куда он летает?')
    run.ask('А драконье логово далеко?')
    await run.travel('astohan-lomar-tower')
    await run.travel('astohan-redstone')
    run.ask('Видели дракона в последние дни?', 'attention-villager', heroes[1].id, { skill: 'deception' })
    run.ask('Видели дракона в последние дни?', 'attention-villager', heroes[1].id, { skill: 'persuasion' })
    snapshot(run, 'redstone-second')
    run.fight('attention-fight')
    snapshot(run, 'stranger-due')
    run.apply({ command_type: 'StageScenarioStranger', stage: 'reveal' }, director)
    const arrived = run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, director)
    if (arrived) narrationEvents.push({ events: clone(arrived.events), state: clone(run.state) })
    snapshot(run, 'stranger-arrived')
    run.ask('Мы ищем дракона, который сжёг заставу.', A.scenarioStrangerNpcId(run.state))
    snapshot(run, 'stranger-acted')
    const revealed = run.apply({ command_type: 'StageScenarioStranger', stage: 'reveal' }, director, dice([4, 4, 4, 4, 4, 4, 4, 4, 2, 19]))
    if (revealed) narrationEvents.push({ events: clone(revealed.events), state: clone(run.state) })
    snapshot(run, 'stranger-revealed')
    await run.travel('astohan-mittlayd')
    run.ruling('Выспрашиваю у перевозчиков, где видели дракона', 'deception')
    run.ruling('Выспрашиваю у перевозчиков, где видели дракона', 'stealth')
    run.ruling('Выспрашиваю у перевозчиков, где видели дракона', 'persuasion')
    run.ruling('Ищу, где продают рыбу', 'persuasion')
    run.ruling('Ищу следы дракона на берегу', 'survival', 'exploration')
    run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'attention-fight-2' }, director)
    snapshot(run, 'mittlayd-fight')
    chains.push(run)
  }
  // Незнакомец в Митглайде: успешный спасбросок, три героя.
  {
    const run = await campaign('ATT-S', heroes)
    await run.travel('astohan-mittlayd')
    run.ask('Где дракон?')
    run.withAttention(3)
    run.restart()
    const arrived = run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, director)
    if (arrived) narrationEvents.push({ events: clone(arrived.events), state: clone(run.state) })
    run.apply({ command_type: 'UpdateObjective', objective: 'Понять незнакомца' })
    snapshot(run, 'stranger-arrived-mittlayd')
    run.ask('Кто вы такой?', A.scenarioStrangerNpcId(run.state), heroes[2].id)
    const revealed = run.apply({ command_type: 'StageScenarioStranger', stage: 'reveal' }, director, dice([6, 6, 6, 6, 6, 6, 6, 5, 20, 1, 12]))
    if (revealed) narrationEvents.push({ events: clone(revealed.events), state: clone(run.state) })
    snapshot(run, 'stranger-revealed-mittlayd')
    chains.push(run)
  }
  // Осведомители: выдать, перевербовать неудачно, отпустить; перевербовать удачно.
  {
    const run = await campaign('ATT-I', heroes.slice(0, 2))
    await run.travel('astohan-redstone')
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[0].id, informant_id: 'toban', choice: 'expose' }, {})
    run.reveal('redstone-mill')
    snapshot(run, 'toban-revealed')
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[0].id, informant_id: 'toban', choice: 'expose' }, {})
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[0].id, informant_id: 'toban', choice: 'release' }, {})
    snapshot(run, 'toban-exposed')
    await run.travel('astohan-mittlayd')
    run.reveal('mittlayd-informant')
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[1].id, informant_id: 'ferryman', choice: 'turn' }, {}, minDice())
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[1].id, informant_id: 'ferryman', choice: 'turn' }, {}, maxDice())
    snapshot(run, 'ferryman-turn-failed')
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[1].id, informant_id: 'ferryman', choice: 'release' }, {})
    snapshot(run, 'ferryman-released')
    chains.push(run)
  }
  {
    const run = await campaign('ATT-T', heroes.slice(0, 1))
    await run.travel('astohan-mittlayd')
    run.reveal('mittlayd-informant')
    run.ask('Видели дракона?')
    run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'att-t-fight' }, director)
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[0].id, informant_id: 'ferryman', choice: 'turn' }, {}, maxDice())
    snapshot(run, 'ferryman-turned')
    await run.travel('astohan-redstone')
    run.reveal('redstone-mill')
    run.apply({ command_type: 'ResolveScenarioInformant', actor_id: heroes[0].id, informant_id: 'toban', choice: 'turn' }, {}, maxDice())
    snapshot(run, 'toban-turned')
    chains.push(run)
  }
  // Двор короля: кошель и оружейная на двоих.
  {
    const run = await campaign('ATT-C', heroes.slice(0, 2))
    snapshot(run, 'court-start')
    run.apply({ command_type: 'ReceiveScenarioPurse', actor_id: heroes[0].id }, {}, dice([12]))
    run.apply({ command_type: 'ReceiveScenarioPurse', actor_id: heroes[0].id }, {}, dice([12]))
    snapshot(run, 'court-purse-one')
    run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[1].id, catalog_id: 'srd_5_2_1:cloak-of-protection' }, {})
    run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[1].id, catalog_id: 'srd_5_2_1:longsword-plus-1' }, {})
    run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[0].id, catalog_id: 'srd_5_2_1:longsword-plus-1' }, {})
    run.apply({ command_type: 'ReceiveScenarioPurse', actor_id: heroes[1].id }, {}, dice([1]))
    snapshot(run, 'court-done')
    await run.travel('astohan-ash-watch')
    snapshot(run, 'court-left')
    chains.push(run)
  }
  // Логово: готовый дракон, беспечный дракон, тайный ход, договор.
  for (const [code, value] of [['ATT-L6', 6], ['ATT-L0', 0], ['ATT-L4', 4]]) {
    const run = await campaign(code, heroes.slice(0, 2))
    await run.travel('astohan-obsidian-pass')
    await run.travel('astohan-vulkanis-brazier')
    run.withAttention(value)
    run.restart()
    snapshot(run, 'lair')
    run.apply({ command_type: 'CreateEncounter', npc_id: 'astohan-sargat', difficulty: 'deadly', seed: `lair-${value}` }, director)
    run.apply({ command_type: 'StartCombat', server_authoritative: true }, director)
    snapshot(run, 'lair-combat')
    chains.push(run)
  }
  {
    const run = await campaign('ATT-D', heroes.slice(0, 2))
    run.reveal('stormberg-journal-page')
    await run.travel('astohan-quiet-watch-camp')
    run.reveal('camp-gedrik')
    await run.travel('astohan-obsidian-pass')
    await run.travel('astohan-vulkanis-brazier')
    snapshot(run, 'treaty-ready')
    run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: heroes[1].id }, {}, minDice())
    run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: heroes[1].id }, {}, minDice())
    snapshot(run, 'treaty-refused')
    run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: heroes[0].id }, {}, maxDice())
    snapshot(run, 'treaty-concluded')
    chains.push(run)
  }
  {
    const run = await campaign('ATT-H', heroes.slice(0, 1))
    await run.travel('astohan-smugglers-cave')
    snapshot(run, 'smugglers')
    await run.travel('astohan-vulkanis-brazier')
    snapshot(run, 'via-tunnel')
    chains.push(run)
  }
}

// Блуждания: случайные шаги по сценарию, долгие журналы.
const LOCATIONS = ['astohan-stormberg', 'astohan-ash-watch', 'astohan-mittlayd', 'astohan-redstone', 'astohan-lomar-tower', 'astohan-wild-forest',
  'astohan-eldrin-heart', 'astohan-forgotten-cliffs', 'astohan-quiet-watch-camp', 'astohan-mirror-lake', 'astohan-cursed-woods', 'astohan-smugglers-cave',
  'astohan-obsidian-pass', 'astohan-vulkanis-brazier']
const CLUES = ['redstone-mill', 'mittlayd-informant', 'camp-gedrik', 'stormberg-journal-page', 'ares-confession']

const CACHE = process.env.ATTENTION_RUNS_CACHE
if (CACHE && existsSync(CACHE)) {
  const cached = JSON.parse(readFileSync(CACHE, 'utf8'))
  chains.push(...cached.chains)
  snapshots.push(...cached.snapshots)
  narrationEvents.push(...cached.narrationEvents)
} else {
  await scriptedRuns()
  await wanders()
  if (CACHE) writeFileSync(CACHE, JSON.stringify({
    chains: chains.map((run) => ({ code: run.code, party: run.party, initial: run.initial, state: run.state, events: run.events, errors: run.errors })),
    snapshots, narrationEvents,
  }))
}
random = rng(20261014)

async function wanders() {
for (const [index, size] of [1, 2, 3, 2, 1, 3].entries()) {
  const run = await campaign(`ATT-W${index}`, heroes.slice(0, size))
  // Блуждание без прямых правок реестра, чтобы журнал переигрывался целиком.
  const steps = 60
  for (let step = 0; step < steps; step += 1) {
    const hero = pick(run.party).id
    const roll = random()
    if (roll < 0.12) await run.hop(pick(LOCATIONS))
    else if (roll < 0.4) run.ask(pick(chance(0.6) ? TOPIC_QUESTIONS : OTHER_QUESTIONS), pick(['attention-villager', 'attention-smith']), hero,
      chance(0.3) ? { skill: pick(['deception', 'persuasion', 'intimidation', 'insight']), success: chance(0.5) } : null)
    else if (roll < 0.5) run.ruling(pick([...TOPIC_QUESTIONS, ...OTHER_QUESTIONS]), pick(['deception', 'stealth', 'sleight_of_hand', 'persuasion', 'intimidation', '']), pick(['social', 'social', 'exploration']))
    else if (roll < 0.57) run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: `w${index}-${step}` }, director)
    else if (roll < 0.66) {
      const stage = A.scenarioStrangerStage(run.state) ?? pick(['arrive', 'reveal'])
      const result = run.apply({ command_type: 'StageScenarioStranger', stage }, director, fixedDice(int(1, 20)))
      if (result) narrationEvents.push({ events: clone(result.events), state: clone(run.state) })
    } else if (roll < 0.74) run.reveal(pick(CLUES))
    else if (roll < 0.82) run.apply({ command_type: 'ResolveScenarioInformant', actor_id: hero, informant_id: pick(['toban', 'ferryman']), choice: pick(['expose', 'release', 'turn']) }, {}, chance(0.5) ? maxDice() : minDice())
    else if (roll < 0.87) run.apply({ command_type: 'ReceiveScenarioPurse', actor_id: hero }, {}, fixedDice(int(1, 20)))
    else if (roll < 0.92) run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: hero, catalog_id: pick(['srd_5_2_1:cloak-of-protection', 'srd_5_2_1:brooch-of-shielding', 'srd_5_2_1:adamantine-chain-mail']) }, {})
    else if (roll < 0.96) run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero }, {}, chance(0.5) ? maxDice() : minDice())
    else run.apply({ command_type: 'UpdateObjective', objective: `Шаг ${step}` })
    if (step % 10 === 0) snapshot(run, `wander-${step}`)
  }
  chains.push(run)
}
}

// ---------- журнал → шаги свёртки ----------

/** Поля состояния, которые читает свёртка. */
function reducerContext(state) {
  return {
    campaignConcept: pickKeys(state.campaignConcept, ['campaign_mode', 'arc']) && {
      ...pickKeys(state.campaignConcept, ['campaign_mode']),
      ...(state.campaignConcept?.arc ? { arc: pickKeys(state.campaignConcept.arc, ['version', 'scenario_id', 'scenario_version']) } : {}),
    },
    worldMap: { locations: (state.worldMap?.locations ?? []).map((location) => pickKeys(location, ['id', 'name'])) },
  }
}
const reducerScene = (state) => ({ scene: pickKeys(state.scene ?? {}, ['location_id', 'locationId', 'location']), partyMemberIds: state.partyMemberIds })

/** Событие без полей, которых свёртка не читает. */
function slimEvent(event) {
  const result = pickKeys(event, ['event_id', 'event_type', 'actor_id'])
  const payload = event.payload
  if (!payload || typeof payload !== 'object') return { ...result, ...(Object.hasOwn(event, 'payload') ? { payload } : {}) }
  const keep = {
    ScenarioPurseGranted: ['hero_id'], ScenarioArmoryItemChosen: ['hero_id'], ScenarioInformantTurnFailed: ['informant_id'],
    ScenarioInformantResolved: ['informant_id', 'outcome', 'location_id'], ScenarioStrangerStaged: ['stage', 'location_id'],
    EncounterCreated: ['encounter_id'],
  }[event.event_type]
  if (keep) {
    const slim = pickKeys(payload, keep)
    if (event.event_type === 'EncounterCreated' && payload.encounter) slim.encounter = pickKeys(payload.encounter, ['id'])
    return { ...result, payload: slim }
  }
  if (event.event_type === 'NpcConversationRecorded') {
    const conversation = payload.conversation
    return { ...result, payload: { conversation: conversation && {
      ...pickKeys(conversation, ['npc_id', 'player_message']),
      ...(conversation.check ? { check: pickKeys(conversation.check, ['skill']) } : {}),
    } } }
  }
  if (event.event_type === 'RulingRecorded') {
    const ruling = payload.ruling
    return { ...result, payload: { ruling: ruling && {
      ...pickKeys(ruling, ['question']),
      ...(ruling.interpretation ? { interpretation: pickKeys(ruling.interpretation, ['activity_kind', 'skill']) } : {}),
    } } }
  }
  return result
}

const chainFixtures = []
let chainSteps = 0
for (const run of chains) {
  let state = run.initial
  const context = reducerContext(state)
  const steps = []
  for (const event of run.events) {
    const before = clone(state.scenario_attention)
    state = applyGameEvent(state, event)
    const after = state.scenario_attention
    const view = clone({ ...context, ...reducerScene(state) })
    if (!isDeepStrictEqual(reducerContext(state), context)) throw new Error(`${run.code}: контекст свёртки сменился посреди журнала`)
    const slim = clone(slimEvent(event))
    const viaView = A.applyScenarioAttentionEvent(before, slim, view)
    if (!isDeepStrictEqual(viaView, after)) throw new Error(`${run.code}: сведённое состояние даёт другой реестр на ${event.event_type}`)
    if (!isDeepStrictEqual(A.applyScenarioAttentionEvent(before, event, state), after)) throw new Error(`${run.code}: свёртка вне редьюсера разошлась на ${event.event_type}`)
    steps.push({ before, event: slim, ...clone(reducerScene(state)), after: clone(after) })
  }
  if (!isDeepStrictEqual(state.scenario_attention, run.state.scenario_attention)) throw new Error(`${run.code}: replay не сошёлся`)
  chainSteps += steps.length
  chainFixtures.push({ name: run.code, errors: run.errors, context, initial: clone(run.initial.scenario_attention), steps, final: clone(run.state.scenario_attention) })
}

// Общий контекст кампании (замысел и точки карты мира) у всех журналов один.
const CONTEXT = clone(reducerContext(chains[0].initial))
/** Состояние без общего контекста: `$concept` и `$map` — подставить из `tables.context`. */
function compact(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const result = { ...state }
  if (Object.hasOwn(state, 'campaignConcept') && isDeepStrictEqual(state.campaignConcept, CONTEXT.campaignConcept)) {
    delete result.campaignConcept
    result.$concept = true
  }
  if (Object.hasOwn(state, 'worldMap') && isDeepStrictEqual(state.worldMap, CONTEXT.worldMap)) {
    delete result.worldMap
    result.$map = true
  }
  return result
}

// ---------- мусор ----------

const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
const STRINGS = ['', ' ', 'a', '  spaced\tout \n text ', 'astohan-redstone', 'astohan-mittlayd', 'astohan-stormberg', 'astohan-vulkanis-brazier',
  'astohan-ash-stranger', 'attention-hero', 'attention-mage', 'toban', 'ferryman', ' toban ', 'expose', 'release', 'turn', ' turn ', 'EXPOSE',
  'arrived', 'revealed', 'none', 'Arrived', 'questions', 'fight', 'дракон', 'Ёжик', 'ＡＢＣ', '１２', 'a b', '﻿x﻿', 'x\u0085y',
  '😀 эмодзи', 'α😀β', '0', '12', '01', '-1', '4294967295', ...PROTOTYPE_KEYS]
const ATOMS = [null, true, false, 0, 1, 2, 3, 5, 6, 7, -1, -3, 2.5, 1e21, 9_007_199_254_740_991, 9_007_199_254_740_993, '7', ' 3 ', '2.5', '0x10', '1e3', 'Infinity', 'NaN', ...STRINGS]

function longString(length) {
  const parts = ['дракон', 'Саргат', ' ', '\t', 'x', '😀', 'ё', 'Ё', '\n\n', 'abc', ',', '.']
  let text = ''
  while (text.length < length) text += pick(parts)
  return text
}
function junk(depth = 0) {
  const roll = random()
  if (depth > 2 || roll < 0.55) return chance(0.08) ? longString(int(150, 260)) : pick(ATOMS)
  if (roll < 0.75) return Array.from({ length: int(0, 3) }, () => junk(depth + 1))
  const object = {}
  for (let index = int(0, 3); index > 0; index -= 1) object[pick(['a', 'id', 'value', 'stage', ...PROTOTYPE_KEYS.slice(0, 2)])] = junk(depth + 1)
  return object
}
const list = (make, max = 4) => Array.from({ length: int(0, max) }, make)
const maybe = (make, p = 0.8) => (chance(p) ? make() : junk(1))

function junkLedger() {
  if (chance(0.06)) return junk()
  const ledger = {}
  const set = (key, make, p = 0.85) => { if (chance(p)) ledger[key] = make() }
  set('schema_version', () => pick([1, 0, 2, '1', null]))
  set('value', () => pick([0, 1, 2, 3, 4, 5, 6, 7, -2, 2.5, '4', ' 5 ', null, 'x', 1e21, 9_007_199_254_740_993, [3], true]))
  set('visit', () => pick([0, 1, 2, 3, 9, -1, '2', null, 1.5]))
  set('counted', () => maybe(() => list(() => pick([`questions:${pick(LOCATIONS)}:${int(0, 3)}`, `fight:${pick(['e1', 'e2', 'encounter-x'])}`, 'informant:toban', 'informant:ferryman', ...ATOMS]), 6)))
  set('history', () => maybe(() => list(() => (chance(0.85) ? {
    delta: pick([1, 2, -1, '2', null, 2.5]), value: pick([0, 1, 3, 6, -1, '4']), reason: pick(['questions', 'fight', 'informant-expose', longString(50), 7, null]),
    location_id: pick([...LOCATIONS, longString(130), null]), event_id: pick(['ev-1', 'event-2', longString(170), 3, null]),
  } : junk(1)), 5)))
  set('stranger', () => (chance(0.8) ? {
    ...(chance(0.8) ? { stage: pick(['none', 'arrived', 'revealed', 'Arrived', 'gone', null, 1]) } : {}),
    ...(chance(0.7) ? { location_id: pick([...LOCATIONS, '', ' astohan-redstone ', null, 5, longString(130)]) } : {}),
    ...(chance(0.7) ? { party_acted: pick([true, false, 'true', 1, null]) } : {}),
  } : junk(1)))
  set('treaty', () => (chance(0.8) ? {
    ...(chance(0.7) ? { concluded: pick([true, false, 'true', 1, null]) } : {}),
    ...(chance(0.7) ? { concluded_by: pick(['attention-hero', '', null, 7, longString(130)]) } : {}),
    ...(chance(0.7) ? { attempts: maybe(() => list(() => pick([...STRINGS, null, 3]), 4)) } : {}),
  } : junk(1)))
  set('purse_paid', () => maybe(() => list(() => pick([...STRINGS, null, 3, heroes[0].id, heroes[1].id]), 4)))
  set('armory_taken', () => maybe(() => list(() => pick([...STRINGS, null, 3, heroes[0].id, heroes[1].id]), 4)))
  set('informants', () => {
    if (chance(0.15)) return junk(1)
    if (chance(0.1)) return list(() => pick(['expose', 'turn', 'x']), 3)
    const object = {}
    for (let index = int(0, 4); index > 0; index -= 1) object[pick(['toban', 'ferryman', ' toban ', '12', '3', '01', '', ...PROTOTYPE_KEYS, longString(90)])] = pick(['expose', 'release', 'turn', ' turn ', 'EXPOSE', '', null, 2, longString(30)])
    return object
  })
  set('informant_turn_failed', () => maybe(() => list(() => pick([...STRINGS, null, 3]), 4)))
  if (chance(0.1)) ledger.extra = junk(1)
  return ledger
}

/** Длинный реестр: срезы последних 200 и 40. */
function longLedger() {
  const ledger = junkLedger()
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return ledger
  ledger.counted = Array.from({ length: int(195, 230) }, (_, index) => (index % 17 === 0 ? '' : `questions:${pick(LOCATIONS)}:${index}`))
  ledger.history = Array.from({ length: int(35, 50) }, (_, index) => ({ delta: 1, value: index % 7, reason: 'questions', location_id: pick(LOCATIONS), event_id: `ev-${index}` }))
  ledger.purse_paid = Array.from({ length: int(195, 210) }, (_, index) => `hero-${index % 203}`)
  ledger.informant_turn_failed = Array.from({ length: int(195, 210) }, (_, index) => `informant-${index}`)
  ledger.treaty = { concluded: false, concluded_by: '', attempts: Array.from({ length: int(195, 210) }, (_, index) => `hero-${index}`) }
  return ledger
}

const realStates = snapshots.map((entry) => entry.state)
const scenarioState = realStates[0]

function junkReducerState() {
  const base = pick(realStates)
  if (chance(0.08)) return chance(0.5) ? {} : junk()
  const state = { ...reducerContext(base), ...reducerScene(base) }
  const roll = random()
  if (roll < 0.25) state.scene = { location_id: pick([...LOCATIONS, '', 'unknown-place']) }
  else if (roll < 0.35) state.scene = { location: pick(['Редстоуновка', 'Митглайд', 'Штормберг', ' Митглайд ', 'митглайд', 'Нигде', '']) }
  else if (roll < 0.4) state.scene = { locationId: pick(LOCATIONS) }
  else if (roll < 0.45) delete state.scene
  if (chance(0.25)) state.partyMemberIds = pick([[], [heroes[0].id], [heroes[0].id, heroes[1].id], [null, 3], 'attention-hero', null])
  if (chance(0.1)) state.campaignConcept = pick([{}, { ...state.campaignConcept, campaign_mode: 'persistent' }, { arc: { ...state.campaignConcept.arc, scenario_version: 2 } }, null])
  return state
}

function junkEvent(ledgerHint) {
  if (chance(0.04)) return pick([null, undefined, false, 0, '', 'SceneAdvanced', 5, []])
  const type = pick(['SceneAdvanced', 'ScenarioStrangerStaged', 'NpcConversationRecorded', 'RulingRecorded', 'EncounterCreated', 'ScenarioPurseGranted',
    'ScenarioArmoryItemChosen', 'ScenarioInformantResolved', 'ScenarioInformantTurnFailed', 'ScenarioTreatyConcluded', 'ScenarioTreatyRefused',
    'DamageApplied', 'ActorMoved', 'UpdateObjective', '', null, 7])
  const event = {}
  if (chance(0.95)) event.event_type = type
  if (chance(0.85)) event.event_id = pick([`ev-${int(1, 999)}`, '', null, 12, longString(170)])
  if (chance(0.7)) event.actor_id = pick([heroes[0].id, heroes[1].id, 'astohan-ash-stranger', 'npc-x', '', null, 3, ' attention-hero '])
  const payload = {}
  switch (type) {
    case 'ScenarioStrangerStaged':
      if (chance(0.9)) payload.stage = pick(['arrived', 'revealed', 'arrive', 'reveal', null, ''])
      if (chance(0.8)) payload.location_id = pick([...LOCATIONS, '', null, ' astohan-mittlayd ', 9])
      break
    case 'NpcConversationRecorded':
      if (chance(0.9)) payload.conversation = chance(0.9) ? {
        ...(chance(0.9) ? { npc_id: pick(['attention-villager', 'astohan-ash-stranger', ' astohan-ash-stranger ', null, 4]) } : {}),
        ...(chance(0.9) ? { player_message: pick([...TOPIC_QUESTIONS, ...OTHER_QUESTIONS, longString(int(10, 1200)), null, 5, ['дракон']]) } : {}),
        ...(chance(0.4) ? { check: chance(0.85) ? { skill: pick(['deception', 'stealth', 'sleight_of_hand', 'sleight-of-hand', ' deception ', 'persuasion', null]) } : junk(1) } : {}),
      } : junk(1)
      break
    case 'RulingRecorded':
      if (chance(0.9)) payload.ruling = chance(0.9) ? {
        ...(chance(0.9) ? { question: pick([...TOPIC_QUESTIONS, ...OTHER_QUESTIONS, null, 3]) } : {}),
        ...(chance(0.85) ? { interpretation: chance(0.9) ? {
          ...(chance(0.9) ? { activity_kind: pick(['social', 'social', 'exploration', 'Social', null]) } : {}),
          ...(chance(0.8) ? { skill: pick(['deception', 'stealth', 'persuasion', '', null, 'sleight-of-hand']) } : {}),
        } : junk(1) } : {}),
      } : junk(1)
      break
    case 'EncounterCreated':
      if (chance(0.6)) payload.encounter_id = pick(['enc-1', 'enc-2', '', null, 5])
      if (chance(0.6)) payload.encounter = chance(0.85) ? { id: pick(['enc-1', 'enc-3', '', null]) } : junk(1)
      break
    case 'ScenarioPurseGranted':
    case 'ScenarioArmoryItemChosen':
      if (chance(0.8)) payload.hero_id = pick([heroes[0].id, heroes[1].id, '', null, 7, ' attention-hero '])
      break
    case 'ScenarioInformantResolved':
      if (chance(0.9)) payload.informant_id = pick(['toban', 'ferryman', 'stranger', '', null, ' toban ', '12', ...PROTOTYPE_KEYS])
      if (chance(0.9)) payload.outcome = pick(['expose', 'release', 'turn', 'EXPOSE', '', null, ' expose '])
      if (chance(0.7)) payload.location_id = pick([...LOCATIONS, '', null])
      break
    case 'ScenarioInformantTurnFailed':
      if (chance(0.9)) payload.informant_id = pick(['toban', 'ferryman', '', null, ' ferryman '])
      break
    default:
      if (chance(0.3)) payload.whatever = junk(1)
  }
  if (chance(0.9)) event.payload = chance(0.93) ? payload : pick([null, 'text', 5, []])
  void ledgerHint
  return event
}

let jsThrows = 0
/** Выход JS или `THROWS`, если JS бросает исключение на этом входе. */
const THROWS = Symbol('throws')
function attempt(make) {
  try {
    return make()
  } catch {
    jsThrows += 1
    return THROWS
  }
}

const applyCases = []
for (let index = 0; index < 2000; index += 1) {
  const ledger = clone(index % 60 === 0 ? longLedger() : chance(0.5) ? junkLedger() : clone(pick(chainFixtures).steps.length ? pick(pick(chainFixtures).steps).before : undefined))
  const event = clone(junkEvent(ledger))
  const state = clone(junkReducerState())
  const expected = attempt(() => A.applyScenarioAttentionEvent(ledger, event, state))
  if (expected === THROWS) continue
  const entry = { ...(ledger === undefined ? {} : { ledger }), ...(event === undefined ? {} : { event }), state, expected }
  if (!jsonSafe(entry)) continue
  applyCases.push({ ...entry, state: compact(entry.state) })
}

const normalizeCases = []
for (let index = 0; index < 700; index += 1) {
  const input = clone(index % 40 === 0 ? longLedger() : index % 7 === 0 ? junk() : junkLedger())
  const expected = attempt(() => A.normalizeScenarioAttentionState(input))
  if (expected === THROWS) continue
  const entry = { ...(input === undefined ? {} : { input }), expected }
  if (!jsonSafe(entry)) continue
  normalizeCases.push(entry)
}
normalizeCases.push({ expected: A.normalizeScenarioAttentionState() })

// ---------- читатели состояния ----------

function readerView(state) {
  const view = { ...reducerContext(state), ...reducerScene(state) }
  if (Object.hasOwn(state, 'players')) view.players = Array.isArray(state.players) ? state.players.map((player) => pickKeys(player, ['id', 'character', 'name'])) : state.players
  if (state.social) view.social = { npcs: (state.social.npcs ?? []).map((npc) => pickKeys(npc, ['id', 'location'])) }
  view.mechanics = {
    ...(state.mechanics?.combat ? { combat: pickKeys(state.mechanics.combat, ['active']) } : {}),
    ...(state.mechanics?.campaign_lifecycle ? { campaign_lifecycle: pickKeys(state.mechanics.campaign_lifecycle, ['status']) } : {}),
  }
  if (Object.hasOwn(state, 'scenario_attention')) view.scenario_attention = state.scenario_attention
  if (state.adventure) view.adventure = { history: (state.adventure.history ?? []).map((entry) => pickKeys(entry, ['location_id', 'location'])) }
  return view
}

const ENEMY_LISTS = [['astohan-sargat'], [], ['astohan-ash-goblin'], [null], [5], ['astohan-ash-goblin', 'astohan-sargat'], [' astohan-sargat ']]
const VIEWERS = ['', ...heroes.map((hero) => hero.id), 'stranger-id', ' attention-hero ']

function readers(state) {
  return {
    attention: A.scenarioAttention(state),
    stranger_stage: A.scenarioStrangerStage(state),
    stranger_npc_id: A.scenarioStrangerNpcId(state),
    profile_available: A.scenarioStrangerProfile(state),
    profile_unavailable: A.scenarioStrangerProfile(state, { available: false }),
    breath: A.scenarioStrangerBreath(state),
    finale: ENEMY_LISTS.map((enemyIds) => A.scenarioFinaleTactics(state, enemyIds)),
    court: VIEWERS.map((playerId) => A.scenarioCourtForViewer(state, { playerId })),
  }
}

function perturb(view) {
  const state = clone(view)
  const roll = random()
  if (chance(0.6)) {
    const ledger = A.normalizeScenarioAttentionState(state.scenario_attention)
    ledger.value = pick([0, 1, 2, 3, 4, 5, 6, 7, -1, '6', 2.5])
    if (chance(0.5)) ledger.stranger = { stage: pick(['none', 'arrived', 'revealed', 'gone']), location_id: pick([...LOCATIONS, '']), party_acted: pick([true, false]) }
    if (chance(0.3)) ledger.purse_paid = list(() => pick([...heroes.map((hero) => hero.id), 'x']), 3)
    if (chance(0.3)) ledger.armory_taken = list(() => pick([...heroes.map((hero) => hero.id), 'x']), 3)
    if (chance(0.3)) ledger.informants = { toban: pick(['expose', 'turn', 'release']) }
    state.scenario_attention = chance(0.05) ? junk(1) : ledger
  }
  if (chance(0.3)) state.mechanics = { ...state.mechanics, combat: { active: pick([true, false, 1, 0, 'yes', '', null]) } }
  if (chance(0.3)) state.mechanics = { ...state.mechanics, campaign_lifecycle: pick([{ status: 'active' }, { status: 'completed' }, { status: '' }, { status: 0 }, { status: 1 }, {}]) }
  if (roll < 0.3) state.scene = { ...state.scene, location_id: pick(LOCATIONS) }
  else if (roll < 0.4) state.scene = { location: pick(['Редстоуновка', 'Митглайд', 'Штормберг', 'Нигде', '']) }
  if (chance(0.25)) state.adventure = { history: [...(state.adventure?.history ?? []), pick([{ location_id: 'astohan-smugglers-cave' }, { location_id: 'astohan-obsidian-pass' }, { location: 'Пещера контрабандистов' }, {}])] }
  if (chance(0.15)) state.players = pick([[], [{ id: heroes[0].id, character: '', name: '' }], [{ id: 5, name: 'Число' }], [{ character: 'Без id' }], null])
  if (chance(0.15)) state.social = { npcs: [...(state.social?.npcs ?? []), { id: 'astohan-ash-stranger', location: pick(['Таверна у моста', '', '  Митглайд  ', 7]) }] }
  if (chance(0.06)) state.campaignConcept = pick([{}, { ...state.campaignConcept, campaign_mode: 'persistent' }, null])
  return state
}

const readerCases = []
for (const entry of snapshots) {
  const view = clone(readerView(entry.state))
  if (!isDeepStrictEqual(readers(view), readers(entry.state))) throw new Error(`${entry.label}: читатели на сведённом состоянии разошлись`)
  readerCases.push({ label: entry.label, state: compact(view), expected: readers(view) })
}
for (let index = 0; index < 500; index += 1) {
  const view = clone(perturb(readerView(pick(snapshots).state)))
  const expected = attempt(() => readers(view))
  if (expected === THROWS) continue
  const entry = { label: `perturbed-${index}`, state: view, expected }
  if (!jsonSafe(entry)) continue
  readerCases.push({ ...entry, state: compact(entry.state) })
}
readerCases.push({ label: 'empty', state: {}, expected: readers({}) })

// ---------- текст сцены незнакомца ----------

const narrationView = (state) => ({ ...reducerContext(state), ...(Object.hasOwn(state, 'players') ? { players: readerView(state).players } : {}) })
/** События шага незнакомца без полей, которых текст не читает. */
function slimNarrationEvent(event) {
  if (!event || typeof event !== 'object') return event
  const result = pickKeys(event, ['event_type', 'target_ids'])
  if (event.payload && typeof event.payload === 'object') result.payload = pickKeys(event.payload, ['stage', 'breath', 'source', 'total', 'saved', 'applied_amount'])
  else if (Object.hasOwn(event, 'payload')) result.payload = event.payload
  return result
}
const narrationCases = []
for (const entry of narrationEvents) {
  const view = clone(narrationView(entry.state))
  const events = clone(entry.events.map(slimNarrationEvent))
  const expected = A.scenarioStrangerNarration(entry.events, entry.state)
  if (A.scenarioStrangerNarration(events, view) !== expected) throw new Error('текст незнакомца на сведённом состоянии разошёлся')
  entry.events = events
  narrationCases.push({ events, state: compact(view), expected })
}
function mutateEvents(events) {
  const result = clone(events)
  for (const event of result) {
    if (!event || typeof event !== 'object') continue
    if (event.event_type === 'ScenarioStrangerStaged' && chance(0.4)) {
      const roll = random()
      if (roll < 0.25) delete event.payload.breath
      else if (roll < 0.5) event.payload.breath = { ...event.payload.breath, ability: pick(['wis', 'con', 'xyz', null, 3]), damage_type: pick(['cold', 'acid', 'xyz', '', null]) }
      else if (roll < 0.6) event.payload.breath = pick([null, 'text', 5])
      else if (roll < 0.75) event.payload.breath = { ...event.payload.breath, dc: pick([15, '17', null, [17, 18], 2.5]) }
      else event.payload.stage = pick(['arrived', 'revealed', 'gone'])
    }
    if (event.event_type === 'SavingThrowResolved' && chance(0.4)) {
      const roll = random()
      if (roll < 0.3) event.payload.total = pick(['12', 'abc', null, 2.5, 1e21])
      else if (roll < 0.5) delete event.payload.total
      else if (roll < 0.7) event.payload.saved = pick([1, 0, '', 'yes', null])
      else if (roll < 0.85) event.target_ids = pick([[], [5], null, ['nobody']])
      else event.payload.source = 'other'
    }
    if (event.event_type === 'DamageApplied' && chance(0.4)) {
      const roll = random()
      if (roll < 0.4) event.payload.applied_amount = pick(['12', -4, null, 2.5, 'x'])
      else if (roll < 0.6) event.target_ids = ['nobody']
      else event.event_type = 'Other'
    }
  }
  if (chance(0.1)) result.reverse()
  return result
}
for (let index = 0; index < 300; index += 1) {
  const base = pick(narrationEvents)
  const events = clone(chance(0.03) ? pick([null, 'x', {}]) : mutateEvents(base.events))
  const state = clone(narrationView(base.state))
  if (chance(0.2)) state.players = pick([[], [{ id: heroes[0].id, character: '', name: '' }], [{ id: heroes[1].id, character: 0, name: 'Имя' }], null, [{ name: 'Без id' }]])
  if (chance(0.04)) delete state.campaignConcept
  const expected = attempt(() => A.scenarioStrangerNarration(events, state))
  if (expected === THROWS) continue
  const entry = { ...(events === undefined ? {} : { events }), state, expected }
  if (!jsonSafe(entry)) continue
  narrationCases.push({ ...entry, state: compact(entry.state) })
}

// ---------- намерения в тексте игрока ----------

function phrase(banks, noise, { punctuation = true } = {}) {
  const parts = []
  for (const bank of banks) if (chance(0.85)) parts.push(pick(bank))
  for (let index = int(0, 3); index > 0; index -= 1) parts.splice(int(0, parts.length), 0, pick(noise))
  let text = parts.join(pick([' ', ' ', '  ', ', ', ' — ', '\n']))
  if (punctuation && chance(0.4)) text += pick(['.', '!', '?', '…'])
  if (chance(0.25)) text = text.toUpperCase()
  if (chance(0.15)) text = text.replace(/е/gu, 'ё')
  if (chance(0.1)) text = `  ${text}  `
  return text
}

const NOISE = ['я', 'мы', 'с', 'и', 'хочу', 'предлагаю', 'отряд', 'ему', 'уйти', 'в', 'деревне', 'будет ли', 'королю', 'сейчас же', 'тихо', '42', 'x',
  'Ирма', 'громко', '😀', 'потом', 'а', 'не', 'про', 'зовут', '.', '!', 'ё-моё']

const config = S.campaignScenario(scenarioState).attention
const topicCases = []
const TOPIC_WORDS = ['дракон', 'Дракона', 'драконьих', 'ДРАКОНУ', 'адракон', 'Саргат', 'саргату', 'Вулканис', 'вулканиса', 'огнедышащий', 'огнедыш', 'драк', 'сар-гат',
  'дра́кон', 'дракон́', 'дракон2', 'Ёлка', 'ёдракон', 'İstanbul', 'ΣΑΡΓΑΣ', 'дракон_x']
const TOPIC_CONFIGS = [config, null, {}, { topic_stems: [] }, { topic_stems: ['ёж', 'еж', 'saрг'] }, { topic_stems: [5, null, 'дра'] }]
for (let index = 0; index < 1500; index += 1) {
  const text = chance(0.03) ? pick([null, 5, ['дракон', 'x'], { a: 1 }, true]) : chance(0.03) ? longString(int(900, 1100)) : phrase([TOPIC_WORDS, NOISE], [...NOISE, ...TOPIC_WORDS])
  const configIndex = index % 5 === 0 ? int(0, TOPIC_CONFIGS.length - 1) : 0
  const configValue = TOPIC_CONFIGS[configIndex]
  const entry = { config: configIndex, ...(text === undefined ? {} : { text }), expected: A.mentionsScenarioTopic(configValue, text) }
  if (!jsonSafe(entry)) continue
  topicCases.push(entry)
}

const TREATY = ['договор', 'договориться', 'договариваемся', 'договорится', 'договорной', 'мир', 'мира', 'миром', 'миру', 'мирный', 'миры', 'перемирие', 'перемирия',
  'сделка', 'сделку', 'уговор', 'уговариваю', 'убеждаю', 'убеждать', 'переговоры', 'переговорах', 'виру', 'вира', 'вирой', 'приговор', 'мироед', 'смир', 'размирие', 'Договор']
const PARTNER = ['дракон', 'дракону', 'драконом', 'Дракона', 'саргат', 'Саргату', 'Саргатом', 'драконий', 'драконы', 'недракон', 'сарга', 'ДРАКОН']
const treatyStates = [null, ...snapshots.filter((entry) => /lair|treaty|via-tunnel|redstone|court-start/u.test(entry.label)).map((entry) => readerView(entry.state)), {}]
for (const view of treatyStates.slice(1, -1)) {
  const full = snapshots.find((entry) => isDeepStrictEqual(readerView(entry.state), view)).state
  for (const text of ['Предлагаю Саргату договор', 'мир с драконом', 'привет']) {
    if (!isDeepStrictEqual(A.scenarioTreatyActionFromText(text, full), A.scenarioTreatyActionFromText(text, view))) throw new Error('договор на сведённом состоянии разошёлся')
  }
}
const treatyCases = []
for (let index = 0; index < 1500; index += 1) {
  const text = chance(0.03) ? pick([null, 5, ['мир', 'дракон'], '']) : phrase([TREATY, PARTNER], [...NOISE, ...TREATY.slice(0, 5), ...PARTNER.slice(0, 3)])
  const stateIndex = index % 3 === 0 ? int(0, treatyStates.length - 1) : 0
  const state = treatyStates[stateIndex]
  const entry = { ...(text === undefined ? {} : { text }), state: stateIndex, expected: A.scenarioTreatyActionFromText(text, state) }
  if (!jsonSafe(entry)) continue
  treatyCases.push(entry)
}

const PURSE = ['кошель', 'кошелёк', 'кошелек', 'кошельки', 'кошёл', 'кошел', 'жалованье', 'жалование', 'плата', 'платы', 'плату', 'плате', 'золото', 'золота', 'кошельку']
const KING = ['короля', 'королевский', 'Ареса', 'арестант', 'казны', 'казначей', 'казна', 'корол', 'АРЕС', 'королю']
const SPACER = ['', ' ', ' от ', ' из ', ' у ', ' нашего доброго ', ' — а это что? — ', ' очень-очень-очень длинная прослойка слов между ними ', '. ', '! ', ' ? ']
const purseCases = []
for (let index = 0; index < 1500; index += 1) {
  let text
  if (chance(0.03)) text = pick([null, 5, '', ['кошель', 'короля']])
  else if (chance(0.6)) {
    const [first, second] = chance(0.5) ? [PURSE, KING] : [KING, PURSE]
    text = `${chance(0.3) ? pick(NOISE) + ' ' : ''}${pick(first)}${pick(SPACER)}${pick(second)}${chance(0.3) ? ' ' + pick(NOISE) : ''}`
    if (chance(0.2)) text = text.toUpperCase()
  } else text = phrase([PURSE, KING], NOISE)
  const entry = { ...(text === undefined ? {} : { text }), expected: A.scenarioPurseActionFromText(text) }
  if (!jsonSafe(entry)) continue
  purseCases.push(entry)
}

const revealedState = snapshots.find((entry) => entry.label.endsWith('ferryman-released'))?.state ?? scenarioState
const realInformants = S.scenarioInformantRules(revealedState)
const INFORMANT_LISTS = [
  realInformants,
  realInformants.filter((informant) => informant.id === 'toban'),
  [],
  [{ id: 'x', name_stems: ['ёж', ''] }],
  [{ id: 7, name_stems: ['тоб'] }, { name_stems: ['ларс'] }],
  [{ id: 'empty', name_stems: [] }, ...realInformants],
]
const INFORMANT_NAMES = ['Тобан', 'Тобана', 'тобану', 'мельник', 'мельника', 'Ларс', 'Ларса', 'перевозчик', 'перевозчика', 'паромщику', 'Тобанов', 'атобан', 'ёжик']
const INFORMANT_VERBS = ['перевербовать', 'перевербовываю', 'переманиваю', 'переманить', 'перемани', 'склоняю на нашу', 'склоняем  на  нашу сторону', 'работать на нас',
  'работать  на\tнас', 'шлите дракону ложь', 'шлёт дракону ложь', 'ложные вести', 'ложную весть', 'выдаём', 'выдать', 'сдаём', 'сдать', 'арестовать', 'арестуем',
  'разоблачаю', 'страже', 'стража', 'отпускаем', 'отпустить', 'отпущен', 'пощадим', 'пощади', 'пусть уходит', 'пусть  уходят', 'привет', 'вы да']
const informantCases = []
for (let index = 0; index < 1500; index += 1) {
  const text = chance(0.03) ? pick([null, 5, '']) : phrase([INFORMANT_VERBS, INFORMANT_NAMES, NOISE], [...NOISE, ...INFORMANT_VERBS.slice(0, 4)])
  const listIndex = index % 4 === 0 ? int(0, INFORMANT_LISTS.length - 1) : 0
  const informants = INFORMANT_LISTS[listIndex]
  const entry = { ...(text === undefined ? {} : { text }), informants: listIndex, expected: A.scenarioInformantActionFromText(text, informants) }
  if (!jsonSafe(entry)) continue
  informantCases.push(entry)
}

const armoryRules = S.scenarioArmoryRules(scenarioState)
const realChoices = armoryRules.catalog_ids.map((catalogId) => ({ catalog_id: catalogId, name: String(catalogItem(catalogId)?.name ?? '') })).filter((choice) => choice.name)
const CHOICE_LISTS = [
  realChoices,
  realChoices.slice(0, 2),
  [],
  [{ catalog_id: 'x:short', name: 'Ёж +1' }, { catalog_id: 'x:long', name: 'Большой ёжик защиты' }],
  [{ name: 'плащ защиты' }, { catalog_id: null, name: 'плащ' }, { catalog_id: 'x:digits', name: 'меч 123 +2' }],
  [{ catalog_id: 'x:same-1', name: 'Плащ защиты' }, { catalog_id: 'x:same-2', name: 'плащ защиты' }],
]
const ITEM_WORDS = [...new Set(realChoices.flatMap((choice) => choice.name.toLocaleLowerCase('ru').split(/[^\p{L}\d+]+/u)).filter(Boolean)),
  'плащ', 'плаща', 'защиты', 'брошь', 'броши', 'кольчугу', 'адамантиновую', 'меч', 'длинный', 'предупреждения', 'ёжика', '+1', 'меча']
const ARMORY_PLACE = ['оружейной', 'оружейная', 'арсенала', 'арсенал', 'кладовой короля', 'кладовая  королевская', 'кладовка', 'оружие']
const ARMORY_TAKE = ['беру', 'берём', 'берем', 'беру-ка', 'возьму', 'возьмём', 'выбираю', 'выберу', 'забираю', 'заберу', 'взять', 'получу', 'получаем', 'берусь', 'отберу']
const armoryCases = []
for (let index = 0; index < 1500; index += 1) {
  const text = chance(0.03) ? pick([null, 5, '']) : phrase([ARMORY_TAKE, ITEM_WORDS, ITEM_WORDS, ARMORY_PLACE], [...NOISE, ...ITEM_WORDS])
  const listIndex = index % 4 === 0 ? int(0, CHOICE_LISTS.length - 1) : 0
  const choices = CHOICE_LISTS[listIndex]
  const entry = { ...(text === undefined ? {} : { text }), choices: listIndex, expected: A.scenarioArmoryActionFromText(text, choices) }
  if (!jsonSafe(entry)) continue
  armoryCases.push(entry)
}

const constants = {
  SCENARIO_ATTENTION_SCHEMA_VERSION: A.SCENARIO_ATTENTION_SCHEMA_VERSION,
  SCENARIO_ATTENTION_POLICY_ID: A.SCENARIO_ATTENTION_POLICY_ID,
  SCENARIO_COMMAND_TYPES: [...A.SCENARIO_COMMAND_TYPES],
  SCENARIO_TREATY_COMMAND_TYPES: [...A.SCENARIO_TREATY_COMMAND_TYPES],
  SCENARIO_TREATY_CONCLUDED_EVENT: A.SCENARIO_TREATY_CONCLUDED_EVENT,
  SCENARIO_TREATY_REFUSED_EVENT: A.SCENARIO_TREATY_REFUSED_EVENT,
  SCENARIO_PURSE_COMMAND_TYPES: [...A.SCENARIO_PURSE_COMMAND_TYPES],
  SCENARIO_PURSE_EVENT: A.SCENARIO_PURSE_EVENT,
  SCENARIO_ARMORY_COMMAND_TYPES: [...A.SCENARIO_ARMORY_COMMAND_TYPES],
  SCENARIO_ARMORY_EVENT: A.SCENARIO_ARMORY_EVENT,
  SCENARIO_INFORMANT_COMMAND_TYPES: [...A.SCENARIO_INFORMANT_COMMAND_TYPES],
  SCENARIO_INFORMANT_CHOICES: [...A.SCENARIO_INFORMANT_CHOICES],
  SCENARIO_INFORMANT_EVENT: A.SCENARIO_INFORMANT_EVENT,
  SCENARIO_INFORMANT_TURN_FAILED_EVENT: A.SCENARIO_INFORMANT_TURN_FAILED_EVENT,
  SCENARIO_INFORMANT_POLICY_ID: A.SCENARIO_INFORMANT_POLICY_ID,
  SCENARIO_ARMORY_POLICY_ID: A.SCENARIO_ARMORY_POLICY_ID,
  SCENARIO_STRANGER_STAGES: [...A.SCENARIO_STRANGER_STAGES],
  SCENARIO_STRANGER_EVENT: A.SCENARIO_STRANGER_EVENT,
  SCENARIO_STRANGER_EVENT_SCHEMA_VERSION: A.SCENARIO_STRANGER_EVENT_SCHEMA_VERSION,
}

const fixture = {
  constants,
  // Общие части случаев: `$concept`/`$map` в состоянии — подставить отсюда.
  tables: {
    context: CONTEXT,
    topic_configs: TOPIC_CONFIGS,
    treaty_states: treatyStates.map((state) => (state ? compact(state) : state)),
    informant_lists: INFORMANT_LISTS,
    choice_lists: CHOICE_LISTS,
    enemy_lists: ENEMY_LISTS,
    viewers: VIEWERS,
  },
  chains: chainFixtures,
  apply: applyCases,
  normalize: normalizeCases,
  readers: readerCases,
  narration: narrationCases,
  topic: topicCases,
  treaty: treatyCases,
  purse: purseCases,
  informant: informantCases,
  armory: armoryCases,
}
const text = JSON.stringify(fixture)
if (LONE_SURROGATE.test(text)) throw new Error('в эталоне половина суррогатной пары')
writeFileSync(new URL('./scenario-attention.json', import.meta.url), `${text}\n`)
const count = (cases) => cases.length
console.log(`цепочек ${chains.length}, шагов свёртки ${chainSteps}; свёртка ${count(applyCases)}, нормализация ${count(normalizeCases)}, читатели ${count(readerCases)}, ` +
  `текст ${count(narrationCases)}, тема ${count(topicCases)}, договор ${count(treatyCases)}, кошель ${count(purseCases)}, осведомитель ${count(informantCases)}, оружейная ${count(armoryCases)}`)
console.log('ошибки команд по цепочкам:', chainFixtures.map((chain) => `${chain.name}:${chain.errors}/${chain.steps.length}`).join(' '))
console.log(`JS бросил исключение и случай пропущен: ${jsThrows}`)
console.log(`размер ${(text.length / 1024 / 1024).toFixed(2)} МБ`)
