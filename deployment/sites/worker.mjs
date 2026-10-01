const requestHeaders = [
  'accept', 'accept-language', 'content-type', 'range',
  'if-none-match', 'if-modified-since', 'last-event-id', 'x-idempotency-key',
]
const hopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]

function failure(status, error) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

function tunnelOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9][a-z0-9.-]*\.(?:free\.pinggy\.net|pinggy-free\.link|pinggy\.link)$/i.test(url.hostname)) {
    throw new Error('Некорректный адрес туннеля')
  }
  return url.origin
}

async function sameSecret(value, expected) {
  if (!value || !expected) return false
  const encode = new TextEncoder()
  const [left, right] = await Promise.all([value, expected].map((text) =>
    crypto.subtle.digest('SHA-256', encode.encode(text))))
  const a = new Uint8Array(left), b = new Uint8Array(right)
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

export default {
  async fetch(request, env) {
    const siteUrl = new URL(request.url)
    if (siteUrl.pathname === '/favicon.svg') {
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#0c0b0a"/><path d="M16 3 29 11v13l-13 6L3 24V11Z M16 3 9 21l7 9 7-9ZM3 11l6 10h14l6-10M3 24l6-3m14 0 6 3M3 11h26" fill="none" stroke="#c99556" stroke-width="1.5" stroke-linejoin="round"/></svg>', {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    if (siteUrl.pathname === '/_skazanie/origin') {
      if (request.method !== 'PUT') return failure(405, 'Разрешено только обновление адреса')
      if (!await sameSecret(request.headers.get('x-skazanie-link-key'), env.SKAZANIE_LINK_KEY)) {
        return failure(403, 'Нет права обновлять адрес сервера')
      }
      try {
        const text = await request.text()
        if (text.length > 2048) return failure(400, 'Слишком длинный запрос')
        const origin = tunnelOrigin(JSON.parse(text).origin)
        await env.ORIGIN_DB.prepare('INSERT INTO server_link (id, origin, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, updated_at = excluded.updated_at')
          .bind(origin, Date.now()).run()
        return Response.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
      } catch { return failure(503, 'Не удалось обновить адрес сервера') }
    }
    let origin
    try {
      const stored = env.ORIGIN_DB ? await env.ORIGIN_DB.prepare('SELECT origin FROM server_link WHERE id = 1').first() : null
      origin = new URL(stored?.origin || env.SKAZANIE_ORIGIN)
      // Адрес задаёт владелец на сервере. Путь и ввод посетителя не выбирают backend.
      if (origin.protocol !== 'https:' || origin.username || origin.password ||
          origin.port || origin.pathname !== '/' || origin.search || origin.hash ||
          origin.origin !== tunnelOrigin(origin.origin) ||
          origin.origin === siteUrl.origin) throw new Error('Некорректный backend')
    } catch {
      return failure(503, 'Облачный сервер игры ещё не подключён')
    }
    const incomingOrigin = request.headers.get('origin')
    if (incomingOrigin && incomingOrigin !== siteUrl.origin) {
      return failure(403, 'Запрос с другого источника отклонён')
    }
    if (request.headers.get('sec-fetch-site') === 'cross-site' &&
        !['GET', 'HEAD'].includes(request.method)) {
      return failure(403, 'Запрос с другого источника отклонён')
    }
    const upstreamUrl = new URL(origin)
    // Присваивание pathname не позволяет пути //host переключить источник.
    upstreamUrl.pathname = siteUrl.pathname
    upstreamUrl.search = siteUrl.search
    const headers = new Headers()
    for (const name of requestHeaders) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    const session = (request.headers.get('cookie') || '').split(';')
      .find((part) => part.trim().startsWith('skazanie_session='))
    if (session) headers.set('cookie', session.trim())
    headers.set('x-forwarded-proto', 'https')
    if (incomingOrigin) headers.set('origin', origin.origin)
    let upstream
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual', signal: request.signal,
        cf: { cacheTtl: 0, cacheEverything: false },
      })
    } catch {
      // Запись могла сохраниться до обрыва ответа: повторять её за игрока нельзя.
      return failure(502, 'Связь с игровым сервером прервалась. Проверьте состояние игры перед повтором действия.')
    }
    const resultHeaders = new Headers(upstream.headers)
    for (const name of hopHeaders) resultHeaders.delete(name)
    for (const name of [...resultHeaders.keys()]) {
      if (name.startsWith('access-control-')) resultHeaders.delete(name)
    }
    const location = resultHeaders.get('location')
    if (location) {
      try {
        const target = new URL(location, upstreamUrl)
        if (target.origin === origin.origin) {
          resultHeaders.set('location', `${siteUrl.origin}${target.pathname}${target.search}${target.hash}`)
        }
      } catch { resultHeaders.delete('location') }
    }
    if (siteUrl.pathname.startsWith('/api/') || siteUrl.pathname.startsWith('/generated/') ||
        resultHeaders.has('set-cookie')) {
      resultHeaders.set('Cache-Control', 'private, no-store, no-transform')
    }
    // SSE и большие ассеты передаются потоком; права и состояние остаются у игры.
    const response = new Response(upstream.body, {
      status: upstream.status, statusText: upstream.statusText, headers: resultHeaders,
    })
    if (resultHeaders.get('content-type')?.startsWith('text/html')) {
      return new HTMLRewriter().on('head', { element(head) {
        head.append('<link rel="icon" type="image/svg+xml" href="/favicon.svg">', { html: true })
      } }).transform(response)
    }
    return response
  },
}
