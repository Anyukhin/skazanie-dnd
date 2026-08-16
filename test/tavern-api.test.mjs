import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Кости и выпивка доступны настоящему игроку через основной сайт.
 *
 * Проба сквозная и ходит теми же путями, что и браузер: карточки действий —
 * POST в `/api/campaigns/:code/commands`, ручной ответный бросок — вторым
 * запросом с `roll_id` из `/api/roll`. Ключа модели у сервера нет, поэтому всё
 * здесь обязано быть детерминированным.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const SESSION = 'TAVERN-API'
const INN = 'Трактир «У моста»'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer({ port, storage, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return response.json() } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* assertion reports raw body */ }
  return { response, status: response.status, body: json, text }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

function cells(width = 6, height = 6) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

function seededState() {
  return {
    sessionCode: SESSION,
    campaign: 'Жизнь таверны',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: {
      title: INN, location: INN, location_id: 'inn', mood: '', objective: '', turn: 1,
      grid: { width: 6, height: 6 }, cells: cells(),
    },
    players: [{
      id: 'hero', name: 'Player', character: 'Ада', hp: 20, maxHp: 20, armor: 12, speed: 30, x: 1, y: 1, level: 3,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 12 },
      proficiency: 2, classSkillProficiencies: [], savingThrowProficiencies: [],
      currency: { copper: 0, silver: 0, gold: 2, platinum: 0 }, inventory: [], online: true,
    }],
    worldMap: { seed: 'tavern-api', locations: [{ id: 'inn', name: INN, kind: 'village', x: 100, y: 300 }], routes: [] },
    enemies: [],
    social: {
      npcs: [
        { id: 'barkeep', name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' },
        // Шулер — не выдумка теста, а сид кампании: на `TAVERN-API` `one-eye`
        // выходит краплёным, и это проверяется там, где на нём стоит проба.
        { id: 'one-eye', name: 'Кривой Сом', role: 'бродяга', location: INN, visibility: 'party', public_summary: 'Сидит у окна.' },
      ],
    },
    mechanics: { world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0 } },
  }
}

async function setUp(t) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-tavern-api-'))
  const setupToken = 'tavern-api-setup-token'
  let logs = ''
  let child = null
  const log = () => logs
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)
  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Tavern Admin', email: 'admin@tavern.test', password: 'very-secure-admin-password', setupToken },
  })
  assert.equal(setup.status, 201, `${setup.text}\n${log()}`)
  const adminCookie = cookie(setup)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Таверна', state: seededState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  return { baseUrl, adminCookie, log }
}

test('раунд костей проходит настоящим путём: чужая кость, ручной бросок, банк', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const idle = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(idle.body.state.tavern, `карточка заведения обязана доехать игроку\n${idle.text}`)
  const stake = idle.body.state.tavern.stakes[0].stake_cp

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: stake },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)
  const afterOpen = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const round = afterOpen.body.state.tavern.round
  assert.ok(round, `кость соперника обязана лечь на стол\n${afterOpen.text}`)
  assert.equal(round.target, round.npc_total + 1)
  assert.equal(afterOpen.body.state.lastDiceRoll.value, round.npc_total, 'кость соперника видна в общем лотке')

  // Первая фаза ответа: сервер объявляет проверку против уже лежащего числа.
  const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-answer-1',
      manual_roll: true,
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.ok(announced.body.check?.check_id, `сервер обязан вернуть карточку броска\n${announced.text}`)
  assert.equal(announced.body.check.difficulty, round.target, 'СЛ карточки — это кость соперника, а не выдуманное число')
  assert.equal(announced.body.check.modifier, 0, 'за столом кидают удачу, а не характеристику')

  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)

  const resolved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-answer-2',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const settled = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'TavernDiceRoundResolved')
  assert.ok(settled, `раунд обязан закрыться событием\n${resolved.text}`)
  assert.equal(settled.payload.hero_total, rolled.body.total, 'движок считает по броску игрока, а не бросает заново')

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(after.body.state.tavern.round, null, 'раунд закрыт')
  const purse = after.body.state.players[0].currency
  const purseCp = purse.copper + purse.silver * 10 + purse.gold * 100 + purse.platinum * 1_000
  const expected = settled.payload.outcome === 'win' ? 200 + stake
    : settled.payload.outcome === 'loss' ? 200 - stake : 200
  assert.equal(purseCp, expected, `банк обязан сойтись с исходом ${settled.payload.outcome}`)
  assert.ok(purseCp >= 0, 'кошелёк не уходит в минус ни при каком исходе')
})

