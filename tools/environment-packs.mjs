// @ts-check
/**
 * Дополнительные CC0-наборы окружения поверх Fantasy Props и Nature Kit.
 *
 * Здесь только данные и чистые преобразования: какой архив ожидается, какие
 * файлы из него берутся, к каким существующим `assetId` они привязаны и как
 * ужимаются их текстуры. Чтение файлов, хеши и запись кандидата остаются в
 * `import-environment-models.mjs`, чтобы у импорта был один путь.
 *
 * Новые виды предметов отсюда не появляются: каждая запись — ещё один вариант
 * вида, уже объявленного в `server/asset-registry.mjs`.
 */

/**
 * @typedef {{url: string, license: string, author: string, archive: string, archiveSha256: string}} PackSource
 * @typedef {{file: string, translation: [number, number, number]}} PackPart
 * @typedef {{
 *   file: string,
 *   name?: string,
 *   label: string,
 *   category: string,
 *   assetIds: string[],
 *   yaw?: number,
 *   imageOverrides?: Record<string, string>,
 *   nodeNames?: Record<string, string>,
 *   parts?: PackPart[],
 * }} PackModel
 * @typedef {{
 *   id: 'nature' | 'kaykit' | 'graveyard',
 *   family: string,
 *   keyPrefix: string,
 *   title: string,
 *   source: PackSource,
 *   archivePath: string,
 *   directoryPath: string,
 *   inputRoot: string,
 *   licenseFile: string,
 *   palette?: 'graveyard-muted',
 *   textureSide: (imageName: string) => number,
 *   selection: readonly PackModel[],
 * }} EnvironmentPack
 */

/** Лиственные текстуры с альфа-вырезом заметны сверху; кора, камень и карты нормалей — нет. */
function natureTextureSide(imageName) {
  if (/_Normal$/u.test(imageName)) return 128
  if (/^(?:Leaves|Leaf|Flowers|Grass)/u.test(imageName)) return 512
  return 256
}

/** Палитра KayKit — полосы градиентов: 512 px сохраняют их ширину, 256 уже смешивают соседние цвета. */
const kaykitTextureSide = () => 512

/** Colormap Kenney — сплошные квадраты 64 px; 256 px оставляют от каждого 32 px. */
const graveyardTextureSide = () => 256

const tree = (file, label, assetIds) => ({ file, label, category: 'Природа', assetIds })

export const NATURE_SELECTION = Object.freeze([
  tree('CommonTree_1.gltf', 'Лиственное дерево', ['tree_oak']),
  tree('CommonTree_2.gltf', 'Раскидистое лиственное дерево', ['tree_oak']),
  tree('CommonTree_5.gltf', 'Невысокое лиственное дерево', ['tree_oak']),
  tree('CommonTree_3.gltf', 'Стройное лиственное дерево', ['tree_birch']),
  tree('CommonTree_4.gltf', 'Высокое стройное дерево', ['tree_birch']),
  tree('Pine_1.gltf', 'Сосна', ['tree_pine']),
  tree('Pine_3.gltf', 'Сосна с голым стволом', ['tree_pine']),
  tree('Pine_4.gltf', 'Высокая сосна', ['tree_pine']),
  tree('Pine_2.gltf', 'Ель', ['tree_spruce']),
  tree('Pine_5.gltf', 'Широкая ель', ['tree_spruce']),
  tree('DeadTree_1.gltf', 'Сухое дерево', ['tree_dead']),
  tree('DeadTree_2.gltf', 'Сухое ветвистое дерево', ['tree_dead']),
  tree('DeadTree_4.gltf', 'Высохшая ель', ['tree_dead']),
  {
    // В исходнике куст покрыт красной листвой TwistedTree; для обычного куста
    // берётся зелёная листва того же набора с той же раскладкой пятен.
    ...tree('Bush_Common.gltf', 'Куст', ['bush', 'shrub']),
    imageOverrides: { 'Leaves_TwistedTree_C.png': 'Leaves_NormalTree_C.png' },
  },
  tree('Bush_Common_Flowers.gltf', 'Цветущий куст', ['bush', 'shrub']),
  tree('Fern_1.gltf', 'Папоротник', ['fern']),
  tree('Grass_Common_Short.gltf', 'Пучок травы', ['grass_tuft']),
  tree('Grass_Common_Tall.gltf', 'Высокая трава', ['grass_tuft']),
  tree('Flower_3_Group.gltf', 'Красные цветы', ['flowers']),
  tree('Flower_4_Group.gltf', 'Жёлтые цветы', ['flowers']),
  tree('Plant_7_Big.gltf', 'Лиловые цветы', ['flowers']),
  tree('Mushroom_Common.gltf', 'Бледные грибы', ['mushroom_cluster']),
  tree('Mushroom_Laetiporus.gltf', 'Трутовик', ['mushroom_cluster']),
  tree('Rock_Medium_1.gltf', 'Валун', ['boulder']),
  tree('Rock_Medium_2.gltf', 'Плоский валун', ['boulder']),
  tree('Rock_Medium_3.gltf', 'Расколотый валун', ['boulder']),
  tree('Pebble_Round_3.gltf', 'Округлый камень', ['rock_small']),
  tree('Pebble_Square_4.gltf', 'Угловатый камень', ['rock_small']),
])

