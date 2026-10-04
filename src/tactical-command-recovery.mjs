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
 * авторитетным отказом, который можно убрать из pending. Тем же правилом
 * решают свободное действие (`/api/narrate`) и продолжение истории.
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

// Конверт хранения общий для всех видов незавершённых запросов: различается
// только проверка содержимого, а схема, предел размера и обработка недоступного
// sessionStorage — одни и те же.
function parsePending(raw, validate) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_STORAGE_VALUE_LENGTH) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.schema_version !== PENDING_SCHEMA_VERSION) return null
    return validate(parsed.pending)
  } catch {
    return null
  }
}

function readPending(storage, key, validate) {
  if (!storage || !key) return null
  try { return parsePending(storage.getItem(key), validate) } catch { return null }
}

function writePending(storage, key, value) {
  if (!storage || !key || !value) return
  try { storage.setItem(key, JSON.stringify({ schema_version: PENDING_SCHEMA_VERSION, pending: value })) } catch { /* sessionStorage may be disabled */ }
}

export function parsePendingTacticalCommand(raw) {
  return parsePending(raw, validPending)
}

export function readPendingTacticalCommand(storage, key) {
  return readPending(storage, key, validPending)
}

export function writePendingTacticalCommand(storage, key, pending) {
  writePending(storage, key, validPending(pending))
}

export function clearPendingTacticalCommand(storage, key) {
  if (!storage || !key) return
  try { storage.removeItem(key) } catch { /* sessionStorage may be disabled */ }
}

export function tacticalCommandView(pending) {
  const value = validPending(pending)
  return value ? { campaignId: value.campaignId, message: value.message, kind: value.kind } : null
}

/*
 * Свободное действие `/api/narrate` с неизвестным исходом (аудит PR #131, REC-01).
 *
 * Принцип тот же, что у тактической команды выше: ключ запоминается до
 * отправки и снимается только известным исходом, а неизвестный исход решает
 * тот же `isTacticalCommandUnknown`. Раньше ключ рождался внутри
 * `narrateWithAgent` на каждый вызов: сервер записывал ход с автоброском,
 * ответ терялся, и повтор той же фразы уходил с новым ключом — вторая проверка
 * и второй бросок.
 *
 * Отличие от доски одно: новое намерение не блокируется. Игрок пишет текст
 * свободно, поэтому другая заявка получает новый ключ и вытесняет запись, а
 * та же заявка (тот же текст, герой, вид реплики и контекст карточки) уходит
 * с прежним ключом, и сервер вернёт уже записанный commit.
 *
 * Хранится намерение, а не готовое тело: тело собирает `narrateWithAgent` из
 * тех же полей. Совпадение намерений гарантирует то же тело, кроме режима
 * броска — его запись хранит сама и повторяет как было.
 */
const NARRATE_REQUEST_KINDS = new Set(['action', 'question', 'discussion'])
// Пределы совпадают с серверными (`GameOrchestrator.handle`): обрезанное
// сервером значение и здесь сравнивается обрезанным.
const NARRATE_ID_LIMITS = Object.freeze({
  npcId: 120,
  clarificationId: 8_000,
  supersedesCheckId: 200,
  supersedesProposalId: 300,
  questionCheckId: 200,
  questionProposalId: 300,
})

// Та же нормализация текста, что в серверном отпечатке заявки
// (`narrationRequestFingerprint`, server/game-orchestrator.mjs): разница в
// пробелах и формах Юникода — та же заявка и для сервера, и здесь.
function narrateAction(value) {
  return String(value ?? '').trim().slice(0, MAX_MESSAGE_LENGTH).normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function narrateIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const campaignId = text(value.campaignId, MAX_CAMPAIGN_ID_LENGTH).toUpperCase()
  const action = narrateAction(value.action)
  if (!campaignId || !action) return null
  const intent = {
    campaignId,
    actorId: text(value.actorId, MAX_REQUEST_ID_LENGTH),
    action,
    requestKind: NARRATE_REQUEST_KINDS.has(value.requestKind) ? value.requestKind : 'action',
  }
  for (const [field, max] of Object.entries(NARRATE_ID_LIMITS)) {
    const id = text(value[field], max)
    if (id) intent[field] = id
  }
  return intent
}

