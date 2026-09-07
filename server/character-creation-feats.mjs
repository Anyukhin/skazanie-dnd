/**
 * PHB 2014 feats used while creating a character.
 *
 * This is deliberately a leaf module.  It owns the catalogue, choice
 * validation, and the derived benefits that are safe to put on a character
 * sheet.  Combat handlers may consume `benefits.static`, but are not imported
 * here.  The catalogue contains the PHB 2014 feat list only; later books and
 * the 2024 origin-feat rules do not belong in this module.
 */

export const PHB_2014_FEATS_SOURCE = Object.freeze({
  edition: 'D&D 5e 2014',
  book: "Player's Handbook",
  source: 'PHB2014',
  source_url: 'https://5e14.dnd.su/feats/',
  official_rules_url: 'https://www.dndbeyond.com/sources/dnd/basic-rules-2014/customization-options',
})

export const ABILITY_IDS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])

const SPELLCASTING_CLASSES = Object.freeze(['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard'])
const SPELLCASTING_ABILITY = Object.freeze({
  bard: 'cha', cleric: 'wis', druid: 'wis', sorcerer: 'cha', warlock: 'cha', wizard: 'int',
})
const ELEMENTAL_DAMAGE_TYPES = Object.freeze(['acid', 'cold', 'fire', 'lightning', 'thunder'])

const SKILLS = Object.freeze([
  'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history',
  'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception',
  'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival',
])

// PHB tool proficiencies.  Both the project's ids and the common SRD spelling
// are accepted at the boundary; the result keeps one stable snake_case id.
const TOOLS = Object.freeze([
  'alchemists_supplies', 'brewers_supplies', 'calligraphers_supplies', 'carpenters_tools',
  'cartographers_tools', 'cobblers_tools', 'cooks_utensils', 'glassblowers_tools',
  'jewelers_tools', 'leatherworkers_tools', 'masons_tools', 'painters_supplies',
  'potters_tools', 'smiths_tools', 'tinkers_tools', 'weavers_tools', 'woodcarvers_tools',
  'disguise_kit', 'forgery_kit', 'herbalism_kit', 'navigators_tools', 'poisoners_kit',
  'thieves_tools', 'dice_set', 'dragonchess_set', 'playing_card_set', 'playing_cards', 'three_dragon_ante_set',
  'bagpipes', 'drum', 'dulcimer', 'flute', 'lute', 'lyre', 'horn', 'pan_flute', 'shawm', 'viol',
  'land_vehicles', 'water_vehicles', 'vehicles_land', 'vehicles_water',
])

const LANGUAGES = Object.freeze([
  'common', 'dwarvish', 'elvish', 'giant', 'gnomish', 'goblin', 'halfling', 'orc',
  'abyssal', 'celestial', 'draconic', 'deep_speech', 'infernal', 'primordial',
  'sylvan', 'undercommon',
])

const WEAPONS = Object.freeze([
  'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'light_hammer', 'mace', 'quarterstaff',
  'sickle', 'spear', 'light_crossbow', 'dart', 'shortbow', 'sling',
  'battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd', 'lance', 'longsword',
  'maul', 'morningstar', 'pike', 'rapier', 'scimitar', 'shortsword', 'trident', 'war_pick',
  'warhammer', 'whip', 'hand_crossbow', 'heavy_crossbow', 'longbow', 'net', 'blowgun',
])

export const PHB_CANTRIPS = Object.freeze({
  bard: Object.freeze(['blade-ward', 'dancing-lights', 'friends', 'light', 'mage-hand', 'mending', 'message', 'minor-illusion', 'prestidigitation', 'true-strike', 'vicious-mockery']),
  cleric: Object.freeze(['guidance', 'light', 'mending', 'resistance', 'sacred-flame', 'spare-the-dying', 'thaumaturgy']),
  druid: Object.freeze(['druidcraft', 'guidance', 'mending', 'poison-spray', 'produce-flame', 'resistance', 'shillelagh', 'thorn-whip']),
  sorcerer: Object.freeze(['acid-splash', 'blade-ward', 'chill-touch', 'dancing-lights', 'fire-bolt', 'friends', 'light', 'mage-hand', 'mending', 'message', 'minor-illusion', 'poison-spray', 'prestidigitation', 'ray-of-frost', 'shocking-grasp', 'true-strike']),
  warlock: Object.freeze(['blade-ward', 'chill-touch', 'eldritch-blast', 'friends', 'mage-hand', 'minor-illusion', 'poison-spray', 'prestidigitation', 'true-strike']),
  wizard: Object.freeze(['acid-splash', 'blade-ward', 'chill-touch', 'dancing-lights', 'fire-bolt', 'friends', 'light', 'mage-hand', 'mending', 'message', 'minor-illusion', 'poison-spray', 'prestidigitation', 'ray-of-frost', 'shocking-grasp', 'true-strike']),
})

export const PHB_FIRST_LEVEL_SPELLS = Object.freeze({
  bard: Object.freeze([
    'animal-friendship', 'bane', 'charm-person', 'comprehend-languages', 'cure-wounds', 'detect-magic',
    'disguise-self', 'dissonant-whispers', 'faerie-fire', 'feather-fall', 'healing-word', 'heroism',
    'tasha-s-hideous-laughter', 'identify', 'illusory-script', 'longstrider', 'silent-image', 'sleep',
    'speak-with-animals', 'thunderwave', 'unseen-servant',
  ]),
  cleric: Object.freeze([
    'bane', 'bless', 'command', 'create-or-destroy-water', 'cure-wounds', 'detect-evil-and-good',
    'detect-magic', 'detect-poison-and-disease', 'guiding-bolt', 'healing-word', 'inflict-wounds',
    'protection-from-evil-and-good', 'purify-food-and-drink', 'sanctuary', 'shield-of-faith',
  ]),
  druid: Object.freeze([
    'animal-friendship', 'charm-person', 'create-or-destroy-water', 'cure-wounds', 'detect-magic', 'detect-poison-and-disease',
    'entangle', 'faerie-fire', 'fog-cloud', 'goodberry', 'healing-word', 'jump', 'longstrider',
    'purify-food-and-drink', 'speak-with-animals', 'thunderwave',
  ]),
  sorcerer: Object.freeze([
    'burning-hands', 'charm-person', 'chromatic-orb', 'color-spray', 'comprehend-languages', 'detect-magic',
    'disguise-self', 'expeditious-retreat', 'false-life', 'feather-fall', 'fog-cloud', 'jump', 'mage-armor', 'magic-missile',
    'ray-of-sickness', 'shield', 'silent-image', 'sleep', 'thunderwave', 'witch-bolt',
  ]),
  warlock: Object.freeze([
    'armor-of-agathys', 'arms-of-hadar', 'charm-person', 'comprehend-languages', 'expeditious-retreat',
    'hellish-rebuke', 'hex', 'illusory-script', 'protection-from-evil-and-good', 'unseen-servant', 'witch-bolt',
  ]),
  wizard: Object.freeze([
    'alarm', 'burning-hands', 'charm-person', 'chromatic-orb', 'comprehend-languages', 'detect-magic',
    'color-spray', 'disguise-self', 'expeditious-retreat', 'false-life', 'feather-fall', 'find-familiar', 'fog-cloud',
    'grease', 'identify', 'illusory-script', 'jump', 'longstrider', 'mage-armor', 'magic-missile', 'protection-from-evil-and-good',
    'ray-of-sickness', 'shield', 'silent-image', 'sleep', 'tasha-s-hideous-laughter', 'tenser-s-floating-disk',
    'thunderwave', 'unseen-servant',
  ]),
})

/**
 * Общая для клиента и сервера проверка доступности классового заклинания.
 * Для героев PHB заговоры и первый круг ограничены списками редакции 2014;
 * расширенные списки и заклинания более высоких кругов остаются доступны.
 */
export function isClassSpellAvailable(spell, classKey, actor = null) {
  const id = String(spell?.id ?? '')
  const classes = Array.isArray(spell?.classes) ? spell.classes : []
  if (!actor?.creationBenefits) return classes.includes(classKey)
  const expanded = Array.isArray(actor.creationBenefits.expanded_spells) ? actor.creationBenefits.expanded_spells : []
  if (expanded.includes(id)) return true
  if (Number(spell?.level) === 0) return PHB_CANTRIPS[classKey]?.includes(id) === true
  if (Number(spell?.level) === 1) return PHB_FIRST_LEVEL_SPELLS[classKey]?.includes(id) === true
  return classes.includes(classKey)
}

