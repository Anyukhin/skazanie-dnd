import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NARRATOR_PROMPT_VERSION,
  NARRATOR_STREAM_MAX_BYTES,
  Narrator,
  deterministicNarration,
} from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

function streamingBrief({ boundaries = '' } = {}) {
  return buildNarrationBrief({
    visible_events: [],
    visible_state_changes: [],
    known_environment: {
      location: 'Зал',
      campaign_premise: {
        boundaries,
      },
    },
    permitted_npc_reactions: [],
  })
}

test('Narrator выдаёт только проверенные законченные предложения полными снимками', async () => {
  const brief = streamingBrief()
  const narration = 'Пока ничего не меняется. Следующий шаг за отрядом.'
  const snapshots = []
  let request
  const llmClient = {
    complete: async (input) => {
      request = input
      input.onDelta('Пока ничего')
      assert.deepEqual(snapshots, [])
      input.onDelta(' не меняется.')
      assert.deepEqual(snapshots, ['Пока ничего не меняется.'])
      input.onDelta(' Следующий шаг')
      assert.equal(snapshots.length, 1)
      input.onDelta(' за отрядом.')
      return { content: narration }
    },
  }

  const result = await new Narrator({ llmClient }).render(brief, {
    onProgress: (text) => snapshots.push(text),
  })

  assert.deepEqual(snapshots, [
    'Пока ничего не меняется.',
    narration,
  ])
  assert.equal(result.narration, narration)
  assert.equal(result.verification.valid, true)
  assert.equal(result.prompt_version, NARRATOR_PROMPT_VERSION)
  assert.match(request.messages[0].content, /PROMPT_ID: narrator\/v6/u)
  assert.equal(Object.hasOwn(request, 'jsonExpected'), false)
})

test('Narrator не публикует префикс, нарушающий явную границу контента', async () => {
  const brief = streamingBrief({ boundaries: 'Без пыток' })
  const unsafe = 'Пытка продолжается.'
  const snapshots = []
  const llmClient = {
    complete: async ({ onDelta }) => {
      onDelta(unsafe)
      return { content: unsafe }
    },
  }

  const result = await new Narrator({ llmClient }).render(brief, {
    onProgress: (text) => snapshots.push(text),
  })

  assert.deepEqual(snapshots, [])
  assert.equal(result.provider, 'deterministic-fallback')
  assert.equal(result.verification.valid, true)
  assert.equal(result.narration, deterministicNarration(brief).narration)
})

test('Narrator завершает показанный префикс авторитетным fallback при ошибке провайдера', async () => {
  const brief = streamingBrief()
  const snapshots = []
  const llmClient = {
    complete: async ({ onDelta }) => {
      onDelta('Пока ничего не меняется.')
      const error = new Error('stream failed')
      error.code = 'LLM_STREAM_INCOMPLETE'
      throw error
    },
  }

  const result = await new Narrator({ llmClient }).render(brief, {
    onProgress: (text) => snapshots.push(text),
  })

  assert.deepEqual(snapshots, ['Пока ничего не меняется.'])
  assert.equal(result.provider, 'deterministic-provider-fallback')
  assert.equal(result.verification.provider_error, 'LLM_STREAM_INCOMPLETE')
  assert.equal(result.narration, deterministicNarration(brief).narration)
})

test('Narrator ограничивает поток даже без подписчика прогресса', async () => {
  const brief = streamingBrief()
  const llmClient = {
    complete: async ({ onDelta }) => {
      onDelta('а'.repeat(NARRATOR_STREAM_MAX_BYTES + 1))
      return { content: 'Пока ничего не меняется.' }
    },
  }

  const result = await new Narrator({ llmClient }).render(brief)

  assert.equal(result.provider, 'deterministic-provider-fallback')
  assert.equal(result.verification.provider_error, 'NARRATION_STREAM_TOO_LARGE')
})

test('Narrator сохраняет совместимость с completeJson без потоковой выдачи', async () => {
  const brief = streamingBrief()
  const narration = deterministicNarration(brief).narration
  let calls = 0
  const llmClient = {
    completeJson: async () => {
      calls += 1
      return { narration }
    },
  }

  const result = await new Narrator({ llmClient }).render(brief)

  assert.equal(calls, 1)
  assert.equal(result.narration, narration)
  assert.equal(result.verification.valid, true)
})
