import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createTacticalMap, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(repositoryRoot, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(repositoryRoot, 'tmp', 'board3d-spell-effects-'))
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(repositoryRoot, 'server', 'circular-area-geometry.mjs'), join(buildDir, 'server', 'circular-area-geometry.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'actor-footprint.mjs'), join(buildDir, 'server', 'actor-footprint.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'equipment-visuals.mjs'), join(buildDir, 'server', 'equipment-visuals.mjs'))
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [
  join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop',
  '--rootDir', repositoryRoot, '--outDir', buildDir, join(repositoryRoot, 'src/board3d-spell-effects.ts'),
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
function emittedFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? emittedFiles(path) : [path]
  })
}
for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const rewritten = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.\.?\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, rewritten)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const { createSpellEffect3D } = await import(pathToFileURL(join(buildDir, 'src/board3d-spell-effects.mjs')).href)
function map(hidden = []) {
  const value = createTacticalMap({ width: 12, height: 12, locationId: 'spell-effects-test', fill: { passable: true, revealed: true, material: 'stone' } })
  hidden.forEach(({ x, y }) => setCell(value, x, y, { revealed: false }))
  return JSON.parse(JSON.stringify(serializeTacticalMap(value)))
}
const actors = [{ id: 'mage', x: 1, y: 6 }, { id: 'target', x: 6, y: 6 }]

test('Скороход, Прыжок и Ускорение имеют разные движущиеся объекты в 3D', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const signatures = []
  for (const spellId of ['longstrider', 'jump', 'haste']) {
    const effect = createSpellEffect3D({ id: spellId, kind: 'channel', actorId: 'mage', targetId: 'mage', targetIds: ['mage'],
      spellId, school: 'transmutation', channelType: 'cast', durationMs: 500 }, actors, board)
    assert.ok(effect)
    const geometryAt = (progress) => {
      effect.update(progress)
      const objects = []
      effect.group.traverse((object) => {
        if (!object.geometry) return
        objects.push({ type: object.geometry.type, visible: object.visible, position: object.position.toArray(),
          vertices: [...(object.geometry.getAttribute('position')?.array ?? [])] })
      })
      return JSON.stringify(objects)
    }
    const early = geometryAt(.2)
    const late = geometryAt(.7)
    assert.notEqual(early, late, `${spellId}: эффект должен двигаться`)
    signatures.push(late)
    effect.dispose()
  }
  assert.equal(new Set(signatures).size, 3)
})

test('generic mobility spell сохраняет короткую дугу и обычную анимацию', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const { spellVisualProfile } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
  assert.equal(spellVisualProfile('spider-climb').family, 'mobility')
  assert.equal(spellVisualProfile('spider-climb').visualVariant, undefined)
  const board = decodeTacticalMap(map())
  const effect = createSpellEffect3D({ id: 'spider-climb', kind: 'channel', actorId: 'mage', targetId: 'target', targetIds: ['target'],
    spellId: 'spider-climb', school: 'transmutation', channelType: 'cast', durationMs: 500, motion: 'reduced' }, actors, board)
  assert.ok(effect)
  const snapshot = (progress) => {
    effect.update(progress)
    const objects = []
    effect.group.traverse((object) => {
      if (!object.geometry) return
      objects.push({ type: object.geometry.type, position: object.position.toArray(), vertices: [...(object.geometry.getAttribute('position')?.array ?? [])] })
    })
    return objects
  }
  const early = snapshot(.2)
  const late = snapshot(.7)
  assert.notDeepEqual(early, late, 'generic mobility не должен замерзать вместе с тремя специальными вариантами')
  const ring = effect.group.children.find((child) => child.geometry?.type === 'TorusGeometry')
  assert.equal(ring?.geometry.parameters.radius, .38, 'generic mobility сохраняет старый компактный контур')
  const spans = late.filter((entry) => entry.type === 'BufferGeometry').map((entry) => {
    const xs = []
    for (let index = 0; index < entry.vertices.length; index += 3) xs.push(entry.vertices[index])
    return Math.max(...xs) - Math.min(...xs)
  })
  assert.ok(spans.some((span) => span > .8 && span < 1.1), 'generic mobility сохраняет короткую дугу')
  effect.dispose()
})

test('мобильность в 3D получает контрастный контур, выносится от фигуры и уважает reduced motion', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  for (const spellId of ['longstrider', 'jump', 'haste']) {
    const cue = { id: `mobility-${spellId}`, kind: 'channel', actorId: 'mage', targetId: 'mage', targetIds: ['mage'],
      spellId, school: 'transmutation', channelType: 'cast', durationMs: 500 }
    const effect = createSpellEffect3D(cue, actors, board)
    assert.ok(effect)
    effect.update(.62)
    const mobilityObjects = []
    effect.group.traverse((object) => {
      if (!object.geometry) return
      const parameters = object.geometry.parameters ?? {}
      mobilityObjects.push({ object, type: object.geometry.type, parameters, position: object.position.toArray(),
        vertices: [...(object.geometry.getAttribute('position')?.array ?? [])] })
    })
    const lineObjects = mobilityObjects.filter((entry) => entry.type === 'BufferGeometry' && entry.vertices.length >= 9)
    const span = lineObjects.reduce((maximum, entry) => {
      const xs = []
      for (let index = 0; index < entry.vertices.length; index += 3) xs.push(entry.vertices[index])
      return Math.max(maximum, Math.max(...xs) - Math.min(...xs))
    }, 0)
    assert.ok(span >= 1 || spellId === 'longstrider', `${spellId}: след должен быть видим на обычной камере`)
    if (spellId === 'longstrider') {
      assert.ok(mobilityObjects.some((entry) => entry.type === 'TorusGeometry' && entry.parameters.radius >= .2 && entry.parameters.tube >= .04),
        'Скороход должен иметь крупные толстые следы')
      const marks = mobilityObjects.filter((entry) => entry.type === 'TorusGeometry' && entry.parameters.radius >= .2)
      assert.ok(marks.some((entry) => Math.hypot(entry.position[0] - 1.5, entry.position[2] - 6.5) > .5), 'след не должен сидеть на центре фигуры')
    }
    effect.dispose()

    const reduced = createSpellEffect3D({ ...cue, id: `${cue.id}-reduced`, motion: 'reduced' }, actors, board)
    assert.ok(reduced)
    const signature = (progress) => {
      reduced.update(progress)
      const objects = []
      reduced.group.traverse((object) => {
        if (!object.geometry) return
        objects.push({ visible: object.visible, position: object.position.toArray(), vertices: [...(object.geometry.getAttribute('position')?.array ?? [])] })
      })
      return JSON.stringify(objects)
    }
    assert.equal(signature(.1), signature(.9), `${spellId}: reduced motion должен оставаться статичным`)
    reduced.dispose()
  }
})

