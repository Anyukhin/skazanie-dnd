import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

function decodeGlb(bytes) {
  let json = null
  let binary = null
  for (let offset = 12; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    const chunk = bytes.subarray(offset + 8, offset + 8 + size)
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8").trim())
    if (type === 0x004e4942) binary = chunk
    offset += 8 + size
  }
  return { json, binary }
}

function accessorRows(document, id) {
  const accessor = document.json.accessors[id]
  const view = document.json.bufferViews[accessor.bufferView]
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type]
  const size = { 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType]
  const stride = view.byteStride || components * size
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0)
  return Array.from({ length: accessor.count }, (_, row) => Array.from({ length: components }, (_, component) => {
    const offset = start + row * stride + component * size
    if (accessor.componentType === 5126) return document.binary.readFloatLE(offset)
    if (accessor.componentType === 5125) return document.binary.readUInt32LE(offset)
    return document.binary.readUInt16LE(offset)
  }))
}

function boundaryEdges(document) {
  const primitive = document.json.meshes[0].primitives[0]
  const positions = accessorRows(document, primitive.attributes.POSITION)
  const indices = accessorRows(document, primitive.indices).flat()
  const edgeCounts = new Map()
  const positionKey = (index) => positions[index].map((value) => Number(value.toFixed(7))).join(",")
  for (let index = 0; index < indices.length; index += 3) {
    for (const [left, right] of [[indices[index], indices[index + 1]], [indices[index + 1], indices[index + 2]], [indices[index + 2], indices[index]]]) {
      const a = positionKey(left), b = positionKey(right)
      const key = a < b ? a + ":" + b : b + ":" + a
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1)
    }
  }
  return [...edgeCounts.values()].filter((count) => count === 1).length
}

test("Детализированная модель дракона воспроизводится без разрывов на швах", () => {
  const output = JSON.parse(execFileSync(process.execPath, ["tools/upscale-cethiel-dragon.mjs", "--check"], { encoding: "utf8" }))
  assert.equal(output.original.triangles, 1262)
  assert.equal(output.output.triangles, 1262 * 16)
  assert.equal(output.original.boundaryEdges, 0)
  assert.equal(output.output.boundaryEdges, 0)
  const document = decodeGlb(readFileSync(output.outputFile))
  assert.equal(boundaryEdges(document), 0, "развёртка и нормали не разрывают геометрию на границе граней")
  assert.ok(document.json.meshes[0].primitives[0].indices != null, "сетка использует индекс вершин")
})
