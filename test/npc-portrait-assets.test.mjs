import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { NPC_PORTRAIT_ROLE_ASSETS } from '../server/npc-portraits.mjs'

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'ожидался PNG')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

test('role set NPC полный, квадратный, уникальный и зарегистрирован в правах', () => {
  assert.deepEqual(Object.keys(NPC_PORTRAIT_ROLE_ASSETS).sort(), [
    'artisan',
    'commoner',
    'guard',
    'merchant',
    'noble',
    'priest',
    'scholar',
    'traveler',
  ])
  const rights = JSON.parse(readFileSync(new URL('../data/asset-rights.json', import.meta.url), 'utf8'))
  const registered = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  const hashes = new Set()
  for (const [role, url] of Object.entries(NPC_PORTRAIT_ROLE_ASSETS)) {
    assert.match(url, new RegExp(`^/assets/npcs/roles/${role}\\.png$`, 'u'))
    const relative = url.replace(/^\/assets\//u, '')
    const file = new URL(`../public/assets/${relative}`, import.meta.url)
    assert.equal(existsSync(file), true, `${relative}: файла нет`)
    const bytes = readFileSync(file)
    const dimensions = pngDimensions(bytes)
    assert.deepEqual(dimensions, { width: 320, height: 320 }, `${relative}: production-размер`)
    assert.ok(bytes.length >= 20_000, `${relative}: файл подозрительно мал`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hashes.has(hash), false, `${relative}: изображение дублирует другую роль`)
    hashes.add(hash)
    const tuple = registered.get(relative)
    assert.ok(tuple, `${relative}: файл не зарегистрирован в data/asset-rights.json`)
    assert.equal(tuple[1], hash, `${relative}: SHA-256 разошёлся с реестром прав`)
    assert.equal(tuple[2], bytes.length, `${relative}: размер разошёлся с реестром прав`)
  }
})
