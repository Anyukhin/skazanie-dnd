// Иллюстрации локаций через живой HTTP: подготовка заранее и рантайм только из
// кеша.
//
// Рантайм-флаг здесь намеренно выключен — это боевая настройка стола. Сторож
// проверяет, что при выключенном флаге подготовка всё равно работает, а
// игровой путь не зовёт модель ни разу.
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const WEBP = Buffer.from('524946460400000057454250', 'hex')

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer({ port, storage, providerBaseUrl, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: 'location-api-test-key',
      ROUTERAI_BASE_URL: providerBaseUrl,
      DND_IMAGE_MODEL: 'test/location-image-v1',
      DND_RUNTIME_IMAGE_GENERATION: 'off',
      DND_AI_MODEL: 'test/text-model',
      DND_AI_FALLBACK_MODELS: '',
      ADMIN_SETUP_TOKEN: 'location-api-setup',
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body, headers } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : null }
  catch { throw new Error(`Ожидался JSON, получено: ${text}`) }
}

function cookie(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

function campaignState() {
  return {
    sessionCode: 'LOCATION-ART',
    campaign: 'Иллюстрации локаций',
    partyName: 'Отряд',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero',
      name: 'Player',
      character: 'Ада',
      hp: 10,
      maxHp: 10,
      armor: 12,
      proficiency: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      inventory: [],
      online: true,
    }],
    merchants: [],
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    scene: {
      title: 'Разбитый обоз',
      location: 'Норвинский тракт',
      location_id: 'loc-norvin-road',
      mood: 'Тревожно',
      objective: 'Найти уцелевших',
      turn: 1,
      cells: [],
    },
    mechanics: { world_time: { elapsed_minutes: 60 } },
    adventure: { chapter: 1, history: [], visitedLocations: ['Норвинский тракт'] },
    worldMap: {
      version: 1,
      seed: 'location-art-seed',
      name: 'Норвин',
      width: 1000,
      height: 640,
      currentLocationId: 'loc-norvin-road',
      regions: [{ id: 'reg:north', name: 'Север', biome: 'plains', x: 10, y: 10, radius: 100 }],
      locations: [{
        id: 'loc-norvin-road', name: 'Норвинский тракт', kind: 'landmark',
        x: 10, y: 10, regionId: 'reg:north', summary: 'Разбитая дорога', known: true, visited: true,
      }],
      routes: [],
    },
    worldMemory: {
      entities: [
        { id: 'loc-norvin-road', kind: 'location', name: 'Норвинский тракт', summary: 'Разбитая дорога', visibility: 'party', aliases: [], tags: [] },
        { id: 'loc:cult-lair', kind: 'location', name: 'Логово культа', summary: 'GM_ONLY_SUMMARY', visibility: 'gm_only', aliases: [], tags: [] },
      ],
      facts: [],
      relationships: [],
      quests: [],
      threads: [],
      epistemic_claims: [],
      summaries: [],
      knowledge_ledger: [],
    },
  }
}

