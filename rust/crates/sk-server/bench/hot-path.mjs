// Замер горячего пути HTTP-сервера (Ск2): один и тот же сценарий против JS
// (`server/index.mjs`) и Rust (`SKAZANIE_RUST_SERVER_BIN`) через `test/kit`.
//
//   node rust/crates/sk-server/bench/hot-path.mjs --impl rust|js [--iterations 20] [--prefill 0]
//
// Сценарий: игрок создаёт кампанию мастером (1 герой, импорт бойца), затем
//   * `--prefill` ходов исследования без замера (длинная летопись и журнал);
//   * MoveActor в исследовании туда-обратно;
//   * GET /api/rooms/:id;
//   * POST /api/narrate без модели;
//   * сборка встречи (один раз) и бой: MoveActor на клетку и обратно,
//     MakeAttack арбалетом (кости — минимум, все промахиваются, бой не кончается),
//     EndTurn с ходами NPC.
//   * `--iterations` по умолчанию 20; итоговая state_version у JS и Rust обязана
//     совпадать — первую сцену сторожит `test/first-scene-map-parity-api.test.mjs`.
// Печатает медиану, p95 и среднее по каждой операции в мс и строку JSON.

import { writeFileSync } from 'node:fs'

import { startTestServer } from '../../../../test/kit/http.mjs'
import { readJournal } from '../../../../test/kit/journal.mjs'
import { movementCostOfPath, shortestTacticalPath } from '../../../../server/rules-engine.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}
const impl = flag('impl', 'rust')
const iterations = Number(flag('iterations', '20'))
const prefill = Number(flag('prefill', '0'))
// `--trace`: только Rust — сервер пишет строку `[perf]` по этапам каждого
// запроса (`SKAZANIE_PERF_TRACE=1`, `sk_store::perf`); этапы суммируются по
// операции сценария (медиана суммы этапа на один запрос).
const trace = argv.includes('--trace')
// `--viewers N`: столько живых потоков (SSE) комнаты держит владелец — рассылка
// комнаты после каждой записи проекции идёт им.
const viewers = Number(flag('viewers', '0'))
// `--dump-state <файл>`: состояние журнала в конце боя, пользователь-игрок и его
// герой — вход микробенча проекции зрителя (`sk-projection/tests/viewer_bench.rs`).
const dumpState = flag('dump-state', '')
// `--dump-journal <файл>`: коммиты журнала (ключ, версии, типы событий и сами
// события) — сверка JS и Rust по шагам сценария. Расхождение 310 против 271
// (2026-10-25) так свелось к сборке встречи: другая обстановка первой сцены
// (#184 не перенесён), другие занятые клетки — другая точка появления крысы.
const dumpJournal = flag('dump-journal', '')
// `--dump-rooms <файл>`: тела ответов GET /api/rooms по порядку (исследование,
// после рассказа, в бою) — сверка «ответ байт в байт» между сборками (Ск4).
const dumpRooms = flag('dump-rooms', '')
const roomBodies = []
const CAMPAIGN = 'HOT-PATH'

const cleanups = []
const t = { after: (fn) => cleanups.push(fn) }

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
    knownSpellIds: [], preparedSpellIds: [],
  } }
}

const stats = new Map()
const spanStats = new Map()
let perfLines = []
function record(label, ms) {
  if (!stats.has(label)) stats.set(label, [])
  stats.get(label).push(ms)
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { n: sorted.length, median: Math.round(at(0.5)), p95: Math.round(at(0.95)), mean: Math.round(mean) }
}

