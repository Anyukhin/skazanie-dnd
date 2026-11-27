import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { assembleEncounter, SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'

const EXPECTED_CREATURES = Object.freeze({
  'srd_5_2_1:bandit': {
    name: 'Бандит',
    hp: 11,
    armor: 12,
    speed: 30,
    abilities: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    initiative_bonus: 1,
    challenge_rating: '1/8',
    xp: 25,
    source_page: 261,
    creature_type: 'humanoid',
    image: '/assets/enemies/bandit.png',
    actions: [
      ['scimitar', 'Скимитар', 'melee', '1d6+1', 3, 'slashing', 5, undefined],
      ['light-crossbow', 'Лёгкий арбалет', 'ranged', '1d8+1', 3, 'piercing', 320, 80],
    ],
  },
  'srd_5_2_1:dire-wolf': {
    name: 'Лютый волк',
    hp: 22,
    armor: 14,
    speed: 50,
    abilities: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
    initiative_bonus: 2,
    challenge_rating: '1',
    xp: 200,
    source_page: 347,
    creature_type: 'beast',
    image: '/assets/enemies/dire-wolf.png',
    actions: [['bite', 'Укус', 'melee', '1d10+3', 5, 'piercing', 5, undefined]],
  },
  'srd_5_2_1:ghoul': {
    name: 'Упырь',
    hp: 22,
    armor: 12,
    speed: 30,
    abilities: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 },
    initiative_bonus: 2,
    challenge_rating: '1',
    xp: 200,
    source_page: 288,
    creature_type: 'undead',
    image: '/assets/enemies/ghoul.png',
    actions: [
      ['bite', 'Укус', 'melee', '1d6+2', 4, 'piercing', 5, undefined],
      ['claw', 'Коготь', 'melee', '1d4+2', 4, 'slashing', 5, undefined],
    ],
  },
  'srd_5_2_1:gnoll-warrior': {
    name: 'Гнолл-воин',
    hp: 27,
    armor: 15,
    speed: 30,
    abilities: { str: 14, dex: 12, con: 11, int: 6, wis: 10, cha: 7 },
    initiative_bonus: 1,
    challenge_rating: '1/2',
    xp: 100,
    source_page: 289,
    creature_type: 'fiend',
    image: '/assets/enemies/gnoll-warrior.png',
    actions: [
      ['rend', 'Раздирание', 'melee', '1d6+2', 4, 'piercing', 5, undefined],
      ['bone-bow', 'Костяной лук', 'ranged', '1d10+1', 3, 'piercing', 600, 150],
    ],
  },
  'srd_5_2_1:ogre': {
    name: 'Огр',
    hp: 68,
    armor: 11,
    speed: 40,
    abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    initiative_bonus: -1,
    challenge_rating: '2',
    xp: 450,
    source_page: 312,
    creature_type: 'giant',
    image: '/assets/enemies/ogre.png',
    actions: [
      ['greatclub', 'Палица', 'melee', '2d8+4', 6, 'bludgeoning', 5, undefined],
      ['javelin', 'Метательное копьё', 'ranged', '2d6+4', 6, 'piercing', 120, 30],
    ],
  },
  'srd_5_2_1:owlbear': {
    name: 'Совомед',
    hp: 59,
    armor: 13,
    speed: 40,
    abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
    initiative_bonus: 1,
    challenge_rating: '3',
    xp: 700,
    source_page: 313,
    creature_type: 'monstrosity',
    image: '/assets/enemies/owlbear.png',
    actions: [['rend', 'Раздирание', 'melee', '2d8+5', 7, 'slashing', 5, undefined]],
  },
  'srd_5_2_1:scout': {
    name: 'Разведчик', hp: 16, armor: 13, speed: 30,
    abilities: { str: 11, dex: 14, con: 12, int: 11, wis: 13, cha: 11 },
    initiative_bonus: 2, challenge_rating: '1/2', xp: 100, source_page: 322,
    creature_type: 'humanoid', image: '/assets/enemies/scout.png',
    actions: [
      ['shortsword', 'Короткий меч', 'melee', '1d6+2', 4, 'piercing', 5, undefined],
      ['longbow', 'Длинный лук', 'ranged', '1d8+2', 4, 'piercing', 600, 150],
    ],
  },
  'srd_5_2_1:spy': {
    name: 'Шпион', hp: 27, armor: 12, speed: 30,
    abilities: { str: 10, dex: 15, con: 10, int: 12, wis: 14, cha: 16 },
    initiative_bonus: 4, challenge_rating: '1', xp: 200, source_page: 329,
    creature_type: 'humanoid', image: '/assets/enemies/spy.png',
    actions: [
      ['shortsword', 'Короткий меч', 'melee', '1d6+2', 4, 'piercing', 5, undefined],
      ['hand-crossbow', 'Ручной арбалет', 'ranged', '1d6+2', 4, 'piercing', 120, 30],
    ],
  },
  'srd_5_2_1:giant-centipede': {
    name: 'Гигантская многоножка', hp: 9, armor: 14, speed: 30,
    abilities: { str: 5, dex: 14, con: 12, int: 1, wis: 7, cha: 3 },
    initiative_bonus: 2, challenge_rating: '1/4', xp: 50, source_page: 349,
    creature_type: 'beast', image: '/assets/enemies/giant-centipede.png',
    actions: [['bite', 'Укус', 'melee', '1d4+2', 4, 'piercing', 5, undefined]],
  },
  'srd_5_2_1:violet-fungus': {
    name: 'Лиловый гриб', hp: 18, armor: 5, speed: 5,
    abilities: { str: 3, dex: 1, con: 10, int: 1, wis: 3, cha: 1 },
    initiative_bonus: -5, challenge_rating: '1/4', xp: 50, source_page: 286,
    creature_type: 'plant', image: '/assets/enemies/violet-fungus.png',
    actions: [['rotting-touch', 'Разлагающее касание', 'melee', '1d8', 2, 'necrotic', 10, undefined]],
  },
  'srd_5_2_1:minotaur-skeleton': {
    name: 'Скелет минотавра', hp: 45, armor: 12, speed: 40,
    abilities: { str: 18, dex: 11, con: 15, int: 6, wis: 8, cha: 5 },
    initiative_bonus: 0, challenge_rating: '2', xp: 450, source_page: 326,
    creature_type: 'undead', image: '/assets/enemies/minotaur-skeleton.png',
    actions: [
      ['gore', 'Рога', 'melee', '2d6+4', 6, 'piercing', 5, undefined],
      ['slam', 'Размашистый удар', 'melee', '2d10+4', 6, 'bludgeoning', 5, undefined],
    ],
  },
  'srd_5_2_1:ankylosaurus': {
    name: 'Анкилозавр', hp: 68, armor: 15, speed: 30,
    abilities: { str: 19, dex: 11, con: 15, int: 2, wis: 12, cha: 5 },
    initiative_bonus: 0, challenge_rating: '3', xp: 700, source_page: 344,
    creature_type: 'beast', image: '/assets/enemies/ankylosaurus.png',
    actions: [['tail', 'Хвост', 'melee', '1d10+4', 6, 'bludgeoning', 10, undefined]],
  },
  'srd_5_2_1:berserker': {
    name: 'Берсерк', hp: 67, armor: 13, speed: 30,
    abilities: { str: 16, dex: 12, con: 17, int: 9, wis: 11, cha: 9 },
    initiative_bonus: 1, challenge_rating: '2', xp: 450, source_page: 263,
    creature_type: 'humanoid', image: '/assets/enemies/berserker.png',
    actions: [['greataxe', 'Секира', 'melee', '1d12+3', 5, 'slashing', 5, undefined]],
  },
  'srd_5_2_1:lion': {
    name: 'Лев', hp: 22, armor: 12, speed: 50,
    abilities: { str: 17, dex: 15, con: 11, int: 3, wis: 12, cha: 8 },
    initiative_bonus: 2, challenge_rating: '1', xp: 200, source_page: 356,
    creature_type: 'beast', image: '/assets/enemies/lion.png',
    actions: [['rend', 'Раздирание', 'melee', '1d8+3', 5, 'slashing', 5, undefined]],
  },
  'srd_5_2_1:brown-bear': {
    name: 'Бурый медведь', hp: 22, armor: 11, speed: 40,
    abilities: { str: 17, dex: 12, con: 15, int: 2, wis: 13, cha: 7 },
    initiative_bonus: 1, challenge_rating: '1', xp: 200, source_page: 346,
    creature_type: 'beast', image: '/assets/enemies/brown-bear.png',
    actions: [
      ['bite', 'Укус', 'melee', '1d8+3', 5, 'piercing', 5, undefined],
      ['claw', 'Когти', 'melee', '1d4+3', 5, 'slashing', 5, undefined],
    ],
  },
  'srd_5_2_1:giant-boar': {
    name: 'Гигантский кабан', hp: 42, armor: 13, speed: 40,
    abilities: { str: 17, dex: 10, con: 16, int: 2, wis: 7, cha: 5 },
    initiative_bonus: 0, challenge_rating: '2', xp: 450, source_page: 349,
    creature_type: 'beast', image: '/assets/enemies/giant-boar.png',
    actions: [['gore', 'Бодание', 'melee', '2d6+3', 5, 'piercing', 5, undefined]],
  },
  'srd_5_2_1:tiger': {
    name: 'Тигр', hp: 30, armor: 13, speed: 40,
    abilities: { str: 17, dex: 16, con: 14, int: 3, wis: 12, cha: 8 },
    initiative_bonus: 3, challenge_rating: '1', xp: 200, source_page: 363,
    creature_type: 'beast', image: '/assets/enemies/tiger.png',
    actions: [['rend', 'Раздирание', 'melee', '2d6+3', 5, 'slashing', 5, undefined]],
  },
  'srd_5_2_1:sahuagin-warrior': {
    name: 'Воин сахуагинов', hp: 22, armor: 12, speed: 30,
    abilities: { str: 13, dex: 11, con: 12, int: 12, wis: 13, cha: 9 },
    initiative_bonus: 0, challenge_rating: '1/2', xp: 100, source_page: 321,
    creature_type: 'fiend', image: '/assets/enemies/sahuagin-warrior.png',
    actions: [['claw', 'Когти', 'melee', '1d6+1', 3, 'slashing', 5, undefined]],
  },
  'srd_5_2_1:bandit-captain': {
    name: 'Атаман бандитов', hp: 52, armor: 15, speed: 30,
    abilities: { str: 15, dex: 16, con: 14, int: 14, wis: 11, cha: 14 },
    initiative_bonus: 3, challenge_rating: '2', xp: 450, source_page: 261,
    creature_type: 'humanoid', image: '/assets/enemies/bandit-captain.png',
    actions: [
      ['scimitar', 'Скимитар', 'melee', '1d6+3', 5, 'slashing', 5, undefined],
      ['pistol', 'Пистоль', 'ranged', '1d10+3', 5, 'piercing', 90, 30],
    ],
  },
  'srd_5_2_1:warrior-veteran': {
    name: 'Воитель-ветеран', hp: 65, armor: 17, speed: 30,
    abilities: { str: 16, dex: 13, con: 14, int: 10, wis: 11, cha: 10 },
    initiative_bonus: 3, challenge_rating: '3', xp: 700, source_page: 337,
    creature_type: 'humanoid', image: '/assets/enemies/warrior-veteran.png',
    actions: [
      ['greatsword', 'Двуручный меч', 'melee', '2d6+3', 5, 'slashing', 5, undefined],
      ['heavy-crossbow', 'Тяжёлый арбалет', 'ranged', '2d10+1', 3, 'piercing', 400, 100],
    ],
  },
  'srd_5_2_1:ettin': {
    name: 'Эттин', hp: 85, armor: 12, speed: 40,
    abilities: { str: 21, dex: 8, con: 17, int: 6, wis: 10, cha: 8 },
    initiative_bonus: -1, challenge_rating: '4', xp: 1100, source_page: 284,
    creature_type: 'giant', image: '/assets/enemies/ettin.png',
    actions: [
      ['battleaxe', 'Боевой топор', 'melee', '2d8+5', 7, 'slashing', 5, undefined],
      ['morningstar', 'Моргенштерн', 'melee', '2d8+5', 7, 'piercing', 5, undefined],
    ],
  },
  'srd_5_2_1:guard-captain': {
    name: 'Капитан стражи', hp: 75, armor: 18, speed: 30,
    abilities: { str: 18, dex: 14, con: 16, int: 12, wis: 14, cha: 13 },
    initiative_bonus: 4, challenge_rating: '4', xp: 1100, source_page: 296,
    creature_type: 'humanoid', image: '/assets/enemies/guard-captain.png',
    actions: [
      ['longsword', 'Длинный меч', 'melee', '2d10+4', 6, 'slashing', 5, undefined],
      ['javelin-melee', 'Метательное копьё (рукопашная)', 'melee', '3d6+4', 6, 'piercing', 5, undefined],
      ['javelin-ranged', 'Метательное копьё (бросок)', 'ranged', '3d6+4', 6, 'piercing', 120, 30],
    ],
  },
  'srd_5_2_1:awakened-tree': {
    name: 'Пробуждённое дерево', hp: 59, armor: 13, speed: 20,
    abilities: { str: 19, dex: 6, con: 15, int: 10, wis: 10, cha: 7 },
    initiative_bonus: -2, challenge_rating: '2', xp: 450, source_page: 260,
    creature_type: 'plant', image: '/assets/enemies/awakened-tree.png',
    actions: [['slam', 'Размашистый удар', 'melee', '3d6+4', 6, 'bludgeoning', 10, undefined]],
  },
  'srd_5_2_1:giant-elk': {
    name: 'Гигантский лось', hp: 42, armor: 14, speed: 60,
    abilities: { str: 19, dex: 18, con: 14, int: 7, wis: 14, cha: 10 },
    initiative_bonus: 6, challenge_rating: '2', xp: 450, source_page: 351,
    creature_type: 'celestial', image: '/assets/enemies/giant-elk.png',
    actions: [['ram', 'Таран', 'melee', '2d6+4', 6, 'bludgeoning', 10, undefined]],
  },
  'srd_5_2_1:ogre-zombie': {
    name: 'Огр-зомби', hp: 85, armor: 8, speed: 30,
    abilities: { str: 19, dex: 6, con: 18, int: 3, wis: 6, cha: 5 },
    initiative_bonus: -2, challenge_rating: '2', xp: 450, source_page: 344,
    creature_type: 'undead', image: '/assets/enemies/ogre-zombie.png',
    actions: [['slam', 'Размашистый удар', 'melee', '2d8+4', 6, 'bludgeoning', 5, undefined]],
  },
  'srd_5_2_1:knight': {
    name: 'Рыцарь', hp: 52, armor: 18, speed: 30,
    abilities: { str: 16, dex: 11, con: 14, int: 11, wis: 11, cha: 15 },
    initiative_bonus: 0, challenge_rating: '3', xp: 700, source_page: 302,
    creature_type: 'humanoid', image: '/assets/enemies/knight.png',
    actions: [
      ['greatsword', 'Двуручный меч', 'melee', '2d6+3', 5, 'slashing', 5, undefined],
      ['heavy-crossbow', 'Тяжёлый арбалет', 'ranged', '2d10', 2, 'piercing', 400, 100],
    ],
  },
  'srd_5_2_1:hippopotamus': {
    name: 'Гиппопотам', hp: 82, armor: 14, speed: 30,
    abilities: { str: 21, dex: 7, con: 15, int: 2, wis: 12, cha: 4 },
    initiative_bonus: -2, challenge_rating: '4', xp: 1100, source_page: 355,
    creature_type: 'beast', image: '/assets/enemies/hippopotamus.png',
    actions: [['bite', 'Укус', 'melee', '2d10+5', 7, 'piercing', 5, undefined]],
  },
  'srd_5_2_1:earth-elemental': {
    name: 'Земляной элементаль', hp: 147, armor: 17, speed: 30,
    abilities: { str: 20, dex: 8, con: 20, int: 5, wis: 10, cha: 5 },
    initiative_bonus: -1, challenge_rating: '5', xp: 1800, source_page: 282,
    creature_type: 'elemental', image: '/assets/enemies/earth-elemental.png',
    actions: [
      ['slam', 'Размашистый удар', 'melee', '2d8+5', 8, 'bludgeoning', 10, undefined],
      ['rock-launch', 'Бросок булыжника', 'ranged', '1d6+5', 8, 'bludgeoning', 60, 60],
    ],
  },
  'srd_5_2_1:hill-giant': {
    name: 'Холмовой великан', hp: 105, armor: 13, speed: 40,
    abilities: { str: 21, dex: 8, con: 19, int: 5, wis: 9, cha: 6 },
    initiative_bonus: 2, challenge_rating: '5', xp: 1800, source_page: 298,
    creature_type: 'giant', image: '/assets/enemies/hill-giant.png',
    actions: [
      ['tree-club', 'Вырванное дерево', 'melee', '3d8+5', 8, 'bludgeoning', 10, undefined],
      ['trash-lob', 'Пригоршня мусора', 'ranged', '2d10+5', 8, 'bludgeoning', 240, 60],
    ],
  },
  'srd_5_2_1:xorn': {
    name: 'Зорн', hp: 84, armor: 19, speed: 20,
    abilities: { str: 17, dex: 10, con: 22, int: 11, wis: 10, cha: 11 },
    initiative_bonus: 0, challenge_rating: '5', xp: 1800, source_page: 343,
    creature_type: 'elemental', image: '/assets/enemies/xorn.png',
    actions: [
      ['bite', 'Укус', 'melee', '4d6+3', 6, 'piercing', 5, undefined],
      ['claw', 'Когти', 'melee', '1d10+3', 6, 'slashing', 5, undefined],
    ],
  },
  'srd_5_2_1:animated-armor': {
    name: 'Живой доспех', hp: 33, armor: 18, speed: 25,
    abilities: { str: 14, dex: 11, con: 13, int: 1, wis: 3, cha: 1 },
    initiative_bonus: 2, challenge_rating: '1', xp: 200, source_page: 259,
    creature_type: 'construct', image: '/assets/enemies/animated-armor.png',
    actions: [['slam', 'Размашистый удар', 'melee', '1d6+2', 4, 'bludgeoning', 5, undefined]],
  },
  'srd_5_2_1:ochre-jelly': {
    name: 'Золотистый студень', hp: 52, armor: 8, speed: 20,
    abilities: { str: 15, dex: 6, con: 14, int: 2, wis: 6, cha: 1 },
    initiative_bonus: -2, challenge_rating: '2', xp: 450, source_page: 312,
    creature_type: 'ooze', image: '/assets/enemies/ochre-jelly.png',
    actions: [['pseudopod', 'Ложноножка', 'melee', '3d6+2', 4, 'acid', 5, undefined]],
  },
  'srd_5_2_1:barbed-devil': {
    name: 'Шипастый дьявол', hp: 110, armor: 15, speed: 30,
    abilities: { str: 16, dex: 17, con: 18, int: 12, wis: 14, cha: 14 },
    initiative_bonus: 3, challenge_rating: '5', xp: 1800, source_page: 262,
    creature_type: 'fiend', image: '/assets/enemies/barbed-devil.png',
    actions: [
      ['claws', 'Когти', 'melee', '2d6+3', 6, 'piercing', 5, undefined],
      ['tail', 'Хвост', 'melee', '2d10+3', 6, 'slashing', 10, undefined],
    ],
  },
  'srd_5_2_1:gladiator': {
    name: 'Гладиатор', hp: 112, armor: 16, speed: 30,
    abilities: { str: 18, dex: 15, con: 16, int: 10, wis: 12, cha: 15 },
    initiative_bonus: 5, challenge_rating: '5', xp: 1800, source_page: 289,
    creature_type: 'humanoid', image: '/assets/enemies/gladiator.png',
    actions: [
      ['spear-melee', 'Копьё (рукопашная)', 'melee', '2d6+4', 7, 'piercing', 5, undefined],
      ['spear-ranged', 'Копьё (бросок)', 'ranged', '2d6+4', 7, 'piercing', 60, 20],
    ],
  },
  'srd_5_2_1:giant-scorpion': {
    name: 'Гигантский скорпион', hp: 52, armor: 15, speed: 40,
    abilities: { str: 16, dex: 13, con: 15, int: 1, wis: 9, cha: 3 },
    initiative_bonus: 1, challenge_rating: '3', xp: 700, source_page: 353,
    creature_type: 'beast', image: '/assets/enemies/giant-scorpion.png',
    actions: [
      ['claw', 'Клешня', 'melee', '1d6+3', 5, 'bludgeoning', 5, undefined],
      ['sting', 'Жало', 'melee', '1d8+3', 5, 'piercing', 5, undefined],
    ],
  },
  'srd_5_2_1:wyvern': {
    name: 'Виверна', hp: 127, armor: 14, speed: 30,
    abilities: { str: 19, dex: 10, con: 16, int: 5, wis: 12, cha: 6 },
    initiative_bonus: 0, challenge_rating: '6', xp: 2300, source_page: 343,
    creature_type: 'dragon', image: '/assets/enemies/wyvern.png',
    actions: [
      ['bite', 'Укус', 'melee', '2d8+4', 7, 'piercing', 5, undefined],
      ['sting', 'Жало', 'melee', '2d6+4', 7, 'piercing', 10, undefined],
    ],
  },
  'srd_5_2_1:manticore': {
    name: 'Мантикора', hp: 68, armor: 14, speed: 30,
    abilities: { str: 17, dex: 16, con: 17, int: 7, wis: 12, cha: 8 },
    initiative_bonus: 3, challenge_rating: '3', xp: 700, source_page: 306,
    creature_type: 'monstrosity', image: '/assets/enemies/manticore.png',
    actions: [
      ['rend', 'Раздирание', 'melee', '1d8+3', 5, 'slashing', 5, undefined],
      ['tail-spike', 'Хвостовой шип', 'ranged', '1d8+3', 5, 'piercing', 200, 100],
    ],
  },
  'srd_5_2_1:tough-boss': {
    name: 'Босс громил', hp: 82, armor: 16, speed: 30,
    abilities: { str: 17, dex: 14, con: 16, int: 11, wis: 10, cha: 11 },
    initiative_bonus: 2, challenge_rating: '4', xp: 1100, source_page: 332,
    creature_type: 'humanoid', image: '/assets/enemies/tough-boss.png',
    actions: [
      ['warhammer', 'Боевой молот', 'melee', '2d8+3', 5, 'bludgeoning', 5, undefined],
      ['heavy-crossbow', 'Тяжёлый арбалет', 'ranged', '2d10+2', 4, 'piercing', 400, 100],
    ],
  },
})