function validPendingNarrate(value) {
  const intent = narrateIntent(value)
  const requestId = text(value?.requestId, MAX_REQUEST_ID_LENGTH)
  if (!intent || !requestId) return null
  return { ...intent, requestId, manualRoll: value.manualRoll === true }
}

/** Та же ли это заявка: кампания, герой, текст, вид реплики и ссылки на карточки. */
export function narrateIntentMatches(pending, intent) {
  const left = narrateIntent(pending)
  const right = narrateIntent(intent)
  if (!left || !right) return false
  return left.campaignId === right.campaignId
    && left.actorId === right.actorId
    && left.action === right.action
    && left.requestKind === right.requestKind
    && Object.keys(NARRATE_ID_LIMITS).every((field) => (left[field] ?? '') === (right[field] ?? ''))
}

/**
 * Запись для отправки. Повтор той же заявки возвращает прежнюю запись — с её
 * ключом и режимом броска; другая заявка получает новую запись. `newKey`
 * вызывается только для новой записи. `null` — заявку нечем описать (нет
 * кампании или текста), и восстанавливать её не из чего.
 */
export function narrateRecoveryFor(existing, intent, { newKey, manualRoll = false }) {
  const previous = validPendingNarrate(existing)
  if (previous && narrateIntentMatches(previous, intent)) return previous
  const fresh = narrateIntent(intent)
  return fresh ? validPendingNarrate({ ...fresh, requestId: newKey(), manualRoll: manualRoll === true }) : null
}

export function pendingNarrateStorageKey(accountId, campaignId) {
  const account = text(accountId, MAX_REQUEST_ID_LENGTH)
  const campaign = text(campaignId, MAX_CAMPAIGN_ID_LENGTH).toUpperCase()
  if (!account || !campaign) return null
  return `skazanie-pending-narrate-v${PENDING_SCHEMA_VERSION}:${encodeURIComponent(account)}:${encodeURIComponent(campaign)}`
}

export function parsePendingNarrate(raw) {
  return parsePending(raw, validPendingNarrate)
}

export function readPendingNarrate(storage, key) {
  return readPending(storage, key, validPendingNarrate)
}

export function writePendingNarrate(storage, key, pending) {
  writePending(storage, key, validPendingNarrate(pending))
}

/**
 * Снимает запись после известного исхода. С `requestId` снимает только свою:
 * поздний ответ прежней заявки не стирает запись новой.
 */
export function clearPendingNarrate(storage, key, requestId) {
  if (!storage || !key) return
  if (requestId) {
    const current = readPendingNarrate(storage, key)
    if (current && current.requestId !== requestId) return
  }
  clearPendingTacticalCommand(storage, key)
}

/*
 * Голос и общий бросок отряда с неизвестным исходом (аудит PR #131, REC-02).
 *
 * Тот же принцип, что у свободного действия выше, в отдельном слоте. Раньше
 * каждое нажатие рождало новый ключ: сервер записывал голос, ответ терялся, и
 * повтор того же голоса уходил с новым ключом — второй `PartyVoteCast` (тот же
 * бюллетень, но лишний commit). Общий бросок закрывает решение атомарно, и
 * повтор с новым ключом получал 409 вместо уже выпавшей кости.
 *
 * Та же операция (кампания, решение, герой, вид и вариант) уходит с прежним
 * ключом и тем же телом, и сервер вернёт записанный commit. Другая операция —
 * например, игрок передумал и выбрал другой вариант — получает новый ключ:
 * смена голоса до кворума разрешена правилами. Запись снимается только
 * известным исходом: принятым ответом или авторитетным отказом 4xx.
 */
