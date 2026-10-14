import '../../../fixtures-env.mjs'
// Эталоны `server/starter-kit.mjs` для Rust-переноса (`sk-chargen`).
//
// Снаряжение для всех классов × предысторий × редакций (2014 legacy и полный
// PHB, 2024 прежний набор и вариант A SRD 5.2.1), выбор и проверка групп
// снаряжения, каталог стартового снаряжения, а также сотни случайных и
// мусорных героев. Большие результаты (герой со всем инвентарём, полный
// каталог) пишутся хешем `JSON.stringify` — Rust сверяет свою строку байт в
// байт. `FULL=1` пишет их целиком (для разбора расхождений; в git не кладётся).
//
// Запуск: node rust/crates/sk-chargen/fixtures/gen-starter-kit.mjs
import { PROTOTYPE_KEYS, chooser, recorder, rng } from './record.mjs'

const root = new URL('../../../../', import.meta.url)
const S = await import(new URL('server/starter-kit.mjs', root).href)
const { defaultBackgroundChoices } = await import(new URL('server/backgrounds.mjs', root).href)

const FULL = process.env.FULL === '1'
const random = rng(20261014)
const { pick, int, chance, sample } = chooser(random)
const r = recorder('server/starter-kit.mjs')
const big = (name, fn, ...args) => (FULL ? r.call(name, fn, ...args) : r.hashed(name, fn, ...args))

const RULESET_2014 = 'dnd_5e_2014'
const RULESET_2024 = 'srd_5_2_1'
const KIT_POLICY = S.STARTER_KIT_2024_POLICY.policy_id
const CLASSES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard']
const BACKGROUNDS = ['acolyte', 'charlatan', 'criminal', 'entertainer', 'folk-hero', 'guild-artisan', 'hermit', 'noble', 'outlander', 'sage', 'sailor', 'soldier', 'urchin']
const ODD_CLASSES = ['artificer', '', 'Fighter', ' fighter', 'fighter-dex', ...PROTOTYPE_KEYS.slice(0, 4), '__proto__']
const TOOLS = ['dice_set', 'playing_cards', 'dragonchess', 'three_dragon_ante', 'lute', 'flute', 'drum', 'smiths_tools', 'cooks_utensils', 'alchemists_supplies', 'thieves_tools', 'disguise_kit', 'not-a-tool']
const ROLES = ['Воин', 'Следопыт', 'Волшебник', 'маг', 'Маг', 'магa', 'Плут · ур. 1', 'Жрец · ур. 1', 'Разбойник', 'Чародейка', 'Колдун', 'Друид', 'Бард', 'Монах', 'Паладин', 'Варвар', 'BARBARIAN', 'wizard', 'sorcerer', 'странник', '', 'Воин-паладин']

r.constant('STARTER_KIT_2024_POLICY', S.STARTER_KIT_2024_POLICY)

// ---------- starterKit2024Preview ----------
for (const key of [...CLASSES, 'fighter-dex', 'unknown', '', undefined, null, ...PROTOTYPE_KEYS]) {
  r.call('starterKit2024Preview', S.starterKit2024Preview, key)
}

// ---------- starterEquipmentCatalogFor ----------
for (const ruleset of [RULESET_2014, RULESET_2024, '', undefined, null, 'dnd_5e_2024']) {
  for (const options of [undefined, {}, { complete: true }, { complete: false }, { complete: 1 }, { complete: 0 }]) {
    big('starterEquipmentCatalogFor', S.starterEquipmentCatalogFor, ruleset, options)
  }
}
const publicComplete = S.starterEquipmentCatalogFor(RULESET_2014, { complete: true })
const publicLegacy = S.starterEquipmentCatalogFor(RULESET_2014)
const completeClass = new Map(publicComplete.classes.map((entry) => [entry.class_id, entry]))
const legacyClass = new Map(publicLegacy.classes.map((entry) => [entry.class_id, entry]))
const completeBackground = new Map(publicComplete.backgrounds.map((entry) => [entry.background_id, entry]))
// Скрытые дедупликацией публичного каталога, но допустимые варианты.
const HIDDEN_OPTIONS = { fighter: { 'melee-loadout': ['martial-and-shield-longsword', 'two-martial-weapons-shortsword-shortsword', 'martial-and-shield-battleaxe'] } }

// ---------- defaultStarterEquipmentChoices ----------
for (const classId of [...CLASSES, ...ODD_CLASSES, undefined, null, 5, ['fighter']]) {
  for (const ruleset of [RULESET_2014, RULESET_2024, undefined]) {
    for (const options of [undefined, { complete: true }]) r.call('defaultStarterEquipmentChoices', S.defaultStarterEquipmentChoices, classId, ruleset, options)
  }
}

