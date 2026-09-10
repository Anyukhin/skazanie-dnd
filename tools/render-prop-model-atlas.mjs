#!/usr/bin/env node
/** Создание 2D-атласа прямо из игровых GLB в каталоге-кандидате. */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat, readFile, realpath, rename, stat, unlink, writeFile,
} from 'node:fs/promises'
import {
  extname, isAbsolute, join, relative, resolve, sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodePng, encodePng } from './png-codec.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const THREE_ROOT = resolve(ROOT, 'node_modules/three')
const ASSET_PREFIX = '/assets/models/environment/'
const THREE_PREFIX = '/three/'
const CANDIDATE_SCHEMA = 'environment-candidate/v1'
const OUTPUT_IMAGE = 'topdown.png'
const OUTPUT_MANIFEST = 'manifest.json'
const TILE = 256
const COLUMNS = 8
const ATLAS_WIDTH = TILE * COLUMNS
const MAX_ATLAS_HEIGHT = 16_384
const MAX_BODY_BYTES = 32_000_000
const DEFAULT_PORT = 53_902
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TYPES = Object.freeze({
  '.glb': 'model/gltf-binary',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
})

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} base @param {string} target */
function isAtOrInside(base, target) {
  const distance = relative(base, target)
  return distance === '' || (
    distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance)
  )
}

/** @param {string} base @param {string} target */
function assertInside(base, target) {
  if (!isAtOrInside(base, target) || resolve(base) === resolve(target)) {
    throw new Error(`Путь вне каталога: ${target}`)
  }
  return target
}

/** @param {string} directory */
async function candidateDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new Error('Нужен каталог кандидата через --dir')
  }
  const requested = resolve(directory)
  const requestedInfo = await lstat(requested)
  if (requestedInfo.isSymbolicLink()) throw new Error(`Каталог-кандидат не может быть симлинком: ${directory}`)
  const candidate = await realpath(requested)
  const blocked = [
    ['public/assets', resolve(ROOT, 'public/assets')],
    ['data', resolve(ROOT, 'data')],
    ['storage', resolve(ROOT, 'storage')],
  ]
  for (const [name, path] of blocked) {
    if (isAtOrInside(path, requested) || isAtOrInside(path, candidate)) {
      throw new Error(`Каталог ${name} запрещён для staged-рендера`)
    }
  }
  const details = await stat(candidate)
  if (!details.isDirectory()) throw new Error(`Кандидат не является каталогом: ${directory}`)
  return candidate
}

/**
 * @param {string} candidate
 * @param {unknown} value
 * @returns {string}
 */
