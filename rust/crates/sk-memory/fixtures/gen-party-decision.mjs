import '../../../fixtures-env.mjs'
// Эталоны `server/party-decision.mjs` для sk-memory: `node gen-party-decision.mjs`.
//
// Три части. Нормализация решения и политики на мусоре старых кампаний.
// Голосования целиком: отряд из 1–5 героев, голосующие по аккаунту или по
// герою (в том числе один аккаунт на двух героев), открытие, голоса, смена
// голоса, воздержание, уход и возвращение участников, общий бросок, истечение
// срока; состояние между шагами ведёт настоящий редьюсер Rules Engine
// (`applyGameEvent`), а в эталон пишется только то, что читает модуль.
// И исполнение решений по поручению (`questDecisionEvents`): принять,
// отложить, оставить, отказаться — в приключении и постоянном мире.
import { IDS, JUNK, collector, plain, rng, server, write } from './lib.mjs'

const P = await import(server('party-decision'))
const { applyGameEvent, normalizeCampaignState } = await import(server('rules-engine'))

const random = rng(5150)
const pick = (list) => random.pick(list)
const c = collector({ hashOver: 30_000 })

const trim = (state) => plain({
  partyMemberIds: state.partyMemberIds,
  players: (state.players ?? []).map((player) => ({ id: player.id, ...(player.character ? { character: player.character } : {}), ...(player.name ? { name: player.name } : {}) })),
  agentInteraction: state.agentInteraction,
  ...(state.worldMemory ? { worldMemory: { quests: state.worldMemory.quests, facts: state.worldMemory.facts, entities: state.worldMemory.entities } } : {}),
  ...(state.scene ? { scene: { objective: state.scene.objective } } : {}),
  ...(state.adventure ? { adventure: { currentHook: state.adventure.currentHook, chapter: state.adventure.chapter } } : {}),
  ...(state.campaignConcept ? { campaignConcept: { campaign_mode: state.campaignConcept.campaign_mode, story_quest_id: state.campaignConcept.story_quest_id } } : {}),
  ...(state.npc_world ? { npc_world: { vitals: state.npc_world.vitals, stances: state.npc_world.stances } } : {}),
})

// ---------------------------------------------------------------------------
// Нормализация
// ---------------------------------------------------------------------------

