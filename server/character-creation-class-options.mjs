/**
 * Данные и проверка классовых выборов для создания героя 1 уровня по PHB 2014.
 *
 * Модуль намеренно не импортирует Rules Engine и не вызывает модель. Он лишь
 * превращает выбор игрока в структурированные преимущества класса; исполнение
 * этих преимуществ остаётся владельцам соответствующей механики.
 */

const BASIC_RULES_SOURCE = 'https://www.dndbeyond.com/sources/dnd/basic-rules-2014/classes'

const DND_SU_CLASS_SOURCES = Object.freeze({
  barbarian: 'https://www.dnd.su/class/87-barbarian/',
  bard: 'https://www.dnd.su/class/88-bard/',
  cleric: 'https://www.dnd.su/class/89-cleric/',
  druid: 'https://www.dnd.su/class/90-druid/',
  fighter: 'https://www.dnd.su/class/91-fighter/',
  monk: 'https://www.dnd.su/class/93-monk/',
  paladin: 'https://www.dnd.su/class/94-paladin/',
  ranger: 'https://www.dnd.su/class/97-ranger/',
  rogue: 'https://www.dnd.su/class/99-rogue/',
  sorcerer: 'https://www.dnd.su/class/101-sorcerer/',
  warlock: 'https://www.dnd.su/class/104-warlock/',
  wizard: 'https://www.dnd.su/class/105-wizard/',
})

export const CLASS_OPTIONS_PROVENANCE = Object.freeze({
  ruleset_id: 'dnd_5e_2014',
  edition_family: '5e_2014',
  source_book: "Player's Handbook (2014)",
  primary_source_url: BASIC_RULES_SOURCE,
  secondary_source_urls: Object.freeze({ ...DND_SU_CLASS_SOURCES }),
})

export const PHB_2014_CLASS_KEYS = Object.freeze([
  'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard',
])

const ALL_SKILLS = Object.freeze([
  'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history',
  'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception',
  'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival',
])

const MUSICAL_INSTRUMENTS = Object.freeze([
  'bagpipes', 'drum', 'dulcimer', 'flute', 'lute', 'lyre', 'horn', 'pan_flute', 'shawm', 'viol',
])

const ARTISAN_TOOLS = Object.freeze([
  'alchemists_supplies', 'brewers_supplies', 'calligraphers_supplies', 'carpenters_tools',
  'cartographers_tools', 'cobblers_tools', 'cooks_utensils', 'glassblowers_tools',
  'jewelers_tools', 'leatherworkers_tools', 'masons_tools', 'painters_supplies',
  'potters_tools', 'smiths_tools', 'tinkers_tools', 'weavers_tools', 'woodcarvers_tools',
])

// Полный список примеров инструментов из таблицы Tools в PHB 2014. Текущий
// каталог предысторий содержит лишь используемые им варианты, поэтому для
// создания класса и авторской предыстории нужен отдельный полный список.
const GAMING_SETS = Object.freeze(['dice_set', 'dragonchess', 'playing_cards', 'three_dragon_ante'])
const OTHER_TOOLS = Object.freeze([
  'disguise_kit', 'forgery_kit', 'herbalism_kit', 'navigators_tools', 'poisoners_kit',
  'thieves_tools', 'vehicles_land', 'vehicles_water',
])

export const PHB_2014_GAMING_SETS = GAMING_SETS
export const PHB_2014_OTHER_TOOLS = OTHER_TOOLS
export const PHB_2014_TOOL_OPTIONS = Object.freeze({
  artisan_tools: ARTISAN_TOOLS,
  musical_instruments: MUSICAL_INSTRUMENTS,
  gaming_sets: GAMING_SETS,
  other_tools: OTHER_TOOLS,
})
export const PHB_2014_TOOL_IDS = Object.freeze([...new Set([
  ...ARTISAN_TOOLS, ...MUSICAL_INSTRUMENTS, ...GAMING_SETS, ...OTHER_TOOLS,
])])

const TOOL_LABELS = Object.freeze({
  alchemists_supplies: 'Алхимические принадлежности', brewers_supplies: 'Принадлежности пивовара', calligraphers_supplies: 'Инструменты каллиграфа',
  carpenters_tools: 'Инструменты плотника', cartographers_tools: 'Инструменты картографа', cobblers_tools: 'Инструменты сапожника', cooks_utensils: 'Кухонная утварь',
  glassblowers_tools: 'Инструменты стеклодува', jewelers_tools: 'Инструменты ювелира', leatherworkers_tools: 'Инструменты кожевника', masons_tools: 'Инструменты каменщика',
  painters_supplies: 'Принадлежности художника', potters_tools: 'Инструменты гончара', smiths_tools: 'Инструменты кузнеца', tinkers_tools: 'Инструменты ремонтника',
  weavers_tools: 'Инструменты ткача', woodcarvers_tools: 'Инструменты резчика по дереву',
  bagpipes: 'Волынка', drum: 'Барабан', dulcimer: 'Цимбалы', flute: 'Флейта', lute: 'Лютня', lyre: 'Лира', horn: 'Рожок', pan_flute: 'Свирель', shawm: 'Шалмей', viol: 'Виола',
  dice_set: 'Набор костей', dragonchess: 'Набор драконьих шахмат', playing_cards: 'Набор игральных карт', three_dragon_ante: 'Набор «Ставка трёх драконов»',
  disguise_kit: 'Набор для грима', forgery_kit: 'Набор для подделок', herbalism_kit: 'Набор травника', navigators_tools: 'Инструменты навигатора', poisoners_kit: 'Инструменты отравителя',
  thieves_tools: 'Воровские инструменты', vehicles_land: 'Наземный транспорт', vehicles_water: 'Водный транспорт',
})

