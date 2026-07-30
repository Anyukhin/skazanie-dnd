import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import { UNTRUSTED_DATA_END, UNTRUSTED_DATA_START } from '../server/security.mjs'

// Сообщение автору кампании собирается через buildDataOnlyContext: полезная
// нагрузка лежит внутри блока UNTRUSTED_DATA и извлекается по его маркерам.
function untrustedPayload(content, section) {
  const open = `${UNTRUSTED_DATA_START}:${section}>>>`
  const close = `${UNTRUSTED_DATA_END}:${section}>>>`
  const start = content.indexOf(open)
  const end = content.indexOf(close)
  assert.ok(start >= 0 && end > start, `блок UNTRUSTED_DATA:${section} обязан присутствовать`)
  return JSON.parse(content.slice(start + open.length, end))
}

const hero = {
  id: 'nova',
  name: 'Анна',
  character: 'Нова Рей',
  role: 'Пилот · ур. 1',
  species: 'Человек',
  background: 'Бывший навигатор',
  backstory: 'Ищет пропавший исследовательский корабль своего брата.',
  speed: 30,
  maxHp: 12,
  armor: 13,
  online: true,
}

test('новая кампания создаёт чистый самостоятельный контекст без данных затопленного архива', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'STARS-01',
    name: 'За пределами Ориона',
    partyName: 'Экипаж Авроры',
    world: {
      era: 'Далёкое будущее',
      genre: 'Космическая опера',
      tone: 'Исследование неизвестного и дипломатия',
      premise: 'Человечество впервые принимает сигнал из-за границы изученного космоса.',
      openingSituation: 'Экипаж прибывает к молчащей орбитальной станции вслед за сигналом бедствия.',
      technologyLevel: 'Межзвёздные перелёты',
      magicLevel: 'Без магии',
    },
    players: [hero],
  })

  assert.equal(state.campaign, 'За пределами Ориона')
  assert.equal(state.campaignConcept.era, 'Далёкое будущее')
  assert.equal(state.campaignConcept.generatedBy, 'local-storyteller')
  assert.deepEqual(state.partyMemberIds, ['nova'])
  assert.deepEqual(state.enemies, [])
  assert.deepEqual(state.adventure.history, [])
  assert.equal(state.scene.turn, 1)
  assert.match(state.scene.location, /станци/iu)
  assert.doesNotMatch(JSON.stringify(state), /затоплен|архивариус|Норвин/iu)
  assert.ok(state.scene.cells.length >= 49)
  assert.equal(state.messages.length, 1)
  assert.equal(state.players[0].currency.gold, 20)
  assert.equal(state.players[0].inventory.length, 1)
  assert.equal(state.players[0].inventory[0].equipped, true)
  assert.ok(state.players[0].inventory[0].combat?.damage)
})

test('стартовый набор соответствует классу и не перезаписывает готовый лист', async () => {
  const fighter = await new CampaignBootstrapper().create({
    code: 'KIT-FIGHTER', world: {}, players: [{ ...hero, id: 'fighter', role: 'Воин · ур. 1', abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } }],
  })
  assert.equal(fighter.players[0].characterClass, 'fighter')
  assert.equal(fighter.players[0].abilities.str, 16)
  assert.equal(fighter.players[0].inventory[0].catalog_id, 'srd_5_2_1:longsword')
  assert.equal(fighter.players[0].inventory[0].combat.damage, '1d8')

  const importedInventory = [{ id: 'keepsake', name: 'Памятный знак', type: 'quest', quantity: 1, equipped: false }]
  const imported = await new CampaignBootstrapper().create({
    code: 'KIT-IMPORTED', world: {}, players: [{
      ...hero, id: 'imported', role: 'Следопыт · ур. 1', inventory: importedInventory,
      currency: { copper: 3, silver: 2, gold: 7, platinum: 0 },
      abilities: { str: 9, dex: 15, con: 12, int: 11, wis: 14, cha: 10 },
    }],
  })
  assert.equal(imported.players[0].inventory[0].id, 'keepsake')
  assert.equal(imported.players[0].currency.gold, 7)
  assert.equal(imported.players[0].abilities.dex, 15)
})

