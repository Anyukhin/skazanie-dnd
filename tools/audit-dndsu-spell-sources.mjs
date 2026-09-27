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
const strictSemantic = args.includes('--strict-semantic')
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

const SOURCE_FACT_FIELDS = Object.freeze([
  'level', 'school', 'castingTime', 'rangeText', 'duration', 'classes',
  'descriptionText',
])
const OPTIONAL_SOURCE_FACT_FIELDS = Object.freeze(['sourceBooks'])
const SOURCE_HOSTS = new Set(['dnd.su', 'www.dnd.su', '5e14.dnd.su', 'www.5e14.dnd.su'])

const normalizeSourceText = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim()
  .toLocaleLowerCase('ru')
  .replace(/ё/gu, 'е')

function sourceUrlIsApproved(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname) && /^\/spells\//u.test(url.pathname) && !url.username && !url.password
  } catch {
    return false
  }
}

function validSourceObservation(row) {
  return row.status === 'observed'
    && sourceUrlIsApproved(row.sourceUrl)
    && typeof row.fetchedAt === 'string'
    && Number.isFinite(Date.parse(row.fetchedAt))
    && /^[a-f0-9]{8,16}$/iu.test(String(row.sourceHashFnv1a64 ?? ''))
    && typeof row.sourceTitle === 'string'
    && row.sourceTitle.trim().length > 0
}

/** Заголовок книги из наблюдённой title-строки; URL и полный текст страницы отбрасываются. */
export function sourceBookTitleFromRow(row) {
  const title = String(row?.sourceTitle ?? '').replace(/\s*\(https?:\/\/[^)]*\)\s*$/u, '').trim()
  const parts = title.split(/\s+\/\s+/u)
  return parts.length > 1 ? parts.at(-1).trim() : null
}

function normalizedSourceField(field, value) {
  if (field === 'school') return normalizeSourceSchool(value)
  if (field === 'level') return Number(value)
  return normalizeSourceText(value)
}

const SOURCE_HIGHER_LEVELS = /на больших уровнях|ячейк[а-яё]*[^.!?]{0,90}(?:выше|уровн)|за каждый уровень|при накладывании.*ячейк/iu
const LOCAL_HIGHER_LEVELS = /на больших уровнях|ячейк[а-яё]*[^.!?]{0,100}(?:выше|уровн|круг)|за каждый уровень|уровень ячейки|увелич(?:ивается|ивается)[^.!?]{0,80}(?:ячейк|уровн|круг)/iu

/** Возвращает только коды пробелов; полный текст source description не выводится. */
export function auditSourceSemanticFields({ rows, catalog, descriptions = null }) {
  const byId = new Map((catalog?.spells ?? []).map((spell) => [spell.id, spell]))
  const gaps = []
  for (const row of rows) {
    const spell = byId.get(row.id)
    if (!spell || row.status !== 'observed' || typeof row.sourceFacts?.descriptionText !== 'string') continue
    const localDescription = descriptions?.[row.id] ?? spell.description ?? ''
    const localHigherLevels = spell.higherLevels ?? localDescription
    if (SOURCE_HIGHER_LEVELS.test(row.sourceFacts.descriptionText) && !LOCAL_HIGHER_LEVELS.test(String(localHigherLevels))) {
      gaps.push({ id: row.id, code: 'HIGHER_LEVEL_SUMMARY_MISSING', fields: ['higherLevels'] })
    }
    if (/реакц/iu.test(String(row.sourceFacts.castingTime)) && !/реакц/iu.test(String(spell.castingTime))) {
      gaps.push({ id: row.id, code: 'REACTION_TRIGGER_MISSING', fields: ['castingTime'] })
    }
    if (row.sourceFacts.duration && !spell.duration) gaps.push({ id: row.id, code: 'DURATION_METADATA_MISSING', fields: ['duration'] })
  }
  return {
    gaps,
    counts: Object.fromEntries(Object.entries(Object.groupBy(gaps, (entry) => entry.code)).map(([code, entries]) => [code, entries.length])),
  }
}

/** Merge base and canonical retry rows without trusting duplicate cache records. */
export function mergeSourceAuditRows(baseRows, retryRows = []) {
  const byId = new Map(baseRows.map((row) => [row.id, row]))
  for (const row of retryRows) byId.set(row.id, { ...byId.get(row.id), ...row })
  return [...byId.values()]
}

/**
 * Проверяет не только счётчики manifest, но и полноту фактов каждой наблюдённой
 * карточки. Тексты страниц не возвращаются из отчёта: проверяется только их
 * наличие, хеш ответа и структурированные поля.
 */