// ---------- resolveStarterEquipmentChoices ----------
function randomChoices(profile, classId, complete) {
  const choices = {}
  for (const group of profile.choice_groups ?? []) {
    const ids = group.options.map((option) => option.id)
    const hidden = complete ? HIDDEN_OPTIONS[classId]?.[group.id] ?? [] : []
    choices[group.id] = sample([...ids, ...hidden], group.count)
  }
  return choices
}
function corrupt(choices, profile) {
  const copy = structuredClone(choices)
  const groups = profile.choice_groups ?? []
  const group = groups.length ? pick(groups) : null
  switch (int(0, 9)) {
    case 0: copy['not-a-group'] = ['x']; break
    case 1: if (group) delete copy[group.id]; break
    case 2: if (group) copy[group.id] = [...(copy[group.id] ?? []), ...(copy[group.id] ?? [])]; break
    case 3: if (group) copy[group.id] = ['unknown-option']; break
    case 4: if (group) copy[group.id] = group.options[0]?.id ?? 'x'; break
    case 5: if (group) copy[group.id] = []; break
    case 6: if (group) copy[group.id] = [7]; break
    case 7: if (group) copy[group.id] = [null]; break
    case 8: return { ...copy, ['0']: ['x'] }
    default: if (group) copy[group.id] = [group.options.at(-1)?.id, group.options[0]?.id].slice(0, group.count); break
  }
  return copy
}
for (const classId of CLASSES) {
  for (const complete of [false, true]) {
    const profile = (complete ? completeClass : legacyClass).get(classId)
    const call = complete ? big : r.call.bind(r)
    const defaults = S.defaultStarterEquipmentChoices(classId, RULESET_2014, { complete })
    call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, defaults, RULESET_2014, { complete })
    for (let index = 0; index < 8; index += 1) {
      const choices = randomChoices(profile, classId, complete)
      call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, choices, RULESET_2014, { complete })
      r.call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, corrupt(choices, profile), RULESET_2014, { complete })
    }
  }
  for (const junk of [undefined, null, [], 'armor', 5, {}, { armor: 'chain-mail' }]) {
    r.call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, junk, RULESET_2014)
  }
  r.call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, {}, RULESET_2024)
  r.call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, null, undefined)
}
for (const classId of [...ODD_CLASSES, undefined, null]) {
  r.call('resolveStarterEquipmentChoices', S.resolveStarterEquipmentChoices, classId, {}, RULESET_2014, { complete: true })
}

// ---------- validateCompleteBackgroundChoices / completeBackgroundChoicesForHero ----------
function randomBackgroundChoices(background) {
  const choices = {}
  for (const group of background.choice_groups ?? []) choices[group.id] = sample(group.options.map((option) => option.id), group.count)
  return choices
}
for (const backgroundId of [...BACKGROUNDS, 'unknown', '', ...PROTOTYPE_KEYS.slice(0, 3)]) {
  const background = completeBackground.get(backgroundId)
  r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, backgroundId, undefined)
  r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, backgroundId, null)
  r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, backgroundId, [])
  r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, backgroundId, { extra: ['x'] })
  if (background) {
    for (let index = 0; index < 6; index += 1) {
      const choices = randomBackgroundChoices(background)
      r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, backgroundId, choices)
      r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, backgroundId, corrupt(choices, background))
    }
    r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, background, randomBackgroundChoices(background))
  }
  const heroes = [
    { backgroundId },
    { backgroundId, phbCreation: { backgroundEquipmentChoices: background ? randomBackgroundChoices(background) : { x: ['y'] } } },
    { backgroundId, backgroundEquipmentChoices: background ? randomBackgroundChoices(background) : {} },
    { backgroundId, phbCreation: { backgroundEquipmentChoices: [] }, backgroundEquipmentChoices: { 'artisan-tool': ['smiths_tools'] } },
    { backgroundId, backgroundChoices: { tools: sample(TOOLS, int(1, 3)) } },
    { backgroundId, backgroundChoices: { tools: TOOLS } },
    { backgroundId, backgroundChoices: { tools: 'dice_set' } },
    { backgroundId, backgroundChoices: { tools: [5, null, 'lute'] } },
    { backgroundId, phbCreation: null, backgroundChoices: null },
  ]
  for (const hero of heroes) {
    r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, hero)
    r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, hero, pick(BACKGROUNDS))
    r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, hero, null)
    if (background) r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, hero, background)
  }
}
for (const background of [0, false, '', {}, { choice_groups: [] }, { choice_groups: [{ id: 'gaming-set', count: 1, options: [{ id: 'dice_set' }] }] }]) {
  r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, { backgroundChoices: { tools: ['dice_set'] } }, background)
  r.call('validateCompleteBackgroundChoices', S.validateCompleteBackgroundChoices, background, {})
}
r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, undefined)
r.call('completeBackgroundChoicesForHero', S.completeBackgroundChoicesForHero, null, 'soldier')

