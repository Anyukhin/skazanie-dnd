// Заклинание, названное словами в бою. Плейтест 2026-10-10: «Мирель отступает
// за спину Борина и швыряет в хобгоблина Огненный снаряд» получало «Так не
// выйдет — таким не располагает» или «Намеренный контакт с опасностью…», хотя
// заговор стоял на панели. Теперь это та же команда CastSpell, что у панели;
// дальность, ход, ячейку и цель проверяет движок.
import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { IntentParser, namedKnownSpell } from '../server/intent-parser.mjs'

const visibleState = {
  ruleset_id: 'dnd_5e_2014',
  mechanics: { combat: { active: true } },
  scene: { location: 'Маяк' },
  players: [{
    id: 'hero', character: 'Мирель', level: 3, characterClass: 'wizard',
    knownSpellIds: ['fire-bolt', 'burning-hands', 'magic-missile'], preparedSpellIds: ['magic-missile', 'burning-hands'],
  }],
  enemies: [{ id: 'hob-1', name: 'Хобгоблин 1', alive: true }, { id: 'gob-2', name: 'Гоблин 2', alive: true }],
}

test('известное заклинание узнаётся в любом падеже', () => {
  assert.equal(namedKnownSpell('швыряю Огненный снаряд', visibleState, 'hero')?.id, 'fire-bolt')
  assert.equal(namedKnownSpell('бью огненным снарядом', visibleState, 'hero')?.id, 'fire-bolt')
  assert.equal(namedKnownSpell('пускаю Волшебную стрелу', visibleState, 'hero')?.id, 'magic-missile')
  assert.equal(namedKnownSpell('швыряю огненный шар', visibleState, 'hero'), null, 'чужого заклинания нет')
})

test('в бою реплика с заклинанием — сотворение с целью, а не импровизация', async () => {
  const parsed = await new IntentParser().parse({ message: 'Мирель отступает за спину Борина и швыряет в Хобгоблина 1 Огненный снаряд', playerId: 'hero', visibleState })
  assert.equal(parsed.intent, 'cast_spell')
  assert.equal(parsed.spell_id, 'fire-bolt')
  assert.deepEqual(parsed.targets, ['hob-1'])
  const outside = await new IntentParser().parse({ message: 'Швыряю Огненный снаряд в небо', playerId: 'hero', visibleState: { ...visibleState, mechanics: { combat: { active: false } } } })
  assert.notEqual(outside.intent, 'cast_spell', 'вне боя заклинание — поступок сцены для арбитра')
})

test('план — команда CastSpell; площадь и пропущенная цель — короткая просьба голосом ведущего', async () => {
  const adjudicator = new Adjudicator()
  const state = { ...visibleState, players: visibleState.players.map((hero) => ({ ...hero, abilities: { int: 16 } })) }
  const intentFor = async (message) => new IntentParser().parse({ message, playerId: 'hero', visibleState })
  const cast = await adjudicator.createPlan({ intent: await intentFor('Швыряю в Хобгоблина 1 Огненный снаряд'), state, retrievedRules: { results: [], confidence: 1 } })
  assert.deepEqual(cast.proposed_commands.map((command) => [command.command_type, command.spell_id, command.target_id]), [['CastSpell', 'fire-bolt', 'hob-1']])
  const area = await adjudicator.createPlan({ intent: await intentFor('Бью Огненными ладонями'), state, retrievedRules: { results: [], confidence: 1 } })
  assert.equal(area.clarification_required, true)
  assert.match(area.clarification_message, /по площади/u)
  const noTarget = await adjudicator.createPlan({ intent: await intentFor('Пускаю Волшебную стрелу'), state, retrievedRules: { results: [], confidence: 1 } })
  assert.equal(noTarget.clarification_required, true)
  assert.match(noTarget.clarification_message, /в кого/u)
})
