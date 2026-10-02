#!/usr/bin/env node
/** Локальный инспектор авторских GLB-ассетов карты. */
import { createServer } from 'node:http'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_DIRECTORY = resolve(ROOT, 'public/assets/maps/detail-v1')
const THREE_DIRECTORY = resolve(ROOT, 'node_modules/three')
const THREE_PREFIX = '/three/'
const MODEL_PREFIX = '/model/'
const DEFAULT_MODEL_ID = 'ballista'
const MODEL_ID_PATTERN = /^[A-Za-z0-9_-]+$/u
const CONTENT_TYPES = Object.freeze({
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
})

class HttpError extends Error {
  /** @param {number} status @param {string} message */
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
function isInside(base, target) {
  const distance = relative(base, target)
  return distance !== '' && distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance)
}

/** @param {string} base @param {string} target */
function assertInside(base, target) {
  if (!isInside(base, target)) throw new Error(`Путь вне разрешённого каталога: ${target}`)
  return target
}

/** @param {string} value */
function decodePath(value) {
  let decoded
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'Некорректное кодирование пути')
  }
  if (decoded.includes('\0')) throw new HttpError(400, 'Некорректный путь')
  return decoded
}

/** @param {string} directory */
async function loadManifest(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Нужен каталог ассетов')
  const requested = resolve(directory)
  const details = await lstat(requested)
  if (!details.isDirectory()) throw new Error(`Каталог ассетов не найден: ${directory}`)
  const root = await realpath(requested)
  const manifestPath = await realpath(join(root, 'manifest.json'))
  assertInside(root, manifestPath)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Не удалось прочитать manifest.json: ${error.message}`)
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error('manifest.json не содержит models')
  }

  /** @type {Map<string, {id:string,file:string,dimensions:[number,number,number],description:string,triangles:number,path:string}>} */
  const models = new Map()
  for (const raw of manifest.models) {
    if (!isRecord(raw)
      || typeof raw.id !== 'string'
      || !MODEL_ID_PATTERN.test(raw.id)
      || models.has(raw.id)
      || typeof raw.file !== 'string'
      || raw.file !== `models/${raw.id}.glb`
      || !Array.isArray(raw.dimensions)
      || raw.dimensions.length !== 3
      || raw.dimensions.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      || typeof raw.description !== 'string'
      || typeof raw.triangles !== 'number'
      || !Number.isSafeInteger(raw.triangles)
      || raw.triangles < 0) {
      throw new Error('Некорректная запись модели в manifest.json')
    }
    const requestedModel = resolve(root, raw.file)
    assertInside(root, requestedModel)
    const modelPath = await realpath(requestedModel)
    assertInside(root, modelPath)
    const modelDetails = await stat(modelPath)
    if (!modelDetails.isFile() || extname(modelPath).toLowerCase() !== '.glb') {
      throw new Error(`Файл модели не найден: ${raw.file}`)
    }
    models.set(raw.id, {
      id: raw.id,
      file: raw.file,
      dimensions: /** @type {[number, number, number]} */ (raw.dimensions),
      description: raw.description,
      triangles: raw.triangles,
      path: modelPath,
    })
  }
  return { root, manifest, models }
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

/** @param {Map<string, {id:string,file:string,dimensions:[number,number,number],description:string,triangles:number,path:string}>} models */
function page(models) {
  const entries = [...models.values()].map(({ id, file, dimensions, description, triangles }) => ({
    id, file, dimensions, description, triangles,
    url: `${MODEL_PREFIX}${encodeURIComponent(id)}.glb`,
  }))
  const defaultId = models.has(DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : entries[0]?.id
  const entriesJson = scriptJson(entries)
  const defaultIdJson = scriptJson(defaultId)
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3D-модели деталей карты</title>
<style>
:root{color-scheme:dark;--rail:#211c17;--rail-deep:#17130f;--line:#4c4033;--text:#e7dccb;--muted:#aa9b89;--accent:#c99858;--viewport:#d0d1cc;--viewport-line:#a8aaa4}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{overflow:hidden;background:var(--rail-deep);color:var(--text);font:400 15px/1.4 system-ui,sans-serif}
button,input,select{font:inherit}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.viewer{display:grid;grid-template-columns:260px minmax(0,1fr);height:100%}
.sidebar{display:flex;min-width:0;flex-direction:column;border-right:1px solid var(--line);background:var(--rail)}
.sidebar-header{padding:22px 20px 16px;border-bottom:1px solid var(--line)}
.sidebar-header h1{margin:0;color:var(--text);font-size:21px;line-height:1.15;font-weight:700}
.sidebar-header p{margin:7px 0 0;color:var(--muted);font-size:13px}
.controls{padding:16px 16px 12px}
.controls label{display:block;margin-bottom:6px;color:var(--muted);font-size:13px}
#search{width:100%;height:36px;padding:0 10px;border:1px solid var(--line);border-radius:4px;background:var(--rail-deep);color:var(--text)}
#model-list{display:block;width:100%;height:calc(100vh - 210px);min-height:210px;margin-top:12px;padding:3px;border:1px solid var(--line);border-radius:4px;background:var(--rail-deep);color:var(--text);font-size:14px}
#model-list option{padding:7px 8px;white-space:normal}
#model-list option:checked{background:#765530;color:#fff3dc}
.sidebar-footer{margin-top:auto;padding:12px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.workspace{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0;background:var(--viewport)}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 16px;border-bottom:1px solid var(--viewport-line);background:#e0e1dc;color:#383a36}
.model-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-title strong{font-size:18px;font-weight:700}
.model-title span{margin-left:10px;color:#656862;font-size:13px}
.view-buttons{display:flex;flex:0 0 auto;gap:6px}
.view-buttons button{height:32px;padding:0 11px;border:1px solid #989b94;border-radius:4px;background:#e9eae6;color:#40423d;cursor:pointer}
.view-buttons button:hover{background:#f3f3f0}
.view-buttons button[aria-pressed="true"]{border-color:#765530;background:#765530;color:#fff3dc}
.viewport{position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--viewport)}
#canvas-wrap{position:absolute;inset:0}
#canvas-wrap canvas{display:block;width:100%;height:100%}
.model-info{position:absolute;right:16px;bottom:16px;width:min(340px,calc(100% - 32px));padding:12px 14px;border:1px solid #a5a7a1;background:rgba(244,244,240,.94);color:#3b3d39;pointer-events:none}
.model-info dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:13px}
.model-info dt{color:#686b65}
.model-info dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.model-info p{margin:10px 0 0;color:#565a54;font-size:13px;line-height:1.35}
#status{position:absolute;left:16px;bottom:16px;max-width:min(430px,calc(100% - 32px));padding:7px 10px;border:1px solid #a5a7a1;background:rgba(244,244,240,.94);color:#565a54;font-size:13px}
#status[data-error="true"]{border-color:#a45345;color:#8c3328}
@media(max-width:720px){.viewer{grid-template-columns:230px minmax(0,1fr)}.toolbar{align-items:flex-start;flex-direction:column}.view-buttons{width:100%}.view-buttons button{flex:1}}
</style>
</head>
<body>
<main class="viewer">
<aside class="sidebar" aria-label="Список моделей">
  <div class="sidebar-header"><h1>Детали карты</h1><p>Просмотр авторских GLB-моделей</p></div>
  <div class="controls">
    <label for="search">Поиск моделей</label>
    <input id="search" type="search" autocomplete="off" placeholder="Например, ballista">
    <select id="model-list" size="12" aria-label="Модели карты"></select>
  </div>
  <div class="sidebar-footer"><span id="model-count"></span> · выбор клавишами ↑ ↓</div>
</aside>
<section class="workspace" aria-label="Просмотр модели">
  <header class="toolbar">
    <div class="model-title"><strong id="model-name">Загрузка…</strong><span id="model-file"></span></div>
    <div class="view-buttons" aria-label="Ракурс">
      <button type="button" data-view="iso" aria-pressed="true">Изометрия</button>
      <button type="button" data-view="top" aria-pressed="false">Сверху</button>
      <button type="button" data-view="front" aria-pressed="false">Спереди</button>
      <button type="button" id="reset" aria-pressed="false">Сбросить</button>
    </div>
  </header>
  <div class="viewport" id="viewport">
    <div id="canvas-wrap"></div>
    <div class="model-info" id="model-info" aria-live="polite"></div>
    <div id="status" role="status" aria-live="polite">Готовим сцену…</div>
  </div>
</section>
</main>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

const models = ${entriesJson};
const defaultModelId = ${defaultIdJson};
const byId = new Map(models.map((model) => [model.id, model]));
const list = document.querySelector('#model-list');
const search = document.querySelector('#search');
const status = document.querySelector('#status');
const viewport = document.querySelector('#viewport');
const canvasWrap = document.querySelector('#canvas-wrap');
const modelInfo = document.querySelector('#model-info');
const modelName = document.querySelector('#model-name');
const modelFile = document.querySelector('#model-file');
const modelCount = document.querySelector('#model-count');
const viewButtons = [...document.querySelectorAll('[data-view]')];

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d0d1cc');
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
camera.up.set(0, 1, 0);
const renderer = new THREE.WebGLRenderer({antialias: true, alpha: false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(room, .04).texture;
scene.environmentIntensity = .65;
room.dispose();
pmrem.dispose();
canvasWrap.append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.minDistance = .01;
const hemisphere = new THREE.HemisphereLight(0xfff7e8, 0x69706d, 2.25);
scene.add(hemisphere);
const keyLight = new THREE.DirectionalLight(0xfff5df, 3.2);
keyLight.position.set(4, 7, 5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -.0002;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xdde7ff, .8);
fillLight.position.set(-4, 3, -3);
scene.add(fillLight);
let grid = null;
let ground = null;
let currentModel = null;
let currentModelId = null;
let currentBox = null;
let generation = 0;
let activeView = 'iso';
const loader = new GLTFLoader();

function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = isError ? 'true' : 'false';
}

function disposeObject(object) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (child.geometry) geometries.add(child.geometry);
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

function makeList(filter = '') {
  const needle = filter.trim().toLocaleLowerCase('ru');
  const selected = list.value;
  list.replaceChildren();
  const visible = models.filter((model) => !needle || model.id.toLocaleLowerCase('ru').includes(needle) || model.description.toLocaleLowerCase('ru').includes(needle));
  for (const model of visible) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.id + (/[А-Яа-яЁё]/.test(model.description) ? ' — ' + model.description : '');
    list.append(option);
  }
  if (visible.some((model) => model.id === selected)) list.value = selected;
  else if (visible.length) list.value = visible[0].id;
  modelCount.textContent = visible.length + ' из ' + models.length;
}

function showInfo(model) {
  modelName.textContent = model.id;
  modelFile.textContent = model.file;
  const details = document.createElement('dl');
  for (const [label, value] of [['Габариты', model.dimensions.map((item) => Number(item.toFixed(2))).join(' × ') + ' м'], ['Треугольники', model.triangles.toLocaleString('ru-RU')]]) {
    const term = document.createElement('dt');
    term.textContent = label;
    const data = document.createElement('dd');
    data.textContent = value;
    details.append(term, data);
  }
  const description = document.createElement('p');
  description.textContent = /[А-Яа-яЁё]/.test(model.description) ? model.description : '';
  modelInfo.replaceChildren(details, description);
}

function updateGrid(box) {
  if (ground) { scene.remove(ground); ground.geometry.dispose(); ground.material.dispose(); }
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  const size = Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).z, .5) * 2.4;
  ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({color:'#d0d1cc',roughness:1,metalness:0}));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y - .005;
  ground.receiveShadow = true;
  scene.add(ground);
  grid = new THREE.GridHelper(size, Math.max(4, Math.min(24, Math.round(size * 4))), '#9fa29d', '#b7b9b4');
  grid.position.set(box.getCenter(new THREE.Vector3()).x, box.min.y, box.getCenter(new THREE.Vector3()).z);
  grid.material.transparent = true;
  grid.material.opacity = .52;
  scene.add(grid);
}

function setView(view) {
  if (!currentBox) return;
  delete viewport.dataset.renderedModel;
  delete viewport.dataset.renderedView;
  activeView = view;
  const size = currentBox.getSize(new THREE.Vector3());
  const center = currentBox.getCenter(new THREE.Vector3());
  const maxSpan = Math.max(size.x, size.y, size.z, .01);
  const halfVertical = THREE.MathUtils.degToRad(camera.fov) / 2;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect);
  const radius = currentBox.getBoundingSphere(new THREE.Sphere()).radius;
  const distance = radius / Math.sin(Math.min(halfVertical, halfHorizontal)) * 1.12;
  const direction = view === 'top' ? new THREE.Vector3(0, 1, 0) : view === 'front' ? new THREE.Vector3(0, .12, -1).normalize() : new THREE.Vector3(1, .78, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(.001, maxSpan / 1000);
  camera.far = Math.max(100, maxSpan * 40);
  camera.lookAt(center);
  controls.target.copy(center);
  controls.minDistance = Math.max(.01, maxSpan * .06);
  controls.maxDistance = Math.max(10, maxSpan * 30);
  controls.update();
  viewButtons.forEach((button) => button.setAttribute('aria-pressed', button.dataset.view === view ? 'true' : 'false'));
  renderCurrent();
}

function resize() {
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

async function chooseModel(id) {
  const model = byId.get(id);
  if (!model) return;
  const requestGeneration = ++generation;
  currentModelId = null;
  delete viewport.dataset.renderedModel;
  delete viewport.dataset.renderedView;
  list.value = id;
  showInfo(model);
  setStatus('Загрузка ' + model.id + '…');
  try {
    const gltf = await loader.loadAsync(model.url);
    if (requestGeneration !== generation) {
      disposeObject(gltf.scene);
      return;
    }
    if (currentModel) {
      scene.remove(currentModel);
      disposeObject(currentModel);
    }
    currentModel = gltf.scene;
    currentModelId = id;
    currentModel.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
    currentModel.updateMatrixWorld(true);
    currentBox = new THREE.Box3().setFromObject(currentModel);
    if (currentBox.isEmpty()) throw new Error('Модель не содержит видимой геометрии');
    scene.add(currentModel);
    updateGrid(currentBox);
    setView(activeView);
    setStatus('Модель загружена');
  } catch (error) {
    if (requestGeneration === generation) setStatus('Не удалось загрузить модель: ' + error.message, true);
  }
}

search.addEventListener('input', () => makeList(search.value));
list.addEventListener('change', () => chooseModel(list.value));
viewButtons.forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelector('#reset').addEventListener('click', () => setView('iso'));
const observer = new ResizeObserver(resize);
observer.observe(viewport);
makeList();
list.value = defaultModelId;
resize();
chooseModel(defaultModelId);
function renderCurrent() {
  controls.update();
  renderer.render(scene, camera);
  if (currentModelId) {
    viewport.dataset.renderedModel = currentModelId;
    viewport.dataset.renderedView = activeView;
  }
}
function frame() {
  renderCurrent();
  requestAnimationFrame(frame);
}
frame();
</script>
</body>
</html>`
}

