import { createHash } from 'node:crypto'
import { knowledgeGateForEvent } from './quest-consequences.mjs'

export const CAMPAIGN_MODES = Object.freeze(['adventure', 'persistent'])
export const PERSISTENT_WORLD_OBJECTIVE = 'Исследовать мир или выбрать собственную цель'

export function validateCampaignMode(value = 'adventure') {
  if (!CAMPAIGN_MODES.includes(value)) {
    const error = new Error('Выберите режим «Приключение» или «Постоянный мир»')
    error.code = 'INVALID_CAMPAIGN_MODE'
    throw error
  }
  return value
}

/** Отсутствующее поле сохраняет политику старых кампаний. */
export function campaignModeFor(state = {}) {
  return state.campaignConcept?.campaign_mode === 'persistent' ? 'persistent' : 'adventure'
}

/** Основная история берётся из уже принятых задач; новые здесь не создаются. */
export function persistentStoryQuest(state = {}) {
  const active = (state.worldMemory?.quests ?? []).filter((quest) => quest.status === 'active'
    && ['public', 'party'].includes(quest.visibility)
    && !String(quest.id).startsWith('quest:chapter:'))
  const selected = state.campaignConcept?.story_quest_id
  // Отсутствующее поле инициализируется один раз при нормализации; null означает,
  // что отряд ещё не принял задачу для следующей истории.
  return selected === undefined ? active[0] ?? null : active.find((quest) => quest.id === selected) ?? null
}

/** Завершение истории входит в тот же атомарный пакет, что и исход её задачи. */
export function campaignStoryCompletionDraft(state, events) {
  if (campaignModeFor(state) !== 'persistent') return null
  const quest = persistentStoryQuest(state)
  const resolution = quest && events.find((event) => ['QuestResolved', 'QuestInvalidated'].includes(event.event_type)
    && event.payload?.quest_id === quest.id && ['success', 'failure', 'abandoned'].includes(event.payload.outcome))
  if (!resolution) return null
  const previous = state.campaignConcept?.story_sequence ?? 0
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
    const error = new Error('Номер истории нельзя безопасно увеличить')
    error.code = 'CAMPAIGN_STORY_SEQUENCE_INVALID'
    throw error
  }
  const sequence = previous + 1
  const campaign = createHash('sha256').update(String(state.sessionCode)).digest('hex').slice(0, 16)
  return {
    event_type: 'CampaignStoryCompleted', visibility: 'party', target_ids: [],
    payload: {
      schema_version: resolution.payload.knowledge_gate ? 2 : 1,
      ...(resolution.payload.knowledge_gate ? {
        knowledge_gate: knowledgeGateForEvent(state, resolution),
        source_event_ids: [resolution.event_id].filter(Boolean),
        dependency_id: resolution.payload.dependency_id,
        policy_id: resolution.payload.policy_id,
        previous_view: {
          story_quest_id: quest.id, location_id: String(state.scene?.location_id || ''),
          objective: state.scene?.objective || '', current_hook: state.adventure?.currentHook || '',
          replaced_objective: PERSISTENT_WORLD_OBJECTIVE,
          suggestions: structuredClone(state.suggestions ?? []),
        },
      } : {}),
      story_id: `story:${campaign}:${sequence}`, story_number: sequence,
      quest_id: quest.id, title: String(quest.title).slice(0, 180),
      outcome: resolution.payload.outcome,
      summary: String(resolution.payload.summary || '').slice(0, 1_000),
      location_id: String(state.scene?.location_id || ''),
      location: String(state.scene?.location || '').slice(0, 180),
      elapsed_minutes: Math.max(0, Number(state.mechanics?.world_time?.elapsed_minutes) || 0),
    },
  }
}

export function campaignStoryChronicleEntry(event) {
  if (event?.event_type !== 'CampaignStoryCompleted' || ![1, 2].includes(event.payload?.schema_version)) return null
  return {
    id: `story-completed:${event.payload.story_id}`, speaker: 'narrator', author: 'Рассказчик',
    text: `История «${event.payload.title}» завершена. ${event.payload.summary} Мир остаётся открытым для ваших действий.`,
    turnConsumed: false,
    ...(event.payload.knowledge_gate ? { knowledge_gate: structuredClone(event.payload.knowledge_gate) } : {}),
  }
}
