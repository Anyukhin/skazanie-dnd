import '../../../fixtures-env.mjs'
// Эталоны `server/improvised-effects.mjs` для Rust-переноса (`sk-attention`).
//
// Каталоги целиком, глагол обстановки по ключу эффекта, план импровизации на
// случайных полях боя (стороны, живость, позиции из `mechanics.positions` и
// из карточек, площадь крупных существ, мусорные id и ставки) и цена хода по
// экономии действия. Поля боя из `test/improvised-effects.test.mjs` идут
// настоящей нормализацией движка.
//
// Запуск: node rust/crates/sk-attention/fixtures/gen-improvised-effects.mjs
import { writeFileSync } from 'node:fs'

const root = new URL('../../../../', import.meta.url)
const E = await import(new URL('server/improvised-effects.mjs', root).href)
const { normalizeCampaignState } = await import(new URL('server/rules-engine.mjs', root).href)

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
const random = rng(20260727)
const pick = (list) => list[Math.floor(random() * list.length)]
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const chance = (p) => random() < p
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// Поле боя из `test/improvised-effects.test.mjs`.
function battlefield(economy = { action: true, bonus_action: true, movement: true, movement_spent: 0 }) {
  return normalizeCampaignState({
    players: [
      { id: 'hero', hp: 12, maxHp: 12, armor: 14, speed: 30, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 0, y: 0, inventory: [] },
      { id: 'ally', hp: 10, maxHp: 10, armor: 13, speed: 30, abilities: { str: 10, dex: 14 }, x: 0, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'ogre', hp: 20, maxHp: 20, armor: 12, alive: true, x: 1, y: 0 }],
    scene: { cells: Array.from({ length: 30 }, (_, index) => ({ x: index % 15, y: Math.floor(index / 15), type: 'floor', revealed: true })), turn: 1 },
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }], action_economy: { hero: economy } } },
  })
}

/** Поле боя без полей, которых модуль не читает. */
function slim(state) {
  const actor = (entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const result = {}
    for (const key of ['id', 'actor_id', 'hp', 'alive', 'x', 'y', 'size', 'footprint']) if (Object.hasOwn(entry, key)) result[key] = entry[key]
    return result
  }
  const result = {}
  for (const key of ['players', 'actors', 'enemies']) if (Object.hasOwn(state, key)) result[key] = Array.isArray(state[key]) ? state[key].map(actor) : state[key]
  if (state.mechanics) {
    result.mechanics = {}
    if (Object.hasOwn(state.mechanics, 'positions')) result.mechanics.positions = state.mechanics.positions
    if (Object.hasOwn(state.mechanics, 'combat')) {
      const combat = state.mechanics.combat
      result.mechanics.combat = combat && typeof combat === 'object' ? { ...(Object.hasOwn(combat, 'active') ? { active: combat.active } : {}), ...(Object.hasOwn(combat, 'action_economy') ? { action_economy: combat.action_economy } : {}) } : combat
    }
  }
  return result
}

const IDS = ['hero', 'ally', 'ogre', 'wolf', 'summon', 'дракон', ' hero ', 'ｈｅｒｏ', '', 'undefined', 'null', '7']
const SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan', 'большой', 'Huge', '', null]

function randomActor(id) {
  const actor = {}
  if (id !== undefined) actor.id = id
  if (chance(0.85)) actor.hp = chance(0.6) ? int(1, 30) : pick([0, -3, '5', '0', null, 2.5, 'abc'])
  if (chance(0.25)) actor.alive = pick([true, false, 'false', 0, null])
  if (chance(0.85)) actor.x = chance(0.6) ? int(0, 2) : pick([3, 4, 5, 6, 7, 8, 10, 12, -1, '3', 2.5, null])
  if (chance(0.85)) actor.y = chance(0.6) ? int(0, 2) : pick([3, 4, 6, -2, '1', null])
  if (chance(0.2)) actor.size = pick(SIZES)
  if (chance(0.1)) actor.footprint = pick([{ version: 1, size: 2 }, { version: 1, size: 3 }, { version: 2, size: 2 }, { size: 9 }, null])
  return actor
}

