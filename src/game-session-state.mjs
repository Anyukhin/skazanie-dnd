/**
 * Чистые правила клиентской сессии: без React, сети и хранилищ.
 *
 * Вынесены из `src/useGameSession.ts`, чтобы проверяться напрямую
 * (`test/game-session-state.test.mjs`), а не через транспиляцию хука. Самое
 * рискованное здесь — слияние авторитетного состояния с локальным: ошибка в
 * нём молча откатывает экран к устаревшему снимку.
 */

const clock = () => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date())

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
export function twoPhaseCheckCommandFor(command) {
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

export const NARRATION_PREVIEW_TEXT_MAX_BYTES = 12 * 1024
export const NARRATION_PREVIEW_EVENT_MAX_BYTES = 16 * 1024
const NARRATION_PREVIEW_PHASES = new Set(['start', 'streaming', 'complete', 'replaced', 'aborted'])

/** Кадр `narration` живого потока. Бросает на битом JSON — как и прежде. */
export function parseNarrationPreview(value) {
  if (new TextEncoder().encode(value).byteLength > NARRATION_PREVIEW_EVENT_MAX_BYTES) return null
  const payload = JSON.parse(value)
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : ''
  const text = typeof payload.text === 'string' ? payload.text : ''
  const phase = typeof payload.phase === 'string' ? payload.phase : null
  if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(messageId) || !phase || !NARRATION_PREVIEW_PHASES.has(phase)) return null
  if (new TextEncoder().encode(text).byteLength > NARRATION_PREVIEW_TEXT_MAX_BYTES) return null
  return {
    messageId,
    text,
    phase,
    replayed: payload.replayed === true,
  }
}

/**
 * Предложение действия, которое переживает пришедший снимок: только той же
 * кампании и только если оно ещё отправляется или предложено ровно для этой
 * версии состояния.
 */
export function pendingActionForSnapshot(current, incoming) {
  const pending = current.sessionCode === incoming.sessionCode ? current.pendingAction : null
  return pending?.status === 'submitting' || pending?.proposal.state_version === incoming.state_version ? pending : null
}

/** Счётчик версии комнаты только растёт; мусор и отрицательные значения его не двигают. */
export function latestRoomVersion(current, candidate) {
  const version = Number(candidate)
  return Number.isSafeInteger(version) && version >= 0 ? Math.max(current, version) : current
}

/** Идёт ли бой с очередью инициативы. Бой без очереди — ещё не бой. */
export function combatTurnActive(state) {
  const combat = state.mechanics?.combat
  return Boolean(combat?.active && combat.initiative?.length)
}

/** Номер текущего хода в очереди инициативы; мусор — начало очереди. */
export function activeInitiativeIndex(combat) {
  return Math.max(0, Number(combat?.active_index) || 0)
}

/**
 * Чей ход: участник инициативы в бою, иначе выбранный герой. Единственное
 * место этого правила на клиенте — его читают хук сессии и стол.
 */
export function currentTurnActorId(state) {
  const combat = state.mechanics?.combat
  if (!combat?.active || !combat.initiative?.length) return state.activePlayerId
  return combat.initiative[activeInitiativeIndex(combat)]?.actor_id ?? state.activePlayerId
}

/**
 * Ответ тактической команды поверх локального состояния. Сервер присылает
 * игроков без части представления (портрет, его кадр) — они берутся из
 * локальной копии; реплика повествования добавляется один раз.
 */
export function mergeTacticalCommandState(current, authoritative, result, requestId) {
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
  const next = {
    ...current,
    ...authoritative,
    engine_mode: authoritative.engine_mode ?? current.engine_mode,
    turn_clock: authoritative.turn_clock ?? null,
    players,
    enemies: authoritative.enemies ?? current.enemies,
    actors: authoritative.actors ?? current.actors,
    merchants: authoritative.merchants ?? current.merchants,
    messages: withNarration,
    pendingCheck: authoritative.pendingCheck ?? null,
    agentInteraction: authoritative.agentInteraction ?? null,
    isNarrating: false,
  }
  return { ...next, activePlayerId: currentTurnActorId(next) }
}

/**
 * Ответ `/api/narrate` поверх локального состояния. Берётся не всё: позиции —
 * только после перемещения или смены сцены, инвентарь — только после выдачи
 * предмета, сцена целиком — только после событий, которые её меняют.
 */
export function mergeAuthoritativeState(current, result) {
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
    turn_clock: authoritative.turn_clock ?? null,
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
