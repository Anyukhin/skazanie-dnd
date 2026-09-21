import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Cache-only verifier for the temporary dnd.su live audit.
 *
 * The live fetch was performed through the research web surface. This tool
 * deliberately reads only the resulting cache and never runs during the game.
 */

const args = process.argv.slice(2)
const cacheIndex = args.indexOf('--cache-dir')
const cacheDir = resolve(cacheIndex >= 0 ? args[cacheIndex + 1] : '')
const manifestName = args.includes('--manifest')
  ? args[args.indexOf('--manifest') + 1]
  : 'manifest-v6.json'

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function ndjson(path) {
  return (await readFile(path, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function normalizeSourceSchool(value) {
  return String(value ?? '')
    .replace(/\s*\(ритуал\)\s*$/iu, '')
    .trim()
    .toLocaleLowerCase('ru')
    .replace(/ё/gu, 'е')
}

async function main() {
  if (!cacheDir || cacheDir === resolve('.')) {
    throw new Error('Укажите --cache-dir <TEMP audit directory>')
  }
  const manifest = await json(join(cacheDir, manifestName))
  const baseManifest = await json(join(cacheDir, manifest.baseManifest ?? 'manifest.json'))
  const baseRows = []
  for (const chunk of baseManifest.factsChunks ?? []) baseRows.push(...await ndjson(join(cacheDir, chunk)))
  const retryRows = manifest.canonicalRetryManifest
    ? await ndjson(join(cacheDir, (await json(join(cacheDir, manifest.canonicalRetryManifest))).records))
    : []
  const byId = new Map(baseRows.map((row) => [row.id, row]))
  for (const row of retryRows) byId.set(row.id, { ...byId.get(row.id), ...row })
  const rows = [...byId.values()]
  const counts = Object.groupBy(rows, (row) => row.status)
  const mismatchCount = rows.filter((row) => (row.mismatches ?? []).some((mismatch) => (
    mismatch.field !== 'school'
      || normalizeSourceSchool(mismatch.source) !== normalizeSourceSchool(mismatch.local)
  ))).length
  const result = {
    ok: rows.length === manifest.total
      && (counts.observed?.length ?? 0) === manifest.actualReadCount
      && (counts.partial?.length ?? 0) === manifest.partialReadCount
      && (counts.unavailable?.length ?? 0) === manifest.unavailableCount,
    cacheDir,
    total: rows.length,
    actualReadCount: counts.observed?.length ?? 0,
    partialReadCount: counts.partial?.length ?? 0,
    unavailableCount: counts.unavailable?.length ?? 0,
    mismatchCardCount: manifest.metadataMismatchCount ?? mismatchCount,
    computedBaseMismatchCardCount: mismatchCount,
    ritualMismatchCount: manifest.ritualMismatchCount ?? null,
    retryRows: retryRows.length,
    network: 'disabled (cache-only)',
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.ok) process.exitCode = 1
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
