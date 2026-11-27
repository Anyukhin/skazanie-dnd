import '../../../fixtures-env.mjs'
// Эталон `server/encounter-rewards.mjs`.
//
// - перехват настоящих вызовов: тесты модуля и его потребителей
//   (`test/encounter-reward*.test.mjs`, автономный цикл, финал сценария,
//   авторские NPC) в этом процессе через `module.registerHooks`;
// - корпус паритета (`tmp/corpus-v1`): состояния со встречей — как есть и
//   доведённые до победы (враги повержены, встреча завершена);
// - случайные встречи обеих редакций: стат-блоки SRD 5.2.1 и dnd.su 2014,
//   авторские NPC, мёртвые и живые участники, кошельки у предела, герои у
//   предела груза и 200 вещей, мусор старых сохранений.
// Каждая победа проходит цепочку движка: план → монеты → добыча → дележ →
// предусловия → применение события.
//
// Монеты бросаются внедрённым сервисом костей: аргумент `{ sequence }` —
// значения `SequenceDiceRng`, id бросков `coin-1…`, время неподвижное
// (`null` — сервис не передан).
//
//   node rust/crates/sk-character/fixtures/gen-encounter-rewards.mjs [каталог-корпуса]
import { registerHooks } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chooser, errorOf, fixtureWriter, mulberry32, sha256, viaJson } from './common.mjs'

const TARGET = 'server/encounter-rewards.mjs'
const NAMES = [
  'encounterCompletionStageKey', 'livingEncounterRewardRecipients', 'freezeEncounterOutcomePlan', 'frozenEncounterOutcomePlanFromEvent',
  'encounterCoinUnitsForXp', 'rollEncounterCoins', 'lootForEncounterOutcome', 'serverRewardForEncounter', 'assertEncounterRewardRecipients',
  'distributeEncounterRewards', 'assertEncounterDistributionPreconditions', 'applyEncounterRewardsDistribution', 'encounterRewardResponse',
]

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith(`/${TARGET}`)) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = NAMES.map((name) => `${name} = globalThis.__rewardsWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const captured = []
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g
const stable = new Map()
function stableIds(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value).replace(UUID, (id) => {
    if (!stable.has(id)) stable.set(id, `00000000-0000-4000-8000-${String(stable.size).padStart(12, '0')}`)
    return stable.get(id)
  }).replace(ISO, (time) => {
    if (!stable.has(time)) stable.set(time, new Date(Date.UTC(2026, 0, 1) + stable.size * 1000).toISOString())
    return stable.get(time)
  }))
}
let depth = 0
let recording = true
globalThis.__rewardsWrap = (name, fn) => function recorded(...args) {
  if (!recording || depth > 0) return fn(...args)
  depth += 1
  try {
    try {
      // Сервис костей не сериализуется: монеты повторяются своей последовательностью.
      const plain = name === 'rollEncounterCoins' ? [stableIds(viaJson(args[0]))] : args.map((arg) => stableIds(arg === undefined ? undefined : viaJson(arg)))
      captured.push({ name, args: plain })
    } catch {
      // Несериализуемый вход тестов (циклы, функции) не пишется.
    }
    return fn(...args)
  } finally {
    depth -= 1
  }
}

const rewards = await import('../../../../server/encounter-rewards.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const assembler = await import('../../../../server/encounter-assembler.mjs')
const { loadDndsu2014Content } = await import('../../../../server/dndsu-2014-content.mjs')
const itemCatalog = await import('../../../../server/item-catalog.mjs')
const lootTables = await import('../../../../server/loot-tables.mjs')

for (const file of ['encounter-reward', 'encounter-rewards-v2', 'encounter-rewards-ruleset', 'authored-world-npcs', 'scenario-finale', 'autonomous-campaign']) {
  await import(`../../../../test/${file}.test.mjs`)
}

// ---------------------------------------------------------------------------

const pick = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key]
  return out
}
const ITEM_FIELDS = ['id', 'catalog_id', 'weight', 'quantity', 'equipped', 'name', 'type']
function stripPlayer(player) {
  if (!player || typeof player !== 'object' || Array.isArray(player)) return player
  const out = pick(player, ['id', 'actor_id', 'currency', 'abilities', 'hp', 'name'])
  if (Object.hasOwn(player, 'inventory')) out.inventory = Array.isArray(player.inventory) ? player.inventory.map((item) => pick(item, ITEM_FIELDS)) : player.inventory
  if (out.abilities && typeof out.abilities === 'object' && !Array.isArray(out.abilities)) out.abilities = pick(out.abilities, ['str'])
  return out
}
const stripEnemy = (enemy) => pick(enemy, ['id', 'actor_id', 'alive', 'hp', 'hit_points', 'stat_block_id', 'origin', 'provenance', 'name'])
/** Состояние без того, чего encounter-rewards не читает. */
function stripState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = pick(state, ['ruleset_id', 'rulesetId', 'partyMemberIds', 'npc_world'])
  if (Array.isArray(state.players)) out.players = state.players.map(stripPlayer)
  else if (Object.hasOwn(state, 'players')) out.players = state.players
  if (Array.isArray(state.enemies)) out.enemies = state.enemies.map(stripEnemy)
  else if (Object.hasOwn(state, 'enemies')) out.enemies = state.enemies
  if (out.npc_world && typeof out.npc_world === 'object' && !Array.isArray(out.npc_world)) out.npc_world = pick(out.npc_world, ['profiles'])
  if (Object.hasOwn(state, 'mechanics')) {
    const mechanics = state.mechanics
    if (!mechanics || typeof mechanics !== 'object' || Array.isArray(mechanics)) out.mechanics = mechanics
    else {
      out.mechanics = {}
      if (Object.hasOwn(mechanics, 'encounter')) out.mechanics.encounter = mechanics.encounter
      if (Object.hasOwn(mechanics, 'death')) out.mechanics.death = pick(mechanics.death, ['heroes'])
    }
  }
  return out
}

function diceFor(spec) {
  if (spec === null) return undefined
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(spec.sequence), idFactory: () => `coin-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}

