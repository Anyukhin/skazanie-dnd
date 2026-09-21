import { useEffect, useMemo, useState } from 'react'
import { Play, RotateCcw, Search, Sparkles, Swords, Volume2, VolumeX } from 'lucide-react'
import catalogPayload from '../data/dndsu-spells-0-6.json'
import mechanicsOverrides from '../data/dndsu-spell-mechanics-overrides.json'
import { attackVisualStyle, attackVisualStyleForActor, attackVisualStyleForModelKey, combatAnimationCuesFromEvents, type AttackKind, type BoardPoint } from './combat-animation'
import type { CombatAudio } from './combat-audio'
import { areaCells, type AreaBounds, type AreaShape } from './area-geometry'
import { modelKeysForEquipmentSlot } from '../server/equipment-visuals.mjs'
import { spellEffectPalette, spellVisualProfile, type SpellEffectFamily, type SpellSoundFamily } from './spell-effects'
import { tacticalMapFromCells } from './tactical-map-client'
import { TacticalBoard, type BoardAnimationActor, type BoardCellNode } from './TacticalBoard'
import type { ActorAppearance, CombatSpell, CombatVisualBatch, GameEvent, MapCell } from './types'
import './combat-effects-lab.css'

type CatalogSpell = CombatSpell & {
  school?: string
}

type Support = 'verified' | 'partial' | 'heuristic' | 'ruling-only'

type SpellEntry = {
  type: 'spell'
  spell: CatalogSpell
  support: Support
  soundFamily: SpellSoundFamily
  family: SpellEffectFamily
}

type AttackEntry = {
  type: 'attack'
  id: string
  name: string
  attackKind: AttackKind
  modelKey: string
  equipment: 'unarmed' | 'sword' | 'staff' | 'dagger' | 'bow' | 'unknown'
  damageType?: string
}

type PreviewEntry = SpellEntry | AttackEntry

type PreviewMode = 'spells' | 'attacks'
type SpellFilter = 'all' | 'damage' | 'control' | 'support' | 'utility'

const WIDTH = 14
const HEIGHT = 10
export const COMBAT_EFFECTS_PREVIEW_BOUNDS: AreaBounds = Object.freeze({ minX: 1, minY: 1, maxX: WIDTH - 2, maxY: HEIGHT - 2 })
const CASTER: BoardPoint = { x: 3, y: 5 }
const ENEMY: BoardPoint = { x: 9, y: 5 }
const SECOND_ENEMY: BoardPoint = { x: 10, y: 7 }
const ALLY: BoardPoint = { x: 3, y: 7 }
const SUMMON: BoardPoint = { x: 8, y: 5 }

const overrides = (mechanicsOverrides as unknown as { spells?: Record<string, Partial<CatalogSpell> & { mechanicsSupport?: Support }> }).spells ?? {}
const catalog = (catalogPayload as unknown as { spells: CatalogSpell[] }).spells

const SOUND_LABELS: Record<SpellSoundFamily, string> = {
  flame: 'пламя', frost: 'лёд', electric: 'электричество', thunder: 'гром', acid: 'кислота', poison: 'яд',
  necrotic: 'некротика', radiant: 'излучение', force: 'сила', psychic: 'психика', healing: 'лечение', ward: 'защита',
  control: 'контроль', teleport: 'телепорт', summon: 'призыв', illusion: 'иллюзия', divination: 'прорицание',
  light: 'свет', darkness: 'тьма', environment: 'окружение', enchantment: 'очарование', restoration: 'восстановление',
  invisibility: 'невидимость', flight: 'полёт', mobility: 'мобильность', transmutation: 'трансмутация',
  communication: 'связь', earth: 'земля', wind: 'ветер', water: 'вода', swarm: 'рой', weapon: 'оружие',
  silence: 'тишина', utility: 'утилита',
}

