import '../../../fixtures-env.mjs'
import { startCapture, quietly, fixtureWriter, stripArgs, outcomeOf, viaJson, sha256, mulberry32, chooser, pickKeys, mapList, corpusDir, corpusRecords, corpusState, runTestFiles, UNDEFINED } from './lib.mjs'
// Эталон server/combat-narration.mjs для Rust:
//
//   node rust/crates/sk-narration/fixtures/gen-combat-narration.mjs [каталог корпуса]
//
// Источники входов:
//
// - настоящие вызовы рассказчика при прогоне тестов JS в этом процессе
//   (test/combat-narration.test.mjs и соседние, что зовут его изнутри
//   конвейера: Rules Engine, таверна, благословения, переговоры…);
// - корпус паритета: события каждой успешной команды и состояние после неё;
// - сотни случайных событий боя (попадание, промах, крит, урон, смерть,
//   заклинания, концентрация, благословения, погода, стол таверны, пленные,
//   звери) и мусор старых сохранений.
//
// Состояние и крупные payload событий урезаются до читаемых полей; JS
// исполняется на урезанном и полном входе, и в эталон идёт урезанный, только
// если исход совпал.
const c = await import('../../../../server/combat-narration.mjs')

const writer = fixtureWriter('combat-narration')
const stats = {}

// ---------------------------------------------------------------------------
// Функции и урезание
// ---------------------------------------------------------------------------

const isFallback = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$fallback')

function narrationOr(events, state, fallback, options) {
  let seen = null
  const actual = isFallback(fallback)
    ? (filtered) => {
      seen = sha256(JSON.stringify(filtered))
      return fallback.$fallback
    }
    : fallback
  const text = c.tacticalNarrationOr(events, state, actual, options)
  return { text, seen }
}

/** Один вход — все четыре функции хода: текст, части, голос, узнавание событий. */
function bundle(events, state, options) {
  return {
    text: outcomeOf(c.combatNarration, [events, state, options]),
    parts: outcomeOf(c.tacticalNarrationParts, [events, state, options]),
    voice: c.combatJournalVoice(events, state),
    has: c.hasCombatNarrationEvent(events),
  }
}

const FNS = {
  bundle: { fn: bundle, states: [1] },
  tacticalNarration: { fn: (...args) => c.combatNarration(...args), states: [1] },
  tacticalNarrationParts: { fn: (...args) => c.tacticalNarrationParts(...args), states: [1] },
  tacticalNarrationOr: { fn: narrationOr, states: [1] },
  combatJournalVoice: { fn: (...args) => c.combatJournalVoice(...args), states: [1] },
  encounterSetting: { fn: (...args) => c.encounterSetting(...args), states: [0] },
  encounterIntro: { fn: (...args) => c.encounterIntro(...args), states: [1] },
  encounterEndText: { fn: (...args) => c.encounterEndText(...args), states: [] },
  // Ключ прототипа даёт в JS функцию или прототип; Rust возвращает их текст —
  // ровно то, что печатает шаблонная строка у единственного вызывающего.
  damageTypeLabel: { fn: (...args) => String(c.damageTypeLabel(...args)), states: [] },
  hasCombatNarrationEvent: { fn: (...args) => c.hasCombatNarrationEvent(...args), states: [] },
}

const ACTOR_KEYS = ['id', 'actor_id', 'character', 'name', 'hp']

function slimState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  for (const key of ['players', 'enemies', 'actors']) if (Object.hasOwn(state, key)) out[key] = mapList(state[key], (actor) => pickKeys(actor, ACTOR_KEYS))
  if (Object.hasOwn(state, 'mechanics')) {
    const mechanics = state.mechanics
    if (mechanics && typeof mechanics === 'object' && !Array.isArray(mechanics)) {
      out.mechanics = {}
      if (Object.hasOwn(mechanics, 'combat')) {
        const combat = mechanics.combat
        out.mechanics.combat = combat && typeof combat === 'object' && !Array.isArray(combat)
          ? { ...pickKeys(combat, ['active']), ...(Object.hasOwn(combat, 'initiative') ? { initiative: Array.isArray(combat.initiative) ? combat.initiative.slice(0, 1).map((entry) => pickKeys(entry, ['actor_id'])) : combat.initiative } : {}) }
          : combat
      }
      if (Object.hasOwn(mechanics, 'world_time')) {
        const time = mechanics.world_time
        out.mechanics.world_time = time && typeof time === 'object' && !Array.isArray(time) ? pickKeys(time, ['elapsed_minutes']) : time
      }
    } else {
      out.mechanics = mechanics
    }
  }
  if (Object.hasOwn(state, 'scene')) {
    const scene = state.scene
    if (scene && typeof scene === 'object' && !Array.isArray(scene)) {
      out.scene = pickKeys(scene, ['theme'])
      if (Object.hasOwn(scene, 'map')) {
        const map = scene.map
        out.scene.map = map && typeof map === 'object' && !Array.isArray(map)
          ? { ...pickKeys(map, ['theme']), ...(Object.hasOwn(map, 'props') ? { props: mapList(map.props, (prop) => pickKeys(prop, ['id', 'assetId'])) } : {}) }
          : map
      }
    } else {
      out.scene = scene
    }
  }
  return out
}

