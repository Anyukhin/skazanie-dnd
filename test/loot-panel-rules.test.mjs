import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOOT_KIND_LABELS,
  LOOT_KIND_NOUNS,
  lootAftermath,
  lootCellLabel,
  lootDistanceFeet,
  lootPickKey,
  lootPickedWeight,
  lootPicksOf,
  lootPriceLabel,
  lootTakeButtonState,
  lootWeightForecast,
  vanishedLootFrom,
  withLootTakenRecord,
} from '../src/loot-panel-rules.mjs'
import { LOOT_CONTAINER_KINDS } from '../server/loot-containers.mjs'

/**
 * Исполняемый сторож чистой половины панели добычи.
 *
 * До этого файла у неё не было ни одного прогона: контракт держался обходом
 * исходника регулярками (`loot-containers-ui-contract.test.mjs`), а текст файла
 * не отличает заблокированную кнопку от работающей. Мутационная проба это и
 * показала — `disabled: true → false` у «Подойдите ближе» и у «Не ваш ход», вес
 * без количества, прогноз без уже несомого и призрак без сторожа летописи не
 * ловились ни одним тестом корпуса.
 *
 * Поэтому правила вынесены в `src/loot-panel-rules.mjs` и проверяются здесь
 * поведением: каждая ступень лестницы, её порядок, её `disabled`, прогноз
 * перегруза и разбор «кто успел раньше».
 */

/** Всё разрешено: с этого состояния кнопка нажимается. */
const READY = Object.freeze({
  canAct: true,
  busy: false,
  narrating: false,
  canInspect: true,
  distanceFeet: 0,
  reachFeet: 5,
  actionCost: null,
  overloaded: false,
  chosenCount: 1,
})

const button = (patch = {}) => lootTakeButtonState({ ...READY, ...patch })

test('каждая ступень лестницы достижима и запирает кнопку ровно там, где отказывает сервер', () => {
  // Шесть запертых состояний. `disabled` здесь — не украшение: разблокированная
  // кнопка шлёт команду, которую движок отвергнет, и стол получает отказ вместо
  // объяснения.
  const locked = [
    [{ takenBy: 'Ада' }, 'Уже забрал Ада', 'gone'],
    [{ canAct: false }, 'Не ваш ход', 'blocked'],
    [{ narrating: true }, 'Подождите', 'blocked'],
    [{ busy: true }, 'Подождите', 'blocked'],
    [{ canInspect: false }, 'Подойдите ближе', 'far'],
    [{ chosenCount: 0 }, 'Выберите, что взять', 'empty'],
    [{ overloaded: true }, 'Не унести — перегруз', 'heavy'],
    [{ actionCost: 'action', actionSpent: true }, 'Действие уже потрачено', 'spent'],
  ]
  for (const [patch, label, tone] of locked) {
    const state = button(patch)
    assert.equal(state.label, label, `состояние ${JSON.stringify(patch)} назвалось иначе`)
    assert.equal(state.tone, tone)
    assert.equal(state.disabled, true, `кнопка «${label}» обязана быть заперта`)
    assert.ok(state.title.length > 0, `у состояния «${label}» нет объяснения`)
  }

  // Два открытых. Цену обыска в экономике хода называет сервер (`action_cost`),
  // и подпись обязана предупредить о ней до нажатия.
  const inCombat = button({ actionCost: 'action' })
  assert.equal(inCombat.label, 'Взять — действие')
  assert.equal(inCombat.disabled, false)
  assert.equal(inCombat.tone, 'action')
  const outOfCombat = button()
  assert.equal(outOfCombat.label, 'Взять')
  assert.equal(outOfCombat.disabled, false)
  assert.equal(outOfCombat.tone, 'ready')
  // Вне боя обыск не стоит действия вовсе, и потраченное действие ему не
  // помеха: `action_cost` там `null`, а запирать кнопку ценой, которой нет, —
  // это выдуманное правило, которого сервер не знает.
  assert.equal(button({ actionSpent: true }).label, 'Взять')
})

