import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'
import { AnimationClip, Bone, Box3, BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack, Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// Сборка должна жить внутри репозитория: с временным каталогом за его
// пределами Node не видит bare-import `three` из `actor-models.mjs`.
const { modules: [models] } = await compileClientModules(['src/actor-models.ts', 'src/model-assets.ts'])
const manifest = JSON.parse(readFileSync(new URL('../public/assets/models/manifest.json', import.meta.url), 'utf8'))
const kaykitRoot = fileURLToPath(new URL('../public/assets/models/kaykit/', import.meta.url))
const kaykitAssets = [
  { key: 'warrior', file: 'knight.glb' },
  { key: 'mage', file: 'mage.glb' },
  { key: 'rogue', file: 'rogue.glb' },
  { key: 'skeleton', file: 'skeleton-warrior.glb' },
]

test('каталог фигурок содержит шесть профилей с правами и локальными путями', () => {
  const validated = models.validateModelManifest(manifest)
  assert.equal(validated.version, 1)
  for (const profile of ['warrior', 'mage', 'rogue', 'goblin', 'skeleton', 'beast']) assert.ok(validated.models.some((entry) => entry.profile === profile), `${profile}: базовый профиль отсутствует`)
  assert.ok(validated.models.every((entry) => entry.rights.source && entry.rights.license))
  assert.deepEqual(models.availableActorModels(validated).map((entry) => entry.key), validated.models.map((entry) => entry.key))
})

test('разрешение уважает override, точный actor id и архетип', () => {
  const catalog = {
    version: 1,
    models: [
      { key: 'custom-hero', profile: 'warrior', actorIds: ['hero-7'], archetypes: ['fighter'], rights: { source: 'test', license: 'original' } },
      { key: 'custom-enemy', profile: 'goblin', actorIds: [], archetypes: ['goblin'], rights: { source: 'test', license: 'original' } },
    ],
  }
  assert.equal(models.resolveModelProfile({ id: 'hero-7', label: 'Кто-то', kind: 'hero', modelKey: 'custom-enemy' }, catalog).key, 'custom-enemy')
  assert.equal(models.resolveModelProfile({ id: 'hero-7', label: 'Кто-то', kind: 'hero' }, catalog).key, 'custom-hero')
  assert.equal(models.resolveModelProfile({ id: 'enemy-1', label: 'Гоблин', kind: 'enemy' }, catalog).key, 'custom-enemy')
})

test('точный архетип имеет приоритет над fuzzy-профилем, неизвестный гуманоид — воин', () => {
  const catalog = {
    version: 1,
    models: [
      { key: 'generic-warrior', profile: 'warrior', actorIds: [], archetypes: [], rights: { source: 'test', license: 'original' } },
      { key: 'fighter-rogue', profile: 'rogue', actorIds: [], archetypes: ['fighter'], rights: { source: 'test', license: 'original' } },
    ],
  }
  assert.equal(models.resolveModelProfile({ id: 'hero-8', label: 'Кто-то', kind: 'hero', archetype: 'fighter' }, catalog).key, 'fighter-rogue')
  assert.equal(models.resolveModelProfile({ id: 'bandit-1', label: 'Разбойник', kind: 'enemy', archetype: 'humanoid' }, manifest).profile, 'warrior')
})

test('пути GLB ограничены локальным каталогом', () => {
  assert.equal(models.safeModelUrl('/assets/models/warrior.glb'), '/assets/models/warrior.glb')
  assert.equal(models.safeModelUrl('warrior.glb'), '/assets/models/warrior.glb')
  for (const value of ['https://cdn.example/x.glb', '//cdn.example/x.glb', '/assets/models/../x.glb', '/assets/models/x.bin', 'data:model/gltf-binary;base64,abc']) {
    assert.equal(models.safeModelUrl(value), null, value)
  }
})

test('процедурные фигурки различимы, стоят на y=0 и освобождают ресурсы', () => {
  for (const profile of ['warrior', 'mage', 'rogue', 'goblin', 'skeleton', 'beast']) {
    const input = { id: `actor-${profile}`, label: profile, kind: 'enemy', archetype: profile }
    const selected = models.resolveModelProfile(input, manifest)
    const actor = models.createProceduralActorModel(input, manifest)
    assert.equal(actor.source, 'procedural')
    assert.equal(actor.profile, profile)
    assert.ok(Math.abs(actor.modelHeight - (selected.height ?? 1.4)) < 1e-8, `${profile}: высота должна соответствовать выбранной записи каталога`)
    assert.ok(actor.children.length > 0)
    const bounds = new Box3().setFromObject(actor)
    assert.ok(bounds.min.y >= -.0001, `${profile}: feet должны начинаться на y=0`)
    assert.ok(bounds.max.y > actor.modelHeight * .9, `${profile}: фигурка должна быть объёмной по высоте`)
    assert.ok(bounds.max.x - bounds.min.x > actor.modelHeight * .3, `${profile}: фигурка должна иметь ширину относительно роста`)
    assert.ok(bounds.max.z - bounds.min.z > actor.modelHeight * .3, `${profile}: фигурка должна иметь глубину относительно роста`)
    for (const pose of ['idle', 'walk', 'attack', 'cast', 'hit', 'death']) actor[pose]?.(.5)
    if (profile === 'beast') {
      actor.setPose('attack', .3)
      assert.notEqual(actor.getObjectByName('rig-leftArm')?.rotation.x, 0, 'зверь должен получать natural front-limb pose без appearance')
    }
    actor.dispose()
    actor.dispose()
    assert.equal(actor.children.length, 0)
  }
})

test('процедурный владелец поз различает рубящий, колющий, дробящий, безоружный и бросок', () => {
  const snapshot = (appearance, pose) => {
    const actor = models.createProceduralActorModel({ id: `pose-${pose}-${appearance.equipment}`, label: 'Атакующий', kind: 'hero', modelKey: 'warrior', appearance }, manifest)
    const rightArm = actor.getObjectByName('rig-rightArm')
    const leftArm = actor.getObjectByName('rig-leftArm')
    const motion = actor.getObjectByName('actor-motion')
    actor.setPose(pose, .5)
    const result = { right: rightArm?.rotation.toArray(), left: leftArm?.rotation.toArray(), z: motion?.position.z }
    actor.dispose()
    return result
  }
  const sword = snapshot({ version: 1, profile: 'warrior', equipment: 'sword' }, 'attack')
  const dagger = snapshot({ version: 1, profile: 'warrior', equipment: 'dagger' }, 'attack')
  const staff = snapshot({ version: 1, profile: 'warrior', equipment: 'staff' }, 'attack')
  const unarmed = snapshot({ version: 1, profile: 'warrior', equipment: 'unarmed' }, 'attack')
  const beast = snapshot({ version: 1, profile: 'beast', equipment: 'unknown' }, 'attack')
  assert.notDeepEqual(sword, dagger)
  assert.notDeepEqual(sword, staff)
  assert.notDeepEqual(sword, unarmed)
  assert.notDeepEqual(sword, beast)
  const thrown = snapshot({ version: 2, profile: 'warrior', equipment: 'dagger', loadout: { main_hand: { model_key: 'dagger' } } }, 'ranged-attack')
  const javelin = snapshot({ version: 2, profile: 'warrior', equipment: 'unknown', loadout: { main_hand: { model_key: 'javelin' } } }, 'ranged-attack')
  const net = snapshot({ version: 2, profile: 'warrior', equipment: 'unknown', loadout: { main_hand: { model_key: 'net' } } }, 'ranged-attack')
  const bow = snapshot({ version: 2, profile: 'warrior', equipment: 'bow', loadout: { main_hand: { model_key: 'longbow' } } }, 'ranged-attack')
  const crossbow = snapshot({ version: 2, profile: 'warrior', equipment: 'bow', loadout: { main_hand: { model_key: 'light-crossbow' } } }, 'ranged-attack')
  assert.notDeepEqual(thrown, bow)
  assert.notDeepEqual(javelin, bow)
  assert.notDeepEqual(net, bow)
  assert.notDeepEqual(bow, crossbow)
})

function glbWithJson(json, binary = new Uint8Array()) {
  const encoded = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunkLength = Math.ceil(encoded.length / 4) * 4
  const binaryChunkLength = binary.length ? Math.ceil(binary.length / 4) * 4 : 0
  const bytes = new Uint8Array(12 + 8 + jsonChunkLength + (binaryChunkLength ? 8 + binaryChunkLength : 0))
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.byteLength, true)
  view.setUint32(12, jsonChunkLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.set(encoded, 20)
  // GLB JSON padding is spaces; GLTFLoader passes the chunk directly to
  // JSON.parse, where NUL padding would be an invalid trailing character.
  bytes.fill(0x20, 20 + encoded.length, 20 + jsonChunkLength)
  if (binaryChunkLength) {
    const offset = 20 + jsonChunkLength
    view.setUint32(offset, binaryChunkLength, true)
    view.setUint32(offset + 4, 0x004e4942, true)
    bytes.set(binary, offset + 8)
  }
  return bytes.buffer
}

test('GLB с embedded JSON проходит, внешняя uri-ссылка отклоняется', () => {
  const valid = models.validateGlbContainer(glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }))
  assert.equal(valid.hasBinaryChunk, false)
  assert.throws(() => models.validateGlbContainer(glbWithJson({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 0 }] })), /внешние ресурсы/u)
})

test('подготовленные KayKit GLB проходят локальную проверку контейнера', () => {
  for (const { file } of kaykitAssets) {
    const report = models.validateGlbContainer(readFileSync(join(kaykitRoot, file)))
    assert.equal(report.hasBinaryChunk, true, `${file}: отсутствует BIN chunk`)
    assert.deepEqual(report.json.animations?.map((animation) => animation.name), ['idle', 'walk', 'attack', 'cast', 'hit', 'death'], `${file}: должен содержать шесть подготовленных клипов`)
    assert.ok(Array.isArray(report.json.images) && report.json.images.every((image) => image && image.bufferView != null), `${file}: изображение не встроено bufferView`)
  }
})

