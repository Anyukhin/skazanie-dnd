import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { normalizeDirectorIntent } from './autonomous-campaign.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/director/v1.txt', import.meta.url)), 'utf8')
const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

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
  return {
    WORLD_STATE: {
      campaign_premise: campaignConceptForAgent(state),
      scene: {
        title: clean(state.scene?.title, 100), location: clean(state.scene?.location, 160),
        objective: clean(state.scene?.objective, 240), turn: Number(state.scene?.turn) || 0,
      },
      chapter: Math.max(1, Number(state.adventure?.chapter) || 1),
      active_quests: (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'active').slice(0, 12).map((quest) => ({
        id: clean(quest.id, 120), title: clean(quest.title, 160), objectives: (quest.objectives ?? []).map((item) => clean(item, 180)).slice(0, 8),
        clock: quest.clock ? { current: Number(quest.clock.current) || 0, max: Number(quest.clock.max) || 1 } : null,
      })),
      available_npcs: (state.social?.npcs ?? []).filter((npc) => npc.available !== false).slice(0, 12).map((npc) => ({
        id: clean(npc.id, 120), name: clean(npc.name, 120), role: clean(npc.role, 120), location: clean(npc.location, 160),
      })),
      encounter: state.mechanics?.encounter ? { status: clean(state.mechanics.encounter.status, 40), outcome: clean(state.mechanics.encounter.outcome, 80) } : null,
    },
    RECENT_EVENTS: currentChapterHistory(state).slice(-12).map((intent) => ({ type: clean(intent.type, 40), reason: clean(intent.reason, 180) })),
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
          { role: 'user', content: JSON.stringify(publicDirectorBrief(state, playerAction)) },
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
