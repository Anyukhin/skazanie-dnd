// Эталон для `prompt_descriptors.rs`: реестр ролей и поиск по prompt_id.
// Чтение `server/` и `prompts/` сверяется вживую в модульных тестах: их
// содержимое меняется вместе с кодом, и снимок здесь быстро устарел бы.
//
//   node rust/crates/sk-narration-base/fixtures/gen-prompt-descriptors.mjs
import { writeFileSync } from 'node:fs'

import { PROMPT_DESCRIPTORS, availablePromptIds, descriptorForPromptId } from '../../../../server/prompt-descriptors.mjs'

const ids = [...availablePromptIds(), 'director/v1', '', 'narrator/v99', 'NARRATOR/V14']
const lookups = ids.map((promptId) => ({ promptId, descriptor: descriptorForPromptId(promptId) }))
writeFileSync(new URL('./prompt-descriptors.json', import.meta.url), `${JSON.stringify({ descriptors: PROMPT_DESCRIPTORS, lookups }, null, 1)}\n`)
console.log(`дескрипторов ${PROMPT_DESCRIPTORS.length}, поисков ${lookups.length}`)