test('иллюстрации локаций готовятся заранее, а в игре берутся только из кеша', { timeout: runnerTimeout(40_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-location-art-api-'))
  let logs = ''
  let child = null
  const imageRequests = []
  const provider = createHttpServer(async (req, res) => {
    if (req.url !== '/api/v1/images' || req.method !== 'POST') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end('{"error":"text model disabled in location test"}')
    }
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    imageRequests.push(JSON.parse(raw))
    // Каждая генерация даёт свои байты: одинаковые скрыли бы главное в проверке
    // перегенерации — новый ETag и новую картинку у уже открытой вкладки.
    const bytes = imageRequests.length === 1 ? WEBP : Buffer.concat([WEBP, Buffer.from([imageRequests.length])])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      data: [{ b64_json: bytes.toString('base64') }],
      usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      cost: 0.03,
    }))
  })
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  const providerAddress = provider.address()
  const providerPort = typeof providerAddress === 'object' && providerAddress ? providerAddress.port : 0
  t.after(async () => {
    await stopServer(child)
    await new Promise((resolve) => provider.close(() => resolve()))
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer({
    port,
    storage,
    providerBaseUrl: `http://127.0.0.1:${providerPort}/api/v1`,
    appendLog: (chunk) => { logs += chunk },
  })
  await waitForHealth(baseUrl, child, () => logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'GM', email: 'gm@location.test', password: 'very-secure-admin-password', setupToken: 'location-api-setup' },
  })
  assert.equal(setup.status, 201, logs)
  const adminCookie = cookie(setup)
  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Ада', email: 'player@location.test', password: 'very-secure-player-password' },
  })
  assert.equal(player.status, 201, logs)
  const playerCookie = cookie(player)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: 'LOCATION-ART', name: 'Иллюстрации локаций', state: campaignState() },
  })
  assert.equal(created.status, 201, `${await created.text()}\n${logs}`)
  const users = await json(await request(baseUrl, '/api/admin/users', { cookie: adminCookie }))
  const playerUser = users.users.find((candidate) => candidate.email === 'player@location.test')
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  })
  assert.equal(assigned.status, 200, `${await assigned.text()}\n${logs}`)

  const roadPath = `/api/campaigns/LOCATION-ART/locations/${encodeURIComponent('loc-norvin-road')}/illustration`
  const lairPath = `/api/campaigns/LOCATION-ART/locations/${encodeURIComponent('loc:cult-lair')}/illustration`

  // Пока картинки нет — честный 404 и ни одного обращения к модели.
  const anonymous = await request(baseUrl, roadPath)
  assert.equal(anonymous.status, 401)
  const absent = await request(baseUrl, roadPath, { cookie: playerCookie })
  assert.equal(absent.status, 404)
  assert.equal((await json(absent)).code, 'LOCATION_ILLUSTRATION_ABSENT')
  assert.equal(imageRequests.length, 0, 'рантайм не зовёт модель даже за отсутствующей картинкой')

  // Закрытая локация для игрока не существует: ни картинки, ни подтверждения,
  // что такое место вообще есть.
  const hiddenForPlayer = await request(baseUrl, lairPath, { cookie: playerCookie })
  assert.equal(hiddenForPlayer.status, 404)
  assert.equal((await json(hiddenForPlayer)).code, 'LOCATION_NOT_VISIBLE')
  const traversal = await request(
    baseUrl,
    `/api/campaigns/LOCATION-ART/locations/${encodeURIComponent('../../auth.json')}/illustration`,
    { cookie: playerCookie },
  )
  assert.equal(traversal.status, 404)

  // Список подготовки честен: обе локации известны ведущему, картинок нет.
  const listed = await json(await request(baseUrl, '/api/campaigns/LOCATION-ART/asset-preparation', { cookie: adminCookie }))
  assert.equal(listed.runtime_image_generation, false)
  assert.deepEqual(
    listed.location_illustrations.map((entry) => [entry.id, entry.name, entry.has_illustration]),
    [['loc-norvin-road', 'Норвинский тракт', false], ['loc:cult-lair', 'Логово культа', false]],
  )
  const playerForbidden = await request(baseUrl, '/api/campaigns/LOCATION-ART/asset-preparation', { cookie: playerCookie })
  assert.equal(playerForbidden.status, 403)

  // Подготовка работает при выключенном рантайм-флаге — иначе картинку было бы
  // неоткуда взять.
  const prepared = await request(baseUrl, '/api/campaigns/LOCATION-ART/asset-preparation', {
    method: 'POST', cookie: adminCookie, body: { location_ids: ['loc-norvin-road'] },
  })
  const preparedBody = await json(prepared)
  assert.equal(prepared.status, 200, `${JSON.stringify(preparedBody)}\n${logs}`)
  assert.deepEqual(preparedBody.prepared, [{ id: 'loc-norvin-road', kind: 'location_illustration', status: 'ready' }])
  assert.equal(imageRequests.length, 1)
  assert.equal(imageRequests[0].model, 'test/location-image-v1')
  assert.equal(imageRequests[0].aspect_ratio, '16:9', 'широкий кадр под шапку сцены')
  assert.match(imageRequests[0].prompt, /Норвинский тракт/u)
  assert.doesNotMatch(imageRequests[0].prompt, /GM_ONLY_SUMMARY/u)

  const usage = await json(await request(baseUrl, '/api/admin/usage', { cookie: adminCookie }))
  assert.equal(usage.usage.completed_requests, 1, 'расход подготовки виден ведущему')
  assert.equal(usage.usage.provider_cost, 0.03)

  // Игрок должен уметь построить адрес картинки. `scene.location_id` в его
  // проекции нет и не будет — id текущего места он берёт из карты мира, и это
  // ровно тот же ключ, под которым ведущий готовил иллюстрацию.
  const playerRoom = await json(await request(baseUrl, '/api/rooms/LOCATION-ART', { cookie: playerCookie }))
  const playerState = playerRoom.state
  assert.equal(playerState.scene.location_id, undefined, 'публичная сцена id локации не несёт')
  assert.equal(playerState.worldMap.currentLocationId, 'loc-norvin-road', 'запасной источник id для клиента')

  // Теперь игрок получает картинку — из кеша, без обращения к модели.
  const served = await request(baseUrl, roadPath, { cookie: playerCookie })
  assert.equal(served.status, 200, logs)
  assert.equal(served.headers.get('content-type'), 'image/webp')
  assert.equal(served.headers.get('x-location-illustration-cache'), 'hit')
  // Адрес иллюстрации один на всю жизнь локации, версии в нём нет. Час
  // `max-age` означал бы, что после перегенерации ведущий заплатил за новую
  // картинку и целый вечер видит прежнюю.
  assert.equal(served.headers.get('cache-control'), 'private, no-cache')
  assert.equal(Buffer.from(await served.arrayBuffer()).equals(WEBP), true)
  assert.equal(imageRequests.length, 1)

  const etag = served.headers.get('etag')
  assert.ok(etag)
  const notModified = await request(baseUrl, roadPath, { cookie: playerCookie, headers: { 'If-None-Match': etag } })
  assert.equal(notModified.status, 304)
  assert.equal(imageRequests.length, 1)

  // Уже готовое без перегенерации пропускается, а с ней — перерисовывается.
  const skipped = await request(baseUrl, '/api/campaigns/LOCATION-ART/asset-preparation', {
    method: 'POST', cookie: adminCookie, body: { location_ids: ['loc-norvin-road'] },
  })
  assert.equal(skipped.status, 200)
  assert.deepEqual((await json(skipped)).prepared, [])
  assert.equal(imageRequests.length, 1, 'за ту же картинку второй раз не платим')

  const regenerated = await request(baseUrl, '/api/campaigns/LOCATION-ART/asset-preparation', {
    method: 'POST', cookie: adminCookie, body: { location_ids: ['loc-norvin-road'], regenerate: true },
  })
  assert.equal(regenerated.status, 200)
  assert.equal(imageRequests.length, 2)

  // После «Перегенерировать» открытая вкладка обязана показать новую картинку.
  // Прежний ETag больше не подходит — ответ приходит целиком, а не 304.
  const afterRegeneration = await request(baseUrl, roadPath, { cookie: playerCookie, headers: { 'If-None-Match': etag } })
  assert.equal(afterRegeneration.status, 200, 'старый ETag не должен подтверждать устаревшую картинку')
  assert.notEqual(afterRegeneration.headers.get('etag'), etag)
  assert.equal(Buffer.from(await afterRegeneration.arrayBuffer()).equals(Buffer.concat([WEBP, Buffer.from([2])])), true)

  // Кеш локаций разведён по кампаниям и не хранит ни кода, ни id открытым
  // текстом.
  const cacheRoot = join(storage, 'generated', 'locations')
  const campaignDirectories = readdirSync(cacheRoot)
  assert.equal(campaignDirectories.length, 1)
  assert.match(campaignDirectories[0], /^[a-f0-9]{24}$/u)
  const files = readdirSync(join(cacheRoot, campaignDirectories[0]))
  assert.deepEqual(files.length, 1)
  assert.match(files[0], /^[a-f0-9]{40}\.webp$/u)
  assert.doesNotMatch(`${campaignDirectories[0]}/${files[0]}`, /LOCATION-ART|norvin/u)

  // Закрытая локация: ведущий её готовит, игрок по-прежнему не видит.
  const preparedHidden = await request(baseUrl, '/api/campaigns/LOCATION-ART/asset-preparation', {
    method: 'POST', cookie: adminCookie, body: { location_ids: ['loc:cult-lair'] },
  })
  assert.equal(preparedHidden.status, 200, `${JSON.stringify(await json(preparedHidden))}\n${logs}`)
  assert.equal(imageRequests.length, 3)
  const stillHidden = await request(baseUrl, lairPath, { cookie: playerCookie })
  assert.equal(stillHidden.status, 404)
  assert.equal((await json(stillHidden)).code, 'LOCATION_NOT_VISIBLE')
  const visibleToGm = await request(baseUrl, lairPath, { cookie: adminCookie })
  assert.equal(visibleToGm.status, 200)
})