test('рассказчик получает вводные владельца и биографии героев до создания пролога', async () => {
  const llm = new FakeLLM([{ content: JSON.stringify({
    campaignName: 'Небесные кочевники', partyName: 'Искатели рассвета',
    worldSummary: 'Мир независимых звёздных городов.',
    openingNarration: 'Нова узнаёт позывной корабля брата.\n\nШлюз станции открывается, и экипаж решает, кто войдёт первым.',
    scene: { title: 'Позывной из тишины', location: 'Станция «Тихая гавань»', mood: 'Напряжённое ожидание', objective: 'Найти источник позывного', theme: 'заброшенная космическая станция', danger: 'средняя', map: { layout: 'rooms', width: 13, height: 9, openness: .6, water: 0, featureCount: 4 } },
    hook: 'Позывной пропавшего корабля',
    suggestions: ['Проверить шлюз', 'Просканировать станцию', 'Ответить на позывной'],
  }) }])
  const state = await new CampaignBootstrapper({ llmClient: llm }).create({
    code: 'SIGNAL-7', name: 'Сигнал', partyName: 'Искатели',
    world: { era: 'Будущее', genre: 'Научная фантастика', premise: 'Первый контакт', openingSituation: 'Неизвестный сигнал' },
    players: [hero],
  })

  const requestContext = untrustedPayload(llm.requests[0].messages[1].content, 'campaign_setup')
  assert.equal(requestContext.heroes[0].backstory, hero.backstory)
  assert.equal(requestContext.world.premise, 'Первый контакт')
  assert.equal(state.campaignConcept.generatedBy, 'ai-storyteller')
  assert.equal(state.scene.title, 'Позывной из тишины')
  assert.match(state.messages[0].text, /корабля брата/iu)
  assert.match(state.messages[0].text, /\n\n/u)
})

test('пустые вводные мира разрешены и передаются рассказчику для свободной генерации', async () => {
  const llm = new FakeLLM([{ content: JSON.stringify({
    campaignName: 'Небесные кочевники', partyName: 'Искатели рассвета',
    worldSummary: 'Города кочуют по спинам древних небесных существ.',
    openingNarration: 'Над кочующим городом гаснет искусственное солнце.\n\nГерои замечают сигнал на запретной башне.',
    scene: { title: 'Погасшее солнце', location: 'Кочующий город', mood: 'Тревожное чудо', objective: 'Добраться до башни', theme: 'город на небесном существе', danger: 'средняя', map: { layout: 'streets', width: 11, height: 9, openness: .6, water: 0, featureCount: 4 } },
    hook: 'Сигнал на запретной башне', suggestions: ['Осмотреть небо', 'Идти к башне'],
  }) }])
  const state = await new CampaignBootstrapper({ llmClient: llm }).create({
    code: 'AUTO-01', name: '', partyName: '', world: {}, players: [hero],
  })

  const requestContext = untrustedPayload(llm.requests[0].messages[1].content, 'campaign_setup')
  assert.equal(requestContext.world.era, '')
  assert.equal(requestContext.world.genre, '')
  assert.equal(requestContext.world.preset, '')
  assert.equal(state.campaign, 'Небесные кочевники')
  assert.equal(state.partyName, 'Искатели рассвета')
  assert.match(state.campaignConcept.worldSummary, /небесных существ/iu)
})

test('свободный текст пресета передаётся агенту без ограничения списком', async () => {
  const llm = new FakeLLM([{ content: '{}' }])
  await new CampaignBootstrapper({ llmClient: llm }).create({
    code: 'CUSTOM-1', world: { preset: 'Подводный соларпанк с разумными китами' }, players: [hero],
  })
  const requestContext = untrustedPayload(llm.requests[0].messages[1].content, 'campaign_setup')
  assert.equal(requestContext.world.preset, 'Подводный соларпанк с разумными китами')
})

test('создание кампании без выбранных героев отклоняется', async () => {
  await assert.rejects(
    () => new CampaignBootstrapper().create({ code: 'EMPTY-1', name: 'Пусто', partyName: 'Никого', world: {}, players: [] }),
    /выберите от 1 до 12 героев/iu,
  )
})

test('bootstrap fixes a deterministic one-evening structure and matching quest budgets', async () => {
  const input = {
    code: 'EVENING-SEED',
    name: 'Один вечер',
    partyName: 'Свидетели',
    world: { preset: 'Классическое фэнтези', premise: 'Колокол зовёт к старой башне.' },
    players: [{ ...hero, id: 'evening-hero' }],
  }
  const first = await new CampaignBootstrapper().create(input)
  const second = await new CampaignBootstrapper().create(input)

  assert.deepEqual(first.campaignConcept.arc, second.campaignConcept.arc)
  assert.equal(first.campaignConcept.arc.preset, 'one_evening')
  assert.ok(first.campaignConcept.arc.target_scenes >= 3 && first.campaignConcept.arc.target_scenes <= 5)
  const chapterQuest = first.worldMemory.quests.find((quest) => quest.id === 'quest:chapter:1')
  const mainQuest = first.worldMemory.quests.find((quest) => !String(quest.id).startsWith('quest:chapter:'))
  assert.equal(chapterQuest.clock.max, 2)
  assert.equal(mainQuest.clock.max, first.campaignConcept.arc.target_scenes)
})
