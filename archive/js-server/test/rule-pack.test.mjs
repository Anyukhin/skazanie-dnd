import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RulePackValidationError,
  assertTranslationNumericIntegrity,
  checkTranslationNumericIntegrity,
  extractMechanicalTokens,
  loadRulePack,
  parseGlossaryCsv,
  parseMetadataYaml,
  validateRulePack,
} from '../server/rule-pack.mjs'

test('loads and validates the bilingual P0 rule pack', async () => {
  const pack = await loadRulePack('srd_5_2_1')

  assert.deepEqual(pack.summary, {
    ruleset_id: 'srd_5_2_1',
    pack_id: 'srd_5_2_1',
    rule_count: 23,
    glossary_term_count: 25,
    ontology_edge_count: 23,
  })
  assert.equal(pack.manifest.canonical_language, 'en')
  assert.deepEqual(pack.manifest.display_languages, ['ru', 'en'])
  assert.equal(new Set(pack.rules.map((rule) => rule.id)).size, pack.rules.length)
  assert.ok(pack.rules.every((rule) => rule.ruleset_id === pack.manifest.ruleset_id))
  assert.ok(pack.rules.every((rule) => rule.title_en && rule.title_ru && rule.text_en && rule.text_ru))
  assert.ok(pack.rules.every((rule) => rule.license_id === 'ORIGINAL-PARAPHRASE'))
  assert.ok(Object.isFrozen(pack))
  assert.ok(Object.isFrozen(pack.rules[0]))
})

test('loads the Russian-canonical D&D 5e 2014 cutover pack with pinned source references', async () => {
  const pack = await loadRulePack('dnd_5e_2014')

  assert.deepEqual(pack.summary, {
    ruleset_id: 'dnd_5e_2014',
    pack_id: 'dnd_5e_2014',
    rule_count: 28,
    glossary_term_count: 34,
    ontology_edge_count: 32,
    source_count: 10,
  })
  assert.equal(pack.manifest.canonical_language, 'ru')
  assert.equal(pack.manifest.edition_family, '5e_2014')
  assert.equal(pack.manifest.activation_status, 'preview')
  assert.equal(pack.sourceRegistry.content_policy.copyrighted_page_text, 'not_bundled')
  assert.ok(pack.sourceRegistry.sources.every((source) => source.url.startsWith('https://5e14.dnd.su/')))
  assert.ok(pack.sourceRegistry.sources.every((source) => source.bundled === false))
  assert.ok(pack.rules.every((rule) => rule.source_ref && rule.source_hash))
  assert.ok(pack.rules.some((rule) => rule.id === 'dnd_5e_2014:environment:suffocation'
    && rule.text_ru.includes('опускаются до 0')))
  assert.ok(pack.rules.some((rule) => rule.id === 'dnd_5e_2014:classes:fighter-indomitable'
    && !rule.text_ru.includes('бонусом, равным уровню')))
  assert.ok(Object.isFrozen(pack.sourceRegistry))
})

test('formalization metadata matches the implemented P0 coverage report', async () => {
  const pack = await loadRulePack('srd_5_2_1')
  const counts = pack.rules.reduce((result, rule) => ({ ...result, [rule.formalization_level]: (result[rule.formalization_level] || 0) + 1 }), {})
  assert.equal(counts.deterministic, pack.coverage.deterministic_rule_count)
  assert.equal(counts.structured, pack.coverage.structured_rule_count)
  assert.equal(counts.retrieval_only ?? 0, pack.coverage.retrieval_only_rule_count)
})

test('mechanical number signatures preserve dice, modifiers, fractions, and DC values', () => {
  assert.deepEqual(
    extractMechanicalTokens('Roll 2d6 + 3, compare DC 10, then apply 1/2 or 50%.'),
    ['1/2', '10', '2d6+3', '50%'],
  )

  const valid = checkTranslationNumericIntegrity(
    'Roll 2d6 + 3 and compare the total with DC 10.',
    'Бросьте 2d6 + 3 и сравните итог со СЛ 10.',
  )
  assert.equal(valid.ok, true)

  const invalid = checkTranslationNumericIntegrity(
    'Roll 2d6 + 3 and compare the total with DC 10.',
    'Бросьте 2d8 + 3 и сравните итог со СЛ 10.',
  )
  assert.equal(invalid.ok, false)
  assert.deepEqual(invalid.missing, ['2d6+3'])
  assert.deepEqual(invalid.extra, ['2d8+3'])
})

test('every stored translation passes numeric integrity', async () => {
  const pack = await loadRulePack('srd_5_2_1')
  for (const rule of pack.rules) assert.equal(assertTranslationNumericIntegrity(rule).ok, true, rule.id)
})

test('validation rejects a translated mechanical number change', async () => {
  const pack = structuredClone(await loadRulePack('srd_5_2_1'))
  const target = pack.rules.find((rule) => rule.id.endsWith('advantage-disadvantage'))
  target.text_ru = target.text_ru.replace('2d20', '2d12')

  assert.throws(
    () => validateRulePack(pack, { expectedRulesetId: 'srd_5_2_1' }),
    (error) => error instanceof RulePackValidationError
      && /changes mechanical numbers/.test(error.message)
      && error.details.rule_id === target.id,
  )
})

test('validation strictly rejects rules and ontology edges from another ruleset', async () => {
  const mixedRulePack = structuredClone(await loadRulePack('srd_5_2_1'))
  mixedRulePack.rules[0].ruleset_id = 'other_edition'
  assert.throws(() => validateRulePack(mixedRulePack), /belongs to other_edition/)

  const mixedOntologyPack = structuredClone(await loadRulePack('srd_5_2_1'))
  mixedOntologyPack.ontologyEdges[0].ruleset_id = 'other_edition'
  assert.throws(() => validateRulePack(mixedOntologyPack), /mixes other_edition/)
})

test('source registry rejects an unknown or mismatched rule source revision', async () => {
  const unknown = structuredClone(await loadRulePack('dnd_5e_2014'))
  unknown.rules[0].source_ref = 'dndsu-2014-unknown'
  assert.throws(() => validateRulePack(unknown), /references unknown source/)

  const mismatched = structuredClone(await loadRulePack('dnd_5e_2014'))
  mismatched.rules[0].source_hash = 'another-revision'
  assert.throws(() => validateRulePack(mismatched), /source revision does not match/)
})

test('loader rejects invalid and unavailable ruleset ids without path traversal', async () => {
  await assert.rejects(() => loadRulePack('../srd_5_2_1'), /Invalid ruleset_id/)
  await assert.rejects(() => loadRulePack('not_installed_ruleset'), /Unable to read rule pack/)
})

test('metadata and glossary parsers are strict and deterministic', () => {
  assert.deepEqual(parseMetadataYaml('ruleset_id: demo\nlanguages:\n  - ru\n  - en\ncount: 2\n'), {
    ruleset_id: 'demo',
    languages: ['ru', 'en'],
    count: 2,
  })
  assert.throws(() => parseMetadataYaml('root:\n  nested: value\n'), /nested YAML is not supported/)

  const glossary = parseGlossaryCsv('canonical_id,term_en,term_ru,aliases_ru,notes\nterm:test,check,проверка,"чек|тест",note\n')
  assert.deepEqual(glossary, [{
    canonical_id: 'term:test',
    term_en: 'check',
    term_ru: 'проверка',
    aliases_ru: ['чек', 'тест'],
    notes: 'note',
  }])
})
