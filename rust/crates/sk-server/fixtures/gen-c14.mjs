// Эталон «Г» С14: торговцы — управление и сборка.
//
//   node rust/crates/sk-server/fixtures/gen-c14.mjs
//
// Пишет два файла, сверка — `tests/c14_golden.rs`:
//
// * `fixtures/c14-guard.json` — санитайзер lifecycle-команды и сверки
//   отпечатков (`index.mjs` 635, 639–662, 1024–1247). Функции не
//   экспортированы, а импорт `index.mjs` поднимает сервер, поэтому исходники
//   вырезаются по диапазонам строк (`RANGES`) и собираются через
//   `new Function` с заглушкой журнала (`eventStore`), как в `gen-c16.mjs`.
//   Хеш `index.mjs` (с LF) закреплён. Входы — образцовые команды каждого типа
//   и их мутации по каждому пути (мусорные значения, границы, camelCase,
//   `toString` объекта); каждый случай исполняется на JSON-копии входа.
//   Случай с одиночной суррогатной половиной в итоге не пишется (в Rust
//   непредставим).
// * `fixtures/c14.json` — сценарий маршрутов против JS-сервера (формат
//   `skazanie.golden/1`): права, лимиты, ключ, все пять команд, повтор и
//   конфликт ключа, сборка магазина, витрина торговца, общий страж id.
//   Тела подготовительных обменов — `<skip>`; токен приглашения — ссылка
//   `<invite:N>`; у `authoritative_state` снята летопись `messages`, большие
//   ветви — по частям или хешем канонического текста (как в С13).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MAX_CURRENCY_CP } from '../../../../server/merchant-economy.mjs'
import { FIXTURES_DIR, GOLDEN_FORMAT, recorder, startGoldenServer } from './golden.mjs'

const root = new URL('../../../../', import.meta.url)
const SOURCE_SHA256 = '5d972e446f05fa2c4fbb604e5a65914422264ed323dbebb94feca1d231e31ecd'
const RANGES = [[637, 637], [641, 664], [1026, 1249]]

const sha = (text) => createHash('sha256').update(text).digest('hex')
const source = readFileSync(new URL('server/index.mjs', root), 'utf8').replace(/\r\n/gu, '\n')
if (sha(source) !== SOURCE_SHA256) {
  throw new Error(`server/index.mjs изменился (sha256 ${sha(source)}): проверьте диапазоны ${JSON.stringify(RANGES)} и обновите SOURCE_SHA256`)
}
const sourceLines = source.split('\n')
const body = RANGES.map(([from, to]) => sourceLines.slice(from - 1, to).join('\n')).join('\n')

// --- функции index.mjs ----------------------------------------------------------------------

const env = { duplicate: null }
const eventStore = {
  async getByIdempotencyKey() {
    if (env.duplicate === 'throw') throw Object.assign(new Error('Журнал недоступен'), { code: 'STORE_UNAVAILABLE' })
    return env.duplicate == null ? null : structuredClone(env.duplicate)
  },
}
const EXPORTS = [
  'merchantCommandFingerprint', 'assertMerchantIdempotency', 'assertMerchantResultFingerprint', 'sanitizeMerchantLifecycleCommand',
  'merchantLifecycleFingerprint', 'assertMerchantLifecycleIdempotency', 'assertMerchantLifecycleResultFingerprint',
]
// eslint-disable-next-line no-new-func
const factory = new Function('createHash', 'eventStore', 'MAX_CURRENCY_CP', `'use strict'\n${body}\nreturn { ${EXPORTS.join(', ')} }`)
const F = factory(createHash, eventStore, MAX_CURRENCY_CP)

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const hasLoneSurrogate = (value) => typeof value === 'string' ? !value.isWellFormed() : Array.isArray(value) ? value.some(hasLoneSurrogate) : isPlain(value) ? Object.entries(value).some(([k, v]) => hasLoneSurrogate(k) || hasLoneSurrogate(v)) : false
const errorOf = (error) => {
  if (error instanceof ReferenceError || error instanceof SyntaxError) throw error
  return { code: error?.code ?? null, message: String(error?.message ?? error) }
}

const cases = []
const seen = new Set()
let excluded = 0

