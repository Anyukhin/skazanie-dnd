#!/usr/bin/env node
// @ts-check
/**
 * Сборка пакета рисованного стиля 3D-доски (`public/assets/styles/stylized`).
 *
 * Node-часть раздаёт исходники (tmp/asset-src, public/assets, рецепты моделей
 * набора детализации) и принимает готовые файлы. Сама обработка идёт в
 * браузере — страница `tools/build-graphics-styles-page.js`: canvas вырезает и
 * сшивает рисованные фактуры Quaternius, three.js собирает модели из деталей
 * наборов, перекрашивает прежние модели и экспортирует GLB. Так же устроен
 * атлас видов сверху (`tools/render-prop-model-atlas.mjs`): без новых зависимостей.
 *
 *   node tools/build-graphics-styles.mjs [--port 53903]
 *   → открыть адрес, нажать «Собрать стиль»; пакет ляжет в public/assets/styles/stylized/.
 *   Адрес с `?only=<регулярка>` собирает только подходящие модели и ничего не публикует.
 *   Затем: node tools/register-asset-rights.mjs --all-under styles
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRAPHICS_STYLE_SOURCES, STYLE_RELEASE } from './graphics-style-sources.mjs'

const STYLE = 'stylized'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_ROOT = resolve(ROOT, 'tmp/asset-src')
const PUBLIC_ROOT = resolve(ROOT, 'public/assets')
const THREE_ROOT = resolve(ROOT, 'node_modules/three')
const STAGING = resolve(ROOT, 'tmp/graphics-styles-build', STYLE)
const OUTPUT = resolve(PUBLIC_ROOT, 'styles', STYLE)
const OUT_PATH = /^(meta.json|floors\/[a-z-]+\/(color|normal|orm|height)\.jpg|materials\/[a-z0-9-]+\/(color|normal|orm)\.jpg|props\/[a-z0-9_]+\.glb)$/u
const TOOL_FILE = /^(map-detail-model-helpers|map-detail-models-[a-z-]+)\.mjs$/u
const RELEASE_REF = /^(quaternius|quaternius-nature)\/[a-z0-9_]+\.glb$/u
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream' }

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

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сборка рисованного стиля</title>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/","three/examples/jsm/":"/three/examples/jsm/"}}</script>
<style>body{font:14px system-ui;background:#1d1a16;color:#e7dccb;padding:20px}button{font:inherit;padding:8px 16px}pre{white-space:pre-wrap}</style></head>
<body><h1>Рисованный стиль</h1><button id="build">Собрать стиль</button><pre id="log"></pre>
<script type="module" src="/page.js"></script></body></html>`

/** @typedef {{ color: boolean, normal: boolean, orm: boolean, metalness: number, roughness: number, doubleSided: boolean, aspect?: number }} BuiltMaterial */

/**
 * Манифест из файлов в staging. Готовые модели выпуска (`ref`) указываются
 * абсолютным путём выпуска, собранные — путём внутри пакета.
 * @param {Record<string, BuiltMaterial>} builtMaterials
 */
