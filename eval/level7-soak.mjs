// Массовый прогон боёв отряда 7-го уровня (цель «вся боёвка 7-го уровня
// работает»): три отряда по четыре героя закрывают все 12 классов с
// подклассами Асстохана и BG3-сборками, против тем врагов боевого стенда, по
// нескольку сидов. Бой ведут автотактика героев (`planHeroCombatCommand`) и
// планировщик врагов, как в боевой лаборатории. Стенд ловит исключения,
// зависшие бои, расхождения replay и героев, которые весь бой ничего не делали.
//
//   node eval/level7-soak.mjs --seeds 3 --themes undead,beasts,raiders,dragons,cultists --out tmp/level7-soak
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { runCombatScenario } from './combat-lab.mjs'
import { buildCombatLabState, generateCombatLabEncounter } from '../server/combat-lab-setup.mjs'
import { planHeroCombatCommand } from '../server/party-tactics.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
const SEEDS = Math.max(1, Number(arg('seeds', 2)))
const THEMES = String(arg('themes', 'undead,beasts,raiders,dragons,cultists')).split(',').filter(Boolean)
const DIFFICULTY = arg('difficulty', 'hard')
const OUT = resolve(arg('out', 'tmp/level7-soak'))
const LEVEL = Number(arg('level', 7))

// Подкласс, стиль и выборы — так, чтобы в бою жили умения, которые стенд проверяет.
const BUILDS = {
  fighter: { subclass: 'Чемпион', selectedFeatureIds: ['fighting-style-great-weapon'] },
  cleric: { subclass: 'Домен жизни' },
  wizard: { subclass: 'Школа Воплощения' },
  rogue: { subclass: 'Вор' },
  paladin: { subclass: 'Клятва преданности', selectedFeatureIds: ['fighting-style-defense'] },
  druid: { subclass: 'Круг луны' },
  sorcerer: { subclass: 'Наследие драконьей крови', selectedFeatureIds: ['quickened-spell', 'twinned-spell'] },
  ranger: { subclass: 'Охотник', selectedFeatureIds: ['fighting-style-archery'] },
  barbarian: { subclass: 'Путь берсерка' },
  bard: { subclass: 'Коллегия знаний' },
  warlock: { subclass: 'Исчадие', selectedFeatureIds: ['agonizing-blast', 'repelling-blast', 'eldritch-spear', 'devils-sight', 'pact-blade'] },
  monk: { subclass: 'Путь открытой ладони' },
}
const PARTIES = [
  ['fighter', 'cleric', 'wizard', 'rogue'],
  ['paladin', 'druid', 'sorcerer', 'ranger'],
  ['barbarian', 'bard', 'warlock', 'monk'],
]

function withBuilds(state, classes) {
  const next = structuredClone(state)
  next.players = next.players.map((hero, index) => ({ ...hero, ...BUILDS[classes[index]] }))
  return normalizeCampaignState(next)
}

mkdirSync(OUT, { recursive: true })
const results = []
const started = Date.now()
for (const classes of PARTIES) {
  const party = classes.map((classId, index) => ({ source: 'class', classId, level: LEVEL, x: index, y: 0 }))
  for (const theme of THEMES) {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const label = `${classes.join('+')} vs ${theme} #${seed}`
      let encounter
      try {
        encounter = await generateCombatLabEncounter({ mapId: 'open-courtyard', party, difficulty: DIFFICULTY, seed, theme })
      } catch (error) {
        results.push({ label, classes, theme, seed, error: `encounter: ${error.code ?? ''} ${error.message}` })
        continue
      }
      const initialState = withBuilds(await buildCombatLabState(encounter.config), classes)
      const runStarted = Date.now()
      let report
      try {
        report = await runCombatScenario({ scenario: 'custom', initialState, chooseCommand: planHeroCombatCommand, seed, maxSteps: 900 })
      } catch (error) {
        results.push({ label, classes, theme, seed, error: `run: ${error.code ?? ''} ${String(error.message).slice(0, 300)}` })
        continue
      }
      // Что делал каждый герой: команды и id действий за бой.
      const byHero = {}
      for (const step of report.steps ?? []) {
        const command = step.command ?? {}
        const actor = String(command.actor_id ?? '')
        if (!actor.startsWith('hero-')) continue
        const what = command.command_type === 'UseCombatAction' ? `action:${command.action_id}`
          : command.command_type === 'CastSpell' ? `spell:${command.spell_id}`
            : command.command_type
        byHero[actor] ??= {}
        byHero[actor][what] = (byHero[actor][what] ?? 0) + 1
      }
      const idle = initialState.players.filter((hero) => !Object.keys(byHero[hero.id] ?? {}).some((what) => /MakeAttack|spell:|action:/u.test(what)))
        .map((hero) => hero.characterClass)
      const final = report.final_state ?? report.steps?.at(-1)?.after ?? null
      results.push({
        label, classes, theme, seed,
        passed: report.passed === true,
        error: report.error ? `${report.error.code ?? ""} ${report.error.message ?? report.error}`.slice(0, 400) : null,
        outcome: report.outcome ?? report.result ?? null,
        steps: report.steps?.length ?? 0,
        ms: Date.now() - runStarted,
        idle,
        byHero,
        refused: (report.steps ?? []).filter((step) => step.error || step.refused).map((step) => `${step.command?.command_type}:${step.command?.action_id ?? step.command?.spell_id ?? ''} → ${String(step.error?.code ?? step.error ?? step.refused).slice(0, 120)}`).slice(0, 8),
      })
      void final
      process.stdout.write(`${report.passed ? '✓' : '✗'} ${label} · шагов ${report.steps?.length ?? 0}${idle.length ? ` · без дела: ${idle.join(', ')}` : ''}${report.error ? ` · ${report.error.code ?? ''} ${String(report.error.message ?? report.error).slice(0, 200)}` : ''}\n`)
    }
  }
}
const failed = results.filter((entry) => !entry.passed)
const idleByClass = {}
for (const entry of results) for (const classId of entry.idle ?? []) idleByClass[classId] = (idleByClass[classId] ?? 0) + 1
const usedByClass = {}
for (const entry of results) {
  for (const [heroId, used] of Object.entries(entry.byHero ?? {})) {
    const classId = entry.classes[Number(heroId.replace('hero-', '')) - 1]
    usedByClass[classId] ??= {}
    for (const [what, count] of Object.entries(used)) usedByClass[classId][what] = (usedByClass[classId][what] ?? 0) + count
  }
}
const summary = { level: LEVEL, difficulty: DIFFICULTY, runs: results.length, failed: failed.length, minutes: Math.round((Date.now() - started) / 600) / 100, idleByClass, usedByClass, failures: failed.map(({ label, error, refused }) => ({ label, error, refused })) }
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ summary, results }, null, 2))
console.log(`\nбоёв ${results.length}, упало ${failed.length}, мин ${summary.minutes}`)
console.log('без дела по классам:', JSON.stringify(idleByClass))
for (const [classId, used] of Object.entries(usedByClass)) console.log(`${classId}: ${Object.entries(used).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([what, count]) => `${what}×${count}`).join(' ')}`)
