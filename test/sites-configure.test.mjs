import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../tools/configure-sites-local.mjs', import.meta.url))

test('ошибка ввода настроек Sites не раскрывает даже часть служебного ключа', () => {
  const result = spawnSync(process.execPath, [script], { input: 'private-test-secret\n', encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-test/u)
})

test('настройка Sites сохраняет другие переменные и скрывает ключ в выводе', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-sites-config-'))
  try {
    writeFileSync(join(directory, '.env'), 'OTHER_SETTING=kept\n')
    const key = 'private-test-service-key'
    const result = spawnSync(process.execPath, [script], {
      cwd: directory, input: `${JSON.stringify({ url: 'https://example.chatgpt.site', key })}\n`, encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-test/u)
    const saved = readFileSync(join(directory, '.env'), 'utf8')
    assert.match(saved, /^OTHER_SETTING=kept$/mu)
    assert.match(saved, /^DND_SITES_URL=https:\/\/example\.chatgpt\.site$/mu)
    assert.ok(saved.includes(`DND_SITES_SERVICE_KEY=${key}`))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
