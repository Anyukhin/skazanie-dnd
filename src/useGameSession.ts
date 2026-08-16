import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyState } from './data'
import {
  ApiRequestError,
  autoRollEnabled,
  fetchWithTimeout,
  generateItemImage,
  isStateVersionConflictError,
  narrateWithAgent,
  publishNarrationPreview,
  rollDice,
  rollSharedDie,
} from './ai-client'
import type { NarrationPreview, NarrationPreviewPhase } from './ai-client'
import { playerMessage } from './game-engine'
import { forgetSceneMaps, latestSceneMapHash, resolveSceneMap } from './scene-map-cache'
import { canIssueUiTacticalCommand } from './tactical-command-guard.mjs'
import type { AgentInteraction, AiTurnResult, CombatVisualBatch, DiceRollEvent, EncounterDifficulty, EncounterProposal, EncounterTheme, GameEvent, GameState, GuardResolution, InventoryItem, ItemUseOptions, LetterAddresseeKind, LootContainersProjection, Merchant, MerchantView, Message, ParleyOutcome, Player, RestCommand, RollResult, SceneObjectIntent, TavernDiceApproach, TwoPhaseCheckCommand } from './types'

const ACTIVE_CAMPAIGN_KEY = 'skazanie-active-campaign-v2'
const channelNameFor = (campaignId: string) => `skazanie-room:${String(campaignId || '').toUpperCase()}`

export type CaptiveInterrogationSkill = 'persuasion' | 'intimidation'
export type CaptiveAction = 'interrogate' | 'release' | 'hand-over' | 'feed' | 'execute'
/** Что герой делает со зверем. Список закрыт сервером (`server/beast-taming.mjs`). */
export type BeastAction = 'calm' | 'feed' | 'scare'

type TacticalCommand =
  | { command_type: 'StartCombat'; actor_id: string }
  | { command_type: 'MoveActor'; actor_id: string; to: { x: number; y: number } }
  | { command_type: 'MakeAttack'; actor_id: string; target_id: string; item_id?: string; attack_mode?: 'melee' | 'ranged' | 'thrown' | 'two-handed'; attack_ability?: 'str' | 'dex'; sneak_attack?: boolean; knock_out?: boolean }
  | { command_type: 'MakeAreaAttack'; actor_id: string; item_id: string; to: { x: number; y: number } }
  | { command_type: 'CastSpell'; actor_id: string; spell_id: string; target_id: string; spell_option?: string; knock_out?: boolean }
  | { command_type: 'CastSpell'; actor_id: string; spell_id: string; to: { x: number; y: number }; spell_option?: string }
  | { command_type: 'UseCombatAction'; actor_id: string; action_id: string; target_id?: string; item_id?: string }
  | { command_type: 'ChangeWeapon'; actor_id: string; item_id: string }
  | { command_type: 'OperateDoor'; actor_id: string; door_id: string; intent: 'open' | 'close' | 'force' }
  | { command_type: 'OperateSceneObject'; actor_id: string; prop_id: string; intent: SceneObjectIntent }
  | { command_type: 'UseLevelTransition'; actor_id: string; prop_id: string }
  | { command_type: 'EndTurn'; actor_id: string }
  | { command_type: 'ProposeParley'; actor_id: string; skill: 'persuasion' | 'intimidation' }
  | { command_type: 'SettleParley'; actor_id: string; outcome: ParleyOutcome }
  | { command_type: 'ResolveHeroDeath'; actor_id: string; resolution: 'resurrect' | 'replace'; replacement_name?: string }
  | { command_type: 'EquipItem'; actor_id: string; item_id: string; equipped: boolean }
  | { command_type: 'UseItem'; actor_id: string; item_id: string; target_id?: string; charges_to_spend?: number; to?: { x: number; y: number }; use_mode?: 'spill'; weapon_id?: string }
  | { command_type: 'TransferItem'; actor_id: string; item_id: string; recipient_id: string; quantity: number }
  | { command_type: 'AttuneItem'; actor_id: string; item_id: string; attuned: boolean }
  | { command_type: 'ActivateItem'; actor_id: string; item_id: string; activated: boolean }
  | { command_type: 'InterrogateCaptive'; actor_id: string; captive_id: string; skill: CaptiveInterrogationSkill }
  | { command_type: 'ReleaseCaptive'; actor_id: string; captive_id: string }
  | { command_type: 'HandCaptiveToGuards'; actor_id: string; captive_id: string }
  | { command_type: 'FeedCaptive'; actor_id: string; captive_id: string }
  | { command_type: 'ExecuteCaptive'; actor_id: string; captive_id: string }
  | { command_type: 'CalmBeast'; actor_id: string; beast_id: string }
  | { command_type: 'FeedBeast'; actor_id: string; beast_id: string }
  | { command_type: 'ScareWithBeast'; actor_id: string; beast_id: string }
  | { command_type: 'ResolveGuardEncounter'; actor_id: string; resolution: GuardResolution; skill: 'stealth' | 'athletics' }
  // Обыск: только ключи. Название, вес, цена и механика вещи лежат в самом
  // контейнере — клиент их не называет и назвать не может.
  | { command_type: 'LootContainer'; actor_id: string; container_id: string; lines: Array<{ item_instance_id: string; quantity: number }>; recipient_id?: string }
  | { command_type: 'OpenTavernDiceRound'; actor_id: string; npc_id: string; stake_cp: number }
  | { command_type: 'AnswerTavernDiceRound'; actor_id: string; approach: TavernDiceApproach }
  | { command_type: 'LeaveTavernDiceRound'; actor_id: string }
  | { command_type: 'OrderTavernDrink'; actor_id: string }
  | { command_type: 'SendLetter'; actor_id: string; addressee_kind: LetterAddresseeKind; addressee_id: string; body: string }
  | { command_type: 'ReceiveNpcBlessing'; actor_id: string; npc_id: string }
  | { command_type: 'ImportCharacter'; actor_id: string; document: unknown }
  | { command_type: 'LevelUp'; actor_id: string; expected_level: number }

/**
 * Двухфазная ли это команда — та, у которой первая фаза возвращает карточку
 * броска, а не результат.
 *
 * Список закрыт и обязан совпадать с серверным (`server/game-orchestrator.mjs`:
 * `parleyCheckCard`, `guardEscapeCheckCard`, `tavernDiceCheckCard`,
 * `beastTamingCheckCard`, `shrinePrayerCheckCard`). Отдельная
 * функция здесь стоит вместо трёх сравнений по месту потому, что забыть одно из
 * них уже удалось: карточка приходит с сервера, клиент её не показывает, и ход
 * зависает без единой ошибки в консоли.
 *
 * `OperateSceneObject` двухфазна **не целиком**, а ровно одним глаголом: кость
 * бросает только молитва. Осмотр, взлом и поджог решаются серверным броском в
 * тот же запрос, и просить у них карточку значило бы вешать ход на кубик,
 * которого сервер не объявит.
 */
function twoPhaseCheckCommandFor(command: TacticalCommand): TwoPhaseCheckCommand | null {
  switch (command.command_type) {
    case 'ProposeParley':
    case 'ResolveGuardEncounter':
    case 'AnswerTavernDiceRound':
    case 'CalmBeast':
      return command
    case 'OperateSceneObject':
      return command.intent === 'pray' ? command : null
    default:
      return null
  }
}

type CharacterBuildCommand =
  | {
      command_type: 'SetCharacterChoices'
      actor_id: string
      subclass: string
      class_skill_proficiencies: string[]
      selected_feature_ids: string[]
    }
  | {
      command_type: 'SetSpellSelections'
      actor_id: string
      known_spell_ids: string[]
      prepared_spell_ids: string[]
    }

type TacticalCommandResult = {
  authoritative_state?: GameState
  narration?: string
  mechanics?: GameEvent[]
  npc_turns?: CombatVisualBatch['npcTurns']
  room_version?: number
  state_version?: number
  turn_id?: string | null
  narration_message_id?: string | null
  narration_speaker?: 'narrator' | 'system'
  narration_author?: string
  /**
   * Первая фаза ручного броска: сервер объявил проверку и ничего не
   * закоммитил. Приходит только у двухфазных команд доски (парлей).
   */
  check?: { check_id?: string; label: string; modifier: number; difficulty: number; sides: 20; ability?: string | null; skill?: string | null; advantage?: boolean; disadvantage?: boolean } | null
  error?: string
  code?: string
  /**
   * Свежий список добычи в **отказе**: сервер прикладывает его к конфликту
   * версии и к кодам `LOOT_*`, означающим «содержимое под тобой изменилось»
   * (`server/index.mjs`). Приходит только вместе с `error`.
   */
  loot_containers?: LootContainersProjection
}

export type CommandOutcome =
  | { ok: true }
  | { ok: false; error: string; conflict?: boolean }

export type WeaponAttackChoice = {
  attackMode?: 'melee' | 'ranged' | 'thrown' | 'two-handed'
  attackAbility?: 'str' | 'dex'
  sneakAttack?: boolean
  knockOut?: boolean
  note?: string
}

type MerchantCommand =
  | { command_type: 'BargainWithMerchant'; actor_id: string }
  | { command_type: 'BuyItem'; actor_id: string; stock_id: string; quantity: number }
  | { command_type: 'SellItem'; actor_id: string; item_id: string; quantity: number }
  | { command_type: 'AppraiseItem'; actor_id: string; item_id: string }
  | { command_type: 'PurchaseMerchantService'; actor_id: string; service_id: string }

type MerchantCommandResult = {
  authoritative_state?: GameState
  merchant_view?: MerchantView
  narration?: string
  room_version?: number
  error?: string
  code?: string
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline'

type RoomSnapshot = {
  version?: number
  state?: GameState | null
}

type ApiErrorDetails = {
  error?: string
  code?: string
}

export type ShopAssemblyOptions = {
  settlementType: 'village' | 'town' | 'city' | 'outpost' | 'traveling'
  theme: 'general' | 'provisions' | 'arms' | 'healing'
  budgetCp: number
}

export type EncounterAssemblyOptions = {
  difficulty: EncounterDifficulty
  theme: EncounterTheme
}

type MerchantLifecycleCommand =
  | { command_type: 'MoveMerchant'; merchant_id: string; location: string; location_id?: string }
  | { command_type: 'SetMerchantAvailability'; merchant_id: string; available: boolean }

type MerchantLifecycleResult = TacticalCommandResult & {
  shop_proposal?: { merchant: Merchant; proposal_id: string; source: string }
}

type EncounterAssemblyResult = TacticalCommandResult & {
  encounter_proposal?: EncounterProposal
}

let localCommandSequence = 0
const commandId = () => globalThis.crypto?.randomUUID?.() ?? `command-${Date.now()}-${++localCommandSequence}`
const clock = () => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date())
const NARRATION_PREVIEW_TEXT_MAX_BYTES = 12 * 1024
const NARRATION_PREVIEW_EVENT_MAX_BYTES = 16 * 1024
const NARRATION_PREVIEW_PHASES = new Set<NarrationPreviewPhase>([
  'start', 'streaming', 'complete', 'replaced', 'aborted',
])

