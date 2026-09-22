import catalogPayload from '../data/dndsu-spells-0-6.json'
import mechanicsOverrides from '../data/dndsu-spell-mechanics-overrides.json'
import { areaCells, type AreaPoint, type AreaShape } from './area-geometry'
import type { BoardContext2D, BoardEffectRenderer, BoardScene } from './board-render'
import type { BoardPoint, CombatAnimationCue, SpellAnimationCue } from './combat-animation'
import { revealedAt } from './tactical-map-client'
import { actorFootprintCells, actorPresentationCenter, areaCellsForActor } from './tactical-ui'
import { maskSpellAreaCells } from './spell-targeting'
import type { ActorFootprint, TacticalMap } from './types'

export type MagicSchool =
  | 'abjuration'
  | 'conjuration'
  | 'divination'
  | 'enchantment'
  | 'evocation'
  | 'illusion'
  | 'necromancy'
  | 'transmutation'

export type SpellEffectDetail = 'full' | 'reduced' | 'minimal'
export type SpellVisualKind = SpellAnimationCue['kind']
export type SpellEffectFamily =
  | 'fire'
  | 'cold'
  | 'lightning'
  | 'thunder'
  | 'acid'
  | 'poison'
  | 'necrotic'
  | 'radiant'
  | 'force'
  | 'psychic'
  | 'healing'
  | 'protection'
  | 'control'
  | 'teleport'
  | 'summon'
  | 'earth'
  | 'wind'
  | 'water'
  | 'swarm'
  | 'weapon'
  | 'illusion'
  | 'divination'
  | 'light'
  | 'darkness'
  | 'environment'
  | 'enchantment'
  | 'restoration'
  | 'invisibility'
  | 'flight'
  | 'mobility'
  | 'transmutation'
  | 'communication'
  | 'utility'
  | 'school'

export type SpellSoundFamily =
  | 'flame' | 'frost' | 'electric' | 'thunder' | 'acid' | 'poison'
  | 'necrotic' | 'radiant' | 'force' | 'psychic' | 'healing' | 'ward'
  | 'control' | 'teleport' | 'summon' | 'illusion' | 'divination'
  | 'light' | 'darkness' | 'environment' | 'enchantment' | 'restoration'
  | 'invisibility' | 'flight' | 'mobility' | 'transmutation' | 'communication'
  | 'earth' | 'wind' | 'water' | 'swarm' | 'weapon' | 'utility' | 'silence'

export type SpellVisualVariant = 'spectral-hand' | 'minor-tricks' | 'borrowed-knowledge' | 'secret-chest' | 'spelljamming-helm' | 'silence' | 'cancellation' | 'soul-transfer' | 'mobility-trail' | 'mobility-arc' | 'mobility-haste'

export type SpellSchoolStyle = {
  label: string
  primary: string
  secondary: string
  fill: string
  behavior: 'flash' | 'dome' | 'focus' | 'wave' | 'shimmer' | 'materialize' | 'inward' | 'morph'
}

export type SpellEffectPalette = Pick<SpellSchoolStyle, 'primary' | 'secondary' | 'fill' | 'behavior'> & {
  school: MagicSchool
  family: SpellEffectFamily
  familyNote?: string
  soundFamily?: SpellSoundFamily
  visualVariant?: SpellVisualVariant
}

type SpellEffectStyle = SpellSchoolStyle & SpellEffectPalette

/**
 * Книжная палитра остаётся приглушённой: школы различаются насыщенным цветом
 * и характером движения, а не неоновым свечением или россыпью частиц.
 */
export const SPELL_SCHOOL_STYLES: Readonly<Record<MagicSchool, SpellSchoolStyle>> = {
  evocation: {
    label: 'Воплощение',
    primary: '#d96d4f',
    secondary: '#efb86f',
    fill: 'rgba(186,72,48,.24)',
    behavior: 'flash',
  },
  abjuration: {
    label: 'Ограждение',
    primary: '#6f91b8',
    secondary: '#b8cbe0',
    fill: 'rgba(77,111,150,.2)',
    behavior: 'dome',
  },
  necromancy: {
    label: 'Некромантия',
    primary: '#756083',
    secondary: '#b295b9',
    fill: 'rgba(67,47,77,.27)',
    behavior: 'inward',
  },
  enchantment: {
    label: 'Очарование',
    primary: '#a66d8d',
    secondary: '#d5a9bd',
    fill: 'rgba(134,70,106,.2)',
    behavior: 'wave',
  },
  conjuration: {
    label: 'Вызов',
    primary: '#4f9a82',
    secondary: '#a6c9ad',
    fill: 'rgba(55,119,94,.22)',
    behavior: 'materialize',
  },
  transmutation: {
    label: 'Преобразование',
    primary: '#a7854d',
    secondary: '#d7bd77',
    fill: 'rgba(139,105,52,.22)',
    behavior: 'morph',
  },
  illusion: {
    label: 'Иллюзия',
    primary: '#786fae',
    secondary: '#c0b8dc',
    fill: 'rgba(91,79,145,.2)',
    behavior: 'shimmer',
  },
  divination: {
    label: 'Прорицание',
    primary: '#4f8794',
    secondary: '#acd0ce',
    fill: 'rgba(55,105,116,.2)',
    behavior: 'focus',
  },
}

type CatalogSpell = {
  id: string
  level?: number
  name?: string
  description?: string
  school?: string
  kind?: string
  target?: string
  radius?: number
  areaShape?: AreaShape
  areaOrigin?: 'self' | 'point'
  areaSideFeet?: number
  damageType?: string
  damageTypes?: string[]
  spreadsAroundCorners?: boolean
  maxTargets?: number
  projectileCount?: number
  beams?: number
  mechanicsSupport?: 'verified' | 'partial' | 'heuristic' | 'ruling-only'
  createsAreaEffect?: unknown
  requiresWeaponAttack?: boolean
}

type SpellProfileHints = Partial<CatalogSpell> & {
  concentration?: boolean
  visualFamily?: SpellEffectFamily
}

export type SpellVisualProfile = {
  spellId: string
  school: MagicSchool
  family: SpellEffectFamily
  familyNote?: string
  soundFamily?: SpellSoundFamily
  visualVariant?: SpellVisualVariant
  kind: SpellVisualKind
  requiresWeaponAttack: boolean
  spreadsAroundCorners?: boolean
  areaShape?: AreaShape
  areaOrigin?: 'self' | 'point'
  areaSideFeet?: number
  sizeFeet?: number
  radiusFeet?: number
  projectileCount?: number
  chain?: boolean
}

const catalogSpells = (catalogPayload as unknown as { spells?: CatalogSpell[] }).spells ?? []
const overrideSpells = (mechanicsOverrides as unknown as { spells?: Record<string, Partial<CatalogSpell>> }).spells ?? {}
const SPELL_CATALOG = new Map(catalogSpells.map((spell) => [
  spell.id,
  { ...spell, ...(overrideSpells[spell.id] ?? {}) },
]))

const SCHOOL_ALIASES: Record<string, MagicSchool> = {
  abjuration: 'abjuration',
  ограждение: 'abjuration',
  conjuration: 'conjuration',
  вызов: 'conjuration',
  divination: 'divination',
  прорицание: 'divination',
  enchantment: 'enchantment',
  очарование: 'enchantment',
  evocation: 'evocation',
  воплощение: 'evocation',
  illusion: 'illusion',
  иллюзия: 'illusion',
  necromancy: 'necromancy',
  некромантия: 'necromancy',
  transmutation: 'transmutation',
  преобразование: 'transmutation',
}

const PROJECTILE_SPELLS = new Set([
  'acid-arrow',
  'acid-splash',
  'chromatic-orb',
  'fire-bolt',
  'guiding-bolt',
  'hail-of-thorns',
  'ice-knife',
  'magic-missile',
  'melf-s-acid-arrow',
  'ray-of-frost',
])

const BEAM_SPELLS = new Set([
  'chain-lightning',
  'eldritch-blast',
  'lightning-lure',
  'ray-of-enfeeblement',
  'disintegrate',
  'scorching-ray',
  'sunbeam',
  'witch-bolt',
])

const COLD_SPELLS = new Set([
  'cone-of-cold',
  'ice-knife',
  'ice-storm',
  'ray-of-frost',
])

const DAMAGE_FAMILIES: Readonly<Record<string, Exclude<SpellEffectFamily, 'school' | 'healing' | 'protection' | 'control' | 'teleport' | 'summon'>>> = {
  fire: 'fire',
  cold: 'cold',
  lightning: 'lightning',
  thunder: 'thunder',
  acid: 'acid',
  poison: 'poison',
  necrotic: 'necrotic',
  radiant: 'radiant',
  force: 'force',
  psychic: 'psychic',
}

const SPELL_FAMILY_IDS: Readonly<Record<string, SpellEffectFamily>> = {
  catapult: 'earth',
  'erupting-earth': 'earth',
  'bones-of-the-earth': 'earth',
  'gust-of-wind': 'wind',
  'dust-devil': 'wind',
  'wind-wall': 'wind',
  'storm-sphere': 'wind',
  maelstrom: 'water',
  'insect-plague': 'swarm',
  'cloud-of-daggers': 'weapon',
  'blade-barrier': 'weapon',
  'cordon-of-arrows': 'weapon',
  knock: 'thunder',
  'minor-illusion': 'illusion',
  'phantasmal-force': 'illusion',
  'guardian-of-faith': 'summon',
  'conjure-elemental': 'summon',
  'fizban-s-platinum-shield': 'protection',
  'planar-binding': 'control',
  'see-invisibility': 'divination',
  shillelagh: 'transmutation',
  'magic-jar': 'control',
  'guardian-of-nature': 'transmutation',
  'investiture-of-ice': 'cold',
  'investiture-of-flame': 'fire',
  'conjure-barrage': 'weapon',
  'conjure-volley': 'weapon',
  'drawmij-s-instant-summons': 'transmutation',
  'magic-circle': 'protection',
  'mordenkainen-s-private-sanctum': 'protection',
  forbiddance: 'protection',
  'wither-and-bloom': 'necrotic',
  'silent-image': 'illusion',
  'major-image': 'illusion',
  'programmed-illusion': 'illusion',
  'hallucinatory-terrain': 'illusion',
  'disguise-self': 'illusion',
  'illusory-script': 'illusion',
  mislead: 'illusion',
  seeming: 'illusion',
  'mirror-image': 'illusion',
  blur: 'illusion',
  'nystul-s-magic-aura': 'illusion',
  light: 'light',
  'continual-flame': 'light',
  daylight: 'light',
  'dancing-lights': 'light',
  'control-flames': 'light',
  darkness: 'darkness',
  hallow: 'protection',
  silence: 'control',
  'dispel-magic': 'restoration',
  counterspell: 'protection',
  'detect-magic': 'divination',
  'detect-thoughts': 'divination',
  'detect-evil-and-good': 'divination',
  'detect-poison-and-disease': 'divination',
  identify: 'divination',
  augury: 'divination',
  divination: 'divination',
  clairvoyance: 'divination',
  scrying: 'divination',
  'true-seeing': 'divination',
  'locate-object': 'divination',
  'locate-creature': 'divination',
  'find-the-path': 'divination',
  'legend-lore': 'divination',
  commune: 'divination',
  'commune-with-nature': 'divination',
  druidcraft: 'environment',
  'mold-earth': 'environment',
  'shape-water': 'environment',
  thaumaturgy: 'environment',
  'create-or-destroy-water': 'environment',
  'fog-cloud': 'environment',
  'plant-growth': 'environment',
  'move-earth': 'environment',
  'stone-shape': 'environment',
  fabricate: 'transmutation',
  'wall-of-stone': 'environment',
  'wall-of-water': 'environment',
  'lesser-restoration': 'restoration',
  'greater-restoration': 'restoration',
  'remove-curse': 'restoration',
  'purify-food-and-drink': 'restoration',
  'gentle-repose': 'restoration',
  revivify: 'restoration',
  'raise-dead': 'restoration',
  reincarnate: 'restoration',
  'spare-the-dying': 'restoration',
  invisibility: 'invisibility',
  'greater-invisibility': 'invisibility',
  fly: 'flight',
  levitate: 'flight',
  'feather-fall': 'flight',
  'wind-walk': 'flight',
  jump: 'mobility',
  longstrider: 'mobility',
  'expeditious-retreat': 'mobility',
  haste: 'mobility',
  'freedom-of-movement': 'mobility',
  'kinetic-jaunt': 'mobility',
  'ashardalon-s-stride': 'mobility',
  'tree-stride': 'mobility',
  'zephyr-strike': 'mobility',
  polymorph: 'transmutation',
  'enlarge-reduce': 'transmutation',
  'alter-self': 'transmutation',
  'shapechange': 'transmutation',
  'stone-skin': 'transmutation',
  message: 'communication',
  sending: 'communication',
  'magic-mouth': 'communication',
  'animal-messenger': 'communication',
  'speak-with-animals': 'communication',
  'speak-with-dead': 'communication',
  'speak-with-plants': 'communication',
  'comprehend-languages': 'communication',
  tongues: 'communication',
  'rary-s-telepathic-bond': 'communication',
  'magic-stone': 'transmutation',
  mending: 'restoration',
  'distort-value': 'enchantment',
  alarm: 'protection',
  'tenser-s-floating-disk': 'environment',
  'air-bubble': 'environment',
  'arcane-lock': 'protection',
  skywrite: 'communication',
  'spider-climb': 'mobility',
  'gift-of-gab': 'communication',
  'locate-animals-or-plants': 'divination',
  'find-traps': 'divination',
  'find-steed': 'summon',
  darkvision: 'divination',
  earthbind: 'control',
  'warp-sense': 'divination',
  'galder-s-tower': 'environment',
  'enemies-abound': 'enchantment',
  'leomund-s-tiny-hut': 'protection',
  nondetection: 'invisibility',
  'water-breathing': 'environment',
  'meld-into-stone': 'transmutation',
  'create-food-and-water': 'environment',
  'incite-greed': 'enchantment',
  'water-walk': 'mobility',
  'galder-s-speedy-courier': 'summon',
  'giant-insect': 'summon',
  'spirit-of-death': 'summon',
  'gate-seal': 'control',
  dream: 'enchantment',
  'antilife-shell': 'protection',
  'dispel-evil-and-good': 'restoration',
  passwall: 'environment',
  creation: 'transmutation',
  'soul-cage': 'necrotic',
  'planar-ally': 'summon',
  contingency: 'protection',
  'transport-via-plants': 'teleport',
  'druid-grove': 'environment',
  'create-homunculus': 'summon',
  'globe-of-invulnerability': 'protection',
  friends: 'enchantment',
  'animal-friendship': 'enchantment',
  'beast-bond': 'enchantment',
  'charm-person': 'enchantment',
  'fast-friends': 'enchantment',
  'modify-memory': 'enchantment',
  'calm-emotions': 'enchantment',
  'zone-of-truth': 'enchantment',
}

