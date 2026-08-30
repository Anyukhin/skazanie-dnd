import { publicRulesetProfiles, rulesetLock, rulesetProfile } from './ruleset-config.mjs'

const RULESET_EVENT_TYPE = 'CampaignRulesetChanged'

export class CampaignRulesetError extends Error {
  constructor(message, code = 'CAMPAIGN_RULESET_INVALID') {
    super(message)
    this.name = 'CampaignRulesetError'
    this.code = code
  }
}

export function campaignRulesetCanChange(events = [], state = null) {
  if (state?.ruleset_selection_locked === true) {
    return {
      allowed: false,
      reason: 'Редакция зафиксирована при импорте состояния без журнала событий',
      blocking_event_type: 'ImportedCampaignState',
    }
  }
  const blocking = (Array.isArray(events) ? events : []).find((event) => String(event?.event_type ?? '') !== RULESET_EVENT_TYPE)
  return {
    allowed: !blocking,
    reason: blocking ? `Редакция зафиксирована событием ${String(blocking.event_type)}` : null,
    blocking_event_type: blocking ? String(blocking.event_type) : null,
  }
}

export function campaignRulesetSettings(state, events = [], { canManage = false } = {}) {
  const profile = rulesetProfile(state?.ruleset_id, { fallback: 'srd_5_2_1' })
  const change = campaignRulesetCanChange(events, state)
  return {
    current: {
      id: profile.id,
      version: String(state?.ruleset_version || profile.version),
      label: profile.label,
      mechanicsStatus: profile.mechanics_status,
      availability: profile.availability,
    },
    available: publicRulesetProfiles(),
    canChange: canManage && change.allowed,
    locked: !change.allowed,
    lockReason: change.reason,
  }
}

export function campaignRulesetChangeEvent(requestedRulesetId, state, events = [], {
  actorId = null,
  now = new Date().toISOString(),
} = {}) {
  const before = rulesetProfile(state?.ruleset_id, { fallback: 'srd_5_2_1' })
  const after = rulesetProfile(requestedRulesetId, { requireCreation: true })
  if (before.id === after.id) return null
  const change = campaignRulesetCanChange(events, state)
  if (!change.allowed) {
    throw new CampaignRulesetError(
      'Редакцию можно менять только до первого игрового события; создайте новую кампанию для другой редакции',
      'CAMPAIGN_RULESET_LOCKED',
    )
  }
  const lock = rulesetLock(after.id)
  const rulesetHouseRules = new Set(rulesetHouseRuleIds())
  const preservedHouseRules = (Array.isArray(state?.enabled_house_rules) ? state.enabled_house_rules : [])
    .map(String)
    .filter((id) => !rulesetHouseRules.has(id))
  const enabledHouseRulesAfter = [...new Set([...preservedHouseRules, ...(lock.enabled_house_rules ?? [])])]
  return {
    event_schema_version: 1,
    event_type: RULESET_EVENT_TYPE,
    actor_id: actorId,
    target_ids: [],
    visibility: 'party',
    source_rule_ids: [],
    ruling_id: null,
    payload: {
      schema_version: 1,
      ruleset_id_before: before.id,
      ruleset_version_before: String(state?.ruleset_version || before.version),
      enabled_rule_packs_before: Array.isArray(state?.enabled_rule_packs) ? [...state.enabled_rule_packs] : [...before.enabled_rule_packs],
      enabled_house_rules_before: Array.isArray(state?.enabled_house_rules) ? [...state.enabled_house_rules] : [],
      ruleset_id_after: lock.ruleset_id,
      ruleset_version_after: lock.ruleset_version,
      enabled_rule_packs_after: lock.enabled_rule_packs,
      enabled_house_rules_after: enabledHouseRulesAfter,
      changed_by: actorId,
      changed_at: now,
    },
  }
}

export function campaignRulesetMetadata(event) {
  if (event?.event_type !== RULESET_EVENT_TYPE) return {}
  return {
    ruleset_id: event.payload.ruleset_id_after,
    ruleset_version: event.payload.ruleset_version_after,
    enabled_rule_packs: [...event.payload.enabled_rule_packs_after],
    enabled_house_rules: [...event.payload.enabled_house_rules_after],
  }
}

function rulesetHouseRuleIds() {
  return publicRulesetProfiles().flatMap((profile) => [...rulesetProfile(profile.id).default_house_rules])
}
