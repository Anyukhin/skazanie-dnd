import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OFFICE_EVENT_SCHEMA_VERSION,
  WORLD_OFFICES_POLICY_ID,
  WORLD_OFFICES_SCHEMA_VERSION,
  WorldOfficeValidationError,
  applyWorldOfficeEvent,
  normalizeWorldOfficesState,
  officeChronicleEntry,
  officesForViewer,
  planOfficeSuccessionDrafts,
  planOfficeVacancyDrafts,
  validateOfficeConfiguration,
} from '../server/world-offices.mjs'

const OFFICE_ID = 'office:crown'
const KING_ID = 'npc:king'
const MARSHAL_ID = 'npc:marshal'
const CROWN_FACTION = 'faction:crown'

function office(overrides = {}) {
  return {
    id: OFFICE_ID,
    title: 'Корона Валедора',
    faction_id: CROWN_FACTION,
    holder_npc_id: KING_ID,
    visibility: 'party',
    successor: {
      npc_id: MARSHAL_ID,
      delay_minutes: 1_440,
      required_tags: ['marshal'],
    },
    defender_npc_ids: ['npc:guard-1'],
    ...overrides,
  }
}

function worldOffices(config = office()) {
  return normalizeWorldOfficesState({ offices: [config] })
}

function campaign({ minute = 0, config = office(), candidate = {}, kingAlive = true } = {}) {
  return {
    mechanics: { world_time: { elapsed_minutes: minute } },
    world_offices: worldOffices(config),
    social: {
      npcs: [
        {
          id: KING_ID,
          name: 'Король Арес',
          role: 'правитель',
          location: 'Штормберг',
          visibility: 'party',
          available: true,
          tags: [`faction:${CROWN_FACTION}`, 'king'],
        },
        {
          id: MARSHAL_ID,
          name: 'Маршал Ивара',
          role: 'маршал',
          location: 'Штормберг',
          visibility: 'party',
          available: true,
          tags: [`faction:${CROWN_FACTION}`, 'marshal'],
          ...candidate,
        },
      ],
    },
    npc_world: {
      vitals: {
        [KING_ID]: { hp: kingAlive ? 10 : 0, max_hp: 10, alive: kingAlive },
        [MARSHAL_ID]: { hp: 10, max_hp: 10, alive: true },
      },
    },
  }
}

function eventDraftEvent(draft, eventId = 'event:office') {
  return { ...draft, event_id: eventId }
}

function applyDraft(state, draft, eventId = 'event:office') {
  return applyWorldOfficeEvent(state, eventDraftEvent(draft, eventId))
}

function deathEvent(eventId = 'event:king-died') {
  return { event_type: 'NpcDied', event_id: eventId, payload: { npc_id: KING_ID, npc_name: 'Король Арес' } }
}

function vacancyState(options = {}) {
  const initial = campaign(options)
  const drafts = planOfficeVacancyDrafts(initial, [deathEvent()], { worldMinute: options.minute ?? 0 })
  assert.equal(drafts.length, 1)
  return { initial, drafts, vacant: applyDraft(initial.world_offices, drafts[0]) }
}

test('optional state and configuration are bounded, typed, and preserve private defenders', () => {
  assert.deepEqual(normalizeWorldOfficesState(), { schema_version: WORLD_OFFICES_SCHEMA_VERSION, offices: [] })
  const normalized = validateOfficeConfiguration(office(), {
    knownNpcIds: [KING_ID, MARSHAL_ID, 'npc:guard-1'],
    knownFactionIds: [CROWN_FACTION],
  })
  assert.deepEqual(normalized, office())
  assert.deepEqual(normalizeWorldOfficesState({ offices: [office()] }).offices[0], {
    ...office(),
    status: 'held',
    pending: null,
    succession_history: [],
  })
  assert.throws(
    () => validateOfficeConfiguration({ ...office(), title: '' }),
    (error) => error instanceof WorldOfficeValidationError && error.code === 'WORLD_OFFICE_TITLE_REQUIRED',
  )
  assert.throws(
    () => validateOfficeConfiguration(office(), { knownNpcIds: [KING_ID], knownFactionIds: [CROWN_FACTION] }),
    (error) => error instanceof WorldOfficeValidationError && error.code === 'WORLD_OFFICE_REFERENCE_NOT_FOUND',
  )
})

