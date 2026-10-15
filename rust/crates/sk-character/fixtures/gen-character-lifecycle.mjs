import '../../../fixtures-env.mjs'
// Эталон `server/character-lifecycle.mjs`.
//
// Три источника случаев:
// - перехват настоящих вызовов: тесты модуля и его потребителей
//   (`test/character-*.test.mjs` и др., без HTTP-серверов) в этом процессе,
//   экспорты обёрнуты хуком загрузки (`module.registerHooks`), исходники на
//   диске не меняются;
// - корпус паритета (`tmp/corpus-v1` прогона Dnd-narrator-live): настоящие
//   команды LevelUp / ImportCharacter / броски создания с их состояниями,
//   события из исходов и листы всех героев корпуса;
// - случайные герои и документы импорта: все классы и подклассы обеих
//   редакций, уровни 1–20, поэтапное создание до стартового уровня, мусор
//   старых сохранений.
// Состояние в эталоне урезано (`stripState`); урезанный вход проверяется на
// тот же исход, иначе пишется полный.
//
//   node rust/crates/sk-character/fixtures/gen-character-lifecycle.mjs [каталог-корпуса]
import { registerHooks } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chooser, errorOf, fixtureWriter, mulberry32, sha256, stripActor, stripState, viaJson } from './common.mjs'

