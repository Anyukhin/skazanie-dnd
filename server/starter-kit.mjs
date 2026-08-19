import { ammunitionCatalogIdForWeapon, catalogItem, materializeCatalogItem } from './item-catalog.mjs'

const STARTING_GOLD = 20

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

/** Supplies only missing first-session essentials; imported, already-built
 * character sheets keep their money, abilities and equipment unchanged. */
export function withStarterKit(hero) {
  const role = `${hero?.role ?? ''} ${hero?.characterClass ?? ''}`.toLocaleLowerCase('ru')
  const profile = CLASS_PROFILES.find((entry) => entry.key === hero?.characterClass || entry.pattern.test(role))
  const heroId = String(hero?.id || 'hero')
  const inventory = Array.isArray(hero?.inventory) && hero.inventory.length
    ? structuredClone(hero.inventory)
    : [
        starterWeapon(heroId, profile?.weapon ?? 'dagger'),
        ...[starterAmmunition(heroId, profile?.weapon ?? 'dagger')].filter(Boolean),
        ...(profile?.gear ?? []).map((key) => starterGear(heroId, key)).filter(Boolean),
      ]
  const currency = totalCurrency(hero?.currency) > 0
    ? structuredClone(hero.currency)
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
  }
}