const MODEL_LABELS: Readonly<Record<string, string>> = {
  club: 'Дубина', dagger: 'Кинжал', greatclub: 'Большая дубина', handaxe: 'Ручной топор', javelin: 'Метательное копьё',
  'light-hammer': 'Лёгкий молот', mace: 'Булава', quarterstaff: 'Боевой посох', sickle: 'Серп', spear: 'Копьё', dart: 'Дротик',
  'light-crossbow': 'Лёгкий арбалет', shortbow: 'Короткий лук', sling: 'Праща', battleaxe: 'Боевой топор', flail: 'Цеп',
  glaive: 'Глефа', greataxe: 'Двуручный топор', greatsword: 'Двуручный меч', halberd: 'Алебарда', lance: 'Копьё всадника',
  longsword: 'Длинный меч', maul: 'Молот', morningstar: 'Моргенштерн', pike: 'Пика', pistol: 'Пистолет', musket: 'Мушкет',
  rapier: 'Рапира', scimitar: 'Скимитар', shortsword: 'Короткий меч', trident: 'Трезубец', warhammer: 'Боевой молот',
  'war-pick': 'Клевец', whip: 'Кнут', blowgun: 'Духовая трубка', 'hand-crossbow': 'Ручной арбалет', 'heavy-crossbow': 'Тяжёлый арбалет',
  longbow: 'Длинный лук', wand: 'Жезл', net: 'Сеть',
}

const STYLE_LABELS: Readonly<Record<string, string>> = {
  slash: 'рубящий', pierce: 'колющий', bludgeon: 'дробящий', unarmed: 'безоружный', natural: 'природный',
  bow: 'лук', crossbow: 'арбалет', sling: 'праща', dart: 'дротик', firearm: 'огнестрельный', wand: 'жезл', net: 'сеть', thrown: 'метательный',
}

const RANGED_MODEL_KEYS = new Set(['blowgun', 'dart', 'hand-crossbow', 'heavy-crossbow', 'light-crossbow', 'longbow', 'musket', 'net', 'pistol', 'shortbow', 'sling', 'wand'])
// Дополнительный такт метания только для оружия с properties: ['thrown'] в
// server/item-catalog.mjs. Каноническая карточка самой модели остаётся melee/ranged.
const THROWN_MODEL_KEYS = ['dagger', 'handaxe', 'javelin', 'light-hammer', 'spear', 'trident', 'dart'] as const
const REACH_MODEL_KEYS = new Set(['glaive', 'halberd', 'lance', 'pike', 'whip'])

function modelAttackKind(modelKey: string): AttackKind {
  if (modelKey === 'net') return 'thrown'
  return RANGED_MODEL_KEYS.has(modelKey) ? 'ranged' : 'melee'
}

function modelEquipment(modelKey: string): AttackEntry['equipment'] {
  if (modelKey === 'longbow' || modelKey === 'shortbow') return 'bow'
  if (modelKey === 'quarterstaff') return 'staff'
  if (modelKey === 'dagger') return 'dagger'
  return modelAttackKind(modelKey) === 'melee' ? 'sword' : 'unknown'
}

function modelDamageType(modelKey: string): string | undefined {
  if (modelKey === 'net') return undefined
  const style = attackVisualStyleForModelKey(modelKey)
  if (style === 'bludgeon' || style === 'sling') return 'bludgeoning'
  if (style === 'slash' || style === 'thrown') return 'slashing'
  return 'piercing'
}

function attackTargetPoint(entry: AttackEntry): BoardPoint {
  if (entry.attackKind !== 'melee') return ENEMY
  return REACH_MODEL_KEYS.has(entry.modelKey) ? { x: 5, y: 5 } : { x: 4, y: 5 }
}

function attackName(modelKey: string) {
  const label = MODEL_LABELS[modelKey]
  if (label) return label
  const style = attackVisualStyleForModelKey(modelKey) ?? 'slash'
  return `Атака ${STYLE_LABELS[style] ?? style} (${modelKey})`
}

const ATTACKS: AttackEntry[] = [
  ...modelKeysForEquipmentSlot('main_hand').map((modelKey) => ({
    type: 'attack' as const,
    id: modelKey,
    name: attackName(modelKey),
    attackKind: modelAttackKind(modelKey),
    modelKey,
    equipment: modelEquipment(modelKey),
    damageType: modelDamageType(modelKey),
  })),
  ...THROWN_MODEL_KEYS.map((modelKey) => ({
    type: 'attack' as const,
    id: `${modelKey}:thrown`,
    name: `${attackName(modelKey)}: метание`,
    attackKind: 'thrown' as const,
    modelKey,
    equipment: modelEquipment(modelKey),
    damageType: modelDamageType(modelKey),
  })),
  { type: 'attack', id: 'unarmed', name: 'Безоружный удар', attackKind: 'melee', modelKey: 'unarmed', equipment: 'unarmed', damageType: 'bludgeoning' },
  { type: 'attack', id: 'natural', name: 'Природная атака', attackKind: 'melee', modelKey: 'natural', equipment: 'unarmed', damageType: 'slashing' },
]