const EVENT_KEYS = ['event_id', 'event_type', 'actor_id', 'target_ids', 'command_id', 'state_version_after', 'payload']
const BIG = 1_500

function slimEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const out = pickKeys(event, EVENT_KEYS)
  const payload = out.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const slim = {}
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'encounter' && value && typeof value === 'object' && !Array.isArray(value)) {
        slim.encounter = { ...pickKeys(value, ['theme', 'difficulty']), ...(Object.hasOwn(value, 'enemies') ? { enemies: mapList(value.enemies, (enemy) => pickKeys(enemy, ['name'])) } : {}) }
      } else if (JSON.stringify(value ?? null).length <= BIG) {
        slim[key] = value
      }
    }
    out.payload = slim
  }
  return out
}

const slimEvents = (events) => mapList(events, slimEvent)

const READ_KEYS = new Set(`target_id outcome reason allocations unassigned duration_minutes participant_ids opening_action surprised id
reaction_preference accepted source_actor_id trigger name action_options action_id success forced_movement pulled distance movement_mode
level_label to_level from_level recharge_action action_name condition_advantage condition_disadvantage high_ground cover cover_blockers
cover_scenery cover_bonus total armor_class shielded_by_reaction hit critical automatic_critical applied_amount hp_before hp_after resistant
vulnerable immune death_ward_triggered resistance_cantrip_reduction scenario_ward_text raw_amount damage_type label shots_after item_name
radius_feet action_type reaction_window_id monster_action saved spell_name spell_id economy_consumed summon turns_spent kind source_prop_id
result natural_roll modifier aura_of_protection_bonus kept difficulty trigger_label failure_increment recovery_hours maximum_hp_before
maximum_hp_after replacement_name condition source attack_bonus taunt truce broken_by term_summary term_label tribute_cp npc_name npc_total
stake_cp hero_total watch_result returned_cp forfeited_cp drinks social_bonus omen donation_cp captive captive_name settlement_name bounty_cp
beast beast_name stage_after amount line round auto_skip_reason phase_after weather_after prop_id loot text state intent trap_detected
encounter attack_kind`.split(/s+/u))
const FULL_PAYLOAD = /^(SceneObject|Lockpick|Rest|DamageApplied|TimeOfDay|Weather)/u

/** Сильное урезание события: только поля, которые читают рассказчик и словарь реплик. */
function tightEvent(event) {
  const out = slimEvent(event)
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out
  const payload = out.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && !FULL_PAYLOAD.test(String(out.event_type ?? ''))) {
    const slim = {}
    for (const [key, value] of Object.entries(payload)) {
      if (!READ_KEYS.has(key)) continue
      if (key === 'summon' && value && typeof value === 'object' && !Array.isArray(value)) slim.summon = pickKeys(value, ['name'])
      else if (key === 'action_options' && Array.isArray(value)) slim.action_options = value.map((option) => pickKeys(option, ['name']))
      else slim[key] = value
    }
    out.payload = slim
  }
  return out
}

const tightEvents = (events) => mapList(events, tightEvent)

/** Пропы карты: только те, на которые ссылаются события. */
function propsFor(state, events) {
  const ids = new Set((Array.isArray(events) ? events : []).map((event) => event?.payload?.prop_id).filter((id) => id != null).map(String))
  const props = state?.scene?.map?.props
  if (!Array.isArray(props)) return state
  return { ...state, scene: { ...state.scene, map: { ...state.scene.map, props: props.filter((prop) => ids.has(String(prop?.id ?? ''))) } } }
}

/** Урезания всего списка аргументов: от сильного к слабому. */
function argStrips(name) {
  const spec = FNS[name]
  const eventsAt = ['encounterIntro'].includes(name) ? 0 : ['encounterSetting', 'encounterEndText', 'damageTypeLabel'].includes(name) ? -1 : 0
  const slimArgs = (args, withState, withEvents) => args.map((arg, index) => {
    if (spec.states.includes(index)) return withState ? slimState(arg) : arg
    if (index === eventsAt && withEvents) return name === 'encounterIntro' ? slimEvent(arg) : slimEvents(arg)
    return arg
  })
  const tight = (args) => {
    const events = eventsAt >= 0 ? args[eventsAt] : null
    return args.map((arg, index) => {
      if (spec.states.includes(index)) return propsFor(slimState(arg), name === 'encounterIntro' ? [events] : events)
      if (index === eventsAt) return name === 'encounterIntro' ? tightEvent(arg) : tightEvents(arg)
      return arg
    })
  }
  return [tight, (args) => slimArgs(args, true, true), (args) => slimArgs(args, true, false), (args) => slimArgs(args, false, true)]
}

function record(name, rawArgs, { cap = Infinity, source = null } = {}) {
  const spec = FNS[name]
  const args = rawArgs.map(viaJson)
  const strips = argStrips(name)
  const expected = quietly(() => outcomeOf(spec.fn, args))
  let chosen = { args, outcome: expected }
  for (const strip of strips) {
    const candidate = strip(args)
    const outcome = quietly(() => outcomeOf(spec.fn, candidate))
    if (JSON.stringify(outcome) === JSON.stringify(expected)) {
      chosen = { args: candidate, outcome }
      stats.stripped = (stats.stripped ?? 0) + 1
      break
    }
  }
  if (chosen.args === args) stats.full = (stats.full ?? 0) + 1
  return writer.add(name, chosen.args, chosen.outcome, { stateArgs: spec.states, cap, source })
}

