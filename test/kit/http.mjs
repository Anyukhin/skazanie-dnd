// HTTP-уровень тестового набора: настоящий `server/index.mjs` дочерним
// процессом на свободном порту и временном хранилище, клиент с cookie и
// типовые шаги «администратор → кампания → игрок по приглашению».
//
// Сервер нельзя собрать в процессе теста: модуль при импорте поднимает
// слушатель и фоновые часы. Поэтому здесь по-прежнему `spawn`, но один на
// весь корпус, а не копия в каждом файле.
//
// Сеть закрыта по построению (`test/test-network-isolation.test.mjs`): ключ
// провайдера всегда пуст, а непустой ключ принимается только вместе с
// локальным `ROUTERAI_BASE_URL`. Ключ и адрес из окружения разработчика и
// из `.env` не наследуются никогда.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { freePort } from '../free-port.mjs'
import { runnerTimeout } from '../shared-runner-timeout.mjs'

/** Корень репозитория: сервер запускается отсюда независимо от cwd теста. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Токен первичной настройки администратора по умолчанию. */
export const DEFAULT_SETUP_TOKEN = 'kit-setup-token'

/** Сколько символов вывода сервера хранить для сообщений об ошибке. */
const OUTPUT_LIMIT = 1_000_000

/**
 * Адрес указывает на эту машину. Тот же критерий, что у сторожа сети.
 *
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLocalProviderUrl(address) {
  return typeof address === 'string'
    && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/u.test(address)
}

/**
 * Окружение дочернего сервера. Единственное место, где набор собирает env.
 *
 * Правило сети: `ROUTERAI_API_KEY` пуст, если вызывающий явно не передал
 * непустой ключ вместе с локальным `ROUTERAI_BASE_URL`; иначе — исключение.
 * Значения из `process.env` для этих двух переменных отбрасываются: dotenv
 * не перезаписывает заданные переменные, поэтому пустая строка закрывает и
 * боевой ключ из `.env`.
 *
 * Переменная со значением `undefined` в `env` снимается из окружения.
 *
 * @param {{ port: number, storageDir: string, setupToken: string, env?: Record<string, string | undefined> }} options
 * @returns {Record<string, string>}
 */
export function isolatedServerEnv({ port, storageDir, setupToken, env = {} }) {
  const callerKey = env.ROUTERAI_API_KEY ?? ''
  const callerBaseUrl = env.ROUTERAI_BASE_URL ?? ''
  if (callerBaseUrl && !isLocalProviderUrl(callerBaseUrl)) {
    throw new Error(`Тестовый сервер не ходит во внешнюю сеть: ROUTERAI_BASE_URL=${callerBaseUrl} не локальный`)
  }
  if (callerKey && !callerBaseUrl) {
    throw new Error('Непустой ROUTERAI_API_KEY допустим только вместе с локальным ROUTERAI_BASE_URL (startFakeProvider)')
  }
  if ('DND_STORAGE_DIR' in env || 'AGENT_PORT' in env) {
    throw new Error('Хранилище и порт задаются набором: используйте опции storageDir и restart()')
  }
  /** @type {Record<string, string | undefined>} */
  const merged = {
    ...process.env,
    AGENT_HOST: '127.0.0.1',
    ADMIN_SETUP_TOKEN: setupToken,
    COOKIE_SECURE: 'false',
    NODE_ENV: 'test',
    ...env,
    AGENT_PORT: String(port),
    DND_STORAGE_DIR: storageDir,
    ROUTERAI_API_KEY: String(callerKey),
    ROUTERAI_BASE_URL: String(callerBaseUrl),
  }
  return /** @type {Record<string, string>} */ (Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)]),
  ))
}

/**
 * @param {string | URL} preload путь от корня репозитория, абсолютный путь или file: URL
 * @returns {string}
 */
function preloadUrl(preload) {
  if (preload instanceof URL) return preload.href
  if (preload.startsWith('file:')) return preload
  return pathToFileURL(isAbsolute(preload) ? preload : resolve(REPO_ROOT, preload)).href
}