/** Вызов по имени с аргументами эталона. */
const calls = {
  ...Object.fromEntries(NAMES.map((name) => [name, (...args) => rewards[name](...args)])),
  rollEncounterCoins: (plan, spec) => rewards.rollEncounterCoins(plan, diceFor(spec)),
  applyEncounterRewardsDistribution: (state, event) => {
    const ids = rewards.applyEncounterRewardsDistribution(state, event)
    return { ids, state }
  },
}
const STATE_ARG = new Set(['livingEncounterRewardRecipients', 'freezeEncounterOutcomePlan', 'serverRewardForEncounter', 'assertEncounterRewardRecipients', 'distributeEncounterRewards', 'assertEncounterDistributionPreconditions', 'applyEncounterRewardsDistribution'])

const writer = fixtureWriter()
const CAPS = { applyEncounterRewardsDistribution: 150, distributeEncounterRewards: 150, freezeEncounterOutcomePlan: 420, serverRewardForEncounter: 200, assertEncounterDistributionPreconditions: 140, encounterRewardResponse: 90, frozenEncounterOutcomePlanFromEvent: 120, livingEncounterRewardRecipients: 300, encounterCompletionStageKey: 300 }
const perOutcome = (key) => (key.endsWith(':ok') ? 900 : 120)
const outcomeText = (name, args) => {
  try {
    let value = calls[name](...args.map(viaJson))
    if (name === 'applyEncounterRewardsDistribution') value = { ...value, state: stripState(value.state) }
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify(errorOf(error))
  }
}
let differ = 0
function run(name, args, options = {}) {
  let used = args
  if (STATE_ARG.has(name) && args[0] && typeof args[0] === 'object') {
    const stripped = [stripState(args[0]), ...args.slice(1)]
    if (outcomeText(name, args) === outcomeText(name, stripped)) used = stripped
    else differ += 1
  }
  return writer.call(name, calls[name], used, { perOutcome, cap: CAPS[name] ?? 500, ...options })
}

