import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ENEMY_PORTRAIT_MIN_BYTES,
  ENEMY_PORTRAIT_SIDE,
  buildEnemyPortraitPrompt,
  enemyPortraitLocation,
  generateEnemyPortrait,
  normalizeEnemyId,
  parseEnemyPortraitArgs,
  toEnemyPortraitPng,
} from '../tools/generate-enemy-portrait.mjs'
import { decodePng, encodePng } from '../tools/png-codec.mjs'
import { createRouterImageGenerator } from '../server/image-generation.mjs'

/**
 * Шумной картинке нужен настоящий шум: заливка сжимается в сотню байт, и
 * порог веса на ней не проверить.
 */
function noisyPng(side, { flat = false } = {}) {
  const data = new Uint8Array(side * side * 4)
  let seed = 0x2545f491
  for (let index = 0; index < side * side; index += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
    const at = index * 4
    data[at] = flat ? 40 : seed & 0xff
    data[at + 1] = flat ? 40 : (seed >>> 8) & 0xff
    data[at + 2] = flat ? 40 : (seed >>> 16) & 0xff
    data[at + 3] = 255
  }
  return encodePng({ width: side, height: side, data })
}

test('идентификатор врага — безопасный сегмент пути, всё остальное отвергается', () => {
  assert.equal(normalizeEnemyId('Ogre-Zombie'), 'ogre-zombie')
  assert.equal(normalizeEnemyId(' wave2-probe '), 'wave2-probe')
  for (const bad of ['', '../secret', 'огр', 'ogre zombie', 'ogre.png', '-ogre', 'ogre-', 'a'.repeat(81)]) {
    assert.throws(() => normalizeEnemyId(bad), (error) => error.code === 'ENEMY_ID_INVALID', `принят «${bad}»`)
  }
})

test('разбор аргументов требует id и содержательное описание, флаги читаются отдельно', () => {
  const parsed = parseEnemyPortraitArgs(['--id', 'ogre-zombie', '--description', '  огр-зомби  с  дырой в груди ', '--force'])
  assert.deepEqual(parsed, {
    id: 'ogre-zombie',
    description: 'огр-зомби с дырой в груди',
    force: true,
    dryRun: false,
  })
  assert.equal(parseEnemyPortraitArgs(['--id', 'lich', '--description', 'иссохший лич в короне', '--dry-run']).dryRun, true)
  assert.throws(
    () => parseEnemyPortraitArgs(['--description', 'иссохший лич в короне']),
    (error) => error.code === 'ENEMY_ID_INVALID',
  )
  // Пустое `--description` без значения не должно проскочить как флаг.
  assert.throws(
    () => parseEnemyPortraitArgs(['--id', 'lich', '--description', '--force']),
    (error) => error.code === 'ENEMY_DESCRIPTION_REQUIRED',
  )
  assert.throws(
    () => parseEnemyPortraitArgs(['--id', 'lich', '--description', 'лич']),
    (error) => error.code === 'ENEMY_DESCRIPTION_REQUIRED',
  )
})

test('промпт несёт визуальный контракт набора и описание, но не выдумывает стат-блок', () => {
  const prompt = buildEnemyPortraitPrompt('ogre-zombie', 'огр-зомби с провалившейся грудной клеткой')
  assert.match(prompt, /square tabletop battlemap enemy token portrait/u)
  assert.match(prompt, /legible at 64px/u)
  assert.match(prompt, /огр-зомби с провалившейся грудной клеткой/u)
  assert.doesNotMatch(prompt, /hit points|challenge rating|armor class/iu)
})

test('путь портрета выводится из id и совпадает с полем image стат-блока', () => {
  assert.deepEqual(
    { assetPath: enemyPortraitLocation('ogre-zombie').assetPath, imageField: enemyPortraitLocation('ogre-zombie').imageField },
    { assetPath: 'enemies/ogre-zombie.png', imageField: '/assets/enemies/ogre-zombie.png' },
  )
})

