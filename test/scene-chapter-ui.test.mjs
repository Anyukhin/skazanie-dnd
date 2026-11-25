import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { compileClientModules } from './kit/client-ts.mjs'

test('авторский номер Пепельной заставы совпадает в заголовке, баннере и журнале', async () => {
  const { modules: [{ sceneChapter, journalChapterNumber }, { SceneTransitionBanner }] } = await compileClientModules([
    'src/scene-chapter.ts', 'src/SceneTransitionOverlay.tsx',
  ])
  const title = 'Глава 1 · Пепельная застава'
  assert.deepEqual(sceneChapter(title, 2), { number: 1, inTitle: true })
  assert.equal(journalChapterNumber(title, 2), '01')
  const notice = { title, chapter: 2, key: 'ash-watch', location: 'Пепельная застава', from: 'Штормберг' }
  const banner = renderToStaticMarkup(createElement(SceneTransitionBanner, { notice, onClose() {} }))
  assert.match(banner, /Глава 1 · Новая локация/u)
  assert.doesNotMatch(banner, /Глава 2/u)
  assert.equal(journalChapterNumber('Линия Древа · Дикий лес', 3), '')
  assert.equal(journalChapterNumber('Дорога к мосту', 3), '03')
})