const random = mulberry32(0xe4c0)
const c = chooser(random)
const sequence = () => ({ sequence: Array.from({ length: 13 }, () => (c.chance(0.98) ? c.int(1, 6) : c.pick([0, 7]))) })

/** Цепочка движка: план → монеты → добыча → дележ → предусловия → событие. */
function chain(state, outcome) {
  const plan = run('freezeEncounterOutcomePlan', [state, outcome]).value
  run('serverRewardForEncounter', [state, outcome])
  run('livingEncounterRewardRecipients', [state])
  if (!plan) return
  const event = { event_type: 'EncounterOutcomeFrozen', payload: { plan } }
  run('frozenEncounterOutcomePlanFromEvent', [event])
  const coins = run('rollEncounterCoins', [plan, c.chance(0.97) ? sequence() : null]).value
  const loot = run('lootForEncounterOutcome', [plan]).value
  run('assertEncounterRewardRecipients', [state, plan.recipients])
  for (const stage of ['outcome', 'xp', 'coins', 'distribution']) run('encounterCompletionStageKey', [plan.encounter_id, stage])
  if (!coins || !loot) return
  const distribution = run('distributeEncounterRewards', [state, { plan, coins, loot }]).value
  run('encounterRewardResponse', [{ plan, coins, loot, distribution }])
  if (!distribution) return
  run('assertEncounterDistributionPreconditions', [state, distribution])
  const applied = { event_type: 'EncounterRewardsDistributed', event_schema_version: 1, payload: distribution }
  const after = run('applyEncounterRewardsDistribution', [state, applied]).value
  if (after && c.chance(0.4)) {
    // Повтор того же события по уже применённому состоянию: id вещей заняты.
    run('applyEncounterRewardsDistribution', [after.state, applied])
    run('assertEncounterDistributionPreconditions', [after.state, distribution])
  }
  if (c.chance(0.3)) {
    const variant = structuredClone(applied)
    const roll = random()
    if (roll < 0.2) variant.event_schema_version = 2
    else if (roll < 0.35) variant.payload.schema_version = '1'
    else if (roll < 0.5 && variant.payload.allocations[0]) variant.payload.allocations[0].coins_cp = c.pick([-1, 0.5, 'x', 9_000_000_001])
    else if (roll < 0.65 && variant.payload.allocations[0]) variant.payload.allocations[0].recipient_id = c.pick(['', 'stranger', null])
    else if (roll < 0.8) variant.payload.allocations = c.pick([[], 'x', null, [...variant.payload.allocations, ...variant.payload.allocations]])
    else if (variant.payload.allocations[0]) variant.payload.allocations[0].items = [{ id: '' }, null, { id: 'dup' }, { id: 'dup' }]
    run('applyEncounterRewardsDistribution', [state, variant])
    run('assertEncounterDistributionPreconditions', [state, variant.payload])
  }
}

// ---------------------------------------------------------------------------

const SRD_IDS = Object.keys(assembler.SRD_5_2_1_MONSTER_ALLOWLIST)
const DND_2014_IDS = (await loadDndsu2014Content()).monsters.map((monster) => String(monster.id))
const THEMES = ['goblinoids', 'undead', 'beasts', 'raiders', 'warband', 'vermin', 'ambush', 'crypt', 'cave', 'wilderness', 'generic', 'bogus', undefined]
const DIFFICULTIES = ['easy', 'medium', 'hard', 'deadly', 'bogus', undefined]
const HEAVY = Object.values(itemCatalog.ITEM_CATALOG).filter((entry) => Number(entry.weight) >= 20).map((entry) => entry.catalog_id)
const LIGHT = Object.values(itemCatalog.ITEM_CATALOG).filter((entry) => Number(entry.weight) > 0 && Number(entry.weight) < 3).map((entry) => entry.catalog_id)

