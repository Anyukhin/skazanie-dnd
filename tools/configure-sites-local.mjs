import { readFileSync, writeFileSync } from 'node:fs'

// Ключ передаётся скрытым stdin: он не попадает в аргументы команды или вывод.
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stderr.write('Ready for private Sites configuration on stdin (input is hidden).\n')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (!/[\r\n]/.test(input)) return
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  const { url, key } = JSON.parse(input.trim())
  const address = new URL(url)
  if (address.protocol !== 'https:' || !address.hostname.endsWith('.chatgpt.site') ||
      typeof key !== 'string' || key.length < 16 || /[\r\n\0]/.test(key)) throw new Error('Некорректная конфигурация Sites')
  let env = readFileSync('.env', 'utf8')
  for (const [name, value] of [['DND_SITES_URL', address.origin], ['DND_SITES_SERVICE_KEY', key]]) {
    const line = `${name}=${value}`
    const pattern = new RegExp(`^${name}=.*$`, 'm')
    env = pattern.test(env) ? env.replace(pattern, () => line) : `${env.trimEnd()}\n${line}\n`
  }
  writeFileSync('.env', env)
  console.log('Private Sites configuration saved; values hidden.')
  process.exit(0)
})
