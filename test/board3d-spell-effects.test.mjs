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
  assert.equal(throughWall, null, 'линия не должна появляться сквозь blocksSight edge')

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