const junkId = () => pick([...IDS, ...JUNK, 'bad id', ' a ', 'x'.repeat(121), '-a'])
for (const value of [...JUNK, { decisionTtlMs: 5_000 }, { decision_ttl_ms: '60000' }, { ttlMs: 999 }, { decisionTtlMs: 10 ** 9 }, { voterScope: 'hero' }, { voter_scope: 'hero', ttlMs: null }, { voterScope: 'HERO' }]) {
  c.call('normalizePartyDecisionPolicy', P.normalizePartyDecisionPolicy, [value])
}
function junkDecision() {
  const ids = random.some(['a', 'b', 'c', 'd', '1', '2', '10'], 4)
  const optionIds = ['north', 'south', 'stay', 'accept', 'later', 'keep', 'abandon']
  const optionPool = random.chance(0.9) ? random.shuffle(optionIds) : Array.from({ length: 7 }, () => pick(optionIds))
  const options = optionPool.slice(0, random.int(0, 7)).map((id) => ({
    id: random.chance(0.97) ? id : junkId(),
    label: random.chance(0.96) ? pick(['На север', '  На   юг ', 'Остаться', 'Ｈｏｍｅ']) : pick(['', null, 5]),
  }))
  const voterMap = Object.fromEntries(ids.map((id) => [id, pick([`account:${id}`, 'account:shared', '', 'bad id', undefined, 7])]))
  return {
    id: random.chance(0.96) ? pick(['decision-1', ' decision-2 ', 'd:3']) : junkId(),
    ...(random.chance(0.9) ? { type: pick(['vote', 'roll', 'choice', 'poll', undefined]) } : {}),
    title: pick([undefined, null, '', 'Куда идти?', 'x'.repeat(120)]), description: pick([undefined, 'Решайте.', 7]),
    options: random.chance(0.95) ? options : pick(JUNK),
    votes: random.chance(0.8) ? Object.fromEntries(random.some([...ids, 'z', 'bad id'], 5).map((id) => [id, pick([...optionIds, 'void', 5])])) : pick(JUNK),
    status: pick(['open', 'resolved', 'resolved', 'closed', undefined]), ...(random.chance(0.6) ? { resolvedOptionId: pick([...optionIds, null, 5]) } : {}),
    ...(random.chance(0.6) ? { [pick(['eligibleActorIds', 'eligible_actor_ids'])]: random.chance(0.9) ? ids : pick(JUNK) } : {}),
    ...(random.chance(0.5) ? { [pick(['voterByActorId', 'voter_by_actor_id'])]: voterMap } : {}),
    ...(random.chance(0.4) ? { [pick(['eligibleVoterIds', 'eligible_voter_ids'])]: random.some(['account:a', 'account:b', 'account:shared', 'hero:a', 'a', 'b'], 4) } : {}),
    ...(random.chance(0.4) ? { [pick(['abstentions', 'abstentionReasons'])]: Object.fromEntries(random.some(['account:a', 'hero:b', 'a', '2', 'bad id'], 3).map((id) => [id, pick(['explicit', 'disconnected', null, '', 7])])) } : {}),
    ...(random.chance(0.3) ? { [pick(['abstainedVoterIds', 'abstained_voter_ids'])]: random.some(['account:a', 'hero:b', 'a', 'b'], 3) } : {}),
    ...(random.chance(0.4) ? { [pick(['activeVoterIds', 'active_voter_ids'])]: random.some(['account:a', 'account:b', 'hero:a', 'hero:c', 'a', 'c'], 4) } : {}),
    ...(random.chance(0.6) ? { [pick(['createdAt', 'created_at'])]: pick([0, 1, 100, 1_000_000, -5, '200', 2 ** 53 - 1, 1.5, null]) } : {}),
    ...(random.chance(0.4) ? { [pick(['expiresAt', 'expires_at'])]: pick([0, 50, 130_000, 10 ** 13, '9', null]) } : {}),
    ...(random.chance(0.4) ? { [pick(['requiredVotes', 'required_votes'])]: pick([0, 1, 2, 9, -1, '2', null]) } : {}),
    ...(random.chance(0.4) ? { difficulty: pick([1, 12, 30, '14', null]) } : {}),
    ...(random.chance(0.3) ? { roll: pick([{ total: 10 }, [], 'x', null, 0]) } : {}),
    ...(random.chance(0.3) ? { [pick(['destinationLocationId', 'destination_location_id'])]: pick(['форт:Север', '', '  тракт  ']) } : {}),
    ...(random.chance(0.2) ? { questAbandonment: pick([{ schemaVersion: 1, questId: 'quest:second' }, { schemaVersion: 2, questId: 'q' }, { schemaVersion: 1, questId: 'bad id' }]) } : {}),
    ...(random.chance(0.2) ? { questAcceptance: pick([{ schemaVersion: 1, questId: 'quest:offer' }, { schemaVersion: 1 }]) } : {}),
    ...(random.chance(0.3) ? { resolutionPrompt: pick(['Решите', '', null]) } : {}),
    ...(random.chance(0.3) ? { resolutionReason: pick(['quorum', '', 'x'.repeat(90)]) } : {}),
    ...(random.chance(0.3) ? { policy: pick([{ voterScope: 'hero' }, { decisionTtlMs: 5_000 }, 'x']) } : {}),
  }
}
for (let index = 0; index < 700; index += 1) {
  const decision = random.chance(0.97) ? junkDecision() : pick(JUNK)
  const policy = random.chance(0.3) ? pick([{ voterScope: 'hero' }, { decisionTtlMs: 2_000 }, null]) : undefined
  c.call('normalizePartyDecision', (value, override) => P.normalizePartyDecision(value, override === undefined ? {} : { policy: override }), [decision, policy])
  if (index % 3 === 0) c.call('partyDecisionActiveVoterIds', P.partyDecisionActiveVoterIds, [decision, random.some(['a', 'b', 'c', '1', 'z', 5], 4)])
}

// ---------------------------------------------------------------------------
// Голосования целиком
// ---------------------------------------------------------------------------