function randomState() {
  if (chance(0.4)) {
    const state = battlefield()
    if (chance(0.6)) {
      const [x, y] = [int(0, 12), int(0, 4)]
      state.enemies[0] = { ...state.enemies[0], x, y }
      state.mechanics.positions.ogre = { x, y }
    }
    if (chance(0.2)) state.enemies[0].alive = false
    if (chance(0.2)) state.enemies[0].size = pick(['large', 'huge'])
    return slim(state)
  }
  const state = {}
  const used = new Set()
  const take = (preferred) => {
    const id = chance(0.85) ? preferred : pick(IDS)
    used.add(id)
    return id
  }
  if (chance(0.95)) state.players = [randomActor(take('hero')), ...(chance(0.6) ? [randomActor(take('ally'))] : []), ...(chance(0.1) ? [randomActor(undefined)] : [])]
  if (chance(0.3)) state.actors = [randomActor(take('summon')), ...(chance(0.2) ? [randomActor(take('ogre'))] : [])]
  if (chance(0.9)) state.enemies = [randomActor(take('ogre')), ...(chance(0.4) ? [randomActor(take('wolf'))] : []), ...(chance(0.1) ? [randomActor(take('hero'))] : [])]
  if (chance(0.05)) state.players = pick([null, 'hero', {}])
  const mechanics = {}
  if (chance(0.7)) {
    mechanics.positions = {}
    for (const id of [...used, 'hero', 'ogre']) if (chance(0.5)) mechanics.positions[String(id)] = pick([{ x: int(0, 10), y: int(0, 4) }, { x: '2', y: 0 }, { x: null, y: 1 }, { x: 1 }, null])
  }
  if (chance(0.7)) {
    mechanics.combat = { active: pick([true, true, false, 1, 0, 'yes', '', null]) }
    if (chance(0.8)) {
      mechanics.combat.action_economy = {}
      for (const id of ['hero', 'ally', 'undefined', 'null', 'ogre']) {
        if (chance(0.6)) mechanics.combat.action_economy[id] = chance(0.9) ? {
          ...(chance(0.8) ? { action: pick([true, false, 'false', null, 0]) } : {}),
          ...(chance(0.8) ? { bonus_action: pick([true, false, 'false', null]) } : {}),
        } : pick([null, 'x', 5])
      }
    }
  }
  state.mechanics = mechanics
  return state
}

const EFFECTS = [...E.IMPROVISED_EFFECT_IDS, ' prone ', 'PRONE', 'ｐｒｏｎｅ', 'instant_kill', '', 'none', 'help ally', 'blind ']
const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__']
const HAZARDS = [...E.ENVIRONMENT_HAZARD_IDS, ' fire ', 'ＦＩＲＥ', 'meteor', '', null]
const RISKS = ['none', 'minor', 'serious', 'deadly', ' deadly ', 'DEADLY', '99d99', '', null]

function randomOptions() {
  const options = {}
  if (chance(0.9)) options.actorId = chance(0.7) ? pick(['hero', 'ally']) : pick([...IDS, null, 5])
  if (chance(0.95)) options.effectId = chance(0.8) ? pick(E.IMPROVISED_EFFECT_IDS) : pick([...EFFECTS, null, 3])
  if (chance(0.9)) options.targetId = chance(0.7) ? pick(['ogre', 'ally', 'wolf', 'hero']) : pick([...IDS, null, 5])
  if (chance(0.7)) options.hazardId = chance(0.7) ? pick(E.ENVIRONMENT_HAZARD_IDS) : pick(HAZARDS)
  if (chance(0.6)) options.risk = pick(RISKS)
  return options
}

