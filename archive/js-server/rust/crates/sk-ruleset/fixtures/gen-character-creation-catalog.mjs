// Эталон server/character-creation-catalog.mjs: node gen-character-creation-catalog.mjs
import * as m from '../../../../server/character-creation-catalog.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('character-creation-catalog')
const rulesets = ['srd_5_2_1', 'dnd_5e_2014']
const rulesetArgs = [...rulesets, undefined, null, '', ' dnd_5e_2014 ', 'invented']

r.call('characterCreationOriginCatalogInfo', m.characterCreationOriginCatalogInfo)
for (const rulesetId of rulesetArgs) r.call('characterCreationPolicyFor', m.characterCreationPolicyFor, rulesetId)

const policies = Object.fromEntries(rulesets.map((rulesetId) => [rulesetId, m.characterCreationPolicyFor(rulesetId)]))
const speciesIds = [...new Set(Object.values(policies).flatMap((policy) => policy.species_options.map((option) => option.id)))]
const profileIds = [...new Set(Object.values(policies).flatMap((policy) => policy.origin_bonus_profiles.map((profile) => profile.id)))]

for (const [speciesId, rulesetId] of product([...speciesIds, 'unknown', '', null, undefined], rulesetArgs)) {
  r.call('speciesOptionFor', m.speciesOptionFor, speciesId, rulesetId)
  r.call('defaultSpeciesChoices', m.defaultSpeciesChoices, speciesId, rulesetId)
  r.call('speciesBenefitsFor', m.speciesBenefitsFor, speciesId, rulesetId)
}
for (const [profileId, rulesetId] of product([...profileIds, 'unknown', null], rulesetArgs.slice(0, 5))) {
  r.call('originBonusProfileFor', m.originBonusProfileFor, profileId, rulesetId)
}

// Выборы вида: по умолчанию, каждый вариант каждой группы, ошибки.
for (const rulesetId of rulesets) {
  for (const option of policies[rulesetId].species_options) {
    const groups = option.choice_groups ?? []
    const variants = [undefined, null, {}, [], 'choices', { unknown: ['x'] }, m.defaultSpeciesChoices(option.id, rulesetId)]
    for (const group of groups) {
      const count = Number(group.count ?? 0)
      for (let index = 0; index + count <= group.options.length; index += 1) {
        variants.push({ ...m.defaultSpeciesChoices(option.id, rulesetId), [group.id]: group.options.slice(index, index + count).map((entry) => entry.id) })
      }
      variants.push({ [group.id]: [] })
      variants.push({ [group.id]: [group.options[0]?.id, group.options[0]?.id].slice(0, Math.max(count, 2)) })
      variants.push({ [group.id]: ['not-an-option'] })
      variants.push({ [group.id]: 'string' })
      variants.push({ [group.id]: [null] })
      if (group.kind === 'language') variants.push({ [group.id]: [...(option.languages ?? []).slice(0, count)] })
    }
    for (const choices of variants) {
      r.call('resolveSpeciesChoices', m.resolveSpeciesChoices, option.id, choices, rulesetId)
      r.call('speciesBenefitsFor', m.speciesBenefitsFor, option.id, rulesetId, choices)
    }
  }
}
r.call('resolveSpeciesChoices', m.resolveSpeciesChoices, 'unknown', {}, 'dnd_5e_2014')
r.call('resolveSpeciesChoices', m.resolveSpeciesChoices, 'elf-high', {}, 'invented')

// Прибавки характеристик от вида.
const bonusSets = [
  undefined, null, {}, { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
  { con: 2, wis: 1 }, { con: 2, wis: 1, str: 0 }, { str: 2, con: 2 }, { cha: 2, str: 1, dex: 1 }, { cha: 2, str: 1, dex: 1, con: 1 },
  { cha: 2, cha2: 1 }, { cha: 3, str: 1 }, { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, { dex: 2, int: 1 }, { dex: 2, wis: 1 },
  { dex: 2, cha: 1 }, { str: 2, cha: 1 }, { int: 2, dex: 1 }, { int: 2, con: 1 }, { cha: 2, int: 1 }, { str: 2, con: 1 }, { dex: '2', int: '1' },
  { con: 2, wis: 1.0001 }, { con: 'x' },
]
for (const rulesetId of rulesetArgs.slice(0, 5)) {
  for (const option of policies['dnd_5e_2014'].species_options) {
    for (const bonuses of bonusSets) {
      r.call('validateSpeciesOriginBonuses', m.validateSpeciesOriginBonuses, option.id, option.bonus_profile_id, bonuses, rulesetId)
    }
    r.call('validateSpeciesOriginBonuses', m.validateSpeciesOriginBonuses, option.id, 'dwarf-mountain', { str: 2, con: 2 }, rulesetId)
    r.call('validateSpeciesOriginBonuses', m.validateSpeciesOriginBonuses, option.id, undefined, {}, rulesetId)
  }
  r.call('validateSpeciesOriginBonuses', m.validateSpeciesOriginBonuses, 'unknown', 'dwarf-hill', {}, rulesetId)
  r.call('validateSpeciesOriginBonuses', m.validateSpeciesOriginBonuses, 'human', 'none', {}, rulesetId)
}
r.write('character-creation-catalog.json')
