// Сквозная проверка игры через два браузерных сеанса. После pnpm build:
// SKAZANIE_RUST_SERVER_BIN=<бинарь с test-hooks> node eval/astohan-browser-run.mjs
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withBrowser } from '../.agent-tasks/browser.mjs'
import { textOverlaps } from '../.agent-tasks/overlap.mjs'
import { REPO_ROOT, setupAdmin, startTestServer } from '../test/kit/http.mjs'

const code = 'ASTOHAN-BROWSER'
const viewport = { width: 1920, height: 1080 }
const timeoutMs = 90_000
const output = resolve(REPO_ROOT, 'tmp', 'astohan-browser-run')
const recipes = JSON.parse(await readFile(new URL('../data/astohan-pilot-builds-v1.json', import.meta.url), 'utf8')).builds
const report = { engine: 'rust', code, steps: [], failures: [], network: [], console: [] }
const context = []
let currentStep = 'подготовка'

function observe(page, seat) {
  page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const failure = exceptionDetails.exception?.description ?? exceptionDetails.text
    report.console.push({ seat, step: currentStep, type: 'exception', text: failure?.slice(0, 280) })
  })
  page.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const message = args.map(arg => String(arg.value ?? arg.description ?? '')).join(' ')
    if (type === 'error' || /WebGLProgram|GL_INVALID|shader error/iu.test(message)) {
      report.console.push({ seat, step: currentStep, type, text: message.slice(0, 280) })
    }
  })
  page.on('Network.responseReceived', ({ response }) => {
    if (response.status < 400) return
    const path = new URL(response.url).pathname
    report.network.push({ seat, step: currentStep, status: response.status, path })
  })
}

async function pointClick(page, point) {
  await page.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function byText(page, selector, text) {
  const query = async (pattern, expected) => {
    const candidates = [...document.querySelectorAll(pattern)]
    const match = candidates.find((node) => node.getClientRects().length && !node.disabled
      && node.textContent.replace(/\s+/gu, ' ').trim().includes(expected))
    if (!match) return null
    match.scrollIntoView({ block: 'center', inline: 'nearest' })
    const box = match.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }
  await page.waitFor(async (pattern, expected) => Boolean([...document.querySelectorAll(pattern)]
    .find(node => node.getClientRects().length && !node.disabled && node.textContent.replace(/\s+/gu, ' ').trim().includes(expected))),
    { args: [selector, text], timeoutMs, label: text })
  const point = await page.evaluate(query, selector, text)
  assert.ok(point, `Кнопка исчезла: ${text}`)
  await pointClick(page, point)
}

async function press(page, key, code = key) {
  const virtualKey = { Home: 36, ArrowDown: 40, Enter: 13, Escape: 27 }[key]
  for (const type of ['keyDown', 'keyUp']) {
    await page.command('Input.dispatchKeyEvent', { type, key, code, ...(virtualKey ? { windowsVirtualKeyCode: virtualKey } : {}) })
  }
}

async function preparePage(page, view, seat) {
  observe(page, seat)
  await page.command('Network.enable')
  await page.command('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })
  await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('skazanie-board-view', ${JSON.stringify(view)});
    localStorage.setItem('skazanie-3d-fps', 'true');
  ` })
}

async function register(page, seat) {
  await page.waitForSelector('.auth-card form', { timeoutMs })
  if (seat === 'owner') await byText(page, '.auth-tabs button', 'Создать аккаунт')
  await page.type('.auth-card input[placeholder="Как к вам обращаться"]', seat === 'owner' ? 'Ведущий стенда' : 'Второй игрок стенда')
  await page.type('.auth-card input[type=email]', `browser-${seat}@astohan.test`)
  await page.type('.auth-card input[type=password]', 'local-astohan-audit-1')
  await page.click('.auth-card .auth-submit')
}

async function createCampaign(page) {
  await byText(page, '.campaign-empty-screen button', 'Кампании и группы')
  await page.click('.campaign-start-wizard')
  await byText(page, 'button.world-template-card', 'Асстоханские равнины')
  await page.type('.world-creator input[placeholder="Создастся автоматически"]', code)
  await byText(page, '.campaign-wizard-actions .primary', 'Продолжить')
  await byText(page, '.slot-count-picker button', '2 игрока')
  const level = '.slot-creator select'
  if (await page.evaluate(selector => document.querySelector(selector).value, level) !== '7') {
    await page.click(level)
    await press(page, 'Home')
    for (let index = 0; index < 6; index += 1) await press(page, 'ArrowDown')
    await press(page, 'Enter')
  }
  assert.equal(await page.evaluate(selector => document.querySelector(selector).value, level), '7')
  await byText(page, '.campaign-wizard-actions .primary', 'Продолжить')
  await byText(page, '.campaign-wizard-actions .primary', 'Создать мир')
}

async function chooseBuild(page, id, name) {
  const recipe = recipes.find(build => build.id === id)
  assert.ok(recipe)
  await byText(page, '.pilot-build-picker button', recipe.label)
  await page.type('.character-creation-wizard input[aria-label="Имя героя"]', name)
  await byText(page, '.character-creation-wizard footer button.primary', 'Создать героя')
  await page.waitFor(() => !document.querySelector('.character-creation-wizard') || Boolean(document.querySelector('.creation-error')?.textContent?.trim()),
    { timeoutMs, label: 'готовый лист принят' })
  const error = await page.evaluate(() => document.querySelector('.creation-error')?.textContent?.trim())
  assert.ok(!error, error)
}

async function invite(page, guestOrigin) {
  await byText(page, 'button[aria-label="Пригласить игрока"]', '')
  await byText(page, '.invite-code button', 'Создать и скопировать')
  await page.waitForSelector('.invite-link')
  const raw = await page.evaluate(() => document.querySelector('.invite-link').value)
  const link = new URL(raw)
  const guest = new URL(guestOrigin)
  link.hostname = guest.hostname
  await press(page, 'Escape')
  return link.href
}

async function room(page) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/rooms/${id}`)
    if (!response.ok) throw new Error(`Чтение комнаты отказало HTTP ${response.status}`)
    return response.json()
  }, code)
}