const TOOL_WEIGHTS = Object.freeze({
  alchemists_supplies: 8, brewers_supplies: 9, calligraphers_supplies: 5, carpenters_tools: 6,
  cartographers_tools: 6, cobblers_tools: 5, cooks_utensils: 8, glassblowers_tools: 5,
  jewelers_tools: 2, leatherworkers_tools: 5, masons_tools: 8, painters_supplies: 5,
  potters_tools: 3, smiths_tools: 8, tinkers_tools: 10, weavers_tools: 5, woodcarvers_tools: 5,
  bagpipes: 6, drum: 3, dulcimer: 10, flute: 1, lute: 2, lyre: 2, horn: 2, pan_flute: 2, shawm: 1, viol: 1,
  dice_set: 0, dragonchess: 0.5, playing_cards: 0, three_dragon_ante: 0,
  disguise_kit: 3, forgery_kit: 5, herbalism_kit: 3, navigators_tools: 2, poisoners_kit: 2, thieves_tools: 1,
  vehicles_land: 0, vehicles_water: 0,
})

export const PHB_2014_TOOL_CATALOG = Object.freeze([
  ...ARTISAN_TOOLS.map((id) => ({ id, kind: 'artisan_tool', label: TOOL_LABELS[id], weight: TOOL_WEIGHTS[id] })),
  ...MUSICAL_INSTRUMENTS.map((id) => ({ id, kind: 'musical_instrument', label: TOOL_LABELS[id], weight: TOOL_WEIGHTS[id] })),
  ...GAMING_SETS.map((id) => ({ id, kind: 'gaming_set', label: TOOL_LABELS[id], weight: TOOL_WEIGHTS[id] })),
  ...OTHER_TOOLS.map((id) => ({ id, kind: 'other_tool', label: TOOL_LABELS[id], weight: TOOL_WEIGHTS[id] })),
])

const DRUID_CANTRIPS = Object.freeze([
  'druidcraft', 'guidance', 'mending', 'poison_spray', 'produce_flame', 'resistance',
  'shillelagh', 'thorn_whip',
])

export const PHB_2014_MUSICAL_INSTRUMENTS = MUSICAL_INSTRUMENTS
export const PHB_2014_ARTISAN_TOOLS = ARTISAN_TOOLS
export const PHB_2014_DRUID_CANTRIPS = DRUID_CANTRIPS
export const PHB_2014_SKILLS = ALL_SKILLS

const DRACONIC_ANCESTRIES = deepFreeze({
  black: { label: 'Чёрный', damage_type: 'acid' },
  blue: { label: 'Синий', damage_type: 'lightning' },
  brass: { label: 'Латунный', damage_type: 'fire' },
  bronze: { label: 'Бронзовый', damage_type: 'lightning' },
  copper: { label: 'Медный', damage_type: 'acid' },
  gold: { label: 'Золотой', damage_type: 'fire' },
  green: { label: 'Зелёный', damage_type: 'poison' },
  red: { label: 'Красный', damage_type: 'fire' },
  silver: { label: 'Серебряный', damage_type: 'cold' },
  white: { label: 'Белый', damage_type: 'cold' },
})

export const PHB_2014_DRACONIC_ANCESTRIES = DRACONIC_ANCESTRIES

const FAVORED_ENEMY_TYPES = Object.freeze([
  'aberrations', 'beasts', 'celestials', 'constructs', 'dragons', 'elementals', 'fey',
  'fiends', 'giants', 'humanoids', 'monstrosities', 'oozes', 'plants', 'undead',
])

// Эти группы имеют обычный язык в базовом справочнике. Для остальных типов
// правила оставляют возможность, что конкретные враги вообще не говорят.
const FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES = Object.freeze([
  'aberrations', 'celestials', 'dragons', 'elementals', 'fey', 'fiends', 'giants', 'humanoids',
])

const NATURAL_EXPLORER_TERRAINS = Object.freeze([
  'arctic', 'coast', 'desert', 'forest', 'grassland', 'mountain', 'swamp', 'underdark',
])

export const PHB_2014_FAVORED_ENEMY_TYPES = FAVORED_ENEMY_TYPES
export const PHB_2014_FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES = FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES
export const PHB_2014_NATURAL_EXPLORER_TERRAINS = NATURAL_EXPLORER_TERRAINS

const classSkill = (count, options) => ({ count, choice_count: count, options: [...options] })
const feature = (id, name, summary) => ({ id, name, level: 1, summary })
const spellcasting = (ability, details) => ({ ability, ...details })
const domainSpells = (spellIds) => ({
  1: [...spellIds],
  always_prepared: true,
  counts_against_prepared_limit: false,
})

