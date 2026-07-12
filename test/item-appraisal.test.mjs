import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CATALOG_APPRAISAL_POLICY_ID,
  CATEGORY_APPRAISAL_POLICY_ID,
  ITEM_APPRAISAL_CONTRACT_VERSION,
  ITEM_APPRAISAL_POLICIES,
  ItemAppraisalError,
  MAX_APPRAISED_UNIT_PRICE_CP,
  appraiseItem,
} from '../server/item-appraisal.mjs'

function homebrew(overrides = {}) {
  return {
    homebrew_id: 'homebrew:moon-blade-fragment',
    item_id: 'item-17',
    name: 'Осколок лунного клинка',
    category: 'weapon',
    rarity: 'rare',
    condition: 'worn',
    ...overrides,
  }
}

function appraisalError(code) {
  return (error) => error instanceof ItemAppraisalError && error.code === code
}

test('catalog appraisal uses only the canonical server price and source provenance', () => {
  const result = appraiseItem({
    catalog_id: 'srd_5_2_1:potion-of-healing',
    item_id: 'potion-1',
    name: 'Зелье лечения',
  })

  assert.equal(result.contract_version, ITEM_APPRAISAL_CONTRACT_VERSION)
  assert.equal(result.authoritative, true)
  assert.equal(result.currency, 'cp')
  assert.equal(result.base_price_cp, 5_000)
  assert.equal(result.provenance, 'catalog')
  assert.equal(result.policy_id, CATALOG_APPRAISAL_POLICY_ID)
  assert.equal(result.source.catalog_version, 'srd_5_2_1')
  assert.equal(result.source.source_page, 95)
  assert.match(result.appraisal_fingerprint, /^[a-f0-9]{64}$/u)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.descriptor))
  assert.ok(Object.isFrozen(result.source))
})

test('client and agent price fields, secrets, attestation markers and every unknown field fail closed', () => {
  for (const field of [
    'base_price_cp',
    'estimated_price_cp',
    'price_cp',
    'secret',
    'secret_supplier',
    'price_provenance',
    'appraisal_policy_id',
    'appraisal_fingerprint',
    'unknown',
  ]) {
    assert.throws(
      () => appraiseItem({ catalog_id: 'srd_5_2_1:torch', [field]: field === 'secret' ? 'GM_ONLY' : 999_999 }),
      appraisalError('UNEXPECTED_APPRAISAL_FIELD'),
      field,
    )
  }
})

test('unknown catalog identity never falls through to the homebrew formula', () => {
  assert.throws(
    () => appraiseItem({ catalog_id: 'homebrew:moon-blade-fragment' }, { policyId: CATEGORY_APPRAISAL_POLICY_ID }),
    appraisalError('APPRAISAL_POLICY_MISMATCH'),
  )
  assert.throws(
    () => appraiseItem({ catalog_id: 'homebrew:moon-blade-fragment' }),
    appraisalError('UNKNOWN_APPRAISAL_CATALOG_ITEM'),
  )
})

test('custom item requires the explicit allowlisted server policy', () => {
  assert.throws(() => appraiseItem(homebrew()), appraisalError('APPRAISAL_POLICY_REQUIRED'))
  assert.throws(
    () => appraiseItem(homebrew(), { policyId: 'agent:free-price:v1' }),
    appraisalError('APPRAISAL_POLICY_NOT_ALLOWED'),
  )
  assert.throws(
    () => appraiseItem(homebrew(), { policyId: CATALOG_APPRAISAL_POLICY_ID }),
    appraisalError('APPRAISAL_POLICY_MISMATCH'),
  )
})

