import { createHash } from 'node:crypto'
import { listAssets } from './asset-registry.mjs'
import { combatBoundsContain, combatBoundsUseful, computeCombatBounds } from './combat-bounds.mjs'
import { SIZE_CLASSES } from './tactical-map.mjs'

export const ENCOUNTER_PROPOSAL_VERSION = 'skazanie:encounter-proposal-v1'

export const ENCOUNTER_ASSEMBLER_LIMITS = Object.freeze({
  maximum_party_size: 8,
  // Предел клеток един для всей системы и живёт в классах размеров карты
  // (`server/tactical-map.mjs`). Раньше число 500 было продублировано в четырёх
  // местах и расходилось бы при первом же изменении.
  maximum_scene_cells: SIZE_CLASSES.region.maxCells,
  maximum_creatures_per_character: 2,
  maximum_creatures: 12,
  minimum_spawn_distance_cells: 2,
  maximum_seed_length: 120,
  maximum_actor_id_length: 120,
  minimum_character_level: 1,
  maximum_character_level: 20,
  minimum_coordinate: -1_000,
  maximum_coordinate: 1_000,
})

export const SRD_5_2_1_SOURCE = deepFreeze({
  title: 'System Reference Document 5.2.1',
  version: '5.2.1',
  published: '2025-05-01',
  url: 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',
  landing_url: 'https://www.dndbeyond.com/srd',
  sha256: '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',
  license: 'CC-BY-4.0',
  attribution: 'This work includes material from the System Reference Document 5.2.1 (\u201cSRD 5.2.1\u201d) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  encounter_budget_page: 202,
})

export const DND_SU_BESTIARY_SOURCE = deepFreeze({
  title: 'DnD.su — Бестиарий D&D 5',
  url: 'https://dnd.su/bestiary/',
  checked_at: '2026-07-13',
  role: 'Russian names, compact stat-block cross-checks and gallery references',
})