test('only a confirmed death of the current holder vacates an office and creates one pending succession', () => {
  const state = campaign({ minute: 300 })
  const otherDeath = { event_type: 'NpcDied', event_id: 'event:other-died', payload: { npc_id: 'npc:other' } }
  assert.deepEqual(planOfficeVacancyDrafts(state, [otherDeath]), [])

  const drafts = planOfficeVacancyDrafts(state, [deathEvent()], { worldMinute: 300 })
  assert.equal(drafts.length, 1)
  assert.deepEqual(drafts[0].payload, {
    schema_version: OFFICE_EVENT_SCHEMA_VERSION,
    policy_id: WORLD_OFFICES_POLICY_ID,
    office_id: OFFICE_ID,
    title: 'Корона Валедора',
    status: 'vacant',
    holder_npc_id: null,
    previous_holder_npc_id: KING_ID,
    succession_id: drafts[0].payload.succession_id,
    vacated_at_minutes: 300,
    due_at_minutes: 1_740,
    source_event_id: 'event:king-died',
  })
  const vacant = applyDraft(state.world_offices, drafts[0])
  assert.equal(vacant.offices[0].status, 'vacant')
  assert.equal(vacant.offices[0].holder_npc_id, null)
  assert.equal(vacant.offices[0].pending.candidate_npc_id, MARSHAL_ID)
  assert.equal(vacant.offices[0].pending.due_at_minutes, 1_740)
  assert.deepEqual(planOfficeVacancyDrafts({ ...state, world_offices: vacant }, [deathEvent()]), [])
})

test('succession waits for due minute, then installs a living available candidate with the correct faction and tag', () => {
  const { initial, drafts, vacant } = vacancyState({ minute: 300 })
  assert.deepEqual(planOfficeSuccessionDrafts({ ...initial, world_offices: vacant }, { worldMinute: 1_739 }), [])

  const due = planOfficeSuccessionDrafts({ ...initial, world_offices: vacant }, { worldMinute: 1_740 })
  assert.equal(due.length, 1)
  assert.equal(due[0].event_type, 'OfficeHolderInstalled')
  assert.equal(due[0].payload.office_id, OFFICE_ID)
  assert.equal(due[0].payload.holder_npc_id, MARSHAL_ID)
  assert.equal(due[0].payload.status, 'held')
  assert.equal(due[0].payload.schema_version, OFFICE_EVENT_SCHEMA_VERSION)
  const installed = applyDraft(vacant, due[0], 'event:successor-installed')
  assert.equal(installed.offices[0].status, 'held')
  assert.equal(installed.offices[0].holder_npc_id, MARSHAL_ID)
  assert.equal(installed.offices[0].pending, null)
  assert.deepEqual(installed.offices[0].succession_history.at(-1), {
    succession_id: drafts[0].payload.succession_id,
    outcome: 'installed',
    reason: 'successor_installed',
    candidate_npc_id: MARSHAL_ID,
    at_minutes: 1_740,
    source_event_id: 'event:king-died',
  })
  assert.deepEqual(planOfficeSuccessionDrafts({ ...initial, world_offices: installed }, { worldMinute: 99_999 }), [])
})

test('a candidate killed before due minute is skipped and the vacancy is durable', () => {
  const { initial, vacant } = vacancyState({ minute: 0 })
  const candidateKilled = {
    ...initial,
    world_offices: vacant,
    npc_world: {
      vitals: {
        [KING_ID]: { hp: 0, max_hp: 10, alive: false },
        [MARSHAL_ID]: { hp: 0, max_hp: 10, alive: false },
      },
    },
  }
  const skipped = planOfficeSuccessionDrafts(candidateKilled, { worldMinute: 1_440 })
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].event_type, 'OfficeSuccessionSkipped')
  assert.equal(skipped[0].payload.reason, 'candidate_dead')
  assert.equal(skipped[0].payload.holder_npc_id, null)
  assert.equal(skipped[0].visibility, 'gm_only')
  const result = applyDraft(vacant, skipped[0], 'event:successor-skipped')
  assert.equal(result.offices[0].status, 'vacant')
  assert.equal(result.offices[0].holder_npc_id, null)
  assert.equal(result.offices[0].pending, null)
  assert.equal(result.offices[0].succession_history.at(-1).outcome, 'skipped')
  assert.deepEqual(planOfficeSuccessionDrafts({ ...candidateKilled, world_offices: result }, { worldMinute: 99_999 }), [])
})

test('wrong faction, missing tag, and unavailable candidate never install the office', () => {
  const cases = [
    { candidate: { tags: ['faction:faction:other', 'marshal'] }, reason: 'candidate_wrong_faction' },
    { candidate: { tags: [`faction:${CROWN_FACTION}`] }, reason: 'candidate_missing_tag' },
    { candidate: { available: false }, reason: 'candidate_unavailable' },
  ]
  for (const item of cases) {
    const { initial, vacant } = vacancyState({ minute: 0, candidate: item.candidate })
    const skipped = planOfficeSuccessionDrafts({ ...initial, world_offices: vacant }, { worldMinute: 1_440 })
    assert.equal(skipped[0]?.event_type, 'OfficeSuccessionSkipped', item.reason)
    assert.equal(skipped[0]?.payload.reason, item.reason)
    const after = applyDraft(vacant, skipped[0])
    assert.equal(after.offices[0].status, 'vacant')
  }
})

