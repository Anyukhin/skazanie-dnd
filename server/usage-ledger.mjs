import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const LEDGER_SCHEMA_VERSION = 1
const DEFAULT_DAILY_TOKEN_LIMIT = 2_000_000
const DEFAULT_RETENTION_DAYS = 31
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000

export class UsageLedgerError extends Error {
  constructor(message, code = 'USAGE_LEDGER_ERROR', details = {}) {
    super(message)
    this.name = 'UsageLedgerError'
    this.code = code
    Object.assign(this, details)
  }
}

export class UsageQuotaExceededError extends UsageLedgerError {
  constructor(limit, used, requested) {
    super(`Daily LLM token quota exceeded: limit=${limit}, committed_or_reserved=${used}, requested=${requested}`, 'LLM_QUOTA_EXCEEDED', {
      daily_token_limit: limit,
      committed_or_reserved_tokens: used,
      requested_tokens: requested,
    })
  }
}

const positiveInteger = (value, fallback, label) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    if (fallback != null) return fallback
    throw new TypeError(`${label} must be a positive integer`)
  }
  return number
}

const clean = (value, maximum = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const dayKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10)

function emptyLedger() {
  return { schema_version: LEDGER_SCHEMA_VERSION, requests: {} }
}

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function safeTokenCount(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function safeCost(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

export function normalizeProviderUsage(usage = {}, fallbackTokens = 0) {
  const input = safeTokenCount(usage.input_tokens ?? usage.prompt_tokens)
  const output = safeTokenCount(usage.output_tokens ?? usage.completion_tokens)
  const total = safeTokenCount(usage.total_tokens) || input + output || safeTokenCount(fallbackTokens)
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    provider_cost: safeCost(usage.cost ?? usage.total_cost),
  }
}

export class DurableUsageLedger {
  constructor({
    storageFile,
    dailyTokenLimit = DEFAULT_DAILY_TOKEN_LIMIT,
    retentionDays = DEFAULT_RETENTION_DAYS,
    reservationTtlMs = DEFAULT_RESERVATION_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    if (!storageFile) throw new TypeError('DurableUsageLedger requires storageFile')
    this.storageFile = resolve(storageFile)
    this.dailyTokenLimit = positiveInteger(dailyTokenLimit, DEFAULT_DAILY_TOKEN_LIMIT, 'dailyTokenLimit')
    this.retentionDays = positiveInteger(retentionDays, DEFAULT_RETENTION_DAYS, 'retentionDays')
    this.reservationTtlMs = positiveInteger(reservationTtlMs, DEFAULT_RESERVATION_TTL_MS, 'reservationTtlMs')
    this.now = now
  }

  _read() {
    if (!existsSync(this.storageFile)) return emptyLedger()
    try {
      const value = JSON.parse(readFileSync(this.storageFile, 'utf8'))
      if (value?.schema_version !== LEDGER_SCHEMA_VERSION || !value.requests || typeof value.requests !== 'object' || Array.isArray(value.requests)) throw new Error('unsupported schema')
      return value
    } catch (error) {
      throw new UsageLedgerError(`Usage ledger is corrupt and will not be overwritten: ${this.storageFile}`, 'USAGE_LEDGER_CORRUPT', { cause: error })
    }
  }

  _prune(ledger, now) {
    const oldest = now - this.retentionDays * 24 * 60 * 60 * 1000
    for (const [id, entry] of Object.entries(ledger.requests)) {
      if (!Number.isFinite(Number(entry.created_at_ms)) || Number(entry.created_at_ms) < oldest) delete ledger.requests[id]
      else if (entry.status === 'reserved' && Number(entry.expires_at_ms) <= now) {
        entry.status = 'expired'
        entry.reserved_tokens = 0
        entry.finished_at_ms = now
      }
    }
    return ledger
  }

  _usedToday(ledger, now) {
    const day = dayKey(now)
    return Object.values(ledger.requests).filter((entry) => entry.day === day)
      .reduce((total, entry) => total + (entry.status === 'reserved' ? safeTokenCount(entry.reserved_tokens) : entry.status === 'completed' ? safeTokenCount(entry.total_tokens) : 0), 0)
  }

  reserve({
    requestId = randomUUID(),
    estimatedTokens,
    scope = 'global',
    model = 'unknown',
  } = {}) {
    const id = clean(requestId, 160)
    if (!id) throw new UsageLedgerError('Usage request id is required', 'USAGE_REQUEST_ID_INVALID')
    const requested = positiveInteger(estimatedTokens, null, 'estimatedTokens')
    const now = Number(this.now())
    const ledger = this._prune(this._read(), now)
    const existing = ledger.requests[id]
    if (existing) {
      if (existing.scope !== clean(scope, 120) || existing.model !== clean(model, 160) || existing.estimated_tokens !== requested) {
        throw new UsageLedgerError(`Usage request id ${id} was reused with different parameters`, 'USAGE_IDEMPOTENCY_CONFLICT')
      }
      return structuredClone(existing)
    }
    const used = this._usedToday(ledger, now)
    if (used + requested > this.dailyTokenLimit) throw new UsageQuotaExceededError(this.dailyTokenLimit, used, requested)
    const entry = {
      request_id: id,
      day: dayKey(now),
      scope: clean(scope, 120) || 'global',
      model: clean(model, 160) || 'unknown',
      status: 'reserved',
      estimated_tokens: requested,
      reserved_tokens: requested,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      provider_cost: 0,
      created_at_ms: now,
      expires_at_ms: now + this.reservationTtlMs,
      finished_at_ms: null,
      error_code: null,
    }
    ledger.requests[id] = entry
    atomicWrite(this.storageFile, ledger)
    return structuredClone(entry)
  }

  settle(requestId, usage = {}) {
    const id = clean(requestId, 160)
    const now = Number(this.now())
    const ledger = this._prune(this._read(), now)
    const entry = ledger.requests[id]
    if (!entry) throw new UsageLedgerError(`Unknown usage reservation ${id}`, 'USAGE_RESERVATION_NOT_FOUND')
    if (entry.status === 'completed') return structuredClone(entry)
    if (entry.status !== 'reserved') throw new UsageLedgerError(`Usage reservation ${id} is ${entry.status}`, 'USAGE_RESERVATION_CLOSED')
    const normalized = normalizeProviderUsage(usage, entry.estimated_tokens)
    Object.assign(entry, {
      status: 'completed',
      reserved_tokens: 0,
      ...normalized,
      finished_at_ms: now,
    })
    atomicWrite(this.storageFile, ledger)
    return structuredClone(entry)
  }

  fail(requestId, errorCode = 'LLM_ERROR') {
    const id = clean(requestId, 160)
    const now = Number(this.now())
    const ledger = this._prune(this._read(), now)
    const entry = ledger.requests[id]
    if (!entry) throw new UsageLedgerError(`Unknown usage reservation ${id}`, 'USAGE_RESERVATION_NOT_FOUND')
    if (entry.status !== 'reserved') return structuredClone(entry)
    Object.assign(entry, {
      status: 'failed',
      reserved_tokens: 0,
      finished_at_ms: now,
      error_code: clean(errorCode, 80) || 'LLM_ERROR',
    })
    atomicWrite(this.storageFile, ledger)
    return structuredClone(entry)
  }

  report() {
    const now = Number(this.now())
    const ledger = this._prune(this._read(), now)
    atomicWrite(this.storageFile, ledger)
    const day = dayKey(now)
    const entries = Object.values(ledger.requests).filter((entry) => entry.day === day)
    const completed = entries.filter((entry) => entry.status === 'completed')
    const reserved = entries.filter((entry) => entry.status === 'reserved')
    return {
      day,
      daily_token_limit: this.dailyTokenLimit,
      committed_tokens: completed.reduce((total, entry) => total + safeTokenCount(entry.total_tokens), 0),
      reserved_tokens: reserved.reduce((total, entry) => total + safeTokenCount(entry.reserved_tokens), 0),
      input_tokens: completed.reduce((total, entry) => total + safeTokenCount(entry.input_tokens), 0),
      output_tokens: completed.reduce((total, entry) => total + safeTokenCount(entry.output_tokens), 0),
      provider_cost: completed.reduce((total, entry) => total + safeCost(entry.provider_cost), 0),
      requests: entries.length,
      completed_requests: completed.length,
      failed_requests: entries.filter((entry) => entry.status === 'failed').length,
    }
  }
}

function estimatedInputTokens(input) {
  const request = Array.isArray(input) ? { messages: input } : input ?? {}
  // One token cannot encode more input units than the UTF-8 byte stream has
  // bytes. Reserving the full byte length is deliberately conservative and
  // prevents multilingual prompts from under-reserving the durable quota.
  return Math.max(1, Buffer.byteLength(JSON.stringify(request.messages ?? []), 'utf8'))
}

export class MeteredLLMClient {
  constructor({ client, ledger } = {}) {
    if (!client || typeof client.complete !== 'function' || !ledger) throw new TypeError('MeteredLLMClient requires client and ledger')
    this.client = client
    this.ledger = ledger
    this.model = client.model
    this.models = client.models
  }

  async complete(input, options = {}) {
    const request = Array.isArray(input) ? { messages: input } : input ?? {}
    const maximumOutput = positiveInteger(options.maxTokens ?? request.maxTokens ?? this.client.maxTokens, 1200, 'maxTokens')
    const requestId = clean(options.usageRequestId ?? request.usageRequestId, 160) || randomUUID()
    const reservation = this.ledger.reserve({
      requestId,
      estimatedTokens: estimatedInputTokens(input) + maximumOutput,
      scope: options.usageScope ?? request.usageScope ?? 'global',
      model: options.model ?? request.model ?? this.model,
    })
    try {
      const result = await this.client.complete(input, options)
      this.ledger.settle(reservation.request_id, result.usage ?? {})
      return result
    } catch (error) {
      this.ledger.fail(reservation.request_id, error?.code ?? error?.name ?? 'LLM_ERROR')
      throw error
    }
  }

  async completeJson(input, options = {}) {
    const result = await this.complete(input, { ...options, json: true })
    return result.json
  }

  probe() { return this.client.probe() }
  health() { return this.client.health() }
  usage() { return this.ledger.report() }
}
