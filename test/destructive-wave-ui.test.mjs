import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dungeon = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/TacticalBoard.tsx', import.meta.url), 'utf8')
const board3d = readFileSync(new URL('../src/TacticalBoard3D.tsx', import.meta.url), 'utf8')

test('Destructive Wave uses caster-centered explicit self-area selection', () => {
  assert.match(dungeon, /const selfAreaSpell = Boolean\(selectTargetsInAreaSpell && selectedSpell\?\.target === 'self'\)/u)
  assert.match(dungeon, /const areaTargetPoint = areaSpellPoint \?\? \(selfAreaSpell && active \? \{ x: active\.x, y: active\.y \} : null\)/u)
  assert.match(dungeon, /selectedSpell\?\.target === 'self' && !selfAreaSpell && spellEconomyReady/u)
  assert.match(dungeon, /const areaTarget = areaTargetSelectionActive && areaTargetPoint/u)
  assert.match(dungeon, /const targetIds = \[\.\.\.spellTargetIds\]/u)
  assert.match(dungeon, /if \(!multiTargetSpell \|\| !spellTargetIds\.length/u)
})

test('Area target UI does not invent a maxTargets=1 fallback', () => {
  assert.match(dungeon, /const spellTargetLimit = selectTargetsInAreaSpell && selectedSpell\?\.maxTargets == null/u)
  assert.match(dungeon, /\? spellAffectedActors\.length/u)
  assert.match(dungeon, /toggleCombatSpellTargetIds\(current, targetId, spellTargetLimit/u)
})

test('Spell option and keyboard selection stay on the shared 2D/3D path', () => {
  assert.match(dungeon, /selectedSpellOption \? \{ spellOption: selectedSpellOption \} : \{\}/u)
  assert.match(dungeon, /key === 'Escape'/u)
  assert.match(dungeon, /key !== 'Enter'/u)
  assert.match(dungeon, /spellAreaPreviewSelected && previewBlastCenter && active/u)
  assert.match(dungeon, /effectRenderers=\{aimingEffectRenderers\}/u)
  assert.match(board, /onConfirmAiming\?: \(\) => void/u)
  assert.match(board3d, /latest\.current\.onConfirmAiming/u)
  assert.match(session, /target_ids: \[\.\.\.new Set\(target\.targetIds\)\]/u)
})