/**
 * @typedef {object} TestServer
 * @property {string} baseUrl текущий адрес; меняется после restart()
 * @property {number} port
 * @property {string} storageDir
 * @property {string} setupToken
 * @property {() => Promise<void>} restart остановить и поднять заново на том же хранилище
 * @property {() => Promise<void>} stop остановить; хранилище остаётся (его можно прочитать журналом напрямую)
 * @property {() => Promise<void>} start поднять снова после stop() на том же хранилище
 * @property {() => string} output накопленный stdout+stderr всех запусков
 * @property {import('node:child_process').ChildProcess | null} child
 */

/**
 * Поднять настоящий сервер для HTTP-теста. Остановка и удаление временного
 * хранилища — в `t.after`.
 *
 * @param {{ after: (fn: () => unknown) => void }} t контекст node:test
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   preload?: string | URL | Array<string | URL>,
 *   storageDir?: string,
 *   storagePrefix?: string,
 *   setupToken?: string,
 *   args?: string[],
 *   healthTimeoutMs?: number,
 * }} [options]
 *   `preload` — модули для `--import` (детерминированные кости, отказы commit);
 *   `storageDir` — готовое хранилище: набор его не создаёт и не удаляет;
 *   `storagePrefix` — префикс временного каталога, если preload проверяет имя;
 *   `args` — аргументы node перед `server/index.mjs`.
 * @returns {Promise<TestServer>}
 */
