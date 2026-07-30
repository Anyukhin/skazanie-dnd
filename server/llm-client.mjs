import { LLMClient } from './contracts.mjs'
import { currentCampaignModel } from './campaign-ai-context.mjs'

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_TOOL_CALLS = 8
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class LLMError extends Error {
  constructor(message, code = 'LLM_ERROR', details = {}) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    Object.assign(this, details)
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(timeoutMs) {
    super(`LLM не ответил за ${timeoutMs} мс`, 'LLM_TIMEOUT', { timeoutMs })
    this.name = 'LLMTimeoutError'
  }
}

export class LLMResponseError extends LLMError {
  constructor(message, code = 'LLM_RESPONSE_INVALID', details = {}) {
    super(message, code, details)
    this.name = 'LLMResponseError'
  }
}

export class LLMToolCallLimitError extends LLMResponseError {
  constructor(actual, maximum) {
    super(`Модель запросила ${actual} инструментов при лимите ${maximum}`, 'LLM_TOOL_CALL_LIMIT', { actual, maximum })
    this.name = 'LLMToolCallLimitError'
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

function assertSafeJsonTree(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LLMResponseError(`Недопустимое число в ${path}`)
    return
  }
  if (typeof value !== 'object') throw new LLMResponseError(`Недопустимый JSON-тип в ${path}`)
  if (seen.has(value)) throw new LLMResponseError(`Циклическая JSON-структура в ${path}`)
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new LLMResponseError(`В ${path} ожидался обычный JSON-объект`)
  }
  seen.add(value)
  for (const key of Object.keys(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) throw new LLMResponseError(`Запрещённое JSON-поле ${path}.${key}`)
    assertSafeJsonTree(value[key], `${path}.${key}`, seen)
  }
  seen.delete(value)
}

/** JSON.parse without markdown/prose recovery. Only a complete JSON value is accepted. */
export function strictJsonParse(input, {
  label = 'ответ LLM',
  expected = 'object-or-array',
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (!['object', 'array', 'object-or-array', 'any'].includes(expected)) throw new TypeError(`Неизвестный expected JSON type: ${expected}`)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes должен быть положительным целым числом')
  let parsed
  if (typeof input === 'string') {
    const source = input.trim()
    if (!source) throw new LLMResponseError(`${label}: пустой JSON`)
    if (byteLength(source) > maxBytes) throw new LLMResponseError(`${label}: JSON превышает лимит ${maxBytes} байт`, 'LLM_RESPONSE_TOO_LARGE')
    if (source.startsWith('```')) {
      throw new LLMResponseError(`${label}: markdown-обёртка запрещена`)
    }
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      throw new LLMResponseError(`${label}: некорректный JSON`, 'LLM_JSON_INVALID', { cause: error })
    }
  } else {
    parsed = input
  }

  const isArray = Array.isArray(parsed)
  const isObject = parsed != null && typeof parsed === 'object' && !isArray
  if (expected === 'object' && !isObject) throw new LLMResponseError(`${label}: ожидался JSON-объект`)
  if (expected === 'array' && !isArray) throw new LLMResponseError(`${label}: ожидался JSON-массив`)
  if (expected === 'object-or-array' && !isObject && !isArray) throw new LLMResponseError(`${label}: ожидался объект или массив`)
  assertSafeJsonTree(parsed)
  if (typeof input !== 'string' && byteLength(JSON.stringify(parsed)) > maxBytes) {
    throw new LLMResponseError(`${label}: JSON превышает лимит ${maxBytes} байт`, 'LLM_RESPONSE_TOO_LARGE')
  }
  return parsed
}

function positiveInteger(value, fallback, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    if (fallback != null) return fallback
    throw new TypeError(`${label} должен быть положительным целым числом`)
  }
  return number
}

