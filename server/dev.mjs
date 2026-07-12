import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const client = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', '4173'], { cwd: root, stdio: 'inherit' })
const agent = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { cwd: root, stdio: 'inherit' })

function stop(code = 0) {
  client.kill()
  agent.kill()
  process.exit(code)
}

client.on('exit', (code) => stop(code ?? 0))
agent.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
