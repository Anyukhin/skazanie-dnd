// @ts-check
/**
 * Чтение и запись PNG на стандартной библиотеке.
 *
 * Новых зависимостей в проекте не заводим (`AGENTS.md` §1), а нарезать листы
 * штампов без доступа к пикселям нельзя. PNG для этого — самый дешёвый формат:
 * сжатие у него `zlib`, который в Node уже есть, а всё остальное — заголовок,
 * контрольная сумма и построчный фильтр.
 *
 * Поддерживается ровно то, что встречается в исходных листах и в атласе:
 * глубина 8 бит, без чересстрочности. Всё прочее отвергается с внятной
 * ошибкой, а не читается наполовину.
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Каналов на пиксель по типу цвета PNG. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export class PngError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'PngError'
    this.code = code
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * Предсказание Paeth: одинаково нужно и при чтении, и при записи.
 * @param {number} left
 * @param {number} up
 * @param {number} upLeft
 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const distanceLeft = Math.abs(estimate - left)
  const distanceUp = Math.abs(estimate - up)
  const distanceCorner = Math.abs(estimate - upLeft)
  if (distanceLeft <= distanceUp && distanceLeft <= distanceCorner) return left
  return distanceUp <= distanceCorner ? up : upLeft
}

/**
 * @typedef {object} PngImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data RGBA, четыре байта на пиксель
 */

/**
 * @param {Buffer} buffer
 * @returns {PngImage}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('Файл не начинается сигнатурой PNG', 'PNG_NOT_A_PNG')
  }
  let offset = 8
  let header = null
  /** @type {Buffer[]} */
  const dataChunks = []
  /** @type {Buffer|null} */
  let palette = null
  /** @type {Buffer|null} */
  let paletteAlpha = null
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (offset + 12 + length > buffer.length) throw new PngError('Обрыв в середине блока PNG', 'PNG_TRUNCATED')
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    } else if (type === 'PLTE') palette = Buffer.from(body)
    else if (type === 'tRNS') paletteAlpha = Buffer.from(body)
    else if (type === 'IDAT') dataChunks.push(Buffer.from(body))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!header) throw new PngError('В файле нет заголовка IHDR', 'PNG_NO_HEADER')
  if (header.depth !== 8) throw new PngError(`Поддерживается только глубина 8 бит, у файла ${header.depth}`, 'PNG_DEPTH_UNSUPPORTED')
  if (header.interlace !== 0) throw new PngError('Чересстрочный PNG не поддерживается', 'PNG_INTERLACE_UNSUPPORTED')
  const channels = CHANNELS[/** @type {keyof typeof CHANNELS} */ (header.colorType)]
  if (!channels) throw new PngError(`Неизвестный тип цвета: ${header.colorType}`, 'PNG_COLOR_TYPE_UNSUPPORTED')
  if (header.colorType === 3 && !palette) throw new PngError('У палитрового PNG нет блока PLTE', 'PNG_NO_PALETTE')

  const raw = inflateSync(Buffer.concat(dataChunks))
  const { width, height } = header
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new PngError('Распакованных данных меньше, чем строк', 'PNG_DATA_TOO_SHORT')

  // Снятие фильтра идёт по месту: строка ссылается на уже восстановленную
  // предыдущую, поэтому обратный порядок или копии здесь недопустимы.
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const source = y * (stride + 1) + 1
    const target = y * stride
    const above = target - stride
    for (let index = 0; index < stride; index += 1) {
      const value = raw[source + index]
      const left = index >= channels ? pixels[target + index - channels] : 0
      const up = y > 0 ? pixels[above + index] : 0
      const upLeft = y > 0 && index >= channels ? pixels[above + index - channels] : 0
      let restored
      if (filter === 0) restored = value
      else if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) restored = value + paeth(left, up, upLeft)
      else throw new PngError(`Неизвестный фильтр строки: ${filter}`, 'PNG_FILTER_UNSUPPORTED')
      pixels[target + index] = restored & 0xff
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels
    const to = index * 4
    if (header.colorType === 6) {
      rgba[to] = pixels[from]
      rgba[to + 1] = pixels[from + 1]
      rgba[to + 2] = pixels[from + 2]
      rgba[to + 3] = pixels[from + 3]
    } else if (header.colorType === 2) {
      rgba[to] = pixels[from]
      rgba[to + 1] = pixels[from + 1]
      rgba[to + 2] = pixels[from + 2]
      rgba[to + 3] = 255
    } else if (header.colorType === 0) {
      rgba[to] = rgba[to + 1] = rgba[to + 2] = pixels[from]
      rgba[to + 3] = 255
    } else if (header.colorType === 4) {
      rgba[to] = rgba[to + 1] = rgba[to + 2] = pixels[from]
      rgba[to + 3] = pixels[from + 1]
    } else {
      const entry = pixels[from] * 3
      rgba[to] = palette?.[entry] ?? 0
      rgba[to + 1] = palette?.[entry + 1] ?? 0
      rgba[to + 2] = palette?.[entry + 2] ?? 0
      rgba[to + 3] = paletteAlpha?.[pixels[from]] ?? 255
    }
  }
  return { width, height, data: rgba }
}