/** Полный production-набор оружия плюс две атаки без каталожной модели. */
export const COMBAT_EFFECTS_ATTACK_ENTRIES = ATTACKS

export function previewActors(entry?: PreviewEntry): BoardAnimationActor[] {
  if (entry?.type !== 'attack') return PREVIEW_ACTORS
  const profile = entry.id === 'natural' ? 'beast' : 'mage'
  const appearance = {
    version: 2 as const,
    profile,
    equipment: entry.equipment,
    loadout: { main_hand: { model_key: entry.modelKey } },
  } as ActorAppearance
  const target = attackTargetPoint(entry)
  return PREVIEW_ACTORS.map((actor) => {
    if (actor.id === 'caster') return { ...actor, appearance }
    if (actor.id === 'enemy') return { ...actor, x: target.x, y: target.y }
    return actor
  })
}

const PREVIEW_CELLS: MapCell[] = Array.from({ length: WIDTH * HEIGHT }, (_, index) => {
  const x = index % WIDTH
  const y = Math.floor(index / WIDTH)
  const edge = x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1
  return { x, y, type: edge ? 'wall' : 'floor', revealed: true, material: y < 3 ? 'stone' : y > 7 ? 'earth' : 'wood', variant: (x + y) % 3 }
})

const PREVIEW_ACTORS: BoardAnimationActor[] = [
  {
    id: 'caster', x: CASTER.x, y: CASTER.y, label: 'Маг', color: '#d5aa63', kind: 'hero',
    appearance: { version: 2, profile: 'mage', equipment: 'staff', loadout: { main_hand: { model_key: 'quarterstaff' } } },
  },
  {
    id: 'ally', x: ALLY.x, y: ALLY.y, label: 'Союзник', color: '#6fae8a', kind: 'hero',
    appearance: { version: 2, profile: 'mage', equipment: 'staff', loadout: { main_hand: { model_key: 'mace' } } } as ActorAppearance,
  },
  {
    id: 'enemy', x: ENEMY.x, y: ENEMY.y, label: 'Цель', color: '#b8665d', kind: 'enemy',
    appearance: { version: 2, profile: 'goblin', equipment: 'dagger', loadout: { main_hand: { model_key: 'dagger' } } },
  },
  {
    id: 'enemy-2', x: SECOND_ENEMY.x, y: SECOND_ENEMY.y, label: 'Вторая цель', color: '#9e5d58', kind: 'enemy',
    appearance: { version: 2, profile: 'skeleton', equipment: 'sword', loadout: { main_hand: { model_key: 'shortsword' } } },
  },
  {
    id: 'summon', x: SUMMON.x, y: SUMMON.y, label: 'Призванный', color: '#66a883', kind: 'summon',
    appearance: { version: 2, profile: 'beast', equipment: 'unarmed', loadout: {} },
  },
]

function spellHints(spell: CatalogSpell) {
  return {
    school: spell.school,
    kind: spell.kind,
    target: spell.target,
    areaShape: spell.areaShape,
    areaOrigin: spell.areaOrigin,
    radius: spell.radius,
    damageType: spell.damageType,
    damageTypes: spell.damageTypes,
    maxTargets: spell.maxTargets,
    projectileCount: spell.projectileCount,
    beams: (spell as CatalogSpell & { beams?: number }).beams,
  }
}

export function soundFamilyForSpell(spellId: string, spell?: CatalogSpell): SpellSoundFamily {
  const palette = spellEffectPalette(spellId, spell ? spellHints(spell) : {})
  return palette.soundFamily as SpellSoundFamily
}

function supportForSpell(spell: CatalogSpell): Support {
  const value = overrides[spell.id]?.mechanicsSupport
  return value === 'verified' || value === 'partial' || value === 'heuristic' || value === 'ruling-only'
    ? value
    : overrides[spell.id] ? 'partial' : 'heuristic'
}

