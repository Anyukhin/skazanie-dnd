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
  }

  _campaign(campaignId, create = true) {
    const normalized = normalizedCampaignId(campaignId)
    if (!normalized) throw streamError('Не указана кампания потокового повествования', 'NARRATION_CAMPAIGN_REQUIRED')
    if (!this.active.has(normalized) && create) this.active.set(normalized, new Map())
    return { normalized, entries: this.active.get(normalized) ?? null }
  }

  _deliver(connection, event, payload) {
    if (!connection || connection.closed || connection.res?.destroyed) return
    // Аудит PR #131, SEC-06: своей очереди у повествования больше нет. Раньше
    // backpressure держал только этот класс, а `room`, `presence` и пульс шли
    // в сокет мимо него. Теперь кадр уходит в общую очередь соединения
    // (`CampaignStreamOutbox` ниже): она и схлопывает снимки одного сообщения
    // до последнего, пока клиент не дочитал прежние.
    this.write(connection, event, payload)
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

  activeCount(campaignId) {
    return this._campaign(campaignId, false).entries?.size ?? 0
  }
}

// ---------------------------------------------------------------------------
// Очередь кадров одного SSE-соединения
// ---------------------------------------------------------------------------

/**
 * Сколько непрочитанных кадров держит одно соединение, пока сокет не принял
 * прежние. Кадры с ключом схлопываются — одна `room`, одна `presence`, один
 * пульс, по снимку на сообщение повествования, — поэтому до предела доходит
 * только поток разных сообщений к клиенту, который не читает вовсе.
 */
export const CAMPAIGN_STREAM_MAX_PENDING_FRAMES = 32

/**
 * Ключ схлопывания кадра: непрочитанный кадр с тем же ключом заменяется новым.
 * `room` несёт полное разрешённое состояние, `presence` — полный список
 * печатающих, снимок повествования — полный текст своего сообщения, так что
 * промежуточные клиенту не нужны. Остальные кадры (`null`) не схлопываются и
 * считаются в предел по одному.
 *
 * @param {string} event
 * @param {unknown} payload
 * @returns {string | null}
 */
export function campaignStreamFrameKey(event, payload) {
  const name = String(event ?? '')
  if (name === 'room' || name === 'presence' || name === 'heartbeat') return name
  const messageId = payload && typeof payload === 'object' ? payload.message_id : null
  if (name.startsWith('narration.') && messageId) return `narration:${messageId}`
  return null
}

/**
 * Аудит PR #131, SEC-06: одна ограниченная очередь на SSE-соединение для всех
 * кадров — комнаты, присутствия, пульса и повествования.
 *
 * `ServerResponse.write()` возвращает `false`, когда буфер сокета переполнен,
 * но кадр при этом уже принят и будет отправлен после `drain`. Раньше это
 * учитывал только поток повествования, а рассылка комнаты и индикатор ввода
 * продолжали писать: клиент, который не читает сокет, копил в памяти сервера
 * по полному состоянию кампании на каждый ход.
 *
 * Теперь пока сокет занят, новые кадры ждут здесь, и кадр с тем же ключом
 * (`campaignStreamFrameKey`) заменяет непрочитанный прежний. На `drain`
 * уходит последнее. Кадр собирается **в момент записи** (`render`), а не
 * постановки: кадр комнаты сжимается относительно карты, которую соединение
 * действительно отправило (`mapHash`), — выброшенный промежуточный кадр не
 * оставит клиенту хеш карты, которую тот так и не получил.
 *
 * Очередь ограничена `maxPending`. Переполнение значит, что клиент не читает
 * вовсе: соединение закрывается (`onClose('overflow')`), а переподключение
 * получает полное разрешённое состояние обычным рукопожатием.
 *
 * Отзыв прав (`access`) сюда не входит: он выбрасывает ожидающие кадры
 * (`discard`) — они собраны под прежними правами — и пишется в сокет напрямую
 * перед закрытием потока.
 */
export class CampaignStreamOutbox {
  /**
   * @param {{
   *   write: (chunk: string) => boolean | null,
   *   maxPending?: number,
   *   onClose?: (reason: 'overflow' | 'render_failed', error?: unknown) => void,
   * }} options `write` возвращает результат `res.write()` либо `null`, если
   *   соединение уже закрыто.
   */
  constructor({ write, maxPending = CAMPAIGN_STREAM_MAX_PENDING_FRAMES, onClose = () => {} } = {}) {
    if (typeof write !== 'function') throw new TypeError('CampaignStreamOutbox требует write')
    this.write = write
    this.maxPending = Math.max(1, Number(maxPending) || CAMPAIGN_STREAM_MAX_PENDING_FRAMES)
    this.onClose = onClose
    this.blocked = false
    this.closed = false
    this.pending = new Map()
    this.sequence = 0
  }

  get pendingCount() {
    return this.pending.size
  }

  _close(reason, error) {
    this.pending.clear()
    if (this.closed) return
    this.closed = true
    this.onClose(reason, error)
  }

  /**
   * Отправляет кадр сразу либо ставит его в очередь, если сокет занят.
   * `render` возвращает готовую строку SSE (или `null`, если писать нечего) и
   * вызывается ровно тогда, когда кадр уходит в сокет.
   *
   * @param {string | null} key ключ схлопывания, `null` — не схлопывать
   * @param {() => string | null} render
   * @returns {boolean | null} результат записи; `false` — кадр в очереди или
   *   буфер полон; `null` — соединение закрыто или переполнено
   */
  send(key, render) {
    if (this.closed) return null
    if (!this.blocked && !this.pending.size) return this._flush(render)
    const slot = key ?? `frame:${++this.sequence}`
    // Удаление перед вставкой переносит схлопнутый кадр в конец: порядок
    // уцелевших кадров тот же, в каком приходили их последние версии.
    this.pending.delete(slot)
    this.pending.set(slot, render)
    if (this.pending.size > this.maxPending) {
      this._close('overflow')
      return null
    }
    return false
  }

  /** Сокет освободился: отправить ожидающее, пока он снова не заполнится. */
  drain() {
    this.blocked = false
    while (!this.closed && this.pending.size && !this.blocked) {
      const [slot, render] = this.pending.entries().next().value
      this.pending.delete(slot)
      let written
      // `drain` приходит из события сокета: брошенная здесь ошибка уронила бы
      // процесс. Не собрался кадр — соединение закрывается, клиент
      // переподключится и получит состояние заново.
      try { written = this._flush(render) }
      catch (error) {
        this._close('render_failed', error)
        return
      }
      if (written === null) {
        this.pending.clear()
        return
      }
    }
  }

  /** Выбросить непрочитанное — перед отзывом прав и закрытием потока. */
  discard() {
    this.pending.clear()
  }

  _flush(render) {
    const chunk = render()
    if (chunk == null) return true
    const written = this.write(String(chunk))
    if (written === false) this.blocked = true
    return written
  }
}