test('все KayKit GLB проходят loader lifecycle, позы, тени и disposal', async () => {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  // Node не умеет декодировать PNG, поэтому возвращаем минимальный ImageBitmap
  // только для проверки геометрии/клипов. В браузере это делает нативный API.
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try {
    for (const { key, file } of kaykitAssets) {
      const bytes = readFileSync(join(kaykitRoot, file))
      const actor = await models.createActorModel({ id: `kaykit-${key}`, label: key, kind: key === 'skeleton' ? 'enemy' : 'hero', modelKey: key }, {
        manifest,
        fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
      })
      assert.equal(actor.source, 'glb', `${file}: должен загрузиться GLB, а не fallback`)
      assert.equal(actor.modelHeight, 1.4)
      assert.ok(Math.abs(actor.position.x) < 1e-8 && Math.abs(actor.position.z) < 1e-8, `${file}: GLB origin rig-а не должен съезжать из-за оружия/накидки`)
      const bounds = new Box3().setFromObject(actor)
      assert.ok(Number.isFinite(bounds.min.x) && Number.isFinite(bounds.min.y) && Number.isFinite(bounds.min.z), `${file}: bounds должны быть конечными`)
      assert.ok(bounds.min.y >= -.0001 && bounds.max.y <= 1.4001, `${file}: GLB должен стоять в нормализованном диапазоне высоты`)
      const bones = []
      const renderables = []
      actor.traverse((object) => {
        if (object.isBone) bones.push(object)
        if (object.isMesh) renderables.push(object)
      })
      assert.ok(bones.length > 0, `${file}: должен содержать скелет`)
      assert.ok(renderables.length > 0 && renderables.every((object) => object.castShadow && object.receiveShadow), `${file}: mesh должен отбрасывать и принимать тени`)
      const poseSignature = () => {
        actor.updateMatrixWorld(true)
        return JSON.stringify(bones.map((bone) => ({ position: bone.position.toArray(), quaternion: bone.quaternion.toArray() })))
      }
      actor.idle?.(0)
      actor.update(.001)
      const idleStart = poseSignature()
      actor.idle?.(.5)
      actor.update(.001)
      assert.notEqual(poseSignature(), idleStart, `${file}: idle должен менять кости`)
      actor.idle?.()
      actor.update(.001)
      const idlePlaybackStart = poseSignature()
      actor.update(.2)
      assert.notEqual(poseSignature(), idlePlaybackStart, `${file}: idle() без progress должен проигрываться через update`)
      for (const pose of ['walk', 'attack', 'cast', 'hit']) {
        assert.equal(typeof actor[pose], 'function', `${file}: отсутствует поза ${pose}`)
        actor[pose](.5)
        actor.update(.001)
      }
      actor.death?.(1)
      actor.update(.001)
      const deathEnd = poseSignature()
      actor.update(.5)
      assert.equal(poseSignature(), deathEnd, `${file}: конечная поза death должна сохраняться`)
      actor.dispose()
      assert.equal(actor.children.length, 0, `${file}: dispose должен очистить Group`)
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

test('v2 использует нейтральную основу и меняет настоящие GLB вещей без замены тела', async () => {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  let actor
  try {
    const requests = []
    const fetcher = async (url) => {
      assert.ok(String(url).startsWith('/assets/models/'))
      requests.push(String(url))
      return new Response(readFileSync(new URL(`../public${url}`, import.meta.url)), { status: 200 })
    }
    const empty = { version: 2, profile: 'warrior', equipment: 'unarmed', loadout: {} }
    actor = await models.createActorModel({ id: 'wardrobe-test', label: 'Герой', kind: 'hero', modelKey: 'traveler', appearance: empty }, { manifest, fetcher })
    assert.equal(actor.source, 'glb')
    assert.equal(requests[0], manifest.models.find((entry) => entry.key === 'traveler').equipmentUrl)
    const body = actor.getObjectByName('Body')
    const originalGeometry = body.geometry
    const rightHand = actor.getObjectByName('hand_r')
    actor.setPose('idle', .42)
    actor.updateMatrixWorld(true)
    const idleHand = rightHand.getWorldPosition(new Vector3())
    actor.setPose('idle', .42)
    actor.updateMatrixWorld(true)
    assert.ok(idleHand.distanceTo(rightHand.getWorldPosition(new Vector3())) < 1e-7, 'повторное отображение idle не возвращает руки в bind-позу')
    actor.setAppearance({ ...empty, equipment: 'sword-shield', loadout: {
      body: { model_key: 'armor-plate' }, main_hand: { model_key: 'longsword' }, off_hand: { model_key: 'shield' },
    } })
    await actor.equipmentReady
    assert.equal(actor.equipmentStatus, 'ready', actor.equipmentError?.message)
    assert.equal(actor.getObjectByName('Body'), body)
    assert.equal(body.geometry, originalGeometry, 'маска не мутирует исходную геометрию')
    const pieces = []
    actor.traverse((object) => { if (/^part:?/u.test(object.name) && object.parent?.isBone) pieces.push(object) })
    assert.ok(pieces.length >= 12, `отдельно закреплено ${pieces.length} частей вместо полного доспеха`)
    const held = actor.getObjectByName('equipment-main_hand-longsword-default')
    assert.ok(held, 'реальный длинный меч загружен')
    let parent = held.parent
    while (parent && parent !== rightHand) parent = parent.parent
    assert.equal(parent, rightHand, 'меч следует правой кисти')
    actor.setPose('walk', .65)
    actor.update(.001)
    actor.setAppearance(empty)
    await actor.equipmentReady
    assert.equal(actor.getObjectByName('Body'), body)
    assert.equal(body.visible, true, 'снятие брони восстанавливает базовую одежду')
    assert.equal(body.geometry, originalGeometry)
    assert.equal(actor.getObjectByName('equipment-main_hand-longsword-default'), undefined)
    assert.equal(actor.getObjectByName('hand_r'), rightHand)
  } finally {
    actor?.dispose()
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

// Quaternius-набор проверяется по ключам: первыми в профилях mage/skeleton
// теперь стоят KayKit 2.0 (их проверка — ниже, «KayKit 2.0 …»).
const productionProfiles = ['hooded-mage', 'goblin-quaternius', 'wolf', 'skeleton-quaternius'].map((key) => manifest.models.find((entry) => entry.key === key))

test('опубликованные Quaternius actor GLB проходят семь поз, rig aliases и fit после idle', async () => {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try {
    for (const entry of productionProfiles) {
      assert.ok(entry?.url)
      const bytes = readFileSync(join(fileURLToPath(new URL('../public/', import.meta.url)), entry.url.slice(1)))
      const report = models.validateGlbContainer(bytes)
      assert.ok(report.json.animations?.length, `${entry.profile}: должны быть реальные clips`)
      assert.equal(report.json.animations?.some((animation) => animation.channels?.some((channel) => channel.target?.path === 'scale')), false, `${entry.profile}: scale channels не должны отменять fitToHeight`)
      const expectedClip = { mage: 'Spell_Simple_Shoot', goblin: 'RecieveHit', beast: 'Idle_HitReact1', skeleton: 'SkeletonArmature|Skeleton_Running' }[entry.profile]
      assert.ok(report.json.animations.some((animation) => animation.name === expectedClip), `${entry.profile}: отсутствует source clip ${expectedClip}`)
      const actor = await models.createActorModel({ id: `production-${entry.profile}`, label: entry.name_ru ?? entry.profile, kind: entry.profile === 'mage' ? 'hero' : 'enemy', modelKey: entry.key }, {
        manifest,
        fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
      })
      assert.equal(actor.source, 'glb', `${entry.profile}: должен использовать production GLB`)
      assert.equal(actor.profile, entry.profile)
      const bones = []
      actor.traverse((object) => { if (object.isBone) bones.push(object) })
      assert.ok(bones.length > 0, `${entry.profile}: rig`)
      const poseSignature = () => JSON.stringify(bones.map((bone) => ({ position: bone.position.toArray(), quaternion: bone.quaternion.toArray() })))
      if (entry.profile === 'beast') {
        const body = actor.getObjectByName('Body')
        const head = actor.getObjectByName('Head')
        assert.ok(body && head, 'beast: Body/Head forward anchors')
        const forwardAngle = () => {
          const bodyPosition = body.getWorldPosition(new Vector3())
          const headPosition = head.getWorldPosition(new Vector3())
          return Math.atan2(headPosition.x - bodyPosition.x, headPosition.z - bodyPosition.z)
        }
        actor.idle?.(0)
        actor.update(.001)
        const idleForward = forwardAngle()
        actor.walk?.(0)
        actor.update(.001)
        const walkForward = forwardAngle()
        assert.ok(Math.abs(idleForward) < .08 && Math.abs(walkForward) < .08, 'beast: Body→Head должен смотреть в +Z после idle/walk')
      }
      actor.idle?.(0)
      actor.update(.001)
      const idleStart = poseSignature()
      actor.idle?.(.5)
      actor.update(.001)
      assert.notEqual(poseSignature(), idleStart, `${entry.profile}: idle должен вращать кости`)
      for (const pose of ['idle', 'walk', 'attack', 'rangedAttack', 'cast', 'hit', 'death']) {
        assert.equal(typeof actor[pose], 'function', `${entry.profile}: pose API ${pose}`)
        actor[pose](.5)
        actor.update(.001)
      }
      actor.idle?.()
      actor.update(.2)
      const bounds = new Box3().setFromObject(actor)
      assert.ok(bounds.min.y >= -.0001 && bounds.max.y > bounds.min.y, `${entry.profile}: finite floor bounds after idle`)
      if (entry.profile === 'goblin') {
        actor.setEquipment('sword')
        const sword = actor.getObjectByName('sword')
        assert.ok(sword && ['hand_r', 'hand_l', 'FistR', 'FistL'].includes(sword.parent?.name ?? ''), 'goblin: sword должен быть на native fist socket')
        assert.ok(Math.abs(sword.rotation.x) < 1e-6, 'goblin: native socket не должен получать Quaternius rotation')
        const swordBounds = new Box3().setFromObject(sword).getSize(new Vector3())
        assert.ok(Math.max(...swordBounds.toArray()) > actor.modelHeight * .25, 'goblin: sword должен иметь production world size')
        const swordExtent = Math.max(...swordBounds.toArray())
        actor.setEquipment('dagger')
        const dagger = actor.getObjectByName('dagger')
        const daggerExtent = dagger ? Math.max(...new Box3().setFromObject(dagger).getSize(new Vector3()).toArray()) : 0
        assert.ok(daggerExtent > swordExtent * .6 && daggerExtent < swordExtent * .8, 'goblin: dagger scale .72 не должна стираться world-scale компенсацией')
      }
      if (entry.profile === 'mage') {
        actor.setEquipment('staff')
        const staff = actor.getObjectByName('staff')
        assert.ok(staff && ['hand_l', 'hand_r'].includes(staff.parent?.name ?? ''), 'mage: staff socket')
        const shaft = actor.getObjectByName('staff-shaft')
        const staffAxis = shaft ? new Vector3(0, 1, 0).applyQuaternion(shaft.getWorldQuaternion(new Quaternion())).normalize() : new Vector3()
        const staffBounds = staff ? new Box3().setFromObject(staff).getSize(new Vector3()) : new Vector3()
        assert.ok(Math.abs(staffAxis.y) > .8 && staffBounds.y > actor.modelHeight * .3, 'mage: staff должен быть вертикальным и видимым в world units')
        actor.idle?.(0)
        actor.update(.001)
        const grip = staff?.parent?.getWorldPosition(new Vector3())
        const crystal = actor.getObjectByName('staff-crystal')?.getWorldPosition(new Vector3())
        assert.ok(grip && crystal && crystal.y > grip.y, 'mage: crystal должен быть над хватом в idle')
      }
      if (entry.profile === 'skeleton') {
        actor.setEquipment('sword-shield')
        const sword = actor.getObjectByName('sword')
        const shield = actor.getObjectByName('shield')
        assert.ok(sword && ['hand_l', 'hand_r'].includes(sword.parent?.name ?? ''), 'skeleton: sword должен быть на end-bone socket')
        assert.ok(shield && ['hand_l', 'hand_r'].includes(shield.parent?.name ?? ''), 'skeleton: shield должен быть на end-bone socket')
        assert.ok(Math.abs(sword.rotation.x) < 1e-6 && Math.abs(shield.rotation.x) < 1e-6, 'skeleton: native sockets не получают Quaternius rotation')
        assert.ok(Math.max(...new Box3().setFromObject(sword).getSize(new Vector3()).toArray()) > actor.modelHeight * .25, 'skeleton: sword должен иметь production world size')
        assert.ok(Math.max(...new Box3().setFromObject(shield).getSize(new Vector3()).toArray()) > actor.modelHeight * .18, 'skeleton: shield должен иметь production world size')
      }
      actor.dispose()
      assert.equal(actor.children.length, 0, `${entry.profile}: disposal`)
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

test('embedded-текстура GLB в браузерном пути идёт через HTML Image, а не fetch(blob:)', async () => {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  const previousDocument = globalThis.document
  let imageBitmapCalls = 0
  const makeImage = () => {
    const listeners = new Map()
    const image = { width: 4, height: 4, complete: false, addEventListener(type, listener) { listeners.set(type, listener) }, removeEventListener(type) { listeners.delete(type) } }
    Object.defineProperty(image, 'src', { set(value) { image.url = value; image.complete = true; queueMicrotask(() => listeners.get('load')?.call(image)) }, get() { return image.url } })
    return image
  }
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => { imageBitmapCalls += 1; throw new Error('CSP ImageBitmap path must not run') }
  globalThis.document = { createElementNS(_namespace, name) { assert.equal(name, 'img'); return makeImage() } }
  try {
    const bytes = readFileSync(join(kaykitRoot, 'knight.glb'))
    const actor = await models.createActorModel({ id: 'csp-knight', label: 'Рыцарь', kind: 'hero', modelKey: 'warrior' }, {
      manifest,
      fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
    })
    assert.equal(actor.source, 'glb', 'HTML Image path должен позволить загрузку GLB при заблокированном fetch(blob:)')
    let texturedMeshes = 0
    actor.traverse((object) => {
      const surfaces = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
      if (surfaces.some((surface) => surface.map)) texturedMeshes += 1
    })
    assert.ok(texturedMeshes > 0, 'после CSP-safe загрузки материалы GLB должны иметь map')
    assert.equal(imageBitmapCalls, 0)
    actor.dispose()
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('self-contained GLB загружается через loader и освобождается как ActorModel', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1])
  const indices = new Uint16Array([0, 1, 2])
  const binary = new Uint8Array(44)
  binary.set(new Uint8Array(positions.buffer), 0)
  binary.set(new Uint8Array(indices.buffer), 36)
  const glb = glbWithJson({
    asset: { version: '2.0', generator: 'actor-models-test' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR', min: [0], max: [2] },
    ],
  }, binary)
  const catalog = {
    version: 1,
    models: [{ key: 'triangle-glb', profile: 'warrior', actorIds: [], archetypes: [], url: '/assets/models/triangle.glb', rights: { source: 'test', license: 'original' } }],
  }
  await new Promise((resolve, reject) => new GLTFLoader().parse(glb, '/assets/models/', () => resolve(), reject))
  const actor = await models.createActorModel({ id: 'glb-1', label: 'Треугольник', kind: 'hero', modelKey: 'triangle-glb' }, {
    manifest: catalog,
    fetcher: async () => new Response(glb, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
  })
  assert.equal(actor.source, 'glb')
  assert.equal(actor.profile, 'warrior')
  assert.ok(actor.getObjectByName('Mesh_0') || actor.children.length > 0)
  const renderables = []
  actor.traverse((object) => { if (object.isMesh) renderables.push(object) })
  assert.ok(renderables.length > 0)
  assert.ok(renderables.every((object) => object.castShadow && object.receiveShadow), 'GLB mesh должен отбрасывать и принимать тени')
  assert.equal(typeof actor.idle, 'function', 'GLB должен безопасно отвечать на idle даже без idle-клипа')
  for (const pose of ['walk', 'attack', 'rangedAttack', 'cast', 'hit', 'death']) assert.equal(typeof actor[pose], 'function', `${pose}: безопасный pose API`)
  actor.dispose()
  assert.equal(actor.children.length, 0)
})

test('ошибка отсутствующего GLB откатывает создание к procedural fallback', async () => {
  const catalog = {
    version: 1,
    models: [{ key: 'local-beast', profile: 'beast', actorIds: [], archetypes: [], url: '/assets/models/missing.glb', rights: { source: 'test', license: 'original' } }],
  }
  const actor = await models.createActorModel({ id: 'missing', label: 'Зверь', kind: 'enemy', modelKey: 'local-beast' }, {
    manifest: catalog,
    fetcher: async () => new Response('нет', { status: 404 }),
  })
  assert.equal(actor.source, 'procedural')
  assert.equal(actor.profile, 'beast')
  actor.dispose()
})

test('отмена до загрузки не вызывает fetch, испорченный каталог даёт fallback', async () => {
  const controller = new AbortController()
  controller.abort(new Error('test abort'))
  let called = false
  await assert.rejects(
    models.createActorModel({ id: 'cancelled', label: 'Воин', kind: 'hero' }, {
      signal: controller.signal,
      fetcher: async () => { called = true; return Response.json(manifest) },
    }),
    /test abort/u,
  )
  assert.equal(called, false)

  const actor = await models.createActorModel({ id: 'bad-catalog', label: 'Гоблин', kind: 'enemy', modelKey: 'goblin' }, {
    manifest: { broken: true },
    fetcher: async () => { throw new Error('не должен вызываться') },
  })
  assert.equal(actor.source, 'procedural')
  assert.equal(actor.profile, 'goblin')
  actor.dispose()
})

test('обновление каталога и GLB перепроверяет HTTP-кеш файлов с постоянным именем', async () => {
  const requests = []
  const catalog = await models.loadActorModelManifest({
    fetcher: async (url, init) => {
      requests.push({ url, cache: init?.cache })
      return Response.json(manifest)
    },
  })
  const actor = await models.createActorModel({ id: 'fresh', label: 'Рыцарь', kind: 'hero', modelKey: 'warrior' }, {
    manifest: catalog,
    fetcher: async (url, init) => {
      requests.push({ url, cache: init?.cache })
      return new Response('нет файла', { status: 404 })
    },
  })
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.cache === 'no-cache'))
  actor.dispose()
})

test('общий кэш GLB разделяет fetch между consumers и оставляет его после отмены одного', async () => {
  models.clearActorModelCache()
  models.resetModelAssetDiagnostics()
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const url = '/assets/models/shared-consumers.glb'
  let calls = 0
  let release
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const fetcher = async (_url, init) => {
    calls += 1
    startedResolve()
    await new Promise((resolve, reject) => {
      release = resolve
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
  }
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = models.loadSharedModelBuffer(url, { fetcher, signal: firstController.signal, timeoutMs: 2_000, maxBytes: 1024 })
  const second = models.loadSharedModelBuffer(url, { fetcher, signal: secondController.signal, timeoutMs: 2_000, maxBytes: 1024 })
  await started
  firstController.abort(new Error('first consumer cancelled'))
  await assert.rejects(first, /first consumer cancelled/u)
  assert.equal(calls, 1, 'отмена первого consumer не должна запускать новый fetch')
  release()
  assert.deepEqual(new Uint8Array(await second), new Uint8Array(bytes))
  assert.deepEqual(new Uint8Array(await models.loadSharedModelBuffer(url, { fetcher, timeoutMs: 2_000, maxBytes: 1024 })), new Uint8Array(bytes))
  const diagnostics = models.getModelAssetDiagnostics()
  assert.equal(diagnostics.fetches, 1)
  assert.ok(diagnostics.cacheHits >= 2, 'повторный consumer и cache hit должны быть видны в диагностике')
  models.clearActorModelCache()
})

test('общий fetch вызывается без привязки к записи кэша', async () => {
  models.clearActorModelCache()
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const fetcher = async function (_url, _init) {
    assert.equal(this, undefined, 'native fetch нельзя вызывать с this=entry кэша')
    return new Response(bytes, { status: 200 })
  }
  await models.loadSharedModelBuffer('/assets/models/detached-fetch.glb', { fetcher, timeoutMs: 2_000, maxBytes: 1024 })
  models.clearActorModelCache()
})

test('общий fetch отменяется после последнего consumer, а failed и invalid GLB retry', async () => {
  models.clearActorModelCache()
  const abortUrl = '/assets/models/all-consumers-cancel.glb'
  let commonAborts = 0
  const abortFetcher = async (_url, init) => {
    await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      commonAborts += 1
      reject(init.signal.reason)
    }, { once: true }))
  }
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = models.loadSharedModelBuffer(abortUrl, { fetcher: abortFetcher, signal: firstController.signal, timeoutMs: 2_000, maxBytes: 1024 })
  const second = models.loadSharedModelBuffer(abortUrl, { fetcher: abortFetcher, signal: secondController.signal, timeoutMs: 2_000, maxBytes: 1024 })
  await new Promise((resolve) => setImmediate(resolve))
  firstController.abort(new Error('first cancelled'))
  await assert.rejects(first, /first cancelled/u)
  assert.equal(commonAborts, 0)
  secondController.abort(new Error('last cancelled'))
  await assert.rejects(second, /last cancelled/u)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(commonAborts, 1, 'последняя отмена должна прервать общий fetch ровно один раз')

  const retryUrl = '/assets/models/failed-retry.glb'
  let attempts = 0
  const retryGlb = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const retryFetcher = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary failure')
    return new Response(retryGlb, { status: 200 })
  }
  await assert.rejects(models.loadSharedModelBuffer(retryUrl, { fetcher: retryFetcher, timeoutMs: 2_000, maxBytes: 1024 }), /temporary failure/u)
  assert.deepEqual(new Uint8Array(await models.loadSharedModelBuffer(retryUrl, { fetcher: retryFetcher, timeoutMs: 2_000, maxBytes: 1024 })), new Uint8Array(retryGlb))
  assert.equal(attempts, 2, 'ошибка не должна застревать в кэше')

  const invalidUrl = '/assets/models/invalid-retry.glb'
  let invalidAttempts = 0
  const validGlb = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const invalidFetcher = async () => {
    invalidAttempts += 1
    return new Response(glbWithJson({ asset: { version: invalidAttempts === 1 ? '1.0' : '2.0' }, scenes: [{ nodes: [] }] }), { status: 200 })
  }
  await assert.rejects(models.loadSharedModelBuffer(invalidUrl, { fetcher: invalidFetcher, timeoutMs: 2_000, maxBytes: 1024 }), /asset.version/u)
  assert.equal((await models.loadSharedModelBuffer(invalidUrl, { fetcher: invalidFetcher, timeoutMs: 2_000, maxBytes: 1024 })).byteLength, validGlb.byteLength)
  assert.equal(invalidAttempts, 2, 'ошибка validation не должна сохранять битый байт-кэш')
  models.clearActorModelCache()
})

test('байтовый кэш ограничен общим бюджетом после множества разных GLB', async () => {
  models.clearActorModelCache()
  models.resetModelAssetDiagnostics()
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }, new Uint8Array(700_000))
  const fetcher = async () => new Response(bytes, { status: 200 })
  for (let index = 0; index < 50; index += 1) {
    await models.loadSharedModelBuffer(`/assets/models/lru-${index}.glb`, { fetcher, timeoutMs: 2_000, maxBytes: 2_000_000 })
  }
  const diagnostics = models.getModelAssetDiagnostics()
  assert.ok(diagnostics.cachedBytes <= 32 * 1024 * 1024, `кэш занял ${diagnostics.cachedBytes} байт`)
  assert.ok(diagnostics.entries < 50, `LRU не вытеснил старые записи: ${diagnostics.entries}`)
  assert.equal(diagnostics.pending, 0)
  models.clearActorModelCache()
})

test('отмена после parse освобождает поздно пришедший ActorModel', async () => {
  models.clearActorModelCache()
  models.resetModelAssetDiagnostics()
  const url = '/assets/models/abort-during-parse.glb'
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const controller = new AbortController()
  const geometry = new BoxGeometry(1, 1, 1)
  const material = new MeshBasicMaterial()
  const scene = new Group()
  scene.add(new Mesh(geometry, material))
  let geometryDisposed = 0
  let materialDisposed = 0
  geometry.addEventListener('dispose', () => { geometryDisposed += 1 })
  material.addEventListener('dispose', () => { materialDisposed += 1 })
  const loader = {
    register() {},
    parse(_buffer, _path, onLoad) {
      queueMicrotask(() => {
        controller.abort(new Error('parse cancelled'))
        onLoad({ scene, animations: [] })
      })
    },
  }
  const manifest = {
    version: 1,
    models: [{ key: 'abort-model', profile: 'warrior', actorIds: [], archetypes: [], url, rights: { source: 'test', license: 'test' } }],
  }
  await assert.rejects(models.createActorModel({ id: 'abort-actor', label: 'Воин', kind: 'hero', modelKey: 'abort-model' }, {
    manifest, signal: controller.signal, loader,
    fetcher: async () => new Response(bytes, { status: 200 }),
  }), /parse cancelled/u)
  assert.equal(geometryDisposed, 1, 'поздняя геометрия должна быть освобождена')
  assert.equal(materialDisposed, 1, 'поздний material должен быть освобождён')
  assert.equal(models.getModelAssetDiagnostics().parses, 1)
  models.clearActorModelCache()
})

const appearance = (profile, equipment) => ({ version: 1, profile, equipment })
const accessoryNames = new Set(['sword', 'shield', 'bow', 'staff', 'dagger', 'short-blade', 'rusty-cleaver'])
function isAccessory(object, actor) {
  for (let current = object; current && current !== actor; current = current.parent) if (accessoryNames.has(current.name)) return true
  return false
}
function bodySignature(actor) {
  const result = []
  actor.traverse((object) => {
    if (isAccessory(object, actor)) return
    result.push({ object, name: object.name, position: object.position.toArray(), rotation: object.rotation.toArray(), visible: object.visible })
  })
  return result
}
function resourceDisposalWatch(group) {
  let geometries = 0
  let materials = 0
  const watchedGeometries = new Set()
  const watchedMaterials = new Set()
  group.traverse((object) => {
    if (object.geometry && !watchedGeometries.has(object.geometry)) {
      watchedGeometries.add(object.geometry)
      object.geometry.addEventListener('dispose', () => { geometries += 1 })
    }
    const surfaces = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const surface of surfaces) if (!watchedMaterials.has(surface)) {
      watchedMaterials.add(surface)
      surface.addEventListener('dispose', () => { materials += 1 })
    }
  })
  return { get geometries() { return geometries }, get materials() { return materials } }
}

test('appearance server profile wins over automatic identity, local modelKey wins over server profile', () => {
  const catalog = {
    version: 1,
    models: [
      { key: 'masked-warrior', profile: 'warrior', actorIds: ['masked-1'], archetypes: ['fighter'], rights: { source: 'test', license: 'original' } },
      { key: 'masked-rogue', profile: 'rogue', actorIds: [], archetypes: [], rights: { source: 'test', license: 'original' } },
    ],
  }
  assert.equal(models.resolveModelProfile({ id: 'masked-1', label: 'Кто-то', kind: 'hero', archetype: 'fighter', appearance: appearance('rogue', 'unknown') }, catalog).key, 'masked-rogue')
  assert.equal(models.resolveModelProfile({ id: 'masked-1', label: 'Кто-то', kind: 'hero', modelKey: 'masked-warrior', appearance: appearance('rogue', 'unknown') }, catalog).key, 'masked-warrior')
  assert.deepEqual(models.normalizeActorInput({ id: 'x', label: 'x', kind: 'hero', appearance: appearance('warrior', 'unarmed') }).appearance, appearance('warrior', 'unarmed'))
})

test('undefined appearance сохраняет legacy-комплект procedural', () => {
  const actor = models.createProceduralActorModel({ id: 'legacy-equipment', label: 'Воин', kind: 'hero', archetype: 'warrior' }, manifest)
  assert.ok(actor.getObjectByName('sword'))
  assert.ok(actor.getObjectByName('shield'))
  actor.setEquipment(undefined)
  assert.ok(actor.getObjectByName('sword'))
  assert.ok(actor.getObjectByName('shield'))
  actor.dispose()
})

test('sword-shield → bow → unarmed меняет только аксессуары процедурной модели', () => {
  const actor = models.createProceduralActorModel({ id: 'equipment-procedural', label: 'Воин', kind: 'hero', appearance: appearance('warrior', 'sword-shield') }, manifest)
  assert.equal(actor.equipment, 'sword-shield')
  assert.ok(actor.getObjectByName('sword'))
  assert.ok(actor.getObjectByName('shield'))
  const before = bodySignature(actor)
  const swordResources = resourceDisposalWatch(actor.getObjectByName('sword'))
  const shieldResources = resourceDisposalWatch(actor.getObjectByName('shield'))

  actor.setEquipment('bow')
  assert.equal(actor.equipment, 'bow')
  assert.equal(actor.getObjectByName('sword'), undefined)
  assert.equal(actor.getObjectByName('shield'), undefined)
  assert.ok(actor.getObjectByName('bow'))
  assert.ok(swordResources.geometries > 0 && swordResources.materials > 0, 'смена должна освободить sword')
  assert.ok(shieldResources.geometries > 0 && shieldResources.materials > 0, 'смена должна освободить shield')
  const afterBow = bodySignature(actor)
  assert.deepEqual(afterBow.map((item) => item.object), before.map((item) => item.object), 'объекты тела не должны пересоздаваться')
  assert.deepEqual(afterBow.map(({ name, position, rotation, visible }) => ({ name, position, rotation, visible })), before.map(({ name, position, rotation, visible }) => ({ name, position, rotation, visible })), 'тело и его поза не должны меняться')

  const bowResources = resourceDisposalWatch(actor.getObjectByName('bow'))
  actor.setEquipment('unarmed')
  assert.equal(actor.equipment, 'unarmed')
  assert.equal(actor.getObjectByName('bow'), undefined)
  assert.ok(bowResources.geometries > 0 && bowResources.materials > 0, 'уход с bow должен освободить ресурсы')
  actor.setEquipment('unknown')
  assert.equal(actor.getObjectByName('sword'), undefined)
  assert.equal(actor.getObjectByName('shield'), undefined)
  assert.equal(actor.getObjectByName('bow'), undefined)
  actor.dispose()
})

test('KayKit equipment скрывает проверенные комплекты и крепит новые к handslot', async () => {
  const bytes = readFileSync(join(kaykitRoot, 'knight.glb'))
  const input = { id: 'equipment-kaykit', label: 'Воин', kind: 'hero', modelKey: 'warrior', appearance: appearance('warrior', 'bow') }
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try {
    const actor = await models.createActorModel(input, {
      manifest,
      fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
    })
    assert.equal(actor.source, 'glb')
    for (const name of ['1H_Sword_Offhand', '1H_Sword', '2H_Sword', 'Badge_Shield', 'Rectangle_Shield', 'Round_Shield', 'Spike_Shield']) assert.equal(actor.getObjectByName(name)?.visible, false, `${name} должен быть скрыт`)
    const bow = actor.getObjectByName('bow')
    assert.ok(bow)
    assert.ok(['handslot.r', 'handslotr'].includes(bow.parent?.name), 'bow должен быть на правом KayKit socket')
    const bonesBefore = bodySignature(actor).filter((item) => item.object.isBone).map(({ name, position, rotation }) => ({ name, position, rotation }))
    actor.setEquipment('unarmed')
    assert.equal(actor.getObjectByName('bow'), undefined)
    assert.equal(actor.getObjectByName('1H_Sword')?.visible, false)
    const bonesAfter = bodySignature(actor).filter((item) => item.object.isBone).map(({ name, position, rotation }) => ({ name, position, rotation }))
    assert.deepEqual(bonesAfter, bonesBefore, 'смена оружия не должна трогать skeleton/skin')
    actor.dispose()
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

test('две GLB-копии имеют независимые аксессуары, а late ranged pose не вызывает melee', async () => {
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const loader = {
    register() {},
    parse(_buffer, _path, onLoad) {
      const scene = new Group()
      scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()))
      const hand = new Group(); hand.name = 'hand_r'; scene.add(hand)
      const bowClip = new AnimationClip('Bow_Shoot', 1, [new NumberKeyframeTrack('hand_r.position[x]', [0, 1], [0, 1])])
      const meleeClip = new AnimationClip('Attack', 1, [new NumberKeyframeTrack('hand_r.position[z]', [0, 1], [0, 1])])
      queueMicrotask(() => onLoad({ scene, animations: [bowClip, meleeClip] }))
    },
  }
  const catalog = {
    version: 1,
    models: [{ key: 'late-ranger', profile: 'rogue', actorIds: [], archetypes: [], url: '/assets/models/late-ranger.glb', rights: { source: 'test', license: 'original' } }],
  }
  const make = (id) => models.createActorModel({ id, label: 'Следопыт', kind: 'hero', modelKey: 'late-ranger', appearance: appearance('rogue', 'bow') }, { manifest: catalog, loader, fetcher: async () => new Response(bytes, { status: 200 }) })
  const first = await make('late-ranger-1')
  const second = await make('late-ranger-2')
  assert.notEqual(first.getObjectByName('bow'), second.getObjectByName('bow'))
  assert.equal(first.getObjectByName('bow')?.parent?.name, 'hand_r')
  assert.ok(Math.abs(first.getObjectByName('bow').rotation.x - Math.PI / 2) < 1e-8, 'Quaternius bow должен учитывать forward +Z')
  assert.notEqual(first.getObjectByName('bow')?.children[0]?.geometry, second.getObjectByName('bow')?.children[0]?.geometry)
  const firstHand = first.getObjectByName('hand_r')
  first.setPose('ranged-attack')
  first.update(.5)
  assert.ok(firstHand.position.x > 0, 'Bow/Shoot должен попасть в ranged-attack')
  assert.equal(firstHand.position.z, 0, 'ranged-attack не должен запускать melee Attack')
  first.setEquipment('unarmed')
  assert.equal(first.getObjectByName('bow'), undefined)
  first.dispose(); second.dispose()
})

test('GLB без собственного attack клипа получает безопасный procedural overlay', async () => {
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const loader = {
    register() {},
    parse(_buffer, _path, onLoad) {
      const scene = new Group()
      scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()))
      for (const name of ['upperarm.r', 'upperarm.l', 'lowerarm.r', 'lowerarm.l', 'chest', 'hand_r']) {
        const bone = new Group(); bone.name = name; scene.add(bone)
      }
      queueMicrotask(() => onLoad({ scene, animations: [] }))
    },
  }
  const catalog = {
    version: 1,
    models: [{ key: 'overlay-warrior', profile: 'warrior', actorIds: [], archetypes: [], url: '/assets/models/overlay-warrior.glb', rights: { source: 'test', license: 'original' } }],
  }
  const actor = await models.createActorModel({ id: 'overlay-warrior', label: 'Воин', kind: 'hero', modelKey: 'overlay-warrior', appearance: appearance('warrior', 'sword') }, {
    manifest: catalog, loader, fetcher: async () => new Response(bytes, { status: 200 }),
  })
  const right = actor.getObjectByName('upperarm.r')
  const before = right.rotation.z
  actor.setPose('attack', .3)
  assert.notEqual(right.rotation.z, before)
  actor.dispose()
})

function aimLoader({ socketName, upperLeft, upperRight, lowerLeft, lowerRight, probePrefix, clips }) {
  return {
    register() {},
    parse(_buffer, _path, onLoad) {
      const scene = new Group()
      scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()))
      const socket = new Group(); socket.name = socketName; scene.add(socket)
      for (const name of [upperLeft, upperRight, lowerLeft, lowerRight, `${probePrefix}-pistol`, `${probePrefix}-melee`, `${probePrefix}-spell`]) {
        const object = new Group(); object.name = name; scene.add(object)
      }
      const animations = clips.map((name) => {
        const probe = name === 'Pistol_Shoot' ? `${probePrefix}-pistol.position[x]` : name === 'Attack' ? `${probePrefix}-melee.position[z]` : `${probePrefix}-spell.position[x]`
        return new AnimationClip(name, 1, name === 'idle' ? [] : [new NumberKeyframeTrack(probe, [0, 1], [0, 1])])
      })
      queueMicrotask(() => onLoad({ scene, animations }))
    },
  }
}

test('Pistol_Shoot не становится bow, Spell_Simple_Shoot остаётся cast, aim fallback работает на двух rig-схемах', async () => {
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const catalog = {
    version: 1,
    models: [{ key: 'aim-ranger', profile: 'rogue', actorIds: [], archetypes: [], url: '/assets/models/aim-ranger.glb', rights: { source: 'test', license: 'original' } }],
  }
  const schemas = [
    { socketName: 'handslot.r', upperLeft: 'upperarm.l', upperRight: 'upperarm.r', lowerLeft: 'lowerarm.l', lowerRight: 'lowerarm.r', probePrefix: 'kaykit', socketParent: 'handslot.r' },
    { socketName: 'hand_r', upperLeft: 'upperarm_l', upperRight: 'upperarm_r', lowerLeft: 'lowerarm_l', lowerRight: 'lowerarm_r', probePrefix: 'quaternius', socketParent: 'hand_r' },
  ]
  for (const schema of schemas) {
    const actor = await models.createActorModel({ id: `pistol-${schema.probePrefix}`, label: 'Следопыт', kind: 'hero', modelKey: 'aim-ranger', appearance: appearance('rogue', 'bow') }, {
      manifest: catalog,
      loader: aimLoader({ ...schema, clips: ['idle', 'Pistol_Shoot', 'Attack'] }),
      fetcher: async () => new Response(bytes, { status: 200 }),
    })
    const upper = actor.getObjectByName(schema.upperRight)
    const pistolProbe = actor.getObjectByName(`${schema.probePrefix}-pistol`)
    const meleeProbe = actor.getObjectByName(`${schema.probePrefix}-melee`)
    const before = upper.rotation.x
    actor.setPose('ranged-attack')
    actor.update(.5)
    assert.notEqual(upper.rotation.x, before, `${schema.probePrefix}: должен примениться aim fallback`)
    assert.equal(pistolProbe.position.x, 0, `${schema.probePrefix}: Pistol_Shoot нельзя выбирать для лука`)
    assert.equal(meleeProbe.position.z, 0, `${schema.probePrefix}: ranged не должен запускать melee`)
    assert.equal(actor.getObjectByName('bow')?.parent?.name, schema.socketParent)
    actor.dispose()

    const spell = await models.createActorModel({ id: `spell-${schema.probePrefix}`, label: 'Следопыт', kind: 'hero', modelKey: 'aim-ranger', appearance: appearance('rogue', 'bow') }, {
      manifest: catalog,
      loader: aimLoader({ ...schema, clips: ['idle', 'Spell_Simple_Shoot', 'Attack'] }),
      fetcher: async () => new Response(bytes, { status: 200 }),
    })
    const spellProbe = spell.getObjectByName(`${schema.probePrefix}-spell`)
    const spellUpper = spell.getObjectByName(schema.upperRight)
    const spellBefore = spellUpper.rotation.x
    spell.setPose('ranged-attack')
    spell.update(.5)
    assert.notEqual(spellUpper.rotation.x, spellBefore, `${schema.probePrefix}: spell shoot тоже должен получить aim fallback`)
    assert.equal(spellProbe.position.x, 0, `${schema.probePrefix}: Spell_Simple_Shoot нельзя считать bow`)
    assert.equal(typeof spell.cast, 'function', `${schema.probePrefix}: Spell_Simple_Shoot должен быть cast`)
    spell.setPose('cast')
    spell.update(.5)
    assert.ok(spellProbe.position.x > 0, `${schema.probePrefix}: cast-клип должен проигрываться отдельно`)
    spell.dispose()
  }
})

test('dispose GLB освобождает boneTexture общего Skeleton ровно один раз', async () => {
  const bone = new Bone(); bone.name = 'root'
  const skeleton = new Skeleton([bone])
  skeleton.computeBoneTexture()
  const boneTexture = skeleton.boneTexture
  let skeletonDisposals = 0
  let textureDisposals = 0
  const originalDispose = skeleton.dispose.bind(skeleton)
  skeleton.dispose = () => { skeletonDisposals += 1; originalDispose() }
  boneTexture.addEventListener('dispose', () => { textureDisposals += 1 })

  const createSkinnedMesh = (name) => {
    const geometry = new BoxGeometry(1, 1, 1)
    const vertices = geometry.getAttribute('position').count
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(vertices * 4), 4))
    const weights = new Float32Array(vertices * 4)
    for (let index = 0; index < vertices; index += 1) weights[index * 4] = 1
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4))
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
    mesh.name = name
    mesh.bind(skeleton)
    return mesh
  }
  const scene = new Group()
  scene.add(createSkinnedMesh('body-a'), createSkinnedMesh('body-b'))
  const loader = {
    register() {},
    parse(_buffer, _path, onLoad) { queueMicrotask(() => onLoad({ scene, animations: [] })) },
  }
  const catalog = {
    version: 1,
    models: [{ key: 'skinned-test', profile: 'warrior', actorIds: [], archetypes: [], url: '/assets/models/skinned-test.glb', rights: { source: 'test', license: 'original' } }],
  }
  const bytes = glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] })
  const actor = await models.createActorModel({ id: 'skinned-test', label: 'Скелет', kind: 'enemy', modelKey: 'skinned-test' }, {
    manifest: catalog, loader, fetcher: async () => new Response(bytes, { status: 200 }),
  })
  assert.equal(actor.source, 'glb')
  actor.dispose()
  actor.dispose()
  assert.equal(skeletonDisposals, 1)
  assert.equal(textureDisposals, 1)
  assert.equal(skeleton.boneTexture, null)
})