async function waitRoom(page, predicate, label) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await room(page)
    if (predicate(snapshot.state)) return snapshot.state
    if (Date.now() >= until) throw new Error(`Комната не подтвердила шаг: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 270))
  }
}

function serverSlice(snapshot) {
  const { state } = snapshot
  return {
    version: snapshot.version,
    location: state.scene.location_id, hash: state.scene.map_hash, chapter: state.adventure?.chapter,
    revealedCells: state.scene.cells.filter(cell => cell.revealed).length,
    players: state.players.map(hero => ({ id: hero.id, name: hero.character, level: hero.level, hp: hero.hp, maxHp: hero.maxHp,
      x: hero.x, y: hero.y, resources: hero.combatResources, loadout: state.actor_appearances?.[hero.id]?.loadout })),
    npcs: state.scene_npcs?.map(npc => ({ id: npc.id, name: npc.name, x: npc.x, y: npc.y })),
    turn: state.mechanics?.combat?.initiative?.[state.mechanics?.combat?.active_index ?? 0]?.actor_id,
    check: state.pendingCheck?.check_id, decision: state.agentInteraction?.id,
    chronicle: state.messages.slice(-4).map(message => ({ speaker: message.speaker, text: message.text })),
  }
}

async function displaySlice(page) {
  return page.evaluate(() => {
    const board = document.querySelector('.board3d-canvas,.board-canvas')
    const view = board?.classList.contains('board3d-canvas') ? '3d' : '2d'
    const actors = [...document.querySelectorAll('[data-actor-id]')].flatMap((node) => {
      const cell = node.closest('[data-board3d-cell],[data-cell]')
      if (!cell) return []
      return [{ id: node.dataset.actorId, at: cell.dataset.board3dCell ?? cell.dataset.cell,
        source: cell.dataset.modelSource, model: cell.dataset.modelKey }]
    })
    const status = [...document.querySelectorAll('.player-hud[aria-label]')].find(node => node.getClientRects().length)?.getAttribute('aria-label')
    return { view, actors, status, canvas: board ? { width: board.width, height: board.height, ...board.dataset } : null,
      panels: [...document.querySelectorAll('.player-hud, .map-turn-banner, .scene-who-card, .game-journal, .pending-check-overlay, .agent-interaction')]
        .map(node => node.innerText.trim().slice(0, 340)).filter(Boolean) }
  })
}

async function dismissLevelCelebration(page) {
  if (!await page.evaluate(() => Boolean(document.querySelector('.level-up-backdrop')))) return
  await byText(page, '.level-up-backdrop button', 'Продолжить')
  await page.waitFor(() => !document.querySelector('.level-up-backdrop'), { timeoutMs })
}

async function receipt(id, title, players) {
  const step = { id, title, seats: [] }
  for (const [seat, page] of players) {
    await page.command('Page.bringToFront')
    await dismissLevelCelebration(page)
    await page.waitForSelector('canvas.board-canvas,canvas.board3d-canvas', { timeoutMs })
    const source = serverSlice(await room(page))
    if (seat === 'guest') {
      await page.waitFor(() => Number(document.querySelector('.board3d-canvas')?.dataset.modelParses) > 0
        && Boolean(document.querySelector('[data-model-source="glb"]')), { timeoutMs, label: 'фигурки загружены' })
    }
    const browser = await displaySlice(page)
    const overlaps = await textOverlaps(page, ['.player-hud', '.scene-who-card', '.map-turn-banner', '.pending-check-overlay', '.agent-interaction'])
    const photo = resolve(output, `${id}-${seat}.png`)
    await page.screenshot(photo, { fullPage: false })
    step.seats.push({ seat, source, browser, overlaps, screenshot: photo })
  }
  assert.equal(step.seats[0].source.hash, step.seats[1].source.hash, `${id}: карты расходятся между зрителями`)
  assert.deepEqual(step.seats[0].source.players.map(hero => [hero.id, hero.name, hero.level]), step.seats[1].source.players.map(hero => [hero.id, hero.name, hero.level]), `${id}: отряд зрителей`)
  for (const evidence of step.seats) {
    for (const hero of evidence.source.players) {
      const actor = evidence.browser.actors.find(view => view.id === hero.id)
      assert.equal(actor?.at, `${hero.x},${hero.y}`, `${id} ${evidence.seat}: положение ${hero.name}`)
      if (evidence.browser.view === '3d') assert.equal(actor.source, 'glb', `${hero.name}: фигурка загружена`)
    }
    assert.ok(evidence.source.players.some(hero => evidence.browser.status?.startsWith(`${hero.name}: здоровье ${hero.hp} из ${hero.maxHp}`)),
      `${id} ${evidence.seat}: здоровье в панели отличается от комнаты`)
  }
  report.steps.push(step)
  console.log(id, title)
}

await mkdir(output, { recursive: true })
const server = await startTestServer({ after: callback => context.push(callback) }, { env: { DND_DATA_DIR: REPO_ROOT } })
try {
  // Первичная настройка изолированного инстанса. Владельца и гостя
  // регистрируют страницы, и оба читают обычную проекцию игрока.
  await setupAdmin(server)
  await withBrowser({ gpu: true, pageCount: 2, timeoutMs, windowSize: viewport }, async browser => {
    const owner = browser.page(0)
    const guest = browser.page(1)
    await Promise.all([preparePage(owner, '2d', 'owner'), preparePage(guest, '3d', 'guest')])
    await owner.command('Page.bringToFront')
    const ownerOrigin = server.baseUrl.replace('127.0.0.1', 'localhost')
    try {
      await owner.navigate(ownerOrigin)
      await register(owner, 'owner')
      currentStep = 'Ш1'
      await createCampaign(owner)
      console.log('Ш1', 'мастер создания отправил кампанию')
      await chooseBuild(owner, 'fighter', 'Ингвар')
      console.log('Ш1', 'владелец закончил готовый лист')
      const link = await invite(owner, server.baseUrl)
      await guest.command('Page.bringToFront')
      await guest.navigate(link)
      await register(guest, 'guest')
      await chooseBuild(guest, 'barbarian', 'Бран')
      const created = await waitRoom(guest, state => state.players.length === 2 && state.players.every(hero => hero.level === 7 && !hero.characterSetupRequired), 'оба листа 7-го уровня')
      assert.ok(created.players.every(hero => Object.keys(created.actor_appearances?.[hero.id]?.loadout ?? {}).length), 'открытая экипировка фигур')
      await receipt('01', 'Кампания, приглашение и готовые листы', [['owner', owner], ['guest', guest]])
    } catch (error) {
      report.screenOnFailure = []
      for (const [seat, page] of [['owner', owner], ['guest', guest]]) {
        const screen = await page.evaluate(() => ({
          headings: [...document.querySelectorAll('h1,h2')].map(node => node.innerText).slice(0, 12),
          errors: [...document.querySelectorAll('.creation-error,.auth-error,.admin-error,[role="alert"]')].map(node => node.innerText.slice(0, 250)),
        })).catch(() => null)
        const photo = resolve(output, `failure-${seat}.png`)
        await page.screenshot(photo, { fullPage: false }).catch(() => null)
        report.screenOnFailure.push({ seat, screen, screenshot: photo })
      }
      throw error
    }
  })
} catch (error) {
  report.failures.push({ step: currentStep, error: error.message })
  throw error
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  for (const callback of context.reverse()) await callback()
}
