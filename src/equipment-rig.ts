import {
  Box3,
  Bone,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three'

/** Части, для которых авторские модели экипировки имеют стабильный якорь. */
export type EquipmentPartKey =
  | 'chest' | 'waist'
  | 'upper-arm-left' | 'upper-arm-right'
  | 'forearm-left' | 'forearm-right'
  | 'thigh-left' | 'thigh-right'
  | 'shin-left' | 'shin-right'
  | 'foot-left' | 'foot-right'
  | 'hand-left' | 'hand-right' | 'head'
  | 'back' | 'collar' | 'brooch' | 'rings' | 'rings-left' | 'rings-right'

export type EquipmentSide = 'left' | 'right'
export type EquipmentRigProfile = string
export type HeldEquipmentOptions = { kind?: string; handedness?: string }
export type EquipmentRigFamily = 'quaternius' | 'goblin' | 'skeleton' | 'kaykit' | 'procedural' | 'unknown'

export type EquipmentRigDiagnostics = Readonly<{
  family: EquipmentRigFamily
  profile: EquipmentRigProfile
  height: number
  /** Роль → фактический Bone/rig-* alias. null означает отсутствие совместимого узла. */
  aliases: Readonly<Record<string, string | null>>
  /** Кости, которые найдены как настоящие Three.Bone и доступны для IK. */
  handBones: Readonly<Record<EquipmentSide, string | null>>
  bodyMask: Readonly<{ meshes: number; masked: number; skipped: number }>
}>

export type EquipmentRig = {
  readonly root: Group
  readonly profile: EquipmentRigProfile
  readonly family: EquipmentRigFamily
  readonly diagnostics: EquipmentRigDiagnostics
  /** Реальные кости руки, без подмены одноимённым Mesh. */
  readonly handBones: Readonly<Record<EquipmentSide, Bone | Object3D | null>>
  readonly grips: Readonly<Record<EquipmentSide, Group | null>>
  getHandBone: (side: EquipmentSide) => Bone | Object3D | null
  getGrip: (side: EquipmentSide) => Group | null
  mountPart: <T extends Object3D>(part: T, partKey: string) => T | null
  mountHeld: (model: Group, side: EquipmentSide, options?: HeldEquipmentOptions) => Group | null
  /** Hook после mixer/IK; матрицы креплений остаются baseline-relative. */
  refresh: () => void
  setCoverage: (parts: string[]) => void
  clear: () => void
  dispose: () => void
}

type CandidateNode = Object3D & { isBone?: boolean; isMesh?: boolean; isSkinnedMesh?: boolean }
type PartSnapshot = {
  parent: Object3D | null
  index: number
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
  matrix: Matrix4
  matrixAutoUpdate: boolean
}
type Mounted = { key: string; object: Object3D; snapshot: PartSnapshot }
type RegionFrame = {
  center: Vector3
  quaternion: Quaternion
  size: Vector3
  bone: CandidateNode
  inverseBone: Matrix4
}
type MaskedMesh = {
  source: Mesh
  clone: Mesh
  parent: Object3D
  index: number
  visible: boolean
}

const PART_KEYS = new Set<EquipmentPartKey>([
  'chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right',
  'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right',
  'hand-left', 'hand-right', 'head', 'back', 'collar', 'brooch', 'rings', 'rings-left', 'rings-right',
])

const FAMILY_ROLE_ALIASES: Record<EquipmentRigFamily, Record<string, string[]>> = {
  quaternius: {
    chest: ['spine_03', 'spine_02', 'spine_01'], waist: ['pelvis'],
    'upper-arm-left': ['upperarm_l', 'clavicle_l'], 'upper-arm-right': ['upperarm_r', 'clavicle_r'],
    'forearm-left': ['lowerarm_l'], 'forearm-right': ['lowerarm_r'],
    'thigh-left': ['thigh_l'], 'thigh-right': ['thigh_r'],
    'shin-left': ['calf_l'], 'shin-right': ['calf_r'],
    'foot-left': ['foot_l'], 'foot-right': ['foot_r'],
    'hand-left': ['hand_l'], 'hand-right': ['hand_r'],
    'grip-left': ['hand_l'], 'grip-right': ['hand_r'], head: ['Head'], neck: ['neck_01'],
  },
  goblin: {
    chest: ['Torso', 'Abdomen'], waist: ['Hips'],
    'upper-arm-left': ['UpperArmL', 'ShoulderL'], 'upper-arm-right': ['UpperArmR', 'ShoulderR'],
    'forearm-left': ['LowerArmL'], 'forearm-right': ['LowerArmR'],
    'thigh-left': ['UpperLegL'], 'thigh-right': ['UpperLegR'],
    'shin-left': ['LowerLegL'], 'shin-right': ['LowerLegR'],
    'foot-left': ['FootL'], 'foot-right': ['FootR'],
    'hand-left': ['FistL'], 'hand-right': ['FistR'],
    'grip-left': ['FistL'], 'grip-right': ['FistR'], head: ['Head'], neck: ['Neck'],
  },
  skeleton: {
    chest: ['Torso'], waist: ['Hips'],
    'upper-arm-left': ['LUpperLeg001'], 'upper-arm-right': ['RUpperLeg001'],
    'forearm-left': ['LDownLeg001'], 'forearm-right': ['RDownLeg001'],
    'hand-left': ['LDownLeg001_end'], 'hand-right': ['RDownLeg001_end'],
    'grip-left': ['LDownLeg001_end'], 'grip-right': ['RDownLeg001_end'],
    'thigh-left': ['LUpperLeg'], 'thigh-right': ['RUpperLeg'],
    'shin-left': ['LDownLeg'], 'shin-right': ['RDownLeg'],
    'foot-left': ['LDownLeg_end'], 'foot-right': ['RDownLeg_end'],
    head: ['Head'], neck: ['Neck'],
  },
  kaykit: {
    chest: ['chest', 'spine'], waist: ['hips'],
    'upper-arm-left': ['upperarml'], 'upper-arm-right': ['upperarmr'],
    'forearm-left': ['lowerarml'], 'forearm-right': ['lowerarmr'],
    'thigh-left': ['upperlegl'], 'thigh-right': ['upperlegr'],
    'shin-left': ['lowerlegl'], 'shin-right': ['lowerlegr'],
    'foot-left': ['footl'], 'foot-right': ['footr'],
    'hand-left': ['handl', 'wristl'], 'hand-right': ['handr', 'wristr'],
    'grip-left': ['handslotl', 'handl'], 'grip-right': ['handslotr', 'handr'],
    head: ['head'], neck: ['head'],
  },
  procedural: {
    chest: ['rig-torso'], waist: ['rig-pelvis'],
    'upper-arm-left': ['rig-leftArm'], 'upper-arm-right': ['rig-rightArm'],
    'forearm-left': ['rig-leftArm'], 'forearm-right': ['rig-rightArm'],
    'thigh-left': ['rig-leftLeg'], 'thigh-right': ['rig-rightLeg'],
    'shin-left': ['rig-leftLeg'], 'shin-right': ['rig-rightLeg'],
    'foot-left': ['rig-leftLeg'], 'foot-right': ['rig-rightLeg'],
    'hand-left': ['rig-leftArm'], 'hand-right': ['rig-rightArm'],
    'grip-left': ['rig-leftArm'], 'grip-right': ['rig-rightArm'],
    head: ['rig-head'], neck: ['rig-head'],
  },
  unknown: {},
}

const REGION_TOKENS: Record<EquipmentPartKey, string[]> = {
  chest: ['spine', 'chest', 'torso', 'abdomen', 'body1', 'rig-torso'],
  waist: ['pelvis', 'hips', 'abdomen', 'rig-pelvis'],
  'upper-arm-left': ['upperarml', 'shoulderl', 'claviclel', 'leftarm', 'lupperleg001', 'rig-leftarm'],
  'upper-arm-right': ['upperarmr', 'shoulderr', 'clavicler', 'rightarm', 'rupperleg001', 'rig-rightarm'],
  'forearm-left': ['lowerarml', 'forearml', 'wristl', 'ldownleg001', 'rig-leftarm'],
  'forearm-right': ['lowerarmr', 'forearmr', 'wristr', 'rdownleg001', 'rig-rightarm'],
  'thigh-left': ['thighl', 'upperlegl', 'rig-leftleg'],
  'thigh-right': ['thighr', 'upperlegr', 'rig-rightleg'],
  'shin-left': ['calfl', 'lowerlegl', 'rig-leftleg'],
  'shin-right': ['calfr', 'lowerlegr', 'rig-rightleg'],
  'foot-left': ['footl', 'toesl', 'rig-leftleg'], 'foot-right': ['footr', 'toesr', 'rig-rightleg'],
  'hand-left': ['handl', 'fistl', 'wristl', 'ldownleg001end', 'rig-leftarm'],
  'hand-right': ['handr', 'fistr', 'wristr', 'rdownleg001end', 'rig-rightarm'],
  head: ['head', 'rig-head'], back: ['spine', 'chest', 'torso', 'rig-torso'],
  collar: ['neck', 'chest', 'rig-head'], brooch: ['chest', 'spine', 'torso', 'rig-torso'],
  rings: ['handl', 'handr', 'fistl', 'fistr', 'wristl', 'wristr', 'ldownleg001end', 'rdownleg001end', 'rig-leftarm', 'rig-rightarm'],
  'rings-left': ['handl', 'fistl', 'wristl', 'ldownleg001end', 'rig-leftarm'],
  'rings-right': ['handr', 'fistr', 'wristr', 'rdownleg001end', 'rig-rightarm'],
}

const ROLE_FALLBACK_SIZE: Record<EquipmentPartKey, [number, number, number]> = {
  chest: [.42, .34, .24], waist: [.4, .2, .22],
  'upper-arm-left': [.16, .24, .16], 'upper-arm-right': [.16, .24, .16],
  'forearm-left': [.15, .22, .15], 'forearm-right': [.15, .22, .15],
  'thigh-left': [.19, .28, .18], 'thigh-right': [.19, .28, .18],
  'shin-left': [.16, .25, .16], 'shin-right': [.16, .25, .16],
  'foot-left': [.18, .12, .25], 'foot-right': [.18, .12, .25],
  'hand-left': [.12, .11, .12], 'hand-right': [.12, .11, .12], head: [.3, .3, .3],
  back: [.42, .34, .14], collar: [.24, .1, .24], brooch: [.08, .08, .04], rings: [.09, .04, .09],
  'rings-left': [.09, .04, .09], 'rings-right': [.09, .04, .09],
}

const BODY_ROLES = new Set<EquipmentPartKey>([
  'chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right',
  'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right',
  'hand-left', 'hand-right', 'head',
])

function normalized(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLocaleLowerCase('en-US')
}

function boneLike(object: Object3D): object is Bone {
  const candidate = object as CandidateNode
  return !candidate.isMesh && (candidate.isBone === true || candidate.type === 'Bone')
}

function proceduralRigNode(object: Object3D): boolean {
  const candidate = object as CandidateNode
  return !candidate.isMesh && !boneLike(object) && /^rig-/u.test(object.name)
}

function allNodes(root: Group): CandidateNode[] {
  const result: CandidateNode[] = []
  root.traverse((object) => result.push(object as CandidateNode))
  return result
}

function detectFamily(root: Group, profile: EquipmentRigProfile, nodes: CandidateNode[]): EquipmentRigFamily {
  const names = new Set(nodes.filter(boneLike).map((node) => normalized(node.name)))
  if (profile === 'beast' || profile === 'wolf') return 'unknown'
  if ([...names].some((name) => name.includes('rupperleg001') || name.includes('lupperleg001'))) return 'skeleton'
  if (names.has('handslotl') || names.has('handslotr')) return 'kaykit'
  if (names.has('body1') || names.has('fistl') || names.has('fistr')) return 'goblin'
  if ([...names].some((name) => name.startsWith('spine') || name === 'pelvis' || name === 'claviclel')) return 'quaternius'
  if (nodes.some(proceduralRigNode)) return 'procedural'
  return 'unknown'
}

function aliasesFor(family: EquipmentRigFamily, role: string): string[] {
  return FAMILY_ROLE_ALIASES[family][role] ?? []
}

function findCompatibleNode(nodes: CandidateNode[], aliases: string[], family: EquipmentRigFamily): CandidateNode | null {
  if (!aliases.length) return null
  for (const alias of aliases) {
    const target = normalized(alias)
    const exact = nodes.find((node) => {
      if (family === 'procedural' ? !proceduralRigNode(node) : !boneLike(node)) return false
      return normalized(node.name) === target
    })
    if (exact) return exact
  }
  return null
}

function preferredNode(nodes: CandidateNode[], family: EquipmentRigFamily, role: string, fallbackRole = role): CandidateNode | null {
  return findCompatibleNode(nodes, aliasesFor(family, role), family) ?? findCompatibleNode(nodes, aliasesFor(family, fallbackRole), family)
}

function roleForKey(value: string): EquipmentPartKey | null {
  const key = normalized(String(value).trim().replace(/^part(?:[:/_-])?/iu, ''))
  for (const part of PART_KEYS) if (normalized(part) === key) return part
  const aliases: Record<string, EquipmentPartKey> = {
    upperarmleft: 'upper-arm-left', upperarmright: 'upper-arm-right',
    forearml: 'forearm-left', forearmr: 'forearm-right',
    thighl: 'thigh-left', thighr: 'thigh-right', upperlegl: 'thigh-left', upperlegr: 'thigh-right',
    shinl: 'shin-left', shinr: 'shin-right', lowerlegl: 'shin-left', lowerlegr: 'shin-right',
    footl: 'foot-left', footr: 'foot-right', handl: 'hand-left', handr: 'hand-right',
    upperarml: 'upper-arm-left', upperarmr: 'upper-arm-right',
    ringleft: 'rings-left', ringright: 'rings-right', ringsl: 'rings-left', ringsr: 'rings-right',
  }
  return aliases[key] ?? (key === 'rings' ? 'rings-right' : null)
}

function partObjectFor(input: Object3D, role: EquipmentPartKey): Object3D {
  const marker = input.userData.armorPart ?? input.userData.accessoryPart ?? input.userData.name
  if (roleForKey(typeof marker === 'string' ? marker : input.name) === role) return input
  let found: Object3D | null = null
  input.traverse((object) => {
    if (found || object === input) return
    const value = object.userData.armorPart ?? object.userData.accessoryPart ?? object.userData.name
    if (roleForKey(typeof value === 'string' ? value : object.name) === role) found = object
  })
  return found ?? input
}

function snapshot(object: Object3D): PartSnapshot {
  object.updateMatrix()
  return {
    parent: object.parent,
    index: object.parent ? object.parent.children.indexOf(object) : -1,
    position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
    matrix: object.matrix.clone(), matrixAutoUpdate: object.matrixAutoUpdate,
  }
}

function restore(object: Object3D, value: PartSnapshot): void {
  object.removeFromParent()
  if (value.parent) {
    value.parent.add(object)
    const current = value.parent.children.indexOf(object)
    const index = Math.max(0, Math.min(value.index, value.parent.children.length - 1))
    if (current !== index) {
      value.parent.children.splice(current, 1)
      value.parent.children.splice(index, 0, object)
    }
  }
  object.matrixAutoUpdate = value.matrixAutoUpdate
  if (value.matrixAutoUpdate) {
    object.position.copy(value.position); object.quaternion.copy(value.quaternion); object.scale.copy(value.scale)
    object.updateMatrix()
  } else object.matrix.copy(value.matrix)
  object.updateMatrixWorld(true)
}

function sourceBounds(part: Object3D): Box3 {
  part.removeFromParent()
  part.matrixAutoUpdate = true
  part.position.set(0, 0, 0); part.quaternion.identity(); part.scale.set(1, 1, 1)
  part.updateMatrixWorld(true)
  return new Box3().setFromObject(part)
}

function tokenMatches(name: string, tokens: string[]): boolean {
  const value = normalized(name)
  return tokens.some((token) => value === token || value.startsWith(token) || value.endsWith(token))
}

function addSkinnedRegionPoints(root: Group, role: EquipmentPartKey, points: Vector3[]): void {
  root.traverse((object) => {
    if (!(object instanceof SkinnedMesh) || !object.skeleton) return
    const geometry = object.geometry
    const positions = geometry.getAttribute('position')
    const skinIndices = geometry.getAttribute('skinIndex')
    const skinWeights = geometry.getAttribute('skinWeight')
    if (!positions || !skinIndices || !skinWeights) return
    object.skeleton.update()
    const tokens = REGION_TOKENS[role]
    const vertex = new Vector3()
    for (let index = 0; index < positions.count; index += 1) {
      let regionWeight = 0
      for (let slot = 0; slot < Math.min(4, skinIndices.itemSize, skinWeights.itemSize); slot += 1) {
        const boneIndex = skinIndices.getComponent(index, slot)
        const weight = skinWeights.getComponent(index, slot)
        const bone = object.skeleton.bones[boneIndex]
        if (bone && tokenMatches(bone.name, tokens)) regionWeight += weight
      }
      if (regionWeight < .18) continue
      object.getVertexPosition(index, vertex)
      object.localToWorld(vertex)
      if (vertex.x !== undefined && vertex.y !== undefined && vertex.z !== undefined && vertex.toArray().every(Number.isFinite)) points.push(vertex.clone())
    }
  })
}

function regionSize(role: EquipmentPartKey, target: CandidateNode, points: Vector3[], height: number, orientation: Quaternion): RegionFrame {
  target.updateMatrixWorld(true)
  const center = new Vector3(); target.getWorldPosition(center)
  const quaternion = orientation.clone().normalize()
  const fallback = new Vector3(...ROLE_FALLBACK_SIZE[role]).multiplyScalar(Math.max(.25, height / 1.4))
  if (points.length >= 3) {
    const bounds = new Box3().setFromPoints(points)
    bounds.getCenter(center)
    const inverse = quaternion.clone().invert()
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const point of points) {
      const local = point.clone().sub(center).applyQuaternion(inverse)
      min.min(local); max.max(local)
    }
    const size = max.sub(min)
    // У skinned vertices реальный размер важнее общего канонического
    // минимума: тот нужен только как защита от редкой/вырожденной выборки.
    return { center, quaternion, size: new Vector3(Math.max(size.x, fallback.x * .4), Math.max(size.y, fallback.y * .4), Math.max(size.z, fallback.z * .4)), bone: target, inverseBone: target.matrixWorld.clone().invert() }
  }
  const subtree = new Box3().setFromObject(target)
  if (!subtree.isEmpty()) {
    subtree.getCenter(center)
    const size = subtree.getSize(new Vector3())
    return { center, quaternion, size: new Vector3(Math.max(size.x, fallback.x), Math.max(size.y, fallback.y), Math.max(size.z, fallback.z)), bone: target, inverseBone: target.matrixWorld.clone().invert() }
  }
  return { center, quaternion, size: fallback, bone: target, inverseBone: target.matrixWorld.clone().invert() }
}