test('объявленная цена хода приходит вместе с ответом «есть ли чем платить»', () => {
  // До этой ступени кнопка называла цену и молчала о том, что платить нечем:
  // герой, уже потративший действие, читал бодрое «Взять — действие», нажимал
  // и получал `ACTION_SPENT` (`assertTurn`, `server/rules-engine.mjs`).
  const spent = button({ actionCost: 'action', actionSpent: true })
  assert.equal(spent.disabled, true, 'кнопка обязана быть заперта: команда всё равно будет отвергнута')
  assert.match(spent.title, /уже потратил/u)

  // Место ступени — последнее, и это не вкус: `ACTION_SPENT` движок бросает
  // после всего, что проверил `validateLootContainerCommand`. Далёкий герой без
  // действия обязан прочитать «подойдите ближе» — ровно то, чем ему ответит
  // сервер (`LOOT_CONTAINER_OUT_OF_REACH`), а не второй запрет вместо первого.
  const far = { actionCost: 'action', actionSpent: true }
  assert.equal(button({ ...far, canInspect: false }).label, 'Подойдите ближе')
  assert.equal(button({ ...far, chosenCount: 0 }).label, 'Выберите, что взять')
  assert.equal(button({ ...far, overloaded: true }).label, 'Не унести — перегруз')
  // А «не ваш ход» стоит выше по той же причине, по какой стоял и раньше.
  assert.equal(button({ ...far, canAct: false }).label, 'Не ваш ход')
})

test('порядок ступеней повторяет порядок отказов правила', () => {
  // «Уже забрал» — верхняя ступень: опустевшая карточка проходит ту же
  // лестницу, и остальные запреты на ней уже не важны.
  assert.equal(button({ takenBy: 'Борх', canAct: false, canInspect: false, chosenCount: 0, overloaded: true }).label, 'Уже забрал Борх')
  // Право хода — раньше занятости и досягаемости.
  assert.equal(button({ canAct: false, narrating: true, canInspect: false }).label, 'Не ваш ход')
  // Досягаемость — раньше выбора и веса: игрок обязан узнать, что до тела не
  // дойти, прежде чем ему предложат поправить набор.
  assert.equal(button({ canInspect: false, chosenCount: 0, overloaded: true }).label, 'Подойдите ближе')
  // `validateLootContainerCommand` отвергает `LOOT_LINES_REQUIRED` раньше веса
  // (`CARRYING_CAPACITY_EXCEEDED`), и кнопка обязана объяснять так же. Иначе
  // уже перегруженный герой с пустым выбором читает «снимите часть выбора» —
  // тупик, из которого нечего снимать.
  const overloadedAndEmpty = button({ overloaded: true, chosenCount: 0 })
  assert.equal(overloadedAndEmpty.label, 'Выберите, что взять')
  assert.equal(overloadedAndEmpty.title.includes('снимите часть выбора'), false)
  // А как только выбор появился — вес выходит вперёд цены хода.
  assert.equal(button({ overloaded: true, actionCost: 'action' }).label, 'Не унести — перегруз')
})

test('далёкий контейнер обещает футы только тогда, когда сервер их прислал', () => {
  // `distance_feet` в проекции необязателен: сервер опускает поле, когда мерить
  // нечем. `Number(null) === 0` — число конечное, и наивная проверка на
  // `Number.isFinite` печатала «Сейчас до неё null фт.».
  for (const distanceFeet of [null, undefined]) {
    const state = button({ canInspect: false, distanceFeet })
    assert.equal(state.title, 'Обыскивают в пределах 5 футов.')
    assert.equal(state.title.includes('null'), false)
    assert.equal(state.title.includes('undefined'), false)
  }
  assert.equal(button({ canInspect: false, distanceFeet: 15 }).title, 'Обыскивают в пределах 5 футов. Сейчас до неё 15 фт.')
  // Ноль футов — такое же честное число, как пятнадцать: подпись не имеет права
  // считать его отсутствием.
  assert.equal(button({ canInspect: false, distanceFeet: 0 }).title.includes('Сейчас до неё 0 фт.'), true)
})