const TARGET = 'server/character-lifecycle.mjs'
const NAMES = [
  'abilityModifier', 'proficiencyBonusForLevel', 'experienceForLevel', 'levelForExperience', 'hitDieFor', 'savingThrowProficienciesFor',
  'normalizedAbilityScores', 'characterCreationCatalog', 'partyPresentationFor', 'createCharacterSlot', 'normalizedHitPointIncreases',
  'deriveMaximumHitPoints', 'deriveArmorClass', 'deriveSpeed', 'deriveCharacterSheet', 'normalizeCharacterSheet', 'classResourcePlan',
  'resourcesAfterRest', 'characterCreationTargetLevel', 'characterCreationChoicesComplete', 'validateLevelUpCommand', 'levelUpEvent',
  'validateCharacterImportCommand', 'validateCharacterAbilityRollCommand', 'characterImportEvent', 'resolveLevelUp',
  'isCharacterLifecycleEvent', 'applyCharacterLifecycleEvent', 'migrateCharacterImport', 'parseCharacterImport',
]
const STATE_ARG = {
  validateLevelUpCommand: 1, validateCharacterImportCommand: 1, validateCharacterAbilityRollCommand: 1, resolveLevelUp: 1,
  applyCharacterLifecycleEvent: 0, characterCreationTargetLevel: 0,
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith(`/${TARGET}`)) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = NAMES.map((name) => `${name} = globalThis.__lifecycleWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const captured = []
// Случайные id тестов (randomUUID) — по порядку появления, чтобы эталон
// пересоздавался байт в байт.
const uuidNames = new Map()
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g
const isoNames = new Map()
function stableIds(args) {
  return args.map((arg) => (arg === undefined ? undefined : JSON.parse(JSON.stringify(arg).replace(UUID, (id) => {
    if (!uuidNames.has(id)) uuidNames.set(id, `00000000-0000-4000-8000-${String(uuidNames.size).padStart(12, '0')}`)
    return uuidNames.get(id)
  }).replace(ISO, (time) => {
    if (!isoNames.has(time)) isoNames.set(time, new Date(Date.UTC(2026, 0, 1) + isoNames.size * 1000).toISOString())
    return isoNames.get(time)
  }))))
}
let depth = 0
let recording = true
globalThis.__lifecycleWrap = (name, fn) => function recorded(...args) {
  if (!recording || depth > 0) return fn(...args)
  depth += 1
  try {
    let plain
    try {
      plain = args.map((arg) => (arg === undefined ? undefined : viaJson(arg)))
    } catch {
      plain = null
    }
    if (plain) captured.push({ name, args: stableIds(plain) })
    return fn(...args)
  } finally {
    depth -= 1
  }
}

const lifecycle = await import('../../../../server/character-lifecycle.mjs')
const combatActions = await import('../../../../server/combat-actions.mjs')
const progression = await import('../../../../server/character-progression.mjs')
const combatSpells = await import('../../../../server/combat-spells.mjs')
const itemCatalog = await import('../../../../server/item-catalog.mjs')
const classOptions = await import('../../../../server/character-creation-class-options.mjs')
const creationCatalog = await import('../../../../server/character-creation-catalog.mjs')
const backgrounds = await import('../../../../server/backgrounds.mjs')
const wealthCatalog = await import('../../../../server/character-creation-wealth.mjs')

const TESTS = [
  'character-lifecycle', 'character-lifecycle-engine', 'character-ability-methods-2014', 'character-creation-2014',
  'character-creation-phb-complete', 'milestone-level-up', 'regression-2026-07-26', 'species-traits-2014', 'starter-kit-2024',
  'starting-level-progression', 'warlock-invocations', 'magic-initiate-focus', 'item-catalog', 'beast-taming', 'scenario-progression',
]
for (const file of TESTS) await import(`../../../../test/${file}.test.mjs`)

// ---------------------------------------------------------------------------

const writer = fixtureWriter()
const CAPS = { parseCharacterImport: 480, validateCharacterImportCommand: 260, deriveCharacterSheet: 560, classResourcePlan: 350, characterImportEvent: 120, validateLevelUpCommand: 330, applyCharacterLifecycleEvent: 300, normalizeCharacterSheet: 250, resolveLevelUp: 100, resourcesAfterRest: 300 }
const perOutcome = (key) => (key.endsWith(':ok') ? 1800 : 300)
const ACTOR_ARG = new Set([
  'hitDieFor', 'savingThrowProficienciesFor', 'normalizedHitPointIncreases', 'deriveMaximumHitPoints', 'deriveArmorClass', 'deriveSpeed',
  'deriveCharacterSheet', 'normalizeCharacterSheet', 'classResourcePlan', 'resourcesAfterRest', 'characterCreationChoicesComplete',
])
const outcomeText = (name, args) => {
  try {
    let value = lifecycle[name](...args.map(viaJson))
    if (name === 'applyCharacterLifecycleEvent') value = stripState(value)
    if (name === 'resolveLevelUp' && value) value = { ...value, state: stripState(value.state) }
    if (name === 'normalizeCharacterSheet' && value) value = { ...value, actor: stripActor(value.actor) }
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify(errorOf(error))
  }
}
let differ = 0
/** Вызов с урезанным состоянием и героем, если исход тот же. */
function run(name, args, options = {}) {
  const index = STATE_ARG[name]
  let used = args
  const stripped = [...args]
  if (index !== undefined && args[index] && typeof args[index] === 'object') stripped[index] = stripState(args[index])
  if (ACTOR_ARG.has(name)) stripped[0] = stripActor(args[0])
  if (name === 'characterImportEvent' && args[0] && typeof args[0] === 'object') {
    const { derived_sheet: _sheet, document: _document, ...command } = args[0]
    stripped[0] = command
  }
  if (stripped.some((value, position) => value !== args[position])) {
    if (outcomeText(name, args) === outcomeText(name, stripped)) used = stripped
    else differ += 1
  }
  return writer.call(name, (...plain) => lifecycle[name](...plain), used, { perOutcome, cap: CAPS[name] ?? 420, ...options })
}

const random = mulberry32(0x5c4a1)
const c = chooser(random)
const RULESETS = ['srd_5_2_1', 'dnd_5e_2014']
const CLASSES = combatActions.combatClassCatalogInfo().classes
const CLASS_KEYS = CLASSES.map((entry) => entry.classKey)
const ARMOR_IDS = Object.keys(itemCatalog.ITEM_ARMOR_PROFILES)
const PROTO = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
const SKILLS = progression.classBuildCatalogInfo().skills.map((skill) => skill.id)
const GARBAGE = [null, '', 'x', -1, 0, 1.5, 99, true, [], {}, ['a'], { a: 1 }, 'NaN', '7']

function sample(list, count) {
  return c.shuffle(list).slice(0, Math.max(0, count))
}

function abilitiesFor() {
  if (c.chance(0.04)) return c.pick([undefined, null, 'x', { str: 10 }, { str: 31, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, luck: 3 }])
  return Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((ability) => [ability, c.chance(0.02) ? c.pick(GARBAGE) : c.int(3, 20)]))
}

function inventoryFor(heroId) {
  const items = []
  const count = c.int(0, 4)
  for (let index = 0; index < count; index += 1) {
    const roll = random()
    if (roll < 0.6) {
      const id = c.pick(ARMOR_IDS)
      items.push({ id: `armor-${index}`, catalog_id: id, type: 'armor', equipped: c.chance(0.75), quantity: 1 })
    } else if (roll < 0.75) {
      const ring = itemCatalog.materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: `ring-${index}` })
      items.push({ ...ring, equipped: c.chance(0.8), attuned_to: c.chance(0.7) ? heroId : null })
    } else if (roll < 0.85) {
      items.push({ id: `odd-${index}`, catalogId: c.pick([...ARMOR_IDS, ...PROTO]), equipped: true })
    } else {
      items.push(c.pick([null, 'junk', 7, { id: 'old', name: 'Старая вещь', equipped: true }, { id: 'p', catalog_id: c.pick(PROTO), equipped: true }]))
    }
  }
  return items
}

function creationBenefitsFor() {
  const benefits = {}
  if (c.chance(0.3)) benefits.unarmored_armor_class = { base: c.pick([13, 12, '11', 'x']) }
  if (c.chance(0.3)) benefits.speed_bonus = c.pick([5, 10, '5', 'fast'])
  if (c.chance(0.4)) benefits.saving_throw_proficiencies = c.pick([['wis'], ['con', 'con'], 'dex', []])
  if (c.chance(0.4)) benefits.expertise = c.pick([sample(SKILLS, 2), 'stealth,perception', []])
  if (c.chance(0.3)) benefits.passive_skill_bonuses = { perception: c.pick([5, '5', 'x']), investigation: c.pick([5, undefined]) }
  if (c.chance(0.3)) benefits.initiative_bonus = c.pick([5, '2', 'x'])
  if (c.chance(0.3)) benefits.extra_hit_points_per_level = c.pick([1, '1', 0.5, 'x'])
  if (c.chance(0.2)) benefits.feat = { id: c.pick(['medium-armor-master', 'alert', 'tough']) }
  return benefits
}

function speciesBenefitsFor(rulesetId) {
  const policy = creationCatalog.characterCreationPolicyFor(rulesetId)
  const option = c.pick(policy.species_options)
  const benefits = creationCatalog.speciesBenefitsFor(option.id, rulesetId)
  if (benefits && c.chance(0.3)) benefits.mechanics = { ...(benefits.mechanics ?? {}), extra_hit_points_per_level: c.pick([1, '1', 'x']), ignore_armor_speed_penalty: c.chance(0.5) }
  return benefits
}

function heroFor({ rulesetId = c.pick(RULESETS), classKey = c.pick(CLASS_KEYS), level = c.int(1, 12), id = `hero-${c.int(1, 999)}` } = {}) {
  const hero = { id, character: c.pick(['Бранн', 'Мира', 'Ёж 🦔', 'Лис']), characterClass: classKey, level, experience: lifecycle.EXPERIENCE_THRESHOLDS[Math.min(12, Math.max(1, level))] ?? 0 }
  if (c.chance(0.05)) hero.characterClass = c.pick(['', 'warrior', 'Wizard', undefined, 'constructor'])
  if (c.chance(0.05)) hero.role = c.pick(['Воин · ур. 3', 'волшебник', 'жрец'])
  if (c.chance(0.04)) hero.level = c.pick(GARBAGE)
  if (c.chance(0.05)) hero.experience = c.pick([...GARBAGE, 2_000_000_001, 64_000])
  hero.abilities = abilitiesFor()
  if (c.chance(0.9)) hero.baseSpeed = c.chance(0.95) ? c.pick([25, 30, 35]) : c.pick(GARBAGE)
  else if (c.chance(0.5)) hero.base_speed = c.pick([30, 40])
  const actorForRules = { characterClass: classKey, level: Math.min(12, Math.max(1, Number(level) || 1)), abilities: hero.abilities && typeof hero.abilities === 'object' ? hero.abilities : {} }
  const classInfo = CLASSES.find((entry) => entry.classKey === classKey)
  if (c.chance(0.8)) {
    const options = [...(classInfo?.subclassOptions ?? []).map((entry) => entry.id), ...(classOptions.classOptionFor(classKey)?.subclass_options ?? []).map((entry) => entry.id)]
    hero.subclass = c.chance(0.9) && options.length ? c.pick(options) : c.pick(['', '  ', 'nonsense', null])
  }
  const skillRule = progression.classSkillRuleFor(actorForRules)
  if (c.chance(0.9)) hero.classSkillProficiencies = skillRule ? sample([...skillRule.skills, ...(c.chance(0.2) ? ['arcana', 'sleight-of-hand', 'junk'] : [])], c.int(0, skillRule.choiceCount + 1)) : []
  const groups = progression.featureChoiceGroupsFor({ ...actorForRules, subclass: hero.subclass })
  if (c.chance(0.9)) hero.selectedFeatureIds = groups.flatMap((group) => sample(group.options.map((entry) => entry.id), c.int(0, group.choiceCount + (c.chance(0.2) ? 1 : 0))))
  const spells = combatSpells.combatSpellsFor({ ...actorForRules, subclass: hero.subclass }, { rulesetId })
  if (spells.length && c.chance(0.85)) {
    const rules = combatSpells.spellSelectionRulesFor(actorForRules)
    const cantrips = spells.filter((spell) => spell.level === 0).map((spell) => spell.id)
    const leveled = spells.filter((spell) => spell.level > 0).map((spell) => spell.id)
    hero.knownSpellIds = [...sample(cantrips, c.int(0, (rules?.cantrips ?? 0) + 1)), ...sample(leveled, c.int(0, Math.max(rules?.spellsKnown ?? 0, rules?.spellbookMinimum ?? 0) + 1))]
    hero.preparedSpellIds = sample(leveled, c.int(0, (rules?.preparedLimit ?? 0) + 1))
  }
  if (c.chance(0.85)) {
    const die = lifecycle.hitDieFor(hero)
    const count = Math.max(0, (Number(hero.level) || 1) - 1)
    hero.hitPointIncreases = Array.from({ length: c.chance(0.85) ? c.int(0, count) : count + 1 }, () => (c.chance(0.03) ? c.pick(GARBAGE) : c.int(1, die)))
  } else if (c.chance(0.2)) hero.hit_point_increases = c.pick(['x', [3], null])
  hero.inventory = inventoryFor(id)
  if (c.chance(0.35)) hero.creationBenefits = creationBenefitsFor()
  if (c.chance(0.35)) hero.speciesBenefits = speciesBenefitsFor(rulesetId)
  if (c.chance(0.25)) hero.levelFeats = c.pick([{ 4: { id: 'medium-armor-master' } }, { 4: { id: '' } }, [{ id: 'medium-armor-master' }], 'feat', null, { 8: 'x' }])
  if (c.chance(0.25)) hero.abilityScoreIncreases = c.pick([{ 4: ['str', 'dex'] }, { 4: ['str'] }, { 4: [] }, { 8: ['con', 'con', 'con'] }, []])
  if (c.chance(0.25)) hero.backgroundSkillProficiencies = sample(SKILLS, 2).map((id) => (c.chance(0.3) ? id.replace('_', '-') : id))
  if (c.chance(0.2)) hero.speciesSkillProficiencies = sample(SKILLS, 1)
  if (c.chance(0.2)) hero.creationSkillProficiencies = c.pick([sample(SKILLS, 2), 'stealth', []])
  if (c.chance(0.4)) hero.hp = c.pick([0, 5, 12, 100, 'x', -3])
  if (c.chance(0.2)) hero.characterSetupRequired = c.pick([true, false, 'yes'])
  if (c.chance(0.2)) hero.characterSetupStage = c.pick(['leveling', 'import'])
  return hero
}

// --- батарея героя ----------------------------------------------------------
function heroBattery(hero, rulesetId) {
  run('deriveCharacterSheet', [hero])
  run('deriveCharacterSheet', [hero, { rulesetId, classResources2024: true }])
  if (c.chance(0.1)) run('deriveCharacterSheet', [hero, { armorProfiles: c.pick([{}, 'x', { 'srd_5_2_1:shield': { kind: 'shield', armorClassBonus: 3 } }, { a: { kind: 'armor', armorClassBase: 99 } }]) }])
  run('normalizeCharacterSheet', [hero, { rulesetId }])
  run('classResourcePlan', [hero])
  run('classResourcePlan', [hero, { classResources2024: true }])
  const resources = c.chance(0.5) ? { pact_slots: { current: c.int(0, 2) }, spell_slots_1: { current: c.pick([0, 1, 'x', null]) }, channel_divinity: { current: 0 } } : c.pick([undefined, null, 'x'])
  run('resourcesAfterRest', [hero, resources, c.pick(['short', 'long', 'short', 'nap'])])
  run('characterCreationChoicesComplete', [hero, { rulesetId }])
  run('deriveArmorClass', [hero])
  run('deriveSpeed', [hero])
  run('deriveMaximumHitPoints', [hero])
  run('normalizedHitPointIncreases', [hero])
  run('hitDieFor', [hero])
  run('savingThrowProficienciesFor', [hero])
}

const context = (id) => c.pick([{ allowedActorIds: [id] }, { isAdmin: true }, { allowedActorIds: [] }, {}, undefined, { allowedActorIds: 'x' }, { allowedActorIds: [7] }])

/** Повышение до упора: команда → событие → состояние, как движок. */
function levelChain(state, actorId, steps) {
  let current = state
  for (let step = 0; step < steps; step += 1) {
    const actor = current.players.find((player) => player.id === actorId)
    const command = { command_type: 'LevelUp', actor_id: actorId }
    if (c.chance(0.5)) command.expected_level = c.chance(0.9) ? actor?.level : c.pick([1, 'x', 13])
    if (c.chance(0.2)) command.next_level = c.chance(0.8) ? Number(actor?.level) + 1 : 3
    if (c.chance(0.6)) command.hit_point_roll = c.chance(0.95) ? c.int(1, lifecycle.hitDieFor(actor ?? {})) : c.pick([0, 13, 'x'])
    if (c.chance(0.1)) command.source_rule_ids = c.pick([['custom:rule'], [], 'x'])
    const ctx = c.chance(0.85) ? { allowedActorIds: [actorId] } : context(actorId)
    const validated = run('validateLevelUpCommand', [command, current, ctx])
    if (c.chance(0.2)) run('resolveLevelUp', [command, current, ctx])
    if (!validated.value) return current
    const event = run('levelUpEvent', [validated.value]).value
    if (!event) return current
    const next = run('applyCharacterLifecycleEvent', [current, event]).value
    if (!next) return current
    const hero = next.players.find((player) => player.id === actorId)
    run('deriveCharacterSheet', [hero, { rulesetId: next.ruleset_id }])
    run('characterCreationChoicesComplete', [hero, { rulesetId: next.ruleset_id }])
    current = next
  }
  return current
}

// --- документы импорта ------------------------------------------------------
function documentFor(rulesetId, classKey, { trusted } = {}) {
  const policy = creationCatalog.characterCreationPolicyFor(rulesetId)
  const catalog = catalogs[rulesetId]
  const classEntry = catalog.classes.find((entry) => entry.id === classKey)
  const abilitiesIds = ['str', 'dex', 'con', 'int', 'wis', 'cha']
  const method = rulesetId === 'dnd_5e_2014' ? c.pick(['standard_array', 'point_buy', 'rolled']) : 'standard_array'
  let baseScores
  let rollId
  if (method === 'standard_array') {
    const shuffled = c.shuffle(policy.standard_array)
    baseScores = Object.fromEntries(abilitiesIds.map((ability, index) => [ability, shuffled[index]]))
  }
  else if (method === 'point_buy') baseScores = Object.fromEntries(abilitiesIds.map((ability) => [ability, c.int(8, c.chance(0.8) ? 13 : 15)]))
  else {
    baseScores = Object.fromEntries(abilitiesIds.map((ability) => [ability, c.int(3, 18)]))
    rollId = `roll-${c.int(1, 99)}`
    trusted.abilities = { id: c.chance(0.9) ? rollId : 'other', scores: c.chance(0.9) ? c.shuffle(Object.values(baseScores)) : [10, 10, 10, 10, 10, 10] }
  }
  const species = c.pick(policy.species_options)
  let profileId = species.bonus_profile_id ?? 'none'
  let originBonuses = Object.fromEntries(abilitiesIds.map((ability) => [ability, 0]))
  let backgroundId
  let backgroundAbilityChoice
  if (rulesetId === 'dnd_5e_2014') {
    const profile = policy.origin_bonus_profiles.find((entry) => entry.id === profileId)
    for (const [ability, value] of Object.entries(profile?.fixed_bonuses ?? {})) originBonuses[ability] = value
    const free = abilitiesIds.filter((ability) => !originBonuses[ability] && !(profile?.excluded_choices ?? []).includes(ability))
    for (const ability of sample(free, profile?.choice_count ?? 0)) originBonuses[ability] = profile.choice_amount
    backgroundId = c.chance(0.85) ? c.pick(backgroundCatalogs[rulesetId].options).id : undefined
  } else {
    const background = c.pick(backgroundCatalogs[rulesetId].options)
    backgroundId = background.id
    const mode = c.pick(['two_one', 'one_one_one'])
    const picked = sample(background.abilityOptions, mode === 'two_one' ? 2 : 3)
    backgroundAbilityChoice = { mode, abilities: picked }
    const resolved = backgrounds.resolveBackgroundAbilityChoice(background.id, backgroundAbilityChoice, rulesetId)
    if (resolved.ok) {
      profileId = mode
      for (const [ability, value] of Object.entries(resolved.bonuses)) originBonuses[ability] = value
    }
  }
  const abilities = Object.fromEntries(abilitiesIds.map((ability) => [ability, Math.min(20, baseScores[ability] + originBonuses[ability])]))
  const character = {
    character: c.pick(['Мира', 'Бранн', 'Ёж 🦔', 'Ульф']),
    characterClass: classKey,
    level: 1,
    experience: 0,
    abilities,
    abilityGeneration: {
      policyId: policy.policy_id, policyVersion: policy.policy_version, method, baseScores,
      originBonusProfileId: profileId, originBonuses, speciesOptionId: species.id, ...(rollId ? { rollId } : {}),
    },
    baseSpeed: species.base_speed,
    classSkillProficiencies: classEntry?.class_skills ? sample(classEntry.class_skills.options.map((entry) => entry.id), classEntry.class_skills.choice_count) : [],
    selectedFeatureIds: (classEntry?.feature_choice_groups ?? []).flatMap((group) => sample(group.options.map((entry) => entry.id), group.choiceCount)),
    knownSpellIds: [],
    preparedSpellIds: [],
  }
  if (c.chance(0.7)) character.species = species.id === 'custom' ? 'Полудракон' : species.label
  if (species.id === 'custom' && c.chance(0.8)) character.species = 'Полудракон'
  const selection = classEntry?.spell_selection
  if (selection) {
    const cantrips = selection.spells.filter((spell) => spell.level === 0).map((spell) => spell.id)
    const first = selection.spells.filter((spell) => spell.level === 1).map((spell) => spell.id)
    const leveledCount = selection.mode === 'known' ? selection.spellsKnown : selection.mode === 'spellbook' ? selection.spellbookMinimum : 0
    character.knownSpellIds = [...sample(cantrips, selection.cantrips), ...sample(first, leveledCount)]
    if (selection.mode !== 'known') character.preparedSpellIds = sample(selection.mode === 'spellbook' ? character.knownSpellIds.filter((id) => first.includes(id)) : first, Math.min(selection.preparedLimit, 2))
  }
  if (classEntry?.subclasses?.length && Number(classEntry.subclass_level) <= 1) character.subclass = c.pick(classEntry.subclasses).id
  if (backgroundId) character.backgroundId = backgroundId
  if (backgroundAbilityChoice) character.backgroundAbilityChoice = backgroundAbilityChoice
  if (c.chance(0.3)) character.name = 'Игрок'
  if (c.chance(0.3)) character.notes = 'Заметки'
  if (c.chance(0.2)) character.role = 'Странник'
  return character
}

function mutate(character) {
  const copy = structuredClone(character)
  const keys = Object.keys(copy)
  const roll = random()
  if (roll < 0.15) delete copy[c.pick(keys)]
  else if (roll < 0.3) copy[c.pick(keys)] = c.pick(GARBAGE)
  else if (roll < 0.38) copy.hp = 999
  else if (roll < 0.46) copy.level = 2
  else if (roll < 0.54 && copy.abilityGeneration) copy.abilityGeneration[c.pick(Object.keys(copy.abilityGeneration))] = c.pick(GARBAGE)
  else if (roll < 0.62) copy.subclass = c.pick(['', 'bogus', 7])
  else if (roll < 0.7) copy.backgroundChoices = c.pick([{ tools: ['lute'], languages: [] }, { tools: [], languages: ['elvish'], replacementSkills: ['arcana'] }, { junk: 1 }, 'x', { tools: [], languages: [], customization: { name: 'Своя' } }])
  else if (roll < 0.76) copy.speciesChoices = c.pick([{}, 'x', { 'extra-language': ['elvish'] }, { bogus: [] }])
  else if (roll < 0.82) copy.starterEquipmentChoices = c.pick([{}, 'x', { bogus: 'a' }])
  else if (roll < 0.88) copy.hitPointIncreases = c.pick(['x', [3], []])
  else if (roll < 0.92) copy.phbCreation = c.pick([{ schema_version: 1 }, { schema_version: 2 }, 'x', null])
  else copy.knownSpellIds = [...(copy.knownSpellIds ?? []), 'fireball']
  return copy
}

const catalogs = Object.fromEntries(RULESETS.map((rulesetId) => [rulesetId, lifecycle.characterCreationCatalog(rulesetId)]))
const backgroundCatalogs = Object.fromEntries(RULESETS.map((rulesetId) => [rulesetId, backgrounds.backgroundCatalogFor(rulesetId)]))

// --- 1. перехват ------------------------------------------------------------
let written = false
process.on('beforeExit', () => {
  if (written) return
  written = true
  recording = false
  const captureCount = captured.length
  for (const entry of captured) run(entry.name, entry.args, { perOutcome: (key) => (key.endsWith(':ok') ? 450 : 120) })

  // --- 2. корпус ------------------------------------------------------------
  const corpusDir = process.argv[2] ?? process.env.SK_CHARACTER_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
  let corpusRows = 0
  let corpusStates = 0
  if (existsSync(join(corpusDir, 'states'))) {
    const files = readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()
    const seenStates = new Set()
    for (const file of files) {
      for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        const type = record.command?.command_type
        const lifecycleCommand = ['LevelUp', 'ImportCharacter', 'RollCharacterAbilities', 'RollCharacterWealth'].includes(type)
        const fresh = !seenStates.has(record.state) && seenStates.size < 40
        if (!lifecycleCommand && !fresh) continue
        const statePath = join(corpusDir, 'states', `${record.state}.json`)
        if (!existsSync(statePath)) continue
        const state = JSON.parse(readFileSync(statePath, 'utf8'))
        if (fresh) {
          seenStates.add(record.state)
          corpusStates += 1
          for (const player of (state.players ?? []).slice(0, 4)) heroBattery(player, state.ruleset_id)
          run('characterCreationTargetLevel', [state])
        }
        if (!lifecycleCommand) continue
        corpusRows += 1
        const ctx = record.context
        const name = type === 'LevelUp' ? 'validateLevelUpCommand' : type === 'ImportCharacter' ? 'validateCharacterImportCommand' : 'validateCharacterAbilityRollCommand'
        const validated = run(name, [record.command, state, ctx], { perOutcome: () => 5000 })
        if (type === 'LevelUp') run('resolveLevelUp', [record.command, state, ctx], { perOutcome: () => 5000 })
        if (validated.value && type === 'LevelUp') run('levelUpEvent', [validated.value], { perOutcome: () => 5000 })
        if (validated.value && type === 'ImportCharacter') run('characterImportEvent', [validated.value], { perOutcome: () => 5000 })
        if (type === 'ImportCharacter') run('parseCharacterImport', [record.command.document, { rulesetId: String(state.ruleset_id ?? 'srd_5_2_1') }], { perOutcome: () => 5000 })
        for (const event of record.outcome?.events ?? []) {
          if (lifecycle.isCharacterLifecycleEvent(event)) {
            const after = run('applyCharacterLifecycleEvent', [state, event], { perOutcome: () => 5000 }).value
            const hero = after?.players?.find((player) => String(player.id) === String(event.target_ids?.[0]))
            if (hero) heroBattery(hero, after.ruleset_id)
          }
        }
      }
    }
  }

  // --- 3. случайные герои ---------------------------------------------------
  for (const value of [...GARBAGE, undefined, 1, 10, 30, 31, 3, '15']) run('abilityModifier', [value])
  for (const value of [...GARBAGE, undefined, 1, 4, 5, 8, 9, 12, 13, 20, '5']) {
    run('proficiencyBonusForLevel', [value])
    run('experienceForLevel', [value])
  }
  for (const value of [...GARBAGE, undefined, 0, 299, 300, 84_999, 85_000, 999_999, 2_000_000_000, 2_000_000_001, '900']) run('levelForExperience', [value])
  for (const value of [...GARBAGE, undefined, 0, 1, 2, 3, 4, 5, 7, 1e300, Infinity, -5, '2']) run('partyPresentationFor', [value])
  for (const value of [undefined, {}, { index: 0 }, { index: 3 }, { index: '0' }, { index: null }, { id: 'slot-a' }, { id: 'Bad Id' }, { id: '', index: 1 }, { index: 1.5 }, { index: true }])
    run('createCharacterSlot', [value])
  for (const value of [undefined, null, 'x', [], {}, { str: 10 }, { str: 30, dex: 1, con: 2, int: 3, wis: 4, cha: 5 }, { str: '12', dex: 12.5 }, { luck: 1 }]) run('normalizedAbilityScores', [value])
  for (const rulesetId of [...RULESETS, 'bogus', undefined]) run('characterCreationCatalog', rulesetId === undefined ? [] : [rulesetId], { perOutcome: () => 10 })
  for (const state of [undefined, null, {}, { character_start_level: 5 }, { characterStartLevel: '3' }, { character_start_level: 13 }, { character_start_level: 'x' }, { character_start_level: null, characterStartLevel: 2 }]) run('characterCreationTargetLevel', [state])
  for (const event of [undefined, null, {}, { event_type: 'CharacterLeveledUp' }, { event_type: 'CharacterImported' }, { event_type: 'ItemGranted' }, { event_type: ['CharacterImported'] }]) run('isCharacterLifecycleEvent', [event])
  for (const raw of [undefined, null, 'x', [], {}, { schema: 'skazanie.character', schema_version: 2, character: {} }, { schema: 'other', schema_version: 1, character: {} }, { schema: 'skazanie.character', schema_version: 1, character: { hp: 1 } }, { schema: 'skazanie.character', schema_version: 0, character: { character_class: 'wizard', characterClass: 'fighter' } }, { schema: 'skazanie.character', schema_version: 0, character: { character_class: 'wizard', characterClass: 'wizard', gold: 1 } }, { schema: 'skazanie.character', schema_version: 0, character: 'x' }, { schema: 'skazanie.character', schema_version: 1, character: { character: 'A' }, extra: 1 }])
    run('migrateCharacterImport', [raw])

  for (let index = 0; index < 420; index += 1) {
    const rulesetId = c.pick(RULESETS)
    const classKey = CLASS_KEYS[index % CLASS_KEYS.length]
    const level = index < 240 ? 1 + (index % 20) : c.int(1, 12)
    const hero = heroFor({ rulesetId, classKey, level, id: `hero-${index}` })
    heroBattery(hero, rulesetId)
    const state = {
      ruleset_id: rulesetId,
      players: [hero, ...(c.chance(0.3) ? [heroFor({ rulesetId, id: `mate-${index}` })] : [])],
      mechanics: { combat: { active: c.chance(0.06) }, ...(c.chance(0.2) ? { progression: { level_up_available: c.chance(0.7) } } : {}) },
      ...(c.chance(0.3) ? { character_start_level: c.int(1, 12) } : {}),
    }
    if (c.chance(0.1)) hero.experience = 0
    levelChain(state, hero.id, c.int(1, 4))
    if (c.chance(0.15)) run('validateLevelUpCommand', [c.pick([undefined, null, {}, { command_type: 'LevelUp', actor_id: 'nobody' }, { command_type: 'LevelUp', actorId: hero.id }, { command_type: 'Other', actor_id: hero.id }]), state, { isAdmin: true }])
    if (c.chance(0.15)) run('levelUpEvent', [c.pick([undefined, {}, { command_type: 'LevelUp', actor_id: hero.id, source_rule_ids: 'ab' }, { command_type: 'LevelUp' }])])
    if (c.chance(0.15)) run('applyCharacterLifecycleEvent', [state, c.pick([{ event_type: 'CharacterLeveledUp', target_ids: ['nobody'] }, { event_type: 'CharacterLeveledUp', actor_id: hero.id, payload: { level_after: 7 } }, { event_type: 'CharacterLeveledUp', target_ids: hero.id, payload: {} }, { event_type: 'ItemGranted' }])])
  }

  // Создание: слот → импорт → поэтапные уровни.
  let imports = 0
  const importCodes = new Map()
  for (let index = 0; index < 700; index += 1) {
    const rulesetId = index % 3 === 0 ? 'srd_5_2_1' : 'dnd_5e_2014'
    const classKey = CLASS_KEYS[index % CLASS_KEYS.length]
    const trusted = {}
    const base = documentFor(rulesetId, classKey, { trusted })
    const character = c.chance(0.65) ? base : mutate(base)
    const document = { schema: 'skazanie.character', schema_version: c.chance(0.95) ? 1 : 0, character }
    const slot = lifecycle.createCharacterSlot({ id: `slot-${index}`, index: index % 5 })
    if (Object.keys(trusted).length) slot.characterCreationRolls = trusted
    const startLevel = c.chance(0.5) ? c.int(1, 12) : undefined
    const state = { ruleset_id: rulesetId, players: [slot], mechanics: { combat: { active: c.chance(0.03) } }, ...(startLevel ? { character_start_level: startLevel } : {}) }
    run('parseCharacterImport', [document, { rulesetId }])
    if (c.chance(0.2)) run('parseCharacterImport', [document, { rulesetId, allowLegacyAbilityPolicy: true }])
    const command = { command_type: 'ImportCharacter', actor_id: `slot-${index}`, document }
    const validated = run('validateCharacterImportCommand', [command, state, c.chance(0.9) ? { allowedActorIds: [`slot-${index}`] } : context(`slot-${index}`)])
    importCodes.set(validated.error?.code ?? validated.error?.name ?? "ok", (importCodes.get(validated.error?.code ?? validated.error?.name ?? "ok") ?? 0) + 1)
    if (!validated.value) continue
    imports += 1
    const event = run('characterImportEvent', [validated.value]).value
    const after = run('applyCharacterLifecycleEvent', [state, event]).value
    if (!after) continue
    const hero = after.players[0]
    heroBattery(hero, rulesetId)
    // Слот уже не слот: повторный импорт существующего героя.
    if (c.chance(0.15)) {
      const again = run('validateCharacterImportCommand', [{ ...command, document: { ...document, character: { ...character, notes: 'Снова' } } }, after, { isAdmin: true }]).value
      if (again) run('applyCharacterLifecycleEvent', [after, lifecycle.characterImportEvent(again)])
    }
    levelChain(after, hero.id, startLevel ? Math.min(12, startLevel + 1) : c.int(0, 2))
    if (rulesetId === 'dnd_5e_2014' && c.chance(0.3)) {
      const roll = { command_type: c.pick(['RollCharacterAbilities', 'RollCharacterWealth']), actor_id: `slot-${index}`, roll_index: c.pick([0, 1, 6, '0', 0.5]), character_class: c.pick([classKey, 'monk', 'constructor', 'toString', 'bogus', undefined]) }
      run('validateCharacterAbilityRollCommand', [roll, state, { isAdmin: true }])
      run('validateCharacterAbilityRollCommand', [roll, { ...state, players: [{ ...slot, characterCreationRolls: c.pick([{ abilities: { scores: [10, 11] } }, { abilities: { scores: 'abc' } }, { wealth: { id: 'w' } }, { abilities: { scores: [1, 2, 3, 4, 5, 6] } }, null]) }] }, { isAdmin: true }])
    }
  }

  // Создание PHB 2014 из документов тестов: стартовое богатство с покупками,
  // замены навыков, порча выборов — через команду, событие и редьюсер слота.
  const purchaseIds = wealthCatalog.startingPurchaseCatalog().map((item) => item.id)
  const phbDocuments = new Map()
  for (const entry of captured) {
    const document = entry.name === 'parseCharacterImport' ? entry.args[0] : entry.name === 'validateCharacterImportCommand' ? entry.args[0]?.document : null
    if (document?.character?.phbCreation && typeof document.character.phbCreation === 'object') phbDocuments.set(JSON.stringify(document), document)
  }
  let phbImports = 0
  for (const [position, document] of [...phbDocuments.values()].entries()) {
    for (let variant = 0; variant < 8; variant += 1) {
      const character = structuredClone(document.character)
      const roll = { id: `wealth-${position}-${variant}`, class_id: character.characterClass, total_gp: c.pick([0, 15, 50, 200, 'x']), expression: '5d4', multiplier: 10 }
      if (variant % 2 === 1) {
        character.phbCreation = { ...character.phbCreation, equipmentMode: 'wealth', wealthRollId: c.chance(0.9) ? roll.id : 'other', purchases: c.chance(0.9) ? sample(purchaseIds, c.int(0, 4)).map((id) => ({ id, quantity: c.int(1, 3) })) : c.pick(['x', [null], [{ id: 'bogus', quantity: 1 }]]) }
        delete character.phbCreation.backgroundEquipmentChoices
      }
      if (variant === 2) character.backgroundChoices = { ...(character.backgroundChoices ?? {}), replacementSkills: sample(SKILLS, c.int(0, 2)) }
      if (variant === 4) Object.assign(character, mutate(character))
      if (variant === 6 && character.phbCreation.classChoices) character.phbCreation.classChoices = c.pick([{}, 'x', null])
      const doc = { ...document, character }
      const slot = { ...lifecycle.createCharacterSlot({ id: `phb-${position}`, index: position % 4 }), characterCreationRolls: { wealth: roll } }
      const state = { ruleset_id: 'dnd_5e_2014', players: [slot], mechanics: { combat: { active: false } }, ...(c.chance(0.5) ? { character_start_level: c.int(1, 5) } : {}) }
      run('parseCharacterImport', [doc, { rulesetId: 'dnd_5e_2014', validateCreationLanguages: true, trustedWealthRoll: roll }], { cap: 4000 })
      const validated = run('validateCharacterImportCommand', [{ command_type: 'ImportCharacter', actor_id: slot.id, document: doc }, state, { isAdmin: true }], { cap: 4000 })
      if (!validated.value) continue
      phbImports += 1
      const event = run('characterImportEvent', [validated.value], { cap: 4000 }).value
      const after = run('applyCharacterLifecycleEvent', [state, event], { cap: 4000 }).value
      if (!after) continue
      heroBattery(after.players[0], 'dnd_5e_2014')
      levelChain(after, slot.id, c.int(1, 5))
    }
  }
  console.error(`документов PHB ${phbDocuments.size}, импортов PHB ${phbImports}`)

  // Подмена события импорта: другой редакцией, без схемы, с пустым подклассом.
  for (const entry of captured.filter((item) => item.name === 'applyCharacterLifecycleEvent' && item.args[1]?.event_type === 'CharacterImported').slice(0, 60)) {
    const [state, event] = entry.args
    const variants = [
      { ...event, payload: { ...event.payload, ruleset_id: state?.ruleset_id === 'dnd_5e_2014' ? 'srd_5_2_1' : 'dnd_5e_2014' } },
      { ...event, payload: { ...event.payload, schema: undefined } },
      { ...event, payload: { ...event.payload, patch: { ...event.payload?.patch, subclass: '' } } },
      { ...event, payload: { ...event.payload, species_policy_version: 1 } },
      { ...event, payload: { ...event.payload, phb_creation_result: undefined } },
    ]
    for (const variant of variants) run('applyCharacterLifecycleEvent', [state, variant])
  }

  console.error(`перехвачено вызовов ${captureCount}; строк корпуса ${corpusRows}, состояний корпуса ${corpusStates}; импортов ${imports}; урезанный вход дал другой исход: ${differ}`)
  console.error([...importCodes].map(([k, v]) => `${k} ${v}`).join(", "))
  writer.write(new URL('character-lifecycle.json', import.meta.url))
  console.error(`sha256 эталона ${sha256(readFileSync(new URL('character-lifecycle.json', import.meta.url), 'utf8')).slice(0, 12)}`)
})
