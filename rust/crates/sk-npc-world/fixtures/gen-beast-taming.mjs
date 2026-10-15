import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/beast-taming.mjs для Rust:
//
//   node rust/crates/sk-npc-world/fixtures/gen-beast-taming.mjs [каталог корпуса]
//
// Источники входов:
//
// - прогалина из `test/beast-taming.test.mjs` через настоящий Rules Engine:
//   уговор, укус, кормление, приручение, привал, отпугивание, смена сцены —
//   и случайные цепочки команд; каждый верхний вызов модуля изнутри
//   конвейера перехватывается хуком (резолвер каталога пишется таблицей);
// - корпус паритета: состояния со зверями и повтор команд приручения;
// - реестры и звери с мусором: ключи прототипа как стат-блок и id, сорок
//   первая запись, строки вместо чисел в счётчиках сырого среза.
import { fixtureWriter, mulberry32, chooser, viaJson, setOwn } from './common.mjs'
import { corpusCommand, corpusDir, corpusRecords, corpusState, replayDice } from './npc-scenes.mjs'

const beasts = await import('../../../../server/beast-taming.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer } = await import('../../../../server/viewer-projection.mjs')

const writer = fixtureWriter('beast-taming', retentionMode)
const random = mulberry32(2026_10_18)
const { int, pick, chance } = chooser(random)
let phaseCap = 120

const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
}
const ENEMY_KEYS = ['id', 'name', 'hp', 'hitPoints', 'maxHp', 'max_hp', 'alive', 'creature_type', 'creatureType', 'monster_type', 'kind', 'stat_block_id', 'statBlockId', 'provenance', 'challenge_rating', 'x', 'y', 'footprint']
const stripEnemy = (enemy) => {
  const out = pickKeys(enemy, ENEMY_KEYS)
  if (out && typeof out === 'object' && out.provenance && typeof out.provenance === 'object') out.provenance = pickKeys(out.provenance, ['challenge_rating'])
  return out
}

/** Состояние урезается до полей, которые читает beast-taming. */
function strip(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  if (state.sessionCode !== undefined) out.sessionCode = state.sessionCode
  if (state.scene !== undefined) {
    out.scene = pickKeys(state.scene, ['title', 'location', 'location_id', 'locationId', 'map'])
    if (out.scene && typeof out.scene === 'object' && out.scene.map && typeof out.scene.map === 'object') out.scene.map = pickKeys(out.scene.map, ['locationId'])
  }
  if (state.players !== undefined) out.players = Array.isArray(state.players) ? state.players.map((player) => pickKeys(player, ['id', 'x', 'y', 'footprint'])) : state.players
  if (state.enemies !== undefined) out.enemies = Array.isArray(state.enemies) ? state.enemies.map(stripEnemy) : state.enemies
  if (state.mechanics && typeof state.mechanics === 'object') {
    out.mechanics = {}
    for (const key of ['positions', 'conditions', 'resting']) if (state.mechanics[key] !== undefined) out.mechanics[key] = state.mechanics[key]
    if (state.mechanics.combat !== undefined) out.mechanics.combat = state.mechanics.combat && typeof state.mechanics.combat === 'object' ? pickKeys(state.mechanics.combat, ['active']) : state.mechanics.combat
    if (state.mechanics.world_time !== undefined) out.mechanics.world_time = pickKeys(state.mechanics.world_time, ['elapsed_minutes', 'amount', 'unit'])
  }
  if (state.beasts !== undefined) out.beasts = state.beasts
  return out
}

const resolverFrom = (table) => (catalogId) => (table && Object.hasOwn(table, catalogId) ? table[catalogId] : null)
const stripEntry = (entry) => (entry && typeof entry === 'object'
  ? Object.fromEntries(['use', 'rarity', 'requires_attunement', 'attunement'].filter((key) => Object.hasOwn(entry, key)).map((key) => [key, key === 'use' ? pickKeys(entry.use, ['kind']) : key === 'attunement' ? pickKeys(entry.attunement, ['required']) : entry[key]]))
  : entry)

