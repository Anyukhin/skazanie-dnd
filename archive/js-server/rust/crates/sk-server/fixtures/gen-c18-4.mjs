// Эталон «Г» автономии кампании (С18.4): `node rust/crates/sk-server/fixtures/gen-c18-4.mjs`
// пишет `fixtures/c18-4.json`; сверка — `tests/c18_4_golden.rs`.
//
// Сценарий без модели:
// * `autonomy/intents`: права (401, 403 игроку), нет кампании, неверный метод,
//   отказ намерения (400 `DIRECTOR_INTENT_NOT_ALLOWED`, 400
//   `DIRECTOR_MECHANICS_FORBIDDEN`, 409 прочее), намерение Режиссёра и его
//   повтор по ключу; смертельная встреча с `run_combat: true` — строка «Оценка
//   угрозы», автобой (`${key}:combat`) и завершение (`${key}:completion`);
// * `autonomy/advance`: права, чужой герой, ключ, тело не объект, неверный и
//   неизвестный `interaction_id`, шаг Режиссёра с его строкой в летописи и
//   повтор ключа (`duplicate`), переход сцены с голосованием отряда: открытое
//   решение, принятое решение без `interaction_id`, продолжение по
//   `interaction_id` и его повтор, конфликт ключа (другие слова под тем же
//   ключом — повтор, а не новый шаг); пауза кампании; активный бой; закрытая
//   встреча завершается стадией `encounter-completion` координатора
//   последствий (награда в ответе), повтор стадии не платит дважды;
// * итоговые комнаты (летопись).
//
// Правила сверх общего формата `skazanie.golden/1` — как у `gen-c18-5.mjs`:
// * `pick` обмена — список путей тела, которые сверяются;
// * `<ref:N:путь>` в пути и строках тела — значение из ответа обмена N;
// * токен приглашения — `<invite:N>`;
// * тела без `pick` сверяются целиком; `<skip>` — только статус;
// * начало строки конца боя (`Бой стихает: …`, `Всё кончено: …`,
//   `Столкновение завершено: …`) — `<encounter-end>: …`: вариант фразы
//   выбирается по случайному `event_id` (`encounterEndPhrase`).
import '../../../fixtures-env.mjs'

import { normalize, recorder, startGoldenServer, writeGolden } from './golden.mjs'

/**
 * Значение по пути `a.b` / `list[].field`; `undefined` — нет значения (как в
 * `gen-c18-5.mjs`: тот модуль — сценарий, его не импортировать).
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

/**
 * Выборка полей тела по путям.
 *
 * @param {unknown} body
 * @param {string[]} paths
 */
function pick(body, paths) {
  /** @type {Record<string, unknown>} */
  const view = {}
  for (const path of paths) {
    const value = at(body, path.split('.'))
    if (value !== undefined) view[path] = value
  }
  return view
}

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ sides: 6, value: 4 }, { value: 12 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }

/** Поля ответа автономии, которые сверяются. */
export const STEP_PICK = [
  'error', 'code', 'duplicate', 'intent', 'director_trace', 'reward', 'state_version', 'admin_commands',
  'state.state_version', 'state.agentInteraction.type', 'state.agentInteraction.status', 'state.agentInteraction.title',
  'state.agentInteraction.options', 'state.agentInteraction.resolvedOptionId',
  'state.adventure.chapter', 'state.scene.location', 'state.scene.objective',
  'state.mechanics.combat.active', 'state.mechanics.encounter.status', 'state.mechanics.encounter.outcome', 'state.mechanics.encounter.difficulty',
  'state.players[].id', 'state.players[].hp', 'state.enemies[].id', 'state.enemies[].hp',
]
/** Поля комнаты, которые сверяются. */
export const ROOM_PICK = [
  'version', 'state.state_version', 'state.agentInteraction',
  'state.messages[].id', 'state.messages[].speaker', 'state.messages[].author', 'state.messages[].text',
]

function hero(id, name, extra = {}) {
  return { id, name, character: name, className: 'fighter', hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], online: true, ...extra }
}

/** Фаза темпа, где Режиссёру доступна встреча. */
/** Герой с высокой ловкостью: ходит первым, автоход врага ждёт его хода. */
const QUICK = { hp: 60, maxHp: 60, abilities: { str: 16, dex: 20, con: 14, int: 10, wis: 10, cha: 10 } }

/** Крепкий герой автобоя: отряд выигрывает бой без спасбросков от смерти. */
const STURDY = { hp: 200, maxHp: 200, armor: 22, abilities: { str: 20, dex: 14, con: 18, int: 10, wis: 10, cha: 10 } }

