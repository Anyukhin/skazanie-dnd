import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { RotateCcw } from 'lucide-react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  availableActorModels,
  createActorModel,
  DEFAULT_ACTOR_MODEL_MANIFEST,
  loadActorModelManifest,
  type ActorModel,
  type ActorModelManifest,
} from './actor-models'
import type { ActorAppearance, InventoryItem, Player } from './types'
import { itemVisualForCatalogId, publicLoadoutForItems } from '../server/equipment-visuals.mjs'
import type { PublicLoadout } from '../server/equipment-visuals.mjs'
import './equipment-preview.css'

type PreviewRuntime = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  actor: THREE.Group
  frameId: number
  lastTime: number
  model?: ActorModel
  resizeObserver?: ResizeObserver
  intersectionObserver?: IntersectionObserver
  intersectionVisible: boolean
  documentVisible: boolean
  reducedMotion: boolean
  renderNow: () => void
  fitCamera: () => void
}

type PreviewStatus = 'loading' | 'ready' | 'fallback' | 'error' | 'equipment-error' | 'unavailable'

const MODEL_STORAGE_PREFIX = 'skazanie-3d-models:'
const DEFAULT_MODEL_KEY = 'traveler'
const FALLBACK_CHOICES = [
  { key: 'traveler', label: 'Мужская основа' },
  { key: 'human-female', label: 'Женская основа' },
]

function readStoredModel(storageKey: string, actorId: string): string {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>
    return typeof value[actorId] === 'string' ? value[actorId] : DEFAULT_MODEL_KEY
  } catch {
    return DEFAULT_MODEL_KEY
  }
}

function writeStoredModel(storageKey: string, actorId: string, modelKey: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>
    value[actorId] = modelKey
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // Недоступное хранилище не должно ломать примерку в текущем окне.
  }
}

function modelLabel(key: string, fallback: string) {
  if (key === 'traveler') return 'Мужская основа'
  if (key === 'human-female') return 'Женская основа'
  return fallback
}

function previewModelInput(player: Player, modelKey: string, appearance?: ActorAppearance) {
  return {
    id: `equipment-preview:${player.id}`,
    label: player.character || 'Герой',
    kind: 'hero' as const,
    modelKey,
    archetype: player.characterClass ?? player.role ?? 'fighter',
    color: player.color,
    appearance,
  }
}

function disposeModel(model: ActorModel | undefined) {
  model?.dispose()
}

function equippedSlot(item: InventoryItem) {
  const visual = itemVisualForCatalogId(item.catalog_id ?? '')
  if (visual?.slot) return visual.slot
  if (item.type === 'armor') return 'body'
  if (item.type === 'weapon' && item.combat) return 'main_hand'
  return undefined
}

function unknownLoadoutItem(item: InventoryItem, loadout: PublicLoadout) {
  const slot = equippedSlot(item)
  return Boolean(slot && Object.hasOwn(loadout, slot) && loadout[slot] === null)
}

function modelChoices(manifest: ActorModelManifest | null) {
  if (!manifest) return FALLBACK_CHOICES
  const choices = availableActorModels(manifest)
    .map((choice) => ({ key: choice.key, label: modelLabel(choice.key, choice.label) }))
  const known = new Set(choices.map((choice) => choice.key))
  return [...FALLBACK_CHOICES.filter((choice) => !known.has(choice.key)), ...choices]
}

