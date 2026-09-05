import { readFileSync } from 'node:fs'

import { ammunitionCatalogIdForWeapon, catalogItem, materializeCatalogItem } from './item-catalog.mjs'
import { backgroundById } from './backgrounds.mjs'
import {
  PHB_2014_ARTISAN_TOOLS,
  PHB_2014_GAMING_SETS,
  PHB_2014_MUSICAL_INSTRUMENTS,
} from './character-creation-class-options.mjs'
import { DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID } from './ruleset-config.mjs'

const STARTING_GOLD = 20
const classicEquipment = JSON.parse(readFileSync(
  new URL('../data/starter-equipment-dnd-5e-2014.json', import.meta.url),
  'utf8',
))
const classicClassProfiles = new Map(classicEquipment.classes.map((entry) => [entry.class_id, entry]))

// PHB 2014 разрешает несколько вариантов «любого оружия». Старый policy v2
// оставляет короткий allowlist для совместимости, а complete-режим расширяет
// ровно эти группы до базовых таблиц оружия PHB. Мушкеты, пистолеты и прочие
// не относящиеся к PHB записи намеренно сюда не попадают.
const PHB_SIMPLE_MELEE_WEAPONS = Object.freeze([
  'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'light-hammer', 'mace',
  'quarterstaff', 'sickle', 'spear',
])
const PHB_SIMPLE_RANGED_WEAPONS = Object.freeze(['light-crossbow', 'dart', 'shortbow', 'sling'])
const PHB_MARTIAL_MELEE_WEAPONS = Object.freeze([
  'battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd', 'lance', 'longsword',
  'maul', 'morningstar', 'pike', 'rapier', 'scimitar', 'shortsword', 'trident', 'warhammer',
  'war-pick', 'whip',
])
const PHB_MARTIAL_RANGED_WEAPONS = Object.freeze(['blowgun', 'hand-crossbow', 'heavy-crossbow', 'longbow', 'net'])
const PHB_SIMPLE_WEAPONS = Object.freeze([...PHB_SIMPLE_MELEE_WEAPONS, ...PHB_SIMPLE_RANGED_WEAPONS])
const PHB_MARTIAL_WEAPONS = Object.freeze([...PHB_MARTIAL_MELEE_WEAPONS, ...PHB_MARTIAL_RANGED_WEAPONS])

// Сеть отсутствует в небольшом серверном item-catalog. Она всё равно является
// обычным оружием PHB, поэтому complete-режим материализует её как безопасную
// описательную вещь с правильным типом, количеством и весом.
const PHB_MISSING_ITEMS = Object.freeze({
  'srd_5_2_1:net': { name: 'Сеть', type: 'weapon', weight: 3, mechanics_status: 'partial', description: 'Специальное метательное оружие PHB 2014.' },
})

const COMPLETE_CLASS_DYNAMIC_GROUPS = Object.freeze({
  barbarian: Object.freeze({ 'primary-weapon': 'martial-melee', 'secondary-weapon': 'simple' }),
  bard: Object.freeze({ weapon: 'simple', instrument: 'musical' }),
  cleric: Object.freeze({ 'ranged-or-simple': 'simple' }),
  druid: Object.freeze({ defense: 'simple', weapon: 'simple-melee' }),
  fighter: Object.freeze({ 'melee-loadout': 'fighter-melee' }),
  monk: Object.freeze({ weapon: 'simple' }),
  paladin: Object.freeze({ 'melee-loadout': 'paladin-melee', secondary: 'simple-melee' }),
  ranger: Object.freeze({ melee: 'two-simple-melee' }),
  sorcerer: Object.freeze({ weapon: 'simple' }),
  warlock: Object.freeze({ ranged: 'simple', melee: 'simple' }),
  wizard: Object.freeze({ weapon: 'simple' }),
})

