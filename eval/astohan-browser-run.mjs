// Сквозная проверка игры через два браузерных сеанса. Укажите собранный
// с test-hooks SKAZANIE_RUST_SERVER_BIN, затем выполните pnpm build и
// node eval/astohan-browser-run.mjs --through 5 для первых пяти шагов.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withBrowser } from '../.agent-tasks/browser.mjs'
import { textOverlaps } from '../.agent-tasks/overlap.mjs'
import { REPO_ROOT, setupAdmin, startTestServer } from '../test/kit/http.mjs'
import { readJournal } from '../test/kit/journal.mjs'
import { finishBrowserReport } from './browser-report.mjs'

const code = 'ASTOHAN-BROWSER'
const viewport = { width: 1920, height: 1080 }
const timeoutMs = 90_000
const actionTimeoutMs = 25_000
const outputOption = process.argv.indexOf('--output')
const output = outputOption < 0 ? resolve(REPO_ROOT, 'tmp', 'astohan-browser-run') : resolve(process.argv[outputOption + 1])
const throughOption = process.argv.indexOf('--through')
const totalSteps = 12
const through = throughOption < 0 ? totalSteps : Number(process.argv[throughOption + 1])
assert.ok(Number.isInteger(through) && through >= 1 && through <= totalSteps, 'доступны шаги --through от 1 до 12')
const seedOption = process.argv.indexOf('--seed')
const seed = seedOption < 0 ? (through >= 6 ? 197 : 12) : Number(process.argv[seedOption + 1])
assert.ok(Number.isSafeInteger(seed), 'сид костей должен быть целым числом')
const recipes = JSON.parse(await readFile(new URL('../data/astohan-pilot-builds-v1.json', import.meta.url), 'utf8')).builds
const report = { engine: 'rust', code, seed, mode: through < totalSteps ? 'partial' : 'full', requestedThrough: through,
  steps: [], failures: [], network: [], console: [], shaders: [], compilerWarnings: [] }
const context = []
let currentStep = 'подготовка'