function pngDimensions(buffer) {
  assert.ok(buffer.subarray(1, 4).equals(Buffer.from('PNG')), 'файл обязан быть PNG')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

test('новые существа точно проецируют stat blocks из SRD 5.2.1', () => {
  for (const [id, expected] of Object.entries(EXPECTED_CREATURES)) {
    const actual = SRD_5_2_1_MONSTER_ALLOWLIST[id]
    assert.ok(actual, `${id}: запись отсутствует`)
    for (const field of [
      'name', 'hp', 'armor', 'speed', 'initiative_bonus',
      'challenge_rating', 'xp', 'source_page', 'creature_type', 'image',
    ]) {
      assert.equal(actual[field], expected[field], `${id}.${field}`)
    }
    assert.deepEqual(actual.abilities, expected.abilities, `${id}.abilities`)
    assert.ok(actual.source_url?.startsWith('https://'), `${id}.source_url`)
    assert.deepEqual(
      actual.action_profiles.map((action) => [
        action.id,
        action.name,
        action.kind,
        action.damage_expression,
        action.attack_modifier,
        action.damage_type,
        action.range_feet,
        action.normal_range_feet,
      ]),
      expected.actions,
      `${id}.action_profiles`,
    )
  }

  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:dire-wolf'].action_profiles[0].on_hit, {
    save_ability: 'str',
    save_dc: 13,
    condition: 'prone',
    duration: 'until-next-turn',
  })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].action_profiles[0].on_hit, {
    damage_expression: '1d6',
    damage_type: 'necrotic',
  })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].action_profiles[1].on_hit, {
    save_ability: 'con',
    save_dc: 10,
    condition: 'paralyzed',
    duration: 'until-next-turn',
  })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ghoul'].traits[0].attacks, 2)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:owlbear'].traits[0].attacks, 2)
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:spy'].action_profiles[1].on_hit, {
    damage_expression: '2d6',
    damage_type: 'poison',
  })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-centipede'].action_profiles[0].on_hit, {
    condition: 'poisoned',
    duration: 'until-source-next-turn',
  })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ankylosaurus'].traits[0].attacks, 2)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ankylosaurus'].action_profiles[0].on_hit.target_size_max, 'huge')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:scout'].traits[0].action_id, undefined)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:berserker'].traits[0].id, 'bloodied-frenzy')
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:brown-bear'].traits[0].action_counts, { bite: 1, claw: 1 })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:brown-bear'].action_profiles[1].on_hit.target_size_max, 'large')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-boar'].traits[1].saving_throws, false)
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-boar'].traits[1].attack_kinds, ['melee'])
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:warrior-veteran'].traits[0].same_action, true)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:tiger'].traits[0].id, 'nimble-escape')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:tiger'].action_profiles[0].on_hit.target_size_max, 'large')
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ettin'].traits[0].action_counts, { battleaxe: 1, morningstar: 1 })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ettin'].action_profiles[0].on_hit.target_size_max, 'large')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ettin'].action_profiles[1].on_hit.duration, 'until-own-turn-end')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:guard-captain'].traits[0].attacks, 2)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:awakened-tree'].traits[0].id, 'relentless-pursuit')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-elk'].traits[0].target_size_max, 'huge')
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-elk'].action_profiles[0].on_hit, {
    damage_expression: '2d4',
    damage_type: 'radiant',
  })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ogre-zombie'].traits[0].id, 'undead-fortitude')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:knight'].traits[0].attacks, 2)
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:knight'].action_profiles[0].on_hit, {
    damage_expression: '1d8',
    damage_type: 'radiant',
  })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:hippopotamus'].traits[0].action_id, 'bite')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:earth-elemental'].action_profiles[1].on_hit.target_size_max, 'large')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:hill-giant'].action_profiles[0].on_hit.target_size_max, 'large')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:hill-giant'].action_profiles[1].on_hit.duration, 'until-own-turn-end')
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:xorn'].traits[0].action_counts, { bite: 1, claw: 3 })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:xorn'].traits[1].id, 'aggressive')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:animated-armor'].traits[0].action_id, 'slam')
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:ochre-jelly'].traits[0].id, 'relentless-pursuit')
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:barbed-devil'].traits[0].action_counts, { claws: 1, tail: 1 })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:gladiator'].traits[0].attacks, 3)
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-scorpion'].traits[0].action_counts, { claw: 2, sting: 1 })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-scorpion'].action_profiles[1].on_hit, {
    damage_expression: '2d10',
    damage_type: 'poison',
  })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:wyvern'].traits[0].action_counts, { bite: 1, sting: 1 })
  assert.deepEqual(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:wyvern'].action_profiles[1].on_hit, {
    damage_expression: '7d6',
    damage_type: 'poison',
    condition: 'poisoned',
    duration: 'until-source-next-turn',
  })
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:manticore'].traits[0].attacks, 3)
  assert.equal(SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:tough-boss'].traits[0].id, 'pack-tactics')
})