test('встроенная фигурка смотрит в +Z, как GLB-модели и поворот на доске', () => {
  const actor = models.createProceduralActorModel({ id: 'facing', label: 'Воин', kind: 'hero', modelKey: 'warrior' }, manifest)
  actor.updateMatrixWorld(true)
  const front = (name) => actor.getObjectByName(name).getWorldPosition(new Vector3()).z
  // Нагрудник и носки сапог — перёд фигурки; корень модели при этом не повёрнут,
  // поэтому слой экипировки по-прежнему считает перёд по +Z.
  assert.ok(front('torso-panel') > 0, 'нагрудник впереди по +Z')
  assert.ok(front('left-boot') > actor.getObjectByName('left-leg').getWorldPosition(new Vector3()).z, 'носок сапога смотрит вперёд')
  assert.equal(actor.rotation.y, 0)
  actor.dispose()
})

// --- KayKit Adventurers 2.0 / Skeletons 1.1 (tools/import-kaykit-models.mjs --v2) ---
const kaykit2Entries = manifest.models.filter((entry) => entry.key.startsWith('kaykit-'))
const kaykit2File = (entry) => join(fileURLToPath(new URL('../public/', import.meta.url)), entry.url.slice(1))
const KAYKIT2_HERO_CLIPS = ['Idle', 'Walk', 'Run', 'Attack_Slash', 'Attack_Chop', 'Attack_Stab', 'Attack_TwoHanded', 'Attack_Unarmed', 'Ranged_Bow', 'Ranged_Crossbow', 'Ranged_Throw', 'Cast', 'Hit', 'Death']

