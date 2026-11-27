// Эталон «Г» С18.2: торговля игрока `POST /api/campaigns/:id/merchants/:merchantId/commands`.
//
//   node rust/crates/sk-server/fixtures/gen-c18-2.mjs
//
// Пишет `fixtures/c18-2.json` (формат `skazanie.golden/1`), сверка —
// `tests/c18_2_golden.rs`. Сценарий: 401 без входа, комната и доступ, тело,
// санитайзер (тип команды, чужой герой, герой не в отряде, версия котировок,
// id торговца из пути важнее тела), оценка, покупка, повтор и конфликт
// ключа, устаревшая версия, продажа, торг (кости сервера — правила `DICE`),
// услуга, недоступный и неизвестный торговец, ключ в заголовке, сделка
// ведущего за героя, `POST` без хвоста `/commands`, битый id, лимит 120.
//
// Правила сверх общего формата: тела подготовительных обменов — `<skip>`;
// токен приглашения — ссылка `<invite:N>`; у `authoritative_state` снята
// летопись `messages`, большие ветви — по частям или хешем канонического
// текста (как в С14).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

import { FIXTURES_DIR, GOLDEN_FORMAT, recorder, startGoldenServer } from './golden.mjs'

export const DICE = {
  format: 'skazanie.test-dice/1',
  rules: [
    { sides: 20, value: 15 },
    { value: 'min' },
  ],
}

const BIG_BODY = 4_000

/** @param {string} text */
const sha = (text) => createHash('sha256').update(text).digest('hex')

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
const CODE = 'SHOP-18'

