import { readFileSync } from 'node:fs'

import { ammunitionCatalogIdForWeapon, catalogItem, materializeCatalogItem } from './item-catalog.mjs'
import { backgroundById } from './backgrounds.mjs'
import { DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID } from './ruleset-config.mjs'

const STARTING_GOLD = 20
const classicEquipment = JSON.parse(readFileSync(
  new URL('../data/starter-equipment-dnd-5e-2014.json', import.meta.url),
  'utf8',
))
const classicClassProfiles = new Map(classicEquipment.classes.map((entry) => [entry.class_id, entry]))

const WEAPONS = Object.freeze({
  dagger: Object.freeze({
    catalog_id: 'srd_5_2_1:dagger',
    description: 'Надёжный дорожный клинок из стартового снаряжения героя.',
    properties: '1к4 колющего урона · фехтовальное · лёгкое.',
  }),
  longsword: Object.freeze({
    catalog_id: 'srd_5_2_1:longsword',
    description: 'Сбалансированный строевой клинок из стартового снаряжения героя.',
    properties: '1к8 рубящего урона · универсальное (1к10).',
  }),
  shortbow: Object.freeze({
    catalog_id: 'srd_5_2_1:shortbow',
    description: 'Компактный охотничий лук из стартового снаряжения героя.',
    properties: '1к6 колющего урона · дальность 80/320 фт · боеприпас · двуручное.',
  }),
})

// Доспех и щит — из тех профилей, которые сервер действительно считает
// (DEFAULT_ARMOR_PROFILES в character-lifecycle.mjs). Без них жрец и воин
// выходили в первый бой с одним кинжалом и КД 12, как волшебник.
const ARMOUR = Object.freeze({
  leather: Object.freeze({
    catalog_id: 'srd_5_2_1:leather-armor',
    description: 'Лёгкий дорожный доспех из стартового снаряжения героя.',
    properties: 'КД 11 + модификатор Ловкости · лёгкий доспех.',
  }),
  shield: Object.freeze({
    catalog_id: 'srd_5_2_1:shield',
    description: 'Окованный щит из стартового снаряжения героя.',
    properties: '+2 к КД · занимает одну руку.',
  }),
})

const CLASS_PROFILES = Object.freeze([
  { key: 'barbarian', pattern: /варвар|barbarian/u, weapon: 'longsword', gear: [], abilities: { str: 16, dex: 12, con: 15, int: 8, wis: 10, cha: 13 } },
  { key: 'fighter', pattern: /воин|fighter/u, weapon: 'longsword', gear: ['leather', 'shield'], abilities: { str: 16, dex: 12, con: 15, int: 10, wis: 13, cha: 8 } },
  { key: 'paladin', pattern: /паладин|paladin/u, weapon: 'longsword', gear: ['leather', 'shield'], abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 12, cha: 15 } },
  { key: 'ranger', pattern: /следопыт|ranger/u, weapon: 'shortbow', gear: ['leather'], abilities: { str: 10, dex: 16, con: 14, int: 12, wis: 15, cha: 8 } },
  { key: 'rogue', pattern: /плут|разбойник|rogue/u, weapon: 'dagger', gear: ['leather'], abilities: { str: 8, dex: 16, con: 14, int: 13, wis: 10, cha: 15 } },
  { key: 'monk', pattern: /монах|monk/u, weapon: 'dagger', gear: [], abilities: { str: 10, dex: 16, con: 14, int: 8, wis: 15, cha: 12 } },
  { key: 'cleric', pattern: /жрец|cleric/u, weapon: 'dagger', gear: ['leather', 'shield'], abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 16, cha: 15 } },
  { key: 'druid', pattern: /друид|druid/u, weapon: 'dagger', gear: ['leather'], abilities: { str: 10, dex: 13, con: 14, int: 12, wis: 16, cha: 8 } },
  { key: 'bard', pattern: /бард|bard/u, weapon: 'dagger', gear: ['leather'], abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 16 } },
  { key: 'sorcerer', pattern: /чарод|sorcer/u, weapon: 'dagger', gear: [], abilities: { str: 8, dex: 14, con: 15, int: 10, wis: 12, cha: 16 } },
  { key: 'warlock', pattern: /колдун|warlock/u, weapon: 'dagger', gear: ['leather'], abilities: { str: 8, dex: 14, con: 15, int: 12, wis: 10, cha: 16 } },
  { key: 'wizard', pattern: /волшеб|wizard|маг\b/u, weapon: 'dagger', gear: [], abilities: { str: 8, dex: 14, con: 13, int: 16, wis: 15, cha: 10 } },
])