const SPELL_VISUAL_VARIANTS: Readonly<Record<string, SpellVisualVariant>> = {
  'mage-hand': 'spectral-hand',
  prestidigitation: 'minor-tricks',
  'borrowed-knowledge': 'borrowed-knowledge',
  'leomund-s-secret-chest': 'secret-chest',
  'creating-spelljamming-helm': 'spelljamming-helm',
  silence: 'silence',
  'counterspell': 'cancellation',
  'dispel-magic': 'cancellation',
  'dispel-evil-and-good': 'cancellation',
  'magic-jar': 'soul-transfer',
  longstrider: 'mobility-trail',
  jump: 'mobility-arc',
  haste: 'mobility-haste',
}

const SOUND_FAMILY_IDS: Readonly<Record<string, SpellSoundFamily>> = {
  'shape-water': 'water',
  'create-or-destroy-water': 'water',
  'wall-of-water': 'water',
  'water-breathing': 'water',
  'water-walk': 'water',
  'control-water': 'water',
  'watery-sphere': 'water',
  'create-food-and-water': 'water',
  'mold-earth': 'earth',
  'earth-tremor': 'earth',
  'maximilian-s-earthen-grasp': 'earth',
  'erupting-earth': 'earth',
  'move-earth': 'earth',
  'stone-shape': 'earth',
  'wall-of-stone': 'earth',
  'bones-of-the-earth': 'earth',
  'investiture-of-stone': 'earth',
  'gust-of-wind': 'wind',
  'air-bubble': 'wind',
  'fog-cloud': 'wind',
  'warding-wind': 'wind',
  'wind-wall': 'wind',
  'control-winds': 'wind',
  'investiture-of-wind': 'wind',
  'wind-walk': 'wind',
  'storm-sphere': 'wind',
  'dust-devil': 'wind',
  infestation: 'swarm',
  'insect-plague': 'swarm',
  'giant-insect': 'swarm',
}

const FAMILY_PALETTE_OVERRIDES: Readonly<Record<Exclude<SpellEffectFamily, 'school'>, Pick<SpellSchoolStyle, 'primary' | 'secondary' | 'fill' | 'behavior'>>> = {
  fire: { primary: '#e85b2f', secondary: '#ffd27a', fill: 'rgba(224,74,31,.28)', behavior: 'flash' },
  cold: { primary: '#82d5ec', secondary: '#e8fbff', fill: 'rgba(111,198,222,.2)', behavior: 'shimmer' },
  lightning: { primary: '#72d8ff', secondary: '#e9fbff', fill: 'rgba(75,174,222,.18)', behavior: 'shimmer' },
  thunder: { primary: '#b58cff', secondary: '#f0ddff', fill: 'rgba(116,80,176,.2)', behavior: 'wave' },
  acid: { primary: '#b6cf5c', secondary: '#e7f5a4', fill: 'rgba(127,153,43,.22)', behavior: 'morph' },
  poison: { primary: '#70b86e', secondary: '#c1e39b', fill: 'rgba(56,111,59,.24)', behavior: 'inward' },
  necrotic: { primary: '#876b9e', secondary: '#d0addc', fill: 'rgba(54,39,72,.3)', behavior: 'inward' },
  radiant: { primary: '#e8c36b', secondary: '#fff3bd', fill: 'rgba(219,171,68,.2)', behavior: 'focus' },
  force: { primary: '#8e9cff', secondary: '#d9ddff', fill: 'rgba(79,88,174,.2)', behavior: 'focus' },
  psychic: { primary: '#d68bc6', secondary: '#f4c4e9', fill: 'rgba(144,67,130,.2)', behavior: 'wave' },
  healing: { primary: '#75c993', secondary: '#d9f4c7', fill: 'rgba(99,190,123,.17)', behavior: 'focus' },
  protection: { primary: '#78a6d4', secondary: '#d5e8ff', fill: 'rgba(77,125,181,.18)', behavior: 'dome' },
  control: { primary: '#aa83bf', secondary: '#e5d1ef', fill: 'rgba(91,57,116,.2)', behavior: 'morph' },
  teleport: { primary: '#65c9bf', secondary: '#d2fff7', fill: 'rgba(45,145,137,.18)', behavior: 'shimmer' },
  summon: { primary: '#5caf91', secondary: '#cef2d5', fill: 'rgba(44,122,87,.2)', behavior: 'materialize' },
  earth: { primary: '#b48b58', secondary: '#ecd29e', fill: 'rgba(121,85,43,.22)', behavior: 'morph' },
  wind: { primary: '#8fb8c9', secondary: '#e9fbff', fill: 'rgba(92,143,161,.18)', behavior: 'wave' },
  water: { primary: '#4299b5', secondary: '#bceeff', fill: 'rgba(39,132,166,.2)', behavior: 'wave' },
  swarm: { primary: '#c8a642', secondary: '#f3e39f', fill: 'rgba(117,91,28,.23)', behavior: 'shimmer' },
  weapon: { primary: '#b4b8c4', secondary: '#f2dfb2', fill: 'rgba(91,97,111,.22)', behavior: 'flash' },
  illusion: { primary: '#9886cf', secondary: '#e2d9ff', fill: 'rgba(91,72,146,.18)', behavior: 'shimmer' },
  divination: { primary: '#6faeb4', secondary: '#d6f1ee', fill: 'rgba(56,119,123,.18)', behavior: 'focus' },
  light: { primary: '#e9c86c', secondary: '#fff5bd', fill: 'rgba(231,190,75,.2)', behavior: 'focus' },
  darkness: { primary: '#5b4b80', secondary: '#bca9df', fill: 'rgba(26,22,48,.3)', behavior: 'inward' },
  environment: { primary: '#6fa86c', secondary: '#c5e3a7', fill: 'rgba(58,111,62,.2)', behavior: 'morph' },
  enchantment: { primary: '#c77eb1', secondary: '#f1c7e2', fill: 'rgba(145,69,122,.18)', behavior: 'wave' },
  restoration: { primary: '#a8c978', secondary: '#e7f2bd', fill: 'rgba(119,159,68,.18)', behavior: 'focus' },
  invisibility: { primary: '#a7b7c8', secondary: '#edf6ff', fill: 'rgba(111,135,157,.14)', behavior: 'shimmer' },
  flight: { primary: '#8dc1d1', secondary: '#e8fbff', fill: 'rgba(86,155,174,.16)', behavior: 'wave' },
  mobility: { primary: '#c3a261', secondary: '#f7e3aa', fill: 'rgba(160,120,48,.18)', behavior: 'wave' },
  transmutation: { primary: '#b68a58', secondary: '#ead19b', fill: 'rgba(137,98,44,.2)', behavior: 'morph' },
  communication: { primary: '#7db4c5', secondary: '#d6f3ff', fill: 'rgba(70,131,151,.16)', behavior: 'wave' },
  utility: { primary: '#a6937b', secondary: '#e4d5bc', fill: 'rgba(104,84,61,.16)', behavior: 'focus' },
}

const SPELL_PALETTE_OVERRIDES: Readonly<Record<string, Partial<SpellEffectPalette>>> = {
  fireball: {
    primary: '#e85b2f',
    secondary: '#ffd27a',
    fill: 'rgba(224,74,31,.28)',
    behavior: 'flash',
  },
  'lightning-bolt': {
    primary: '#72d8ff',
    secondary: '#e9fbff',
    fill: 'rgba(75,174,222,.18)',
    behavior: 'shimmer',
  },
  'chain-lightning': {
    primary: '#5fc8ef',
    secondary: '#d7f7ff',
    fill: 'rgba(52,155,201,.18)',
    behavior: 'shimmer',
  },
  web: {
    primary: '#c9afc2',
    secondary: '#f2e6ef',
    fill: 'rgba(154,111,143,.18)',
    behavior: 'morph',
  },
}

const AURA_SPELLS: Record<string, number> = {
  'aura-of-life': 30,
  'aura-of-purity': 30,
  'aura-of-vitality': 30,
  'crusader-s-mantle': 30,
  'paladin-aura-of-protection': 10,
  'spirit-guardians': 15,
}

const CHANNEL_POINT_SPELLS = new Set([
  'guardian-of-faith',
  'conjure-elemental',
  'fizban-s-platinum-shield',
])

const PROTECTION_AREA_SPELLS = new Set(['magic-circle', 'hallow', 'mordenkainen-s-private-sanctum'])

const normalizeId = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase('en-US')

/** Вынимает id заклинания и из `web:<command>`, и из старого `spell:web`. */
export function spellIdFromEffect(value: unknown) {
  const effectId = normalizeId(value)
  const normalized = effectId.startsWith('spell:') ? effectId.slice('spell:'.length) : effectId
  return normalized.includes(':') ? normalized.slice(0, normalized.indexOf(':')) : normalized
}