const FNS = {
  beastDietFor: { fn: (enemy) => beasts.beastDietFor(enemy), states: [], enemies: [0] },
  isTameableBeast: { fn: (enemy) => beasts.isTameableBeast(enemy), states: [], enemies: [0] },
  beastChallengeRating: { fn: (enemy) => beasts.beastChallengeRating(enemy), states: [], enemies: [0] },
  beastChallengeDcShift: { fn: (cr) => beasts.beastChallengeDcShift(cr), states: [] },
  beastIsWounded: { fn: (enemy) => beasts.beastIsWounded(enemy), states: [], enemies: [0] },
  beastMoraleBroken: { fn: (...args) => beasts.beastMoraleBroken(...args), states: [0] },
  normalizeBeastState: { fn: (input) => beasts.normalizeBeastState(input), states: [], refs: [0] },
  beastList: { fn: (state) => beasts.beastList(state), states: [0] },
  beastFor: { fn: (state, id) => beasts.beastFor(state, id), states: [0] },
  beastCompanions: { fn: (state) => beasts.beastCompanions(state), states: [0] },
  beastIdFor: { fn: (state, id) => beasts.beastIdFor(state, id), states: [0] },
  beastDistanceFeet: { fn: (...args) => beasts.beastDistanceFeet(...args), states: [0] },
  beastReachFor: { fn: (...args) => beasts.beastReachFor(...args), states: [0] },
  beastOutOfReach: { fn: (...args) => beasts.beastOutOfReach(...args), states: [0] },
  beastReachByHero: { fn: (...args) => beasts.beastReachByHero(...args), states: [0] },
  beastApproachBlockedReason: { fn: (...args) => beasts.beastApproachBlockedReason(...args), states: [0], enemies: [1] },
  tameableBeasts: { fn: (state) => beasts.tameableBeasts(state), states: [0] },
  beastDraftFor: { fn: (...args) => beasts.beastDraftFor(...args), states: [0], enemies: [1] },
  beastTamingPolicy: { fn: (...args) => beasts.beastTamingPolicy(...args), states: [0], enemies: [1] },
  beastBiteDamage: { fn: (cr) => beasts.beastBiteDamage(cr), states: [] },
  // Резолвер каталога — таблицей `{ catalogId: entry }` вторым аргументом.
  beastFoodItemFor: { fn: (actor, table) => beasts.beastFoodItemFor(actor, table === undefined ? null : resolverFrom(table)), states: [] },
  partyIsResting: { fn: (state) => beasts.partyIsResting(state), states: [0] },
  beastWatchCompanion: { fn: (state) => beasts.beastWatchCompanion(state), states: [0] },
  beastWatchSwing: { fn: (...args) => beasts.beastWatchSwing(...args), states: [0] },
  beastScareLine: { fn: (...args) => beasts.beastScareLine(...args), states: [] },
  beastScareCooldownLeft: { fn: (...args) => beasts.beastScareCooldownLeft(...args), states: [] },
  planBeastFollowDrafts: { fn: (state) => beasts.planBeastFollowDrafts(state), states: [0] },
  beastDietLabel: { fn: (diet) => beasts.beastDietLabel(diet), states: [] },
  beastStageLabel: { fn: (stage) => beasts.beastStageLabel(stage), states: [] },
  beastForViewer: { fn: (beast) => beasts.beastForViewer(beast), states: [] },
  beastsForViewer: { fn: (state, viewer) => beasts.beastsForViewer(state, viewer), states: [0] },
  beastChronicleEntry: { fn: (event) => beasts.beastChronicleEntry(event), states: [] },
  applyBeastEvent: { fn: (input, event, state) => beasts.applyBeastEvent(input, event, state), states: [2], refs: [0] },
}

