// Замер горячего пути на длинном журнале (урок 11 плана переноса): как растут
// ход, чтение комнаты и холодная загрузка с длиной журнала кампании.
//
//   SKAZANIE_RUST_SERVER_BIN=<бинарь test-hooks> node rust/crates/sk-server/bench/long-journal.mjs \
//     --storage <tmpdir>/skazanie-long-journal --to 2000 [--measure] [--iterations 9] [--narrate-every 10] [--out file.json]
//
// Хранилище — постоянное (не удаляется), прямо во временном каталоге ОС с
// префиксом `skazanie-` (так требуют тестовые кости набора). Повторный запуск
// продолжает ту же кампанию до `--to` версий журнала:
//   * рост — MoveActor героя туда-обратно в исследовании, каждый
//     `--narrate-every`-й шаг — POST /api/narrate без модели (летопись растёт,
//     как в игре);
//   * `--measure` — на достигнутой версии: холодная загрузка (перезапуск
//     сервера → первый GET /api/rooms), MoveActor в исследовании, GET
//     /api/rooms; затем бой на копии хранилища (сборка встречи, MoveActor в бою,
//     EndTurn с ходами NPC) — основная кампания остаётся в исследовании;
//     размеры состояния и снимков из SQLite.
// Каждая операция — медиана по `--iterations`, с трассой `[perf]`
// (`SKAZANIE_PERF_TRACE=1`): медианы отрезков на один запрос.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { startTestServer } from '../../../../test/kit/http.mjs'
import { readJournal } from '../../../../test/kit/journal.mjs'
import { movementCostOfPath, shortestTacticalPath } from '../../../../server/rules-engine.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}
const storage = resolve(flag('storage', join(tmpdir(), 'skazanie-long-journal')))
const target = Number(flag('to', '160'))
const measure = argv.includes('--measure')
const iterations = Number(flag('iterations', '9'))
const narrateEvery = Number(flag('narrate-every', '10'))
const out = flag('out', '')
if (dirname(storage) !== resolve(tmpdir()) || !basename(storage).startsWith('skazanie-')) {
  throw new Error(`--storage: только прямо в ${tmpdir()} с префиксом skazanie- (тестовые кости набора)`)
}
mkdirSync(storage, { recursive: true })

const CAMPAIGN = 'LONG-JOURNAL'
const HERO = 'hero-slot-1'
const SETUP = 'long-journal-setup'
const ADMIN = { email: 'admin@long-journal.test', password: 'long-journal-admin-password' }
const PLAYER = { email: 'player@long-journal.test', password: 'long-journal-player-password' }
const DICE = { format: 'skazanie.test-dice/1', description: 'все кости — минимум', rules: [{ value: 'min' }] }

function fighterDocument(name) {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: name, characterClass: 'fighter', species: 'Человек', background: 'Мудрец', backgroundId: 'sage',
    level: 1, experience: 0, abilities: Object.fromEntries(Object.entries(baseScores).map(([id, value]) => [id, value + 1])),
    abilityGeneration: { policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
      baseScores, originBonusProfileId: 'human', originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, speciesOptionId: 'human' },
    speciesChoices: { 'extra-language': ['dwarvish'] }, backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
    starterEquipmentChoices: { armor: ['chain-mail'], 'melee-loadout': ['longsword-shield'], secondary: ['light-crossbow'], pack: ['explorers-pack'] },
    baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['athletics', 'perception'], selectedFeatureIds: ['fighting-style-defense'],
    knownSpellIds: [], preparedSpellIds: [], phbCreation: { schema_version: 1, classChoices: {} },
  } }
}

const cleanups = []
const t = { after: (fn) => cleanups.push(fn) }
const report = { storage, target, iterations, narrate_every: narrateEvery, ops: {}, spans: {}, sizes: null }

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const samples = new Map()

