import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export const DEFAULT_RULE_PACKS_ROOT = join(projectRoot, 'data', 'rule_packs')
export const RULESET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/i
export const FORMALIZATION_LEVELS = new Set(['deterministic', 'structured', 'retrieval_only'])

const REQUIRED_RULE_FIELDS = [
  'id',
  'ruleset_id',
  'version',
  'kind',
  'section_path',
  'title_en',
  'title_ru',
  'text_en',
  'text_ru',
  'tags',
  'entity_refs',
  'aliases_en',
  'aliases_ru',
  'formalization_level',
  'source_page_start',
  'source_page_end',
  'source_hash',
  'license_id',
]

export class RulePackValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'RulePackValidationError'
    this.details = details
  }
}

function parseYamlScalar(raw) {
  const value = raw.trim()
  if (value === '') return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { throw new RulePackValidationError(`Invalid quoted YAML scalar: ${value}`) }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/**
 * Deliberately small YAML reader for the flat metadata files in a rule pack.
 * It accepts top-level scalar keys and top-level scalar lists, and rejects
 * unsupported nesting instead of silently guessing at the document shape.
 */
export function parseMetadataYaml(source, label = 'metadata.yaml') {
  const result = {}
  let listKey = null
  const lines = String(source).replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue

    const listItem = rawLine.match(/^\s{2}-\s+(.+)$/)
    if (listItem) {
      if (!listKey || !Array.isArray(result[listKey])) {
        throw new RulePackValidationError(`${label}:${index + 1}: list item has no top-level list key`)
      }
      result[listKey].push(parseYamlScalar(listItem[1]))
      continue
    }

    if (/^\s/.test(rawLine)) {
      throw new RulePackValidationError(`${label}:${index + 1}: nested YAML is not supported in rule-pack metadata`)
    }

    const entry = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/)
    if (!entry) throw new RulePackValidationError(`${label}:${index + 1}: invalid metadata entry`)
    const [, key, rawValue = ''] = entry
    if (Object.hasOwn(result, key)) throw new RulePackValidationError(`${label}:${index + 1}: duplicate key ${key}`)
    if (rawValue.trim() === '') {
      result[key] = []
      listKey = key
    } else {
      result[key] = parseYamlScalar(rawValue)
      listKey = null
    }
  }

  return result
}

function parseCsvRows(source, label) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const text = String(source).replace(/^\uFEFF/, '')

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
      continue
    }

    if (character === '"') {
      if (field) throw new RulePackValidationError(`${label}: quote inside an unquoted CSV field`)
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }

  if (quoted) throw new RulePackValidationError(`${label}: unterminated quoted CSV field`)
  row.push(field.replace(/\r$/, ''))
  if (row.some((value) => value !== '')) rows.push(row)
  return rows
}

export function parseGlossaryCsv(source, label = 'glossary.csv') {
  const rows = parseCsvRows(source, label)
  if (!rows.length) throw new RulePackValidationError(`${label}: glossary is empty`)
  const expectedHeaders = ['canonical_id', 'term_en', 'term_ru', 'aliases_ru', 'notes']
  if (rows[0].length !== expectedHeaders.length || rows[0].some((header, index) => header.trim() !== expectedHeaders[index])) {
    throw new RulePackValidationError(`${label}: expected header ${expectedHeaders.join(',')}`)
  }

  return rows.slice(1).map((values, index) => {
    if (values.length !== expectedHeaders.length) {
      throw new RulePackValidationError(`${label}:${index + 2}: expected ${expectedHeaders.length} columns, got ${values.length}`)
    }
    const entry = Object.fromEntries(expectedHeaders.map((header, column) => [header, values[column].trim()]))
    entry.aliases_ru = entry.aliases_ru.split('|').map((alias) => alias.trim()).filter(Boolean)
    return entry
  })
}

export function parseJsonLines(source, label = 'data.jsonl') {
  const entries = []
  const lines = String(source).replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entry must be an object')
      entries.push(entry)
    } catch (error) {
      throw new RulePackValidationError(`${label}:${index + 1}: invalid JSONL entry (${error instanceof Error ? error.message : 'parse error'})`)
    }
  }
  return entries
}

/**
 * Extracts translation-sensitive mechanical tokens. Sorting makes the check
 * independent from natural sentence order while preserving the multiset.
 */
export function extractMechanicalTokens(source) {
  const normalized = String(source)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/(\d),(\d)/g, '$1.$2')
  const pattern = /(?<![\p{L}\p{N}_])(?:\d+\s*d\s*\d+(?:\s*[+-]\s*\d+)?|d\s*\d+(?:\s*[+-]\s*\d+)?|\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*[x×]|[+-]?\d+(?:\.\d+)?)(?![\p{L}\p{N}_])/giu
  return [...normalized.matchAll(pattern)]
    .map(([token]) => token.replace(/\s+/g, '').replace('×', 'x'))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function multisetDifference(left, right) {
  const remaining = new Map()
  for (const token of right) remaining.set(token, (remaining.get(token) || 0) + 1)
  const difference = []
  for (const token of left) {
    const count = remaining.get(token) || 0
    if (count > 0) remaining.set(token, count - 1)
    else difference.push(token)
  }
  return difference
}