function record(name, args, options = {}) {
  const spec = FNS[name]
  const prepared = args.map((arg, index) => (spec.states.includes(index) ? strip(arg) : (spec.enemies ?? []).includes(index) ? stripEnemy(arg) : arg))
  return writer.call(name, spec.fn, prepared, { stateArgs: [...spec.states, ...(spec.refs ?? [])], ...options, cap: Math.min(options.cap ?? Infinity, phaseCap) })
}

const captured = []
function capture(module, name, args) {
  if (module !== 'server/beast-taming.mjs' || !FNS[name] || captured.length > 8_000) return
  try {
    const spec = FNS[name]
    let plain = args
    if (name === 'beastFoodItemFor') {
      const [actor, resolve] = args
      const table = {}
      if (typeof resolve === 'function') {
        for (const item of Array.isArray(actor?.inventory) ? actor.inventory : []) {
          const id = String(item?.catalog_id ?? item?.catalogId ?? '').trim()
          if (id && !Object.hasOwn(table, id)) setOwn(table, id, stripEntry(resolve(id)))
        }
      }
      plain = [pickKeys(actor, ['inventory']), typeof resolve === 'function' ? table : undefined]
    }
    if (name === 'applyBeastEvent' && args.length < 3) plain = [...args, undefined]
    captured.push({ name, args: plain.map((arg, index) => viaJson(spec.states.includes(index) ? strip(arg) : (name === 'beastsForViewer' && index === 1 ? pickKeys(arg, ['isAdmin']) : arg))) })
  } catch { /* вход не сериализуется */ }
}
const flushCaptured = () => {
  for (const entry of captured.splice(0)) record(entry.name, entry.args)
}

const ODD = ['constructor', '__proto__', 'toString', '', 'ghost']

function battery(state) {
  const enemies = Array.isArray(state?.enemies) ? state.enemies.slice(0, 4) : []
  const heroes = [...(Array.isArray(state?.players) ? state.players : []).map((player) => player?.id).filter(Boolean).slice(0, 3), ...ODD.filter(() => chance(0.2))]
  for (const name of ['beastList', 'beastCompanions', 'tameableBeasts', 'partyIsResting', 'beastWatchCompanion', 'planBeastFollowDrafts']) record(name, [state])
  record('beastsForViewer', [state, pick([{}, { isAdmin: true }, undefined])])
  record('normalizeBeastState', [state?.beasts])
  for (const enemy of enemies) {
    for (const name of ['beastDietFor', 'isTameableBeast', 'beastChallengeRating', 'beastIsWounded']) record(name, [stripEnemy(enemy)])
    record('beastMoraleBroken', [state, enemy?.id])
    record('beastApproachBlockedReason', [state, stripEnemy(enemy)])
    record('beastDraftFor', [state, stripEnemy(enemy)])
    record('beastIdFor', [state, enemy?.id])
    const registered = beasts.beastList(viaJson(strip(state))).find((beast) => beast.actor_id === String(enemy?.id))
    record('beastTamingPolicy', [state, stripEnemy(enemy), registered ?? pick([null, undefined, { stage: 'fed', attempts: 2 }, { stage: 'wary', attempts: '9', diet: 'herbivore' }])])
    record('beastReachByHero', [state, enemy?.id])
    for (const heroId of heroes) {
      record('beastReachFor', [state, heroId, enemy?.id])
      record('beastDistanceFeet', [state, heroId, enemy?.id])
    }
  }
  for (const beast of beasts.beastList(viaJson(strip(state))).slice(0, 3)) {
    record('beastFor', [state, beast.id])
    record('beastForViewer', [beast])
    record('beastScareCooldownLeft', [beast, pick([0, 30, 59, 60, 61, 300, '45', undefined])])
    record('beastScareLine', [beast, pick([0, 59, 60, 125, 3_600, -5, undefined])])
  }
  for (const heroId of heroes) record('beastWatchSwing', [state, pick(['perception', ' Perception ', 'PERCEPTION', 'perception_', 'stealth', undefined]), heroId])
}

// ---------------------------------------------------------------------------
// 1. Прогалина через Rules Engine
// ---------------------------------------------------------------------------

