// Эталоны `server/quest-consequences.mjs` и `server/campaign-stories.mjs` для
// sk-society: `node gen-quest-consequences.mjs`.
//
// Две части. Настоящие сценарии из `test/quest-consequence-knowledge.test.mjs`
// на дворце Асстохана (`palaceFixture`): тайная смерть короля, раскрытие факта,
// публичный шум, позднейшая история, скрытая смена получателя поручения,
// смена держателя должности. И случайные границы знания, поручения, истории и
// читатели с мусором — для каждой экспортируемой функции.
import { JUNK, collector, plain, rng, server, write } from './lib.mjs'

const quests = await import(server('quest-consequences'))
const stories = await import(server('campaign-stories'))
const engine = await import(server('rules-engine'))
const memoryModule = await import(server('world-memory'))
const { palaceFixture } = await import(new URL('../../../../test/shared-npc-consequence-fixture.mjs', import.meta.url).href)

const random = rng(9001)
const q = collector()
const s = collector()

// ---------------------------------------------------------------------------
// Дворец: только то, что читают оба модуля
// ---------------------------------------------------------------------------

function trim(state) {
  const concept = state.campaignConcept ?? {}
  return plain({
    sessionCode: state.sessionCode,
    partyMemberIds: state.partyMemberIds,
    campaignConcept: {
      campaign_mode: concept.campaign_mode,
      story_sequence: concept.story_sequence,
      story_history: concept.story_history,
      story_quest_id: concept.story_quest_id,
      current_arc_number: concept.current_arc_number,
    },
    worldMemory: {
      facts: state.worldMemory?.facts,
      quests: state.worldMemory?.quests,
      knowledge_ledger: state.worldMemory?.knowledge_ledger,
      knowledge_revealed: state.worldMemory?.knowledge_revealed,
    },
    scene: { title: state.scene?.title, location: state.scene?.location, location_id: state.scene?.location_id, objective: state.scene?.objective },
    adventure: { currentHook: state.adventure?.currentHook, objective: state.adventure?.objective, chapter: state.adventure?.chapter },
    suggestions: state.suggestions,
    messages: state.messages?.slice(-3),
    mechanics: { world_time: state.mechanics?.world_time },
    world_offices: state.world_offices,
    social: { npcs: (state.social?.npcs ?? []).map((npc) => ({ id: npc.id, name: npc.name, available: npc.available })) },
    npc_world: { vitals: state.npc_world?.vitals, stances: state.npc_world?.stances },
  })
}

function viewers(heroId) {
  return [
    { role: 'player', playerId: heroId, partyIds: [heroId], isPartyMember: true },
    { role: 'player', playerId: 'another-hero', partyIds: [heroId], isPartyMember: true },
    { isPartyMember: true },
    { role: 'admin', playerId: heroId },
    { playerId: heroId, isPartyMember: false },
    { playerId: heroId, isPartyMember: true, asOfMinutes: 0 },
  ]
}

function project(state, heroId) {
  const trimmed = trim(state)
  for (const viewer of viewers(heroId)) q.call('questStateForViewer', quests.questStateForViewer, [trimmed, viewer])
  for (const quest of trimmed.worldMemory.quests ?? []) {
    q.call('questIsImpossible', quests.questIsImpossible, [trimmed, quest])
    q.call('normalizeQuestResponsibility', quests.normalizeQuestResponsibility, [quest.responsibility])
    q.call('questGiverId', quests.questGiverId, [trimmed, quest.responsibility])
    q.call('questInvalidationDraft', quests.questInvalidationDraft, [trimmed, quest, { primaryQuestId: quest.id }])
    for (const viewer of viewers(heroId).slice(0, 3)) q.call('questForKnowledge', quests.questForKnowledge, [quest, trimmed.worldMemory, viewer])
  }
  s.call('campaignModeFor', stories.campaignModeFor, [trimmed])
  s.call('persistentStoryQuest', stories.persistentStoryQuest, [trimmed])
  return trimmed
}

