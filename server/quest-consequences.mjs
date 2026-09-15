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
  return state.world_offices?.offices?.find((office) => office.id === responsibility?.office_id)?.holder_npc_id || null
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
  return {
    event_type: 'QuestInvalidated', visibility: quest.visibility, target_ids: [],
    payload: {
      schema_version: 1, quest_id: quest.id, outcome: 'failure', reason: 'required_npc_dead', npc_id: npcId,
      summary: `Поручение «${quest.title}» стало невыполнимым: ${npcName} погиб.`,
      source_event_ids: deathEvent?.event_id ? [deathEvent.event_id] : [...fact.source_event_ids],
      updates_scene_objective: quest.id === primaryQuestId,
      next_objective: 'Выбрать дальнейшее занятие в текущей локации',
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
        payload: { schema_version: 1, quest_id: quest.id, office_id: responsibility.office_id, giver_npc_id: giverId,
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
