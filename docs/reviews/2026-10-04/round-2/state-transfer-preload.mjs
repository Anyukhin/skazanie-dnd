// Предзагрузчик только для пробы. Он передаётся временному HTTP-процессу через
// `node --import`; production-модули на месте не редактируются и не изменяются.
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'
import { Server, ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'

import { FileEventStore } from '../../../../server/event-store.mjs'

const recordsPath = process.env.STATE_COST_RECORDS
const asyncLocalStorage = new AsyncLocalStorage()
const originalStringify = JSON.stringify

function now() {
  return performance.now()
}

function currentContext() {
  return asyncLocalStorage.getStore() ?? null
}

function addTiming(context, name, elapsedMs) {
  if (!context) return
  const bucket = context.store[name] ?? { calls: 0, elapsed_ms: 0 }
  bucket.calls += 1
  bucket.elapsed_ms += elapsedMs
  context.store[name] = bucket
}

function wrapStoreMethod(name) {
  const original = FileEventStore.prototype[name]
  if (typeof original !== 'function') return
  FileEventStore.prototype[name] = function probeStoreMethod(...args) {
    const started = now()
    let value
    try {
      value = original.apply(this, args)
    } catch (error) {
      addTiming(currentContext(), name, now() - started)
      throw error
    }
    if (value && typeof value.then === 'function') {
      return value.finally(() => addTiming(currentContext(), name, now() - started))
    }
    addTiming(currentContext(), name, now() - started)
    return value
  }
}

// Это production-границы сохранения, которые можно связать с запросом команды.
// В отчёте используются включающие вложенные операции времена load/commit;
// сами вложенные вызовы остаются видимыми в той же записи, но не складываются
// повторно.
for (const name of ['load', 'commit', 'getEvents', 'acknowledgeProjection', 'pendingProjection']) wrapStoreMethod(name)

JSON.stringify = function probeStringify(value, ...args) {
  const started = now()
  const encoded = originalStringify.call(JSON, value, ...args)
  const context = currentContext()
  if (context) {
    context.stringify_calls += 1
    context.stringify_ms += now() - started
    if (value && typeof value === 'object' && !Array.isArray(value) && value.authoritative_state) {
      context.response_stringify_calls += 1
      context.response_stringify_ms += now() - started
      context.response_bytes = Buffer.byteLength(encoded, 'utf8')
      context.response_keys = Object.keys(value)
    }
  }
  return encoded
}

const originalWriteHead = ServerResponse.prototype.writeHead
ServerResponse.prototype.writeHead = function probeWriteHead(...args) {
  const context = currentContext()
  if (context && Number.isInteger(args[0])) context.status = args[0]
  return originalWriteHead.apply(this, args)
}

const originalEmit = Server.prototype.emit
Server.prototype.emit = function probeServerEmit(event, ...args) {
  if (event !== 'request' || !args[0] || !args[1]) return originalEmit.call(this, event, ...args)
  const request = args[0]
  const response = args[1]
  const context = {
    method: String(request.method ?? ''),
    path: String(request.url ?? ''),
    started: now(),
    status: 0,
    store: Object.create(null),
    stringify_calls: 0,
    stringify_ms: 0,
    response_stringify_calls: 0,
    response_stringify_ms: 0,
    response_bytes: null,
    response_keys: null,
  }
  response.once('finish', () => {
    if (!recordsPath) return
    const record = {
      method: context.method,
      path: context.path,
      status: context.status || response.statusCode,
      request_elapsed_ms: Number((now() - context.started).toFixed(3)),
      store: Object.fromEntries(Object.entries(context.store).map(([name, value]) => [name, {
        calls: value.calls,
        elapsed_ms: Number(value.elapsed_ms.toFixed(3)),
      }])),
      stringify_calls: context.stringify_calls,
      stringify_ms: Number(context.stringify_ms.toFixed(3)),
      response_stringify_calls: context.response_stringify_calls,
      response_stringify_ms: Number(context.response_stringify_ms.toFixed(3)),
      response_bytes: context.response_bytes,
      response_keys: context.response_keys,
    }
    appendFileSync(recordsPath, `${originalStringify.call(JSON, record)}\n`, 'utf8')
  })
  return asyncLocalStorage.run(context, () => originalEmit.call(this, event, request, response))
}
