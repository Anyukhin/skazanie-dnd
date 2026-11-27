import assert from 'node:assert/strict'
import test from 'node:test'

import { assembleWithRateLimitPause } from '../eval/soak-encounter-assembly.mjs'

test('стенд повторяет сборку с теми же параметрами после десятиминутного окна', async () => {
  const rejected = { status: 429, body: { code: 'ENCOUNTER_ASSEMBLY_RATE_LIMITED' } }
  const accepted = { status: 200 }
  const calls = []
  const options = { method: 'POST', cookie: 'session', body: { idempotency_key: 'encounter', expected_state_version: 7 } }
  const path = '/api/campaigns/SOAK-31/encounters/assemble'
  const post = async (url, request) => {
    calls.push([url, request])
    return calls.length === 1 ? rejected : accepted
  }

  assert.equal(await assembleWithRateLimitPause(post, path, options, async (delay) => {
    assert.deepEqual(calls, [[path, options]])
    assert.equal(delay, 600_000)
  }), accepted)
  assert.deepEqual(calls, [[path, options], [path, options]])
})

test('стенд делает одну попытку после паузы и сразу возвращает другие отказы', async () => {
  const limited = { status: 429, body: { code: 'ENCOUNTER_ASSEMBLY_RATE_LIMITED' } }
  let requests = 0
  let pauses = 0
  assert.equal(await assembleWithRateLimitPause(async () => {
    requests += 1
    return limited
  }, '/assemble', {}, async () => { pauses += 1 }), limited)
  assert.equal(requests, 2)
  assert.equal(pauses, 1)

  for (const failure of [{ status: 429, body: { code: 'OTHER_LIMIT' } }, { status: 500 }]) {
    assert.equal(await assembleWithRateLimitPause(async () => failure, '/assemble', {}, () => assert.fail('пауза только на лимите сборки')), failure)
  }
})
