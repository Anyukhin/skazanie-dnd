// Эталон «Г» рассказа хода (С18.5): `node rust/crates/sk-server/fixtures/gen-c18-5.mjs`
// пишет `fixtures/c18-5.json`; сверка — `tests/c18_5_golden.rs`.
//
// Сценарий `POST /api/narrate` без модели: отказы до хода (сырой url, тело,
// вид реплики, legacy payload, roll, доступ, герой, собеседник, решение
// группы), свободная реплика и её повтор по ключу, приватный вопрос,
// обсуждение, бросок с карточкой (карточка → `/api/roll` → ход, повторное
// использование кости), конфликт версии (обстановка сменилась между
// карточкой и броском), голосование об уходе и переход сцены Режиссёра с
// повтором и конфликтами ключа, соло-выход, живой поток рассказа второго
// игрока и итоговая комната обоих игроков.
//
// Правила сверх общего формата `skazanie.golden/1`:
// * `pick` обмена — список путей тела (`a.b`, `list[].field`), которые
//   сверяются; тело без `pick` сверяется целиком. Путь без значения в
//   эталон не попадает;
// * `<ref:N:путь>` в пути и строках тела — значение из ответа обмена N
//   (id карточки, броска, решения), подставляется перед отправкой;
// * токен приглашения — `<invite:N>` (как в `gen-c11.mjs`);
// * имя торговца в тексте (`<имя> раскладывает товар`) — `<merchant>`: лавку
//   двух игроков сеет id решения, а он — случайный uuid карточки;
// * псевдообмены: `STREAM` — открыть живой поток роли (`path`), `EVENTS` —
//   кадры `narration.*`, пришедшие роли с прошлого `EVENTS` (`body_norm` —
//   `[{ event, payload }]`).
import '../../../fixtures-env.mjs'

import { recorder, normalize, startGoldenServer, writeGolden } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ sides: 6, value: 4 }, { value: 12 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }

/** Поля ответа хода, которые сверяются. */
export const NARRATE_PICK = [
  'error', 'code', 'request_kind', 'narration', 'provider', 'model', 'narration_message_id', 'turn_consumed', 'action_kind',
  'free_action_outcome', 'idempotent_replay', 'room_version', 'state_version', 'engine_mode',
  'check.skill', 'check.ability', 'check.difficulty', 'check.modifier', 'check.label',
  'effects.roll', 'effects.interaction.type', 'effects.interaction.title', 'effects.interaction.description', 'effects.interaction.options', 'effects.interaction.status',
  'effects.scene.scene.location', 'effects.scene.adventure.chapter',
  // `merchant_id` выводится из id решения (случайный uuid карточки) — не сверяется.
  'director_transition.fingerprint', 'director_transition.shop_action', 'director_transition.shop_outcome', 'director_transition.abandoned_quest_id', 'director_transition.replayed',
  'mechanics[].event_type', 'agent_trace[].agent',
]
/** Поля комнаты, которые сверяются. */
export const ROOM_PICK = [
  'version', 'state.state_version', 'state.scene.location', 'state.agentInteraction',
  'state.messages[].id', 'state.messages[].speaker', 'state.messages[].author', 'state.messages[].text', 'state.messages[].knowledge_gate',
]

function hero(id, name) {
  return { id, name, character: name, hp: 14, maxHp: 14, armor: 13, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], online: true }
}

