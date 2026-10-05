/**
 * Прогон «Асстоханских равнин» по нескольким сидам костей и сводная таблица
 * (eval, в тесты не входит). Редкие ошибки боя и Режиссёра видны только на
 * серии: один сид проходит, соседний встаёт. Каждый сид — отдельный
 * `eval/astohan-playthrough.mjs` со своим портом и временным хранилищем.
 *
 *   node eval/astohan-seeds.mjs                       # сиды 1–5, по два сразу, 25 мин на сид
 *   node eval/astohan-seeds.mjs --seeds 1,4,9 --parallel 1 --minutes 20 --keep
 *
 * Итог — `<out>/summary.md` (таблица сидов и находки по видам) и
 * `<out>/summary.json`; отчёты каждого сида лежат в `<out>/seed-<N>/`.
 * Параллельные прогоны делят процессор: при бюджете по времени сид, не
 * дошедший до финала в серии, стоит перепроверить один (`--parallel 1`).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

function parseSeeds(value) {
  const seeds = []
  for (const part of String(value).split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/u)
    if (range) for (let seed = Number(range[1]); seed <= Number(range[2]); seed += 1) seeds.push(seed)
    else if (/^\d+$/u.test(part)) seeds.push(Number(part))
    else throw new Error(`Непонятный сид «${part}»: ожидается число, список через запятую или диапазон 1-5`)
  }
  return [...new Set(seeds)]
}

const SEEDS = parseSeeds(option('seeds', '1-5'))
const PARALLEL = Math.max(1, Number(option('parallel', 2)) || 1)
const MINUTES = option('minutes', '25')
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const OUT = resolve(ROOT, option('out', join('tmp', 'astohan-playtest', `${STAMP}-seeds`)))
const BASE_PORT = 8800 + Math.floor(Math.random() * 40) * 2

function runSeed(seed, index) {
  const out = join(OUT, `seed-${seed}`)
  const args = ['eval/astohan-playthrough.mjs', '--seed', String(seed), '--port', String(BASE_PORT + index), '--out', out]
  if (MINUTES) args.push('--minutes', MINUTES)
  if (argv.includes('--keep')) args.push('--keep')
  return new Promise((resolveRun) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    let storage = null
    const keep = (chunk) => {
      tail = (tail + chunk.toString()).slice(-4000)
      storage = /Хранилище оставлено: (.+)/u.exec(tail)?.[1]?.trim() ?? storage
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('close', (code) => {
      const reportPath = join(out, 'report.json')
      const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
      const line = report
        ? `${report.scorecard.status}, ${report.scorecard.overall}/10`
        : `упал (код ${code})`
      console.log(`сид ${seed}: ${line} · ${((Date.now() - startedAt) / 60000).toFixed(1)} мин${storage ? ` · хранилище ${storage}` : ''}`)
      resolveRun({ seed, code, report, out, storage, tail: report ? '' : tail })
    })
  })
}

async function runAll() {
  const queue = SEEDS.map((seed, index) => ({ seed, index }))
  const results = []
  const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length) {
      const { seed, index } = queue.shift()
      results.push(await runSeed(seed, index))
    }
  })
  await Promise.all(workers)
  return results.sort((left, right) => left.seed - right.seed)
}

const cell = (value) => String(value ?? '—').replace(/\|/gu, '\\|').replace(/\s+/gu, ' ')

function summarize(results) {
  const rows = results.map(({ seed, report, code }) => {
    if (!report) return { seed, status: `упал (${code})` }
    const { scorecard, stats, minutes } = report
    return {
      seed,
      status: scorecard.status,
      overall: scorecard.overall,
      minutes,
      chapters: stats.chapters,
      combats: stats.combats,
      wins: stats.combatWins,
      deaths: stats.heroDeaths,
      dead_ends: stats.deadEnds,
      corpus: stats.corpus ? `${stats.corpus.deadEnds}/${stats.corpus.said}` : '—',
      text: scorecard.criteria?.find((entry) => entry.id === 'Т')?.score ?? '—',
      consistency: scorecard.criteria?.find((entry) => entry.id === 'С')?.score ?? '—',
      refused: stats.commandRefused,
      blockers: scorecard.blockers,
      critical: scorecard.critical,
      major: scorecard.major,
    }
  })
  const kinds = new Map()
  for (const { seed, report } of results) {
    for (const entry of report?.findings ?? []) {
      const key = `${entry.severity}\u0000${entry.kind}`
      const known = kinds.get(key) ?? { severity: entry.severity, kind: entry.kind, seeds: new Set(), count: 0, example: entry.message }
      known.seeds.add(seed)
      known.count += 1
      kinds.set(key, known)
    }
  }
  const order = { blocker: 0, critical: 1, major: 2, minor: 3 }
  const findings = [...kinds.values()]
    .map((entry) => ({ ...entry, seeds: [...entry.seeds].sort((a, b) => a - b) }))
    .sort((left, right) => (order[left.severity] ?? 9) - (order[right.severity] ?? 9) || right.seeds.length - left.seeds.length || left.kind.localeCompare(right.kind))
  const completed = rows.filter((row) => row.status === 'completed').length
  // Поражение отряда — тоже конец истории: сюжет дошёл до развязки, просто не
  // в пользу героев. Не дошедший до конца прогон — это `active` или падение.
  const finished = rows.filter((row) => ['completed', 'failed'].includes(row.status)).length
  const scores = rows.map((row) => row.overall).filter(Number.isFinite)
  return {
    rows,
    findings,
    completed,
    finished,
    mean: scores.length ? Math.round(10 * scores.reduce((sum, value) => sum + value, 0) / scores.length) / 10 : null,
    min: scores.length ? Math.min(...scores) : null,
  }
}

function writeSummary(results, summary) {
  const lines = [
    `# Асстохан по сидам — ${STAMP}`,
    '',
    `Сиды ${SEEDS.join(', ')} · параллельно ${PARALLEL}${MINUTES ? ` · бюджет ${MINUTES} мин на сид` : ''} · до конца дошли **${summary.finished} из ${results.length}** (победой ${summary.completed}) · оценка средняя **${summary.mean ?? '—'}**, худшая ${summary.min ?? '—'}`,
    '',
    '| Сид | Исход | Оценка | Мин | Глав | Боёв (побед) | Смертей | Тупиков | На реальных фразах | Текст | Согласованность | Отказов команд | Блок / крит / серьёзн |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.rows.map((row) => row.overall == null
      ? `| ${row.seed} | ${cell(row.status)} | — | — | — | — | — | — | — | — | — | — | — |`
      : `| [${row.seed}](seed-${row.seed}/report.md) | ${row.status} | ${row.overall} | ${row.minutes} | ${row.chapters} | ${row.combats} (${row.wins}) | ${row.deaths} | ${row.dead_ends} | ${row.corpus} | ${row.text} | ${row.consistency} | ${row.refused} | ${row.blockers} / ${row.critical} / ${row.major} |`),
    '',
    '## Находки по видам',
    '',
    'Вид, который встречается на всех сидах, — свойство кампании; на одном — редкий случай, его стоит воспроизвести этим сидом.',
    '',
    '| Важность | Вид | Сиды | Всего | Пример |',
    '| --- | --- | --- | --- | --- |',
    ...summary.findings.map((entry) => `| ${entry.severity} | \`${entry.kind}\` | ${entry.seeds.join(', ')} | ${entry.count} | ${cell(String(entry.example ?? '').slice(0, 220))} |`),
  ]
  const kept = results.filter((result) => result.storage)
  if (kept.length) lines.push('', '## Сохранённые хранилища', '', ...kept.map((result) => `- сид ${result.seed}: \`${result.storage}\``))
  const crashed = results.filter((result) => !result.report)
  if (crashed.length) {
    lines.push('', '## Упавшие прогоны', '')
    for (const result of crashed) lines.push(`### Сид ${result.seed}`, '', '```', result.tail.trim(), '```', '')
  }
  writeFileSync(join(OUT, 'summary.md'), `${lines.join('\n')}\n`)
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ stamp: STAMP, seeds: SEEDS, parallel: PARALLEL, minutes: MINUTES, ...summary }, null, 2))
}

mkdirSync(OUT, { recursive: true })
console.log(`Сиды ${SEEDS.join(', ')}, по ${PARALLEL} сразу → ${relative(ROOT, OUT)}`)
const results = await runAll()
const summary = summarize(results)
writeSummary(results, summary)
console.log(`\nДо конца: ${summary.finished} из ${results.length} (победой ${summary.completed}), оценка средняя ${summary.mean ?? '—'}, худшая ${summary.min ?? '—'}`)
console.log(`Сводка: ${relative(ROOT, join(OUT, 'summary.md'))}`)
process.exitCode = summary.finished === results.length && results.every((result) => result.report?.scorecard.blockers === 0) ? 0 : 1