test('Скороход рисует один подтверждённый cue у всех видимых целей, не подменяет скрытую цель заклинателем', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const cue = { id: 'longstrider-cast', kind: 'channel', actorId: 'mage', targetId: 'mage', targetIds: ['mage', 'target', 'missing'], spellId: 'longstrider', school: 'transmutation', channelType: 'cast', durationMs: 400 }
  const visible = createSpellEffect3D(cue, actors, decodeTacticalMap(map()))
  assert.ok(visible)
  assert.equal(visible.group.children.length, 2)
  visible.update(.6)
  assert.ok(visible.group.children.every((effect) => effect.visible))
  visible.dispose()
  const hidden = createSpellEffect3D(cue, actors, decodeTacticalMap(map([{ x: 6, y: 6 }])))
  assert.ok(hidden)
  assert.equal(hidden.group.children.length, 1)
  hidden.dispose()
  const neutral = createSpellEffect3D({ ...cue, targetIds: ['npc'] }, [{ id: 'npc', x: 2, y: 2, kind: 'neutral' }], decodeTacticalMap(map()))
  assert.equal(neutral.group.children.length, 1)
  neutral.dispose()
  assert.equal(createSpellEffect3D({ ...cue, targetIds: [] }, actors, decodeTacticalMap(map())), null)
})

test('3D spell cue рисует fireball/beam/healing и освобождает ресурсы', async () => {
  const board = (await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)).decodeTacticalMap(map())
  const fireball = createSpellEffect3D({
    id: 'fireball', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
    center: { x: 6, y: 6 }, shape: 'sphere', sizeFeet: 20, durationMs: 480, detail: 'reduced',
  }, actors, board)
  assert.ok(fireball)
  fireball.update(.2)
  assert.ok(fireball.group.children.some((child) => child.visible), 'огненный шар должен быть видим в полёте')
  fireball.update(.8)
  assert.ok(fireball.group.children.some((child) => child.visible), 'взрыв должен быть видим после прилёта')
  assert.ok(fireball.group.children[3].scale.x > 2, 'fireball ground contour должен соответствовать 20-футовой footprint')
  const resources = new Set(fireball.group.children.flatMap((child) => [child.geometry, child.material]).filter(Boolean))
  let disposed = 0
  resources.forEach((resource) => resource.addEventListener('dispose', () => disposed++))
  fireball.dispose()
  assert.equal(disposed, resources.size)

  const beam = createSpellEffect3D({
    id: 'lightning', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'chain-lightning', school: 'evocation',
    chain: false, durationMs: 560, detail: 'minimal',
  }, actors, board)
  assert.ok(beam)
  beam.update(.8)
  assert.ok(beam.group.children.some((child) => child.visible))
  beam.dispose()

  const healing = createSpellEffect3D({
    id: 'healing', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'healing-word', school: 'evocation',
    channelType: 'healing', durationMs: 480, detail: 'minimal',
  }, actors, board)
  assert.ok(healing)
  healing.update(.5)
  assert.ok(healing.group.children.some((child) => child.visible))
  healing.dispose()
})

test('3D-круговой взрыв использует серверный gridOrigin при отличающемся центре выбора', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const fireball = createSpellEffect3D({
    id: 'fireball-grid-origin', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
    center: { x: 6, y: 6 }, gridOrigin: { x: 8, y: 4 }, geometryVersion: 'circle-grid-v2',
    shape: 'sphere', sizeFeet: 20, durationMs: 1000, detail: 'reduced',
  }, actors, board)
  assert.ok(fireball)
  fireball.update(.8)
  const ring = fireball.group.children[3]
  assert.equal(ring.position.x, 8)
  assert.equal(ring.position.z, 4)
  fireball.dispose()
})

test('3D Шипы града рисуют подтверждённый взрыв вокруг цели попадания', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const burst = createSpellEffect3D({
    id: 'hail-of-thorns-burst', kind: 'burst', actorId: 'ranger', targetIds: ['target-a', 'target-b'],
    spellId: 'hail-of-thorns', school: 'conjuration', shape: 'sphere', originMode: 'point', sizeFeet: 5, durationMs: 480,
  }, [{ id: 'ranger', x: 1, y: 6 }, { id: 'target-a', x: 6, y: 6 }, { id: 'target-b', x: 6, y: 7 }], board)
  assert.ok(burst)
  burst.update(.65)
  assert.ok(burst.group.children.some((child) => child.visible), 'подтверждённая область должна иметь 3D-рисунок')
  burst.dispose()
})

test('3D target-local варианты сохраняют смысловую геометрию вокруг цели', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const targetActors = [{ id: 'mage', x: 1, y: 6 }, { id: 'target', x: 6, y: 6 }]
  for (const spellId of ['sacred-flame', 'toll-the-dead', 'mind-sliver', 'infestation']) {
    const effect = createSpellEffect3D({
      id: `target-local-${spellId}`, kind: 'channel', actorId: 'mage', targetId: 'target', spellId,
      school: 'evocation', channelType: 'cast', durationMs: 480,
    }, targetActors, board)
    assert.ok(effect, `${spellId}: target-local effect`)
    effect.update(.55)
    assert.ok(effect.group.children.some((child) => child.visible), `${spellId}: visible target-local geometry`)
    effect.dispose()
  }
})

test('3D Психический кнут использует изогнутые mesh-сегменты и освобождает reduced-ресурсы', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const actors = [{ id: 'mage', x: 1, y: 6 }, { id: 'target', x: 6, y: 6 }]
  const full = createSpellEffect3D({
    id: 'psychic-whip-full', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'tasha-s-mind-whip',
    school: 'enchantment', chain: false, durationMs: 560, detail: 'full',
  }, actors, board)
  assert.ok(full)
  const pieces = full.group.children.filter((child) => child.geometry?.type === 'CylinderGeometry')
  assert.equal(pieces.length, 8)
  full.update(1)
  assert.ok(pieces.every((piece) => piece.visible), 'все сегменты кнута должны дойти до цели')
  assert.ok(pieces[Math.floor(pieces.length / 2)].position.y > pieces[0].position.y + .1, 'середина кнута должна подниматься над прямой')
  full.dispose()

  const reduced = createSpellEffect3D({
    id: 'psychic-whip-reduced', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'tasha-s-mind-whip',
    school: 'enchantment', chain: false, durationMs: 560, detail: 'reduced', motion: 'reduced',
  }, actors, board)
  assert.ok(reduced)
  const reducedPieces = reduced.group.children.filter((child) => child.geometry?.type === 'CylinderGeometry')
  assert.equal(reducedPieces.length, 6)
  const resources = new Set(reduced.group.children.flatMap((child) => [child.geometry, child.material]).filter(Boolean))
  let disposed = 0
  resources.forEach((resource) => resource.addEventListener('dispose', () => { disposed += 1 }))
  reduced.dispose()
  assert.equal(disposed, resources.size)
})