export function normalizeMagicSchool(value: unknown): MagicSchool {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  return SCHOOL_ALIASES[normalized] ?? 'evocation'
}

function schoolFromDamageType(value: unknown): MagicSchool {
  const damageType = String(value ?? '').toLocaleLowerCase('ru')
  if (/necrot|некрот/u.test(damageType)) return 'necromancy'
  if (/psychic|псих/u.test(damageType)) return 'enchantment'
  if (/acid|poison|кисл|яд/u.test(damageType)) return 'conjuration'
  return 'evocation'
}

/**
 * Единый детерминированный профиль визуала. Каталог даёт школу всем известным
 * заклинаниям, а серверные override — исполняемую геометрию и количество целей.
 * Подсказки из события имеют приоритет, чтобы будущая версия протокола могла
 * передать профиль напрямую без замены этого API.
 */
export function spellVisualProfile(spellIdValue: unknown, hints: SpellProfileHints = {}): SpellVisualProfile {
  const spellId = normalizeId(spellIdValue)
  const catalog = SPELL_CATALOG.get(spellId)
  const presentHints = Object.fromEntries(
    Object.entries(hints).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as SpellProfileHints
  const spell = { ...(catalog ?? {}), ...presentHints }
  const school = spell.school
    ? normalizeMagicSchool(spell.school)
    : schoolFromDamageType(spell.damageType ?? spell.damageTypes?.[0])
  const radiusFeet = Math.max(0, Number(AURA_SPELLS[spellId] ?? spell.radius) || 0)
  const projectileCount = Math.max(1, Number(spell.projectileCount ?? spell.beams) || 1)

  const spellKind = normalizeId(spell.kind)
  const areaCapable = /^area-/u.test(spellKind)
    || spellKind === 'area-save'
    || spellKind === 'area-damage'
    || Boolean(spell.createsAreaEffect && spell.areaShape && spellKind !== 'buff')
  let kind: SpellVisualKind = 'channel'
  if (AURA_SPELLS[spellId] != null) kind = 'aura'
  else if (CHANNEL_POINT_SPELLS.has(spellId)) kind = 'channel'
  else if (PROTECTION_AREA_SPELLS.has(spellId) || areaCapable) kind = 'burst'
  else if (BEAM_SPELLS.has(spellId) || /beam|bolt-chain|lightning-lure/u.test(spellId)) kind = 'beam'
  else if (PROJECTILE_SPELLS.has(spellId) || spellKind === 'attack' || spellKind === 'damage') kind = 'projectile'
  else if (spellKind === 'summon' || spellKind === 'healing' || spellKind === 'buff' || spellKind === 'teleport') kind = 'channel'

  const family = spellEffectFamily(spellId, hints)
  const visualVariant = SPELL_VISUAL_VARIANTS[spellId]

  return {
    spellId,
    school,
    family,
    familyNote: spellFamilyNote(spellId, hints, family),
    soundFamily: soundFamilyFor(family, spellId),
    visualVariant,
    kind,
    requiresWeaponAttack: spell.requiresWeaponAttack === true,
    ...(spell.spreadsAroundCorners === true ? { spreadsAroundCorners: true } : {}),
    ...(spell.areaShape ? { areaShape: spell.areaShape } : {}),
    ...(spell.areaOrigin ? { areaOrigin: spell.areaOrigin } : {}),
    ...(Number(spell.areaSideFeet) > 0 ? { areaSideFeet: Number(spell.areaSideFeet) } : {}),
    ...(spell.areaShape && radiusFeet > 0 ? { sizeFeet: radiusFeet } : {}),
    ...(kind === 'aura' ? { radiusFeet: radiusFeet || 10 } : {}),
    ...(kind === 'projectile' ? { projectileCount } : {}),
    ...(kind === 'beam' ? { chain: spellId === 'chain-lightning' || Number(spell.maxTargets) > 1 } : {}),
  }
}

const HEALING_IDS = /(?:^|-)heal(?:ing)?|(?:^|-)cure|goodberry|healing-spirit|regenerate|power-word-heal/u
const RESTORATION_IDS = /restoration|remove-curse|purify-food|gentle-repose|revivify|raise-dead|reincarnate|spare-the-dying/u
const TELEPORT_IDS = /teleport|misty-step|dimension-door|thunder-step|far-step|vortex-warp|word-of-recall|blink|teleportation-circle/u
const SUMMON_IDS = /summon|conjure|familiar|servant|animate-dead|create-undead|infernal-calling|danse-macabre/u
const PROTECTION_IDS = /shield|ward|protection|sanctuary|bless|resistance|guidance|heroism|armor|armour|stoneskin|barkskin|invisibility|haste|aura|beacon|death-ward|absorb-elements|circle-of-power|magic-weapon|holy-weapon|elemental-weapon|warding-bond/u
const CONTROL_IDS = /web|entangle|grease|darkness|silence|hold-|hypnotic|fear|confusion|slow|command|banishment|bestow-curse|blindness|charm|dominate|stinking-cloud|plant-growth|spike-growth|wall-of-|forcecage|prismatic-wall|maze|telekinesis|counterspell|dispel-magic|ray-of-enfeeblement|silvery-barbs/u

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => normalizeId(entry)).filter(Boolean) : []
}

function spellEffectFamily(spellIdValue: unknown, hints: SpellProfileHints = {}): SpellEffectFamily {
  const spellId = normalizeId(spellIdValue)
  const catalog = SPELL_CATALOG.get(spellId)
  const spell = { ...(catalog ?? {}), ...hints } as Record<string, unknown>
  const kind = normalizeId(spell.kind)
  const conditions = textList(spell.conditions)
  const createsAreaEffect = spell.createsAreaEffect && typeof spell.createsAreaEffect === 'object'
    ? spell.createsAreaEffect as Record<string, unknown>
    : null
  const nextWeaponHit = spell.nextWeaponHit && typeof spell.nextWeaponHit === 'object'
    ? spell.nextWeaponHit as Record<string, unknown>
    : null
  const damageTypes = [
    hints.damageType,
    ...textList(hints.damageTypes),
    spell.damageType,
    ...textList(spell.damageTypes),
    nextWeaponHit?.damageType,
    createsAreaEffect?.damageType,
  ].map((value) => normalizeId(value))
  const damageFamily = damageTypes.map((damageType) => DAMAGE_FAMILIES[damageType]).find(Boolean)
  const hintedFamily = hints.visualFamily
  if (hintedFamily && hintedFamily !== 'school' && Object.hasOwn(FAMILY_PALETTE_OVERRIDES, hintedFamily)) return hintedFamily

  if (kind === 'healing' || (!damageFamily && (spell.healing != null || spell.healingAmount != null || HEALING_IDS.test(spellId)))) return 'healing'
  if (RESTORATION_IDS.test(spellId)) return 'restoration'
  if (SPELL_FAMILY_IDS[spellId]) return SPELL_FAMILY_IDS[spellId]
  if (kind === 'teleport' || TELEPORT_IDS.test(spellId)) return 'teleport'
  if (kind === 'summon' || SUMMON_IDS.test(spellId)) return 'summon'
  if (kind === 'buff') return damageFamily ?? 'protection'
  if (PROTECTION_IDS.test(spellId)) return damageFamily ?? 'protection'
  if (damageFamily) return damageFamily

  if (kind === 'debuff' || conditions.length || createsAreaEffect?.condition || CONTROL_IDS.test(spellId)) return 'control'
  return SPELL_CATALOG.has(spellId) ? 'utility' : 'school'
}

const FAMILY_NOTES: Readonly<Partial<Record<SpellEffectFamily, string>>> = {
  fire: 'Пламя и жар: вспышка, языки огня и горячий след.',
  cold: 'Холод и лёд: кристаллы, стылый след и ломкая вспышка.',
  lightning: 'Электричество: направленный импульс и резкие разряды.',
  thunder: 'Звук и ударная волна: короткий импульс с расширяющимся эхом.',
  acid: 'Кислота: капли и разъедающие лужицы.',
  poison: 'Яд: пузырьки, дым и медленно расползающийся след.',
  necrotic: 'Некротика: втягивающая тень и угасающий контур.',
  radiant: 'Излучение: световой импульс и звёздный рисунок.',
  force: 'Силовое поле: строгая геометрия и упругая отдача.',
  psychic: 'Психика: волна мысли и ломкий мерцающий контур.',
  healing: 'Лечение: мягкий восходящий поток и спокойное свечение.',
  protection: 'Защита и усиление: купол, щит или устойчивый внешний контур.',
  control: 'Контроль: решётка, удерживающий контур или связывающий знак.',
  teleport: 'Телепортация: портал отправления и портал прибытия.',
  summon: 'Призыв: материализация снизу вверх вокруг точки появления.',
  earth: 'Земля и камень: тяжёлые осколки и оседающая пыль.',
  wind: 'Ветер: спиральные потоки и смещающиеся дуги.',
  water: 'Вода: текучие волны и влажный круг.',
  swarm: 'Рой: множество мелких движущихся точек.',
  weapon: 'Оружейная магия: лезвия, клинья и резкие штрихи.',
  illusion: 'Иллюзия: мерцание, двойник или неполный силуэт.',
  divination: 'Прорицание: фокус, глаз и расходящиеся сигнальные кольца.',
  light: 'Свет: устойчивое сияние с тёплым центром.',
  darkness: 'Тьма: втягивающее затемнение с холодной кромкой.',
  environment: 'Окружение: изменение материала, воздуха, воды или рельефа клетки.',
  enchantment: 'Очарование: мягкая волна, направленная на внимание и волю.',
  restoration: 'Восстановление: снятие повреждения или вредного состояния.',
  invisibility: 'Невидимость: растворение силуэта и лёгкий остаточный контур.',
  flight: 'Полёт и высота: восходящая дуга и разреженный след.',
  mobility: 'Мобильность: ускорение, прыжок или свободное движение.',
  transmutation: 'Преобразование: морфинг формы и смена материала.',
  communication: 'Связь: направленный шёпот, знак или световой сигнал.',
  utility: 'Утилитарный эффект: отдельная смысловая операция без боевого паттерна.',
  school: 'Неизвестный идентификатор: используется школьная палитра как запасной вариант.',
}

const VARIANT_NOTES: Readonly<Record<SpellVisualVariant, string>> = {
  'spectral-hand': 'Призрачная рука: контур ладони и короткий след движения.',
  'minor-tricks': 'Мелкие фокусы: четыре искры и короткий знак изменения.',
  'borrowed-knowledge': 'Заимствованное знание: раскрывающаяся книга и световая метка.',
  'secret-chest': 'Тайный сундук: контур крышки и исчезающий замок.',
  'spelljamming-helm': 'Руль spelljamming: парящая штурвальная форма и сигнальное кольцо.',
  silence: 'Тишина: глухой сжимающийся контур без взрывного акцента.',
  cancellation: 'Отмена магии: короткий знак прерывания без урона и взрыва.',
  'soul-transfer': 'Перенос души: замкнутый контур связи тела и сосуда.',
  'mobility-trail': 'Скороход: короткий след шагов у ног.',
  'mobility-arc': 'Прыжок: читаемая дуга подъёма.',
  'mobility-haste': 'Ускорение: несколько тактов быстрого шлейфа.',
}

function spellFamilyNote(spellIdValue: unknown, hints: SpellProfileHints, family: SpellEffectFamily) {
  const spellId = normalizeId(spellIdValue)
  const spell = { ...(SPELL_CATALOG.get(spellId) ?? {}), ...hints } as Record<string, unknown>
  const variant = SPELL_VISUAL_VARIANTS[spellId]
  if (variant) return VARIANT_NOTES[variant]
  if (spellId === 'forbiddance') {
    return 'Запрет: иллюстративный защитный знак в точке; авторитетный footprint и радиус сервер не передал.'
  }
  if (family !== 'utility') return FAMILY_NOTES[family] ?? 'Семантическая визуальная семья.'
  const description = String(spell.description ?? '').replace(/\s+/gu, ' ').trim()
  const detail = description ? ` ${description.slice(0, 150)}${description.length > 150 ? '…' : ''}` : ''
  return `${FAMILY_NOTES.utility}${detail}`
}

