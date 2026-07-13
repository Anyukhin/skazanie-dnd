import { useCallback, useEffect, useRef, useState } from 'react'
import { initialState } from './data'
import { generateItemImage, narrateWithAgent, rollDice, rollSharedDie } from './ai-client'
import { createLocalCheck, playerMessage, resolveAction } from './game-engine'
import type { AgentInteraction, AiTurnResult, DiceRollEvent, EncounterDifficulty, EncounterProposal, EncounterTheme, GameEvent, GameState, InventoryItem, Merchant, MerchantView, Message, Player, RollResult } from './types'

const STORAGE_KEY = 'skazanie-demo-session-v1'
const CHANNEL_NAME = 'skazanie-demo-room'

type TacticalCommand =
  | { command_type: 'StartCombat'; actor_id: string }
  | { command_type: 'MoveActor'; actor_id: string; to: { x: number; y: number } }
  | { command_type: 'MakeAttack'; actor_id: string; target_id: string }
  | { command_type: 'MakeAttack'; actor_id: string; target_id: string; item_id: string }
  | { command_type: 'MakeAreaAttack'; actor_id: string; item_id: string; to: { x: number; y: number } }
  | { command_type: 'CastSpell'; actor_id: string; spell_id: string; target_id: string; spell_option?: string }
  | { command_type: 'CastSpell'; actor_id: string; spell_id: string; to: { x: number; y: number }; spell_option?: string }
  | { command_type: 'UseCombatAction'; actor_id: string; action_id: string; target_id?: string; item_id?: string }
  | { command_type: 'ChangeWeapon'; actor_id: string; item_id: string }
  | { command_type: 'EndTurn'; actor_id: string }

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

type MerchantCommandResult = {
  authoritative_state?: GameState
  merchant_view?: MerchantView
  narration?: string
  room_version?: number
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
  | { command_type: 'MoveMerchant'; merchant_id: string; location: string }
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
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return requested && requested !== initialState.sessionCode
      ? { ...structuredClone(initialState), sessionCode: requested, campaign: 'Загрузка кампании…' }
      : structuredClone(initialState)
    const parsed = JSON.parse(saved) as GameState
    if (requested && parsed.sessionCode !== requested) {
      return { ...structuredClone(initialState), sessionCode: requested, campaign: 'Загрузка кампании…' }
    }
    return {
      ...initialState,
      ...parsed,
      engine_mode: 'enforce',
      // Narration progress belongs to the tab that owns the request. Restoring
      // it would turn a closed or refreshed request into an endless loader.
      isNarrating: false,
      pendingCheck: parsed.pendingCheck ?? null,
      agentInteraction: parsed.agentInteraction ?? null,
      partyMemberIds: parsed.partyMemberIds?.length ? parsed.partyMemberIds : parsed.players.map((player) => player.id),
      enemies: parsed.enemies ?? initialState.enemies,
      tacticalTurn: parsed.tacticalTurn,
      mapFeedback: parsed.mapFeedback ?? [],
      players: parsed.players.map((player) => {
        const fallback = initialState.players.find((initial) => initial.id === player.id) ?? initialState.players[0]
        return {
          ...fallback,
          ...player,
          portrait: player.portrait || fallback.portrait,
          portraitPosition: player.portraitPosition || fallback.portraitPosition,
          abilities: { ...fallback.abilities, ...player.abilities },
          currency: { ...fallback.currency, ...player.currency },
          inventory: player.inventory ?? fallback.inventory,
        }
      }),
    }
  } catch {
    return structuredClone(initialState)
  }
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

function applyLegacyHazards(mechanics: GameState['mechanics'], effects: NonNullable<AiTurnResult['effects']['hazards']>) {
  const next = structuredClone(mechanics ?? {}) as Record<string, unknown> & { hazards?: Record<string, Array<Record<string, unknown> & { id: string }>> }
  next.hazards = structuredClone(next.hazards ?? {})
  for (const effect of effects) {
    const current = next.hazards[effect.targetId] ?? []
    next.hazards[effect.targetId] = effect.operation === 'remove'
      ? current.filter((hazard) => hazard.id !== effect.hazard.id)
      : [...current.filter((hazard) => hazard.id !== effect.hazard.id), structuredClone(effect.hazard)]
  }
  return next
}