export const PHB_RITUALS = Object.freeze({
  bard: Object.freeze(['comprehend-languages', 'detect-magic', 'identify', 'illusory-script', 'speak-with-animals', 'unseen-servant']),
  cleric: Object.freeze(['detect-magic', 'detect-poison-and-disease', 'purify-food-and-drink']),
  druid: Object.freeze(['detect-magic', 'detect-poison-and-disease', 'purify-food-and-drink', 'speak-with-animals']),
  sorcerer: Object.freeze(['comprehend-languages', 'detect-magic']),
  warlock: Object.freeze(['comprehend-languages', 'detect-magic', 'illusory-script', 'unseen-servant']),
  wizard: Object.freeze(['alarm', 'comprehend-languages', 'detect-magic', 'find-familiar', 'identify', 'illusory-script', 'tenser-s-floating-disk', 'unseen-servant']),
})

const RITUALS = PHB_RITUALS
const SPELL_SNIPER_CANTRIPS = Object.freeze({
  bard: Object.freeze([]),
  cleric: Object.freeze([]),
  druid: Object.freeze(['produce-flame', 'thorn-whip']),
  sorcerer: Object.freeze(['chill-touch', 'fire-bolt', 'ray-of-frost', 'shocking-grasp']),
  warlock: Object.freeze(['chill-touch', 'eldritch-blast']),
  wizard: Object.freeze(['chill-touch', 'fire-bolt', 'ray-of-frost', 'shocking-grasp']),
})

const SPELL_ID_ALIASES = Object.freeze({
  "tasha's-hideous-laughter": 'tasha-s-hideous-laughter',
  'tashas-hideous-laughter': 'tasha-s-hideous-laughter',
  'tenser’s-floating-disk': 'tenser-s-floating-disk',
  'tenser\'s-floating-disk': 'tenser-s-floating-disk',
})

const TOKEN_ALIASES = Object.freeze({
  'animal-handling': 'animal_handling', 'sleight-of-hand': 'sleight_of_hand',
  'alchemist-s-supplies': 'alchemists_supplies', 'alchemist’s-supplies': 'alchemists_supplies',
  'brewer-s-supplies': 'brewers_supplies', 'brewer’s-supplies': 'brewers_supplies',
  'calligrapher-s-supplies': 'calligraphers_supplies', 'calligrapher’s-supplies': 'calligraphers_supplies',
  'carpenter-s-tools': 'carpenters_tools', 'carpenter’s-tools': 'carpenters_tools',
  'cartographer-s-tools': 'cartographers_tools', 'cartographer’s-tools': 'cartographers_tools',
  'cobbler-s-tools': 'cobblers_tools', 'cobbler’s-tools': 'cobblers_tools',
  'cook-s-utensils': 'cooks_utensils', 'cook’s-utensils': 'cooks_utensils',
  'glassblower-s-tools': 'glassblowers_tools', 'glassblower’s-tools': 'glassblowers_tools',
  'jeweler-s-tools': 'jewelers_tools', 'jeweler’s-tools': 'jewelers_tools',
  'leatherworker-s-tools': 'leatherworkers_tools', 'leatherworker’s-tools': 'leatherworkers_tools',
  'mason-s-tools': 'masons_tools', 'mason’s-tools': 'masons_tools',
  'painter-s-supplies': 'painters_supplies', 'painter’s-supplies': 'painters_supplies',
  'potter-s-tools': 'potters_tools', 'potter’s-tools': 'potters_tools',
  'smith-s-tools': 'smiths_tools', 'smith’s-tools': 'smiths_tools',
  'tinker-s-tools': 'tinkers_tools', 'tinker’s-tools': 'tinkers_tools',
  'weaver-s-tools': 'weavers_tools', 'weaver’s-tools': 'weavers_tools',
  'woodcarver-s-tools': 'woodcarvers_tools', 'woodcarver’s-tools': 'woodcarvers_tools',
  'disguise-kit': 'disguise_kit', 'forgery-kit': 'forgery_kit', 'herbalism-kit': 'herbalism_kit',
  'navigators-tools': 'navigators_tools', 'poisoners-kit': 'poisoners_kit', 'thieves-tools': 'thieves_tools',
  'land-vehicles': 'land_vehicles', 'water-vehicles': 'water_vehicles',
  'playing-cards': 'playing_card_set',
  'hand-crossbow': 'hand_crossbow', 'light-crossbow': 'light_crossbow', 'heavy-crossbow': 'heavy_crossbow',
  'great-club': 'greatclub', 'light-hammer': 'light_hammer', 'quarter-staff': 'quarterstaff',
  'short-bow': 'shortbow', 'battle-axe': 'battleaxe', 'great-axe': 'greataxe', 'great-sword': 'greatsword',
  'long-sword': 'longsword', 'morning-star': 'morningstar', 'war-pick': 'war_pick', 'war-hammer': 'warhammer',
  'deep-speech': 'deep_speech',
})

export const PHB_MARTIAL_ADEPT_MANEUVER_IDS = Object.freeze([
  'commander-s-strike', 'disarming-attack', 'distracting-strike', 'evasive-footwork',
  'feinting-attack', 'goading-attack', 'lunging-attack', 'maneuvering-attack',
  'menacing-attack', 'parry', 'precision-attack', 'pushing-attack', 'rally',
  'riposte', 'sweeping-attack', 'trip-attack',
])

const clone = (value) => structuredClone(value)
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const token = (value) => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en').replace(/[\s]+/gu, '-').replace(/_/gu, '-').replace(/—/gu, '-')
const canonicalToken = (value) => {
  const raw = token(value)
  return TOKEN_ALIASES[raw] ?? raw.replace(/-/gu, '_')
}
const canonicalSpellId = (value) => SPELL_ID_ALIASES[token(value)] ?? token(value)
const exactArray = (value, count, label) => {
  if (!Array.isArray(value) || value.length !== count) return { ok: false, code: 'CHOICE_COUNT_INVALID', reason: `${label}: нужно выбрать ${count}` }
  const result = value.map(canonicalToken)
  if (result.some((entry) => !entry)) return { ok: false, code: 'CHOICE_INVALID', reason: `${label}: выбор не может быть пустым` }
  if (new Set(result).size !== result.length) return { ok: false, code: 'CHOICE_DUPLICATE', reason: `${label}: варианты не должны повторяться` }
  return { ok: true, value: result }
}

const spellArray = (value, count, label) => {
  if (!Array.isArray(value) || value.length !== count) return { ok: false, code: 'CHOICE_COUNT_INVALID', reason: `${label}: нужно выбрать ${count}` }
  const result = value.map(canonicalSpellId)
  if (result.some((entry) => !entry)) return { ok: false, code: 'CHOICE_INVALID', reason: `${label}: выбор не может быть пустым` }
  if (new Set(result).size !== result.length) return { ok: false, code: 'CHOICE_DUPLICATE', reason: `${label}: варианты не должны повторяться` }
  return { ok: true, value: result }
}

const maneuverArray = (value, count, label) => {
  if (!Array.isArray(value) || value.length !== count) return { ok: false, code: 'CHOICE_COUNT_INVALID', reason: `${label}: нужно выбрать ${count}` }
  const result = value.map((entry) => String(entry ?? '').normalize('NFKC').trim().toLocaleLowerCase('en').replace(/[\s_]+/gu, '-'))
  if (result.some((entry) => !entry)) return { ok: false, code: 'CHOICE_INVALID', reason: `${label}: выбор не может быть пустым` }
  if (new Set(result).size !== result.length) return { ok: false, code: 'CHOICE_DUPLICATE', reason: `${label}: варианты не должны повторяться` }
  return { ok: true, value: result }
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key)
const choiceValue = (choices, names) => names.find((name) => hasOwn(choices, name)) === undefined
  ? undefined
  : choices[names.find((name) => hasOwn(choices, name))]

const PREREQUISITES = Object.freeze({
  'defensive-duelist': [{ kind: 'ability', ability: 'dex', minimum: 13, label: 'Ловкость 13 или выше' }],
  'elemental-adept': [{ kind: 'spellcasting', label: 'Умение накладывать хотя бы одно заклинание' }],
  grappler: [{ kind: 'ability', ability: 'str', minimum: 13, label: 'Сила 13 или выше' }],
  'heavily-armored': [{ kind: 'proficiency', category: 'armor', value: 'medium', label: 'Владение средними доспехами' }],
  'heavy-armor-master': [{ kind: 'proficiency', category: 'armor', value: 'heavy', label: 'Владение тяжёлыми доспехами' }],
  'inspiring-leader': [{ kind: 'ability', ability: 'cha', minimum: 13, label: 'Харизма 13 или выше' }],
  'medium-armor-master': [{ kind: 'proficiency', category: 'armor', value: 'medium', label: 'Владение средними доспехами' }],
  'moderately-armored': [{ kind: 'proficiency', category: 'armor', value: 'light', label: 'Владение лёгкими доспехами' }],
  'ritual-caster': [{ kind: 'ability_any', abilities: ['int', 'wis'], minimum: 13, label: 'Интеллект или Мудрость 13 или выше' }],
  skulker: [{ kind: 'ability', ability: 'dex', minimum: 13, label: 'Ловкость 13 или выше' }],
  'spell-sniper': [{ kind: 'spellcasting', label: 'Умение накладывать хотя бы одно заклинание' }],
  'war-caster': [{ kind: 'spellcasting', label: 'Умение накладывать хотя бы одно заклинание' }],
})