// ---------------------------------------------------------------------------
// 1. Настоящие вызовы при прогоне тестов JS
// ---------------------------------------------------------------------------

const captured = []
const capturedPerFn = new Map()
const CAPTURE_LIMIT = 600

const stop = startCapture((module, name, args) => {
  if (module !== 'server/combat-narration.mjs' || !FNS[name]) return undefined
  if ((capturedPerFn.get(name) ?? 0) >= CAPTURE_LIMIT) return undefined
  capturedPerFn.set(name, (capturedPerFn.get(name) ?? 0) + 1)
  let plain
  try {
    plain = args.map((arg) => (typeof arg === 'function' ? arg : viaJson(arg)))
  } catch {
    return undefined
  }
  if (name === 'tacticalNarrationOr' && typeof args[2] === 'function') {
    const original = args[2]
    const entry = { name, args: plain, fallback: null }
    captured.push(entry)
    const spy = (...inner) => {
      const value = original(...inner)
      entry.fallback = String(value ?? '')
      return value
    }
    return { args: [args[0], args[1], spy, ...args.slice(3)] }
  }
  captured.push({ name, args: plain })
  return undefined
})

const TEST_FILES = [
  'combat-narration', 'bestiary-monster-actions', 'blessings', 'boss-mechanics', 'concentration-end-reasons',
  'deterministic-narration', 'encounter-deadly-tier', 'encounter-rewards-ruleset', 'monster-defenses', 'monster-recharge',
  'npc-equipment', 'parley', 'reaction-preferences', 'scenario-knight', 'shove-push', 'tavern-life', 'thrown-flasks',
  'weather', 'scene-summary', 'scene-narration',
].map((name) => new URL(`../../../../test/${name}.test.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))

await runTestFiles(TEST_FILES)
stop()

for (const entry of captured) {
  const args = entry.args.slice()
  if (entry.name === 'tacticalNarrationOr' && typeof args[2] === 'function') args[2] = { $fallback: entry.fallback ?? 'запасной текст' }
  record(entry.name, args, { source: 'tests' })
}
console.log(`тесты JS: перехвачено ${captured.length} вызовов`, Object.fromEntries(capturedPerFn))

// ---------------------------------------------------------------------------
// 2. Корпус паритета
// ---------------------------------------------------------------------------

const corpus = corpusDir(process.argv[2])
if (corpus) {
  const perSignature = new Map()
  let rows = 0
  let used = 0
  for (const record_ of corpusRecords(corpus)) {
    rows += 1
    const events = record_.events
    if (!events.length || !c.hasCombatNarrationEvent(events)) continue
    const state = corpusState(corpus, record_.after)
    if (!state) continue
    const signature = events.map((event) => event?.event_type).join(',')
    const count = perSignature.get(signature) ?? 0
    if (count >= 3) continue
    perSignature.set(signature, count + 1)
    used += 1
    record('bundle', [events, state], { source: 'corpus' })
    for (const event of events) {
      if (event?.event_type === 'EncounterCreated') {
        record('encounterIntro', [event, state], { source: 'corpus' })
        record('encounterSetting', [state, event.payload?.encounter], { source: 'corpus' })
      }
      if (event?.event_type === 'EncounterEnded') record('encounterEndText', [event.payload?.reason ?? event.payload?.outcome], { source: 'corpus' })
      if (event?.event_type === 'DamageApplied') record('damageTypeLabel', [event.payload?.damage_type], { source: 'corpus' })
    }
  }
  console.log(`корпус: строк ${rows}, использовано ${used}, сигнатур ${perSignature.size}`)
} else {
  console.log('корпус не найден — пропущен')
}

// ---------------------------------------------------------------------------
// 3. Случайные события боя и мусор
// ---------------------------------------------------------------------------

const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)

const GARBAGE = [null, 0, -3, 1e21, '', 'строка', '12', 'constructor', '__proto__', 'toString', [], [1, 'a'], ['x'], {}, { a: 1 }, { length: 2 }, true, false, '😀🙂', '   пробелы  внутри\t ']
const garbage = () => pick(GARBAGE)
const maybe = (value, p = 0.08) => (chance(p) ? garbage() : value)

const HERO_NAMES = ['Лира', 'Бор', 'Кирем', 'Мирель', 'Тордин', 'Эльза', 'Хоп', 'Ульф Железный']
const ENEMY_NAMES = ['Волк', 'Гоблин', 'Гоблин 2', 'Огр', 'Тень', 'Скелет', 'Хобгоблин-капитан', 'Разбойник 3', 'Паучиха', 'Mimic', 'Безголовый рыцарь', 'Крыса']
const CONDITIONS = ['blinded', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious', 'fled', 'surrendered', 'minor-blessing', 'constructor', 'charmed']
const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder', 'FIRE', 'constructor', '__proto__', 'unknown', null]
const SPELLS = ['fire-bolt', 'sacred-flame', 'magic-missile', 'healing-word', 'cure-wounds', 'shield', 'bless', 'eldritch-blast', 'scorching-ray', 'hold-person', 'unknown-spell', null]
const WEAPONS = ['Длинный меч', 'Короткий лук', 'Кинжал', 'Боевой посох', 'Арбалет', 'Булава', 'Copper sword', '']
const TACTICS = ['тактика стаи', 'давит на раненого', 'загнан в угол', 'сокращает дистанцию', 'выходит на линию атаки', 'держит дистанцию', 'пытается спастись', 'неизвестная']
const PROP_ASSETS = ['chest', 'barrel', 'crate', 'sarcophagus', 'bookshelf', 'table', 'altar', 'statue', 'well', 'tree_oak', 'campfire', 'chandelier', 'unknown_asset']
const THEMES = ['forest', 'road', 'settlement', 'graveyard', 'building', 'temple', 'crypt', 'cave', 'dungeon', '', 'swamp', 'FOREST']

let serial = 0

function randomState() {
  const players = Array.from({ length: int(1, 4) }, (_, index) => ({
    id: `hero-${index + 1}`,
    ...(chance(0.7) ? { character: pick(HERO_NAMES) } : {}),
    ...(chance(0.4) ? { name: pick(HERO_NAMES) } : {}),
    hp: int(-2, 30),
  }))
  const enemies = Array.from({ length: int(0, 4) }, (_, index) => ({
    id: `enemy-${index + 1}`,
    name: pick(ENEMY_NAMES),
    hp: chance(0.25) ? 0 : int(-1, 40),
  }))
  const actors = chance(0.3) ? [{ actor_id: 'npc-1', name: pick(['Хозяин таверны', 'Стражник', 'Жрица']) }] : undefined
  const state = { players: mapList(players, (p) => maybe(p, 0.03)), enemies: mapList(enemies, (e) => maybe(e, 0.03)) }
  if (actors) state.actors = actors
  if (chance(0.06)) state.players = garbage()
  if (chance(0.06)) state.enemies = garbage()
  if (chance(0.6)) {
    state.mechanics = {
      combat: { active: chance(0.6), initiative: chance(0.8) ? [{ actor_id: pick([...players, ...enemies]).id ?? 'hero-1' }] : maybe([]) },
      ...(chance(0.5) ? { world_time: { elapsed_minutes: int(0, 3000) } } : {}),
    }
  }
  if (chance(0.7)) {
    state.scene = {
      ...(chance(0.6) ? { theme: pick(THEMES) } : {}),
      map: {
        ...(chance(0.3) ? { theme: pick(THEMES) } : {}),
        props: Array.from({ length: int(0, 4) }, (_, index) => ({ id: `prop-${index + 1}`, assetId: pick(PROP_ASSETS) })),
      },
    }
  }
  if (chance(0.03)) return garbage()
  return state
}

function actorIds(state) {
  const ids = []
  for (const key of ['players', 'enemies']) for (const actor of Array.isArray(state?.[key]) ? state[key] : []) if (actor && typeof actor === 'object') ids.push(actor.id)
  return ids.length ? ids : ['hero-1']
}

function base(type, state, extra = {}) {
  serial += 1
  const ids = actorIds(state)
  const event = { event_type: type }
  if (chance(0.85)) event.event_id = `evt-${serial}-${int(0, 9999)}`
  event.actor_id = maybe(pick(ids), 0.05)
  event.target_ids = chance(0.85) ? [maybe(pick(ids), 0.05)] : maybe([], 0.3)
  if (chance(0.6)) event.command_id = `cmd-${int(1, 4)}`
  if (chance(0.3)) event.state_version_after = int(1, 500)
  event.payload = extra
  return event
}

const roll = () => int(1, 20)
const amount = () => (chance(0.1) ? garbage() : int(0, 25))

const GENERATORS = {
  AttackResolved: (s) => base('AttackResolved', s, {
    hit: chance(0.6), critical: chance(0.15), automatic_critical: chance(0.05), total: maybe(roll() + int(0, 8)), armor_class: maybe(int(10, 19)),
    attack_mode: pick(['melee', 'ranged', 'spell', undefined]), weapon_name: pick(WEAPONS), damage_type: pick(DAMAGE_TYPES),
    ...(chance(0.2) ? { condition_advantage: maybe([`${pick(['target', 'attacker'])}:${pick(CONDITIONS)}`], 0.15) } : {}),
    ...(chance(0.2) ? { condition_disadvantage: maybe([`${pick(['target', 'attacker'])}:${pick(CONDITIONS)}`, pick(['prone', 'target'])], 0.15) } : {}),
    ...(chance(0.2) ? { high_ground: pick(['higher', 'lower', 'same']) } : {}),
    ...(chance(0.2) ? { cover: pick(['half', 'three-quarters', true]), cover_bonus: maybe(pick([2, 5, undefined])), cover_blockers: maybe([pick(actorIds(s))], 0.1), cover_scenery: maybe([pick(['tree_oak', 'table_long', 'constructor', 'Валун', 'unknown', 'barrel'])], 0.1) } : {}),
    ...(chance(0.15) ? { shielded_by_reaction: true } : {}),
    ...(chance(0.1) ? { recharge_action: true, action_name: maybe(pick(['Огненное дыхание', '', undefined])), action_id: 'breath' } : {}),
  }),
  DamageApplied: (s) => base('DamageApplied', s, {
    applied_amount: amount(), raw_amount: amount(), hp_before: amount(), hp_after: amount(), damage_type: pick(DAMAGE_TYPES),
    ...(chance(0.1) ? { immune: true } : {}), ...(chance(0.1) ? { resistant: true } : {}), ...(chance(0.1) ? { vulnerable: true } : {}),
    ...(chance(0.05) ? { death_ward_triggered: true } : {}), ...(chance(0.05) ? { resistance_cantrip_reduction: int(1, 4) } : {}),
    ...(chance(0.04) ? { scenario_ward_text: 'Клинок проходит сквозь пустоту, и рыцарь смеётся.' } : {}),
    ...(chance(0.03) ? { reason: 'scene-object-trap' } : {}),
  }),
  HealingApplied: (s) => base('HealingApplied', s, { applied_amount: amount(), hp_before: amount(), hp_after: amount(), ...(chance(0.1) ? { reason: 'stable-recovery-after-1d4-hours' } : {}), ...(chance(0.1) ? { spell_id: 'aura-of-life' } : {}) }),
  HitPointsReducedToZero: (s) => base('HitPointsReducedToZero', s, {}),
  DeathSavingThrowRolled: (s) => base('DeathSavingThrowRolled', s, { natural_roll: maybe(roll()), modifier: maybe(pick([0, 0, 2, -1])), total: maybe(pick([undefined, roll()])), success: chance(0.5), result: pick(['revived', 'stabilized', 'died', undefined, undefined]), ...(chance(0.1) ? { aura_of_protection_bonus: int(1, 5) } : {}) }),
  ConcentrationSavingThrowResolved: (s) => base('ConcentrationSavingThrowResolved', s, { kept: maybe(roll()), modifier: maybe(pick([0, 3, -2])), total: maybe(pick([undefined, roll()])), difficulty: maybe(pick([10, 12, undefined])), saved: chance(0.5), ...(chance(0.1) ? { aura_of_protection_bonus: 3 } : {}) }),
  ConcentrationEnded: (s) => base('ConcentrationEnded', s, { reason: maybe(pick(['damage', 'incapacitated', 'new-concentration', 'duration-expired', 'voluntary', 'unknown'])) }),
  SpellCast: (s) => {
    const event = base('SpellCast', s, { name: maybe(pick(['Огненный снаряд', 'Священное пламя', '', undefined])), spell_id: pick(SPELLS), ...(chance(0.2) ? { economy_consumed: false } : {}) })
    if (chance(0.2)) event.event_id = `spell-cast:${int(1, 9)}:beam:${int(1, 3)}`
    if (chance(0.1)) event.command_id = `cmd-ray:beam:${int(1, 3)}`
    return event
  },
  SpellSavingThrowResolved: (s) => base('SpellSavingThrowResolved', s, { saved: pick([true, false, undefined, 'yes']), spell_id: pick(SPELLS), ...(chance(0.4) ? { spell_name: maybe(pick(['Удержание личности', 'Hold Person', ''])) } : {}) }),
  NpcSavingThrowResolved: (s) => base('NpcSavingThrowResolved', s, { saved: pick([true, false]), spell_id: pick(SPELLS), name: maybe(pick(['Священное пламя', undefined])) }),
  SavingThrowResolved: (s) => base('SavingThrowResolved', s, { saved: pick([true, false, undefined]) }),
  ActorMoved: (s) => base('ActorMoved', s, { distance: maybe(pick([5, 10, 15, 30, -5])), movement_mode: pick([undefined, 'walk', 'long_jump', 'swing']), ...(chance(0.2) ? { forced_movement: true, pulled: chance(0.5) } : {}) }),
  CombatStarted: (s) => base('CombatStarted', s, {
    ...(chance(0.3) ? { opening_action: { actor_id: pick(actorIds(s)), ...(chance(0.5) ? { npc_id: pick(actorIds(s)) } : {}), free_strike: chance(0.3), status: pick(['deferred', 'resolved']), first_actor_id: pick(actorIds(s)) } } : {}),
    ...(chance(0.3) ? { surprised: maybe([pick(actorIds(s))], 0.1) } : {}),
  }),
  CombatEnded: (s) => base('CombatEnded', s, { round: maybe(int(1, 9)) }),
  EncounterCreated: (s) => base('EncounterCreated', s, {
    encounter: maybe({ theme: pick(['ambush', 'crypt', 'cave', 'forest', undefined]), difficulty: pick(['easy', 'deadly', undefined]), enemies: Array.from({ length: int(0, 4) }, () => maybe({ name: pick(ENEMY_NAMES) }, 0.05)) }, 0.05),
  }),
  EncounterEnded: (s) => base('EncounterEnded', s, { reason: maybe(pick(['resolved', 'victory', 'enemies_defeated', 'party_defeated', 'fled', 'truce', 'стороны разошлись миром', 'mixed текст', 'unknown_code', 'constructor'])), outcome: pick(['enemies_defeated', undefined]) }),
  EncounterRewardsDistributed: (s) => base('EncounterRewardsDistributed', s, {
    allocations: Array.from({ length: int(0, 3) }, () => ({ recipient_id: pick(actorIds(s)), items: Array.from({ length: int(0, 3) }, () => ({ name: maybe(pick(WEAPONS)), quantity: maybe(pick([1, 2, 3, undefined])) })), coins_cp: maybe(int(0, 1500)), xp: maybe(pick([0, 50, 100, 100])) })),
    ...(chance(0.3) ? { unassigned: { items: [{ name: 'Тяжёлый щит', quantity: 2 }] } } : {}),
  }),
  DowntimeResolved: (s) => base('DowntimeResolved', s, { reason: pick(['post_encounter_recovery', 'post_encounter_recovery_after_stabilisation', 'post_defeat_recovery', 'other']), duration_minutes: maybe(pick([480, 720, undefined])), participant_ids: actorIds(s) }),
  RestStarted: (s) => base('RestStarted', s, { kind: pick(['short', 'long']), ...(chance(0.1) ? { source_prop_id: 'prop-1' } : {}) }),
  RestCompleted: (s) => base('RestCompleted', s, { kind: pick(['short', 'long']), ...(chance(0.1) ? { reason: 'knockout' } : {}), ...(chance(0.1) ? { source_prop_id: 'prop-1' } : {}) }),
  TurnStarted: (s) => base('TurnStarted', s, { round: maybe(int(1, 6)) }),
  TurnEnded: (s) => base('TurnEnded', s, chance(0.15) ? { auto_skip_reason: 'turn-timeout' } : {}),
  ReactionWindowOpened: (s) => base('ReactionWindowOpened', s, { id: `rw-${int(1, 3)}`, trigger: pick(['enemy-left-reach', 'spell-cast', 'attack']), source_actor_id: pick(actorIds(s)), action_id: pick(['opportunity-attack', 'cast:shield', 'uncanny-dodge', 'constructor', 'x']), ...(chance(0.3) ? { action_options: [{ name: pick(['Щит', 'Shield', '']) }] } : {}) }),
  ReactionWindowClosed: (s) => base('ReactionWindowClosed', s, { id: `rw-${int(1, 3)}`, accepted: pick([true, false, undefined]), ...(chance(0.2) ? { reaction_preference: pick(['auto', 'never']) } : {}), action_id: 'cast:shield' }),
  CombatActionUsed: (s) => base('CombatActionUsed', s, {
    action_id: pick(['opportunity-attack', 'dash', 'disengage', 'dodge', 'help', 'hide', 'break-free', 'cast:shield', 'custom']), name: maybe(pick(['Рывок', 'Отход', 'Высвободиться', 'Dash', '', undefined])),
    ...(chance(0.2) ? { action_type: 'reaction' } : {}), ...(chance(0.1) ? { reaction_window_id: 'rw-1' } : {}), ...(chance(0.1) ? { reaction_preference: pick(['auto', 'never']) } : {}),
    ...(chance(0.1) ? { monster_action: true } : {}), ...(chance(0.3) ? { success: pick([true, false, 'yes']) } : {}),
  }),
  ConditionAdded: (s) => base('ConditionAdded', s, { condition: pick(CONDITIONS), ...(chance(0.3) ? { action_id: 'web' } : {}), ...(chance(0.15) ? { source: pick(['blessing:shrine', 'tavern-drink', 'spell']) } : {}), ...(chance(0.1) ? { attack_bonus: maybe(int(1, 3)) } : {}) }),
  ConditionRemoved: (s) => base('ConditionRemoved', s, { condition: pick(['minor-blessing', 'prone']), trigger: pick(['attack', 'rest']) }),
  CreatureKnockedOut: (s) => base('CreatureKnockedOut', s, {}),
  KnockoutEnded: (s) => base('KnockoutEnded', s, {}),
  HeroStabilized: (s) => base('HeroStabilized', s, {}),
  HeroDied: (s) => base('HeroDied', s, {}),
  CampaignFailed: (s) => base('CampaignFailed', s, {}),
  HeroResurrected: (s) => base('HeroResurrected', s, {}),
  HeroReplaced: (s) => base('HeroReplaced', s, { replacement_name: maybe(pick(['Новичок Тим', ''])) }),
  StableRecoveryScheduled: (s) => base('StableRecoveryScheduled', s, { recovery_hours: maybe(int(0, 4)) }),
  DeathSaveFailureRecorded: (s) => base('DeathSaveFailureRecorded', s, { failure_increment: pick([1, 2, '2']) }),
  HitPointMaximumReduced: (s) => base('HitPointMaximumReduced', s, { maximum_hp_before: amount(), maximum_hp_after: amount() }),
  HitPointMaximumIncreased: (s) => base('HitPointMaximumIncreased', s, { maximum_hp_before: amount(), maximum_hp_after: amount() }),
  HitPointMaximumReductionPrevented: (s) => base('HitPointMaximumReductionPrevented', s, {}),
  ActionReadied: (s) => base('ActionReadied', s, { trigger_label: maybe(pick(['враг подойдёт', undefined, ''])) }),
  ReadiedActionExpired: (s) => base('ReadiedActionExpired', s, { reason: pick(['used', 'concentration-lost', 'turn-start']), ...(chance(0.4) ? { spell_id: 'fire-bolt' } : {}) }),
  SwingResolved: (s) => base('SwingResolved', s, { success: pick([true, false]) }),
  MapLevelChanged: (s) => base('MapLevelChanged', s, { from_level: maybe(int(0, 2)), to_level: maybe(int(0, 2)), level_label: maybe(pick(['Подвал', '', undefined])) }),
  DoorLockpicked: (s) => base('DoorLockpicked', s, { success: pick([true, false]) }),
  NpcItemUsed: (s) => base('NpcItemUsed', s, { label: maybe(pick(['прикладывается к склянке', ''])) }),
  NpcEquipmentSpent: (s) => base('NpcEquipmentSpent', s, { reason: pick(['ammunition', 'potion']), shots_after: pick([0, 1, '0']) }),
  ItemEffectIneffective: (s) => base('ItemEffectIneffective', s, { item_name: maybe(pick(['Склянка кислоты', ''])) }),
  LegendaryActionUsed: (s) => base('LegendaryActionUsed', s, { name: maybe(pick(['Удар хвостом', ''])) }),
  LegendaryResistanceUsed: (s) => base('LegendaryResistanceUsed', s, { reason: pick(['lethal', 'spell']) }),
  LegendaryActionsReset: (s) => base('LegendaryActionsReset', s, {}),
  MonsterAbilityRecharged: (s) => base('MonsterAbilityRecharged', s, { name: maybe(pick(['Огненное дыхание', ''])), action_id: 'breath' }),
  AreaAttackResolved: (s) => base('AreaAttackResolved', s, { item_name: maybe(pick(['Алхимический огонь', ''])), radius_feet: maybe(pick([5, 10])) }),
  SummonedCreatureCreated: (s) => base('SummonedCreatureCreated', s, { summon: maybe({ name: pick(['Дух-волк', '']) }) }),
  SummonedCreatureDismissed: (s) => base('SummonedCreatureDismissed', s, {}),
  EquipmentChanged: (s) => base('EquipmentChanged', s, { item_name: maybe(pick(WEAPONS)), turns_spent: chance(0.5) }),
  ConditionImmunityResolved: (s) => base('ConditionImmunityResolved', s, {}),
  ParleyProposed: (s) => base('ParleyProposed', s, {}),
  ParleyRejected: (s) => base('ParleyRejected', s, { taunt: maybe(pick(['Ха! Трусы!', ''])) }),
  TruceEstablished: (s) => base('TruceEstablished', s, { truce: maybe({ leader_name: pick(['Вожак', '']) }) }),
  TruceBroken: (s) => base('TruceBroken', s, { broken_by: pick(['enemies', 'party']) }),
  ParleySettled: (s) => base('ParleySettled', s, { outcome: pick(['resume', 'deal']), term_summary: maybe(pick(['Отряд уходит.', ''])), term_label: 'Мир', tribute_cp: maybe(pick([0, 50])) }),
  TavernDiceRoundOpened: (s) => base('TavernDiceRoundOpened', s, { npc_name: maybe('Гном Бруно'), npc_total: maybe(int(2, 12)), stake_cp: maybe(int(0, 50)) }),
  TavernDiceRoundResolved: (s) => base('TavernDiceRoundResolved', s, { hero_total: int(2, 12), npc_total: int(2, 12), stake_cp: maybe(int(0, 50)), outcome: pick(['win', 'loss', 'push', 'caught', 'walked']), watch_result: pick(['clean', undefined]) }),
  TavernDiceRoundCancelled: (s) => base('TavernDiceRoundCancelled', s, { returned_cp: maybe(pick([0, 10])), reason: pick(['patron-ejected', 'opponent-broke', 'forfeit']), forfeited_cp: maybe(10), npc_name: maybe('Бруно') }),
  TavernCheatCaught: (s) => base('TavernCheatCaught', s, { npc_name: maybe('Бруно') }),
  TavernCheatExposed: (s) => base('TavernCheatExposed', s, { npc_name: maybe('Бруно') }),
  TavernPatronEjected: (s) => base('TavernPatronEjected', s, {}),
  TavernDrinkOrdered: (s) => base('TavernDrinkOrdered', s, { drinks: maybe(int(1, 5)), social_bonus: pick([0, 1]) }),
  ShrinePrayerResolved: (s) => base('ShrinePrayerResolved', s, { outcome: pick(['blessed', 'omen', 'silence']), omen: maybe(pick(['Свеча гаснет.', ''])) }),
  NpcBlessingGranted: (s) => base('NpcBlessingGranted', s, { npc_name: maybe('Жрица'), donation_cp: maybe(int(0, 100)) }),
  CaptiveTaken: (s) => base('CaptiveTaken', s, { captive: maybe({ origin: pick(['knocked_out', 'surrendered']), name: maybe(pick(ENEMY_NAMES)) }) }),
  CaptiveInterrogated: (s) => base('CaptiveInterrogated', s, { success: pick([true, false]) }),
  CaptiveFed: (s) => base('CaptiveFed', s, {}),
  CaptiveNeglected: (s) => base('CaptiveNeglected', s, { captive_name: maybe('Гоблин') }),
  CaptiveReleased: (s) => base('CaptiveReleased', s, {}),
  CaptiveHandedOver: (s) => base('CaptiveHandedOver', s, { settlement_name: maybe('Норвин'), bounty_cp: maybe(int(0, 200)) }),
  CaptiveExecuted: (s) => base('CaptiveExecuted', s, {}),
  CaptiveMoved: (s) => base('CaptiveMoved', s, {}),
  BeastEncountered: (s) => base('BeastEncountered', s, { beast: maybe({ name: pick(['Волчица', '']) }) }),
  BeastSoothingResolved: (s) => base('BeastSoothingResolved', s, { success: pick([true, false]), stage_after: pick(['tamed', 'calm']), beast_name: maybe('Волчица') }),
  BeastBit: (s) => base('BeastBit', s, { beast_name: maybe('Волчица'), amount: amount() }),
  BeastFed: (s) => base('BeastFed', s, { beast_name: maybe('волчица'), item_name: maybe('Паёк') }),
  BeastTamed: (s) => base('BeastTamed', s, { beast_name: maybe('Волчица') }),
  BeastMoved: (s) => base('BeastMoved', s, { beast_name: maybe('Волчица') }),
  BeastScaredThreat: (s) => base('BeastScaredThreat', s, { beast_name: maybe('Волчица'), line: maybe(pick(['Волчица рычит на крысу.', ''])) }),
  TimeOfDayChanged: (s) => base('TimeOfDayChanged', s, { phase_after: pick(['morning', 'day', 'evening', 'night', 'constructor']) }),
  WeatherChanged: (s) => base('WeatherChanged', s, { weather_after: pick(['clear', 'overcast', 'rain', 'fog', 'storm', 'toString']), reason: pick(['region', 'day']) }),
  SceneObjectInspected: (s) => base('SceneObjectInspected', s, { prop_id: pick(['prop-1', 'prop-2', 'prop-9']), success: pick([true, false]), trap_detected: chance(0.3) }),
  SceneObjectStateChanged: (s) => base('SceneObjectStateChanged', s, { prop_id: pick(['prop-1', 'prop-2']), state: pick(['open', 'toppled', 'burning', 'taken', 'used', 'closed']), success: pick([true, false, undefined]), intent: pick(['open', 'lockpick', 'topple']) }),
  SceneObjectLootRevealed: (s) => base('SceneObjectLootRevealed', s, { prop_id: 'prop-1', loot: [{ name: pick(['Боевой посох', 'Золотое кольцо', '']) }] }),
  SceneObjectLootGranted: (s) => base('SceneObjectLootGranted', s, { prop_id: 'prop-1', loot: maybe([{ name: 'Боевой посох' }, { name: 'Свиток' }]) }),
  LockpickNoticed: (s) => base('LockpickNoticed', s, { prop_id: 'prop-1' }),
  Unknown: (s) => base(pick(['ObjectiveUpdated', 'TimeAdvanced', 'SceneAdvanced']), s, {}),
}

const GENERATOR_NAMES = Object.keys(GENERATORS)

function randomEvents(state) {
  const count = int(1, 7)
  const events = []
  for (let index = 0; index < count; index += 1) {
    const roll_ = random()
    if (roll_ < 0.02) events.push(pick([null, 5, 'событие', [], {}, { event_type: ['AttackResolved'] }, { event_type: 'AttackResolved', payload: null }]))
    else events.push(GENERATORS[pick(GENERATOR_NAMES)](state))
  }
  // Удар со своим уроном — частый случай слияния строк.
  if (chance(0.3)) {
    const attack = GENERATORS.AttackResolved(state)
    attack.payload.hit = true
    const damage = GENERATORS.DamageApplied(state)
    damage.target_ids = attack.target_ids
    damage.command_id = attack.command_id
    events.push(attack, damage)
  }
  return events
}

const TARGET_RANDOM = 2_500
for (let index = 0; index < TARGET_RANDOM; index += 1) {
  const state = randomState()
  const events = randomEvents(state)
  const options = chance(0.3) ? { npcTurns: actorIds(state).map((id) => ({ actor_id: id, tactic: pick(TACTICS) })) } : undefined
  record('bundle', options ? [events, state, options] : [events, state], { source: 'random' })
  if (index % 7 === 0) record('tacticalNarrationOr', [events, state, chance(0.5) ? 'Запасной текст.' : { $fallback: pick(['', 'Сцена перемещена.']) }, options ?? {}], { source: 'random' })
}
for (let index = 0; index < 300; index += 1) {
  const state = randomState()
  const encounter = chance(0.9) ? { theme: pick(['ambush', 'crypt', 'cave', 'forest', undefined, 'AMBUSH']), enemies: [{ name: pick(ENEMY_NAMES) }] } : garbage()
  record('encounterSetting', [state, encounter], { source: 'random' })
  record('encounterIntro', [GENERATORS.EncounterCreated(state), state], { source: 'random' })
}
for (const value of [...GARBAGE, 'resolved', 'victory', 'enemies_defeated', 'party_defeated', 'party_incapacitated', 'surrendered', 'truce', 'parley', 'fled', ' fled ', 'Отряд ушёл', 'Ушли mixed', 'ЁЖ', 'ё'.repeat(130), `${'я'.repeat(119)}😀`, 'hasOwnProperty']) {
  record('encounterEndText', [value], { source: 'random' })
}
for (const value of [...GARBAGE, ...DAMAGE_TYPES, 'Poison', 'ACID', 'valueOf']) record('damageTypeLabel', [value], { source: 'random' })

console.log('урезание:', stats)
writer.write(new URL('./combat-narration.json.gz', import.meta.url))
void UNDEFINED
void stripArgs
