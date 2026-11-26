import {
  Color,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type Object3D,
} from 'three'
import type { ActorModelManifestEntry, ActorModelInput, ActorModelProfile, NormalizedActorModelInput } from './actor-models'
import type { DndClassKey } from './types'

/**
 * Публичный класс героя и выбранный локальный GLB. Ручной `modelKey` имеет
 * приоритет и проходит через обычный путь `resolveModelProfile`.
 */
export const ASTOHAN_HERO_FIGURES: Readonly<Record<DndClassKey, { key: string; profile: ActorModelProfile; label: string }>> = Object.freeze({
  fighter: { key: 'hero-male', profile: 'warrior', label: 'Воин · служебная броня' },
  paladin: { key: 'hero-male', profile: 'warrior', label: 'Паладин · служебная броня' },
  barbarian: { key: 'hero-male', profile: 'warrior', label: 'Варвар · служебная броня' },
  monk: { key: 'hero-male', profile: 'warrior', label: 'Монах · служебная броня' },
  wizard: { key: 'mage-male', profile: 'mage', label: 'Волшебник · посох' },
  sorcerer: { key: 'mage-male', profile: 'mage', label: 'Чародей · посох' },
  warlock: { key: 'mage-male', profile: 'mage', label: 'Колдун · посох' },
  cleric: { key: 'mage-male', profile: 'mage', label: 'Жрец · посох' },
  druid: { key: 'mage-male', profile: 'mage', label: 'Друид · посох' },
  bard: { key: 'mage-male', profile: 'mage', label: 'Бард · посох' },
  rogue: { key: 'ranger-male', profile: 'rogue', label: 'Плут · лук' },
  ranger: { key: 'ranger-male', profile: 'rogue', label: 'Следопыт · лук' },
})

function classKey(value: unknown): DndClassKey | null {
  const key = String(value ?? '').trim().toLowerCase() as DndClassKey
  return Object.hasOwn(ASTOHAN_HERO_FIGURES, key) ? key : null
}

export function astohanHeroClass(input: Pick<ActorModelInput, 'kind' | 'archetype'>): DndClassKey | null {
  return input.kind === 'hero' ? classKey(input.archetype) : null
}

/** Возвращает запись только когда её публичный профиль совместим с внешностью. */
export function astohanHeroFigureEntry(
  input: NormalizedActorModelInput | ActorModelInput,
  models: readonly ActorModelManifestEntry[],
): ActorModelManifestEntry | null {
  const key = astohanHeroClass(input)
  if (!key) return null
  const spec = ASTOHAN_HERO_FIGURES[key]
  if (input.appearance?.profile && input.appearance.profile !== spec.profile) return null
  const entry = models.find((candidate) => candidate.key === spec.key)
  if (!entry || entry.profile !== spec.profile || !entry.url) return null
  return entry
}

type AccessorySpec = {
  kind: 'medallion' | 'sash' | 'lute' | 'orb' | 'leaf' | 'guard-shoulder' | 'fur' | 'book' | 'scarf' | 'feather'
  color: string
}

const CLASS_ACCESSORY: Readonly<Partial<Record<DndClassKey, AccessorySpec>>> = Object.freeze({
  fighter: { kind: 'guard-shoulder', color: '#73818a' },
  paladin: { kind: 'medallion', color: '#d5b45c' },
  barbarian: { kind: 'fur', color: '#5c4439' },
  cleric: { kind: 'medallion', color: '#c99c4c' },
  druid: { kind: 'leaf', color: '#6b9a52' },
  bard: { kind: 'lute', color: '#8d5b38' },
  monk: { kind: 'sash', color: '#b56f40' },
  sorcerer: { kind: 'orb', color: '#79b7e8' },
  warlock: { kind: 'orb', color: '#8658ac' },
  wizard: { kind: 'book', color: '#4e6b96' },
  rogue: { kind: 'scarf', color: '#4e463f' },
  ranger: { kind: 'feather', color: '#718b58' },
})

function detailMaterial(color: string): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: new Color(color), roughness: .7, metalness: .05, flatShading: true })
}

function attach(parent: Object3D, object: Mesh | Group, name: string): void {
  object.name = name
  object.userData.board3dPickable = false
  object.traverse((child) => { child.userData.board3dPickable = false })
  parent.add(object)
}

function attachmentBone(root: Object3D): Object3D {
  let result: Object3D | null = null
  root.traverse((object) => {
    if (result || !object.name) return
    if (/^(spine_03|spine_02|torso|chest)$/u.test(object.name)) result = object
  })
  return result ?? root
}

function namedBone(root: Object3D, name: RegExp): Object3D | null {
  let result: Object3D | null = null
  root.traverse((object) => { if (!result && name.test(object.name)) result = object })
  return result
}

