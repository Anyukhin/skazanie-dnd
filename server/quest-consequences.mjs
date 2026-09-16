export const QUEST_CONSEQUENCE_POLICY_ID = 'skazanie:quest-consequences-v2'

/** Граница осведомлённости следует за причиной, а не публичностью задания. */
export function knowledgeGateForEvent(state, event = {}) {
  if (event.payload?.knowledge_gate) return structuredClone(event.payload.knowledge_gate)
  const sourceIds = [event.event_id, event.payload?.source_event_id, ...(event.payload?.source_event_ids ?? [])].filter(Boolean)
  const requiredFact = event.event_type === 'NpcDied' ? { subject_id: event.payload?.npc_id, predicate: 'died' } : null
  return {
    visibility: event.visibility || 'gm_only',
    recorded_at_minutes: Math.max(0, Number(state.mechanics?.world_time?.elapsed_minutes) || 0),
    player_ids: [...new Set([...(event.player_ids ?? []), ...(event.target_ids ?? []), event.actor_id].filter(Boolean))],
    source_event_ids: sourceIds,
    ...(requiredFact ? { required_fact: requiredFact } : {}),
    fact_ids: (state.worldMemory?.facts ?? []).filter((fact) => (!requiredFact || fact.subject_id === requiredFact.subject_id && fact.predicate === requiredFact.predicate)
      && (fact.source_event_ids ?? []).some((id) => sourceIds.includes(id))).map((fact) => fact.id),
  }
}

/** Получение знания открывает проекцию, не запускает механическое последствие снова. */
export function knowledgeGateVisible(gate, memory = {}, viewer = {}) {
  if (!gate || viewer.isAdmin || viewer.role === 'admin') return true
  const requested = viewer.asOfMinutes ?? viewer.as_of_minutes
  const maximum = requested == null ? Infinity : Number(requested)
  if (Number(gate.recorded_at_minutes || 0) > maximum) return false
  if (gate.visibility === 'public' || gate.visibility === 'party' && viewer.isPartyMember !== false) return true
  const playerId = String(viewer.playerId || '')
  if (gate.visibility === 'specific_player' && playerId && gate.player_ids?.includes(playerId)) return true
  const known = new Set((memory.knowledge_ledger ?? memory.knowledge_revealed ?? []).filter((entry) => entry.hero_id === playerId && Number(entry.recorded_at_minutes || 0) <= maximum).map((entry) => entry.fact_id))
  for (const fact of memory.facts ?? []) {
    if (Number(fact.recorded_at_minutes || 0) > maximum) continue
    if (gate.required_fact && (fact.subject_id !== gate.required_fact.subject_id || fact.predicate !== gate.required_fact.predicate)) continue
    if (!gate.fact_ids?.includes(fact.id) && !(fact.source_event_ids ?? []).some((id) => gate.source_event_ids?.includes(id))) continue
    if (known.has(fact.id) || fact.visibility === 'public' || fact.visibility === 'party' && viewer.isPartyMember !== false) return true
  }
  return false
}

/** История содержит только прежнее представление записи, без второй копии механики. */
export function normalizeQuestKnowledgeHistory(value) {
  return (Array.isArray(value) ? value : []).filter((entry) => entry?.schema_version === 1 && entry.event_id && entry.previous && entry.knowledge_gate).map((entry) => structuredClone(entry))
}

export function recordQuestKnowledge(record, event) {
  const history = normalizeQuestKnowledgeHistory(record.knowledge_history)
  if (!history.length && (event.payload?.schema_version !== 2 || !event.payload.knowledge_gate)) return record
  const eventId = event.event_id || `${event.command_id || event.payload.source_event_ids?.join(':') || history.length}:${event.event_type}:${event.payload.quest_id || event.payload.quest?.id || record.id}`
  if (history.some((entry) => entry.event_id === eventId)) return record
  const fields = {
    QuestAssignmentChanged: ['giver_npc_id'], QuestInvalidated: ['status', 'summary'], QuestResolved: ['status', 'summary'],
    QuestClockAdvanced: ['clock'], QuestAccepted: ['status'],
    QuestUpserted: ['title', 'status', 'summary', 'giver_npc_id', 'clock', 'recorded_at_minutes', 'visibility', 'entity_ids', 'objectives', 'responsibility'],
  }[event.event_type]
  if (!fields) return record
  const previous = Object.fromEntries(fields
    .filter((key) => Object.hasOwn(record, key)).map((key) => [key, structuredClone(record[key])]))
  return { ...record, knowledge_history: [...history, { schema_version: 1, event_id: eventId, previous,
    absent_fields: fields.filter((key) => !Object.hasOwn(record, key)),
    knowledge_gate: structuredClone(event.payload.knowledge_gate ?? knowledgeGateForEvent({}, { ...event, visibility: event.visibility ?? 'public' })),
    ...(event.payload.previous_view ? { previous_view: structuredClone(event.payload.previous_view) } : {}),
  }] }
}

