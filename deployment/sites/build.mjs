import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

// Идентификатор записывает Sites при регистрации; конфигурация не содержит секретов.
const hosting = JSON.parse(readFileSync('.openai/hosting.json', 'utf8'))
if (!hosting.project_id || hosting.static || hosting.d1 !== 'ORIGIN_DB' || hosting.r2) {
  throw new Error('Нужен зарегистрированный Sites Worker с ORIGIN_DB без static и R2')
}
mkdirSync('dist/server', { recursive: true })
mkdirSync('dist/.openai', { recursive: true })
copyFileSync('worker.mjs', 'dist/server/index.js')
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json')
