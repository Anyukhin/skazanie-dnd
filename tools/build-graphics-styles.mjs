#!/usr/bin/env node
// @ts-check
/**
 * Сборка пакетов двух стилей графики 3D-доски.
 *
 * Node-часть раздаёт исходники (tmp/asset-src, public/assets) и принимает
 * готовые файлы. Сама обработка идёт в браузере — страница
 * `tools/build-graphics-styles-page.js`: canvas уменьшает и перекодирует
 * текстуры в JPEG, вычисляет рельеф рисованных полов, three.js упрощает
 * тяжёлые модели и экспортирует GLB. Так же устроен атлас видов сверху
 * (`tools/render-prop-model-atlas.mjs`): без новых зависимостей.
 *
 *   node tools/build-graphics-styles.mjs [--port 53903]
 *   → открыть адрес, нажать «Собрать стили»; пакеты лягут в public/assets/styles/<стиль>/.
 *   Затем: node tools/register-asset-rights.mjs --all-under styles
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPHICS_STYLE_SOURCES } from './graphics-style-sources.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_ROOT = resolve(ROOT, 'tmp/asset-src')
const PUBLIC_ROOT = resolve(ROOT, 'public/assets')
const THREE_ROOT = resolve(ROOT, 'node_modules/three')
const STAGING = resolve(ROOT, 'tmp/graphics-styles-build')
const OUTPUT_ROOT = resolve(PUBLIC_ROOT, 'styles')
const OUT_PATH = /^(floors\/[a-z-]+\/(color|normal|orm|height)\.jpg|props\/[a-z0-9_]+\.glb)$/u
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream' }

/** @param {string} base @param {string} target */
function inside(base, target) {
  const distance = relative(base, target)
  return distance !== '' && !distance.startsWith('..') && !distance.includes(`..${sep}`) && !distance.startsWith(sep)
}

/** @param {string} base @param {string} rest */
function safeFile(base, rest) {
  const target = resolve(base, decodeURIComponent(rest))
  if (!inside(base, target) || !existsSync(target) || !statSync(target).isFile()) return null
  return target
}

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сборка стилей графики</title>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<style>body{font:14px system-ui;background:#1d1a16;color:#e7dccb;padding:20px}button{font:inherit;padding:8px 16px}pre{white-space:pre-wrap}</style></head>
<body><h1>Стили графики</h1><button id="build">Собрать стили</button><pre id="log"></pre>
<script type="module" src="/page.js"></script></body></html>`

/** @param {string} style */
function finish(style) {
  const directory = join(STAGING, style)
  const files = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        const bytes = readFileSync(path)
        files.push({ file: relative(directory, path).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
      }
    }
  }
  walk(directory)
  const source = GRAPHICS_STYLE_SOURCES[style]
  const has = (file) => files.some((entry) => entry.file === file)
  const floors = Object.fromEntries(Object.entries(source.floors)
    .filter(([key]) => ['color', 'normal', 'orm', 'height'].every((map) => has(`floors/${key}/${map}.jpg`)))
    .map(([key, floor]) => [key, { color: `floors/${key}/color.jpg`, normal: `floors/${key}/normal.jpg`, orm: `floors/${key}/orm.jpg`, height: `floors/${key}/height.jpg`, cells: floor.cells, relief: floor.relief }]))
  const props = Object.fromEntries(Object.entries(source.props).map(([assetId, list]) => [assetId, list
    .filter((prop) => has(`props/${prop.polyhaven}.glb`))
    .map((prop) => ({ key: `${style}-${prop.polyhaven}`, url: `props/${prop.polyhaven}.glb`, yaw: prop.yaw ?? 0 }))]).filter(([, list]) => list.length))
  // Ревизия меняется и от файлов, и от масштабов: тот же JPEG с другим
  // повтором — уже другой пол.
  const revision = createHash('sha256').update(files.map((entry) => entry.sha256).join('')).update(JSON.stringify({ floors, props })).digest('hex').slice(0, 16)
  const manifest = { schema: 'graphics-style/v1', style, label: source.label, revision, license: source.license, sources: source.sources, floors, props, files }
  rmSync(join(OUTPUT_ROOT, style), { recursive: true, force: true })
  mkdirSync(join(OUTPUT_ROOT, style), { recursive: true })
  cpSync(directory, join(OUTPUT_ROOT, style), { recursive: true })
  writeFileSync(join(OUTPUT_ROOT, style, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
  const total = files.reduce((sum, entry) => sum + entry.bytes, 0)
  return { style, revision, floors: Object.keys(floors).length, props: Object.keys(props).length, files: files.length, megabytes: +(total / 1048576).toFixed(2) }
}

export function startGraphicsStyleBuilder({ port = 53903 } = {}) {
  rmSync(STAGING, { recursive: true, force: true })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status, body, type = 'text/plain; charset=utf-8') => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body) }
    try {
      if (request.method === 'GET') {
        if (url.pathname === '/') return send(200, PAGE, TYPES['.html'])
        if (url.pathname === '/page.js') return send(200, readFileSync(new URL('build-graphics-styles-page.js', import.meta.url)), TYPES['.js'])
        if (url.pathname === '/plan.json') return send(200, JSON.stringify(GRAPHICS_STYLE_SOURCES), TYPES['.json'])
        for (const [prefix, base] of [['/three/', THREE_ROOT], ['/source/', SOURCE_ROOT], ['/public/', PUBLIC_ROOT]]) {
          if (!url.pathname.startsWith(prefix)) continue
          const file = safeFile(base, url.pathname.slice(prefix.length))
          if (!file) return send(404, 'нет файла')
          return send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream')
        }
        return send(404, 'нет')
      }
      if (request.method === 'POST' && url.pathname === '/out') {
        const style = url.searchParams.get('style') ?? '', path = url.searchParams.get('path') ?? ''
        if (!Object.hasOwn(GRAPHICS_STYLE_SOURCES, style) || !OUT_PATH.test(path)) return send(400, 'недопустимый путь')
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
          const target = join(STAGING, style, path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, Buffer.concat(chunks))
          send(200, 'ok')
        })
        return undefined
      }
      if (request.method === 'POST' && url.pathname === '/finish') {
        const results = Object.keys(GRAPHICS_STYLE_SOURCES).filter((style) => existsSync(join(STAGING, style))).map(finish)
        process.stdout.write(`${JSON.stringify(results)}\n`)
        return send(200, JSON.stringify(results), TYPES['.json'])
      }
      return send(405, 'нет')
    } catch (error) {
      return send(500, String(error))
    }
  })
  server.listen(port, '127.0.0.1')
  return server
}

/**
 * Пересчёт манифестов из уже собранных файлов: нужен, когда в
 * graphics-style-sources.mjs поменялись только масштабы и рельеф.
 */
export function rebuildManifests() {
  rmSync(STAGING, { recursive: true, force: true })
  const results = []
  for (const style of Object.keys(GRAPHICS_STYLE_SOURCES)) {
    const published = join(OUTPUT_ROOT, style)
    if (!existsSync(published)) continue
    cpSync(published, join(STAGING, style), { recursive: true, filter: (path) => !path.endsWith('manifest.json') })
    results.push(finish(style))
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--manifest-only')) {
  process.stdout.write(`${JSON.stringify(rebuildManifests())}\n`)
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port')
  const port = index > 0 ? Number(process.argv[index + 1]) : 53903
  startGraphicsStyleBuilder({ port })
  process.stdout.write(`Откройте http://127.0.0.1:${port} и нажмите «Собрать стили».\n`)
}
