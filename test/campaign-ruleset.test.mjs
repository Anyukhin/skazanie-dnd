import assert from 'node:assert/strict'
import test from 'node:test'

import {
  campaignRulesetCanChange,
  campaignRulesetChangeEvent,
  campaignRulesetMetadata,
  campaignRulesetSettings,
} from '../server/campaign-ruleset.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'

const state = () => normalizeCampaignState({
  sessionCode: 'RULESET-CHOICE',
  ruleset_id: 'srd_5_2_1',
  ruleset_version: '5.2.1',
  enabled_rule_packs: ['srd_5_2_1'],
  players: [],
})

test('ruleset selection is an additive replayable event before gameplay', () => {
  const before = state()
  const event = campaignRulesetChangeEvent('dnd_5e_2014', before, [], {
    actorId: 'owner',
    now: '2026-08-30T12:00:00.000Z',
  })
  assert.equal(event.event_schema_version, 1)
  assert.deepEqual(campaignRulesetMetadata(event), {
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_rule_packs: ['dnd_5e_2014'],
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
  })
  const after = applyGameEvent(before, event)
  assert.equal(after.ruleset_id, 'dnd_5e_2014')
  assert.equal(after.ruleset_version, '2014.1.0')
  assert.deepEqual(after.enabled_rule_packs, ['dnd_5e_2014'])
  assert.deepEqual(after.enabled_house_rules, ['skazanie:2014-preview-legacy-catalogs-v1'])
  assert.deepEqual(replayEvents(before, [event]), after)
})

test('only ruleset events may precede another pre-game switch', () => {
  const first = campaignRulesetChangeEvent('dnd_5e_2014', state(), [])
  assert.equal(campaignRulesetCanChange([first]).allowed, true)
  assert.equal(campaignRulesetChangeEvent('srd_5_2_1', applyGameEvent(state(), first), [first]).payload.ruleset_id_after, 'srd_5_2_1')

  const gameplay = { event_type: 'CharacterImported' }
  assert.equal(campaignRulesetCanChange([first, gameplay]).allowed, false)
  assert.throws(
    () => campaignRulesetChangeEvent('srd_5_2_1', applyGameEvent(state(), first), [first, gameplay]),
    (error) => error.code === 'CAMPAIGN_RULESET_LOCKED',
  )
})

test('settings expose both profiles but management and event history control the selector', () => {
  const open = campaignRulesetSettings(state(), [], { canManage: true })
  assert.equal(open.current.id, 'srd_5_2_1')
  assert.equal(open.canChange, true)
  assert.deepEqual(open.available.map((entry) => entry.id), ['dnd_5e_2014', 'srd_5_2_1'])

  const guest = campaignRulesetSettings(state(), [], { canManage: false })
  assert.equal(guest.canChange, false)
  assert.equal(guest.locked, false)

  const locked = campaignRulesetSettings(state(), [{ event_type: 'DamageApplied' }], { canManage: true })
  assert.equal(locked.canChange, false)
  assert.equal(locked.locked, true)
  assert.match(locked.lockReason, /DamageApplied/u)

  const imported = campaignRulesetSettings({ ...state(), ruleset_selection_locked: true }, [], { canManage: true })
  assert.equal(imported.canChange, false)
  assert.equal(imported.locked, true)
  assert.match(imported.lockReason, /импорте/u)
  assert.throws(
    () => campaignRulesetChangeEvent('dnd_5e_2014', { ...state(), ruleset_selection_locked: true }, []),
    (error) => error.code === 'CAMPAIGN_RULESET_LOCKED',
  )
})