function parseNarrationPreview(value: string): NarrationPreview | null {
  if (new TextEncoder().encode(value).byteLength > NARRATION_PREVIEW_EVENT_MAX_BYTES) return null
  const payload = JSON.parse(value) as {
    message_id?: unknown
    text?: unknown
    phase?: unknown
    replayed?: unknown
  }
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : ''
  const text = typeof payload.text === 'string' ? payload.text : ''
  const phase = typeof payload.phase === 'string' ? payload.phase as NarrationPreviewPhase : null
  if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(messageId) || !phase || !NARRATION_PREVIEW_PHASES.has(phase)) return null
  if (new TextEncoder().encode(text).byteLength > NARRATION_PREVIEW_TEXT_MAX_BYTES) return null
  return {
    messageId,
    text,
    phase,
    replayed: payload.replayed === true,
  }
}

function apiRequestError(response: Response, details: ApiErrorDetails | null, fallback: string) {
  return new ApiRequestError(details?.error || fallback, response.status, details?.code)
}

function stateVersionConflictMessage(refreshed: boolean) {
  return refreshed
    ? 'Другой игрок уже изменил состояние кампании. Состояние обновлено — проверьте изменения и повторите действие. Ваш ввод сохранён.'
    : 'Другой игрок уже изменил состояние кампании. Не удалось обновить его автоматически — обновите страницу и повторите действие. Ваш ввод сохранён.'
}

function stateForPersistence(state: GameState): GameState {
  return { ...state, engine_mode: 'enforce', ...(state.isNarrating ? { isNarrating: false } : {}) }
}

function latestRoomVersion(current: number, candidate: unknown): number {
  const version = Number(candidate)
  return Number.isSafeInteger(version) && version >= 0 ? Math.max(current, version) : current
}

/**
 * Достраивает карту сцены из клиентского кэша. `null` означает, что дельта
 * пришла от карты, которой у нас нет: обновление потеряно и нужен полный
 * запрос. Разбор идёт на **каждом** сообщении, даже если само состояние потом
 * отложится в очередь, — иначе цепочка дельт рвётся на первом же пропуске.
 */
function roomWithSceneMap(room: RoomSnapshot): RoomSnapshot | null {
  if (!room.state?.scene) return room
  const scene = resolveSceneMap(room.state.scene)
  if (!scene) return null
  return scene === room.state.scene ? room : { ...room, state: { ...room.state, scene } }
}

function roomUrl(sessionCode: string, mapHash = '') {
  const base = `/api/rooms/${encodeURIComponent(sessionCode)}`
  return mapHash ? `${base}?map_hash=${encodeURIComponent(mapHash)}` : base
}

function currentCombatActorId(state: GameState) {
  const combat = state.mechanics?.combat
  if (!combat?.active || !combat.initiative?.length) return state.activePlayerId
  const index = Math.max(0, Number(combat.active_index) || 0)
  return combat.initiative[index]?.actor_id ?? state.activePlayerId
}

function mergeTacticalCommandState(current: GameState, authoritative: GameState, result: TacticalCommandResult, requestId: string): GameState {
  const currentPlayers = new Map(current.players.map((player) => [player.id, player]))
  const players = (authoritative.players?.length ? authoritative.players : current.players).map((player) => {
    const fallback = currentPlayers.get(player.id)
    return fallback ? {
      ...fallback,
      ...player,
      abilities: { ...fallback.abilities, ...player.abilities },
      currency: { ...fallback.currency, ...player.currency },
      inventory: player.inventory ?? fallback.inventory,
      portrait: player.portrait || fallback.portrait,
      portraitPosition: player.portraitPosition || fallback.portraitPosition,
    } : player
  })
  const messages = authoritative.messages ?? current.messages
  const narrationId = result.narration_message_id || `${result.turn_id || requestId}-tactical-narration`
  const withNarration = result.narration?.trim() && !messages.some((message) => message.id === narrationId)
    ? [...messages, {
      id: narrationId,
      speaker: result.narration_speaker ?? 'system',
      author: result.narration_author ?? (result.narration_speaker === 'narrator' ? 'Рассказчик' : 'Система боя'),
      timestamp: clock(),
      text: result.narration.trim(),
      turnConsumed: false,
    }]
    : messages
  const next: GameState = {
    ...current,
    ...authoritative,
    engine_mode: authoritative.engine_mode ?? current.engine_mode,
    players,
    enemies: authoritative.enemies ?? current.enemies,
    actors: authoritative.actors ?? current.actors,
    merchants: authoritative.merchants ?? current.merchants,
    messages: withNarration,
    pendingCheck: authoritative.pendingCheck ?? null,
    agentInteraction: authoritative.agentInteraction ?? null,
    isNarrating: false,
  }
  return { ...next, activePlayerId: currentCombatActorId(next) }
}

function loadState(): GameState {
  const requested = new URLSearchParams(window.location.search).get('room')?.toUpperCase()
  const selected = requested || localStorage.getItem(ACTIVE_CAMPAIGN_KEY)?.toUpperCase()
  // Пока комната не выбрана, показываем пустую оболочку, а не демо-мир.
  if (!selected) return structuredClone(emptyState)
  // Never restore a viewer-specific campaign projection from a cross-account
  // local cache. The authenticated room/SSE endpoints repopulate it.
  return { ...structuredClone(emptyState), sessionCode: selected, campaign: 'Загрузка кампании…' }
}

function mergeAuthoritativeState(current: GameState, result: AiTurnResult | null): GameState {
  const authoritative = result?.authoritative_state
  if (!authoritative) return current
  const eventTypes = new Set((result.mechanics ?? []).map((event) => event.event_type))
  const byId = new Map(authoritative.players.map((player) => [player.id, player]))
  const players = current.players.map((player) => {
    const server = byId.get(player.id)
    if (!server) return player
    return {
      ...player,
      hp: server.hp,
      ...(eventTypes.has('ItemGranted') ? { inventory: server.inventory } : {}),
      ...(eventTypes.has('ActorMoved') || eventTypes.has('SceneAdvanced') || eventTypes.has('MapLevelChanged') ? { x: server.x, y: server.y } : {}),
    }
  })
  // Смена этажа меняет карту, партию и предметы разом — сцену берём целиком.
  const sceneChanged = ['SceneAdvanced', 'AreaRevealed', 'ObjectiveUpdated', 'EntitySpawned', 'MapLevelChanged'].some((type) => eventTypes.has(type))
  return {
    ...current,
    players,
    enemies: authoritative.enemies ?? current.enemies,
    merchants: authoritative.merchants ?? current.merchants,
    mechanics: authoritative.mechanics,
    messages: authoritative.messages ?? current.messages,
    engine_mode: authoritative.engine_mode ?? result.engine_mode ?? current.engine_mode,
    state_version: authoritative.state_version ?? result.state_version,
    ruleset_id: authoritative.ruleset_id,
    ruleset_version: authoritative.ruleset_version,
    enabled_rule_packs: authoritative.enabled_rule_packs,
    enabled_house_rules: authoritative.enabled_house_rules,
    ruleset_locked_at: authoritative.ruleset_locked_at,
    ...(sceneChanged ? {
      scene: authoritative.scene,
      adventure: authoritative.adventure,
      worldMap: authoritative.worldMap,
      entities: authoritative.entities,
      agentInteraction: authoritative.agentInteraction ?? null,
      activePlayerId: authoritative.activePlayerId ?? current.activePlayerId,
      tacticalTurn: authoritative.tacticalTurn,
      mapFeedback: authoritative.mapFeedback ?? [],
    } : {}),
    ...(eventTypes.has('RulingRecorded') ? { rulings: authoritative.rulings } : {}),
  }
}