const spellEntries: SpellEntry[] = catalog
  .filter((spell) => Number(spell.level) >= 0 && Number(spell.level) <= 6)
  .map((spell) => {
    const merged = { ...spell, ...(overrides[spell.id] ?? {}) } as CatalogSpell
    const palette = spellEffectPalette(merged.id, spellHints(merged))
    return { type: 'spell', spell: merged, support: supportForSpell(merged), family: palette.family, soundFamily: soundFamilyForSpell(merged.id, merged) }
  })

const AREA_SHAPE_LABELS: Record<NonNullable<CatalogSpell['areaShape']>, string> = {
  sphere: 'сфера', cylinder: 'цилиндр', cone: 'конус', cube: 'куб', line: 'линия',
}

function previewWalkable(point: BoardPoint) {
  return PREVIEW_CELLS.some((cell) => cell.x === point.x && cell.y === point.y && cell.type !== 'wall')
}

function previewAreaGeometry(spell: CatalogSpell) {
  const profile = spellVisualProfile(spell.id, spellHints(spell))
  if (profile.kind !== 'burst' || !profile.areaShape) return null
  const originMode = spell.areaOrigin ?? (spell.target === 'self' ? 'self' : 'point')
  const origin = CASTER
  const directional = profile.areaShape === 'cone' || profile.areaShape === 'line' || profile.areaShape === 'cube' && originMode === 'self'
  const target = directional || originMode === 'point' ? { x: 8, y: 5 } : origin
  const sizeFeet = Math.max(5, Number(profile.sizeFeet ?? spell.radius ?? 10) || 10)
  return {
    shape: profile.areaShape as AreaShape,
    origin,
    target,
    originMode,
    sizeFeet,
    ...(profile.areaSideFeet ? { sideFeet: profile.areaSideFeet } : {}),
  }
}

function previewAreaCells(spell: CatalogSpell, bounded = true) {
  const geometry = previewAreaGeometry(spell)
  if (!geometry) return []
  const cells = areaCells({
    ...geometry,
    cellFeet: 5,
    bounds: bounded ? COMBAT_EFFECTS_PREVIEW_BOUNDS : undefined,
    isWalkable: bounded ? previewWalkable : undefined,
  })
  return bounded ? cells.filter(previewWalkable) : cells
}

function previewAreaMeta(spell: CatalogSpell) {
  const geometry = previewAreaGeometry(spell)
  if (!geometry) return null
  const full = previewAreaCells(spell, false)
  const bounded = areaCells({ ...geometry, cellFeet: 5, bounds: COMBAT_EFFECTS_PREVIEW_BOUNDS })
  const clipped = full.some((point) => (
    point.x < COMBAT_EFFECTS_PREVIEW_BOUNDS.minX || point.x > COMBAT_EFFECTS_PREVIEW_BOUNDS.maxX
    || point.y < COMBAT_EFFECTS_PREVIEW_BOUNDS.minY || point.y > COMBAT_EFFECTS_PREVIEW_BOUNDS.maxY
  )) || previewAreaCells(spell).length < bounded.length
  return { shape: AREA_SHAPE_LABELS[geometry.shape], sizeFeet: geometry.sizeFeet, clipped }
}

function targetIdsForSpell(spell: CatalogSpell, profile: ReturnType<typeof spellVisualProfile>) {
  if (profile.kind === 'aura' || spell.target === 'self') return ['caster', 'ally']
  if (spell.target === 'ally' || spell.kind === 'healing' || spell.kind === 'buff') return ['ally']
  return profile.kind === 'burst' ? ['enemy', 'enemy-2'] : ['enemy']
}

