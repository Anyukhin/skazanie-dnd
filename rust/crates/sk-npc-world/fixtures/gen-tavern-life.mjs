import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/tavern-life.mjs для Rust:
//
//   node rust/crates/sk-npc-world/fixtures/gen-tavern-life.mjs [каталог корпуса]
//
// Источники входов:
//
// - вечера за столом через настоящий Rules Engine (`resolveCommands`): кости,
//   сдачи, выпивка, скандалы, смена сцены, стол на пятерых — по сценариям
//   `test/tavern-life.test.mjs` и случайными цепочками команд; каждый верхний
//   вызов модуля изнутри конвейера (валидация, редьюсер, проекция)
//   перехватывается хуком;
// - корпус паритета: состояния с заведением и повтор команд таверны;
// - срезы заведения с мусором старых сохранений: ключи прототипа как id героя
//   и соседа, переполненные посетители и кассы, легаси-раунд.
import { fixtureWriter, mulberry32, chooser, viaJson, setOwn } from './common.mjs'
import { corpusCommand, corpusDir, corpusRecords, corpusState, replayDice } from './npc-scenes.mjs'

const tavern = await import('../../../../server/tavern-life.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer } = await import('../../../../server/viewer-projection.mjs')

const writer = fixtureWriter('tavern-life', retentionMode)
// Предел случаев функции растёт по фазам: каждой фазе — своя доля.
let phaseCap = 150
const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)

const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
}
const NPC_KEYS = ['id', 'name', 'role', 'location', 'location_id', 'locationId', 'available', 'visibility']

/** Состояние урезается до полей, которые читает tavern-life (и npc-positioning под ним). */
function strip(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  if (state.sessionCode !== undefined) out.sessionCode = state.sessionCode
  if (state.scene !== undefined) {
    out.scene = pickKeys(state.scene, ['title', 'location', 'location_id', 'locationId', 'theme', 'material', 'map'])
    if (out.scene && typeof out.scene === 'object' && out.scene.map && typeof out.scene.map === 'object') out.scene.map = pickKeys(out.scene.map, ['layout', 'theme', 'locationId'])
  }
  if (state.social !== undefined) {
    out.social = state.social && typeof state.social === 'object' && !Array.isArray(state.social)
      ? { npcs: Array.isArray(state.social.npcs) ? state.social.npcs.map((npc) => pickKeys(npc, NPC_KEYS)) : state.social.npcs }
      : state.social
  }
  if (state.npc_world !== undefined) out.npc_world = pickKeys(state.npc_world, ['vitals', 'stances'])
  if (state.tavern !== undefined) out.tavern = state.tavern
  return out
}

const FNS = {
  isTavernScene: { fn: (state) => tavern.isTavernScene(state), states: [0] },
  tavernOpponents: { fn: (state) => tavern.tavernOpponents(state), states: [0] },
  isTavernOpponent: { fn: (state, id) => tavern.isTavernOpponent(state, id), states: [0] },
  tavernGamblerFor: { fn: (state, id) => tavern.tavernGamblerFor(state, id), states: [0] },
  tavernOpponentDie: { fn: (gambler, die) => tavern.tavernOpponentDie(gambler, die), states: [] },
  normalizeTavernState: { fn: (input) => tavern.normalizeTavernState(input), states: [], refs: [0] },
  tavernRoundFor: { fn: (state, id) => tavern.tavernRoundFor(state, id), states: [0] },
  tavernGamblerPurseFor: { fn: (state, id) => tavern.tavernGamblerPurseFor(state, id), states: [0] },
  tavernPurseTransfer: { fn: (...args) => tavern.tavernPurseTransfer(...args), states: [] },
  tavernPurseTransferPayload: { fn: (transfer) => tavern.tavernPurseTransferPayload(transfer), states: [] },
  tavernOpenRounds: { fn: (state) => tavern.tavernOpenRounds(state), states: [0] },
  tavernOpenRoundsAgainst: { fn: (state, id) => tavern.tavernOpenRoundsAgainst(state, id), states: [0] },
  tavernEarmarkedCpAgainst: { fn: (state, id) => tavern.tavernEarmarkedCpAgainst(state, id), states: [0] },
  tavernFreePurseFor: { fn: (state, id) => tavern.tavernFreePurseFor(state, id), states: [0] },
  tavernMaxStakeFor: { fn: (state, id) => tavern.tavernMaxStakeFor(state, id), states: [0] },
  tavernDrinksFor: { fn: (state, id) => tavern.tavernDrinksFor(state, id), states: [0] },
  tavernScandalsFor: { fn: (state, id) => tavern.tavernScandalsFor(state, id), states: [0] },
  tavernEjected: { fn: (state, id) => tavern.tavernEjected(state, id), states: [0] },
  tavernNextDrinkDc: { fn: (state, id) => tavern.tavernNextDrinkDc(state, id), states: [0] },
  tavernSocialBonus: { fn: (state, id, skill) => tavern.tavernSocialBonus(state, id, skill), states: [0] },
  tavernTableMood: { fn: (state, id) => tavern.tavernTableMood(state, id), states: [0] },
  tavernForViewer: { fn: (state, viewer) => tavern.tavernForViewer(state, viewer), states: [0] },
  publicTavernRoundFor: { fn: (round) => tavern.publicTavernRoundFor(round), states: [] },
  applyTavernEvent: { fn: (input, event) => tavern.applyTavernEvent(input, event, {}), states: [], refs: [0] },
}