/** @param {string} root @param {string} pathname */
async function readThreeScript(root, pathname) {
  const decoded = decodePath(pathname.slice(THREE_PREFIX.length))
  if (!decoded || decoded.includes('?') || decoded.includes('#') || extname(decoded).toLowerCase() !== '.js') {
    throw new HttpError(404, 'Файл Three.js не найден')
  }
  const requested = resolve(root, decoded)
  try { assertInside(root, requested) } catch { throw new HttpError(400, 'Путь вне каталога Three.js') }
  let actual
  try { actual = await realpath(requested) } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Файл Three.js не найден')
    throw error
  }
  try { assertInside(root, actual) } catch { throw new HttpError(400, 'Путь вне каталога Three.js') }
  const details = await stat(actual)
  if (!details.isFile()) throw new HttpError(404, 'Файл Three.js не найден')
  return { bytes: await readFile(actual), type: CONTENT_TYPES['.js'] }
}

/** @param {Map<string, {id:string,file:string,dimensions:[number,number,number],description:string,triangles:number,path:string}>} models @param {string} pathname */
async function readModel(models, pathname) {
  const encoded = pathname.slice(MODEL_PREFIX.length)
  const decoded = decodePath(encoded)
  const match = /^([A-Za-z0-9_-]+)\.glb$/u.exec(decoded)
  if (!match) throw new HttpError(404, 'Модель не найдена')
  const model = models.get(match[1])
  if (!model) throw new HttpError(404, 'Модель не найдена')
  return { bytes: await readFile(model.path), type: CONTENT_TYPES['.glb'] }
}

