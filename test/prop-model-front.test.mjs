import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

/**
 * Поправка лица моделей (`PROP_MODEL_FRONT_TURNS`, обзор генератора карт
 * 2026-10-10). Генератор ставит настенную вещь спиной к стене, поворот 0° —
 * лицом на юг, и модель обязана смотреть в +Z. Таблица доворачивает модели,
 * собранные лицом в −Z или полотном вдоль X, и относится к конкретному yaw
 * манифеста: пересборка пакета с исправленным yaw обязана убрать запись, иначе
 * модель развернётся дважды.
 */

const { modules: [catalog, detail] } = await compileClientModules(['src/prop-model-catalog.ts', 'src/detail-props.ts'])
const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const style = readJson('public/assets/styles/stylized/manifest.json')
const environment = readJson('public/assets/models/environment/manifest.json')
const styleEntries = new Map(Object.values(style.props).flat().map((entry) => [entry.key, entry]))
const environmentEntries = new Map(environment.models.map((entry) => [entry.key, entry]))

test('каждая поправка лица указывает на модель текущих манифестов с тем же yaw', () => {
  const fixes = Object.entries(catalog.PROP_MODEL_FRONT_TURNS)
  assert.ok(fixes.length >= 20)
  for (const [key, { turn, baseYaw }] of fixes) {
    assert.ok([90, 180, 270].includes(turn), `${key}: доворот не четверть оборота`)
    if (key.startsWith('detail-v1-')) {
      // Набор детализации — запасной путь без пакета стиля, yaw у него всегда 0.
      assert.ok(detail.DETAIL_PROP_MODELS.has(key.slice('detail-v1-'.length)), `${key}: нет модели в наборе детализации`)
      assert.equal(baseYaw, 0, key)
      continue
    }
    const entry = styleEntries.get(key) ?? environmentEntries.get(key)
    assert.ok(entry, `${key}: модели нет ни в пакете стиля, ни в выпуске окружения`)
    assert.equal(entry.yaw, baseYaw, `${key}: yaw манифеста сменился — поправку пора перенести в источник и убрать отсюда`)
  }
})

test('поправка доворачивает yaw, а четверть оборота меняет ширину и глубину местами', () => {
  const stove = catalog.frontFacingEntry({ key: 'style-detail-kitchen-stove', yaw: 0, size: [2.6, 1.1, 1.1] })
  assert.equal(stove.yaw, 180)
  assert.deepEqual(stove.size, [2.6, 1.1, 1.1], 'пол-оборота bbox не меняет')
  const banner = catalog.frontFacingEntry({ key: 'style-kenney-town-banner-red', yaw: 0, size: [0.05, 0.84, 0.5] })
  assert.equal(banner.yaw, 90)
  assert.deepEqual(banner.size, [0.5, 0.84, 0.05], 'знамя после доворота — полотно вдоль стены')
  const chair = { key: 'ref-quaternius-chair-1', yaw: 0, size: [0.5, 0.9, 0.5] }
  assert.equal(catalog.frontFacingEntry(chair), chair, 'модель без поправки не копируется')
  assert.equal(catalog.propModelFrontTurn('ref-quaternius-chair-1'), 0)
  assert.equal(catalog.propModelFrontTurn('kd-stairs'), 180, 'лестница поднимается к стене, а не от неё')
})