const classDefinitions = {
  barbarian: {
    id: 'barbarian', label: 'Варвар', english_name: 'Barbarian', hit_die: 12,
    primary_abilities: ['str'], saving_throw_proficiencies: ['str', 'con'],
    armor_proficiencies: ['light', 'medium', 'shields'], weapon_proficiencies: ['simple', 'martial'],
    tool_proficiencies: [],
    skill_choice: classSkill(2, ['athletics', 'perception', 'survival', 'intimidation', 'nature', 'animal_handling']),
    subclass_options: [],
    features: [
      feature('rage', 'Ярость', 'Два использования за продолжительный отдых; бонусное действие, сопротивление дробящему, колющему и рубящему урону.'),
      feature('unarmored-defense', 'Защита без доспехов', 'КД равен 10 + модификатор Ловкости + модификатор Телосложения без доспехов; щит использовать можно.'),
    ],
    spellcasting: null,
  },
  bard: {
    id: 'bard', label: 'Бард', english_name: 'Bard', hit_die: 8,
    primary_abilities: ['cha'], saving_throw_proficiencies: ['dex', 'cha'],
    armor_proficiencies: ['light'], weapon_proficiencies: ['simple', 'hand_crossbow', 'longsword', 'rapier', 'shortsword'],
    tool_proficiencies: [],
    tool_choice: { id: 'musical_instruments', kind: 'musical_instrument', count: 3, options: [...MUSICAL_INSTRUMENTS] },
    skill_choice: classSkill(3, ALL_SKILLS),
    subclass_options: [],
    features: [
      feature('spellcasting', 'Использование заклинаний', 'Харизма — ключевая характеристика заклинаний барда.'),
      feature('bardic-inspiration', 'Бардовское вдохновение', 'Бонусным действием одно существо в пределах 60 футов получает кость бардовского вдохновения 1к6 на 10 минут; её можно добавить к одной проверке, атаке или спасброску.'),
    ],
    spellcasting: spellcasting('cha', { cantrips_known: 2, spells_known: 4, first_level_spell_slots: 2 }),
  },
  cleric: {
    id: 'cleric', label: 'Жрец', english_name: 'Cleric', hit_die: 8,
    primary_abilities: ['wis'], saving_throw_proficiencies: ['wis', 'cha'],
    armor_proficiencies: ['light', 'medium', 'shields'], weapon_proficiencies: ['simple'],
    tool_proficiencies: [],
    skill_choice: classSkill(2, ['history', 'insight', 'medicine', 'persuasion', 'religion']),
    subclass_level: 1,
    subclass_label: 'Божественный домен',
    subclass_options: [],
    features: [
      feature('spellcasting', 'Использование заклинаний', 'Мудрость — ключевая характеристика заклинаний жреца.'),
      feature('divine-domain', 'Божественный домен', 'Выберите один домен, связанный с божеством; выбор даёт доменные заклинания и особенности на 1 уровне.'),
    ],
    spellcasting: spellcasting('wis', { cantrips_known: 3, prepared_formula: 'wisdom_modifier + cleric_level (minimum 1)', first_level_spell_slots: 2 }),
  },
  druid: {
    id: 'druid', label: 'Друид', english_name: 'Druid', hit_die: 8,
    primary_abilities: ['wis'], saving_throw_proficiencies: ['int', 'wis'],
    armor_proficiencies: ['light', 'medium', 'shields'], armor_restrictions: ['nonmetal'],
    weapon_proficiencies: ['club', 'dagger', 'dart', 'javelin', 'mace', 'quarterstaff', 'scimitar', 'sickle', 'sling', 'spear'],
    tool_proficiencies: ['herbalism_kit'],
    skill_choice: classSkill(2, ['arcana', 'animal_handling', 'insight', 'medicine', 'nature', 'perception', 'religion', 'survival']),
    subclass_options: [],
    features: [
      feature('druidic', 'Друидический', 'Вы знаете тайный язык друидов и можете оставлять скрытые послания.'),
      feature('spellcasting', 'Использование заклинаний', 'Мудрость — ключевая характеристика заклинаний друида.'),
    ],
    spellcasting: spellcasting('wis', { cantrips_known: 2, prepared_formula: 'wisdom_modifier + druid_level (minimum 1)', first_level_spell_slots: 2 }),
  },
  fighter: {
    id: 'fighter', label: 'Воин', english_name: 'Fighter', hit_die: 10,
    primary_abilities: ['str', 'dex'], saving_throw_proficiencies: ['str', 'con'],
    armor_proficiencies: ['light', 'medium', 'heavy', 'shields'], weapon_proficiencies: ['simple', 'martial'],
    tool_proficiencies: [],
    skill_choice: classSkill(2, ['acrobatics', 'animal_handling', 'athletics', 'history', 'insight', 'intimidation', 'perception', 'survival']),
    subclass_options: [],
    tool_choice: { id: 'fighting_style', kind: 'fighting_style', count: 1, options: ['archery', 'defense', 'dueling', 'great_weapon_fighting', 'protection', 'two_weapon_fighting'] },
    features: [
      feature('fighting-style', 'Боевой стиль', 'Выберите один боевой стиль из шести вариантов PHB 2014.'),
      feature('second-wind', 'Второе дыхание', 'Бонусным действием восстановите 1к10 + уровень хитов; восстановление после короткого или продолжительного отдыха.'),
    ],
    spellcasting: null,
  },
  monk: {
    id: 'monk', label: 'Монах', english_name: 'Monk', hit_die: 8,
    primary_abilities: ['dex', 'wis'], saving_throw_proficiencies: ['str', 'dex'],
    armor_proficiencies: [], weapon_proficiencies: ['simple', 'shortsword'], tool_proficiencies: [],
    tool_choice: {
      id: 'artisan_tool_or_musical_instrument', kind: 'artisan_tool_or_musical_instrument', count: 1,
      options: [...ARTISAN_TOOLS, ...MUSICAL_INSTRUMENTS],
      option_kinds: { artisan_tools: [...ARTISAN_TOOLS], musical_instruments: [...MUSICAL_INSTRUMENTS] },
    },
    skill_choice: classSkill(2, ['acrobatics', 'athletics', 'history', 'insight', 'religion', 'stealth']),
    subclass_options: [],
    features: [
      feature('unarmored-defense', 'Защита без доспехов', 'КД равен 10 + модификатор Ловкости + модификатор Мудрости без доспехов и щита.'),
      feature('martial-arts', 'Боевые искусства', 'Безоружные удары и оружие монаха используют кость 1к4 и позволяют безоружный удар бонусным действием.'),
    ],
    spellcasting: null,
  },
  paladin: {
    id: 'paladin', label: 'Паладин', english_name: 'Paladin', hit_die: 10,
    primary_abilities: ['str', 'cha'], saving_throw_proficiencies: ['wis', 'cha'],
    armor_proficiencies: ['light', 'medium', 'heavy', 'shields'], weapon_proficiencies: ['simple', 'martial'],
    tool_proficiencies: [],
    skill_choice: classSkill(2, ['athletics', 'insight', 'intimidation', 'medicine', 'persuasion', 'religion']),
    subclass_options: [],
    features: [
      feature('divine-sense', 'Божественное чувство', 'Количество использований равно 1 + модификатор Харизмы, минимум одно; восстановление после продолжительного отдыха.'),
      feature('lay-on-hands', 'Наложение рук', 'Запас целительных сил равен пяти хитов на уровень паладина; восстанавливается после продолжительного отдыха.'),
    ],
    spellcasting: null,
  },
  ranger: {
    id: 'ranger', label: 'Следопыт', english_name: 'Ranger', hit_die: 10,
    primary_abilities: ['dex', 'wis'], saving_throw_proficiencies: ['str', 'dex'],
    armor_proficiencies: ['light', 'medium', 'shields'], weapon_proficiencies: ['simple', 'martial'],
    tool_proficiencies: [],
    skill_choice: classSkill(3, ['animal_handling', 'athletics', 'insight', 'investigation', 'nature', 'perception', 'stealth', 'survival']),
    subclass_options: [],
    features: [
      feature('favored-enemy', 'Избранный враг', 'Выберите тип врага либо две расы гуманоидов; получите преимущество на проверки отслеживания и изучите язык, если избранные враги вообще говорят на языке.'),
      feature('natural-explorer', 'Исследователь природы', 'Выберите один тип предпочитаемой местности; в нём действуют преимущества исследователя.'),
    ],
    spellcasting: null,
  },
  rogue: {
    id: 'rogue', label: 'Плут', english_name: 'Rogue', hit_die: 8,
    primary_abilities: ['dex'], saving_throw_proficiencies: ['dex', 'int'],
    armor_proficiencies: ['light'], weapon_proficiencies: ['simple', 'hand_crossbow', 'longsword', 'rapier', 'shortsword'],
    tool_proficiencies: ['thieves_tools'],
    skill_choice: classSkill(4, ['acrobatics', 'athletics', 'deception', 'insight', 'intimidation', 'investigation', 'perception', 'performance', 'persuasion', 'sleight_of_hand', 'stealth']),
    subclass_options: [],
    choices: [{ id: 'expertise', count: 2, kind: 'expertise', options: [...ALL_SKILLS, 'thieves_tools'], requires_proficiency: true }],
    features: [
      feature('expertise', 'Мастерство', 'Выберите два владения навыками либо одно владение навыком и воровскими инструментами; бонус мастерства удваивается.'),
      feature('sneak-attack', 'Скрытая атака', 'Один раз за ход добавьте 1к6 урона подходящей атаке при наличии преимущества или союзника рядом с целью.'),
      feature('thieves-cant', 'Воровской жаргон', 'Тайный язык и набор знаков, известный преступному миру.'),
    ],
    spellcasting: null,
  },
  sorcerer: {
    id: 'sorcerer', label: 'Чародей', english_name: 'Sorcerer', hit_die: 6,
    primary_abilities: ['cha'], saving_throw_proficiencies: ['con', 'cha'],
    armor_proficiencies: [], weapon_proficiencies: ['dagger', 'dart', 'sling', 'quarterstaff', 'light_crossbow'],
    tool_proficiencies: [],
    skill_choice: classSkill(2, ['arcana', 'deception', 'insight', 'intimidation', 'persuasion', 'religion']),
    subclass_level: 1, subclass_label: 'Происхождение чародея', subclass_options: [],
    features: [
      feature('spellcasting', 'Использование заклинаний', 'Харизма — ключевая характеристика заклинаний чародея.'),
      feature('sorcerous-origin', 'Происхождение чародея', 'Выберите источник врождённой магии; он даёт особенности на 1 уровне.'),
    ],
    spellcasting: spellcasting('cha', { cantrips_known: 4, spells_known: 2, first_level_spell_slots: 2 }),
  },
  warlock: {
    id: 'warlock', label: 'Колдун', english_name: 'Warlock', hit_die: 8,
    primary_abilities: ['cha'], saving_throw_proficiencies: ['wis', 'cha'],
    armor_proficiencies: ['light'], weapon_proficiencies: ['simple'], tool_proficiencies: [],
    skill_choice: classSkill(2, ['arcana', 'deception', 'history', 'intimidation', 'investigation', 'nature', 'religion']),
    subclass_level: 1, subclass_label: 'Потусторонний покровитель', subclass_options: [],
    features: [
      feature('otherworldly-patron', 'Потусторонний покровитель', 'Выберите покровителя; он даёт особенность на 1 уровне.'),
      feature('pact-magic', 'Магия договора', 'Харизма — ключевая характеристика; одна ячейка заклинаний 1 круга восстанавливается после короткого или продолжительного отдыха.'),
    ],
    spellcasting: spellcasting('cha', { cantrips_known: 2, spells_known: 2, pact_magic_slots: 1, pact_magic_slot_level: 1 }),
  },
  wizard: {
    id: 'wizard', label: 'Волшебник', english_name: 'Wizard', hit_die: 6,
    primary_abilities: ['int'], saving_throw_proficiencies: ['int', 'wis'],
    armor_proficiencies: [], weapon_proficiencies: ['dagger', 'dart', 'sling', 'quarterstaff', 'light_crossbow'],
    tool_proficiencies: [],
    skill_choice: classSkill(2, ['arcana', 'history', 'insight', 'investigation', 'medicine', 'religion']),
    subclass_options: [],
    features: [
      feature('spellcasting', 'Использование заклинаний', 'Интеллект — ключевая характеристика заклинаний волшебника; книга содержит шесть заклинаний 1 круга.'),
      feature('arcane-recovery', 'Магическое восстановление', 'После короткого отдыха восстановите ячейки суммарным уровнем до половины уровня волшебника.'),
    ],
    spellcasting: spellcasting('int', { cantrips_known: 3, spellbook_first_level_spells: 6, prepared_formula: 'intelligence_modifier + wizard_level (minimum 1)', first_level_spell_slots: 2 }),
  },
}

