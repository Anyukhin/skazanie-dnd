import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('campaign-selectable D&D 2014 preview cannot become the process-wide runtime default', { timeout: 10_000 }, async () => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-ruleset-guard-'))
  let output = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROUTERAI_API_KEY: '',
      DND_STORAGE_DIR: storage,
      DND_DEFAULT_RULESET_ID: 'dnd_5e_2014',
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  const exitCode = await new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
  assert.notEqual(exitCode, 0)
  assert.match(output, /dnd_5e_2014.*process-wide runtime default/u)
})