function nextTurnPlayerId(state: GameState, authoritative: boolean) {
  const combat = (state.mechanics as { combat?: { active?: boolean; active_index?: number; initiative?: Array<{ actor_id?: string }> } } | undefined)?.combat
  if (combat?.active && combat.initiative?.length) {
    if (authoritative) return combat.initiative[Math.max(0, Number(combat.active_index) || 0)]?.actor_id
    const currentIndex = combat.initiative.findIndex((entry) => entry.actor_id === state.activePlayerId)
    return combat.initiative[(currentIndex + 1 + combat.initiative.length) % combat.initiative.length]?.actor_id
  }
  const members = new Set(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((item) => item.id))
  const onlinePlayers = state.players.filter((item) => item.online && members.has(item.id) && item.hp > 0)
  const activeIndex = onlinePlayers.findIndex((item) => item.id === state.activePlayerId)
  return (onlinePlayers[(activeIndex + 1) % onlinePlayers.length] ?? state.players[0])?.id
}

export function useGameSession() {
  const [state, setState] = useState<GameState>(loadState)
  const [tacticalBusy, setTacticalBusy] = useState(false)
  const [tacticalError, setTacticalError] = useState<string | null>(null)
  const [merchantBusy, setMerchantBusy] = useState(false)
  const [merchantError, setMerchantError] = useState<string | null>(null)
  const [merchantView, setMerchantView] = useState<MerchantView | null>(null)
  const [merchantNarration, setMerchantNarration] = useState<string | null>(null)
  const stateRef = useRef(state)
  const channel = useRef<BroadcastChannel | null>(null)
  const roomVersion = useRef(0)
  const busy = useRef(false)
  const tacticalBusyRef = useRef(false)
  const merchantBusyRef = useRef(false)
  const freeRollBusy = useRef(false)
  const actionEpoch = useRef(0)
  const writeQueue = useRef(Promise.resolve())

  const applyRemote = useCallback((next: GameState) => {
    const recovered = stateForPersistence(next)
    stateRef.current = recovered
    setState(recovered)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recovered))
    channel.current?.postMessage(recovered)
  }, [])

  const persistRemote = useCallback((next: GameState) => {
    writeQueue.current = writeQueue.current.then(async () => {
      const response = await fetch(`/api/rooms/${encodeURIComponent(next.sessionCode)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: stateForPersistence(next), baseVersion: roomVersion.current }),
      })
      const room = await response.json().catch(() => null) as { version?: number; state?: GameState } | null
      if (response.status === 409 && room?.state) {
        roomVersion.current = latestRoomVersion(roomVersion.current, room.version)
        if (!busy.current) applyRemote(room.state)
        return
      }
      if (response.ok && room?.version) roomVersion.current = latestRoomVersion(roomVersion.current, room.version)
      if (response.ok && room?.state && stateRef.current === next && !busy.current && !tacticalBusyRef.current) {
        applyRemote(room.state)
      }
    }).catch((error) => console.warn('Синхронизация комнаты:', error))
  }, [applyRemote])

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    channel.current = new BroadcastChannel(CHANNEL_NAME)
    channel.current.onmessage = (event: MessageEvent<GameState>) => {
      const recovered = stateForPersistence(event.data)
      stateRef.current = recovered
      setState(recovered)
    }
    return () => channel.current?.close()
  }, [])

  useEffect(() => {
    let active = true
    const sync = async () => {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(state.sessionCode)}`)
        if (!response.ok) return
        const room = await response.json() as { version: number; state: GameState | null }
        if (!active) return
        if (!room.state && state.sessionCode === initialState.sessionCode) {
          roomVersion.current = room.version
          applyRemote(structuredClone(initialState))
          persistRemote(structuredClone(initialState))
      } else if (room.state && room.version > roomVersion.current && !busy.current && !tacticalBusyRef.current && !merchantBusyRef.current) {
          roomVersion.current = room.version
          applyRemote(room.state)
        }
      } catch (error) { console.warn('Комната временно недоступна:', error) }
    }
    void sync()
    const timer = window.setInterval(sync, 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [applyRemote, persistRemote, state.sessionCode])

  const commit = useCallback((next: GameState) => {
    stateRef.current = next
    setState(next)
    const shared = stateForPersistence(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shared))
    channel.current?.postMessage(shared)
    persistRemote(next)
  }, [persistRemote])

  const mutate = useCallback((recipe: (current: GameState) => GameState) => {
    const current = stateRef.current
    const next = recipe(current)
    if (next === current) return
    stateRef.current = next
    setState(next)
    const shared = stateForPersistence(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shared))
    channel.current?.postMessage(shared)
    persistRemote(next)
  }, [persistRemote])

  const finishTurn = useCallback((current: GameState, action: string, aiResult: AiTurnResult | null, roll?: RollResult): GameState => {
    const base = mergeAuthoritativeState(current, aiResult)
    const hasAuthoritativeState = Boolean(aiResult?.authoritative_state)
    const sceneTransition = !hasAuthoritativeState ? aiResult?.effects.scene : null
    const fallback = aiResult ? null : resolveAction(base, action, roll)
    const aiCells = aiResult && !hasAuthoritativeState ? base.scene.cells.map((cell) => {
      const revealed = aiResult.effects.reveal.some((item) => item.x === cell.x && item.y === cell.y)
      const spawned = aiResult.effects.spawn.find((item) => item.x === cell.x && item.y === cell.y)
      return { ...cell, revealed: revealed || cell.revealed, feature: spawned?.kind ?? cell.feature }
    }) : null
    const consumesTurn = aiResult ? aiResult.turn_consumed !== false : fallback?.turnConsumed ?? true
    const narratorMessage: Message = aiResult ? {
      id: `${Date.now()}-agent`, speaker: 'narrator', author: 'Рассказчик',
      timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
      text: aiResult.narration, roll: aiResult.effects.roll ?? roll, turnConsumed: consumesTurn,
    } : { ...fallback!.message, turnConsumed: consumesTurn }
    const nextInteraction = aiResult?.effects.interaction
      ?? (action.startsWith('[РЕШЕНИЕ ГРУППЫ]') ? null : base.agentInteraction)
    const narrationPersisted = Boolean(aiResult?.narration_message_id)
      && base.messages.some((message) => message.id === aiResult?.narration_message_id)
    return {
      ...base,
      state_version: aiResult?.state_version ?? base.state_version,
      mechanics: !hasAuthoritativeState && aiResult?.effects.hazards?.length ? applyLegacyHazards(base.mechanics, aiResult.effects.hazards) : base.mechanics,
      isNarrating: false,
      pendingCheck: null,
      agentInteraction: nextInteraction,
      // An authoritative response already contains the canonical turn owner.
      // Advancing it again on the client causes a different state after reload.
      activePlayerId: consumesTurn && !hasAuthoritativeState ? nextTurnPlayerId(base, false) ?? base.activePlayerId : base.activePlayerId,
      messages: narrationPersisted ? base.messages : [...base.messages, narratorMessage],
      suggestions: aiResult?.suggestions?.length ? aiResult.suggestions : sceneTransition?.suggestions?.length ? sceneTransition.suggestions : base.suggestions,
      players: base.players.map((existing) => {
        const additions = hasAuthoritativeState ? [] : aiResult?.effects.grantItems?.filter((item) => item.ownerId === existing.id) ?? []
        const withItems = additions.length ? { ...existing, inventory: [...existing.inventory, ...additions] } : existing
        return sceneTransition ? { ...withItems, x: sceneTransition.entrance.x, y: sceneTransition.entrance.y } : withItems
      }),
      entities: sceneTransition ? [] : base.entities,
      adventure: sceneTransition?.adventure ?? base.adventure,
      scene: hasAuthoritativeState ? base.scene : sceneTransition?.scene ?? {
        ...base.scene,
        turn: base.scene.turn + (consumesTurn ? 1 : 0),
        cells: aiCells ?? fallback?.cells ?? base.scene.cells,
        objective: hasAuthoritativeState ? base.scene.objective : aiResult?.effects.objective ?? fallback?.objective ?? base.scene.objective,
      },
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
      if (pending.engine_mode === 'enforce') authoritativeError = error instanceof Error ? error.message : 'Сервер отклонил действие'
      else await new Promise((resolve) => window.setTimeout(resolve, 700))
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

    const check = aiResult?.check ?? (!aiResult ? createLocalCheck(pending, text) : null)
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

    mutate((current) => finishTurn(current, text, aiResult))
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
    } catch {
      if (check.check_id) {
        mutate((current) => current.pendingCheck ? { ...current, pendingCheck: { ...current.pendingCheck, status: 'ready' }, isNarrating: false } : current)
        busy.current = false
        return
      }
      const value = Math.floor(Math.random() * 20) + 1
      result = { value, modifier: check.modifier, total: value + check.modifier, label: check.label, success: value + check.modifier >= check.difficulty }
      await new Promise((resolve) => window.setTimeout(resolve, 900))
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
      console.warn('AI resolution fallback:', error instanceof Error ? error.message : error)
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    }
    if (epoch !== actionEpoch.current) { busy.current = false; return }
    if (aiResult?.room_version) roomVersion.current = latestRoomVersion(roomVersion.current, aiResult.room_version)
    mutate((current) => finishTurn(current, check.action, aiResult, result))
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

  const voteAgentInteraction = useCallback((playerId: string, optionId: string) => mutate((current) => {
    const interaction = current.agentInteraction
    if (!interaction || interaction.status !== 'open' || interaction.type === 'roll' || !interaction.options.some((option) => option.id === optionId)) return current
    const votes = { ...interaction.votes, [playerId]: optionId }
    const eligible = current.players.filter((player) => player.online).map((player) => player.id)
    const required = interaction.type === 'choice' ? 1 : Math.floor(Math.max(1, eligible.length) / 2) + 1
    const winner = interaction.options.find((option) => Object.values(votes).filter((vote) => vote === option.id).length >= required)
    const resolved = Boolean(winner)
    const nextInteraction: AgentInteraction = {
      ...interaction,
      votes,
      status: resolved ? 'resolved' : 'open',
      resolvedOptionId: winner?.id,
    }
    return {
      ...current,
      agentInteraction: nextInteraction,
      messages: resolved ? [...current.messages, {
        id: `${Date.now()}-decision`, speaker: 'system', author: 'Решение отряда',
        timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
        text: `Выбран вариант: «${winner?.label}». Рассказчик готов продолжить историю.`,
        turnConsumed: false,
      }] : current.messages,
    }
  }), [mutate])

  const rollAgentInteraction = useCallback(async (playerId: string): Promise<DiceRollEvent> => {
    const interaction = state.agentInteraction
    if (!interaction || interaction.type !== 'roll' || interaction.status !== 'open') throw new Error('Общий бросок сейчас не требуется')
    const room = await rollSharedDie(state.sessionCode, playerId)
    roomVersion.current = latestRoomVersion(roomVersion.current, room.version)
    const latest = room.state.agentInteraction ?? interaction
    const success = room.roll.value >= (latest.difficulty ?? 12)
    const winner = latest.options[success ? 0 : 1] ?? latest.options[0]
    const next: GameState = {
      ...room.state,
      agentInteraction: { ...latest, status: 'resolved', resolvedOptionId: winner.id, roll: room.roll },
      messages: [...room.state.messages, {
        id: `${Date.now()}-party-roll`, speaker: 'system', author: 'Кубик судьбы',
        timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
        text: `Общий бросок: ${room.roll.value} против сложности ${latest.difficulty ?? 12}. Решение: «${winner.label}».`,
        turnConsumed: false,
      }],
    }
    commit(next)
    return room.roll
  }, [commit, state.agentInteraction, state.sessionCode])

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
    if (current.mechanics?.combat?.active && command.command_type !== 'StartCombat' && command.actor_id !== combatActorId) {
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

  const selectPlayer = useCallback((playerId: string) => commit({ ...state, activePlayerId: playerId }), [commit, state])

  const startCombat = useCallback((playerId: string) => {
    void executeTacticalCommand({ command_type: 'StartCombat', actor_id: playerId }, 'Начать бой')
  }, [executeTacticalCommand])

  const movePlayer = useCallback((playerId: string, x: number, y: number) => {
    void executeTacticalCommand({ command_type: 'MoveActor', actor_id: playerId, to: { x, y } }, `Переместить героя на клетку ${x}, ${y}`)
  }, [executeTacticalCommand])

  const attackEnemy = useCallback((playerId: string, enemyId: string, itemId?: string) => {
    void executeTacticalCommand({ command_type: 'MakeAttack', actor_id: playerId, target_id: enemyId, ...(itemId ? { item_id: itemId } : {}) } as TacticalCommand, 'Атаковать выбранную цель')
  }, [executeTacticalCommand])

  const throwAreaItem = useCallback((playerId: string, itemId: string, x: number, y: number) => {
    void executeTacticalCommand({ command_type: 'MakeAreaAttack', actor_id: playerId, item_id: itemId, to: { x, y } }, `Бросить предмет в клетку ${x}, ${y}`)
  }, [executeTacticalCommand])

  const castSpell = useCallback((actorId: string, spellId: string, target: ({ targetId: string } | { x: number; y: number }) & { spellOption?: string }) => {
    const command: TacticalCommand = 'targetId' in target
      ? { command_type: 'CastSpell', actor_id: actorId, spell_id: spellId, target_id: target.targetId, ...(target.spellOption ? { spell_option: target.spellOption } : {}) }
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

  const moveMerchant = useCallback((merchantId: string, location: string) => executeMerchantLifecycleCommand({
    command_type: 'MoveMerchant', merchant_id: merchantId, location,
  }), [executeMerchantLifecycleCommand])

  const setMerchantAvailability = useCallback((merchantId: string, available: boolean) => executeMerchantLifecycleCommand({
    command_type: 'SetMerchantAvailability', merchant_id: merchantId, available,
  }), [executeMerchantLifecycleCommand])

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

  const updatePlayer = useCallback((playerId: string, patch: Partial<Player>) => mutate((current) => ({
    ...current,
    players: current.players.map((player) => player.id === playerId ? { ...player, ...patch } : player),
  })), [mutate])

  const addItem = useCallback((playerId: string, item: InventoryItem) => mutate((current) => ({
    ...current,
    players: current.players.map((player) => player.id === playerId ? { ...player, inventory: [...player.inventory, item] } : player),
  })), [mutate])

  const updateItem = useCallback((playerId: string, itemId: string, patch: Partial<InventoryItem>) => mutate((current) => ({
    ...current,
    players: current.players.map((player) => player.id === playerId ? { ...player, inventory: player.inventory.map((item) => item.id === itemId ? { ...item, ...patch } : item) } : player),
  })), [mutate])

  const removeItem = useCallback((playerId: string, itemId: string) => mutate((current) => ({
    ...current,
    players: current.players.map((player) => player.id === playerId ? { ...player, inventory: player.inventory.filter((item) => item.id !== itemId) } : player),
  })), [mutate])

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
    tacticalBusy,
    tacticalError,
    merchantBusy,
    merchantError,
    merchantView,
    merchantNarration,
    clearTacticalError: () => setTacticalError(null),
    submitAction,
    rollPendingCheck,
    cancelPendingCheck,
    rollFreeDie,
    voteAgentInteraction,
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
    switchCampaign,
    loadMerchant,
    bargainWithMerchant,
    buyFromMerchant,
    sellToMerchant,
    appraiseWithMerchant,
    assembleMerchant,
    assembleEncounter,
    moveMerchant,
    setMerchantAvailability,
    reset,
    updatePlayer,
    addItem,
    updateItem,
    removeItem,
    updateWorld,
  }
}
