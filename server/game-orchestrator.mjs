import { createHash, randomUUID } from 'node:crypto'

import { Adjudicator } from './adjudicator.mjs'
import { answerKnownLore } from './player-request-router.mjs'
import { PROMPT_DESCRIPTORS } from './prompt-descriptors.mjs'
import { TURN_TRACE_SCHEMA_VERSION } from './trace-store.mjs'
import { AutonomousCampaignOrchestrator } from './autonomous-orchestrator.mjs'
import { IdempotencyConflictError } from './event-store.mjs'
import { deterministicNarratorFor, renderDeterministicNarration } from './deterministic-narration.mjs'
import './encounter-narration.mjs'
import { IntentParser, buildRuleQueries } from './intent-parser.mjs'
import './merchant-narration.mjs'
import { ensureNpcSocialState, npcConversationNarration, npcProfileAtWorldTime, npcSocialForViewer, relationshipTier } from './npc-social.mjs'
import { assertNpcSocialCheckFingerprint, buildNpcSocialCheckPolicy, npcSocialCheckOutcome } from './npc-social-check.mjs'
import { LAW_POLICY_ID, guardEncounterFor } from './law-and-order.mjs'
import { PARLEY_ABILITY, PARLEY_POLICY_ID, mentionsParley, parleyMoraleFor, parleySkillFor, truceFor } from './parley.mjs'
import {
  NARRATOR_PROMPT_VERSION,
  NARRATOR_RECENT_TEXT_LIMIT,
  Narrator,
  deterministicNarration,
  verifyNarratorCraft,
} from './narrator.mjs'
import { TAVERN_DICE_APPROACHES, TAVERN_POLICY_ID, tavernRoundFor } from './tavern-life.mjs'
import { actorNameResolver, eventSummary, normalizeCampaignState, previewD20Check, previewTavernDiceRoll } from './rules-engine.mjs'
import { ABILITY_LABELS_RU, SKILL_LABELS_RU, d20CheckLabel } from './free-action-adjudication.mjs'
import './scene-narration.mjs'
import './scene-hazard-narration.mjs'
import { buildNarrationBrief, projectVisibleState, validateAllowedCommands, verifyNarration } from './security.mjs'
import { campaignStateForViewer, mechanicsForViewer, publicAdventureFor, turnExplanationForViewer } from './viewer-projection.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { worldClockForAgents } from './weather.mjs'
import { buildTurnExplanation } from './trace-store.mjs'
import { retrieveWorldMemory } from './world-memory.mjs'

// A JSON request cannot manufacture this identity. Only server-owned world
// orchestration may attach it to derived AdvanceScene/merchant commands.
export const DIRECTOR_COMMAND_CAPABILITY = Symbol('skazanie:director-command-capability')

function emptyEffects() {
  return { roll: null, reveal: [], spawn: [], objective: null, grantItems: [] }
}

/**
 * Narrator receives only a small supplemental memory window. The committed
 * events already carry the current result; three ranked facts are enough to
 * connect that result to the nearby canon without turning every narration into
 * a full-world prompt.
 */
export const NARRATION_WORLD_FACT_LIMIT = 3
const memoryText = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function narrationMemoryQuery(state, message, events) {
  return [
    message,
    state.scene?.title,
    state.scene?.location,
    state.scene?.objective,
    ...(events ?? []).map((event) => eventSummary(event)),
  ].filter(Boolean).join(' ').slice(0, 4_000)
}

function narrationWorldFacts(state, viewer, message, events) {
  // A hero may legitimately have a personal gm_only fact in the canonical
  // viewer projection. Narrator has a stricter contract: remove such facts
  // before retrieval so they cannot consume ranking slots or leak through a
  // wrapper record's summary.
  const publicMemory = {
    ...(state.worldMemory ?? {}),
    facts: (state.worldMemory?.facts ?? []).filter((fact) => ['public', 'party'].includes(fact.visibility)),
  }
  const records = retrieveWorldMemory(publicMemory, {
    playerId: viewer.playerId,
    partyIds: viewer.partyIds,
    isPartyMember: viewer.isPartyMember,
  }, {
    query: narrationMemoryQuery(state, message, events),
    limit: NARRATION_WORLD_FACT_LIMIT,
    asOfMinutes: state.mechanics?.world_time?.elapsed_minutes,
  })
  return records
    .filter((record) => record.kind === 'fact' && ['public', 'party'].includes(record.fact?.visibility))
    .map((record) => ({
      id: memoryText(record.fact?.id, 120),
      subject: memoryText(record.entity?.name || record.fact?.subject_id, 120),
      predicate: memoryText(record.fact?.predicate, 80),
      summary: memoryText(record.fact?.summary || record.fact?.object, 280),
    }))
    .filter((fact) => fact.id && fact.summary)
    .slice(0, NARRATION_WORLD_FACT_LIMIT)
}

/**
 * Story context gives the narrator continuity, not authority: active quests,
 * plot threads, recent scene summaries, the party roster, NPCs presently in
 * the scene and their open promises. Every entry is bounded, party-visible
 * and still passes the narrator projection with the rest of the brief.
 */
export const NARRATION_STORY_LIMITS = Object.freeze({
  quests: 2, threads: 2, summaries: 2, decisions: 2,
  heroes: 6, npcs: 4, promises: 4, interactions: 4,
})

const partyVisibleRecord = (value) => ['public', 'party'].includes(String(value?.visibility ?? '').toLowerCase())

function narrationQuestClock(clock) {
  const max = Number(clock?.max)
  if (!Number.isSafeInteger(max) || max <= 0) return null
  return { label: memoryText(clock.label, 80), current: Math.max(0, Number(clock.current) || 0), max }
}

export function narrationStoryContext(state, viewer = {}, events = []) {
  const memory = state.worldMemory ?? {}
  const active_quests = (memory.quests ?? [])
    .filter((quest) => quest.status === 'active' && partyVisibleRecord(quest))
    .slice(-NARRATION_STORY_LIMITS.quests)
    .map((quest) => {
      const clock = narrationQuestClock(quest.clock)
      return {
        title: memoryText(quest.title, 160),
        summary: memoryText(quest.summary, 400),
        objectives: (Array.isArray(quest.objectives) ? quest.objectives : []).slice(0, 3).map((objective) => memoryText(objective, 200)).filter(Boolean),
        ...(clock ? { clock } : {}),
      }
    })
    .filter((quest) => quest.title)
  const active_threads = (memory.threads ?? [])
    .filter((thread) => thread.status === 'active' && partyVisibleRecord(thread))
    .slice(-NARRATION_STORY_LIMITS.threads)
    .map((thread) => ({ title: memoryText(thread.title, 160), summary: memoryText(thread.summary, 300) }))
    .filter((thread) => thread.title)
  const recent_summaries = (memory.summaries ?? [])
    .filter(partyVisibleRecord)
    .slice(-NARRATION_STORY_LIMITS.summaries)
    .map((summary) => ({
      id: memoryText(summary.id, 120),
      kind: memoryText(summary.kind, 40) || 'scene',
      title: memoryText(summary.title, 160),
      summary: memoryText(summary.summary, 500),
    }))
    .filter((summary) => summary.title && summary.summary)
  const adventure = state.adventure ?? {}
  const visibleAdventure = {
    ...adventure,
    history: (Array.isArray(adventure.history) ? adventure.history : [])
      .filter((entry) => !entry?.visibility || partyVisibleRecord(entry)),
  }
  const recent_decisions = (publicAdventureFor(visibleAdventure).history ?? [])
    .slice(-NARRATION_STORY_LIMITS.decisions)
    .map((entry) => ({
      title: memoryText(entry.title, 160),
      location: memoryText(entry.location, 180),
      objective: memoryText(entry.objective, 300),
      outcome: memoryText(entry.outcome, 300),
      ...(entry.status ? { status: memoryText(entry.status, 40) } : {}),
    }))
    .filter((entry) => entry.title || entry.location || entry.objective || entry.outcome)
  const viewerId = String(viewer?.playerId ?? '')
  const heroes = (state.players ?? [])
    .slice(0, NARRATION_STORY_LIMITS.heroes)
    .map((actor) => {
      const id = String(actor?.id ?? '')
      const isViewer = id === viewerId
      const role = memoryText(actor?.role || actor?.characterClass, 120)
        .replace(/\s*[·—-]?\s*(?:ур(?:овень)?\.?|level)\s*\d+.*$/iu, '')
        .trim()
      return {
        id,
        name: memoryText(actor?.character || actor?.name, 120),
        is_viewer: isViewer,
        ...(isViewer && role ? { class_name: role } : {}),
        ...(isViewer && actor?.background ? { background: memoryText(actor.background, 160) } : {}),
      }
    })
    .filter((hero) => hero.id && hero.name)

  const social = ensureNpcSocialState(state.social, state)
  const sceneLocation = memoryText(state.scene?.location, 180).toLocaleLowerCase('ru')
  const viewerSocial = npcSocialForViewer(social, {
    ...viewer,
    isAdmin: false,
    state,
  })
  const viewerProfiles = new Map(viewerSocial.npcs.map((npc) => [String(npc.id), npc]))
  const presentProfiles = social.npcs
    .map((npc) => {
      const visibleCurrent = viewerProfiles.get(String(npc.id))
      return visibleCurrent
        ? { ...npc, location: visibleCurrent.location, available: visibleCurrent.available }
        : null
    })
    .filter((npc) => npc && npc.available !== false && partyVisibleRecord(npc))
    .filter((npc) => npc.location && sceneLocation && npc.location.toLocaleLowerCase('ru') === sceneLocation)
    .slice(0, NARRATION_STORY_LIMITS.npcs)
  const relationships = social.relationships ?? {}
  const present_npcs = presentProfiles.map((npc) => ({
    id: String(npc.id),
    name: memoryText(npc.name, 120),
    role: memoryText(npc.role, 120),
    public_summary: memoryText(npc.public_summary, 300),
    voice: memoryText(npc.voice, 200),
    speech_profile: {
      pace: memoryText(npc.speech_profile?.pace, 100),
      lexicon: memoryText(npc.speech_profile?.lexicon, 180),
      mannerism: memoryText(npc.speech_profile?.mannerism, 180),
    },
    relationship: relationshipTier(relationships[npc.id]?.[viewer?.playerId] ?? 0),
  })).filter((npc) => npc.id && npc.name)
  const presentIds = new Set(presentProfiles.map((npc) => String(npc.id)))
  const npcNames = new Map(presentProfiles.map((npc) => [String(npc.id), npc.name]))
  const promiseVisible = (promise) => promise.visibility === 'party'
    || (promise.visibility === 'specific_player' && String(promise.hero_id) === String(viewer?.playerId ?? ''))
  const open_promises = (social.promises ?? [])
    .filter((promise) => promise.status === 'open' && promiseVisible(promise) && presentIds.has(String(promise.npc_id)))
    .slice(-NARRATION_STORY_LIMITS.promises)
    .map((promise) => ({
      id: memoryText(promise.id, 120),
      npc: memoryText(npcNames.get(String(promise.npc_id)) || promise.npc_id, 120),
      direction: memoryText(promise.direction, 40),
      text: memoryText(promise.text, 280),
      ...(promise.due_hint ? { due_hint: memoryText(promise.due_hint, 160) } : {}),
    }))
    .filter((promise) => promise.text)
  const heroNames = new Map(heroes.map((hero) => [String(hero.id), hero.name]))
  const recent_interactions = (social.conversations ?? [])
    .filter((entry) => entry.visibility === 'party' && presentIds.has(String(entry.npc_id)))
    .slice(-NARRATION_STORY_LIMITS.interactions)
    .map((entry) => ({
      npc: memoryText(npcNames.get(String(entry.npc_id)) || entry.npc_id, 120),
      hero: memoryText(heroNames.get(String(entry.hero_id)) || entry.hero_id, 120),
      player_message: memoryText(entry.player_message, 240),
      npc_reply: memoryText(entry.npc_reply, 240),
      stance: memoryText(entry.stance, 40),
    }))
    .filter((entry) => entry.npc && entry.npc_reply)
  const currentConversationEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => event?.event_type === 'NpcConversationRecorded' && event.payload?.conversation?.npc_id)
  const currentConversationId = memoryText(currentConversationEvent?.payload?.conversation?.id, 120)
  const currentNpcId = memoryText(currentConversationEvent?.payload?.conversation?.npc_id, 120)
  const currentProfile = currentNpcId && presentIds.has(currentNpcId)
    ? viewerProfiles.get(currentNpcId)
    : null
  const priorDossier = (Array.isArray(currentProfile?.dossier) ? currentProfile.dossier : [])
    .filter((entry) => String(entry?.provenance?.source_conversation_id ?? '') !== currentConversationId)
  const npc_dossiers = currentProfile && priorDossier.length
    ? [{
        npc_id: currentNpcId,
        name: memoryText(currentProfile.name, 120),
        relationship: {
          tier: viewerSocial.relationship_tiers?.[currentNpcId]?.[viewerId]
            ?? relationshipTier(viewerSocial.relationships?.[currentNpcId]?.[viewerId] ?? 0),
          provenance: { source_event_ids: [] },
        },
        interactions: priorDossier,
        promises: (viewerSocial.promises ?? [])
          .filter((promise) => promise.status === 'open' && String(promise.npc_id) === currentNpcId),
      }]
    : []
  return {
    active_quests,
    active_threads,
    recent_summaries,
    recent_decisions,
    heroes,
    present_npcs,
    open_promises,
    recent_interactions,
    npc_dossiers,
  }
}