function canonicalBodyFrame(root: Group): Quaternion {
  const rootQuaternion = root.getWorldQuaternion(new Quaternion())
  const up = new Vector3(0, 1, 0)
  const forward = new Vector3(0, 0, 1).applyQuaternion(rootQuaternion)
  forward.y = 0
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1)
  forward.normalize()
  const right = up.clone().cross(forward).normalize()
  const cleanForward = right.clone().cross(up).normalize()
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, cleanForward))
}

function limbFrame(target: CandidateNode, next: CandidateNode | undefined, bodyQuaternion: Quaternion): Quaternion {
  if (!next) return bodyQuaternion.clone()
  const from = target.getWorldPosition(new Vector3())
  const to = next.getWorldPosition(new Vector3())
  const y = to.sub(from)
  if (y.lengthSq() < 1e-8) return bodyQuaternion.clone()
  y.normalize()
  const bodyForward = new Vector3(0, 0, 1).applyQuaternion(bodyQuaternion).normalize()
  let z = bodyForward.sub(y.clone().multiplyScalar(bodyForward.dot(y)))
  if (z.lengthSq() < 1e-8) z = new Vector3(1, 0, 0).applyQuaternion(bodyQuaternion).sub(y.clone().multiplyScalar(new Vector3(1, 0, 0).applyQuaternion(bodyQuaternion).dot(y)))
  if (z.lengthSq() < 1e-8) return bodyQuaternion.clone()
  z.normalize()
  const x = y.clone().cross(z).normalize()
  z = x.clone().cross(y).normalize()
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z))
}

