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
  assert.deepEqual(report.integrity.item_catalog, { entries: 107, shop_entries: 12 })
  assert.equal(report.integrity.coverage.find((entry) => entry.id === 'equipment').count, 107)
  // 1222 + 7 петель атмосферы (`public/assets/audio/ambience/*.ogg`)
  // + 2 дорожки музыки мастеров создания мира и героя
  // + 102 индивидуальных item-art и отдельный портрет гоблина-налётчика.
  // Число сторожит именно неожиданный приход и уход ассетов, поэтому меняется
  // вместе с осознанным пополнением набора.
  // + 12 рисованных эмблем классов (`public/assets/ui/class-icons/*.webp`).
  // + 6 переиспользуемых фонов способностей (`public/assets/ui/action-backgrounds/*.webp`).
  // + 8 файлов гарнитур интерфейса (`public/assets/fonts/*.woff2`, см. docs/fonts.md).
  assert.equal(report.integrity.assets, 1360)
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
      // Размер обязан совпадать с фактическим блобом (нормализация 2026-07-28):
      // иначе первой срабатывает проверка размера, а тест проверяет именно хеш.
      size_bytes: 29517,
      rights_status: 'verified',
    }),
    (error) => error instanceof ContentIntegrityError && error.code === 'CONTENT_HASH_MISMATCH',
  )
})
