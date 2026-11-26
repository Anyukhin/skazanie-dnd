#!/usr/bin/env node
/**
 * Выпускает плотный GLB дракона Cethiel/Drummyfish.
 * Два прохода Loop subdivision сохраняют skin, UV, веса костей и клипы.
 *
 *   node tools/upscale-cethiel-dragon.mjs
 *   node tools/upscale-cethiel-dragon.mjs --publish
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { registerAssets } from "./register-asset-rights.mjs"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const SOURCE_FILE = join(ROOT, "public/assets/models/cethiel/dragon-15190f872082e85af253/dragon.glb")
const MANIFEST_FILE = join(ROOT, "public/assets/models/manifest.json")
const PUBLISH = process.argv.includes("--publish")
const CHECK = process.argv.includes("--check")
if (PUBLISH && CHECK) throw new Error("Выберите один режим: --publish или --check")
const OUTPUT_ROOT = PUBLISH || CHECK ? join(ROOT, "public/assets/models/cethiel") : join(ROOT, "tmp/dragon-hd-candidate")
const COMPONENTS = { 5121: [1, "u8"], 5123: [2, "u16"], 5125: [4, "u32"], 5126: [4, "f32"] }
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const ALIGN = (value) => (value + 3) & ~3
const round = (value) => Number(value.toFixed(7))

function parseGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error("Нужен GLB 2.0")
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error("Повреждённая длина GLB")
  let json = null
  let binary = Buffer.alloc(0)
  for (let offset = 12; offset < bytes.length;) {
    const size = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    const chunk = bytes.subarray(offset + 8, offset + 8 + size)
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8").trim())
    else if (type === 0x004e4942) binary = Buffer.from(chunk)
    offset += 8 + size
  }
  if (!json || !binary.length) throw new Error("В GLB нет JSON или BIN")
  return { json, binary }
}

function readAccessor(document, accessorId) {
  const accessor = document.json.accessors[accessorId]
  const view = document.json.bufferViews[accessor.bufferView]
  const info = COMPONENTS[accessor.componentType]
  const components = TYPE_COMPONENTS[accessor.type]
  if (!view || !info || !components) throw new Error("Неподдержанный accessor " + accessorId)
  const stride = view.byteStride || info[0] * components
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0)
  const result = []
  for (let row = 0; row < accessor.count; row += 1) {
    const values = []
    for (let component = 0; component < components; component += 1) {
      const offset = start + row * stride + component * info[0]
      if (accessor.componentType === 5126) values.push(document.binary.readFloatLE(offset))
      else if (accessor.componentType === 5123) values.push(document.binary.readUInt16LE(offset))
      else if (accessor.componentType === 5125) values.push(document.binary.readUInt32LE(offset))
      else values.push(document.binary.readUInt8(offset))
    }
    result.push(values)
  }
  return result
}

function key(row) {
  return row.map((value) => Number.isInteger(value) ? value : round(value)).join(",")
}

function weld(document, primitive) {
  const names = primitive.attributes
  const arrays = {
    position: readAccessor(document, names.POSITION),
    normal: readAccessor(document, names.NORMAL),
    uv: readAccessor(document, names.TEXCOORD_0),
    joints: readAccessor(document, names.JOINTS_0),
    weights: readAccessor(document, names.WEIGHTS_0),
  }
  const nodes = []
  const lookup = new Map()
  const nodeIds = []
  for (let index = 0; index < arrays.position.length; index += 1) {
    const vertex = {
      position: arrays.position[index],
      joints: arrays.joints[index],
      weights: arrays.weights[index],
    }
    // Normals and UVs are per-corner attributes. Position and compatible skin
    // define the shared geometric topology.
    const id = [vertex.position, vertex.joints, vertex.weights].map(key).join("|")
    let target = lookup.get(id)
    if (target == null) { target = nodes.length; lookup.set(id, target); nodes.push(vertex) }
    nodeIds.push(target)
  }
  const faces = []
  for (let index = 0; index < nodeIds.length; index += 3) {
    faces.push({
      nodes: [nodeIds[index], nodeIds[index + 1], nodeIds[index + 2]],
      corners: [0, 1, 2].map((offset) => ({
        normal: arrays.normal[index + offset],
        uv: arrays.uv[index + offset],
      })),
    })
  }
  return { nodes, faces }
}

function addScaled(out, source, scale) {
  for (let index = 0; index < source.length; index += 1) out[index] += source[index] * scale
}

function skin(vertices, influences) {
  const joints = new Map()
  for (const [id, scale] of influences) {
    const vertex = vertices[id]
    vertex.joints.forEach((joint, index) => joints.set(joint, (joints.get(joint) || 0) + vertex.weights[index] * scale))
  }
  const strongest = [...joints.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4)
  const total = strongest.reduce((sum, entry) => sum + entry[1], 0) || 1
  const jointRows = strongest.map((entry) => entry[0])
  const weightRows = strongest.map((entry) => entry[1] / total)
  while (jointRows.length < 4) jointRows.push(0)
  while (weightRows.length < 4) weightRows.push(0)
  return { joints: jointRows, weights: weightRows }
}

function blend(nodes, influences) {
  const position = [0, 0, 0]
  for (const [id, scale] of influences) {
    addScaled(position, nodes[id].position, scale)
  }
  return { position, ...skin(nodes, influences) }
}

function cornerBlend(left, right) {
  const normal = [
    (left.normal[0] + right.normal[0]) / 2,
    (left.normal[1] + right.normal[1]) / 2,
    (left.normal[2] + right.normal[2]) / 2,
  ]
  const length = Math.hypot(...normal) || 1
  return {
    normal: normal.map((value) => value / length),
    uv: [(left.uv[0] + right.uv[0]) / 2, (left.uv[1] + right.uv[1]) / 2],
  }
}

function countBoundaryEdges(faces) {
  const counts = new Map()
  for (const face of faces) for (const [left, right] of [[face.nodes[0], face.nodes[1]], [face.nodes[1], face.nodes[2]], [face.nodes[2], face.nodes[0]]]) {
    const id = left < right ? left + ":" + right : right + ":" + left
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return [...counts.values()].filter((count) => count === 1).length
}

function subdivide(mesh) {
  const nodes = mesh.nodes
  const faces = mesh.faces
  const edges = new Map()
  const neighbors = nodes.map(() => new Set())
  for (const face of faces) {
    const [a, b, c] = face.nodes
    for (const [left, right, opposite] of [[a, b, c], [b, c, a], [c, a, b]]) {
      neighbors[left].add(right)
      neighbors[right].add(left)
      const id = left < right ? left + ":" + right : right + ":" + left
      const edge = edges.get(id) || { left, right, opposite: [] }
      edge.opposite.push(opposite)
      edges.set(id, edge)
    }
  }
  const nextNodes = nodes.map((vertex, id) => {
    const boundary = [...neighbors[id]].filter((neighbor) => {
      const edgeId = id < neighbor ? id + ":" + neighbor : neighbor + ":" + id
      return edges.get(edgeId).opposite.length === 1
    })
    if (boundary.length >= 2) return blend(nodes, [[id, .75], [boundary[0], .125], [boundary[1], .125]])
    const degree = neighbors[id].size
    const beta = degree === 3 ? 3 / 16 : 3 / (8 * degree)
    return blend(nodes, [[id, 1 - degree * beta], ...[...neighbors[id]].map((neighbor) => [neighbor, beta])])
  })
  const edgeIds = new Map()
  for (const [id, edge] of edges) {
    const influences = edge.opposite.length === 2
      ? [[edge.left, .375], [edge.right, .375], [edge.opposite[0], .125], [edge.opposite[1], .125]]
      : [[edge.left, .5], [edge.right, .5]]
    edgeIds.set(id, nextNodes.length)
    nextNodes.push(blend(nodes, influences))
  }
  const edge = (left, right) => edgeIds.get(left < right ? left + ":" + right : right + ":" + left)
  const nextFaces = []
  for (const face of faces) {
    const [a, b, c] = face.nodes
    const [ca, cb, cc] = face.corners
    const ab = edge(a, b), bc = edge(b, c), caId = edge(c, a)
    const cab = cornerBlend(ca, cb), cbc = cornerBlend(cb, cc), cca = cornerBlend(cc, ca)
    nextFaces.push(
      { nodes: [a, ab, caId], corners: [ca, cab, cca] },
      { nodes: [b, bc, ab], corners: [cb, cbc, cab] },
      { nodes: [c, caId, bc], corners: [cc, cca, cbc] },
      { nodes: [ab, bc, caId], corners: [cab, cbc, cca] },
    )
  }
  return { nodes: nextNodes, faces: nextFaces }
}

function append(document, values, componentType, type, target) {
  const info = COMPONENTS[componentType]
  const components = TYPE_COMPONENTS[type]
  const start = ALIGN(document.binary.length)
  if (start > document.binary.length) document.binary = Buffer.concat([document.binary, Buffer.alloc(start - document.binary.length)])
  const data = Buffer.alloc(values.length * components * info[0])
  values.flat().forEach((value, index) => {
    const offset = index * info[0]
    if (info[1] === "f32") data.writeFloatLE(value, offset)
    else if (info[1] === "u16") data.writeUInt16LE(value, offset)
    else if (info[1] === "u32") data.writeUInt32LE(value, offset)
    else data.writeUInt8(value, offset)
  })
  const viewId = document.json.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: data.length, target }) - 1
  const accessor = { bufferView: viewId, componentType, count: values.length, type }
  if (type === "VEC3" && componentType === 5126) {
    accessor.min = [0, 1, 2].map((component) => Math.min(...values.map((row) => row[component])))
    accessor.max = [0, 1, 2].map((component) => Math.max(...values.map((row) => row[component])))
  }
  document.binary = Buffer.concat([document.binary, data])
  return document.json.accessors.push(accessor) - 1
}

function update(document, primitive, mesh) {
  const vertices = []
  const faces = []
  const lookup = new Map()
  for (const face of mesh.faces) {
    const indices = face.nodes.map((nodeId, corner) => {
      const node = mesh.nodes[nodeId]
      const attributes = {
        position: node.position,
        normal: face.corners[corner].normal,
        uv: face.corners[corner].uv,
        joints: node.joints,
        weights: node.weights,
      }
      const id = nodeId + "|" + key(attributes.normal) + "|" + key(attributes.uv)
      let target = lookup.get(id)
      if (target == null) { target = vertices.length; lookup.set(id, target); vertices.push(attributes) }
      return target
    })
    faces.push(indices)
  }
  primitive.attributes.POSITION = append(document, vertices.map((vertex) => vertex.position), 5126, "VEC3", 34962)
  primitive.attributes.NORMAL = append(document, vertices.map((vertex) => vertex.normal), 5126, "VEC3", 34962)
  primitive.attributes.TEXCOORD_0 = append(document, vertices.map((vertex) => vertex.uv), 5126, "VEC2", 34962)
  primitive.attributes.JOINTS_0 = append(document, vertices.map((vertex) => vertex.joints), 5123, "VEC4", 34962)
  primitive.attributes.WEIGHTS_0 = append(document, vertices.map((vertex) => vertex.weights), 5126, "VEC4", 34962)
  primitive.indices = append(document, faces.flat().map((value) => [value]), vertices.length > 65535 ? 5125 : 5123, "SCALAR", 34963)
  return { vertices, faces }
}

function encode(document) {
  document.json.buffers[0].byteLength = document.binary.length
  const json = Buffer.from(JSON.stringify(document.json))
  const paddedJson = Buffer.concat([json, Buffer.alloc(ALIGN(json.length) - json.length, 0x20)])
  const paddedBin = Buffer.concat([document.binary, Buffer.alloc(ALIGN(document.binary.length) - document.binary.length)])
  const header = Buffer.alloc(12)
  const jsonHeader = Buffer.alloc(8)
  const binHeader = Buffer.alloc(8)
  const total = 12 + 8 + paddedJson.length + 8 + paddedBin.length
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  jsonHeader.writeUInt32LE(paddedJson.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  binHeader.writeUInt32LE(paddedBin.length); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin])
}

function inspect(document) {
  const primitive = document.json.meshes?.[0]?.primitives?.[0]
  if (!primitive || primitive.mode !== 4 || primitive.indices != null) throw new Error("Ожидалась одна неиндексированная треугольная сетка")
  let mesh = weld(document, primitive)
  const original = { triangles: mesh.faces.length, vertices: mesh.nodes.length, boundaryEdges: countBoundaryEdges(mesh.faces) }
  for (let level = 0; level < 2; level += 1) mesh = subdivide(mesh)
  const topologyBoundaryEdges = countBoundaryEdges(mesh.faces)
  const output = update(document, primitive, mesh)
  if (topologyBoundaryEdges !== original.boundaryEdges * 4) throw new Error("Loop subdivision создала новые открытые рёбра")
  return {
    original,
    output: { triangles: mesh.faces.length, vertices: output.vertices.length, boundaryEdges: topologyBoundaryEdges },
  }
}

const source = readFileSync(SOURCE_FILE)
const document = parseGlb(source)
const stats = inspect(document)
const bytes = encode(document)
const digest = createHash("sha256").update(bytes).digest("hex")
const dirName = "dragon-hd-" + digest.slice(0, 20)
const outputDir = join(OUTPUT_ROOT, dirName)
const outputFile = join(outputDir, "dragon.glb")
const notice = {
  schema: "skazanie-model-notice/v1",
  models: [{
    file: "dragon.glb",
    sha256: digest,
    bytes: bytes.length,
    title: "Cethiel's Dragon 3D — детализированная модель Саргата",
    author: "Drummyfish (3D), Cethiel (исходный рисунок)",
    source: "https://opengameart.org/content/cethiels-dragon-3d",
    license: "CC0-1.0",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    source_glb: "/assets/models/cethiel/dragon-15190f872082e85af253/dragon.glb",
    source_sha256: createHash("sha256").update(source).digest("hex"),
    changes: "Два прохода подразделения Лупа по общей геометрической сетке. Координаты фактуры и нормали интерполируются по углам граней, веса скелета — по общей вершине. Встроенная фактура и четыре исходные анимации сохранены.",
    original: stats.original,
    output: stats.output,
    clips: ["Idle", "Walk", "Bite_Attack", "Death"],
  }],
}
const relativeDir = "models/cethiel/" + dirName
const nextUrl = "/assets/" + relativeDir + "/dragon.glb"
const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"))
const dragon = manifest.models.find(model => model.key === "dragon")
if (!dragon) throw new Error("В каталоге отсутствует фигурка дракона")
if (CHECK) {
  if (dragon.url !== nextUrl || !readFileSync(outputFile).equals(bytes)) throw new Error("Опубликованная модель отличается от воспроизводимого выпуска")
} else {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(outputFile, bytes)
  writeFileSync(join(outputDir, "NOTICE.json"), JSON.stringify(notice, null, 2) + "\n")
  if (PUBLISH) {
    dragon.url = nextUrl
    dragon.rights.notes = "Детализированная сетка исходного дракона Cethiel/Drummyfish. Лицензия, исходный файл и изменения — /assets/" + relativeDir + "/NOTICE.json."
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n")
    registerAssets(["models/manifest.json", relativeDir + "/dragon.glb", relativeDir + "/NOTICE.json"])
  }
}
console.log(JSON.stringify({ source: SOURCE_FILE, outputFile, publish: PUBLISH, sha256: digest, bytes: bytes.length, ...stats }, null, 2))