function targetRoleFor(role: EquipmentPartKey): string {
  if (role === 'back' || role === 'brooch') return 'chest'
  if (role === 'collar') return 'neck'
  if (role === 'rings') return 'grip-right'
  if (role === 'rings-left') return 'grip-left'
  if (role === 'rings-right') return 'grip-right'
  return role
}

function nextRoleFor(role: EquipmentPartKey): EquipmentPartKey | null {
  if (role === 'upper-arm-left') return 'forearm-left'
  if (role === 'upper-arm-right') return 'forearm-right'
  if (role === 'forearm-left') return 'hand-left'
  if (role === 'forearm-right') return 'hand-right'
  if (role === 'thigh-left') return 'shin-left'
  if (role === 'thigh-right') return 'shin-right'
  if (role === 'shin-left') return 'foot-left'
  if (role === 'shin-right') return 'foot-right'
  return null
}

function isBodyAxisRole(role: EquipmentPartKey): boolean {
  return role.startsWith('upper-arm-') || role.startsWith('forearm-') || role.startsWith('thigh-') || role.startsWith('shin-')
}

function materialName(object: Object3D): string {
  const mesh = object as Mesh
  const material = mesh.material
  if (!material) return ''
  const values = Array.isArray(material) ? material : [material]
  return values.map((entry) => entry?.name ?? '').join(' ')
}