// Each entry is a server-owned projection of one SRD 5.2.1 stat block onto the
// combat fields currently supported by the rules engine. damageDice is the
// number of sides in the primary attack's single damage die.
//
// `damage_vulnerabilities`, `damage_resistances`, `damage_immunities` и
// `condition_immunities` — это строки Vulnerabilities/Resistances/Immunities
// того же стат-блока, поэтому отдельного номера страницы у них нет: он уже
// стоит в `source_page` записи и уезжает в `provenance.source_page` врага.
// Поля объявлены **только** у существ, у которых эти строки в SRD 5.2.1
// действительно есть; отсутствие поля означает «в стат-блоке пусто», а не
// «ещё не перенесли». Условные формулировки редакции («немагическое оружие»,
// «не адамантиновое») сюда не переносятся: движок не различает магическое
// оружие, и записать такую строку списком значило бы соврать в сторону
// монстра. Поэтому у зорна (SRD 5.2.1, с. 343) резистов здесь нет.
export const SRD_5_2_1_MONSTER_ALLOWLIST = deepFreeze({
  'srd_5_2_1:goblin-minion': {
    name: 'Гоблин-налётчик', hp: 7, armor: 12, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2,
    challenge_rating: '1/8', xp: 25, source_page: 290, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/4-goblin/', image: '/assets/enemies/goblin-minion.png',
    traits: [{ id: 'nimble-escape', name: 'Ловкое бегство' }],
    action_profiles: [
      { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'slashing', range_feet: 5 },
      { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:goblin-warrior': {
    name: 'Гоблин-воин', hp: 10, armor: 15, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 290, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/4-goblin/', image: '/assets/enemies/goblin.png',
    traits: [{ id: 'nimble-escape', name: 'Ловкое бегство' }],
    action_profiles: [
      { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'slashing', range_feet: 5 },
      { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:skeleton': {
    name: 'Скелет', hp: 13, armor: 14, speed: 30, abilities: { str: 10, dex: 16, con: 15, int: 6, wis: 8, cha: 5 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '1/4', xp: 50, source_page: 325, creature_type: 'undead',
    damage_vulnerabilities: ['bludgeoning'], damage_immunities: ['poison'],
    condition_immunities: ['exhaustion', 'poisoned'],
    source_url: 'https://dnd.su/bestiary/24-skeleton/', image: '/assets/enemies/skeleton.png',
    traits: [{ id: 'undead-nature', name: 'Природа нежити' }],
    action_profiles: [
      { id: 'shortsword', name: 'Короткий меч', kind: 'melee', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'piercing', range_feet: 5 },
      { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:zombie': {
    name: 'Зомби', hp: 15, armor: 8, speed: 20, abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
    initiative_bonus: -2, attackBonus: 3, damageDice: 8, damageBonus: 1,
    challenge_rating: '1/4', xp: 50, source_page: 343, creature_type: 'undead',
    damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'],
    source_url: 'https://dnd.su/bestiary/9-zombie/', image: '/assets/enemies/zombie.png',
    traits: [{ id: 'undead-fortitude', name: 'Стойкость нежити' }, { id: 'undead-nature', name: 'Природа нежити' }],
    action_profiles: [
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'bludgeoning', range_feet: 5 },
    ],
  },
  'srd_5_2_1:wolf': {
    name: 'Волк', hp: 11, armor: 12, speed: 40, abilities: { str: 14, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 364, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/2-wolf/', image: '/assets/enemies/wolf.png',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'str', save_dc: 11, condition: 'prone', duration: 'until-next-turn' } },
    ],
  },
  'srd_5_2_1:giant-rat': {
    name: 'Гигантская крыса', hp: 7, armor: 13, speed: 30, abilities: { str: 7, dex: 16, con: 11, int: 2, wis: 10, cha: 4 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 4, damageBonus: 3,
    challenge_rating: '1/8', xp: 25, source_page: 296, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/336-giant-rat/', image: '/assets/enemies/giant-rat.png',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [{ id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d4+3', damage_type: 'piercing', range_feet: 5 }],
  },
  'srd_5_2_1:giant-wolf-spider': {
    name: 'Гигантский паук-волк', hp: 11, armor: 13, speed: 40, abilities: { str: 12, dex: 16, con: 13, int: 3, wis: 12, cha: 4 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 4, damageBonus: 3,
    challenge_rating: '1/4', xp: 50, source_page: 305, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/358-giant-wolf-spider/', image: '/assets/enemies/giant-wolf-spider.png',
    traits: [{ id: 'spider-climb', name: 'Паучье лазание' }, { id: 'web-walker', name: 'Хождение по паутине' }],
    action_profiles: [{ id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d4+3', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'con', save_dc: 11, damage_expression: '2d4', damage_type: 'poison', half_on_save: true } }],
  },
  'srd_5_2_1:giant-spider': {
    name: 'Гигантский паук', hp: 26, armor: 14, speed: 30, abilities: { str: 14, dex: 16, con: 12, int: 2, wis: 11, cha: 4 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 8, damageBonus: 3,
    challenge_rating: '1', xp: 200, source_page: 305, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/3-giant-spider/', image: '/assets/enemies/giant-spider.png',
    traits: [{ id: 'spider-climb', name: 'Паучье лазание' }, { id: 'web-walker', name: 'Хождение по паутине' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'con', save_dc: 11, damage_expression: '2d8', damage_type: 'poison', half_on_save: true } },
      // Recharge 5–6 из стат-блока. Раньше стояло `uses: 1` — грубое
      // приближение «один раз за бой»: способность не возвращалась никогда,
      // хотя по редакции паук пускает её снова, едва выпадет 5 или 6.
      { id: 'web', name: 'Паутина', kind: 'ranged', attack_modifier: 5, damage_amount: 0, damage_type: 'untyped', range_feet: 60, normal_range_feet: 30, on_hit: { condition: 'restrained', duration: 'until-next-turn' }, recharge: 5, tactical_priority: 8 },
    ],
  },
  'srd_5_2_1:orc': {
    name: 'Орк', hp: 15, armor: 13, speed: 30, abilities: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 },
    initiative_bonus: 1, attackBonus: 5, damageDice: 12, damageBonus: 3,
    challenge_rating: '1/2', xp: 100, source_page: 315, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/20-orc/', image: '/assets/enemies/orc.png',
    traits: [{ id: 'aggressive', name: 'Агрессивный' }],
    action_profiles: [
      { id: 'greataxe', name: 'Секира', kind: 'melee', attack_modifier: 5, damage_expression: '1d12+3', damage_type: 'slashing', range_feet: 5 },
      { id: 'javelin', name: 'Метательное копьё', kind: 'ranged', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:hobgoblin': {
    name: 'Хобгоблин', hp: 11, armor: 18, speed: 30, abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 },
    initiative_bonus: 1, attackBonus: 3, damageDice: 8, damageBonus: 1,
    challenge_rating: '1/2', xp: 100, source_page: 295, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/27-hobgoblin/', image: '/assets/enemies/hobgoblin.png',
    traits: [{ id: 'martial-advantage', name: 'Воинское превосходство', damage_expression: '2d6' }],
    action_profiles: [
      { id: 'longsword', name: 'Длинный меч', kind: 'melee', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'slashing', range_feet: 5 },
      { id: 'longbow', name: 'Длинный лук', kind: 'ranged', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'piercing', range_feet: 600, normal_range_feet: 150 },
    ],
  },
  'srd_5_2_1:kobold': {
    name: 'Кобольд', hp: 5, armor: 12, speed: 30, abilities: { str: 7, dex: 15, con: 9, int: 8, wis: 7, cha: 8 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2,
    challenge_rating: '1/8', xp: 25, source_page: 299, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/210-kobold/', image: '/assets/enemies/kobold.png',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [
      { id: 'dagger', name: 'Кинжал', kind: 'melee', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'piercing', range_feet: 5 },
      { id: 'sling', name: 'Праща', kind: 'ranged', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'bludgeoning', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:bugbear': {
    name: 'Багбир', hp: 27, armor: 16, speed: 30, abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 8, damageBonus: 2,
    challenge_rating: '1', xp: 200, source_page: 282, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/13-bugbear/', image: '/assets/enemies/bugbear.png',
    traits: [{ id: 'surprise-attack', name: 'Внезапная атака', damage_expression: '2d6' }],
    action_profiles: [
      { id: 'morningstar', name: 'Моргенштерн', kind: 'melee', attack_modifier: 4, damage_expression: '2d8+2', damage_type: 'piercing', range_feet: 5 },
      { id: 'javelin', name: 'Метательное копьё', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:bandit': {
    name: 'Бандит', hp: 11, armor: 12, speed: 30, abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    initiative_bonus: 1, attackBonus: 3, damageDice: 6, damageBonus: 1,
    challenge_rating: '1/8', xp: 25, source_page: 261, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/21204-bandit/', image: '/assets/enemies/bandit.png',
    traits: [],
    action_profiles: [
      { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 3, damage_expression: '1d6+1', damage_type: 'slashing', range_feet: 5 },
      { id: 'light-crossbow', name: 'Лёгкий арбалет', kind: 'ranged', attack_modifier: 3, damage_expression: '1d8+1', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
    ],
  },
  'srd_5_2_1:dire-wolf': {
    name: 'Лютый волк', hp: 22, armor: 14, speed: 50, abilities: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
    initiative_bonus: 2, attackBonus: 5, damageDice: 10, damageBonus: 3,
    challenge_rating: '1', xp: 200, source_page: 347, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/297-dire-wolf/', image: '/assets/enemies/dire-wolf.png',
    traits: [{ id: 'pack-tactics', name: 'Тактика стаи' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d10+3', damage_type: 'piercing', range_feet: 5, on_hit: { save_ability: 'str', save_dc: 13, condition: 'prone', duration: 'until-next-turn' } },
    ],
  },
  'srd_5_2_1:ghoul': {
    name: 'Упырь', hp: 22, armor: 12, speed: 30, abilities: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1', xp: 200, source_page: 288, creature_type: 'undead',
    damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'],
    source_url: 'https://dnd.su/bestiary/21321-ghoul/', image: '/assets/enemies/ghoul.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'bite' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 5, on_hit: { damage_expression: '1d6', damage_type: 'necrotic' } },
      { id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'slashing', range_feet: 5, on_hit: { save_ability: 'con', save_dc: 10, condition: 'paralyzed', duration: 'until-next-turn' }, tactical_priority: 8 },
    ],
  },
  'srd_5_2_1:gnoll-warrior': {
    name: 'Гнолл-воин', hp: 27, armor: 15, speed: 30, abilities: { str: 14, dex: 12, con: 11, int: 6, wis: 10, cha: 7 },
    initiative_bonus: 1, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/2', xp: 100, source_page: 289, creature_type: 'fiend',
    source_url: 'https://dnd.su/bestiary/178-gnoll/', image: '/assets/enemies/gnoll-warrior.png',
    traits: [{ id: 'rampage', name: 'Буйство', uses: 1 }],
    action_profiles: [
      { id: 'rend', name: 'Раздирание', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 5 },
      { id: 'bone-bow', name: 'Костяной лук', kind: 'ranged', attack_modifier: 3, damage_expression: '1d10+1', damage_type: 'piercing', range_feet: 600, normal_range_feet: 150 },
    ],
  },
  'srd_5_2_1:ogre': {
    name: 'Огр', hp: 68, armor: 11, speed: 40, abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    initiative_bonus: -1, attackBonus: 6, damageDice: 8, damageBonus: 4,
    challenge_rating: '2', xp: 450, source_page: 312, creature_type: 'giant',
    source_url: 'https://dnd.su/bestiary/21480-ogre/', image: '/assets/enemies/ogre.png',
    traits: [],
    action_profiles: [
      { id: 'greatclub', name: 'Палица', kind: 'melee', attack_modifier: 6, damage_expression: '2d8+4', damage_type: 'bludgeoning', range_feet: 5 },
      { id: 'javelin', name: 'Метательное копьё', kind: 'ranged', attack_modifier: 6, damage_expression: '2d6+4', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:owlbear': {
    name: 'Совомед', hp: 59, armor: 13, speed: 40, abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
    initiative_bonus: 1, attackBonus: 7, damageDice: 8, damageBonus: 5,
    challenge_rating: '3', xp: 700, source_page: 313, creature_type: 'monstrosity',
    source_url: 'https://dnd.su/bestiary/25-owlbear/', image: '/assets/enemies/owlbear.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'rend' }],
    action_profiles: [
      { id: 'rend', name: 'Раздирание', kind: 'melee', attack_modifier: 7, damage_expression: '2d8+5', damage_type: 'slashing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:scout': {
    name: 'Разведчик', hp: 16, armor: 13, speed: 30, abilities: { str: 11, dex: 14, con: 12, int: 11, wis: 13, cha: 11 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1/2', xp: 100, source_page: 322, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/439-scout/', image: '/assets/enemies/scout.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'shortsword', name: 'Короткий меч', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 5 },
      { id: 'longbow', name: 'Длинный лук', kind: 'ranged', attack_modifier: 4, damage_expression: '1d8+2', damage_type: 'piercing', range_feet: 600, normal_range_feet: 150 },
    ],
  },
  'srd_5_2_1:spy': {
    name: 'Шпион', hp: 27, armor: 12, speed: 30, abilities: { str: 10, dex: 15, con: 10, int: 12, wis: 14, cha: 16 },
    initiative_bonus: 4, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1', xp: 200, source_page: 329, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/444-spy/', image: '/assets/enemies/spy.png',
    traits: [
      { id: 'keep-distance', name: 'Держит дистанцию' },
      { id: 'nimble-escape', name: 'Хитрое действие' },
    ],
    action_profiles: [
      { id: 'shortsword', name: 'Короткий меч', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 5, on_hit: { damage_expression: '2d6', damage_type: 'poison' } },
      { id: 'hand-crossbow', name: 'Ручной арбалет', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30, on_hit: { damage_expression: '2d6', damage_type: 'poison' } },
    ],
  },
  'srd_5_2_1:giant-centipede': {
    name: 'Гигантская многоножка', hp: 9, armor: 14, speed: 30, abilities: { str: 5, dex: 14, con: 12, int: 1, wis: 7, cha: 3 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2,
    challenge_rating: '1/4', xp: 50, source_page: 349, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/341-giant-centipede/', image: '/assets/enemies/giant-centipede.png',
    traits: [{ id: 'relentless-pursuit', name: 'Неотступная охота' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 4, damage_expression: '1d4+2', damage_type: 'piercing', range_feet: 5, on_hit: { condition: 'poisoned', duration: 'until-source-next-turn' } },
    ],
  },
  'srd_5_2_1:violet-fungus': {
    name: 'Лиловый гриб', hp: 18, armor: 5, speed: 5, abilities: { str: 3, dex: 1, con: 10, int: 1, wis: 3, cha: 1 },
    initiative_bonus: -5, attackBonus: 2, damageDice: 8, damageBonus: 0,
    challenge_rating: '1/4', xp: 50, source_page: 286, creature_type: 'plant',
    condition_immunities: ['blinded', 'charmed', 'deafened', 'frightened'],
    source_url: 'https://dnd.su/bestiary/157-violet-fungus/', image: '/assets/enemies/violet-fungus.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'rotting-touch' },
      { id: 'relentless-pursuit', name: 'Неотступная охота' },
    ],
    action_profiles: [
      { id: 'rotting-touch', name: 'Разлагающее касание', kind: 'melee', attack_modifier: 2, damage_expression: '1d8', damage_type: 'necrotic', range_feet: 10 },
    ],
  },
  'srd_5_2_1:minotaur-skeleton': {
    name: 'Скелет минотавра', hp: 45, armor: 12, speed: 40, abilities: { str: 18, dex: 11, con: 15, int: 6, wis: 8, cha: 5 },
    initiative_bonus: 0, attackBonus: 6, damageDice: 6, damageBonus: 4,
    challenge_rating: '2', xp: 450, source_page: 326, creature_type: 'undead',
    damage_vulnerabilities: ['bludgeoning'], damage_immunities: ['poison'],
    condition_immunities: ['exhaustion', 'poisoned'],
    source_url: 'https://dnd.su/bestiary/286-minotaur_skeleton/', image: '/assets/enemies/minotaur-skeleton.png',
    traits: [{
      id: 'charge', name: 'Разбег', action_id: 'gore', minimum_distance_feet: 20,
      requires_straight_toward_target: true, target_size_max: 'large',
      damage_expression: '2d8', damage_type: 'piercing', condition: 'prone', duration: 'until-next-turn',
    }],
    action_profiles: [
      { id: 'gore', name: 'Рога', kind: 'melee', attack_modifier: 6, damage_expression: '2d6+4', damage_type: 'piercing', range_feet: 5 },
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 6, damage_expression: '2d10+4', damage_type: 'bludgeoning', range_feet: 5 },
    ],
  },
  'srd_5_2_1:ankylosaurus': {
    name: 'Анкилозавр', hp: 68, armor: 15, speed: 30, abilities: { str: 19, dex: 11, con: 15, int: 2, wis: 12, cha: 5 },
    initiative_bonus: 0, attackBonus: 6, damageDice: 10, damageBonus: 4,
    challenge_rating: '3', xp: 700, source_page: 344, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/21185-ankylosaurus/', image: '/assets/enemies/ankylosaurus.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'tail' }],
    action_profiles: [
      { id: 'tail', name: 'Хвост', kind: 'melee', attack_modifier: 6, damage_expression: '1d10+4', damage_type: 'bludgeoning', range_feet: 10, on_hit: { condition: 'prone', duration: 'until-next-turn', target_size_max: 'huge' } },
    ],
  },
  'srd_5_2_1:berserker': {
    name: 'Берсерк', hp: 67, armor: 13, speed: 30, abilities: { str: 16, dex: 12, con: 17, int: 9, wis: 11, cha: 9 },
    initiative_bonus: 1, attackBonus: 5, damageDice: 12, damageBonus: 3,
    challenge_rating: '2', xp: 450, source_page: 263, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/420-berserker/', image: '/assets/enemies/berserker.png',
    traits: [{ id: 'bloodied-frenzy', name: 'Кровавая ярость' }],
    action_profiles: [
      { id: 'greataxe', name: 'Секира', kind: 'melee', attack_modifier: 5, damage_expression: '1d12+3', damage_type: 'slashing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:lion': {
    name: 'Лев', hp: 22, armor: 12, speed: 50, abilities: { str: 17, dex: 15, con: 11, int: 3, wis: 12, cha: 8 },
    initiative_bonus: 2, attackBonus: 5, damageDice: 8, damageBonus: 3,
    challenge_rating: '1', xp: 200, source_page: 356, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/375-lion/', image: '/assets/enemies/lion.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'rend' },
      { id: 'pack-tactics', name: 'Тактика стаи' },
    ],
    action_profiles: [
      { id: 'rend', name: 'Раздирание', kind: 'melee', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'slashing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:brown-bear': {
    name: 'Бурый медведь', hp: 22, armor: 11, speed: 40, abilities: { str: 17, dex: 12, con: 15, int: 2, wis: 13, cha: 7 },
    initiative_bonus: 1, attackBonus: 5, damageDice: 8, damageBonus: 3,
    challenge_rating: '1', xp: 200, source_page: 346, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/19977-brown-bear/', image: '/assets/enemies/brown-bear.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', action_counts: { bite: 1, claw: 1 } }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'piercing', range_feet: 5 },
      { id: 'claw', name: 'Когти', kind: 'melee', attack_modifier: 5, damage_expression: '1d4+3', damage_type: 'slashing', range_feet: 5, on_hit: { condition: 'prone', duration: 'until-next-turn', target_size_max: 'large' } },
    ],
  },
  'srd_5_2_1:giant-boar': {
    name: 'Гигантский кабан', hp: 42, armor: 13, speed: 40, abilities: { str: 17, dex: 10, con: 16, int: 2, wis: 7, cha: 5 },
    initiative_bonus: 0, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '2', xp: 450, source_page: 349, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/21326-giant-boar/', image: '/assets/enemies/giant-boar.png',
    traits: [
      {
        id: 'charge', name: 'Разбег', action_id: 'gore', minimum_distance_feet: 20,
        requires_straight_toward_target: true, target_size_max: 'large',
        damage_expression: '2d6', damage_type: 'piercing', condition: 'prone', duration: 'until-next-turn',
      },
      { id: 'bloodied-frenzy', name: 'Ярость раненого', attack_kinds: ['melee'], saving_throws: false },
    ],
    action_profiles: [
      { id: 'gore', name: 'Бодание', kind: 'melee', attack_modifier: 5, damage_expression: '2d6+3', damage_type: 'piercing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:tiger': {
    name: 'Тигр', hp: 30, armor: 13, speed: 40, abilities: { str: 17, dex: 16, con: 14, int: 3, wis: 12, cha: 8 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '1', xp: 200, source_page: 363, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/21588-tiger/', image: '/assets/enemies/tiger.png',
    traits: [{ id: 'nimble-escape', name: 'Хитрый отход' }],
    action_profiles: [
      { id: 'rend', name: 'Раздирание', kind: 'melee', attack_modifier: 5, damage_expression: '2d6+3', damage_type: 'slashing', range_feet: 5, on_hit: { condition: 'prone', duration: 'until-next-turn', target_size_max: 'large' } },
    ],
  },
  'srd_5_2_1:sahuagin-warrior': {
    name: 'Воин сахуагинов', hp: 22, armor: 12, speed: 30, abilities: { str: 13, dex: 11, con: 12, int: 12, wis: 13, cha: 9 },
    initiative_bonus: 0, attackBonus: 3, damageDice: 6, damageBonus: 1,
    challenge_rating: '1/2', xp: 100, source_page: 321, creature_type: 'fiend',
    source_url: 'https://dnd.su/bestiary/21533-sahuagin-warrior/', image: '/assets/enemies/sahuagin-warrior.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'claw' }],
    action_profiles: [
      { id: 'claw', name: 'Когти', kind: 'melee', attack_modifier: 3, damage_expression: '1d6+1', damage_type: 'slashing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:bandit-captain': {
    name: 'Атаман бандитов', hp: 52, armor: 15, speed: 30, abilities: { str: 15, dex: 16, con: 14, int: 14, wis: 11, cha: 14 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '2', xp: 450, source_page: 261, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/21201-bandit-captain/', image: '/assets/enemies/bandit-captain.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'slashing', range_feet: 5 },
      { id: 'pistol', name: 'Пистоль', kind: 'ranged', attack_modifier: 5, damage_expression: '1d10+3', damage_type: 'piercing', range_feet: 90, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:warrior-veteran': {
    name: 'Воитель-ветеран', hp: 65, armor: 17, speed: 30, abilities: { str: 16, dex: 13, con: 14, int: 10, wis: 11, cha: 10 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '3', xp: 700, source_page: 337, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/21617-warrior-veteran/', image: '/assets/enemies/warrior-veteran.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2, same_action: true },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'greatsword', name: 'Двуручный меч', kind: 'melee', attack_modifier: 5, damage_expression: '2d6+3', damage_type: 'slashing', range_feet: 5 },
      { id: 'heavy-crossbow', name: 'Тяжёлый арбалет', kind: 'ranged', attack_modifier: 3, damage_expression: '2d10+1', damage_type: 'piercing', range_feet: 400, normal_range_feet: 100 },
    ],
  },
  'srd_5_2_1:ettin': {
    name: 'Эттин', hp: 85, armor: 12, speed: 40, abilities: { str: 21, dex: 8, con: 17, int: 6, wis: 10, cha: 8 },
    initiative_bonus: -1, attackBonus: 7, damageDice: 8, damageBonus: 5,
    challenge_rating: '4', xp: 1100, source_page: 284, creature_type: 'giant',
    source_url: 'https://dnd.su/bestiary/21300-ettin/', image: '/assets/enemies/ettin.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', action_counts: { battleaxe: 1, morningstar: 1 } }],
    action_profiles: [
      { id: 'battleaxe', name: 'Боевой топор', kind: 'melee', attack_modifier: 7, damage_expression: '2d8+5', damage_type: 'slashing', range_feet: 5, on_hit: { condition: 'prone', duration: 'until-next-turn', target_size_max: 'large' } },
      { id: 'morningstar', name: 'Моргенштерн', kind: 'melee', attack_modifier: 7, damage_expression: '2d8+5', damage_type: 'piercing', range_feet: 5, on_hit: { condition: 'disadvantage-next-attack', duration: 'until-own-turn-end' } },
    ],
  },
  'srd_5_2_1:guard-captain': {
    name: 'Капитан стражи', hp: 75, armor: 18, speed: 30, abilities: { str: 18, dex: 14, con: 16, int: 12, wis: 14, cha: 13 },
    initiative_bonus: 4, attackBonus: 6, damageDice: 10, damageBonus: 4,
    challenge_rating: '4', xp: 1100, source_page: 296, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/21384-guard-captain/', image: '/assets/enemies/guard-captain.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'longsword', name: 'Длинный меч', kind: 'melee', attack_modifier: 6, damage_expression: '2d10+4', damage_type: 'slashing', range_feet: 5 },
      { id: 'javelin-melee', name: 'Метательное копьё (рукопашная)', kind: 'melee', attack_modifier: 6, damage_expression: '3d6+4', damage_type: 'piercing', range_feet: 5 },
      { id: 'javelin-ranged', name: 'Метательное копьё (бросок)', kind: 'ranged', attack_modifier: 6, damage_expression: '3d6+4', damage_type: 'piercing', range_feet: 120, normal_range_feet: 30 },
    ],
  },
  'srd_5_2_1:awakened-tree': {
    name: 'Пробуждённое дерево', hp: 59, armor: 13, speed: 20, abilities: { str: 19, dex: 6, con: 15, int: 10, wis: 10, cha: 7 },
    initiative_bonus: -2, attackBonus: 6, damageDice: 6, damageBonus: 4,
    challenge_rating: '2', xp: 450, source_page: 260, creature_type: 'plant',
    damage_vulnerabilities: ['fire'], damage_resistances: ['bludgeoning', 'piercing'],
    source_url: 'https://dnd.su/bestiary/21194-awakened-tree/', image: '/assets/enemies/awakened-tree.png',
    traits: [{ id: 'relentless-pursuit', name: 'Политика: неумолимое преследование' }],
    action_profiles: [
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 6, damage_expression: '3d6+4', damage_type: 'bludgeoning', range_feet: 10 },
    ],
  },
  'srd_5_2_1:giant-elk': {
    name: 'Гигантский лось', hp: 42, armor: 14, speed: 60, abilities: { str: 19, dex: 18, con: 14, int: 7, wis: 14, cha: 10 },
    initiative_bonus: 6, attackBonus: 6, damageDice: 6, damageBonus: 4,
    challenge_rating: '2', xp: 450, source_page: 351, creature_type: 'celestial',
    damage_resistances: ['necrotic', 'radiant'],
    source_url: 'https://dnd.su/bestiary/21332-giant-elk/', image: '/assets/enemies/giant-elk.png',
    traits: [{
      id: 'charge', name: 'Разбег', action_id: 'ram', minimum_distance_feet: 20,
      requires_straight_toward_target: true, target_size_max: 'huge',
      damage_expression: '2d4', damage_type: 'bludgeoning', condition: 'prone', duration: 'until-next-turn',
    }],
    action_profiles: [
      {
        id: 'ram', name: 'Таран', kind: 'melee', attack_modifier: 6,
        damage_expression: '2d6+4', damage_type: 'bludgeoning', range_feet: 10,
        on_hit: { damage_expression: '2d4', damage_type: 'radiant' },
      },
    ],
  },
  'srd_5_2_1:ogre-zombie': {
    name: 'Огр-зомби', hp: 85, armor: 8, speed: 30, abilities: { str: 19, dex: 6, con: 18, int: 3, wis: 6, cha: 5 },
    initiative_bonus: -2, attackBonus: 6, damageDice: 8, damageBonus: 4,
    challenge_rating: '2', xp: 450, source_page: 344, creature_type: 'undead',
    damage_immunities: ['poison'], condition_immunities: ['exhaustion', 'poisoned'],
    source_url: 'https://dnd.su/bestiary/21479-ogre-zombie/', image: '/assets/enemies/ogre-zombie.png',
    traits: [{ id: 'undead-fortitude', name: 'Стойкость нежити' }],
    action_profiles: [
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 6, damage_expression: '2d8+4', damage_type: 'bludgeoning', range_feet: 5 },
    ],
  },
  'srd_5_2_1:knight': {
    name: 'Рыцарь', hp: 52, armor: 18, speed: 30, abilities: { str: 16, dex: 11, con: 14, int: 11, wis: 11, cha: 15 },
    initiative_bonus: 0, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '3', xp: 700, source_page: 302, creature_type: 'humanoid',
    condition_immunities: ['frightened'],
    source_url: 'https://dnd.su/bestiary/21419-knight/', image: '/assets/enemies/knight.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'greatsword', name: 'Двуручный меч', kind: 'melee', attack_modifier: 5, damage_expression: '2d6+3', damage_type: 'slashing', range_feet: 5, on_hit: { damage_expression: '1d8', damage_type: 'radiant' } },
      { id: 'heavy-crossbow', name: 'Тяжёлый арбалет', kind: 'ranged', attack_modifier: 2, damage_expression: '2d10', damage_type: 'piercing', range_feet: 400, normal_range_feet: 100, on_hit: { damage_expression: '1d8', damage_type: 'radiant' } },
    ],
  },
  'srd_5_2_1:hippopotamus': {
    name: 'Гиппопотам', hp: 82, armor: 14, speed: 30, abilities: { str: 21, dex: 7, con: 15, int: 2, wis: 12, cha: 4 },
    initiative_bonus: -2, attackBonus: 7, damageDice: 10, damageBonus: 5,
    challenge_rating: '4', xp: 1100, source_page: 355, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/21397-hippopotamus/', image: '/assets/enemies/hippopotamus.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'bite' }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 7, damage_expression: '2d10+5', damage_type: 'piercing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:earth-elemental': {
    name: 'Земляной элементаль', hp: 147, armor: 17, speed: 30, abilities: { str: 20, dex: 8, con: 20, int: 5, wis: 10, cha: 5 },
    initiative_bonus: -1, attackBonus: 8, damageDice: 8, damageBonus: 5,
    challenge_rating: '5', xp: 1800, source_page: 282, creature_type: 'elemental',
    damage_vulnerabilities: ['thunder'], damage_immunities: ['poison'],
    condition_immunities: ['exhaustion', 'paralyzed', 'petrified', 'poisoned', 'unconscious'],
    source_url: 'https://dnd.su/bestiary/21290-earth-elemental/', image: '/assets/enemies/earth-elemental.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 8, damage_expression: '2d8+5', damage_type: 'bludgeoning', range_feet: 10 },
      { id: 'rock-launch', name: 'Бросок булыжника', kind: 'ranged', attack_modifier: 8, damage_expression: '1d6+5', damage_type: 'bludgeoning', range_feet: 60, normal_range_feet: 60, on_hit: { condition: 'prone', duration: 'until-next-turn', target_size_max: 'large' } },
    ],
  },
  'srd_5_2_1:hill-giant': {
    name: 'Холмовой великан', hp: 105, armor: 13, speed: 40, abilities: { str: 21, dex: 8, con: 19, int: 5, wis: 9, cha: 6 },
    initiative_bonus: 2, attackBonus: 8, damageDice: 8, damageBonus: 5,
    challenge_rating: '5', xp: 1800, source_page: 298, creature_type: 'giant',
    source_url: 'https://dnd.su/bestiary/21395-hill-giant/', image: '/assets/enemies/hill-giant.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'tree-club', name: 'Вырванное дерево', kind: 'melee', attack_modifier: 8, damage_expression: '3d8+5', damage_type: 'bludgeoning', range_feet: 10, on_hit: { condition: 'prone', duration: 'until-next-turn', target_size_max: 'large' } },
      { id: 'trash-lob', name: 'Пригоршня мусора', kind: 'ranged', attack_modifier: 8, damage_expression: '2d10+5', damage_type: 'bludgeoning', range_feet: 240, normal_range_feet: 60, on_hit: { condition: 'poisoned', duration: 'until-own-turn-end' } },
    ],
  },
  'srd_5_2_1:xorn': {
    name: 'Зорн', hp: 84, armor: 19, speed: 20, abilities: { str: 17, dex: 10, con: 22, int: 11, wis: 10, cha: 11 },
    initiative_bonus: 0, attackBonus: 6, damageDice: 6, damageBonus: 3,
    challenge_rating: '5', xp: 1800, source_page: 343, creature_type: 'elemental',
    source_url: 'https://dnd.su/bestiary/21635-xorn/', image: '/assets/enemies/xorn.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', action_counts: { bite: 1, claw: 3 } },
      { id: 'aggressive', name: 'Налёт' },
    ],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 6, damage_expression: '4d6+3', damage_type: 'piercing', range_feet: 5 },
      { id: 'claw', name: 'Когти', kind: 'melee', attack_modifier: 6, damage_expression: '1d10+3', damage_type: 'slashing', range_feet: 5 },
    ],
  },
  'srd_5_2_1:animated-armor': {
    name: 'Живой доспех', hp: 33, armor: 18, speed: 25, abilities: { str: 14, dex: 11, con: 13, int: 1, wis: 3, cha: 1 },
    initiative_bonus: 2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '1', xp: 200, source_page: 259, creature_type: 'construct',
    damage_immunities: ['poison', 'psychic'],
    condition_immunities: ['charmed', 'deafened', 'exhaustion', 'frightened', 'paralyzed', 'petrified', 'poisoned'],
    source_url: 'https://dnd.su/bestiary/35-animated-armor/', image: '/assets/enemies/animated-armor.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, action_id: 'slam' }],
    action_profiles: [
      { id: 'slam', name: 'Размашистый удар', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'bludgeoning', range_feet: 5 },
    ],
  },
  'srd_5_2_1:ochre-jelly': {
    name: 'Золотистый студень', hp: 52, armor: 8, speed: 20, abilities: { str: 15, dex: 6, con: 14, int: 2, wis: 6, cha: 1 },
    initiative_bonus: -2, attackBonus: 4, damageDice: 6, damageBonus: 2,
    challenge_rating: '2', xp: 450, source_page: 312, creature_type: 'ooze',
    damage_resistances: ['acid'], damage_immunities: ['lightning', 'slashing'],
    condition_immunities: ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'prone'],
    source_url: 'https://dnd.su/bestiary/8-ochre-jelly/', image: '/assets/enemies/ochre-jelly.png',
    traits: [{ id: 'relentless-pursuit', name: 'Политика: неумолимое преследование' }],
    action_profiles: [
      { id: 'pseudopod', name: 'Ложноножка', kind: 'melee', attack_modifier: 4, damage_expression: '3d6+2', damage_type: 'acid', range_feet: 5 },
    ],
  },
  'srd_5_2_1:barbed-devil': {
    name: 'Шипастый дьявол', hp: 110, armor: 15, speed: 30, abilities: { str: 16, dex: 17, con: 18, int: 12, wis: 14, cha: 14 },
    initiative_bonus: 3, attackBonus: 6, damageDice: 6, damageBonus: 3,
    challenge_rating: '5', xp: 1800, source_page: 262, creature_type: 'fiend',
    damage_resistances: ['cold'], damage_immunities: ['fire', 'poison'],
    condition_immunities: ['poisoned'],
    source_url: 'https://dnd.su/bestiary/77-barbed_devil/', image: '/assets/enemies/barbed-devil.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака: когти и хвост', action_counts: { claws: 1, tail: 1 } }],
    action_profiles: [
      { id: 'claws', name: 'Когти', kind: 'melee', attack_modifier: 6, damage_expression: '2d6+3', damage_type: 'piercing', range_feet: 5 },
      { id: 'tail', name: 'Хвост', kind: 'melee', attack_modifier: 6, damage_expression: '2d10+3', damage_type: 'slashing', range_feet: 10 },
    ],
  },
  'srd_5_2_1:gladiator': {
    name: 'Гладиатор', hp: 112, armor: 16, speed: 30, abilities: { str: 18, dex: 15, con: 16, int: 10, wis: 12, cha: 15 },
    initiative_bonus: 5, attackBonus: 7, damageDice: 6, damageBonus: 4,
    challenge_rating: '5', xp: 1800, source_page: 289, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/423-gladiator/', image: '/assets/enemies/gladiator.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 3 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'spear-melee', name: 'Копьё (рукопашная)', kind: 'melee', attack_modifier: 7, damage_expression: '2d6+4', damage_type: 'piercing', range_feet: 5 },
      { id: 'spear-ranged', name: 'Копьё (бросок)', kind: 'ranged', attack_modifier: 7, damage_expression: '2d6+4', damage_type: 'piercing', range_feet: 60, normal_range_feet: 20 },
    ],
  },
  'srd_5_2_1:giant-scorpion': {
    name: 'Гигантский скорпион', hp: 52, armor: 15, speed: 40, abilities: { str: 16, dex: 13, con: 15, int: 1, wis: 9, cha: 3 },
    initiative_bonus: 1, attackBonus: 5, damageDice: 6, damageBonus: 3,
    challenge_rating: '3', xp: 700, source_page: 353, creature_type: 'beast',
    source_url: 'https://dnd.su/bestiary/359-giant-scorpion/', image: '/assets/enemies/giant-scorpion.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', action_counts: { claw: 2, sting: 1 } }],
    action_profiles: [
      { id: 'claw', name: 'Клешня', kind: 'melee', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'bludgeoning', range_feet: 5 },
      { id: 'sting', name: 'Жало', kind: 'melee', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'piercing', range_feet: 5, on_hit: { damage_expression: '2d10', damage_type: 'poison' } },
    ],
  },
  'srd_5_2_1:wyvern': {
    name: 'Виверна', hp: 127, armor: 14, speed: 30, abilities: { str: 19, dex: 10, con: 16, int: 5, wis: 12, cha: 6 },
    initiative_bonus: 0, attackBonus: 7, damageDice: 8, damageBonus: 4,
    challenge_rating: '6', xp: 2300, source_page: 343, creature_type: 'dragon',
    source_url: 'https://dnd.su/bestiary/313-wyvern/', image: '/assets/enemies/wyvern.png',
    traits: [{ id: 'multiattack', name: 'Мультиатака', action_counts: { bite: 1, sting: 1 } }],
    action_profiles: [
      { id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 7, damage_expression: '2d8+4', damage_type: 'piercing', range_feet: 5 },
      {
        id: 'sting', name: 'Жало', kind: 'melee', attack_modifier: 7,
        damage_expression: '2d6+4', damage_type: 'piercing', range_feet: 10,
        on_hit: { damage_expression: '7d6', damage_type: 'poison', condition: 'poisoned', duration: 'until-source-next-turn' },
      },
    ],
  },
  'srd_5_2_1:manticore': {
    name: 'Мантикора', hp: 68, armor: 14, speed: 30, abilities: { str: 17, dex: 16, con: 17, int: 7, wis: 12, cha: 8 },
    initiative_bonus: 3, attackBonus: 5, damageDice: 8, damageBonus: 3,
    challenge_rating: '3', xp: 700, source_page: 306, creature_type: 'monstrosity',
    source_url: 'https://dnd.su/bestiary/226-manticore/', image: '/assets/enemies/manticore.png',
    traits: [
      { id: 'multiattack', name: 'Мультиатака', attacks: 3 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'rend', name: 'Раздирание', kind: 'melee', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'slashing', range_feet: 5 },
      { id: 'tail-spike', name: 'Хвостовой шип', kind: 'ranged', attack_modifier: 5, damage_expression: '1d8+3', damage_type: 'piercing', range_feet: 200, normal_range_feet: 100 },
    ],
  },
  'srd_5_2_1:tough-boss': {
    name: 'Босс громил', hp: 82, armor: 16, speed: 30, abilities: { str: 17, dex: 14, con: 16, int: 11, wis: 10, cha: 11 },
    initiative_bonus: 2, attackBonus: 5, damageDice: 8, damageBonus: 3,
    challenge_rating: '4', xp: 1100, source_page: 332, creature_type: 'humanoid',
    source_url: 'https://dnd.su/bestiary/21589-tough-boss/', image: '/assets/enemies/tough-boss.png',
    traits: [
      { id: 'pack-tactics', name: 'Тактика стаи' },
      { id: 'multiattack', name: 'Мультиатака', attacks: 2 },
      { id: 'keep-distance', name: 'Держит дистанцию' },
    ],
    action_profiles: [
      { id: 'warhammer', name: 'Боевой молот', kind: 'melee', attack_modifier: 5, damage_expression: '2d8+3', damage_type: 'bludgeoning', range_feet: 5 },
      { id: 'heavy-crossbow', name: 'Тяжёлый арбалет', kind: 'ranged', attack_modifier: 4, damage_expression: '2d10+2', damage_type: 'piercing', range_feet: 400, normal_range_feet: 100 },
    ],
  },
})

/**
 * Темы — это состав ростера, а не отдельный бестиарий: каждая перечисляет
 * подмножество того же server-owned allowlist. Их двенадцать вместо прежних
 * пяти, и разница между ними настоящая — «стая» из быстрых зверей ощущается
 * иначе, чем «ватага» из трёх тяжёлых бойцов, даже когда бюджет XP один.
 *
 * Честная граница: бестиарий расширен до пятидесяти существ, но это всё ещё
 * компактный mini-compendium, а не полный monster corpus (`docs/known-limitations.md`).
 */
const THEMES = deepFreeze({
  goblinoids: ['srd_5_2_1:goblin-minion', 'srd_5_2_1:goblin-warrior', 'srd_5_2_1:hobgoblin', 'srd_5_2_1:kobold', 'srd_5_2_1:bugbear'],
  undead: ['srd_5_2_1:skeleton', 'srd_5_2_1:zombie', 'srd_5_2_1:ghoul', 'srd_5_2_1:minotaur-skeleton', 'srd_5_2_1:ogre-zombie'],
  beasts: ['srd_5_2_1:wolf', 'srd_5_2_1:dire-wolf', 'srd_5_2_1:owlbear', 'srd_5_2_1:giant-rat', 'srd_5_2_1:giant-wolf-spider', 'srd_5_2_1:giant-spider', 'srd_5_2_1:giant-centipede', 'srd_5_2_1:ankylosaurus', 'srd_5_2_1:lion', 'srd_5_2_1:brown-bear', 'srd_5_2_1:giant-boar', 'srd_5_2_1:tiger', 'srd_5_2_1:giant-elk', 'srd_5_2_1:hippopotamus'],
  raiders: ['srd_5_2_1:bandit', 'srd_5_2_1:gnoll-warrior', 'srd_5_2_1:ogre', 'srd_5_2_1:orc', 'srd_5_2_1:goblin-warrior', 'srd_5_2_1:hobgoblin', 'srd_5_2_1:bugbear', 'srd_5_2_1:scout', 'srd_5_2_1:spy', 'srd_5_2_1:berserker', 'srd_5_2_1:bandit-captain', 'srd_5_2_1:warrior-veteran', 'srd_5_2_1:ettin', 'srd_5_2_1:hill-giant', 'srd_5_2_1:gladiator', 'srd_5_2_1:tough-boss'],
  // Ватага: только тяжёлые бойцы, мало целей и каждая больно бьёт.
  warband: ['srd_5_2_1:gnoll-warrior', 'srd_5_2_1:ogre', 'srd_5_2_1:orc', 'srd_5_2_1:bugbear', 'srd_5_2_1:hobgoblin', 'srd_5_2_1:berserker', 'srd_5_2_1:sahuagin-warrior', 'srd_5_2_1:bandit-captain', 'srd_5_2_1:warrior-veteran', 'srd_5_2_1:ettin', 'srd_5_2_1:guard-captain', 'srd_5_2_1:knight', 'srd_5_2_1:hill-giant', 'srd_5_2_1:barbed-devil', 'srd_5_2_1:gladiator', 'srd_5_2_1:tough-boss'],
  // Закон: те, кто носит чужую присягу, а не своё оружие. Тема нужна отдельная,
  // потому что бюджет XP тратится по **всей** теме: пока стража собиралась из
  // «ватаги», рядом с капитаном стражи в ростере стояли эттин, холмовой великан
  // и шипастый дьявол — и деревенскую стражу у ворот игрок встречал дьяволом.
  // Ни одного нового стат-блока здесь нет: перечислены только записи allowlist.
  law: ['srd_5_2_1:scout', 'srd_5_2_1:spy', 'srd_5_2_1:warrior-veteran', 'srd_5_2_1:knight', 'srd_5_2_1:guard-captain'],
  // Мелочь: много слабых существ, бой решается площадью, а не силой удара.
  vermin: ['srd_5_2_1:giant-rat', 'srd_5_2_1:kobold', 'srd_5_2_1:goblin-minion', 'srd_5_2_1:giant-centipede', 'srd_5_2_1:violet-fungus', 'srd_5_2_1:ochre-jelly', 'srd_5_2_1:giant-scorpion'],
  // Засада: быстрые и хрупкие, наказывают за растянутый строй.
  ambush: ['srd_5_2_1:bandit', 'srd_5_2_1:kobold', 'srd_5_2_1:goblin-minion', 'srd_5_2_1:giant-wolf-spider', 'srd_5_2_1:wolf', 'srd_5_2_1:dire-wolf', 'srd_5_2_1:scout', 'srd_5_2_1:spy', 'srd_5_2_1:lion', 'srd_5_2_1:tiger', 'srd_5_2_1:bandit-captain', 'srd_5_2_1:wyvern', 'srd_5_2_1:manticore'],
  // Склеп: нежить и то, что кормится в мёртвом месте.
  crypt: ['srd_5_2_1:skeleton', 'srd_5_2_1:zombie', 'srd_5_2_1:ghoul', 'srd_5_2_1:giant-rat', 'srd_5_2_1:minotaur-skeleton', 'srd_5_2_1:giant-centipede', 'srd_5_2_1:ogre-zombie', 'srd_5_2_1:animated-armor', 'srd_5_2_1:ochre-jelly'],
  // Пещера: обитатели подземелья вперемешку с тем, кто их туда загнал.
  cave: ['srd_5_2_1:kobold', 'srd_5_2_1:giant-spider', 'srd_5_2_1:giant-rat', 'srd_5_2_1:bugbear', 'srd_5_2_1:ghoul', 'srd_5_2_1:ogre', 'srd_5_2_1:owlbear', 'srd_5_2_1:giant-centipede', 'srd_5_2_1:violet-fungus', 'srd_5_2_1:minotaur-skeleton', 'srd_5_2_1:brown-bear', 'srd_5_2_1:ettin', 'srd_5_2_1:awakened-tree', 'srd_5_2_1:ogre-zombie', 'srd_5_2_1:earth-elemental', 'srd_5_2_1:hill-giant', 'srd_5_2_1:xorn', 'srd_5_2_1:animated-armor', 'srd_5_2_1:ochre-jelly', 'srd_5_2_1:barbed-devil', 'srd_5_2_1:giant-scorpion'],
  // Дикая местность: звери открытых пространств.
  wilderness: ['srd_5_2_1:wolf', 'srd_5_2_1:dire-wolf', 'srd_5_2_1:owlbear', 'srd_5_2_1:gnoll-warrior', 'srd_5_2_1:giant-spider', 'srd_5_2_1:giant-wolf-spider', 'srd_5_2_1:scout', 'srd_5_2_1:ankylosaurus', 'srd_5_2_1:lion', 'srd_5_2_1:brown-bear', 'srd_5_2_1:giant-boar', 'srd_5_2_1:tiger', 'srd_5_2_1:awakened-tree', 'srd_5_2_1:giant-elk', 'srd_5_2_1:hippopotamus', 'srd_5_2_1:hill-giant', 'srd_5_2_1:giant-scorpion', 'srd_5_2_1:wyvern', 'srd_5_2_1:manticore'],
  generic: Object.keys(SRD_5_2_1_MONSTER_ALLOWLIST),
})

export const ENCOUNTER_THEMES = Object.freeze(Object.keys(THEMES))
export const ENCOUNTER_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'deadly'])
const SRD_DIFFICULTY = Object.freeze({ easy: 'low', medium: 'moderate', hard: 'high', deadly: 'high' })

/**
 * «Смертельно» — **серверная политика, а не SRD**. В редакции 5.2.1 четвёртого
 * тира нет: таблица на странице 202 заканчивается на high. Этот тир нужен для
 * решения владельца о честном мире — когда отряд сам провоцирует силу заведомо
 * выше своих возможностей, бой собирается по-настоящему смертельным.
 *
 * Множитель применяется к high и намеренно живёт отдельной константой, чтобы
 * ни одно число здесь нельзя было принять за строку из таблицы SRD.
 */
const DEADLY_BUDGET_MULTIPLIER = 2
const DEADLY_DIFFICULTY = 'deadly'

/**
 * Ярлык «на глаз» для стола. Числа бюджета игрокам не показываются: они
 * превращают оценку опасности в арифметику, а не в решение отступить.
 */
export const ENCOUNTER_DIFFICULTY_LABELS = Object.freeze({
  easy: 'лёгкий',
  medium: 'средний',
  hard: 'тяжёлый',
  deadly: 'смертельный',
})

/** Предупреждение до точки невозврата: бой ещё не начат, отступить можно. */
export const DEADLY_ENCOUNTER_WARNING = 'Противник выглядит смертельно опасным — силы явно неравны. Ещё не поздно отступить или сменить план.'

export function encounterDifficultyLabel(difficulty) {
  return ENCOUNTER_DIFFICULTY_LABELS[String(difficulty ?? '')] ?? ENCOUNTER_DIFFICULTY_LABELS.medium
}

// SRD 5.2.1, printed page 202: XP Budget per Character.
const XP_BUDGET_PER_CHARACTER = deepFreeze({
  1: { low: 50, moderate: 75, high: 100 },
  2: { low: 100, moderate: 150, high: 200 },
  3: { low: 150, moderate: 225, high: 400 },
  4: { low: 250, moderate: 375, high: 500 },
  5: { low: 500, moderate: 750, high: 1_100 },
  6: { low: 600, moderate: 1_000, high: 1_400 },
  7: { low: 750, moderate: 1_300, high: 1_700 },
  8: { low: 1_000, moderate: 1_700, high: 2_100 },
  9: { low: 1_300, moderate: 2_000, high: 2_600 },
  10: { low: 1_600, moderate: 2_300, high: 3_100 },
  11: { low: 1_900, moderate: 2_900, high: 4_100 },
  12: { low: 2_200, moderate: 3_700, high: 4_700 },
  13: { low: 2_600, moderate: 4_200, high: 5_400 },
  14: { low: 2_900, moderate: 4_900, high: 6_200 },
  15: { low: 3_300, moderate: 5_400, high: 7_800 },
  16: { low: 3_800, moderate: 6_100, high: 9_800 },
  17: { low: 4_500, moderate: 7_200, high: 11_700 },
  18: { low: 5_000, moderate: 8_700, high: 14_200 },
  19: { low: 5_500, moderate: 10_700, high: 17_200 },
  20: { low: 6_400, moderate: 13_200, high: 22_000 },
})

const TOP_LEVEL_KEYS = new Set(['scene', 'party', 'difficulty', 'theme', 'seed'])
const SCENE_KEYS = new Set(['cells'])
// `occupied` появился в M0: раньше занятость клетки существом выражалась
// записью сущности в `feature`, а после разделения слоёв её нужно передавать
// явно, иначе двух противников можно поставить в одну клетку.
const CELL_KEYS = new Set(['x', 'y', 'type', 'revealed', 'feature', 'occupied'])
const PARTY_MEMBER_KEYS = new Set(['id', 'level', 'x', 'y'])
const CELL_TYPES = new Set(['wall', 'floor', 'water', 'door'])
// Общие server-owned предметы карты — препятствия, а не клиентская механика.
// Каталог ассетов является allowlist: тематический генератор не должен ломать
// встречу только потому, что его `assetId` новее прежних legacy-ярлыков.
const CELL_FEATURES = new Set([
  'chest', 'altar', 'torch', 'rune', 'stairs', 'enemy', 'bed', 'table', 'chair', 'fireplace', 'bookshelf',
  'barrel', 'crate', 'rock', 'mushroom', 'bones', 'campfire', 'grave', 'pillar', 'statue', 'tree', 'bush', 'wagon', 'well', 'console',
  ...listAssets().map((asset) => asset.id),
])
const WALKABLE_TYPES = new Set(['floor', 'door'])

export class EncounterAssemblyError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EncounterAssemblyError'
    this.code = code
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectUnexpectedKeys(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new EncounterAssemblyError('Вход содержит поле, не разрешённое контрактом сборщика столкновения', code)
  }
}

function boundedText(value, maximum, code, label) {
  if (typeof value !== 'string') throw new EncounterAssemblyError(`${label} должен быть строкой`, code)
  const result = value.trim()
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new EncounterAssemblyError(`${label} не прошёл проверку границ`, code)
  }
  return result
}