test('3D chain lightning branches each secondary from the primary endpoint', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const chainActors = [
    { id: 'mage', x: 1, y: 1 },
    { id: 'primary', x: 4, y: 1 },
    { id: 'secondary-a', x: 2, y: 4 },
    { id: 'secondary-b', x: 6, y: 4 },
  ]
  const chain = createSpellEffect3D({
    id: 'chain-branch', kind: 'beam', actorId: 'mage', targetIds: ['primary', 'secondary-a', 'secondary-b'],
    spellId: 'chain-lightning', school: 'evocation', chain: true, durationMs: 560, detail: 'minimal',
  }, chainActors, board)
  assert.ok(chain)
  chain.update(1)
  const lineEndpoints = chain.group.children.filter((child) => child.isLine).map((line) => {
    const positions = line.geometry.getAttribute('position')
    return [[positions.getX(0), positions.getZ(0)], [positions.getX(2), positions.getZ(2)]]
  })
  assert.deepEqual(lineEndpoints, [
    [[1.5, 1.5], [4.5, 1.5]],
    [[4.5, 1.5], [2.5, 4.5]],
    [[4.5, 1.5], [6.5, 4.5]],
  ])
  chain.dispose()

  const generic = createSpellEffect3D({
    id: 'generic-beam', kind: 'beam', actorId: 'mage', targetIds: ['primary', 'secondary-a', 'secondary-b'],
    spellId: 'eldritch-blast', school: 'evocation', chain: true, durationMs: 560, detail: 'minimal',
  }, chainActors, board)
  assert.ok(generic)
  generic.update(1)
  const genericLines = generic.group.children.filter((child) => child.isLine)
  const genericPositions = genericLines.map((line) => line.geometry.getAttribute('position'))
  assert.deepEqual(genericPositions.map((positions) => [[positions.getX(0), positions.getZ(0)], [positions.getX(2), positions.getZ(2)]]), [
    [[1.5, 1.5], [4.5, 1.5]],
    [[4.5, 1.5], [2.5, 4.5]],
    [[2.5, 4.5], [6.5, 4.5]],
  ])
  generic.dispose()
})

test('3D chain lightning keeps a missing primary as a gap instead of connecting a secondary through it', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const missingPrimary = createSpellEffect3D({
    id: 'chain-missing-primary', kind: 'beam', actorId: 'mage', targetIds: ['primary', 'secondary-a'],
    spellId: 'chain-lightning', school: 'evocation', chain: true, durationMs: 560, detail: 'minimal',
  }, [{ id: 'mage', x: 1, y: 1 }, { id: 'secondary-a', x: 2, y: 4 }], board)
  assert.equal(missingPrimary, null)
})
test('3D spell cue не пересекает туман траекторией или объёмным blast', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const hiddenPath = decodeTacticalMap(map([{ x: 3, y: 6 }]))
  const hiddenFlight = createSpellEffect3D({
    id: 'hidden-flight', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
    center: { x: 6, y: 6 }, shape: 'sphere', sizeFeet: 5, durationMs: 480,
  }, actors, hiddenPath)
  assert.equal(hiddenFlight, null, 'fogged trajectory: 3D geometry must stay absent and canvas remains clipped')

  const hiddenBlast = decodeTacticalMap(map([{ x: 5, y: 5 }]))
  const fireball = createSpellEffect3D({
    id: 'hidden-blast', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
    center: { x: 6, y: 6 }, cells: [{ x: 6, y: 6 }, { x: 5, y: 5 }], shape: 'sphere', sizeFeet: 20, durationMs: 480,
  }, actors, hiddenBlast)
  assert.ok(fireball)
  fireball.update(.85)
  assert.equal(fireball.group.children[2].visible, false, 'hidden blast footprint: no volumetric explosion may leak through fog')
  assert.ok(fireball.group.children.some((child) => child.visible), 'visible footprint cells may keep a clipped contour')
  fireball.dispose()
})

test('объёмная молния продолжается за выбранную клетку направления до края области', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const bolt = createSpellEffect3D({
    id: 'long-bolt', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
    origin: { x: 1, y: 6 }, center: { x: 2, y: 6 }, shape: 'line', originMode: 'self', sizeFeet: 40, durationMs: 480,
  }, actors, decodeTacticalMap(map()))
  assert.ok(bolt)
  bolt.update(1)
  const line = bolt.group.children.find((child) => child.isLine)
  assert.equal(line.geometry.getAttribute('position').getX(2), 9.5)
  bolt.dispose()
})

test('области сохраняют shape и не отказывают на открытом краю карты', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const full = decodeTacticalMap(map())
  for (const shape of ['sphere', 'cylinder', 'cone', 'cube']) {
    const effect = createSpellEffect3D({
      id: `shape-${shape}`, kind: 'burst', actorId: 'mage', targetIds: [], spellId: shape === 'cone' ? 'burning-hands' : 'acid-splash', school: 'evocation',
      center: { x: 6, y: 6 }, shape, origin: { x: 1, y: 6 }, originMode: 'point', sizeFeet: 10, durationMs: 480, detail: 'reduced',
    }, actors, full)
    assert.ok(effect, shape)
    effect.update(.55)
    assert.ok(effect.group.children.some((child) => child.visible), shape)
    effect.dispose()
  }

  const edgeValue = createTacticalMap({ width: 10, height: 6, locationId: 'edge-effects', fill: { passable: true, revealed: true, material: 'stone' } })
  const edge = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(edgeValue))))
  const edgeFireball = createSpellEffect3D({
    id: 'edge-fireball', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
    center: { x: 8, y: 2 }, shape: 'sphere', sizeFeet: 20, durationMs: 480, detail: 'reduced',
  }, [{ id: 'mage', x: 1, y: 2 }], edge)
  assert.ok(edgeFireball)
  const contourFrames = []
  for (const phase of [.65, .8, .95]) {
    edgeFireball.update(phase)
    const contour = edgeFireball.group.children.find((child) => child.type === 'LineSegments')
    assert.ok(contour?.visible, `контур должен быть видим на фазе ${phase}`)
    const positions = contour.geometry.getAttribute('position')
    const xs = Array.from({ length: positions.count }, (_, index) => positions.getX(index))
    assert.ok(Math.min(...xs) >= -0.001 && Math.max(...xs) <= 10.001, `контур не должен уехать за world bounds на фазе ${phase}`)
    contourFrames.push([positions.getX(0), positions.getZ(0)])
  }
  assert.deepEqual(contourFrames[0], contourFrames[1], 'контур должен расти drawRange-ом, а не сдвигаться world transform')
  assert.ok(edgeFireball.group.children.some((child) => child.visible), 'открытая граница карты не должна гасить взрыв')
  edgeFireball.dispose()
})

test('projectile, aura и channel-семейства получают bounded 3D акцент', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const cues = [
    { id: 'magic-missile', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'magic-missile', school: 'evocation', from: { x: 1, y: 6 }, to: { x: 6, y: 6 }, projectileCount: 3, durationMs: 520, detail: 'full' },
    { id: 'aura', kind: 'aura', actorId: 'mage', spellId: 'aura-of-life', school: 'abjuration', radiusFeet: 30, auraType: 'spell', active: true, durationMs: 440, detail: 'reduced' },
    { id: 'summon', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'summon-beast', school: 'conjuration', channelType: 'summon', durationMs: 480, detail: 'minimal' },
    { id: 'teleport', kind: 'channel', actorId: 'mage', position: { x: 6, y: 6 }, spellId: 'misty-step', school: 'conjuration', channelType: 'cast', durationMs: 480, detail: 'reduced' },
    { id: 'shield', kind: 'channel', actorId: 'mage', targetId: 'mage', spellId: 'shield', school: 'abjuration', channelType: 'cast', durationMs: 480, detail: 'minimal' },
    { id: 'control', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'hold-person', school: 'enchantment', channelType: 'cast', durationMs: 480, detail: 'minimal' },
  ]
  for (const cue of cues) {
    const effect = createSpellEffect3D(cue, actors, board)
    assert.ok(effect, cue.id)
    effect.update(.5)
    assert.ok(effect.group.children.some((child) => child.visible), cue.id)
    effect.dispose()
  }
})

