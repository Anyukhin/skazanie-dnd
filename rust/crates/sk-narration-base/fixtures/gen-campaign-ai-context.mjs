// Эталон для `campaign_ai_context.rs`: нормализация настроек, словари и то,
// что видно внутри `runWithCampaignAiSettings`.
//
//   node rust/crates/sk-narration-base/fixtures/gen-campaign-ai-context.mjs
import { writeFileSync } from 'node:fs'

import {
  DEFAULT_IMPROV_MODE,
  DEFAULT_REASONING_LEVEL,
  IMPROV_MODES,
  NARRATOR_GENERATION_PARAMETERS,
  NARRATOR_STYLES,
  REASONING_LEVELS,
  campaignReasoningFor,
  currentCampaignAiSettings,
  currentCampaignModel,
  currentImprovMode,
  currentNarratorGenerationParameters,
  currentNarratorStyle,
  currentNarratorStyleInstruction,
  normalizeImprovMode,
  normalizeNarratorStyle,
  normalizeReasoningLevel,
  runWithCampaignAiSettings,
} from '../../../../server/campaign-ai-context.mjs'

const inputs = ['neutral', 'FORMAL', ' ironic ', 'story', 'CHAOS', ' chaos\n', 'auto', 'Thoughtful', 'DEEP', 'ultra', '', null, 7, true, ['deep'], { id: 'deep' }, 'constructor', '__proto__', 'İronic']
const normalize = inputs.map((value) => ({
  value,
  style: normalizeNarratorStyle(value),
  improv: normalizeImprovMode(value),
  reasoning: normalizeReasoningLevel(value),
}))

function snapshot() {
  return {
    settings: currentCampaignAiSettings(),
    model: currentCampaignModel(),
    style: currentNarratorStyle(),
    improv: currentImprovMode(),
    instruction: currentNarratorStyleInstruction(),
    parameters: currentNarratorGenerationParameters(),
    reasoning: ['openai/gpt-6-luna', 'z-ai/glm-5.3-flash', '', null, ' openai/gpt-6-luna'].flatMap((model) => (
      ['narrator', 'director', 'npc', '', undefined].map((role) => ({ model, role: role ?? null, value: role === undefined ? campaignReasoningFor(model) : campaignReasoningFor(model, role) }))
    )),
  }
}

const settings = [
  null, 'строка', [], { model: 'openai/gpt-6-luna', reasoningLevel: 'deep' }, { model: ' openai/gpt-6-luna ', reasoningLevel: 'THOUGHTFUL', narratorStyle: 'Formal' },
  { model: 'openai/gpt-6-luna', reasoningLevel: 'auto', improvMode: 'chaos', narratorStyle: 'ironic' }, { model: '', reasoningLevel: 'deep' },
  { model: 'z-ai/glm-5.3-flash', reasoningLevel: 'deep', improvMode: 'мусор', narratorStyle: 5 }, { model: 42, reasoningLevel: null }, {},
]
const contexts = settings.map((value) => ({ value, inside: runWithCampaignAiSettings(value, snapshot) }))
const fixture = {
  narratorStyles: NARRATOR_STYLES,
  improvModes: IMPROV_MODES,
  reasoningLevels: REASONING_LEVELS,
  defaults: { improv: DEFAULT_IMPROV_MODE, reasoning: DEFAULT_REASONING_LEVEL },
  generation: NARRATOR_GENERATION_PARAMETERS,
  normalize,
  outside: snapshot(),
  contexts,
}
writeFileSync(new URL('./campaign-ai-context.json', import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`)
console.log(`нормализаций ${normalize.length}, контекстов ${contexts.length}`)
