import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { AGENT_ROLES, answerKnownLore, proposeAgentInteraction, resolvePartyDecision, roleAllowsWorldTools, selectAgentRole } from '../server/agent-router.mjs'

test('маршрутизатор отправляет вопросы о лоре Хранителю мира', () => {
  assert.equal(selectAgentRole('Что я знаю про легенду архивариуса?'), 'worldkeeper')
  assert.equal(roleAllowsWorldTools('worldkeeper'), false)
})

test('коллективный маршрут и завершение сцены получает Режиссёр', () => {
  assert.equal(selectAgentRole('Предлагаю покинуть подземелье и решить вместе'), 'director')
  assert.equal(selectAgentRole('[РЕШЕНИЕ ГРУППЫ] Мы уходим дальше'), 'director')
})

test('механические вопросы получает Арбитр правил', () => {
  assert.equal(selectAgentRole('Можно ли бросить кубик на проверку атаки?'), 'game_master')
  assert.equal(roleAllowsWorldTools('game_master'), true)
})

test('Режиссёр гарантированно предлагает голосование для выхода всей группы', () => {
  const proposal = proposeAgentInteraction('Предлагаю покинуть подземелье', {})
  assert.equal(proposal.type, 'vote')
  assert.deepEqual(proposal.options, ['Покинуть подземелье', 'Остаться и исследовать дальше'])
  assert.equal(proposeAgentInteraction('Предлагаю покинуть подземелье', { agentInteraction: { status: 'open' } }), null)
})

test('Режиссёр сохраняет в варианте голосования явно выбранный город', () => {
  const proposal = proposeAgentInteraction('Предлагаю покинуть подземелье и отправиться в большой город Норвин', {})
  assert.match(proposal.options[0], /идём в большой город Норвин/iu)
})

test('Режиссёр открывает переход из города и сохраняет обе локации', () => {
  const proposal = proposeAgentInteraction('Предлагаю покинуть город Норвин и отправиться в большой город Эльмар', {
    scene: { title: 'Норвин', location: 'Большой город Норвин' },
  })
  assert.equal(proposal.type, 'vote')
  assert.match(proposal.title, /Большой город Норвин/u)
  assert.match(proposal.options[0], /Большой город Норвин.*большой город Эльмар/iu)
})

test('отряд может доверить развилку общему кубику без траты хода', () => {
  const proposal = proposeAgentInteraction('Пусть решит кубик судьбы', {})
  assert.equal(proposal.type, 'roll')
  assert.equal(proposal.difficulty, 11)
})

test('каждый объявленный prompt_id указывает на существующий версионированный контракт', () => {
  assert.deepEqual(Object.keys(AGENT_ROLES), ['worldkeeper', 'director', 'game_master', 'narrator', 'map_architect', 'action_adjudicator'])
  for (const role of Object.values(AGENT_ROLES)) {
    if (!Object.hasOwn(role, 'prompt_id')) continue
    assert.match(role.prompt_id, /\/v1$/, role.id)
    assert.equal(existsSync(new URL(`../prompts/${role.prompt_id}.txt`, import.meta.url)), true, role.id)
  }
})

test('детерминированные роли не объявляют контракт промпта', () => {
  for (const id of ['worldkeeper', 'game_master']) {
    assert.equal(Object.hasOwn(AGENT_ROLES[id], 'prompt_id'), false, id)
    assert.equal(existsSync(new URL(`../prompts/${id}/v1.txt`, import.meta.url)), false, id)
  }
})

test('Хранитель отвечает только из подтверждённой памяти и не меняет мир', () => {
  const result = answerKnownLore('Что я знаю про легенду архивариуса?', {
    scene: { objective: 'Найти печать архивариуса' },
    adventure: { currentHook: 'Печать открывает путь к забытому королю', visitedLocations: ['Монастырь Норвин'], history: [] },
  })
  assert.equal(result.provider, 'AgentWorldkeeper')
  assert.equal(result.turn_consumed, false)
  assert.match(result.narration, /Печать открывает путь/)
  assert.equal(result.effects.scene, null)
})

test('вопрос о направлении честно объясняет отсутствие открытого пункта назначения', () => {
  const result = answerKnownLore('Куда нам уходить отсюда по заданию?', {
    scene: { location: 'Кольцевая станция «Гелиос»', objective: 'Разобраться в происходящем и решить, кому можно доверять' },
    adventure: { currentHook: 'Привычный порядок нарушен' },
  })
  assert.equal(result.provider, 'AgentWorldkeeper')
  assert.equal(result.turn_consumed, false)
  assert.match(result.narration, /пункт назначения пока не открыт/iu)
  assert.match(result.narration, /Разобраться в происходящем/iu)
  assert.match(result.narration, /Гелиос/iu)
})


test('resolved party exit creates scene arguments', () => {
  const result = resolvePartyDecision('[\u0420\u0415\u0428\u0415\u041D\u0418\u0415 \u0413\u0420\u0423\u041F\u041F\u042B] \u041F\u043E\u043A\u0438\u043D\u0443\u0442\u044C \u043F\u043E\u0434\u0437\u0435\u043C\u0435\u043B\u044C\u0435', {
    scene: { title: '\u041F\u043E\u0434\u0437\u0435\u043C\u0435\u043B\u044C\u0435', location: '\u041D\u0438\u0436\u043D\u0438\u0439 \u0437\u0430\u043B' },
    adventure: { chapter: 1 },
    agentInteraction: { resolvedOptionId: 'option-1', options: [{ id: 'option-1', label: '\u041F\u043E\u043A\u0438\u043D\u0443\u0442\u044C \u043F\u043E\u0434\u0437\u0435\u043C\u0435\u043B\u044C\u0435' }] },
  })
  assert.equal(result.type, 'scene_request')
  assert.match(result.decision, /\u041F\u043E\u043A\u0438\u043D\u0443\u0442\u044C/u)
  assert.equal(typeof result.destinationHint, 'string')
})

test('resolved stay decision continues current scene', () => {
  const result = resolvePartyDecision('[\u0420\u0415\u0428\u0415\u041D\u0418\u0415 \u0413\u0420\u0423\u041F\u041F\u042B] \u041E\u0441\u0442\u0430\u0442\u044C\u0441\u044F', {
    agentInteraction: { resolvedOptionId: 'option-2', options: [{ id: 'option-2', label: '\u041E\u0441\u0442\u0430\u0442\u044C\u0441\u044F \u0438 \u0438\u0441\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u0442\u044C \u0434\u0430\u043B\u044C\u0448\u0435' }] },
  })
  assert.equal(result.type, 'narration')
  assert.match(result.narration, /\u041E\u0441\u0442\u0430\u0442\u044C\u0441\u044F/u)
})
