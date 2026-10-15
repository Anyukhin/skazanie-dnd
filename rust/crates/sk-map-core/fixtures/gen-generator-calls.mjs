import '../../../fixtures-env.mjs'
import { chainsOf, startRecording } from './recorder.mjs'
import { hashText, writeFixture } from './common.mjs'
import { sceneInputs } from './scenes.mjs'
// Эталон вызовов sk-map-core изнутри настоящих генераторов карт:
//
//   node rust/crates/sk-map-core/fixtures/gen-generator-calls.mjs
//
// Корпус сцен (`scenes.mjs`) строится `generateSceneGeometry` без библиотеки
// карт; каждый вызов записанных функций сохраняется цепочкой по карте:
// первая запись цепочки несёт сериализованную карту, следующие — только
// входы, если карта между вызовами не менялась (Rust продолжает своей картой).
// Ожидаемая карта после вызова — SHA-256 строки `JSON.stringify` её
// сериализации, результат — целиком.

const t = await import('../../../../server/tactical-map.mjs')
const { generateSceneGeometry } = await import('../../../../server/adventure-director.mjs')
const { MAP_PREVIEW_PRESETS } = await import('../../../../server/map-quality.mjs')
const { sceneMapRequirementsFor, sceneRequirementsFromText } = await import('../../../../server/scene-requirements.mjs')

/** Какие функции уже перенесены и записываются. */
const RECORD = new Set(['thinWalls'])

const inputs = sceneInputs(MAP_PREVIEW_PRESETS, sceneMapRequirementsFor, sceneRequirementsFromText)
const recording = startRecording(t, RECORD)
const runs = []
for (const { label, input } of inputs) {
  const start = recording.calls.length
  try {
    generateSceneGeometry({ ...input, useLibrary: false })
  } catch (error) {
    console.log(`  генератор отказал на ${label}: ${error.message}`)
  }
  runs.push({ label, calls: recording.calls.slice(start) })
}
recording.stop()

const chains = []
for (const run of runs) {
  for (const chain of chainsOf(run.calls)) {
    chains.push({
      run: run.label,
      before: chain.before,
      calls: chain.calls.map((call) => ({ fn: call.fn, input: call.input, result: call.result, after: hashText(call.after), agrees: call.agrees })),
    })
  }
}
const disagreements = chains.flatMap((chain) => chain.calls.filter((call) => !call.agrees).map((call) => `${chain.run}:${call.fn}`))
if (disagreements.length) console.log(`  на копии карты иначе, чем в памяти: ${disagreements.length} (${disagreements.slice(0, 5).join(', ')})`)

writeFixture(new URL('./generator-calls.json', import.meta.url), {
  recorded: [...RECORD],
  chains,
})
