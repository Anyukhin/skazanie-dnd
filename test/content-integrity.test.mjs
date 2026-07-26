import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ContentIntegrityError,
  verifyContentIntegrity,
  verifyDeclaredArtifact,
} from '../server/content-integrity.mjs'

test('content integrity gate verifies hashes, references, counts and the complete asset registry', async () => {
  const report = await verifyContentIntegrity()
  assert.equal(report.integrity.ok, true)
  assert.equal(report.integrity.rule_pack.rule_count, 23)
  assert.equal(report.integrity.compatibility_catalogs.spells, 439)
  assert.equal(report.integrity.compatibility_catalogs.classes, 12)
  assert.equal(report.integrity.assets, 1129)
  assert.equal(report.integrity.coverage.find((entry) => entry.id === 'feats').coverage, 'missing')
})

test('release gate stays closed while rights and mandatory SRD coverage are unresolved', async () => {
  const report = await verifyContentIntegrity()
  assert.equal(report.release.ready, false)
  assert.ok(report.release.blockers.includes('PROJECT_LICENSE_MISSING'))
  assert.ok(report.release.blockers.includes('RIGHTS:public/assets'))
  assert.ok(report.release.blockers.includes('COVERAGE:feats:missing'))
})

test('a changed registered artifact fails closed before release packaging', () => {
  assert.throws(
    () => verifyDeclaredArtifact(process.cwd(), {
      path: 'data/rule_packs/srd_5_2_1/rules.jsonl',
      sha256: '0'.repeat(64),
      size_bytes: 29535,
      rights_status: 'verified',
    }),
    (error) => error instanceof ContentIntegrityError && error.code === 'CONTENT_HASH_MISMATCH',
  )
})
