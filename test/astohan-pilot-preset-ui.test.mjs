import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
const wizard = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
test('готовый пилотный лист доступен только для свежего Асстохана уровня 7', () => {
  assert.match(app, /world_template_id.*astohan-plains/u)
  assert.match(app, /character_start_level === 7/u)
  assert.match(app, /characterSetupRequired === true/u)
  assert.match(wizard, /Готовый лист для первой партии/u)
  assert.match(wizard, /onApplyPilotBuild/u)
})
test('выбор пилотного листа проходит через staged character build commands', () => {
  assert.match(session, /stagedCommandsForPilotBuild/u)
  assert.match(session, /executeCharacterBuild\(commands\)/u)
  assert.doesNotMatch(wizard, /ImportCharacter|admin/u, 'пилотная кнопка не добавляет обходной импорт')
})
