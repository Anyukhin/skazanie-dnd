import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

// Сборка внутри tmp видит установленный three; игровые данные не используются.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(repositoryRoot, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(repositoryRoot, 'tmp', 'board3d-effects-'))
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(repositoryRoot, 'server', 'actor-footprint.mjs'), join(buildDir, 'server', 'actor-footprint.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'equipment-visuals.mjs'), join(buildDir, 'server', 'equipment-visuals.mjs'))
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
const compiled = spawnSync(process.execPath, [
  join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop',
  '--rootDir', repositoryRoot, '--outDir', buildDir, join(repositoryRoot, 'src/board3d-effects.ts'),
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
const { createCombatEffect3D } = await import(pathToFileURL(join(buildDir, 'src/board3d-effects.mjs')).href)
const { attackOutcome, attackVisualStyle, attackVisualStyleForModelKey, combatAnimationCuesFromEvents, strikeImpactProgress, strikeLaunchProgress, strikeMotionProgress } = await import(pathToFileURL(join(buildDir, 'src/combat-animation.mjs')).href)
const { spellBurstCells } = await import(pathToFileURL(join(buildDir, 'src/spell-effects.mjs')).href)
const { decodeTacticalMap, revealedAt } = await import(pathToFileURL(join(buildDir, 'src/tactical-map-client.mjs')).href)
function map(hidden = []) {
  const value = createTacticalMap({ width: 8, height: 5, locationId: 'effects-test', fill: { passable: true, revealed: true, material: 'stone' } })
  hidden.forEach(({ x, y }) => setCell(value, x, y, { revealed: false }))
  return decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(value))))
}
const actors = [{ id: 'mage', x: 1, y: 2 }, { id: 'target', x: 6, y: 2 }]
const projectile = { id: 'spell-confirmed', kind: 'projectile', actorId: 'mage', targetIds: ['target'], spellId: 'fire-bolt', school: 'evocation', projectileCount: 2, durationMs: 500 }

test('3D ranged strike летит физической стрелой по event trajectory', () => {
  const cue = {
    id: 'attack-bow', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'bow', from: { x: 0, y: 0 }, to: { x: 5, y: 3 }, durationMs: 480, detail: 'full',
  }
  // Позиции участников намеренно не совпадают с событием: cue обязан вести
  // стрелу по замороженной траектории, а не по текущему снимку актёров.
  const effect = createCombatEffect3D(cue, [{ id: 'mage', x: 7, y: 4 }, { id: 'target', x: 1, y: 4 }], map())
  const arrow = effect.group.children.find((child) => child.type === 'Group')
  assert.ok(arrow)
  assert.equal(arrow.children.length, 2, 'стрела состоит из древка и наконечника, а не из melee beam-сегментов')
  effect.update(.36)
  assert.ok(arrow.visible)
  assert.ok(arrow.position.x > 1 && arrow.position.x < 5, 'стрела должна быть между концами trajectory')
  effect.update(.73)
  assert.equal(arrow.visible, false, 'к моменту impact стрела уже прилетела')
  effect.dispose()
})

test('3D ranged strike выбирает bolt, bullet, stone и dart по v2 loadout', () => {
  const base = {
    kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'unknown', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480,
  }
  for (const [modelKey, expected] of [
    ['light-crossbow', 'bolt'], ['heavy-crossbow', 'bolt'], ['pistol', 'bullet'],
    ['musket', 'bullet'], ['sling', 'stone'], ['blowgun', 'dart'],
  ]) {
    const effect = createCombatEffect3D({
      ...base,
      loadout: { main_hand: { model_key: modelKey } },
    }, actors, map())
    const projectile = effect.group.children.find((child) => child.type === 'Group')
    assert.ok(projectile, modelKey)
    assert.equal(projectile.userData.projectileKind, expected, modelKey)
    effect.dispose()
  }
  const fallback = createCombatEffect3D(base, actors, map())
  assert.equal(fallback.group.children.find((child) => child.type === 'Group')?.userData.projectileKind, 'arrow')
  fallback.dispose()
})

