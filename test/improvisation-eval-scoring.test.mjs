import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  CATEGORY_LABELS,
  IMPROVISATION_CASES,
  expectationMisses,
  scoreImprovisationRun,
  structuralIssues,
} from '../eval/improvisation-scenarios.mjs'

/**
 * Скоринг замера импровизаций — обычный детерминированный код, и он обязан
 * ловить ровно то, ради чего заведён: отказ на выполнимой задумке и
 * `impossible_without_means` без названного средства. Сеть здесь не нужна.
 */

const valid = (overrides = {}) => ({
  goal_summary: 'цель',
  approach_summary: 'подход',
  obstacle: 'препятствие',
  ability: 'dex',
  skill: 'acrobatics',
  plausibility: 'strenuous',
  risk: 'serious',
  required_means: [],
  action_cost: 'action',
  effect: 'none',
  effect_target: '',
  hazard: '',
  prop_id: '',
  target_id: '',
  item_id: '',
  proficiency: 'proficient',
  consequence_type: 'noise',
  ...overrides,
})

const caseById = (id) => IMPROVISATION_CASES.find((testCase) => testCase.id === id)

test('набор покрывает все шесть категорий с оговорённым минимумом кейсов', () => {
  const counts = new Map()
  for (const testCase of IMPROVISATION_CASES) {
    counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1)
    assert.ok(String(testCase.text).trim(), `${testCase.id}: пустой текст действия`)
    assert.ok(testCase.state?.scene, `${testCase.id}: у кейса нет сцены`)
    assert.ok(CATEGORY_LABELS[testCase.category], `${testCase.id}: категория без подписи`)
  }
  const ids = IMPROVISATION_CASES.map((testCase) => testCase.id)
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы кейсов должны быть уникальны')
  assert.ok(counts.get('acrobatics_environment') >= 5)
  assert.ok(counts.get('social_audacity') >= 5)
  assert.ok(counts.get('inventory_items') >= 4)
  assert.ok(counts.get('wild_but_possible') >= 5)
  assert.ok(counts.get('scene_props') >= 4)
  assert.ok(counts.get('honest_impossible_without_means') >= 4)
  assert.ok(counts.get('physically_impossible') >= 3)
  assert.ok(IMPROVISATION_CASES.length >= 30, 'владелец просил около тридцати импровизаций')
})

test('кейсы обстановки опираются на настоящий список пропсов сцены', () => {
  const propCases = IMPROVISATION_CASES.filter((testCase) => testCase.category === 'scene_props')
  const known = new Set(propCases.flatMap((testCase) => (testCase.state.scene?.map?.props ?? []).map((prop) => String(prop.id))))
  assert.ok(known.size >= 3, 'у сцены обязан быть реальный список предметов, иначе кейсы ничего не проверяют')
  for (const testCase of propCases) {
    assert.ok(Array.isArray(testCase.state.scene?.map?.props), `${testCase.id}: сцене нужна карта с предметами`)
    for (const id of testCase.expect.prop?.ids ?? []) {
      assert.ok(known.has(id), `${testCase.id}: ожидаемый ${id} обязан существовать в сцене`)
    }
  }
  // Три кейса «выдумки» обязательны: именно они ловят предмет, которого нет.
  assert.ok(propCases.filter((testCase) => testCase.expect.no_prop_effect).length >= 3)
})

test('структурная проверка ловит мусор до нормализатора', () => {
  assert.deepEqual(structuralIssues(valid()), [])
  assert.deepEqual(structuralIssues(null), ['ответ не является JSON-объектом'])
  assert.ok(structuralIssues(valid({ skill: 'jumping' })).some((issue) => issue.startsWith('skill=')))
  assert.ok(structuralIssues(valid({ plausibility: 'maybe' })).some((issue) => issue.startsWith('plausibility=')))
  assert.ok(structuralIssues(valid({ required_means: 'верёвка' })).includes('required_means не массив'))
  assert.ok(structuralIssues(valid({ goal_summary: '  ' })).includes('goal_summary пустое'))
  // Числа и текст исхода — работа сервера: их присутствие в ответе модели
  // означает, что промпт потерял границу роли.
  assert.ok(structuralIssues(valid({ difficulty: 15 })).includes('difficulty не должно приходить от модели'))
  assert.ok(structuralIssues(valid({ narration: 'герой прыгает' })).includes('narration не должно приходить от модели'))
})