async function concealedDeath() {
  const { state, heroId, kingId } = await palaceFixture()
  const quest = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'npc')
  state.campaignConcept.story_quest_id = quest.id
  state.scene.objective = quest.title
  state.adventure.currentHook = quest.title
  const events = [
    { event_type: 'NpcDied', event_id: 'hidden-death', visibility: 'gm_only', payload: { npc_id: kingId } },
    { event_type: 'WorldFactRecorded', event_id: 'hidden-death-fact', visibility: 'gm_only', payload: { fact: {
      id: 'fact:hidden-death', subject_id: kingId, predicate: 'died', object: 'дворец', summary: 'Король погиб тайно',
      visibility: 'gm_only', status: 'active', source_event_ids: ['hidden-death'],
    } } },
  ]
  let after = engine.replayEvents(state, events)
  const trimmedAfter = project(after, heroId)
  for (const event of events) q.call('knowledgeGateForEvent', quests.knowledgeGateForEvent, [trimmedAfter, event])
  const consequences = q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [trimmedAfter, events, { primaryQuestId: quest.id }])
    .map((event, index) => ({ ...event, event_id: `hidden-consequence-${index}` }))
  q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [trimmedAfter, events, {}])
  q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [trimmedAfter, events])
  events.push(...consequences)
  for (const event of consequences) {
    for (const record of trimmedAfter.worldMemory.quests) q.call('recordQuestKnowledge', quests.recordQuestKnowledge, [record, event])
  }
  const story = s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [trim(state), events], { expectThrow: true })
  events.push({ ...story, event_id: 'hidden-story' })
  after = engine.replayEvents(state, events)
  s.call('campaignStoryChronicleEntry', stories.campaignStoryChronicleEntry, [events.at(-1)])
  after.messages = [stories.campaignStoryChronicleEntry(events.at(-1))].filter(Boolean)
  project(after, heroId)
  return { state, after, events, heroId, quest }
}

{
  const { after, heroId, quest } = await concealedDeath()
  const disclosed = engine.applyGameEvent(after, { event_type: 'KnowledgeRevealed', event_id: 'learn-death', target_ids: [heroId], visibility: 'specific_player', payload: { fact_id: 'fact:hidden-death' } })
  project(disclosed, heroId)
  const noise = engine.applyGameEvent(after, { event_type: 'WorldFactRecorded', event_id: 'heard-noise', visibility: 'party', payload: { fact: {
    id: 'fact:noise', subject_id: quest.responsibility.npc_id, predicate: 'noise', object: 'шум во дворце', summary: 'Во дворце слышали шум.', status: 'active', visibility: 'party', source_event_ids: ['hidden-death'],
  } } })
  project(noise, heroId)
  const publicStory = { event_type: 'CampaignStoryCompleted', visibility: 'party', payload: {
    schema_version: 1, story_id: 'another-story', story_number: 2, quest_id: 'another-quest', title: 'Новый путь', outcome: 'success', summary: 'Путь пройден.',
  } }
  s.call('campaignStoryChronicleEntry', stories.campaignStoryChronicleEntry, [publicStory])
  project(engine.applyGameEvent(after, publicStory), heroId)
}

// Видимая смерть: последствие и история без тайны.
{
  const { state, heroId, kingId } = await palaceFixture()
  const quest = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'npc')
  const events = [
    { event_type: 'NpcDied', event_id: 'open-death', visibility: 'party', actor_id: heroId, target_ids: [kingId], payload: { npc_id: kingId } },
    { event_type: 'WorldFactRecorded', event_id: 'open-death-fact', visibility: 'party', payload: { fact: {
      id: 'fact:open-death', subject_id: kingId, predicate: 'died', object: 'дворец', summary: 'Король погиб', visibility: 'party', status: 'active', source_event_ids: ['open-death'],
    } } },
  ]
  const after = engine.replayEvents(state, events)
  const trimmedAfter = project(after, heroId)
  const drafts = q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [trimmedAfter, events, { primaryQuestId: quest.id }])
  q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [trimmedAfter, events.slice(1), { primaryQuestId: quest.id }])
  // Без события смерти — только по сохранённому факту.
  q.call('questInvalidationDraft', quests.questInvalidationDraft, [trimmedAfter, quest, { primaryQuestId: quest.id }])
  q.call('questInvalidationDraft', quests.questInvalidationDraft, [trimmedAfter, quest, { deathEvent: events[0] }])
  const withDrafts = [...events, ...drafts.map((event, index) => ({ ...event, event_id: `open-consequence-${index}` }))]
  s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [trim(state), withDrafts], { expectThrow: true })
  s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [{ ...trim(state), campaignConcept: { ...trim(state).campaignConcept, story_sequence: -1 } }, withDrafts], { expectThrow: true })
  s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [{ ...trim(state), campaignConcept: { ...trim(state).campaignConcept, story_sequence: '2' } }, withDrafts], { expectThrow: true })
  s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [{ ...trim(state), campaignConcept: { ...trim(state).campaignConcept, story_sequence: 2 ** 53 - 1 } }, withDrafts], { expectThrow: true })
  project(engine.replayEvents(state, withDrafts), heroId)
}

