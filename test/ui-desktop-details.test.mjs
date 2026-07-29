import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ensureSceneWorldMemory } from '../server/scene-memory.mjs'
import {
  localizedQuestClockLabel,
  shouldAutoOpenCampaignModal,
} from '../src/desktop-ui.mjs'

test('new and legacy scene objective clocks are presented in Russian', () => {
  const memory = ensureSceneWorldMemory(undefined, {
    scene: { title: 'Перекрёсток', location: 'Старая дорога', objective: 'Найти след' },
    adventure: { chapter: 1 },
  })
  assert.equal(memory.quests[0].clock.label, 'Цель сцены')
  assert.equal(localizedQuestClockLabel('Scene objective'), 'Цель сцены')
  assert.equal(localizedQuestClockLabel('Цель сцены'), 'Цель сцены')
})

test('a requested room suppresses only the automatic campaign picker', () => {
  assert.equal(shouldAutoOpenCampaignModal({ heroCount: 0, membershipCount: 0 }), true)
  assert.equal(shouldAutoOpenCampaignModal({ heroCount: 0, membershipCount: 0, requestedRoom: 'WORLD-123' }), false)
  assert.equal(shouldAutoOpenCampaignModal({ heroCount: 1, membershipCount: 0 }), false)
})

test('desktop hero cards show server speed, while the objective remains fully expandable', async () => {
  const [appSource, styles] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ])
  assert.match(appSource, /player\.speed\} фт<\/b><small>СКОРОСТЬ/)
  assert.doesNotMatch(appSource, /player\.x\}:\{player\.y/)
  assert.match(appSource, /className=\{`objective \$\{objectiveExpanded \? 'expanded' : ''\}`\}/)
  assert.match(appSource, /aria-expanded=\{objectiveExpanded\}/)
  assert.match(appSource, /title=\{objective\}/)
  assert.match(appSource, /const roomLoaded = requestedRoom/)
  assert.doesNotMatch(appSource, /roomLoaded[\s\S]{0,220}state\.players\.length > 0/)
  assert.match(styles, /\.objective\.expanded strong \{[^}]*overflow: visible;[^}]*white-space: normal;/)
  assert.doesNotMatch(styles, /\.objective\.expanded strong \{[^}]*-webkit-line-clamp:/)
})