function preserveFaceOrHand(object: Object3D): boolean {
  const token = `${object.name} ${materialName(object)}`.toLocaleLowerCase('en-US')
  return /face|eye|jaw|teeth|nose|pupil|hand/u.test(token)
}

function coveredVertex(mesh: SkinnedMesh, index: number, tokens: string[]): boolean {
  const indices = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  if (!indices || !weights) return false
  let value = 0
  for (let slot = 0; slot < Math.min(4, indices.itemSize, weights.itemSize); slot += 1) {
    const boneIndex = indices.getComponent(index, slot)
    const bone = mesh.skeleton?.bones[boneIndex]
    if (bone && tokenMatches(bone.name, tokens)) value += weights.getComponent(index, slot)
  }
  return value >= .25
}

function maskedGeometry(source: SkinnedMesh, tokens: string[]): BufferGeometry | null {
  const geometry = source.geometry
  const positions = geometry.getAttribute('position')
  const skinIndices = geometry.getAttribute('skinIndex')
  const skinWeights = geometry.getAttribute('skinWeight')
  if (!positions || !skinIndices || !skinWeights) return null
  const indexed = geometry.index
  const groups: Array<{ start: number; count: number; materialIndex: number }> = geometry.groups.length
    ? geometry.groups.map((group) => ({ start: group.start, count: group.count, materialIndex: group.materialIndex ?? 0 }))
    : [{ start: 0, count: indexed ? indexed.count : positions.count, materialIndex: 0 }]
  const kept: number[] = []
  const ranges: Array<{ start: number; count: number; materialIndex: number }> = []
  for (const group of groups) {
    const start = kept.length
    const end = Math.min(group.start + group.count, indexed ? indexed.count : positions.count)
    for (let offset = group.start; offset + 2 < end; offset += 3) {
      const a = indexed ? indexed.getX(offset) : offset
      const b = indexed ? indexed.getX(offset + 1) : offset + 1
      const c = indexed ? indexed.getX(offset + 2) : offset + 2
      if (coveredVertex(source, a, tokens) && coveredVertex(source, b, tokens) && coveredVertex(source, c, tokens)) continue
      kept.push(a, b, c)
    }
    if (kept.length > start) ranges.push({ start, count: kept.length - start, materialIndex: group.materialIndex })
  }
  if (kept.length === (indexed ? indexed.count : positions.count)) return null
  const result = geometry.clone()
  result.setIndex(kept)
  result.clearGroups()
  for (const range of ranges) result.addGroup(range.start, range.count, range.materialIndex)
  result.computeBoundingBox(); result.computeBoundingSphere()
  return result
}

