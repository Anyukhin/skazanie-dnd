import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function fixture() {
  return {
    sessionCode: 'CAMP-1', campaign: 'Регрессионная кампания', activePlayerId: 'hero', isNarrating: false,
    messages: [{ id: 'm1', speaker: 'player', author: 'Ада', text: 'Осматриваю дверь', timestamp: '12:00' }],
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Комната', objective: 'Найти выход', turn: 1, cells: [] },
  }
}

test('legacy-кампания, персонаж и история сохраняются и восстанавливаются после reload модуля', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-store-'))
  process.env.DND_STORAGE_DIR = root
  const first = await import(`../server/store.mjs?first=${Date.now()}`)
  const created = first.saveRoom('CAMP-1', fixture(), 0)
  assert.equal(created.conflict, false)
  assert.equal(first.getRoom('CAMP-1').state.messages[0].text, 'Осматриваю дверь')
  assert.equal(first.getRoom('CAMP-1').state.players[0].character, 'Ада')

  const second = await import(`../server/store.mjs?second=${Date.now()}`)
  const restored = second.getRoom('CAMP-1')
  assert.equal(restored.version, 1)
  assert.equal(restored.state.campaign, 'Регрессионная кампания')
  assert.equal(restored.state.players[0].hp, 10)
  assert.deepEqual(second.listRoomCodes(), ['CAMP-1'])
})

test('optimistic locking не позволяет затереть более новую комнату', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-lock-'))
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?lock=${Date.now()}`)
  assert.equal(store.saveRoom('LOCK-1', fixture(), 0).conflict, false)
  const conflict = store.saveRoom('LOCK-1', { ...fixture(), campaign: 'Устаревшая запись' }, 0)
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.room.state.campaign, 'Регрессионная кампания')
})

test('повреждённый JSON не заменяется пустым состоянием', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-corrupt-'))
  mkdirSync(join(root, 'rooms'), { recursive: true })
  writeFileSync(join(root, 'rooms', 'BROKEN.json'), '{not json', 'utf8')
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?corrupt=${Date.now()}`)
  assert.throws(() => store.getRoom('BROKEN'), (error) => error instanceof store.StorageCorruptionError)
})

test('transient narration progress is never persisted as campaign state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-transient-'))
  process.env.DND_STORAGE_DIR = root
  const store = await import(`../server/store.mjs?transient=${Date.now()}`)
  const saved = store.saveRoom('LOADING-1', { ...fixture(), isNarrating: true }, 0)
  assert.equal(saved.conflict, false)
  assert.equal(saved.room.state.isNarrating, false)
  assert.equal(store.getRoom('LOADING-1').state.isNarrating, false)
})
