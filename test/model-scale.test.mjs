import assert from 'node:assert/strict'
import test from 'node:test'

import * as THREE from 'three'
import { actorAppearanceFor, actorStatureFor } from '../server/actor-appearance.mjs'
import { compileClientModules } from './kit/client-ts.mjs'

/**
 * Замер масштаба 2026-10-09 (`tools/model-scale-audit.mjs`): полурослик стоял
 * ростом с человека, крыса — с волка, великан 3×3 был лишь вдвое выше героя;
 * стул на карте выходил 1,8 фт при столе в 3 фт, свеча — выше колена.
 */

const { modules: [models, props, render, catalog] } = await compileClientModules(['src/actor-models.ts', 'src/board3d-props.ts', 'src/board-render.ts', 'src/prop-model-catalog.ts'])
const HUMAN = 1.3

test('рост фигурки идёт по категории размера: маленький ниже человека, огромный заметно выше большого', () => {
  const medium = models.figureHeightFor(HUMAN, 'warrior', 1)
  const small = models.figureHeightFor(HUMAN, 'warrior', 1, 'small')
  const tiny = models.figureHeightFor(HUMAN, 'warrior', 1, 'tiny')
  const large = models.figureHeightFor(HUMAN, 'warrior', 2)
  const huge = models.figureHeightFor(HUMAN, 'warrior', 3)
  const gargantuan = models.figureHeightFor(HUMAN, 'warrior', 4)
  assert.equal(medium, HUMAN, 'средний рост без stature не меняется')
  assert.ok(tiny < small && small < medium && medium < large && large < huge && huge < gargantuan)
  assert.ok(small / medium > .55 && small / medium < .75, 'полурослик — около двух третей человека')
  assert.ok(huge / medium >= 2.2, 'великан 3×3 — больше чем вдвое выше героя')
  // Площадь главнее: фигурка 2×2 большая, даже если stature не пришёл.
  assert.equal(models.figureHeightFor(HUMAN, 'warrior', 2, 'small'), large)
  // Большое существо, чья площадь раскрыта не целиком, остаётся ростом профиля.
  assert.equal(models.figureHeightFor(HUMAN, 'warrior', 1, 'large'), medium)
})

test('высота профиля — рост его собственного размера: гоблин мал, дракон велик', () => {
  assert.equal(models.figureHeightFor(.95, 'goblin', 1, 'small'), .95)
  assert.equal(models.figureHeightFor(.95, 'goblin', 1), .95)
  assert.equal(models.figureHeightFor(2.4, 'dragon', 2), 2.4, 'дракон 2×2 — рост из манифеста')
  assert.ok(models.figureHeightFor(2.4, 'dragon', 1, 'medium') < 2.4, 'дракончик на клетке ниже большого дракона')
  assert.ok(models.figureHeightFor(2.4, 'dragon', 3) > 2.4)
})

test('сервер выводит категорию размера из стат-блока и расы героя, средний рост не пишет', () => {
  assert.equal(actorStatureFor('hero', { species: 'Легконогий полурослик' }), 'small')
  assert.equal(actorStatureFor('hero', { species: 'Лесной гном' }), 'small')
  assert.equal(actorStatureFor('hero', { species: 'Холмовой дварф' }), null, 'дварф — средний')
  assert.equal(actorStatureFor('enemy', { size: 'tiny' }), 'tiny')
  assert.equal(actorStatureFor('enemy', { size: 'Huge' }), 'huge')
  assert.equal(actorStatureFor('enemy', { species: 'полурослик' }), null, 'у врага раса не читается — только стат-блок')
  assert.equal(actorAppearanceFor('hero', { species: 'Коренастый полурослик', characterClass: 'Плут' }).stature, 'small')
  assert.equal('stature' in actorAppearanceFor('hero', { species: 'Человек', characterClass: 'Воин' }), false)
  assert.equal('stature' in actorAppearanceFor('enemy', { name: 'Разбойник', size: 'medium' }), false)
  // Размер виден всем, как и сама фигурка: замаскированный враг его не теряет.
  const masked = actorAppearanceFor('enemy', { name: 'Неизвестный', size: 'large', masked: true })
  assert.equal(masked.profile, 'warrior')
  assert.equal(masked.stature, 'large')
})

function heightFeet(assetId, scale, footprint = [{ x: 4, y: 4 }]) {
  const models3d = props.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, null)
  const group = models3d.create({ id: `probe-${assetId}`, assetId, x: footprint[0].x + .5, y: footprint[0].y + .5, rotation: 0, scale, footprint, zOrder: 0 })
  group.updateMatrixWorld(true)
  const cells = new THREE.Box3().setFromObject(group).max.y
  models3d.dispose()
  return cells / (HUMAN / 5.75)
}

test('стул и табурет держат рост при уменьшенном масштабе, свеча и прилавок соразмерны человеку', () => {
  for (const scale of [.42, .5, 1]) {
    const chair = heightFeet('chair', scale)
    assert.ok(chair > 2.8 && chair < 3.6, `стул при масштабе ${scale}: ${chair.toFixed(1)} фт`)
  }
  for (const scale of [.33, .42]) {
    const stool = heightFeet('stool', scale)
    assert.ok(stool > 1.6 && stool < 2.4, `табурет при масштабе ${scale}: ${stool.toFixed(1)} фт`)
  }
  const table = heightFeet('table_long', .95, [{ x: 4, y: 4 }, { x: 5, y: 4 }])
  assert.ok(heightFeet('chair', .46) > table, 'спинка стула выше столешницы')
  assert.ok(heightFeet('candle', 1) < 1.5, 'свеча в подсвечнике ниже полутора футов')
  const stall = heightFeet('market_stall', 1, [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 }])
  assert.ok(stall > 6.5, `навес прилавка выше головы: ${stall.toFixed(1)} фт`)
})

test('GLB стула при масштабе генератора держит рост, но не выходит за свою клетку', () => {
  // Стул каталога: 0.5 × 1 × 0.5 клетки до вписывания, след 1×1, масштаб 0.46.
  const size = [.5, 1, .5]
  const fit = catalog.propModelFit('chair', null, 1, 1, render.PROP_FOOTPRINT_FILL, size)
  const raised = catalog.propModelFloorFit('chair', fit, size, .46, 1, 1)
  assert.ok(size[1] * fit * .46 < .68, 'без предела стул ниже нормы')
  assert.ok(Math.abs(size[1] * raised * .46 - .68) < 1e-9, 'с пределом — 3 фт')
  assert.ok(size[0] * raised * .46 <= 1, 'ширина в пределах клетки')
  // Широкая модель упирается в клетку раньше, чем в рост.
  const wide = [1.2, .9, 1.2]
  const wideFit = catalog.propModelFloorFit('chair', .3, wide, .46, 1, 1)
  assert.ok(wide[0] * wideFit * .46 <= 1 + 1e-9)
  // Виду без предела вписывание не меняется.
  assert.equal(catalog.propModelFloorFit('table_long', .5, [2, .8, 1], .95, 2, 1), .5)
})
