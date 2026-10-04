import assert from 'node:assert/strict'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { normalizeWorldMemory } from '../../../../server/world-memory.mjs'
import { turnResultForViewer } from '../../../../server/viewer-projection.mjs'

const FIXED_CLOCK = '2026-09-16T00:00:00.000Z'
const OUTPUT = resolve('docs/reviews/2026-10-04/round-7/33-memory-transport.json')
const ALIASES = ['knowledge_revealed', 'knowledge_ledger']
const HERO_A = 'hero-1'
const HERO_B = 'hero-2'
const sandbox = mkdtempSync(join(tmpdir(), 'skazanie-round7-memory-'))
process.once('exit', () => rmSync(sandbox, { recursive: true, force: true }))
const emptyEnv = join(sandbox, 'empty.env')
writeFileSync(emptyEnv, '', 'utf8')
process.env.DOTENV_CONFIG_PATH = emptyEnv
process.env.ROUTERAI_API_KEY = ''
const { DEFAULT_COUNTS, materializeLongState } = await import('../../../../eval/world-data-measurements.mjs')
const FIXTURE_COUNTS = Object.fromEntries(Object.entries(DEFAULT_COUNTS)
  .map(([key, value]) => [key, Math.max(1, Math.round(value * 0.2))]))

const clone = (value) => structuredClone(value)
const json = (value) => JSON.stringify(value)
const bytes = (value) => Buffer.byteLength(json(value), 'utf8')
const sha256 = (value) => createHash('sha256').update(json(value)).digest('hex')

function withoutAliases(value) {
  const copy = clone(value)
  const memory = copy?.authoritative_state?.worldMemory
  if (memory && typeof memory === 'object') {
    delete memory.knowledge_revealed
    delete memory.knowledge_ledger
  }
  return copy
}

function wireSizes(value) {
  const raw = Buffer.from(json(value), 'utf8')
  return {
    json_bytes: raw.byteLength,
    gzip_bytes: gzipSync(raw).byteLength,
    brotli_bytes: brotliCompressSync(raw).byteLength,
  }
}

function savings(full, compact) {
  return Object.fromEntries(Object.entries(full).map(([key, value]) => [
    key,
    { bytes: value - compact[key], percent: Number(((value - compact[key]) / value * 100).toFixed(3)) },
  ]))
}

function knowledgeIndex(entries) {
  const index = {}
  for (const entry of entries) {
    const heroId = String(entry.hero_id ?? '')
    const factId = String(entry.fact_id ?? '')
    if (!heroId || !factId) continue
    index[heroId] = [...new Set([...(index[heroId] ?? []), factId])]
  }
  return index
}

function canonicalState() {
  const state = materializeLongState(FIXTURE_COUNTS)
  const originalEntries = state.worldMemory.knowledge_ledger.map((entry, index) => ({
    ...entry,
    hero_id: index % 2 === 0 ? HERO_A : HERO_B,
  }))
  const privateFacts = [
    [HERO_A, 'fact:hero-a-private'],
    [HERO_B, 'fact:hero-b-private'],
  ].map(([heroId, id], index) => ({
    id, subject_id: 'npc:measurement-1', predicate: 'private_measurement',
    object: `Скрытая запись ${heroId}.`, summary: `Скрытая запись ${heroId}.`, visibility: 'gm_only',
    source_event_ids: [`event:${id}`], source_command_id: `command:${id}`, recorded_at_minutes: 20_000 + index,
    heroId,
  }))
  const unlearnedFacts = Array.from({ length: 64 }, (_, index) => ({
    id: `fact:unlearned-private-${index + 1}`, subject_id: 'npc:measurement-1', predicate: 'unlearned_measurement',
    object: `Нераскрытая запись ${index + 1}.`, summary: `Нераскрытая запись ${index + 1}.`, visibility: 'gm_only',
    source_event_ids: [`event:unlearned-${index + 1}`], source_command_id: `command:unlearned-${index + 1}`, recorded_at_minutes: 21_000 + index,
  }))
  const privateEntries = privateFacts.map(({ heroId, ...fact }, index) => ({
    id: `knowledge:${fact.id}`, hero_id: heroId, fact_id: fact.id, summary: fact.summary,
    source_event_ids: fact.source_event_ids, source_command_id: fact.source_command_id,
    revealed_event_id: fact.source_event_ids[0], source_kind: 'knowledge_revealed', recorded_at_minutes: fact.recorded_at_minutes,
    sequence: index,
  }))
  const entries = [...originalEntries, ...privateEntries]
  state.worldMemory = {
    ...state.worldMemory,
    facts: [...state.worldMemory.facts, ...privateFacts.map(({ heroId: _heroId, ...fact }) => fact), ...unlearnedFacts],
    knowledge: knowledgeIndex(entries),
    knowledge_ledger: entries,
    knowledge_revealed: entries,
  }
  return state
}

function visibilitySummary(memory, canonicalMemory, heroId, role) {
  const canonicalFacts = canonicalMemory.facts
  const projectedIds = new Set(memory.facts.map((fact) => fact.id))
  const canonicalHidden = canonicalFacts.filter((fact) => fact.visibility === 'gm_only')
  const hidden = canonicalHidden.filter((fact) => !projectedIds.has(fact.id))
  const knownHidden = canonicalHidden.filter((fact) => projectedIds.has(fact.id))
  return {
    role, hero_id: heroId,
    fact_count: memory.facts.length,
    gm_only_fact_count: memory.facts.filter((fact) => fact.visibility === 'gm_only').length,
    canonical_gm_only_fact_count: canonicalHidden.length,
    hidden_gm_only_fact_count: hidden.length,
    hidden_gm_only_fact_ids_sample: hidden.slice(0, 5).map((fact) => fact.id),
    known_gm_only_fact_ids: knownHidden.map((fact) => fact.id).filter((id) => id.startsWith('fact:hero-')),
    knowledge_entry_count: memory.knowledge_ledger.length,
    alias_equal: json(memory.knowledge_revealed) === json(memory.knowledge_ledger),
  }
}