function normalizeRequest(input, options = {}) {
  const request = Array.isArray(input)
    ? { ...options, messages: input }
    : { ...(input && typeof input === 'object' ? input : {}), ...options }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new TypeError('LLM-запрос должен содержать непустой массив messages')
  }
  request.messages = request.messages.map((message) => {
    if (!message || typeof message !== 'object' || !String(message.role || '').trim()) {
      throw new TypeError('Каждое LLM-сообщение должно иметь role')
    }
    return { ...message, role: String(message.role) }
  })
  return request
}

function toolNames(tools, explicitNames) {
  const names = new Set()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.function?.name ?? tool?.name
    if (name) names.add(String(name))
  }
  for (const name of Array.isArray(explicitNames) ? explicitNames : []) names.add(String(name))
  return names
}

function wantsJson(request) {
  return request.json === true || request.expectJson === true || request.responseFormat === 'json' || request.responseFormat === 'json_object'
}

export function validateToolCalls(toolCalls, {
  allowedToolNames = [],
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
} = {}) {
  if (toolCalls != null && !Array.isArray(toolCalls)) {
    throw new LLMResponseError('tool_calls должен быть массивом', 'LLM_TOOL_CALL_INVALID')
  }
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  const maximum = positiveInteger(maxToolCalls, DEFAULT_MAX_TOOL_CALLS, 'maxToolCalls')
  if (calls.length > maximum) throw new LLMToolCallLimitError(calls.length, maximum)

  const allowed = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames)
  return calls.map((call, index) => {
    if (!call || typeof call !== 'object' || (call.type && call.type !== 'function')) {
      throw new LLMResponseError(`Tool call ${index} имеет недопустимый формат`, 'LLM_TOOL_CALL_INVALID')
    }
    const name = String(call.function?.name ?? call.name ?? '')
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) {
      throw new LLMResponseError(`Tool call ${index}: недопустимое имя`, 'LLM_TOOL_NAME_INVALID')
    }
    if (!allowed.has(name)) {
      throw new LLMResponseError(`Инструмент ${name} не входит в allowlist`, 'LLM_TOOL_NOT_ALLOWED', { toolName: name })
    }
    const rawArguments = call.function?.arguments ?? call.arguments ?? '{}'
    const args = strictJsonParse(rawArguments, { label: `аргументы ${name}`, expected: 'object' })
    return {
      id: String(call.id || `tool-call-${index + 1}`),
      type: 'function',
      function: { name, arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments) },
      arguments: args,
    }
  })
}

function normalizeAssistantMessage(message, request, defaults) {
  if (!message || typeof message !== 'object') throw new LLMResponseError('LLM не вернул assistant message')
  if (message.role && message.role !== 'assistant') throw new LLMResponseError('LLM вернул сообщение с неверной ролью')
  const allowed = toolNames(request.tools, request.allowedToolNames)
  const toolCalls = validateToolCalls(message.tool_calls ?? message.toolCalls, {
    allowedToolNames: allowed,
    maxToolCalls: request.maxToolCalls ?? defaults.maxToolCalls,
  })
  const content = message.content == null ? '' : typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const normalized = { role: 'assistant', content, tool_calls: toolCalls }
  if (!content.trim() && !toolCalls.length) throw new LLMResponseError('LLM returned an empty assistant response', 'LLM_RESPONSE_INVALID')
  if (wantsJson(request)) normalized.json = strictJsonParse(content, { label: 'JSON content', expected: request.jsonExpected ?? 'object' })
  return normalized
}

function makeAbortScope(timeoutMs, externalSignal) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new LLMTimeoutError(timeoutMs)) }, timeoutMs)
  const onAbort = () => controller.abort(externalSignal.reason)
  if (externalSignal?.aborted) onAbort()
  else externalSignal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    close() {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onAbort)
    },
  }
}

