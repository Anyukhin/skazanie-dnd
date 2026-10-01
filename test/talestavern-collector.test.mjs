import assert from 'node:assert/strict'
import test from 'node:test'

import { libraryRecordFor, parseSlabPage } from '../tools/collect-talestavern-library.mjs'
import { HOUSE_SLAB } from './talespire-fixtures.mjs'

/**
 * Сборщик стартовой библиотеки: разбор страницы слэба и фильтры. Страница
 * собирается здесь же в той разметке, которую сборщик читает, — без копий
 * чужих страниц и текстов.
 */

function page({ license = "<a href='https://creativecommons.org/licenses/by-nc/4.0/' target=_blank>Attribution-NonCommercial</a>", codes = [HOUSE_SLAB], types = ['village'], extra = '' } = {}) {
  return `<html><head><meta property="og:title" content="Тестовая деревня (Slab) - Tales Tavern" />
<script type="application/ld+json">{"@type": "CreativeWork","creator": {"@type": "Person","name": "Тестовый автор","identifier": "7","url": "https://talestavern.com/userprofile/7/"}}</script></head>
<body>
<button class="tt-log-download" title="Num Downloads">
  <i class="fa fa-download"></i> 42
</button>
${codes.map((code) => `<textarea readOnly class="code">${code}</textarea>`).join('\n')}
${extra}
<strong>Author:</strong> <a href='/userprofile/7/'>Тестовый автор</a>
<strong>Status:</strong> Complete
<strong>Created On:</strong> May 1st, 2024
<strong>Terrain:</strong> <a href="https://talestavern.com/slab-terrain/woodland/">Woodland</a>
<strong>Type:</strong> ${types.map((type) => `<a href="https://talestavern.com/slab-type/${type}/">${type}</a>`).join(' , ')}
Creative Commons Lic. ${license}
</body></html>`
}

test('страница слэба: название, автор, категории, лицензия, скачивания и код', () => {
  const parsed = parseSlabPage(page(), 'https://talestavern.com/slab/test-village/')
  assert.equal(parsed.title, 'Тестовая деревня')
  assert.equal(parsed.author, 'Тестовый автор')
  assert.equal(parsed.status, 'Complete')
  assert.deepEqual(parsed.types, ['village'])
  assert.deepEqual(parsed.terrains, ['woodland'])
  assert.equal(parsed.licenseCode, 'by-nc')
  assert.equal(parsed.licenseUrl, 'https://creativecommons.org/licenses/by-nc/4.0/')
  assert.equal(parsed.downloads, 42)
  assert.equal(parsed.codes.length, 1)

  const record = libraryRecordFor(parsed, 'village')
  assert.ok('entry' in record, `запись должна пройти фильтры: ${'reason' in record ? record.reason : ''}`)
  assert.equal(record.entry.id, 'tt-test-village')
  assert.deepEqual(record.entry.source, {
    site: 'TalesTavern',
    url: 'https://talestavern.com/slab/test-village/',
    author: 'Тестовый автор',
    author_url: 'https://talestavern.com/userprofile/7/',
    license: 'Attribution-NonCommercial',
    license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
    created: 'May 1st, 2024',
    downloads: 42,
  })
  assert.ok(record.entry.place_kinds.includes('village'))
  assert.deepEqual(record.levels.map((level) => level.index), [0, 1])
})

test('фильтры: без лицензии, «без производных», несколько слэбов, доска вместо слэба, чужой вид места', () => {
  const url = 'https://talestavern.com/slab/x/'
  const reason = (html, kind = 'village') => {
    const result = libraryRecordFor(parseSlabPage(html, url), kind)
    return 'reason' in result ? result.reason : ''
  }
  assert.match(reason(page({ license: '' })), /лицензия/u)
  assert.match(reason(page({ license: "<a href='https://creativecommons.org/licenses/by-nc-nd/4.0/' target=_blank>Attribution-NonCommercial-NoDerivs</a>" })), /лицензия/u)
  assert.equal(reason(page({ codes: [HOUSE_SLAB, `${HOUSE_SLAB}AAAA`] })), 'несколько слэбов на странице')
  assert.equal(reason(page({ codes: [], extra: '<a href="talespire://published-board/abc/def">Open</a>' })), 'опубликованная доска, не слэб')
  assert.equal(reason(page({ types: ['inn', 'home', 'farm', 'market', 'trade'] })), 'слишком много категорий')
  assert.match(reason(page(), 'temple'), /нужен temple/u)
})