const ABILITY_CHOICES = Object.freeze({
  athlete: ['str', 'dex'], 'lightly-armored': ['str', 'dex'],
  'moderately-armored': ['str', 'dex'], 'observant': ['int', 'wis'], 'resilient': [...ABILITY_IDS],
  'tavern-brawler': ['str', 'con'],
})

const STATIC = Object.freeze({
  actor: { advantage_on_deception_performance_disguise: true, mimic_speech_and_sounds: true, mimic_listen_minutes: 1 },
  alert: { cannot_be_surprised_while_conscious: true, unseen_attackers_do_not_gain_advantage: true },
  athlete: { stand_from_prone_cost_feet: 5, climbing_uses_no_extra_movement: true, running_jump_start_feet: 5 },
  charger: { charge_distance_feet: 10, charge_bonus_action: true, charge_attack_damage_bonus: 5, charge_shove: true },
  'crossbow-expert': { ignore_loading_property: true, ranged_attacks_in_melee_no_disadvantage: true, bonus_action_hand_crossbow_after_one_handed_attack: true },
  'defensive-duelist': { reaction_ac_bonus: 'proficiency_bonus', trigger: 'melee_attack_hit', weapon_property: 'finesse' },
  'dual-wielder': { one_handed_non_light_two_weapon_fighting: true, draw_or_stow_two_one_handed_weapons: true, armor_class_bonus_condition: 'wielding_separate_one_handed_melee_weapons' },
  'dungeon-delver': { advantage_detect_secret_doors: true, advantage_trap_saves: true, advantage_trap_disarm_checks: true, trap_damage_resistance: true, search_normal_travel_pace: true },
  durable: { hit_die_recovery_minimum: 'max(2, constitution_modifier * 2)' },
  'elemental-adept': { ignore_resistance_to_selected_damage: true, damage_die_one_becomes_two: true, can_take_again_with_different_damage_type: true },
  grappler: { advantage_attacks_against_grappled: true, pin_action_restrains_both: true },
  'great-weapon-master': { heavy_melee_attack_penalty: -5, heavy_melee_damage_bonus: 10, bonus_action_attack_on_crit_or_zero: true },
  healer: { healer_kit_stabilize_hp: 1, healer_kit_action_healing: '1d6 + 4 + target_hit_dice', healer_kit_once_per_rest_per_target: true },
  'heavy-armor-master': { nonmagical_bls_damage_reduction: 3 },
  'inspiring-leader': { inspiring_time_minutes: 10, temporary_hp: 'character_level + charisma_modifier', temporary_hp_targets_max: 6, temporary_hp_recovery: 'short_or_long_rest' },
  'keen-mind': { know_north: true, know_time_to_sunset: true, recall_past_days: 30 },
  lucky: { luck_points: 3, luck_points_recovery: 'long_rest' },
  'mage-slayer': { reaction_attack_spell_cast_within_feet: 5, advantage_saves_against_nearby_spellcasters: true, concentration_save_disadvantage_on_damage: true },
  'martial-adept': { superiority_dice: 1, superiority_die: 'd6', superiority_die_recovery: 'short_or_long_rest', maneuver_save_ability: 'str_or_dex' },
  'medium-armor-master': { medium_armor_max_dex_bonus: 3, medium_armor_stealth_disadvantage: false },
  'mounted-combatant': { advantage_melee_attacks_smaller_unmounted: true, redirect_attack_from_mount: true, mount_dex_save_reaction: true },
  observant: { read_lips_if_language_known: true },
  'polearm-master': { bonus_action_butt_attack: true, butt_attack_damage: '1d4 bludgeoning', opportunity_attack_on_reach_entry: true, reach_weapons: ['glaive', 'halberd', 'quarterstaff', 'spear'] },
  'savage-attacker': { reroll_melee_weapon_damage_once_per_turn: true },
  sentinel: { opportunity_attack_sets_speed_zero: true, disengage_does_not_avoid_opportunity: true, reaction_attack_when_adjacent_target_attacked: true },
  'shield-master': { bonus_action_shove_after_attack: true, add_shield_bonus_to_single_target_dex_save: true, reaction_no_damage_on_successful_single_target_dex_save: true },
  sharpshooter: { long_range_no_disadvantage: true, ignore_half_and_three_quarters_cover: true, ranged_attack_penalty: -5, ranged_damage_bonus: 10 },
  skulker: { dim_light_no_disadvantage: true, missed_ranged_attack_reveals_no_position: true, hide_when_lightly_obscured: true },
  'spell-sniper': { double_range_attack_roll_spell: true, ignore_half_and_three_quarters_cover_spell: true },
  'tavern-brawler': { improvised_weapon_proficiency: true, unarmed_strike_damage: '1d4', grapple_bonus_action_after_unarmed_hit: true },
  tough: { hit_point_maximum_bonus_per_level: 2 },
  'war-caster': { concentration_save_advantage: true, somatic_components_with_hands_full: true, opportunity_spell_instead_of_attack: true },
  'weapon-master': { weapon_choices: 4 },
})

