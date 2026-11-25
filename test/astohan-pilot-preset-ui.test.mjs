import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pilotImportAlreadyStarted } from '../src/pilot-import-state.mjs'
import { astohanPilotBuildCatalog } from '../server/astohan-pilot-builds.mjs'
import { applyCharacterLifecycleEvent, characterCreationCatalog, characterImportEvent, createCharacterSlot, validateCharacterImportCommand } from '../server/character-lifecycle.mjs'
import { pilotImportDocument } from './kit/astohan-pilot.mjs'
const wizard = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
test('готовый пилотный лист доступен только для свежего Асстохана уровня 7', () => {
  assert.match(app, /world_template_id.*astohan-plains/u)
  assert.match(app, /character_start_level === astohanPilotTargetLevel/u)
  assert.match(app, /characterSetupRequired === true/u)
  assert.match(wizard, /Готовый лист для первой партии/u)
  assert.match(wizard, /onApplyPilotBuild/u)
  assert.match(wizard, /pilotCreationChoicesFor/u)
})

test('итог готового листа показывает целевой уровень без промежуточных характеристик', () => {
  const review = wizard.slice(wizard.indexOf('className="creation-review-sheet"'))
  assert.match(review, /selectedPilotBuild[\s\S]*?\$\{astohanPilotTargetLevel\}-й уровень/u)
  assert.match(review, /!selectedPilotBuild && <dl className="creation-review-vitals"/u)
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
test('catalog-driven choices make all four pilot imports valid', () => {
  const catalog = characterCreationCatalog('dnd_5e_2014')
  for (const recipe of astohanPilotBuildCatalog().builds) {
    const document = pilotImportDocument(catalog, recipe, `Проверка ${recipe.id}`)
    const actorId = `${recipe.id}-import-check`
    const state = { ruleset_id: 'dnd_5e_2014', character_start_level: 7, players: [createCharacterSlot({ id: actorId })], mechanics: { combat: { active: false } } }
    const command = validateCharacterImportCommand({ command_type: 'ImportCharacter', actor_id: actorId, document }, state, { allowedActorIds: [actorId] })
    const afterImport = applyCharacterLifecycleEvent(state, characterImportEvent(command))
    assert.equal(afterImport.players[0].characterSetupRequired, true, recipe.id)
    assert.equal(afterImport.players[0].characterSetupStage, 'leveling', recipe.id)
  }
})