/**
 * Зонд ревью: подкрутка. Карточка ручного броска объявляла «модификатор +0», а
 * исполнение считало с `+5` — игрок видел «нужно 16», а хватало 11. Проверяется
 * это на живом пути целиком: чем карточка объявила, тем `/api/roll` и посчитал,
 * и с тем же числом закрылся раунд.
 */
test('карточка подкрученного броска объявляет тот же модификатор, с каким считает движок', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open-cheat',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 10 },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)
  const round = (await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })).body.state.tavern.round

  const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-cheat-1',
      manual_roll: true,
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'cheat' },
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.equal(announced.body.check.difficulty, round.target, 'СЛ карточки — это кость соперника')
  assert.equal(announced.body.check.modifier, 5, 'подкрученная кость объявлена до броска, а не после')

  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)
  assert.equal(rolled.body.total, rolled.body.value + 5, 'реестр бросков считает по объявленному модификатору')

  const resolved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-cheat-2',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'cheat' },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const settled = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'TavernDiceRoundResolved')
  assert.ok(settled, `раунд обязан закрыться событием\n${resolved.text}`)
  assert.equal(settled.payload.hero_total, rolled.body.total, 'карточка и движок сошлись на одном числе')
})

test('во вторую фазу раунда принимается только бросок, зарегистрированный костями', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open-foreign',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 10 },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)

  const foreign = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', label: 'Проверка Ловкости', modifier: 12, difficulty: 5 },
  })
  assert.equal(foreign.status, 200, `${foreign.text}\n${log()}`)

  const rejected = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-foreign-roll',
      roll: { roll_id: foreign.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(rejected.status, 400, rejected.text)
  assert.equal(rejected.body.code, 'ROLL_CONTEXT_MISMATCH')

  // Ставку и характер соперника клиент подсказать не может: лишнее поле в
  // команде — отказ, а не молчаливое игнорирование.
  const forgedField = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-forged-field',
      command: { command_type: 'OrderTavernDrink', actor_id: 'hero', difficulty: 1 },
    },
  })
  assert.equal(forgedField.status, 400, forgedField.text)
  assert.equal(forgedField.body.code, 'TAVERN_COMMAND_UNKNOWN_FIELD')

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(after.body.state.tavern.round, 'чужой бросок раунда не закрывает')
})

/**
 * Зонд ревью: подход не был закреплён между фазами ручного броска.
 *
 * Первая фаза объявляла карточку по подходу из команды, а вторая читала подход
 * из **новой** команды — то есть решение подкрутить кость принималось уже после
 * того, как игрок увидел свой кубик. Честный бросок с `+0` доигрывался как
 * `cheat` с `+5` ровно тогда, когда не хватило, а карточка при этом объявляла
 * столу другое число.
 *
 * Проверяется на живом пути целиком, потому что дыра была именно в стыке двух
 * запросов: тот же `roll_id`, другой `approach`.
 */
