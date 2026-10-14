// Эталон server/ruleset-config.mjs, server/rules/core.mjs и
// server/rules/actors.mjs: node gen-ruleset-config.mjs
import * as config from '../../../../server/ruleset-config.mjs'
import * as core from '../../../../server/rules/core.mjs'
import * as actors from '../../../../server/rules/actors.mjs'
import { product, recorder } from './record.mjs'

{
  const r = recorder('ruleset-config')
  for (const name of [
    'DND_2014_RULESET_ID', 'LEGACY_DEFAULT_RULESET_ID', 'NEW_WORLD_DEFAULT_RULESET_ID', 'CLASS_RESOURCES_2024_POLICY_ID',
    'BG3_OPENING_STRIKE_HOUSE_RULE_ID', 'BG3_SPELL_HANDS_HOUSE_RULE_ID', 'DEFAULT_ON_HOUSE_RULE_IDS', 'TOGGLEABLE_HOUSE_RULES',
    'RULESET_PROFILES', 'INSTALLED_RULESET_IDS',
  ]) r.constant(name, config[name])
  r.call('publicRulesetProfiles', config.publicRulesetProfiles)

  const ids = ['dnd_5e_2014', 'srd_5_2_1', ' dnd_5e_2014 ', '\tsrd_5_2_1\n', '', '   ', null, undefined, 'invented', 'DND_5E_2014', 5, 'srd_5_2_1:x']
  const fallbacks = [undefined, null, 'srd_5_2_1', 'dnd_5e_2014', 'nope', '', ' srd_5_2_1 ']
  for (const [id, fallback, requireCreation] of product(ids, fallbacks, [undefined, false, true])) {
    const options = {}
    if (fallback !== undefined) options.fallback = fallback
    if (requireCreation !== undefined) options.requireCreation = requireCreation
    r.call('rulesetProfile', config.rulesetProfile, id, options)
    r.call('rulesetLock', config.rulesetLock, id, options)
  }
  const ruleIds = ['srd_5_2_1:combat:attack-roll', 'srd_5_2_1:', 'srd_5_2_1', 'dnd_5e_2014:combat:damage', 'house:high-ground', '', null, undefined, 'xsrd_5_2_1:a', 'srd_5_2_1:srd_5_2_1:a']
  const targets = ['dnd_5e_2014', 'srd_5_2_1', '', null, undefined, 'invented', ' dnd_5e_2014']
  for (const [ruleId, rulesetId] of product(ruleIds, targets)) r.call('rulesetRuleId', config.rulesetRuleId, ruleId, rulesetId)
  r.write('ruleset-config.json')
}

{
  const r = recorder('rules-core')
  r.constant('DEFAULT_RULESET_ID', core.DEFAULT_RULESET_ID)
  const states = [
    undefined, null, {}, { ruleset_id: null }, { ruleset_id: '' }, { ruleset_id: 'dnd_5e_2014' }, { ruleset_id: 'srd_5_2_1' },
    { ruleset_id: ' dnd_5e_2014' }, { ruleset_id: 2014 }, { ruleset_id: ['dnd_5e_2014'] }, 'dnd_5e_2014',
  ]
  for (const state of states) r.call('usesDnd2014', core.usesDnd2014, state)
  const values = [
    1, -3, 0, -0, '2', ' 3 ', '4.5', 4.5, null, undefined, true, false, '', 'abc', [], [7], ['8'], [1, 2], {}, 1e300,
    '0x10', '0b11', 'Infinity', 9007199254740991, -9007199254740991, 9007199254740992, '1e3', '.5', '5.', '+7', '-7',
  ]
  for (const [value, fallback] of product(values, [undefined, 0, 7, -1])) r.call('safeInteger', core.safeInteger, value, fallback)
  r.write('rules-core.json')
}

{
  const r = recorder('rules-actors')
  const actorSamples = [
    undefined, null, {}, { id: 'a' }, { id: '', actor_id: 'x' }, { id: null, actor_id: 'x' }, { actor_id: 'y' }, { id: 5 },
    { id: 'hero', hp: 10 }, { hp: '7' }, { hp: -4 }, { hp: 2.5 }, { hp: 3, alive: false }, { hp: 3, alive: null }, { hp: 0 },
    'string', 0, [], { id: { nested: true } },
  ]
  for (const actor of actorSamples) {
    r.call('actorId', actors.actorId, actor)
    r.call('actorHp', actors.actorHp, actor)
    r.call('isLivingActor', actors.isLivingActor, actor)
  }
  const states = [
    undefined, null, {},
    {
      players: [{ id: 'a', hp: 1, x: 1, y: 2 }, { id: 'b', x: null, y: 4 }, { id: '' }, { actor_id: 'p2', x: '3', y: '4' }],
      actors: [{ id: 'c', hp: 3, x: 1.5, y: 2 }, { id: 'a', hp: 9 }],
      enemies: [{ id: 'e', hp: 5, x: 7, y: 8 }, { actor_id: 'f', hp: 0, x: 0, y: 0 }, { id: 'c', hp: 4 }],
      mechanics: { positions: { a: { x: 10, y: null }, e: { x: '11', y: 12 }, ghost: { x: 1, y: 1 }, f: { x: 2.5, y: 1 } } },
    },
    { players: 'oops', actors: [{ id: 'solo', x: true, y: false }], enemies: [], mechanics: { positions: null } },
    { players: [{ id: 'z', x: [3], y: ' 9 ' }], mechanics: { positions: { z: { x: undefined } } } },
  ]
  const ids = ['a', 'b', 'c', 'e', 'f', 'p2', 'ghost', 'solo', 'z', '', 'missing']
  for (const state of states) {
    r.call('listActors', actors.listActors, state)
    for (const id of ids) {
      r.call('findActor', actors.findActor, state, id)
      r.call('isEnemyActor', actors.isEnemyActor, state, id)
      r.call('actorPosition', actors.actorPosition, state, id)
    }
  }
  r.write('rules-actors.json')
}