const CLERIC_DOMAINS = [
  {
    id: 'knowledge', label: 'Домен знаний', aliases: ['cleric-domen-znaniy', 'домен знаний'],
    features: [feature('blessings-of-knowledge', 'Благословение знаний', 'Два выбранных языка, два навыка из списка домена и удвоенный бонус мастерства для проверок выбранных навыков.')],
    domain_spells: domainSpells(['identify', 'command']),
    choices: {
      knowledge_skills: { count: 2, options: ['history', 'arcana', 'nature', 'religion'] },
      knowledge_languages: { count: 2, kind: 'language' },
    },
  },
  {
    id: 'life', label: 'Домен жизни', aliases: ['cleric-domen-zhizni', 'домен жизни'],
    features: [feature('bonus-proficiency-heavy-armor', 'Дополнительное владение', 'Вы получаете владение тяжёлыми доспехами.'), feature('disciple-of-life', 'Ученик жизни', 'Заклинания 1 круга и выше, восстанавливающие хиты, восстанавливают дополнительно 2 + круг заклинания.')],
    additional_armor_proficiencies: ['heavy'], domain_spells: domainSpells(['bless', 'cure_wounds']),
  },
  {
    id: 'light', label: 'Домен света', aliases: ['cleric-domen-sveta', 'домен света'],
    features: [feature('bonus-cantrip-light', 'Дополнительный заговор', 'Вы изучаете заговор Свет.'), feature('warding-flare', 'Ослепляющая вспышка', 'Реакцией навяжите атакующему помеху; число использований равно модификатору Мудрости, минимум одно.')],
    domain_spells: domainSpells(['burning_hands', 'faerie_fire']),
  },
  {
    id: 'nature', label: 'Домен природы', aliases: ['cleric-domen-prirody', 'домен природы'],
    features: [feature('acolyte-of-nature', 'Послушник природы', 'Один заговор из списка друида и владение одним навыком: Уход за животными, Природа или Выживание.'), feature('bonus-proficiency-heavy-armor', 'Дополнительное владение', 'Вы получаете владение тяжёлыми доспехами.')],
    additional_armor_proficiencies: ['heavy'], domain_spells: domainSpells(['animal_friendship', 'speak_with_animals']),
    choices: { nature_cantrip: { kind: 'druid_cantrip', count: 1, options: [...DRUID_CANTRIPS] }, nature_skill: { kind: 'skill', count: 1, options: ['animal_handling', 'nature', 'survival'] } },
  },
  {
    id: 'tempest', label: 'Домен бури', aliases: ['cleric-domen-buri', 'домен бури'],
    features: [feature('bonus-proficiencies', 'Дополнительные владения', 'Владение боевым оружием и тяжёлыми доспехами.'), feature('wrath-of-the-storm', 'Гнев бури', 'Реакцией нанесите урон молнией или громом существу, которое вас атакует.')],
    additional_armor_proficiencies: ['heavy'], additional_weapon_proficiencies: ['martial'], domain_spells: domainSpells(['fog_cloud', 'thunderwave']),
  },
  {
    id: 'trickery', label: 'Домен обмана', aliases: ['cleric-domen-obmana', 'домен обмана'],
    features: [feature('blessing-of-the-trickster', 'Благословение обманщика', 'Действием коснитесь существа и дайте ему преимущество на проверки Ловкости (Скрытность) на 1 час.')],
    domain_spells: domainSpells(['charm_person', 'disguise_self']),
  },
  {
    id: 'war', label: 'Домен войны', aliases: ['cleric-domen-voyny', 'домен войны'],
    features: [feature('bonus-proficiencies', 'Дополнительные владения', 'Владение боевым оружием и тяжёлыми доспехами.'), feature('war-priest', 'Военный жрец', 'После действия Атака совершите одну атаку бонусным действием; число использований равно модификатору Мудрости, минимум одно.')],
    additional_armor_proficiencies: ['heavy'], additional_weapon_proficiencies: ['martial'], domain_spells: domainSpells(['divine_favor', 'shield_of_faith']),
  },
]