const NARRATIVE_ITEM_DEFAULTS = Object.freeze({
  'Набор дипломата': { type: 'pack', weight: 35, contents: [{ name: 'Сундук', quantity: 1, weight: 25 }, { name: 'Футляр для карт или свитков', quantity: 2, weight: 2 }, { name: 'Парадная одежда', quantity: 1, weight: 6 }, { name: 'Чернила', quantity: 1, weight: 0 }, { name: 'Перо', quantity: 1, weight: 0 }, { name: 'Масло', quantity: 2, weight: 2 }, { name: 'Бумага', quantity: 5, weight: 0 }, { name: 'Духи', quantity: 1, weight: 0 }, { name: 'Воск', quantity: 1, weight: 0 }, { name: 'Мыло', quantity: 1, weight: 0 }] },
  'Набор артиста': { type: 'pack', weight: 38, contents: [{ name: 'Рюкзак', quantity: 1, weight: 5 }, { name: 'Спальный мешок', quantity: 1, weight: 7 }, { name: 'Костюм', quantity: 2, weight: 8 }, { name: 'Свеча', quantity: 5, weight: 0 }, { name: 'Сухой паёк, 1 день', quantity: 5, weight: 10 }, { name: 'Бурдюк', quantity: 1, weight: 5 }, { name: 'Набор для грима', quantity: 1, weight: 3 }] },
  'Набор священника': { type: 'pack', weight: 24, contents: [{ name: 'Рюкзак', quantity: 1, weight: 5 }, { name: 'Одеяло', quantity: 1, weight: 3 }, { name: 'Свеча', quantity: 10, weight: 0 }, { name: 'Огниво', quantity: 1, weight: 1 }, { name: 'Ящик для пожертвований', quantity: 1, weight: 1 }, { name: 'Благовония', quantity: 2, weight: 0 }, { name: 'Кадило', quantity: 1, weight: 0 }, { name: 'Облачение', quantity: 1, weight: 4 }, { name: 'Сухой паёк, 1 день', quantity: 2, weight: 4 }, { name: 'Бурдюк', quantity: 1, weight: 5 }] },
  'Набор исследователя подземелий': { type: 'pack', weight: 56.5, contents: [{ name: 'Рюкзак', quantity: 1, weight: 5 }, { name: 'Лом', quantity: 1, weight: 5 }, { name: 'Молоток', quantity: 1, weight: 3 }, { name: 'Питон', quantity: 10, weight: 2.5 }, { name: 'Факел', quantity: 10, weight: 10 }, { name: 'Огниво', quantity: 1, weight: 1 }, { name: 'Сухой паёк, 1 день', quantity: 10, weight: 20 }, { name: 'Бурдюк', quantity: 1, weight: 5 }, { name: 'Пеньковая верёвка, 50 футов', quantity: 1, weight: 5 }] },
  'Набор учёного': { type: 'pack', weight: 12, contents: [{ name: 'Рюкзак', quantity: 1, weight: 5 }, { name: 'Книга знаний', quantity: 1, weight: 5 }, { name: 'Чернила', quantity: 1, weight: 0 }, { name: 'Перо', quantity: 1, weight: 0 }, { name: 'Пергамент', quantity: 10, weight: 0 }, { name: 'Маленький мешок песка', quantity: 1, weight: 1 }, { name: 'Маленький нож', quantity: 1, weight: 1 }] },
  'Мешочек с компонентами': { type: 'focus', weight: 2, mechanics_status: 'partial' },
  'Магическая фокусировка': { type: 'focus', weight: 1, mechanics_status: 'partial' },
  'Книга заклинаний': { type: 'book', weight: 3, mechanics_status: 'partial' },
  'Священный символ': { type: 'focus', weight: 1, mechanics_status: 'partial' },
  'Друидический фокус': { type: 'focus', weight: 1, mechanics_status: 'partial' },
  'Воровские инструменты': { type: 'tool', weight: 1, mechanics_status: 'partial' },
})

