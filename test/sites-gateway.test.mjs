import test from 'node:test'
import assert from 'node:assert/strict'
import gateway from '../deployment/sites/worker.mjs'

const env = { SKAZANIE_ORIGIN: 'https://test-game.free.pinggy.net' }
const site = 'https://skazanie.example'

test('Sites не выбирает backend из адреса посетителя и отклоняет чужой Origin', async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; return new Response('unexpected') }
  try {
    for (const origin of ['http://localhost:8787', 'https://user:secret@host.example', `${env.SKAZANIE_ORIGIN}/path`, 'https://localhost', 'https://127.0.0.1']) {
      assert.equal((await gateway.fetch(new Request(site), { SKAZANIE_ORIGIN: origin })).status, 503)
    }
    const denied = await gateway.fetch(new Request(`${site}/api/auth/login`, {
      method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}',
    }), env)
    assert.equal(denied.status, 403)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})

test('новый адрес туннеля сохраняется только с серверным ключом и читается следующим запросом', async () => {
  let stored = null, writes = 0
  const configured = { ...env, SKAZANIE_LINK_KEY: 'test-link-key', ORIGIN_DB: {
    prepare(sql) {
      if (sql.startsWith('SELECT')) return { first: async () => stored }
      return { bind(origin) { return { run: async () => { writes++; stored = { origin } } } } }
    },
  } }
  const update = (key, origin) => gateway.fetch(new Request(`${site}/_skazanie/origin`, {
    method: 'PUT', headers: { 'x-skazanie-link-key': key }, body: JSON.stringify({ origin }),
  }), configured)
  assert.equal((await update('visitor-key', env.SKAZANIE_ORIGIN)).status, 403)
  assert.equal((await update('test-link-key', 'https://evil.example')).status, 503)
  assert.equal(writes, 0)
  const nextOrigin = 'https://next-game.run.pinggy-free.link'
  assert.equal((await update('test-link-key', nextOrigin)).status, 200)
  const original = globalThis.fetch
  globalThis.fetch = async (url) => { assert.equal(new URL(url).origin, nextOrigin); return new Response('ready') }
  try { assert.equal(await (await gateway.fetch(new Request(site), configured)).text(), 'ready') }
  finally { globalThis.fetch = original }
})

test('Sites передаёт сессию, ключ повтора и тело, сохраняя серверную cookie входа', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${env.SKAZANIE_ORIGIN}/api/command?room=A`)
    assert.equal(init.headers.get('origin'), env.SKAZANIE_ORIGIN)
    assert.equal(init.headers.get('cookie'), 'skazanie_session=game-token')
    assert.equal(init.headers.get('x-idempotency-key'), 'same-command')
    assert.equal(init.headers.get('x-forwarded-proto'), 'https')
    assert.equal(init.headers.get('oai-authenticated-user-id'), null)
    assert.equal(init.headers.get('authorization'), null)
    assert.equal(init.redirect, 'manual')
    assert.equal(await new Response(init.body).text(), '{"move":1}')
    return new Response('{"ok":true}', { headers: {
      'set-cookie': 'skazanie_session=new-token; Path=/; HttpOnly; Secure; SameSite=Lax',
      'access-control-allow-origin': 'http://localhost:4173', 'cache-control': 'public',
    } })
  }
  try {
    const response = await gateway.fetch(new Request(`${site}/api/command?room=A`, {
      method: 'POST', headers: {
        origin: site, cookie: 'sites_session=private; skazanie_session=game-token',
        'x-idempotency-key': 'same-command', 'oai-authenticated-user-id': 'private',
        authorization: 'Bearer private', 'content-type': 'application/json',
      }, body: '{"move":1}',
    }), env)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure/)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    assert.match(response.headers.get('cache-control'), /private, no-store/)
    assert.deepEqual(await response.json(), { ok: true })
  } finally { globalThis.fetch = original }
})

test('Sites отдаёт SSE до закрытия потока, сохраняет URL и не повторяет потерянную запись', async () => {
  const original = globalThis.fetch
  let calls = 0
  let controller
  globalThis.fetch = async (url) => {
    calls++
    assert.equal(new URL(url).origin, env.SKAZANIE_ORIGIN)
    return new Response(new ReadableStream({ start(value) {
      controller = value
      value.enqueue(new TextEncoder().encode('event: room\ndata: {}\n\n'))
    } }), { headers: { 'content-type': 'text/event-stream', connection: 'keep-alive' } })
  }
  try {
    const response = await gateway.fetch(new Request(`${site}//evil.example/api/stream`), env)
    assert.equal(response.headers.get('connection'), null)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /event: room/)
    controller.close()
    assert.equal((await reader.read()).done, true)
    globalThis.fetch = async () => { calls++; throw new Error('connection reset') }
    assert.equal((await gateway.fetch(new Request(`${site}/api/command`, { method: 'POST', body: '{}' }), env)).status, 502)
    assert.equal(calls, 2)
  } finally { globalThis.fetch = original }
})