test('прогноз перегруза складывает выбранное с уже несомым', () => {
  const recipient = { inventoryLoad: { weight: 100, capacity: 120 } }
  const light = lootWeightForecast(recipient, 10)
  assert.equal(light.carried, 100)
  assert.equal(light.after, 110, 'уже несомое обязано входить в прогноз')
  assert.equal(light.overloaded, false)
  assert.equal(light.remaining, 10)
  assert.equal(light.known, true)

  const heavy = lootWeightForecast(recipient, 25)
  assert.equal(heavy.after, 125)
  assert.equal(heavy.overloaded, true, 'предел получателя перейдён — движок откажет по тому же неравенству')
  assert.equal(heavy.remaining, 0)

  // Ровно в предел — ещё не перегруз: у `CARRYING_CAPACITY_EXCEEDED` то же
  // строгое неравенство.
  assert.equal(lootWeightForecast(recipient, 20).overloaded, false)

  // Предел сервером не посчитан — пугать нечем, и запирать кнопку тоже нечем.
  const unknown = lootWeightForecast({}, 500)
  assert.equal(unknown.known, false)
  assert.equal(unknown.overloaded, false)
  assert.equal(lootWeightForecast(null, 1).overloaded, false)
})

test('вес выбранного считает количество, а не число строк', () => {
  const picks = [
    { item: { weight: 2.5 }, quantity: 3 },
    { item: { weight: 1 }, quantity: 1 },
  ]
  assert.equal(lootPickedWeight(picks), 8.5)
  assert.equal(lootPickedWeight([{ item: { weight: 0.05 }, quantity: 3 }]), 0.15, 'вес округляется до сотых, а не копится дробью')
  assert.equal(lootPickedWeight([]), 0)
  // Отрицательный вес в проекцию не приезжает, но и не имеет права уменьшать
  // прогноз, если приедет.
  assert.equal(lootPickedWeight([{ item: { weight: -10 }, quantity: 2 }]), 0)
})

test('выбор ограничен тем, что лежит в контейнере', () => {
  const container = {
    id: 'loot:corpse:abc',
    items: [
      { item_instance_id: 'i1', quantity: 3, weight: 1 },
      { item_instance_id: 'i2', quantity: 1, weight: 2 },
    ],
  }
  const picks = {
    [lootPickKey(container.id, 'i1')]: 99,
    [lootPickKey(container.id, 'i2')]: -4,
  }
  const picked = lootPicksOf(container, picks)
  assert.deepEqual(picked.map((pick) => pick.quantity), [3, 0], 'больше, чем есть, и меньше нуля брать нельзя')
  // Ключ содержит контейнер: очистка после удачного обыска обязана касаться
  // одной карточки, а не всех сразу.
  assert.equal(lootPicksOf(container, { [lootPickKey('loot:corpse:другой', 'i1')]: 2 })[0].quantity, 0)
  assert.deepEqual(lootPicksOf({ id: 'x' }, {}), [])
})

test('сводка после победы отличает тела от тайников и оружия пленного', () => {
  const containers = [
    { id: 'a', kind: 'corpse', item_count: 2, total_weight: 5 },
    { id: 'b', kind: 'corpse', item_count: 1, total_weight: 1.5 },
    { id: 'c', kind: 'cache', item_count: 3, total_weight: 4 },
    { id: 'd', kind: 'abandoned', item_count: 1, total_weight: 2 },
    { id: 'e', kind: 'captive', item_count: 1, total_weight: 3 },
  ]
  const aftermath = lootAftermath(containers)
  assert.equal(aftermath.bodies.length, 2, 'телом считается только `corpse`')
  assert.equal(aftermath.caches.length, 2)
  assert.equal(aftermath.captiveGear.length, 1)
  assert.equal(aftermath.itemCount, 8)
  assert.equal(aftermath.weight, 15.5)
  assert.equal(aftermath.empty, false)
  assert.equal(lootAftermath([]).empty, true)
})

test('подписи видов заведены на все виды контейнеров сервера', () => {
  for (const kind of LOOT_CONTAINER_KINDS) {
    assert.ok(LOOT_KIND_LABELS[kind], `у вида ${kind} нет подписи в панели`)
    assert.ok(LOOT_KIND_NOUNS[kind], `у вида ${kind} нет счётного слова в сводке`)
  }
})

