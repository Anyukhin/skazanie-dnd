import { createHash } from 'node:crypto'

import {
  ECONOMY_CATALOG_VERSION,
  SRD_EQUIPMENT_CATALOG,
} from './merchant-economy.mjs'

export const ITEM_APPRAISAL_CONTRACT_VERSION = 'skazanie:item-appraisal:v1'
export const CATALOG_APPRAISAL_POLICY_ID = `skazanie:item-appraisal:catalog:${ECONOMY_CATALOG_VERSION}:v1`
export const CATEGORY_APPRAISAL_POLICY_ID = 'skazanie:item-appraisal:category-rarity-condition:v1'
export const MAX_APPRAISED_UNIT_PRICE_CP = 10_000_000

const MAX_NAME_LENGTH = 120
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const INPUT_FIELDS = new Set([
  'catalog_id',
  'homebrew_id',
  'item_id',
  'name',
  'category',
  'rarity',
  'condition',
])
const OPTION_FIELDS = new Set(['policyId'])

const CATEGORY_BASE_CP = Object.freeze({
  miscellaneous: 25,
  consumable: 50,
  tool: 100,
  treasure: 250,
  weapon: 500,
  armor: 1_000,
})

const RARITY_MULTIPLIER_BPS = Object.freeze({
  common: 10_000,
  uncommon: 50_000,
  rare: 250_000,
  very_rare: 1_000_000,
  legendary: 5_000_000,
})

const CONDITION_MULTIPLIER_BPS = Object.freeze({
  broken: 1_000,
  damaged: 5_000,
  worn: 7_500,
  serviceable: 10_000,
  fine: 12_500,
  pristine: 15_000,
})

export const ITEM_APPRAISAL_POLICIES = Object.freeze({
  [CATALOG_APPRAISAL_POLICY_ID]: Object.freeze({
    policy_id: CATALOG_APPRAISAL_POLICY_ID,
    kind: 'catalog',
    source_version: ECONOMY_CATALOG_VERSION,
  }),
  [CATEGORY_APPRAISAL_POLICY_ID]: Object.freeze({
    policy_id: CATEGORY_APPRAISAL_POLICY_ID,
    kind: 'category-rarity-condition',
    formula_version: 'category-rarity-condition-v1',
    categories: Object.freeze(Object.keys(CATEGORY_BASE_CP)),
    rarities: Object.freeze(Object.keys(RARITY_MULTIPLIER_BPS)),
    conditions: Object.freeze(Object.keys(CONDITION_MULTIPLIER_BPS)),
    maximum_unit_price_cp: MAX_APPRAISED_UNIT_PRICE_CP,
  }),
})

export class ItemAppraisalError extends Error {
  constructor(message, code = 'ITEM_APPRAISAL_REJECTED') {
    super(message)
    this.name = 'ItemAppraisalError'
    this.code = code
  }
}

function inputObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ItemAppraisalError(`${label} must be an object`, 'INVALID_APPRAISAL_INPUT')
  }
  return value
}

function assertKnownFields(source, allowed, label) {
  const unknown = Object.keys(source).filter((key) => !allowed.has(key)).sort()
  if (unknown.length > 0) {
    throw new ItemAppraisalError(
      `${label} contains fields outside the server appraisal contract: ${unknown.join(', ')}`,
      'UNEXPECTED_APPRAISAL_FIELD',
    )
  }
}

function normalizedId(value, label, { required = false } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw new ItemAppraisalError(`${label} is required`, 'INVALID_APPRAISAL_DESCRIPTOR')
  }
  if (typeof value !== 'string') {
    throw new ItemAppraisalError(`${label} must be a string`, 'INVALID_APPRAISAL_DESCRIPTOR')
  }
  const id = value.normalize('NFKC').trim()
  if (!SAFE_ID.test(id)) {
    throw new ItemAppraisalError(`${label} is not a safe identifier`, 'INVALID_APPRAISAL_DESCRIPTOR')
  }
  return id
}

function normalizedName(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (!required) return null
    throw new ItemAppraisalError('name is required', 'INVALID_APPRAISAL_DESCRIPTOR')
  }
  if (typeof value !== 'string') {
    throw new ItemAppraisalError('name must be a string', 'INVALID_APPRAISAL_DESCRIPTOR')
  }
  const name = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new ItemAppraisalError(`name must contain 1-${MAX_NAME_LENGTH} characters`, 'INVALID_APPRAISAL_DESCRIPTOR')
  }
  return name
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !Object.hasOwn(allowed, value)) {
    throw new ItemAppraisalError(
      `${label} must be one of: ${Object.keys(allowed).join(', ')}`,
      'INVALID_APPRAISAL_DESCRIPTOR',
    )
  }
  return value
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function withFingerprint(payload) {
  return deepFreeze({
    ...payload,
    appraisal_fingerprint: fingerprint(payload),
  })
}

