// Эталон «Г» комнаты, общего кубика и выдачи кости (С10):
// `node rust/crates/sk-server/fixtures/gen-c10.mjs` пишет `fixtures/c10.json`;
// сверка — `tests/c10_golden.rs`.
//
// Правила сверх общего формата `skazanie.golden/1` (как в `gen-c6.mjs`):
// * токен приглашения — ссылкой `<invite:N>` в теле входа;
// * хеш карты из ответа обмена N в адресе — `<map_hash:N>` (Rust подставляет
//   хеш из своего ответа N, а сам хеш сверяется в теле того ответа);
// * большие ветви тела — `<sha256:хеш:длина>` от JSON с ключами по алфавиту
//   (порядок ключей верхнего уровня комнаты в Rust — журнала, а не JS);
// * время строк летописи `ЧЧ:ММ` — `<clock>`;
// * кости сервера — правила `DICE`.
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ value: 2 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const BIG_BODY = 4_000
const CLOCK = /^\d{2}:\d{2}$/u

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function clock(value) {
  if (Array.isArray(value)) return value.map(clock)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'timestamp' && typeof item === 'string' && CLOCK.test(item) ? '<clock>' : clock(item)]))
  }
  return value
}

/**
 * JSON с ключами объектов по алфавиту (кодовые единицы UTF-16).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(/** @type {any} */ (value)[key])]))
  return value
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function shrink(value) {
  const text = JSON.stringify(sorted(value))
  if (text === undefined || text.length <= BIG_BODY || value === null || typeof value !== 'object') return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (JSON.stringify(parts).length <= BIG_BODY) return parts
  return `<sha256:${createHash('sha256').update(text).digest('hex')}:${text.length}>`
}

function cells(width = 6, height = 4) {
  return Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', passable: true, revealed: true }))
}

