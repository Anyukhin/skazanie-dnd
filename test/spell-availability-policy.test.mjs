import assert from 'node:assert/strict'
import test from 'node:test'

import { isClassSpellAvailable } from '../server/character-creation-feats.mjs'
import { validateCharacterBuildCommand } from '../server/character-build.mjs'
import { combatSpellsFor } from '../server/combat-spells.mjs'

const creationWizard = {
  id: 'wizard',
  characterClass: 'wizard',
  level: 2,
  abilities: { int: 16 },
  knownSpellIds: [],
  preparedSpellIds: [],
  creationBenefits: { expanded_spells: [], domain_spells: [] },
}

test('каталог PHB и проверка листа одинаково отклоняют недоступное заклинание', () => {
  const absorbElements = { id: 'absorb-elements', level: 1, classes: ['wizard'] }
  assert.equal(isClassSpellAvailable(absorbElements, 'wizard', creationWizard), false)
  assert.equal(combatSpellsFor(creationWizard).some((spell) => spell.id === 'absorb-elements'), false)
  assert.throws(
    () => validateCharacterBuildCommand({
      command_type: 'SetSpellSelections', actor_id: 'wizard', known_spell_ids: ['absorb-elements'], prepared_spell_ids: [],
    }, { players: [creationWizard] }, { allowedActorIds: ['wizard'] }),
    (error) => error?.code === 'SPELL_SELECTION_NOT_ALLOWED',
  )
})

test('расширенный список PHB и прежние герои сохраняют доступность заклинаний', () => {
  const expanded = { ...creationWizard, creationBenefits: { expanded_spells: ['absorb-elements'] } }
  assert.equal(isClassSpellAvailable({ id: 'absorb-elements', level: 1, classes: ['wizard'] }, 'wizard', expanded), true)
  assert.equal(combatSpellsFor(expanded).some((spell) => spell.id === 'absorb-elements'), true)

  const legacy = { ...creationWizard, creationBenefits: undefined }
  assert.equal(isClassSpellAvailable({ id: 'absorb-elements', level: 1, classes: ['wizard'] }, 'wizard', legacy), true)
  assert.equal(combatSpellsFor(legacy).some((spell) => spell.id === 'absorb-elements'), true)
})