function heroFor(id) {
  const hero = { id, hp: c.int(0, 30), currency: { copper: c.int(0, 50), silver: c.int(0, 50), gold: c.int(0, 500), platinum: c.int(0, 5) }, abilities: { str: c.int(3, 20) }, inventory: [] }
  const roll = random()
  if (roll < 0.1) hero.currency = { platinum: 8_999_990 }
  else if (roll < 0.15) hero.currency = c.pick([null, 'x', { gold: -5 }, { gold: 1.5 }])
  const load = random()
  if (load < 0.05) hero.inventory = Array.from({ length: c.int(197, 201) }, (_, index) => ({ id: `p${index}`, weight: 0 }))
  else if (load < 0.25) hero.inventory = Array.from({ length: c.int(1, 6) }, (_, index) => ({ id: `${id}-heavy-${index}`, catalog_id: c.pick(HEAVY), weight: c.int(20, 70), quantity: c.int(1, 2) }))
  else hero.inventory = Array.from({ length: c.int(0, 4) }, (_, index) => ({ id: `${id}-item-${index}`, catalog_id: c.pick(LIGHT), weight: c.pick([1, 2, 0.5, '3', 'x']), quantity: c.pick([1, 2, '1', 0]) }))
  if (c.chance(0.04)) hero.inventory = c.pick([null, 'x', {}])
  if (c.chance(0.04)) hero.abilities = c.pick([null, { str: 'x' }, {}])
  return hero
}

function enemyFor(id, statBlockId, xp) {
  const enemy = { id, stat_block_id: statBlockId, hp: 0, alive: false }
  const roll = random()
  if (roll < 0.02) Object.assign(enemy, { hp: 3, alive: true })
  else if (roll < 0.04) { delete enemy.hp; delete enemy.alive }
  else if (roll < 0.05) Object.assign(enemy, { hp: 'NaN', alive: true })
  else if (roll < 0.1) Object.assign(enemy, { hit_points: 0, alive: undefined, hp: undefined })
  if (c.chance(0.7)) enemy.provenance = { xp: c.chance(0.95) ? xp : xp + 1 }
  if (c.chance(0.1)) enemy.xp = Number.MAX_SAFE_INTEGER
  return enemy
}