/** Один вызов на JSON-копиях аргументов; `undefined` аргумента — `null` в эталоне не бывает (все определены). */
async function call(fn, args, { duplicate = null } = {}) {
  const roundTrip = args.map(plain)
  env.duplicate = plain(duplicate)
  let out
  try {
    const value = await F[fn](...roundTrip.map((value) => structuredClone(value)))
    out = { ok: value === undefined ? null : plain(value) }
  } catch (error) {
    out = { err: errorOf(error) }
  }
  if (hasLoneSurrogate(out) || roundTrip.some(hasLoneSurrogate)) { excluded += 1; return out }
  const entry = { fn, args: roundTrip }
  if (duplicate != null) entry.duplicate = plain(duplicate)
  entry.out = out
  const key = JSON.stringify([fn, roundTrip, entry.duplicate])
  if (!seen.has(key)) { seen.add(key); cases.push(entry) }
  return out
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(2026_10_23_14)
const shuffled = (items) => [...items].sort(() => random() - 0.5)

// --- образцы и мутации ------------------------------------------------------------------------

const PRICING = {
  mode: 'catalog_with_agent_adjustment', buy_markup_bps: 11_000, sell_rate_bps: 5_000, bargain_dc: 12, success_discount_bps: 500,
  failure_markup_bps: 300, agent_adjustment_bps: -250, agent_adjustment_limit_percent: 10, description: '  Цены по каталогу  ',
}
const STOCK_ITEM = { stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', quantity: 3, name: 'Факел', type: 'tool', weight: 1.5, rarity: 'common', description: 'Горит час', properties: 'свет' }
const MERCHANT = {
  id: 'marten.shop', name: ' Мартен ', title: 'Снабженец', description: 'Торговец', greeting: 'Добро пожаловать.', voice: 'Спокойный', location: 'Рыночная площадь',
  location_id: 'loc-market', available: true, pricing: PRICING, purse_cp: 5_000, stock: [STOCK_ITEM, { stock_id: 'rope', quantity: 1 }],
  services: [{ service_id: 'heal', name: 'Лечение', description: 'Перевязка', kind: 'healing', base_price_cp: 500, duration_minutes: 30, available: true, requires_presence: false, tags: ['a', ' b ', ''] }],
  restock_policy: { enabled: true, interval_minutes: 720, last_restock_world_minute: 100, targets: [{ stock_id: 'torch', target_quantity: 5 }] },
}
const BASES = [
  { command_type: 'CreateMerchant', expected_state_version: 3, merchant: MERCHANT },
  { command_type: 'ConfigureMerchant', expected_state_version: 4, merchant_id: 'marten.shop', configuration: { name: 'Мартен', title: 'Главный', description: 'Д', greeting: 'Привет', voice: 'Тихий', pricing: { buy_markup_bps: 10_500 }, purse_cp: 10 } },
  { command_type: 'RestockMerchant', expected_state_version: 5, merchant_id: 'marten.shop', items: [STOCK_ITEM, { stock_id: 'rope', catalog_id: 'srd_5_2_1:rope', quantity: 4 }] },
  { command_type: 'MoveMerchant', expected_state_version: 6, merchant_id: 'marten.shop', location: 'Старый порт', location_id: 'loc-port' },
  { command_type: 'SetMerchantAvailability', expected_state_version: 7, merchant_id: 'marten.shop', available: false },
]

const JUNK = [
  undefined, null, '', '   ', '  отступ  ', 0, -1, 1, 1.5, 5, 30, 59, 60, 999_999, 1_000_000, 1_000_001, 100_000_000, 2 ** 53, 9_000_000_000, 9_000_000_001,
  0.1 + 0.2, 1e-7, '12', ' 7 ', '1e3', '0x10', 'abc', 'Infinity', true, false, [], [5], ['7'], [1, 2], [null], {}, { toString: 1 }, { valueOf: 1 }, [{ toString: 1 }],
  'x'.repeat(130), 'я'.repeat(1_100), '🙂'.repeat(70), 'catalog', 'catalog_with_agent_adjustment', 'retail', -2_000, -2_001, 2_000, 2_001, 20, 21, 1_000, 30_000, 30_001, 10_080, 10_081, 525_600, 525_601,
  1_000_000_000, 1_000_000_001, 'CreateMerchant', 'BuyItem',
]

/** Все пути объекта (листья и контейнеры). */
function paths(value, prefix = []) {
  const out = []
  if (Array.isArray(value)) value.forEach((item, index) => { out.push([...prefix, index]); out.push(...paths(item, [...prefix, index])) })
  else if (isPlain(value)) Object.entries(value).forEach(([key, item]) => { out.push([...prefix, key]); out.push(...paths(item, [...prefix, key])) })
  return out
}
function setAt(value, path, item) {
  const copy = structuredClone(value)
  let node = copy
  for (const key of path.slice(0, -1)) node = node[key]
  const last = path[path.length - 1]
  if (item === undefined) {
    if (Array.isArray(node)) node.splice(last, 1)
    else delete node[last]
  } else node[last] = item
  return copy
}

const sanitized = []
for (const base of BASES) {
  const out = await call('sanitizeMerchantLifecycleCommand', [base])
  if (out.ok) sanitized.push(out.ok)
  for (const path of paths(base)) {
    const depth = path.length
    const junk = depth <= 1 ? JUNK : shuffled(JUNK).slice(0, depth === 2 ? 16 : 7)
    for (const item of junk) await call('sanitizeMerchantLifecycleCommand', [setAt(base, path, item)])
  }
}
// camelCase и запасные поля.
const CAMEL_VARIANTS = [
  { commandType: 'MoveMerchant', expectedStateVersion: 2, merchantId: 'm', location: 'Порт', locationId: 'loc' },
  { type: 'SetMerchantAvailability', expected_state_version: '3', merchantId: ' m ', available: true },
  { command_type: null, commandType: 'MoveMerchant', expected_state_version: null, expectedStateVersion: 1, merchant_id: null, merchantId: 'm', location: 'x', location_id: null, locationId: 'y' },
  { command_type: 'MoveMerchant', expected_state_version: null, merchant_id: 'm', location: 'x' },
  { command_type: 'MoveMerchant', merchant_id: 'm', location: 'x' },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { merchant_id: 'alt', name: 'Имя', location: 'Где-то', locationId: 'loc-alt', stock: [{ stockId: 's', catalogId: 'c', quantity: '2' }], services: [{ id: 'svc', base_price_cp: 0 }] } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'big', name: 'Склад', location: 'Х', stock: Array.from({ length: 501 }, (_, index) => ({ stock_id: `s${index}`, quantity: 1 })) } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'big', name: 'Склад', location: 'Х', stock: Array.from({ length: 500 }, (_, index) => ({ stock_id: `s${index}`, quantity: 1 })) } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'svc', name: 'Храм', location: 'Х', services: Array.from({ length: 101 }, (_, index) => ({ service_id: `v${index}`, base_price_cp: 1 })) } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'tags', name: 'Т', location: 'Х', services: [{ service_id: 'v', base_price_cp: 1, tags: Array.from({ length: 15 }, (_, index) => ` t${index} `) }] } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'pol', name: 'Т', location: 'Х', restock_policy: { targets: Array.from({ length: 503 }, (_, index) => ({ stock_id: `s${index}`, target_quantity: 1 })) } } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'pol', name: 'Т', location: 'Х', restock_policy: { targets: ['s', 5, null] } } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'pol', name: 'Т', location: 'Х', restock_policy: { enabled: 'yes', targets: 'all' } } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'p', name: 'Т', location: 'Х', pricing: {} } },
  { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'p', name: 'Т', location: 'Х', ignored_secret: 'x' } },
  { command_type: 'RestockMerchant', expected_state_version: 0, merchant_id: 'm', items: Array.from({ length: 501 }, (_, index) => ({ stock_id: `s${index}`, quantity: 1 })) },
  { command_type: 'RestockMerchant', expected_state_version: 0, merchant_id: 'm', items: [] },
  { command_type: 'ConfigureMerchant', expected_state_version: 0, merchant_id: 'm', configuration: { forbidden: 'x' } },
  { command_type: 'ConfigureMerchant', expected_state_version: 0, merchant_id: 'm', configuration: { pricing: {} } },
  { command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'm' },
  { command_type: 'createmerchant', expected_state_version: 0 },
  { command_type: { toString: 1 }, expected_state_version: 0 },
  { command_type: ['MoveMerchant'], expected_state_version: 0, merchant_id: 'm', location: 'x' },
  {},
]
for (const variant of CAMEL_VARIANTS) {
  const out = await call('sanitizeMerchantLifecycleCommand', [variant])
  if (out.ok) sanitized.push(out.ok)
}
for (const input of [null, [], 'CreateMerchant', 5, true, [BASES[0]]]) await call('sanitizeMerchantLifecycleCommand', [input])

