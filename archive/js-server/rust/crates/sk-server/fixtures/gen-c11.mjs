// Эталон «Г» решений отряда и заданий (С11):
// `node rust/crates/sk-server/fixtures/gen-c11.mjs` пишет `fixtures/c11.json`;
// сверка — `tests/c11_golden.rs`.
//
// Сценарий: отказ от задания и принятие задания (права, повтор по ключу,
// конфликты), голосование с кворумом по присутствию (живые потоки героев),
// гонка повтора (два одинаковых голоса одновременно), истечение голосования,
// общий бросок `1d20` (решение открывается записью в журнал при остановленном
// сервере — так его открыл бы ход ведущего).
//
// Правила сверх общего формата `skazanie.golden/1` (как в `gen-c10.mjs`):
// * токен приглашения — ссылкой `<invite:N>` в теле входа;
// * голосующий-аккаунт `account:<24 hex>` (sha256 кода кампании и id
//   пользователя, id случаен) — `<voter:роль>`, и в строках, и в ключах;
// * большие ветви тела — `<sha256:хеш:длина>` от JSON с ключами по алфавиту;
// * время строк летописи `ЧЧ:ММ` — `<clock>`; id бросков — `<uuid>`;
// * псевдообмены: `STREAM` — открыть живой поток роли (`status` — ответ
//   рукопожатия), `CLOSE` — закрыть все потоки, `SLEEP` — пауза `ms`,
//   `JOURNAL` — коммит `body` в журнал кампании `path` мимо сервера с
//   перезапуском (у Rust — коммит в ядре и сверка запуска), `PARALLEL` — все
//   запросы `body` одновременно (ответы — в `body_norm` массивом).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { appendJournal, readJournal } from '../../../../test/kit/journal.mjs'
import { partyDecisionOpenedEvent } from '../../../../server/party-decision.mjs'
import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ purpose: '^party_decision$', sides: 20, value: 14 }, { value: 3 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const BIG_BODY = 4_000
const CLOCK = /^\d{2}:\d{2}$/u
const VOTER = /account:[0-9a-f]{24}/gu
const CODES = ['PARTY-1', 'PARTY-2', 'PARTY-3', 'PARTY-4']
const EXPIRY_TTL_MS = 1_000

/** Открытие общего броска — тот же вход, что у `tests/c11_golden.rs`. */
export const ROLL_DECISION = {
  id: 'roll-gate-1',
  type: 'roll',
  title: 'Прорваться через ворота?',
  description: 'Один общий бросок решает, успеет ли отряд.',
  difficulty: 12,
  options: [{ id: 'through', label: 'Прорваться' }, { id: 'retreat', label: 'Отступить' }],
}

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
 * Голосующие-аккаунты — по ролям.
 *
 * @param {unknown} value
 * @param {Map<string, string>} voters
 * @returns {unknown}
 */
function voterRefs(value, voters) {
  const swap = (/** @type {string} */ text) => text.replace(VOTER, (match) => voters.get(match) ?? '<voter:?>')
  if (Array.isArray(value)) return value.map((item) => voterRefs(item, voters))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [swap(key), voterRefs(item, voters)]))
  if (typeof value === 'string') return swap(value)
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

/** id бросков (uuid у JS, `roll-N` у Rust) — `<uuid>` уже нормализатором. */
function hero(id, name) {
  return { id, name, character: name, hp: 14, maxHp: 14, armor: 13, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [] }
}

function quest(id, title, status = 'active', visibility = 'party') {
  return { id, title, summary: title, status, visibility, entity_ids: [], objectives: [title], clock: { current: 0, max: 4, label: 'Срок' } }
}

