const CONTROL_ACTIONS = new Set(['rewind_turn', 'replay_scene'])
const REWIND_EVENT = 'CampaignRewound'
const HARD_BOUNDARY_TYPES = new Set([
  'LegacyStateImported',
  'CampaignArcCompleted',
  'CampaignCompleted',
  'CampaignFailed',
  'CampaignArchived',
])
const SCENE_BOUNDARY_TYPES = new Set([
  'LegacyStateImported',
  'CampaignArcCompleted',
  'SceneAdvanced',
])
const NON_GAMEPLAY_TYPES = new Set([
  REWIND_EVENT,
  'CampaignPaused',
  'CampaignResumed',
  'CampaignArcChainSet',
  'NarrativeSummaryRecorded',
  'PublicDieRolled',
])

export class CampaignControlError extends Error {
  constructor(message, code = 'CAMPAIGN_CONTROL_ERROR') {
    super(message)
    this.name = 'CampaignControlError'
    this.code = code
  }
}

function safeVersion(value, label) {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new CampaignControlError(`${label} должен быть целой неотрицательной версией`, 'INVALID_CONTROL_VERSION')
  }
  return version
}

function orderedEvents(events, currentVersion) {
  const normalized = (Array.isArray(events) ? events : [])
    .map((event) => ({
      ...event,
      state_version_before: safeVersion(event?.state_version_before, 'state_version_before'),
      state_version_after: safeVersion(event?.state_version_after, 'state_version_after'),
    }))
    .sort((left, right) => left.state_version_after - right.state_version_after)
  for (const event of normalized) {
    if (event.state_version_after !== event.state_version_before + 1) {
      throw new CampaignControlError('Журнал содержит событие с разрывом версии', 'INVALID_CONTROL_HISTORY')
    }
  }
  const current = safeVersion(currentVersion, 'currentVersion')
  if ((normalized.at(-1)?.state_version_after ?? 0) > current) {
    throw new CampaignControlError('Журнал новее текущего состояния кампании', 'INVALID_CONTROL_HISTORY')
  }
  return normalized
}

function isGameplayEvent(event) {
  return !NON_GAMEPLAY_TYPES.has(String(event?.event_type ?? ''))
}

/**
 * После отката журнал остаётся append-only. Эта функция идёт по цепочке
 * CampaignRewound назад и отделяет действующую ветвь от уже отменённых событий.
 */
function semanticEvents(events) {
  let visible = events
  for (let guard = 0; guard <= events.length; guard += 1) {
    const rewindIndex = visible.findLastIndex((event) => event.event_type === REWIND_EVENT)
    if (rewindIndex < 0) return visible
    if (visible.slice(rewindIndex + 1).some(isGameplayEvent)) return visible
    const targetVersion = safeVersion(visible[rewindIndex]?.payload?.target_version, 'CampaignRewound.target_version')
    if (targetVersion >= visible[rewindIndex].state_version_before) {
      throw new CampaignControlError('CampaignRewound ссылается не на прошлую версию', 'INVALID_CONTROL_HISTORY')
    }
    visible = visible.filter((event) => event.state_version_after <= targetVersion)
  }
  throw new CampaignControlError('Цепочка откатов зациклена', 'INVALID_CONTROL_HISTORY')
}

function commandGroups(events) {
  const groups = []
  for (const event of events) {
    const commandId = String(event.command_id ?? event.idempotency_key ?? event.event_id ?? `version-${event.state_version_after}`)
    const previous = groups.at(-1)
    if (previous?.commandId === commandId && previous.endVersion === event.state_version_before) {
      previous.events.push(event)
      previous.endVersion = event.state_version_after
      continue
    }
    groups.push({
      commandId,
      startVersion: event.state_version_before,
      endVersion: event.state_version_after,
      events: [event],
    })
  }
  return groups
}

function lastGroupWith(groups, predicate) {
  return groups.findLast((group) => group.events.some(predicate)) ?? null
}