export async function startTestServer(t, {
  env = {},
  preload = [],
  storageDir,
  storagePrefix = 'skazanie-kit-',
  setupToken = env.ADMIN_SETUP_TOKEN ?? DEFAULT_SETUP_TOKEN,
  args = [],
  healthTimeoutMs = runnerTimeout(30_000),
} = {}) {
  const ownsStorage = !storageDir
  const storage = storageDir ?? mkdtempSync(join(tmpdir(), storagePrefix))
  const preloads = (Array.isArray(preload) ? preload : [preload]).flatMap((entry) => ['--import', preloadUrl(entry)])
  let log = ''
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  const append = (/** @type {unknown} */ chunk) => {
    log += String(chunk)
    if (log.length > OUTPUT_LIMIT) log = log.slice(-OUTPUT_LIMIT)
  }

  /** @type {TestServer} */
  const server = {
    baseUrl: '',
    port: 0,
    storageDir: storage,
    setupToken,
    child: null,
    output: () => log,
    stop: async () => {
      const running = child
      child = null
      server.child = null
      await stopChild(running)
    },
    restart: async () => {
      await server.stop()
      await launch()
    },
    start: async () => {
      if (child) throw new Error('Тестовый сервер уже запущен: для перезапуска есть restart()')
      await launch()
    },
  }

  const launch = async () => {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const spawned = spawn(process.execPath, [...args, ...preloads, 'server/index.mjs'], {
      cwd: REPO_ROOT,
      env: isolatedServerEnv({ port, storageDir: storage, setupToken, env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    spawned.stdout?.on('data', append)
    spawned.stderr?.on('data', append)
    child = spawned
    Object.assign(server, { baseUrl, port, child: spawned })
    await waitForHealth(baseUrl, spawned, healthTimeoutMs, () => log)
  }

  t.after(async () => {
    await server.stop()
    if (ownsStorage) rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  await launch()
  return server
}

/**
 * @param {import('node:child_process').ChildProcess | null} child
 */
async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  await new Promise((resolveExit) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => { clearTimeout(force); resolveExit(undefined) })
    child.kill()
  })
}

/**
 * @param {string} baseUrl
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @param {() => string} output
 */
async function waitForHealth(baseUrl, child, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`Тестовый сервер завершился до health: exit=${child.exitCode}, signal=${child.signalCode}\n${output().slice(-4_000)}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })
      await response.arrayBuffer()
      if (response.ok) return
    } catch { /* слушатель ещё поднимается */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  await stopChild(child)
  throw new Error(`Тестовый сервер не ответил на /api/health за ${timeoutMs} мс\n${output().slice(-4_000)}`)
}

/**
 * @typedef {object} KitResponse
 * @property {number} status
 * @property {any} body разобранный JSON или null
 * @property {string} text сырое тело
 * @property {Headers} headers
 * @property {string} cookie пара `имя=значение` из Set-Cookie этого ответа или ''
 */

/**
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {unknown} [body] сериализуется в JSON
 * @property {Record<string, string>} [headers]
 * @property {string} [idempotencyKey] заголовок X-Idempotency-Key
 * @property {string | null} [cookie] переопределить cookie клиента; null — без cookie
 * @property {number} [timeoutMs]
 */

/**
 * @typedef {object} KitClient
 * @property {string} cookie текущая сессия клиента (`skazanie_session=…`) или ''
 * @property {(path: string, options?: RequestOptions) => Promise<KitResponse>} request
 * @property {(path: string, options?: RequestOptions) => Promise<KitResponse>} get
 * @property {(path: string, body?: unknown, options?: RequestOptions) => Promise<KitResponse>} post
 * @property {(path: string, body?: unknown, options?: RequestOptions) => Promise<KitResponse>} patch
 * @property {(path: string, body?: unknown, options?: RequestOptions) => Promise<KitResponse>} put
 * @property {(path: string, options?: RequestOptions) => Promise<KitResponse>} delete
 * @property {(path: string, init?: RequestInit) => Promise<Response>} fetch сырой ответ с cookie клиента (файлы, SSE-поток)
 */

/**
 * Клиент с собственной cookie-сессией. Адрес читается при каждом запросе,
 * поэтому клиент переживает `server.restart()` (сессии сервер хранит в storage).
 *
 * @param {string | { baseUrl: string }} target адрес или объект сервера из startTestServer
 * @param {{ cookie?: string }} [options]
 * @returns {KitClient}
 */
export function createClient(target, { cookie = '' } = {}) {
  const baseUrl = () => (typeof target === 'string' ? target : target.baseUrl)
  /** @type {KitClient} */
  const client = {
    cookie,
    async request(path, { method = 'GET', body, headers = {}, idempotencyKey, cookie: override, timeoutMs = runnerTimeout(30_000) } = {}) {
      const session = override === undefined ? client.cookie : (override ?? '')
      const response = await fetch(`${baseUrl()}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(session ? { Cookie: session } : {}),
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { /* не JSON: проверку делает тест по text */ }
      const setCookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
      // Сервер снимает сессию пустым значением (logout) — клиент её забывает.
      if (setCookie && override === undefined) client.cookie = /=$/u.test(setCookie) ? '' : setCookie
      return { status: response.status, body: parsed, text, headers: response.headers, cookie: setCookie }
    },
    get: (path, options = {}) => client.request(path, { ...options, method: 'GET' }),
    post: (path, body, options = {}) => client.request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options = {}) => client.request(path, { ...options, method: 'PATCH', body }),
    put: (path, body, options = {}) => client.request(path, { ...options, method: 'PUT', body }),
    delete: (path, options = {}) => client.request(path, { ...options, method: 'DELETE' }),
    fetch: (path, init = {}) => fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...Object.fromEntries(new Headers(init.headers ?? {})) },
    }),
  }
  return client
}

/**
 * Проверить статус ответа и вернуть тело. Сообщение — код и текст ошибки
 * сервера, а не весь JSON.
 *
 * @param {KitResponse} response
 * @param {number | number[]} [status]
 * @returns {any}
 */
export function expectStatus(response, status = 200) {
  const allowed = Array.isArray(status) ? status : [status]
  assert.ok(allowed.includes(response.status),
    `ожидался HTTP ${allowed.join('/')}, получен ${response.status}: ${response.text.slice(0, 400)}`)
  return response.body
}

let accountSerial = 0

/**
 * Первичная настройка администратора. Сессию выдаёт сам `setup-admin`.
 *
 * @param {{ baseUrl: string, setupToken: string }} server
 * @param {{ name?: string, email?: string, password?: string }} [account]
 * @returns {Promise<{ client: KitClient, user: any, email: string, password: string }>}
 */
