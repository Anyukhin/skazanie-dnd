import '../../../fixtures-env.mjs'
// Корпус генераторов сцен → `fixtures/corpus-prop-placement.json.gz` и
// `fixtures/corpus-scene-dressing.json.gz`.
//
// Настоящие генераторы JS (`generateSceneGeometry`, `buildThemedScene`,
// `generateBuildingScene`, `generateAresFortressScene`) прогоняются по темам,
// местам, сидам, этажам и программам сцен корпуса
// `test/fixtures/scene-programs/corpus.json`; перехват модулей (`recorder.mjs`)
// пишет каждый вызов функций sk-props: карту до вызова, аргументы и карту
// после. Затем каждый вызов повторяется в JS на прочитанной карте — ровно
// том входе, который увидит Rust, — и в эталон идёт хеш итога, ответ и отказ.
// Карта на входе, совпадающая с итогом прежнего вызова того же файла,
// пишется ссылкой `from`. Файлы сжаты gzip: карты повторяются и сжимаются в
// десяток раз.
//
// Запуск: node rust/crates/sk-props/fixtures/gen-corpus.mjs
import { readFileSync } from 'node:fs'

import { calls, decodeArgs, setRecording } from './recorder.mjs'
import * as pp from '../../../../server/prop-placement.mjs'
import * as sd from '../../../../server/scene-dressing.mjs'
import * as t from '../../../../server/tactical-map.mjs'
import { encodeJs, hash, mulberry32, restore, runOn, writeFixture } from './common.mjs'

const { generateSceneGeometry } = await import('../../../../server/adventure-director.mjs')
const { buildThemedScene } = await import('../../../../server/scene-themes.mjs')
const { generateBuildingScene, generateAresFortressScene } = await import('../../../../server/building-generator.mjs')
const { sceneMapRequirementsFor } = await import('../../../../server/scene-requirements.mjs')

const random = mulberry32(0xc0_4b_05)
const pick = (list) => list[Math.floor(random() * list.length)]