test('3D thrown strike создаёт физический снаряд, а не луч', () => {
  const cue = {
    id: 'attack-thrown', kind: 'strike', actorId: 'mage', targetId: 'target', hit: false, amount: 0,
    attackKind: 'thrown', equipment: 'dagger', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480, detail: 'reduced',
  }
  const effect = createCombatEffect3D(cue, actors, map())
  const projectileMesh = effect.group.children.find((child) => child.type === 'Group')
  assert.ok(projectileMesh)
  assert.equal(projectileMesh.children.length, 1)
  effect.update(.35)
  assert.ok(projectileMesh.visible)
  effect.dispose()
})

test('snapshot loadout различает силуэт брошенного клинка, копья и топора', () => {
  const base = {
    kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5, attackKind: 'thrown', equipment: 'dagger',
    from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480,
  }
  for (const [modelKey, expected] of [['dagger', 'thrown-dagger'], ['javelin', 'thrown-spear'], ['handaxe', 'thrown-axe'], ['net', 'thrown-net'], ['unknown', 'thrown']]) {
    const effect = createCombatEffect3D({ ...base, id: `thrown-${modelKey}`, loadout: { main_hand: { model_key: modelKey } } }, actors, map())
    assert.equal(effect.group.children.find((child) => child.type === 'Group')?.userData.projectileKind, expected)
    if (modelKey === 'net') {
      effect.update(.74)
      assert.ok(effect.group.children.some((child) => child.userData.netContour && child.visible), 'сеть должна кратко раскрыться на цели')
    }
    effect.dispose()
  }
})

test('физический профиль атаки различает slash, thrust, blunt и outcomes', () => {
  const base = { kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5, attackKind: 'melee', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480 }
  assert.equal(attackVisualStyle({ ...base, equipment: 'sword' }), 'slash')
  assert.equal(attackVisualStyle({ ...base, equipment: 'dagger' }), 'pierce')
  assert.equal(attackVisualStyle({ ...base, equipment: 'staff' }), 'bludgeon')
  assert.equal(attackVisualStyle({ ...base, equipment: 'unarmed' }), 'unarmed')
  assert.equal(attackOutcome({ ...base, equipment: 'sword', critical: true }), 'critical')
  assert.equal(attackOutcome({ ...base, equipment: 'sword', hit: false, blocked: true }), 'blocked')
  assert.equal(strikeMotionProgress(base, strikeImpactProgress(base)), .5)
  assert.equal(strikeLaunchProgress(base), 0)
  assert.equal(strikeLaunchProgress({ ...base, attackKind: 'ranged' }), .2)

  for (const [equipment, expected] of [['sword', 'slash'], ['dagger', 'pierce'], ['staff', 'bludgeon'], ['unarmed', 'unarmed']]) {
    const effect = createCombatEffect3D({ ...base, id: `profile-${equipment}`, equipment }, actors, map())
    const arc = effect.group.children.find((child) => child.userData.attackStyle === expected)
    assert.ok(arc, `${equipment}: отсутствует профиль ${expected}`)
    effect.dispose()
  }
  const critical = createCombatEffect3D({ ...base, id: 'critical', equipment: 'sword', critical: true }, actors, map())
  assert.ok(critical.group.children.filter((child) => child.userData.attackOutcome === 'critical').length >= 2)
  critical.dispose()
  const blocked = createCombatEffect3D({ ...base, id: 'blocked', equipment: 'sword', hit: false, blocked: true }, actors, map())
  assert.ok(blocked.group.children.filter((child) => child.userData.attackOutcome === 'blocked').length >= 2)
  blocked.dispose()
})

