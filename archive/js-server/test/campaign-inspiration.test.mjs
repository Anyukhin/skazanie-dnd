// Зерно вдохновения: разные кампании при пустом мастере.
//
// Живой отзыв владельца: несколько кампаний подряд с пустыми полями выходили
// похожими — посёлок, тайна, странное событие. Причина не в модели, а в
// задании: при пустом мастере она каждый раз получала один и тот же текст.
//
// Главное утверждение сторожа не «зерно существует», а «заполненное владельцем
// важнее зерна»: подмешивать ориентир туда, где человек уже написал своё, было
// бы хуже прежнего однообразия.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import {
  INSPIRATION_DETAILS,
  INSPIRATION_GENRE_LEANS,
  INSPIRATION_HOOKS,
  INSPIRATION_REGIONS,
  drawCampaignInspiration,
  inspirationPromptSeed,
} from '../server/campaign-inspiration.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `inspiration-roll-${++id}`,
    now: () => '2026-08-03T12:00:00.000Z',
  })
}

const heroes = [{ id: 'hero-1', character: 'Мира', characterSetupRequired: false }]

test('пулы достаточно велики и содержательны', () => {
  for (const [name, pool] of [
    ['жанровые уклоны', INSPIRATION_GENRE_LEANS],
    ['регионы', INSPIRATION_REGIONS],
    ['завязки', INSPIRATION_HOOKS],
    ['детали мира', INSPIRATION_DETAILS],
  ]) {
    assert.ok(pool.length >= 10, `${name}: нужно не меньше десяти позиций, есть ${pool.length}`)
    const keys = pool.map((entry) => (typeof entry === 'string' ? entry : entry.label))
    assert.equal(new Set(keys).size, keys.length, `${name}: позиции повторяются`)
    for (const key of keys) assert.ok(key.length > 12, `${name}: слишком короткая позиция «${key}»`)
  }
  // У региона есть подсказка для карты, иначе разные миры начинались бы на
  // одинаковой сетке.
  for (const region of INSPIRATION_REGIONS) {
    assert.ok(['streets', 'rooms', 'open'].includes(region.layout), region.label)
    assert.ok(region.water >= 0 && region.water <= 1, region.label)
    assert.ok(region.theme.length > 3, region.label)
  }
})

test('зерно подмешивается только в пустые поля мастера', () => {
  const empty = drawCampaignInspiration({ world: {}, diceService: dice([3, 5, 7, 9]) })
  assert.equal(empty.applied, true)
  assert.ok(empty.genreLean && empty.region && empty.hook && empty.detail)

  // Владелец описал место — регион из зерна молчит, остальное подмешивается.
  const withPlace = drawCampaignInspiration({ world: { startingLocation: 'Портовый город Тир' }, diceService: dice([3, 7, 9]) })
  assert.equal(withPlace.region, null, 'указанное владельцем место не переписывается')
  assert.ok(withPlace.genreLean && withPlace.hook)

  // Описан жанр — молчит жанровый уклон.
  assert.equal(drawCampaignInspiration({ world: { genre: 'нуар' }, diceService: dice([3, 7, 9]) }).genreLean, null)
  assert.equal(drawCampaignInspiration({ world: { preset: 'киберпанк' }, diceService: dice([3, 7, 9]) }).genreLean, null)

  // Описана завязка — молчит завязка.
  assert.equal(drawCampaignInspiration({ world: { premise: 'Король умер' }, diceService: dice([3, 7, 9]) }).hook, null)
  assert.equal(drawCampaignInspiration({ world: { openingSituation: 'Отряд на суде' }, diceService: dice([3, 7, 9]) }).hook, null)

  // Мастер заполнен целиком — зерна нет вовсе, и в промпт ничего не уедет.
  const full = drawCampaignInspiration({
    world: { genre: 'нуар', startingLocation: 'Тир', premise: 'Король умер' },
    diceService: dice([1]),
  })
  assert.equal(full.applied, false)
  assert.equal(inspirationPromptSeed(full), null)
})

