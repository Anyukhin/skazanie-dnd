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
