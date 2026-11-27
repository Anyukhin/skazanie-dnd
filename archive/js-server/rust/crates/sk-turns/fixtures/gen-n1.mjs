import '../../../fixtures-env.mjs'
// Эталоны задачи Н1 (`sk-turns`): `server/npc-turn-scheduler.mjs` и
// `server/combat-turn-coordinator.mjs`.
//
//   node rust/crates/sk-turns/fixtures/gen-n1.mjs [каталог корпуса]
//
// Источники случаев:
// 1. «тесты» — вызовы `planNpcTurn`, `planLegendaryAction` и чистых функций
//    координатора, записанные при прогоне тестов JS (`capture-n1.mjs`); выход
//    пересчитывается здесь на JSON-копии аргументов;
// 2. «корпус» — боевые состояния `tmp/corpus-v1` (все враги корпуса по
//    корзинам «имя × повадки») и их варианты: раненый, лежащий, изгнанный,
//    замедленный, с потраченным действием, с зельем/ядом/склянкой, в тумане;
// 3. «бестиарий» — каждый монстр 2014 и SRD на малой арене, рядом и далеко;
// 4. «прогоны» — `runNpcTurnScheduler` на `FileEventStore` (кости — mulberry32
//    по сиду случая, id событий и часы — детерминированные), с моралью: без
//    контроллера, `NpcMoraleAgent` без модели, с записывающей заглушкой модели
//    и заглушкой контроллера; «пассивные герои» — бой до конца, герои только
//    завершают ход;
// 5. мусор.
//
// Каждый план исполняется движком JS (`resolvePlan`, те же кости): Rust
// сверяет число и хеш событий и бросков — свойство «план принимается движком».
//
// Состояния хранятся один раз: верхние поля — в таблице `blobs` по хешу,
// состояние — список ключей и индексов. Файл — gzip (`n1.json.gz`).
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/npc-turn-scheduler.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: `${source}\nexport { targetCandidates as __targetCandidates, publicTacticFor as __publicTacticFor }\n` }
  },
})

const S = await import('../../../../server/npc-turn-scheduler.mjs')
const C = await import('../../../../server/combat-turn-coordinator.mjs')
const { RulesEngine, normalizeCampaignState, findActor, applyGameEvent, validateCommand } = await import('../../../../server/rules-engine.mjs')
const { DiceService } = await import('../../../../server/dice-service.mjs')
const { FileEventStore } = await import('../../../../server/event-store.mjs')
const { AuthoritativeExecutor } = await import('../../../../server/authoritative-executor.mjs')
const { NpcMoraleAgent } = await import('../../../../server/npc-controller.mjs')
const { isBossActor } = await import('../../../../server/legendary-actions.mjs')
const { enemyFrom2014 } = await import('../../../../server/combat-lab-monsters.mjs')
const { SRD_5_2_1_MONSTER_ALLOWLIST } = await import('../../../../server/encounter-assembler.mjs')

const corpusDir = process.argv[2] ?? process.env.SK_N1_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const FIXED_MS = Date.parse('2026-08-01T10:00:00.000Z')
const FIXED_NOW = '2026-08-01T10:00:00.000Z'

let seed = 0x000a_11ce
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
const sha = (value) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
/**
 * Хеш состояния без порядка ключей: хранилище Rust всегда выносит карту сцены
 * (`scene.map`) и возвращает `cells` после неё, а `FileEventStore` без
 * `mapStore` — нет; порядок ключей сцены — дело хранилища, не планировщика.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
const csha = (value) => sha(canonical(clone(value)))

/** Кости случая: mulberry32 от сида, `min + floor(r * (max - min + 1))`. */
function seededRng(caseSeed) {
  let state = caseSeed >>> 0
  return {
    randint(minimum, maximum) {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296
      return minimum + Math.floor(r * (maximum - minimum + 1))
    },
  }
}
function dice(caseSeed) {
  let serial = 0
  return new DiceService({ rng: seededRng(caseSeed), idFactory: () => `n1-roll-${++serial}`, now: () => FIXED_NOW })
}

