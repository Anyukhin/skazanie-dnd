import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { projectVisibleState, redactTrace as redactSecurityTrace } from './security.mjs'

const SECRET_KEY = /(api[_-]?key|authorization|cookie|password|passwd|secret|session|token|environment|env)/i
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/

function safeId(value, label) {
  const id = String(value || '')
  if (!SAFE_ID.test(id)) throw new TypeError(`Некорректный ${label}`)
  return id
}

export function redactTrace(value, key = '', seen = new WeakSet()) {
  if (key === '') value = redactSecurityTrace(value)
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
      .replace(/(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      .slice(0, 4000)
  }
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.slice(0, 200).map((item) => redactTrace(item, key, seen))
    seen.delete(value)
    return result
  }
  const result = {}
  for (const [childKey, child] of Object.entries(value)) result[childKey] = redactTrace(child, childKey, seen)
  seen.delete(value)
  return result
}

function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

export class FileTraceStore {
  constructor({ rootDir }) {
    if (!rootDir) throw new TypeError('FileTraceStore требует rootDir')
    this.rootDir = resolve(rootDir)
    mkdirSync(this.rootDir, { recursive: true })
  }

  campaignDir(campaignId) {
    const directory = join(this.rootDir, safeId(campaignId, 'campaign_id'))
    mkdirSync(directory, { recursive: true })
    return directory
  }

  save(input) {
    const trace = redactTrace({
      turn_id: input.turn_id || randomUUID(),
      campaign_id: input.campaign_id,
      idempotency_key: input.idempotency_key ?? null,
      request_fingerprint: input.request_fingerprint ?? null,
      engine_mode: 'enforce',
      prompt_versions: input.prompt_versions ?? {},
      model_identifiers: input.model_identifiers ?? {},
      intent: input.intent ?? {},
      retrieval_queries: input.retrieval_queries ?? [],
      retrieved_rule_ids: input.retrieved_rule_ids ?? [],
      adjudication_plan: input.adjudication_plan ?? {},
      validated_commands: input.validated_commands ?? [],
      rolls: input.rolls ?? [],
      events: input.events ?? [],
      state_version_before: Number(input.state_version_before ?? 0),
      state_version_after: Number(input.state_version_after ?? input.state_version_before ?? 0),
      verification_result: input.verification_result ?? {},
      latency_ms: Number(input.latency_ms ?? 0),
      token_usage: input.token_usage ?? {},
      narration_result: input.narration_result ?? null,
      ruling: input.ruling ?? null,
      created_at: input.created_at || new Date().toISOString(),
    })
    safeId(trace.turn_id, 'turn_id')
    safeId(trace.campaign_id, 'campaign_id')
    atomicJson(join(this.campaignDir(trace.campaign_id), `${trace.turn_id}.json`), trace)
    return trace
  }

  get(campaignId, turnId) {
    const file = join(this.campaignDir(campaignId), `${safeId(turnId, 'turn_id')}.json`)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  latest(campaignId) {
    return this.recent(campaignId, 1)[0] ?? null
  }

  recent(campaignId, limit = 3) {
    const directory = this.campaignDir(campaignId)
    const boundedLimit = Math.max(1, Math.min(20, Number(limit) || 3))
    const traces = readdirSync(directory)
      .filter((name) => name.endsWith('.json') && SAFE_ID.test(name.slice(0, -5)))
      .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    return traces.slice(0, boundedLimit)
  }
}

/**
 * Версия схемы трассы. `v2` добавляет сквозной `proposal_id` и честные версии
 * промптов из реестра; `v1` остаётся читаемым — сохранённые трассы не
 * переписываются (шаг 8 `docs/agent-architecture-plan.md`).
 */
export const TURN_TRACE_SCHEMA_VERSION = 'turn-trace/v2'

/**
 * Приводит сохранённую трассу к форме v2 **на чтении**, не трогая файл. Так
 * `/why` одинаково отвечает и по старым кампаниям, и по новым.
 *
 * @param {Record<string, any> | null} trace
 * @returns {Record<string, any> | null}
 */
export function migrateTraceToV2(trace) {
  if (!trace || typeof trace !== 'object') return trace
  if (String(trace.schema_version ?? '') === TURN_TRACE_SCHEMA_VERSION) return trace
  return {
    ...trace,
    schema_version: TURN_TRACE_SCHEMA_VERSION,
    migrated_from: String(trace.schema_version ?? 'turn-trace/v1'),
    // У старых трасс сквозного идентификатора нет вовсе. Выдумывать его нельзя:
    // `/why` обязано отличать «предложение неизвестно» от «предложения не было».
    proposal_id: trace.proposal_id ?? null,
  }
}

export function buildTurnExplanation(trace, viewer = null) {
  if (!trace) return null
  const record = migrateTraceToV2(trace)
  const visible = (value, fallback) => viewer
    ? projectVisibleState(value, viewer) ?? fallback
    : value
  return {
    turn_id: record.turn_id,
    schema_version: record.schema_version,
    // Сквозной идентификатор предложения связывает то, что предложил агент, с
    // тем, что оставила политика и подтвердил сервер. У старых трасс его нет —
    // тогда здесь честный null, а не выдуманное значение.
    proposal_id: record.proposal_id ?? null,
    engine_mode: record.engine_mode,
    rules_used: record.retrieved_rule_ids ?? [],
    commands: visible(record.validated_commands ?? [], []),
    rolls: visible(record.rolls ?? [], []),
    events: visible(record.events ?? [], []),
    ruling: visible(record.ruling ?? null, null),
    state_version_before: record.state_version_before,
    state_version_after: record.state_version_after,
    verification: record.verification_result ?? {},
  }
}
