import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCENE_COMMERCE_PLAN_VERSION,
  defaultSceneShopIntent,
  normalizeSceneShopIntent,
} from '../server/scene-commerce.mjs'

test('городская сцена детерминированно запрашивает catalog-only профиль лавки', () => {
  const intent = defaultSceneShopIntent({
    location: 'Большой город Норвин',
    theme: 'городские улицы и кузницы',
  })
  assert.deepEqual(intent, {
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: 'create',
    settlement_type: 'city',
    theme: 'arms',
    budget_cp: 50_000,
    reason: 'Новая сцена является поселением, поэтому Директор запросил базовую торговую точку.',
  })
  assert.ok(Object.isFrozen(intent))
})

test('лес и подземелье не получают стационарную лавку по умолчанию', () => {
  for (const scene of [
    { location: 'Чаща у Серого ручья', theme: 'дикая местность' },
    { location: 'Подземный архив', theme: 'подземные помещения' },
    { location: 'Серая чаща', theme: 'дикая местность', arrival: 'Путь из большого города приводит героев в лес.' },
  ]) {
    assert.equal(defaultSceneShopIntent(scene).action, 'none')
  }
})

test('ограниченный замысел Директора может отключить городской магазин или вызвать странствующую лавку', () => {
  const city = { location: 'Город Норвин', theme: 'городские улицы' }
  assert.equal(normalizeSceneShopIntent({ action: 'none', reason: 'Рынок закрыт по сюжету.' }, city).action, 'none')

  const road = { location: 'Северный тракт', theme: 'дорога' }
  assert.deepEqual(normalizeSceneShopIntent({
    action: 'create', settlement_type: 'traveling', theme: 'provisions', budget_cp: 7_500,
  }, road), {
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: 'create',
    settlement_type: 'traveling',
    theme: 'provisions',
    budget_cp: 7_500,
    reason: 'В сцене не обнаружено поселение или постоянная торговая точка.',
  })
})

test('небезопасные поля и неподходящий стационарный магазин fail closed', () => {
  const road = { location: 'Северный тракт', theme: 'дорога' }
  const forged = normalizeSceneShopIntent({
    action: 'create', settlement_type: 'city', theme: 'arms', budget_cp: 500_000,
    base_price_cp: 1,
  }, road)
  assert.equal(forged.action, 'none')
  assert.equal(forged.settlement_type, 'traveling')

  const stationary = normalizeSceneShopIntent({
    action: 'create', settlement_type: 'city', theme: 'arms', budget_cp: 500_000,
  }, road)
  assert.equal(stationary.action, 'none')
  assert.equal(stationary.settlement_type, 'city')
})
