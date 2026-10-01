/**
 * Подписи, расчёты и мелкие HUD-компоненты тактической сцены. Вынесены из
 * `DungeonMap.tsx`, чтобы файл компонента держал только сам компонент;
 * `DungeonMap.tsx` реэкспортирует всё отсюда, поэтому импорты в остальном
 * клиенте не меняются.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, Crown, ScrollText, Swords, X, Bot, PawPrint, Skull, WandSparkles } from 'lucide-react'
import type {
  ActorFootprint,
  BattleEvent,
  CombatSpell,
  CombatVisualBatch,
  Enemy,
  GameState,
  MapFeedback,
  ParleyOutcome,
  Player,
  SceneObjectIntent,
  TacticalProp,
} from './types'
import { spellComponentAvailabilityFor, spellComponentsPresentation } from './types'
import { DAMAGE_TYPE_LABELS, HARMFUL_SPELL_KINDS, REPUTATION_TIER_LABELS, boardTrajectoryBlockReason } from './app-shared'
import type { WeaponAttackChoice } from './useGameSession'
import { CELL_FEET } from './tactical-engine'
import {
  TOKEN_CONDITION_PRIORITY,
  actorFootprintCells,
  battleRollContext,
  battleRollPresentation,
  conditionPresentation,
  tokenConditionGlyph,
  turnClockPresentation,
} from './tactical-ui'
import { fallbackCombatResources, featureResourceName } from './combat-actions'
import { fallbackSpellResources, spellNameById } from './combat-spells'
import { spellIdFromEffect } from './spell-effects'
import { localizedQuestClockLabel } from './desktop-ui.mjs'
import type { SceneVisualTheme } from './scene-art'
import { factionDisplayName, reputationImpactForTier } from './player-experience'

export type EnemyVisualKind = 'construct' | 'undead' | 'beast' | 'mystic' | 'raider'

export type PresentedCondition = ReturnType<typeof conditionPresentation>

/**
 * Что у героя «на нём» прямо сейчас: состояния, концентрация и временные хиты.
 * Три вещи, без которых за столом D&D не принять решения, а в интерфейсе они
 * жили только на фишке и в полоске хода того, кто ходит. Всё читается из
 * серверной проекции: состояния — `mechanics.conditions`, концентрация —
 * `mechanics.concentration` (имя заклинания — по эффекту или по самому ключу
 * эффекта), временные хиты — `mechanics.temporary_hp`.
 */
export type HeroStatus = { conditions: PresentedCondition[]; concentration: string | null; temporaryHp: number }

export function heroStatusFor(state: GameState, actorId: string): HeroStatus {
  const conditions = (state.mechanics?.conditions?.[actorId] ?? []).map(conditionPresentation)
  const concentration = state.mechanics?.concentration?.[actorId]
  let concentrationLabel: string | null = null
  if (concentration) {
    const effectId = concentration.effect_id
    const effect = (state.mechanics?.active_effects ?? []).find((entry) => entry.effect_id === effectId || entry.id === effectId)
    const spellId = effect?.spell_id ?? spellIdFromEffect(effectId)
    concentrationLabel = spellNameById(spellId ? String(spellId) : null) ?? 'заклинание'
  }
  const temporaryHp = Math.max(0, Math.floor(Number(state.mechanics?.temporary_hp?.[actorId] ?? 0) || 0))
  // Своё же заклинание под концентрацией движок кладёт герою и состоянием
  // («Благословение · пока держится концентрация»): чип концентрации уже
  // сказал то же самое, второй раз не повторяем.
  const raw = state.mechanics?.conditions?.[actorId] ?? []
  const visibleConditions = conditions.filter((condition, index) => !(concentrationLabel && condition.label === concentrationLabel && raw[index]?.duration === 'concentration'))
  return { conditions: visibleConditions, concentration: concentrationLabel, temporaryHp }
}

/** Подсказка к точкам состояний в отряде: всё словами, через точку. */
export function heroStatusSummary(status: HeroStatus): string {
  const parts = []
  if (status.temporaryHp > 0) parts.push(`Временные хиты: ${status.temporaryHp}`)
  if (status.concentration) parts.push(`Концентрация: ${status.concentration}`)
  for (const condition of status.conditions) parts.push(`${condition.label}${condition.duration ? ` · ${condition.duration}` : ''}`)
  return parts.join(' · ')
}

export const MAP_FEEDBACK_TTL_MS = 4200
export const BATTLE_ROLL_TTL_MS = 4600
export const NPC_TACTIC_TTL_MS = 4800

