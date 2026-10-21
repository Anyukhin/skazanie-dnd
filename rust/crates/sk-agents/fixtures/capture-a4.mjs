import '../../../fixtures-env.mjs'
// Запись вызовов `NpcSocialController.respond` в тестах JS (задача А4).
//
//   node --import ./rust/crates/sk-agents/fixtures/capture-a4.mjs test/<файл>.test.mjs
//
// Подключается `gen-a4.mjs` к каждому тесту, где участвует роль: прототип
// `respond` обёрнут, клиент модели — прозрачным прокси, который пишет запросы
// и ответы (или отказ). Запись — вход роли (состояние на момент вызова), имя
// класса и модель клиента, сценарий ответов модели, запросы к ней и итог.
// Rust повторяет каждую запись своей заглушкой. Выход — JSON в `CAPTURE_OUT`.
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config' || specifier === 'dotenv') return { url: 'data:text/javascript,export default {}; export const config = () => ({});', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const errorOf = (error) => ({
  name: error?.name ?? 'Error',
  code: error?.code === undefined || error?.code === null ? null : String(error.code),
  message: String(error?.message ?? error),
})

function recordedCall(method, input, options) {
  const copy = plain(input)
  for (const message of copy?.messages ?? []) {
    if (message?.role === 'system') message.content = `sha256:${createHash('sha256').update(String(message.content)).digest('hex')}`
  }
  return { method, input: copy, options: plain(options ?? {}) ?? {} }
}

const records = []
const { NpcSocialController } = await import('../../../../server/npc-social-controller.mjs')
const original = NpcSocialController.prototype.respond
NpcSocialController.prototype.respond = async function respond(input) {
  const record = {
    input: plain(input ?? {}) ?? {},
    hasClient: Boolean(this.llmClient),
    className: this.llmClient ? (this.llmClient.constructor?.name ?? 'llm') : null,
    model: typeof this.llmClient?.model === 'string' ? this.llmClient.model : null,
    script: [],
    calls: [],
  }
  let self = this
  if (this.llmClient) {
    const client = this.llmClient
    const proxy = new Proxy(client, {
      get(target, property) {
        if (property !== 'completeJson') return Reflect.get(target, property, target)
        return async (request, options) => {
          record.calls.push(recordedCall('completeJson', request, options))
          try {
            const value = await target.completeJson(request, options)
            record.script.push(value === undefined ? { undef: true } : { value: plain(value) })
            return value
          } catch (error) {
            record.script.push({ error: errorOf(error) })
            throw error
          }
        }
      },
    })
    self = Object.create(this)
    self.llmClient = proxy
  }
  try {
    const out = await original.call(self, input)
    record.out = out === undefined ? null : plain(out)
    records.push(record)
    return out
  } catch (error) {
    record.err = errorOf(error)
    records.push(record)
    throw error
  }
}

process.on('exit', () => {
  if (process.env.CAPTURE_OUT) writeFileSync(process.env.CAPTURE_OUT, JSON.stringify(records))
})