export async function setupAdmin(server, {
  name = 'Ведущий',
  email = `kit-admin-${process.pid}-${++accountSerial}@kit.test`,
  password = 'kit-admin-password-1',
} = {}) {
  const client = createClient(server)
  const response = await client.post('/api/auth/setup-admin', { name, email, password, setupToken: server.setupToken })
  const body = expectStatus(response, 201)
  assert.ok(client.cookie, 'setup-admin должен выдать сессию')
  return { client, user: body.user, email, password }
}

/**
 * Зарегистрировать игрока. Сессию выдаёт сам `register`.
 *
 * @param {{ baseUrl: string }} server
 * @param {{ name?: string, email?: string, password?: string }} [account]
 * @returns {Promise<{ client: KitClient, user: any, email: string, password: string }>}
 */
export async function registerUser(server, {
  name = 'Игрок',
  email = `kit-player-${process.pid}-${++accountSerial}@kit.test`,
  password = 'kit-player-password-1',
} = {}) {
  const client = createClient(server)
  const body = expectStatus(await client.post('/api/auth/register', { name, email, password }), 201)
  assert.ok(client.cookie, 'register должен выдать сессию')
  return { client, user: body.user, email, password }
}

/**
 * Войти существующим аккаунтом — новая сессия в новом клиенте.
 *
 * @param {{ baseUrl: string }} server
 * @param {{ email: string, password: string }} account
 * @returns {Promise<KitClient>}
 */
export async function login(server, { email, password }) {
  const client = createClient(server)
  expectStatus(await client.post('/api/auth/login', { email, password }))
  assert.ok(client.cookie, 'login должен выдать сессию')
  return client
}

/**
 * Создать кампанию. Готовое состояние (`state`) принимает только администратор;
 * `bootstrap` — путь мастера создания.
 *
 * @param {KitClient} client
 * @param {{ code: string, name?: string, state?: object, bootstrap?: object, status?: number | number[] }} campaign
 * @returns {Promise<any>} тело ответа сервера
 */
export async function createCampaign(client, { code, name = 'Тестовая кампания', state, bootstrap, status = 201 }) {
  const body = { code, name }
  if (state !== undefined) Object.assign(body, { state })
  if (bootstrap !== undefined) Object.assign(body, { bootstrap })
  return expectStatus(await client.post('/api/campaigns', body), status)
}

/**
 * Пригласить нового игрока на героев кампании: приглашение владельцем,
 * регистрация, вход по ссылке.
 *
 * @param {{ baseUrl: string }} server
 * @param {KitClient} ownerClient владелец кампании или администратор
 * @param {string} campaignCode
 * @param {{ heroIds?: string[], name?: string, email?: string, password?: string }} [options]
 * @returns {Promise<{ client: KitClient, user: any, heroIds: string[], invite: any, email: string, password: string }>}
 */
export async function addPlayer(server, ownerClient, campaignCode, { heroIds, ...account } = {}) {
  const invite = expectStatus(await ownerClient.post(`/api/campaigns/${campaignCode}/invites`, heroIds ? { hero_ids: heroIds } : {}), 201)
  const player = await registerUser(server, account)
  const joined = expectStatus(await player.client.post(`/api/campaigns/${campaignCode}/join`, { invite_token: invite.token }))
  return { ...player, heroIds: joined.hero_ids, invite }
}

/**
 * Отправить команду движку через основной маршрут.
 *
 * @param {KitClient} client
 * @param {string} campaignCode
 * @param {string} idempotencyKey
 * @param {object} command
 * @param {{ message?: string, header?: boolean }} [options] `header` — продублировать ключ в X-Idempotency-Key
 * @returns {Promise<KitResponse>}
 */
export function sendCommand(client, campaignCode, idempotencyKey, command, { message, header = false } = {}) {
  return client.post(`/api/campaigns/${campaignCode}/commands`, {
    idempotency_key: idempotencyKey,
    ...(message === undefined ? {} : { message }),
    command,
  }, header ? { idempotencyKey } : {})
}