/**
 * Разрешённые реакции NPC. Поле называется «permitted» не случайно: это
 * allowlist, а не подсказка. Без него рассказчик додумывал отношение
 * присутствующих NPC к происходящему сам — теперь он может показать только
 * ту реакцию, которую выбрал сервер, и только у названного NPC.
 *
 * Словарь — presentation, а не механика: реакция ничего не меняет в
 * состоянии, отношения двигает отдельная команда социального хода.
 */
export const NPC_REACTION_LIMIT = 3
const NPC_REACTION_LABELS = Object.freeze({
  alarmed: 'встревожен происходящим',
  persuaded: 'принимает довод героя',
  unconvinced: 'остаётся при своём',
  welcoming: 'держится приветливо',
  attentive: 'молча наблюдает за разговором',
  watchful: 'держится настороже',
  cold: 'держится холодно',
})
const NPC_REACTION_BY_TIER = Object.freeze({
  trusted: 'welcoming', friendly: 'welcoming', neutral: 'attentive',
  unfriendly: 'watchful', hostile: 'cold',
})

export function narrationNpcReactions(presentNpcs = [], events = []) {
  // Насилие в сцене перекрывает отношения: даже дружелюбный NPC сначала
  // реагирует на кровь, а не на давнее знакомство.
  const alarming = (events ?? []).some((event) => /damage|hitpointsreducedtozero|herodied|combatstarted/i.test(String(event.event_type ?? '')))
  const socialOutcomes = new Map((events ?? [])
    .filter((event) => event.event_type === 'AbilityCheckResolved' && event.payload?.social_check?.npc_id)
    .map((event) => [String(event.payload.social_check.npc_id), event.payload.success === true]))
  return presentNpcs.slice(0, NPC_REACTION_LIMIT).map((npc) => {
    const outcome = socialOutcomes.get(String(npc.id))
    const reaction = alarming
      ? 'alarmed'
      : outcome === true
        ? 'persuaded'
        : outcome === false
          ? 'unconvinced'
          : NPC_REACTION_BY_TIER[npc.relationship] ?? 'attentive'
    return { npc_id: String(npc.id), name: memoryText(npc.name, 120), reaction, description: NPC_REACTION_LABELS[reaction] }
  })
}

function narrationSocialConsequences(events, state) {
  const promises = new Map((state.social?.promises ?? []).map((promise) => [String(promise.id), promise]))
  return (events ?? [])
    .filter((event) => event.event_type === 'NpcPromiseResolved')
    .map((event) => {
      const promiseId = memoryText(event.payload?.promise_id, 120)
      const promise = promises.get(promiseId)
      return {
        promise_id: promiseId,
        status: memoryText(event.payload?.status, 30),
        npc_id: memoryText(promise?.npc_id, 120),
        direction: memoryText(promise?.direction, 40),
        text: memoryText(promise?.text, 280),
        consequence_delta: Number.isSafeInteger(Number(event.payload?.consequence_delta))
          ? Number(event.payload.consequence_delta)
          : 0,
      }
    })
    .filter((entry) => entry.promise_id && entry.status)
    .slice(-6)
}

// `purpose` — служебный ключ броска (`ability_check:wis`). Игроку он попадал
// в карточку результата как есть, вместо названия проверки.
const ABILITY_CHECK_LABELS = Object.freeze({
  str: 'Проверка Силы',
  dex: 'Проверка Ловкости',
  con: 'Проверка Телосложения',
  int: 'Проверка Интеллекта',
  wis: 'Проверка Мудрости',
  cha: 'Проверка Харизмы',
})
const SAVING_THROW_LABELS = Object.freeze({
  str: 'Спасбросок Силы',
  dex: 'Спасбросок Ловкости',
  con: 'Спасбросок Телосложения',
  int: 'Спасбросок Интеллекта',
  wis: 'Спасбросок Мудрости',
  cha: 'Спасбросок Харизмы',
})

export function rollPurposeLabel(purpose) {
  const value = String(purpose ?? '').trim()
  if (!value) return 'Проверка'
  const [kind, detail = ''] = value.split(':')
  const ability = detail.toLowerCase()
  if (kind === 'ability_check') return ABILITY_CHECK_LABELS[ability] ?? 'Проверка характеристики'
  if (kind === 'saving_throw') return SAVING_THROW_LABELS[ability] ?? 'Спасбросок'
  if (kind === 'attack_roll' || kind === 'attack') return 'Бросок атаки'
  if (kind === 'initiative') return 'Инициатива'
  if (kind === 'death_save') return 'Спасбросок от смерти'
  if (kind === 'free_roll') return 'Свободный бросок'
  // Незнакомый служебный ключ лучше не показывать вовсе, чем показывать сырым.
  return /^[a-z0-9_:.-]+$/i.test(value) ? 'Проверка' : value
}

function rollForClient(roll) {
  if (!roll) return null
  return {
    roll_id: roll.roll_id,
    actor_id: String(roll.actor_id ?? roll.actorId ?? ''),
    value: roll.kept ?? roll.dice?.[0] ?? 0,
    modifier: Number(roll.modifier) || 0,
    total: Number(roll.total) || 0,
    label: rollPurposeLabel(roll.purpose),
    success: typeof roll.success === 'boolean' ? roll.success : undefined,
  }
}

export function eventsToClientEffects(events, rolls = []) {
  const effects = emptyEffects()
  effects.roll = rollForClient(rolls[0])
  for (const event of events ?? []) {
    if (event.event_type === 'AreaRevealed') effects.reveal.push(...(event.payload?.cells ?? []))
    if (event.event_type === 'ObjectiveUpdated') effects.objective = event.payload?.objective ?? null
    if (event.event_type === 'EntitySpawned') effects.spawn.push(event.payload?.entity)
    if (event.event_type === 'ItemGranted') effects.grantItems.push({ ...event.payload?.item, ownerId: event.target_ids?.[0] ?? event.actor_id })
  }
  return effects
}

function visibleChanges(events) {
  return (events ?? []).map((event) => ({
    event_type: event.event_type,
    actor_id: event.actor_id,
    target_ids: event.target_ids,
    payload: event.payload,
    source_rule_ids: event.source_rule_ids,
    ruling_id: event.ruling_id ?? null,
    visibility: event.visibility ?? 'public',
  }))
}