function useEquipmentPreviewRuntime(
  host: RefObject<HTMLDivElement | null>,
  player: Player,
  modelKey: string,
  appearanceRef: { current: ActorAppearance | undefined },
  manifest: ActorModelManifest | null,
  setStatus: (status: PreviewStatus) => void,
  onModelReady: () => void,
) {
  const runtimeRef = useRef<PreviewRuntime | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    let disposed = false
    const abort = new AbortController()
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#14120f')
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch {
      setStatus('unavailable')
      element.replaceChildren()
      return undefined
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.className = 'equipment-preview-canvas'
    renderer.domElement.setAttribute('aria-label', '3D-примерка героя')
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.tabIndex = 0
    element.replaceChildren(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#ead9c1', '#30261d', 1.7))
    const keyLight = new THREE.DirectionalLight('#ffe4bd', 2.3)
    keyLight.position.set(2.5, 3.3, 2.8)
    keyLight.castShadow = true
    keyLight.shadow.normalBias = 0.025
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight('#8e9aa0', 0.75)
    fillLight.position.set(-2, 1.7, -2)
    scene.add(fillLight)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 32),
      new THREE.MeshStandardMaterial({ color: '#29221c', roughness: 0.95, metalness: 0.05 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0.012
    ground.receiveShadow = true
    scene.add(ground)
    const actor = new THREE.Group()
    actor.position.y = 0.025
    scene.add(actor)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    controls.enableDamping = !reducedMotion
    controls.minDistance = 0.95
    controls.maxDistance = 4.5

    const runtime: PreviewRuntime = {
      renderer,
      scene,
      camera,
      controls,
      actor,
      frameId: 0,
      lastTime: 0,
      intersectionVisible: true,
      documentVisible: document.visibilityState !== 'hidden',
      reducedMotion,
      renderNow: () => undefined,
      fitCamera: () => undefined,
    }
    runtimeRef.current = runtime

    const renderNow = () => renderer.render(scene, camera)
    runtime.renderNow = renderNow

    const fitCamera = () => {
      actor.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(actor)
      if (bounds.isEmpty()) return
      const center = bounds.getCenter(new THREE.Vector3())
      const size = bounds.getSize(new THREE.Vector3())
      const dimension = Math.max(size.x, size.y, size.z, 0.8)
      const distance = Math.max(1.2, dimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.18)
      camera.position.copy(center).add(new THREE.Vector3(0.52, 0.13, 1).normalize().multiplyScalar(distance))
      camera.near = 0.05
      camera.far = Math.max(20, distance * 8)
      camera.updateProjectionMatrix()
      controls.target.copy(center)
      controls.saveState()
      controls.update()
      renderNow()
    }
    runtime.fitCamera = fitCamera

    const onResize = () => {
      const width = Math.max(1, element.clientWidth)
      const height = Math.max(1, element.clientHeight)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      renderNow()
    }
    onResize()
    if (typeof ResizeObserver !== 'undefined') {
      runtime.resizeObserver = new ResizeObserver(onResize)
      runtime.resizeObserver.observe(element)
    } else {
      window.addEventListener('resize', onResize)
    }

    const active = () => !disposed && runtime.intersectionVisible && runtime.documentVisible
    const animate = (time: number) => {
      runtime.frameId = 0
      if (!active()) return
      const delta = runtime.lastTime ? Math.min(0.05, Math.max(0, (time - runtime.lastTime) / 1000)) : 0
      runtime.lastTime = time
      if (!runtime.reducedMotion) {
        runtime.model?.update(delta)
        controls.update()
      }
      renderNow()
      schedule()
    }
    const schedule = () => {
      if (runtime.reducedMotion || !active() || runtime.frameId) return
      runtime.frameId = window.requestAnimationFrame(animate)
    }
    const onControlsChange = () => {
      renderNow()
      schedule()
    }
    controls.addEventListener('change', onControlsChange)
    const onDocumentVisibility = () => {
      runtime.documentVisible = document.visibilityState !== 'hidden'
      if (!runtime.documentVisible && runtime.frameId) { window.cancelAnimationFrame(runtime.frameId); runtime.frameId = 0 }
      if (runtime.documentVisible) { renderNow(); schedule() }
    }
    document.addEventListener('visibilitychange', onDocumentVisibility)
    if (typeof IntersectionObserver !== 'undefined') {
      runtime.intersectionObserver = new IntersectionObserver(([entry]) => {
        runtime.intersectionVisible = entry?.isIntersecting !== false
        if (!runtime.intersectionVisible && runtime.frameId) { window.cancelAnimationFrame(runtime.frameId); runtime.frameId = 0 }
        if (runtime.intersectionVisible) { renderNow(); schedule() }
      })
      runtime.intersectionObserver.observe(element)
    }
    renderNow()
    schedule()
    setStatus('loading')

    const load = async () => {
      try {
        const loaded = await createActorModel(previewModelInput(player, modelKey, appearanceRef.current), {
          manifest: manifest ?? DEFAULT_ACTOR_MODEL_MANIFEST,
          modelKey,
          height: 1.4,
          signal: abort.signal,
        })
        if (disposed) {
          disposeModel(loaded)
          return
        }
        loaded.setPose('idle', 0)
        actor.add(loaded)
        runtime.model = loaded
        loaded.onEquipmentChange = () => { fitCamera(); renderNow(); schedule() }
        onModelReady()
        fitCamera()
        renderNow()
      } catch {
        if (disposed || abort.signal.aborted) return
        setStatus('error')
      }
    }
    void load()

    return () => {
      disposed = true
      abort.abort()
      if (runtime.frameId) window.cancelAnimationFrame(runtime.frameId)
      runtime.resizeObserver?.disconnect()
      runtime.intersectionObserver?.disconnect()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onDocumentVisibility)
      controls.removeEventListener('change', onControlsChange)
      controls.dispose()
      disposeModel(runtime.model)
      runtime.model = undefined
      ground.geometry.dispose()
      ground.material.dispose()
      renderer.dispose()
      element.replaceChildren()
      runtimeRef.current = null
    }
  }, [host, manifest, modelKey, onModelReady, player.character, player.characterClass, player.color, player.id, player.role])

  return runtimeRef
}

