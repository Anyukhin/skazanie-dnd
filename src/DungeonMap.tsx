/**
 * Тактическая доска и всё, что живёт только на ней: фишки, колода действий,
 * часы хода, разбор броска, меню объектов сцены и NPC.
 *
 * Вынесено из `App.tsx` вторым шагом задачи 0 бэклога. Правок поведения нет —
 * только адрес кода. До выноса `App.tsx` был 3501 строку, из них 2116 занимала
 * доска: любая работа по интерфейсу конфликтовала с любой другой.
 */

import { Fragment, Suspense, cloneElement, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Coins,
  Crown,
  DoorOpen,
  Dices,
  Flame,
  Footprints,
  Gem,
  History,
  MessageSquare,
  ScrollText,
  Send,
  Shield,
  Sparkles,
  Swords,
  X,
  SlidersHorizontal,
  HelpCircle,
  Lock,
  LockKeyhole,
  LockOpen,
  RefreshCw,
  Store,
  PawPrint,
  Skull,
  Gavel,
  Soup,
  Unlink,
  UserLock,
  Handshake,
  ShieldAlert,
  Beer,
  Ear,
  Eye,
  Mail,
  MailOpen,
  MailX,
  HandHeart,
  Feather,
  PanelRightClose,
} from 'lucide-react'
import type {
  CombatAction,
  CombatSpell,
  CombatVisualBatch,
  Enemy,
  GameState,
  GuardResolution,
  HeroReactionMode,
  LetterAddresseeKind,
  ParleyOutcome,
  Player,
  PlayerRequestKind,
  ReactionMode,
  SceneObjectIntent,
  TacticalProp,
  TavernDiceApproach,
} from './types'
import {
  actorMovementPresentation,
  combatSpellTargetLimit,
  movementEffectTimeLabel,
  spellCastingSourcesFor,
  spellComponentAvailabilityFor,
  spellSlotAvailabilityFor,
  toggleCombatSpellTargetIds,
} from './types'
import {
  HARMFUL_SPELL_KINDS,
  HeroFaceInitials,
  battleEventText,
  combatState,
  damageTypeLabel,
  hasHeroPortrait,
  heroFaceMode,
  heroFaceStyle,
  useDialogEscape,
} from './app-shared'
import type { BoardCombatant } from './app-shared'
import { LootCellMarker, LootPanel, PostCombatLootSummary, useVanishedLoot } from './LootPanel'
import { VoiceInput } from './VoiceInput'
import type { BeastAction, CaptiveAction, CaptiveInterrogationSkill, CommandOutcome, WeaponAttackChoice } from './useGameSession'
import { CELL_FEET, currentTacticalTurn, mapGridDimensions } from './tactical-engine'
import {
  actorDistanceFeet,
  actorFootprintCells,
  actorFootprintLayout,
  actorFootprintSize,
  actorPresentationCenter,
  actorPresentationSize,
  areaCellsForActor,
  battleRollContext,
  boardPositionKey,
  buildMovementPaths,
  conditionPresentation,
  evaluateCombatTarget,
  isDifficultTerrain,
  levelIndicatorRows,
  levelTransitionHint,
  levelTransitionPresentation,
  mechanicsSupportPresentation,
  movementCellReason,
  pointInAreaEffect,
  type MovementPath,
} from './tactical-ui'
import { SUPERSEDED_FEATURE_POOLS, fallbackCombatActions } from './combat-actions'
import { allCatalogCombatSpells, fallbackCombatSpells } from './combat-spells'
import { CombatIcon } from './CombatIcon'
import { ReactionAskMark, ReactionModesPanel, reactionIconId, reactionModeTitle } from './ReactionModes'
import { TacticalBoard, type BoardAnimationActor, type BoardCellHint, type BoardCellNode } from './TacticalBoard'
import { moveRiskPoint, type BoardMovePreview } from './move-preview'
import { drawLingeringSpellEffects, type BoardAreaEffect, type BoardEffectRenderer, type BoardOverlayCell } from './board-render'
import { CIRCULAR_AREA_GEOMETRY_VERSION, gridOriginForTargetCell } from './area-geometry'
import {
  createPersistentSpellEffectsRenderer,
  persistentSpellEffectsFromProjection,
  spellEffectPalette,
  spellVisualProfile,
  systemPrefersReducedMotion,
} from './spell-effects'
import { doorsReachableFrom, sceneTacticalMap } from './tactical-map-client'
import { combatActionTargetGuard } from './tactical-command-guard.mjs'
import { sceneMapContentSignature } from './scene-map-cache'
import { circularGridPointLineOfEffect, createSpellTargetRenderer, maskSpellAreaCells, spellPreviewActors } from './spell-targeting'
import type { CombatAudio } from './combat-audio'
import { doorDirectionFromActor, doorOverlayCells, selectedAttackForecast } from './desktop-ui.mjs'
import { boardMapArtForMap, locationOverviewFor, resolveSceneTheme } from './scene-art'
import { LocationOverview } from './LocationOverview'
import {
  battleEventParticipantIds,
  latestNpcTurnEvents,
  recentDamageForTarget,
  sceneNpcsAt,
  merchantForSceneNpc,
  visibleNpcStance,
} from './player-experience'
import {
  actorTrajectoryBlockReason,
  ammunitionSupplyFor,
  BASE_ATTACK_ID,
  BattleRollTokenCallout,
  boardVisualTheme,
  castableOutOfCombat,
  CHAT_COLLAPSED_KEY,
  type CombatDeck,
  type CombatMode,
  COMPOSER_HEIGHT_KEY,
  type HotbarSection,
  CombatTurnClock,
  DetailHeader,
  EnemyGlyph,
  enemyHealthPresentation,
  enemyVisualKind,
  hasClearBoardTrajectory,
  heroResourceLabel,
  heroResourceRank,
  heroResourcesFor,
  heroResourceShortLabel,
  heroResourceTitle,
  HOTBAR_COST_FILTER_LABELS,
  type HotbarCostFilter,
  inferredCombatItem,
  isSpellSlotPool,
  LegendaryPips,
  MAP_LEGEND_KEY,
  NPC_CONVERSATION_STANCE_LABELS,
  NPC_RELATIONSHIP_LABELS,
  NPC_STANCE_LABELS,
  NpcPortrait,
  NpcTokenPortrait,
  PARLEY_TERM_LABELS,
  PartyQuestHud,
  type PendingCombatCommand,
  RAIL_HEIGHT_KEY,
  SCENE_OBJECT_VERB_LABELS,
  sceneObjectCells,
  sceneObjectLabel,
  sceneObjectVerbs,
  SERVER_WIDTH_KEY,
  SituationalSlot,
  SPELL_OPTION_LABELS,
  spellActionType,
  SpellComponentsLine,
  spellKind,
  spellRange,
  supportMark,
  targetPopoverStyle,
  TILE_LOCK_KEY,
  TILE_ORDER_KEY,
  type TileCost,
  tokenAnchor,
  type TokenAnchor,
  TokenConditionIcons,
  TokenHealthBar,
  unavailableUiReason,
  useTransientBattleRoll,
  useTransientMapFeedback,
  useTransientNpcTactic,
  WEAPON_ATTACK_ABILITY_LABELS,
  WEAPON_ATTACK_MODE_LABELS,
} from './dungeon-map-parts'

export * from './dungeon-map-parts'
import { heroStatusFor as heroStatusForActor } from './dungeon-map-parts'
import { DeathSavesPanel, SPELL_LEVEL_ROMANS, SpellSlotBar, spellSlotPools, TileTooltip, UpcastPopover, useFitColumns, useTileTooltip, viewerStorage } from './hud-parts'

const Spellbook = lazy(() => import('./Spellbook').then(({ Spellbook: Component }) => ({ default: Component })))

/** Подсказки вкладок колоды: что в ней лежит. */
const DECK_HINTS: Record<CombatDeck, string> = {
  all: 'всё, чем владеет герой, секциями по цене хода',
  common: 'перемещение и общие действия боя',
  weapon: 'атаки оружием из снаряжения героя',
  magic: 'книга и заклинания, вынесенные на панель',
  class: 'умения класса и их запасы',
  items: 'расходуемые предметы из сумки',
}

/** Подписи секций общего вида панели (для чтения с экрана). */
const HOTBAR_SECTION_LABELS: Record<HotbarSection | 'deck', string> = {
  action: 'Действия',
  spell: 'Заклинания',
  bonus: 'Бонусные и свободные действия',
  items: 'Предметы',
  deck: 'Плитки колоды',
}

/** Виды реплики игрока: подпись на переключателе и подсказка. */
const REQUEST_KIND_OPTIONS: ReadonlyArray<readonly [PlayerRequestKind, string, string]> = [
  ['action', 'Действие', 'Герой действует: ведущий разрешает намерение'],
  ['question', 'Вопрос', 'Вопрос ведущему о ситуации — герой не действует'],
  ['discussion', 'Отряду', 'Обсуждение с отрядом — план без действия героя'],
]

/* Классовые запасы ряда — без ячеек заклинаний, они живут в `SpellSlotBar`.
   Один запас приезжает под двумя ключами: рукописным (`second_wind`) и
   каталожным (`feature_fighter-vtoroe-dyhanie`) — сервер кладёт оба
   (`server/combat-actions.mjs:288` и `:295`), и после резолва подписи
   близнецы неотличимы: у воина в ряду стояли два чипа «второе дыхан… ●».
   Схлопываем их в один — но только когда сходятся и подпись, и заряд, и
   запас. Разошедшиеся счётчики схлопывать нельзя: это уже серверный баг, и
   спрятанный он покажет игроку один заряд там, где учтено два. Оба сырых
   ключа уходят в подсказку чипа. Перебор здесь линейный по ряду: запасов у
   героя единицы, а порядок сортировки схлопывание не ломает. */
function heroClassPoolRowsFrom(resources: Record<string, { current?: number; max?: number } | undefined>) {
  return Object.entries(resources)
    .map(([key, pool]) => ({ key, current: Math.max(0, Number(pool?.current ?? 0)), max: Math.max(0, Number(pool?.max ?? 0)) }))
    .filter((entry) => entry.max > 0 && !SUPERSEDED_FEATURE_POOLS.has(entry.key))
    .sort((left, right) => heroResourceRank(left.key) - heroResourceRank(right.key) || left.key.localeCompare(right.key, 'ru'))
    .reduce<Array<{ keys: string[]; current: number; max: number }>>((rows, entry) => {
      const twin = rows.find((row) => row.current === entry.current && row.max === entry.max
        && heroResourceLabel(row.keys[0]) === heroResourceLabel(entry.key))
      if (twin) twin.keys.push(entry.key)
      else rows.push({ keys: [entry.key], current: entry.current, max: entry.max })
      return rows
    }, [])
    .filter((row) => !isSpellSlotPool(row.keys[0]) && row.keys[0] !== 'pact_slots')
}