const dungeon = (file, label, category, assetIds, extra = {}) => ({ file, label, category, assetIds, ...extra })

export const KAYKIT_SELECTION = Object.freeze([
  dungeon('barrel_large.gltf.glb', 'Бочка', 'Хранилища', ['barrel']),
  dungeon('barrel_small.gltf.glb', 'Небольшая бочка', 'Хранилища', ['barrel']),
  dungeon('barrel_small_stack.gltf.glb', 'Штабель бочек', 'Хранилища', ['barrel_stack']),
  dungeon('keg.gltf.glb', 'Бочонок на козлах', 'Хранилища', ['keg']),
  dungeon('box_small.gltf.glb', 'Окованный ящик', 'Хранилища', ['crate']),
  dungeon('box_large.gltf.glb', 'Большой окованный ящик', 'Хранилища', ['crate']),
  dungeon('box_stacked.gltf.glb', 'Груда ящиков и бочонок', 'Хранилища', ['crate_stack']),
  dungeon('crates_stacked.gltf.glb', 'Стопка ящиков', 'Хранилища', ['crate_stack']),
  // Крышка — отдельный узел с осью на задней кромке: клиент поворачивает узел hinge-lid.
  dungeon('chest.glb', 'Сундук', 'Хранилища', ['chest'], { nodeNames: { chest_lid: 'hinge-lid' } }),
  dungeon('chest_gold.glb', 'Сундук с золотой окантовкой', 'Хранилища', ['chest'], { nodeNames: { chest_gold_lid: 'hinge-lid' } }),
  dungeon('torch_mounted.gltf.glb', 'Настенный факел', 'Освещение и декор', ['torch_wall']),
  dungeon('pillar.gltf.glb', 'Каменная колонна', 'Храм', ['pillar']),
  dungeon('coin_stack_large.gltf.glb', 'Груда монет', 'Утварь', ['coin_pile']),
  dungeon('coin_stack_medium.gltf.glb', 'Столбики монет', 'Утварь', ['coin_pile']),
  dungeon('rubble_large.gltf.glb', 'Груда обломков', 'Пещера', ['rubble_heap']),
  dungeon('rubble_half.gltf.glb', 'Осыпь камней', 'Пещера', ['rubble_heap']),
])

/**
 * Могила реестра занимает 2×1 и в собственной модели `sk-grave` повёрнута
 * надгробием к −Z. Здесь холм и надгробие собраны из двух файлов набора
 * в одну модель с тем же расположением надгробия; yaw 90 кладёт её вдоль
 * длинной стороны футпринта.
 */
const graveWith = (name, label, mound, stone, translation) => ({
  file: mound, name, label, category: 'Склеп', assetIds: ['grave'], yaw: 90,
  parts: [{ file: stone, translation }],
})

export const GRAVEYARD_SELECTION = Object.freeze([
  graveWith('grave-round', 'Могила с круглым надгробием', 'grave.glb', 'gravestone-round.glb', [0, 0, -0.66]),
  graveWith('grave-cross', 'Могила с каменным крестом', 'grave.glb', 'gravestone-cross.glb', [0, 0, -0.7]),
  graveWith('grave-decorative', 'Могила с резным надгробием', 'grave-border.glb', 'gravestone-decorative.glb', [0, 0, -0.74]),
  graveWith('grave-broken', 'Заброшенная могила', 'grave-border.glb', 'gravestone-broken.glb', [0, 0, -0.76]),
  { file: 'crypt.glb', label: 'Каменный саркофаг', category: 'Склеп', assetIds: ['sarcophagus'], yaw: 90 },
  { file: 'urn-round.glb', label: 'Круглая урна', category: 'Склеп', assetIds: ['urn'] },
  { file: 'urn-square.glb', label: 'Гранёная урна', category: 'Склеп', assetIds: ['urn'] },
  { file: 'debris.glb', label: 'Каменные обломки', category: 'Пещера', assetIds: ['rubble_heap'] },
])

