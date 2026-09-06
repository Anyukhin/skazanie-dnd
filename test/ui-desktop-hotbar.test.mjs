import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { selectedAttackForecast } from '../src/desktop-ui.mjs'

const targets = {
  goblin: [
    { item_id: 'sword', attack_modifier: 5, average_damage: 7 },
    { item_id: 'bow', attack_modifier: 4, average_damage: 6 },
  ],
}

test('attack details exist only for a hovered or selected server target', () => {
  assert.equal(selectedAttackForecast(targets, null, 'sword'), null)
  assert.equal(selectedAttackForecast(targets, 'missing', 'sword'), null)
  assert.deepEqual(selectedAttackForecast(targets, 'goblin', 'bow'), targets.goblin[1])
  assert.deepEqual(selectedAttackForecast(targets, 'goblin', 'unknown'), targets.goblin[0])
})

test('wide hotbar lays out title, chips and readable detail at the requested thresholds', async () => {
  const [appSource, styles] = await Promise.all([
    Promise.all(['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
      .map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ])
  assert.match(appSource, /selectedAttackForecast\(\s*state\.combatForecast\?\.targets,/)
  assert.match(appSource, /inspectedForecast \? <i className="detail-chip forecast"/)
  assert.match(appSource, /selectedWeaponCombat\?\.damage/)
  assert.match(styles, /@media \(min-width: 1500px\)/)
  assert.match(styles, /@container hotbar-detail \(min-width: 400px\)/)
  assert.match(styles, /\.hotbar-detail \.detail-description \{[^}]*max-width: 70ch;[^}]*text-wrap: pretty;/)
  assert.doesNotMatch(styles, /\.hotbar-detail \.detail-description \{[^}]*columns: 2;/)
})

test('решение группы находится рядом с категориями, а пустая колонка действий не занимает место', async () => {
  const source = await readFile(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const header = source.slice(source.indexOf('<div className="hotbar-decks">'), source.indexOf('<div className="hotbar-main">'))
  assert.match(header, /Предметы/)
  assert.match(header, /<\/nav>\s*\{!combatActive && <button/)
  assert.match(header, /onClick=\{onLeaveLocation\}/)
  assert.match(header, /disabled=\{leaveLocationDisabled \|\| narrating \|\| tacticalBusy \|\| Boolean\(guardEncounter\)\}/)
  assert.match(header, /Решение группы/)
  assert.match(source, /\(combatActive \|\| showStartCombat \|\| doorsAtHand.length > 0 \|\| selectedSceneObject\) && <div className="hotbar-turn-controls">/)
  assert.doesNotMatch(source, /className="exploration-leave-location"/)
})
