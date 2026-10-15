// Таблица переноса сервера на Rust: каждый модуль `server/` — целевой крейт,
// волна и статус (крейт существует в `rust/crates`). Пишет
// `rust/PORT-STATUS.md`; карта модулей — `PLAN` ниже, граф импортов — из кода.
//
//   node tools/rust-port-status.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Волна → крейт → модули (путь от `server/` без `.mjs`). */
const PLAN = [
  [0, 'sk-dice', ['dice-service']],
  [0, 'sk-store', ['event-store', 'map-store', 'store', 'authoritative-executor']],
  [0, 'sk-server', ['rate-window']],
  [1, 'sk-ruleset', ['ruleset-config', 'rules/core', 'rules/actors', 'campaign-ruleset', 'character-progression', 'character-creation-class-options', 'character-creation-feats', 'character-creation-catalog', 'backgrounds', 'lockpicking']],
  [1, 'sk-geometry', ['actor-footprint', 'circular-area-geometry', 'scene-graph', 'world-map']],
  [1, 'sk-narration-base', ['deterministic-narration', 'combat-phrases', 'concentration-end-reasons', 'narrator-craft-quality', 'projection-integrity', 'prompt-descriptors', 'model-style-profiles', 'campaign-ai-context', 'campaign-inspiration', 'clarification-registry', 'contracts', 'speech-input']],
  [1, 'sk-society', ['underworld', 'retention-context', 'quest-consequences', 'campaign-stories', 'law-and-order', 'reputation-policy', 'parley', 'post-commit-coordinator', 'world-ontology']],
  [1, 'sk-scene-base', ['scene-requirements', 'scene-map-design', 'detail-props', 'asset-registry', 'environment-catalog-revision', 'equipment-visuals', 'actor-appearance', 'talespire-slab']],
  [1, 'sk-scenario', ['campaign-scenario', 'party-exit-intent', 'campaign-controls']],
  [1, 'sk-combat-base', ['legendary-actions', 'dndsu-2014-content', 'reaction-preferences', 'combat-lab-encounter-math', 'monster-actions']],
  [1, 'sk-rulepack', ['rule-pack', 'rule-retriever']],
  [1, 'sk-infra', ['roll-registry', 'usage-ledger', 'narration-stream', 'backup-service', 'image-generation', 'asset-preparation']],
  [2, 'sk-combat-content', ['combat-spells', 'combat-lab-monsters', 'scene-hazards', 'scene-hazard-narration', 'wild-shape', 'combat-actions', 'character-build', 'spell-override-audit', 'spell-acceptance-audit']],
  [2, 'sk-items', ['item-catalog', 'item-dawn-recharge', 'loot-tables', 'pickpocket']],
  [2, 'sk-social', ['npc-social', 'npc-social-check']],
  [2, 'sk-memory', ['world-memory', 'party-decision']],
  [2, 'sk-agents-base', ['llm-client', 'architect-usage']],
  [3, 'sk-chargen', ['starter-kit', 'character-creation-wealth', 'npc-portraits', 'location-illustrations']],
  [3, 'sk-heroes', ['character-creation-phb', 'authored-npc']],
  [3, 'sk-economy', ['merchant-economy', 'item-appraisal', 'item-instances', 'merchant-narration', 'shop-assembler', 'scene-commerce', 'enemy-loadouts', 'npc-equipment']],
  [3, 'sk-attention', ['scenario-attention', 'improvised-effects']],
  [4, 'sk-tactical', ['scene-interactions', 'tactical-map', 'combat-bounds', 'reveal-delta', 'reveal-transport', 'action-hints']],
  [5, 'sk-map-core', ['map-quality', 'thin-walls', 'room-floors', 'scene-features', 'dynamic-map', 'authored-location-maps', 'combat-lab-maps']],
  [5, 'sk-props', ['prop-placement', 'scene-dressing']],
  [6, 'sk-buildings', ['building-generator']],
  [6, 'sk-settlements', ['settlement-generator', 'graph-layout', 'scene-program-layout']],
  [6, 'sk-encounters', ['encounter-assembler', 'agent-context']],
  [6, 'sk-npc-world', ['npc-positioning', 'tavern-life', 'blessings', 'beast-taming']],
  [7, 'sk-world-life', ['captives', 'courier-letters', 'world-offices']],
  [7, 'sk-items-life', ['item-lifecycle', 'content-integrity']],
  [7, 'sk-themes', ['scene-themes']],
  [8, 'sk-character', ['character-lifecycle', 'encounter-rewards', 'quest-decisions']],
  [8, 'sk-world-time', ['level-generator', 'weather', 'world-deeds', 'world-template-catalog']],
  [9, 'sk-world-story', ['autonomous-campaign', 'offscreen-world', 'scenario-knight', 'scene-canon', 'talespire-import']],
  [9, 'sk-narration', ['combat-narration', 'scene-narration', 'encounter-narration', 'scene-summary']],
  [10, 'sk-story', ['campaign-dialogues', 'campaign-loop-policy', 'intent-parser', 'llm-json-schemas', 'map-library']],
  [11, 'sk-director', ['adventure-director', 'campaign-lifecycle', 'scene-memory', 'director-scene-transition', 'loot-containers']],
  [13, 'sk-rules', ['rules-engine', 'rules/tactical-geometry']],
  [14, 'sk-tactics', ['adjudicator', 'combat-forecast-view', 'party-tactics', 'security', 'cutover-audit', 'combat-lab-setup', 'combat-lab']],
  [15, 'sk-projection', ['viewer-projection', 'trace-store']],
  [15, 'sk-agents', ['campaign-bootstrap', 'campaign-recap', 'creative-director', 'hero-hooks', 'lore-author', 'lore-voice', 'npc-controller', 'scene-architect', 'director-agent', 'free-action-adjudication', 'npc-social-controller', 'player-request-router', 'action-adjudicator', 'narrator']],
  [16, 'sk-turns', ['npc-turn-scheduler', 'combat-turn-coordinator']],
  [18, 'sk-orchestrator', ['autonomous-orchestrator', 'game-orchestrator']],
  [20, 'sk-server', ['index', 'routes/map-import-routes', 'routes/combat-lab-routes']],
]

