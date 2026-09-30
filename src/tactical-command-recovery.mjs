const PENDING_SCHEMA_VERSION = 1
const MAX_CAMPAIGN_ID_LENGTH = 120
const MAX_REQUEST_ID_LENGTH = 200
const MAX_MESSAGE_LENGTH = 2_000
const MAX_STORAGE_VALUE_LENGTH = 64 * 1024

function text(value, max) {
  const result = String(value ?? '').trim()
  return result.length <= max ? result : result.slice(0, max)
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

/**
 * Команда, чей HTTP-ответ неизвестен. Она не содержит состояние комнаты:
 * повтор должен отправить ровно тот же command и idempotency_key, даже если
 * между попытками пришёл более свежий снимок комнаты.
 */
export function tacticalCommandRequest(pending) {
  const campaignId = text(pending?.campaignId, MAX_CAMPAIGN_ID_LENGTH)
  const requestId = text(pending?.requestId, MAX_REQUEST_ID_LENGTH)
  const body = pending?.kind === 'rest'
    ? {
        command: clone(pending?.command ?? {}),
        message: text(pending?.message, MAX_MESSAGE_LENGTH),
      }
    : {
        command: clone(pending?.command ?? {}),
        idempotency_key: requestId,
        message: text(pending?.message, MAX_MESSAGE_LENGTH),
        ...(pending?.manualRoll === true ? { manual_roll: true } : {}),
        ...(pending?.rollId ? { roll: { roll_id: text(pending.rollId, MAX_REQUEST_ID_LENGTH) } } : {}),
      }
  return {
    path: `/api/campaigns/${encodeURIComponent(campaignId)}/commands`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(pending?.kind === 'rest' ? { 'X-Idempotency-Key': requestId } : {}),
      },
      body: JSON.stringify(body),
    },
    body,
  }
}

/**
 * Ошибка без HTTP-статуса не доказывает, что сервер не применил команду:
 * fetch мог оборваться после commit. Ответ 5xx тоже оставляем неизвестным:
 * обработчик мог записать commit и упасть на проекции. Только 4xx является
 * авторитетным отказом, который можно убрать из pending.
 */
export function isTacticalCommandUnknown(error) {
  if (!error || typeof error !== 'object') return true
  const status = error.status
  const numericStatus = Number(status)
  if (!Number.isFinite(numericStatus) || numericStatus <= 0) return true
  return numericStatus < 400 || numericStatus >= 500
}

export function pendingTacticalCommandStorageKey(accountId, campaignId) {
  const account = text(accountId, MAX_REQUEST_ID_LENGTH)
  const campaign = text(campaignId, MAX_CAMPAIGN_ID_LENGTH)
  if (!account || !campaign) return null
  return `skazanie-pending-tactical-command-v${PENDING_SCHEMA_VERSION}:${encodeURIComponent(account)}:${encodeURIComponent(campaign)}`
}

function validPending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const campaignId = text(value.campaignId, MAX_CAMPAIGN_ID_LENGTH)
  const requestId = text(value.requestId, MAX_REQUEST_ID_LENGTH)
  const message = text(value.message, MAX_MESSAGE_LENGTH)
  if (!campaignId || !requestId || !message || !value.command || typeof value.command !== 'object' || Array.isArray(value.command)) return null
  if (!text(value.command.command_type, 120)) return null
  return {
    campaignId,
    requestId,
    kind: value.kind === 'rest' ? 'rest' : 'tactical',
    command: clone(value.command),
    message,
    manualRoll: value.manualRoll === true,
    ...(typeof value.rollId === 'string' && text(value.rollId, MAX_REQUEST_ID_LENGTH) ? { rollId: text(value.rollId, MAX_REQUEST_ID_LENGTH) } : {}),
  }
}

export function parsePendingTacticalCommand(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_STORAGE_VALUE_LENGTH) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.schema_version !== PENDING_SCHEMA_VERSION) return null
    return validPending(parsed.pending)
  } catch {
    return null
  }
}

export function readPendingTacticalCommand(storage, key) {
  if (!storage || !key) return null
  try { return parsePendingTacticalCommand(storage.getItem(key)) } catch { return null }
}

export function writePendingTacticalCommand(storage, key, pending) {
  if (!storage || !key) return
  const value = validPending(pending)
  if (!value) return
  try { storage.setItem(key, JSON.stringify({ schema_version: PENDING_SCHEMA_VERSION, pending: value })) } catch { /* sessionStorage may be disabled */ }
}

export function clearPendingTacticalCommand(storage, key) {
  if (!storage || !key) return
  try { storage.removeItem(key) } catch { /* sessionStorage may be disabled */ }
}

export function tacticalCommandView(pending) {
  const value = validPending(pending)
  return value ? { campaignId: value.campaignId, message: value.message, kind: value.kind } : null
}
