import '../../../fixtures-env.mjs'
// Эталон `server/quest-decisions.mjs`: запрос решения по поручению против
// настоящего `AuthoritativeExecutor` с журналом-заглушкой и запись хроники.
//
//   node rust/crates/sk-character/fixtures/gen-quest-decisions.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthoritativeExecutor } from '../../../../server/authoritative-executor.mjs'
import { questDecisionChronicleEntry, requestQuestDecision } from '../../../../server/quest-decisions.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let seed = 20261015
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = (items) => items[Math.floor(random() * items.length)]
const chance = (p) => random() < p

const QUEST_IDS = ['quest-mill', 'quest-bridge', 'quest:chapter:2', 'quest-hidden', 'constructor']
const HEROES = ['hero-a', 'hero-b', 'hero-c']

function questFor(id) {
  const quest = {
    id,
    title: pick(['Мельница', 'Мост через Чёрную', '', undefined, 7]),
    status: chance(0.8) ? pick(['active', 'offered']) : pick(['resolved', 'hidden', 'failed']),
    visibility: chance(0.85) ? pick(['public', 'party']) : pick(['gm', undefined]),
  }
  if (chance(0.5)) quest.giver_npc_id = pick(['npc-miller', 'npc-guard'])
  if (chance(0.3)) quest.responsibility = { schema_version: 1, type: 'npc', npc_id: pick(['npc-miller', 'npc-guard']), death_policy: 'impossible' }
  if (chance(0.25)) {
    quest.knowledge_history = [{
      schema_version: 1, event_id: 'evt-1',
      knowledge_gate: pick([{ visibility: 'gm' }, { visibility: 'party' }, { visibility: 'specific_player', player_ids: ['hero-b'] }]),
      previous: pick([{ status: 'offered' }, { giver_npc_id: 'npc-old' }, { title: 'Старое имя' }]),
    }]
  }
  return quest
}

function stateFor() {
  const players = HEROES.slice(0, 1 + Math.floor(random() * 3)).map((id) => ({ id, name: id, ...(chance(0.08) ? { characterSetupRequired: true } : {}) }))
  const state = {
    players,
    mechanics: {
      campaign_lifecycle: { status: chance(0.95) ? 'active' : pick(['paused', 'ended', undefined]) },
      ...(chance(0.05) ? { combat: { active: pick([true, 1, 'yes']) } } : {}),
      ...(chance(0.1) ? { death: { heroes: { [pick(HEROES)]: { status: 'dead' } } } } : {}),
    },
    worldMemory: { quests: QUEST_IDS.filter(() => chance(0.7)).map(questFor) },
  }
  if (chance(0.5)) state.partyMemberIds = players.map((hero) => hero.id).filter(() => chance(0.93))
  if (chance(0.3)) state.npc_world = { vitals: { 'npc-miller': { alive: chance(0.5) } }, stances: { 'npc-guard': { stance: pick(['dead', 'friendly']) } } }
  if (chance(0.5)) state.campaignConcept = { campaign_mode: pick(['persistent', 'adventure']), ...(chance(0.5) ? { story_quest_id: pick([null, 'quest-mill', 'quest-bridge']) } : {}) }
  if (chance(0.1)) state.agentInteraction = { id: 'vote-old', status: 'open' }
  if (chance(0.3)) state.partyDecisionPolicy = pick([{ quorumMode: 'unanimous' }, { decisionTtlMs: 60000, voterScope: 'hero' }])
  return state
}

function snapshotFor(state) {
  const eligibleHeroIds = (state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((hero) => hero.id))
  const snapshot = { eligibleHeroIds }
  if (chance(0.5)) snapshot.eligibleVoterIds = eligibleHeroIds.map((id) => `account-${id}`)
  if (chance(0.5)) snapshot.voterByHeroId = Object.fromEntries(eligibleHeroIds.map((id) => [id, `account-${id}`]))
  if (chance(0.3)) snapshot.policy = { quorumMode: 'majority_of_active_voters', decisionTtlMs: 30000 }
  return snapshot
}

