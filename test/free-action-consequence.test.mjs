import assert from 'node:assert/strict'
import test from 'node:test'

import { materialConsequenceCommands } from '../server/autonomous-orchestrator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { worldMemoryForViewer } from '../server/world-memory.mjs'

/**
 * Задача 2.1 плана: «сожжённая таверна остаётся сожжённой». Успешное свободное
 * действие, изменившее мир, обязано оставить факт; обычная удачная проверка —
 * не обязана, иначе память заполнится шумом.
 */

const checkEvent = (event_id = 'evt-check') => ({ event_type: 'AbilityCheckResolved', event_id, payload: { success: true } })

const reading = (overrides = {}) => ({
  goal_summary: 'Поджечь разлитое масло под ногами огра',
  approach_summary: 'бросает факел в лужу',
  effect: 'none',
  risk: 'minor',
  hazard: '',
  ...overrides,
})

function state(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'CONSEQ',
    partyMemberIds: ['hero-1'],
    players: [{ id: 'hero-1', character: 'Ада', level: 1, hp: 10, maxHp: 10, abilities: { str: 14 }, inventory: [] }],
    scene: { title: 'Драка', location: 'Трактир «Кабанья голова»', cells: [] },
    ...overrides,
  })
}

test('опасный успех оставляет факт scene_change с провенансом', () => {
  const commands = materialConsequenceCommands(state(), {
    succeeded: true,
    reading: reading({ risk: 'serious' }),
    checkEvent: checkEvent(),
  })
  const fact = commands.find((command) => command.command_type === 'RecordWorldFact')?.fact
  assert.ok(fact, 'факт записан')
  assert.equal(fact.predicate, 'scene_change')
  assert.equal(fact.visibility, 'party')
  assert.deepEqual(fact.source_event_ids, ['evt-check'])
  assert.match(fact.summary, /Поджечь разлитое масло/u)
  assert.match(fact.summary, /Кабанья голова/u, 'место остаётся в тексте факта')
})

test('граница заметности: считается эффект, ставка или названная опасность', () => {
  const notable = [
    reading({ effect: 'hazard_damage' }),
    reading({ risk: 'serious' }),
    reading({ risk: 'deadly' }),
    reading({ hazard: 'fire' }),
  ]
  for (const value of notable) {
    const commands = materialConsequenceCommands(state(), { succeeded: true, reading: value, checkEvent: checkEvent() })
    assert.ok(commands.some((command) => command.command_type === 'RecordWorldFact'), `ожидался факт для ${JSON.stringify(value)}`)
  }
})

test('обычное успешное действие факта не оставляет — шум хуже пустоты', () => {
  for (const value of [reading(), reading({ risk: 'none' }), reading({ effect: 'distract' })]) {
    assert.deepEqual(
      materialConsequenceCommands(state(), { succeeded: true, reading: value, checkEvent: checkEvent() }),
      [],
      `тривиальное действие не должно писать факт: ${JSON.stringify(value)}`,
    )
  }
})

test('провал мир не меняет, даже если ставка была смертельной', () => {
  assert.deepEqual(
    materialConsequenceCommands(state(), { succeeded: false, reading: reading({ risk: 'deadly' }), checkEvent: checkEvent() }),
    [],
  )
})

test('без провенанса и без прочтения факт не пишется', () => {
  assert.deepEqual(materialConsequenceCommands(state(), { succeeded: true, reading: reading({ risk: 'deadly' }), checkEvent: null }), [])
  assert.deepEqual(
    materialConsequenceCommands(state(), {
      succeeded: true,
      reading: reading({ risk: 'deadly', goal_summary: '', approach_summary: '' }),
      checkEvent: checkEvent(),
    }),
    [],
  )
})

test('в состоянии без сущностей локация заводится вместе с фактом', () => {
  // Движок обычно сам заводит локацию сцены, но факт обязан ссылаться на
  // существующую сущность — иначе WORLD_ENTITY_NOT_FOUND уронит весь батч.
  const bare = { scene: { title: 'Драка', location: 'Трактир «Кабанья голова»' }, worldMemory: { entities: [], facts: [] } }
  const commands = materialConsequenceCommands(bare, {
    succeeded: true, reading: reading({ risk: 'serious' }), checkEvent: checkEvent(),
  })
  assert.deepEqual(commands.map((command) => command.command_type), ['UpsertWorldEntity', 'RecordWorldFact'])
  assert.equal(commands[0].entity.kind, 'location')
  assert.equal(commands[1].fact.subject_id, commands[0].entity.id)
})

test('повтор того же события факт не удваивает, а replay даёт то же состояние', () => {
  const initial = state()
  const first = materialConsequenceCommands(initial, {
    succeeded: true, reading: reading({ risk: 'serious' }), checkEvent: checkEvent(),
  })
  // Локацию сцены движок уже завёл при нормализации — вторую заводить незачем.
  assert.deepEqual(first.map((command) => command.command_type), ['RecordWorldFact'])

  const diceService = new DiceService({ rng: new SequenceDiceRng([]) })
  const resolved = resolveCommands(first, initial, { diceService, context: { isDirector: true } })
  assert.deepEqual(resolved.events.map((event) => event.event_type), ['WorldFactRecorded'])
  assert.deepEqual(replayEvents(initial, resolved.events), resolved.state, 'replay даёт то же состояние')

  // Второй заход того же броска: сущность уже есть, факт уже записан.
  const second = materialConsequenceCommands(resolved.state, {
    succeeded: true, reading: reading({ risk: 'serious' }), checkEvent: checkEvent(),
  })
  assert.deepEqual(second, [], 'детерминированный id закрывает повтор')

  // Другое действие в той же сцене чужую сущность не пересоздаёт.
  const other = materialConsequenceCommands(resolved.state, {
    succeeded: true, reading: reading({ risk: 'deadly', goal_summary: 'Обрушить люстру' }), checkEvent: checkEvent('evt-other'),
  })
  assert.deepEqual(other.map((command) => command.command_type), ['RecordWorldFact'])

  const visible = worldMemoryForViewer(resolved.state.worldMemory, { playerId: 'hero-1', isPartyMember: true })
  assert.ok(visible.facts.some((fact) => fact.predicate === 'scene_change'), 'последствие видно отряду')
})
