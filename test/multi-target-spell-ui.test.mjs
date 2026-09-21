import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const testRoot = mkdtempSync(join(tmpdir(), 'skazanie-multi-target-ui-'))
const buildDir = join(testRoot, 'build')
mkdirSync(buildDir, { recursive: true })
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/types.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--noCheck', '--noResolve', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--outDir', buildDir, source], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const output = readFileSync(join(buildDir, 'types.js'), 'utf8')
writeFileSync(join(buildDir, 'types.mjs'), output)
const { combatSpellTargetLimit, normalSpellSlotLevelsFor, spellSlotAvailabilityFor, toggleCombatSpellTargetIds, combatSpellTargetsWithinSeparation } = await import(pathToFileURL(join(buildDir, 'types.mjs')).href)
process.on('exit', () => rmSync(testRoot, { recursive: true, force: true }))

test('multi-target spell UI uses the server profile limit and toggles without auto-selecting', () => {
  assert.equal(combatSpellTargetLimit({ maxTargets: 2 }), 2)
  assert.equal(combatSpellTargetLimit({ maxTargets: 0 }), 1)
  assert.deepEqual(toggleCombatSpellTargetIds([], 'enemy-1', 2, true), ['enemy-1'])
  assert.deepEqual(toggleCombatSpellTargetIds(['enemy-1'], 'enemy-1', 2, true), [])
  assert.deepEqual(toggleCombatSpellTargetIds(['enemy-1', 'enemy-2'], 'enemy-3', 2, true), ['enemy-1', 'enemy-2'])
  assert.deepEqual(toggleCombatSpellTargetIds([], 'enemy-1', 2, false), [])
})

test('multi-target separation warning follows grid feet and allows one target', () => {
  assert.equal(combatSpellTargetsWithinSeparation([{ x: 1, y: 1 }], 5), true)
  assert.equal(combatSpellTargetsWithinSeparation([{ x: 1, y: 1 }, { x: 2, y: 1 }], 5), true)
  assert.equal(combatSpellTargetsWithinSeparation([{ x: 1, y: 1 }, { x: 3, y: 1 }], 5), false)
  assert.equal(combatSpellTargetsWithinSeparation([{ x: 1, y: 1 }, { x: 3, y: 1 }], 0), true)
})

test('upcast UI offers only real ordinary spell slots and falls back above an empty base slot', () => {
  const resources = {
    spell_slots_1: { current: 0 },
    spell_slots_2: { current: 1 },
    spell_slots_3: { current: 2 },
    pact_slots: { current: 2 },
  }
  assert.deepEqual(normalSpellSlotLevelsFor(1, 'spell_slots_1', resources), [2, 3])
  assert.deepEqual(normalSpellSlotLevelsFor(1, 'pact_slots', resources), [])
  assert.deepEqual(normalSpellSlotLevelsFor(1, 'mystic_arcanum_6', resources), [])
  assert.deepEqual(normalSpellSlotLevelsFor(1, 'species_spell_shield', { ...resources, species_spell_shield: { current: 1 } }), [])
})

test('innate spell keeps its fixed live resource and does not fake an ordinary upcast', () => {
  const spell = { level: 1, slotResource: 'species_spell_shield', innateSpell: true, innateCastLevel: 2, slotLevel: 2 }
  const availability = spellSlotAvailabilityFor(spell, {
    species_spell_shield: { current: 1, max: 1 },
    spell_slots_1: { current: 1, max: 1 },
    spell_slots_2: { current: 1, max: 1 },
  })
  assert.deepEqual(availability, { resource: 'species_spell_shield', levels: [], fixedLevel: 2, ready: true, usingFallback: false })
})

test('exhausted innate spell uses only an explicit ordinary fallback', () => {
  const spell = { level: 1, slotResource: 'species_spell_shield', innateSpell: true, innateCastLevel: 2, slotLevel: 2, fallbackSlotResource: 'spell_slots_1' }
  const fallback = spellSlotAvailabilityFor(spell, {
    species_spell_shield: { current: 0, max: 1 },
    spell_slots_1: { current: 1, max: 1 },
    spell_slots_2: { current: 0, max: 1 },
  })
  assert.deepEqual(fallback, { resource: 'spell_slots_1', levels: [1], fixedLevel: null, ready: true, usingFallback: true })
  const blocked = spellSlotAvailabilityFor({ ...spell, fallbackSlotResource: undefined }, {
    species_spell_shield: { current: 0, max: 1 },
    spell_slots_1: { current: 1, max: 1 },
  })
  assert.deepEqual(blocked, { resource: 'species_spell_shield', levels: [], fixedLevel: 2, ready: false, usingFallback: false })
})

test('pact and arcanum remain fixed special resources', () => {
  assert.deepEqual(spellSlotAvailabilityFor({ level: 3, slotResource: 'pact_slots', slotLevel: 5 }, { pact_slots: { current: 1, max: 2 } }), { resource: 'pact_slots', levels: [], fixedLevel: 5, ready: true, usingFallback: false })
  assert.deepEqual(spellSlotAvailabilityFor({ level: 6, slotResource: 'mystic_arcanum_6', slotLevel: 6 }, { mystic_arcanum_6: { current: 0, max: 1 } }), { resource: 'mystic_arcanum_6', levels: [], fixedLevel: 6, ready: false, usingFallback: false })
})

test('DungeonMap keeps point spells and manual target confirmation paths separate', () => {
  const source = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
  assert.match(source, /targetIds: string\[\]/u)
  assert.match(source, /slotLevel\?: number/u)
  assert.match(source, /slotLevel/u)
  assert.match(source, /selectedSpell\.slotLevel/u)
  assert.match(source, /spell-slot-picker/u)
  assert.match(session, /target\.slotLevel/u)
  assert.match(session, /slot_level/u)
  assert.match(source, /kind: 'spell-targets'/u)
  assert.match(source, /Enter — подтвердить/u)
  assert.match(source, /if \(multiTargetSpell && multiTargetSelectable\) toggleSpellTarget/u)
  assert.match(source, /if \(!multiTargetSpell \|\| !spellTargetIds\.length/u)
  assert.match(source, /selectedSpell\?\.target === 'point'/u)
  assert.match(source, /onCancelAiming=\{spellAiming \? clearPrepared : undefined\}/u)
})