export function npcTacticFromBattleLog(battleLog: BattleEvent[] | undefined) {
  for (let index = (battleLog?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = battleLog?.[index]
    if (!entry || entry.type !== 'attack' || entry.actorKind !== 'enemy') continue
    const tactic = entry.packTactics ? 'тактика стаи'
      : entry.charge ? 'удар с разбега'
        : entry.bloodiedFrenzy ? 'ярость раненого'
          : entry.actionName ? entry.actionName.toLocaleLowerCase('ru')
            : 'идёт в атаку'
    return { id: entry.id, kind: 'enemy-turn' as const, actor_id: entry.actorId, target_id: entry.targetId, tactic }
  }
  return null
}

export type BattleRollContext = NonNullable<ReturnType<typeof battleRollContext>>

export function BattleRollReasons({ context }: { context: BattleRollContext | null }) {
  if (!context || context.mode === 'normal') return null
  const reasons = context.mode === 'advantage' ? context.advantageReasons : context.disadvantageReasons
  return <div className={`battle-roll-reasons ${context.mode}`}>
    <small>{context.mode === 'advantage' ? 'Преимущество' : 'Помеха'}</small>
    <span>{reasons.length > 0 ? reasons.join(' · ') : 'Причина не раскрыта сервером'}</span>
    {context.dice.length === 2 && <em>кости {context.dice.join(' и ')}</em>}
  </div>
}

export const NPC_STANCE_LABELS = {
  neutral: 'нейтрально',
  friendly: 'дружелюбно',
  wary: 'настороженно',
  hostile: 'враждебно',
  panicked: 'в панике',
} as const

export const NPC_RELATIONSHIP_LABELS = {
  hostile: 'враждебное',
  unfriendly: 'неприязненное',
  neutral: 'нейтральное',
  friendly: 'дружеское',
  trusted: 'доверительное',
} as const

export const NPC_CONVERSATION_STANCE_LABELS = {
  friendly: 'дружелюбно',
  neutral: 'нейтрально',
  guarded: 'сдержанно',
  hostile: 'враждебно',
} as const

export const RAIL_HEIGHT_KEY = 'skazanie-rail-height-v1'
export const SERVER_WIDTH_KEY = 'skazanie-server-width-v1'
export const TILE_LOCK_KEY = 'skazanie-tiles-locked-v1'
export const TILE_ORDER_KEY = 'skazanie-tile-order-v1'
export const MAP_LEGEND_KEY = 'skazanie-map-legend-open-v1'
export const BASE_ATTACK_ID = '__base-attack__'
export const SCENE_OBJECT_VERB_LABELS: Record<SceneObjectIntent, string> = {
  inspect: 'Осмотреть',
  open: 'Открыть',
  lockpick: 'Взломать',
  take: 'Взять',
  use: 'Использовать',
  topple: 'Опрокинуть',
  ignite: 'Поджечь',
  pray: 'Помолиться',
}
/**
 * Подписи условий перемирия. Какие из них доступны, решает сервер: здесь
 * только текст карточки. Держать их у клиента можно ровно потому, что список
 * исходов закрыт и приезжает в проекции — придумать новый клиент не может.
 */
export const PARLEY_TERM_LABELS: Record<ParleyOutcome, { label: string; summary: string }> = {
  withdraw: { label: 'Разойтись миром', summary: 'Противник уходит со сцены и клянётся не возвращаться.' },
  tribute: { label: 'Уйти, оставив добычу', summary: 'Противник уходит и оставляет отряду всё взятое.' },
  surrender: { label: 'Сложить оружие', summary: 'Противник сдаётся и переходит в плен, когда бой будет закрыт.' },
  resume: { label: 'Продолжить бой', summary: 'Уговора нет: перемирие снимается, очередь оживает.' },
}
/**
 * Варианты, которые предлагает заклинание. Виды урона среди них те же самые,
 * что печатает боевая хроника, поэтому берутся из общего словаря
 * (`DAMAGE_TYPE_LABELS`, `app-shared.tsx`), а не переписываются здесь второй
 * раз: пока они жили только тут, «колющего» в строке журнала не было вовсе.
 */
export const SPELL_OPTION_LABELS: Record<string, string> = {
  blinded: 'Ослепление',
  deafened: 'Глухота',
  asleep: 'Сон',
  panicked: 'Паника',
  sickened: 'Тошнота',
  charmed: 'Очарование',
  paralyzed: 'Паралич',
  petrified: 'Окаменение',
  poisoned: 'Отравление',
  exhaustion: 'Истощение',
  enlarge: 'Увеличение',
  reduce: 'Уменьшение',
  'great-tree': 'Великое древо',
  'primal-beast': 'Первобытный зверь',
  warm: 'Тёплый щит',
  chill: 'Холодный щит',
  str: 'Сила', dex: 'Ловкость', con: 'Телосложение',
  int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма',
  acrobatics: 'Акробатика',
  'animal-handling': 'Уход за животными',
  arcana: 'Магия',
  athletics: 'Атлетика',
  deception: 'Обман',
  history: 'История',
  insight: 'Проницательность',
  intimidation: 'Запугивание',
  investigation: 'Расследование',
  medicine: 'Медицина',
  nature: 'Природа',
  perception: 'Восприятие',
  performance: 'Выступление',
  persuasion: 'Убеждение',
  religion: 'Религия',
  'sleight-of-hand': 'Ловкость рук',
  stealth: 'Скрытность',
  survival: 'Выживание',
  approach: 'Подойди',
  drop: 'Брось',
  flee: 'Убегай',
  grovel: 'Падай',
  halt: 'Стой',
  ...DAMAGE_TYPE_LABELS,
}

export const WEAPON_ATTACK_MODE_LABELS: Record<NonNullable<WeaponAttackChoice['attackMode']>, string> = {
  melee: 'Одной рукой',
  ranged: 'Дальний выстрел',
  thrown: 'Метнуть',
  'two-handed': 'Двумя руками',
}

export const WEAPON_ATTACK_ABILITY_LABELS: Record<NonNullable<WeaponAttackChoice['attackAbility']>, string> = {
  str: 'Сила',
  dex: 'Ловкость',
}

/**
 * Подписи запасов героя для ресурсного кластера у панели действий. Список
 * открытый намеренно: ключей в серверной проекции (`mechanics.resources`)
 * больше, чем перечислено здесь, и незнакомый запас показывается своим ключом.
 * Молча прятать чужой ресурс хуже, чем назвать его сырым именем: спрятанное
 * игрок не пересчитает, а сырое имя хотя бы совпадёт с листом героя.
 */
export const HERO_RESOURCE_LABELS: Record<string, string> = {
  pact_slots: 'Ячейки договора',
  mystic_arcanum_6: 'Мистический арканум',
  ki: 'Ци',
  rage: 'Ярость',
  second_wind: 'Второе дыхание',
  action_surge: 'Всплеск действий',
  indomitable: 'Несгибаемость',
  superiority_dice: 'Кости превосходства',
  bardic_inspiration: 'Вдохновение барда',
  channel_divinity: 'Божественный канал',
  wild_shape: 'Дикий облик',
  lay_on_hands: 'Наложение рук',
  divine_sense: 'Божественное чувство',
  sorcery_points: 'Единицы чародейства',
  /* «Восстановление сил» было вольным синонимом: сама способность и здесь, и на
     сервере называется «Магическое восстановление» (`combat-actions.ts`,
     `server/combat-actions.mjs:139`). Из-за расхождения свой же двойник
     `feature_wizard-magicheskoe-vosstanovlenie` не узнавался как двойник и
     стоял в ряду вторым чипом. */
  arcane_recovery: 'Магическое восстановление',
}

/**
 * Незнакомый ключ — опрятно, но без подлога: срезаем служебный префикс
 * серверной проекции, разделители превращаем в пробелы, поднимаем первую букву.
 * Переводом это не притворяется, и потому сырой ключ не теряется — он уходит в
 * подсказку чипа (`heroResourceTitle`), чтобы запас можно было сверить с листом
 * героя. Раньше ключ показывался как есть и вдобавок обрезался на середине.
 */
export function heroResourceFallbackLabel(key: string): string {
  const tidy = key.replace(/^(?:feature|resource)_/u, '').replace(/[_-]+/gu, ' ').trim()
  return tidy ? tidy.charAt(0).toLocaleUpperCase('ru') + tidy.slice(1) : key
}

/** Знаем ли мы запас по имени — от этого зависит, нужен ли сырой ключ в подсказке. */
function heroResourceKnown(key: string): boolean {
  return /^spell_slots_[1-9]$/u.test(key) || Boolean(HERO_RESOURCE_LABELS[key]) || Boolean(featureResourceName(key))
}

/** Полное имя запаса — для подсказки и для скринридера. */
export function heroResourceLabel(key: string): string {
  const slot = /^spell_slots_([1-9])$/u.exec(key)
  if (slot) return `Ячейки ${slot[1]} круга`
  return HERO_RESOURCE_LABELS[key] ?? featureResourceName(key) ?? heroResourceFallbackLabel(key)
}

/**
 * Подсказка чипа запаса: имя и счёт, а у выведенного имени — ещё и сырой ключ.
 * Чип узкий и обрывается многоточием, поэтому подсказка обязана нести всё, чего
 * в нём не поместилось.
 */
export function heroResourceTitle(keys: string[], current: number, max: number): string {
  const [first = ''] = keys
  const head = `${heroResourceLabel(first)}: ${current} из ${max}`
  /* Ключей несколько — это схлопнутые близнецы, и назвать оба обязательно:
     игрок вправе знать, из чего сложился единственный чип, а мастеру это
     единственный след серверного задвоения. */
  if (keys.length > 1) return `${head} · ключи: ${keys.join(', ')}`
  return `${head}${heroResourceKnown(first) ? '' : ` · ключ ${first}`}`
}

/** Короткая подпись в ряду: у ячейки — цифра круга, у прочего — имя строчными. */
export function heroResourceShortLabel(key: string): string {
  const slot = /^spell_slots_([1-9])$/u.exec(key)
  if (slot) return slot[1]
  return heroResourceLabel(key).toLocaleLowerCase('ru')
}

/**
 * Ресурсы героя принадлежат серверной проекции целиком. Fallback нужен только
 * старым снимкам, где карты ресурсов ещё нет; пустая карта — тоже авторитетный
 * ответ и не должна дополняться клиентским каталогом.
 */
export function heroResourcesFor(
  state: GameState,
  actorId: string,
  player?: Player | null,
): Record<string, { current: number; max: number }> {
  const resources = state.mechanics?.resources
  if (resources && Object.hasOwn(resources, actorId)) return resources[actorId] ?? {}
  const fallbackPlayer = player ?? undefined
  return { ...fallbackCombatResources(fallbackPlayer), ...fallbackSpellResources(fallbackPlayer) }
}

export const SPELL_SLOT_ROMANS = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const

/** Круг ячеек заклинаний — цифра после общего слова «Ячейки», а не имя. */
export function isSpellSlotPool(key: string): boolean {
  return /^spell_slots_[1-9]$/u.test(key)
}

export type HeroPoolRow = { keys: string[]; current: number; max: number }

/**
 * Бюджет позиций ряда запасов: круг ячеек — позиция, классовый запас —
 * позиция. Что не влезло, сворачивается в чип «+N ещё», и он сам занимает
 * последнюю позицию — поэтому при переполнении видимых на одну меньше
 * бюджета, а хвост всегда не короче двух. Невидимой прокрутки у кластера
 * нет: хвост обязан быть виден как счётчик, а не срезан молча.
 */
export function heroPoolLayout<T extends HeroPoolRow>(rows: readonly T[], budget: number): { visible: T[]; hidden: T[]; slotCount: number } {
  const limit = Math.max(1, Math.floor(budget))
  const visible = rows.length <= limit ? [...rows] : rows.slice(0, Math.max(1, limit - 1))
  const hidden = rows.slice(visible.length)
  return { visible, hidden, slotCount: visible.filter((row) => isSpellSlotPool(row.keys[0])).length }
}

/** Порядок ряда: ячейки по кругам, следом договор и арканум, дальше классовое. */
export function heroResourceRank(key: string): number {
  const slot = /^spell_slots_([1-9])$/u.exec(key)
  if (slot) return Number(slot[1])
  if (key === 'pact_slots') return 10
  if (key === 'mystic_arcanum_6') return 11
  return 20
}

/**
 * Стоимость плитки — та же строка, что стоит на бейдже плитки. Фильтр по клику
 * на пипсе сравнивает именно её, поэтому список стоимостей и список пипсов
 * обязаны сходиться.
 */
export type TileCost = 'action' | 'bonus_action' | 'reaction' | 'free' | 'movement' | 'long_cast'
export type HotbarCostFilter = 'action' | 'bonus_action' | 'reaction'
export const HOTBAR_COST_FILTER_LABELS: Record<HotbarCostFilter, string> = {
  action: 'действия',
  bonus_action: 'бонусные действия',
  reaction: 'реакции',
}

export type CombatMode = 'weapon' | 'magic' | 'action'
export type CombatDeck = 'common' | 'weapon' | 'magic' | 'class' | 'items'
export type PendingCombatCommand =
  | { kind: 'target'; targetId: string; attackMode?: WeaponAttackChoice['attackMode']; attackAbility?: WeaponAttackChoice['attackAbility']; sneakAttack?: boolean }
  | { kind: 'area'; x: number; y: number }
  | { kind: 'spell-target'; targetId: string }
  | { kind: 'spell-targets'; targetIds: string[] }
  | { kind: 'action-target'; targetId: string }

export function spellKind(spell?: CombatSpell | null): CombatSpell['kind'] | null {
  if (!spell) return null
  const raw = String(spell.kind ?? spell.targetType ?? '')
  if (raw === 'ally') return 'healing'
  if (raw === 'cell') return 'summon'
  if (raw === 'enemy') return 'attack'
  return ['attack', 'save', 'area-save', 'damage', 'area-damage', 'healing', 'summon', 'buff', 'debuff', 'utility', 'teleport'].includes(raw) ? raw as CombatSpell['kind'] : null
}

export function spellRange(spell?: CombatSpell | null) {
  return Math.max(0, Number(spell?.range ?? spell?.rangeFeet ?? spell?.range_feet) || 0)
}

export function spellActionType(spell?: CombatSpell | null): CombatSpell['actionType'] {
  const value = spell?.actionType ?? spell?.action_type
  return value === 'bonus_action' || value === 'reaction' || value === 'long_cast' ? value : 'action'
}

export function chebyshevFeet(from: { x: number; y: number }, to: { x: number; y: number }) {
  return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * CELL_FEET
}

export function sceneObjectCells(prop: TacticalProp) {
  return prop.footprint.length
    ? prop.footprint
    : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
}

export function sceneObjectVerbs(prop: TacticalProp): SceneObjectIntent[] {
  const projected = prop.interaction?.verbs ?? prop.interactionVerbs ?? []
  return [...new Set(projected.filter((verb): verb is SceneObjectIntent => (
    verb === 'inspect' || verb === 'open' || verb === 'lockpick' || verb === 'take' || verb === 'use'
    || verb === 'topple' || verb === 'ignite' || verb === 'pray'
  )))]
}

export function sceneObjectLabel(prop: TacticalProp) {
  return prop.label?.trim() || (prop.interaction?.pointOfInterest ? 'Точка интереса' : 'Объект сцены')
}

type BoardTrajectoryActor = { x: number; y: number; footprint?: ActorFootprint }

export function actorTrajectoryBlockReason(state: GameState, from: BoardTrajectoryActor, to: BoardTrajectoryActor) {
  const starts = actorFootprintCells(from)
  const ends = actorFootprintCells(to)
  let firstReason: string | null = null
  for (const start of starts) for (const end of ends) {
    const reason = boardTrajectoryBlockReason(state, start, end)
    if (reason == null) return null
    firstReason ??= reason
  }
  return firstReason ?? 'Траектория недоступна'
}

export function hasClearBoardTrajectory(state: GameState, from: BoardTrajectoryActor, to: BoardTrajectoryActor) {
  return actorTrajectoryBlockReason(state, from, to) == null
}

export function inferredCombatItem(item: Player['inventory'][number]) {
  if (item.combat) return item
  const text = `${item.name} ${item.properties}`.toLocaleLowerCase('ru')
  const combat = /динамит|dynamite/u.test(text)
    ? { kind: 'thrown-area' as const, ability: 'dex' as const, damage: '3d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex' as const, saveDc: 12, halfOnSave: true }
    : /гранат|бомб|grenade|bomb/u.test(text)
      ? { kind: 'thrown-area' as const, ability: 'dex' as const, damage: '2d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex' as const, saveDc: 12, halfOnSave: true }
      : /арбалет|crossbow/u.test(text)
        ? { kind: 'ranged' as const, ability: 'dex' as const, damage: '1d8', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }
        : /длинн.{0,3}лук|longbow/u.test(text)
          ? { kind: 'ranged' as const, ability: 'dex' as const, damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600, twoHanded: true, ammunition: true }
          : /лук|bow/u.test(text)
            ? { kind: 'ranged' as const, ability: 'dex' as const, damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }
            : null
  return combat ? { ...item, combat } : null
}

/**
 * Сколько выстрелов осталось у этого оружия и как снаряд называется.
 * `null` — оружию боеприпас не нужен (ближний бой, метание, самодельный лук из
 * старого сохранения без каталожной записи).
 *
 * Считает сервер: у пачки снарядов в проекции лежит готовый остаток
 * (`capabilities.ammunition.shots`), у оружия — какой снаряд оно просит. Здесь
 * только сложение по карману, потому что таблицу «лук → стрелы» и размер пачки
 * знает каталог (`server/item-catalog.mjs`), и второй её копии в браузере быть
 * не должно: разойдись они, счётчик обещал бы выстрел, в котором сервер
 * откажет.
 */
export function ammunitionSupplyFor(inventory: Player['inventory'] | undefined, item: Player['inventory'][number]) {
  const weapon = item.capabilities?.ammunition
  if (!weapon || weapon.role !== 'weapon') return null
  const shots = (inventory ?? []).reduce((total, candidate) => {
    const pack = candidate.capabilities?.ammunition
    if (!pack || pack.role !== 'ammunition' || candidate.catalog_id !== weapon.catalog_id) return total
    return total + Math.max(0, Number(pack.shots) || 0)
  }, 0)
  return { shots, unit: weapon.unit }
}

export function enemyVisualKind(enemy: Enemy): EnemyVisualKind {
  const signature = enemy.name.toLocaleLowerCase('ru')
  if (/(дрон|робот|андроид|автомат|мех|голем|конструкт|страж|construct|golem|guardian|drone|robot)/u.test(signature)) return 'construct'
  if (/(скелет|нежит|призрак|зомби|упыр|undead|skeleton|ghost|wraith|zombie)/u.test(signature)) return 'undead'
  if (/(волк|звер|крыса|паук|медвед|beast|wolf|rat|spider|bear)/u.test(signature)) return 'beast'
  if (/(маг|чарод|колдун|жрец|шаман|культист|mage|caster|warlock|cultist|shaman)/u.test(signature)) return 'mystic'
  return 'raider'
}

/* Числа лежат на самой полоске, а фон под ними по мере ранения меняется с заливки
   на пустоту. Поэтому текст рисуется дважды: светлый на всю ширину и тёмный,
   обрезанный по заливке. Контраст держится при любом остатке, без обводки — она
   на полоске в 11px превращается в грязь. */
export function TokenHealthBar({ fill, label, className }: { fill: number; label?: string; className?: string }) {
  const ratio = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0))
  return <span className={`map-token-hp ${className ?? ''}`} style={{ '--hp-fill': ratio } as React.CSSProperties}>
    <i />
    {label ? <b>{label}</b> : null}
    {label && ratio > 0 ? <span className="map-token-hp-lit"><b>{label}</b></span> : null}
  </span>
}

