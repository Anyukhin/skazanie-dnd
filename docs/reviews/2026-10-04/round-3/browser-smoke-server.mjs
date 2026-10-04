import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from '../../../../test/free-port.mjs'

// Временный стенд для ручного браузерного аудита. Порт 127.0.0.2 отделяет
// cookie теста от обычного localhost. Реальные ключи и сохранения не нужны.
const root = mkdtempSync(join(tmpdir(), 'skazanie-browser-review-'))
const emptyEnv = join(root, 'empty.env')
writeFileSync(emptyEnv, '')
const backendPort = await freePort()
const backend = `http://127.0.0.1:${backendPort}`
const credentials = { email: 'review-player@example.test', password: 'local-review-only-password' }
const campaign = 'BROWSER-REVIEW3'
const switchTest = process.argv.includes('--switch-test')
const receiptsArgument = process.argv.find(value => value.startsWith('--receipts='))
const durableReceipts = receiptsArgument ? resolve(receiptsArgument.slice('--receipts='.length)) : null
let logs = ''
const serverPath = fileURLToPath(new URL('../../../../server/index.mjs', import.meta.url))
const child = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  env: {
    ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(backendPort),
    DND_STORAGE_DIR: join(root, 'storage'), DOTENV_CONFIG_PATH: emptyEnv,
    ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'local-browser-review-token',
    COOKIE_SECURE: 'false', GAME_ENGINE_MODE: 'enforce',
  }, stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', c => { logs = (logs + c).slice(-2000) })
child.stderr.on('data', c => { logs = (logs + c).slice(-2000) })
let stopRequested = false
process.once('SIGINT', () => { stopRequested = true })
process.once('SIGTERM', () => { stopRequested = true })

async function api(path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(backend + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  })
  const value = await response.json()
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}

const sockets = new Set()
const requests = []
const heldTimers = new Set()
const proxy = createServer((req, res) => {
  const command = req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/commands$/u.test(req.url ?? '')
  const narrate = req.method === 'POST' && req.url === '/api/narrate'
  const tracked = command || narrate
  const drop = command && existsSync(join(root, 'drop-next-command'))
  const fail = command && existsSync(join(root, 'fail-command-responses'))
  const hold = tracked && switchTest && existsSync(join(root, 'hold-command-responses'))
  if (drop) rmSync(join(root, 'drop-next-command'))
  const chunks = []
  req.on('data', chunk => { if (tracked) chunks.push(chunk) })
  const upstream = httpRequest({
    hostname: '127.0.0.1', port: backendPort, method: req.method, path: req.url,
    headers: req.headers,
  }, result => {
    const reply = []
    if (tracked) result.on('data', chunk => reply.push(chunk))
    if (hold) {
      result.resume()
      result.once('end', () => {
        writeFileSync(join(root, 'held-response.json'), JSON.stringify({ path: req.url, status: result.statusCode }))
        const timer = setInterval(() => {
          if (!res.destroyed && existsSync(join(root, 'hold-command-responses'))) return
          clearInterval(timer)
          heldTimers.delete(timer)
          if (!res.destroyed) { res.writeHead(result.statusCode ?? 502, result.headers); res.end(Buffer.concat(reply)) }
        }, 50)
        heldTimers.add(timer)
      })
    } else if (fail) {
      result.resume()
      result.once('end', () => {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Ответ потерян на пробном proxy.', code: 'SIMULATED_REPLY_LOST' }))
      })
    } else if (drop) {
      result.resume()
      result.once('end', () => { res.destroy(); writeFileSync(join(root, 'last-drop.json'), JSON.stringify({ status: result.statusCode, path: req.url })) })
    } else { res.writeHead(result.statusCode ?? 502, result.headers); result.pipe(res) }
    if (tracked) result.once('end', () => {
      let input = {}
      try { input = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* Только диагностика синтетического ввода. */ }
      let output = {}
      try { output = JSON.parse(Buffer.concat(reply).toString()) } catch { /* Не сохраняем тело ответа. */ }
      const hero = output.authoritative_state?.players?.find(player => player.id === 'review-hero')
      requests.push({
        path: req.url, status: result.statusCode, dropped: drop,
        response_status: hold ? null : fail ? 503 : drop ? null : result.statusCode,
        ...(hold ? { held: true } : {}),
        key: input.idempotency_key, type: input.command?.command_type ?? (narrate ? 'narrate' : null),
        replayed: output.idempotent_replay ?? null,
        state_version: output.authoritative_state?.state_version ?? null,
        position: hero ? { x: hero.x, y: hero.y } : null,
      })
      writeFileSync(join(root, 'command-receipts.json'), JSON.stringify(requests, null, 2))
      if (durableReceipts) writeFileSync(durableReceipts, JSON.stringify(requests, null, 2))
    })
  })
  upstream.on('error', () => { if (!res.destroyed) { res.writeHead(502); res.end('{}') } })
  res.once('close', () => upstream.destroy())
  req.pipe(upstream)
})
proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })

async function stop() {
  for (const timer of heldTimers) clearInterval(timer)
  for (const socket of sockets) socket.destroy()
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve))
  if (child.exitCode == null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill()
    await exited
  }
  rmSync(root, { recursive: true, force: true })
}

try {
  let ready = false
  for (let index = 0; index < 100; index++) {
    if (child.exitCode != null) throw new Error(`Пробный сервер завершился: ${logs}`)
    try { if ((await api('/api/health')).status === 200) { ready = true; break } } catch { /* Ждём свой процесс. */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, 'Пробный сервер не запустился')
  const admin = await api('/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Администратор стенда', email: 'review-admin@example.test',
    password: 'local-review-admin-password', setupToken: 'local-browser-review-token',
  } })
  assert.equal(admin.status, 201)
  const state = {
    sessionCode: campaign, campaign: 'Браузерная проверка восстановления', activePlayerId: 'review-hero',
    partyMemberIds: ['review-hero'], messages: [],
    players: [{ id: 'review-hero', character: 'Алёна', class: 'Воин', level: 1,
      hp: 8, maxHp: 10, armor: 12, speed: 30, proficiency: 2, x: 1, y: 1, online: true,
      characterSetupRequired: false, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [] }],
    scene: { title: 'Тихая площадь', location: 'Тестовая площадь', description: 'Безопасная синтетическая сцена.',
      cells: Array.from({ length: 256 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16), type: 'floor', revealed: true })) },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
  const created = await api('/api/campaigns', { method: 'POST', cookie: admin.cookie, body: { code: campaign, name: state.campaign, state } })
  assert.equal(created.status, 201, JSON.stringify(created.value))
  if (switchTest) {
    const other = structuredClone(state)
    other.sessionCode = 'BROWSER-OTHER4'
    other.campaign = 'Вторая кампания проверки'
    other.scene.title = 'Комната Б'
    other.scene.location = 'Вторая площадь'
    const second = await api('/api/campaigns', { method: 'POST', cookie: admin.cookie, body: {
      code: other.sessionCode, name: other.campaign, state: other,
    } })
    assert.equal(second.status, 201, JSON.stringify(second.value))
    for (let i = 0; i < 3; i++) {
      const seeded = await api(`/api/campaigns/${campaign}/commands`, { method: 'POST', cookie: admin.cookie, body: {
        idempotency_key: `queue-fixture-${i}`, message: 'Подготовить версию первой кампании',
        command: { command_type: 'MoveActor', actor_id: 'review-hero', to: { x: i % 2 ? 1 : 2, y: 1 } },
      } })
      assert.equal(seeded.status, 200, JSON.stringify(seeded.value))
    }
  }
  const player = await api('/api/auth/register', { method: 'POST', body: { name: 'Игрок стенда', ...credentials } })
  assert.equal(player.status, 201)
  const users = await api('/api/admin/users', { cookie: admin.cookie })
  const playerId = users.value.users.find(user => user.email === credentials.email)?.id
  assert.ok(playerId)
  const assigned = await api(`/api/admin/users/${playerId}`, { method: 'PATCH', cookie: admin.cookie, body: { heroIds: ['review-hero'] } })
  assert.equal(assigned.status, 200)
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.2', resolve) })
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')
  const info = { url: `http://127.0.0.2:${address.port}`, campaign, root, credentials,
    helper_pid: process.pid, backend_pid: child.pid, backend_port: backendPort,
    arm: join(root, 'drop-next-command'), fail: join(root, 'fail-command-responses'),
    ...(switchTest ? { other_campaign: 'BROWSER-OTHER4', hold: join(root, 'hold-command-responses'), pulse: join(root, 'pulse-a') } : {}),
    receipts: join(root, 'command-receipts.json'), stop: join(root, 'stop') }
  console.log(JSON.stringify(info))
  const deadline = Date.now() + 20 * 60 * 1000
  let pulse = 0
  while (!stopRequested && !existsSync(info.stop) && Date.now() < deadline && child.exitCode == null) {
    if (switchTest && existsSync(info.pulse)) {
      rmSync(info.pulse)
      const result = await api(`/api/campaigns/${campaign}/commands`, { method: 'POST', cookie: admin.cookie, body: {
        idempotency_key: `queue-pulse-${++pulse}`, message: 'Синтетическое обновление A для очереди',
        command: { command_type: 'MoveActor', actor_id: 'review-hero', to: { x: 4 + pulse % 2, y: 1 } },
      } })
      writeFileSync(join(root, 'last-pulse.json'), JSON.stringify({ status: result.status, version: result.value.room_version, state_version: result.value.authoritative_state?.state_version }))
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
} finally {
  await stop()
  console.log('BROWSER_REVIEW_SERVER_STOPPED')
}