test('линия не пересекает стену, а крупный заклинатель получает area cue', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const blockedValue = createTacticalMap({ width: 12, height: 12, locationId: 'line-wall', fill: { passable: true, revealed: true, material: 'stone' } })
  setEdge(blockedValue, 3, 6, 4, 6, { kind: 'wall', blocksMove: true, blocksSight: true })
  const blocked = decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(blockedValue))))
  const throughWall = createSpellEffect3D({
    id: 'wall-line', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
    origin: { x: 1, y: 6 }, center: { x: 8, y: 6 }, shape: 'line', originMode: 'self', sizeFeet: 40, durationMs: 480,
  }, actors, blocked)
  assert.ok(throughWall, 'видимая часть луча до стены остаётся в 3D')
  throughWall.update(1)
  const wallLine = throughWall.group.children.find((child) => child.isLine)
  assert.equal(wallLine.geometry.getAttribute('position').getX(2), 3.5, 'линия обрывается перед blocksSight edge и не проходит сквозь него')
  throughWall.dispose()

  const confirmedThroughWall = createSpellEffect3D({
    id: 'confirmed-wall-line', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
    origin: { x: 1, y: 6 }, center: { x: 8, y: 6 }, cells: [{ x: 2, y: 6 }, { x: 3, y: 6 }], shape: 'line', originMode: 'self', sizeFeet: 40, durationMs: 480,
  }, actors, blocked)
  assert.ok(confirmedThroughWall, 'подтверждённые cells не должны повторно пересчитывать LoE после изменения projection')
  confirmedThroughWall.update(.8)
  assert.ok(confirmedThroughWall.group.children.some((child) => child.visible), 'подтверждённый сегмент должен остаться видимым')
  confirmedThroughWall.dispose()

  const fogValue = createTacticalMap({ width: 12, height: 12, locationId: 'line-fog', fill: { passable: true, revealed: true, material: 'stone' } })
  setCell(fogValue, 3, 6, { revealed: false })
  const foggedConfirmed = createSpellEffect3D({
    id: 'confirmed-fog-line', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
    origin: { x: 1, y: 6 }, center: { x: 8, y: 6 }, cells: [{ x: 2, y: 6 }, { x: 3, y: 6 }], shape: 'line', originMode: 'self', sizeFeet: 40, durationMs: 480,
  }, actors, decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(fogValue)))))
  assert.ok(foggedConfirmed, 'fog не должен удалять весь подтверждённый cue')
  foggedConfirmed.update(.8)
  foggedConfirmed.dispose()

  const missingTarget = createSpellEffect3D({
    id: 'missing-projectile-target', kind: 'projectile', actorId: 'mage', targetIds: [], spellId: 'magic-missile', school: 'evocation',
    from: { x: 1, y: 6 }, projectileCount: 1, durationMs: 520, detail: 'minimal',
  }, actors, blocked)
  assert.equal(missingTarget, null, 'missing target endpoint: no guessed projectile geometry')

  const largeActors = [{ id: 'ogre', x: 1, y: 5, footprint: { version: 1, size: 2 } }, { id: 'target', x: 6, y: 6 }]
  const large = createSpellEffect3D({
    id: 'large-caster-area', kind: 'burst', actorId: 'ogre', targetIds: ['target'], spellId: 'burning-hands', school: 'evocation',
    center: { x: 5, y: 6 }, shape: 'cone', originMode: 'self', sizeFeet: 15, durationMs: 480, detail: 'reduced',
  }, largeActors, decodeTacticalMap(map()))
  assert.ok(large)
  large.update(.55)
  assert.ok(large.group.children.some((child) => child.visible), 'крупный caster не должен обрушить area cue')
  large.dispose()
})

test('3D использует все shared semantic families из общей palette', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const { spellEffectPalette } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
  const board = decodeTacticalMap(map())
  const burstFamilies = new Set(['fire', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'earth', 'wind', 'water', 'swarm', 'weapon'])
  assert.equal(spellEffectPalette('thunder-step', { school: 'conjuration', visualFamily: 'thunder' }).family, 'thunder')
  const cards = [
    ['fireball', 'fire'], ['ice-storm', 'cold'], ['chain-lightning', 'lightning'], ['thunderwave', 'thunder'],
    ['acid-splash', 'acid'], ['poison-spray', 'poison'], ['toll-the-dead', 'necrotic'], ['guiding-bolt', 'radiant'],
    ['magic-missile', 'force'], ['dissonant-whispers', 'psychic'], ['healing-word', 'healing'], ['shield', 'protection'],
    ['hold-person', 'control'], ['misty-step', 'teleport'], ['summon-beast', 'summon'], ['erupting-earth', 'earth'],
    ['gust-of-wind', 'wind'], ['maelstrom', 'water'], ['insect-plague', 'swarm'], ['cloud-of-daggers', 'weapon'], ['knock', 'thunder'],
    ['unknown-arcane-spell', 'school'],
    ['minor-illusion', 'illusion'], ['detect-magic', 'divination'], ['light', 'light'], ['darkness', 'darkness'],
    ['mold-earth', 'environment'], ['lesser-restoration', 'restoration'], ['invisibility', 'invisibility'], ['fly', 'flight'],
    ['jump', 'mobility'], ['polymorph', 'transmutation'], ['message', 'communication'], ['charm-person', 'enchantment'], ['mage-hand', 'utility'],
  ]
  for (const [spellId, family] of cards) {
    assert.equal(spellEffectPalette(spellId, { school: 'evocation' }).family, family, spellId)
    const cue = burstFamilies.has(family)
      ? {
        id: `family-${spellId}`, kind: 'burst', actorId: 'mage', targetIds: ['target'], spellId, school: 'evocation',
        center: { x: 6, y: 6 }, shape: 'sphere', originMode: 'point', sizeFeet: 10, durationMs: 480, detail: 'minimal',
      }
      : {
        id: `family-${spellId}`, kind: 'channel', actorId: 'mage', targetId: 'target', spellId, school: 'evocation',
        channelType: 'cast', durationMs: 480, detail: 'minimal',
      }
    const effect = createSpellEffect3D(cue, actors, board)
    assert.ok(effect, spellId)
    effect.update(.5)
    assert.ok(effect.group.children.some((child) => child.visible), spellId)
    effect.dispose()
  }
})