function soundFamilyFor(family: SpellEffectFamily, spellId = ''): SpellSoundFamily | undefined {
  if (family === 'school') return undefined
  if (SOUND_FAMILY_IDS[spellId]) return SOUND_FAMILY_IDS[spellId]
  if (spellId === 'silence') return 'silence'
  if (spellId === 'counterspell' || spellId === 'dispel-magic') return 'control'
  if (spellId === 'magic-jar') return 'necrotic'
  if (family === 'fire') return 'flame'
  if (family === 'cold') return 'frost'
  if (family === 'lightning') return 'electric'
  if (family === 'protection') return 'ward'
  return family
}

/**
 * Цвет и характер эффекта для предпросмотра и самой реплики. Школа остаётся
 * запасным тоном, но смысловая семья задаёт материал и рисунок: огонь,
 * молния, лёд, контроль и лечение не сливаются в один цвет.
 */
export function spellEffectPalette(spellIdValue: unknown, hints: SpellProfileHints = {}): SpellEffectPalette {
  const profile = spellVisualProfile(spellIdValue, hints)
  const base = SPELL_SCHOOL_STYLES[profile.school]
  const id = profile.spellId
  const family = spellEffectFamily(id, hints)
  const familyStyle = family === 'school' ? undefined : FAMILY_PALETTE_OVERRIDES[family]
  const semantic = SPELL_PALETTE_OVERRIDES[id]
  return {
    school: profile.school,
    family,
    familyNote: profile.familyNote,
    soundFamily: profile.soundFamily,
    visualVariant: profile.visualVariant,
    behavior: semantic?.behavior ?? familyStyle?.behavior ?? base.behavior,
    primary: semantic?.primary ?? familyStyle?.primary ?? base.primary,
    secondary: semantic?.secondary ?? familyStyle?.secondary ?? base.secondary,
    fill: semantic?.fill ?? familyStyle?.fill ?? base.fill,
  }
}

export type SpellVisualAuditEntry = {
  id: string
  level: number
  school: MagicSchool
  family: SpellEffectFamily
  kind: SpellVisualKind
  soundFamily: SpellSoundFamily
  visualVariant?: SpellVisualVariant
  note: string
  mechanicsSupport: 'verified' | 'partial' | 'heuristic' | 'ruling-only'
}

/** Машиночитаемый обзор всех карточек каталога, включая неподдержанные. */
export function spellVisualAudit(): SpellVisualAuditEntry[] {
  return catalogSpells.map((spell) => {
    const override = overrideSpells[spell.id]
    const profile = spellVisualProfile(spell.id)
    if (!profile.familyNote || !profile.soundFamily) throw new Error(`Нет audit metadata для ${spell.id}`)
    return {
      id: spell.id,
      level: Math.max(0, Number(spell.level) || 0),
      school: profile.school,
      family: profile.family,
      kind: profile.kind,
      soundFamily: profile.soundFamily,
      visualVariant: profile.visualVariant,
      note: profile.familyNote,
      mechanicsSupport: override?.mechanicsSupport ?? (override ? 'partial' : 'heuristic'),
    }
  })
}

export const SPELL_EFFECT_FRAME_BUDGET_MS = 1_000 / 60

export function systemPrefersReducedMotion() {
  return typeof globalThis.matchMedia === 'function'
    && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function spellEffectDetailForFrame(
  frameDurationMs: number,
  reducedMotion = systemPrefersReducedMotion(),
): SpellEffectDetail {
  if (reducedMotion) return 'minimal'
  const duration = Math.max(0, Number(frameDurationMs) || 0)
  if (duration > SPELL_EFFECT_FRAME_BUDGET_MS * 1.7) return 'minimal'
  if (duration > SPELL_EFFECT_FRAME_BUDGET_MS * 1.08) return 'reduced'
  return 'full'
}

/**
 * Деградирует немедленно, восстанавливает детализацию только после серии
 * быстрых кадров. Гистерезис не даёт эффекту дёргаться между режимами.
 */
export function createSpellEffectBudgetController(options: {
  frameBudgetMs?: number
  recoveryFrames?: number
  reducedMotion?: boolean
} = {}) {
  const frameBudgetMs = Math.max(1, Number(options.frameBudgetMs) || SPELL_EFFECT_FRAME_BUDGET_MS)
  const recoveryFrames = Math.max(1, Math.floor(Number(options.recoveryFrames) || 10))
  const reducedMotion = options.reducedMotion ?? systemPrefersReducedMotion()
  let detail: SpellEffectDetail = reducedMotion ? 'minimal' : 'full'
  let healthyFrames = 0

  return {
    get detail() {
      return detail
    },
    recordFrame(frameDurationMs: number) {
      const next = spellEffectDetailForFrame(
        Math.max(0, Number(frameDurationMs) || 0) * SPELL_EFFECT_FRAME_BUDGET_MS / frameBudgetMs,
        reducedMotion,
      )
      if (next === 'minimal' || next === 'reduced' && detail === 'full') {
        detail = next
        healthyFrames = 0
        return detail
      }
      if (next !== 'full' || detail === 'full') {
        healthyFrames = next === 'full' ? healthyFrames + 1 : 0
        return detail
      }
      healthyFrames += 1
      if (healthyFrames >= recoveryFrames) {
        detail = detail === 'minimal' ? 'reduced' : 'full'
        healthyFrames = 0
      }
      return detail
    },
  }
}

export type SpellEffectActor = BoardPoint & {
  id: string
  /** Серверная площадь существа; x/y остаются верхним левым якорем. */
  footprint?: ActorFootprint
}

export type SpellEffectRenderInput = {
  cue: SpellAnimationCue
  /** Нормализованное время текущей реплики, от 0 до 1. */
  progress: number
  actors: readonly SpellEffectActor[]
  detail?: SpellEffectDetail
  frameDurationMs?: number
  reducedMotion?: boolean
}

export type PersistentSpellEffect =
  | {
      id: string
      kind: 'area'
      actorId?: string
      spellId: string
      school?: MagicSchool
      center?: BoardPoint
      cells?: BoardPoint[]
      shape: AreaShape
      originMode?: 'self' | 'point'
      sizeFeet: number
      areaSideFeet?: number
    }
  | {
      id: string
      kind: 'aura'
      actorId: string
      spellId: string
      school?: MagicSchool
      radiusFeet: number
    }
  | {
      id: string
      kind: 'concentration'
      actorId: string
      spellId?: string
      school?: MagicSchool
    }

type ProjectedSpellArea = {
  id: string
  effect_id?: string
  spell_id?: string
  source_actor?: string
  center?: BoardPoint
  cells?: BoardPoint[]
  radius_feet?: number
  area_shape?: string
  area_side_feet?: number
}

type ProjectedConcentration = Record<string, { effect_id?: string } | undefined>

function projectedAreaShape(value: unknown): AreaShape | undefined {
  return value === 'cylinder' || value === 'cone' || value === 'cube' || value === 'line'
    ? value
    : value === 'sphere' ? value : undefined
}

/**
 * Переводит текущую авторитетную проекцию в постоянный слой доски. Одноразовый
 * `SpellAreaCreated` остаётся в очереди, а эта модель переживает reconnect.
 */
export function persistentSpellEffectsFromProjection(
  activeEffects: readonly ProjectedSpellArea[],
  concentration: ProjectedConcentration,
): PersistentSpellEffect[] {
  const result: PersistentSpellEffect[] = []
  const effectsById = new Map(activeEffects.map((effect) => [String(effect.effect_id ?? effect.id), effect]))
  for (const effect of activeEffects) {
    const spellId = normalizeId(effect.spell_id ?? spellIdFromEffect(effect.effect_id ?? effect.id))
    if (!spellId) continue
    const projectedShape = projectedAreaShape(effect.area_shape)
    const profile = spellVisualProfile(spellId, {
      areaShape: projectedShape,
      radius: Math.max(0, Number(effect.radius_feet) || 0),
      areaSideFeet: Number(effect.area_side_feet) || undefined,
    })
    if (profile.kind === 'aura' && effect.source_actor) {
      result.push({
        id: `persistent:aura:${effect.id}`,
        kind: 'aura',
        actorId: effect.source_actor,
        spellId,
        school: profile.school,
        radiusFeet: Math.max(5, Number(effect.radius_feet) || profile.radiusFeet || 5),
      })
      continue
    }
    if (effect.center || effect.cells?.length) {
      result.push({
        id: `persistent:area:${effect.id}`,
        kind: 'area',
        actorId: effect.source_actor,
        spellId,
        school: profile.school,
        center: effect.center,
        cells: effect.cells,
        shape: projectedShape ?? profile.areaShape ?? 'sphere',
        originMode: profile.areaOrigin,
        sizeFeet: Math.max(5, Number(effect.radius_feet) || profile.sizeFeet || 5),
        ...(Number(effect.area_side_feet) > 0 || profile.areaSideFeet ? { areaSideFeet: Number(effect.area_side_feet) || profile.areaSideFeet } : {}),
      })
    }
  }
  for (const [actorId, focus] of Object.entries(concentration)) {
    const effectId = String(focus?.effect_id ?? '')
    const activeEffect = effectsById.get(effectId)
    const spellId = normalizeId(activeEffect?.spell_id ?? spellIdFromEffect(effectId))
    if (!actorId || !spellId) continue
    result.push({
      id: `persistent:concentration:${actorId}:${effectId}`,
      kind: 'concentration',
      actorId,
      spellId,
    })
  }
  return result
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number(value) || 0))
const pointKey = (value: BoardPoint) => `${value.x},${value.y}`

function actorPoint(actors: readonly SpellEffectActor[], actorId: string | undefined) {
  return actorId ? actors.find((actor) => actor.id === actorId) ?? null : null
}

function pointCenter(
  point: BoardPoint,
  cellSize: number,
  scene?: BoardScene,
  actor?: SpellEffectActor | null,
) {
  const center = actor && scene
    ? actorPresentationCenter(scene.map, actor, { x: point.x, y: point.y })
    : { x: point.x + .5, y: point.y + .5 }
  return { x: center.x * cellSize, y: center.y * cellSize }
}

function visiblePoint(scene: BoardScene, point: BoardPoint | null | undefined): point is BoardPoint {
  return Boolean(point && revealedAt(scene.map, Math.floor(point.x), Math.floor(point.y)))
}

function trajectoryVisible(
  scene: BoardScene,
  from: BoardPoint,
  to: BoardPoint,
  fromActor?: SpellEffectActor | null,
  toActor?: SpellEffectActor | null,
) {
  const start = pointCenter(from, 1, scene, fromActor)
  const finish = pointCenter(to, 1, scene, toActor)
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))))
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps
    const x = start.x + (finish.x - start.x) * progress
    const y = start.y + (finish.y - start.y) * progress
    if (!revealedAt(scene.map, Math.floor(x), Math.floor(y))) return false
  }
  return true
}

function envelope(style: SpellSchoolStyle, progress: number) {
  const t = clamp01(progress)
  if (style.behavior === 'flash') return { alpha: Math.max(0, 1 - t * t), phase: Math.min(1, t * 1.55) }
  if (style.behavior === 'inward') return { alpha: Math.sin(Math.PI * t), phase: 1 - t }
  if (style.behavior === 'wave') return { alpha: Math.sin(Math.PI * t), phase: .5 - Math.cos(Math.PI * t) / 2 }
  if (style.behavior === 'materialize') return { alpha: Math.min(1, t * 3) * Math.max(0, 1 - Math.max(0, t - .82) / .18), phase: t }
  if (style.behavior === 'morph') return { alpha: Math.sin(Math.PI * t), phase: .5 + Math.sin(t * Math.PI * 2) * .12 }
  if (style.behavior === 'shimmer') return { alpha: Math.sin(Math.PI * t) * (.72 + Math.sin(t * Math.PI * 6) * .18), phase: t }
  if (style.behavior === 'focus') return { alpha: Math.sin(Math.PI * t), phase: 1 - Math.abs(t * 2 - 1) * .45 }
  return { alpha: Math.sin(Math.PI * t), phase: t }
}

