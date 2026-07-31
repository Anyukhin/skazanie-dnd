import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const sessionSource = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const clientSource = readFileSync(new URL('../src/ai-client.ts', import.meta.url), 'utf8')

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-conflict-ux-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const clientPath = fileURLToPath(new URL('../src/ai-client.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, clientPath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const compiledPath = join(buildDir, 'ai-client.mjs')
renameSync(join(buildDir, 'ai-client.js'), compiledPath)
const client = await import(pathToFileURL(compiledPath).href)

test.after(() => rmSync(buildDir, { recursive: true, force: true }))

test('API error сохраняет HTTP-статус и серверный code рассказчика', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'сырая серверная формулировка',
    code: 'STATE_VERSION_CONFLICT',
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  })
  try {
    await assert.rejects(
      () => client.narrateWithAgent({ sessionCode: 'RACE' }, 'Открыть дверь', 'Герой', undefined, 'race-key', 'hero'),
      (error) => {
        assert.ok(error instanceof client.ApiRequestError)
        assert.equal(error.status, 409)
        assert.equal(error.code, 'STATE_VERSION_CONFLICT')
        assert.equal(client.isStateVersionConflictError(error), true)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('любой другой 409 не выдаётся за конфликт версии', () => {
  const activeCombat = new client.ApiRequestError('Сначала завершите бой', 409, 'COMBAT_ACTIVE')
  const idempotency = new client.ApiRequestError('Ключ уже использован', 409, 'IDEMPOTENCY_CONFLICT')
  assert.equal(client.isStateVersionConflictError(activeCombat), false)
  assert.equal(client.isStateVersionConflictError(idempotency), false)
})

test('хук обновляет авторитетное состояние и заменяет сырой конфликт понятным текстом', () => {
  assert.match(sessionSource, /if \(!isStateVersionConflictError\(error\)\)/u)
  assert.match(sessionSource, /await refreshFullRoom\(true\)/u)
  assert.match(sessionSource, /Другой игрок уже изменил состояние кампании/u)
  assert.match(sessionSource, /Состояние обновлено — проверьте изменения и повторите действие/u)
  assert.doesNotMatch(sessionSource, /response\.status === 409/u)
})

test('свободный и подготовленный ввод очищаются только после успешной команды', () => {
  assert.match(appSource, /const outcome = await onFreeAction\(text\)\s+if \(outcome\.ok\) updateFreeText\(''\)/u)
  assert.match(appSource, /const outcome = await confirmPreparedCommand\(text \|\| undefined\)\s+if \(outcome\?\.ok\) updateFreeText\(''\)/u)
  assert.match(appSource, /if \(outcome\?\.ok\) setPendingCommand\(null\)/u)
  assert.match(appSource, /const outcome = await confirmSelfCast\(text \|\| undefined\)\s+if \(outcome\?\.ok\) updateFreeText\(''\)/u)
  assert.match(appSource, /if \(outcome\?\.ok\) setCombatMode\('weapon'\)/u)
  assert.doesNotMatch(appSource, /onFreeAction\(text\)\s+updateFreeText\(''\)/u)
})

test('проверка и выбранный маршрут остаются доступны после отказа', () => {
  assert.match(sessionSource, /pendingCheck: \{ \.\.\.check, status: 'ready' \}/u)
  assert.match(appSource, /onMove\(selected, cell\.x, cell\.y\)\.then\(\(outcome\) => \{\s+if \(outcome\.ok\) setPendingMoveKey\(null\)/u)
})
