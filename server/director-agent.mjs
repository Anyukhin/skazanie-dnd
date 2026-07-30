import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { normalizeDirectorIntent } from './autonomous-campaign.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { campaignArcPosition } from './campaign-loop-policy.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { retrieveWorldMemory } from './world-memory.mjs'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/director/v1.txt', import.meta.url)), 'utf8')
const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

export const DIRECTOR_MEMORY_RECORD_LIMIT = 6
const DIRECTOR_THREAD_LIMIT = 6
const DIRECTOR_PROMISE_LIMIT = 6

function currentChapterHistory(state = {}) {
  const history = Array.isArray(state.autonomy?.director_history) ? state.autonomy.director_history : []
  const intents = history.map((entry) => entry?.intent ?? entry).filter((entry) => entry && typeof entry === 'object')
  const lastSceneEnd = intents.map((intent) => intent.type).lastIndexOf('end_scene')
  return intents.slice(lastSceneEnd + 1)
}

function firstActiveQuest(state = {}) {
  return (state.worldMemory?.quests ?? []).find((quest) => quest.status === 'active' && !quest.clock?.triggered) ?? null
}

function firstAvailableNpc(state = {}) {
  const location = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
  return (state.social?.npcs ?? []).find((npc) => npc.available !== false
    && (!npc.location || !location || clean(npc.location, 180).toLocaleLowerCase('ru') === location)) ?? null
}

function directorMemoryQuery(state, playerAction) {
  return [
    playerAction,
    state.scene?.title,
    state.scene?.location,
    state.scene?.objective,
    state.adventure?.currentHook,
  ].filter(Boolean).join(' ').slice(0, 3_000)
}

function directorMemoryRecord(record) {
  const result = {
    kind: clean(record.kind, 40),
    id: clean(record.id, 120),
    summary: clean(record.summary, 360),
  }
  if (record.kind === 'fact' && record.fact) {
    result.subject = clean(record.entity?.name || record.fact.subject_id, 120)
    result.predicate = clean(record.fact.predicate, 100)
  }
  if (record.thread) {
    result.status = clean(record.thread.status, 30)
    result.clock = record.thread.clock
      ? { current: Number(record.thread.clock.current) || 0, max: Number(record.thread.clock.max) || 1, triggered: record.thread.clock.triggered === true }
      : null
  }
  if (record.quest) result.status = clean(record.quest.status, 30)
  if (record.claim) {
    result.truth_status = clean(record.claim.truth_status, 30)
    result.claim_kind = clean(record.claim.kind, 30)
  }
  return result
}

function directorNarrativeMemory(state, playerAction) {
  const records = retrieveWorldMemory(state.worldMemory, { isAdmin: true }, {
    query: directorMemoryQuery(state, playerAction),
    limit: DIRECTOR_MEMORY_RECORD_LIMIT,
    asOfMinutes: state.mechanics?.world_time?.elapsed_minutes,
  }).map(directorMemoryRecord)
  const openThreads = (state.worldMemory?.threads ?? [])
    .filter((thread) => thread.status === 'active')
    .slice(0, DIRECTOR_THREAD_LIMIT)
    .map((thread) => ({
      id: clean(thread.id, 120), title: clean(thread.title, 160), summary: clean(thread.summary, 360),
      clock: thread.clock ? { current: Number(thread.clock.current) || 0, max: Number(thread.clock.max) || 1, triggered: thread.clock.triggered === true } : null,
    }))
  const promiseConsequences = (state.social?.promises ?? [])
    .filter((promise) => promise.status !== 'open')
    .slice(-DIRECTOR_PROMISE_LIMIT)
    .map((promise) => ({
      id: clean(promise.id, 120), npc_id: clean(promise.npc_id, 120), hero_id: clean(promise.hero_id, 120),
      direction: clean(promise.direction, 40), text: clean(promise.text, 300), status: clean(promise.status, 30),
      resolution_reason: clean(promise.resolution_reason, 30), consequence_delta: Number(promise.consequence_delta) || 0,
    }))
  return { retrieved: records, open_threads: openThreads, promise_consequences: promiseConsequences }
}