export function useGameSession() {
  const [state, setState] = useState<GameState>(loadState)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [narrationPreview, setNarrationPreview] = useState<NarrationPreview | null>(null)
  const [tacticalBusy, setTacticalBusy] = useState(false)
  const [tacticalError, setTacticalError] = useState<string | null>(null)
  const [merchantBusy, setMerchantBusy] = useState(false)
  const [merchantError, setMerchantError] = useState<string | null>(null)
  const [directorBusy, setDirectorBusy] = useState(false)
  const [directorError, setDirectorError] = useState<string | null>(null)
  const [combatVisualBatch, setCombatVisualBatch] = useState<CombatVisualBatch | null>(null)
  const [merchantView, setMerchantView] = useState<MerchantView | null>(null)
  const [merchantNarration, setMerchantNarration] = useState<string | null>(null)
  const stateRef = useRef(state)
  const channel = useRef<BroadcastChannel | null>(null)
  const roomVersion = useRef(0)
  const busy = useRef(false)
  const directorBusyRef = useRef(false)
  const tacticalBusyRef = useRef(false)
  const merchantBusyRef = useRef(false)
  const freeRollBusy = useRef(false)
  const fullRoomRequest = useRef<Promise<boolean> | null>(null)
  const actionEpoch = useRef(0)
  // Вторая фаза ручного броска для команд доски. `rollPendingCheck` объявлен
  // раньше `executeTacticalCommand`, и прямая зависимость читалась бы до
  // инициализации константы; ссылка проставляется сразу после объявления.
  const tacticalCommandRef = useRef<
    ((command: TacticalCommand, message: string, dice?: { manualRoll?: boolean; roll?: RollResult }) => Promise<CommandOutcome>) | null
  >(null)
  const queuedRooms = useRef<Array<{ version: number; state: GameState }>>([])
  const persistLocal = useCallback((next: GameState) => {
    localStorage.setItem(ACTIVE_CAMPAIGN_KEY, next.sessionCode)
  }, [])

  const applyRemote = useCallback((next: GameState) => {
    // Ответы команд и бросков приходят с картой целиком: разбор здесь только
    // запоминает её в кэше, чтобы следующая дельта было к чему приложить.
    const scene = next.scene ? resolveSceneMap(next.scene) : null
    const recovered = stateForPersistence(scene && scene !== next.scene ? { ...next, scene } : next)
    stateRef.current = recovered
    setState(recovered)
    persistLocal(recovered)
    channel.current?.postMessage(recovered)
  }, [persistLocal])

  const applyRoomSnapshot = useCallback((room: RoomSnapshot) => {
    if (!room.state) return
    setNarrationPreview((current) => (
      current && room.state?.messages?.some((message) => message.id === current.messageId)
        ? null
        : current
    ))
    roomVersion.current = latestRoomVersion(roomVersion.current, room.version)
    applyRemote(room.state)
  }, [applyRemote])

  /**
   * Карта сцены не собралась из кэша — значит обновление потеряно. Единственный
   * правильный ответ: запросить комнату целиком и получить карту без дельты.
   */
  const refreshFullRoom = useCallback((force = false): Promise<boolean> => {
    if (fullRoomRequest.current) return fullRoomRequest.current
    const request = (async () => {
      try {
        const response = await fetch(roomUrl(stateRef.current.sessionCode))
        if (!response.ok) return false
        const room = roomWithSceneMap(await response.json() as RoomSnapshot & { version?: number })
        if (!room?.state) return false
        if (force || Number(room.version) > roomVersion.current) applyRoomSnapshot(room)
        return true
      } catch (error) {
        console.warn('Не удалось перезапросить состояние кампании целиком:', error)
        return false
      }
    })()
    fullRoomRequest.current = request
    void request.finally(() => {
      if (fullRoomRequest.current === request) fullRoomRequest.current = null
    })
    return request
  }, [applyRoomSnapshot])

  const normalizeCommandError = useCallback(async (error: unknown): Promise<Error> => {
    if (!isStateVersionConflictError(error)) {
      return error instanceof Error ? error : new Error('Сервер отклонил действие')
    }
    const refreshed = await refreshFullRoom(true)
    return new ApiRequestError(stateVersionConflictMessage(refreshed), error.status, error.code)
  }, [refreshFullRoom])

  const responseCommandError = useCallback(async (
    response: Response,
    details: ApiErrorDetails | null,
    fallback: string,
  ) => normalizeCommandError(apiRequestError(response, details, fallback)), [normalizeCommandError])

  const queueRoomSnapshot = useCallback((room: RoomSnapshot) => {
    if (!room.state) return
    const version = Number(room.version)
    if (!Number.isSafeInteger(version) || version < 0) return
    queuedRooms.current.push({ version, state: room.state })
    if (queuedRooms.current.length > 50) queuedRooms.current.splice(0, queuedRooms.current.length - 50)
  }, [])

  const flushQueuedRooms = useCallback(() => {
    if (busy.current || tacticalBusyRef.current || merchantBusyRef.current || directorBusyRef.current) return
    const latest = queuedRooms.current
      .filter((candidate) => candidate.version > roomVersion.current)
      .reduce<{ version: number; state: GameState } | null>((current, candidate) => (
        !current || candidate.version >= current.version ? candidate : current
      ), null)
    queuedRooms.current = []
    if (latest) applyRoomSnapshot(latest)
  }, [applyRoomSnapshot])

  const persistRemote = useCallback((_next: GameState) => {
    // Room JSON is a server-owned read model. Gameplay and shared state are
    // persisted only by typed campaign endpoints and their event commits.
  }, [])

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    channel.current?.close()
    channel.current = new BroadcastChannel(channelNameFor(state.sessionCode))
    channel.current.onmessage = (event: MessageEvent<GameState>) => {
      if (event.data.sessionCode !== state.sessionCode) return
      const recovered = stateForPersistence(event.data)
      stateRef.current = recovered
      setState(recovered)
    }
    return () => channel.current?.close()
  }, [state.sessionCode])

  useEffect(() => {
    if (!state.sessionCode) {
      setConnectionState('offline')
      return
    }
    if (!('EventSource' in window)) {
      setConnectionState('offline')
      return
    }
    let active = true
    let source: EventSource | null = null
    let retryTimer: number | null = null
    let retryDelay = 1_000
    let retryScheduled = false
    const receive = (event: MessageEvent<string>) => {
      try {
        const received = JSON.parse(event.data) as RoomSnapshot
        if (!received.state) return
        const room = roomWithSceneMap(received)
        if (!room) {
          void refreshFullRoom()
          return
        }
        if (busy.current || tacticalBusyRef.current || merchantBusyRef.current || directorBusyRef.current) {
          queueRoomSnapshot(room)
          return
        }
        applyRoomSnapshot(room)
      } catch (error) {
        console.warn('Realtime-событие комнаты отклонено:', error)
      }
    }
    const receivePresence = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { typing_actor_ids?: string[] }
        const typingActorIds = Array.isArray(payload.typing_actor_ids) ? payload.typing_actor_ids.map(String) : []
        setState((current) => {
          const next = {
            ...current,
            presence: {
              transport: 'sse' as const,
              connected_users: current.presence?.connected_users ?? 0,
              connected_heroes: current.presence?.connected_heroes ?? 0,
              online_hero_ids: current.presence?.online_hero_ids ?? [],
              typing_actor_ids: typingActorIds,
            },
          }
          stateRef.current = next
          return next
        })
      } catch (error) {
        console.warn('Realtime-событие присутствия отклонено:', error)
      }
    }
    const receiveNarration = (event: MessageEvent<string>) => {
      try {
        const preview = parseNarrationPreview(event.data)
        if (!preview) return
        publishNarrationPreview(state.sessionCode, preview)
        setNarrationPreview(() => (
          stateRef.current.messages.some((message) => message.id === preview.messageId)
            ? null
            : preview
        ))
      } catch (error) {
        console.warn('Потоковое повествование отклонено:', error)
      }
    }
    const closeSource = () => {
      if (!source) return
      source.removeEventListener('room', receive as EventListener)
      source.removeEventListener('presence', receivePresence as EventListener)
      source.removeEventListener('narration.start', receiveNarration as EventListener)
      source.removeEventListener('narration.chunk', receiveNarration as EventListener)
      source.removeEventListener('narration.complete', receiveNarration as EventListener)
      source.close()
      source = null
    }
    // Комната могла быть удалена или в адресе просто опечатка. Без этой
    // проверки клиент вечно переподключался к 404 и держал статус
    // «Связь восстанавливается…».
    let opened = false
    let failedConnects = 0
    const stopIfRoomMissing = async () => {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(state.sessionCode)}`)
        const room = await response.json().catch(() => null) as { state?: unknown } | null
        if (response.ok && room?.state) return false
      } catch { return false }
      active = false
      closeSource()
      setConnectionState('offline')
      return true
    }
    const scheduleReconnect = () => {
      if (!active || retryScheduled) return
      if (!opened && ++failedConnects >= 2) { void stopIfRoomMissing().then((stopped) => { if (!stopped) failedConnects = 0 }) }
      retryScheduled = true
      setConnectionState('reconnecting')
      closeSource()
      retryTimer = window.setTimeout(() => {
        retryScheduled = false
        retryTimer = null
        connect()
      }, retryDelay)
      retryDelay = Math.min(30_000, retryDelay * 2)
    }
    function connect() {
      if (!active) return
      setConnectionState('connecting')
      const nextSource = new EventSource(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/stream`)
      source = nextSource
      nextSource.addEventListener('room', receive as EventListener)
      nextSource.addEventListener('presence', receivePresence as EventListener)
      nextSource.addEventListener('narration.start', receiveNarration as EventListener)
      nextSource.addEventListener('narration.chunk', receiveNarration as EventListener)
      nextSource.addEventListener('narration.complete', receiveNarration as EventListener)
      nextSource.onopen = () => {
        retryDelay = 1_000
        opened = true
        failedConnects = 0
        setConnectionState('connected')
        flushQueuedRooms()
      }
      nextSource.onerror = scheduleReconnect
    }
    connect()
    return () => {
      active = false
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      closeSource()
    }
  }, [applyRoomSnapshot, flushQueuedRooms, queueRoomSnapshot, refreshFullRoom, state.sessionCode])

  // Пакет анимации принадлежит одной кампании. При смене комнаты это состояние
  // представления сбрасывается, чтобы не проиграть последний ход чужого стола.
  useEffect(() => { setCombatVisualBatch(null) }, [state.sessionCode])
  useEffect(() => { setNarrationPreview(null) }, [state.sessionCode])

  useEffect(() => {
    if (!busy.current && !tacticalBusy && !merchantBusy && !directorBusy) flushQueuedRooms()
  }, [directorBusy, flushQueuedRooms, merchantBusy, state.isNarrating, tacticalBusy])

  useEffect(() => {
    // Пока кампания не выбрана, опрашивать нечего: запрос уходил на
    // `/api/rooms/` и раз в 15 секунд писал в консоль «Комната недоступна».
    if (!state.sessionCode) return
    let active = true
    const sync = async () => {
      try {
        // Сервер узнаёт, какая карта уже есть, и молчит о ней, если она не
        // менялась. Хеш недоверенный и на сервере — только ключ кэша.
        const response = await fetch(roomUrl(state.sessionCode, latestSceneMapHash()))
        if (!response.ok) return
        const received = await response.json() as RoomSnapshot & { version: number }
        if (!active) return
        const resolved = roomWithSceneMap(received)
        if (!resolved) { void refreshFullRoom(); return }
        const room = resolved as RoomSnapshot & { version: number }
        // Пустую комнату больше не засеваем демо-миром: выдуманный отряд
        // уезжал на сервер и подменял «кампаний пока нет».
        if (room.state && room.version > roomVersion.current) {
          if (busy.current || tacticalBusyRef.current || merchantBusyRef.current || directorBusyRef.current) {
            queueRoomSnapshot(room)
          } else {
            applyRoomSnapshot(room)
          }
        }
      } catch (error) { console.warn('Комната временно недоступна:', error) }
    }
    void sync()
    const timer = window.setInterval(sync, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [applyRemote, applyRoomSnapshot, flushQueuedRooms, persistRemote, queueRoomSnapshot, refreshFullRoom, state.sessionCode])

  const commit = useCallback((next: GameState) => {
    stateRef.current = next
    setState(next)
    const shared = stateForPersistence(next)
    persistLocal(shared)
    channel.current?.postMessage(shared)
    persistRemote(next)
  }, [persistLocal, persistRemote])

  const mutate = useCallback((recipe: (current: GameState) => GameState) => {
    const current = stateRef.current
    const next = recipe(current)
    if (next === current) return
    stateRef.current = next
    setState(next)
    const shared = stateForPersistence(next)
    persistLocal(shared)
    channel.current?.postMessage(shared)
    persistRemote(next)
  }, [persistLocal, persistRemote])

  const finishTurn = useCallback((current: GameState, action: string, aiResult: AiTurnResult, roll?: RollResult): GameState => {
    const base = mergeAuthoritativeState(current, aiResult)
    const consumesTurn = aiResult.turn_consumed !== false
    // Служебные команды (`/why`) сервер подписывает «Разбор правил», а не
    // Рассказчиком. Оптимистичная копия обязана совпадать с серверной записью
    // и по автору, и по id — иначе после опроса комнаты текст задваивается.
    const metaCommand = /^\s*\//u.test(action)
    const narratorMessage: Message = {
      id: aiResult.narration_message_id ?? `${Date.now()}-agent`,
      speaker: metaCommand ? 'system' : 'narrator',
      author: metaCommand ? 'Разбор правил' : 'Рассказчик',
      timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
      text: aiResult.narration, roll: aiResult.effects.roll ?? roll, turnConsumed: metaCommand ? undefined : consumesTurn,
      // Ставки приходили в ответе, но нигде не показывались: игрок узнавал СЛ
      // и цену провала только из объяснения `/why`, если додумывался спросить.
      ...(aiResult.stakes ? { stakes: aiResult.stakes } : {}),
    }
    const narrationPersisted = Boolean(aiResult?.narration_message_id)
      && base.messages.some((message) => message.id === aiResult?.narration_message_id)
    return {
      ...base,
      state_version: aiResult?.state_version ?? base.state_version,
      isNarrating: false,
      pendingCheck: null,
      activePlayerId: base.activePlayerId,
      messages: narrationPersisted ? base.messages : [...base.messages, narratorMessage],
    }
  }, [])

  const submitAction = useCallback(async (text: string, actorId?: string, npcId?: string): Promise<CommandOutcome> => {
    if (!text.trim() || state.isNarrating || state.pendingCheck) {
      return { ok: false, error: 'Сейчас нельзя отправить это действие.' }
    }
    busy.current = true
    setTacticalError(null)
    const epoch = ++actionEpoch.current
    const player = state.players.find((item) => item.id === (actorId || state.activePlayerId)) ?? state.players[0]
    // Служебные команды (`/why`) сервер в летопись не пишет — локальный пузырь
    // игрока прожил бы ровно до следующего опроса комнаты и исчезал на глазах.
    const metaCommand = /^\s*\//u.test(text.trim())
    const pending: GameState = {
      ...state,
      isNarrating: true,
      messages: metaCommand ? state.messages : [...state.messages, playerMessage(player.character, text.trim())],
    }
    commit(pending)

    let aiResult: AiTurnResult | null = null
    let authoritativeError: Error | null = null
    try {
      aiResult = await narrateWithAgent(
        pending,
        text.trim(),
        player.character,
        undefined,
        undefined,
        player.id,
        { npcId, onNarrationPreview: setNarrationPreview },
      )
    } catch (error) {
      console.warn('AI fallback:', error instanceof Error ? error.message : error)
      authoritativeError = await normalizeCommandError(error)
    }
    if (epoch !== actionEpoch.current) {
      busy.current = false
      return { ok: false, error: 'Действие было отменено.' }
    }
    if (authoritativeError) {
      const message = authoritativeError.message
      const conflict = isStateVersionConflictError(authoritativeError)
      if (conflict) setTacticalError(message)
      mutate((current) => ({
        ...current,
        isNarrating: false,
        messages: [...current.messages, {
          id: `${Date.now()}-server-rejection`, speaker: 'system', author: 'Правила игры',
          timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
          text: message,
          turnConsumed: false,
        }],
      }))
      busy.current = false
      return { ok: false, error: message, ...(conflict ? { conflict: true } : {}) }
    }
    if (aiResult?.room_version) roomVersion.current = latestRoomVersion(roomVersion.current, aiResult.room_version)
    if (aiResult?.narration_message_id) {
      setNarrationPreview((current) => current?.messageId === aiResult?.narration_message_id ? null : current)
    }
    if (aiResult?.mechanics?.length) {
      setCombatVisualBatch({
        id: `narrate:${aiResult.turn_id ?? aiResult.state_version ?? Date.now()}`,
        events: aiResult.mechanics,
        npcTurns: [],
      })
    }

    const check = aiResult?.check ?? null
    if (check) {
      mutate((current) => ({
        ...current,
        isNarrating: false,
        pendingCheck: { ...check, action: text.trim(), playerId: player.id, status: 'ready' },
        messages: [...current.messages, {
          id: `${Date.now()}-check`, speaker: 'narrator', author: 'Рассказчик',
          timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
          text: aiResult?.narration || `Это рискованное действие. Проверим, насколько удачно оно получится: брось d20 на «${check.label}».`,
        }],
      }))
      busy.current = false
      return { ok: true }
    }

    mutate((current) => finishTurn(current, text, aiResult!))
    busy.current = false

    for (const item of aiResult?.effects.grantItems ?? []) {
      if (!item.imagePrompt) continue
      const landscape = item.type === 'document' && /карт|map|схем|план/i.test(`${item.name} ${item.description}`)
      void generateItemImage(item.imagePrompt, landscape).then((generated) => {
        mutate((current) => ({
          ...current,
          players: current.players.map((owner) => owner.id === item.ownerId ? {
            ...owner,
            inventory: owner.inventory.map((existing) => existing.id === item.id ? { ...existing, image: generated.url, imageStatus: 'ready' } : existing),
          } : owner),
        }))
      }).catch(() => {
        mutate((current) => ({
          ...current,
          players: current.players.map((owner) => owner.id === item.ownerId ? {
            ...owner,
            inventory: owner.inventory.map((existing) => existing.id === item.id ? { ...existing, imageStatus: 'failed' } : existing),
          } : owner),
        }))
      })
    }
    return { ok: true }
  }, [commit, finishTurn, mutate, normalizeCommandError, state])

  const rollPendingCheck = useCallback(async () => {
    const check = state.pendingCheck
    if (!check || check.status !== 'ready') return
    busy.current = true
    const epoch = ++actionEpoch.current
    mutate((current) => current.pendingCheck ? { ...current, pendingCheck: { ...current.pendingCheck, status: 'rolling' } } : current)

    let result: RollResult
    try {
      const [rolled] = await Promise.all([
        rollDice(check, state.sessionCode),
        new Promise((resolve) => window.setTimeout(resolve, 1250)),
      ])
      result = rolled
    } catch (error) {
      mutate((current) => current.pendingCheck ? {
        ...current,
        pendingCheck: { ...current.pendingCheck, status: 'ready' },
        isNarrating: false,
        messages: [...current.messages, {
          id: `${Date.now()}-roll-error`, speaker: 'system', author: 'Сервер кубиков',
          timestamp: clock(),
          text: error instanceof Error ? error.message : 'Серверный бросок временно недоступен.',
          turnConsumed: false,
        }],
      } : current)
      busy.current = false
      return
    }
    if (epoch !== actionEpoch.current) { busy.current = false; return }

    mutate((current) => current.pendingCheck ? {
      ...current,
      isNarrating: true,
      pendingCheck: { ...current.pendingCheck, status: 'resolving', result },
    } : current)

    // Вторая фаза команды доски: та же команда с серверным `roll_id`, а не
    // пересборка свободного действия. Иначе парлей уходил бы в разбор текста и
    // терял уже объявленную СЛ.
    //
    // Команд здесь четыре (`twoPhaseCheckCommandFor`), и текст отказа общий: он
    // достаётся не только парлею, но и побегу от стражи, ответному броску за
    // костями и уговору зверя.
    if (check.command) {
      const outcome = await tacticalCommandRef.current?.(check.command, check.action, { roll: result })
        ?? { ok: false as const, error: 'Команда доски сейчас недоступна' }
      mutate((current) => ({
        ...current,
        isNarrating: false,
        pendingCheck: outcome.ok ? null : { ...check, status: 'ready' },
      }))
      busy.current = false
      return
    }

    const player = state.players.find((item) => item.id === check.playerId) ?? state.players[0]
    let aiResult: AiTurnResult | null = null
    try {
      aiResult = await narrateWithAgent(state, check.action, player.character, result, undefined, player.id)
    } catch (error) {
      const normalized = await normalizeCommandError(error)
      const conflict = isStateVersionConflictError(normalized)
      if (conflict) setTacticalError(normalized.message)
      mutate((current) => ({
        ...current,
        isNarrating: false,
        // Полный refresh при конфликте заменяет оптимистическое состояние.
        // Возвращаем исходную проверку, чтобы повтор не требовал заново вводить действие.
        pendingCheck: { ...check, status: 'ready' },
        messages: [...current.messages, {
          id: `${Date.now()}-resolution-error`, speaker: 'system', author: 'Правила игры',
          timestamp: clock(),
          text: normalized.message,
          turnConsumed: false,
        }],
      }))
      busy.current = false
      return
    }
    if (epoch !== actionEpoch.current) { busy.current = false; return }
    if (aiResult?.room_version) roomVersion.current = latestRoomVersion(roomVersion.current, aiResult.room_version)
    if (aiResult?.mechanics?.length) {
      setCombatVisualBatch({
        id: `check:${aiResult.turn_id ?? aiResult.state_version ?? Date.now()}`,
        events: aiResult.mechanics,
        npcTurns: [],
      })
    }
    mutate((current) => finishTurn(current, check.action, aiResult!, result))
    busy.current = false

    for (const item of aiResult?.effects.grantItems ?? []) {
      if (!item.imagePrompt) continue
      const landscape = item.type === 'document' && /карт|map|схем|план/i.test(`${item.name} ${item.description}`)
      void generateItemImage(item.imagePrompt, landscape).then((generated) => mutate((current) => ({
        ...current,
        players: current.players.map((owner) => owner.id === item.ownerId ? { ...owner, inventory: owner.inventory.map((existing) => existing.id === item.id ? { ...existing, image: generated.url, imageStatus: 'ready' } : existing) } : owner),
      }))).catch(() => mutate((current) => ({
        ...current,
        players: current.players.map((owner) => owner.id === item.ownerId ? { ...owner, inventory: owner.inventory.map((existing) => existing.id === item.id ? { ...existing, imageStatus: 'failed' } : existing) } : owner),
      })))
    }
  }, [finishTurn, mutate, normalizeCommandError, state])

  const cancelPendingCheck = useCallback(() => {
    actionEpoch.current += 1
    busy.current = false
    mutate((current) => ({
      ...current,
      pendingCheck: null,
      isNarrating: false,
      messages: [...current.messages, {
        id: `${Date.now()}-cancel-check`, speaker: 'system', author: 'Система',
        timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
        text: 'Игрок отменил рискованное действие или его зависшее разрешение. Ход остаётся у текущего героя.',
      }],
    }))
  }, [mutate])

  const rollFreeDie = useCallback(async (playerId: string, sides = 20): Promise<DiceRollEvent> => {
    if (freeRollBusy.current) throw new Error('Предыдущий бросок ещё не завершён')
    freeRollBusy.current = true
    try {
      // This endpoint rolls and updates the room in one server-side operation.
      // Unlike a skill check, it does not touch messages, the active hero or turn.
      const room = await rollSharedDie(state.sessionCode, playerId, sides)
      roomVersion.current = latestRoomVersion(roomVersion.current, room.version)
      applyRemote(room.state)
      return room.roll
    } finally {
      freeRollBusy.current = false
    }
  }, [applyRemote, state.sessionCode])

  const voteAgentInteraction = useCallback(async (playerId: string, optionId: string) => {
    const current = stateRef.current
    const interaction = current.agentInteraction
    if (!interaction || interaction.status !== 'open' || interaction.type === 'roll'
      || !interaction.options.some((option) => option.id === optionId)) return
    setDirectorError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor_id: playerId,
          option_id: optionId,
          idempotency_key: commandId(),
        }),
      })
      const result = await response.json() as { version?: number; state?: GameState; error?: string; code?: string }
      if (!response.ok) throw await responseCommandError(response, result, 'Не удалось записать голос')
      if (!result.state) throw new Error('Сервер не вернул состояние после голосования')
      roomVersion.current = latestRoomVersion(roomVersion.current, result.version)
      applyRemote(result.state)
    } catch (error) {
      setDirectorError(error instanceof Error ? error.message : 'Не удалось записать голос')
    }
  }, [applyRemote, responseCommandError])

  const abstainAgentInteraction = useCallback(async (playerId: string) => {
    const current = stateRef.current
    const interaction = current.agentInteraction
    if (!interaction || interaction.status !== 'open' || interaction.type === 'roll') return
    setDirectorError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor_id: playerId, abstain: true, idempotency_key: commandId() }),
      })
      const result = await response.json() as { version?: number; state?: GameState; error?: string; code?: string }
      if (!response.ok) throw await responseCommandError(response, result, 'Не удалось воздержаться')
      if (!result.state) throw new Error('Сервер не вернул состояние после отказа от голоса')
      roomVersion.current = latestRoomVersion(roomVersion.current, result.version)
      applyRemote(result.state)
    } catch (error) {
      setDirectorError(error instanceof Error ? error.message : 'Не удалось воздержаться')
    }
  }, [applyRemote, responseCommandError])

  const rollAgentInteraction = useCallback(async (playerId: string): Promise<DiceRollEvent> => {
    const current = stateRef.current
    const interaction = current.agentInteraction
    if (!interaction || interaction.type !== 'roll' || interaction.status !== 'open') throw new Error('Общий бросок сейчас не требуется')
    const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/party-decisions/${encodeURIComponent(interaction.id)}/roll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_id: playerId, idempotency_key: commandId() }),
    })
    const result = await response.json() as { version?: number; state?: GameState; roll?: DiceRollEvent; error?: string; code?: string }
    try {
      if (!response.ok) throw await responseCommandError(response, result, 'Не удалось выполнить общий бросок')
      if (!result.state || !result.roll) throw new Error('Сервер не вернул результат общего броска')
      roomVersion.current = latestRoomVersion(roomVersion.current, result.version)
      applyRemote(result.state)
      return result.roll
    } catch (error) {
      setDirectorError(error instanceof Error ? error.message : 'Не удалось выполнить общий бросок')
      throw error
    }
  }, [applyRemote, responseCommandError])

  const continueAgentInteraction = useCallback((playerId?: string) => {
    const interaction = state.agentInteraction
    if (!interaction || interaction.status !== 'resolved') return
    const winner = interaction.options.find((option) => option.id === interaction.resolvedOptionId)
    if (!winner) return
    void submitAction(`[РЕШЕНИЕ ГРУППЫ] ${interaction.title}: ${winner.label}. ${interaction.resolutionPrompt}`, playerId)
  }, [state.agentInteraction, submitAction])

  // Возвращает исход, а не только пишет его в tacticalError: вызывающему коду
  // (мастеру создания персонажа) нужно отличить отказ сервера от успеха, иначе
  // он закрывает себя и теряет черновик при 400.
  const executeTacticalCommand = useCallback(async (
    command: TacticalCommand,
    message: string,
    /**
     * Двухфазный ручной бросок. `manualRoll` просит сервер объявить проверку
     * вместо того, чтобы бросить за игрока; `roll` приносит уже сделанный
     * серверный бросок во второй фазе. Обычные команды доски обходятся без них.
     */
    dice: { manualRoll?: boolean; roll?: RollResult } = {},
  ): Promise<CommandOutcome> => {
    if (tacticalBusyRef.current) return { ok: false, error: 'Предыдущая команда ещё выполняется.' }
    const current = stateRef.current
    const combatActorId = currentCombatActorId(current)
    if (!canIssueUiTacticalCommand(current.mechanics?.combat, command, combatActorId)) {
      setTacticalError('Сейчас ход другого участника боя.')
      return { ok: false, error: 'Сейчас ход другого участника боя.' }
    }

    const requestId = commandId()
    tacticalBusyRef.current = true
    setTacticalBusy(true)
    setTacticalError(null)
    try {
      const response = await fetchWithTimeout(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          idempotency_key: requestId,
          message,
          ...(dice.manualRoll ? { manual_roll: true } : {}),
          ...(dice.roll?.roll_id ? { roll: { roll_id: dice.roll.roll_id } } : {}),
        }),
      }, 25_000, 'Сервер слишком долго обрабатывает действие. Не повторяйте его сразу: результат мог сохраниться и появиться после синхронизации.')
      const result = await response.json().catch(() => null) as TacticalCommandResult | null
      if (!response.ok) {
        // Гонка за один кинжал: первый его забрал, второму сервер отказал и
        // приложил к отказу свежий список добычи. Без этой ветки карточка
        // проигравшего показывала бы уже взятую вещь до следующего опроса
        // комнаты — и он бил бы в ту же стену. Проекция серверная, браузер её
        // не пересобирает: подставляется ровно то, что пришло.
        const staleLoot = result?.loot_containers
        if (staleLoot) mutate((state) => ({ ...state, loot_containers: staleLoot }))
        throw await responseCommandError(response, result, `Сервер отклонил команду (${response.status})`)
      }

      // Карточка проверки вместо результата: сервер ничего не закоммитил и
      // ждёт второй фазы с собственным `roll_id`. Кубик остаётся за игроком.
      //
      // Развилка идёт по списку двухфазных команд, а не по одной из них. До
      // ревью здесь стояло `command.command_type === 'ProposeParley'`, и обе
      // остальные карточки — побег от стражи и ответный бросок за костями —
      // приходили с сервера и молча пропадали: `result.check` отбрасывался,
      // ниже начинался разбор `authoritative_state`, которого у неоткоммиченной
      // первой фазы нет, и ход было нечем доиграть. С выключенным автобросом
      // (значение по умолчанию) это ровно рабочий путь, а не редкий случай.
      const twoPhase = twoPhaseCheckCommandFor(command)
      if (result?.check && twoPhase) {
        mutate((state) => ({
          ...state,
          pendingCheck: {
            ...result.check!,
            action: message,
            playerId: twoPhase.actor_id,
            status: 'ready',
            command: twoPhase,
          },
        }))
        return { ok: true }
      }

      let authoritative = result?.authoritative_state
      let version = result?.room_version
      if (!authoritative) {
        const roomResponse = await fetchWithTimeout(
          `/api/rooms/${encodeURIComponent(current.sessionCode)}`,
          {},
          15_000,
          'Сервер не успел вернуть итоговое состояние кампании. Оно обновится при следующей синхронизации.',
        )
        const room = await roomResponse.json().catch(() => null) as { version?: number; state?: GameState | null; error?: string } | null
        if (!roomResponse.ok || !room?.state) throw new Error(room?.error || 'Сервер не вернул итоговое состояние боя')
        authoritative = room.state
        version = room.version ?? version
      }
      if (version != null) roomVersion.current = latestRoomVersion(roomVersion.current, version)
      if (result?.mechanics?.length || result?.npc_turns?.length) {
        setCombatVisualBatch({
          id: `${requestId}:${result.state_version ?? version ?? 'committed'}`,
          events: result.mechanics ?? [],
          npcTurns: result.npc_turns ?? [],
        })
      }
      applyRemote(mergeTacticalCommandState(stateRef.current, authoritative, result ?? {}, requestId))
      return { ok: true }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Не удалось выполнить команду на сервере'
      setTacticalError(text)
      return { ok: false, error: text, ...(isStateVersionConflictError(error) ? { conflict: true } : {}) }
    } finally {
      tacticalBusyRef.current = false
      setTacticalBusy(false)
    }
  }, [applyRemote, mutate, responseCommandError])
  tacticalCommandRef.current = executeTacticalCommand

  const executeRestCommand = useCallback(async (command: RestCommand, message: string): Promise<CommandOutcome> => {
    if (tacticalBusyRef.current) return { ok: false, error: 'Предыдущая команда ещё выполняется.' }
    const current = stateRef.current
    const requestId = commandId()
    tacticalBusyRef.current = true
    setTacticalBusy(true)
    setTacticalError(null)
    try {
      const response = await fetchWithTimeout(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': requestId },
        body: JSON.stringify({
          command: { ...command, expected_state_version: current.state_version ?? 0 },
          message,
        }),
      }, 25_000, 'Сервер не успел завершить отдых. Не повторяйте команду: результат мог сохраниться.')
      const result = await response.json().catch(() => null) as TacticalCommandResult | null
      if (!response.ok) throw await responseCommandError(response, result, `Сервер отклонил команду отдыха (${response.status})`)
      if (!result?.authoritative_state) throw new Error(result?.error || 'Сервер не вернул состояние после команды отдыха')
      if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
      applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, result, requestId))
      return { ok: true }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Не удалось выполнить команду отдыха'
      setTacticalError(text)
      return { ok: false, error: text, ...(isStateVersionConflictError(error) ? { conflict: true } : {}) }
    } finally {
      tacticalBusyRef.current = false
      setTacticalBusy(false)
    }
  }, [applyRemote, responseCommandError])

  const executeCharacterBuild = useCallback(async (commands: CharacterBuildCommand[]) => {
    const current = stateRef.current
    const requestId = commandId()
    setTacticalError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': requestId },
        body: JSON.stringify({
          commands: commands.map((command) => ({
            ...command,
            expected_state_version: current.state_version ?? 0,
          })),
          message: 'Обновление развития персонажа',
        }),
      })
      const result = await response.json().catch(() => null) as TacticalCommandResult | null
      if (!response.ok) throw await responseCommandError(response, result, `Сервер отклонил изменение персонажа (${response.status})`)
      if (!result?.authoritative_state) throw new Error('Сервер не вернул состояние после изменения персонажа')
      if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
      applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, result, requestId))
    } catch (error) {
      setTacticalError(error instanceof Error ? error.message : 'Не удалось сохранить развитие персонажа')
      throw error
    }
  }, [applyRemote, responseCommandError])

  const selectPlayer = useCallback((playerId: string) => commit({ ...state, activePlayerId: playerId }), [commit, state])

  const startCombat = useCallback((playerId: string) => {
    return executeTacticalCommand({ command_type: 'StartCombat', actor_id: playerId }, 'Начать бой')
  }, [executeTacticalCommand])

  const startRest = useCallback((playerId: string, kind: 'short' | 'long') => {
    return executeRestCommand({ command_type: 'StartRest', actor_id: playerId, kind }, kind === 'long' ? 'Устроить долгий отдых' : 'Начать короткий отдых')
  }, [executeRestCommand])

  const spendHitPointDie = useCallback((playerId: string) => {
    return executeRestCommand({ command_type: 'SpendHitPointDie', actor_id: playerId }, 'Потратить одну кость хитов')
  }, [executeRestCommand])

  const completeRest = useCallback((playerId: string) => {
    return executeRestCommand({ command_type: 'CompleteRest', actor_id: playerId }, 'Завершить короткий отдых')
  }, [executeRestCommand])

  const movePlayer = useCallback((playerId: string, x: number, y: number) => {
    return executeTacticalCommand({ command_type: 'MoveActor', actor_id: playerId, to: { x, y } }, `Переместить героя на клетку ${x}, ${y}`)
  }, [executeTacticalCommand])

  /* Слова игрока едут вместе с командой: подтверждение теперь одно на всё —
     кнопка «Отправить», и приписка к действию должна доходить до рассказчика
     тем же запросом, а не отдельной репликой после. */
  const attackEnemy = useCallback((playerId: string, enemyId: string, itemId?: string, choice: WeaponAttackChoice = {}) => {
    const { attackMode, attackAbility, sneakAttack = false, knockOut = false, note } = choice
    const base = knockOut ? 'Нокаутировать выбранную цель' : 'Атаковать выбранную цель'
    return executeTacticalCommand({
      command_type: 'MakeAttack', actor_id: playerId, target_id: enemyId,
      ...(itemId ? { item_id: itemId } : {}),
      ...(itemId && attackMode ? { attack_mode: attackMode } : {}),
      ...(itemId && attackAbility ? { attack_ability: attackAbility } : {}),
      ...(itemId && sneakAttack ? { sneak_attack: true } : {}),
      ...(knockOut ? { knock_out: true } : {}),
    } as TacticalCommand, note ? `${base}. ${note}` : base)
  }, [executeTacticalCommand])

  const throwAreaItem = useCallback((playerId: string, itemId: string, x: number, y: number, note?: string) => {
    const base = `Бросить предмет в клетку ${x}, ${y}`
    return executeTacticalCommand({ command_type: 'MakeAreaAttack', actor_id: playerId, item_id: itemId, to: { x, y } }, note ? `${base}. ${note}` : base)
  }, [executeTacticalCommand])

  const castSpell = useCallback((actorId: string, spellId: string, target: ({ targetId: string } | { x: number; y: number }) & { spellOption?: string; knockOut?: boolean; note?: string }) => {
    const command: TacticalCommand = 'targetId' in target
      ? { command_type: 'CastSpell', actor_id: actorId, spell_id: spellId, target_id: target.targetId, ...(target.spellOption ? { spell_option: target.spellOption } : {}), ...(target.knockOut ? { knock_out: true } : {}) }
      : { command_type: 'CastSpell', actor_id: actorId, spell_id: spellId, to: { x: target.x, y: target.y }, ...(target.spellOption ? { spell_option: target.spellOption } : {}) }
    return executeTacticalCommand(command, target.note ? `Сотворить выбранное заклинание. ${target.note}` : 'Сотворить выбранное заклинание')
  }, [executeTacticalCommand])

  const changeWeapon = useCallback((playerId: string, itemId: string) => {
    return executeTacticalCommand({ command_type: 'ChangeWeapon', actor_id: playerId, item_id: itemId }, 'Сменить оружие')
  }, [executeTacticalCommand])

  const operateDoor = useCallback((playerId: string, doorId: string, intent: 'open' | 'close' | 'force') => {
    const label = intent === 'force' ? 'Выломать дверь' : intent === 'close' ? 'Закрыть дверь' : 'Открыть дверь'
    return executeTacticalCommand({ command_type: 'OperateDoor', actor_id: playerId, door_id: doorId, intent }, label)
  }, [executeTacticalCommand])

  const operateSceneObject = useCallback((actorId: string, propId: string, intent: SceneObjectIntent) => {
    const label: Record<SceneObjectIntent, string> = {
      inspect: 'Осмотреть объект сцены',
      open: 'Открыть объект сцены',
      take: 'Взять объект сцены',
      use: 'Использовать объект сцены',
      topple: 'Опрокинуть объект сцены',
      ignite: 'Поджечь объект сцены',
      pray: 'Помолиться у святыни',
    }
    return executeTacticalCommand({
      command_type: 'OperateSceneObject',
      actor_id: actorId,
      prop_id: propId,
      intent,
    }, label[intent],
    // Двухфазный ручной кубик просит только молитва: остальные глаголы пропса
    // сервер решает своим броском в тот же запрос, и карточки для них нет.
    intent === 'pray' ? { manualRoll: !autoRollEnabled() } : undefined)
  }, [executeTacticalCommand])

  /* Переговоры посреди боя. Клиент называет только подход: кто отвечает за
     сторону противника, какая СЛ и на что она вообще пойдёт — считает сервер.
     Бросок Харизмы двухфазный, если игрок не включил автобросок: первая фаза
     возвращает карточку, вторая приходит из `rollPendingCheck`. */
  const proposeParley = useCallback((actorId: string, skill: 'persuasion' | 'intimidation' = 'persuasion') => {
    return executeTacticalCommand(
      { command_type: 'ProposeParley', actor_id: actorId, skill },
      skill === 'intimidation' ? 'Потребовать сложить оружие' : 'Предложить переговоры',
      { manualRoll: !autoRollEnabled() },
    )
  }, [executeTacticalCommand])

  const settleParley = useCallback((actorId: string, outcome: ParleyOutcome) => {
    const labels: Record<ParleyOutcome, string> = {
      withdraw: 'Отпустить противника с миром',
      tribute: 'Отпустить противника, забрав добычу',
      surrender: 'Принять сдачу противника',
      resume: 'Прервать переговоры и продолжить бой',
    }
    return executeTacticalCommand({ command_type: 'SettleParley', actor_id: actorId, outcome }, labels[outcome])
  }, [executeTacticalCommand])

  /* Ответ страже. Клиент называет исход и, для побега, подход: размер виры, СЛ
     проверки и состав стражи объявил сервер и пересчитает их сам. Побег —
     групповая проверка, и двухфазный ручной кубик здесь есть у того, кто побег
     объявил; за остальных героев бросает сервер. */
  const resolveGuardEncounter = useCallback((
    actorId: string,
    resolution: GuardResolution,
    skill: 'stealth' | 'athletics' = 'stealth',
  ) => {
    const labels: Record<GuardResolution, string> = {
      fine: 'Заплатить виру страже',
      surrender: 'Сдаться страже',
      fight: 'Принять бой со стражей',
      flee: skill === 'athletics' ? 'Прорваться мимо стражи' : 'Уйти от стражи тихо',
    }
    return executeTacticalCommand(
      { command_type: 'ResolveGuardEncounter', actor_id: actorId, resolution, skill },
      labels[resolution],
      resolution === 'flee' ? { manualRoll: !autoRollEnabled() } : undefined,
    )
  }, [executeTacticalCommand])

  /* Кости за столом. Раунд разложен на две команды, потому что бросок соперника
     обязан лечь на стол первым: только после него у ручного кубика героя
     появляется объявленная СЛ. Ставку клиент выбирает из серверного набора, а
     подход к ответу — из серверного списка. */
  const openTavernDiceRound = useCallback((actorId: string, npcId: string, stakeCp: number) => {
    return executeTacticalCommand(
      { command_type: 'OpenTavernDiceRound', actor_id: actorId, npc_id: npcId, stake_cp: stakeCp },
      'Сыграть в кости',
    )
  }, [executeTacticalCommand])

  const answerTavernDiceRound = useCallback((actorId: string, approach: TavernDiceApproach = 'fair') => {
    const labels: Record<TavernDiceApproach, string> = {
      fair: 'Ответить на бросок честно',
      cheat: 'Подкрутить кость',
      watch: 'Бросить и следить за чужими руками',
    }
    return executeTacticalCommand(
      { command_type: 'AnswerTavernDiceRound', actor_id: actorId, approach },
      labels[approach],
      { manualRoll: !autoRollEnabled() },
    )
  }, [executeTacticalCommand])

  /* Встать из-за стола. Броска нет и ставка не двигается — её до расчёта никто
     не трогал; команда существует потому, что ответить герой может не всегда:
     соперника мог обыграть дочиста товарищ по отряду, а свои деньги — уйти
     другой командой. */
  const leaveTavernDiceRound = useCallback((actorId: string) => {
    return executeTacticalCommand({ command_type: 'LeaveTavernDiceRound', actor_id: actorId }, 'Встать из-за стола')
  }, [executeTacticalCommand])

  const orderTavernDrink = useCallback((actorId: string) => {
    return executeTacticalCommand({ command_type: 'OrderTavernDrink', actor_id: actorId }, 'Заказать выпивку')
  }, [executeTacticalCommand])

  /* Письмо. Клиент называет только адресата и текст: дальность, плату курьеру,
     срок доставки и тон ответа считает сервер, а полировку ответа моделью он
     же и запечатывает — черновик из браузера был бы ответом NPC, написанным
     игроком, поэтому такого поля в команде нет. */
  const sendLetter = useCallback((actorId: string, addresseeKind: LetterAddresseeKind, addresseeId: string, body: string) => {
    return executeTacticalCommand(
      { command_type: 'SendLetter', actor_id: actorId, addressee_kind: addresseeKind, addressee_id: addresseeId, body },
      'Написать письмо',
    )
  }, [executeTacticalCommand])

  /* Треба у служителя. Клиент называет только жреца: размер пожертвования, срок
     благословения и суточный предел объявляет сервер. Броска здесь нет — за него
     и платят. */
  const receiveNpcBlessing = useCallback((actorId: string, npcId: string) => {
    return executeTacticalCommand(
      { command_type: 'ReceiveNpcBlessing', actor_id: actorId, npc_id: npcId },
      'Попросить благословение',
    )
  }, [executeTacticalCommand])

  /* Судьба пленного. Клиент называет только пленного и, для допроса, подход;
     СЛ, исход броска, награду и последствия считает сервер. */
  const captiveAction = useCallback((
    actorId: string,
    captiveId: string,
    action: CaptiveAction,
    skill: CaptiveInterrogationSkill = 'intimidation',
  ) => {
    if (action === 'interrogate') {
      return executeTacticalCommand({
        command_type: 'InterrogateCaptive', actor_id: actorId, captive_id: captiveId, skill,
      }, skill === 'persuasion' ? 'Разговорить пленного убеждением' : 'Допросить пленного с нажимом')
    }
    if (action === 'release') {
      return executeTacticalCommand({ command_type: 'ReleaseCaptive', actor_id: actorId, captive_id: captiveId }, 'Отпустить пленного')
    }
    if (action === 'hand-over') {
      return executeTacticalCommand({ command_type: 'HandCaptiveToGuards', actor_id: actorId, captive_id: captiveId }, 'Сдать пленного страже')
    }
    if (action === 'feed') {
      return executeTacticalCommand({ command_type: 'FeedCaptive', actor_id: actorId, captive_id: captiveId }, 'Накормить пленного')
    }
    return executeTacticalCommand({ command_type: 'ExecuteCaptive', actor_id: actorId, captive_id: captiveId }, 'Убить пленного')
  }, [executeTacticalCommand])

  /* Обыск контейнера. Клиент называет только контейнер, ключи экземпляров и
     количества: имя, вес, цена и механика вещи лежат в самом контейнере, и
     читает их сервер. Набор уезжает одной командой — «всё или ничего» это не
     про интерфейс, а про правило: частично взятого набора не бывает. */
  const lootContainer = useCallback((
    actorId: string,
    containerId: string,
    lines: Array<{ item_instance_id: string; quantity: number }>,
    recipientId?: string,
  ) => {
    return executeTacticalCommand({
      command_type: 'LootContainer',
      actor_id: actorId,
      container_id: containerId,
      lines,
      ...(recipientId && recipientId !== actorId ? { recipient_id: recipientId } : {}),
    }, 'Обыскать добычу')
  }, [executeTacticalCommand])

  /* Зверь. Клиент называет только зверя: навык проверки один и объявлен
     сервером, СЛ считает политика приручения, а паёк для кормления сервер
     находит в рюкзаке сам. Уговор идёт двухфазным ручным броском — тем же
     путём, что парлей и побег от стражи. */
  const beastAction = useCallback((actorId: string, beastId: string, action: BeastAction) => {
    if (action === 'feed') {
      return executeTacticalCommand({ command_type: 'FeedBeast', actor_id: actorId, beast_id: beastId }, 'Накормить зверя с руки')
    }
    if (action === 'scare') {
      return executeTacticalCommand({ command_type: 'ScareWithBeast', actor_id: actorId, beast_id: beastId }, 'Отогнать угрозу зверем')
    }
    // Уговор двухфазный, если игрок не включил автобросок: первая фаза
    // возвращает карточку с объявленной СЛ, вторая приходит из
    // `rollPendingCheck` — тем же путём, что парлей и побег от стражи.
    return executeTacticalCommand(
      { command_type: 'CalmBeast', actor_id: actorId, beast_id: beastId },
      'Успокоить зверя',
      { manualRoll: !autoRollEnabled() },
    )
  }, [executeTacticalCommand])

  /* Переход между этажами — та же лёгкая команда, что и остальные действия у
     карты: сервер решает, дошёл ли герой до лестницы и не идёт ли бой, и
     отказывает кодами `TRANSITION_*` / `LEVEL_*`. Клиент только называет
     предмет. */
  const useLevelTransition = useCallback((actorId: string, propId: string) => {
    return executeTacticalCommand({ command_type: 'UseLevelTransition', actor_id: actorId, prop_id: propId }, 'Перейти на другой этаж')
  }, [executeTacticalCommand])

  const useCombatAction = useCallback((actorId: string, actionId: string, targetId?: string, itemId?: string, beneficiaryId?: string, note?: string) => {
    return executeTacticalCommand({
      command_type: 'UseCombatAction', actor_id: actorId, action_id: actionId,
      ...(targetId ? { target_id: targetId } : {}),
      ...(itemId ? { item_id: itemId } : {}),
      ...(beneficiaryId ? { beneficiary_id: beneficiaryId } : {}),
    }, note ? `Использовать выбранное боевое действие. ${note}` : 'Использовать выбранное боевое действие')
  }, [executeTacticalCommand])

  const finishMapTurn = useCallback(() => {
    const current = stateRef.current
    return executeTacticalCommand({ command_type: 'EndTurn', actor_id: currentCombatActorId(current) }, 'Завершить ход')
  }, [executeTacticalCommand])

  const resolveHeroDeath = useCallback((playerId: string, resolution: 'resurrect' | 'replace', replacementName?: string) => {
    return executeTacticalCommand({
      command_type: 'ResolveHeroDeath',
      actor_id: playerId,
      resolution,
      ...(resolution === 'replace' ? { replacement_name: String(replacementName ?? '').trim() } : {}),
    }, resolution === 'resurrect' ? 'Воскресить погибшего героя' : 'Заменить погибшего героя новым')
  }, [executeTacticalCommand])

  const equipItem = useCallback((playerId: string, itemId: string, equipped: boolean) => {
    return executeTacticalCommand({ command_type: 'EquipItem', actor_id: playerId, item_id: itemId, equipped }, equipped ? 'Экипировать предмет' : 'Снять предмет')
  }, [executeTacticalCommand])

  const useItem = useCallback((playerId: string, itemId: string, options: ItemUseOptions = {}) => {
    return executeTacticalCommand({
      command_type: 'UseItem',
      actor_id: playerId,
      item_id: itemId,
      ...(options.targetId ? { target_id: options.targetId } : {}),
      ...(options.chargesToSpend == null ? {} : { charges_to_spend: options.chargesToSpend }),
      ...(options.to ? { to: options.to } : {}),
      ...(options.useMode ? { use_mode: options.useMode } : {}),
      ...(options.weaponId ? { weapon_id: options.weaponId } : {}),
    }, 'Использовать предмет')
  }, [executeTacticalCommand])

  const transferItem = useCallback((playerId: string, itemId: string, recipientId: string, quantity = 1) => {
    return executeTacticalCommand({ command_type: 'TransferItem', actor_id: playerId, item_id: itemId, recipient_id: recipientId, quantity }, 'Передать предмет союзнику')
  }, [executeTacticalCommand])

  const attuneItem = useCallback((playerId: string, itemId: string, attuned: boolean) => {
    return executeTacticalCommand({ command_type: 'AttuneItem', actor_id: playerId, item_id: itemId, attuned }, attuned ? 'Настроиться на предмет' : 'Разорвать настройку')
  }, [executeTacticalCommand])

  const activateItem = useCallback((playerId: string, itemId: string, activated: boolean) => {
    void executeTacticalCommand({ command_type: 'ActivateItem', actor_id: playerId, item_id: itemId, activated }, activated ? 'Зажечь магический клинок' : 'Погасить магический клинок')
  }, [executeTacticalCommand])

  const importCharacter = useCallback(async (playerId: string, source: string) => {
    let document: unknown
    try {
      document = JSON.parse(source)
    } catch {
      const error = new Error('Файл персонажа должен содержать корректный JSON.')
      setTacticalError(error.message)
      throw error
    }
    const outcome = await executeTacticalCommand({ command_type: 'ImportCharacter', actor_id: playerId, document }, 'Импортировать версионированный лист персонажа')
    if (!outcome.ok) throw new Error(outcome.error || 'Сервер отклонил создание персонажа.')
  }, [executeTacticalCommand])

  const levelUpCharacter = useCallback((playerId: string, expectedLevel: number) => {
    void executeTacticalCommand({ command_type: 'LevelUp', actor_id: playerId, expected_level: expectedLevel } as TacticalCommand, 'Повысить уровень персонажа')
  }, [executeTacticalCommand])

  const switchCampaign = useCallback(async (code: string, prefetched?: { version?: number; state?: GameState | null }) => {
    const normalized = code.toUpperCase()
    setTacticalError(null)
    setMerchantError(null)
    setMerchantView(null)
    setMerchantNarration(null)
    // Карты прежней кампании к новой сцене отношения не имеют: дельта от них не
    // применима, и хранить их значит рисковать наложением чужой карты.
    forgetSceneMaps()
    if (prefetched?.state) {
      roomVersion.current = prefetched.version ?? 0
      applyRemote(prefetched.state)
      const url = new URL(window.location.href)
      url.searchParams.set('room', normalized)
      window.history.replaceState(null, '', url)
      return
    }
    const response = await fetchWithTimeout(
      '/api/rooms/' + encodeURIComponent(normalized),
      {},
      20_000,
      'Кампания не загрузилась вовремя. Попробуйте ещё раз.',
    )
    const room = await response.json() as { version?: number; state?: GameState | null; error?: string }
    if (!response.ok || !room.state) throw new Error(room.error || 'Кампания не найдена')
    roomVersion.current = room.version ?? 0
    applyRemote(room.state)
    const url = new URL(window.location.href)
    url.searchParams.set('room', normalized)
    window.history.replaceState(null, '', url)
  }, [applyRemote])

  const loadMerchant = useCallback(async (merchantId: string, actorId: string) => {
    if (merchantBusyRef.current) return
    const current = stateRef.current
    merchantBusyRef.current = true
    setMerchantBusy(true)
    setMerchantError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/merchants/${encodeURIComponent(merchantId)}?actor_id=${encodeURIComponent(actorId)}`)
      const result = await response.json().catch(() => null) as MerchantCommandResult | MerchantView | null
      const wrapped = result && 'merchant_view' in result ? result as MerchantCommandResult : null
      const view = wrapped?.merchant_view ?? (result && 'merchant' in result ? result as MerchantView : null)
      if (!response.ok) throw new Error(wrapped?.error || `Не удалось получить цены торговца (${response.status})`)
      if (!view) throw new Error('Сервер не вернул витрину и котировки торговца')
      if (wrapped?.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, wrapped.room_version)
      if (wrapped?.authoritative_state) {
        applyRemote(mergeTacticalCommandState(stateRef.current, wrapped.authoritative_state, {}, commandId()))
      }
      setMerchantView(view)
    } catch (error) {
      setMerchantView(null)
      setMerchantError(error instanceof Error ? error.message : 'Торговец временно недоступен')
    } finally {
      merchantBusyRef.current = false
      setMerchantBusy(false)
    }
  }, [applyRemote])

  const executeMerchantCommand = useCallback(async (merchantId: string, command: MerchantCommand) => {
    if (merchantBusyRef.current) return
    const current = stateRef.current
    const expectedStateVersion = Number(merchantView?.expected_state_version ?? merchantView?.state_version)
    if (merchantView?.merchant.id !== merchantId || merchantView.actor_id !== command.actor_id || !Number.isInteger(expectedStateVersion) || expectedStateVersion < 0) {
      setMerchantError('Сначала обновите серверные котировки для выбранного героя.')
      return
    }
    const requestId = commandId()
    merchantBusyRef.current = true
    setMerchantBusy(true)
    setMerchantError(null)
    setMerchantNarration(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/merchants/${encodeURIComponent(merchantId)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: requestId, command: { ...command, expected_state_version: expectedStateVersion } }),
      })
      const result = await response.json().catch(() => null) as MerchantCommandResult | null
      if (!response.ok) throw await responseCommandError(response, result, `Торговец отклонил действие (${response.status})`)
      if (!result?.authoritative_state) throw new Error('Сервер не вернул итоговое состояние сделки')
      if (!result.merchant_view) throw new Error('Сервер не вернул обновлённые котировки торговца')
      if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
      applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, {
        narration: result.narration,
        room_version: result.room_version,
      }, requestId))
      setMerchantView(result.merchant_view)
      setMerchantNarration(result.narration?.trim() || null)
    } catch (error) {
      setMerchantError(error instanceof Error ? error.message : 'Не удалось выполнить торговую операцию')
    } finally {
      merchantBusyRef.current = false
      setMerchantBusy(false)
    }
  }, [applyRemote, merchantView, responseCommandError])

  const bargainWithMerchant = useCallback((merchantId: string, actorId: string) => executeMerchantCommand(merchantId, {
    command_type: 'BargainWithMerchant', actor_id: actorId,
  }), [executeMerchantCommand])

  const buyFromMerchant = useCallback((merchantId: string, actorId: string, stockId: string, quantity: number) => executeMerchantCommand(merchantId, {
    command_type: 'BuyItem', actor_id: actorId, stock_id: stockId, quantity: Math.max(1, Math.floor(quantity)),
  }), [executeMerchantCommand])

  const sellToMerchant = useCallback((merchantId: string, actorId: string, itemId: string, quantity: number) => executeMerchantCommand(merchantId, {
    command_type: 'SellItem', actor_id: actorId, item_id: itemId, quantity: Math.max(1, Math.floor(quantity)),
  }), [executeMerchantCommand])

  const appraiseWithMerchant = useCallback((merchantId: string, actorId: string, itemId: string) => executeMerchantCommand(merchantId, {
    command_type: 'AppraiseItem', actor_id: actorId, item_id: itemId,
  }), [executeMerchantCommand])

  const purchaseMerchantService = useCallback((merchantId: string, actorId: string, serviceId: string) => executeMerchantCommand(merchantId, {
    command_type: 'PurchaseMerchantService', actor_id: actorId, service_id: serviceId,
  }), [executeMerchantCommand])

  const executeMerchantLifecycleCommand = useCallback(async (command: MerchantLifecycleCommand) => {
    const current = stateRef.current
    const requestId = commandId()
    const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/merchants/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': requestId },
      body: JSON.stringify({ command: { ...command, expected_state_version: current.state_version ?? 0 } }),
    })
    const result = await response.json().catch(() => null) as MerchantLifecycleResult | null
    if (!response.ok) throw await responseCommandError(response, result, `Сервер отклонил изменение торговца (${response.status})`)
    if (!result?.authoritative_state) throw new Error('Сервер не вернул состояние после изменения торговца')
    if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
    applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, {}, requestId))
  }, [applyRemote, responseCommandError])

  const assembleMerchant = useCallback(async ({ settlementType, theme, budgetCp }: ShopAssemblyOptions) => {
    const current = stateRef.current
    const requestId = commandId()
    const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/merchants/assemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': requestId },
      body: JSON.stringify({
        expected_state_version: current.state_version ?? 0,
        settlement_type: settlementType,
        theme,
        budget_cp: Math.max(100, Math.min(1_000_000, Math.floor(budgetCp))),
        seed: requestId,
      }),
    })
    const result = await response.json().catch(() => null) as MerchantLifecycleResult | null
    if (!response.ok) throw await responseCommandError(response, result, `ShopAssembler отклонил запрос (${response.status})`)
    if (!result?.authoritative_state || !result.shop_proposal?.merchant) throw new Error('Сервер не вернул созданного торговца')
    if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
    applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, {}, requestId))
    return result.shop_proposal.merchant
  }, [applyRemote, responseCommandError])

  const assembleEncounter = useCallback(async ({ difficulty, theme }: EncounterAssemblyOptions) => {
    const current = stateRef.current
    if (current.mechanics?.combat?.active) throw new Error('Нельзя собирать новое столкновение, пока текущий бой не завершён.')
    const requestId = commandId()
    const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/encounters/assemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': requestId },
      body: JSON.stringify({
        expected_state_version: current.state_version ?? 0,
        difficulty,
        theme,
        seed: requestId,
      }),
    })
    const result = await response.json().catch(() => null) as EncounterAssemblyResult | null
    if (!response.ok) throw await responseCommandError(response, result, `EncounterAssembler отклонил запрос (${response.status})`)
    if (!result?.authoritative_state || !result.encounter_proposal) throw new Error('Сервер не вернул собранное столкновение')
    if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
    applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, result, requestId))
    return result.encounter_proposal
  }, [applyRemote, responseCommandError])

  const moveMerchant = useCallback((merchantId: string, location: string, locationId?: string) => executeMerchantLifecycleCommand({
    command_type: 'MoveMerchant', merchant_id: merchantId, location, ...(locationId ? { location_id: locationId } : {}),
  }), [executeMerchantLifecycleCommand])

  const setMerchantAvailability = useCallback((merchantId: string, available: boolean) => executeMerchantLifecycleCommand({
    command_type: 'SetMerchantAvailability', merchant_id: merchantId, available,
  }), [executeMerchantLifecycleCommand])

  const advanceAdventure = useCallback(async () => {
    if (directorBusyRef.current) return null
    directorBusyRef.current = true
    setDirectorBusy(true)
    setDirectorError(null)
    try {
      const current = stateRef.current
      const requestId = commandId()
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/autonomy/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': requestId },
        body: JSON.stringify({ idempotency_key: requestId, player_action: 'Продолжить приключение' }),
      })
      const result = await response.json().catch(() => null) as { state?: GameState; state_version?: number; intent?: { type?: string }; error?: string; code?: string } | null
      if (!response.ok) throw await responseCommandError(response, result, `Director не смог продолжить приключение (${response.status})`)
      if (!result?.state) throw new Error('Director не вернул состояние кампании')
      applyRemote(result.state)
      return result.intent ?? null
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Director временно недоступен'
      setDirectorError(message)
      throw error
    } finally {
      directorBusyRef.current = false
      setDirectorBusy(false)
    }
  }, [applyRemote, responseCommandError])

  // Раньше сюда подставлялся демо-мир целиком: реальная кампания получала
  // «Затопленный архив», чужого стража и три вымышленные реплики. Теперь это
  // ровно то, что обещает кнопка, — снять бой и поднять отряд.
  const reset = useCallback(() => mutate((current) => {
    const members = current.partyMemberIds?.length ? current.partyMemberIds : current.players.map((player) => player.id)
    return {
      ...current,
      players: current.players.map((player) => ({ ...player, hp: player.maxHp })),
      enemies: [],
      battleLog: [],
      tacticalTurn: { sceneTurn: 0, actorId: '', movementSpent: 0, actionUsed: false },
      pendingCheck: null,
      isNarrating: false,
      activePlayerId: members[0] ?? current.players[0]?.id ?? '',
    }
  }), [mutate])

  const updatePlayer = useCallback(async (playerId: string, patch: Partial<Player>) => {
    const current = stateRef.current
    const player = current.players.find((candidate) => candidate.id === playerId)
    if (!player) return
    const commands: CharacterBuildCommand[] = []
    if (patch.subclass !== undefined || patch.classSkillProficiencies !== undefined || patch.selectedFeatureIds !== undefined) {
      commands.push({
        command_type: 'SetCharacterChoices',
        actor_id: playerId,
        subclass: String(patch.subclass ?? player.subclass ?? ''),
        class_skill_proficiencies: patch.classSkillProficiencies ?? player.classSkillProficiencies ?? [],
        selected_feature_ids: patch.selectedFeatureIds ?? player.selectedFeatureIds ?? [],
      })
    }
    if (patch.knownSpellIds !== undefined || patch.preparedSpellIds !== undefined) {
      commands.push({
        command_type: 'SetSpellSelections',
        actor_id: playerId,
        known_spell_ids: patch.knownSpellIds ?? player.knownSpellIds ?? [],
        prepared_spell_ids: patch.preparedSpellIds ?? player.preparedSpellIds ?? [],
      })
    }
    if (commands.length) await executeCharacterBuild(commands)
    const mechanical = new Set<keyof Player>([
      'subclass', 'classSkillProficiencies', 'selectedFeatureIds', 'knownSpellIds', 'preparedSpellIds',
      'role', 'characterClass', 'level', 'experience', 'hp', 'maxHp', 'armor', 'speed', 'proficiency', 'abilities', 'currency',
      'inventory', 'combatActions', 'combatSpells',
      'x', 'y',
    ])
    const presentation = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !mechanical.has(key as keyof Player)),
    ) as Partial<Player>
    if (Object.keys(presentation).length) {
      mutate((latest) => ({
        ...latest,
        players: latest.players.map((candidate) => candidate.id === playerId ? { ...candidate, ...presentation } : candidate),
      }))
    }
  }, [executeCharacterBuild, mutate])

  const updateWorld = useCallback((patch: { campaign?: string; partyName?: string; partyMemberIds?: string[]; scene?: Partial<GameState['scene']> }) => mutate((current) => {
    const partyMemberIds = patch.partyMemberIds?.length ? [...new Set(patch.partyMemberIds)] : current.partyMemberIds ?? current.players.map((player) => player.id)
    return {
      ...current,
      campaign: patch.campaign ?? current.campaign,
      partyName: patch.partyName ?? current.partyName,
      partyMemberIds,
      activePlayerId: partyMemberIds.includes(current.activePlayerId) ? current.activePlayerId : partyMemberIds[0] ?? current.activePlayerId,
      tacticalTurn: partyMemberIds.includes(current.activePlayerId) ? current.tacticalTurn : undefined,
      scene: { ...current.scene, ...patch.scene },
    }
  }), [mutate])

  return {
    state,
    narrationPreview,
    connectionState,
    tacticalBusy,
    tacticalError,
    merchantBusy,
    merchantError,
    directorBusy,
    directorError,
    combatVisualBatch,
    merchantView,
    merchantNarration,
    clearTacticalError: () => setTacticalError(null),
    submitAction,
    rollPendingCheck,
    cancelPendingCheck,
    rollFreeDie,
    voteAgentInteraction,
    abstainAgentInteraction,
    rollAgentInteraction,
    continueAgentInteraction,
    selectPlayer,
    startCombat,
    startRest,
    spendHitPointDie,
    completeRest,
    movePlayer,
    attackEnemy,
    throwAreaItem,
    castSpell,
    useCombatAction,
    changeWeapon,
    operateDoor,
    operateSceneObject,
    captiveAction,
    lootContainer,
    beastAction,
    resolveGuardEncounter,
    openTavernDiceRound,
    answerTavernDiceRound,
    leaveTavernDiceRound,
    orderTavernDrink,
    sendLetter,
    receiveNpcBlessing,
    proposeParley,
    settleParley,
    useLevelTransition,
    finishMapTurn,
    resolveHeroDeath,
    equipItem,
    useItem,
    transferItem,
    attuneItem,
    activateItem,
    importCharacter,
    levelUpCharacter,
    switchCampaign,
    loadMerchant,
    bargainWithMerchant,
    buyFromMerchant,
    sellToMerchant,
    appraiseWithMerchant,
    purchaseMerchantService,
    assembleMerchant,
    assembleEncounter,
    moveMerchant,
    setMerchantAvailability,
    advanceAdventure,
    reset,
    updatePlayer,
    updateWorld,
  }
}
