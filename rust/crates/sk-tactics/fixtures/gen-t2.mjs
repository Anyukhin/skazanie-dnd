import '../../../fixtures-env.mjs'
// Эталоны задачи Т2: `server/adjudicator.mjs` и `server/party-tactics.mjs`.
//
// Три источника случаев:
// 1. «тесты» — вызовы модулей, записанные при прогоне тестов JS, которые их
//    касаются (`record/*.mjs`: хук загрузчика подменяет модуль обёрткой,
//    обёртка повторяет вызов на JSON-копии аргументов). Смысловые проверки
//    тестов JS переходят в Rust как паритет на тех же входах;
// 2. «корпус» — боевые состояния `tmp/corpus-v1` (ход героя, окно реакции),
//    со всеми классами, где они есть, и их синтетические варианты (раны,
//    зелья, падение, потраченная экономика, скрытые хиты врагов);
// 3. «заявки» — интенты `createPlan` на состояниях корпуса и мусор.
//
// Выход: `t2.json.gz` — `{ states, cases }`, состояние в аргументах заменено
// ссылкой `{ "$state": индекс }`; итог — `{ ok }`, `{ err: [code, message] }`
// или `{ fault }`.
//
// Запуск: node rust/crates/sk-tactics/fixtures/gen-t2.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Adjudicator, difficultyCategoryFor } from '../../../../server/adjudicator.mjs'
import { healingTargetFor, planHeroCombatCommand, planHeroReaction, planHeroTurn } from '../../../../server/party-tactics.mjs'
import { combatSpellsFor } from '../../../../server/combat-spells.mjs'
import { RulesEngine, resolveCommand } from '../../../../server/rules-engine.mjs'
import { fixedDice } from '../../../../test/kit/dice.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const corpusDir = process.argv[2] ?? process.env.SK_T2_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0007_2a2b
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function failure(error) {
  if (error?.name === 'RulesValidationError') return { err: [error.code, error.message] }
  return { fault: String(error?.name ?? 'Error') }
}
async function outcome(run) {
  try {
    return { ok: clone(await run()) }
  } catch (error) {
    return failure(error)
  }
}

// --- состояния и случаи ------------------------------------------------------------

const states = []
const stateIndex = new Map()
function addState(state) {
  const key = sha(state)
  if (!stateIndex.has(key)) {
    stateIndex.set(key, states.length)
    states.push(state)
  }
  return stateIndex.get(key)
}
const cases = []
const caseKeys = new Set()
function pushCase(source, f, args, o) {
  const key = sha([f, args])
  if (caseKeys.has(key)) return false
  caseKeys.add(key)
  cases.push({ source, f, a: args, o })
  return true
}
/** Состояние — первый аргумент тактики и `state` заявки. */
function refArgs(f, args) {
  const copy = clone(args)
  if (f === 'createPlan') {
    if (copy[0] && typeof copy[0] === 'object' && copy[0].state && typeof copy[0].state === 'object') copy[0].state = { $state: addState(copy[0].state) }
  } else if (f === 'difficultyCategoryFor') {
    if (copy[1] && typeof copy[1] === 'object') copy[1] = { $state: addState(copy[1]) }
  } else if (copy[0] && typeof copy[0] === 'object') {
    copy[0] = { $state: addState(copy[0]) }
  }
  return copy
}

const FUNCTIONS = {
  healingTargetFor: (args) => healingTargetFor(...args),
  planHeroTurn: (args) => planHeroTurn(...args),
  planHeroReaction: (args) => planHeroReaction(...args),
  planHeroCombatCommand: (args) => planHeroCombatCommand(...args),
  difficultyCategoryFor: (args) => difficultyCategoryFor(...args),
  createPlan: (args) => new Adjudicator().createPlan(...args),
}
/**
 * Принимает ли движок JS план автотактики (кости — `fixedDice(10)`):
 * `planHeroTurn` — `resolvePlan` с контекстом автономного цикла
 * (`runCommands`), `planHeroCombatCommand` — `resolveCommand` с контекстом
 * стенда. Итог — `{ ok: число событий }`, `{ err }` или `{ fault }`.
 */
