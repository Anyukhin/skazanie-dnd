// Эталон для `combat_phrases.rs`: склонения, подписи и сотни сценариев
// выбора формулировок одной книгой фраз — прогоном самого JS.
//
//   node rust/crates/sk-narration-base/fixtures/gen-combat-phrases.mjs
//
// Пишет `combat-phrases.json` рядом. Входы детерминированы (mulberry32 с
// постоянным зерном), поэтому повторный прогон даёт тот же файл, пока не
// меняется `server/combat-phrases.mjs` или данные бестиария и каталога.
import { readFileSync, writeFileSync } from 'node:fs'

import {
  Phrasebook,
  accusativeName,
  actionPhrase,
  attackPhrase,
  confidentAccusative,
  damagePhrase,
  downedPhrase,
  encounterEndPhrase,
  encounterIntroPhrase,
  hoursLabelRu,
  joinRu,
  lowerFirst,
  movePhrase,
  phraseSeed,
  savePhrase,
  spellSourceText,
  stabilizedPhrase,
  tacticLead,
  turnEndPhrase,
  turnStartPhrase,
} from '../../../../server/combat-phrases.mjs'

const root = new URL('../../../../', import.meta.url)
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(20261013)
const chance = (p) => random() < p
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const choice = (list) => list[Math.floor(random() * list.length)]

// ---------------------------------------------------------------------------
// Корпус имён
// ---------------------------------------------------------------------------

const monsters = readJson('data/compendia/dnd_5e_2014/monsters.json').monsters
const monsterNames = monsters.map((monster) => monster.name_ru)
const actionNames = [...new Set(monsters.flatMap((monster) => [
  ...(monster.actions ?? []), ...(monster.bonus_actions ?? []), ...(monster.reactions ?? []),
]).map((action) => action?.name_ru ?? action?.name).filter(Boolean))]
const catalog = Object.values(readJson('rust/data/item-catalog.json'))
const weaponNames = catalog.filter((item) => item.weapon || item.category === 'weapon').map((item) => item.name)

const adjectivesM = ['Лютый', 'Бурый', 'Ночной', 'Тихий', 'Каменный', 'Огромный', 'Древний', 'Синий', 'Злобный', 'Гигантский', 'Дикий', 'Молодой', 'Мясной', 'Огненный', 'Старый', 'Глухой', 'Рыжий']
const adjectivesF = ['Гигантская', 'Чёрная', 'Синяя', 'Летучая', 'Бешеная', 'Старая', 'Злая', 'Ночная', 'Древняя', 'Огромная', 'Лютая', 'Тёмная']
const nounsM = ['волк', 'медведь', 'кабан', 'конь', 'змей', 'князь', 'воевода', 'дядя', 'судья', 'паук', 'скорпион', 'элементаль', 'страж', 'тролль', 'слуга', 'ворон', 'дракон', 'вор', 'гоблин-воин', 'юноша', 'жрец']
const nounsF = ['крыса', 'слизь', 'змея', 'птица', 'мышь', 'ведьма', 'гарпия', 'стая', 'тень', 'лиса', 'жаба', 'дева', 'нежить', 'гидра', 'кобра', 'химера']
const nounsN = ['чудище', 'чудовище', 'существо', 'облако', 'пугало']
const heroNames = ['Мира', 'Торвальд', 'Ада', 'Брам Тихий Молот', 'Мирель', 'Борин', 'Лиара Звёздная', 'Тень', 'Эльдар', 'Ия', 'Илья', 'Зоя', 'Кай', 'Лев', 'Ёж', 'Аня-Мария', 'Огр 2', 'Ворон', 'Мия', 'Яга', 'Бая']
const oddNames = [
  '', ' ', 'Goblin', 'Гоблин 1', 'Гоблин  2', '  Волк  12 ', 'Гоблин-воин 3', 'Скелет минотавра 2', 'Капитан разбойников 1',
  'ВОЛК', 'Волк Волк', 'Лютый волк 2', 'лютый волк', 'Гигантская крыса 3', 'Зомби 2', 'зомби', 'Пугало', 'Облако',
  'Суккуб / Инкуб', 'Молодой красный дракон', 'Ускользающий зверь', 'Шлемоносный ужас', 'Брам\tТихий\nМолот', 'Гоблин1',
  'Гоблин-', '-Гоблин', 'Гоблин--воин', 'Волк-1', 'Ия', 'Ая', 'Ия 2', 'Змея', 'Земля', 'Ладья', 'Кий', 'Чай', 'Мужчина',
  'Лиса Патрикеевна', 'Синяя Борода', 'Тихий омут', 'Злой и добрый', 'Древний синий дракон', 'Старый мудрый филин',
  'Синее существо', 'Гигантская летучая мышь', 'Злобный старый волк 4', 'Огромный тролль 10', 'Ночная гарпия',
  'Бешеная стая', 'Лютая змея', 'Тёмная нежить', 'Огненный элементаль 2', 'Каменный страж', 'Дикий кабан 1',
  'Молодой жрец', 'Старая ведьма', 'Ворон 3', 'Ёж', 'ЁЖ', 'Ёлка', 'Слизь', 'Чёрная слизь 2', 'Тень 3', 'Мимик',
  'Bandit 1', 'Гоблин 1a', 'Вор 007', 'Страж ворот', 'Страж ворот', 'Хозяин леса', 'Повелитель мух',
  'Скелет', 'Скелет воина', 'Голова', 'Голова змеи', 'Кобольд-шаман', 'Кобольд-шаман 2', 'Гиена-людоед',
  'Мать-гиена', 'Человек-ящер', 'Человек-ящер 2', 'Тролль Злобный', 'Глухой', 'Глухая', 'Синий', 'Синяя', 'Заяц-беляк',
  'Бес$&', 'Вор $1', '{actor}', '{feet}', '{name}', 'Мира$`', "Мира$'", 'Мира$$',
]
const generated = []
for (let index = 0; index < 220; index += 1) {
  const feminine = chance(0.4)
  const neuter = !feminine && chance(0.15)
  const count = int(1, 2)
  const adjectives = Array.from({ length: count }, () => (feminine ? choice(adjectivesF) : choice(adjectivesM)))
  const noun = neuter ? choice(nounsN) : feminine ? choice(nounsF) : choice(nounsM)
  const number = chance(0.3) ? ` ${int(1, 15)}` : ''
  generated.push(`${adjectives.join(' ')} ${noun}${number}`)
}
for (let index = 0; index < 60; index += 1) {
  const head = choice([...monsterNames, ...heroNames])
  generated.push(chance(0.5) ? `${head} ${int(1, 9)}` : `${head}${choice([' ', '  ', '\t'])}${choice(nounsM)}`)
}
const names = [...new Set([...monsterNames, ...heroNames, ...oddNames, ...generated])]