/**
 * Крейты, перенос которых начат, но не закончен: модуль считается перенесённым
 * только в законченном крейте. Убрать крейт отсюда — когда его модули
 * перенесены целиком и проходят свои тесты.
 */
const PARTIAL = {
  'sk-rules': 'каркас Р0 (точки входа, ядро, normalizeCommand, кости, паузы), редьюсер: живучесть, состояния, атака, ход и раунд',
  'sk-server': 'вход, сессии, админка, раздача клиента',
  'sk-character': 'решения по поручениям (quest-decisions)',
}

/** Модули, которые сознательно не переносятся (решение D4 плана). */
const SKIPPED = {
  'rules-corpus': 'запись корпуса паритета — инструмент JS',
  'dev': 'запуск JS-разработки',
  'autonomy-eval': 'стенд оценки JS',
  'migrations/001-event-engine': 'до-событийные комнаты; Rust импортирует событийное хранилище',
  'migrations/run': 'запуск миграций JS',
}

const files = []
for (const dir of ['server', 'server/rules', 'server/routes', 'server/migrations']) {
  const abs = join(root, dir)
  if (!existsSync(abs)) continue
  for (const name of readdirSync(abs)) if (name.endsWith('.mjs')) files.push(posix.join(dir, name).replace(/^server\//, '').replace(/\.mjs$/, ''))
}
const lines = Object.fromEntries(files.map((file) => [file, readFileSync(join(root, 'server', `${file}.mjs`), 'utf8').split('\n').length]))
const assigned = new Map()
for (const [wave, crate, modules] of PLAN) for (const module of modules) assigned.set(module, { wave, crate })
const crates = new Set(readdirSync(join(root, 'rust', 'crates')))

const rows = []
const missing = files.filter((file) => !assigned.has(file) && !SKIPPED[file])
for (const [wave, crate, modules] of PLAN) {
  const status = PARTIAL[crate] ? `начат: ${PARTIAL[crate]}` : crates.has(crate) ? 'перенесён' : 'в очереди'
  const total = modules.reduce((sum, module) => sum + (lines[module] ?? 0), 0)
  rows.push(`| ${wave} | \`${crate}\` | ${status} | ${total} | ${modules.map((module) => `\`${module}\``).join(', ')} |`)
}
const totalLines = files.reduce((sum, file) => sum + lines[file], 0)
const portedLines = [...assigned].filter(([, { crate }]) => crates.has(crate) && !PARTIAL[crate]).reduce((sum, [module]) => sum + (lines[module] ?? 0), 0)
const text = `# Статус переноса сервера на Rust

Сгенерировано \`node tools/rust-port-status.mjs\`. Волна — порядок по графу
импортов JS: модуль переносится, когда перенесены все, что он импортирует.
«Перенесён» значит, что крейт есть в \`rust/crates\` (готовность модулей внутри
крейта — его тесты и отчёт исполнителя).

Строк JS в крейтах, которые уже есть: ${portedLines} из ${totalLines}.

| Волна | Крейт | Статус | Строк JS | Модули \`server/\` |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

Не переносятся: ${Object.entries(SKIPPED).map(([module, reason]) => `\`${module}\` — ${reason}`).join('; ')}.
${missing.length ? `\n**Без крейта:** ${missing.map((module) => `\`${module}\``).join(', ')}\n` : ''}`
writeFileSync(join(root, 'rust', 'PORT-STATUS.md'), text)
console.log(`модулей: ${files.length}, без крейта: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}; перенесено строк: ${portedLines}/${totalLines}`)
