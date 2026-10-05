// Модель в тестах — только подставная. Два уровня:
//
// * `scriptedLlm` — объект с `completeJson`/`complete`, который модули сервера
//   получают внедрением (`llmClient`); сетевого кода нет вовсе;
// * `startFakeProvider` — локальный HTTP-сервер в протоколе OpenAI-совместимого
//   провайдера для `startTestServer({ env: { ROUTERAI_BASE_URL } })`, когда
//   проверяется весь путь через `server/llm-client.mjs` и учёт расхода.
import { createServer } from 'node:http'

/**
 * @typedef {object} LlmCall
 * @property {'completeJson' | 'complete'} method
 * @property {any} input запрос роли: `{ messages, temperature, maxTokens, … }`
 * @property {any} options второй аргумент: `{ timeoutMs, signal, … }`
 */

/**
 * @typedef {unknown | Error | ((input: any, options: any, call: number) => unknown)} ScriptedResponse
 *   значение — ответ; Error — отказ; функция — ответ по запросу
 */

/**
 * Подставной клиент модели с записью вызовов.
 *
 * Ответы берутся по очереди. Ошибка в очереди выбрасывается, функция
 * вызывается с `(input, options, номер)`. Когда очередь кончилась —
 * повторяется `fallback`, а если его нет, вызов падает: лишнее обращение к
 * модели в горячем пути — ошибка, а не шум.
 *
 * `complete` возвращает `{ content, json }`, как `LLMClient.complete`;
 * строковый ответ становится `content`.
 *
 * @param {ScriptedResponse[] | ScriptedResponse} [responses]
 * @param {{ fallback?: ScriptedResponse }} [options]
 */
export function scriptedLlm(responses = [], options = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const hasFallback = Object.hasOwn(options, 'fallback')
  /** @type {LlmCall[]} */
  const calls = []

  /**
   * @param {'completeJson' | 'complete'} method
   * @param {any} input
   * @param {any} requestOptions
   */
  const next = async (method, input, requestOptions) => {
    calls.push({ method, input, options: requestOptions })
    if (!queue.length && !hasFallback) {
      throw Object.assign(new Error(`scriptedLlm: неожиданный вызов модели №${calls.length}`), { code: 'LLM_UNEXPECTED_CALL' })
    }
    const response = queue.length ? queue.shift() : options.fallback
    if (response instanceof Error) throw response
    return typeof response === 'function' ? response(input, requestOptions, calls.length) : structuredClone(response)
  }

  return {
    calls,
    /** Сколько ответов осталось в очереди. */
    get remaining() { return queue.length },
    /** @param {any} input @param {any} [requestOptions] */
    completeJson: (input, requestOptions = {}) => next('completeJson', input, requestOptions),
    /** @param {any} input @param {any} [requestOptions] */
    async complete(input, requestOptions = {}) {
      const value = await next('complete', input, requestOptions)
      if (typeof value === 'string') return { content: value, json: null }
      return value && typeof value === 'object' && 'content' in value ? value : { content: JSON.stringify(value), json: value }
    },
    health: () => [],
  }
}

/**
 * Клиент, обращение к которому — ошибка теста.
 *
 * @param {string} [reason]
 */
export function forbiddenLlm(reason = 'модель не должна вызываться') {
  const fail = async () => { throw Object.assign(new Error(reason), { code: 'LLM_FORBIDDEN' }) }
  return { completeJson: fail, complete: fail, health: () => [] }
}

/**
 * Тело ответа `/chat/completions` в формате OpenAI.
 *
 * @param {unknown} content объект сериализуется в JSON (ответ JSON-роли), строка — как есть
 * @param {{ model?: string, usage?: object }} [options]
 */
export function chatCompletion(content, { model = 'kit/fake-model', usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } = {}) {
  return {
    model,
    choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    usage,
  }
}

/**
 * @typedef {object} ProviderRequest
 * @property {string} method
 * @property {string} path путь без префикса `/api/v1` (например `/chat/completions`)
 * @property {string} url полный путь запроса
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} text сырое тело
 * @property {any} body разобранный JSON или null
 */

/**
 * @typedef {{ status?: number, json?: unknown, body?: string | Buffer, headers?: Record<string, string> }} ProviderReply
 */

/**
 * Локальный провайдер на 127.0.0.1 в протоколе RouterAI/OpenAI
 * (`POST {base}/chat/completions`, `POST {base}/images`).
 *
 * Обработчик получает запрос и `res`. Возвращает:
 * * `undefined`/`null` — 404 (стартовая проба модели уйдёт в cooldown);
 * * `{ status?, json?, body?, headers? }` — ответ как есть;
 * * любое другое значение — JSON с кодом 200 (например `chatCompletion(...)`).
 * Если обработчик сам ответил через `res` (поток SSE), набор ничего не пишет.
 *
 * @param {{ after: (fn: () => unknown) => void }} t
 * @param {(request: ProviderRequest, res: import('node:http').ServerResponse) => unknown} handler
 * @returns {Promise<{ baseUrl: string, requests: ProviderRequest[], env: Record<string, string>, close: () => Promise<void> }>}
 *   `env` — готовая пара ROUTERAI_API_KEY/ROUTERAI_BASE_URL для startTestServer
 */
export async function startFakeProvider(t, handler) {
  /** @type {ProviderRequest[]} */
  const requests = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += String(chunk)
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { /* обработчик увидит text */ }
    const url = String(req.url ?? '')
    /** @type {ProviderRequest} */
    const request = { method: String(req.method), url, path: url.replace(/^\/api\/v1/u, ''), headers: req.headers, text, body }
    requests.push(request)
    try {
      const reply = await handler(request, res)
      if (res.headersSent || res.writableEnded) return
      if (reply == null) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":"kit fake provider: not handled"}')
        return
      }
      const shaped = /** @type {ProviderReply} */ (typeof reply === 'object' && ('status' in reply || 'json' in reply || 'body' in reply) ? reply : { json: reply })
      const payload = shaped.body ?? JSON.stringify(shaped.json ?? null)
      res.writeHead(shaped.status ?? 200, { 'Content-Type': 'application/json', ...shaped.headers })
      res.end(payload)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  let closed = false
  const close = () => new Promise((resolveClose) => {
    if (closed) return resolveClose(undefined)
    closed = true
    server.closeAllConnections()
    server.close(() => resolveClose(undefined))
  })
  t.after(close)
  const baseUrl = `http://127.0.0.1:${port}/api/v1`
  return {
    baseUrl,
    requests,
    env: { ROUTERAI_API_KEY: 'kit-fake-provider-key', ROUTERAI_BASE_URL: baseUrl },
    close: async () => { await close() },
  }
}