// ---------- withStarterKit ----------
const MODES_2014 = [
  { options: { rulesetId: RULESET_2014 } },
  { options: { rulesetId: RULESET_2014, starterPolicyVersion: 1 } },
  { options: { rulesetId: RULESET_2014, starterPolicyVersion: '1' } },
  { options: { rulesetId: RULESET_2014, starterPolicyVersion: null } },
  { options: { rulesetId: RULESET_2014, complete: true } },
  { options: { rulesetId: RULESET_2014 }, hero: { phbCreation: { schema_version: 1 } } },
  { options: { rulesetId: RULESET_2014, starterPolicyId: KIT_POLICY } },
]
const MODES_2024 = [
  { options: {} },
  { options: { rulesetId: RULESET_2024 } },
  { options: { rulesetId: RULESET_2024, starterPolicyId: KIT_POLICY } },
  { options: { rulesetId: 'dnd_5e_2024', starterPolicyId: KIT_POLICY } },
  { options: { rulesetId: RULESET_2024, starterPolicyId: 'other-policy' } },
]
let withCount = 0
const kit = (hero, options) => {
  withCount += 1
  // Первые случаи — целиком, чтобы расхождение было видно и без FULL.
  return withCount <= 40 ? r.call('withStarterKit', S.withStarterKit, hero, options) : big('withStarterKit', S.withStarterKit, hero, options)
}
for (const classId of CLASSES) {
  for (const backgroundId of [...BACKGROUNDS, 'unknown', undefined]) {
    const backgroundChoices = backgroundId && BACKGROUNDS.includes(backgroundId) ? defaultBackgroundChoices(backgroundId, RULESET_2014) : undefined
    for (const mode of MODES_2014) {
      kit({ id: `hero-${classId}-${backgroundId}`, characterClass: classId, backgroundId, backgroundChoices, inventory: [], currency: {}, ...(mode.hero ?? {}) }, mode.options)
    }
  }
  for (const mode of MODES_2024) {
    kit({ id: `hero-${classId}`, characterClass: classId, level: 1, inventory: [], currency: {} }, mode.options)
    kit({ id: `hero-${classId}-dex`, characterClass: classId, abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 12, cha: 8 } }, mode.options)
  }
}
// Выбор групп снаряжения и предыстории в полном и legacy режиме.
for (let index = 0; index < 220; index += 1) {
  const classId = pick(CLASSES)
  const backgroundId = pick([...BACKGROUNDS, 'unknown'])
  const complete = chance(0.6)
  const profile = (complete ? completeClass : legacyClass).get(classId)
  let choices = randomChoices(profile, classId, complete)
  if (chance(0.15)) choices = corrupt(choices, profile)
  const background = completeBackground.get(backgroundId)
  const hero = {
    id: pick([`random-${index}`, 0, '', 'герой-😀'.repeat(20), 'x'.repeat(130), null]),
    characterClass: classId,
    backgroundId,
    backgroundChoices: chance(0.7) ? { tools: sample(TOOLS, int(0, 3)), languages: [] } : undefined,
    inventory: [],
    currency: chance(0.5) ? {} : { copper: 0, silver: 0, gold: 0, platinum: 0 },
  }
  if (chance(0.5)) hero.starterEquipmentChoices = choices
  if (complete) {
    hero.phbCreation = { schema_version: pick([1, '1', 1.0]) }
    if (chance(0.5)) hero.phbCreation.classEquipmentChoices = choices
    if (background && chance(0.5)) hero.phbCreation.backgroundEquipmentChoices = chance(0.85) ? randomBackgroundChoices(background) : corrupt(randomBackgroundChoices(background), background)
  }
  kit(hero, { rulesetId: RULESET_2014, ...(chance(0.2) ? { complete: true } : {}) })
}
// Герои по роли, импортированные листы и мусор.
for (const role of ROLES) {
  for (const options of [{}, { rulesetId: RULESET_2014 }, { rulesetId: RULESET_2024, starterPolicyId: KIT_POLICY }]) {
    kit({ id: `role-${role}`, role }, options)
    kit({ id: `role-${role}`, role, characterClass: pick([...CLASSES, null, '']) }, options)
  }
}
const JUNK_HEROES = [
  undefined,
  null,
  {},
  { id: 'imported', characterClass: 'fighter', inventory: [{ id: 'own-sword', name: 'Свой меч', type: 'weapon', quantity: 1 }], currency: { gold: 3 }, abilities: { str: 18, dex: 8, con: 14, int: 10, wis: 10, cha: 10 } },
  { id: 'rich', characterClass: 'wizard', currency: { copper: '5' } },
  { id: 'nan-currency', characterClass: 'wizard', currency: { copper: 'abc' } },
  { id: 'null-currency', characterClass: 'wizard', currency: null },
  { id: 'number-currency', characterClass: 'wizard', currency: 5 },
  { id: 'null-abilities', characterClass: 'wizard', abilities: null },
  { id: 'string-abilities', characterClass: 'fighter', abilities: 'strong' },
  { id: 'array-abilities', characterClass: 'fighter', abilities: [] },
  { id: 'number-class', characterClass: 5 },
  { id: 'array-class', characterClass: ['fighter'] },
  { id: 'proto-class', characterClass: 'constructor' },
  { id: 'proto-class-2', characterClass: 'toString' },
  { id: 'proto-class-3', characterClass: '__proto__' },
  { id: 'empty-inventory-object', characterClass: 'rogue', inventory: {} },
  { id: 'string-tools', characterClass: 'fighter', backgroundId: 'guild-artisan', backgroundChoices: { tools: 'smiths_tools' } },
  { id: 'number-tools', characterClass: 'fighter', backgroundId: 'guild-artisan', backgroundChoices: { tools: 5 } },
  { id: 'object-tools', characterClass: 'fighter', backgroundId: 'guild-artisan', backgroundChoices: { tools: { a: 1 } } },
  { id: 'bool-tools', characterClass: 'fighter', backgroundId: 'folk-hero', backgroundChoices: { tools: true } },
  { id: 'chosen-tool', characterClass: 'fighter', backgroundId: 'folk-hero', backgroundChoices: { tools: ['cooks_utensils', 'smiths_tools'] } },
  { id: 'choices-string', characterClass: 'fighter', starterEquipmentChoices: 'chain-mail' },
  { id: 'choices-null', characterClass: 'fighter', starterEquipmentChoices: null },
  { id: 'phb-null', characterClass: 'fighter', phbCreation: null },
  { id: 'phb-choices-null', characterClass: 'fighter', phbCreation: { schema_version: 1, classEquipmentChoices: null, backgroundEquipmentChoices: null }, backgroundId: 'soldier' },
  { id: 'phb-bg-array', characterClass: 'fighter', phbCreation: { schema_version: 1, backgroundEquipmentChoices: [] }, backgroundId: 'soldier', backgroundChoices: { tools: ['dragonchess'] } },
  { id: 'phb-bg-old-tools', characterClass: 'bard', phbCreation: { schema_version: 1 }, backgroundId: 'entertainer', backgroundChoices: { tools: ['flute', 'lute'] } },
  { id: 'phb-guild-tools', characterClass: 'bard', phbCreation: { schema_version: 1 }, backgroundId: 'guild-artisan', backgroundChoices: { tools: ['smiths_tools'] } },
  { id: 'phb-net', characterClass: 'fighter', backgroundId: 'criminal', phbCreation: { schema_version: 1 }, starterEquipmentChoices: { armor: ['chain-mail'], 'melee-loadout': ['martial-and-shield-net'], secondary: ['light-crossbow'], pack: ['dungeoneers-pack'] } },
  { id: 'phb-explorer', characterClass: 'wizard', backgroundId: 'sage', phbCreation: { schema_version: 1 }, starterEquipmentChoices: { weapon: ['quarterstaff'], focus: ['component-pouch'], pack: ['explorers-pack'] } },
  { id: 'phb-gladiator', characterClass: 'fighter', backgroundId: 'entertainer', phbCreation: { schema_version: 1, backgroundEquipmentChoices: { 'musical-instrument': ['gladiator-net'] } } },
  { id: 'phb-mule', characterClass: 'fighter', backgroundId: 'guild-artisan', phbCreation: { schema_version: 1, backgroundEquipmentChoices: { 'artisan-tool': ['guild-merchant-mule-cart'] } } },
  { id: 'no-class-2014', role: 'Воин', backgroundId: 'soldier' },
  { id: 'zero-id', characterClass: 'monk' },
  { id: 'blank-abilities', characterClass: 'monk', abilities: { str: '10', dex: 10 } },
  { id: 'ability-strings', characterClass: 'fighter', abilities: { str: '8', dex: '16' } },
  { id: 'ordered', zeta: 1, 10: 'index', alpha: 2, characterClass: 'cleric', 2: 'two' },
]
for (const hero of JUNK_HEROES) {
  for (const options of [undefined, { rulesetId: RULESET_2014 }, { rulesetId: RULESET_2014, complete: true }, { rulesetId: RULESET_2024, starterPolicyId: KIT_POLICY }, { rulesetId: RULESET_2024 }]) {
    kit(hero, options)
  }
}

r.write('starter-kit.json')