// Полное описание правил PHB 2014 для карточки черты.  Это текст правил,
// а не отчёт о том, какие из эффектов уже подключены к боевому обработчику.
const FEAT_DESCRIPTIONS = Object.freeze({
  actor: [
    'Увеличьте Харизму на 1, максимум до 20.',
    'Вы совершаете с преимуществом проверки Харизмы (Обман) и Харизмы (Выступление), когда пытаетесь выдать себя за другого человека.',
    'Вы можете копировать речь другого человека или звуки других существ. Для этого нужно не менее минуты слышать речь человека или звук существа. Слушатель распознаёт подделку успешной проверкой Мудрости (Проницательность), противопоставленной вашей проверке Харизмы (Обман).',
  ],
  athlete: [
    'Увеличьте Силу или Ловкость на 1, максимум до 20.',
    'Когда вы лежите, вставание требует только 5 футов перемещения. Подъём по вертикальной поверхности не тратит дополнительное перемещение.',
    'Для прыжка в длину или высоту с разбега вам достаточно переместиться на 5 футов вместо обычных 10.',
  ],
  alert: [
    'Вы получаете бонус +5 к инициативе.',
    'Пока вы в сознании, вас нельзя застать врасплох.',
    'Невидимые для вас атакующие не получают преимущество на броски атаки только из-за того, что вы их не видите.',
  ],
  'war-caster': [
    'Вы совершаете с преимуществом спасброски Телосложения, которые делаете для сохранения концентрации на заклинании после получения урона.',
    'Вы можете выполнять соматические компоненты заклинаний даже тогда, когда держите оружие или щит в одной или обеих руках.',
    'Когда перемещение враждебного существа провоцирует от вас провоцированную атаку, вы можете реакцией вместо неё наложить на это существо заклинание. У заклинания должно быть время накладывания 1 действие, и оно должно иметь целью только это существо.',
  ],
  grappler: [
    'Вы совершаете с преимуществом броски атаки по существу, схваченному вами.',
    'Вы можете действием попытаться прижать схваченное вами существо. Совершите ещё одну проверку захвата; при успехе вы и существо получаете состояние «опутан» до окончания захвата.',
  ],
  lucky: [
    'Вы получаете 3 очка удачи. После окончания продолжительного отдыха вы восстанавливаете все потраченные очки.',
    'Когда вы совершаете бросок атаки, проверку характеристики или спасбросок, вы можете потратить очко удачи и бросить дополнительный d20. Выберите, какой из бросков использовать для определения результата; потратить очко можно после броска, но до объявления результата.',
    'Когда по вам совершают бросок атаки, вы можете потратить очко удачи, бросить d20 и выбрать, использовать ли бросок атакующего или ваш. Если несколько существ тратят очки удачи на один бросок, очки отменяют друг друга и дополнительные кости не бросаются.',
  ],
  'mounted-combatant': [
    'Пока вы верхом и не недееспособны, вы совершаете с преимуществом атаки в ближнем бою по любому существу без верхового животного, которое меньше вашего верхового животного.',
    'Вы можете заставить атаку, нацеленную на ваше верховое животное, нацелиться вместо него на вас.',
    'Если ваше верховое животное подвергается эффекту, позволяющему совершить спасбросок Ловкости для получения половины урона, оно не получает урона при успехе и получает только половину урона при провале.',
  ],
  observant: [
    'Увеличьте Интеллект или Мудрость на 1, максимум до 20.',
    'Увеличьте пассивную Мудрость (Восприятие) и пассивный Интеллект (Расследование) на 5.',
    'Если вы видите рот говорящего существа и понимаете язык, на котором оно говорит, вы можете читать по его губам.',
  ],
  'martial-adept': [
    'Вы изучаете два приёма из списка архетипа Воинский мастер класса воина. Если приём требует спасброска, СЛ равна 8 + ваш бонус мастерства + ваш модификатор Силы или Ловкости (на ваш выбор).',
    'Вы получаете одну кость превосходства d6 для усиления приёмов. Вы тратите её при использовании приёма и восстанавливаете после короткого или продолжительного отдыха. Если у вас уже есть кости превосходства, эта кость добавляется к ним.',
  ],
  'inspiring-leader': [
    'Потратьте 10 минут, чтобы воодушевить спутников. Выберите до шести дружественных существ, включая себя, в пределах 30 футов, которые могут видеть или слышать вас и понимать вас. Каждое выбранное существо получает временные хиты в количестве, равном вашему уровню + вашему модификатору Харизмы.',
    'Существо не может снова получить временные хиты от этой черты, пока не закончит короткий или продолжительный отдых.',
  ],
  'savage-attacker': [
    'Один раз в ход, когда вы бросаете урон для атаки оружием ближнего боя, вы можете перебросить кости урона оружия и использовать любую из двух сумм.',
  ],
  'tavern-brawler': [
    'Увеличьте Силу или Телосложение на 1, максимум до 20.',
    'Вы получаете владение импровизированным оружием, а урон вашей безоружной атаки становится 1d4.',
    'Когда вы попадаете по существу безоружной атакой или импровизированным оружием в свой ход, вы можете бонусным действием попытаться схватить это существо.',
  ],
  'lightly-armored': [
    'Увеличьте Силу или Ловкость на 1, максимум до 20.',
    'Вы получаете владение лёгкими доспехами.',
  ],
  'moderately-armored': [
    'Увеличьте Силу или Ловкость на 1, максимум до 20.',
    'Вы получаете владение средними доспехами и щитами.',
  ],
  'heavily-armored': [
    'Увеличьте Силу на 1, максимум до 20.',
    'Вы получаете владение тяжёлыми доспехами.',
  ],
  'dual-wielder': [
    'Вы получаете бонус +1 к КД, пока держите отдельное одноручное оружие ближнего боя в каждой руке.',
    'Вы можете сражаться двумя оружиями, даже если одноручное оружие ближнего боя в одной или обеих руках не имеет свойства «лёгкое».',
    'Вы можете вытащить или убрать два одноручных оружия одновременно, когда обычно могли бы вытащить или убрать только одно.',
  ],
  'dungeon-delver': [
    'Вы совершаете с преимуществом проверки Мудрости (Восприятие) и Интеллекта (Расследование), чтобы обнаружить тайные двери.',
    'Вы совершаете с преимуществом спасброски, чтобы избежать ловушек или сопротивляться им, и получаете сопротивление урону от ловушек.',
    'Вы можете искать ловушки во время путешествия обычным темпом, а не только медленным.',
  ],
  durable: [
    'Увеличьте Телосложение на 1, максимум до 20.',
    'Когда вы бросаете Кость Хитов, чтобы восстановить хиты, минимальное число восстановленных хитов равно удвоенному модификатору Телосложения, но не менее 2.',
  ],
  healer: [
    'Когда вы используете набор целителя для стабилизации умирающего существа, оно восстанавливает 1 хит вместо того, чтобы просто стать стабильным.',
    'Действием вы можете потратить одно применение набора целителя и восстановить существу 1d6 + 4 хита, а также дополнительные хиты в количестве, равном максимальному числу его Костей Хитов. Существо не может снова получить лечение от этой черты до окончания короткого или продолжительного отдыха.',
  ],
  'great-weapon-master': [
    'В свой ход, когда вы совершаете критическое попадание оружием ближнего боя или уменьшаете хиты существа до 0 атакой оружием ближнего боя, вы можете бонусным действием совершить одну атаку оружием ближнего боя.',
    'Перед броском атаки оружием ближнего боя со свойством «тяжёлое», которым вы владеете, вы можете получить штраф −5 к броску атаки. Если атака попадает, к её урону добавляется +10.',
  ],
  'polearm-master': [
    'Когда вы совершаете действие Атака и атакуете только глефой, алебардой, боевым посохом или копьём, вы можете бонусным действием совершить этим оружием ещё одну атаку противоположным концом, используя тот же модификатор характеристики, что и для основной атаки. Кость урона этой атаки — d4, а тип урона — дробящий.',
    'Когда вы держите глефу, алебарду, пику, боевой посох или копьё, другие существа провоцируют от вас провоцированную атаку, когда входят в досягаемость, которую даёт вам это оружие.',
  ],
  'weapon-master': [
    'Увеличьте Силу или Ловкость на 1, максимум до 20.',
    'Выберите четыре простых или воинских оружия. Вы получаете владение каждым выбранным оружием.',
  ],
  'medium-armor-master': [
    'Когда вы носите средний доспех, он не накладывает помеху на проверки Ловкости (Скрытность).',
    'Когда вы носите средний доспех, вы можете добавить к КД до 3 вместо обычных 2 от модификатора Ловкости, если ваша Ловкость равна 16 или выше.',
  ],
  'heavy-armor-master': [
    'Увеличьте Силу на 1, максимум до 20.',
    'Когда вы носите тяжёлый доспех, дробящий, колющий и рубящий урон от немагического оружия уменьшается на 3.',
  ],
  'shield-master': [
    'Пока вы держите щит, вы получаете следующие преимущества.',
    'Если в свой ход вы совершаете действие Атака, вы можете бонусным действием попытаться толкнуть щитом существо в пределах 5 футов от вас.',
    'Если вы не недееспособны, вы можете добавлять бонус к КД от щита к спасброскам Ловкости против заклинаний и других вредных эффектов, нацеленных только на вас.',
    'Если вы подвергаетесь эффекту, позволяющему совершить спасбросок Ловкости для получения половины урона, вы можете реакцией выставить щит между собой и источником эффекта и не получить урон при успешном спасброске.',
  ],
  'spell-sniper': [
    'Когда вы накладываете заклинание, требующее броска атаки, его дальность удваивается.',
    'Ваши дальнобойные атаки заклинаниями игнорируют половину и три четверти укрытия.',
    'Вы изучаете один заговор, требующий броска атаки. Заговор выбирается из списка заклинаний барда, жреца, друида, чародея, колдуна или волшебника. Базовая характеристика для этого заговора зависит от выбранного списка: Харизма для барда, чародея и колдуна; Интеллект для волшебника; Мудрость для друида и жреца.',
  ],
  sharpshooter: [
    'Атаки дальнобойным оружием на дальней дистанции не получают помеху.',
    'Ваши дальнобойные атаки оружием игнорируют половину и три четверти укрытия.',
    'Перед броском атаки дальнобойным оружием, которым вы владеете, вы можете получить штраф −5 к броску атаки. Если атака попадает, к её урону добавляется +10.',
  ],
  charger: [
    'Когда вы используете действие Рывок, вы можете бонусным действием совершить одну атаку оружием ближнего боя или попытаться толкнуть существо.',
    'Если перед этим бонусным действием вы переместились как минимум на 10 футов по прямой, попавшая атака оружием ближнего боя получает +5 к урону либо успешный толчок отбрасывает цель на 10 футов от вас.',
  ],
  'defensive-duelist': [
    'Когда вы держите оружие со свойством «фехтовальное», которым владеете, и другое существо попадает по вам атакой ближнего боя, вы можете реакцией добавить бонус мастерства к КД для этой атаки, из-за чего она может промахнуться.',
  ],
  skilled: [
    'Вы получаете владение любыми тремя навыками или инструментами в любой комбинации.',
  ],
  'keen-mind': [
    'Увеличьте Интеллект на 1, максимум до 20.',
    'Вы всегда знаете, где находится север, сколько часов осталось до следующего восхода или заката, а также можете безошибочно вспомнить всё, что видели или слышали за последний месяц.',
  ],
  mobile: [
    'Ваша скорость увеличивается на 10 футов.',
    'Когда вы совершаете Рывок, труднопроходимая местность не требует от вас дополнительного перемещения в этот ход.',
    'Когда вы совершаете рукопашную атаку по существу, вы не провоцируете от него провоцированные атаки до конца хода, независимо от того, попали вы или промахнулись.',
  ],
  'magic-initiate': [
    'Выберите барда, жреца, друида, чародея, колдуна или волшебника. Вы изучаете два заговора из списка заклинаний выбранного класса.',
    'Из того же списка вы изучаете одно заклинание 1-го уровня. С помощью этой черты вы можете один раз наложить его на минимальном уровне без расхода ячейки; возможность восстанавливается после продолжительного отдыха. Если выбранный для черты класс является одним из ваших классов, обычные правила его накладывания заклинаний определяют, можете ли вы расходовать его ячейки на это изученное заклинание; сама черта ячеек не создаёт.',
    'Способность для этих заклинаний определяется выбранным классом: Харизма для барда, чародея и колдуна; Мудрость для жреца и друида; Интеллект для волшебника.',
  ],
  skulker: [
    'Вы можете попытаться спрятаться, когда слегка заслонены от существа, от которого скрываетесь, например в тусклом свете, тумане или листве.',
    'Если вы скрыты от существа, промах при атаке дальнобойным оружием не раскрывает ему ваше местоположение.',
    'Тусклый свет не накладывает помеху на ваши проверки Мудрости (Восприятие), основанные на зрении.',
  ],
  'ritual-caster': [
    'Требуется Интеллект или Мудрость 13 или выше. Выберите барда, жреца, друида, чародея, колдуна или волшебника; выбранный класс определяет базовую характеристику: Харизма для барда, чародея и колдуна; Интеллект для волшебника; Мудрость для друида и жреца.',
    'Вы получаете книгу ритуалов с двумя ритуальными заклинаниями 1-го уровня по вашему выбору из списка выбранного класса. Книгу нужно держать в руке во время накладывания записанных в ней заклинаний; эта черта позволяет накладывать их как ритуалы.',
    'Если вы находите письменную копию заклинания, оно должно быть в списке выбранного класса, иметь ключевое слово «ритуал» и быть не выше половины вашего уровня, округлённой вверх. Вы можете переписать его в книгу: это занимает 2 часа за каждый уровень заклинания и стоит 50 зм за каждый уровень заклинания. В книгу можно добавлять новые подходящие ритуалы во время приключений.',
  ],
  'elemental-adept': [
    'Выберите один тип урона: кислота, холод, огонь, электричество или гром. Заклинания, которые вы накладываете и которые причиняют выбранный тип урона, игнорируют сопротивление этому типу.',
    'При определении урона заклинания выбранной стихии вы можете считать выпавшие на костях единицы двойками.',
    'Эту черту можно выбрать несколько раз, но каждый раз нужно выбрать другой тип урона.',
  ],
  resilient: [
    'Увеличьте одну выбранную характеристику на 1, максимум до 20.',
    'Вы получаете владение спасбросками выбранной характеристикой.',
  ],
  sentinel: [
    'Когда вы попадаете по существу провоцированной атакой, его скорость становится 0 до конца текущего хода, и оно не может продолжить перемещение.',
    'Существа провоцируют от вас провоцированные атаки, даже если передвижение использовало действие Отступление.',
    'Когда существо в пределах 5 футов от вас совершает атаку по цели, отличной от вас и не имеющей этой черты, вы можете реакцией совершить по атакующему одну атаку оружием ближнего боя.',
  ],
  'mage-slayer': [
    'Когда существо в пределах 5 футов от вас накладывает заклинание, вы можете реакцией совершить по нему одну атаку оружием ближнего боя.',
    'Если вы наносите урон существу, концентрирующемуся на заклинании, оно совершает с помехой спасбросок Телосложения для сохранения концентрации.',
    'Вы совершаете с преимуществом спасброски против заклинаний, наложенных существами в пределах 5 футов от вас.',
  ],
  tough: [
    'Когда вы получаете эту черту, ваш максимум хитов увеличивается на 2 за каждый уже полученный уровень.',
    'Каждый раз после этого, когда вы получаете новый уровень, ваш максимум хитов дополнительно увеличивается ещё на 2.',
  ],
  'crossbow-expert': [
    'Вы игнорируете свойство «перезарядка» у арбалетов, которыми владеете.',
    'Нахождение в пределах 5 футов от враждебного существа не накладывает помеху на ваши дальнобойные броски атаки.',
    'Когда вы совершаете действие Атака и атакуете одноручным оружием, вы можете бонусным действием атаковать из ручного арбалета, который держите в руке.',
  ],
  linguist: [
    'Увеличьте Интеллект на 1, максимум до 20, и выучите три языка по вашему выбору.',
    'Вы можете создавать письменные шифры. Другие существа не могут расшифровать созданный вами код, если вы их не обучили, они не преуспели в проверке Интеллекта со СЛ, равной вашему Интеллекту + ваш бонус мастерства, или не использовали магию для расшифровки.',
  ],
})