function coordinate(value, code, label) {
  if (!Number.isSafeInteger(value)
    || value < ENCOUNTER_ASSEMBLER_LIMITS.minimum_coordinate
    || value > ENCOUNTER_ASSEMBLER_LIMITS.maximum_coordinate) {
    throw new EncounterAssemblyError(`${label} должен быть целым числом в разрешённых границах`, code)
  }
  return value
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function positionKey(value) {
  return `${value.x},${value.y}`
}

function validateScene(input) {
  if (!isPlainObject(input)) throw new EncounterAssemblyError('scene должен быть объектом', 'INVALID_SCENE')
  rejectUnexpectedKeys(input, SCENE_KEYS, 'UNEXPECTED_SCENE_FIELD')
  if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_scene_cells) {
    throw new EncounterAssemblyError('scene.cells должен быть непустым ограниченным массивом', 'INVALID_SCENE_CELLS')
  }

  const seen = new Set()
  const cells = Array.from(input.cells, (entry) => {
    if (!isPlainObject(entry)) throw new EncounterAssemblyError('Клетка сцены должна быть объектом', 'INVALID_SCENE_CELL')
    rejectUnexpectedKeys(entry, CELL_KEYS, 'UNEXPECTED_SCENE_CELL_FIELD')
    const x = coordinate(entry.x, 'INVALID_SCENE_CELL_COORDINATE', 'cell.x')
    const y = coordinate(entry.y, 'INVALID_SCENE_CELL_COORDINATE', 'cell.y')
    if (typeof entry.type !== 'string' || !CELL_TYPES.has(entry.type)) {
      throw new EncounterAssemblyError('Неизвестный тип клетки', 'SCENE_CELL_TYPE_NOT_ALLOWED')
    }
    if (typeof entry.revealed !== 'boolean') {
      throw new EncounterAssemblyError('cell.revealed должен быть boolean', 'INVALID_SCENE_CELL_VISIBILITY')
    }
    if (entry.feature != null && (typeof entry.feature !== 'string' || !CELL_FEATURES.has(entry.feature))) {
      throw new EncounterAssemblyError('Неизвестный объект в клетке', 'SCENE_CELL_FEATURE_NOT_ALLOWED')
    }
    if (entry.occupied != null && typeof entry.occupied !== 'boolean') {
      throw new EncounterAssemblyError('cell.occupied должен быть boolean', 'INVALID_SCENE_CELL_OCCUPANCY')
    }
    const key = `${x},${y}`
    if (seen.has(key)) throw new EncounterAssemblyError('Координаты клеток не должны повторяться', 'DUPLICATE_SCENE_CELL')
    seen.add(key)
    return {
      x,
      y,
      type: entry.type,
      revealed: entry.revealed,
      ...(entry.feature == null ? {} : { feature: entry.feature }),
      ...(entry.occupied === true ? { occupied: true } : {}),
    }
  })
  cells.sort((left, right) => left.y - right.y || left.x - right.x)
  return cells
}