const initialState = {
  sessionCode: CODE, campaign: 'Торговля', partyName: 'Покупатели', partyMemberIds: ['hero', 'hero-2'],
  activePlayerId: 'hero', engine_mode: 'enforce', isNarrating: false, pendingCheck: null, suggestions: [], messages: [], economyLog: [],
  players: [
    {
      id: 'hero', name: 'Аня', character: 'Астер', hp: 10, maxHp: 10, armor: 12, proficiency: 2,
      abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 16 }, skills: { persuasion_bonus: 2 },
      currency: { copper: 0, silver: 0, gold: 101, platinum: 0 },
      inventory: [
        { id: 'hero-dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 2, equipped: false, base_price_cp: 99_999, combat: { kind: 'melee', ability: 'dex', damage: '1d4', damageType: 'piercing', normalRange: 5 } },
        { id: 'quest-letter', name: 'Письмо короля', type: 'document', rarity: 'сюжетный', quantity: 1, equipped: false, base_price_cp: 10_000 },
        { id: 'gem', name: 'Самоцвет', type: 'treasure', rarity: 'обычный', quantity: 1, equipped: false },
      ], online: true,
    },
    { id: 'hero-2', name: 'Второй', character: 'Борей', hp: 10, maxHp: 10, armor: 12, abilities: { cha: 10 }, currency: { gold: 100 }, inventory: [], online: true },
  ],
  merchants: [
    {
      id: 'marten.shop', name: 'Мартен', location: 'Рыночная площадь', available: true, purse_cp: 20_000,
      pricing: { buy_markup_bps: 11_000, sell_rate_bps: 5_000, bargain_dc: 15, success_discount_bps: 1_000, failure_markup_bps: 500, agent_adjustment_bps: 0 },
      services: [{ service_id: 'repair', name: 'Починка доспеха', kind: 'repair', base_price_cp: 100, duration_minutes: 30 }],
      stock: [
        { stock_id: 'potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: 3 },
        { stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'other', quantity: 10 },
        { stock_id: 'rope', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', name: 'Верёвка', type: 'tool', quantity: 4 },
      ],
    },
    { id: 'far-merchant', name: 'Дальний торговец', location: 'Другой город', available: true, pricing: {}, stock: [{ stock_id: 'far-torch', catalog_id: 'srd_5_2_1:torch', quantity: 1 }] },
  ],
  scene: { title: 'Рынок', location: 'Рыночная площадь', mood: 'Шумно', objective: 'Торговля', turn: 1, cells: [] },
  mechanics: { world_time: { elapsed_minutes: 60 } },
  adventure: { chapter: 1, history: [], visitedLocations: ['Рыночная площадь'] },
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  const skip = () => Object.assign(exchanges[exchanges.length - 1], { body_norm: '<skip>' })
  const trade = (body, { merchant = 'marten.shop', code = CODE, role = 'player', headers, tail = '/commands' } = {}) => send(role, 'POST', `/api/campaigns/${code}/merchants/${merchant}${tail}`, { body, headers })
  const version = async (role = 'player', actor = 'hero') => {
    const view = await send(role, 'GET', `/api/campaigns/${CODE}/merchants/marten.shop?actor_id=${actor}`)
    return view.body.merchant_view.expected_state_version
  }

  // Без входа — 401.
  await trade({ command: {} }, { role: 'anon' })

  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } }); skip()
  await send('player', 'POST', '/api/auth/register', { body: PLAYER }); skip()
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER }); skip()
  await send('admin', 'POST', '/api/campaigns', { body: { code: CODE, name: 'Торговля', state: initialState } }); skip()
  const invite = await send('admin', 'POST', `/api/campaigns/${CODE}/invites`, { body: { hero_ids: ['hero'] } }); skip()
  const inviteIndex = exchanges.length - 1
  await send('player', 'POST', `/api/campaigns/${CODE}/join`, { body: { invite_token: invite.body.token } }); skip()
  Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${inviteIndex}>` } })

  // Комната, доступ, тело.
  await trade({ command: {} }, { code: 'NOPE-18' })
  await trade({ command: {} }, { role: 'outsider' })
  await trade([])
  await trade(42)
  await trade({})
  await trade({ command: [] })
  await trade({ command: 'BuyItem' })
  await trade({ command: null })

  // Санитайзер.
  let v = await version()
  await trade({ command: { command_type: 'CreateMerchant', actor_id: 'hero', expected_state_version: v }, idempotency_key: 'forged-type' })
  await trade({ command: { command_type: 'BuyItem', expected_state_version: v, stock_id: 'torch', quantity: 1 }, idempotency_key: 'no-actor' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero-2', expected_state_version: v, stock_id: 'torch', quantity: 1 }, idempotency_key: 'foreign' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'ghost', expected_state_version: v, stock_id: 'torch', quantity: 1 }, idempotency_key: 'ghost' }, { role: 'admin' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', stock_id: 'torch', quantity: 1 }, idempotency_key: 'no-version' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', expected_state_version: -1, stock_id: 'torch', quantity: 1 }, idempotency_key: 'negative-version' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', expected_state_version: 1.5, stock_id: 'torch', quantity: 1 }, idempotency_key: 'fraction-version' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', expected_state_version: v, stock_id: 'nothing', quantity: 1 }, idempotency_key: 'no-stock' })
  await trade({ command: { command_type: 'SellItem', actor_id: 'hero', expected_state_version: v, item_id: 'nothing', quantity: 1 }, idempotency_key: 'no-item' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', expected_state_version: v, stock_id: 'torch', quantity: 1 }, idempotency_key: 'nobody' }, { merchant: 'nobody' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', expected_state_version: v, stock_id: 'far-torch', quantity: 1 }, idempotency_key: 'far' }, { merchant: 'far-merchant' })
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero', expected_state_version: v, stock_id: 'potion', quantity: 99 }, idempotency_key: 'too-many' })

  // Оценка, покупка (id торговца из пути важнее тела), повтор и конфликт ключа.
  await trade({ command: { command_type: 'AppraiseItem', actor_id: 'hero', expected_state_version: v, item_id: 'gem' }, idempotency_key: 'appraise-gem', message: 'Сколько стоит?' })
  v = await version()
  const buy = { command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'far-merchant', expected_state_version: v, stock_id: 'potion', quantity: 1, price_cp: 1 }
  await trade({ command: buy, idempotency_key: 'buy-potion' })
  await trade({ command: buy, idempotency_key: 'buy-potion' })
  await trade({ command: { ...buy, quantity: 2 }, idempotency_key: 'buy-potion' })
  await trade({ command: { command_type: 'AppraiseItem', actor_id: 'hero', expected_state_version: v, item_id: 'gem' }, idempotency_key: 'buy-potion' })
  await trade({ command: { ...buy, stock_id: 'torch' }, idempotency_key: 'stale-version' })
  v = await version()
  await trade({ command: { commandType: 'BuyItem', actorId: 'hero', expectedStateVersion: v, stockId: 'torch', quantity: '2' } }, { headers: { 'x-idempotency-key': 'header-key' } })

  // Продажа, торг, услуга.
  v = await version()
  await trade({ command: { command_type: 'SellItem', actor_id: 'hero', expected_state_version: v, item_id: 'hero-dagger', quantity: 1 }, idempotency_key: 'sell-dagger' })
  v = await version()
  await trade({ command: { command_type: 'SellItem', actor_id: 'hero', expected_state_version: v, item_id: 'quest-letter', quantity: 1 }, idempotency_key: 'sell-letter' })
  await trade({ command: { command_type: 'BargainWithMerchant', actor_id: 'hero', expected_state_version: v, roll: 20 }, idempotency_key: 'bargain' })
  await trade({ command: { command_type: 'BargainWithMerchant', actor_id: 'hero', expected_state_version: v }, idempotency_key: 'bargain' })
  v = await version()
  await trade({ command: { command_type: 'BargainWithMerchant', actor_id: 'hero', expected_state_version: v }, idempotency_key: 'bargain-again' })
  v = await version()
  await trade({ command: { command_type: 'PurchaseMerchantService', actor_id: 'hero', expected_state_version: v, service_id: 'nothing' }, idempotency_key: 'no-service' })
  await trade({ command: { command_type: 'PurchaseMerchantService', actor_id: 'hero', expected_state_version: v, service_id: 'repair' }, idempotency_key: 'repair' })

  // Ведущий торгует за героя; герой второго игрока — тоже.
  v = await version('admin', 'hero-2')
  await trade({ command: { command_type: 'BuyItem', actor_id: 'hero-2', expected_state_version: v, stock_id: 'rope', quantity: 1 }, idempotency_key: 'admin-rope' }, { role: 'admin' })

  // Ключ другого маршрута: lifecycle ведущего под тем же ключом.
  await send('admin', 'POST', `/api/campaigns/${CODE}/merchants/commands`, { body: { command: { command_type: 'SetMerchantAvailability', expected_state_version: v + 1, merchant_id: 'marten.shop', available: true }, idempotency_key: 'shared-key' } })
  v = await version()
  await trade({ command: { command_type: 'AppraiseItem', actor_id: 'hero', expected_state_version: v, item_id: 'gem' }, idempotency_key: 'shared-key' })

  // Путь: без хвоста `/commands`, битый id, кодированный id, лишний хвост.
  await trade({ command: {} }, { tail: '' })
  await trade({ command: {} }, { merchant: '%E0' })
  await trade({ command: { command_type: 'AppraiseItem', actor_id: 'hero', expected_state_version: v, item_id: 'gem' }, idempotency_key: 'encoded-id' }, { merchant: 'marten%2Eshop' })
  await trade({ command: {} }, { tail: '/commands/x' })

  // Лимит: 120 торговых операций на пользователя (счёт идёт с начала сценария).
  for (let attempt = 0; attempt < 130; attempt += 1) {
    const response = await trade({}, { headers: { 'x-idempotency-key': `rate-${attempt}` } })
    if (response.status === 429) break
  }
  // У другого пользователя счёт свой.
  await trade({}, { role: 'admin' })

  for (const entry of /** @type {any[]} */ (exchanges)) {
    if (entry.body_norm !== '<skip>') entry.body_norm = reduce(entry.body_norm)
  }
  const file = join(FIXTURES_DIR, 'c18-2.json')
  writeFileSync(file, `${JSON.stringify({
    format: GOLDEN_FORMAT,
    scenario: 'торговля игрока: 401, комната, доступ и тело, санитайзер, оценка, покупка, повтор и конфликт ключа, устаревшая версия, продажа, торг, услуга, недоступный торговец, ключ в заголовке и чужого маршрута, сделка ведущего, хвосты пути и битый id, лимит 120',
    exchanges,
  }, null, 2)}\n`)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