function record(name, args, options = {}) {
  const spec = FNS[name]
  options = { ...options, cap: Math.min(options.cap ?? Infinity, phaseCap) }
  const prepared = args.map((arg, index) => (spec.states.includes(index) ? strip(arg) : arg))
  return writer.call(name, spec.fn, prepared, { stateArgs: [...spec.states, ...(spec.refs ?? [])], ...options })
}

const captured = []
const capturedPerFn = new Map()
function capture(module, name, args) {
  if (module !== 'server/tavern-life.mjs' || !FNS[name]) return
  if ((capturedPerFn.get(name) ?? 0) >= 1_200) return
  capturedPerFn.set(name, (capturedPerFn.get(name) ?? 0) + 1)
  try {
    const spec = FNS[name]
    captured.push({ name, args: args.slice(0, name === 'applyTavernEvent' ? 2 : args.length).map((arg, index) => viaJson(spec.states.includes(index) ? strip(arg) : arg)) })
  } catch { /* вход не сериализуется */ }
}
function flushCaptured(cap) {
  for (const entry of captured.splice(0)) record(entry.name, entry.args, { cap })
}

// ---------------------------------------------------------------------------
// Батарея над состоянием
// ---------------------------------------------------------------------------

const ODD = ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'ghost']

function battery(state, { cap = Infinity } = {}) {
  const heroes = [...new Set([...(Array.isArray(state?.players) ? state.players : []).map((player) => player?.id).filter(Boolean).slice(0, 5), ...Object.keys(state?.tavern?.patrons ?? {}).slice(0, 3), ...ODD.filter(() => chance(0.25))])]
  const npcs = [...new Set([...(Array.isArray(state?.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id).filter(Boolean).slice(0, 5), ...Object.keys(state?.tavern?.gamblers ?? {}).slice(0, 3), ...ODD.filter(() => chance(0.25))])]
  for (const name of ['isTavernScene', 'tavernOpponents', 'tavernOpenRounds']) record(name, [state], { cap })
  record('normalizeTavernState', [state?.tavern], { cap })
  for (const npcId of npcs) {
    for (const name of ['isTavernOpponent', 'tavernGamblerFor', 'tavernGamblerPurseFor', 'tavernOpenRoundsAgainst', 'tavernEarmarkedCpAgainst', 'tavernFreePurseFor', 'tavernMaxStakeFor']) {
      record(name, [state, npcId], { cap })
    }
  }
  for (const heroId of heroes) {
    for (const name of ['tavernRoundFor', 'tavernDrinksFor', 'tavernScandalsFor', 'tavernEjected', 'tavernNextDrinkDc', 'tavernTableMood']) record(name, [state, heroId], { cap })
    record('tavernSocialBonus', [state, heroId, pick(['persuasion', 'persuasion', 'stealth', 'PERSUASION', 'per_suasion', undefined])], { cap })
    record('tavernForViewer', [state, { playerId: heroId }], { cap })
  }
  record('tavernForViewer', [state, pick([{}, undefined, { role: 'admin' }])], { cap })
}

// ---------------------------------------------------------------------------
// 1. Вечера за столом через Rules Engine
// ---------------------------------------------------------------------------

const CAMPAIGN = 'TAVERN'
const INN = 'Трактир «У моста»'
const HONEST = 'barkeep'
const CROOK = 'hunter'

function cells(width = 6, height = 6) {
  const grid = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  return grid
}

function campaign({ scene = {}, currency = { copper: 0, silver: 0, gold: 1, platinum: 0 }, minutes = 0, heroIds = ['hero'], sessionCode = CAMPAIGN, tavernState, extraNpcs = [] } = {}) {
  return rules.normalizeCampaignState({
    sessionCode,
    campaign: 'Жизнь таверны',
    activePlayerId: heroIds[0],
    partyMemberIds: [...heroIds],
    partyName: 'Отряд героев',
    scene: { title: INN, location: INN, location_id: 'inn', grid: { width: 6, height: 6 }, cells: cells(), ...scene },
    players: heroIds.map((heroId, index) => ({
      id: heroId, character: index === 0 ? 'Ада' : `Спутник ${index}`, hp: 12, maxHp: 12, x: 1 + index, y: 1, speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, proficiency: 2,
      classSkillProficiencies: [], savingThrowProficiencies: [], backgroundSkillProficiencies: [], currency, inventory: [],
    })),
    worldMap: { seed: 'tavern-seed', regions: [{ id: 'north', name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 }], locations: [{ id: 'inn', name: INN, kind: 'village', x: 200, y: 200, regionId: 'north' }], routes: [] },
    enemies: [],
    social: {
      npcs: [
        { id: HONEST, name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' },
        { id: CROOK, name: 'Охотник Кривой', role: 'охотник', location: INN, visibility: 'party', public_summary: 'Сидит у окна.' },
        ...extraNpcs,
      ],
    },
    ...(tavernState ? { tavern: tavernState } : {}),
    mechanics: { world_time: { elapsed_minutes: minutes } },
  })
}

let rollId = 0
function run(state, commands, diceValues = []) {
  return rules.resolveCommands(
    commands.map((command, index) => ({ campaign_id: state.sessionCode, command_id: `cmd-${int(1, 1e6)}-${index + 1}`, ...command })),
    state,
    { diceService: new DiceService({ rng: new SequenceDiceRng(diceValues), idFactory: () => `tavern-roll-${++rollId}`, now: () => '2026-08-20T10:00:00.000Z' }), context: { allowedActorIds: commands.map((command) => String(command.actor_id ?? 'hero')) } },
  )
}
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const open = (npcId = HONEST, stakeCp = 10, actorId = 'hero') => ({ command_type: 'OpenTavernDiceRound', actor_id: actorId, npc_id: npcId, stake_cp: stakeCp })
const answer = (approach = 'fair', actorId = 'hero') => ({ command_type: 'AnswerTavernDiceRound', actor_id: actorId, approach })
const leave = (actorId = 'hero') => ({ command_type: 'LeaveTavernDiceRound', actor_id: actorId })
const drink = (actorId = 'hero') => ({ command_type: 'OrderTavernDrink', actor_id: actorId })
const label = (name, state) => {
  writer.stateRef(strip(viaJson(state)), name)
  return state
}

const stop = startCapture(capture)
const base = label('campaign', campaign())
label('forest', campaign({ scene: { title: 'Тёмный лес', location: 'Тёмный лес' } }))
for (const title of ['Корчма на развилке', 'Постоялый двор у брода', 'Лавка старьёвщика', 'Отряд постоял у ворот', 'Стража постояла и разошлась', 'Войско постояло у брода', 'Солнце постояло в зените',
  'Пивная бочка в подвале', 'Пивной погреб под лестницей', 'Полка со швейных машинок', 'Finn у костра', 'Republic Square', 'Ночь у постоялого двора', 'Шинок у дороги', 'The Broken Inn', 'Old Alehouse',
  'КАБАК', 'харчевня', 'Таверна «Рог»', 'pub crawl', 'Pub', 'inn', 'Innkeeper', 'шинок', 'машинок']) {
  record('isTavernScene', [campaign({ scene: { title, location: title } })])
}
record('isTavernScene', [{ scene: { title: 'Поле', theme: 'tavern' } }])
record('isTavernScene', [{ scene: { title: 'Поле', map: { layout: 'inn-hall' } } }])
record('isTavernScene', [{ scene: { title: 'Поле', map: { theme: 'Трактир' } } }])
record('isTavernScene', [{ scene: 'Таверна' }])
record('isTavernScene', [{}])

const opened = attempt(() => run(base, [open(HONEST, 50)], [14]))
if (opened) {
  label('opened-honest-50', opened.state)
  const won = attempt(() => run(opened.state, [answer()], [18]))
  if (won) label('won-honest', won.state)
}
const crookOpened = attempt(() => run(base, [open(CROOK, 50)], [9]))
if (crookOpened) label('opened-crook-50', crookOpened.state)
{
  const rich = { copper: 0, silver: 0, gold: 100, platinum: 0 }
  let state = campaign({ currency: rich })
  let rounds = 0
  while (tavern.tavernMaxStakeFor(state, HONEST) >= 200 && rounds < 12) {
    state = attempt(() => run(state, [open(HONEST, 200)], [5]).state) ?? state
    state = attempt(() => run(state, [answer()], [19]).state) ?? state
    rounds += 1
  }
  label('drained-honest', state)
  const moved = attempt(() => rules.replayEvents(state, [{ event_id: 'evt-scene', command_id: 'cmd-scene', event_type: 'SceneAdvanced', actor_id: null, target_ids: [], visibility: 'party', payload: { scene: { title: INN, location: INN, location_id: 'inn' } }, state_version_after: state.state_version + 1 }]))
  if (moved) {
    label('drained-moved', moved)
    attempt(() => campaignStateForViewer(moved, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero'))
  }
}
{
  // Стол на пятерых и закреплённое покрытие.
  const heroIds = ['hero', 'hero-2', 'hero-3', 'hero-4', 'hero-5']
  let state = campaign({ heroIds, currency: { copper: 0, silver: 0, gold: 10, platinum: 0 } })
  for (const heroId of heroIds) state = attempt(() => run(state, [open(HONEST, 200, heroId)], [int(2, 18)]).state) ?? state
  label('five-heroes', state)
  for (const heroId of heroIds.slice(0, 2)) state = attempt(() => run(state, [answer(pick(['fair', 'watch', 'cheat']), heroId)], [int(1, 20), int(1, 20)]).state) ?? state
  label('five-heroes-answered', state)
  state = attempt(() => run(state, [leave('hero-3')]).state) ?? state
  label('five-heroes-left', state)
}
{
  // Скандалы и запрет входа.
  let state = campaign({ currency: { copper: 0, silver: 0, gold: 5, platinum: 0 } })
  for (let index = 0; index < 3; index += 1) {
    state = attempt(() => run(state, [open(HONEST, 10)], [10]).state) ?? state
    state = attempt(() => run(state, [answer('cheat')], [1, 20]).state) ?? state
  }
  label('ejected', state)
  state = attempt(() => run(state, [leave()]).state) ?? state
  label('ejected-left', state)
}
{
  // Выпивка по нарастающей.
  let state = campaign()
  for (let index = 0; index < 5; index += 1) {
    state = attempt(() => run(state, [drink()], [int(1, 20)]).state) ?? state
    label(`drinks-${index + 1}`, state)
  }
  const moved = attempt(() => rules.replayEvents(state, [{ event_id: 'evt-scene', command_id: 'cmd-scene', event_type: 'SceneAdvanced', actor_id: null, target_ids: [], visibility: 'party', payload: { scene: { title: 'Дорога', location: 'Дорога', location_id: 'road' } }, state_version_after: state.state_version + 1 }]))
  if (moved) label('drinks-road', moved)
}
// Потолок кассы: доля заведения.
{
  const capped = campaign({ tavernState: { patrons: {}, gamblers: { [HONEST]: { purse_cp: 9_900, last_played_at_minutes: 10 } } } })
  label('capped-purse', capped)
  const lost = attempt(() => run(capped, [open(HONEST, 200)], [19]))
  if (lost) attempt(() => run(lost.state, [answer()], [2]))
  const left = attempt(() => run(lost?.state ?? capped, [leave()]))
  if (left) label('capped-left', left.state)
}
// Случайные вечера.
for (let session = 0; session < 60; session += 1) {
  const heroIds = ['hero', 'hero-2', 'hero-3', 'hero-4', 'hero-5'].slice(0, int(1, 5))
  let state = campaign({ heroIds, sessionCode: `TAVERN-${session}`, minutes: int(0, 3000), currency: { copper: int(0, 9), silver: int(0, 9), gold: int(0, 30), platinum: 0 },
    extraNpcs: chance(0.5) ? [{ id: `guest-${session}`, name: 'Гость', role: 'путник', location: INN, visibility: pick(['party', 'gm_only', 'public']) }] : [] })
  for (let step = 0; step < int(4, 14); step += 1) {
    const heroId = pick(heroIds)
    const roll = random()
    const command = roll < 0.35 ? open(pick([HONEST, CROOK, `guest-${session}`, 'ghost']), pick([10, 50, 200, 37]), heroId)
      : roll < 0.65 ? answer(pick(['fair', 'cheat', 'watch', 'bribe']), heroId)
        : roll < 0.75 ? leave(heroId)
          : drink(heroId)
    const result = attempt(() => run(state, [command], Array.from({ length: 4 }, () => int(1, 20))))
    if (result) state = result.state
    if (chance(0.07)) state = attempt(() => rules.replayEvents(state, [{ event_id: `evt-scene-${step}`, command_id: `cmd-scene-${step}`, event_type: 'SceneAdvanced', actor_id: null, target_ids: [], visibility: 'party', payload: { scene: { title: INN, location: INN, location_id: 'inn' } }, state_version_after: state.state_version + 1 }])) ?? state
    if (chance(0.3)) attempt(() => campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: [heroId] }, heroId))
  }
  if (chance(0.5)) battery(state, { cap: 1_500 })
}
stop()
flushCaptured(500)
const afterScenarios = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Корпус
// ---------------------------------------------------------------------------

phaseCap = 240
const dir = corpusDir(process.argv[2])
if (dir) {
  const seen = new Set()
  let states = 0
  let replayed = 0
  const stopCorpus = startCapture(capture)
  for (const entry of corpusRecords(dir)) {
    if (seen.has(entry.state)) continue
    const tavernCommand = String(entry.command?.command_type ?? '').includes('Tavern')
    seen.add(entry.state)
    const state = corpusState(dir, entry.state)
    if (!state) continue
    const interesting = tavernCommand || (state.tavern && Object.keys(state.tavern.patrons ?? {}).length) || tavern.isTavernScene(state)
    if (!interesting) continue
    if (states < 90) {
      states += 1
      stopCorpus()
      battery(state)
      startCapture(capture)
    }
    if (tavernCommand && replayed < 400) {
      replayed += 1
      try {
        rules.resolveCommand(corpusCommand(entry), state, { diceService: replayDice(entry.dice), context: entry.context ?? {} })
        const after = (entry.outcome?.events ?? []).reduce(rules.applyGameEvent, rules.normalizeCampaignState(state))
        const viewer = after.players?.[0]?.id
        if (viewer) campaignStateForViewer(after, { role: 'player', playerId: viewer, heroIds: [viewer] }, viewer)
      } catch { /* отказ — тоже часть корпуса */ }
    }
  }
  stopCorpus()
  console.log(`корпус: состояний ${states}, повторено команд таверны ${replayed}, перехвачено ${captured.length}`)
  flushCaptured(900)
} else {
  console.log('корпус не найден — пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Срезы заведения с мусором
// ---------------------------------------------------------------------------

phaseCap = 340
const KEYS = ['hero', 'hero-2', ' hero ', '7', '12', 'constructor', '__proto__', 'toString', '', 'ghost', HONEST, CROOK]
function junkRound() {
  if (chance(0.15)) return pick([null, 'round', 5, []])
  return {
    id: pick(['r-1', 'r-2', '', ' r-3 ']),
    hero_id: pick(KEYS),
    npc_id: pick([HONEST, CROOK, '', 'constructor']),
    npc_name: pick(['Бажен', '', undefined]),
    stake_cp: pick([10, 50, 200, 37, '50', null]),
    npc_total: pick([0, 1, 7, 20, 25, '12', undefined]),
    opened_at_minutes: pick([0, 30, -5, '40', undefined]),
  }
}
function junkTavern() {
  const patrons = {}
  for (let index = int(0, 16); index > 0; index -= 1) {
    const key = chance(0.7) ? `p-${index}` : pick(KEYS)
    setOwn(patrons, key, chance(0.1) ? pick([null, 3, 'x']) : { drinks: pick([0, 1, 3, 120, -1, '2']), scandals: pick([0, 1, 2, '1']), ejected: pick([true, false, 'yes', undefined]), round: chance(0.4) ? junkRound() : null })
  }
  const gamblers = {}
  for (let index = int(0, 28); index > 0; index -= 1) {
    const key = chance(0.75) ? `g-${index}` : pick(KEYS)
    setOwn(gamblers, key, chance(0.1) ? pick([null, 5]) : { purse_cp: pick([0, 10, 199, 400, 10_000, 20_000, -5, '300']), last_played_at_minutes: pick([0, 1, 5, 100, 100, 900, -1, '7']) })
  }
  const value = { schema_version: pick([3, 3, 2, undefined]), patrons: chance(0.9) ? patrons : pick(['x', [], null]), gamblers }
  if (chance(0.2)) value.round = junkRound()
  return value
}
function junkEvent() {
  const type = pick(['SceneAdvanced', 'TavernDiceRoundOpened', 'TavernDiceRoundResolved', 'TavernDiceRoundCancelled', 'TavernPatronEjected', 'TavernDrinkOrdered', 'Other'])
  const payload = {}
  if (type === 'TavernDiceRoundOpened') payload.round = junkRound()
  else {
    payload.hero_id = pick(KEYS)
    payload.npc_id = pick([HONEST, CROOK, 'constructor', '__proto__', ''])
    if (chance(0.6)) payload.npc_purse_after_cp = pick([0, 150, 9_999, 12_000, 'x'])
    if (chance(0.6)) payload.at_minutes = pick([0, 30, 1_000, -4])
    if (chance(0.5)) payload.outcome = pick(['win', 'loss', 'caught', 'exposed', 'draw'])
  }
  return { event_type: type, payload: chance(0.05) ? pick([null, 'x']) : payload }
}

for (let index = 0; index < 160; index += 1) {
  let input = chance(0.08) ? pick([undefined, null, 'tavern', 5, []]) : junkTavern()
  record('normalizeTavernState', [input])
  if (chance(0.5)) input = tavern.normalizeTavernState(viaJson(input))
  for (let step = 0; step < int(1, 6); step += 1) {
    const event = junkEvent()
    record('applyTavernEvent', [input, event])
    try {
      input = tavern.applyTavernEvent(viaJson(input), viaJson(event), {})
    } catch {
      break
    }
  }
  const state = { sessionCode: pick(['TAVERN', 'X', undefined]), scene: { title: pick([INN, 'Поле']), location: INN, location_id: 'inn' }, social: { npcs: [{ id: HONEST, name: 'Бажен', role: 'трактирщик', location: INN }, { id: 'constructor', name: 'Кон', location: INN }] }, tavern: input }
  if (chance(0.4)) battery(state, { cap: 2_000 })
}
for (let index = 0; index < 120; index += 1) {
  record('tavernPurseTransfer', [pick([0, 100, 9_900, 10_000, 12_000, -50, '300', undefined]), pick([0, 10, 200, -200, -20_000, 5_000, '50', undefined])])
}
for (const transfer of [undefined, null, {}, { moved_cp: 0, house_cut_cp: 0, before_cp: 1, after_cp: 1 }, { moved_cp: 200, house_cut_cp: 0, before_cp: 1, after_cp: 201 }, { moved_cp: 0, house_cut_cp: 50, before_cp: 10_000, after_cp: 10_000 }, { moved_cp: '0' }, tavern.tavernPurseTransfer(9_950, 200)]) {
  record('tavernPurseTransferPayload', [transfer])
}
for (let index = 0; index < 60; index += 1) {
  record('tavernOpponentDie', [pick([{ crooked: true, dice_bonus: 5 }, { crooked: false, dice_bonus: 5 }, { crooked: 1, dice_bonus: '3' }, null, undefined, { crooked: true, dice_bonus: -4 }]), pick([1, 7, 15, 19, 20, 25, 0, '12', undefined, 2.5])])
}
for (let index = 0; index < 40; index += 1) record('publicTavernRoundFor', [junkRound()])
for (let index = 0; index < 300; index += 1) record('tavernGamblerFor', [base, `patron-${index}`], { cap: Infinity })

// Ключ `__proto__` собственным полем, как его оставляет JSON.parse старого снимка.
phaseCap = Infinity
{
  const protoRound = { id: 'r-p', hero_id: '__proto__', npc_id: HONEST, npc_name: 'Бажен', stake_cp: 50, npc_total: 9 }
  const patrons = setOwn({ hero: { drinks: 1, scandals: 0, ejected: false, round: null } }, '__proto__', { drinks: 3, scandals: 1, ejected: true, round: protoRound })
  const gamblers = setOwn({ [HONEST]: { purse_cp: 120, last_played_at_minutes: 5 } }, '__proto__', { purse_cp: 77, last_played_at_minutes: 9 })
  const protoTavern = { schema_version: 3, patrons, gamblers }
  const state = { ...strip(base), tavern: protoTavern }
  for (const heroId of ['__proto__', 'constructor', 'hero', 'drinks', 'round', 'toString']) {
    for (const name of ['tavernRoundFor', 'tavernDrinksFor', 'tavernScandalsFor', 'tavernEjected', 'tavernNextDrinkDc', 'tavernTableMood']) record(name, [state, heroId])
    record('tavernForViewer', [state, { playerId: heroId }])
  }
  for (const npcId of ['__proto__', 'constructor', HONEST, CROOK, 'purse_cp', 'valueOf']) {
    for (const name of ['tavernGamblerPurseFor', 'tavernFreePurseFor', 'tavernMaxStakeFor', 'tavernOpenRoundsAgainst', 'tavernGamblerFor']) record(name, [state, npcId])
  }
  record('normalizeTavernState', [protoTavern])
  record('normalizeTavernState', [{ ...protoTavern, schema_version: 2 }])
  record('normalizeTavernState', [{ patrons: {}, round: protoRound }])
  record('normalizeTavernState', [{ patrons: setOwn({}, '__proto__', { drinks: 2 }), round: protoRound }])
  for (const input of [protoTavern, { ...protoTavern, schema_version: 1 }, tavern.normalizeTavernState(viaJson(protoTavern))]) {
    for (const event of [
      { event_type: 'TavernDrinkOrdered', payload: { hero_id: '__proto__' } },
      { event_type: 'TavernPatronEjected', payload: { hero_id: 'constructor' } },
      { event_type: 'TavernDiceRoundOpened', payload: { round: { ...protoRound, id: 'r-q' } } },
      { event_type: 'TavernDiceRoundResolved', payload: { hero_id: '__proto__', npc_id: '__proto__', npc_purse_after_cp: 300, at_minutes: 40, outcome: 'caught' } },
      { event_type: 'TavernDiceRoundCancelled', payload: { hero_id: 'hero', npc_id: 'constructor', npc_purse_after_cp: 30 } },
      { event_type: 'SceneAdvanced', payload: {} },
      { event_type: 'Other' },
    ]) record('applyTavernEvent', [input, event])
  }
}

console.log(`сценарии ${afterScenarios}, корпус ${afterCorpus - afterScenarios}, срезы ${writer.cases.length - afterCorpus}`)
writer.write(new URL('./tavern-life.json', import.meta.url))