export function auditSourceRows({ rows, manifest, catalog = null }) {
  const problems = []
  const factsMissing = []
  const optionalFactsMissing = []
  const sourceBookTitleMissing = []
  const metadataMismatches = []
  const sourceObservationGaps = []
  const catalogById = new Map((catalog?.spells ?? []).map((spell) => [spell.id, spell]))
  const seen = new Set()
  for (const row of rows) {
    const id = String(row?.id ?? '<unknown>')
    if (seen.has(id)) problems.push({ id, code: 'DUPLICATE_ID', message: 'Кэш содержит ID более одного раза после merge.' })
    seen.add(id)
    if (!validSourceObservation(row)) sourceObservationGaps.push(id)
    const missing = SOURCE_FACT_FIELDS.filter((field) => {
      const value = row?.sourceFacts?.[field]
      return field === 'level' ? !Number.isInteger(value) : typeof value !== 'string' || value.trim().length === 0
    })
    if (missing.length) factsMissing.push({ id, fields: missing })
    const optionalMissing = OPTIONAL_SOURCE_FACT_FIELDS.filter((field) => row?.sourceFacts?.[field] === undefined)
    if (optionalMissing.length) optionalFactsMissing.push({ id, fields: optionalMissing })
    if (!sourceBookTitleFromRow(row)) sourceBookTitleMissing.push(id)
    const local = catalogById.get(id)
    if (catalog && !local) problems.push({ id, code: 'UNKNOWN_ID', message: 'Кэш наблюдений содержит ID вне локального каталога.' })
    if (local) {
      if (row.sourceUrl !== local.sourceUrl) metadataMismatches.push({ id, field: 'sourceUrl', source: row.sourceUrl, local: local.sourceUrl })
      for (const field of ['level', 'school', 'castingTime', 'rangeText', 'duration']) {
        if (row.sourceFacts?.[field] === undefined) continue
        const sourceValue = normalizedSourceField(field, row.sourceFacts[field])
        const localValue = normalizedSourceField(field, local[field])
        if (sourceValue !== localValue && !(field === 'school' && sourceValue === normalizeSourceSchool(local[field]))) metadataMismatches.push({ id, field, source: row.sourceFacts[field], local: local[field] })
      }
    }
  }
  if (catalog) {
    for (const spell of catalog.spells ?? []) if (!seen.has(spell.id)) problems.push({ id: spell.id, code: 'MISSING_ID', message: 'Для карточки нет записи в source cache.' })
  }
  const counts = Object.groupBy(rows, (row) => row.status)
  const expectedTotal = manifest?.total ?? catalog?.spells?.length ?? rows.length
  return {
    ok: rows.length === expectedTotal
      && problems.length === 0
      && factsMissing.length === 0
      && metadataMismatches.length === 0
      && sourceObservationGaps.length === 0,
    total: rows.length,
    expectedTotal,
    actualReadCount: counts.observed?.length ?? 0,
    partialReadCount: counts.partial?.length ?? 0,
    unavailableCount: counts.unavailable?.length ?? 0,
    factsMissing,
    optionalFactsMissing,
    sourceBookTitleMissing,
    metadataMismatches,
    sourceObservationGaps,
    problems,
  }
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
  const catalog = args.includes('--catalog')
    ? await json(resolve(args[args.indexOf('--catalog') + 1]))
    : null
  const rows = mergeSourceAuditRows(baseRows, retryRows)
  const counts = Object.groupBy(rows, (row) => row.status)
  const mismatchCount = rows.filter((row) => (row.mismatches ?? []).some((mismatch) => (
    mismatch.field !== 'school'
      || normalizeSourceSchool(mismatch.source) !== normalizeSourceSchool(mismatch.local)
  ))).length
  const sourceAudit = auditSourceRows({ rows, manifest, catalog })
  const catalogDescriptions = catalog
    ? Object.fromEntries((catalog.spells ?? []).map((spell) => [spell.id, spell.description]))
    : null
  const semanticAudit = auditSourceSemanticFields({ rows, catalog, descriptions: catalogDescriptions })
  const result = {
    ok: sourceAudit.ok
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
    catalogChecked: Boolean(catalog),
    factsMissing: sourceAudit.factsMissing,
    optionalFactsMissing: sourceAudit.optionalFactsMissing,
    sourceBookTitleMissing: sourceAudit.sourceBookTitleMissing,
    sourceObservationGaps: sourceAudit.sourceObservationGaps,
    sourceMetadataMismatches: sourceAudit.metadataMismatches,
    sourceProblems: sourceAudit.problems,
    semanticGaps: semanticAudit.gaps,
    semanticGapCounts: semanticAudit.counts,
    network: 'disabled (cache-only)',
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.ok || (strictSemantic && semanticAudit.gaps.length > 0)) process.exitCode = 1
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
