import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRulePack } from '../server/rule-pack.mjs'
import {
  RuleRetriever,
  deterministicLocalVector,
  normalizeForSearch,
  tokenizeForSearch,
} from '../server/rule-retriever.mjs'

const RULESET_ID = 'srd_5_2_1'

async function makeRetriever() {
  return new RuleRetriever(await loadRulePack(RULESET_ID))
}

const retrievalCases = [
  ['Как работает помеха?', 'srd_5_2_1:core:advantage-disadvantage'],
  ['Можно ли сделать реакцию?', 'srd_5_2_1:combat:reaction'],
  ['Что происходит при нуле хитов?', 'srd_5_2_1:combat:zero-hit-points'],
  ['Нужно ли держать концентрацию?', 'srd_5_2_1:spells:concentration'],
  ['У меня преимущество на атаку?', 'srd_5_2_1:core:advantage-disadvantage'],
  ['Без помехи на броске атаки', 'srd_5_2_1:core:advantage-disadvantage'],
  ['Помехха на атаке', 'srd_5_2_1:core:advantage-disadvantage'],
  ['Концентрацыя', 'srd_5_2_1:spells:concentration'],
  ['How do death saving throws work at zero hp?', 'srd_5_2_1:combat:zero-hit-points'],
  ['Can I use a reaction after an attack?', 'srd_5_2_1:combat:reaction'],
  ['Можно use reaction after attack?', 'srd_5_2_1:combat:reaction'],
  ['Бросаю два d20 и беру худший', 'srd_5_2_1:core:advantage-disadvantage'],
  ['Пытаюсь выплыть из бурной воды', 'srd_5_2_1:environment:swimming'],
  ['Сколько герой может задерживать дыхание до удушья?', 'srd_5_2_1:environment:suffocation'],
  ['Сколько серебряных монет в одной золотой?', 'srd_5_2_1:economy:coins'],
  ['За сколько торговец выкупает обычное снаряжение?', 'srd_5_2_1:economy:selling-equipment'],
  ['Как работает Аура защиты паладина?', 'srd_5_2_1:classes:paladin-aura-of-protection'],
  ['Как воин использует Несгибаемого после провала спасброска?', 'srd_5_2_1:classes:fighter-indomitable'],
]

for (const [query, expectedRuleId] of retrievalCases) {
  test(`retrieves ${expectedRuleId} for “${query}”`, async () => {
    const retriever = await makeRetriever()
    const result = await retriever.search({
      queries: [query],
      ruleset_id: RULESET_ID,
      enabled_packs: [RULESET_ID],
      limit: 5,
    })
    assert.equal(result.results[0]?.rule_id, expectedRuleId)
    assert.ok(result.results.every((entry) => entry.ruleset_id === RULESET_ID))
  })
}

test('normalization covers Russian inflection while preserving mixed-language terms', () => {
  assert.equal(normalizeForSearch('  ПОМЕХОЙ, Reaction!  '), 'помехой reaction')
  assert.deepEqual(
    tokenizeForSearch('с помехой и помеха reaction reactions').map((token) => token.stem),
    ['помех', 'помех', 'reaction', 'reaction'],
  )
})

test('local vectors are deterministic and react to changed text', () => {
  const first = [...deterministicLocalVector('проверка concentration')]
  const second = [...deterministicLocalVector('проверка concentration')]
  const different = [...deterministicLocalVector('урон damage')]
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, different)
  const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))
  assert.ok(Math.abs(magnitude - 1) < 1e-12)
})

test('ontology expands a direct concentration hit to its saving-throw neighbor', async () => {
  const retriever = await makeRetriever()
  const result = await retriever.search({ queries: ['концентрация'], rulesetId: RULESET_ID, limit: 5 })
  assert.equal(result.results[0].rule_id, 'srd_5_2_1:spells:concentration')
  const savingThrow = result.results.find((entry) => entry.rule_id === 'srd_5_2_1:checks:saving-throw')
  assert.ok(savingThrow)
  assert.ok(savingThrow.score_breakdown.ontology > 0)
  assert.ok(savingThrow.ontology_reasons.some((reason) => reason.from_rule_id.endsWith(':spells:concentration')))
})

