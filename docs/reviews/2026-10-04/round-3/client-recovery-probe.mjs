import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const clientSourcePath = join(root, 'src', 'ai-client.ts')
const sessionSourcePath = join(root, 'src', 'useGameSession.ts')
const clientSource = readFileSync(clientSourcePath, 'utf8')
const sessionSource = readFileSync(sessionSourcePath, 'utf8')

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-client-recovery-'))
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const compiled = spawnSync(process.execPath, [
  compiler,
  '--ignoreConfig',
  '--target', 'ES2022',
  '--module', 'ESNext',
  '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM',
  '--strict',
  '--skipLibCheck',
  '--outDir', buildDir,
  clientSourcePath,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const compiledPath = join(buildDir, 'ai-client.mjs')
renameSync(join(buildDir, 'ai-client.js'), compiledPath)
const client = await import(pathToFileURL(compiledPath).href)

const originalFetch = globalThis.fetch
const requests = []
globalThis.fetch = async (_input, init = {}) => {
  requests.push(JSON.parse(String(init.body ?? '{}')))
  return new Response(JSON.stringify({
    narration: 'Серверный результат',
    effects: { roll: null, grantItems: [] },
    turn_consumed: false,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

try {
  // `/api/narrate` получает новый ключ на каждый вызов без явного ключа.
  // Это именно поведение production caller из submitAction: он ключ не передаёт.
  await client.narrateWithAgent({ sessionCode: 'RECOVERY-PROBE' }, 'Открыть дверь', 'Герой')
  await client.narrateWithAgent({ sessionCode: 'RECOVERY-PROBE' }, 'Открыть дверь', 'Герой')
  assert.notEqual(requests[0].idempotency_key, requests[1].idempotency_key)

  // Runtime decoder принимает HTTP 200 с пустым объектом и передаёт его выше.
  // Это доказывает отсутствие decoder, но не доказывает поведение всего hook
  // после исключения в finishTurn или его cleanup/finally path.
  globalThis.fetch = async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  const malformedResult = await client.narrateWithAgent(
    { sessionCode: 'RECOVERY-PROBE' },
    'Осмотреться',
    'Герой',
    undefined,
    'malformed-response-key',
  )
  assert.deepEqual(malformedResult, {})

  const submitStart = sessionSource.indexOf('  const submitAction =')
  const confirmStart = sessionSource.indexOf('  const confirmPendingAction =')
  assert.ok(submitStart >= 0 && confirmStart > submitStart)
  const submitBlock = sessionSource.slice(submitStart, confirmStart)
  assert.match(submitBlock, /narrateWithAgent\(/u)
  assert.doesNotMatch(submitBlock, /rememberPendingTacticalCommand\(/u)

  const switchStart = sessionSource.indexOf('  const switchCampaign =')
  const merchantStart = sessionSource.indexOf('  const loadMerchant =')
  assert.ok(switchStart >= 0 && merchantStart > switchStart)
  const switchBlock = sessionSource.slice(switchStart, merchantStart)
  assert.doesNotMatch(switchBlock, /queuedRooms\.current\s*=\s*\[\]/u)

  // This is a reduced selection model for flushQueuedRooms. It is deliberately
  // not presented as full hook execution: switchCampaign also advances epochs,
  // and only a mounted-hook scenario can prove whether that guard wins before
  // applyRemote.
  const queuedRooms = [{ version: 7, state: { sessionCode: 'A' } }]
  const roomVersion = 1 // freshly loaded B room
  const latest = queuedRooms
    .filter((candidate) => candidate.version > roomVersion)
    .reduce((current, candidate) => (!current || candidate.version >= current.version ? candidate : current), null)
  let appliedCampaign = 'B'
  if (latest) appliedCampaign = latest.state.sessionCode
  assert.equal(appliedCampaign, 'A')

  const rollStart = clientSource.indexOf('export async function rollDice')
  const rollEnd = clientSource.indexOf('export async function rollSharedDie')
  assert.ok(rollStart >= 0 && rollEnd > rollStart)
  const rollBlock = clientSource.slice(rollStart, rollEnd)
  assert.match(rollBlock, /fetch\('\/api\/roll'/u)
  assert.doesNotMatch(rollBlock, /fetchWithTimeout\(/u)

  process.stdout.write(JSON.stringify({
    ok: true,
    scenarios: {
      narrate_without_explicit_key: {
        first_key_present: Boolean(requests[0].idempotency_key),
        second_key_present: Boolean(requests[1].idempotency_key),
        keys_equal: requests[0].idempotency_key === requests[1].idempotency_key,
      },
      malformed_200_decoder_acceptance: {
        decoder_rejected: false,
        payload_keys: Object.keys(malformedResult),
        busy_lock_proven: false,
      },
      queued_snapshot_selection_model: {
        selected_campaign: appliedCampaign,
        current_campaign: 'B',
        hook_execution_proven: false,
      },
      skill_roll_transport_timeout: { uses_fetch_with_timeout: false },
    },
  }, null, 2) + '\n')
} finally {
  globalThis.fetch = originalFetch
  rmSync(buildDir, { recursive: true, force: true })
}