// Как игра прочла команду — одной понятной фразой. Сырые идентификаторы
// правил и типов команд игроку не показываются: это объяснение, а не журнал
// отладки.
function describeCommandForPlayer(command, resolveName) {
  const type = String(command?.command_type ?? '')
  const difficulty = Number.isSafeInteger(Number(command?.difficulty)) ? ` против СЛ ${Number(command.difficulty)}` : ''
  if (type === 'MakeAbilityCheck') return `${d20CheckLabel({ kind: 'check', ability: command.ability, skill: command.skill })}${difficulty}`
  if (type === 'MakeSavingThrow') return `${d20CheckLabel({ kind: 'save', ability: command.ability })}${difficulty}`
  if (type === 'MakeAttack') return `атака по цели «${resolveName(command.target_id)}»`
  if (type === 'MakeAreaAttack') return 'атака по области'
  if (type === 'CastSpell') return 'применение заклинания'
  if (type === 'MoveActor') return 'перемещение'
  if (type === 'UseCombatAction') return 'боевое действие'
  if (type === 'OperateSceneObject' || type === 'OperateDoor') return 'взаимодействие с объектом сцены'
  if (type === 'RecordRuling') return 'судейское решение ведущего'
  if (type === 'UpdateObjective') return 'обновление цели отряда'
  // Служебные команды (объявление действия и т.п.) игроку не пересказываем.
  return null
}

function describeRollForPlayer(roll) {
  const kept = roll?.kept ?? (Array.isArray(roll?.dice) ? roll.dice[0] : null)
  const modifier = Number(roll?.modifier) || 0
  const modifierText = modifier ? ` ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} (модификатор)` : ''
  const base = kept != null
    ? `выпало ${kept}${modifierText}, итого ${roll.total}`
    : `${roll?.expression ?? 'бросок'} = ${roll?.total}`
  const target = roll?.difficulty != null ? ` против СЛ ${roll.difficulty}` : ''
  const outcome = typeof roll?.success === 'boolean' ? ` — ${roll.success ? 'успех' : 'провал'}` : ''
  return `${rollPurposeLabel(roll?.purpose)}: ${base}${target}${outcome}`
}

function whyNarration(explanation, resolveName) {
  if (!explanation) return 'Для этой кампании ещё нет сохранённого механического решения.'
  const sentences = []
  const recognized = (Array.isArray(explanation.commands) ? explanation.commands : [])
    .map((command) => describeCommandForPlayer(command, resolveName))
    .filter(Boolean)
  sentences.push(recognized.length
    ? `Игра прочла действие как: ${[...new Set(recognized)].join('; ')}.`
    : 'Действие не потребовало механических команд.')
  const rolls = Array.isArray(explanation.rolls) ? explanation.rolls : []
  sentences.push(rolls.length
    ? `${rolls.slice(0, 3).map(describeRollForPlayer).join('. ')}.`
    : 'Бросков не потребовалось.')
  const events = Array.isArray(explanation.events) ? explanation.events : []
  const outcomes = events.map((event) => eventSummary(event, resolveName)).filter(Boolean)
  if (outcomes.length) sentences.push(`В итоге: ${outcomes.slice(0, 4).join('; ')}.`)
  sentences.push(explanation.ruling
    ? 'Основание: разовое судейское решение ведущего — точного правила для этого случая движок не исполняет.'
    : 'Основание: закреплённые правила игры, результат рассчитан сервером.')
  return sentences.join(' ')
}

function modelIdentifiers(narration) {
  return {
    narrator: narration?.provider ?? null,
  }
}

/** Сколько кампаний держать в тёплой памяти процесса одновременно. */
const NARRATION_MEMORY_CAMPAIGNS = 64

function recentCampaignNarrations(traceStore, campaignId) {
  if (!traceStore || !campaignId) return []
  const traces = typeof traceStore.recent === 'function'
    ? traceStore.recent(campaignId, NARRATOR_RECENT_TEXT_LIMIT)
    : (typeof traceStore.latest === 'function' ? [traceStore.latest(campaignId)] : [])
  return traces
    .filter(Boolean)
    .reverse()
    .map((trace) => String(trace?.narration_result?.narration ?? '').trim())
    .filter(Boolean)
    .slice(-NARRATOR_RECENT_TEXT_LIMIT)
}

function structuredCommandTurnId(campaignId, idempotencyKey) {
  const digest = createHash('sha256')
    .update(String(campaignId))
    .update('\0')
    .update(String(idempotencyKey))
    .digest('hex')
    .slice(0, 32)
  return `turn-${digest}`
}

export function narrationRequestFingerprint({
  campaignId = '',
  playerId = '',
  message = '',
  npcId = '',
} = {}) {
  return createHash('sha256')
    .update(String(campaignId).toUpperCase())
    .update('\0')
    .update(String(playerId))
    .update('\0')
    .update(String(message).normalize('NFKC').replace(/\s+/gu, ' ').trim())
    .update('\0')
    .update(String(npcId))
    .digest('hex')
}

function assertNarrationRequestIdempotency(duplicate, trace, {
  campaignId,
  idempotencyKey,
  playerId,
  message,
  npcId,
}) {
  if (!duplicate) return
  const requestFingerprint = narrationRequestFingerprint({
    campaignId,
    playerId,
    message,
    npcId,
  })
  if (trace?.request_fingerprint) {
    if (String(trace.request_fingerprint) !== requestFingerprint) {
      throw new IdempotencyConflictError(campaignId, idempotencyKey)
    }
    return
  }
  // Traces created before request fingerprints existed cannot distinguish an
  // omitted target from an old inferred social target. Preserve that replay
  // path, but never let a new explicit target bind to a different old event.
  if (!npcId) return
  const conversation = (duplicate.events ?? [])
    .find((event) => event?.event_type === 'NpcConversationRecorded')
    ?.payload?.conversation
  const replayFingerprint = conversation
    ? narrationRequestFingerprint({
        campaignId,
        playerId: conversation.hero_id,
        message: conversation.player_message,
        npcId: conversation.npc_id,
      })
    : ''
  if (!replayFingerprint || replayFingerprint !== requestFingerprint) {
    throw new IdempotencyConflictError(campaignId, idempotencyKey)
  }
}

function cachedNarration(trace, brief, knownRuleIds) {
  const cached = trace?.narration_result
  const text = typeof cached?.narration === 'string' ? cached.narration.trim() : ''
  if (!text) return null
  const verification = verifyNarratorCraft(
    text,
    brief,
    verifyNarration(text, brief, { knownRuleIds }),
  )
  if (!verification.valid) return null
  return {
    narration: text,
    verification,
    prompt_version: String(cached.prompt_version || NARRATOR_PROMPT_VERSION),
    provider: String(cached.provider || 'cached-idempotent-replay'),
  }
}

function deterministicReplayNarration(brief, knownRuleIds, resolveName) {
  const fallback = deterministicNarration(brief, resolveName)
  return {
    ...fallback,
    verification: verifyNarratorCraft(
      fallback.narration,
      brief,
      verifyNarration(fallback.narration, brief, { knownRuleIds }),
    ),
    prompt_version: NARRATOR_PROMPT_VERSION,
    provider: 'deterministic-idempotent-replay',
  }
}

function deterministicMechanicsNarration(brief, knownRuleIds, resolveName) {
  const fallback = deterministicNarration(brief, resolveName)
  return {
    ...fallback,
    verification: verifyNarration(fallback.narration, brief, { knownRuleIds }),
    prompt_version: 'mechanics-log/v1',
    provider: 'deterministic-mechanics',
  }
}

/**
 * Один путь для всех детерминированных рассказчиков вместо трёх почти
 * одинаковых обёрток. Кто именно отвечает за события, решает реестр в
 * `deterministic-narration.mjs`, а не лестница тернарных операторов здесь.
 */
function deterministicNarratorResponse(narrator, events, state, brief, knownRuleIds) {
  const rendered = renderDeterministicNarration(narrator, {
    events,
    state,
    fallbackNarration: deterministicNarration(brief, actorNameResolver(state)).narration,
  })
  return { ...rendered, verification: verifyNarration(rendered.narration, brief, { knownRuleIds }) }
}

/**
 * Отказ обязан подсказывать выход. Прежнее «Уточните имя собеседника.» было
 * тупиком: игрок не знал, кто вообще есть в сцене, и ход тратился впустую.
 */
function availableNpcNames(state) {
  const sceneLocation = String(state?.scene?.location ?? '').trim().toLocaleLowerCase('ru')
  return (state?.social?.npcs ?? [])
    .filter((npc) => npc?.available !== false)
    .filter((npc) => {
      const npcLocation = String(npc?.location ?? '').trim().toLocaleLowerCase('ru')
      return !sceneLocation || !npcLocation || sceneLocation === npcLocation
    })
    .map((npc) => String(npc?.name ?? '').trim())
    .filter(Boolean)
    .slice(0, 6)
}

