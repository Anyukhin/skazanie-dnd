import { useCallback, useEffect, useRef, useState } from 'react'
import { initialState } from './data'
import { generateItemImage, narrateWithAgent, rollDice, rollSharedDie } from './ai-client'
import { playerMessage } from './game-engine'
import { canIssueUiTacticalCommand } from './tactical-command-guard.mjs'
import type { AgentInteraction, AiTurnResult, DiceRollEvent, EncounterDifficulty, EncounterProposal, EncounterTheme, GameEvent, GameState, InventoryItem, Merchant, MerchantView, Message, Player, RollResult } from './types'

const ACTIVE_CAMPAIGN_KEY = 'skazanie-active-campaign-v2'
const channelNameFor = (campaignId: string) => `skazanie-room:${String(campaignId || '').toUpperCase()}`

type TacticalCommand =
  | { command_type: 'StartCombat'; actor_id: string }
  | { command_type: 'MoveActor'; actor_id: string; to: { x: number; y: number } }
  | { command_type: 'MakeAttack'; actor_id: string; target_id: string; knock_out?: boolean }
  | { command_type: 'MakeAttack'; actor_id: string; target_id: string; item_id: string; knock_out?: boolean }
  | { command_type: 'MakeAreaAttack'; actor_id: string; item_id: string; to: { x: number; y: number } }
  | { command_type: 'CastSpell'; actor_id: string; spell_id: string; target_id: string; spell_option?: string; knock_out?: boolean }
  | { command_type: 'CastSpell'; actor_id: string; spell_id: string; to: { x: number; y: number }; spell_option?: string }
  | { command_type: 'UseCombatAction'; actor_id: string; action_id: string; target_id?: string; item_id?: string }
  | { command_type: 'ChangeWeapon'; actor_id: string; item_id: string }
  | { command_type: 'EndTurn'; actor_id: string }
  | { command_type: 'ResolveHeroDeath'; actor_id: string; resolution: 'resurrect' | 'replace'; replacement_name?: string }
  | { command_type: 'EquipItem'; actor_id: string; item_id: string; equipped: boolean }
  | { command_type: 'UseItem'; actor_id: string; item_id: string; target_id?: string }
  | { command_type: 'TransferItem'; actor_id: string; item_id: string; recipient_id: string; quantity: number }
  | { command_type: 'AttuneItem'; actor_id: string; item_id: string; attuned: boolean }
  | { command_type: 'ImportCharacter'; actor_id: string; document: unknown }
  | { command_type: 'LevelUp'; actor_id: string; expected_level: number }

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
  npc_turns?: Array<Record<string, unknown>>
  room_version?: number
  state_version?: number
  turn_id?: string | null
  narration_message_id?: string | null
  narration_speaker?: 'narrator' | 'system'
  narration_author?: string
  error?: string
  code?: string
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

function stateForPersistence(state: GameState): GameState {
  return { ...state, engine_mode: 'enforce', ...(state.isNarrating ? { isNarrating: false } : {}) }
}

