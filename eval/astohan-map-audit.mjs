// После pnpm build и сборки skazanie-server с test-hooks:
// node eval/astohan-map-audit.mjs [--location astohan-wild-forest]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withBrowser } from '../.agent-tasks/browser.mjs'
import { authoredLocationMapFor, createCampaignState, editMap, serverCall } from '../test/kit/fixtures.mjs'
import { createCampaign, expectStatus, registerUser, REPO_ROOT, setupAdmin, startTestServer } from '../test/kit/http.mjs'

const position = process.argv.indexOf('--location')
const requested = position < 0 ? null : process.argv[position + 1]
if (position >= 0) assert.ok(requested, 'укажите id локации после --location')
const output = 'tmp/astohan-map-audit'
const players = [
  { id: 'audit-lira', character: 'Лира', characterClass: 'fighter' },
  { id: 'audit-toren', character: 'Торен', characterClass: 'cleric' },
].map(hero => ({ ...hero, level: 7, hp: 48, maxHp: 48, inventory: [] }))
const viewport = { width: 1920, height: 1080 }
const views = ['2d', '3d']
const storyProps = {
  'astohan-vulkanis-brazier': ['vulkanis-skull'],
  'astohan-quiet-watch-camp': ['gedrik-war-table'],
  'astohan-forgotten-cliffs': ['sealed-altar', 'falling-stars-mosaic'],
  'astohan-lomar-tower': ['workbench-37', 'lab-star-charts'],
}

async function openRoom(server, admin, guests, initial, location, index, night = false) {
  const id = location.location_id
  const authored = await authoredLocationMapFor(id)
  assert.ok(authored, `${id}: авторская карта не найдена`)
  const { map } = await editMap(authored.map, authored.cells.map(({ x, y }) => ({ cell: [x, y, { revealed: true }] })))
  const seats = map.spawnPoints.filter(point => point.role === 'party')
  const positions = Object.fromEntries(players.map(({ id }, slot) => {
    assert.ok(seats[slot], `${id}: нет авторской точки входа ${slot + 1}`)
    return [id, { x: seats[slot].x, y: seats[slot].y }]
  }))
  const code = `MAP-AUDIT-${index + 1}${night ? '-NIGHT' : ''}`
  await createCampaign(admin, { code, name: location.title, state: {
    ...initial, sessionCode: code, campaign: location.title,
    worldMap: { ...initial.worldMap, currentLocationId: id },
    scene: { title: location.title, location: location.title, location_id: id, map, cells: [] },
    locationMaps: {}, locationLevels: {},
    players: initial.players.map(hero => ({ ...hero, ...positions[hero.id] })),
    mechanics: {
      ...initial.mechanics, positions,
      world_time: { ...initial.mechanics.world_time, elapsed_minutes: night ? 1_080 : 360 },
    },
  } })
  const rooms = await Promise.all(guests.map(async ({ client }, slot) => {
    const { token } = expectStatus(await admin.post(`/api/campaigns/${code}/invites`, { hero_ids: [players[slot].id] }), 201)
    expectStatus(await client.post(`/api/campaigns/${code}/join`, { invite_token: token }))
    return expectStatus(await client.get(`/api/rooms/${code}`)).state
  }))
  const [first, second] = rooms.map(room => room.scene)
  assert.equal(first.map_hash, second.map_hash, `${id}: двум игрокам отданы разные карты`)
  assert.ok(first.map_hash)
  assert.equal(first.map.locationId, id)
  assert.deepEqual(first.map.generator, authored.map.generator)
  assert.deepEqual([first.map.width, first.map.height], [map.width, map.height])
  const edges = first.map.edges
  assert.deepEqual(edges, map.edges, `${id}: проекция изменила рёбра раскрытой карты`)
  const landmarks = (storyProps[id] ?? []).map(suffix => `${id}:${suffix}`)
  for (const prop of landmarks) assert.ok(first.map.props.some(record => record.id === prop), `${id}: на раскрытой карте нет ${prop}`)
  return { code, id, cells: authored.cells.length, width: map.width, height: map.height,
    edges: Buffer.from(edges.cells, 'base64').length / 2, props: first.map.props.length, landmarks, night, weather: rooms[0].weather?.phase }
}