const HERO_POOL = ['a', 'b', 'c', 'd', 'e', 'hero-a', 'hero-b', '1', '2', '10']
const apply = (state, events) => events.reduce((current, event) => applyGameEvent(current, plain(event)), state)

for (let flow = 0; flow < 420; flow += 1) {
  const heroes = random.shuffle(HERO_POOL).slice(0, random.int(1, 5))
  const scope = pick(['account', 'account', 'hero'])
  let state = normalizeCampaignState({
    partyMemberIds: random.chance(0.9) ? heroes : [],
    players: heroes.map((id) => ({ id, ...(random.chance(0.7) ? { character: `Герой ${id}` } : {}), ...(random.chance(0.3) ? { name: `Игрок ${id}` } : {}) })),
    partyDecisionPolicy: { decisionTtlMs: pick([10_000, 60_000, 120_000]), voterScope: scope },
  })
  const kind = pick(['vote', 'vote', 'choice', 'roll'])
  const optionCount = kind === 'roll' ? 2 : random.int(1, 4)
  const options = ['north', 'south', 'stay', 'camp'].slice(0, optionCount).map((id) => ({ id, label: `Вариант ${id}` }))
  const eligible = random.chance(0.8) ? heroes : heroes.slice(0, Math.max(1, heroes.length - 1))
  const sharedAccount = random.chance(0.3)
  const voterByHeroId = Object.fromEntries(eligible.map((id, index) => [id, sharedAccount && index < 2 ? 'account:shared' : `account:${id}`]))
  const createdAt = pick([100, 1_000, 5_000])
  const interaction = {
    id: `decision-${flow}`, type: kind, title: 'Куда идти?', description: '', options, votes: random.chance(0.3) ? { [heroes[0]]: 'north' } : {}, status: pick(['open', 'resolved']),
    resolvedOptionId: 'north', resolutionPrompt: '', createdAt, ...(kind === 'roll' ? { difficulty: pick([5, 10, 14, 20]) } : {}),
    ...(random.chance(0.2) ? { destinationLocationId: 'форт:Север' } : {}), ...(random.chance(0.1) ? { roll: { forged: true } } : {}),
  }
  const openOptions = {
    eligibleHeroIds: eligible,
    ...(scope === 'account' && random.chance(0.7) ? { eligibleVoterIds: [...new Set(Object.values(voterByHeroId))], voterByHeroId } : {}),
    ...(random.chance(0.5) ? { policy: { decisionTtlMs: pick([10_000, 30_000]), voterScope: scope } } : {}),
  }
  const opened = c.call('partyDecisionOpenedEvent', P.partyDecisionOpenedEvent, [interaction, random.chance(0.5) ? pick([heroes[0], null, '', 'bad id']) : undefined, openOptions])
  if (!opened) continue
  state = apply(state, [opened])
  let now = createdAt
  const length = random.int(2, 10)
  for (let step = 0; step < length; step += 1) {
    if (state.agentInteraction?.status !== 'open') break
    const current = trim(state)
    const hero = random.chance(0.9) ? pick(heroes) : pick(['outsider', 'bad id', ...heroes])
    const interactionId = random.chance(0.93) ? state.agentInteraction.id : pick(['other', 'bad id'])
    const action = kind === 'roll' ? pick(['roll', 'roll', 'vote', 'expiry', 'presence']) : pick(['vote', 'vote', 'vote', 'abstain', 'presence', 'expiry', 'active', 'roll'])
    let result
    if (action === 'vote') {
      result = c.call('resolvePartyVote', P.resolvePartyVote, [current, {
        interactionId, heroId: hero, optionId: random.chance(0.9) ? pick(options).id : pick(['void', 'bad id']),
        ...(random.chance(0.3) ? { eligibleHeroIds: random.chance(0.8) ? heroes : ['a'] } : {}),
      }])
    } else if (action === 'abstain') {
      result = c.call('resolvePartyAbstain', P.resolvePartyAbstain, [current, { interactionId, heroId: hero }])
    } else if (action === 'presence') {
      const voters = state.agentInteraction.activeVoterIds ?? []
      result = c.call('partyDecisionPresenceEvents', P.partyDecisionPresenceEvents, [current, { activeVoterIds: random.some([...voters, 'account:ghost'], voters.length) }])
    } else if (action === 'expiry') {
      now += pick([0, 1_000, 10_000, 200_000])
      result = c.call('partyDecisionExpiryEvents', (value, at) => P.partyDecisionExpiryEvents(value, { now: at }), [current, pick([now, now, String(now), 'x'])])
    } else if (action === 'active') {
      c.call('partyDecisionActiveVoterIds', P.partyDecisionActiveVoterIds, [current.agentInteraction, random.some([...heroes, 'z'], heroes.length + 1)])
    } else {
      const die = random.int(1, 20)
      result = c.call('resolvePartyRoll', P.resolvePartyRoll, [current, {
        interactionId, heroId: hero,
        roll: pick([{ roll_id: `roll-${flow}-${step}`, dice: [die], total: die, created_at: '2026-07-24T00:00:00.000Z' }, { id: 'r', dice: [die], total: die }, { total: die },
          { roll_id: 'r', dice: [0], total: die }, { roll_id: 'r', total: 25 }, { roll_id: 'r', dice: ['7'], total: '7', created_at: 'вчера' }, null]),
      }])
    }
    if (result?.events?.length) state = apply(state, result.events)
  }
}

