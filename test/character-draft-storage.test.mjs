import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHARACTER_DRAFT_MAX_AGE_MS, characterDraftKey, clearCharacterDraft, loadCharacterDraft, saveCharacterDraft,
} from '../src/character-draft-storage.mjs'

// OB-01 (исследование PR #136, U02): черновик мастера создания героя пропадал
// при закрытии окна и перезагрузке.

function memoryStorage() {
  const items = new Map()
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)) },
    removeItem: (key) => { items.delete(key) },
  }
}

const owner = { accountId: 'acc-1', sessionCode: 'ROOM-1', playerId: 'hero-slot-2', rulesetId: 'dnd_5e_2014' }
const draft = { classId: 'wizard', abilityMethod: 'point_buy', characterName: 'Ада' }

test('ключ различает аккаунт, кампанию, место героя и редакцию', () => {
  const keys = new Set([
    characterDraftKey(owner),
    characterDraftKey({ ...owner, accountId: 'acc-2' }),
    characterDraftKey({ ...owner, sessionCode: 'ROOM-2' }),
    characterDraftKey({ ...owner, playerId: 'hero-slot-3' }),
    characterDraftKey({ ...owner, rulesetId: 'srd_5_2_1' }),
  ])
  assert.equal(keys.size, 5)
  assert.equal(characterDraftKey({ ...owner, accountId: '' }), '', 'без владельца черновик не сохраняется')
})

test('черновик переживает перезагрузку: сохранён — прочитан с шагом', () => {
  const storage = memoryStorage()
  const key = characterDraftKey(owner)
  assert.equal(saveCharacterDraft(key, { draft, step: 'abilities', furthestStep: 'equipment' }, { storage, now: 1_000 }), true)
  assert.deepEqual(loadCharacterDraft(key, { storage, now: 2_000, knownClassIds: ['wizard', 'fighter'], knownSteps: ['class', 'abilities', 'equipment'] }), {
    draft, step: 'abilities', furthestStep: 'equipment', savedAt: 1_000,
  })
})

test('устаревший, чужого формата или с исчезнувшим классом черновик не предлагается и стирается', () => {
  const key = characterDraftKey(owner)
  for (const [label, prepare, options] of [
    ['просрочен', (storage) => saveCharacterDraft(key, { draft, step: 'class', furthestStep: 'class' }, { storage, now: 0 }), { now: CHARACTER_DRAFT_MAX_AGE_MS + 1 }],
    ['класса нет в каталоге', (storage) => saveCharacterDraft(key, { draft, step: 'class', furthestStep: 'class' }, { storage, now: 0 }), { now: 1, knownClassIds: ['fighter'] }],
    ['не тот формат', (storage) => storage.setItem(key, JSON.stringify({ version: 999, saved_at: 0, draft })), { now: 1 }],
    ['мусор', (storage) => storage.setItem(key, '{не json'), { now: 1 }],
  ]) {
    const storage = memoryStorage()
    prepare(storage)
    assert.equal(loadCharacterDraft(key, { storage, ...options }), null, label)
    assert.equal(storage.items.has(key), false, `${label}: запись стёрта`)
  }
})

test('неизвестный шаг не восстанавливается, а сам черновик — да', () => {
  const storage = memoryStorage()
  const key = characterDraftKey(owner)
  saveCharacterDraft(key, { draft, step: 'removed-step', furthestStep: 'class' }, { storage, now: 0 })
  const loaded = loadCharacterDraft(key, { storage, now: 1, knownSteps: ['class'] })
  assert.equal(loaded.step, '')
  assert.equal(loaded.furthestStep, 'class')
  assert.deepEqual(loaded.draft, draft)
})

test('недоступное хранилище не роняет мастер', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('denied') },
  }
  const key = characterDraftKey(owner)
  assert.equal(saveCharacterDraft(key, { draft, step: 'class', furthestStep: 'class' }, { storage: broken }), false)
  assert.equal(loadCharacterDraft(key, { storage: broken }), null)
  assert.doesNotThrow(() => clearCharacterDraft(key, { storage: broken }))
})

test('после создания героя черновик стирается', () => {
  const storage = memoryStorage()
  const key = characterDraftKey(owner)
  saveCharacterDraft(key, { draft, step: 'identity', furthestStep: 'identity' }, { storage, now: 0 })
  clearCharacterDraft(key, { storage })
  assert.equal(loadCharacterDraft(key, { storage, now: 1 }), null)
})
