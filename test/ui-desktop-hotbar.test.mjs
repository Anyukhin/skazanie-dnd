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

test('wide hotbar lays out title, chips and two-column detail at the requested thresholds', async () => {
  const [appSource, styles] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ])
  assert.match(appSource, /selectedAttackForecast\(\s*state\.combatForecast\?\.targets,/)
  assert.match(appSource, /inspectedForecast \? <i className="detail-chip forecast"/)
  assert.match(appSource, /selectedItem\?\.combat\?\.damage/)
  assert.match(styles, /@media \(min-width: 1500px\)/)
  assert.match(styles, /@container hotbar-detail \(min-width: 400px\)/)
  assert.match(styles, /\.hotbar-detail \.detail-description \{[^}]*columns: 2;/)
})

test('the exploration controls wrapper cannot render without its start-combat button', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(appSource, /\{showStartCombat && !combatActive && <div className="hotbar-controls-row">[\s\S]*?<button className="exploration-start-combat"[\s\S]*?<\/div>\}/)
})
