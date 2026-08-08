#!/usr/bin/env node
// @ts-check
/**
 * Портрет врага для бестиария — задача II.1 плана `docs/experience-upgrade-plan-2.md`.
 *
 * Зачем инструмент. Расширять `SRD_5_2_1_MONSTER_ALLOWLIST` нельзя без картинки:
 * сторож `test/srd-creature-expansion.test.mjs` требует у каждой записи
 * собственный PNG 512×512 не легче 20 КБ в `public/assets/enemies/`, без
 * повторов по имени файла и по содержимому. Раньше портреты рисовались вручную
 * встроенным ImageGen, и добавление монстра упиралось в человека.
 *
 * Что здесь есть и чего нет. Инструмент **только** делает файл и регистрирует
 * его хеш. Он не трогает ни allowlist, ни темы ассемблера: стат-блок с
 * провенансом — отдельная работа, и подставлять её генерацией картинки нельзя.
 *
 * Почему это `tools/`, а не подготовка ассетов. Портреты врагов — часть
 * репозитория, а не кампании: они лежат в `public/assets`, попадают в реестр
 * прав и одинаковы у всех столов. Подготовка ассетов готовит картинки
 * **кампании** в `storage/generated`. Смешивать эти два хранилища нельзя.
 *
 * Модель зовётся тем же серверным путём, что и портреты NPC
 * (`server/image-generation.mjs`), только просит `png`: `webp` в Node без
 * зависимостей не разобрать, а привести к 512 надо обязательно — модель отдаёт
 * 1024. Уменьшение и запись — своим PNG-кодеком (`tools/png-codec.mjs`).
 *
 * Запуск:
 *   node tools/generate-enemy-portrait.mjs --id ogre-zombie \
 *     --description "огр-зомби с провалившейся грудной клеткой"
 *   node tools/generate-enemy-portrait.mjs --id ogre-zombie --description "…" --force
 */
import 'dotenv/config'

import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { createRouterImageGenerator } from '../server/image-generation.mjs'
import { decodePng, encodePng } from './png-codec.mjs'
import { resampleImage } from './build-prop-atlas.mjs'
import { registerAssets } from './register-asset-rights.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Каталог портретов врагов внутри `public/assets`. */
export const ENEMY_PORTRAIT_DIRECTORY = 'enemies'

/** Сторона готового портрета: визуальный контракт `docs/enemy-art-pipeline.md`. */
export const ENEMY_PORTRAIT_SIDE = 512

/**
 * Нижняя граница веса файла. Её проверяет сторож бестиария, и проверить её
 * здесь — значит узнать о плоской заливке до коммита, а не на прогоне тестов.
 */
export const ENEMY_PORTRAIT_MIN_BYTES = 20_000

/**
 * Общая основа промпта. Слово в слово повторяет визуальный контракт из
 * `docs/enemy-art-pipeline.md`: набор должен остаться одним набором, а не
 * распасться на «до инструмента» и «после».
 */
export const ENEMY_PORTRAIT_STYLE = [
  'Use case: stylized-concept',
  'Asset type: square tabletop battlemap enemy token portrait for a dark-fantasy game UI',
  'Style/medium: premium hand-painted dark fantasy game illustration, grounded materials, subtle ink-and-gouache texture, original design',
  'Composition/framing: centered subject, strong readable silhouette, all important features inside a circular-safe center crop, generous edge padding, square composition, no border',
  'Lighting/mood: restrained warm or cold rim light over deep shadows, high local contrast that remains legible at 64px',
  'Constraints: exactly one creature; no text, letters, numbers, logo, UI frame, watermark, blood, gore or extra limbs; quiet dark background',
  'Avoid: copyrighted character likeness, comedy, anime, chibi, bright cartoon colors, branded iconography, busy scenery',
].join('\n')

export class EnemyPortraitError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'EnemyPortraitError'
    this.code = code
  }
}

/**
 * Имя файла обязано быть безопасным сегментом пути: оно попадает и в реестр
 * прав, и в поле `image` стат-блока, и в URL. Точки, слэши и кириллица здесь
 * означают опечатку, а не экзотический вид.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEnemyId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/u.test(id)) {
    throw new EnemyPortraitError(
      'Идентификатор врага — латиница, цифры и дефис, от 1 до 80 символов (например ogre-zombie)',
      'ENEMY_ID_INVALID',
    )
  }
  return id
}

/**
 * Разбор аргументов отделён от исполнения, чтобы отказ по неверному вводу
 * проверялся без единого обращения к модели.
 *
 * @param {string[]} argv
 * @returns {{id: string, description: string, force: boolean, dryRun: boolean}}
 */
export function parseEnemyPortraitArgs(argv) {
  const values = Array.isArray(argv) ? argv : []
  const option = (/** @type {string} */ name) => {
    const at = values.indexOf(name)
    return at >= 0 && at + 1 < values.length && !values[at + 1].startsWith('--') ? values[at + 1] : ''
  }
  const id = normalizeEnemyId(option('--id'))
  const description = String(option('--description') ?? '').replace(/\s+/gu, ' ').trim().slice(0, 600)
  if (description.length < 8) {
    throw new EnemyPortraitError(
      'Нужно русское описание внешности врага: --description "огр-зомби с провалившейся грудной клеткой"',
      'ENEMY_DESCRIPTION_REQUIRED',
    )
  }
  return { id, description, force: values.includes('--force'), dryRun: values.includes('--dry-run') }
}

