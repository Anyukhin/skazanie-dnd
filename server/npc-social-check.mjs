import { createHash } from 'node:crypto'

import { ensureNpcSocialState, npcProfileAtWorldTime } from './npc-social.mjs'
import { reputationStandingFor } from './reputation-policy.mjs'

export const NPC_SOCIAL_CHECK_SKILLS = new Set(['persuasion', 'deception', 'intimidation', 'insight'])

const SKILL_ABILITIES = Object.freeze({
  persuasion: 'cha', deception: 'cha', intimidation: 'cha', insight: 'wis',
})

const clean = (value, maximum = 2_000) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0))

function stableHash(...parts) {
  return createHash('sha256').update(parts.map((part) => clean(part)).join('\0')).digest('hex')
}

export function classifyNpcSocialCheck(message) {
  const text = clean(message).toLocaleLowerCase('ru')
  if (!text) return null
  if (/(\u043f\u0440\u043e\u043d\u0438\u0446\u0430\u0442\u0435\u043b|\u0440\u0430\u0441\u043f\u043e\u0437\u043d.*\u043c\u043e\u0442\u0438\u0432|\u043f\u043e\u043d\u0438\u043c\u0430\u044e.*\u043c\u043e\u0442\u0438\u0432|\u043b\u0436[\u0435\u0451]\u0442\s+\u043b\u0438|\u0432\u0440[\u0435\u0451]\u0442\s+\u043b\u0438|insight|read\s+(?:their|his|her)\s+intent)/iu.test(text)) return 'insight'
  if (/(\u0437\u0430\u043f\u0443\u0433|\u0443\u0433\u0440\u043e\u0436|\u0448\u0430\u043d\u0442\u0430\u0436|\u043f\u0440\u0438\u043f\u0443\u0433|intimidat|threaten|coerce)/iu.test(text)) return 'intimidation'
  if (/(\u043e\u0431\u043c\u0430\u043d|\u043b\u0433\u0443|\u0441\u043e\u043b\u0433|\u0432\u0440\u0443|\u0431\u043b\u0435\u0444|\u0432\u044b\u0434\u0430\u044e\s+\u0441\u0435\u0431\u044f|deceiv|\blie\b|bluff)/iu.test(text)) return 'deception'
  if (/(\u0443\u0431\u0435\u0436\u0434|\u0443\u0433\u043e\u0432\u0430\u0440|\u0434\u0438\u043f\u043b\u043e\u043c\u0430\u0442|\u0441\u043a\u043b\u043e\u043d\u044f\u044e|\u043f\u0440\u043e\u0448\u0443\s+\u0441\u043e\u0433\u043b\u0430\u0441\u0438\u0442\u044c\u0441\u044f|persuad|convinc|negotiate)/iu.test(text)) return 'persuasion'
  return null
}

function attitudeFor(social, npcId, heroId) {
  const relationship = Number(social.relationships?.[npcId]?.[heroId] ?? 0)
  const latest = [...(social.conversations ?? [])].reverse().find((entry) => entry.npc_id === npcId && entry.hero_id === heroId)
  const stance = latest?.stance ?? (relationship >= 20 ? 'friendly' : relationship <= -20 ? 'hostile' : relationship <= -5 ? 'guarded' : 'neutral')
  return { relationship, stance }
}

/**
 * `reputationShift` — поправка от славы отряда у фракций этого NPC
 * (`server/reputation-policy.mjs`). Личное отношение и репутация — разные
 * вещи и складываются: трактирщик может любить героя лично и всё равно
 * опасаться говорить с тем, кого его гильдия объявила врагом.
 *
 * Явно заданный `social_dcs` репутацией не двигается: это ручное решение
 * автора кампании, и перебивать его политикой нельзя.
 */
function difficultyFor(profile, skill, attitude, reputationShift = 0) {
  const configured = Number(profile.social_dcs?.[skill])
  if (Number.isSafeInteger(configured)) return clamp(configured, 5, 30)
  const base = { friendly: 10, neutral: 12, guarded: 15, hostile: 18 }[attitude.stance] ?? 12
  const relationshipAdjustment = attitude.relationship >= 50 ? -4
    : attitude.relationship >= 20 ? -2
      : attitude.relationship >= 5 ? -1
        : attitude.relationship <= -50 ? 4
          : attitude.relationship <= -20 ? 2
            : attitude.relationship <= -5 ? 1
              : 0
  const skillAdjustment = skill === 'deception' ? 1 : skill === 'insight' ? 3 : 0
  return clamp(base + relationshipAdjustment + skillAdjustment + clamp(reputationShift, -3, 3), 5, 25)
}

export function buildNpcSocialCheckPolicy({ state = {}, npcId = '', heroId = '', message = '', turnId = '' } = {}) {
  const skill = classifyNpcSocialCheck(message)
  if (!skill) return null
  const social = ensureNpcSocialState(state.social, state)
  const persistedProfile = social.npcs.find((npc) => npc.id === String(npcId))
  const profile = persistedProfile ? npcProfileAtWorldTime(persistedProfile, state) : null
  if (!profile || profile.available === false) return null
  const normalizedNpcId = String(profile.id)
  const normalizedHeroId = String(heroId)
  const attitude = attitudeFor(social, normalizedNpcId, normalizedHeroId)
  const standing = reputationStandingFor(state, normalizedNpcId)
  const fingerprint = stableHash(normalizedNpcId, normalizedHeroId, skill, message)
  return Object.freeze({
    check_id: `social-check:${stableHash(turnId, fingerprint).slice(0, 24)}`,
    request_fingerprint: fingerprint,
    npc_id: normalizedNpcId,
    hero_id: normalizedHeroId,
    skill,
    ability: SKILL_ABILITIES[skill],
    difficulty: difficultyFor(profile, skill, attitude, standing.social_dc_shift),
    reputation_tier: standing.tier,
    visibility: 'specific_player',
  })
}

export function npcSocialCheckOutcome(event) {
  if (event?.event_type !== 'AbilityCheckResolved' || !event.payload?.social_check) return null
  const payload = event.payload
  const success = payload.success === true
  const margin = Number(payload.total ?? 0) - Number(payload.difficulty ?? 0)
  const degree = success ? (margin >= 10 ? 'strong_success' : 'success') : (margin <= -10 ? 'severe_failure' : 'failure')
  return Object.freeze({
    check_id: clean(payload.social_check.check_id, 120),
    npc_id: clean(payload.social_check.npc_id, 120),
    skill: NPC_SOCIAL_CHECK_SKILLS.has(payload.skill) ? payload.skill : clean(payload.social_check.skill, 30),
    ability: clean(payload.ability, 10),
    roll_id: clean(payload.roll_id, 120),
    total: Number(payload.total ?? 0),
    modifier: Number(payload.modifier ?? 0),
    success,
    degree,
  })
}

export function assertNpcSocialCheckFingerprint(event, policy) {
  const actual = String(event?.payload?.social_check?.request_fingerprint ?? '')
  if (!actual || actual !== String(policy?.request_fingerprint ?? '')) {
    const error = new Error('Idempotency key is already bound to a different social check')
    error.code = 'IDEMPOTENCY_CONFLICT'
    throw error
  }
}
