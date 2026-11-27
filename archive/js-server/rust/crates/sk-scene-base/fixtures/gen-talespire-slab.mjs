// Эталон `server/talespire-slab.mjs` для sk-scene-base.
// Запуск из корня репозитория: node rust/crates/sk-scene-base/fixtures/gen-talespire-slab.mjs
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'

import {
  SLAB_MAX_INSTANCES,
  SLAB_MAX_LAYOUTS,
  SLAB_MAX_TEXT_LENGTH,
  decodeSlab,
  guidFromBytes,
  normalizeSlabText,
} from '../../../../server/talespire-slab.mjs'
import { ASSETS, HOUSE_SLAB, encodeSlabV1, encodeSlabV1Raw, encodeSlabV2, housePlacements } from '../../../../test/talespire-fixtures.mjs'
import { rng } from './corpus.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')

/** Ответ разбора: слэб или код и текст ошибки; большой слэб — сводкой с хешем. */
function decoded(input) {
  try {
    const slab = decodeSlab(input)
    if (slab.instances.length > 400) {
      return { summary: { version: slab.version, packedBytes: slab.packedBytes, kinds: slab.kinds, count: slab.instances.length, sha256: sha(JSON.stringify(slab.instances)) } }
    }
    return { slab }
  } catch (error) {
    return { error: { code: error.code, message: error.message, name: error.name } }
  }
}

const header = (version, layouts, extra = 0) => {
  const buffer = Buffer.alloc(8 + extra)
  buffer.writeUInt32LE(0xD1CEFACE, 0)
  buffer.writeUInt16LE(version, 4)
  buffer.writeUInt16LE(layouts, 6)
  return buffer
}
const b64 = (buffer) => buffer.toString('base64')
const gz = (buffer) => gzipSync(buffer)

// v2 из одной записи с заданным 64-битным словом.
function v2Word(word, layoutCount = 1) {
  const layout = Buffer.alloc(20)
  for (let index = 0; index < 16; index += 1) layout[index] = index * 17
  layout.writeUInt16LE(1, 16)
  const instance = Buffer.alloc(8)
  instance.writeBigUInt64LE(word)
  return b64(gz(Buffer.concat([header(2, layoutCount, 2), layout, instance])))
}

// v1 из одной записи с заданными float32.
function v1Floats(values, rotationByte = 0) {
  const layout = Buffer.alloc(20)
  layout.writeUInt16LE(1, 16)
  const instance = Buffer.alloc(28)
  values.forEach((value, index) => instance.writeFloatLE(value, index * 4))
  instance.writeUInt8(rotationByte, 24)
  return b64(gz(Buffer.concat([header(1, 1), layout, instance])))
}

/** gzip с правкой заголовка: флаги, метод, CRC. */
function gzipVariant(payload, patch) {
  const plain = Buffer.from(gz(payload))
  return patch(plain)
}

const houseData = gunzipSync(Buffer.from(HOUSE_SLAB, 'base64'))

const cases = []
const add = (label, input) => cases.push({ label, input: input === undefined ? '__undefined__' : input, output: decoded(input) })

// Штатные слэбы.
add('дом v2', HOUSE_SLAB)
add('дом v1', encodeSlabV1(housePlacements()))
add('две записи v2', encodeSlabV2([{ asset: ASSETS.floor, x: 3, y: 0.5, z: 7.25 }, { asset: ASSETS.door, x: 6.75, y: 0.5, z: 3, rotation: 90 }]))
add('дверь v1', encodeSlabV1([{ asset: ASSETS.door, x: 6.75, y: 0.5, z: 3, rotation: 90 }]))
add('кавычки и переносы', `\n\`\`\`${HOUSE_SLAB.slice(0, 40)}\n${HOUSE_SLAB.slice(40)}\`\`\`  `)
add('только открывающие кавычки', `\`\`\`${HOUSE_SLAB}`)
add('пробелы внутри', HOUSE_SLAB.split('').join(' '))
add('табы и неразрывные пробелы', `\t${HOUSE_SLAB.slice(0, 10)}  ${HOUSE_SLAB.slice(10)}\r\n`)
const next = rng(5)
for (let index = 0; index < 60; index += 1) {
  const word = BigInt(Math.floor(next() * 2 ** 32)) | (BigInt(Math.floor(next() * 2 ** 32)) << 32n)
  add(`v2 слово ${index}`, v2Word(word))
}
add('v2 все единицы', v2Word(0xFFFFFFFFFFFFFFFFn))
add('v2 ноль', v2Word(0n))
for (const values of [
  [0.5, 0.25, 0.5, 0.5, 0.25, 0.5], [1.1, -2.2, 3.3, -0.5, 0.25, -0.75], [-0, 0, -0, -0, 0, 0], [999999, -999999, 1000000, 32, 32, 32],
  [1000000.1, 0, 0, 1, 1, 1], [0, 0, 0, 32.01, 1, 1], [1e30, 0.25, 0.5, 0.5, 0.25, 0.5], [1e17, 0.25, 0.5, 20, 0.25, 0.5],
  [5, 0.25, 5, 100000, 0.25, 100000], [NaN, 0, 0, 1, 1, 1], [0, 0, 0, Infinity, 1, 1], [-Infinity, 0, 0, 1, 1, 1], [1.4e-45, 3.4e38, 0, 1e-7, 0, 0],
  [123.456, 7.875, -0.001, 0.1, 0.2, 0.3],
]) {
  for (const rotation of [0, 4, 8, 17, 255]) add(`v1 ${values.join(',')} r${rotation}`, v1Floats(values, rotation))
}
const room = []
for (let x = 0; x < 10; x += 1) for (let z = 0; z < 10; z += 1) room.push({ asset: ASSETS.floor, center: [x + 0.5, 0.25, z + 0.5], extent: [0.5, 0.25, 0.5] })
add('комната v1', encodeSlabV1Raw(room))
add('далёкая комната v1', encodeSlabV1Raw(room.map((record) => ({ ...record, center: [record.center[0] + 100_000, record.center[1], record.center[2] - 100_000] }))))

