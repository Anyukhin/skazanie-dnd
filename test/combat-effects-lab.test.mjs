import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, renameSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-combat-effects-lab-'))
mkdirSync(join(buildDir, 'server'), { recursive: true })
symlinkSync(join(repositoryRoot, 'node_modules'), join(buildDir, 'node_modules'), 'junction')
copyFileSync(join(repositoryRoot, 'server', 'equipment-visuals.mjs'), join(buildDir, 'server', 'equipment-visuals.mjs'))
copyFileSync(join(repositoryRoot, 'server', 'actor-footprint.mjs'), join(buildDir, 'server', 'actor-footprint.mjs'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM,DOM.Iterable', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop',
  '--jsx', 'react-jsx', '--types', 'vite/client', '--rootDir', repositoryRoot, '--outDir', buildDir,
  join(repositoryRoot, 'src', 'CombatEffectsLab.tsx'),
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)

function emittedFiles(directory) {
  return readdirSync(directory).filter((name) => name !== 'node_modules').flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? emittedFiles(path) : [path]
  })
}

for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const rewritten = readFileSync(path, 'utf8')
    .replace(/^import\s+["'][^"']+\.css["'];?\s*$/gmu, '')
    .replace(/(from\s+["'])(\.\.?\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => (
      specifier.endsWith('.json') || specifier.endsWith('.mjs') || specifier.endsWith('.js')
        ? match
        : `${before}${specifier}.mjs${after}`
    ))
  writeFileSync(path, rewritten)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}

const lab = await import(pathToFileURL(join(buildDir, 'src', 'CombatEffectsLab.mjs')).href)
const animation = await import(pathToFileURL(join(buildDir, 'src', 'combat-animation.mjs')).href)
const effects = await import(pathToFileURL(join(buildDir, 'src', 'spell-effects.mjs')).href)
const sharedArea = await import(pathToFileURL(join(buildDir, 'src', 'area-geometry.mjs')).href)
const equipmentVisuals = await import(pathToFileURL(join(buildDir, 'server', 'equipment-visuals.mjs')).href)
const labSource = readFileSync(join(repositoryRoot, 'src', 'CombatEffectsLab.tsx'), 'utf8')
const labCssSource = readFileSync(join(repositoryRoot, 'src', 'combat-effects-lab.css'), 'utf8')
const catalog = JSON.parse(readFileSync(join(repositoryRoot, 'data', 'dndsu-spells-0-6.json'), 'utf8')).spells
const overrides = JSON.parse(readFileSync(join(repositoryRoot, 'data', 'dndsu-spell-mechanics-overrides.json'), 'utf8')).spells

function assertPoint(point, label) {
  assert.ok(point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)), `${label}: point`)
  assert.ok(Number(point.x) >= 0 && Number(point.x) < 14 && Number(point.y) >= 0 && Number(point.y) < 10, `${label}: bounded point`)
}

function auditCues(cues, label) {
  assert.ok(cues.length > 0, `${label}: cue не построен`)
  for (const cue of cues) {
    assert.ok(Number.isFinite(cue.durationMs) && cue.durationMs > 0 && cue.durationMs <= 2000, `${label}: bounded duration`)
    if (cue.kind === 'burst') {
      for (const point of cue.cells ?? []) assertPoint(point, `${label}: cell`)
      assert.ok((cue.cells?.length ?? 0) <= 96, `${label}: bounded area`)
      if (cue.center) assertPoint(cue.center, `${label}: center`)
      if (cue.origin) assertPoint(cue.origin, `${label}: origin`)
    }
    if (cue.kind === 'projectile' || cue.kind === 'beam') {
      if (cue.from) assertPoint(cue.from, `${label}: from`)
      for (const point of cue.points ?? []) assertPoint(point, `${label}: beam point`)
      assert.ok((cue.points?.length ?? 0) <= 8, `${label}: bounded beam`)
    }
    if (cue.kind === 'channel' && cue.position) assertPoint(cue.position, `${label}: position`)
  }
}