// Должность: новый держатель и свободное место.
{
  const { state, heroId } = await palaceFixture()
  const office = state.world_offices.offices[0]
  for (const holder of ['astohan-ivara', null, 'astohan-oren', 'missing-npc']) {
    const changed = trim(state)
    changed.world_offices.offices[0] = { ...changed.world_offices.offices[0], holder_npc_id: holder }
    for (const type of ['OfficeHolderInstalled', 'OfficeVacated']) {
      const events = [{ event_type: type, event_id: `office-${type}-${holder}`, visibility: random.pick(['party', 'gm_only']), payload: { office_id: office.id } }]
      q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [changed, events, { primaryQuestId: 'quest:astohan-crown-report' }])
    }
    q.call('questGiverId', quests.questGiverId, [changed, { type: 'office', office_id: office.id }])
  }
  // Скрытая смена получателя и последующий известный прогресс.
  const quest = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'office')
  const steps = [
    { event_type: 'QuestAssignmentChanged', event_id: 'secret-assignment', visibility: 'party', payload: {
      schema_version: 2, quest_id: quest.id, giver_npc_id: 'secret-recipient', knowledge_gate: { visibility: 'gm_only', fact_ids: [], source_event_ids: [] },
    } },
    { event_type: 'QuestClockAdvanced', event_id: 'public-progress', visibility: 'party', payload: { quest_id: quest.id, amount: 1 } },
    { event_type: 'QuestResolved', event_id: 'public-resolution', visibility: 'party', payload: { quest_id: quest.id, outcome: 'success', summary: 'Поручение исполнено.' } },
  ]
  let memory = state.worldMemory
  for (const event of steps) {
    const record = memory.quests.find((entry) => entry.id === quest.id)
    q.call('recordQuestKnowledge', quests.recordQuestKnowledge, [record, event])
    memory = memoryModule.applyWorldMemoryEvent(memory, event)
    const updated = memory.quests.find((entry) => entry.id === quest.id)
    for (const viewer of viewers(heroId).slice(0, 3)) q.call('questForKnowledge', quests.questForKnowledge, [updated, { facts: memory.facts, knowledge_ledger: memory.knowledge_ledger }, viewer])
  }
}

// ---------------------------------------------------------------------------
// Случайные границы, поручения, истории и читатели
// ---------------------------------------------------------------------------

const EVENT_IDS = ['e1', 'e2', 'e3', 'hidden', '', null, undefined, 7, 0]
const NPC_IDS = ['king', 'ivara', 'oren', 'ghost', '', null, undefined, 5]
const VISIBILITY = ['public', 'party', 'gm_only', 'specific_player', '', null, undefined, 3]
const MINUTES = [undefined, null, 0, 10, 60, 600, -5, '30', 'abc', 1.5, true]
const HERO = ['hero', 'mate', '', null, undefined, 4]

const maybe = (value, p = 0.7) => (random.chance(p) ? value : undefined)

function sourceIds() {
  return random.pick([[random.pick(EVENT_IDS)], [random.pick(EVENT_IDS), random.pick(EVENT_IDS)], [], undefined, 'e1', null, [null, 'e2']])
}

function fact() {
  if (random.chance(0.05)) return random.pick(['x', 3, {}])
  return {
    id: random.pick(['f1', 'f2', 'f3', 'fact:x', null, undefined, 9]),
    subject_id: random.pick(NPC_IDS),
    predicate: random.pick(['died', 'noise', 'discovery', undefined]),
    status: random.pick(['active', 'retracted', undefined]),
    source_event_ids: sourceIds(),
    visibility: random.pick(VISIBILITY),
    recorded_at_minutes: random.pick(MINUTES),
  }
}

