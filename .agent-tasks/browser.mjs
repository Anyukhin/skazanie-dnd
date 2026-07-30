import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DEFAULT_PAGE_COUNT = 5
const DEFAULT_TIMEOUT = 15_000

export const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

function timeoutError(label, timeoutMs) {
  return new Error(`CDP timeout after ${timeoutMs} ms: ${label}`)
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

class CdpConnection {
  constructor(webSocket, defaultTimeout = DEFAULT_TIMEOUT) {
    this.webSocket = webSocket
    this.defaultTimeout = defaultTimeout
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    webSocket.addEventListener('message', (event) => void this.#receive(event.data))
    webSocket.addEventListener('close', () => this.#rejectAll(new Error('CDP WebSocket closed')))
    webSocket.addEventListener('error', () => this.#rejectAll(new Error('CDP WebSocket failed')))
  }

  async #receive(data) {
    const text = typeof data === 'string'
      ? data
      : typeof data?.text === 'function'
        ? await data.text()
        : Buffer.from(data).toString('utf8')
    const message = JSON.parse(text)
    if (message.id != null) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result ?? {})
      return
    }
    const key = `${message.sessionId ?? ''}:${message.method}`
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener(message.params ?? {})
  }

  #rejectAll(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  send(method, params = {}, sessionId = null, timeoutMs = this.defaultTimeout) {
    if (this.closed || this.webSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot send ${method}: CDP connection is closed`))
    }
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCommand(timeoutError(method, timeoutMs))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer, method })
      this.webSocket.send(JSON.stringify(payload))
    })
  }

  waitForEvent(method, { sessionId = null, timeoutMs = this.defaultTimeout, predicate = () => true } = {}) {
    const key = `${sessionId ?? ''}:${method}`
    return new Promise((resolveEvent, rejectEvent) => {
      const listeners = this.listeners.get(key) ?? new Set()
      this.listeners.set(key, listeners)
      const cleanup = () => {
        clearTimeout(timer)
        listeners.delete(listener)
        if (!listeners.size) this.listeners.delete(key)
      }
      const listener = (params) => {
        if (!predicate(params)) return
        cleanup()
        resolveEvent(params)
      }
      const timer = setTimeout(() => {
        cleanup()
        rejectEvent(timeoutError(method, timeoutMs))
      }, timeoutMs)
      listeners.add(listener)
    })
  }

  close() {
    this.#rejectAll(new Error('CDP connection closed by runner'))
    if (this.webSocket.readyState === WebSocket.OPEN || this.webSocket.readyState === WebSocket.CONNECTING) {
      this.webSocket.close()
    }
  }
}

function scriptFor(source, args) {
  if (typeof source === 'function') {
    return `(${source.toString()})(${args.map((value) => JSON.stringify(value)).join(',')})`
  }
  if (args.length) throw new TypeError('Arguments are supported only when evaluate receives a function')
  return String(source)
}

export class CdpPage {
  constructor({ connection, targetId, sessionId, browserContextId, index }) {
    this.connection = connection
    this.targetId = targetId
    this.sessionId = sessionId
    this.browserContextId = browserContextId
    this.index = index
    this.closed = false
  }

  command(method, params = {}, timeoutMs) {
    return this.connection.send(method, params, this.sessionId, timeoutMs)
  }

  async navigate(url, { waitUntil = 'load', timeoutMs = DEFAULT_TIMEOUT } = {}) {
    const eventMethod = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired'
    const loaded = waitUntil === 'none'
      ? null
      : this.connection.waitForEvent(eventMethod, { sessionId: this.sessionId, timeoutMs })
    const result = await this.command('Page.navigate', { url: String(url) }, timeoutMs)
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
    if (loaded) await loaded
    return result
  }

  async evaluate(source, ...args) {
    const expression = scriptFor(source, args)
    const result = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'unknown page exception'
      throw new Error(`Runtime.evaluate: ${description}`)
    }
    return result.result?.value
  }

  async waitFor(source, {
    args = [],
    timeoutMs = DEFAULT_TIMEOUT,
    intervalMs = 50,
    label = 'page predicate',
  } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() <= deadline) {
      try {
        if (await this.evaluate(source, ...args)) return true
      } catch (error) {
        lastError = error
      }
      await wait(intervalMs)
    }
    const error = timeoutError(label, timeoutMs)
    if (lastError) error.cause = lastError
    throw error
  }

  waitForSelector(selector, { visible = true, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    return this.waitFor((query, mustBeVisible) => {
      const element = document.querySelector(query)
      if (!element) return false
      if (!mustBeVisible) return true
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }, { args: [selector, visible], timeoutMs, label: `selector ${selector}` })
  }

  async click(selector) {
    const point = await this.evaluate((query) => {
      const element = document.querySelector(query)
      if (!element) throw new Error(`Element not found: ${query}`)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) throw new Error(`Element is not visible: ${query}`)
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, selector)
    await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }

  async type(selector, text, { clear = true } = {}) {
    await this.click(selector)
    await this.evaluate((query) => {
      const element = document.querySelector(query)
      if (!(element instanceof HTMLElement)) throw new Error(`Element cannot receive focus: ${query}`)
      element.focus()
    }, selector)
    if (clear) {
      await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
      await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
      await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
      await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    await this.command('Input.insertText', { text: String(text) })
  }

  async screenshot(filePath, { fullPage = true } = {}) {
    const absolutePath = resolve(filePath)
    await mkdir(resolve(absolutePath, '..'), { recursive: true })
    let clip
    if (fullPage) {
      const metrics = await this.command('Page.getLayoutMetrics')
      const size = metrics.cssContentSize ?? metrics.contentSize
      clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
    }
    const result = await this.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: fullPage,
      ...(clip ? { clip } : {}),
    }, 30_000)
    await writeFile(absolutePath, Buffer.from(result.data, 'base64'))
    return absolutePath
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

async function connectWebSocket(url, timeoutMs) {
  const webSocket = new WebSocket(url)
  await withTimeout(new Promise((resolveOpen, rejectOpen) => {
    webSocket.addEventListener('open', resolveOpen, { once: true })
    webSocket.addEventListener('error', () => rejectOpen(new Error(`Cannot connect to ${url}`)), { once: true })
  }), timeoutMs, 'Chrome DevTools WebSocket')
  return webSocket
}

async function waitForDevToolsFile(profileDir, chromeProcess, timeoutMs) {
  const activePortPath = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (chromeProcess.exitCode != null) throw new Error(`Chrome exited with code ${chromeProcess.exitCode}`)
    try {
      const [port, browserPath] = (await readFile(activePortPath, 'utf8')).trim().split(/\r?\n/u)
      if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await wait(50)
  }
  throw timeoutError('DevToolsActivePort', timeoutMs)
}

function safeTemporaryProfile(profileDir) {
  const temporaryRoot = resolve(tmpdir())
  const candidate = resolve(profileDir)
  return candidate.startsWith(`${temporaryRoot}${sep}`) && basename(candidate).startsWith('skazanie-cdp-')
}

export class CdpBrowser {
  constructor({ chromeProcess, connection, profileDir, pages, browserContextIds }) {
    this.chromeProcess = chromeProcess
    this.connection = connection
    this.profileDir = profileDir
    this.pages = pages
    this.browserContextIds = browserContextIds
    this.closed = false
  }

  page(index) {
    const page = this.pages[index]
    if (!page) throw new RangeError(`Page ${index} does not exist; available: 0..${this.pages.length - 1}`)
    return page
  }

  async reopenPage(index, url = 'about:blank') {
    const previous = this.page(index)
    const browserContextId = previous.browserContextId
    await previous.close()
    const { targetId } = await this.connection.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true })
    await this.connection.send('Page.enable', {}, sessionId)
    await this.connection.send('Runtime.enable', {}, sessionId)
    const page = new CdpPage({ connection: this.connection, targetId, sessionId, browserContextId, index })
    this.pages[index] = page
    if (url !== 'about:blank') await page.navigate(url)
    return page
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const page of [...this.pages].reverse()) await page.close()
    for (const browserContextId of [...this.browserContextIds].reverse()) {
      await this.connection.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
    }
    await this.connection.send('Browser.close').catch(() => {})
    await Promise.race([
      new Promise((resolveExit) => {
        if (this.chromeProcess.exitCode != null) resolveExit()
        else this.chromeProcess.once('exit', resolveExit)
      }),
      wait(2_000),
    ])
    if (this.chromeProcess.exitCode == null) this.chromeProcess.kill()
    this.connection.close()
    if (safeTemporaryProfile(this.profileDir)) await rm(this.profileDir, { recursive: true, force: true })
  }
}

export async function launchBrowser({
  chromePath = DEFAULT_CHROME_PATH,
  pageCount = DEFAULT_PAGE_COUNT,
  timeoutMs = DEFAULT_TIMEOUT,
  windowSize = { width: 1440, height: 1000 },
} = {}) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 20) {
    throw new RangeError('pageCount must be an integer from 1 to 20')
  }
  const absoluteChromePath = isAbsolute(chromePath) ? chromePath : resolve(chromePath)
  await access(absoluteChromePath)
  const profileDir = await mkdtemp(join(tmpdir(), 'skazanie-cdp-'))
  const chromeProcess = spawn(absoluteChromePath, [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-sync',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${windowSize.width},${windowSize.height}`,
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })

  let connection
  try {
    const webSocketUrl = await waitForDevToolsFile(profileDir, chromeProcess, timeoutMs)
    connection = new CdpConnection(await connectWebSocket(webSocketUrl, timeoutMs), timeoutMs)
    const pages = []
    const browserContextIds = []
    for (let index = 0; index < pageCount; index += 1) {
      const { browserContextId } = await connection.send('Target.createBrowserContext', { disposeOnDetach: true })
      browserContextIds.push(browserContextId)
      const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank', browserContextId })
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
      await connection.send('Page.enable', {}, sessionId)
      await connection.send('Runtime.enable', {}, sessionId)
      pages.push(new CdpPage({ connection, targetId, sessionId, browserContextId, index }))
    }
    return new CdpBrowser({ chromeProcess, connection, profileDir, pages, browserContextIds })
  } catch (error) {
    connection?.close()
    if (chromeProcess.exitCode == null) chromeProcess.kill()
    if (safeTemporaryProfile(profileDir)) await rm(profileDir, { recursive: true, force: true })
    throw error
  }
}