const FEAT_DEFINITIONS = [
  ['actor', 'Артистичный', 'Actor', 'Мастер перевоплощений и убедительной имитации.'],
  ['athlete', 'Атлетичный', 'Athlete', 'Физическая подготовка ускоряет подъём и прыжки.', [], { ability: { type: 'ability', options: ['str', 'dex'] } }],
  ['alert', 'Бдительный', 'Alert', 'Вы быстро замечаете угрозу и почти не даёте застать себя врасплох.'],
  ['war-caster', 'Боевой заклинатель', 'War Caster', 'Вы сохраняете концентрацию и колдуете, удерживая оружие или щит.', PREREQUISITES['war-caster']],
  ['grappler', 'Борец', 'Grappler', 'Захваты и удержание противника становятся надёжнее.', PREREQUISITES.grappler],
  ['lucky', 'Везунчик', 'Lucky', 'Трижды за день удача помогает изменить результат броска.'],
  ['mounted-combatant', 'Верховой боец', 'Mounted Combatant', 'Вы защищаете ездовое животное и лучше сражаетесь верхом.'],
  ['observant', 'Внимательный', 'Observant', 'Вы замечаете детали, читаете по губам и запоминаете больше.', [], { ability: { type: 'ability', options: ['int', 'wis'] } }],
  ['martial-adept', 'Воинский адепт', 'Martial Adept', 'Два боевых приёма и кость превосходства расширяют тактику.', [], { maneuvers: { type: 'maneuver', count: 2, options: [...PHB_MARTIAL_ADEPT_MANEUVER_IDS] } }],
  ['inspiring-leader', 'Воодушевляющий лидер', 'Inspiring Leader', 'Речь перед боем даёт союзникам запас временных хитов.', PREREQUISITES['inspiring-leader']],
  ['savage-attacker', 'Дикий атакующий', 'Savage Attacker', 'Раз за ход вы выбираете лучший бросок урона оружием ближнего боя.'],
  ['tavern-brawler', 'Драчун', 'Tavern Brawler', 'Подручные предметы и кулаки становятся полноценным оружием.', [], { ability: { type: 'ability', options: ['str', 'con'] } }],
  ['lightly-armored', 'Знаток лёгких доспехов', 'Lightly Armored', 'Тренировка позволяет носить лёгкие доспехи.', [], { ability: { type: 'ability', options: ['str', 'dex'] } }],
  ['moderately-armored', 'Знаток средних доспехов', 'Moderately Armored', 'Вы осваиваете средние доспехи и щиты.', PREREQUISITES['moderately-armored'], { ability: { type: 'ability', options: ['str', 'dex'] } }],
  ['heavily-armored', 'Знаток тяжёлых доспехов', 'Heavily Armored', 'Вы осваиваете тяжёлые доспехи.', PREREQUISITES['heavily-armored']],
  ['dual-wielder', 'Использование двух оружий', 'Dual Wielder', 'Вы сражаетесь двумя одноручными оружиями, даже если они не лёгкие.'],
  ['dungeon-delver', 'Исследователь подземелий', 'Dungeon Delver', 'Ловушки и тайные двери редко остаются для вас незамеченными.'],
  ['durable', 'Стойкий', 'Durable', 'Отдых и Кости Хитов восстанавливают больше здоровья.'],
  ['healer', 'Лекарь', 'Healer', 'Аптечка в ваших руках лечит и возвращает союзников в строй.'],
  ['great-weapon-master', 'Мастер большого оружия', 'Great Weapon Master', 'Тяжёлое оружие позволяет обменивать точность на урон и добивать врагов.'],
  ['polearm-master', 'Мастер древкового оружия', 'Polearm Master', 'Древковое оружие даёт дополнительный удар и контролирует подход.'],
  ['weapon-master', 'Мастер оружия', 'Weapon Master', 'Четыре выбранных оружия становятся вам знакомы.', [], { weapons: { type: 'weapon', count: 4 } }],
  ['medium-armor-master', 'Мастер средних доспехов', 'Medium Armor Master', 'Средние доспехи перестают мешать скрытности и лучше используют Ловкость.', PREREQUISITES['medium-armor-master']],
  ['heavy-armor-master', 'Мастер тяжёлых доспехов', 'Heavy Armor Master', 'Тяжёлые доспехи снижают обычный физический урон.', PREREQUISITES['heavy-armor-master']],
  ['shield-master', 'Мастер щитов', 'Shield Master', 'Щит помогает сбивать врагов и переживать направленные эффекты.'],
  ['spell-sniper', 'Меткие заклинания', 'Spell Sniper', 'Дальнобойные заклинания точнее обходят укрытия.', PREREQUISITES['spell-sniper'], { class: { type: 'spellcasting_class', options: [...SPELLCASTING_CLASSES] }, cantrip: { type: 'attack_roll_cantrip', count: 1 } }],
  ['sharpshooter', 'Меткий стрелок', 'Sharpshooter', 'Дальний выстрел сохраняет силу и точность сквозь укрытие.'],
  ['charger', 'Налётчик', 'Charger', 'Разгон превращается в мощную атаку или толчок.', [], undefined],
  ['defensive-duelist', 'Оборонительный дуэлянт', 'Defensive Duelist', 'Фехтовальная реакция может превратить попадание в промах.', PREREQUISITES['defensive-duelist']],
  ['skilled', 'Одарённый', 'Skilled', 'Три дополнительных владения расширяют набор умений.', [], { skills: { type: 'skill_or_tool', count: 3 }, tools: { type: 'skill_or_tool', count: 3 } }],
  ['keen-mind', 'Отличная память', 'Keen Mind', 'Вы безошибочно ориентируетесь во времени, направлении и деталях.'],
  ['mobile', 'Подвижный', 'Mobile', 'Вы быстрее перемещаетесь и легче выходите из ближнего боя.'],
  ['magic-initiate', 'Посвящённый в магию', 'Magic Initiate', 'Два заговора и одно заклинание дают начальное обучение магии.', [], { class: { type: 'spellcasting_class', options: [...SPELLCASTING_CLASSES] }, cantrips: { type: 'cantrip', count: 2 }, spell: { type: 'first_level_spell', count: 1 } }],
  ['skulker', 'Проныра', 'Skulker', 'Тусклый свет и промахи меньше выдают скрывающегося стрелка.', PREREQUISITES.skulker],
  ['ritual-caster', 'Ритуальный заклинатель', 'Ritual Caster', 'Книга ритуалов сохраняет два первых ритуала выбранной традиции.', PREREQUISITES['ritual-caster'], { class: { type: 'spellcasting_class', options: [...SPELLCASTING_CLASSES] }, rituals: { type: 'first_level_ritual', count: 2 } }],
  ['elemental-adept', 'Стихийный адепт', 'Elemental Adept', 'Вы выбираете стихию и лучше пробиваете её сопротивление.', PREREQUISITES['elemental-adept'], { damage_type: { type: 'damage_type', options: [...ELEMENTAL_DAMAGE_TYPES] } }],
  ['resilient', 'Устойчивый', 'Resilient', 'Одна характеристика растёт, а её спасбросок становится привычным.', [], { ability: { type: 'ability', options: [...ABILITY_IDS] } }],
  ['sentinel', 'Страж', 'Sentinel', 'Вы удерживаете врагов рядом и наказываете за атаки по союзникам.'],
  ['mage-slayer', 'Убийца магов', 'Mage Slayer', 'Ближний бой мешает противнику колдовать и держать концентрацию.'],
  ['tough', 'Крепкий', 'Tough', 'Каждый уровень даёт ещё два максимальных хита.'],
  ['crossbow-expert', 'Эксперт в арбалетах', 'Crossbow Expert', 'Арбалет можно использовать вплотную и быстро перезаряжать.'],
  ['linguist', 'Языковед', 'Linguist', 'Три языка и собственные шифры расширяют общение.', [], { languages: { type: 'language', count: 3 } }],
]

