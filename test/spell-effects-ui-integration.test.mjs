import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const boardSource = await readFile(new URL('../src/TacticalBoard.tsx', import.meta.url), 'utf8')
const appSource = (await Promise.all(['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n')
const typesSource = await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')

test('TacticalBoard рисует подтверждённые spell cues в RAF через общий canvas-слой', () => {
  const prepareIndex = boardSource.indexOf('const prepared = prepareEffectsContext()')
  const drawIndex = boardSource.indexOf('drawBoardEffects(context, scene, [', prepareIndex)
  assert.ok(prepareIndex >= 0, 'кадровый цикл должен подготовить overlay canvas')
  assert.ok(drawIndex > prepareIndex, 'эффект должен рисоваться после prepareEffectsContext')
  assert.match(boardSource, /const spellCue = isSpellAnimationCue\(activeAnimation\)/u)
  assert.match(boardSource, /createSpellEffectRenderer\(\{\s+cue: activeAnimation,\s+progress,\s+actors: animationActorsRef\.current/u)
  assert.match(boardSource, /budget\?\.recordFrame\(frameDurationMs\)/u)
})

test('reduced motion оставляет короткий статический акцент и не ломает бюджет пакета', () => {
  assert.match(boardSource, /const REDUCED_MOTION_SPELL_CUE_MS = 120/u)
  assert.match(boardSource, /spellCue && activeAnimation\.motion === 'reduced'/u)
  assert.match(boardSource, /reducedMotion: activeAnimation\.motion === 'reduced'/u)
})

test('App строит постоянные области, ауры и концентрацию из текущей проекции', () => {
  assert.match(appSource, /persistentSpellEffectsFromProjection\(\s+activeEffects,\s+state\.mechanics\?\.concentration \?\? \{\}/u)
  assert.match(appSource, /createPersistentSpellEffectsRenderer\(\s+persistentSpells,\s+animationActors/u)
  assert.match(appSource, /renderers\.push\(createPersistentSpellEffectsRenderer/u)
  assert.match(typesSource, /concentration\?: Record<string, \{ effect_id\?: string; source_rule_ids\?: string\[\] \}>/u)
})

test('постоянный и transient слои подключены к публичной точке drawBoardEffects', () => {
  assert.match(boardSource, /drawBoardEffects\(context, scene, effectRenderers \?\? \[\]\)/u)
  assert.match(boardSource, /drawBoardEffects\(context, scene, \[\s+createSpellEffectRenderer/u)
})
