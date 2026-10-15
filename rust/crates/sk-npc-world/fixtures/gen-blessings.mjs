import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/blessings.mjs для Rust:
//
//   node rust/crates/sk-npc-world/fixtures/gen-blessings.mjs [каталог корпуса]
//
// Источники входов:
//
// - часовня из `test/blessings.test.mjs` через настоящий Rules Engine:
//   молитвы с разными костями, требы жрецу, отказы, сутки, отдых — каждый
//   верхний вызов модуля изнутри конвейера перехватывается хуком;
// - корпус паритета: состояния с NPC и повтор команд у святынь и жрецов;
// - реестры с мусором старых сохранений и ключами прототипа как id героя,
//   роли служителей и не-служителей, сиды знамений.
import { fixtureWriter, mulberry32, chooser, viaJson, setOwn } from './common.mjs'
import { corpusCommand, corpusDir, corpusRecords, corpusState, replayDice, ROLES } from './npc-scenes.mjs'

const blessings = await import('../../../../server/blessings.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const t = await import('../../../../server/tactical-map.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer } = await import('../../../../server/viewer-projection.mjs')

const writer = fixtureWriter('blessings', retentionMode)
const random = mulberry32(2026_10_17)
const { int, pick, chance } = chooser(random)
let phaseCap = 220

const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
}
const NPC_KEYS = ['id', 'name', 'role', 'tags', 'location', 'location_id', 'locationId', 'available', 'visibility']

/** Состояние урезается до полей, которые читает blessings (и npc-positioning под ним). */
function strip(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  if (state.scene !== undefined) {
    out.scene = pickKeys(state.scene, ['title', 'location', 'location_id', 'locationId', 'map'])
    if (out.scene && typeof out.scene === 'object' && out.scene.map && typeof out.scene.map === 'object') out.scene.map = pickKeys(out.scene.map, ['locationId'])
  }
  if (state.social !== undefined) {
    out.social = state.social && typeof state.social === 'object' && !Array.isArray(state.social)
      ? { npcs: Array.isArray(state.social.npcs) ? state.social.npcs.map((npc) => pickKeys(npc, NPC_KEYS)) : state.social.npcs }
      : state.social
  }
  if (state.npc_world !== undefined) out.npc_world = pickKeys(state.npc_world, ['vitals', 'stances'])
  if (state.blessings !== undefined) out.blessings = state.blessings
  if (state.mechanics && typeof state.mechanics === 'object') {
    out.mechanics = {}
    if (state.mechanics.conditions !== undefined) out.mechanics.conditions = state.mechanics.conditions
    if (state.mechanics.world_time !== undefined) out.mechanics.world_time = pickKeys(state.mechanics.world_time, ['elapsed_minutes'])
  }
  return out
}

const FNS = {
  normalizeBlessingState: { fn: (input) => blessings.normalizeBlessingState(input), states: [], refs: [0] },
  blessingRecordFor: { fn: (state, id) => blessings.blessingRecordFor(state, id), states: [0] },
  heroIsBlessed: { fn: (state, id) => blessings.heroIsBlessed(state, id), states: [0] },
  blessingAvailabilityFor: { fn: (...args) => blessings.blessingAvailabilityFor(...args), states: [0] },
  isPriestProfile: { fn: (npc) => blessings.isPriestProfile(npc), states: [] },
  blessingPriestsFor: { fn: (state) => blessings.blessingPriestsFor(state), states: [0] },
  isBlessingPriest: { fn: (state, id) => blessings.isBlessingPriest(state, id), states: [0] },
  blessingFactionIdsFor: { fn: (state, id) => blessings.blessingFactionIdsFor(state, id), states: [0] },
  blessingOmenFor: { fn: (seed) => blessings.blessingOmenFor(seed), states: [] },
  blessingsForViewer: { fn: (state, viewer) => blessings.blessingsForViewer(state, viewer), states: [0] },
  applyBlessingEvent: { fn: (input, event) => blessings.applyBlessingEvent(input, event, {}), states: [], refs: [0] },
}

function record(name, args, options = {}) {
  const spec = FNS[name]
  const prepared = args.map((arg, index) => (spec.states.includes(index) ? strip(arg) : arg))
  return writer.call(name, spec.fn, prepared, { stateArgs: [...spec.states, ...(spec.refs ?? [])], ...options, cap: Math.min(options.cap ?? Infinity, phaseCap) })
}

