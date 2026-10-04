import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { pngContractFailures } from './png-asset-contract.mjs'

// Снимок `tmp/art-2026-10/nonspell-actions.json` на 2026-10-04. Источник
// подготовки игнорируется, поэтому стабильный набор идентификаторов состояний живёт в тесте.
const expectedIds = new Set([
  'dead', 'unconscious', 'incapacitated', 'stunned', 'paralyzed', 'petrified', 'restrained', 'grappled', 'prone',
  'poisoned', 'blinded', 'deafened', 'frightened', 'charmed', 'invisible', 'exhaustion', 'concentration', 'fled',
  'surrendered', 'weapon-coated', 'rime-encased', 'vitriolic-acid-covered', 'minor-blessing',
])
const assetDirectory = new URL('../public/assets/ui/conditions/', import.meta.url)
const rights = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
const declaredRights = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))

function idsOnDisk() {
  try {
    return readdirSync(assetDirectory).filter((name) => name.endsWith('.png')).map((name) => name.slice(0, -4)).sort()
  } catch {
    return []
  }
}

test('реестр состояний содержит ровно 23 ожидаемых идентификатора', () => {
  assert.equal(expectedIds.size, 23)
  assert.deepEqual(idsOnDisk(), [...expectedIds].sort(), 'каталог состояний должен содержать ровно запланированные идентификаторы')
})

test('каждая новая иконка состояния имеет полный PNG-контракт', () => {
  const failures = []
  for (const id of [...expectedIds].sort()) {
    const path = new URL(`${id}.png`, assetDirectory)
    if (!existsSync(path)) {
      failures.push(`${id}: файл отсутствует`)
      continue
    }
    const errors = pngContractFailures(readFileSync(path), { spanMin: 180, spanMax: 199 })
    if (errors.length) failures.push(`${id}: ${errors.join('; ')}`)
  }
  assert.deepEqual(failures, [], 'иконки состояний должны быть PNG RGBA 256×256 с прозрачными углами, bbox 70–78%, центром и размером до 120 КБ')
})

test('иконки состояний имеют уникальные хеши и зарегистрированные хеши и размеры', () => {
  const failures = []
  const hashes = new Map()
  for (const id of [...expectedIds].sort()) {
    const path = new URL(`${id}.png`, assetDirectory)
    if (!existsSync(path)) continue
    const bytes = readFileSync(path)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const owners = hashes.get(hash) ?? []
    owners.push(id)
    hashes.set(hash, owners)
    const relative = `ui/conditions/${id}.png`
    const tuple = declaredRights.get(relative)
    if (!tuple) failures.push(`${relative}: права не зарегистрированы`)
    else {
      if (tuple[1] !== hash) failures.push(`${relative}: хеш разошёлся с реестром прав`)
      if (tuple[2] !== bytes.length) failures.push(`${relative}: размер разошёлся с реестром прав`)
    }
  }
  for (const owners of hashes.values()) if (owners.length > 1) failures.push(`дубликат байтов: ${owners.join(', ')}`)
  assert.deepEqual(failures, [], 'каждой иконке состояния нужен собственный зарегистрированный файл')
})