const failures = []
function attemptScene(label, build) {
  try {
    build()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

// --- прогоны генераторов -------------------------------------------------------------

const locations = ['Таверна', 'Храм', 'Склеп', 'Подземелье', 'Пещера', 'Тёмный лес', 'Дорога', 'Кладбище', 'Деревня', 'Город', 'Замок', 'Мост через ущелье', 'Порт', 'Кузница', 'Рынок', 'Руины', 'Болото', 'Лавка алхимика', 'Казарма', 'Мельница', 'Конюшня', 'Тюрьма', 'Башня мага', 'Пустыня', 'Зимний лес']
for (const location of locations) {
  for (let index = 0; index < 5; index += 1) {
    const input = { location, seed: `corpus:${location}:${index}`, useLibrary: false }
    if (index === 3) input.entrySide = pick(['east', 'north', 'south', 'west'])
    attemptScene(location, () => generateSceneGeometry(input))
  }
}
attemptScene('levels', () => generateSceneGeometry({ location: 'Таверна', seed: 'levels', locationId: 'loc-tavern', levels: [{ offset: 1, hint: 'спальни и кабинет хозяина' }, { offset: -1, hint: 'винный погреб' }], useLibrary: false }))
attemptScene('tower', () => generateSceneGeometry({ location: 'Башня мага', seed: 'tower', locationId: 'loc-tower', levels: [{ offset: 1, hint: 'кабинет' }, { offset: 2, hint: 'обсерватория' }], useLibrary: false }))

const programCorpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
for (const scene of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
  for (const seed of [`program:${scene.id}`, `program-2:${scene.id}`]) {
    attemptScene(scene.id, () => generateSceneGeometry({ location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '', requirements: program?.items ?? [], program, seed, useLibrary: false }))
  }
}

// Сцены переносимых тестов обстановки и опор.
const tavern = { width: 36, height: 30, location: 'Трактир трёх дорог', theme: 'таверна', design: { building_use: 'tavern', architecture: 'wood' } }
const temple = { width: 36, height: 30, location: 'Храм Утренней звезды', theme: 'храм', design: {} }
const village = { width: 44, height: 38, location: 'Деревня Кленовка', theme: 'деревня', design: { topology: 'organic', architecture: 'wood' } }
for (const seed of ['brawl-a', 'brawl-b', 'brawl-c']) {
  attemptScene('brawl', () => buildThemedScene({ ...tavern, seed, description: 'После вчерашней драки трактирщик ещё не прибрался.' }))
  attemptScene('tavern', () => buildThemedScene({ ...tavern, seed }))
}
for (const seed of ['temple-a', 'temple-b']) {
  attemptScene('temple', () => buildThemedScene({ ...temple, seed }))
  attemptScene('temple-ruined', () => buildThemedScene({ ...temple, seed, description: 'Заброшенный храм, свод местами обвалился.' }))
}
for (const seed of ['village-a', 'village-b']) {
  attemptScene('village', () => buildThemedScene({ ...village, seed }))
  attemptScene('village-burned', () => buildThemedScene({ ...village, seed, description: 'На краю деревни — пепелище сгоревшего двора.' }))
}
attemptScene('village-winter', () => buildThemedScene({ ...village, seed: 'village-a', design: { ...village.design, climate: 'cold' } }))
const dressed = [
  { location: 'Поляна в Чернолесье', theme: 'лесная поляна' },
  { location: 'Поляна в Чернолесье', theme: 'лесная поляна', description: 'Остывшее кострище, вокруг волчьи следы.' },
  { location: 'Развалины старой заставы', theme: 'руины у дороги' },
  { location: 'Старое кладбище', theme: 'кладбище' },
  { location: 'Пещера контрабандистов', theme: 'пещера' },
  { location: 'Фамильный склеп', theme: 'склеп', description: 'Сектанты проводили здесь обряд.' },
  { location: 'Снежный перевал', theme: 'зимний лес', design: { climate: 'cold' }, description: 'Древние руины сторожевой башни.' },
  { location: 'Красные барханы', theme: 'дорога через пустыню', design: { climate: 'arid' } },
  { location: 'Тракт', theme: 'дорога', description: 'У обочины опрокинута телега, рядом могила.' },
  { location: 'Грот', theme: 'пещера', description: 'Сырой грот с грибами, здесь сгинул искатель.' },
  { location: 'Склеп', theme: 'склеп', description: 'Разграбленный склеп, мародёры вскрыли урны; поминальные свечи предков.' },
]
for (const scene of dressed) for (const seed of ['dress-a', 'dress-b', 'dress-c']) {
  attemptScene(scene.location, () => buildThemedScene({ seed, width: 36, height: 30, location: scene.location, theme: scene.theme, design: scene.design ?? {}, description: scene.description ?? '' }))
}
for (const themeId of ['building', 'crypt', 'dungeon', 'cave', 'temple', 'forest', 'road', 'graveyard', 'settlement']) {
  for (const seed of ['interior-a', 'interior-b']) attemptScene(themeId, () => buildThemedScene({ themeId, seed, locationId: `supports-${themeId}`, width: 26, height: 26 }))
}
for (const input of [
  { location: 'Заснеженный лес', theme: 'зимний лес в глубоком снегу', seed: 'climate-cold' },
  { location: 'Пустынная дорога', theme: 'дорога через пустыню, барханы', seed: 'climate-arid' },
  { location: 'Гнилое болото', theme: 'топкое болото с камышом', seed: 'climate-wet' },
  { location: 'Лесная опушка', theme: 'светлый лес', seed: 'climate-temperate' },
  { location: 'Лагерь разбойников', theme: 'лесной лагерь разбойников', seed: 'camp-set' },
  { location: 'Портовый квартал', theme: 'гавань у пристани', settlementType: 'town', seed: 'harbor-set' },
  { location: 'Дом мага', theme: 'башня мага с лабораторией', seed: 'mage-set' },
]) attemptScene(input.location, () => generateSceneGeometry(input))
for (const seed of ['s0', 's6', 's10', '39', '200', 'a', 'b', 'c', 'd', 'e']) attemptScene('building', () => generateBuildingScene({ seed }))
for (const seed of ['s6', 's10', 's189', '39', '200']) attemptScene('fortress', () => generateAresFortressScene({ seed }))
setRecording(false)

// --- повтор и запись ---------------------------------------------------------------------

const PROP_PLACEMENT = new Set(['placeProps', 'ensurePropAccess', 'placeRequiredProps', 'placeColonnade', 'attachPropSupports'])
const real = {
  placeProps: (map, args) => pp.placeProps(map, ...args),
  ensurePropAccess: (map) => pp.ensurePropAccess(map),
  placeRequiredProps: (map, args) => pp.placeRequiredProps(map, ...args),
  placeColonnade: (map, args) => pp.placeColonnade(map, ...args),
  attachPropSupports: (map) => pp.attachPropSupports(map),
  placeVignettes: (map, args) => sd.placeVignettes(map, ...args),
  roughenGround: (map, args) => sd.roughenGround(map, ...args),
  markLowFurniture: (map, args) => sd.markLowFurniture(map, ...args),
  placeRuins: (map, args) => sd.placeRuins(map, ...args),
  placeRuinsField: (map, args) => sd.placeRuinsField(map, ...args),
}

function replay(selected) {
  const entries = []
  const byOutput = new Map()
  let unstable = 0
  for (const call of selected) {
    if (call.fn === 'vignettesNamedBy') {
      const [set, text] = decodeArgs(call.args)
      entries.push({ fn: call.fn, args: call.args, result: sd.vignettesNamedBy(set, text) })
      continue
    }
    const inputKey = hash(t.serializeTacticalMap(restore(call.before)))
    const input = byOutput.has(inputKey) ? { from: byOutput.get(inputKey) } : { map: call.before }
    const map = restore(call.before)
    const args = decodeArgs(call.args)
    const record = runOn(map, (target) => real[call.fn](target, args))
    // Сравнение с картой генератора — через то же чтение: сериализация зон
    // генератора и прочитанной карты может различаться порядком ключей.
    if (record.hash !== hash(t.serializeTacticalMap(restore(call.after)))) unstable += 1
    entries.push({ fn: call.fn, input, args: call.args, ...record })
    byOutput.set(record.hash, entries.length - 1)
  }
  return { entries, unstable }
}

const placement = replay(calls.filter((call) => PROP_PLACEMENT.has(call.fn)))
const dressing = replay(calls.filter((call) => !PROP_PLACEMENT.has(call.fn)))
const count = (entries) => Object.entries(entries.reduce((total, entry) => ({ ...total, [entry.fn]: (total[entry.fn] ?? 0) + 1 }), {})).map(([fn, n]) => `${fn} ${n}`).join(', ')
console.log('prop-placement:', count(placement.entries), '— на карте генератора и после чтения расходятся', placement.unstable)
console.log('scene-dressing:', count(dressing.entries), '— на карте генератора и после чтения расходятся', dressing.unstable)
if (failures.length) console.log('генератор отказал:', failures)

writeFixture(new URL('./corpus-prop-placement.json.gz', import.meta.url), { calls: placement.entries.map(encodeJs) }, { gzip: true })
writeFixture(new URL('./corpus-scene-dressing.json.gz', import.meta.url), { calls: dressing.entries.map(encodeJs) }, { gzip: true })