const PHB_PACK_CONTENTS = Object.freeze({
  'srd_5_2_1:explorers-pack': [
    { name: 'Рюкзак', quantity: 1, weight: 5 }, { name: 'Спальный мешок', quantity: 1, weight: 7 }, { name: 'Кухонная утварь', quantity: 1, weight: 1 },
    { name: 'Огниво', quantity: 1, weight: 1 }, { name: 'Факел', quantity: 10, weight: 10 }, { name: 'Сухой паёк, 1 день', quantity: 10, weight: 20 },
    { name: 'Бурдюк', quantity: 1, weight: 5 }, { name: 'Пеньковая верёвка, 50 футов', quantity: 1, weight: 5 },
  ],
})

const PHB_TOOL_WEIGHTS = Object.freeze({
  bagpipes: 6, drum: 3, dulcimer: 10, flute: 1, lute: 2, lyre: 2, horn: 2, pan_flute: 2, shawm: 1, viol: 1,
  dice_set: 0, dragonchess: 0.5, playing_cards: 0, three_dragon_ante: 0,
  disguise_kit: 3, forgery_kit: 5, herbalism_kit: 3, navigators_tools: 2, poisoners_kit: 2, thieves_tools: 1,
  vehicles_land: 0, vehicles_water: 0,
})

const PHB_TOOL_NAMES = Object.freeze({
  bagpipes: 'Волынка', drum: 'Барабан', dulcimer: 'Цимбалы', flute: 'Флейта', lute: 'Лютня', lyre: 'Лира', horn: 'Рожок', pan_flute: 'Свирель', shawm: 'Шалмей', viol: 'Виола',
  dice_set: 'Набор костей', dragonchess: 'Набор драконьих шахмат', playing_cards: 'Набор игральных карт', three_dragon_ante: 'Набор «Ставка трёх драконов»',
  disguise_kit: 'Набор для грима', forgery_kit: 'Набор для подделок', herbalism_kit: 'Набор травника', navigators_tools: 'Инструменты навигатора', poisoners_kit: 'Инструменты отравителя', thieves_tools: 'Воровские инструменты',
  vehicles_land: 'Наземный транспорт', vehicles_water: 'Водный транспорт',
})

function phbToolCatalogId(toolId) {
  const converted = String(toolId).replaceAll('_', '-')
  const catalogId = `srd_5_2_1:${converted}`
  return catalogItem(catalogId) ? catalogId : null
}

function phbToolOption(toolId, kind) {
  const catalogId = phbToolCatalogId(toolId)
  const name = catalogItem(catalogId)?.name ?? PHB_TOOL_NAMES[toolId] ?? toolId
  const weight = Number(PHB_TOOL_WEIGHTS[toolId] ?? 0)
  if (catalogId) return { id: toolId, label: name, summary: `${name} · ${weight} фнт`, items: [{ catalog_id: catalogId, quantity: 1 }] }
  return { id: toolId, label: name, summary: `${name} · ${weight} фнт`, narrative_items: [{ name, type: 'tool', weight, quantity: 1, proficiency: kind }] }
}

function completeBackgroundChoiceOptions(source) {
  if (source === 'musical') return PHB_2014_MUSICAL_INSTRUMENTS.map((id) => phbToolOption(id, 'musical_instrument'))
  if (source === 'artisan') return PHB_2014_ARTISAN_TOOLS.map((id) => phbToolOption(id, 'artisan_tool'))
  if (source === 'gaming') return PHB_2014_GAMING_SETS.map((id) => phbToolOption(id, 'gaming_set'))
  return []
}