export function questForKnowledge(record, memory, viewer) {
  const { knowledge_history: history = [], ...visible } = record
  const knownFields = new Set()
  for (const entry of [...history].reverse()) {
    const known = knowledgeGateVisible(entry.knowledge_gate, memory, viewer)
    for (const [key, value] of Object.entries(entry.previous)) {
      if (known) knownFields.add(key)
      else if (!knownFields.has(key)) visible[key] = structuredClone(value)
    }
    for (const key of entry.absent_fields ?? []) {
      if (known) knownFields.add(key)
      else if (!knownFields.has(key)) delete visible[key]
    }
  }
  return visible
}

/**
 * Представление для читателей. Команды всегда исполняются по исходному state.
 * @param {Record<string, any>} state
 * @param {Record<string, any>} viewer
 * @returns {Record<string, any>}
 */
export function questStateForViewer(state = {}, viewer = {}) {
  if (viewer.isAdmin || viewer.role === 'admin') return state
  const memory = state.worldMemory ?? {}
  const concept = state.campaignConcept ?? {}
  const history = concept.story_history ?? []
  const hiddenStories = history.filter((story) => !knowledgeGateVisible(story.knowledge_gate, memory, viewer))
  let hiddenBefore = 0
  const visibleHistory = history.flatMap(({ knowledge_gate, previous_view, source_event_ids, dependency_id, policy_id, ...story }) => {
    if (!knowledgeGateVisible(knowledge_gate, memory, viewer)) { hiddenBefore += 1; return [] }
    return [{ ...story, ...(hiddenBefore ? { story_number: Math.max(1, story.story_number - hiddenBefore) } : {}) }]
  })
  const result = {
    ...state,
    worldMemory: { ...memory, quests: (memory.quests ?? []).map((quest) => questForKnowledge(quest, memory, viewer)) },
    ...(state.campaignConcept ? { campaignConcept: { ...concept, ...(Array.isArray(concept.story_history) ? { story_history: visibleHistory } : {}),
      ...(hiddenStories.length ? { story_sequence: Math.max(0, Number(concept.story_sequence || 0) - hiddenStories.length) } : {}),
    } } : {}),
    ...(state.messages ? { messages: state.messages.filter((entry) => knowledgeGateVisible(entry.knowledge_gate, memory, viewer))
      .map(({ knowledge_gate, ...entry }) => entry) } : {}),
  }
  const restoreObjective = (before) => {
    if (!before || state.scene?.location_id !== before.location_id || result.scene?.objective !== before.replaced_objective) return
    result.scene = { ...result.scene, objective: before.objective }
    result.adventure = { ...result.adventure, currentHook: before.current_hook }
    result.suggestions = structuredClone(before.suggestions ?? [])
  }
  for (const story of [...history].reverse()) {
    if (knowledgeGateVisible(story.knowledge_gate, memory, viewer)) break
    const before = story.previous_view
    if (!before) continue
    if (result.campaignConcept.story_quest_id == null) result.campaignConcept.story_quest_id = before.story_quest_id
    restoreObjective(before)
  }
  for (const quest of memory.quests ?? []) {
    if (history.some((story) => story.quest_id === quest.id)) continue
    for (const entry of [...(quest.knowledge_history ?? [])].reverse()) {
      if (knowledgeGateVisible(entry.knowledge_gate, memory, viewer)) break
      restoreObjective(entry.previous_view)
    }
  }
  return result
}

/** Причина невозможности поручения задаётся явно, а не выводится из entity_ids. */
export function normalizeQuestResponsibility(value) {
  if (!value || (value.schema_version != null && value.schema_version !== 1)) return null
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id)
  if (value.type === 'npc' && value.death_policy === 'impossible' && validId(value.npc_id)) {
    return { schema_version: 1, type: 'npc', npc_id: value.npc_id, death_policy: 'impossible' }
  }
  if (value.type === 'office' && value.death_policy === 'transfer' && validId(value.office_id)) {
    return { schema_version: 1, type: 'office', office_id: value.office_id, death_policy: 'transfer' }
  }
  return null
}

export function questGiverId(state, responsibility) {
  if (responsibility?.type === 'npc') return responsibility.npc_id
  const office = state.world_offices?.offices?.find((office) => office.id === responsibility?.office_id)
  const id = office?.holder_npc_id
  const npc = state.social?.npcs?.find((entry) => entry.id === id)
  if (!id || !npc || npc.available === false || state.npc_world?.vitals?.[id]?.alive === false
    || state.npc_world?.stances?.[id]?.stance === 'dead') return null
  return id
}