function acceptance(f, state, o) {
  if (!o.ok) return undefined
  try {
    const engine = new RulesEngine({ diceService: fixedDice(10) })
    if (f === 'planHeroTurn') {
      const ids = [...(state.players ?? []), ...(state.enemies ?? []), ...(state.actors ?? [])].map((actor) => String(actor.id ?? actor.actor_id))
      const proposed = o.ok.commands.map((command, index) => ({ ...command, campaign_id: 'T2', command_id: `t2:${index + 1}` }))
      return { ok: engine.resolvePlan({ proposed_commands: proposed }, state, { isDirector: true, serverAuthoritativeCombat: true, allowedActorIds: ids }).events.length }
    }
    if (f === 'planHeroCombatCommand') {
      const command = { ...o.ok.command, campaign_id: 'T2', command_id: 't2:1' }
      return { ok: resolveCommand(command, state, { diceService: fixedDice(10), context: { serverAuthoritativeCombat: true, allowedActorIds: [String(command.actor_id)] } }).events.length }
    }
  } catch (error) {
    return failure(error)
  }
  return undefined
}

async function call(source, f, args) {
  const input = clone(args)
  const o = await outcome(() => FUNCTIONS[f](clone(input)))
  const accept = acceptance(f, clone(input[0]), o)
  const added = pushCase(source, f, refArgs(f, input), o)
  if (added && accept) cases.at(-1).accept = accept
  return added
}

// --- 1. записи тестов JS -----------------------------------------------------------

const TEST_FILES = [
  'ally-attack-reactions', 'free-action', 'free-text-attack-weapon', 'large-creature-approach', 'orchestration-roles',
  'party-tactics-arena', 'party-tactics-stabilize', 'party-tactics', 'resistance-ruleset-callers', 'rest-mechanics',
  'scenario-attention', 'scenario-knight', 'scenario-progression', 'spell-by-words', 'turn-undead', 'wild-shape',
]
const TEST_CAP = Number(process.env.SK_T2_TEST_CAP ?? 120)
const recordDir = mkdtempSync(join(tmpdir(), 't2-record-'))
const testSummary = {}
for (const name of TEST_FILES) {
  const out = join(recordDir, `${name}.json`)
  try {
    execFileSync(process.execPath, ['--import', pathToFileURL(join(HERE, 'record', 'register.mjs')).href, join(ROOT, 'test', `${name}.test.mjs`)], {
      cwd: ROOT, env: { ...process.env, T2_RECORD_OUT: out, ROUTERAI_API_KEY: '', SK_NODE_MODULES_FROM: process.env.SK_NODE_MODULES_FROM ?? 'C:/Users/anton/PycharmProjects/Dnd' }, stdio: 'ignore', timeout: 900_000,
    })
  } catch { /* упавший тест JS всё равно оставляет записи */ }
  if (!existsSync(out)) continue
  const records = JSON.parse(readFileSync(out, 'utf8'))
  let taken = 0
  for (const record of records) {
    if (taken >= TEST_CAP) break
    // Запись сделана тем же JS; здесь только ссылка на состояние и дедупликация.
    if (pushCase(`test:${name}`, record.f, refArgs(record.f, record.a), record.o)) taken += 1
  }
  testSummary[name] = `${taken}/${records.length}`
}
rmSync(recordDir, { recursive: true, force: true })

// --- 2. корпус: боевые состояния ---------------------------------------------------

const heroClass = (hero) => String(hero?.characterClass ?? hero?.class_id ?? hero?.class ?? '?')
const currentOf = (state) => {
  const combat = state?.mechanics?.combat
  return combat?.initiative?.[Number(combat?.active_index)]?.actor_id
}
const heroTurn = []
const reactionTurn = []
const otherTurn = []
const calm = []
if (!existsSync(corpusDir)) throw new Error(`нет корпуса в ${corpusDir}`)
const stateDir = join(corpusDir, 'states')
for (const name of readdirSync(stateDir).sort()) {
  const path = join(stateDir, name)
  if (statSync(path).size > 150_000) continue
  let state
  try { state = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
  const combat = state?.mechanics?.combat
  if (!combat?.active) {
    if ((state.players ?? []).length && calm.length < 400) calm.push(state)
    continue
  }
  const window = combat.reaction_window
  if (window && (state.players ?? []).some((player) => String(player.id) === String(window.actor_id))) {
    reactionTurn.push(state)
    continue
  }
  const current = currentOf(state)
  const hero = (state.players ?? []).find((player) => String(player.id) === String(current))
  if (hero) heroTurn.push({ state, hero })
  else if (otherTurn.length < 200) otherTurn.push(state)
}

// Отбор героев по классу и уровню: не больше `PER_BUCKET` на корзину.
const PER_BUCKET = Number(process.env.SK_T2_PER_BUCKET ?? 8)
const HERO_TOTAL = Number(process.env.SK_T2_HERO_TOTAL ?? 360)
const buckets = new Map()
for (const entry of heroTurn) {
  const key = `${heroClass(entry.hero)}:${Number(entry.hero.level) || 1}:${(entry.state.enemies ?? []).length > 2 ? 'many' : 'few'}`
  if (!buckets.has(key)) buckets.set(key, [])
  buckets.get(key).push(entry)
}
// По кругу через корзины: каждый класс и уровень попадает в отбор раньше,
// чем вторая выборка из самой населённой корзины.
const picks = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, list]) => {
  const step = Math.max(1, Math.floor(list.length / PER_BUCKET))
  const taken = []
  for (let index = 0; index < list.length && taken.length < PER_BUCKET; index += step) taken.push(list[index])
  return taken
})
const chosen = []
for (let round = 0; round < PER_BUCKET && chosen.length < HERO_TOTAL; round += 1) {
  for (const list of picks) if (round < list.length && chosen.length < HERO_TOTAL) chosen.push(list[round])
}
const classSummary = {}
for (const { hero } of chosen) classSummary[heroClass(hero)] = (classSummary[heroClass(hero)] ?? 0) + 1