async function withImageStub(run) {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try { return await run() } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
}

const publicFetcher = async (url) => {
  assert.ok(String(url).startsWith('/assets/models/'), String(url))
  return new Response(readFileSync(new URL(`../public${url}`, import.meta.url)), { status: 200 })
}

test('клипы KayKit 2.0 распознаются как позы и варианты по оружию', () => {
  const info = (name) => models.actorClipInfo(name)
  assert.deepEqual(info('Idle'), { pose: 'idle', style: null })
  assert.deepEqual(info('Walk'), { pose: 'walk', style: null })
  assert.deepEqual(info('Run'), { pose: 'walk', style: 'run' })
  assert.deepEqual(info('Attack'), { pose: 'attack', style: null })
  for (const [name, style] of [['Attack_Slash', 'slash'], ['Attack_Chop', 'chop'], ['Attack_Stab', 'stab'], ['Attack_TwoHanded', 'twohanded'], ['Attack_Unarmed', 'unarmed']]) {
    assert.deepEqual(info(name), { pose: 'attack', style }, name)
  }
  for (const [name, style] of [['Ranged_Bow', 'bow'], ['Ranged_Crossbow', 'crossbow'], ['Ranged_Throw', 'throw']]) {
    assert.deepEqual(info(name), { pose: 'ranged-attack', style }, name)
  }
  assert.deepEqual(info('Cast'), { pose: 'cast', style: null })
  assert.deepEqual(info('Hit'), { pose: 'hit', style: null })
  assert.deepEqual(info('Death'), { pose: 'death', style: null })
  assert.deepEqual(info('Spawn'), { pose: 'spawn', style: null })
  // Прежние имена сохраняют разбор: стиль у них не появляется.
  assert.deepEqual(info('SkeletonArmature|Skeleton_Running'), { pose: 'walk', style: null })
  assert.deepEqual(info('Sword_Attack'), { pose: 'attack', style: null })
  assert.deepEqual(info('Spell_Simple_Shoot'), { pose: 'cast', style: null })
  assert.equal(info('Pistol_Shoot'), null)
  assert.equal(info('1H_Crossbow_Shoot'), null, 'арбалетный клип без явного стиля не становится выстрелом из лука')
})

