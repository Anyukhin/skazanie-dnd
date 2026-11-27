// Корпус сцен для эталонов sk-map-core: входы `generateSceneGeometry` по
// темам, размерам и сидам — те же, что проверяют `test/map-quality.test.mjs`,
// `test/room-floors.test.mjs`, `test/scene-program-corpus.test.mjs`, — плюс
// стороны входа, этажи и программы сцен корпуса.
import { readFileSync } from 'node:fs'

const SIZES = [{ width: 16, height: 14 }, { width: 26, height: 26 }, { width: 40, height: 32 }]

/**
 * @param {Array<{id: string, input: Record<string, any>}>} presets `MAP_PREVIEW_PRESETS`
 * @param {(texts: string[], options: object) => any} sceneMapRequirementsFor
 * @param {(texts: string[]) => any[]} sceneRequirementsFromText
 */
export function sceneInputs(presets, sceneMapRequirementsFor, sceneRequirementsFromText) {
  const inputs = []
  for (const preset of presets) {
    for (const size of SIZES) {
      for (const seed of ['q1', 'q2']) {
        inputs.push({ label: `${preset.id}/${size.width}x${size.height}/${seed}`, input: { ...preset.input, map: { ...(preset.input.map ?? {}), ...size }, seed: `${preset.id}:${seed}` } })
      }
    }
    for (const seed of ['q3', 'q4']) inputs.push({ label: `${preset.id}/default/${seed}`, input: { ...preset.input, seed: `${preset.input.location}:${seed}` } })
  }
  for (const shape of ['L', 'cross', 'round']) {
    for (const seed of ['q1', 'q2']) {
      inputs.push({ label: `shape:${shape}/${seed}`, input: { location: 'Усадьба Вельских', theme: 'усадьба', seed: `shape:${shape}:${seed}`, map: { width: 30, height: 28, design: { shape } } } })
    }
  }
  inputs.push({ label: 'tower', input: { location: 'Круглая башня мага', theme: 'усадьба', seed: 'tower', map: { width: 30, height: 28 } } })
  const places = [
    ['Кузница Борга', 'кузница'], ['Казарма городской стражи', 'казарма'], ['Кладбище за часовней', 'кладбище'],
    ['Подземелье под замком', 'подземелье'], ['Логово дракона', 'пещера'], ['Лагерь бандитов', 'лесной лагерь'],
    ['Лесная поляна', 'лес'], ['Мост через ущелье', 'мост'], ['Тракт у старого моста', 'дорога'], ['Пустынный оазис', 'оазис'],
    ['Старый склеп', 'склеп'], ['Мастерская гончара', 'мастерская'], ['Водяная мельница у реки', 'мельница'],
  ]
  for (const [location, theme] of places) inputs.push({ label: `place:${location}`, input: { location, theme, seed: `fidelity:${location}` } })
  inputs.push({ label: 'place:hamlet', input: { location: 'Хутор у леса', theme: 'хутор', settlementType: 'village', seed: 'fidelity:Хутор у леса' } })
  inputs.push({ label: 'place:village-mix', input: { location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: 'mix:q1', map: { width: 36, height: 32 } } })
  for (const [location, theme] of [['Подземелье под замком', 'подземелье'], ['Фамильный склеп', 'склеп']]) {
    for (let index = 0; index < 6; index += 1) inputs.push({ label: `loops:${theme}/${index}`, input: { location, theme, seed: `loops:${index}` } })
  }
  const locations = ['Таверна', 'Храм', 'Склеп', 'Подземелье', 'Пещера', 'Тёмный лес', 'Дорога', 'Кладбище', 'Деревня', 'Город', 'Замок', 'Мост через ущелье', 'Порт', 'Кузница', 'Рынок', 'Руины', 'Болото']
  const sides = ['east', 'north', 'south']
  for (const [index, location] of locations.entries()) {
    inputs.push({ label: `side:${location}`, input: { location, seed: `side:${location}`, entrySide: sides[index % sides.length] } })
  }
  inputs.push({ label: 'levels:tavern', input: { location: 'Таверна', seed: 'levels', locationId: 'loc-tavern', levels: [{ offset: 1, hint: 'спальни и кабинет хозяина' }, { offset: -1, hint: 'винный погреб' }] } })
  inputs.push({ label: 'levels:tower', input: { location: 'Башня мага', seed: 'tower', locationId: 'loc-tower', levels: [{ offset: 1, hint: 'кабинет' }, { offset: 2, hint: 'обсерватория' }] } })
  const requirementCases = [
    ['Таверна «Рыжий рог»', 'таверна', 'В зале очаг, четыре стола, у стойки две бочки и сундук хозяина.'],
    ['Лесная поляна', 'лес', 'Костёр, старый дуб и телега торговца.'],
    ['Пещера контрабандистов', 'пещера', 'Ящики, три бочки, сундук и костёр в глубине.'],
    ['Храм Утренней звезды', 'храм', 'Две статуи у алтаря, жаровни горят, у стены котёл.'],
  ]
  for (const [location, theme, text] of requirementCases) {
    inputs.push({ label: `requirements:${location}`, input: { location, theme, seed: `${location}:q1`, requirements: sceneRequirementsFromText([text]) } })
  }
  const corpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
  for (const scene of corpus.scenes) {
    const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
    inputs.push({ label: `corpus:${scene.id}`, input: { location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${scene.id}` } })
  }
  return inputs
}