function gate() {
  if (random.chance(0.12)) return random.pick([undefined, null, '', 0, true, 'gate', [], {}])
  const result = {
    visibility: random.pick(VISIBILITY),
    recorded_at_minutes: random.pick(MINUTES),
    player_ids: random.pick([['hero'], ['mate', 'hero'], [], undefined, 'hero', 'heroic', [4]]),
    source_event_ids: sourceIds(),
    fact_ids: random.pick([['f1'], ['f2', 'f3'], [], undefined, 'f1', [null]]),
  }
  if (random.chance(0.3)) result.required_fact = random.pick([{ subject_id: random.pick(NPC_IDS), predicate: 'died' }, { predicate: 'died' }, null, 'x'])
  return result
}

function memory() {
  const ledgerKey = random.pick(['knowledge_ledger', 'knowledge_revealed', 'both', 'none'])
  const ledger = () => Array.from({ length: random.int(0, 3) }, () => ({ hero_id: random.pick(HERO), fact_id: random.pick(['f1', 'f2', 'f3', undefined, null]), recorded_at_minutes: random.pick(MINUTES) }))
  const result = { facts: random.chance(0.9) ? Array.from({ length: random.int(0, 4) }, fact) : random.pick([undefined, null, 'ff']) }
  if (ledgerKey === 'knowledge_ledger' || ledgerKey === 'both') result.knowledge_ledger = random.chance(0.9) ? ledger() : random.pick([null, 'x'])
  if (ledgerKey === 'knowledge_revealed' || ledgerKey === 'both') result.knowledge_revealed = ledger()
  return result
}

function viewer() {
  if (random.chance(0.05)) return random.pick([{}, { role: 'admin' }, { isAdmin: 1 }])
  const result = { playerId: random.pick(HERO), isPartyMember: random.pick([true, false, undefined, 0]) }
  if (random.chance(0.2)) result.asOfMinutes = random.pick(MINUTES)
  if (random.chance(0.1)) result.as_of_minutes = random.pick(MINUTES)
  if (random.chance(0.1)) result.role = random.pick(['player', 'admin'])
  return result
}

function responsibility() {
  return random.pick([
    { schema_version: 1, type: 'npc', npc_id: random.pick(['king', 'ivara', 'bad id', '']), death_policy: 'impossible' },
    { type: 'npc', npc_id: 'king', death_policy: 'impossible' },
    { type: 'npc', npc_id: 'king', death_policy: 'transfer' },
    { type: 'office', office_id: random.pick(['office:crown', 'office:none', '-bad']), death_policy: 'transfer' },
    { schema_version: 2, type: 'npc', npc_id: 'king', death_policy: 'impossible' },
    { schema_version: null, type: 'office', office_id: 'office:crown', death_policy: 'transfer' },
    { type: 'npc', npc_id: 'x'.repeat(121), death_policy: 'impossible' },
    undefined, null, 'npc', {},
  ])
}

function history() {
  return Array.from({ length: random.int(0, 3) }, () => {
    if (random.chance(0.1)) return random.pick([null, 'x', { schema_version: 1 }])
    const entry = {
      schema_version: random.pick([1, 1, 2, '1']),
      event_id: random.pick(['e1', 'e2', 'e3', '', null]),
      previous: random.pick([{ status: 'active' }, { status: 'offered', summary: 'Старое' }, { giver_npc_id: 'ivara' }, { 7: 'x', status: 'active' }, {}, null, 'st']),
      absent_fields: random.pick([['clock'], [], undefined, ['summary', 'giver_npc_id'], 'ab', [7]]),
      knowledge_gate: gate(),
    }
    if (random.chance(0.4)) entry.previous_view = { location_id: random.pick(['palace', 'road']), objective: maybe('Старая цель'), replaced_objective: random.pick(['Выбрать дальнейшее занятие в текущей локации', 'Новая цель']), current_hook: maybe('Старый крючок'), suggestions: maybe(['совет']), story_quest_id: maybe(random.pick(['q1', null])) }
    return entry
  })
}

