/**
 * Тактическая доска и всё, что живёт только на ней: фишки, колода действий,
 * часы хода, разбор броска, меню объектов сцены и NPC.
 *
 * Вынесено из `App.tsx` вторым шагом задачи 0 бэклога. Правок поведения нет —
 * только адрес кода. До выноса `App.tsx` был 3501 строку, из них 2116 занимала
 * доска: любая работа по интерфейсу конфликтовала с любой другой.
 */

import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, ChevronDown, ChevronRight, Copy, Crown, DoorOpen,
  Dices, Flame, Footprints, Gem, History, Menu, MessageSquare,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RotateCcw,
  ScrollText, Send, Settings, Shield, Sparkles, Swords, Target, Users, X,
  BrainCircuit, Check, Compass, SlidersHorizontal, Wifi, WifiOff,
  Heart, HeartCrack, HelpCircle,
  Lock, LockKeyhole, LockOpen, LogOut, ShieldCheck, RefreshCw, Store,
  Bot, PawPrint, Skull, WandSparkles, Globe2, Volume2, VolumeX, Bell, BellOff,
  Gavel, Soup, Unlink, UserLock, Handshake, ShieldAlert, Beer, Ear, Eye,
  Mail, MailOpen, MailX,
} from 'lucide-react'
import type { Account, AgentInteraction, AiHealth, BattleEvent, CampaignAiSettings, CampaignAiSettingsResponse, CampaignSummary, CombatAction, CombatMechanics, CombatReactionWindow, CombatSpell, CombatVisualBatch, EncounterProposal, Enemy, GameState, GuardResolution, LetterAddresseeKind, MapCell, MapFeedback, Merchant, Message, ParleyOutcome, PendingCheck, Player, ReputationTier, SceneObjectIntent, SummonedCreature, TacticalProp, TavernDiceApproach } from './types'
import { fetchWithTimeout, getAiHealth } from './ai-client'
import type { NarrationPreview } from './ai-client'
import {
  HARMFUL_SPELL_KINDS, REPUTATION_TIER_LABELS, battleEventText, boardTrajectoryBlockReason,
  canonicalLocationKey, combatState,
} from './app-shared'
import type { BoardCombatant } from './app-shared'
import { CharacterEditor, InventoryView } from './InventoryViews'
import { CharacterCreationWizard } from './CharacterCreationWizard'
import { DiceTray } from './DiceTray'
import { useGameSession, type BeastAction, type CaptiveAction, type CaptiveInterrogationSkill, type CommandOutcome, type ConnectionState, type EncounterAssemblyOptions, type ShopAssemblyOptions, type WeaponAttackChoice } from './useGameSession'
import { chronicleMatchesFilter, isChronicleNearBottom, type ChronicleFilter } from './chat-chronicle.mjs'
import { CELL_FEET, currentTacticalTurn, mapGridDimensions } from './tactical-engine'
import { battleRollContext, battleRollPresentation, boardPositionKey, buildMovementPaths, conditionPresentation, evaluateCombatTarget, levelIndicatorRows, levelTransitionHint, levelTransitionPresentation, mechanicsSupportPresentation, movementCellReason, movementCostLabel, turnClockPresentation, type MovementPath } from './tactical-ui'
import { fallbackCombatActions, fallbackCombatResources } from './combat-actions'
import { fallbackCombatSpells, fallbackSpellResources } from './combat-spells'
import { AgentLabView } from './AgentLabView'
import { MerchantScreen } from './MerchantView'
import { CombatIcon } from './CombatIcon'
import { TacticalBoard, type BoardAnimationActor, type BoardCellHint, type BoardCellNode } from './TacticalBoard'
import { drawLingeringSpellEffects, type BoardAreaEffect, type BoardEffectRenderer, type BoardOverlayCell } from './board-render'
import { areaCells } from './area-geometry'
import {
  createPersistentSpellEffectsRenderer,
  persistentSpellEffectsFromProjection,
  systemPrefersReducedMotion,
} from './spell-effects'
import { doorsReachableFrom, sceneTacticalMap } from './tactical-map-client'
import { WorldMapView } from './WorldMapView'
import { doorDirectionFromActor, doorOverlayCells, localizedQuestClockLabel, selectedAttackForecast, shouldAutoOpenCampaignModal } from './desktop-ui.mjs'
import { boardMapArtForTheme, resolveSceneTheme, sceneIllustrationForTheme, type SceneArt, type SceneVisualTheme } from './scene-art'
import {
  createAtmosphereAudio,
  loadAtmosphereSettings,
  normalizeAtmosphereMood,
  saveAtmosphereSettings,
  type AtmosphereAudio,
  type AtmosphereSettings,
} from './atmosphere-audio'
import {
  NEWBIE_GUIDE_DISMISSED_KEY,
  confirmedLevelUps,
  battleEventParticipantIds,
  factionDisplayName,
  latestNpcTurnEvents,
  levelUpSeenKey,
  recentDamageForTarget,
  reputationImpactForTier,
  sceneNpcsAt,
  visibleNpcStance,
  type ConfirmedLevelUp,
} from './player-experience'

export type EnemyVisualKind = 'construct' | 'undead' | 'beast' | 'mystic' | 'raider'

export type PresentedCondition = ReturnType<typeof conditionPresentation>

export const TOKEN_CONDITION_GLYPHS: Record<string, string> = {
  paralyzed: '✦',
  restrained: '⌁',
  prone: '▰',
  frightened: '!',
}

export const TOKEN_CONDITION_PRIORITY = ['paralyzed', 'restrained', 'prone', 'frightened']

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
    <small>{context.mode === 'advantage' ? 'ПРЕИМУЩЕСТВО' : 'ПОМЕХА'}</small>
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
export const TILE_ROWS_KEY = 'skazanie-tile-rows-v1'
export const TILE_LOCK_KEY = 'skazanie-tiles-locked-v1'
export const TILE_ORDER_KEY = 'skazanie-tile-order-v1'
export const MAP_LEGEND_KEY = 'skazanie-map-legend-open-v1'
export const BASE_ATTACK_ID = '__base-attack__'
export const SCENE_OBJECT_VERB_LABELS: Record<SceneObjectIntent, string> = {
  inspect: 'Осмотреть',
  open: 'Открыть',
  take: 'Взять',
  use: 'Использовать',
  topple: 'Опрокинуть',
  ignite: 'Поджечь',
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
export const SPELL_OPTION_LABELS: Record<string, string> = {
  approach: 'Подойди',
  drop: 'Брось',
  flee: 'Убегай',
  grovel: 'Падай',
  halt: 'Стой',
  acid: 'Кислота',
  bludgeoning: 'Дробящий',
  cold: 'Холод',
  fire: 'Огонь',
  lightning: 'Молния',
  necrotic: 'Некротический',
  piercing: 'Колющий',
  poison: 'Яд',
  radiant: 'Излучение',
  slashing: 'Рубящий',
  thunder: 'Звук',
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

export type CombatMode = 'weapon' | 'magic' | 'action'
export type CombatDeck = 'common' | 'weapon' | 'magic' | 'class' | 'items'
export type PendingCombatCommand =
  | { kind: 'target'; targetId: string; attackMode?: WeaponAttackChoice['attackMode']; attackAbility?: WeaponAttackChoice['attackAbility']; sneakAttack?: boolean }
  | { kind: 'area'; x: number; y: number }
  | { kind: 'spell-target'; targetId: string }
  | { kind: 'spell-point'; x: number; y: number }
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
    verb === 'inspect' || verb === 'open' || verb === 'take' || verb === 'use'
    || verb === 'topple' || verb === 'ignite'
  )))]
}

export function sceneObjectLabel(prop: TacticalProp) {
  return prop.interaction?.pointOfInterest ? 'Точка интереса' : 'Объект сцены'
}

