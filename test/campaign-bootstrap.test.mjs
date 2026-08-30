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

test('стартовая деревня по карте мира автора рисуется улицами, даже если в названии «брод»', async () => {
  // Живая кампания: автор назвал стартовую точку «Тихий Брод» и на карте мира
  // отметил её деревней, но первая сцена рисовалась дорогой — по слову «брод».
  const opening = {
    campaignName: 'Зелёный камень', partyName: 'Одиночка',
    worldSummary: 'Долина с тихими деревнями.',
    openingNarration: 'К вечеру Тихий Брод погружается в тишину.\n\nУ колодца из земли выступает зелёный камень.',
    scene: { title: 'Камень у тихого брода', location: 'Тихий Брод', mood: 'Тревожная тишина', objective: 'Понять, что с камнем', theme: 'тихая деревня у реки', danger: 'низкая', map: { layout: 'open', pattern: 'natural', material: 'earth', width: 15, height: 11, openness: .6, water: 0, featureCount: 6 } },
    hook: 'Зелёный камень',
    worldMap: {
      name: 'Долина', locations: [
        { id: 'tihiy-brod', name: 'Тихий Брод', kind: 'village', x: 500, y: 360, summary: 'Деревня у брода.', known: true, visited: true },
        { id: 'veyr', name: 'Вейр', kind: 'city', x: 300, y: 200, summary: 'Город.', known: true, visited: false },
      ],
      routes: [{ id: 'route-1', from: 'tihiy-brod', to: 'veyr', kind: 'road', distance: 3, danger: 'низкая', discovered: true }],
    },
  }
  const authored = await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(opening) }]) }).create({
    code: 'BROD-1', name: 'Зелёный камень', partyName: 'Одиночка', world: { startingLocation: 'Тихий Брод' }, players: [hero],
  })
  assert.equal(authored.worldMap.locations.find((location) => location.id === authored.worldMap.currentLocationId)?.kind, 'village')
  assert.ok(authored.scene.cells.filter((cell) => cell.type === 'door').length >= 4, 'у стартовой деревни нет домов — нарисована дорога')

  // Без карты автора запасная карта ставит стартовой точке «город» вслепую — по
  // нему улицы не рисуются, и первая сцена остаётся прежней дорогой.
  const { worldMap: _authored, ...blind } = opening
  const fallback = await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(blind) }]) }).create({
    code: 'BROD-2', name: 'Зелёный камень', partyName: 'Одиночка', world: { startingLocation: 'Тихий Брод' }, players: [hero],
  })
  assert.equal(fallback.scene.cells.some((cell) => cell.type === 'door'), false)
})

test('стартовая сцена и currentLocationId не расходятся при ошибке карты автора', async () => {
  const opening = {
    campaignName: 'Несогласованный мир', partyName: 'Путники',
    worldSummary: 'Карта, в которой автор забыл стартовую точку.',
    openingNarration: 'История начинается в месте, которого ещё нет на карте.',
    scene: { title: 'Первый шаг', location: 'Несуществующий старт', mood: 'Тревога', objective: 'Осмотреться', theme: 'открытая местность', danger: 'низкая', map: { layout: 'open', pattern: 'natural', material: 'grass', width: 15, height: 11 } },
    hook: 'Найти дорогу',
    worldMap: {
      locations: [
        { id: 'foreign-fort', name: 'Чужой форт', kind: 'fortress', known: true },
        { id: 'foreign-port', name: 'Чужой порт', kind: 'port', known: true },
      ],
    },
  }
  const state = await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(opening) }]) }).create({
    code: 'MAP-MISMATCH', name: 'Несогласованный мир', partyName: 'Путники', world: {}, players: [hero],
  })
  const current = state.worldMap.locations.find((location) => location.id === state.worldMap.currentLocationId)
  assert.equal(state.scene.location, 'Несуществующий старт')
  assert.equal(state.scene.location_id, current?.id)
  assert.equal(current?.name, state.scene.location)
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
  assert.equal(requestContext.party_size, 1)
  assert.equal(requestContext.heroes[0].backstory, hero.backstory)
  assert.equal(requestContext.world.premise, 'Первый контакт')
  assert.match(llm.requests[0].messages[0].content, /campaign_setup\.party_size — точное число выбранных героев/u)
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