function quest() {
  if (random.chance(0.04)) return random.pick([null, 'q'])
  const result = {
    id: random.pick(['q1', 'q2', 'quest:chapter:1', 'q3', undefined, 4]),
    title: random.pick(['Найти переправу', 'Поручение короля', undefined, null, 12]),
    status: random.pick(['active', 'offered', 'completed', 'failed', undefined]),
    visibility: random.pick(VISIBILITY),
    giver_npc_id: random.pick(NPC_IDS),
    summary: maybe('Сводка'),
    clock: maybe({ filled: random.int(0, 4), segments: 4 }),
    responsibility: responsibility(),
  }
  if (random.chance(0.5)) result.knowledge_history = random.chance(0.9) ? history() : random.pick([null, 'h'])
  return result
}

function story() {
  if (random.chance(0.08)) return random.pick([null, 'story'])
  const result = {
    story_id: random.pick(['s1', 's2']),
    story_number: random.pick([1, 2, 3, '4', undefined, null, 'x']),
    quest_id: random.pick(['q1', 'q2', 'q3', undefined]),
    title: 'История',
    knowledge_gate: gate(),
    policy_id: maybe('p'),
    dependency_id: maybe('d'),
    source_event_ids: maybe(['e1']),
  }
  if (random.chance(0.5)) result.previous_view = { story_quest_id: maybe(random.pick(['q1', 'q2', null])), location_id: random.pick(['palace', 'road', undefined]), objective: maybe('Старая цель'), current_hook: maybe('Старый крючок'), replaced_objective: random.pick(['Исследовать мир или выбрать собственную цель', 'Новая цель', undefined]), suggestions: maybe(['совет']) }
  return result
}

function campaignState() {
  const conceptKind = random.int(0, 9)
  const concept = conceptKind === 0 ? random.pick([undefined, null, 'concept', 0]) : {
    campaign_mode: random.pick(['persistent', 'persistent', 'adventure', undefined, 'PERSISTENT']),
    story_sequence: random.pick([0, 1, 2, undefined, null, -1, '3', 1.5, 2 ** 53 - 1, 2 ** 53]),
    story_history: random.chance(0.85) ? Array.from({ length: random.int(0, 3) }, story) : random.pick([undefined, null, {}]),
  }
  if (concept && typeof concept === 'object' && random.chance(0.6)) concept.story_quest_id = random.pick(['q1', 'q2', 'q3', null, 'quest:chapter:1'])
  const state = {
    sessionCode: random.pick(['NPC-OFFICE', 'S', undefined, null, 5]),
    worldMemory: random.chance(0.95) ? { ...memory(), quests: random.chance(0.9) ? Array.from({ length: random.int(0, 4) }, quest) : undefined } : random.pick([undefined, null, 'wm']),
    scene: random.chance(0.9) ? { location_id: random.pick(['palace', 'road', undefined, 7]), location: maybe('Дворец'), objective: random.pick(['Выбрать дальнейшее занятие в текущей локации', 'Исследовать мир или выбрать собственную цель', 'Новая цель', undefined, '']) } : random.pick([undefined, 'scene']),
    adventure: random.chance(0.8) ? { currentHook: maybe('Крючок'), chapter: maybe(2) } : undefined,
    suggestions: maybe(['совет 1', 'совет 2']),
    messages: random.chance(0.5) ? Array.from({ length: random.int(0, 3) }, () => random.chance(0.9) ? { id: 'm', text: 'Сообщение', knowledge_gate: maybe(gate()) } : 'msg') : random.pick([undefined, null]),
    mechanics: random.chance(0.9) ? { world_time: { elapsed_minutes: random.pick(MINUTES) } } : undefined,
    world_offices: random.chance(0.7) ? { offices: [{ id: 'office:crown', title: 'Корона', holder_npc_id: random.pick(NPC_IDS) }, { id: 'office:none', title: 'Пустая', holder_npc_id: null }] } : undefined,
    social: { npcs: [{ id: 'king', name: 'Король' }, { id: 'ivara', name: random.pick(['Ивара', '', null]) }, { id: 'oren', name: 'Орен', available: random.pick([true, false, undefined]) }] },
    npc_world: random.chance(0.8) ? {
      vitals: { king: { alive: random.pick([true, false, undefined]) }, ivara: { alive: random.pick([true, false]) }, oren: { alive: true } },
      stances: { king: { stance: random.pick(['dead', 'calm', undefined]) }, oren: { stance: random.pick(['dead', 'calm']) } },
    } : undefined,
  }
  if (concept !== undefined) state.campaignConcept = concept
  return state
}

