import type { GameState, InventoryItem, MapCell, Merchant, Player } from './types'

const layout = [
  '#############',
  '##....#??????',
  '#.....D??????',
  '#..~..#??????',
  '#..~........#',
  '#..~~.#.....#',
  '#.....D.....#',
  '###.#########',
  '#############',
]

const features: Record<string, MapCell['feature']> = {
  '3,1': 'torch',
  '1,4': 'altar',
  '4,6': 'rune',
  '8,4': 'chest',
  '10,5': 'enemy',
  '11,6': 'stairs',
}

export const createMap = (): MapCell[] =>
  layout.flatMap((row, y) =>
    [...row].map((char, x) => ({
      x,
      y,
      type: char === '#' || char === '?' ? 'wall' : char === '~' ? 'water' : char === 'D' ? 'door' : 'floor',
      revealed: char !== '?',
      feature: features[`${x},${y}`],
    } as MapCell)),
  )

const starterItems: Record<string, InventoryItem[]> = {
  lira: [
    { id: 'lira-longbow', catalog_id: 'srd_5_2_1:longbow', base_price_cp: 5000, name: 'Длинный лук', type: 'weapon', quantity: 1, weight: 2, equipped: false, rarity: 'обычный', description: 'Высокий тисовый лук с тугой тетивой. Лира носит его в промасленном чехле.', properties: '1к8 колющего урона · дальность 150/600 фт · боеприпас · двуручное.', image: '', imageStatus: 'ready', combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600, twoHanded: true, ammunition: true } },
    { id: 'lira-fire-bomb', name: 'Алхимическая граната', type: 'consumable', quantity: 2, weight: 1, equipped: false, rarity: 'необычный', description: 'Глиняная сфера с алхимическим запалом. Взрывается при ударе о твёрдую поверхность.', properties: 'Домашнее правило: бросок до 60 фт, взрыв радиусом 10 фт; Ловкость СЛ 12, 2к6 огнём, половина при успехе.', image: '', imageStatus: 'ready', combat: { kind: 'thrown-area', ability: 'dex', damage: '2d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex', saveDc: 12, halfOnSave: true } },
    { id: 'map-norvin', name: 'Карта затопленного архива', type: 'document', quantity: 1, weight: .1, equipped: false, rarity: 'сюжетный', description: 'Промасленный лист пергамента с планом подземного архива. Часть линий проявляется только рядом с зелёными рунами.', properties: 'Можно приблизить. Красные отметки указывают на старый путь архивариуса.', image: '/assets/items/norvin-map.png', imageStatus: 'ready' },
    { id: 'emerald-compass', name: 'Компас тихих вод', type: 'tool', quantity: 1, weight: .3, equipped: true, rarity: 'необычный', description: 'Латунный компас, чья зелёная стрелка указывает не на север, а к ближайшему безопасному берегу.', properties: 'Преимущество при навигации в затопленных подземельях.', image: '/assets/items/item-atlas.png', imagePosition: '0% 0%', imageStatus: 'ready' },
    { id: 'healing-vial', catalog_id: 'srd_5_2_1:potion-of-healing', base_price_cp: 5000, name: 'Малое зелье лечения', type: 'consumable', quantity: 2, weight: .2, equipped: false, rarity: 'обычный', description: 'Густая алая жидкость пахнет можжевельником и железом. На свету внутри вспыхивают золотые искры.', properties: 'Восстанавливает 2к4 + 2 хита.', image: '/assets/items/item-atlas.png', imagePosition: '100% 0%', imageStatus: 'ready' },
  ],
  brann: [
    { id: 'watchful-amulet', name: 'Амулет дозорного', type: 'treasure', quantity: 1, weight: .2, equipped: true, rarity: 'редкий', description: 'Холодный серебряный глаз никогда не отражает лицо владельца. Иногда в нём виден силуэт того, кто наблюдает из темноты.', properties: '+1 к Внимательности в подземельях.', image: '/assets/items/item-atlas.png', imagePosition: '0% 100%', imageStatus: 'ready' },
    { id: 'brann-journal', name: 'Полевой журнал', type: 'document', quantity: 1, weight: .5, equipped: false, rarity: 'обычный', description: 'Потрёпанная книга в кожаном переплёте. Бранн записывает сюда имена павших и долги, которые ещё предстоит вернуть.', properties: 'Содержит заметки о встреченных угрозах.', image: '/assets/items/item-atlas.png', imagePosition: '100% 100%', imageStatus: 'ready' },
  ],
  miriel: [{ id: 'miriel-potion', catalog_id: 'srd_5_2_1:potion-of-healing', base_price_cp: 5000, name: 'Малое зелье лечения', type: 'consumable', quantity: 1, weight: .2, equipped: false, rarity: 'обычный', description: 'Густая алая жидкость с золотыми искрами.', properties: 'Восстанавливает 2к4 + 2 хита.', image: '/assets/items/item-atlas.png', imagePosition: '100% 0%', imageStatus: 'ready' }],
  torvald: [{ id: 'torvald-journal', name: 'Книга дорожных молитв', type: 'document', quantity: 1, weight: .5, equipped: true, rarity: 'обычный', description: 'Небольшая книга с мягкими страницами, исписанными рукой Торвальда.', properties: 'Священный символ и записи об обрядах.', image: '/assets/items/item-atlas.png', imagePosition: '100% 100%', imageStatus: 'ready' }],
}