export function checkTranslationNumericIntegrity(sourceText, translatedText) {
  const sourceTokens = extractMechanicalTokens(sourceText)
  const translatedTokens = extractMechanicalTokens(translatedText)
  const missing = multisetDifference(sourceTokens, translatedTokens)
  const extra = multisetDifference(translatedTokens, sourceTokens)
  return { ok: missing.length === 0 && extra.length === 0, sourceTokens, translatedTokens, missing, extra }
}

export function assertTranslationNumericIntegrity(rule) {
  const check = checkTranslationNumericIntegrity(
    `${rule.title_en || ''}\n${rule.text_en || ''}`,
    `${rule.title_ru || ''}\n${rule.text_ru || ''}`,
  )
  if (!check.ok) {
    throw new RulePackValidationError(`Rule ${rule.id || '<unknown>'} changes mechanical numbers in translation`, {
      rule_id: rule.id,
      ...check,
    })
  }
  return check
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new RulePackValidationError(`${label} must be a non-empty string`)
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new RulePackValidationError(`${label} must be an array of non-empty strings`)
  }
}

function validateRule(rule, rulesetId, seenIds) {
  for (const field of REQUIRED_RULE_FIELDS) {
    if (!Object.hasOwn(rule, field)) throw new RulePackValidationError(`Rule ${rule.id || '<unknown>'} misses required field ${field}`)
  }
  assertString(rule.id, 'rule.id')
  if (seenIds.has(rule.id)) throw new RulePackValidationError(`Duplicate rule id ${rule.id}`)
  seenIds.add(rule.id)
  if (rule.ruleset_id !== rulesetId) {
    throw new RulePackValidationError(`Rule ${rule.id} belongs to ${rule.ruleset_id}, expected ${rulesetId}`)
  }
  if (!rule.id.startsWith(`${rulesetId}:`)) throw new RulePackValidationError(`Rule id ${rule.id} is not namespaced by ${rulesetId}`)
  for (const field of ['version', 'kind', 'title_en', 'title_ru', 'text_en', 'text_ru', 'source_hash', 'license_id']) {
    assertString(rule[field], `${rule.id}.${field}`)
  }
  for (const field of ['section_path', 'tags', 'entity_refs', 'aliases_en', 'aliases_ru']) {
    assertStringArray(rule[field], `${rule.id}.${field}`)
  }
  if (!FORMALIZATION_LEVELS.has(rule.formalization_level)) {
    throw new RulePackValidationError(`Rule ${rule.id} has unsupported formalization level ${rule.formalization_level}`)
  }
  if (!Number.isInteger(rule.source_page_start) || !Number.isInteger(rule.source_page_end) || rule.source_page_start < 0 || rule.source_page_end < rule.source_page_start) {
    throw new RulePackValidationError(`Rule ${rule.id} has invalid source page range`)
  }
  assertTranslationNumericIntegrity(rule)
}

