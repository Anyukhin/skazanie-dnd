import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { combatClassCatalogInfo } from './combat-actions.mjs'
import { spellCatalogInfo } from './combat-spells.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from './encounter-assembler.mjs'
import { ITEM_CATALOG, ITEM_SHOP_CATALOG_IDS } from './item-catalog.mjs'
import { loadRulePack } from './rule-pack.mjs'
import { backgroundCatalogInfo } from './backgrounds.mjs'
import { characterCreationOriginCatalogInfo } from './character-creation-catalog.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA256 = /^[a-f0-9]{64}$/u
const COVERAGE = new Set(['complete', 'partial', 'missing'])
const RIGHTS = new Set(['verified', 'cleared', 'project_license_required', 'review_required', 'blocked'])

export class ContentIntegrityError extends Error {
  constructor(message, code = 'CONTENT_INTEGRITY_ERROR', details = {}) {
    super(message)
    this.name = 'ContentIntegrityError'
    this.code = code
    Object.assign(this, details)
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ContentIntegrityError(`Cannot read JSON ${file}: ${error instanceof Error ? error.message : String(error)}`, 'CONTENT_MANIFEST_INVALID')
  }
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function safeProjectFile(rootDir, relativePath) {
  const normalized = String(relativePath ?? '').replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new ContentIntegrityError(`Unsafe artifact path: ${relativePath}`, 'CONTENT_PATH_INVALID')
  }
  const absolute = resolve(rootDir, normalized)
  const rel = relative(resolve(rootDir), absolute)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new ContentIntegrityError(`Artifact escapes project root: ${relativePath}`, 'CONTENT_PATH_INVALID')
  }
  return absolute
}

export function verifyDeclaredArtifact(rootDir, artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new ContentIntegrityError('Artifact declaration must be an object', 'CONTENT_ARTIFACT_INVALID')
  }
  const file = safeProjectFile(rootDir, artifact.path)
  let actualSize
  try {
    actualSize = statSync(file).size
  } catch {
    throw new ContentIntegrityError(`Registered artifact is missing: ${artifact.path}`, 'CONTENT_ARTIFACT_MISSING', { path: artifact.path })
  }
  if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0 || actualSize !== artifact.size_bytes) {
    throw new ContentIntegrityError(`Size mismatch for ${artifact.path}: expected ${artifact.size_bytes}, actual ${actualSize}`, 'CONTENT_SIZE_MISMATCH', { path: artifact.path })
  }
  if (!SHA256.test(String(artifact.sha256 ?? ''))) {
    throw new ContentIntegrityError(`Invalid SHA-256 declaration for ${artifact.path}`, 'CONTENT_HASH_INVALID', { path: artifact.path })
  }
  const actualHash = sha256File(file)
  if (actualHash !== artifact.sha256) {
    throw new ContentIntegrityError(`SHA-256 mismatch for ${artifact.path}`, 'CONTENT_HASH_MISMATCH', { path: artifact.path, expected: artifact.sha256, actual: actualHash })
  }
  if (!RIGHTS.has(artifact.rights_status)) {
    throw new ContentIntegrityError(`Unknown rights status for ${artifact.path}`, 'CONTENT_RIGHTS_STATUS_INVALID', { path: artifact.path })
  }
  return { path: artifact.path, sha256: actualHash, size_bytes: actualSize, rights_status: artifact.rights_status }
}

function walkFiles(directory, prefix = '') {
  const files = []
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name)
    const relativeName = prefix ? `${prefix}/${name}` : name
    if (statSync(absolute).isDirectory()) files.push(...walkFiles(absolute, relativeName))
    else files.push(relativeName)
  }
  return files
}