function failure(error) {
  if (error?.name === 'RulesValidationError') return { err: [error.code ?? null, String(error.message)] }
  return { fault: String(error?.name ?? 'Error'), code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) }
}
function attempt(run) {
  try {
    return { ok: clone(run()) }
  } catch (error) {
    return failure(error)
  }
}

// --- состояния --------------------------------------------------------------------

const blobs = []
const blobIndex = new Map()
const states = []
const stateIndex = new Map()
function addBlob(value) {
  const key = sha(value)
  if (!blobIndex.has(key)) {
    blobIndex.set(key, blobs.length)
    blobs.push(value)
  }
  return blobIndex.get(key)
}
function addState(state) {
  const key = sha(state)
  if (stateIndex.has(key)) return stateIndex.get(key)
  const k = []
  const v = []
  for (const [name, value] of Object.entries(state)) {
    k.push(name)
    v.push(addBlob(value))
  }
  stateIndex.set(key, states.length)
  states.push({ k, v })
  return stateIndex.get(key)
}

// --- планы ------------------------------------------------------------------------

const plans = []
const planKeys = new Set()
const legendary = []
const coordinator = []
const runs = []
let caseSerial = 0

function candidateView(candidate) {
  return clone({
    actor_id: String(candidate.actor?.id ?? candidate.actor?.actor_id ?? ''),
    path: candidate.path ?? null,
    inRange: candidate.inRange,
    blockedShot: candidate.blockedShot,
    coverLevel: candidate.coverLevel,
    distance: candidate.distance,
    profile_id: candidate.profile?.id,
    score: candidate.score,
  })
}

function accept(state, commands, caseSeed) {
  try {
    const engine = new RulesEngine({ diceService: dice(caseSeed) })
    const proposed = commands.map((command, index) => ({ ...command, server_authoritative: true, campaign_id: 'N1', command_id: `n1:${index + 1}` }))
    const resolved = engine.resolvePlan({ proposed_commands: proposed }, state, { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true, actor_ids: [] })
    return { ok: { n: resolved.events.length, types: resolved.events.map((event) => event.event_type), events: sha(resolved.events), rolls: sha(resolved.rolls), state: sha(resolved.state) } }
  } catch (error) {
    return failure(error)
  }
}