test('полный каталог боевого оружия получает визуальный профиль', () => {
  const expected = {
    club: 'bludgeon', dagger: 'pierce', greatclub: 'bludgeon', handaxe: 'slash', javelin: 'pierce',
    'light-hammer': 'bludgeon', mace: 'bludgeon', quarterstaff: 'bludgeon', sickle: 'slash', spear: 'pierce',
    dart: 'dart', 'light-crossbow': 'crossbow', shortbow: 'bow', sling: 'sling', battleaxe: 'slash', flail: 'bludgeon',
    glaive: 'slash', greataxe: 'slash', greatsword: 'slash', halberd: 'slash', lance: 'pierce', longsword: 'slash',
    maul: 'bludgeon', morningstar: 'pierce', pike: 'pierce', rapier: 'pierce', scimitar: 'slash', shortsword: 'pierce',
    trident: 'pierce', warhammer: 'bludgeon', 'war-pick': 'pierce', whip: 'slash', blowgun: 'dart',
    'hand-crossbow': 'crossbow', 'heavy-crossbow': 'crossbow', longbow: 'bow', musket: 'firearm', pistol: 'firearm',
    wand: 'wand', net: 'net',
  }
  assert.equal(Object.keys(expected).length, 40)
  for (const [modelKey, style] of Object.entries(expected)) assert.equal(attackVisualStyleForModelKey(modelKey), style, modelKey)
  assert.equal(attackVisualStyle({ kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 1, attackKind: 'thrown', loadout: { main_hand: { model_key: 'handaxe' } } }), 'thrown')
  assert.equal(attackVisualStyle({ kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 1, attackKind: 'melee', loadout: { main_hand: { model_key: 'wand' } } }), 'bludgeon')
  assert.equal(attackVisualStyle({ kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 1, attackKind: 'ranged', loadout: { main_hand: { model_key: 'wand' } } }), 'wand')
  assert.equal(attackVisualStyle({ kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 1, attackKind: 'thrown', loadout: { main_hand: { model_key: 'net' } } }), 'net')
})

test('публичный beast metadata даёт natural claws и не рисует weapon arc', () => {
  const effect = createCombatEffect3D({
    id: 'wolf-bite', kind: 'strike', actorId: 'wolf', targetId: 'target', hit: true, amount: 4,
    attackKind: 'melee', equipment: 'unknown', damageType: 'piercing', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480,
  }, [{ id: 'wolf', x: 1, y: 2, kind: 'enemy', archetype: 'wolf' }, { id: 'target', x: 6, y: 2 }], map())
  assert.ok(effect.group.children.some((child) => child.userData.attackStyle === 'natural'))
  effect.dispose()
})

test('брошенное оружие вращается по frozen trajectory', () => {
  const effect = createCombatEffect3D({
    id: 'spin-thrown', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'thrown', equipment: 'dagger', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480,
  }, actors, map())
  const projectileMesh = effect.group.children.find((child) => child.type === 'Group')
  assert.ok(projectileMesh)
  effect.update(.24)
  const first = projectileMesh.quaternion.clone()
  effect.update(.38)
  assert.notDeepEqual(projectileMesh.quaternion.toArray(), first.toArray())
  effect.dispose()
})

test('physical cue сохраняет только подтверждённые critical и block markers', () => {
  const [critical] = combatAnimationCuesFromEvents([{
    event_id: 'critical-event', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['target'],
    payload: { hit: true, critical: true, attack_kind: 'melee', attack_visual: { version: 1, equipment: 'sword' } },
  }])
  assert.equal(critical.critical, true)
  assert.equal(critical.blocked, undefined)
  const [blocked] = combatAnimationCuesFromEvents([{
    event_id: 'blocked-event', event_type: 'AttackResolved', actor_id: 'mage', target_ids: ['target'],
    payload: { hit: false, mirror_image_intercepted: true, attack_kind: 'ranged', attack_visual: { version: 1, equipment: 'bow' } },
  }])
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.critical, undefined)
})

test('3D physical strike не выпускается по скрытой траектории', () => {
  const cue = {
    id: 'attack-hidden', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'bow', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480,
  }
  const effect = createCombatEffect3D(cue, actors, map([{ x: 3, y: 2 }]))
  assert.equal(effect.group.children.length, 0)
  effect.dispose()
})

