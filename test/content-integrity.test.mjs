import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ContentIntegrityError,
  verifyContentIntegrity,
  verifyDeclaredArtifact,
} from '../server/content-integrity.mjs'

// Выпуски добавляются целиком через models:publish. Считаем объявленный состав
// их manifest, а не реальные файлы или строки реестра: лишний файл по-прежнему
// нарушает гейт, исходные ассеты остаются фиксированной базой.
function declaredEnvironmentReleaseFiles() {
  const directory = fileURLToPath(new URL('../public/assets/models/environment/releases', import.meta.url))
  if (!existsSync(directory)) return 0
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(entry.isDirectory() && /^[a-f0-9]{24}$/u.test(entry.name), 'каталог опубликованного выпуска имеет неизменяемый ID')
    const manifest = JSON.parse(readFileSync(join(directory, entry.name, 'manifest.json'), 'utf8'))
    assert.equal(manifest.release?.schema, 'environment-release/v1')
    assert.equal(manifest.release.id, entry.name)
    assert.ok(Array.isArray(manifest.release.files))
    const paths = manifest.release.files.map((file) => file.path)
    assert.equal(new Set(paths).size, paths.length, 'состав выпуска не содержит повторов')
    assert.ok(paths.every((path) => typeof path === 'string' && path !== 'manifest.json' && !path.startsWith('/') && !path.split('/').includes('..')))
    count += 1 + paths.length
  }
  return count
}

function declaredEquipmentReleaseFiles() {
  const directory = fileURLToPath(new URL('../public/assets/models/equipment/', import.meta.url))
  let count = 1 // активный каталог
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    assert.match(entry.name, /^equipment-[a-f0-9]{24}$/u)
    const manifest = JSON.parse(readFileSync(join(directory, entry.name, 'manifest.json'), 'utf8'))
    count += new Set(manifest.models.map((model) => model.url)).size + 3 // GLB, каталог, NOTICE, LICENSE
  }
  return count
}

test('content integrity gate verifies hashes, references, counts and the complete asset registry', async () => {
  const report = await verifyContentIntegrity()
  assert.equal(report.integrity.ok, true)
  assert.equal(report.integrity.rule_pack.rule_count, 23)
  assert.deepEqual(
    report.integrity.rule_packs.map((pack) => [pack.ruleset_id, pack.rule_count]),
    [['srd_5_2_1', 23], ['dnd_5e_2014', 28]],
  )
  assert.equal(report.integrity.target_rule_references.referenced_terms, 34)
  assert.equal(report.integrity.compatibility_catalogs.spells, 439)
  assert.equal(report.integrity.compatibility_catalogs.classes, 12)
  assert.deepEqual(report.integrity.character_creation_catalogs.dnd_5e_2014, {
    species_options: 15,
    backgrounds: 13,
    classes_with_starter_equipment: 12,
    species_choice_groups: 10,
    starter_choice_groups: 37,
    bonus_source: 'species',
  })
  assert.equal(report.integrity.character_creation_catalogs.srd_5_2_1.bonus_source, 'background')
  assert.deepEqual(report.integrity.item_catalog, { entries: 145, shop_entries: 50 })
  assert.equal(report.integrity.coverage.find((entry) => entry.id === 'equipment').count, 145)
  // 1222 + 7 петель атмосферы (`public/assets/audio/ambience/*.ogg`)
  // + 2 дорожки музыки мастеров создания мира и героя
  // + 102 индивидуальных item-art и отдельный портрет гоблина-налётчика.
  // Число сторожит именно неожиданный приход и уход ассетов, поэтому меняется
  // вместе с осознанным пополнением набора.
  // + 12 рисованных эмблем классов (`public/assets/ui/class-icons/*.webp`).
  // + 6 переиспользуемых фонов способностей (`public/assets/ui/action-backgrounds/*.webp`).
  // + 8 файлов гарнитур интерфейса (`public/assets/fonts/*.woff2`, см. docs/fonts.md).
  // + 7 авторских глобальных карт: три исходных фона v1, три атласных v2
  // и авторская карта Асстоханских равнин
  // (`public/assets/maps/world/skazanie/*.webp`).
  // + 4 авторских плана стартовых городов (`public/assets/maps/city/skazanie/*.webp`).
  // + 10 портретов рас мастера создания, включая отдельный портрет дроу.
  // + 9 портретов бестиария 2014 и 20 иллюстраций стартового снаряжения.
  // + 4 портрета бестиария, 11 готовых карт локаций и 8 портретов Асстохана.
  // + 41 портрет расширенного бестиария CR 0–6 (четыре предыдущих учтены выше).
  // + 52 файла общих планов локаций и дополнительных изображений замка.
  // + 125 GLB окружения, 4 файла происхождения/лицензий, каталог и парный 2D-атлас.
  // + замороженный baseline-pr79.json для карт без catalogRevision.
  // + два персонажа Quaternius и их LICENSE/NOTICE.
  // + 4 файла нейтральных основ и объявленные неизменяемые выпуски экипировки.
  // + 53 записанных боевых звука и их фазовый manifest.
  // + 38 карточек фокусов, инструментов барда и дорогих компонентов.
  assert.equal(report.integrity.assets, 1777 + declaredEnvironmentReleaseFiles() + declaredEquipmentReleaseFiles())
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
