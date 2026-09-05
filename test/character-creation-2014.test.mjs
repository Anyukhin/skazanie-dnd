import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyCharacterLifecycleEvent,
  characterCreationCatalog,
  characterImportEvent,
  parseCharacterImport,
  validateCharacterImportCommand,
} from '../server/character-lifecycle.mjs'
import { backgroundBenefits } from '../server/backgrounds.mjs'
import {
  defaultSpeciesChoices,
  resolveSpeciesChoices,
  speciesBenefitsFor,
} from '../server/character-creation-catalog.mjs'
import { combatSpellsFor } from '../server/combat-spells.mjs'
import { withStarterKit } from '../server/starter-kit.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'

const RULESET_ID = 'dnd_5e_2014'

test('все эльфы владеют Восприятием, а дроу не получают дополнительный язык автоматически', () => {
  for (const id of ['elf-high', 'elf-wood', 'elf-drow']) {
    const benefits = speciesBenefitsFor(id, RULESET_ID, defaultSpeciesChoices(id, RULESET_ID))
    assert.ok(benefits.skill_proficiencies.includes('perception'), id)
  }
  assert.deepEqual(speciesBenefitsFor('elf-drow', RULESET_ID, {}).languages, ['common', 'elvish'])
})

test('все 2184 сочетания расы, класса и предыстории собираются без потери навыков и языков', () => {
  const catalog = characterCreationCatalog(RULESET_ID)
  const skillIds = [...new Set(catalog.classes.flatMap((entry) => entry.class_skills.options.map((skill) => skill.id)))]
  let checked = 0
  for (const species of catalog.ability_policy.species_options) {
    const profile = catalog.ability_policy.origin_bonus_profiles.find((entry) => entry.id === species.bonus_profile_id)
    const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
    const originBonuses = Object.fromEntries(Object.keys(baseScores).map((ability) => [ability, profile.fixed_bonuses?.[ability] ?? 0]))
    for (const ability of Object.keys(baseScores).filter((ability) => !(profile.excluded_choices ?? []).includes(ability)).slice(0, profile.choice_count ?? 0)) originBonuses[ability] += profile.choice_amount
    const abilities = Object.fromEntries(Object.entries(baseScores).map(([ability, score]) => [ability, score + originBonuses[ability]]))
    const speciesChoices = defaultSpeciesChoices(species.id, RULESET_ID)
    const benefits = speciesBenefitsFor(species.id, RULESET_ID, speciesChoices)
    for (const klass of catalog.classes) for (const background of catalog.backgrounds.options) {
      const classSkills = klass.class_skills.options.slice(0, klass.class_skills.choice_count).map((entry) => entry.id)
      const granted = [...classSkills, ...benefits.skill_proficiencies, ...background.skillProficiencies]
      const unique = new Set(granted)
      const replacementSkills = skillIds.filter((id) => !unique.has(id)).slice(0, granted.length - unique.size)
      const spells = klass.spell_selection
      const cantrips = spells?.spells.filter((spell) => spell.level === 0).slice(0, spells.cantrips).map((spell) => spell.id) ?? []
      const knownCount = spells?.mode === 'spellbook' ? spells.spellbookMinimum : spells?.mode === 'known' ? spells.spellsKnown : 0
      const known = spells?.spells.filter((spell) => spell.level === 1).slice(0, knownCount).map((spell) => spell.id) ?? []
      const document = classicFighter({
        characterClass: klass.id, role: klass.label, species: species.label, baseSpeed: species.base_speed,
        subclass: klass.subclass_level === 1 ? klass.subclasses[0].name : undefined,
        speciesChoices, abilities,
        abilityGeneration: { policyId: catalog.ability_policy.policy_id, policyVersion: catalog.ability_policy.policy_version, method: 'standard_array', baseScores, originBonuses, originBonusProfileId: profile.id, speciesOptionId: species.id },
        classSkillProficiencies: classSkills,
        selectedFeatureIds: klass.feature_choice_groups.flatMap((group) => group.options.slice(0, group.choiceCount).map((entry) => entry.id)),
        knownSpellIds: [...cantrips, ...known], preparedSpellIds: [],
        backgroundId: background.id, background: background.name,
        backgroundChoices: {
          tools: (background.toolChoice?.options ?? []).slice(0, background.toolChoice?.count ?? 0).map((entry) => entry.id),
          languages: catalog.backgrounds.language_options.filter((entry) => !benefits.languages.includes(entry.id)).slice(0, background.languageChoiceCount ?? 0).map((entry) => entry.id),
          replacementSkills,
        },
      })
      const parsed = parseCharacterImport(document, { rulesetId: RULESET_ID, validateCreationLanguages: true })
      const label = `${species.id}/${klass.id}/${background.id}`
      assert.equal(Object.values(parsed.sheet.skills).filter((skill) => skill.proficient).length, granted.length, label)
      assert.equal(parsed.sheet.speed.value, species.base_speed, label)
      assert.ok(parsed.sheet.hit_points.value > 0, label)
      assert.deepEqual(parsed.patch.knownSpellIds, [...cantrips, ...known], label)
      checked += 1
    }
  }
  assert.equal(checked, 2184)
})