test('ответ модели приводится к 512×512 PNG, а подозрительно лёгкий файл отвергается', () => {
  const large = toEnemyPortraitPng(noisyPng(1_024))
  assert.deepEqual(
    { width: decodePng(large).width, height: decodePng(large).height },
    { width: ENEMY_PORTRAIT_SIDE, height: ENEMY_PORTRAIT_SIDE },
  )
  assert.ok(large.length >= ENEMY_PORTRAIT_MIN_BYTES, `портрет весит ${large.length} Б`)

  // Ровно 512 проходит без пересэмплирования.
  const exact = toEnemyPortraitPng(noisyPng(ENEMY_PORTRAIT_SIDE))
  assert.equal(decodePng(exact).width, ENEMY_PORTRAIT_SIDE)

  assert.throws(
    () => toEnemyPortraitPng(noisyPng(512, { flat: true })),
    (error) => error.code === 'ENEMY_PORTRAIT_TOO_SMALL',
  )
  assert.throws(
    () => toEnemyPortraitPng(Buffer.from('RIFF____WEBP', 'ascii')),
    (error) => error.code === 'PNG_NOT_A_PNG',
  )
})

test('не квадрат от модели отвергается до записи файла', () => {
  const data = new Uint8Array(64 * 32 * 4).fill(255)
  assert.throws(
    () => toEnemyPortraitPng(encodePng({ width: 64, height: 32, data })),
    (error) => error.code === 'ENEMY_PORTRAIT_NOT_SQUARE',
  )
})

/**
 * Временный набор: свой корень `public/assets` и свой реестр прав. Иначе
 * оркестрацию можно проверить только настоящим походом к модели и записью в
 * репозиторий, то есть никак.
 */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-enemy-portrait-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registryFile = join(root, 'asset-rights.json')
  writeFileSync(registryFile, '{\n  "rights_status": "test",\n  "assets": [\n\n  ]\n}\n', 'utf8')
  return { assetsRoot: join(root, 'assets'), registryFile }
}

