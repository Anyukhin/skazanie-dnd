import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NARRATOR_FEW_SHOT_CORPUS,
  Narrator,
  deterministicNarration,
  narratorArcRecap,
  narratorContentDirectives,
  selectNarratorFewShotExamples,
  sensoryAnchorsFor,
} from '../server/narrator.mjs'
import { campaignConceptForAgent } from '../server/agent-context.mjs'
import {
  NPC_NARRATOR_DOSSIER_LIMITS,
  npcDossiersForNarrator,
} from '../server/npc-social.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

function experienceBrief() {
  return buildNarrationBrief({
    visible_events: [{
      event_type: 'AbilityCheckResolved',
      actor_id: 'hero:ada',
      payload: { ability: 'wisdom', success: true },
      source_rule_ids: ['srd:ability-check'],
      visibility: 'public',
    }],
    visible_state_changes: [],
    known_environment: {
      campaign_premise: {
        tone: 'тёплая загадка без мрачного пафоса',
        themes: 'память, долг и доверие',
        boundaries: 'Без сексуального насилия и пыток; жестокость без натуралистичных подробностей.',
      },
      scene: {
        id: 'scene:empty-cup',
        title: 'Вечер в «Пустом кубке»',
        location: 'Трактир «Пустой кубок»',
        mood: 'настороженно, но тепло',
      },
      story_context: {
        heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }],
        present_npcs: [],
        active_quests: [],
        active_threads: [],
        recent_summaries: [],
        recent_decisions: [],
        open_promises: [],
        recent_interactions: [],
      },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

function secondArcBrief({ includeTransition = true } = {}) {
  const state = {
    adventure: { chapter: 1 },
    campaignConcept: {
      arc: { arc_number: 2 },
      arc_history: [{
        arc_number: 1,
        title: 'Буря над Северным трактом',
        epilogue: 'Буря стихла, а спасённый караван вернулся к Северным воротам.',
        concluded_at: '2026-07-31T18:00:00.000Z',
      }],
    },
  }
  return buildNarrationBrief({
    visible_events: includeTransition
      ? [{
          event_type: 'CampaignArcCompleted',
          payload: {
            closed_arc: { arc_number: 1 },
            next_arc: { arc_number: 2 },
            epilogue: state.campaignConcept.arc_history[0].epilogue,
          },
          visibility: 'party',
        }]
      : [],
    visible_state_changes: [],
    known_environment: {
      campaign_premise: campaignConceptForAgent(state),
      scene: {
        id: 'scene:arc-two-opening',
        title: 'Первая дорога новой арки',
        location: 'Северные ворота',
      },
      story_context: {
        heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }],
        present_npcs: [],
        active_quests: [],
        active_threads: [],
        recent_summaries: [],
        recent_decisions: [],
        open_promises: [],
        recent_interactions: [],
      },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

test('few-shot корпус содержит 36 размеченных примеров и выбирает три из одного пресета', () => {
  assert.equal(NARRATOR_FEW_SHOT_CORPUS.length, 36)
  assert.equal(new Set(NARRATOR_FEW_SHOT_CORPUS.map((example) => example.id)).size, 36)
  for (const style of ['neutral', 'formal', 'ironic']) {
    assert.equal(NARRATOR_FEW_SHOT_CORPUS.filter((example) => example.style === style).length, 12)
    const selected = selectNarratorFewShotExamples(experienceBrief(), { style })
    assert.equal(selected.length, 3)
    assert.ok(selected.every((example) => example.style === style))
    assert.ok(selected.filter((example) => example.moment === 'action').length >= 2)
  }
})

test('тон, темы и границы приходят отдельными обязательными данными', async () => {
  const brief = experienceBrief()
  const requests = []
  const llmClient = {
    completeJson: async (input) => {
      requests.push(input)
      return { narration: deterministicNarration(brief).narration }
    },
  }
  const result = await new Narrator({ llmClient }).render(brief, {
    knownRuleIds: ['srd:ability-check'],
  })

  assert.deepEqual(narratorContentDirectives(brief), {
    tone: 'тёплая загадка без мрачного пафоса',
    themes: 'память, долг и доверие',
    boundaries: 'Без сексуального насилия и пыток; жестокость без натуралистичных подробностей.',
  })
  const data = requests[0].messages[1].content
  assert.match(data, /UNTRUSTED_DATA:content_preferences/u)
  assert.match(data, /тёплая загадка без мрачного пафоса/u)
  assert.match(data, /память, долг и доверие/u)
  assert.match(data, /Без сексуального насилия и пыток/u)
  assert.equal(result.verification.valid, true)
})

test('явное нарушение content boundaries блокируется до показа', async () => {
  const brief = experienceBrief()
  const llmClient = {
    completeJson: async () => ({
      narration: 'Пленника подвергают пыткам, подробно описывая каждую рану.',
    }),
  }
  const result = await new Narrator({ llmClient }).render(brief, {
    knownRuleIds: ['srd:ability-check'],
  })

  assert.equal(result.provider, 'deterministic-fallback')
  assert.doesNotMatch(result.narration, /пытк/iu)
  assert.ok(result.verification.repaired_from
    .some((entry) => entry.code === 'CONTENT_BOUNDARY_VIOLATION'))
})

test('сенсорные якоря стабильны для локации и переиспользуются в fallback и prompt', async () => {
  const brief = experienceBrief()
  const first = sensoryAnchorsFor(brief)
  const second = sensoryAnchorsFor(structuredClone(brief))
  assert.deepEqual(second, first)
  assert.equal(Object.values(first).filter(Boolean).length, 4)

  let userPrompt = ''
  const llmClient = {
    completeJson: async ({ messages }) => {
      userPrompt = messages[1].content
      return { narration: deterministicNarration(brief).narration }
    },
  }
  const narrator = new Narrator({ llmClient })
  const result = await narrator.render(brief, { knownRuleIds: ['srd:ability-check'] })
  const feedback = await narrator.awaitFeedback(result.narration)

  assert.match(userPrompt, /UNTRUSTED_DATA:sensory_anchors/u)
  assert.ok(Object.values(first).some((anchor) => userPrompt.includes(anchor)))
  assert.ok(Object.values(first).some((anchor) => result.narration.toLocaleLowerCase('ru')
    .includes(anchor.toLocaleLowerCase('ru'))))
  assert.equal(feedback.violations.some((entry) => entry.code === 'SENSORY_ANCHOR_OMITTED'), false)
})

test('художественный verifier не задерживает текущий ответ и применяется следующим ходом', async () => {
  const brief = experienceBrief()
  const shown = deterministicNarration(brief).narration
  let resolveFeedback
  const feedbackGate = new Promise((resolve) => { resolveFeedback = resolve })
  let providerCalls = 0
  const narrator = new Narrator({
    llmClient: {
      completeJson: async () => {
        providerCalls += 1
        return { narration: shown }
      },
    },
    feedbackVerifier: () => feedbackGate,
  })

  const first = await narrator.render(brief, { knownRuleIds: ['srd:ability-check'] })
  assert.equal(first.narration, shown)
  assert.equal(providerCalls, 1)
  assert.equal(first.verification.feedback_pending, true)

  const secondPromise = narrator.render(brief, {
    knownRuleIds: ['srd:ability-check'],
    recentNarrations: [first.narration],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(providerCalls, 1, 'следующий ход ждёт уже запущенный verdict, а не создаёт второй вызов прошлого хода')

  resolveFeedback({
    valid: false,
    violations: [{ code: 'STYLE_FEEDBACK', message: 'Сменить ритм', match: 'повтор' }],
  })
  const second = await secondPromise
  assert.equal(providerCalls, 2)
  assert.equal(second.verification.feedback_applied[0].violations[0].code, 'STYLE_FEEDBACK')
})

test('первое повествование второй арки получает recap из arc_history', async () => {
  const brief = secondArcBrief()
  const recap = narratorArcRecap(brief)
  assert.equal(recap.arc_number, 1)
  assert.match(recap.epilogue, /Буря стихла/u)

  const requests = []
  const expected = deterministicNarration(brief).narration
  const narrator = new Narrator({
    llmClient: {
      completeJson: async (input) => {
        requests.push(input)
        return { narration: expected }
      },
    },
  })
  const result = await narrator.render(brief)
  const data = requests[0].messages[1].content

  assert.equal(result.provider, 'Object')
  assert.match(result.narration, /^В прошлый раз:/u)
  assert.match(result.narration, /Буря стихла/u)
  assert.match(result.narration, /Теперь:/u)
  assert.doesNotMatch(result.narration, /CampaignArcCompleted/u)
  assert.match(data, /UNTRUSTED_DATA:previous_arc_recap/u)
  assert.match(data, /campaign_premise\.arc_history|Буря стихла/u)
  assert.deepEqual(result.verification.arc_recap, {
    source: 'campaign_premise.arc_history',
    arc_number: 1,
  })
})

test('первый обычный ход новой арки получает recap без события перехода и не повторяет его', async () => {
  const firstBrief = secondArcBrief({ includeTransition: false })
  const narrator = new Narrator({
    llmClient: {
      completeJson: async () => ({ narration: 'Теперь: партия выбирает новую дорогу.' }),
    },
  })
  const first = await narrator.render(firstBrief)
  assert.equal(first.provider, 'deterministic-fallback')
  assert.match(first.narration, /^В прошлый раз:/u)
  assert.ok(first.verification.repaired_from.some((entry) => entry.code === 'ARC_RECAP_OMITTED'))

  const laterBrief = secondArcBrief({ includeTransition: false })
  assert.equal(
    narratorArcRecap(laterBrief, {
      includeOpeningArc: true,
      recentNarrations: [first.narration],
    }),
    null,
  )
  assert.doesNotMatch(
    deterministicNarration(laterBrief, undefined, { recentNarrations: [first.narration] }).narration,
    /В прошлый раз/iu,
  )

  const second = await narrator.render(laterBrief)
  assert.equal(second.provider, 'Object')
  assert.doesNotMatch(second.narration, /В прошлый раз/iu)
})

function npcDossierBrief({
  currentConversation = null,
  interactions = [],
  promises = [],
  dossiers = [],
  relationship = 'neutral',
} = {}) {
  return buildNarrationBrief({
    visible_events: currentConversation
      ? [{
          event_type: 'NpcConversationRecorded',
          payload: { conversation: currentConversation },
          target_ids: ['npc:marta', 'hero:ada'],
          visibility: 'party',
        }]
      : [],
    visible_state_changes: [],
    known_environment: {
      scene: { id: 'scene:market', location: 'Рыночная площадь' },
      campaign_premise: {},
      story_context: {
        heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }],
        present_npcs: [{
          id: 'npc:marta',
          name: 'Марта',
          relationship,
          beliefs: ['PRIVATE_BELIEF'],
          rumors: ['PRIVATE_RUMOR'],
        }, {
          id: 'npc:other',
          name: 'Орвин',
          relationship: 'trusted',
        }],
        active_quests: [],
        active_threads: [],
        recent_summaries: [],
        recent_decisions: [],
        open_promises: promises,
        recent_interactions: interactions,
        npc_dossiers: dossiers,
      },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

test('NPC dossier distinguishes first meeting from return and reaches Narrator with provenance', async () => {
  const currentConversation = {
    npc_id: 'npc:marta',
    hero_id: 'hero:ada',
    player_message: 'Мы прежде встречались?',
    npc_reply: 'Нет, я бы вас запомнила.',
  }
  const firstMeeting = npcDossierBrief({
    currentConversation,
    interactions: [{
      npc: 'Марта',
      hero: 'Ада',
      player_message: currentConversation.player_message,
      npc_reply: currentConversation.npc_reply,
      stance: 'neutral',
    }],
  })
  assert.deepEqual(npcDossiersForNarrator(firstMeeting), [])

  const returning = npcDossierBrief({
    relationship: 'friendly',
    interactions: [{
      npc: 'Марта',
      hero: 'Ада',
      player_message: 'Спрячьте реестр до рассвета.',
      npc_reply: 'Он будет под третьей половицей.',
      stance: 'guarded',
    }, {
      npc: 'Марта',
      hero: 'Чужой герой',
      hero_id: 'hero:other',
      player_message: 'PRIVATE_OTHER_HERO_MESSAGE',
      npc_reply: 'PRIVATE_OTHER_HERO_REPLY',
      stance: 'guarded',
      visibility: 'specific_player',
    }],
    promises: [{
      id: 'promise:ledger',
      npc: 'Марта',
      direction: 'npc_to_party',
      text: 'Марта сохранит реестр до рассвета.',
      due_hint: 'до рассвета',
      source_conversation_id: 'conversation:ledger',
    }],
    dossiers: [{
      npc_id: 'npc:marta',
      name: 'Марта',
      relationship: {
        tier: 'friendly',
        provenance: { source_event_ids: ['event:relationship:1'] },
      },
      interactions: [{
        id: 'interaction:conversation:ledger',
        hero_id: 'hero:ada',
        summary: 'Герой попросил спрятать реестр. Марта согласилась убрать его под третью половицу.',
        stance: 'guarded',
        epistemic_status: 'contains_unverified_claims',
        disclosed_claims: [{
          id: 'claim:ledger-owner',
          truth_status: 'verified',
        }],
        provenance: {
          source_conversation_id: 'conversation:ledger',
          source_event_ids: ['event:conversation:ledger'],
        },
      }, {
        id: 'interaction:conversation:private',
        hero_id: 'hero:other',
        summary: 'PRIVATE_OTHER_HERO_DOSSIER',
        visibility: 'specific_player',
        provenance: {
          source_conversation_id: 'conversation:private',
          source_event_ids: ['event:conversation:private'],
        },
      }],
      promises: [{
        id: 'promise:ledger',
        direction: 'npc_to_party',
        text: 'Марта сохранит реестр до рассвета.',
        due_hint: 'до рассвета',
        source_conversation_id: 'conversation:ledger',
      }],
      beliefs: ['PRIVATE_DOSSIER_BELIEF'],
      rumors: ['PRIVATE_DOSSIER_RUMOR'],
    }],
  })
  const dossiers = npcDossiersForNarrator(returning)
  assert.equal(dossiers.length, 1)
  assert.equal(dossiers[0].name, 'Марта')
  assert.equal(dossiers[0].relationship.tier, 'friendly')
  assert.equal(dossiers[0].interactions[0].epistemic_status, 'contains_unverified_claims')
  assert.deepEqual(dossiers[0].interactions[0].disclosed_claims, [{
    id: 'claim:ledger-owner',
    truth_status: 'unknown',
  }])
  assert.equal(dossiers[0].promises[0].provenance.source_id, 'promise:ledger')
  assert.equal(dossiers[0].interactions[0].provenance.source_kind, 'NpcConversationRecorded')
  assert.deepEqual(dossiers[0].interactions[0].provenance.source_event_ids, ['event:conversation:ledger'])
  assert.doesNotMatch(
    JSON.stringify(dossiers),
    /PRIVATE_BELIEF|PRIVATE_RUMOR|PRIVATE_DOSSIER|PRIVATE_OTHER_HERO/u,
  )

  const requests = []
  const narrator = new Narrator({
    llmClient: {
      completeJson: async (input) => {
        requests.push(input)
        return deterministicNarration(returning)
      },
    },
  })
  await narrator.render(returning)
  const promptData = requests[0].messages[1].content
  assert.match(promptData, /UNTRUSTED_DATA:npc_dossiers/u)
  assert.match(promptData, /NpcConversationRecorded|contains_unverified_claims/u)
  assert.doesNotMatch(
    promptData,
    /PRIVATE_BELIEF|PRIVATE_RUMOR|PRIVATE_DOSSIER|PRIVATE_OTHER_HERO/u,
  )
})

test('Narrator NPC dossier is deterministically bounded and deduplicated to the current return', () => {
  const interactions = Array.from({ length: 12 }, (_, index) => ({
    id: `interaction:${index % 5}`,
    hero_id: 'hero:ada',
    summary: `Разговор ${index % 5}`,
    stance: 'friendly',
    visibility: index === 10 ? 'gm_only' : 'party',
    beliefs: ['PRIVATE_BELIEF'],
    provenance: {
      source_conversation_id: `conversation:${index % 5}`,
      source_event_ids: [`event:conversation:${index % 5}`],
    },
  }))
  const promises = Array.from({ length: 5 }, (_, index) => ({
    id: `promise:${index % 3}`,
    direction: 'npc_to_party',
    text: `Обещание ${index % 3}`,
    source_conversation_id: `conversation:${index % 3}`,
  }))
  const brief = npcDossierBrief({
    interactions: [{ npc: 'Марта', player_message: 'Не использовать как досье' }],
    promises: [{ id: 'recent:promise', npc: 'Марта', text: 'Не использовать как досье' }],
    relationship: 'trusted',
    dossiers: [{
      npc_id: 'npc:other',
      name: 'Орвин',
      relationship: {
        tier: 'trusted',
        provenance: { source_event_ids: ['event:relationship:orvin'] },
      },
      interactions,
      promises,
    }, {
      npc_id: 'npc:marta',
      name: 'Марта',
      relationship: { tier: 'friendly' },
      interactions: [{
        id: 'interaction:marta',
        summary: 'Эта запись не должна попасть из-за лимита NPC.',
        provenance: { source_conversation_id: 'conversation:marta' },
      }],
    }],
  })
  const first = npcDossiersForNarrator(brief)
  const second = npcDossiersForNarrator(structuredClone(brief))

  assert.deepEqual(second, first)
  assert.equal(first.length, NPC_NARRATOR_DOSSIER_LIMITS.npcs)
  assert.equal(first[0].name, 'Орвин', 'берётся NPC самой свежей повторной встречи, а не все присутствующие')
  assert.ok(first[0].interactions.length <= NPC_NARRATOR_DOSSIER_LIMITS.interactions)
  assert.ok(first[0].promises.length <= NPC_NARRATOR_DOSSIER_LIMITS.promises)
  assert.ok(JSON.stringify(first).length < 4_000)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_BELIEF/u)
})