test('повтор навыка заменяется свободным владением и сохраняется после replay', () => {
  const document = classicFighter({ backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills: ['stealth'] } })
  const parsed = parseCharacterImport(document, { rulesetId: RULESET_ID })
  assert.equal(parsed.sheet.skills.stealth.proficient, true)
  assert.equal(parsed.sheet.skills.stealth.total, 4)
  assert.deepEqual(parsed.patch.backgroundChoices.replacementSkills, ['stealth'])
  const restored = parseCharacterImport({ ...document, character: parsed.patch }, { rulesetId: RULESET_ID })
  assert.deepEqual(restored.sheet, parsed.sheet)
  const initial = normalizeCampaignState({ ruleset_id: RULESET_ID, sessionCode: 'REPLACEMENT', partyMemberIds: ['hero'], players: [{ id: 'hero', characterClass: 'fighter', characterSetupRequired: true, inventory: [] }] })
  const result = resolveCommands([{ command_type: 'ImportCharacter', actor_id: 'hero', document }], initial, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { allowedActorIds: ['hero'] } })
  assert.deepEqual(replayEvents(initial, result.events), result.state)
  assert.equal(result.state.players[0].characterSheet.skills.stealth.proficient, true)
  const changed = normalizeCampaignState({ ...result.state, players: [{ ...result.state.players[0], classSkillProficiencies: ['perception', 'survival'] }] })
  assert.equal(changed.players[0].characterSheet.skills.stealth.proficient, false, 'После исчезновения повтора лишнее владение не остаётся')
  for (const replacementSkills of [[], ['athletics'], ['stealth', 'arcana'], ['unknown-skill']]) {
    assert.throws(() => parseCharacterImport(classicFighter({
      backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills },
    }), { rulesetId: RULESET_ID }), (error) => error.code === 'IMPORT_SKILL_REPLACEMENT_INVALID')
  }
  assert.doesNotThrow(() => parseCharacterImport(classicFighter(), { rulesetId: RULESET_ID }), 'Старый лист без поля замены остаётся читаемым')
})

test('новый импорт не теряет язык предыстории при пересечении с расой', () => {
  const document = classicFighter({ backgroundId: 'sage', background: 'Мудрец', backgroundChoices: { tools: [], languages: ['dwarvish', 'elvish'] } })
  assert.throws(() => parseCharacterImport(document, { rulesetId: RULESET_ID, validateCreationLanguages: true }), (error) => error.code === 'IMPORT_LANGUAGE_DUPLICATE')
  assert.doesNotThrow(() => parseCharacterImport(document, { rulesetId: RULESET_ID }), 'Старые события читаются с прежними языками')
  document.character.backgroundChoices.languages = ['elvish', 'giant']
  assert.doesNotThrow(() => parseCharacterImport(document, { rulesetId: RULESET_ID, validateCreationLanguages: true }))
})

function classicFighter(overrides = {}) {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const originBonuses = { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Торин',
      name: 'Игрок',
      role: 'Воин · ур. 1',
      characterClass: 'fighter',
      species: 'Холмовой дварф',
      background: 'Солдат',
      backgroundId: 'soldier',
      backgroundChoices: { tools: ['dice_set'], languages: [] },
      level: 1,
      experience: 0,
      abilities: { str: 15, dex: 14, con: 15, int: 12, wis: 11, cha: 8 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014',
        policyVersion: 2,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'dwarf-hill',
        originBonuses,
        speciesOptionId: 'dwarf-hill',
      },
      baseSpeed: 25,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: ['fighting-style-defense'],
      knownSpellIds: [],
      preparedSpellIds: [],
      ...overrides,
    },
  }
}

test('каталог создания 2014 отделён по ruleset_id и содержит PHB расы, подрасы и предыстории', () => {
  const catalog = characterCreationCatalog(RULESET_ID)
  assert.equal(catalog.ruleset_id, RULESET_ID)
  assert.equal(catalog.edition_family, '5e_2014')
  assert.equal(catalog.ability_policy.bonus_source, 'species')
  assert.equal(catalog.ability_policy.species_options.length, 14)
  assert.equal(new Set(catalog.ability_policy.species_options.map((entry) => entry.race_id)).size, 9)
  assert.equal(catalog.backgrounds.options.length, 13)
  assert.deepEqual(catalog.backgrounds.ability_modes, [])
  assert.ok(catalog.ability_policy.species_options.some((entry) => entry.id === 'elf-drow' && entry.subrace_id === 'drow'))
  assert.ok(catalog.backgrounds.options.some((entry) => entry.id === 'guild-artisan' && entry.toolChoice.options.length > 0))

  const current = characterCreationCatalog('srd_5_2_1')
  assert.equal(current.ability_policy.bonus_source, 'background')
  assert.notEqual(current.ability_policy.policy_id, catalog.ability_policy.policy_id)
  assert.notEqual(current.backgrounds.policy_id, catalog.backgrounds.policy_id)
})