const SORCERER_ORIGINS = [
  {
    id: 'draconic-bloodline', label: 'Наследие драконьей крови', aliases: ['draconic', 'draconic-origin', 'наследие драконьей крови'],
    features: [feature('dragon-ancestor', 'Драконий предок', 'Выберите цвет дракона; получите соответствующий тип урона и владение Драконьим языком.'), feature('draconic-resilience', 'Драконья стойкость', 'Максимум хитов увеличивается на 1 за каждый уровень чародея; КД без доспехов равен 13 + модификатор Ловкости.')],
    choices: { draconic_ancestry: { kind: 'dragon_ancestry', count: 1, options: Object.keys(DRACONIC_ANCESTRIES) } },
  },
  {
    id: 'wild-magic', label: 'Дикая магия', aliases: ['wild-magic-origin', 'дикая магия'],
    features: [feature('wild-magic-surge', 'Всплеск дикой магии', 'После заклинания 1 круга или выше Мастер может попросить бросок на всплеск дикой магии.'), feature('tides-of-chaos', 'Приливы хаоса', 'Получите преимущество на одну проверку, бросок атаки или спасбросок; восстановление по решению Мастера после всплеска.')],
  },
]

const WARLOCK_PATRONS = [
  {
    id: 'archfey', label: 'Архифея', aliases: ['warlock-archfey', 'архифея'],
    features: [feature('fey-presence', 'Присутствие фей', 'Действием очаруйте или испугайте существ в кубе 10 футов; восстановление после короткого или продолжительного отдыха.')],
    expanded_spell_list: { 1: ['faerie_fire', 'sleep'] },
  },
  {
    id: 'fiend', label: 'Исчадие', aliases: ['warlock-fiend', 'исчадие'],
    features: [feature('dark-ones-blessing', 'Благословение тёмного', 'Когда враждебное существо падает до 0 хитов, получите временные хиты, равные модификатору Харизмы + уровень колдуна, минимум 1.')],
    expanded_spell_list: { 1: ['burning_hands', 'command'] },
  },
  {
    id: 'great-old-one', label: 'Великий Древний', aliases: ['great-old-one', 'warlock-great-old-one', 'великий древний'],
    features: [feature('awakened-mind', 'Пробуждённый разум', 'Телепатически общайтесь с выбранным существом в пределах 30 футов.')],
    expanded_spell_list: { 1: ['dissonant_whispers', 'tashas_hideous_laughter'] },
  },
]

classDefinitions.cleric.subclass_options = CLERIC_DOMAINS
classDefinitions.sorcerer.subclass_options = SORCERER_ORIGINS
classDefinitions.warlock.subclass_options = WARLOCK_PATRONS

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export const PHB_2014_CLASS_OPTIONS = deepFreeze(classDefinitions)

function normalizedToken(value) {
  return String(value ?? '').trim().toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, '_').replace(/^_+|_+$/gu, '')
}

function canonicalFrom(value, values, aliases = []) {
  const token = normalizedToken(value)
  const map = new Map(values.map((entry) => [normalizedToken(entry), entry]))
  for (const [canonical, names] of aliases) for (const name of names) map.set(normalizedToken(name), canonical)
  return map.get(token) ?? null
}

function canonicalClassKey(value) {
  const key = String(value ?? '').trim().toLocaleLowerCase('en')
  return PHB_2014_CLASS_KEYS.includes(key) ? key : null
}

