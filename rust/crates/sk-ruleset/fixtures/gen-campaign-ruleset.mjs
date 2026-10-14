// Эталон server/campaign-ruleset.mjs: node gen-campaign-ruleset.mjs
import * as m from '../../../../server/campaign-ruleset.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('campaign-ruleset')
const NOW = '2026-10-13T12:00:00.000Z'

const states = [
  undefined,
  null,
  {},
  { ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], enabled_house_rules: ['skazanie:class-resources-2024-v1'] },
  { ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_rule_packs: ['dnd_5e_2014'], enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1', 'house:bg3-opening-strike'] },
  { ruleset_id: 'dnd_5e_2014', enabled_house_rules: ['house:bg3-opening-strike', 'house:bg3-spell-hands', 'house:custom'] },
  { ruleset_id: '', ruleset_version: 0, enabled_house_rules: [null, 5, 'house:bg3-spell-hands'] },
  { ruleset_id: null, ruleset_version: 7, enabled_rule_packs: 'srd', enabled_house_rules: 'house:bg3-opening-strike' },
  { ruleset_id: 'srd_5_2_1', ruleset_selection_locked: true },
  { ruleset_id: 'srd_5_2_1', ruleset_selection_locked: 'yes', mechanics: { combat: { active: true } } },
  { ruleset_id: 'srd_5_2_1', enabled_house_rules: ['house:bg3-opening-strike'], mechanics: { combat: { active: true } } },
  { ruleset_id: 'srd_5_2_1', enabled_house_rules: [], mechanics: { combat: { active: 'true' } } },
  { ruleset_id: 'invented' },
  { ruleset_id: ' dnd_5e_2014 ', ruleset_version: '' },
]

const eventLists = [
  undefined,
  [],
  [{ event_type: 'CampaignRulesetChanged' }],
  [{ event_type: 'CampaignRulesetChanged' }, { event_type: 'CharacterImported' }],
  [{ event_type: 'DamageApplied' }],
  [{}],
  [null],
  [null, { event_type: 'DamageApplied' }],
  [0, { event_type: 'X' }],
  ['text'],
  [{ event_type: null }],
  [{ event_type: 5 }],
  'not-an-array',
]

for (const [events, state] of product(eventLists, states)) r.call('campaignRulesetCanChange', m.campaignRulesetCanChange, events, state)
for (const [state, events, canManage] of product(states, eventLists.slice(0, 6), [true, false])) {
  r.call('campaignRulesetSettings', m.campaignRulesetSettings, state, events, { canManage })
}
for (const state of states) r.call('campaignHouseRuleSettings', m.campaignHouseRuleSettings, state)

const houseRules = ['house:bg3-opening-strike', 'house:bg3-spell-hands', 'skazanie:2014-preview-legacy-catalogs-v1', '', null, undefined, 'house:unknown']
const enabledValues = [true, false, 'yes', null, undefined, 1]
for (const [rule, enabled, state, actorId] of product(houseRules, enabledValues, states, [undefined, 'owner'])) {
  const options = { now: NOW }
  if (actorId !== undefined) options.actorId = actorId
  r.call('campaignHouseRuleChangeEvent', m.campaignHouseRuleChangeEvent, rule, enabled, state, options)
}

const histories = [
  undefined,
  [],
  [{ event_type: 'CampaignHouseRuleChanged', payload: { house_rule_id: 'house:bg3-opening-strike' } }],
  [{ event_type: 'CampaignHouseRuleChanged', payload: { house_rule_id: 'house:bg3-spell-hands' } }],
  [{ event_type: 'CampaignHouseRuleChanged' }, null, { event_type: 'Other', payload: { house_rule_id: 'house:bg3-opening-strike' } }],
  'nope',
]
for (const [rule, state, history] of product(houseRules, states, histories)) {
  r.call('defaultHouseRuleEvent', m.defaultHouseRuleEvent, rule, state, history, { now: NOW })
}

const requested = ['dnd_5e_2014', 'srd_5_2_1', ' dnd_5e_2014 ', '', null, undefined, 'invented']
for (const [ruleset, state, events, actorId] of product(requested, states, [...eventLists.slice(0, 4), [null], [{}], "text"], [undefined, "owner"])) {
  const options = { now: NOW }
  if (actorId !== undefined) options.actorId = actorId
  r.call('campaignRulesetChangeEvent', m.campaignRulesetChangeEvent, ruleset, state, events, options)
}

const metadataEvents = [
  undefined,
  null,
  {},
  { event_type: 'Other' },
  { event_type: 'CampaignHouseRuleChanged', payload: { enabled_house_rules_after: ['a', 'b'] } },
  { event_type: 'CampaignHouseRuleChanged', payload: { enabled_house_rules_after: 'ab' } },
  { event_type: 'CampaignRulesetChanged', payload: { ruleset_id_after: 'dnd_5e_2014', ruleset_version_after: '2014.1.0', enabled_rule_packs_after: ['dnd_5e_2014'], enabled_house_rules_after: [] } },
  { event_type: 'CampaignRulesetChanged', payload: { enabled_rule_packs_after: [], enabled_house_rules_after: ['x'] } },
  { event_type: 'CampaignRulesetChanged', payload: { ruleset_id_after: null, enabled_rule_packs_after: [], enabled_house_rules_after: [] } },
]
for (const event of metadataEvents) {
  r.call('campaignHouseRuleMetadata', m.campaignHouseRuleMetadata, event)
  r.call('campaignRulesetMetadata', m.campaignRulesetMetadata, event)
}
r.write('campaign-ruleset.json')