/**
 * @param {string} id
 * @param {string} description
 * @returns {string}
 */
export function buildEnemyPortraitPrompt(id, description) {
  return [
    ENEMY_PORTRAIT_STYLE,
    `Subject (${id}): ${description}`,
    'Отрисуй именно это существо, описание дано на русском языке. Никакого текста на изображении.',
  ].join('\n')
}

/**
 * Приведение ответа модели к контракту набора: PNG, ровно 512×512, не легче
 * 20 КБ. Проверка веса стоит после записи в PNG, а не до неё: весит именно тот
 * файл, который ляжет в репозиторий.
 *
 * @param {Buffer} bytes
 * @param {{side?: number, minBytes?: number}} [options]
 * @returns {Buffer}
 */
export function toEnemyPortraitPng(bytes, { side = ENEMY_PORTRAIT_SIDE, minBytes = ENEMY_PORTRAIT_MIN_BYTES } = {}) {
  const source = decodePng(bytes)
  if (source.width !== source.height) {
    throw new EnemyPortraitError(`Модель вернула не квадрат: ${source.width}×${source.height}`, 'ENEMY_PORTRAIT_NOT_SQUARE')
  }
  const square = source.width === side ? source : resampleImage(source, side, side)
  const encoded = encodePng(square)
  if (encoded.length < minBytes) {
    throw new EnemyPortraitError(
      `Портрет весит ${encoded.length} Б при минимуме ${minBytes} Б: похоже, модель отдала заливку, а не иллюстрацию`,
      'ENEMY_PORTRAIT_TOO_SMALL',
    )
  }
  return encoded
}

/**
 * @param {string} id
 * @returns {{assetPath: string, filePath: string, imageField: string}}
 */
export function enemyPortraitLocation(id) {
  const assetPath = `${ENEMY_PORTRAIT_DIRECTORY}/${id}.png`
  return {
    assetPath,
    filePath: join(ROOT, 'public/assets', assetPath),
    imageField: `/assets/${assetPath}`,
  }
}

/**
 * @param {{
 *   id: string,
 *   description: string,
 *   force?: boolean,
 *   generator?: (input: {prompt: string, model: string}) => Promise<{bytes: Buffer, usage?: Record<string, unknown>}>,
 *   model?: string,
 *   apiKey?: string,
 *   baseUrl?: string,
 * }} input
 */
export async function generateEnemyPortrait({
  id,
  description,
  force = false,
  generator,
  model = process.env.DND_IMAGE_MODEL || 'openai/gpt-image-1',
  apiKey = process.env.ROUTERAI_API_KEY || '',
  baseUrl = process.env.ROUTERAI_BASE_URL || '',
}) {
  const location = enemyPortraitLocation(id)
  if (!force && existsSync(location.filePath)) {
    throw new EnemyPortraitError(`Портрет уже есть: ${location.assetPath}. Перерисовать — с --force`, 'ENEMY_PORTRAIT_EXISTS')
  }
  const generate = generator ?? (() => {
    if (!apiKey || !baseUrl) throw new EnemyPortraitError('Нет ROUTERAI_API_KEY или ROUTERAI_BASE_URL в .env', 'IMAGE_GENERATOR_UNAVAILABLE')
    // Просим 1K и уменьшаем сами: модель без запаса по разрешению теряет
    // читаемость силуэта, ради которой контракт и написан.
    return createRouterImageGenerator({ apiKey, baseUrl, outputFormat: 'png', resolution: '1K', quality: 'medium' })
  })()
  const prompt = buildEnemyPortraitPrompt(id, description)
  const generated = await generate({ prompt, model })
  const png = toEnemyPortraitPng(generated.bytes)
  writeFileSync(location.filePath, png)
  const rights = registerAssets([location.assetPath])
  return {
    ...location,
    bytes: png.length,
    model,
    cost: generated.usage?.cost ?? null,
    rights,
  }
}

if (process.argv[1] && process.argv[1].endsWith('generate-enemy-portrait.mjs')) {
  try {
    const args = parseEnemyPortraitArgs(process.argv.slice(2))
    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        dry_run: true,
        ...enemyPortraitLocation(args.id),
        prompt: buildEnemyPortraitPrompt(args.id, args.description),
      }, null, 2)}\n`)
    } else {
      const result = await generateEnemyPortrait(args)
      process.stdout.write(`${JSON.stringify({
        ok: true,
        ...result,
        next: `указать image: '${result.imageField}' в SRD_5_2_1_MONSTER_ALLOWLIST и прогнать node --test test/srd-creature-expansion.test.mjs`,
      }, null, 2)}\n`)
    }
  } catch (error) {
    const code = error instanceof EnemyPortraitError ? error.code : 'ENEMY_PORTRAIT_FAILED'
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}