function detailRank(detail: SpellEffectDetail) {
  return detail === 'full' ? 2 : detail === 'reduced' ? 1 : 0
}

function cueDetail(input: SpellEffectRenderInput): SpellEffectDetail {
  const reducedMotion = input.reducedMotion ?? (input.cue.motion === 'reduced' || systemPrefersReducedMotion())
  if (reducedMotion) return 'minimal'
  const frameDetail = spellEffectDetailForFrame(input.frameDurationMs ?? 0, false)
  const declared = input.detail ?? input.cue.detail ?? 'full'
  return detailRank(frameDetail) < detailRank(declared) ? frameDetail : declared
}

function spellStyle(cue: SpellAnimationCue): SpellEffectStyle {
  const hints = {
    school: cue.school,
    ...('damageType' in cue && cue.damageType ? { damageType: cue.damageType } : {}),
    ...(cue.kind === 'channel' && cue.channelType === 'healing' ? { kind: 'healing' } : {}),
    ...(cue.visualFamily ? { visualFamily: cue.visualFamily } : {}),
  }
  const palette = spellEffectPalette(cue.spellId, hints)
  return { ...SPELL_SCHOOL_STYLES[palette.school], ...palette }
}

function drawRing(
  context: BoardContext2D,
  center: { x: number; y: number },
  radius: number,
  color: string,
  alpha: number,
  width: number,
  dash: number[] = [],
) {
  context.save()
  context.globalAlpha = clamp01(alpha)
  context.strokeStyle = color
  context.lineWidth = width
  context.setLineDash(dash)
  context.beginPath()
  context.arc(center.x, center.y, Math.max(1, radius), 0, Math.PI * 2)
  context.stroke()
  context.restore()
}

function targetOutcomeIsMiss(cue: SpellAnimationCue, targetId: string | undefined) {
  if (!targetId) return false
  const outcome = cue.targetOutcomes?.[targetId]
  return outcome === 'miss' || outcome === 'blocked'
}

function projectileEndpoints(cue: Extract<SpellAnimationCue, { kind: 'projectile' }>, actors: readonly SpellEffectActor[]) {
  const fromActor = actorPoint(actors, cue.actorId)
  const from = cue.from ?? actorPoint(actors, cue.actorId)
  const targetId = cue.targetIds[0]
  const toActor = actorPoint(actors, targetId)
  const to = cue.to ?? actorPoint(actors, targetId)
  return { from, to, fromActor, toActor }
}

function drawFireballFlight(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
  progress: number,
) {
  const projectileCue: Extract<SpellAnimationCue, { kind: 'projectile' }> = {
    id: `${cue.id}:flight`,
    kind: 'projectile',
    actorId: cue.actorId,
    targetIds: cue.targetIds,
    from: cue.origin,
    to: cue.center,
    projectileCount: 1,
    spellId: cue.spellId,
    school: cue.school,
    durationMs: cue.durationMs,
    motion: cue.motion,
    detail: cue.detail,
  }
  drawProjectile(context, scene, projectileCue, { ...input, cue: projectileCue, progress }, detail)
}

function drawProjectile(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'projectile' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const { from, to, fromActor, toActor } = projectileEndpoints(cue, input.actors)
  if (!visiblePoint(scene, from) || !visiblePoint(scene, to) || !trajectoryVisible(scene, from, to, fromActor, toActor)) return
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? 1 : clamp01(input.progress)
  if (targetOutcomeIsMiss(cue, cue.targetIds[0]) && (detail === 'minimal' || progress >= 1)) return
  const start = pointCenter(from, scene.cellSize, scene, fromActor)
  const end = pointCenter(to, scene.cellSize, scene, toActor)
  if (detail === 'minimal') {
    drawRing(context, end, scene.cellSize * .28, style.primary, .78, Math.max(2, scene.cellSize * .055))
    return
  }
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const count = Math.min(detail === 'full' ? 5 : 2, Math.max(1, cue.projectileCount))
  const steps = detail === 'full' ? 10 : 5
  for (let projectile = 0; projectile < count; projectile += 1) {
    const volleyProgress = clamp01(progress - projectile * .035)
    const spread = (projectile - (count - 1) / 2) * scene.cellSize * .22
    const control = {
      x: (start.x + end.x) / 2 - dy / length * (Math.min(scene.cellSize * 1.2, length * .16) + spread),
      y: (start.y + end.y) / 2 + dx / length * (Math.min(scene.cellSize * 1.2, length * .16) + spread),
    }
    const at = (t: number) => ({
      x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
      y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
    })
    const head = at(volleyProgress)
    const tailStart = Math.max(0, volleyProgress - (detail === 'full' ? .28 : .16))
    context.save()
    context.globalAlpha = .86
    context.strokeStyle = style.secondary
    context.lineWidth = Math.max(2, scene.cellSize * (detail === 'full' ? .08 : .055))
    context.beginPath()
    for (let index = 0; index <= steps; index += 1) {
      const pathPoint = at(tailStart + (volleyProgress - tailStart) * index / steps)
      if (index === 0) context.moveTo(pathPoint.x, pathPoint.y)
      else context.lineTo(pathPoint.x, pathPoint.y)
    }
    context.stroke()
    context.fillStyle = style.primary
    context.beginPath()
    const headRadius = Math.max(3, scene.cellSize * .11)
    if (style.family === 'cold') {
      context.moveTo(head.x, head.y - headRadius * 1.35)
      context.lineTo(head.x + headRadius, head.y)
      context.lineTo(head.x, head.y + headRadius * 1.35)
      context.lineTo(head.x - headRadius, head.y)
      context.closePath()
      context.fill()
      context.strokeStyle = style.secondary
      context.stroke()
    } else {
      context.arc(head.x, head.y, headRadius, 0, Math.PI * 2)
      context.fill()
      drawFamilyGlyph(context, head, headRadius * 2, style, detail)
    }
    context.restore()
  }
}

export function spellBurstCells(
  map: TacticalMap,
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
  options: { includeHidden?: boolean } = {},
) {
  const visible = (cell: BoardPoint) => revealedAt(map, Math.floor(cell.x), Math.floor(cell.y))
  const includeHidden = options.includeHidden === true
  if (cue.cells?.length) return includeHidden ? [...cue.cells] : cue.cells.filter(visible)
  const actor = actorPoint(actors, cue.actorId)
  const targets = cue.targetIds.map((targetId) => actorPoint(actors, targetId)).filter((target): target is SpellEffectActor => Boolean(target))
  const firstTarget = targets[0]
  const center = cue.center ?? (cue.shape === 'line'
    ? targets.reduce((farthest, target) => {
      if (!farthest) return target
      const currentDistance = actor ? Math.hypot(target.x - actor.x, target.y - actor.y) : 0
      const farthestDistance = actor ? Math.hypot(farthest.x - actor.x, farthest.y - actor.y) : 0
      return currentDistance > farthestDistance ? target : farthest
    }, firstTarget)
    : firstTarget)
  const origin = cue.origin ?? actor
  if (!center || !origin) return []
  const profile = spellVisualProfile(cue.spellId, {
    areaShape: cue.shape,
    areaOrigin: cue.originMode,
    radius: cue.sizeFeet,
    areaSideFeet: cue.areaSideFeet,
    damageType: cue.damageType,
  })
  const originMode = cue.originMode ?? profile.areaOrigin
  const geometry = {
    shape: cue.shape,
    origin,
    target: center,
    originMode,
    sizeFeet: cue.sizeFeet,
    ...(profile.areaSideFeet ? { sideFeet: profile.areaSideFeet } : {}),
    bounds: { minX: 0, minY: 0, maxX: map.width - 1, maxY: map.height - 1 },
  }
  const cells = actor ? areaCellsForActor(geometry, actor, map) : areaCells(geometry)
  const origins = originMode === 'self'
    ? actor ? actorFootprintCells(actor) : origin ? [origin] : []
    : center ? [center] : []
  const masked = maskSpellAreaCells(map, cells, {
    origins,
    spreadsAroundCorners: profile.spreadsAroundCorners === true,
    radiusFeet: cue.sizeFeet,
  })
  const lineOfEffectCells = cells.filter((cell) => masked.has(`${cell.x},${cell.y}`))
  return includeHidden ? lineOfEffectCells : lineOfEffectCells.filter(visible)
}

function evenlySample<T>(values: readonly T[], maximum: number) {
  if (values.length <= maximum) return [...values]
  const sampled: T[] = []
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(values[Math.floor(index * values.length / maximum)])
  }
  return sampled
}