function totalCurrency(currency = {}) {
  return Number(currency.copper || 0) + Number(currency.silver || 0) * 10 + Number(currency.gold || 0) * 100 + Number(currency.platinum || 0) * 1_000
}
function abilityScoresAreBlank(abilities = {}) {
  return ['str', 'dex', 'con', 'int', 'wis', 'cha'].every((key) => Number(abilities[key] ?? 10) === 10)
}

function starterWeapon(heroId, weaponKey) {
  const template = WEAPONS[weaponKey] ?? WEAPONS.dagger
  return materializeCatalogItem(template.catalog_id, {
    id: `${heroId}-starter-${weaponKey}`.slice(0, 120),
    ...structuredClone(template),
    quantity: 1,
    equipped: true,
    rarity: 'обычный',
    image: '',
    imageStatus: 'ready',
  })
}

/**
 * Колчан к стартовому оружию. Выводится из самого оружия, а не приписан классу:
 * с 2026-08-18 выстрел снимает снаряд у героя так же, как у противника
 * (`server/npc-equipment.mjs`), и лук без стрел означал бы следопыта, которому
 * сервер честно отказывает в первой же дальней атаке. Оружие без свойства
 * `ammunition` (кинжал, длинный меч) колчана не получает — возвращается `null`.
 */
function starterAmmunition(heroId, weaponKey) {
  const template = WEAPONS[weaponKey] ?? WEAPONS.dagger
  const catalogId = ammunitionCatalogIdForWeapon(template.catalog_id)
  const entry = catalogId ? catalogItem(catalogId) : null
  if (!entry) return null
  return materializeCatalogItem(catalogId, {
    id: `${heroId}-starter-ammunition`.slice(0, 120),
    description: 'Полный комплект снарядов из стартового снаряжения героя.',
    properties: `Комплект из ${Math.max(1, Number(entry.ammunition?.amount) || 1)} шт. Каждый выстрел снимает один снаряд.`,
    quantity: 1,
    equipped: false,
    rarity: 'обычный',
    image: '',
    imageStatus: 'ready',
  })
}

function starterGear(heroId, gearKey) {
  const template = ARMOUR[gearKey]
  if (!template) return null
  return materializeCatalogItem(template.catalog_id, {
    id: `${heroId}-starter-${gearKey}`.slice(0, 120),
    ...structuredClone(template),
    quantity: 1,
    equipped: true,
    rarity: 'обычный',
    image: '',
    imageStatus: 'ready',
  })
}

function classicStarterItem(heroId, item, index, prefix = 'class') {
  const entry = catalogItem(item.catalog_id)
  if (!entry) throw new TypeError(`Стартовый набор 2014 ссылается на неизвестный предмет ${item.catalog_id}`)
  return materializeCatalogItem(item.catalog_id, {
    id: `${heroId}-starter-${prefix}-${index + 1}`.slice(0, 120),
    quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1)),
    equipped: item.equipped === true,
    rarity: 'обычный',
    image: '',
    imageStatus: 'ready',
  })
}

function narrativeStarterItem(heroId, entry, index, prefix) {
  return {
    id: `${heroId}-starter-${prefix}-${index + 1}`.slice(0, 120),
    name: String(entry.name ?? 'Личные вещи').slice(0, 160),
    type: 'other',
    quantity: 1,
    weight: 0,
    description: String(entry.description ?? '').slice(0, 2_000),
    properties: 'Нарративный предмет; механическое применение требует подтверждённого правила.',
    mechanics_status: 'ruling-only',
    sellable: false,
    equipped: false,
  }
}