function humanMissingInformation(values, state, intent = {}) {
  const labels = {
    message: 'само действие',
    target_id: 'цель действия',
    npc_id: 'имя собеседника',
    available_npc: 'доступного собеседника',
    ambiguous_npc: 'конкретного собеседника',
  }
  const missing = [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
  if (missing.includes('ambiguous_npc')) {
    const candidates = (intent.target_candidates ?? []).map((candidate) => {
      const name = String(candidate?.name ?? '').trim()
      const role = String(candidate?.role ?? '').trim()
      return role ? `${name} (${role})` : name
    }).filter(Boolean).slice(0, 6)
    return candidates.length
      ? `По описанию подходят несколько собеседников: ${candidates.join(', ')}. Назовите одного из них.`
      : 'По описанию подходят несколько собеседников. Назовите конкретного NPC.'
  }
  if (missing.includes('npc_id') || missing.includes('available_npc')) {
    const names = availableNpcNames(state)
    return names.length
      ? `Назовите собеседника по имени. Сейчас рядом: ${names.join(', ')}.`
      : 'Рядом нет никого, с кем можно заговорить. Осмотритесь или дойдите туда, где есть люди.'
  }
  return missing.length ? `Уточните ${missing.map((value) => labels[value] ?? 'деталь действия').join(' и ')}.` : 'Опишите действие подробнее, чтобы его можно было разрешить по правилам.'
}

function noWorldChangeConstraint(plan) {
  return plan?.ruling_draft?.world_change === false
    || (Array.isArray(plan?.narration_constraints) && plan.narration_constraints.includes('no-unconfirmed-world-changes'))
}

/**
 * Идентификатор предложения — сквозной ключ объяснения хода. Он детерминирован:
 * повтор того же хода по тому же ключу идемпотентности даёт то же значение,
 * поэтому `/why` по повтору показывает ту же цепочку, а не новую.
 *
 * @param {string} campaignId
 * @param {string} seed
 * @returns {string}
 */
function proposalIdFor(campaignId, seed) {
  return `proposal:${createHash('sha256').update(`${campaignId} ${seed}`).digest('hex').slice(0, 20)}`
}

/**
 * Честные версии промптов хода. Роли без загружаемого промпта помечаются
 * `null`, а не выдуманным ярлыком: разбор намерения ведут детерминированные
 * регулярки без промпта вовсе, а отдельного `verifier`-промпта в проекте нет.
 *
 * @param {Record<string, any> | null} narration
 * @returns {Record<string, string | null>}
 */
function turnPromptVersions(narration) {
  const byRole = new Map(PROMPT_DESCRIPTORS.map((descriptor) => [descriptor.role, descriptor.promptId]))
  return {
    intent_parser: null,
    action_adjudicator: byRole.get('action_adjudicator') ?? null,
    narrator: narration?.prompt_version ?? byRole.get('narrator') ?? null,
    verifier: null,
  }
}

export class GameOrchestrator {
  constructor({
    intentParser = new IntentParser(),
    ruleRetriever = null,
    adjudicator = new Adjudicator(),
    rulesEngine,
    eventStore,
    traceStore = null,
    narrator = new Narrator(),
    npcSocialController = null,
    unknownActionHandler = null,
    rollRegistry = null,
    idFactory = randomUUID,
    now = () => Date.now(),
  } = {}) {
    if (!rulesEngine) throw new TypeError('GameOrchestrator требует RulesEngine')
    if (!eventStore) throw new TypeError('GameOrchestrator требует EventStore')
    /**
     * Последние нарации кампании — тёплый буфер в памяти процесса.
     *
     * Раньше их брали из трейс-стора **на каждую нарацию**, а `recent()` читает
     * и разбирает все файлы трасс кампании целиком: за кампанию из N ходов это
     * ~N²/2 чтений и парсингов. Сквозной прогон кампании упирался из-за этого в
     * потолок таймаута (239 с на прежнем main против 600 с и отмены).
     *
     * Трейс-стор остаётся источником только на холодном старте: один скан на
     * кампанию после запуска процесса, дальше буфер обновляется на месте.
     * Нарация не входит в поток событий, поэтому память процесса здесь не
     * ухудшает replay: он и раньше зависел от трасс, а не от событий.
     */
    this.narrationMemory = new Map()
    this.intentParser = intentParser
    this.ruleRetriever = ruleRetriever
    this.adjudicator = adjudicator
    this.rulesEngine = rulesEngine
    this.eventStore = eventStore
    this.traceStore = traceStore
    this.narrator = narrator
    this.npcSocialController = npcSocialController
    this.unknownActionHandler = unknownActionHandler ?? new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, rollRegistry, now })
    // Реестр бросков включает ручное подтверждение кубика игроком; без него
    // все d20-проверки разрешаются немедленным серверным броском, как раньше.
    this.rollRegistry = rollRegistry
    this.narrationInflight = new Map()
    this.idFactory = idFactory
    this.now = now
  }

  /**
   * Последние нарации кампании. Холодный старт поднимает историю из трасс один
   * раз, дальше отвечает тёплый буфер.
   */
  recentNarrationsFor(campaignId) {
    const key = String(campaignId ?? '')
    if (!key) return []
    const warm = this.narrationMemory.get(key)
    if (warm) return warm
    const cold = recentCampaignNarrations(this.traceStore, key)
    this.narrationMemory.set(key, cold)
    return cold
  }

  /** Запоминает показанный игроку текст, чтобы следующая нарация его не повторила. */
  rememberNarration(campaignId, value) {
    const key = String(campaignId ?? '')
    const text = String(value ?? '').trim()
    if (!key || !text) return
    const next = [...this.recentNarrationsFor(key), text].slice(-NARRATOR_RECENT_TEXT_LIMIT)
    // Переустановка ключа поднимает кампанию в конец очереди: вытесняется та,
    // к которой дольше всех не обращались.
    this.narrationMemory.delete(key)
    this.narrationMemory.set(key, next)
    while (this.narrationMemory.size > NARRATION_MEMORY_CAMPAIGNS) {
      const oldest = this.narrationMemory.keys().next().value
      if (oldest === undefined) break
      this.narrationMemory.delete(oldest)
    }
  }

  explanation(campaignId, turnId = null, viewer = null) {
    if (!this.traceStore) return null
    const trace = turnId ? this.traceStore.get(campaignId, turnId) : this.traceStore.latest(campaignId)
    return buildTurnExplanation(trace, viewer)
  }

  /**
   * Команда парлея, откуда бы она ни пришла: явной командой из хотбара или
   * распознанной фразой в бою. `null` — обычный ход.
   *
   * Подход (Убеждение или Запугивание) выводится из самой фразы тем же
   * детерминированным правилом, что и распознавание окрика, — `parleySkillFor`
   * в `parley.mjs`. Второго списка нажима здесь нет намеренно: прежний
   * разошёлся с распознаванием и читал «прекрати бой, или я тебя убью»
   * Убеждением.
   *
   * @returns {{ command_type: 'ProposeParley', actor_id: string, skill: string } | null}
   */
  parleyCommandFor({ input, playerId, message, state }) {
    const explicit = (Array.isArray(input?.commands) ? input.commands : [])
      .find((command) => String(command?.command_type ?? '') === 'ProposeParley')
    if (explicit) {
      return {
        ...explicit,
        actor_id: String(explicit.actor_id ?? playerId),
        skill: explicit.skill === 'intimidation' ? 'intimidation' : 'persuasion',
      }
    }
    if (input?.commands || !playerId) return null
    if (state?.mechanics?.combat?.active !== true || truceFor(state)) return null
    if (!mentionsParley(message)) return null
    return { command_type: 'ProposeParley', actor_id: playerId, skill: parleySkillFor(message) }
  }

  /**
   * Карточка проверки для первой фазы ручного броска. СЛ берётся у той же
   * серверной морали, которую применит движок во второй фазе, поэтому игрок
   * бросает ровно против объявленного числа.
   */
  parleyCheckCard({ campaignId, playerId, state, command }) {
    const morale = parleyMoraleFor(state)
    // Фанатикам и бессловесным бросать нечего: отказ выносит движок, и он
    // должен случиться сразу, а не после кубика.
    if (morale.refuses) return null
    const attempts = Math.max(0, Number(state?.mechanics?.combat?.parley_attempts) || 0)
    const preview = previewD20Check(state, {
      actorId: String(command.actor_id ?? playerId),
      kind: 'check',
      ability: PARLEY_ABILITY,
      skill: command.skill,
      difficulty: morale.difficulty,
    })
    const check = this.rollRegistry.registerCheck({
      campaignId,
      actorId: String(command.actor_id ?? playerId),
      label: d20CheckLabel({ kind: 'check', ability: preview.ability, skill: preview.skill }),
      modifier: preview.modifier,
      difficulty: morale.difficulty,
      ability: preview.ability,
      advantage: preview.advantage,
      // Повторный окрик идёт с помехой — тем же правилом, что применит движок.
      disadvantage: preview.disadvantage || attempts > 0,
      context: { kind: 'parley', policy: PARLEY_POLICY_ID, skill: command.skill },
    })
    return { ...check, skill: preview.skill }
  }

  /**
   * Карточка проверки для первой фазы побега от стражи. СЛ — пассивное
   * Восприятие стражи, объявленное сервером при встрече, поэтому игрок бросает
   * ровно против того числа, которое применит движок.
   */
  guardEscapeCheckCard({ campaignId, playerId, state, command }) {
    const encounter = guardEncounterFor(state)
    if (!encounter) return null
    const actorId = String(command.actor_id ?? playerId)
    const preview = previewD20Check(state, {
      actorId,
      kind: 'check',
      skill: command.skill,
      difficulty: encounter.escape_dc,
    })
    const check = this.rollRegistry.registerCheck({
      campaignId,
      actorId,
      label: d20CheckLabel({ kind: 'check', ability: preview.ability, skill: preview.skill }),
      modifier: preview.modifier,
      difficulty: encounter.escape_dc,
      ability: preview.ability,
      advantage: preview.advantage,
      // Повторная попытка идёт с помехой — тем же правилом, что применит движок.
      disadvantage: preview.disadvantage || encounter.escape_attempts > 0,
      context: { kind: 'guard-escape', policy: LAW_POLICY_ID, skill: command.skill },
    })
    return { ...check, skill: preview.skill }
  }

  /**
   * Карточка проверки для ответного броска за костями. СЛ здесь честнее, чем у
   * любой другой карточки: это ровно `бросок соперника + 1`, уже лежащий в
   * состоянии, — раунд для того и разложен на две команды, чтобы игроку было
   * против чего бросать.
   *
   * Подход уезжает в предпросмотр вместе с героем, и это не украшение: у
   * подкрученной кости свой модификатор, и печатать «+0» там, где исполнение
   * посчитает «+5», карточка не имеет права.
   */
  tavernDiceCheckCard({ campaignId, playerId, state, command }) {
    const actorId = String(command.actor_id ?? playerId)
    const round = tavernRoundFor(state, actorId)
    if (!round) return null
    const approach = String(command.approach ?? 'fair')
    const preview = previewTavernDiceRoll(state, actorId, approach)
    const check = this.rollRegistry.registerCheck({
      campaignId,
      actorId,
      label: `Кости против ${round.npc_name || 'соперника'}`,
      modifier: preview.modifier,
      difficulty: round.target,
      ability: null,
      advantage: preview.advantage,
      disadvantage: preview.disadvantage,
      // Подход закрепляется здесь и только здесь. Иначе решение подкрутить
      // кость принималось бы **после** просмотра кубика: первая фаза объявляла
      // бы честный бросок, игрок видел бы выпавшее число, а вторая приносила бы
      // `cheat` новой командой — и +5 доставался бы ровно тем, кому его не
      // хватило. Модификатор карточки при этом уже посчитан по этому подходу.
      context: { kind: 'tavern-dice', policy: TAVERN_POLICY_ID, round_id: round.id, approach },
    })
    return check
  }

  freeActionResponse({
    freeAction,
    campaignId,
    playerId,
    viewer,
    message,
    intent,
    retrievalQueries,
    retrievedRules,
    plan,
    authoritativeState,
    idempotencyKey,
    turnId,
    started,
    mode,
  }) {
    const state = freeAction.state ?? authoritativeState
    // Проверка объявлена, но кубик за игроком: события не коммитились, мир не
    // изменился. Клиент получает карточку броска, а не нарацию хода.
    if (freeAction.kind === 'check_required') {
      return {
        narration: String(freeAction.narration ?? ''),
        effects: emptyEffects(),
        provider: 'deterministic-free-action',
        model: 'server-policy',
        turn_id: turnId,
        engine_mode: mode,
        state_version: freeAction.state_version ?? state.state_version,
        mechanics: [],
        visible_state_changes: [],
        check: freeAction.check,
        ...(freeAction.stakes ? { stakes: freeAction.stakes } : {}),
        turn_consumed: false,
        action_kind: 'free',
        free_action_outcome: freeAction.kind,
      }
    }
    const committedEvents = Array.isArray(freeAction.events) ? freeAction.events : []
    const publicCommittedEvents = mechanicsForViewer(committedEvents, { isPartyMember: true }, playerId, state)
    const constraints = [
      ...(Array.isArray(plan?.narration_constraints) ? plan.narration_constraints : []),
      ...(noWorldChangeConstraint(plan) ? ['no-unconfirmed-world-changes'] : []),
      ...(Array.isArray(freeAction.narration_constraints) ? freeAction.narration_constraints : []),
    ]
    const storyContext = narrationStoryContext(state, viewer, publicCommittedEvents)
    const brief = buildNarrationBrief({
      visible_events: publicCommittedEvents,
      visible_state_changes: visibleChanges(publicCommittedEvents),
      known_environment: {
        scene: projectVisibleState(state.scene ?? {}, viewer, { forNarrator: true }) ?? {},
        campaign_premise: campaignConceptForAgent(state),
        // Небо и час — данные, а не право сочинять: Рассказчик получает уже
        // решённые время суток и погоду, чтобы не выдумывать закат в полдень.
        world_clock: worldClockForAgents(state),
        world_memory: { facts: narrationWorldFacts(state, viewer, message, publicCommittedEvents) },
        story_context: storyContext,
        social_consequences: narrationSocialConsequences(publicCommittedEvents, state),
      },
      permitted_npc_reactions: narrationNpcReactions(storyContext.present_npcs, publicCommittedEvents),
      narration_constraints: constraints,
      viewer,
    })
    const candidateNarration = String(freeAction.narration ?? '').trim()
    const candidateVerification = verifyNarration(candidateNarration, brief, { knownRuleIds: [] })
    const narration = candidateVerification.valid && candidateNarration
      ? candidateNarration
      : freeAction.kind === 'clarification'
        ? 'Опишите действие подробнее, чтобы его можно было разрешить по правилам.'
        : 'Действие не получило подтверждённого последствия. Уточните, чего герой хочет добиться.'
    const verification = verifyNarration(narration, brief, { knownRuleIds: [] })
    const idempotentReplay = Boolean(freeAction.duplicate)
    const response = {
      narration,
      effects: eventsToClientEffects(committedEvents, freeAction.rolls ?? []),
      provider: 'deterministic-free-action',
      model: 'server-policy',
      turn_id: turnId,
      engine_mode: mode,
      state_version: state.state_version,
      mechanics: committedEvents,
      visible_state_changes: projectVisibleState(visibleChanges(publicCommittedEvents), viewer) ?? [],
      authoritative_state: state,
      verification,
      ruling: freeAction.ruling ?? null,
      // Ставки объявляются игроку вместе с исходом: характеристика, СЛ и цена провала.
      ...(freeAction.stakes ? { stakes: freeAction.stakes } : {}),
      explanation_url: `/api/campaigns/${encodeURIComponent(campaignId)}/turns/${encodeURIComponent(turnId)}/explanation`,
      idempotent_replay: idempotentReplay,
      turn_consumed: false,
      action_kind: 'free',
      free_action_outcome: freeAction.kind,
      ...(freeAction.rejected ? { rejected: true } : {}),
    }
    if (!idempotentReplay) {
      this.saveTrace({
        turnId,
        campaignId,
        idempotencyKey,
        mode,
        intent,
        retrievalQueries,
        retrievedRules,
        plan: {
          ...plan,
          proposed_commands: freeAction.commands ?? [],
          ruling_required: Boolean(freeAction.ruling),
          ruling_draft: freeAction.ruling ?? null,
          narration_constraints: constraints,
        },
        engineResult: { commands: freeAction.commands ?? [], events: committedEvents, rolls: freeAction.rolls ?? [] },
        stateBefore: authoritativeState.state_version,
        stateAfter: state.state_version,
        verification,
        latency: this.now() - started,
        narration: {
          narration,
          verification,
          prompt_version: 'free-action/v1',
          provider: response.provider,
        },
        ruling: freeAction.ruling ?? null,
      })
    }
    return response
  }

  async handle(input) {
    const originalState = normalizeCampaignState(input.state ?? {})
    const campaignId = String(input.campaignId ?? input.campaign_id ?? originalState.sessionCode ?? originalState.campaign_id ?? '')
    const playerId = String(input.playerId ?? input.player_id ?? originalState.activePlayerId ?? '')
    const message = String(input.message ?? input.action ?? '').trim().slice(0, 2000)
    const idempotencyKey = String(input.idempotencyKey ?? input.idempotency_key ?? '')
    const npcId = String(input.npcId ?? input.npc_id ?? '').trim().slice(0, 120)
    const coalesces = !input.commands && message !== '/why' && input.why !== true && Boolean(campaignId && idempotencyKey)
    if (!coalesces) return this._handle(input)

    const key = `${campaignId}\u001f${idempotencyKey}`
    const requestFingerprint = narrationRequestFingerprint({ campaignId, playerId, message, npcId })
    const existing = this.narrationInflight.get(key)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError(campaignId, idempotencyKey)
      }
      const result = await existing.promise
      return { ...result, idempotent_replay: true }
    }

    const entry = { requestFingerprint, promise: null }
    entry.promise = this._handle(input)
    this.narrationInflight.set(key, entry)
    try {
      return await entry.promise
    } finally {
      if (this.narrationInflight.get(key) === entry) this.narrationInflight.delete(key)
    }
  }

  async _handle(input) {
    const started = this.now()
    const originalState = normalizeCampaignState(input.state ?? {})
    const campaignId = String(input.campaignId ?? input.campaign_id ?? originalState.sessionCode ?? originalState.campaign_id ?? '')
    const playerId = String(input.playerId ?? input.player_id ?? originalState.activePlayerId ?? '')
    const message = String(input.message ?? input.action ?? '').trim().slice(0, 2000)
    const idempotencyKey = String(input.idempotencyKey ?? input.idempotency_key ?? this.idFactory())
    const explicitNpcId = String(input.npcId ?? input.npc_id ?? '').trim().slice(0, 120)
    const directorCapability = input.commandCapability === DIRECTOR_COMMAND_CAPABILITY
    const rulesContext = {
      allowedActorIds: input.allowedActorIds ?? [playerId],
      isAdmin: input.user?.role === 'admin',
      isDirector: directorCapability,
    }
    let turnId = structuredCommandTurnId(campaignId, idempotencyKey)
    const mode = 'enforce'
    // Ручной бросок: клиент просит не бросать d20 за игрока. Сервер остаётся
    // авторитетом — он регистрирует проверку и принимает только свой roll_id.
    const manualRoll = input.manualRoll === true
    const verifiedRoll = input.verifiedRoll ?? null

    if (message === '/why' || input.why === true) {
      const rawExplanation = this.explanation(campaignId, input.turnId ?? input.turn_id, {
        playerId,
        isPartyMember: true,
        role: input.user?.role,
      })
      const explanation = turnExplanationForViewer(rawExplanation, input.user ?? {}, playerId, originalState)
      return { narration: whyNarration(explanation, actorNameResolver(originalState)), effects: emptyEffects(), provider: 'RulesEngine', model: 'deterministic', engine_mode: mode, turn_id: explanation?.turn_id ?? null, state_version: originalState.state_version, explanation, turn_consumed: false }
    }

    const viewer = { playerId, partyIds: input.partyIds ?? [], isPartyMember: true, role: input.user?.role }
    const visibleState = campaignStateForViewer(originalState, input.user ?? {}, playerId) ?? {}
    visibleState.social = npcSocialForViewer(ensureNpcSocialState(originalState.social, originalState), {
      playerId,
      isAdmin: input.user?.role === 'admin',
      isPartyMember: true,
      state: originalState,
    })
    const worldkeeperViewer = {
      playerId,
      isAdmin: input.user?.role === 'admin',
      isPartyMember: true,
      role: input.user?.role,
    }
    const worldkeeperState = { ...visibleState, worldMemory: originalState.worldMemory }
    // Окрик о переговорах посреди боя — не вопрос к миру: Хранитель мира на
    // него отвечать не должен, иначе «предлагаю переговоры» уходило бы в
    // «подтверждённых сведений нет» и до правила не доезжало.
    const loreAnswer = input.commands || explicitNpcId
      || (originalState.mechanics?.combat?.active === true && mentionsParley(message))
      ? null
      : answerKnownLore(message, worldkeeperState, { viewer: worldkeeperViewer })
    if (loreAnswer) {
      const loreIntent = {
        actor_id: playerId, intent: 'known_lore_query', approach: 'deterministic',
        targets: [], mentioned_entities: [], missing_information: [],
        requires_clarification: false, confidence: 1, raw_message: message,
      }
      const lorePlan = { rule_ids: [], proposed_commands: [], roll_requests: [], ruling_required: false, narration_constraints: ['known-world-facts-only'], confidence: 1 }
      const response = { ...loreAnswer, engine_mode: mode, turn_id: turnId, state_version: originalState.state_version }
      this.saveTrace({ turnId, campaignId, mode, intent: loreIntent, retrievalQueries: [], retrievedRules: { results: [], confidence: 1, count: 0 }, plan: lorePlan, stateBefore: originalState.state_version, stateAfter: originalState.state_version, verification: { valid: true }, latency: this.now() - started })
      return response
    }
    const loaded = await this.eventStore.load(campaignId)
    const authoritativeState = normalizeCampaignState(loaded.state)
    const duplicate = typeof this.eventStore.getByIdempotencyKey === 'function'
      ? await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      : null
    const requestFingerprint = narrationRequestFingerprint({
      campaignId,
      playerId,
      message,
      npcId: explicitNpcId,
    })
    const requestTrace = duplicate && this.traceStore && typeof this.traceStore.get === 'function'
      ? this.traceStore.get(campaignId, turnId)
      : null
    assertNarrationRequestIdempotency(duplicate, requestTrace, {
      campaignId,
      idempotencyKey,
      playerId,
      message,
      npcId: explicitNpcId,
    })
    // Парлей: единственная развилка на оба входа.
    //
    // Кнопка хотбара приходит сюда командой `ProposeParley`, свободная фраза —
    // текстом, и обе идут через `_handle`. Развилка стоит **до** разбора
    // намерения намеренно: «предлагаю переговоры» разбирается как социальное
    // намерение и требует npc_id, которого у врага в бою нет, — без этой ветки
    // фраза упиралась бы в уточнение, а не в правило.
    //
    // Ручной бросок тоже один на оба входа: сервер регистрирует проверку в
    // реестре, ничего не коммитит и ждёт второй запрос с `roll_id`. Так игрок
    // бросает d20 сам и за парлей из хотбара, и за парлей голосом.
    const parleyCommand = this.parleyCommandFor({ input, playerId, message, state: authoritativeState })
    if (parleyCommand) {
      if (manualRoll && !verifiedRoll && this.rollRegistry && !duplicate) {
        const card = this.parleyCheckCard({ campaignId, playerId, state: authoritativeState, command: parleyCommand })
        if (card) {
          return {
            narration: `Требуется проверка: ${card.label}, СЛ ${card.difficulty}. Бросьте d20, чтобы узнать, услышат ли вас.`,
            effects: emptyEffects(),
            provider: 'RulesEngine',
            model: 'deterministic',
            turn_id: turnId,
            engine_mode: mode,
            state_version: authoritativeState.state_version,
            mechanics: [],
            visible_state_changes: [],
            authoritative_state: authoritativeState,
            check: { ...card, sides: 20 },
            turn_consumed: false,
          }
        }
      }
      if (verifiedRoll) {
        // Бросок обязан быть зарегистрирован **как парлей**. Реестр сверяет
        // только кампанию и актора (`roll-registry.mjs`), поэтому без этой
        // проверки во вторую фазу переговоров можно было бы подать кубик от
        // любой другой проверки того же героя — в том числе брошенный одной
        // костью там, где парлей требует помехи.
        const { context: parleyCheckContext, ...verifiedRollPayload } = verifiedRoll
        if (String(parleyCheckContext?.kind ?? '') !== 'parley') {
          const error = new Error('Этот бросок регистрировался не для переговоров')
          error.code = 'ROLL_CONTEXT_MISMATCH'
          throw error
        }
        parleyCommand.verified_roll = verifiedRollPayload
      }
      input = { ...input, commands: [parleyCommand] }
    }
    // Побег от стражи: тот же двухфазный ручной кубик, что у парлея. Карточка
    // объявляет ту же СЛ, которую применит движок во второй фазе, а бросает её
    // тот, кто побег объявил, — остальных героев отряда бросает сервер, потому
    // что собрать четыре ручных кубика в одну команду движок не умеет.
    const escapeCommand = (input.commands ?? []).find((candidate) => (
      String(candidate?.command_type ?? '') === 'ResolveGuardEncounter'
      && String(candidate?.resolution ?? '') === 'flee'
    )) ?? null
    if (escapeCommand) {
      if (manualRoll && !verifiedRoll && this.rollRegistry && !duplicate) {
        const card = this.guardEscapeCheckCard({ campaignId, playerId, state: authoritativeState, command: escapeCommand })
        if (card) {
          return {
            narration: `Требуется проверка: ${card.label}, СЛ ${card.difficulty}. Бросьте d20, чтобы узнать, уйдёт ли отряд.`,
            effects: emptyEffects(),
            provider: 'RulesEngine',
            model: 'deterministic',
            turn_id: turnId,
            engine_mode: mode,
            state_version: authoritativeState.state_version,
            mechanics: [],
            visible_state_changes: [],
            authoritative_state: authoritativeState,
            check: { ...card, sides: 20 },
            turn_consumed: false,
          }
        }
      }
      if (verifiedRoll) {
        // Бросок обязан быть зарегистрирован **как побег**: реестр сверяет
        // только кампанию и актора, поэтому без этой проверки во вторую фазу
        // можно было бы подать кубик от любой другой проверки того же героя.
        const { context: escapeCheckContext, ...verifiedRollPayload } = verifiedRoll
        if (String(escapeCheckContext?.kind ?? '') !== 'guard-escape') {
          const error = new Error('Этот бросок регистрировался не для побега от стражи')
          error.code = 'ROLL_CONTEXT_MISMATCH'
          throw error
        }
        escapeCommand.verified_roll = verifiedRollPayload
      }
    }
    // Ответный бросок за костями — тот же двухфазный ручной кубик, что у парлея
    // и побега. Разница одна и она в пользу игрока: СЛ здесь не выведена
    // политикой, а лежит на столе — это кость соперника, брошенная предыдущей
    // командой.
    const tavernAnswerCommand = (input.commands ?? [])
      .find((candidate) => String(candidate?.command_type ?? '') === 'AnswerTavernDiceRound') ?? null
    if (tavernAnswerCommand) {
      if (manualRoll && !verifiedRoll && this.rollRegistry && !duplicate) {
        const card = this.tavernDiceCheckCard({ campaignId, playerId, state: authoritativeState, command: tavernAnswerCommand })
        if (card) {
          return {
            narration: `Кость соперника на столе: нужно ${card.difficulty} или больше. Бросайте.`,
            effects: emptyEffects(),
            provider: 'RulesEngine',
            model: 'deterministic',
            turn_id: turnId,
            engine_mode: mode,
            state_version: authoritativeState.state_version,
            mechanics: [],
            visible_state_changes: [],
            authoritative_state: authoritativeState,
            check: { ...card, sides: 20 },
            turn_consumed: false,
          }
        }
      }
      if (verifiedRoll) {
        // Бросок обязан быть зарегистрирован **как кости**: реестр сверяет
        // только кампанию и актора, поэтому без этой проверки во вторую фазу
        // раунда можно было бы подать кубик от любой другой проверки того же
        // героя — в том числе брошенный с модификатором навыка.
        const { context: tavernCheckContext, ...verifiedRollPayload } = verifiedRoll
        if (String(tavernCheckContext?.kind ?? '') !== 'tavern-dice') {
          const error = new Error('Этот бросок регистрировался не для игры в кости')
          error.code = 'ROLL_CONTEXT_MISMATCH'
          throw error
        }
        // Подход берётся из реестра, а не из этой команды, и расхождение —
        // отказ, а не тихое исправление.
        //
        // Соблазн здесь ровно один и он крупный: между фазами игрок видит свой
        // кубик. Если бы вторая фаза читала `approach` из новой команды, решение
        // «а подкручу-ка» принималось бы уже после просмотра числа — и +5
        // доставался бы только тем броскам, которым не хватило. Карточка при
        // этом объявила бы честный модификатор, то есть соврала бы столу.
        //
        // Раунд сверяется тем же движением: карточка объявила СЛ по кости,
        // лежавшей на столе в первой фазе, а между фазами раунд мог закрыться
        // (соперник разорился, герой встал из-за стола) и открыться заново уже
        // против другого числа.
        const registeredApproach = String(tavernCheckContext?.approach ?? '')
        if (!TAVERN_DICE_APPROACHES.includes(registeredApproach)) {
          const error = new Error('Этот бросок регистрировался без подхода к игре: бросьте кость заново')
          error.code = 'ROLL_CONTEXT_MISMATCH'
          throw error
        }
        if (String(tavernAnswerCommand.approach ?? registeredApproach) !== registeredApproach) {
          const error = new Error('Подход к броску выбирается до кости, а не после: этот бросок регистрировался иначе')
          error.code = 'ROLL_CONTEXT_MISMATCH'
          throw error
        }
        const registeredRoundId = String(tavernCheckContext?.round_id ?? '')
        if (registeredRoundId !== String(tavernRoundFor(authoritativeState, String(tavernAnswerCommand.actor_id ?? playerId))?.id ?? '')) {
          const error = new Error('За столом уже другой раунд: этот бросок к нему не относится')
          error.code = 'ROLL_CONTEXT_MISMATCH'
          throw error
        }
        tavernAnswerCommand.approach = registeredApproach
        tavernAnswerCommand.verified_roll = verifiedRollPayload
      }
    }
    let intent = input.commands
      ? { actor_id: playerId, intent: 'structured_commands', approach: 'api', targets: [], mentioned_entities: [], missing_information: [], requires_clarification: false, confidence: 1, raw_message: message }
      : await this.intentParser.parse({ message, playerId, visibleState })
    if (!input.commands && explicitNpcId) {
      intent = {
        ...intent,
        intent: 'social',
        targets: [explicitNpcId],
        missing_information: [],
        requires_clarification: false,
      }
    }
    let socialRequest = null
    if (!input.commands && intent.intent === 'social' && this.npcSocialController) {
      const socialNpcIds = new Set((visibleState.social?.npcs ?? []).map((npc) => String(npc.id)))
      const npcId = (intent.targets ?? []).map(String).find((candidate) => socialNpcIds.has(candidate))
      if (intent.requires_clarification) {
        // Резолвер уже нашёл неоднозначность и сохранил кандидатов для полезного уточнения.
        socialRequest = null
      } else if (!npcId) {
        intent.requires_clarification = true
        intent.missing_information = ['npc_id']
      } else socialRequest = { npcId }
    }
    const retrievalQueries = buildRuleQueries(intent, originalState)
    const retrievedRules = this.ruleRetriever && retrievalQueries.length
      ? await this.ruleRetriever.search({ queries: retrievalQueries, ruleset_id: originalState.ruleset_id, enabled_packs: originalState.enabled_rule_packs, limit: 10 })
      : { results: [], confidence: 0, count: 0 }
    const freeActionRequest = !input.commands && ['improvised_action', 'unknown'].includes(intent.intent)
    let plan = input.commands
      ? { rule_ids: [...new Set(input.commands.flatMap((command) => command.source_rule_ids ?? []))], proposed_commands: input.commands, roll_requests: [], ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1 }
      : intent.requires_clarification
        ? {
            rule_ids: [],
            proposed_commands: [],
            roll_requests: [],
            ruling_required: false,
            ruling_draft: null,
            narration_constraints: [],
            confidence: intent.confidence,
            clarification_required: true,
            missing_information: intent.missing_information,
          }
      : socialRequest
        ? {
            rule_ids: [],
            proposed_commands: [],
            roll_requests: [],
            ruling_required: false,
            ruling_draft: null,
            narration_constraints: ['server-social-check-before-dialogue', 'npc-dialogue-from-committed-event-only'],
            confidence: intent.confidence,
          }
        : freeActionRequest
          ? {
              rule_ids: [],
              proposed_commands: [],
              roll_requests: [],
              ruling_required: false,
              ruling_draft: null,
              narration_constraints: ['free-action-committed-consequences-only'],
              confidence: intent.confidence,
            }
        : await this.adjudicator.createPlan({ intent, state: originalState, retrievedRules })
    plan = { ...plan, proposed_commands: validateAllowedCommands(plan.proposed_commands ?? []).map((command, index) => ({ ...command, campaign_id: campaignId, command_id: `${idempotencyKey}:${index + 1}` })) }

    if (freeActionRequest) {
      turnId = structuredCommandTurnId(campaignId, idempotencyKey)
      const freeAction = await this.unknownActionHandler.handleUnknownAction({
        campaignId,
        action: message,
        idempotencyKey,
        playerId,
        intent,
        manualRoll,
        verifiedRoll,
      })
      return this.freeActionResponse({
        freeAction,
        campaignId,
        playerId,
        viewer,
        message,
        intent,
        retrievalQueries,
        retrievedRules,
        plan,
        authoritativeState,
        idempotencyKey,
        turnId,
        started,
        mode,
      })
    }
    if (socialRequest && !duplicate) {
      const social = ensureNpcSocialState(authoritativeState.social, authoritativeState)
      const persistedProfile = social.npcs.find((npc) => npc.id === socialRequest.npcId)
      const profile = persistedProfile ? npcProfileAtWorldTime(persistedProfile, authoritativeState) : null
      const sceneLocation = String(authoritativeState.scene?.location ?? '').trim().toLocaleLowerCase('ru')
      const npcLocation = String(profile?.location ?? '').trim().toLocaleLowerCase('ru')
      // Разговор в активном бою запрещён — кроме одного случая: под
      // объявленным перемирием говорить можно, и говорить можно **только** с
      // предводителем противника. Ради этого парлей и заводился; исключение
      // именное, чтобы посреди схватки нельзя было заболтать кого угодно.
      //
      // Допуск держится на живом перемирии, а не на профиле: собеседник
      // переговоров заведён недоступным и без адреса, чтобы после боя он не
      // остался в мире говорящим трупом (`rules-engine.mjs`, ветка
      // `ProposeParley`). Кончилось перемирие — кончился и допуск.
      const truceLeaderId = String(truceFor(authoritativeState)?.leader_id ?? '')
      const speaksUnderTruce = Boolean(truceLeaderId) && socialRequest.npcId === truceLeaderId
      const unavailable = !profile || (!speaksUnderTruce && (
        profile.available === false
        || Boolean(authoritativeState.mechanics?.combat?.active)
        || (sceneLocation && npcLocation && sceneLocation !== npcLocation)
      ))
      if (unavailable) {
        intent.requires_clarification = true
        intent.missing_information = ['available_npc']
      }
    }


    if (intent.requires_clarification || plan.clarification_required) {
      const narration = humanMissingInformation(intent.missing_information ?? plan.missing_information, authoritativeState, intent)
      const response = { narration, effects: emptyEffects(), provider: 'RulesEngine', model: 'deterministic', turn_id: turnId, engine_mode: mode, state_version: authoritativeState.state_version, mechanics: [], visible_state_changes: [], authoritative_state: authoritativeState, turn_consumed: false }
      this.saveTrace({ turnId, campaignId, mode, intent, retrievalQueries, retrievedRules, plan, stateBefore: authoritativeState.state_version, stateAfter: authoritativeState.state_version, verification: { valid: true }, latency: this.now() - started })
      return response
    }

    // Ручной бросок для распознанных проверок и спасбросков: план построен,
    // но кубик остаётся за игроком. Ничего не коммитим — ход завершит второй
    // запрос с roll_id из `/api/roll`. Социальные проверки и структурные
    // команды идут прежним путём.
    const planCheckCommand = !input.commands && !socialRequest && !duplicate
      ? (plan.proposed_commands ?? []).find((command) => ['MakeAbilityCheck', 'MakeSavingThrow'].includes(command.command_type) && !command.social_check)
      : null
    if (planCheckCommand && manualRoll && !verifiedRoll && this.rollRegistry) {
      const preview = previewD20Check(authoritativeState, {
        actorId: planCheckCommand.actor_id ?? playerId,
        kind: planCheckCommand.command_type === 'MakeSavingThrow' ? 'save' : 'check',
        ability: planCheckCommand.ability ?? null,
        skill: planCheckCommand.skill ?? null,
        difficulty: planCheckCommand.difficulty ?? 10,
        proficient: Boolean(planCheckCommand.proficient),
      })
      const check = this.rollRegistry.registerCheck({
        campaignId,
        actorId: String(planCheckCommand.actor_id ?? playerId),
        label: d20CheckLabel({ kind: preview.kind, ability: preview.ability, skill: preview.skill }),
        modifier: preview.modifier,
        difficulty: preview.difficulty,
        ability: preview.ability,
        advantage: preview.advantage,
        disadvantage: preview.disadvantage,
      })
      return {
        narration: `Требуется проверка: ${check.label}, СЛ ${check.difficulty}. Бросьте d20, чтобы узнать исход.`,
        effects: emptyEffects(),
        provider: 'RulesEngine',
        model: 'deterministic',
        turn_id: turnId,
        engine_mode: mode,
        state_version: authoritativeState.state_version,
        mechanics: [],
        visible_state_changes: [],
        check: { ...check, sides: 20, skill: preview.skill },
        turn_consumed: false,
      }
    }
    if (planCheckCommand && verifiedRoll) {
      // Кости из реестра передаются движку; математику он пересчитывает сам.
      const { context: _checkContext, ...verifiedRollPayload } = verifiedRoll
      planCheckCommand.verified_roll = verifiedRollPayload
    }

    let socialBaseState = authoritativeState
    let precedingEvents = []
    let precedingRolls = []
    let precedingCommands = []
    let socialTurn = null
    if (socialRequest) {
      const policy = buildNpcSocialCheckPolicy({ state: authoritativeState, npcId: socialRequest.npcId, heroId: playerId, message, turnId })
      const checkKey = `${idempotencyKey}:social-check`
      let checkCommit = policy && typeof this.eventStore.getByIdempotencyKey === 'function'
        ? await this.eventStore.getByIdempotencyKey(campaignId, checkKey)
        : null
      let checkCommand = null
      if (!duplicate && policy && !checkCommit) {
        checkCommand = {
          command_type: 'MakeAbilityCheck', actor_id: playerId, social_check: { requested: true },
          campaign_id: campaignId, command_id: `${checkKey}:1`,
        }
        rulesContext.isSocialController = true
        rulesContext.socialCheck = policy
        const checkPlan = { rule_ids: [], proposed_commands: [checkCommand], roll_requests: [], ruling_required: false, ruling_draft: null, narration_constraints: [], confidence: 1 }
        const checkResult = this.rulesEngine.resolvePlan(checkPlan, authoritativeState, rulesContext)
        try {
          checkCommit = await this.eventStore.commit({
            campaign_id: campaignId, expected_state_version: authoritativeState.state_version,
            idempotency_key: checkKey, command_id: checkKey, events: checkResult.events,
          })
        } catch (error) {
          if (!(error instanceof IdempotencyConflictError) && error?.code !== 'IDEMPOTENCY_CONFLICT') throw error
          checkCommit = await this.eventStore.getByIdempotencyKey(campaignId, checkKey)
          if (!checkCommit) throw error
        }
        precedingCommands = checkResult.commands
        precedingRolls = checkResult.rolls
      }
      let checkOutcome = null
      if (policy && checkCommit) {
        const checkEvent = (checkCommit.events ?? []).find((event) => event.event_type === 'AbilityCheckResolved' && event.payload?.social_check)
        assertNpcSocialCheckFingerprint(checkEvent, policy)
        checkOutcome = npcSocialCheckOutcome(checkEvent)
        if (!checkOutcome) throw new Error('Committed social check has no usable outcome')
        precedingEvents = checkCommit.events ?? []
        if (!precedingRolls.length) precedingRolls = [checkEvent.payload]
        const latest = await this.eventStore.load(campaignId)
        socialBaseState = normalizeCampaignState(latest.state)
      }
      if (!duplicate) {
        socialTurn = await this.npcSocialController.respond({
          state: socialBaseState, playerId, npcId: socialRequest.npcId, message, turnId, checkOutcome,
        })
        if (!socialTurn) throw new Error('NPC is no longer available for this social turn')
        rulesContext.isSocialController = true
        rulesContext.socialCheckOutcome = checkOutcome
        const socialCommand = {
          command_type: 'RecordNpcSocialTurn', actor_id: playerId, conversation: socialTurn.conversation,
          campaign_id: campaignId, command_id: `${idempotencyKey}:dialogue`,
        }
        plan = {
          ...plan, proposed_commands: validateAllowedCommands([socialCommand]),
          confidence: socialTurn.confidence,
          social_check: policy ? { check_id: policy.check_id, skill: policy.skill } : null,
        }
      }
    }

    let engineResult
    let committed
    let replayedCommit = Boolean(duplicate)
    if (duplicate) {
      committed = duplicate
      engineResult = { commands: plan.proposed_commands, events: duplicate.events, rolls: duplicate.events.filter((event) => event.event_type === 'DieRolled').map((event) => event.payload), state: duplicate.state }
    } else {
      if (plan.ruling_required && !plan.proposed_commands.length) {
        const ruling = { id: this.idFactory(), campaign_id: campaignId, ...plan.ruling_draft }
        plan = { ...plan, ruling_draft: ruling, proposed_commands: [{ command_type: 'RecordRuling', actor_id: playerId || null, ruling, ruling_id: ruling.id, campaign_id: campaignId, command_id: `${idempotencyKey}:ruling` }] }
      }
      let resolutionState = socialRequest ? socialBaseState : authoritativeState
      for (let attempt = 0; attempt < 3; attempt += 1) {
        engineResult = this.rulesEngine.resolvePlan(plan, resolutionState, rulesContext)
        if (!engineResult.events.length) throw new Error('Enforce-ход не создал ни события, ни ruling')
        try {
          committed = await this.eventStore.commit({ campaign_id: campaignId, expected_state_version: resolutionState.state_version, idempotency_key: idempotencyKey, command_id: idempotencyKey, events: engineResult.events })
          break
        } catch (error) {
          if (error?.code === 'STATE_VERSION_CONFLICT' && attempt < 2) {
            const latest = await this.eventStore.load(campaignId)
            resolutionState = normalizeCampaignState(latest.state)
            continue
          }
          if (!(error instanceof IdempotencyConflictError) && error?.code !== 'IDEMPOTENCY_CONFLICT') throw error
          committed = await this.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
          if (!committed) throw error
          replayedCommit = true
          break
        }
      }
    }

    const mainEvents = committed.events ?? engineResult.events
    const committedEvents = [...precedingEvents, ...mainEvents]
    const publicCommittedEvents = mechanicsForViewer(committedEvents, input.user ?? {}, playerId, committed.state)
    engineResult = {
      ...engineResult,
      commands: [...precedingCommands, ...(engineResult.commands ?? [])],
      events: committedEvents,
      rolls: [...precedingRolls, ...(engineResult.rolls ?? [])],
    }
    const changes = visibleChanges(committedEvents)
    const storyContext = narrationStoryContext(committed.state, viewer, publicCommittedEvents)
    const brief = buildNarrationBrief({
      visible_events: publicCommittedEvents,
      visible_state_changes: visibleChanges(publicCommittedEvents),
      known_environment: {
        scene: projectVisibleState(committed.state.scene ?? {}, viewer, { forNarrator: true }) ?? {},
        campaign_premise: campaignConceptForAgent(committed.state),
        // Небо и час — данные, а не право сочинять: тот же расчёт, что у
        // индикатора в шапке сцены, чтобы текст и картинка не разошлись.
        world_clock: worldClockForAgents(committed.state),
        world_memory: {
          facts: narrationWorldFacts(committed.state, viewer, message, publicCommittedEvents),
        },
        story_context: storyContext,
        social_consequences: narrationSocialConsequences(publicCommittedEvents, committed.state),
      },
      permitted_npc_reactions: narrationNpcReactions(storyContext.present_npcs, publicCommittedEvents),
      viewer,
    })
    const resolvedRuleIds = [...new Set([...(plan.rule_ids ?? []), ...committedEvents.flatMap((event) => event.source_rule_ids ?? [])])]
    const idempotentReplay = Boolean(replayedCommit || committed.duplicate)
    const replayTrace = idempotentReplay && this.traceStore && typeof this.traceStore.get === 'function'
      ? requestTrace ?? this.traceStore.get(campaignId, turnId)
      : null
    const storedSocialNarration = npcConversationNarration(committedEvents, committed.state)
    const resolveActorName = actorNameResolver(committed.state)
    // Кто рассказывает про эти события, знает реестр. Раньше выбор был записан
    // лестницей `?:` дважды — здесь и в ветке повтора, — и расходились они
    // молча.
    const deterministicNarrator = deterministicNarratorFor(committedEvents)
    const deterministicResponse = deterministicNarrator
      ? deterministicNarratorResponse(deterministicNarrator, committedEvents, committed.state, brief, resolvedRuleIds)
      : null
    const replayFallback = deterministicResponse
      ?? storedSocialNarration
      ?? deterministicReplayNarration(brief, resolvedRuleIds, resolveActorName)
    const structuredMechanics = Array.isArray(input.commands) && !deterministicNarrator
    const streamsModelNarration = !idempotentReplay
      && !deterministicResponse
      && !storedSocialNarration
      && !structuredMechanics
    if (streamsModelNarration && typeof input.onNarrationStart === 'function') {
      // Этот callback расположен строго после успешного commit. Ошибка
      // необязательного транспорта не может откатить уже принятый ход.
      try {
        input.onNarrationStart({ stateVersion: committed.state_version })
      } catch { /* Поток не является авторитетным результатом хода. */ }
    }
    const onNarrationProgress = typeof input.onNarrationProgress === 'function'
      ? (text) => {
          try {
            input.onNarrationProgress(text, { stateVersion: committed.state_version })
          } catch { /* Поток не является авторитетным результатом хода. */ }
        }
      : null
    const narration = idempotentReplay
      ? cachedNarration(replayTrace, brief, resolvedRuleIds) ?? replayFallback
      : deterministicResponse
        ?? storedSocialNarration
        ?? (structuredMechanics
          ? deterministicMechanicsNarration(brief, resolvedRuleIds, resolveActorName)
          : await this.narrator.render(brief, {
              knownRuleIds: resolvedRuleIds,
              recentNarrations: this.recentNarrationsFor(campaignId),
              onProgress: onNarrationProgress,
            }))
    if (!idempotentReplay) this.rememberNarration(campaignId, narration.narration)
    const response = {
      narration: narration.narration,
      ...(narration.journal_author ? { journal_author: narration.journal_author } : {}),
      effects: eventsToClientEffects(committedEvents, engineResult.rolls),
      provider: narration.provider,
      model: 'orchestrated',
      turn_id: turnId,
      engine_mode: mode,
      state_version: committed.state_version,
      mechanics: committedEvents,
      visible_state_changes: projectVisibleState(changes, viewer) ?? [],
      authoritative_state: committed.state,
      verification: narration.verification,
      ruling: plan.ruling_draft ?? null,
      explanation_url: `/api/campaigns/${encodeURIComponent(campaignId)}/turns/${encodeURIComponent(turnId)}/explanation`,
      idempotent_replay: idempotentReplay,
      ...(storedSocialNarration ? { turn_consumed: true, action_kind: 'social' } : {}),
    }
    if (!idempotentReplay) {
      this.saveTrace({ turnId, campaignId, idempotencyKey, requestFingerprint, mode, intent, retrievalQueries, retrievedRules, plan, engineResult: { ...engineResult, events: committedEvents }, stateBefore: authoritativeState.state_version, stateAfter: committed.state_version, verification: narration.verification, latency: this.now() - started, narration, ruling: plan.ruling_draft })
    }
    return response
  }

  saveTrace({ turnId, campaignId, idempotencyKey = null, requestFingerprint = null, mode, intent, retrievalQueries, retrievedRules, plan, engineResult = {}, stateBefore, stateAfter, verification = {}, latency, narration = null, ruling = null }) {
    if (!this.traceStore) return null
    return this.traceStore.save({
      schema_version: TURN_TRACE_SCHEMA_VERSION,
      turn_id: turnId,
      campaign_id: campaignId,
      idempotency_key: idempotencyKey,
      request_fingerprint: requestFingerprint,
      // Сквозной идентификатор предложения: одно значение проходит через
      // предложение агента, решение политики, команды, события и повествование.
      // Выводится из ключа идемпотентности, поэтому повтор того же хода даёт тот
      // же идентификатор, а не новый.
      proposal_id: proposalIdFor(campaignId, idempotencyKey ?? turnId),
      engine_mode: mode,
      // Версии промптов берутся из реестра рядом с загрузчиками, а не из
      // литералов. Прежние `intent_parser/v1`, `adjudicator/v1` и `verifier/v1`
      // были ярлыками несуществующих файлов — долг, отмеченный в AGENTS.md.
      prompt_versions: turnPromptVersions(narration),
      model_identifiers: modelIdentifiers(narration),
      intent,
      retrieval_queries: retrievalQueries,
      retrieved_rule_ids: [...new Set([...(plan.rule_ids ?? []), ...(retrievedRules.results?.map((result) => result.rule_id) ?? []), ...(engineResult.events ?? []).flatMap((event) => event.source_rule_ids ?? [])])],
      adjudication_plan: plan,
      validated_commands: engineResult.commands ?? plan.proposed_commands ?? [],
      rolls: engineResult.rolls ?? [],
      events: engineResult.events ?? [],
      state_version_before: stateBefore,
      state_version_after: stateAfter,
      verification_result: verification,
      latency_ms: latency,
      token_usage: {},
      narration_result: narration ? {
        narration: narration.narration,
        verification: narration.verification ?? verification,
        prompt_version: narration.prompt_version ?? null,
        provider: narration.provider ?? null,
      } : null,
      ruling,
    })
  }
}