function drawFamilyGlyph(
  context: BoardContext2D,
  center: { x: number; y: number },
  size: number,
  style: SpellEffectStyle,
  detail: SpellEffectDetail,
) {
  const radius = size * (detail === 'full' ? .2 : .15)
  const family = style.family
  if (detail === 'minimal' || family === 'school' || family === 'cold') return
  context.save()
  context.globalAlpha *= detail === 'full' ? .7 : .52
  context.strokeStyle = style.secondary
  context.fillStyle = style.secondary
  context.lineWidth = Math.max(1, size * .025)
  context.beginPath()
  if (style.visualVariant === 'cancellation') {
    context.arc(center.x, center.y, radius * .82, 0, Math.PI * 2)
    context.moveTo(center.x - radius * .62, center.y + radius * .62)
    context.lineTo(center.x + radius * .62, center.y - radius * .62)
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'spectral-hand') {
    context.moveTo(center.x - radius * .55, center.y + radius)
    context.lineTo(center.x - radius * .55, center.y - radius * .2)
    context.lineTo(center.x - radius * .35, center.y - radius * 1.2)
    context.lineTo(center.x - radius * .1, center.y - radius * .15)
    context.lineTo(center.x + radius * .1, center.y - radius * 1.45)
    context.lineTo(center.x + radius * .32, center.y - radius * .1)
    context.lineTo(center.x + radius * .7, center.y - radius * .9)
    context.lineTo(center.x + radius * .85, center.y + radius * .1)
    context.lineTo(center.x + radius * .25, center.y + radius)
    context.closePath()
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'silence') {
    context.arc(center.x, center.y, radius * .8, 0, Math.PI * 2)
    context.moveTo(center.x - radius * .95, center.y - radius * .95)
    context.lineTo(center.x + radius * .95, center.y + radius * .95)
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'minor-tricks') {
    for (let index = 0; index < 4; index += 1) {
      const angle = index * Math.PI / 2 + Math.PI / 4
      const x = center.x + Math.cos(angle) * radius * .75
      const y = center.y + Math.sin(angle) * radius * .75
      context.moveTo(x - radius * .18, y)
      context.lineTo(x + radius * .18, y)
      context.moveTo(x, y - radius * .18)
      context.lineTo(x, y + radius * .18)
    }
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'borrowed-knowledge' || style.visualVariant === 'secret-chest') {
    const chest = style.visualVariant === 'secret-chest'
    context.moveTo(center.x - radius, center.y - radius * .45)
    context.lineTo(center.x + radius, center.y - radius * .45)
    context.lineTo(center.x + radius, center.y + radius)
    context.lineTo(center.x - radius, center.y + radius)
    context.closePath()
    context.moveTo(center.x - radius, center.y - radius * .45)
    context.lineTo(center.x, center.y - radius * 1.05)
    context.lineTo(center.x + radius, center.y - radius * .45)
    if (!chest) {
      context.moveTo(center.x, center.y - radius * .35)
      context.lineTo(center.x, center.y + radius * .72)
    }
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'spelljamming-helm') {
    context.arc(center.x, center.y, radius, Math.PI, Math.PI * 2)
    context.moveTo(center.x - radius, center.y)
    context.lineTo(center.x + radius, center.y)
    context.moveTo(center.x, center.y)
    context.lineTo(center.x, center.y + radius * 1.2)
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'mobility-trail') {
    context.globalAlpha = Math.min(1, context.globalAlpha * 1.35)
    for (let index = 0; index < 4; index += 1) {
      const offset = (index % 2 ? 1 : -1) * radius * .35
      const y = center.y + radius * (1.35 - index * .55)
      context.moveTo(center.x + offset + radius * .23, y)
      context.arc(center.x + offset, y, radius * .23, 0, Math.PI * 2)
    }
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'mobility-arc') {
    context.arc(center.x, center.y + radius * .42, radius * 1.04, Math.PI * 1.16, Math.PI * 1.84)
    context.moveTo(center.x + radius * .72, center.y - radius * .18)
    context.lineTo(center.x + radius * 1.02, center.y - radius * .02)
    context.lineTo(center.x + radius * .76, center.y + radius * .18)
    context.stroke()
    context.restore()
    return
  }
  if (style.visualVariant === 'mobility-haste') {
    for (let index = 0; index < 3; index += 1) {
      const y = center.y + (index - 1) * radius * .48
      const start = center.x - radius * (.92 - index * .12)
      context.moveTo(start, y)
      context.lineTo(start + radius * 1.12, y - radius * .16)
    }
    context.stroke()
    context.restore()
    return
  }
  context.beginPath()
  if (family === 'fire') {
    context.moveTo(center.x, center.y - radius * 1.5)
    context.lineTo(center.x + radius, center.y + radius * .9)
    context.lineTo(center.x, center.y + radius * .45)
    context.lineTo(center.x - radius, center.y + radius * .9)
    context.closePath()
    context.fill()
  } else if (family === 'acid' || family === 'poison') {
    context.arc(center.x - radius * .35, center.y, radius * .55, 0, Math.PI * 2)
    context.stroke()
    context.beginPath()
    context.arc(center.x + radius * .65, center.y - radius * .55, radius * .28, 0, Math.PI * 2)
    context.stroke()
  } else if (family === 'radiant' || family === 'healing') {
    context.moveTo(center.x, center.y - radius * 1.5)
    context.lineTo(center.x + radius * .45, center.y - radius * .45)
    context.lineTo(center.x + radius * 1.5, center.y)
    context.lineTo(center.x + radius * .45, center.y + radius * .45)
    context.lineTo(center.x, center.y + radius * 1.5)
    context.lineTo(center.x - radius * .45, center.y + radius * .45)
    context.lineTo(center.x - radius * 1.5, center.y)
    context.lineTo(center.x - radius * .45, center.y - radius * .45)
    context.closePath()
    context.stroke()
  } else if (family === 'force' || family === 'protection') {
    for (let index = 0; index < 6; index += 1) {
      const angle = index * Math.PI / 3 - Math.PI / 6
      const x = center.x + Math.cos(angle) * radius
      const y = center.y + Math.sin(angle) * radius
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.closePath()
    context.stroke()
  } else if (family === 'necrotic') {
    context.moveTo(center.x - radius, center.y - radius)
    context.lineTo(center.x + radius, center.y - radius)
    context.lineTo(center.x + radius, center.y + radius)
    context.lineTo(center.x - radius * .25, center.y + radius)
    context.lineTo(center.x - radius * .25, center.y - radius * .25)
    context.stroke()
  } else if (family === 'psychic') {
    context.moveTo(center.x - radius * 1.2, center.y)
    context.lineTo(center.x - radius * .4, center.y - radius * .65)
    context.lineTo(center.x + radius * .4, center.y + radius * .65)
    context.lineTo(center.x + radius * 1.2, center.y)
    context.stroke()
  } else if (family === 'thunder' || family === 'lightning') {
    context.moveTo(center.x - radius, center.y)
    context.lineTo(center.x - radius * .25, center.y)
    context.lineTo(center.x - radius * .05, center.y - radius)
    context.lineTo(center.x + radius * .2, center.y + radius)
    context.lineTo(center.x + radius * .4, center.y)
    context.lineTo(center.x + radius, center.y)
    context.stroke()
  } else if (family === 'control') {
    context.moveTo(center.x - radius, center.y - radius)
    context.lineTo(center.x + radius, center.y - radius)
    context.lineTo(center.x + radius, center.y + radius)
    context.lineTo(center.x - radius, center.y + radius)
    context.closePath()
    context.moveTo(center.x - radius * .55, center.y)
    context.lineTo(center.x + radius * .55, center.y)
    context.stroke()
  } else if (family === 'teleport' || family === 'summon') {
    context.arc(center.x, center.y, radius, 0, Math.PI * 2)
    context.stroke()
    context.moveTo(center.x, center.y - radius * .8)
    context.lineTo(center.x, center.y + radius * .8)
    context.stroke()
  } else if (family === 'earth') {
    context.moveTo(center.x - radius, center.y + radius * .7)
    context.lineTo(center.x - radius * .65, center.y - radius * .65)
    context.lineTo(center.x + radius * .2, center.y - radius)
    context.lineTo(center.x + radius, center.y + radius * .55)
    context.closePath()
    context.fill()
  } else if (family === 'wind' || family === 'water') {
    context.arc(center.x - radius * .25, center.y, radius * .8, Math.PI * .15, Math.PI * 1.35)
    context.arc(center.x + radius * .25, center.y, radius * .8, -Math.PI * .35, Math.PI * .85)
    context.stroke()
  } else if (family === 'mobility') {
    // Ускорение и прыжок читаются как направленное движение, а не как щит.
    context.moveTo(center.x - radius * 1.05, center.y + radius * .62)
    context.lineTo(center.x, center.y - radius * .82)
    context.lineTo(center.x + radius * 1.05, center.y + radius * .62)
    context.moveTo(center.x, center.y - radius * .82)
    context.lineTo(center.x, center.y + radius * 1.12)
    context.stroke()
  } else if (family === 'swarm') {
    for (let index = 0; index < 3; index += 1) {
      context.arc(center.x + (index - 1) * radius * .65, center.y + (index % 2 ? -1 : 1) * radius * .35, radius * .2, 0, Math.PI * 2)
      context.fill()
    }
  } else if (family === 'weapon') {
    context.moveTo(center.x - radius * .25, center.y - radius * 1.4)
    context.lineTo(center.x + radius * .25, center.y - radius * 1.4)
    context.lineTo(center.x + radius * .5, center.y + radius * .9)
    context.lineTo(center.x, center.y + radius * 1.4)
    context.lineTo(center.x - radius * .5, center.y + radius * .9)
    context.closePath()
    context.stroke()
  }
  context.restore()
}

function drawWebBurst(
  context: BoardContext2D,
  scene: BoardScene,
  cells: readonly BoardPoint[],
  style: SpellEffectStyle,
  progress: number,
  detail: SpellEffectDetail,
) {
  const size = scene.cellSize
  const inset = detail === 'minimal' ? size * .16 : size * (.1 + (1 - progress) * .06)
  const side = Math.max(2, size - inset * 2)
  const occupied = new Set(cells.map(pointKey))
  context.save()
  context.globalAlpha = detail === 'minimal' ? .68 : Math.max(.22, Math.sin(Math.PI * clamp01(progress)) * .9)
  context.fillStyle = style.fill
  context.strokeStyle = style.primary
  context.lineWidth = Math.max(1, size * (detail === 'full' ? .035 : .028))
  for (const cell of evenlySample(cells, detail === 'full' ? 96 : detail === 'reduced' ? 48 : 24)) {
    const left = cell.x * size + inset
    const top = cell.y * size + inset
    const centerX = cell.x * size + size / 2
    const centerY = cell.y * size + size / 2
    if (detail !== 'minimal') context.fillRect(left, top, side, side)
    context.strokeRect(left, top, side, side)
    context.beginPath()
    context.moveTo(left, top)
    context.lineTo(left + side, top + side)
    context.moveTo(left + side, top)
    context.lineTo(left, top + side)
    if (detail !== 'minimal') {
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (!occupied.has(`${cell.x + dx},${cell.y + dy}`)) continue
        context.moveTo(centerX, centerY)
        context.lineTo(centerX + dx * size, centerY + dy * size)
      }
    }
    context.stroke()
  }
  context.restore()
}

function drawColdBurst(
  context: BoardContext2D,
  scene: BoardScene,
  cells: readonly BoardPoint[],
  style: SpellEffectStyle,
  progress: number,
  detail: SpellEffectDetail,
) {
  const size = scene.cellSize
  const inset = detail === 'minimal' ? size * .15 : size * (.1 + (1 - progress) * .06)
  const side = Math.max(2, size - inset * 2)
  context.save()
  context.globalAlpha = detail === 'minimal' ? .7 : Math.max(.18, Math.sin(Math.PI * clamp01(progress)) * .85)
  context.fillStyle = style.fill
  context.strokeStyle = style.primary
  context.lineWidth = Math.max(1, size * (detail === 'full' ? .04 : .03))
  for (const cell of evenlySample(cells, detail === 'full' ? 96 : detail === 'reduced' ? 48 : 24)) {
    const left = cell.x * size + inset
    const top = cell.y * size + inset
    const centerX = cell.x * size + size / 2
    const centerY = cell.y * size + size / 2
    if (detail !== 'minimal') context.fillRect(left, top, side, side)
    context.strokeRect(left, top, side, side)
    context.beginPath()
    context.moveTo(centerX, top)
    context.lineTo(left + side, centerY)
    context.lineTo(centerX, top + side)
    context.lineTo(left, centerY)
    context.closePath()
    context.stroke()
    if (detail === 'full') {
      context.beginPath()
      context.moveTo(centerX, centerY - size * .12)
      context.lineTo(centerX, centerY + size * .12)
      context.moveTo(centerX - size * .12, centerY)
      context.lineTo(centerX + size * .12, centerY)
      context.stroke()
    }
  }
  context.restore()
}

function drawLightningBurst(
  context: BoardContext2D,
  scene: BoardScene,
  cells: readonly BoardPoint[],
  style: SpellEffectStyle,
  progress: number,
  detail: SpellEffectDetail,
) {
  if (!cells.length) return
  const points = cells.map((cell) => pointCenter(cell, scene.cellSize))
  const count = Math.max(1, Math.ceil(points.length * clamp01(progress)))
  const drawPath = (color: string, width: number, alpha: number) => {
    context.save()
    context.globalAlpha = alpha
    context.strokeStyle = color
    context.lineWidth = width
    let groupStart = 0
    while (groupStart < count) {
      context.beginPath()
      context.moveTo(points[groupStart].x, points[groupStart].y)
      let groupEnd = groupStart
      for (let index = groupStart + 1; index < count; index += 1) {
        const previous = cells[index - 1]
        const current = cells[index]
        if (Math.abs(current.x - previous.x) > 1 || Math.abs(current.y - previous.y) > 1) break
        const dx = points[index].x - points[index - 1].x
        const dy = points[index].y - points[index - 1].y
        const length = Math.max(1, Math.hypot(dx, dy))
        const kink = (index % 2 ? 1 : -1) * scene.cellSize * .12
        const middle = {
          x: (points[index - 1].x + points[index].x) / 2 - dy / length * kink,
          y: (points[index - 1].y + points[index].y) / 2 + dx / length * kink,
        }
        context.lineTo(middle.x, middle.y)
        context.lineTo(points[index].x, points[index].y)
        groupEnd = index
      }
      context.stroke()
      groupStart = groupEnd + 1
    }
    context.restore()
  }
  if (detail === 'full') drawPath(style.secondary, Math.max(5, scene.cellSize * .16), .32)
  drawPath(style.primary, Math.max(2, scene.cellSize * (detail === 'minimal' ? .055 : .075)), .95)
  if (detail !== 'minimal') {
    const head = points[Math.min(count - 1, points.length - 1)]
    drawRing(context, head, scene.cellSize * .18, style.secondary, .88, Math.max(1, scene.cellSize * .035))
  }
}