function modelFilePath(candidate, value) {
  if (typeof value !== 'string' || !value.startsWith(ASSET_PREFIX)) {
    throw new Error('URL модели должен начинаться с /assets/models/environment/')
  }
  const encoded = value.slice(ASSET_PREFIX.length)
  if (!encoded || encoded.includes('?') || encoded.includes('#')) throw new Error(`Некорректный URL модели: ${value}`)
  let pathname
  try {
    pathname = decodeURIComponent(encoded)
  } catch {
    throw new Error(`Некорректное кодирование URL модели: ${value}`)
  }
  if (pathname.includes('\0')) throw new Error(`Некорректный URL модели: ${value}`)
  const parts = pathname.split(/[\\/]/u)
  if (parts.length < 2 || !['quaternius', 'kenney'].includes(parts[0])
    || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Модель должна лежать в quaternius или kenney: ${value}`)
  }
  const file = parts.at(-1)
  if (!file || extname(file).toLowerCase() !== '.glb') throw new Error(`Ожидается GLB-модель: ${value}`)
  const target = resolve(candidate, pathname)
  return assertInside(candidate, target)
}

/** @param {string} directory */
async function loadCandidate(directory) {
  const root = await candidateDirectory(directory)
  const manifestPath = join(root, OUTPUT_MANIFEST)
  const manifestRealPath = await realpath(manifestPath)
  assertInside(root, manifestRealPath)
  let manifest
  let manifestBytes
  try {
    manifestBytes = await readFile(manifestRealPath)
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error(`Не удалось прочитать manifest.json кандидата: ${error.message}`)
  }
  if (!isRecord(manifest) || !isRecord(manifest.build) || manifest.build.schema !== CANDIDATE_SCHEMA) {
    throw new Error(`manifest.json не помечен как ${CANDIDATE_SCHEMA}`)
  }
  if (!Array.isArray(manifest.models) || !manifest.models.length) throw new Error('В кандидате нет моделей')
  if (manifest.models.length > (MAX_ATLAS_HEIGHT / TILE) * COLUMNS) throw new Error('В кандидате слишком много моделей')
  const keys = new Set()
  for (const model of manifest.models) {
    if (!isRecord(model) || typeof model.key !== 'string' || !model.key || keys.has(model.key)) {
      throw new Error('У моделей кандидата должны быть уникальные ключи')
    }
    keys.add(model.key)
    modelFilePath(root, model.url)
  }
  return { root, manifest, manifestBytes }
}

/** @param {string} encoded */
function decodePath(encoded) {
  try {
    const decoded = decodeURIComponent(encoded)
    if (decoded.includes('\0')) throw new Error('NUL')
    return decoded
  } catch {
    throw new HttpError(400, 'Некорректное кодирование пути')
  }
}

/** @param {string} base @param {string} target */
async function safeStaticPath(base, target) {
  try { assertInside(base, target) } catch { throw new HttpError(400, 'Путь вне каталога') }
  let actual
  try {
    actual = await realpath(target)
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Файл не найден')
    throw error
  }
  try { assertInside(base, actual) } catch { throw new HttpError(400, 'Путь вне каталога') }
  const details = await stat(actual)
  if (!details.isFile()) throw new HttpError(404, 'Файл не найден')
  return actual
}

/** @param {string} base @param {string} prefix @param {string} pathname */
async function staticFile(base, prefix, pathname) {
  const decoded = decodePath(pathname.slice(prefix.length))
  const target = resolve(base, decoded)
  const actual = await safeStaticPath(base, target)
  const type = TYPES[extname(actual).toLowerCase()]
  if (!type) throw new HttpError(404, 'Тип файла запрещён')
  return { bytes: await readFile(actual), type }
}

/** @param {unknown} value */
function scriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

/** @param {Record<string, unknown>} manifest @param {string} token */
function page(manifest, token) {
  const models = scriptJson(manifest.models)
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Атлас 2D из 3D</title>
<style>body{background:#292722;color:#eee;font:16px system-ui;margin:24px}button{font:inherit;padding:8px 16px}canvas{max-width:100%;background:#454139}#status{margin:16px 0}</style>
<h1>Атлас предметов из игровых моделей</h1><button id="render">Создать 2D-виды</button><div id="status">${manifest.models.length} моделей. Камера смотрит строго сверху.</div><div id="preview"></div>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
const models = ${models};
const button = document.querySelector('#render'), status = document.querySelector('#status');
function disposeGroup(group) {
 const geometries = new Set(), materials = new Set(), textures = new Set();
 group.traverse(object => { if (!object.isMesh) return; if (object.geometry) geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) { if (!material) continue; materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value); } });
 textures.forEach(texture => texture.dispose()); materials.forEach(material => material.dispose()); geometries.forEach(geometry => geometry.dispose());
}
button.onclick = async () => {
 button.disabled = true;
 try {
  const tile = 256, columns = 8, atlas = document.createElement('canvas');
  atlas.width = tile * columns; atlas.height = Math.max(tile, Math.ceil(models.length / columns) * tile);
  const context = atlas.getContext('2d'); if (!context) throw new Error('Не удалось создать 2D-контекст'); document.querySelector('#preview').replaceChildren(atlas);
  const crop = document.createElement('canvas'); crop.width = tile; crop.height = tile; const pixels = crop.getContext('2d',{willReadFrequently:true});
  if (!pixels) throw new Error('Не удалось создать контекст чтения пикселей');
  const frames = {}, renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:true});
  try {
   renderer.setSize(tile,tile); renderer.setPixelRatio(1); renderer.setClearColor(0,0);
   renderer.outputColorSpace = THREE.SRGBColorSpace;
   renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
   const scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xfff4df,0x574637,2.2));
   const light = new THREE.DirectionalLight(0xffffff,3); light.position.set(-3,8,-5); scene.add(light);
   const camera = new THREE.OrthographicCamera(-1,1,1,-1,.01,10000); camera.up.set(0,0,-1);
   const loader = new GLTFLoader();
   for (let index=0;index<models.length;index++) {
    const entry = models[index]; status.textContent = (index+1)+' / '+models.length+' — '+entry.label; let group = null;
    try {
     const gltf = await loader.loadAsync(entry.url); group = new THREE.Group(); group.add(gltf.scene); group.rotation.y = (entry.yaw || 0)*Math.PI/180;
     const box = new THREE.Box3().setFromObject(group), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
     const span = Math.max(size.x,size.z,.01)*1.04;
     camera.left=-span/2; camera.right=span/2; camera.top=span/2; camera.bottom=-span/2;
     camera.position.set(center.x,box.max.y+Math.max(10,span),center.z); camera.lookAt(center); camera.updateProjectionMatrix();
     scene.add(group); renderer.render(scene,camera);
     pixels.clearRect(0,0,tile,tile); pixels.drawImage(renderer.domElement,0,0);
     const rgba=pixels.getImageData(0,0,tile,tile).data; let left=tile,top=tile,right=-1,bottom=-1;
     for(let y=0;y<tile;y++)for(let x=0;x<tile;x++)if(rgba[(y*tile+x)*4+3]>8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
     if(right<left) throw new Error('Пустой вид сверху: '+entry.key);
     const x=(index%columns)*tile,y=Math.floor(index/columns)*tile,w=right-left+1,h=bottom-top+1;
     context.drawImage(crop,left,top,w,h,x,y,w,h); frames[entry.key]={x,y,w,h};
    } finally {
     if (group) { scene.remove(group); disposeGroup(group); }
    }
   }
  } finally {
   renderer.dispose();
  }
  const response = await fetch('/save/${token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({frames,image:atlas.toDataURL('image/png')})});
  if(!response.ok)throw new Error(await response.text());
  status.textContent='Готово: '+models.length+' моделей и 2D-изображений сохранены.';
 } catch(error) {status.textContent='Ошибка: '+error.message; button.disabled=false;}
};
</script></html>`
}

/** @param {import('node:http').IncomingMessage} request */
async function requestBody(request) {
  const declared = Number(request.headers['content-length'])
  if (Number.isSafeInteger(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'Атлас слишком большой')
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Атлас слишком большой')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

/** @param {{width:number,height:number,data:Uint8Array}} image @param {{x:number,y:number,w:number,h:number}} frame */
function hasAlpha(image, frame) {
  for (let y = frame.y; y < frame.y + frame.h; y += 1) {
    for (let x = frame.x; x < frame.x + frame.w; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 0) return true
    }
  }
  return false
}

/** @param {Record<string, unknown>} payload @param {Record<string, unknown>} manifest */
function validatePayload(payload, manifest) {
  if (!isRecord(payload) || typeof payload.image !== 'string' || !isRecord(payload.frames)) {
    throw new HttpError(400, 'Ожидаются image и frames')
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(payload.image)
  if (!match || match[1].length % 4 !== 0) throw new HttpError(400, 'Ожидается PNG в data URI')
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length < 24 || !PNG_SIGNATURE.equals(bytes.subarray(0, 8))) throw new HttpError(400, 'Ожидается PNG в data URI')
  const expectedHeight = Math.max(TILE, Math.ceil(manifest.models.length / COLUMNS) * TILE)
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width !== ATLAS_WIDTH || height !== expectedHeight || height > MAX_ATLAS_HEIGHT) {
    throw new HttpError(400, `Неверный размер атласа: ожидался ${ATLAS_WIDTH}×${expectedHeight}`)
  }
  let image
  try {
    image = decodePng(bytes)
  } catch (error) {
    throw new HttpError(400, `Некорректный PNG: ${error.message}`)
  }
  if (image.width !== ATLAS_WIDTH || image.height !== expectedHeight || image.height > MAX_ATLAS_HEIGHT) {
    throw new HttpError(400, `Неверный размер атласа: ожидался ${ATLAS_WIDTH}×${expectedHeight}`)
  }
  const known = new Set(manifest.models.map((model) => model.key))
  const unknown = Object.keys(payload.frames).filter((key) => !known.has(key))
  if (unknown.length) throw new HttpError(400, `Неизвестные кадры: ${unknown.join(', ')}`)
  for (const model of manifest.models) {
    const frame = payload.frames[model.key]
    if (!isRecord(frame) || !['x', 'y', 'w', 'h'].every((key) => Number.isSafeInteger(frame[key]))) {
      throw new HttpError(400, `Нет кадра ${model.key}`)
    }
    if (frame.x < 0 || frame.y < 0 || frame.w < 1 || frame.h < 1
      || frame.w > TILE || frame.h > TILE
      || frame.x + frame.w > image.width || frame.y + frame.h > image.height) {
      throw new HttpError(400, `Кадр вне атласа: ${model.key}`)
    }
    if (!hasAlpha(image, /** @type {{x:number,y:number,w:number,h:number}} */ (frame))) {
      throw new HttpError(400, `Пустой кадр: ${model.key}`)
    }
  }
  return image
}

/** @param {string} path */
async function present(path) {
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink()) return true
    return details.isFile()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** @param {string} path @param {string} root */
async function assertOutputPath(path, root) {
  try {
    const target = await realpath(path)
    assertInside(root, target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** @param {string} root @param {Buffer} image @param {string} text @param {Buffer} expectedManifest */
async function writeCandidate(root, image, text, expectedManifest) {
  const imagePath = join(root, OUTPUT_IMAGE)
  const manifestPath = join(root, OUTPUT_MANIFEST)
  await assertOutputPath(imagePath, root)
  await assertOutputPath(manifestPath, root)
  const suffix = `.${process.pid}.${randomUUID()}`
  const imageTemp = join(root, `.topdown${suffix}.png.tmp`)
  const manifestTemp = join(root, `.manifest${suffix}.json.tmp`)
  const imageBackup = join(root, `.topdown${suffix}.png.bak`)
  const manifestBackup = join(root, `.manifest${suffix}.json.bak`)
  let imageBacked = false
  let manifestBacked = false
  let imageMoved = false
  let manifestMoved = false
  let rollbackIncomplete = false
  const rollbackErrors = []
  try {
    await writeFile(imageTemp, image, { flag: 'wx' })
    await writeFile(manifestTemp, text, { flag: 'wx' })
    const currentManifest = await readFile(manifestPath)
    if (!currentManifest.equals(expectedManifest)) throw new HttpError(409, 'manifest кандидата изменился; перезапустите рендер')
    if (await present(imagePath)) { await rename(imagePath, imageBackup); imageBacked = true }
    await rename(imageTemp, imagePath); imageMoved = true
    if (await present(manifestPath)) { await rename(manifestPath, manifestBackup); manifestBacked = true }
    await rename(manifestTemp, manifestPath); manifestMoved = true
  } catch (error) {
    const removeNewFile = async (path, moved) => {
      if (!moved) return
      try { await unlink(path) } catch (rollbackError) {
        rollbackIncomplete = true
        rollbackErrors.push(`не удалось убрать ${path}: ${rollbackError.message}`)
      }
    }
    const restoreBackup = async (path, target, backed) => {
      if (!backed) return
      try {
        await rename(path, target)
        if (target === imagePath) imageBacked = false
        if (target === manifestPath) manifestBacked = false
      } catch (rollbackError) {
        rollbackIncomplete = true
        rollbackErrors.push(`не удалось вернуть ${path} в ${target}: ${rollbackError.message}`)
      }
    }
    await removeNewFile(manifestPath, manifestMoved)
    await removeNewFile(imagePath, imageMoved)
    await restoreBackup(manifestBackup, manifestPath, manifestBacked)
    await restoreBackup(imageBackup, imagePath, imageBacked)
    if (rollbackIncomplete) {
      const retained = [
        ...(imageBacked ? [imageBackup] : []),
        ...(manifestBacked ? [manifestBackup] : []),
      ]
      const paths = retained.length ? retained.join(', ') : `${imageBackup}, ${manifestBackup}`
      throw new Error(`Не удалось откатить запись кандидата: ${rollbackErrors.join('; ')}. Резервные копии оставлены по путям: ${paths}`, { cause: error })
    }
    throw error
  } finally {
    await unlink(imageTemp).catch(() => {})
    await unlink(manifestTemp).catch(() => {})
    if (!rollbackIncomplete) {
      await unlink(imageBackup).catch(() => {})
      await unlink(manifestBackup).catch(() => {})
    }
  }
  return { imagePath, manifestPath }
}

/** @param {{root:string,manifestBytes:Buffer}} candidate */
async function assertManifestUnchanged(candidate) {
  const manifestPath = join(candidate.root, OUTPUT_MANIFEST)
  try {
    await assertOutputPath(manifestPath, candidate.root)
    const current = await readFile(manifestPath)
    if (!current.equals(candidate.manifestBytes)) throw new HttpError(409, 'manifest кандидата изменился; перезапустите рендер')
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error.code === 'ENOENT') throw new HttpError(409, 'manifest кандидата исчез; перезапустите рендер')
    throw error
  }
}

/** @param {string} threeRoot @returns {Promise<string|undefined>} */
async function installedThreeVersion(threeRoot) {
  try {
    const packageJson = JSON.parse(await readFile(join(threeRoot, 'package.json'), 'utf8'))
    return typeof packageJson.version === 'string' && packageJson.version ? packageJson.version : undefined
  } catch {
    return undefined
  }
}

/** @param {import('node:http').Server} server */
function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error)
      else resolveClose()
    })
  })
}

