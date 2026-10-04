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

test('решение группы и начало боя — в «Отдых и режимы», переговоры — плиткой действия', async () => {
  const source = await readFile(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const header = source.slice(source.indexOf('<div className="hotbar-decks">'), source.indexOf('<div className="hotbar-main">'))
  assert.match(header, /Предметы/)
  assert.match(header, /className="hotbar-combat-controls"/)
  // Макет исследования (холст, Room): решение группы и начало боя — значками
  // в «Отдых и режимы» колонки хода, а не кнопками в ряду вкладок.
  assert.doesNotMatch(header, /onLeaveLocation|onStartCombat/)
  const modes = source.slice(source.indexOf('<div className="hud-modes"'), source.indexOf('className="hud-purse"'))
  assert.match(modes, /className="hud-mode group-decision-button"/)
  assert.match(modes, /onClick=\{onLeaveLocation\}/)
  assert.match(modes, /disabled=\{leaveLocationDisabled \|\| narrating \|\| tacticalBusy \|\| Boolean\(guardEncounter\)\}/)
  assert.match(modes, /Решение группы/)
  assert.match(modes, /showStartCombat && <button[^>]*className="hud-mode start-combat-button"[^>]*onClick=\{onStartCombat\}/)
  // Завершение хода живёт в правой колонке панели — рядом с ресурсами хода,
  // как в прототипе стола, а не в ряду колод.
  assert.doesNotMatch(header, /onClick=\{onFinishTurn\}/)
  const side = source.slice(source.indexOf('<aside className="turn-rail-side"'), source.indexOf('</aside>', source.indexOf('<aside className="turn-rail-side"')))
  assert.match(side, /className=\{`end-turn-hotbar/)
  assert.match(side, /onClick=\{onFinishTurn\}/)
  // Раскладка BG3 (2026-10-04): остаток движения — кольцом вокруг кнопки хода,
  // реакции — рядом с ней; камни действия, бонуса и реакции переехали в лоток
  // над плитками, где по щелчку фильтруют панель.
  assert.match(side, /className="end-turn-ring"/)
  assert.match(side, /className="hud-reactions"/)
  const tray = source.slice(source.indexOf('<div className="hud-tray"'), source.indexOf('<div className="hotbar-decks">'))
  assert.match(tray, /className="hero-cluster-pips"/)
  assert.match(tray, /<SpellSlotBar/)
  assert.doesNotMatch(header, /<SpellSlotBar/, 'ячейки по кругам живут в лотке, а не в ряду вкладок')
  // Макет боя: переговоры — плиткой среди действий, цена — действие.
  assert.match(source, /id: 'propose-parley', cost: 'action', section: 'action', node: <button className="action-tile parley-hotbar"[^\n]*onProposeParley\('persuasion'\)/)
  assert.match(source, /doorsAtHand\.some\(\(door\) => door\.state === 'locked'\) && <div className="hotbar-turn-controls">/)
  assert.doesNotMatch(source, /selectedSceneObjectVerbs\.map/u, 'действия объекта переехали в контекстное меню карты')
  assert.doesNotMatch(source, /className="exploration-leave-location"/)
})
