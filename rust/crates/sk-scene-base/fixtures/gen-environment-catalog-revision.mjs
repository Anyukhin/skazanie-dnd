// Эталон `server/environment-catalog-revision.mjs` для sk-scene-base.
// Запуск из корня репозитория: node rust/crates/sk-scene-base/fixtures/gen-environment-catalog-revision.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LEGACY_CATALOG_REVISION, SAFE_CATALOG_REVISION, currentEnvironmentCatalogRevision, isSafeCatalogRevision } from '../../../../server/environment-catalog-revision.mjs'

const VALUES = [
  'pr79', 'new_release', 'future_release-2', 'docker-release', '5f884daa35bf2ebe49f61f75', '', 'UPPER', '../release', 'a'.repeat(96), 'a'.repeat(97),
  '-start', '_start', '0', 'a b', 'a\n', 'ё', 'release.1', 'a-', 'a_', 42, null, true, ['pr79'], { id: 'pr79' },
]
const safe = VALUES.map((value) => ({ value, output: isSafeCatalogRevision(value) }))

// Манифесты: release.id разной формы, битый JSON, каталог вместо файла.
const MANIFESTS = [
  '{"release":{"id":"new_release"}}', '{"version":1}', '{"release":{"id":"BAD"}}', '{"release":{"id":7}}', '{"release":"x"}',
  'null', '[]', '{битый', '', '{"release":{"id":"a-b_c"},"extra":[1,2,3]}', '﻿{"release":{"id":"bom"}}',
]
const dir = mkdtempSync(join(tmpdir(), 'sk-scene-base-revision-'))
const manifests = MANIFESTS.map((text, index) => {
  const file = join(dir, `manifest-${index}.json`)
  writeFileSync(file, text)
  return { text, output: currentEnvironmentCatalogRevision(file) }
})
mkdirSync(join(dir, 'folder.json'))
const folder = currentEnvironmentCatalogRevision(join(dir, 'folder.json'))
rmSync(dir, { recursive: true, force: true })

writeFileSync(new URL('./environment-catalog-revision.json', import.meta.url), `${JSON.stringify({ legacy: LEGACY_CATALOG_REVISION, source: SAFE_CATALOG_REVISION.source, safe, manifests, folder })}\n`)
console.log(`environment-catalog-revision: ${safe.length + manifests.length + 1} случаев`)
