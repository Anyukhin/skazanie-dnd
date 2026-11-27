// Записывающая обёртка `server/narrator.mjs` для эталонов задачи А5.
//
// Экспортирует то же, что рассказчик, но каждый вызов открытой функции и
// каждый `render` попадает в журнал `RECORDS` в порядке вызова: аргументы,
// итог (или исключение), для `render` — бриф, параметры, контекст кампании,
// запросы к модели с кусками потока и ответами, снимки `onProgress`.
// Журнал — данные для Rust: тот же порядок вызовов повторяется там шаг в шаг
// (кэш сенсорных якорей общий на процесс, и от порядка зависит итог).
//
// Подключается `fixtures/record-a5.mjs` (тесты JS) или напрямую из
// `gen-a5.mjs`. Если задан `A5_RECORD_FILE`, журнал пишется туда при выходе.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import * as real from '../../../../server/narrator.mjs?real'
import { currentCampaignAiSettings } from '../../../../server/campaign-ai-context.mjs'

export * from '../../../../server/narrator.mjs?real'

export const RECORDS = []

const sha = (text) => createHash('sha256').update(String(text)).digest('hex')

/** JSON-копия: функции и `undefined` выпадают, `Set` — массивом. */
export function plain(value) {
  if (value === undefined) return undefined
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'function') return undefined
    if (item instanceof Set) return [...item]
    if (item instanceof Map) return Object.fromEntries(item)
    if (typeof item === 'bigint') return Number(item)
    return item
  })
  return text === undefined ? undefined : JSON.parse(text)
}

const arg = (value) => (value === undefined ? { u: true } : { v: plain(value) })
const errorOf = (error) => ({ name: String(error?.name ?? 'Error'), code: error?.code == null ? null : String(error.code), message: String(error?.message ?? error) })

function wrap(name, fn, prepare = (args) => ({ args: args.map(arg) })) {
  return function recorded(...args) {
    const prepared = prepare(args)
    const entry = { k: 'call', fn: name, ...prepared }
    const settings = currentCampaignAiSettings()
    if (settings) entry.settings = plain(settings)
    RECORDS.push(entry)
    try {
      const out = fn.apply(this, prepared.call ?? args)
      entry.out = arg(out)
      return out
    } catch (error) {
      entry.threw = errorOf(error)
      throw error
    }
  }
}

export const weatherRecentlyMentioned = wrap('weatherRecentlyMentioned', real.weatherRecentlyMentioned)
export const recentClicheReminders = wrap('recentClicheReminders', real.recentClicheReminders)
export const narratorMomentFor = wrap('narratorMomentFor', real.narratorMomentFor)
export const freeActionRulingOutcome = wrap('freeActionRulingOutcome', real.freeActionRulingOutcome)
export const withoutEchoOfPlayer = wrap('withoutEchoOfPlayer', real.withoutEchoOfPlayer)
export const narratorResponsePlan = wrap('narratorResponsePlan', real.narratorResponsePlan)
export const selectNarratorFewShotExamples = wrap('selectNarratorFewShotExamples', real.selectNarratorFewShotExamples)
export const narratorContentDirectives = wrap('narratorContentDirectives', real.narratorContentDirectives)
export const narratorArcRecap = wrap('narratorArcRecap', real.narratorArcRecap)
export const sensoryAnchorsFor = wrap('sensoryAnchorsFor', real.sensoryAnchorsFor)
export const narratorMemoryFocus = wrap('narratorMemoryFocus', real.narratorMemoryFocus)
export const freshSceneElement = wrap('freshSceneElement', real.freshSceneElement)
export const confirmedOutcomeDetailSentence = wrap('confirmedOutcomeDetailSentence', real.confirmedOutcomeDetailSentence)
export const verifyNarratorCraft = wrap('verifyNarratorCraft', real.verifyNarratorCraft)
export const verifyNarratorFeedback = wrap('verifyNarratorFeedback', real.verifyNarratorFeedback)
export const narrationRepairNote = wrap('narrationRepairNote', real.narrationRepairNote)

/**
 * Резолвер имён — функция: в журнал уходят его ответы (`id` → имя), и Rust
 * отвечает теми же.
 */
export const deterministicNarration = wrap('deterministicNarration', real.deterministicNarration, (args) => {
  const [brief, resolveName, options] = args
  if (typeof resolveName !== 'function') return { args: args.map(arg) }
  const answers = []
  const recorder = (id) => {
    const out = resolveName(id)
    answers.push([arg(id), arg(out)])
    return out
  }
  return { args: [arg(brief), { resolver: answers }, ...(args.length > 2 ? [arg(options)] : [])], call: [brief, recorder, ...args.slice(2)] }
})

function requestPlain(request) {
  const copy = plain(request) ?? null
  if (copy && typeof copy === 'object') {
    delete copy.signal
    for (const message of Array.isArray(copy.messages) ? copy.messages : []) {
      if (message?.role === 'system' && typeof message.content === 'string') message.content = `sha256:${sha(message.content)}`
    }
  }
  return {
    request: copy,
    has_signal: Boolean(request?.signal),
    has_on_delta: typeof request?.onDelta === 'function',
  }
}

