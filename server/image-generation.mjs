// @ts-check
/**
 * Единственный путь к картиночной модели провайдера.
 *
 * Раньше контракт запроса жил внутри `npc-portraits.mjs`, и всякий, кому нужна
 * была картинка другого формата, обязан был написать свой `fetch` — то есть
 * второй авторитетный путь к той же модели. Здесь он один: адрес, заголовки,
 * тайм-аут, разбор ответа и проверка формата.
 *
 * Формат проверяется по сигнатуре файла, а не по слову провайдера: `webp` в
 * поле `output_format` — это просьба, а не гарантия, и подсунутый вместо
 * картинки HTML или JSON должен отсекаться до записи на диск.
 */

/** Потолок одного изображения. Восемь мегабайт — это уже не портрет, а ошибка. */
export const IMAGE_GENERATION_MAX_BYTES = 8 * 1024 * 1024

/**
 * @param {Buffer} bytes
 * @returns {boolean}
 */
export function isWebp(bytes) {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

/**
 * @param {Buffer} bytes
 * @returns {boolean}
 */
export function isPng(bytes) {
  return bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

/** @type {Record<string, {contentType: string, matches: (bytes: Buffer) => boolean}>} */
const IMAGE_FORMATS = {
  webp: { contentType: 'image/webp', matches: isWebp },
  png: { contentType: 'image/png', matches: isPng },
}

/**
 * @typedef {{bytes: Buffer, usage?: Record<string, unknown>}} GeneratedImage
 */

/**
 * @typedef {{
 *   fetchImpl?: typeof fetch,
 *   baseUrl: string,
 *   apiKey: string,
 *   timeoutMs?: number,
 *   outputFormat?: 'webp' | 'png',
 *   aspectRatio?: string,
 *   resolution?: string,
 *   quality?: string,
 *   maxBytes?: number,
 * }} RouterImageGeneratorOptions
 */

/**
 * Клиент `POST {baseUrl}/images`. Возвращает функцию генерации, чтобы вызывающий
 * модуль оставался тестируемым без сети: в тестах вместо неё подставляется своя.
 *
 * @param {RouterImageGeneratorOptions} options
 * @returns {(input: {prompt: string, model: string}) => Promise<GeneratedImage>}
 */
export function createRouterImageGenerator({
  fetchImpl = fetch,
  baseUrl,
  apiKey,
  timeoutMs = 120_000,
  outputFormat = 'webp',
  aspectRatio = '1:1',
  resolution = '1K',
  quality = 'low',
  maxBytes = IMAGE_GENERATION_MAX_BYTES,
}) {
  const format = IMAGE_FORMATS[outputFormat]
  if (!format) throw new Error(`Неизвестный формат изображения: ${outputFormat}`)
  const endpoint = `${String(baseUrl || '').replace(/\/+$/u, '')}/images`
  return async ({ prompt, model }) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        aspect_ratio: aspectRatio,
        resolution,
        quality,
        output_format: outputFormat,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Генератор изображений ответил ${response.status}`)
    const payload = /** @type {any} */ (await response.json())
    const encoded = typeof payload?.data?.[0]?.b64_json === 'string' ? payload.data[0].b64_json : ''
    if (!encoded || encoded.length > Math.ceil(maxBytes * 4 / 3) + 16) {
      throw new Error('Генератор изображений вернул некорректный размер')
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (!format.matches(bytes) || bytes.length > maxBytes) {
      throw new Error('Генератор изображений вернул файл неподдерживаемого формата')
    }
    const providerUsage = payload?.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
      ? payload.usage
      : {}
    const providerCost = payload?.cost ?? providerUsage.cost ?? providerUsage.total_cost
    return {
      bytes,
      usage: {
        ...providerUsage,
        ...(providerCost == null ? {} : { cost: providerCost }),
      },
    }
  }
}
