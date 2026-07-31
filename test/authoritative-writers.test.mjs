import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Шаг 0 плана `docs/agent-architecture-plan.md`: реестр авторитетных писателей
 * зафиксирован как факт, а не как норма. Тест ничего не улучшает — он ловит
 * появление семнадцатого писателя раньше, чем тот доедет до main.
 *
 * За вторую волну писателей прибавилось трое (`CampaignRewound`, серверные часы
 * боя, третий путь автономного оркестратора), и ни один из них не был замечен
 * до ручной сверки. Поэтому сторож ставится до шагов 3–5, а не после.
 */

const serverDir = fileURLToPath(new URL('../server/', import.meta.url))

/** Кто именно сегодня имеет право писать в журнал. Числа — из ручной сверки. */
const KNOWN_WRITERS = Object.freeze({
  // Командные писатели: план → resolvePlan → commit.
  'game-orchestrator.mjs': 2,
  'autonomous-orchestrator.mjs': 3,
  'npc-turn-scheduler.mjs': 1,
  'combat-turn-coordinator.mjs': 1,
  // Производные писатели: события без прохода через Rules Engine.
  'index.mjs': 9,
})

/** Сам Event Store и миграции пишут по определению — они и есть исполнитель. */
const EXEMPT = new Set(['event-store.mjs'])

function commitCallCounts() {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith('.mjs') || EXEMPT.has(name)) continue
    const source = readFileSync(new URL(name, new URL('../server/', import.meta.url)), 'utf8')
    // Считаем только вызовы commit у стора, а не любые методы со словом commit.
    const matches = source.match(/(?:eventStore|store|this\.eventStore)\s*\.\s*commit\s*\(/gu) ?? []
    if (matches.length) counts[name] = matches.length
  }
  return counts
}

test('реестр авторитетных писателей не растёт молча', () => {
  const actual = commitCallCounts()
  const unexpected = Object.keys(actual).filter((name) => !(name in KNOWN_WRITERS)).sort()
  assert.deepEqual(unexpected, [], [
    'Появился новый модуль, который сам пишет в Event Store.',
    'Это второй авторитетный путь — ровно то, что запрещает AGENTS.md.',
    'Либо переведите его на общий executor, либо осознанно внесите в KNOWN_WRITERS',
    'вместе со строкой в docs/agent-architecture-plan.md.',
  ].join(' '))
  for (const [name, expected] of Object.entries(KNOWN_WRITERS)) {
    assert.equal(actual[name] ?? 0, expected,
      `${name}: писателей стало ${actual[name] ?? 0} вместо ${expected}. `
      + 'Обновите реестр в docs/agent-architecture-plan.md тем же PR.')
  }
})

test('политики устойчивости расходятся — и это записано до унификации', () => {
  const orchestrator = readFileSync(new URL('../server/game-orchestrator.mjs', import.meta.url), 'utf8')
  const scheduler = readFileSync(new URL('../server/npc-turn-scheduler.mjs', import.meta.url), 'utf8')

  // Основной ход игрока переживает конфликт версии прозрачно.
  assert.match(orchestrator, /STATE_VERSION_CONFLICT/u,
    'основной ход обязан различать конфликт версии')

  // Планировщик NPC — нет. Тест фиксирует это как текущее поведение;
  // шаг 4 плана меняет его явным коммитом, а не «чтобы позеленело».
  assert.doesNotMatch(scheduler, /STATE_VERSION_CONFLICT/u,
    'если планировщик NPC научился retry — это шаг 4, обновите тест осознанно')
})
