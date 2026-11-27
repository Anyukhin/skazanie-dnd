import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellsFor, spellSlotMaximumsFor } from '../server/combat-spells.mjs'

const CASES = [
  ['bard', 4], ['cleric', 4], ['druid', 4], ['sorcerer', 4], ['wizard', 4],
  ['warlock', 4], ['ranger', 2], ['paladin', 2],
]

test('7-й уровень показывает только доступные круги и создаёт правильные ячейки', () => {
  for (const [characterClass, maximumCircle] of CASES) {
    const player = { characterClass, level: 7, abilities: { int: 18, wis: 16, cha: 16 } }
    const spells = combatSpellsFor(player)
    assert.ok(spells.length > 0, `${characterClass}: список заклинаний пуст`)
    assert.ok(spells.every((spell) => spell.level <= maximumCircle), `${characterClass}: заклинание выше ${maximumCircle}-го круга`)
    assert.ok(spells.some((spell) => spell.level === maximumCircle), `${characterClass}: нет верхнего доступного круга`)
    const slots = spellSlotMaximumsFor(player)
    if (characterClass === 'warlock') {
      assert.equal(slots.pact_slots, 2, 'колдун 7-го уровня получает две ячейки пакта')
    } else {
      assert.ok(slots[`spell_slots_${maximumCircle}`] > 0, `${characterClass}: нет ячейки ${maximumCircle}-го круга`)
      assert.equal(slots[`spell_slots_${maximumCircle + 1}`], undefined, `${characterClass}: лишняя ячейка выше лимита`)
    }
  }
})

test('карточки заклинаний сохраняют описание выбора цели и повышения', () => {
  const spells = combatSpellsFor({ characterClass: 'wizard', level: 7, abilities: { int: 18 } })
  for (const id of ['fireball', 'misty-step', 'counterspell', 'polymorph']) {
    const spell = spells.find((entry) => entry.id === id)
    assert.ok(spell, `${id}: заклинание отсутствует в списке 7-го уровня`)
    assert.ok(spell.target, `${id}: нет типа цели`)
    assert.ok(spell.actionType, `${id}: нет цены действия`)
    assert.ok(spell.description?.trim(), `${id}: нет описания`)
  }
})