/**
 * @param {string} type
 * @param {Buffer} body
 * @returns {Buffer}
 */
function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}

/**
 * Построчная фильтрация. Фильтр строки выбирается перебором пяти вариантов по
 * сумме абсолютных отклонений — обычная эвристика, вдвое уменьшающая файл по
 * сравнению с фильтром 0 и не требующая ничего, кроме арифметики.
 *
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} bytesPerPixel
 * @returns {Buffer}
 */
function filterRows(data, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  const raw = Buffer.alloc((stride + 1) * height)
  const candidate = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const line = y * stride
    const above = line - stride
    let bestFilter = 0
    let bestScore = Number.POSITIVE_INFINITY
    /** @type {Buffer|null} */
    let bestLine = null
    for (let filter = 0; filter <= 4; filter += 1) {
      let score = 0
      for (let index = 0; index < stride; index += 1) {
        const value = data[line + index]
        const left = index >= bytesPerPixel ? data[line + index - bytesPerPixel] : 0
        const up = y > 0 ? data[above + index] : 0
        const upLeft = y > 0 && index >= bytesPerPixel ? data[above + index - bytesPerPixel] : 0
        let encoded
        if (filter === 0) encoded = value
        else if (filter === 1) encoded = value - left
        else if (filter === 2) encoded = value - up
        else if (filter === 3) encoded = value - ((left + up) >> 1)
        else encoded = value - paeth(left, up, upLeft)
        candidate[index] = encoded & 0xff
        // Знаковая сумма: байт 0xff здесь означает −1, а не большое число.
        score += candidate[index] < 128 ? candidate[index] : 256 - candidate[index]
      }
      if (score < bestScore) {
        bestScore = score
        bestFilter = filter
        bestLine = Buffer.from(candidate)
      }
    }
    raw[y * (stride + 1)] = bestFilter
    bestLine?.copy(raw, y * (stride + 1) + 1)
  }
  return raw
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} colorType
 * @returns {Buffer}
 */
function headerChunk(width, height, colorType) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  return chunk('IHDR', header)
}

/**
 * @param {PngImage} image
 */
function assertImage(image) {
  const { width, height, data } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError('Размеры изображения должны быть целыми и положительными', 'PNG_SIZE_INVALID')
  }
  if (data.length !== width * height * 4) throw new PngError('Длина данных не совпадает с размером изображения', 'PNG_DATA_SIZE_MISMATCH')
}

/**
 * Запись RGBA в PNG.
 *
 * @param {PngImage} image
 * @returns {Buffer}
 */
