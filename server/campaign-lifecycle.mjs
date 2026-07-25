const STATUSES = new Set(['setup', 'active', 'paused', 'completed', 'failed', 'archived'])
const TERMINAL = new Set(['completed', 'failed', 'archived'])

export function normalizeCampaignLifecycle(input, deathStatus = 'active') {
  const raw = input && typeof input === 'object' ? input : {}
  const legacyFailed = deathStatus === 'party_defeated'
  const status = STATUSES.has(raw.status) ? raw.status : legacyFailed ? 'failed' : 'active'
  return {
    schema_version: 1,
    status,
    reason: raw.reason == null ? (legacyFailed ? 'party_final_death' : null) : String(raw.reason).slice(0, 240),
    paused_at: raw.paused_at ?? null,
    concluded_at: raw.concluded_at ?? (legacyFailed ? raw.updated_at ?? null : null),
    archived_at: raw.archived_at ?? null,
    epilogue: raw.epilogue == null ? null : String(raw.epilogue).slice(0, 8_000),
    changed_by: raw.changed_by == null ? null : String(raw.changed_by).slice(0, 120),
  }
}

export function campaignIsReadOnly(state) {
  return TERMINAL.has(normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status).status)
}

export function assertCampaignPlayable(state) {
  const lifecycle = normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status)
  if (lifecycle.status === 'paused') {
    const error = new Error('Кампания приостановлена владельцем')
    error.code = 'CAMPAIGN_PAUSED'
    throw error
  }
  if (TERMINAL.has(lifecycle.status)) {
    const error = new Error('Завершённая или архивная кампания доступна только для чтения')
    error.code = 'CAMPAIGN_READ_ONLY'
    throw error
  }
  return lifecycle
}

export function lifecycleEventForAction(action, state, { actorId, reason, now = new Date().toISOString() } = {}) {
  const lifecycle = normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status)
  const normalizedAction = String(action || '').toLowerCase()
  const transitions = {
    activate: { from: ['setup'], to: 'active', event: 'CampaignActivated' },
    pause: { from: ['active'], to: 'paused', event: 'CampaignPaused' },
    resume: { from: ['paused'], to: 'active', event: 'CampaignResumed' },
    complete: { from: ['active', 'paused'], to: 'completed', event: 'CampaignCompleted' },
    archive: { from: ['setup', 'paused', 'completed', 'failed'], to: 'archived', event: 'CampaignArchived' },
  }
  const transition = transitions[normalizedAction]
  if (!transition || !transition.from.includes(lifecycle.status)) {
    const error = new Error(`Переход lifecycle "${lifecycle.status}" → "${normalizedAction}" запрещён`)
    error.code = 'INVALID_CAMPAIGN_TRANSITION'
    throw error
  }
  if (normalizedAction === 'complete' && state?.mechanics?.combat?.active) {
    const error = new Error('Нельзя завершить кампанию во время активного боя')
    error.code = 'CAMPAIGN_COMBAT_ACTIVE'
    throw error
  }
  const epilogue = normalizedAction === 'complete' ? buildDeterministicEpilogue(state) : null
  return {
    event_type: transition.event,
    actor_id: actorId ?? null,
    target_ids: [],
    visibility: 'party',
    source_rule_ids: [],
    ruling_id: null,
    payload: {
      status: transition.to,
      reason: String(reason || normalizedAction).slice(0, 240),
      changed_by: actorId ?? null,
      occurred_at: now,
      ...(epilogue ? { epilogue } : {}),
    },
  }
}

export function buildDeterministicEpilogue(state) {
  const campaign = String(state?.campaign || 'Кампания').trim()
  const objective = String(state?.scene?.objective || '').trim()
  const location = String(state?.scene?.location || '').trim()
  const living = (state?.players ?? []).filter((hero) => state?.mechanics?.death?.heroes?.[String(hero.id)]?.status !== 'dead')
    .map((hero) => String(hero.character || hero.name || hero.id))
  const heroes = living.length ? living.join(', ') : 'память о павших героях'
  return [
    `История «${campaign}» завершена.`,
    objective ? `Последняя цель: ${objective}.` : '',
    location ? `Финальная глава развернулась в месте «${location}».` : '',
    `В летописи мира остаются: ${heroes}.`,
  ].filter(Boolean).join(' ')
}