/**
 * Портрет на токене NPC. Тот же серверный эндпоинт, что и в досье: для
 * значимых персонажей — сгенерированный портрет, для остальных — ролевая
 * заготовка с подтверждёнными правами. Пока картинки нет — инициалы.
 */
export function NpcTokenPortrait({ campaignId, npcId, name }: { campaignId: string; npcId: string; name: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [campaignId, npcId])
  if (failed || !campaignId) {
    return <span className="neutral-token-mark" aria-hidden="true">{name.slice(0, 2).toLocaleUpperCase('ru')}</span>
  }
  return <img
    className="neutral-token-portrait"
    src={`/api/campaigns/${encodeURIComponent(campaignId)}/npcs/${encodeURIComponent(npcId)}/portrait`}
    alt=""
    aria-hidden="true"
    loading="lazy"
    draggable={false}
    onError={() => setFailed(true)}
  />
}

export function NpcPortrait({ campaignId, npcId, name }: { campaignId: string; npcId: string; name: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [campaignId, npcId])
  const portraitUrl = `/api/campaigns/${encodeURIComponent(campaignId)}/npcs/${encodeURIComponent(npcId)}/portrait`
  return <div className={`npc-dialog-portrait ${failed ? 'fallback' : 'loaded'}`}>
    {!failed && <img src={portraitUrl} alt={`Портрет: ${name}`} onError={() => setFailed(true)} />}
    {failed && <span aria-label={`Нейтральный портрет-заглушка: ${name}`}>{name.slice(0, 2).toLocaleUpperCase('ru')}</span>}
  </div>
}