export function DungeonMap({ state, players, turnActorId, typingActorId, canAct, canConverse, dialogueBusy, dialogueDraft, tacticalBusy, tacticalError, autoAttackRoll, scenicBackdrop, boardLighting, combatAnimations, combatAudio, visualBatch, onStartCombat, onNpcAttack, onMove, onAttack, onAreaAttack, onCastSpell, onUseCombatAction, onSetSpellBonusPreference, onSetReactionMode, onChangeWeapon, onOperateDoor, onOperateSceneObject, onUseLevelTransition, onLeaveLocation, leaveLocationDisabled, onOpenMerchant, onFinishTurn, onFreeAction, onNpcAction, onCaptiveAction, onLootContainer, onBeastAction, onResolveGuardEncounter, onProposeParley, onSettleParley, onOpenTavernDiceRound, onAnswerTavernDiceRound, onLeaveTavernDiceRound, onOrderTavernDrink, onSendLetter, onReceiveNpcBlessing, onTransferItem, onStartRest, onSpendHitPointDie, onCompleteRest, onTypingChange, narrating, playerHud, foreignTurn, statusContent, children }: {
  state: GameState
  players: Player[]
  turnActorId: string
  typingActorId: string
  canAct: boolean
  tacticalBusy: boolean
  tacticalError: string | null
  autoAttackRoll: boolean
  scenicBackdrop: boolean
  /** Запечённый свет и тени доски. Настройка зрителя — механики не касается. */
  boardLighting: boolean
  combatAnimations: boolean
  combatAudio?: CombatAudio
  visualBatch: CombatVisualBatch | null
  onStartCombat: () => Promise<CommandOutcome>
  onNpcAttack: (npcId: string) => Promise<CommandOutcome>
  onMove: (actorId: string, x: number, y: number) => Promise<CommandOutcome>
  onAttack: (actorId: string, enemyId: string, itemId?: string, choice?: WeaponAttackChoice) => Promise<CommandOutcome>
  onAreaAttack: (actorId: string, itemId: string, x: number, y: number, note?: string) => Promise<CommandOutcome>
  onCastSpell: (actorId: string, spellId: string, target: (({ targetId: string } | { targetIds: string[] } | { x: number; y: number } | { x: number; y: number; targetIds: string[] }) & { itemId?: string; spellOption?: string; slotLevel?: number; castingResource?: string; knockOut?: boolean; note?: string })) => Promise<CommandOutcome>
  onUseCombatAction: (actorId: string, actionId: string, targetId?: string, itemId?: string, beneficiaryId?: string, note?: string) => Promise<CommandOutcome>
  onSetSpellBonusPreference?: (actorId: string, enabled: boolean) => Promise<CommandOutcome>
  onSetReactionMode?: (actorId: string, reactionId: string, mode: ReactionMode, reactionName?: string) => Promise<CommandOutcome>
  onChangeWeapon: (actorId: string, itemId: string) => Promise<CommandOutcome>
  onOperateDoor: (actorId: string, doorId: string, intent: 'open' | 'close' | 'force' | 'lockpick') => Promise<CommandOutcome>
  onOperateSceneObject: (actorId: string, propId: string, intent: SceneObjectIntent) => Promise<CommandOutcome>
  onUseLevelTransition: (actorId: string, propId: string) => Promise<CommandOutcome>
  onLeaveLocation: () => void
  leaveLocationDisabled?: boolean
  onOpenMerchant: (merchantId: string) => void
  onFinishTurn: () => Promise<CommandOutcome>
  canConverse: boolean
  dialogueBusy: boolean
  dialogueDraft?: { id: number; text: string; kind: PlayerRequestKind } | null
  onFreeAction: (text: string, kind?: PlayerRequestKind) => Promise<CommandOutcome>
  onNpcAction: (text: string, npcId: string) => Promise<CommandOutcome>
  onCaptiveAction: (captiveId: string, action: CaptiveAction, skill?: CaptiveInterrogationSkill) => Promise<CommandOutcome>
  onLootContainer: (containerId: string, lines: Array<{ item_instance_id: string; quantity: number }>, recipientId?: string) => Promise<CommandOutcome>
  onBeastAction: (beastId: string, action: BeastAction) => Promise<CommandOutcome>
  onResolveGuardEncounter: (resolution: GuardResolution, skill?: 'stealth' | 'athletics') => Promise<CommandOutcome>
  onProposeParley: (skill: 'persuasion' | 'intimidation') => Promise<CommandOutcome>
  onSettleParley: (outcome: ParleyOutcome) => Promise<CommandOutcome>
  onOpenTavernDiceRound: (npcId: string, stakeCp: number) => Promise<CommandOutcome>
  onAnswerTavernDiceRound: (approach: TavernDiceApproach) => Promise<CommandOutcome>
  onLeaveTavernDiceRound: () => Promise<CommandOutcome>
  onOrderTavernDrink: () => Promise<CommandOutcome>
  onSendLetter: (addresseeKind: LetterAddresseeKind, addresseeId: string, body: string) => Promise<CommandOutcome>
  onReceiveNpcBlessing: (npcId: string) => Promise<CommandOutcome>
  onTransferItem: (itemId: string, npcId: string, quantity: number) => Promise<CommandOutcome>
  onStartRest: (kind: 'short' | 'long') => Promise<CommandOutcome>
  onSpendHitPointDie: () => Promise<CommandOutcome>
  onCompleteRest: () => Promise<CommandOutcome>
  onTypingChange: (actorId: string, typing: boolean) => void
  narrating: boolean
  playerHud?: ReactNode
  /** Ходит не герой зрителя: вместо чужих неактивных плиток — кто ходит и чей лист внизу. */
  foreignTurn?: { turnName: string; heroName: string } | null
  statusContent: React.ReactNode
  children?: React.ReactNode
}) {
  const [freeText, setFreeText] = useState('')
  const [requestKind, setRequestKind] = useState<PlayerRequestKind>('action')
  const conversationOnly = requestKind !== 'action'
  const composerBlocked = narrating || dialogueBusy || (conversationOnly ? !canConverse : Boolean(state.pendingCheck || state.pendingAction) || !canAct)
  const freeInputRef = useRef<HTMLTextAreaElement | null>(null)
  const typingTimeoutRef = useRef<number | null>(null)
  const typingActiveRef = useRef(false)
  const [openTokenLabelId, setOpenTokenLabelId] = useState<string | null>(null)
  const [linkedParticipantIds, setLinkedParticipantIds] = useState<string[]>([])
  const [npcDossier, setNpcDossier] = useState<{ npcId: string; mode: 'talk' | 'inspect' | 'transfer' } | null>(null)
  useDialogEscape(() => setNpcDossier(null), Boolean(npcDossier))
  // Как отряд собирается уходить от стражи. Выбор влияет только на навык
  // проверки: СЛ и состав проверяющих остаются серверными.
  const [guardEscapeSkill, setGuardEscapeSkill] = useState<'stealth' | 'athletics'>('stealth')
  // Какая добыча сейчас в фокусе. Связывает метку на доске, карточку панели и
  // строку послебоевой сводки: они показывают один и тот же контейнер, и
  // наведение на любую из трёх подсвечивает остальные.
  const [focusedLootId, setFocusedLootId] = useState<string | null>(null)
  // Какая победа уже отсмотрена. Ключ — идентификатор записи «бой завершён»,
  // поэтому следующая победа откроет сводку снова, а перерисовка — нет.
  const [dismissedVictoryId, setDismissedVictoryId] = useState<string | null>(null)
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
  useEffect(() => {
    setFreeText('')
    setRequestKind('action')
  }, [state.sessionCode, typingActorId])
  useEffect(() => {
    if (!dialogueDraft) return
    setFreeText(dialogueDraft.text)
    setRequestKind(dialogueDraft.kind)
    freeInputRef.current?.focus()
  }, [dialogueDraft])
  /* Высота панели и ширина хроники переживают перезагрузку. Описание действия
     больше не отделено ручкой: она дробила нижнюю полосу и заставляла текст
     переноситься, хотя рядом оставалось свободное место. */
  const [railHeight, setRailHeight] = useState(() => Number(window.localStorage.getItem(RAIL_HEIGHT_KEY)) || 0)
  const [serverWidth, setServerWidth] = useState(() => Number(window.localStorage.getItem(SERVER_WIDTH_KEY)) || 0)
  const [chatCollapsed, setChatCollapsed] = useState(() => viewerStorage.get(CHAT_COLLAPSED_KEY) === 'collapsed')
  const toggleChat = useCallback((collapsed: boolean) => {
    setChatCollapsed(collapsed)
    if (collapsed) viewerStorage.set(CHAT_COLLAPSED_KEY, 'collapsed')
    else viewerStorage.remove(CHAT_COLLAPSED_KEY)
  }, [])
  /* Высота поля ввода: 0 — обычная, иначе пиксели. Тянется ручкой над полем
     вверх (выше) и вниз (ниже); стрелки с клавиатуры — по 24 px. */
  const [composerHeight, setComposerHeight] = useState(() => Number(viewerStorage.get(COMPOSER_HEIGHT_KEY)) || 0)
  const composerLimit = (value: number) => Math.round(Math.min(window.innerHeight * .5, Math.max(44, value)))
  const startComposerResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = freeInputRef.current?.getBoundingClientRect().height ?? 52
    let latest = startHeight
    const move = (moveEvent: PointerEvent) => {
      latest = composerLimit(startHeight + (startY - moveEvent.clientY))
      setComposerHeight(latest)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      viewerStorage.set(COMPOSER_HEIGHT_KEY, String(latest))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const resizeComposerWithKeys = (event: React.KeyboardEvent<HTMLElement>) => {
    const current = freeInputRef.current?.getBoundingClientRect().height ?? 52
    let next: number | null = null
    if (event.key === 'ArrowUp') next = composerLimit(current + 24)
    else if (event.key === 'ArrowDown') next = composerLimit(current - 24)
    else if (event.key === 'Enter' || event.key === 'Home') { event.preventDefault(); setComposerHeight(0); viewerStorage.remove(COMPOSER_HEIGHT_KEY); return }
    if (next == null) return
    event.preventDefault()
    setComposerHeight(next)
    viewerStorage.set(COMPOSER_HEIGHT_KEY, String(next))
  }
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
  useDialogEscape(() => setSelectedSceneObjectId(null), Boolean(selectedSceneObjectId))
  useEffect(() => {
    const root = document.documentElement.style
    if (railHeight) root.setProperty('--ui-rail-height', `${railHeight}px`)
    else root.removeProperty('--ui-rail-height')
    if (serverWidth) root.setProperty('--ui-server-column', `${serverWidth}px`)
    else root.removeProperty('--ui-server-column')
    root.setProperty('--ui-tile-rows', '2')
  }, [railHeight, serverWidth])
  const startRailResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = document.querySelector('.turn-rail')?.getBoundingClientRect().height ?? 292
    const move = (moveEvent: PointerEvent) => {
      const next = Math.round(Math.min(window.innerHeight * .45, Math.max(120, startHeight + (startY - moveEvent.clientY))))
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
      const next = Math.round(Math.min(window.innerWidth * .4, Math.max(300, startWidth + (startX - moveEvent.clientX))))
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
  /* Ручка хроники с клавиатуры, как в макете: стрелки двигают край на 16 px
     (с Shift — на 48), Home и End — к пределам, Enter возвращает обычную. */
  const resizeServerWithKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = document.querySelector('.server-column')?.getBoundingClientRect().width ?? 320
    const step = event.shiftKey ? 48 : 16
    const limit = (value: number) => Math.round(Math.min(window.innerWidth * .4, Math.max(300, value)))
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = limit(current + step)
    else if (event.key === 'ArrowRight') next = limit(current - step)
    else if (event.key === 'Home') next = 300
    else if (event.key === 'End') next = limit(window.innerWidth * .4)
    else if (event.key === 'Enter') { event.preventDefault(); setServerWidth(0); viewerStorage.remove(SERVER_WIDTH_KEY); return }
    if (next == null) return
    event.preventDefault()
    setServerWidth(next)
    viewerStorage.set(SERVER_WIDTH_KEY, String(next))
  }
  useEffect(() => {
    const reset = () => setServerWidth(0)
    window.addEventListener('skazanie:columns-reset', reset)
    return () => window.removeEventListener('skazanie:columns-reset', reset)
  }, [])

  const [focusedParticipantId, setFocusedParticipantId] = useState<string | null>(null)
  const [combatMode, setCombatMode] = useState<CombatMode>('weapon')
  const [activeDeck, setActiveDeck] = useState<CombatDeck>('all')
  const [selectedItemId, setSelectedItemId] = useState(BASE_ATTACK_ID)
  const [selectedSpellId, setSelectedSpellId] = useState('')
  const [selectedSpellItemId, setSelectedSpellItemId] = useState('')
  const [selectedSpellOption, setSelectedSpellOption] = useState('')
  const [spellSlotLevelChoice, setSpellSlotLevelChoice] = useState<number | null>(null)
  const [spellCastingSourceChoice, setSpellCastingSourceChoice] = useState<string | null>(null)
  const [spellTargetIds, setSpellTargetIds] = useState<string[]>([])
  const spellCommandInFlight = useRef(false)
  const [selectedCombatActionId, setSelectedCombatActionId] = useState('')
  const [attackMode, setAttackMode] = useState<WeaponAttackChoice['attackMode']>()
  const [attackAbility, setAttackAbility] = useState<WeaponAttackChoice['attackAbility']>()
  const [sneakAttack, setSneakAttack] = useState(false)
  const [knockOut, setKnockOut] = useState(false)
  /* Фильтр колоды по стоимости — чисто экранная выборка по клику на пипсе
     ресурса. Никуда не сохраняется и ничего не запрещает: закрытая плитка
     остаётся закрытой, а видимая — видимой, просто рядом с ней стоят только
     плитки той же цены. */
  const [costFilter, setCostFilter] = useState<HotbarCostFilter | null>(null)
  /* Выборка колоды заклинаний по кругу ячейки — щелчок по кругу в полосе
     ячеек. Как и фильтр стоимости, ничего не запрещает и не сохраняется. */
  const [slotLevelFilter, setSlotLevelFilter] = useState<number | null>(null)
  /* Выбор круга ячейки всплывает над плиткой заклинания, если его можно
     сотворить ячейками нескольких кругов. */
  const [upcastPrompt, setUpcastPrompt] = useState<{ spellId: string; anchor: DOMRect } | null>(null)
  // Панель режимов реакций: где открыть и чью строку выделить.
  const [reactionMenu, setReactionMenu] = useState<{ anchorElement: HTMLElement; focusId: string | null } | null>(null)
  const closeUpcastPrompt = useCallback(() => setUpcastPrompt(null), [])
  const hotbarActionsRef = useRef<HTMLDivElement | null>(null)
  const tileTip = useTileTooltip(hotbarActionsRef)
  const fitTileColumns = useFitColumns(hotbarActionsRef)
  const [spellbookOpen, setSpellbookOpen] = useState(false)
  // Escape закрывает книгу заклинаний и разговор с NPC и возвращает фокус тому,
  // кто их открыл. Оба окна живут прямо в разметке доски, поэтому признак «окно
  // на экране» передаётся хуку, а не изображается условным вызовом.
  useDialogEscape(() => setSpellbookOpen(false), spellbookOpen)
  const [hotbarSpellIds, setHotbarSpellIds] = useState<string[]>([])
  const [aimCell, setAimCell] = useState<{ x: number; y: number } | null>(null)
  // Областные заклинания сначала фиксируют центр, а затем ждут явный список
  // существ в сфере. Точка живёт отдельно от наведённой клетки, чтобы
  // наведение на фишку не сдвигало уже выбранный центр. Для self-area центр
  // берётся из текущей клетки заклинателя сразу после выбора плитки.
  const [areaSpellPoint, setAreaSpellPoint] = useState<{ x: number; y: number } | null>(null)
  const [pendingCommand, setPendingCommand] = useState<PendingCombatCommand | null>(null)
  const [hoveredMoveKey, setHoveredMoveKey] = useState<string | null>(null)
  const [pendingMoveKey, setPendingMoveKey] = useState<string | null>(null)
  const [inspectedTarget, setInspectedTarget] = useState<{ id: string; name: string; team: 'ally' | 'enemy'; hp?: number; maxHp?: number; healthLabel?: string; distanceFeet: number; allowed: boolean; reason: string | null } | null>(null)
  /* Якорь инспектора — рамка фишки, на которую навели: поповер стоит у неё,
     а не в правой колонке. Снимается вместе с самим `inspectedTarget`. */
  const [inspectedAnchor, setInspectedAnchor] = useState<TokenAnchor | null>(null)
  /* Какая ситуативная панель раскрыта поверх ленты; чипы — в одной строке. */
  const [openSituational, setOpenSituational] = useState<string | null>(null)
  const [npcGroupOpen, setNpcGroupOpen] = useState(false)
  const { columns: cellColumns, rows: cellRows } = mapGridDimensions(state.scene.cells)
  // Канон сцены — `scene.map`; старая проекция без него собирается из клеток.
  const boardMapContent = sceneMapContentSignature(state.scene)
  const boardMap = useMemo(() => sceneTacticalMap(state.scene), [
    boardMapContent, state.scene.location_id, state.scene.location, state.scene.title,
  ])
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
      ?? sceneNpcs.find((npc) => npc.id === id)?.name
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
  /* Герой на нуле хитов ещё не мёртв: он лежит без сознания и бросает
     спасброски. С доски он пропадал вместе с убитыми врагами, и поднять его
     было нечем — ни «Лечащим словом», ни стабилизацией, хотя сервер это
     разрешает (плейтест 2026-10-03). Мёртвым считается только запись смерти. */
  const heroIsDead = (heroId: string) => state.mechanics?.death?.heroes?.[heroId]?.status === 'dead'
    || (state.mechanics?.conditions?.[heroId] ?? []).some((condition) => condition.id === 'dead')
  const animationActors: BoardAnimationActor[] = [
    ...players.map((player) => ({ id: player.id, x: player.x, y: player.y, label: player.character, color: player.color, kind: 'hero' as const, archetype: player.characterClass ?? player.role, footprint: player.footprint, defeated: player.hp <= 0 })),
    ...(state.enemies ?? []).map((enemy) => ({ id: enemy.id, x: enemy.x, y: enemy.y, label: enemy.name, color: '#c86c5d', kind: 'enemy' as const, archetype: enemy.creature_type, footprint: enemy.footprint, defeated: enemy.alive === false })),
    ...(state.actors ?? []).map((actor) => ({ id: actor.id, x: actor.x, y: actor.y, label: actor.name, color: '#70a78b', kind: 'summon' as const, footprint: actor.footprint, defeated: actor.alive === false })),
    ...sceneNpcs.filter((npc) => npc.alive).map((npc) => ({ id: npc.id, x: npc.x, y: npc.y, label: npc.name, color: '#9d8f72', kind: 'neutral' as const, footprint: npc.footprint })),
  ].map((actor) => ({ ...actor, appearance: state.actor_appearances?.[actor.id] }))
  const npcSummaryEvents = latestNpcTurnEvents(state.battleLog ?? [])
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
  // Добыча в сцене. Список приходит серверной веткой проекции: содержимое лежит
  // только у того контейнера, до которого дотягивается герой игрока
  // (`can_inspect`), расстояние и цена обыска в экономике хода тоже решены
  // сервером — здесь они не пересчитываются.
  const sceneLoot = useMemo(() => state.loot_containers?.containers ?? [], [state.loot_containers])
  const lootReachFeet = state.loot_containers?.reach_feet ?? 5
  const lootActionCost = state.loot_containers?.action_cost ?? null
  // «Есть чем платить» решает сервер той же `action_economy`, по которой движок
  // отказывает `ACTION_SPENT`: без этого признака кнопка звала обыскивать в
  // ходу, где действие уже потрачено.
  const lootActionSpent = state.loot_containers?.action_spent === true
  const lootByCell = useMemo(
    () => new Map(sceneLoot.filter((container) => container.x != null && container.y != null)
      .map((container) => [`${container.x},${container.y}`, container])),
    [sceneLoot],
  )
  // Опустевшие контейнеры в проекцию не приезжают вовсе, поэтому «пропал из
  // списка» — это ответ авторитета. Призрак живёт несколько секунд, чтобы метка
  // на доске погасла, а проигравший гонку прочитал, кто успел раньше.
  const vanishedLoot = useVanishedLoot(sceneLoot, state.battleLog, actorNameById)
  const vanishedLootByCell = useMemo(
    () => new Map(vanishedLoot.filter((ghost) => ghost.x != null && ghost.y != null)
      .map((ghost) => [`${ghost.x},${ghost.y}`, ghost])),
    [vanishedLoot],
  )
  /* Победа закрывает бой записью летописи, и именно она открывает сводку: пока
     последняя запись «бой завершён» не сменилась, повторных окон не будет. */
  const victoryEntry = useMemo(() => {
    if (combatActive) return null
    const closing = [...(state.battleLog ?? [])].reverse().find((event) => event.type === 'combat-end')
    return closing?.reason === 'enemies_defeated' ? closing : null
  }, [combatActive, state.battleLog])
  const lootChipVisible = sceneLoot.length > 0 || vanishedLoot.some((ghost) => !sceneLoot.some((container) => container.id === ghost.id))
  const showLootAftermath = Boolean(victoryEntry && victoryEntry.id !== dismissedVictoryId && sceneLoot.length > 0)
  // Звери приезжают отдельной серверной веткой проекции: и кандидаты с
  // объявленной СЛ, и уже прирученные спутники. Своей формулы сложности здесь
  // нет и быть не должно — карточку собрал сервер (`server/beast-taming.mjs`).
  const beastCandidates = useMemo(
    () => (state.beasts?.candidates ?? []).filter((candidate) => !candidate.blocked_reason),
    [state.beasts],
  )
  const beastCompanions = useMemo(() => state.beasts?.companions ?? [], [state.beasts])
  // Своих запретов доска здесь не выдумывает: кого нельзя трогать, сервер уже
  // назвал полем `blocked_reason` — и у кандидата, и у спутника. «Идёт бой» сам
  // по себе запретом не является: к зверю со сломленной моралью подходят прямо
  // посреди схватки, платя действием, и слепой гейт по бою гасил кнопки там,
  // где команда проходит. Остаются поводы самой доски: идёт рассказ, команда в
  // полёте, герой не может действовать.
  //
  // И один повод — про чужой ход. Доступность считается по действующему герою
  // (`turnActorId`, в бою это герой инициативы), а команда зверя уходит от того,
  // которым игрок сейчас играет (`typingActorId`). У аккаунта с двумя героями и
  // у ведущего это разные герои: на ходу героя Б при выбранном в сайдбаре
  // герое А кнопки горели, а сервер отбивал команду `OUT_OF_TURN`. Раньше весь
  // класс был скрыт боевым гейтом; сняв гейт, надо назвать настоящую причину.
  const beastOffTurn = Boolean(combatActive && turnActorId !== typingActorId)
  const beastActionsBlocked = Boolean(narrating || tacticalBusy || !canAct || beastOffTurn)
  // Молчаливо неактивных кнопок в проекте нет (принцип 3): раз погасили — надо
  // сказать, почему. Своей формулировки о запретах сервера здесь по-прежнему
  // нет — эта строка только про чужой ход, который доска знает сама.
  const beastOffTurnTitle = 'Сейчас ход другого героя: зверя уговаривает тот, чей ход'
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
  /* Срочные панели раскрываются сами: стража ждёт ответа, перемирие держит
     очередь, кость уже на столе. Остальные (почта, добыча, отдых) ждут чипом —
     они не срочнее рассказа. Закрыть срочную можно, но при новой страже или
     новом раунде она откроется снова — ключ эффекта и есть это событие. */
  const urgentSituational = guardEncounter ? 'guard' : truce ? 'truce' : tavernRound ? 'tavern' : null
  const urgentSituationalKey = `${urgentSituational ?? ''}:${guardEncounter ? 'guard' : ''}:${truce?.round ?? ''}:${tavernRound?.id ?? ''}`
  useEffect(() => {
    if (urgentSituational) setOpenSituational(urgentSituational)
  }, [urgentSituationalKey])
  useEffect(() => {
    if (!openSituational) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenSituational(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSituational])
  const toggleSituational = (id: string) => setOpenSituational((current) => current === id ? null : id)
  const closeSituational = () => setOpenSituational(null)
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
  const dossierPublicTags = dossierSocialNpc?.tags?.filter((tag) => !/^faction:/iu.test(String(tag))) ?? []
  const dossierMerchant = dossierSceneNpc
    ? merchantForSceneNpc(state, dossierSceneNpc.id)
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
  const dossierWaiting = Boolean(dialogueBusy || narrating)
  const dossierCanTalk = Boolean(
    dossierSceneNpc?.alive
    && dossierSocialNpc?.available !== false
    && !combatActive
    && canAct
    && !dossierWaiting,
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
  const shillelaghHeldItems = combatItems.filter((item) => item.type === 'weapon' && item.equipped
    && ['club', 'quarterstaff'].includes(String(item.catalog_id ?? item.id).split(':').at(-1) ?? ''))
  const shillelaghHeldItemKey = shillelaghHeldItems.map((item) => item.id).join('|')
  const shillelaghItemId = shillelaghHeldItems.some((item) => item.id === selectedSpellItemId)
    ? selectedSpellItemId
    : shillelaghHeldItems[0]?.id
  const selectedItem = selectedItemId === BASE_ATTACK_ID ? undefined : combatItems.find((item) => item.id === selectedItemId)
  const selectedWeaponCatalogCombat = selectedItem?.type === 'weapon'
    ? selectedItem.combat as Player['inventory'][number]['combat']
    : undefined
  const activeShillelagh = selectedItem?.type === 'weapon'
    ? (state.mechanics?.conditions?.[turnActorId] ?? []).find((condition) => condition.id === 'shillelagh'
      && String(condition.source_item_id ?? '') === String((selectedItem as (typeof selectedItem & { item_instance_id?: string; itemInstanceId?: string }))?.item_instance_id
        ?? (selectedItem as (typeof selectedItem & { item_instance_id?: string; itemInstanceId?: string }))?.itemInstanceId
        ?? selectedItem.id))
    : undefined
  const activeShillelaghAbility = ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(String(activeShillelagh?.spellcasting_ability ?? ''))
    ? String(activeShillelagh?.spellcasting_ability) as NonNullable<WeaponAttackChoice['attackAbility']>
    : null
  const weaponModeOptions = selectedWeaponCatalogCombat?.modes ?? []
  const weaponModeKey = weaponModeOptions.map((mode) => `${mode.id}:${mode.ability}`).join('|')
  const selectedWeaponMode = weaponModeOptions.find((mode) => mode.id === attackMode) ?? weaponModeOptions[0]
  const weaponAbilityOptions: NonNullable<WeaponAttackChoice['attackAbility']>[] = selectedItem?.type === 'weapon'
    ? [...new Set<NonNullable<WeaponAttackChoice['attackAbility']>>([
      ...(selectedWeaponCatalogCombat?.abilities ?? (selectedWeaponMode?.ability ? [selectedWeaponMode.ability] : [])) as NonNullable<WeaponAttackChoice['attackAbility']>[],
      ...(activeShillelaghAbility ? ['str'] as NonNullable<WeaponAttackChoice['attackAbility']>[] : []),
    ])]
    : []
  const selectedWeaponAbility = activeShillelaghAbility && attackAbility == null
    ? undefined
    : weaponAbilityOptions.includes(attackAbility as NonNullable<WeaponAttackChoice['attackAbility']>)
      ? attackAbility
      : selectedWeaponMode?.ability
  const selectedWeaponCombat = selectedWeaponMode ?? selectedItem?.combat
  const weaponSelectionId = selectedItem?.id ?? BASE_ATTACK_ID
  const projectedSpells = activeHero?.combatSpells ?? []
  const fallbackSpells = fallbackCombatSpells(activeHero, state.ruleset_id)
  const spellbookSpells = useMemo(() => allCatalogCombatSpells(projectedSpells, state.ruleset_id), [projectedSpells, state.ruleset_id])
  const fallbackSpellById = new Map(fallbackSpells.map((spell) => [spell.id, spell]))
  const spells = [...new Map([...fallbackSpells, ...projectedSpells].map((spell) => [spell.id, spell])).entries()]
    .map(([id, spell]) => {
      const fallback = fallbackSpellById.get(id)
      /* Старые projections могут принести авторитетную availability без
         повторения каталожного описания компонентов. Сохраняем метаданные из
         fallback, но не переносим из него решение о доступности. */
      return fallback?.components && !spell.components ? { ...spell, components: fallback.components } : spell
    })
  const hotbarSpells = spells.filter((spell) => hotbarSpellIds.includes(spell.id) && spellActionType(spell) !== 'reaction')
  const selectedSpell = spells.find((spell) => spell.id === selectedSpellId) ?? spells[0]
  const selectedSpellItemOption = selectedSpell?.id === 'shillelagh' && shillelaghItemId ? { itemId: shillelaghItemId } : {}
  const selectedSpellItemReady = selectedSpell?.id !== 'shillelagh' || Boolean(shillelaghItemId)
  const combatActions = activeHero ? (activeHero.combatActions?.length ? activeHero.combatActions : fallbackCombatActions(activeHero)) : []
  const selectedCombatAction = combatActions.find((action) => action.id === selectedCombatActionId) ?? null
  const selectedSpellKind = spellKind(selectedSpell)
  const selectedSpellRange = spellRange(selectedSpell)
  const activeConditionIds = new Set((state.mechanics?.conditions?.[turnActorId] ?? []).map((condition) => String(condition.id)))
  const selectedSpellAction = activeConditionIds.has('metamagic-quickened') && spellActionType(selectedSpell) === 'action' ? 'bonus_action' : spellActionType(selectedSpell)
  const activeResources = heroResourcesFor(state, turnActorId, activeHero)
  const explicitSpellSource = selectedSpell?.id === 'longstrider'
  const spellCastingSources = explicitSpellSource ? spellCastingSourcesFor(selectedSpell, activeResources) : []
  const selectedCastingSource = spellCastingSources.find((source) => source.resource === spellCastingSourceChoice)
    ?? spellCastingSources.find((source) => source.availability.ready) ?? spellCastingSources[0]
  const selectedSpellSlotAvailability = selectedCastingSource?.availability ?? (selectedSpell
    ? spellSlotAvailabilityFor(selectedSpell, activeResources)
    : { resource: null, levels: [], fixedLevel: null, ready: true, usingFallback: false })
  const availableSpellSlotLevels = selectedSpellSlotAvailability.levels
  const selectedSpellSlotLevel = spellSlotLevelChoice != null && (explicitSpellSource || availableSpellSlotLevels.includes(spellSlotLevelChoice))
    ? spellSlotLevelChoice
    : availableSpellSlotLevels[0] ?? null
  const selectedSpellPool = selectedSpellSlotLevel
    ? activeResources[`spell_slots_${selectedSpellSlotLevel}`]
    : selectedSpellSlotAvailability.resource ? activeResources[selectedSpellSlotAvailability.resource] : undefined
  const spellSlotReady = selectedSpellSlotAvailability.ready && (!explicitSpellSource || selectedSpellSlotLevel == null || availableSpellSlotLevels.includes(selectedSpellSlotLevel))
  const selectedSpellCastLevel = selectedSpell && selectedSpell.level > 0
    ? selectedSpellSlotAvailability.fixedLevel ?? selectedSpellSlotLevel ?? (Number.isSafeInteger(Number(selectedSpell.slotLevel)) && Number(selectedSpell.slotLevel) >= selectedSpell.level ? Number(selectedSpell.slotLevel) : selectedSpell.level)
    : selectedSpell?.level ?? 0
  const selectTargetsInAreaSpell = Boolean(combatMode === 'magic' && selectedSpell?.selectTargetsInArea === true)
  const selfAreaSpell = Boolean(selectTargetsInAreaSpell && selectedSpell?.target === 'self')
  const selectedSpellMaxTargets = combatSpellTargetLimit(selectedSpell, selectedSpellCastLevel, activeHero?.level)
  const areaTargetPoint = areaSpellPoint ?? (selfAreaSpell && active ? { x: active.x, y: active.y } : null)
  const areaTargetSelectionActive = Boolean(selectTargetsInAreaSpell && areaTargetPoint)
  const multiTargetSpell = Boolean(combatMode === 'magic' && selectedSpell && (
    areaTargetSelectionActive
    || (selectedSpellMaxTargets > 1 && ['enemy', 'ally', 'creature'].includes(selectedSpell.target))
  ))
  const genericProfile = active as (BoardCombatant & { attackRange?: number; rangeFeet?: number; attack_profile?: { kind?: 'melee' | 'ranged'; range_feet?: number; normal_range_feet?: number } }) | undefined
  const baseRangeFeet = Math.max(CELL_FEET, Number(genericProfile?.attack_profile?.range_feet ?? genericProfile?.attackRange ?? genericProfile?.rangeFeet) || CELL_FEET)
  const selectedAttackKind = selectedWeaponCombat?.kind ?? genericProfile?.attack_profile?.kind ?? (baseRangeFeet <= CELL_FEET ? 'melee' : 'ranged')
  const knockoutEligible = combatMode === 'weapon'
    ? selectedAttackKind === 'melee'
    : combatMode === 'magic' && selectedSpell?.kind === 'attack' && selectedSpell.attackKind === 'melee'
  const attackRangeFeet = Math.max(CELL_FEET, Number(selectedWeaponCombat?.longRange ?? selectedWeaponCombat?.normalRange) || baseRangeFeet)
  const normalRangeFeet = Math.max(CELL_FEET, Number(selectedWeaponCombat?.normalRange ?? genericProfile?.attack_profile?.normal_range_feet) || attackRangeFeet)
  const areaRadiusFeet = selectedItem?.combat?.kind === 'thrown-area' ? Number(selectedItem.combat.radius) || 5 : 0
  const spellAreaRadiusFeet = combatMode === 'magic' && (selectedSpell?.target === 'point' || selfAreaSpell) ? Math.max(0, Number(selectedSpell.radius) || 0) : 0
  const equippedWeapon = activeHero?.inventory.find((item) => item.type === 'weapon' && item.equipped)
  const needsWeaponChange = Boolean(selectedItem?.type === 'weapon' && !selectedItem.equipped && equippedWeapon && equippedWeapon.id !== selectedItem.id)
  const economy = combat.action_economy?.[turnActorId]
  const movement = actorMovementPresentation(state.mechanics?.movement?.[turnActorId], active?.speed ?? 0, economy, combatActive)
  const sneakAttackEligible = combatMode === 'weapon'
    && activeHero?.characterClass === 'rogue'
    && selectedItem?.type === 'weapon'
    && (selectedWeaponCatalogCombat?.kind === 'ranged' || selectedWeaponCatalogCombat?.abilities?.includes('dex'))
  const sneakAttackSpent = Boolean(economy?.sneak_attack_turn_key)
  const authoritativeMovementSpent = movement.spent
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
  const speedFeet = movement.budget
  const remainingFeet = movement.remaining
  const movementAvailable = movement.available
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
        areaSideFeet: effect.area_side_feet,
        areaShape: (['sphere', 'cylinder', 'cone', 'cube', 'line'].includes(String(effect.area_shape))
          ? effect.area_shape
          : 'sphere') as BoardAreaEffect['areaShape'],
        ...(effect.geometry_version ? { geometryVersion: effect.geometry_version } : {}),
        ...(effect.grid_origin ? { gridOrigin: effect.grid_origin } : {}),
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
  const onPropActivate = (propId: string) => {
    if (!interactiveSceneObjects.some((prop) => prop.id === propId)) return
    setSelectedSceneObjectId((current) => current === propId ? null : propId)
  }
  const sceneObjectOpen = (prop: TacticalProp | undefined) => Boolean(prop && ['open', 'taken', 'looted'].includes(prop.state))
  const sceneObjectsAtHand = active
    ? interactiveSceneObjects.filter((prop) => sceneObjectCells(prop).some((cell) => actorDistanceFeet(active, cell) <= CELL_FEET))
    : []
  const selectedSceneObject = interactiveSceneObjects.find((prop) => prop.id === selectedSceneObjectId) ?? null
  const selectedSceneObjectAtHand = Boolean(selectedSceneObject && sceneObjectsAtHand.some((prop) => prop.id === selectedSceneObject.id))
  /* Благословения приезжают готовой карточкой: цена требы, СЛ молитвы и то,
     прошли ли сутки, посчитаны сервером (`server/blessings.mjs`). Своей
     арифметики суток здесь нет — иначе кнопка обещала бы одно, а движок делал
     другое. */
  const blessings = state.blessings ?? null
  const blessingAvailable = blessings?.available !== false
  /* Благословение, которое ещё не израсходовано, закрывает оба обращения:
     второго поверх первого движок не даёт (`BLESSING_ALREADY_ACTIVE`). Одного
     суточного слота здесь мало — сутки открывают его через 1440 минут, а
     состояние снимает продолжительный отдых или первый удар, и сутки дороги без
     ночёвки оставляли кнопку требы горящей над отказом. */
  const blessingHeld = blessings?.blessed === true
  const blessingWaitHours = Math.ceil(Math.max(0, Number(blessings?.waits_minutes) || 0) / 60)
  const blessingHeldHint = 'Благословение этого героя ещё не израсходовано: оно уйдёт первым ударом или продолжительным отдыхом'
  const blessingSpentHint = `Этот герой уже обращался к богам сегодня. Снова можно примерно через ${blessingWaitHours} ч`
  const blessingPrayerHint = !blessingAvailable
    ? blessingSpentHint
    : blessingHeld
      ? blessingHeldHint
      : `Молитва: проверка Религии, СЛ ${Number(blessings?.prayer_dc) || 12}. Успех — малое благословение (+${Number(blessings?.attack_bonus) || 1} к первой атаке) до продолжительного отдыха. Раз в сутки на героя`
  const blessingPriests = blessings?.priests ?? []
  const blessingDonationCp = Math.max(0, Number(blessings?.donation_cp) || 0)
  /* Взлом приезжает такой же готовой карточкой (`server/lockpicking.mjs`):
     владеет ли герой инструментом и какой строкой сервер откажет, если нет.
     Своей проверки владения у клиента нет намеренно — лист героя её не везёт, а
     сочинённый браузером отказ разошёлся бы с ответом движка. Сложности замка в
     карточке нет и не будет: СЛ игроку не объявляется. */
  const lockpicking = state.lockpicking ?? null
  const lockpickAllowed = lockpicking?.proficient === true
  const lockpickBlockedHint = lockpicking?.blocked_reason || 'Нужно владение воровскими инструментами'
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
  const sceneObjectAnchorById = new Map<string, string>()
  for (const prop of [...interactiveSceneObjects].sort((left, right) => left.zOrder - right.zOrder)) {
    const cells = sceneObjectCells(prop)
    const anchor = cells[0]
    if (anchor) sceneObjectAnchorById.set(prop.id, boardPositionKey(anchor.x, anchor.y))
    for (const cell of cells) sceneObjectByCell.set(boardPositionKey(cell.x, cell.y), prop)
  }
  const movementLimit = combatActive ? remainingFeet : Number.POSITIVE_INFINITY
  const reachable = selected && active && movementAvailable
    ? new Set([...movementPaths.entries()].filter(([, route]) => route.costFeet <= movementLimit).map(([key]) => key))
    : new Set<string>()
  // Выбранная клетка принадлежит ходу, в котором её выбрали: после смены хода
  // второй клик по ней не должен двигать уже другого героя.
  useEffect(() => { setPendingMoveKey(null) }, [turnActorId, selected, combatActive])
  const pendingMovePoint = combatActive && pendingMoveKey && reachable.has(pendingMoveKey)
    ? (() => { const [x, y] = pendingMoveKey.split(',').map(Number); return { x, y } })()
    : null
  const previewMoveKey = pendingMoveKey ?? hoveredMoveKey
  const previewRoute = previewMoveKey ? movementPaths.get(previewMoveKey) ?? null : null
  const maneuverPath = state.pendingAction?.proposal.actor_id === turnActorId ? state.pendingAction.proposal.path : null
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
  /* Ресурсный кластер и кнопка конца хода читают ту же серверную
     `action_economy`, что и плашка над картой: своей арифметики хода у панели
     нет и быть не должно — иначе панель обещала бы одно, а движок делал другое. */
  const movementRatio = movementAvailable && speedFeet > 0 ? Math.max(0, Math.min(1, remainingFeet / speedFeet)) : 0
  const heroPips: Array<{ id: HotbarCostFilter; label: string; ready: boolean; note: string }> = [
    // «Дополнительная атака» не заводит второго пипса: действие одно, а сколько
    // ударов оно ещё несёт — подпись рядом с кругом.
    { id: 'action', label: 'Действие', ready: actionReady || weaponAttackReady, note: weaponAttacksAllowed > 1 ? `атаки ${weaponAttacksUsed}/${weaponAttacksAllowed}` : '' },
    { id: 'bonus_action', label: 'Бонус', ready: bonusReady, note: '' },
    { id: 'reaction', label: 'Реакция', ready: reactionReady, note: '' },
  ]
  /* Показываем только то, что у героя есть: пустого ряда «ячейки» у воина не
     будет вовсе, потому что в `activeResources` их нет. */
  const heroClassPoolRows = heroClassPoolRowsFrom(activeResources)
  /* Чужой ход: колонка ресурсов и ячейки принадлежат герою зрителя, а не
     ходящему. Плитки чужого героя спрятаны с плейтеста 2026-10-02, но колонка
     осталась: воин видел у себя скорость жреца, его «божественный канал» и —
     хуже всего — его реакцию, хотя свою реакцию игрок тратит как раз в чужой
     ход (плейтест 2026-10-03). */
  const viewerHero = combatActive && foreignTurn ? players.find((player) => player.id === typingActorId) : undefined
  const railEconomy = viewerHero ? combat.action_economy?.[viewerHero.id] : economy
  const railMovement = viewerHero
    ? actorMovementPresentation(state.mechanics?.movement?.[viewerHero.id], viewerHero.speed ?? 0, railEconomy, combatActive)
    : movement
  const railMovementAvailable = viewerHero ? railMovement.available : movementAvailable
  const railRemainingFeet = viewerHero ? railMovement.remaining : remainingFeet
  const railSpeedFeet = viewerHero ? railMovement.budget : speedFeet
  const railMovementRatio = viewerHero
    ? railMovementAvailable && railSpeedFeet > 0 ? Math.max(0, Math.min(1, railRemainingFeet / railSpeedFeet)) : 0
    : movementRatio
  const railActionCount = viewerHero
    ? Number(railEconomy?.action !== false) + Math.max(0, Number(railEconomy?.extra_actions) || 0)
    : Number(actionReady) + Math.max(0, Number(economy?.extra_actions) || 0)
  const railPips: typeof heroPips = viewerHero ? [
    { id: 'action', label: 'Действие', ready: railEconomy?.action !== false, note: '' },
    { id: 'bonus_action', label: 'Бонус', ready: railEconomy?.bonus_action !== false, note: '' },
    { id: 'reaction', label: 'Реакция', ready: railEconomy?.reaction !== false, note: '' },
  ] : heroPips
  const railResources = viewerHero ? heroResourcesFor(state, viewerHero.id, viewerHero) : activeResources
  const railClassPoolRows = viewerHero ? heroClassPoolRowsFrom(railResources) : heroClassPoolRows
  const railName = viewerHero?.character ?? activeName
  /* Спасброски от смерти — у того же героя, что и полоска жизни слева: у
     ходящего героя, а в ход противника — у героя зрителя, который ждёт
     своего броска весь чужой ход. */
  const ownHero = viewerHero ?? activeHero ?? players.find((player) => player.id === typingActorId)
  const ownDeathSaves = ownHero && ownHero.hp <= 0 ? state.mechanics?.death?.saving_throws?.[ownHero.id] : undefined
  const ownHeroDead = Boolean(ownHero && (state.mechanics?.death?.heroes?.[ownHero.id]?.status === 'dead'
    || (state.mechanics?.conditions?.[ownHero.id] ?? []).some((condition) => condition.id === 'dead')))
  /* Что в ходу ещё не потрачено — списком, из которого собирается честная
     подсказка «Завершить ход». Реакции здесь нет намеренно: она переживает
     конец своего хода и тратится на чужом. */
  const unspentTurnResources = [
    ...(actionReady ? ['действие'] : weaponAttackReady ? [`атаки ${weaponAttacksLeft} из ${weaponAttacksAllowed}`] : []),
    ...(bonusReady ? ['бонусное действие'] : []),
    ...(movementAvailable && remainingFeet > 0 ? [`движение ${remainingFeet} фт`] : []),
  ]
  const turnFullySpent = combatActive && unspentTurnResources.length === 0
  /* Переспрос, как в BG3: щелчок по «Завершить ход», когда остались шаги или
     бонус, сначала перечисляет, что ещё можно сделать. Пробел завершает сразу —
     клавиатура остаётся быстрым путём. «Не спрашивать» живёт до конца боя. */
  const [endTurnConfirm, setEndTurnConfirm] = useState(false)
  const [skipEndTurnConfirm, setSkipEndTurnConfirm] = useState(false)
  useEffect(() => { setEndTurnConfirm(false) }, [turnActorId])
  useEffect(() => { if (!combatActive) { setEndTurnConfirm(false); setSkipEndTurnConfirm(false) } }, [combatActive])
  useDialogEscape(() => setEndTurnConfirm(false), endTurnConfirm)
  const requestFinishTurn = () => {
    if (turnFullySpent || skipEndTurnConfirm) { void onFinishTurn(); return }
    setEndTurnConfirm(true)
  }
  /* Escape снимает фильтр стоимости — и только его. Пока книга заклинаний
     открыта, Escape принадлежит ей (`useDialogEscape`), иначе одно нажатие
     закрывало бы окно и заодно сбрасывало выборку под ним. */
  useEffect(() => {
    if (!costFilter || spellbookOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setCostFilter(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [costFilter, spellbookOpen])
  /* Пробел завершает ход — но только когда ход вообще можно завершить и когда
     клавиша никому больше не нужна: в поле ввода это пробел между словами, а на
     кнопке в фокусе — её собственное нажатие. */
  const finishTurnRef = useRef(onFinishTurn)
  finishTurnRef.current = onFinishTurn
  useEffect(() => {
    if (!combatActive || !canAct || tacticalBusy) return
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      const focused = document.activeElement
      const tag = focused instanceof HTMLElement ? focused.tagName : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return
      // Пробел на элементе, который сам считает его нажатием (клетка мира,
      // редактируемый текст), принадлежит этому элементу, а не ходу.
      if (focused instanceof HTMLElement && (focused.isContentEditable || focused.getAttribute('role') === 'button')) return
      event.preventDefault()
      void finishTurnRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combatActive, canAct, tacticalBusy])
  const selectedSpellSupport = mechanicsSupportPresentation(selectedSpell?.mechanicsSupport, selectedSpell?.supportNote)
  const selectedSpellComponentAvailability = spellComponentAvailabilityFor(selectedSpell)
  /* Вне боя экономики хода нет, а длинное накладывание, наоборот, доступно
     только там: боевая панель его не вмещает. Совпадает с правилом движка —
     `HARMFUL_SPELL_KINDS` и проверка `long_cast` в rules-engine. */
  const spellEconomyReady = selectedSpellItemReady && !selectedSpellSupport.blocked && !selectedSpellComponentAvailability.blocked && selectedSpell?.prepared !== false && spellSlotReady && !(state.ruleset_id === 'dnd_5e_2014' && selectedSpellAction === 'reaction') && (combatActive
    ? selectedSpellAction !== 'long_cast' && (selectedSpellAction === 'bonus_action' ? bonusReady : selectedSpellAction === 'reaction' ? reactionReady : actionReady)
    : Boolean(selectedSpell && castableOutOfCombat(selectedSpell)))
  const selectedActionPool = selectedCombatAction?.resource ? activeResources[selectedCombatAction.resource] : undefined
  const selectedActionResourceReady = !selectedCombatAction?.resource || Number(selectedActionPool?.current ?? 0) >= Number(selectedCombatAction.cost ?? 1)
  const selectedActionSupport = mechanicsSupportPresentation(selectedCombatAction?.mechanicsSupport, selectedCombatAction?.supportNote)
  const selectedActionEconomyReady = Boolean(selectedCombatAction && !selectedActionSupport.blocked && selectedActionResourceReady && (selectedCombatAction.actionType === 'free' || (selectedCombatAction.actionType === 'bonus_action' ? bonusReady : selectedCombatAction.actionType === 'reaction' ? reactionReady : actionReady)))
  const selectedCommandReady = combatMode === 'magic' ? spellEconomyReady : combatMode === 'action' ? selectedActionEconomyReady : weaponAttackReady
  const selectedSpellSlotOption = {
    ...(selectedSpellSlotLevel ? { slotLevel: selectedSpellSlotLevel } : {}),
    ...(explicitSpellSource && selectedCastingSource ? {
      castingResource: selectedSpellSlotLevel ? `spell_slots_${selectedSpellSlotLevel}` : selectedCastingSource.resource,
      slotLevel: selectedSpellCastLevel,
    } : {}),
  }
  /* Действие на себя цели на карте не требует, поэтому подтверждение выводится
     из самого выбора, а не хранится в `pendingCommand`: команду стирает эффект,
     который срабатывает как раз на смену выбранного заклинания. */
  const selfCastSpell = combatMode === 'magic' && selectedSpell?.target === 'self' && !selfAreaSpell && spellEconomyReady ? selectedSpell : null
  const selfUseAction = combatMode === 'action' && selectedCombatAction?.target === 'self' && selectedActionEconomyReady ? selectedCombatAction : null
  const selfCastReady = Boolean(selected && !tacticalBusy && (selfCastSpell || selfUseAction))
  const confirmSelfCast = async (note?: string): Promise<CommandOutcome | null> => {
    if (!selected) return null
    const outcome = selfCastSpell
      ? await onCastSpell(selected, selfCastSpell.id, { targetId: selected, ...selectedSpellItemOption, ...selectedSpellSlotOption, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(note ? { note } : {}) })
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
          && actorDistanceFeet(active, enemy) === CELL_FEET
      })
    : []
  const showStartCombat = aliveEnemies.length > 0 && !combatActive
  /* Вне боя плитки видны, но не нажимаются: выбор цели на карте закрыт по всему
     клиенту (`combatActive &&` в каждом правиле наведения), да и сервер отвергает
     атаку и боевое действие без инициативы — `COMBAT_NOT_ACTIVE` в rules-engine.
     Показывать живую плитку, которая никуда не ведёт, хуже, чем закрытую. */
  const actionsLocked = tacticalBusy || !combatActive
  const pendingPoint = pendingCommand?.kind === 'area' ? pendingCommand : null
  const pendingTargetId = pendingCommand?.kind === 'target' || pendingCommand?.kind === 'spell-target' || pendingCommand?.kind === 'action-target'
    ? pendingCommand.targetId
    : null
  const pendingTarget = pendingTargetId
    ? [...players, ...(state.actors ?? []), ...(state.enemies ?? [])].find((actor) => actor.id === pendingTargetId) ?? null
    : null
  const projectileTarget = pendingPoint ?? aimCell
  const projectileEnd = pendingTarget ?? projectileTarget
  const trajectoryStart = active
    ? boardMap ? actorPresentationCenter(boardMap, active) : { x: active.x + .5, y: active.y + .5 }
    : null
  const trajectoryEnd = projectileEnd
    ? pendingTarget && boardMap
      ? actorPresentationCenter(boardMap, pendingTarget)
      : { x: projectileEnd.x + .5, y: projectileEnd.y + .5 }
    : null
  const trajectory = trajectoryStart && trajectoryEnd
    ? { x1: trajectoryStart.x / columns * 100, y1: trajectoryStart.y / rows * 100, x2: trajectoryEnd.x / columns * 100, y2: trajectoryEnd.y / rows * 100 }
    : null
  const activeConditions = (state.mechanics?.conditions?.[turnActorId] ?? []).map(conditionPresentation)
  const pendingTargetName = pendingTarget
    ? ('character' in pendingTarget ? pendingTarget.character : pendingTarget.name)
    : pendingPoint ? `клетка ${pendingPoint.x + 1}:${pendingPoint.y + 1}` : ''
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
  // Босс берётся из состояния по идентификатору, а не из снимка наведения:
  // снимок делается один раз при наведении, а запас легендарных действий
  // тратится и восстанавливается прямо под курсором. Признак — серверный:
  // клиент его не выводит и рамку сам себе не рисует.
  const inspectedBoss = inspectedTarget?.team === 'enemy'
    ? state.enemies?.find((enemy) => enemy.id === inspectedTarget.id && enemy.boss === true) ?? null
    : null
  const sceneTheme = resolveSceneTheme(state)
  const fortressMap = boardMap?.generator?.id === 'ares-fortress'
  const visualTheme = fortressMap ? 'map-theme-fortress' : boardVisualTheme(sceneTheme)
  const mapArt = boardMapArtForMap(sceneTheme, boardMap)

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
    setActiveDeck('all')
    setCombatMode('weapon')
  }, [turnActorId])
  useEffect(() => {
    if (selectedSpell && selectedSpell.id !== selectedSpellId) setSelectedSpellId(selectedSpell.id)
  }, [selectedSpell?.id, selectedSpellId])
  useEffect(() => {
    if (selectedSpell?.id !== 'shillelagh') {
      setSelectedSpellItemId('')
      return
    }
    if (!shillelaghHeldItems.some((item) => item.id === selectedSpellItemId)) {
      setSelectedSpellItemId(shillelaghHeldItems[0]?.id ?? '')
    }
  }, [selectedSpell?.id, shillelaghHeldItemKey])
  useEffect(() => {
    const options = selectedSpell?.spellOptions ?? []
    if (!options.length) setSelectedSpellOption('')
    else if (!options.includes(selectedSpellOption as typeof options[number])) setSelectedSpellOption(options[0])
  }, [selectedSpell?.id, selectedSpellOption])
  useEffect(() => {
    if (!explicitSpellSource && spellSlotLevelChoice != null && !availableSpellSlotLevels.includes(spellSlotLevelChoice)) setSpellSlotLevelChoice(null)
  }, [explicitSpellSource, spellSlotLevelChoice, availableSpellSlotLevels.join('|')])
  useEffect(() => {
    const defaultMode = weaponModeOptions[0]
    const mode = weaponModeOptions.find((candidate) => candidate.id === attackMode) ?? defaultMode
    const abilities = (selectedWeaponCatalogCombat?.abilities ?? (mode?.ability ? [mode.ability] : [])) as NonNullable<WeaponAttackChoice['attackAbility']>[]
    setAttackMode(mode?.id)
    setAttackAbility(activeShillelaghAbility
      ? undefined
      : (current) => abilities.includes(current as NonNullable<WeaponAttackChoice['attackAbility']>) ? current : mode?.ability)
  }, [selectedItem?.id, selectedWeaponCatalogCombat?.abilities?.join('|'), weaponModeKey, attackMode, activeShillelaghAbility])
  useEffect(() => { if (!knockoutEligible) setKnockOut(false) }, [knockoutEligible])
  useEffect(() => { if (!sneakAttackEligible || sneakAttackSpent) setSneakAttack(false) }, [sneakAttackEligible, sneakAttackSpent])
  useEffect(() => {
    setPendingCommand(null)
    setSpellSlotLevelChoice(null)
    setSpellCastingSourceChoice(null)
    setSpellTargetIds([])
    setAreaSpellPoint(null)
    setPendingMoveKey(null)
    setHoveredMoveKey(null)
    setInspectedTarget(null)
    setAimCell(null)
  }, [selectedItemId, selectedSpellId, selectedSpellItemId, selectedCombatActionId, combatMode, turnActorId, combat.round, attackMode, attackAbility, sneakAttack, boardMap?.locationId, sceneLevelIndex])

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
  const issueSpell = async (target: Parameters<typeof onCastSpell>[2]) => {
    if (!selected || !selectedSpell || !spellEconomyReady || spellCommandInFlight.current) return
    spellCommandInFlight.current = true
    try {
      const outcome = await onCastSpell(selected, selectedSpell.id, { ...target, ...selectedSpellItemOption, ...selectedSpellSlotOption, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}) })
      if (outcome.ok) {
        setPendingCommand(null)
        setSpellTargetIds([])
        setAreaSpellPoint(null)
        setAimCell(null)
        setOpenTokenLabelId(null)
        setInspectedTarget(null)
        setInspectedAnchor(null)
        setCombatMode('weapon')
      }
    } finally {
      spellCommandInFlight.current = false
    }
  }
  const confirmSpellTargetSelection = () => {
    if (!multiTargetSpell || !spellTargetIds.length || !selected || !selectedSpell || !spellEconomyReady) return
    const targetIds = [...spellTargetIds]
    const areaTarget = areaTargetSelectionActive && areaTargetPoint
      ? { x: areaTargetPoint.x, y: areaTargetPoint.y, targetIds }
      : { targetIds }
    // Областное лечение уже собрано полностью: Enter — единственное
    // подтверждение, поэтому оно не превращается в чип с повторным Apply в
    // строке свободного действия. Longstrider сохраняет прежний общий путь.
    if (autoAttackRoll || explicitSpellSource || selectTargetsInAreaSpell) {
      void issueSpell({ ...areaTarget, ...(knockOut && knockoutEligible ? { knockOut: true } : {}) })
    } else {
      setPendingCommand({ kind: 'spell-targets', targetIds })
    }
  }
  const toggleSpellTarget = (targetId: string, selectable: boolean) => {
    if (!multiTargetSpell || !selected || !selectedSpell || !spellEconomyReady) return
    setSpellTargetIds((current) => toggleCombatSpellTargetIds(current, targetId, spellTargetLimit, selectable))
  }
  const castAtTarget = (targetId: string) => {
    if (!selected || !selectedSpell || !spellEconomyReady) return
    if (multiTargetSpell) return
    if (autoAttackRoll || explicitSpellSource) void issueSpell({ targetId, ...(knockOut && knockoutEligible ? { knockOut: true } : {}) })
    else setPendingCommand({ kind: 'spell-target', targetId })
  }
  const castAtCell = (x: number, y: number) => {
    if (!selected || !selectedSpell || selectedSpell.target !== 'point' || !spellEconomyReady) return
    if (pointSpellReason({ x, y })) return
    if (selectTargetsInAreaSpell) {
      if (!areaSpellPoint) {
        setAreaSpellPoint({ x, y })
        setAimCell({ x, y })
        setSpellTargetIds([])
        setPendingCommand(null)
      }
      return
    }
    void issueSpell({ x, y })
  }
  const selectSpell = (spell: CombatSpell, tile?: HTMLElement) => {
    if (mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote).blocked) return
    if (state.ruleset_id === 'dnd_5e_2014' && spellActionType(spell) === 'reaction') return
    setSelectedSpellId(spell.id)
    setSelectedSpellOption(spell.spellOptions?.[0] ?? '')
    setCombatMode('magic')
    /* Несколько доступных кругов — спрашиваем круг сразу у плитки. Выбор
       ляжет в тот же `slot_level`, что и список «Ячейка» в параметрах. */
    const castableLevels = spellSlotAvailabilityFor(spell, activeResources).levels
    setUpcastPrompt(tile && spell.level > 0 && castableLevels.length > 1 ? { spellId: spell.id, anchor: tile.getBoundingClientRect() } : null)
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
    if (!combatActionTargetGuard(selectedCombatAction, targetId).allowed) return
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
  const clearPrepared = () => { setPendingCommand(null); setSpellTargetIds([]); setAreaSpellPoint(null); setAimCell(null); setCombatMode('weapon') }

  const spellAiming = Boolean(selected && combatMode === 'magic' && selectedSpell && spellEconomyReady)
  const pointSpellSelected = Boolean(selected && combatMode === 'magic' && selectedSpell?.target === 'point' && spellEconomyReady)
  const spellAreaPreviewSelected = Boolean(pointSpellSelected || areaTargetSelectionActive)
  /* Предпросмотр хода (`src/move-preview.ts`): нить маршрута и одно число у
     цели вместо номера на каждой клетке, а в бою ещё контур — докуда хватает
     движения. Прицел заклинания гасит и то и другое: клик по клетке тогда
     значит «колдовать сюда», а не «идти сюда». Вне боя контура нет — движение
     не ограничено, и он обвёл бы всю карту. */
  const movePreview: BoardMovePreview | null = (() => {
    if (!active || spellAiming) return null
    const routePath = maneuverPath ?? previewRoute?.path ?? []
    const reach = combatActive ? [...reachable] : []
    if (!routePath.length && !reach.length) return null
    const start = { x: active.x, y: active.y }
    const path = routePath.map((step) => ({ x: step.x, y: step.y, difficult: isDifficultTerrain(state, step, boardMap) }))
    const threatened = (point: { x: number; y: number }) => opportunityThreats.some((threat) => actorDistanceFeet(threat, point) <= CELL_FEET)
    const risk = path.length && opportunityThreats.length ? moveRiskPoint({ start, path }, threatened) : null
    const route = maneuverPath ? null : previewRoute
    return {
      start,
      path,
      reach,
      risk,
      label: route ? {
        main: `${route.costFeet} фт`,
        ...(combatActive ? { sub: `останется ${Math.max(0, remainingFeet - route.costFeet)} фт` } : {}),
        ...(route.difficultTerrainFeet > 0 ? { note: `трудная местность +${route.difficultTerrainFeet} фт` } : {}),
        ...(risk ? { risk: 'атака по возможности' } : {}),
      } : undefined,
    }
  })()
  useEffect(() => {
    if (spellEconomyReady) return
    setAreaSpellPoint(null)
    setAimCell(null)
  }, [spellEconomyReady])
  useEffect(() => {
    if (!spellAiming || spellbookOpen) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return
      setPendingCommand(null)
      setSpellTargetIds([])
      setAreaSpellPoint(null)
      setAimCell(null)
      setCombatMode('weapon')
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [spellAiming, spellbookOpen])
  useEffect(() => {
    if (!multiTargetSpell || !spellAiming || spellbookOpen || pendingCommand) return
    const confirm = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.repeat) return
      if ((event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (!spellTargetIds.length) return
      event.preventDefault()
      event.stopPropagation()
      confirmSpellTargetSelection()
    }
    window.addEventListener('keydown', confirm, true)
    return () => window.removeEventListener('keydown', confirm, true)
  }, [multiTargetSpell, spellAiming, spellbookOpen, pendingCommand, spellTargetIds, autoAttackRoll, selectedSpell?.id, selectedSpellMaxTargets, knockoutEligible])

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
      outcome = await onCastSpell(selected, selectedSpell.id, { targetId: pendingCommand.targetId, ...selectedSpellItemOption, ...selectedSpellSlotOption, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(knockOut && knockoutEligible ? { knockOut: true } : {}), ...(note ? { note } : {}) })
    } else if (pendingCommand.kind === 'spell-targets' && selectedSpell) {
      outcome = await onCastSpell(selected, selectedSpell.id, { targetIds: pendingCommand.targetIds, ...selectedSpellItemOption, ...selectedSpellSlotOption, ...(selectedSpellOption ? { spellOption: selectedSpellOption } : {}), ...(knockOut && knockoutEligible ? { knockOut: true } : {}), ...(note ? { note } : {}) })
    } else if (pendingCommand.kind === 'action-target' && selectedCombatAction) {
      outcome = await onUseCombatAction(selected, selectedCombatAction.id, pendingCommand.targetId, selectedCombatAction.requiresWeapon ? selectedItem?.id : undefined, undefined, note)
    }
    if (outcome?.ok) {
      if (pendingCommand.kind === 'target' && pendingCommand.sneakAttack) setSneakAttack(false)
      setPendingCommand(null)
      setSpellTargetIds([])
      setAreaSpellPoint(null)
      setAimCell(null)
    }
    return outcome
  }

  const previewBlastCenter = pointSpellSelected
    ? (areaSpellPoint ?? aimCell)
    : areaTargetSelectionActive
      ? areaTargetPoint
    : combatMode === 'weapon' ? projectileTarget : null
  const previewBlastSizeFeet = combatMode === 'magic' ? spellAreaRadiusFeet : areaRadiusFeet
  const previewBlastShape = combatMode === 'magic' ? selectedSpell?.areaShape ?? 'sphere' : 'sphere'
  const previewBlastGeometryVersion = selectedSpell?.areaGeometryVersion
  const previewBlastGridOrigin = previewBlastCenter
    && previewBlastGeometryVersion === CIRCULAR_AREA_GEOMETRY_VERSION
    && (previewBlastShape === 'sphere' || previewBlastShape === 'cylinder')
    ? gridOriginForTargetCell(previewBlastCenter)
    : undefined
  const previewBlastKeys = useMemo(() => {
    if (!previewBlastCenter || !active || previewBlastSizeFeet <= 0) return new Set<string>()
    const previewWalkableKeys = new Set(
      state.scene.cells
        .filter((cell) => cell.revealed !== false && (cell.type === 'floor' || cell.type === 'door'))
        .map((cell) => boardPositionKey(cell.x, cell.y)),
    )
    const geometryCells = areaCellsForActor({
        shape: previewBlastShape,
        origin: active,
        target: previewBlastCenter,
        originMode: selectedSpell?.areaOrigin ?? 'point',
        sizeFeet: previewBlastSizeFeet,
        ...(previewBlastGeometryVersion ? { geometryVersion: previewBlastGeometryVersion } : {}),
        ...(previewBlastGridOrigin ? { gridOrigin: previewBlastGridOrigin } : {}),
        ...(selectedSpell?.areaSideFeet ? { sideFeet: selectedSpell.areaSideFeet } : {}),
        cellFeet: CELL_FEET,
        bounds: { minX: 0, minY: 0, maxX: columns - 1, maxY: rows - 1 },
        isWalkable: (point) => previewWalkableKeys.has(boardPositionKey(point.x, point.y)),
      }, active, boardMap)
    if (!boardMap) return new Set(geometryCells.map((point) => boardPositionKey(point.x, point.y)))
    const profile = selectedSpell
      ? spellVisualProfile(selectedSpell.id, selectedSpell)
      : null
    const origins = selectedSpell?.areaOrigin === 'self' || selectedSpell?.target === 'self'
      ? actorFootprintCells(active)
      : [previewBlastCenter]
    return maskSpellAreaCells(boardMap, geometryCells, {
      origins,
      spreadsAroundCorners: profile?.spreadsAroundCorners === true,
      radiusFeet: previewBlastSizeFeet,
      ...(previewBlastGeometryVersion ? { geometryVersion: previewBlastGeometryVersion } : {}),
      ...(previewBlastGeometryVersion === CIRCULAR_AREA_GEOMETRY_VERSION && previewBlastGridOrigin
        ? { gridOrigin: previewBlastGridOrigin }
        : {}),
    })
  }, [
    active?.id, active?.x, active?.y, active?.footprint?.version, active?.footprint?.size, boardMap,
    columns, previewBlastCenter?.x, previewBlastCenter?.y, previewBlastShape, previewBlastSizeFeet,
    rows, previewBlastGeometryVersion, previewBlastGridOrigin?.x, previewBlastGridOrigin?.y,
    selectedSpell?.areaOrigin, selectedSpell?.areaSideFeet, state.scene.cells,
  ])

  const pointSpellUsesCircularGeometry = selectedSpell?.areaGeometryVersion === CIRCULAR_AREA_GEOMETRY_VERSION
    && (previewBlastShape === 'sphere' || previewBlastShape === 'cylinder')
  const clearPointSpellLineOfEffect = (point: { x: number; y: number }) => {
    if (!active) return false
    if (pointSpellUsesCircularGeometry && boardMap) {
      const origin = gridOriginForTargetCell(point)
      return actorFootprintCells(active).some((casterCell) => circularGridPointLineOfEffect(boardMap, origin, casterCell, {
        radiusFeet: 600,
        spreadsAroundCorners: false,
      }))
    }
    return hasClearBoardTrajectory(state, active, point)
  }
  const pointSpellReason = (point: { x: number; y: number }) => {
    if (!active || !pointSpellSelected) return 'Заклинание недоступно'
    const cell = state.scene.cells.find((candidate) => candidate.x === point.x && candidate.y === point.y)
    if (!cell?.revealed || (cell.type !== 'floor' && cell.type !== 'door')) return 'Недоступная точка'
    if (selectedSpell?.areaOrigin === 'self' && ['cone', 'cube', 'line'].includes(previewBlastShape) && actorDistanceFeet(active, point) === 0) return 'Укажите направление'
    if (actorDistanceFeet(active, point) > selectedSpellRange) return 'Вне дальности'
    if (!clearPointSpellLineOfEffect(point)) return pointSpellUsesCircularGeometry
      ? 'Недоступная траектория области'
      : actorTrajectoryBlockReason(state, active, point)
    return ['summon', 'teleport'].includes(selectedSpellKind ?? '')
      && animationActors.some((actor) => !actor.defeated && actorFootprintCells(actor).some((occupied) => occupied.x === point.x && occupied.y === point.y))
      ? 'Клетка занята'
      : null
  }
  const spellAimReason = pointSpellSelected && previewBlastCenter ? pointSpellReason(previewBlastCenter) : null
  const spellAffectedActors = spellAreaPreviewSelected ? spellPreviewActors(boardMap, previewBlastKeys, animationActors) : []
  // Если источник не объявляет maxTargets (как у Destructive Wave), UI не
  // придумывает лимит «1»: пределом служит число доступных видимых фишек в
  // уже показанной области. Ячейка усиливает только объявленный сервером
  // maxTargets, поэтому его отсутствие не превращается в скрытое правило.
  const spellTargetLimit = selectTargetsInAreaSpell && selectedSpell?.maxTargets == null
    ? spellAffectedActors.length
    : selectedSpellMaxTargets
  const spellAffectedIds = new Set(spellAffectedActors.map((actor) => actor.id))
  const spellAffectedAllies = spellAffectedActors.filter((actor) => actor.kind === 'hero' || actor.kind === 'summon')
  const selectedSpellTargetSet = new Set(spellTargetIds)
  const selectedSpellTargetSeparationFeet = Math.max(0, Number(selectedSpell?.maxTargetSeparationFeet) || 0)
  const selectedSpellTargetSeparationAnchor = selectedSpell?.targetSeparationAnchor === 'primary' ? spellTargetIds[0] ?? null : null
  const selectedSpellPrimary = selectedSpellTargetSeparationAnchor
    ? animationActors.find((actor) => actor.id === selectedSpellTargetSeparationAnchor) ?? null
    : null
  const spellTargetSeparationReason = (candidate: BoardAnimationActor) => {
    if (!multiTargetSpell || !selectedSpellTargetSeparationFeet) return null
    if (selectedSpellPrimary) {
      if (candidate.id === selectedSpellPrimary.id) return null
      if (actorDistanceFeet(selectedSpellPrimary, candidate) > selectedSpellTargetSeparationFeet) {
        return `Цель должна быть в пределах ${selectedSpellTargetSeparationFeet} футов от ${selectedSpellPrimary.label}`
      }
      return hasClearBoardTrajectory(state, selectedSpellPrimary, candidate) ? null : `Траектория от ${selectedSpellPrimary.label} перекрыта`
    }
    const selectedActors = animationActors.filter((actor) => selectedSpellTargetSet.has(actor.id))
    const tooFar = selectedActors.find((actor) => actorDistanceFeet(actor, candidate) > selectedSpellTargetSeparationFeet)
    return tooFar ? `Цель должна быть в пределах ${selectedSpellTargetSeparationFeet} футов от ${tooFar.label}` : null
  }
  const spellTargetSelectionFull = multiTargetSpell && spellTargetLimit > 0 && spellTargetIds.length >= spellTargetLimit
  const beamTargetSelection = Boolean(selectedSpell?.beamScaling || Number(selectedSpell?.beams) > 0)
  const beamDistribution = beamTargetSelection && spellTargetIds.length
    ? spellTargetIds.map((_id, index) => Math.floor(spellTargetLimit / spellTargetIds.length) + (index < spellTargetLimit % spellTargetIds.length ? 1 : 0)).join(' + ')
    : null
  const spellTargetSelectionText = multiTargetSpell
    ? `${areaTargetSelectionActive ? `Сфера ${Number(selectedSpell?.radius) || 30} фт · ` : ''}Цели ${spellTargetIds.length}/${spellTargetLimit}${beamDistribution ? ` · лучи по порядку выбора: ${beamDistribution}` : ''} · Enter — подтвердить`
    : null
  const preparedLabel = (() => {
    if (pendingCommand?.kind === 'target') return `${selectedItem?.name ?? 'Базовая атака'} → ${pendingTargetName ?? 'цель'}`
    if (pendingCommand?.kind === 'area') return `${selectedItem?.name ?? 'Бросок'} → клетка`
    if (pendingCommand?.kind === 'spell-target') return `${selectedSpell?.name ?? 'Заклинание'} → ${pendingTargetName ?? 'цель'}`
    if (pendingCommand?.kind === 'spell-targets') return `${selectedSpell?.name ?? 'Заклинание'} → целей: ${pendingCommand.targetIds.length}${beamDistribution ? ` · лучи: ${beamDistribution}` : ''}`
    if (pendingCommand?.kind === 'action-target') return `${selectedCombatAction?.name ?? 'Действие'} → ${pendingTargetName ?? 'цель'}`
    if (selfCastSpell) return `${selfCastSpell.name} → на себя`
    if (selfUseAction) return `${selfUseAction.name} → на себя`
    if (multiTargetSpell) return `${selectedSpell?.name ?? 'Заклинание'} → выбрано ${spellTargetIds.length}/${spellTargetLimit}${beamDistribution ? ` · лучи: ${beamDistribution}` : ''}; Enter — подтвердить`
    if (awaitingTarget) return `${(combatMode === 'magic' ? selectedSpell?.name : combatMode === 'action' ? selectedCombatAction?.name : selectedItem?.name) ?? 'Действие'} → ${targetWord}`
    return null
  })()
  const spellAimColor = spellEffectPalette(selectedSpell?.id, selectedSpell ?? {}).primary
  const aimingEffectRenderers = spellAreaPreviewSelected && previewBlastCenter && active
    ? [...boardEffectRenderers, createSpellTargetRenderer({
      cells: previewBlastKeys,
      origin: active,
      target: previewBlastGridOrigin ?? previewBlastCenter,
      ...(previewBlastGridOrigin ? { targetAnchor: 'grid-intersection' as const } : {}),
      color: spellAimColor,
      blocked: Boolean(spellAimReason),
    })]
    : boardEffectRenderers
  const targetSelectionHintPoint = areaSpellPoint ?? aimCell
  const targetSelectionHintOrigin = targetSelectionHintPoint
    && selectedSpell?.areaGeometryVersion === CIRCULAR_AREA_GEOMETRY_VERSION
    && (previewBlastShape === 'sphere' || previewBlastShape === 'cylinder')
    ? gridOriginForTargetCell(targetSelectionHintPoint)
    : undefined

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
  const doorHotspotsByCell = new Map<string, typeof doorsAtHand>()
  for (const door of doorsAtHand) {
    const key = boardPositionKey(door.x, door.y)
    const doors = doorHotspotsByCell.get(key) ?? []
    doors.push(door)
    doorHotspotsByCell.set(key, doors)
  }
  // Подсказки клеток без узла: причина недоступности обязана остаться на всех
  // клетках, а узел получает только активная.
  const boardHints = new Map<string, BoardCellHint>()
  /**
   * Один индекс используется и для подсветки всех клеток крупного участника,
   * и для выбора по любой из них. Полная площадь попадает в индекс только
   * после раскрытия всех её клеток; иначе на экране остаётся безопасный
   * одноклеточный anchor и туман не превращается в подсказку о скрытой части.
   */
  const actorByCell = new Map<string, BoardAnimationActor>()
  const actorLayoutById = new Map<string, ReturnType<typeof actorFootprintLayout>>()
  const fullActorIds = new Set<string>()
  const sceneCellByKey = new Map(state.scene.cells.map((sceneCell) => [boardPositionKey(sceneCell.x, sceneCell.y), sceneCell]))
  for (const actor of animationActors) {
    if (actor.defeated && !(actor.kind === 'hero' && !heroIsDead(actor.id))) continue
    const rawLayout = actorFootprintLayout(actor)
    if (!rawLayout) continue
    const rawSize = actorFootprintSize(actor)
    const sceneFullyRevealed = rawLayout.cells.every((point) => {
      const sceneCell = sceneCellByKey.get(boardPositionKey(point.x, point.y))
      return Boolean(sceneCell && sceneCell.revealed !== false)
    })
    const presentationSize = boardMap ? actorPresentationSize(boardMap, actor) : sceneFullyRevealed ? rawSize : 1
    const fullyRevealed = presentationSize === rawSize
    const layout = fullyRevealed ? rawLayout : actorFootprintLayout({ ...actor, footprint: undefined })
    const cells = layout?.cells ?? []
    for (const point of cells) {
      if (sceneCellByKey.get(boardPositionKey(point.x, point.y))?.revealed === false) continue
      const key = boardPositionKey(point.x, point.y)
      if (!actorByCell.has(key)) actorByCell.set(key, actor)
    }
    actorLayoutById.set(actor.id, layout)
    if (fullyRevealed) fullActorIds.add(actor.id)
  }
  for (const cell of state.scene.cells) {
    const actorAtCell = actorByCell.get(boardPositionKey(cell.x, cell.y))
    const player = actorAtCell?.kind === 'hero' ? players.find((item) => item.id === actorAtCell.id && (item.hp > 0 || !heroIsDead(item.id))) : undefined
    const enemy = actorAtCell?.kind === 'enemy' ? state.enemies?.find((item) => item.id === actorAtCell.id && item.alive) : undefined
    const summon = actorAtCell?.kind === 'summon' ? state.actors?.find((item) => item.id === actorAtCell.id && item.alive) : undefined
    const sceneNpc = !player && !enemy && !summon
      ? actorAtCell?.kind === 'neutral'
        ? sceneNpcs.find((item) => item.id === actorAtCell.id)
        : sceneNpcs.find((item) => item.x === cell.x && item.y === cell.y)
      : undefined
    const sceneNpcStance = visibleNpcStance(sceneNpc?.stance ?? 'neutral')
    const sceneNpcMerchant = sceneNpc ? merchantForSceneNpc(state, sceneNpc.id) : null
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
      ? actorDistanceFeet(active, enemy)
      : Number.POSITIVE_INFINITY
    const spellDistanceFeet = enemy && active ? actorDistanceFeet(active, enemy) : Number.POSITIVE_INFINITY
    const trajectoryBlockReason = enemy && active ? actorTrajectoryBlockReason(state, active, enemy) : null
    const clearTrajectory = Boolean(enemy && active && trajectoryBlockReason == null)
    const enemyForecast = enemy
      ? selectedAttackForecast(state.combatForecast?.targets, enemy.id, selectedItem?.id ?? null)
      : null
    const enemyInWeaponRange = attackDistanceFeet >= CELL_FEET && attackDistanceFeet <= attackRangeFeet && (attackRangeFeet <= CELL_FEET || clearTrajectory)
    const enemyInSpellRange = spellDistanceFeet <= selectedSpellRange && (selectedSpellRange <= CELL_FEET || clearTrajectory)
    const enemyInChainSecondaryRange = Boolean(
      enemy && selectedSpellPrimary && enemy.id !== selectedSpellPrimary.id
      && actorDistanceFeet(selectedSpellPrimary, enemy) <= selectedSpellTargetSeparationFeet
      && hasClearBoardTrajectory(state, selectedSpellPrimary, enemy),
    )
    const canWeaponTargetEnemy = Boolean(combatActive && selected && combatMode === 'weapon' && weaponAttackReady && enemyInWeaponRange && selectedItem?.combat?.kind !== 'thrown-area' && !needsWeaponChange)
    const longstriderTargeting = (selectedSpell?.id === 'longstrider' || selectedSpell?.target === 'creature' && selectedSpell.mechanicsSupport === 'verified') && combatMode === 'magic'
    const canSpellTargetEnemy = Boolean(
      (combatActive || longstriderTargeting) && selected && combatMode === 'magic'
      && selectedSpell && ['enemy', 'creature'].includes(selectedSpell.target) && spellEconomyReady
      && (selectedSpellPrimary && enemy?.id !== selectedSpellPrimary.id ? enemyInChainSecondaryRange : enemyInSpellRange)
      && (!longstriderTargeting || clearTrajectory),
    )
    const selectedActionRange = selectedCombatAction?.requiresWeapon ? attackRangeFeet : Number(selectedCombatAction?.range ?? 0)
    const enemyInActionRange = Boolean(enemy && active && actorDistanceFeet(active, enemy) <= selectedActionRange && (selectedActionRange <= CELL_FEET || clearTrajectory))
    const enemyKnockedOut = Boolean(enemy && state.mechanics?.resting?.[enemy.id]?.reason === 'knockout')
    const selectedActionTargetGuard = enemy && selectedCombatAction
      ? combatActionTargetGuard(selectedCombatAction, enemy.id)
      : { allowed: true, reason: null }
    const canActionTargetEnemy = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['enemy', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && selectedActionTargetGuard.allowed && enemyInActionRange && (selectedCombatAction.id !== 'first-aid' || enemyKnockedOut))
    const targetRangeFeet = combatMode === 'magic' ? selectedSpellRange : combatMode === 'action' ? selectedActionRange : selectedItem?.combat?.kind === 'thrown-area' ? normalRangeFeet : attackRangeFeet
    const acceptedTarget = combatMode === 'magic'
      ? selectedSpell?.target === 'ally' ? 'ally' : selectedSpell?.target === 'enemy' ? 'enemy' : 'creature'
      : combatMode === 'action'
        ? selectedCombatAction?.target === 'ally' ? 'ally' : selectedCombatAction?.target === 'enemy' ? 'enemy' : 'creature'
        : 'enemy'
    const targetEconomyReady = combatMode === 'magic' ? spellEconomyReady : combatMode === 'action' ? selectedActionEconomyReady : weaponAttackReady
    const targetUnavailableReason = combatMode === 'magic' ? selectedSpellComponentAvailability.reason : null
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
          : combatMode === 'action' && selectedCombatAction && !selectedActionTargetGuard.allowed
            ? selectedActionTargetGuard.reason
            : null
    const enemyTargetCheck = enemy ? evaluateCombatTarget({
      selected: Boolean((combatActive || longstriderTargeting) && selected), economyReady: targetEconomyReady,
      unavailableReason: targetUnavailableReason,
      targetAlive: enemy.alive, targetTeam: 'enemy', acceptedTarget,
      distanceFeet: attackDistanceFeet, rangeFeet: targetRangeFeet,
      clearTrajectory: !longstriderTargeting && targetRangeFeet <= CELL_FEET || clearTrajectory,
      equipmentReady: targetEquipmentReady, resourceReady: targetResourceReady,
      specialBlockReason: targetSpecialBlock,
    }) : null
    const cellKey = cell.x + ',' + cell.y
    const doorHotspots = doorHotspotsByCell.get(cellKey) ?? []
    /* Добыча в этой клетке. Метка живёт обычным узлом клетки — там же, где
       фишки и след, — а не в холсте `board-render.ts`: у неё кнопка, подсказка
       и фокус клавиатуры, и всё это на холсте пришлось бы заводить заново. */
    const lootHere = lootByCell.get(cellKey)
    const lootGhostHere = vanishedLootByCell.get(cellKey)
    /* Павший рисуется затемнённой фишкой ровно столько, сколько с него есть что
       снять: пока цел контейнер и ещё несколько секунд, пока метка гаснет.
       Дальше тело уходит вместе с меткой — иначе поле боя навсегда зарастало бы
       фишками, по которым уже нечего делать. Живой в клетке отменяет фишку
       вовсе: два токена на одной клетке читались бы как двое. */
    const fallenEnemy = (lootHere || lootGhostHere) && !player && !enemy && !summon && !sceneNpc
      ? state.enemies?.find((item) => item.x === cell.x && item.y === cell.y && !item.alive)
      : undefined
    const sceneObject = sceneObjectByCell.get(cellKey)
    /* Тултип лестницы (`docs/multilevel-map-plan.md`, 7.4). Кнопка перехода
       появляется только у подошедшего вплотную персонажа, а «куда ведёт эта
       лестница» игрок спрашивает раньше — наведением с другого конца зала. */
    const sceneObjectHint = [sceneObject ? `Выбрать: ${sceneObjectLabel(sceneObject)}${sceneObjectOpen(sceneObject) ? ' · открыто' : ''}` : '',
      levelTransitionHint(sceneObject?.transition, knownSceneLevels) ?? ''].filter(Boolean).join(' · ')
    const canMoveHere = reachable.has(cellKey)
    const route = movementPaths.get(cellKey)
    const moveReason = movement.blockedReason ?? (active ? movementCellReason(state, active, cell, movementLimit, movementPaths) : null)
    const opportunityRisk = Boolean(canMoveHere && opportunityThreats.some((threat) => actorDistanceFeet(threat, cell) > CELL_FEET))
    const canThrowHere = Boolean(combatActive && selected && combatMode === 'weapon' && actionReady && selectedItem?.combat?.kind === 'thrown-area' && active && actorDistanceFeet(active, cell) <= normalRangeFeet && hasClearBoardTrajectory(state, active, cell) && cell.revealed && cell.type !== 'wall')
    const actorIsAnchor = Boolean(actorAtCell && actorAtCell.x === cell.x && actorAtCell.y === cell.y)
    const actorLayout = actorAtCell ? actorLayoutById.get(actorAtCell.id) ?? null : null
    const actorHasFullArea = Boolean(actorAtCell && fullActorIds.has(actorAtCell.id) && actorLayout && actorLayout.width > 1)
    const actorTokenStyle = actorHasFullArea && actorLayout
      ? {
          '--actor-footprint-width': actorLayout.width,
          '--actor-footprint-height': actorLayout.height,
          '--actor-footprint-center-x': actorLayout.width / 2,
          '--actor-footprint-center-y': actorLayout.height / 2,
        } as React.CSSProperties
      : undefined
    // Подпись врага висит под фишкой и видна, пока его можно выбрать целью.
    // Фишка ниже рисуется позже и закрыла бы её: подпись живёт внутри своей
    // фишки и выше её слоя не поднимется. Поэтому, если под врагом или
    // наискосок под ним кто-то стоит, подпись встаёт над фишкой — верхний ряд
    // рисуется раньше. В верхнем ряду доски подпись остаётся снизу.
    const enemyNameplateAbove = Boolean(enemy && actorIsAnchor && actorAtCell && (() => {
      const cells = actorHasFullArea && actorLayout ? actorLayout.cells : [{ x: cell.x, y: cell.y }]
      const top = Math.min(...cells.map((point) => point.y))
      const bottom = Math.max(...cells.map((point) => point.y))
      const left = Math.min(...cells.map((point) => point.x))
      const right = Math.max(...cells.map((point) => point.x))
      if (top <= 0) return false
      for (let x = left - 1; x <= right + 1; x += 1) {
        const below = actorByCell.get(boardPositionKey(x, bottom + 1))
        if (below && below.id !== actorAtCell.id) return true
      }
      return false
    })())
    const occupied = Boolean(actorAtCell || player || enemy || summon || sceneNpc)
    const commandRangeVisible = Boolean(selected && targetRangeFeet > 0 && (combatActive || spellEconomyReady))
    const cellInCommandRange = Boolean(commandRangeVisible && active && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && actorDistanceFeet(active, cell) <= targetRangeFeet && (targetRangeFeet <= CELL_FEET || hasClearBoardTrajectory(state, active, cell)))
    const moveUnavailable = Boolean(selected && movementAvailable && active && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && !occupied && !canMoveHere && moveReason)
    const canPointSpellHere = Boolean(selected && combatMode === 'magic' && selectedSpell?.target === 'point' && spellEconomyReady && (!selectTargetsInAreaSpell || !areaSpellPoint) && active && actorDistanceFeet(active, cell) <= selectedSpellRange && clearPointSpellLineOfEffect(cell) && cell.revealed && (cell.type === 'floor' || cell.type === 'door') && (!['summon', 'teleport'].includes(selectedSpellKind ?? '') || !occupied))
    const canSummonHere = Boolean(canPointSpellHere && selectedSpellKind === 'summon')
    const canAimHere = canThrowHere || canPointSpellHere
    const canPreviewSpellHere = Boolean(spellAreaPreviewSelected && cell.revealed && (cell.type === 'floor' || cell.type === 'door'))
    const actorTargetDistance = actorAtCell && active
      ? actorDistanceFeet(active, actorAtCell)
      : Number.POSITIVE_INFINITY
    const areaTargetInBlast = Boolean(areaTargetSelectionActive && actorAtCell && spellAffectedIds.has(actorAtCell.id))
    const chainSecondaryTargetAllowed = Boolean(
      actorAtCell && selectedSpell?.id === 'chain-lightning' && selectedSpellPrimary
      && actorAtCell.id !== selectedSpellPrimary.id
      && actorDistanceFeet(selectedSpellPrimary, actorAtCell) <= selectedSpellTargetSeparationFeet
      && hasClearBoardTrajectory(state, selectedSpellPrimary, actorAtCell),
    )
    // Дальше пяти футов сервер требует чистую траекторию для любого заклинания
    // на существо (проверка цели CastSpell). Без неё «Лечащее слово» сквозь
    // стену подсвечивалось допустимой целью, а отказ приходил уже с сервера
    // (плейтест 2026-10-03).
    const canHealActorHere = Boolean(
      actorAtCell
      && (actorAtCell.kind === 'hero' || actorAtCell.kind === 'summon' || areaTargetSelectionActive || longstriderTargeting && actorAtCell.kind === 'neutral')
      && selected
      && combatMode === 'magic'
      && selectedSpell
      && (['ally', 'creature'].includes(selectedSpell.target) || areaTargetSelectionActive)
      && spellEconomyReady
      && (areaTargetSelectionActive
        ? areaTargetInBlast
        : (chainSecondaryTargetAllowed || (actorTargetDistance <= CELL_FEET && !longstriderTargeting || Boolean(active && hasClearBoardTrajectory(state, active, actorAtCell))) && actorTargetDistance <= selectedSpellRange)),
    )
    const multiTargetSelected = Boolean(multiTargetSpell && actorAtCell && selectedSpellTargetSet.has(actorAtCell.id))
    const multiTargetSeparationReason = actorAtCell ? spellTargetSeparationReason(actorAtCell) : null
    const multiTargetSelectable = Boolean(
      multiTargetSpell
      && actorAtCell
      && (canSpellTargetEnemy || canHealActorHere || multiTargetSelected)
      && (multiTargetSelected || !spellTargetSelectionFull)
      && (multiTargetSelected || !multiTargetSeparationReason),
    )
    const sceneNpcTargetCheck = sceneNpc && longstriderTargeting ? evaluateCombatTarget({
      selected: Boolean(selected), economyReady: spellEconomyReady,
      unavailableReason: targetUnavailableReason, targetAlive: sceneNpc.alive,
      targetTeam: 'ally', acceptedTarget: 'creature',
      distanceFeet: actorTargetDistance, rangeFeet: selectedSpellRange,
      clearTrajectory: Boolean(active && hasClearBoardTrajectory(state, active, sceneNpc)),
      resourceReady: spellSlotReady,
    }) : null
    const areaTargetReason = areaTargetSelectionActive && actorAtCell && !areaTargetInBlast ? 'Существо вне сферы 30 футов'
      : null
    const sceneNpcTargetReason = multiTargetSelected ? 'Цель выбрана · клик уберёт её'
      : areaTargetReason ?? multiTargetSeparationReason ?? (spellTargetSelectionFull ? `Выбрано максимальное число целей: ${spellTargetLimit}` : sceneNpcTargetCheck?.reason ?? 'Допустимая цель')
    const canAidActorHere = Boolean(
      actorAtCell
      && (actorAtCell.kind === 'hero' || actorAtCell.kind === 'summon')
      && combatActive
      && selected
      && combatMode === 'action'
      && selectedCombatAction
      && ['ally', 'creature'].includes(selectedCombatAction.target)
      && selectedActionEconomyReady
      && actorAtCell.id !== selected
      && actorTargetDistance <= selectedCombatAction.range,
    )
    const actorCanActivate = Boolean(actorAtCell && (canAimHere || canActionTargetEnemy || canSpellTargetEnemy || canWeaponTargetEnemy || canHealActorHere || canAidActorHere || multiTargetSelectable))
    const inBlastArea = Boolean(cell.revealed && previewBlastKeys.has(cellKey))
    const inPersistentSpellArea = Boolean(cell.revealed && (state.mechanics?.active_effects ?? []).some((effect) => pointInAreaEffect(effect, cell)))
    // У объекта собственная hotspot-зона в соседнем слое поверх клетки. Клетка
    // маршрута и предмет поэтому остаются двумя отдельными элементами, и оба
    // доступны мышью и клавиатурой.
    const cellIsInteractive = Boolean((((canMoveHere && !spellAiming) || canAimHere) && !occupied) || (!actorIsAnchor && actorCanActivate))
    const cellFeedback = visibleMapFeedback.filter((item) => item.x === cell.x && item.y === cell.y)
    const cellLabel = actorAtCell && !actorIsAnchor && actorCanActivate
      ? `Выбрать ${actorAtCell.label}`
      : canPointSpellHere
      ? `Наложить ${selectedSpell?.name} в клетку ${cell.x}, ${cell.y}`
      : canThrowHere
        ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку ${cell.x}, ${cell.y}`
        : pointSpellSelected ? 'Недоступная точка заклинания'
        : canMoveHere
          ? `Маршрут для ${activeName}: ${route?.costFeet ?? 0} футов${opportunityRisk ? '. Это спровоцирует атаку по возможности' : ''}`
          : sceneObject
            ? sceneObjectHint
            : moveReason ?? undefined
    const enemyKind = enemy ? enemyVisualKind(enemy) : null
    const enemyHealth = enemy ? enemyHealthPresentation(enemy) : null
    const enemyCommandAllowed = Boolean(canWeaponTargetEnemy || canSpellTargetEnemy || canActionTargetEnemy || canThrowHere || canPointSpellHere || multiTargetSelectable)
    const enemyTargetReason = multiTargetSpell && enemy
      ? multiTargetSelected
        ? 'Цель выбрана · клик уберёт её'
        : multiTargetSeparationReason ?? (spellTargetSelectionFull ? `Выбрано максимальное число целей: ${spellTargetLimit}` : (canSpellTargetEnemy ? 'Клик добавит цель' : 'Выбранная команда не подходит для этой цели'))
      : enemyCommandAllowed
      ? enemyForecast?.cover_bonus
        ? `Допустимая цель · ${enemyForecast.cover_label ?? 'укрытие'} +${enemyForecast.cover_bonus} к КД`
        : attackDistanceFeet > normalRangeFeet && combatMode === 'weapon' ? 'Допустимая цель · дальний диапазон с помехой' : 'Допустимая цель'
      : trajectoryBlockReason ?? enemyTargetCheck?.reason ?? 'Выбранная команда не подходит для этой цели'
    const enemyConditions = enemy ? (state.mechanics?.conditions?.[enemy.id] ?? []).map(conditionPresentation) : []
    const enemyHighGround = enemyForecast?.advantage_sources.includes('позиция выше цели')
      ? 'higher'
      : enemyForecast?.disadvantage_sources.includes('позиция ниже цели') ? 'lower' : null

    // Область команды накрывает почти всю карту, поэтому рисуется на холсте: в
    // разметке это был бы узел на каждую клетку.
    if (commandRangeVisible && cell.revealed && !spellAreaPreviewSelected) boardOverlay.push({ x: cell.x, y: cell.y, kind: cellInCommandRange ? 'command-range' : 'command-out-of-range' })
    /* «Сюда не дойти» — признак клетки, а не слой карты. Раньше на каждую такую
       клетку уходил красноватый × на холст, и вся карта покрывалась ковром
       крестов: достижимого пятачка вокруг героя это не касалось, зато поле боя
       за ним читать становилось нечем. Метку рисует доска и ровно на той
       клетке, где сейчас курсор (`src/TacticalBoard.tsx`), а причина — та же
       `moveReason`, что и в подсказке. */
    const moveBlockedHere = moveUnavailable && !canAimHere && !cellInCommandRange

    const stateClasses = [
      canMoveHere && !canAimHere && previewMoveKey === cellKey ? 'move-target' : '',
      opportunityRisk && !canAimHere ? 'opportunity-risk' : '',
      canAimHere ? 'aim-target' : '',
      canSummonHere ? 'summon-target' : '',
      inPersistentSpellArea ? 'spell-terrain' : '',
      inBlastArea ? 'blast-area' : '',
      spellAreaPreviewSelected && (canAimHere || inBlastArea) ? 'spell-preview-cell' : '',
      spellAreaPreviewSelected && actorAtCell && spellAffectedIds.has(actorAtCell.id) ? `spell-affected-${actorAtCell.kind === 'hero' || actorAtCell.kind === 'summon' ? 'ally' : actorAtCell.kind}` : '',
      multiTargetSelectable && !multiTargetSelected ? 'spell-target-candidate' : '',
      multiTargetSelected ? 'spell-target-selected' : '',
      pendingPoint?.x === cell.x && pendingPoint?.y === cell.y ? 'command-center' : '',
      sceneObject ? 'scene-object-target' : '',
      sceneObjectOpen(sceneObject) ? 'scene-object-open' : '',
      sceneObject?.id === selectedSceneObjectId ? 'scene-object-selected' : '',
      // Подсветка добычи закрыта туманом наравне с самой меткой (`hasLootLayer`)
      // и остальными украшениями клетки: `.board-cell.loot-here` рисуется поверх
      // тумана, и без этой проверки нераскрытый угол зала светился бы рамкой
      // ровно там, где лежит невзятое тело.
      cell.revealed && lootHere ? 'loot-here' : '',
      cell.revealed && lootHere && focusedLootId === lootHere.id ? 'loot-focused' : '',
      occupied ? actorAtCell?.kind === 'hero' ? 'occupied-by-hero' : actorAtCell?.kind === 'summon' ? 'occupied-by-summon' : actorAtCell?.kind === 'neutral' ? 'occupied-by-neutral' : 'occupied-by-enemy' : '',
      actorHasFullArea && actorIsAnchor ? 'actor-footprint-anchor' : '',
    ].filter(Boolean)
    const cellTitle = canPreviewSpellHere && !canPointSpellHere
      ? active && actorDistanceFeet(active, cell) > selectedSpellRange ? 'Вне дальности заклинания' : active ? actorTrajectoryBlockReason(state, active, cell) ?? 'Клетка недоступна для заклинания' : undefined
      : opportunityRisk && !canAimHere
      ? 'Опасная клетка: выход из ближнего боя вызовет атаку по возможности'
      : moveUnavailable ? moveReason ?? undefined : undefined
    // Метка добычи и павший — такой же повод завести узел клетки, как фишка:
    // без этой ветки тело в пустом углу зала не рисовалось бы вовсе.
    const hasLootLayer = Boolean(cell.revealed && (lootHere || lootGhostHere))
    if (!stateClasses.length && !cellFeedback.length && !cellIsInteractive && !hasLootLayer && !doorHotspots.length) {
      if (cellTitle || cellLabel || moveBlockedHere) boardHints.set(cellKey, { title: cellTitle, ariaLabel: cellLabel, blocked: moveBlockedHere })
      continue
    }

    const doorHotspot = doorHotspots.length > 0
      ? <>{doorHotspots.map((door) => {
          const direction = active ? doorDirectionFromActor(door, active) : ''
          const locked = door.state === 'locked'
          const label = locked
            ? `Запертая дверь на ${direction}. Выберите отмычку или выломать в панели действий`
            : `${door.state === 'open' ? 'Закрыть' : 'Открыть'} дверь на ${direction}`
          return <button
            key={door.id}
            type="button"
            className={`door-hotspot door-hotspot--${door.dir} door-hotspot--${door.state}`}
            data-door-id={door.id}
            aria-label={label}
            title={locked ? `${label}. Щелчок не ломает дверь автоматически` : `${label}: свободное взаимодействие`}
            disabled={!canAct || tacticalBusy}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerEnter={() => setHoveredDoorId(door.id)}
            onPointerLeave={() => setHoveredDoorId((current) => current === door.id ? null : current)}
            onFocus={() => setHoveredDoorId(door.id)}
            onBlur={() => setHoveredDoorId((current) => current === door.id ? null : current)}
            onClick={(event) => {
              event.stopPropagation()
              if (locked || !selected) return
              void onOperateDoor(selected, door.id, door.state === 'open' ? 'close' : 'open')
            }}
          />
        })}</>
      : undefined
    const sceneObjectMenuOpen = Boolean(
      sceneObject
      && sceneObject.id === selectedSceneObjectId
      && sceneObjectAnchorById.get(sceneObject.id) === cellKey,
    )
    const sceneObjectMenu = sceneObjectMenuOpen && sceneObject
      ? <div
          className="scene-object-menu"
          role="group"
          aria-label={`Действия: ${sceneObjectLabel(sceneObject)}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <header>
            <span><b>{sceneObjectLabel(sceneObject)}</b><small>{selectedSceneObjectAtHand ? 'Выберите действие' : 'Подойдите к объекту на соседнюю клетку'}</small></span>
            <button type="button" className="scene-object-menu-close" aria-label="Закрыть действия объекта" onClick={() => setSelectedSceneObjectId(null)}><X size={13} /></button>
          </header>
          {sceneObjectVerbs(sceneObject).map((intent) => {
            const label = SCENE_OBJECT_VERB_LABELS[intent]
            const unavailable = !selectedSceneObjectAtHand
            const disabled = !canAct || tacticalBusy || unavailable
              || (intent === 'pray' && (blessingHeld || !blessingAvailable || combatActive))
              || (intent === 'lockpick' && !lockpickAllowed)
            const title = unavailable
              ? 'Подойдите к объекту на соседнюю клетку'
              : intent === 'pray'
                ? (combatActive ? 'Посреди боя благословений не раздают' : blessingPrayerHint)
                : intent === 'lockpick'
                  ? (lockpickAllowed
                      ? 'Вскрыть замок отмычкой: Ловкость и владение воровскими инструментами. Тратит действие в бою. Замка может и не быть — тогда сервер откажет, и ход не пропадёт'
                      : lockpickBlockedHint)
                  : `${label}: ${sceneObjectLabel(sceneObject)}`
            return <button
              type="button"
              key={`${sceneObject.id}:${intent}`}
              className={`scene-object-menu-action intent-${intent}`}
              disabled={disabled}
              title={title}
              onClick={() => {
                if (!selected || disabled) return
                void onOperateSceneObject(selected, sceneObject.id, intent).then((outcome) => {
                  if (outcome.ok) setSelectedSceneObjectId(null)
                })
              }}
            >
              <CombatIcon id={`scene-object-${intent}`} kind={intent === 'take' ? 'item' : intent === 'inspect' ? 'spellbook' : 'action'} hint={intent === 'pray' ? `${label} святыня prayer divine` : `${label} объект сцены`} size={18} compact />
              <span>{label}</span>
            </button>
          })}
          {selectedSceneObject?.transition && <small className="scene-object-menu-lead">
            {levelTransitionHint(selectedSceneObject.transition, knownSceneLevels)}
          </small>}
          {selectedLevelTransition && <button
            type="button"
            className={`scene-object-menu-action level-transition ${selectedLevelTransition.direction}`}
            disabled={!canAct || tacticalBusy || selectedLevelTransition.disabled}
            onClick={() => {
              if (!selected || selectedLevelTransition.disabled) return
              void onUseLevelTransition(selected, sceneObject.id).then((outcome) => {
                if (outcome.ok) setSelectedSceneObjectId(null)
              })
            }}
            title={selectedLevelTransition.title}
          >
            <CombatIcon id={`level-transition-${selectedLevelTransition.direction}`} kind="swap" hint={`${selectedLevelTransition.direction === 'up' ? 'подняться' : 'спуститься'} лестница этаж`} size={18} compact />
            <span>{selectedLevelTransition.label}</span>
          </button>}
          {sceneObjectVerbs(sceneObject).length === 0 && !selectedLevelTransition && <span className="scene-object-menu-empty">Сервер не открыл доступных действий</span>}
        </div>
      : null

    boardCells.push({
      x: cell.x,
      y: cell.y,
      className: stateClasses.join(' '),
      interactive: cellIsInteractive,
      ariaLabel: cellLabel,
      title: cellTitle,
      blocked: moveBlockedHere,
      onPointerEnter: () => {
        if (sceneObject) setHoveredSceneObjectId(sceneObject.id)
        if ((canAimHere || canPreviewSpellHere) && !areaTargetSelectionActive) setAimCell({ x: cell.x, y: cell.y })
        else if (canMoveHere) setHoveredMoveKey(cellKey)
      },
      onPointerLeave: () => {
        if (sceneObject) setHoveredSceneObjectId((current) => current === sceneObject.id ? null : current)
        if ((canAimHere || canPreviewSpellHere) && !pendingCommand && !areaTargetSelectionActive) setAimCell(null)
        if (hoveredMoveKey === cellKey) setHoveredMoveKey(null)
      },
      onActivate: () => {
        if (actorAtCell && !actorIsAnchor) {
          if (!selected || !actorCanActivate) return
          if (pointSpellSelected && !areaTargetSelectionActive) { if (canPointSpellHere) castAtCell(cell.x, cell.y); return }
          else if (canThrowHere) chooseArea(cell.x, cell.y)
          else if (multiTargetSpell && multiTargetSelectable) toggleSpellTarget(actorAtCell.id, multiTargetSelectable)
          else if (enemy && canActionTargetEnemy) useActionAtTarget(enemy.id)
          else if (enemy && canSpellTargetEnemy) castAtTarget(enemy.id)
          else if (enemy && canWeaponTargetEnemy) chooseTarget(enemy.id)
          else if (canAidActorHere) useActionAtTarget(actorAtCell.id)
          else if (canHealActorHere) castAtTarget(actorAtCell.id)
          return
        }
        if (!selected || (!canMoveHere && !canAimHere) || (spellAiming && !canPointSpellHere)) return
        if (pointSpellSelected && !areaTargetSelectionActive && canPointSpellHere) castAtCell(cell.x, cell.y)
        else if (canThrowHere) chooseArea(cell.x, cell.y)
        else if (!combatActive || pendingMoveKey === cellKey) {
          void onMove(selected, cell.x, cell.y).then((outcome) => {
            if (outcome.ok) setPendingMoveKey(null)
          })
        }
        else setPendingMoveKey(cellKey)
      },
      hotspot: !pointSpellSelected && (doorHotspot || sceneObject) ? <>
        {doorHotspot}
        {sceneObject ? <span
          role="button"
          tabIndex={0}
          className="scene-object-hotspot"
          data-selected={sceneObject.id === selectedSceneObjectId ? 'true' : undefined}
          data-state={sceneObject.state || undefined}
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
            onPropActivate(sceneObject.id)
          }}
          onClick={(event) => {
            event.stopPropagation()
            onPropActivate(sceneObject.id)
          }}
        /> : null}
        {sceneObjectMenu}
      </> : undefined,
      children: <>
        {/* След на клетке: лежит в плоскости доски, поэтому при любом повороте и
            наклоне точно совпадает с сеткой. Фигурка стоит стоймя и из-за этого
            перспективно смещается — позиционную правду несёт именно этот след. */}
        {occupied && cell.revealed && <span className="cell-footprint" aria-hidden="true" />}
        {hasLootLayer && <LootCellMarker
          container={lootHere}
          ghost={lootGhostHere}
          fallen={fallenEnemy ? { name: fallenEnemy.name, image: fallenEnemy.image } : undefined}
          selected={Boolean(lootHere && focusedLootId === lootHere.id)}
          onSelect={(containerId) => setFocusedLootId((current) => current === containerId ? null : containerId)}
        />}
        {/* Точное здоровье остаётся полоской с числами только после раскрытия.
            До раскрытия используется предельно скупое кольцо качественной
            ступени: без цифр и текста, чтобы не вернуть перегрузку фишек,
            из-за которой здоровье убрали в PR #7. */}
        {enemy && cell.revealed && actorIsAnchor && enemyHealth && !enemyHealth.exact && enemyHealth.status !== 'unharmed' && (
          <span className="enemy-health-ring" data-status={enemyHealth.status} aria-hidden="true" />
        )}
        {enemy && cell.revealed && actorIsAnchor && enemyHealth?.exact && <TokenHealthBar fill={enemyHealth.fill} label={enemyHealth.barLabel} className={`enemy-health ${enemyHealth.status}`} />}
        {enemy && cell.revealed && actorIsAnchor && (enemyForecast?.cover_bonus || enemyHighGround || trajectoryBlockReason) && (
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
        {actorHasFullArea && actorIsAnchor && <span className="actor-footprint-area" style={actorTokenStyle} aria-hidden="true" />}
        {enemy && cell.revealed && actorIsAnchor && (
          <button
            className={`enemy-token ${actorHasFullArea ? 'large-actor' : ''}${enemyNameplateAbove ? ' nameplate-above' : ''} ${focusedParticipantId === enemy.id ? 'initiative-focus' : ''} ${linkedParticipantIds.includes(enemy.id) ? 'journal-linked' : ''} ${enemy.id === turnActorId ? 'active-turn' : ''} ${enemyCommandAllowed ? 'targetable' : combatActive ? 'unavailable-target' : ''} ${pendingTargetId === enemy.id ? 'command-selected' : ''} ${multiTargetSelected ? 'multi-target-selected' : ''}`}
            data-actor-id={enemy.id}
            data-enemy-kind={enemyKind}
            data-footprint-size={actorHasFullArea ? actorLayout?.size : undefined}
            style={actorTokenStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={(event) => { setLinkedParticipantIds([enemy.id]); setInspectedAnchor(tokenAnchor(event.currentTarget)); if (!areaTargetSelectionActive) setAimCell({ x: enemy.x, y: enemy.y }); setInspectedTarget({ id: enemy.id, name: enemy.name, team: 'enemy', ...(enemyHealth?.exact ? { hp: enemy.hp, maxHp: enemy.maxHp } : { healthLabel: enemyHealth?.label }), distanceFeet: attackDistanceFeet, allowed: enemyCommandAllowed, reason: enemyTargetReason }) }}
            onMouseLeave={() => { setLinkedParticipantIds([]); if (!pendingCommand) { if (!areaTargetSelectionActive) setAimCell(null); setInspectedTarget(null); setInspectedAnchor(null) } }}
            onFocus={(event) => { setLinkedParticipantIds([enemy.id]); setInspectedAnchor(tokenAnchor(event.currentTarget)); setInspectedTarget({ id: enemy.id, name: enemy.name, team: 'enemy', ...(enemyHealth?.exact ? { hp: enemy.hp, maxHp: enemy.maxHp } : { healthLabel: enemyHealth?.label }), distanceFeet: attackDistanceFeet, allowed: enemyCommandAllowed, reason: enemyTargetReason }) }}
            onBlur={() => { setLinkedParticipantIds([]); if (!pendingCommand) { setInspectedTarget(null); setInspectedAnchor(null) } }}
            onKeyDown={(event) => { if (multiTargetSpell && !pendingCommand && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); confirmSpellTargetSelection() } }}
            onClick={(event) => { event.stopPropagation(); if (multiTargetSpell && multiTargetSelectable) toggleSpellTarget(enemy.id, multiTargetSelectable); else if (canPointSpellHere) castAtCell(cell.x, cell.y); else if (canThrowHere) chooseArea(cell.x, cell.y); else if (canActionTargetEnemy) useActionAtTarget(enemy.id); else if (canSpellTargetEnemy) castAtTarget(enemy.id); else if (canWeaponTargetEnemy) chooseTarget(enemy.id) }}
            aria-disabled={tacticalBusy || !enemyCommandAllowed}
            aria-label={canPointSpellHere ? `Наложить ${selectedSpell?.name} в клетку с ${enemy.name}` : canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${enemy.name}` : `${canActionTargetEnemy ? `Использовать ${selectedCombatAction?.name} на` : canSpellTargetEnemy ? 'Наложить заклинание на' : 'Атаковать'} ${enemy.name}. Состояние: ${enemyHealth?.label}`}
            title={enemyTargetReason}
          >
            <span className="enemy-emblem">{enemy.image ? <img src={enemy.image} alt="" /> : <EnemyGlyph kind={enemyKind ?? 'raider'} />}</span>
            <span className="enemy-nameplate">{enemy.name}</span>
            {enemyHealth?.exact && <small className="enemy-health-value">{enemyHealth.label}</small>}
            <TokenConditionIcons conditions={enemyConditions} />
          </button>
        )}
        {sceneNpc && cell.revealed && actorIsAnchor && <>
          {actorHasFullArea && <span className="actor-footprint-area" style={actorTokenStyle} aria-hidden="true" />}
          <button
            type="button"
            className={`map-token neutral-token ${actorHasFullArea ? 'large-actor' : ''} stance-${sceneNpcStance} ${sceneNpc.alive ? '' : 'dead'} ${openTokenLabelId === sceneNpcMenuId ? 'label-open' : ''} ${canHealActorHere || multiTargetSelectable ? 'targetable healing-target' : ''} ${multiTargetSelected ? 'multi-target-selected' : ''}`}
            data-actor-id={sceneNpc.id}
            data-token-role="neutral"
            data-footprint-size={actorHasFullArea ? actorLayout?.size : undefined}
            style={actorTokenStyle}
            aria-expanded={openTokenLabelId === sceneNpcMenuId}
            aria-label={canPointSpellHere ? `Наложить ${selectedSpell?.name} в клетку с ${sceneNpc.name}` : (longstriderTargeting || areaTargetSelectionActive) ? `Наложить ${selectedSpell?.name} на ${sceneNpc.name}` : `${sceneNpc.name}, ${sceneNpc.role || 'персонаж'}. Отношение: ${NPC_STANCE_LABELS[sceneNpcStance]}`}
            aria-disabled={(longstriderTargeting || areaTargetSelectionActive) ? tacticalBusy || !(multiTargetSpell ? multiTargetSelectable : canHealActorHere) : undefined}
            title={(longstriderTargeting || areaTargetSelectionActive) ? sceneNpcTargetReason : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if ((longstriderTargeting || areaTargetSelectionActive) && multiTargetSpell && !pendingCommand && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); confirmSpellTargetSelection() } }}
            onClick={(event) => {
              event.stopPropagation()
              if (pointSpellSelected && !areaTargetSelectionActive) { if (canPointSpellHere) castAtCell(cell.x, cell.y); return }
              if (longstriderTargeting || areaTargetSelectionActive) {
                if (multiTargetSpell && multiTargetSelectable) toggleSpellTarget(sceneNpc.id, multiTargetSelectable)
                else if (!multiTargetSpell && canHealActorHere) castAtTarget(sceneNpc.id)
                return
              }
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
              disabled={combatActive || !sceneNpc.alive || !sceneNpc.can_start_combat || narrating || tacticalBusy || !canAct}
              title={combatActive
                ? 'Бой уже идёт'
                : !sceneNpc.alive
                  ? 'Этот персонаж уже выбыл'
                  : !sceneNpc.can_start_combat
                    ? 'Бой с этим NPC пока недоступен: нет готового серверного профиля'
                  : narrating
                    ? 'Дождитесь ответа Рассказчика'
                    : tacticalBusy
                      ? 'Дождитесь завершения текущего действия'
                      : !canAct
                        ? 'Сейчас этот герой не может действовать'
                        : `Начать бой с ${sceneNpc.name}. Инициатива определится случайно`}
              onClick={() => { setOpenTokenLabelId(null); void onNpcAttack(sceneNpc.id) }}
            ><Swords size={13} />Напасть</button>
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
            {/* Обчистить карманы. Кнопка идёт тем же каналом свободной фразы,
                что и «Заговорить»: сервер разбирает её в команду `PickpocketNpc`
                (`resolvePickpocket`, `server/free-action-adjudication.mjs`), и у
                кнопки с фразой получается один путь, а не два расходящихся.
                Своих условий доска не выдумывает — все отказы у движка, — но
                молчать о заведомо невозможном тоже нельзя: подсказка называет
                причину до нажатия. */}
            <button
              type="button"
              disabled={combatActive || !sceneNpc.alive || narrating || tacticalBusy || !canAct}
              title={combatActive
                ? 'Посреди боя карманов не чистят'
                : !sceneNpc.alive
                  ? 'Карманы живых'
                  : narrating
                    ? 'Дождитесь ответа Рассказчика'
                    : tacticalBusy
                      ? 'Дождитесь завершения текущего действия'
                      : !canAct
                        ? 'Сейчас этот герой не может действовать'
                        : 'Ловкость рук против чужого внимания. Заметят — будет скандал, и его запомнят'}
              onClick={() => { void onNpcAction(`Незаметно обчищаю карманы: ${sceneNpc.name}`, sceneNpc.id) }}
            ><Coins size={13} />Обчистить карманы</button>
            {/* Подкрепить слова монетой. Три ступени щедрости шлют ту же
                свободную фразу, что игрок мог бы сказать сам, — сервер читает
                ступень из неё и сам же считает сумму от кошелька героя
                (`classifyBribeTier`, `server/npc-social-check.mjs`). Своих
                чисел доска не держит намеренно: две копии правила разошлись бы
                при первой правке долей, и подпись обещала бы не ту цену. */}
            {(['монету', 'кошель', 'щедро'] as const).map((tier) => <button
              key={tier}
              type="button"
              disabled={combatActive || !sceneNpc.alive || narrating || tacticalBusy || !canAct}
              title={combatActive
                ? 'Посреди боя не торгуются'
                : narrating
                  ? 'Дождитесь ответа Рассказчика'
                  : tacticalBusy
                    ? 'Дождитесь завершения текущего действия'
                    : !canAct
                      ? 'Сейчас этот герой не может действовать'
                      : `Убеждение станет легче. Сумму отсчитает сервер от вашего кошелька; если этот человек не берёт денег — станет только хуже, и это запомнят`}
              onClick={() => { void onNpcAction(`Убеждаю и подкрепляю слова: ${tier}`, sceneNpc.id) }}
            ><Coins size={13} />Подкрепить: {tier}</button>)}
            {sceneNpcMerchant
              ? <button
                  type="button"
                  disabled={!canAct || narrating || tacticalBusy || dialogueBusy}
                  title={!canAct ? 'Сейчас этот герой не может торговать' : narrating || tacticalBusy || dialogueBusy ? 'Дождитесь завершения текущего действия' : `Торговать с ${sceneNpc.name}`}
                  onClick={() => onOpenMerchant(sceneNpc.id)}
                ><Store size={13} />Торговать</button>
              : null}
            {/* Треба у служителя. Кто служитель, решает сервер по роли профиля
                (`blessingPriestsFor`, `server/blessings.mjs`): своего списка
                ролей у доски нет, иначе кнопка появлялась бы там, где движок её
                не принимает. */}
            {blessingPriests.some((priest) => priest.id === sceneNpc.id)
              ? <button
                  type="button"
                  disabled={combatActive || !sceneNpc.alive || narrating || tacticalBusy || !canAct || blessingHeld || !blessingAvailable || activeHeroPurseCp < blessingDonationCp}
                  title={combatActive
                    ? 'Посреди боя благословений не раздают'
                    : !sceneNpc.alive
                      ? 'Служитель сейчас недоступен'
                      : !blessingAvailable
                        ? blessingSpentHint
                        : blessingHeld
                          ? blessingHeldHint
                          : activeHeroPurseCp < blessingDonationCp
                            ? `На пожертвование нужно ${blessingDonationCp} мм`
                            : `Пожертвовать ${blessingDonationCp} мм и получить малое благословение (+${Number(blessings?.attack_bonus) || 1} к первой атаке) без броска`}
                  onClick={() => { void onReceiveNpcBlessing(sceneNpc.id) }}
                ><HandHeart size={13} />Благословение ({blessingDonationCp} мм)</button>
              : null}
          </div>}
        </>}
        {player && cell.revealed && actorIsAnchor && (() => {
          const healingDistance = active ? actorDistanceFeet(active, player) : Number.POSITIVE_INFINITY
          // `combatActive` здесь больше нет: вне боя мирное заклинание на союзника
          // разрешено, и решает это `spellEconomyReady`, повторяющий правило движка.
          const playerInBlast = Boolean(areaTargetSelectionActive && spellAffectedIds.has(player.id))
          const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && (['ally', 'creature'].includes(selectedSpell.target) || areaTargetSelectionActive) && spellEconomyReady && (areaTargetSelectionActive ? playerInBlast : healingDistance <= selectedSpellRange && (healingDistance <= CELL_FEET && !longstriderTargeting || Boolean(active && hasClearBoardTrajectory(state, active, player)))))
          const playerKnockedOut = state.mechanics?.resting?.[player.id]?.reason === 'knockout'
          const canAid = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['ally', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && player.id !== selected && healingDistance <= selectedCombatAction.range && (selectedCombatAction.id !== 'stabilize' || player.hp === 0) && (selectedCombatAction.id !== 'first-aid' || playerKnockedOut))
          const playerCommandAllowed = Boolean(canHeal || canAid || canThrowHere || canPointSpellHere || multiTargetSelectable)
          const playerSpecialBlock = combatMode === 'action' && selectedCombatAction?.id === 'stabilize' && player.hp > 0
            ? 'Стабилизация нужна только герою с 0 ОЗ'
            : combatMode === 'action' && selectedCombatAction?.id === 'first-aid' && !playerKnockedOut
              ? 'Первая помощь доступна только нокаутированному союзнику'
              : combatMode === 'action' && player.id === selected ? 'Выберите другого союзника' : null
          const playerTargetCheck = evaluateCombatTarget({
            selected: Boolean(selected && (combatActive || spellEconomyReady)), economyReady: targetEconomyReady,
            unavailableReason: targetUnavailableReason,
            targetAlive: player.hp > 0 || !heroIsDead(player.id), targetTeam: 'ally', acceptedTarget,
            distanceFeet: healingDistance, rangeFeet: targetRangeFeet,
            clearTrajectory: !longstriderTargeting && targetRangeFeet <= CELL_FEET || Boolean(active && hasClearBoardTrajectory(state, active, player)),
            resourceReady: targetResourceReady, specialBlockReason: playerSpecialBlock,
          })
          // Вне боя и без выбранного заклинания наведение на союзника — просто
          // взгляд на фишку. Прежде здесь звучал отказ «Сейчас этим участником
          // нельзя командовать» — даже над собственным героем.
          const playerIdleHover = !combatActive && combatMode !== 'magic' && !playerCommandAllowed && !areaTargetSelectionActive && !multiTargetSpell
          const playerTargetReason = playerIdleHover
            ? player.id === selected ? 'Ваш герой. Клик по клетке карты — перемещение.' : 'Союзник по отряду'
            : multiTargetSpell && multiTargetSelected
            ? 'Цель выбрана · клик уберёт её'
            : areaTargetSelectionActive && !playerInBlast
              ? 'Существо вне сферы 30 футов'
              : multiTargetSpell && multiTargetSeparationReason
                ? multiTargetSeparationReason
                : multiTargetSpell && spellTargetSelectionFull
                  ? `Выбрано максимальное число целей: ${spellTargetLimit}`
                  : playerCommandAllowed ? 'Допустимая цель' : playerTargetCheck.reason ?? 'Выбранная команда не подходит для союзника'
          const playerConditions = (state.mechanics?.conditions?.[player.id] ?? []).map(conditionPresentation)
          return <button
             className={'map-token hero-token ' + (actorHasFullArea ? 'large-actor ' : '') + (focusedParticipantId === player.id ? 'initiative-focus ' : '') + (linkedParticipantIds.includes(player.id) ? 'journal-linked ' : '') + (selected === player.id ? 'selected' : '') + ' ' + (openTokenLabelId === player.id ? 'label-open' : '') + ' ' + (player.id === turnActorId ? 'active-turn' : '') + ' ' + (canHeal || canAid || multiTargetSelectable ? 'targetable healing-target' : combatActive && selected && player.id !== turnActorId ? 'unavailable-target' : '') + ' ' + (pendingTargetId === player.id ? 'command-selected' : '') + ' ' + (multiTargetSelected ? 'multi-target-selected ' : '') + (player.hp <= 0 ? 'downed ' : '') + (player.maxHp > 0 && player.hp / player.maxHp <= .25 ? 'critical' : player.maxHp > 0 && player.hp / player.maxHp <= .5 ? 'wounded' : '')}
            data-actor-id={player.id}
            data-face={heroFaceMode(player)}
             style={{ ...heroFaceStyle(player, { '--token': player.color } as React.CSSProperties), ...actorTokenStyle }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={(event) => { setLinkedParticipantIds([player.id]); setInspectedAnchor(tokenAnchor(event.currentTarget)); if (canHeal && !areaTargetSelectionActive) setAimCell({ x: player.x, y: player.y }); setInspectedTarget({ id: player.id, name: player.character, team: 'ally', hp: player.hp, maxHp: player.maxHp, distanceFeet: healingDistance, allowed: playerCommandAllowed, reason: playerTargetReason }) }}
            onMouseLeave={() => { setLinkedParticipantIds([]); if (!pendingCommand) { if (!areaTargetSelectionActive) setAimCell(null); setInspectedTarget(null); setInspectedAnchor(null) } }}
            onFocus={(event) => { setLinkedParticipantIds([player.id]); setInspectedAnchor(tokenAnchor(event.currentTarget)); setInspectedTarget({ id: player.id, name: player.character, team: 'ally', hp: player.hp, maxHp: player.maxHp, distanceFeet: healingDistance, allowed: playerCommandAllowed, reason: playerTargetReason }) }}
            onBlur={() => { setLinkedParticipantIds([]); if (!pendingCommand) { setInspectedTarget(null); setInspectedAnchor(null) } }}
            onKeyDown={(event) => { if (multiTargetSpell && !pendingCommand && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); confirmSpellTargetSelection() } }}
            onClick={(event) => { event.stopPropagation(); if (pointSpellSelected && !areaTargetSelectionActive) { if (canPointSpellHere) castAtCell(cell.x, cell.y); return }; if (multiTargetSpell && multiTargetSelectable) { toggleSpellTarget(player.id, multiTargetSelectable); return }; if (canHeal) { castAtTarget(player.id); return }; setOpenTokenLabelId((current) => current === player.id ? null : player.id); if (canThrowHere) chooseArea(cell.x, cell.y); else if (canAid) useActionAtTarget(player.id) }}
            aria-label={canPointSpellHere ? `Наложить ${selectedSpell?.name} в клетку с ${player.character}` : canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${player.character}` : canAid ? `Использовать ${selectedCombatAction?.name} на ${player.character}` : canHeal ? `Наложить ${selectedSpell?.name} на ${player.character}` : player.character + (player.id === turnActorId ? ', активный герой' : '')}
            aria-disabled={!canHeal && !canAid && !canThrowHere && !canPointSpellHere && !multiTargetSelectable}
            title={playerTargetReason}
          >
            {!hasHeroPortrait(player) && <HeroFaceInitials hero={player} />}
            <TokenConditionIcons conditions={playerConditions} />
            <span className="token-label">{player.character}</span>
          </button>
        })()}
        {summon && cell.revealed && actorIsAnchor && (() => {
           const healingDistance = active ? actorDistanceFeet(active, summon) : Number.POSITIVE_INFINITY
          // `combatActive` здесь больше нет: вне боя мирное заклинание на союзника
          // разрешено, и решает это `spellEconomyReady`, повторяющий правило движка.
          const summonInBlast = Boolean(areaTargetSelectionActive && spellAffectedIds.has(summon.id))
          const canHeal = Boolean(selected && combatMode === 'magic' && selectedSpell && (['ally', 'creature'].includes(selectedSpell.target) || areaTargetSelectionActive) && spellEconomyReady && (areaTargetSelectionActive ? summonInBlast : healingDistance <= selectedSpellRange && (healingDistance <= CELL_FEET && !longstriderTargeting || Boolean(active && hasClearBoardTrajectory(state, active, summon)))))
          const summonKnockedOut = state.mechanics?.resting?.[summon.id]?.reason === 'knockout'
          const canAid = Boolean(combatActive && selected && combatMode === 'action' && selectedCombatAction && ['ally', 'creature'].includes(selectedCombatAction.target) && selectedActionEconomyReady && summon.id !== selected && healingDistance <= selectedCombatAction.range && (selectedCombatAction.id !== 'first-aid' || summonKnockedOut))
          const summonCommandAllowed = Boolean(canHeal || canAid || canThrowHere || canPointSpellHere || multiTargetSelectable)
          const summonTargetCheck = evaluateCombatTarget({
            selected: Boolean(selected && (combatActive || spellEconomyReady)), economyReady: targetEconomyReady,
            unavailableReason: targetUnavailableReason,
            targetAlive: summon.alive, targetTeam: 'ally', acceptedTarget,
            distanceFeet: healingDistance, rangeFeet: targetRangeFeet,
            clearTrajectory: !longstriderTargeting && targetRangeFeet <= CELL_FEET || Boolean(active && hasClearBoardTrajectory(state, active, summon)),
            resourceReady: targetResourceReady,
            specialBlockReason: combatMode === 'action' && summon.id === selected ? 'Выберите другого союзника' : null,
          })
          const summonTargetReason = multiTargetSpell && multiTargetSelected
            ? 'Цель выбрана · клик уберёт её'
            : areaTargetSelectionActive && !summonInBlast
              ? 'Существо вне сферы 30 футов'
              : multiTargetSpell && multiTargetSeparationReason
                ? multiTargetSeparationReason
                : multiTargetSpell && spellTargetSelectionFull
                  ? `Выбрано максимальное число целей: ${spellTargetLimit}`
                  : summonCommandAllowed ? 'Допустимая цель' : summonTargetCheck.reason ?? 'Выбранная команда не подходит для призыва'
          const summonConditions = (state.mechanics?.conditions?.[summon.id] ?? []).map(conditionPresentation)
          return <button
            className={'map-token summon-token ' + (actorHasFullArea ? 'large-actor ' : '') + (focusedParticipantId === summon.id ? 'initiative-focus ' : '') + (linkedParticipantIds.includes(summon.id) ? 'journal-linked ' : '') + (selected === summon.id ? 'selected ' : '') + (summon.id === turnActorId ? 'active-turn ' : '') + (openTokenLabelId === summon.id ? 'label-open' : '') + ' ' + (canHeal || canAid || multiTargetSelectable ? 'targetable healing-target' : combatActive && selected ? 'unavailable-target' : '') + ' ' + (pendingTargetId === summon.id ? 'command-selected' : '') + ' ' + (multiTargetSelected ? 'multi-target-selected' : '')}
            data-actor-id={summon.id}
             style={{ '--token': '#70a78b', ...actorTokenStyle } as React.CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onMouseEnter={(event) => { setLinkedParticipantIds([summon.id]); setInspectedAnchor(tokenAnchor(event.currentTarget)); if (canHeal && !areaTargetSelectionActive) setAimCell({ x: summon.x, y: summon.y }); setInspectedTarget({ id: summon.id, name: summon.name, team: 'ally', hp: summon.hp, maxHp: summon.maxHp, distanceFeet: healingDistance, allowed: summonCommandAllowed, reason: summonTargetReason }) }}
            onMouseLeave={() => { setLinkedParticipantIds([]); if (!pendingCommand) { if (!areaTargetSelectionActive) setAimCell(null); setInspectedTarget(null); setInspectedAnchor(null) } }}
            onFocus={(event) => { setLinkedParticipantIds([summon.id]); setInspectedAnchor(tokenAnchor(event.currentTarget)); setInspectedTarget({ id: summon.id, name: summon.name, team: 'ally', hp: summon.hp, maxHp: summon.maxHp, distanceFeet: healingDistance, allowed: summonCommandAllowed, reason: summonTargetReason }) }}
            onBlur={() => { setLinkedParticipantIds([]); if (!pendingCommand) { setInspectedTarget(null); setInspectedAnchor(null) } }}
            onKeyDown={(event) => { if (multiTargetSpell && !pendingCommand && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); confirmSpellTargetSelection() } }}
            onClick={(event) => { event.stopPropagation(); if (pointSpellSelected && !areaTargetSelectionActive) { if (canPointSpellHere) castAtCell(cell.x, cell.y); return }; if (multiTargetSpell && multiTargetSelectable) { toggleSpellTarget(summon.id, multiTargetSelectable); return }; if (canHeal) { castAtTarget(summon.id); return }; setOpenTokenLabelId((current) => current === summon.id ? null : summon.id); if (canThrowHere) chooseArea(cell.x, cell.y); else if (canAid) useActionAtTarget(summon.id) }}
            aria-label={canPointSpellHere ? `Наложить ${selectedSpell?.name} в клетку с ${summon.name}` : canThrowHere ? `Бросить ${selectedItem?.name ?? 'предмет'} в клетку с ${summon.name}` : canAid ? `Использовать ${selectedCombatAction?.name} на ${summon.name}` : canHeal ? `Наложить ${selectedSpell?.name} на ${summon.name}` : `${summon.name}, призванный союзник${summon.id === turnActorId ? ', активный участник' : ''}`}
            aria-disabled={!canHeal && !canAid && !canThrowHere && !canPointSpellHere && !multiTargetSelectable}
            title={summonTargetReason}
          >
            <Sparkles size={15} />
            <TokenConditionIcons conditions={summonConditions} />
            <span className="token-label">{summon.name}</span>
          </button>
        })()}
        {visibleBattleRoll && actorIsAnchor && (visibleBattleRoll.targetId ?? visibleBattleRoll.actorId) === (enemy?.id ?? player?.id ?? summon?.id) && (
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
  /* Стоимость плитки едет рядом с ней отдельным полем, а не вычитывается из
     разметки: по нему работает фильтр от пипсов ресурсов, и бейдж на плитке и
     фильтр обязаны читать одно и то же значение. */
  /* Счётчики вкладок — сколько плиток лежит в каждой колоде, по тем же
     правилам отбора, что и сами плитки ниже. */
  const deckCounts: Record<CombatDeck, number> = {
    all: 0,
    common: 1 + combatActions.filter((action) => action.category === 'common' && action.actionType !== 'reaction').length,
    weapon: 1 + combatItems.filter((item) => item.type === 'weapon').length,
    magic: hotbarSpells.length,
    class: combatActions.filter((action) => action.category === 'class' && action.actionType !== 'reaction').length,
    items: combatItems.filter((item) => item.type !== 'weapon').length,
  }
  // «Все» — сумма колод без плитки движения: шаги видны кольцом у «Завершить ход».
  deckCounts.all = deckCounts.common - 1 + deckCounts.weapon + deckCounts.magic + (spells.length ? 1 : 0) + deckCounts.class + deckCounts.items
  /* Плитка попадает и в свою колоду, и в общий вид «Все». */
  const inDeck = (deck: CombatDeck) => activeDeck === deck || activeDeck === 'all'
  /* Заклинание, которое герой держит сейчас: его плитка обводится кольцом. */
  const heroConcentration = activeHero ? heroStatusForActor(state, activeHero.id).concentration : null
  const deckTiles: Array<{ id: string; node: React.ReactElement; cost?: TileCost; section: HotbarSection }> = []
  if (activeDeck === 'common') deckTiles.push({ id: 'movement', cost: 'movement', section: 'action', node: <button className="action-tile movement-tile" disabled={!selected || !movementAvailable || remainingFeet <= 0 || actionsLocked} onClick={() => { setSelectedCombatActionId(''); setCombatMode('weapon') }} title="Перемещение — выберите подсвеченную клетку на карте"><CombatIcon id="movement" kind="movement" hint="перемещение" /><strong>Перемещение</strong><small>{remainingFeet} фт</small><i className="action-cost movement">движение</i></button> })
  if (inDeck('weapon')) deckTiles.push({ id: BASE_ATTACK_ID, cost: 'action', section: 'action', node: <button className={`action-tile weapon ${combatMode === 'weapon' && weaponSelectionId === BASE_ATTACK_ID ? 'selected' : ''}`} disabled={!selected || !weaponAttackReady || actionsLocked} onClick={() => { setSelectedItemId(BASE_ATTACK_ID); setCombatMode('weapon') }} title={`Базовая атака · ${baseRangeFeet} фт`}><CombatIcon id={BASE_ATTACK_ID} kind="weapon" hint="базовая атака оружием" /><strong>Базовая атака</strong><small>{baseRangeFeet} фт</small><i className="action-cost action">действие</i></button> })
  /* Колчан объясняется той же кнопкой, что и всё остальное на панели: пустой —
     плитка гаснет и в подсказке названа причина, ровно как у потраченной ячейки
     или занятого действия. Числа берутся из серверной проекции, поэтому
     счётчик не может обещать выстрел, в котором движок откажет. */
  if (inDeck('weapon')) combatItems.filter((item) => item.type === 'weapon').forEach((item) => { const ammunition = ammunitionSupplyFor(activeHero?.inventory, item); const quiverEmpty = Boolean(ammunition && ammunition.shots <= 0); const ammunitionLabel = ammunition ? `${ammunition.shots}×${ammunition.unit}` : ''; deckTiles.push({ id: item.id, cost: 'action', section: 'action', node: <button key={item.id} className={`action-tile weapon ${combatMode === 'weapon' && selectedItemId === item.id ? 'selected' : ''}`} disabled={!selected || !weaponAttackReady || actionsLocked || quiverEmpty} onClick={() => { setSelectedItemId(item.id); setCombatMode('weapon') }} title={quiverEmpty ? `${item.name}: колчан пуст — для выстрела нужен боеприпас «${ammunition?.unit}»` : ammunition ? `${item.name} ${ammunitionLabel}: ${item.description || item.properties}` : `${item.name}: ${item.description || item.properties}`}><CombatIcon id={item.id} kind="weapon" hint={`${item.name} ${item.combat?.kind ?? ''} ${item.combat?.damageType ?? ''}`} /><strong>{item.name}</strong><small>{item.combat?.damage ?? 'атака'} · {item.combat?.normalRange ?? 5} фт{ammunition ? ` · ${ammunitionLabel}` : ''}</small>{ammunition && <em>{ammunition.shots}</em>}<i className="action-cost action">действие</i></button> }) })
  if (activeDeck === 'magic' || (activeDeck === 'all' && spells.length > 0)) deckTiles.push({ id: 'spellbook', section: 'spell', node: <button className="action-tile spellbook-tile" onClick={() => setSpellbookOpen(true)} disabled={tacticalBusy} title={`Открыть полный каталог: ${spells.length} заклинаний в списке героя`}><CombatIcon id="spellbook" kind="spellbook" hint="книга заклинаний" /><strong>Книга</strong><small>{spells.length} в списке</small></button> })
  const slotFilteredSpells = slotLevelFilter
    ? hotbarSpells.filter((spell) => spell.level > 0 && spell.level <= slotLevelFilter)
    : hotbarSpells
  if (inDeck('magic')) slotFilteredSpells.forEach((spell) => {
    const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote)
    const componentAvailability = spellComponentAvailabilityFor(spell)
    const availability = spellSlotAvailabilityFor(spell, activeResources)
    const pools = availability.levels.length
      ? availability.levels.map((level) => activeResources[`spell_slots_${level}`]).filter(Boolean)
      : availability.resource ? [activeResources[availability.resource]].filter(Boolean) : []
    const pool = pools.find((candidate) => Number(candidate.current ?? 0) > 0) ?? pools[0]
    const ready = availability.ready
    const actionType = activeConditionIds.has('metamagic-quickened') && spellActionType(spell) === 'action' ? 'bonus_action' : spellActionType(spell)
    const reactionOnly = state.ruleset_id === 'dnd_5e_2014' && actionType === 'reaction'
    const economyReady = !reactionOnly && (combatActive
      ? actionType !== 'long_cast' && (actionType === 'bonus_action' ? bonusReady : actionType === 'reaction' ? reactionReady : actionReady)
      : castableOutOfCombat(spell))
    const componentReason = componentAvailability.blocked
      ? unavailableUiReason(componentAvailability.reason)
      : null
    const tileReason = support.blocked
      ? `${support.label}. ${support.explanation}`
      : componentReason ?? (reactionOnly ? 'Применяется через окно реакции после подходящего события' : `${spell.description ?? ''}${spell.concentration ? ' · Концентрация' : ''}`)
    const componentReasonId = `spell-component-availability-${spell.id}`
    deckTiles.push({
      id: spell.id,
      cost: actionType,
      section: 'spell',
      node: <button
        key={spell.id}
        className={`action-tile spell support-${support.status}${componentAvailability.blocked ? ' components-blocked' : ''} ${combatMode === 'magic' && selectedSpell?.id === spell.id ? 'selected' : ''}`}
        disabled={support.blocked || !selected || !ready || !economyReady || (combatActive ? tacticalBusy : !castableOutOfCombat(spell))}
        onClick={(event) => selectSpell(spell, event.currentTarget)}
        title={`${spell.name} — ${tileReason}`}
        aria-label={`${spell.name}. ${tileReason}`}
        aria-describedby={componentAvailability.blocked ? componentReasonId : undefined}
      >
        <CombatIcon id={spell.id} kind="spell" hint={`${spell.kind} ${spell.damageType ?? ''} ${spell.name}`} priority />
        {spell.level > 0 && <i className="tile-level" aria-hidden="true">{SPELL_LEVEL_ROMANS[spell.level - 1]}</i>}
        {spell.concentration && <i className={`tile-conc${heroConcentration === spell.name ? ' holding' : ''}`} aria-hidden="true" />}
        <strong>{spell.name}</strong>
        <small>{spell.level ? `${spell.level} круг` : 'заговор'} · {spellRange(spell)} фт</small>
        <SpellComponentsLine spell={spell} compact />
        {pool && <em>{Number(pool.current ?? 0)}/{Number(pool.max ?? 0)}</em>}
        {componentAvailability.blocked && <i id={componentReasonId} className="spell-component-lock" title={componentReason ?? 'Недоступно: нужные компоненты недоступны'} aria-label={componentReason ?? 'Недоступно: нужные компоненты недоступны'}><Lock size={11} aria-hidden="true" /></i>}
        {support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`}>{support.shortLabel}</i>}
        <i className={`action-cost ${actionType}`}>{actionType === 'bonus_action' ? 'бонус' : actionType === 'reaction' ? 'реакция' : actionType === 'long_cast' ? 'вне боя' : 'действие'}</i>
      </button>,
    })
  })
  if (activeDeck === 'common' || activeDeck === 'class' || activeDeck === 'all') combatActions.filter((action) => (activeDeck === 'all' ? action.category === 'common' || action.category === 'class' : action.category === activeDeck) && action.actionType !== 'reaction').forEach((action) => { const support = mechanicsSupportPresentation(action.mechanicsSupport, action.supportNote); const pool = action.resource ? activeResources[action.resource] : undefined; const ready = !action.resource || Number(pool?.current ?? 0) >= Number(action.cost ?? 1); const economyReady = action.actionType === 'free' || (action.actionType === 'bonus_action' ? bonusReady : actionReady); deckTiles.push({ id: action.id, cost: action.actionType === 'bonus_action' ? 'bonus_action' : action.actionType === 'free' ? 'free' : action.actionType === 'reaction' ? 'reaction' : 'action', section: action.actionType === 'bonus_action' || action.actionType === 'free' ? 'bonus' : 'action', node: <button key={action.id} className={`action-tile feature-action support-${support.status} ${combatMode === 'action' && selectedCombatAction?.id === action.id ? 'selected' : ''}`} disabled={support.blocked || !selected || !ready || !economyReady || actionsLocked} onClick={() => selectCombatAction(action)} title={`${action.name} — ${support.blocked ? `${support.label}. ${support.explanation}` : action.description}`}><CombatIcon id={action.id} kind="action" hint={`${action.name} ${action.category} ${action.target}`} /><strong>{action.name}</strong><small>{action.target === 'self' ? 'на себя' : action.target === 'ally' ? `${action.range} фт · союзник` : `${action.range} фт · враг`}</small>{pool && <em>{Number(pool.current ?? 0)}/{Number(pool.max ?? 0)}</em>}{support.status !== 'verified' && <i className={`mechanics-support-badge support-${support.status}`}>{support.shortLabel}</i>}<i className={`action-cost ${action.actionType}`}>{action.actionType === 'bonus_action' ? 'бонус' : action.actionType === 'free' ? 'свободно' : 'действие'}</i></button>  }) })
  if (inDeck('items')) combatItems.filter((item) => item.type !== 'weapon').forEach((item) => deckTiles.push({ id: item.id, cost: 'action', section: 'items', node: <button key={item.id} className={`action-tile item ${combatMode === 'weapon' && selectedItemId === item.id ? 'selected' : ''}`} disabled={!selected || !actionReady || actionsLocked} onClick={() => { setSelectedItemId(item.id); setCombatMode('weapon') }} title={`${item.name} — ${item.description}`}><CombatIcon id={item.id} kind="item" hint={`${item.name} ${item.type} ${item.combat?.kind ?? ''} ${item.combat?.damageType ?? ''}`} /><strong>{item.name}</strong><small>{item.quantity} шт. · {item.combat?.radius ? `радиус ${item.combat.radius} фт` : 'предмет'}</small><i className="action-cost action">действие</i></button> }))
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
  /* Фильтр — только выборка на экран. Перестановка плиток по-прежнему считает
     полный порядок колоды (`orderedTiles`), иначе перетаскивание при включённом
     фильтре стирало бы из памяти всё, что фильтр спрятал. */
  const visibleTiles = costFilter ? orderedTiles.filter((tile) => tile.cost === costFilter) : orderedTiles
  const tileColumns = Math.max(fitTileColumns, Math.ceil(visibleTiles.length / 2))
  /* Общий вид BG3: секции по цене хода. Самая многочисленная секция остаётся
     компактной — только иконки, лишнее уходит в прокрутку, — а свободная ширина
     достаётся малым секциям под подписи. Так у волшебника двенадцатого уровня
     заклинания не выдавливают оружие и бонусные действия с панели. */
  const hudRows = 3
  const hotbarSections: Array<{ id: HotbarSection | 'deck'; tiles: typeof visibleTiles }> = activeDeck === 'all'
    ? (['action', 'spell', 'bonus', 'items'] as HotbarSection[])
        .map((id) => ({ id, tiles: visibleTiles.filter((tile) => tile.section === id) }))
        .filter((section) => section.tiles.length > 0)
    : visibleTiles.length ? [{ id: 'deck', tiles: visibleTiles }] : []
  const largestSection = hotbarSections.length > 1
    ? hotbarSections.reduce((best, section) => section.tiles.length > best.tiles.length ? section : best)
    : null
  /* Реакции героя — справа от плиток: они не нажимаются, а срабатывают в окне
     реакции, поэтому панель только показывает, чем герой может ответить и не
     потрачена ли реакция в этом раунде. */
  const reactionHero = viewerHero ?? activeHero
  const railReactionReady = railPips.find((pip) => pip.id === 'reaction')?.ready ?? true
  // Реакции героя и их режимы приходят с сервера списком — тем же, по которому
  // сервер сверяет команду. Чужому герою режимов не отдают: тогда панель
  // показывает его реакции без переключателя.
  const ownReactionModes = reactionHero?.reactionModes ?? null
  const heroReactions: HeroReactionMode[] = ownReactionModes ?? (reactionHero ? [
    { id: 'opportunity-attack', name: 'Атака по возможности', kind: 'action' as const, mode: 'ask' as const },
    ...(reactionHero.combatActions ?? []).filter((action) => action.actionType === 'reaction').map((action) => ({ id: action.id, name: action.name, kind: 'action' as const, mode: 'ask' as const })),
    ...(reactionHero.combatSpells ?? []).filter((spell) => spellActionType(spell) === 'reaction').map((spell) => ({ id: `cast:${spell.id}`, spell_id: spell.id, name: spell.name, kind: 'spell' as const, mode: 'ask' as const })),
  ].filter((reaction, index, list) => list.findIndex((other) => other.id === reaction.id) === index) : [])
  const canSetReactionModes = Boolean(ownReactionModes && onSetReactionMode && reactionHero && !ownHeroDead)
  const openReactionModes = (anchorElement: HTMLElement, focusId: string | null = null) => {
    if (reactionMenu) { setReactionMenu(null); return }
    setReactionMenu({ anchorElement, focusId })
  }
  const setReactionMode = (reaction: HeroReactionMode, mode: ReactionMode) => {
    if (!reactionHero || !onSetReactionMode) return
    void onSetReactionMode(reactionHero.id, reaction.id, mode, reaction.name)
  }
  const openChatForOwnAction = () => {
    toggleChat(false)
    window.requestAnimationFrame(() => freeInputRef.current?.focus())
  }
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
            <div className={`initiative-active-chip ${activeEnemy ? 'enemy' : activeSummon ? 'summon' : 'hero'}${activeEnemy?.boss ? ' boss' : ''}`}>
              {activeHero
                ? <span className="initiative-active-avatar portrait" data-face={heroFaceMode(activeHero)} style={heroFaceStyle(activeHero)}>{!hasHeroPortrait(activeHero) && <HeroFaceInitials hero={activeHero} />}</span>
                : activeEnemy
                  ? <span className="initiative-active-avatar enemy">{activeEnemy.image ? <img src={activeEnemy.image} alt="" /> : <EnemyGlyph kind={enemyVisualKind(activeEnemy)} />}</span>
                  : <span className="initiative-active-avatar summon"><Sparkles size={18} /></span>}
              <span><strong>{activeName}</strong></span>
              {activeEnemy?.legendary && <LegendaryPips legendary={activeEnemy.legendary} />}
            </div>
            <header>Раунд <b>{combat.round ?? 1}</b></header>
            {/* Как в BG3: лента начинается с ходящего, а кто уже сходил в этом
                раунде, уходит за черту следующего раунда. Номер в углу — место
                в исходном порядке инициативы. */}
            <ol>{(combat.initiative ?? []).map((entry, index) => ({ entry, index }))
              .sort((left, right) => ((left.index - activeInitiativeIndex + 1000) % 1000) - ((right.index - activeInitiativeIndex + 1000) % 1000))
              .map(({ entry, index }) => {
              const hero = state.players.find((player) => player.id === entry.actor_id)
              const enemy = state.enemies?.find((item) => item.id === entry.actor_id)
              const summon = state.actors?.find((item) => item.id === entry.actor_id)
              const kind = summon ? 'summon' : enemy ? 'enemy' : 'hero'
              const name = hero?.character ?? summon?.name ?? enemy?.name ?? entry.actor_id
              const defeated = participantDefeated(entry.actor_id)
              const activeNow = index === activeInitiativeIndex
              const nextUp = index === nextInitiativeIndex
              const statusLabel = defeated ? 'Выбыл' : activeNow ? 'Сейчас' : nextUp ? 'Следующий' : ''
              const enemyKind = enemy ? enemyVisualKind(enemy) : null
              // Босса стол узнаёт в ленте с первого взгляда: он действует между
              // чужими ходами, и очередь без этого читалась бы неправдой.
              const boss = enemy?.boss === true
              /* Здоровье в очереди — как в макете боя: у героя и призванного
                 доля хитов, у противника — ступень словами (точные числа только
                 при раскрытых характеристиках, это решает проекция сервера). */
              const enemyHealth = enemy && !defeated ? enemyHealthPresentation(enemy) : null
              const allyHealth = hero ?? summon
              const healthFill = enemyHealth ? enemyHealth.fill : allyHealth && Number(allyHealth.maxHp) > 0 ? Math.max(0, Math.min(1, Number(allyHealth.hp) / Number(allyHealth.maxHp))) : null
              const healthWord = enemyHealth ? enemyHealth.label : allyHealth && Number(allyHealth.maxHp) > 0 ? `${Math.max(0, Number(allyHealth.hp))}/${allyHealth.maxHp} ОЗ` : ''
              return <Fragment key={entry.actor_id}>
              {index === 0 && activeInitiativeIndex > 0 && <li className="initiative-round-divider" aria-label={`Раунд ${(combat.round ?? 1) + 1}`}><span>{(combat.round ?? 1) + 1}</span></li>}
              <li className={`${kind} ${activeNow ? 'active' : ''} ${nextUp ? 'next' : ''} ${defeated ? 'defeated' : ''}${boss ? ' boss' : ''}`} aria-current={activeNow ? 'step' : undefined}>
                <button
                  className={`initiative-avatar-button ${focusedParticipantId === entry.actor_id ? 'focused' : ''}`}
                  aria-label={`Выделить на карте: ${name}${boss ? ', босс' : ''}${healthWord && !defeated ? `, ${healthWord.toLowerCase()}` : ''}${statusLabel ? `, ${statusLabel}` : ''}`}
                  aria-pressed={focusedParticipantId === entry.actor_id}
                  title={`${name}${boss ? ' · босс' : ''}${healthWord && !defeated ? ` — ${healthWord.toLowerCase()}` : ''}${statusLabel ? ` · ${statusLabel}` : ''}`}
                  onClick={() => setFocusedParticipantId((current) => current === entry.actor_id ? null : entry.actor_id)}
                >
                  <span className="initiative-order" aria-hidden="true">{index + 1}</span>
                  {hero
                    ? <span className="initiative-avatar portrait" data-face={heroFaceMode(hero)} style={heroFaceStyle(hero)}>{!hasHeroPortrait(hero) && <HeroFaceInitials hero={hero} />}</span>
                    : enemy
                      ? <span className="initiative-avatar enemy">{enemy.image ? <img src={enemy.image} alt="" /> : <EnemyGlyph kind={enemyKind ?? 'raider'} />}</span>
                      : <span className="initiative-avatar summon"><Sparkles size={18} /></span>}
                  {boss && <span className="initiative-boss-badge" aria-hidden="true"><Crown size={11} /></span>}
                  {boss && enemy?.legendary && !defeated && <LegendaryPips legendary={enemy.legendary} compact />}
                  {activeNow && <span className="initiative-turn-dot" aria-hidden="true" />}
                  {healthFill != null && !defeated && <span className={`initiative-health ${enemy ? 'enemy' : 'ally'}`} data-status={enemyHealth?.status} aria-hidden="true"><u style={{ width: `${Math.round(healthFill * 100)}%` }} /></span>}
                  {/* Урон заливает портрет снизу, как в BG3: у противника — по
                      ступени здоровья, у своих — по доле хитов. */}
                  {healthFill != null && !defeated && <span className="initiative-damage" aria-hidden="true" style={{ height: `${Math.round((1 - healthFill) * 100)}%` }} />}
                  {statusLabel && <span className={`initiative-status-label ${defeated ? 'defeated' : activeNow ? 'active' : 'next'}`}>{statusLabel}</span>}
                </button>
              </li>
              </Fragment>
            })}</ol>
          </> : <div className="initiative-exploration-lead">
            <span className="initiative-ribbon-label">Свободная сцена</span>
            <div className="initiative-active-chip exploration">
              <span className="initiative-active-avatar portrait" data-face={heroFaceMode(activeHero)} style={heroFaceStyle(activeHero)}>{!hasHeroPortrait(activeHero) && <HeroFaceInitials hero={activeHero} />}</span>
              <span><strong>Говорит любой герой</strong><small>Групповые решения — голосованием</small></span>
            </div>
          </div>}
        </section>
      </div>
      <div
        className={`map-stage ${visualTheme} ${scenicBackdrop ? 'scenic-backdrop' : 'monotone-backdrop'}${!mapArt ? ' native-board-stage' : ''}${truce ? ' truce-held' : ''}`}
        data-map-source={mapArt?.id ?? boardMap?.tilesetId}
        style={{ '--board-art': mapArt ? `url("${mapArt.url}")` : 'none' } as React.CSSProperties}
      >
      <div className="map-atmosphere map-atmosphere-one" />
      <div className="map-atmosphere map-atmosphere-two" />
      {!combatActive && <PartyQuestHud state={state} />}
      {combatActive && pendingTarget && (() => {
        const targetEnemy = state.enemies?.find((enemy) => enemy.id === pendingTarget.id)
        const health = targetEnemy ? enemyHealthPresentation(targetEnemy) : null
        const allyFill = !targetEnemy && Number(pendingTarget.maxHp) > 0 ? Math.max(0, Math.min(1, Number(pendingTarget.hp) / Number(pendingTarget.maxHp))) : null
        const fill = health ? health.fill : allyFill
        const word = health ? health.label : allyFill != null ? `${Math.max(0, Number(pendingTarget.hp))}/${pendingTarget.maxHp} ОЗ` : ''
        const targetName = 'character' in pendingTarget && pendingTarget.character ? pendingTarget.character : pendingTarget.name
        return <div className={`combat-target-plate ${targetEnemy ? 'enemy' : 'ally'}`} role="status" aria-label={`Выбранная цель: ${targetName}${word ? `, ${word.toLowerCase()}` : ''}`}>
          <strong>{targetName}</strong>
          {targetEnemy?.boss && <span className="combat-target-plate-tag">босс</span>}
          {fill != null && <span className="combat-target-plate-bar" aria-hidden="true"><u style={{ width: `${Math.round(fill * 100)}%` }} /><b>{word}</b></span>}
          <small>Ваша цель — подтвердите в поле ввода или выберите другую</small>
        </div>
      })()}
      {/* Перемирие видно на самой доске, а не только в панели: рамка вокруг
          поля и полоса сверху. Без этого стол не понимал бы, почему очередь
          стоит и почему кнопки боя ведут себя иначе. */}
      {truce && <div className="truce-banner" role="status" aria-live="polite">
        <Handshake size={15} />
        <span>Перемирие · говорит {truce.leader_name || 'предводитель уцелевших'}. Удар разорвёт уговор.</span>
      </div>}
      {npcTacticText && <div className="npc-tactic-banner" role="status" aria-live="polite"><Swords size={15} /><span>{npcTacticText}</span></div>}
      <TacticalBoard
        campaignId={state.sessionCode}
        key={state.sessionCode}
        map={boardMap}
        columns={columns}
        rows={rows}
        irregular={irregularMap}
        themeKey={visualTheme}
        artUrl={mapArt && scenicBackdrop && (!fortressMap || mapArt.mode === 'map') ? mapArt.url : null}
        artMode={mapArt?.mode}
        lighting={boardLighting}
        ariaLabel={`Тактическая карта, вид сверху. Колесо меняет масштаб, перетаскивание двигает полотно, двойной клик центрирует. Активный участник: ${activeName}`}
        cells={boardCells}
        cellHints={boardHints}
        overlayCells={boardOverlay}
        movePreview={movePreview}
        effectRenderers={aimingEffectRenderers}
        onCancelAiming={spellAiming ? clearPrepared : undefined}
        onConfirmAiming={multiTargetSpell && spellTargetIds.length > 0 && !pendingCommand ? confirmSpellTargetSelection : undefined}
        targetHint={pointSpellSelected && previewBlastCenter && !areaTargetSelectionActive && (spellAimReason || spellAffectedAllies.length) ? {
          point: previewBlastGridOrigin ?? previewBlastCenter,
          ...(previewBlastGridOrigin ? { anchor: 'grid-intersection' as const } : {}),
          text: spellAimReason ?? `Союзники в области: ${spellAffectedAllies.length}`,
          tone: spellAimReason ? 'blocked' : 'warning',
        } : multiTargetSpell && targetSelectionHintPoint && spellTargetSelectionText ? {
          point: targetSelectionHintOrigin ?? targetSelectionHintPoint,
          ...(targetSelectionHintOrigin ? { anchor: 'grid-intersection' as const } : {}),
          text: spellTargetSelectionText,
          tone: 'warning',
        } : pendingMovePoint ? {
          // В бою первый клик по клетке только показывает маршрут. Без этой
          // подсказки игрок кликал, видел подсвеченный путь — и ждал хода,
          // который не наступал. Живой прогон 2026-10-02.
          point: pendingMovePoint,
          text: 'Нажмите ещё раз, чтобы идти сюда',
          tone: 'warning',
        } : undefined}
        onCellHover={pointSpellSelected ? (point) => {
          if (areaTargetSelectionActive) return
          const cell = point && state.scene.cells.find((candidate) => candidate.x === point.x && candidate.y === point.y)
          setAimCell(cell?.revealed && (cell.type === 'floor' || cell.type === 'door') ? { x: cell.x, y: cell.y } : null)
        } : undefined}
        battleLog={animatedBattleLog}
        visualBatch={visualBatch}
        animationActors={animationActors}
        focusActorId={typingActorId}
        passClickThroughAnimation={combatActive}
        autoFocusKey={combatActive ? (turnActorId === typingActorId ? `turn:${combat.round ?? 1}:${turnActorId}` : 'combat') : ''}
        animationsEnabled={combatAnimations}
        combatAudio={combatAudio}
        conditions={state.mechanics?.conditions}
        trajectory={spellAreaPreviewSelected ? null : trajectory}
        conditionVersion={state.state_version}
        onPropActivate={spellAreaPreviewSelected ? undefined : onPropActivate}
        levelIndex={sceneLevelIndex}
        onBackgroundActivate={() => { setOpenTokenLabelId(null); setSelectedSceneObjectId(null) }}
        decoration={trajectory && !spellAreaPreviewSelected
          ? <svg className="projectile-trajectory" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1={trajectory.x1} y1={trajectory.y1} x2={trajectory.x2} y2={trajectory.y2} /></svg>
          : null}
      />
      <div className="map-scale-plate">1 клетка = 5 футов</div>
      <LocationOverview overview={locationOverviewFor(state.scene.location_id)} map={boardMap} />
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
          <span><i className="legend-swatch contour" />Горизонталь · каждые 5 футов высоты</span>
          <span><i className="legend-swatch cliff" />Обрыв · перепад от 10 футов</span>
          <span><i className="legend-mark elevation">▲</i>Высота клетки — под курсором</span>
          <span><i className="legend-mark cover">½</i>Укрытие от линии огня</span>
          {/* Поверхности: цвета повторяют SURFACE_COLORS из src/board-render.ts —
              по ним игрок читает, где вода, где лёд, а где месиво. */}
          <span><i className="legend-swatch surface-water" />Вода · движение вдвое дороже</span>
          <span><i className="legend-swatch surface-ice" />Лёд · проверка на падение</span>
          <span><i className="legend-swatch surface-mud" />Грязь · трудная местность</span>
          <span><i className="legend-swatch surface-rubble" />Щебень · трудная местность</span>
          <span><i className="legend-mark stairs">⇅</i>Лестница или люк · переход между этажами</span>
          {state.scene.map_source && <span className="map-legend-credit">
            Карта: {state.scene.map_source.url
              ? <a href={state.scene.map_source.url} target="_blank" rel="noreferrer">«{state.scene.map_source.title}»</a>
              : `«${state.scene.map_source.title}»`}
            {' — '}{state.scene.map_source.author}
            {state.scene.map_source.site ? `, ${state.scene.map_source.site}` : ''}
            {state.scene.map_source.license && <>{', '}{state.scene.map_source.license_url
              ? <a href={state.scene.map_source.license_url} target="_blank" rel="noreferrer">{state.scene.map_source.license}</a>
              : state.scene.map_source.license}</>}
          </span>}
        </div>
      </details>
      {spellbookOpen && <Suspense fallback={<section className="spellbook-catalog spellbook-loading" role="dialog" aria-modal="true" aria-label={`Книга заклинаний: ${activeName}`} onPointerDown={(event) => event.stopPropagation()}><p role="status">Открываем книгу заклинаний…</p><button type="button" onClick={() => setSpellbookOpen(false)}>Закрыть</button></section>}><Spellbook
        spells={spells}
        catalogSpells={spellbookSpells}
        activeName={activeName}
        initialSpellId={selectedSpell?.id}
        pinnedSpellIds={hotbarSpellIds}
        onClose={() => setSpellbookOpen(false)}
        onSelect={(catalogSpell) => {
          const spell = spells.find((entry) => entry.id === catalogSpell.id)
          if (!spell) return
          selectSpell(spell)
          setSpellbookOpen(false)
        }}
        onPin={(spellId) => { if (spells.some((entry) => entry.id === spellId)) toggleHotbarSpell(spellId) }}
        isPinDisabled={(catalogSpell) => {
          const spell = spells.find((entry) => entry.id === catalogSpell.id)
          if (!spell) return true
          return spell.prepared === false || mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote).blocked || spellComponentAvailabilityFor(spell).blocked
        }}
        isSelectionDisabled={(catalogSpell) => {
          const spell = spells.find((entry) => entry.id === catalogSpell.id)
          if (!spell) return true
          const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote)
          return spellComponentAvailabilityFor(spell).blocked || support.blocked || spell.prepared === false || (state.ruleset_id === 'dnd_5e_2014' && spellActionType(spell) === 'reaction') || (combatActive && spellActionType(spell) === 'long_cast') || (!combatActive && !castableOutOfCombat(spell))
        }}
        blockedReasonFor={(catalogSpell) => {
          const spell = spells.find((entry) => entry.id === catalogSpell.id)
          if (!spell) return 'Заклинание отсутствует в наборе героя'
          const availability = spellComponentAvailabilityFor(spell)
          if (availability.blocked) return availability.reason ?? 'Нужные компоненты недоступны'
          const support = mechanicsSupportPresentation(spell.mechanicsSupport, spell.supportNote)
          if (support.blocked) return support.label + '. ' + support.explanation
          if (spell.prepared === false) return 'Заклинание не изучено или не подготовлено'
          if (state.ruleset_id === 'dnd_5e_2014' && spellActionType(spell) === 'reaction') return 'Применяется через окно реакции после подходящего события'
          if (combatActive && spellActionType(spell) === 'long_cast') return 'Длительное накладывание доступно только вне боя'
          if (!combatActive && !castableOutOfCombat(spell)) return 'Боевое заклинание требует инициативы: сначала начните бой'
          return null
        }}
      /></Suspense>}

      </div>
      {dossierSceneNpc && <div className="npc-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setNpcDossier(null)
      }}>
        <section className="npc-dialog" role="dialog" aria-modal="true" aria-labelledby="npc-dialog-title">
          <header>
            <NpcPortrait campaignId={state.sessionCode} npcId={dossierSceneNpc.id} name={dossierSceneNpc.name} />
            <span><small>{dossierSceneNpc.role || 'Персонаж сцены'}</small><strong id="npc-dialog-title">{dossierSceneNpc.name}</strong></span>
            <button type="button" onClick={() => setNpcDossier(null)} aria-label="Закрыть разговор"><X size={18} /></button>
          </header>
          <div className="npc-dialog-status">
            <span><small>Стойка на сцене</small><b>{NPC_STANCE_LABELS[visibleNpcStance(dossierSceneNpc.stance)]}</b></span>
            <span><small>Отношение к герою</small><b>{NPC_RELATIONSHIP_LABELS[dossierRelationship]}</b></span>
            {dossierCaptive && <span className="npc-dialog-captive"><small>Положение</small><b>Пленник отряда</b></span>}
          </div>
          <div className="npc-dialog-body">
            <section className="npc-public-dossier">
              <header><BookOpen size={14} /><strong>Известно герою</strong><small>просмотр не расходует действие</small></header>
              <p>{dossierSocialNpc?.public_summary || 'Собеседник ещё не раскрыл о себе ничего сверх имени и роли.'}</p>
              {dossierSocialNpc?.voice && <blockquote>Манера речи: {dossierSocialNpc.voice}</blockquote>}
              {dossierPublicTags.length > 0 ? <div>{dossierPublicTags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
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
                    <span>Предмет из инвентаря {giftSender?.character ?? 'героя'}</span>
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
                    <span>Количество</span>
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
                      placeholder={dossierWaiting ? 'Ожидаем ответ собеседника…' : dossierCanTalk ? `Сказать ${dossierSceneNpc.name}…` : combatActive ? 'Разговор недоступен во время боя' : 'Собеседник сейчас недоступен'}
                      aria-label={`Реплика для ${dossierSceneNpc.name}`}
                    />
                    <button type="submit" disabled={!dossierCanTalk || !npcDialogueText.trim()}><Send size={15} />Сказать</button>
                  </form>
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
              disabled={!canAct || narrating || tacticalBusy || dialogueBusy}
              onClick={() => { setNpcDossier(null); onOpenMerchant(dossierSceneNpc.id) }}
            ><Store size={14} />Торговать</button>}
          </footer>
        </section>
      </div>}
      {/* Свёрнутая хроника — узкой колонкой у правого края стола: вкладка не
          ложится на доску и не прячет фишки. */}
      {chatCollapsed && <button type="button" className="chat-reopen-tab" data-hud="chat-toggle" onClick={() => toggleChat(false)} aria-label="Открыть хронику и поле ввода" title="Открыть хронику: рассказ, бой и поле ввода"><Feather size={18} aria-hidden="true" /><span>Хроника</span></button>}
      <aside className="server-column" aria-label="Состояние сцены" data-collapsed={chatCollapsed ? 'true' : undefined}>
        <button type="button" className="chat-collapse-button" data-hud="chat-toggle" onClick={() => toggleChat(true)} aria-label="Свернуть хронику" title="Свернуть хронику: стол целиком под доской, слово Рассказчику — вкладкой у края или «Своё действие»"><PanelRightClose size={16} aria-hidden="true" /></button>
        <div className="server-resize column-grip" role="separator" aria-orientation="vertical" aria-label="Ширина хроники" aria-valuemin={300} aria-valuenow={serverWidth || undefined} tabIndex={0} onPointerDown={startServerResize} onDoubleClick={() => { setServerWidth(0); viewerStorage.remove(SERVER_WIDTH_KEY) }} onKeyDown={resizeServerWithKeys} title="Потяните, чтобы изменить ширину. Двойной щелчок — вернуть обычную"><i aria-hidden="true" /></div>
        {/* Полоска хода — всё, что колонка говорит о бое сверху: раунд, кто
            ходит, его состояния чипами и часы автопропуска одной строкой.
            Прежняя карточка контекста росла до 435px, а колонке на ноутбуке
            доставалось 384: видны были первые 80, остальное — инспектор цели,
            боевая хроника, сводка ходов — жило под прокруткой, куда никто не
            заглядывал. Инспектор теперь стоит у самой фишки
            (`combat-target-popover` ниже), события боя — в ленте, ходы
            противников — свёртком под полоской. ОЗ ходящего здесь не
            повторяются: они есть в списке отряда и в полоске жизни. */}
        {combatActive && <div className="turn-strip" role="status" aria-live="polite" aria-label={`Раунд ${combat.round ?? 1}, ходит ${activeName}`}>
          <span className="turn-strip-round">Раунд {combat.round ?? 1}</span>
          <span className="turn-strip-actor">ходит <b className={activeHero || activeSummon ? 'ally' : 'enemy'}>{activeName}</b></span>
          {activeConditions.map((condition) => <span key={condition.instanceKey} className={`turn-strip-condition ${condition.status}`} title={`${condition.statusLabel}. ${condition.explanation}${condition.duration ? ` Длительность: ${condition.duration}` : ''}`}><i />{condition.label}</span>)}
          <CombatTurnClock clock={state.turn_clock} actorName={actorNameById(state.turn_clock?.actor_ids?.[0])} compact />
        </div>}
        {activeHero && canAct && activeConditionIds.has('bless-d4') && onSetSpellBonusPreference && <label className="spell-bonus-preference"><input type="checkbox" aria-label="Использовать бонус Благословения" checked={(state.mechanics?.conditions?.[turnActorId] ?? []).some((condition) => condition.id === 'bless-d4' && condition.bonus_enabled !== false)} disabled={tacticalBusy || Boolean(combat.reaction_window)} onChange={(event) => { void onSetSpellBonusPreference(turnActorId, event.target.checked) }} /> Использовать бонус Благословения к атакам и спасброскам</label>}
        {/* Ходы противников, прошедшие пока игрок ждал, — одной свёрнутой
            строкой со счётчиком, а не отдельной панелью: раскрывается по
            нажатию, наведение на строку подсвечивает участников на доске. */}
        {npcSummaryEvents.length > 0 && <section className={`npc-turn-group${npcGroupOpen ? ' open' : ''}`} aria-label="Пока вы ждали: ходы противников">
          <button type="button" aria-expanded={npcGroupOpen} onClick={() => setNpcGroupOpen((value) => !value)}>
            <History size={14} /><span>Пока вы ждали</span><b>{npcSummaryEvents.length}</b><ChevronDown size={14} />
          </button>
          {npcGroupOpen && <ol>{npcSummaryEvents.map((event) => {
            const participantIds = battleEventParticipantIds(event)
            const linked = participantIds.some((id) => linkedParticipantIds.includes(id))
            return <li
              key={event.id}
              className={linked ? 'linked' : ''}
              tabIndex={0}
              onMouseEnter={() => setLinkedParticipantIds(participantIds)}
              onMouseLeave={() => setLinkedParticipantIds([])}
              onFocus={() => setLinkedParticipantIds(participantIds)}
              onBlur={() => setLinkedParticipantIds([])}
            >{battleEventText(state, event)}</li>
          })}</ol>}
        </section>}
        {/* Ситуативные панели — перемирие, стража, добыча, таверна, почта,
            пленники, звери, отдых — одной строкой чипов; раскрытая встаёт
            поверх ленты (`SituationalSlot`). Раньше они стояли штабелем между
            контекстом боя и хроникой и делили с ней 384 пикселя колонки: почта
            обрезалась пополам, хронике оставалось 78. Отступ содержимого
            оставлен без сдвига намеренно: смысл вложенности виден по обёртке,
            а не по лишним 430 строкам диффа. */}
        <div className="server-situational">
        {truce && <SituationalSlot id="truce" icon={<Handshake size={14} />} label="Перемирие" open={openSituational === 'truce'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="truce-panel" aria-label="Условия перемирия" aria-live="polite">
          <header><Handshake size={15} /><span><small>Перемирие · раунд {truce.round ?? combat.round ?? 1}</small><strong>Говорит {truce.leader_name || 'предводитель уцелевших'}</strong></span></header>
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
        </section></SituationalSlot>}
        {guardEncounter && <SituationalSlot id="guard" icon={<ShieldAlert size={14} />} label="Стража" open={openSituational === 'guard'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="guard-panel" aria-label="Встреча со стражей" aria-live="polite">
          <header><ShieldAlert size={15} /><span><small>Стража · {guardEncounter.place_name || 'поселение'}</small><strong>{guardEncounter.officer_rank || 'стражник'} {guardEncounter.officer_name || ''}</strong></span></header>
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
        </section></SituationalSlot>}
        {showLootAftermath && victoryEntry && <SituationalSlot id="aftermath" icon={<Coins size={14} />} label="После боя" open={openSituational === 'aftermath'} onToggle={toggleSituational} onClose={closeSituational}><PostCombatLootSummary
          containers={sceneLoot}
          onClose={() => setDismissedVictoryId(victoryEntry.id)}
          onFocus={setFocusedLootId}
        /></SituationalSlot>}
        {lootChipVisible && <SituationalSlot id="loot" icon={<Gem size={14} />} label="Добыча" badge={sceneLoot.length} open={openSituational === 'loot'} onToggle={toggleSituational} onClose={closeSituational}>
        <LootPanel
          containers={sceneLoot}
          ghosts={vanishedLoot}
          reachFeet={lootReachFeet}
          actionCost={lootActionCost}
          actionSpent={lootActionSpent}
          players={players}
          actorId={typingActorId}
          enemies={state.enemies ?? []}
          canAct={canAct}
          busy={tacticalBusy}
          narrating={narrating}
          combatActive={combatActive}
          focusedId={focusedLootId}
          onFocus={setFocusedLootId}
          onLoot={onLootContainer}
        /></SituationalSlot>}
        {tavern && <SituationalSlot id="tavern" icon={<Beer size={14} />} label="Таверна" open={openSituational === 'tavern'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="tavern-panel" aria-label="Жизнь таверны" aria-live="polite">
          <header><Beer size={15} /><span><small>Заведение · {tavern.place_name || 'таверна'}</small><strong>{tavernRound ? 'Кость на столе' : 'Кости и выпивка'}</strong></span></header>
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
                    {/* «На мели» здесь было неправдой чаще, чем правдой: нулевой
                        `max_stake_cp` — это пустая **свободная** касса, а она пустеет и у
                        того, у кого деньги есть, но уже расписаны по открытым раундам с
                        другими героями (`tavernFreePurseFor`, `server/tavern-life.mjs`).
                        Отличить одно от другого доска не может и не должна: точной суммы
                        в кармане соседа в проекции нет намеренно. Поэтому и подпись, и
                        подсказки кнопок ниже говорят ровно то, что доске известно, —
                        свободных денег у соседа сейчас нет. Настоящую причину называет
                        отказ движка, который её знает (`TAVERN_OPPONENT_BROKE`). */}
                    <select
                      value={chosenTavernOpponentId}
                      disabled={tavernActionsBlocked || !tavernOpponents.length}
                      onChange={(event) => setTavernOpponentId(event.target.value)}
                    >
                      {tavernOpponents.length
                        ? tavernOpponents.map((npc) => <option key={npc.id} value={npc.id}>{npc.name}{npc.role ? ` (${npc.role})` : ''}{Number(npc.max_stake_cp ?? 0) > 0 ? '' : ' · свободных денег нет'}</option>)
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
                        : tavernOpponentMaxStakeCp < stake.stake_cp ? 'Столько соперник сейчас не закроет: свободных денег у него меньше' : `${stake.stake_cp} мм`}
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
                        ? 'Столько соперник сейчас не закроет: свободных денег у него меньше'
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
        </section></SituationalSlot>}
        {/* Почта отряда. Панель складная и по умолчанию закрыта: письмо — не
            срочное действие, и держать открытым бланк рядом с боем незачем.
            Показывается она только там, где почте есть смысл, — когда отряд
            знает хоть одного адресата или уже отправил хоть одно письмо. */}
        {(letterAddressees.length > 0 || heroLetters.length > 0) && <SituationalSlot id="letters" icon={<Mail size={14} />} label="Письма" badge={heroLettersInTransit.length} open={openSituational === 'letters'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="letters-panel" aria-label="Почта отряда" aria-live="polite">
          <header>
            <Mail size={15} />
            <span><small>Почта отряда{heroLettersInTransit.length ? ` · в пути: ${heroLettersInTransit.length}` : ''}</small><strong>Письма и курьеры</strong></span>
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
        </section></SituationalSlot>}
        {heldCaptives.length > 0 && <SituationalSlot id="captives" icon={<UserLock size={14} />} label="Пленники" badge={heldCaptives.length} open={openSituational === 'captives'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="captive-panel" aria-label="Пленники отряда">
          <header><UserLock size={15} /><span><small>Пленники · {heldCaptives.length}</small><strong>Судьба решается вами</strong></span></header>
          {heldCaptives.map((captive) => {
            const starving = captive.neglected_at_minutes != null
            return <article key={captive.id} className={`captive-card${starving ? ' starving' : ''}`}>
              <header>
                <i className="captive-tag">Пленник</i>
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
        </section></SituationalSlot>}
        {(beastCandidates.length > 0 || beastCompanions.length > 0) && <SituationalSlot id="beasts" icon={<PawPrint size={14} />} label="Звери" badge={beastCandidates.length + beastCompanions.length} open={openSituational === 'beasts'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="beast-panel" aria-label="Звери отряда">
          <header><PawPrint size={15} /><span><small>Звери · {beastCandidates.length + beastCompanions.length}</small><strong>Кого можно увести с собой</strong></span></header>
          {beastCompanions.map((companion) => <article key={companion.id} className="beast-card companion">
            <header>
              <i className="beast-tag companion">Спутник</i>
              <b>{companion.name}</b>
              <small>идёт с отрядом · в бой не вводится</small>
            </header>
            <p>На привале держит стражу: Восприятие лагеря идёт с преимуществом.</p>
            <div className="beast-actions">
              <button
                type="button"
                disabled={beastActionsBlocked || Boolean(companion.blocked_reason)}
                title={companion.blocked_reason === 'combat_active'
                  ? 'В бою зверь не отгоняет: это не боевой спутник'
                  : companion.blocked_reason === 'scare_cooldown'
                    ? `Зверь только что отогнал одну тварь: ждать ещё ${companion.scare_cooldown_minutes} мин игрового времени`
                    : 'Отогнать мелкую угрозу. Механики за этим нет — только строка в летописи'}
                onClick={() => onBeastAction(companion.id, 'scare')}
              ><Ear size={13} />Отогнать</button>
            </div>
          </article>)}
          {beastCandidates.map((candidate) => {
            // Досягаемость меряется по тому герою, которым игрок сейчас жмёт
            // кнопку: сервер прислал строку на каждого героя отряда той же
            // меркой, которой проверит команду. Своей геометрии у доски нет, и
            // «сосед стоит ближе» ответом на этот вопрос не является.
            //
            // Умолчание при отсутствующей строке — «далеко». Строка есть на
            // каждого героя отряда всегда, даже в сцене без карты
            // (`distance_feet: null`, `out_of_reach: false`), поэтому её
            // отсутствие означает одно из двух: вкладка со старым клиентом
            // после выкладки или герой не из отряда. В обоих случаях горящая
            // кнопка — обещание, которое сервер отобьёт `BEAST_OUT_OF_REACH`.
            const reach = candidate.reach_by_hero?.[typingActorId]
            const outOfReach = reach?.out_of_reach !== false
            return <article key={candidate.id} className={`beast-card${candidate.diet === 'predator' ? ' predator' : ''}${outOfReach ? ' out-of-reach' : ''}`}>
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
            {outOfReach && <p className="beast-reach">
              До зверя ещё идти{typeof reach?.distance_feet === 'number' ? `: ${reach.distance_feet} фт` : ''}. Подойдите вплотную.
            </p>}
            <div className="beast-actions">
              <button
                type="button"
                disabled={beastActionsBlocked || outOfReach || candidate.stage === 'calmed'}
                title={beastOffTurn
                  ? beastOffTurnTitle
                  : outOfReach
                  ? 'Сначала подойдите к зверю вплотную'
                  : candidate.stage === 'calmed'
                    ? 'Зверь успокоен и ждёт еды с руки'
                    : candidate.stage === 'fed' ? 'Позвать за собой: проверка против объявленной СЛ' : 'Проверка Ухода за животными против серверной СЛ'}
                onClick={() => onBeastAction(candidate.id, 'calm')}
              ><PawPrint size={13} />{candidate.stage === 'fed' ? 'Приручить' : 'Успокоить'}</button>
              <button
                type="button"
                disabled={beastActionsBlocked || outOfReach || candidate.stage !== 'calmed'}
                title={beastOffTurn
                  ? beastOffTurnTitle
                  : outOfReach
                  ? 'Еду с руки дают вплотную: сначала подойдите'
                  : candidate.stage === 'calmed' ? 'Дать еду с руки: паёк спишется из рюкзака' : 'С руки едят только успокоенные'}
                onClick={() => onBeastAction(candidate.id, 'feed')}
              ><Soup size={13} />Покормить</button>
            </div>
          </article>
          })}
        </section></SituationalSlot>}
        {!combatActive && <SituationalSlot id="rest" icon={<Flame size={14} />} label="Отдых" open={openSituational === 'rest'} onToggle={toggleSituational} onClose={closeSituational}>
        <section className="rest-controls" aria-label="Отдых">
          <header><Flame size={15} /><span><small>Передышка</small><strong>Отдых героя</strong></span></header>
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
        </section></SituationalSlot>}
        </div>
        {children}
      </aside>
      {/* Инспектор цели стоит у самой фишки, а не в правой колонке: это
          состояние наведения на доску, и читать его надо там же, где курсор.
          Якорь — рамка фишки в момент наведения; поповер не ловит указатель,
          чтобы не гасить наведение на саму фишку. Содержимое то же, что было
          в колонке: серверный прогноз, разбор броска, история урона. */}
      {combatMode !== 'magic' && inspectedTarget && inspectedAnchor && <div className="combat-target-popover" style={targetPopoverStyle(inspectedAnchor)} role="tooltip" aria-label={`Цель: ${inspectedTarget.name}`}>
          <div className={`combat-target-inspector ${inspectedTarget.allowed ? 'allowed' : 'blocked'}${inspectedBoss ? ' boss' : ''}`}>
            {/* Дистанция и причина берутся из серверного прогноза, когда он
                есть: снимок `inspectedTarget` делается в момент наведения и
                после перемещения показывал прежние футы. */}
            {/* Крупный портрет — только у босса, и он читается с доски: это
                тот же снимок, что и в ленте, только в размер карточки. Признак
                берётся из состояния по идентификатору, а не из снимка
                наведения: снимок делается один раз, а запас тратится и
                восстанавливается прямо во время боя. */}
            {inspectedBoss && <span className="combat-target-portrait">
              {inspectedBoss.image ? <img src={inspectedBoss.image} alt="" /> : <EnemyGlyph kind={enemyVisualKind(inspectedBoss)} />}
              {/* Подпись не прячется от чтения с экрана: «босс» — это факт о
                  порядке боя, а не украшение рамки. */}
              <b><Crown size={11} aria-hidden="true" />Босс</b>
            </span>}
            <span><small>{inspectedTarget.team === 'enemy' ? 'Противник' : 'Союзник'} · {inspectedForecast?.distance_feet ?? inspectedTarget.distanceFeet} фт</small><strong>{inspectedTarget.name}</strong><em>{inspectedTarget.healthLabel ? `${inspectedTarget.healthLabel} · параметры скрыты` : `${inspectedTarget.hp}/${inspectedTarget.maxHp} ОЗ`}</em>{inspectedBoss?.legendary && <LegendaryPips legendary={inspectedBoss.legendary} />}</span>
            {(!inspectedForecast || !inspectedForecast.in_range) && <p>{inspectedTarget.reason}</p>}
            {inspectedForecast && <div className={`attack-forecast ${inspectedForecast.advantage && !inspectedForecast.disadvantage ? 'advantage' : inspectedForecast.disadvantage && !inspectedForecast.advantage ? 'disadvantage' : ''}`}>
              <header>
                {/* Пока КД цели не узнана, сервер не отдаёт и процент: при
                    известном бонусе атаки он однозначно выдаёт закрытую КД. */}
                <b>{!inspectedForecast.in_range ? '—' : inspectedForecast.hit_chance == null ? '?' : `${inspectedForecast.hit_chance}%`}</b>
                <span>{!inspectedForecast.in_range ? 'не достать' : inspectedForecast.hit_chance == null ? 'шанс неизвестен' : 'шанс попасть'}<small>{inspectedForecast.label}{!inspectedForecast.in_range
                  ? ` · ${inspectedForecast.unreachable_reason}`
                  : inspectedForecast.critical_on_hit ? ' · попадание станет критом'
                    : inspectedForecast.critical_chance != null ? ` · крит ${inspectedForecast.critical_chance}%` : ''}</small></span>
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
              <small>История урона</small>
              <ol>{inspectedDamageHistory.map((entry) => <li key={entry.id}>
                <span>{entry.round != null ? `Р${entry.round}` : entry.sceneTurn != null ? `Х${entry.sceneTurn}` : '·'}</span>
                <b>−{entry.amount}</b>
                {/* Вид урона называется тем же словом, что и в строке хроники:
                    словарь общий, и «колющий» под фишкой не расходится с
                    «колющего» в журнале. */}
                <em>{actorNameById(entry.actorId) || 'источник'}{entry.damageType ? ` · ${(damageTypeLabel(entry.damageType) || entry.damageType).toLocaleLowerCase('ru')}` : ''}</em>
              </li>)}</ol>
            </div>}
          </div>
      </div>}
      <div className="dialogue-composer">
      <div className="composer-resize" role="separator" aria-orientation="horizontal" aria-label="Высота поля ввода" aria-valuenow={composerHeight || undefined} tabIndex={0} onPointerDown={startComposerResize} onKeyDown={resizeComposerWithKeys} onDoubleClick={() => { setComposerHeight(0); viewerStorage.remove(COMPOSER_HEIGHT_KEY) }} title="Потяните вверх или вниз, чтобы изменить высоту поля. Стрелки — по шагу, двойной щелчок — обычная"><i aria-hidden="true" /></div>
      <form
        className="rail-free-input"
        onSubmit={async (event) => {
          event.preventDefault()
          if (composerBlocked) return
          const text = freeText.trim()
          if (!conversationOnly && pendingCommand) {
            const outcome = await confirmPreparedCommand(text || undefined)
            if (outcome?.ok) updateFreeText('')
            return
          }
          if (!conversationOnly && selfCastReady) {
            const outcome = await confirmSelfCast(text || undefined)
            if (outcome?.ok) updateFreeText('')
            return
          }
          if (!text) return
          const outcome = await onFreeAction(text, requestKind)
          if (outcome.ok) updateFreeText('')
        }}
      >

        {/* Вид реплики — переключателем под полем, как в прототипе стола: три
            варианта видны сразу и меняются одним щелчком. */}
        <div className="request-kind" role="radiogroup" aria-label="Тип реплики">
          {REQUEST_KIND_OPTIONS.map(([kind, label, title]) => <button
            type="button"
            key={kind}
            role="radio"
            aria-checked={requestKind === kind}
            className={requestKind === kind ? 'active' : ''}
            disabled={narrating}
            title={title}
            onClick={() => { setRequestKind(kind); clearPrepared() }}
          >{label}</button>)}
        </div>
        <div className="rail-input-shell">
          {preparedLabel && <span className={`prepared-chip ${awaitingTarget ? 'awaiting' : ''}`}><CombatIcon id="prepared-command" kind="roll" hint="выбранное действие" size={15} compact /><b>{preparedLabel}</b><button type="button" onClick={clearPrepared} aria-label="Снять выбранное действие"><X size={12} /></button></span>}
          <textarea
            rows={2}
            ref={freeInputRef}
            style={composerHeight ? { height: composerHeight } : undefined}
            value={freeText}
            onChange={(event) => updateFreeText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={requestKind === 'question' ? 'Спросите о ситуации или возможном действии' : requestKind === 'discussion' ? 'Предложите план товарищам — герой пока не действует' : preparedLabel ? 'Добавьте слова к действию — или отправьте как есть' : combatActive ? 'Что вы делаете?' : 'Ваше действие или «продолжим»'}
            aria-label={requestKind === 'question' ? 'Вопрос ведущему' : requestKind === 'discussion' ? 'Обсуждение с отрядом' : 'Действие своими словами'}
            disabled={composerBlocked}
            title={narrating ? 'Рассказчик разрешает предыдущее действие' : combatActive && !canAct ? `Сейчас ходит ${activeName}` : 'Отправить намерение от имени выбранного героя'}
          />
          <VoiceInput key={state.sessionCode + turnActorId} value={freeText} onChange={updateFreeText} disabled={composerBlocked} />
        </div>
        <button type="submit" disabled={composerBlocked || ((conversationOnly || !preparedLabel || awaitingTarget) && !freeText.trim())} title={narrating ? 'Рассказчик разрешает предыдущее действие' : combatActive && !canAct ? `Сейчас ходит ${activeName}` : awaitingTarget ? 'Сначала выберите цель на карте' : !preparedLabel && !freeText.trim() ? 'Сначала опишите действие' : 'Отправить действие'}><Send size={17} />Отправить</button>
      </form>
      </div>
      <section className="turn-rail">
        {/* Ручка высоты: тянется вверх и вниз, значение переживает перезагрузку. */}
        <div className="rail-resize" role="separator" aria-orientation="horizontal" aria-label="Высота нижней панели" onPointerDown={startRailResize} onDoubleClick={() => { setRailHeight(0); window.localStorage.removeItem(RAIL_HEIGHT_KEY) }} title="Потяните, чтобы изменить высоту. Двойной щелчок — вернуть обычную" />
      {/* Свободный ввод присутствует во ВСЕХ состояниях, включая бой. Продуктовые
          принципы 2 и 3 требуют, чтобы предложения интерфейса не были границами;
          раньше в бою на месте этого поля стоял только хотбар, и у принципа не было
          носителя в UI. Ход не расходуется до подтверждённого сервером броска. */}
        {/* Колоды стоят у карты, а выбранная команда подтверждается
          той же формой реплики под хроникой. */}
        {/* Герой — левой колонкой панели: портрет, ОЗ и состояния рядом с
            его действиями, как в прототипе стола. */}
        {playerHud && <div className="turn-rail-hero turn-rail-player-hud">{playerHud}</div>}
        {/* Лоток ресурсов хода над плитками, как в BG3: камни действия, бонуса
            и реакции (щелчок — показать только плитки этой цены), классовые
            запасы и ячейки по кругам (щелчок — только заклинания круга). */}
        <div className="hud-tray" role="group" aria-label={`Ресурсы хода: ${railName}`}>
          {combatActive && !(ownHero && ownDeathSaves) && <div className="hero-cluster-pips" role="group" aria-label="Экономика хода">
            {railPips.map((pip) => <button type="button" key={pip.id}
              className={`hero-pip ${pip.id} ${pip.ready ? 'ready' : 'spent'} ${costFilter === pip.id ? 'filtering' : ''}`}
              aria-pressed={costFilter === pip.id} disabled={Boolean(viewerHero)}
              onClick={() => setCostFilter((current) => current === pip.id ? null : pip.id)}
              title={`${pip.label}: ${pip.note || (pip.ready ? 'доступно' : 'потрачено')}. Щелчок — показать только плитки этой цены`}
            ><i className="hero-pip-shape" aria-hidden="true" /><span>{pip.label}</span><b>{pip.id === 'action' ? railActionCount : Number(pip.ready)}</b></button>)}
          </div>}
          {railClassPoolRows.length > 0 && <div className="hero-cluster-resources" role="group" aria-label="Классовые запасы">
            {railClassPoolRows.map((row) => <span key={row.keys.join('+')}
              className={`hero-resource class-pool ${row.current > 0 ? 'ready' : 'spent'}`}
              title={heroResourceTitle(row.keys, row.current, row.max)} aria-label={heroResourceTitle(row.keys, row.current, row.max)}
            ><em>{heroResourceShortLabel(row.keys[0])}</em>{row.max <= 6
              ? <i aria-hidden="true">{Array.from({length:row.max}, (_,index) => <u key={index} className={index < row.current ? '' : 'spent'} />)}</i>
              : <b>{row.current}/{row.max}</b>}</span>)}
          </div>}
          {/* Ячейки по кругам — в лотке, как в BG3. */}
          <SpellSlotBar
            resources={railResources}
            filterLevel={slotLevelFilter}
            concentration={(viewerHero ?? activeHero) ? heroStatusForActor(state, (viewerHero ?? activeHero)!.id).concentration : null}
            onToggleLevel={(level) => {
              setSlotLevelFilter((current) => current === level ? null : level)
              setActiveDeck((current) => current === 'all' ? 'all' : 'magic')
            }}
          />
        </div>
        <div className="hotbar-decks">
        {/* Колоды и их счётчики — ходящего героя; в чужой ход их нет, как и плиток. */}
        <nav className="hotbar-tabs" role="tablist" aria-label="Категории действий" hidden={Boolean(viewerHero)}>
          {([
            ['all', 'Все', <Sparkles size={18} />],
            ['common', 'Основные', <Footprints size={18} />],
            ['weapon', 'Атаки', <Swords size={18} />],
            ['magic', 'Заклинания', <Sparkles size={18} />],
            ['class', 'Классовые', <Shield size={18} />],
            ['items', 'Предметы', <Gem size={18} />],
          ] as Array<[CombatDeck, string, React.ReactNode]>).map(([deck, label, icon]) => <button type="button" key={deck} role="tab" aria-selected={activeDeck === deck} className={activeDeck === deck ? 'active' : ''} onClick={() => setActiveDeck(deck)} disabled={tacticalBusy} title={`${label}: ${DECK_HINTS[deck]}${deckCounts[deck] ? ` · плиток: ${deckCounts[deck]}` : ''}`}>{icon}<span>{label}</span>{deckCounts[deck] > 0 && <b className="hotbar-tab-count" aria-label={`плиток: ${deckCounts[deck]}`}>{deckCounts[deck]}</b>}</button>)}
        </nav>
        {!combatActive && <button
          type="button"
          className="group-decision-button"
          disabled={leaveLocationDisabled || narrating || tacticalBusy || Boolean(guardEncounter)}
          onClick={onLeaveLocation}
          title={guardEncounter
            ? 'Стража стоит перед отрядом — сначала ответьте офицеру'
            : leaveLocationDisabled
              ? 'Сначала завершите текущее действие или проверку'
            : 'Предложить отряду покинуть локацию. Переход начнётся после решения группы'}
        ><DoorOpen size={18} /><span>Решение группы</span></button>}
        {showStartCombat && <button type="button" className="start-combat-button" disabled={!canAct || tacticalBusy} onClick={onStartCombat} title="Бросить инициативу и начать бой"><Swords size={18} /><span>Начать бой</span></button>}
        {combatActive && <div className="hotbar-combat-controls">
            {combatActive && !truce && <button
              className="parley-hotbar"
              disabled={!canAct || tacticalBusy || narrating || Boolean(state.pendingCheck) || !actionReady}
              onClick={() => { void onProposeParley('persuasion') }}
              title={canAct && !actionReady
                ? 'Действие на этом ходу уже потрачено: переговоры станут доступны в следующий ход'
                : parleyAttempted
                ? 'Повторный окрик в этом бою идёт с помехой. Тратит действие; отклик решает мораль противника'
                : 'Проверка Убеждения против серверной СЛ по морали противника. Тратит действие'}
            ><CombatIcon id="propose-parley" kind="action" hint="переговоры перемирие поговорить" size={18} compact /><span>{parleyAttempted ? 'Переговоры (помеха)' : 'Переговоры'}</span></button>}
            {/* Переключатель, как «Не убивать» макета: флаг `knock_out` уходит
                с ближайшей атакой ближнего боя, сервер сам решает, сработал ли он. */}
            {combatActive && knockoutEligible && <button className={`knockout-turn-toggle hud-toggle ${knockOut ? 'active' : ''}`} disabled={tacticalBusy} aria-pressed={knockOut} onClick={() => setKnockOut((current) => !current)} title='Не убивать: удар, сводящий ОЗ к нулю, оставит цель с 1 ОЗ без сознания. Только ближний бой'><i aria-hidden="true" /><span>Не убивать</span></button>}
            {combatActive && selectedItem && needsWeaponChange && <button disabled={!canAct || tacticalBusy || !actionReady} onClick={() => selected && onChangeWeapon(selected, selectedItem.id)}><CombatIcon id={`swap-${selectedItem.id}`} kind="swap" hint={`сменить оружие ${selectedItem.name}`} size={18} compact /><span>Сменить оружие</span></button>}
        </div>}
        </div>
      {/* Панель одна на оба режима. Раньше вне боя вместо неё показывалась полоска
          «исследование», а колоды и плитки не рендерились вовсе: игрок не видел, чем
          вообще владеет герой, пока не бросит инициативу. Место под панель в сетке
          зарезервировано всегда, поэтому показывать арсенал ничего не стоит. */}
      <section className={`tactical-control combat-hotbar ${combatActive ? '' : 'out-of-combat'}`} aria-label={combatActive ? `Панель боевых действий: ${activeName}` : `Панель действий вне боя: ${activeName}`}>
        <div className="hotbar-main">
          {/* Замок защищает сохранённую расстановку плиток от перетаскивания. */}
          <div className="tile-toolbar" role="group" aria-label="Настройки панели действий">
            <button type="button" className={tilesLocked ? '' : 'active'} aria-pressed={!tilesLocked} onClick={() => { const next = !tilesLocked; setTilesLocked(next); window.localStorage.setItem(TILE_LOCK_KEY, next ? 'locked' : 'unlocked') }} title={tilesLocked ? 'Разблокировать: плитки можно перетаскивать' : 'Заблокировать: расстановка сохранится'}>{tilesLocked ? <Lock size={15} /> : <LockOpen size={15} />}</button>
          </div>
          {/* Кнопки хода живут внутри карточки действий, прижатые к её правому
              краю: они завершают тот же выбор, что и плитки, а отдельной колонкой
              между колодой и описанием рвала строку надвое. Прокрутка плиток их
              не уносит — они лежат рядом с областью прокрутки, а не в ней. */}
          <div className="hotbar-actions-shell">
          {/* Пока выборка держится, её видно словами, а не только рамкой
              пипса: снять её можно и мышью, и Escape. Чип стоит у нижней
              кромки карточки, а не строкой кластера: это контекст колоды. */}
          {combatActive && costFilter && <p className="hero-cluster-filter" role="status">Показаны: {HOTBAR_COST_FILTER_LABELS[costFilter]} · <button type="button" onClick={() => setCostFilter(null)} title="Снять фильтр стоимости (Escape)">сбросить</button></p>}
          {/* Чужой ход: плитки ходящего героя второму игроку не нужны — нажать
              их он всё равно не может, а читал как свои (плейтест 2026-10-02). */}
          {combatActive && foreignTurn && <p className="hotbar-foreign-turn" role="status">Сейчас ходит <b>{foreignTurn.turnName}</b>. Ваш герой — {foreignTurn.heroName}: действия героя откроются в ваш ход.</p>}
          <div className={`hotbar-actions${activeDeck === 'all' ? ' sectioned' : ''}`} role="tabpanel" aria-label="Доступные действия" ref={hotbarActionsRef} hidden={Boolean(combatActive && foreignTurn)} style={{ '--tile-cols': tileColumns, '--hud-rows': hudRows } as React.CSSProperties}>
            {/* Пустых гнёзд нет: свободную ширину забирают подписи малых секций. */}
            {hotbarSections.map((section, index) => <Fragment key={section.id}>
              {index > 0 && <span className="hotbar-section-divider" aria-hidden="true" />}
              <div className={`hotbar-section ${section.id}${largestSection === section ? ' compact' : ''}`} role="group" aria-label={HOTBAR_SECTION_LABELS[section.id]} style={{ '--section-cols': Math.max(1, Math.ceil(section.tiles.length / hudRows)) } as React.CSSProperties}>
                {section.tiles.map(({ id, node }) => cloneElement(node as React.ReactElement<Record<string, unknown>>, {
                  key: id,
                  draggable: !tilesLocked,
                  onDragStart: () => setDraggedTileId(id),
                  onDragOver: (event: React.DragEvent) => { if (!tilesLocked) event.preventDefault() },
                  onDrop: (event: React.DragEvent) => { event.preventDefault(); moveTile(id); setDraggedTileId(null) },
                  onDragEnd: () => setDraggedTileId(null),
                  className: `${(node.props as { className?: string }).className ?? ''}${tilesLocked ? '' : ' movable'}`,
                }))}
              </div>
            </Fragment>)}
            {((activeDeck === 'magic' && !spells.length) || (activeDeck === 'class' && !combatActions.some((action) => action.category === 'class')) || (activeDeck === 'items' && !combatItems.some((item) => item.type !== 'weapon'))) && <div className="hotbar-empty"><LockKeyhole size={18} /><span>У героя нет доступных действий этой категории</span></div>}
            {/* Фильтр может не оставить ничего — и тогда пустая карточка обязана
                сказать почему, иначе она читается как «у героя ничего нет». */}
            {costFilter && !visibleTiles.length && orderedTiles.length > 0 && <div className="hotbar-empty"><LockKeyhole size={18} /><span>В этой колоде нет плиток стоимостью «{HOTBAR_COST_FILTER_LABELS[costFilter]}»</span></div>}
          </div>
          {/* Кнопки шага: запертая дверь сохраняет два явных пути, в бою — ещё
              нокаут, смена оружия и завершение хода. Обычная дверь действует
              прямо по своему полотну на карте, поэтому второй кнопки здесь нет. */}
          {doorsAtHand.some((door) => door.state === 'locked') && <div className="hotbar-turn-controls">
            {doorsAtHand.filter((door) => door.state === 'locked').map((door) => {
              const direction = active ? doorDirectionFromActor(door, active) : ''
              const lockDc = Math.max(10, door.lockDc)
              const hoverProps = {
                onPointerEnter: () => setHoveredDoorId(door.id),
                onPointerLeave: () => setHoveredDoorId((current) => current === door.id ? null : current),
                onFocus: () => setHoveredDoorId(door.id),
                onBlur: () => setHoveredDoorId((current) => current === door.id ? null : current),
              }
              /* У запертой двери путей два, и оба стоят кнопками рядом:
                 отмычка у владеющего и плечо у всех. СЛ в подписи — это СЛ
                 **выламывания**, она была здесь и раньше; у взлома своей
                 подписи с числом нет, потому что сложность замка сервер не
                 объявляет. Кнопка отмычки не прячется без владения, а гаснет с
                 честной причиной: спрятанная кнопка ничему не учит. */
              return door.state === 'locked'
                ? <Fragment key={door.id}>
                    <button {...hoverProps} className="door-control locked" disabled={!canAct || tacticalBusy || !lockpickAllowed} onClick={() => selected && onOperateDoor(selected, door.id, 'lockpick')} title={lockpickAllowed ? `Запертая дверь на ${direction}. Вскрыть замок отмычкой: Ловкость и владение воровскими инструментами. Дверь останется целой. Тратит действие` : lockpickBlockedHint}><CombatIcon id={`door-lockpick-${door.id}`} kind="action" hint="взломать замок отмычкой воровские инструменты" size={27} compact /><span>Взломать дверь ({direction})</span></button>
                    <button {...hoverProps} className="door-control locked" disabled={!canAct || tacticalBusy} onClick={() => selected && onOperateDoor(selected, door.id, 'force')} title={`Запертая дверь на ${direction}. Проверка Силы (Атлетика), СЛ ${lockDc}. Дверь будет сломана. Тратит действие`}><CombatIcon id={`door-force-${door.id}`} kind="action" hint="выломать запертую дверь замок" size={27} compact /><span>Выломать дверь ({direction}, СЛ {lockDc})</span></button>
                  </Fragment>
                : null
            })}
           </div>}
           </div>
           {(combatActive || (combatMode === 'magic' && selectedSpell)) && <details className="hotbar-detail">
            <summary aria-label="Параметры действия" title="Параметры действия"><SlidersHorizontal size={15} /></summary>
            <div className="hotbar-detail-content">
            {combatMode === 'magic' && selectedSpell ? <>
              <DetailHeader title={selectedSpell.name} description={selectedSpell.description} meta={<>
                {selectedSpellRange > 0 ? <i className="detail-chip" title={`Дальность: ${selectedSpellRange} фт`}>{selectedSpellRange} фт</i> : <i className="detail-chip" title="Заклинание на себя">на себя</i>}
                {selectedSpell.concentration ? <i className="detail-chip mark" title="Требует концентрации">К</i> : null}
                {supportMark(selectedSpellSupport.status) ? <i className={`detail-chip mark support-${selectedSpellSupport.status}`} title={`${selectedSpellSupport.label}. ${selectedSpellSupport.explanation}`}>{supportMark(selectedSpellSupport.status)}</i> : null}
              </>} />
              <SpellComponentsLine spell={selectedSpell} />
              {selectedSpell.id === 'shillelagh' && <label className="spell-slot-picker" aria-label="Оружие для Дубинки">
                <span>В руке</span>
                <select
                  aria-label="Экземпляр оружия для Дубинки"
                  value={shillelaghItemId ?? ''}
                  disabled={!shillelaghHeldItems.length}
                  onChange={(event) => {
                    setSelectedSpellItemId(event.target.value)
                    setPendingCommand(null)
                    setAimCell(null)
                  }}
                >
                  {!shillelaghHeldItems.length && <option value="">Нет удерживаемой дубинки или боевого посоха</option>}
                  {shillelaghHeldItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>}
              {explicitSpellSource && selectedCastingSource && <label className="spell-slot-picker" aria-label="Источник заклинания">
                <span>Источник</span>
                <select aria-label="Источник заклинания" value={selectedCastingSource.resource} onChange={(event) => {
                  setSpellCastingSourceChoice(event.target.value)
                  setSpellSlotLevelChoice(null)
                  setSpellTargetIds([])
                  setPendingCommand(null)
                  setAimCell(null)
                }}>
                  {spellCastingSources.map((source) => <option key={source.resource} value={source.resource} disabled={!source.availability.ready}>{source.label}{source.availability.ready ? '' : ' · нет ресурса'}</option>)}
                </select>
              </label>}
              {/* Оговорка о полноте механики убрана из колонки: игроку она
                  ничего не даёт, а место занимала больше самого описания. Ярлык
                  статуса рядом остаётся, полный текст живёт в подсказке плитки. */}
              {selectedSpell.spellOptions?.length ? <div className="spell-option-picker" aria-label="Вариант заклинания">
                {selectedSpell.spellOptions.map((option) => <button key={option} className={selectedSpellOption === option ? 'selected' : ''} onClick={() => setSelectedSpellOption(option)}>{SPELL_OPTION_LABELS[option] ?? option}</button>)}
              </div> : null}
              {(availableSpellSlotLevels.length > 0 || explicitSpellSource && selectedSpellSlotLevel != null) && <label className="spell-slot-picker" aria-label="Круг ячейки">
                <span>Ячейка</span>
                <select
                  aria-label="Круг ячейки"
                  value={String(selectedSpellSlotLevel ?? '')}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setSpellSlotLevelChoice(Number.isSafeInteger(next) ? next : null)
                    setSpellTargetIds([])
                    setPendingCommand(null)
                    setAimCell(null)
                  }}
                >
                  {explicitSpellSource && selectedSpellSlotLevel != null && !availableSpellSlotLevels.includes(selectedSpellSlotLevel) && <option value={selectedSpellSlotLevel} disabled>{selectedSpellSlotLevel} круг · нет ячейки</option>}
                  {availableSpellSlotLevels.map((level) => {
                    const pool = activeResources[`spell_slots_${level}`]
                    return <option key={level} value={level}>{level} круг · {Number(pool?.current ?? 0)}/{Number(pool?.max ?? 0)}</option>
                  })}
                </select>
              </label>}
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
            {(weaponAbilityOptions.length > 1 || activeShillelaghAbility) && <div className="spell-option-picker weapon-attack-picker" aria-label="Характеристика атаки оружием">
              {activeShillelaghAbility && <button key="spellcasting" type="button" className={!selectedWeaponAbility ? 'selected' : ''} onClick={() => setAttackAbility(undefined)}>{SPELL_OPTION_LABELS[activeShillelaghAbility] ?? activeShillelaghAbility}</button>}
              {weaponAbilityOptions.map((ability) => <button key={ability} type="button" className={selectedWeaponAbility === ability ? 'selected' : ''} onClick={() => setAttackAbility(ability)}>{WEAPON_ATTACK_ABILITY_LABELS[ability]}</button>)}
            </div>}
            {sneakAttackEligible && <label className={`weapon-rider-toggle ${sneakAttack ? 'selected' : ''} ${sneakAttackSpent ? 'spent' : ''}`} title={sneakAttackSpent ? 'Коварная атака уже нанесла урон в этом ходу' : 'Добавить урон Коварной атаки, если сервер подтвердит условия'}>
              <input type="checkbox" checked={sneakAttack} disabled={tacticalBusy || sneakAttackSpent} onChange={(event) => setSneakAttack(event.target.checked)} />
              <span>{sneakAttackSpent ? 'Коварная атака использована' : 'Коварная атака'}</span>
            </label>}
            </>}
            </div>
          </details>}
        </div>
        <button type="button" className="own-action-tile" onClick={openChatForOwnAction} title="Своё действие: опишите словами — Рассказчик разберёт, а цена хода спишется так же, как с панели"><Feather size={22} aria-hidden="true" /><span>Своё действие</span></button>
        {tacticalBusy && <p className="tactical-command-status"><RefreshCw className={state.pendingAction?.status === 'ready' || state.pendingCheck?.status === 'ready' ? '' : 'spinning'} size={12} />{state.pendingAction?.status === 'ready' || state.pendingCheck?.status === 'ready' ? 'Сначала подтвердите предложение ведущего или откажитесь от него.' : 'Действие идёт, мир отзывается на него…'}</p>}
        {/* Отказ команды больше не рисуется здесь своей строкой: он уходит в
            общую ленту тостов над всем экраном (`ErrorToasts`). Раньше строка
            жила только под хотбаром и только в комнате, а следующий отказ
            затирал предыдущий. */}
      </section>
      {/* Правая колонка панели, как в прототипе стола: что осталось на ход,
          сколько шагов и чем его закончить. */}
      <aside className="turn-rail-side" aria-label={`Ход героя: ${activeName}`}>
        {/* Герой на нуле хитов: вместо камней хода — счёт спасбросков от
            смерти из `mechanics.death.saving_throws`. */}
        {ownHero && ownDeathSaves && <DeathSavesPanel
          name={ownHero.character}
          successes={ownDeathSaves.successes}
          failures={ownDeathSaves.failures}
          stable={ownDeathSaves.stable}
          dead={ownHeroDead}
        />}
        {!(ownHero && ownDeathSaves) && <div className="hotbar-hero-cluster player-resource-panel" aria-label={`Ресурсы героя: ${railName}`}>
          {combatActive && heroReactions.length > 0 && <div className="hud-reactions" role="group" aria-label={`Реакции героя${railReactionReady ? '' : ': реакция этого раунда потрачена'}`}>
            <span className="hud-side-title">Реакции</span>
            <div className="hud-reaction-grid">
              {/* Облачко — «спрашивать», серая — «никогда», без метки — «сразу».
                  Щелчок открывает режимы всех реакций героя. */}
              {heroReactions.slice(0, 6).map((reaction) => canSetReactionModes
                ? <button key={reaction.id} type="button" data-reaction-modes-anchor="" className={`hud-reaction mode-${reaction.mode}${railReactionReady ? '' : ' spent'}`} aria-haspopup="dialog" aria-expanded={reactionMenu?.focusId === reaction.id} aria-label={`${reactionModeTitle(reaction)}${railReactionReady ? '' : '; реакция этого раунда потрачена'}. Изменить режим`} title={`${reactionModeTitle(reaction)}${railReactionReady ? '' : '. Реакция этого раунда уже потрачена'}. Щелчок — режимы реакций`} onClick={(event) => openReactionModes(event.currentTarget, reaction.id)}><CombatIcon id={reactionIconId(reaction)} kind={reaction.kind === 'spell' ? 'spell' : 'action'} hint={reaction.name} size={34} compact />{reaction.mode === 'ask' && <ReactionAskMark />}</button>
                : <span key={reaction.id} className={`hud-reaction${railReactionReady ? '' : ' spent'}`} title={`${reaction.name} — реакция. Срабатывает в окне реакции, когда случится подходящее событие${railReactionReady ? '' : '. Реакция этого раунда уже потрачена'}`}><CombatIcon id={reactionIconId(reaction)} kind={reaction.kind === 'spell' ? 'spell' : 'action'} hint={reaction.name} size={34} compact /></span>)}
            </div>
          </div>}
          {state.mechanics?.movement?.[viewerHero?.id ?? turnActorId] && <div className="hero-cluster-speed" aria-label="Скорость героя">
            <span>Скорость: <b>{railMovement.currentSpeed} фт</b> · базовая {railMovement.baseSpeed} фт</span>
            {railMovement.effects.filter((effect) => effect.applied).map((effect) => <span key={effect.effect_id}>{effect.name} {effect.bonus_feet >= 0 ? '+' : ''}{effect.bonus_feet} фт</span>)}
          </div>}

          {railMovement.blockedReason && <p className="hero-cluster-movement-note" role="status">{railMovement.blockedReason}</p>}
          {railMovement.effects.length > 0 && <ul className="hero-cluster-movement-effects" aria-label="Эффекты скорости">
            {railMovement.effects.map((effect) => <li key={effect.effect_id}>{effect.name} · ещё {movementEffectTimeLabel(effect.remaining_seconds)}{effect.applied ? '' : ' · бонус не используется'}</li>)}
          </ul>}
          {combatActive && !viewerHero && weaponAttacksUsed > 0 && weaponAttacksLeft > 0 && <small>Атак в действии осталось: {weaponAttacksLeft}</small>}
           {/* Вне боя — справка героя, как `.infob` макета: пассивная
               внимательность из листа и кости хитов из `mechanics.hit_point_dice`. */}
           {!combatActive && activeHero && (activeHero.characterSheet?.passive_perception != null || hitPointDice) && <dl className="hud-infob" aria-label="Справка героя">
             {activeHero.characterSheet?.passive_perception != null && <div title="Пассивная Мудрость (Внимательность): что герой замечает, не тратя действий"><dt>Пасс. внимательность</dt><dd>{activeHero.characterSheet.passive_perception}</dd></div>}
             {hitPointDice && <div title="Кости хитов тратятся на коротком отдыхе, восстанавливаются после долгого"><dt>Кости хитов</dt><dd>{hitPointDiceRemaining}/{hitPointDice.maximum} · к{hitPointDice.die_size}</dd></div>}
           </dl>}
           {/* Камни хода, классовые запасы и ячейки — в лотке над плитками. */}
           {/* Вне боя на месте реакций — отдых, почта и режимы реакций. Кнопки
               отдыха и писем открывают те же панели, что чипы хроники;
               свёрнутую хронику сначала разворачивают. */}
           {!combatActive && <div className="hud-modes" role="group" aria-label="Отдых и режимы">
             <span className="hud-side-title">Отдых и режимы</span>
             <div className="hud-mode-grid">
               <button type="button" className={`hud-mode${openSituational === 'rest' ? ' open' : ''}`} aria-expanded={openSituational === 'rest'} onClick={() => { toggleChat(false); toggleSituational('rest') }} title="Короткий или долгий отдых: восстановление считает сервер"><Flame size={18} aria-hidden="true" /><span>Отдых</span></button>
               {(letterAddressees.length > 0 || heroLetters.length > 0) && <button type="button" className={`hud-mode${openSituational === 'letters' ? ' open' : ''}`} aria-expanded={openSituational === 'letters'} onClick={() => { toggleChat(false); toggleSituational('letters') }} title="Почта отряда: письма и курьеры"><Mail size={18} aria-hidden="true" /><span>Письма</span>{heroLettersInTransit.length > 0 && <b aria-label={`в пути: ${heroLettersInTransit.length}`}>{heroLettersInTransit.length}</b>}</button>}
               {canSetReactionModes && <button type="button" data-reaction-modes-anchor="" className={`hud-mode${reactionMenu ? ' open' : ''}`} aria-haspopup="dialog" aria-expanded={Boolean(reactionMenu)} onClick={(event) => openReactionModes(event.currentTarget)} title="Режимы реакций: спрашивать, сразу или никогда"><RefreshCw size={18} aria-hidden="true" /><span>Реакции</span></button>}
             </div>
           </div>}
        </div>}
        {/* Завершение хода — главное решение этого ряда, и выглядит оно так
            же: выше соседей, в золоте отправки. Когда тратить больше нечего,
            рамка мягко пульсирует; при `prefers-reduced-motion` она просто
            светлее. Подсказка не хвалит кнопку, а перечисляет, что игрок
            уносит с собой неистраченным. */}
        {/* Кольцо вокруг кнопки — остаток движения, как в BG3: смотреть на
            него приходится ровно тогда, когда решаешь, заканчивать ли ход. */}
        {combatActive && <div className="end-turn-dock">
          {canAct && bonusReady && !turnFullySpent && <span className="end-turn-tag" title="Бонусное действие этого хода ещё не потрачено">▲ бонус не потрачен</span>}
          <div className="end-turn-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle className="track" cx="60" cy="60" r="55" pathLength="100" />
              <circle className="fill" cx="60" cy="60" r="55" pathLength="100" strokeDasharray={`${Math.round((railMovementAvailable ? railMovementRatio : 0) * 1000) / 10} 100`} />
            </svg>
            <button
          className={`end-turn-hotbar ${turnFullySpent ? 'exhausted' : ''}`}
          disabled={!canAct || tacticalBusy}
          onClick={requestFinishTurn}
          aria-haspopup={turnFullySpent || skipEndTurnConfirm ? undefined : 'dialog'}
          title={turnFullySpent
            ? 'Ресурсы хода израсходованы. Завершить ход — клавиша «Пробел»'
            : `Остались: ${unspentTurnResources.join(', ')}. Завершить ход — клавиша «Пробел»`}
        ><CombatIcon id="end-turn" kind="end-turn" hint="завершить ход" size={22} compact /><span>Завершить ход<kbd>Пробел</kbd></span></button>
          </div>
          {endTurnConfirm && canAct && <div className="end-turn-confirm" role="alertdialog" aria-label="Завершить ход?" aria-describedby="end-turn-confirm-list">
            <b>Завершить ход?</b>
            <span>Ещё можно:</span>
            <ul id="end-turn-confirm-list">{unspentTurnResources.map((item) => <li key={item}>{item}</li>)}</ul>
            <div className="end-turn-confirm-actions">
              <button type="button" className="confirm" onClick={onFinishTurn} disabled={tacticalBusy}>Завершить</button>
              <button type="button" onClick={() => setEndTurnConfirm(false)} autoFocus>Вернуться</button>
            </div>
            <label><input type="checkbox" checked={skipEndTurnConfirm} onChange={(event) => setSkipEndTurnConfirm(event.target.checked)} /> Не спрашивать до конца боя</label>
          </div>}
          <small className={`end-turn-move${railMovementAvailable && railRemainingFeet > 0 ? '' : ' spent'}`} title={railMovement.blockedReason ?? undefined}>{railMovement.blockedReason ? 'Движение недоступно' : `Осталось ${railMovementAvailable ? railRemainingFeet : 0} из ${railSpeedFeet} фт`}</small>
        </div>}
      </aside>
      <TileTooltip tip={tileTip} />
      {upcastPrompt && selectedSpell?.id === upcastPrompt.spellId && combatMode === 'magic' && <UpcastPopover
        spellName={selectedSpell.name}
        baseLevel={selectedSpell.level}
        pools={spellSlotPools(activeResources).levels.map((pool) => availableSpellSlotLevels.includes(pool.level) ? pool : { ...pool, current: 0 })}
        selectedLevel={selectedSpellSlotLevel}
        anchor={upcastPrompt.anchor}
        onPick={(level) => {
          setSpellSlotLevelChoice(level)
          setSpellTargetIds([])
          setPendingCommand(null)
          setAimCell(null)
          setUpcastPrompt(null)
        }}
        onClose={closeUpcastPrompt}
      />}
      </section>
      {reactionMenu && reactionHero && canSetReactionModes && <ReactionModesPanel
        heroName={reactionHero.character}
        reactions={heroReactions}
        busy={tacticalBusy}
        focusId={reactionMenu.focusId}
        anchorElement={reactionMenu.anchorElement}
        onSet={setReactionMode}
        onClose={() => setReactionMenu(null)}
      />}
    </>
  )
}