const captured = []
function capture(module, name, args) {
  if (module !== 'server/blessings.mjs' || !FNS[name] || captured.length > 6_000) return
  try {
    const spec = FNS[name]
    captured.push({ name, args: args.slice(0, name === 'applyBlessingEvent' ? 2 : args.length).map((arg, index) => viaJson(spec.states.includes(index) ? strip(arg) : arg)) })
  } catch { /* вход не сериализуется */ }
}
const flushCaptured = () => {
  for (const entry of captured.splice(0)) record(entry.name, entry.args)
}

const ODD = ['constructor', '__proto__', 'toString', 'at_minutes', 'source', 'granted', '', 'ghost']

function battery(state) {
  const heroes = [...new Set([...(Array.isArray(state?.players) ? state.players : []).map((player) => player?.id).filter(Boolean).slice(0, 3), ...Object.keys(state?.blessings?.heroes ?? {}).slice(0, 3), ...ODD.filter(() => chance(0.25))])]
  const npcs = [...new Set([...(Array.isArray(state?.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id).filter(Boolean).slice(0, 4), ...ODD.filter(() => chance(0.2))])]
  record('blessingPriestsFor', [state])
  record('normalizeBlessingState', [state?.blessings])
  for (const heroId of heroes) {
    record('blessingRecordFor', [state, heroId])
    record('heroIsBlessed', [state, heroId])
    record('blessingAvailabilityFor', [state, heroId, pick([0, 10, 1_440, 1_441, 3_000, -5, '20', undefined])])
    record('blessingsForViewer', [state, { playerId: heroId }])
  }
  record('blessingsForViewer', [state, pick([{}, undefined, null])])
  for (const npcId of npcs) {
    record('isBlessingPriest', [state, npcId])
    record('blessingFactionIdsFor', [state, npcId])
  }
}

// ---------------------------------------------------------------------------
// 1. Часовня через Rules Engine
// ---------------------------------------------------------------------------

const CAMPAIGN = 'SHRINE-1'
const CHAPEL = 'Придорожная часовня'
const PRIEST = 'father'
const SMITH = 'smith'

function chapel({ assetId = 'altar', minutes = 0, currency = { copper: 0, silver: 0, gold: 2, platinum: 0 }, blessingsState, conditions = {}, priestFactions = ['faction:temple-dawn'], sessionCode = CAMPAIGN, extraNpcs = [] } = {}) {
  const map = t.createTacticalMap({ width: 5, height: 3, locationId: 'chapel', seed: 'chapel-seed', fill: { passable: true, revealed: true, material: 'stone' } })
  t.addProp(map, { id: `prop-${assetId}`, assetId, x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }], interactive: true })
  return rules.normalizeCampaignState({
    sessionCode, campaign: 'Молитвы и благословения', activePlayerId: 'hero', partyMemberIds: ['hero'], partyName: 'Отряд героев',
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12, proficiency: 2, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, classSkillProficiencies: [], savingThrowProficiencies: [], backgroundSkillProficiencies: [], currency, inventory: [], x: 0, y: 0 }],
    enemies: [],
    scene: { title: CHAPEL, location: CHAPEL, location_id: 'chapel', map: t.serializeTacticalMap(map), turn: 1 },
    social: { npcs: [
      { id: PRIEST, name: 'Отец Никодим', role: 'жрец Утренней зари', location: CHAPEL, visibility: 'party', tags: priestFactions, public_summary: 'Служитель часовни.' },
      { id: SMITH, name: 'Кузнец Горазд', role: 'кузнец', location: CHAPEL, visibility: 'party', public_summary: 'Зашёл поставить свечу.' },
      ...extraNpcs,
    ] },
    ...(blessingsState ? { blessings: blessingsState } : {}),
    mechanics: { positions: { hero: { x: 0, y: 0 } }, conditions, world_time: { elapsed_minutes: minutes } },
  })
}
const dice = (values = []) => {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `blessing-roll-${++id}`, now: () => '2026-08-15T09:00:00.000Z' })
}
function run(state, commands, diceValues = []) {
  return rules.resolveCommands(commands.map((command, index) => ({ campaign_id: state.sessionCode, command_id: `cmd-${int(1, 1e6)}-${index + 1}`, ...command })), state, { diceService: dice(diceValues), context: { allowedActorIds: ['hero'] } })
}
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const pray = (propId = 'prop-altar') => ({ command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: propId, intent: 'pray' })
const ask = (npcId = PRIEST) => ({ command_type: 'ReceiveNpcBlessing', actor_id: 'hero', npc_id: npcId })
const label = (name, state) => {
  writer.stateRef(strip(viaJson(state)), name)
  return state
}