function validateAssetRegistry(rootDir, registry) {
  if (registry.schema_version !== 1 || registry.assets_root !== 'public/assets' || !Array.isArray(registry.assets)) {
    throw new ContentIntegrityError('Asset rights registry has an unsupported shape', 'ASSET_REGISTRY_INVALID')
  }
  const declared = new Set()
  const artifacts = []
  for (const tuple of registry.assets) {
    if (!Array.isArray(tuple) || tuple.length !== 3) throw new ContentIntegrityError('Asset registry entry must be [path, sha256, size]', 'ASSET_REGISTRY_INVALID')
    const [path, sha256, sizeBytes] = tuple
    if (declared.has(path)) throw new ContentIntegrityError(`Duplicate asset declaration: ${path}`, 'ASSET_REGISTRY_DUPLICATE')
    declared.add(path)
    artifacts.push(verifyDeclaredArtifact(rootDir, {
      path: `${registry.assets_root}/${path}`,
      sha256,
      size_bytes: sizeBytes,
      rights_status: registry.rights_status,
    }))
  }
  const actual = walkFiles(safeProjectFile(rootDir, registry.assets_root))
  const undeclared = actual.filter((path) => !declared.has(path))
  const missing = [...declared].filter((path) => !actual.includes(path))
  if (undeclared.length || missing.length) {
    throw new ContentIntegrityError(`Asset registry drift: undeclared=${undeclared.join(', ') || '-'}; missing=${missing.join(', ') || '-'}`, 'ASSET_REGISTRY_DRIFT', { undeclared, missing })
  }
  return artifacts
}

function validateRuleReferences(pack) {
  const glossaryIds = new Set(pack.glossary.map((entry) => entry.canonical_id))
  const unknown = []
  for (const rule of pack.rules) {
    for (const reference of rule.entity_refs ?? []) if (!glossaryIds.has(reference)) unknown.push(`${rule.id} -> ${reference}`)
  }
  if (unknown.length) throw new ContentIntegrityError(`Unknown rule entity references: ${unknown.join(', ')}`, 'RULE_REFERENCE_INVALID', { unknown })
  const levels = pack.rules.reduce((counts, rule) => {
    counts[rule.formalization_level] = (counts[rule.formalization_level] ?? 0) + 1
    return counts
  }, {})
  for (const level of ['deterministic', 'structured', 'retrieval_only']) {
    const declared = Number(pack.coverage[`${level}_rule_count`])
    const actual = levels[level] ?? 0
    if (declared !== actual) throw new ContentIntegrityError(`Coverage ${level}_rule_count=${declared}, actual=${actual}`, 'RULE_COVERAGE_COUNT_MISMATCH')
  }
  return { referenced_terms: glossaryIds.size, formalization: levels }
}