export function validateRulePack(pack, { expectedRulesetId } = {}) {
  if (!pack || typeof pack !== 'object') throw new RulePackValidationError('Rule pack must be an object')
  const { manifest, rules, glossary, ontologyEdges, coverage } = pack
  if (!manifest || typeof manifest !== 'object') throw new RulePackValidationError('Rule pack has no manifest')
  const rulesetId = manifest.ruleset_id
  assertString(rulesetId, 'manifest.ruleset_id')
  if (!RULESET_ID_PATTERN.test(rulesetId)) throw new RulePackValidationError(`Invalid ruleset_id ${rulesetId}`)
  if (expectedRulesetId && rulesetId !== expectedRulesetId) {
    throw new RulePackValidationError(`Loaded ruleset ${rulesetId} does not match requested ${expectedRulesetId}`)
  }
  for (const field of ['pack_id', 'edition_family', 'version', 'canonical_language', 'license_id', 'created_at', 'verified_at']) {
    assertString(manifest[field], `manifest.${field}`)
  }
  if (manifest.canonical_language !== 'en') throw new RulePackValidationError('manifest.canonical_language must be en')
  assertStringArray(manifest.display_languages, 'manifest.display_languages')
  if (!manifest.display_languages.includes('ru') || !manifest.display_languages.includes('en')) {
    throw new RulePackValidationError('manifest.display_languages must include ru and en')
  }
  if (!Array.isArray(rules) || rules.length === 0) throw new RulePackValidationError('Rule pack must contain at least one rule')
  const seenIds = new Set()
  for (const rule of rules) validateRule(rule, rulesetId, seenIds)

  if (!Array.isArray(glossary)) throw new RulePackValidationError('Rule pack glossary must be an array')
  const glossaryIds = new Set()
  for (const entry of glossary) {
    assertString(entry.canonical_id, 'glossary.canonical_id')
    assertString(entry.term_en, `${entry.canonical_id}.term_en`)
    assertString(entry.term_ru, `${entry.canonical_id}.term_ru`)
    assertStringArray(entry.aliases_ru, `${entry.canonical_id}.aliases_ru`)
    if (glossaryIds.has(entry.canonical_id)) throw new RulePackValidationError(`Duplicate glossary id ${entry.canonical_id}`)
    glossaryIds.add(entry.canonical_id)
  }

  if (!Array.isArray(ontologyEdges)) throw new RulePackValidationError('Rule pack ontologyEdges must be an array')
  for (const edge of ontologyEdges) {
    if (edge.ruleset_id !== rulesetId) throw new RulePackValidationError(`Ontology edge mixes ${edge.ruleset_id} into ${rulesetId}`)
    if (!seenIds.has(edge.from_id) || !seenIds.has(edge.to_id)) {
      throw new RulePackValidationError(`Ontology edge ${edge.from_id} -> ${edge.to_id} references an unknown rule`)
    }
    assertString(edge.relation, 'ontology edge relation')
    if (typeof edge.weight !== 'number' || edge.weight <= 0 || edge.weight > 1) {
      throw new RulePackValidationError(`Ontology edge ${edge.from_id} -> ${edge.to_id} has invalid weight`)
    }
  }

  if (!coverage || typeof coverage !== 'object') throw new RulePackValidationError('Rule pack has no coverage metadata')
  if (coverage.ruleset_id !== rulesetId) throw new RulePackValidationError(`Coverage belongs to ${coverage.ruleset_id}, expected ${rulesetId}`)
  if (coverage.rule_count !== rules.length) throw new RulePackValidationError(`Coverage rule_count=${coverage.rule_count}, actual=${rules.length}`)
  if (coverage.glossary_term_count !== glossary.length) throw new RulePackValidationError(`Coverage glossary_term_count=${coverage.glossary_term_count}, actual=${glossary.length}`)
  if (coverage.ontology_edge_count !== ontologyEdges.length) throw new RulePackValidationError(`Coverage ontology_edge_count=${coverage.ontology_edge_count}, actual=${ontologyEdges.length}`)

  return {
    ruleset_id: rulesetId,
    pack_id: manifest.pack_id,
    rule_count: rules.length,
    glossary_term_count: glossary.length,
    ontology_edge_count: ontologyEdges.length,
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function resolvePackDirectory(rootDir, rulesetId) {
  if (!RULESET_ID_PATTERN.test(String(rulesetId || ''))) throw new RulePackValidationError(`Invalid ruleset_id ${rulesetId || '<empty>'}`)
  const root = resolve(rootDir)
  const directory = resolve(root, rulesetId)
  const pathFromRoot = relative(root, directory)
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    if (!pathFromRoot) return directory
    throw new RulePackValidationError(`ruleset_id escapes the rule-packs root: ${rulesetId}`)
  }
  return directory
}

export async function loadRulePack(rulesetId, { rootDir = DEFAULT_RULE_PACKS_ROOT, freeze = true } = {}) {
  const directory = resolvePackDirectory(rootDir, rulesetId)
  const files = ['manifest.yaml', 'glossary.csv', 'rules.jsonl', 'ontology_edges.jsonl', 'coverage.yaml']
  let contents
  try {
    contents = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
  } catch (error) {
    throw new RulePackValidationError(`Unable to read rule pack ${rulesetId}: ${error instanceof Error ? error.message : 'file error'}`, {
      ruleset_id: rulesetId,
      directory,
    })
  }

  const [manifestSource, glossarySource, rulesSource, ontologySource, coverageSource] = contents
  const pack = {
    directory,
    manifest: parseMetadataYaml(manifestSource, `${rulesetId}/manifest.yaml`),
    glossary: parseGlossaryCsv(glossarySource, `${rulesetId}/glossary.csv`),
    rules: parseJsonLines(rulesSource, `${rulesetId}/rules.jsonl`),
    ontologyEdges: parseJsonLines(ontologySource, `${rulesetId}/ontology_edges.jsonl`),
    coverage: parseMetadataYaml(coverageSource, `${rulesetId}/coverage.yaml`),
  }
  pack.summary = validateRulePack(pack, { expectedRulesetId: rulesetId })
  return freeze ? deepFreeze(pack) : pack
}

export async function loadRulePacks(rulesetIds, options = {}) {
  if (!Array.isArray(rulesetIds) || rulesetIds.length === 0) throw new RulePackValidationError('rulesetIds must be a non-empty array')
  if (new Set(rulesetIds).size !== rulesetIds.length) throw new RulePackValidationError('rulesetIds contains duplicates')
  return Promise.all(rulesetIds.map((rulesetId) => loadRulePack(rulesetId, options)))
}
