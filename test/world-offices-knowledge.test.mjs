import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OFFICE_EVENT_LEGACY_SCHEMA_VERSION,
  OFFICE_EVENT_SCHEMA_VERSION,
  WORLD_OFFICES_LEGACY_POLICY_ID,
  WORLD_OFFICES_POLICY_ID,
  applyWorldOfficeEvent,
  normalizeWorldOfficesState,
  officeChronicleEntry,
  officesForViewer,
  planOfficeSuccessionDrafts,
  planOfficeVacancyDrafts,
} from '../server/world-offices.mjs'

const OFFICE_ID = 'office:crown'
const KING_ID = 'npc:king'
const MARSHAL_ID = 'npc:marshal'
const FACT_ID = 'fact:king-dead'

function office() {
  return {
    id: OFFICE_ID,
    title: 'Корона Валедора',
    faction_id: 'faction:crown',
    holder_npc_id: KING_ID,
    visibility: 'party',
    successor: { npc_id: MARSHAL_ID, delay_minutes: 1_440, required_tags: ['marshal'] },
    defender_npc_ids: [],
  }
}

function campaign({ deathVisibility = 'gm_only', known = [] } = {}) {
  const gateFact = {
    id: FACT_ID,
    subject_id: KING_ID,
    predicate: 'died',
    object: 'palace',
    summary: 'Король погиб.',
    visibility: deathVisibility,
    status: 'active',
    source_event_ids: ['death:hidden'],
  }
  return {
    world_offices: normalizeWorldOfficesState({ offices: [office()] }),
    worldMemory: {
      facts: [gateFact],
      knowledge_ledger: known.map((heroId) => ({ hero_id: heroId, fact_id: FACT_ID })),
      knowledge_revealed: known.map((heroId) => ({ hero_id: heroId, fact_id: FACT_ID })),
    },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [
      { id: KING_ID, name: 'Король Арес', tags: ['faction:faction:crown'], available: true },
      { id: MARSHAL_ID, name: 'Маршал Ивара', tags: ['faction:faction:crown', 'marshal'], available: true },
    ] },
    npc_world: { vitals: {
      [KING_ID]: { hp: 0, max_hp: 10, alive: false },
      [MARSHAL_ID]: { hp: 10, max_hp: 10, alive: true },
    } },
  }
}

function death(visibility = 'gm_only') {
  return {
    event_type: 'NpcDied', event_id: 'death:hidden', visibility,
    payload: { npc_id: KING_ID },
  }
}

function event(draft, eventId) {
  return { ...draft, event_id: eventId }
}

test('старые Office события v1 воспроизводятся без журнала знания', () => {
  const initial = normalizeWorldOfficesState({ offices: [office()] })
  const vacated = {
    event_type: 'OfficeVacated', event_id: 'office-v1-vacated', visibility: 'party',
    payload: {
      schema_version: OFFICE_EVENT_LEGACY_SCHEMA_VERSION,
      policy_id: WORLD_OFFICES_LEGACY_POLICY_ID,
      office_id: OFFICE_ID, title: 'Корона Валедора', status: 'vacant', holder_npc_id: null,
      previous_holder_npc_id: KING_ID, succession_id: 'succession:v1',
      vacated_at_minutes: 10, due_at_minutes: 20, source_event_id: 'death:v1',
    },
  }
  const holder = {
    event_type: 'OfficeHolderInstalled', event_id: 'office-v1-installed', visibility: 'party',
    payload: {
      schema_version: OFFICE_EVENT_LEGACY_SCHEMA_VERSION,
      policy_id: WORLD_OFFICES_LEGACY_POLICY_ID,
      office_id: OFFICE_ID, title: 'Корона Валедора', status: 'held', holder_npc_id: MARSHAL_ID,
      previous_holder_npc_id: null, succession_id: 'succession:v1',
      installed_at_minutes: 20, source_event_id: 'death:v1',
    },
  }
  const vacant = applyWorldOfficeEvent(initial, vacated)
  const installed = applyWorldOfficeEvent(vacant, holder)
  const replayed = applyWorldOfficeEvent(applyWorldOfficeEvent(initial, vacated), holder)
  assert.deepEqual(replayed, installed)
  assert.equal(installed.offices[0].succession_history[0].knowledge_gate, undefined)
  assert.equal(installed.offices[0].succession_history[0].previous_holder_npc_id, undefined)
})