function validateCompatibilityCatalogs(rootDir) {
  const spells = readJson(safeProjectFile(rootDir, 'data/dndsu-spells-0-6.json'))
  const overrides = readJson(safeProjectFile(rootDir, 'data/dndsu-spell-mechanics-overrides.json'))
  const actions = readJson(safeProjectFile(rootDir, 'data/dndsu-class-actions-1-12.json'))
  const build = readJson(safeProjectFile(rootDir, 'data/dndsu-class-build-rules-1-12.json'))
  const spellIds = new Set(spells.spells.map((spell) => spell.id))
  const classIds = new Set(actions.classes.map((entry) => entry.classKey))
  const buildClassIds = new Set(build.classes.map((entry) => entry.classKey))
  const problems = []
  if (spells.count !== spells.spells.length) problems.push(`spell count ${spells.count} != ${spells.spells.length}`)
  for (const id of Object.keys(overrides.spells ?? {})) if (!spellIds.has(id)) problems.push(`override references unknown spell ${id}`)
  for (const spell of spells.spells) {
    for (const classId of spell.classes ?? []) if (!classIds.has(classId)) problems.push(`spell ${spell.id} references unknown class ${classId}`)
    if (!/^https:\/\/www\.dnd\.su\//u.test(spell.sourceUrl)) problems.push(`spell ${spell.id} has an unapproved source URL`)
  }
  for (const entry of actions.classes) {
    if (!buildClassIds.has(entry.classKey)) problems.push(`class actions missing build rules for ${entry.classKey}`)
    for (const action of entry.actions) if (action.classKey !== entry.classKey) problems.push(`action ${action.id} belongs to ${action.classKey}, expected ${entry.classKey}`)
  }
  for (const classId of buildClassIds) if (!classIds.has(classId)) problems.push(`build rules reference unknown class ${classId}`)
  if (problems.length) throw new ContentIntegrityError(`Compatibility catalog integrity failed: ${problems.slice(0, 20).join('; ')}`, 'CATALOG_REFERENCE_INVALID', { problems })
  return {
    spells: spells.spells.length,
    classes: actions.classes.length,
    subclasses: actions.classes.reduce((total, entry) => total + entry.subclasses.length, 0),
    actions: actions.classes.reduce((total, entry) => total + entry.actions.length, 0),
    overrides: Object.keys(overrides.spells ?? {}).length,
  }
}

function validateCharacterCreationCatalogs(rootDir) {
  const origins = characterCreationOriginCatalogInfo()
  const backgrounds = backgroundCatalogInfo()
  const starter = readJson(safeProjectFile(rootDir, 'data/starter-equipment-dnd-5e-2014.json'))
  const classicBackgrounds = readJson(safeProjectFile(rootDir, 'data/backgrounds-dnd-5e-2014.json'))
  const problems = []
  if (origins.dnd_5e_2014?.species_options !== 14 || origins.dnd_5e_2014?.bonus_source !== 'species') {
    problems.push('2014 must expose 14 race/subrace options with species-owned ability bonuses')
  }
  if (backgrounds.dnd_5e_2014?.backgrounds !== 13 || backgrounds.dnd_5e_2014?.ability_modes !== 0) {
    problems.push('2014 must expose 13 backgrounds without background ability modes')
  }
  if (origins.srd_5_2_1?.bonus_source !== 'background') problems.push('2024 background-owned ability bonuses changed')
  if (starter.ruleset_id !== 'dnd_5e_2014' || starter.classes?.length !== 12) problems.push('2014 starter equipment must cover 12 classes')
  const classIds = new Set()
  for (const profile of starter.classes ?? []) {
    if (classIds.has(profile.class_id)) problems.push(`duplicate 2014 starter class ${profile.class_id}`)
    classIds.add(profile.class_id)
    for (const item of profile.items ?? []) if (!ITEM_CATALOG[item.catalog_id]) problems.push(`unknown starter item ${item.catalog_id}`)
  }
  for (const background of classicBackgrounds.backgrounds ?? []) {
    for (const item of background.equipment?.catalogItems ?? []) if (!ITEM_CATALOG[item.catalogId]) problems.push(`unknown background item ${item.catalogId}`)
  }
  if (problems.length) throw new ContentIntegrityError(`Character creation catalog integrity failed: ${problems.join('; ')}`, 'CHARACTER_CREATION_CATALOG_INVALID', { problems })
  return {
    dnd_5e_2014: {
      species_options: origins.dnd_5e_2014.species_options,
      backgrounds: backgrounds.dnd_5e_2014.backgrounds,
      classes_with_starter_equipment: starter.classes.length,
      bonus_source: origins.dnd_5e_2014.bonus_source,
    },
    srd_5_2_1: {
      species_options: origins.srd_5_2_1.species_options,
      backgrounds: backgrounds.srd_5_2_1.backgrounds,
      bonus_source: origins.srd_5_2_1.bonus_source,
    },
  }
}

function runtimeCoverageCounts(rootDir, rulePack) {
  const actions = readJson(safeProjectFile(rootDir, 'data/dndsu-class-actions-1-12.json'))
  return {
    classes: combatClassCatalogInfo().classes.length,
    subclasses: actions.classes.reduce((total, entry) => total + entry.subclasses.length, 0),
    spells: spellCatalogInfo().count,
    monsters: Object.keys(SRD_5_2_1_MONSTER_ALLOWLIST).length,
    equipment: Object.keys(ITEM_CATALOG).length,
    commerce_equipment: ITEM_SHOP_CATALOG_IDS.length,
    feats: 0,
    glossary: rulePack.glossary.length,
  }
}

function validateCoverageMatrix(matrix, counts) {
  if (matrix.schema_version !== 1 || !Array.isArray(matrix.categories)) {
    throw new ContentIntegrityError('Rules coverage matrix has an unsupported shape', 'COVERAGE_MATRIX_INVALID')
  }
  const seen = new Set()
  for (const category of matrix.categories) {
    if (!category.id || seen.has(category.id)) throw new ContentIntegrityError(`Invalid or duplicate coverage category ${category.id}`, 'COVERAGE_MATRIX_INVALID')
    seen.add(category.id)
    if (!COVERAGE.has(category.coverage)) throw new ContentIntegrityError(`Unknown coverage state for ${category.id}`, 'COVERAGE_MATRIX_INVALID')
    if (!(category.id in counts)) throw new ContentIntegrityError(`Coverage category ${category.id} has no runtime counter`, 'COVERAGE_MATRIX_INVALID')
    if (Number(category.expected_count) !== counts[category.id]) {
      throw new ContentIntegrityError(`Coverage count mismatch for ${category.id}: expected ${category.expected_count}, runtime ${counts[category.id]}`, 'COVERAGE_MATRIX_COUNT_MISMATCH')
    }
  }
  return matrix.categories.map((category) => ({
    id: category.id,
    coverage: category.coverage,
    count: counts[category.id],
    mandatory_for_release: category.mandatory_for_release === true,
  }))
}

function assertAttribution(rootDir) {
  const attribution = readFileSync(safeProjectFile(rootDir, 'ATTRIBUTION.md'), 'utf8')
  const required = [
    'System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC',
    'https://creativecommons.org/licenses/by/4.0/legalcode',
    'не означает официальный статус, одобрение',
    'data/rule_packs/dnd_5e_2014',
    '5e14.dnd.su',
    'Права на русские переводы и базу dnd.su по-прежнему не подтверждены',
  ]
  const missing = required.filter((text) => !attribution.includes(text))
  if (missing.length) throw new ContentIntegrityError(`ATTRIBUTION.md misses required notices: ${missing.join(', ')}`, 'ATTRIBUTION_MISSING')
}

export async function verifyContentIntegrity({ rootDir = projectRoot } = {}) {
  const root = resolve(rootDir)
  const provenance = readJson(safeProjectFile(root, 'data/content-provenance.json'))
  const sourceIds = new Set((provenance.external_sources ?? []).map((source) => source.id))
  const artifacts = []
  for (const artifact of provenance.artifacts ?? []) {
    if (!sourceIds.has(artifact.source_id)) throw new ContentIntegrityError(`Artifact ${artifact.path} references unknown source ${artifact.source_id}`, 'CONTENT_SOURCE_INVALID')
    artifacts.push(verifyDeclaredArtifact(root, artifact))
  }
  const assetRegistry = readJson(safeProjectFile(root, 'data/asset-rights.json'))
  const assets = validateAssetRegistry(root, assetRegistry)
  const [rulePack, targetRulePack] = await Promise.all([
    loadRulePack('srd_5_2_1', { rootDir: safeProjectFile(root, 'data/rule_packs') }),
    loadRulePack('dnd_5e_2014', { rootDir: safeProjectFile(root, 'data/rule_packs') }),
  ])
  const ruleReferences = validateRuleReferences(rulePack)
  const targetRuleReferences = validateRuleReferences(targetRulePack)
  const compatibility = validateCompatibilityCatalogs(root)
  const characterCreation = validateCharacterCreationCatalogs(root)
  const counts = runtimeCoverageCounts(root, rulePack)
  const coverage = validateCoverageMatrix(readJson(safeProjectFile(root, 'data/rules-coverage-matrix.json')), counts)
  assertAttribution(root)

  const blockers = new Set(provenance.release_blockers ?? [])
  for (const artifact of artifacts) if (!['verified', 'cleared'].includes(artifact.rights_status)) blockers.add(`RIGHTS:${artifact.path}`)
  if (!['verified', 'cleared'].includes(assetRegistry.rights_status) || assetRegistry.distribution !== 'allowed') blockers.add('RIGHTS:public/assets')
  for (const category of coverage) if (category.mandatory_for_release && category.coverage !== 'complete') blockers.add(`COVERAGE:${category.id}:${category.coverage}`)

  return {
    schema_version: 1,
    integrity: {
      ok: true,
      artifacts: artifacts.length,
      assets: assets.length,
      rule_pack: rulePack.summary,
      rule_packs: [rulePack.summary, targetRulePack.summary],
      rule_references: ruleReferences,
      target_rule_references: targetRuleReferences,
      compatibility_catalogs: compatibility,
      character_creation_catalogs: characterCreation,
      item_catalog: {
        entries: counts.equipment,
        shop_entries: counts.commerce_equipment,
      },
      coverage,
    },
    release: {
      ready: blockers.size === 0,
      blockers: [...blockers].sort(),
    },
  }
}