export function questIsImpossible(state, quest) {
  const responsibility = normalizeQuestResponsibility(quest?.responsibility)
  return responsibility?.type === 'npc' && (state.npc_world?.vitals?.[responsibility.npc_id]?.alive === false
    || state.npc_world?.stances?.[responsibility.npc_id]?.stance === 'dead')
}

/** Только сохранённая смерть, без заполнения часов и без придуманного итога LLM. */
export function questInvalidationDraft(state, quest, { primaryQuestId = null, deathEvent = null } = {}) {
  if (!['active', 'offered'].includes(quest?.status) || !questIsImpossible(state, quest)) return null
  const npcId = quest.responsibility.npc_id
  const fact = state.worldMemory?.facts?.find((entry) => entry.subject_id === npcId
    && entry.predicate === 'died' && entry.status === 'active' && entry.source_event_ids?.length)
  if (!fact && !(deathEvent?.event_type === 'NpcDied' && deathEvent.payload?.npc_id === npcId)) return null
  const npcName = state.social?.npcs?.find((npc) => npc.id === npcId)?.name || npcId
  const cause = deathEvent ?? { event_type: 'NpcDied', payload: { npc_id: npcId }, visibility: fact.visibility, event_id: fact.source_event_ids[0] }
  const nextObjective = 'Выбрать дальнейшее занятие в текущей локации'
  return {
    event_type: 'QuestInvalidated', visibility: quest.visibility, target_ids: [],
    payload: {
      schema_version: 2, policy_id: QUEST_CONSEQUENCE_POLICY_ID, dependency_id: `${quest.id}:npc:${npcId}`,
      knowledge_gate: knowledgeGateForEvent(state, cause),
      ...(quest.id === primaryQuestId ? { previous_view: {
        location_id: String(state.scene?.location_id || ''), objective: state.scene?.objective || '',
        current_hook: state.adventure?.currentHook || '', suggestions: structuredClone(state.suggestions ?? []),
        replaced_objective: nextObjective,
      } } : {}),
      quest_id: quest.id, outcome: 'failure', reason: 'required_npc_dead', npc_id: npcId,
      summary: `Поручение «${quest.title}» стало невыполнимым: ${npcName} погиб.`,
      source_event_ids: deathEvent?.event_id ? [deathEvent.event_id] : [...fact.source_event_ids],
      updates_scene_objective: quest.id === primaryQuestId,
      next_objective: nextObjective,
    },
  }
}

/** Вызывается один раз после фиксации смертей и смены держателей должностей. */
export function planQuestConsequenceDrafts(state, events, { primaryQuestId = null } = {}) {
  const deaths = new Map(events.filter((event) => event.event_type === 'NpcDied').map((event) => [event.payload.npc_id, event]))
  const offices = new Map(events.filter((event) => ['OfficeVacated', 'OfficeHolderInstalled'].includes(event.event_type))
    .map((event) => [event.payload.office_id, event]))
  const result = []
  for (const quest of state.worldMemory?.quests ?? []) {
    if (!['active', 'offered'].includes(quest.status)) continue
    const responsibility = normalizeQuestResponsibility(quest.responsibility)
    if (responsibility?.type === 'npc' && deaths.has(responsibility.npc_id)) {
      const draft = questInvalidationDraft(state, quest, { primaryQuestId, deathEvent: deaths.get(responsibility.npc_id) })
      if (draft) result.push(draft)
    }
    if (responsibility?.type === 'office' && offices.has(responsibility.office_id)) {
      const giverId = questGiverId(state, responsibility)
      if ((quest.giver_npc_id || null) === giverId) continue
      const office = state.world_offices.offices.find((entry) => entry.id === responsibility.office_id)
      const name = state.social?.npcs?.find((npc) => npc.id === giverId)?.name || giverId
      result.push({
        event_type: 'QuestAssignmentChanged', visibility: quest.visibility, target_ids: [],
        payload: { schema_version: 2, policy_id: QUEST_CONSEQUENCE_POLICY_ID, dependency_id: `${quest.id}:office:${responsibility.office_id}`,
          knowledge_gate: knowledgeGateForEvent(state, offices.get(responsibility.office_id)),
          quest_id: quest.id, office_id: responsibility.office_id, giver_npc_id: giverId,
          reason: giverId ? 'office_holder_changed' : 'office_vacant',
          source_event_ids: [offices.get(responsibility.office_id).event_id].filter(Boolean),
          summary: giverId ? `По поручению «${quest.title}» теперь принимает ${name} (${office.title}).`
            : `Поручение «${quest.title}» сохраняется; должность «${office.title}» пока свободна.`,
        },
      })
    }
  }
  return result
}
