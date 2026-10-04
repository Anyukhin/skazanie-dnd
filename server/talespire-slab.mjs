// @ts-check
/**
 * Разбор слэба TaleSpire — строки, которую игра кладёт в буфер обмена при
 * копировании выделенной области (Ctrl+C в режиме строительства).
 *
 * Формат v2 описан разработчиком игры:
 * https://github.com/Bouncyrock/DumbSlabStats/blob/master/format.md
 * Формат v1 (старые слэбы, их много на TalesTavern) не документирован и
 * восстановлен по образцам: те же 20-байтовые описания видов, но экземпляр
 * занимает 28 байт — центр и полуразмеры габарита в мировых координатах
 * (шесть float32) и байт поворота.
 *
 * Модуль ничего не знает о каталоге ассетов и о тактической карте: он только
 * превращает строку в список экземпляров. Любая ошибка разбора — это
 * `TaleSpireSlabError` с кодом, а не исключение zlib или Buffer, чтобы
 * маршрут мог ответить игроку по-русски.
 */
import { gunzipSync } from 'node:zlib'

export const SLAB_MAGIC = 0xD1CEFACE
/** Предел сжатого слэба, который принимает сама игра (format.md). */
export const SLAB_MAX_PACKED_BYTES = 30720
/** Предел распакованных данных: v1 с 28 байтами на экземпляр и 65535 экземплярами на вид — с большим запасом. */
export const SLAB_MAX_UNPACKED_BYTES = 4 * 1024 * 1024
/** Предел текста: base64 от 30 КБ плюс обрамление кавычками и пробелы. */
export const SLAB_MAX_TEXT_LENGTH = 48 * 1024

/**
 * Пределы видов и экземпляров (аудит PR #131, MAP-BOUNDARY-01). Предел
 * распаковки держит память буфера, но не число записей: одинаковые записи
 * сжимаются почти без остатка, и в 30 КиБ влезает полмиллиона экземпляров v2.
 * Число проверяется по заголовкам видов — до того, как собран хоть один
 * экземпляр.
 *
 * Запас относительно настоящих построек: даже идеально ровная сетка плит 1×1
 * сжимается примерно в 2 байта на экземпляр, и в предел самой игры влезает
 * около 15 тысяч; у живых слэбов TalesTavern разброс координат больше, а
 * экземпляров меньше. Видов в таблице ассетов 3289, в одной постройке —
 * десятки, редко сотни.
 */
export const SLAB_MAX_LAYOUTS = 4096
export const SLAB_MAX_INSTANCES = 50_000

/**
 * Числовые границы v1 (аудит PR #131, MAP-BOUNDARY-02): конечное — ещё не
 * ограниченное. Центр старого слэба — мировая координата, и далёкая от начала
 * доски постройка законна, поэтому предел смещения щедрый: до 2^22 float32
 * хранит четверть клетки точно, а шаг обхода в одну клетку не теряется. Дальше
 * `x += 1` у огромного числа перестаёт что-либо прибавлять, и обход клеток не
 * кончается. Полуразмер габарита — с восьмикратным запасом над самым крупным
 * ассетом таблицы (4 клетки, после поворота около 5,7).
 */
export const SLAB_MAX_COORDINATE = 1_000_000
export const SLAB_MAX_HALF_EXTENT = 32

const V1_INSTANCE_BYTES = 28
const V2_INSTANCE_BYTES = 8
const LAYOUT_BYTES = 20
const MASK_18 = (1n << 18n) - 1n

export class TaleSpireSlabError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'TaleSpireSlabError'
    this.code = code
  }
}

/**
 * Экземпляр v2: точка — минимальный угол повёрнутого габарита в сотых клетки,
 * поворот — шаги по 15°. Габарит восстанавливается по каталогу.
 * @typedef {{ assetId: string, x: number, y: number, z: number, rotation: number }} SlabV2Instance
 */

/**
 * Экземпляр v1: габарит уже повёрнут и лежит в мировых координатах.
 * @typedef {{ assetId: string, center: {x:number,y:number,z:number}, extent: {x:number,y:number,z:number}, rotation: number }} SlabV1Instance
 */

/**
 * @typedef {object} DecodedSlab
 * @property {1|2} version
 * @property {number} packedBytes
 * @property {number} kinds число видов ассетов
 * @property {Array<SlabV1Instance|SlabV2Instance>} instances
 */

/**
 * GUID в порядке байт .NET: первые три поля little-endian, остальное как есть.
 * @param {Buffer} bytes 16 байт
 * @returns {string}
 */
export function guidFromBytes(bytes) {
  const hex = (/** @type {number[]} */ list) => Buffer.from(list).toString('hex')
  return [
    hex([bytes[3], bytes[2], bytes[1], bytes[0]]),
    hex([bytes[5], bytes[4]]),
    hex([bytes[7], bytes[6]]),
    bytes.subarray(8, 10).toString('hex'),
    bytes.subarray(10, 16).toString('hex'),
  ].join('-')
}

/**
 * Снимает обрамление из тройных обратных кавычек и пробелы. Внутри base64
 * переносы строк тоже убираются: мессенджеры любят переносить длинные строки.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeSlabText(text) {
  let value = String(text ?? '').trim()
  if (value.startsWith('```')) value = value.slice(3)
  if (value.endsWith('```')) value = value.slice(0, -3)
  return value.replace(/\s+/gu, '')
}

/**
 * @param {Buffer} data
 * @param {number} offset
 * @param {number} need
 */
