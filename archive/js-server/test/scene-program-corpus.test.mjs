import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { SETTLEMENT_MIN_SIZE, auditTacticalMap, programReport } from '../server/map-quality.mjs'
import { requiredProgramKinds, sceneMapRequirementsFor } from '../server/scene-requirements.mjs'
import { resolveSceneTheme } from '../server/scene-themes.mjs'
import { SIZE_CLASSES } from '../server/tactical-map.mjs'

/**
 * Корпус программ сцен — этап 6 `docs/map-generation-plan.md`. Двадцать мест,
 * как их описывают создатель кампании и картограф: деревня с навесом, таверна,
 * переправа, храм, лагерь, рынок, ворота, причал, кладбище, руины, кузница,
 * усадьба, хутор, склеп, пещера… Проверяются свойства, а не пиксели: что
 * обещал текст, то стоит на карте и досягаемо, общая проверка чиста, размер в
 * пределах. Новый живой случай «текст обещал — карта не держит» — новой
 * строкой корпуса.
 */
const corpus = JSON.parse(readFileSync(new URL('./fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))

test('корпус: двадцать разных мест', () => {
  assert.equal(corpus.scenes.length, 20)
  assert.equal(new Set(corpus.scenes.map((scene) => scene.id)).size, 20)
})

for (const scene of corpus.scenes) {
  test(`корпус «${scene.id}»: обещанное стоит на карте и досягаемо`, () => {
    const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
    assert.ok(program, 'текст что-то обещает')
    const ids = program.items.map((item) => item.id)
    for (const id of scene.expect.items) assert.ok(ids.includes(id), `разбор текста видит «${id}»`)
    if (scene.expect.focus) assert.equal(program.focus, scene.expect.focus)

    const geometry = generateSceneGeometry({
      location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '',
      seed: `corpus:${scene.id}`, useLibrary: false, requirements: program.items, program,
    })
    const { map } = geometry
    assert.equal(geometry.missing, undefined, `обязательное (${requiredProgramKinds(program).join(', ')}) воплощено`)
    const settlement = resolveSceneTheme({ location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '' }).kind === 'settlement'
    const report = programReport(map, program, { minSize: settlement ? SETTLEMENT_MIN_SIZE : null, openScene: settlement })
    assert.deepEqual(report.problems, [], 'проверка по программе')
    assert.deepEqual(report.warnings, [], 'и без предупреждений: всё обещанное на месте, на краю карты ничего')
    assert.deepEqual(auditTacticalMap(map).problems, [], 'общая проверка карты')
    assert.ok(map.width >= 16 && map.height >= 16, 'не меньше нижней границы 16×16')
    assert.ok(map.width <= SIZE_CLASSES.area.maxWidth && map.height <= SIZE_CLASSES.area.maxHeight, 'не больше класса области')
  })
}