function observe(page, seat) {
  const requests = new Map()
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
  page.on('Network.requestWillBeSent', ({ requestId, request }) => {
    const url = new URL(request.url)
    if (url.protocol === 'http:' || url.protocol === 'https:') requests.set(requestId, url.pathname)
  })
  page.on('Network.responseReceived', ({ response, requestId }) => {
    if (response.status < 400) return
    const path = requests.get(requestId) ?? new URL(response.url).pathname
    report.network.push({ seat, step: currentStep, status: response.status, path })
  })
  page.on('Network.loadingFinished', ({ requestId }) => requests.delete(requestId))
  page.on('Network.loadingFailed', ({ requestId, canceled, errorText }) => {
    const path = requests.get(requestId)
    requests.delete(requestId)
    if (path && !canceled) report.network.push({ seat, step: currentStep, path, error: errorText })
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
    const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    return match.contains(document.elementFromPoint(point.x, point.y)) ? point : null
  }
  await page.waitFor(query, { args: [selector, text], timeoutMs: actionTimeoutMs, label: text || selector })
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
  await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    localStorage.setItem('skazanie-board-view', ${JSON.stringify(view)});
    localStorage.setItem('skazanie-3d-fps', 'true');
    window.astohanShaderLogs = [];
    if (typeof WebGL2RenderingContext === 'undefined') return;
    const gl = WebGL2RenderingContext.prototype;
    const getProgramInfoLog = gl.getProgramInfoLog;
    gl.getProgramInfoLog = function (program) {
      const log = getProgramInfoLog.call(this, program);
      if (log?.trim()) {
        const translated = this.getExtension('WEBGL_debug_shaders');
        const lines = [...new Set([...log.matchAll(/\\((\\d+),/g)].map(match => Number(match[1])))];
        window.astohanShaderLogs.push({ log, linked: Boolean(this.getProgramParameter(program, this.LINK_STATUS)),
          stages: this.getAttachedShaders(program).map(shader => {
            const code = this.getShaderSource(shader) ?? '';
            const hlsl = translated?.getTranslatedShaderSource(shader).split('\\n') ?? [];
            return { type: this.getShaderParameter(shader, this.SHADER_TYPE) === this.VERTEX_SHADER ? 'vertex' : 'fragment',
              name: code.match(/#define SHADER_NAME (.+)/)?.[1], material: code.match(/#define SHADER_TYPE (.+)/)?.[1],
              translatedLines: lines.flatMap(number => hlsl[number - 1] ? [{ number, text: hlsl[number - 1].trim() }] : []) };
          }) });
      }
      return log;
    };
  })();` })
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
  await byText(page, '.campaign-start-wizard', 'Создать полностью новую кампанию')
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
    geometry: { width: state.scene.map?.width, height: state.scene.map?.height, generator: state.scene.map?.generator?.id,
      props: state.scene.map?.props?.map(prop => prop.id) ?? [] },
    players: state.players.map(hero => ({ id: hero.id, name: hero.character, level: hero.level, hp: hero.hp, maxHp: hero.maxHp,
      x: hero.x, y: hero.y, resources: hero.combatResources, loadout: state.actor_appearances?.[hero.id]?.loadout })),
    npcs: state.scene_npcs?.map(npc => ({ id: npc.id, name: npc.name, x: npc.x, y: npc.y })),
    turn: state.mechanics?.combat?.initiative?.[state.mechanics?.combat?.active_index ?? 0]?.actor_id,
    initiative: state.mechanics?.combat?.initiative?.map(entry => ({ id: entry.actor_id, value: entry.total,
      name: state.players.find(actor => actor.id === entry.actor_id)?.character
        ?? state.enemies?.find(actor => actor.id === entry.actor_id)?.name })),
    phase: state.turn_phase_actor_ids,
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
    const frame = document.querySelector('.board-frame')
    const cells2d = frame ? ['--board-columns', '--board-rows'].map(name => Number(getComputedStyle(frame).getPropertyValue(name))) : null
    const initiative = [...document.querySelectorAll('.initiative-ribbon.combat li button')].map(node => ({
      number: Number(node.querySelector('.initiative-order')?.textContent), label: node.getAttribute('aria-label'),
      active: node.closest('li')?.getAttribute('aria-current') === 'step',
    }))
    return { view, actors, status, cells2d, canvas: board ? { width: board.width, height: board.height, ...board.dataset } : null,
      initiative,
      panels: [...document.querySelectorAll('.player-hud, .map-turn-banner, .scene-who-card, .server-column .messages, .pending-check-overlay, .agent-interaction')]
        .map(node => node.innerText.trim().slice(-340)).filter(Boolean) }
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
      await page.waitFor((id) => {
        const canvas = document.querySelector('.board3d-canvas')
        return canvas?.dataset.locationId === id && Number(canvas.dataset.modelParses) > 0
          && Boolean(document.querySelector('[data-model-source="glb"]'))
      }, { args: [source.location], timeoutMs, label: 'фигурки загружены на текущей карте' })
    }
    const browser = await displaySlice(page)
    const overlaps = await textOverlaps(page, ['.player-hud', '.scene-who-card', '.map-turn-banner', '.initiative-ribbon', '.pending-check-overlay', '.agent-interaction'])
    const photo = resolve(output, `${id}-${seat}.png`)
    await page.screenshot(photo, { fullPage: false })
    step.seats.push({ seat, source, browser, overlaps, screenshot: photo })
  }
  assert.equal(step.seats[0].source.hash, step.seats[1].source.hash, `${id}: карты расходятся между зрителями`)
  assert.deepEqual(step.seats[0].source.players.map(hero => [hero.id, hero.name, hero.level]), step.seats[1].source.players.map(hero => [hero.id, hero.name, hero.level]), `${id}: отряд зрителей`)
  for (const evidence of step.seats) {
    if (evidence.browser.view === '2d') {
      assert.deepEqual(evidence.browser.cells2d, [evidence.source.geometry.width, evidence.source.geometry.height],
        `${id}: размеры карты 2D отличаются от комнаты`)
    } else {
      assert.equal(evidence.browser.canvas.locationId, evidence.source.location, `${id}: 3D отстаёт от комнаты`)
    }
    for (const hero of evidence.source.players) {
      const actor = evidence.browser.actors.find(view => view.id === hero.id)
      assert.equal(actor?.at, `${hero.x},${hero.y}`, `${id} ${evidence.seat}: положение ${hero.name}`)
      if (evidence.browser.view === '3d') assert.equal(actor.source, 'glb', `${hero.name}: фигурка загружена`)
    }
    assert.ok(evidence.source.players.some(hero => evidence.browser.status?.startsWith(`${hero.name}: здоровье ${hero.hp} из ${hero.maxHp}`)),
      `${id} ${evidence.seat}: здоровье в панели отличается от комнаты`)
  }
  step.coverage = 'completed'
  report.steps.push(step)
  console.log(id, title)
}

async function openNpc(page, name) {
  await page.command('Page.bringToFront')
  await dismissLevelCelebration(page)
  await byText(page, '.scene-who-row', name)
  await page.waitForSelector('.npc-dialog [type=submit]', { timeoutMs: actionTimeoutMs })
}

async function chooseDialogue(page, text) {
  await byText(page, '.npc-dialogue-options button', text)
}

async function rollDisplayedCheck(page, server, previousCount) {
  await page.waitForSelector('.pending-check-overlay .dice-copy', { timeoutMs })
  const card = await page.evaluate(() => ({
    label: document.querySelector('.pending-check-overlay .dice-copy strong')?.textContent,
    dc: Number(document.querySelector('.pending-check-overlay .dice-arch-dc b')?.textContent),
  }))
  assert.ok(Number.isFinite(card.dc) && card.dc > 0, 'в карточке видна сложность')
  await byText(page, '.pending-check-overlay .d20-button', 'Бросить')
  const until = Date.now() + timeoutMs
  for (;;) {
    const journal = await readJournal(server, code)
    const check = journal.events.slice(previousCount).find(event => event.event_type === 'AbilityCheckResolved')
    if (check) {
      assert.equal(check.payload.difficulty, card.dc, 'СЛ карточки совпала с событием')
      return { card, check: { type: check.event_type, actor: check.actor_id, payload: check.payload } }
    }
    if (Date.now() > until) throw new Error('Бросок на странице не появился в журнале Rust')
    await new Promise(resolve => setTimeout(resolve, 350))
  }
}

async function audience(owner, server, viewerSeats) {
  await openNpc(owner, 'Король Арес')
  await chooseDialogue(owner, 'Какое поручение вы даёте нам')
  const journalBefore = await readJournal(server, code)
  const question = 'Почему вы отводите взгляд при имени Вулканиса?'
  const badge = await owner.evaluate(label => [...document.querySelectorAll('.npc-dialogue-options button')]
    .find(button => button.textContent.includes(label))?.querySelector('.npc-dialogue-check')?.textContent, question)
  assert.match(badge, /Проницательность · СЛ 17/iu)
  await chooseDialogue(owner, question)
  const conversation = await waitRoom(owner, state => state.social?.conversations?.some(turn => turn.player_message === question), 'ответ Ареса')
  const answer = conversation.social.conversations.find(turn => turn.player_message === question).npc_reply
  await owner.waitFor(text => document.querySelector('.npc-dialogue-greeting')?.textContent === text,
    { args: [answer], timeoutMs, label: 'реплика Ареса в окне разговора' })
  const afterQuestion = (await readJournal(server, code)).events.slice(journalBefore.events.length)
  const choice = afterQuestion.find(event => event.event_type === 'DialogueOptionChosen' && event.payload.label === question)
  const check = afterQuestion.find(event => event.event_type === 'AbilityCheckResolved' && event.actor_id === choice?.actor_id)
  assert.ok(check, 'вариант Ареса открыл один серверный бросок')
  assert.equal(choice.payload.check.dc, 17)
  assert.equal(choice.payload.check.skill, 'insight')
  assert.equal(choice.payload.check.total, check.payload.total)
  assert.equal(choice.payload.reply, answer)
  const result = { question, badge, answer, check: choice.payload.check }
  console.log('Ш2', 'проверка зафиксирована в журнале Rust')
  const coins = state => state.players.reduce((sum, { currency: amount }) =>
    sum + (amount?.platinum ?? 0) * 1_000 + (amount?.gold ?? 0) * 100 + (amount?.silver ?? 0) * 10 + (amount?.copper ?? 0), 0)
  const wealthBefore = coins((await room(owner)).state)
  if (!await owner.evaluate(() => Boolean(document.querySelector('.npc-dialogue-options')))) await openNpc(owner, 'Король Арес')
  await chooseDialogue(owner, 'Мы возьмём королевский кошель')
  const withPurse = await waitRoom(owner, state => coins(state) > wealthBefore, 'золото королевского кошеля')
  console.log('Ш2', 'кошель зачислен')
  await chooseDialogue(owner, 'Покажите королевскую оружейную')
  await chooseDialogue(owner, 'Беру длинный меч +1')
  const weapon = 'Длинный меч +1'
  const withWeapon = await waitRoom(owner, state => state.players[0].inventory?.some(item => item.name === weapon), 'вещь из оружейной')
  const item = withWeapon.players[0].inventory.find(entry => entry.name === weapon)
  if (await owner.evaluate(() => Boolean(document.querySelector('.npc-dialog')))) {
    await byText(owner, '.npc-dialog button[aria-label="Закрыть разговор"]', '')
  }
  await byText(owner, 'button', 'Вещи')
  await owner.waitForSelector('.inv-coins', { timeoutMs: actionTimeoutMs })
  const purseInSheet = await owner.evaluate(() => document.querySelector('.inv-coins').textContent.trim())
  const currency = withWeapon.players[0].currency
  for (const [denomination, label] of [['gold', 'зм'], ['silver', 'см'], ['copper', 'мм'], ['platinum', 'пм']]) {
    if (currency[denomination] || denomination !== 'platinum') assert.ok(purseInSheet.includes(`${currency[denomination]} ${label}`))
  }
  if (!item.equipped) {
    await byText(owner, `button[title="${weapon}"]`, weapon)
    await byText(owner, '.inv-detail-actions button', 'Надеть')
    await waitRoom(owner, state => state.players[0].inventory?.some(entry => entry.id === item.id && entry.equipped), 'меч экипирован')
  }
  const sheet = resolve(output, '02-inventory.png')
  await owner.screenshot(sheet, { fullPage: false })
  await byText(owner, 'button', 'Игра')
  await receipt('02', 'Аудиенция, проверка, королевский кошель и оружейная', viewerSeats)
  const step = report.steps.at(-1)
  for (const { source } of step.seats) {
    assert.deepEqual(source.players.find(hero => hero.id === choice.actor_id)?.loadout?.main_hand,
      { model_key: 'longsword', variant: 'enchanted' }, 'оба зрителя видят зачарованный клинок')
  }
  step.audience = { ...result, copperBefore: wealthBefore, copperAfter: coins(withPurse), purseInSheet, weapon, itemId: item.id, sheet }
}

async function freeDialogueAndCheck(owner, server, viewerSeats) {
  const action = 'Я внимательно осматриваю зал, ищу скрытые следы недавней драки.'
  const baseline = await readJournal(server, code)
  await owner.command('Page.bringToFront')
  await owner.type('.dialogue-composer textarea', action)
  await byText(owner, '.dialogue-composer button[type=submit]', 'Отправить')
  const check = await rollDisplayedCheck(owner, server, baseline.events.length)
  assert.equal(check.check.payload.skill, 'perception')
  assert.match(check.card.label, /Восприятие/u)
  assert.equal(check.check.payload.player_rolled, true)
  await owner.waitFor(() => !document.querySelector('.pending-check-overlay'), { timeoutMs, label: 'карточка проверки закрылась после результата' })
  console.log('Ш3', 'свободная проверка зафиксирована в журнале Rust')
  await openNpc(owner, 'Орен Фаль')
  const text = 'Мастер Орен, кто был в отряде Ареса во время похода на Вулканиса?'
  const before = await readJournal(server, code)
  await owner.type('.npc-dialog input[placeholder^="Сказать"]', text)
  await byText(owner, '.npc-dialog button[type=submit]', 'Сказать')
  const until = Date.now() + timeoutMs
  let reply
  while (!reply) {
    const journal = await readJournal(server, code)
    reply = journal.events.slice(before.events.length).find(event => event.event_type === 'NpcConversationRecorded'
      && event.payload.conversation?.player_message === text)
    if (Date.now() > until) throw new Error('В журнале Rust нет реплики Орена')
    if (!reply) await new Promise(resolve => setTimeout(resolve, 350))
  }
  const answer = reply.payload.conversation.npc_reply
  await owner.waitFor(text => document.querySelector('.npc-dialogue-greeting')?.textContent === text,
    { args: [answer], timeoutMs: actionTimeoutMs, label: 'свободная реплика Орена в окне разговора' })
  const dialogue = resolve(output, '03-dialogue.png')
  await owner.screenshot(dialogue, { fullPage: false })
  await press(owner, 'Escape')
  await owner.waitFor(() => !document.querySelector('.npc-dialog'), { timeoutMs: actionTimeoutMs, label: 'Escape закрыл разговор' })
  const version = (await readJournal(server, code)).state_version
  assert.ok(version > baseline.state_version, 'проверка и разговор сохранены в состоянии кампании')
  await receipt('03', 'Свободная заявка и свободный разговор', viewerSeats)
  report.steps.at(-1).freeAction = { action, check, question: text, reply: answer, versionBefore: baseline.state_version, version, dialogue }
}

async function travelToAshWatch(owner, guest, server, viewerSeats, finish) {
  const before = await readJournal(server, code)
  await owner.command('Page.bringToFront')
  await byText(owner, 'button[title="Глобальная карта"], button[aria-label="Мир"]', 'Мир')
  await byText(owner, '.world-map-places button', 'Пепельная застава')
  const routeScreenshot = resolve(output, '04-route.png')
  await owner.screenshot(routeScreenshot, { fullPage: false })
  await byText(owner, 'button.travel-button', 'Предложить отряду этот путь')
  const proposed = await waitRoom(owner, state => state.agentInteraction?.status === 'open', 'предложение пути отряду')
  const route = proposed.agentInteraction
  assert.equal(route.destinationLocationId, 'astohan-ash-watch', 'пункт назначения записан в решении')
  const ballots = []
  for (const [seat, page] of viewerSeats) {
    await page.command('Page.bringToFront')
    await page.waitForSelector('.agent-interaction .agent-options', { timeoutMs: actionTimeoutMs })
    const seen = (await room(page)).state.agentInteraction
    assert.equal(seen?.id, route.id, 'обе сессии получили одно голосование')
    const panel = await page.evaluate(() => document.querySelector('.agent-interaction').innerText.trim())
    assert.ok(panel.includes(seen.title), 'заголовок голосования совпадает с комнатой')
    const overlaps = await textOverlaps(page, ['.agent-interaction'])
    const screenshot = resolve(output, `04-${seat}.png`)
    await page.screenshot(screenshot, { fullPage: false })
    ballots.push({ seat, panel, overlaps, screenshot })
  }
  const choice = route.options.find(option => /пепельн|идти|отправить|соглас/iu.test(option.label))
  assert.ok(choice, 'в голосовании есть предложение пути')
  for (const page of [owner, guest]) {
    await page.command('Page.bringToFront')
    await byText(page, '.agent-options button', choice.label)
  }
  const arrived = await waitRoom(owner, state => state.scene.location_id === 'astohan-ash-watch', 'переход на Пепельную заставу')
  const journal = await readJournal(server, code)
  const events = journal.events.slice(before.events.length)
  const votes = events.filter(event => event.event_type === 'PartyVoteCast' && event.payload.interaction_id === route.id)
  assert.equal(votes.length, 2, 'записаны два отдельных голоса')
  assert.equal(new Set(votes.map(vote => vote.payload.voter_id)).size, 2, 'голосовали два аккаунта')
  assert.ok(votes.every(vote => vote.payload.option_id === choice.id), 'оба голоса за путь')
  const transitions = events.filter(event => event.event_type === 'SceneAdvanced')
  assert.equal(transitions.length, 1, 'решение отряда совершило один переход')
  assert.equal(arrived.adventure.chapter, before.state.adventure.chapter + 1, 'открыта одна глава')
  const step = { id: '04', title: 'Путь на карте мира и два голоса', coverage: 'completed',
    decision: route.id, option: choice.label, transition: transitions[0].event_type, routeScreenshot, ballots,
    votes: votes.map(vote => vote.actor_id), chapterBefore: before.state.adventure.chapter, chapter: arrived.adventure.chapter }
  report.steps.push(step)
  console.log('04', step.title)
  if (!finish) return
  currentStep = 'Ш5'
  await receipt('05', 'Карта Пепельной заставы в двух представлениях', viewerSeats)
  for (const seat of report.steps.at(-1).seats) {
    assert.equal(seat.source.location, 'astohan-ash-watch')
    assert.equal(seat.source.geometry.generator, 'authored-tactical-scene')
    assert.ok(seat.source.hash && seat.source.geometry.props.length, 'авторская карта с открытыми предметами получена по хешу')
    const previous = report.steps[0].seats.find(entry => entry.seat === seat.seat)
    assert.notEqual(seat.source.hash, previous.source.hash, 'новая карта имеет свой хеш')
    if (seat.browser.view === '3d') {
      assert.ok(Number(seat.browser.canvas.modelParses) > Number(previous.browser.canvas.modelParses), 'после перехода загружены модели новой сцены')
    }
  }
}

async function ashWatchCombat(owner, server, viewerSeats) {
  const initial = await readJournal(server, code)
  await owner.command('Page.bringToFront')
  await byText(owner, '.app-rail button', 'Опции')
  await byText(owner, '.setting-row[aria-pressed=false]', 'Домашнее правило: Групповая инициатива')
  await waitRoom(owner, state => state.enabled_house_rules?.includes('house:group-initiative'), 'включена групповая инициатива')
  await byText(owner, '.app-rail button', 'Игра')
  await owner.type('.dialogue-composer textarea', 'Ищем бой')
  await byText(owner, '.dialogue-composer button[type=submit]', 'Отправить')
  const heroId = initial.state.players[0].id
  const combat = await waitRoom(owner, (state) => state.mechanics?.combat?.active
    && state.turn_phase_actor_ids?.includes(heroId), 'ход героя в бою на заставе')
  assert.equal(combat.mechanics.combat.group_initiative, true)
  const partyIds = combat.players.map(hero => hero.id)
  assert.ok(partyIds.every(id => combat.turn_phase_actor_ids.includes(id)), 'оба героя получили общую фазу хода')
  const beforeMove = combat.players.find(hero => hero.id === heroId)
  const adjacent = await owner.evaluate(({ x, y }) => [...document.querySelectorAll('.board-cells button.board-cell[data-cell]')]
    .map(node => ({ node, at: node.dataset.cell.split(',').map(Number) }))
    .filter(({ node, at }) => !node.querySelector('[data-actor-id], .door-hotspot') && Math.abs(at[0] - x) + Math.abs(at[1] - y) === 1
      && !node.className.includes('scene-object'))
    .map(({ node, at }) => ({ cell: node.dataset.cell, x: at[0], y: at[1] })), beforeMove)
  assert.ok(adjacent.length, 'на 2D есть соседняя клетка для перемещения')
  const target = adjacent[0]
  const cell = `button.board-cell[data-cell="${target.cell}"]`
  await byText(owner, cell, '')
  await owner.waitFor(() => document.body.innerText.includes('Нажмите ещё раз, чтобы идти сюда'),
    { timeoutMs: actionTimeoutMs, label: 'маршрут движения ждёт подтверждения' })
  const staged = (await room(owner)).state.players.find(hero => hero.id === heroId)
  assert.deepEqual([staged.x, staged.y], [beforeMove.x, beforeMove.y], 'предпросмотр не переместил героя')
  await byText(owner, cell, '')
  await waitRoom(owner, state => state.players.some(hero => hero.id === heroId && hero.x === target.x && hero.y === target.y), 'подтверждённое перемещение героя')
  const afterMove = await readJournal(server, code)
  const events = afterMove.events.slice(initial.events.length)
  const started = events.find(event => event.event_type === 'CombatStarted')
  assert.equal(started?.payload.group_initiative, true)
  const moved = events.find(event => event.event_type === 'ActorMoved' && event.actor_id === heroId)
  assert.deepEqual(moved?.payload.to, { x: target.x, y: target.y })
  assert.ok(moved.payload.movement_cost > 0)
  await owner.waitFor(feet => [...document.querySelectorAll('button[title]')]
    .some(button => button.title.includes(`движение ${feet} фт`) && button.title.includes('Завершить ход')),
    { args: [moved.payload.movement_remaining], timeoutMs: actionTimeoutMs, label: 'остаток движения в панели совпал с событием' })
  await receipt('06', 'Бой на заставе, групповая инициатива и движение', viewerSeats)
  const step = report.steps.at(-1)
  for (const seat of step.seats) {
    const order = seat.browser.initiative.toSorted((a, b) => a.number - b.number)
    assert.equal(order.length, seat.source.initiative.length)
    for (const [index, row] of order.entries()) {
      const expected = seat.source.initiative[index]
      if (expected.name) assert.ok(row.label.startsWith(`Выделить на карте: ${expected.name}`))
      assert.equal(row.active, expected.id === seat.source.turn)
    }
  }
  step.combat = { move: moved.payload, groupInitiative: started.payload.group_initiative, partyPhase: combat.turn_phase_actor_ids }
}

await mkdir(output, { recursive: true })
try {
  const server = await startTestServer({ after: callback => context.push(callback) }, { env: { DND_DATA_DIR: REPO_ROOT, PLAYTEST_DICE_SEED: String(seed) } })
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
      const viewerSeats = [['owner', owner], ['guest', guest]]
      await receipt('01', 'Кампания, приглашение и готовые листы', viewerSeats)
      if (through >= 2) {
        currentStep = 'Ш2'
        await audience(owner, server, viewerSeats)
      }
      if (through >= 3) {
        currentStep = 'Ш3'
        await freeDialogueAndCheck(owner, server, viewerSeats)
      }
      if (through >= 4) {
        currentStep = 'Ш4'
        await travelToAshWatch(owner, guest, server, viewerSeats, through >= 5)
      }
      if (through >= 6) {
        currentStep = 'Ш6'
        await ashWatchCombat(owner, server, viewerSeats)
      }
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
    } finally {
      for (const [seat, page] of [['owner', owner], ['guest', guest]]) {
        const logs = await page.evaluate(() => window.astohanShaderLogs ?? []).catch(() => [])
        report.shaders.push(...logs.map(log => ({ seat, ...log })))
      }
    }
  })
} catch (error) {
  report.failures.push({ step: currentStep, error: error.message })
  throw error
} finally {
  if (finishBrowserReport(report)) process.exitCode = 1
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  for (const callback of context.reverse()) await callback()
}