const fixedAbilityIncreases = Object.freeze({
  actor: { cha: 1 }, durable: { con: 1 }, 'heavily-armored': { str: 1 },
  'heavy-armor-master': { str: 1 }, 'keen-mind': { int: 1 },
  linguist: { int: 1 }, tough: {},
})
const armorBenefits = Object.freeze({
  'lightly-armored': ['light'], 'moderately-armored': ['medium', 'shield'], 'heavily-armored': ['heavy'],
})

function freezeDefinition([id, name, englishName, summary, prerequisites = [], choiceSchema]) {
  return Object.freeze({
    id, name, english_name: englishName, summary, source: PHB_2014_FEATS_SOURCE.source,
    source_url: PHB_2014_FEATS_SOURCE.source_url, book: PHB_2014_FEATS_SOURCE.book,
    edition: PHB_2014_FEATS_SOURCE.edition, prerequisites: clone(prerequisites),
    choice_schema: clone(choiceSchema ?? {}), description: clone(FEAT_DESCRIPTIONS[id] ?? [summary]),
    mechanics_status: 'partial',
  })
}

export const PHB_2014_FEATS = Object.freeze(FEAT_DEFINITIONS.map(freezeDefinition))
const FEATS_BY_ID = new Map(PHB_2014_FEATS.map((feat) => [feat.id, feat]))

function normalizeAbilities(value) {
  if (value == null) return { ok: true, value: {} }
  if (!isRecord(value)) return { ok: false, code: 'INVALID_CONTEXT', reason: 'context.abilities должен быть объектом' }
  const result = {}
  for (const ability of ABILITY_IDS) {
    if (!hasOwn(value, ability)) continue
    const score = Number(value[ability])
    if (!Number.isFinite(score)) return { ok: false, code: 'INVALID_CONTEXT', reason: `context.abilities.${ability} должен быть числом` }
    result[ability] = score
  }
  return { ok: true, value: result }
}

function listFrom(value) {
  if (Array.isArray(value)) return value
  if (value instanceof Set) return [...value]
  return []
}

function firstList(record, names) {
  for (const name of names) if (hasOwn(record, name)) return listFrom(record[name])
  return []
}

function normalizeContext(context = {}) {
  if (context == null) context = {}
  if (!isRecord(context)) return { ok: false, code: 'INVALID_CONTEXT', reason: 'context должен быть объектом' }
  const abilityResult = normalizeAbilities(context.abilities)
  if (!abilityResult.ok) return abilityResult
  const proficiency = isRecord(context.proficiency) ? context.proficiency : (isRecord(context.proficiencies) ? context.proficiencies : {})
  const weaponValues = firstList(proficiency, ['weapons', 'weapon', 'weapon_proficiencies', 'weaponProficiencies'])
  const armorValues = firstList(proficiency, ['armor', 'armors', 'armor_proficiencies', 'armorProficiencies'])
  const weapons = new Set([...weaponValues, ...firstList(context, ['weapons', 'weaponProficiencies', 'weapon_proficiencies'])].map(canonicalToken))
  const armor = new Set([...armorValues, ...firstList(context, ['armor', 'armorProficiencies', 'armor_proficiencies'])].map((value) => {
    const normalized = canonicalToken(value).replace(/_armor$/u, '')
    return normalized === 'shields' ? 'shield' : normalized
  }))
  const skills = new Set(firstList(context, ['skills', 'skillProficiencies', 'skill_proficiencies']).map(canonicalToken))
  const tools = new Set(firstList(context, ['tools', 'toolProficiencies', 'tool_proficiencies']).map(canonicalToken))
  const languages = new Set(firstList(context, ['languages', 'languageProficiencies', 'language_proficiencies']).map(canonicalToken))
  const existingFeats = new Set(firstList(context, ['feats', 'selectedFeats', 'selected_feats']).map(token))
  const existingFeatChoices = context.existingFeatChoices ?? context.existing_feat_choices ?? context.featChoices ?? context.feat_choices ?? {}
  return {
    ok: true,
    value: {
      abilities: abilityResult.value, weapons, armor, skills, tools, languages, existingFeats, existingFeatChoices,
      canCastSpells: context.canCastSpells === true || context.can_cast_spells === true,
      proficiencyBonus: Number(context.proficiencyBonus ?? context.proficiency_bonus ?? 0) || 0,
      allowCappedAbilityIncrease: context.allowCappedAbilityIncrease === true || context.allow_capped_ability_increase === true,
    },
  }
}

function abilityScore(context, ability) {
  return Number(context.abilities[ability] ?? 10)
}

function prerequisiteResult(feat, context) {
  const unmet = []
  for (const prerequisite of feat.prerequisites) {
    if (prerequisite.kind === 'ability' && abilityScore(context, prerequisite.ability) < prerequisite.minimum) unmet.push(prerequisite.label)
    if (prerequisite.kind === 'ability_any' && !prerequisite.abilities.some((ability) => abilityScore(context, ability) >= prerequisite.minimum)) unmet.push(prerequisite.label)
    if (prerequisite.kind === 'spellcasting' && !context.canCastSpells) unmet.push(prerequisite.label)
    if (prerequisite.kind === 'proficiency' && prerequisite.category === 'armor' && !context.armor.has(prerequisite.value)) unmet.push(prerequisite.label)
    if (prerequisite.kind === 'proficiency' && prerequisite.category === 'weapon' && !context.weapons.has(prerequisite.value)) unmet.push(prerequisite.label)
  }
  return { ok: unmet.length === 0, unmet }
}

function emptyBenefits() {
  return {
    ability_increases: {}, saving_throw_proficiencies: [], skill_proficiencies: [], tool_proficiencies: [],
    language_proficiencies: [], weapon_proficiencies: [], armor_proficiencies: [], speed_bonus: 0,
    hit_point_maximum_bonus_per_level: 0, armor_class_bonus: 0, initiative_bonus: 0,
    passive_skill_bonuses: {}, spellcasting: null, static: {},
  }
}