/**
 * Что можно творить без инициативы. Список повторяет серверный
 * `HARMFUL_SPELL_KINDS` из rules-engine: решает всё равно сервер, здесь он
 * нужен, чтобы не предлагать игроку плитку, которая заведомо вернёт отказ.
 */
export const castableOutOfCombat = (spell: { kind?: string } | null | undefined) => Boolean(spell && !HARMFUL_SPELL_KINDS.has(String(spell.kind)))

/**
 * Шапка колонки описания: название, рядом с ним — метки самого действия
 * (дальность, концентрация, область), под ним полный текст. Метки стоят
 * здесь, а не строкой внизу: внизу остаётся только указание, что делать
 * дальше, и оно не тонет среди чисел. Условные знаки взяты из уже принятых
 * в игре — «К» концентрации из книги заклинаний, футы с плиток.
 */
/**
 * Короткий знак поддержки механики: «½» — исполняется частично, «?» — карточка
 * не проверена, «!» — нужно решение правил. Полная формулировка остаётся в
 * подсказке: в строке с названием на неё нет места, а знак виден сразу.
 */
export function supportMark(status: string) {
  if (status === 'partial') return '½'
  if (status === 'heuristic') return '?'
  if (status === 'ruling-only') return '!'
  return null
}

export function DetailHeader({ title, description, meta }: { title: string; description?: string; meta?: React.ReactNode }) {
  return <>
    <div className="detail-head"><strong>{title}</strong>{meta ? <div className="detail-meta">{meta}</div> : null}</div>
    {description ? <p className="detail-description">{description}</p> : null}
  </>
}