function drawAreaBoundary(
  context: BoardContext2D,
  scene: BoardScene,
  cells: readonly BoardPoint[],
  style: SpellEffectStyle,
  alpha: number,
  detail: SpellEffectDetail,
) {
  const size = scene.cellSize
  const occupied = new Set(cells.map(pointKey))
  context.save()
  context.globalAlpha = Math.max(.2, alpha)
  context.strokeStyle = style.secondary
  context.lineWidth = Math.max(1, size * (detail === 'full' ? .045 : .032))
  context.setLineDash(detail === 'minimal' ? [Math.max(4, size * .14), Math.max(2, size * .08)] : [])
  context.beginPath()
  for (const cell of cells) {
    const left = cell.x * size
    const top = cell.y * size
    const right = left + size
    const bottom = top + size
    if (!occupied.has(`${cell.x},${cell.y - 1}`)) { context.moveTo(left, top); context.lineTo(right, top) }
    if (!occupied.has(`${cell.x + 1},${cell.y}`)) { context.moveTo(right, top); context.lineTo(right, bottom) }
    if (!occupied.has(`${cell.x},${cell.y + 1}`)) { context.moveTo(right, bottom); context.lineTo(left, bottom) }
    if (!occupied.has(`${cell.x - 1},${cell.y}`)) { context.moveTo(left, bottom); context.lineTo(left, top) }
  }
  context.stroke()
  context.restore()
}

function drawBurstMaterial(
  context: BoardContext2D,
  scene: BoardScene,
  cells: readonly BoardPoint[],
  style: SpellEffectStyle,
  detail: SpellEffectDetail,
  progress: number,
) {
  if (detail === 'minimal' || !cells.length) return
  const size = scene.cellSize
  const fire = style.family === 'fire'
  const count = fire ? (detail === 'full' ? 14 : 8) : (detail === 'full' ? 24 : 14)
  const sampled = evenlySample(cells, count)
  const phaseProgress = clamp01(progress)
  context.save()
  context.globalAlpha = detail === 'full' ? .72 : .52
  context.strokeStyle = style.secondary
  context.fillStyle = style.secondary
  context.lineWidth = Math.max(1, size * .025)
  if (fire) {
    // Огненный шар — это одна движущаяся волна клубов, а не пиктограмма в каждой клетке.
    // Повторение базовой клетки при малой области намеренно: число клубов остаётся
    // читаемым, а смещение и фаза не дают им выглядеть одинаковой заливкой.
    for (let index = 0; index < count; index += 1) {
      const cell = sampled[index % sampled.length]
      const seed = Math.abs(cell.x * 17 + cell.y * 31 + index * 13)
      const phase = (phaseProgress * 1.2 + index / count + (seed % 9) / 18) % 1
      const fade = .28 + Math.sin(Math.PI * phase) * .72
      const radius = size * (.1 + (seed % 5) * .014) * (.78 + phase * .42)
      const center = {
        x: (cell.x + .5) * size + Math.sin(seed + phaseProgress * Math.PI * 2) * size * .18,
        y: (cell.y + .5) * size + size * (.16 - phase * .32),
      }
      context.save()
      context.globalAlpha = fade * (detail === 'full' ? .8 : .62)
      context.fillStyle = style.primary
      context.beginPath()
      context.arc(center.x, center.y, radius, 0, Math.PI * 2)
      context.fill()
      context.globalAlpha *= .92
      context.fillStyle = style.secondary
      context.beginPath()
      context.arc(
        center.x + Math.sin(seed * 1.7) * radius * .28,
        center.y - radius * (.25 + (seed % 3) * .08),
        radius * (.42 + (seed % 3) * .04),
        0,
        Math.PI * 2,
      )
      context.fill()
      context.restore()
    }
    context.restore()
    return
  }
  for (let index = 0; index < sampled.length; index += 1) {
    const cell = sampled[index]
    const phase = (phaseProgress * .9 + index / Math.max(1, sampled.length)) % 1
    const seed = Math.abs(cell.x * 19 + cell.y * 23 + index * 11)
    const center = {
      x: (cell.x + .5) * size + Math.sin(seed + phaseProgress * Math.PI * 2) * size * .16,
      y: (cell.y + .5) * size - Math.cos(seed * .7 + phaseProgress * Math.PI * 2) * size * .12,
    }
    const radius = size * (.16 + (seed % 4) * .025)
    context.save()
    context.globalAlpha = (detail === 'full' ? .52 : .4) * (.7 + Math.sin(Math.PI * phase) * .3)
    if (style.family === 'water' || style.family === 'wind') {
      context.beginPath()
      const drift = Math.sin(phase * Math.PI * 2) * radius * .35
      context.arc(center.x - radius * .45 + drift, center.y, radius, Math.PI * .1, Math.PI * 1.25)
      context.arc(center.x + radius * .35 + drift, center.y, radius, -Math.PI * .25, Math.PI * .9)
      context.stroke()
    } else if (style.family === 'acid' || style.family === 'poison' || style.family === 'swarm') {
      context.beginPath()
      context.arc(center.x - radius * .45, center.y + radius * (.2 - phase * .3), radius * .42, 0, Math.PI * 2)
      context.arc(center.x + radius * .5, center.y - radius * (.4 + phase * .25), radius * .25, 0, Math.PI * 2)
      context.stroke()
    } else if (style.family === 'weapon') {
      context.translate(center.x, center.y)
      context.rotate((phase - .5) * .8 + (seed % 3) * .2)
      context.beginPath()
      context.moveTo(-radius * .2, -radius * 1.7)
      context.lineTo(radius * .2, -radius * 1.7)
      context.lineTo(radius * .45, radius * 1.2)
      context.lineTo(0, radius * 1.7)
      context.lineTo(-radius * .45, radius * 1.2)
      context.closePath()
      context.stroke()
    } else if (style.family === 'earth') {
      context.beginPath()
      context.moveTo(center.x - radius, center.y + radius)
      context.lineTo(center.x - radius * .5, center.y - radius)
      context.lineTo(center.x + radius * .25, center.y - radius * .35)
      context.lineTo(center.x + radius, center.y + radius)
      context.closePath()
      context.fill()
    } else {
      drawFamilyGlyph(context, center, size * .85, style, detail)
    }
    context.restore()
  }
  context.restore()
}

function drawBurst(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const cells = spellBurstCells(scene.map, cue, input.actors)
  const style = spellStyle(cue)
  const reducedMotion = input.reducedMotion || cue.motion === 'reduced'
  const baseProgress = reducedMotion ? .68 : clamp01(input.progress)
  const fireball = cue.spellId === 'fireball'
  if (fireball && !reducedMotion && detail !== 'minimal') {
    drawFireballFlight(context, scene, cue, input, detail, Math.min(1, baseProgress / .56))
    if (baseProgress < .56) return
  }
  if (!cells.length) return
  const progress = fireball && !reducedMotion ? clamp01((baseProgress - .56) / .44) : baseProgress
  if (cue.spellId === 'web') {
    drawWebBurst(context, scene, cells, style, progress, detail)
    return
  }
  if (cue.shape === 'line' && (cue.spellId === 'lightning-bolt' || cue.damageType === 'lightning')) {
    const origin = cue.origin ?? actorPoint(input.actors, cue.actorId)
    const directedCells = origin ? [...cells].sort((left, right) =>
      Math.hypot(left.x - origin.x, left.y - origin.y) - Math.hypot(right.x - origin.x, right.y - origin.y)) : cells
    drawLightningBurst(context, scene, directedCells, style, progress, detail)
    return
  }
  if (style.family === 'cold') {
    drawColdBurst(context, scene, cells, style, progress, detail)
    return
  }
  const motion = envelope(style, progress)
  const size = scene.cellSize
  const alpha = detail === 'minimal' ? .72 : Math.max(.15, motion.alpha)
  context.save()
  context.globalAlpha = alpha
  context.fillStyle = style.fill
  context.beginPath()
  for (const cell of cells) {
    const left = cell.x * size
    const top = cell.y * size
    context.moveTo(left, top)
    context.lineTo(left + size, top)
    context.lineTo(left + size, top + size)
    context.lineTo(left, top + size)
    context.closePath()
  }
  context.fill()
  context.restore()
  drawAreaBoundary(context, scene, cells, style, alpha, detail)
  drawBurstMaterial(context, scene, cells, style, detail, progress)
}

type BeamPoint = { point: BoardPoint; actor?: SpellEffectActor | null }

function beamPoints(cue: Extract<SpellAnimationCue, { kind: 'beam' }>, actors: readonly SpellEffectActor[]) {
  const result: BeamPoint[] = []
  const originActor = actorPoint(actors, cue.actorId)
  const origin = cue.from ?? originActor
  if (origin) result.push({ point: origin, actor: originActor })
  if (cue.points?.length) result.push(...cue.points.map((point, index) => ({ point, actor: actorPoint(actors, cue.targetIds[index]) })))
  else {
    for (const targetId of cue.targetIds) {
      const target = actorPoint(actors, targetId)
      if (target && !result.some((entry) => pointKey(entry.point) === pointKey(target))) result.push({ point: target, actor: target })
    }
  }
  return result
}

function drawBeam(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'beam' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const points = beamPoints(cue, input.actors).filter((entry) => visiblePoint(scene, entry.point))
  if (points.length < 2) return
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? 1 : clamp01(input.progress)
  const segmentProgress = progress * (points.length - 1)
  const completeSegments = Math.floor(segmentProgress)
  const local = segmentProgress - completeSegments
  const screen = points.map((entry) => pointCenter(entry.point, scene.cellSize, scene, entry.actor))
  const drawPath = (color: string, width: number, alpha: number) => {
    context.save()
    context.globalAlpha = alpha
    context.strokeStyle = color
    context.lineWidth = width
    context.setLineDash(style.family === 'control' ? [Math.max(3, scene.cellSize * .12), Math.max(2, scene.cellSize * .08)] : [])
    context.beginPath()
    context.moveTo(screen[0].x, screen[0].y)
    for (let index = 0; index < completeSegments; index += 1) {
      const from = screen[index]
      const target = screen[index + 1]
      if (style.family === 'lightning' || style.family === 'thunder' || style.family === 'psychic') {
        const dx = target.x - from.x
        const dy = target.y - from.y
        const length = Math.max(1, Math.hypot(dx, dy))
        const kink = (index % 2 ? 1 : -1) * scene.cellSize * .12
        context.lineTo((from.x + target.x) / 2 - dy / length * kink, (from.y + target.y) / 2 + dx / length * kink)
      }
      context.lineTo(target.x, target.y)
    }
    if (completeSegments < screen.length - 1) {
      const from = screen[completeSegments]
      const to = screen[completeSegments + 1]
      const current = { x: from.x + (to.x - from.x) * local, y: from.y + (to.y - from.y) * local }
      if (style.family === 'lightning' || style.family === 'thunder' || style.family === 'psychic') {
        const dx = current.x - from.x
        const dy = current.y - from.y
        const length = Math.max(1, Math.hypot(dx, dy))
        const kink = (completeSegments % 2 ? 1 : -1) * scene.cellSize * .12
        context.lineTo((from.x + current.x) / 2 - dy / length * kink, (from.y + current.y) / 2 + dx / length * kink)
      }
      context.lineTo(current.x, current.y)
    }
    context.stroke()
    context.restore()
  }
  if (detail === 'full') drawPath(style.secondary, Math.max(5, scene.cellSize * .14), .28)
  drawPath(style.primary, Math.max(2, scene.cellSize * (detail === 'minimal' ? .045 : .07)), .9)
  if (cue.chain && detail !== 'minimal') {
    for (let index = 1; index <= Math.min(completeSegments + 1, screen.length - 1); index += 1) {
      if (targetOutcomeIsMiss(cue, cue.targetIds[index - 1])) continue
      drawRing(context, screen[index], scene.cellSize * .18, style.secondary, .75, Math.max(1, scene.cellSize * .035))
    }
  }
}

