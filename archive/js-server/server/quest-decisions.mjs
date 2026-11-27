import { createHash } from 'node:crypto'
import { PARTY_DECISION_CAPABILITY } from './authoritative-executor.mjs'
import { PartyDecisionError, partyDecisionOpenedEvent } from './party-decision.mjs'
import { campaignModeFor, persistentStoryQuest } from './campaign-stories.mjs'
import { questIsImpossible, questForKnowledge } from './quest-consequences.mjs'

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u

export function questDecisionChronicleEntry(event) {
  if (['QuestInvalidated', 'QuestAssignmentChanged'].includes(event?.event_type) && [1, 2].includes(event.payload?.schema_version)
    && ['public', 'party'].includes(event.visibility)) return {
    id: `quest-consequence:${event.event_id}`, speaker: 'narrator', author: 'Рассказчик', text: String(event.payload.summary || ''), turnConsumed: false,
    ...(event.payload.knowledge_gate ? { knowledge_gate: structuredClone(event.payload.knowledge_gate) } : {}),
  }
  if (event?.event_type === 'QuestAccepted' && event.payload?.schema_version === 1) return {
    id: `quest-accepted:${event.event_id}`, speaker: 'narrator', author: 'Рассказчик', text: String(event.payload.summary || ''), turnConsumed: false,
  }
  if (event?.event_type !== 'QuestResolved' || event.payload?.stay_in_location !== true) return null
  return { id: `quest-resolution:${event.event_id}`, speaker: 'narrator', author: 'Рассказчик',
    text: String(event.payload.summary || ''), turnConsumed: false }
}

function assertRequest({ actorId, questId, idempotencyKey }) {
  if (typeof actorId !== 'string' || !safeId.test(actorId) || typeof questId !== 'string' || !safeId.test(questId)
    || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 160) {
    throw new PartyDecisionError('Нужны герой, задание и ключ запроса', 'INVALID_QUEST_REQUEST')
  }
}

function assertSameRequest(committed, fingerprint) {
  if (!committed?.events?.some((event) => event.event_type === 'PartyDecisionOpened'
    && event.payload?.request_fingerprint === fingerprint)) {
    throw new PartyDecisionError('Ключ уже использован для другого запроса', 'IDEMPOTENCY_CONFLICT')
  }
  return committed
}