function finish(builtMaterials) {
  const files = []
  const walk = (/** @type {string} */ folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (path !== join(STAGING, 'meta.json')) {
        const bytes = readFileSync(path)
        files.push({ file: relative(STAGING, path).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
      }
    }
  }
  walk(STAGING)
  const source = GRAPHICS_STYLE_SOURCES[STYLE]
  const has = (/** @type {string} */ file) => files.some((entry) => entry.file === file)
  const floors = Object.fromEntries(Object.entries(source.floors)
    .filter(([key]) => ['color', 'normal', 'orm', 'height'].every((map) => has(`floors/${key}/${map}.jpg`)))
    .map(([key, floor]) => [key, { color: `floors/${key}/color.jpg`, normal: `floors/${key}/normal.jpg`, orm: `floors/${key}/orm.jpg`, height: `floors/${key}/height.jpg`, cells: floor.cells, relief: floor.relief }]))
  const materials = Object.fromEntries(Object.entries(builtMaterials).sort(([a], [b]) => a.localeCompare(b)).map(([key, built]) => {
    if (!has(`materials/${key}/color.jpg`)) throw new Error(`нет фактуры материала ${key}`)
    /** @type {Record<string, unknown>} */
    const entry = { color: `materials/${key}/color.jpg` }
    if (built.normal && has(`materials/${key}/normal.jpg`)) entry.normal = `materials/${key}/normal.jpg`
    if (built.orm && has(`materials/${key}/orm.jpg`)) entry.orm = `materials/${key}/orm.jpg`
    entry.metalness = +Number(built.metalness ?? 0).toFixed(3)
    entry.roughness = +Number(built.roughness ?? 1).toFixed(3)
    entry.doubleSided = Boolean(built.doubleSided)
    if (built.aspect !== undefined && built.aspect !== 1) entry.aspect = built.aspect
    return [key, entry]
  }))
  // Виды стен ссылаются на материалы пакета; вид без собранного материала не публикуется.
  const walls = Object.fromEntries(Object.entries(source.walls ?? {})
    .filter(([, look]) => Object.hasOwn(materials, look.material))
    .map(([key, look]) => [key, { material: look.material, cells: look.cells }]))
  const props = Object.fromEntries(Object.entries(source.props).map(([assetId, list]) => [assetId, list.flatMap((prop) => {
    if (prop.ref) {
      if (!RELEASE_REF.test(prop.ref) || !existsSync(join(PUBLIC_ROOT, 'models/environment/releases', STYLE_RELEASE, prop.ref))) throw new Error(`нет модели выпуска ${prop.ref}`)
      return [{ key: `ref-${prop.ref.replace(/\.glb$/u, '').replace(/[^a-z0-9]+/gu, '-')}`, url: `/assets/models/environment/releases/${STYLE_RELEASE}/${prop.ref}`, yaw: prop.yaw ?? 0 }]
    }
    if (!prop.name || !has(`props/${prop.name}.glb`)) throw new Error(`не собрана модель ${prop.name} (${assetId})`)
    return [{ key: `style-${prop.name.replace(/_/gu, '-')}`, url: `props/${prop.name}.glb`, yaw: prop.yaw ?? 0 }]
  })]))
  // Ревизия меняется и от файлов, и от масштабов: тот же JPEG с другим
  // повтором — уже другой пол.
  const revision = createHash('sha256').update(files.map((entry) => entry.sha256).join('')).update(JSON.stringify({ floors, materials, walls, props })).digest('hex').slice(0, 16)
  const manifest = { schema: 'graphics-style/v1', style: STYLE, label: source.label, revision, license: source.license, sources: source.sources, floors, materials, walls, props, files }
  rmSync(OUTPUT, { recursive: true, force: true })
  mkdirSync(OUTPUT, { recursive: true })
  cpSync(STAGING, OUTPUT, { recursive: true, filter: (path) => path !== join(STAGING, 'meta.json') })
  writeFileSync(join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
  const total = files.reduce((sum, entry) => sum + entry.bytes, 0)
  return { style: STYLE, revision, floors: Object.keys(floors).length, materials: Object.keys(materials).length, walls: Object.keys(walls).length, props: Object.keys(props).length, files: files.length, megabytes: +(total / 1048576).toFixed(2) }
}

export function startGraphicsStyleBuilder({ port = 53903 } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (/** @type {number} */ status, /** @type {string | Buffer} */ body, type = 'text/plain; charset=utf-8') => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body) }
    try {
      if (request.method === 'GET') {
        if (url.pathname === '/') return send(200, PAGE, TYPES['.html'])
        if (url.pathname === '/view') return send(200, PAGE.replace('/page.js', '/view.js').replace('<button id="build">Собрать стиль</button><pre id="log"></pre>', '').replace('padding:20px', 'padding:0;margin:0'), TYPES['.html'])
        if (url.pathname === '/view.js') return send(200, readFileSync(new URL('build-graphics-styles-view.js', import.meta.url)), TYPES['.js'])
        if (url.pathname === '/page.js') return send(200, readFileSync(new URL('build-graphics-styles-page.js', import.meta.url)), TYPES['.js'])
        if (url.pathname === '/plan.json') return send(200, JSON.stringify({ style: GRAPHICS_STYLE_SOURCES[STYLE], release: STYLE_RELEASE }), TYPES['.json'])
        if (url.pathname === '/staging-list.json') {
          const list = /** @type {string[]} */ ([])
          const walk = (/** @type {string} */ folder) => { if (existsSync(folder)) for (const entry of readdirSync(folder, { withFileTypes: true })) entry.isDirectory() ? walk(join(folder, entry.name)) : list.push(relative(STAGING, join(folder, entry.name)).split(sep).join('/')) }
          walk(STAGING)
          return send(200, JSON.stringify(list), TYPES['.json'])
        }
        if (url.pathname.startsWith('/tools/')) {
          const name = url.pathname.slice('/tools/'.length)
          if (!TOOL_FILE.test(name)) return send(404, 'нет')
          return send(200, readFileSync(new URL(name, import.meta.url)), TYPES['.mjs'])
        }
        for (const [prefix, base] of [['/three/', THREE_ROOT], ['/source/', SOURCE_ROOT], ['/public/', PUBLIC_ROOT], ['/staging/', STAGING]]) {
          if (!url.pathname.startsWith(prefix)) continue
          const file = safeFile(base, url.pathname.slice(prefix.length))
          if (!file) return send(404, 'нет файла')
          return send(200, readFileSync(file), TYPES[/** @type {keyof typeof TYPES} */ (extname(file))] ?? 'application/octet-stream')
        }
        return send(404, 'нет')
      }
      if (request.method === 'POST') {
        const chunks = /** @type {Buffer[]} */ ([])
        request.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
          try {
            const body = Buffer.concat(chunks)
            if (url.pathname === '/out') {
              const path = url.searchParams.get('path') ?? ''
              if (!OUT_PATH.test(path)) return send(400, 'недопустимый путь')
              const target = join(STAGING, path)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, body)
              return send(200, 'ok')
            }
            if (url.pathname === '/shot') {
              // Снимок сетки просмотра — для глазной проверки, в пакет не попадает.
              const name = (url.searchParams.get('name') ?? 'view').replace(/[^a-z0-9_-]/giu, '')
              mkdirSync(resolve(ROOT, 'tmp/graphics-style-shots'), { recursive: true })
              writeFileSync(resolve(ROOT, 'tmp/graphics-style-shots', `${name}.png`), body)
              return send(200, 'ok')
            }
            if (url.pathname === '/reset') {
              rmSync(STAGING, { recursive: true, force: true })
              return send(200, 'ok')
            }
            if (url.pathname === '/finish') {
              const result = finish(JSON.parse(body.toString('utf8')).materials)
              process.stdout.write(`${JSON.stringify(result)}\n`)
              return send(200, JSON.stringify(result), TYPES['.json'])
            }
            return send(405, 'нет')
          } catch (error) {
            return send(500, String(error))
          }
        })
        return undefined
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
 * Пересчёт манифеста из уже опубликованных файлов: нужен, когда в
 * graphics-style-sources.mjs поменялись только масштабы, рельеф или ссылки
 * на готовые модели выпуска.
 */
export function rebuildManifest() {
  const previous = JSON.parse(readFileSync(join(OUTPUT, 'manifest.json'), 'utf8'))
  rmSync(STAGING, { recursive: true, force: true })
  cpSync(OUTPUT, STAGING, { recursive: true, filter: (path) => !path.endsWith('manifest.json') })
  // Материал, чьи файлы убраны из пакета, выпадает и из манифеста.
  return finish(Object.fromEntries(Object.entries(previous.materials ?? {}).filter(([, entry]) => existsSync(join(OUTPUT, entry.color))).map(([key, entry]) => [key, {
    color: true, normal: Boolean(entry.normal), orm: Boolean(entry.orm), metalness: entry.metalness, roughness: entry.roughness, doubleSided: entry.doubleSided, aspect: entry.aspect,
  }])))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--manifest-only')) {
  process.stdout.write(`${JSON.stringify(rebuildManifest())}\n`)
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port')
  const port = index > 0 ? Number(process.argv[index + 1]) : 53903
  startGraphicsStyleBuilder({ port })
  process.stdout.write(`Откройте http://127.0.0.1:${port} и нажмите «Собрать стиль».\n`)
}