/** Небольшой class-read cue. Он следует размеру корня и освобождается вместе с моделью. */
export function decorateAstohanHeroFigure(parent: Object3D, input: Pick<ActorModelInput, 'kind' | 'archetype'>): Object3D | null {
  const key = astohanHeroClass(input)
  const accessory = key ? CLASS_ACCESSORY[key] : undefined
  if (!accessory) return null
  const group = new Group()
  group.name = `astohan-hero-detail:${key}`
  const anchor = attachmentBone(parent)
  const material = detailMaterial(accessory.color)
  if (accessory.kind === 'medallion') {
    const ring = new Mesh(new TorusGeometry(.085, .016, 6, 12), material)
    ring.rotation.x = Math.PI / 2; ring.position.set(0, .01, .14); attach(group, ring, `${key}-medallion`)
  } else if (accessory.kind === 'sash') {
    const sash = new Mesh(new BoxGeometry(.34, .045, .028), material)
    sash.rotation.z = -.46; sash.position.set(0, -.01, -.13); attach(group, sash, 'monk-sash')
    const waist = new Mesh(new TorusGeometry(.12, .015, 6, 16), material)
    waist.rotation.x = Math.PI / 2; waist.position.set(0, -.07, 0); attach(group, waist, 'monk-waist-wrap')
    for (const [name, boneName] of [['monk-wrap-left', /^(?:hand_l|leftArm)$/u], ['monk-wrap-right', /^(?:hand_r|rightArm)$/u]] as const) {
      const hand = namedBone(parent, boneName)
      if (!hand) continue
      const wrap = new Mesh(new TorusGeometry(.042, .012, 6, 12), material)
      wrap.rotation.x = Math.PI / 2; attach(hand, wrap, name)
    }
  } else if (accessory.kind === 'lute') {
    // У локального рига грудь смотрит в +Z. Корпус лежит за спиной (-Z),
    // гриф выходит к левому плечу по диагонали и следует кости spine_03.
    const body = new Mesh(new SphereGeometry(.11, 12, 8), material)
    body.scale.set(.82, 1.18, .30); body.position.set(.02, -.04, -.15); attach(group, body, 'bard-lute-body')
    const rosette = new Mesh(new TorusGeometry(.035, .008, 6, 12), detailMaterial('#d3a65e'))
    rosette.rotation.x = Math.PI / 2; rosette.position.set(.02, -.01, -.185); attach(group, rosette, 'bard-lute-rosette')
    const neck = new Mesh(new CylinderGeometry(.012, .016, .30, 8), material)
    neck.rotation.z = -.43; neck.position.set(.12, .10, -.15); attach(group, neck, 'bard-lute-neck')
    const peg = new Mesh(new BoxGeometry(.07, .025, .025), material)
    peg.rotation.z = -.43; peg.position.set(.23, .205, -.15); attach(group, peg, 'bard-lute-pegs')
  } else if (accessory.kind === 'orb') {
    const orb = new Mesh(new SphereGeometry(.075, 10, 6), material)
    orb.position.set(0, .06, .14); orb.userData.board3dPickable = false; attach(group, orb, `${key}-arcane-orb`)
  } else if (accessory.kind === 'leaf') {
    const leaf = new Mesh(new ConeGeometry(.07, .20, 5), material)
    leaf.position.set(.10, .05, .02); leaf.rotation.z = -.45; attach(group, leaf, 'druid-leaf-focus')
  }
  if (accessory.kind === 'guard-shoulder') {
    const plate = new Mesh(new TorusGeometry(.11, .025, 6, 12), material)
    plate.rotation.x = Math.PI / 2; plate.position.set(-.15, .04, 0); attach(group, plate, 'fighter-shoulder')
  } else if (accessory.kind === 'fur') {
    const mantle = new Mesh(new TorusGeometry(.16, .035, 6, 12), material)
    mantle.rotation.x = Math.PI / 2; mantle.position.set(0, .04, 0); attach(group, mantle, 'barbarian-fur')
  } else if (accessory.kind === 'book') {
    const book = new Mesh(new BoxGeometry(.12, .09, .035), material)
    book.scale.set(1, 1.35, 1); book.rotation.z = -.12; book.position.set(.12, -.01, -.16); attach(group, book, 'wizard-spellbook')
  } else if (accessory.kind === 'scarf') {
    const scarf = new Mesh(new TorusGeometry(.12, .018, 6, 12), material)
    scarf.rotation.x = Math.PI / 2; scarf.position.set(0, -.04, 0); attach(group, scarf, 'rogue-scarf')
  } else if (accessory.kind === 'feather') {
    const feather = new Mesh(new ConeGeometry(.025, .17, 5), material)
    feather.position.set(.16, .07, -.02); feather.rotation.z = -.4; attach(group, feather, 'ranger-feather')
  }
  anchor.add(group)
  return group
}