function canonicalSkill(value) {
  return canonicalFrom(value, ALL_SKILLS, ALL_SKILLS.map((id) => [id, [id.replaceAll('_', '-'), id.replaceAll('_', ' ')]]))
}

function canonicalInstrument(value) {
  return canonicalFrom(value, MUSICAL_INSTRUMENTS, MUSICAL_INSTRUMENTS.map((id) => [id, [id.replaceAll('_', '-'), id.replaceAll('_', ' ')]]))
}

function canonicalArtisanTool(value) {
  return canonicalFrom(value, ARTISAN_TOOLS, ARTISAN_TOOLS.map((id) => [id, [id.replaceAll('_', '-'), id.replaceAll('_', ' ')]]))
}

function uniqueValues(input, canonicalizer) {
  if (!Array.isArray(input)) return null
  const values = input.map(canonicalizer)
  return values.every(Boolean) ? values : values
}

function exactSelection(input, { count, options, label, canonicalizer = (value) => value }, errors) {
  if (!Array.isArray(input) || input.length !== count) {
    errors.push(`${label}: нужно выбрать ровно ${count}`)
    return []
  }
  const selected = input.map(canonicalizer)
  if (selected.some((value) => !value || !options.includes(value))) errors.push(`${label}: выбран недопустимый вариант`)
  if (new Set(selected).size !== selected.length) errors.push(`${label}: варианты нельзя повторять`)
  return selected
}

function firstChoice(source, keys) {
  for (const key of keys) if (source[key] !== undefined) return source[key]
  return undefined
}