/** Готовое состояние для импорта администратором: двое героев и поручения. */
function importedState(code, policy) {
  return {
    sessionCode: code,
    campaign: 'Совет отряда',
    partyName: 'Двое у ворот',
    partyMemberIds: ['hero-one', 'hero-two'],
    activePlayerId: 'hero-one',
    messages: [],
    players: [hero('hero-one', 'Агата'), hero('hero-two', 'Гелла')],
    scene: { title: 'Старые ворота', location: 'Старые ворота', mood: '', objective: 'Решить, куда идти', turn: 1, cells: [] },
    adventure: { chapter: 1, currentHook: 'Решить, куда идти', visitedLocations: ['Старые ворота'], history: [] },
    mechanics: { combat: { active: false } },
    worldMemory: {
      quests: [
        quest('quest:road', 'Расчистить дорогу'),
        quest('quest:well', 'Очистить колодец'),
        quest('quest:offer', 'Сопроводить обоз', 'offered'),
        quest('quest:secret', 'Тайное поручение', 'active', 'gm_only'),
      ],
    },
    ...(policy ? { partyDecisionPolicy: policy } : {}),
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

const { server, close } = await startGoldenServer({ dice: DICE })
/** @type {Array<{ controller: AbortController }>} */
const streams = []
try {
  const { send, exchanges } = recorder(server)
  /** @type {Map<string, string>} */
  const cookies = new Map()
  /** @type {Map<string, string>} голосующий-аккаунт → `<voter:роль>` */
  const voters = new Map()
  const account = async (role, path, body) => {
    const response = await send(role, 'POST', path, { body })
    cookies.set(role, response.cookie)
    const userId = String(response.body?.user?.id ?? '')
    for (const code of CODES) {
      const digest = createHash('sha256').update(code).update('\0').update(userId).digest('hex').slice(0, 24)
      voters.set(`account:${digest}`, `<voter:${role}>`)
    }
  }
  const invite = async (role, code, body = {}) => {
    const response = await send(role, 'POST', `/api/campaigns/${code}/invites`, { body })
    Object.assign(exchanges[exchanges.length - 1], { raw_token: response.body?.token ?? null })
    return exchanges.length - 1
  }
  const join = async (role, code, index) => {
    const token = /** @type {any} */ (exchanges[index]).raw_token
    await send(role, 'POST', `/api/campaigns/${code}/join`, { body: { invite_token: token } })
    Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${index}>` } })
  }
  const seat = async (code) => {
    await join('owner', code, await invite('admin', code, { hero_ids: ['hero-one'] }))
    await join('guest', code, await invite('admin', code, { hero_ids: ['hero-two'] }))
  }
  const stream = async (role, code) => {
    const controller = new AbortController()
    const path = `/api/campaigns/${code}/stream`
    const response = await fetch(`${server.baseUrl}${path}`, { headers: { Cookie: cookies.get(role) ?? '', Accept: 'text/event-stream' }, signal: controller.signal })
    if (response.body) await response.body.getReader().read()
    streams.push({ controller })
    exchanges.push({ as: role, method: 'STREAM', path, headers: {}, body: null, status: response.status, body_norm: null })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const closeStreams = async () => {
    for (const { controller } of streams.splice(0)) controller.abort()
    exchanges.push({ as: 'admin', method: 'CLOSE', path: '', headers: {}, body: null, status: 0, body_norm: null })
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const sleep = async (ms) => {
    exchanges.push({ as: 'admin', method: 'SLEEP', path: '', headers: {}, body: { ms }, status: 0, body_norm: null })
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
  const parallel = async (role, path, bodies) => {
    const before = exchanges.length
    await Promise.all(bodies.map((body) => send(role, 'POST', path, { body })))
    const done = exchanges.splice(before)
    exchanges.push({ as: role, method: 'PARALLEL', path, headers: {}, body: bodies, status: 0, body_norm: done.map((entry) => ({ status: /** @type {any} */ (entry).status, body_norm: /** @type {any} */ (entry).body_norm })) })
  }

  const quests = (code, action = 'abandon') => `/api/campaigns/${code}/quests/${action}`
  const votes = (code, id) => `/api/campaigns/${code}/party-decisions/${encodeURIComponent(id)}/votes`
  const roll = (code, id) => `/api/campaigns/${code}/party-decisions/${encodeURIComponent(id)}/roll`
  const interactionOf = (response) => String(response.body?.state?.agentInteraction?.id ?? '')

  // Без входа.
  await send('anon', 'POST', quests('PARTY-1'), { body: {} })
  await send('anon', 'POST', votes('PARTY-1', 'x'), { body: {} })
  await send('anon', 'POST', roll('PARTY-1', 'x'), { body: {} })
  // Аккаунты и кампании.
  await account('admin', '/api/auth/setup-admin', { ...ADMIN, setupToken: 'setup-code' })
  await account('owner', '/api/auth/register', OWNER)
  await account('guest', '/api/auth/register', GUEST)
  await account('outsider', '/api/auth/register', OUTSIDER)
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'PARTY-1', name: 'Совет отряда', state: importedState('PARTY-1') } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'PARTY-2', name: 'Короткий срок', state: importedState('PARTY-2', { decisionTtlMs: EXPIRY_TTL_MS }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'PARTY-3', name: 'Общий бросок', state: importedState('PARTY-3') } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'PARTY-4', name: 'Один в сети', state: importedState('PARTY-4') } })
  for (const code of CODES) await seat(code)

  // Общий бросок открывает ход ведущего: коммит мимо сервера, перезапуск.
  await server.stop()
  const head = await readJournal(server, 'PARTY-3')
  const opened = partyDecisionOpenedEvent({ ...ROLL_DECISION, createdAt: Date.now() }, 'hero-one', { eligibleHeroIds: ['hero-one', 'hero-two'], policy: head.state.partyDecisionPolicy })
  await appendJournal(server, 'PARTY-3', { idempotency_key: 'golden-open-roll', events: [opened], expected_state_version: head.state_version })
  // Rust собирает то же событие своим `party_decision_opened_event` из этих данных.
  const journal = { idempotency_key: 'golden-open-roll', interaction: ROLL_DECISION, actor_id: 'hero-one', eligibleHeroIds: ['hero-one', 'hero-two'] }
  exchanges.push({ as: 'admin', method: 'JOURNAL', path: 'PARTY-3', headers: {}, body: journal, status: 0, body_norm: null })
  await server.start()
  await new Promise((resolve) => setTimeout(resolve, 400))

  // Решение по заданию: отказы до коммита.
  await send('outsider', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-out' } })
  await send('guest', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-foreign' } })
  await send('owner', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:road' } })
  await send('owner', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:secret', idempotency_key: 'q-secret' } })
  await send('owner', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:offer', idempotency_key: 'q-offer' } })
  await send('owner', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:nope', idempotency_key: 'q-nope' } })
  await send('owner', 'POST', quests('PARTY-1'), { body: [] })
  await send('owner', 'POST', quests('NOPE-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-missing' } })
  await send('admin', 'POST', quests('NOPE-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-missing' } })
  await send('owner', 'GET', quests('PARTY-1'))
  await send('owner', 'POST', '/api/campaigns/PARTY-1/quests/drop', { body: {} })
  // Отказ от задания: открытие, повтор, другой запрос под тем же ключом.
  const abandon = await send('owner', 'POST', quests('party-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-1' } })
  const first = interactionOf(abandon)
  await send('owner', 'POST', `${quests('PARTY-1')}?from=golden`, { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-1' } })
  await send('owner', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-one', quest_id: 'quest:well', idempotency_key: 'q-1' } })
  await send('owner', 'POST', quests('PARTY-1', 'accept'), { body: { actor_id: 'hero-one', quest_id: 'quest:road', idempotency_key: 'q-1' } })
  await send('guest', 'POST', quests('PARTY-1'), { body: { actor_id: 'hero-two', quest_id: 'quest:well', idempotency_key: 'q-2' } })
  await send('guest', 'POST', quests('PARTY-1', 'accept'), { body: { actor_id: 'hero-two', quest_id: 'quest:offer' }, headers: { 'X-Idempotency-Key': 'q-3' } })

  // Голоса без живых потоков: кворум по `online`.
  await send('outsider', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-one', option_id: 'abandon' } })
  await send('guest', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-one', option_id: 'abandon', idempotency_key: 'v-foreign' } })
  await send('owner', 'POST', votes('PARTY-1', 'stale-decision'), { body: { actor_id: 'hero-one', option_id: 'abandon', idempotency_key: 'v-stale' } })
  await send('owner', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-one', option_id: 'maybe', idempotency_key: 'v-bad-option' } })
  await send('owner', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-one', option_id: 'abandon', idempotency_key: 'q-1' } })
  await send('owner', 'POST', votes('PARTY-1', 'bad id!'), { body: { actor_id: 'hero-one', option_id: 'abandon' } })
  await send('owner', 'POST', roll('PARTY-1', first), { body: { actor_id: 'hero-one', idempotency_key: 'r-on-vote' } })

  // Кворум по присутствию: оба героя в сети живыми потоками.
  await stream('owner', 'PARTY-1')
  await stream('guest', 'PARTY-1')
  await stream('outsider', 'PARTY-1')
  await send('owner', 'GET', '/api/rooms/PARTY-1')
  // Гонка повтора: два одинаковых голоса одновременно — один коммит.
  await parallel('owner', votes('PARTY-1', first), [
    { actor_id: 'hero-one', option_id: 'abandon', idempotency_key: 'v-1' },
    { actor_id: 'hero-one', option_id: 'abandon', idempotency_key: 'v-1' },
  ])
  await send('owner', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-one', option_id: 'keep', idempotency_key: 'v-1' } })
  await send('guest', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-two', option_id: 'abandon', idempotency_key: 'v-1' } })
  await send('owner', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-one', abstain: true, idempotency_key: 'v-1' } })
  await send('guest', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-two', option_id: 'abandon', idempotency_key: 'v-2' } })
  await send('guest', 'POST', votes('PARTY-1', first), { body: { actor_id: 'hero-two', option_id: 'abandon', idempotency_key: 'v-2' } })
  await send('owner', 'GET', '/api/rooms/PARTY-1')
  // Второе решение: один голос и воздержание второго.
  const accept = await send('owner', 'POST', quests('PARTY-1', 'accept'), { body: { actor_id: 'hero-one', quest_id: 'quest:offer', idempotency_key: 'q-4' } })
  const second = interactionOf(accept)
  await send('guest', 'POST', votes('PARTY-1', second), { body: { actor_id: 'hero-two', abstain: true, idempotency_key: 'v-3' } })
  await send('guest', 'POST', votes('PARTY-1', second), { body: { actor_id: 'hero-two', abstain: true, idempotency_key: 'v-3' } })
  await send('guest', 'POST', votes('PARTY-1', second), { body: { actor_id: 'hero-two', option_id: 'accept', idempotency_key: 'v-4' } })
  await send('owner', 'POST', votes('PARTY-1', second), { body: { actor_id: 'hero-one', option_id: 'accept', idempotency_key: 'v-5' } })
  await send('owner', 'GET', '/api/rooms/PARTY-1')
  // Кворум по присутствию: в сети только владелец первого героя.
  await stream('owner', 'PARTY-4')
  const solo = await send('owner', 'POST', quests('PARTY-4'), { body: { actor_id: 'hero-one', quest_id: 'quest:well', idempotency_key: 'q-5' } })
  await send('owner', 'POST', votes('PARTY-4', 'quest-x'), { body: { actor_id: 'hero-one', option_id: 'keep', idempotency_key: 'v-solo-stale' } })
  await send('owner', 'POST', votes('PARTY-4', interactionOf(solo)), { body: { actor_id: 'hero-one', option_id: 'abandon', idempotency_key: 'v-solo' } })
  await send('owner', 'GET', '/api/rooms/PARTY-4')
  await closeStreams()

  // Истечение: срок решения — секунда.
  const short = await send('owner', 'POST', quests('PARTY-2', 'accept'), { body: { actor_id: 'hero-one', quest_id: 'quest:offer', idempotency_key: 'q-6' } })
  await sleep(EXPIRY_TTL_MS + 600)
  await send('guest', 'POST', votes('PARTY-2', interactionOf(short)), { body: { actor_id: 'hero-two', option_id: 'accept', idempotency_key: 'v-6' } })
  await send('owner', 'GET', '/api/rooms/PARTY-2')

  // Общий бросок.
  await send('outsider', 'POST', roll('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-two', idempotency_key: 'r-out' } })
  await send('owner', 'POST', roll('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-two', idempotency_key: 'r-foreign' } })
  await send('guest', 'POST', votes('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-two', option_id: 'through', idempotency_key: 'v-roll' } })
  await send('guest', 'POST', votes('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-two', abstain: true, idempotency_key: 'v-roll-abstain' } })
  await send('guest', 'POST', roll('PARTY-3', 'roll-gate-0'), { body: { actor_id: 'hero-two', idempotency_key: 'r-stale' } })
  await send('guest', 'POST', roll('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-two', idempotency_key: 'r-1', total: 1 } })
  await send('guest', 'POST', roll('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-two', idempotency_key: 'r-1' } })
  await send('admin', 'POST', roll('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-one', idempotency_key: 'r-2' } })
  // Ключ чужого коммита: бросок его не сверяет (как JS) — 200 с тем коммитом.
  await send('admin', 'POST', roll('PARTY-3', ROLL_DECISION.id), { body: { actor_id: 'hero-one', idempotency_key: 'golden-open-roll' } })
  await send('owner', 'GET', '/api/rooms/PARTY-3')

  // `C11_DUMP=<файл>` — тела обычных обменов целиком (ключи по алфавиту) для разбора расхождения хешей.
  if (process.env.C11_DUMP) {
    const plain = exchanges.filter((entry) => !['STREAM', 'CLOSE', 'SLEEP', 'JOURNAL', 'PARALLEL'].includes(/** @type {any} */ (entry).method))
    writeFileSync(process.env.C11_DUMP, JSON.stringify(plain.map((entry) => sorted(clock(voterRefs(/** @type {any} */ (entry).body_norm, voters)))), null, 2))
  }
  for (const entry of /** @type {any[]} */ (exchanges)) {
    const tidy = (/** @type {unknown} */ value) => shrink(clock(voterRefs(value, voters)))
    entry.body_norm = entry.method === 'PARALLEL'
      ? entry.body_norm.map((/** @type {any} */ item) => ({ status: item.status, body_norm: tidy(item.body_norm) }))
      : tidy(entry.body_norm)
    delete entry.raw_token
  }
  const file = writeGolden('c11', 'решения отряда и задания: отказ и принятие задания, голоса с кворумом по присутствию, гонка повтора, истечение, общий бросок', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  for (const { controller } of streams) controller.abort()
  await close()
}
