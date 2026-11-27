import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GAME_REDUCER_VERSION,
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
} from '../server/rules-engine.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { MapStore } from '../server/map-store.mjs'

const COLLECTIONS = Object.freeze([
  'entities', 'facts', 'relationships', 'quests', 'threads', 'epistemic_claims', 'summaries', 'knowledge_ledger',
])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stateHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function realPathForNewOutput(path) {
  const suffix = []
  let current = path
  while (!existsSync(current)) {
    suffix.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) return path
    current = parent
  }
  return resolve(realpathSync(current), ...suffix)
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error('Неизвестный аргумент: ' + argument)
    const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error('Для ' + argument + ' нужен путь или ID')
    result[key] = value
    index += 1
  }
  for (const key of ['source', 'campaign', 'output']) if (!result[key]) throw new Error('Нужен аргумент --' + key)
  return result
}

function collectionDiff(sourceMemory, recoveredMemory) {
  return Object.fromEntries(COLLECTIONS.map((collection) => {
    const source = Array.isArray(sourceMemory?.[collection]) ? sourceMemory[collection] : []
    const recovered = Array.isArray(recoveredMemory?.[collection]) ? recoveredMemory[collection] : []
    const sourceIds = new Set(source.map((entry) => String(entry?.id ?? '')))
    const recoveredIds = new Set(recovered.map((entry) => String(entry?.id ?? '')))
    const sourceById = new Map(source.map((entry) => [String(entry?.id ?? ''), entry]))
    return [collection, {
      source_count: source.length,
      recovered_count: recovered.length,
      added_ids: recovered.filter((entry) => !sourceIds.has(String(entry?.id ?? ''))).map((entry) => entry.id),
      missing_ids: source.filter((entry) => !recoveredIds.has(String(entry?.id ?? ''))).map((entry) => entry.id),
      changed_ids: recovered.filter((entry) => sourceIds.has(String(entry?.id ?? ''))
        && stateHash(sourceById.get(String(entry?.id ?? ''))) !== stateHash(entry)).map((entry) => entry.id),
    }]
  }))
}

function rootDiff(sourceState, recoveredState) {
  const ignored = new Set(['state_version'])
  const roots = [...new Set([...Object.keys(sourceState ?? {}), ...Object.keys(recoveredState ?? {})])]
    .filter((key) => !ignored.has(key))
    .sort()
  const changed_roots = roots.filter((key) => stateHash(sourceState?.[key]) !== stateHash(recoveredState?.[key]))
  const expected_roots = ['worldMemory', 'social', 'npc_world']
  return {
    changed_roots,
    expected_roots,
    unexpected_root_differences: changed_roots.filter((key) => !expected_roots.includes(key)),
    has_unexpected_root_differences: changed_roots.some((key) => !expected_roots.includes(key)),
  }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function recoverWorldMemory({ source, campaign, output, maps = null }) {
  const sourceRoot = resolve(source)
  const outputRoot = resolve(output)
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) throw new Error('Каталог исходного хранилища не существует: ' + sourceRoot)
  const sourceReal = realpathSync(sourceRoot)
  if (sourceRoot === outputRoot) throw new Error('Каталог результата должен отличаться от исходного хранилища')
  const outputReal = realPathForNewOutput(outputRoot)
  const relativeOutput = relative(sourceReal, outputReal)
  if (relativeOutput !== '..' && !relativeOutput.startsWith('..' + sep) && !isAbsolute(relativeOutput)) {
    throw new Error('Каталог результата не может находиться внутри исходного хранилища')
  }
  if (existsSync(outputRoot)) throw new Error('Каталог результата уже существует: ' + outputRoot)
  mkdirSync(outputRoot, { recursive: true })
  const mapRoot = resolve(maps ?? sourceRoot)

  const store = new FileEventStore({
    rootDir: sourceRoot,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    reducerVersion: GAME_REDUCER_VERSION,
    mapStore: new MapStore({ rootDir: mapRoot }),
  })
  const legacy = await store.replay(campaign)
  const recovered = await store.replay(campaign, {
    use_snapshots: false,
    reducer_version: GAME_REDUCER_VERSION,
  })
  const sourceEvents = await store.getEvents(campaign)
  if (legacy.state_version !== recovered.state_version || legacy.state_version !== (sourceEvents.at(-1)?.state_version_after ?? 0)) {
    throw new Error('Хранилище изменилось во время проверки. Остановите запись и повторите аудит в новом каталоге.')
  }
  const diff = {
    world_memory: collectionDiff(legacy.state.worldMemory, recovered.state.worldMemory),
    roots: rootDiff(legacy.state, recovered.state),
  }
  const manifest = {
    schema_version: 'world-memory-recovery/v1',
    artifact_kind: 'read-only-preview',
    backup_required_before_apply: true,
    source_backup_not_created: true,
    source: sourceRoot,
    campaign_id: campaign,
    output: outputRoot,
    source_state_version: legacy.state_version,
    recovered_state_version: recovered.state_version,
    legacy_reducer_version: legacy.reducer_version,
    recovered_reducer_version: GAME_REDUCER_VERSION,
    source_event_count: sourceEvents.length,
    source_state_hash: stateHash(legacy.state),
    recovered_state_hash: stateHash(recovered.state),
    maps_root: mapRoot,
    diff,
    source_unchanged: true,
  }
  writeJson(join(outputRoot, 'source_state.json'), legacy.state)
  writeJson(join(outputRoot, 'source_events.json'), sourceEvents)
  writeJson(join(outputRoot, 'recovered_state.json'), recovered.state)
  writeJson(join(outputRoot, 'diff.json'), diff)
  writeJson(join(outputRoot, 'manifest.json'), manifest)
  return manifest
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const manifest = await recoverWorldMemory(parseArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  }
}