function completeBackgroundProfile(profile) {
  if (!profile) return null
  return {
    ...structuredClone(profile),
    choice_groups: (profile.choice_groups ?? []).map((group) => {
      const options = group.dynamic_source ? completeBackgroundChoiceOptions(group.dynamic_source) : (group.options ?? []).map((option) => structuredClone(option))
      if (profile.background_id === 'entertainer' && group.dynamic_source === 'musical') {
        for (const weapon of ['trident', 'net']) {
          const option = phbWeaponOption(weapon, { equipped: false, optionId: `gladiator-${weapon}` })
          options.push({ ...option, label: `Гладиатор: ${option.label}` })
        }
      }
      if (profile.background_id === 'guild-artisan' && group.dynamic_source === 'artisan') options.push({
        id: 'guild-merchant-mule-cart', label: 'Гильдейский торговец: мул и повозка',
        owned_assets: [{ id: 'mule', name: 'Мул', type: 'mount', quantity: 1 }, { id: 'cart', name: 'Повозка', type: 'vehicle', quantity: 1 }],
      })
      return { ...structuredClone(group), options }
    }),
  }
}

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

function classicStarterItem(heroId, item, index, prefix = 'class', { complete = false } = {}) {
  const entry = catalogItem(item.catalog_id)
  if (!entry) throw new TypeError(`Стартовый набор 2014 ссылается на неизвестный предмет ${item.catalog_id}`)
  const materialized = materializeCatalogItem(item.catalog_id, {
    id: `${heroId}-starter-${prefix}-${index + 1}`.slice(0, 120),
    quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1)),
    equipped: item.equipped === true,
    rarity: 'обычный',
    image: '',
    imageStatus: 'ready',
  })
  return complete && PHB_PACK_CONTENTS[item.catalog_id]
    ? { ...materialized, contents: structuredClone(PHB_PACK_CONTENTS[item.catalog_id]) }
    : materialized
}

function completeStarterItem(heroId, item, index, prefix = 'class') {
  if (item?.catalog_id && catalogItem(item.catalog_id)) return classicStarterItem(heroId, item, index, prefix, { complete: true })
  return narrativeStarterItem(heroId, item, index, prefix, { complete: true })
}