function questEvent() {
  const type = random.pick(['NpcDied', 'NpcDied', 'OfficeVacated', 'OfficeHolderInstalled', 'QuestResolved', 'QuestInvalidated', 'QuestAssignmentChanged', 'QuestClockAdvanced', 'QuestAccepted', 'QuestUpserted', 'Other', undefined])
  const payload = {
    npc_id: random.pick(NPC_IDS),
    office_id: random.pick(['office:crown', 'office:none', undefined]),
    quest_id: random.pick(['q1', 'q2', 'q3', undefined, '']),
    outcome: random.pick(['success', 'failure', 'abandoned', 'partial', undefined]),
    summary: maybe('Итог'),
    schema_version: random.pick([2, 2, 1, undefined]),
    source_event_id: maybe(random.pick(EVENT_IDS), 0.3),
    source_event_ids: maybe(sourceIds(), 0.5),
    dependency_id: maybe('dep'),
    policy_id: maybe('pol'),
  }
  if (random.chance(0.6)) payload.knowledge_gate = gate()
  if (random.chance(0.3)) payload.previous_view = { location_id: 'palace', objective: 'Старая' }
  if (random.chance(0.2)) payload.quest = { id: random.pick(['q1', 'q9']) }
  return {
    event_type: type,
    event_id: random.pick(EVENT_IDS),
    command_id: maybe(random.pick(['cmd-1', '', 7]), 0.4),
    visibility: random.pick(VISIBILITY),
    actor_id: random.pick(HERO),
    target_ids: random.pick([['king'], [], undefined, 'king', ['hero', 'hero']]),
    player_ids: random.pick([['hero'], undefined, ['mate', 'hero']]),
    payload: random.chance(0.95) ? payload : undefined,
  }
}

