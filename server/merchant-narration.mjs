import { findMerchant } from './merchant-economy.mjs'
import { NARRATOR_PRIORITY, narrationTextOr, registerDeterministicNarrator } from './deterministic-narration.mjs'

const MERCHANT_EVENT_TYPES = new Set([
  'MerchantBargainResolved',
  'MerchantItemAppraised',
  'MerchantPurchaseCompleted',
  'MerchantSaleCompleted',
  'MerchantCreated',
  'MerchantConfigured',
  'MerchantRestocked',
  'MerchantMoved',
  'MerchantAvailabilityChanged',
])

function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

const safeText = narrationTextOr

function formatCopper(value) {
  let copper = Math.max(0, safeInteger(value, 0))
  const gold = Math.floor(copper / 100)
  copper -= gold * 100
  const silver = Math.floor(copper / 10)
  copper -= silver * 10
  const parts = []
  if (gold) parts.push(`${gold} зм`)
  if (silver) parts.push(`${silver} см`)
  if (copper || !parts.length) parts.push(`${copper} мм`)
  return parts.join(' ')
}

export function hasMerchantEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => MERCHANT_EVENT_TYPES.has(String(event?.event_type ?? '')))
}

/**
 * Produces commerce narration solely from committed event payloads and the
 * committed merchant identity. Structured trades deliberately bypass a free
 * form LLM response so the voice layer cannot invent a different location,
 * item, price, roll or outcome after the mechanics have committed.
 */
export function merchantNarration(events, state) {
  const businessEvent = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((event) => MERCHANT_EVENT_TYPES.has(String(event?.event_type ?? '')))
  if (!businessEvent) return null

  const payload = businessEvent.payload && typeof businessEvent.payload === 'object'
    ? businessEvent.payload
    : {}
  const merchant = findMerchant(state, payload.merchant_id)
  const merchantName = safeText(merchant?.name ?? payload.merchant?.name, 'Торговец')

  if (businessEvent.event_type === 'MerchantCreated') {
    const location = safeText(payload.merchant?.location ?? merchant?.location, 'текущей локации', 180)
    return `${merchantName} открывает торговлю в локации «${location}». Склад и ценовая политика подтверждены сервером.`
  }
  if (businessEvent.event_type === 'MerchantConfigured') {
    return `Профиль и торговая политика «${merchantName}» обновлены сервером.`
  }
  if (businessEvent.event_type === 'MerchantRestocked') {
    const quantity = Math.max(0, safeInteger(payload.total_quantity_added, 0))
    return `Склад «${merchantName}» пополнен на ${quantity} ед. товара.`
  }
  if (businessEvent.event_type === 'MerchantMoved') {
    const location = safeText(payload.location_after ?? merchant?.location, 'новую локацию', 180)
    return `${merchantName} перемещён в локацию «${location}».`
  }
  if (businessEvent.event_type === 'MerchantAvailabilityChanged') {
    return payload.available_after === true
      ? `${merchantName} открывает торговлю.`
      : `${merchantName} временно закрывает торговлю.`
  }

  if (businessEvent.event_type === 'MerchantBargainResolved') {
    const total = safeInteger(payload.roll_total, 0)
    const difficulty = safeInteger(payload.difficulty, 15)
    return payload.success === true
      ? `${merchantName} принимает ваши доводы и меняет условия сделки. Проверка торга: ${total} против СЛ ${difficulty} — успех.`
      : `${merchantName} выслушивает вас, но не уступает в цене. Проверка торга: ${total} против СЛ ${difficulty} — неудача.`
  }

  if (businessEvent.event_type === 'MerchantItemAppraised') {
    const itemName = safeText(payload.item_name ?? payload.item_id, 'предмет')
    return `${merchantName} осматривает «${itemName}» и называет подтверждённую цену: ${formatCopper(payload.base_unit_price_cp)}.`
  }

  const itemName = safeText(payload.item?.name ?? payload.catalog_id, 'предмет')
  const quantity = Math.max(1, safeInteger(payload.quantity, 1))
  const total = formatCopper(payload.total_price_cp)
  if (businessEvent.event_type === 'MerchantPurchaseCompleted') {
    return `${merchantName} подтверждает покупку: ${itemName} × ${quantity}. Списано ${total}.`
  }
  return `${merchantName} принимает товар: ${itemName} × ${quantity}. Получено ${total}.`
}

export const merchantNarrator = registerDeterministicNarrator({
  id: 'merchant',
  priority: NARRATOR_PRIORITY.merchant,
  promptVersion: 'merchant-narrator/v1',
  provider: 'deterministic-merchant',
  matches: hasMerchantEvent,
  narrate: merchantNarration,
})