test('весь allowlist имеет локальные портреты 512×512 без скрытых копий', async () => {
  const hashes = new Map()
  const basenames = new Map()
  const sharedGoblinIds = new Set(['srd_5_2_1:goblin-minion', 'srd_5_2_1:goblin-warrior'])

  for (const [id, block] of Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)) {
    const basename = block.image.replace('/assets/enemies/', '')
    const previousOwner = basenames.get(basename)
    if (previousOwner) {
      assert.ok(sharedGoblinIds.has(id) && sharedGoblinIds.has(previousOwner), `${id}: портрет повторно использован`)
    } else {
      basenames.set(basename, id)
    }

    const fileUrl = new URL(`../public/assets/enemies/${basename}`, import.meta.url)
    const buffer = await readFile(fileURLToPath(fileUrl))
    assert.ok(buffer.length >= 20_000, `${id}: изображение подозрительно мало`)
    assert.deepEqual(pngDimensions(buffer), { width: 512, height: 512 }, `${id}: размер PNG`)

    const hash = createHash('sha256').update(buffer).digest('hex')
    const previousHashOwner = hashes.get(hash)
    if (previousHashOwner) {
      assert.ok(sharedGoblinIds.has(id) && sharedGoblinIds.has(previousHashOwner), `${id}: содержимое портрета повторяется`)
    } else {
      hashes.set(hash, id)
    }
  }
})

