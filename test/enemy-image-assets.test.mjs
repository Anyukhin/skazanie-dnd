import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const publicRoot = join(root, 'public')

function pngSize(file) {
  const header = readFileSync(file).subarray(0, 24)
  assert.equal(header.subarray(1, 4).toString('ascii'), 'PNG', `${file} — не PNG`)
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

test('каждое существо серверного бестиария имеет локальный квадратный портрет', () => {
  const monsters = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)
  assert.ok(monsters.length >= 12, 'реестр существ неожиданно сократился')

  const imageOwners = new Map()
  const contentOwners = new Map()
  const rights = JSON.parse(readFileSync(join(root, 'data', 'asset-rights.json'), 'utf8'))
  const declaredRights = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  for (const [monsterId, monster] of monsters) {
    assert.match(monster.image, /^\/assets\/enemies\/[a-z0-9-]+\.png$/, `${monsterId} ссылается не на локальный PNG`)
    const file = join(publicRoot, ...monster.image.slice(1).split('/'))
    assert.equal(existsSync(file), true, `${monsterId}: отсутствует ${monster.image}`)
    const size = statSync(file).size
    assert.ok(size >= 20_000, `${monsterId}: портрет подозрительно пуст`)
    assert.deepEqual(pngSize(file), { width: 512, height: 512 }, `${monsterId}: токен должен быть 512×512`)

    const bytes = readFileSync(file)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const relative = monster.image.slice('/assets/'.length)
    const tuple = declaredRights.get(relative)
    assert.ok(tuple, `${monsterId}: ${relative} не зарегистрирован в реестре прав`)
    assert.equal(tuple[1], hash, `${monsterId}: хеш портрета разошёлся с реестром прав`)
    assert.equal(tuple[2], size, `${monsterId}: размер портрета разошёлся с реестром прав`)

    const owners = imageOwners.get(monster.image) ?? []
    owners.push(monsterId)
    imageOwners.set(monster.image, owners)
    const sameContent = contentOwners.get(hash) ?? []
    sameContent.push(monsterId)
    contentOwners.set(hash, sameContent)
  }

  const shared = [...imageOwners.values()].filter((owners) => owners.length > 1)
  assert.deepEqual(shared, [], 'каждый профиль серверного бестиария должен иметь собственный портрет')
  assert.equal(imageOwners.size, monsters.length)
  const duplicatedContent = [...contentOwners.values()].filter((owners) => owners.length > 1)
  assert.deepEqual(duplicatedContent, [], 'разные имена файлов не должны скрывать одинаковый портрет')
  assert.equal(contentOwners.size, monsters.length)
})

test('Страж архива из базовой демонстрационной кампании тоже имеет портрет', () => {
  const source = readFileSync(join(root, 'src', 'data.ts'), 'utf8')
  assert.match(
    source,
    /id: 'archive-guardian'[\s\S]*?image: '\/assets\/enemies\/archive-guardian\.png'/,
    'базовый враг не подключён к локальному портрету',
  )
  const file = join(publicRoot, 'assets', 'enemies', 'archive-guardian.png')
  assert.equal(existsSync(file), true)
  assert.deepEqual(pngSize(file), { width: 512, height: 512 })
})
