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
const { MAP_PREVIEW_PRESETS, auditTacticalMap } = await import('../../../../server/map-quality.mjs')
const { sceneMapRequirementsFor, sceneRequirementsFromText } = await import('../../../../server/scene-requirements.mjs')

/** Какие функции уже перенесены и записываются. */
const RECORD = new Set(['thinWalls', 'applyRoomFloors', 'raiseDais', 'deepestRoom', 'auditTacticalMap', 'programReport'])

const inputs = sceneInputs(MAP_PREVIEW_PRESETS, sceneMapRequirementsFor, sceneRequirementsFromText)
// Карта, на которой проверяют программу сцены, — почти готовая карта
// генератора: с неё же снимается и аудит.
const recording = startRecording(t, RECORD, { programReport: (map) => ({ audit: auditTacticalMap(map) }) })
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

// Бюджет эталона: карты аудита и проверки программы крупные (с предметами),
// поэтому из них берётся каждая третья и каждая четвёртая.
const SAMPLE = { auditTacticalMap: 3, programReport: 4 }
const seen = {}
const keep = (call) => {
  seen[call.name] = (seen[call.name] ?? 0) + 1
  return (seen[call.name] - 1) % (SAMPLE[call.name] ?? 1) === 0
}
const chains = []
for (const run of runs) {
  for (const chain of chainsOf(run.calls, { keep })) {
    chains.push({
      run: run.label,
      before: chain.before,
      calls: chain.calls.map((call) => ({ fn: call.fn, input: call.input, result: call.result, after: hashText(call.after), agrees: call.agrees, agreesAfterRead: call.agreesAfterRead, ...(call.extra === undefined ? {} : { extra: call.extra }) })),
    })
  }
}
const disagreements = chains.flatMap((chain) => chain.calls.filter((call) => !call.agrees).map((call) => `${chain.run}:${call.fn}`))
if (disagreements.length) console.log(`  на копии карты иначе, чем в памяти: ${disagreements.length} (${disagreements.slice(0, 5).join(', ')})`)
const real = chains.flatMap((chain) => chain.calls.filter((call) => !call.agreesAfterRead).map((call) => `${chain.run}:${call.fn}`))
if (real.length) console.log(`  и после чтения тоже: ${real.length} (${real.slice(0, 5).join(', ')})`)

writeFixture(new URL('./generator-calls.json', import.meta.url), {
  recorded: [...RECORD],
  chains,
})