test('новые существа достижимы через подходящие семантические темы', () => {
  const sceneCells = Array.from({ length: 5 }, (_, y) => (
    Array.from({ length: 7 }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
  const cases = [
    ['srd_5_2_1:bandit', 'raiders', 1, 'medium', 'reach-0'],
    ['srd_5_2_1:dire-wolf', 'beasts', 2, 'hard', 'reach-0'],
    ['srd_5_2_1:ghoul', 'undead', 2, 'hard', 'reach-0'],
    ['srd_5_2_1:gnoll-warrior', 'warband', 1, 'hard', 'reach-1'],
    ['srd_5_2_1:ogre', 'warband', 4, 'hard', 'reach-0'],
    ['srd_5_2_1:owlbear', 'wilderness', 5, 'medium', 'reach-2'],
    ['srd_5_2_1:scout', 'ambush', 1, 'hard', 'wave1-scout-0'],
    ['srd_5_2_1:spy', 'ambush', 2, 'hard', 'wave1-spy-1'],
    ['srd_5_2_1:giant-centipede', 'vermin', 1, 'easy', 'wave1-giant-centipede-0'],
    ['srd_5_2_1:violet-fungus', 'vermin', 1, 'easy', 'wave1-violet-fungus-0'],
    ['srd_5_2_1:minotaur-skeleton', 'undead', 4, 'hard', 'wave1-minotaur-skeleton-0'],
    ['srd_5_2_1:ankylosaurus', 'wilderness', 5, 'medium', 'reach-0'],
    ['srd_5_2_1:berserker', 'raiders', 4, 'hard', 'wave1-berserker-2'],
    ['srd_5_2_1:lion', 'beasts', 2, 'hard', 'wave1-lion-2'],
    ['srd_5_2_1:brown-bear', 'beasts', 2, 'hard', 'wave2-0'],
    ['srd_5_2_1:giant-boar', 'wilderness', 4, 'hard', 'wave2-0'],
    ['srd_5_2_1:tiger', 'ambush', 2, 'hard', 'wave2-0'],
    ['srd_5_2_1:sahuagin-warrior', 'warband', 1, 'hard', 'wave2-1'],
    ['srd_5_2_1:bandit-captain', 'raiders', 4, 'hard', 'wave2-6'],
    ['srd_5_2_1:warrior-veteran', 'warband', [2, 4], 'hard', 'wave2-hi-0'],
    ['srd_5_2_1:ettin', 'cave', 5, 'hard', 'wave2-hi-0'],
    ['srd_5_2_1:guard-captain', 'warband', 5, 'hard', 'wave2-hi-0'],
    ['srd_5_2_1:awakened-tree', 'wilderness', [1, 5], 'easy', 'search-srd_5_2_1:awakened-tree-easy-1-5'],
    ['srd_5_2_1:giant-elk', 'beasts', [1, 5], 'easy', 'search-srd_5_2_1:giant-elk-easy-1-5'],
    ['srd_5_2_1:ogre-zombie', 'undead', [1, 5], 'easy', 'search-srd_5_2_1:ogre-zombie-easy-1-5'],
    ['srd_5_2_1:knight', 'warband', [1, 7], 'easy', 'search-srd_5_2_1:knight-easy-1-7'],
    ['srd_5_2_1:hippopotamus', 'beasts', [1, 9], 'easy', 'search-srd_5_2_1:hippopotamus-easy-1-9'],
    ['srd_5_2_1:earth-elemental', 'cave', [1, 11], 'easy', 'search-srd_5_2_1:earth-elemental-easy-1-11'],
    ['srd_5_2_1:hill-giant', 'raiders', [1, 11], 'easy', 'search-srd_5_2_1:hill-giant-easy-1-11'],
    ['srd_5_2_1:xorn', 'cave', [1, 11], 'easy', 'search-srd_5_2_1:xorn-easy-1-11'],
    ['srd_5_2_1:animated-armor', 'crypt', [1, 3], 'easy', 'search-srd_5_2_1:animated-armor-easy-1-3'],
    ['srd_5_2_1:ochre-jelly', 'vermin', [1, 5], 'easy', 'search-srd_5_2_1:ochre-jelly-easy-1-5'],
    ['srd_5_2_1:barbed-devil', 'warband', [1, 12], 'easy', 'search-srd_5_2_1:barbed-devil-easy-1-12'],
    ['srd_5_2_1:gladiator', 'raiders', [1, 11], 'easy', 'search-srd_5_2_1:gladiator-easy-1-11'],
    ['srd_5_2_1:giant-scorpion', 'vermin', [1, 7], 'easy', 'search-srd_5_2_1:giant-scorpion-easy-1-7'],
    ['srd_5_2_1:wyvern', 'ambush', [1, 13], 'easy', 'search-srd_5_2_1:wyvern-easy-1-13'],
    ['srd_5_2_1:manticore', 'ambush', [1, 7], 'easy', 'search-srd_5_2_1:manticore-easy-1-7'],
    ['srd_5_2_1:tough-boss', 'warband', [1, 10], 'easy', 'search-srd_5_2_1:tough-boss-easy-1-10'],
  ]

  for (const [id, theme, levelOrLevels, difficulty, seed] of cases) {
    const party = (Array.isArray(levelOrLevels) ? levelOrLevels : [levelOrLevels])
      .map((level, index) => ({ id: `hero-${index + 1}`, level, x: index, y: 0 }))
    let proposal = null
    for (let index = 0; index < 256 && !proposal; index += 1) {
      const candidate = assembleEncounter({
        scene: { cells: sceneCells },
        party,
        difficulty,
        theme,
        seed: `${seed}-${index}`,
      })
      if (candidate.enemies.some((enemy) => enemy.stat_block_id === id)) proposal = candidate
    }
    assert.ok(
      proposal?.enemies.some((enemy) => enemy.stat_block_id === id),
      `${id}: не собирается темой ${theme}`,
    )
  }
})
