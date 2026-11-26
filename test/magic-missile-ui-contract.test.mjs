import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')

test('панель Волшебной стрелы показывает число дротиков, а не число уникальных целей', () => {
  assert.match(source, /\{missileTargetIds\.length\}\/\{missileProjectileCount\} дротиков/u)
  assert.match(source, /missileSpell \? \[\.\.\.new Set\(missileTargetIds\)\]/u)
  assert.match(source, /removeMissileTarget\(index\)/u)
})

test('кнопка и Enter за один шаг отправляют полный набор дротиков', () => {
  assert.match(source, /missileTargetIds\.length === missileProjectileCount/u)
  assert.match(source, /className="missile-assignment-confirm" disabled=\{!missileCanCast\} onClick=\{castAssignedMissiles\}/u)
  assert.match(source, /if \(missileSpell\) \{\s+void castAssignedMissiles\(\)\s+return/u)
  assert.match(source, /await issueSpell\(\{ targetIds: spellTargetIds, missileTargetIds,/u)
  assert.match(source, /spellCommandInFlight\.current\) return false/u)
  assert.match(source, /if \(outcome\.ok && \(!missileScope \|\| currentMissileScope\.current === missileScope\)\) \{[\s\S]+?setMissileTargetIds\(\[\]\)[\s\S]+?setCombatMode\('weapon'\)/u)
})

test('обычная атака показывает одну карточку для наведённой и выбранной цели', () => {
  assert.match(source, /inspectedTarget\?\.id === pendingCommand\.targetId/u)
  assert.match(source, /pendingTarget && !inspectedPreparedAttack/u)
  assert.match(source, /inspectedPreparedAttack && <p className="attack-confirmation"/u)
})
