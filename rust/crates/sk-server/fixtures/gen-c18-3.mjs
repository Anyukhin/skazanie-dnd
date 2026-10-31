// Эталон «Г» С18.3: сборка встречи `POST /api/campaigns/:id/encounters/assemble`.
//
//   node rust/crates/sk-server/fixtures/gen-c18-3.mjs
//
// Пишет `fixtures/c18-3.json` (формат `skazanie.golden/1`), сверка —
// `tests/c18_3_golden.rs`. Сценарий: 401 без входа, 403 игроку, кампании нет,
// тело (не объект, лишнее поле), ключ (нет, длинный, в заголовке), версия
// (дробь, строка, отрицательная, устаревшая), сборка с ходами врагов до героя
// (кости сервера — правила `DICE`), повтор и конфликт ключа (отпечатки
// встречи: другая сложность, тема, зерно), новая встреча во время боя,
// отряд без живых (отказ предпросмотра), смертельная встреча со стенами,
// окнами и занятыми клетками — предупреждение в летописи до боя, зерно по
// умолчанию, лимит 30.
//
// Правила сверх общего формата: тела подготовительных обменов — `<skip>`;
// токен приглашения — ссылка `<invite:N>`; у `authoritative_state` снята
// летопись `messages`, большие ветви — по частям или хешем канонического
// текста (как в С14 и С18.2); у `GET /api/rooms` — только летопись (id,
// голос, автор, текст). Строка боя (`narration` ответа и реплика летописи
// `combat-…`) — `<combat-line>`: формулировку шага `Phrasebook` выбирает по
// случайному `event_id` (`phraseSeed`), и у двух прогонов JS она тоже
// разная (как в С18.1).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

import { FIXTURES_DIR, GOLDEN_FORMAT, recorder, startGoldenServer } from './golden.mjs'

export const DICE = {
  format: 'skazanie.test-dice/1',
  rules: [
    { purpose: '^initiative$', actor: '^hero', value: 'min' },
    { purpose: '^initiative$', value: 'max' },
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

/**
 * Строки `narration` на любой глубине — `<combat-line>`, `verification` —
 * `<verification>`: проверка рассказа (`valid`, `violations`) и выдача
 * записанного рассказа на повторе ключа (`response_plan`, `origin`) зависят
 * от случайной формулировки — у двух прогонов JS по-разному.
 * @param {unknown} value @returns {unknown}
 */
function maskNarration(value) {
  if (Array.isArray(value)) return value.map(maskNarration)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === 'narration' && typeof item === 'string' && item) return [key, '<combat-line>']
      if (key === 'verification' && item && typeof item === 'object' && !Array.isArray(item)) {
        return [key, '<verification>']
      }
      return [key, maskNarration(item)]
    }))
  }
  return value
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

/** Летопись комнаты: id, голос, автор, текст. @param {any} value */
function journal(value) {
  const messages = Array.isArray(value?.state?.messages) ? value.state.messages : []
  return { messages: messages.map((message) => ({ id: message.id ?? null, speaker: message.speaker ?? null, author: message.author ?? null, text: String(message.id ?? '').startsWith('combat-') ? '<combat-line>' : message.text ?? null })) }
}

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const CODE = 'FIGHT-18'
const DEAD = 'DEAD-18'
const DEADLY = 'DEADLY-18'
const COERCE = 'COERCE-18'

/** @param {number} width @param {number} height @param {(cell: any) => any} [patch] */
function cells(width, height, patch = (cell) => cell) {
  return Array.from({ length: width * height }, (_, index) => patch({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true }))
}