function spellEntry(id) {
  const spell = catalog.find((candidate) => candidate.id === id)
  assert.ok(spell, `${id}: fixture exists`)
  const merged = { ...spell, ...(overrides[id] ?? {}) }
  const palette = effects.spellEffectPalette(id, merged)
  return { type: 'spell', spell: merged, support: 'heuristic', family: palette.family, soundFamily: palette.soundFamily }
}

test('галерея строит production cue и sound profile для всех 439 заклинаний кругов 0-6', () => {
  assert.equal(catalog.length, 439)
  assert.equal(new Set(catalog.map((spell) => spell.id)).size, catalog.length)
  assert.ok(catalog.every((spell) => spell.level >= 0 && spell.level <= 6))

  for (const [index, spell] of catalog.entries()) {
    const merged = { ...spell, ...(overrides[spell.id] ?? {}) }
    const palette = effects.spellEffectPalette(spell.id, merged)
    assert.ok(palette.soundFamily, `${spell.id}: sound family`)
    const entry = {
      type: 'spell',
      spell: merged,
      support: overrides[spell.id]?.mechanicsSupport ?? 'heuristic',
      family: palette.family,
      soundFamily: palette.soundFamily,
    }
    const events = lab.buildPreviewEvents(entry, index + 1)
    auditCues(animation.combatAnimationCuesFromEvents(events), spell.id)
    assert.equal(lab.soundFamilyForSpell(spell.id, merged), palette.soundFamily, `${spell.id}: profile sound mapping`)
  }
})

test('галерея оставляет все shared physical attack model keys и 13 стилей в production strike cue', () => {
  const expectedModelKeys = [
    'battleaxe', 'blowgun', 'club', 'dagger', 'dart', 'flail', 'glaive', 'greataxe', 'greatclub', 'greatsword',
    'halberd', 'hand-crossbow', 'handaxe', 'heavy-crossbow', 'javelin', 'lance', 'light-crossbow', 'light-hammer',
    'longbow', 'longsword', 'mace', 'maul', 'morningstar', 'musket', 'net', 'pike', 'pistol', 'quarterstaff',
    'rapier', 'scimitar', 'shortbow', 'shortsword', 'sickle', 'sling', 'spear', 'trident', 'wand', 'war-pick',
    'warhammer', 'whip',
  ]
  // В main_hand также входят фокусы и инструменты; галерея ударов проверяет
  // физическое оружие и палочку для магической атаки.
  const modelKeys = new Set(equipmentVisuals.modelKeysForEquipmentSlot('main_hand').filter((key) => expectedModelKeys.includes(key)))
  const entries = lab.COMBAT_EFFECTS_ATTACK_ENTRIES.filter((entry) => modelKeys.has(entry.modelKey) || entry.id === 'unarmed' || entry.id === 'natural' || entry.id.endsWith(':thrown'))
  assert.deepEqual([...modelKeys].sort(), expectedModelKeys.sort(), 'canonical main_hand model keys')
  assert.equal(entries.filter((entry) => modelKeys.has(entry.modelKey) && entry.id === entry.modelKey).length, expectedModelKeys.length)
  assert.equal(entries.filter((entry) => entry.id.endsWith(':thrown')).length, 7, 'метательные варианты должны следовать properties=thrown')
  assert.equal(entries.length, 49, '40 canonical + 7 thrown + unarmed + natural')
  const net = entries.find((entry) => entry.id === 'net')
  assert.equal(net?.attackKind, 'thrown')
  assert.equal(net?.damageType, undefined, 'сеть не должна получать выдуманный damage_type')
  assert.equal(entries.some((entry) => entry.id === 'net:thrown'), false)
  assert.ok(entries.some((entry) => entry.id === 'unarmed'))
  assert.ok(entries.some((entry) => entry.id === 'natural'))
  const styles = new Set()
  for (const entry of entries) {
    const events = lab.buildPreviewEvents(entry, 1)
    const actors = lab.previewActors(entry)
    const caster = actors.find((actor) => actor.id === 'caster')
    const target = actors.find((actor) => actor.id === 'enemy')
    assert.equal(caster?.appearance?.loadout?.main_hand?.model_key, entry.modelKey, `${entry.id}: caster loadout`)
    assert.deepEqual(events[0]?.payload?.trajectory?.[1], { x: target?.x, y: target?.y }, `${entry.id}: trajectory matches actor`)
    if (entry.attackKind === 'melee') assert.ok(target?.x === 4 || target?.x === 5, `${entry.id}: melee contact range`)
    else assert.equal(target?.x, 9, `${entry.id}: ranged contact distance`)
    const [cue] = animation.combatAnimationCuesFromEvents(events)
    assert.equal(cue?.kind, 'strike', `${entry.id}: strike cue`)
    const style = entry.id === 'natural'
      ? animation.attackVisualStyleForActor(cue, { appearance: { profile: 'beast' } })
      : animation.attackVisualStyle(cue)
    styles.add(style)
    auditCues([cue], entry.id)
  }
  assert.deepEqual([...styles].sort(), ['bludgeon', 'bow', 'crossbow', 'dart', 'firearm', 'natural', 'net', 'pierce', 'sling', 'slash', 'thrown', 'unarmed', 'wand'].sort())
})