test('KayKit 2.0 GLB самодостаточны, ≤1,5 МБ, совпадают с NOTICE и несут нужные клипы', () => {
  assert.equal(kaykit2Entries.length, 10)
  const firstUrl = kaykit2Entries[0].url
  const releaseDir = join(fileURLToPath(new URL('../public/', import.meta.url)), firstUrl.slice(1, firstUrl.lastIndexOf('/')))
  const notice = JSON.parse(readFileSync(join(releaseDir, 'NOTICE.json'), 'utf8'))
  assert.equal(notice.license, 'CC0-1.0')
  assert.ok(notice.release.id && kaykit2Entries.every((entry) => entry.url.includes(`/${notice.release.id}/`)), 'все записи из одного неизменяемого выпуска')
  for (const name of ['adventurers-LICENSE.txt', 'skeletons-LICENSE.txt', 'animations-LICENSE.txt']) assert.match(readFileSync(join(releaseDir, name), 'utf8'), /Creative Commons Zero, CC0/u, name)
  for (const entry of kaykit2Entries) {
    const bytes = readFileSync(kaykit2File(entry))
    const output = notice.outputs.find((item) => entry.url.endsWith(`/${item.file}`))
    assert.ok(output, `${entry.key}: нет в NOTICE`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256, `${entry.key}: SHA-256 drift`)
    assert.ok(bytes.length <= 1.5 * 1024 * 1024, `${entry.key}: ${bytes.length} байт больше 1,5 МБ`)
    assert.equal(entry.rights.license, 'CC0-1.0')
    assert.equal(entry.outfit, 'builtin')
    assert.equal(Object.hasOwn(entry, 'equipmentUrl'), false, `${entry.key}: v2 должна рисоваться на самой KayKit-фигурке`)
    const report = models.validateGlbContainer(bytes)
    assert.equal(report.hasBinaryChunk, true)
    assert.ok(report.json.images?.length && report.json.images.every((image) => image.bufferView != null && !image.uri), `${entry.key}: текстуры встроены`)
    const names = report.json.animations.map((animation) => animation.name)
    const expected = entry.profile === 'skeleton' ? [...KAYKIT2_HERO_CLIPS, 'Spawn'] : KAYKIT2_HERO_CLIPS
    for (const clip of expected) assert.ok(names.includes(clip), `${entry.key}: нет клипа ${clip}`)
    assert.ok(names.length <= expected.length + 1, `${entry.key}: лишние клипы ${names}`)
    for (const name of names) assert.ok(models.actorClipInfo(name), `${entry.key}: клип ${name} не распознан`)
    assert.equal(report.json.animations.some((animation) => animation.channels.some((channel) => channel.target.path === 'scale')), false, `${entry.key}: единичный масштаб не переносится`)
    for (const animation of report.json.animations) for (const sampler of animation.samplers) {
      const input = report.json.accessors[sampler.input]
      assert.ok(Array.isArray(input.min) && Array.isArray(input.max), `${entry.key}/${animation.name}: input без min/max`)
    }
    const gear = report.json.nodes.filter((node) => node.name.startsWith('KayKitGear_'))
    assert.ok(gear.length >= 1, `${entry.key}: встроенное снаряжение`)
    for (const node of gear) {
      const index = report.json.nodes.indexOf(node)
      const parent = report.json.nodes.find((candidate) => candidate.children?.includes(index))
      assert.match(parent?.name ?? '', /^handslot\.[lr]$/u, `${entry.key}: ${node.name} должен висеть на handslot`)
    }
  }
})