const stop = startCapture(capture)
const base = label('chapel', chapel())
label('chapel-no-factions', chapel({ priestFactions: [] }))
label('day-closed', chapel({ minutes: 10, blessingsState: { heroes: { hero: { at_minutes: 0, source: 'shrine', granted: false, place_name: CHAPEL } } } }))
label('still-blessed', chapel({ minutes: 1_441, conditions: { hero: [{ id: 'minor-blessing', duration: 'until-long-rest' }] }, blessingsState: { heroes: { hero: { at_minutes: 0, source: 'shrine', granted: true, place_name: CHAPEL } } } }))
for (const [value, name] of [[15, 'prayed-blessed'], [5, 'prayed-silence'], [1, 'prayed-omen']]) {
  const result = attempt(() => run(base, [pray()], [value]))
  if (result) label(name, rules.replayEvents(base, result.events))
}
const asked = attempt(() => run(base, [ask()]))
if (asked) {
  const after = label('asked-priest', rules.replayEvents(base, asked.events))
  attempt(() => campaignStateForViewer(after, { role: 'player' }, 'hero'))
  attempt(() => run(after, [pray()], [20]))
}
for (const npcId of [SMITH, 'ghost', PRIEST]) attempt(() => run(chapel({ minutes: int(0, 5_000) }), [ask(npcId)]))
for (let session = 0; session < 50; session += 1) {
  let state = chapel({ sessionCode: `SHRINE-${session}`, minutes: int(0, 4_000), currency: { copper: 0, silver: 0, gold: int(0, 3), platinum: 0 },
    extraNpcs: chance(0.6) ? [{ id: `npc-${session}`, name: 'Странник', role: pick(ROLES), location: CHAPEL, visibility: pick(['party', 'gm_only']), tags: chance(0.5) ? [`faction:${pick(['dawn', 'dusk'])}`] : [] }] : [] })
  for (let step = 0; step < int(2, 6); step += 1) {
    const command = chance(0.5) ? pray(pick(['prop-altar', 'prop-chest'])) : ask(pick([PRIEST, SMITH, `npc-${session}`]))
    const result = attempt(() => run(state, [command], [int(1, 20), int(1, 20)]))
    if (result) state = rules.replayEvents(state, result.events)
    if (chance(0.3)) state = rules.normalizeCampaignState({ ...state, mechanics: { ...state.mechanics, world_time: { elapsed_minutes: Number(state.mechanics?.world_time?.elapsed_minutes ?? 0) + int(100, 2_000) } } })
    if (chance(0.3)) attempt(() => campaignStateForViewer(state, { role: 'player' }, 'hero'))
  }
  if (chance(0.5)) battery(state)
}
stop()
flushCaptured()
const afterScenarios = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Корпус
// ---------------------------------------------------------------------------

