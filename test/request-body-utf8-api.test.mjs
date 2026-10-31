// Тело запроса, пришедшее несколькими кусками, разбирается целиком: буква,
// разорванная границей куска, не превращается в «��». JS-сервер склеивал куски
// строками (`raw += chunk`), и двухбайтовая кириллица на границе куска
// портилась — большое тело с готовым состоянием, импортом или картой уходило в
// журнал испорченным (docs/rust-port-js-findings.md, «HTTP-маршруты»).
import assert from 'node:assert/strict'
import { request } from 'node:http'
import test from 'node:test'

import { setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const NAME = 'Ёжик Благословенный'

/** POST, тело которого уходит двумя кусками с разрывом посреди буквы. */
function postInTwoChunks(baseUrl, path, body, splitAt) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': bytes.length },
    }, (res) => {
      const parts = []
      res.on('data', (part) => parts.push(part))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }))
    })
    req.on('error', reject)
    req.write(bytes.subarray(0, splitAt))
    // Пауза — чтобы сервер получил первый кусок отдельным событием `data`.
    setTimeout(() => req.end(bytes.subarray(splitAt)), 50)
  })
}

test('тело из двух кусков с разрывом посреди буквы разбирается без порчи кириллицы', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t)
  await setupAdmin(server)
  const body = { name: NAME, email: `utf8-${process.pid}@kit.test`, password: 'kit-player-password-1' }
  const json = Buffer.from(JSON.stringify(body), 'utf8')
  // Середина «Ё» (два байта UTF-8): граница куска рвёт букву.
  const splitAt = json.indexOf(Buffer.from('Ё', 'utf8')) + 1
  const response = await postInTwoChunks(server.baseUrl, '/api/auth/register', body, splitAt)
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(response.body.user.name, NAME)
})
