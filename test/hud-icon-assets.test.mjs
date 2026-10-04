import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { pngContractFailures } from './png-asset-contract.mjs'

// Снимок `tmp/art-2026-10/nonspell-actions.json` на 2026-10-04. Источник
// подготовки игнорируется, поэтому стабильный набор служебных идентификаторов живёт в тесте.
const expectedIds = new Set([
  'end-turn', 'movement', 'spellbook', 'swap-weapons', 'base-attack', 'interact', 'parley', 'unarmed-strike',
  'throw', 'lockpick', 'leave-scene', 'look-around', 'talk', 'short-rest', 'long-rest', 'group-vote', 'letters',
  'turn-based', 'sneak', 'common-actions', 'nonlethal', 'opportunity-attack', 'hasted-action', 'custom-action',
  'free-roll', 'sculpt-spells',
])
const assetDirectory = new URL('../public/assets/ui/hud-icons/', import.meta.url)
const rights = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
const declaredRights = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))

function idsOnDisk() {
  try {
    return readdirSync(assetDirectory).filter((name) => name.endsWith('.png')).map((name) => name.slice(0, -4)).sort()
  } catch {
    return []
  }
}

test('реестр служебных значков содержит ровно 26 ожидаемых идентификаторов', () => {
  assert.equal(expectedIds.size, 26)
  assert.deepEqual(idsOnDisk(), [...expectedIds].sort(), 'каталог служебных значков должен содержать ровно запланированные идентификаторы')
})

test('каждый новый служебный значок имеет полный PNG-контракт', () => {
  const failures = []
  for (const id of [...expectedIds].sort()) {
    const path = new URL(`${id}.png`, assetDirectory)
    if (!existsSync(path)) {
      failures.push(`${id}: файл отсутствует`)
      continue
    }
    const errors = pngContractFailures(readFileSync(path), { spanMin: 210, spanMax: 225 })
    if (errors.length) failures.push(`${id}: ${errors.join('; ')}`)
  }
  assert.deepEqual(failures, [], 'служебные значки должны быть PNG RGBA 256×256 с прозрачными углами, bbox 82–88%, центром и размером до 120 КБ')
})

test('служебные значки имеют уникальные хеши и зарегистрированные хеши и размеры', () => {
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
    const relative = `ui/hud-icons/${id}.png`
    const tuple = declaredRights.get(relative)
    if (!tuple) failures.push(`${relative}: права не зарегистрированы`)
    else {
      if (tuple[1] !== hash) failures.push(`${relative}: хеш разошёлся с реестром прав`)
      if (tuple[2] !== bytes.length) failures.push(`${relative}: размер разошёлся с реестром прав`)
    }
  }
  for (const owners of hashes.values()) if (owners.length > 1) failures.push(`дубликат байтов: ${owners.join(', ')}`)
  assert.deepEqual(failures, [], 'каждому служебному значку нужен собственный зарегистрированный файл')
})