function probeCase({ name, user, heroId }, canonical, canonicalHash) {
  const input = { state_version: 0, room_version: 1, mechanics: [], authoritative_state: canonical }
  const full = turnResultForViewer(input, user, heroId)
  assert.equal(sha256(canonical), canonicalHash, `${name}: viewer projection mutated canonical input`)
  const fullMemory = full.authoritative_state.worldMemory
  const canonicalMemory = canonical.worldMemory
  const fullWire = wireSizes(full)
  assert.deepEqual(fullMemory.knowledge_revealed, fullMemory.knowledge_ledger, `${name}: full aliases differ`)
  const privateFact = heroId === HERO_A ? 'fact:hero-a-private' : 'fact:hero-b-private'
  const otherPrivateFact = heroId === HERO_A ? 'fact:hero-b-private' : 'fact:hero-a-private'
  if (user.role === 'player') {
    assert.ok(fullMemory.facts.some((fact) => fact.id === privateFact), `${name}: own private fact was hidden`)
    assert.equal(fullMemory.facts.some((fact) => fact.id === otherPrivateFact), false, `${name}: other hero private fact leaked`)
    assert.equal(fullMemory.facts.some((fact) => fact.id === 'fact:unlearned-private-1'), false, `${name}: unlearned fact leaked`)
  } else {
    assert.ok(fullMemory.facts.some((fact) => fact.id === 'fact:hero-a-private'), 'admin: hero-a private fact missing')
    assert.ok(fullMemory.facts.some((fact) => fact.id === 'fact:hero-b-private'), 'admin: hero-b private fact missing')
    assert.ok(fullMemory.facts.some((fact) => fact.id === 'fact:unlearned-private-1'), 'admin: unlearned fact missing')
  }
  const noAlias = withoutAliases(full)
  const remainingHash = sha256(noAlias)
  const variants = {}
  for (const omittedAlias of ALIASES) {
    const compact = clone(full)
    delete compact.authoritative_state.worldMemory[omittedAlias]
    const retainedAlias = ALIASES.find((alias) => alias !== omittedAlias)
    const compactWire = wireSizes(compact)
    assert.deepEqual(withoutAliases(compact), noAlias, `${name}: omitted ${omittedAlias} changed another field`)
    assert.deepEqual(compact.authoritative_state.worldMemory[retainedAlias], fullMemory[retainedAlias], `${name}: retained alias changed`)
    const normalized = normalizeWorldMemory(compact.authoritative_state.worldMemory)
    const normalizedFull = normalizeWorldMemory(fullMemory)
    assert.deepEqual(normalized, normalizedFull, `${name}: normalizeWorldMemory did not reconstruct ${omittedAlias}`)
    variants[omittedAlias] = {
      wire: compactWire,
      savings: savings(fullWire, compactWire),
      omitted_alias: omittedAlias,
      retained_alias: retainedAlias,
      retained_alias_equal_full: true,
      remaining_fields_sha256: sha256(withoutAliases(compact)),
      remaining_fields_identity: sha256(withoutAliases(compact)) === remainingHash,
      normalize_world_memory_matches_full: json(normalized) === json(normalizedFull),
    }
  }
  return {
    name,
    visibility: visibilitySummary(fullMemory, canonicalMemory, heroId, user.role),
    full: {
      wire: fullWire,
      alias_array_bytes: Object.fromEntries(ALIASES.map((alias) => [alias, bytes(fullMemory[alias])])),
      remaining_fields_sha256: remainingHash,
    },
    variants,
  }
}

const canonical = canonicalState()
const canonicalHash = sha256(canonical)
const cases = [
  probeCase({ name: 'hero-a', user: { role: 'player', heroIds: [HERO_A] }, heroId: HERO_A }, canonical, canonicalHash),
  probeCase({ name: 'hero-b', user: { role: 'player', heroIds: [HERO_B] }, heroId: HERO_B }, canonical, canonicalHash),
  probeCase({ name: 'admin', user: { role: 'admin' }, heroId: HERO_A }, canonical, canonicalHash),
]

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  fixture_clock: FIXED_CLOCK,
  environment: { node: process.version, zlib: process.versions.zlib, brotli: process.versions.brotli ?? null, compression_options: 'node:zlib defaults' },
  decision: 'At the public transport boundary, retain one knowledge alias and reconstruct the other only when a consumer explicitly needs the compatibility shape.',
  scope: 'Full turnResultForViewer JSON envelope versus deleting exactly one worldMemory alias after viewer projection. gzip and Brotli are bounded wire-size estimates; no timing SLA is inferred.',
  source: {
    runtime_commit: 'cb045a8466f35696ff24abe9020d6f39dee89462',
    fixture: 'eval/world-data-measurements.mjs:materializeLongState',
    counts: FIXTURE_COUNTS,
    canonical_state_sha256: canonicalHash,
    no_http: true,
    no_llm: true,
    canonical_input_unchanged_after_each_projection: true,
  },
  cases,
  limitations: [
    'The probe does not change the server or client, and it does not prove replay compatibility for a persisted transport variant.',
    'normalize_world_memory_matches_full covers only the worldMemory normalizer; consumers still need an explicit alias policy.',
  ],
}

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
