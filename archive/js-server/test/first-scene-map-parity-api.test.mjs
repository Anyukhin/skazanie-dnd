// Первая сцена кампании одинакова в Rust и JS.
//
// Карта первой сцены рождается при создании кампании и лежит в seed-снимке, а
// не в событиях: сверка журнала событий её не видит, а сценарии контракта
// проверяют поведение, а не расстановку. Перенос #184 (обстановка карт:
// гарнитур стульев, мебель спиной к стене, версии building-with-yard 8,
// settlement-layout 7, graph-layout 3) отстал, и все контрактные тесты
// оставались зелёными, хотя у Rust стояли другие предметы: сборщик встречи
// видел другие занятые клетки, крыса появлялась в другом месте, и стенд
// горячего пути расходился на десятки событий (`rust/crates/sk-server/bench/hot-path.mjs`).
//
// Против Rust тест поднимает рядом эталонный JS-сервер, создаёт на обоих одни
// и те же кампании мастером без модели и сравнивает сцену, карты мест и
// позиции героев. Против JS эталон — второй JS-процесс: так тест проверяет
// себя и то, что создание кампании не зависит от процесса.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaign, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'

const FANTASY = 'Классическое фэнтези'
/**
 * По месту на каждый генератор первой сцены: поселение (`settlement-layout`),
 * дом с двором (`building-with-yard`: таверна, усадьба), раскладка графа
 * (`graph-layout`: храм, склеп), темы леса и пещеры; пустой мастер — место из
 * зерна вдохновения; авторские миры — нарисованные стартовые карты.
 */
const CASES = Object.freeze([
  { code: 'MAPPAR-TOWN', bootstrap: { world: { preset: FANTASY } } },
  { code: 'MAPPAR-EMPTY', bootstrap: { world: {} } },
  { code: 'MAPPAR-TAVERN', bootstrap: { world: { preset: FANTASY, startingLocation: 'Таверна «Пьяный гусь»' } } },
  { code: 'MAPPAR-MANOR', bootstrap: { world: { preset: FANTASY, startingLocation: 'Усадьба купца' } } },
  { code: 'MAPPAR-TEMPLE', bootstrap: { world: { preset: FANTASY, startingLocation: 'Храм Рассвета' } } },
  { code: 'MAPPAR-CRYPT', bootstrap: { world: { preset: FANTASY, startingLocation: 'Фамильный склеп' } } },
  { code: 'MAPPAR-FOREST', bootstrap: { world: { preset: FANTASY, startingLocation: 'Лесная поляна' } } },
  { code: 'MAPPAR-CAVE', bootstrap: { world: { preset: FANTASY, startingLocation: 'Пещера у водопада' } } },
  { code: 'MAPPAR-TIDES', bootstrap: { worldTemplateId: 'league-nine-tides' } },
  { code: 'MAPPAR-STAR', bootstrap: { worldTemplateId: 'unfading-star-belt' } },
  { code: 'MAPPAR-GARDEN', bootstrap: { worldTemplateId: 'ashen-garden-bowl' } },
  { code: 'MAPPAR-ASTOHAN', bootstrap: { worldTemplateId: 'astohan-plains' } },
])

/** Что сравнивается: геометрия и обстановка сцены, память карт, позиции героев. */
function sceneFingerprint(state) {
  return {
    scene: state.scene,
    locationMaps: state.locationMaps ?? null,
    heroes: (state.players ?? []).map((hero) => ({ id: hero.id, x: hero.x, y: hero.y })),
    positions: state.mechanics?.positions ?? null,
  }
}

/** Первое расхождение — путь и обе стороны, чтобы отказ был читаемым. */
function firstDifference(expected, actual, path = '') {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return null
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const found = firstDifference(expected[key], actual[key], `${path}.${key}`)
      if (found) return found
    }
  }
  return `${path || '.'}: JS ${JSON.stringify(expected)?.slice(0, 300)} — сервер ${JSON.stringify(actual)?.slice(0, 300)}`
}

// Зерно вдохновения свободного мира (`campaign-inspiration`) тянется
// серверными костями: без закреплённых костей деталь мира, а с ней обещания
// карты (`map_requirements`), у двух процессов разные.
const DICE = { format: 'skazanie.test-dice/1', description: 'все кости — минимум', rules: [{ value: 'min' }] }

async function createAll(server) {
  const { client } = await setupAdmin(server)
  const result = new Map()
  for (const { code, bootstrap } of CASES) {
    await createCampaign(client, { code, name: 'Сверка карты', bootstrap: { slotCount: 2, startLevel: 1, rulesetId: 'dnd_5e_2014', ...bootstrap } })
    result.set(code, sceneFingerprint((await readJournal(server, code)).state))
  }
  return result
}

test('первая сцена кампании совпадает с эталоном JS: карта, обстановка, позиции', async (t) => {
  const server = await startTestServer(t, { dice: DICE, storagePrefix: 'skazanie-first-scene-' })
  const reference = await startTestServer(t, { impl: 'js', dice: DICE, storagePrefix: 'skazanie-first-scene-ref-' })
  const actual = await createAll(server)
  const expected = await createAll(reference)
  const differences = []
  for (const { code } of CASES) {
    const want = expected.get(code)
    assert.ok(want?.scene?.map?.generator, `${code}: у эталонной сцены нет карты с генератором`)
    const found = firstDifference(want, actual.get(code))
    if (found) differences.push(`${code} (${want.scene.map.generator.id} ${want.scene.map.generator.version}) ${found}`)
  }
  assert.deepEqual(differences, [], 'первая сцена расходится с JS')
})