function trimUiPunctuation(value: string | null | undefined) {
  return String(value ?? '').trim().replace(/[.!?]+$/u, '')
}

export function unavailableUiReason(reason: string | null | undefined) {
  const clean = trimUiPunctuation(reason) || 'нужные компоненты недоступны'
  return `Недоступно: ${clean}`
}

/**
 * Компоненты остаются частью карточки заклинания. Ветка availability только
 * показывает авторитетную причину блокировки, если сервер её явно прислал;
 * локальный профиль компонентов здесь не участвует в решении о доступности.
 */
export function SpellComponentsLine({ spell, compact = false }: { spell: CombatSpell; compact?: boolean }) {
  const presentation = spellComponentsPresentation(spell.components)
  const availability = spellComponentAvailabilityFor(spell)
  if (!presentation && !availability.blocked) return null
  const blockedReason = availability.blocked
    ? trimUiPunctuation(availability.reason) || 'нужные компоненты недоступны'
    : null
  const reasonLabel = blockedReason ? unavailableUiReason(blockedReason) : null
  const ariaLabel = [presentation?.ariaLabel ?? 'Компоненты не указаны.', reasonLabel ? `${reasonLabel}.` : null]
    .filter(Boolean)
    .join(' ')
  const markers = presentation?.markers ?? []
  const markerNodes = markers.map((marker) => <b key={marker} className="spell-component-marker">{marker}</b>)
  if (compact) {
    return <small className={`spell-components compact${blockedReason ? ' blocked' : ''}`} aria-label={ariaLabel} title={ariaLabel}>
      <span className="spell-component-markers" aria-hidden="true">{markerNodes}</span>
      {blockedReason && <span className="spell-component-compact-reason" aria-hidden="true">!</span>}
    </small>
  }
  return <p className={`spell-components${blockedReason ? ' blocked' : ''}`} aria-label={ariaLabel} title={ariaLabel}>
    <span className="spell-component-markers" aria-hidden="true">{markerNodes}</span>
    {presentation?.materialText && <span className="spell-component-material"><b>М:</b> {presentation.materialText}</span>}
    {presentation?.specialText && <span className="spell-component-special">{presentation.specialText}</span>}
    {!presentation && <span className="spell-component-material">Компоненты не указаны</span>}
    {blockedReason && <span className="spell-component-reason" role="status">{reasonLabel}</span>}
  </p>
}