test('KayKit 2.0 фигурки стоят на полу, смотрят в +Z и играют все позы', async () => {
  await withImageStub(async () => {
    for (const entry of kaykit2Entries) {
      const bytes = readFileSync(kaykit2File(entry))
      const actor = await models.createActorModel({ id: entry.key, label: entry.name_ru, kind: entry.profile === 'skeleton' ? 'enemy' : 'hero', modelKey: entry.key }, {
        manifest, fetcher: async () => new Response(bytes, { status: 200 }),
      })
      assert.equal(actor.source, 'glb', `${entry.key}: GLB`)
      assert.equal(actor.modelHeight, entry.height)
      const bones = []
      actor.traverse((object) => { if (object.isBone) bones.push(object) })
      const signature = () => { actor.updateMatrixWorld(true); return JSON.stringify(bones.map((bone) => [bone.position.toArray(), bone.quaternion.toArray()])) }
      actor.idle(0); actor.update(.001)
      // Тело без встроенного оружия: двуручный топор варвара касается пола.
      const bounds = new Box3()
      actor.traverse((object) => { if (object.isSkinnedMesh) bounds.union(new Box3().setFromObject(object)) })
      assert.ok(Math.abs(bounds.min.y) < .02, `${entry.key}: стопы на полу (${bounds.min.y})`)
      const hips = actor.getObjectByName('hips').getWorldPosition(new Vector3())
      const toes = actor.getObjectByName('toesl').getWorldPosition(new Vector3())
      assert.ok(toes.z > hips.z, `${entry.key}: носки смотрят в +Z`)
      // Без внешности видно встроенное оружие, у внешности v2 — скрыто.
      const gear = []
      actor.traverse((object) => { if (object.name.startsWith('KayKitGear_')) gear.push(object) })
      assert.ok(gear.length && gear.every((object) => object.visible), `${entry.key}: встроенный комплект без внешности`)
      const poses = ['idle', 'walk', 'attack', 'rangedAttack', 'cast', 'hit', 'death', ...(entry.profile === 'skeleton' ? ['spawn'] : [])]
      const seen = new Set()
      for (const pose of poses) {
        actor[pose](.5); actor.update(.001)
        seen.add(signature())
      }
      assert.equal(seen.size, poses.length, `${entry.key}: каждая поза должна давать свою позу костей`)
      actor.death(1); actor.update(.001)
      const deathEnd = signature()
      actor.update(.5)
      assert.equal(signature(), deathEnd, `${entry.key}: конец death сохраняется`)
      actor.setAppearance({ version: 2, profile: entry.profile, equipment: 'unarmed', loadout: {} })
      assert.ok(gear.every((object) => !object.visible), `${entry.key}: внешность v2 прячет встроенный комплект`)
      actor.setAppearance(undefined)
      assert.ok(gear.every((object) => object.visible), `${entry.key}: без внешности комплект возвращается`)
      actor.dispose()
      assert.equal(actor.children.length, 0)
    }
  })
})