function validateParty(input, cells) {
  if (!Array.isArray(input) || input.length < 1 || input.length > ENCOUNTER_ASSEMBLER_LIMITS.maximum_party_size) {
    throw new EncounterAssemblyError('party должен быть непустым ограниченным массивом', 'INVALID_PARTY')
  }
  const cellsByPosition = new Map(cells.map((cell) => [positionKey(cell), cell]))
  const ids = new Set()
  const positions = new Set()
  const party = Array.from(input, (entry) => {
    if (!isPlainObject(entry)) throw new EncounterAssemblyError('Участник группы должен быть объектом', 'INVALID_PARTY_MEMBER')
    rejectUnexpectedKeys(entry, PARTY_MEMBER_KEYS, 'UNEXPECTED_PARTY_MEMBER_FIELD')
    const id = boundedText(entry.id, ENCOUNTER_ASSEMBLER_LIMITS.maximum_actor_id_length, 'INVALID_PARTY_MEMBER_ID', 'party.id')
    if (ids.has(id)) throw new EncounterAssemblyError('ID участников группы не должны повторяться', 'DUPLICATE_PARTY_MEMBER_ID')
    ids.add(id)
    if (!Number.isSafeInteger(entry.level)
      || entry.level < ENCOUNTER_ASSEMBLER_LIMITS.minimum_character_level
      || entry.level > ENCOUNTER_ASSEMBLER_LIMITS.maximum_character_level) {
      throw new EncounterAssemblyError('Уровень персонажа вне разрешённых границ', 'PARTY_LEVEL_OUT_OF_RANGE')
    }
    const x = coordinate(entry.x, 'INVALID_PARTY_MEMBER_COORDINATE', 'party.x')
    const y = coordinate(entry.y, 'INVALID_PARTY_MEMBER_COORDINATE', 'party.y')
    const key = `${x},${y}`
    const cell = cellsByPosition.get(key)
    if (!cell || !cell.revealed || !WALKABLE_TYPES.has(cell.type)) {
      throw new EncounterAssemblyError('Персонаж должен находиться на открытой проходимой клетке', 'PARTY_POSITION_NOT_WALKABLE')
    }
    if (positions.has(key)) throw new EncounterAssemblyError('Два персонажа не могут занимать одну клетку', 'DUPLICATE_PARTY_POSITION')
    positions.add(key)
    return { id, level: entry.level, x, y }
  })
  party.sort((left, right) => left.id.localeCompare(right.id))
  return party
}