const baseDetails = { level: 3, species: 'Человек', background: 'Странник', alignment: 'Нейтрально-добрый', experience: 900, speed: 30, proficiency: 2, traits: 'Сначала наблюдает, затем действует.', ideals: 'Свобода важнее удобства.', bonds: 'Отряд — её новая семья.', flaws: 'Слишком долго хранит опасные тайны.', backstory: 'Путь в Норвин начался с письма без подписи и карты, которую невозможно сжечь.', features: 'Тёмное зрение · Следопыт · Владение лёгкими доспехами', notes: '', currency: { copper: 8, silver: 14, gold: 37, platinum: 0 } }

export const players: Player[] = [
  { ...baseDetails, id: 'lira', name: 'Антон', character: 'Лира Вейл', role: 'Следопыт · ур. 3', color: '#d79b5b', initials: 'ЛВ', portrait: '/assets/party-portraits.png', portraitPosition: '0% 0%', abilities: { str: 11, dex: 17, con: 14, int: 12, wis: 15, cha: 10 }, inventory: starterItems.lira, hp: 24, maxHp: 28, armor: 15, online: true, x: 4, y: 4 },
  { ...baseDetails, id: 'brann', name: 'Маша', character: 'Бранн', role: 'Воин · ур. 3', species: 'Человек', background: 'Солдат', color: '#758f78', initials: 'БР', portrait: '/assets/party-portraits.png', portraitPosition: '100% 0%', abilities: { str: 17, dex: 12, con: 16, int: 10, wis: 13, cha: 11 }, inventory: starterItems.brann, hp: 31, maxHp: 34, armor: 18, online: true, x: 3, y: 5 },
  { ...baseDetails, id: 'miriel', name: 'Илья', character: 'Мириэль', role: 'Чародей · ур. 3', species: 'Высший эльф', background: 'Учёная', color: '#8b789e', initials: 'МИ', portrait: '/assets/party-portraits.png', portraitPosition: '0% 100%', abilities: { str: 8, dex: 14, con: 13, int: 16, wis: 12, cha: 17 }, inventory: starterItems.miriel, hp: 17, maxHp: 19, armor: 12, online: true, x: 4, y: 5 },
  { ...baseDetails, id: 'torvald', name: 'Соня', character: 'Торвальд', role: 'Жрец · ур. 3', species: 'Человек', background: 'Прислужник', color: '#9a745d', initials: 'ТО', portrait: '/assets/party-portraits.png', portraitPosition: '100% 100%', abilities: { str: 12, dex: 10, con: 14, int: 13, wis: 17, cha: 15 }, inventory: starterItems.torvald, hp: 22, maxHp: 25, armor: 16, online: false, x: 3, y: 4 },
]