function foreignPack() {
  const rulesetId = 'foreign_edition'
  const ruleId = `${rulesetId}:core:quantum-flumph`
  return {
    manifest: {
      ruleset_id: rulesetId,
      pack_id: rulesetId,
      edition_family: 'foreign',
      version: '1.0.0',
      canonical_language: 'en',
      display_languages: ['ru', 'en'],
      license_id: 'ORIGINAL-PARAPHRASE',
      created_at: '2026-07-11T00:00:00Z',
      verified_at: '2026-07-11T00:00:00Z',
    },
    rules: [{
      id: ruleId,
      ruleset_id: rulesetId,
      version: '1.0.0',
      kind: 'rule',
      section_path: ['Core'],
      title_en: 'Quantum Flumph Protocol',
      title_ru: 'Квантовый протокол флумфа',
      text_en: 'Invoke the quantum flumph protocol.',
      text_ru: 'Примените квантовый протокол флумфа.',
      tags: ['foreign'],
      entity_refs: ['term:quantum-flumph'],
      aliases_en: ['quantum flumph'],
      aliases_ru: ['квантовый флумф'],
      formalization_level: 'retrieval_only',
      source_page_start: 0,
      source_page_end: 0,
      source_hash: 'orig-foreign',
      license_id: 'ORIGINAL-PARAPHRASE',
    }],
    glossary: [{
      canonical_id: 'term:quantum-flumph',
      term_en: 'quantum flumph',
      term_ru: 'квантовый флумф',
      aliases_ru: ['флумф'],
      notes: '',
    }],
    ontologyEdges: [],
    coverage: {
      ruleset_id: rulesetId,
      rule_count: 1,
      glossary_term_count: 1,
      ontology_edge_count: 0,
    },
  }
}

test('ruleset and enabled-pack filters never mix editions', async () => {
  const basePack = await loadRulePack(RULESET_ID)
  const retriever = new RuleRetriever([basePack, foreignPack()])

  const baseResult = await retriever.search({
    queries: ['quantum flumph помеха'],
    ruleset_id: RULESET_ID,
    enabled_packs: [RULESET_ID],
    limit: 20,
  })
  assert.ok(baseResult.results.length > 0)
  assert.ok(baseResult.results.every((entry) => entry.ruleset_id === RULESET_ID))
  assert.ok(baseResult.results.every((entry) => !entry.rule_id.includes('foreign_edition')))

  const foreignResult = await retriever.search({
    queries: ['quantum flumph'],
    ruleset_id: 'foreign_edition',
    enabled_packs: ['foreign_edition'],
  })
  assert.equal(foreignResult.results[0].rule_id, 'foreign_edition:core:quantum-flumph')

  await assert.rejects(
    () => retriever.search({ queries: ['помеха'], ruleset_id: RULESET_ID, enabled_packs: ['foreign_edition'] }),
    /belongs to foreign_edition, not requested srd_5_2_1/,
  )
  await assert.rejects(() => retriever.search({ queries: ['помеха'], ruleset_id: 'missing' }), /Unknown ruleset_id/)
  await assert.rejects(() => retriever.search({ queries: ['помеха'] }), /ruleset_id is required/)
})

test('same request produces stable ids, ordering, scores, and explanations', async () => {
  const retriever = await makeRetriever()
  const request = {
    queries: ['атака с преимуществом', 'advantage on attack'],
    ruleset_id: RULESET_ID,
    enabled_packs: [RULESET_ID],
    limit: 8,
  }
  const first = await retriever.search(request)
  const second = await retriever.search(request)
  assert.deepEqual(first, second)
  assert.ok(first.results.every((entry, index, results) => index === 0 || results[index - 1].score >= entry.score))
})
