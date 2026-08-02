import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_IMPROV_MODE,
  IMPROV_MODES,
  currentImprovMode,
  normalizeImprovMode,
  runWithCampaignAiSettings,
} from '../server/campaign-ai-context.mjs'
import { DirectorAgent } from '../server/director-agent.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'improv-setup',
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* starting */ }
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
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

test('режим импровизации нормализуется к «сюжету» и доезжает до Режиссёра', async (t) => {
  assert.deepEqual(Object.keys(IMPROV_MODES).sort(), ['chaos', 'story'])
  assert.equal(DEFAULT_IMPROV_MODE, 'story')
  assert.equal(normalizeImprovMode('chaos'), 'chaos')
  assert.equal(normalizeImprovMode('CHAOS'), 'chaos')
  assert.equal(normalizeImprovMode('sandbox'), 'story')
  assert.equal(normalizeImprovMode(undefined), 'story')
  // Вне запроса контекста кампании нет — режим обязан оставаться дефолтным.
  assert.equal(currentImprovMode(), 'story')

  await runWithCampaignAiSettings({ model: 'primary', narratorStyle: 'neutral', improvMode: 'chaos' }, async () => {
    assert.equal(currentImprovMode(), 'chaos')
    // Значение только прокинуто в трассу: намерение и промпт от него не зависят.
    const decision = await new DirectorAgent().choose({ state: {}, playerAction: 'Осмотреться' })
    assert.equal(decision.trace.improv_mode, 'chaos')
    assert.equal(decision.intent.type, 'continue_exploration')
  })

  const explicit = await new DirectorAgent().choose({ state: {}, playerAction: 'Осмотреться', improvMode: 'мусор' })
  assert.equal(explicit.trace.improv_mode, 'story')
  t.diagnostic('режим импровизации пока не меняет решение Режиссёра — это следующая задача')
})

test('режим импровизации меняет только владелец, переживает перезапуск и отвергает мусор', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-improv-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'improv-owner@test.local', password: 'secure-owner-password' },
  })
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Guest', email: 'improv-guest@test.local', password: 'secure-guest-password' },
  })
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      code: 'IMPROV',
      name: 'Режим импровизации',
      bootstrap: { partyName: 'Двое', players: [{ id: 'hero-1' }, { id: 'hero-2' }] },
    },
  })
  assert.equal(created.status, 201, created.text)

  // Дефолт: новая кампания живёт в «сюжете», пока владелец не решит иначе.
  const initial = await request(baseUrl, '/api/campaigns/IMPROV/settings', { cookie: ownerCookie })
  assert.equal(initial.status, 200, initial.text)
  assert.equal(initial.body.settings.improvMode, 'story')
  assert.deepEqual(initial.body.improvModes.map((mode) => mode.id).sort(), ['chaos', 'story'])
  for (const mode of initial.body.improvModes) {
    assert.ok(mode.label, 'у режима есть подпись для интерфейса')
    assert.ok(mode.description, 'у режима есть короткое русское описание')
  }
  // Счётчик локаций едет тем же ответом, что и режим: интерфейс настроек берёт
  // обе величины одним запросом.
  assert.equal(initial.body.architectGenerationsToday, 0)
  assert.ok(Number.isSafeInteger(initial.body.architectAlertThreshold) && initial.body.architectAlertThreshold > 0)

  // Не-владелец в кампании: настройку видит, но менять не может.
  const invite = await request(baseUrl, '/api/campaigns/IMPROV/invites', {
    method: 'POST',
    cookie: ownerCookie,
    body: { hero_ids: ['hero-2'] },
  })
  assert.equal(invite.status, 201, invite.text)
  assert.equal((await request(baseUrl, '/api/campaigns/IMPROV/join', {
    method: 'POST',
    cookie: guestCookie,
    body: { invite_token: invite.body.token },
  })).status, 200)

  const guestView = await request(baseUrl, '/api/campaigns/IMPROV/settings', { cookie: guestCookie })
  assert.equal(guestView.status, 200, guestView.text)
  assert.equal(guestView.body.canManage, false)
  const guestPatch = await request(baseUrl, '/api/campaigns/IMPROV/settings', {
    method: 'PATCH',
    cookie: guestCookie,
    body: { improvMode: 'chaos' },
  })
  assert.equal(guestPatch.status, 403, guestPatch.text)
  assert.equal(
    (await request(baseUrl, '/api/campaigns/IMPROV/settings', { cookie: ownerCookie })).body.settings.improvMode,
    'story',
    'отказ не должен менять сохранённую настройку',
  )

  // Владелец переводит кампанию в «хаос» по ходу игры.
  const saved = await request(baseUrl, '/api/campaigns/IMPROV/settings', {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { improvMode: 'chaos' },
  })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.body.settings.improvMode, 'chaos')
  assert.equal(saved.body.architectGenerationsToday, 0, 'PATCH возвращает счётчик тем же ответом')
  assert.equal(
    (await request(baseUrl, '/api/campaigns/IMPROV/settings', { cookie: ownerCookie })).body.settings.improvMode,
    'chaos',
  )

  // Смена режима не должна быть молчаливой: игроки видят её в летописи.
  const journal = await request(baseUrl, '/api/rooms/IMPROV', { cookie: ownerCookie })
  assert.equal(journal.status, 200, journal.text)
  const modeMessages = (journal.body.state.messages ?? []).filter((message) => /Режим импровизации изменён/u.test(message.text))
  assert.equal(modeMessages.length, 1, 'ровно одна запись на одну фактическую смену')
  assert.equal(modeMessages[0].speaker, 'system')
  assert.match(modeMessages[0].text, /Хаос/u)

  // Мусор отвергается отдельным кодом и не затирает сохранённый режим.
  const rejected = await request(baseUrl, '/api/campaigns/IMPROV/settings', {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { improvMode: 'anarchy' },
  })
  assert.equal(rejected.status, 400, rejected.text)
  assert.equal(rejected.body.code, 'IMPROV_MODE_INVALID')
  assert.equal(
    (await request(baseUrl, '/api/campaigns/IMPROV/settings', { cookie: ownerCookie })).body.settings.improvMode,
    'chaos',
  )

  // Правка соседнего поля не сбрасывает режим на дефолт.
  const styleOnly = await request(baseUrl, '/api/campaigns/IMPROV/settings', {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { narratorStyle: 'ironic' },
  })
  assert.equal(styleOnly.status, 200, styleOnly.text)
  assert.equal(styleOnly.body.settings.improvMode, 'chaos')
  assert.equal(styleOnly.body.settings.narratorStyle, 'ironic')
  // Запись в летописи одна: PATCH без фактической смены режима её не повторяет.
  const afterStyleOnly = await request(baseUrl, '/api/rooms/IMPROV', { cookie: ownerCookie })
  assert.equal(
    (afterStyleOnly.body.state.messages ?? []).filter((message) => /Режим импровизации изменён/u.test(message.text)).length,
    1,
  )

  // Перезапуск: настройка перечитывается с диска, а не живёт в памяти процесса.
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const recovered = await request(baseUrl, '/api/campaigns/IMPROV/settings', { cookie: ownerCookie })
  assert.equal(recovered.status, 200, recovered.text)
  assert.equal(recovered.body.settings.improvMode, 'chaos')
  assert.equal(recovered.body.settings.narratorStyle, 'ironic')
})