/** Готовое состояние для импорта администратором: двое героев и карта. */
function importedState(code) {
  return {
    sessionCode: code,
    campaign: 'Две грани',
    partyName: 'Проверка броска',
    partyMemberIds: ['hero-one', 'hero-two'],
    activePlayerId: 'hero-one',
    messages: [],
    players: [
      { id: 'hero-one', name: 'Агата', character: 'Агата', hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'hero-two', name: 'Гелла', character: '', hp: 18, maxHp: 18, armor: 13, speed: 30, proficiency: 2, abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 10 }, inventory: [], x: 3, y: 1 },
    ],
    scene: { title: 'Зал двух граней', location: 'Зал двух граней', mood: '', objective: 'Проверить общий кубик', turn: 0, cells: cells() },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  const join = async (role, code, index) => {
    const token = /** @type {any} */ (exchanges[index]).raw_token
    await send(role, 'POST', `/api/campaigns/${code}/join`, { body: { invite_token: token } })
    Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${index}>` } })
  }
  const invite = async (role, code, body = {}) => {
    const response = await send(role, 'POST', `/api/campaigns/${code}/invites`, { body })
    Object.assign(exchanges[exchanges.length - 1], { raw_token: response.body?.token ?? null })
    return exchanges.length - 1
  }
  /** Комната с хешем карты из ответа обмена `index`. */
  const withHash = async (role, code, index) => {
    const hash = /** @type {any} */ (exchanges[index]).raw_map_hash
    await send(role, 'GET', `/api/rooms/${code}?map_hash=${encodeURIComponent(hash)}`)
    Object.assign(exchanges[exchanges.length - 1], { path: `/api/rooms/${code}?map_hash=<map_hash:${index}>` })
  }
  const room = async (role, path) => {
    const response = await send(role, 'GET', path)
    Object.assign(exchanges[exchanges.length - 1], { raw_map_hash: response.body?.state?.scene?.map_hash ?? null })
    return exchanges.length - 1
  }

  // Без входа.
  await send('anon', 'GET', '/api/rooms/ROOM-1')
  await send('anon', 'PUT', '/api/rooms/ROOM-1', { body: {} })
  await send('anon', 'POST', '/api/rooms/ROOM-1/dice', { body: {} })
  await send('anon', 'POST', '/api/roll', { body: {} })
  // Аккаунты и кампания: двое владельцев героев и посторонний.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('owner', 'POST', '/api/auth/register', { body: OWNER })
  await send('guest', 'POST', '/api/auth/register', { body: GUEST })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'ROOM-1', name: 'Две грани', state: importedState('ROOM-1') } })
  const ownerInvite = await invite('admin', 'ROOM-1', { hero_ids: ['hero-one'] })
  const guestInvite = await invite('admin', 'ROOM-1', { hero_ids: ['hero-two'] })
  await join('owner', 'ROOM-1', ownerInvite)
  await join('guest', 'ROOM-1', guestInvite)

  // Комната: проекция зрителя, хеш карты, пустая комната, отказы.
  const first = await room('owner', '/api/rooms/ROOM-1')
  await withHash('owner', 'ROOM-1', first)
  await send('owner', 'GET', '/api/rooms/ROOM-1?map_hash=chuzhoy-hash')
  await send('owner', 'GET', '/api/rooms/room-1')
  await send('guest', 'GET', '/api/rooms/ROOM-1')
  await room('admin', '/api/rooms/ROOM-1')
  await send('outsider', 'GET', '/api/rooms/ROOM-1')
  await send('admin', 'GET', '/api/rooms/NOPE-1')
  await send('owner', 'GET', '/api/rooms/NOPE-1')
  await send('owner', 'GET', '/api/rooms/BAD_ID')
  await send('owner', 'GET', '/api/rooms/ROOM-1/')
  await send('owner', 'DELETE', '/api/rooms/ROOM-1')
  await send('owner', 'PATCH', '/api/rooms/ROOM-1', { body: {} })

  // Полная запись комнаты снята.
  await send('owner', 'PUT', '/api/rooms/ROOM-1', { body: { state: {}, baseVersion: 1 } })
  await send('owner', 'PUT', '/api/rooms/ROOM-1?x=1', { body: {} })
  await send('outsider', 'PUT', '/api/rooms/ROOM-1', { body: {} })
  await send('owner', 'PUT', '/api/rooms/NOPE-1', { body: {} })
  await send('admin', 'PUT', '/api/rooms/NOPE-1', { body: {} })

  // Общий кубик.
  await send('owner', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-one', sides: 6 } })
  await send('guest', 'GET', '/api/rooms/ROOM-1')
  await send('owner', 'POST', '/api/rooms/ROOM-1/dice?x=1', { body: { playerId: 'hero-one', sides: 6 } })
  await send('owner', 'GET', '/api/rooms/ROOM-1/dice')
  await send('owner', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-two', sides: 20 } })
  await send('owner', 'POST', '/api/rooms/ROOM-1/dice', { body: { sides: 20 } })
  await send('outsider', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-one' } })
  await send('guest', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-two', sides: 7 } })
  await send('guest', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-two', sides: 'много' } })
  await send('guest', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-two', sides: '8' } })
  await send('guest', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'hero-two', sides: null } })
  await send('guest', 'POST', '/api/rooms/room-1/dice', { body: { playerId: 'hero-two', sides: [100] } })
  await send('owner', 'POST', '/api/rooms/ROOM-1/dice', { body: [] })
  await send('admin', 'POST', '/api/rooms/ROOM-1/dice', { body: { playerId: 'ghost', sides: 4 } })
  await send('admin', 'POST', '/api/rooms/NOPE-1/dice', { body: { playerId: 'hero-one', sides: 4 } })
  await send('owner', 'POST', '/api/rooms/NOPE-1/dice', { body: { playerId: 'hero-one', sides: 4 } })
  await send('owner', 'GET', '/api/rooms/ROOM-1')

  // Кость только под объявленную проверку.
  await send('owner', 'POST', '/api/roll', { body: { campaignId: 'ROOM-1', playerId: 'hero-one' } })
  await send('owner', 'POST', '/api/roll', { body: { campaign_id: 'ROOM-1', playerId: 'hero-one', checkId: 'nope' } })
  await send('owner', 'POST', '/api/roll', { body: { campaignId: 'ROOM-1', playerId: 'hero-one', check_id: 'nope-2' } })
  await send('owner', 'POST', '/api/roll', { body: { playerId: 'hero-one' } })
  await send('owner', 'POST', '/api/roll', { body: { campaignId: 'ROOM-1', playerId: 'hero-two' } })
  await send('outsider', 'POST', '/api/roll', { body: { campaignId: 'ROOM-1', playerId: 'hero-one' } })
  await send('admin', 'POST', '/api/roll', { body: { campaignId: 'NOPE-1', playerId: 'hero-one' } })
  await send('admin', 'POST', '/api/roll', { body: { campaignId: '___', playerId: 'hero-one' } })
  await send('admin', 'POST', '/api/roll', { body: { campaignId: 'ROOM-1' } })
  await send('owner', 'POST', '/api/roll', { body: [] })
  await send('owner', 'POST', '/api/roll?x=1', { body: { campaignId: 'ROOM-1', playerId: 'hero-one' } })
  await send('owner', 'GET', '/api/roll')

  // `C10_DUMP=<файл>` — тела целиком (ключи по алфавиту) для разбора расхождения хешей.
  if (process.env.C10_DUMP) writeFileSync(process.env.C10_DUMP, JSON.stringify(exchanges.map((entry) => sorted(clock(/** @type {any} */ (entry).body_norm))), null, 2))
  for (const entry of /** @type {any[]} */ (exchanges)) {
    entry.body_norm = shrink(clock(entry.body_norm))
    delete entry.raw_token
    delete entry.raw_map_hash
  }
  const file = writeGolden('c10', 'комната: проекция зрителя и хеш карты, пустая комната, отказы, снятый PUT, общий кубик, выдача кости', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
