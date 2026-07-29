import assert from 'node:assert/strict'
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
  for (const [monsterId, monster] of monsters) {
    assert.match(monster.image, /^\/assets\/enemies\/[a-z0-9-]+\.png$/, `${monsterId} ссылается не на локальный PNG`)
    const file = join(publicRoot, ...monster.image.slice(1).split('/'))
    assert.equal(existsSync(file), true, `${monsterId}: отсутствует ${monster.image}`)
    assert.ok(statSync(file).size >= 20_000, `${monsterId}: портрет подозрительно пуст`)
    assert.deepEqual(pngSize(file), { width: 512, height: 512 }, `${monsterId}: токен должен быть 512×512`)

    const owners = imageOwners.get(monster.image) ?? []
    owners.push(monsterId)
    imageOwners.set(monster.image, owners)
  }

  const shared = [...imageOwners.values()].filter((owners) => owners.length > 1)
  assert.deepEqual(shared, [[
    'srd_5_2_1:goblin-minion',
    'srd_5_2_1:goblin-warrior',
  ]], 'портрет разрешено делить только двум вариантам одного гоблина')
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