test('visualVariant даёт собственную 3D-форму, фазы и cleanup', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const { spellEffectPalette } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
  const board = decodeTacticalMap(map())
  const variants = [
    ['mage-hand', 'spectral-hand'], ['prestidigitation', 'minor-tricks'], ['borrowed-knowledge', 'borrowed-knowledge'],
    ['leomund-s-secret-chest', 'secret-chest'], ['creating-spelljamming-helm', 'spelljamming-helm'], ['silence', 'silence'],
    ['counterspell', 'cancellation'], ['dispel-magic', 'cancellation'], ['magic-jar', 'soul-transfer'],
  ]
  for (const [spellId, visualVariant] of variants) {
    assert.equal(spellEffectPalette(spellId, { school: 'conjuration' }).visualVariant, visualVariant, spellId)
    const effect = createSpellEffect3D({
      id: `variant-${spellId}`, kind: 'channel', actorId: 'mage', targetId: 'target', position: { x: 6, y: 6 }, spellId, school: 'conjuration',
      channelType: 'cast', durationMs: 480, detail: 'full',
    }, actors, board)
    assert.ok(effect, spellId)
    let sawVisible = false
    for (const phase of [.12, .5, .86]) {
      effect.update(phase)
      sawVisible ||= effect.group.children.some((child) => child.visible)
    }
    assert.ok(sawVisible, `${spellId}: visualVariant has no visible phase`)
    const resources = new Set(effect.group.children.flatMap((child) => [child.geometry, child.material]).filter(Boolean))
    let disposed = 0
    resources.forEach((resource) => resource.addEventListener('dispose', () => disposed++))
    effect.dispose()
    assert.equal(disposed, resources.size, `${spellId}: variant resources not disposed`)
  }
  const cancellation = createSpellEffect3D({
    id: 'counterspell-dome-recheck', kind: 'channel', actorId: 'mage', targetId: 'target', position: { x: 6, y: 6 }, spellId: 'counterspell', school: 'abjuration',
    channelType: 'cast', durationMs: 480, detail: 'full',
  }, actors, board)
  const protection = createSpellEffect3D({
    id: 'shield-dome-recheck', kind: 'channel', actorId: 'mage', targetId: 'target', position: { x: 6, y: 6 }, spellId: 'shield', school: 'abjuration',
    channelType: 'cast', durationMs: 480, detail: 'full',
  }, actors, board)
  assert.ok(cancellation && protection)
  cancellation.update(.5); protection.update(.5)
  assert.equal(cancellation.group.children.some((child) => child.geometry?.type === 'SphereGeometry'), false, 'cancellation must not retain shield dome')
  assert.equal(protection.group.children.some((child) => child.geometry?.type === 'SphereGeometry'), true, 'ordinary protection keeps its dome')
  cancellation.dispose(); protection.dispose()
})

test('3D teleport channel меняет portal с departure на arrival без travel line', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const effect = createSpellEffect3D({
    id: 'teleport-authoritative', kind: 'channel', actorId: 'mage', from: { x: 1, y: 6 }, position: { x: 6, y: 6 },
    spellId: 'misty-step', school: 'conjuration', channelType: 'teleport', durationMs: 480, detail: 'reduced',
  }, actors, board)
  assert.ok(effect)
  effect.update(.2)
  assert.ok(effect.group.children.some((child) => child.visible), 'departure portal должен быть виден')
  effect.update(.8)
  assert.ok(effect.group.children.some((child) => child.visible), 'arrival portal должен быть виден')
  assert.equal(effect.group.children.some((child) => child.type === 'Line'), false, 'телепорт не должен рисовать физическую линию')
  effect.dispose()
})

test('lightning beam использует ломаные world-width сегменты и branch sparks', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const chainActors = [...actors, { id: 'target-2', x: 8, y: 6 }]
  const effect = createSpellEffect3D({
    id: 'chain-lightning-3d', kind: 'beam', actorId: 'mage', targetIds: ['target', 'target-2'], spellId: 'chain-lightning', school: 'evocation',
    from: { x: 1, y: 6 }, points: [{ x: 6, y: 6 }, { x: 8, y: 6 }], chain: true, durationMs: 560, detail: 'full',
  }, chainActors, board)
  assert.ok(effect)
  effect.update(.62)
  assert.ok(effect.group.children.some((child) => child.type === 'Mesh' && child.geometry?.type === 'CylinderGeometry' && child.visible), 'lightning должен иметь объёмный blue core')
  effect.update(.9)
  assert.ok(effect.group.children.filter((child) => child.type === 'Mesh' && child.geometry?.type === 'CylinderGeometry').length >= 4, 'цепь должна сохранять bounded lightning branches')
  const resources = new Set(effect.group.children.flatMap((child) => [child.geometry, child.material]).filter(Boolean))
  let disposed = 0
  resources.forEach((resource) => resource.addEventListener('dispose', () => disposed++))
  effect.dispose()
  assert.equal(disposed, resources.size)
})

test('targetOutcomes suppresses only explicit spell misses', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const miss = createSpellEffect3D({
    id: 'ray-miss', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'ray-of-frost', school: 'evocation',
    from: { x: 1, y: 6 }, to: { x: 6, y: 6 }, projectileCount: 1, durationMs: 520, detail: 'minimal', targetOutcomes: { target: 'miss' },
  }, actors, board)
  assert.ok(miss)
  miss.update(.9)
  const missRoot = miss.group.children[0]
  assert.equal(missRoot.children.some((child) => child.geometry?.type === 'TorusGeometry' && child.visible), false, 'explicit miss has no impact ring')
  miss.dispose()

  const unknown = createSpellEffect3D({
    id: 'ray-unknown', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'ray-of-frost', school: 'evocation',
    from: { x: 1, y: 6 }, to: { x: 6, y: 6 }, projectileCount: 1, durationMs: 520, detail: 'minimal',
  }, actors, board)
  assert.ok(unknown)
  unknown.update(.9)
  const unknownRoot = unknown.group.children[0]
  assert.equal(unknownRoot.children.some((child) => child.geometry?.type === 'TorusGeometry' && child.visible), true, 'unknown outcome keeps impact ring')
  unknown.dispose()
})

