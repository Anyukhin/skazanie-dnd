export const DND_2014_RULESET_ID = 'dnd_5e_2014'
export const LEGACY_DEFAULT_RULESET_ID = 'srd_5_2_1'
export const NEW_WORLD_DEFAULT_RULESET_ID = DND_2014_RULESET_ID

const profiles = [
  {
    id: DND_2014_RULESET_ID,
    version: '2014.1.0',
    edition_family: '5e_2014',
    label: 'D&D 5e 2014',
    description: 'Классическая пятая редакция по локальному профилю 5e14.dnd.su.',
    mechanics_status: 'partial',
    availability: 'preview',
    creation_enabled: true,
    process_default_allowed: false,
    enabled_rule_packs: ['dnd_5e_2014'],
    default_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    limitations: [
      'Создание героев, предметы и бестиарий ещё переводятся на отдельные каталоги 2014.',
      'Неперенесённые различия остаются partial и перечислены в аудите cutover.',
    ],
  },
  {
    id: 'srd_5_2_1',
    version: '5.2.1',
    edition_family: '5e_2024',
    label: 'D&D 2024',
    description: 'Текущий стабильный runtime-профиль на основе SRD 5.2.1.',
    mechanics_status: 'partial',
    availability: 'active',
    creation_enabled: true,
    process_default_allowed: true,
    enabled_rule_packs: ['srd_5_2_1'],
    default_house_rules: [],
    limitations: [
      'Покрытие классов, заклинаний, существ и предметов остаётся частичным.',
    ],
  },
]

export const RULESET_PROFILES = Object.freeze(Object.fromEntries(profiles.map((profile) => [
  profile.id,
  Object.freeze({
    ...profile,
    enabled_rule_packs: Object.freeze([...profile.enabled_rule_packs]),
    default_house_rules: Object.freeze([...profile.default_house_rules]),
    limitations: Object.freeze([...profile.limitations]),
  }),
])))

export const INSTALLED_RULESET_IDS = Object.freeze(profiles.map((profile) => profile.id))

export class RulesetSelectionError extends Error {
  constructor(message, code = 'RULESET_INVALID') {
    super(message)
    this.name = 'RulesetSelectionError'
    this.code = code
  }
}

export function rulesetProfile(rulesetId, { fallback = null, requireCreation = false } = {}) {
  const requested = String(rulesetId ?? '').trim()
  const resolvedId = requested || fallback
  const profile = RULESET_PROFILES[resolvedId]
  if (!profile) throw new RulesetSelectionError(`Неизвестный ruleset «${resolvedId || requested || '(пусто)'}»`)
  if (requireCreation && profile.creation_enabled !== true) {
    throw new RulesetSelectionError(`Ruleset ${profile.id} пока нельзя выбрать для новой кампании`, 'RULESET_CREATION_DISABLED')
  }
  return profile
}

export function rulesetLock(rulesetId, options = {}) {
  const profile = rulesetProfile(rulesetId, options)
  return {
    ruleset_id: profile.id,
    ruleset_version: profile.version,
    enabled_rule_packs: [...profile.enabled_rule_packs],
    enabled_house_rules: [...profile.default_house_rules],
  }
}

export function publicRulesetProfiles() {
  return profiles.filter((profile) => profile.creation_enabled).map((profile) => ({
    id: profile.id,
    version: profile.version,
    editionFamily: profile.edition_family,
    label: profile.label,
    description: profile.description,
    mechanicsStatus: profile.mechanics_status,
    availability: profile.availability,
    limitations: [...profile.limitations],
  }))
}

export function rulesetRuleId(ruleId, rulesetId) {
  const value = String(ruleId ?? '')
  const profile = RULESET_PROFILES[String(rulesetId ?? '')]
  if (!profile || !value.startsWith(`${LEGACY_DEFAULT_RULESET_ID}:`)) return value
  return `${profile.id}:${value.slice(LEGACY_DEFAULT_RULESET_ID.length + 1)}`
}