/** Клиент модели в записи: `complete`/`completeJson` пишут запрос, куски и исход. */
function recordingClient(client, holder) {
  if (!client || typeof client !== 'object') return client
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if ((key !== 'complete' && key !== 'completeJson') || typeof value !== 'function') return value
      return function recordedCall(request, ...rest) {
        const call = { method: key, ...requestPlain(request), deltas: [] }
        holder.calls?.push(call)
        let input = request
        if (request && typeof request.onDelta === 'function') {
          const onDelta = request.onDelta
          input = {
            ...request,
            onDelta: (delta) => {
              const piece = { text: String(delta ?? '') }
              call.deltas.push(piece)
              try {
                return onDelta(delta)
              } catch (error) {
                piece.threw = errorOf(error)
                throw error
              }
            },
          }
        }
        const signal = request?.signal
        let promise
        try {
          promise = value.call(target, input, ...rest)
        } catch (error) {
          call.outcome = { error: errorOf(error) }
          throw error
        }
        return Promise.resolve(promise).then(
          (result) => {
            call.outcome = { value: plain(result) ?? null }
            call.after_abort = Boolean(signal?.aborted)
            return result
          },
          (error) => {
            call.outcome = { error: errorOf(error) }
            call.after_abort = Boolean(signal?.aborted)
            throw error
          },
        )
      }
    },
  })
}

let nextNarratorId = 0

export class Narrator extends real.Narrator {
  constructor(options = {}) {
    const id = ++nextNarratorId
    const client = options?.llmClient ?? null
    const holder = { calls: null }
    const feedback = options?.feedbackVerifier === undefined ? 'default' : typeof options.feedbackVerifier === 'function' ? 'custom' : 'none'
    const config = {
      id,
      has_client: Boolean(client),
      client_name: client ? (client.constructor?.name ?? 'llm') : null,
      model: client?.model == null ? null : String(client.model),
      json_only: Boolean(client) && typeof client.complete !== 'function',
      async_feedback: options?.asyncFeedback !== false,
      feedback,
      custom_verifier: options?.verifier !== undefined,
      feedback_results: [],
    }
    let feedbackVerifier = options?.feedbackVerifier
    if (feedback === 'custom') {
      const original = options.feedbackVerifier
      feedbackVerifier = async (...args) => {
        const slot = { pending: true }
        config.feedback_results.push(slot)
        try {
          const out = await original(...args)
          delete slot.pending
          slot.value = plain(out) ?? null
          return out
        } catch (error) {
          delete slot.pending
          slot.error = String(error?.code ?? error?.name ?? 'NARRATOR_ASYNC_VERIFIER_ERROR')
          throw error
        }
      }
    }
    RECORDS.push({ k: 'new', id, config })
    super({ ...options, llmClient: recordingClient(client, holder), ...(feedback === 'custom' ? { feedbackVerifier } : {}) })
    this.recordId = id
    this.recordHolder = holder
  }

  async render(brief, options = {}) {
    const entry = {
      k: 'render',
      id: this.recordId,
      brief: arg(brief),
      options: {
        knownRuleIds: arg(options?.knownRuleIds),
        style: arg(options?.style),
        timeoutMs: arg(options?.timeoutMs),
        recentNarrations: arg(options?.recentNarrations),
        has_progress: typeof options?.onProgress === 'function',
      },
      calls: [],
      progress: [],
    }
    const settings = currentCampaignAiSettings()
    if (settings) entry.settings = plain(settings)
    RECORDS.push(entry)
    this.recordHolder.calls = entry.calls
    const userProgress = options?.onProgress
    const effective = typeof userProgress === 'function'
      ? { ...options, onProgress: (text) => { entry.progress.push(String(text)); return userProgress(text) } }
      : options
    try {
      const result = await super.render(brief, effective)
      const copy = plain(result)
      if (copy?.verification?.origin) delete copy.verification.origin.elapsed_ms
      entry.result = copy
      return result
    } catch (error) {
      entry.threw = errorOf(error)
      throw error
    }
  }

  async awaitFeedback(narration) {
    const entry = { k: 'awaitFeedback', id: this.recordId, narration: arg(narration) }
    RECORDS.push(entry)
    const out = await super.awaitFeedback(narration)
    entry.out = arg(out)
    return out
  }

  async drainFeedback() {
    const entry = { k: 'drainFeedback', id: this.recordId }
    RECORDS.push(entry)
    const out = await super.drainFeedback()
    entry.out = plain(out)
    return out
  }
}

if (process.env.A5_RECORD_FILE) {
  process.on('exit', () => {
    try {
      writeFileSync(process.env.A5_RECORD_FILE, JSON.stringify(RECORDS))
    } catch { /* запись журнала необязательна для теста */ }
  })
}
