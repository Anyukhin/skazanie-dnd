#!/usr/bin/env node
/** Создание 2D-атласа прямо из игровых GLB. Запуск: node tools/render-prop-model-atlas.mjs. */
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { decodePng, encodePng } from './png-codec.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = resolve(root, 'public/assets/models/environment')
const manifestPath = resolve(output, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const token = randomUUID()
const port = Number(process.env.PROP_ATLAS_PORT || 53902)
const origin = `http://127.0.0.1:${port}`
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Атлас 2D из 3D</title>
<style>body{background:#292722;color:#eee;font:16px system-ui;margin:24px}button{font:inherit;padding:8px 16px}canvas{max-width:100%;background:#454139}#status{margin:16px 0}</style>
<h1>Атлас предметов из игровых моделей</h1><button id="render">Создать 2D-виды</button><div id="status">${manifest.models.length} моделей. Камера смотрит строго сверху.</div><div id="preview"></div>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
const models = ${JSON.stringify(manifest.models).replaceAll('<', '\\u003c')};
const button = document.querySelector('#render'), status = document.querySelector('#status');
button.onclick = async () => {
 button.disabled = true;
 try {
  const tile = 256, columns = 8, atlas = document.createElement('canvas');
  atlas.width = tile * columns; atlas.height = Math.max(tile, Math.ceil(models.length / columns) * tile);
  const context = atlas.getContext('2d'); document.querySelector('#preview').replaceChildren(atlas);
  const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:true});
  renderer.setSize(tile,tile); renderer.setPixelRatio(1); renderer.setClearColor(0,0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
  const scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xfff4df,0x574637,2.2));
  const light = new THREE.DirectionalLight(0xffffff,3); light.position.set(-3,8,-5); scene.add(light);
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,.01,10000); camera.up.set(0,0,-1);
  const loader = new GLTFLoader(), frames = {};
  const crop = document.createElement('canvas'); crop.width = tile; crop.height = tile; const pixels = crop.getContext('2d',{willReadFrequently:true});
  for (let index=0;index<models.length;index++) {
   const entry = models[index]; status.textContent = (index+1)+' / '+models.length+' — '+entry.label;
   const gltf = await loader.loadAsync(entry.url), group = new THREE.Group(); group.add(gltf.scene); group.rotation.y = (entry.yaw || 0)*Math.PI/180;
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
   scene.remove(group); const geometries=new Set(),materials=new Set(),textures=new Set();
   group.traverse(o=>{if(o.isMesh){geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}}});
   textures.forEach(t=>t.dispose()); materials.forEach(m=>m.dispose()); geometries.forEach(g=>g.dispose());
  }
  renderer.dispose();
  const response = await fetch('/save/${token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({frames,image:atlas.toDataURL('image/png')})});
  if(!response.ok)throw new Error(await response.text());
  status.textContent='Готово: '+models.length+' моделей и 2D-изображений сохранены.';
 } catch(error) {status.textContent='Ошибка: '+error.message; button.disabled=false;}
};
</script></html>`

const types = { '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.json': 'application/json' }
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  try {
    const url = new URL(request.url, origin)
    if (request.method === 'POST' && url.pathname === `/save/${token}`) {
      if (request.headers.origin !== origin) throw new Error('Неверный источник запроса')
      const chunks = []; let length = 0
      for await (const chunk of request) { length += chunk.length; if (length > 32_000_000) throw new Error('Атлас слишком большой'); chunks.push(chunk) }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!/^data:image\/png;base64,/.test(payload.image)) throw new Error('Ожидается PNG')
      const decoded = decodePng(Buffer.from(payload.image.split(',')[1], 'base64'))
      if (decoded.width !== 2048 || decoded.height > 16384) throw new Error('Неверный размер атласа')
      for (const entry of manifest.models) {
        const frame = payload.frames[entry.key]
        if (!frame || !['x', 'y', 'w', 'h'].every((key) => Number.isInteger(frame[key]) && frame[key] >= 0)
          || frame.w < 1 || frame.h < 1 || frame.x + frame.w > decoded.width || frame.y + frame.h > decoded.height) throw new Error(`Нет кадра ${entry.key}`)
        entry.preview = frame
      }
      const image = encodePng(decoded)
      await writeFile(resolve(output, 'topdown.png'), image)
      manifest.atlas = { image: '/assets/models/environment/topdown.png', key: createHash('sha256').update(image).digest('hex') }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      response.writeHead(200); response.end('ok')
      process.stdout.write(`Сохранено ${manifest.models.length} кадров: ${image.length} байт\n`)
      return
    }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return }
    const base = url.pathname.startsWith('/three/') ? resolve(root, 'node_modules/three') : resolve(root, 'public/assets/models/environment')
    const prefix = url.pathname.startsWith('/three/') ? '/three/' : '/assets/models/environment/'
    if (!url.pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return }
    const path = resolve(base, decodeURIComponent(url.pathname.slice(prefix.length)))
    if (!path.startsWith(base + sep)) throw new Error('Путь вне каталога')
    const extension = path.slice(path.lastIndexOf('.'))
    if (!types[extension]) throw new Error('Неподдерживаемый файл')
    response.setHeader('Content-Type', types[extension]); response.end(await readFile(path))
  } catch (error) { response.writeHead(400); response.end(error.message) }
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`Откройте ${origin} и нажмите «Создать 2D-виды».\n`))