/** @param {{directory?:string,port?:number}} [options] @returns {Promise<{url:string,close:()=>Promise<void>}>} */
export async function startMapDetailViewer({ directory = DEFAULT_DIRECTORY, port = 0 } = {}) {
  const assetSet = await loadManifest(directory)
  const threeRoot = await realpath(THREE_DIRECTORY)
  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65_535) throw new Error(`Некорректный порт: ${port}`)
  let origin = ''
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    try {
      if (request.method !== 'GET') throw new HttpError(405, 'Поддерживается только GET')
      const url = new URL(request.url ?? '/', origin)
      if (url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(page(assetSet.models))
        return
      }
      let file
      if (url.pathname.startsWith(THREE_PREFIX)) file = await readThreeScript(threeRoot, url.pathname)
      else if (url.pathname.startsWith(MODEL_PREFIX)) file = await readModel(assetSet.models, url.pathname)
      else throw new HttpError(404, 'Страница не найдена')
      response.writeHead(200, { 'Content-Type': file.type })
      response.end(file.bytes)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (!response.headersSent) {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(error instanceof Error ? error.message : 'Ошибка сервера')
      } else response.destroy()
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    const failed = (error) => { server.off('listening', started); rejectListen(error) }
    const started = () => { server.off('error', failed); resolveListen() }
    server.once('error', failed)
    server.once('listening', started)
    server.listen(numericPort, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise((resolveClose) => server.close(() => resolveClose()))
    throw new Error('Не удалось узнать порт просмотрщика')
  }
  origin = `http://127.0.0.1:${address.port}`
  return {
    url: origin,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error)
      else resolveClose()
    })),
  }
}

/** @param {string[]} argv */
function cliOptions(argv) {
  let directory = DEFAULT_DIRECTORY
  let port = 0
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dir' || argument === '--port') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${argument} требует значение`)
      if (argument === '--dir') directory = argv[++index]
      else port = Number(argv[++index])
    } else if (argument.startsWith('--dir=')) directory = argument.slice('--dir='.length)
    else if (argument.startsWith('--port=')) port = Number(argument.slice('--port='.length))
    else throw new Error(`Неизвестный аргумент: ${argument}`)
  }
  return { directory, port }
}

async function main() {
  try {
    const started = await startMapDetailViewer(cliOptions(process.argv.slice(2)))
    process.stdout.write(`Откройте ${started.url} для просмотра 3D-моделей.\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()