test('отказ на выполнимой задумке засчитывается промахом', () => {
  const chandelier = caseById('acro-chandelier-ogre')
  assert.deepEqual(expectationMisses(chandelier, valid({ ability: 'dex', skill: 'acrobatics' })), [])
  const refused = expectationMisses(chandelier, valid({ plausibility: 'impossible_without_means' }))
  assert.ok(refused.some((miss) => miss.includes('отказ на выполнимой задумке')))
  // Занижение до тривиальности — тоже промах: ставки исчезают вместе с броском.
  assert.ok(expectationMisses(chandelier, valid({ plausibility: 'trivial' })).some((miss) => miss.startsWith('plausibility=')))
})

test('impossible_without_means без названного средства засчитывается промахом', () => {
  const flying = caseById('means-fly-chasm')
  assert.deepEqual(expectationMisses(flying, valid({ plausibility: 'impossible_without_means', required_means: ['полёт'] })), [])
  assert.deepEqual(
    expectationMisses(flying, valid({ plausibility: 'impossible_without_means', required_means: [] })),
    ['impossible_without_means без required_means'],
  )
  assert.ok(expectationMisses(flying, valid({ plausibility: 'strenuous' }))
    .some((miss) => miss.includes('ожидался impossible_without_means')))
})

test('сводка считает доли и разрез по категориям', () => {
  const samples = [
    { id: 'a', category: 'social_audacity', raw: valid(), structural_issues: [], expectation_misses: [], wrong_refusal: false },
    { id: 'b', category: 'social_audacity', raw: valid(), structural_issues: [], expectation_misses: ['отказ на выполнимой задумке: impossible_without_means'], wrong_refusal: true },
    { id: 'c', category: 'inventory_items', raw: valid(), structural_issues: ['skill вне перечисления'], expectation_misses: [], wrong_refusal: false },
    { id: 'd', category: 'inventory_items', raw: valid(), structural_issues: [], expectation_misses: [], wrong_refusal: false },
  ]
  const score = scoreImprovisationRun(samples)
  assert.equal(score.total, 4)
  assert.equal(score.structural_valid_pct, 75)
  assert.equal(score.in_expectation_pct, 75)
  assert.equal(score.wrong_refusals, 1)
  assert.equal(score.categories.social_audacity.in_expectation_pct, 50)
  assert.equal(score.categories.social_audacity.wrong_refusals, 1)
  assert.equal(score.categories.inventory_items.structural_valid_pct, 50)
  assert.deepEqual(score.misses.map((miss) => miss.id), ['b', 'c'])
})

test('промпт v4 держит контракт роли и не ослабляет запреты v2/v3', async () => {
  const v4 = await readFile(new URL('../prompts/action_adjudicator/v4.txt', import.meta.url), 'utf8')
  assert.match(v4, /^PROMPT_ID: action_adjudicator\/v4/u)
  assert.match(v4, /UNTRUSTED_DATA/u)
  // Запреты v2 сохранены дословно.
  assert.match(v4, /Ты не бросаешь кубики, не называешь числа и не описываешь исход/u)
  assert.match(v4, /не выдумывай предметов, существ и особенностей обстановки/u)
  assert.match(v4, /отвечай только JSON без markdown и пояснений/u)
  // Усиление 1.3: выполнимое не получает отказ, а отказ обязан назвать средство.
  assert.match(v4, /выполнимая задумка никогда не получает отказ/u)
  assert.match(v4, /required_means при impossible_without_means обязателен и никогда не пуст/u)
  assert.match(v4, /социальная дерзость — всегда допустимая заявка/u)
  // Единственное расширение перечислений — мост к механике 3.2.
  assert.match(v4, /- effect: none, prone, help_ally, distract, blind, restrain, hazard_damage, topple_prop, ignite_prop/u)
  assert.match(v4, /prop_id обязателен и берётся ровно из scene_props/u)
  assert.match(v4, /не подбирай похожий и не придумывай новый/u)

  // Прочие перечисления не трогали: v3 остаётся на диске, и разница между
  // файлами обязана сводиться к мосту, а не к переписанному контракту.
  const v3 = await readFile(new URL('../prompts/action_adjudicator/v3.txt', import.meta.url), 'utf8')
  const enums = (text) => text.split(/\r?\n/u).filter((line) => /^- (?:ability|skill|plausibility|risk|action_cost|hazard|proficiency|consequence_type):/u.test(line))
  assert.deepEqual(enums(v4), enums(v3), 'кроме effect перечисления обязаны совпасть с v3')
})
