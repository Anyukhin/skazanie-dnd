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
    Promise.all(['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
      .map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ])
  assert.match(appSource, /selectedAttackForecast\(\s*state\.combatForecast\?\.targets,/)
  assert.match(appSource, /inspectedForecast \? <i className="detail-chip forecast"/)
  assert.match(appSource, /selectedItem\?\.combat\?\.damage/)
  assert.match(styles, /@media \(min-width: 1500px\)/)
  assert.match(styles, /@container hotbar-detail \(min-width: 400px\)/)
  assert.match(styles, /\.hotbar-detail \.detail-description \{[^}]*columns: 2;/)
})

test('строка исследования не рендерится пустой и всегда несёт выход из локации', async () => {
  // Прежний сторож требовал, чтобы коробка не появлялась без кнопки боя. Смысл
  // остался тот же — пустой полосы отступов быть не должно, — но безусловное
  // содержимое теперь другое: уйти из локации нужно как раз тогда, когда в сцене
  // не осталось ни одного противника и кнопки боя нет.
  const appSource = (await Promise.all(['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n')
  const row = appSource.match(/\{!combatActive && <div className="hotbar-controls-row">[\s\S]*?<\/div>\}/)
  assert.ok(row, 'строка исследования обязана рендериться только вне боя')
  assert.match(row[0], /<button\s+className="exploration-leave-location"/)
  assert.match(row[0], /\{showStartCombat && <button className="exploration-start-combat"/)
})