/** Клиент сервера набора: замер времени и отрезков `[perf]` каждого запроса. */
function client(server) {
  let pending = ''
  let perfLines = []
  server.child?.stderr?.on('data', (chunk) => {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/u)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('[perf] ')) perfLines.push(JSON.parse(line.slice(7)))
  })
  const request = async (path, { cookie = '', method = 'GET', body, label } = {}) => {
    perfLines = []
    const started = performance.now()
    const response = await fetch(`${server.baseUrl}${path}`, { method, signal: AbortSignal.timeout(600_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    const elapsed = performance.now() - started
    if (label) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
      // Отрезок `[число, мс, МБ]`; МБ и `alloc` — только в сборке с фичей alloc-count.
      const spans = {}
      const alloc = { mb: 0, count: 0, big: 0 }
      for (const line of perfLines) {
        for (const [name, [count, ms, mb = 0]] of Object.entries(line.spans)) {
          spans[name] ??= [0, 0, 0]
          spans[name][0] += count
          spans[name][1] += ms
          spans[name][2] += mb
        }
        for (const key of Object.keys(alloc)) alloc[key] += line.alloc?.[key] ?? 0
      }
      const key = response.status < 300 ? label : `${label} [${response.status}]`
      if (!samples.has(key)) samples.set(key, [])
      samples.get(key).push({ ms: elapsed, spans, alloc, server_ms: perfLines.reduce((sum, line) => sum + line.total_ms, 0) })
    }
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const expect = (result, status = 200) => {
    if (result.status !== status) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 600)}\n${server.output().slice(-3000)}`)
    return result.body
  }
  const summarize = (prefix = '') => {
    for (const [label, values] of samples) {
      const name = `${prefix}${label}`
      report.ops[name] = { n: values.length, median: Math.round(median(values.map((value) => value.ms))), min: Math.round(Math.min(...values.map((value) => value.ms))), max: Math.round(Math.max(...values.map((value) => value.ms))),
        alloc_mb: Number(median(values.map((value) => value.alloc.mb)).toFixed(1)), allocs: median(values.map((value) => value.alloc.count)), big_allocs: median(values.map((value) => value.alloc.big)) }
      const names = [...new Set(values.flatMap((value) => Object.keys(value.spans)))]
      report.spans[name] = Object.fromEntries(names.map((span) => [span, {
        count: median(values.map((value) => value.spans[span]?.[0] ?? 0)),
        ms: Number(median(values.map((value) => value.spans[span]?.[1] ?? 0)).toFixed(2)),
        mb: Number(median(values.map((value) => value.spans[span]?.[2] ?? 0)).toFixed(2)),
      }]).sort((a, b) => b[1].ms - a[1].ms))
    }
  }
  return { request, expect, summarize }
}

async function login(api, account) {
  return (await api.request('/api/auth/login', { method: 'POST', body: account })).cookie
}

async function ensureCampaign(api) {
  const setup = await api.request('/api/auth/setup-admin', { method: 'POST', body: { name: 'Ведущий', ...ADMIN, setupToken: SETUP } })
  if (setup.status === 201) {
    api.expect(await api.request('/api/auth/register', { method: 'POST', body: { name: 'Игрок', ...PLAYER } }), 201)
  }
  const owner = await login(api, PLAYER)
  const admin = await login(api, ADMIN)
  const room = await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: owner })
  if (room.status !== 200) {
    api.expect(await api.request('/api/campaigns', { method: 'POST', cookie: owner, body: {
      code: CAMPAIGN, name: 'Длинный журнал', bootstrap: { slotCount: 1, startLevel: 1, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } },
    } }), 201)
    api.expect(await api.request(`/api/campaigns/${CAMPAIGN}/commands`, { method: 'POST', cookie: owner, body: {
      idempotency_key: 'long-import', command: { command_type: 'ImportCharacter', actor_id: HERO, document: fighterDocument('Воин') } } }))
  }
  return { owner, admin }
}

const positionOf = (current) => {
  const stored = current?.mechanics?.positions?.[HERO]
  const hero = current.players.find((entry) => entry.id === HERO)
  return Number.isSafeInteger(Number(stored?.x)) ? { x: Number(stored.x), y: Number(stored.y) } : { x: Number(hero.x), y: Number(hero.y) }
}
const freeStep = (current) => {
  const origin = positionOf(current)
  const occupied = new Set(Object.entries(current?.mechanics?.positions ?? {}).filter(([id]) => id !== HERO).map(([, p]) => `${p.x},${p.y}`))
  const cell = current.scene.cells.find((candidate) => Math.max(Math.abs(candidate.x - origin.x), Math.abs(candidate.y - origin.y)) === 1
    && candidate.movement_blocked !== true && !occupied.has(`${candidate.x},${candidate.y}`)
    && shortestTacticalPath(current, HERO, candidate)?.length === 1 && movementCostOfPath(current, HERO, [candidate]) === 5)
  if (!cell) throw new Error('нет свободной соседней клетки')
  return { origin, step: { x: cell.x, y: cell.y } }
}

/** Мутатор: ходы туда-обратно и редкий рассказ; ключи — по версии, повтор безопасен. */
function explorer(api, owner, state) {
  const { origin, step } = freeStep(state)
  let version = state.state_version
  let at = positionOf(state)
  let moves = 0
  const move = async (label) => {
    const to = at.x === origin.x && at.y === origin.y ? step : origin
    const body = api.expect(await api.request(`/api/campaigns/${CAMPAIGN}/commands`, { method: 'POST', cookie: owner, label,
      body: { idempotency_key: `long-move-${version}`, command: { command_type: 'MoveActor', actor_id: HERO, to } } }))
    version = body.authoritative_state.state_version
    at = positionOf(body.authoritative_state)
    moves += 1
    return body
  }
  const narrate = async (label) => {
    const result = await api.request('/api/narrate', { method: 'POST', cookie: owner, label, body: {
      campaignId: CAMPAIGN, action: `Осматриваюсь вокруг, версия ${version}`, idempotency_key: `long-narrate-${version}` } })
    const room = api.expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: owner }))
    version = room.state.state_version
    at = positionOf(room.state)
    return result
  }
  return { move, narrate, version: () => version, moves: () => moves }
}

function sizes(state) {
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null))
  const total = bytes(state)
  const top = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, bytes(value)]).sort((a, b) => b[1] - a[1]).slice(0, 20))
  const playerFields = {}
  for (const player of state.players ?? []) {
    for (const [key, value] of Object.entries(player)) playerFields[key] = (playerFields[key] ?? 0) + bytes(value)
  }
  const players = Object.fromEntries(Object.entries(playerFields).sort((a, b) => b[1] - a[1]).slice(0, 15))
  const mechanics = Object.fromEntries(Object.entries(state.mechanics ?? {}).map(([key, value]) => [key, bytes(value)]).sort((a, b) => b[1] - a[1]).slice(0, 12))
  return { total, top, players, mechanics }
}

function sqliteSizes() {
  const db = new DatabaseSync(join(storage, 'skazanie.sqlite'), { readOnly: true })
  try {
    const snapshots = db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS bytes, MAX(LENGTH(body)) AS max FROM snapshots WHERE campaign_id = ?').get(CAMPAIGN)
    const last = db.prepare('SELECT state_version, LENGTH(body) AS bytes FROM snapshots WHERE campaign_id = ? ORDER BY state_version DESC LIMIT 1').get(CAMPAIGN)
    const commits = db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS bytes, MAX(version_after) AS head FROM commits WHERE campaign_id = ?').get(CAMPAIGN)
    const maps = db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS bytes FROM map_blobs').get()
    const overlays = db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS bytes FROM room_overlays').get()
    return { snapshots, last_snapshot: last, commits, map_blobs: maps, room_overlays: overlays }
  } catch (error) {
    return { error: String(error) }
  } finally {
    db.close()
  }
}

async function main() {
  const env = { SKAZANIE_PERF_TRACE: '1' }
  const server = await startTestServer(t, { impl: 'rust', dice: DICE, storageDir: storage, setupToken: SETUP, healthTimeoutMs: 600_000, env })
  let api = client(server)
  const { owner, admin } = await ensureCampaign(api)
  let room = api.expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: owner }))
  let walker = explorer(api, owner, room.state)
  const growStarted = performance.now()
  let lastLog = performance.now()
  while (walker.version() < target) {
    if (narrateEvery > 0 && walker.moves() % narrateEvery === narrateEvery - 1) await walker.narrate(null)
    await walker.move(null)
    if (performance.now() - lastLog > 30_000) {
      lastLog = performance.now()
      console.log(`  рост: версия ${walker.version()} / ${target}, ${Math.round((performance.now() - growStarted) / 1000)} с`)
    }
  }
  report.grow_ms = Math.round(performance.now() - growStarted)
  report.version = walker.version()
  console.log(`версия ${report.version}, рост ${Math.round(report.grow_ms / 1000)} с`)
  if (!measure) return

  // Холодная загрузка: новый процесс, первый запрос комнаты.
  for (let run = 0; run < 3; run += 1) {
    await server.restart()
    api = client(server)
    const cookie = await login(api, PLAYER)
    api.expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie, label: 'cold GET /api/rooms (first)' }))
    api.expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie, label: 'cold GET /api/rooms (second)' }))
  }
  const ownerCookie = await login(api, PLAYER)
  room = api.expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: ownerCookie }))
  walker = explorer(api, ownerCookie, room.state)
  await walker.move('first MoveActor after restart')  // холодная память рассказов: чтение всех трасс хода
  await walker.move(null)
  for (let index = 0; index < iterations; index += 1) await walker.move('MoveActor (explore)')
  for (let index = 0; index < iterations; index += 1) api.expect(await api.request(`/api/rooms/${CAMPAIGN}`, { cookie: ownerCookie, label: 'GET /api/rooms' }))
  const journal = await readJournal(server, CAMPAIGN)
  report.sizes = { state: sizes(journal.state), sqlite: sqliteSizes() }
  report.version = journal.state.state_version
  await server.stop()

  // Бой — на копии хранилища: основная кампания остаётся в исследовании.
  const combatStorage = `${storage}-combat`
  rmSync(combatStorage, { recursive: true, force: true })
  cpSync(storage, combatStorage, { recursive: true })
  try {
    const combat = await startTestServer(t, { impl: 'rust', dice: DICE, storageDir: combatStorage, setupToken: SETUP, healthTimeoutMs: 600_000, env })
    const capi = client(combat)
    const owner2 = await login(capi, PLAYER)
    const admin2 = await login(capi, ADMIN)
    let state = capi.expect(await capi.request(`/api/rooms/${CAMPAIGN}`, { cookie: owner2 })).state
    const assembled = capi.expect(await capi.request(`/api/campaigns/${CAMPAIGN}/encounters/assemble`, { method: 'POST', cookie: admin2, label: 'encounters/assemble',
      body: { idempotency_key: `long-encounter-${state.state_version}`, expected_state_version: state.state_version, difficulty: 'easy', theme: 'beasts', seed: 'long-journal-bench' } }))
    state = assembled.authoritative_state
    const activeId = (current) => current.mechanics.combat.initiative[current.mechanics.combat.active_index]?.actor_id
    let serial = 0
    const command = (cookie, body, label) => capi.request(`/api/campaigns/${CAMPAIGN}/commands`, { method: 'POST', cookie, label, body: { idempotency_key: `long-combat-${++serial}`, command: body } })
    let rounds = 0
    for (let guard = 0; guard < iterations * 4 && rounds < iterations; guard += 1) {
      if (!state.mechanics?.combat?.active) break
      if (activeId(state) !== HERO) {
        state = capi.expect(await command(admin2, { command_type: 'EndTurn', actor_id: activeId(state) }, null)).authoritative_state
        continue
      }
      rounds += 1
      const { origin, step } = freeStep(state)
      capi.expect(await command(owner2, { command_type: 'MoveActor', actor_id: HERO, to: step }, 'MoveActor (combat)'))
      state = capi.expect(await command(owner2, { command_type: 'MoveActor', actor_id: HERO, to: origin }, 'MoveActor (combat)')).authoritative_state
      state = capi.expect(await command(owner2, { command_type: 'EndTurn', actor_id: HERO }, 'EndTurn (+NPC)')).authoritative_state
    }
    report.combat_rounds = rounds
    capi.summarize()
    await combat.stop()
  } finally {
    rmSync(combatStorage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  void admin
}

try {
  await main()
} finally {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (error) { console.error(error) }
  }
  if (measure) {
    console.log(`\nверсия ${report.version}`)
    for (const [label, value] of Object.entries(report.ops)) {
      console.log(`  ${label.padEnd(32)} n=${String(value.n).padStart(3)} median ${String(value.median).padStart(6)} min ${String(value.min).padStart(6)} max ${String(value.max).padStart(6)}  alloc ${value.alloc_mb} МБ / ${value.allocs} (крупных ${value.big_allocs})`)
      for (const [name, span] of Object.entries(report.spans[label] ?? {}).slice(0, 40)) {
        if (span.ms >= 0.5 || name.startsWith('normalize')) console.log(`      ${name.padEnd(40)} ×${String(span.count).padStart(3)} ${span.ms.toFixed(1).padStart(8)} мс ${span.mb.toFixed(1).padStart(7)} МБ`)
      }
    }
    if (out) writeFileSync(out, JSON.stringify(report, null, 1))
  }
  if (!existsSync(storage)) console.error('хранилище пропало')
}