// Сверки повтора и итога: свой, чужой, пустой, повторённый и смешанный отпечатки.
const duplicates = (fingerprint) => [
  null, {}, { events: [] }, { events: null }, { events: [{ payload: { request_fingerprint: fingerprint } }] },
  { events: [{ payload: { request_fingerprint: fingerprint } }, { payload: { request_fingerprint: fingerprint } }] },
  { events: [{ payload: { request_fingerprint: fingerprint } }, { payload: { request_fingerprint: 'чужой' } }] },
  { events: [{ payload: { request_fingerprint: 'чужой' } }] }, { events: [{ payload: {} }, { payload: { request_fingerprint: fingerprint } }, { payload: { request_fingerprint: '' } }] },
  { events: [{ payload: { request_fingerprint: 0 } }, { payload: { request_fingerprint: fingerprint } }, {}, null] }, { events: [{ payload: { request_fingerprint: 5 } }] },
  { events: [{ payload: { request_fingerprint: false } }] }, 'throw',
]
for (const command of sanitized.slice(0, 12)) {
  const fingerprint = command.request_fingerprint
  await call('merchantLifecycleFingerprint', [command])
  for (const duplicate of duplicates(fingerprint)) {
    await call('assertMerchantLifecycleIdempotency', ['SHOP-14', 'key-1', command], { duplicate })
    if (duplicate !== 'throw') await call('assertMerchantLifecycleResultFingerprint', [duplicate == null ? null : { mechanics: duplicate.events, authoritative_state: {} }, command])
  }
}
const PLAYER_COMMANDS = [
  { command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten.shop', stock_id: 'torch', quantity: 2 },
  { command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten.shop', stock_id: 'torch', quantity: '2' },
  { command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten.shop', item_id: 'gem', quantity: 1 },
  { command_type: 'AppraiseItem', actor_id: 'hero', merchant_id: 'marten.shop', item_id: 'gem' },
  { command_type: 'PurchaseMerchantService', actor_id: 'hero', merchant_id: 'temple', service_id: 'heal' },
  { command_type: 'BargainWithMerchant', actor_id: 'hero', merchant_id: 'marten.shop' },
  { commandType: 'BuyItem', actor_id: 5, merchant_id: null, stock_id: 'x', quantity: 1.5 },
]
for (const command of PLAYER_COMMANDS) {
  const fingerprint = F.merchantCommandFingerprint(plain(command))
  for (const duplicate of duplicates(fingerprint)) {
    await call('assertMerchantIdempotency', ['SHOP-14', 'key-2', command], { duplicate })
    if (duplicate !== 'throw') await call('assertMerchantResultFingerprint', [duplicate == null ? null : { mechanics: duplicate.events }, command])
  }
}
await call('assertMerchantLifecycleResultFingerprint', [{}, sanitized[0]])
await call('assertMerchantResultFingerprint', [{ mechanics: 'x' }, PLAYER_COMMANDS[0]])

const guardFile = join(FIXTURES_DIR, 'c14-guard.json')
const guardText = JSON.stringify({ format: 'sk-server.merchant-guard/1', source: 'server/index.mjs', source_sha256: sha(source), ranges: RANGES, cases })
writeFileSync(guardFile, `${guardText}\n`)
const byFn = {}
for (const entry of cases) byFn[entry.fn] = (byFn[entry.fn] ?? 0) + 1
console.log(`эталон: ${guardFile} — ${cases.length} случаев (${cases.filter((entry) => entry.out.err).length} отказов), выброшено с суррогатом: ${excluded}, ${(guardText.length / 1e6).toFixed(2)} МБ`)
console.log(Object.entries(byFn).map(([fn, n]) => `${fn}:${n}`).join(' '))

// --- сценарий маршрутов ------------------------------------------------------------------------

const BIG_BODY = 4_000

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {unknown} value @returns {unknown} */
function shrink(value) {
  if (value === null || typeof value !== 'object') return value
  const text = canonical(value)
  if (text.length <= BIG_BODY) return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (canonical(parts).length <= BIG_BODY) return parts
  return `<sha256:${sha(text)}:${text.length}>`
}

/** Тело ответа: `authoritative_state` без летописи, большие ветви — хешем. @param {any} value */
function reduce(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'authoritative_state' && item && typeof item === 'object' && !Array.isArray(item)) {
      const { messages: _messages, ...state } = item
      return [key, Object.fromEntries(Object.entries(state).map(([field, entry]) => [field, shrink(entry)]))]
    }
    return [key, shrink(item)]
  }))
}

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const CODE = 'SHOP-14'