// Ключи прототипа (`constructor`, `__proto__`) у каталогов эффектов,
// опасностей и ставок JS разрешает в функции и объекты `Object` — такие входы
// в план не идут: до планировщика их не пропускает `action-adjudicator`, а
// Rust считает их неизвестными ключами (см. отчёт). У глагола обстановки исход
// тот же, и там они проверяются.
// Не массив вместо списка участников (`players: 'hero'`, `{}`) JS не
// переживает: `.some` и `[...x]` бросают TypeError. Такие случаи считаются,
// но в эталон не идут; Rust читает их как пустой список.
let jsThrows = 0
const plans = []
for (let index = 0; index < 2500; index += 1) {
  const state = clone(randomState())
  const options = clone(randomOptions())
  let expected
  try {
    expected = E.planImprovisedEffect(state, options)
  } catch {
    jsThrows += 1
    continue
  }
  plans.push({ state, options, expected: clone(expected) })
}
plans.push({ state: slim(battlefield()), expected: clone(E.planImprovisedEffect(battlefield())) })
// Исполнимые планы: поле боя теста, огр и союзник на случайных клетках рядом,
// крупный огр, позиция только в карточке или только в `mechanics.positions`.
for (let index = 0; index < 600; index += 1) {
  const state = battlefield()
  const [x, y] = [int(0, 8), int(0, 2)]
  state.enemies[0] = { ...state.enemies[0], x, y, ...(chance(0.3) ? { size: pick(['large', 'huge', 'gargantuan']) } : {}) }
  if (chance(0.8)) state.mechanics.positions.ogre = { x, y }
  else delete state.mechanics.positions.ogre
  if (chance(0.3)) state.mechanics.positions.ally = { x: int(0, 3), y: int(0, 2) }
  if (chance(0.1)) state.enemies[0].hp = 0
  const options = {
    actorId: pick(['hero', 'hero', 'ally']),
    effectId: pick(E.IMPROVISED_EFFECT_IDS),
    targetId: pick(['ogre', 'ogre', 'ally', 'hero']),
    hazardId: pick(E.ENVIRONMENT_HAZARD_IDS),
    risk: pick(RISKS),
  }
  const slimState = clone(slim(state))
  plans.push({ state: slimState, options, expected: clone(E.planImprovisedEffect(slimState, options)) })
}

const COSTS = [...E.ACTION_COSTS, 'movement', 'сделать бесплатно', '', ' action ', null, 5]
const costs = []
for (let index = 0; index < 1500; index += 1) {
  const state = clone(randomState())
  const actorId = pick([...IDS, null, 5, undefined])
  const requested = pick([...COSTS, undefined])
  const entry = { state, ...(actorId === undefined ? {} : { actor_id: actorId }), ...(requested === undefined ? {} : { requested }), expected: E.resolveActionCost(state, actorId, requested) }
  costs.push(entry)
}
costs.push({ state: slim(normalizeCampaignState({ players: [{ id: 'hero' }] })), actor_id: 'hero', requested: 'action', expected: E.resolveActionCost(normalizeCampaignState({ players: [{ id: 'hero' }] }), 'hero', 'action') })

const intents = [...EFFECTS, ...PROTOTYPE_KEYS, 'topple_prop ', 'ｉｇｎｉｔｅ＿ｐｒｏｐ', 'burn_everything', 'hazard_damage'].map((effectId) => ({ effect_id: effectId, expected: E.scenePropIntentFor(effectId) }))

const fixture = {
  constants: {
    ACTION_COSTS: [...E.ACTION_COSTS],
    IMPROVISED_EFFECTS: E.IMPROVISED_EFFECTS,
    ENVIRONMENT_HAZARDS: E.ENVIRONMENT_HAZARDS,
    IMPROVISED_EFFECT_IDS: [...E.IMPROVISED_EFFECT_IDS],
    ENVIRONMENT_HAZARD_IDS: [...E.ENVIRONMENT_HAZARD_IDS],
  },
  intents,
  plans,
  costs,
}
const text = JSON.stringify(fixture)
writeFileSync(new URL('./improvised-effects.json', import.meta.url), `${text}\n`)
const rejected = plans.filter((plan) => plan.expected.rejected).length
const commands = plans.filter((plan) => plan.expected.commands.length).length
console.log(`JS бросил исключение и случай пропущен: ${jsThrows}`)
console.log(`планов ${plans.length} (с командой ${commands}, отказов ${rejected}), цен ${costs.length}, глаголов ${intents.length}; ${(text.length / 1024 / 1024).toFixed(2)} МБ`)