// ---------------------------------------------------------------------------
// Простые функции
// ---------------------------------------------------------------------------

const nameCases = names.map((name) => ({
  name,
  accusative: accusativeName(name),
  confident: confidentAccusative(name),
  lower_first: lowerFirst(name),
}))

const hourInputs = [
  ...Array.from({ length: 131 }, (_, index) => index - 5),
  0.4, 0.5, 1.49, 1.5, 2.5, -0.4, -0.5, 10.5, 11.5, 14.49, 21.7, 111, 112, 1000.5, 1e6, 1e21, 1e22, 'NaN', 'Infinity', '-Infinity',
]
const hourCases = hourInputs.map((input) => ({ input, label: hoursLabelRu(Number(input)) }))

const joinCases = []
for (let index = 0; index < 60; index += 1) {
  const items = Array.from({ length: int(0, 5) }, () => choice([...names.slice(0, 30), '', ' ', '  а  ']))
  joinCases.push({ items, text: joinRu(items) })
}

function randomEvent() {
  if (chance(0.08)) return null
  const event = {}
  if (chance(0.6)) event.event_id = choice([`evt-${int(1, 400)}`, `  evt-${int(1, 50)}  `, int(0, 99), '', ' ', true, [int(1, 3), 'x'], null])
  if (chance(0.8)) event.event_type = choice(['AttackResolved', 'DamageApplied', 'TurnStarted', 'TurnEnded', 'ActorMoved', 'SavingThrowResolved', 'EncounterCreated', 'EncounterEnded', 7, null])
  if (chance(0.7)) event.actor_id = choice(['hero', 'goblin-1', 'wolf-2', 'npc:mira', '', null, 3])
  if (chance(0.6)) event.target_ids = chance(0.85) ? Array.from({ length: int(0, 3) }, () => choice(['hero', 'goblin-1', 'wolf-2', null, 5, ['a', 'b'], { x: 1 }])) : choice(['hero', 5, { a: 1 }])
  if (chance(0.4)) event.command_id = choice([`cmd-${int(1, 30)}`, '', null, 42])
  if (chance(0.5)) event.state_version_after = choice([int(0, 500), 1.5, 1e21, 1e-7, '12', null, -3])
  return event
}

