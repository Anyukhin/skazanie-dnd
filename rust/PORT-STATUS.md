# Статус переноса сервера на Rust

Сгенерировано `node tools/rust-port-status.mjs`. Волна — порядок по графу
импортов JS: модуль переносится, когда перенесены все, что он импортирует.
«Перенесён» значит, что крейт есть в `rust/crates` (готовность модулей внутри
крейта — его тесты и отчёт исполнителя).

Строк JS в крейтах, которые уже есть: 2173 из 142937.

| Волна | Крейт | Статус | Строк JS | Модули `server/` |
| --- | --- | --- | --- | --- |
| 0 | `sk-dice` | перенесён | 116 | `dice-service` |
| 0 | `sk-store` | перенесён | 2057 | `event-store`, `map-store`, `store` |
| 0 | `sk-server` | начат: вход, сессии, админка, раздача клиента | 70 | `rate-window` |
| 1 | `sk-ruleset` | в очереди | 2876 | `ruleset-config`, `rules/core`, `rules/actors`, `campaign-ruleset`, `character-progression`, `character-creation-class-options`, `character-creation-feats`, `character-creation-catalog`, `backgrounds`, `lockpicking` |
| 1 | `sk-geometry` | в очереди | 1531 | `actor-footprint`, `circular-area-geometry`, `scene-graph`, `world-map` |
| 1 | `sk-narration-base` | в очереди | 2095 | `deterministic-narration`, `combat-phrases`, `concentration-end-reasons`, `narrator-craft-quality`, `projection-integrity`, `prompt-descriptors`, `model-style-profiles`, `campaign-ai-context`, `campaign-inspiration`, `clarification-registry`, `contracts`, `speech-input` |
| 1 | `sk-society` | в очереди | 2517 | `underworld`, `retention-context`, `quest-consequences`, `campaign-stories`, `law-and-order`, `reputation-policy`, `parley`, `post-commit-coordinator`, `world-ontology` |
| 1 | `sk-scene-base` | в очереди | 2497 | `scene-requirements`, `scene-map-design`, `detail-props`, `asset-registry`, `environment-catalog-revision`, `equipment-visuals`, `actor-appearance`, `talespire-slab` |
| 1 | `sk-scenario` | в очереди | 2247 | `campaign-scenario`, `party-exit-intent`, `campaign-controls` |
| 1 | `sk-combat-base` | в очереди | 1041 | `legendary-actions`, `dndsu-2014-content`, `reaction-preferences`, `combat-lab-encounter-math`, `monster-actions` |
| 1 | `sk-rulepack` | в очереди | 888 | `rule-pack`, `rule-retriever` |
| 1 | `sk-infra` | в очереди | 1703 | `roll-registry`, `usage-ledger`, `narration-stream`, `backup-service`, `image-generation`, `asset-preparation` |
| 2 | `sk-combat-content` | в очереди | 3485 | `combat-spells`, `combat-lab-monsters`, `scene-hazards`, `scene-hazard-narration`, `wild-shape`, `combat-actions`, `character-build`, `spell-override-audit`, `spell-acceptance-audit` |
| 2 | `sk-items` | в очереди | 2705 | `item-catalog`, `item-dawn-recharge`, `loot-tables`, `pickpocket` |
| 2 | `sk-social` | в очереди | 1450 | `npc-social`, `npc-social-check` |
| 2 | `sk-memory` | в очереди | 2411 | `world-memory`, `party-decision` |
| 2 | `sk-agents-base` | в очереди | 1060 | `llm-client`, `architect-usage` |
| 3 | `sk-chargen` | в очереди | 2577 | `starter-kit`, `character-creation-phb`, `character-creation-wealth`, `npc-portraits`, `location-illustrations`, `authored-npc` |
| 3 | `sk-economy` | в очереди | 3320 | `merchant-economy`, `item-appraisal`, `item-instances`, `merchant-narration`, `shop-assembler`, `scene-commerce`, `enemy-loadouts`, `npc-equipment` |
| 3 | `sk-scene-interact` | в очереди | 1323 | `scene-interactions`, `improvised-effects`, `scenario-attention` |
| 4 | `sk-tactical` | в очереди | 3548 | `tactical-map`, `combat-bounds`, `reveal-delta`, `reveal-transport`, `action-hints` |
| 5 | `sk-map-core` | в очереди | 2382 | `map-quality`, `thin-walls`, `room-floors`, `scene-features`, `dynamic-map`, `authored-location-maps`, `combat-lab-maps` |
| 5 | `sk-props` | в очереди | 2369 | `prop-placement`, `scene-dressing` |
| 6 | `sk-buildings` | в очереди | 2239 | `building-generator` |
| 6 | `sk-settlements` | в очереди | 2797 | `settlement-generator`, `graph-layout`, `scene-program-layout` |
| 6 | `sk-encounters` | в очереди | 1935 | `encounter-assembler`, `agent-context` |
| 6 | `sk-npc-world` | в очереди | 3446 | `npc-positioning`, `tavern-life`, `blessings`, `beast-taming` |
| 7 | `sk-world-life` | в очереди | 2777 | `captives`, `courier-letters`, `world-offices` |
| 7 | `sk-items-life` | в очереди | 1519 | `item-lifecycle`, `content-integrity`, `authoritative-executor` |
| 7 | `sk-themes` | в очереди | 2568 | `scene-themes` |
| 8 | `sk-character` | в очереди | 2181 | `character-lifecycle`, `encounter-rewards`, `quest-decisions` |
| 8 | `sk-world-time` | в очереди | 3775 | `level-generator`, `weather`, `world-deeds`, `world-template-catalog` |
| 9 | `sk-world-story` | в очереди | 3376 | `autonomous-campaign`, `offscreen-world`, `scenario-knight`, `scene-canon`, `talespire-import` |
| 9 | `sk-narration` | в очереди | 1488 | `combat-narration`, `scene-narration`, `encounter-narration`, `scene-summary` |
| 10 | `sk-story` | в очереди | 3029 | `campaign-dialogues`, `campaign-loop-policy`, `intent-parser`, `llm-json-schemas`, `map-library` |
| 11 | `sk-director` | в очереди | 3684 | `adventure-director`, `campaign-lifecycle`, `scene-memory`, `director-scene-transition`, `loot-containers` |
| 13 | `sk-rules` | начат: редьюсер: живучесть, состояния, атака, ход и раунд | 28261 | `rules-engine`, `rules/tactical-geometry` |
| 14 | `sk-tactics` | в очереди | 3373 | `adjudicator`, `combat-forecast-view`, `party-tactics`, `security`, `cutover-audit`, `combat-lab-setup`, `combat-lab` |
| 15 | `sk-projection` | в очереди | 2989 | `viewer-projection`, `trace-store` |
| 15 | `sk-agents` | в очереди | 11269 | `campaign-bootstrap`, `campaign-recap`, `creative-director`, `hero-hooks`, `lore-author`, `lore-voice`, `npc-controller`, `scene-architect`, `director-agent`, `free-action-adjudication`, `npc-social-controller`, `player-request-router`, `action-adjudicator`, `narrator` |
| 16 | `sk-turns` | в очереди | 2297 | `npc-turn-scheduler`, `combat-turn-coordinator` |
| 18 | `sk-orchestrator` | в очереди | 6443 | `autonomous-orchestrator`, `game-orchestrator` |
| 20 | `sk-server` | начат: вход, сессии, админка, раздача клиента | 6799 | `index`, `routes/map-import-routes`, `routes/combat-lab-routes` |

Не переносятся: `rules-corpus` — запись корпуса паритета — инструмент JS; `dev` — запуск JS-разработки; `autonomy-eval` — стенд оценки JS; `migrations/001-event-engine` — до-событийные комнаты; Rust импортирует событийное хранилище; `migrations/run` — запуск миграций JS.