function validateInput(input) {
  if (!isPlainObject(input)) throw new EncounterAssemblyError('Вход сборщика должен быть объектом', 'INVALID_ENCOUNTER_INPUT')
  rejectUnexpectedKeys(input, TOP_LEVEL_KEYS, 'UNEXPECTED_ENCOUNTER_FIELD')
  const cells = validateScene(input.scene)
  const party = validateParty(input.party, cells)
  if (typeof input.difficulty !== 'string' || !ENCOUNTER_DIFFICULTIES.includes(input.difficulty)) {
    throw new EncounterAssemblyError('Неизвестная сложность столкновения', 'ENCOUNTER_DIFFICULTY_NOT_ALLOWED')
  }
  if (typeof input.theme !== 'string' || !Object.hasOwn(THEMES, input.theme)) {
    throw new EncounterAssemblyError('Неизвестная тема столкновения', 'ENCOUNTER_THEME_NOT_ALLOWED')
  }
  const seed = boundedText(input.seed, ENCOUNTER_ASSEMBLER_LIMITS.maximum_seed_length, 'INVALID_ENCOUNTER_SEED', 'seed')
  return { cells, party, difficulty: input.difficulty, theme: input.theme, seed }
}

/**
 * Габарит сетки по списку клеток. Сборщик получает клетки, а не `TacticalMap`,
 * поэтому размер поля он выводит из них: подрайон боя считается от него.
 * Сетка со сдвинутым началом (отрицательные координаты) не поддерживается —
 * тогда подрайон не считается вовсе и расстановка остаётся прежней.
 */