function narrativeStarterItem(heroId, entry, index, prefix, { complete = false } = {}) {
  if (!complete) return {
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
  const defaults = NARRATIVE_ITEM_DEFAULTS[String(entry?.name ?? '')] ?? {}
  const quantity = Math.max(1, Math.trunc(Number(entry?.quantity) || 1))
  const weight = Number.isFinite(Number(entry?.weight)) ? Math.max(0, Number(entry.weight)) : Math.max(0, Number(defaults.weight) || 0)
  const type = String(entry?.type ?? defaults.type ?? 'other').trim() || 'other'
  const status = String(entry?.mechanics_status ?? defaults.mechanics_status ?? (type === 'tool' || type === 'focus' ? 'partial' : 'ruling-only'))
  return {
    id: `${heroId}-starter-${prefix}-${index + 1}`.slice(0, 120),
    name: String(entry.name ?? 'Личные вещи').slice(0, 160),
    type,
    quantity,
    weight,
    description: String(entry.description ?? '').slice(0, 2_000),
    properties: String(entry.properties ?? defaults.properties ?? 'Обычный предмет стартового снаряжения PHB 2014.').slice(0, 1_000),
    mechanics_status: status,
    ...(Array.isArray(entry.contents ?? defaults.contents) ? { contents: structuredClone(entry.contents ?? defaults.contents) } : {}),
    ...(entry.proficiency ? { proficiency: String(entry.proficiency) } : {}),
    sellable: false,
    equipped: entry.equipped === true,
  }
}

function phbWeaponOption(weaponId, { quantity = 1, equipped = true, optionId = weaponId } = {}) {
  const catalogId = `srd_5_2_1:${weaponId}`
  const entry = catalogItem(catalogId)
  if (entry) return {
    id: optionId,
    label: entry.name,
    summary: `Обычное оружие PHB 2014 · ${entry.weight} фнт за единицу`,
    items: [{ catalog_id: catalogId, quantity, ...(equipped ? { equipped: true } : {}) }],
  }
  const missing = PHB_MISSING_ITEMS[catalogId]
  if (!missing) throw new TypeError(`Полный набор 2014 ссылается на неизвестное оружие ${catalogId}`)
  return {
    id: optionId,
    label: missing.name,
    summary: `Обычное оружие PHB 2014 · ${missing.weight} фнт`,
    narrative_items: [{ ...structuredClone(missing), quantity, ...(equipped ? { equipped: true } : {}) }],
  }
}

function phbWeaponOptions(source, { equipped = true, optionPrefix = 'phb' } = {}) {
  return source.map((weaponId) => phbWeaponOption(weaponId, { equipped, optionId: `${optionPrefix}-${weaponId}` }))
}

function combineWeaponOption(first, second, optionId, label) {
  const firstOption = phbWeaponOption(first, { equipped: true, optionId: `${optionId}-${first}` })
  const secondOption = second === 'shield'
    ? { items: [{ catalog_id: 'srd_5_2_1:shield', quantity: 1, equipped: true }] }
    : phbWeaponOption(second, { equipped: true, optionId: `${optionId}-${second}` })
  return {
    id: optionId,
    label,
    summary: 'Полный выбор оружия PHB 2014',
    items: [...(firstOption.items ?? []), ...(secondOption.items ?? [])],
    narrative_items: [...(firstOption.narrative_items ?? []), ...(secondOption.narrative_items ?? [])],
  }
}

function completeDynamicOptions(kind) {
  if (kind === 'simple') return phbWeaponOptions(PHB_SIMPLE_WEAPONS, { optionPrefix: 'simple-weapon' })
  if (kind === 'simple-melee') return phbWeaponOptions(PHB_SIMPLE_MELEE_WEAPONS, { optionPrefix: 'simple-melee' })
  if (kind === 'martial-melee') return phbWeaponOptions(PHB_MARTIAL_MELEE_WEAPONS, { optionPrefix: 'martial-melee' })
  if (kind === 'musical') return PHB_2014_MUSICAL_INSTRUMENTS.map((id) => phbToolOption(id, 'musical_instrument'))
  if (kind === 'two-simple-melee') {
    const options = []
    for (let left = 0; left < PHB_SIMPLE_MELEE_WEAPONS.length; left += 1) {
      for (let right = left; right < PHB_SIMPLE_MELEE_WEAPONS.length; right += 1) {
        const first = PHB_SIMPLE_MELEE_WEAPONS[left]
        const second = PHB_SIMPLE_MELEE_WEAPONS[right]
        const id = `two-simple-melee-${first}-${second}`
        const firstOption = phbWeaponOption(first, { equipped: true, optionId: `${id}-first` })
        const secondOption = phbWeaponOption(second, { equipped: true, optionId: `${id}-second` })
        options.push({
          id,
          label: `${firstOption.label} ×${first === second ? 2 : 1}${first === second ? '' : ` и ${secondOption.label}`}`,
          summary: 'Два простых рукопашных оружия PHB 2014',
          items: [...(firstOption.items ?? []), ...(secondOption.items ?? [])],
          narrative_items: [...(firstOption.narrative_items ?? []), ...(secondOption.narrative_items ?? [])],
        })
      }
    }
    return options
  }
  if (kind === 'fighter-melee' || kind === 'paladin-melee') {
    const options = PHB_MARTIAL_WEAPONS.map((weaponId) => combineWeaponOption(
      weaponId, 'shield', `martial-and-shield-${weaponId}`, `${catalogItem(`srd_5_2_1:${weaponId}`)?.name ?? PHB_MISSING_ITEMS[`srd_5_2_1:${weaponId}`]?.name} и щит`,
    ))
    for (let left = 0; left < PHB_MARTIAL_WEAPONS.length; left += 1) {
      for (let right = left; right < PHB_MARTIAL_WEAPONS.length; right += 1) {
        const first = PHB_MARTIAL_WEAPONS[left]
        const second = PHB_MARTIAL_WEAPONS[right]
        const id = `two-martial-weapons-${first}-${second}`
        const firstOption = phbWeaponOption(first, { equipped: true, optionId: `${id}-first` })
        const secondOption = phbWeaponOption(second, { equipped: true, optionId: `${id}-second` })
        options.push({
          id,
          label: `${firstOption.label}${first === second ? ' ×2' : ` и ${secondOption.label}`}`,
          summary: 'Два воинских оружия PHB 2014',
          items: [...(firstOption.items ?? []), ...(secondOption.items ?? [])],
          narrative_items: [...(firstOption.narrative_items ?? []), ...(secondOption.narrative_items ?? [])],
        })
      }
    }
    return options
  }
  return []
}

const COMPLETE_DYNAMIC_OPTIONS = Object.freeze(Object.fromEntries(
  ['simple', 'simple-melee', 'martial-melee', 'musical', 'two-simple-melee', 'fighter-melee', 'paladin-melee']
    .map((kind) => [kind, completeDynamicOptions(kind)]),
))

function mergeCompleteClassProfile(profile) {
  const stored = (classicEquipment.complete_classes ?? []).find((entry) => String(entry.class_id) === String(profile?.class_id ?? ''))
  const rules = stored?.dynamic_groups ?? COMPLETE_CLASS_DYNAMIC_GROUPS[profile?.class_id]
  if (!profile || !rules) return profile ? structuredClone(profile) : null
  const groups = (profile.choice_groups ?? []).map((group) => {
    const source = rules[group.id]
    if (!source) return structuredClone(group)
    const additions = COMPLETE_DYNAMIC_OPTIONS[source] ?? []
    const existing = new Set((group.options ?? []).map((option) => String(option.id)))
    return {
      ...structuredClone(group),
      complete: true,
      options: [...(group.options ?? []).filter((option) => option.legacy_only !== true).map((option) => structuredClone(option)), ...additions.filter((option) => !existing.has(String(option.id))).map((option) => structuredClone(option))],
    }
  })
  return { ...structuredClone(profile), complete: true, choice_groups: groups }
}

export function starterEquipmentCatalogFor(rulesetId = LEGACY_DEFAULT_RULESET_ID, { complete = false } = {}) {
  if (rulesetId !== DND_2014_RULESET_ID) return null
  const labelItem = (item) => ({
    ...structuredClone(item),
    ...(item.catalog_id ? { name: catalogItem(item.catalog_id)?.name ?? item.catalog_id } : {}),
  })
  const classes = classicEquipment.classes.map((profile) => (complete ? mergeCompleteClassProfile(profile) : structuredClone(profile)))
  return {
    ...structuredClone(classicEquipment),
    ...(complete ? { complete: true, complete_schema_version: 1 } : {}),
    ...(complete ? { backgrounds: (classicEquipment.complete_backgrounds ?? []).map(completeBackgroundProfile) } : {}),
    classes: classes.map((profile) => ({
      ...profile,
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

export function defaultStarterEquipmentChoices(classId, rulesetId = LEGACY_DEFAULT_RULESET_ID, { complete = false } = {}) {
  if (rulesetId !== DND_2014_RULESET_ID) return {}
  const rawProfile = classicClassProfiles.get(String(classId ?? ''))
  const profile = complete ? mergeCompleteClassProfile(rawProfile) : rawProfile
  if (!profile) return null
  return Object.fromEntries((profile.choice_groups ?? []).map((group) => [
    group.id,
    (group.options ?? []).slice(0, Number(group.count ?? 0)).map((option) => option.id),
  ]))
}

export function resolveStarterEquipmentChoices(classId, choices = {}, rulesetId = LEGACY_DEFAULT_RULESET_ID, { complete = false } = {}) {
  if (rulesetId !== DND_2014_RULESET_ID) return { ok: true, choices: {}, selected_options: [], profile: null }
  const rawProfile = classicClassProfiles.get(String(classId ?? ''))
  const profile = complete ? mergeCompleteClassProfile(rawProfile) : rawProfile
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

function completeModeRequested(hero, complete = false) {
  return complete === true || Number(hero?.phbCreation?.schema_version) === 1
}

function completeBackgroundProfileFor(backgroundId) {
  const profile = (classicEquipment.complete_backgrounds ?? []).find((entry) => String(entry.background_id) === String(backgroundId ?? '')) ?? null
  return completeBackgroundProfile(profile)
}

function resolveCompleteBackgroundChoices(background, choices = {}) {
  const groups = background?.choice_groups ?? []
  if (!background) return { ok: false, reason: 'Для предыстории нет полного набора 2014' }
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return { ok: false, reason: 'backgroundChoices должен быть объектом' }
  const allowed = new Set(groups.map((group) => String(group.id)))
  for (const key of Object.keys(choices)) if (!allowed.has(key)) return { ok: false, reason: `Группа предыстории ${key} не принадлежит этому фону` }
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
  return { ok: true, choices: resolved, selected_options: selectedOptions, profile: structuredClone(background) }
}

function defaultCompleteBackgroundChoices(background) {
  return Object.fromEntries((background?.choice_groups ?? []).map((group) => [
    group.id,
    (group.options ?? []).slice(0, Number(group.count ?? 0)).map((option) => option.id),
  ]))
}

function backgroundChoicesForHero(hero, background) {
  const defaults = defaultCompleteBackgroundChoices(background)
  const explicit = hero?.phbCreation?.backgroundEquipmentChoices ?? hero?.backgroundEquipmentChoices
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) return { ...defaults, ...structuredClone(explicit) }
  const oldTools = Array.isArray(hero?.backgroundChoices?.tools) ? hero.backgroundChoices.tools.map(String) : []
  if (!oldTools.length) return defaults
  const translated = { ...defaults }
  const groupById = new Map((background?.choice_groups ?? []).map((group) => [group.id, group]))
  for (const [groupId, group] of groupById) {
    if (!['musical-instrument', 'artisan-tool', 'gaming-set'].includes(groupId)) continue
    const available = new Set((group.options ?? []).map((option) => String(option.id)))
    const selected = oldTools.filter((id) => available.has(id)).slice(0, Number(group.count ?? 0))
    if (selected.length === Number(group.count ?? 0)) translated[groupId] = selected
  }
  return translated
}

/** Returns complete PHB 2014 equipment choices for a hero, filling omitted groups with their first legal option. */
export function completeBackgroundChoicesForHero(hero, background = undefined) {
  const profile = typeof background === 'string'
    ? completeBackgroundProfileFor(background)
    : background ?? completeBackgroundProfileFor(hero?.backgroundId)
  return profile ? backgroundChoicesForHero(hero, profile) : null
}

/** Validates complete-mode equipment choices against one PHB 2014 background. */
export function validateCompleteBackgroundChoices(backgroundOrId, choices = {}) {
  const profile = typeof backgroundOrId === 'string' ? completeBackgroundProfileFor(backgroundOrId) : backgroundOrId
  return resolveCompleteBackgroundChoices(profile, choices)
}

function completeBackgroundInventory(heroId, background, choices) {
  const resolved = resolveCompleteBackgroundChoices(background, choices)
  if (!resolved.ok) throw new TypeError(resolved.reason)
  const selected = resolved.selected_options
  const fixed = [...(background.fixed_items ?? [])].map((item, index) => completeStarterItem(heroId, item, index, 'background'))
  const fixedNarrative = [...(background.fixed_narrative_items ?? [])].map((item, index) => completeStarterItem(heroId, item, index, 'background-keepsake'))
  const selectedItems = selected.flatMap((option) => option.items ?? []).map((item, index) => completeStarterItem(heroId, item, index, 'background-choice'))
  const selectedNarrative = selected.flatMap((option) => option.narrative_items ?? []).map((item, index) => completeStarterItem(heroId, item, index, 'background-choice'))
  return [...fixed, ...fixedNarrative, ...selectedItems, ...selectedNarrative]
}

function classicStarterInventory(hero, profile, { policyVersion = classicEquipment.policy_version, complete = false } = {}) {
  const heroId = String(hero?.id || 'hero')
  let classItems
  if (Number(policyVersion) < 2) {
    classItems = (profile?.legacy_default_items ?? []).map((item, index) => classicStarterItem(heroId, item, index))
  } else {
    const requestedChoices = hero?.phbCreation?.classEquipmentChoices
      ?? hero?.starterEquipmentChoices
      ?? defaultStarterEquipmentChoices(hero?.characterClass, DND_2014_RULESET_ID, { complete })
      ?? {}
    const resolved = resolveStarterEquipmentChoices(hero?.characterClass, requestedChoices, DND_2014_RULESET_ID, { complete })
    if (!resolved.ok) throw new TypeError(resolved.reason)
    const selectedItems = resolved.selected_options.flatMap((option) => option.items ?? [])
    const selectedNarrative = resolved.selected_options.flatMap((option) => option.narrative_items ?? [])
    classItems = [...(profile?.fixed_items ?? []), ...selectedItems]
      .map((item, index) => complete ? completeStarterItem(heroId, item, index) : classicStarterItem(heroId, item, index))
    classItems.push(...[...(profile?.fixed_narrative_items ?? []), ...selectedNarrative]
      .map((item, index) => complete ? completeStarterItem(heroId, item, index, 'class-keepsake') : narrativeStarterItem(heroId, item, index, 'class-keepsake')))
  }
  const background = complete ? completeBackgroundProfileFor(hero?.backgroundId) : backgroundById(hero?.backgroundId, DND_2014_RULESET_ID)
  if (complete && background) {
    const backgroundChoices = backgroundChoicesForHero(hero, background)
    return [...classItems, ...completeBackgroundInventory(heroId, background, backgroundChoices)]
  }
  const backgroundItems = (background?.equipment?.catalogItems ?? [])
    .map((item, index) => classicStarterItem(heroId, { ...item, catalog_id: item.catalogId }, index, 'background'))
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
export function withStarterKit(hero, { rulesetId = LEGACY_DEFAULT_RULESET_ID, starterPolicyVersion = classicEquipment.policy_version, complete = false } = {}) {
  const role = `${hero?.role ?? ''} ${hero?.characterClass ?? ''}`.toLocaleLowerCase('ru')
  const profile = CLASS_PROFILES.find((entry) => entry.key === hero?.characterClass || entry.pattern.test(role))
  const heroId = String(hero?.id || 'hero')
  const useComplete = completeModeRequested(hero, complete)
  const rawClassicProfile = classicClassProfiles.get(hero?.characterClass ?? profile?.key)
  const classicProfile = useComplete ? mergeCompleteClassProfile(rawClassicProfile) : rawClassicProfile
  const selectedStarterChoices = hero?.phbCreation?.classEquipmentChoices
    ?? hero?.starterEquipmentChoices
    ?? defaultStarterEquipmentChoices(hero?.characterClass ?? profile?.key, DND_2014_RULESET_ID, { complete: useComplete })
  const inventory = Array.isArray(hero?.inventory) && hero.inventory.length
    ? structuredClone(hero.inventory)
    : rulesetId === DND_2014_RULESET_ID
      ? classicProfile
        ? classicStarterInventory(hero, classicProfile, { policyVersion: starterPolicyVersion, complete: useComplete })
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
      starterEquipmentChoices: structuredClone(selectedStarterChoices ?? {}),
    } : {}),
  }
}
