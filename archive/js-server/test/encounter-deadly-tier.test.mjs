import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { normalizeDirectorIntent } from '../server/autonomous-campaign.mjs'
import {
  DEADLY_ENCOUNTER_WARNING,
  ENCOUNTER_DIFFICULTIES,
  assembleEncounter,
  encounterDifficultyLabel,
} from '../server/encounter-assembler.mjs'
import { encounterNarration } from '../server/encounter-narration.mjs'
import { publicEncounterFor } from '../server/viewer-projection.mjs'

/**
 * Задача 3.3 плана: калькулятор сложности и режим честного мира. Смертельный
 * тир — серверная политика, а не строка SRD, поэтому сторож проверяет и само
 * удвоение, и то, что бюджет по-прежнему растёт от фактического состава партии.
 */

function scene(width = 14, height = 10) {
  const cells = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  }
  return { cells }
}

const party = (size, level) => Array.from({ length: size }, (_, index) => ({
  id: `hero-${index + 1}`, level, x: index, y: 0,
}))

const assemble = (size, level, difficulty) => assembleEncounter({
  scene: scene(), party: party(size, level), difficulty, theme: 'beasts', seed: `seed-${size}-${level}-${difficulty}`,
})

test('смертельный тир объявлен четвёртым и подписан по-русски', () => {
  assert.deepEqual(ENCOUNTER_DIFFICULTIES, ['easy', 'medium', 'hard', 'deadly'])
  assert.equal(encounterDifficultyLabel('easy'), 'лёгкий')
  assert.equal(encounterDifficultyLabel('medium'), 'средний')
  assert.equal(encounterDifficultyLabel('hard'), 'тяжёлый')
  assert.equal(encounterDifficultyLabel('deadly'), 'смертельный')
  assert.equal(encounterDifficultyLabel('чепуха'), 'средний', 'неизвестное значение не роняет проекцию')
})

test('бюджет растёт с числом героев и уровнем, а deadly ровно вдвое выше hard', () => {
  for (const level of [1, 4, 9, 15, 20]) {
    for (const size of [2, 3, 4, 5]) {
      const budgets = Object.fromEntries(ENCOUNTER_DIFFICULTIES.map((difficulty) => [
        difficulty,
        assemble(size, level, difficulty).xp_budget,
      ]))
      assert.ok(budgets.easy < budgets.medium, `${size}×${level}: easy < medium`)
      assert.ok(budgets.medium < budgets.hard, `${size}×${level}: medium < hard`)
      // Единственное отличие смертельного тира от high — серверный множитель.
      assert.equal(budgets.deadly, budgets.hard * 2, `${size}×${level}: deadly вдвое выше hard`)
    }
  }

  // Больше героев — больше бюджет; выше уровень — больше бюджет.
  for (const difficulty of ENCOUNTER_DIFFICULTIES) {
    for (const level of [1, 8, 20]) {
      const sizes = [2, 3, 4, 5].map((size) => assemble(size, level, difficulty).xp_budget)
      for (let index = 1; index < sizes.length; index += 1) {
        assert.ok(sizes[index] > sizes[index - 1], `${difficulty}/${level}: бюджет растёт с составом`)
      }
    }
    const levels = [1, 5, 11, 20].map((level) => assemble(4, level, difficulty).xp_budget)
    for (let index = 1; index < levels.length; index += 1) {
      assert.ok(levels[index] > levels[index - 1], `${difficulty}: бюджет растёт с уровнем`)
    }
  }
})

test('смертельная сборка проходит валидацию и несёт ярлык вместо чисел', () => {
  const proposal = assemble(4, 5, 'deadly')
  assert.equal(proposal.difficulty, 'deadly')
  assert.equal(proposal.difficulty_label, 'смертельный')
  assert.ok(proposal.enemies.length > 0, 'бюджет действительно тратится на противников')
  assert.ok(proposal.threat.budget_xp > 0)

  // Проекция игрока: ярлык есть, а бюджетных чисел в нём нет.
  const projected = publicEncounterFor({ id: 'enc-1', status: 'staged', difficulty: 'deadly', theme: 'beasts' })
  assert.equal(projected.difficulty_label, 'смертельный')
  assert.equal(/\d/u.test(projected.difficulty_label), false)
  assert.equal(publicEncounterFor({ id: 'enc-2', difficulty: 'easy' }).difficulty_label, 'лёгкий')
})

test('режиссёр может запросить deadly, но не выдуманную сложность', () => {
  const intent = normalizeDirectorIntent({ type: 'request_encounter', theme: 'raiders', difficulty: 'deadly', reason: 'Отряд напал на гильдию.' })
  assert.equal(intent.difficulty, 'deadly')
  assert.throws(
    () => normalizeDirectorIntent({ type: 'request_encounter', theme: 'raiders', difficulty: 'lethal', reason: 'x' }),
    (error) => error.code === 'DIRECTOR_ENCOUNTER_DIFFICULTY_NOT_ALLOWED',
  )
})

test('оба промпта режиссёра синхронно разрешают deadly и ограничивают его провокацией', async () => {
  for (const name of ['v3_story', 'v3_chaos']) {
    const prompt = await readFile(new URL(`../prompts/director/${name}.txt`, import.meta.url), 'utf8')
    assert.match(prompt, /difficulty только easy, medium, hard, deadly;/u, `${name}: перечисление обновлено`)
    assert.match(prompt, /deadly запрашивается только тогда, когда отряд сознательно провоцирует/u, `${name}: условие названо`)
    assert.match(prompt, /Обычная эскалация сюжета — по-прежнему easy, medium или hard/u, `${name}: обычный путь сохранён`)
  }
})

test('предупреждение о неравных силах существует и не содержит чисел', () => {
  assert.match(DEADLY_ENCOUNTER_WARNING, /смертельно опасным/u)
  assert.match(DEADLY_ENCOUNTER_WARNING, /отступить/u)
  assert.equal(/\d/u.test(DEADLY_ENCOUNTER_WARNING), false, 'игрокам не показывают числа бюджета')
})

test('нарратив прямо называет неравные силы только у смертельной встречи', () => {
  const events = (difficulty) => [
    { event_type: 'EncounterCreated', payload: { encounter: { difficulty, enemies: [{ name: 'Огр' }] } } },
    { event_type: 'CombatStarted', payload: {} },
  ]
  assert.match(encounterNarration(events('deadly')), /Силы неравны/u)
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.equal(/Силы неравны/u.test(encounterNarration(events(difficulty))), false, `${difficulty}: лишнего предупреждения нет`)
  }
})