function requireBytes(data, offset, need) {
  if (offset + need > data.length) {
    throw new TaleSpireSlabError('Слэб обрезан: данных меньше, чем объявлено в заголовке', 'SLAB_TRUNCATED')
  }
}

/**
 * @param {unknown} text строка из буфера обмена TaleSpire
 * @returns {DecodedSlab}
 */
export function decodeSlab(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TaleSpireSlabError('Вставьте строку слэба', 'SLAB_EMPTY')
  if (text.length > SLAB_MAX_TEXT_LENGTH) throw new TaleSpireSlabError('Слэб длиннее, чем допускает TaleSpire', 'SLAB_TOO_LARGE')
  const body = normalizeSlabText(text)
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) throw new TaleSpireSlabError('Это не слэб TaleSpire: строка не в base64', 'SLAB_NOT_BASE64')
  const packed = Buffer.from(body, 'base64')
  if (packed.length > SLAB_MAX_PACKED_BYTES) throw new TaleSpireSlabError('Слэб длиннее, чем допускает TaleSpire', 'SLAB_TOO_LARGE')
  /** @type {Buffer} */
  let data
  try {
    data = gunzipSync(packed, { maxOutputLength: SLAB_MAX_UNPACKED_BYTES })
  } catch {
    throw new TaleSpireSlabError('Это не слэб TaleSpire: данные не распаковываются', 'SLAB_NOT_GZIP')
  }
  requireBytes(data, 0, 8)
  if (data.readUInt32LE(0) !== SLAB_MAGIC) throw new TaleSpireSlabError('Это не слэб TaleSpire: неверная сигнатура', 'SLAB_BAD_MAGIC')
  const version = data.readUInt16LE(4)
  if (version !== 1 && version !== 2) throw new TaleSpireSlabError(`Версия слэба ${version} не поддерживается`, 'SLAB_VERSION_UNSUPPORTED')
  const layoutCount = data.readUInt16LE(6)
  if (layoutCount > SLAB_MAX_LAYOUTS) {
    throw new TaleSpireSlabError(`В слэбе ${layoutCount} видов ассетов — больше предела ${SLAB_MAX_LAYOUTS}`, 'SLAB_TOO_MANY_LAYOUTS')
  }
  let offset = 8
  if (version === 2) {
    requireBytes(data, offset, 2)
    offset += 2 // число существ, в v2 всегда ноль
  }
  /** @type {Array<{ assetId: string, count: number }>} */
  const layouts = []
  requireBytes(data, offset, layoutCount * LAYOUT_BYTES)
  for (let index = 0; index < layoutCount; index += 1) {
    layouts.push({ assetId: guidFromBytes(data.subarray(offset, offset + 16)), count: data.readUInt16LE(offset + 16) })
    offset += LAYOUT_BYTES
  }
  const declared = layouts.reduce((sum, layout) => sum + layout.count, 0)
  if (declared > SLAB_MAX_INSTANCES) {
    throw new TaleSpireSlabError(`В слэбе ${declared} объектов — больше предела ${SLAB_MAX_INSTANCES}: скопируйте часть доски`, 'SLAB_TOO_MANY_INSTANCES')
  }
  /** @type {Array<SlabV1Instance|SlabV2Instance>} */
  const instances = []
  for (const layout of layouts) {
    if (version === 2) {
      requireBytes(data, offset, layout.count * V2_INSTANCE_BYTES)
      for (let index = 0; index < layout.count; index += 1) {
        const packedValue = data.readBigUInt64LE(offset)
        offset += V2_INSTANCE_BYTES
        instances.push({
          assetId: layout.assetId,
          x: Number(packedValue & MASK_18) / 100,
          y: Number((packedValue >> 18n) & MASK_18) / 100,
          z: Number((packedValue >> 36n) & MASK_18) / 100,
          rotation: Number((packedValue >> 54n) & 31n) * 15,
        })
      }
    } else {
      requireBytes(data, offset, layout.count * V1_INSTANCE_BYTES)
      for (let index = 0; index < layout.count; index += 1) {
        const at = (/** @type {number} */ slot) => data.readFloatLE(offset + slot * 4)
        const center = { x: at(0), y: at(1), z: at(2) }
        const extent = { x: Math.abs(at(3)), y: Math.abs(at(4)), z: Math.abs(at(5)) }
        // байт поворота: 0, 4, 8, 12 — четверти оборота, то есть шаг 22,5°
        const rotation = (data.readUInt8(offset + 24) % 16) * 22.5
        offset += V1_INSTANCE_BYTES
        if (![center.x, center.y, center.z, extent.x, extent.y, extent.z].every(Number.isFinite)) {
          throw new TaleSpireSlabError('Слэб повреждён: координаты не числа', 'SLAB_CORRUPT')
        }
        if (![center.x, center.y, center.z].every((value) => Math.abs(value) <= SLAB_MAX_COORDINATE)) {
          throw new TaleSpireSlabError(`Слэб повреждён: объект дальше ${SLAB_MAX_COORDINATE} клеток от начала доски`, 'SLAB_COORDINATE_OUT_OF_RANGE')
        }
        if (![extent.x, extent.y, extent.z].every((value) => value <= SLAB_MAX_HALF_EXTENT)) {
          throw new TaleSpireSlabError(`Слэб повреждён: объект больше ${2 * SLAB_MAX_HALF_EXTENT} клеток в поперечнике`, 'SLAB_EXTENT_TOO_LARGE')
        }
        instances.push({ assetId: layout.assetId, center, extent, rotation })
      }
    }
  }
  return { version: /** @type {1|2} */ (version), packedBytes: packed.length, kinds: layouts.length, instances }
}