function addAbilityIncrease(benefits, ability, context) {
  if (!ABILITY_IDS.includes(ability)) return { ok: false, code: 'CHOICE_INVALID', reason: 'Неизвестная характеристика' }
  if (abilityScore(context, ability) >= 20) {
    if (context.allowCappedAbilityIncrease) return { ok: true }
    return { ok: false, code: 'ABILITY_MAX_REACHED', reason: 'Значение характеристики уже достигло максимума 20' }
  }
  benefits.ability_increases[ability] = (benefits.ability_increases[ability] ?? 0) + 1
  return { ok: true }
}

function resolveAbilityChoice(feat, choices, context, benefits) {
  const allowed = ABILITY_CHOICES[feat.id]
  if (!allowed) return { ok: true, choices: {} }
  const selected = canonicalToken(choiceValue(choices, ['ability', 'ability_id', 'abilityId']))
  if (!selected) return { ok: false, code: 'CHOICE_REQUIRED', reason: 'Нужно выбрать характеристику' }
  if (!allowed.includes(selected)) return { ok: false, code: 'CHOICE_INVALID', reason: 'Эта характеристика недоступна для выбранной черты' }
  const increase = addAbilityIncrease(benefits, selected, context)
  if (!increase.ok) return increase
  return { ok: true, choices: { ability: selected } }
}

function resolveFixedAbility(feat, context, benefits) {
  for (const [ability, amount] of Object.entries(fixedAbilityIncreases[feat.id] ?? {})) {
    if (abilityScore(context, ability) >= 20) {
      if (context.allowCappedAbilityIncrease) continue
      return { ok: false, code: 'ABILITY_MAX_REACHED', reason: 'Значение характеристики уже достигло максимума 20' }
    }
    benefits.ability_increases[ability] = amount
  }
  return { ok: true }
}

function resolveSkilled(choices, benefits) {
  const skills = choiceValue(choices, ['skills', 'skill_ids', 'skillIds'])
  const tools = choiceValue(choices, ['tools', 'tool_ids', 'toolIds'])
  if (skills === undefined && tools === undefined) return { ok: false, code: 'CHOICE_REQUIRED', reason: 'Нужно выбрать три навыка или инструмента' }
  const selectedSkills = listFrom(skills).map(canonicalToken)
  const selectedTools = listFrom(tools).map(canonicalToken)
  if (selectedSkills.some((id) => !SKILLS.includes(id))) return { ok: false, code: 'CHOICE_INVALID', reason: 'Одарённый: неизвестный навык' }
  if (selectedTools.some((id) => !TOOLS.includes(id))) return { ok: false, code: 'CHOICE_INVALID', reason: 'Одарённый: неизвестный инструмент' }
  if (selectedSkills.length + selectedTools.length !== 3) return { ok: false, code: 'CHOICE_COUNT_INVALID', reason: 'Одарённый: нужно выбрать ровно три навыка или инструмента' }
  if (new Set([...selectedSkills, ...selectedTools]).size !== 3) return { ok: false, code: 'CHOICE_DUPLICATE', reason: 'Одарённый: варианты не должны повторяться' }
  benefits.skill_proficiencies.push(...selectedSkills)
  benefits.tool_proficiencies.push(...selectedTools)
  return { ok: true, choices: { skills: selectedSkills, tools: selectedTools } }
}

function resolveWeaponMaster(choices, benefits) {
  const raw = choiceValue(choices, ['weapons', 'weapon_ids', 'weaponIds'])
  const selected = exactArray(raw, 4, 'Мастер оружия')
  if (!selected.ok) return selected
  if (selected.value.some((id) => !WEAPONS.includes(id))) return { ok: false, code: 'CHOICE_INVALID', reason: 'Мастер оружия: неизвестное оружие' }
  benefits.weapon_proficiencies.push(...selected.value)
  return { ok: true, choices: { weapons: selected.value } }
}

function resolveMartialAdept(choices, benefits) {
  const selected = maneuverArray(choiceValue(choices, ['maneuvers', 'maneuver_ids', 'maneuverIds']), 2, 'Воинский адепт: приёмы')
  if (!selected.ok) return selected
  if (selected.value.some((id) => !PHB_MARTIAL_ADEPT_MANEUVER_IDS.includes(id))) return { ok: false, code: 'CHOICE_INVALID', reason: 'Воинский адепт: неизвестный боевой приём' }
  benefits.static.maneuvers = selected.value
  return { ok: true, choices: { maneuvers: selected.value } }
}

function resolveLanguages(choices, context, benefits) {
  const raw = choiceValue(choices, ['languages', 'language_ids', 'languageIds'])
  const selected = exactArray(raw, 3, 'Языковед')
  if (!selected.ok) return selected
  if (selected.value.some((id) => !LANGUAGES.includes(id))) return { ok: false, code: 'CHOICE_INVALID', reason: 'Языковед: неизвестный язык' }
  if (selected.value.some((id) => context.languages.has(id))) return { ok: false, code: 'CHOICE_DUPLICATE', reason: 'Языковед: персонаж уже знает выбранный язык' }
  benefits.language_proficiencies.push(...selected.value)
  return { ok: true, choices: { languages: selected.value } }
}

function resolveMagicInitiate(choices, benefits) {
  const classKey = canonicalToken(choiceValue(choices, ['class', 'class_key', 'classKey']))
  if (!SPELLCASTING_CLASSES.includes(classKey)) return { ok: false, code: 'CHOICE_INVALID', reason: 'Посвящённый в магию: нужно выбрать класс заклинателя' }
  const cantripsRaw = choiceValue(choices, ['cantrips', 'cantrip_ids', 'cantripIds'])
  const cantrips = spellArray(cantripsRaw, 2, 'Посвящённый в магию: заговоры')
  if (!cantrips.ok) return cantrips
  if (cantrips.value.some((id) => !PHB_CANTRIPS[classKey].includes(id))) return { ok: false, code: 'SPELL_CHOICE_INVALID', reason: 'Заговор недоступен в списке выбранного класса' }
  const spell = canonicalSpellId(choiceValue(choices, ['spell', 'spell_id', 'spellId']))
  if (!spell) return { ok: false, code: 'CHOICE_REQUIRED', reason: 'Посвящённый в магию: нужно выбрать заклинание 1-го уровня' }
  if (!PHB_FIRST_LEVEL_SPELLS[classKey].includes(spell)) return { ok: false, code: 'SPELL_CHOICE_INVALID', reason: 'Заклинание недоступно в списке выбранного класса' }
  benefits.spellcasting = {
    source: 'magic-initiate', class_key: classKey, ability: SPELLCASTING_ABILITY[classKey],
    cantrips: cantrips.value, first_level_spell: spell, once_per_long_rest: true, uses_spell_slots: true,
  }
  return { ok: true, choices: { class: classKey, cantrips: cantrips.value, spell } }
}

function resolveRitualCaster(choices, benefits) {
  const classKey = canonicalToken(choiceValue(choices, ['class', 'class_key', 'classKey']))
  if (!SPELLCASTING_CLASSES.includes(classKey)) return { ok: false, code: 'CHOICE_INVALID', reason: 'Ритуальный заклинатель: нужно выбрать класс заклинателя' }
  const rituals = spellArray(choiceValue(choices, ['rituals', 'ritual_ids', 'ritualIds']), 2, 'Ритуальный заклинатель: ритуалы')
  if (!rituals.ok) return rituals
  if (rituals.value.some((id) => !RITUALS[classKey].includes(id))) return { ok: false, code: 'SPELL_CHOICE_INVALID', reason: 'Ритуал недоступен в списке выбранного класса' }
  benefits.spellcasting = {
    source: 'ritual-caster', class_key: classKey, ability: SPELLCASTING_ABILITY[classKey], rituals: rituals.value,
    ritual_book: true, cast_as_ritual_only: true, can_add_rituals_found: true,
  }
  return { ok: true, choices: { class: classKey, rituals: rituals.value } }
}

function resolveSpellSniper(choices, benefits) {
  const classKey = canonicalToken(choiceValue(choices, ['class', 'class_key', 'classKey']))
  if (!SPELLCASTING_CLASSES.includes(classKey)) return { ok: false, code: 'CHOICE_INVALID', reason: 'Меткие заклинания: нужно выбрать класс заклинателя' }
  const cantrip = canonicalSpellId(choiceValue(choices, ['cantrip', 'cantrip_id', 'cantripId']))
  if (!cantrip || !SPELL_SNIPER_CANTRIPS[classKey].includes(cantrip)) return { ok: false, code: 'SPELL_CHOICE_INVALID', reason: 'Нужно выбрать заговор с броском атаки из списка класса' }
  benefits.spellcasting = {
    source: 'spell-sniper', class_key: classKey, ability: SPELLCASTING_ABILITY[classKey], cantrips: [cantrip],
  }
  return { ok: true, choices: { class: classKey, cantrip } }
}