const seedCases = Array.from({ length: 150 }, () => {
  const event = randomEvent()
  return { event, seed: phraseSeed(event) }
})

// ---------------------------------------------------------------------------
// Сценарии одной книги фраз
// ---------------------------------------------------------------------------

const weapons = [
  ...weaponNames, ...actionNames,
  'Длинный меч +1', 'длинный меч  +2 ', 'Жестокий длинный меч', 'Длинный меч предупреждения', 'КОРОТКИЙ ЛУК', '  лук  ',
  'Метательное копьё', 'копьё', 'Посох', 'боевой   посох', 'Разлагающий кулак', 'Размашистый удар', 'Когти',
  'Тяжёлый арбалет +3', 'Огненная стрела', 'Укус волка', 'Лук охотника', 'камень', '', 'меч', 'Пика всадника',
]
const damageTypes = ['slashing', 'piercing', 'bludgeoning', 'fire', 'default', '', 'constructor-free']
const tactics = ['сокращает дистанцию', 'выходит на линию атаки', 'держит дистанцию', 'пытается спастись', 'тактика стаи', 'давит на раненого', 'загнан в угол', 'стоит на месте', '']
const settings = ['underground', 'night', 'forest', 'road', 'graveyard', 'settlement', 'ambush', 'generic', 'swamp', '']
const actions = ['dash', 'disengage', 'dodge', 'help', 'hide', 'search', 'ready', '', 7]

function randomPayload() {
  const payload = {}
  if (chance(0.6)) payload.hit = choice([true, false, 1, 0, 'да', ''])
  if (chance(0.25)) payload.critical = choice([true, false, 1])
  if (chance(0.1)) payload.automatic_critical = choice([true, false])
  if (chance(0.15)) payload.spell_id = choice(['fire-bolt', '', null, 0])
  if (chance(0.08)) payload.spell_name = choice(['Огненный снаряд', ''])
  if (chance(0.6)) payload.attack_kind = choice(['melee', 'ranged', 'thrown', 'spell', '', null, ['ranged']])
  if (chance(0.6)) payload.item_name = choice([...weapons, null, 0])
  if (chance(0.6)) payload.action_name = choice(weapons)
  if (chance(0.5)) payload.damage_type = choice(damageTypes)
  return chance(0.05) ? choice([null, 'строка', 5]) : payload
}

const optionalText = (values) => (chance(0.5) ? choice(values) : undefined)

function randomCall(events) {
  const event = choice(events)
  const actor = choice(names)
  const target = choice(names)
  const kind = choice(['attack', 'attack', 'attack', 'attack', 'damage', 'downed', 'stabilized', 'save', 'move', 'action', 'turn_end', 'turn_start', 'intro', 'end', 'pick', 'spell_source', 'tactic_lead'])
  switch (kind) {
    case 'attack': {
      const input = {
        actor,
        target,
        targetIsEnemy: chance(0.5),
        payload: randomPayload(),
        reason: optionalText(['', ' с преимуществом', ' (укрытие)', ' сверху']),
        numbers: optionalText(['', '15 против КД 12', '3 против КД 18']),
        damage: optionalText(['', ', 7 урона', ', 9 урона; ОЗ 9 → 0']),
        opportunity: chance(0.15),
        lead: optionalText(['', 'Почуяв слабину, ', 'Пользуясь поддержкой стаи, ']),
      }
      return { fn: 'attack', input, event }
    }
    case 'damage': {
      const input = { target, amount: choice([int(0, 40), 7.5, 1e21]), hp: optionalText(['', '; ОЗ 9 → 2']) }
      return { fn: 'damage', input, event }
    }
    case 'downed': return { fn: 'downed', input: { target, side: choice(['hero', 'enemy', 'other', '']) }, event }
    case 'stabilized': return { fn: 'stabilized', input: { target }, event }
    case 'save': return { fn: 'save', input: { target, saved: choice([true, false, null]), source: optionalText(['', 'от заклинания', 'от заклинания «Священное пламя»']) }, event }
    case 'move': return { fn: 'move', input: { actor, feet: choice([int(0, 60), 7.5, 0.1]), tactic: optionalText(tactics), mode: optionalText(['long_jump', 'swing', 'walk', ['swing'], 5]) }, event }
    case 'action': return { fn: 'action', input: { actor, actionId: choice(actions), name: choice(['Рывок', 'Отход', 'Уклонение', 'Помощь', 'Засада', '$&', '{actor}']) }, event }
    case 'turn_end': return { fn: 'turn_end', input: { actor }, event }
    case 'turn_start': return { fn: 'turn_start', input: { actor, round: choice([int(1, 12), 2.5]) }, event }
    case 'intro': return { fn: 'intro', input: { names: Array.from({ length: int(0, 4) }, () => choice(names)), setting: choice(settings) }, event }
    case 'end': return { fn: 'end', input: { endText: choice(['противники повержены', 'враги бежали', '']) }, event }
    case 'pick': return { fn: 'pick', input: { kind: choice(['custom', 'attack-melee', 'turn-end', 'x']), variants: Array.from({ length: int(0, 4) }, () => choice(['а', 'б', 'в', '', 'г'])) }, event }
    case 'spell_source': return { fn: 'spell_source', input: { label: choice(['', '«Священное пламя»']) }, event }
    default: return { fn: 'tactic_lead', input: { tactic: optionalText(tactics) }, event }
  }
}