function insertAt(parent: Object3D, object: Object3D, index: number): void {
  parent.add(object)
  const current = parent.children.indexOf(object)
  const target = Math.max(0, Math.min(index, parent.children.length - 1))
  if (current === target) return
  parent.children.splice(current, 1)
  parent.children.splice(target, 0, object)
}

function cloneMaskedMesh(source: Mesh, geometry: BufferGeometry): Mesh {
  const clone = source.clone(false) as Mesh
  clone.geometry = geometry
  clone.name = `${source.name}:coverage`
  clone.userData = { ...source.userData, equipmentCoverageClone: true }
  return clone
}

function disposeMaskedGeometry(mesh: Mesh): void {
  mesh.geometry?.dispose()
  mesh.removeFromParent()
}

function isPole(kind: string): boolean {
  return /staff|spear|pike|lance|halberd|glaive|trident|javelin|quarterstaff/iu.test(kind)
}

function isCrossbow(kind: string): boolean {
  return /crossbow/iu.test(kind)
}

function isBow(kind: string): boolean {
  return /bow/iu.test(kind) && !isCrossbow(kind)
}

function isBlade(kind: string): boolean {
  return /sword|blade|dagger|rapier|scimitar|sickle|axe|mace|hammer|club|flail|whip|pick|morningstar|maul/iu.test(kind)
}