export const ENVIRONMENT_PACKS = /** @type {readonly EnvironmentPack[]} */ (Object.freeze([
  {
    id: 'nature',
    family: 'quaternius-nature',
    keyPrefix: 'qn',
    title: 'Stylized Nature MegaKit (Standard) — Quaternius',
    source: {
      url: 'https://quaternius.itch.io/stylized-nature-megakit',
      license: 'CC0-1.0',
      author: 'Quaternius',
      archive: 'Stylized_Nature_MegaKit_Standard.zip',
      archiveSha256: '298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9',
    },
    archivePath: 'Stylized_Nature_MegaKit_Standard.zip',
    directoryPath: 'Stylized_Nature_MegaKit_Standard/glTF',
    inputRoot: '..',
    licenseFile: '../License_Standard.txt',
    textureSide: natureTextureSide,
    selection: NATURE_SELECTION,
  },
  {
    id: 'kaykit',
    family: 'kaykit-dungeon',
    keyPrefix: 'kk',
    title: 'KayKit : Dungeon Remastered (1.0) — Kay Lousberg',
    source: {
      url: 'https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0',
      license: 'CC0-1.0',
      author: 'Kay Lousberg',
      archive: 'KayKit-Dungeon-Remastered-1.0-b0ca9bd.zip',
      archiveSha256: 'e96a65ce4040b6b630f04470a60fd523d621c124cfbad062809cf7b94ccf714b',
    },
    archivePath: 'KayKit-Dungeon-Remastered-1.0-b0ca9bd.zip',
    directoryPath: 'KayKit-Dungeon-Remastered-1.0-b0ca9bd/KayKit-Dungeon-Remastered-1.0-b0ca9bd96a8072ab36a3a5464f00ed1e06a16d07/addons/kaykit_dungeon_remastered/Assets/gltf',
    inputRoot: '..',
    licenseFile: '../LICENSE.txt',
    textureSide: kaykitTextureSide,
    selection: KAYKIT_SELECTION,
  },
  {
    id: 'graveyard',
    family: 'kenney-graveyard',
    keyPrefix: 'kg',
    title: 'Graveyard Kit (5.0) — Kenney',
    source: {
      url: 'https://kenney.nl/assets/graveyard-kit',
      license: 'CC0-1.0',
      author: 'Kenney',
      archive: 'kenney_graveyard-kit_5.0.zip',
      archiveSha256: '1a93613f2e5675f3310acf49ec9ef13ae7adeb756ac3b205bfb6cc9311a81062',
    },
    archivePath: 'kenney_graveyard-kit_5.0.zip',
    directoryPath: 'kenney_graveyard-kit_5.0/Models/GLB format',
    inputRoot: '../..',
    licenseFile: '../../License.txt',
    palette: 'graveyard-muted',
    textureSide: graveyardTextureSide,
    selection: GRAVEYARD_SELECTION,
  },
]))

/**
 * Собственные модели `skazanie`, чью привязку забрали варианты наборов выше.
 * Модели остаются в библиотеке без assetIds: их файлы и история сохранены,
 * но генерация больше не смешивает два стиля в одном помещении.
 */
export const SUPERSEDED_AUTHORED_KEYS = Object.freeze([
  'sk-tree-dead', 'sk-pillar', 'sk-grave', 'sk-household-urn', 'sk-rubble-heap',
  'sk-household-barrel-stack', 'sk-household-crate-stack',
])

export const GRAVEYARD_PALETTE_NOTICE = 'Colormap перекрашен для «Сказания»: сиреневый камень — в тёплый серый, мятный металл — в тёмное железо, оранжевое дерево и глина приглушены.'

/** @param {number} r @param {number} g @param {number} b @returns {[number, number, number]} */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

/** @param {number} h @param {number} s @param {number} l @returns {[number, number, number]} */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m]
}

/**
 * Приглушает один цвет colormap Graveyard Kit. Набор раскрашен под мультфильм:
 * сиреневый камень, мятный металл, рыжее дерево. Холодные оттенки камня
 * становятся тёплым серым, зелёные — тёмным железом, тёплые теряют насыщенность.
 *
 * @param {number} red @param {number} green @param {number} blue 0…255
 * @returns {[number, number, number]}
 */
export function muteGraveyardColor(red, green, blue) {
  const [h, s, l] = rgbToHsl(red / 255, green / 255, blue / 255)
  let next
  if (s < 0.08) next = hslToRgb(35, s * 0.5, l * 0.8)
  else if (h >= 190 && h < 300) next = hslToRgb(36, Math.min(0.08, s * 0.2), l * 0.7)
  else if (h >= 80 && h < 190) next = hslToRgb(150, 0.08, Math.min(0.3, l * 0.45))
  else next = hslToRgb(h < 16 || h >= 300 ? 14 : Math.min(h, 28), s * 0.4, l * 0.52)
  return /** @type {[number, number, number]} */ (next.map((value) => Math.max(0, Math.min(255, Math.round(value * 255)))))
}

/** @param {{width: number, height: number, data: Uint8Array}} image */
export function applyPackPalette(image, palette) {
  if (palette !== 'graveyard-muted') throw new Error(`Неизвестная палитра набора: ${palette}`)
  const data = new Uint8Array(image.data)
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = muteGraveyardColor(data[index], data[index + 1], data[index + 2])
    data[index] = r; data[index + 1] = g; data[index + 2] = b
  }
  return { width: image.width, height: image.height, data }
}

/** Имя модели набора; составная модель называется явно. */
export function packModelName(model) {
  return model.name ?? model.file.replace(/\.gltf\.glb$|\.glb$|\.gltf$/u, '')
}

/** Имя файла выпуска без расширения: то же преобразование, что у Fantasy Props и Nature Kit. */
export function packModelSlug(model) {
  return packModelName(model)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^a-zA-Z0-9_-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/gu, '')
    .toLowerCase()
}

/** Ключ записи manifest: `qn-common_tree_1`, `kk-barrel_large`, `kg-grave-round`. */
export function packModelKey(pack, model) {
  return `${pack.keyPrefix}-${packModelSlug(model)}`
}
