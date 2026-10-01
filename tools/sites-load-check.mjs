import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const site = process.env.DND_SITES_URL
if (!site) throw new Error('Для замера нужен DND_SITES_URL')
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')
const main = html.match(/src="([^\"]+\.js)"/)?.[1]
const css = html.match(/href="([^\"]+\.css)"/)?.[1]
if (!main || !css) throw new Error('Нужна актуальная сборка pnpm build')
const measurements = []
const groups = []
const assetList = process.argv[2]
const paths = assetList ? JSON.parse(readFileSync(assetList, 'utf8')).paths : ['/api/auth/me', main, css]
if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))) throw new Error('Некорректный список ресурсов')
for (const [name, base] of [['local', 'http://127.0.0.1:8787'], ['site', site]]) {
 for (let round = 1; round <= (assetList ? 2 : 1); round++) {
  const groupStarted = performance.now()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, async () => {
   while (cursor < paths.length) {
    const path = paths[cursor++]
    const started = performance.now()
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(60000) })
    const headersAt = performance.now()
    const data = await response.arrayBuffer()
    measurements.push({ origin: name, round, path, status: response.status,
      firstByteMs: Math.round(headersAt - started), totalMs: Math.round(performance.now() - started),
      decodedBytes: data.byteLength, wireBytes: Number(response.headers.get('content-length')) || null,
      encoding: response.headers.get('content-encoding'), cache: response.headers.get('cf-cache-status'),
      assetCache: response.headers.get('x-skazanie-asset-cache'),
    })
   }
  }))
  groups.push({ origin: name, round, files: paths.length, elapsedMs: Math.round(performance.now() - groupStarted) })
 }
}
console.log(JSON.stringify({ groups, measurements }, null, 2))
if (measurements.some((entry) => entry.status !== 200)) process.exitCode = 1
const script = measurements.find((entry) => entry.origin === 'site' && entry.path === main)
if (script?.totalMs > 3000) { console.error('Основной скрипт загружается дольше целевых 3 секунд'); process.exitCode = 1 }
if (assetList && groups.some((group) => group.origin === 'site' && group.elapsedMs > 5000)) {
  console.error('Ресурсы сцены загружаются дольше целевых 5 секунд'); process.exitCode = 1
}
