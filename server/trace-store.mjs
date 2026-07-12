import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { redactTrace as redactSecurityTrace } from './security.mjs'

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
      engine_mode: input.engine_mode || 'legacy',
      prompt_versions: input.prompt_versions ?? {},
      model_identifiers: input.model_identifiers ?? {},
      intent: input.intent ?? {},
      retrieval_queries: input.retrieval_queries ?? [],
      retrieved_rule_ids: input.retrieved_rule_ids ?? [],
      adjudication_plan: input.adjudication_plan ?? {},
      validated_commands: input.validated_commands ?? [],
      rolls: input.rolls ?? [],
      events: input.events ?? [],
      shadow_comparison: input.shadow_comparison ?? null,
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
    const directory = this.campaignDir(campaignId)
    const traces = readdirSync(directory)
      .filter((name) => name.endsWith('.json') && SAFE_ID.test(name.slice(0, -5)))
      .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    return traces[0] ?? null
  }
}

export function buildTurnExplanation(trace) {
  if (!trace) return null
  return {
    turn_id: trace.turn_id,
    engine_mode: trace.engine_mode,
    rules_used: trace.retrieved_rule_ids ?? [],
    commands: trace.validated_commands ?? [],
    rolls: trace.rolls ?? [],
    events: trace.events ?? [],
    ruling: trace.ruling ?? null,
    state_version_before: trace.state_version_before,
    state_version_after: trace.state_version_after,
    verification: trace.verification_result ?? {},
    shadow_comparison: trace.shadow_comparison ?? null,
  }
}

export function compareShadowResults(legacyResult, engineResult) {
  const differences = []
  const legacyRoll = legacyResult?.effects?.roll
  const engineRoll = engineResult?.rolls?.[0]
  if (legacyRoll && engineRoll && Number(legacyRoll.total) !== Number(engineRoll.total)) differences.push({ field: 'roll.total', legacy: legacyRoll.total, engine: engineRoll.total })
  const legacyEffects = legacyResult?.effects ?? {}
  const engineEvents = engineResult?.events ?? []
  if ((legacyEffects.grantItems?.length ?? 0) !== engineEvents.filter((event) => event.event_type === 'ItemGranted').length) differences.push({ field: 'items' })
  if ((legacyEffects.reveal?.length ?? 0) !== engineEvents.filter((event) => event.event_type === 'AreaRevealed').reduce((sum, event) => sum + (event.payload?.cells?.length ?? 0), 0)) differences.push({ field: 'visibility' })
  return { differences, severity: differences.length ? 'warning' : 'info' }
}