test('3D gallery sanity проходит все карточки каталога 0–6 без необъяснимой null geometry', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const { spellEffectPalette, spellVisualProfile } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
  const spells = JSON.parse(readFileSync(join(repositoryRoot, 'data/dndsu-spells-0-6.json'), 'utf8')).spells
  const board = decodeTacticalMap(map())
  const nullCues = []
  const familyCounts = new Map()
  let maximumChildren = 0
  for (const spell of spells) {
    const profile = spellVisualProfile(spell.id, { school: spell.school, damageType: spell.damageType, kind: spell.kind })
    const family = spellEffectPalette(spell.id, { school: spell.school, damageType: spell.damageType, kind: spell.kind }).family
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1)
    const common = { spellId: spell.id, school: profile.school, durationMs: 480, detail: 'minimal' }
    const cue = profile.kind === 'projectile'
      ? { id: `gallery:${spell.id}`, kind: 'projectile', actorId: 'mage', targetIds: ['target'], from: { x: 1, y: 6 }, to: { x: 6, y: 6 }, projectileCount: profile.projectileCount ?? 1, damageType: spell.damageType, ...common }
      : profile.kind === 'beam'
        ? { id: `gallery:${spell.id}`, kind: 'beam', actorId: 'mage', targetIds: ['target'], from: { x: 1, y: 6 }, points: [{ x: 6, y: 6 }], chain: profile.chain === true, damageType: spell.damageType, ...common }
        : profile.kind === 'burst'
          ? { id: `gallery:${spell.id}`, kind: 'burst', actorId: 'mage', targetIds: ['target'], origin: { x: 1, y: 6 }, center: { x: 6, y: 6 }, shape: profile.areaShape ?? 'sphere', originMode: profile.areaOrigin ?? 'point', sizeFeet: profile.sizeFeet ?? 10, damageType: spell.damageType, ...common }
          : profile.kind === 'aura'
            ? { id: `gallery:${spell.id}`, kind: 'aura', actorId: 'mage', center: { x: 1, y: 6 }, radiusFeet: profile.radiusFeet ?? 10, auraType: 'spell', active: true, ...common }
            : { id: `gallery:${spell.id}`, kind: 'channel', actorId: 'mage', targetId: 'target', position: { x: 6, y: 6 }, channelType: profile.family === 'teleport' ? 'teleport' : profile.family === 'summon' ? 'summon' : profile.family === 'healing' ? 'healing' : 'cast', amount: profile.family === 'healing' ? 5 : undefined, ...common }
    const effect = createSpellEffect3D(cue, actors, board)
    if (!effect) { nullCues.push({ id: spell.id, kind: profile.kind, family }); continue }
    let sawVisiblePhase = false
    for (const phase of [.12, .5, .86]) {
      effect.update(phase)
      sawVisiblePhase ||= effect.group.children.some((child) => child.visible)
    }
    assert.ok(sawVisiblePhase, `gallery phases produced no visible geometry: ${spell.id}`)
    maximumChildren = Math.max(maximumChildren, effect.group.children.length)
    effect.dispose()
  }
  assert.equal(spells.length, 439)
  assert.equal(nullCues.length, 0, `null geometry: ${JSON.stringify(nullCues.slice(0, 8))}`)
  for (const family of ['illusion', 'divination', 'light', 'darkness', 'environment', 'enchantment', 'restoration', 'invisibility', 'flight', 'mobility', 'transmutation', 'communication', 'utility']) {
    assert.ok(familyCounts.has(family), `gallery family missing: ${family}`)
  }
  assert.ok(familyCounts.size >= 20, `shared families covered: ${[...familyCounts.keys()].join(', ')}`)
  assert.ok(maximumChildren <= 80, `bounded gallery draw children: ${maximumChildren}`)
})

function decodedMap(edit = () => {}) {
  const value = createTacticalMap({ width: 12, height: 12, locationId: 'spell-effects-audit', fill: { passable: true, revealed: true, material: 'stone' } })
  edit(value)
  return JSON.parse(JSON.stringify(serializeTacticalMap(value)))
}

test('контур Огненного шара строится по всем видимым клеткам и остаётся замкнутым на любой детализации', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const { spellBurstCells } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
  const board = decodeTacticalMap(map())
  for (const detail of ['full', 'reduced', 'minimal']) {
    const cue = {
      id: `fireball-contour-${detail}`, kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation',
      center: { x: 6, y: 6 }, gridOrigin: { x: 6, y: 6 }, geometryVersion: 'circle-grid-v2', shape: 'sphere', sizeFeet: 20, durationMs: 1000, detail,
    }
    const cells = spellBurstCells(board, cue, actors, { includeHidden: true })
    assert.ok(cells.length > 36, 'площадь 20 фт больше любой выборки искр')
    const fireball = createSpellEffect3D(cue, actors, board)
    assert.ok(fireball)
    const contour = fireball.group.children.find((child) => child.type === 'LineSegments')
    const positions = contour.geometry.getAttribute('position')
    const keys = new Set(cells.map(({ x, y }) => `${x},${y}`))
    const boundaryEdges = cells.reduce((sum, { x, y }) => sum
      + [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dy]) => !keys.has(`${x + dx},${y + dy}`)).length, 0)
    assert.equal(positions.count / 2, boundaryEdges, `${detail}: каждая граничная грань footprint попадает в контур`)
    const degree = new Map()
    for (let index = 0; index < positions.count; index += 1) {
      const key = `${positions.getX(index)},${positions.getZ(index)}`
      degree.set(key, (degree.get(key) ?? 0) + 1)
    }
    assert.ok([...degree.values()].every((count) => count % 2 === 0), `${detail}: у контура нет оборванных концов`)
    fireball.dispose()
  }
})

test('кольцо области совпадает с серверной площадью: круг на пересечении сетки или квадрат Чебышёва', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const ringOf = (effect) => effect.group.children.find((child) => child.geometry?.type === 'TorusGeometry' && child.geometry.parameters.radius > 1
    || child.geometry?.type === 'RingGeometry')
  for (const sizeFeet of [20, 30]) {
    const circle = createSpellEffect3D({
      id: `circle-ring-${sizeFeet}`, kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'shatter', school: 'evocation',
      center: { x: 6, y: 6 }, gridOrigin: { x: 6, y: 6 }, geometryVersion: 'circle-grid-v2', shape: 'sphere', sizeFeet, durationMs: 480, detail: 'full',
    }, actors, board)
    assert.ok(circle)
    circle.update(.6)
    const ring = ringOf(circle)
    assert.equal(ring.geometry.type, 'TorusGeometry')
    assert.ok(Math.abs(ring.geometry.parameters.radius * ring.scale.x - sizeFeet / 5) < 1e-9, `${sizeFeet} фт: радиус кольца равен r клеток, без капа 4`)
    assert.deepEqual([ring.position.x, ring.position.z], [6, 6], 'центр — пересечение сетки gridOrigin')
    circle.dispose()
  }
  const square = createSpellEffect3D({
    id: 'legacy-square-ring', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'shatter', school: 'evocation',
    center: { x: 6, y: 6 }, shape: 'sphere', originMode: 'point', sizeFeet: 10, durationMs: 480, detail: 'full',
  }, actors, board)
  assert.ok(square)
  square.update(.6)
  const ring = ringOf(square)
  assert.equal(ring.geometry.type, 'RingGeometry', 'старая сфера — квадрат 2r+1 клеток, а не круг')
  assert.equal(ring.geometry.parameters.thetaSegments, 4)
  assert.equal(ring.geometry.userData.halfWidth * ring.scale.x, 2.5, 'полуширина r+0.5 клетки')
  assert.deepEqual([ring.position.x, ring.position.z], [6.5, 6.5])
  square.dispose()
})