const { server, close } = await startGoldenServer()
try {
  const { send, exchanges } = recorder(server)
  const skip = () => Object.assign(exchanges[exchanges.length - 1], { body_norm: '<skip>' })
  const commands = (body, { code = CODE, role = 'admin', headers } = {}) => send(role, 'POST', `/api/campaigns/${code}/merchants/commands`, { body, headers })
  const assemble = (body, { code = CODE, role = 'admin', headers } = {}) => send(role, 'POST', `/api/campaigns/${code}/merchants/assemble`, { body, headers })
  const view = (role, merchant, query = '', code = CODE) => send(role, 'GET', `/api/campaigns/${code}/merchants/${merchant}${query}`)

  // Без входа — 401 на всех трёх.
  await commands({ command: {} }, { role: 'anon' })
  await assemble({}, { role: 'anon' })
  await view('anon', 'marten.shop', '?actor_id=hero')

  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } }); skip()
  await send('player', 'POST', '/api/auth/register', { body: PLAYER }); skip()
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER }); skip()
  const initialState = {
    sessionCode: CODE, campaign: 'Лавки', partyName: 'Покупатели', partyMemberIds: ['hero', 'hero-2'], activePlayerId: 'hero', isNarrating: false,
    pendingCheck: null, suggestions: [], messages: [], merchants: [], economyLog: [],
    players: [
      { id: 'hero', name: 'Аня', character: 'Астер', hp: 10, maxHp: 10, armor: 12, abilities: { cha: 12 }, inventory: [], currency: { gold: 10 }, online: true },
      { id: 'hero-2', name: 'Второй', character: 'Борей', hp: 10, maxHp: 10, armor: 12, abilities: { cha: 10 }, inventory: [], currency: { gold: 2 }, online: true },
    ],
    scene: { title: 'Рынок', location: 'Рыночная площадь', mood: 'Шумно', objective: 'Торговля', turn: 1, cells: [] },
    adventure: { chapter: 1, history: [], visitedLocations: ['Рыночная площадь'] },
  }
  await send('admin', 'POST', '/api/campaigns', { body: { code: CODE, name: 'Лавки', state: initialState } }); skip()
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'NOWHERE-14', name: 'Без места', state: { ...initialState, sessionCode: 'NOWHERE-14', scene: { title: 'Пусто', location: '   ' } } } }); skip()
  const invite = await send('admin', 'POST', `/api/campaigns/${CODE}/invites`, { body: { hero_ids: ['hero'] } }); skip()
  const inviteIndex = exchanges.length - 1
  await send('player', 'POST', `/api/campaigns/${CODE}/join`, { body: { invite_token: invite.body.token } }); skip()
  Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${inviteIndex}>` } })

  // Права: игрок — 403 администратора.
  await commands({ command: { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'forged', name: 'Forged' } }, idempotency_key: 'p' }, { role: 'player' })
  await assemble({ expected_state_version: 0, idempotency_key: 'p' }, { role: 'player' })

  // Комната, тело, ключ.
  await commands({ command: {} }, { code: 'NOPE-14' })
  await assemble({}, { code: 'NOPE-14' })
  await commands([])
  await commands(42)
  await commands({})
  await commands({ command: [] })
  await commands({ command: 'CreateMerchant' })
  await commands({ command: { command_type: 'MoveMerchant' } })
  await commands({ command: { command_type: 'MoveMerchant' }, idempotency_key: '   ' })
  await commands({ command: { command_type: 'MoveMerchant' }, idempotency_key: 'k'.repeat(201) })
  await commands({ command: { command_type: 'MoveMerchant' }, idempotency_key: '🙂'.repeat(101) })
  await commands({ command: { command_type: 'MoveMerchant' }, idempotency_key: { toString: 1 } })
  await commands({ command: { command_type: 'MoveMerchant' }, idempotency_key: null }, { headers: { 'x-idempotency-key': ' hdr-1 ' } })
  await commands({ command: { command_type: 'BuyItem', actor_id: 'hero' }, idempotency_key: 'buy' })
  await commands({ command: { command_type: 'CreateMerchant', expected_state_version: 'x' }, idempotency_key: 'bad-version' })
  await commands({ command: { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'm', name: 'Имя' } }, idempotency_key: 'no-location' })
  await commands({ command: { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'm', name: 'Имя', location: 'Х', available: 'yes' } }, idempotency_key: 'bad-available' })

  // Обход через /commands — отказ отдельным кодом.
  await send('admin', 'POST', `/api/campaigns/${CODE}/commands`, { body: { idempotency_key: 'bypass', command: { command_type: 'CreateMerchant', expected_state_version: 0, merchant: { id: 'bypass', name: 'Bypass' } } } })

  // Жизненный цикл: создание, повтор, конфликт ключа, устаревшая версия, все команды.
  const create = {
    command_type: 'CreateMerchant', expected_state_version: 0,
    merchant: { ...MERCHANT, ignored_secret: 'не попадёт в событие', stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', quantity: 3, name: 'Факел', type: 'tool' }] },
  }
  await commands({ command: create, idempotency_key: 'create-marten' })
  await commands({ command: create, idempotency_key: 'create-marten' })
  await commands({ command: { ...create, merchant: { ...create.merchant, name: 'Другой' } }, idempotency_key: 'create-marten' })
  await commands({ command: { command_type: 'MoveMerchant', expected_state_version: 1, merchant_id: 'marten.shop', location: 'Порт' }, idempotency_key: 'create-marten' })
  await commands({ command: { ...create, expected_state_version: 1 }, idempotency_key: 'create-again' })
  await commands({ command: { command_type: 'ConfigureMerchant', expected_state_version: 0, merchant_id: 'marten.shop', configuration: { title: 'Старое' } }, idempotency_key: 'stale' })
  await commands({ command: { command_type: 'ConfigureMerchant', expected_state_version: 1, merchant_id: 'nobody', configuration: { title: 'Никто' } }, idempotency_key: 'nobody' })
  await commands({ command: { command_type: 'ConfigureMerchant', expected_state_version: 1, merchant_id: 'marten.shop', configuration: { title: 'Главный снабженец', pricing: { buy_markup_bps: 10_500, agent_adjustment_bps: -250 }, forbidden: 'x' } }, idempotency_key: 'configure' })
  await commands({ command: { command_type: 'RestockMerchant', expectedStateVersion: 2, merchantId: 'marten.shop', items: [{ stock_id: 'torch', quantity: 2 }, { stockId: 'rope', catalogId: 'srd_5_2_1:rope-hempen-50-feet', quantity: '4', name: 'Верёвка', type: 'tool' }] } }, { headers: { 'x-idempotency-key': 'restock' } })
  await view('player', 'marten.shop', '?actor_id=hero')
  await view('admin', 'marten.shop', '?actor_id=hero-2')
  await commands({ command: { command_type: 'MoveMerchant', expected_state_version: 3, merchant_id: 'marten.shop', location: 'Старый порт', location_id: 'loc-port' }, idempotency_key: 'move' })
  await view('player', 'marten.shop', '?actor_id=hero')
  await commands({ command: { command_type: 'MoveMerchant', expected_state_version: 4, merchant_id: 'marten.shop', location: 'Рыночная площадь' }, idempotency_key: 'move-back' })
  await commands({ command: { command_type: 'SetMerchantAvailability', expected_state_version: 5, merchant_id: 'marten.shop', available: false }, idempotency_key: 'disable' })
  await view('player', 'marten.shop', '?actor_id=hero')
  await commands({ command: { command_type: 'SetMerchantAvailability', expected_state_version: 6, merchant_id: 'marten.shop', available: true }, idempotency_key: 'enable' })

  // Витрина: права, герой, id, хвосты пути.
  await view('player', 'marten.shop', '?actor_id=hero')
  await view('player', 'marten%2Eshop', '?actor_id=hero&actor_id=hero-2')
  await view('outsider', 'marten.shop', '?actor_id=hero')
  await view('player', 'marten.shop')
  await view('player', 'marten.shop', '?actor_id=')
  await view('player', 'marten.shop', '?actor_id=hero-2')
  await view('player', 'nobody', '?actor_id=hero')
  await view('admin', 'marten.shop', '?actor_id=nobody')
  await view('player', 'marten.shop', '?actor_id=hero', 'NOPE-14')
  await view('player', '%E0', '?actor_id=hero')
  await send('player', 'DELETE', `/api/campaigns/${CODE}/merchants/%E0`)
  await view('player', 'commands', '?actor_id=hero')
  await view('player', 'assemble', '?actor_id=hero')
  await view('player', 'marten.shop/commands', '?actor_id=hero')
  await send('admin', 'PUT', `/api/campaigns/${CODE}/merchants/commands`, { body: {} })
  await send('admin', 'GET', `/api/campaigns/${CODE}/merchants/assemble/x`)

  // Сборка магазина: поля, ключ, версия, отказы сборщика, успех, повтор, конфликт.
  await assemble({ expected_state_version: 7, idempotency_key: 'a', price: 1 })
  await assemble([])
  await assemble({ expected_state_version: 7 })
  await assemble({ expected_state_version: 7, idempotency_key: 'k'.repeat(201) })
  await assemble({ expected_state_version: 'x', idempotency_key: 'a-bad-version' })
  await assemble({ idempotency_key: 'a-no-version' })
  await assemble({ expected_state_version: 7, idempotency_key: 'a-bad-town', settlement_type: 'metropolis' })
  await assemble({ expected_state_version: 7, idempotency_key: 'a-bad-theme', theme: 'dragons' })
  await assemble({ expected_state_version: 7, idempotency_key: 'a-bad-budget', budget_cp: -5 })
  await assemble({ expected_state_version: 7, idempotency_key: 'a-object-town', settlement_type: { toString: 1 } })
  await assemble({ expected_state_version: 7, idempotency_key: 'a-forged', theme: 'provisions', seed: 'forged', director_intent: { stock: [{ catalog_id: 'srd_5_2_1:torch', quantity: 1, base_price_cp: 999_999 }], agent_adjustment_bps: 0 } })
  await assemble({ expected_state_version: 0, idempotency_key: 'a-nowhere' }, { code: 'NOWHERE-14' })
  const assembled = {
    expected_state_version: 7, settlement_type: 'town', theme: 'provisions', seed: 'c14-provisioner', budget_cp: 20_000,
    director_intent: { stock: [{ catalog_id: 'srd_5_2_1:potion-of-healing', quantity: 2 }, { catalog_id: 'srd_5_2_1:torch', quantity: 4 }], agent_adjustment_bps: -500 },
  }
  await assemble({ ...assembled, idempotency_key: 'assemble-1' })
  await assemble({ ...assembled, idempotency_key: 'assemble-1' })
  await assemble({ ...assembled, seed: 'другой', idempotency_key: 'assemble-1' })
  await assemble({ expected_state_version: 8, idempotency_key: 'create-marten' })
  await assemble({ expected_state_version: 7, idempotency_key: 'assemble-stale', seed: 'stale' })
  await assemble({ expected_state_version: 8, settlement_type: null, theme: null, seed: null, budget_cp: null, director_intent: null }, { headers: { 'x-idempotency-key': 'assemble-default' } })
  await assemble({ expected_state_version: 9, idempotency_key: 'assemble-default-2' })

  // Лимиты: 60 изменений и 30 сборок на ведущего (счёт идёт с начала сценария).
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const response = await commands({}, { headers: { 'x-idempotency-key': `rate-${attempt}` } })
    if (response.status === 429) break
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await assemble({ idempotency_key: `rate-a-${attempt}` })
    if (response.status === 429) break
  }

  for (const entry of /** @type {any[]} */ (exchanges)) {
    if (entry.body_norm !== '<skip>') entry.body_norm = reduce(entry.body_norm)
  }
  const file = join(FIXTURES_DIR, 'c14.json')
  writeFileSync(file, `${JSON.stringify({
    format: GOLDEN_FORMAT,
    scenario: 'торговцы: права, комната, тело и ключ, пять lifecycle-команд, повтор и конфликт ключа, устаревшая версия, обход через /commands, витрина торговца и общий страж id, сборка магазина, лимиты 60 и 30',
    exchanges,
  }, null, 2)}\n`)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
