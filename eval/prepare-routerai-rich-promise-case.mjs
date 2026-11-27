import { readFileSync, writeFileSync } from 'node:fs'

const cases = JSON.parse(readFileSync('tmp/routerai-narrator-rich-cases-2026-11-27.json', 'utf8'))
const promise = cases.find(entry => entry.id === 'open-promise')
if (!promise) throw new Error('open-promise case is missing')
writeFileSync('tmp/routerai-narrator-rich-promise-case-2026-11-27.json', `${JSON.stringify([promise], null, 2)}\n`)