function validateFirst(state, command) {
  try {
    validateCommand({ ...command, command_id: 'n1-validate', server_authoritative: true }, state, { serverAuthoritativeCombat: true, isNpcScheduler: true, allowedActorIds: [String(command.actor_id)] })
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

function planCase(source, rawState, enemyId, { acceptance = true } = {}) {
  const state = clone(rawState)
  const id = enemyId === undefined ? undefined : enemyId
  const key = sha([state, id])
  if (planKeys.has(key)) return null
  planKeys.add(key)
  const s = addState(state)
  const o = attempt(() => S.planNpcTurn(state, id))
  const entry = { src: source, s, id: String(id ?? ''), o }
  try {
    const normalized = normalizeCampaignState(clone(state))
    const enemy = findActor(normalized, id)
    if (enemy) {
      const candidates = S.__targetCandidates(normalized, enemy)
      const views = candidates.map(candidateView)
      entry.cand = views.slice(0, 6)
      entry.candN = views.length
      entry.candHash = sha(views)
      if (o.ok) entry.tactic = clone(S.__publicTacticFor(normalized, enemy, candidates[0], o.ok) ?? null)
    } else {
      entry.cand = null
    }
  } catch (error) {
    entry.cand = failure(error)
  }
  if (o.ok && acceptance && o.ok.length) {
    entry.seed = (++caseSerial * 7919 + 17) >>> 0
    entry.acc = accept(state, o.ok, entry.seed)
    entry.val = validateFirst(state, o.ok[0])
  }
  plans.push(entry)
  return entry
}

function legendaryCase(source, rawState, bossId) {
  const state = clone(rawState)
  legendary.push({ src: source, s: addState(state), id: String(bossId ?? ''), o: attempt(() => S.planLegendaryAction(state, bossId)) })
}

function coordinatorCase(source, f, args) {
  const copy = clone(args)
  const run = {
    activeTurnActorIds: () => C.activeTurnActorIds(copy[0]),
    turnActivityKey: () => C.turnActivityKey(copy[0]),
    combatTurnClock: () => C.combatTurnClock(copy[0], copy[1], copy[2] ?? undefined),
    combatTurnClockForState: () => C.combatTurnClockForState(copy[0], copy[1]),
  }[f]
  const o = attempt(run)
  const refs = clone(args)
  if (refs[0] && typeof refs[0] === 'object') refs[0] = { $state: addState(refs[0]) }
  coordinator.push({ src: source, f, a: refs, o })
}

// --- 1. вызовы тестов JS ------------------------------------------------------------

const TESTS = [
  'npc-turn-scheduler', 'combat-turn-coordinator', 'ally-passage', 'authored-world-npcs', 'bestiary-monster-actions', 'boss-mechanics',
  'combat-lab-monsters', 'downed-hero-occupies-cell', 'large-creature-approach', 'monster-recharge', 'npc-attack-from-fog', 'npc-equipment',
  'npc-planner-dash-and-distance', 'npc-planner-stop-cell', 'npc-spell-tactics-regression', 'npc-spent-action-regression', 'npc-tactics-cover',
  'parley', 'reaction-preferences', 'spell-review-condition-mismatches', 'spell-review-defenses-and-summons', 'spell-review-engine-mismatches',
  'spell-turn-relative-durations', 'summon-lesser-demons-hostile', 'surprise-round', 'turn-undead', 'web-walker', 'writers-conflict-characterization',
]
function captureTests() {
  const root = new URL('../../../../', import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'sk-n1-capture-'))
  const file = join(dir, 'capture.jsonl')
  const targets = {
    '/server/npc-turn-scheduler.mjs': ['planNpcTurn', 'planLegendaryAction'],
    '/server/combat-turn-coordinator.mjs': ['activeTurnActorIds', 'turnActivityKey', 'combatTurnClock', 'combatTurnClockForState'],
  }
  try {
    try {
      execFileSync(process.execPath, [
        '--import', new URL('./capture-n1.mjs', import.meta.url).href,
        '--test', '--test-isolation=none', '--test-reporter=dot',
        ...TESTS.map((name) => new URL(`test/${name}.test.mjs`, root).pathname.replace(/^\/([A-Za-z]:)/u, '$1')),
      ], {
        cwd: new URL('.', root),
        env: { ...process.env, ROUTERAI_API_KEY: '', SK_CAPTURE: file, SK_CAPTURE_TARGETS: JSON.stringify(targets), SK_CAPTURE_LIMIT: '600' },
        stdio: ['ignore', 'ignore', 'inherit'],
        maxBuffer: 1 << 30,
      })
    } catch (error) {
      console.warn(`захват: тесты завершились с ошибкой (${error.status ?? error.message})`)
    }
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const captured = captureTests()
const capturedSummary = {}
for (const record of captured) {
  const args = clone(record.args)
  for (const index of record.undef ?? []) args[index] = undefined
  const source = `test:${record.test}`
  capturedSummary[record.fn] = (capturedSummary[record.fn] ?? 0) + 1
  if (record.fn === 'planNpcTurn') planCase(source, args[0], args[1])
  else if (record.fn === 'planLegendaryAction') legendaryCase(source, args[0], args[1])
  else coordinatorCase(source, record.fn, args)
}
console.log('захвачено:', capturedSummary)

// --- 2. корпус ----------------------------------------------------------------------

const traitIds = (enemy) => (Array.isArray(enemy?.traits) ? enemy.traits : []).map((entry) => String(entry?.id ?? entry))
function signature(enemy, current) {
  const traits = traitIds(enemy)
  return [
    String(enemy.name ?? enemy.id).replace(/\s*\d+$/u, '').slice(0, 30),
    enemy.legendary ? 'L' : '', enemy.spellcasting ? 'S' : '', enemy.footprint?.size > 1 ? 'B' : '',
    (enemy.special_actions ?? []).length ? 'A' : '', traits.includes('multiattack') ? 'M' : '', traits.includes('keep-distance') ? 'K' : '',
    traits.includes('nimble-escape') ? 'N' : '', (enemy.loadout?.items ?? []).length ? 'I' : '', enemy.hostile_to_all ? 'H' : '',
    String(enemy.id) === String(current) ? 'T' : '',
  ].join('')
}
const corpusStates = []
const buckets = new Map()
const PER_BUCKET = Number(process.env.SK_N1_PER_BUCKET ?? 4)
const STATE_LIMIT = Number(process.env.SK_N1_STATES ?? 1100)
if (!existsSync(corpusDir)) throw new Error(`нет корпуса в ${corpusDir}`)
const stateDir = join(corpusDir, 'states')
for (const name of readdirSync(stateDir).sort()) {
  if (corpusStates.length >= STATE_LIMIT) break
  const file = join(stateDir, name)
  if (statSync(file).size > 120_000) continue
  let state
  try { state = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
  const combat = state?.mechanics?.combat
  if (!combat?.active || !(state.enemies ?? []).length) continue
  const current = combat.initiative?.[combat.active_index]?.actor_id
  const fresh = []
  for (const enemy of state.enemies) {
    const key = signature(enemy, current)
    const count = buckets.get(key) ?? 0
    if (count < PER_BUCKET) fresh.push(enemy)
    buckets.set(key, count + 1)
  }
  if (fresh.length) corpusStates.push({ state, enemies: fresh.slice(0, 4).map((enemy) => String(enemy.id)), current })
}
console.log(`корпус: ${corpusStates.length} состояний, ${buckets.size} корзин`)

const POTION = { item_instance_id: 'n1-potion', catalog_id: 'srd_5_2_1:potion-of-healing', quantity: 1 }
const ACID = { item_instance_id: 'n1-acid', catalog_id: 'srd_5_2_1:acid', quantity: 2 }
const FIRE = { item_instance_id: 'n1-fire', catalog_id: 'srd_5_2_1:alchemists-fire', quantity: 1 }
const POISON = { item_instance_id: 'n1-poison', catalog_id: 'srd_5_2_1:poison-basic', quantity: 1 }

function enemyOf(state, id) {
  return (state.enemies ?? []).find((enemy) => String(enemy.id) === String(id))
}
function setConditions(state, id, list) {
  state.mechanics = state.mechanics ?? {}
  state.mechanics.conditions = { ...(state.mechanics.conditions ?? {}), [id]: [...(state.mechanics.conditions?.[id] ?? []), ...list] }
}
function economy(state, id, patch) {
  state.mechanics.combat.action_economy = state.mechanics.combat.action_economy ?? {}
  state.mechanics.combat.action_economy[id] = { ...(state.mechanics.combat.action_economy[id] ?? { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }), ...patch }
}
function heroIds(state) {
  return (state.players ?? []).map((player) => String(player.id))
}
const VARIANTS = {
  wounded(state, id) { const enemy = enemyOf(state, id); enemy.hp = Math.max(1, Math.floor((Number(enemy.maxHp ?? enemy.max_hp) || 10) * 0.2)) },
  prone(state, id) { setConditions(state, id, [{ id: 'prone' }]) },
  turned(state, id) { setConditions(state, id, [{ id: 'turned', source_actor: pick(heroIds(state)) ?? 'hero' }]) },
  slowed(state, id) { setConditions(state, id, [{ id: 'slowed' }]); economy(state, id, { attacks_used: 1, action: false }) },
  spent(state, id) { economy(state, id, { action: false, attacks_used: int(3), movement_spent: pick([0, 5, 15, 30]) }) },
  moved(state, id) { economy(state, id, { movement_spent: pick([10, 20, 25, 40]) }) },
  dance(state, id) { setConditions(state, id, [{ id: 'otto-dance', action_save_ability: 'wis' }]) },
  stunned(state, id) { setConditions(state, id, [{ id: 'stunned' }]) },
  potion(state, id) { const enemy = enemyOf(state, id); enemy.hp = 1; enemy.loadout = { ...(enemy.loadout ?? {}), items: [...(enemy.loadout?.items ?? []), POTION] } },
  flasks(state, id) { const enemy = enemyOf(state, id); enemy.loadout = { ...(enemy.loadout ?? {}), items: [...(enemy.loadout?.items ?? []), ACID, FIRE, POISON] } },
  morale(state, id) { setConditions(state, id, [{ id: 'morale-tested' }]); VARIANTS.wounded(state, id) },
  fog(state) {
    const heroes = (state.players ?? []).map((hero) => ({ x: Number(state.mechanics?.positions?.[hero.id]?.x ?? hero.x), y: Number(state.mechanics?.positions?.[hero.id]?.y ?? hero.y) }))
    for (const cell of state.scene?.cells ?? []) {
      const near = heroes.some((hero) => Math.max(Math.abs(hero.x - cell.x), Math.abs(hero.y - cell.y)) <= 3)
      if (!near) cell.revealed = false
    }
  },
  frenzy(state, id) { const enemy = enemyOf(state, id); enemy.traits = [...(enemy.traits ?? []), pick(['bloodied-frenzy', 'relentless-pursuit', 'keep-distance', 'nimble-escape', 'aggressive', 'pack-tactics'])] },
  ally(state, id) { const enemy = enemyOf(state, id); const copy = { ...clone(enemy), id: `${id}-twin`, name: `${enemy.name ?? id} двойник` }; copy.x = Number(enemy.x) + 1; state.enemies.push(copy); state.mechanics.positions = { ...(state.mechanics.positions ?? {}), [copy.id]: { x: copy.x, y: Number(state.mechanics.positions?.[id]?.y ?? enemy.y) } } },
}
const corpusSummary = { states: 0, plans: 0, variants: 0, legendary: 0 }
for (const { state, enemies } of corpusStates) {
  corpusSummary.states += 1
  for (const id of enemies) {
    planCase('corpus:plan', state, id)
    corpusSummary.plans += 1
    if (chance(0.45)) {
      const names = Object.keys(VARIANTS)
      for (const name of [pick(names), pick(names)]) {
        const copy = clone(state)
        if (!enemyOf(copy, id)) continue
        VARIANTS[name](copy, id)
        if (planCase(`corpus:variant:${name}`, copy, id)) corpusSummary.variants += 1
      }
    }
  }
  for (const enemy of state.enemies ?? []) {
    if (enemy.legendary || isBossActor(enemy) || chance(0.02)) {
      legendaryCase('corpus:legendary', state, String(enemy.id))
      corpusSummary.legendary += 1
      const copy = clone(state)
      copy.mechanics.combat.active_index = (Number(copy.mechanics.combat.active_index) + 1) % Math.max(1, copy.mechanics.combat.initiative?.length ?? 1)
      legendaryCase('corpus:legendary', copy, String(enemy.id))
    }
  }
  if (chance(0.25)) {
    coordinatorCase('corpus:clock', 'activeTurnActorIds', [state])
    coordinatorCase('corpus:clock', 'turnActivityKey', [state])
    const events = [{ event_type: 'TurnStarted', event_id: pick(['turn-a', 'turn-b', undefined]), created_at: pick(['2026-08-01T09:59:00.000Z', '2026-08-01T10:00:30.000Z', 'не дата', undefined]) }]
    const options = { timeoutMs: pick([60_000, 120_000, 20, 'x', 3_000]), now: FIXED_MS + int(200_000), activityAt: pick([null, '2026-08-01T10:01:00.000Z', '2026-08-01T09:00:00.000Z']) }
    coordinatorCase('corpus:clock', 'combatTurnClock', [state, events, options])
    let clock = null
    try { clock = C.combatTurnClock(clone(state), clone(events), clone(options)) } catch {}
    if (clock) {
      coordinatorCase('corpus:clock', 'combatTurnClockForState', [state, clock])
      coordinatorCase('corpus:clock', 'combatTurnClockForState', [state, { ...clock, active_index: clock.active_index + 1 }])
      coordinatorCase('corpus:clock', 'combatTurnClock', [state, [], { ...options, previousClock: clock }])
    }
  }
}
console.log('корпус:', corpusSummary)

// --- 3. бестиарий --------------------------------------------------------------------

function arena(enemy, { width = 12, height = 5, enemyX = 4, heroes = 1, ruleset = 'dnd_5e_2014' } = {}) {
  const players = [
    { id: 'hero', character: 'Мирт', characterClass: 'fighter', level: 5, hp: 44, maxHp: 44, armor: 16, speed: 30, proficiency: 3, attackBonus: 6, damageDice: 8, damageBonus: 3,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, x: 0, y: 2 },
    { id: 'archer', character: 'Ива', characterClass: 'ranger', level: 5, hp: 36, maxHp: 36, armor: 14, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, x: 0, y: 4,
      inventory: [{ id: 'bow', name: 'Длинный лук', type: 'weapon', equipped: true, quantity: 1, combat: { kind: 'ranged', damage: '1d8', range_feet: 150 } }] },
  ].slice(0, heroes)
  const enemies = [{ ...enemy, x: enemyX, y: 2 }]
  return normalizeCampaignState({
    sessionCode: 'N1-ARENA', ruleset_id: ruleset, partyMemberIds: players.map((player) => player.id), players, enemies,
    scene: { turn: 1, cells: Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true })) },
    mechanics: {
      positions: Object.fromEntries([...players, ...enemies].map((actor) => [actor.id, { x: actor.x, y: actor.y }])),
      encounter: { enemy_ids: [String(enemy.id)] },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: String(enemy.id), total: 20 }, ...players.map((player, index) => ({ actor_id: player.id, total: 10 - index }))],
        action_economy: Object.fromEntries([...enemies, ...players].map((actor) => [actor.id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}
const records = JSON.parse(readFileSync(new URL('../../../../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const bestiary = []
for (const record of records) {
  try { bestiary.push({ ...enemyFrom2014(record, { x: 4, y: 2 }), id: `m-${String(record.id).split(':').at(-1)}`, alive: true }) } catch {}
}
for (const [catalogId, block] of Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)) {
  bestiary.push({ id: `srd-${catalogId.split(':').at(-1)}`, name: block.name, hp: block.hp, maxHp: block.hp, armor: block.armor, speed: block.speed, abilities: block.abilities,
    traits: block.traits, action_profiles: block.action_profiles, attack_profile: block.action_profiles?.[0], alive: true, srd: true })
}
const bestiarySummary = { monsters: bestiary.length, plans: 0 }
const arenaStates = []
for (const enemy of bestiary) {
  const ruleset = enemy.srd ? 'srd_5_2_1' : 'dnd_5e_2014'
  for (const [enemyX, heroes] of [[1, 1], [4, 2], [9, 2]]) {
    let state
    try { state = arena(clone(enemy), { enemyX, heroes, ruleset }) } catch { continue }
    planCase('bestiary', state, enemy.id)
    bestiarySummary.plans += 1
    arenaStates.push({ state, id: enemy.id })
    if (chance(0.5)) {
      const name = pick(Object.keys(VARIANTS))
      const copy = clone(state)
      VARIANTS[name](copy, enemy.id)
      planCase(`bestiary:variant:${name}`, copy, enemy.id)
    }
    if (enemy.legendary) legendaryCase('bestiary:legendary', { ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } }, enemy.id)
  }
}
console.log('бестиарий:', bestiarySummary)

// --- 5. мусор -----------------------------------------------------------------------

const JUNK = [
  [{}, 'x'], [{ enemies: [] }, ''], [{ enemies: [{ id: 'e', hp: 5 }] }, 'e'],
  [{ enemies: [{ id: 'e', hp: 5, x: 1, y: 1 }], players: [{ id: 'p', hp: 5, x: 2, y: 1 }], mechanics: { combat: { active: true, initiative: [{ actor_id: 'e' }] } } }, 'e'],
  [{ enemies: [{ id: 'e', hp: 'много', traits: [null, 3, 'multiattack', { id: 'keep-distance' }], action_profiles: [{}, { id: 'bite', kind: 'melee', range_feet: 'x' }] }] }, 'e'],
  [{ enemies: [{ id: 7, hp: 3, x: '1', y: '1' }], players: [{ id: 'p', hp: 3 }] }, 7],
]
for (const [state, id] of JUNK) {
  planCase('junk', state, id)
  legendaryCase('junk', state, id)
  coordinatorCase('junk', 'activeTurnActorIds', [state])
  coordinatorCase('junk', 'turnActivityKey', [state])
  coordinatorCase('junk', 'combatTurnClock', [state, [{ event_type: 'TurnStarted' }], { timeoutMs: 'x', now: FIXED_MS }])
}

// --- 4. прогоны планировщика ---------------------------------------------------------------

class RecordingLlm {
  constructor(calls, answers) {
    this.calls = calls
    this.answers = answers
    this.index = 0
  }

  async completeJson(input) {
    this.calls.push({ llm: sha(input) })
    const answer = this.answers[this.index++ % this.answers.length]
    if (answer === 'throw') throw Object.assign(new Error('модель недоступна'), { code: 'LLM_DOWN' })
    return clone(answer)
  }
}
const LLM_ANSWERS = [
  { disposition: 'flee', reaction: 'Бежим!', confidence: 0.8 },
  { disposition: 'surrender', reaction: 'Сдаюсь', confidence: 0.6 },
  'throw',
  { disposition: 'fight', reaction: 'Ни шагу назад', confidence: 0.9 },
  { disposition: 'dance', reaction: 'x'.repeat(400) },
]
const STUB_DECISIONS = [
  { disposition: 'flee', reaction: 'Бегу', provider: 'stub' },
  { disposition: 'surrender', reaction: 'Пощады', provider: 'stub' },
  null,
  { disposition: 'fight', reaction: 'Держусь', provider: 'stub' },
  { disposition: 'parley', provider: 'stub' },
]
function controllerFor(kind, calls) {
  if (kind === 'fallback') return new NpcMoraleAgent()
  if (kind === 'llm') return new NpcMoraleAgent({ llmClient: new RecordingLlm(calls, LLM_ANSWERS) })
  if (kind === 'stub') {
    let index = 0
    return {
      async decide({ state, enemyId }) {
        calls.push({ decide: String(enemyId), state: sha(state) })
        return clone(STUB_DECISIONS[index++ % STUB_DECISIONS.length])
      },
    }
  }
  return null
}

async function runCase(source, rawState, { controller = 'none', maxTurns = 160, advanceNpc = true, soak = false } = {}) {
  const state = clone(rawState)
  const caseSeed = (++caseSerial * 104729 + 3) >>> 0
  const campaign = `N1-RUN-${runs.length + 1}`
  const dir = mkdtempSync(join(tmpdir(), 'sk-n1-run-'))
  const calls = []
  const entry = { src: source, s: addState(state), campaign, controller, maxTurns, advanceNpc, soak, seed: caseSeed }
  try {
    let serial = 0
    const store = new FileEventStore({
      rootDir: dir, reducer: applyGameEvent, normalizeState: normalizeCampaignState,
      clock: () => new Date(FIXED_MS), idFactory: () => `n1-event-${++serial}`,
    })
    await store.initializeCampaign({ campaign_id: campaign, initial_state: state })
    const engine = new RulesEngine({ diceService: dice(caseSeed) })
    const npcController = controllerFor(controller, calls)
    const segments = []
    const steps = soak ? 40 : 1
    for (let step = 0; step < steps; step += 1) {
      let result
      try {
        result = await S.runNpcTurnScheduler({ campaignId: campaign, eventStore: store, rulesEngine: engine, npcController, advanceNpc, maxTurns })
      } catch (error) {
        segments.push({ err: failure(error) })
        break
      }
      segments.push({ turns: clone(result.turns), events: result.events.map(sha), types: result.events.map((event) => event.event_type), version: result.state_version, state: csha(result.state) })
      if (!soak) break
      const loaded = await store.load(campaign)
      const combat = loaded.state.mechanics?.combat
      if (!combat?.active) break
      const ids = C.activeTurnActorIds(loaded.state)
      if (!ids.length || ids.every((id) => (loaded.state.enemies ?? []).some((enemy) => String(enemy.id) === id))) break
      const window = combat.reaction_window
      const commands = ids.map((actorId, index) => ({
        command_type: window ? 'UseCombatAction' : 'EndTurn',
        actor_id: actorId,
        ...(window ? { action_id: 'decline-reaction' } : {}),
        server_authoritative: true,
        campaign_id: campaign,
        command_id: `soak:${step}:${index + 1}`,
      }))
      try {
        const committed = await new AuthoritativeExecutor({ eventStore: store, rulesEngine: engine }).executeCommands({
          campaignId: campaign, idempotencyKey: `soak:${step}`, commands, context: { isAdmin: true, serverAuthoritativeCombat: true },
        })
        segments.push({ hero: committed.events.map(sha), version: committed.state_version })
      } catch (error) {
        segments.push({ heroErr: failure(error) })
        break
      }
    }
    const final = await store.load(campaign)
    entry.o = { segments, final: { version: final.state_version, state: csha(final.state), active: Boolean(final.state.mechanics?.combat?.active), round: final.state.mechanics?.combat?.round ?? null } }
  } catch (error) {
    entry.o = { setup: failure(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  entry.calls = calls
  runs.push(entry)
}

const RUN_LIMIT = Number(process.env.SK_N1_RUNS ?? 120)
const enemyTurnStates = corpusStates.filter(({ state, current }) => (state.enemies ?? []).some((enemy) => String(enemy.id) === String(current)))
const runSummary = { corpus: 0, soak: 0, bestiary: 0 }
for (const { state } of enemyTurnStates.slice(0, RUN_LIMIT)) {
  await runCase('run:corpus', state, { controller: pick(['none', 'none', 'fallback', 'llm', 'stub']), advanceNpc: chance(0.9), maxTurns: pick([160, 160, 3, 40]) })
  runSummary.corpus += 1
}
for (const { state } of enemyTurnStates.slice(RUN_LIMIT, RUN_LIMIT + 30)) {
  const copy = clone(state)
  for (const enemy of copy.enemies ?? []) enemy.hp = Math.max(1, Math.floor((Number(enemy.maxHp ?? enemy.max_hp) || 10) * 0.25))
  await runCase('run:morale', copy, { controller: pick(['fallback', 'llm', 'stub']) })
  runSummary.corpus += 1
}
for (const { state } of corpusStates.filter((_, index) => index % 9 === 0).slice(0, 45)) {
  await runCase('run:soak', state, { soak: true, controller: pick(['none', 'fallback']) })
  runSummary.soak += 1
}
for (const { state } of arenaStates.filter((_, index) => index % 3 === 1)) {
  await runCase('run:bestiary', state, { soak: true, controller: pick(['none', 'fallback', 'llm']) })
  runSummary.bestiary += 1
}
console.log('прогоны:', runSummary)

// --- запись ---------------------------------------------------------------------------

const sections = { blobs, states, plans, legendary, coordinator, runs }
const lines = Object.entries(sections).map(([key, value]) => `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
const text = `{\n${lines.join(',\n')}\n}\n`
const gz = gzipSync(text, { level: 9 })
writeFileSync(new URL('./n1.json.gz', import.meta.url), gz)
console.log(`n1.json.gz: ${Object.entries(sections).map(([key, value]) => `${key} ${value.length}`).join(', ')} (${(text.length / 1e6).toFixed(1)} МБ текста, ${(gz.length / 1e6).toFixed(2)} МБ gzip)`)