function stringList(source, keys) {
  const value = firstChoice(source, keys)
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function normalizeLanguage(value) {
  const result = String(value ?? '').trim()
  return result || null
}

function selectedSubclass(definition, rawValue, errors) {
  if (definition.subclass_level !== 1) {
    if (rawValue !== undefined && rawValue !== null && String(rawValue).trim()) errors.push('У этого класса нет выбора подкласса на 1 уровне по PHB 2014')
    return null
  }
  if (rawValue == null || !String(rawValue).trim()) {
    errors.push(`${definition.subclass_label}: нужно выбрать вариант`)
    return null
  }
  const token = normalizedToken(rawValue)
  const option = definition.subclass_options.find((entry) => [entry.id, entry.label, ...(entry.aliases ?? [])].some((value) => normalizedToken(value) === token))
  if (!option) {
    errors.push(`${definition.subclass_label}: выбран вариант вне PHB 2014`)
    return null
  }
  return option
}

function languageFromContext(context) {
  const values = context?.language_options ?? context?.languages
  if (!Array.isArray(values)) return null
  return new Set(values.map((entry) => normalizedToken(typeof entry === 'object' ? entry.id ?? entry.value : entry)).filter(Boolean))
}

function validateRangerChoices(choices, errors, context = {}) {
  const rawEnemy = firstChoice(choices, ['favored_enemy', 'favoredEnemy'])
  const enemy = rawEnemy && typeof rawEnemy === 'object' && !Array.isArray(rawEnemy)
    ? rawEnemy
    : { type: firstChoice(choices, ['favored_enemy_type', 'favoredEnemyType']), races: firstChoice(choices, ['favored_enemy_races', 'favoredEnemyRaces']), language: firstChoice(choices, ['favored_enemy_language', 'favoredEnemyLanguage']) }
  const type = canonicalFrom(enemy.type ?? enemy.enemy_type, FAVORED_ENEMY_TYPES, FAVORED_ENEMY_TYPES.map((id) => [id, [id.replace(/s$/u, '')]]))
  const language = normalizeLanguage(enemy.language)
  if (!type) errors.push('Избранный враг: выберите допустимый тип врага')
  if (type && FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES.includes(type) && !language) {
    errors.push('Избранный враг: для этого типа нужно указать язык, на котором говорят враги')
  }
  const languageOptions = languageFromContext(context)
  if (language && languageOptions && !languageOptions.has(normalizedToken(language))) {
    errors.push('Избранный враг: язык отсутствует в каталоге доступных языков')
  }
  const rawRaces = enemy.races ?? enemy.humanoid_races ?? enemy.humanoidRaces
  const races = Array.isArray(rawRaces) ? rawRaces.map((race) => String(race ?? '').trim()).filter(Boolean) : []
  if (type === 'humanoids') {
    if (races.length !== 2 || new Set(races.map(normalizedToken)).size !== 2) errors.push('Избранный враг: для гуманоидов нужно выбрать две разные расы')
  } else if (races.length) {
    errors.push('Избранный враг: расы можно указывать только для гуманоидов')
  }
  return { type, races, language }
}

function validateMonkToolChoice(choices, errors) {
  const raw = firstChoice(choices, ['tool_or_instrument', 'toolOrInstrument'])
  const artisan = firstChoice(choices, ['artisan_tool', 'artisanTool'])
  const instrument = firstChoice(choices, ['instrument', 'musical_instrument', 'musicalInstrument'])
  const supplied = [raw !== undefined, artisan !== undefined, instrument !== undefined].filter(Boolean).length
  if (supplied !== 1) {
    errors.push('Монах: выберите один ремесленный инструмент или один музыкальный инструмент')
    return null
  }
  if (raw !== undefined) {
    const value = raw && typeof raw === 'object' ? raw : { id: raw }
    const id = value.id ?? value.value
    const kind = normalizedToken(value.kind ?? value.type)
    const artisanId = canonicalArtisanTool(id)
    const instrumentId = canonicalInstrument(id)
    if (kind.includes('artisan') || kind.includes('ремес')) {
      if (!artisanId) errors.push('Монах: выбран недопустимый ремесленный инструмент')
      return artisanId ? { kind: 'artisan_tool', id: artisanId } : null
    }
    if (kind.includes('musical') || kind.includes('instrument') || kind.includes('музык')) {
      if (!instrumentId) errors.push('Монах: выбран недопустимый музыкальный инструмент')
      return instrumentId ? { kind: 'musical_instrument', id: instrumentId } : null
    }
    if (artisanId && !instrumentId) return { kind: 'artisan_tool', id: artisanId }
    if (instrumentId && !artisanId) return { kind: 'musical_instrument', id: instrumentId }
    errors.push('Монах: укажите вид выбранного инструмента')
    return null
  }
  const artisanId = canonicalArtisanTool(artisan)
  const instrumentId = canonicalInstrument(instrument)
  if (artisan !== undefined) {
    if (!artisanId) errors.push('Монах: выбран недопустимый ремесленный инструмент')
    return artisanId ? { kind: 'artisan_tool', id: artisanId } : null
  }
  if (!instrumentId) errors.push('Монах: выбран недопустимый музыкальный инструмент')
  return instrumentId ? { kind: 'musical_instrument', id: instrumentId } : null
}

function contextProficiencies(context, selectedSkills, definition) {
  const explicit = [
    ...(Array.isArray(context?.proficiencies) ? context.proficiencies : []),
    ...(Array.isArray(context?.available_proficiencies) ? context.available_proficiencies : []),
    ...(Array.isArray(context?.skill_proficiencies) ? context.skill_proficiencies : []),
    ...(Array.isArray(context?.tool_proficiencies) ? context.tool_proficiencies : []),
  ]
  const normalized = new Set(selectedSkills)
  for (const value of definition.tool_proficiencies ?? []) normalized.add(value)
  for (const value of explicit) normalized.add(canonicalSkill(value) ?? canonicalArtisanTool(value) ?? canonicalInstrument(value) ?? normalizedToken(value))
  return normalized
}

function validateChoices(classKey, choices, context = {}) {
  const definition = PHB_2014_CLASS_OPTIONS[classKey]
  const errors = []
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return { errors: ['Классовые выборы должны быть объектом'] }

  const selectedSkills = exactSelection(
    firstChoice(choices, ['skills', 'class_skills', 'classSkillProficiencies', 'skill_proficiencies']),
    { count: definition.skill_choice.count, options: definition.skill_choice.options, label: 'Классовые навыки', canonicalizer: canonicalSkill }, errors,
  )
  const normalized = { skills: selectedSkills }

  if (classKey === 'bard') {
    normalized.instruments = exactSelection(stringList(choices, ['instruments', 'musical_instruments', 'musicalInstruments']), { count: 3, options: MUSICAL_INSTRUMENTS, label: 'Музыкальные инструменты', canonicalizer: canonicalInstrument }, errors)
  }

  if (classKey === 'fighter') {
    const styles = ['archery', 'defense', 'dueling', 'great_weapon_fighting', 'protection', 'two_weapon_fighting']
    const raw = firstChoice(choices, ['fighting_style', 'fightingStyle'])
    const value = canonicalFrom(raw, styles, [['defense', ['defence', 'защита']], ['dueling', ['duelist', 'дуэлянт']], ['great_weapon_fighting', ['great weapon', 'сражение большим оружием']], ['two_weapon_fighting', ['two weapon', 'сражение двумя оружиями']], ['archery', ['стрельба']], ['protection', ['оборона']]])
    if (!value) errors.push('Боевой стиль: выберите один из шести вариантов PHB 2014')
    normalized.fighting_style = value
  }

  if (classKey === 'monk') normalized.tool_or_instrument = validateMonkToolChoice(choices, errors)

  if (classKey === 'rogue') {
    const available = contextProficiencies(context, selectedSkills, definition)
    const expertise = exactSelection(stringList(choices, ['expertise', 'expertise_proficiencies', 'expertiseProficiencies']), { count: 2, options: [...ALL_SKILLS, 'thieves_tools'], label: 'Мастерство', canonicalizer: (value) => canonicalSkill(value) ?? (normalizedToken(value) === 'thieves_tools' ? 'thieves_tools' : null) }, errors)
    if (expertise.some((value) => !available.has(value))) errors.push('Мастерство: каждое выбранное владение должно уже принадлежать герою')
    normalized.expertise = expertise
  }

  if (classKey === 'ranger') {
    normalized.favored_enemy = validateRangerChoices(choices, errors, context)
    const terrain = canonicalFrom(firstChoice(choices, ['natural_explorer', 'natural_explorer_terrain', 'naturalExplorer', 'naturalExplorerTerrain']), NATURAL_EXPLORER_TERRAINS, NATURAL_EXPLORER_TERRAINS.map((id) => [id, [id.replace('underdark', 'underdark')]]))
    if (!terrain) errors.push('Исследователь природы: выберите один тип предпочитаемой местности')
    normalized.natural_explorer = terrain
  }

  const subclass = selectedSubclass(definition, firstChoice(choices, ['subclass', 'domain', 'origin', 'patron']), errors)
  normalized.subclass = subclass?.id ?? null

  if (classKey === 'cleric' && subclass) {
    if (subclass.id === 'knowledge') {
      normalized.knowledge_skills = exactSelection(stringList(choices, ['knowledge_skills', 'knowledgeSkills']), { count: 2, options: subclass.choices.knowledge_skills.options, label: 'Домен знаний: навыки', canonicalizer: canonicalSkill }, errors)
      normalized.knowledge_languages = stringList(choices, ['knowledge_languages', 'knowledgeLanguages']).map(normalizeLanguage).filter(Boolean)
      if (normalized.knowledge_languages.length !== 2) errors.push('Домен знаний: нужно выбрать два языка')
      if (new Set(normalized.knowledge_languages.map(normalizedToken)).size !== normalized.knowledge_languages.length) errors.push('Домен знаний: языки нельзя повторять')
    }
    if (subclass.id === 'nature') {
      const cantrip = canonicalFrom(firstChoice(choices, ['nature_cantrip', 'druid_cantrip', 'natureCantrip', 'druidCantrip']), DRUID_CANTRIPS, DRUID_CANTRIPS.map((id) => [id, [id.replaceAll('_', '-'), id.replaceAll('_', ' ')]]))
      const skill = canonicalFrom(firstChoice(choices, ['nature_skill', 'natureSkill']), ['animal_handling', 'nature', 'survival'], [['animal_handling', ['animal handling', 'уход за животными']]])
      if (!cantrip) errors.push('Домен природы: выберите один заговор друида PHB 2014')
      if (!skill) errors.push('Домен природы: выберите один навык из трёх вариантов')
      normalized.nature_cantrip = cantrip
      normalized.nature_skill = skill
    }
  }

  if (classKey === 'sorcerer' && subclass?.id === 'draconic-bloodline') {
    const ancestry = canonicalFrom(firstChoice(choices, ['draconic_ancestry', 'ancestry', 'draconicAncestry']), Object.keys(DRACONIC_ANCESTRIES), Object.entries(DRACONIC_ANCESTRIES).map(([id, value]) => [id, [value.label]]))
    if (!ancestry) errors.push('Драконий предок: выберите один цвет дракона PHB 2014')
    normalized.draconic_ancestry = ancestry
  }

  return { errors, choices: normalized, subclass }
}

function buildBenefits(classKey, choices, subclass) {
  const definition = PHB_2014_CLASS_OPTIONS[classKey]
  const armor = [...new Set([...(definition.armor_proficiencies ?? []), ...(subclass?.additional_armor_proficiencies ?? [])])]
  const weapons = [...new Set([...(definition.weapon_proficiencies ?? []), ...(subclass?.additional_weapon_proficiencies ?? [])])]
  const tools = [...new Set([...(definition.tool_proficiencies ?? []), ...(choices.instruments ?? []), ...(choices.tool_or_instrument?.id ? [choices.tool_or_instrument.id] : [])])]
  const skills = [...new Set([...(choices.skills ?? []), ...(choices.knowledge_skills ?? []), ...(choices.nature_skill ? [choices.nature_skill] : [])])]
  const selectedSubclass = subclass ? {
    id: subclass.id, label: subclass.label, features: structuredClone(subclass.features ?? []),
    domain_spells: structuredClone(subclass.domain_spells ?? null),
    expanded_spell_list: structuredClone(subclass.expanded_spell_list ?? null),
  } : null
  const benefits = {
    class_key: classKey,
    level: 1,
    hit_die: definition.hit_die,
    primary_abilities: [...definition.primary_abilities],
    saving_throw_proficiencies: [...definition.saving_throw_proficiencies],
    armor_proficiencies: armor,
    armor_restrictions: [...(definition.armor_restrictions ?? [])],
    weapon_proficiencies: weapons,
    tool_proficiencies: tools,
    skill_proficiencies: skills,
    expertise: [...(choices.expertise ?? (choices.knowledge_skills && subclass?.id === 'knowledge' ? choices.knowledge_skills : []))],
    features: [...structuredClone(definition.features), ...(subclass?.features ? structuredClone(subclass.features) : [])],
    spellcasting: structuredClone(definition.spellcasting),
    subclass: selectedSubclass,
    choices: structuredClone(choices),
    source_url: DND_SU_CLASS_SOURCES[classKey],
  }
  if (choices.tool_or_instrument) benefits.tool_choice = structuredClone(choices.tool_or_instrument)
  if (choices.fighting_style) benefits.fighting_style = choices.fighting_style
  if (choices.expertise) benefits.expertise = [...choices.expertise]
  if (choices.favored_enemy) {
    benefits.favored_enemy = structuredClone(choices.favored_enemy)
    benefits.languages = choices.favored_enemy.language ? [choices.favored_enemy.language] : []
  }
  if (choices.natural_explorer) benefits.natural_explorer = choices.natural_explorer
  if (choices.knowledge_languages) benefits.languages = [...choices.knowledge_languages]
  if (choices.nature_cantrip) benefits.extra_druid_cantrip = choices.nature_cantrip
  if (choices.draconic_ancestry) {
    const ancestry = DRACONIC_ANCESTRIES[choices.draconic_ancestry]
    benefits.draconic_ancestry = { id: choices.draconic_ancestry, ...structuredClone(ancestry) }
    benefits.languages = ['draconic']
    benefits.max_hit_points_bonus = 1
    benefits.max_hit_points_bonus_per_class_level = 1
    benefits.unarmored_armor_class = { base: 13, dexterity_modifier: true }
  }
  if (subclass?.domain_spells) {
    benefits.domain_spells = structuredClone(subclass.domain_spells)
    benefits.domain_spell_ids = [...(subclass.domain_spells[1] ?? [])]
    benefits.domain_spells_always_prepared = true
    benefits.domain_spells_count_against_prepared_limit = false
  }
  if (subclass?.expanded_spell_list) benefits.expanded_spell_list = structuredClone(subclass.expanded_spell_list)
  return benefits
}

export function classOptionFor(classKey) {
  const key = canonicalClassKey(classKey)
  return key ? structuredClone(PHB_2014_CLASS_OPTIONS[key]) : null
}

/** Полный каталог только двенадцати базовых классов PHB 2014. */
export function classOptionsCatalog() {
  return PHB_2014_CLASS_KEYS.map((key) => classOptionFor(key))
}

export function classCreationOptionsCatalog() {
  return {
    ruleset_id: CLASS_OPTIONS_PROVENANCE.ruleset_id,
    edition_family: CLASS_OPTIONS_PROVENANCE.edition_family,
    source_book: CLASS_OPTIONS_PROVENANCE.source_book,
    classes: classOptionsCatalog(),
  }
}

/**
 * Проверяет выборы игрока. `context.proficiencies` используется для Rogue:
 * expertise допускается только для уже полученного навыка или инструмента.
 */
export function validateClassChoices(classKey, choices = {}, context = {}) {
  const key = canonicalClassKey(classKey)
  if (!key) return { ok: false, code: 'CLASS_UNSUPPORTED', errors: ['Неизвестный класс PHB 2014'] }
  const result = validateChoices(key, choices, context)
  if (result.errors.length) return { ok: false, code: 'CLASS_CHOICES_INVALID', class_key: key, errors: result.errors, error: result.errors[0] }
  const benefits = buildBenefits(key, result.choices, result.subclass)
  return { ok: true, class_key: key, choices: result.choices, benefits }
}

/** Возвращает проверенные преимущества класса и краткую копию результата валидации. */
export function classBenefitsFor(classKey, choices = {}, context = {}) {
  const result = validateClassChoices(classKey, choices, context)
  return result.ok ? { ...result, ...structuredClone(result.benefits) } : result
}
