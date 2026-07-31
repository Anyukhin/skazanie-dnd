export const NARRATION_STREAM_TEXT_MAX_BYTES = 12 * 1024
export const NARRATION_STREAM_EVENT_MAX_BYTES = 16 * 1024
export const NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN = 16
export const NARRATION_STREAM_COALESCE_MS = 50

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u
const FINAL_PHASES = new Set(['complete', 'replaced', 'aborted'])

function streamError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizedCampaignId(value) {
  return String(value ?? '').trim().toUpperCase()
}

function normalizedMessageId(value) {
  const messageId = String(value ?? '').trim()
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw streamError('Некорректный идентификатор потокового повествования', 'NARRATION_MESSAGE_ID_INVALID')
  }
  return messageId
}

function boundedText(value) {
  const text = String(value ?? '')
  if (Buffer.byteLength(text, 'utf8') > NARRATION_STREAM_TEXT_MAX_BYTES) {
    throw streamError('Потоковое повествование превышает допустимый размер', 'NARRATION_STREAM_TOO_LARGE')
  }
  return text
}

function publicPayload({ messageId, text = '', phase, replayed = false }) {
  const payload = {
    message_id: normalizedMessageId(messageId),
    text: boundedText(text),
    phase,
    replace: true,
    replayed: Boolean(replayed),
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > NARRATION_STREAM_EVENT_MAX_BYTES) {
    throw streamError('SSE-событие повествования превышает допустимый размер', 'NARRATION_STREAM_EVENT_TOO_LARGE')
  }
  return payload
}

/**
 * Хранит только короткие публичные снимки текста. Авторитетное состояние,
 * события механики и ключ идемпотентности в этот объект не принимаются.
 */
export class CampaignNarrationStream {
  constructor({
    connectionsFor,
    write,
    coalesceMs = NARRATION_STREAM_COALESCE_MS,
    maxActive = NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
  } = {}) {
    if (typeof connectionsFor !== 'function' || typeof write !== 'function') {
      throw new TypeError('CampaignNarrationStream требует connectionsFor и write')
    }
    this.connectionsFor = connectionsFor
    this.write = write
    this.coalesceMs = Math.max(0, Number(coalesceMs) || 0)
    this.maxActive = Math.max(1, Number(maxActive) || NARRATION_STREAM_MAX_ACTIVE_PER_CAMPAIGN)
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.now = now
    this.active = new Map()
    this.pendingByConnection = new WeakMap()
  }

  _campaign(campaignId, create = true) {
    const normalized = normalizedCampaignId(campaignId)
    if (!normalized) throw streamError('Не указана кампания потокового повествования', 'NARRATION_CAMPAIGN_REQUIRED')
    if (!this.active.has(normalized) && create) this.active.set(normalized, new Map())
    return { normalized, entries: this.active.get(normalized) ?? null }
  }

  _pending(connection) {
    let pending = this.pendingByConnection.get(connection)
    if (!pending) {
      pending = new Map()
      this.pendingByConnection.set(connection, pending)
    }
    return pending
  }

  _deliver(connection, event, payload) {
    if (!connection || connection.closed || connection.res?.destroyed) return
    if (connection.narrationBackpressured) {
      this._pending(connection).set(payload.message_id, { event, payload })
      return
    }
    const ready = this.write(connection, event, payload)
    if (ready === false) connection.narrationBackpressured = true
  }

  _broadcast(campaignId, event, payload) {
    for (const connection of this.connectionsFor(campaignId)) {
      this._deliver(connection, event, payload)
    }
  }

  _cancel(entry) {
    if (entry?.timer != null) {
      this.clearTimer(entry.timer)
      entry.timer = null
    }
  }

  _remove(campaignId, messageId) {
    const { normalized, entries } = this._campaign(campaignId, false)
    const entry = entries?.get(messageId)
    this._cancel(entry)
    entries?.delete(messageId)
    if (entries && !entries.size) this.active.delete(normalized)
    return entry ?? null
  }

  start(campaignId, { messageId } = {}) {
    const { normalized, entries } = this._campaign(campaignId)
    const id = normalizedMessageId(messageId)
    if (!entries.has(id) && entries.size >= this.maxActive) {
      const oldest = [...entries.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0]
      // Лимит относится только к process-local preview. Генерацию и commit он
      // не отменяет, поэтому `aborted` здесь был бы ложным финалом: старый ход
      // всё равно позже пришлёт канонический complete/replaced.
      if (oldest) this._remove(normalized, oldest.messageId)
    }
    // При maxActive=1 удаление единственной старой записи убирает Map из
    // верхнего реестра; возвращаем тот же ограниченный контейнер перед записью.
    if (!this.active.has(normalized)) this.active.set(normalized, entries)
    const entry = {
      messageId: id,
      text: '',
      updatedAt: this.now(),
      timer: null,
    }
    entries.set(id, entry)
    const payload = publicPayload({
      messageId: id,
      phase: 'start',
    })
    this._broadcast(normalized, 'narration.start', payload)
    return payload
  }

  progress(campaignId, { messageId, text } = {}) {
    const { normalized, entries } = this._campaign(campaignId, false)
    const id = normalizedMessageId(messageId)
    const entry = entries?.get(id)
    if (!entry) {
      throw streamError('Повествование не было начато после commit', 'NARRATION_STREAM_NOT_STARTED')
    }
    entry.text = boundedText(text)
    entry.updatedAt = this.now()
    if (entry.timer != null) return
    entry.timer = this.setTimer(() => {
      entry.timer = null
      if (!entries.has(id)) return
      const payload = publicPayload({
        messageId: id,
        text: entry.text,
        phase: 'streaming',
      })
      this._broadcast(normalized, 'narration.chunk', payload)
    }, this.coalesceMs)
    entry.timer?.unref?.()
  }

  complete(campaignId, {
    messageId,
    text,
    phase = 'complete',
    replayed = false,
  } = {}) {
    if (!FINAL_PHASES.has(phase)) {
      throw streamError('Некорректная финальная фаза повествования', 'NARRATION_PHASE_INVALID')
    }
    const id = normalizedMessageId(messageId)
    this._remove(campaignId, id)
    const payload = publicPayload({
      messageId: id,
      text,
      phase,
      replayed,
    })
    this._broadcast(campaignId, 'narration.complete', payload)
    return payload
  }

  abort(campaignId, { messageId } = {}) {
    const id = normalizedMessageId(messageId)
    const entry = this._remove(campaignId, id)
    return this.complete(campaignId, {
      messageId: id,
      text: entry?.text ?? '',
      phase: 'aborted',
    })
  }

  replay(campaignId, connection) {
    const { entries } = this._campaign(campaignId, false)
    if (!entries) return
    for (const entry of [...entries.values()].sort((left, right) => left.updatedAt - right.updatedAt)) {
      const streaming = Boolean(entry.text)
      this._deliver(connection, streaming ? 'narration.chunk' : 'narration.start', publicPayload({
        messageId: entry.messageId,
        text: entry.text,
        phase: streaming ? 'streaming' : 'start',
      }))
    }
  }

  drain(connection) {
    connection.narrationBackpressured = false
    const pending = this._pending(connection)
    for (const [messageId, item] of [...pending]) {
      pending.delete(messageId)
      this._deliver(connection, item.event, item.payload)
      if (connection.narrationBackpressured) break
    }
  }

  activeCount(campaignId) {
    return this._campaign(campaignId, false).entries?.size ?? 0
  }
}
