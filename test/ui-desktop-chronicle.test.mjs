import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  chronicleMatchesFilter,
  isChronicleNearBottom,
} from '../src/chat-chronicle.mjs'

test('desktop chronicle filters the existing speaker contract without losing player narration', () => {
  assert.equal(chronicleMatchesFilter('narrator', 'story'), true)
  assert.equal(chronicleMatchesFilter('player', 'story'), true)
  assert.equal(chronicleMatchesFilter('system', 'story'), false)
  assert.equal(chronicleMatchesFilter('system', 'combat'), true)
  assert.equal(chronicleMatchesFilter('narrator', 'combat'), false)
  assert.equal(chronicleMatchesFilter('player', 'combat'), false)
  assert.equal(chronicleMatchesFilter('system', 'all'), true)
})

test('desktop chronicle follows new events only while the reader remains at the bottom', () => {
  assert.equal(isChronicleNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true)
  assert.equal(isChronicleNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 550 }), true)
  assert.equal(isChronicleNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 500 }), false)
})

test('the combat context does not render a second copy of the latest chronicle event', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(appSource, /<BattleResultCard\b/)
  assert.doesNotMatch(appSource, /ПОСЛЕДНИЙ РЕЗУЛЬТАТ/)
})
