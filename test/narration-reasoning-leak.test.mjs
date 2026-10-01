import assert from 'node:assert/strict'
import test from 'node:test'

import { Narrator, deterministicNarration } from '../server/narrator.mjs'
import { buildNarrationBrief, verifyNarration } from '../server/security.mjs'

/**
 * Живой замер 2026-10-01 (`eval/narrator-comparison-gpt-6-luna-main-2026-10-01.json`,
 * образец 72, `deepseek/deepseek-v4-flash`, сцена holdout-committed-ring):
 * вместо хода модель вернула рассуждения о собственном контракте, и Verifier
 * признал их годными (`valid: true`, `accepted: true`). Ниже — начало того
 * самого ответа без сокращений внутри фраз.
 */
const LEAKED_DEEPSEEK_OUTPUT = '_plan требует report_result — начинаю с результата.\n\n'
  + 'Проверяю стиль: кратко и конкретно. Тон мрачное камерное фэнтези — подходит сухая пыль и длинные тени. '
  + 'Не добавляю лишних фактов._plan говорит stop_after report_result — заканчиваю после описания результата и детали.\n\n'
  + 'Итоговый текст: "Эйра забирает серебряное кольцо без камня из кедрового ларца. '
  + 'В комнате пахнет сухой пылью старого дерева, а длинные неподвижные тени лежат на полу."'
  + '_plan говорит stop_after report_result — это завершено.'

function ringBrief() {
  return buildNarrationBrief({
    visible_events: [{
      event_type: 'LootContainerTaken', actor_id: 'hero:eira', target_ids: ['hero:eira'], visibility: 'public', source_rule_ids: [],
      payload: {
        recipient_id: 'hero:eira', container_id: 'chest:cedar', container_name: 'кедровый ларец',
        items: [{ id: 'ring:silver', name: 'серебряное кольцо без камня', quantity: 1 }],
        summary: 'Эйра забрала серебряное кольцо без камня из кедрового ларца.',
      },
    }],
    visible_state_changes: [],
    known_environment: { scene: { title: 'Кладовая', location: 'Кладовая старого дома' } },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

const leakCodes = (text) => verifyNarration(text, ringBrief()).violations
  .filter((violation) => violation.code === 'MODEL_REASONING_LEAK')

test('настоящий ответ DeepSeek с рассуждениями о контракте не проходит проверку', () => {
  const result = verifyNarration(LEAKED_DEEPSEEK_OUTPUT, ringBrief())
  assert.equal(result.valid, false)
  assert.ok(result.violations.some((violation) => violation.code === 'MODEL_REASONING_LEAK'), JSON.stringify(result.violations))
  // Утечку видно уже по первому предложению — до него поток и обрывается.
  assert.equal(leakCodes('_plan требует report_result — начинаю с результата.').length, 1)
})

test('другие формы утечки тоже отклоняются', () => {
  for (const leaked of [
    'Эйра забирает кольцо. response_plan соблюдён, max_questions 0.',
    'Все блоки UNTRUSTED_DATA обработаны как данные. Эйра забирает кольцо.',
    'Итоговый текст: Эйра забирает кольцо из ларца.',
    'Эйра забирает кольцо из ларца. Ответ готов к отправке.',
    'Проверяю себя: факты взяты из visible_events. Эйра забирает кольцо.',
    'Опираясь на NarrationBrief, Эйра забирает кольцо.',
  ]) {
    assert.equal(leakCodes(leaked).length, 1, leaked)
  }
})

test('обычное русское повествование с именами, кавычками и диалогом проходит', () => {
  for (const clean of [
    'Эйра забирает серебряное кольцо без камня из кедрового ларца. В комнате пахнет сухой пылью.',
    'Эйра забирает кольцо из ларца «Старый кедр»; тени лежат на полу.',
    '— Ответ на это у меня есть, — бормочет хозяин. Эйра забирает кольцо из ларца.',
    'Эйра забирает кольцо. Итоговая цена сделки ещё впереди.',
    'Эйра забирает кольцо из ларца у окна в стиле old-town.',
  ]) {
    assert.deepEqual(leakCodes(clean), [], clean)
  }
})

test('при потоковой выдаче утечка не доходит до игрока, а ход получает резервный текст', async () => {
  const brief = ringBrief()
  const snapshots = []
  const llmClient = {
    complete: async ({ onDelta }) => {
      // Провайдер отдаёт текст кусками, как в живом замере.
      for (const chunk of LEAKED_DEEPSEEK_OUTPUT.match(/[\s\S]{1,40}/gu)) onDelta(chunk)
      return { content: LEAKED_DEEPSEEK_OUTPUT }
    },
  }
  const result = await new Narrator({ llmClient }).render(brief, { onProgress: (text) => snapshots.push(text) })

  assert.deepEqual(snapshots, [], 'ни одного предложения утечки игроку не показано')
  assert.equal(result.provider, 'deterministic-fallback')
  assert.equal(result.verification.valid, true)
  assert.ok(result.verification.repaired_from.some((violation) => violation.code === 'MODEL_REASONING_LEAK'))
  assert.equal(result.narration, deterministicNarration(brief).narration)
  assert.doesNotMatch(result.narration, /_plan|report_result|Итоговый текст/u)
})