/**
 * Запускает локальный staged-рендерер. В candidate ничего не пишется до
 * принятия полного валидного PNG; callback вызывается после атомарной записи.
 *
 * @param {{directory: string, port?: number, onSaved?: (details: {directory:string,imagePath:string,manifestPath:string,manifest:Record<string,unknown>}) => void|Promise<void>}} options
 * @returns {Promise<{url:string,close:()=>Promise<void>}>}
 */
export async function startPropModelAtlas({ directory, port = 0, onSaved } = {}) {
  if (onSaved !== undefined && typeof onSaved !== 'function') throw new Error('onSaved должен быть функцией')
  const candidate = await loadCandidate(directory)
  const threeRoot = await realpath(THREE_ROOT)
  const threeVersion = await installedThreeVersion(threeRoot)
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65_535) throw new Error(`Некорректный порт: ${port}`)
  const token = randomUUID()
  let origin = ''
  let saveQueue = Promise.resolve()
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    try {
      const url = new URL(request.url ?? '/', origin)
      if (request.method === 'POST' && url.pathname === `/save/${token}`) {
        if (request.headers.origin !== origin) throw new HttpError(403, 'Неверный источник запроса')
        const body = await requestBody(request)
        let payload
        try { payload = JSON.parse(body.toString('utf8')) } catch { throw new HttpError(400, 'Некорректный JSON') }
        const save = saveQueue.then(async () => {
          await assertManifestUnchanged(candidate)
          const decoded = validatePayload(payload, candidate.manifest)
          const nextManifest = structuredClone(candidate.manifest)
          nextManifest.build = { ...candidate.manifest.build, atlasRendererVersion: 1 }
          if (threeVersion) nextManifest.build.threeVersion = threeVersion
          nextManifest.models = candidate.manifest.models.map((model) => ({
            ...model,
            preview: { ...(isRecord(model.preview) ? model.preview : {}), ...payload.frames[model.key] },
          }))
          const png = encodePng(decoded)
          nextManifest.atlas = {
            ...(isRecord(candidate.manifest.atlas) ? candidate.manifest.atlas : {}),
            image: `${ASSET_PREFIX}${OUTPUT_IMAGE}`,
            key: createHash('sha256').update(png).digest('hex'),
          }
          const paths = await writeCandidate(candidate.root, png, `${JSON.stringify(nextManifest, null, 2)}\n`, candidate.manifestBytes)
          if (onSaved) await onSaved({ directory: candidate.root, ...paths, manifest: nextManifest })
        })
        saveQueue = save.catch(() => {})
        await save
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('ok'); return
      }
      if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается')
      if (url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page(candidate.manifest, token)); return
      }
      let file
      if (url.pathname.startsWith(THREE_PREFIX)) file = await staticFile(threeRoot, THREE_PREFIX, url.pathname)
      else if (url.pathname.startsWith(ASSET_PREFIX)) file = await staticFile(candidate.root, ASSET_PREFIX, url.pathname)
      else throw new HttpError(404, 'Страница не найдена')
      response.writeHead(200, { 'Content-Type': file.type }); response.end(file.bytes)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (!response.headersSent) { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(error.message) }
      else response.destroy()
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    const failed = (error) => { server.off('listening', started); rejectListen(error) }
    const started = () => { server.off('error', failed); resolveListen() }
    server.once('error', failed); server.once('listening', started); server.listen(numericPort, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') { await closeServer(server); throw new Error('Не удалось узнать порт staged-рендера') }
  origin = `http://127.0.0.1:${address.port}`
  return { url: origin, close: () => closeServer(server) }
}

/** @param {string[]} argv */
function cliOptions(argv) {
  let directory = null
  let port = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dir' || argument === '--port') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${argument} требует значение`)
      if (argument === '--dir') { if (directory !== null) throw new Error('--dir указан дважды'); directory = argv[index + 1] }
      else { if (port !== null) throw new Error('--port указан дважды'); port = argv[index + 1] }
      index += 1
    } else if (argument.startsWith('--dir=')) {
      if (directory !== null) throw new Error('--dir указан дважды'); directory = argument.slice(6)
    } else if (argument.startsWith('--port=')) {
      if (port !== null) throw new Error('--port указан дважды')
      port = argument.slice(7)
      if (!port) throw new Error('--port требует значение')
    } else {
      throw new Error(`Неизвестный аргумент: ${argument}`)
    }
  }
  if (directory === null) throw new Error('CLI требует --dir <candidate>')
  return { directory, port: Number(port ?? (process.env.PROP_ATLAS_PORT || DEFAULT_PORT)) }
}

async function main() {
  try {
    const started = await startPropModelAtlas(cliOptions(process.argv.slice(2)))
    process.stdout.write(`Откройте ${started.url} и нажмите «Создать 2D-виды».\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
