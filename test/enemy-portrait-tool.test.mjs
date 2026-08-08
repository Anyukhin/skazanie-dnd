import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENEMY_PORTRAIT_MIN_BYTES,
  ENEMY_PORTRAIT_SIDE,
  buildEnemyPortraitPrompt,
  enemyPortraitLocation,
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

test('инструмент просит у провайдера PNG тем же серверным путём, что и портреты NPC', async () => {
  let request = null
  const png = noisyPng(64)
  const generator = createRouterImageGenerator({
    baseUrl: 'https://images.example/v1/',
    apiKey: 'fake-key',
    outputFormat: 'png',
    quality: 'medium',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const generated = await generator({ prompt: 'server prompt', model: 'image/model' })
  assert.equal(generated.bytes.equals(png), true)
  assert.equal(request.url, 'https://images.example/v1/images')
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'image/model',
    prompt: 'server prompt',
    n: 1,
    aspect_ratio: '1:1',
    resolution: '1K',
    quality: 'medium',
    output_format: 'png',
  })
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