/** A server-owned progression policy used whenever the model is absent or invalid. */
export function fallbackDirectorIntent(state = {}) {
  const chapterHistory = currentChapterHistory(state)
  const types = new Set(chapterHistory.map((intent) => intent.type))
  const quest = firstActiveQuest(state)
  const npc = firstAvailableNpc(state)
  const encounter = state.mechanics?.encounter
  const outcomes = Array.isArray(state.autonomy?.encounter_outcomes) ? state.autonomy.encounter_outcomes : []
  const outcomeRecorded = encounter?.id && outcomes.some((entry) => entry.encounter_id === encounter.id)

  if (encounter?.status === 'ended' && outcomeRecorded && !types.has('end_scene')) {
    return normalizeDirectorIntent({
      type: 'end_scene',
      destination: `След ${Math.max(2, Number(state.adventure?.chapter || 1) + 1)}`,
      reason: 'Последствия столкновения подтверждены сервером; история переходит к следующей связанной сцене.',
    })
  }
  if (!types.has('continue_exploration')) return normalizeDirectorIntent({ type: 'continue_exploration', reason: 'Сначала отряд исследует текущую сцену.' })
  if (!types.has('open_social_scene') && npc) return normalizeDirectorIntent({ type: 'open_social_scene', npc_id: npc.id, reason: 'Доступный очевидец связывает исследование с квестом.' })
  if (!types.has('advance_quest_clock') && quest) return normalizeDirectorIntent({ type: 'advance_quest_clock', quest_id: quest.id, reason: 'Подтверждённая зацепка продвигает активную цель.' })
  if (Number(state.adventure?.chapter || 1) >= 2 && outcomes.length > 0 && !encounter && !types.has('end_scene')) {
    return normalizeDirectorIntent({
      type: 'end_scene',
      destination: `След ${Number(state.adventure?.chapter || 1) + 1}`,
      reason: 'После обязательного столкновения предыдущей главы подтверждённый прогресс позволяет избежать нового боя.',
    })
  }
  if (!types.has('request_encounter') && !encounter) {
    return normalizeDirectorIntent({ type: 'request_encounter', theme: 'beasts', difficulty: 'medium', reason: 'MVP-политика создаёт полноценное тактическое препятствие для всего отряда.' })
  }
  if (encounter?.status === 'ended' && !types.has('end_scene')) {
    return normalizeDirectorIntent({ type: 'offer_next_hook', hook: clean(state.scene?.objective, 300) || 'Осмыслить последствия столкновения', reason: 'Сервер ещё применяет последствия столкновения.' })
  }
  return normalizeDirectorIntent({ type: 'offer_next_hook', hook: clean(state.scene?.objective, 300) || 'Продолжить расследование', reason: 'Сохраняется доступная сюжетная зацепка.' })
}

function publicDirectorBrief(state = {}, playerAction = '') {
  const arc = campaignArcPosition(state)
  return {
    WORLD_STATE: {
      campaign_premise: campaignConceptForAgent(state),
      scene: {
        title: clean(state.scene?.title, 100), location: clean(state.scene?.location, 160),
        objective: clean(state.scene?.objective, 240), turn: Number(state.scene?.turn) || 0,
      },
      chapter: Math.max(1, Number(state.adventure?.chapter) || 1),
      pacing: {
        phase: clean(state.autonomy?.pacing?.phase, 30) || 'breather',
        tension: Math.max(0, Math.min(100, Number(state.autonomy?.pacing?.tension) || 0)),
        beat: Math.max(0, Number(state.autonomy?.pacing?.beat) || 0),
      },
      ...(arc ? { arc: {
        preset: arc.preset,
        scene_number: arc.scene_number,
        target_scenes: arc.target_scenes,
        scene_beat: arc.scene_beat,
        remaining_beats: arc.remaining_beats,
        phase: arc.phase,
        climax_required: arc.climax,
      } } : {}),
      active_quests: (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'active').slice(0, 12).map((quest) => ({
        id: clean(quest.id, 120), title: clean(quest.title, 160), objectives: (quest.objectives ?? []).map((item) => clean(item, 180)).slice(0, 8),
        clock: quest.clock ? { current: Number(quest.clock.current) || 0, max: Number(quest.clock.max) || 1 } : null,
      })),
      available_npcs: (state.social?.npcs ?? []).filter((npc) => npc.available !== false).slice(0, 12).map((npc) => ({
        id: clean(npc.id, 120), name: clean(npc.name, 120), role: clean(npc.role, 120), location: clean(npc.location, 160),
      })),
      encounter: state.mechanics?.encounter ? { status: clean(state.mechanics.encounter.status, 40), outcome: clean(state.mechanics.encounter.outcome, 80) } : null,
      narrative_memory: directorNarrativeMemory(state, playerAction),
    },
    RECENT_EVENTS: currentChapterHistory(state).slice(-12).map((intent) => ({ type: clean(intent.type, 40), reason: clean(intent.reason, 180) })),
    RECENT_OUTCOMES: (state.autonomy?.director_outcomes ?? []).slice(-12).map((outcome) => ({
      intent_type: clean(outcome.intent_type, 40),
      state_changed: outcome.state_changed === true,
    })),
    PLAYER_ACTION: clean(playerAction, 500) || 'Продолжить приключение',
    UNTRUSTED_DATA: true,
  }
}

export class DirectorAgent {
  constructor({ llmClient = null } = {}) { this.llmClient = llmClient }

  async choose({ state = {}, playerAction = '' } = {}) {
    const fallback = fallbackDirectorIntent(state)
    if (!this.llmClient) return { intent: fallback, trace: { agent: 'DirectorAgent', mode: 'deterministic-fallback', reason: 'LLM is not configured' } }
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ director_brief: publicDirectorBrief(state, playerAction) }) },
        ],
        temperature: 0.25,
        maxTokens: 500,
      })
      return { intent: normalizeDirectorIntent(result), trace: { agent: 'DirectorAgent', mode: 'model', model: this.llmClient.model ?? null } }
    } catch (error) {
      return { intent: fallback, trace: { agent: 'DirectorAgent', mode: 'deterministic-fallback', reason: error instanceof Error ? error.message : 'invalid model response' } }
    }
  }
}
