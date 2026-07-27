// Ось «сервер решает»: вне боя творится только то, что не бьёт. Правило
// серверное, клиент им лишь подсвечивает плитки, поэтому сторож проверяет
// движок напрямую — и обе стороны границы: что разрешено вне боя и что
// по-прежнему требует инициативы.
//
// Решение владельца от 2026-07-27. Раньше вне боя отвергалось любое
// заклинание (`COMBAT_NOT_ACTIVE`), а ритуалы не творились нигде: их
// отвергала и боевая ветка тоже.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = Array.from({ length: 60 }, () => 3)) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `cast-roll-${++id}`, now: () => '2026-07-27T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = () => ({ diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })

/**
 * Жрица и раненый воин рядом, волк — за пределами дальности лечения, но в
 * пределах дальности заговора. Бой по умолчанию выключен: это состояние
 * привала, ради которого правило и заводилось.
 */
function camp({ combatActive = false } = {}) {
  const cells = Array.from({ length: 36 }, (_, index) => ({ x: index % 9, y: Math.floor(index / 9), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CAMP-1',
    campaign_id: 'CAMP-1',
    partyMemberIds: ['cleric', 'fighter'],
    players: [
      {
        id: 'cleric', character: 'Мириэль', characterClass: 'cleric', level: 3, proficiency: 2,
        hp: 21, maxHp: 21, armor: 15, speed: 30, x: 1, y: 1,
        abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 16, cha: 10 },
        preparedSpellIds: ['cure-wounds', 'sacred-flame', 'prayer-of-healing'], inventory: [],
      },
      {
        id: 'fighter', character: 'Брайн', characterClass: 'fighter', level: 3, proficiency: 2,
        hp: 9, maxHp: 30, armor: 16, speed: 30, x: 2, y: 1,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
      },
    ],
    enemies: [{
      id: 'wolf', name: 'Волк', creature_type: 'beast', hp: 20, maxHp: 20, armor: 12, speed: 40,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 4, y: 1, alive: true,
    }],
    scene: { turn: 1, location: 'Привал', title: 'Привал', cells },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      resources: { cleric: { spell_slots_1: { current: 3, max: 3 }, spell_slots_2: { current: 2, max: 2 } } },
      combat: combatActive
        ? {
          active: true, round: 1, active_index: 0,
          initiative: [{ actor_id: 'cleric', total: 18 }, { actor_id: 'wolf', total: 9 }],
          action_economy: {
            cleric: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
            wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          },
        }
        : { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} },
    },
  })
}

const cast = (state, command) => resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'cleric', ...command }), state, options())

test('вне боя лечение союзника проходит, тратит ячейку и не трогает экономику хода', () => {
  const state = camp()
  const result = cast(state, { spell_id: 'cure-wounds', target_id: 'fighter' })
  const after = replayEvents(state, result.events)

  assert.ok(after.players.find((player) => player.id === 'fighter').hp > 9, 'воин должен быть подлечен')
  assert.equal(after.mechanics.resources.cleric.spell_slots_1.current, 2, 'ячейка первого круга потрачена')
  assert.deepEqual(after.mechanics.combat.action_economy, {}, 'вне боя экономика хода не заводится')
  assert.equal(after.mechanics.combat.active, false, 'лечение не начинает бой')
})

test('вне боя боевое заклинание отвергается: нападение начинается с инициативы', () => {
  assert.throws(
    () => cast(camp(), { spell_id: 'sacred-flame', target_id: 'wolf' }),
    (error) => error.code === 'COMBAT_NOT_ACTIVE',
    'заговор с уроном обязан требовать инициативы',
  )
})

test('вне боя мирное заклинание во врага не проходит', () => {
  assert.throws(
    () => cast(camp(), { spell_id: 'cure-wounds', target_id: 'wolf' }),
    (error) => error.code === 'INVALID_SPELL_TARGET',
    'лечение требует союзника, а не противника',
  )
})

test('в бою ритуал недоступен — и ответ о правилах не зависит от каталога', () => {
  /* Проверка порядка: «в бою так нельзя» обязано отвечать раньше, чем движок
     дойдёт до разметки механики карточки. Иначе игрок вместо правила получает
     сообщение о неготовых данных. */
  assert.throws(
    () => cast(camp({ combatActive: true }), { spell_id: 'prayer-of-healing', target_id: 'fighter' }),
    (error) => error.code === 'SPELL_CAST_TIME_TOO_LONG',
    'длинное накладывание в бою обязано отвергаться боевым правилом',
  )
})

test('вне боя ритуал упирается уже не в бой, а в неразмеченную карточку', () => {
  /* Дверь в правилах открыта, но пройти в неё пока нельзя: ни у одного
     заклинания с длинным накладыванием нет проверенной механики в
     `data/dndsu-spell-mechanics-overrides.json` — все они `heuristic`.
     Сторож фиксирует именно это состояние: как только каталог разметят,
     тест упадёт и его нужно будет заменить на проверку течения времени. */
  assert.throws(
    () => cast(camp(), { spell_id: 'prayer-of-healing', target_id: 'fighter' }),
    (error) => error.code === 'MECHANICS_NOT_VERIFIED',
    'вне боя ритуал больше не отвергается боем',
  )
})

test('в бою боевое заклинание работает как прежде', () => {
  const state = camp({ combatActive: true })
  const result = cast(state, { spell_id: 'sacred-flame', target_id: 'wolf' })
  const after = replayEvents(state, result.events)

  assert.ok(result.events.length > 0, 'заклинание в бою обязано разрешаться')
  assert.equal(after.mechanics.combat.action_economy.cleric.action, false, 'в бою действие тратится')
})