function campaignState(code, players, location) {
  return {
    sessionCode: code,
    campaign: 'Рассказ хода',
    partyName: 'Отряд у ворот',
    partyMemberIds: players.map((player) => player.id),
    activePlayerId: players[0].id,
    isNarrating: false,
    pendingCheck: null,
    agentInteraction: null,
    suggestions: [],
    messages: [],
    players,
    enemies: [],
    scene: { title: location, location, mood: '', objective: 'Решить, куда идти', turn: 1, cells: [] },
    adventure: { chapter: 1, currentHook: 'Решить, куда идти', visitedLocations: [location], history: [] },
    mechanics: { combat: { active: false }, world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
  }
}

/**
 * Значение по пути `a.b` / `list[].field`; `undefined` — нет значения.
 *
 * @param {unknown} value
 * @param {string[]} parts
 * @returns {unknown}
 */
function at(value, parts) {
  if (!parts.length) return value
  const [head, ...rest] = parts
  if (head.endsWith('[]')) {
    const list = /** @type {any} */ (value)?.[head.slice(0, -2)]
    return Array.isArray(list) ? list.map((item) => at(item, rest) ?? null) : undefined
  }
  if (Array.isArray(value)) return /^\d+$/u.test(head) ? at(value[Number(head)], rest) : undefined
  if (value === null || typeof value !== 'object') return undefined
  return at(/** @type {any} */ (value)[head], rest)
}

const MERCHANT = /(^|\n\n)[^\n.]*? раскладывает товар/gu

/**
 * Имя торговца в тексте — `<merchant>` (см. шапку).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function merchants(value) {
  if (typeof value === 'string') return value.replace(MERCHANT, '$1<merchant> раскладывает товар')
  if (Array.isArray(value)) return value.map(merchants)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, merchants(item)]))
  return value
}

/**
 * Выборка полей тела по путям.
 *
 * @param {unknown} body
 * @param {string[]} paths
 */
export function pick(body, paths) {
  /** @type {Record<string, unknown>} */
  const view = {}
  for (const path of paths) {
    const value = at(body, path.split('.'))
    if (value !== undefined) view[path] = value
  }
  return view
}

const { server, close } = await startGoldenServer({ dice: DICE })
/** @type {Array<{ controller: AbortController }>} */
const streams = []
try {
  const { send, exchanges } = recorder(server)
  /** @type {unknown[]} сырые ответы по индексу обмена */
  const raw = []
  /** @type {Map<string, string>} */
  const cookies = new Map()
  /** @type {Map<string, { buffer: string, events: Array<{ event: string, payload: unknown }> }>} */
  const feeds = new Map()
  const resolve = (/** @type {string} */ text) => text.replace(/<ref:(\d+):([^>]+)>/gu, (_, index, path) => String(at(raw[Number(index)], path.split('.')) ?? ''))
  const resolveBody = (/** @type {unknown} */ value) => {
    if (typeof value === 'string') return resolve(value)
    if (Array.isArray(value)) return value.map(resolveBody)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBody(item)]))
    return value
  }
  /**
   * Обмен с подстановкой ссылок и выборкой полей.
   *
   * @param {string} role
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, picked?: string[] }} [options]
   */
  const call = async (role, method, path, { body, picked } = {}) => {
    const response = await send(role, method, resolve(path), { body: body === undefined ? undefined : resolveBody(body) })
    const entry = /** @type {any} */ (exchanges[exchanges.length - 1])
    entry.path = path
    entry.body = body ?? null
    if (picked) {
      entry.pick = picked
      entry.body_norm = normalize(pick(response.body, picked))
    }
    raw[exchanges.length - 1] = response.body
    return { index: exchanges.length - 1, response }
  }
  const narrate = (role, body) => call(role, 'POST', '/api/narrate', { body, picked: NARRATE_PICK })
  const account = async (role, path, body) => {
    const { response } = await call(role, 'POST', path, { body })
    cookies.set(role, response.cookie)
  }
  const invite = async (code, heroId) => {
    const { index } = await call('admin', 'POST', `/api/campaigns/${code}/invites`, { body: { hero_ids: [heroId] } })
    return index
  }
  const join = async (role, code, index) => {
    const token = /** @type {any} */ (raw[index])?.token
    await call(role, 'POST', `/api/campaigns/${code}/join`, { body: { invite_token: token } })
    Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${index}>` } })
  }
  const stream = async (role, code) => {
    const controller = new AbortController()
    const path = `/api/campaigns/${code}/stream`
    const response = await fetch(`${server.baseUrl}${path}`, { headers: { Cookie: cookies.get(role) ?? '', Accept: 'text/event-stream' }, signal: controller.signal })
    const feed = { buffer: '', events: /** @type {Array<{ event: string, payload: unknown }>} */ ([]) }
    feeds.set(role, feed)
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader?.read()
          if (!chunk || chunk.done) return
          feed.buffer += decoder.decode(chunk.value, { stream: true })
          const blocks = feed.buffer.split(/\r?\n\r?\n/u)
          feed.buffer = blocks.pop() ?? ''
          for (const block of blocks) {
            const event = /^event: ([^\r\n]+)$/mu.exec(block)?.[1] ?? ''
            const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
            if (event.startsWith('narration.') && data) feed.events.push({ event, payload: JSON.parse(data) })
          }
        }
      } catch { /* поток закрыт */ }
    })()
    streams.push({ controller })
    exchanges.push({ as: role, method: 'STREAM', path, headers: {}, body: null, status: response.status, body_norm: null })
    await new Promise((done) => setTimeout(done, 150))
  }
  const events = async (role) => {
    await new Promise((done) => setTimeout(done, 300))
    const feed = feeds.get(role)
    const seen = feed ? feed.events.splice(0) : []
    exchanges.push({ as: role, method: 'EVENTS', path: '', headers: {}, body: null, status: 0, body_norm: normalize(seen) })
  }

  // Без входа, сырой адрес, неверный метод.
  await call('anon', 'POST', '/api/narrate', { body: { campaignId: 'NARR-1', action: 'Иду' } })
  await account('admin', '/api/auth/setup-admin', { ...ADMIN, setupToken: 'setup-code' })
  await account('owner', '/api/auth/register', OWNER)
  await account('guest', '/api/auth/register', GUEST)
  await account('outsider', '/api/auth/register', OUTSIDER)
  await call('owner', 'GET', '/api/narrate')
  await call('owner', 'POST', '/api/narrate?x=1', { body: { campaignId: 'NARR-1', action: 'Иду' } })
  // Кампании: двое у ворот и соло-стол.
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'NARR-1', name: 'Рассказ хода', state: campaignState('NARR-1', [hero('hero-one', 'Агата'), hero('hero-two', 'Гелла')], 'Старые ворота') } })
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'NARR-2', name: 'Соло', state: campaignState('NARR-2', [hero('lira', 'Лира')], 'Нижний зал') } })
  await join('owner', 'NARR-1', await invite('NARR-1', 'hero-one'))
  await join('guest', 'NARR-1', await invite('NARR-1', 'hero-two'))

  // Отказы до хода.
  await call('owner', 'POST', '/api/narrate', { body: [] })
  await narrate('owner', { campaignId: 'NARR-1', action: 'Иду', request_kind: 'chat' })
  await narrate('owner', { campaignId: 'NARR-1', action: 'Что там?', request_kind: 'question', roll: { roll_id: 'x' } })
  await narrate('owner', { campaignId: 'NARR-1', action: 'Иду', state: {} })
  await narrate('owner', { campaignId: 'NARR-1', action: 'Иду', engineMode: 'trust' })
  await narrate('owner', { campaignId: 'NARR-1', action: 'Иду', roll: { roll_id: 'x', total: 20 } })
  await narrate('owner', { campaignId: 'NARR-1', action: 'Иду', roll: 5 })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Иду', roll: {} })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Иду', roll: { roll_id: 'nope' }, idempotency_key: 'r-nope' })
  await narrate('outsider', { campaignId: 'NARR-1', action: 'Иду' })
  await narrate('outsider', { campaignId: 'NOPE-1', action: 'Иду' })
  await narrate('admin', { campaignId: 'NOPE-1', action: 'Иду' })
  await narrate('guest', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Иду' })
  await narrate('owner', { campaign_id: 'NARR-1', actor_id: 'hero-one', action: 'Говорю', npc_id: 'bad id' })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Говорю', npc_id: 7 })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Говорю', npc_id: 'ghost' })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: '[РЕШЕНИЕ ГРУППЫ] Уйти', idempotency_key: 'pd-none' })

  // Живой поток обоих игроков.
  await stream('owner', 'NARR-1')
  await stream('guest', 'NARR-1')

  // Свободная реплика без модели и её повтор по ключу.
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Осматриваю старые ворота', idempotency_key: 'n-1' })
  await events('guest')
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Осматриваю старые ворота', idempotency_key: 'n-1' })
  await events('guest')
  // Вопрос — приватный ответ мимо общего потока; обсуждение вне своего хода.
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Что мы знаем о воротах?', request_kind: 'question', idempotency_key: 'q-1' })
  await events('guest')
  await narrate('guest', { campaignId: 'NARR-1', actor_id: 'hero-two', action: 'Может, обойдём стороной?', request_kind: 'discussion', idempotency_key: 'd-1' })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: '/why', idempotency_key: 'why-1' })

  // Конфликт версии: между карточкой и броском обстановка сменилась; бросок
  // несостоявшегося хода снова свободен.
  const stale = await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Балансирую на узкой опоре', manual_roll: true, idempotency_key: 's-4' })
  const staleRoll = await call('owner', 'POST', '/api/roll', { body: { campaignId: 'NARR-1', playerId: 'hero-one', checkId: `<ref:${stale.index}:check.check_id>` }, picked: ['value', 'total', 'difficulty', 'success'] })
  await call('admin', 'POST', '/api/rooms/NARR-1/dice', { body: { playerId: 'hero-one', sides: 6, idempotency_key: 'die-1' }, picked: ['version', 'roll.value', 'roll.sides'] })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Балансирую на узкой опоре', roll: { roll_id: `<ref:${staleRoll.index}:roll_id>` }, idempotency_key: 's-5' })

  // Бросок с карточкой: карточка, кость своей карточки, ход, повторная кость.
  const offer = await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Балансирую на узкой опоре', manual_roll: true, idempotency_key: 's-1' })
  const rolled = await call('owner', 'POST', '/api/roll', { body: { campaignId: 'NARR-1', playerId: 'hero-one', checkId: `<ref:${offer.index}:check.check_id>` }, picked: ['roll_id', 'value', 'total', 'difficulty', 'success'] })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Балансирую на узкой опоре', roll: { roll_id: `<ref:${rolled.index}:roll_id>` }, idempotency_key: 's-2' })
  await events('guest')
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Балансирую на узкой опоре', roll: { roll_id: `<ref:${rolled.index}:roll_id>` }, idempotency_key: 's-2' })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Балансирую на узкой опоре', roll: { roll_id: `<ref:${rolled.index}:roll_id>` }, idempotency_key: 's-3' })
  await narrate('guest', { campaignId: 'NARR-1', actor_id: 'hero-two', action: 'Балансирую на узкой опоре', roll: { roll_id: `<ref:${rolled.index}:roll_id>` }, idempotency_key: 's-foreign' })

  // Голосование об уходе и переход сцены Режиссёра.
  const proposal = await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: 'Предлагаю покинуть локацию «Старые ворота»', idempotency_key: 't-1' })
  const votes = `/api/campaigns/NARR-1/party-decisions/<ref:${proposal.index}:effects.interaction.id>/votes`
  await call('owner', 'POST', votes, { body: { actor_id: 'hero-one', option_id: 'option-1', idempotency_key: 'v-1' }, picked: ['version', 'state.agentInteraction.status', 'state.agentInteraction.resolvedOptionId'] })
  await call('guest', 'POST', votes, { body: { actor_id: 'hero-two', option_id: 'option-1', idempotency_key: 'v-2' }, picked: ['version', 'state.agentInteraction.status', 'state.agentInteraction.resolvedOptionId'] })
  const leave = `[РЕШЕНИЕ ГРУППЫ] <ref:${proposal.index}:effects.interaction.options.0.label>`
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: leave, idempotency_key: 't-2' })
  await events('guest')
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: leave, idempotency_key: 't-2' })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: '[РЕШЕНИЕ ГРУППЫ] Остаться у ворот', idempotency_key: 't-2' })
  await narrate('owner', { campaignId: 'NARR-1', actor_id: 'hero-one', action: leave, idempotency_key: 't-3' })

  // Соло-стол уходит без карточки, повтор — тот же переход.
  await narrate('admin', { campaignId: 'NARR-2', action: 'Предлагаю покинуть локацию «Нижний зал»', idempotency_key: 'solo-1' })
  await narrate('admin', { campaignId: 'NARR-2', action: 'Предлагаю покинуть локацию «Нижний зал»', idempotency_key: 'solo-1' })

  // Итог: летопись обоих игроков (приватный ответ видит только спросивший).
  await call('owner', 'GET', '/api/rooms/NARR-1', { picked: ROOM_PICK })
  await call('guest', 'GET', '/api/rooms/NARR-1', { picked: ROOM_PICK })
  await call('admin', 'GET', '/api/rooms/NARR-2', { picked: ROOM_PICK })

  for (const entry of /** @type {any[]} */ (exchanges)) entry.body_norm = merchants(entry.body_norm)
  const file = writeGolden('c18-5', 'рассказ хода без модели: отказы до хода, свободная реплика и повтор, вопрос и обсуждение, бросок с карточкой, конфликт версии, голосование и переход сцены, соло-выход, живой поток рассказа', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  for (const { controller } of streams) controller.abort()
  await close()
}