export const merchants: Merchant[] = [
  {
    id: 'marten-road-cart',
    name: 'Мартен Рыжий',
    title: 'Странствующий торговец и сборщик редкостей',
    description: 'Мартен возит припасы между монастырями и пограничными селениями. Он ценит хорошие истории почти так же высоко, как звонкую монету.',
    greeting: 'Подходите ближе. Всё честно взвешено, а цена ещё может стать дружелюбнее — если разговор удастся.',
    initials: 'МР',
    location: 'Подземелья монастыря Норвин',
    available: true,
    pricing: {
      mode: 'catalog_with_agent_adjustment',
      catalog_id: 'srd_5_2_1',
      buy_markup_percent: 10,
      sell_rate_percent: 50,
      agent_adjustment_limit_percent: 20,
      description: 'Базовая цена берётся из каталога SRD; характер и обстоятельства торговца дают ограниченную поправку, а успешный торг применяется отдельно.',
    },
    stock: [
      { stock_id: 'marten-healing-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: 3, base_price_cp: 5000, weight: .5, rarity: 'обычный', description: 'Красная жидкость мерцает, если встряхнуть флакон.', properties: 'Восстанавливает 2к4 + 2 хита.' },
      { stock_id: 'marten-hempen-rope', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', name: 'Пеньковая верёвка, 50 футов', type: 'tool', quantity: 4, base_price_cp: 100, weight: 10, rarity: 'обычный', description: 'Туго свитая дорожная верёвка без заметных повреждений.', properties: '50 футов пеньковой верёвки.' },
      { stock_id: 'marten-rations', catalog_id: 'srd_5_2_1:rations-one-day', name: 'Сухой паёк, 1 день', type: 'consumable', quantity: 12, base_price_cp: 50, weight: 2, rarity: 'обычный', description: 'Сухари, вяленое мясо и орехи в промасленной бумаге.', properties: 'Дневной рацион одного путешественника.' },
      { stock_id: 'marten-torches', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'tool', quantity: 10, base_price_cp: 1, weight: 1, rarity: 'обычный', description: 'Просмолённый факел, защищённый от сырости.', properties: 'Горит 1 час и даёт яркий свет в радиусе 20 футов.' },
      { stock_id: 'marten-arrows', catalog_id: 'srd_5_2_1:arrows-20', name: 'Стрелы, 20 штук', type: 'other', quantity: 5, base_price_cp: 100, weight: 1, rarity: 'обычный', description: 'Связка ровных стрел с гусиным оперением.', properties: 'Боеприпасы для лука, 20 штук.' },
    ],
  },
]

export const initialState: GameState = {
  sessionCode: 'RUNE-742',
  campaign: 'Пепел забытого королевства',
  partyName: 'Отряд Пепельной руны',
  partyMemberIds: players.filter((player) => player.online).map((player) => player.id),
  state_version: 0,
  ruleset_id: 'srd_5_2_1',
  ruleset_version: '5.2.1',
  enabled_rule_packs: ['srd_5_2_1'],
  enabled_house_rules: ['skazanie:economy:merchant-policy-v1'],
  ruleset_locked_at: '2026-07-11T00:00:00.000Z',
  engine_mode: 'shadow',
  players,
  merchants,
  enemies: [{ id: 'archive-guardian', name: 'Страж архива', hp: 18, maxHp: 18, armor: 13, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 2, x: 10, y: 5, alive: true }],
  tacticalTurn: { sceneTurn: 7, actorId: 'lira', movementSpent: 0, actionUsed: false },
  mapFeedback: [],
  battleLog: [],
  economyLog: [],
  activePlayerId: 'lira',
  isNarrating: false,
  pendingCheck: null,
  lastDiceRoll: null,
  suggestions: ['Осторожно осмотреть воду', 'Изучить зеленоватый знак', 'Проверить механизм двери'],
  scene: {
    title: 'Затопленный архив',
    location: 'Подземелья монастыря Норвин',
    mood: 'Тревожно и тихо',
    objective: 'Найти печать архивариуса',
    turn: 7,
    cells: createMap(),
  },
  messages: [
    {
      id: 'm1',
      speaker: 'narrator',
      author: 'Рассказчик',
      timestamp: '21:42',
      text: 'Каменная дверь поддаётся с протяжным стоном. За ней — архив, наполовину ушедший под чёрную воду. В дальнем конце зала мерцает зеленоватый знак. Воздух пахнет мокрой бумагой и железом.',
    },
    {
      id: 'm2',
      speaker: 'player',
      author: 'Бранн',
      timestamp: '21:43',
      text: 'Я придерживаю дверь щитом и всматриваюсь в воду. Здесь точно что-то не так.',
    },
    {
      id: 'm3',
      speaker: 'narrator',
      author: 'Рассказчик',
      timestamp: '21:43',
      text: 'На поверхности расходятся три ровных круга — один за другим, словно кто-то под водой услышал голос Бранна.',
      roll: { value: 14, modifier: 3, total: 17, label: 'Внимательность', success: true },
    },
  ],
}
