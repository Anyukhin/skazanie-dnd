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
const { actorMovementPresentation, combatSpellTargetLimit, movementEffectTimeLabel, normalSpellSlotLevelsFor, spellCastingSourcesFor, spellSlotAvailabilityFor, toggleCombatSpellTargetIds, combatSpellTargetsWithinSeparation } = await import(pathToFileURL(join(buildDir, 'types.mjs')).href)
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

test('Enter на полотне 3D подтверждает список раньше переключения фишки, пробел сохраняет выбор', () => {
  const board = readFileSync(new URL('../src/TacticalBoard3D.tsx', import.meta.url), 'utf8')
  const dungeon = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const keyDown = board.slice(board.indexOf('const keyDown = (event: KeyboardEvent)'))
  const confirm = keyDown.indexOf("event.key === 'Enter' && latest.current.onConfirmAiming")
  const activate = keyDown.indexOf('activateActor(')
  assert.ok(confirm >= 0 && activate > confirm, 'canvas не должен перехватывать Enter как повторный клик по цели')
  assert.match(keyDown, /onConfirmAiming\(\)\s+return/u)
  assert.match(dungeon, /onConfirmAiming=\{multiTargetSpell && spellTargetIds\.length > 0 && !pendingCommand \? confirmSpellTargetSelection : undefined\}/u)
})

