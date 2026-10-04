// Плейтест 2026-10-04, QP-04: отряд ушёл из Вельдбурга, не закрыв нить главы,
// и журнал показал три равные активные задачи, среди них «Отряд покинул
// «Вельдбург», не закрыв прежнюю сюжетную нить». Сторож держит раскладку:
// одна текущая цель, перенесённые нити помечены, и ни одно задание при этом
// не закрывается и не меняется.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { journalQuestFocus } from '../src/journal-quests.mjs'

test('текущая цель — задание нынешней главы, задание прежней главы — незавершённая нить', () => {
  const state = {
    scene: { objective: 'Найти в Солёные Ворота другой путь к разгадке: Девятый колокол' },
    adventure: { chapter: 2 },
    worldMemory: { quests: [
      { id: 'quest-opening', title: 'Девятый колокол', status: 'active', objectives: ['Добраться до смотровой дамбы'] },
      { id: 'quest:chapter:1', title: 'Добраться до смотровой дамбы', summary: 'Отряд покинул «Вельдбург», не закрыв прежнюю сюжетную нить.', status: 'active' },
      { id: 'quest:chapter:2', title: 'Найти в Солёные Ворота другой путь', status: 'active', objectives: ['Найти в Солёные Ворота другой путь к разгадке: Девятый колокол'] },
      { id: 'quest:chapter:0-old', title: 'Не глава', status: 'active' },
      { id: 'quest-done', title: 'Закрытое', status: 'completed' },
    ] },
  }
  assert.deepEqual(journalQuestFocus(state), { currentId: 'quest:chapter:2', carriedIds: ['quest:chapter:1'] })
})

test('без задания главы текущая цель находится по цели сцены, а нитей нет', () => {
  const state = {
    scene: { objective: 'Найти  пропавшего курьера' },
    adventure: { chapter: 3 },
    worldMemory: { quests: [
      { id: 'quest-side', title: 'Груз для мельника', status: 'active', objectives: ['Доставить муку'] },
      { id: 'quest-story', title: 'Курьер', status: 'active', objectives: ['найти пропавшего курьера'] },
    ] },
  }
  assert.deepEqual(journalQuestFocus(state), { currentId: 'quest-story', carriedIds: [] })
  assert.deepEqual(journalQuestFocus({ scene: { objective: 'Осмотреться' }, adventure: { chapter: 1 } }), { currentId: '', carriedIds: [] })
  assert.deepEqual(journalQuestFocus(null), { currentId: '', carriedIds: [] })
})

test('уход без завершения: нить прежней главы помечена, но остаётся активной', async () => {
  const objective = 'Добраться до смотровой дамбы, понять источник звона и не дать толпе открыть шлюзы.'
  const initial = normalizeCampaignState({
    sessionCode: 'JOURNAL-FOCUS', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Брам', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Колокол под мутной водой', location: 'Вельдбург', mood: 'Тревога', objective, turn: 3, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }] },
    adventure: { chapter: 1, currentHook: 'Девятый колокол зовёт', unresolvedThreads: [], visitedLocations: ['Вельдбург'], history: [] },
  })
  const { sceneArgs } = await new SceneArchitectAgent().plan({ state: initial, decision: 'Уходим в Солёные Ворота', destinationHint: 'Солёные Ворота' })
  assert.equal(sceneArgs.carry_unresolved, true)
  const { state } = resolveCommands([{ command_type: 'AdvanceScene', command_id: 'leave-veldburg', scene_args: sceneArgs }], initial,
    { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { isAdmin: true } })

  const focus = journalQuestFocus(state)
  assert.equal(focus.currentId, 'quest:chapter:2')
  assert.deepEqual(focus.carriedIds, ['quest:chapter:1'])
  const carried = state.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1')
  assert.equal(carried.status, 'active', 'перенесённая нить не закрывается автоматически')
  assert.match(carried.summary, /не закрыв прежнюю сюжетную нить/u)
})

test('журнал выводит текущую цель первой и подписывает перенесённые нити', () => {
  const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/campaign-pages.css', import.meta.url), 'utf8')
  assert.match(views, /const questFocus = journalQuestFocus\(state\)/u)
  assert.match(views, /\{orderedQuests\.map\(\(quest\) => \{/u)
  assert.match(views, />Текущая цель</u)
  assert.match(views, />Незавершённая нить · задание остаётся открытым</u)
  assert.match(styles, /\.quest-card \.quest-tag \{/u)
})