export function buildPreviewEvents(entry: PreviewEntry, replay: number): GameEvent[] {
  if (entry.type === 'attack') {
    const target = attackTargetPoint(entry)
    return [{
      event_id: `effects-lab:${entry.id}:${replay}`,
      command_id: `effects-lab:${entry.id}:${replay}`,
      event_type: 'AttackResolved',
      actor_id: 'caster',
      target_ids: ['enemy'],
      payload: {
        hit: true,
        damage_type: entry.damageType,
        attack_kind: entry.attackKind,
        attack_visual: {
          version: 2,
          equipment: entry.equipment,
          loadout: { main_hand: { model_key: entry.modelKey } },
        },
        trajectory: [CASTER, target],
      },
    }]
  }

  const spell = entry.spell
  const profile = spellVisualProfile(spell.id, spellHints(spell))
  const family = entry.family
  const areaGeometry = profile.kind === 'burst' ? previewAreaGeometry(spell) : null
  const originMode = areaGeometry?.originMode ?? spell.areaOrigin ?? (spell.target === 'self' ? 'self' : 'point')
  const center = areaGeometry?.target ?? (profile.kind === 'beam' ? ENEMY : { x: 8, y: 5 })
  const sizeFeet = areaGeometry?.sizeFeet ?? Math.max(5, Number(profile.sizeFeet ?? spell.radius ?? 10) || 10)
  const cells = areaGeometry ? previewAreaCells(spell) : []
  const targetIds = targetIdsForSpell(spell, profile)
  const commandId = `effects-lab:${spell.id}:${replay}`

  if (family === 'healing') return [{
    event_id: commandId,
    command_id: commandId,
    event_type: 'HealingApplied',
    actor_id: 'caster',
    target_ids: ['ally'],
    payload: { spell_id: spell.id, applied_amount: 8, hp_after: 24, hp_before: 16 },
  }]
  if (family === 'summon') return [{
    event_id: commandId,
    command_id: commandId,
    event_type: 'SummonedCreatureCreated',
    actor_id: 'caster',
    target_ids: ['summon'],
    payload: { summon: { id: 'summon', sourceSpellId: spell.id, x: SUMMON.x, y: SUMMON.y } },
  }]
  if (family === 'teleport') return [{
    event_id: commandId,
    command_id: commandId,
    event_type: 'ActorMoved',
    actor_id: 'caster',
    target_ids: ['caster'],
    payload: { teleport: true, spell_id: spell.id, from: CASTER, to: { x: 8, y: 5 } },
  }]

  return [{
    event_id: commandId,
    command_id: commandId,
    event_type: 'SpellCast',
    actor_id: 'caster',
    target_ids: targetIds,
    payload: {
      spell_id: spell.id,
      kind: spell.kind,
      school: spell.school,
      damage_type: spell.damageType ?? spell.damageTypes?.[0],
      from: CASTER,
      to: center,
      center,
      points: profile.kind === 'beam' ? [ENEMY, SECOND_ENEMY] : undefined,
      cells: cells.length ? cells : undefined,
      area_shape: areaGeometry?.shape ?? profile.areaShape,
      area_origin: originMode,
      radius_feet: sizeFeet,
      concentration: spell.concentration === true,
    },
  }]
}

function actorNode(actor: BoardAnimationActor): BoardCellNode {
  return {
    x: actor.x,
    y: actor.y,
    className: 'combat-effects-lab-actor-cell',
    interactive: false,
    ariaLabel: actor.label,
    title: actor.label,
    children: <span className={`combat-effects-lab-token ${actor.kind}`}><b>{actor.label.slice(0, 1)}</b></span>,
  }
}

function spellCategory(spell: CatalogSpell, family: SpellEffectFamily): SpellFilter {
  if (spell.kind === 'healing' || spell.kind === 'buff' || spell.kind === 'summon' || family === 'protection' || family === 'restoration') return 'support'
  if (spell.kind === 'debuff' || family === 'control') return 'control'
  if (spell.kind === 'damage' || spell.kind === 'area-damage' || spell.kind === 'attack' || String(spell.kind) === 'area-save') return 'damage'
  if (spell.kind === 'utility' || spell.kind === 'teleport') return 'utility'
  return 'all'
}

function supportLabel(support: Support) {
  if (support === 'verified') return 'Исполняется сервером'
  if (support === 'partial') return 'Частичная поддержка'
  if (support === 'ruling-only') return 'Только решение ведущего'
  return 'Просмотр эффекта, применение в кампании недоступно'
}

function previewId(entry: PreviewEntry | undefined) {
  return entry?.type === 'spell' ? entry.spell.id : entry?.id ?? ''
}

export type CombatEffectsLabProps = {
  combatAudio?: CombatAudio
  soundMuted?: boolean
  onSoundMutedChange?: (muted: boolean) => void
}

function attackStyle(entry: AttackEntry) {
  const [cue] = combatAnimationCuesFromEvents(buildPreviewEvents(entry, 0))
  if (cue?.kind !== 'strike') return entry.id
  if (entry.id === 'natural') return attackVisualStyleForActor(cue, { appearance: { profile: 'beast' } })
  return attackVisualStyle(cue)
}

