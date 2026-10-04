import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Стык двух правок аудита PR #131. RCV-01/02: потерянный хвост журнала или
 * seed-снимок кампании дают явный отказ `CAMPAIGN_RECOVERY_REQUIRED` вместо
 * тихой загрузки старого состояния. MAP-BOUNDARY-03: необработанная ошибка
 * маршрута завершает только свой запрос. Без второй правки первая превращала
 * одну повреждённую кампанию в падение сервера для всех: первый же
 * `GET /api/rooms/:id` ронял процесс с кодом 1.
 */

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'recovery-setup',
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* не JSON */ }
  return { response, status: response.status, body: parsed, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

/** Каталог журнала кампании: `<storage>/engine/campaigns/<КОД>-<хеш>`. */
function campaignDirectory(storage, code) {
  const root = join(storage, 'engine', 'campaigns')
  const name = readdirSync(root).find((entry) => entry.startsWith(`${code}-`))
  assert.ok(name, `нет каталога журнала кампании ${code}`)
  return join(root, name)
}

/**
 * Повреждение, которое журнал больше не прощает молча: последний коммит, если
 * коммиты есть, иначе единственный seed-снимок v0.
 */
function damageCampaign(directory) {
  const events = join(directory, 'events')
  const commits = existsSync(events) ? readdirSync(events).sort() : []
  if (commits.length) {
    rmSync(join(events, commits.at(-1)))
    return 'EVENT_LOG_TAIL_MISSING'
  }
  const snapshots = join(directory, 'snapshots')
  const seed = readdirSync(snapshots).sort()[0]
  assert.ok(seed, 'нет ни коммитов, ни снимков — повреждать нечего')
  rmSync(join(snapshots, seed))
  return 'SEED_SNAPSHOT_MISSING'
}

test('повреждённая кампания отвечает отказом, а сервер обслуживает остальные (аудит PR #131, RCV-01/02 + MAP-BOUNDARY-03)', { timeout: runnerTimeout(120_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-recovery-api-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { name: 'Owner', email: 'recovery-owner@test.local', password: 'secure-owner-password' } })
  const cookie = sessionCookie(owner)
  for (const [code, name] of [['RECOVA', 'Повреждённая'], ['RECOVB', 'Целая']]) {
    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST', cookie,
      body: { code, name, bootstrap: { partyName: 'Один', players: [{ id: 'hero-1' }] } },
    })
    assert.equal(created.status, 201, created.text)
  }
  assert.equal((await request(baseUrl, '/api/rooms/RECOVA', { cookie })).status, 200)

  // Файл теряется, пока сервер выключен: так выглядит восстановление из
  // неполной копии или сбой диска, а не действие игрока.
  await stopServer(child)
  const reason = damageCampaign(campaignDirectory(storage, 'RECOVA'))
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const damaged = await request(baseUrl, '/api/rooms/RECOVA', { cookie })
  assert.ok(damaged.status >= 500, `повреждённая кампания не должна открываться молча (${reason}): ${damaged.status} ${damaged.text}`)
  assert.equal(child.exitCode, null, `сервер упал на повреждённой кампании\n${logs}`)
  assert.match(logs, /CAMPAIGN_RECOVERY_REQUIRED|Необработанная ошибка/u, 'отказ виден в журнале сервера')

  // Сервер жив и обслуживает остальных.
  assert.equal((await request(baseUrl, '/api/health')).status, 200)
  const healthy = await request(baseUrl, '/api/rooms/RECOVB', { cookie })
  assert.equal(healthy.status, 200, healthy.text)
  // Повтор запроса к повреждённой кампании отказывает так же и процесс не роняет.
  assert.ok((await request(baseUrl, '/api/rooms/RECOVA', { cookie })).status >= 500)
  assert.equal(child.exitCode, null, `сервер упал на повторном запросе\n${logs}`)
})