function gridExtent(cells) {
  let width = 0
  let height = 0
  for (const cell of cells) {
    if (cell.x < 0 || cell.y < 0) return null
    width = Math.max(width, cell.x + 1)
    height = Math.max(height, cell.y + 1)
  }
  return width && height ? { width, height } : null
}

/**
 * Подрайон боя вокруг отряда (`docs/tactical-map-plan.md`, раздел 11.4).
 *
 * Противник обязан появиться внутри него. На карте 100×100 клетка «где-нибудь»
 * — это до двадцати ходов ходьбы: половина отряда несколько ходов идёт к
 * противнику, и боя не происходит. Запас вокруг отряда берётся общий, из
 * `server/combat-bounds.mjs`, чтобы расстановка и подрайон, который поставит
 * `CombatStarted`, считались по одному правилу.
 *
 * Это **не** невидимая стена: подрайон ограничивает только точку появления.
 * Уже начавшийся бой выпускает участников за границу и раздвигает её.
 *
 * `combat-bounds.mjs` читает у карты только размеры, поэтому габарита сетки ему
 * достаточно.
 *
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 *   null — карта слишком мала, чтобы подрайон что-то значил; расстановка идёт
 *   по всей сцене, как раньше
 */
function spawnBounds(cells, party) {
  const extent = gridExtent(cells)
  if (!extent || !combatBoundsUseful(extent)) return null
  return computeCombatBounds(extent, party)
}