function respondWith(png, requests) {
  return async (/** @type {string} */ url, /** @type {any} */ options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers })
    return new Response(JSON.stringify({
      data: [{ b64_json: png.toString('base64') }],
      usage: { total_tokens: 12, cost: 0.07 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

test('запрос к провайдеру собирает сам инструмент: png, 1K, среднее качество', async (t) => {
  const { assetsRoot, registryFile } = sandbox(t)
  const requests = []
  const result = await generateEnemyPortrait({
    id: 'wave2-probe',
    description: 'пробный страж с каменным щитом',
    model: 'image/model',
    apiKey: 'fake-key',
    baseUrl: 'https://images.example/v1/',
    assetsRoot,
    registryFile,
    fetchImpl: respondWith(noisyPng(1_024), requests),
  })

  // Ассерты на то, что попросил код инструмента, а не тест: подмена
  // output_format, resolution или quality в `generateEnemyPortrait` обязана
  // ронять эту проверку.
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example/v1/images')
  assert.equal(requests[0].headers.Authorization, 'Bearer fake-key')
  assert.deepEqual(requests[0].body, {
    model: 'image/model',
    prompt: buildEnemyPortraitPrompt('wave2-probe', 'пробный страж с каменным щитом'),
    n: 1,
    aspect_ratio: '1:1',
    resolution: '1K',
    quality: 'medium',
    output_format: 'png',
  })

  // Файл лёг туда, куда указывает `enemyPortraitLocation`, и приведён к
  // контракту набора.
  const location = enemyPortraitLocation('wave2-probe', { assetsRoot })
  assert.equal(result.filePath, location.filePath)
  assert.equal(result.imageField, '/assets/enemies/wave2-probe.png')
  const written = readFileSync(location.filePath)
  assert.deepEqual(
    [decodePng(written).width, decodePng(written).height],
    [ENEMY_PORTRAIT_SIDE, ENEMY_PORTRAIT_SIDE],
  )
  assert.equal(result.bytes, written.length)
  assert.equal(result.cost, 0.07)

  // Права зарегистрированы честным хешем того файла, что лежит на диске.
  assert.deepEqual(result.rights, { added: ['enemies/wave2-probe.png'], updated: [], unchanged: [] })
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
  assert.deepEqual(registry.assets, [[
    'enemies/wave2-probe.png',
    createHash('sha256').update(written).digest('hex'),
    statSync(location.filePath).size,
  ]])
})

test('готовый портрет не перерисовывается без --force, а с ним перекрывается', async (t) => {
  const { assetsRoot, registryFile } = sandbox(t)
  const first = []
  await generateEnemyPortrait({
    id: 'wave2-probe', description: 'пробный страж с каменным щитом',
    apiKey: 'fake-key', baseUrl: 'https://images.example/v1', assetsRoot, registryFile,
    fetchImpl: respondWith(noisyPng(512), first),
  })
  const before = readFileSync(enemyPortraitLocation('wave2-probe', { assetsRoot }).filePath)

  const refused = []
  await assert.rejects(
    generateEnemyPortrait({
      id: 'wave2-probe', description: 'пробный страж с каменным щитом',
      apiKey: 'fake-key', baseUrl: 'https://images.example/v1', assetsRoot, registryFile,
      fetchImpl: respondWith(noisyPng(512), refused),
    }),
    (error) => error.code === 'ENEMY_PORTRAIT_EXISTS',
  )
  assert.deepEqual(refused, [], 'отказ случился до обращения к модели: за отказ не платят')

  const forced = []
  await generateEnemyPortrait({
    id: 'wave2-probe', description: 'пробный страж, но иначе',
    force: true,
    apiKey: 'fake-key', baseUrl: 'https://images.example/v1', assetsRoot, registryFile,
    fetchImpl: respondWith(noisyPng(1_024), forced),
  })
  assert.equal(forced.length, 1)
  const after = readFileSync(enemyPortraitLocation('wave2-probe', { assetsRoot }).filePath)
  assert.equal(after.equals(before), false, 'перерисовка обязана перекрыть файл')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
  assert.equal(registry.assets.length, 1, 'запись обновляется, а не дублируется')
  assert.equal(registry.assets[0][1], createHash('sha256').update(after).digest('hex'))
})

test('без ключа провайдера инструмент отказывается до записи файла', async (t) => {
  const { assetsRoot, registryFile } = sandbox(t)
  await assert.rejects(
    generateEnemyPortrait({
      id: 'wave2-probe', description: 'пробный страж с каменным щитом',
      apiKey: '', baseUrl: 'https://images.example/v1', assetsRoot, registryFile,
    }),
    (error) => error.code === 'IMAGE_GENERATOR_UNAVAILABLE',
  )
  assert.equal(readFileSync(registryFile, 'utf8').includes('enemies/'), false)
})

test('брак модели не доходит до набора: файл не пишется, права не регистрируются', async (t) => {
  const { assetsRoot, registryFile } = sandbox(t)
  await assert.rejects(
    generateEnemyPortrait({
      id: 'wave2-probe', description: 'пробный страж с каменным щитом',
      apiKey: 'fake-key', baseUrl: 'https://images.example/v1', assetsRoot, registryFile,
      fetchImpl: respondWith(noisyPng(512, { flat: true }), []),
    }),
    (error) => error.code === 'ENEMY_PORTRAIT_TOO_SMALL',
  )
  assert.equal(readFileSync(registryFile, 'utf8').includes('enemies/'), false)
})

test('webp вместо png отвергается по сигнатуре, а не по слову провайдера', async () => {
  const generator = createRouterImageGenerator({
    baseUrl: 'https://images.example/v1',
    apiKey: 'fake-key',
    outputFormat: 'png',
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from('524946460400000057454250', 'hex').toString('base64') }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  await assert.rejects(generator({ prompt: 'p', model: 'm' }), /неподдерживаемого формата/u)
})