const POTION = { id: 'gen-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 1, type: 'consumable' }

/** Синтетические варианты состояния хода героя. */
function variants(state, heroId) {
  const out = []
  const at = (copy) => copy.players.find((player) => String(player.id) === String(heroId))
  {
    // Тяжело ранен и с зельем.
    const copy = clone(state)
    const me = at(copy)
    me.hp = 1
    me.inventory = [...(me.inventory ?? []), POTION]
    out.push(copy)
  }
  {
    // Союзник упал, зелье у героя; спасброски от смерти идут.
    const copy = clone(state)
    const ally = copy.players.find((player) => String(player.id) !== String(heroId))
    if (ally) {
      ally.hp = 0
      at(copy).inventory = [...(at(copy).inventory ?? []), POTION]
      copy.mechanics.death = { ...(copy.mechanics.death ?? {}), saving_throws: { ...(copy.mechanics.death?.saving_throws ?? {}), [ally.id]: { successes: 0, failures: 1 } } }
      out.push(copy)
    }
  }
  {
    // Сбит с ног.
    const copy = clone(state)
    copy.mechanics.conditions = { ...(copy.mechanics.conditions ?? {}), [heroId]: [...(copy.mechanics.conditions?.[heroId] ?? []), { id: 'prone' }] }
    out.push(copy)
  }
  {
    // Действие потрачено, удары остались или нет.
    const copy = clone(state)
    const economy = copy.mechanics.combat.action_economy ?? (copy.mechanics.combat.action_economy = {})
    economy[heroId] = { ...(economy[heroId] ?? {}), action: false, attacks_used: chance(0.5) ? 1 : 0, attacks_allowed: 2, bonus_action: chance(0.5) }
    out.push(copy)
  }
  {
    // Проекция игрока: хиты врагов скрыты.
    const copy = clone(state)
    for (const enemy of copy.enemies ?? []) {
      if (chance(0.7)) {
        delete enemy.hp
        delete enemy.maxHp
      }
    }
    out.push(copy)
  }
  {
    // Отход уже сделан, рядом враг без реакции.
    const copy = clone(state)
    copy.mechanics.conditions = { ...(copy.mechanics.conditions ?? {}), [heroId]: [{ id: pick(['disengaged', 'invisible', 'reckless', 'raging', 'searing-smite-flames']) }] }
    out.push(copy)
  }
  return out
}

const corpusSummary = { heroTurn: 0, variants: 0, reaction: 0, other: 0 }
for (const { state, hero } of chosen) {
  const id = String(hero.id)
  await call('corpus:hero', 'planHeroCombatCommand', [state, id])
  await call('corpus:hero', 'planHeroTurn', [state, id])
  await call('corpus:hero', 'healingTargetFor', [state, id])
  corpusSummary.heroTurn += 1
  // Другой герой того же состояния — «сейчас ход другого участника».
  const other = (state.players ?? []).find((player) => String(player.id) !== id)
  if (other && chance(0.3)) await call('corpus:hero', 'planHeroCombatCommand', [state, String(other.id)])
  if (chance(0.35)) {
    for (const variant of variants(state, id)) {
      await call('corpus:variant', 'planHeroCombatCommand', [variant, id])
      if (chance(0.5)) await call('corpus:variant', 'planHeroTurn', [variant, id])
      corpusSummary.variants += 1
    }
  }
}
for (const state of reactionTurn) {
  const window = state.mechanics.combat.reaction_window
  await call('corpus:reaction', 'planHeroCombatCommand', [state, String(window.actor_id)])
  await call('corpus:reaction', 'planHeroReaction', [state])
  // Окно, переданное явно, с другим набором действий.
  const offered = ['opportunity-attack', 'cast:shield', 'uncanny-dodge', 'parry', 'riposte', 'cast:silvery-barbs', 'cast:counterspell', 'indomitable', 'decline-reaction', 'fighter-zaschita']
  const altered = { ...window, action_ids: offered.filter(() => chance(0.4)), damage: chance(0.5) ? { applied_amount: int(30), temporary_hp_absorbed: int(3), damage_type: pick(['fire', 'cold', 'slashing']) } : window.damage }
  await call('corpus:reaction', 'planHeroReaction', [state, altered])
  const copy = clone(state)
  copy.mechanics.combat.reaction_window = altered
  await call('corpus:reaction', 'planHeroCombatCommand', [copy, String(window.actor_id)])
  corpusSummary.reaction += 1
}
for (const state of otherTurn.slice(0, 60)) {
  const hero = (state.players ?? [])[0]
  if (!hero) continue
  await call('corpus:other', 'planHeroCombatCommand', [state, String(hero.id)])
  await call('corpus:other', 'planHeroTurn', [state, String(hero.id)])
  await call('corpus:other', 'planHeroReaction', [state, null])
  corpusSummary.other += 1
}

// --- 3. заявки createPlan ----------------------------------------------------------

// Ключи прототипа ('toString', 'constructor') сюда не входят: в JS они дают функцию
// вместо способности — в Rust это неизвестный подход (отчёт, «Замечено в JS»).
const APPROACHES = ['strength', 'stealth', 'arcana', 'investigation', 'perception', 'survival', 'persuasion', 'intimidation', 'constitution', '', 7, null, ['stealth']]
const WAIT_TEXTS = ['ждём до полуночи', 'подождём рассвета', 'ждём темноты', 'дождёмся вечера', 'ждём полудня', 'ждём', 'караулим до утра', 'пережидаем ночь']
const REST_TEXTS = ['отдыхаем', 'долгий отдых', 'продолжительный отдых', 'short rest', 'long rest', undefined]
const RETRIEVED = [
  null,
  { results: [], confidence: 1 },
  { results: [{ rule_id: 'srd_5_2_1:combat:attack-roll' }, { rule_id: 'srd_5_2_1:checks:ability-check' }, { rule_id: '' }, { rule_id: 'x:y' }], confidence: 0.8 },
  { results: Array.from({ length: 8 }, (_, i) => ({ rule_id: `srd_5_2_1:test:${i}` })), confidence: 0.3 },
  { results: 'нет', confidence: '0.2' },
  { confidence: null },
  { results: [null], confidence: 1 },
]
function intentsFor(state, combat) {
  const hero = (state.players ?? [])[0]
  const enemy = (state.enemies ?? [])[0]
  const actor = hero ? String(hero.id) : 'nobody'
  const target = enemy ? String(enemy.id) : 'nobody'
  const spells = hero ? combatSpellsFor(hero, { rulesetId: state.ruleset_id }).map((spell) => spell.id) : []
  const list = [
    { intent: 'approach_attack', actor_id: actor, targets: [target], raw_message: 'подхожу и бью', confidence: 0.9 },
    { intent: 'approach_attack', actor_id: actor, raw_message: 'подхожу' },
    { intent: 'compound_maneuver', actor_id: actor, targets: [target], raw_message: pick(['прыгаю с разбегом и бью', 'прыгаю на врага', 'раскачиваюсь на люстре и бью', 'для разбега отхожу и прыгаю']) },
    { intent: 'attack', actor_id: actor, targets: [target], raw_message: 'бью', confidence: 0.7 },
    { intent: 'attack', actor_id: actor, raw_message: 'бью кого-нибудь' },
    { intent: 'ability_check', actor_id: actor, approach: pick(APPROACHES), difficulty_category: pick(['easy', 'medium', 'hard', ' HARD ', '999', undefined]), raw_message: pick(['осматриваю', 'тону в бурной реке', 'плыву']), confidence: 1 },
    { intent: 'saving_throw', actor_id: actor, approach: pick(APPROACHES), raw_message: 'спасбросок от удушья' },
    { intent: 'healing', actor_id: actor, raw_message: 'лечу друга' },
    { intent: 'end_turn', actor_id: actor },
    { intent: 'start_combat', actor_id: actor },
    { intent: 'end_combat', actor_id: actor },
    { intent: 'scenario_purse', actor_id: actor },
    { intent: 'scenario_informant', actor_id: actor, scenario_informant: pick([{ informant_id: 'inf-1', choice: 'turn' }, { informant_id: 'inf-1', choice: 'expose' }, 'turn', null]) },
    { intent: 'scenario_armory', actor_id: actor, scenario_armory: pick([{ catalog_id: 'srd_5_2_1:longsword' }, {}, null]) },
    { intent: 'scenario_treaty', actor_id: actor },
    { intent: 'scenario_knight', actor_id: actor, scenario_knight: pick([{ action: 'release', skill: 'religion' }, { action: 'return' }, null]) },
    { intent: 'wait', actor_id: actor, raw_message: pick(WAIT_TEXTS) },
    { intent: 'rest', actor_id: actor, raw_message: pick(REST_TEXTS) },
    { intent: 'mystery', actor_id: actor, raw_message: 'танцую' },
    { intent: 'attack', requires_clarification: true, missing_information: ['цель'] },
  ]
  for (const spell of [...spells.slice(0, 3), pick(spells) ?? 'fire-bolt', 'fireball', 'unknown-spell', '']) {
    list.push({ intent: 'cast_spell', actor_id: actor, spell_id: spell, targets: chance(0.7) ? [target] : [], knock_out: chance(0.2), raw_message: 'колдую' })
  }
  if (combat) list.push({ intent: 'wait', actor_id: actor, raw_message: 'ждём до полуночи' })
  return list
}
const planStates = [...chosen.slice(0, 120).map(({ state }) => state), ...calm.slice(0, 120)]
let planCount = 0
for (const state of planStates) {
  for (const intent of intentsFor(state, Boolean(state?.mechanics?.combat?.active))) {
    if (await call('plan', 'createPlan', [{ intent, state, retrievedRules: pick(RETRIEVED) }])) planCount += 1
  }
  // Сложность от опасности героя.
  const hero = (state.players ?? [])[0]
  if (hero) {
    const copy = clone(state)
    copy.mechanics = copy.mechanics ?? {}
    copy.mechanics.hazards = { [hero.id]: [{ escapeDifficulty: pick([8, 12, 18, null, '14', 'x']) }] }
    await call('plan', 'difficultyCategoryFor', [{ actor_id: hero.id, raw_message: 'выбираюсь' }, copy])
    await call('plan', 'createPlan', [{ intent: { intent: 'ability_check', actor_id: hero.id, approach: 'strength', raw_message: 'выбираюсь' }, state: copy, retrievedRules: null }])
  }
}
// Мусор заявки.
const junkState = calm[0] ?? planStates[0]
for (const intent of [null, {}, { intent: 5 }, { intent: 'attack', targets: 'abc', actor_id: 7 }, { intent: 'approach_attack', targets: null }, { intent: 'start_combat' },
  { intent: 'cast_spell', spell_id: null }, { intent: 'ability_check', approach: ['stealth'], difficultyCategory: 'EASY' }, { intent: 'rest', raw_message: null }, { intent: 'wait', raw_message: 42 }]) {
  await call('plan', 'createPlan', [{ intent, state: junkState, retrievedRules: pick(RETRIEVED) }])
}
for (const players of [[null], 'ab', { id: 1 }, [{ name: 'без ид' }, { id: '' }, { id: 5 }]]) {
  await call('plan', 'createPlan', [{ intent: { intent: 'start_combat', actor_id: 'x' }, state: { ...clone(junkState), players }, retrievedRules: null }])
}

// --- выход ---------------------------------------------------------------------------

const payload = { states, cases }
const gz = gzipSync(JSON.stringify(payload), { level: 9 })
writeFileSync(join(HERE, 't2.json.gz'), gz)
const counts = {}
for (const entry of cases) counts[entry.f] = (counts[entry.f] ?? 0) + 1
console.log(JSON.stringify({ states: states.length, cases: cases.length, counts, gzip: gz.length, tests: testSummary, classes: classSummary, corpus: corpusSummary, plans: planCount }, null, 1))