function heldOrientation(kindValue: string, side: EquipmentSide, bodyQuaternion: Quaternion): Quaternion {
  const kind = kindValue.toLocaleLowerCase('en-US')
  const rotation = new Quaternion()
  // Посохи и дуга лука стоят вертикально; арбалет смотрит вдоль +Z.
  if (isPole(kind) || isCrossbow(kind) || isBow(kind)) return bodyQuaternion.clone()
  if (isBlade(kind)) {
    rotation.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
    rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), side === 'right' ? -.12 : .12))
  }
  return bodyQuaternion.clone().multiply(rotation)
}

function finiteHeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1.4
}

/**
 * Небольшой bounded rig для надетых частей. Калибровка выполняется один раз
 * в переданной idle-позе; поздняя загрузка части не измеряет текущую анимацию.
 */
export function createEquipmentRig(root: Group, options: { height: number; profile: EquipmentRigProfile }): EquipmentRig {
  if (!root || typeof root.traverse !== 'function') throw new Error('Для equipment rig нужен Group фигурки')
  const height = finiteHeight(options?.height)
  const profile = typeof options?.profile === 'string' ? options.profile : 'unknown'
  root.updateMatrixWorld(true)
  const nodes = allNodes(root)
  const family = detectFamily(root, profile, nodes)
  const aliases: Record<string, string | null> = {}
  const targetByRole = new Map<EquipmentPartKey, CandidateNode>()
  const frames = new Map<EquipmentPartKey, RegionFrame>()
  const bodyQuaternion = canonicalBodyFrame(root)
  for (const role of PART_KEYS) {
    const targetRole = targetRoleFor(role)
    const target = preferredNode(nodes, family, targetRole)
    aliases[role] = target?.name ?? null
    if (target) targetByRole.set(role, target)
  }
  for (const role of PART_KEYS) {
    const target = targetByRole.get(role)
    if (!target) continue
    const points: Vector3[] = []
    if (role !== 'collar') addSkinnedRegionPoints(root, role, points)
    const next = nextRoleFor(role) ? targetByRole.get(nextRoleFor(role)!) : undefined
    const orientation = isBodyAxisRole(role) ? limbFrame(target, next, bodyQuaternion) : bodyQuaternion
    const frame = regionSize(role, target, points, height, orientation)
    if (!BODY_ROLES.has(role)) {
      const base = role === 'rings' || role === 'rings-left' || role === 'rings-right' ? frame : frames.get('chest')
      const size = new Vector3(...ROLE_FALLBACK_SIZE[role]).multiplyScalar(Math.max(.25, height / 1.4))
      const center = frame.center.clone()
      if (role === 'back' && base) center.add(new Vector3(0, 0, -(base.size.z + size.z) * .5 - Math.max(.012, height * .022)).applyQuaternion(bodyQuaternion))
      if (role === 'brooch' && base) center.add(new Vector3(0, 0, (base.size.z + size.z) * .5 + Math.max(.012, height * .022)).applyQuaternion(bodyQuaternion))
      frames.set(role, { ...frame, center, quaternion: bodyQuaternion.clone(), size })
    } else frames.set(role, frame)
  }
  const handBoneBySide: Record<EquipmentSide, Bone | Object3D | null> = {
    left: targetByRole.get('hand-left') ?? null,
    right: targetByRole.get('hand-right') ?? null,
  }
  const gripTargetBySide: Record<EquipmentSide, CandidateNode | null> = {
    left: preferredNode(nodes, family, 'grip-left', 'hand-left'),
    right: preferredNode(nodes, family, 'grip-right', 'hand-right'),
  }
  const baseGripQuaternion: Record<EquipmentSide, Quaternion | null> = {
    left: gripTargetBySide.left?.getWorldQuaternion(new Quaternion()).normalize() ?? null,
    right: gripTargetBySide.right?.getWorldQuaternion(new Quaternion()).normalize() ?? null,
  }
  aliases['grip-left'] = gripTargetBySide.left?.name ?? null
  aliases['grip-right'] = gripTargetBySide.right?.name ?? null
  const grips: Record<EquipmentSide, Group | null> = { left: null, right: null }
  const mountedParts = new Map<EquipmentPartKey, Mounted>()
  const mountedHeld = new Map<EquipmentSide, Mounted>()
  const masked: MaskedMesh[] = []
  let disposed = false
  let maskStats = { meshes: 0, masked: 0, skipped: 0 }

  const getGrip = (side: EquipmentSide): Group | null => {
    if (grips[side]) return grips[side]
    const hand = gripTargetBySide[side]
    if (!hand || profile === 'beast' || profile === 'wolf') return null
    const existing = hand.children.find((child) => child.name === 'grip0' && child.userData.equipmentRigGrip === true)
    const grip = existing instanceof Group ? existing : new Group()
    grip.name = 'grip0'
    grip.userData = { ...grip.userData, equipmentRigGrip: true, side }
    if (!existing) hand.add(grip)
    grip.position.set(0, 0, 0); grip.rotation.set(0, 0, 0); grip.scale.set(1, 1, 1)
    grip.updateMatrixWorld(true)
    grips[side] = grip
    return grip
  }

  const detach = (item: Mounted) => restore(item.object, item.snapshot)

  const mountPart = <T extends Object3D>(part: T, inputKey: string): T | null => {
    if (disposed || !part || typeof part.traverse !== 'function') return null
    const role = roleForKey(inputKey)
    if (!role || !targetByRole.has(role)) return null
    const mountedObject = partObjectFor(part, role)
    const frame = frames.get(role)
    const target = targetByRole.get(role)
    if (!frame || !target) return null
    const previous = mountedParts.get(role)
    if (previous) { mountedParts.delete(role); detach(previous) }
    const original = snapshot(mountedObject)
    let bounds = sourceBounds(mountedObject)
    // Гребень находится над головой. Посадку определяет купол: размер
    // всего шлема уменьшал его и оставлял макушку снаружи.
    const helmetShell = role === 'head' ? mountedObject.getObjectByName('helmet-crown') : undefined
    if (helmetShell) bounds = new Box3().setFromObject(helmetShell)
    if (bounds.isEmpty()) { restore(mountedObject, original); return null }
    const sourceSize = bounds.getSize(new Vector3())
    const sourceCenter = bounds.getCenter(new Vector3())
    const padding = Math.max(.006, height * .008)
    const wanted = frame.size.clone().addScalar(padding * 2)
    const fitted = new Vector3(
      Math.max(.45, Math.min(3, wanted.x / Math.max(.0001, sourceSize.x))),
      Math.max(.45, Math.min(3, wanted.y / Math.max(.0001, sourceSize.y))),
      Math.max(.45, Math.min(3, wanted.z / Math.max(.0001, sourceSize.z))),
    )
    const translatedCenter = sourceCenter.clone().multiply(fitted).applyQuaternion(frame.quaternion)
    const desiredWorld = new Matrix4().compose(frame.center.clone().sub(translatedCenter), frame.quaternion, fitted)
    const local = frame.inverseBone.clone().multiply(desiredWorld)
    mountedObject.matrixAutoUpdate = false
    mountedObject.matrix.copy(local)
    target.add(mountedObject)
    mountedObject.updateMatrixWorld(true)
    const mounted = { key: role, object: mountedObject, snapshot: original }
    mountedParts.set(role, mounted)
    return mountedObject as T
  }

  const mountHeld = (model: Group, side: EquipmentSide, heldOptions: HeldEquipmentOptions = {}): Group | null => {
    if (disposed || !model || (side !== 'left' && side !== 'right')) return null
    const grip = getGrip(side)
    if (!grip) { model.removeFromParent(); return null }
    const previous = mountedHeld.get(side)
    if (previous) { mountedHeld.delete(side); detach(previous) }
    const original = snapshot(model)
    model.removeFromParent()
    model.matrixAutoUpdate = true
    model.position.set(0, 0, 0); model.quaternion.identity(); model.scale.set(1, 1, 1)
    const desiredWorldOrientation = heldOrientation(typeof heldOptions.kind === 'string' ? heldOptions.kind : '', side, bodyQuaternion)
    const gripWorldOrientation = baseGripQuaternion[side] ?? bodyQuaternion
    model.quaternion.copy(gripWorldOrientation.clone().invert().multiply(desiredWorldOrientation))
    grip.add(model)
    grip.updateMatrixWorld(true)
    const parentScale = grip.getWorldScale(new Vector3())
    const desiredWorldScale = height / 1.4
    model.scale.set(
      desiredWorldScale / Math.max(.0001, Math.abs(parentScale.x)),
      desiredWorldScale / Math.max(.0001, Math.abs(parentScale.y)),
      desiredWorldScale / Math.max(.0001, Math.abs(parentScale.z)),
    )
    model.updateMatrixWorld(true)
    mountedHeld.set(side, { key: `held:${side}`, object: model, snapshot: original })
    return model
  }

  const clearCoverage = () => {
    for (const item of masked.splice(0)) {
      item.source.visible = item.visible
      disposeMaskedGeometry(item.clone)
    }
    maskStats = { meshes: 0, masked: 0, skipped: 0 }
  }

  const setCoverage = (parts: string[]) => {
    if (disposed) return
    clearCoverage()
    const requested = [...new Set((Array.isArray(parts) ? parts : []).map((part) => roleForKey(String(part))).filter((value): value is EquipmentPartKey => Boolean(value)))]
    if (!requested.length) return
    const tokens = [...new Set(requested.flatMap((part) => REGION_TOKENS[part]))]
    const sources: SkinnedMesh[] = []
    root.traverse((object) => { if (object instanceof SkinnedMesh) sources.push(object) })
    maskStats = { meshes: sources.length, masked: 0, skipped: 0 }
    for (const source of sources) {
      if (preserveFaceOrHand(source)) { maskStats.skipped += 1; continue }
      const geometry = maskedGeometry(source, tokens)
      if (!geometry || !source.parent) { maskStats.skipped += 1; continue }
      const parent = source.parent
      const index = parent.children.indexOf(source)
      const clone = cloneMaskedMesh(source, geometry)
      const visible = source.visible
      source.visible = false
      insertAt(parent, clone, index)
      masked.push({ source, clone, parent, index, visible })
      maskStats.masked += 1
    }
  }

  const clear = () => {
    if (disposed) return
    for (const item of mountedHeld.values()) detach(item)
    mountedHeld.clear()
    for (const item of mountedParts.values()) detach(item)
    mountedParts.clear()
    clearCoverage()
  }

  const handBones: Readonly<Record<EquipmentSide, Bone | Object3D | null>> = handBoneBySide
  const diagnostics: EquipmentRigDiagnostics = {
    family, profile, height, aliases: { ...aliases },
    handBones: { left: handBoneBySide.left?.name ?? null, right: handBoneBySide.right?.name ?? null }, bodyMask: maskStats,
  }
  Object.defineProperty(diagnostics, 'bodyMask', { enumerable: true, get: () => maskStats })
  const rig: EquipmentRig = {
    root, profile, family, diagnostics, handBones, grips,
    getHandBone: (side) => handBoneBySide[side] ?? null,
    getGrip,
    mountPart,
    mountHeld,
    refresh: () => { if (!disposed) root.updateMatrixWorld(true) },
    setCoverage,
    clear,
    dispose: () => { if (!disposed) { clear(); for (const grip of Object.values(grips)) grip?.removeFromParent(); disposed = true } },
  }
  return rig
}