// ---------------------------------------------------------------------------
// Призрак опустевшего контейнера

const CONTAINER = Object.freeze({ id: 'loot:corpse:abc', name: 'Тело: Разбойник 1', kind: 'corpse', x: 2, y: 1 })
const naming = (id) => (id === 'hero' ? 'Ада' : id === 'mate' ? 'Борх' : '')
const takenRecord = (patch = {}) => ({
  id: 'log-1', type: 'loot-taken', actorId: 'hero', recipientId: 'hero', containerId: CONTAINER.id, itemCount: 1, ...patch,
})

test('призрак заводится только по опустошённому контейнеру, а не по любому обыску', () => {
  // Неполный обыск пишет ту же запись летописи: взяли одну вещь из трёх, отряд
  // поднялся на другой ярус — проекция сцены опустела целиком. Призрак здесь
  // солгал бы «уже забрал Ада» о теле, на котором осталось ещё две вещи, и
  // нарисовал бы метку добычи по старым координатам на карте другого яруса.
  assert.deepEqual(
    vanishedLootFrom([CONTAINER], [], [takenRecord({ remainingCount: 2, statusAfter: 'available' })], naming),
    [],
  )

  const ghosts = vanishedLootFrom([CONTAINER], [], [takenRecord({ remainingCount: 0, statusAfter: 'emptied' })], naming, 1_000)
  assert.deepEqual(ghosts, [{
    id: CONTAINER.id, name: CONTAINER.name, kind: 'corpse', x: 2, y: 1, cell_revealed: true, takenBy: 'Ада', at: 1_000,
  }])
  // Туман переезжает вместе с клеткой: тело, которое соратник обобрал в
  // неразведанной части зала, места своего не называет и призраком.
  const [dark] = vanishedLootFrom(
    [{ ...CONTAINER, cell_revealed: false }], [],
    [takenRecord({ remainingCount: 0, statusAfter: 'emptied' })], naming,
  )
  assert.equal(dark.cell_revealed, false)
  assert.equal(lootCellLabel(dark), '')
})

test('проигравший гонку узнаёт, кто забрал, тем же кадром отказа', () => {
  // Кадр отказа приносит свежий список — контейнера в нём уже нет. Летопись при
  // этом отстаёт на один опрос комнаты, и до починки призрака заводить было не
  // по чему: свежий список переписывал «то, что было», а пришедшая через
  // секунду запись объясняла уже исчезнувшее.
  const record = takenRecord({ id: 'log-9', recipientId: 'mate', remainingCount: 0, statusAfter: 'emptied' })
  const before = []
  assert.deepEqual(vanishedLootFrom([CONTAINER], [], before, naming), [], 'без записи призрака нет — это и есть починенная дыра')

  // Сервер знает, кто забрал, и кладёт запись в тот же отказ.
  const afterRefusal = withLootTakenRecord(before, record)
  const [ghost] = vanishedLootFrom([CONTAINER], [], afterRefusal, naming, 1_000)
  assert.equal(ghost.takenBy, 'Борх')

  // Та же запись из следующего опроса комнаты не задваивается: ключ летописи
  // детерминирован.
  assert.deepEqual(withLootTakenRecord(afterRefusal, record), afterRefusal)
  assert.equal(withLootTakenRecord(afterRefusal, { ...record, id: 'log-10' }).length, 2)
  // Мусор в летопись не попадает: ни пустой отказ, ни запись другого вида.
  assert.deepEqual(withLootTakenRecord(before, null), before)
  assert.deepEqual(withLootTakenRecord(before, { id: 'x', type: 'attack', containerId: CONTAINER.id }), before)
  assert.deepEqual(withLootTakenRecord(before, { id: 'x', type: 'loot-taken' }), before)
})