const cases = []
for (let index = 0; index < 1500; index += 1) {
  const state = stateFor()
  const snapshot = snapshotFor(state)
  const quests = state.worldMemory.quests
  const request = {
    campaignId: pick(['CAMP-1', 'ASTOHAN-RUN']),
    actorId: chance(0.95) ? (chance(0.85) ? pick(state.players).id : pick([...HEROES, 'hero-x', 'constructor'])) : pick(['', '-bad', 'герой', 5, null]),
    questId: chance(0.9) ? (quests.length && chance(0.8) ? pick(quests).id : pick(QUEST_IDS)) : pick(['', 'квест', null]),
    idempotencyKey: chance(0.96) ? `key-${index}` : pick(['', '   ', 'k'.repeat(161), 'k'.repeat(160), 42, null]),
    action: chance(0.95) ? pick(['abandon', 'accept', undefined]) : 'delete',
    now: 1760000000000 + index,
  }
  // Повтор: журнал уже знает ключ — с тем же отпечатком или чужим.
  const previousKind = chance(0.08) ? pick(['same', 'foreign']) : null
  let previous = null
  const store = {
    async getByIdempotencyKey() { return previous },
    async load() { return { state: structuredClone(state), state_version: 7 } },
    async commit(input) {
      return { campaign_id: input.campaign_id, state_version: 8, current_state_version: 8, state: {}, metadata: {}, events: input.events, duplicate: false, idempotency_key: input.idempotency_key, command_id: input.command_id }
    },
  }
  const executor = new AuthoritativeExecutor({ eventStore: store })
  const run = async () => requestQuestDecision({ executor, ...request, voterSnapshot: () => structuredClone(snapshot) })
  if (previousKind) {
    // Отпечаток прежнего запроса: снять его первым прогоном, как сделал бы JS.
    try {
      const first = await run()
      previous = previousKind === 'same' ? first : { ...first, events: first.events.map((event) => ({ ...event, payload: { ...event.payload, request_fingerprint: 'другой' } })) }
    } catch {
      previous = null
    }
  }
  let expected
  try {
    const result = await run()
    expected = { events: result.events }
  } catch (error) {
    expected = { error: { code: error.code ?? error.name, message: error.message } }
  }
  cases.push({ state, snapshot, request: { ...request, actorId: request.actorId ?? null, questId: request.questId ?? null, idempotencyKey: request.idempotencyKey ?? null, action: request.action ?? null }, previous, expected })
}

const chronicle = []
for (let index = 0; index < 300; index += 1) {
  const event = {
    event_id: chance(0.9) ? `evt-${index}` : undefined,
    event_type: pick(['QuestInvalidated', 'QuestAssignmentChanged', 'QuestAccepted', 'QuestResolved', 'QuestUpserted', undefined]),
    visibility: pick(['public', 'party', 'gm', undefined]),
    payload: pick([undefined, {
      schema_version: pick([1, 2, 3, '1', undefined]),
      summary: pick(['Мельник погиб, поручение отменено', '', undefined, 0, 12.5]),
      ...(chance(0.4) ? { knowledge_gate: pick([{ visibility: 'party' }, null, 0]) } : {}),
      ...(chance(0.4) ? { stay_in_location: pick([true, 'true', false]) } : {}),
    }]),
  }
  chronicle.push({ event, expected: questDecisionChronicleEntry(event) })
}

const text = JSON.stringify({ cases, chronicle })
writeFileSync(join(here, 'quest-decisions.json'), text)
const codes = {}
for (const item of cases) codes[item.expected.error?.code ?? 'ok'] = (codes[item.expected.error?.code ?? 'ok'] ?? 0) + 1
console.log(`случаев: ${cases.length}, хроника: ${chronicle.length}, ${(text.length / 1024).toFixed(0)} КБ`, codes)
