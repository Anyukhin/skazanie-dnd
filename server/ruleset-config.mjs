export const DND_2014_RULESET_ID = 'dnd_5e_2014'
export const LEGACY_DEFAULT_RULESET_ID = 'srd_5_2_1'
export const NEW_WORLD_DEFAULT_RULESET_ID = DND_2014_RULESET_ID
/**
 * Запасы классов по таблицам 2024 (`server/combat-actions.mjs`). Только для
 * кампаний, созданных после 2026-10-03: прежние живут по старой таблице, чтобы
 * их replay не менял уже начисленные запасы.
 */
export const CLASS_RESOURCES_2024_POLICY_ID = 'skazanie:class-resources-2024-v1'
/**
 * Домашнее правило в духе BG3: удар из исследования проходит сразу, вне
 * очереди, и только потом бросается инициатива; ход нападающего в первом
 * раунде остаётся целым. По редакции нападение начинается с инициативы — без
 * правила движок так и делает (`resolveOpeningStrike`). Решение владельца от
 * 2026-10-04: правило включено в новых кампаниях по умолчанию, в идущих его
 * включает ведущий в настройках кампании событием `CampaignHouseRuleChanged`.
 */
export const BG3_OPENING_STRIKE_HOUSE_RULE_ID = 'house:bg3-opening-strike'

/**
 * Правила, которые сервер сам включает и уже идущим кампаниям — при старте,
 * событием `CampaignHouseRuleChanged` (`defaultHouseRuleEvent`). Решение
 * владельца от 2026-10-04: удар как в BG3 включён у всех, пока ведущий его
 * явно не выключит.
 */
export const DEFAULT_ON_HOUSE_RULE_IDS = Object.freeze([BG3_OPENING_STRIKE_HOUSE_RULE_ID])

/**
 * Домашние правила, которые ведущий переключает в настройках идущей кампании.
 * Сюда попадает только правило, решающее исход в момент команды: его итог
 * записан событиями, поэтому смена правила не меняет replay прошлого.
 */
export const TOGGLEABLE_HOUSE_RULES = Object.freeze([
  Object.freeze({
    id: BG3_OPENING_STRIKE_HOUSE_RULE_ID,
    label: 'Нападение как в BG3',
    description: 'Удар из исследования проходит сразу, до инициативы, а ход нападающего в первом раунде остаётся целым. Выключено — по редакции: сначала инициатива, и удар исполняется, только если нападающий ходит первым',
  }),
])

const profiles = [
  {
    id: DND_2014_RULESET_ID,
    version: '2014.1.0',
    edition_family: '5e_2014',
    label: 'D&D 5e 2014',
    description: 'Правила 2014 года, как в «Книге игрока». Часть механик ещё в работе.',
    mechanics_status: 'partial',
    availability: 'preview',
    creation_enabled: true,
    process_default_allowed: false,
    enabled_rule_packs: ['dnd_5e_2014'],
    default_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1', BG3_OPENING_STRIKE_HOUSE_RULE_ID],
    limitations: [
      'Снаряжение и монстры пока общие с правилами 2024 года.',
      'Часть различий между редакциями ещё не перенесена: такие правила работают по-2024.',
    ],
  },
  {
    id: 'srd_5_2_1',
    version: '5.2.1',
    edition_family: '5e_2024',
    label: 'D&D 2024',
    description: 'Правила 2024 года — поддерживаются лучше всего.',
    mechanics_status: 'partial',
    availability: 'active',
    creation_enabled: true,
    process_default_allowed: true,
    enabled_rule_packs: ['srd_5_2_1'],
    default_house_rules: [CLASS_RESOURCES_2024_POLICY_ID, BG3_OPENING_STRIKE_HOUSE_RULE_ID],
    limitations: [
      'Часть классовых умений, заклинаний и существ пока объявляется словами.',
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

/**
 * @param {unknown} rulesetId
 * @param {{ fallback?: string | null, requireCreation?: boolean }} [options]
 */
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
