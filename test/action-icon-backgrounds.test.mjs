import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const THEMES = ['arcane', 'divine', 'martial', 'nature', 'shadow', 'utility']

function webpDimensions(bytes) {
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP')
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString('ascii')
    const size = bytes.readUInt32LE(offset + 4)
    const data = offset + 8
    if (type === 'VP8 ') {
      assert.equal(bytes.subarray(data + 3, data + 6).toString('hex'), '9d012a')
      return [bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff]
    }
    if (type === 'VP8X') {
      return [1 + bytes.readUIntLE(data + 4, 3), 1 + bytes.readUIntLE(data + 7, 3)]
    }
    if (type === 'VP8L') {
      assert.equal(bytes[data], 0x2f)
      const width = 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8)
      const height = 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10)
      return [width, height]
    }
    offset = data + size + (size % 2)
  }
  throw new Error('В WebP не найден графический chunk')
}

test('все семейства способностей имеют отдельный зарегистрированный фон 256×256', () => {
  const rights = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
  const registered = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  const hashes = new Set()

  for (const theme of THEMES) {
    const relative = `ui/action-backgrounds/${theme}.webp`
    const bytes = readFileSync(new URL(`../public/assets/${relative}`, import.meta.url))
    assert.deepEqual(webpDimensions(bytes), [256, 256], `${relative}: нужен production-размер 256×256`)
    assert.ok(bytes.length >= 8_000 && bytes.length <= 40_000, `${relative}: неожиданный размер файла`)

    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hashes.has(hash), false, `${relative}: фон дублирует другое семейство`)
    hashes.add(hash)

    const tuple = registered.get(relative)
    assert.ok(tuple, `${relative}: нет записи в data/asset-rights.json`)
    assert.equal(tuple[1], hash, `${relative}: SHA-256 разошёлся с реестром`)
    assert.equal(tuple[2], bytes.length, `${relative}: размер разошёлся с реестром`)
  }
})

test('CombatIcon выбирает тему и собирает фон с прозрачным символом разными слоями', () => {
  const component = readFileSync(new URL('../src/CombatIcon.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  for (const theme of THEMES) assert.ok(component.includes(`'${theme}'`), `не объявлена тема ${theme}`)
  assert.match(component, /action-backgrounds\/\$\{theme\}\.webp/u)
  assert.ok(component.includes('combat-icon-symbol'))
  assert.ok(styles.includes('background-image: var(--combat-icon-bg)'))
  assert.ok(styles.includes('background-image: var(--combat-icon-src)'))
})