test('галерея не подменяет смысловые исключения summon/teleport из catalog.kind', () => {
  for (const id of ['phantasmal-force', 'hallow', 'forbiddance']) {
    const [event] = lab.buildPreviewEvents(spellEntry(id), 1)
    assert.equal(event.event_type, 'SpellCast', `${id}: эффект остаётся spell cast preview`)
    assert.notEqual(event.event_type, 'SummonedCreatureCreated', `${id}: не fake summon`)
    assert.notEqual(event.event_type, 'ActorMoved', `${id}: не fake teleport`)
  }
})

test('галерея использует ту же клеточную геометрию sphere/cone/line/cube и clipping', () => {
  const cases = ['fireball', 'burning-hands', 'lightning-bolt', 'web', 'control-water']
  const walkable = (point) => point.x > 0 && point.x < 13 && point.y > 0 && point.y < 9
  for (const id of cases) {
    const entry = spellEntry(id)
    const profile = effects.spellVisualProfile(id, entry.spell)
    const shape = profile.areaShape
    assert.ok(shape, `${id}: area shape`)
    const originMode = entry.spell.areaOrigin ?? (entry.spell.target === 'self' ? 'self' : 'point')
    const directional = shape === 'cone' || shape === 'line' || shape === 'cube' && originMode === 'self'
    const target = directional || originMode === 'point' ? { x: 8, y: 5 } : { x: 3, y: 5 }
    const sizeFeet = Math.max(5, Number(profile.sizeFeet ?? entry.spell.radius ?? 10) || 10)
    const expected = sharedArea.areaCells({
      shape,
      origin: { x: 3, y: 5 },
      target,
      originMode,
      sizeFeet,
      cellFeet: 5,
      bounds: lab.COMBAT_EFFECTS_PREVIEW_BOUNDS,
      isWalkable: walkable,
    }).filter(walkable)
    const [event] = lab.buildPreviewEvents(entry, 17)
    assert.deepEqual(event.payload.cells, expected, `${id}: preview cells equal shared area geometry`)
    if (id === 'control-water') assert.ok(expected.length < 96, 'large cube is clipped to the bounded preview window')
  }
})

test('галерея не помечает первый preview batch просмотренным и меняет id при повторе', () => {
  assert.match(labSource, /useState<CombatVisualBatch \| null>\(null\)/u)
  assert.match(labSource, /setBatch\(\{ id: `effects-lab:\$\{current\.type\}:\$\{previewId\(current\)\}:\$\{replay\}`/u)
  assert.match(labSource, /combatAudio=\{combatAudio\}/u)
  assert.doesNotMatch(labSource, /createOscillator|SOUND_PRESETS|playMappedSound/u)
  assert.match(labCssSource, /\.combat-lab-page \.combat-effects-lab \.board3d :is\(\.board3d-quality, \.board3d-roof-mode\)/u)
  assert.match(labCssSource, /\.combat-lab-page \.combat-effects-lab \.combat-effects-lab-list button/u)
})

process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))