export function planCampaignControl({ action, events, currentVersion }) {
  const normalizedAction = String(action ?? '').trim()
  if (!CONTROL_ACTIONS.has(normalizedAction)) {
    throw new CampaignControlError(`Неизвестное действие ведущего: ${normalizedAction || '<пусто>'}`, 'INVALID_CAMPAIGN_CONTROL')
  }
  const history = semanticEvents(orderedEvents(events, currentVersion))
  const groups = commandGroups(history)
  const semanticVersion = history.at(-1)?.state_version_after ?? 0
  const hardBoundary = lastGroupWith(groups, (event) => HARD_BOUNDARY_TYPES.has(event.event_type))
  const boundaryVersion = hardBoundary?.endVersion ?? 0

  if (normalizedAction === 'replay_scene') {
    const sceneBoundary = lastGroupWith(groups, (event) => SCENE_BOUNDARY_TYPES.has(event.event_type))
    const targetVersion = Math.max(boundaryVersion, sceneBoundary?.endVersion ?? 0)
    if (semanticVersion <= targetVersion) {
      throw new CampaignControlError('Текущая сцена ещё не содержит действий для переигрывания', 'NOTHING_TO_REPLAY')
    }
    return Object.freeze({
      action: normalizedAction,
      targetVersion,
      semanticVersion,
      commandId: sceneBoundary?.commandId ?? null,
      revertedEventTypes: history
        .filter((event) => event.state_version_after > targetVersion)
        .map((event) => event.event_type),
    })
  }

  const candidate = groups.findLast((group) => (
    group.startVersion >= boundaryVersion
    && !group.events.some((event) => HARD_BOUNDARY_TYPES.has(event.event_type))
    && group.events.some(isGameplayEvent)
  ))
  if (!candidate) {
    throw new CampaignControlError('В текущей арке нет хода, который можно откатить', 'NOTHING_TO_REWIND')
  }
  return Object.freeze({
    action: normalizedAction,
    targetVersion: candidate.startVersion,
    semanticVersion,
    commandId: candidate.commandId,
    revertedEventTypes: candidate.events.map((event) => event.event_type),
  })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function campaignRewindEvent({
  action,
  targetState,
  currentState,
  targetVersion,
  actorId,
  occurredAt = new Date().toISOString(),
}) {
  const normalizedAction = String(action ?? '').trim()
  if (!CONTROL_ACTIONS.has(normalizedAction)) {
    throw new CampaignControlError(`Неизвестное действие ведущего: ${normalizedAction || '<пусто>'}`, 'INVALID_CAMPAIGN_CONTROL')
  }
  if (!targetState || typeof targetState !== 'object' || Array.isArray(targetState)) {
    throw new CampaignControlError('Не найдено состояние для отката', 'INVALID_REWIND_STATE')
  }
  const state = clone(targetState)
  const currentLifecycle = currentState?.mechanics?.campaign_lifecycle
  if (currentLifecycle && typeof currentLifecycle === 'object' && !Array.isArray(currentLifecycle)) {
    state.mechanics = {
      ...(state.mechanics ?? {}),
      campaign_lifecycle: clone(currentLifecycle),
    }
  }
  if (currentState?.campaignConcept && Object.hasOwn(currentState.campaignConcept, 'arc_chain')) {
    state.campaignConcept = {
      ...(state.campaignConcept ?? {}),
      arc_chain: currentState.campaignConcept.arc_chain === true,
    }
  }
  state.isNarrating = false
  return {
    event_type: REWIND_EVENT,
    actor_id: String(actorId ?? ''),
    target_ids: [],
    visibility: 'party',
    source_rule_ids: ['campaign.control.rewind.v1'],
    payload: {
      action: normalizedAction,
      target_version: safeVersion(targetVersion, 'targetVersion'),
      rewound_from_version: safeVersion(currentState?.state_version ?? 0, 'currentState.state_version'),
      occurred_at: String(occurredAt),
      state,
    },
  }
}

