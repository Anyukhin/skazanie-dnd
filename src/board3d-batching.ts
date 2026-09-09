import * as THREE from 'three'

type Candidate = { mesh: THREE.Mesh; local: THREE.Matrix4 }
type Bucket = { geometry: THREE.BufferGeometry; material: THREE.Material; candidates: Candidate[]; castShadow: boolean; receiveShadow: boolean; renderOrder: number; frustumCulled: boolean }
type MeshLike = THREE.Mesh & { isMesh?: boolean; isInstancedMesh?: boolean; isSkinnedMesh?: boolean; morphTargetInfluences?: unknown }

function meshOf(object: THREE.Object3D): MeshLike | null {
  const value = object as MeshLike
  return value.isMesh ? value : null
}

function visibleIn(root: THREE.Object3D, object: THREE.Object3D) {
  for (let current: THREE.Object3D | null = object; current && current !== root; current = current.parent) {
    if (!current.visible) return false
  }
  return root.visible
}

function eligible(mesh: THREE.Mesh, root: THREE.Object3D) {
  const value = mesh as MeshLike
  if (!visibleIn(root, mesh) || value.isInstancedMesh || value.isSkinnedMesh || value.morphTargetInfluences) return false
  if (mesh.userData?.animated === true || mesh.userData?.static === false || mesh.userData?.mixer) return false
  if (Array.isArray(mesh.material) || !mesh.geometry) return false
  const material = mesh.material
  if (material.transparent || material.opacity < 1 || material.alphaTest > 0) return false
  if (mesh.matrixWorld.determinant() < 0) return false
  return true
}

function drawCalls(root: THREE.Object3D) {
  let count = 0
  root.traverse((object) => { if (meshOf(object) && visibleIn(root, object)) count += 1 })
  return count
}

export function batchEnvironmentMeshes(group: THREE.Group) {
  group.updateMatrixWorld(true)
  const inverseRoot = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const byGeometry = new Map<THREE.BufferGeometry, Map<THREE.Material, Map<string, Bucket>>>()
  group.traverse((object) => {
    const mesh = meshOf(object)
    if (!mesh || !eligible(mesh, group)) return
    if (!mesh.geometry || Array.isArray(mesh.material)) return
    const key = `${mesh.castShadow ? 1 : 0}:${mesh.receiveShadow ? 1 : 0}:${mesh.renderOrder}:${mesh.frustumCulled ? 1 : 0}`
    let byMaterial = byGeometry.get(mesh.geometry)
    if (!byMaterial) { byMaterial = new Map(); byGeometry.set(mesh.geometry, byMaterial) }
    let byFlags = byMaterial.get(mesh.material)
    if (!byFlags) { byFlags = new Map(); byMaterial.set(mesh.material, byFlags) }
    let bucket = byFlags.get(key)
    if (!bucket) {
      bucket = { geometry: mesh.geometry, material: mesh.material, candidates: [], castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, renderOrder: mesh.renderOrder, frustumCulled: mesh.frustumCulled }
      byFlags.set(key, bucket)
    }
    bucket.candidates.push({ mesh, local: new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld) })
  })

  const originalDrawCalls = drawCalls(group)
  const batches: THREE.InstancedMesh[] = []
  let batchIndex = 0
  let disposed = false
  for (const byMaterial of byGeometry.values()) for (const byFlags of byMaterial.values()) for (const bucket of byFlags.values()) {
    if (bucket.candidates.length < 2) continue
    const batch = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.candidates.length)
    batch.name = `batch:${batchIndex++}`
    batch.castShadow = bucket.castShadow
    batch.receiveShadow = bucket.receiveShadow
    batch.renderOrder = bucket.renderOrder
    batch.frustumCulled = bucket.frustumCulled
    bucket.candidates.forEach((entry, index) => {
      entry.mesh.removeFromParent()
      batch.setMatrixAt(index, entry.local)
    })
    batch.instanceMatrix.needsUpdate = true
    batch.computeBoundingBox()
    batch.computeBoundingSphere()
    group.add(batch)
    batches.push(batch)
  }

  return {
    batches,
    originalDrawCalls,
    batchedDrawCalls: drawCalls(group),
    dispose() {
      if (disposed) return
      disposed = true
      for (const batch of batches) {
        batch.removeFromParent()
        batch.instanceMatrix.dispose()
        batch.instanceColor?.dispose()
        batch.dispose()
      }
    },
  }
}