function encounterState(index) {
  const rulesetId = c.chance(0.94) ? c.pick(['srd_5_2_1', 'dnd_5e_2014', 'dnd_5e_2014', undefined]) : c.pick(['bogus', 'constructor', '__proto__'])
  const pool = rulesetId === 'dnd_5e_2014' ? DND_2014_IDS : SRD_IDS
  const count = c.chance(0.93) ? c.int(1, 6) : c.pick([0, 12, 13])
  const enemies = Array.from({ length: count }, (_, position) => {
    const statBlockId = c.chance(0.92) ? c.pick(pool) : c.pick(['srd_5_2_1:not-a-monster', 'dnd_5e_2014:goblin', 'srd_5_2_1:goblin-warrior', 'authored:bandit', ''])
    const xp = rulesetId === 'dnd_5e_2014' ? Number((DND_2014_XP.get(statBlockId)) ?? 0) : Number(assembler.SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]?.xp ?? 0)
    return enemyFor(`enemy-${index}-${position + 1}`, statBlockId, xp)
  })
  const party = Array.from({ length: c.int(1, 5) }, (_, position) => `hero-${index}-${position + 1}`)
  const players = party.map(heroFor)
  const deaths = Object.fromEntries(party.filter(() => c.chance(0.15)).map((id) => [id, { status: c.pick(['dead', 'stable', 'dying']) }]))
  const encounterId = c.chance(0.95) ? `encounter-${index}` : c.pick(['', '  ', 'x'.repeat(200)])
  const outcome = c.chance(0.85) ? 'enemies_defeated' : c.pick(['fled', 'party_defeated', 'retreated', ''])
  const state = {
    ...(rulesetId === undefined ? {} : { ruleset_id: rulesetId }),
    partyMemberIds: c.chance(0.95) ? [...party, ...(c.chance(0.1) ? [party[0], 'ghost', 7] : [])] : c.pick([undefined, []]),
    players,
    enemies: [...enemies, ...(c.chance(0.2) ? [enemyFor('outsider', c.pick(SRD_IDS), 50)] : [])],
    mechanics: {
      death: { heroes: deaths },
      encounter: {
        id: encounterId,
        encounter_id: encounterId,
        status: c.chance(0.95) ? 'ended' : 'active',
        outcome,
        theme: c.pick(THEMES),
        difficulty: c.pick(DIFFICULTIES),
        enemy_ids: enemies.map((enemy) => enemy.id),
        enemies: enemies.map((enemy) => ({ id: enemy.id, stat_block_id: enemy.stat_block_id })),
      },
    },
  }
  const encounter = state.mechanics.encounter
  const tamper = random()
  if (tamper < 0.04 && encounter.enemy_ids.length) encounter.enemy_ids.push(encounter.enemy_ids[0])
  else if (tamper < 0.07 && encounter.enemies.length) encounter.enemies[0].stat_block_id = c.pick(SRD_IDS)
  else if (tamper < 0.1) encounter.enemies.push({ id: 'phantom', stat_block_id: c.pick(SRD_IDS) })
  else if (tamper < 0.12) state.enemies = c.pick([null, 'x', []])
  else if (tamper < 0.14) state.players = c.pick([null, [null], 'x'])
  return { state, outcome: c.chance(0.85) ? outcome : c.pick([undefined, null, 'party_defeated', ' enemies_defeated '].filter((value) => value !== undefined || true)) }
}
const DND_2014_XP = new Map((await loadDndsu2014Content()).monsters.map((monster) => [String(monster.id), Number(monster.xp)]))

// ---------------------------------------------------------------------------