function raceWithSignal(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(
      (value) => { signal?.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal?.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

async function readProviderBody(response, maxBytes) {
  if (typeof response?.text === 'function') {
    let text = await response.text()
    // Some compatible gateways wrap the whole HTTP JSON envelope in one
    // markdown fence. Unwrap only that transport quirk; model content and tool
    // arguments still go through their original strict parsers unchanged.
    // Compatible gateways are inconsistent here: some put the JSON on the
    // next line, while others return a compact ```json{...}``` envelope.
    // We only unwrap when the fence covers the complete HTTP body; the inner
    // value still has to pass strictJsonParse and all of its safety checks.
    const fenced = /^\s*```[A-Za-z0-9_./+-]*\s*([\s\S]*?)\s*```\s*$/.exec(text)
    if (fenced) text = fenced[1]
    return strictJsonParse(text, { label: 'ответ RouterAI', expected: 'object', maxBytes })
  }
  if (typeof response?.json === 'function') {
    return strictJsonParse(await response.json(), { label: 'ответ RouterAI', expected: 'object', maxBytes })
  }
  throw new LLMResponseError('RouterAI вернул нечитаемый ответ')
}

export class RouterAIClient extends LLMClient {
  constructor({
    apiKey = process.env.ROUTERAI_API_KEY ?? '',
    baseUrl = process.env.ROUTERAI_BASE_URL ?? 'https://routerai.ru/api/v1',
    model = process.env.DND_AI_MODEL ?? 'deepseek/deepseek-v4-flash',
    maxTokens = Number(process.env.DND_AI_MAX_TOKENS) || 1200,
    reasoning = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super()
    if (typeof fetchImpl !== 'function') throw new TypeError('Для RouterAIClient требуется fetch')
    this.apiKey = String(apiKey)
    this.baseUrl = String(baseUrl).replace(/\/$/, '')
    this.model = String(model)
    this.maxTokens = positiveInteger(maxTokens, 1200, 'maxTokens')
    this.reasoning = reasoning && typeof reasoning === 'object' ? { ...reasoning } : null
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxToolCalls = positiveInteger(maxToolCalls, DEFAULT_MAX_TOOL_CALLS, 'maxToolCalls')
    this.maxResponseBytes = positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes')
    this.fetchImpl = fetchImpl
  }

  async complete(input, options = {}) {
    const request = normalizeRequest(input, options)
    if (!this.apiKey) throw new LLMError('ROUTERAI_API_KEY не настроен', 'LLM_NOT_CONFIGURED')
    const timeoutMs = positiveInteger(request.timeoutMs ?? this.timeoutMs, this.timeoutMs, 'timeoutMs')
    const scope = makeAbortScope(timeoutMs, request.signal)
    const body = {
      model: String(request.model || this.model),
      messages: request.messages,
      temperature: Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : 0,
      max_tokens: positiveInteger(request.maxTokens ?? this.maxTokens, this.maxTokens, 'maxTokens'),
    }
    if (Array.isArray(request.tools) && request.tools.length) {
      body.tools = request.tools
      body.tool_choice = request.toolChoice ?? request.tool_choice ?? 'auto'
    }
    const reasoning = request.reasoning && typeof request.reasoning === 'object' ? request.reasoning : this.reasoning
    if (reasoning) body.reasoning = reasoning
    if (wantsJson(request)) body.response_format = { type: 'json_object' }

    try {
      const response = await raceWithSignal(this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: scope.signal,
      }), scope.signal)
      const payload = await raceWithSignal(readProviderBody(response, this.maxResponseBytes), scope.signal)
      if (!response.ok) throw new LLMError(`RouterAI ответил HTTP ${response.status}`, 'LLM_PROVIDER_ERROR', { status: response.status })
      const message = normalizeAssistantMessage(payload.choices?.[0]?.message, request, this)
      return { ...message, model: payload.model ?? body.model, usage: payload.usage ?? null, provider: 'RouterAI' }
    } catch (error) {
      if (scope.timedOut()) throw new LLMTimeoutError(timeoutMs)
      if (request.signal?.aborted) throw new LLMError('LLM-запрос отменён', 'LLM_ABORTED', { cause: error })
      if (error instanceof LLMError) throw error
      throw new LLMError('Не удалось вызвать RouterAI', 'LLM_PROVIDER_UNAVAILABLE', { cause: error })
    } finally {
      scope.close()
    }
  }

  async completeJson(input, options = {}) {
    const result = await this.complete(input, { ...options, json: true })
    return result.json
  }
}

export class FallbackLLMClient extends LLMClient {
  constructor({
    clients = [],
    failureCooldownMs = 120_000,
    probeTimeoutMs = 8_000,
    now = () => Date.now(),
  } = {}) {
    super()
    if (!Array.isArray(clients) || !clients.length || clients.some((client) => !client || typeof client.complete !== 'function')) {
      throw new TypeError('FallbackLLMClient requires at least one LLM client')
    }
    this.clients = [...clients]
    this.model = String(this.clients[0].model ?? 'fallback-cascade')
    this.models = this.clients.map((client) => String(client.model ?? 'unknown-model'))
    this.failureCooldownMs = positiveInteger(failureCooldownMs, 120_000, 'failureCooldownMs')
    this.probeTimeoutMs = positiveInteger(probeTimeoutMs, 8_000, 'probeTimeoutMs')
    this.now = now
    this.statuses = new Map(this.models.map((model) => [model, {
      model,
      state: 'unknown',
      failures: 0,
      disabledUntil: 0,
      lastErrorCode: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    }]))
  }

  _status(client) {
    return this.statuses.get(String(client.model ?? 'unknown-model'))
  }

  _markSuccess(client) {
    const status = this._status(client)
    Object.assign(status, {
      state: 'ready', failures: 0, disabledUntil: 0, lastErrorCode: null, lastSuccessAt: this.now(),
    })
  }

  _markFailure(client, error) {
    const status = this._status(client)
    Object.assign(status, {
      state: 'cooldown',
      failures: status.failures + 1,
      disabledUntil: this.now() + this.failureCooldownMs,
      lastErrorCode: String(error?.code ?? error?.name ?? 'LLM_ERROR').slice(0, 80),
      lastFailureAt: this.now(),
    })
  }

  _retryable(error) {
    if (error instanceof LLMResponseError || error instanceof LLMTimeoutError) return true
    if (!(error instanceof LLMError)) return false
    if (['LLM_ABORTED', 'LLM_NOT_CONFIGURED'].includes(error.code)) return false
    if (error.code === 'LLM_PROVIDER_ERROR' && [401, 402].includes(Number(error.status))) return false
    return ['LLM_PROVIDER_ERROR', 'LLM_PROVIDER_UNAVAILABLE', 'LLM_RESPONSE_INVALID', 'LLM_JSON_INVALID', 'LLM_RESPONSE_TOO_LARGE'].includes(error.code)
  }

  _candidates() {
    const now = this.now()
    const ready = this.clients.filter((client) => this._status(client).disabledUntil <= now)
    const candidates = ready.length ? ready : [...this.clients].sort((left, right) => this._status(left).disabledUntil - this._status(right).disabledUntil)
    const preferredModel = currentCampaignModel()
    if (!preferredModel) return candidates
    const preferredIndex = candidates.findIndex((client) => String(client.model ?? '') === preferredModel)
    if (preferredIndex <= 0) return candidates
    return [candidates[preferredIndex], ...candidates.slice(0, preferredIndex), ...candidates.slice(preferredIndex + 1)]
  }

  async complete(input, options = {}) {
    const validateResponse = options.validateResponse ?? (input && !Array.isArray(input) ? input.validateResponse : null)
    const attempts = []
    for (const client of this._candidates()) {
      try {
        const result = await client.complete(input, options)
        if (typeof validateResponse === 'function' && await validateResponse(result) === false) {
          throw new LLMResponseError(`Model ${client.model} returned an unusable response`, 'LLM_RESPONSE_INVALID')
        }
        this._markSuccess(client)
        return { ...result, fallback_attempts: attempts, fallback_used: attempts.length > 0 }
      } catch (error) {
        if (!this._retryable(error)) throw error
        this._markFailure(client, error)
        attempts.push({ model: String(client.model ?? 'unknown-model'), code: String(error?.code ?? error?.name ?? 'LLM_ERROR') })
      }
    }
    throw new LLMError('All configured RouterAI models failed', 'LLM_FALLBACK_EXHAUSTED', { attempts })
  }

  async completeJson(input, options = {}) {
    const result = await this.complete(input, { ...options, json: true })
    return result.json
  }

  async probe() {
    for (const client of this.clients) {
      try {
        const result = await client.complete({
          messages: [
            { role: 'system', content: 'Return only a JSON object with {"ok":true}.' },
            { role: 'user', content: 'Health check.' },
          ],
          json: true,
          jsonExpected: 'object',
          temperature: 0,
          maxTokens: 128,
          timeoutMs: this.probeTimeoutMs,
        })
        if (result.json?.ok !== true) throw new LLMResponseError('Model health check returned invalid JSON', 'LLM_PROBE_INVALID')
        this._markSuccess(client)
      } catch (error) {
        this._markFailure(client, error)
      }
    }
    return this.health()
  }

  health() {
    const now = this.now()
    return this.models.map((model, index) => {
      const status = this.statuses.get(model)
      return {
        model,
        primary: index === 0,
        state: status.disabledUntil > now ? 'cooldown' : status.state === 'cooldown' ? 'retry-ready' : status.state,
        failures: status.failures,
        last_error_code: status.lastErrorCode,
        retry_after_ms: Math.max(0, status.disabledUntil - now),
      }
    })
  }
}

function fakeMessage(response) {
  if (response?.choices?.[0]?.message) return response.choices[0].message
  if (response && typeof response === 'object' && ('content' in response || 'tool_calls' in response || 'toolCalls' in response || response.role === 'assistant')) return response
  return { role: 'assistant', content: typeof response === 'string' ? response : JSON.stringify(response) }
}

function waitFor(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, milliseconds)
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

export class FakeLLM extends LLMClient {
  constructor(config = {}) {
    super()
    if (Array.isArray(config)) config = { responses: config }
    if (typeof config === 'function') config = { handler: config }
    this.responses = [...(config.responses ?? [])]
    this.handler = config.handler ?? null
    this.delayMs = Math.max(0, Number(config.delayMs) || 0)
    this.timeoutMs = positiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxToolCalls = positiveInteger(config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS, 'maxToolCalls')
    this.requests = []
    this.calls = this.requests
  }

  enqueue(response) {
    this.responses.push(response)
    return this
  }

  async complete(input, options = {}) {
    const request = normalizeRequest(input, options)
    this.requests.push({ ...request, signal: undefined })
    const timeoutMs = positiveInteger(request.timeoutMs ?? this.timeoutMs, this.timeoutMs, 'timeoutMs')
    const scope = makeAbortScope(timeoutMs, request.signal)
    try {
      await waitFor(request.delayMs ?? this.delayMs, scope.signal)
      let response
      if (this.handler) response = await raceWithSignal(this.handler(request, this.requests.length - 1), scope.signal)
      else if (this.responses.length) response = this.responses.shift()
      else throw new LLMError('У FakeLLM закончились ответы', 'FAKE_LLM_EXHAUSTED')
      if (response instanceof Error) throw response
      const message = normalizeAssistantMessage(fakeMessage(response), request, this)
      return { ...message, model: 'fake', usage: null, provider: 'FakeLLM' }
    } catch (error) {
      if (scope.timedOut()) throw new LLMTimeoutError(timeoutMs)
      if (error instanceof LLMError) throw error
      throw new LLMError('FakeLLM завершился ошибкой', 'FAKE_LLM_ERROR', { cause: error })
    } finally {
      scope.close()
    }
  }

  async completeJson(input, options = {}) {
    const result = await this.complete(input, { ...options, json: true })
    return result.json
  }
}

export {
  RouterAIClient as RouterAIAdapter,
  RouterAIClient as RouterAILLMClient,
  FakeLLM as FakeLLMClient,
  strictJsonParse as parseStrictJson,
}
