import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

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
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: setupToken, GAME_ENGINE_MODE: 'shadow',
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

function assertStatus(result, status, log) {
  assert.equal(result.status, status, `${result.text}\n${log()}`)
  assert.ok(result.body && typeof result.body === 'object')
}

function totalCp(currency = {}) {
  return Number(currency.copper || 0) + Number(currency.silver || 0) * 10 + Number(currency.gold || 0) * 100 + Number(currency.platinum || 0) * 1_000
}

function businessEvent(result, type) {
  return (result?.mechanics ?? []).find((event) => event.event_type === type)
}

async function merchantView(baseUrl, session, merchantId, actorId, sessionCookie) {
  return request(baseUrl, `/api/campaigns/${session}/merchants/${encodeURIComponent(merchantId)}?actor_id=${encodeURIComponent(actorId)}`, { cookie: sessionCookie })
}

async function merchantCommand(baseUrl, session, merchantId, sessionCookie, idempotencyKey, command) {
  return request(baseUrl, `/api/campaigns/${session}/merchants/${encodeURIComponent(merchantId)}/commands`, {
    method: 'POST', cookie: sessionCookie, body: { idempotency_key: idempotencyKey, command },
  })
}

test('merchant API is authoritative, stale-safe, idempotent and durable across restart', { timeout: 40_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-merchant-api-'))
  const setupToken = 'merchant-api-setup-token'
  let logs = ''
  let child = null
  const log = () => logs
  const appendLog = (chunk) => { logs += chunk }
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Merchant Admin', email: 'admin@merchant.test', password: 'very-secure-admin-password', setupToken },
  })
  assertStatus(setup, 201, log)
  const adminCookie = cookie(setup)
  const registered = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Merchant Player', email: 'player@merchant.test', password: 'very-secure-player-password' },
  })
  assertStatus(registered, 201, log)
  const playerCookie = cookie(registered)

  const initialState = {
    sessionCode: 'SHOP-HTTP', campaign: 'Merchant integration', partyName: 'Customers', partyMemberIds: ['hero', 'foreign'],
    activePlayerId: 'hero', engine_mode: 'shadow', isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
    players: [
      {
        id: 'hero', name: 'Player', character: 'Aster', hp: 10, maxHp: 10, armor: 12, proficiency: 2,
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 16 }, skills: { persuasion_bonus: 2 },
        currency: { copper: 0, silver: 0, gold: 100, platinum: 0 },
        inventory: [
          { id: 'hero-dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 2, equipped: false, base_price_cp: 99_999 },
          { id: 'quest-letter', name: 'Письмо короля', type: 'document', rarity: 'сюжетный', quantity: 1, equipped: false, base_price_cp: 10_000 },
          {
            id: 'moon-shard', name: 'Осколок лунного клинка', type: 'treasure', rarity: 'редкий', quantity: 1, equipped: false,
            base_price_cp: 99_999_999, price_provenance: 'server_appraisal_policy', appraisal_policy_id: 'agent:free-price:v1',
            appraisal: { authoritative: true, base_price_cp: 99_999_999, appraisal_fingerprint: 'f'.repeat(64) },
          },
        ], online: true,
      },
      { id: 'foreign', name: 'Other', character: 'Bryn', hp: 10, maxHp: 10, armor: 12, abilities: { cha: 10 }, currency: { gold: 100 }, inventory: [], online: true },
    ],
    merchants: [
      {
        id: 'marten.shop', name: 'Мартен', location: 'РЫНОЧНАЯ   ПЛОЩАДЬ', available: true,
        purse_cp: 20_000,
        secret_inventory_note: 'GM_ONLY_MERCHANT_SECRET',
        pricing: { buy_markup_bps: 11_000, sell_rate_bps: 5_000, bargain_dc: 15, success_discount_bps: 1_000, failure_markup_bps: 500, agent_adjustment_bps: 0 },
        stock: [
          { stock_id: 'potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: 3, base_price_cp: 1, secret_supplier: 'GM_ONLY_STOCK_SECRET' },
          { stock_id: 'rope', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', name: 'Верёвка', type: 'tool', quantity: 4, base_price_cp: 99_999 },
          { stock_id: 'rations', catalog_id: 'srd_5_2_1:rations-one-day', name: 'Паёк', type: 'consumable', quantity: 12, base_price_cp: 99_999 },
          { stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'other', quantity: 10, base_price_cp: 99_999 },
        ],
      },
      { id: 'far-merchant', name: 'Дальний торговец', location: 'Другой город', available: true, pricing: {}, stock: [] },
    ],
    scene: { title: 'Market', location: 'рыночная площадь', mood: 'Busy', objective: 'Trade', turn: 1, cells: [] },
    adventure: { chapter: 1, history: [], visitedLocations: ['Рыночная площадь'] },
  }

  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'SHOP-HTTP', name: initialState.campaign, state: initialState } })
  assertStatus(created, 201, log)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const user = users.body.users.find((candidate) => candidate.email === 'player@merchant.test')
  const assigned = await request(baseUrl, `/api/admin/users/${user.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] } })
  assertStatus(assigned, 200, log)
  const shadowView = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(shadowView, 200, log)
  const beforeEnforce = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'before-enforce', {
    command_type: 'BuyItem', actor_id: 'hero', stock_id: 'torch', quantity: 1,
    expected_state_version: shadowView.body.merchant_view.expected_state_version,
  })
  assertStatus(beforeEnforce, 409, log)
  assert.equal(beforeEnforce.body.code, 'ENGINE_MODE_NOT_ENFORCE')
  const foreignView = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'foreign', playerCookie)
  assertStatus(foreignView, 403, log)
  assert.equal(foreignView.body.code, 'ACTOR_FORBIDDEN')
  const enforced = await request(baseUrl, '/api/campaigns/SHOP-HTTP/engine-mode', { method: 'PATCH', cookie: adminCookie, body: { mode: 'enforce' } })
  assertStatus(enforced, 200, log)

  const adminView = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', adminCookie)
  assertStatus(adminView, 200, log)
  const initialView = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(initialView, 200, log)
  assert.equal(initialView.body.merchant_view.merchant.location, 'РЫНОЧНАЯ   ПЛОЩАДЬ')
  assert.equal(initialView.body.merchant_view.merchant_purse_cp, 20_000)
  assert.equal(initialView.body.merchant_view.buy_quotes.find((quote) => quote.stock_id === 'potion').unit_price_cp, 5_500)
  assert.equal(initialView.body.merchant_view.merchant.stock.find((stock) => stock.stock_id === 'potion').base_price_cp, 5_000)
  const initialCustomQuote = initialView.body.merchant_view.sell_quotes.find((quote) => quote.item_id === 'moon-shard')
  assert.equal(initialCustomQuote.unit_price_cp, 0)
  assert.equal(initialCustomQuote.can_sell, false)
  assert.equal(initialCustomQuote.appraisal_required, true)
  assert.equal(initialCustomQuote.can_appraise, true)
  assert.doesNotMatch(JSON.stringify(initialView.body), /GM_ONLY_/u)

  const roomBeforeTamper = await request(baseUrl, '/api/rooms/SHOP-HTTP', { cookie: playerCookie })
  assertStatus(roomBeforeTamper, 200, log)
  assert.doesNotMatch(JSON.stringify(roomBeforeTamper.body.state.merchants), /GM_ONLY_|bargain_dc|agent_adjustment_bps|bargains/u)
  const tampered = structuredClone(roomBeforeTamper.body.state)
  tampered.players[0].currency = { platinum: 9_000_000, gold: 0, silver: 0, copper: 0 }
  tampered.players[0].inventory = [{ id: 'forged', name: 'Подделка', type: 'treasure', quantity: 999, base_price_cp: 100_000_000 }]
  tampered.players[0].abilities.cha = 30
  tampered.players[0].skills = { persuasion_bonus: 100 }
  tampered.merchants[0].pricing.buy_markup_percent = -99
  tampered.merchants[0].stock[0].quantity = 999_999
  tampered.economyLog = [{ id: 'forged-log', totalPriceCp: 0 }]
  const tamperResult = await request(baseUrl, '/api/rooms/SHOP-HTTP', { method: 'PUT', cookie: playerCookie, body: { state: tampered, baseVersion: roomBeforeTamper.body.version } })
  assertStatus(tamperResult, 200, log)
  assert.equal(totalCp(tamperResult.body.state.players[0].currency), 10_000)
  assert.equal(tamperResult.body.state.players[0].inventory[0].id, 'hero-dagger')
  assert.equal(tamperResult.body.state.players[0].abilities.cha, 16)
  assert.equal(tamperResult.body.state.players[0].skills.persuasion_bonus, 2)
  assert.equal(tamperResult.body.state.merchants[0].stock.find((stock) => stock.stock_id === 'potion').quantity, 3)
  assert.equal(tamperResult.body.state.economyLog.some((entry) => entry.id === 'forged-log'), false)

  // Same fresh key, two different operations in parallel: exactly one may commit.
  const viewedVersion = initialView.body.merchant_view.expected_state_version
  const raced = await Promise.all([
    merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'merchant-race-key', { command_type: 'BuyItem', actor_id: 'hero', stock_id: 'torch', quantity: 1, expected_state_version: viewedVersion }),
    merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'merchant-race-key', { command_type: 'BuyItem', actor_id: 'hero', stock_id: 'rations', quantity: 1, expected_state_version: viewedVersion }),
  ])
  assert.deepEqual(raced.map((result) => result.status).sort(), [200, 409], raced.map((result) => result.text).join('\n'))
  const raceWinner = raced.find((result) => result.status === 200)
  assert.ok(raceWinner)
  assert.equal(raceWinner.body.idempotent_replay, false)

  let fresh = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(fresh, 200, log)
  const afterRaceBalance = fresh.body.merchant_view.balance_cp
  const winnerCost = businessEvent(raceWinner.body, 'MerchantPurchaseCompleted').payload.total_price_cp
  assert.equal(afterRaceBalance, 10_000 - winnerCost)

  const insufficient = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'insufficient-funds', {
    command_type: 'BuyItem', actor_id: 'hero', stock_id: 'potion', quantity: 2,
    expected_state_version: fresh.body.merchant_view.expected_state_version, price_cp: 1,
  })
  assertStatus(insufficient, 400, log)
  assert.equal(insufficient.body.code, 'INSUFFICIENT_FUNDS')
  const foreign = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'foreign-owner', {
    command_type: 'BuyItem', actor_id: 'foreign', stock_id: 'torch', quantity: 1,
    expected_state_version: fresh.body.merchant_view.expected_state_version,
  })
  assertStatus(foreign, 403, log)
  assert.equal(foreign.body.code, 'ACTOR_FORBIDDEN')

  const buyCommand = {
    command_type: 'BuyItem', actor_id: 'hero', stock_id: 'potion', quantity: 1,
    expected_state_version: fresh.body.merchant_view.expected_state_version,
    price_cp: 1, base_price_cp: 1, item: { id: 'forged', name: 'Бесплатный артефакт' }, roll: 20,
  }
  const bought = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'buy-potion-once', buyCommand)
  assertStatus(bought, 200, log)
  const purchase = businessEvent(bought.body, 'MerchantPurchaseCompleted')
  assert.equal(purchase.payload.unit_price_cp, 5_500)
  assert.equal(purchase.payload.item.name, 'Зелье лечения')
  assert.doesNotMatch(JSON.stringify(bought.body), /GM_ONLY_|secret_supplier|secret_inventory_note/u)
  const balanceAfterBuy = bought.body.merchant_view.balance_cp
  assert.equal(balanceAfterBuy, afterRaceBalance - 5_500)
  assert.equal(bought.body.merchant_view.merchant.stock.find((stock) => stock.stock_id === 'potion').quantity, 2)
  assert.equal(bought.body.authoritative_state.players.find((candidate) => candidate.id === 'hero').inventory.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').quantity, 1)
  assert.equal(bought.body.authoritative_state.economyLog.at(-1).type, 'purchase')
  assert.equal(bought.body.provider, 'deterministic-merchant')
  assert.match(bought.body.narration, /Мартен.*Зелье лечения/u)
  const roomAfterBuy = await request(baseUrl, '/api/rooms/SHOP-HTTP', { cookie: playerCookie })
  assertStatus(roomAfterBuy, 200, log)
  assert.equal(roomAfterBuy.body.state.messages.filter((message) => message.id === bought.body.narration_message_id).length, 1)
  assert.equal(roomAfterBuy.body.state.messages.find((message) => message.id === bought.body.narration_message_id).text, bought.body.narration)

  const replayedBuy = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'buy-potion-once', buyCommand)
  assertStatus(replayedBuy, 200, log)
  assert.equal(replayedBuy.body.idempotent_replay, true)
  assert.equal(replayedBuy.body.turn_id, bought.body.turn_id)
  assert.equal(replayedBuy.body.narration, bought.body.narration)
  assert.equal(replayedBuy.body.provider, bought.body.provider)
  assert.equal(replayedBuy.body.merchant_view.balance_cp, balanceAfterBuy)
  assert.equal(replayedBuy.body.merchant_view.merchant.stock.find((stock) => stock.stock_id === 'potion').quantity, 2)
  assert.equal(replayedBuy.body.authoritative_state.economyLog.filter((entry) => entry.type === 'purchase' && entry.stockId === 'potion').length, 1)
  assert.equal(replayedBuy.body.narration_message_id, bought.body.narration_message_id)
  const reusedKey = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'buy-potion-once', {
    ...buyCommand, stock_id: 'rope',
  })
  assertStatus(reusedKey, 409, log)
  assert.equal(reusedKey.body.code, 'IDEMPOTENCY_CONFLICT')

  const staleView = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(staleView, 200, log)
  const staleVersion = staleView.body.merchant_view.expected_state_version
  const bargained = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'bargain-once', {
    command_type: 'BargainWithMerchant', actor_id: 'hero', expected_state_version: staleVersion,
    roll: 20, modifier: 100, difficulty: 1,
  })
  assertStatus(bargained, 200, log)
  const bargain = businessEvent(bargained.body, 'MerchantBargainResolved')
  assert.ok(Number.isInteger(bargain.payload.natural_roll) && bargain.payload.natural_roll >= 1 && bargain.payload.natural_roll <= 20)
  assert.equal(bargain.payload.modifier, 5)
  assert.equal(bargain.payload.difficulty, 15)
  const stateAfterBargain = bargained.body.merchant_view
  const staleBuy = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'stale-buy-must-fail', {
    command_type: 'BuyItem', actor_id: 'hero', stock_id: 'rope', quantity: 1, expected_state_version: staleVersion,
  })
  assertStatus(staleBuy, 409, log)
  assert.equal(staleBuy.body.code, 'STATE_VERSION_CONFLICT')
  fresh = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(fresh, 200, log)
  assert.equal(fresh.body.merchant_view.balance_cp, stateAfterBargain.balance_cp)
  assert.equal(fresh.body.merchant_view.merchant.stock.find((stock) => stock.stock_id === 'rope').quantity, stateAfterBargain.merchant.stock.find((stock) => stock.stock_id === 'rope').quantity)

  const staleAppraisal = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'stale-appraisal-must-fail', {
    command_type: 'AppraiseItem', actor_id: 'hero', item_id: 'moon-shard', expected_state_version: staleVersion,
  })
  assertStatus(staleAppraisal, 409, log)
  assert.equal(staleAppraisal.body.code, 'STATE_VERSION_CONFLICT')
  const foreignAppraisal = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'foreign-appraisal-must-fail', {
    command_type: 'AppraiseItem', actor_id: 'foreign', item_id: 'moon-shard', expected_state_version: fresh.body.merchant_view.expected_state_version,
  })
  assertStatus(foreignAppraisal, 403, log)
  assert.equal(foreignAppraisal.body.code, 'ACTOR_FORBIDDEN')

  const purseBeforeAppraisal = fresh.body.merchant_view.merchant_purse_cp
  const appraisalCommand = {
    command_type: 'AppraiseItem', actor_id: 'hero', item_id: 'moon-shard',
    expected_state_version: fresh.body.merchant_view.expected_state_version,
    price_cp: 1, base_price_cp: 1, estimated_price_cp: 1,
    price_provenance: 'client', appraisal_policy_id: 'agent:free-price:v1',
    appraisal: { authoritative: true, base_price_cp: 1 },
  }
  const appraised = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'appraise-moon-shard-once', appraisalCommand)
  assertStatus(appraised, 200, log)
  assert.equal(appraised.body.idempotent_replay, false)
  const appraisalEvent = businessEvent(appraised.body, 'MerchantItemAppraised')
  assert.ok(appraisalEvent)
  assert.equal(appraisalEvent.payload.item_id, 'moon-shard')
  assert.equal(appraisalEvent.payload.base_unit_price_cp, 6_250)
  assert.equal(appraisalEvent.payload.appraisal.base_price_cp, 6_250)
  assert.equal(appraisalEvent.payload.appraisal.provenance, 'server_appraisal_policy')
  assert.equal(appraisalEvent.payload.appraisal.policy_id, 'skazanie:item-appraisal:category-rarity-condition:v1')
  assert.notEqual(appraisalEvent.payload.appraisal.policy_id, 'agent:free-price:v1')
  assert.equal(appraised.body.merchant_view.merchant_purse_cp, purseBeforeAppraisal)
  const appraisedQuote = appraised.body.merchant_view.sell_quotes.find((quote) => quote.item_id === 'moon-shard')
  assert.equal(appraisedQuote.breakdown.catalog_base_unit_cp, 6_250)
  assert.equal(appraisedQuote.price_provenance, 'server_appraisal_policy')
  assert.equal(appraisedQuote.appraisal_required, false)
  assert.equal(appraisedQuote.can_appraise, false)
  assert.equal(appraisedQuote.can_sell, true)
  assert.ok(appraised.body.authoritative_state.economyLog.some((entry) => entry.type === 'appraisal' && entry.itemId === 'moon-shard'))

  const replayedAppraisal = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'appraise-moon-shard-once', appraisalCommand)
  assertStatus(replayedAppraisal, 200, log)
  assert.equal(replayedAppraisal.body.idempotent_replay, true)
  assert.equal(replayedAppraisal.body.turn_id, appraised.body.turn_id)
  assert.equal(businessEvent(replayedAppraisal.body, 'MerchantItemAppraised').payload.base_unit_price_cp, 6_250)
  assert.equal(replayedAppraisal.body.merchant_view.merchant_purse_cp, purseBeforeAppraisal)
  assert.equal(replayedAppraisal.body.authoritative_state.economyLog.filter((entry) => entry.type === 'appraisal' && entry.itemId === 'moon-shard').length, 1)
  const appraisalKeyConflict = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'appraise-moon-shard-once', {
    ...appraisalCommand, item_id: 'quest-letter',
  })
  assertStatus(appraisalKeyConflict, 409, log)
  assert.equal(appraisalKeyConflict.body.code, 'IDEMPOTENCY_CONFLICT')
  const appraiseTwice = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'appraise-moon-shard-twice', {
    command_type: 'AppraiseItem', actor_id: 'hero', item_id: 'moon-shard',
    expected_state_version: appraised.body.merchant_view.expected_state_version,
  })
  assertStatus(appraiseTwice, 400, log)
  assert.equal(appraiseTwice.body.code, 'ITEM_ALREADY_APPRAISED')

  fresh = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(fresh, 200, log)

  const daggerQuote = fresh.body.merchant_view.sell_quotes.find((quote) => quote.item_id === 'hero-dagger')
  assert.ok(daggerQuote.can_sell)
  assert.equal(fresh.body.merchant_view.sell_quotes.find((quote) => quote.item_id === 'quest-letter').can_sell, false)
  const sellCommand = {
    command_type: 'SellItem', actor_id: 'hero', item_id: 'hero-dagger', quantity: 1,
    expected_state_version: fresh.body.merchant_view.expected_state_version, price_cp: 99_999_999,
  }
  const sold = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'sell-dagger-once', sellCommand)
  assertStatus(sold, 200, log)
  const sale = businessEvent(sold.body, 'MerchantSaleCompleted')
  assert.equal(sale.payload.unit_price_cp, daggerQuote.unit_price_cp)
  assert.equal(sold.body.merchant_view.balance_cp, fresh.body.merchant_view.balance_cp + daggerQuote.unit_price_cp)
  assert.equal(sold.body.merchant_view.merchant_purse_cp, fresh.body.merchant_view.merchant_purse_cp - daggerQuote.unit_price_cp)
  assert.equal(sold.body.authoritative_state.players.find((candidate) => candidate.id === 'hero').inventory.find((item) => item.id === 'hero-dagger').quantity, 1)
  assert.equal(sold.body.authoritative_state.economyLog.at(-1).type, 'sale')

  const repeatBargain = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'bargain-twice', {
    command_type: 'BargainWithMerchant', actor_id: 'hero', expected_state_version: sold.body.merchant_view.expected_state_version,
  })
  assertStatus(repeatBargain, 400, log)
  assert.equal(repeatBargain.body.code, 'BARGAIN_ALREADY_RESOLVED')
  const far = await merchantView(baseUrl, 'SHOP-HTTP', 'far-merchant', 'hero', playerCookie)
  assertStatus(far, 409, log)
  assert.equal(far.body.code, 'MERCHANT_NOT_PRESENT')

  const stableBalance = sold.body.merchant_view.balance_cp
  const stableMerchantPurse = sold.body.merchant_view.merchant_purse_cp
  const stableVersion = sold.body.merchant_view.state_version
  const stableLogLength = sold.body.authoritative_state.economyLog.length
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog })
  await waitForHealth(baseUrl, child, log)

  const afterRestart = await merchantView(baseUrl, 'SHOP-HTTP', 'marten.shop', 'hero', playerCookie)
  assertStatus(afterRestart, 200, log)
  assert.equal(afterRestart.body.merchant_view.balance_cp, stableBalance)
  assert.equal(afterRestart.body.merchant_view.merchant_purse_cp, stableMerchantPurse)
  assert.equal(afterRestart.body.merchant_view.state_version, stableVersion)
  assert.equal(afterRestart.body.merchant_view.merchant.stock.find((stock) => stock.stock_id === 'potion').quantity, 2)
  assert.equal(afterRestart.body.merchant_view.bargain.attempted, true)
  const durableAppraisalQuote = afterRestart.body.merchant_view.sell_quotes.find((quote) => quote.item_id === 'moon-shard')
  assert.equal(durableAppraisalQuote.breakdown.catalog_base_unit_cp, 6_250)
  assert.equal(durableAppraisalQuote.price_provenance, 'server_appraisal_policy')
  assert.equal(durableAppraisalQuote.can_sell, true)
  const replayedAppraisalAfterRestart = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'appraise-moon-shard-once', appraisalCommand)
  assertStatus(replayedAppraisalAfterRestart, 200, log)
  assert.equal(replayedAppraisalAfterRestart.body.idempotent_replay, true)
  assert.equal(replayedAppraisalAfterRestart.body.turn_id, appraised.body.turn_id)
  assert.equal(replayedAppraisalAfterRestart.body.merchant_view.merchant_purse_cp, stableMerchantPurse)
  const replayedSale = await merchantCommand(baseUrl, 'SHOP-HTTP', 'marten.shop', playerCookie, 'sell-dagger-once', sellCommand)
  assertStatus(replayedSale, 200, log)
  assert.equal(replayedSale.body.idempotent_replay, true)
  assert.equal(replayedSale.body.turn_id, sold.body.turn_id)
  assert.equal(replayedSale.body.narration, sold.body.narration)
  assert.equal(replayedSale.body.provider, sold.body.provider)
  assert.equal(replayedSale.body.merchant_view.balance_cp, stableBalance)
  assert.equal(replayedSale.body.authoritative_state.players.find((candidate) => candidate.id === 'hero').inventory.find((item) => item.id === 'hero-dagger').quantity, 1)
  assert.equal(replayedSale.body.authoritative_state.economyLog.length, stableLogLength)
  assert.ok(replayedSale.body.authoritative_state.economyLog.some((entry) => entry.type === 'bargain'))
  assert.ok(replayedSale.body.authoritative_state.economyLog.some((entry) => entry.type === 'sale'))
})
