import assert from 'node:assert/strict'
import test from 'node:test'

import { hasMerchantEvent, merchantNarration } from '../server/merchant-narration.mjs'

const state = {
  merchants: [{ id: 'marten', name: 'Мартен', location: 'Рыночная площадь' }],
}

test('merchant narration uses only committed bargain facts', () => {
  const events = [{
    event_type: 'MerchantBargainResolved',
    payload: { merchant_id: 'marten', success: false, roll_total: 12, difficulty: 15 },
  }]
  assert.equal(hasMerchantEvent(events), true)
  assert.equal(
    merchantNarration(events, state),
    'Мартен выслушивает вас, но не уступает в цене. Проверка торга: 12 против СЛ 15 — неудача.',
  )
})

test('merchant narration derives item, quantity and exact total from committed purchase', () => {
  const events = [{
    event_type: 'MerchantPurchaseCompleted',
    payload: {
      merchant_id: 'marten', quantity: 3, total_price_cp: 5_511,
      item: { name: 'Зелье лечения' },
    },
  }]
  const narration = merchantNarration(events, state)
  assert.equal(narration, 'Мартен подтверждает покупку: Зелье лечения × 3. Списано 55 зм 1 см 1 мм.')
  assert.doesNotMatch(narration, /другая локация|секрет|повозка/iu)
})

test('non-commerce events do not produce merchant narration', () => {
  assert.equal(hasMerchantEvent([{ event_type: 'ActorMoved' }]), false)
  assert.equal(merchantNarration([{ event_type: 'ActorMoved' }], state), null)
})

test('merchant lifecycle narration is deterministic and names only committed location and stock delta', () => {
  const created = merchantNarration([{
    event_type: 'MerchantCreated',
    payload: { merchant_id: 'marten', merchant: { name: 'Мартен', location: 'Рыночная площадь' } },
  }], state)
  assert.equal(created, 'Мартен открывает торговлю в локации «Рыночная площадь». Склад и ценовая политика подтверждены сервером.')

  const restocked = merchantNarration([{
    event_type: 'MerchantRestocked', payload: { merchant_id: 'marten', total_quantity_added: 7 },
  }], state)
  assert.equal(restocked, 'Склад «Мартен» пополнен на 7 ед. товара.')
})