test('разные броски дают разные зёрна, одинаковые — одинаковые', () => {
  const first = drawCampaignInspiration({ world: {}, diceService: dice([1, 1, 1, 1]) })
  const second = drawCampaignInspiration({ world: {}, diceService: dice([2, 2, 2, 2]) })
  const repeat = drawCampaignInspiration({ world: {}, diceService: dice([1, 1, 1, 1]) })

  assert.notDeepEqual(
    [first.genreLean, first.region.label, first.hook, first.detail],
    [second.genreLean, second.region.label, second.hook, second.detail],
    'другой бросок обязан дать другое зерно',
  )
  assert.deepEqual(first, repeat, 'тот же бросок обязан дать то же зерно')
})

test('зерно уезжает в задание модели с оговоркой о приоритете владельца', () => {
  const seed = inspirationPromptSeed(drawCampaignInspiration({ world: {}, diceService: dice([4, 6, 8, 10]) }))
  assert.ok(seed)
  assert.match(seed.note, /важнее|не переписыва/u, 'оговорка о приоритете обязана быть в задании')
  assert.deepEqual(Object.keys(seed).sort(), ['genre_lean', 'hook_nature', 'note', 'region', 'world_detail'])

  // Указанное владельцем в блок не попадает вовсе.
  const partial = inspirationPromptSeed(drawCampaignInspiration({
    world: { startingLocation: 'Тир' }, diceService: dice([4, 8, 10]),
  }))
  assert.equal('region' in partial, false)
})

test('детерминированный fallback выдаёт разные миры на разных бросках', async () => {
  const create = async (values, code) => {
    const bootstrapper = new CampaignBootstrapper({ diceService: dice(values) })
    return bootstrapper.create({
      code, name: 'Новая кампания', partyName: 'Новый отряд', world: {}, players: heroes,
    })
  }

  const first = await create([1, 1, 1, 1], 'SEED-AAA')
  const second = await create([6, 6, 6, 6], 'SEED-BBB')
  const third = await create([12, 12, 12, 12], 'SEED-CCC')

  const locations = [first, second, third].map((state) => state.scene.location)
  assert.equal(new Set(locations).size, 3, `три броска — три разных места: ${locations.join(' | ')}`)

  // Место начинается с заглавной: ярлык пула — ориентир, а не готовое название.
  for (const location of locations) assert.match(location, /^[А-ЯЁ]/u, location)

  // Планировка карты идёт за регионом: разные зёрна дают разную стартовую
  // сетку, а не одну на все миры. Сравниваем сами клетки — темы и планировки в
  // состоянии не сохраняются, их потребляет генератор.
  const grids = [first, second, third].map((state) => JSON.stringify(
    state.scene.cells.map((cell) => `${cell.x},${cell.y},${cell.type}`),
  ))
  assert.ok(new Set(grids).size > 1, 'стартовая карта обязана меняться вместе с зерном')

  // И источник этой разницы: у выпавших регионов разные планировки, а раньше
  // при пустом мастере планировка была одна на все автоматические миры.
  // Второй бросок — это регион: подставляем три разных и смотрим планировку.
  const drawnLayouts = [[1, 1, 1, 1], [1, 2, 1, 1], [1, 3, 1, 1]]
    .map((values) => drawCampaignInspiration({ world: {}, diceService: dice(values) }).region.layout)
  assert.ok(new Set(drawnLayouts).size > 1, `планировка обязана следовать за регионом: ${drawnLayouts.join(' | ')}`)

  // Прежний единственный мир больше не единственный ответ.
  assert.equal(locations.includes('Поселение у Разломанной трассы'), false)

  // Завязка тоже разная, а не «привычный порядок нарушает событие» трижды.
  const summaries = [first, second, third].map((state) => state.campaignConcept.worldSummary)
  assert.equal(new Set(summaries).size, 3)
})

test('заполненный мастер сильнее зерна и в fallback', async () => {
  const bootstrapper = new CampaignBootstrapper({ diceService: dice([2, 2, 2, 2]) })
  const state = await bootstrapper.create({
    code: 'SEED-OWNER',
    name: 'Новая кампания',
    partyName: 'Новый отряд',
    world: { startingLocation: 'Портовый город Тир', genre: 'нуар', premise: 'Пропал начальник порта' },
    players: heroes,
  })
  assert.equal(state.scene.location, 'Портовый город Тир')
  assert.match(state.campaignConcept.worldSummary, /нуар/u)
  assert.match(state.scene.mood.length ? state.campaignConcept.worldSummary : '', /Пропал начальник порта/u)
})