/** HTTP передаёт намерение и снимок участников; правила решения живут на сервере. */
export async function requestQuestDecision({
  executor, campaignId, actorId, questId, idempotencyKey, voterSnapshot, now = Date.now(), action = 'abandon',
}) {
  assertRequest({ actorId, questId, idempotencyKey })
  if (!['abandon', 'accept'].includes(action)) throw new PartyDecisionError('Неизвестное решение по заданию', 'INVALID_QUEST_REQUEST')
  const acceptance = action === 'accept'
  const fingerprint = createHash('sha256').update(JSON.stringify([acceptance ? 'quest-acceptance/v1' : 'quest-abandonment/v1', campaignId, actorId, questId])).digest('hex')
  const previous = await executor.eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
  if (previous) return assertSameRequest(previous, fingerprint)
  const interactionId = `quest-${createHash('sha256').update(`${campaignId}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`
  const committed = await executor.commitDerived({
    campaignId, idempotencyKey, producerCapability: PARTY_DECISION_CAPABILITY,
    deriveEvents: (state) => {
      const status = state.mechanics?.campaign_lifecycle?.status
      if (status !== 'active') throw new PartyDecisionError('Кампания сейчас недоступна для действий', 'CAMPAIGN_NOT_ACTIVE')
      if (state.mechanics?.combat?.active) throw new PartyDecisionError('Дождитесь окончания боя', 'QUEST_DECISION_DURING_COMBAT')
      const members = state.partyMemberIds?.length ? state.partyMemberIds : (state.players ?? []).map((hero) => hero.id)
      const actor = state.players?.find((hero) => hero.id === actorId)
      if (!members.includes(actorId) || !actor) throw new PartyDecisionError('Герой не входит в отряд', 'ACTOR_FORBIDDEN')
      if (actor.characterSetupRequired || state.mechanics?.death?.heroes?.[actorId]?.status === 'dead') {
        throw new PartyDecisionError('Этот герой пока не может действовать', 'ACTOR_UNAVAILABLE')
      }
      const quest = state.worldMemory?.quests?.find((entry) => entry.id === questId
        && entry.status !== 'hidden' && ['public', 'party'].includes(entry.visibility))
      if (!quest) throw new PartyDecisionError('Задание недоступно отряду', 'WORLD_QUEST_NOT_FOUND')
      const knownQuest = questForKnowledge(quest, state.worldMemory, { playerId: actorId, isPartyMember: true })
      if (knownQuest.status !== quest.status || knownQuest.giver_npc_id !== quest.giver_npc_id) {
        throw new PartyDecisionError('Сейчас решение по этому поручению недоступно. Уточните его условия в мире.', 'QUEST_DECISION_UNAVAILABLE')
      }
      if (acceptance && questIsImpossible(state, quest)) throw new PartyDecisionError('Необходимый для поручения NPC погиб', 'WORLD_QUEST_IMPOSSIBLE')
      if (quest.id.startsWith('quest:chapter:')) throw new PartyDecisionError('Это цель текущей сцены, а не отдельное поручение', 'WORLD_QUEST_NOT_ABANDONABLE')
      if (!(acceptance ? ['offered', 'active'] : ['active']).includes(quest.status)) throw new PartyDecisionError('Это задание нельзя сейчас изменить', 'WORLD_QUEST_CLOSED')
      if (acceptance && quest.status === 'active'
        && (campaignModeFor(state) !== 'persistent' || persistentStoryQuest(state))) {
        throw new PartyDecisionError('Задание уже принято; основная история пока занята', 'WORLD_QUEST_ALREADY_ACCEPTED')
      }
      if (state.agentInteraction) throw new PartyDecisionError('Сначала завершите текущее решение отряда', 'PARTY_DECISION_CONFLICT')
      const opened = partyDecisionOpenedEvent({
        id: interactionId, type: 'vote', createdAt: now,
        title: acceptance ? quest.status === 'active' ? 'Выбрать основную историю?' : 'Принять задание?' : 'Отказаться от задания?',
        description: acceptance ? `Отряд ${quest.status === 'active' ? 'выбирает основной историей' : 'принимает'} задание «${quest.title}». Место и время не меняются.` : `Задание «${quest.title}» будет оставлено. Отряд останется в текущей локации.`,
        // При истечении без голосов сохраняем задание по общей политике стола.
        options: acceptance ? [{ id: 'later', label: 'Решить позже' }, { id: 'accept', label: quest.status === 'active' ? 'Выбрать основной историей' : 'Принять задание' }]
          : [{ id: 'keep', label: 'Продолжить задание' }, { id: 'abandon', label: 'Отказаться от задания' }],
        ...(acceptance ? { questAcceptance: { schemaVersion: 1, questId } } : { questAbandonment: { schemaVersion: 1, questId } }),
      }, actorId, { ...voterSnapshot(state), policy: state.partyDecisionPolicy })
      opened.payload.request_fingerprint = fingerprint
      return [opened]
    },
  })
  // Проверяем также результат гонки: исполнитель может вернуть чужой commit с тем же ключом.
  return assertSameRequest(committed, fingerprint)
}

/** Сохранённое решение само служит возобновляемой работой после сбоя. */
export async function finishQuestDecision({ executor, campaignId, state }) {
  const current = state ?? (await executor.eventStore.load(campaignId)).state
  const interaction = current.agentInteraction
  if ((!interaction?.questAbandonment && !interaction?.questAcceptance) || interaction.status !== 'resolved'
    || current.mechanics?.campaign_lifecycle?.status !== 'active') return null
  const key = `quest-decision:${interaction.id}`
  try {
    const result = await executor.executeCommands({
      campaignId, idempotencyKey: key, context: { isDirector: true },
      commands: [{ command_type: 'ResolveQuestDecision', interaction_id: interaction.id,
        house_rule_id: 'skazanie:quest-decision:v1' }],
    })
    if (!result.events?.some((event) => event.event_type === 'PartyDecisionConsumed'
      && event.payload?.interaction_id === interaction.id)) {
      throw new PartyDecisionError('Ключ исполнения уже занят', 'IDEMPOTENCY_CONFLICT')
    }
    return result
  } catch (error) {
    if (error?.code === 'PARTY_DECISION_REQUIRED') {
      const previous = await executor.eventStore.getByIdempotencyKey(campaignId, key)
      if (previous?.events?.some((event) => event.event_type === 'PartyDecisionConsumed'
        && event.payload?.interaction_id === interaction.id)) return previous
    }
    throw error
  }
}
