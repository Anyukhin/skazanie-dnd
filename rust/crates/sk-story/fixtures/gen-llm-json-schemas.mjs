import '../../../fixtures-env.mjs'
// Эталон server/llm-json-schemas.mjs для Rust:
//
//   node rust/crates/sk-story/fixtures/gen-llm-json-schemas.mjs
//
// Каждый экспорт — строкой `JSON.stringify`: Rust сверяет схему байт в байт,
// вместе с порядком ключей.
import { writeFileSync } from 'node:fs'

const S = await import('../../../../server/llm-json-schemas.mjs')

const names = ['DIRECTOR_SCENE_RESOLUTIONS', 'DIRECTOR_INTENT_JSON_SCHEMA', 'NPC_SOCIAL_STANCES', 'NPC_PROMISE_DIRECTIONS', 'NPC_SOCIAL_RESPONSE_JSON_SCHEMA', 'CAMPAIGN_CREATION_JSON_SCHEMA', 'HERO_HOOKS_JSON_SCHEMA']
const missing = Object.keys(S).filter((name) => !names.includes(name))
if (missing.length) throw new Error(`новые экспорты без эталона: ${missing.join(', ')}`)
const fixture = Object.fromEntries(names.map((name) => [name, JSON.stringify(S[name])]))
writeFileSync(new URL('./llm-json-schemas.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`llm-json-schemas.json: ${names.length} экспортов`)
