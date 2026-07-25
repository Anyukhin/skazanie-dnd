import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const STORE_SCHEMA_VERSION = 1
const EVENT_FILE = /^(\d{16})-(\d{16})-([a-zA-Z0-9-]+)\.json$/
const SNAPSHOT_FILE = /^(\d{16})\.json$/

export class EventStoreError extends Error {
  constructor(message, code = 'EVENT_STORE_ERROR', details = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    Object.assign(this, details)
  }
}

export class CampaignNotFoundError extends EventStoreError {
  constructor(campaignId) {
    super(`Campaign ${campaignId} is not initialized`, 'CAMPAIGN_NOT_FOUND', { campaign_id: campaignId })
  }
}

export class CampaignAlreadyInitializedError extends EventStoreError {
  constructor(campaignId, stateVersion) {
    super(`Campaign ${campaignId} is already initialized at state version ${stateVersion}`, 'CAMPAIGN_ALREADY_INITIALIZED', {
      campaign_id: campaignId,
      state_version: stateVersion,
    })
  }
}

export class VersionConflictError extends EventStoreError {
  constructor(campaignId, expected, actual) {
    super(`State version conflict for ${campaignId}: expected ${expected}, actual ${actual}`, 'STATE_VERSION_CONFLICT', {
      campaign_id: campaignId,
      expected_state_version: expected,
      actual_state_version: actual,
    })
  }
}

export class IdempotencyConflictError extends EventStoreError {
  constructor(campaignId, idempotencyKey) {
    super(`Idempotency key ${idempotencyKey} was already used with a different request`, 'IDEMPOTENCY_CONFLICT', {
      campaign_id: campaignId,
      idempotency_key: idempotencyKey,
    })
  }
}

export class CorruptEventLogError extends EventStoreError {
  constructor(campaignId, message, details = {}) {
    super(`Corrupt event log for ${campaignId}: ${message}`, 'CORRUPT_EVENT_LOG', { campaign_id: campaignId, ...details })
  }
}

export class StoreBusyError extends EventStoreError {
  constructor(campaignId) {
    super(`Campaign ${campaignId} is being committed by another process`, 'EVENT_STORE_BUSY', { campaign_id: campaignId })
  }
}

function jsonClone(value, label = 'value') {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('is not JSON serializable')
    return JSON.parse(encoded)
  } catch (error) {
    throw new EventStoreError(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_JSON_VALUE')
  }
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(sortObject(jsonClone(value)))
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function assertPlainState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new EventStoreError('Campaign state must be a JSON object', 'INVALID_CAMPAIGN_STATE')
  }
  return state
}

function versionedState(state, version) {
  return { ...assertPlainState(jsonClone(state, 'campaign state')), state_version: version }
}

function safeId(value, label, maximum = 200) {
  const result = String(value ?? '').trim()
  if (!result || result.length > maximum) throw new EventStoreError(`${label} is required and must be at most ${maximum} characters`, 'INVALID_IDENTIFIER')
  return result
}

function safeVersion(value, label) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new EventStoreError(`${label} must be a non-negative safe integer`, 'INVALID_STATE_VERSION')
  return result
}

function padVersion(value) {
  return String(safeVersion(value, 'state version')).padStart(16, '0')
}

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new EventStoreError('Clock returned an invalid date', 'INVALID_CLOCK')
  return date.toISOString()
}