const GLADE = 'Волчья прогалина'
const cells = (width = 6, height = 6) => {
  const grid = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  return grid
}
const ration = (quantity = 2) => ({ id: 'item-rations', catalog_id: 'srd_5_2_1:rations-one-day', name: 'Сухой паёк, 1 день', type: 'consumable', quantity, weight: 2 })
const wolf = (id = 'enemy-wolf', overrides = {}) => ({ id, name: 'Волк 1', hp: 11, maxHp: 11, armor: 12, creature_type: 'beast', stat_block_id: 'srd_5_2_1:wolf', provenance: { challenge_rating: '1/4', xp: 50 }, x: 2, y: 1, alive: true, ...overrides })
const boar = (id = 'enemy-boar', overrides = {}) => ({ id, name: 'Гигантский кабан 1', hp: 42, maxHp: 42, armor: 13, creature_type: 'beast', stat_block_id: 'srd_5_2_1:giant-boar', provenance: { challenge_rating: '2', xp: 450 }, x: 2, y: 2, alive: true, ...overrides })
const hero = (id = 'hero', overrides = {}) => ({ id, character: 'Ловчий Влад', hp: 14, maxHp: 14, x: 1, y: 1, abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 16, cha: 10 }, proficiency: 2, backgroundSkillProficiencies: ['animal_handling'], inventory: [ration()], ...overrides })

function campaign({ minutes = 0, enemies = [wolf()], conditions = {}, combatActive = false, inventory = [ration()], beastsState, resting = {}, scene = {}, heroes = [], sessionCode = 'BEAST' } = {}) {
  return rules.normalizeCampaignState({
    sessionCode, campaign: 'Волк у костра', activePlayerId: 'hero', partyMemberIds: ['hero', ...heroes.map((entry) => String(entry.id))], partyName: 'Отряд героев',
    scene: { title: 'Прогалина', location: GLADE, location_id: 'glade', grid: { width: 6, height: 6 }, cells: cells(), ...scene },
    players: [hero('hero', { inventory }), ...heroes],
    worldMap: { seed: 'beast-seed', locations: [{ id: 'glade', name: GLADE, kind: 'wilderness', x: 100, y: 100 }, { id: 'village', name: 'Тихий Брод', kind: 'village', x: 130, y: 100 }], routes: [] },
    enemies,
    ...(beastsState ? { beasts: beastsState } : {}),
    mechanics: { world_time: { elapsed_minutes: minutes }, combat: combatActive ? { active: true, round: 2, initiative: [{ actor_id: 'hero', total: 15 }], active_index: 0, action_economy: {} } : { active: false }, conditions, resting },
  })
}
let rollId = 0
function run(state, command, rng = []) {
  return rules.resolveCommands([{ command_id: `cmd-beast-${int(1, 1e6)}`, campaign_id: state.sessionCode, actor_id: 'hero', ...command }], state, { diceService: new DiceService({ rng: new SequenceDiceRng(rng), idFactory: () => `beast-roll-${++rollId}`, now: () => '2026-08-20T10:00:00.000Z' }), context: { allowedActorIds: ['hero'] } })
}
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const label = (name, state) => {
  writer.stateRef(strip(viaJson(state)), name)
  return state
}