test('скрытая смерть удерживает прежний статус должности до раскрытия одному герою', () => {
  const initial = campaign()
  const deathEvent = death()
  const vacancyDraft = planOfficeVacancyDrafts(initial, [deathEvent])[0]
  assert.equal(vacancyDraft.payload.schema_version, OFFICE_EVENT_SCHEMA_VERSION)
  assert.equal(vacancyDraft.payload.policy_id, WORLD_OFFICES_POLICY_ID)
  assert.deepEqual(vacancyDraft.payload.knowledge_gate, {
    visibility: 'gm_only', player_ids: [], fact_ids: [FACT_ID], source_event_ids: ['death:hidden'],
    required_fact: { subject_id: KING_ID, predicate: 'died' }, recorded_at_minutes: 0,
  })

  const vacant = applyWorldOfficeEvent(initial.world_offices, event(vacancyDraft, 'office:hidden-vacated'))
  assert.deepEqual(vacant.offices[0].pending.knowledge_gate, vacancyDraft.payload.knowledge_gate)
  assert.deepEqual(officesForViewer({ ...initial, world_offices: vacant }, { playerId: 'hero' }), [{
    office_id: OFFICE_ID, title: 'Корона Валедора', status: 'held', holder_npc_id: KING_ID,
  }])

  const revealed = campaign({ known: ['hero'] })
  const revealedVacant = officesForViewer({ ...revealed, world_offices: vacant }, { playerId: 'hero' })
  assert.equal(revealedVacant[0].status, 'vacant')
  assert.equal(revealedVacant[0].holder_npc_id, null)

  const installedDraft = planOfficeSuccessionDrafts({ ...initial, world_offices: vacant }, { worldMinute: 1_440 })[0]
  assert.equal(installedDraft.payload.schema_version, OFFICE_EVENT_SCHEMA_VERSION)
  assert.deepEqual(installedDraft.payload.knowledge_gate, vacancyDraft.payload.knowledge_gate)
  const installed = applyWorldOfficeEvent(vacant, event(installedDraft, 'office:hidden-installed'))
  assert.deepEqual(officesForViewer({ ...initial, world_offices: installed }, { playerId: 'hero' })[0], {
    office_id: OFFICE_ID, title: 'Корона Валедора', status: 'held', holder_npc_id: KING_ID,
  })
  assert.deepEqual(officesForViewer({ ...revealed, world_offices: installed }, { playerId: 'hero' })[0], {
    office_id: OFFICE_ID, title: 'Корона Валедора', status: 'held', holder_npc_id: MARSHAL_ID,
  })
})

test('публичная смерть меняет статус должности и запись летописи для всего отряда', () => {
  const initial = campaign({ deathVisibility: 'party' })
  const deathEvent = death('party')
  const vacancyDraft = planOfficeVacancyDrafts(initial, [deathEvent])[0]
  const vacant = applyWorldOfficeEvent(initial.world_offices, event(vacancyDraft, 'office:public-vacated'))
  assert.equal(officesForViewer({ ...initial, world_offices: vacant }, { playerId: 'hero' })[0].status, 'vacant')

  const entry = officeChronicleEntry(event(vacancyDraft, 'office:public-vacated'))
  assert.deepEqual(entry.knowledge_gate, vacancyDraft.payload.knowledge_gate)
  assert.match(entry.text, /Корона Валедора/u)
  assert.doesNotMatch(entry.text, /death|succession|faction|marshal|npc:/iu)
})

test('нормализация сохраняет knowledge_gate в pending и истории должности', () => {
  const gate = { visibility: 'specific_player', player_ids: ['hero'], fact_ids: [FACT_ID], source_event_ids: ['death:hidden'] }
  const input = {
    offices: [{ ...office(), status: 'vacant', holder_npc_id: null,
      pending: { succession_id: 'succession:hidden', candidate_npc_id: MARSHAL_ID, due_at_minutes: 10,
        vacated_at_minutes: 0, source_event_id: 'death:hidden', previous_status: 'held',
        previous_holder_npc_id: KING_ID, knowledge_gate: gate },
      succession_history: [{ succession_id: 'succession:old', outcome: 'installed', reason: 'successor_installed',
        candidate_npc_id: 'npc:old', at_minutes: 0, source_event_id: 'event:old',
        previous_status: 'vacant', previous_holder_npc_id: null, knowledge_gate: gate }],
    }],
  }
  const normalized = normalizeWorldOfficesState(input)
  assert.deepEqual(normalized.offices[0].pending.knowledge_gate, gate)
  assert.deepEqual(normalized.offices[0].succession_history[0].knowledge_gate, gate)
  assert.deepEqual(normalizeWorldOfficesState(normalized), normalized)
})