export function enemyHealthPresentation(enemy: Enemy) {
  const exact = enemy.healthKnown === 'exact' && Number.isFinite(enemy.hp) && Number.isFinite(enemy.maxHp) && Number(enemy.maxHp) > 0
  const labels: Record<NonNullable<Enemy['healthStatus']>, string> = {
    unharmed: 'Не ранен',
    wounded: 'Ранен',
    bloodied: 'Тяжело ранен',
    critical: 'При смерти',
    defeated: 'Побеждён',
  }
  const ratio = Number.isFinite(enemy.hp) && Number.isFinite(enemy.maxHp) && Number(enemy.maxHp) > 0
    ? Number(enemy.hp) / Number(enemy.maxHp)
    : null
  const derivedStatus: NonNullable<Enemy['healthStatus']> = enemy.healthStatus
    ?? (!enemy.alive || ratio === 0 ? 'defeated' : ratio == null || ratio >= 1 ? 'unharmed' : ratio > .5 ? 'wounded' : ratio > .25 ? 'bloodied' : 'critical')
  /* Пока характеристики не раскрыты, точной доли нет — полоска показывает ступень
     состояния теми же долями, какими её раньше задавали классы в CSS. */
  const statusFill: Record<NonNullable<Enemy['healthStatus']>, number> = { unharmed: 1, wounded: .75, bloodied: .5, critical: .2, defeated: 0 }
  return {
    exact,
    status: derivedStatus,
    label: exact ? `${enemy.hp}/${enemy.maxHp} ОЗ` : labels[derivedStatus],
    percent: exact ? Math.max(0, Math.min(100, Number(enemy.hp) / Number(enemy.maxHp) * 100)) : null,
    fill: exact ? Math.max(0, Math.min(1, Number(enemy.hp) / Number(enemy.maxHp))) : statusFill[derivedStatus],
    /* В полоску пишем только то, что игрок имеет право знать: числа при раскрытых
       характеристиках. Слово состояния туда не влезает («Тяжело ранен» вдвое шире
       полоски), поэтому оно остаётся в подписи под токеном и в aria-label. */
    barLabel: exact ? `${enemy.hp}/${enemy.maxHp}` : '',
  }
}

export function TokenConditionIcons({ conditions }: { conditions: PresentedCondition[] }) {
  const ordered = [...conditions].sort((left, right) => {
    const leftPriority = TOKEN_CONDITION_PRIORITY.indexOf(left.id)
    const rightPriority = TOKEN_CONDITION_PRIORITY.indexOf(right.id)
    return (leftPriority < 0 ? 99 : leftPriority) - (rightPriority < 0 ? 99 : rightPriority)
  })
  if (!ordered.length) return null
  return <span className="token-conditions" aria-label="Состояния фишки">
    {ordered.slice(0, 4).map((condition) => (
      <i
        key={condition.instanceKey}
        className={condition.status}
        data-condition={condition.id}
        aria-label={condition.label}
        title={`${condition.label} · ${condition.statusLabel}. ${condition.explanation}`}
      >
        {tokenConditionGlyph(condition.id, condition.label)}
      </i>
    ))}
  </span>
}

/* Отметка над клеткой живёт ровно столько, сколько нужно, чтобы её прочитать.
   Движок держит последние шесть записей до самой смены сцены, и без этого
   «Промах» висел над клеткой все следующие раунды — как будто бой замер на том
   броске. Считаем от первого показа у игрока, а не от прихода состояния:
   повторная проекция того же события метку не продлевает. */
export function useTransientMapFeedback(feedback: MapFeedback[] | undefined) {
  const timers = useRef(new Map<string, number>())
  // Ключ по идентификаторам: объект состояния пересоздаётся на каждой проекции,
  // а набор отметок при этом тот же — пересчёт по ссылке перезапускал бы отсчёт.
  const idKey = (feedback ?? []).map((item) => String(item.id)).join('|')
  const items = useMemo(() => feedback ?? [], [idKey])
  // При открытии карты уже загруженные записи — история, а не новые попадания.
  const [expired, setExpired] = useState<string[]>(() => items.map((item) => String(item.id)))
  useEffect(() => {
    const live = new Set(items.map((item) => String(item.id)))
    for (const id of live) {
      if (timers.current.has(id)) continue
      timers.current.set(id, window.setTimeout(() => setExpired((current) => current.includes(id) ? current : [...current, id]), MAP_FEEDBACK_TTL_MS))
    }
    for (const [id, handle] of [...timers.current]) if (!live.has(id)) { window.clearTimeout(handle); timers.current.delete(id) }
    setExpired((current) => {
      const next = current.filter((id) => live.has(id))
      return next.length === current.length ? current : next
    })
  }, [items])
  useEffect(() => {
    const handles = timers.current
    return () => { for (const handle of handles.values()) window.clearTimeout(handle); handles.clear() }
  }, [])
  return useMemo(() => items.filter((item) => !expired.includes(String(item.id))), [items, expired])
}

export function useTransientBattleRoll(battleLog: BattleEvent[] | undefined) {
  const logKey = (battleLog ?? []).map((event) => `${event.id}:${event.roll?.die ?? ''}:${event.roll?.total ?? ''}`).join('|')
  const latest = useMemo(
    () => [...(battleLog ?? [])].reverse().find((event) => battleRollPresentation(event)) ?? null,
    [logKey],
  )
  const seenId = useRef<string | null>(latest?.id ?? null)
  const [visibleId, setVisibleId] = useState<string | null>(null)
  useEffect(() => {
    if (!latest) {
      seenId.current = null
      setVisibleId(null)
      return
    }
    if (seenId.current === latest.id) return
    seenId.current = latest.id
    setVisibleId(latest.id)
    const handle = window.setTimeout(() => setVisibleId((current) => current === latest.id ? null : current), BATTLE_ROLL_TTL_MS)
    return () => window.clearTimeout(handle)
  }, [latest?.id])
  return latest && latest.id === visibleId ? latest : null
}

/**
 * Подпись хода NPC из журнала боя. Журнал входит в проекцию состояния, поэтому
 * этот источник виден **всей партии**, а не только тому, чей браузер отправил
 * команду: батч `npcTurns` приходит лишь в ответе на HTTP-команду инициатора.
 * Признаки удара посчитал сервер, клиент лишь подбирает слова.
 */
export function useTransientNpcTactic(batch: CombatVisualBatch | null | undefined, battleLog?: BattleEvent[]) {
  const fromBatch = [...(batch?.npcTurns ?? [])].reverse().find((turn) => turn.kind === 'enemy-turn' && turn.tactic) ?? null
  const fromLog = npcTacticFromBattleLog(battleLog)
  const latest = fromBatch ?? fromLog
  const key = latest
    ? `${fromBatch ? batch?.id ?? '' : fromLog?.id ?? ''}:${latest.actor_id ?? ''}:${latest.tactic ?? ''}`
    : ''
  const seenKey = useRef(key)
  const [visibleKey, setVisibleKey] = useState('')
  useEffect(() => {
    if (!key) {
      seenKey.current = ''
      setVisibleKey('')
      return
    }
    if (seenKey.current === key) return
    seenKey.current = key
    setVisibleKey(key)
    const handle = window.setTimeout(() => setVisibleKey((current) => current === key ? '' : current), NPC_TACTIC_TTL_MS)
    return () => window.clearTimeout(handle)
  }, [key])
  return key && key === visibleKey ? latest : null
}

