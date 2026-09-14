import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { buildNarrationBrief } from '../server/security.mjs'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const RUNNER_URL = pathToFileURL(fileURLToPath(new URL('../eval/routerai-narrator-benchmark.mjs', import.meta.url))).href

function makeFixtures(modelIds) {
  const directory = mkdtempSync(join(tmpdir(), 'narrator-benchmark-runner-'))
  const brief = buildNarrationBrief({
    visible_events: [],
    visible_state_changes: [],
    known_environment: {
      scene: { title: 'Тест', location: 'Тест', mood: 'Тихо', objective: 'Проверить runner' },
      story_context: { heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }], present_npcs: [], open_promises: [], recent_interactions: [] },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
  const files = {
    directory,
    output: join(directory, 'report.json'),
    requests: join(directory, 'requests.json'),
    catalog: join(directory, 'catalog.json'),
    cases: join(directory, 'cases.json'),
    addendum: join(directory, 'addendum.txt'),
  }
  writeFileSync(files.catalog, JSON.stringify({
    data: modelIds.map(id => ({ id, pricing: { prompt: 0.000001, completion: 0.000001 } })),
  }))
  writeFileSync(files.cases, JSON.stringify([{ id: 'runner-case', brief, expected: 'Тест' }]))
  writeFileSync(files.addendum, '')
  return files
}

function runRunner(files, {
  modelIds,
  repeats = 1,
  reasoning = {},
  fail = false,
  maxCalls = 20,
  budgetRub = 30,
} = {}) {
  const runnerArgs = [
    '--live',
    '--output', files.output,
    '--catalog', files.catalog,
    '--case-file', files.cases,
    '--addendum', files.addendum,
    '--profiles', 'common',
    '--models', modelIds.join(','),
    '--repeats', String(repeats),
    '--reasoning', JSON.stringify(reasoning),
    '--max-calls', String(maxCalls),
    '--timeout-ms', '1000',
    '--budget-rub', String(budgetRub),
  ]
  const childSource = `
import { writeFileSync } from 'node:fs'

const requests = []
const recordPath = ${JSON.stringify(files.requests)}
const shouldFail = ${JSON.stringify(fail)}
const newline = String.fromCharCode(10)
const frame = payload => ['data: ', JSON.stringify(payload), newline, newline].join('')

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({ url, body })
  if (shouldFail) throw new Error('test connection failure')
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(frame({ model: body.model, choices: [{ delta: { content: 'Пока ничего не меняется.' } }] }))
        yield Buffer.from(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }))
        yield Buffer.from(['data: [DONE]', newline, newline].join(''))
      },
    },
  }
}

process.on('exit', () => writeFileSync(recordPath, JSON.stringify(requests)))
process.argv = [process.argv[0], 'routerai-narrator-benchmark.mjs', ...${JSON.stringify(runnerArgs)}]
await import(${JSON.stringify(RUNNER_URL)})
`
  return spawnSync(process.execPath, [
    '--input-type=module', '--eval', childSource,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      ROUTERAI_API_KEY: 'test-only-key',
      ROUTERAI_BASE_URL: 'https://routerai.ru/api/v1',
      DND_STORAGE_DIR: files.directory,
    },
  })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, `runner завершился с ошибкой:\n${result.stderr || result.stdout}`)
}

test('runner повторяет пары и передаёт reasoning в каждый запрос', () => {
  const files = makeFixtures(['test/model'])
  try {
    const result = runRunner(files, { modelIds: ['test/model'], repeats: 2, reasoning: { 'test/model': { effort: 'high' } } })
    assertSucceeded(result)

    const report = readJson(files.output)
    assert.deepEqual(report.samples.map(sample => sample.repeat), [1, 2])
    const requests = readJson(files.requests)
    assert.equal(requests.length, 2)
    assert.deepEqual(requests.map(request => request.body.reasoning), [{ effort: 'high' }, { effort: 'high' }])
  } finally {
    rmSync(files.directory, { recursive: true, force: true })
  }
})

test('runner сообщает о превышении бюджета до provider-вызова', () => {
  const files = makeFixtures(['test/model'])
  try {
    const result = runRunner(files, { modelIds: ['test/model'], budgetRub: 0.000001 })
    assert.notEqual(result.status, 0)
    const message = `${result.stdout}\n${result.stderr}`
    assert.match(message, /Достигнут оценочный лимит/u)
    assert.doesNotMatch(message, /Narrator не вызвал модель/u)
    assert.deepEqual(readJson(files.requests), [])
  } finally {
    rmSync(files.directory, { recursive: true, force: true })
  }
})

test('runner при возобновлении пропускает уже сохранённые пары', () => {
  const files = makeFixtures(['test/model'])
  try {
    const first = runRunner(files, { modelIds: ['test/model'], repeats: 2 })
    assertSucceeded(first)
    assert.equal(readJson(files.requests).length, 2)

    const resumed = runRunner(files, { modelIds: ['test/model'], repeats: 2 })
    assertSucceeded(resumed)
    assert.deepEqual(readJson(files.requests), [])
    assert.equal(readJson(files.output).samples.length, 2)
  } finally {
    rmSync(files.directory, { recursive: true, force: true })
  }
})

test('runner останавливает серию после трёх ошибок соединения', () => {
  const modelIds = ['test/model-a', 'test/model-b', 'test/model-c', 'test/model-d']
  const files = makeFixtures(modelIds)
  try {
    const result = runRunner(files, { modelIds, fail: true, maxCalls: 10 })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /Три ошибки доступа или соединения подряд/u)

    const report = readJson(files.output)
    assert.equal(report.samples.length, 3)
    assert.ok(report.samples.every(sample => sample.error_code === 'LLM_PROVIDER_UNAVAILABLE'))
    assert.equal(readJson(files.requests).length, 3)
  } finally {
    rmSync(files.directory, { recursive: true, force: true })
  }
})
