import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился с кодом ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Тестовый сервер не запустился')
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill()
  })
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

test('HTTP-каталог не раскрывает полный шаблон, а POST создаёт server-owned авторский мир', { timeout: runnerTimeout(30_000) }, async (t) => {
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-world-template-api-'))
  let logs = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'world-template-setup', COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => { await stopServer(child) })
  await waitForHealth(baseUrl, child)

  const unauthorized = await request(baseUrl, '/api/world-templates')
  assert.equal(unauthorized.status, 401)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Admin', email: 'world-template-admin@example.test', password: 'very-secure-password', setupToken: 'world-template-setup' },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${logs}`)
  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Cartographer', email: 'cartographer@example.test', password: 'very-secure-player-password' },
  })
  assert.equal(registered.status, 201, registered.text)
  const cookie = registered.response.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie)

  const catalog = await request(baseUrl, '/api/world-templates', { cookie })
  assert.equal(catalog.status, 200, catalog.text)
  assert.equal(catalog.body.templates.length, 4)
  assert.deepEqual(catalog.body.templates.map((template) => template.id), [
    'league-nine-tides', 'unfading-star-belt', 'ashen-garden-bowl', 'astohan-plains',
  ])
  for (const template of catalog.body.templates) {
    assert.equal(Object.hasOwn(template, 'worldMap'), false)
    assert.equal(Object.hasOwn(template, 'world_map'), false)
    assert.equal(Object.hasOwn(template, 'worldHistory'), false)
    assert.match(template.image, /^\/assets\/maps\/world\/skazanie\/.+-v[1-9][0-9]*\.webp$/u)
    assert.equal(template.locationCount, 14)
    assert.equal(template.routeCount, 18)
    assert.equal(template.cityOverviewCount, 1)
  }

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: {
      code: 'TIDE-TEMPLATE', name: '',
      bootstrap: {
        partyName: '', slotCount: 1, rulesetId: 'srd_5_2_1', worldTemplateId: 'league-nine-tides',
        world: { premise: 'Подмена', startingLocation: 'Подмена', boundaries: 'Без боди-хоррора' },
      },
    },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)
  assert.equal(created.body.state.campaign, 'Лига Девяти Отливов')
  assert.equal(created.body.state.campaignConcept.world_template_id, 'league-nine-tides')
  assert.equal(created.body.state.campaignConcept.generatedBy, 'authored-world-template')
  assert.equal(created.body.state.campaignConcept.boundaries, 'Без боди-хоррора')
  assert.notEqual(created.body.state.campaignConcept.premise, 'Подмена')
  assert.equal(created.body.state.scene.location, 'Вельдбург')
  assert.equal(created.body.state.worldMap.locations.length, 14)
  assert.equal(created.body.state.worldMap.routes.length, 18)
  assert.equal(created.body.state.worldMap.backgroundImage, '/assets/maps/world/skazanie/nine-tides-v2.webp')
  const cityOverview = created.body.state.worldMap.locations.find((location) => location.id === 'tides-veld-burg').cityOverview
  assert.equal(cityOverview.image, '/assets/maps/city/skazanie/veld-burg-v1.webp')
  assert.equal(cityOverview.districts.length, 6)
  assert.equal(cityOverview.places.length, 10)

  const unknown = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'TEMPLATE-BAD', bootstrap: { partyName: '', slotCount: 1, world: {}, worldTemplateId: 'invented-world' } },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'WORLD_TEMPLATE_INVALID')

  const forgedVersion = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'TEMPLATE-FORGE', bootstrap: { partyName: '', slotCount: 1, world: {}, worldTemplateId: 'league-nine-tides', worldTemplateVersion: '999' } },
  })
  assert.equal(forgedVersion.status, 400)
  assert.equal(forgedVersion.body.code, 'WORLD_TEMPLATE_FIELDS_SERVER_OWNED')

  const forgedMap = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'TEMPLATE-MAP-FORGE', bootstrap: { partyName: '', slotCount: 1, world: {}, worldMap: { locations: [] } } },
  })
  assert.equal(forgedMap.status, 400)
  assert.equal(forgedMap.body.code, 'WORLD_TEMPLATE_FIELDS_SERVER_OWNED')
})