// Сценарии `test/party-decision.test.mjs` на тех же входах, что и в тесте.
const base = {
  partyMemberIds: ['a', 'b', 'c', 'd'], players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
  agentInteraction: { id: 'decision-1', type: 'vote', title: 'Куда идти?', description: '', options: [{ id: 'north', label: 'На север' }, { id: 'south', label: 'На юг' }], votes: { a: 'north', b: 'north' }, status: 'open', resolutionPrompt: '', createdAt: 1 },
}
c.call('partyDecisionOpenedEvent', P.partyDecisionOpenedEvent, [{ ...base.agentInteraction, destinationLocationId: 'форт:Север', votes: { a: 'north' }, status: 'resolved', resolvedOptionId: 'north' }, 'a'])
// Порядок отказов: инициатор проверяется раньше самого решения.
for (const actor of ['bad id', 'a', null]) {
  for (const interaction of [{ id: 'bad id', options: [] }, { id: 'ok', options: [] }, { ...base.agentInteraction }, null]) {
    c.call('partyDecisionOpenedEvent', P.partyDecisionOpenedEvent, [interaction, actor, { eligibleHeroIds: ['a'] }])
  }
}
c.call('resolvePartyVote', P.resolvePartyVote, [base, { interactionId: 'decision-1', heroId: 'c', optionId: 'north', eligibleHeroIds: ['a', 'b', 'c', 'd'] }])
c.call('resolvePartyVote', P.resolvePartyVote, [base, { interactionId: 'decision-1', heroId: 'outsider', optionId: 'north', eligibleHeroIds: ['a', 'b', 'c', 'd'] }])
c.call('resolvePartyVote', P.resolvePartyVote, [base, { interactionId: 'decision-1', heroId: 'c', optionId: 'void', eligibleHeroIds: ['a', 'b', 'c', 'd'] }])
c.call('resolvePartyRoll', P.resolvePartyRoll, [{ ...base, agentInteraction: { ...base.agentInteraction, type: 'roll', difficulty: 14, eligibleActorIds: ['a', 'b'], options: [{ id: 'success', label: 'Success' }, { id: 'failure', label: 'Failure' }] } },
  { interactionId: 'decision-1', heroId: 'a', roll: { roll_id: 'roll-1', dice: [15], total: 15, created_at: '2026-07-24T00:00:00.000Z' } }])
for (const junk of [...JUNK.slice(0, 12), { agentInteraction: null }, { agentInteraction: 'x' }]) {
  c.call('resolvePartyVote', P.resolvePartyVote, [junk, { interactionId: 'decision-1', heroId: 'a', optionId: 'north' }])
  c.call('partyDecisionExpiryEvents', (value, at) => P.partyDecisionExpiryEvents(value, { now: at }), [junk, 10])
  c.call('partyDecisionPresenceEvents', P.partyDecisionPresenceEvents, [junk])
}

