import assert from 'node:assert/strict'
import test from 'node:test'

import {
  campaignHouseRuleChangeEvent,
  campaignHouseRuleMetadata,
  campaignHouseRuleSettings,
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
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1', 'house:bg3-opening-strike'],
  })
  const after = applyGameEvent(before, event)
  assert.equal(after.ruleset_id, 'dnd_5e_2014')
  assert.equal(after.ruleset_version, '2014.1.0')
  assert.deepEqual(after.enabled_rule_packs, ['dnd_5e_2014'])
  assert.deepEqual(after.enabled_house_rules, ['skazanie:2014-preview-legacy-catalogs-v1', 'house:bg3-opening-strike'])
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

test('ведущий переключает домашнее правило BG3 событием, replay сходится', () => {
  const before = normalizeCampaignState({ ...state(), enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'] })
  assert.equal(campaignHouseRuleSettings(before).find((rule) => rule.id === 'house:bg3-opening-strike').enabled, false)
  const event = campaignHouseRuleChangeEvent('house:bg3-opening-strike', true, before, { actorId: 'owner', now: '2026-10-04T12:00:00.000Z' })
  assert.equal(event.house_rule_id, 'house:bg3-opening-strike', 'отступление от редакции помечено явно')
  assert.deepEqual(campaignHouseRuleMetadata(event), { enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1', 'house:bg3-opening-strike'] })
  const after = applyGameEvent(before, event)
  assert.ok(after.enabled_house_rules.includes('house:bg3-opening-strike'))
  assert.deepEqual(replayEvents(before, [event]).enabled_house_rules, after.enabled_house_rules)
  assert.equal(campaignHouseRuleChangeEvent('house:bg3-opening-strike', true, after), null, 'повтор без изменения событий не даёт')
  const off = applyGameEvent(after, campaignHouseRuleChangeEvent('house:bg3-opening-strike', false, after))
  assert.ok(!off.enabled_house_rules.includes('house:bg3-opening-strike'))
})

test('переключить можно только объявленное правило и не посреди боя', () => {
  const base = normalizeCampaignState(state())
  assert.throws(() => campaignHouseRuleChangeEvent('skazanie:2014-preview-legacy-catalogs-v1', false, base), { code: 'HOUSE_RULE_NOT_TOGGLEABLE' })
  assert.throws(() => campaignHouseRuleChangeEvent('house:bg3-opening-strike', 'yes', base), { code: 'HOUSE_RULE_VALUE_INVALID' })
  const fighting = normalizeCampaignState({ ...state(), mechanics: { ...base.mechanics, combat: { ...base.mechanics.combat, active: true } } })
  assert.throws(() => campaignHouseRuleChangeEvent('house:bg3-opening-strike', true, fighting), { code: 'HOUSE_RULE_DURING_COMBAT' })
})