test('KayKit 2.0 выбирает клип удара и выстрела по снаряжению', async () => {
  await withImageStub(async () => {
    const entry = kaykit2Entries.find((item) => item.key === 'kaykit-barbarian')
    const bytes = readFileSync(kaykit2File(entry))
    const actor = await models.createActorModel({ id: 'style', label: 'Варвар', kind: 'hero', modelKey: entry.key }, { manifest, fetcher: async () => new Response(bytes, { status: 200 }) })
    const bones = []
    actor.traverse((object) => { if (object.isBone) bones.push(object) })
    const poseWith = (appearanceValue, pose, progress = .3) => {
      actor.appearance = appearanceValue
      actor.setPose('idle', 0)
      actor.setPose(pose, progress)
      actor.update(.001)
      actor.updateMatrixWorld(true)
      return JSON.stringify(bones.map((bone) => bone.quaternion.toArray().map((value) => value.toFixed(5))))
    }
    const v2 = (key, equipment = 'unknown') => ({ version: 2, profile: 'warrior', equipment, loadout: key ? { main_hand: { model_key: key } } : {} })
    const legacy = poseWith(undefined, 'attack')
    const greatsword = poseWith(v2('greatsword', 'sword'), 'attack')
    const longsword = poseWith(v2('longsword', 'sword'), 'attack')
    const rapier = poseWith(v2('rapier'), 'attack')
    const mace = poseWith(v2('mace'), 'attack')
    const fists = poseWith(v2(null, 'unarmed'), 'attack')
    assert.equal(legacy, greatsword, 'встроенный двуручный топор варвара = клип двуручного удара')
    assert.equal(new Set([greatsword, longsword, rapier, mace, fists]).size, 5, 'двуручный, рубящий, колющий, дробящий и безоружный различаются')
    const bow = poseWith(v2('longbow', 'bow'), 'ranged-attack', .1)
    const crossbow = poseWith(v2('light-crossbow'), 'ranged-attack', .1)
    const thrown = poseWith(v2('javelin'), 'ranged-attack', .1)
    assert.equal(new Set([bow, crossbow, thrown]).size, 3, 'лук, арбалет и бросок различаются')
    assert.equal(poseWith(undefined, 'ranged-attack', .1), bow, 'без внешности выстрел по умолчанию — лук, не арбалет')
    actor.dispose()
  })
})

test('KayKit 2.0 под внешностью v2 рисует только вещи в руках поверх вылепленного костюма', async () => {
  await withImageStub(async () => {
    const actor = await models.createActorModel({ id: 'outfit', label: 'Рыцарь', kind: 'hero', modelKey: 'kaykit-knight', appearance: {
      version: 2, profile: 'warrior', equipment: 'sword-shield',
      loadout: { main_hand: { model_key: 'longsword' }, off_hand: { model_key: 'shield' }, body: { model_key: 'armor-plate' }, cloak: { model_key: 'cloak' } },
    } }, { manifest, fetcher: publicFetcher })
    await actor.equipmentReady
    assert.equal(actor.equipmentStatus, 'ready', String(actor.equipmentError))
    const mounted = []
    actor.traverse((object) => { if (/^grip\d/u.test(object.name)) mounted.push(...object.children) })
    assert.equal(mounted.length, 2, 'меч и щит в руках')
    let armorParts = 0
    actor.traverse((object) => { if (/armor-plate|cloak/u.test(object.name)) armorParts += 1 })
    assert.equal(armorParts, 0, 'доспех и плащ не надеваются поверх костюма KayKit')
    actor.dispose()
  })
})

test('вариант фигурки внутри серверного профиля: класс героя и имя врага', () => {
  const resolve = (input) => models.resolveModelProfile(input, manifest).key
  const hero = (archetype, profile) => ({ id: `h-${archetype}`, label: 'Борен', kind: 'hero', archetype, appearance: { version: 2, profile, equipment: 'unknown', loadout: {} } })
  const enemy = (label, profile) => ({ id: `e-${label}`, label, kind: 'enemy', appearance: { version: 2, profile, equipment: 'unknown', loadout: {} } })
  // С 2 октября 2026 автоподбор ведёт к героям реалистичных пропорций:
  // воинские классы — основа под надетые вещи, заклинатели — маг, плут и
  // следопыт — следопыт. Пола в данных персонажа нет, поэтому по умолчанию
  // мужской вариант; женский выбирается в меню «Фигурки».
  for (const archetype of ['fighter', 'paladin', 'barbarian', 'monk']) assert.equal(resolve(hero(archetype, 'warrior')), 'hero-male', archetype)
  for (const archetype of ['wizard', 'sorcerer', 'warlock', 'cleric', 'druid', 'bard']) assert.equal(resolve(hero(archetype, 'mage')), 'mage-male', archetype)
  for (const archetype of ['rogue', 'ranger']) assert.equal(resolve(hero(archetype, 'rogue')), 'ranger-male', archetype)
  // Без серверной внешности (старый формат) — по точному классу.
  assert.equal(resolve({ id: 'legacy', label: 'Борен', kind: 'hero', archetype: 'fighter' }), 'hero-male')
  assert.equal(resolve({ id: 'legacy', label: 'Мирра', kind: 'hero', archetype: 'druid' }), 'mage-male')
  // Скелет — Quaternius с человеческими пропорциями, без чиби-вариантов по имени.
  for (const label of ['Скелет', 'Скелет-маг', 'Скелет-лучник', 'Скелет-прислужник']) assert.equal(resolve(enemy(label, 'skeleton')), 'skeleton-quaternius', label)
  assert.equal(resolve(enemy('Гоблин', 'goblin')), 'goblin-quaternius')
  assert.equal(resolve(enemy('Бандит', 'warrior')), 'hero-male', 'обычный гуманоид получает нейтральную основу')
  assert.equal(resolve(enemy('Существо', 'warrior')), 'hero-male', 'замаскированный враг не получает вариант')
  // Класс врага профиль не уточняет: читается только показанное имя.
  assert.equal(resolve({ ...enemy('Существо', 'warrior'), archetype: 'barbarian' }), 'hero-male')
  // Ни один автоматический путь не возвращает записи с auto=false.
  const manual = new Set(manifest.models.filter((entry) => entry.auto === false).map((entry) => entry.key))
  for (const key of manifest.models.map((entry) => entry.key)) if (key.startsWith('kaykit-')) assert.ok(manual.has(key), `${key}: KayKit только ручным выбором`)
  for (const profile of ['warrior', 'mage', 'rogue', 'skeleton', 'goblin', 'beast']) {
    for (const archetype of manifest.models.flatMap((entry) => entry.archetypes ?? [])) {
      assert.equal(manual.has(resolve(hero(archetype, profile))), false, `${profile}/${archetype}`)
      assert.equal(manual.has(resolve({ id: 'x', label: archetype, kind: 'enemy', archetype })), false, `enemy ${archetype}`)
    }
  }
  // Старые и KayKit-ключи, сохранённые в браузере игрока, продолжают открываться.
  for (const key of ['warrior', 'mage', 'rogue', 'skeleton', 'traveler', 'ranger', 'hooded-mage', 'human-female', ...manifest.models.filter((entry) => entry.key.startsWith('kaykit-')).map((entry) => entry.key)]) {
    assert.equal(resolve({ ...hero('fighter', 'warrior'), modelKey: key }), key)
  }
  for (const key of ['hero-female', 'mage-female', 'ranger-female']) assert.equal(resolve({ ...hero('fighter', 'warrior'), modelKey: key }), key)
})