function safePlacementCells(cells, party, bounds = null) {
  const occupied = new Set(party.map(positionKey))
  const walkable = new Map(cells
    .filter((cell) => cell.revealed && WALKABLE_TYPES.has(cell.type))
    .map((cell) => [positionKey(cell), cell]))
  const reachable = new Set()
  const queue = party.flatMap((member) => walkable.has(positionKey(member)) ? [walkable.get(positionKey(member))] : [])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const key = positionKey(current)
    if (reachable.has(key)) continue
    reachable.add(key)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = walkable.get(`${current.x + dx},${current.y + dy}`)
      if (neighbor && !reachable.has(positionKey(neighbor))) queue.push(neighbor)
    }
  }
  return cells.filter((cell) => (
    combatBoundsContain(bounds, cell.x, cell.y)
    && cell.revealed
    && WALKABLE_TYPES.has(cell.type)
    && reachable.has(positionKey(cell))
    && cell.feature == null
    && cell.occupied !== true
    && !occupied.has(positionKey(cell))
    && party.every((member) => (
      Math.abs(member.x - cell.x) + Math.abs(member.y - cell.y)
      >= ENCOUNTER_ASSEMBLER_LIMITS.minimum_spawn_distance_cells
    ))
  ))
}

function seededTieBreak(left, right, seed) {
  const leftKey = digest(`${seed}\u0000${left.join('|')}`)
  const rightKey = digest(`${seed}\u0000${right.join('|')}`)
  return leftKey.localeCompare(rightKey) < 0 ? left : right
}