export async function withBrowser(options, task) {
  const browser = await launchBrowser(options)
  try {
    return await task(browser)
  } finally {
    await browser.close()
  }
}

function help() {
  return `Raw CDP runner for the five-player smoke.

Usage:
  node .agent-tasks/browser.mjs --url http://127.0.0.1:4173/?room=CODE
       [--pages 5] [--screenshots .agent-tasks/screenshots]
  node .agent-tasks/browser.mjs --help

Library:
  import { withBrowser } from './.agent-tasks/browser.mjs'
  await withBrowser({ pageCount: 5 }, async ({ pages }) => {
    await Promise.all(pages.map((page) => page.navigate(url)))
    await pages[0].click('[data-testid="join"]')
    await pages[0].type('input[name="name"]', 'Игрок 1')
    await pages[0].waitForSelector('[data-testid="scene"]')
    await pages[0].screenshot('screenshots/player-1.png')
  })
`
}

function cliOptions(argv) {
  const options = { pages: DEFAULT_PAGE_COUNT, screenshots: '.agent-tasks/screenshots', url: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { ...options, help: true }
    if (argument === '--url') options.url = argv[++index] ?? ''
    else if (argument === '--pages') options.pages = Number(argv[++index])
    else if (argument === '--screenshots') options.screenshots = argv[++index] ?? options.screenshots
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

async function main() {
  const options = cliOptions(process.argv.slice(2))
  if (options.help || !options.url) {
    process.stdout.write(help())
    if (!options.help) process.exitCode = 2
    return
  }
  const screenshotsDir = resolve(options.screenshots)
  const result = await withBrowser({ pageCount: options.pages }, async (browser) => {
    await Promise.all(browser.pages.map((page) => page.navigate(options.url)))
    const pages = []
    for (const page of browser.pages) {
      const screenshot = await page.screenshot(join(screenshotsDir, `player-${page.index + 1}.png`))
      pages.push({ index: page.index, url: await page.evaluate(() => location.href), screenshot })
    }
    return pages
  })
  process.stdout.write(`${JSON.stringify({ ok: true, pages: result }, null, 2)}\n`)
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === executedPath) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