export function starterEquipmentCatalogFor(rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  if (rulesetId !== DND_2014_RULESET_ID) return null
  const labelItem = (item) => ({
    ...structuredClone(item),
    ...(item.catalog_id ? { name: catalogItem(item.catalog_id)?.name ?? item.catalog_id } : {}),
  })
  return {
    ...structuredClone(classicEquipment),
    classes: classicEquipment.classes.map((profile) => ({
      ...structuredClone(profile),
      fixed_items: (profile.fixed_items ?? []).map(labelItem),
      fixed_narrative_items: (profile.fixed_narrative_items ?? []).map(labelItem),
      choice_groups: (profile.choice_groups ?? []).map((group) => ({
        ...structuredClone(group),
        options: (group.options ?? []).map((option) => ({
          ...structuredClone(option),
          items: (option.items ?? []).map(labelItem),
          narrative_items: (option.narrative_items ?? []).map(labelItem),
        })),
      })),
    })),
  }
}

export function defaultStarterEquipmentChoices(classId, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  if (rulesetId !== DND_2014_RULESET_ID) return {}
  const profile = classicClassProfiles.get(String(classId ?? ''))
  if (!profile) return null
  return Object.fromEntries((profile.choice_groups ?? []).map((group) => [
    group.id,
    (group.options ?? []).slice(0, Number(group.count ?? 0)).map((option) => option.id),
  ]))
}

export function resolveStarterEquipmentChoices(classId, choices = {}, rulesetId = LEGACY_DEFAULT_RULESET_ID) {
  if (rulesetId !== DND_2014_RULESET_ID) return { ok: true, choices: {}, selected_options: [], profile: null }
  const profile = classicClassProfiles.get(String(classId ?? ''))
  if (!profile) return { ok: false, reason: 'Для класса нет стартового набора 2014' }
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return { ok: false, reason: 'starterEquipmentChoices должен быть объектом' }
  const groups = profile.choice_groups ?? []
  const allowedGroups = new Set(groups.map((group) => String(group.id)))
  for (const key of Object.keys(choices)) if (!allowedGroups.has(key)) return { ok: false, reason: `Группа снаряжения ${key} не принадлежит классу` }
  const resolved = {}
  const selectedOptions = []
  for (const group of groups) {
    const selected = Array.isArray(choices[group.id]) ? choices[group.id].map(String) : []
    const expected = Math.max(0, Number(group.count ?? 0))
    if (selected.length !== expected || new Set(selected).size !== selected.length) return { ok: false, reason: `${group.label}: нужно выбрать ${expected}` }
    const byId = new Map((group.options ?? []).map((option) => [String(option.id), option]))
    if (selected.some((id) => !byId.has(id))) return { ok: false, reason: `${group.label}: неизвестный вариант` }
    resolved[group.id] = selected
    selectedOptions.push(...selected.map((id) => ({ group_id: group.id, ...structuredClone(byId.get(id)) })))
  }
  return { ok: true, choices: resolved, selected_options: selectedOptions, profile: structuredClone(profile) }
}