export function BattleRollCard({ event, context }: { event: BattleEvent; context: BattleRollContext | null }) {
  const roll = battleRollPresentation(event)
  if (!roll) return null
  return <div className={`battle-roll-card ${roll.success ? 'success' : 'failed'}`} role="status" aria-label={`Бросок d20: ${roll.natural == null ? 'кости скрыты' : `${roll.natural} ${roll.modifierText}`}, итого ${roll.total}${roll.difficulty != null ? ` против ${roll.difficultyLabel} ${roll.difficulty}` : ''}. ${roll.outcome}`}>
    {roll.natural != null && <div className="battle-roll-d20"><small>d20</small><b>{roll.natural}</b></div>}
    <div className="battle-roll-summary">
      {roll.natural != null && <><span><small>Модификатор</small><b>{roll.modifierText}</b></span><i aria-hidden="true">=</i></>}
      <span className="total"><small>Итог</small><b>{roll.total}</b></span>
      {roll.difficulty != null && <><i aria-hidden="true">против</i><span><small>{roll.difficultyLabel}</small><b>{roll.difficulty}</b></span></>}
    </div>
    <strong>{roll.success ? 'Успех' : event.type === 'attack' ? 'Промах' : 'Неудача'}</strong>
    <BattleRollReasons context={context} />
  </div>
}

export function BattleRollTokenCallout({ event, context }: { event: BattleEvent; context: BattleRollContext | null }) {
  const roll = battleRollPresentation(event)
  if (!roll) return null
  const modeReasons = context?.mode === 'advantage'
    ? context.advantageReasons
    : context?.mode === 'disadvantage'
      ? context.disadvantageReasons
      : []
  return <div className={`battle-roll-token-callout ${roll.success ? 'success' : 'failed'}`} role="status">
    <b>{roll.natural == null ? `итого ${roll.total}` : `${roll.natural} ${roll.modifierText}`}</b>
    <span>{roll.difficulty == null ? (roll.natural == null ? 'серверный результат' : `= ${roll.total}`) : `против ${roll.difficultyLabel} ${roll.difficulty}`}</span>
    <strong>{roll.outcome}</strong>
    {context && context.mode !== 'normal' && <small>{context.mode === 'advantage' ? 'Преимущество' : 'Помеха'}{modeReasons.length ? `: ${modeReasons.join(', ')}` : ''}</small>}
  </div>
}

export function PartyQuestHud({ state }: { state: GameState }) {
  const [expanded, setExpanded] = useState(false)
  const quests = (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'active')
  const threads = (state.worldMemory?.threads ?? []).filter((thread) => (
    !['closed', 'completed', 'resolved'].includes(thread.status ?? 'active')
  ))
  // Это уже `npcSocialForViewer`: specific-player и скрытые обещания сервер
  // отрезал до HTTP/SSE. На клиенте нет второго visibility-фильтра и нет
  // чтения persistence-состояния.
  const promises = (state.social?.promises ?? []).filter((promise) => promise.status === 'open')
  const npcNames = new Map((state.social?.npcs ?? []).map((npc) => [npc.id, npc.name]))
  const reputation = state.autonomy?.reputation_standing ?? []
  if (quests.length === 0 && threads.length === 0 && promises.length === 0 && reputation.length === 0) return null
  const signalCount = quests.length + threads.length + promises.length
  return <section className={`party-quest-hud ${expanded ? 'expanded' : ''}`} aria-label="Задачи отряда">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <ScrollText size={15} />
      <span>
        <small>Задачи {quests.length} · Обещания {promises.length} · Нити {threads.length}</small>
      </span>
      <ChevronDown size={15} />
    </button>
    {reputation.length > 0 && <p className="party-reputation-rule">
      <Crown size={13} />
      <span>Слава меняет цены до ±10% и СЛ разговоров до ±3</span>
    </p>}
    {expanded && <div>
      {promises.length > 0 && <section className="party-signal-group">
        <h3>Открытые обещания</h3>
        {promises.map((promise) => <article key={promise.id} className="promise">
          <b>{npcNames.get(promise.npc_id) ?? 'Знакомый персонаж'}</b>
          <p>{promise.text}</p>
          <small>{promise.direction === 'party_to_npc' ? 'Обещал отряд' : 'Обещано отряду'}{promise.due_hint ? ` · ${promise.due_hint}` : ''}</small>
        </article>)}
      </section>}
      {threads.length > 0 && <section className="party-signal-group">
        <h3>Незакрытые нити</h3>
        {threads.map((thread) => <article key={thread.id} className="thread">
          <b>{thread.title}</b>
          {thread.summary && <p>{thread.summary}</p>}
        </article>)}
      </section>}
      {quests.length > 0 && <section className="party-signal-group">
        <h3>Активные задачи</h3>
        {quests.map((quest) => <article key={quest.id}>
          <b>{quest.title}</b>
          {quest.summary && <p>{quest.summary}</p>}
          {quest.objectives?.length ? <ul>{quest.objectives.slice(0, 4).map((objective) => <li key={objective}>{objective}</li>)}</ul> : null}
          {quest.clock && quest.clock.max > 0 && <small>{localizedQuestClockLabel(quest.clock.label)} · {quest.clock.current}/{quest.clock.max}</small>}
        </article>)}
      </section>}
      {reputation.length > 0 && <section className="party-signal-group reputation-impact">
        <h3>Как слава влияет на правила</h3>
        <p>Показывается только публичная ступень — скрытый счёт репутации остаётся у сервера.</p>
        <dl>{reputation.map((entry) => {
          const impact = reputationImpactForTier(entry.tier)
          const price = impact.pricePercent === 0 ? 'цены без поправки' : impact.pricePercent < 0 ? `цены дешевле на ${Math.abs(impact.pricePercent)}%` : `цены дороже на ${impact.pricePercent}%`
          const dc = impact.socialDcShift === 0 ? 'СЛ без поправки' : impact.socialDcShift < 0 ? `СЛ ниже на ${Math.abs(impact.socialDcShift)}` : `СЛ выше на ${impact.socialDcShift}`
          return <div key={entry.faction_id} className={entry.tier}>
            <dt>{factionDisplayName(entry.faction_id)}<small>{REPUTATION_TIER_LABELS[entry.tier]}</small></dt>
            <dd>{price} · {dc}</dd>
          </div>
        })}</dl>
      </section>}
      {signalCount === 0 && <p className="party-signals-empty">Открытых задач, обещаний и нитей сейчас нет.</p>}
    </div>}
  </section>
}