export function hasClearBoardTrajectory(state: GameState, from: { x: number; y: number }, to: { x: number; y: number }) {
  return boardTrajectoryBlockReason(state, from, to) == null
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
function NpcTokenPortrait({ campaignId, npcId, name }: { campaignId: string; npcId: string; name: string }) {
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
        key={condition.id}
        className={condition.status}
        data-condition={condition.id}
        aria-label={condition.label}
        title={`${condition.label} · ${condition.statusLabel}. ${condition.explanation}`}
      >
        {TOKEN_CONDITION_GLYPHS[condition.id] ?? condition.label.slice(0, 1)}
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
  const [expired, setExpired] = useState<string[]>([])
  const timers = useRef(new Map<string, number>())
  // Ключ по идентификаторам: объект состояния пересоздаётся на каждой проекции,
  // а набор отметок при этом тот же — пересчёт по ссылке перезапускал бы отсчёт.
  const idKey = (feedback ?? []).map((item) => String(item.id)).join('|')
  const items = useMemo(() => feedback ?? [], [idKey])
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
      {roll.natural != null && <><span><small>МОДИФИКАТОР</small><b>{roll.modifierText}</b></span><i aria-hidden="true">=</i></>}
      <span className="total"><small>ИТОГ</small><b>{roll.total}</b></span>
      {roll.difficulty != null && <><i aria-hidden="true">против</i><span><small>{roll.difficultyLabel}</small><b>{roll.difficulty}</b></span></>}
    </div>
    <strong>{roll.success ? 'УСПЕХ' : event.type === 'attack' ? 'ПРОМАХ' : 'НЕУДАЧА'}</strong>
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
  const primary = promises[0]?.text ?? threads[0]?.title ?? quests[0]?.title ?? 'Состояние отряда'
  const signalCount = quests.length + threads.length + promises.length
  return <section className={`party-quest-hud ${expanded ? 'expanded' : ''}`} aria-label="Задачи отряда">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <ScrollText size={15} />
      <span>
        <small>ЗАДАЧИ {quests.length} · ОБЕЩАНИЯ {promises.length} · НИТИ {threads.length}</small>
        <strong>{primary}</strong>
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

export function CombatTurnClock({ clock, actorName }: { clock: GameState['turn_clock']; actorName?: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!clock) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [clock?.deadline_at, clock?.turn_id])
  const presentation = turnClockPresentation(clock, now)
  if (!presentation) return null
  return <div
    className={`combat-turn-clock ${presentation.urgent ? 'urgent' : ''} ${presentation.expired ? 'expired' : ''}`}
    role="timer"
    aria-live={presentation.urgent ? 'polite' : 'off'}
    aria-label={`До автоматического пропуска хода${actorName ? ` ${actorName}` : ''}: ${presentation.label}`}
  >
    <small>{clock?.reaction_window_id ? 'ОТВЕТ НА РЕАКЦИЮ' : 'ДО АВТОПРОПУСКА'}{actorName ? ` · ${actorName}` : ''}</small>
    <b>{presentation.label}</b>
    <span aria-hidden="true"><i style={{ width: `${presentation.remainingRatio * 100}%` }} /></span>
  </div>
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

export function DungeonMap({ state, players, turnActorId, typingActorId, canAct, tacticalBusy, tacticalError, autoAttackRoll, scenicBackdrop, combatAnimations, visualBatch, onClearTacticalError, onStartCombat, onMove, onAttack, onAreaAttack, onCastSpell, onUseCombatAction, onChangeWeapon, onOperateDoor, onOperateSceneObject, onUseLevelTransition, onLeaveLocation, onOpenMerchant, onFinishTurn, onFreeAction, onNpcAction, onCaptiveAction, onBeastAction, onResolveGuardEncounter, onProposeParley, onSettleParley, onOpenTavernDiceRound, onAnswerTavernDiceRound, onLeaveTavernDiceRound, onOrderTavernDrink, onSendLetter, onTransferItem, onStartRest, onSpendHitPointDie, onCompleteRest, onTypingChange, narrating, statusContent, children }: {
  state: GameState
  players: Player[]
  turnActorId: string
  typingActorId: string
  canAct: boolean
  tacticalBusy: boolean
  tacticalError: string | null
  autoAttackRoll: boolean
  scenicBackdrop: boolean
  combatAnimations: boolean
  visualBatch: CombatVisualBatch | null
  onClearTacticalError: () => void
  onStartCombat: () => Promise<CommandOutcome>
  onMove: (actorId: string, x: number, y: number) => Promise<CommandOutcome>
  onAttack: (actorId: string, enemyId: string, itemId?: string, choice?: WeaponAttackChoice) => Promise<CommandOutcome>
  onAreaAttack: (actorId: string, itemId: string, x: number, y: number, note?: string) => Promise<CommandOutcome>
  onCastSpell: (actorId: string, spellId: string, target: (({ targetId: string } | { x: number; y: number }) & { spellOption?: string; knockOut?: boolean; note?: string })) => Promise<CommandOutcome>
  onUseCombatAction: (actorId: string, actionId: string, targetId?: string, itemId?: string, beneficiaryId?: string, note?: string) => Promise<CommandOutcome>
  onChangeWeapon: (actorId: string, itemId: string) => Promise<CommandOutcome>
  onOperateDoor: (actorId: string, doorId: string, intent: 'open' | 'close' | 'force') => Promise<CommandOutcome>
  onOperateSceneObject: (actorId: string, propId: string, intent: SceneObjectIntent) => Promise<CommandOutcome>
  onUseLevelTransition: (actorId: string, propId: string) => Promise<CommandOutcome>
  onLeaveLocation: () => void
  onOpenMerchant: (merchantId: string) => void
  onFinishTurn: () => Promise<CommandOutcome>
  onFreeAction: (text: string) => Promise<CommandOutcome>
  onNpcAction: (text: string, npcId: string) => Promise<CommandOutcome>
  onCaptiveAction: (captiveId: string, action: CaptiveAction, skill?: CaptiveInterrogationSkill) => Promise<CommandOutcome>
  onBeastAction: (beastId: string, action: BeastAction) => Promise<CommandOutcome>
  onResolveGuardEncounter: (resolution: GuardResolution, skill?: 'stealth' | 'athletics') => Promise<CommandOutcome>
  onProposeParley: (skill: 'persuasion' | 'intimidation') => Promise<CommandOutcome>
  onSettleParley: (outcome: ParleyOutcome) => Promise<CommandOutcome>
  onOpenTavernDiceRound: (npcId: string, stakeCp: number) => Promise<CommandOutcome>
  onAnswerTavernDiceRound: (approach: TavernDiceApproach) => Promise<CommandOutcome>
  onLeaveTavernDiceRound: () => Promise<CommandOutcome>
  onOrderTavernDrink: () => Promise<CommandOutcome>
  onSendLetter: (addresseeKind: LetterAddresseeKind, addresseeId: string, body: string) => Promise<CommandOutcome>
  onTransferItem: (itemId: string, npcId: string, quantity: number) => Promise<CommandOutcome>
  onStartRest: (kind: 'short' | 'long') => Promise<CommandOutcome>
  onSpendHitPointDie: () => Promise<CommandOutcome>
  onCompleteRest: () => Promise<CommandOutcome>
  onTypingChange: (actorId: string, typing: boolean) => void
  narrating: boolean
  statusContent: React.ReactNode
  children?: React.ReactNode
}) {
  const [freeText, setFreeText] = useState('')
  const freeInputRef = useRef<HTMLInputElement | null>(null)
  const typingTimeoutRef = useRef<number | null>(null)
  const typingActiveRef = useRef(false)
  const [openTokenLabelId, setOpenTokenLabelId] = useState<string | null>(null)
  const [linkedParticipantIds, setLinkedParticipantIds] = useState<string[]>([])
  const [npcDossier, setNpcDossier] = useState<{ npcId: string; mode: 'talk' | 'inspect' | 'transfer' } | null>(null)
  // Как отряд собирается уходить от стражи. Выбор влияет только на навык
  // проверки: СЛ и состав проверяющих остаются серверными.
  const [guardEscapeSkill, setGuardEscapeSkill] = useState<'stealth' | 'athletics'>('stealth')
  // С кем и на что играем. Оба поля — только выбор из серверных списков:
  // соперника и ставку сервер всё равно проверит своей карточкой заведения.
  const [tavernOpponentId, setTavernOpponentId] = useState('')
  const [tavernStakeCp, setTavernStakeCp] = useState(0)
  // Сдача ждёт подтверждения, как и любая необратимая команда на этой панели.
  // Хранится идентификатор раунда, а не флаг: раунд может закрыться и открыться
  // заново, пока игрок держит палец над кнопкой, и подтверждение от прошлой
  // кости не должно достаться следующей.
  const [tavernSurrenderRoundId, setTavernSurrenderRoundId] = useState('')
  // Кому и что пишем. Оба поля — черновик в браузере и ничего больше: адресата
  // сервер всё равно сверит со своим списком, а текст письма он режет сам.
  const [letterAddresseeId, setLetterAddresseeId] = useState('')
  const [letterBody, setLetterBody] = useState('')
  const [lettersOpen, setLettersOpen] = useState(false)
  const [npcDialogueText, setNpcDialogueText] = useState('')
  const [selectedGiftItemId, setSelectedGiftItemId] = useState('')
  const [giftQuantity, setGiftQuantity] = useState(1)
  const npcDialogueInputRef = useRef<HTMLInputElement | null>(null)
  const publishTyping = useCallback((typing: boolean) => {
    if (typingActiveRef.current === typing) return
    typingActiveRef.current = typing
    onTypingChange(typingActorId, typing)
  }, [onTypingChange, typingActorId])
  const updateFreeText = (value: string) => {
    setFreeText(value)
    if (typingTimeoutRef.current !== null) window.clearTimeout(typingTimeoutRef.current)
    const typing = Boolean(value.trim()) && !narrating
    publishTyping(typing)
    if (typing) typingTimeoutRef.current = window.setTimeout(() => publishTyping(false), 1_500)
  }
  useEffect(() => () => {
    if (typingTimeoutRef.current !== null) window.clearTimeout(typingTimeoutRef.current)
    if (typingActiveRef.current) {
      typingActiveRef.current = false
      onTypingChange(typingActorId, false)
    }
  }, [onTypingChange, typingActorId])
  /* Высота панели и ширина хроники переживают перезагрузку. Описание действия
     больше не отделено ручкой: она дробила нижнюю полосу и заставляла текст
     переноситься, хотя рядом оставалось свободное место. */
  const [railHeight, setRailHeight] = useState(() => Number(window.localStorage.getItem(RAIL_HEIGHT_KEY)) || 0)
  const [serverWidth, setServerWidth] = useState(() => Number(window.localStorage.getItem(SERVER_WIDTH_KEY)) || 0)
  /* Рядов плиток — один или два. Раньше их считал `auto-fill` от высоты
     карточки, и в «Основных» получалась петля: плитки не влезали по ширине,
     появлялся ползунок, он съедал высоту, второй ряд переставал помещаться —
     и колода оставалась в один ряд, хотя место было. Теперь это решение
     игрока, а не побочный эффект. */
  const [tileRows, setTileRows] = useState(() => (Number(window.localStorage.getItem(TILE_ROWS_KEY)) === 1 ? 1 : 2))
  /* Замок бережёт расстановку от случайного перетаскивания в бою: пока он
     закрыт, плитки только нажимаются. Порядок хранится по герою и колоде. */
  const [tilesLocked, setTilesLocked] = useState(() => window.localStorage.getItem(TILE_LOCK_KEY) !== 'unlocked')
  const [tileOrder, setTileOrder] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(window.localStorage.getItem(TILE_ORDER_KEY) ?? '{}') as Record<string, string[]> } catch { return {} }
  })
  const [draggedTileId, setDraggedTileId] = useState<string | null>(null)
  /* Легенда доски свёрнута по умолчанию: она нужна новичку и первому вечеру, а
     дальше только занимает угол стола. Своё состояние она помнит между
     сессиями — тем же способом, что высота панели и раскладка плиток. */
  const [legendOpen, setLegendOpen] = useState(() => window.localStorage.getItem(MAP_LEGEND_KEY) === 'open')
  const [hoveredDoorId, setHoveredDoorId] = useState<string | null>(null)
  const [selectedSceneObjectId, setSelectedSceneObjectId] = useState<string | null>(null)
  const [hoveredSceneObjectId, setHoveredSceneObjectId] = useState<string | null>(null)
  useEffect(() => {
    const root = document.documentElement.style
    if (railHeight) root.setProperty('--ui-rail-height', `${railHeight}px`)
    else root.removeProperty('--ui-rail-height')
    if (serverWidth) root.setProperty('--ui-server-column', `${serverWidth}px`)
    else root.removeProperty('--ui-server-column')
    root.setProperty('--ui-tile-rows', String(tileRows))
    window.localStorage.setItem(TILE_ROWS_KEY, String(tileRows))
  }, [railHeight, serverWidth, tileRows])
  const startRailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = document.querySelector('.turn-rail')?.getBoundingClientRect().height ?? 292
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(window.innerHeight * .45, Math.max(196, startHeight + (startY - moveEvent.clientY))))
      setRailHeight(next)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setRailHeight((value) => { if (value) window.localStorage.setItem(RAIL_HEIGHT_KEY, String(value)); return value })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const startServerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = document.querySelector('.server-column')?.getBoundingClientRect().width ?? 320
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(window.innerWidth * .32, Math.max(240, startWidth + (startX - moveEvent.clientX))))
      setServerWidth(next)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      setServerWidth((value) => { if (value) window.localStorage.setItem(SERVER_WIDTH_KEY, String(value)); return value })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const [focusedParticipantId, setFocusedParticipantId] = useState<string | null>(null)
  const [combatMode, setCombatMode] = useState<CombatMode>('weapon')
  const [activeDeck, setActiveDeck] = useState<CombatDeck>('weapon')
  const [selectedItemId, setSelectedItemId] = useState(BASE_ATTACK_ID)
  const [selectedSpellId, setSelectedSpellId] = useState('')
  const [selectedSpellOption, setSelectedSpellOption] = useState('')
  const [selectedCombatActionId, setSelectedCombatActionId] = useState('')
  const [attackMode, setAttackMode] = useState<WeaponAttackChoice['attackMode']>()
  const [attackAbility, setAttackAbility] = useState<WeaponAttackChoice['attackAbility']>()
  const [sneakAttack, setSneakAttack] = useState(false)
  const [knockOut, setKnockOut] = useState(false)
  const [spellbookOpen, setSpellbookOpen] = useState(false)
  const [spellSearch, setSpellSearch] = useState('')
  const [spellLevelFilter, setSpellLevelFilter] = useState<number | 'all'>('all')
  const [hotbarSpellIds, setHotbarSpellIds] = useState<string[]>([])
  const [aimCell, setAimCell] = useState<{ x: number; y: number } | null>(null)
  const [pendingCommand, setPendingCommand] = useState<PendingCombatCommand | null>(null)
  const [hoveredMoveKey, setHoveredMoveKey] = useState<string | null>(null)
  const [pendingMoveKey, setPendingMoveKey] = useState<string | null>(null)
  const [inspectedTarget, setInspectedTarget] = useState<{ id: string; name: string; team: 'ally' | 'enemy'; hp?: number; maxHp?: number; healthLabel?: string; distanceFeet: number; allowed: boolean; reason: string | null } | null>(null)
  const { columns: cellColumns, rows: cellRows } = mapGridDimensions(state.scene.cells)
  // Канон сцены — `scene.map`; старая проекция без него собирается из клеток.
  const boardMap = useMemo(() => sceneTacticalMap(state.scene), [state.scene])
  // Этаж входит в сброс наравне с локацией: лестница, у которой стоял герой,
  // на новом этаже не существует, а идентификаторы предметов у карт свои.
  useEffect(() => setSelectedSceneObjectId(null), [boardMap?.locationId, boardMap?.levelIndex])
  const columns = boardMap?.width ?? cellColumns
  const rows = boardMap?.height ?? cellRows
  const irregularMap = state.scene.cells.length < columns * rows
  const combat = combatState(state)
  const combatActive = Boolean(combat.active && combat.initiative?.length)
  // Перемирие. Пока оно держится, очередь заморожена сервером, и доска обязана
  // это показать: рамка вокруг поля, карточка условий и заглушённый хотбар.
  const truce = combatActive ? combat.truce ?? null : null
  const parleyAttempted = Math.max(0, Number(combat.parley_attempts) || 0) > 0
  const activeInitiativeIndex = Math.max(0, Number(combat.active_index) || 0)
  const visibleBattleRoll = useTransientBattleRoll(state.battleLog)
  const visibleBattleRollContext = visibleBattleRoll ? battleRollContext(visualBatch?.events, visibleBattleRoll) : null
  const visibleNpcTactic = useTransientNpcTactic(visualBatch, state.battleLog)
  const activeHero = players.find((player) => player.id === turnActorId)
  const activeRest = activeHero ? state.mechanics?.resting?.[activeHero.id] : undefined
  const hitPointDice = activeHero ? state.mechanics?.hit_point_dice?.[activeHero.id] : undefined
  const hitPointDiceRemaining = hitPointDice ? Math.max(0, hitPointDice.maximum - hitPointDice.spent) : 0
  const hitPointDieBlockedReason = !activeHero
    ? 'Отдых доступен только герою.'
    : activeHero.hp <= 0
      ? 'Без хитов нельзя тратить кости хитов.'
      : activeHero.hp >= activeHero.maxHp
        ? 'У героя уже полные хиты.'
        : hitPointDiceRemaining <= 0
          ? 'Все кости хитов потрачены.'
          : null
  const activeSummon = state.actors?.find((actor) => actor.id === turnActorId && actor.alive)
  const activeEnemy = state.enemies?.find((enemy) => enemy.id === turnActorId && enemy.alive)
  const activeTurnLabel = !combatActive ? 'ИДЁТ СВОБОДНО' : activeEnemy ? 'ХОД ПРОТИВНИКА' : activeSummon ? 'ХОД ПРИЗЫВА' : 'ХОД ИГРОКА'
  const active: BoardCombatant | undefined = activeHero ?? activeSummon
  const activeName = activeHero?.character ?? activeSummon?.name ?? activeEnemy?.name ?? 'участник боя'
  const sceneLocationId = state.scene.location_id ?? boardMap?.locationId ?? ''
  const combatActorIds = new Set([
    ...players.map((player) => player.id),
    ...(state.enemies ?? []).map((enemy) => enemy.id),
    ...(state.actors ?? []).map((actor) => actor.id),
  ])
  // PR #18 отдаёт только viewer-safe scene_npcs. Без этого optional-контракта
  // клиент не рисует spawn-point как персонажа и не угадывает координаты.
  const sceneNpcs = sceneNpcsAt(state.scene_npcs ?? [], sceneLocationId, { columns, rows }, combatActorIds)
  const actorNameById = (id?: string) => {
    if (!id) return ''
    return players.find((player) => player.id === id)?.character
      ?? state.enemies?.find((enemy) => enemy.id === id)?.name
      ?? state.actors?.find((actor) => actor.id === id)?.name
      ?? id
  }
  const npcTacticText = visibleNpcTactic?.tactic
    ? (() => {
        const actorName = actorNameById(visibleNpcTactic.actor_id)
        const targetName = actorNameById(visibleNpcTactic.target_id)
        const action = !targetName
          ? `${actorName} меняет план`
          : visibleNpcTactic.tactic === 'тактика стаи'
            ? `${actorName} бросается на ${targetName}`
            : visibleNpcTactic.tactic.includes('сковать')
              ? `${actorName} пытается сковать ${targetName}`
              : visibleNpcTactic.tactic.includes('дистанц') || visibleNpcTactic.tactic.includes('лини')
                ? `${actorName} маневрирует против ${targetName}`
                : `${actorName} действует против ${targetName}`
        return `${action} — ${visibleNpcTactic.tactic}`
      })()
    : null
  const animationActors: BoardAnimationActor[] = [
    ...players.map((player) => ({ id: player.id, x: player.x, y: player.y, label: player.character, color: player.color, kind: 'hero' as const })),
    ...(state.enemies ?? []).map((enemy) => ({ id: enemy.id, x: enemy.x, y: enemy.y, label: enemy.name, color: '#c86c5d', kind: 'enemy' as const })),
    ...(state.actors ?? []).map((actor) => ({ id: actor.id, x: actor.x, y: actor.y, label: actor.name, color: '#70a78b', kind: 'summon' as const })),
    ...sceneNpcs.filter((npc) => npc.alive).map((npc) => ({ id: npc.id, x: npc.x, y: npc.y, label: npc.name, color: '#9d8f72', kind: 'neutral' as const })),
  ]
  const npcSummaryEvents = latestNpcTurnEvents(state.battleLog ?? [])
  const recentCombatJournal = (state.battleLog ?? []).slice(-6).reverse()
  // Пленные приезжают отдельной серверной веткой проекции: на доске связанный
  // выглядит обычным NPC сцены, и без этого списка отличить его было бы нечем.
  const heldCaptives = useMemo(
    () => (state.captives?.captives ?? []).filter((captive) => captive.status === 'held'),
    [state.captives],
  )
  const captiveByNpcId = useMemo(
    () => new Map(heldCaptives.map((captive) => [captive.npc_id, captive])),
    [heldCaptives],
  )
  const captiveActionsBlocked = Boolean(combatActive || narrating || tacticalBusy || !canAct)
  // Звери приезжают отдельной серверной веткой проекции: и кандидаты с
  // объявленной СЛ, и уже прирученные спутники. Своей формулы сложности здесь
  // нет и быть не должно — карточку собрал сервер (`server/beast-taming.mjs`).
  const beastCandidates = useMemo(
    () => (state.beasts?.candidates ?? []).filter((candidate) => !candidate.blocked_reason),
    [state.beasts],
  )
  const beastCompanions = useMemo(() => state.beasts?.companions ?? [], [state.beasts])
  // В бою зверя не уговаривают — сервер уже вычеркнул таких из кандидатов, — а
  // спутник в бой не вводится вовсе, поэтому его кнопка блокируется тем же
  // условием, что и действия с пленным.
  const beastActionsBlocked = Boolean(combatActive || narrating || tacticalBusy || !canAct)
  // Встреча со стражей приезжает готовой карточкой: подписи исходов, размер
  // виры и СЛ побега считает сервер (`server/law-and-order.mjs`). Своей таблицы
  // ступеней здесь нет и быть не может — точной ступени игрок не видит вовсе.
  const guardEncounter = state.law?.encounter ?? null
  const guardFineCp = Number(guardEncounter?.fine_cp ?? 0)
  const activeHeroPurse = players.find((player) => player.id === typingActorId)?.currency
  // Кошелёк героя в медяках. Считается один раз: и вира стражи, и ставка за
  // костями, и кружка спрашивают у него одно и то же, а три копии одной суммы
  // разошлись бы при первой правке номиналов.
  const activeHeroPurseCp = (activeHeroPurse?.copper ?? 0)
    + (activeHeroPurse?.silver ?? 0) * 10
    + (activeHeroPurse?.gold ?? 0) * 100
    + (activeHeroPurse?.platinum ?? 0) * 1_000
  const canPayGuardFine = activeHeroPurseCp >= guardFineCp
  // Досуг таверны приезжает готовой карточкой: список соперников, набор ставок,
  // цена кружки и СЛ следующего спасброска посчитаны сервером
  // (`server/tavern-life.mjs`). Своей таблицы цен и своей проверки «а таверна
  // ли это» здесь нет: карточки нет — панели нет.
  const tavern = state.tavern ?? null
  const tavernOpponents = tavern?.opponents ?? []
  const tavernStakes = tavern?.stakes ?? []
  const tavernRound = tavern?.round ?? null
  const chosenTavernOpponentId = tavernOpponents.some((npc) => npc.id === tavernOpponentId)
    ? tavernOpponentId
    : tavernOpponents[0]?.id ?? ''
  const chosenTavernStakeCp = tavernStakes.some((stake) => stake.stake_cp === tavernStakeCp)
    ? tavernStakeCp
    : tavernStakes[0]?.stake_cp ?? 0
  // Ставка ограничена не только своим кошельком, но и чужим: банк соперника
  // приходит из его кармана, и сервер откажет в ставке, которую ему нечем
  // закрыть. Кнопка обязана показать это до клика, а не после отказа.
  const tavernOpponentMaxStakeCp = Number(tavernOpponents.find((npc) => npc.id === chosenTavernOpponentId)?.max_stake_cp ?? 0)
  const tavernActionsBlocked = Boolean(combatActive || narrating || tacticalBusy || !canAct)
  // Ответить на кость нельзя ровно в одном положении: героя выставили за дверь,
  // и с ним больше не садятся. Тупиком это не является — встать из-за стола он
  // может, — но кнопки ответа обязаны гаснуть до клика, а не приносить отказ
  // после него.
  //
  // Своей арифметики чужой кассы здесь нет и быть не должно: поводов «отвечать
  // нечем» из-за денег соседа не существует по построению — касса закрепляет
  // выплату за раундом с самого открытия (`tavernFreePurseFor`,
  // `server/tavern-life.mjs`).
  const tavernPatronEjected = tavern?.ejected === true
  // Уход из-за стола стоит всей ставки всегда: она уже лежит на столе (её сняли
  // с кошелька, когда кость легла), и назад её приносит только расчёт.
  // Возвратов у сдачи нет ни одного, поэтому и вопрос «вернут ли» доска больше
  // не задаёт — она называет цену.
  //
  // Раз цена одна и необратима, подтверждение спрашивается всегда — тем же
  // порядком, каким на этой панели проходят команды с целью.
  const tavernSurrenderPending = Boolean(tavernRound && tavernSurrenderRoundId === tavernRound.id)
  // Почта отряда. Карточка приезжает готовой (`server/courier-letters.mjs`):
  // список адресатов уже посчитан по дорогам карты мира, у каждого стоит своя
  // цена курьера и свой срок. Досчитывать здесь нечего и нечем — второй
  // арифметики дальности в проекте нет.
  const letterAddressees = (state.courier_letters?.addressees ?? []).filter((entry) => entry.unreachable !== true)
  const heroLetters = (state.courier_letters?.letters ?? []).filter((letter) => letter.hero_id === typingActorId)
  const heroLettersInTransit = heroLetters.filter((letter) => letter.status === 'in_transit')
  const letterOpenLimit = Number(state.courier_letters?.open_limit ?? 3)
  const letterBodyLimit = Number(state.courier_letters?.body_limit ?? 1_200)
  const chosenLetterAddressee = letterAddressees.find((entry) => entry.id === letterAddresseeId) ?? letterAddressees[0] ?? null
  const letterFeeCp = Number(chosenLetterAddressee?.fee_cp ?? 0)
  // Отказы движка названы до клика, а не после него: посреди боя писем не
  // пишут, кошелёк не уходит в минус, и четвёртое письмо героя курьер не берёт.
  const letterBlockReason = combatActive
    ? 'Посреди боя писем не пишут'
    : !canAct || narrating || tacticalBusy
      ? 'Сейчас ход не ваш'
      : !chosenLetterAddressee
        ? 'Отряд пока не знает никого, кому можно написать'
        : heroLettersInTransit.length >= letterOpenLimit
          ? `У героя и так ${heroLettersInTransit.length} писем в дороге`
          : activeHeroPurseCp < letterFeeCp
            ? 'На курьера не хватает монет'
            : !letterBody.trim()
              ? 'Пустое письмо курьер не повезёт'
              : ''
  const dossierSceneNpc = npcDossier ? sceneNpcs.find((npc) => npc.id === npcDossier.npcId) ?? null : null
  const dossierCaptive = dossierSceneNpc ? captiveByNpcId.get(dossierSceneNpc.id) ?? null : null
  const dossierSocialNpc = dossierSceneNpc
    ? state.social?.npcs?.find((npc) => npc.id === dossierSceneNpc.id) ?? null
    : null
  const dossierMerchant = dossierSceneNpc
    ? state.merchants?.find((merchant) => merchant.id === dossierSceneNpc.id) ?? null
    : null
  const dossierRelationship = dossierSceneNpc
    ? state.social?.relationship_tiers?.[dossierSceneNpc.id]?.[typingActorId] ?? 'neutral'
    : 'neutral'
  const dossierConversations = dossierSceneNpc
    ? (state.social?.conversations ?? []).filter((conversation) => conversation.npc_id === dossierSceneNpc.id).slice(-6).reverse()
    : []
  const dossierPromises = dossierSceneNpc
    ? (state.social?.promises ?? []).filter((promise) => promise.npc_id === dossierSceneNpc.id && promise.status === 'open')
    : []
  const giftSender = players.find((player) => player.id === typingActorId)
  const transferableGiftItems = (giftSender?.inventory ?? []).filter((item) => (
    Number(item.quantity ?? 0) > 0
    && !item.equipped
    && !item.attuned_to
  ))
  const selectedGiftItem = transferableGiftItems.find((item) => item.id === selectedGiftItemId) ?? null
  const selectedGiftAvailable = Math.max(0, Math.floor(Number(selectedGiftItem?.quantity ?? 0)))
  const dossierCanTalk = Boolean(
    dossierSceneNpc?.alive
    && dossierSocialNpc?.available !== false
    && !combatActive
    && canAct
    && !narrating,
  )
  const dossierCanReceiveGift = Boolean(
    dossierSceneNpc?.alive
    && dossierSocialNpc?.available !== false
    && !combatActive
    && canAct
    && !narrating
    && !tacticalBusy,
  )
  useEffect(() => {
    setNpcDossier(null)
    setNpcDialogueText('')
    setSelectedGiftItemId('')
    setGiftQuantity(1)
  }, [sceneLocationId])
  useEffect(() => {
    if (npcDossier?.mode !== 'talk') return
    npcDialogueInputRef.current?.focus()
  }, [npcDossier?.mode, npcDossier?.npcId])
  const animatedBattleLog = useMemo(() => {
    const recentIds = new Set((state.battleLog ?? []).slice(-12).map((event) => event.id))
    return (state.battleLog ?? []).map((event) => {
      if (event.type !== 'move' || event.path?.length || !event.actorId || !event.from || !event.to || !recentIds.has(event.id)) return event
      const playersAtMove = state.players.map((actor) => actor.id === event.actorId ? { ...actor, ...event.from } : actor)
      const enemiesAtMove = (state.enemies ?? []).map((actor) => actor.id === event.actorId ? { ...actor, ...event.from, alive: true } : actor)
      const actorsAtMove = (state.actors ?? []).map((actor) => actor.id === event.actorId ? { ...actor, ...event.from, alive: true } : actor)
      const projectedAtMove = { ...state, players: playersAtMove, enemies: enemiesAtMove, actors: actorsAtMove }
      const route = buildMovementPaths(projectedAtMove, { id: event.actorId, ...event.from }, CELL_FEET, boardMap)
        .get(boardPositionKey(event.to.x, event.to.y))
      return { ...event, path: route?.path ?? [event.to] }
    })
  }, [state.battleLog, state.players, state.enemies, state.actors, state.scene.cells, boardMap])
  const participantDefeated = (actorId: string) => {
    const hero = state.players.find((player) => player.id === actorId)
    const enemy = state.enemies?.find((item) => item.id === actorId)
    const summon = state.actors?.find((item) => item.id === actorId)
    return hero ? hero.hp <= 0 : summon ? !summon.alive || summon.hp <= 0 : enemy ? !enemy.alive : false
  }
  let nextInitiativeIndex = -1
  if (combatActive && combat.initiative?.length) {
    for (let step = 1; step < combat.initiative.length; step += 1) {
      const index = (activeInitiativeIndex + step) % combat.initiative.length
      if (!participantDefeated(combat.initiative[index].actor_id)) {
        nextInitiativeIndex = index
        break
      }
    }
  }
  const combatItems = (activeHero?.inventory ?? []).map(inferredCombatItem).filter((item): item is NonNullable<typeof item> => Boolean(item && item.quantity > 0))
  const selectedItem = selectedItemId === BASE_ATTACK_ID ? undefined : combatItems.find((item) => item.id === selectedItemId)
  const selectedWeaponCatalogCombat = selectedItem?.type === 'weapon'
    ? selectedItem.combat as Player['inventory'][number]['combat']
    : undefined
  const weaponModeOptions = selectedWeaponCatalogCombat?.modes ?? []
  const weaponModeKey = weaponModeOptions.map((mode) => `${mode.id}:${mode.ability}`).join('|')
  const selectedWeaponMode = weaponModeOptions.find((mode) => mode.id === attackMode) ?? weaponModeOptions[0]
  const weaponAbilityOptions = selectedItem?.type === 'weapon'
    ? selectedWeaponCatalogCombat?.abilities ?? (selectedWeaponMode?.ability ? [selectedWeaponMode.ability] : [])
    : []
  const selectedWeaponAbility = weaponAbilityOptions.includes(attackAbility as NonNullable<WeaponAttackChoice['attackAbility']>)
    ? attackAbility
    : selectedWeaponMode?.ability
  const selectedWeaponCombat = selectedWeaponMode ?? selectedItem?.combat
  const weaponSelectionId = selectedItem?.id ?? BASE_ATTACK_ID
  const projectedSpells = activeHero?.combatSpells ?? []
  const fallbackSpells = fallbackCombatSpells(activeHero)
  const spells = [...new Map([...fallbackSpells, ...projectedSpells].map((spell) => [spell.id, spell])).values()]
  const hotbarSpells = spells.filter((spell) => hotbarSpellIds.includes(spell.id) && spellActionType(spell) !== 'reaction')
  const selectedSpell = spells.find((spell) => spell.id === selectedSpellId) ?? spells[0]
  const combatActions = activeHero ? (activeHero.combatActions?.length ? activeHero.combatActions : fallbackCombatActions(activeHero)) : []
  const selectedCombatAction = combatActions.find((action) => action.id === selectedCombatActionId) ?? null
  const selectedSpellKind = spellKind(selectedSpell)
  const selectedSpellRange = spellRange(selectedSpell)
  const activeConditionIds = new Set((state.mechanics?.conditions?.[turnActorId] ?? []).map((condition) => String(condition.id)))
  const selectedSpellAction = activeConditionIds.has('metamagic-quickened') && spellActionType(selectedSpell) === 'action' ? 'bonus_action' : spellActionType(selectedSpell)
  const activeResources = {
    ...fallbackCombatResources(activeHero),
    ...fallbackSpellResources(activeHero),
    ...((state.mechanics as { resources?: Record<string, Record<string, { current?: number; max?: number }>> } | undefined)?.resources?.[turnActorId] ?? {}),
  }
  const spellPools = selectedSpell?.slotResource
    ? selectedSpell.slotResource === 'pact_slots' || selectedSpell.slotResource === 'mystic_arcanum_6'
      ? [activeResources[selectedSpell.slotResource]].filter(Boolean)
      : Array.from({ length: Math.max(0, 7 - selectedSpell.level) }, (_, index) => activeResources[`spell_slots_${selectedSpell.level + index}`]).filter(Boolean)
    : []
  const selectedSpellPool = spellPools.find((pool) => Number(pool?.current ?? 0) > 0) ?? spellPools[0]
  const spellSlotReady = !selectedSpell?.slotResource || spellPools.some((pool) => Number(pool?.current ?? 0) > 0)
  const genericProfile = active as (BoardCombatant & { attackRange?: number; rangeFeet?: number; attack_profile?: { kind?: 'melee' | 'ranged'; range_feet?: number; normal_range_feet?: number } }) | undefined
  const baseRangeFeet = Math.max(CELL_FEET, Number(genericProfile?.attack_profile?.range_feet ?? genericProfile?.attackRange ?? genericProfile?.rangeFeet) || CELL_FEET)
  const selectedAttackKind = selectedWeaponCombat?.kind ?? genericProfile?.attack_profile?.kind ?? (baseRangeFeet <= CELL_FEET ? 'melee' : 'ranged')
  const knockoutEligible = combatMode === 'weapon'
    ? selectedAttackKind === 'melee'
    : combatMode === 'magic' && selectedSpell?.kind === 'attack' && selectedSpell.attackKind === 'melee'
  const attackRangeFeet = Math.max(CELL_FEET, Number(selectedWeaponCombat?.longRange ?? selectedWeaponCombat?.normalRange) || baseRangeFeet)
  const normalRangeFeet = Math.max(CELL_FEET, Number(selectedWeaponCombat?.normalRange ?? genericProfile?.attack_profile?.normal_range_feet) || attackRangeFeet)
  const areaRadiusFeet = selectedItem?.combat?.kind === 'thrown-area' ? Number(selectedItem.combat.radius) || 5 : 0
  const spellAreaRadiusFeet = combatMode === 'magic' && selectedSpell?.target === 'point' ? Math.max(0, Number(selectedSpell.radius) || 0) : 0
  const equippedWeapon = activeHero?.inventory.find((item) => item.type === 'weapon' && item.equipped)
  const needsWeaponChange = Boolean(selectedItem?.type === 'weapon' && !selectedItem.equipped && equippedWeapon && equippedWeapon.id !== selectedItem.id)
  const economy = combat.action_economy?.[turnActorId]
  const sneakAttackEligible = combatMode === 'weapon'
    && activeHero?.characterClass === 'rogue'
    && selectedItem?.type === 'weapon'
    && (selectedWeaponCatalogCombat?.kind === 'ranged' || selectedWeaponCatalogCombat?.abilities?.includes('dex'))
  const sneakAttackSpent = Boolean(economy?.sneak_attack_turn_key)
  const authoritativeMovementSpent = economy?.movement_remaining != null
    ? Math.max(0, (active?.speed ?? 0) - economy.movement_remaining)
    : economy?.movement_spent ?? (economy?.movement === false ? active?.speed ?? 0 : 0)
  const tacticalState = {
    ...state,
    activePlayerId: turnActorId,
    tacticalTurn: {
      sceneTurn: state.scene.turn,
      actorId: turnActorId,
      movementSpent: authoritativeMovementSpent,
      actionUsed: economy?.action === false,
    },
  }
  // Exploration and combat share the same authoritative pathfinding, but only
  // combat spends per-turn movement. Outside initiative the selected hero can
  // walk to any revealed cell connected by a legal path.
  const selected = canAct && !tacticalBusy && active ? turnActorId : null
  const tactical = currentTacticalTurn(tacticalState)
  const movementBonus = Math.max(0, Number(economy?.movement_bonus) || 0)
  const speedFeet = (active?.speed ?? 0) + movementBonus
  const remainingFeet = Math.max(0, speedFeet - tactical.movementSpent)
  const movementAvailable = !combatActive || economy?.movement !== false
  const movementPaths = active ? buildMovementPaths(state, active, CELL_FEET, boardMap) : new Map<string, MovementPath>()
  const boardEffectRenderers = useMemo<BoardEffectRenderer[]>(() => {
    const activeEffects = state.mechanics?.active_effects ?? []
    const effects: BoardAreaEffect[] = activeEffects
      .filter((effect) => Boolean(effect.center || effect.cells?.length) || effect.difficult_terrain === true)
      .map((effect) => ({
        id: effect.id,
        ...(effect.cells?.length ? { cells: effect.cells } : {}),
        ...(effect.center ? { center: effect.center } : {}),
        radiusFeet: effect.radius_feet,
        areaShape: (['sphere', 'cylinder', 'cone', 'cube', 'line'].includes(String(effect.area_shape))
          ? effect.area_shape
          : 'sphere') as BoardAreaEffect['areaShape'],
        spellId: effect.spell_id,
        sourceActor: effect.source_actor,
        ownerLabel: effect.source_actor ? actorNameById(effect.source_actor) : undefined,
        concentration: effect.concentration === true,
        difficultTerrain: effect.difficult_terrain === true,
      }))
    const persistentSpells = persistentSpellEffectsFromProjection(
      activeEffects,
      state.mechanics?.concentration ?? {},
    )
    const covered = new Set(persistentSpells.map((effect) => effect.id.replace(/^persistent:(?:area|aura):/u, '')))
    const informative = effects.filter((effect) => !covered.has(String(effect.id ?? '')) || effect.difficultTerrain)
    const renderers: BoardEffectRenderer[] = informative.length
      ? [(context, scene) => drawLingeringSpellEffects(context, scene, informative)]
      : []
    if (persistentSpells.length) {
      const reducedMotion = systemPrefersReducedMotion()
      renderers.push(createPersistentSpellEffectsRenderer(
        persistentSpells,
        animationActors,
        { detail: reducedMotion ? 'minimal' : 'reduced', reducedMotion },
      ))
    }
    return renderers
  }, [state.mechanics?.active_effects, state.mechanics?.concentration, players, state.enemies, state.actors])
  /* Двери, до которых активный участник дотягивается рукой. Открыть или закрыть
     дверь — свободное взаимодействие, выломать — действие; какое именно из них
     доступно, решает состояние полотна. */
  const doorsAtHand = active && boardMap
    ? doorsReachableFrom(boardMap, active.x, active.y).filter((door) => door.state !== 'broken')
    : []
  const interactiveSceneObjects = (boardMap?.props ?? []).filter((prop) => prop.interactive)
  const sceneObjectsAtHand = active
    ? interactiveSceneObjects.filter((prop) => sceneObjectCells(prop).some((cell) => chebyshevFeet(active, cell) <= CELL_FEET))
    : []
  const selectedSceneObject = interactiveSceneObjects.find((prop) => prop.id === selectedSceneObjectId) ?? null
  const selectedSceneObjectAtHand = Boolean(selectedSceneObject && sceneObjectsAtHand.some((prop) => prop.id === selectedSceneObject.id))
  const selectedSceneObjectVerbs = selectedSceneObject ? sceneObjectVerbs(selectedSceneObject) : []
  /* Этажи локации (`docs/multilevel-map-plan.md`, раздел 6). Номер активного
     этажа приходит проекцией; у старой кампании его нет, и это этаж входа. */
  const sceneLevelIndex = Number(state.scene.level?.index ?? boardMap?.levelIndex ?? 0) || 0
  const knownSceneLevels = state.scene.levels ?? []
  const levelStackRows = levelIndicatorRows(knownSceneLevels, sceneLevelIndex)
  /* Кнопка перехода живёт у выбранного предмета, а не отдельным списком:
     лестница — такой же объект сцены, и решение «куда веду» уже приехало в
     `transition`. Далеко или бой — кнопка видна, но закрыта с причиной. */
  const selectedLevelTransition = selectedSceneObject?.transition
    ? levelTransitionPresentation({
        transition: selectedSceneObject.transition,
        currentLevel: sceneLevelIndex,
        levels: knownSceneLevels,
        atHand: selectedSceneObjectAtHand,
        combatActive,
      })
    : null
  const sceneObjectByCell = new Map<string, TacticalProp>()
  for (const prop of [...interactiveSceneObjects].sort((left, right) => left.zOrder - right.zOrder)) {
    for (const cell of sceneObjectCells(prop)) sceneObjectByCell.set(boardPositionKey(cell.x, cell.y), prop)
  }
  const movementLimit = combatActive ? remainingFeet : Number.POSITIVE_INFINITY
  const reachable = selected && active && movementAvailable
    ? new Set([...movementPaths.entries()].filter(([, route]) => route.costFeet <= movementLimit).map(([key]) => key))
    : new Set<string>()
  const previewMoveKey = pendingMoveKey ?? hoveredMoveKey
  const previewRoute = previewMoveKey ? movementPaths.get(previewMoveKey) ?? null : null
  const previewRouteSteps = new Map((previewRoute?.path ?? []).map((step, index) => [boardPositionKey(step.x, step.y), index + 1]))
  const actionReady = !tactical.actionUsed && economy?.action !== false
  // «Дополнительная атака» — свойство действия «Атака», а не отдельная кнопка:
  // действие уже потрачено первым ударом, но оружие бьёт ещё раз, и между
  // ударами можно перемещаться.
  const weaponAttacksUsed = Math.max(0, Number(economy?.attacks_used) || 0)
  const weaponAttacksAllowed = Math.max(1, Number(economy?.attacks_allowed) || 1)
  const weaponAttacksLeft = Math.max(0, weaponAttacksAllowed - weaponAttacksUsed)
  const weaponAttackReady = actionReady || (weaponAttacksUsed > 0 && weaponAttacksLeft > 0)
  const bonusReady = economy?.bonus_action !== false
  const reactionReady = economy?.reaction !== false
  const selectedSpellSupport = mechanicsSupportPresentation(selectedSpell?.mechanicsSupport, selectedSpell?.supportNote)
  /* Вне боя экономики хода нет, а длинное накладывание, наоборот, доступно
     только там: боевая панель его не вмещает. Совпадает с правилом движка —
     `HARMFUL_SPELL_KINDS` и проверка `long_cast` в rules-engine. */
  const spellEconomyReady = !selectedSpellSupport.blocked && selectedSpell?.prepared !== false && spellSlotReady && (combatActive
    ? selectedSpellAction !== 'long_cast' && (selectedSpellAction === 'bonus_action' ? bonusReady : selectedSpellAction === 'reaction' ? reactionReady : actionReady)
    : Boolean(selectedSpell && castableOutOfCombat(selectedSpell)))
  const selectedActionPool = selectedCombatAction?.resource ? activeResources[selectedCombatAction.resource] : undefined
  const selectedActionResourceReady = !selectedCombatAction?.resource || Number(selectedActionPool?.current ?? 0) >= Number(selectedCombatAction.cost ?? 1)
  const selectedActionSupport = mechanicsSupportPresentation(selectedCombatAction?.mechanicsSupport, selectedCombatAction?.supportNote)
  const selectedActionEconomyReady = Boolean(selectedCombatAction && !selectedActionSupport.blocked && selectedActionResourceReady && (selectedCombatAction.actionType === 'free' || (selectedCombatAction.actionType === 'bonus_action' ? bonusReady : selectedCombatAction.actionType === 'reaction' ? reactionReady : actionReady)))
  const selectedCommandReady = combatMode === 'magic' ? spellEconomyReady : combatMode === 'action' ? selectedActionEconomyReady : weaponAttackReady
  /* Действие на себя цели на карте не требует, поэтому подтверждение выводится
     из самого выбора, а не хранится в `pendingCommand`: команду стирает эффект,
     который срабатывает как раз на смену выбранного заклинания. */
  const selfCastSpell = combatMode === 'magic' && selectedSpell?.target === 'self' && spellEconomyReady ? selectedSpell : null
  const selfUseAction = combatMode === 'action' && selectedCombatAction?.target === 'self' && selectedActionEconomyReady ? selectedCombatAction : null
  const selfCastReady = Boolean(selected && !tacticalBusy && (selfCastSpell || selfUseAction))
  const confirmSelfCast = async (note?: string): Promise<CommandOutcome | null> => {
    if (!selected) return null
    const outcome = selfCastSpell
      ? await onCastSpell(selected, selfCastSpell.id, { targetId: selected, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(note ? { note } : {}) })
      : selfUseAction
        ? await onUseCombatAction(selected, selfUseAction.id, undefined, selfUseAction.requiresWeapon ? selectedItem?.id : undefined, undefined, note)
        : null
    if (outcome?.ok) setCombatMode('weapon')
    return outcome
  }
  /* Выбор надо уметь снять. Вне боя плитка базовой атаки закрыта, и без этой
     кнопки подтверждение висело бы до следующего выбранного заклинания. */
  const cancelSelfCast = () => setCombatMode('weapon')
  const aliveEnemies = (state.enemies ?? []).filter((enemy) => enemy.alive && !(state.mechanics?.conditions?.[enemy.id] ?? []).some((condition) => condition.id === 'unconscious'))
  const opportunityThreats = combatActive && active && !activeConditionIds.has('disengaged') && !activeConditionIds.has('invisible')
    ? aliveEnemies.filter((enemy) => {
        const conditions = new Set((state.mechanics?.conditions?.[enemy.id] ?? []).map((condition) => String(condition.id)))
        const reactionAvailable = combat.action_economy?.[enemy.id]?.reaction !== false
        const threatProfile = enemy as Enemy & { attack_profile?: { range_feet?: number }; attackRange?: number }
        const range = Number(threatProfile.attack_profile?.range_feet ?? threatProfile.attackRange ?? 5) || 5
        return reactionAvailable
          && range <= CELL_FEET
          && !['incapacitated', 'unconscious', 'stunned', 'paralyzed'].some((condition) => conditions.has(condition))
          && chebyshevFeet(active, enemy) === CELL_FEET
      })
    : []
  const showStartCombat = aliveEnemies.length > 0 && !combatActive
  /* Вне боя плитки видны, но не нажимаются: выбор цели на карте закрыт по всему
     клиенту (`combatActive &&` в каждом правиле наведения), да и сервер отвергает
     атаку и боевое действие без инициативы — `COMBAT_NOT_ACTIVE` в rules-engine.
     Показывать живую плитку, которая никуда не ведёт, хуже, чем закрытую. */
  const actionsLocked = tacticalBusy || !combatActive
  const availableSpellLevels = [...new Set(spells.map((spell) => spell.level))].sort((left, right) => left - right)
  const normalizedSpellSearch = spellSearch.trim().toLocaleLowerCase('ru')
  const filteredSpellbookSpells = spells.filter((spell) => (spellLevelFilter === 'all' || spell.level === spellLevelFilter) && (!normalizedSpellSearch || `${spell.name} ${spell.englishName ?? ''} ${spell.description ?? ''}`.toLocaleLowerCase('ru').includes(normalizedSpellSearch)))
  const pendingPoint = pendingCommand?.kind === 'area' || pendingCommand?.kind === 'spell-point' ? pendingCommand : null
  const pendingTargetId = pendingCommand?.kind === 'target' || pendingCommand?.kind === 'spell-target' || pendingCommand?.kind === 'action-target'
    ? pendingCommand.targetId
    : null
  const pendingTarget = pendingTargetId
    ? [...players, ...(state.actors ?? []), ...(state.enemies ?? [])].find((actor) => actor.id === pendingTargetId) ?? null
    : null
  const projectileTarget = pendingPoint ?? aimCell
  const projectileEnd = pendingTarget ?? projectileTarget
  const trajectory = active && projectileEnd ? { x1: (active.x + .5) / columns * 100, y1: (active.y + .5) / rows * 100, x2: (projectileEnd.x + .5) / columns * 100, y2: (projectileEnd.y + .5) / rows * 100 } : null
  const activeConditions = (state.mechanics?.conditions?.[turnActorId] ?? []).map(conditionPresentation)
  const activeTeam = activeHero || activeSummon ? 'СОЮЗНИК' : 'ПРОТИВНИК'
  const activeHealth = active
    ? `${active.hp}/${active.maxHp} ОЗ`
    : activeEnemy ? enemyHealthPresentation(activeEnemy).label : '—'
  const selectedCommandName = combatMode === 'magic' && selectedSpell
    ? selectedSpell.name
    : combatMode === 'action' && selectedCombatAction ? selectedCombatAction.name : selectedItem?.name ?? 'Базовая атака'
  const pendingTargetName = pendingTarget
    ? ('character' in pendingTarget ? pendingTarget.character : pendingTarget.name)
    : pendingPoint ? `клетка ${pendingPoint.x + 1}:${pendingPoint.y + 1}` : ''
  const pendingCommandLabel = pendingCommand ? `${selectedCommandName} → ${pendingTargetName}` : ''
  // Прогноз выбирается под пару «выбранное оружие + наведённая/выбранная цель».
  // Все числа уже пришли с сервера; без цели helper намеренно возвращает null.
  const inspectedForecast = selectedAttackForecast(
    state.combatForecast?.targets,
    inspectedTarget?.team === 'enemy' ? inspectedTarget.id : null,
    selectedItem?.id ?? null,
  )
  const inspectedDamageHistory = inspectedTarget
    ? recentDamageForTarget(state.battleLog ?? [], inspectedTarget.id)
    : []
  const sceneTheme = resolveSceneTheme(state)
  const visualTheme = boardVisualTheme(sceneTheme)
  const mapArt = boardMapArtForTheme(sceneTheme)

  useEffect(() => {
    const defaultItem = combatItems.find((item) => item.equipped) ?? combatItems[0]
    setSelectedItemId(defaultItem?.id ?? BASE_ATTACK_ID)
    const storageKey = `skazanie-hotbar-spells:${turnActorId}`
    let saved: string[] = []
    try { saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') } catch { saved = [] }
    const eligible = saved.filter((id) => spells.some((spell) => spell.id === id && spell.prepared !== false && spellActionType(spell) !== 'reaction'))
    const defaults = spells.filter((spell) => !mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote).blocked && spell.prepared !== false && spell.actionType !== 'long_cast' && spellActionType(spell) !== 'reaction' && spell.kind !== 'utility').slice(0, 18).map((spell) => spell.id)
    const nextHotbar = eligible.length ? eligible : defaults
    setHotbarSpellIds(nextHotbar)
    setSelectedSpellId(nextHotbar[0] ?? spells[0]?.id ?? '')
    setSelectedCombatActionId('')
    setSneakAttack(false)
    setSpellbookOpen(false)
    setActiveDeck('weapon')
    setCombatMode('weapon')
  }, [turnActorId])
  useEffect(() => {
    if (selectedSpell && selectedSpell.id !== selectedSpellId) setSelectedSpellId(selectedSpell.id)
  }, [selectedSpell?.id, selectedSpellId])
  useEffect(() => {
    const options = selectedSpell?.spellOptions ?? []
    if (!options.length) setSelectedSpellOption('')
    else if (!options.includes(selectedSpellOption as typeof options[number])) setSelectedSpellOption(options[0])
  }, [selectedSpell?.id, selectedSpellOption])
  useEffect(() => {
    const defaultMode = weaponModeOptions[0]
    const mode = weaponModeOptions.find((candidate) => candidate.id === attackMode) ?? defaultMode
    const abilities = selectedWeaponCatalogCombat?.abilities ?? (mode?.ability ? [mode.ability] : [])
    setAttackMode(mode?.id)
    setAttackAbility((current) => abilities.includes(current as NonNullable<WeaponAttackChoice['attackAbility']>) ? current : mode?.ability)
  }, [selectedItem?.id, selectedWeaponCatalogCombat?.abilities?.join('|'), weaponModeKey, attackMode])
  useEffect(() => { if (!knockoutEligible) setKnockOut(false) }, [knockoutEligible])
  useEffect(() => { if (!sneakAttackEligible || sneakAttackSpent) setSneakAttack(false) }, [sneakAttackEligible, sneakAttackSpent])
  useEffect(() => {
    setPendingCommand(null)
    setPendingMoveKey(null)
    setHoveredMoveKey(null)
    setInspectedTarget(null)
    setAimCell(null)
  }, [selectedItemId, selectedSpellId, selectedCombatActionId, combatMode, turnActorId, combat.round, attackMode, attackAbility, sneakAttack])

  const chooseTarget = (enemyId: string) => {
    if (!selected || needsWeaponChange || selectedItem?.combat?.kind === 'thrown-area') return
    const choice = {
      ...(selectedWeaponMode?.id ? { attackMode: selectedWeaponMode.id } : {}),
      ...(selectedWeaponAbility ? { attackAbility: selectedWeaponAbility } : {}),
      ...(sneakAttack ? { sneakAttack: true } : {}),
      ...(knockOut && knockoutEligible ? { knockOut: true } : {}),
    }
    if (autoAttackRoll) void onAttack(selected, enemyId, selectedItem?.id, choice).then((outcome) => {
      if (outcome.ok && sneakAttack) setSneakAttack(false)
    })
    else setPendingCommand({ kind: 'target', targetId: enemyId, ...choice })
  }
  const chooseArea = (x: number, y: number) => {
    if (!selected || !selectedItem || selectedItem.combat?.kind !== 'thrown-area') return
    if (autoAttackRoll) onAreaAttack(selected, selectedItem.id, x, y)
    else setPendingCommand({ kind: 'area', x, y })
  }
  const castAtTarget = (targetId: string) => {
    if (!selected || !selectedSpell || !spellEconomyReady) return
    setPendingCommand({ kind: 'spell-target', targetId })
  }
  const castAtCell = (x: number, y: number) => {
    if (!selected || !selectedSpell || selectedSpell.target !== 'point' || !spellEconomyReady) return
    setPendingCommand({ kind: 'spell-point', x, y })
  }
  const selectSpell = (spell: CombatSpell) => {
    if (mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote).blocked) return
    setSelectedSpellId(spell.id)
    setSelectedSpellOption(spell.spellOptions?.[0] ?? '')
    setCombatMode('magic')
    /* Нажатие на плитку выбирает, а не применяет. Раньше заклинание на себя
       уходило на сервер прямо из клика: игрок открывал колоду посмотреть, что у
       героя есть, и случайно тратил ячейку. Теперь оно ждёт подтверждения —
       кнопку рисует `selfCastReady`, выведенный из выбора. Хранить его в
       `pendingCommand` нельзя: эффект ниже стирает команду как раз при смене
       выбранного заклинания. */
  }
  const toggleHotbarSpell = (spellId: string) => {
    const next = hotbarSpellIds.includes(spellId) ? hotbarSpellIds.filter((id) => id !== spellId) : [...hotbarSpellIds, spellId].slice(-24)
    setHotbarSpellIds(next)
    window.localStorage.setItem(`skazanie-hotbar-spells:${turnActorId}`, JSON.stringify(next))
  }
  const useActionAtTarget = (targetId: string) => {
    if (!selected || !selectedCombatAction || !selectedActionEconomyReady) return
    setPendingCommand({ kind: 'action-target', targetId })
  }
  const selectCombatAction = (action: CombatAction) => {
    if (mechanicsSupportPresentation(action.mechanicsSupport, action.supportNote).blocked) return
    if (!selected || tacticalBusy) return
    const pool = action.resource ? activeResources[action.resource] : undefined
    const resourceReady = !action.resource || Number(pool?.current ?? 0) >= Number(action.cost ?? 1)
    const economyReady = action.actionType === 'free' || (action.actionType === 'bonus_action' ? bonusReady : action.actionType === 'reaction' ? reactionReady : actionReady)
    if (!resourceReady || !economyReady) return
    setSelectedCombatActionId(action.id)
    setCombatMode('action')
    // Как и заклинание на себя: выбор, описание, и только потом подтверждение.
  }
  /* Что именно уедет по «Отправить». Ярлык показывается прямо в строке ввода,
     поэтому игрок видит выбранное действие там же, где пишет слова к нему. */
  const targetWord = combatMode === 'magic' && selectedSpell
    ? (selectedSpell.target === 'point' ? 'выберите клетку' : selectedSpell.target === 'ally' ? 'выберите союзника' : selectedSpell.target === 'creature' ? 'выберите существо' : 'выберите врага')
    : combatMode === 'action' && selectedCombatAction
      ? (selectedCombatAction.target === 'ally' ? 'выберите союзника' : 'выберите врага')
      : selectedItem?.combat?.kind === 'thrown-area' ? 'выберите клетку' : 'выберите цель'
  /* Пока цель не выбрана, ярлык говорит, чего он ждёт. Раньше это стояло
     строкой в колонке описания, далеко от кнопки, которой действие
     отправляют. */
  const awaitingTarget = Boolean(selected && !pendingCommand && !selfCastReady && selectedCommandReady && (
    (combatMode === 'magic' && selectedSpell && selectedSpell.target !== 'self')
    || (combatMode === 'action' && selectedCombatAction && selectedCombatAction.target !== 'self')
    || (combatMode === 'weapon' && combatActive)
  ))
  const preparedLabel = (() => {
    if (pendingCommand?.kind === 'target') return `${selectedItem?.name ?? 'Базовая атака'} → ${pendingTargetName ?? 'цель'}`
    if (pendingCommand?.kind === 'area') return `${selectedItem?.name ?? 'Бросок'} → клетка`
    if (pendingCommand?.kind === 'spell-target') return `${selectedSpell?.name ?? 'Заклинание'} → ${pendingTargetName ?? 'цель'}`
    if (pendingCommand?.kind === 'spell-point') return `${selectedSpell?.name ?? 'Заклинание'} → клетка`
    if (pendingCommand?.kind === 'action-target') return `${selectedCombatAction?.name ?? 'Действие'} → ${pendingTargetName ?? 'цель'}`
    if (selfCastSpell) return `${selfCastSpell.name} → на себя`
    if (selfUseAction) return `${selfUseAction.name} → на себя`
    if (awaitingTarget) return `${(combatMode === 'magic' ? selectedSpell?.name : combatMode === 'action' ? selectedCombatAction?.name : selectedItem?.name) ?? 'Действие'} → ${targetWord}`
    return null
  })()
  const clearPrepared = () => { setPendingCommand(null); setCombatMode('weapon') }

  const confirmPreparedCommand = async (note?: string): Promise<CommandOutcome | null> => {
    if (!selected || !pendingCommand) return null
    let outcome: CommandOutcome | null = null
    if (pendingCommand.kind === 'target') outcome = await onAttack(selected, pendingCommand.targetId, selectedItem?.id, {
      ...(pendingCommand.attackMode ? { attackMode: pendingCommand.attackMode } : {}),
      ...(pendingCommand.attackAbility ? { attackAbility: pendingCommand.attackAbility } : {}),
      ...(pendingCommand.sneakAttack ? { sneakAttack: true } : {}),
      ...(knockOut && knockoutEligible ? { knockOut: true } : {}),
      ...(note ? { note } : {}),
    })
    else if (pendingCommand.kind === 'area' && selectedItem) outcome = await onAreaAttack(selected, selectedItem.id, pendingCommand.x, pendingCommand.y, note)
    else if (pendingCommand.kind === 'spell-target' && selectedSpell) {
      outcome = await onCastSpell(selected, selectedSpell.id, { targetId: pendingCommand.targetId, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(knockOut && knockoutEligible ? { knockOut: true } : {}), ...(note ? { note } : {}) })
    } else if (pendingCommand.kind === 'spell-point' && selectedSpell) {
      outcome = await onCastSpell(selected, selectedSpell.id, { x: pendingCommand.x, y: pendingCommand.y, ...(note ? { note } : {}) })
    } else if (pendingCommand.kind === 'action-target' && selectedCombatAction) {
      outcome = await onUseCombatAction(selected, selectedCombatAction.id, pendingCommand.targetId, selectedCombatAction.requiresWeapon ? selectedItem?.id : undefined, undefined, note)
    }
    if (outcome?.ok) {
      if (pendingCommand.kind === 'target' && pendingCommand.sneakAttack) setSneakAttack(false)
      setPendingCommand(null)
    }
    return outcome
  }

  const previewBlastCenter = combatMode === 'magic' && selectedSpell?.target === 'point'
    ? pendingPoint ?? aimCell
    : projectileTarget
  const previewBlastSizeFeet = combatMode === 'magic' ? spellAreaRadiusFeet : areaRadiusFeet
  const previewBlastShape = combatMode === 'magic' ? selectedSpell?.areaShape ?? 'sphere' : 'sphere'
  const previewBlastKeys = useMemo(() => {
    if (!previewBlastCenter || !active || previewBlastSizeFeet <= 0) return new Set<string>()
    const previewWalkableKeys = new Set(
      state.scene.cells
        .filter((cell) => cell.revealed !== false && (cell.type === 'floor' || cell.type === 'door'))
        .map((cell) => boardPositionKey(cell.x, cell.y)),
    )
    return new Set(
      areaCells({
        shape: previewBlastShape,
        origin: active,
        target: previewBlastCenter,
        originMode: selectedSpell?.areaOrigin ?? 'point',
        sizeFeet: previewBlastSizeFeet,
        cellFeet: CELL_FEET,
        bounds: { minX: 0, minY: 0, maxX: columns - 1, maxY: rows - 1 },
        isWalkable: (point) => previewWalkableKeys.has(boardPositionKey(point.x, point.y)),
      }).map((point) => boardPositionKey(point.x, point.y)),
    )
  }, [
    active?.id, active?.x, active?.y, columns, previewBlastCenter?.x, previewBlastCenter?.y,
    previewBlastShape, previewBlastSizeFeet, rows, selectedSpell?.areaOrigin, state.scene.cells,
  ])

  const openNpcDossier = (npcId: string, mode: 'talk' | 'inspect' | 'transfer') => {
    setOpenTokenLabelId(null)
    setNpcDialogueText('')
    setSelectedGiftItemId(mode === 'transfer' ? transferableGiftItems[0]?.id ?? '' : '')
    setGiftQuantity(1)
    setNpcDossier({ npcId, mode })
  }

  const submitNpcDialogue = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = npcDialogueText.trim()
    if (!text || !dossierSceneNpc || !dossierCanTalk) return
    // Имя и роль остаются в читаемом тексте/legacy fallback, а npcId уходит
    // отдельным аргументом нового server-owned контракта через App adapter.
    const addressed = `Обращаюсь к ${dossierSceneNpc.name}${dossierSceneNpc.role ? ` (${dossierSceneNpc.role})` : ''}: ${text}`
    const outcome = await onNpcAction(addressed, dossierSceneNpc.id)
    if (outcome.ok) setNpcDialogueText('')
  }

  const submitNpcGift = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!dossierSceneNpc || !selectedGiftItem || !dossierCanReceiveGift) return
    if (!Number.isInteger(giftQuantity) || giftQuantity < 1 || giftQuantity > selectedGiftAvailable) return
    // Инвентарь получателя намеренно не запрашивается и не меняется на
    // клиенте: итоговый снимок после server-owned TransferItem придёт сам.
    const outcome = await onTransferItem(selectedGiftItem.id, dossierSceneNpc.id, giftQuantity)
    if (outcome.ok) {
      setNpcDossier(null)
      setSelectedGiftItemId('')
      setGiftQuantity(1)
    }
  }

  // Доска. Перебор клеток остаётся прежним: он занимает доли миллисекунды и
  // узким местом не является (`docs/tactical-map-plan.md`, раздел 7). Меняется
  // то, что из него выходит: местность рисует холст, массовые подсветки —
  // холст же, а DOM-узел достаётся только активной клетке: занятой фишкой,
  // досягаемой, входящей в маршрут или в область команды.
  const boardCells: BoardCellNode[] = []
  const boardOverlay: BoardOverlayCell[] = []
  const visibleMapFeedback = useTransientMapFeedback(state.mapFeedback)
  // Подсказки клеток без узла: причина недоступности обязана остаться на всех
  // клетках, а узел получает только активная.
  const boardHints = new Map<string, BoardCellHint>()
  for (const cell of state.scene.cells) {
    const player = players.find((item) => item.x === cell.x && item.y === cell.y && item.hp > 0)
    const enemy = state.enemies?.find((item) => item.x === cell.x && item.y === cell.y && item.alive)
    const summon = state.actors?.find((item) => item.x === cell.x && item.y === cell.y && item.alive)
    const sceneNpc = !player && !enemy && !summon
      ? sceneNpcs.find((item) => item.x === cell.x && item.y === cell.y)
      : undefined
    const sceneNpcStance = visibleNpcStance(sceneNpc?.stance ?? 'neutral')
    const sceneNpcMerchant = sceneNpc ? state.merchants?.find((merchant) => merchant.id === sceneNpc.id) : undefined
    const sceneNpcSocial = sceneNpc ? state.social?.npcs?.find((npc) => npc.id === sceneNpc.id) : undefined
    const sceneNpcGiftBlocked = Boolean(
      combatActive
      || !sceneNpc?.alive
      || sceneNpcSocial?.available === false
      || narrating
      || tacticalBusy
      || !canAct
      || transferableGiftItems.length === 0
    )
    const sceneNpcMenuId = sceneNpc ? `scene-npc:${sceneNpc.id}` : ''
    const attackDistanceFeet = enemy && active
      ? chebyshevFeet(active, enemy)
      : Number.POSITIVE_INFINITY
    const spellDistanceFeet = enemy && active ? chebyshevFeet(active, enemy) : Number.POSITIVE_INFINITY
    const trajectoryBlockReason = enemy && active ? boardTrajectoryBlockReason(state, active, enemy) : null
    const clearTrajectory = Boolean(enemy && active && trajectoryBlockReason == null)
    const enemyForecast = enemy
      ? selectedAttackForecast(state.combatForecast?.targets, enemy.id, selectedItem?.id ?? null)
      : null
    const enemyInWeaponRange = attackDistanceFeet >= CELL_FEET && attackDistanceFeet <= attackRangeFeet && (attackRangeFeet <= CELL_FEET || clearTrajectory)
    const enemyInSpellRange = spellDistanceFeet <= selectedSpellRange && (selectedSpellRange <= CELL_FEET || clearTrajectory)
    const canWeaponTargetEnemy = Boolean(combatActive && selected && combatMode === 'weapon' && weaponAttackReady && enemyInWeaponRange && selectedItem?.combat?.kind !== 'thrown-area' && !needsWeaponChange)
    const canSpellTargetEnemy = Boolean(combatActive && selected && combatMode === 'magic' && selectedSpell && ['enemy', 'creature'].includes(selectedSpell.target) && spellEconomyReady && enemyInSpellRange)
    const selectedActionRange = selectedCombatAction?.requiresWeapon ? attackRangeFeet : Number(selectedCombatAction?.range ?? 0)
    const enemyInActionRange = Boolean(enemy && active && chebyshevFeet(active, enemy) <= selectedActionRange && (selectedActionRange <= CELL_FEET || clearTrajectory))
    const enemyKnockedOut = Boolean(enemy && state.mechanics?.resting?.[enemy.id]?.reason === 'knockout')
    const canActionTargetEnemy = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['enemy', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && enemyInActionRange && (selectedCombatAction.id !== 'first-aid' || enemyKnockedOut))
    const targetRangeFeet = combatMode === 'magic' ? selectedSpellRange : combatMode === 'action' ? selectedActionRange : selectedItem?.combat?.kind === 'thrown-area' ? normalRangeFeet : attackRangeFeet
    const acceptedTarget = combatMode === 'magic'
      ? selectedSpell?.target === 'ally' ? 'ally' : selectedSpell?.target === 'enemy' ? 'enemy' : 'creature'
      : combatMode === 'action'
        ? selectedCombatAction?.target === 'ally' ? 'ally' : selectedCombatAction?.target === 'enemy' ? 'enemy' : 'creature'
        : 'enemy'
    const targetEconomyReady = combatMode === 'magic' ? spellEconomyReady : combatMode === 'action' ? selectedActionEconomyReady : weaponAttackReady
    const targetResourceReady = combatMode === 'magic' ? spellSlotReady : combatMode === 'action' ? selectedActionResourceReady : true
    const targetEquipmentReady = combatMode !== 'weapon' || !needsWeaponChange
    const targetSpecialBlock = combatMode === 'magic' && !selectedSpell
      ? 'У героя нет выбранного боевого заклинания'
      : combatMode === 'magic' && selectedSpell?.target === 'self'
        ? 'Это заклинание применяется только на себя'
        : combatMode === 'action' && !selectedCombatAction
          ? 'Сначала выберите классовое или основное действие'
          : combatMode === 'action' && selectedCombatAction?.id === 'first-aid' && !enemyKnockedOut
            ? 'Первая помощь доступна только нокаутированной цели'
            : null
    const enemyTargetCheck = enemy ? evaluateCombatTarget({
      selected: Boolean(combatActive && selected), economyReady: targetEconomyReady,
      targetAlive: enemy.alive, targetTeam: 'enemy', acceptedTarget,
      distanceFeet: attackDistanceFeet, rangeFeet: targetRangeFeet,
      clearTrajectory: targetRangeFeet <= CELL_FEET || clearTrajectory,
      equipmentReady: targetEquipmentReady, resourceReady: targetResourceReady,
      specialBlockReason: targetSpecialBlock,
    }) : null
    const cellKey = cell.x + ',' + cell.y
    const sceneObject = sceneObjectByCell.get(cellKey)
    /* Тултип лестницы (`docs/multilevel-map-plan.md`, 7.4). Кнопка перехода
       появляется только у подошедшего вплотную персонажа, а «куда ведёт эта
       лестница» игрок спрашивает раньше — наведением с другого конца зала. */
    const sceneObjectHint = [sceneObject ? `Выбрать: ${sceneObjectLabel(sceneObject)}` : '',
      levelTransitionHint(sceneObject?.transition, knownSceneLevels) ?? ''].filter(Boolean).join(' · ')
    const canMoveHere = reachable.has(cellKey)
    const route = movementPaths.get(cellKey)
    const moveReason = active ? movementCellReason(state, active, cell, movementLimit, movementPaths) : null
    const routeStep = previewRouteSteps.get(cellKey)
    const opportunityRisk = Boolean(canMoveHere && opportunityThreats.some((threat) => chebyshevFeet(threat, cell) > CELL_FEET))
    const canThrowHere = Boolean(combatActive && selected && combatMode === 'weapon' && actionReady && selectedItem?.combat?.kind === 'thrown-area' && active && chebyshevFeet(active, cell) <= normalRangeFeet && hasClearBoardTrajectory(state, active, cell) && cell.revealed && cell.type !== 'wall')
    const occupied = Boolean(player || enemy || summon || sceneNpc)
    const commandRangeVisible = Boolean(selected && targetRangeFeet > 0 && (combatActive || spellEconomyReady))
    const cellInCommandRange = Boolean(commandRangeVisible && active && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && chebyshevFeet(active, cell) <= targetRangeFeet && (targetRangeFeet <= CELL_FEET || hasClearBoardTrajectory(state, active, cell)))
    const moveUnavailable = Boolean(selected && movementAvailable && active && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && !occupied && !canMoveHere && moveReason)
    const canPointSpellHere = Boolean(selected && combatMode === 'magic' && selectedSpell?.target === 'point' && spellEconomyReady && active && chebyshevFeet(active, cell) <= selectedSpellRange && hasClearBoardTrajectory(state, active, cell) && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && (!['summon', 'teleport'].includes(selectedSpellKind ?? '') || !occupied))
    const canSummonHere = Boolean(canPointSpellHere && selectedSpellKind === 'summon')
    const canAimHere = canThrowHere || canPointSpellHere
    const inBlastArea = previewBlastKeys.has(cellKey)
    const inPersistentSpellArea = Boolean((state.mechanics?.active_effects ?? []).some((effect) => effect.center && chebyshevFeet(effect.center, cell) <= Number(effect.radius_feet ?? 0)))
    // У объекта собственная hotspot-зона в соседнем слое поверх клетки. Клетка
    // маршрута и предмет поэтому остаются двумя отдельными элементами, и оба
    // доступны мышью и клавиатурой.
    const cellIsInteractive = Boolean((canMoveHere || canAimHere) && !occupied)
    const cellFeedback = visibleMapFeedback.filter((item) => item.x === cell.x && item.y === cell.y)
    const cellLabel = canPointSpellHere
      ? `Наложить ${selectedSpell?.name} в клетку ${cell.x}, ${cell.y}`
      : canThrowHere
        ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку ${cell.x}, ${cell.y}`
        : canMoveHere
          ? `Маршрут для ${activeName}: ${route?.costFeet ?? 0} футов${opportunityRisk ? '. Это спровоцирует атаку по возможности' : ''}`
          : sceneObject
            ? sceneObjectHint
            : moveReason ?? undefined
    const enemyKind = enemy ? enemyVisualKind(enemy) : null
    const enemyHealth = enemy ? enemyHealthPresentation(enemy) : null
    const enemyCommandAllowed = Boolean(canWeaponTargetEnemy || canSpellTargetEnemy || canActionTargetEnemy || canThrowHere || canPointSpellHere)
    const enemyTargetReason = enemyCommandAllowed
      ? enemyForecast?.cover_bonus
        ? `Допустимая цель · ${enemyForecast.cover_label ?? 'укрытие'} +${enemyForecast.cover_bonus} к КД`
        : attackDistanceFeet > normalRangeFeet && combatMode === 'weapon' ? 'Допустимая цель · дальний диапазон с помехой' : 'Допустимая цель'
      : trajectoryBlockReason ?? enemyTargetCheck?.reason ?? 'Выбранная команда не подходит для этой цели'
    const enemyConditions = enemy ? (state.mechanics?.conditions?.[enemy.id] ?? []).map(conditionPresentation) : []
    const enemyHighGround = enemyForecast?.advantage_sources.includes('позиция выше цели')
      ? 'higher'
      : enemyForecast?.disadvantage_sources.includes('позиция ниже цели') ? 'lower' : null

    // Область команды и недоступный маршрут накрывают почти всю карту, поэтому
    // они рисуются на холсте: в разметке это был бы узел на каждую клетку.
    if (commandRangeVisible && cell.revealed) boardOverlay.push({ x: cell.x, y: cell.y, kind: cellInCommandRange ? 'command-range' : 'command-out-of-range' })
    if (moveUnavailable && !canAimHere && !cellInCommandRange) boardOverlay.push({ x: cell.x, y: cell.y, kind: 'move-unavailable' })

    const stateClasses = [
      canMoveHere && !canAimHere && previewMoveKey === cellKey ? 'move-target' : '',
      routeStep ? 'route-step' : '',
      previewMoveKey === cellKey ? 'route-destination' : '',
      opportunityRisk && !canAimHere ? 'opportunity-risk' : '',
      canAimHere ? 'aim-target' : '',
      canSummonHere ? 'summon-target' : '',
      inPersistentSpellArea ? 'spell-terrain' : '',
      inBlastArea ? 'blast-area' : '',
      pendingPoint?.x === cell.x && pendingPoint?.y === cell.y ? 'command-center' : '',
      sceneObject ? 'scene-object-target' : '',
      sceneObject?.id === selectedSceneObjectId ? 'scene-object-selected' : '',
      occupied ? player ? 'occupied-by-hero' : summon ? 'occupied-by-summon' : sceneNpc ? 'occupied-by-neutral' : 'occupied-by-enemy' : '',
    ].filter(Boolean)
    const cellTitle = opportunityRisk && !canAimHere
      ? 'Опасная клетка: выход из ближнего боя вызовет атаку по возможности'
      : moveUnavailable ? moveReason ?? undefined : undefined
    if (!stateClasses.length && !cellFeedback.length && !cellIsInteractive) {
      if (cellTitle || cellLabel) boardHints.set(cellKey, { title: cellTitle, ariaLabel: cellLabel })
      continue
    }

    boardCells.push({
      x: cell.x,
      y: cell.y,
      className: stateClasses.join(' '),
      interactive: cellIsInteractive,
      ariaLabel: cellLabel,
      title: cellTitle,
      onPointerEnter: () => {
        if (sceneObject) setHoveredSceneObjectId(sceneObject.id)
        if (canAimHere) setAimCell({ x: cell.x, y: cell.y })
        else if (canMoveHere) setHoveredMoveKey(cellKey)
      },
      onPointerLeave: () => {
        if (sceneObject) setHoveredSceneObjectId((current) => current === sceneObject.id ? null : current)
        if (canAimHere && !pendingCommand) setAimCell(null)
        if (hoveredMoveKey === cellKey) setHoveredMoveKey(null)
      },
      onActivate: () => {
        if (!selected || (!canMoveHere && !canAimHere)) return
        if (canPointSpellHere) castAtCell(cell.x, cell.y)
        else if (canThrowHere) chooseArea(cell.x, cell.y)
        else if (!combatActive || pendingMoveKey === cellKey) {
          void onMove(selected, cell.x, cell.y).then((outcome) => {
            if (outcome.ok) setPendingMoveKey(null)
          })
        }
        else setPendingMoveKey(cellKey)
      },
      hotspot: sceneObject ? <span
          role="button"
          tabIndex={0}
          className="scene-object-hotspot"
          data-selected={sceneObject.id === selectedSceneObjectId ? 'true' : undefined}
          aria-label={sceneObjectHint}
          aria-pressed={sceneObject.id === selectedSceneObjectId}
          title={sceneObjectHint}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerEnter={() => setHoveredSceneObjectId(sceneObject.id)}
          onPointerLeave={() => setHoveredSceneObjectId((current) => current === sceneObject.id ? null : current)}
          onFocus={() => setHoveredSceneObjectId(sceneObject.id)}
          onBlur={() => setHoveredSceneObjectId((current) => current === sceneObject.id ? null : current)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setSelectedSceneObjectId((current) => current === sceneObject.id ? null : sceneObject.id)
          }}
          onClick={(event) => {
            event.stopPropagation()
            setSelectedSceneObjectId((current) => current === sceneObject.id ? null : sceneObject.id)
          }}
        /> : undefined,
      children: <>
        {routeStep && <span className="route-step-badge" aria-hidden="true">{routeStep}</span>}
        {/* След на клетке: лежит в плоскости доски, поэтому при любом повороте и
            наклоне точно совпадает с сеткой. Фигурка стоит стоймя и из-за этого
            перспективно смещается — позиционную правду несёт именно этот след. */}
        {occupied && cell.revealed && <span className="cell-footprint" aria-hidden="true" />}
        {/* Точное здоровье остаётся полоской с числами только после раскрытия.
            До раскрытия используется предельно скупое кольцо качественной
            ступени: без цифр и текста, чтобы не вернуть перегрузку фишек,
            из-за которой здоровье убрали в PR #7. */}
        {enemy && cell.revealed && enemyHealth && !enemyHealth.exact && enemyHealth.status !== 'unharmed' && (
          <span className="enemy-health-ring" data-status={enemyHealth.status} aria-hidden="true" />
        )}
        {enemy && cell.revealed && enemyHealth?.exact && <TokenHealthBar fill={enemyHealth.fill} label={enemyHealth.barLabel} className={`enemy-health ${enemyHealth.status}`} />}
        {enemy && cell.revealed && (enemyForecast?.cover_bonus || enemyHighGround || trajectoryBlockReason) && (
          <span className="token-tactical-badges" aria-label="Тактические модификаторы цели">
            {enemyForecast && enemyForecast.cover_bonus > 0 && (
              <i className="cover" title={`${enemyForecast.cover_label ?? 'Укрытие'}: +${enemyForecast.cover_bonus} к КД. Союзники и реквизит на линии дают лучшее, а не суммарное укрытие.`}>
                {enemyForecast.cover_bonus >= 5 ? '¾' : '½'} +{enemyForecast.cover_bonus}
              </i>
            )}
            {enemyHighGround === 'higher' && <i className="advantage" title="Стрелок выше цели минимум на 5 футов: преимущество">↑</i>}
            {enemyHighGround === 'lower' && <i className="disadvantage" title="Стрелок ниже цели минимум на 5 футов: помеха">↓</i>}
            {trajectoryBlockReason && <i className="blocked" title={trajectoryBlockReason}>×</i>}
          </span>
        )}
        {enemy && cell.revealed && (
          <button
            className={`enemy-token ${focusedParticipantId === enemy.id ? 'initiative-focus' : ''} ${linkedParticipantIds.includes(enemy.id) ? 'journal-linked' : ''} ${enemy.id === turnActorId ? 'active-turn' : ''} ${enemyCommandAllowed ? 'targetable' : combatActive ? 'unavailable-target' : ''} ${pendingTargetId === enemy.id ? 'command-selected' : ''}`}
            data-actor-id={enemy.id}
            data-enemy-kind={enemyKind}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={() => { setLinkedParticipantIds([enemy.id]); setAimCell({ x: enemy.x, y: enemy.y }); setInspectedTarget({ id: enemy.id, name: enemy.name, team: 'enemy', ...(enemyHealth?.exact ? { hp: enemy.hp, maxHp: enemy.maxHp } : { healthLabel: enemyHealth?.label }), distanceFeet: attackDistanceFeet, allowed: enemyCommandAllowed, reason: enemyTargetReason }) }}
            onMouseLeave={() => { setLinkedParticipantIds([]); if (!pendingCommand) { setAimCell(null); setInspectedTarget(null) } }}
            onFocus={() => { setLinkedParticipantIds([enemy.id]); setInspectedTarget({ id: enemy.id, name: enemy.name, team: 'enemy', ...(enemyHealth?.exact ? { hp: enemy.hp, maxHp: enemy.maxHp } : { healthLabel: enemyHealth?.label }), distanceFeet: attackDistanceFeet, allowed: enemyCommandAllowed, reason: enemyTargetReason }) }}
            onBlur={() => { setLinkedParticipantIds([]); if (!pendingCommand) setInspectedTarget(null) }}
            onClick={(event) => { event.stopPropagation(); if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canActionTargetEnemy) useActionAtTarget(enemy.id); else if (canSpellTargetEnemy) castAtTarget(enemy.id); else if (canWeaponTargetEnemy) chooseTarget(enemy.id) }}
            aria-disabled={tacticalBusy || !enemyCommandAllowed}
            aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${enemy.name}` : `${canActionTargetEnemy ? `Использовать ${selectedCombatAction?.name} на` : canSpellTargetEnemy ? 'Наложить заклинание на' : 'Атаковать'} ${enemy.name}. Состояние: ${enemyHealth?.label}`}
            title={enemyTargetReason}
          >
            <span className="enemy-emblem">{enemy.image ? <img src={enemy.image} alt="" /> : <EnemyGlyph kind={enemyKind ?? 'raider'} />}</span>
            <span className="enemy-nameplate">{enemy.name}</span>
            {enemyHealth?.exact && <small className="enemy-health-value">{enemyHealth.label}</small>}
            <TokenConditionIcons conditions={enemyConditions} />
          </button>
        )}
        {sceneNpc && cell.revealed && <>
          <button
            type="button"
            className={`map-token neutral-token stance-${sceneNpcStance} ${sceneNpc.alive ? '' : 'dead'} ${openTokenLabelId === sceneNpcMenuId ? 'label-open' : ''}`}
            data-actor-id={sceneNpc.id}
            data-token-role="neutral"
            aria-expanded={openTokenLabelId === sceneNpcMenuId}
            aria-label={`${sceneNpc.name}, ${sceneNpc.role || 'персонаж'}. Отношение: ${NPC_STANCE_LABELS[sceneNpcStance]}`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              setOpenTokenLabelId((current) => current === sceneNpcMenuId ? null : sceneNpcMenuId)
            }}
          >
            <NpcTokenPortrait campaignId={state.sessionCode} npcId={sceneNpc.id} name={sceneNpc.name} />
            <span className="neutral-nameplate">{sceneNpc.name}</span>
          </button>
          {openTokenLabelId === sceneNpcMenuId && <div className="neutral-token-menu" role="group" aria-label={`Действия с ${sceneNpc.name}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <span><b>{sceneNpc.name}</b><small>{sceneNpc.role || 'Персонаж'} · {NPC_STANCE_LABELS[sceneNpcStance]}</small></span>
            <button
              type="button"
              disabled={combatActive || !sceneNpc.alive || narrating}
              title={combatActive ? 'Разговор недоступен во время боя' : !sceneNpc.alive ? 'Собеседник недоступен' : narrating ? 'Дождитесь ответа Рассказчика' : 'Открыть адресованный разговор'}
              onClick={() => openNpcDossier(sceneNpc.id, 'talk')}
            ><MessageSquare size={13} />Заговорить</button>
            <button type="button" onClick={() => openNpcDossier(sceneNpc.id, 'inspect')} title="Открыть публичное досье, не расходуя действие"><BookOpen size={13} />Осмотреть</button>
            <button
              type="button"
              disabled={sceneNpcGiftBlocked}
              title={combatActive
                ? 'Передача недоступна во время боя'
                : !sceneNpc.alive
                  ? 'Этому персонажу нельзя передать предмет'
                  : sceneNpcSocial?.available === false
                    ? 'Персонаж сейчас недоступен'
                    : narrating
                      ? 'Дождитесь ответа Рассказчика'
                      : tacticalBusy
                        ? 'Дождитесь завершения текущего действия'
                        : !canAct
                          ? 'Сейчас этот герой не может действовать'
                          : transferableGiftItems.length === 0
                            ? 'Нет свободных предметов для передачи'
                            : 'Выбрать предмет и количество'}
              onClick={() => openNpcDossier(sceneNpc.id, 'transfer')}
            ><Send size={13} />Передать предмет</button>
            {sceneNpcMerchant
              ? <button
                  type="button"
                  disabled={combatActive || !sceneNpc.alive || !sceneNpcMerchant.available}
                  title={combatActive ? 'Торговля недоступна во время боя' : !sceneNpc.alive || !sceneNpcMerchant.available ? 'Торговец сейчас недоступен' : 'Открыть существующее серверное окно торговли'}
                  onClick={() => onOpenMerchant(sceneNpc.id)}
                ><Store size={13} />Торговать</button>
              : null}
          </div>}
        </>}
        {player && cell.revealed && (() => {
          const healingDistance = active ? chebyshevFeet(active, player) : Number.POSITIVE_INFINITY
          // `combatActive` здесь больше нет: вне боя мирное заклинание на союзника
          // разрешено, и решает это `spellEconomyReady`, повторяющий правило движка.
          const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && ['ally', 'creature'].includes(selectedSpell.target) && spellEconomyReady && healingDistance <= selectedSpellRange)
          const playerKnockedOut = state.mechanics?.resting?.[player.id]?.reason === 'knockout'
          const canAid = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['ally', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && player.id !== selected && healingDistance <= selectedCombatAction.range && (selectedCombatAction.id !== 'stabilize' || player.hp === 0) && (selectedCombatAction.id !== 'first-aid' || playerKnockedOut))
          const playerCommandAllowed = Boolean(canHeal || canAid || canThrowHere || canPointSpellHere)
          const playerSpecialBlock = combatMode === 'action' && selectedCombatAction?.id === 'stabilize' && player.hp > 0
            ? 'Стабилизация нужна только герою с 0 ОЗ'
            : combatMode === 'action' && selectedCombatAction?.id === 'first-aid' && !playerKnockedOut
              ? 'Первая помощь доступна только нокаутированному союзнику'
              : combatMode === 'action' && player.id === selected ? 'Выберите другого союзника' : null
          const playerTargetCheck = evaluateCombatTarget({
            selected: Boolean(selected && (combatActive || spellEconomyReady)), economyReady: targetEconomyReady,
            targetAlive: player.hp > 0 || selectedCombatAction?.id === 'stabilize', targetTeam: 'ally', acceptedTarget,
            distanceFeet: healingDistance, rangeFeet: targetRangeFeet,
            clearTrajectory: targetRangeFeet <= CELL_FEET || Boolean(active && hasClearBoardTrajectory(state, active, player)),
            resourceReady: targetResourceReady, specialBlockReason: playerSpecialBlock,
          })
          const playerTargetReason = playerCommandAllowed ? 'Допустимая цель' : playerTargetCheck.reason ?? 'Выбранная команда не подходит для союзника'
          const playerConditions = (state.mechanics?.conditions?.[player.id] ?? []).map(conditionPresentation)
          return <button
            className={'map-token hero-token ' + (focusedParticipantId === player.id ? 'initiative-focus ' : '') + (linkedParticipantIds.includes(player.id) ? 'journal-linked ' : '') + (selected === player.id ? 'selected' : '') + ' ' + (openTokenLabelId === player.id ? 'label-open' : '') + ' ' + (player.id === turnActorId ? 'active-turn' : '') + ' ' + (canHeal || canAid ? 'targetable healing-target' : combatActive && selected && player.id !== turnActorId ? 'unavailable-target' : '') + ' ' + (pendingTargetId === player.id ? 'command-selected' : '') + ' ' + (player.maxHp > 0 && player.hp / player.maxHp <= .25 ? 'critical' : player.maxHp > 0 && player.hp / player.maxHp <= .5 ? 'wounded' : '')}
            data-actor-id={player.id}
            style={{ '--token': player.color, backgroundImage: 'url(' + player.portrait + ')', backgroundPosition: player.portraitPosition } as React.CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={() => { setLinkedParticipantIds([player.id]); if (canHeal) setAimCell({ x: player.x, y: player.y }); setInspectedTarget({ id: player.id, name: player.character, team: 'ally', hp: player.hp, maxHp: player.maxHp, distanceFeet: healingDistance, allowed: playerCommandAllowed, reason: playerTargetReason }) }}
            onMouseLeave={() => { setLinkedParticipantIds([]); if (!pendingCommand) { setAimCell(null); setInspectedTarget(null) } }}
            onFocus={() => { setLinkedParticipantIds([player.id]); setInspectedTarget({ id: player.id, name: player.character, team: 'ally', hp: player.hp, maxHp: player.maxHp, distanceFeet: healingDistance, allowed: playerCommandAllowed, reason: playerTargetReason }) }}
            onBlur={() => { setLinkedParticipantIds([]); if (!pendingCommand) setInspectedTarget(null) }}
            onClick={(event) => { event.stopPropagation(); setOpenTokenLabelId((current) => current === player.id ? null : player.id); if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canAid) useActionAtTarget(player.id); else if (canHeal) castAtTarget(player.id) }}
            aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${player.character}` : canAid ? `Использовать ${selectedCombatAction?.name} на ${player.character}` : canHeal ? `Наложить ${selectedSpell?.name} на ${player.character}` : player.character + (player.id === turnActorId ? ', активный герой' : '')}
            aria-disabled={!canHeal && !canAid && !canThrowHere}
            title={playerTargetReason}
          >
            <TokenConditionIcons conditions={playerConditions} />
            {openTokenLabelId === player.id && <span className="token-label">{player.character}<small>{player.hp} ОЗ · {combatActive ? `${remainingFeet} фт` : 'свободный ход'}</small></span>}
          </button>
        })()}
        {summon && cell.revealed && (() => {
          const healingDistance = active ? chebyshevFeet(active, summon) : Number.POSITIVE_INFINITY
          // `combatActive` здесь больше нет: вне боя мирное заклинание на союзника
          // разрешено, и решает это `spellEconomyReady`, повторяющий правило движка.
          const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && ['ally', 'creature'].includes(selectedSpell.target) && spellEconomyReady && healingDistance <= selectedSpellRange)
          const summonKnockedOut = state.mechanics?.resting?.[summon.id]?.reason === 'knockout'
          const canAid = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['ally', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && summon.id !== selected && healingDistance <= selectedCombatAction.range && (selectedCombatAction.id !== 'first-aid' || summonKnockedOut))
          const summonCommandAllowed = Boolean(canHeal || canAid || canThrowHere || canPointSpellHere)
          const summonTargetCheck = evaluateCombatTarget({
            selected: Boolean(selected && (combatActive || spellEconomyReady)), economyReady: targetEconomyReady,
            targetAlive: summon.alive, targetTeam: 'ally', acceptedTarget,
            distanceFeet: healingDistance, rangeFeet: targetRangeFeet,
            clearTrajectory: targetRangeFeet <= CELL_FEET || Boolean(active && hasClearBoardTrajectory(state, active, summon)),
            resourceReady: targetResourceReady,
            specialBlockReason: combatMode === 'action' && summon.id === selected ? 'Выберите другого союзника' : null,
          })
          const summonTargetReason = summonCommandAllowed ? 'Допустимая цель' : summonTargetCheck.reason ?? 'Выбранная команда не подходит для призыва'
          const summonConditions = (state.mechanics?.conditions?.[summon.id] ?? []).map(conditionPresentation)
          return <button
            className={'map-token summon-token ' + (focusedParticipantId === summon.id ? 'initiative-focus ' : '') + (linkedParticipantIds.includes(summon.id) ? 'journal-linked ' : '') + (selected === summon.id ? 'selected ' : '') + (summon.id === turnActorId ? 'active-turn ' : '') + (openTokenLabelId === summon.id ? 'label-open' : '') + ' ' + (canHeal || canAid ? 'targetable healing-target' : combatActive && selected ? 'unavailable-target' : '') + ' ' + (pendingTargetId === summon.id ? 'command-selected' : '')}
            data-actor-id={summon.id}
            style={{ '--token': '#70a78b' } as React.CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={() => { setLinkedParticipantIds([summon.id]); if (canHeal) setAimCell({ x: summon.x, y: summon.y }); setInspectedTarget({ id: summon.id, name: summon.name, team: 'ally', hp: summon.hp, maxHp: summon.maxHp, distanceFeet: healingDistance, allowed: summonCommandAllowed, reason: summonTargetReason }) }}
            onMouseLeave={() => { setLinkedParticipantIds([]); if (!pendingCommand) { setAimCell(null); setInspectedTarget(null) } }}
            onFocus={() => { setLinkedParticipantIds([summon.id]); setInspectedTarget({ id: summon.id, name: summon.name, team: 'ally', hp: summon.hp, maxHp: summon.maxHp, distanceFeet: healingDistance, allowed: summonCommandAllowed, reason: summonTargetReason }) }}
            onBlur={() => { setLinkedParticipantIds([]); if (!pendingCommand) setInspectedTarget(null) }}
            onClick={(event) => { event.stopPropagation(); setOpenTokenLabelId((current) => current === summon.id ? null : summon.id); if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canAid) useActionAtTarget(summon.id); else if (canHeal) castAtTarget(summon.id) }}
            aria-label={canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${summon.name}` : canAid ? `Использовать ${selectedCombatAction?.name} на ${summon.name}` : canHeal ? `Наложить ${selectedSpell?.name} на ${summon.name}` : `${summon.name}, призванный союзник${summon.id === turnActorId ? ', активный участник' : ''}`}
            aria-disabled={!canHeal && !canAid && !canThrowHere}
            title={summonTargetReason}
          >
            <Sparkles size={15} />
            <TokenConditionIcons conditions={summonConditions} />
            {openTokenLabelId === summon.id && <span className="token-label">{summon.name}<small>{summon.hp} ОЗ · {remainingFeet} фт</small></span>}
          </button>
        })()}
        {visibleBattleRoll && (visibleBattleRoll.targetId ?? visibleBattleRoll.actorId) === (enemy?.id ?? player?.id ?? summon?.id) && (
          <BattleRollTokenCallout event={visibleBattleRoll} context={visibleBattleRollContext} />
        )}
        {cellFeedback.map((item) => <span key={item.id} className={'map-feedback ' + item.kind}>{item.text}</span>)}
      </>,
    })
  }
  const highlightedDoor = doorsAtHand.find((door) => door.id === hoveredDoorId)
  if (highlightedDoor) {
    for (const cell of doorOverlayCells(highlightedDoor)) {
      boardOverlay.push({ ...cell, kind: 'command-range' })
    }
  }
  const highlightedSceneObject = sceneObjectsAtHand.find((prop) => (
    prop.id === (hoveredSceneObjectId ?? selectedSceneObjectId)
  ))
  if (highlightedSceneObject) {
    for (const cell of sceneObjectCells(highlightedSceneObject)) {
      boardOverlay.push({ ...cell, kind: 'command-range' })
    }
  }

  /* Плитки собираются в один список, чтобы их можно было переставлять:
     порядок хранится по герою и колоде и переживает перезагрузку. Пока замок
     закрыт, список только читается. */
  const deckTiles: Array<{ id: string; node: React.ReactElement }> = []
  if (activeDeck === 'common') deckTiles.push({ id: 'movement', node: <button className="action-tile movement-tile" disabled={!selected || !movementAvailable || remainingFeet <= 0 || actionsLocked} onClick={() => { setSelectedCombatActionId(''); setCombatMode('weapon') }} title="Перемещение — выберите подсвеченную клетку на карте"><CombatIcon id="movement" kind="movement" hint="перемещение" /><strong>Перемещение</strong><small>{remainingFeet} фт</small><i className="action-cost movement">движение</i></button> })
  if (activeDeck === 'weapon') deckTiles.push({ id: BASE_ATTACK_ID, node: <button className={`action-tile weapon ${combatMode === 'weapon' && weaponSelectionId === BASE_ATTACK_ID ? 'selected' : ''}`} disabled={!selected || !weaponAttackReady || actionsLocked} onClick={() => { setSelectedItemId(BASE_ATTACK_ID); setCombatMode('weapon') }} title={`Базовая атака · ${baseRangeFeet} фт`}><CombatIcon id={BASE_ATTACK_ID} kind="weapon" hint="базовая атака оружием" /><strong>Базовая атака</strong><small>{baseRangeFeet} фт</small><i className="action-cost action">действие</i></button> })
  if (activeDeck === 'weapon') combatItems.filter((item) => item.type === 'weapon').forEach((item) => deckTiles.push({ id: item.id, node: <button key={item.id} className={`action-tile weapon ${combatMode === 'weapon' && selectedItemId === item.id ? 'selected' : ''}`} disabled={!selected || !weaponAttackReady || actionsLocked} onClick={() => { setSelectedItemId(item.id); setCombatMode('weapon') }} title={`${item.name}: ${item.description || item.properties}`}><CombatIcon id={item.id} kind="weapon" hint={`${item.name} ${item.combat?.kind ?? ''} ${item.combat?.damageType ?? ''}`} /><strong>{item.name}</strong><small>{item.combat?.damage ?? 'атака'} · {item.combat?.normalRange ?? 5} фт</small><i className="action-cost action">действие</i></button> }))
  if (activeDeck === 'magic') deckTiles.push({ id: 'spellbook', node: <button className="action-tile spellbook-tile" onClick={() => setSpellbookOpen(true)} disabled={!spells.length || tacticalBusy} title={`Открыть полный каталог: ${spells.length} заклинаний доступно герою`}><CombatIcon id="spellbook" kind="spellbook" hint="книга заклинаний" /><strong>Книга</strong><small>{spells.length} доступно</small></button> })
  if (activeDeck === 'magic') hotbarSpells.forEach((spell) => { const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote); const pools = !spell.slotResource ? [] : spell.slotResource === 'pact_slots' || spell.slotResource === 'mystic_arcanum_6' ? [activeResources[spell.slotResource]].filter(Boolean) : Array.from({ length: Math.max(0, 7 - spell.level) }, (_, index) => activeResources[`spell_slots_${spell.level + index}`]).filter(Boolean); const pool = pools.find((candidate) => Number(candidate.current ?? 0) > 0) ?? pools[0]; const ready = !spell.slotResource || pools.some((candidate) => Number(candidate.current ?? 0) > 0); const actionType = activeConditionIds.has('metamagic-quickened') && spellActionType(spell) === 'action' ? 'bonus_action' : spellActionType(spell); const economyReady = actionType !== 'long_cast' && (actionType === 'bonus_action' ? bonusReady : actionType === 'reaction' ? reactionReady : actionReady); deckTiles.push({ id: spell.id, node: <button key={spell.id} className={`action-tile spell support-${support.status} ${combatMode === 'magic' && selectedSpell?.id === spell.id ? 'selected' : ''}`} disabled={support.blocked || !selected || !ready || !economyReady || (combatActive ? tacticalBusy : !castableOutOfCombat(spell))} onClick={() => selectSpell(spell)} title={`${spell.name} — ${support.blocked ? `${support.label}. ${support.explanation}` : `${spell.description ?? ''}${spell.concentration ? ' · Концентрация' : ''}`}`}><CombatIcon id={spell.id} kind="spell" hint={`${spell.kind} ${spell.damageType ?? ''} ${spell.name}`} priority /><strong>{spell.name}</strong><small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spellRange(spell)} фт</small>{pool && <em>{Number(pool.current ?? 0)}/{Number(pool.max ?? 0)}</em>}{support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`}>{support.shortLabel}</i>}<i className={`action-cost ${actionType}`}>{actionType === 'bonus_action' ? 'бонус' : actionType === 'reaction' ? 'реакция' : actionType === 'long_cast' ? 'вне боя' : 'действие'}</i></button>  }) })
  if (activeDeck === 'common' || activeDeck === 'class') combatActions.filter((action) => action.category === activeDeck && action.actionType !== 'reaction').forEach((action) => { const support = mechanicsSupportPresentation(action.mechanicsSupport, action.supportNote); const pool = action.resource ? activeResources[action.resource] : undefined; const ready = !action.resource || Number(pool?.current ?? 0) >= Number(action.cost ?? 1); const economyReady = action.actionType === 'free' || (action.actionType === 'bonus_action' ? bonusReady : actionReady); deckTiles.push({ id: action.id, node: <button key={action.id} className={`action-tile feature-action support-${support.status} ${combatMode === 'action' && selectedCombatAction?.id === action.id ? 'selected' : ''}`} disabled={support.blocked || !selected || !ready || !economyReady || actionsLocked} onClick={() => selectCombatAction(action)} title={`${action.name} — ${support.blocked ? `${support.label}. ${support.explanation}` : action.description}`}><CombatIcon id={action.id} kind="action" hint={`${action.name} ${action.category} ${action.target}`} /><strong>{action.name}</strong><small>{action.target === 'self' ? 'на себя' : action.target === 'ally' ? `${action.range} фт · союзник` : `${action.range} фт · враг`}</small>{pool && <em>{Number(pool.current ?? 0)}/{Number(pool.max ?? 0)}</em>}{support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`}>{support.shortLabel}</i>}<i className={`action-cost ${action.actionType}`}>{action.actionType === 'bonus_action' ? 'бонус' : action.actionType === 'free' ? 'свободно' : 'действие'}</i></button>  }) })
  if (activeDeck === 'items') combatItems.filter((item) => item.type !== 'weapon').forEach((item) => deckTiles.push({ id: item.id, node: <button key={item.id} className={`action-tile item ${combatMode === 'weapon' && selectedItemId === item.id ? 'selected' : ''}`} disabled={!selected || !actionReady || actionsLocked} onClick={() => { setSelectedItemId(item.id); setCombatMode('weapon') }} title={`${item.name} — ${item.description}`}><CombatIcon id={item.id} kind="item" hint={`${item.name} ${item.type} ${item.combat?.kind ?? ''} ${item.combat?.damageType ?? ''}`} /><strong>{item.name}</strong><small>{item.quantity} шт. · {item.combat?.radius ? `радиус ${item.combat.radius} фт` : 'предмет'}</small><i className="action-cost action">действие</i></button> }))
  const tileOrderKey = `${turnActorId}:${activeDeck}`
  const savedTileOrder = tileOrder[tileOrderKey] ?? []
  const orderedTiles = savedTileOrder.length
    ? [...deckTiles].sort((left, right) => {
        const leftIndex = savedTileOrder.indexOf(left.id)
        const rightIndex = savedTileOrder.indexOf(right.id)
        if (leftIndex === rightIndex) return 0
        if (leftIndex === -1) return 1
        if (rightIndex === -1) return -1
        return leftIndex - rightIndex
      })
    : deckTiles
  const moveTile = (targetId: string) => {
    if (!draggedTileId || draggedTileId === targetId) return
    const ids = orderedTiles.map((tile) => tile.id)
    const from = ids.indexOf(draggedTileId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    const next = { ...tileOrder, [tileOrderKey]: ids }
    setTileOrder(next)
    window.localStorage.setItem(TILE_ORDER_KEY, JSON.stringify(next))
  }
  return (
    <>
      <div className="status-bar">
        {statusContent}
        <section className={`initiative-ribbon ${combatActive ? 'combat' : 'exploration'}`} aria-label={combatActive ? `Раунд ${combat.round ?? 1}, порядок инициативы` : 'Кто ведёт отряд'} aria-live="polite">
          {combatActive ? <>
            <div className={`initiative-active-chip ${activeEnemy ? 'enemy' : activeSummon ? 'summon' : 'hero'}`}>
              {activeHero
                ? <span className="initiative-active-avatar portrait" style={{ backgroundImage: `url(${activeHero.portrait})`, backgroundPosition: activeHero.portraitPosition }} />
                : activeEnemy
                  ? <span className="initiative-active-avatar enemy">{activeEnemy.image ? <img src={activeEnemy.image} alt="" /> : <EnemyGlyph kind={enemyVisualKind(activeEnemy)} />}</span>
                  : <span className="initiative-active-avatar summon"><Sparkles size={18} /></span>}
              <span><strong>{activeName}</strong><small>{activeTurnLabel}</small></span>
            </div>
            <header>РАУНД <b>{combat.round ?? 1}</b></header>
            <ol>{combat.initiative?.map((entry, index) => {
              const hero = state.players.find((player) => player.id === entry.actor_id)
              const enemy = state.enemies?.find((item) => item.id === entry.actor_id)
              const summon = state.actors?.find((item) => item.id === entry.actor_id)
              const kind = summon ? 'summon' : enemy ? 'enemy' : 'hero'
              const name = hero?.character ?? summon?.name ?? enemy?.name ?? entry.actor_id
              const defeated = participantDefeated(entry.actor_id)
              const activeNow = index === activeInitiativeIndex
              const nextUp = index === nextInitiativeIndex
              const statusLabel = defeated ? 'выбыл' : activeNow ? 'сейчас' : nextUp ? 'следующий' : ''
              const enemyKind = enemy ? enemyVisualKind(enemy) : null
              return <li key={entry.actor_id} className={`${kind} ${activeNow ? 'active' : ''} ${nextUp ? 'next' : ''} ${defeated ? 'defeated' : ''}`} aria-current={activeNow ? 'step' : undefined}>
                <button
                  className={`initiative-avatar-button ${focusedParticipantId === entry.actor_id ? 'focused' : ''}`}
                  aria-label={`Выделить на карте: ${name}${statusLabel ? `, ${statusLabel}` : ''}`}
                  aria-pressed={focusedParticipantId === entry.actor_id}
                  title={`${name}${statusLabel ? ` · ${statusLabel}` : ''}`}
                  onClick={() => setFocusedParticipantId((current) => current === entry.actor_id ? null : entry.actor_id)}
                >
                  <span className="initiative-order" aria-hidden="true">{index + 1}</span>
                  {hero
                    ? <span className="initiative-avatar portrait" style={{ backgroundImage: `url(${hero.portrait})`, backgroundPosition: hero.portraitPosition }} />
                    : enemy
                      ? <span className="initiative-avatar enemy">{enemy.image ? <img src={enemy.image} alt="" /> : <EnemyGlyph kind={enemyKind ?? 'raider'} />}</span>
                      : <span className="initiative-avatar summon"><Sparkles size={18} /></span>}
                  {activeNow && <span className="initiative-turn-dot" aria-hidden="true" />}
                  {statusLabel && <span className={`initiative-status-label ${defeated ? 'defeated' : activeNow ? 'active' : 'next'}`}>{statusLabel}</span>}
                </button>
              </li>
            })}</ol>
          </> : <div className="initiative-exploration-lead">
            <span className="initiative-ribbon-label">СВОБОДНАЯ СЦЕНА</span>
            <div className="initiative-active-chip exploration">
              <span className="initiative-active-avatar portrait" style={{ backgroundImage: `url(${activeHero?.portrait ?? ''})`, backgroundPosition: activeHero?.portraitPosition }} />
              <span><strong>Говорит любой герой</strong><small>Групповые решения — голосованием</small></span>
            </div>
          </div>}
        </section>
      </div>
      <div
        className={`map-stage ${visualTheme} ${scenicBackdrop ? 'scenic-backdrop' : 'monotone-backdrop'}${truce ? ' truce-held' : ''}`}
        data-map-source={mapArt.id}
        style={{ '--board-art': `url("${mapArt.url}")` } as React.CSSProperties}
      >
      <div className="map-atmosphere map-atmosphere-one" />
      <div className="map-atmosphere map-atmosphere-two" />
      <PartyQuestHud state={state} />
      {/* Перемирие видно на самой доске, а не только в панели: рамка вокруг
          поля и полоса сверху. Без этого стол не понимал бы, почему очередь
          стоит и почему кнопки боя ведут себя иначе. */}
      {truce && <div className="truce-banner" role="status" aria-live="polite">
        <Handshake size={15} />
        <span>Перемирие · говорит {truce.leader_name || 'предводитель уцелевших'}. Удар разорвёт уговор.</span>
      </div>}
      {npcTacticText && <div className="npc-tactic-banner" role="status" aria-live="polite"><Swords size={15} /><span>{npcTacticText}</span></div>}
      <TacticalBoard
        key={state.sessionCode}
        map={boardMap}
        columns={columns}
        rows={rows}
        irregular={irregularMap}
        themeKey={visualTheme}
        artUrl={scenicBackdrop ? mapArt.url : null}
        ariaLabel={`Тактическая карта, вид сверху. Колесо меняет масштаб, перетаскивание двигает полотно, двойной клик центрирует. Активный участник: ${activeName}`}
        cells={boardCells}
        cellHints={boardHints}
        overlayCells={boardOverlay}
        effectRenderers={boardEffectRenderers}
        battleLog={animatedBattleLog}
        visualBatch={visualBatch}
        animationActors={animationActors}
        animationsEnabled={combatAnimations}
        conditions={state.mechanics?.conditions}
        conditionVersion={state.state_version}
        levelIndex={sceneLevelIndex}
        onBackgroundActivate={() => setOpenTokenLabelId(null)}
        decoration={trajectory
          ? <svg className="projectile-trajectory" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1={trajectory.x1} y1={trajectory.y1} x2={trajectory.x2} y2={trajectory.y2} /></svg>
          : null}
      />
      <div className="map-scale-plate">1 клетка = 5 футов</div>
      {/* Индикатор этажей: появляется только там, где партия знает больше
          одного этажа. Не кликабельный — вид всегда следует за партией. */}
      {levelStackRows.length > 0 && <div className="map-level-stack" role="status" aria-label="Известные этажи локации">
        {levelStackRows.map((row) => <span key={row.index} className={row.active ? 'active' : ''} aria-current={row.active ? 'true' : undefined}>{row.label}</span>)}
      </div>}
      {/* Режим стоит над полем по центру: он описывает то, что происходит на
          карте, и читается раньше, чем взгляд уходит к панели действий. */}
      {!combatActive && <div className="map-mode-plate" role="status">Исследование</div>}
      <details
        className="map-legend"
        open={legendOpen}
        onToggle={(event) => {
          const open = (event.currentTarget as HTMLDetailsElement).open
          setLegendOpen(open)
          window.localStorage.setItem(MAP_LEGEND_KEY, open ? 'open' : 'closed')
        }}
      >
        <summary><HelpCircle size={13} />Легенда доски</summary>
        <div>
          <span><i className="legend-dot party" />Отряд</span>
          <span><i className="legend-dot summon" />Призыв</span>
          <span><i className="legend-dot danger" />Враг · параметры скрыты</span>
          <span><i className="legend-dot interest" />Интерес</span>
          <span><i className="legend-swatch difficult" />Штриховка · трудная местность</span>
          <span><i className="legend-swatch hazard" />Пунктир · опасность</span>
          <span><i className="legend-swatch spell" />Контур · длящееся заклинание</span>
          <span><i className="legend-mark concentration">К</i>Концентрация владельца</span>
          <span><i className="legend-mark elevation">+5</i>Высота в футах</span>
          <span><i className="legend-mark cover">½</i>Укрытие от линии огня</span>
          {/* Поверхности: цвета повторяют SURFACE_COLORS из src/board-render.ts —
              по ним игрок читает, где вода, где лёд, а где месиво. */}
          <span><i className="legend-swatch surface-water" />Вода · движение вдвое дороже</span>
          <span><i className="legend-swatch surface-ice" />Лёд · проверка на падение</span>
          <span><i className="legend-swatch surface-mud" />Грязь · трудная местность</span>
          <span><i className="legend-swatch surface-rubble" />Щебень · трудная местность</span>
          <span><i className="legend-mark stairs">⇅</i>Лестница или люк · переход между этажами</span>
        </div>
      </details>
      {/* Остаток хода стоит у нижней кромки стола, а не над панелью действий:
          «хватит ли на ещё один шаг» спрашивают, глядя на карту, и ответ теперь
          лежит на той же линии взгляда. Плашка не перехватывает указатель —
          клетки под ней остаются кликабельными. */}
      {combatActive && <div className="map-economy" aria-label="Экономика текущего хода">
        <span className={remainingFeet > 0 && movementAvailable ? 'ready' : 'spent'}><small>Движение</small><b>{movementAvailable ? `${remainingFeet} из ${speedFeet} фт` : 'потрачено'}</b></span>
        <span className={actionReady || weaponAttackReady ? 'ready' : 'spent'}><small>Действие</small><b>{actionReady ? 'свободно' : weaponAttackReady ? `ещё ${weaponAttacksLeft} атака` : 'потрачено'}</b></span>
        <span className={bonusReady ? 'ready' : 'spent'}><small>Бонус</small><b>{bonusReady ? 'свободен' : 'потрачен'}</b></span>
        <span className={reactionReady ? 'ready' : 'spent'}><small>Реакция</small><b>{reactionReady ? 'свободна' : 'потрачена'}</b></span>
      </div>}
      {spellbookOpen && <section className="spellbook-panel" role="dialog" aria-modal="true" aria-label={`Книга заклинаний: ${activeName}`} onPointerDown={(event) => event.stopPropagation()}>
        <header><div><BookOpen size={21} /><span><small>КНИГА ЗАКЛИНАНИЙ</small><strong>{activeName}</strong></span></div><button onClick={() => setSpellbookOpen(false)} aria-label="Закрыть книгу заклинаний"><X size={18} /></button></header>
        <div className="spellbook-tools">
          <label><Target size={15} /><input value={spellSearch} onChange={(event) => setSpellSearch(event.target.value)} placeholder="Название или эффект…" /></label>
          <nav aria-label="Фильтр по кругу"><button className={spellLevelFilter === 'all' ? 'active' : ''} onClick={() => setSpellLevelFilter('all')}>Все</button>{availableSpellLevels.map((level) => <button key={level} className={spellLevelFilter === level ? 'active' : ''} onClick={() => setSpellLevelFilter(level)}>{level === 0 ? 'З' : level}</button>)}</nav>
          <span>{filteredSpellbookSpells.length} из {spells.length}</span>
        </div>
        <div className="spellbook-grid">{filteredSpellbookSpells.map((spell) => {
          const pinned = hotbarSpellIds.includes(spell.id)
          const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote)
          /* Книга открывается и вне боя, поэтому в ней тоже действует правило
             движка: боевое заклинание без инициативы выбрать нельзя. Иначе
             выбор проходил бы, книга закрывалась, а карта молча не предлагала
             ни одной цели — тупик без объяснения. */
          const lockedOutOfCombat = !combatActive && !castableOutOfCombat(spell)
          const unavailableReason = support.blocked ? `${support.label}. ${support.explanation}` : spell.prepared === false ? 'Заклинание не изучено или не подготовлено' : spell.actionType === 'long_cast' ? `Время накладывания: ${spell.castingTime}` : lockedOutOfCombat ? 'Боевое заклинание требует инициативы: сначала начните бой' : 'Выбрать заклинание'
          return <article key={spell.id} className={`${pinned ? 'pinned' : ''} ${spell.prepared === false ? 'unprepared' : ''} support-${support.status} spell-kind-${spell.kind}`}>
            <button className="spellbook-spell" onClick={() => { selectSpell(spell); if (spell.actionType !== 'long_cast') setSpellbookOpen(false) }} disabled={support.blocked || spell.actionType === 'long_cast' || spell.prepared === false || lockedOutOfCombat} title={unavailableReason}>
              <CombatIcon id={spell.id} kind="spell" hint={`${spell.kind} ${spell.damageType ?? ''} ${spell.name}`} size={76} /><span><strong>{spell.name}</strong><small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spell.castingTime || '1 действие'} · {spell.rangeText || `${spell.range} фт`}</small><em>{spell.description}</em></span>
            </button>
            <button className="pin-spell" disabled={support.blocked || spell.prepared === false} onClick={() => toggleHotbarSpell(spell.id)} aria-pressed={pinned} title={support.blocked ? unavailableReason : spell.prepared === false ? 'Сначала изучите или подготовьте заклинание' : pinned ? 'Убрать с панели' : 'Закрепить на панели'}>{pinned ? <Check size={15} /> : <Plus size={15} />}</button>
            {spell.concentration && <i className="spellbook-tag">К</i>}
            {spell.prepared === false && <i className="spellbook-tag unavailable">НЕ ПОДГОТОВЛЕНО</i>}
            {support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`} title={support.explanation}>{support.shortLabel}</i>}
          </article>
        })}</div>
      </section>}
      </div>
      {dossierSceneNpc && <div className="npc-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setNpcDossier(null)
      }}>
        <section className="npc-dialog" role="dialog" aria-modal="true" aria-labelledby="npc-dialog-title">
          <header>
            <NpcPortrait campaignId={state.sessionCode} npcId={dossierSceneNpc.id} name={dossierSceneNpc.name} />
            <span><small>{dossierSceneNpc.role || 'ПЕРСОНАЖ СЦЕНЫ'}</small><strong id="npc-dialog-title">{dossierSceneNpc.name}</strong></span>
            <button type="button" onClick={() => setNpcDossier(null)} aria-label="Закрыть разговор"><X size={18} /></button>
          </header>
          <div className="npc-dialog-status">
            <span><small>СТОЙКА НА СЦЕНЕ</small><b>{NPC_STANCE_LABELS[visibleNpcStance(dossierSceneNpc.stance)]}</b></span>
            <span><small>ОТНОШЕНИЕ К ГЕРОЮ</small><b>{NPC_RELATIONSHIP_LABELS[dossierRelationship]}</b></span>
            {dossierCaptive && <span className="npc-dialog-captive"><small>ПОЛОЖЕНИЕ</small><b>Пленник отряда</b></span>}
          </div>
          <div className="npc-dialog-body">
            <section className="npc-public-dossier">
              <header><BookOpen size={14} /><strong>Известно герою</strong><small>просмотр не расходует действие</small></header>
              <p>{dossierSocialNpc?.public_summary || 'Собеседник ещё не раскрыл о себе ничего сверх имени и роли.'}</p>
              {dossierSocialNpc?.voice && <blockquote>Манера речи: {dossierSocialNpc.voice}</blockquote>}
              {dossierSocialNpc?.tags?.length ? <div>{dossierSocialNpc.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
            </section>
            <section className="npc-conversation-history">
              <header><MessageSquare size={14} /><strong>Прошлые разговоры</strong><small>{dossierConversations.length}</small></header>
              {dossierConversations.length > 0
                ? dossierConversations.map((conversation) => <article key={conversation.id}>
                    <small>{NPC_CONVERSATION_STANCE_LABELS[conversation.stance]}</small>
                    <p><b>Вы:</b> {conversation.player_message}</p>
                    <p><b>{dossierSceneNpc.name}:</b> {conversation.npc_reply}</p>
                  </article>)
                : <em>Записанных разговоров пока нет.</em>}
            </section>
            <section className="npc-open-promises">
              <header><ScrollText size={14} /><strong>Открытые обещания</strong><small>{dossierPromises.length}</small></header>
              {dossierPromises.length > 0
                ? <ul>{dossierPromises.map((promise) => <li key={promise.id}><span>{promise.direction === 'npc_to_party' ? `${dossierSceneNpc.name} обещает` : 'Отряд обещает'}</span><b>{promise.text}</b>{promise.due_hint && <small>{promise.due_hint}</small>}</li>)}</ul>
                : <em>Открытых обещаний нет.</em>}
            </section>
          </div>
          <footer>
            {npcDossier?.mode === 'transfer'
              ? <form className="npc-gift-picker" onSubmit={submitNpcGift}>
                  <label>
                    <span>ПРЕДМЕТ ИЗ ИНВЕНТАРЯ {giftSender?.character?.toLocaleUpperCase('ru') ?? 'ГЕРОЯ'}</span>
                    <select
                      value={selectedGiftItemId}
                      disabled={!dossierCanReceiveGift || transferableGiftItems.length === 0}
                      aria-label={`Предмет для ${dossierSceneNpc.name}`}
                      onChange={(event) => {
                        setSelectedGiftItemId(event.target.value)
                        setGiftQuantity(1)
                      }}
                    >
                      {transferableGiftItems.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.quantity} шт.</option>)}
                    </select>
                  </label>
                  <label className="npc-gift-quantity">
                    <span>КОЛИЧЕСТВО</span>
                    <input
                      type="number"
                      min={1}
                      max={selectedGiftAvailable}
                      step={1}
                      value={giftQuantity}
                      disabled={!dossierCanReceiveGift || !selectedGiftItem}
                      aria-label="Количество передаваемых предметов"
                      onChange={(event) => setGiftQuantity(Math.max(1, Math.min(selectedGiftAvailable, Math.floor(Number(event.target.value) || 1))))}
                    />
                  </label>
                  <button type="submit" disabled={!dossierCanReceiveGift || !selectedGiftItem || giftQuantity > selectedGiftAvailable}><Send size={15} />Передать</button>
                  {transferableGiftItems.length === 0 && <em>Нет свободных предметов: экипированные и настроенные вещи передавать нельзя.</em>}
                  {tacticalError && <p className="npc-gift-error">{tacticalError}</p>}
                </form>
              : <>
                  <form onSubmit={submitNpcDialogue}>
                    <input
                      ref={npcDialogueInputRef}
                      value={npcDialogueText}
                      onChange={(event) => setNpcDialogueText(event.target.value)}
                      disabled={!dossierCanTalk}
                      placeholder={dossierCanTalk ? `Сказать ${dossierSceneNpc.name}…` : combatActive ? 'Разговор недоступен во время боя' : 'Собеседник сейчас недоступен'}
                      aria-label={`Реплика для ${dossierSceneNpc.name}`}
                    />
                    <button type="submit" disabled={!dossierCanTalk || !npcDialogueText.trim()}><Send size={15} />Сказать</button>
                  </form>
                  <small>Адресат закрепляется отдельно как <code>npc_id</code>; полное имя и роль остаются в читаемой реплике.</small>
                </>}
            {dossierCaptive && npcDossier?.mode !== 'transfer' && <div className="npc-dialog-captive-actions">
              <button
                type="button"
                disabled={captiveActionsBlocked || !dossierCaptive.pending_knowledge}
                title={dossierCaptive.pending_knowledge ? 'Допрос: проверка Запугивания против серверной СЛ' : 'Пленный уже всё рассказал'}
                onClick={() => onCaptiveAction(dossierCaptive.id, 'interrogate', 'intimidation')}
              ><Skull size={14} />Допросить</button>
              <button type="button" disabled={captiveActionsBlocked} title="Накормить связанного" onClick={() => onCaptiveAction(dossierCaptive.id, 'feed')}><Soup size={14} />Накормить</button>
              <button type="button" disabled={captiveActionsBlocked} title="Отпустить живым" onClick={() => { setNpcDossier(null); void onCaptiveAction(dossierCaptive.id, 'release') }}><Unlink size={14} />Отпустить</button>
              <button type="button" disabled={captiveActionsBlocked} title="Сдать страже поселения" onClick={() => { setNpcDossier(null); void onCaptiveAction(dossierCaptive.id, 'hand-over') }}><Gavel size={14} />Сдать страже</button>
            </div>}
            {dossierMerchant && npcDossier?.mode !== 'transfer' && <button
              className="npc-dialog-trade"
              type="button"
              disabled={combatActive || !dossierSceneNpc.alive || !dossierMerchant.available}
              onClick={() => { setNpcDossier(null); onOpenMerchant(dossierSceneNpc.id) }}
            ><Store size={14} />Торговать</button>}
          </footer>
        </section>
      </div>}
      <aside className="server-column" aria-label="Состояние сцены">
        <div className="server-resize" role="separator" aria-orientation="vertical" aria-label="Ширина правой колонки" onPointerDown={startServerResize} onDoubleClick={() => { setServerWidth(0); window.localStorage.removeItem(SERVER_WIDTH_KEY) }} title="Потяните, чтобы изменить ширину. Двойной щелчок — вернуть обычную" />
        {combatActive && <section className="combat-context-panel" aria-label="Текущее состояние боя" aria-live="polite">
          <header><div><small>СЕЙЧАС ХОДИТ · {activeTeam}</small><strong>{activeName}</strong></div><span><Heart size={13} />{activeHealth}</span></header>
          <CombatTurnClock clock={state.turn_clock} actorName={actorNameById(state.turn_clock?.actor_ids?.[0])} />
          {visibleBattleRoll && <BattleRollCard event={visibleBattleRoll} context={visibleBattleRollContext} />}
          <div className="combat-context-conditions" aria-label="Состояния активного участника">{activeConditions.length ? activeConditions.map((condition) => <span key={condition.id} className={condition.status} title={`${condition.statusLabel}. ${condition.explanation}${condition.duration ? ` Длительность: ${condition.duration}` : ''}`}><i />{condition.label}<small>{condition.status === 'marker' ? 'маркер' : condition.status === 'partial' ? 'частично' : 'работает'}</small></span>) : <em>Нет состояний</em>}</div>
          <div className="combat-context-command"><Target size={14} /><span><small>ВЫБРАННАЯ КОМАНДА</small><strong>{selected ? selectedCommandName : 'Ожидание хода союзника'}</strong></span></div>
          {inspectedTarget && <div className={`combat-target-inspector ${inspectedTarget.allowed ? 'allowed' : 'blocked'}`}>
            {/* Дистанция и причина берутся из серверного прогноза, когда он
                есть: снимок `inspectedTarget` делается в момент наведения и
                после перемещения показывал прежние футы. */}
            <span><small>{inspectedTarget.team === 'enemy' ? 'ПРОТИВНИК' : 'СОЮЗНИК'} · {inspectedForecast?.distance_feet ?? inspectedTarget.distanceFeet} ФТ</small><strong>{inspectedTarget.name}</strong><em>{inspectedTarget.healthLabel ? `${inspectedTarget.healthLabel} · параметры скрыты` : `${inspectedTarget.hp}/${inspectedTarget.maxHp} ОЗ`}</em></span>
            {(!inspectedForecast || !inspectedForecast.in_range) && <p>{inspectedTarget.reason}</p>}
            {inspectedForecast && <div className={`attack-forecast ${inspectedForecast.advantage && !inspectedForecast.disadvantage ? 'advantage' : inspectedForecast.disadvantage && !inspectedForecast.advantage ? 'disadvantage' : ''}`}>
              <header>
                <b>{inspectedForecast.in_range ? `${inspectedForecast.hit_chance}%` : '—'}</b>
                <span>{inspectedForecast.in_range ? 'шанс попасть' : 'не достать'}<small>{inspectedForecast.label}{inspectedForecast.in_range ? ` · крит ${inspectedForecast.critical_chance}%` : ` · ${inspectedForecast.unreachable_reason}`}</small></span>
              </header>
              <dl>
                <div><dt>Бросок</dt><dd>d20 {inspectedForecast.attack_modifier >= 0 ? '+' : '−'} {Math.abs(inspectedForecast.attack_modifier)}{inspectedForecast.advantage && !inspectedForecast.disadvantage ? ' с преимуществом' : inspectedForecast.disadvantage && !inspectedForecast.advantage ? ' с помехой' : ''}</dd></div>
                <div><dt>Против</dt><dd>{inspectedForecast.armor_class == null ? 'КД неизвестен' : `КД ${inspectedForecast.armor_class}`}{inspectedForecast.cover_bonus > 0 ? ` · ${inspectedForecast.cover_label ?? 'укрытие'} +${inspectedForecast.cover_bonus}` : ''}</dd></div>
                <div><dt>Урон</dt><dd>≈ {inspectedForecast.average_damage}</dd></div>
              </dl>
              {(inspectedForecast.advantage_sources.length > 0 || inspectedForecast.disadvantage_sources.length > 0) && <ul>
                {inspectedForecast.advantage_sources.map((reason) => <li key={`plus-${reason}`} className="plus">+ {reason}</li>)}
                {inspectedForecast.disadvantage_sources.map((reason) => <li key={`minus-${reason}`} className="minus">− {reason}</li>)}
              </ul>}
              {inspectedForecast.advantage && inspectedForecast.disadvantage && <small className="forecast-note">Преимущество и помеха гасят друг друга — бросается одна кость.</small>}
            </div>}
            {inspectedDamageHistory.length > 0 && <div className="token-damage-history" aria-label={`Последний полученный урон: ${inspectedTarget.name}`}>
              <small>ИСТОРИЯ УРОНА</small>
              <ol>{inspectedDamageHistory.map((entry) => <li key={entry.id}>
                <span>{entry.round != null ? `Р${entry.round}` : entry.sceneTurn != null ? `Х${entry.sceneTurn}` : '·'}</span>
                <b>−{entry.amount}</b>
                <em>{actorNameById(entry.actorId) || 'источник'}{entry.damageType ? ` · ${(SPELL_OPTION_LABELS[entry.damageType] ?? entry.damageType).toLocaleLowerCase('ru')}` : ''}</em>
              </li>)}</ol>
            </div>}
          </div>}
          {pendingCommand && <div className="combat-command-confirmation">
            <header><Target size={14} /><span><small>ЦЕЛЬ ЗАФИКСИРОВАНА</small><strong>{pendingCommandLabel}</strong></span></header>
            <p>Команда ждёт в строке действия внизу: добавьте слова, если хотите, и нажмите «Отправить».</p>
            <div><button onClick={() => { setPendingCommand(null); setAimCell(null); setInspectedTarget(null) }}><X size={13} />Отменить</button></div>
          </div>}
          {previewRoute && <div className={`movement-preview ${pendingMoveKey ? 'selected' : ''}`}>
            <span><Footprints size={14} /><b>{movementCostLabel(previewRoute)}</b><small>{previewRoute.path.length} кл. · останется {Math.max(0, remainingFeet - previewRoute.costFeet)} фт</small></span>
            {pendingMoveKey && selected && <div><button disabled={tacticalBusy} onClick={() => { const [x, y] = pendingMoveKey.split(',').map(Number); void onMove(selected, x, y).then((outcome) => { if (outcome.ok) setPendingMoveKey(null) }) }}><Check size={13} />Подтвердить</button><button onClick={() => setPendingMoveKey(null)} aria-label="Отменить маршрут"><X size={13} /></button></div>}
          </div>}
          {recentCombatJournal.length > 0 && <section className="board-combat-journal" aria-label="Боевая хроника, связанная с картой">
          <header><Swords size={14} /><strong>Боевая хроника</strong><small>наведите — участники подсветятся</small></header>
          <div>{recentCombatJournal.map((event) => {
            const participantIds = battleEventParticipantIds(event)
            const linked = participantIds.some((id) => linkedParticipantIds.includes(id))
            return <article
              key={event.id}
              className={linked ? 'linked' : ''}
              tabIndex={0}
              onMouseEnter={() => setLinkedParticipantIds(participantIds)}
              onMouseLeave={() => setLinkedParticipantIds([])}
              onFocus={() => setLinkedParticipantIds(participantIds)}
              onBlur={() => setLinkedParticipantIds([])}
            >
              <i>{event.round ?? event.sceneTurn ?? '·'}</i>
              <p>{battleEventText(state, event)}</p>
            </article>
          })}</div>
        </section>}
        {npcSummaryEvents.length > 0 && <section className="npc-turn-summary" aria-label="Сводка ходов противников" aria-live="polite">
          <header><History size={14} /><span><small>ПОКА ВЫ ЖДАЛИ</small><strong>Ходы противников</strong></span></header>
          <ol>{npcSummaryEvents.map((event) => <li key={event.id}>{battleEventText(state, event)}</li>)}</ol>
        </section>}
        </section>}
        {truce && <section className="truce-panel" aria-label="Условия перемирия" aria-live="polite">
          <header><Handshake size={15} /><span><small>ПЕРЕМИРИЕ · РАУНД {truce.round ?? combat.round ?? 1}</small><strong>Говорит {truce.leader_name || 'предводитель уцелевших'}</strong></span></header>
          <p>
            Оружие опущено, очередь заморожена. Любая атака рвёт уговор — и это запомнят.
            {truce.hero_name ? ` Переговоры ведёт ${truce.hero_name}.` : ''}
          </p>
          <div className="truce-terms">
            {(truce.outcomes ?? []).map((outcome) => {
              const term = PARLEY_TERM_LABELS[outcome]
              if (!term) return null
              return <button
                key={outcome}
                type="button"
                className={`truce-term term-${outcome}`}
                disabled={!canAct || narrating || tacticalBusy}
                title={term.summary}
                onClick={() => { void onSettleParley(outcome) }}
              >
                <b>{term.label}</b>
                <small>{term.summary}</small>
                {outcome === 'tribute' && Number(truce.tribute_cp) > 0 ? <em>откуп: {truce.tribute_cp} мм</em> : null}
              </button>
            })}
          </div>
        </section>}
        {guardEncounter && <section className="guard-panel" aria-label="Встреча со стражей" aria-live="polite">
          <header><ShieldAlert size={15} /><span><small>СТРАЖА · {guardEncounter.place_name || 'поселение'}</small><strong>{guardEncounter.officer_rank || 'стражник'} {guardEncounter.officer_name || ''}</strong></span></header>
          <p className="guard-demand">{guardEncounter.demand || '«Стоять. Разговор есть».'}</p>
          {Number(guardEncounter.escape_attempts) > 0 && <p className="guard-warning">Уйти уже пробовали — теперь стража смотрит в оба, и проверка идёт с помехой.</p>}
          <div className="guard-options">
            {(guardEncounter.options ?? []).map((option) => <button
              key={option.id}
              type="button"
              className={`guard-option option-${option.id}`}
              disabled={!canAct || narrating || tacticalBusy || (option.id === 'fine' && !canPayGuardFine)}
              title={option.id === 'fine' && !canPayGuardFine ? 'На виру не хватает монет' : option.summary}
              onClick={() => { void onResolveGuardEncounter(option.id, option.id === 'flee' ? guardEscapeSkill : undefined) }}
            >
              <b>{option.label}</b>
              <small>{option.summary}</small>
            </button>)}
          </div>
          <div className="guard-escape-skill" role="group" aria-label="Как уходить">
            <span>Уходить:</span>
            {(['stealth', 'athletics'] as const).map((skill) => <button
              key={skill}
              type="button"
              className={guardEscapeSkill === skill ? 'active' : ''}
              disabled={!canAct || narrating || tacticalBusy}
              onClick={() => setGuardEscapeSkill(skill)}
            >{skill === 'stealth' ? 'тихо (Скрытность)' : 'напролом (Атлетика)'}</button>)}
          </div>
        </section>}
        {tavern && <section className="tavern-panel" aria-label="Жизнь таверны" aria-live="polite">
          <header><Beer size={15} /><span><small>ЗАВЕДЕНИЕ · {tavern.place_name || 'таверна'}</small><strong>{tavernRound ? 'Кость на столе' : 'Кости и выпивка'}</strong></span></header>
          {/* Заметка о запрете входа и блок раунда идут **рядом**, а не через
              «или»: выставленный за дверь остаётся с открытым раундом на руках,
              и до ревью панель рисовала ему одну заметку — кнопки «встать из-за
              стола» выставленный не видел вовсе, хотя движок её ему разрешает.
              Возврата за ней нет: скандал он устроил сам, и его уход — такая же
              сдача, как любая другая. */}
          {tavern.ejected && <p className="tavern-note">Отсюда героя выставили: за этим столом ему больше не наливают и в кости с ним не садятся.</p>}
          {tavernRound
            ? <>
              <p className="tavern-note">
                {tavernRound.npc_name || 'Соперник'} выбросил <b>{tavernRound.npc_total}</b>. Нужно <b>{tavernRound.target}</b> или больше,
                чтобы забрать банк в {tavernRound.stake_cp * 2} мм. Ставка в {tavernRound.stake_cp} мм уже на столе.
              </p>
              <div className="tavern-approaches">
                {([
                  { id: 'fair' as const, label: 'Бросить честно', summary: 'Просто кость: чей бросок старше, тот и забрал банк.', icon: <Dices size={13} /> },
                  { id: 'cheat' as const, label: 'Подкрутить кость', summary: 'Подменённая кость даёт +5 к вашему броску, но идёт Ловкость рук против чужой Проницательности: поймают — скандал и потерянная ставка.', icon: <Sparkles size={13} /> },
                  { id: 'watch' as const, label: 'Следить за руками', summary: 'Проницательность: если сосед мечет краплёными, это можно разглядеть.', icon: <Eye size={13} /> },
                ]).map((approach) => <button
                  key={approach.id}
                  type="button"
                  className={`tavern-approach approach-${approach.id}`}
                  disabled={tavernActionsBlocked || tavernPatronEjected}
                  title={tavernPatronEjected ? 'Героя выставили за дверь: доигрывать не с кем' : approach.summary}
                  onClick={() => { void onAnswerTavernDiceRound(approach.id) }}
                >
                  {approach.icon}
                  <b>{approach.label}</b>
                  <small>{approach.summary}</small>
                </button>)}
              </div>
              {/* Встать из-за стола можно всегда — но никогда даром, и цену
                  игрок обязан увидеть **до** клика, а не в подписи под ним.
                  Ставка уже ушла из кошелька на стол, поэтому уход от кости —
                  это сдача: она остаётся сопернику ровно как при проигрыше.
                  Возвратов у неё нет ни одного, и обещать их доска не может.

                  Поэтому кнопка двухщелчковая всегда: щелчок необратим и стоит
                  до 200 мм. Тем же порядком на этой панели идут команды с целью
                  (`combat-command-confirmation`), и заводить сдаче свой обычай
                  незачем. Выставленному за дверь она нужна тем более: ответить
                  ему нельзя, а деньги у него на столе. */}
              <div className={`tavern-leave${tavernSurrenderPending ? ' confirming' : ''}`}>
                <button
                  type="button"
                  className="tavern-action action-leave"
                  disabled={tavernActionsBlocked}
                  title={tavernSurrenderPending
                    ? `Подтвердите: ${tavernRound.stake_cp} мм со стола останутся сопернику`
                    : `Спросит подтверждения: ставка в ${tavernRound.stake_cp} мм со стола останется сопернику`}
                  onClick={() => {
                    if (!tavernSurrenderPending) { setTavernSurrenderRoundId(tavernRound.id); return }
                    setTavernSurrenderRoundId('')
                    void onLeaveTavernDiceRound()
                  }}
                ><DoorOpen size={13} />{tavernSurrenderPending ? `Подтвердить сдачу · −${tavernRound.stake_cp} мм` : 'Встать из-за стола'}</button>
                {tavernSurrenderPending && <button
                  type="button"
                  className="tavern-action action-leave-cancel"
                  onClick={() => setTavernSurrenderRoundId('')}
                ><X size={13} />Остаться за столом</button>}
                <small>
                  {tavernPatronEjected
                    ? `Доигрывать выставленному нельзя, и остаётся только сдаться: раунд закроется, а ставку в ${tavernRound.stake_cp} мм со стола заберёт ${tavernRound.npc_name || 'соперник'}.`
                    : tavernSurrenderPending
                      ? `Кость ${tavernRound.npc_name || 'соперника'} ещё жива: подтвердите — и ${tavernRound.stake_cp} мм со стола уйдут ему.`
                      : `Ставка в ${tavernRound.stake_cp} мм уже на столе: встать можно, но это сдача — ставку заберёт ${tavernRound.npc_name || 'соперник'}.`}
                </small>
              </div>
            </>
            : tavern.ejected
              ? null
              : <>
                <div className="tavern-dice-setup" role="group" aria-label="Игра в кости">
                  <label>
                    <span>Соперник</span>
                    <select
                      value={chosenTavernOpponentId}
                      disabled={tavernActionsBlocked || !tavernOpponents.length}
                      onChange={(event) => setTavernOpponentId(event.target.value)}
                    >
                      {tavernOpponents.length
                        ? tavernOpponents.map((npc) => <option key={npc.id} value={npc.id}>{npc.name}{npc.role ? ` (${npc.role})` : ''}{Number(npc.max_stake_cp ?? 0) > 0 ? '' : ' · на мели'}</option>)
                        : <option value="">за столом никого нет</option>}
                    </select>
                  </label>
                  <div className="tavern-stakes" role="group" aria-label="Ставка">
                    {tavernStakes.map((stake) => <button
                      key={stake.stake_cp}
                      type="button"
                      className={chosenTavernStakeCp === stake.stake_cp ? 'active' : ''}
                      disabled={tavernActionsBlocked || activeHeroPurseCp < stake.stake_cp || tavernOpponentMaxStakeCp < stake.stake_cp}
                      title={activeHeroPurseCp < stake.stake_cp
                        ? 'На такую ставку не хватает монет'
                        : tavernOpponentMaxStakeCp < stake.stake_cp ? 'Соперник такую ставку не закроет' : `${stake.stake_cp} мм`}
                      onClick={() => setTavernStakeCp(stake.stake_cp)}
                    >{stake.label} · {stake.stake_cp} мм</button>)}
                  </div>
                  <button
                    type="button"
                    className="tavern-action action-dice"
                    disabled={tavernActionsBlocked || !chosenTavernOpponentId || !chosenTavernStakeCp || activeHeroPurseCp < chosenTavernStakeCp || tavernOpponentMaxStakeCp < chosenTavernStakeCp}
                    title={activeHeroPurseCp < chosenTavernStakeCp
                      ? 'На ставку не хватает монет'
                      : tavernOpponentMaxStakeCp < chosenTavernStakeCp
                        ? 'У соперника столько не наберётся'
                        : `Соперник мечет первым, отвечать будете вы. Ставка в ${chosenTavernStakeCp} мм уходит из кошелька на стол сразу`}
                    onClick={() => { void onOpenTavernDiceRound(chosenTavernOpponentId, chosenTavernStakeCp) }}
                  ><Dices size={13} />Сыграть в кости</button>
                </div>
                <div className="tavern-drink">
                  <button
                    type="button"
                    className="tavern-action action-drink"
                    disabled={tavernActionsBlocked || activeHeroPurseCp < Number(tavern.drink_price_cp ?? 0)}
                    title={activeHeroPurseCp < Number(tavern.drink_price_cp ?? 0) ? 'На выпивку не хватает монет' : 'Кружка эля из кошелька'}
                    onClick={() => { void onOrderTavernDrink() }}
                  ><Beer size={13} />Заказать выпивку · {tavern.drink_price_cp ?? 0} мм</button>
                  <small>
                    Выпито за вечер: {tavern.drinks ?? 0}.
                    {Number(tavern.social_bonus) > 0 ? ` Разговор идёт легче: +${tavern.social_bonus} к Убеждению до конца сцены.` : ''}
                    {tavern.next_drink_dc != null ? ` Следующая кружка — спасбросок Телосложения СЛ ${tavern.next_drink_dc}.` : ''}
                  </small>
                </div>
              </>}
        </section>}
        {/* Почта отряда. Панель складная и по умолчанию закрыта: письмо — не
            срочное действие, и держать открытым бланк рядом с боем незачем.
            Показывается она только там, где почте есть смысл, — когда отряд
            знает хоть одного адресата или уже отправил хоть одно письмо. */}
        {(letterAddressees.length > 0 || heroLetters.length > 0) && <section className="letters-panel" aria-label="Почта отряда" aria-live="polite">
          <header>
            <Mail size={15} />
            <span><small>ПОЧТА ОТРЯДА{heroLettersInTransit.length ? ` · В ПУТИ: ${heroLettersInTransit.length}` : ''}</small><strong>Письма и курьеры</strong></span>
            <button
              type="button"
              className="letters-toggle"
              aria-expanded={lettersOpen}
              onClick={() => setLettersOpen((value) => !value)}
            >{lettersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{lettersOpen ? 'Свернуть' : 'Написать письмо'}</button>
          </header>
          {heroLetters.length > 0 && <ul className="letters-list">
            {heroLetters.slice(0, 4).map((letter) => <li key={letter.id} className={`letter-row letter-${letter.status}`}>
              {letter.status === 'answered'
                ? <MailOpen size={13} />
                : letter.status === 'returned' || letter.status === 'unanswered' ? <MailX size={13} /> : <Mail size={13} />}
              <b>{letter.addressee_name}</b>
              <i>{letter.status_label}</i>
              {letter.reply ? <span className="letter-reply">{letter.reply}</span> : null}
            </li>)}
          </ul>}
          {lettersOpen && <div className="letters-compose">
            <label>
              <span>Кому</span>
              <select
                value={chosenLetterAddressee?.id ?? ''}
                disabled={!letterAddressees.length}
                onChange={(event) => setLetterAddresseeId(event.target.value)}
              >
                {letterAddressees.length
                  ? letterAddressees.map((entry) => <option key={`${entry.kind}:${entry.id}`} value={entry.id}>
                    {entry.name}{entry.role ? ` (${entry.role})` : ''} · {entry.leagues} перех. · {entry.fee_cp} мм
                  </option>)
                  : <option value="">писать пока некому</option>}
              </select>
            </label>
            <textarea
              value={letterBody}
              maxLength={letterBodyLimit}
              rows={4}
              placeholder="Что написать? Обещание в письме — обещание."
              onChange={(event) => setLetterBody(event.target.value)}
            />
            <div className="letters-send">
              <button
                type="button"
                className="letter-action action-send"
                disabled={Boolean(letterBlockReason)}
                title={letterBlockReason || `Курьер возьмёт ${letterFeeCp} мм и повезёт письмо ${chosenLetterAddressee?.leagues ?? 0} перех.`}
                onClick={() => {
                  if (!chosenLetterAddressee) return
                  // Поле чистится **только по ok** — тем же порядком, что и
                  // реплика в разговоре с NPC выше по файлу. Отказ движка (бой
                  // начался, кошелёк потратил сосед, адресат вошёл в зал) или
                  // обрыв сети иначе уничтожали бы до 1200 знаков, которые
                  // игрок только что написал, без возможности их вернуть.
                  void (async () => {
                    const outcome = await onSendLetter(chosenLetterAddressee.kind, chosenLetterAddressee.id, letterBody)
                    if (outcome.ok) setLetterBody('')
                  })()
                }}
              ><Send size={13} />Отправить с курьером · {letterFeeCp} мм</button>
              <small>
                {letterBlockReason
                  ? letterBlockReason
                  : `Ответа ждать не раньше, чем отряд переночует: курьеру ехать ${chosenLetterAddressee?.leagues ?? 0} перех.${chosenLetterAddressee?.place_name ? ` до «${chosenLetterAddressee.place_name}»` : ''}.`}
              </small>
            </div>
          </div>}
        </section>}
        {heldCaptives.length > 0 && <section className="captive-panel" aria-label="Пленники отряда">
          <header><UserLock size={15} /><span><small>ПЛЕННИКИ · {heldCaptives.length}</small><strong>Судьба решается вами</strong></span></header>
          {heldCaptives.map((captive) => {
            const starving = captive.neglected_at_minutes != null
            return <article key={captive.id} className={`captive-card${starving ? ' starving' : ''}`}>
              <header>
                <i className="captive-tag">ПЛЕННИК</i>
                <b>{captive.name}</b>
                <small>{captive.role || 'без роли'} · {captive.origin === 'knocked_out' ? 'взят без сознания' : 'сдался в бою'}</small>
              </header>
              <p>
                {captive.pending_knowledge
                  ? `Похоже, ему есть что рассказать (${captive.pending_knowledge}).`
                  : 'Всё, что знал, уже сказано.'}
                {starving ? ' Голодает — это уже жестокость.' : ''}
              </p>
              <div className="captive-actions">
                <button
                  type="button"
                  disabled={captiveActionsBlocked || !captive.pending_knowledge}
                  title={captive.pending_knowledge ? 'Проверка Запугивания против серверной СЛ' : 'Пленный уже всё рассказал'}
                  onClick={() => onCaptiveAction(captive.id, 'interrogate', 'intimidation')}
                ><Skull size={13} />Допросить</button>
                <button
                  type="button"
                  disabled={captiveActionsBlocked || !captive.pending_knowledge}
                  title={captive.pending_knowledge ? 'Проверка Убеждения против серверной СЛ' : 'Пленный уже всё рассказал'}
                  onClick={() => onCaptiveAction(captive.id, 'interrogate', 'persuasion')}
                ><MessageSquare size={13} />Уговорить</button>
                <button type="button" disabled={captiveActionsBlocked} title="Накормить: сутки без еды считаются жестокостью" onClick={() => onCaptiveAction(captive.id, 'feed')}><Soup size={13} />Накормить</button>
                <button type="button" disabled={captiveActionsBlocked} title="Отпустить живым: пощажённый это запомнит" onClick={() => onCaptiveAction(captive.id, 'release')}><Unlink size={13} />Отпустить</button>
                <button type="button" disabled={captiveActionsBlocked} title="Сдать страже поселения: награда и слава закона" onClick={() => onCaptiveAction(captive.id, 'hand-over')}><Gavel size={13} />Сдать страже</button>
                <button className="captive-execute" type="button" disabled={captiveActionsBlocked} title="Убить связанного. Это поступок жестокости, и мир его запомнит" onClick={() => onCaptiveAction(captive.id, 'execute')}><Swords size={13} />Убить</button>
              </div>
            </article>
          })}
        </section>}
        {(beastCandidates.length > 0 || beastCompanions.length > 0) && <section className="beast-panel" aria-label="Звери отряда">
          <header><PawPrint size={15} /><span><small>ЗВЕРИ · {beastCandidates.length + beastCompanions.length}</small><strong>Кого можно увести с собой</strong></span></header>
          {beastCompanions.map((companion) => <article key={companion.id} className="beast-card companion">
            <header>
              <i className="beast-tag companion">СПУТНИК</i>
              <b>{companion.name}</b>
              <small>идёт с отрядом · в бой не вводится</small>
            </header>
            <p>На привале держит стражу: Восприятие лагеря идёт с преимуществом.</p>
            <div className="beast-actions">
              <button
                type="button"
                disabled={beastActionsBlocked || companion.scare_cooldown_minutes > 0}
                title={companion.scare_cooldown_minutes > 0
                  ? `Зверь только что отогнал одну тварь: ждать ещё ${companion.scare_cooldown_minutes} мин игрового времени`
                  : 'Отогнать мелкую угрозу. Механики за этим нет — только строка в летописи'}
                onClick={() => onBeastAction(companion.id, 'scare')}
              ><Ear size={13} />Отогнать</button>
            </div>
          </article>)}
          {beastCandidates.map((candidate) => <article key={candidate.id} className={`beast-card${candidate.diet === 'predator' ? ' predator' : ''}${candidate.out_of_reach ? ' out-of-reach' : ''}`}>
            <header>
              <i className={`beast-tag${candidate.diet === 'predator' ? ' predator' : ''}`}>{(candidate.diet_label || 'зверь').toLocaleUpperCase('ru')}</i>
              <b>{candidate.name}</b>
              <small>{candidate.stage_label || 'сторожится'}{candidate.wounded ? ' · ранен' : ''}{candidate.broken_morale ? ' · сломлен' : ''}</small>
            </header>
            <p>
              Уход за животными, СЛ {candidate.difficulty}
              {candidate.parts?.length ? ` (${candidate.parts.filter((part) => part.id !== 'base').map((part) => `${part.label} ${part.shift > 0 ? `+${part.shift}` : part.shift}`).join(', ')})` : ''}.
              {candidate.bites_on_failure ? ' При провале укусит.' : ''}
            </p>
            {/* Досягаемость: приручение — это ладонь и еда, а не окрик через
                поляну. Карточка не исчезает, а гаснет и зовёт подойти. */}
            {candidate.out_of_reach && <p className="beast-reach">
              До зверя ещё идти{typeof candidate.distance_feet === 'number' ? `: ${candidate.distance_feet} фт` : ''}. Подойдите вплотную.
            </p>}
            <div className="beast-actions">
              <button
                type="button"
                disabled={beastActionsBlocked || candidate.out_of_reach === true || candidate.stage === 'calmed'}
                title={candidate.out_of_reach
                  ? 'Сначала подойдите к зверю вплотную'
                  : candidate.stage === 'calmed'
                    ? 'Зверь успокоен и ждёт еды с руки'
                    : candidate.stage === 'fed' ? 'Позвать за собой: проверка против объявленной СЛ' : 'Проверка Ухода за животными против серверной СЛ'}
                onClick={() => onBeastAction(candidate.id, 'calm')}
              ><PawPrint size={13} />{candidate.stage === 'fed' ? 'Приручить' : 'Успокоить'}</button>
              <button
                type="button"
                disabled={beastActionsBlocked || candidate.out_of_reach === true || candidate.stage !== 'calmed'}
                title={candidate.out_of_reach
                  ? 'Еду с руки дают вплотную: сначала подойдите'
                  : candidate.stage === 'calmed' ? 'Дать еду с руки: паёк спишется из рюкзака' : 'С руки едят только успокоенные'}
                onClick={() => onBeastAction(candidate.id, 'feed')}
              ><Soup size={13} />Покормить</button>
            </div>
          </article>)}
        </section>}
        {!combatActive && <section className="rest-controls" aria-label="Отдых">
          <header><Flame size={15} /><span><small>ПЕРЕДЫШКА</small><strong>Отдых героя</strong></span></header>
          {!activeRest
            ? <>
                <p>Короткий отдых откроет поштучный расход костей хитов. Долгий пройдёт атомарно.</p>
                <div>
                  <button disabled={!canAct || narrating || Boolean(state.pendingCheck)} onClick={() => onStartRest('short')}>Короткий · 1 час</button>
                  <button disabled={!canAct || narrating || Boolean(state.pendingCheck)} onClick={() => onStartRest('long')}>Долгий · 8 часов</button>
                </div>
              </>
            : activeRest.reason === 'knockout'
              ? <p>Герой приходит в себя. Время восстановления рассчитывает сервер.</p>
            : activeRest.kind !== 'short' || activeRest.schema_version !== 2
              ? <p>Отдых уже начат. Его длительность и завершение определяет сервер.</p>
            : <>
                <p>Короткий отдых идёт. Кости хитов: {hitPointDiceRemaining}/{hitPointDice?.maximum ?? 0} · d{hitPointDice?.die_size ?? 8}. {hitPointDieBlockedReason ?? 'Можно потратить одну кость и снова оценить состояние.'}</p>
                <div>
                  <button
                    disabled={!canAct || narrating || Boolean(state.pendingCheck) || Boolean(hitPointDieBlockedReason)}
                    title={hitPointDieBlockedReason ?? `Бросить 1d${hitPointDice?.die_size ?? 8} и добавить модификатор Телосложения`}
                    onClick={onSpendHitPointDie}
                  >Потратить 1d{hitPointDice?.die_size ?? 8}</button>
                  <button disabled={!canAct || narrating || Boolean(state.pendingCheck)} onClick={onCompleteRest}>Завершить отдых</button>
                </div>
              </>}
        </section>}
        {children}
      </aside>
      <section className="turn-rail">
        {/* Ручка высоты: тянется вверх и вниз, значение переживает перезагрузку. */}
        <div className="rail-resize" role="separator" aria-orientation="horizontal" aria-label="Высота нижней панели" onPointerDown={startRailResize} onDoubleClick={() => { setRailHeight(0); window.localStorage.removeItem(RAIL_HEIGHT_KEY) }} title="Потяните, чтобы изменить высоту. Двойной щелчок — вернуть обычную" />
      {/* Свободный ввод присутствует во ВСЕХ состояниях, включая бой. Продуктовые
          принципы 2 и 3 требуют, чтобы предложения интерфейса не были границами;
          раньше в бою на месте этого поля стоял только хотбар, и у принципа не было
          носителя в UI. Ход не расходуется до подтверждённого сервером броска. */}
      {/* Одна строка на всё: слева колоды, справа поле и «Отправить». Выбранное
          действие подтверждается той же кнопкой — отдельного «Подтвердить»
          больше нет, а слова игрока уезжают вместе с командой. */}
      <form
        className="rail-free-input"
        onSubmit={async (event) => {
          event.preventDefault()
          if (narrating) return
          const text = freeText.trim()
          if (pendingCommand) {
            const outcome = await confirmPreparedCommand(text || undefined)
            if (outcome?.ok) updateFreeText('')
            return
          }
          if (selfCastReady) {
            const outcome = await confirmSelfCast(text || undefined)
            if (outcome?.ok) updateFreeText('')
            return
          }
          if (!text) return
          const outcome = await onFreeAction(text)
          if (outcome.ok) updateFreeText('')
        }}
      >
        <nav className="hotbar-decks" role="tablist" aria-label="Категории действий">
          {([
            ['common', 'Основные', <CombatIcon id="deck-common" kind="deck" hint="перемещение основные действия" size={21} compact />],
            ['weapon', 'Атаки', <CombatIcon id="deck-weapon" kind="deck" hint="оружие атака меч" size={21} compact />],
            ['magic', 'Заклинания', <CombatIcon id="deck-magic" kind="deck" hint="магия заклинания" size={21} compact />],
            ['class', 'Классовые', <CombatIcon id="deck-class" kind="deck" hint="классовые способности защита" size={21} compact />],
            ['items', 'Предметы', <CombatIcon id="deck-items" kind="deck" hint="предметы зелья" size={21} compact />],
          ] as Array<[CombatDeck, string, React.ReactNode]>).map(([deck, label, icon]) => <button type="button" key={deck} role="tab" aria-selected={activeDeck === deck} className={activeDeck === deck ? 'active' : ''} onClick={() => setActiveDeck(deck)} disabled={tacticalBusy || (deck === 'magic' && !spells.length)} title={label}>{icon}<span>{label}</span></button>)}
        </nav>
        <div className="rail-input-shell">
          {preparedLabel && <span className={`prepared-chip ${awaitingTarget ? 'awaiting' : ''}`}><CombatIcon id="prepared-command" kind="roll" hint="выбранное действие" size={15} compact /><b>{preparedLabel}</b><button type="button" onClick={clearPrepared} aria-label="Снять выбранное действие"><X size={12} /></button></span>}
          <input
            ref={freeInputRef}
            value={freeText}
            onChange={(event) => updateFreeText(event.target.value)}
            placeholder={preparedLabel ? 'Добавьте слова к действию — или отправьте как есть' : `Опишите действие ${activeName} так, как сказали бы за столом — Арбитр найдёт правило`}
            aria-label="Действие своими словами"
            disabled={narrating || (combatActive && !canAct)}
            title={narrating ? 'Рассказчик разрешает предыдущее действие' : combatActive && !canAct ? `Сейчас ходит ${activeName}` : 'Отправить намерение от имени выбранного героя'}
          />
        </div>
        <button type="submit" disabled={narrating || (combatActive && !canAct) || ((!preparedLabel || awaitingTarget) && !freeText.trim())} title={narrating ? 'Рассказчик разрешает предыдущее действие' : combatActive && !canAct ? `Сейчас ходит ${activeName}` : awaitingTarget ? 'Сначала выберите цель на карте' : !preparedLabel && !freeText.trim() ? 'Сначала опишите действие' : 'Отправить действие'}><Send size={17} />Отправить</button>
      </form>
      {/* Панель одна на оба режима. Раньше вне боя вместо неё показывалась полоска
          «исследование», а колоды и плитки не рендерились вовсе: игрок не видел, чем
          вообще владеет герой, пока не бросит инициативу. Место под панель в сетке
          зарезервировано всегда, поэтому показывать арсенал ничего не стоит. */}
      <section className={`tactical-control combat-hotbar ${combatActive ? '' : 'out-of-combat'}`} aria-label={combatActive ? `Панель боевых действий: ${activeName}` : `Панель действий вне боя: ${activeName}`}>
        {/* Ряд рисуется только со своим содержимым: остаток хода уехал под стол,
            и в бою здесь не остаётся ничего, кроме пустой полосы отступов. */}
        {!combatActive && <div className="hotbar-controls-row">
          <div className="hotbar-exploration-note">
            {/* Сам режим переехал на поле, по центру сверху: он относится к карте,
                а не к панели действий. Здесь остались вход в бой и выход из
                локации — два решения, которые не выражаются плиткой действия.

                Уход показывается всегда вне боя, в том числе когда противников в
                сцене не осталось: именно тогда уйти и хочется, а прежде ряд без
                кнопки боя не рисовался вовсе. Отряд она не уводит — открывает
                голосование, а переход исполняет сервер по его результату. Замок
                тот же, что у свободного ввода вне боя, и не строже: кнопка — ярлык
                к той же фразе, и запирать её там, где те же слова можно набрать
                руками, не за что. */}
            {/* Пока стража стоит перед отрядом, уход закрыт: сервер такой переход
                и не пропустит (`GUARD_ENCOUNTER_BLOCKS_SCENE`), а «бежать» —
                это ответ офицеру с групповой проверкой, а не эта кнопка. */}
            <button
              className="exploration-leave-location"
              disabled={narrating || tacticalBusy || Boolean(guardEncounter)}
              onClick={onLeaveLocation}
              title={guardEncounter
                ? 'Стража стоит перед отрядом — сначала ответьте офицеру'
                : 'Предложить отряду покинуть локацию. Переход начнётся после решения группы'}
            ><DoorOpen size={22} /><span><small>Решение группы</small><strong>Покинуть локацию</strong></span></button>
            {showStartCombat && <button className="exploration-start-combat" disabled={!canAct || tacticalBusy} onClick={onStartCombat}><CombatIcon id="start-combat" kind="start-combat" hint="инициатива начать бой" size={27} compact /><span><small>Бросить инициативу</small><strong>Начать бой</strong></span></button>}
          </div>
        </div>}
        <div className="hotbar-main">
          {/* Настройки панели держатся у самой панели, а не в строке ввода: замок
              бережёт расстановку, вторая кнопка меняет число рядов. */}
          <div className="tile-toolbar" role="group" aria-label="Настройки панели действий">
            <button type="button" className={tilesLocked ? '' : 'active'} aria-pressed={!tilesLocked} onClick={() => { const next = !tilesLocked; setTilesLocked(next); window.localStorage.setItem(TILE_LOCK_KEY, next ? 'locked' : 'unlocked') }} title={tilesLocked ? 'Разблокировать: плитки можно перетаскивать' : 'Заблокировать: расстановка сохранится'}>{tilesLocked ? <Lock size={15} /> : <LockOpen size={15} />}</button>
            <button type="button" onClick={() => setTileRows(tileRows === 1 ? 2 : 1)} title={tileRows === 1 ? 'Сейчас один ряд плиток — переключить на два' : 'Сейчас два ряда плиток — переключить на один'} aria-label={`Рядов плиток: ${tileRows}`}>{tileRows === 1 ? <span className="rows-glyph one"><i /></span> : <span className="rows-glyph two"><i /><i /></span>}</button>
          </div>
          {/* Кнопки хода живут внутри карточки действий, прижатые к её правому
              краю: они завершают тот же выбор, что и плитки, а отдельной колонкой
              между колодой и описанием рвала строку надвое. Прокрутка плиток их
              не уносит — они лежат рядом с областью прокрутки, а не в ней. */}
          <div className="hotbar-actions-shell">
          <div className="hotbar-actions" role="tabpanel" aria-label="Доступные действия">
            {orderedTiles.map(({ id, node }) => cloneElement(node as React.ReactElement<Record<string, unknown>>, {
              key: id,
              draggable: !tilesLocked,
              onDragStart: () => setDraggedTileId(id),
              onDragOver: (event: React.DragEvent) => { if (!tilesLocked) event.preventDefault() },
              onDrop: (event: React.DragEvent) => { event.preventDefault(); moveTile(id); setDraggedTileId(null) },
              onDragEnd: () => setDraggedTileId(null),
              className: `${(node.props as { className?: string }).className ?? ''}${tilesLocked ? '' : ' movable'}`,
            }))}
            {((activeDeck === 'magic' && !spells.length) || (activeDeck === 'class' && !combatActions.some((action) => action.category === 'class')) || (activeDeck === 'items' && !combatItems.some((item) => item.type !== 'weapon'))) && <div className="hotbar-empty"><LockKeyhole size={18} /><span>У героя нет доступных действий этой категории</span></div>}
          </div>
          {/* Кнопки шага: вне боя это подтверждение выбранной цели и двери под
              рукой, в бою — ещё нокаут, смена оружия и завершение хода. Без
              содержимого блок не рисуется, и плитки занимают всю карточку. */}
          {(combatActive || pendingCommand || doorsAtHand.length > 0 || selectedSceneObject) && <div className="hotbar-turn-controls">
            {/* Дверь рядом — единственное, что делается и вне боя: заперто это
                или просто прикрыто, игрок видит по самой кнопке. */}
            {doorsAtHand.map((door) => {
              const direction = active ? doorDirectionFromActor(door, active) : ''
              const lockDc = Math.max(10, door.lockDc)
              const hoverProps = {
                onPointerEnter: () => setHoveredDoorId(door.id),
                onPointerLeave: () => setHoveredDoorId((current) => current === door.id ? null : current),
                onFocus: () => setHoveredDoorId(door.id),
                onBlur: () => setHoveredDoorId((current) => current === door.id ? null : current),
              }
              return door.state === 'locked'
                ? <button {...hoverProps} key={door.id} className="door-control locked" disabled={!canAct || tacticalBusy} onClick={() => selected && onOperateDoor(selected, door.id, 'force')} title={`Запертая дверь на ${direction}. Проверка Силы (Атлетика), СЛ ${lockDc}. Тратит действие`}><CombatIcon id={`door-force-${door.id}`} kind="action" hint="выломать запертую дверь замок" size={27} compact /><span>Выломать дверь ({direction}, СЛ {lockDc})</span></button>
                : <button {...hoverProps} key={door.id} className="door-control" disabled={!canAct || tacticalBusy} onClick={() => selected && onOperateDoor(selected, door.id, door.state === 'open' ? 'close' : 'open')} title={`${door.state === 'open' ? 'Закрыть' : 'Открыть'} дверь на ${direction}: свободное взаимодействие`}><CombatIcon id={`door-${door.id}`} kind="swap" hint="открыть закрыть дверь проём" size={27} compact /><span>{door.state === 'open' ? 'Закрыть' : 'Открыть'} дверь ({direction})</span></button>
            })}
            {selectedSceneObject && selectedSceneObjectVerbs.map((intent) => {
              const label = SCENE_OBJECT_VERB_LABELS[intent]
              const unavailable = !selectedSceneObjectAtHand
              const hoverProps = {
                onPointerEnter: () => setHoveredSceneObjectId(selectedSceneObject.id),
                onPointerLeave: () => setHoveredSceneObjectId((current) => current === selectedSceneObject.id ? null : current),
                onFocus: () => setHoveredSceneObjectId(selectedSceneObject.id),
                onBlur: () => setHoveredSceneObjectId((current) => current === selectedSceneObject.id ? null : current),
              }
              return <button
                {...hoverProps}
                type="button"
                key={`${selectedSceneObject.id}:${intent}`}
                className={`scene-object-control intent-${intent}`}
                disabled={!canAct || tacticalBusy || unavailable}
                onClick={() => selected && onOperateSceneObject(selected, selectedSceneObject.id, intent)}
                title={unavailable ? 'Подойдите к объекту на соседнюю клетку' : `${label}: ${sceneObjectLabel(selectedSceneObject)}`}
              >
                <CombatIcon id={`scene-object-${intent}`} kind={intent === 'take' ? 'item' : intent === 'inspect' ? 'spellbook' : 'action'} hint={`${label} объект сцены`} size={27} compact />
                <span>{label}</span>
              </button>
            })}
            {/* Куда ведёт выбранная лестница — строкой, а не только надписью
                кнопки: кнопка закрыта в бою и вдали, а знать назначение
                перехода игрок вправе всегда. */}
            {selectedSceneObject?.transition && <span className="scene-object-lead">
              {levelTransitionHint(selectedSceneObject.transition, knownSceneLevels)}
            </span>}
            {selectedSceneObject && selectedLevelTransition && <button
              type="button"
              className={`scene-object-control level-transition ${selectedLevelTransition.direction}`}
              disabled={!canAct || tacticalBusy || selectedLevelTransition.disabled}
              onClick={() => selected && onUseLevelTransition(selected, selectedSceneObject.id)}
              title={selectedLevelTransition.title}
            >
              <CombatIcon id={`level-transition-${selectedLevelTransition.direction}`} kind="swap" hint={`${selectedLevelTransition.direction === 'up' ? 'подняться' : 'спуститься'} лестница этаж`} size={27} compact />
              <span>{selectedLevelTransition.label}</span>
            </button>}
            {selectedSceneObject && selectedSceneObjectVerbs.length === 0 && !selectedLevelTransition && <button type="button" className="scene-object-control" disabled title="Сервер не открыл доступных действий для этого объекта"><span>Нет доступных действий</span></button>}
            {combatActive && !truce && <button
              className="parley-hotbar"
              disabled={!canAct || tacticalBusy || narrating || Boolean(state.pendingCheck)}
              onClick={() => { void onProposeParley('persuasion') }}
              title={parleyAttempted
                ? 'Повторный окрик в этом бою идёт с помехой. Тратит действие; отклик решает мораль противника'
                : 'Проверка Убеждения против серверной СЛ по морали противника. Тратит действие'}
            ><CombatIcon id="propose-parley" kind="action" hint="переговоры перемирие поговорить" size={27} compact /><span>{parleyAttempted ? 'Переговоры (помеха)' : 'Переговоры'}</span></button>}
            {combatActive && knockoutEligible && <button className={`knockout-turn-toggle ${knockOut ? 'active' : ''}`} disabled={tacticalBusy} aria-pressed={knockOut} onClick={() => setKnockOut((current) => !current)} title='При снижении до 0 ОЗ оставить цель с 1 ОЗ без сознания'><CombatIcon id='knockout-toggle' kind='action' hint='несмертельный нокаут пощадить цель' size={27} compact /><span>{knockOut ? 'Нокаут включён' : 'Нокаутировать'}</span></button>}
            {combatActive && selectedItem && needsWeaponChange && <button disabled={!canAct || tacticalBusy || !actionReady} onClick={() => selected && onChangeWeapon(selected, selectedItem.id)}><CombatIcon id={`swap-${selectedItem.id}`} kind="swap" hint={`сменить оружие ${selectedItem.name}`} size={27} compact /><span>Сменить оружие</span></button>}
            {combatActive && <button className="end-turn-hotbar" disabled={!canAct || tacticalBusy} onClick={onFinishTurn}><CombatIcon id="end-turn" kind="end-turn" hint="завершить ход" size={27} compact /><span>Завершить ход</span></button>}
          </div>}
          </div>
          <aside className="hotbar-detail" aria-live="polite">
            {!combatActive && !(combatMode === 'magic' && selectedSpell) ? <>
              <DetailHeader title="Вне боя" description="Лечение, усиление и утилита творятся прямо здесь. Всё, что бьёт, требует инициативы." />
            </> : combatMode === 'magic' && selectedSpell ? <>
              <DetailHeader title={selectedSpell.name} description={selectedSpell.description} meta={<>
                {selectedSpellRange > 0 ? <i className="detail-chip" title={`Дальность: ${selectedSpellRange} фт`}>{selectedSpellRange} фт</i> : <i className="detail-chip" title="Заклинание на себя">на себя</i>}
                {selectedSpell.concentration ? <i className="detail-chip mark" title="Требует концентрации">К</i> : null}
                {supportMark(selectedSpellSupport.status) ? <i className={`detail-chip mark support-${selectedSpellSupport.status}`} title={`${selectedSpellSupport.label}. ${selectedSpellSupport.explanation}`}>{supportMark(selectedSpellSupport.status)}</i> : null}
              </>} />
              {/* Оговорка о полноте механики убрана из колонки: игроку она
                  ничего не даёт, а место занимала больше самого описания. Ярлык
                  статуса рядом остаётся, полный текст живёт в подсказке плитки. */}
              {selectedSpell.spellOptions?.length ? <div className="spell-option-picker" aria-label="Вариант заклинания">
                {selectedSpell.spellOptions.map((option) => <button key={option} className={selectedSpellOption === option ? 'selected' : ''} onClick={() => setSelectedSpellOption(option)}>{SPELL_OPTION_LABELS[option] ?? option}</button>)}
              </div> : null}
              {/* Раньше подпись всегда звала выбрать цель, даже когда она уже
                  была выбрана: клик по врагу выглядел как несработавший. */}
            </> : combatMode === 'action' && selectedCombatAction ? <><DetailHeader title={selectedCombatAction.name} description={selectedCombatAction.description} meta={supportMark(selectedActionSupport.status) ? <i className={`detail-chip mark support-${selectedActionSupport.status}`} title={`${selectedActionSupport.label}. ${selectedActionSupport.explanation}`}>{supportMark(selectedActionSupport.status)}</i> : null} /></> : <><DetailHeader title={selectedItem?.name ?? 'Базовая атака'} description={selectedItem?.description || (selectedItem?.combat?.kind === 'thrown-area' ? 'Выберите клетку для броска.' : 'Выберите противника на карте.')} meta={<>
              <i className="detail-chip" title={`Дальность: ${attackRangeFeet} фт`}>{attackRangeFeet} фт</i>
              {areaRadiusFeet ? <i className="detail-chip" title={`Радиус поражения: ${areaRadiusFeet} фт`}>◍ {areaRadiusFeet}</i> : null}
              {inspectedForecast ? <i className="detail-chip forecast" title="Бонус атаки рассчитан сервером для выбранной цели">атака {inspectedForecast.attack_modifier >= 0 ? '+' : '−'}{Math.abs(inspectedForecast.attack_modifier)}</i> : null}
              {inspectedForecast ? <i className="detail-chip forecast" title="Урон взят из серверного профиля выбранного оружия">{selectedWeaponCombat?.damage ? `урон ${selectedWeaponCombat.damage}` : `средний урон ${inspectedForecast.average_damage}`}</i> : null}
            </>} />
            {weaponModeOptions.length > 1 && <div className="spell-option-picker weapon-attack-picker" aria-label="Режим атаки оружием">
              {weaponModeOptions.map((mode) => <button key={mode.id} type="button" className={selectedWeaponMode?.id === mode.id ? 'selected' : ''} onClick={() => { setAttackMode(mode.id); setAttackAbility(mode.ability) }}>{WEAPON_ATTACK_MODE_LABELS[mode.id]}</button>)}
            </div>}
            {weaponAbilityOptions.length > 1 && <div className="spell-option-picker weapon-attack-picker" aria-label="Характеристика атаки оружием">
              {weaponAbilityOptions.map((ability) => <button key={ability} type="button" className={selectedWeaponAbility === ability ? 'selected' : ''} onClick={() => setAttackAbility(ability)}>{WEAPON_ATTACK_ABILITY_LABELS[ability]}</button>)}
            </div>}
            {sneakAttackEligible && <label className={`weapon-rider-toggle ${sneakAttack ? 'selected' : ''} ${sneakAttackSpent ? 'spent' : ''}`} title={sneakAttackSpent ? 'Коварная атака уже нанесла урон в этом ходу' : 'Добавить урон Коварной атаки, если сервер подтвердит условия'}>
              <input type="checkbox" checked={sneakAttack} disabled={tacticalBusy || sneakAttackSpent} onChange={(event) => setSneakAttack(event.target.checked)} />
              <span>{sneakAttackSpent ? 'Коварная атака использована' : 'Коварная атака'}</span>
            </label>}
            </>}
          </aside>
        </div>
        {tacticalBusy && <p className="tactical-command-status"><RefreshCw className="spinning" size={12} />Действие идёт, мир отзывается на него…</p>}
        {tacticalError && <div className="tactical-command-error" role="alert"><span>{tacticalError}</span><button onClick={onClearTacticalError} aria-label="Закрыть ошибку"><X size={12} /></button></div>}
      </section>
      </section>
    </>
  )
}