test('подход к броску закреплён первой фазой: тот же кубик с другим подходом не принимается', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open-approach',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 10 },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)

  // Первая фаза объявлена честной: карточка обещает столу «+0».
  const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-approach-1',
      manual_roll: true,
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
  assert.equal(announced.body.check.modifier, 0, 'честный бросок объявлен без надбавки')

  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)

  // Кубик увиден — и вот теперь герой «решает» подкрутить. Отказ, а не +5.
  const switched = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-approach-switch',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'cheat' },
    },
  })
  assert.equal(switched.status, 400, switched.text)
  assert.equal(switched.body.code, 'ROLL_CONTEXT_MISMATCH')

  const stillOpen = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(stillOpen.body.state.tavern.round, 'отказ ничего не закоммитил: раунд на месте')

  // Кубик при этом сгорел: реестр помечает бросок использованным до разбора
  // команды, и подставить его ещё раз — уже под объявленным подходом — нельзя.
  // Так и надо: попытка переиграть решение стоит броска, а раунд остаётся
  // открытым и доигрывается новой костью.
  const reused = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-approach-reuse',
      roll: { roll_id: rolled.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(reused.status, 400, reused.text)
  assert.equal(reused.body.code, 'ROLL_ALREADY_USED')

  // Новая честная пара фаз доигрывает раунд штатно, и никакой проверки Ловкости
  // рук в журнале нет — подкрутки не было.
  const reannounced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-approach-3',
      manual_roll: true,
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(reannounced.status, 200, `${reannounced.text}\n${log()}`)
  assert.equal(reannounced.body.check.modifier, 0)
  const rerolled = await request(baseUrl, '/api/roll', {
    method: 'POST',
    cookie: adminCookie,
    body: { campaignId: SESSION, playerId: 'hero', checkId: reannounced.body.check.check_id },
  })
  assert.equal(rerolled.status, 200, `${rerolled.text}\n${log()}`)

  const resolved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-approach-4',
      roll: { roll_id: rerolled.body.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${log()}`)
  const settled = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'TavernDiceRoundResolved')
  assert.ok(settled, `раунд обязан закрыться событием\n${resolved.text}`)
  assert.equal(settled.payload.approach, 'fair')
  assert.equal(settled.payload.cheated, false)
  assert.equal(settled.payload.hero_total, rerolled.body.total, 'считается ровно тот кубик, что объявляла карточка')
  assert.equal(
    (resolved.body.mechanics ?? []).some((event) => event.event_type === 'AbilityCheckResolved'),
    false,
    'честный ответ не заводит проверку Ловкости рук',
  )
  // Касса соперника здесь на месте намеренно: проба ходит под администратором,
  // а ведущий проекцию не проходит вовсе (`mechanicsForViewer`). Что её не
  // видит игрок — проверяется там, где есть роль игрока
  // (`test/tavern-life.test.mjs`).
  assert.ok(Number.isInteger(settled.payload.npc_purse_after_cp))
})

/**
 * Цена ухода из-за стола живым путём — и это ровно тот сценарий, которым
 * повторное ревью прошло сквозь прошлую заплату.
 *
 * У теста две прошлые редакции, и обе закрепляли дыру. Первая требовала, чтобы
 * команда «не сжигала вечер» (уход был бесплатным перебросом чужой кости).
 * Вторая заменила это запретом «встать можно только из тупика» — и сама же
 * подсказывала обход: чтобы получить право уйти, тест **заказывал кружку эля**
 * за 4 мм и ронял кошелёк ниже сделанной ставки. Отмена проигрышного раунда
 * стоила 4 мм вместо 200.
 *
 * Здесь проверяется новый инвариант целиком: ставка уходит из кошелька вместе с
 * костью на столе, кружка эля тупика больше не делает, а уход от живой кости —
 * это сдача, и стоит она ровно ставки.
 */
test('уход от живой кости стоит ставки, и кружка эля этого не отменяет', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const idle = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  const purseCp = (body) => {
    const purse = body.state.players[0].currency
    return purse.copper + purse.silver * 10 + purse.gold * 100 + purse.platinum * 1_000
  }
  assert.equal(purseCp(idle.body), 200, 'кошелёк героя — ровно одна крупная ставка')

  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open-leave',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 200 },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)
  const openedEvent = (opened.body.mechanics ?? []).find((event) => event.event_type === 'TavernDiceRoundOpened')
  assert.ok(openedEvent, `открытие раунда обязано доехать игроку событием\n${opened.text}`)
  assert.equal(openedEvent.payload.balance_before_cp - openedEvent.payload.balance_after_cp, 200,
    'событие открытия само говорит, что ставка ушла из кошелька на стол')

  const before = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(before.body.state.tavern.round, 'кость соперника на столе')
  assert.equal(purseCp(before.body), 0, 'ставка уплачена сразу: в кармане пусто')

  // Обход прошлой заплаты: кружку эля с пустым кошельком уже не купить, и даже
  // купленная тупика бы не сделала — поводов «отвечать нечем» не осталось вовсе.
  const drank = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: { idempotency_key: 'tavern-leave-drink', command: { command_type: 'OrderTavernDrink', actor_id: 'hero' } },
  })
  assert.equal(drank.status, 400, drank.text)
  assert.equal(drank.body.code, 'INSUFFICIENT_FUNDS')
  const stillOpen = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.ok(stillOpen.body.state.tavern.round, 'раунд по-прежнему открыт: бедность отвечать не мешает')

  // Встать из-за стола можно — но это сдача, и ставка со стола не возвращается.
  const left = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-leave',
      command: { command_type: 'LeaveTavernDiceRound', actor_id: 'hero' },
    },
  })
  assert.equal(left.status, 200, `${left.text}\n${log()}`)
  const cancelled = (left.body.mechanics ?? []).find((event) => event.event_type === 'TavernDiceRoundCancelled')
  assert.ok(cancelled, `закрытие раунда обязано доехать игроку событием\n${left.text}`)
  assert.equal(cancelled.payload.reason, 'surrendered')
  assert.equal(cancelled.payload.forfeited_cp, 200)
  assert.equal(Object.hasOwn(cancelled.payload, 'returned_cp'), false, 'возвратов у сдачи нет ни одного')
  // Ставка уехала в карман соседа: деньги за этим столом переезжают, а не
  // исчезают. Здесь это видно, потому что запрос идёт от ведущего — игроку
  // точные суммы чужой кассы режет проекция (`test/tavern-life.test.mjs`).
  assert.equal(cancelled.payload.npc_purse_after_cp - cancelled.payload.npc_purse_before_cp, 200)

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(after.body.state.tavern.round, null, 'раунд снят')
  assert.equal(purseCp(after.body), 0, 'ставка осталась на столе: цикл «увидел много — встал» стоит ставки')

  // За стол сесть заново уже не на что, и это видно карточкой, а не отказом.
  assert.equal(after.body.state.tavern.opponents.every((npc) => npc.max_stake_cp >= 10), true, 'у соседа деньги есть')
  const broke = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-open-again',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 10 },
    },
  })
  assert.equal(broke.status, 400, broke.text)
  assert.equal(broke.body.code, 'INSUFFICIENT_FUNDS')
})

/**
 * Зонд ревью: сверка раунда между фазами ручного броска не была закрыта ничем.
 *
 * У подхода тест есть, у вида броска — есть, а у `round_id` не было: мутация
 * `if (false)` на этом условии оставляла все сорок пять тестов таверны
 * зелёными. Стоит проверка того, что карточку, выданную под старый раунд (СЛ по
 * старой кости), нельзя доиграть против нового: герой держит зарегистрированный
 * кубик, закрывает раунд, открывает следующий, смотрит новое число соперника — и
 * только потом решает, катать ли отложенную кость.
 *
 * Проверяется на живом пути целиком, потому что дыра именно в стыке запросов:
 * тот же `roll_id`, тот же подход, другой раунд.
 */
test('бросок закреплён своим раундом: отложенный кубик не доигрывает следующую кость', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const openRound = async (key) => {
    const response = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
      method: 'POST',
      cookie: adminCookie,
      body: {
        idempotency_key: key,
        command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'barkeep', stake_cp: 10 },
      },
    })
    assert.equal(response.status, 200, `${response.text}\n${log()}`)
    return (await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })).body.state.tavern.round
  }
  const registerRoll = async (key) => {
    const announced = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
      method: 'POST',
      cookie: adminCookie,
      body: {
        idempotency_key: key,
        manual_roll: true,
        command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
      },
    })
    assert.equal(announced.status, 200, `${announced.text}\n${log()}`)
    const rolled = await request(baseUrl, '/api/roll', {
      method: 'POST',
      cookie: adminCookie,
      body: { campaignId: SESSION, playerId: 'hero', checkId: announced.body.check.check_id },
    })
    assert.equal(rolled.status, 200, `${rolled.text}\n${log()}`)
    return { check: announced.body.check, roll: rolled.body }
  }

  const first = await openRound('tavern-round-1')
  // Две карточки под один и тот же раунд: одной он доигрывается, вторая
  // остаётся у героя «на потом».
  const held = await registerRoll('tavern-round-1-hold')
  const played = await registerRoll('tavern-round-1-play')
  assert.equal(held.check.difficulty, first.target, 'обе карточки объявлены по кости, лежащей на столе сейчас')
  assert.equal(played.check.difficulty, first.target)

  const settled = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-round-1-settle',
      roll: { roll_id: played.roll.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(settled.status, 200, `${settled.text}\n${log()}`)

  // Новый раунд — новая кость соперника, и герой видит её до того, как решит
  // катать отложенный кубик.
  const second = await openRound('tavern-round-2')
  assert.notEqual(second.id, first.id, 'за столом действительно другой раунд')

  const stale = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      idempotency_key: 'tavern-round-2-stale',
      roll: { roll_id: held.roll.roll_id },
      command: { command_type: 'AnswerTavernDiceRound', actor_id: 'hero', approach: 'fair' },
    },
  })
  assert.equal(stale.status, 400, stale.text)
  assert.equal(stale.body.code, 'ROLL_CONTEXT_MISMATCH')

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: adminCookie })
  assert.equal(after.body.state.tavern.round.id, second.id, 'отказ ничего не закоммитил: новый раунд на месте')
})

/**
 * Зонд ревью глазами игрока, а не ведущего: настоящая кость шулера уезжала в
 * ответе на его же команду.
 *
 * Весь остальной файл ходит под администратором, а `turnResultForViewer` для
 * админа возвращает результат сырым первой же строкой — поэтому ни одна проба
 * шага не смотрела на ответ команды глазами игрока, и защита, стоявшая на одном
 * канале из двух, никого не разбудила.
 */
test('игроку не приходит выпавшая кость соперника — ни лотком, ни броском', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { baseUrl, adminCookie, log } = await setUp(t)

  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Игрок', email: 'player@tavern.test', password: 'very-secure-player-password' },
  })
  assert.equal(registered.status, 201, `${registered.text}\n${log()}`)
  const playerCookie = cookie(registered)
  const invited = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: adminCookie, body: { hero_ids: ['hero'] },
  })
  assert.equal(invited.status, 201, `${invited.text}\n${log()}`)
  const joined = await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: playerCookie, body: { invite_token: invited.body.token },
  })
  assert.equal(joined.status, 200, `${joined.text}\n${log()}`)

  // Соперник краплёный, поэтому показанное число и выпавшее расходятся ровно на
  // надбавку — то самое, что игрок обязан искать Проницательностью.
  const opened = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST',
    cookie: playerCookie,
    body: {
      idempotency_key: 'tavern-player-open',
      command: { command_type: 'OpenTavernDiceRound', actor_id: 'hero', npc_id: 'one-eye', stake_cp: 10 },
    },
  })
  assert.equal(opened.status, 200, `${opened.text}\n${log()}`)
  assert.equal(opened.body.effects?.roll ?? null, null, `кость соперника уехала игроку лотком\n${opened.text}`)
  assert.equal(
    JSON.stringify(opened.body).includes('tavern-dice:opponent'),
    false,
    `бросок соперника не должен появляться в ответе игрока вовсе\n${opened.text}`,
  )

  // Показанное число при этом на месте: скрывается разница, а не игра.
  const room = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: playerCookie })
  const shown = room.body.state.tavern.round.npc_total
  assert.ok(shown >= 1 && shown <= 20)
  assert.equal(room.body.state.lastDiceRoll.value, shown, 'стол видит объявленное число')
  const publicRoll = (opened.body.mechanics ?? []).find((event) => event.event_type === 'PublicDieRolled')
  assert.equal(publicRoll.payload.roll.value, shown)
})
