import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommands,
} from '../../../../server/rules-engine.mjs'
import {
  characterCreationCatalog,
  createCharacterSlot,
  parseCharacterImport,
} from '../../../../server/character-lifecycle.mjs'
import { defaultSpeciesChoices } from '../../../../server/character-creation-catalog.mjs'
import { completeBackgroundChoicesForHero, defaultStarterEquipmentChoices } from '../../../../server/starter-kit.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { FileEventStore } from '../../../../server/event-store.mjs'

const rulesetId = 'dnd_5e_2014'
const catalog = characterCreationCatalog(rulesetId)
const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
const speciesId = 'human-variant'
const speciesChoices = defaultSpeciesChoices(speciesId, rulesetId)
const starterChoices = defaultStarterEquipmentChoices('fighter', rulesetId, { complete: true })
const baseHero = {
  id: 'hero',
  characterClass: 'fighter',
  backgroundId: 'sage',
  phbCreation: { schema_version: 1, classChoices: {} },
}

function documentFor(overrides = {}) {
  const abilityGeneration = {
    policyId: catalog.ability_policy.policy_id,
    policyVersion: catalog.ability_policy.policy_version,
    method: 'standard_array',
    baseScores,
    originBonusProfileId: speciesId,
    originBonuses: { str: 1, dex: 1, con: 0, int: 0, wis: 0, cha: 0 },
    speciesOptionId: speciesId,
  }
  const character = {
    character: 'Пробный герой',
    name: 'Проба',
    characterClass: 'fighter',
    level: 1,
    experience: 0,
    species: 'Вариантный человек',
    abilities: { str: 16, dex: 15, con: 13, int: 12, wis: 10, cha: 8 },
    abilityGeneration,
    baseSpeed: 30,
    classSkillProficiencies: ['athletics', 'perception'],
    selectedFeatureIds: ['fighting-style-defense'],
    knownSpellIds: [],
    preparedSpellIds: [],
    hitPointIncreases: [],
    backgroundId: 'sage',
    backgroundChoices: { tools: [], languages: ['giant', 'gnomish'], replacementSkills: [], replacementTools: [] },
    speciesChoices,
    starterEquipmentChoices: starterChoices,
    phbCreation: {
      schema_version: 1,
      classChoices: {},
      feat: { id: 'tough', choices: {} },
      backgroundEquipmentChoices: completeBackgroundChoicesForHero(baseHero),
    },
    ...overrides,
  }
  return { schema: 'skazanie.character', schema_version: 1, character }
}

const initial = normalizeCampaignState({
  sessionCode: 'CHARACTER-PROBE',
  ruleset_id: rulesetId,
  partyMemberIds: ['hero'],
  players: [createCharacterSlot({ id: 'hero' })],
})
const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: (() => { let n = 0; return () => `probe-${++n}` })() })

const result = resolveCommands([
  { command_type: 'ImportCharacter', actor_id: 'hero', document: documentFor() },
], initial, { diceService: dice, context: { allowedActorIds: ['hero'] } })
assert.equal(result.state.players[0].creationBenefits.feat.id, 'tough')
assert.equal(result.state.players[0].characterSheet.hit_points.value, 13)
assert.deepEqual(replayEvents(initial, result.events), result.state)

const customBackground = documentFor({
  background: 'Своя предыстория',
  backgroundChoices: {
    tools: [],
    languages: ['giant', 'gnomish'],
    replacementSkills: ['stealth'],
    replacementTools: [],
    customization: {
      name: 'Своя предыстория',
      skills: ['animal_handling', 'acrobatics'],
      toolCount: 0,
      featureBackgroundId: 'sage',
    },
  },
})
const customParsed = parseCharacterImport(customBackground, { rulesetId })
assert.equal(customParsed.patch.background, 'Своя предыстория')
const customResult = resolveCommands([
  { command_type: 'ImportCharacter', actor_id: 'hero', document: customBackground },
], initial, { diceService: dice, context: { allowedActorIds: ['hero'] } })
assert.ok(customResult.state.players[0].backgroundSkillProficiencies.includes('animal_handling'))
assert.ok(customResult.state.players[0].backgroundSkillProficiencies.includes('acrobatics'))
assert.deepEqual(replayEvents(initial, customResult.events), customResult.state)

assert.throws(
  () => parseCharacterImport(documentFor({ hp: 999 }), { rulesetId }),
  (error) => error.code === 'IMPORT_UNKNOWN_FIELD',
)
assert.throws(
  () => parseCharacterImport(documentFor({ abilities: { str: 30, dex: 30, con: 30, int: 30, wis: 30, cha: 30 } }), { rulesetId }),
  (error) => error.code === 'IMPORT_ABILITY_BUDGET_INVALID',
)

const rootDir = await mkdtemp(join(tmpdir(), 'skazanie-character-probe-'))
try {
  const storeOptions = { rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 0 }
  const store = new FileEventStore(storeOptions)
  await store.initializeCampaign({ campaign_id: initial.sessionCode, initial_state: initial, ruleset_id: rulesetId })
  const committed = await store.commit({
    campaign_id: initial.sessionCode,
    expected_state_version: 0,
    idempotency_key: 'character-probe-import',
    events: result.events,
  })
  const duplicate = await store.commit({
    campaign_id: initial.sessionCode,
    expected_state_version: 0,
    idempotency_key: 'character-probe-import',
    events: result.events,
  })
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, committed.state)
  const reopenedStore = new FileEventStore(storeOptions)
  const reopened = await reopenedStore.replay(initial.sessionCode, { use_snapshots: false })
  assert.deepEqual(reopened.state, committed.state)
} finally {
  await rm(rootDir, { recursive: true, force: true })
}

console.log(JSON.stringify({
  direct: {
    import: 'accepted',
    derived_hp_from_server_rules: true,
    forged_field_rejected: true,
    forged_ability_budget: 'rejected',
    replay: 'equal',
  },
  event_store: { duplicate: true, reopen_replay: 'equal' },
}))