function spendBudget(catalogIds, budgetXp, quantityCap, seed) {
  let states = new Map([[0, []]])
  for (let count = 0; count < quantityCap; count += 1) {
    const next = new Map(states)
    for (const [spent, selection] of states) {
      if (selection.length !== count) continue
      for (const catalogId of catalogIds) {
        const nextSpent = spent + SRD_5_2_1_MONSTER_ALLOWLIST[catalogId].xp
        if (nextSpent > budgetXp) continue
        const candidate = [...selection, catalogId].sort()
        const current = next.get(nextSpent)
        if (!current || current.length > candidate.length) next.set(nextSpent, candidate)
        else if (current.length === candidate.length) next.set(nextSpent, seededTieBreak(current, candidate, seed))
      }
    }
    states = next
  }
  const spentXp = Math.max(...states.keys())
  return { spent_xp: spentXp, stat_block_ids: states.get(spentXp) ?? [] }
}

function deterministicOrder(values, seed, label) {
  return [...values].sort((left, right) => {
    const leftKey = `${left.x},${left.y}`
    const rightKey = `${right.x},${right.y}`
    const leftHash = digest(`${seed}\u0000${label}\u0000${leftKey}`)
    const rightHash = digest(`${seed}\u0000${label}\u0000${rightKey}`)
    return leftHash.localeCompare(rightHash) || leftKey.localeCompare(rightKey)
  })
}

function enemyFrom(statBlockId, position, proposalHash, index, ordinal) {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  const slug = statBlockId.split(':').at(-1)
  return {
    id: `encounter-${proposalHash.slice(0, 16)}-${slug}-${index + 1}`.slice(0, 120),
    name: `${block.name} ${ordinal}`,
    hp: block.hp,
    maxHp: block.hp,
    armor: block.armor,
    speed: block.speed,
    initiativeBonus: block.initiative_bonus,
    attackBonus: block.attackBonus,
    damageDice: block.damageDice,
    damageBonus: block.damageBonus,
    abilities: cloneCatalogValue(block.abilities ?? {}),
    creature_type: block.creature_type,
    // Пустые строки стат-блока не превращаются в пустые массивы: запись врага
    // остаётся той же формы, что и была, пока у существа нечего объявлять.
    ...(block.damage_vulnerabilities?.length ? { damage_vulnerabilities: cloneCatalogValue(block.damage_vulnerabilities) } : {}),
    ...(block.damage_resistances?.length ? { damage_resistances: cloneCatalogValue(block.damage_resistances) } : {}),
    ...(block.damage_immunities?.length ? { damage_immunities: cloneCatalogValue(block.damage_immunities) } : {}),
    ...(block.condition_immunities?.length ? { condition_immunities: cloneCatalogValue(block.condition_immunities) } : {}),
    image: block.image,
    source_url: block.source_url,
    traits: cloneCatalogValue(block.traits ?? []),
    action_profiles: cloneCatalogValue(block.action_profiles ?? []),
    attack_profile: cloneCatalogValue(block.action_profiles?.[0] ?? {}),
    x: position.x,
    y: position.y,
    alive: true,
    stat_block_id: statBlockId,
    provenance: {
      kind: 'server-owned-srd-primary-attack-projection',
      ruleset_id: 'srd_5_2_1',
      source_version: SRD_5_2_1_SOURCE.version,
      source_sha256: SRD_5_2_1_SOURCE.sha256,
      source_page: block.source_page,
      challenge_rating: block.challenge_rating,
      xp: block.xp,
      dndsu_url: block.source_url,
    },
  }
}

function cloneCatalogValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export class EncounterAssembler {
  assemble(input) {
    const validated = validateInput(input)
    const canonical = JSON.stringify(validated)
    const proposalHash = digest(`${ENCOUNTER_PROPOSAL_VERSION}\u0000${canonical}`)
    // Подрайон боя выводится из уже проверенного входа, а не принимается извне:
    // иначе клетку появления можно было бы подсказать запросом.
    const bounds = spawnBounds(validated.cells, validated.party)
    const availableCells = safePlacementCells(validated.cells, validated.party, bounds)
    if (!availableCells.length) {
      throw new EncounterAssemblyError('Нет безопасных клеток для размещения противников', 'NO_SAFE_PLACEMENT_CELLS')
    }

    const srdBudgetXp = validated.party.reduce((sum, member) => (
      sum + XP_BUDGET_PER_CHARACTER[member.level][SRD_DIFFICULTY[validated.difficulty]]
    ), 0)
    // Умножение — единственное отличие смертельного тира от high, и оно
    // серверное: таблица SRD остаётся нетронутой.
    const budgetXp = validated.difficulty === DEADLY_DIFFICULTY
      ? srdBudgetXp * DEADLY_BUDGET_MULTIPLIER
      : srdBudgetXp
    const quantityCap = Math.min(
      ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures,
      ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures_per_character * validated.party.length,
      availableCells.length,
    )
    const allocation = spendBudget(THEMES[validated.theme], budgetXp, quantityCap, proposalHash)
    if (!allocation.stat_block_ids.length) {
      throw new EncounterAssemblyError('Бюджет не позволяет собрать столкновение выбранной темы', 'BUDGET_CANNOT_FUND_ENCOUNTER')
    }

    const positions = deterministicOrder(availableCells, proposalHash, 'placement')
    const counts = new Map()
    const enemies = allocation.stat_block_ids.map((statBlockId, index) => {
      const ordinal = (counts.get(statBlockId) ?? 0) + 1
      counts.set(statBlockId, ordinal)
      return enemyFrom(statBlockId, positions[index], proposalHash, index, ordinal)
    })
    const spentXp = allocation.spent_xp
    const proposal = {
      proposal_id: `encounter-proposal-${proposalHash.slice(0, 24)}`,
      version: ENCOUNTER_PROPOSAL_VERSION,
      difficulty: validated.difficulty,
      // Ярлык едет рядом с самим уровнем: столу показывают его, а не бюджет.
      difficulty_label: encounterDifficultyLabel(validated.difficulty),
      theme: validated.theme,
      xp_budget: budgetXp,
      xp_spent: spentXp,
      threat: {
        budget_xp: budgetXp,
        spent_xp: spentXp,
        unspent_xp: budgetXp - spentXp,
        utilization_bps: Math.floor(spentXp * 10_000 / budgetXp),
        quantity: enemies.length,
        quantity_cap: quantityCap,
      },
      enemies,
      source: SRD_5_2_1_SOURCE,
    }
    return deepFreeze(proposal)
  }
}

export function assembleEncounter(input) {
  return new EncounterAssembler().assemble(input)
}