export function EquipmentPreview({ player, campaignId = '', appearance }: { player: Player; campaignId?: string; appearance?: ActorAppearance }) {
  const host = useRef<HTMLDivElement>(null)
  const appearanceRef = useRef<ActorAppearance | undefined>(appearance)
  appearanceRef.current = appearance
  const [manifest, setManifest] = useState<ActorModelManifest | null>(null)
  const [modelKey, setModelKey] = useState(DEFAULT_MODEL_KEY)
  const [status, setStatus] = useState<PreviewStatus>('loading')
  const [modelRevision, setModelRevision] = useState(0)
  const storageKey = `${MODEL_STORAGE_PREFIX}${campaignId}`
  const appearanceLoadout = appearance?.version === 2 ? appearance.loadout : undefined
  const fallbackLoadout = useMemo(() => publicLoadoutForItems(player.inventory), [player.inventory])
  const loadout = appearanceLoadout ?? fallbackLoadout
  const equipped = useMemo(() => player.inventory.filter((item) => item.equipped === true), [player.inventory])
  const choices = useMemo(() => modelChoices(manifest), [manifest])
  const validModelKey = choices.some((choice) => choice.key === modelKey) ? modelKey : DEFAULT_MODEL_KEY

  useEffect(() => {
    setModelKey(readStoredModel(storageKey, player.id))
  }, [player.id, storageKey])

  useEffect(() => {
    const controller = new AbortController()
    void loadActorModelManifest({ signal: controller.signal }).then((value) => setManifest(value)).catch(() => {
      if (!controller.signal.aborted) setManifest(null)
    })
    return () => controller.abort()
  }, [campaignId])

  const onModelReady = useCallback(() => setModelRevision((value) => value + 1), [])
  const runtimeRef = useEquipmentPreviewRuntime(host, player, validModelKey, appearanceRef, manifest, setStatus, onModelReady)

  const appearanceKey = JSON.stringify(appearance ?? null)
  useEffect(() => {
    const runtime = runtimeRef.current
    const model = runtime?.model
    if (!runtime || !model) return undefined
    const expected = model
    setStatus('loading')
    model.setAppearance(appearanceRef.current)
    void model.equipmentReady.then(() => {
      if (runtimeRef.current?.model !== expected) return
      runtime.fitCamera()
      setStatus(expected.equipmentStatus === 'error' ? 'equipment-error' : expected.source === 'glb' ? 'ready' : 'fallback')
    }).catch(() => {
      if (runtimeRef.current?.model === expected) setStatus('equipment-error')
    })
    return undefined
  }, [appearanceKey, modelRevision, runtimeRef])

  const selectModel = (next: string) => {
    if (!choices.some((choice) => choice.key === next)) return
    setModelKey(next)
    writeStoredModel(storageKey, player.id, next)
  }
  const resetView = () => {
    runtimeRef.current?.controls.reset()
    host.current?.querySelector<HTMLElement>('.equipment-preview-canvas')?.focus()
  }
  const statusLabel = status === 'loading' ? 'Загрузка модели…' : status === 'ready' ? '3D-модель' : status === 'fallback' ? 'Встроенная фигурка' : status === 'unavailable' ? '3D-просмотр недоступен' : status === 'equipment-error' ? 'Экипировка не загрузилась' : 'Модель не загрузилась'

  return <section className="equipment-preview" aria-label="Примерка героя">
    <div className="equipment-preview-stage">
      <div ref={host} className="equipment-preview-canvas-host" />
      {status === 'loading' && <div className="equipment-preview-overlay" role="status">Загрузка модели…</div>}
      {status === 'error' && <div className="equipment-preview-overlay" role="status">Модель не загрузилась</div>}
      {status === 'unavailable' && <div className="equipment-preview-overlay" role="status">3D-просмотр недоступен в этом браузере</div>}
      {status === 'equipment-error' && <div className="equipment-preview-overlay" role="status">Не удалось загрузить надетые предметы</div>}
      <div className="equipment-preview-stage-footer"><span>{statusLabel}</span><span>Вращайте мышью или пальцем</span></div>
    </div>
    <div className="equipment-preview-details">
      <div className="equipment-preview-heading"><strong>Внешность героя</strong><span>{player.character}</span></div>
      <label className="equipment-preview-model-choice"><span>Основа</span><select value={validModelKey} onChange={(event) => selectModel(event.target.value)} aria-label="Основа модели героя">
        {choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
      </select></label>
      {manifest?.models.find((entry) => entry.key === validModelKey)?.profile === 'beast' && <p>В звериной форме экипировка скрыта. Для примерки вещей выберите основу с руками.</p>}
      <button type="button" className="equipment-preview-reset" onClick={resetView}><RotateCcw size={14} />Сбросить вид</button>
      <div className="equipment-preview-equipped"><span className="equipment-preview-label">Надето сейчас</span>
        {equipped.length === 0 ? <p>Ничего не надето.</p> : <ul>{equipped.map((item) => <li key={item.id}><span>{item.name}</span>{unknownLoadoutItem(item, loadout) && <em>модель недоступна</em>}</li>)}</ul>}
      </div>
    </div>
  </section>
}