test('versioned category/rarity/condition formula is deterministic, bounded and auditable', () => {
  const input = homebrew()
  const snapshot = structuredClone(input)
  const first = appraiseItem(input, { policyId: CATEGORY_APPRAISAL_POLICY_ID })
  const second = appraiseItem(structuredClone(input), { policyId: CATEGORY_APPRAISAL_POLICY_ID })

  assert.deepEqual(input, snapshot)
  assert.deepEqual(first, second)
  assert.equal(first.base_price_cp, 9_375)
  assert.equal(first.provenance, 'server_appraisal_policy')
  assert.equal(first.policy_id, CATEGORY_APPRAISAL_POLICY_ID)
  assert.equal(first.formula.formula_version, 'category-rarity-condition-v1')
  assert.deepEqual(first.formula, {
    formula_version: 'category-rarity-condition-v1',
    category_base_cp: 500,
    rarity_multiplier_bps: 250_000,
    condition_multiplier_bps: 7_500,
    maximum_unit_price_cp: MAX_APPRAISED_UNIT_PRICE_CP,
  })
  assert.ok(first.base_price_cp >= 1 && first.base_price_cp <= MAX_APPRAISED_UNIT_PRICE_CP)
  assert.ok(Object.isFrozen(first.formula))
})

test('safe descriptor normalization makes equivalent requests share one stable fingerprint', () => {
  const first = appraiseItem(homebrew({ name: '  Осколок   лунного клинка  ' }), { policyId: CATEGORY_APPRAISAL_POLICY_ID })
  const second = appraiseItem(homebrew({ name: 'Осколок лунного клинка' }), { policyId: CATEGORY_APPRAISAL_POLICY_ID })
  const changed = appraiseItem(homebrew({ condition: 'fine' }), { policyId: CATEGORY_APPRAISAL_POLICY_ID })

  assert.equal(first.descriptor.name, 'Осколок лунного клинка')
  assert.equal(first.appraisal_fingerprint, second.appraisal_fingerprint)
  assert.notEqual(first.appraisal_fingerprint, changed.appraisal_fingerprint)
  assert.notEqual(first.base_price_cp, changed.base_price_cp)
})

test('formula accepts only the small versioned descriptor vocabularies', () => {
  for (const [field, value] of [
    ['category', 'artifact'],
    ['rarity', 'unique'],
    ['condition', 'enchanted-by-agent'],
  ]) {
    assert.throws(
      () => appraiseItem(homebrew({ [field]: value }), { policyId: CATEGORY_APPRAISAL_POLICY_ID }),
      appraisalError('INVALID_APPRAISAL_DESCRIPTOR'),
    )
  }
  assert.throws(
    () => appraiseItem(homebrew({ name: 'x'.repeat(121) }), { policyId: CATEGORY_APPRAISAL_POLICY_ID }),
    appraisalError('INVALID_APPRAISAL_DESCRIPTOR'),
  )
})

test('catalog and homebrew descriptors cannot be mixed and policy options are strict', () => {
  assert.throws(
    () => appraiseItem({ catalog_id: 'srd_5_2_1:dagger', rarity: 'legendary' }),
    appraisalError('APPRAISAL_DESCRIPTOR_MISMATCH'),
  )
  assert.throws(
    () => appraiseItem(homebrew(), { policyId: CATEGORY_APPRAISAL_POLICY_ID, estimatedPriceCp: 1 }),
    appraisalError('UNEXPECTED_APPRAISAL_FIELD'),
  )
})

test('published policy allowlist is immutable and exposes only bounded server policies', () => {
  assert.deepEqual(Object.keys(ITEM_APPRAISAL_POLICIES).sort(), [
    CATALOG_APPRAISAL_POLICY_ID,
    CATEGORY_APPRAISAL_POLICY_ID,
  ].sort())
  assert.ok(Object.isFrozen(ITEM_APPRAISAL_POLICIES))
  assert.ok(Object.isFrozen(ITEM_APPRAISAL_POLICIES[CATEGORY_APPRAISAL_POLICY_ID]))
  assert.equal(
    ITEM_APPRAISAL_POLICIES[CATEGORY_APPRAISAL_POLICY_ID].maximum_unit_price_cp,
    MAX_APPRAISED_UNIT_PRICE_CP,
  )
})