const ESCALATION = { autonomy: { pacing: { phase: 'escalation', tension: 60 } } }

/** Открытое поле 16×16: встрече есть где встать. */
const GRID = Array.from({ length: 256 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))

function campaignState(code, players, location, extra = {}) {
  return {
    sessionCode: code,
    campaign: 'Автономия',
    partyName: 'Отряд у ворот',
    partyMemberIds: players.map((player) => player.id),
    activePlayerId: players[0].id,
    isNarrating: false,
    pendingCheck: null,
    agentInteraction: null,
    suggestions: [],
    messages: [],
    players: players.map((player, index) => ({ x: 3 + index, y: 3, ...player })),
    enemies: [],
    scene: { title: location, location, mood: '', objective: 'Решить, куда идти', turn: 1, cells: GRID },
    adventure: { chapter: 1, currentHook: 'Решить, куда идти', visitedLocations: [location], history: [] },
    mechanics: { combat: { active: false }, world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    state_version: 0,
    ...extra,
  }
}


const ENCOUNTER_END = /^(?:Столкновение завершено|Бой стихает|Всё кончено): /u

/**
 * Вариант фразы конца боя — `<encounter-end>` (см. шапку).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function encounterEnd(value) {
  if (typeof value === 'string') return value.replace(ENCOUNTER_END, '<encounter-end>: ')
  if (Array.isArray(value)) return value.map(encounterEnd)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encounterEnd(item)]))
  return value
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  /** @type {unknown[]} сырые ответы по индексу обмена */
  const raw = []
  const resolve = (/** @type {string} */ text) => text.replace(/<ref:(\d+):([^>]+)>/gu, (_, index, path) => String(at(raw[Number(index)], path.split('.')) ?? ''))
  const resolveBody = (/** @type {unknown} */ value) => {
    if (typeof value === 'string') return resolve(value)
    if (Array.isArray(value)) return value.map(resolveBody)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBody(item)]))
    return value
  }
  /**
   * @param {string} role
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, picked?: string[], skip?: boolean }} [options]
   */
  const call = async (role, method, path, { body, picked, skip } = {}) => {
    const response = await send(role, method, resolve(path), { body: body === undefined ? undefined : resolveBody(body) })
    const entry = /** @type {any} */ (exchanges[exchanges.length - 1])
    entry.path = path
    entry.body = body ?? null
    if (picked) {
      entry.pick = picked
      entry.body_norm = normalize(pick(response.body, picked))
    }
    if (skip) entry.body_norm = '<skip>'
    raw[exchanges.length - 1] = response.body
    return { index: exchanges.length - 1, response }
  }
  const intents = (role, code, body) => call(role, 'POST', `/api/campaigns/${code}/autonomy/intents`, { body, picked: STEP_PICK })
  const advance = (role, code, body) => call(role, 'POST', `/api/campaigns/${code}/autonomy/advance`, { body, picked: STEP_PICK })
  const room = (role, code) => call(role, 'GET', `/api/rooms/${code}`, { picked: ROOM_PICK })
  const invite = async (code, heroId) => (await call('admin', 'POST', `/api/campaigns/${code}/invites`, { body: { hero_ids: [heroId] }, skip: true })).index
  const join = async (role, code, index) => {
    const token = /** @type {any} */ (raw[index])?.token
    await call(role, 'POST', `/api/campaigns/${code}/join`, { body: { invite_token: token }, skip: true })
    Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${index}>` } })
  }

  // Без входа.
  await call('anon', 'POST', '/api/campaigns/AUTO-1/autonomy/intents', { body: {} })
  await call('anon', 'POST', '/api/campaigns/AUTO-1/autonomy/advance', { body: {} })
  await call('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' }, skip: true })
  await call('owner', 'POST', '/api/auth/register', { body: OWNER, skip: true })
  await call('guest', 'POST', '/api/auth/register', { body: GUEST, skip: true })
  await call('outsider', 'POST', '/api/auth/register', { body: OUTSIDER, skip: true })

  // Кампании: двое у ворот, стол ведущего, закрытая встреча.
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'AUTO-1', name: 'Автономия', state: campaignState('AUTO-1', [hero('hero-one', 'Агата'), hero('hero-two', 'Гелла')], 'Старые ворота') }, skip: true })
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'AUTO-2', name: 'Бой ведущего', state: campaignState('AUTO-2', [hero('lira', 'Лира', QUICK), hero('tor', 'Тор', QUICK)], 'Нижний зал', ESCALATION) }, skip: true })
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'AUTO-6', name: 'Автобой', state: campaignState('AUTO-6', [hero('yan', 'Ян', STURDY), hero('ilma', 'Ильма', STURDY)], 'Курган', ESCALATION) }, skip: true })
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'AUTO-3', name: 'Пауза', state: campaignState('AUTO-3', [hero('nika', 'Ника')], 'Мост', ESCALATION) }, skip: true })
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'AUTO-4', name: 'Тропа', state: campaignState('AUTO-4', [hero('mira', 'Мира', QUICK)], 'Лесная тропа', ESCALATION) }, skip: true })
  await call('admin', 'POST', '/api/campaigns', { body: { code: 'AUTO-5', name: 'Зацепка', state: campaignState('AUTO-5', [hero('oleg', 'Олег')], 'Перекрёсток') }, skip: true })
  await join('owner', 'AUTO-1', await invite('AUTO-1', 'hero-one'))
  await join('guest', 'AUTO-1', await invite('AUTO-1', 'hero-two'))

  // autonomy/intents: права и отказы.
  await intents('owner', 'AUTO-1', { intent: { type: 'continue_exploration' } })
  await intents('admin', 'NOPE-1', { intent: { type: 'continue_exploration' } })
  await call('admin', 'GET', '/api/campaigns/AUTO-2/autonomy/intents')
  await intents('admin', 'AUTO-2', { intent: { type: 'teleport' }, idempotency_key: 'i-bad' })
  await intents('admin', 'AUTO-2', { intent: { type: 'continue_exploration', damage: 5 }, idempotency_key: 'i-mech' })
  await intents('admin', 'AUTO-2', { intent: { type: 'continue_exploration', extra: 1 }, idempotency_key: 'i-extra' })
  await intents('admin', 'AUTO-2', { intent: 'просто строка', idempotency_key: 'i-string' })
  await call('admin', 'POST', '/api/campaigns/AUTO-2/autonomy/intents', { body: [], picked: STEP_PICK })
  // Смертельная встреча: строка «Оценка угрозы» (герои ходят первыми —
  // автоход врага комнату не меняет).
  await intents('admin', 'AUTO-2', { intent: { type: 'request_encounter', theme: 'beasts', difficulty: 'deadly' }, idempotency_key: 'i-deadly' })
  await room('admin', 'AUTO-2')
  // Автобой и завершение встречи (`run_combat: true`) и повтор ключа.
  await intents('admin', 'AUTO-6', { intent: { type: 'request_encounter', theme: 'beasts', difficulty: 'medium' }, idempotency_key: 'i-fight', run_combat: true })
  await room('admin', 'AUTO-6')
  await intents('admin', 'AUTO-6', { intent: { type: 'request_encounter', theme: 'beasts', difficulty: 'medium' }, idempotency_key: 'i-fight', run_combat: true })
  // Намерение и его повтор по ключу (ключ — из idempotencyKey и заголовка).
  await intents('admin', 'AUTO-5', { intent: { type: 'offer_next_hook', hook: 'Найти пропавший обоз' }, idempotency_key: 'i-hook' })
  await intents('admin', 'AUTO-5', { intent: { type: 'offer_next_hook', hook: 'Найти пропавший обоз' }, idempotencyKey: 'i-hook' })
  await intents('admin', 'AUTO-5', { intent: { type: 'continue_exploration' }, idempotency_key: 'i-hook' })

  // autonomy/advance: права и отказы до шага.
  await advance('outsider', 'AUTO-1', { idempotency_key: 'a-x', player_action: 'продолжим' })
  await advance('owner', 'NOPE-1', { idempotency_key: 'a-x', player_action: 'продолжим' })
  await call('owner', 'GET', '/api/campaigns/AUTO-1/autonomy/advance')
  await advance('guest', 'AUTO-1', { idempotency_key: 'a-x', actor_id: 'hero-one', player_action: 'продолжим' })
  await advance('owner', 'AUTO-1', { actor_id: 'hero-one', player_action: 'продолжим' })
  await call('owner', 'POST', '/api/campaigns/AUTO-1/autonomy/advance', { body: [], picked: STEP_PICK })
  await advance('owner', 'AUTO-1', { interaction_id: 'bad id', actor_id: 'hero-one' })
  await advance('owner', 'AUTO-1', { interaction_id: 'ghost-1', actor_id: 'hero-one' })

  // Шаг Режиссёра и повтор ключа.
  await advance('owner', 'AUTO-1', { idempotency_key: 'a-1', actor_id: 'hero-one', player_action: 'продолжим' })
  await advance('owner', 'AUTO-1', { idempotency_key: 'a-1', actor_id: 'hero-one', player_action: 'другая формулировка' })
  await advance('guest', 'AUTO-1', { idempotency_key: 'a-1', actor_id: 'hero-two', player_action: 'продолжим' })

  // Переход сцены через голосование отряда.
  const transition = await advance('owner', 'AUTO-1', { idempotency_key: 'a-2', actor_id: 'hero-one', player_action: 'Перейти дальше' })
  await advance('owner', 'AUTO-1', { idempotency_key: 'a-3', actor_id: 'hero-one', player_action: 'продолжим' })
  const votes = `/api/campaigns/AUTO-1/party-decisions/<ref:${transition.index}:state.agentInteraction.id>/votes`
  await call('owner', 'POST', votes, { body: { actor_id: 'hero-one', option_id: 'continue', idempotency_key: 'v-1' }, picked: ['version', 'state.agentInteraction.status', 'state.agentInteraction.resolvedOptionId'] })
  await call('guest', 'POST', votes, { body: { actor_id: 'hero-two', option_id: 'continue', idempotency_key: 'v-2' }, picked: ['version', 'state.agentInteraction.status', 'state.agentInteraction.resolvedOptionId'] })
  await advance('owner', 'AUTO-1', { idempotency_key: 'a-4', actor_id: 'hero-one', player_action: 'продолжим' })
  await advance('owner', 'AUTO-1', { interaction_id: `<ref:${transition.index}:state.agentInteraction.id>`, idempotency_key: 'a-ignored', actor_id: 'hero-one', player_action: 'Продолжить переход' })
  await advance('owner', 'AUTO-1', { interaction_id: `<ref:${transition.index}:state.agentInteraction.id>`, actor_id: 'hero-one', player_action: 'Повтор после reconnect' })
  await advance('owner', 'AUTO-1', { idempotency_key: 'a-2', actor_id: 'hero-one', player_action: 'Перейти дальше' })
  await advance('owner', 'AUTO-1', { idempotency_key: 'a-5', actor_id: 'hero-one', player_action: 'продолжим' })

  // Пауза кампании.
  await call('admin', 'POST', '/api/campaigns/AUTO-3/lifecycle', { body: { action: 'pause', idempotency_key: 'pause-1' }, skip: true })
  await advance('admin', 'AUTO-3', { idempotency_key: 'p-1', player_action: 'продолжим' })
  await intents('admin', 'AUTO-3', { intent: { type: 'continue_exploration' }, idempotency_key: 'p-2' })

  // Активный бой: встреча без автобоя.
  await call('admin', 'POST', '/api/campaigns/AUTO-3/lifecycle', { body: { action: 'resume', idempotency_key: 'resume-1' }, skip: true })
  await intents('admin', 'AUTO-3', { intent: { type: 'request_encounter', theme: 'beasts', difficulty: 'easy' }, idempotency_key: 'c-1' })
  await advance('admin', 'AUTO-3', { idempotency_key: 'c-2', player_action: 'продолжим' })

  // Закрытая встреча: отряд отступил (бой закрыт командой ведущего; герой
  // ходит первым — автоход врага не вклинивается), завершение — стадия координатора
  // последствий; повтор стадии не платит дважды.
  await intents('admin', 'AUTO-4', { intent: { type: 'request_encounter', theme: 'beasts', difficulty: 'easy' }, idempotency_key: 'e-0' })
  await call('admin', 'POST', '/api/campaigns/AUTO-4/commands', { body: { idempotency_key: 'e-end', command: { command_type: 'EndCombat', actor_id: 'mira', reason: 'party_retreated' } }, picked: ['error', 'code', 'state_version'] })
  await advance('admin', 'AUTO-4', { idempotency_key: 'e-1', player_action: 'продолжим' })
  await advance('admin', 'AUTO-4', { idempotency_key: 'e-2', player_action: 'продолжим' })

  // Итог: летопись.
  await room('owner', 'AUTO-1')
  await room('admin', 'AUTO-4')
  await room('admin', 'AUTO-5')

  for (const entry of /** @type {any[]} */ (exchanges)) entry.body_norm = encounterEnd(entry.body_norm)
  const file = writeGolden('c18-4', 'автономия кампании без модели: права и отказы intents и advance, намерение и повтор, смертельная встреча с автобоем и завершением, шаг Режиссёра и повтор, переход сцены голосованием и продолжение по interaction_id, пауза, активный бой, завершение встречи стадией координатора', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
  // `C18_4_LOGS=1` — вывод JS-сервера (сбои стадий после коммита).
  if (process.env.C18_4_LOGS) console.error(server.output())
} finally {
  await close()
}