function classicStarterInventory(hero, profile, { policyVersion = classicEquipment.policy_version } = {}) {
  const heroId = String(hero?.id || 'hero')
  let classItems
  if (Number(policyVersion) < 2) {
    classItems = (profile?.legacy_default_items ?? []).map((item, index) => classicStarterItem(heroId, item, index))
  } else {
    const requestedChoices = hero?.starterEquipmentChoices
      ?? defaultStarterEquipmentChoices(hero?.characterClass, DND_2014_RULESET_ID)
      ?? {}
    const resolved = resolveStarterEquipmentChoices(hero?.characterClass, requestedChoices, DND_2014_RULESET_ID)
    if (!resolved.ok) throw new TypeError(resolved.reason)
    const selectedItems = resolved.selected_options.flatMap((option) => option.items ?? [])
    const selectedNarrative = resolved.selected_options.flatMap((option) => option.narrative_items ?? [])
    classItems = [...(profile?.fixed_items ?? []), ...selectedItems]
      .map((item, index) => classicStarterItem(heroId, item, index))
    classItems.push(...[...(profile?.fixed_narrative_items ?? []), ...selectedNarrative]
      .map((item, index) => narrativeStarterItem(heroId, item, index, 'class-keepsake')))
  }
  const background = backgroundById(hero?.backgroundId, DND_2014_RULESET_ID)
  const backgroundItems = (background?.equipment?.catalogItems ?? [])
    .map((item, index) => classicStarterItem(heroId, item, index, 'background'))
  if (background?.equipment?.includeChosenTool) {
    const selected = new Set(hero?.backgroundChoices?.tools ?? [])
    const tool = (background.toolChoice?.options ?? []).find((entry) => selected.has(entry.id) && entry.catalogId)
    if (tool?.catalogId) backgroundItems.push(classicStarterItem(heroId, { catalog_id: tool.catalogId, quantity: 1 }, backgroundItems.length, 'background-tool'))
  }
  if (background?.equipment?.summary) {
    backgroundItems.push(narrativeStarterItem(heroId, {
      name: `${background.name}: личные вещи`,
      description: String(background.equipment.summary),
    }, 0, 'background-keepsakes'))
  }
  return [...classItems, ...backgroundItems]
}

/** Supplies only missing first-session essentials; imported, already-built
 * character sheets keep their money, abilities and equipment unchanged. */
export function withStarterKit(hero, { rulesetId = LEGACY_DEFAULT_RULESET_ID, starterPolicyVersion = classicEquipment.policy_version } = {}) {
  const role = `${hero?.role ?? ''} ${hero?.characterClass ?? ''}`.toLocaleLowerCase('ru')
  const profile = CLASS_PROFILES.find((entry) => entry.key === hero?.characterClass || entry.pattern.test(role))
  const heroId = String(hero?.id || 'hero')
  const classicProfile = classicClassProfiles.get(hero?.characterClass ?? profile?.key)
  const inventory = Array.isArray(hero?.inventory) && hero.inventory.length
    ? structuredClone(hero.inventory)
    : rulesetId === DND_2014_RULESET_ID
      ? classicProfile
        ? classicStarterInventory(hero, classicProfile, { policyVersion: starterPolicyVersion })
        : [starterWeapon(heroId, profile?.weapon ?? 'dagger')]
      : [
        starterWeapon(heroId, profile?.weapon ?? 'dagger'),
        ...[starterAmmunition(heroId, profile?.weapon ?? 'dagger')].filter(Boolean),
        ...(profile?.gear ?? []).map((key) => starterGear(heroId, key)).filter(Boolean),
      ]
  const currency = totalCurrency(hero?.currency) > 0
    ? structuredClone(hero.currency)
    : rulesetId === DND_2014_RULESET_ID
      ? { copper: 0, silver: 0, gold: Math.max(0, Number(backgroundById(hero?.backgroundId, DND_2014_RULESET_ID)?.equipment?.gold) || 0), platinum: 0 }
      : { copper: 0, silver: 0, gold: STARTING_GOLD, platinum: 0 }
  const abilities = abilityScoresAreBlank(hero?.abilities) && profile
    ? structuredClone(profile.abilities)
    : structuredClone(hero?.abilities ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 })
  return {
    ...hero,
    ...(profile && !hero?.characterClass ? { characterClass: profile.key } : {}),
    inventory,
    currency,
    abilities,
    ...(rulesetId === DND_2014_RULESET_ID && classicProfile ? {
      starterEquipmentPolicyId: classicEquipment.policy_id,
      starterEquipmentPolicyVersion: classicEquipment.policy_version,
      starterEquipmentChoices: structuredClone(hero?.starterEquipmentChoices
        ?? defaultStarterEquipmentChoices(hero?.characterClass, DND_2014_RULESET_ID)
        ?? {}),
    } : {}),
  }
}