function atomicWrite(file, value, { exclusive = false } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  if (exclusive && existsSync(file)) throw new EventStoreError(`Immutable file already exists: ${file}`, 'IMMUTABLE_FILE_EXISTS', { file })
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
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

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new EventStoreError(`Cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_STORE_FILE', { file })
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
}

function eventType(input) {
  const value = String(input?.event_type ?? input?.type ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new EventStoreError(`Invalid event_type: ${value || '<empty>'}`, 'INVALID_EVENT_TYPE')
  }
  return value
}

/**
 * Append-only, file-backed event store.
 *
 * The reducer is deliberately injected instead of importing rules-engine.mjs,
 * which keeps persistence independent from domain mechanics:
 *
 *   new FileEventStore({ rootDir, reducer: applyGameEvent,
 *     normalizeState: normalizeCampaignState })
 */
export class FileEventStore {
  constructor({
    rootDir,
    reducer,
    normalizeState = (state) => state,
    initialStateFactory = () => ({}),
    snapshotEvery = 25,
    snapshotProjectorVersion = 1,
    maxEventsPerCommit = 100,
    staleLockMs = 30_000,
    clock = () => new Date(),
    idFactory = () => randomUUID(),
  } = {}) {
    if (!rootDir) throw new EventStoreError('rootDir is required', 'INVALID_CONFIGURATION')
    if (typeof reducer !== 'function') throw new EventStoreError('A synchronous reducer(state, event) is required', 'INVALID_CONFIGURATION')
    if (typeof normalizeState !== 'function') throw new EventStoreError('normalizeState must be a function', 'INVALID_CONFIGURATION')
    if (typeof initialStateFactory !== 'function') throw new EventStoreError('initialStateFactory must be a function', 'INVALID_CONFIGURATION')
    const projectorVersion = Number(snapshotProjectorVersion)
    if (!Number.isSafeInteger(projectorVersion) || projectorVersion < 1) throw new EventStoreError('snapshotProjectorVersion must be a positive safe integer', 'INVALID_CONFIGURATION')
    this.rootDir = resolve(rootDir)
    this.reducer = reducer
    this.normalizeState = normalizeState
    this.initialStateFactory = initialStateFactory
    this.snapshotEvery = Math.max(0, Number(snapshotEvery) || 0)
    this.snapshotProjectorVersion = projectorVersion
    this.maxEventsPerCommit = Math.max(1, Number(maxEventsPerCommit) || 100)
    this.staleLockMs = Math.max(1_000, Number(staleLockMs) || 30_000)
    this.clock = clock
    this.idFactory = idFactory
  }

  _layout(campaignId) {
    const id = safeId(campaignId, 'campaign_id')
    const slug = id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'campaign'
    const key = `${slug}-${sha256(id).slice(0, 16)}`
    const directory = join(this.rootDir, 'campaigns', key)
    return {
      campaignId: id,
      directory,
      events: join(directory, 'events'),
      snapshots: join(directory, 'snapshots'),
      metadata: join(directory, 'metadata.json'),
      lock: join(directory, '.commit.lock'),
    }
  }

  _ensureLayout(layout) {
    mkdirSync(layout.events, { recursive: true })
    mkdirSync(layout.snapshots, { recursive: true })
  }

  _exists(layout) {
    if (existsSync(layout.metadata)) return true
    if (existsSync(layout.snapshots) && readdirSync(layout.snapshots).some((name) => SNAPSHOT_FILE.test(name))) return true
    return existsSync(layout.events) && readdirSync(layout.events).some((name) => EVENT_FILE.test(name))
  }

  _withLock(layout, operation) {
    this._ensureLayout(layout)
    let descriptor
    const acquire = () => {
      try {
        descriptor = openSync(layout.lock, 'wx', 0o600)
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquired_at: nowIso(this.clock) }), 'utf8')
        fsyncSync(descriptor)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(layout.lock).mtimeMs > this.staleLockMs) {
            unlinkSync(layout.lock)
            descriptor = openSync(layout.lock, 'wx', 0o600)
            writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquired_at: nowIso(this.clock) }), 'utf8')
            fsyncSync(descriptor)
            return
          }
        } catch (retryError) {
          if (retryError?.code !== 'ENOENT') throw retryError
        }
        if (descriptor === undefined) throw new StoreBusyError(layout.campaignId)
      }
    }

    acquire()
    try {
      return operation()
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* best effort */ }
      }
      try { if (existsSync(layout.lock)) unlinkSync(layout.lock) } catch { /* best effort */ }
    }
  }

  _normalizeState(state, version) {
    const normalized = this.normalizeState(jsonClone(state, 'campaign state'))
    if (normalized && typeof normalized.then === 'function') {
      throw new EventStoreError('normalizeState must be synchronous', 'ASYNC_REDUCER_NOT_SUPPORTED')
    }
    return versionedState(normalized, version)
  }

  _applyEvent(state, event) {
    if (event.event_type === 'LegacyStateImported' && event.payload?.state) {
      return this._normalizeState(event.payload.state, event.state_version_after)
    }
    const reduced = this.reducer(jsonClone(state, 'reducer state'), jsonClone(event, 'event'))
    if (reduced && typeof reduced.then === 'function') {
      throw new EventStoreError('Reducer must be synchronous', 'ASYNC_REDUCER_NOT_SUPPORTED')
    }
    if (reduced === undefined) throw new EventStoreError(`Reducer returned undefined for ${event.event_type}`, 'INVALID_REDUCER_RESULT')
    return this._normalizeState(reduced, event.state_version_after)
  }

  _readCommits(layout) {
    if (!existsSync(layout.events)) return []
    const files = readdirSync(layout.events)
      .map((name) => ({ name, match: name.match(EVENT_FILE) }))
      .filter((entry) => entry.match)
      .sort((left, right) => left.name.localeCompare(right.name))

    const commits = []
    let version = 0
    for (const { name, match } of files) {
      const commit = readJson(join(layout.events, name), 'event commit')
      const start = Number(match[1])
      const end = Number(match[2])
      if (commit.campaign_id !== layout.campaignId) throw new CorruptEventLogError(layout.campaignId, `${name} belongs to another campaign`)
      if (commit.state_version_before !== version || start !== version + 1) {
        throw new CorruptEventLogError(layout.campaignId, `non-contiguous commit ${name}`, { expected_state_version: version })
      }
      if (!Array.isArray(commit.events) || commit.events.length < 1 || end !== version + commit.events.length || commit.state_version_after !== end) {
        throw new CorruptEventLogError(layout.campaignId, `invalid version range in ${name}`)
      }
      for (let index = 0; index < commit.events.length; index += 1) {
        const event = commit.events[index]
        const before = version + index
        if (event.campaign_id !== layout.campaignId || event.state_version_before !== before || event.state_version_after !== before + 1) {
          throw new CorruptEventLogError(layout.campaignId, `invalid event version in ${name}`, { event_id: event.event_id })
        }
      }
      version = end
      commits.push(commit)
    }
    return commits
  }

  _readMetadata(layout, stateVersion = 0) {
    if (!existsSync(layout.metadata)) {
      return {
        schema_version: STORE_SCHEMA_VERSION,
        campaign_id: layout.campaignId,
        state_version: stateVersion,
        current_version: stateVersion,
        projection_checkpoint_version: 0,
      }
    }
    const metadata = readJson(layout.metadata, 'campaign metadata')
    if (metadata.campaign_id !== layout.campaignId) throw new CorruptEventLogError(layout.campaignId, 'metadata belongs to another campaign')
    return { ...metadata, state_version: stateVersion, current_version: stateVersion }
  }

  _writeMetadata(layout, current, patch, stateVersion) {
    const timestamp = nowIso(this.clock)
    const metadata = {
      schema_version: STORE_SCHEMA_VERSION,
      campaign_id: layout.campaignId,
      ruleset_id: 'srd_5_2_1',
      ruleset_version: '5.2.1',
      enabled_rule_packs: ['srd_5_2_1'],
      enabled_house_rules: [],
      created_at: current?.created_at ?? timestamp,
      ...current,
      ...jsonClone(patch ?? {}, 'metadata'),
      schema_version: STORE_SCHEMA_VERSION,
      campaign_id: layout.campaignId,
      state_version: stateVersion,
      current_version: stateVersion,
      projection_checkpoint_version: Math.max(
        0,
        Math.min(stateVersion, Number(patch?.projection_checkpoint_version ?? current?.projection_checkpoint_version) || 0),
      ),
      updated_at: timestamp,
    }
    atomicWrite(layout.metadata, metadata)
    return metadata
  }

  _readSnapshot(layout, targetVersion, useSnapshots = true) {
    if (!existsSync(layout.snapshots)) return null
    const candidates = readdirSync(layout.snapshots)
      .map((name) => ({ name, match: name.match(SNAPSHOT_FILE) }))
      .filter((entry) => entry.match && Number(entry.match[1]) <= targetVersion && (useSnapshots || Number(entry.match[1]) === 0))
      .sort((left, right) => right.name.localeCompare(left.name))
    if (!candidates.length) return null
    for (const candidate of candidates) {
      const file = join(layout.snapshots, candidate.name)
      const snapshot = readJson(file, 'snapshot')
      const version = Number(candidate.match[1])
      if (snapshot.campaign_id !== layout.campaignId || snapshot.state_version !== version) {
        throw new CorruptEventLogError(layout.campaignId, `invalid snapshot ${candidate.name}`)
      }
      if (snapshot.checksum !== sha256(snapshot.state)) {
        throw new CorruptEventLogError(layout.campaignId, `snapshot checksum mismatch ${candidate.name}`)
      }
      const projectorVersion = Number(snapshot.projector_version ?? 1)
      if (version === 0 || projectorVersion === this.snapshotProjectorVersion) return snapshot
    }
    return null
  }

  _writeSnapshot(layout, state, stateVersion) {
    const file = join(layout.snapshots, `${padVersion(stateVersion)}.json`)
    const normalized = this._normalizeState(state, stateVersion)
    const snapshot = {
      schema_version: STORE_SCHEMA_VERSION,
      projector_version: this.snapshotProjectorVersion,
      campaign_id: layout.campaignId,
      state_version: stateVersion,
      created_at: nowIso(this.clock),
      checksum: sha256(normalized),
      state: normalized,
    }
    if (existsSync(file)) {
      const existing = readJson(file, 'snapshot')
      if (existing.checksum !== snapshot.checksum) throw new CorruptEventLogError(layout.campaignId, `conflicting immutable snapshot ${basename(file)}`)
      return existing
    }
    atomicWrite(file, snapshot, { exclusive: true })
    return snapshot
  }

  _load(layout, { atVersion, useSnapshots = true } = {}) {
    const commits = this._readCommits(layout)
    if (!this._exists(layout)) throw new CampaignNotFoundError(layout.campaignId)
    const currentVersion = commits.at(-1)?.state_version_after ?? 0
    const targetVersion = atVersion === undefined ? currentVersion : safeVersion(atVersion, 'atVersion')
    if (targetVersion > currentVersion) throw new VersionConflictError(layout.campaignId, targetVersion, currentVersion)

    const snapshot = this._readSnapshot(layout, targetVersion, useSnapshots)
    let state
    let fromVersion
    if (snapshot) {
      state = this._normalizeState(snapshot.state, snapshot.state_version)
      fromVersion = snapshot.state_version
    } else {
      state = this._normalizeState(this.initialStateFactory(layout.campaignId), 0)
      fromVersion = 0
    }

    const events = commits.flatMap((commit) => commit.events)
      .filter((event) => event.state_version_after > fromVersion && event.state_version_after <= targetVersion)
    for (const event of events) state = this._applyEvent(state, event)

    return {
      campaign_id: layout.campaignId,
      state_version: targetVersion,
      current_state_version: currentVersion,
      state: this._normalizeState(state, targetVersion),
      metadata: this._readMetadata(layout, currentVersion),
      events_applied: events.length,
    }
  }

  _normalizeEvent(rawEvent, campaignId, commandId, idempotencyKey, before, timestamp) {
    const input = jsonClone(rawEvent, 'event')
    const type = eventType(input)
    const eventId = safeId(input.event_id ?? input.eventId ?? this.idFactory(), 'event_id')
    return {
      ...input,
      event_id: eventId,
      campaign_id: campaignId,
      command_id: commandId,
      idempotency_key: idempotencyKey,
      event_type: type,
      actor_id: input.actor_id ?? null,
      target_ids: uniqueStrings(input.target_ids),
      payload: jsonClone(input.payload ?? {}, 'event payload'),
      source_rule_ids: uniqueStrings(input.source_rule_ids),
      ruling_id: input.ruling_id ?? null,
      state_version_before: before,
      state_version_after: before + 1,
      created_at: input.created_at ?? timestamp,
    }
  }

  _commitFile(layout, commit) {
    const start = commit.state_version_before + 1
    const file = join(layout.events, `${padVersion(start)}-${padVersion(commit.state_version_after)}-${commit.commit_id}.json`)
    atomicWrite(file, commit, { exclusive: true })
    return file
  }

  async initializeCampaign({
    campaignId,
    campaign_id,
    initialState = {},
    initial_state,
    rulesetId = 'srd_5_2_1',
    ruleset_id,
    rulesetVersion = '5.2.1',
    ruleset_version,
    enabledRulePacks = ['srd_5_2_1'],
    enabled_rule_packs,
    enabledHouseRules = [],
    enabled_house_rules,
    metadata = {},
  } = {}) {
    const layout = this._layout(campaignId ?? campaign_id)
    return this._withLock(layout, () => {
      const requested = this._normalizeState(initial_state ?? initialState, 0)
      if (this._exists(layout)) {
        const existing = this._load(layout, { atVersion: 0, useSnapshots: false })
        if (sha256(existing.state) !== sha256(requested)) throw new CampaignAlreadyInitializedError(layout.campaignId, existing.current_state_version)
        return { ...existing, initialized: false }
      }
      this._writeSnapshot(layout, requested, 0)
      const storedMetadata = this._writeMetadata(layout, null, {
        ...metadata,
        ruleset_id: ruleset_id ?? rulesetId,
        ruleset_version: ruleset_version ?? rulesetVersion,
        enabled_rule_packs: enabled_rule_packs ?? enabledRulePacks,
        enabled_house_rules: enabled_house_rules ?? enabledHouseRules,
      }, 0)
      return {
        campaign_id: layout.campaignId,
        state_version: 0,
        current_state_version: 0,
        state: requested,
        metadata: storedMetadata,
        initialized: true,
      }
    })
  }

  async importLegacySnapshot({
    campaignId,
    campaign_id,
    legacyState,
    legacy_state,
    state,
    idempotencyKey,
    idempotency_key,
    commandId,
    command_id,
    source = 'legacy_room_snapshot',
    rulesetId = 'srd_5_2_1',
    ruleset_id,
    rulesetVersion = '5.2.1',
    ruleset_version,
    enabledRulePacks = ['srd_5_2_1'],
    enabled_rule_packs,
    enabledHouseRules = [],
    enabled_house_rules,
  } = {}) {
    const layout = this._layout(campaignId ?? campaign_id)
    const key = safeId(idempotencyKey ?? idempotency_key ?? `legacy-import:${layout.campaignId}`, 'idempotency_key')
    return this._withLock(layout, () => {
      const commits = this._readCommits(layout)
      const imported = this._normalizeState(legacy_state ?? legacyState ?? state, 1)
      const legacyHash = sha256({ ...imported, state_version: 0 })
      const duplicate = commits.find((commit) => commit.idempotency_key === key)
      if (duplicate) {
        if (duplicate.legacy_state_hash !== legacyHash) throw new IdempotencyConflictError(layout.campaignId, key)
        const loaded = this._load(layout, { atVersion: duplicate.state_version_after })
        return { ...loaded, events: jsonClone(duplicate.events), duplicate: true, idempotency_key: key, command_id: duplicate.command_id }
      }
      const currentVersion = commits.at(-1)?.state_version_after ?? 0
      if (currentVersion !== 0) throw new CampaignAlreadyInitializedError(layout.campaignId, currentVersion)

      if (!this._readSnapshot(layout, 0, false)) {
        this._writeSnapshot(layout, this._normalizeState(this.initialStateFactory(layout.campaignId), 0), 0)
      }
      const timestamp = nowIso(this.clock)
      const resolvedCommandId = safeId(commandId ?? command_id ?? this.idFactory(), 'command_id')
      const event = this._normalizeEvent({
        event_type: 'LegacyStateImported',
        payload: { state: { ...imported, state_version: 0 }, source, legacy_state_hash: legacyHash },
      }, layout.campaignId, resolvedCommandId, key, 0, timestamp)
      const commit = {
        schema_version: STORE_SCHEMA_VERSION,
        commit_id: safeId(this.idFactory(), 'commit_id'),
        campaign_id: layout.campaignId,
        command_id: resolvedCommandId,
        idempotency_key: key,
        request_hash: sha256({ source, legacy_state_hash: legacyHash }),
        legacy_state_hash: legacyHash,
        state_version_before: 0,
        state_version_after: 1,
        created_at: timestamp,
        events: [event],
        projection_outbox: {
          schema_version: 1,
          target: 'compatibility-room',
          state_version_after: 1,
        },
      }
      this._commitFile(layout, commit)
      this._writeSnapshot(layout, imported, 1)
      const currentMetadata = this._readMetadata(layout, 0)
      const storedMetadata = this._writeMetadata(layout, currentMetadata, {
        ruleset_id: ruleset_id ?? rulesetId,
        ruleset_version: ruleset_version ?? rulesetVersion,
        enabled_rule_packs: enabled_rule_packs ?? enabledRulePacks,
        enabled_house_rules: enabled_house_rules ?? enabledHouseRules,
        legacy_imported_at: timestamp,
      }, 1)
      return {
        campaign_id: layout.campaignId,
        state_version: 1,
        current_state_version: 1,
        state: imported,
        metadata: storedMetadata,
        events: [event],
        duplicate: false,
        idempotency_key: key,
        command_id: resolvedCommandId,
      }
    })
  }

  async commit({
    campaignId,
    campaign_id,
    expectedStateVersion,
    expected_state_version,
    idempotencyKey,
    idempotency_key,
    commandId,
    command_id,
    events,
    forceSnapshot = false,
    force_snapshot,
    metadata = {},
  } = {}) {
    const layout = this._layout(campaignId ?? campaign_id)
    const expected = safeVersion(expectedStateVersion ?? expected_state_version, 'expected_state_version')
    const key = safeId(idempotencyKey ?? idempotency_key, 'idempotency_key')
    const requestedEvents = jsonClone(events, 'events')
    if (!Array.isArray(requestedEvents) || requestedEvents.length < 1 || requestedEvents.length > this.maxEventsPerCommit) {
      throw new EventStoreError(`events must contain 1-${this.maxEventsPerCommit} entries`, 'INVALID_EVENT_BATCH')
    }
    const requestedCommandId = commandId ?? command_id ?? null
    const requestHash = sha256({ command_id: requestedCommandId, events: requestedEvents })

    return this._withLock(layout, () => {
      if (!this._exists(layout)) {
        const initial = this._normalizeState(this.initialStateFactory(layout.campaignId), 0)
        this._writeSnapshot(layout, initial, 0)
        this._writeMetadata(layout, null, {}, 0)
      }
      const commits = this._readCommits(layout)
      const duplicate = commits.find((item) => item.idempotency_key === key)
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw new IdempotencyConflictError(layout.campaignId, key)
        const loaded = this._load(layout, { atVersion: duplicate.state_version_after })
        return {
          ...loaded,
          events: jsonClone(duplicate.events),
          duplicate: true,
          idempotency_key: key,
          command_id: duplicate.command_id,
        }
      }

      const actual = commits.at(-1)?.state_version_after ?? 0
      if (expected !== actual) throw new VersionConflictError(layout.campaignId, expected, actual)
      const current = this._load(layout)
      const timestamp = nowIso(this.clock)
      const resolvedCommandId = safeId(requestedCommandId ?? this.idFactory(), 'command_id')
      const normalizedEvents = requestedEvents.map((event, index) => this._normalizeEvent(
        event,
        layout.campaignId,
        resolvedCommandId,
        key,
        actual + index,
        timestamp,
      ))
      let nextState = current.state
      for (const event of normalizedEvents) nextState = this._applyEvent(nextState, event)
      const nextVersion = actual + normalizedEvents.length
      nextState = this._normalizeState(nextState, nextVersion)

      const commit = {
        schema_version: STORE_SCHEMA_VERSION,
        commit_id: safeId(this.idFactory(), 'commit_id'),
        campaign_id: layout.campaignId,
        command_id: resolvedCommandId,
        idempotency_key: key,
        request_hash: requestHash,
        state_version_before: actual,
        state_version_after: nextVersion,
        created_at: timestamp,
        events: normalizedEvents,
        projection_outbox: {
          schema_version: 1,
          target: 'compatibility-room',
          state_version_after: nextVersion,
        },
      }
      this._commitFile(layout, commit)
      if ((force_snapshot ?? forceSnapshot) || (this.snapshotEvery > 0 && nextVersion % this.snapshotEvery === 0)) {
        this._writeSnapshot(layout, nextState, nextVersion)
      }
      const storedMetadata = this._writeMetadata(layout, current.metadata, metadata, nextVersion)
      return {
        campaign_id: layout.campaignId,
        state_version: nextVersion,
        current_state_version: nextVersion,
        state: nextState,
        metadata: storedMetadata,
        events: normalizedEvents,
        duplicate: false,
        idempotency_key: key,
        command_id: resolvedCommandId,
      }
    })
  }

  async load(campaignId, options = {}) {
    return this._load(this._layout(campaignId), options)
  }

  async getByIdempotencyKey(campaignId, idempotencyKey) {
    const layout = this._layout(campaignId)
    if (!this._exists(layout)) return null
    const key = safeId(idempotencyKey, 'idempotency_key')
    const commit = this._readCommits(layout).find((item) => item.idempotency_key === key)
    if (!commit) return null
    const loaded = this._load(layout, { atVersion: commit.state_version_after })
    return {
      ...loaded,
      events: jsonClone(commit.events),
      duplicate: true,
      idempotency_key: key,
      command_id: commit.command_id,
    }
  }

  async replay(campaignId, { atVersion, at_version, useSnapshots = true, use_snapshots } = {}) {
    return this._load(this._layout(campaignId), {
      atVersion: atVersion ?? at_version,
      useSnapshots: use_snapshots ?? useSnapshots,
    })
  }

  async getEvents(campaignId, {
    afterVersion = 0,
    after_version,
    upToVersion = Number.MAX_SAFE_INTEGER,
    up_to_version,
  } = {}) {
    const layout = this._layout(campaignId)
    if (!this._exists(layout)) throw new CampaignNotFoundError(layout.campaignId)
    const after = safeVersion(after_version ?? afterVersion, 'after_version')
    const upTo = safeVersion(up_to_version ?? upToVersion, 'up_to_version')
    return this._readCommits(layout).flatMap((commit) => commit.events)
      .filter((event) => event.state_version_after > after && event.state_version_after <= upTo)
      .map((event) => jsonClone(event))
  }

  async createSnapshot(campaignId) {
    const layout = this._layout(campaignId)
    return this._withLock(layout, () => {
      const loaded = this._load(layout)
      const snapshot = this._writeSnapshot(layout, loaded.state, loaded.state_version)
      return { campaign_id: layout.campaignId, state_version: loaded.state_version, snapshot: jsonClone(snapshot) }
    })
  }

  async getMetadata(campaignId) {
    const layout = this._layout(campaignId)
    if (!this._exists(layout)) throw new CampaignNotFoundError(layout.campaignId)
    const commits = this._readCommits(layout)
    const stateVersion = commits.at(-1)?.state_version_after ?? 0
    return jsonClone(this._readMetadata(layout, stateVersion))
  }

  async pendingProjection(campaignId) {
    const layout = this._layout(campaignId)
    if (!this._exists(layout)) throw new CampaignNotFoundError(layout.campaignId)
    const commits = this._readCommits(layout)
    const currentVersion = commits.at(-1)?.state_version_after ?? 0
    const metadata = this._readMetadata(layout, currentVersion)
    const checkpoint = Math.max(0, Math.min(currentVersion, Number(metadata.projection_checkpoint_version) || 0))
    if (checkpoint >= currentVersion) return null
    const loaded = this._load(layout)
    const events = commits
      .filter((commit) => commit.state_version_after > checkpoint)
      .flatMap((commit) => commit.events)
    return {
      campaign_id: layout.campaignId,
      checkpoint_version: checkpoint,
      state_version: currentVersion,
      state: loaded.state,
      events: jsonClone(events),
    }
  }

  async acknowledgeProjection(campaignId, projectedVersion, { projectionHash = null, projection_hash } = {}) {
    const layout = this._layout(campaignId)
    const requested = safeVersion(projectedVersion, 'projected_version')
    return this._withLock(layout, () => {
      const commits = this._readCommits(layout)
      const currentVersion = commits.at(-1)?.state_version_after ?? 0
      if (requested > currentVersion) throw new VersionConflictError(layout.campaignId, requested, currentVersion)
      const metadata = this._readMetadata(layout, currentVersion)
      const checkpoint = Math.max(Number(metadata.projection_checkpoint_version) || 0, requested)
      return jsonClone(this._writeMetadata(layout, metadata, {
        projection_checkpoint_version: checkpoint,
        projection_checkpoint_at: nowIso(this.clock),
        projection_checkpoint_hash: projection_hash ?? projectionHash ?? metadata.projection_checkpoint_hash ?? null,
      }, currentVersion))
    })
  }
}

export function createFileEventStore(options) {
  return new FileEventStore(options)
}

export { STORE_SCHEMA_VERSION }