test('сервер принимает расовые бонусы 2014 и отвергает бонусы от предыстории или чужой подрасы', () => {
  const parsed = parseCharacterImport(classicFighter(), { rulesetId: RULESET_ID })
  assert.equal(parsed.patch.abilities.con, 15)
  assert.equal(parsed.patch.abilities.wis, 11)
  assert.equal(parsed.patch.backgroundAbilityChoice, undefined)
  const benefits = backgroundBenefits('soldier', null, parsed.patch.backgroundChoices, RULESET_ID)
  assert.deepEqual(benefits.ability_bonuses, {})
  assert.deepEqual(benefits.skill_proficiencies, ['athletics', 'intimidation'])

  assert.throws(
    () => parseCharacterImport(classicFighter({
      backgroundAbilityChoice: { mode: 'two_one', abilities: ['str', 'con'] },
    }), { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_BACKGROUND_ABILITY_INVALID',
  )
  assert.throws(
    () => parseCharacterImport(classicFighter({
      abilityGeneration: {
        ...classicFighter().character.abilityGeneration,
        originBonusProfileId: 'dwarf-mountain',
      },
    }), { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_ABILITY_BUDGET_INVALID' || error.code === 'IMPORT_SPECIES_ABILITY_INVALID',
  )
})

test('полуэльф получает +2 Харизма и выбирает две другие характеристики', () => {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const document = classicFighter({
    species: 'Полуэльф',
    baseSpeed: 30,
    abilities: { str: 16, dex: 15, con: 13, int: 12, wis: 10, cha: 10 },
    abilityGeneration: {
      policyId: 'skazanie.character-abilities.dnd-5e-2014',
      policyVersion: 2,
      method: 'standard_array',
      baseScores,
      originBonusProfileId: 'half-elf',
      originBonuses: { str: 1, dex: 1, con: 0, int: 0, wis: 0, cha: 2 },
      speciesOptionId: 'half-elf',
    },
  })
  assert.equal(parseCharacterImport(document, { rulesetId: RULESET_ID }).patch.abilities.cha, 10)

  document.character.abilityGeneration.originBonuses.cha = 3
  document.character.abilities.cha = 11
  assert.throws(
    () => parseCharacterImport(document, { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_ABILITY_BUDGET_INVALID' || error.code === 'IMPORT_SPECIES_ABILITY_INVALID',
  )
})

test('расовые выборы 2014 валидируются каталогом и становятся владениями и врождённой магией', () => {
  const halfElf = resolveSpeciesChoices('half-elf', {
    'extra-language': ['giant'],
    'versatility-skills': ['perception', 'stealth'],
  }, RULESET_ID)
  assert.equal(halfElf.ok, true)
  const benefits = speciesBenefitsFor('half-elf', RULESET_ID, halfElf.choices)
  assert.ok(benefits.languages.includes('giant'))
  assert.deepEqual(benefits.skill_proficiencies, ['perception', 'stealth'])
  assert.equal(resolveSpeciesChoices('half-elf', {
    'extra-language': ['elvish'],
    'versatility-skills': ['perception', 'perception'],
  }, RULESET_ID).ok, false)

  const highElf = speciesBenefitsFor('elf-high', RULESET_ID, {
    'extra-language': ['giant'],
    'wizard-cantrip': ['fire-bolt'],
  })
  const fighterSpells = combatSpellsFor({ characterClass: 'fighter', level: 1, speciesBenefits: highElf })
  assert.ok(fighterSpells.some((spell) => spell.id === 'fire-bolt' && spell.innateSpell && spell.spellcastingAbility === 'int'))
})

test('импорт героя 2014 выдаёт классовое и фоновое снаряжение и стабилен при replay', () => {
  const state = {
    ruleset_id: RULESET_ID,
    players: [{
      id: 'hero-slot-1', character: 'Место героя', characterSetupRequired: true,
      inventory: [], currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
    }],
    mechanics: { combat: { active: false } },
  }
  const command = validateCharacterImportCommand({
    command_type: 'ImportCharacter', actor_id: 'hero-slot-1', document: classicFighter(),
  }, state, { allowedActorIds: ['hero-slot-1'] })
  assert.equal(command.ruleset_id, RULESET_ID)
  assert.deepEqual(command.source_rule_ids, [`${RULESET_ID}:resources:spending`])
  const event = characterImportEvent(command)
  const after = applyCharacterLifecycleEvent(state, event)
  const hero = after.players[0]
  assert.equal(hero.speciesBenefits.species_option_id, 'dwarf-hill')
  assert.equal(hero.backgroundBenefits.background_id, 'soldier')
  assert.equal(hero.currency.gold, 10)
  assert.equal(hero.starterEquipmentPolicyId, 'skazanie.starter-equipment.dnd-5e-2014')
  assert.ok(hero.inventory.some((item) => item.catalog_id === 'srd_5_2_1:chain-mail'))
  assert.ok(hero.inventory.some((item) => item.name === 'Солдат: личные вещи'))
  assert.deepEqual(applyCharacterLifecycleEvent(state, event), after)
})

test('каждый класс 2014 получает непустой детерминированный стартовый набор', () => {
  const classes = characterCreationCatalog(RULESET_ID).classes
  assert.equal(classes.length, 12)
  for (const entry of classes) {
    const hero = withStarterKit({
      id: `starter-${entry.id}`,
      characterClass: entry.id,
      backgroundId: 'soldier',
      backgroundChoices: { tools: ['dice_set'], languages: [] },
      inventory: [],
      currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
    }, { rulesetId: RULESET_ID })
    assert.ok(hero.inventory.length >= 2, entry.id)
    assert.equal(hero.currency.gold, 10, entry.id)
    assert.equal(hero.starterEquipmentPolicyId, 'skazanie.starter-equipment.dnd-5e-2014')
  }
})

test('выбранные альтернативы снаряжения материализуются сервером, а чужой option id отклоняется', () => {
  const hero = withStarterKit({
    id: 'chosen-fighter',
    characterClass: 'fighter',
    backgroundId: 'soldier',
    backgroundChoices: { tools: ['dice_set'], languages: [] },
    starterEquipmentChoices: {
      armor: ['leather-and-longbow'],
      'melee-loadout': ['greatsword'],
      secondary: ['two-handaxes'],
      pack: ['dungeoneers-pack'],
    },
    inventory: [],
    currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
  }, { rulesetId: RULESET_ID })
  assert.ok(hero.inventory.some((item) => item.catalog_id === 'srd_5_2_1:greatsword'))
  assert.ok(hero.inventory.some((item) => item.catalog_id === 'srd_5_2_1:longbow'))
  assert.ok(hero.inventory.some((item) => item.name === 'Набор исследователя подземелий'))
  assert.throws(() => withStarterKit({
    ...hero,
    inventory: [],
    starterEquipmentChoices: { ...hero.starterEquipmentChoices, armor: ['plate-armor'] },
  }, { rulesetId: RULESET_ID }), /неизвестный вариант/u)
})

test('legacy событие до policy v2 получает прежний детерминированный набор', () => {
  const legacy = withStarterKit({
    id: 'legacy-cleric', characterClass: 'cleric', backgroundId: 'soldier',
    backgroundChoices: { tools: ['dice_set'], languages: [] }, inventory: [],
    currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
  }, { rulesetId: RULESET_ID, starterPolicyVersion: 1 })
  assert.ok(legacy.inventory.some((item) => item.catalog_id === 'srd_5_2_1:explorers-pack'))
  assert.ok(!legacy.inventory.some((item) => item.name === 'Набор священника'))
})

test('legacy CharacterImported policy v1 replay не получает новые расовые механики задним числом', () => {
  const document = classicFighter()
  document.character.abilityGeneration.policyVersion = 1
  delete document.character.speciesChoices
  delete document.character.starterEquipmentChoices
  assert.throws(
    () => parseCharacterImport(document, { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_ABILITY_POLICY_UNSUPPORTED',
    'новый сетевой импорт не может притвориться legacy-событием',
  )
  const patch = parseCharacterImport(document, { rulesetId: RULESET_ID, allowLegacyAbilityPolicy: true }).patch
  const state = {
    ruleset_id: RULESET_ID,
    players: [{ id: 'hero-slot-legacy', character: 'Место героя', characterSetupRequired: true, inventory: [], currency: {} }],
    mechanics: { combat: { active: false } },
  }
  const event = {
    event_type: 'CharacterImported', actor_id: 'hero-slot-legacy', target_ids: ['hero-slot-legacy'],
    payload: { schema: 'skazanie.character', schema_version: 1, ruleset_id: RULESET_ID, patch },
  }
  const after = applyCharacterLifecycleEvent(state, event)
  assert.deepEqual(after.players[0].speciesBenefits.mechanics, {})
  assert.equal(after.players[0].abilityGeneration.policyVersion, 1)
  assert.ok(after.players[0].inventory.some((item) => item.catalog_id === 'srd_5_2_1:explorers-pack'))
})
