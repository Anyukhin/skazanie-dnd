import assert from 'node:assert/strict'
import test from 'node:test'

import { CharacterLifecycleValidationError, levelUpEvent, validateLevelUpCommand } from '../server/character-lifecycle.mjs'
import { MILESTONES_PER_LEVEL, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

/**
 * Найдено ревью плана P4. Реестр вех считал заслуженный уровень с 2026-07-28,
 * но ворота `validateLevelUpCommand` знали только опыт. Кампания на вехах
 * опыта не начисляет вовсе, поэтому её герои не могли повыситься **никогда**:
 * счётчик обещал уровень, движок отвечал «нужно 300 XP».
 */

function campaign({ experience = 0, milestones = 0 } = {}) {
  const state = normalizeCampaignState({
    sessionCode: 'LEVELUP',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    scene: { title: 'Привал', location: 'Привал', cells: [] },
    players: [{
      id: 'hero', character: 'Ада', characterClass: 'fighter', level: 1, experience,
      hp: 12, maxHp: 12, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
    }],
  })
  let next = state
  for (let index = 1; index <= milestones; index += 1) {
    next = applyGameEvent(next, {
      event_id: `milestone-${index}`, event_type: 'MilestoneAwarded', actor_id: 'hero', target_ids: [],
      payload: { milestone: 'encounter-resolved', encounter_id: `e-${index}` },
      visibility: 'party', source_rule_ids: [],
    })
  }
  return next
}

const context = { isAdmin: false, allowedActorIds: ['hero'] }
const levelUp = (state) => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'hero' }, state, context)

test('без опыта и без вех уровень по-прежнему закрыт', () => {
  assert.throws(
    () => levelUp(campaign()),
    (error) => error instanceof CharacterLifecycleValidationError && error.code === 'LEVEL_UP_PROGRESSION_REQUIRED',
  )
})

test('заслуженная веха открывает уровень там, где опыта нет вовсе', () => {
  const validated = levelUp(campaign({ milestones: MILESTONES_PER_LEVEL }))
  assert.equal(validated.level_after, 2)
  assert.equal(validated.progression_source, 'milestone')
  assert.equal(validated.experience, 0)
})

test('накопленных вех меньше порога — уровень всё ещё закрыт', () => {
  assert.throws(
    () => levelUp(campaign({ milestones: MILESTONES_PER_LEVEL - 1 })),
    (error) => error.code === 'LEVEL_UP_PROGRESSION_REQUIRED',
  )
})

test('путь по опыту сохранён и помечен своим источником', () => {
  const validated = levelUp(campaign({ experience: 500 }))
  assert.equal(validated.progression_source, 'experience')
  assert.equal(validated.level_after, 2)
})

test('уровень по вехе списывает порог, и следующий сразу не открывается', () => {
  let state = campaign({ milestones: MILESTONES_PER_LEVEL })
  assert.equal(state.mechanics.progression.level_up_available, true)

  const validated = levelUp(state)
  state = applyGameEvent(state, { event_id: 'level-1', ...levelUpEvent(validated) })

  assert.equal(state.players[0].level, 2)
  assert.equal(state.mechanics.progression.milestones_since_level, 0)
  assert.equal(state.mechanics.progression.level_up_available, false)
  assert.throws(() => levelUp(state), (error) => error.code === 'LEVEL_UP_PROGRESSION_REQUIRED')
})

test('уровень по опыту не съедает накопленную веху', () => {
  // Смешанная кампания: опыт хватает на уровень, и веха при этом уже заслужена.
  let state = campaign({ experience: 500, milestones: MILESTONES_PER_LEVEL })
  const validated = levelUp(state)
  assert.equal(validated.progression_source, 'experience')

  state = applyGameEvent(state, { event_id: 'level-xp', ...levelUpEvent(validated) })
  assert.equal(
    state.mechanics.progression.milestones_since_level,
    MILESTONES_PER_LEVEL,
    'кредит вех обязан уцелеть: уровень оплачен опытом',
  )
  assert.equal(state.mechanics.progression.level_up_available, true)
})

test('событие несёт источник прогрессии, а не выводит его задним числом', () => {
  const event = levelUpEvent(levelUp(campaign({ milestones: MILESTONES_PER_LEVEL })))
  assert.equal(event.payload.progression_source, 'milestone')
})