test('аура крупного существа — квадрат вокруг центра площади с полушириной r + size/2 на высоте модели', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(decodedMap((value) => setCell(value, 4, 4, { elevation: 10 })))
  const ogre = { id: 'ogre', x: 3, y: 3, footprint: { version: 1, size: 2 } }
  const aura = createSpellEffect3D({
    id: 'large-aura', kind: 'aura', actorId: 'ogre', spellId: 'spirit-guardians', school: 'conjuration',
    radiusFeet: 10, auraType: 'spell', active: true, durationMs: 440, detail: 'reduced',
  }, [ogre], board)
  assert.ok(aura)
  aura.update(.5)
  const ring = aura.group.children.find((child) => child.geometry?.type === 'RingGeometry')
  assert.ok(ring, 'граница ауры — квадрат по Чебышёву')
  assert.equal(ring.geometry.userData.halfWidth, 3, '10 фт + половина площади 2×2')
  assert.equal(ring.position.x, 4)
  assert.equal(ring.position.z, 4)
  assert.ok(Math.abs(ring.position.y - (2 + .05)) < 1e-9, 'аура стоит на максимуме рельефа под площадью, как модель')
  aura.dispose()
})

test('3D-Молния видима по клеткам луча, а не по прямой до кликнутой клетки', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  // Прямая (1,1)→(8,3) задевает стену (5,2), а сервер ведёт луч по диагонали (1,1)→(9,9).
  const board = decodeTacticalMap(decodedMap((value) => setCell(value, 5, 2, { passable: false })))
  const bolt = createSpellEffect3D({
    id: 'diagonal-bolt', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation',
    origin: { x: 1, y: 1 }, center: { x: 8, y: 3 }, shape: 'line', originMode: 'self', sizeFeet: 40, durationMs: 480,
  }, [{ id: 'mage', x: 1, y: 1 }], board)
  assert.ok(bolt, 'луч по восьми направлениям не должен пропадать из-за прямой до клика')
  bolt.update(1)
  const line = bolt.group.children.find((child) => child.isLine)
  const positions = line.geometry.getAttribute('position')
  assert.deepEqual([positions.getX(2), positions.getZ(2)], [9.5, 9.5])
  bolt.dispose()
})

test('исход промаха берётся у той же цели, к которой летит снаряд', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const effect = createSpellEffect3D({
    id: 'paired-miss', kind: 'projectile', actorId: 'mage', targetIds: ['vanished', 'target'], spellId: 'ray-of-frost', school: 'evocation',
    projectileCount: 1, durationMs: 520, detail: 'minimal', targetOutcomes: { target: 'miss' },
  }, actors, board)
  assert.ok(effect)
  effect.update(.9)
  const impacts = []
  effect.group.traverse((child) => { if (child.geometry?.type === 'TorusGeometry' && child.visible) impacts.push(child) })
  assert.equal(impacts.length, 0, 'промах цели target не должен рисовать попадание')
  effect.dispose()
})

test('снаряды распределяются по всем целям, а Волшебная стрела берёт число дротиков из cue', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const twoTargets = [{ id: 'mage', x: 1, y: 6 }, { id: 'a', x: 6, y: 4 }, { id: 'b', x: 6, y: 8 }]
  const splash = createSpellEffect3D({
    id: 'acid-splash-two', kind: 'projectile', actorId: 'mage', targetIds: ['a', 'b'], spellId: 'acid-splash', school: 'conjuration',
    projectileCount: 2, durationMs: 520, detail: 'reduced',
  }, twoTargets, board)
  assert.ok(splash)
  assert.equal(splash.group.children.length, 2)
  splash.update(.95)
  const impacts = splash.group.children.map((root) => root.children.find((child) => child.geometry?.type === 'TorusGeometry').position)
  assert.deepEqual(impacts.map((point) => [point.x, point.z]).sort(), [[6.5, 4.5], [6.5, 8.5]])
  splash.dispose()

  const missile = createSpellEffect3D({
    id: 'magic-missile-upcast', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'magic-missile', school: 'evocation',
    projectileCount: 5, durationMs: 520, detail: 'full',
  }, actors, board)
  assert.equal(missile.group.children.length, 5, 'ячейка 3-го круга — пять дротиков')
  missile.dispose()
})

test('эффект над крупным существом поднимается от максимума рельефа его площади', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(decodedMap((value) => setCell(value, 2, 6, { elevation: 10 })))
  const ogre = { id: 'ogre', x: 1, y: 5, footprint: { version: 1, size: 2 } }
  const effect = createSpellEffect3D({
    id: 'ogre-bolt', kind: 'projectile', actorId: 'ogre', targetIds: ['target'], spellId: 'fire-bolt', school: 'evocation',
    projectileCount: 1, durationMs: 520, detail: 'minimal',
  }, [ogre, { id: 'target', x: 8, y: 6 }], board)
  assert.ok(effect)
  effect.update(.08)
  const orb = effect.group.children[0].children.find((child) => child.geometry?.type === 'SphereGeometry')
  assert.ok(Math.abs(orb.position.y - (2 + .78)) < 1e-9, 'старт снаряда — от высоты модели 2×2, а не anchor-клетки')
  assert.deepEqual([orb.position.x, orb.position.z], [2, 6])
  effect.dispose()
})

test('эффекты не пересчитывают bounding sphere каждый кадр и не отсекаются по устаревшей сфере', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const THREE = await import('three')
  const board = decodeTacticalMap(map())
  const original = THREE.BufferGeometry.prototype.computeBoundingSphere
  let calls = 0
  THREE.BufferGeometry.prototype.computeBoundingSphere = function patched(...args) { calls += 1; return original.apply(this, args) }
  try {
    for (const cue of [
      { id: 'cull-fireball', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation', center: { x: 6, y: 6 }, shape: 'sphere', sizeFeet: 20, durationMs: 1000, detail: 'full' },
      { id: 'cull-missile', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'magic-missile', school: 'evocation', projectileCount: 3, durationMs: 520, detail: 'full' },
      { id: 'cull-chain', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'chain-lightning', school: 'evocation', chain: false, durationMs: 560, detail: 'full' },
      { id: 'cull-heal', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'healing-word', school: 'evocation', channelType: 'healing', durationMs: 480, detail: 'full' },
    ]) {
      const effect = createSpellEffect3D(cue, actors, board)
      assert.ok(effect, cue.id)
      effect.group.traverse((object) => assert.equal(object.frustumCulled, false, `${cue.id}: ${object.type}`))
      calls = 0
      for (const progress of [.1, .3, .5, .7, .9]) effect.update(progress)
      assert.equal(calls, 0, `${cue.id}: update() не должен пересчитывать bounding sphere`)
      effect.dispose()
    }
  } finally {
    THREE.BufferGeometry.prototype.computeBoundingSphere = original
  }
})