function latestRoomVersion(current: number, candidate: unknown): number {
  const version = Number(candidate)
  return Number.isSafeInteger(version) && version >= 0 ? Math.max(current, version) : current
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
  if (!selected || selected === initialState.sessionCode) return structuredClone(initialState)
  // Never restore a viewer-specific campaign projection from a cross-account
  // local cache. The authenticated room/SSE endpoints repopulate it.
  return { ...structuredClone(initialState), sessionCode: selected, campaign: 'Загрузка кампании…' }
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
      ...(eventTypes.has('ActorMoved') || eventTypes.has('SceneAdvanced') ? { x: server.x, y: server.y } : {}),
    }
  })
  const sceneChanged = ['SceneAdvanced', 'AreaRevealed', 'ObjectiveUpdated', 'EntitySpawned'].some((type) => eventTypes.has(type))
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
      suggestions: authoritative.suggestions ?? current.suggestions,
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
  const [tacticalBusy, setTacticalBusy] = useState(false)
  const [tacticalError, setTacticalError] = useState<string | null>(null)
  const [merchantBusy, setMerchantBusy] = useState(false)
  const [merchantError, setMerchantError] = useState<string | null>(null)
  const [directorBusy, setDirectorBusy] = useState(false)
  const [directorError, setDirectorError] = useState<string | null>(null)
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
  const systemTickBusy = useRef(false)
  const actionEpoch = useRef(0)
  const queuedRooms = useRef<Array<{ version: number; state: GameState }>>([])
  const persistLocal = useCallback((next: GameState) => {
    localStorage.setItem(ACTIVE_CAMPAIGN_KEY, next.sessionCode)
  }, [])

  const applyRemote = useCallback((next: GameState) => {
    const recovered = stateForPersistence(next)
    stateRef.current = recovered
    setState(recovered)
    persistLocal(recovered)
    channel.current?.postMessage(recovered)
  }, [persistLocal])

  const applyRoomSnapshot = useCallback((room: RoomSnapshot) => {
    if (!room.state) return
    roomVersion.current = latestRoomVersion(roomVersion.current, room.version)
    applyRemote(room.state)
  }, [applyRemote])

  const queueRoomSnapshot = useCallback((room: RoomSnapshot) => {
    if (!room.state) return
    const version = Number(room.version)
    if (!Number.isSafeInteger(version) || version < 0) return
    queuedRooms.current.push({ version, state: room.state })
    if (queuedRooms.current.length > 50) queuedRooms.current.splice(0, queuedRooms.current.length - 50)
  }, [])

  const flushQueuedRooms = useCallback(() => {
    if (busy.current || tacticalBusyRef.current || merchantBusyRef.current || directorBusyRef.current || systemTickBusy.current) return
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
        const room = JSON.parse(event.data) as RoomSnapshot
        if (!room.state) return
        if (busy.current || tacticalBusyRef.current || merchantBusyRef.current || directorBusyRef.current || systemTickBusy.current) {
          queueRoomSnapshot(room)
          return
        }
        applyRoomSnapshot(room)
      } catch (error) {
        console.warn('Realtime-событие комнаты отклонено:', error)
      }
    }
    const closeSource = () => {
      if (!source) return
      source.removeEventListener('room', receive as EventListener)
      source.close()
      source = null
    }
    const scheduleReconnect = () => {
      if (!active || retryScheduled) return
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
      nextSource.onopen = () => {
        retryDelay = 1_000
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
  }, [applyRoomSnapshot, flushQueuedRooms, queueRoomSnapshot, state.sessionCode])

  useEffect(() => {
    if (!busy.current && !tacticalBusy && !merchantBusy && !directorBusy) flushQueuedRooms()
  }, [directorBusy, flushQueuedRooms, merchantBusy, state.isNarrating, tacticalBusy])

  useEffect(() => {
    let active = true
    const sync = async () => {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(state.sessionCode)}`)
        if (!response.ok) return
        let room = await response.json() as RoomSnapshot & { version: number }
        if (!active) return
        const combat = room.state?.mechanics?.combat
        const activeActorId = combat?.initiative?.[combat.active_index ?? 0]?.actor_id ?? room.state?.activePlayerId
        const partyControlsTurn = room.state?.players?.some((player) => player.id === activeActorId)
        if (combat?.active && activeActorId && !partyControlsTurn && !systemTickBusy.current) {
          systemTickBusy.current = true
          try {
            const tickResponse = await fetch(`/api/campaigns/${encodeURIComponent(state.sessionCode)}/system-tick`, { method: 'POST' })
            if (tickResponse.ok) room = await tickResponse.json() as RoomSnapshot & { version: number }
          } finally {
            systemTickBusy.current = false
            flushQueuedRooms()
          }
        }
        if (!room.state && state.sessionCode === initialState.sessionCode) {
          roomVersion.current = room.version
          applyRemote(structuredClone(initialState))
          persistRemote(structuredClone(initialState))
        } else if (room.state && room.version > roomVersion.current) {
          if (busy.current || tacticalBusyRef.current || merchantBusyRef.current || directorBusyRef.current || systemTickBusy.current) {
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
  }, [applyRemote, applyRoomSnapshot, flushQueuedRooms, persistRemote, queueRoomSnapshot, state.sessionCode])

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

  const finishTurn = useCallback((current: GameState, _action: string, aiResult: AiTurnResult, roll?: RollResult): GameState => {
    const base = mergeAuthoritativeState(current, aiResult)
    const consumesTurn = aiResult.turn_consumed !== false
    const narratorMessage: Message = {
      id: `${Date.now()}-agent`, speaker: 'narrator', author: 'Рассказчик',
      timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
      text: aiResult.narration, roll: aiResult.effects.roll ?? roll, turnConsumed: consumesTurn,
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
      suggestions: aiResult?.suggestions?.length ? aiResult.suggestions : base.suggestions,
    }
  }, [])

  const submitAction = useCallback(async (text: string) => {
    if (!text.trim() || state.isNarrating || state.pendingCheck) return
    busy.current = true
    const epoch = ++actionEpoch.current
    const player = state.players.find((item) => item.id === state.activePlayerId) ?? state.players[0]
    const pending: GameState = {
      ...state,
      isNarrating: true,
      messages: [...state.messages, playerMessage(player.character, text.trim())],
    }
    commit(pending)

    let aiResult: AiTurnResult | null = null
    let authoritativeError: string | null = null
    try {
      aiResult = await narrateWithAgent(pending, text.trim(), player.character)
    } catch (error) {
      console.warn('AI fallback:', error instanceof Error ? error.message : error)
      authoritativeError = error instanceof Error ? error.message : 'Сервер отклонил действие'
    }
    if (epoch !== actionEpoch.current) { busy.current = false; return }
    if (authoritativeError) {
      mutate((current) => ({
        ...current,
        isNarrating: false,
        messages: [...current.messages, {
          id: `${Date.now()}-server-rejection`, speaker: 'system', author: 'Правила игры',
          timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
          text: authoritativeError,
          turnConsumed: false,
        }],
      }))
      busy.current = false
      return
    }
    if (aiResult?.room_version) roomVersion.current = latestRoomVersion(roomVersion.current, aiResult.room_version)

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
      return
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
  }, [commit, finishTurn, mutate, state])

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

    const player = state.players.find((item) => item.id === check.playerId) ?? state.players[0]
    let aiResult: AiTurnResult | null = null
    try {
      aiResult = await narrateWithAgent(state, check.action, player.character, result)
    } catch (error) {
      mutate((current) => ({
        ...current,
        isNarrating: false,
        pendingCheck: current.pendingCheck ? { ...current.pendingCheck, status: 'ready' } : null,
        messages: [...current.messages, {
          id: `${Date.now()}-resolution-error`, speaker: 'system', author: 'Правила игры',
          timestamp: clock(),
          text: error instanceof Error ? error.message : 'Сервер не смог разрешить проверку.',
          turnConsumed: false,
        }],
      }))
      busy.current = false
      return
    }
    if (epoch !== actionEpoch.current) { busy.current = false; return }
    if (aiResult?.room_version) roomVersion.current = latestRoomVersion(roomVersion.current, aiResult.room_version)
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
  }, [finishTurn, mutate, state])

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

  const rollFreeDie = useCallback(async (playerId: string): Promise<DiceRollEvent> => {
    if (freeRollBusy.current) throw new Error('Предыдущий бросок ещё не завершён')
    freeRollBusy.current = true
    try {
      // This endpoint rolls and updates the room in one server-side operation.
      // Unlike a skill check, it does not touch messages, the active hero or turn.
      const room = await rollSharedDie(state.sessionCode, playerId)
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
      const result = await response.json() as { version?: number; state?: GameState; error?: string }
      if (!response.ok || !result.state) throw new Error(result.error || 'Не удалось записать голос')
      roomVersion.current = latestRoomVersion(roomVersion.current, result.version)
      applyRemote(result.state)
    } catch (error) {
      setDirectorError(error instanceof Error ? error.message : 'Не удалось записать голос')
    }
  }, [applyRemote])

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
      const result = await response.json() as { version?: number; state?: GameState; error?: string }
      if (!response.ok || !result.state) throw new Error(result.error || 'Не удалось воздержаться')
      roomVersion.current = latestRoomVersion(roomVersion.current, result.version)
      applyRemote(result.state)
    } catch (error) {
      setDirectorError(error instanceof Error ? error.message : 'Не удалось воздержаться')
    }
  }, [applyRemote])

  const rollAgentInteraction = useCallback(async (playerId: string): Promise<DiceRollEvent> => {
    const current = stateRef.current
    const interaction = current.agentInteraction
    if (!interaction || interaction.type !== 'roll' || interaction.status !== 'open') throw new Error('Общий бросок сейчас не требуется')
    const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/party-decisions/${encodeURIComponent(interaction.id)}/roll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_id: playerId, idempotency_key: commandId() }),
    })
    const result = await response.json() as { version?: number; state?: GameState; roll?: DiceRollEvent; error?: string }
    if (!response.ok || !result.state || !result.roll) throw new Error(result.error || 'Не удалось выполнить общий бросок')
    roomVersion.current = latestRoomVersion(roomVersion.current, result.version)
    applyRemote(result.state)
    return result.roll
  }, [applyRemote])

  const continueAgentInteraction = useCallback(() => {
    const interaction = state.agentInteraction
    if (!interaction || interaction.status !== 'resolved') return
    const winner = interaction.options.find((option) => option.id === interaction.resolvedOptionId)
    if (!winner) return
    void submitAction(`[РЕШЕНИЕ ГРУППЫ] ${interaction.title}: ${winner.label}. ${interaction.resolutionPrompt}`)
  }, [state.agentInteraction, submitAction])

  const executeTacticalCommand = useCallback(async (command: TacticalCommand, message: string) => {
    if (tacticalBusyRef.current) return
    const current = stateRef.current
    const combatActorId = currentCombatActorId(current)
    if (!canIssueUiTacticalCommand(current.mechanics?.combat, command, combatActorId)) {
      setTacticalError('Сейчас ход другого участника боя.')
      return
    }

    const requestId = commandId()
    tacticalBusyRef.current = true
    setTacticalBusy(true)
    setTacticalError(null)
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(current.sessionCode)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, idempotency_key: requestId, message }),
      })
      const result = await response.json().catch(() => null) as TacticalCommandResult | null
      if (!response.ok) throw new Error(result?.error || `Сервер отклонил команду (${response.status})`)

      let authoritative = result?.authoritative_state
      let version = result?.room_version
      if (!authoritative) {
        const roomResponse = await fetch(`/api/rooms/${encodeURIComponent(current.sessionCode)}`)
        const room = await roomResponse.json().catch(() => null) as { version?: number; state?: GameState | null; error?: string } | null
        if (!roomResponse.ok || !room?.state) throw new Error(room?.error || 'Сервер не вернул итоговое состояние боя')
        authoritative = room.state
        version = room.version ?? version
      }
      if (version != null) roomVersion.current = latestRoomVersion(roomVersion.current, version)
      applyRemote(mergeTacticalCommandState(stateRef.current, authoritative, result ?? {}, requestId))
    } catch (error) {
      setTacticalError(error instanceof Error ? error.message : 'Не удалось выполнить команду на сервере')
    } finally {
      tacticalBusyRef.current = false
      setTacticalBusy(false)
    }
  }, [applyRemote])

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
      if (!response.ok || !result?.authoritative_state) {
        throw new Error(result?.error || `Сервер отклонил изменение персонажа (${response.status})`)
      }
      if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
      applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, result, requestId))
    } catch (error) {
      setTacticalError(error instanceof Error ? error.message : 'Не удалось сохранить развитие персонажа')
      throw error
    }
  }, [applyRemote])

  const selectPlayer = useCallback((playerId: string) => commit({ ...state, activePlayerId: playerId }), [commit, state])

  const startCombat = useCallback((playerId: string) => {
    void executeTacticalCommand({ command_type: 'StartCombat', actor_id: playerId }, 'Начать бой')
  }, [executeTacticalCommand])

  const movePlayer = useCallback((playerId: string, x: number, y: number) => {
    void executeTacticalCommand({ command_type: 'MoveActor', actor_id: playerId, to: { x, y } }, `Переместить героя на клетку ${x}, ${y}`)
  }, [executeTacticalCommand])

  const attackEnemy = useCallback((playerId: string, enemyId: string, itemId?: string, knockOut = false) => {
    void executeTacticalCommand({ command_type: 'MakeAttack', actor_id: playerId, target_id: enemyId, ...(itemId ? { item_id: itemId } : {}), ...(knockOut ? { knock_out: true } : {}) } as TacticalCommand, knockOut ? 'Нокаутировать выбранную цель' : 'Атаковать выбранную цель')
  }, [executeTacticalCommand])

  const throwAreaItem = useCallback((playerId: string, itemId: string, x: number, y: number) => {
    void executeTacticalCommand({ command_type: 'MakeAreaAttack', actor_id: playerId, item_id: itemId, to: { x, y } }, `Бросить предмет в клетку ${x}, ${y}`)
  }, [executeTacticalCommand])

  const castSpell = useCallback((actorId: string, spellId: string, target: ({ targetId: string } | { x: number; y: number }) & { spellOption?: string; knockOut?: boolean }) => {
    const command: TacticalCommand = 'targetId' in target
      ? { command_type: 'CastSpell', actor_id: actorId, spell_id: spellId, target_id: target.targetId, ...(target.spellOption ? { spell_option: target.spellOption } : {}), ...(target.knockOut ? { knock_out: true } : {}) }
      : { command_type: 'CastSpell', actor_id: actorId, spell_id: spellId, to: { x: target.x, y: target.y }, ...(target.spellOption ? { spell_option: target.spellOption } : {}) }
    void executeTacticalCommand(command, 'Сотворить выбранное заклинание')
  }, [executeTacticalCommand])

  const changeWeapon = useCallback((playerId: string, itemId: string) => {
    void executeTacticalCommand({ command_type: 'ChangeWeapon', actor_id: playerId, item_id: itemId }, 'Сменить оружие')
  }, [executeTacticalCommand])

  const useCombatAction = useCallback((actorId: string, actionId: string, targetId?: string, itemId?: string, beneficiaryId?: string) => {
    void executeTacticalCommand({
      command_type: 'UseCombatAction', actor_id: actorId, action_id: actionId,
      ...(targetId ? { target_id: targetId } : {}),
      ...(itemId ? { item_id: itemId } : {}),
      ...(beneficiaryId ? { beneficiary_id: beneficiaryId } : {}),
    }, 'Использовать выбранное боевое действие')
  }, [executeTacticalCommand])

  const finishMapTurn = useCallback(() => {
    const current = stateRef.current
    void executeTacticalCommand({ command_type: 'EndTurn', actor_id: currentCombatActorId(current) }, 'Завершить ход')
  }, [executeTacticalCommand])

  const resolveHeroDeath = useCallback((playerId: string, resolution: 'resurrect' | 'replace', replacementName?: string) => {
    void executeTacticalCommand({
      command_type: 'ResolveHeroDeath',
      actor_id: playerId,
      resolution,
      ...(resolution === 'replace' ? { replacement_name: String(replacementName ?? '').trim() } : {}),
    }, resolution === 'resurrect' ? 'Воскресить погибшего героя' : 'Заменить погибшего героя новым')
  }, [executeTacticalCommand])

  const equipItem = useCallback((playerId: string, itemId: string, equipped: boolean) => {
    void executeTacticalCommand({ command_type: 'EquipItem', actor_id: playerId, item_id: itemId, equipped }, equipped ? 'Экипировать предмет' : 'Снять предмет')
  }, [executeTacticalCommand])

  const useItem = useCallback((playerId: string, itemId: string, targetId?: string) => {
    void executeTacticalCommand({ command_type: 'UseItem', actor_id: playerId, item_id: itemId, ...(targetId ? { target_id: targetId } : {}) }, 'Использовать предмет')
  }, [executeTacticalCommand])

  const transferItem = useCallback((playerId: string, itemId: string, recipientId: string, quantity = 1) => {
    void executeTacticalCommand({ command_type: 'TransferItem', actor_id: playerId, item_id: itemId, recipient_id: recipientId, quantity }, 'Передать предмет союзнику')
  }, [executeTacticalCommand])

  const attuneItem = useCallback((playerId: string, itemId: string, attuned: boolean) => {
    void executeTacticalCommand({ command_type: 'AttuneItem', actor_id: playerId, item_id: itemId, attuned }, attuned ? 'Настроиться на предмет' : 'Разорвать настройку')
  }, [executeTacticalCommand])

  const importCharacter = useCallback((playerId: string, source: string) => {
    let document: unknown
    try {
      document = JSON.parse(source)
    } catch {
      setTacticalError('Файл персонажа должен содержать корректный JSON.')
      return
    }
    void executeTacticalCommand({ command_type: 'ImportCharacter', actor_id: playerId, document }, 'Импортировать версионированный лист персонажа')
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
    if (prefetched?.state) {
      roomVersion.current = prefetched.version ?? 0
      applyRemote(prefetched.state)
      const url = new URL(window.location.href)
      url.searchParams.set('room', normalized)
      window.history.replaceState(null, '', url)
      return
    }
    const response = await fetch('/api/rooms/' + encodeURIComponent(normalized))
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
      if (response.status === 409) {
        setMerchantView(null)
        throw new Error('Котировки устарели: кто-то уже изменил деньги или склад. Обновите цены перед новой попыткой.')
      }
      if (!response.ok) throw new Error(result?.error || `Торговец отклонил действие (${response.status})`)
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
  }, [applyRemote, merchantView])

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
    if (!response.ok) throw new Error(result?.error || `Сервер отклонил изменение торговца (${response.status})`)
    if (!result?.authoritative_state) throw new Error('Сервер не вернул состояние после изменения торговца')
    if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
    applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, {}, requestId))
  }, [applyRemote])

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
    if (!response.ok) throw new Error(result?.error || `ShopAssembler отклонил запрос (${response.status})`)
    if (!result?.authoritative_state || !result.shop_proposal?.merchant) throw new Error('Сервер не вернул созданного торговца')
    if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
    applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, {}, requestId))
    return result.shop_proposal.merchant
  }, [applyRemote])

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
    if (!response.ok) throw new Error(result?.error || `EncounterAssembler отклонил запрос (${response.status})`)
    if (!result?.authoritative_state || !result.encounter_proposal) throw new Error('Сервер не вернул собранное столкновение')
    if (result.room_version != null) roomVersion.current = latestRoomVersion(roomVersion.current, result.room_version)
    applyRemote(mergeTacticalCommandState(stateRef.current, result.authoritative_state, result, requestId))
    return result.encounter_proposal
  }, [applyRemote])

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
      const result = await response.json().catch(() => null) as { state?: GameState; state_version?: number; intent?: { type?: string }; error?: string } | null
      if (!response.ok || !result?.state) throw new Error(result?.error || `Director не смог продолжить приключение (${response.status})`)
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
  }, [applyRemote])

  const reset = useCallback(() => mutate((current) => {
    const fresh = structuredClone(initialState)
    const members = current.partyMemberIds?.length ? current.partyMemberIds : current.players.map((player) => player.id)
    return {
      ...fresh,
      sessionCode: current.sessionCode,
      campaign: current.campaign,
      partyName: current.partyName,
      partyMemberIds: members,
      players: current.players.map((player, index) => ({ ...player, hp: player.maxHp, x: fresh.players[index]?.x ?? 3, y: fresh.players[index]?.y ?? 4 })),
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
    connectionState,
    tacticalBusy,
    tacticalError,
    merchantBusy,
    merchantError,
    directorBusy,
    directorError,
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
    movePlayer,
    attackEnemy,
    throwAreaItem,
    castSpell,
    useCombatAction,
    changeWeapon,
    finishMapTurn,
    resolveHeroDeath,
    equipItem,
    useItem,
    transferItem,
    attuneItem,
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