const stop = startCapture(capture)
const base = label('glade', campaign())
label('glade-two', campaign({ enemies: [wolf(), boar()] }))
label('glade-fled', campaign({ conditions: { 'enemy-wolf': [{ id: 'fled' }] } }))
label('fighting', campaign({ combatActive: true }))
label('fighting-broken', campaign({ combatActive: true, conditions: { 'enemy-wolf': [{ id: 'fled' }] } }))
label('dead-wolf', campaign({ enemies: [wolf('enemy-wolf', { hp: 0, alive: false })] }))
const idOf = (state, actorId = 'enemy-wolf') => beasts.beastIdFor(state, actorId)
const calmed = attempt(() => run(base, { command_type: 'CalmBeast', beast_id: idOf(base) }, [18]).state)
if (calmed) {
  label('calmed', calmed)
  const fed = attempt(() => run(calmed, { command_type: 'FeedBeast', beast_id: idOf(calmed) }).state)
  if (fed) {
    label('fed', fed)
    const tamed = attempt(() => run(fed, { command_type: 'CalmBeast', beast_id: idOf(fed) }, [12]).state)
    if (tamed) {
      label('tamed', tamed)
      const camped = rules.normalizeCampaignState({ ...tamed, mechanics: { ...tamed.mechanics, resting: { hero: { kind: 'long', started_at_minutes: 0 } } } })
      label('tamed-camped', camped)
      attempt(() => run(camped, { command_type: 'MakeAbilityCheck', skill: 'perception', difficulty: 12 }, [8, 15]))
      attempt(() => run(tamed, { command_type: 'ScareWithBeast', beast_id: idOf(tamed) }))
      const scared = attempt(() => run(tamed, { command_type: 'ScareWithBeast', beast_id: idOf(tamed) }).state)
      if (scared) label('scared', scared)
      const moved = attempt(() => rules.replayEvents(tamed, [{ event_id: 'evt-scene', command_id: 'cmd-scene', event_type: 'SceneAdvanced', actor_id: null, target_ids: [], visibility: 'party', payload: { scene: { title: 'Тихий Брод', location: 'Тихий Брод', location_id: 'village' } }, state_version_after: tamed.state_version + 1 }]))
      if (moved) label('tamed-moved', moved)
      attempt(() => campaignStateForViewer(tamed, { role: 'player' }, 'hero'))
    }
  }
}
const bitten = attempt(() => run(base, { command_type: 'CalmBeast', beast_id: idOf(base) }, [1, 3]).state)
if (bitten) label('bitten', bitten)
attempt(() => run(campaign({ enemies: [boar()] }), { command_type: 'CalmBeast', beast_id: idOf(base, 'enemy-boar') }, [1]))
attempt(() => run(campaign({ combatActive: true }), { command_type: 'CalmBeast', beast_id: idOf(base) }, [18]))
label('far-wolf', campaign({ enemies: [wolf('enemy-wolf', { x: 5, y: 5 })] }))
attempt(() => run(campaign({ enemies: [wolf('enemy-wolf', { x: 5, y: 5 })] }), { command_type: 'CalmBeast', beast_id: idOf(base) }, [18]))
for (let session = 0; session < 50; session += 1) {
  const extra = chance(0.5) ? [hero('hero-2', { x: int(0, 5), y: int(0, 5) })] : []
  let state = campaign({ sessionCode: `BEAST-${session}`, minutes: int(0, 3_000), heroes: extra, combatActive: chance(0.2),
    enemies: [wolf('enemy-wolf', { x: int(0, 5), y: int(0, 5), hp: pick([11, 4, 0]) }), ...(chance(0.5) ? [boar('enemy-boar', { x: int(0, 5), y: int(0, 5) })] : []), ...(chance(0.2) ? [{ id: 'enemy-spider', name: 'Паук', hp: 5, creature_type: 'beast', stat_block_id: 'srd_5_2_1:giant-spider', x: 3, y: 3 }] : [])],
    inventory: pick([[ration()], [ration(0)], [], [{ id: 'jerky', name: 'Копчёное мясо', quantity: 1 }], [{ id: 'heart', name: 'Вяленое сердце', quantity: 1, rarity: 'редкий' }, ration(1)]]),
    resting: chance(0.3) ? { hero: { kind: 'short' } } : {} })
  for (let step = 0; step < int(2, 7); step += 1) {
    const target = pick(['enemy-wolf', 'enemy-boar'])
    const command = pick([{ command_type: 'CalmBeast', beast_id: idOf(state, target) }, { command_type: 'FeedBeast', beast_id: idOf(state, target) }, { command_type: 'ScareWithBeast', beast_id: idOf(state, target) }])
    const result = attempt(() => run(state, command, [int(1, 20), int(1, 20), int(1, 4)]))
    if (result) state = result.state
    if (chance(0.25)) attempt(() => campaignStateForViewer(state, { role: 'player' }, 'hero'))
  }
  if (chance(0.6)) battery(state)
}
stop()
flushCaptured()
const afterScenarios = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Корпус
// ---------------------------------------------------------------------------

