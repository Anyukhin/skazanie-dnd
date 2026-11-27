import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ClarificationRegistry } from '../server/clarification-registry.mjs'

function fixture(now = 1_000) {
  const directory = mkdtempSync(join(tmpdir(), 'clarification-dialogue-'))
  return { directory, file: join(directory, 'registry.json'), clock: { value: now } }
}

test('память диалога ограничена шестью записями и принадлежит аккаунту', () => {
  const fixtureData = fixture()
  try {
    const registry = new ClarificationRegistry({ storageFile: fixtureData.file, now: () => fixtureData.clock.value, idFactory: (() => { let i = 0; return () => `id-${++i}` })() })
    for (let i = 0; i < 8; i += 1) registry.rememberDialogue({ campaignId: 'camp', actorId: 'hero', question: `q${i}`, answer: `a${i}` })
    registry.rememberDialogue({ campaignId: 'camp', actorId: 'other', question: 'чужой', answer: 'чужой ответ' })
    assert.deepEqual(registry.recentDialogue({ campaignId: 'camp', actorId: 'hero' }).map((entry) => entry.question), ['q7', 'q6', 'q5', 'q4', 'q3', 'q2'])
    assert.deepEqual(registry.recentDialogue({ campaignId: 'camp', actorId: 'other' }).map((entry) => entry.question), ['чужой'])
    assert.equal(registry.resetDialogue({ campaignId: 'camp', actorId: 'hero' }), 6)
    assert.deepEqual(registry.recentDialogue({ campaignId: 'camp', actorId: 'other' }).map((entry) => entry.question), ['чужой'])
  } finally { rmSync(fixtureData.directory, { recursive: true, force: true }) }
})

test('память переживает перезапуск, TTL и не меняет старую схему', () => {
  const fixtureData = fixture()
  try {
    const options = { storageFile: fixtureData.file, now: () => fixtureData.clock.value }
    const registry = new ClarificationRegistry(options)
    registry.rememberDialogue({ campaignId: 'camp', actorId: 'hero', question: 'куда идти?', answer: 'к северным воротам', action: 'route', stateVersion: 7 })
    const restarted = new ClarificationRegistry(options)
    assert.equal(restarted.recentDialogue({ campaignId: 'camp', actorId: 'hero' })[0].answer, 'к северным воротам')
    fixtureData.clock.value += 60 * 60 * 1_000 + 1
    assert.deepEqual(restarted.recentDialogue({ campaignId: 'camp', actorId: 'hero' }), [])
    const intent = restarted.create({ campaignId: 'camp', actorId: 'hero', question: 'что дальше?', stateVersion: 1, intent: { actor_id: 'hero', intent: 'clarify', approach: 'ask', action_steps: ['шаг 1'], constraints: ['не шуметь'], pending_step: 'выбрать дверь' } })
    assert.equal(intent.id.startsWith('clarification:'), true)
  } finally { rmSync(fixtureData.directory, { recursive: true, force: true }) }
})