phaseCap = 360
const dir = corpusDir(process.argv[2])
if (dir) {
  const seen = new Set()
  let states = 0
  let replayed = 0
  const stopCorpus = startCapture(capture)
  for (const entry of corpusRecords(dir)) {
    if (seen.has(entry.state)) continue
    seen.add(entry.state)
    const type = String(entry.command?.command_type ?? '')
    const relevant = type === 'ReceiveNpcBlessing' || (type === 'OperateSceneObject')
    const state = corpusState(dir, entry.state)
    if (!state) continue
    const interesting = relevant || (Array.isArray(state.social?.npcs) && state.social.npcs.length) || state.blessings
    if (!interesting) continue
    if (states < 50 && chance(0.5)) {
      states += 1
      stopCorpus()
      battery(state)
      startCapture(capture)
    }
    if (replayed < 300 && (relevant || chance(0.05))) {
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
  console.log(`корпус: состояний ${states}, повторено ${replayed}, перехвачено ${captured.length}`)
  flushCaptured()
} else {
  console.log('корпус не найден — пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Реестры с мусором, роли, знамения
// ---------------------------------------------------------------------------

phaseCap = Infinity
const KEYS = ['hero', 'hero-2', ' hero ', '7', '3', ...ODD]
function junkRecord() {
  if (chance(0.12)) return pick([null, 'нет', 5, []])
  return { at_minutes: pick([0, 10, 120, 1_440, -5, '30', undefined]), source: pick(['shrine', 'priest', 'дракон', ' priest ', undefined]), granted: pick([true, false, 'да', 1]), place_name: pick([CHAPEL, '', undefined]), npc_id: pick([PRIEST, '', undefined]), npc_name: pick(['Отец', undefined]) }
}
for (let index = 0; index < 120; index += 1) {
  const heroes = {}
  for (let count = int(0, 15); count > 0; count -= 1) setOwn(heroes, chance(0.6) ? `h-${count}` : pick(KEYS), junkRecord())
  let input = chance(0.08) ? pick([undefined, null, 'x', 5, []]) : { schema_version: pick([1, 1, 2, undefined]), heroes: chance(0.9) ? heroes : pick(['x', [], null]) }
  record('normalizeBlessingState', [input])
  for (let step = 0; step < int(1, 4); step += 1) {
    const event = { event_type: pick(['ShrinePrayerResolved', 'NpcBlessingGranted', 'Other']), ...(chance(0.5) ? { actor_id: pick(KEYS) } : {}), payload: chance(0.05) ? pick([null, 'x']) : { ...(chance(0.8) ? { hero_id: pick(KEYS) } : {}), at_minutes: pick([0, 30, 2_000, -4, '9']), outcome: pick(['blessed', 'silence', 'omen', undefined]), place_name: CHAPEL, npc_id: pick([PRIEST, undefined]), npc_name: 'Отец' } }
    record('applyBlessingEvent', [input, event])
    try {
      input = blessings.applyBlessingEvent(viaJson(input), viaJson(event), {})
    } catch {
      break
    }
  }
  const state = { scene: { title: CHAPEL, location: CHAPEL, location_id: 'chapel' }, social: { npcs: [{ id: PRIEST, name: 'Отец', role: 'жрец', location: CHAPEL, tags: ['faction:dawn'] }] }, blessings: input,
    mechanics: { world_time: { elapsed_minutes: pick([0, 100, 2_000]) }, conditions: setOwn({ hero: pick([[{ id: 'minor-blessing' }], ['minor-blessing'], [null], 'minor-blessing', []]) }, pick(['__proto__', 'constructor']), ['minor-blessing']) } }
  if (chance(0.5)) battery(state)
}
// Запись-прототип: поля находятся по своим именам.
{
  const heroes = setOwn({ hero: { at_minutes: 5, source: 'priest', granted: true } }, '__proto__', { at_minutes: 30, source: 'shrine', granted: false, place_name: '', npc_id: 'x', npc_name: 'Икс' })
  const state = { scene: { title: CHAPEL, location: CHAPEL }, blessings: { heroes }, mechanics: { world_time: { elapsed_minutes: 100 } } }
  for (const heroId of ['__proto__', 'constructor', 'hero', 'at_minutes', 'source', 'granted', 'place_name', 'npc_id', 'npc_name', 'valueOf', 'other']) {
    record('blessingRecordFor', [state, heroId])
    record('blessingAvailabilityFor', [state, heroId, 100])
    record('blessingsForViewer', [state, { playerId: heroId }])
  }
  record('normalizeBlessingState', [{ heroes }])
  record('applyBlessingEvent', [{ heroes }, { event_type: 'NpcBlessingGranted', payload: { hero_id: '__proto__', at_minutes: 9 } }])
  record('applyBlessingEvent', [{ schema_version: 1, heroes }, { event_type: 'ShrinePrayerResolved', payload: { hero_id: '__proto__', outcome: 'blessed' } }])
}
for (const role of ['жрец Утренней зари', 'настоятельница обители', 'монах', 'кузнец', 'мономах', 'жрица', 'иеромонах', 'монашка', 'монахиня', 'священник', 'священница', 'священнослужитель',
  'хранитель святилища', 'хранительница святилища', 'служитель храма', 'служительница богов', 'послушник', 'клирик', 'проповедник', 'priest', 'acolyte', 'monk', 'освященный страж', 'посвященный',
  'священный воин', 'служитель закона', 'поединок', 'монтажник', 'инок', 'инокиня', 'Аббат', 'MONK', 'monkey', 'Priestess', 'иерей', 'жречество', ...ROLES]) {
  record('isPriestProfile', [{ role }])
}
for (const npc of [undefined, null, {}, { role: 5 }, { role: ['жрец'] }, { role: 'кузнец', tags: ['faction:priesthood-of-dawn'] }, { role: 'нищий', tags: ['свяще'] }]) record('isPriestProfile', [npc])
for (let index = 0; index < 60; index += 1) record('blessingOmenFor', [pick([`seed-${index}`, `hero:${index}:shrine`, index, undefined, null, ' x '])])

console.log(`сценарии ${afterScenarios}, корпус ${afterCorpus - afterScenarios}, срезы ${writer.cases.length - afterCorpus}`)
writer.write(new URL('./blessings.json', import.meta.url))
