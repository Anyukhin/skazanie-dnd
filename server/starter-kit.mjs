const STARTING_GOLD = 20

const WEAPONS = Object.freeze({
  dagger: Object.freeze({
    catalog_id: 'srd_5_2_1:dagger',
    base_price_cp: 200,
    name: 'Кинжал',
    weight: 1,
    description: 'Надёжный дорожный клинок из стартового снаряжения героя.',
    properties: '1к4 колющего урона · фехтовальное · лёгкое.',
    combat: Object.freeze({ kind: 'melee', ability: 'dex', damage: '1d4', damageType: 'piercing', normalRange: 5 }),
  }),
  longsword: Object.freeze({
    catalog_id: 'srd_5_2_1:longsword',
    base_price_cp: 1_500,
    name: 'Длинный меч',
    weight: 3,
    description: 'Сбалансированный строевой клинок из стартового снаряжения героя.',
    properties: '1к8 рубящего урона · универсальное (1к10).',
    combat: Object.freeze({ kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 }),
  }),
  shortbow: Object.freeze({
    catalog_id: 'srd_5_2_1:shortbow',
    base_price_cp: 2_500,
    name: 'Короткий лук',
    weight: 2,
    description: 'Компактный охотничий лук из стартового снаряжения героя.',
    properties: '1к6 колющего урона · дальность 80/320 фт · боеприпас · двуручное.',
    combat: Object.freeze({ kind: 'ranged', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }),
  }),
})

const CLASS_PROFILES = Object.freeze([
  { key: 'barbarian', pattern: /варвар|barbarian/u, weapon: 'longsword', abilities: { str: 16, dex: 12, con: 15, int: 8, wis: 10, cha: 13 } },
  { key: 'fighter', pattern: /воин|fighter/u, weapon: 'longsword', abilities: { str: 16, dex: 12, con: 15, int: 10, wis: 13, cha: 8 } },
  { key: 'paladin', pattern: /паладин|paladin/u, weapon: 'longsword', abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 12, cha: 15 } },
  { key: 'ranger', pattern: /следопыт|ranger/u, weapon: 'shortbow', abilities: { str: 10, dex: 16, con: 14, int: 12, wis: 15, cha: 8 } },
  { key: 'rogue', pattern: /плут|разбойник|rogue/u, weapon: 'dagger', abilities: { str: 8, dex: 16, con: 14, int: 13, wis: 10, cha: 15 } },
  { key: 'monk', pattern: /монах|monk/u, weapon: 'dagger', abilities: { str: 10, dex: 16, con: 14, int: 8, wis: 15, cha: 12 } },
  { key: 'cleric', pattern: /жрец|cleric/u, weapon: 'dagger', abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 16, cha: 15 } },
  { key: 'druid', pattern: /друид|druid/u, weapon: 'dagger', abilities: { str: 10, dex: 13, con: 14, int: 12, wis: 16, cha: 8 } },
  { key: 'bard', pattern: /бард|bard/u, weapon: 'dagger', abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 16 } },
  { key: 'sorcerer', pattern: /чарод|sorcer/u, weapon: 'dagger', abilities: { str: 8, dex: 14, con: 15, int: 10, wis: 12, cha: 16 } },
  { key: 'warlock', pattern: /колдун|warlock/u, weapon: 'dagger', abilities: { str: 8, dex: 14, con: 15, int: 12, wis: 10, cha: 16 } },
  { key: 'wizard', pattern: /волшеб|wizard|маг\b/u, weapon: 'dagger', abilities: { str: 8, dex: 14, con: 13, int: 16, wis: 15, cha: 10 } },
])

function totalCurrency(currency = {}) {
  return Number(currency.copper || 0) + Number(currency.silver || 0) * 10 + Number(currency.gold || 0) * 100 + Number(currency.platinum || 0) * 1_000
}
function abilityScoresAreBlank(abilities = {}) {
  return ['str', 'dex', 'con', 'int', 'wis', 'cha'].every((key) => Number(abilities[key] ?? 10) === 10)
}

function starterWeapon(heroId, weaponKey) {
  const weapon = WEAPONS[weaponKey] ?? WEAPONS.dagger
  return {
    id: `${heroId}-starter-${weaponKey}`.slice(0, 120),
    ...structuredClone(weapon),
    type: 'weapon',
    quantity: 1,
    equipped: true,
    rarity: 'обычный',
    image: '',
    imageStatus: 'ready',
  }
}

/** Supplies only missing first-session essentials; imported, already-built
 * character sheets keep their money, abilities and equipment unchanged. */
export function withStarterKit(hero) {
  const role = `${hero?.role ?? ''} ${hero?.characterClass ?? ''}`.toLocaleLowerCase('ru')
  const profile = CLASS_PROFILES.find((entry) => entry.key === hero?.characterClass || entry.pattern.test(role))
  const inventory = Array.isArray(hero?.inventory) && hero.inventory.length
    ? structuredClone(hero.inventory)
    : [starterWeapon(String(hero?.id || 'hero'), profile?.weapon ?? 'dagger')]
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