function resolveElementalAdept(choices, benefits) {
  const damageType = canonicalToken(choiceValue(choices, ['damage_type', 'damageType', 'damage']))
  if (!ELEMENTAL_DAMAGE_TYPES.includes(damageType)) return { ok: false, code: 'CHOICE_INVALID', reason: 'Стихийный адепт: выберите кислоту, холод, огонь, электричество или гром' }
  benefits.static.selected_damage_type = damageType
  return { ok: true, choices: { damage_type: damageType } }
}

function previousElementalDamageTypes(context) {
  const source = context.existingFeatChoices
  if (!isRecord(source)) return []
  const entries = source['elemental-adept'] ?? source.elemental_adept ?? source.elementalAdept
  const list = Array.isArray(entries) ? entries : entries == null ? [] : [entries]
  return list.map((entry) => canonicalToken(isRecord(entry) ? (entry.damage_type ?? entry.damageType ?? entry.damage) : entry))
}

function featAlreadyTaken(feat, context, choices) {
  if (feat.id === 'elemental-adept') return false
  return context.existingFeats.has(feat.id)
}

function validateChoiceShape(choices) {
  if (choices == null) return { ok: true, value: {} }
  if (!isRecord(choices)) return { ok: false, code: 'INVALID_CHOICES', reason: 'choices должен быть объектом' }
  return { ok: true, value: choices }
}

const CHOICE_KEYS = Object.freeze({
  actor: [], athlete: ['ability', 'ability_id', 'abilityId'], alert: [], 'war-caster': [], grappler: [], lucky: [],
  'mounted-combatant': [], observant: ['ability', 'ability_id', 'abilityId'], 'martial-adept': ['maneuvers', 'maneuver_ids', 'maneuverIds'], 'inspiring-leader': [],
  'savage-attacker': [], 'tavern-brawler': ['ability', 'ability_id', 'abilityId'],
  'lightly-armored': ['ability', 'ability_id', 'abilityId'], 'moderately-armored': ['ability', 'ability_id', 'abilityId'],
  'heavily-armored': [], 'dual-wielder': [], 'dungeon-delver': [], durable: [], healer: [], 'great-weapon-master': [],
  'polearm-master': [], 'weapon-master': ['weapons', 'weapon_ids', 'weaponIds'], 'medium-armor-master': [],
  'heavy-armor-master': [], 'shield-master': [], 'spell-sniper': ['class', 'class_key', 'classKey', 'cantrip', 'cantrip_id', 'cantripId'],
  sharpshooter: [], charger: [], 'defensive-duelist': [], skilled: ['skills', 'skill_ids', 'skillIds', 'tools', 'tool_ids', 'toolIds'],
  'keen-mind': [], mobile: [], 'magic-initiate': ['class', 'class_key', 'classKey', 'cantrips', 'cantrip_ids', 'cantripIds', 'spell', 'spell_id', 'spellId'],
  skulker: [], 'ritual-caster': ['class', 'class_key', 'classKey', 'rituals', 'ritual_ids', 'ritualIds'],
  'elemental-adept': ['damage_type', 'damageType', 'damage'], resilient: ['ability', 'ability_id', 'abilityId'], sentinel: [],
  'mage-slayer': [], tough: [], 'crossbow-expert': [], linguist: ['languages', 'language_ids', 'languageIds'],
})

function validateChoiceKeys(featId, choices) {
  const allowed = new Set(CHOICE_KEYS[featId] ?? [])
  const unexpected = Object.keys(choices).filter((key) => !allowed.has(key))
  return unexpected.length
    ? { ok: false, code: 'CHOICE_UNKNOWN_FIELD', reason: `choices содержит неподдерживаемые поля: ${unexpected.join(', ')}` }
    : { ok: true }
}

export function characterCreationFeatFor(featId) {
  return FEATS_BY_ID.get(String(featId ?? '').trim().toLocaleLowerCase('en'))
    ? clone(FEATS_BY_ID.get(String(featId ?? '').trim().toLocaleLowerCase('en')))
    : null
}

export function listCharacterCreationFeats(context = {}) {
  const normalized = normalizeContext(context)
  const value = normalized.ok ? normalized.value : null
  return PHB_2014_FEATS.map((feat) => {
    const status = value ? prerequisiteResult(feat, value) : { ok: false, unmet: [normalized.reason] }
    return { ...clone(feat), prerequisites_met: status.ok, unmet_prerequisites: [...status.unmet] }
  })
}

export function resolveCharacterCreationFeat(featId, choices = {}, context = {}) {
  const id = String(featId ?? '').trim().toLocaleLowerCase('en')
  const feat = FEATS_BY_ID.get(id)
  if (!feat) return { ok: false, code: 'UNKNOWN_FEAT', reason: 'Такой черты PHB 2014 нет в каталоге', feat_id: id }
  const normalizedContext = normalizeContext(context)
  if (!normalizedContext.ok) return { ok: false, code: normalizedContext.code, reason: normalizedContext.reason, feat_id: id }
  const shape = validateChoiceShape(choices)
  if (!shape.ok) return { ok: false, code: shape.code, reason: shape.reason, feat_id: id }
  const choiceKeys = validateChoiceKeys(id, shape.value)
  if (!choiceKeys.ok) return { ok: false, code: choiceKeys.code, reason: choiceKeys.reason, feat_id: id }
  const prerequisite = prerequisiteResult(feat, normalizedContext.value)
  if (!prerequisite.ok) return { ok: false, code: 'PREREQUISITE_NOT_MET', reason: `Не выполнены требования: ${prerequisite.unmet.join('; ')}`, feat_id: id, unmet_prerequisites: prerequisite.unmet }
  if (featAlreadyTaken(feat, normalizedContext.value, shape.value)) return { ok: false, code: 'FEAT_ALREADY_TAKEN', reason: 'Одну и ту же черту нельзя выбрать повторно', feat_id: id }

  const benefits = emptyBenefits()
  benefits.static = clone(STATIC[id] ?? {})
  if (id === 'mobile') benefits.speed_bonus = 10
  if (id === 'dual-wielder') benefits.armor_class_bonus = 1
  if (id === 'alert') benefits.initiative_bonus = 5
  if (id === 'observant') benefits.passive_skill_bonuses = { perception: 5, investigation: 5 }
  if (id === 'tough') benefits.hit_point_maximum_bonus_per_level = 2
  for (const armor of armorBenefits[id] ?? []) benefits.armor_proficiencies.push(armor)

  const resolvedChoices = {}
  const fixed = resolveFixedAbility(feat, normalizedContext.value, benefits)
  if (!fixed.ok) return { ok: false, code: fixed.code, reason: fixed.reason, feat_id: id }
  if (ABILITY_CHOICES[id]) {
    const resolved = resolveAbilityChoice(feat, shape.value, normalizedContext.value, benefits)
    if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason, feat_id: id }
    Object.assign(resolvedChoices, resolved.choices)
  }

  let resolved
  if (id === 'skilled') resolved = resolveSkilled(shape.value, benefits)
  else if (id === 'weapon-master') resolved = resolveWeaponMaster(shape.value, benefits)
  else if (id === 'martial-adept') resolved = resolveMartialAdept(shape.value, benefits)
  else if (id === 'magic-initiate') resolved = resolveMagicInitiate(shape.value, benefits)
  else if (id === 'ritual-caster') resolved = resolveRitualCaster(shape.value, benefits)
  else if (id === 'spell-sniper') resolved = resolveSpellSniper(shape.value, benefits)
  else if (id === 'elemental-adept') resolved = resolveElementalAdept(shape.value, benefits)
  else if (id === 'linguist') resolved = resolveLanguages(shape.value, normalizedContext.value, benefits)
  else resolved = { ok: true, choices: {} }
  if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason, feat_id: id }
  Object.assign(resolvedChoices, resolved.choices)
  if (id === 'elemental-adept' && previousElementalDamageTypes(normalizedContext.value).includes(resolvedChoices.damage_type)) {
    return { ok: false, code: 'FEAT_CHOICE_ALREADY_TAKEN', reason: 'Стихийный адепт: при повторном выборе нужна другая стихия', feat_id: id }
  }
  if (id === 'resilient') benefits.saving_throw_proficiencies.push(resolvedChoices.ability)
  if (id === 'skilled' && benefits.skill_proficiencies.length + benefits.tool_proficiencies.length !== 3) {
    return { ok: false, code: 'CHOICE_COUNT_INVALID', reason: 'Одарённый: нужно выбрать ровно три навыка или инструмента', feat_id: id }
  }
  return {
    ok: true, feat: clone(feat), choices: clone(resolvedChoices), benefits: clone(benefits), mechanics_status: 'partial',
  }
}