const LIGHT_CUES = [
  { id: 'light-fireball', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'fireball', school: 'evocation', center: { x: 6, y: 6 }, shape: 'sphere', sizeFeet: 20, durationMs: 1000 },
  { id: 'light-fire-bolt', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'fire-bolt', school: 'evocation', projectileCount: 1, durationMs: 520 },
  { id: 'light-missile', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'magic-missile', school: 'evocation', projectileCount: 3, durationMs: 520 },
  { id: 'light-chain', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'chain-lightning', school: 'evocation', chain: false, durationMs: 560 },
  { id: 'light-bolt-line', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'lightning-bolt', school: 'evocation', origin: { x: 1, y: 6 }, center: { x: 2, y: 6 }, shape: 'line', originMode: 'self', sizeFeet: 40, durationMs: 480 },
  { id: 'light-heal', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'cure-wounds', school: 'evocation', channelType: 'healing', durationMs: 480 },
  { id: 'light-teleport', kind: 'channel', actorId: 'mage', from: { x: 1, y: 6 }, position: { x: 6, y: 6 }, spellId: 'misty-step', school: 'conjuration', channelType: 'teleport', durationMs: 480 },
]
const QUIET_CUES = [
  { id: 'quiet-aura', kind: 'aura', actorId: 'mage', spellId: 'spirit-guardians', school: 'conjuration', radiusFeet: 15, auraType: 'spell', active: true, durationMs: 440 },
  { id: 'quiet-shield', kind: 'channel', actorId: 'mage', targetId: 'mage', spellId: 'shield', school: 'abjuration', channelType: 'cast', durationMs: 480 },
  { id: 'quiet-hold', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'hold-person', school: 'enchantment', channelType: 'cast', durationMs: 480 },
  { id: 'quiet-toll', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'toll-the-dead', school: 'necromancy', channelType: 'cast', durationMs: 480 },
  { id: 'quiet-summon', kind: 'channel', actorId: 'mage', targetId: 'target', spellId: 'summon-beast', school: 'conjuration', channelType: 'summon', durationMs: 480 },
  { id: 'quiet-whip', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'tasha-s-mind-whip', school: 'enchantment', chain: false, durationMs: 560 },
  { id: 'quiet-blast', kind: 'beam', actorId: 'mage', targetIds: ['target'], spellId: 'eldritch-blast', school: 'evocation', chain: false, durationMs: 560, targetOutcomes: { target: 'miss' } },
  { id: 'quiet-cone', kind: 'burst', actorId: 'mage', targetIds: [], spellId: 'burning-hands', school: 'evocation', center: { x: 4, y: 6 }, shape: 'cone', originMode: 'self', sizeFeet: 15, durationMs: 480 },
]
const PHASES = Array.from({ length: 51 }, (_, index) => index / 50)

test('контракт света эффекта: не больше двух источников, гаснет к концу и молчит на минимальной детализации', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  for (const detail of ['full', 'reduced', 'minimal']) {
    for (const base of [...LIGHT_CUES, ...QUIET_CUES]) {
      const cue = { ...base, id: `${base.id}-${detail}`, detail }
      const effect = createSpellEffect3D(cue, actors, board)
      assert.ok(effect, cue.id)
      const lights = effect.group.userData.lights
      assert.ok(Array.isArray(lights), `${cue.id}: userData.lights объявлен сразу`)
      const seen = new Set()
      let lit = 0
      for (const phase of PHASES) {
        effect.update(phase)
        const frame = effect.group.userData.lights
        assert.equal(frame, lights, `${cue.id}: массив света не пересоздаётся каждый кадр`)
        assert.ok(frame.length <= 2, `${cue.id}@${phase}: не больше двух источников`)
        for (const light of frame) {
          seen.add(light)
          for (const key of ['x', 'y', 'z', 'intensity', 'distance']) assert.ok(Number.isFinite(light[key]), `${cue.id}: ${key}`)
          assert.match(light.color, /^#[0-9a-f]{6}$/iu)
          assert.ok(light.intensity > 0 && light.intensity <= 6, `${cue.id}: яркость ${light.intensity}`)
          assert.ok(light.distance >= 3 && light.distance <= 8, `${cue.id}: дальность ${light.distance}`)
        }
        if (frame.length) lit += 1
      }
      assert.equal(effect.group.userData.lights.length, 0, `${cue.id}: после progress 1 свет погашен`)
      assert.ok(seen.size <= 2, `${cue.id}: источники берутся из постоянного пула`)
      if (detail === 'minimal') assert.equal(lit, 0, `${cue.id}: на минимальной детализации света нет`)
      else if (LIGHT_CUES.includes(base)) assert.ok(lit > 0, `${cue.id}: эффект должен подсветить сцену`)
      effect.dispose()
    }
  }
})

test('update() переиспользует объекты, геометрию и материалы и ничего не добавляет в сцену', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const inventory = (effect) => {
    const objects = []
    const geometries = new Set()
    const materials = new Set()
    effect.group.traverse((object) => {
      objects.push(object)
      if (object.geometry) geometries.add(object.geometry)
      for (const entry of [object.material].flat()) if (entry) materials.add(entry)
    })
    return { objects, geometries, materials }
  }
  for (const detail of ['full', 'minimal']) {
    for (const base of [...LIGHT_CUES, ...QUIET_CUES]) {
      const effect = createSpellEffect3D({ ...base, id: `${base.id}-alloc-${detail}`, detail }, actors, board)
      assert.ok(effect, base.id)
      effect.update(0)
      const before = inventory(effect)
      for (const phase of PHASES) effect.update(phase)
      const after = inventory(effect)
      assert.equal(after.objects.length, before.objects.length, `${base.id}: число объектов не меняется`)
      assert.ok(after.objects.every((object, index) => object === before.objects[index]), `${base.id}: те же объекты`)
      assert.deepEqual([...after.geometries], [...before.geometries], `${base.id}: та же геометрия`)
      assert.deepEqual([...after.materials], [...before.materials], `${base.id}: те же материалы`)
      effect.dispose()
    }
  }
})

test('огненный шар: купол и вспышка растут быстро, тает к краю, а снаряд промаха гаснет без вспышки', async () => {
  const { decodeTacticalMap } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
  const board = decodeTacticalMap(map())
  const fireball = createSpellEffect3D({ ...LIGHT_CUES[0], id: 'fireball-shape', detail: 'full' }, actors, board)
  const dome = fireball.group.children[2]
  fireball.update(.56 + .44 * .15)
  const early = dome.scale.x
  fireball.update(.56 + .44 * .34)
  const full = dome.scale.x
  assert.ok(early > full * .7, 'ease-out: за первую треть взрыва купол почти достигает края')
  assert.ok(dome.scale.y < dome.scale.x * .6, 'купол приплюснут и не закрывает фигурки целиком')
  assert.ok(dome.material.vertexColors, 'край купола ярче макушки')
  fireball.dispose()

  const miss = createSpellEffect3D({
    id: 'bolt-miss-path', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'fire-bolt', school: 'evocation',
    projectileCount: 1, durationMs: 520, detail: 'full', targetOutcomes: { target: 'miss' },
  }, actors, board)
  const root = miss.group.children[0]
  const orb = root.children.find((child) => child.geometry?.type === 'SphereGeometry')
  miss.update(.6)
  assert.ok(Math.hypot(orb.position.x - 6.5, orb.position.z - 6.5) > .2, 'промах проходит мимо центра цели')
  let flashes = 0
  for (const phase of PHASES) {
    miss.update(phase)
    flashes += root.children.filter((child, index) => index > 1 && child.visible && child !== orb && child.geometry?.type === 'SphereGeometry' && child.scale.x > 1).length
  }
  assert.equal(flashes, 0, 'у промаха нет вспышки попадания')
  miss.dispose()
})
