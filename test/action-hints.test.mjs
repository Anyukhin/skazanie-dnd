// Подсказки «что можно сделать»: детерминированная сборка из уже видимого.
//
// Главная проверка здесь не «строки красивые», а «строки не могут раскрыть
// скрытое». Подсказки строятся из спроецированной комнаты, поэтому сторож
// прогоняет настоящую проекцию со скрытыми клетками, gm_only NPC и секретами
// пропсов и убеждается, что ничего из этого в подсказки не просочилось.
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_ACTION_HINTS, suggestedActionsFor } from '../server/action-hints.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const room = (patch = {}) => ({
  scene: { objective: '', map: { props: [], doors: [] }, ...(patch.scene ?? {}) },
  scene_npcs: patch.scene_npcs ?? [],
  mechanics: patch.mechanics ?? { combat: { active: false } },
})

const prop = (id, name, verbs, extra = {}) => ({
  id, name, interactive: true, interaction: { kind: 'container', verbs, ...extra },
})

test('подсказки собираются из пропсов, NPC, цели и выхода', () => {
  const hints = suggestedActionsFor(room({
    scene: {
      objective: 'Найти пропавшего писаря',
      map: {
        props: [prop('chest-1', 'Окованный сундук', ['inspect', 'open'])],
        doors: [{ x: 1, y: 0, dir: 'e' }],
      },
    },
    scene_npcs: [{ id: 'npc-1', name: 'Бром', role: 'трактирщик', alive: true, stance: 'neutral' }],
  }))
  assert.deepEqual(hints.map((hint) => hint.text), [
    'Можно осмотреть: Окованный сундук',
    'Можно заговорить с кем-то из местных: Бром (трактирщик)',
    'Цель отряда: Найти пропавшего писаря',
    'Можно уйти из этого места через дверь',
  ])
  // Идентификаторы нужны клиенту, чтобы не перерисовывать закрытую панель.
  assert.deepEqual(hints.map((hint) => hint.id), ['prop:chest-1:inspect', 'npc:npc-1', 'objective', 'exit'])
})

test('в бою подсказок нет: там действия перечисляет хотбар', () => {
  const combat = room({
    scene: { objective: 'Выжить', map: { props: [prop('chest-1', 'Сундук', ['inspect'])], doors: [{ x: 1, y: 0, dir: 'e' }] } },
    scene_npcs: [{ id: 'npc-1', name: 'Бром', alive: true }],
    mechanics: { combat: { active: true } },
  })
  assert.deepEqual(suggestedActionsFor(combat), [])
})

test('пустая, чужая и бессодержательная комната не рождают подсказок', () => {
  assert.deepEqual(suggestedActionsFor(null), [])
  assert.deepEqual(suggestedActionsFor(undefined), [])
  assert.deepEqual(suggestedActionsFor('комната'), [])
  assert.deepEqual(suggestedActionsFor(room()), [])
  // Неинтерактивный пропс и незнакомый глагол пропускаются молча.
  assert.deepEqual(suggestedActionsFor(room({
    scene: { map: { props: [{ id: 'rug', name: 'Ковёр' }, prop('x', 'Штука', ['левитировать'])], doors: [] } },
  })), [])
  // Враждебный и мёртвый NPC — не собеседники.
  assert.deepEqual(suggestedActionsFor(room({
    scene_npcs: [
      { id: 'a', name: 'Головорез', alive: true, stance: 'hostile' },
      { id: 'b', name: 'Труп', alive: false },
    ],
  })), [])
})

test('порядок детерминирован, приметное впереди, число ограничено', () => {
  const many = room({
    scene: {
      objective: 'Цель',
      map: {
        props: [
          prop('b-crate', 'Ящик', ['open']),
          prop('a-altar', 'Алтарь', ['inspect'], { pointOfInterest: true }),
          prop('c-barrel', 'Бочка', ['topple']),
          prop('d-hay', 'Сено', ['ignite']),
        ],
        doors: [{ x: 0, y: 0, dir: 's' }],
      },
    },
    scene_npcs: [{ id: 'z', name: 'Зевака', alive: true }],
  })
  const first = suggestedActionsFor(many)
  assert.equal(first.length, MAX_ACTION_HINTS)
  assert.equal(first[0].text, 'Можно осмотреть: Алтарь', 'точка интереса идёт первой')

  // Тот же вход — тот же список: перестановка не должна выглядеть как событие.
  const shuffled = room({
    scene: {
      objective: 'Цель',
      map: {
        props: [...many.scene.map.props].reverse(),
        doors: [{ x: 0, y: 0, dir: 's' }],
      },
    },
    scene_npcs: many.scene_npcs,
  })
  assert.deepEqual(suggestedActionsFor(shuffled), first)
  assert.deepEqual(suggestedActionsFor(many), first)
})

test('подсказки не выносят из проекции ничего скрытого', () => {
  const state = normalizeCampaignState({
    sessionCode: 'HINTS',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Мира', hp: 20, maxHp: 20, armor: 14, x: 0, y: 0, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } }],
    enemies: [],
    scene: {
      turn: 1,
      objective: 'Найти писаря',
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
        // Дальняя часть зала ещё не раскрыта — и всё, что там стоит, тоже.
        { x: 5, y: 0, type: 'floor', revealed: false },
      ],
    },
    npc_world: {
      placements: [],
    },
    mechanics: { combat: { active: false } },
  })
  const projected = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.ok(Array.isArray(projected.suggested_actions), 'проекция обязана нести поле подсказок')

  const serialized = JSON.stringify(projected.suggested_actions)
  for (const secret of ['gm_only', 'hidden_information', 'секрет', 'ловушк', 'Скрытый']) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'iu'), `подсказки выдали ${secret}`)
  }
  // Цель сцены игрок и так видит в проекции — её подсказка повторить вправе.
  assert.ok(projected.suggested_actions.some((hint) => hint.text.includes('Найти писаря')))
  assert.ok(projected.suggested_actions.length <= MAX_ACTION_HINTS)

  // Каждая подсказка выводится только из того, что уже уехало игроку.
  assert.deepEqual(projected.suggested_actions, suggestedActionsFor(projected))
})
