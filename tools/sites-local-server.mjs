import 'dotenv/config'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const runtime = join(root, 'tmp/sites-runtime')
mkdirSync(runtime, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const output = createWriteStream(join(runtime, 'server.log'), { flags: 'a' })
let server, tunnel, closing = false, currentOrigin = '', connectedOrigin = ''

async function ready() {
  try {
    const response = await fetch('http://127.0.0.1:8787/api/health', { method: 'HEAD', signal: AbortSignal.timeout(3000) })
    return response.ok
  } catch { return false }
}

async function syncOrigin() {
  if (!currentOrigin || currentOrigin === connectedOrigin || !process.env.DND_SITES_URL || !process.env.DND_SITES_SERVICE_KEY) return
  try {
    const response = await fetch(new URL('/_skazanie/origin', process.env.DND_SITES_URL), {
      method: 'PUT', headers: {
        'Content-Type': 'application/json',
        'OAI-Sites-Authorization': `Bearer ${process.env.DND_SITES_SERVICE_KEY}`,
        'X-Skazanie-Link-Key': process.env.DND_SITES_SERVICE_KEY,
      }, body: JSON.stringify({ origin: currentOrigin }), signal: AbortSignal.timeout(15000),
    })
    if (!response.ok || !(await response.json()).ok) return
    connectedOrigin = currentOrigin
    console.log('Адрес сервера обновлён в Sites')
  } catch { /* Следующая проверка повторяет только безопасное обновление адреса. */ }
}

async function run() {
  if (!await ready()) {
    server = spawn(process.execPath, [join(root, 'server/index.mjs')], {
      cwd: root, windowsHide: true, env: { ...process.env, AGENT_PORT: '8787', AGENT_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.pipe(output, { end: false }); server.stderr.pipe(output, { end: false })
    for (let i = 0; i < 60 && !await ready(); i++) await pause(1000)
    if (!await ready()) throw new Error('Игровой сервер не запустился; подробности в tmp/sites-runtime/server.log')
  }
  const key = join(runtime, 'tunnel-key')
  if (!existsSync(key) && spawnSync('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-f', key, '-N', ''], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    throw new Error('Не удалось подготовить ключ бесплатного туннеля')
  }
  const timer = setInterval(() => { void syncOrigin() }, 15000)
  while (!closing) {
    console.log('Подключаем бесплатный туннель к игровому серверу…')
    tunnel = spawn('ssh.exe', ['-p', '443', '-T', '-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=15', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${join(runtime, 'known_hosts')}`, '-R', '0:127.0.0.1:8787', 'free.pinggy.io'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    writeFileSync(join(runtime, 'children.json'), JSON.stringify({ server: server?.pid ?? null, tunnel: tunnel.pid }))
    let pending = ''
    const inspect = (chunk) => {
      pending = (pending + chunk.toString()).slice(-12000)
      const match = pending.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.(?:free\.pinggy\.net|pinggy-free\.link|pinggy\.link)/i)
      if (match && currentOrigin !== match[0]) {
        currentOrigin = match[0]
        writeFileSync(join(root, 'PUBLIC_LINK.txt'), `${currentOrigin}\n`)
        console.log(`Игровой сервер доступен: ${currentOrigin}`)
        void syncOrigin()
      }
    }
    tunnel.stdout.on('data', inspect); tunnel.stderr.on('data', inspect)
    await new Promise((resolve) => { tunnel.once('close', resolve); tunnel.once('error', resolve) })
    currentOrigin = ''; connectedOrigin = ''
    if (!closing) await pause(3000)
  }
  clearInterval(timer)
}

function stop() { closing = true; tunnel?.kill(); server?.kill(); output.end() }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
run().catch((error) => { console.error(error.message); stop(); process.exitCode = 1 })