test('3D combat center использует центр footprint, но возвращается к anchor в тумане', () => {
  const largeActors = [
    { id: 'mage', x: 1, y: 1, footprint: { version: 1, size: 2 } },
    { id: 'target', x: 5, y: 1, footprint: { version: 1, size: 2 } },
  ]
  const cue = {
    id: 'large-arrow', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5,
    attackKind: 'ranged', equipment: 'bow', from: { x: 1, y: 1 }, to: { x: 5, y: 1 }, durationMs: 480, detail: 'full',
  }
  const full = createCombatEffect3D(cue, largeActors, map())
  const fullArrow = full.group.children.find((child) => child.type === 'Group')
  assert.ok(fullArrow)
  full.update(0)
  assert.equal(fullArrow.position.x, 2, 'полный footprint начинается из центра большой клетки')
  assert.equal(fullArrow.position.z, 2, 'полный footprint центрируется по Z')
  full.dispose()

  const partialBoard = map([{ x: 2, y: 1 }])
  const partial = createCombatEffect3D(cue, largeActors, partialBoard)
  assert.equal(partial.group.children.length, 0, 'скрытая часть footprint блокирует физическую траекторию')
  partial.dispose()
})

test('cue.detail и внешний более строгий detail уменьшают sparks и beam segments', () => {
  const base = { id: 'detail-strike', kind: 'strike', actorId: 'mage', targetId: 'target', hit: true, amount: 5, attackKind: 'melee', from: { x: 1, y: 2 }, to: { x: 6, y: 2 }, durationMs: 480 }
  const full = createCombatEffect3D({ ...base, detail: 'full' }, actors, map())
  const reduced = createCombatEffect3D({ ...base, detail: 'reduced' }, actors, map())
  const minimal = createCombatEffect3D({ ...base, detail: 'full' }, actors, map(), 'minimal')
  assert.ok(full.group.children.length > reduced.group.children.length)
  assert.ok(reduced.group.children.length > minimal.group.children.length)
  full.dispose(); reduced.dispose(); minimal.dispose()
})

test('3D-снаряды не рисуют скрытую цель и скрытые участки траектории', () => {
  const hiddenTarget = createCombatEffect3D(projectile, actors, map([{ x: 6, y: 2 }]))
  assert.equal(hiddenTarget.group.children.length, 0)
  hiddenTarget.dispose()
  const board = map([{ x: 3, y: 2 }, { x: 4, y: 2 }])
  const effect = createCombatEffect3D(projectile, actors, board)
  assert.ok(effect.group.children.length > 0)
  for (let progress = 0; progress <= 1; progress += .025) {
    effect.update(progress)
    for (const mesh of effect.group.children.filter((child) => child.visible)) assert.ok(revealedAt(board, Math.floor(mesh.position.x), Math.floor(mesh.position.z)))
  }
  effect.dispose()
})

test('3D-эффект использует переданные события без изменения карты и участников', () => {
  const board = map()
  const before = JSON.stringify({ board, actors, projectile })
  const effect = createCombatEffect3D(projectile, actors, board)
  effect.update(.25); effect.update(.7)
  assert.equal(JSON.stringify({ board, actors, projectile }), before)
  const resources = new Set(effect.group.children.flatMap((mesh) => [mesh.geometry, mesh.material]))
  let disposed = 0
  resources.forEach((resource) => resource.addEventListener('dispose', () => disposed++))
  effect.dispose()
  assert.equal(disposed, resources.size)
})

test('объёмный взрыв следует тем же клеткам сферы, конуса, куба и линии, что и 2D', () => {
  const board = map()
  for (const shape of ['sphere', 'cone', 'cube', 'line']) {
    const cue = { id: 'area-' + shape, kind: 'burst', actorId: 'mage', targetIds: ['target'], school: 'evocation', spellId: 'burning-hands', shape, originMode: 'self', sizeFeet: 10, durationMs: 500 }
    const expected = new Set(spellBurstCells(board, cue, actors).map((cell) => `${cell.x},${cell.y}`))
    assert.ok(expected.size > 0)
    const effect = createCombatEffect3D(cue, actors, board)
    effect.update(.65)
    const visible = effect.group.children.filter((mesh) => mesh.visible)
    assert.ok(visible.length > 0, `${shape}: не нарисован эффект`)
    for (const mesh of visible) assert.ok(expected.has(`${Math.floor(mesh.position.x)},${Math.floor(mesh.position.z)}`), `${shape}: частица за пределами области 2D`)
    effect.dispose()
  }
})
