// Эталон reaction-preferences для Rust: нормализация сохранённых режимов и
// решения по окнам реакции на сотнях случайных настроек и окон.
//
//   node rust/crates/sk-combat-base/fixtures/gen-reaction-preferences.mjs
//
// Пишет reaction-preferences.json рядом с собой.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  REACTION_PREFERENCE_IDS,
  isConfigurableReaction,
  isReactionMode,
  normalizeReactionPreferences,
  planReactionByPreference,
  reactionModeFor,
} from '../../../../server/reaction-preferences.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(777)
const pick = (items) => items[Math.floor(random() * items.length)]

const REACTIONS = [...REACTION_PREFERENCE_IDS, 'cast:fireball', 'readied-attack', 'decline-reaction', '', '0']
const MODES = ['ask', 'auto', 'never', 'sometimes', 'AUTO', null, 1, ['auto']]
const ACTORS = ['hero', 'ally', '', '0', '1', 'Ёж']

function randomPreferences() {
  const roll = random()
  if (roll < 0.05) return pick([null, 'hero', 5, [{ parry: 'auto' }]])
  const preferences = {}
  for (const actor of ACTORS) {
    if (random() < (actor === 'hero' ? 0.15 : 0.7)) continue
    const entries = random() < 0.08 ? pick([null, 'x', ['auto'], 3]) : {}
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const reaction of REACTIONS) if (random() < 0.6) entries[reaction] = random() < 0.8 ? pick(['ask', 'auto', 'never', 'never']) : pick(MODES)
    }
    preferences[actor] = entries
  }
  return preferences
}
function randomWindow() {
  const roll = random()
  if (roll < 0.04) return pick([null, 'window', 5, []])
  const window = {}
  if (random() < 0.95) window.actor_id = random() < 0.7 ? 'hero' : pick([...ACTORS, null, 7])
  if (random() < 0.1) window.free_choice = pick([true, false, 'true'])
  if (random() < 0.15) window.trigger = pick(['failed-saving-throw', 'saving-throw-bonus-choice', 'attack-hit', null])
  if (random() < 0.95) {
    window.action_ids = random() < 0.05 ? 'parry' : Array.from({ length: Math.floor(random() * 3) }, () => (random() < 0.9 ? pick(REACTION_PREFERENCE_IDS) : pick(REACTIONS)))
  }
  return window
}

const normalized = Array.from({ length: 200 }, () => {
  const raw = randomPreferences()
  return { raw, result: normalizeReactionPreferences(raw) }
})
const plans = Array.from({ length: 500 }, () => {
  const preferences = randomPreferences()
  const window = randomWindow()
  return { preferences, window, plan: planReactionByPreference(preferences, window) }
})
const modes = Array.from({ length: 200 }, () => {
  const preferences = randomPreferences()
  const actor = pick(ACTORS)
  const reaction = pick(REACTIONS)
  return { preferences, actor, reaction, mode: reactionModeFor(preferences, actor, reaction) }
})
const predicates = [...REACTIONS, ...MODES].map((value) => ({ value, mode: isReactionMode(value), configurable: isConfigurableReaction(value) }))

const fixture = { normalized, plans, modes, predicates }
const lines = Object.entries(fixture).map(([key, value]) => `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
writeFileSync(here('reaction-preferences.json'), `{\n${lines.join(',\n')}\n}\n`)
console.log(`reaction-preferences.json: ${normalized.length} нормализаций, ${plans.length} окон (${plans.filter((entry) => entry.plan?.mode === 'auto').length} «сразу», ${plans.filter((entry) => entry.plan?.mode === 'never').length} «никогда»)`)