function catalogAppraisal(source, policyId) {
  if (policyId != null && policyId !== CATALOG_APPRAISAL_POLICY_ID) {
    throw new ItemAppraisalError('The selected policy cannot appraise catalog items', 'APPRAISAL_POLICY_MISMATCH')
  }
  if (source.homebrew_id != null || source.category != null || source.rarity != null || source.condition != null) {
    throw new ItemAppraisalError(
      'Catalog appraisal accepts catalog identity only; custom descriptors are not price authority',
      'APPRAISAL_DESCRIPTOR_MISMATCH',
    )
  }

  const catalogId = normalizedId(source.catalog_id, 'catalog_id', { required: true })
  const catalog = SRD_EQUIPMENT_CATALOG[catalogId]
  if (!catalog) {
    throw new ItemAppraisalError('catalog_id is absent from the server catalog', 'UNKNOWN_APPRAISAL_CATALOG_ITEM')
  }
  const descriptor = {
    catalog_id: catalog.catalog_id,
    ...(normalizedId(source.item_id, 'item_id') ? { item_id: normalizedId(source.item_id, 'item_id') } : {}),
    ...(normalizedName(source.name) ? { name: normalizedName(source.name) } : {}),
  }
  return withFingerprint({
    contract_version: ITEM_APPRAISAL_CONTRACT_VERSION,
    authoritative: true,
    currency: 'cp',
    descriptor,
    base_price_cp: catalog.base_price_cp,
    provenance: 'catalog',
    policy_id: CATALOG_APPRAISAL_POLICY_ID,
    source: {
      catalog_version: ECONOMY_CATALOG_VERSION,
      source_version: catalog.source_version,
      source_sha256: catalog.source_sha256,
      source_page: catalog.source_page,
      license: catalog.license,
    },
  })
}

function formulaPrice(category, rarity, condition) {
  const numerator = BigInt(CATEGORY_BASE_CP[category])
    * BigInt(RARITY_MULTIPLIER_BPS[rarity])
    * BigInt(CONDITION_MULTIPLIER_BPS[condition])
  const divisor = 100_000_000n
  const rounded = Number((numerator + divisor / 2n) / divisor)
  return Math.max(1, Math.min(MAX_APPRAISED_UNIT_PRICE_CP, rounded))
}

function homebrewAppraisal(source, policyId) {
  if (source.catalog_id != null) {
    throw new ItemAppraisalError('A custom appraisal cannot claim a catalog identity', 'APPRAISAL_DESCRIPTOR_MISMATCH')
  }
  if (policyId == null) {
    throw new ItemAppraisalError('Custom items require an explicit server appraisal policy', 'APPRAISAL_POLICY_REQUIRED')
  }
  if (!Object.hasOwn(ITEM_APPRAISAL_POLICIES, policyId)) {
    throw new ItemAppraisalError('The appraisal policy is not server-allowlisted', 'APPRAISAL_POLICY_NOT_ALLOWED')
  }
  if (policyId !== CATEGORY_APPRAISAL_POLICY_ID) {
    throw new ItemAppraisalError('The selected policy cannot appraise custom items', 'APPRAISAL_POLICY_MISMATCH')
  }

  const descriptor = {
    homebrew_id: normalizedId(source.homebrew_id, 'homebrew_id', { required: true }),
    ...(normalizedId(source.item_id, 'item_id') ? { item_id: normalizedId(source.item_id, 'item_id') } : {}),
    name: normalizedName(source.name, { required: true }),
    category: enumValue(source.category, CATEGORY_BASE_CP, 'category'),
    rarity: enumValue(source.rarity, RARITY_MULTIPLIER_BPS, 'rarity'),
    condition: enumValue(source.condition, CONDITION_MULTIPLIER_BPS, 'condition'),
  }
  const basePriceCp = formulaPrice(descriptor.category, descriptor.rarity, descriptor.condition)
  return withFingerprint({
    contract_version: ITEM_APPRAISAL_CONTRACT_VERSION,
    authoritative: true,
    currency: 'cp',
    descriptor,
    base_price_cp: basePriceCp,
    provenance: 'server_appraisal_policy',
    policy_id: CATEGORY_APPRAISAL_POLICY_ID,
    formula: {
      formula_version: ITEM_APPRAISAL_POLICIES[CATEGORY_APPRAISAL_POLICY_ID].formula_version,
      category_base_cp: CATEGORY_BASE_CP[descriptor.category],
      rarity_multiplier_bps: RARITY_MULTIPLIER_BPS[descriptor.rarity],
      condition_multiplier_bps: CONDITION_MULTIPLIER_BPS[descriptor.condition],
      maximum_unit_price_cp: MAX_APPRAISED_UNIT_PRICE_CP,
    },
  })
}

/**
 * Produces a price attestation from server-owned authority only.
 *
 * Callers should pass the policy through the second, server-controlled
 * argument. A policy marker embedded in an inventory item is deliberately an
 * unknown field and cannot bootstrap its own authority.
 */
export function appraiseItem(input, options = {}) {
  const source = inputObject(input, 'item')
  const appraisalOptions = inputObject(options, 'options')
  assertKnownFields(source, INPUT_FIELDS, 'item')
  assertKnownFields(appraisalOptions, OPTION_FIELDS, 'options')

  const policyId = appraisalOptions.policyId == null
    ? null
    : normalizedId(appraisalOptions.policyId, 'policyId', { required: true })

  if (source.catalog_id != null) return catalogAppraisal(source, policyId)
  return homebrewAppraisal(source, policyId)
}
