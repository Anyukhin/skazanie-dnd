import { publicRulesetProfiles, rulesetLock, rulesetProfile, TOGGLEABLE_HOUSE_RULES } from './ruleset-config.mjs'

const RULESET_EVENT_TYPE = 'CampaignRulesetChanged'
const HOUSE_RULE_EVENT_TYPE = 'CampaignHouseRuleChanged'

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
    houseRules: campaignHouseRuleSettings(state),
  }
}

/**
 * Переключаемые домашние правила кампании и их состояние — для настроек
 * ведущего. Источник истины — `enabled_house_rules` состояния.
 */
export function campaignHouseRuleSettings(state) {
  const enabled = new Set((Array.isArray(state?.enabled_house_rules) ? state.enabled_house_rules : []).map(String))
  return TOGGLEABLE_HOUSE_RULES.map((rule) => ({ id: rule.id, label: rule.label, description: rule.description, enabled: enabled.has(rule.id) }))
}

/**
 * Событие включения или выключения домашнего правила в идущей кампании.
 * Разрешены только правила из `TOGGLEABLE_HOUSE_RULES`: их итог фиксируется
 * событиями в момент команды, поэтому переключение не меняет replay прошлого.
 * Без изменения возвращает `null`.
 */
export function campaignHouseRuleChangeEvent(houseRuleId, enabled, state, {
  actorId = null,
  now = new Date().toISOString(),
} = {}) {
  const id = String(houseRuleId ?? '')
  if (!TOGGLEABLE_HOUSE_RULES.some((rule) => rule.id === id)) {
    throw new CampaignRulesetError('Это домашнее правило нельзя переключить в идущей кампании', 'HOUSE_RULE_NOT_TOGGLEABLE')
  }
  if (typeof enabled !== 'boolean') throw new CampaignRulesetError('Нужно явное включено или выключено', 'HOUSE_RULE_VALUE_INVALID')
  if (state?.mechanics?.combat?.active === true) {
    throw new CampaignRulesetError('Домашние правила боя не меняют посреди боя', 'HOUSE_RULE_DURING_COMBAT')
  }
  const before = (Array.isArray(state?.enabled_house_rules) ? state.enabled_house_rules : []).map(String)
  if (before.includes(id) === enabled) return null
  const after = enabled ? [...new Set([...before, id])] : before.filter((entry) => entry !== id)
  return {
    event_schema_version: 1,
    event_type: HOUSE_RULE_EVENT_TYPE,
    actor_id: actorId,
    target_ids: [],
    visibility: 'party',
    source_rule_ids: [],
    house_rule_id: id,
    ruling_id: null,
    payload: {
      schema_version: 1,
      house_rule_id: id,
      enabled,
      enabled_house_rules_before: before,
      enabled_house_rules_after: after,
      changed_by: actorId,
      changed_at: now,
    },
  }
}

/**
 * Включение правила «по умолчанию» в уже идущей кампании. Возвращает событие
 * или `null`, если трогать кампанию не нужно:
 * - правило уже включено;
 * - ведущий уже переключал его сам — его выбор, в том числе «выключено»,
 *   важнее умолчания;
 * - идёт бой: правила боя посреди него не меняют, сервер попробует при
 *   следующем старте.
 *
 * Событие дописывается в журнал, а не правит историю: прошлые команды уже
 * записаны своими событиями, и replay их не меняется.
 */
export function defaultHouseRuleEvent(houseRuleId, state, history = [], { now = new Date().toISOString() } = {}) {
  if (state?.mechanics?.combat?.active === true) return null
  const id = String(houseRuleId ?? '')
  const toggledBefore = (Array.isArray(history) ? history : []).some((event) => event?.event_type === HOUSE_RULE_EVENT_TYPE
    && String(event?.payload?.house_rule_id ?? '') === id)
  if (toggledBefore) return null
  const event = campaignHouseRuleChangeEvent(id, true, state, { actorId: null, now })
  return event ? { ...event, payload: { ...event.payload, reason: 'default-on' } } : null
}

export function campaignHouseRuleMetadata(event) {
  if (event?.event_type !== HOUSE_RULE_EVENT_TYPE) return {}
  return { enabled_house_rules: [...event.payload.enabled_house_rules_after] }
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