export function CombatEffectsLab({ combatAudio, soundMuted: soundMutedProp, onSoundMutedChange }: CombatEffectsLabProps = {}) {
  const [mode, setMode] = useState<PreviewMode>('spells')
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [category, setCategory] = useState<SpellFilter>('all')
  const [selectedId, setSelectedId] = useState('fireball')
  const [replay, setReplay] = useState(0)
  const [batch, setBatch] = useState<CombatVisualBatch | null>(null)
  const [localSoundMuted, setLocalSoundMuted] = useState(false)
  const [hasPlayed, setHasPlayed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const soundMuted = soundMutedProp ?? localSoundMuted

  const entries = useMemo<PreviewEntry[]>(() => mode === 'spells' ? spellEntries : ATTACKS, [mode])
  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ru')
    return entries.filter((entry) => {
      const matchesQuery = !normalized || `${previewId(entry)} ${entry.type === 'spell' ? `${entry.spell.name} ${entry.spell.englishName ?? ''}` : entry.name}`.toLocaleLowerCase('ru').includes(normalized)
      if (!matchesQuery) return false
      if (entry.type === 'attack') return true
      if (level !== 'all' && entry.spell.level !== Number(level)) return false
      return category === 'all' || spellCategory(entry.spell, entry.family) === category
    })
  }, [entries, query, level, category])
  const current = entries.find((entry) => entry.type === 'spell' ? entry.spell.id === selectedId : entry.id === selectedId) ?? entries[0]
  const map = useMemo(() => tacticalMapFromCells(PREVIEW_CELLS), [])
  const boardActors = useMemo(() => previewActors(current), [current])
  const cells = useMemo(() => boardActors.map(actorNode), [boardActors])
  const events = useMemo(() => current ? buildPreviewEvents(current, replay) : [], [current, replay])
  const cues = useMemo(() => combatAnimationCuesFromEvents(events), [events])
  const soundFamily = current?.type === 'spell' ? current.soundFamily : null
  const areaMeta = useMemo(() => current?.type === 'spell' ? previewAreaMeta(current.spell) : null, [current])

  useEffect(() => {
    setHasPlayed(false)
    setPlaying(false)
    setBatch(null)
  }, [current?.type, previewId(current)])

  useEffect(() => {
    if (!current || hasPlayed) return
    const timer = window.setTimeout(() => {
      setBatch({ id: `effects-lab:${current.type}:${previewId(current)}:${replay}`, events, npcTurns: [] })
      setHasPlayed(true)
      setPlaying(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [current, replay, events, hasPlayed])

  useEffect(() => {
    if (!playing) return
    const duration = Math.max(600, ...cues.map((cue) => Math.max(1, Number(cue.durationMs) || 1)))
    const timer = window.setTimeout(() => setPlaying(false), duration + 120)
    return () => window.clearTimeout(timer)
  }, [playing, cues, batch?.id])

  const play = () => {
    if (!current) return
    setHasPlayed(false)
    setPlaying(true)
    setReplay((value) => value + 1)
    void combatAudio?.unlock()
  }

  const countLabel = mode === 'spells' ? `${filteredEntries.length} из ${spellEntries.length} заклинаний` : `${filteredEntries.length} вариантов атаки`
  const support = current?.type === 'spell' ? supportLabel(current.support) : 'Просмотр физического такта'

  return <section className="combat-effects-lab" aria-labelledby="combat-effects-lab-title">
    <header className="combat-effects-lab-header">
      <div>
        <h2 id="combat-effects-lab-title">Визуальная проверка</h2>
        <p>Сравнение заклинаний и атак на тестовой арене. Здесь нет расхода ресурсов и правил кампании.</p>
      </div>
      <div className="combat-effects-lab-header-count">{mode === 'spells' ? '0-6 круг' : 'Физические атаки'}<strong>{countLabel}</strong></div>
    </header>

    <div className="combat-effects-lab-layout">
      <aside className="combat-effects-lab-catalog" aria-label="Каталог эффектов">
        <div className="combat-effects-lab-mode-tabs" role="tablist" aria-label="Тип эффекта">
          <button type="button" role="tab" aria-selected={mode === 'spells'} onClick={() => { setMode('spells'); setSelectedId('fireball'); setCategory('all'); setLevel('all') }}><Sparkles size={15} />Заклинания</button>
          <button type="button" role="tab" aria-selected={mode === 'attacks'} onClick={() => { setMode('attacks'); setSelectedId('slash'); setCategory('all'); setLevel('all') }}><Swords size={15} />Атаки</button>
        </div>
        <label className="combat-effects-lab-search"><Search size={16} /><span className="sr-only">Поиск</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или id" /></label>
        {mode === 'spells' && <div className="combat-effects-lab-filters">
          <label>Круг<select value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">Все круги</option>{[0, 1, 2, 3, 4, 5, 6].map((value) => <option value={value} key={value}>{value === 0 ? 'Заговоры' : `${value} круг`}</option>)}</select></label>
          <label>Категория<select value={category} onChange={(event) => setCategory(event.target.value as SpellFilter)}><option value="all">Все</option><option value="damage">Урон</option><option value="control">Контроль</option><option value="support">Поддержка</option><option value="utility">Утилита</option></select></label>
        </div>}
        <div className="combat-effects-lab-list" role="listbox" aria-label={mode === 'spells' ? 'Заклинания' : 'Типы атаки'}>
          {filteredEntries.map((entry) => {
            const id = entry.type === 'spell' ? entry.spell.id : entry.id
            const active = current?.type === entry.type && id === (current.type === 'spell' ? current.spell.id : current.id)
            return <button type="button" role="option" aria-selected={active} className={active ? 'selected' : ''} key={id} onClick={() => setSelectedId(id)}>
              <span className="combat-effects-lab-list-main"><strong>{entry.type === 'spell' ? entry.spell.name : entry.name}</strong><small>{entry.type === 'spell' ? `Круг ${entry.spell.level} · ${entry.family}` : attackStyle(entry)}</small></span>
              {entry.type === 'spell' && <span className={`combat-effects-lab-support ${entry.support}`}>{entry.support === 'verified' ? '✓' : entry.support === 'partial' ? '~' : '?'}</span>}
            </button>
          })}
          {!filteredEntries.length && <p className="combat-effects-lab-empty">Ничего не найдено.</p>}
        </div>
      </aside>

      <div className="combat-effects-lab-stage">
        <div className="combat-effects-lab-stage-head">
          <div><h3>{current?.type === 'spell' ? current.spell.name : current?.name}</h3><p>{support}</p></div>
          <div className="combat-effects-lab-stage-actions">
            <button type="button" className="combat-effects-lab-play" onClick={play} disabled={!current}>{hasPlayed ? <RotateCcw size={16} /> : <Play size={16} />}{hasPlayed ? 'Повторить' : 'Воспроизвести'}</button>
            <button type="button" className={`combat-effects-lab-sound ${soundMuted ? 'muted' : ''}`} aria-pressed={!soundMuted} onClick={() => (onSoundMutedChange ? onSoundMutedChange(!soundMuted) : setLocalSoundMuted((value) => !value))} title={soundMuted ? 'Включить звук эффекта' : 'Выключить звук эффекта'}>{soundMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
          </div>
        </div>
        <div className="combat-effects-lab-board-shell">
          {map && <TacticalBoard key={`${current?.type}:${previewId(current)}`} map={map} campaignId="combat-effects-lab" columns={WIDTH} rows={HEIGHT} irregular={false} ariaLabel="Карта галереи боевых эффектов" themeKey="combat-lab" artUrl={null} cells={cells} overlayCells={[]} lighting={false} viewResetKey={`${current?.type}:${previewId(current)}`} animationsEnabled visualBatch={batch} animationActors={boardActors} wheelZoomRequiresAltKey combatAudio={combatAudio} />}
          {!batch && <div className="combat-effects-lab-board-empty"><Play size={20} /><span>Нажмите «Воспроизвести»</span></div>}
        </div>
        <footer className="combat-effects-lab-stage-meta">
          <span>Вид: 2D / 3D, переключатель на карте</span>
          {areaMeta && <span>Размер каста: {areaMeta.shape}, {areaMeta.sizeFeet} футов{areaMeta.clipped ? ' · окно превью обрезано' : ''}</span>}
          <span>{soundFamily ? `Звук: ${SOUND_LABELS[soundFamily]} после нажатия` : 'Звук: профиль физической атаки после нажатия'}</span>
          <span>Эффектов: {cues.length}</span>
        </footer>
      </div>
    </div>
  </section>
}