test('уход со сцены не выдаётся за обыск', () => {
  // Летопись молчит — контейнер просто уехал вместе с ярусом.
  assert.deepEqual(vanishedLootFrom([CONTAINER], [], [], naming), [])
  assert.deepEqual(
    vanishedLootFrom([CONTAINER], [], [{ id: 'l', type: 'loot-container', containerId: CONTAINER.id }], naming),
    [],
  )
  // Запись о чужом контейнере тоже не считается.
  assert.deepEqual(
    vanishedLootFrom([CONTAINER], [], [takenRecord({ containerId: 'loot:corpse:другой', statusAfter: 'emptied' })], naming),
    [],
  )
  // Старая запись без признака остатка призрака не заводит: молчание честнее
  // выдуманного состояния.
  assert.deepEqual(vanishedLootFrom([CONTAINER], [], [takenRecord()], naming), [])
})

test('контейнер на месте — призрака нет; имя успевшего берётся из летописи', () => {
  assert.deepEqual(vanishedLootFrom([CONTAINER], [CONTAINER], [takenRecord({ statusAfter: 'emptied' })], naming), [])
  assert.deepEqual(vanishedLootFrom([], [], [takenRecord({ statusAfter: 'emptied' })], naming), [])

  // Получателя называют первым: добычу мог поднять один, а унести — другой.
  const [toMate] = vanishedLootFrom([CONTAINER], [], [takenRecord({ recipientId: 'mate', statusAfter: 'emptied' })], naming)
  assert.equal(toMate.takenBy, 'Борх')
  // Имя не разошлось — карточка всё равно называет отряд, а не пустую строку.
  const [unknown] = vanishedLootFrom([CONTAINER], [], [takenRecord({ actorId: 'x', recipientId: '', statusAfter: 'emptied' })], naming)
  assert.equal(unknown.takenBy, 'кто-то из отряда')
  // Свежая запись перебивает старую: последний обыск и опустошает контейнер.
  const [latest] = vanishedLootFrom([CONTAINER], [], [
    takenRecord({ id: 'log-1', recipientId: 'hero', remainingCount: 1, statusAfter: 'available' }),
    takenRecord({ id: 'log-2', recipientId: 'mate', remainingCount: 0, statusAfter: 'emptied' }),
  ], naming)
  assert.equal(latest.takenBy, 'Борх')
})

test('мелочь панели: цена монетами и клетка с единицы', () => {
  assert.equal(lootPriceLabel(0), '')
  assert.equal(lootPriceLabel(undefined), '')
  assert.equal(lootPriceLabel(2_505), '25 зм 5 мм')
  assert.equal(lootPriceLabel(156), '1 зм 5 см 6 мм')
  assert.equal(lootCellLabel({ x: 0, y: 0 }), 'клетка 1:1')
  assert.equal(lootCellLabel({ x: null, y: 3 }), '')
})

test('под туманом карточка не называет ни клетку, ни футы', () => {
  // Метка добычи на доске гаснет вместе с нераскрытой клеткой, а карточка
  // печатала «клетка 3:2 · 30 фт до героя» и для тела в неразведанном углу —
  // то есть проговаривала словами разведку, которой отряд не делал. Признак
  // приходит с сервера (`cell_revealed`), своей карты видимости у панели нет.
  const open = { x: 2, y: 1, distance_feet: 30, cell_revealed: true }
  assert.equal(lootCellLabel(open), 'клетка 3:2')
  assert.equal(lootDistanceFeet(open), 30)

  const fogged = { ...open, cell_revealed: false }
  assert.equal(lootCellLabel(fogged), '')
  assert.equal(lootDistanceFeet(fogged), null)

  // Старая проекция признака не несёт — и молчать вместо неё нельзя: карточка
  // потеряла бы клетку у тела, которое отряд видит своими глазами.
  assert.equal(lootCellLabel({ x: 2, y: 1 }), 'клетка 3:2')
  assert.equal(lootDistanceFeet({ distance_feet: 5 }), 5)
  // «Померить нечем» — по-прежнему `null`, а не ноль.
  assert.equal(lootDistanceFeet({ cell_revealed: true }), null)
  assert.equal(lootDistanceFeet({ distance_feet: 0, cell_revealed: true }), 0)
})