test('Mass Cure Wounds fixes the point before selecting explicit area targets', () => {
  const source = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
  assert.match(source, /selectTargetsInAreaSpell/u)
  assert.match(source, /areaSpellPoint/u)
  assert.match(source, /areaTargetSelectionActive[^\n]*\|\|[^\n]*longstriderTargeting/u)
  assert.match(source, /issueSpell\(\{ \.\.\.areaTarget/u)
  assert.match(session, /to: \{ x: target\.x, y: target\.y \}, target_ids: \[\.\.\.new Set\(target\.targetIds\)\]/u)
  assert.match(source, /Enter — подтвердить/u)
  assert.match(source, /setAreaSpellPoint\(null\)/u)
  assert.match(source, /<select aria-label="Источник заклинания"/u)
  assert.match(source, /<select\s+aria-label="Круг ячейки"/u)

  const massCure = { level: 5, maxTargets: 6, upcastHealingDicePerLevel: 1, selectTargetsInArea: true }
  assert.equal(combatSpellTargetLimit(massCure, 5), 6)
  assert.equal(combatSpellTargetLimit(massCure, 6), 6, 'upcast does not increase the target count')
})

test('Скороход усиливает число выбранных целей по серверной карточке, не добавляет дубли и не подбирает их автоматически', () => {
  const spell = { level: 1, maxTargets: 1, upcastTargetsPerLevel: 1 }
  assert.equal(combatSpellTargetLimit(spell, 1), 1)
  assert.equal(combatSpellTargetLimit(spell, 3), 3)
  assert.equal(combatSpellTargetLimit(spell, 6), 6)
  let selected = ['caster', 'ally']
  selected = toggleCombatSpellTargetIds(selected, 'enemy', combatSpellTargetLimit(spell, 3), true)
  assert.deepEqual(selected, ['caster', 'ally', 'enemy'])
  assert.deepEqual(toggleCombatSpellTargetIds(selected, 'far-target', 3, false), selected)
  assert.deepEqual(toggleCombatSpellTargetIds(selected, 'caster', 3, true), ['ally', 'enemy'])
  assert.deepEqual(toggleCombatSpellTargetIds(['caster'], 'scene-npc', 2, true), ['caster', 'scene-npc'])
  assert.deepEqual(toggleCombatSpellTargetIds(['caster'], 'scene-npc', 2, false), ['caster'])
})

test('нейтральный NPC выбирается общей картой только для Скорохода, с общей проверкой касания и подтверждением', () => {
  const source = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  assert.match(source, /longstriderTargeting && actorAtCell\.kind === 'neutral'/u)
  assert.match(source, /hasClearBoardTrajectory\(state, active, sceneNpc\)/u)
  assert.match(source, /toggleSpellTarget\(sceneNpc\.id, multiTargetSelectable\)/u)
  assert.match(source, /!multiTargetSpell && canHealActorHere\) castAtTarget\(sceneNpc\.id\)/u)
  assert.match(source, /sceneNpcs\.filter\(\(npc\) => npc\.alive\)\.map/u, 'оба renderer получают видимых живых NPC из общей карты')
})

test('выбор источника не скрывает истощённый выбранный ресурс за неявным fallback', () => {
  const spell = { level: 1, slotResource: 'species_spell_longstrider', innateCastLevel: 1, fallbackSlotResource: 'spell_slots_1' }
  const sources = spellCastingSourcesFor(spell, { species_spell_longstrider: { current: 0 }, spell_slots_1: { current: 0 }, spell_slots_3: { current: 2 }, pact_slots: { current: 1 } })
  assert.equal(sources.length, 2)
  assert.equal(sources[0].resource, 'species_spell_longstrider')
  assert.equal(sources[0].availability.ready, false)
  assert.equal(sources[0].availability.usingFallback, false)
  assert.deepEqual(sources[1].availability.levels, [3])
  assert.ok(sources.every((source) => source.resource !== 'pact_slots'), 'необъявленный сервером источник не предлагается')
})

test('интерфейс сохраняет серверные скорость, расход и остаток вместо добавления своих десяти футов', () => {
  const projection = { base_speed: 30, current_speed: 40, movement_spent: 20, movement_bonus: 0, movement_remaining: 20, blocked_reason: null, effects: [] }
  const result = actorMovementPresentation(projection, 30, { movement_spent: 20, movement_remaining: 10 }, true)
  assert.equal(result.currentSpeed, 40)
  assert.equal(result.spent, 20)
  assert.equal(result.remaining, 20)
  const withDash = actorMovementPresentation({ ...projection, movement_bonus: 40, movement_remaining: 60 }, 30, { movement_bonus: 30 }, true)
  assert.equal(withDash.budget, 80)
  assert.equal(withDash.remaining, 60)
  const slow = actorMovementPresentation({ ...projection, current_speed: 17, movement_remaining: 0 }, 30, {}, true)
  assert.equal(slow.currentSpeed, 17)
  assert.equal(slow.remaining, 0)
  assert.equal(movementEffectTimeLabel(3594), '59 мин 54 с')
  assert.equal(movementEffectTimeLabel(0), '0 с')
})

test('новая серверная скорость возвращает движение после исчерпания старого бюджета', () => {
  const staleEconomy = { movement: false, movement_spent: 30, movement_remaining: 0 }
  const exhausted = { base_speed: 30, current_speed: 30, movement_spent: 30, movement_bonus: 0, movement_remaining: 0, blocked_reason: null, effects: [] }
  assert.equal(actorMovementPresentation(exhausted, 30, staleEconomy, true).available, false)
  const restored = actorMovementPresentation({ ...exhausted, current_speed: 40, movement_remaining: 10 }, 30, staleEconomy, true)
  assert.equal(restored.available, true)
  assert.equal(restored.remaining, 10)
  assert.equal(actorMovementPresentation(null, 30, staleEconomy, true).available, false, 'старая проекция сохраняет прежний fallback')
})

test('обездвиживание блокирует исследование, а существующий эффект и его серверный срок остаются видимыми', () => {
  const effect = { effect_id: 'cast-b', spell_id: 'longstrider', name: 'Скороход', bonus_feet: 10, applied: false, started_at_seconds: 600, expires_at_seconds: 4200, remaining_seconds: 600 }
  const snapshot = { base_speed: 30, current_speed: 0, movement_spent: 0, movement_bonus: 0, movement_remaining: 0, blocked_reason: 'Герой схвачен', effects: [effect] }
  const view = actorMovementPresentation(snapshot, 30, null, false)
  assert.equal(view.available, false)
  assert.equal(view.blockedReason, 'Герой схвачен')
  assert.deepEqual(view.effects, [effect])
  const expired = actorMovementPresentation({ ...snapshot, current_speed: 30, movement_remaining: 30, blocked_reason: null, effects: [] }, 30, null, false)
  assert.equal(expired.currentSpeed, 30)
  assert.deepEqual(expired.effects, [])
})