function drawAura(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'aura' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const carrierActor = actorPoint(input.actors, cue.actorId)
  const carrier = cue.center ?? carrierActor
  if (!visiblePoint(scene, carrier)) return
  const center = pointCenter(carrier, scene.cellSize, scene, cue.center ? null : carrierActor)
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? .72 : clamp01(input.progress)
  const activeRadius = cue.auraType === 'concentration'
    ? scene.cellSize * .36
    : Math.max(scene.cellSize * .62, cue.radiusFeet / 5 * scene.cellSize)
  const phase = cue.active === false ? 1 - progress : .84 + Math.sin(progress * Math.PI) * .16
  const dash = cue.auraType === 'concentration'
    ? [Math.max(3, scene.cellSize * .1), Math.max(2, scene.cellSize * .07)]
    : style.family === 'control' || style.family === 'teleport'
      ? [Math.max(4, scene.cellSize * .12), Math.max(2, scene.cellSize * .08)]
      : detail === 'minimal' ? [Math.max(5, scene.cellSize * .18), Math.max(3, scene.cellSize * .1)] : []
  drawRing(context, center, activeRadius * phase, style.primary, cue.active === false ? 1 - progress : .72, Math.max(2, scene.cellSize * .045), dash)
  if (cue.auraType === 'concentration') {
    context.save()
    context.globalAlpha = cue.active === false ? Math.max(0, 1 - progress) : .9
    context.fillStyle = style.secondary
    context.font = `800 ${Math.max(10, Math.round(scene.cellSize * .2))}px Manrope, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText('К', center.x, center.y - scene.cellSize * .42)
    context.restore()
  } else if (detail === 'full') {
    drawRing(context, center, activeRadius * (.72 + progress * .12), style.secondary, .3, Math.max(1, scene.cellSize * .025))
  }
  if (style.family === 'teleport' && detail !== 'minimal') {
    drawRing(context, center, activeRadius * (.52 + progress * .18), style.secondary, .48, Math.max(1, scene.cellSize * .03), [Math.max(3, scene.cellSize * .08), Math.max(2, scene.cellSize * .05)])
  }
}

function drawHealingRise(
  context: BoardContext2D,
  center: { x: number; y: number },
  size: number,
  style: SpellEffectStyle,
  progress: number,
  detail: SpellEffectDetail,
) {
  if (detail === 'minimal') return
  const count = detail === 'full' ? 3 : 2
  const lift = .52 + clamp01(progress) * .35
  context.save()
  context.globalAlpha = detail === 'full' ? .62 : .48
  context.strokeStyle = style.secondary
  context.fillStyle = style.secondary
  context.lineWidth = Math.max(1, size * .028)
  for (let index = 0; index < count; index += 1) {
    const offset = (index - (count - 1) / 2) * size * .22
    const baseY = center.y + size * .34
    const topY = center.y - size * (.5 + (index % 2) * .12)
    const x = center.x + offset
    const wobble = (index - 1) * size * .055
    const endY = baseY + (topY - baseY) * lift
    context.beginPath()
    context.moveTo(x, baseY)
    context.lineTo(x + wobble, endY)
    context.stroke()
    context.beginPath()
    context.arc(x + wobble, endY, Math.max(2, size * .045), 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
}

function drawTeleportPortal(
  context: BoardContext2D,
  center: { x: number; y: number },
  size: number,
  style: SpellEffectStyle,
  alpha: number,
  detail: SpellEffectDetail,
) {
  if (alpha <= 0) return
  drawRing(context, center, size * .34, style.primary, alpha, Math.max(2, size * .055), [Math.max(3, size * .1), Math.max(2, size * .06)])
  if (detail !== 'minimal') {
    drawRing(context, center, size * (.2 + alpha * .16), style.secondary, alpha * .8, Math.max(1, size * .03))
    drawFamilyGlyph(context, center, size * .8, style, detail)
  }
}

/** Один подтверждённый cue и звук, но акцент у каждой видимой цели Скорохода. */
export function spellChannelTargetIds(cue: Extract<SpellAnimationCue, { kind: 'channel' }>): string[] {
  return [...new Set(cue.spellId === 'longstrider' && Array.isArray(cue.targetIds) ? cue.targetIds : [cue.targetId ?? cue.actorId])]
}

function drawChannel(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'channel' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const targetActor = actorPoint(input.actors, cue.targetId) ?? actorPoint(input.actors, cue.actorId)
  const target = cue.position ?? targetActor
  if (!visiblePoint(scene, target)) return
  const center = pointCenter(target, scene.cellSize, scene, cue.position ? null : targetActor)
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? .72 : clamp01(input.progress)
  if (cue.channelType === 'teleport') {
    if (!cue.from) {
      drawTeleportPortal(context, center, scene.cellSize, style, .9, detail)
      return
    }
    if (!visiblePoint(scene, cue.from)) return
    const source = pointCenter(cue.from, scene.cellSize, scene, actorPoint(input.actors, cue.actorId))
    const departure = 1 - clamp01(progress / .4)
    const arrival = clamp01((progress - .6) / .4)
    drawTeleportPortal(context, source, scene.cellSize, style, departure, detail)
    drawTeleportPortal(context, center, scene.cellSize, style, arrival, detail)
    return
  }
  const motion = envelope(style, progress)
  const radius = scene.cellSize * (
    cue.channelType === 'summon' ? .56 + motion.phase * .12
      : cue.channelType === 'healing' ? .28 + motion.phase * .24
        : .3 + motion.phase * .18
  )
  drawRing(
    context,
    center,
    radius,
    cue.channelType === 'healing' ? '#75ad83' : style.primary,
    Math.max(.28, motion.alpha),
    Math.max(2, scene.cellSize * .055),
    cue.channelType === 'summon' && detail !== 'minimal' ? [Math.max(4, scene.cellSize * .13), Math.max(2, scene.cellSize * .07)] : [],
  )
  if (cue.channelType === 'healing') drawHealingRise(context, center, scene.cellSize, style, progress, detail)
  if (style.family === 'teleport' && detail !== 'minimal') {
    drawRing(context, center, radius * 1.45, style.secondary, Math.max(.25, motion.alpha * .7), Math.max(1, scene.cellSize * .03), [Math.max(3, scene.cellSize * .08), Math.max(2, scene.cellSize * .05)])
  } else if (style.family === 'protection' && style.visualVariant !== 'cancellation' && detail !== 'minimal') {
    drawRing(context, center, radius * 1.28, style.secondary, Math.max(.2, motion.alpha * .55), Math.max(1, scene.cellSize * .028))
  } else if (style.family === 'control') {
    drawFamilyGlyph(context, center, scene.cellSize * .7, style, detail)
  } else if (style.family === 'summon') {
    drawFamilyGlyph(context, center, scene.cellSize * .7, style, detail)
  } else if (style.family !== 'school' && style.family !== 'healing') {
    drawFamilyGlyph(context, center, scene.cellSize * .7, style, detail)
  }
  if (detail === 'minimal') return
  context.save()
  context.globalAlpha = Math.max(.35, motion.alpha)
  context.fillStyle = cue.channelType === 'healing' ? '#a8d2a5' : style.secondary
  context.font = `900 ${Math.max(12, Math.round(scene.cellSize * .25))}px Manrope, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  // Величины может не быть вовсе: у неопознанного противника сервер её не
  // присылает (точная десятка выдала бы зелье на 2к4 + 2). Тогда над клеткой
  // стоит слово, а не «+0» — ноль означал бы, что лечение не сработало.
  const label = cue.channelType === 'healing'
    ? cue.amount == null ? 'ЛЕЧЕНИЕ' : `+${cue.amount}`
    : cue.channelType === 'summon' ? 'ПРИЗЫВ' : style.label.toLocaleUpperCase('ru')
  context.fillText(label, center.x, center.y - scene.cellSize * (.28 + progress * .28))
  context.restore()
}

/** Чистая отрисовка одной реплики; состояние canvas изолирует drawBoardEffects. */
export function drawSpellEffect(
  context: BoardContext2D,
  scene: BoardScene,
  input: SpellEffectRenderInput,
) {
  const detail = cueDetail(input)
  const cue = input.cue
  if (cue.kind === 'projectile') drawProjectile(context, scene, cue, input, detail)
  else if (cue.kind === 'burst') drawBurst(context, scene, cue, input, detail)
  else if (cue.kind === 'beam') drawBeam(context, scene, cue, input, detail)
  else if (cue.kind === 'aura') drawAura(context, scene, cue, input, detail)
  else if (cue.spellId === 'longstrider') {
    for (const targetId of spellChannelTargetIds(cue)) {
      if (actorPoint(input.actors, targetId)) drawChannel(context, scene, { ...cue, targetId, position: undefined }, input, detail)
    }
  } else drawChannel(context, scene, cue, input, detail)
}

/** Готовая точка подключения к публичному `drawBoardEffects`. */
export function createSpellEffectRenderer(input: SpellEffectRenderInput): BoardEffectRenderer {
  return (context, scene) => drawSpellEffect(context, scene, input)
}

/**
 * Длящиеся ауры и концентрация не принадлежат очереди: этот renderer строится
 * из текущей проекции и остаётся на доске до исчезновения состояния.
 */
export function createPersistentSpellEffectsRenderer(
  effects: readonly PersistentSpellEffect[],
  actors: readonly SpellEffectActor[],
  options: { detail?: SpellEffectDetail; reducedMotion?: boolean } = {},
): BoardEffectRenderer {
  return (context, scene) => {
    for (const effect of effects) {
      const profile = spellVisualProfile(effect.spellId ?? '', { school: effect.school })
      if (effect.kind === 'area') {
        const carrier = actorPoint(actors, effect.actorId)
        const cue: Extract<SpellAnimationCue, { kind: 'burst' }> = {
          id: effect.id,
          kind: 'burst',
          actorId: effect.actorId ?? '',
          targetIds: [],
          spellId: effect.spellId,
          school: effect.school ?? profile.school,
          origin: carrier ?? effect.center,
          center: effect.center,
          cells: effect.cells,
          shape: effect.shape,
          originMode: effect.originMode,
          sizeFeet: effect.sizeFeet,
          areaSideFeet: effect.areaSideFeet ?? profile.areaSideFeet,
          durationMs: 1,
          motion: 'reduced',
          detail: options.detail,
        }
        drawBurst(context, scene, cue, {
          cue,
          progress: .68,
          actors,
          detail: options.detail,
          reducedMotion: true,
        }, options.detail ?? (options.reducedMotion ? 'minimal' : 'reduced'))
        continue
      }
      const cue: Extract<SpellAnimationCue, { kind: 'aura' }> = {
        id: effect.id,
        kind: 'aura',
        actorId: effect.actorId,
        spellId: effect.spellId ?? '',
        school: effect.school ?? profile.school,
        radiusFeet: effect.kind === 'aura' ? effect.radiusFeet : 0,
        auraType: effect.kind === 'aura' ? 'spell' : 'concentration',
        active: true,
        durationMs: 1,
        motion: options.reducedMotion ? 'reduced' : 'full',
        detail: options.detail,
      }
      drawAura(context, scene, cue, {
        cue,
        progress: .5,
        actors,
        detail: options.detail,
        reducedMotion: options.reducedMotion,
      }, options.detail ?? (options.reducedMotion ? 'minimal' : 'reduced'))
    }
  }
}

export function isSpellAnimationCue(cue: CombatAnimationCue): cue is SpellAnimationCue {
  return cue.kind === 'projectile'
    || cue.kind === 'burst'
    || cue.kind === 'beam'
    || cue.kind === 'aura'
    || cue.kind === 'channel'
}
