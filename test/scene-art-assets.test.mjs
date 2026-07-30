import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { BOARD_MAP_LIBRARY, SCENE_ART_LIBRARY, SCENE_THEMES } from '../src/scene-art.ts'

test('каждый URL подложки и иллюстрации сцены указывает на существующий файл', () => {
  const urls = [
    ...Object.values(BOARD_MAP_LIBRARY).map((entry) => entry.url),
    ...SCENE_THEMES.flatMap((theme) => SCENE_ART_LIBRARY[theme].map((entry) => entry.url)),
    ...SCENE_ART_LIBRARY.common.map((entry) => entry.url),
  ]
  assert.equal(new Set(urls).size, urls.length, 'URL ассетов сцены не должны дублироваться')
  for (const url of urls) {
    assert.match(url, /^\/assets\//u)
    assert.equal(
      existsSync(new URL(`../public${url}`, import.meta.url)),
      true,
      `${url}: файл отсутствует в public`,
    )
  }
})