test('локальный пролог называет фактическое число незаполненных мест от одного до пяти', async () => {
  const forms = ['одного героя', 'двух героев', 'трёх героев', 'четырёх героев', 'пяти героев']
  for (let count = 1; count <= 5; count += 1) {
    const players = Array.from({ length: count }, (_, index) => ({
      ...hero,
      id: `slot-${count}-${index + 1}`,
      character: `Герой ${index + 1}`,
      characterSetupRequired: true,
    }))
    const state = await new CampaignBootstrapper().create({
      code: `SLOTS-${count}`,
      world: {},
      players,
    })
    assert.match(state.messages[0].text, new RegExp(forms[count - 1], 'u'))
  }
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

test('bootstrap locks the selected campaign ruleset while legacy callers keep 2024', async () => {
  const input = {
    code: 'RULESET-BOOTSTRAP', name: 'Редакции', partyName: 'Двое', world: {},
    players: [{ ...hero, id: 'hero-1', character: 'Первый' }],
  }
  const legacy = await new CampaignBootstrapper().create(input)
  assert.equal(legacy.ruleset_id, 'srd_5_2_1')
  assert.equal(legacy.ruleset_version, '5.2.1')

  const classic = await new CampaignBootstrapper().create({ ...input, code: 'RULESET-CLASSIC', rulesetId: 'dnd_5e_2014' })
  assert.equal(classic.ruleset_id, 'dnd_5e_2014')
  assert.equal(classic.ruleset_version, '2014.1.0')
  assert.deepEqual(classic.enabled_rule_packs, ['dnd_5e_2014'])
  assert.ok(classic.enabled_house_rules.includes('skazanie:2014-preview-legacy-catalogs-v1'))
  await assert.rejects(
    () => new CampaignBootstrapper().create({ ...input, code: 'RULESET-BAD', rulesetId: 'invented' }),
    (error) => error.code === 'RULESET_INVALID',
  )
})

test('герой без портрета получает лицо из спрайта отряда по номеру места', async () => {
  // Мастерский путь: администратор присылает готовый список героев, и портрета
  // в нём нет. Раньше поле оставалось пустой строкой, клиент красил ею фишку —
  // и на доске стоял пустой цветной кружок. Поле презентационное, механики оно
  // не касается, но пустым быть не имеет права.
  const state = await new CampaignBootstrapper().create({
    code: 'FACES-01',
    world: {},
    players: [
      { ...hero, id: 'face-one', character: 'Первая' },
      { ...hero, id: 'face-two', character: 'Второй' },
      { ...hero, id: 'face-three', character: 'Третья' },
      { ...hero, id: 'face-four', character: 'Четвёртый' },
      { ...hero, id: 'face-five', character: 'Пятая' },
    ],
  })

  const faces = state.players.map((player) => ({ portrait: player.portrait, position: player.portraitPosition }))
  assert.deepEqual(faces.map((face) => face.portrait), Array.from({ length: 5 }, () => '/assets/party-portraits.png'))
  // Подбор детерминированный и по номеру места: четыре подряд идущих героя
  // получают четыре разных лица, пятый идёт по кругу.
  assert.deepEqual(faces.map((face) => face.position), ['0% 0%', '100% 0%', '0% 100%', '100% 100%', '0% 0%'])
  // Цвет фишки подбирается той же таблицей и тоже не повторяется подряд.
  assert.equal(new Set(state.players.slice(0, 4).map((player) => player.color)).size, 4)
})

test('свой портрет героя сильнее подбора по месту и центрируется, а не режется по спрайту', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'FACES-02',
    world: {},
    players: [{ ...hero, id: 'own-face', portrait: 'data:image/png;base64,AAAA' }],
  })

  assert.equal(state.players[0].portrait, 'data:image/png;base64,AAAA')
  // Позиция из спрайта отряда имеет смысл только вместе со спрайтом: своя
  // картинка приходит целым файлом.
  assert.equal(state.players[0].portraitPosition, '50% 50%')
})
