import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pilotImportAlreadyStarted } from '../src/pilot-import-state.mjs'
const wizard = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
test('готовый пилотный лист доступен только для свежего Асстохана уровня 7', () => {
  assert.match(app, /world_template_id.*astohan-plains/u)
  assert.match(app, /character_start_level === 7/u)
  assert.match(app, /characterSetupRequired === true/u)
  assert.match(wizard, /Готовый лист для первой партии/u)
  assert.match(wizard, /onApplyPilotBuild/u)
  assert.match(wizard, /speciesLanguageIds/u)
})
test('выбор пилотного листа проходит через staged character build commands', () => {
  assert.match(session, /stagedCommandsForPilotBuild/u)
  assert.match(session, /executeCharacterBuild\(commands\)/u)
  assert.match(wizard, /deferDevelopment/u)
  assert.doesNotMatch(wizard, /ImportCharacter|admin/u, 'пилотная кнопка не добавляет обходной импорт')
})
test('fresh fighter slot is not mistaken for an imported pilot on retry', () => {
  const build = { class: 'fighter' }
  assert.equal(pilotImportAlreadyStarted({ character: 'Место героя 1', characterClass: 'fighter', characterSetupRequired: true, species: 'Не выбран', background: 'Не выбрано' }, build), false)
  assert.equal(pilotImportAlreadyStarted({ character: 'Борен', characterClass: 'fighter', characterSetupRequired: true, species: 'Человек', background: 'Солдат' }, build), true)
  assert.equal(pilotImportAlreadyStarted({ character: 'Борен', characterClass: 'barbarian', characterSetupRequired: true, species: 'Человек', background: 'Солдат' }, build), false)
})