async function main() {
  const server = await startTestServer(t, { impl, dice: DICE, storagePrefix: 'skazanie-hot-path-', setupToken: 'hot-path-setup',
    healthTimeoutMs: 60_000, env: trace ? { SKAZANIE_PERF_TRACE: '1' } : {} })
  let pending = ''
  server.child?.stderr?.on('data', (chunk) => {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/u)
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('[perf] ')) perfLines.push(JSON.parse(line.slice(7)))
  })
  const request = async (path, { cookie = '', method = 'GET', body, label } = {}) => {
    const started = performance.now()
    const response = await fetch(`${server.baseUrl}${path}`, { method, signal: AbortSignal.timeout(120_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    const elapsed = performance.now() - started
    if (dumpRooms && method === 'GET' && path.startsWith('/api/rooms/')) roomBodies.push(text)
    if (label) record(response.status < 300 ? label : `${label} [${response.status}]`, elapsed)
    if (trace) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 15))
      const lines = perfLines
      perfLines = []
      if (label) {
        const sums = {}
        for (const line of lines) for (const [name, [, ms]] of Object.entries(line.spans)) sums[name] = (sums[name] ?? 0) + ms
        if (!spanStats.has(label)) spanStats.set(label, [])
        spanStats.get(label).push(sums)
      }
    }
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const expect = (result, status = 200) => {
    if (result.status !== status) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 600)}\n${server.output().slice(-3000)}`)
    return result.body
  }
  let serial = 0
  const command = (cookie, command, label) => request(`/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie, label, body: { idempotency_key: `bench-${++serial}`, command },
  })

  const admin = expect(await request('/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Ведущий', email: 'admin@hot-path.test', password: 'hot-path-admin-password', setupToken: 'hot-path-setup' } }), 201)
  const adminCookie = (await request('/api/auth/login', { method: 'POST', body: { email: 'admin@hot-path.test', password: 'hot-path-admin-password' } })).cookie
  void admin
  const player = await request('/api/auth/register', { method: 'POST', body: { name: 'Игрок', email: 'player@hot-path.test', password: 'hot-path-player-password' } })
  expect(player, 201)
  const owner = player.cookie
  expect(await request('/api/campaigns', { method: 'POST', cookie: owner, label: 'create campaign', body: {
    code: CAMPAIGN, name: 'Горячий путь', bootstrap: { slotCount: 1, startLevel: 1, rulesetId: 'dnd_5e_2014', world: { preset: 'Классическое фэнтези' } },
  } }), 201)
  let state = expect(await command(owner, { command_type: 'ImportCharacter', actor_id: 'hero-slot-1', document: fighterDocument('Воин') }, 'import character')).authoritative_state
  const heroId = 'hero-slot-1'
  const streams = []
  for (let index = 0; index < viewers; index += 1) {
    const controller = new AbortController()
    const response = await fetch(`${server.baseUrl}/api/campaigns/${CAMPAIGN}/stream`, { headers: { Cookie: owner, Accept: 'text/event-stream' }, signal: controller.signal })
    if (response.status !== 200) throw new Error(`stream HTTP ${response.status}`)
    const reader = response.body.getReader()
    const drain = (async () => { try { while (!(await reader.read()).done) { /* кадры не нужны */ } } catch { /* закрыт */ } })()
    streams.push({ controller, drain })
  }
  cleanups.push(async () => { for (const stream of streams) stream.controller.abort() })
  const positionOf = (current) => {
    const stored = current?.mechanics?.positions?.[heroId]
    const hero = current.players.find((entry) => entry.id === heroId)
    return Number.isSafeInteger(Number(stored?.x)) ? { x: Number(stored.x), y: Number(stored.y) } : { x: Number(hero.x), y: Number(hero.y) }
  }
  const freeStep = (current) => {
    const origin = positionOf(current)
    const occupied = new Set(Object.entries(current?.mechanics?.positions ?? {}).filter(([id]) => id !== heroId).map(([, p]) => `${p.x},${p.y}`))
    const cell = current.scene.cells.find((candidate) => Math.max(Math.abs(candidate.x - origin.x), Math.abs(candidate.y - origin.y)) === 1
      && candidate.movement_blocked !== true && !occupied.has(`${candidate.x},${candidate.y}`)
      && shortestTacticalPath(current, heroId, candidate)?.length === 1 && movementCostOfPath(current, heroId, [candidate]) === 5)
    if (!cell) throw new Error('нет свободной соседней клетки')
    return { origin, step: { x: cell.x, y: cell.y } }
  }
  const explore = freeStep(state)
  let flip = false
  const exploreMove = async (label) => {
    flip = !flip
    const to = flip ? explore.step : explore.origin
    return expect(await command(owner, { command_type: 'MoveActor', actor_id: heroId, to }, label))
  }

  const prefillStarted = performance.now()
  for (let index = 0; index < prefill; index += 1) await exploreMove(null)
  const prefillMs = performance.now() - prefillStarted

  for (let index = 0; index < iterations; index += 1) await exploreMove('commands MoveActor (explore)')
  for (let index = 0; index < iterations; index += 1) expect(await request(`/api/rooms/${CAMPAIGN}`, { cookie: owner, label: 'GET /api/rooms' }))
  for (let index = 0; index < iterations; index += 1) {
    await request('/api/narrate', { method: 'POST', cookie: owner, label: 'narrate (no model)', body: {
      campaignId: CAMPAIGN, action: `Осматриваюсь вокруг, шаг ${index}`, idempotency_key: `bench-narrate-${index}` } })
  }

  const room = expect(await request(`/api/rooms/${CAMPAIGN}`, { cookie: owner }))
  state = room.state
  const assembled = expect(await request(`/api/campaigns/${CAMPAIGN}/encounters/assemble`, { method: 'POST', cookie: adminCookie, label: 'encounters/assemble',
    body: { idempotency_key: 'bench-encounter', expected_state_version: state.state_version, difficulty: 'easy', theme: 'beasts', seed: 'hot-path-bench' } }))
  state = assembled.authoritative_state
  const activeId = (current) => current.mechanics.combat.initiative[current.mechanics.combat.active_index]?.actor_id
  const crossbow = state.players.find((hero) => hero.id === heroId).inventory.find((item) => /crossbow|арбалет/iu.test(`${item.catalog_id} ${item.name}`))
  let combatRounds = 0
  for (let round = 0; round < iterations; round += 1) {
    if (!state.mechanics?.combat?.active) break
    if (activeId(state) !== heroId) {
      state = expect(await command(adminCookie, { command_type: 'EndTurn', actor_id: activeId(state) }, null)).authoritative_state
      continue
    }
    combatRounds += 1
    const { origin, step } = freeStep(state)
    expect(await command(owner, { command_type: 'MoveActor', actor_id: heroId, to: step }, 'commands MoveActor (combat)'))
    state = expect(await command(owner, { command_type: 'MoveActor', actor_id: heroId, to: origin }, 'commands MoveActor (combat)')).authoritative_state
    const target = (state.enemies ?? []).find((enemy) => Number(enemy.hp) > 0)
    if (target && crossbow) {
      const attacked = await command(owner, { command_type: 'MakeAttack', actor_id: heroId, target_id: target.id, item_id: crossbow.id }, 'commands MakeAttack')
      if (attacked.status === 200) state = attacked.body.authoritative_state
    }
    const ended = expect(await command(owner, { command_type: 'EndTurn', actor_id: heroId }, 'commands EndTurn (+NPC)'))
    state = ended.authoritative_state
  }
  const finalRoom = expect(await request(`/api/rooms/${CAMPAIGN}`, { cookie: owner }))
  if (dumpState) {
    const journal = await readJournal(server, CAMPAIGN)
    const me = expect(await request('/api/auth/me', { cookie: owner }))
    writeFileSync(dumpState, JSON.stringify({ state: journal.state, user: me.user ?? me, actor_id: heroId }))
  }
  if (dumpJournal) {
    const journal = await readJournal(server, CAMPAIGN)
    writeFileSync(dumpJournal, JSON.stringify(journal.commits.map((commit) => ({ key: commit.idempotency_key,
      before: commit.state_version_before, after: commit.state_version_after,
      events: commit.events.map((event) => event.event_type ?? event.type), payloads: commit.events })), null, 1))
  }
  if (dumpRooms) writeFileSync(dumpRooms, roomBodies.join('\n'))
  const report = {
    impl, iterations, prefill, viewers, prefill_ms: Math.round(prefillMs), combat_rounds: combatRounds,
    final_state_version: finalRoom.state.state_version, room_messages: finalRoom.state.messages?.length ?? 0,
    ops: Object.fromEntries([...stats].map(([label, values]) => [label, summary(values)])),
  }
  console.log(`\n${impl} · prefill ${prefill} · viewers ${viewers} · state_version ${report.final_state_version} · messages ${report.room_messages}`)
  for (const [label, value] of Object.entries(report.ops)) {
    console.log(`  ${label.padEnd(34)} n=${String(value.n).padStart(3)}  median ${String(value.median).padStart(6)}  p95 ${String(value.p95).padStart(6)}  mean ${String(value.mean).padStart(6)}`)
    const samples = spanStats.get(label)
    if (!samples?.length) continue
    const names = [...new Set(samples.flatMap((sample) => Object.keys(sample)))]
    for (const name of names) {
      const values = samples.map((sample) => sample[name] ?? 0).sort((a, b) => a - b)
      const median = values[Math.floor(values.length / 2)]
      if (median >= 0.5) console.log(`      ${name.padEnd(38)} median ${median.toFixed(1).padStart(8)}`)
    }
  }
  console.log(`JSON ${JSON.stringify(report)}`)
}

try {
  await main()
} finally {
  for (const fn of cleanups.reverse()) {
    try { await fn() } catch (error) { console.error(error) }
  }
}
