// Подготовленные заклинания волшебника переживают создание героя (план
// Асстохана, 1.7): то, что игрок выбрал в мастере, остаётся у героя после
// импорта, после развития до стартового уровня и после перезапуска сервера.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SLOT = 'hero-slot-1'

function wizardDocument(selection) {
  const baseScores = { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Мира', name: 'Игрок', characterClass: 'wizard', species: 'Человек', level: 1, experience: 0,
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array', policyVersion: 1, method: 'standard_array',
        baseScores, originBonusProfileId: 'none', originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['arcana', 'history'], selectedFeatureIds: [],
      ...selection,
    },
  }
}

const hero = (state) => state.players.find((player) => player.id === SLOT)

test('подготовленные заклинания волшебника остаются после создания героя', { timeout: runnerTimeout(120_000) }, async (t) => {
  const server = await startTestServer(t)
  const { client: admin } = await setupAdmin(server)
  const code = 'WIZARD-PREP'
  await createCampaign(admin, { code, bootstrap: { slotCount: 1, startLevel: 2 } })
  const health = expectStatus(await admin.get('/api/health'))
  const rules = health.characterCreation.classes.find((entry) => entry.id === 'wizard').spell_selection
  const cantrips = rules.spells.filter((spell) => spell.level === 0).slice(0, rules.cantrips).map((spell) => spell.id)
  const book = rules.spells.filter((spell) => spell.level === 1).slice(0, rules.spellbookMinimum).map((spell) => spell.id)
  const prepared = book.slice(0, Math.min(rules.preparedLimit, book.length))
  assert.ok(prepared.length > 0, JSON.stringify({ ...rules, spells: rules.spells.length }))

  const imported = expectStatus(await sendCommand(admin, code, 'wizard-import', {
    command_type: 'ImportCharacter', actor_id: SLOT, document: wizardDocument({ knownSpellIds: [...cantrips, ...book], preparedSpellIds: prepared }),
  }))
  assert.deepEqual(hero(imported.authoritative_state).preparedSpellIds, prepared, 'сразу после импорта')

  const loaded = expectStatus(await admin.get(`/api/rooms/${code}`))
  assert.deepEqual(hero(loaded.state ?? loaded).preparedSpellIds, prepared, 'после чтения кампании')

  await server.restart()
  const reloaded = expectStatus(await admin.get(`/api/rooms/${code}`))
  assert.deepEqual(hero(reloaded.state ?? reloaded).preparedSpellIds, prepared, 'после перезапуска сервера')

  // Развитие до стартового уровня подготовку не трогает: её меняет только
  // сам игрок командой SetSpellSelections.
  const raised = expectStatus(await sendCommand(admin, code, 'wizard-level-2', { command_type: 'LevelUp', actor_id: SLOT, expected_level: 1 }))
  assert.equal(hero(raised.authoritative_state).level, 2)
  assert.deepEqual(hero(raised.authoritative_state).preparedSpellIds, prepared, 'после повышения уровня')
})