// Пределы видов и объектов.
add('лавина объектов', encodeSlabV2(Array.from({ length: SLAB_MAX_INSTANCES + 1 }, () => ({ asset: ASSETS.floor, x: 1, y: 0, z: 1 }))))
add('предел объектов', encodeSlabV2(Array.from({ length: SLAB_MAX_INSTANCES }, (_, index) => ({ asset: ASSETS.floor, x: index % 50, y: 0, z: Math.floor(index / 50) % 50 }))))
add('видов больше предела', b64(gz(Buffer.concat([header(2, SLAB_MAX_LAYOUTS + 1, 2), Buffer.alloc((SLAB_MAX_LAYOUTS + 1) * 20 + 2)]))))
add('видов на пределе без объектов', b64(gz(Buffer.concat([header(2, SLAB_MAX_LAYOUTS, 2), Buffer.alloc(SLAB_MAX_LAYOUTS * 20)]))))

// Ошибки.
const badMagic = b64(gz(Buffer.from([1, 2, 3, 4, 2, 0, 0, 0, 0, 0])))
const truncatedHeader = header(2, 5, 2)
for (const [label, input] of [
  ['пусто', ''], ['пробелы', '   \n\t'], ['число', 42], ['null', null], ['не задано', undefined], ['объект', { slab: HOUSE_SLAB }],
  ['не base64', 'это не слэб!'], ['base64 с пробелом посередине = ', 'QUJD=QUJD'], ['три знака =', 'QQ==='],
  ['base64 текста', Buffer.from('просто текст').toString('base64')], ['неверная сигнатура', badMagic],
  ['версия 3', b64(gz(Buffer.from([0xCE, 0xFA, 0xCE, 0xD1, 3, 0, 0, 0])))], ['версия 0', b64(gz(Buffer.from([0xCE, 0xFA, 0xCE, 0xD1, 0, 0, 0, 0])))],
  ['обрезанный заголовок', b64(gz(truncatedHeader))], ['семь байт', b64(gz(Buffer.alloc(7)))], ['пусто внутри', b64(gz(Buffer.alloc(0)))],
  ['v2 без числа существ', b64(gz(header(2, 0)))], ['v2 с одним байтом существ', b64(gz(Buffer.concat([header(2, 0), Buffer.from([0])])))],
  ['v2 обрезанные экземпляры', b64(gz(Buffer.concat([header(2, 1, 2), Buffer.from([...Array(16).fill(1), 3, 0, 0, 0]), Buffer.alloc(16)])))],
  ['v1 обрезанные экземпляры', b64(gz(Buffer.concat([header(1, 1), Buffer.from([...Array(16).fill(2), 2, 0, 0, 0]), Buffer.alloc(40)])))],
  ['слишком длинный текст', 'A'.repeat(SLAB_MAX_TEXT_LENGTH + 1)], ['текст на пределе', 'A'.repeat(SLAB_MAX_TEXT_LENGTH)],
  ['эмодзи сверх предела UTF-16', '😀'.repeat(25000)], ['эмодзи', '😀'], ['кириллица', 'слэб'],
  ['сжатое больше предела', b64(Buffer.from(Array.from({ length: 30721 }, (_, index) => (index * 7919) % 256)))],
  ['сжатое на пределе', b64(Buffer.from(Array.from({ length: 30720 }, (_, index) => (index * 7919) % 256)))],
  ['один знак', 'A'], ['два знака', 'QQ'], ['пять знаков', 'QUJDR'], ['паддинг одним =', 'QUI='],
]) add(label, input)

