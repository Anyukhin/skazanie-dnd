// Полномочия агента-арбитра. Тесты стерегут не «модель поняла задумку» — это
// не проверить детерминированно, — а то, что её предложение ничего не решает
// в обход сервера и что отказ модели не ломает ход.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ActionAdjudicator, adjudicationBrief } from '../server/action-adjudicator.mjs'
import { interpretFreeAction } from '../server/free-action-adjudication.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

function scene() {
  return normalizeCampaignState({
    players: [{
      id: 'hero', character: 'Аster', characterClass: 'fighter', level: 1, hp: 20, maxHp: 20, armor: 15, speed: 30, x: 0, y: 0,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
      classSkillProficiencies: ['athletics', 'perception'],
      skillExpertiseIds: ['perception'],
      preparedSpellIds: ['sacred-flame'],
      inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1, equipped: false }],
    }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 25, maxHp: 25, armor: 12, alive: true, x: 1, y: 0 }],
    scene: { title: 'Мост', location: 'Мост', mood: 'Ветрено', objective: 'Удержать мост', turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: {
      combat: {
        active: true, round: 2, active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }],
        action_economy: { hero: { action: true, bonus_action: false, movement: true, movement_spent: 10 } },
      },
    },
  })
}

const stub = (payload, { fail = false } = {}) => new ActionAdjudicator({
  llmClient: { completeJson: async () => { if (fail) throw new Error('LLM_PROVIDER_ERROR'); return payload } },
})

test('бриф даёт агенту лист, сцену, участников и экономию хода — и ничего сверх', () => {
  const brief = adjudicationBrief(scene(), 'hero', 'Опрокидываю жаровню')
  assert.equal(brief.hero.id, 'hero')
  assert.deepEqual(brief.hero.skill_proficiencies, ['athletics', 'perception'])
  assert.deepEqual(brief.hero.skill_expertise, ['perception'])
  assert.equal(brief.turn_economy.in_combat, true)
  assert.equal(brief.turn_economy.bonus_action_available, false)
  assert.deepEqual(brief.participants.map((entry) => entry.side), ['party', 'enemy'])
  // Список разрешённого передаётся явно: агент не должен угадывать словарь.
  assert.ok(brief.allowed.effects.includes('prone'))
  assert.ok(brief.allowed.hazards.includes('fire'))
  // Скрытых параметров врага в брифе нет.
  assert.equal(Object.hasOwn(brief.participants[1], 'hp'), false)
})

test('предложение агента принимается только по закрытым перечислениям', async () => {
  const adjudicator = stub({
    goal_summary: 'Опрокинуть жаровню под ноги огру',
    approach_summary: 'Толкаю жаровню ногой',
    obstacle: 'тяжёлая жаровня',
    ability: 'str',
    skill: 'athletics',
    plausibility: 'strenuous',
    risk: 'serious',
    action_cost: 'action',
    effect: 'hazard_damage',
    effect_target: 'ogre',
    hazard: 'fire',
    target_id: 'ogre',
    item_id: 'rope',
    proficiency: 'expertise',
    consequence_type: 'noise',
  })
  const reading = await adjudicator.read(scene(), 'hero', 'Опрокидываю жаровню', interpretFreeAction('Опрокидываю жаровню'))
  assert.equal(reading.ability, 'str')
  assert.equal(reading.skill, 'athletics')
  assert.equal(reading.plausibility, 'strenuous')
  assert.equal(reading.effect, 'hazard_damage')
  assert.equal(reading.hazard, 'fire')
  assert.equal(reading.target_id, 'ogre')
  assert.equal(reading.item_id, 'rope')
  assert.equal(reading.proficiency, 'proficient', 'уровень берётся из листа, а не из ответа модели')
  assert.equal(reading.proficiency_bonus, 2)
  assert.equal(reading.consequence_type, 'noise')
  assert.equal(reading.source, 'agent-adjudicator')
})

test('агент не может назначить СЛ, исход, свой эффект или чужое поле', async () => {
  const adjudicator = stub({
    ability: 'сила',
    plausibility: 'легко',
    risk: 'катастрофа',
    action_cost: 'бесплатно',
    effect: 'instant_kill',
    hazard: 'meteor',
    difficulty: 5,
    success: true,
    damage: '99d99',
    target_id: 'hidden-dragon',
    item_id: 'wish-scroll',
    proficiency: 'triple',
    consequence_type: 'instant_death',
  })
  const reading = await adjudicator.read(scene(), 'hero', 'Убиваю огра взглядом', interpretFreeAction('Убиваю огра взглядом'))

  assert.equal(reading.ability, 'wis', 'неизвестная характеристика заменяется безопасной')
  assert.equal(reading.plausibility, 'plausible')
  assert.equal(reading.risk, 'minor')
  assert.equal(reading.action_cost, 'action', 'выдуманный слот трактуется как самый дорогой')
  assert.equal(reading.effect, 'none', 'эффекта вне каталога не существует')
  assert.equal(reading.hazard, '', 'опасности вне таблицы не существует')
  assert.equal(reading.target_id, 'ogre', 'forged ID отброшен, но реальная цель надёжно выведена из текста')
  assert.equal(reading.item_id, '')
  assert.equal(reading.proficiency, 'expertise', 'сервер восстанавливает реальную expertise Внимательности')
  assert.equal(reading.consequence_type, 'time')
  for (const forbidden of ['difficulty', 'success', 'damage']) {
    assert.equal(Object.hasOwn(reading, forbidden), false, `поле ${forbidden} не должно доходить до движка`)
  }
})

test('отказ модели возвращает игру к детерминированной таблице, а не ломает ход', async () => {
  const text = 'Подпираю створку ворот обломком бревна'
  const fallback = interpretFreeAction(text)
  const reading = await stub(null, { fail: true }).read(scene(), 'hero', text, fallback)
  assert.equal(reading.ability, fallback.ability)
  assert.equal(reading.skill, fallback.skill)
  assert.match(reading.source, /after-agent-error$/)
})

test('без ключа модели арбитр вообще не вмешивается', async () => {
  const text = 'Подпираю створку ворот обломком бревна'
  const fallback = interpretFreeAction(text)
  const reading = await new ActionAdjudicator({ llmClient: null }).read(scene(), 'hero', text, fallback)
  assert.equal(reading.source, fallback.source)
  assert.equal(reading.skill, 'athletics')
  assert.equal(reading.proficiency, 'proficient')
  assert.equal(reading.proficiency_bonus, 2)
  assert.deepEqual(reading.reference_ambiguities, [])
})