// ---------------------------------------------------------------------------
// Исполнение решений по поручению
// ---------------------------------------------------------------------------

for (let index = 0; index < 500; index += 1) {
  const persistent = random.chance(0.4)
  const quests = [
    { id: 'quest:first', title: 'Спасти купца', status: pick(['active', 'offered']), visibility: 'party', objectives: random.chance(0.5) ? ['Найти купца у брода'] : [] },
    { id: 'quest:second', title: 'Найти печать', summary: 'Печать архива пропала.', status: pick(['active', 'active', 'offered', 'completed']), visibility: pick(['party', 'public', 'gm_only']), objectives: random.chance(0.5) ? ['Осмотреть архив'] : undefined },
    { id: 'quest:offer', title: 'Охрана каравана', status: pick(['offered', 'active']), visibility: pick(['party', 'public']), ...(random.chance(0.3) ? { responsibility: { type: 'npc', npc_id: 'npc:merchant', death_policy: 'impossible' } } : {}) },
    { id: 'quest:chapter:1', title: pick(['Найти печать', 'Осмотреться']), status: pick(['active', 'completed']), visibility: 'party' },
  ]
  const target = pick(['quest:first', 'quest:second', 'quest:offer', 'quest:chapter:1', 'quest:missing'])
  const acceptance = random.chance(0.5)
  const interaction = {
    id: 'decision-quest', type: 'vote', title: 'Решение', options: acceptance ? [{ id: 'accept', label: 'Принять' }, { id: 'later', label: 'Позже' }] : [{ id: 'keep', label: 'Оставить' }, { id: 'abandon', label: 'Отказаться' }],
    status: pick(['resolved', 'resolved', 'resolved', 'resolved', 'open']), resolvedOptionId: pick(acceptance ? ['accept', 'accept', 'later', 'abandon'] : ['abandon', 'abandon', 'keep', 'accept']),
    ...(acceptance ? { questAcceptance: { schemaVersion: 1, questId: target } } : { questAbandonment: { schemaVersion: 1, questId: target } }),
    ...(random.chance(0.05) ? { questAcceptance: { schemaVersion: 1, questId: 'quest:offer' }, questAbandonment: { schemaVersion: 1, questId: 'quest:first' } } : {}),
  }
  const raw = {
    sessionCode: 'QUEST-CHOICE', partyMemberIds: ['hero-a', 'hero-b'], players: [{ id: 'hero-a' }, { id: 'hero-b' }],
    scene: { location: 'Тихий Брод', location_id: 'ford', objective: pick(['Найти печать', 'Спасти купца', 'Осмотреть архив', 'Другое']), cells: [] },
    adventure: { chapter: pick([1, 2]), currentHook: pick(['Найти печать', 'печать архива пропала.', 'Другое']) },
    campaignConcept: persistent ? { campaign_mode: 'persistent', story_quest_id: pick([null, 'quest:first', undefined]) } : undefined,
    worldMemory: { quests },
    npc_world: random.chance(0.3) ? { vitals: { 'npc:merchant': { alive: false } }, stances: {} } : undefined,
  }
  const state = trim({ ...normalizeCampaignState(raw), agentInteraction: interaction })
  const command = { command_type: 'ResolveQuestDecision', interaction_id: random.chance(0.93) ? 'decision-quest' : 'other', ...(random.chance(0.8) ? { command_id: `cmd-${index}` } : {}), ...(random.chance(0.3) ? { actor_id: 'hero-a' } : {}) }
  const context = pick([{ isDirector: true }, { isDirector: true }, { isDirector: true }, { isDirector: true }, { isDirector: true }, { isDirector: true }, { isAdmin: true }, {}])
  c.call('questDecisionEvents', P.questDecisionEvents, [command, state, context])
}

write('party-decision.json', {
  constants: { PARTY_DECISION_POLICY_VERSION: P.PARTY_DECISION_POLICY_VERSION, DEFAULT_PARTY_DECISION_POLICY: P.DEFAULT_PARTY_DECISION_POLICY },
  cases: c.cases, values: c.values, skipped: c.skipped,
})