test('поле auto каталога проверяется и не мешает явному выбору', () => {
  const catalog = (auto) => ({ version: 1, models: [
    { key: 'old', profile: 'warrior', archetypes: ['fighter'], auto, rights: { source: 'test', license: 'original' } },
    { key: 'new', profile: 'warrior', archetypes: ['fighter'], rights: { source: 'test', license: 'original' } },
  ] })
  assert.throws(() => models.validateModelManifest(catalog('no')), /auto/u)
  assert.equal(models.validateModelManifest(catalog(false)).models[0].auto, false)
  assert.equal(Object.hasOwn(models.validateModelManifest(catalog(true)).models[0], 'auto'), false)
  assert.equal(models.resolveModelProfile({ id: 'a', label: 'A', kind: 'hero', archetype: 'fighter' }, catalog(false)).key, 'new')
  assert.equal(models.resolveModelProfile({ id: 'a', label: 'A', kind: 'hero', archetype: 'fighter' }, catalog(true)).key, 'old')
  assert.equal(models.resolveModelProfile({ id: 'a', label: 'A', kind: 'hero', modelKey: 'old' }, catalog(false)).key, 'old')
  // Профиль без автоматических записей уходит во встроенную фигурку, а не в ручную.
  const onlyManual = { version: 1, models: [{ key: 'old', profile: 'mage', auto: false, rights: { source: 'test', license: 'original' } }] }
  const resolved = models.resolveModelProfile({ id: 'a', label: 'A', kind: 'hero', appearance: { version: 2, profile: 'mage', equipment: 'unknown', loadout: {} } }, onlyManual)
  assert.equal(resolved.url, null)
  assert.equal(resolved.profile, 'mage')
})

// --- Герои реалистичных пропорций (tools/import-quaternius-actors.mjs --heroes) ---
const HERO_KEYS = ['hero-male', 'hero-female', 'mage-male', 'mage-female', 'ranger-male', 'ranger-female']
const HERO_CLIPS = ['Idle_Loop', 'Walk_Loop', 'Sword_Attack', 'Spell_Simple_Shoot', 'Hit_Chest', 'Death01']
const heroEntries = HERO_KEYS.map((key) => manifest.models.find((entry) => entry.key === key))
const heroFile = (url) => join(fileURLToPath(new URL('../public/', import.meta.url)), url.slice(1))

test('герои Quaternius: один неизменяемый выпуск, ≤3 МиБ, причёски, клипы и NOTICE', () => {
  assert.ok(heroEntries.every(Boolean), 'все шесть героев в каталоге')
  const first = heroEntries[0].url
  const releaseDir = heroFile(first.slice(0, first.lastIndexOf('/')))
  const notice = JSON.parse(readFileSync(join(releaseDir, 'NOTICE.json'), 'utf8'))
  assert.equal(notice.schema, 'skazanie-quaternius-heroes/v1')
  assert.ok(notice.sources.length === 3 && notice.sources.every((source) => source.license === 'CC0-1.0' && source.author === 'Quaternius'))
  assert.match(readFileSync(join(releaseDir, 'LICENSE.txt'), 'utf8'), /CC0-1\.0/u)
  const concat = createHash('sha256').update(Buffer.concat(notice.immutableRelease.files.map((file) => readFileSync(join(releaseDir, file))))).digest('hex')
  assert.equal(concat, notice.immutableRelease.glbConcatSha256)
  assert.ok(first.includes(`/${notice.immutableRelease.id}/`) && notice.immutableRelease.id === `heroes-${concat.slice(0, 20)}`)
  for (const entry of heroEntries) {
    assert.ok(entry.url.includes(`/${notice.immutableRelease.id}/`), `${entry.key}: из того же выпуска`)
    assert.notEqual(entry.auto, false, `${entry.key}: участвует в автоподборе или ручном выборе без флага`)
    assert.equal(entry.rights.license, 'CC0-1.0')
    assert.equal(entry.height, 1.3)
    const bytes = readFileSync(heroFile(entry.url))
    const profile = notice.profiles.find((item) => entry.url.endsWith(`/${item.file}`))
    assert.ok(profile, `${entry.key}: нет в NOTICE`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), profile.sha256, `${entry.key}: SHA-256 drift`)
    assert.ok(bytes.length <= 3 * 1024 * 1024, `${entry.key}: ${bytes.length} байт больше 3 МиБ`)
    if (entry.key.startsWith('hero-')) assert.equal(entry.equipmentUrl, entry.url, `${entry.key}: сама является основой под вещи`)
    else {
      assert.equal(entry.outfit, 'builtin', `${entry.key}: костюм вылеплен`)
      assert.equal(Object.hasOwn(entry, 'equipmentUrl'), false, `${entry.key}: v2 рисуется на самой фигуре`)
    }
    const report = models.validateGlbContainer(bytes)
    const { json } = report
    assert.deepEqual(json.animations.map((animation) => animation.name), HERO_CLIPS)
    for (const name of HERO_CLIPS) assert.ok(models.actorClipInfo(name), `${entry.key}: клип ${name} не распознан`)
    for (const animation of json.animations) for (const sampler of animation.samplers) {
      const input = json.accessors[sampler.input]
      assert.ok(Array.isArray(input.min) && Array.isArray(input.max), `${entry.key}/${animation.name}: input без min/max`)
    }
    assert.ok(json.images.every((image) => image.bufferView != null && !image.uri), `${entry.key}: текстуры встроены`)
    assert.deepEqual(json.extensionsRequired ?? [], ['KHR_mesh_quantization'])
    const meshNames = json.nodes.filter((node) => Number.isInteger(node.mesh)).map((node) => node.name)
    for (const name of ['Head_Face', 'Head_Eyes', 'Head_Eyebrows']) assert.ok(meshNames.includes(name), `${entry.key}: ${name}`)
    assert.deepEqual(meshNames.filter((name) => name.startsWith('Hair_')), profile.hair, `${entry.key}: причёска как в NOTICE`)
    // Текстуры волос в наборе серые — без оттенка брови и волосы белые.
    const hairMaterials = json.materials.filter((material) => /^MI_Hair_\d+$/u.test(material.name))
    assert.ok(hairMaterials.length >= 1)
    for (const material of hairMaterials) assert.ok(material.pbrMetallicRoughness.baseColorFactor.slice(0, 3).every((value) => value < .8), `${entry.key}: ${material.name} без оттенка`)
    assert.ok(json.meshes.every((mesh) => mesh.primitives.every((primitive) => !Object.keys(primitive.attributes).some((name) => /^COLOR_|^TEXCOORD_[1-9]/u.test(name)))), `${entry.key}: лишние атрибуты`)
    for (const bone of ['root', 'Head', 'hand_l', 'hand_r']) assert.ok(json.nodes.some((node) => node.name === bone), `${entry.key}: кость ${bone}`)
  }
  assert.ok(heroEntries.filter((entry) => entry.key.endsWith('-female')).every((entry) => !(entry.archetypes ?? []).length), 'женские варианты — только ручной выбор')
})

test('герои Quaternius стоят на полу, смотрят в +Z, держат сокеты и играют все позы', async () => {
  await withImageStub(async () => {
    for (const entry of heroEntries) {
      const bytes = readFileSync(heroFile(entry.url))
      const actor = await models.createActorModel({ id: entry.key, label: entry.name_ru, kind: 'hero', modelKey: entry.key }, {
        manifest, fetcher: async () => new Response(bytes, { status: 200 }),
      })
      assert.equal(actor.source, 'glb', `${entry.key}: GLB`)
      assert.equal(actor.modelHeight, entry.height)
      const bones = []
      actor.traverse((object) => { if (object.isBone) bones.push(object) })
      assert.equal(bones.length, 65, `${entry.key}: 65 костей`)
      const signature = () => { actor.updateMatrixWorld(true); return JSON.stringify(bones.map((bone) => [bone.position.toArray(), bone.quaternion.toArray()])) }
      actor.idle(0); actor.update(.001)
      const bounds = new Box3()
      actor.traverse((object) => { if (object.isSkinnedMesh) bounds.union(new Box3().setFromObject(object)) })
      assert.ok(Math.abs(bounds.min.y) < .03, `${entry.key}: стопы на полу (${bounds.min.y})`)
      assert.ok(bounds.max.y > entry.height * .9 && bounds.max.y < entry.height * 1.08, `${entry.key}: рост ${bounds.max.y}`)
      const pelvis = actor.getObjectByName('pelvis').getWorldPosition(new Vector3())
      const toes = actor.getObjectByName('ball_l').getWorldPosition(new Vector3())
      assert.ok(toes.z > pelvis.z, `${entry.key}: носки смотрят в +Z`)
      assert.ok(actor.getObjectByName('hand_l') && actor.getObjectByName('hand_r'), `${entry.key}: сокеты рук`)
      const seen = new Set()
      for (const pose of ['idle', 'walk', 'attack', 'cast', 'hit', 'death']) {
        actor[pose](.5); actor.update(.001)
        seen.add(signature())
      }
      assert.equal(seen.size, 6, `${entry.key}: каждая поза даёт свою позу костей`)
      actor.dispose()
      assert.equal(actor.children.length, 0)
    }
  })
})