phaseCap = 200
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
    const relevant = ['CalmBeast', 'FeedBeast', 'ScareWithBeast'].includes(type)
    const state = corpusState(dir, entry.state)
    if (!state) continue
    const interesting = relevant || state.beasts?.beasts?.length || (Array.isArray(state.enemies) && state.enemies.some((enemy) => beasts.isTameableBeast(enemy)))
    if (!interesting) continue
    if (states < 60) {
      states += 1
      stopCorpus()
      battery(state)
      startCapture(capture)
    }
    if (relevant && replayed < 300) {
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
// 3. Мусор, ключи прототипа, переполнение реестра
// ---------------------------------------------------------------------------

phaseCap = 300
const STAT_BLOCKS = ['srd_5_2_1:wolf', 'srd_5_2_1:dire-wolf', 'srd_5_2_1:lion', 'srd_5_2_1:tiger', 'srd_5_2_1:brown-bear', 'srd_5_2_1:giant-rat', 'srd_5_2_1:giant-boar', 'srd_5_2_1:ankylosaurus', 'srd_5_2_1:hippopotamus', 'srd_5_2_1:giant-spider', 'constructor', '__proto__', 'toString', '', ' srd_5_2_1:wolf ']
function junkEnemy(index) {
  return {
    id: chance(0.9) ? `foe-${index}` : pick(['constructor', '__proto__', 5, '']),
    name: pick(['Волк', 'Кабан', '', undefined]),
    hp: pick([0, 1, 4, 11, 42, '7', null, undefined]),
    ...(chance(0.3) ? { hitPoints: pick([3, '9']) } : {}),
    ...(chance(0.6) ? { maxHp: pick([11, 42, 0, '20']) } : {}),
    ...(chance(0.1) ? { max_hp: 8 } : {}),
    ...(chance(0.15) ? { alive: false } : {}),
    [pick(['creature_type', 'creatureType', 'monster_type', 'kind'])]: pick(['beast', 'Beast', ' BEAST ', 'humanoid', 'зверь']),
    [pick(['stat_block_id', 'statBlockId'])]: pick(STAT_BLOCKS),
    ...(chance(0.8) ? { provenance: { challenge_rating: pick(['1/4', '1/8', '1/2', '1', '2', '3', '4', '1/0', '0', '-1', 'abc', ' 1 / 4 ', '1e1', '']) } } : { challenge_rating: pick(['1/4', 2, null]) }),
    x: int(0, 6),
    y: int(0, 6),
  }
}
function junkBeast(index) {
  if (chance(0.06)) return pick(['beast', 5, []])
  return {
    id: chance(0.85) ? `beast:${index}` : pick(['', '-bad', 'с кириллицей', 'x'.repeat(130), 'ok.id:1']),
    actor_id: chance(0.9) ? `foe-${index % 6}` : '',
    name: pick(['Волк', 'Кабан', undefined]),
    diet: pick(['predator', 'herbivore', 'other', undefined]),
    stage: pick(['wary', 'calmed', 'fed', 'tamed', 'weird', undefined]),
    status: pick(['wild', 'companion', 'other', undefined]),
    attempts: pick([0, 1, 5, '3', -2, undefined]),
    bites: pick([0, 2, '1', undefined]),
    location_id: pick(['glade', 'village', undefined]),
    location_name: pick([GLADE, 'Тихий Брод', undefined]),
    calmed_at_minutes: pick([null, 30, '40', undefined]),
    scared_at_minutes: pick([null, 0, 100, undefined]),
  }
}
for (let index = 0; index < 80; index += 1) {
  const list = Array.from({ length: chance(0.08) ? int(38, 46) : int(0, 6) }, (_, beastIndex) => junkBeast(beastIndex))
  let input = chance(0.07) ? pick([undefined, null, 'x', []]) : { schema_version: pick([1, 1, 2, undefined]), beasts: list }
  record('normalizeBeastState', [input])
  const state = {
    sessionCode: pick(['BEAST', 'X']), scene: { title: pick(['Прогалина', '']), location: pick([GLADE, 'Тихий Брод']), location_id: pick(['glade', 'village']) },
    players: [{ id: 'hero', x: int(0, 5), y: int(0, 5) }, ...(chance(0.4) ? [{ id: pick(['hero-2', '__proto__', 'constructor']), x: int(0, 5), y: int(0, 5), ...(chance(0.3) ? { footprint: { version: 1, size: 2 } } : {}) }] : [])],
    enemies: Array.from({ length: int(0, 4) }, (_, enemyIndex) => junkEnemy(enemyIndex)),
    mechanics: {
      ...(chance(0.6) ? { positions: setOwn({ hero: { x: int(0, 5), y: int(0, 5) } }, pick(['foe-0', 'constructor', '__proto__']), { x: 1, y: 1 }) } : {}),
      conditions: setOwn({ 'foe-0': pick([[{ id: 'fled' }], ['surrendered'], [null], []]) }, pick(['foe-1', '__proto__']), [{ id: 'fled' }]),
      ...(chance(0.4) ? { combat: { active: chance(0.6) } } : {}),
      world_time: pick([{ elapsed_minutes: int(0, 3_000) }, { amount: pick([2, 1.5, 'Infinity']), unit: pick(['hours', 'дня', 'minutes']) }, {}]),
      resting: pick([{}, { hero: { reason: 'knockout' } }, { hero: { kind: 'long' } }, { hero: null }, 'ab']),
    },
    beasts: input,
  }
  if (chance(0.6)) battery(state)
  for (let step = 0; step < int(1, 6); step += 1) {
    const type = pick(['BeastEncountered', 'BeastSoothingResolved', 'BeastBit', 'BeastFed', 'BeastTamed', 'BeastMoved', 'BeastScaredThreat', 'Other'])
    const known = Array.isArray(input?.beasts) ? input.beasts.map((beast) => beast?.id).filter(Boolean) : []
    const payload = type === 'BeastEncountered'
      ? { beast: chance(0.8) ? junkBeast(int(0, 50)) : undefined }
      : { beast_id: chance(0.8) && known.length ? pick(known) : pick(['', 'missing', 'constructor']), success: pick([true, false, 'yes']), stage_after: pick(['calmed', 'tamed', 'bogus']), ...(chance(0.6) ? { at_minutes: pick([0, 15, 9_000, '30', -7, 2.5]) } : {}), location_id: 'village', location_name: 'Тихий Брод' }
    const event = { event_type: type, payload: chance(0.05) ? pick([null, 'x']) : payload }
    record('applyBeastEvent', [input, event, state])
    try {
      input = beasts.applyBeastEvent(viaJson(input), viaJson(event), viaJson(state))
    } catch {
      break
    }
  }
}
for (let index = 0; index < 40; index += 1) {
  const enemy = junkEnemy(index)
  for (const name of ['beastDietFor', 'isTameableBeast', 'beastChallengeRating', 'beastIsWounded']) record(name, [enemy])
  record('beastTamingPolicy', [{ mechanics: { conditions: { [String(enemy.id)]: pick([[{ id: 'fled' }], []]) } } }, enemy, pick([null, { stage: 'fed', attempts: 1, diet: 'herbivore' }, { stage: 'wary', attempts: 9 }, { diet: 7 }])])
}
phaseCap = Infinity
for (const cr of [0, 0.125, 0.2, 0.25, 0.5, 0.75, 1, 2, 3, 3.5, 30, -1, 'x', '2', null, undefined, Infinity]) {
  record('beastChallengeDcShift', [cr])
  record('beastBiteDamage', [cr])
}
for (const key of ['predator', 'herbivore', 'wary', 'calmed', 'fed', 'tamed', '', 'constructor', '__proto__', 'toString', null, undefined, 5]) {
  record('beastDietLabel', [key])
  record('beastStageLabel', [key])
}
const RATION = { id: 'item-rations', catalog_id: 'srd_5_2_1:rations-one-day', name: 'Сухой паёк, 1 день', type: 'consumable', quantity: 2 }
const foods = [
  [{ inventory: [RATION] }, {}],
  [{ inventory: [{ id: 'i1', catalog_id: 'custom:jerky', name: 'Вяленое', quantity: 1 }] }, { 'custom:jerky': { use: { kind: 'ration' } } }],
  [{ inventory: [{ id: 'i2', name: 'Копчёное мясо', quantity: 1 }] }, undefined],
  [{ inventory: [{ ...RATION, quantity: 0 }] }, undefined],
  [{ inventory: [{ id: 'i3', name: 'Верёвка пеньковая', quantity: 1 }] }, undefined],
  [{ inventory: [{ id: 'i-trophy', name: 'Вяленое сердце вепря', quantity: 1, rarity: 'редкий' }, RATION] }, undefined],
  [{ inventory: [{ id: 'i-jerky', name: 'Копчёное мясо', quantity: 1 }, RATION] }, undefined],
  [{ inventory: [{ id: 'i-quest', name: 'Вяленое мясо', quantity: 1, quest_item: true }] }, undefined],
  [{ inventory: [{ id: 'i-att', name: 'Вяленое мясо', quantity: 1, requires_attunement: true }] }, undefined],
  [{ inventory: [{ id: 'i-eq', name: 'Сухари', quantity: 1, equipped: true }, { id: 'i-q', name: 'Паек', type: 'Quest', quantity: 1 }, { id: 'i-s', name: 'Провизия', sellable: false }] }, undefined],
  [{ inventory: [{ id: 'i-c', catalog_id: 'magic:meat', name: 'Мясо', quantity: 1 }] }, { 'magic:meat': { rarity: 'редкий' } }],
  [{ inventory: [{ id: 'i-c', catalog_id: 'magic:meat', name: 'Мясо', quantity: 1 }] }, { 'magic:meat': { attunement: { required: true } } }],
  [{ inventory: [null, 'паёк', 5, { name: 'Снедь', quantity: '2' }] }, undefined],
  [{ inventory: 'x' }, undefined],
  [undefined, undefined],
]
for (const [actor, table] of foods) record('beastFoodItemFor', [actor, table])
for (const event of [
  { event_type: 'BeastSoothingResolved', payload: { beast_id: 'beast:1', beast_name: 'Волк', success: true, stage_after: 'calmed', diet: 'predator' } },
  { event_type: 'BeastSoothingResolved', payload: { beast_id: 'beast:1', success: true, stage_after: 'tamed' } },
  { event_type: 'BeastSoothingResolved', payload: { beast_id: 'beast:1', success: false, stage_after: 'calmed' } },
  { event_type: 'BeastFed', payload: { beast_id: 'beast:1', beast_name: 'Кабан', item_name: 'Сухой паёк', diet: 'herbivore' } },
  { event_type: 'BeastFed', payload: { beast_id: 'beast:1', diet: 'constructor' } },
  { event_type: 'BeastTamed', payload: { beast_id: 'beast:1', beast_name: '', diet: '__proto__' } },
  { event_type: 'BeastTamed', payload: { beast_id: '' } },
  { event_type: 'BeastBit', payload: { beast_id: 'beast:1' } },
  { event_type: 'BeastFed', payload: null },
  {},
]) record('beastChronicleEntry', [event])

console.log(`сценарии ${afterScenarios}, корпус ${afterCorpus - afterScenarios}, мусор ${writer.cases.length - afterCorpus}`)
writer.write(new URL('./beast-taming.json', import.meta.url))
