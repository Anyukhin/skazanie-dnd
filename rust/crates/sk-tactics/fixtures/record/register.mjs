// `node --import <этот файл> test/x.test.mjs`: среда эталонов, хук обёрток и
// сброс записанных вызовов в `T2_RECORD_OUT` при выходе.
import '../../../../fixtures-env.mjs'
import { register } from 'node:module'
import { writeFileSync } from 'node:fs'

register('./hooks.mjs', import.meta.url)

globalThis.__T2_RECORD__ = []
process.on('exit', () => {
  const out = process.env.T2_RECORD_OUT
  if (out) writeFileSync(out, JSON.stringify(globalThis.__T2_RECORD__))
})
