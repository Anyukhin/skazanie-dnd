import * as THREE from 'three'
import { createActorModel, figureHeightFor, loadActorModelManifest, resolveModelProfile, type ActorModelInput } from '../src/actor-models'

type Figure = { actor: ActorModelInput; side: number }
type AtlasMode = 'color' | 'scale' | 'silhouette'
const tile = 164
const picture = tile - 30
const columns = 8

/** Снимает цвет и контур теми же моделями, загрузчиком и масштабом, что на доске. */
export async function drawAstohanFigureAtlas(figures: Figure[], mode: AtlasMode) {
  const rows = Math.ceil(figures.length / columns)
  const width = columns * tile
  const height = rows * tile
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(width, height)
  renderer.setClearColor(mode === 'silhouette' ? '#ffffff' : '#d2c6ad')
  renderer.clear()
  renderer.setScissorTest(true)
  const page = document.createElement('div')
  page.style.cssText = 'position:relative;width:max-content;font:13px system-ui;color:#20180f'
  page.append(renderer.domElement)
  document.body.style.cssText = 'margin:0;background:#d2c6ad;overflow:auto'
  document.body.replaceChildren(page)
  const gl = renderer.getContext()
  const adapter = gl.getExtension('WEBGL_debug_renderer_info')
  const manifest = await loadActorModelManifest()
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight('#fff5db', '#6b584e', 2.7))
  const key = new THREE.DirectionalLight('#fff4e3', 2.2)
  key.position.set(2, 4, 3)
  scene.add(key)
  const ink = new THREE.MeshBasicMaterial({ color: '#141311', side: THREE.DoubleSide })
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 50)
  const pixels = new Uint8Array(tile * picture * 4)
  const captures = []
  try {
    for (const [index, { actor, side }] of figures.entries()) {
      const entry = resolveModelProfile(actor, manifest)
      const stature = actor.appearance?.version === 2 ? actor.appearance.stature : undefined
      const heightInCells = figureHeightFor(entry.height ?? 1.25, entry.profile, side, stature)
      const model = await createActorModel(actor, { manifest, height: heightInCells })
      try {
        await model.equipmentReady
        model.setPose('idle', 0)
        scene.add(model)
        const box = new THREE.Box3().setFromObject(model, true)
        const dimensions = box.getSize(new THREE.Vector3()).toArray()
        const center = box.getCenter(new THREE.Vector3())
        const x = index % columns * tile
        const y = height - (Math.floor(index / columns) + 1) * tile
        renderer.setViewport(x, y + 30, tile, picture)
        renderer.setScissor(x, y + 30, tile, picture)
        const frame = (degrees: number, relative: boolean) => {
          const half = relative ? Math.max(...dimensions) * .60 : 2.8
          camera.top = half
          camera.bottom = -half
          camera.left = -half * tile / picture
          camera.right = half * tile / picture
          const rad = THREE.MathUtils.degToRad(degrees)
          const target = relative ? center : new THREE.Vector3(0, 2.35, 0)
          camera.position.set(target.x + 8 * Math.sin(rad), target.y + 2.3, target.z + 8 * Math.cos(rad))
          camera.lookAt(target)
          camera.updateProjectionMatrix()
        }
        const hashes = [35, 145].map((degrees) => {
          frame(degrees, false)
          scene.overrideMaterial = ink
          renderer.setClearColor('#ffffff')
          renderer.render(scene, camera)
          gl.readPixels(x, y + 30, tile, picture, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
          let hash = 0x811c9dc5
          let count = 0
          for (let p = 0; p < pixels.length; p += 4) {
            const covered = pixels[p] < 224
            count += Number(covered)
            hash = Math.imul(hash ^ Number(covered), 0x01000193)
          }
          return { hash: (hash >>> 0).toString(16), pixels: count }
        })
        scene.overrideMaterial = mode === 'silhouette' ? ink : null
        renderer.setClearColor(mode === 'silhouette' ? '#ffffff' : '#d2c6ad')
        frame(35, mode === 'color')
        renderer.render(scene, camera)
        const caption = document.createElement('span')
        caption.textContent = mode === 'scale' ? `${actor.label} · ${(heightInCells * 5).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} фт` : actor.label
        caption.style.cssText = `position:absolute;left:${x}px;top:${height - y - 27}px;width:${tile}px;text-align:center;line-height:14px`
        page.append(caption)
        if (mode === 'scale') {
          const scaleBar = document.createElement('span')
          const oneCell = picture / 5.6 * Math.cos(Math.atan2(2.3, 8))
          scaleBar.textContent = '5 фт'
          scaleBar.style.cssText = `position:absolute;left:${x + 8}px;top:${height - y - 40 - oneCell}px;height:${oneCell}px;padding-left:3px;border-left:1px solid #5b4d3a;font-size:9px`
          page.append(scaleBar)
        }
        captures.push({
          id: actor.id, name: actor.label, key: model.modelKey, source: model.source, expectedSource: entry.url ? 'glb' : 'procedural',
          heightInCells, dimensions, side, hashes,
        })
      } finally {
        scene.remove(model)
        model.dispose()
      }
    }
    return { adapter: adapter ? gl.getParameter(adapter.UNMASKED_RENDERER_WEBGL) as string : null, captures }
  } finally {
    ink.dispose()
    renderer.dispose()
  }
}