test('an available candidate participating in active combat is not installed', () => {
  const { initial, vacant } = vacancyState({ minute: 0 })
  const inCombat = {
    ...initial,
    world_offices: vacant,
    mechanics: {
      ...initial.mechanics,
      combat: { active: true },
    },
    enemies: [{
      id: 'enemy:marshal',
      origin: { npc_id: MARSHAL_ID },
      hp: 10,
      alive: true,
    }],
  }
  const skipped = planOfficeSuccessionDrafts(inCombat, { worldMinute: 1_440 })
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].event_type, 'OfficeSuccessionSkipped')
  assert.equal(skipped[0].payload.reason, 'candidate_unavailable')
  assert.equal(skipped[0].visibility, 'gm_only')
})

test('occupied office consumes a stale pending succession without replacing the current holder', () => {
  const { initial, vacant } = vacancyState({ minute: 0 })
  const pending = vacant.offices[0].pending
  const occupied = {
    ...vacant,
    offices: vacant.offices.map((entry) => ({
      ...entry,
      status: 'held',
      holder_npc_id: 'npc:interim-holder',
      pending,
    })),
  }
  const skipped = planOfficeSuccessionDrafts({ ...initial, world_offices: occupied }, { worldMinute: 1_440 })
  assert.equal(skipped[0]?.event_type, 'OfficeSuccessionSkipped')
  assert.equal(skipped[0]?.payload.reason, 'office_occupied')
  const result = applyDraft(occupied, skipped[0])
  assert.equal(result.offices[0].status, 'held')
  assert.equal(result.offices[0].holder_npc_id, 'npc:interim-holder')
  assert.equal(result.offices[0].pending, null)
})

test('an office without a successor produces a durable vacancy instead of a fabricated holder', () => {
  const config = office({ successor: undefined })
  const { initial, vacant } = vacancyState({ config, minute: 60 })
  assert.equal(vacant.offices[0].pending.candidate_npc_id, null)
  assert.equal(vacant.offices[0].pending.due_at_minutes, 60)
  const skipped = planOfficeSuccessionDrafts({ ...initial, world_offices: vacant }, { worldMinute: 60 })
  assert.equal(skipped[0]?.event_type, 'OfficeSuccessionSkipped')
  assert.equal(skipped[0]?.payload.reason, 'no_successor_configured')
  const result = applyDraft(vacant, skipped[0])
  assert.equal(result.offices[0].status, 'vacant')
  assert.equal(result.offices[0].holder_npc_id, null)
  assert.equal(result.offices[0].pending, null)
})

test('office reducer is immutable, versioned, replay-safe, and public projection hides succession policy', () => {
  const { initial, drafts, vacant } = vacancyState({ minute: 10 })
  const before = structuredClone(initial.world_offices)
  const installedDraft = planOfficeSuccessionDrafts({ ...initial, world_offices: vacant }, { worldMinute: 1_450 })[0]
  const installed = applyDraft(vacant, installedDraft, 'event:installed')
  assert.deepEqual(initial.world_offices, before)
  assert.deepEqual(applyWorldOfficeEvent(installed, eventDraftEvent(installedDraft, 'event:installed')), installed)

  const replayed = [drafts[0], installedDraft].reduce(
    (state, draft, index) => applyDraft(state, draft, `event:replay:${index + 1}`),
    initial.world_offices,
  )
  assert.deepEqual(replayed, installed)

  const publicView = officesForViewer(installed)
  assert.deepEqual(publicView, [{
    office_id: OFFICE_ID,
    title: 'Корона Валедора',
    status: 'held',
    holder_npc_id: MARSHAL_ID,
  }])
  assert.equal(Object.hasOwn(publicView[0], 'successor'), false)
  assert.equal(Object.hasOwn(publicView[0], 'defender_npc_ids'), false)
  assert.deepEqual(officesForViewer(normalizeWorldOfficesState({ offices: [office({ visibility: 'gm_only' })] })), [])
  assert.equal(officesForViewer(normalizeWorldOfficesState({ offices: [office({ visibility: 'gm_only' })] }), { isAdmin: true }).length, 1)
})

test('chronicle helper exposes only the public office status', () => {
  const event = {
    event_id: 'event:office-installed',
    event_type: 'OfficeHolderInstalled',
    visibility: 'party',
    payload: {
      schema_version: 1,
      policy_id: WORLD_OFFICES_POLICY_ID,
      office_id: OFFICE_ID,
      title: 'Корона Валедора',
      status: 'held',
      holder_npc_id: MARSHAL_ID,
      succession_id: 'succession:private',
      reason: 'candidate_wrong_faction',
      defender_npc_ids: ['npc:guard-1'],
    },
  }
  const entry = officeChronicleEntry(event)
  assert.equal(entry.author, 'Летопись мира')
  assert.match(entry.text, /Корона Валедора/u)
  assert.doesNotMatch(entry.text, /marshal|candidate|private|guard|faction/u)
  assert.equal(officeChronicleEntry({ ...event, visibility: 'gm_only' }), null)
})