const PARTY_DECISION_OPERATIONS = new Set(['vote', 'abstain', 'roll'])
const MAX_PARTY_DECISION_ID_LENGTH = 200

function partyDecisionIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const campaignId = text(value.campaignId, MAX_CAMPAIGN_ID_LENGTH).toUpperCase()
  const interactionId = text(value.interactionId, MAX_PARTY_DECISION_ID_LENGTH)
  const actorId = text(value.actorId, MAX_REQUEST_ID_LENGTH)
  const operation = PARTY_DECISION_OPERATIONS.has(value.operation) ? value.operation : null
  const optionId = operation === 'vote' ? text(value.optionId, MAX_PARTY_DECISION_ID_LENGTH) : ''
  if (!campaignId || !interactionId || !actorId || !operation || (operation === 'vote' && !optionId)) return null
  return { campaignId, interactionId, actorId, operation, ...(optionId ? { optionId } : {}) }
}

function validPendingPartyDecision(value) {
  const intent = partyDecisionIntent(value)
  const requestId = text(value?.requestId, MAX_REQUEST_ID_LENGTH)
  return intent && requestId ? { ...intent, requestId } : null
}

/** Та же ли это операция отряда: кампания, решение, герой, вид и вариант. */
export function partyDecisionIntentMatches(pending, intent) {
  const left = partyDecisionIntent(pending)
  const right = partyDecisionIntent(intent)
  if (!left || !right) return false
  return left.campaignId === right.campaignId
    && left.interactionId === right.interactionId
    && left.actorId === right.actorId
    && left.operation === right.operation
    && (left.optionId ?? '') === (right.optionId ?? '')
}

/**
 * Запись для отправки: повтор той же операции возвращает прежнюю запись с её
 * ключом, другая операция — новую. `newKey` вызывается только для новой.
 */
export function partyDecisionRecoveryFor(existing, intent, { newKey }) {
  const previous = validPendingPartyDecision(existing)
  if (previous && partyDecisionIntentMatches(previous, intent)) return previous
  const fresh = partyDecisionIntent(intent)
  return fresh ? validPendingPartyDecision({ ...fresh, requestId: newKey() }) : null
}

/** Запрос из записи: путь и тело собираются только из неё, повтор шлёт ровно то же. */
export function partyDecisionRequest(pending) {
  const value = validPendingPartyDecision(pending)
  if (!value) return null
  const base = `/api/campaigns/${encodeURIComponent(value.campaignId)}/party-decisions/${encodeURIComponent(value.interactionId)}`
  const body = value.operation === 'roll'
    ? { actor_id: value.actorId, idempotency_key: value.requestId }
    : value.operation === 'abstain'
      ? { actor_id: value.actorId, abstain: true, idempotency_key: value.requestId }
      : { actor_id: value.actorId, option_id: value.optionId, idempotency_key: value.requestId }
  return {
    path: value.operation === 'roll' ? `${base}/roll` : `${base}/votes`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    body,
  }
}

export function pendingPartyDecisionStorageKey(accountId, campaignId) {
  const account = text(accountId, MAX_REQUEST_ID_LENGTH)
  const campaign = text(campaignId, MAX_CAMPAIGN_ID_LENGTH).toUpperCase()
  if (!account || !campaign) return null
  return `skazanie-pending-party-decision-v${PENDING_SCHEMA_VERSION}:${encodeURIComponent(account)}:${encodeURIComponent(campaign)}`
}

export function readPendingPartyDecision(storage, key) {
  return readPending(storage, key, validPendingPartyDecision)
}

export function writePendingPartyDecision(storage, key, pending) {
  writePending(storage, key, validPendingPartyDecision(pending))
}

/** Снимает запись после известного исхода; с `requestId` — только свою. */
export function clearPendingPartyDecision(storage, key, requestId) {
  if (!storage || !key) return
  if (requestId) {
    const current = readPendingPartyDecision(storage, key)
    if (current && current.requestId !== requestId) return
  }
  clearPendingTacticalCommand(storage, key)
}
