// Помощники генераторов эталонов «Г» sk-server (`rust/SERVER-PLAN.md` §2):
// сценарий гоняется против JS-сервера через `test/kit`, каждый обмен
// записывается в `fixtures/<имя>.json` формата `skazanie.golden/1`, а
// Rust-тест (`tests/kit/golden.rs`) прогоняет те же запросы через свой набор.
//
// Генератор импортирует `rust/fixtures-env.mjs` ПЕРВЫМ и запускает сервер с
// ним же (`preload`), чтобы локаль не зависела от машины.
//
// Нормализатор обязан совпадать с `normalize` из `tests/kit/golden.rs`:
// * поля `*token*` (строки) — `<token>`, `*cookie*` — `<cookie>`;
// * поля `updatedAt`, `*At`, `*_at` (строки и числа) — `<time>`;
// * в строках: `skazanie_session=…` — `<cookie>`, `invite=…`/`invite/…` —
//   `<invite>`, uuid — `<uuid>`, ISO-даты — `<date>`;
// * `null` остаётся `null`; детерминированные `event_id` не трогаются.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient, startTestServer } from '../../../../test/kit/http.mjs'

export const GOLDEN_FORMAT = 'skazanie.golden/1'
export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))
/** Код первичной настройки администратора — как у Rust-набора (`Options::default`). */
export const GOLDEN_SETUP_TOKEN = 'setup-code'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu
const DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu
const INVITE = /([?&/]invite[=/])[^&#/\s]+/gu
const COOKIE = /(skazanie_session=)[^;\s]+/gu

/** @param {string} key */
const isTimeKey = (key) => key === 'updatedAt' || key.endsWith('_at') || (key.length > 2 && key.endsWith('At'))

/** @param {string} key */
function secretMask(key) {
  const lower = key.toLowerCase()
  if (lower.includes('token')) return '<token>'
  if (lower.includes('cookie')) return '<cookie>'
  return null
}

/** @param {string} text */
export function normalizeString(text) {
  return text.replace(COOKIE, '$1<cookie>').replace(INVITE, '$1<invite>').replace(UUID, '<uuid>').replace(DATE, '<date>')
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (item === null) return [key, null]
      const mask = secretMask(key)
      if (mask && typeof item === 'string') return [key, mask]
      if (isTimeKey(key) && (typeof item === 'string' || typeof item === 'number')) return [key, '<time>']
      return [key, normalize(item)]
    }))
  }
  if (typeof value === 'string') return normalizeString(value)
  return value
}

/**
 * Запуск JS-сервера для генератора: свой `t.after`, локаль `fixtures-env`.
 *
 * @param {Record<string, unknown>} [options] опции `startTestServer`
 */
export async function startGoldenServer(options = {}) {
  /** @type {Array<() => unknown>} */
  const cleanups = []
  const t = { after: (/** @type {() => unknown} */ fn) => { cleanups.push(fn) } }
  const server = await startTestServer(t, { impl: 'js', setupToken: GOLDEN_SETUP_TOKEN, preload: 'rust/fixtures-env.mjs', ...options })
  return { server, close: async () => { for (const fn of cleanups.reverse()) await fn() } }
}

/**
 * Запись сценария: клиенты по ролям, каждый обмен — в список.
 *
 * @param {{ baseUrl: string }} server
 */
export function recorder(server) {
  /** @type {Map<string, ReturnType<typeof createClient>>} */
  const clients = new Map()
  /** @type {object[]} */
  const exchanges = []
  /**
   * @param {string} role
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, headers?: Record<string, string>, responseHeaders?: string[] }} [options]
   */
  async function send(role, method, path, { body, headers = {}, responseHeaders = [] } = {}) {
    if (!clients.has(role)) clients.set(role, createClient(server))
    const client = /** @type {ReturnType<typeof createClient>} */ (clients.get(role))
    const response = await client.request(path, { method, body, headers })
    const entry = { as: role, method, path, headers, body: body ?? null, status: response.status, body_norm: normalize(response.body) }
    if (responseHeaders.length) {
      Object.assign(entry, {
        headers_norm: Object.fromEntries(responseHeaders.map((name) => {
          const value = response.headers.get(name)
          return [name, value === null ? null : normalizeString(value)]
        })),
      })
    }
    exchanges.push(entry)
    return response
  }
  return { send, exchanges }
}

/**
 * @param {string} name
 * @param {string} scenario
 * @param {object[]} exchanges
 */
export function writeGolden(name, scenario, exchanges) {
  const file = join(FIXTURES_DIR, `${name}.json`)
  writeFileSync(file, `${JSON.stringify({ format: GOLDEN_FORMAT, scenario, exchanges }, null, 2)}\n`)
  return file
}