function run(book, call) {
  const { input, event } = call
  switch (call.fn) {
    case 'attack': return attackPhrase(book, input, event)
    case 'damage': return damagePhrase(input)
    case 'downed': return downedPhrase(book, input, event)
    case 'stabilized': return stabilizedPhrase(book, input.target, event)
    case 'save': return savePhrase(book, input, event)
    case 'move': return movePhrase(book, input, event)
    case 'action': return actionPhrase(book, input, event)
    case 'turn_end': return turnEndPhrase(book, input.actor, event)
    case 'turn_start': return turnStartPhrase(book, input.actor, input.round, event)
    case 'intro': return encounterIntroPhrase(book, input, event)
    case 'end': return encounterEndPhrase(book, input, event)
    case 'pick': return book.pick(input.kind, input.variants, event)
    case 'spell_source': return spellSourceText(input.label)
    default: return tacticLead(input.tactic)
  }
}

const scenarios = []
for (let index = 0; index < 500; index += 1) {
  // Несколько событий на сценарий и повторы одного события — так проверяется
  // сдвиг на соседнюю формулировку при совпадении с прошлым выбором.
  const events = Array.from({ length: int(1, 3) }, randomEvent)
  const book = new Phrasebook()
  const calls = Array.from({ length: int(1, 10) }, () => randomCall(events)).map((call) => {
    const out = run(book, call)
    // `undefined` в JSON не попадает: отсутствующее поле в Rust — `None`.
    return JSON.parse(JSON.stringify({ ...call, out }))
  })
  scenarios.push({ calls })
}

// Перебор оружия: каждое название × вид атаки × вид урона, цель склоняется
// надёжно — так проверяются все таблицы оружия и поиск по началу и концу.
for (const weapon of weapons) {
  const book = new Phrasebook()
  const calls = []
  for (const attack_kind of ['melee', 'ranged', 'thrown']) {
    for (const damage_type of attack_kind === 'melee' ? ['slashing', 'piercing', 'bludgeoning', 'fire'] : ['piercing']) {
      const event = { event_id: `sweep:${weapon}:${attack_kind}:${damage_type}` }
      for (const useAction of [false, true]) {
        const payload = useAction
          ? { hit: chance(0.6), attack_kind, action_name: weapon, damage_type }
          : { hit: chance(0.6), attack_kind, item_name: weapon, action_name: choice(actionNames), damage_type }
        const input = { actor: choice(heroNames), target: choice(['Волк', 'Гигантская крыса', 'Лютый волк 2', 'Скелет минотавра']), targetIsEnemy: true, payload }
        calls.push({ fn: 'attack', input, event, out: attackPhrase(book, input, event) })
      }
    }
  }
  scenarios.push({ calls: JSON.parse(JSON.stringify(calls)) })
}

/** По элементу верхних списков на строку: файл читается и сравнивается построчно. */
function compactJson(value) {
  const sections = Object.entries(value).map(([key, list]) => `${JSON.stringify(key)}: [\n${list.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
  return `{\n${sections.join(',\n')}\n}\n`
}

const fixture = { names: nameCases, hours: hourCases, join: joinCases, seeds: seedCases, scenarios }
writeFileSync(new URL('./combat-phrases.json', import.meta.url), compactJson(fixture))
const callCount = scenarios.reduce((sum, scenario) => sum + scenario.calls.length, 0)
console.log(`имён ${nameCases.length}, часов ${hourCases.length}, списков ${joinCases.length}, зёрен ${seedCases.length}, сценариев ${scenarios.length} (вызовов ${callCount})`)
