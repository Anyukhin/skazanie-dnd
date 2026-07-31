import { LLMClient } from './contracts.mjs'
import { currentCampaignModel } from './campaign-ai-context.mjs'

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_TOOL_CALLS = 8
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000
export const ROUTERAI_STREAM_MAX_EVENT_BYTES = 64 * 1024
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

function optionalNumberInRange(value, minimum, maximum, label) {
  if (value == null) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} должен быть числом от ${minimum} до ${maximum}`)
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

async function* providerBodyChunks(body) {
  if (!body) throw new LLMResponseError('RouterAI returned an empty streaming body')
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (value != null) yield value
      }
    } finally {
      reader.releaseLock?.()
    }
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield chunk
    return
  }
  throw new LLMResponseError('RouterAI returned an unreadable streaming body')
}

function streamFrameSeparator(value) {
  const match = /\r?\n\r?\n/u.exec(value)
  return match ? { index: match.index, length: match[0].length } : null
}

/**
 * Строгий ограниченный SSE-парсер OpenAI-совместимого потока. Сырые дельты
 * провайдера не покидают адаптер: вызывающий код превращает их в проверенные снимки.
 */
export async function parseRouterAIEventStream(body, {
  onDelta = null,
  maxEventBytes = ROUTERAI_STREAM_MAX_EVENT_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const eventLimit = positiveInteger(maxEventBytes, ROUTERAI_STREAM_MAX_EVENT_BYTES, 'maxEventBytes')
  const responseLimit = positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let receivedBytes = 0
  let content = ''
  let model = null
  let usage = null
  let done = false

  const processFrame = async (frame) => {
    const dataLines = []
    for (const line of String(frame).split(/\r?\n/u)) {
      if (!line || line.startsWith(':')) continue
      if (line === 'data') dataLines.push('')
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''))
    }
    if (!dataLines.length) return
    const data = dataLines.join('\n')
    if (data.trim() === '[DONE]') {
      done = true
      return
    }
    const payload = strictJsonParse(data, {
      label: 'RouterAI SSE event',
      expected: 'object',
      maxBytes: eventLimit,
    })
    if (payload.error) {
      throw new LLMError('RouterAI stream returned an error event', 'LLM_PROVIDER_ERROR', {
        providerCode: String(payload.error?.code ?? '').slice(0, 80),
      })
    }
    if (payload.model != null) model = String(payload.model)
    if (payload.usage != null) usage = payload.usage
    const delta = payload.choices?.[0]?.delta
    if (delta?.tool_calls?.length || delta?.toolCalls?.length) {
      throw new LLMResponseError('Streaming tool calls are not supported', 'LLM_TOOL_CALL_INVALID')
    }
    if (delta?.content == null) return
    if (typeof delta.content !== 'string') {
      throw new LLMResponseError('RouterAI stream returned non-text content')
    }
    if (!delta.content) return
    if (byteLength(content) + byteLength(delta.content) > responseLimit) {
      throw new LLMResponseError(
        `RouterAI stream exceeds ${responseLimit} bytes`,
        'LLM_RESPONSE_TOO_LARGE',
      )
    }
    content += delta.content
    if (typeof onDelta === 'function') await onDelta(delta.content)
  }

  try {
    for await (const chunk of providerBodyChunks(body)) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      receivedBytes += bytes.byteLength
      if (receivedBytes > responseLimit) {
        throw new LLMResponseError(
          `RouterAI stream exceeds ${responseLimit} bytes`,
          'LLM_RESPONSE_TOO_LARGE',
        )
      }
      buffer += decoder.decode(bytes, { stream: true })
      let separator = streamFrameSeparator(buffer)
      while (separator) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        if (byteLength(frame) > eventLimit) {
          throw new LLMResponseError(
            `RouterAI SSE event exceeds ${eventLimit} bytes`,
            'LLM_RESPONSE_TOO_LARGE',
          )
        }
        await processFrame(frame)
        if (done) return { content, model, usage, done }
        separator = streamFrameSeparator(buffer)
      }
      if (byteLength(buffer) > eventLimit) {
        throw new LLMResponseError(
          `RouterAI SSE event exceeds ${eventLimit} bytes`,
          'LLM_RESPONSE_TOO_LARGE',
        )
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      if (byteLength(buffer) > eventLimit) {
        throw new LLMResponseError(
          `RouterAI SSE event exceeds ${eventLimit} bytes`,
          'LLM_RESPONSE_TOO_LARGE',
        )
      }
      await processFrame(buffer)
    }
    if (!done) {
      throw new LLMResponseError(
        'RouterAI stream ended before [DONE]',
        'LLM_STREAM_INCOMPLETE',
      )
    }
    return { content, model, usage, done }
  } catch (error) {
    if (error instanceof LLMError) throw error
    throw new LLMResponseError('RouterAI returned a malformed SSE stream', 'LLM_STREAM_INVALID', { cause: error })
  }
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
    const frequencyPenalty = optionalNumberInRange(request.frequencyPenalty ?? request.frequency_penalty, -2, 2, 'frequencyPenalty')
    const presencePenalty = optionalNumberInRange(request.presencePenalty ?? request.presence_penalty, -2, 2, 'presencePenalty')
    if (frequencyPenalty != null) body.frequency_penalty = frequencyPenalty
    if (presencePenalty != null) body.presence_penalty = presencePenalty
    if (Array.isArray(request.tools) && request.tools.length) {
      body.tools = request.tools
      body.tool_choice = request.toolChoice ?? request.tool_choice ?? 'auto'
    }
    const reasoning = request.reasoning && typeof request.reasoning === 'object' ? request.reasoning : this.reasoning
    if (reasoning) body.reasoning = reasoning
    if (wantsJson(request)) body.response_format = { type: 'json_object' }
    const streaming = typeof request.onDelta === 'function'
    if (streaming) {
      if (wantsJson(request)) throw new TypeError('Streaming JSON responses are not supported')
      body.stream = true
      body.stream_options = { include_usage: true }
    }

    try {
      const response = await raceWithSignal(this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: scope.signal,
      }), scope.signal)
      if (!response.ok) throw new LLMError(`RouterAI ответил HTTP ${response.status}`, 'LLM_PROVIDER_ERROR', { status: response.status })
      if (streaming) {
        const streamed = await raceWithSignal(parseRouterAIEventStream(response.body, {
          onDelta: request.onDelta,
          maxEventBytes: request.maxEventBytes ?? ROUTERAI_STREAM_MAX_EVENT_BYTES,
          maxResponseBytes: request.maxResponseBytes ?? this.maxResponseBytes,
        }), scope.signal)
        const message = normalizeAssistantMessage({
          role: 'assistant',
          content: streamed.content,
        }, request, this)
        return {
          ...message,
          model: streamed.model ?? body.model,
          usage: streamed.usage,
          provider: 'RouterAI',
          streamed: true,
        }
      }
      const payload = await raceWithSignal(readProviderBody(response, this.maxResponseBytes), scope.signal)
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
    const requestedDelta = options.onDelta ?? (input && !Array.isArray(input) ? input.onDelta : null)
    const attempts = []
    for (const client of this._candidates()) {
      let emitted = false
      const onDelta = typeof requestedDelta === 'function'
        ? async (delta) => {
            emitted = true
            await requestedDelta(delta)
          }
        : null
      try {
        const result = await client.complete(input, {
          ...options,
          ...(onDelta ? { onDelta } : {}),
        })
        if (typeof validateResponse === 'function' && await validateResponse(result) === false) {
          throw new LLMResponseError(`Model ${client.model} returned an unusable response`, 'LLM_RESPONSE_INVALID')
        }
        this._markSuccess(client)
        return { ...result, fallback_attempts: attempts, fallback_used: attempts.length > 0 }
      } catch (error) {
        if (!this._retryable(error)) throw error
        this._markFailure(client, error)
        attempts.push({ model: String(client.model ?? 'unknown-model'), code: String(error?.code ?? error?.name ?? 'LLM_ERROR') })
        // После первой показанной дельты другой провайдер не может продолжить
        // текст без склейки двух независимо сгенерированных ответов.
        if (emitted) throw error
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