// gzip по правилам Node: несколько членов, набивка нулями, мусор, обрезка, CRC, флаги.
const member = gz(houseData)
const half = Math.floor(houseData.length / 2)
add('два члена gzip', b64(Buffer.concat([gz(houseData.subarray(0, half)), gz(houseData.subarray(half))])))
add('три члена с пустым', b64(Buffer.concat([gz(houseData.subarray(0, half)), gz(Buffer.alloc(0)), gz(houseData.subarray(half))])))
add('нули после члена', b64(Buffer.concat([member, Buffer.alloc(5)])))
add('ноль и мусор после члена', b64(Buffer.concat([member, Buffer.from([0, 1, 2, 3])])))
add('мусор после члена', b64(Buffer.concat([member, Buffer.from('garbage')])))
add('один байт 1f после члена', b64(Buffer.concat([member, Buffer.from([0x1f])])))
add('1f 8b после члена', b64(Buffer.concat([member, Buffer.from([0x1f, 0x8b])])))
add('обрезанный член', b64(member.subarray(0, member.length - 3)))
add('без трейлера', b64(member.subarray(0, member.length - 8)))
add('неверный CRC', b64(gzipVariant(houseData, (buffer) => { buffer[buffer.length - 6] ^= 1; return buffer })))
add('неверная длина', b64(gzipVariant(houseData, (buffer) => { buffer[buffer.length - 2] ^= 1; return buffer })))
add('метод не 8', b64(gzipVariant(houseData, (buffer) => { buffer[2] = 7; return buffer })))
add('не gzip-сигнатура', b64(gzipVariant(houseData, (buffer) => { buffer[1] = 0x8c; return buffer })))
const withHeader = (flags, extra) => {
  const plain = gz(houseData)
  const body = plain.subarray(10)
  const head = Buffer.from(plain.subarray(0, 10))
  head[3] = flags
  return b64(Buffer.concat([head, extra, body]))
}
add('FNAME', withHeader(0x08, Buffer.from('house.slab\0')))
add('FCOMMENT', withHeader(0x10, Buffer.from('комментарий\0')))
add('FEXTRA', withHeader(0x04, Buffer.from([4, 0, 1, 2, 3, 4])))
add('FTEXT', withHeader(0x01, Buffer.alloc(0)))
const fhcrc = (correct) => {
  const plain = gz(houseData)
  const head = Buffer.from(plain.subarray(0, 10))
  head[3] = 0x02
  let crc = 0xFFFFFFFF
  for (const byte of head) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  crc = (crc ^ 0xFFFFFFFF) >>> 0
  const check = Buffer.alloc(2)
  check.writeUInt16LE(correct ? crc & 0xFFFF : (crc + 1) & 0xFFFF)
  return b64(Buffer.concat([head, check, plain.subarray(10)]))
}
add('FHCRC верный', fhcrc(true))
add('FHCRC неверный', fhcrc(false))
add('распаковка ровно 4 МиБ', b64(gz(Buffer.alloc(4 * 1024 * 1024))))
add('распаковка больше 4 МиБ', b64(gz(Buffer.alloc(4 * 1024 * 1024 + 1))))
add('два члена по 2 МиБ и байт', b64(Buffer.concat([gz(Buffer.alloc(2 * 1024 * 1024)), gz(Buffer.alloc(2 * 1024 * 1024 + 1))])))

const guids = []
for (let index = 0; index < 40; index += 1) {
  const bytes = Buffer.from(Array.from({ length: 16 }, () => Math.floor(next() * 256)))
  guids.push({ bytes: [...bytes], output: guidFromBytes(bytes) })
}
for (const length of [0, 3, 9, 12]) {
  const bytes = Buffer.from(Array.from({ length }, (_, index) => index + 1))
  guids.push({ bytes: [...bytes], output: guidFromBytes(bytes) })
}

const normalized = ['', '   ', '```', '``````', '`````', '```abc```', ' ```a b\nc``` ', 'a\tb c', '```\n```', null, undefined, 42].map((text) => ({ text: text === undefined ? '__undefined__' : text, output: normalizeSlabText(text) }))

writeFileSync(new URL('./talespire-slab.json', import.meta.url), `${JSON.stringify({ cases, guids, normalized })}\n`)
console.log(`talespire-slab: ${cases.length + guids.length + normalized.length} случаев`)
