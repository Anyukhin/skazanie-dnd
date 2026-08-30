import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { loadRulePack } from '../server/rule-pack.mjs'
import { RULE_IDS, normalizeCampaignState, validateCommand } from '../server/rules-engine.mjs'
import {
  INSTALLED_RULESET_IDS,
  LEGACY_DEFAULT_RULESET_ID,
  NEW_WORLD_DEFAULT_RULESET_ID,
  publicRulesetProfiles,
  rulesetLock,
  rulesetProfile,
  rulesetRuleId,
} from '../server/ruleset-config.mjs'

test('registry exposes exactly the selectable 2014 and 2024 profiles', () => {
  assert.deepEqual(INSTALLED_RULESET_IDS, ['dnd_5e_2014', 'srd_5_2_1'])
  assert.equal(NEW_WORLD_DEFAULT_RULESET_ID, 'dnd_5e_2014')
  assert.equal(LEGACY_DEFAULT_RULESET_ID, 'srd_5_2_1')
  assert.deepEqual(publicRulesetProfiles().map((profile) => [profile.id, profile.availability]), [
    ['dnd_5e_2014', 'preview'],
    ['srd_5_2_1', 'active'],
  ])
})

test('ruleset lock carries a version and one matching pack', () => {
  assert.deepEqual(rulesetLock('dnd_5e_2014'), {
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_rule_packs: ['dnd_5e_2014'],
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
  })
  assert.equal(rulesetProfile('srd_5_2_1').process_default_allowed, true)
  assert.throws(() => rulesetProfile('invented'), (error) => error.code === 'RULESET_INVALID')
})

test('legacy provenance IDs are remapped only for an installed target edition', () => {
  assert.equal(rulesetRuleId('srd_5_2_1:combat:attack-roll', 'dnd_5e_2014'), 'dnd_5e_2014:combat:attack-roll')
  assert.equal(rulesetRuleId('srd_5_2_1:combat:attack-roll', 'srd_5_2_1'), 'srd_5_2_1:combat:attack-roll')
  assert.equal(rulesetRuleId('house:high-ground', 'dnd_5e_2014'), 'house:high-ground')
})

test('every core Rules Engine provenance id has a 2014 counterpart', async () => {
  const pack = await loadRulePack('dnd_5e_2014')
  const installed = new Set(pack.rules.map((rule) => rule.id))
  for (const ruleId of new Set(Object.values(RULE_IDS))) {
    const mapped = rulesetRuleId(ruleId, 'dnd_5e_2014')
    assert.ok(installed.has(mapped), `${mapped} отсутствует в dnd_5e_2014`)
  }
})

test('a command cannot inject a rule id from another installed edition', () => {
  const state = normalizeCampaignState({
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'],
    players: [
      { id: 'hero', hp: 10, maxHp: 10, abilities: {}, inventory: [] },
      { id: 'target', hp: 10, maxHp: 10, abilities: {}, inventory: [] },
    ],
  })
  assert.throws(
    () => validateCommand({
      command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'target', amount: 1,
      source_rule_ids: ['dnd_5e_2014:combat:damage'],
    }, state, { isAdmin: true }),
    (error) => error.code === 'RULESET_RULE_ID_MISMATCH',
  )

  const classic = normalizeCampaignState({
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_rule_packs: ['dnd_5e_2014'],
    players: state.players,
  })
  assert.throws(
    () => validateCommand({
      command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'target', amount: 1,
      source_rule_ids: ['srd_5_2_1:combat:damage'],
    }, classic, { isAdmin: true }),
    (error) => error.code === 'RULESET_RULE_ID_MISMATCH',
  )
})

test('nested Rules Engine commands do not append edition-specific IDs by hand', () => {
  const source = readFileSync(new URL('../server/rules-engine.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /source_rule_ids:\s*\[\.\.\.new Set\(\[\.\.\.command\.source_rule_ids,\s*RULE_IDS/u,
    'nested commands must use commandWithRules so 2014 provenance is remapped',
  )
})