/** @param {string} code @param {{ hp?: number, extra?: object, sceneCells?: object[] }} [options] */
function campaignState(code, { hp = 30, extra = {}, sceneCells = cells(9, 6) } = {}) {
  return {
    sessionCode: code, campaign: 'Встречи', partyName: 'Отряд', partyMemberIds: ['hero', 'hero-2'],
    activePlayerId: 'hero', engine_mode: 'enforce', isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
    players: [
      { id: 'hero', name: 'Аня', character: 'Астер', level: 2, hp, maxHp: 30, armor: 15, speed: 30, proficiency: 2, abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 0, y: 0, online: true },
      { id: 'hero-2', name: 'Второй', character: 'Борей', level: '3', hp: 0, maxHp: 20, armor: 12, speed: 30, abilities: { dex: 10 }, inventory: [], x: 1, y: 0, online: true },
    ],
    enemies: [],
    scene: { title: 'Поле', location: 'Поле битвы', mood: 'Тревожно', objective: 'Выжить', turn: 1, cells: sceneCells },
    adventure: { chapter: 1, history: [], visitedLocations: ['Поле битвы'] },
    mechanics: { positions: { hero: { x: 0, y: 0 }, 'hero-2': { x: 1, y: 0 } } },
    ...extra,
  }
}

