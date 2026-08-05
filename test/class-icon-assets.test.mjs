import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const CLASS_IDS = [
  'barbarian',
  'bard',
  'cleric',
  'druid',
  'fighter',
  'monk',
  'paladin',
  'ranger',
  'rogue',
  'sorcerer',
  'warlock',
  'wizard',
]

test('рисованные эмблемы покрывают все классы и зарегистрированы в реестре ассетов', () => {
  const rights = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
  const registered = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  const hashes = new Set()

  for (const classId of CLASS_IDS) {
    const relative = `ui/class-icons/${classId}.webp`
    const file = new URL(`../public/assets/${relative}`, import.meta.url)
    assert.equal(existsSync(file), true, `${relative}: файл отсутствует`)
    const bytes = readFileSync(file)
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', `${relative}: ожидался WebP`)
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', `${relative}: ожидался WebP`)
    assert.ok(bytes.length >= 10_000 && bytes.length <= 80_000, `${relative}: неожиданный размер production-файла`)

    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hashes.has(hash), false, `${relative}: эмблема дублирует другой класс`)
    hashes.add(hash)

    const tuple = registered.get(relative)
    assert.ok(tuple, `${relative}: файл не зарегистрирован в data/asset-rights.json`)
    assert.equal(tuple[1], hash, `${relative}: SHA-256 разошёлся с реестром`)
    assert.equal(tuple[2], bytes.length, `${relative}: размер разошёлся с реестром`)
  }

  const component = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
  assert.match(component, /\/assets\/ui\/class-icons\/\$\{classId\}\.webp/u)
})