let written = false
process.on('beforeExit', () => {
  if (written) return
  written = true
  recording = false
  const captureCount = captured.length
  for (const entry of captured) {
    const args = entry.name === 'rollEncounterCoins' ? [entry.args[0], sequence()] : entry.args
    run(entry.name, args, { perOutcome: (key) => (key.endsWith(':ok') ? 300 : 80) })
    if (entry.name === 'freezeEncounterOutcomePlan' && c.chance(0.5)) chain(entry.args[0], entry.args[1])
  }

  // --- корпус ---------------------------------------------------------------
  const corpusDir = process.argv[2] ?? process.env.SK_CHARACTER_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
  let corpusStates = 0
  if (existsSync(join(corpusDir, 'states'))) {
    const seen = new Set()
    const files = readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()
    outer: for (const file of files) {
      for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
        const hash = /"state":"([0-9a-f]{64})"/.exec(line)?.[1]
        if (!hash || seen.has(hash)) continue
        seen.add(hash)
        const statePath = join(corpusDir, 'states', `${hash}.json`)
        if (!existsSync(statePath)) continue
        const text = readFileSync(statePath, 'utf8')
        if (!text.includes('"encounter":{')) continue
        const state = stripState(JSON.parse(text))
        const encounter = state.mechanics?.encounter
        if (!encounter || typeof encounter !== 'object' || !encounter.id) continue
        corpusStates += 1
        chain(state, undefined)
        // Та же встреча, доведённая до победы.
        const won = structuredClone(state)
        won.mechanics.encounter = { ...encounter, status: 'ended', outcome: 'enemies_defeated' }
        const enemyIds = new Set((encounter.enemy_ids ?? []).map(String))
        won.enemies = (won.enemies ?? []).map((enemy) => (enemyIds.has(String(enemy?.id)) ? { ...enemy, hp: 0, alive: false } : enemy))
        chain(won, 'enemies_defeated')
        if (corpusStates >= 40) break outer
      }
    }
  }

  // --- случайные встречи ----------------------------------------------------
  for (const value of [undefined, null, 0, 1, 24, 25, 26, 49.9, -5, 100_000, 100_001, Infinity, -Infinity, 'NaN', '450', Number.MAX_SAFE_INTEGER, true, [50]]) run('encounterCoinUnitsForXp', [value])
  for (const id of [undefined, null, '', '  enc-1  ', 'x'.repeat(170), 5]) {
    for (const stage of ['outcome', 'xp', 'coins', 'loot', 'distribution', 'transition', 'bogus', undefined]) run('encounterCompletionStageKey', [id, stage])
  }
  for (const event of [undefined, null, {}, { payload: {} }, { payload: { plan: { version: 'old' } } }, { payload: { plan: 'x' } }]) run('frozenEncounterOutcomePlanFromEvent', [event])
  for (const plan of [undefined, null, {}, { rewards_eligible: false, encounter_id: '  e  ' }, { rewards_eligible: true, enemies: [] }, { rewards_eligible: true }, { rewards_eligible: 1, enemies: [{ enemy_id: 'b', xp: 50 }, { enemy_id: 'a', xp: 'x' }], encounter_id: 'e' }]) {
    run('rollEncounterCoins', [plan, sequence()])
    run('rollEncounterCoins', [plan, null])
    run('lootForEncounterOutcome', [plan])
  }
  run('rollEncounterCoins', [{ rewards_eligible: true, encounter_id: 'cap', enemies: Array.from({ length: 12 }, (_, index) => ({ enemy_id: `e-${index}`, stat_block_id: 'x', xp: Number.MAX_SAFE_INTEGER })) }, { sequence: Array(12).fill(6) }])
  for (const response of [undefined, {}, { plan: { recipients: 'ab', total_xp: -5 }, coins: { total_cp: 'x' } }, { plan: { encounter_id: null, outcome: null } }]) run('encounterRewardResponse', [response])
  for (const loot of [[{ catalog_id: LIGHT[0], quantity: 11, weight: 1 }], [{ catalog_id: LIGHT[0], quantity: 2.5, weight: 1 }], [{ catalog_id: HEAVY[0], quantity: 1, weight: 61 }], [null], 'x', [{ catalog_id: LIGHT[0] }, { catalog_id: LIGHT[1] }, { catalog_id: LIGHT[2] }, { catalog_id: LIGHT[3] }]]) {
    const { state } = encounterState(9000)
    run('distributeEncounterRewards', [state, { plan: { encounter_id: 'bounds', recipients: (state.players ?? []).map?.((player) => player?.id) ?? [], total_xp: 10 }, coins: { total_cp: 5 }, loot }])
  }
  const magic = lootTables.serverEncounterMagicLoot({ encounterId: 'magic-twice', totalXp: 100_000 })
  if (magic.length) run('distributeEncounterRewards', [{ players: [heroFor('m')] }, { plan: { encounter_id: 'magic-twice', recipients: ['m'], total_xp: 0 }, coins: { total_cp: 0 }, loot: [...magic, ...magic] }])

  for (let index = 0; index < 240; index += 1) {
    const { state, outcome } = encounterState(index)
    chain(state, outcome)
  }

  console.error(`перехвачено вызовов ${captureCount}; состояний корпуса ${corpusStates}; урезанный вход дал другой исход: ${differ}`)
  writer.write(new URL('encounter-rewards.json', import.meta.url))
  console.error(`sha256 эталона ${sha256(readFileSync(new URL('encounter-rewards.json', import.meta.url), 'utf8')).slice(0, 12)}`)
})
