import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'

import {
  BOARD_MAP_LIBRARY,
  SCENE_ART_LIBRARY,
  SCENE_THEMES,
  boardMapArtForTheme,
  resolveSceneTheme,
  sceneIllustrationForTheme,
  stableSceneHash,
} from '../src/scene-art.ts'

function state(scene = {}) {
  return {
    scene: {
      title: '',
      location: '',
      mood: '',
      objective: '',
      turn: 0,
      cells: [],
      ...scene,
    },
  }
}

function webpDimensions(bytes) {
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP')
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8 ') {
    assert.equal(bytes.subarray(23, 26).toString('hex'), '9d012a')
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }
  if (chunk === 'VP8L') {
    assert.equal(bytes[20], 0x2f)
    const bits = bytes.readUInt32LE(21)
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    }
  }
  assert.fail(`неподдержанный WebP chunk ${chunk}`)
}

test('каталог владеет пятью собственными подложками и всеми 17 иллюстрациями', () => {
  assert.equal(Object.keys(BOARD_MAP_LIBRARY).length, 5)
  assert.equal(BOARD_MAP_LIBRARY.cave.url, '/assets/maps/library/skazanie/cave-01.webp')
  assert.equal(BOARD_MAP_LIBRARY.dungeon.url, '/assets/maps/library/skazanie/dungeon-01.webp')
  assert.equal(BOARD_MAP_LIBRARY.tavern.url, '/assets/maps/library/skazanie/tavern-01.webp')
  assert.equal(BOARD_MAP_LIBRARY.temple.url, '/assets/maps/library/skazanie/temple-01.webp')
  assert.equal(BOARD_MAP_LIBRARY.village.url, '/assets/maps/library/skazanie/village-01.webp')

  const sceneUrls = [
    ...SCENE_THEMES.flatMap((theme) => SCENE_ART_LIBRARY[theme].map((entry) => entry.url)),
    ...SCENE_ART_LIBRARY.common.map((entry) => entry.url),
  ]
  assert.equal(sceneUrls.length, 17)
  assert.equal(new Set(sceneUrls).size, 17)
  assert.ok(sceneUrls.every((url) => /^\/assets\/scenes\/(?:building|temple|crypt|cave|forest|road|settlement|common)-(?:01|02|night-road|camp|ruins)\.webp$/u.test(url)))

  const boardUrls = Object.values(BOARD_MAP_LIBRARY).map((entry) => entry.url)
  const rights = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
  const registered = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  for (const url of [...boardUrls, ...sceneUrls]) {
    const relative = url.replace(/^\/assets\//u, '')
    const file = new URL(`../public/assets/${relative}`, import.meta.url)
    const bytes = readFileSync(file)
    assert.deepEqual(
      webpDimensions(bytes),
      url.includes('/maps/library/') ? { width: 1536, height: 1024 } : { width: 1280, height: 512 },
      relative,
    )
    const tuple = registered.get(relative)
    assert.ok(tuple, `${relative}: нет записи прав`)
    assert.equal(tuple[1], createHash('sha256').update(bytes).digest('hex'), `${relative}: неверный SHA-256`)
    assert.equal(tuple[2], statSync(file).size, `${relative}: неверный размер`)
  }
})

test('resolver покрывает семь live themes и отдаёт приоритет теме map', () => {
  for (const theme of SCENE_THEMES) {
    assert.equal(resolveSceneTheme(state({
      map: { theme },
      theme: theme === 'cave' ? 'храм' : 'пещера',
      location: 'Ложная деревня',
    })), theme)
  }
  assert.equal(resolveSceneTheme(state({ theme: 'древний склеп', location: 'Лес' })), 'crypt')
  assert.equal(resolveSceneTheme(state({ location: 'Северный тракт' })), 'road')
  assert.equal(resolveSceneTheme(state({ cells: [{ x: 0, y: 0, type: 'floor', revealed: true, material: 'marble' }] })), 'temple')
  assert.equal(resolveSceneTheme(state({
    scene_kind: 'road',
    cells: [{ x: 0, y: 0, type: 'floor', revealed: true, material: 'grass' }],
  })), 'forest', 'клеточные данные должны предшествовать запасному scene_kind')
})

test('каждая тема выбирает одну из двух тематических иллюстраций стабильно по locationId', () => {
  for (const theme of SCENE_THEMES) {
    const seen = new Set()
    for (let index = 0; index < 100; index += 1) {
      const locationId = `${theme}:location:${index}`
      const first = sceneIllustrationForTheme(theme, locationId)
      const retry = sceneIllustrationForTheme(theme, locationId)
      assert.deepEqual(retry, first)
      assert.ok(SCENE_ART_LIBRARY[theme].includes(first))
      seen.add(first.url)
    }
    assert.equal(seen.size, 2, `${theme}: обе тематические вариации должны быть достижимы`)
  }
})

test('неизвестная тема использует общий fallback, а board mapping покрывает все темы', () => {
  assert.equal(resolveSceneTheme(state()), 'common')
  const fallback = sceneIllustrationForTheme('unknown', 'lost-location')
  assert.ok(SCENE_ART_LIBRARY.common.includes(fallback))
  const expectedBoard = {
    building: 'tavern',
    temple: 'temple',
    crypt: 'dungeon',
    cave: 'cave',
    forest: 'village',
    road: 'village',
    settlement: 'village',
  }
  for (const theme of SCENE_THEMES) {
    assert.equal(boardMapArtForTheme(theme), BOARD_MAP_LIBRARY[expectedBoard[theme]])
  }
  assert.equal(boardMapArtForTheme('common'), BOARD_MAP_LIBRARY.dungeon)
})

test('hash стабилен, чувствителен к строке и всегда является uint32', () => {
  assert.equal(stableSceneHash('Локация №1'), stableSceneHash('Локация №1'))
  assert.notEqual(stableSceneHash('Локация №1'), stableSceneHash('Локация №2'))
  assert.ok(Number.isInteger(stableSceneHash('test')))
  assert.ok(stableSceneHash('test') >= 0 && stableSceneHash('test') <= 0xffffffff)
})