export function CombatTurnClock({ clock, actorName, compact = false }: { clock: GameState['turn_clock']; actorName?: string; compact?: boolean }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!clock) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [clock?.deadline_at, clock?.turn_id])
  const presentation = turnClockPresentation(clock, now)
  if (!presentation) return null
  /* Компактный вид — для полоски хода: одни цифры и нить таймера, а подпись
     «до автопропуска» уходит в title и aria — в строке шириной с колонку ей
     места нет, а смысл цифр и так ясен из соседства с именем ходящего. */
  const caption = `${clock?.reaction_window_id ? 'Ответ на реакцию' : 'До автопропуска'}${actorName ? ` · ${actorName}` : ''}`
  return <div
    className={`combat-turn-clock ${compact ? 'compact' : ''} ${presentation.urgent ? 'urgent' : ''} ${presentation.expired ? 'expired' : ''}`}
    role="timer"
    aria-live={presentation.urgent ? 'polite' : 'off'}
    aria-label={`До автоматического пропуска хода${actorName ? ` ${actorName}` : ''}: ${presentation.label}`}
    title={compact ? caption : undefined}
  >
    {!compact && <small>{caption}</small>}
    <b>{presentation.label}</b>
    <span aria-hidden="true"><i style={{ width: `${presentation.remainingRatio * 100}%` }} /></span>
  </div>
}

/** Рамка фишки в момент наведения — якорь для поповера инспектора цели. */
export type TokenAnchor = { left: number; top: number; right: number; bottom: number }

export function tokenAnchor(element: Element): TokenAnchor {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

/**
 * Поповер встаёт справа от фишки, а у правого края окна — слева от неё; по
 * вертикали начинается чуть выше фишки и не выходит за низ окна. Ширина
 * фиксированная: прогноз атаки с разбором броска рассчитан на колонку в
 * 300px, и уже он читается хуже.
 */
export function targetPopoverStyle(anchor: TokenAnchor, viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight }): CSSProperties {
  const width = 300
  const margin = 12
  const fitsRight = anchor.right + margin + width <= viewport.width - margin
  const left = fitsRight ? anchor.right + margin : Math.max(margin, anchor.left - margin - width)
  const top = Math.max(margin, Math.min(anchor.top - 8, viewport.height - margin - 240))
  return { position: 'fixed', left, top, width, maxHeight: Math.max(120, viewport.height - top - margin) }
}

/**
 * Ситуативная панель колонки — перемирие, стража, добыча, таверна, почта,
 * пленники, звери, отдых — живёт чипом в одной строке, а раскрывается
 * поверх ленты, а не в штабеле: раньше девять панелей делили с хроникой
 * 384 пикселя, и хронике доставалось 78. Срочные (стража, перемирие, кость
 * на столе) раскрываются сами — см. `urgentSituational` в `DungeonMap`.
 */
export function SituationalSlot({ id, icon, label, badge, open, onToggle, onClose, children }: {
  id: string; icon: ReactNode; label: string; badge?: number | string | null; open: boolean; onToggle: (id: string) => void; onClose: () => void; children: ReactNode
}) {
  return <>
    <button type="button" className={`situational-chip${open ? ' open' : ''}`} aria-expanded={open} onClick={() => onToggle(id)}>
      {icon}<span>{label}</span>{badge != null && badge !== '' && badge !== 0 && <b>{badge}</b>}
    </button>
    {open && <div className="situational-overlay" role="dialog" aria-label={label}>
      <header><span>{icon}{label}</span><button type="button" className="icon-button" onClick={onClose} aria-label={`Закрыть: ${label}`}><X size={16} /></button></header>
      <div className="situational-overlay-body">{children}</div>
    </div>}
  </>
}

/**
 * Полоса легендарных действий: пипс на каждое, потраченные погашены.
 *
 * Форма повторяет часы квеста (`quest-clock`, `AppViews.tsx`) — `<i>` строка,
 * `<u>` пипс, `.spent` вместо `.filled`, — потому что это тот же вид знания:
 * server-owned счётчик, который стол читает взглядом, а не считает в уме.
 * Числа стат-блока сюда не приходят: сервер отдаёт только сколько всего и
 * сколько израсходовано.
 */
export function LegendaryPips({ legendary, compact = false }: { legendary: { uses: number; used: number }; compact?: boolean }) {
  const total = Math.max(0, Math.min(5, legendary.uses))
  if (total <= 0) return null
  const used = Math.max(0, Math.min(total, legendary.used))
  const label = `Легендарные действия: осталось ${total - used} из ${total}`
  return <span className={`legendary-pips ${compact ? 'compact' : ''}`} title={label} aria-label={label}>
    <i aria-hidden="true">{Array.from({ length: total }, (_, index) => <u key={index} className={index < used ? 'spent' : ''} />)}</i>
    {!compact && <b>{total - used}/{total}</b>}
  </span>
}

export function EnemyGlyph({ kind }: { kind: EnemyVisualKind }) {
  if (kind === 'construct') return <Bot size={17} />
  if (kind === 'undead') return <Skull size={17} />
  if (kind === 'beast') return <PawPrint size={17} />
  if (kind === 'mystic') return <WandSparkles size={17} />
  return <Swords size={17} />
}

export function boardVisualTheme(theme: SceneVisualTheme) {
  if (theme === 'building') return 'map-theme-interior'
  if (theme === 'temple') return 'map-theme-temple'
  if (theme === 'crypt' || theme === 'cave') return 'map-theme-cave'
  if (theme === 'common') return 'map-theme-ruins'
  return 'map-theme-wild'
}
