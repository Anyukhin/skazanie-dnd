import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer as createViteServer } from 'vite'

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createHttpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function closeServer(server) {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

test('Vite proxy keeps the browser Origin/Host pair for the server origin guard', { timeout: 30_000 }, async (t) => {
  const upstreamPort = await freePort()
  const frontendPort = await freePort()
  let forwarded = null
  const upstream = createHttpServer((request, response) => {
    const origin = String(request.headers.origin ?? '')
    const host = String(request.headers.host ?? '')
    const sameOrigin = !origin || (() => {
      try { return new URL(origin).host === host } catch { return false }
    })()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '') && !sameOrigin) {
      response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Запрос с другого источника отклонён' }))
      return
    }
    forwarded = { origin, host, url: request.url, method: request.method }
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('upstream-ok')
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(upstreamPort, '127.0.0.1', resolve)
  })
  t.after(async () => { await closeServer(upstream) })

  const previousAgentPort = process.env.AGENT_PORT
  process.env.AGENT_PORT = String(upstreamPort)
  let vite
  try {
    vite = await createViteServer({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      mode: 'test',
      server: { host: '127.0.0.1', port: frontendPort, strictPort: true },
    })
    await vite.listen()

    const browserOrigin = `http://127.0.0.1:${frontendPort}`
    const accepted = await fetch(`${browserOrigin}/api/proxy-check`, {
      method: 'POST',
      headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(accepted.status, 200)
    assert.equal(await accepted.text(), 'upstream-ok')
    assert.deepEqual(forwarded, {
      origin: browserOrigin,
      host: `127.0.0.1:${frontendPort}`,
      url: '/api/proxy-check',
      method: 'POST',
    })

    const rejected = await fetch(`${browserOrigin}/api/proxy-check`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(rejected.status, 403)
  } finally {
    await vite?.close()
    if (previousAgentPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = previousAgentPort
  }
})