export function encodePng(image) {
  assertImage(image)
  return Buffer.concat([
    SIGNATURE,
    headerChunk(image.width, image.height, 6),
    chunk('IDAT', deflateSync(filterRows(image.data, image.width, image.height, 4), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Подбор палитры методом медианного сечения: набор цветов делится пополам по
 * самому широкому каналу, пока коробок не станет столько, сколько нужно.
 *
 * Выбор метода объясняется задачей. Фактуры пола — это один материал с узким
 * разбросом оттенков, и равномерная сетка цветов на них тратит палитру на
 * пустоту. Медианное сечение отдаёт цвета туда, где их больше, и на камне или
 * траве двести пятьдесят шесть оттенков глазом от полного цвета не отличаются.
 *
 * @param {PngImage} image
 * @param {number} maxColors
 * @returns {{palette: Uint8Array, indices: Uint8Array}}
 */
export function quantizeColors(image, maxColors = 256) {
  const { width, height, data } = image
  /** @type {Map<number, number>} */
  const histogram = new Map()
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4
    const key = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2]
    histogram.set(key, (histogram.get(key) ?? 0) + 1)
  }
  const colors = [...histogram.entries()].map(([key, count]) => ({
    red: (key >> 16) & 0xff, green: (key >> 8) & 0xff, blue: key & 0xff, count,
  }))

  /** @type {Array<typeof colors>} */
  let boxes = [colors]
  while (boxes.length < maxColors) {
    // Делится коробка с наибольшим разбросом, взвешенным по числу пикселей:
    // редкий выброс не должен отбирать место у основного тона.
    let target = -1
    let targetScore = 0
    let targetChannel = 'red'
    boxes.forEach((box, index) => {
      if (box.length < 2) return
      let pixels = 0
      const bounds = { red: [255, 0], green: [255, 0], blue: [255, 0] }
      for (const color of box) {
        pixels += color.count
        for (const channel of ['red', 'green', 'blue']) {
          const value = color[/** @type {'red'|'green'|'blue'} */ (channel)]
          const pair = bounds[/** @type {'red'|'green'|'blue'} */ (channel)]
          if (value < pair[0]) pair[0] = value
          if (value > pair[1]) pair[1] = value
        }
      }
      const spreads = /** @type {const} */ (['red', 'green', 'blue']).map((channel) => ({
        channel, spread: bounds[channel][1] - bounds[channel][0],
      }))
      const widest = spreads.reduce((left, right) => (right.spread > left.spread ? right : left))
      const score = widest.spread * Math.log2(pixels + 1)
      if (score > targetScore) {
        targetScore = score
        target = index
        targetChannel = widest.channel
      }
    })
    if (target < 0) break
    const box = boxes[target]
    const channel = /** @type {'red'|'green'|'blue'} */ (targetChannel)
    box.sort((left, right) => left[channel] - right[channel])
    const half = box.reduce((sum, color) => sum + color.count, 0) / 2
    let carried = 0
    let cut = 1
    for (let index = 0; index < box.length - 1; index += 1) {
      carried += box[index].count
      if (carried >= half) {
        cut = index + 1
        break
      }
    }
    boxes = [...boxes.slice(0, target), box.slice(0, cut), box.slice(cut), ...boxes.slice(target + 1)]
  }

  const palette = new Uint8Array(boxes.length * 3)
  boxes.forEach((box, index) => {
    let pixels = 0
    let red = 0
    let green = 0
    let blue = 0
    for (const color of box) {
      pixels += color.count
      red += color.red * color.count
      green += color.green * color.count
      blue += color.blue * color.count
    }
    palette[index * 3] = Math.round(red / pixels)
    palette[index * 3 + 1] = Math.round(green / pixels)
    palette[index * 3 + 2] = Math.round(blue / pixels)
  })

  /** @type {Map<number, number>} */
  const nearest = new Map()
  const indices = new Uint8Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4
    const key = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2]
    let entry = nearest.get(key)
    if (entry === undefined) {
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let candidate = 0; candidate < boxes.length; candidate += 1) {
        const dr = data[at] - palette[candidate * 3]
        const dg = data[at + 1] - palette[candidate * 3 + 1]
        const db = data[at + 2] - palette[candidate * 3 + 2]
        const distance = dr * dr + dg * dg + db * db
        if (distance < bestDistance) {
          bestDistance = distance
          best = candidate
        }
      }
      entry = best
      nearest.set(key, entry)
    }
    indices[index] = entry
  }
  return { palette, indices }
}

/**
 * Запись палитрового PNG. Прозрачность не поддерживается намеренно: палитра
 * заводится под фактуры пола и стен, а они непрозрачны целиком. Спрайты с
 * альфой пишутся обычным `encodePng`.
 *
 * Смысл в весе. Фактура 512×512 в полном цвете весит около полумегабайта, и
 * шестнадцать таких материалов утяжелили бы страницу на восемь мегабайт против
 * нынешних четырёхсот килобайт на весь набор webp.
 *
 * @param {PngImage} image
 * @param {{colors?: number}} [options]
 * @returns {Buffer}
 */
export function encodeIndexedPng(image, options = {}) {
  assertImage(image)
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] !== 255) throw new PngError('Палитровая запись не поддерживает прозрачность', 'PNG_INDEXED_NEEDS_OPAQUE')
  }
  const { palette, indices } = quantizeColors(image, Math.max(2, Math.min(256, options.colors ?? 256)))
  return Buffer.concat([
    SIGNATURE,
    headerChunk(image.width, image.height, 3),
    chunk('PLTE', Buffer.from(palette)),
    chunk('IDAT', deflateSync(filterRows(indices, image.width, image.height, 1), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