// Смертельная встреча: стены и окна у клеток, занятые клетки (живой союзник
// и сущность-враг), павший — не занимает.
const deadlyCells = cells(10, 8, (cell) => ({
  ...cell,
  ...(cell.x === 3 && cell.y < 4 ? { walls: 'e' } : {}),
  ...(cell.y === 4 && cell.x > 5 ? { windows: 's' } : {}),
  ...(cell.x === 8 && cell.y === 1 ? { feature: 'barrel' } : {}),
}))
const deadlyState = campaignState(DEADLY, {
  sceneCells: deadlyCells,
  extra: {
    actors: [{ id: 'ally', name: 'Союзник', hp: 5, x: 2, y: 2 }, { id: 'fallen', name: 'Павший', hp: 0, x: 4, y: 4 }],
    entities: [{ id: 'statue', kind: 'enemy', x: 5, y: 5 }],
    mechanics: { positions: { hero: { x: 0, y: 0 }, 'hero-2': { x: 1, y: 0 }, ally: { x: 2, y: 3 } } },
  },
})

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  const skip = () => Object.assign(exchanges[exchanges.length - 1], { body_norm: '<skip>' })
  const rooms = () => Object.assign(exchanges[exchanges.length - 1], { body_norm: journal(exchanges[exchanges.length - 1].body_norm) })
  const assemble = (body, { code = CODE, role = 'admin', headers } = {}) => send(role, 'POST', `/api/campaigns/${code}/encounters/assemble`, { body, headers })

  // Без входа — 401.
  await assemble({}, { role: 'anon' })

  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } }); skip()
  await send('player', 'POST', '/api/auth/register', { body: PLAYER }); skip()
  for (const [code, state] of [[CODE, campaignState(CODE)], [DEAD, campaignState(DEAD, { hp: 0 })], [DEADLY, deadlyState], [COERCE, campaignState(COERCE)]]) {
    await send('admin', 'POST', '/api/campaigns', { body: { code, name: 'Встречи', state } }); skip()
  }
  const invite = await send('admin', 'POST', `/api/campaigns/${CODE}/invites`, { body: { hero_ids: ['hero'] } }); skip()
  const inviteIndex = exchanges.length - 1
  await send('player', 'POST', `/api/campaigns/${CODE}/join`, { body: { invite_token: invite.body.token } }); skip()
  Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${inviteIndex}>` } })

  // Права, кампания, тело.
  await assemble({ idempotency_key: 'player' }, { role: 'player' })
  await assemble({ idempotency_key: 'nope' }, { code: 'NOPE-18' })
  await assemble([])
  await assemble(42)
  await assemble({ idempotency_key: 'forged', enemies: [{ id: 'forged', hp: 999 }] })
  await assemble({ idempotency_key: 'forged', npc_id: 'boss' })

  // Ключ.
  await assemble({ expected_state_version: 0 })
  await assemble({ expected_state_version: 0, idempotency_key: '   ' })
  await assemble({ expected_state_version: 0, idempotency_key: 'к'.repeat(201) })

  // Версия.
  const room = await send('admin', 'GET', `/api/rooms/${CODE}`); skip()
  const version = room.body.state.state_version
  await assemble({ expected_state_version: 1.5, idempotency_key: 'fraction' })
  await assemble({ expected_state_version: 'x', idempotency_key: 'text' })
  await assemble({ expected_state_version: -1, idempotency_key: 'negative' })
  await assemble({ idempotency_key: 'no-version' })
  await assemble({ expected_state_version: version + 5, difficulty: 'easy', theme: 'beasts', seed: 'stable', idempotency_key: 'stale' })
  // Отказ сборщика (предпросмотр): неизвестная тема и сложность; нестроковые поля.
  await assemble({ expected_state_version: version, theme: 'dragons', idempotency_key: 'bad-theme' })
  await assemble({ expected_state_version: version, difficulty: 'legendary', idempotency_key: 'bad-difficulty' })

  // Сборка, повтор и конфликт ключа.
  const request = { expected_state_version: version, difficulty: 'easy', theme: 'beasts', seed: 'stable-seed', idempotency_key: 'fight-1' }
  await assemble(request)
  await assemble(request)
  await assemble({ ...request, difficulty: 'medium' })
  await assemble({ ...request, theme: 'bandits' })
  await assemble({ ...request, seed: 'other-seed' })
  await assemble({ ...request, expected_state_version: version + 100 })
  await send('admin', 'GET', `/api/rooms/${CODE}`); rooms()

  // Новая встреча во время боя.
  const fighting = await send('admin', 'GET', `/api/rooms/${CODE}`); skip()
  await assemble({ expected_state_version: fighting.body.state.state_version, difficulty: 'easy', idempotency_key: 'fight-2' })

  // Отряд без живых героев: предпросмотр отказывает.
  const dead = await send('admin', 'GET', `/api/rooms/${DEAD}`); skip()
  await assemble({ expected_state_version: dead.body.state.state_version, idempotency_key: 'dead' }, { code: DEAD })

  // Смертельная встреча, зерно по умолчанию, ключ в заголовке.
  const deadly = await send('admin', 'GET', `/api/rooms/${DEADLY}`); skip()
  await assemble({ expected_state_version: deadly.body.state.state_version, difficulty: 'deadly', theme: 'undead' }, { code: DEADLY, headers: { 'x-idempotency-key': 'deadly-key' } })
  await send('admin', 'GET', `/api/rooms/${DEADLY}`); rooms()
  await assemble({ expected_state_version: deadly.body.state.state_version, difficulty: 'deadly', theme: 'undead' }, { code: DEADLY, headers: { 'x-idempotency-key': 'deadly-key' } })

  // Нестроковые поля приводятся строкой: сложность из массива, тема null — по умолчанию, зерно-число.
  const coerce = await send('admin', 'GET', `/api/rooms/${COERCE}`); skip()
  await assemble({ expected_state_version: String(coerce.body.state.state_version), difficulty: ['easy'], theme: null, seed: 12345, idempotency_key: 'coerced' }, { code: COERCE })

  // Лимит: 30 сборок на ведущего (счёт идёт с начала сценария).
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await assemble({ idempotency_key: `rate-${attempt}`, expected_state_version: 'x' })
    if (response.status === 429) break
  }

  for (const entry of /** @type {any[]} */ (exchanges)) {
    if (entry.body_norm !== '<skip>' && entry.method === 'POST') entry.body_norm = reduce(maskNarration(entry.body_norm))
  }
  const file = join(FIXTURES_DIR, 'c18-3.json')
  writeFileSync(file, `${JSON.stringify({
    format: GOLDEN_FORMAT,
    scenario: 'сборка встречи: 401, 403 игроку, кампании нет, тело, ключ, версия, сборка с ходами врагов, повтор и конфликт ключа по отпечатку встречи, встреча во время боя, отряд без живых, смертельная встреча со стенами, окнами и занятостью — предупреждение в летописи, зерно по умолчанию, ключ в заголовке, лимит 30',
    exchanges,
  }, null, 2)}\n`)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