async function preparePage(page, guest, baseUrl, view) {
  const [name, ...value] = guest.client.cookie.split('=')
  await page.command('Network.setCookie', { name, value: value.join('='), url: baseUrl })
  await page.command('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })
  await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('skazanie-board-view', ${JSON.stringify(view)});
    localStorage.setItem('skazanie-3d-fps', 'true');
    window.renderFaults = [];
    window.addEventListener('error', event => { if (event.message) window.renderFaults.push(event.message) });
    const report = console.error.bind(console);
    console.error = (...args) => { window.renderFaults.push(args.map(String).join(' ')); report(...args) };
    window.glbRequests = [];
    const request = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (url.origin !== location.origin || !(url.pathname.endsWith('.glb') || url.pathname === '/assets/models/manifest.json')) return request(input, options);
      try {
        const response = await request(input, options);
        window.glbRequests.push({ path: url.pathname, status: response.status,
          type: response.headers.get('content-type'), bytes: Number(response.headers.get('content-length')) });
        return response;
      } catch (error) {
        window.glbRequests.push({ path: url.pathname, status: null, error: error.name });
        throw error;
      }
    };
  ` })
}

async function capture(page, room, view, baseUrl) {
  await page.command('Page.bringToFront')
  const start = performance.now()
  await page.navigate(`${baseUrl}/?room=${room.code}`)
  const selector = view === '3d' ? 'canvas.board3d-canvas' : 'canvas.board-canvas'
  await page.waitForSelector(selector, { timeoutMs: 60_000 })
  let firstFrameMs = Math.round(performance.now() - start)
  if (view === '3d') {
    await page.waitFor((id) => {
      const canvas = document.querySelector('canvas.board3d-canvas')
      return canvas?.dataset.locationId === id && Number(canvas.dataset.frames) >= 1
    }, { args: [room.id], timeoutMs: 60_000 })
    firstFrameMs = Math.round(performance.now() - start)
    try {
      await page.waitFor(() => {
        const canvas = document.querySelector('canvas.board3d-canvas')
        return Number(canvas?.dataset.modelParses) > 0 && Number(canvas.dataset.modelPending) === 0
          && Boolean(document.querySelector('[data-board3d-cell][data-model-source="glb"]'))
      }, { timeoutMs: 45_000, label: 'GLB разобран и фигурка установлена' })
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        dataset: { ...document.querySelector('canvas.board3d-canvas')?.dataset },
        markers: Array.from(document.querySelectorAll('[data-model-source]'), node => [node.dataset.modelKey, node.dataset.modelSource]),
        requests: window.glbRequests.filter(entry => entry.path.endsWith('manifest.json') || entry.status !== 200).slice(-12),
        errors: window.renderFaults.slice(-4),
      }))
      throw new Error(`${room.id}: не удалось подтвердить GLB на игровой доске. ${JSON.stringify(diagnostics)}`, { cause: error })
    }
  }
  const info = await page.evaluate((selector, mode) => {
    const canvas = document.querySelector(selector)
    const gl = mode === '3d' ? canvas.getContext('webgl2') : null
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return { adapter: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      size: [canvas.width, canvas.height], dataset: { ...canvas.dataset },
      glb: document.querySelectorAll('[data-board3d-cell][data-model-source="glb"]').length,
      glbRequests: window.glbRequests,
      faults: window.renderFaults }
  }, selector, view)
  if (view === '3d') assert.ok(info.adapter, `${room.id}: требуется настоящий WebGL`)
  assert.deepEqual(info.faults, [], `${room.id}, ${view}: ошибка приложения или рендера`)
  await page.screenshot(join(output, `${room.id}${room.night ? '-night' : ''}-${view}.png`), { fullPage: false })
  return { ...info, firstFrameMs, sampleMs: Math.round(performance.now() - start) }
}

async function checkWebglFallback(page, room, baseUrl) {
  await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return type === 'webgl2' || type === 'webgl' ? null : context.call(this, type, ...args);
    };
  ` })
  await page.navigate(`${baseUrl}/?room=${room.code}`)
  await page.waitForSelector('canvas.board-canvas')
  const message = await page.evaluate(() => document.querySelector('.board-view-error')?.textContent)
  assert.match(message ?? '', /Включён вид 2D/u)
  return message
}

const cleanup = []
const server = await startTestServer({ after: callback => cleanup.push(callback) }, { env: { DND_DATA_DIR: REPO_ROOT } })
try {
  const { client: admin } = await setupAdmin(server)
  const guests = await Promise.all(views.map((_, index) => registerUser(server, { name: `Аудитор ${index + 1}` })))
  const scenario = await serverCall('scenarioForWorldTemplate', 'astohan-plains')
  const locations = scenario.locations.filter(location => !requested || location.location_id === requested)
  assert.ok(locations.length, `Нет локации ${requested}`)
  const initial = await createCampaignState({ code: 'MAP-AUDIT', worldTemplateId: 'astohan-plains', players })
  await mkdir(output, { recursive: true })
  const report = []
  await withBrowser({ gpu: true, pageCount: views.length, timeoutMs: 90_000, windowSize: viewport }, async browser => {
    await Promise.all(views.map((view, slot) => preparePage(browser.page(slot), guests[slot], server.baseUrl, view)))
    for (const [index, location] of locations.entries()) {
      const times = location.location_id === 'astohan-forgotten-cliffs' ? [false, true] : [false]
      for (const night of times) {
        const room = await openRoom(server, admin, guests, initial, location, index, night)
        const receipts = {}
        for (const [slot, view] of views.entries()) receipts[view] = await capture(browser.page(slot), room, view, server.baseUrl)
        if (night) {
          const day = report.find(entry => entry.id === room.id && !entry.night)
          assert.equal(room.weather, 'night', `${room.id}: в проекции наступила ночь`)
          assert.ok(Number(receipts['3d'].dataset.darkness) > Number(day.views['3d'].dataset.darkness), `${room.id}: ночной свет темнее дневного`)
        }
        report.push({ ...room, views: receipts })
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
        console.log(room.id, night ? 'ночь' : 'день', room.cells, 'клеток', room.edges, 'рёбер', room.props, 'предметов')
      }
    }
    const last = report.at(-1)
    last.withoutWebgl = await checkWebglFallback(browser.page(1), last, server.baseUrl)
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  })
} finally {
  for (const callback of cleanup.reverse()) await callback()
}