for (let index = 0; index < 260; index += 1) {
  const state = campaignState()
  const mem = memory()
  q.call('knowledgeGateVisible', quests.knowledgeGateVisible, [gate(), mem, viewer()])
  q.call('knowledgeGateVisible', quests.knowledgeGateVisible, [gate(), random.chance(0.9) ? state.worldMemory : undefined, viewer()])
  q.call('knowledgeGateForEvent', quests.knowledgeGateForEvent, [state, questEvent()])
  q.call('normalizeQuestKnowledgeHistory', quests.normalizeQuestKnowledgeHistory, [random.chance(0.8) ? history() : random.pick(JUNK)])
  const record = quest()
  if (record && typeof record === 'object') {
    q.call('recordQuestKnowledge', quests.recordQuestKnowledge, [record, questEvent()])
    q.call('questForKnowledge', quests.questForKnowledge, [record, mem, viewer()])
  }
  q.call('questStateForViewer', quests.questStateForViewer, [state, viewer()])
  q.call('normalizeQuestResponsibility', quests.normalizeQuestResponsibility, [responsibility()])
  q.call('questGiverId', quests.questGiverId, [state, responsibility()])
  q.call('questIsImpossible', quests.questIsImpossible, [state, quest()])
  q.call('questInvalidationDraft', quests.questInvalidationDraft, [state, quest(), random.pick([undefined, {}, { primaryQuestId: 'q1' }, { deathEvent: questEvent() }, { primaryQuestId: 'q2', deathEvent: questEvent() }, { primaryQuestId: undefined }])])
  const events = Array.from({ length: random.int(0, 4) }, questEvent)
  q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [state, events, random.pick([undefined, {}, { primaryQuestId: 'q1' }, { primaryQuestId: 'q2' }])])
  s.call('campaignModeFor', stories.campaignModeFor, [state])
  s.call('persistentStoryQuest', stories.persistentStoryQuest, [state])
  s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [state, events], { expectThrow: true })
  s.call('campaignStoryChronicleEntry', stories.campaignStoryChronicleEntry, [random.chance(0.7) ? {
    event_type: random.pick(['CampaignStoryCompleted', 'CampaignStoryCompleted', 'Other']),
    payload: random.chance(0.9) ? { schema_version: random.pick([1, 2, 3, '1', undefined]), story_id: maybe('story:abc:1'), title: maybe('История'), summary: maybe('Итог.'), knowledge_gate: maybe(gate(), 0.4) } : undefined,
  } : random.pick(JUNK)])
}
// Прицельно: история постоянного мира закрывается исходом своей задачи, а
// личное поручение и должность дают черновики последствий.
for (let index = 0; index < 120; index += 1) {
  const state = campaignState()
  state.campaignConcept = {
    campaign_mode: 'persistent',
    story_sequence: random.pick([0, 1, 5, undefined, null]),
    story_history: Array.from({ length: random.int(0, 2) }, story),
    ...(random.chance(0.6) ? { story_quest_id: random.pick(['q1', 'q2', null]) } : {}),
  }
  const storyQuest = { ...quest(), id: random.pick(['q1', 'q2']), status: 'active', visibility: random.pick(['party', 'public']), title: random.pick(['Найти переправу', 'x'.repeat(200), 7, undefined]) }
  const king = { ...quest(), id: 'q3', status: random.pick(['active', 'offered']), responsibility: { type: 'npc', npc_id: 'king', death_policy: 'impossible' } }
  const crown = { ...quest(), id: 'q4', status: 'active', responsibility: { type: 'office', office_id: 'office:crown', death_policy: 'transfer' } }
  state.worldMemory = { ...memory(), quests: [storyQuest, king, crown] }
  if (random.chance(0.5)) state.worldMemory.facts = [...(state.worldMemory.facts ?? []), { id: 'f-king', subject_id: 'king', predicate: 'died', status: 'active', source_event_ids: random.pick([['death-1'], 'death-1', ['death-1', 'death-0']]), visibility: random.pick(VISIBILITY) }]
  state.npc_world = { vitals: { king: { alive: random.pick([false, false, true]) } }, stances: { king: { stance: random.pick(['dead', 'calm']) } } }
  const resolution = { event_type: random.pick(['QuestResolved', 'QuestInvalidated']), event_id: random.pick(['res-1', undefined, '']), visibility: random.pick(VISIBILITY), payload: {
    quest_id: storyQuest.id, outcome: random.pick(['success', 'failure', 'abandoned']), summary: random.pick(['Итог.', '', undefined, 'и'.repeat(1200)]),
    ...(random.chance(0.5) ? { knowledge_gate: gate(), dependency_id: maybe('dep'), policy_id: maybe('pol') } : {}),
  } }
  const events = [
    ...random.some([questEvent(), { event_type: 'NpcDied', event_id: random.pick(['death-1', undefined]), visibility: random.pick(VISIBILITY), payload: { npc_id: 'king' } }, { event_type: random.pick(['OfficeVacated', 'OfficeHolderInstalled']), event_id: 'office-1', payload: { office_id: 'office:crown' } }], 3),
    resolution,
  ]
  s.call('campaignStoryCompletionDraft', stories.campaignStoryCompletionDraft, [state, events], { expectThrow: true })
  s.call('persistentStoryQuest', stories.persistentStoryQuest, [state])
  q.call('planQuestConsequenceDrafts', quests.planQuestConsequenceDrafts, [state, events, { primaryQuestId: random.pick(['q3', 'q4', null]) }])
  q.call('questInvalidationDraft', quests.questInvalidationDraft, [state, king, { primaryQuestId: random.pick(['q3', undefined]), deathEvent: random.pick([undefined, events[0]]) }])
  q.call('questStateForViewer', quests.questStateForViewer, [state, viewer()])
}

s.call('campaignModeFor', stories.campaignModeFor, [])
s.call('persistentStoryQuest', stories.persistentStoryQuest, [])
for (const mode of [undefined, 'adventure', 'persistent', 'Persistent', '', null, 1]) s.call('validateCampaignMode', stories.validateCampaignMode, [mode], { expectThrow: true })

const questConstants = { QUEST_CONSEQUENCE_POLICY_ID: quests.QUEST_CONSEQUENCE_POLICY_ID }
const storyConstants = { CAMPAIGN_MODES: stories.CAMPAIGN_MODES, PERSISTENT_WORLD_OBJECTIVE: stories.PERSISTENT_WORLD_OBJECTIVE }
write('quest-consequences.json', { generator: 'gen-quest-consequences.mjs', constants: questConstants, values: q.values, cases: q.cases, skipped: q.skipped })
write('campaign-stories.json', { generator: 'gen-quest-consequences.mjs', constants: storyConstants, values: s.values, cases: s.cases, skipped: s.skipped })
