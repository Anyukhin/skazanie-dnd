/**
 * Паритет боевого стенда (eval, в тесты не входит; ночной прогон CI —
 * `.github/workflows/rust-nightly.yml`).
 *
 * Урок 6 плана переноса (`docs/rust-rewrite-plan.md` §1): бой проверяется
 * массой. Один и тот же прогон `eval/combat-http-soak.mjs` с одним сидом костей
 * идёт против JS и против Rust. Падает (код 1), если исходы боёв или аномалии
 * расходятся, сервер писал ошибки или сам стенд сломался. Аномалия, одинаковая
 * у обоих, — известная ошибка движка: печатается, но прогон не валит.
 *
 *   SKAZANIE_RUST_SERVER_BIN=… node eval/soak-parity.mjs
 *   SOAK_DICE_SEED=7 SOAK_DIFFICULTIES=hard node eval/soak-parity.mjs
 *
 * Пишет обе выдачи и сводку в `tmp/soak-parity/<время>/`.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SEED = process.env.SOAK_DICE_SEED ?? '1'
const OUT = join('tmp', 'soak-parity', new Date().toISOString().replace(/[:.]/gu, '-'))

/** Прогон стенда против одной реализации; выдача целиком. */
function run(impl) {
  return new Promise((resolve, reject) => {
    const args = ['eval/combat-http-soak.mjs', ...(impl === 'rust' ? ['--impl', 'rust'] : [])]
    // Общий SOAK_PORT посадил бы оба сервера на один порт: порт выбирает сам стенд.
    const { SOAK_PORT: _port, ...env } = process.env
    const child = spawn(process.execPath, args, { env: { ...env, SOAK_DICE_SEED: SEED }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    child.on('error', reject)
    child.on('close', (code) => resolve({ impl, code, stdout, stderr }))
  })
}

/** Исходы, аномалии и число ошибок сервера из выдачи стенда. */
function parse(stdout) {
  const lines = stdout.split('\n')
  const outcomes = []
  const anomalies = []
  let serverErrors = null
  let section = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('OUTCOMES')) { section = 'outcomes'; continue }
    if (line.startsWith('ANOMALIES')) { section = 'anomalies'; continue }
    if (line.startsWith('SERVER LOG ERRORS')) { serverErrors = Number(line.trim().split(' ').pop()); section = ''; continue }
    if (section === 'outcomes' && /^ {2}SOAK-/u.test(line)) {
      // Время боя у серверов разное по природе — из сравнения убирается.
      outcomes.push(`${line.trim().replace(/ \d+ms \|/u, ' |')} ${(lines[index + 1] ?? '').trim()}`)
    }
    if (section === 'anomalies' && line.startsWith('{')) {
      const anomaly = JSON.parse(line)
      // Текст отказа сравнивается по коду, а не дословно: формулировки ответа
      // не часть паритета боя.
      anomalies.push({ key: [anomaly.code, anomaly.kind, anomaly.actor ?? '', anomaly.step ?? ''].join(' '), kind: anomaly.kind, line })
    }
  }
  return { outcomes, anomalies, serverErrors }
}

/** Строки, которые есть в `left` и нет в `right`. */
function missing(left, right) {
  const rest = [...right]
  return left.filter((item) => {
    const at = rest.indexOf(item)
    if (at < 0) return true
    rest.splice(at, 1)
    return false
  })
}

const runs = await Promise.all([run('js'), run('rust')])
mkdirSync(OUT, { recursive: true })
for (const result of runs) writeFileSync(join(OUT, `${result.impl}.txt`), `${result.stdout}\n--- stderr\n${result.stderr}`)
const [js, rust] = runs.map((result) => ({ ...result, ...parse(result.stdout) }))

const problems = []
for (const side of [js, rust]) {
  if (side.code !== 0) problems.push(`${side.impl}: стенд завершился с кодом ${side.code}`)
  if (side.serverErrors == null) problems.push(`${side.impl}: стенд не дошёл до сводки`)
  else if (side.serverErrors > 0) problems.push(`${side.impl}: ошибок в журнале сервера — ${side.serverErrors}`)
  if (side.outcomes.length === 0) problems.push(`${side.impl}: ни одного боя`)
  for (const anomaly of side.anomalies.filter((item) => item.kind === 'script')) problems.push(`${side.impl}: сбой стенда ${anomaly.line}`)
}
for (const line of missing(js.outcomes, rust.outcomes)) problems.push(`исход только у JS: ${line}`)
for (const line of missing(rust.outcomes, js.outcomes)) problems.push(`исход только у Rust: ${line}`)
const jsKeys = js.anomalies.map((item) => item.key)
const rustKeys = rust.anomalies.map((item) => item.key)
for (const key of missing(jsKeys, rustKeys)) problems.push(`аномалия только у JS: ${key}`)
for (const key of missing(rustKeys, jsKeys)) problems.push(`аномалия только у Rust: ${key}`)
const shared = rust.anomalies.filter((item) => jsKeys.includes(item.key))

const summary = [
  `# Паритет боевого стенда, сид ${SEED}`,
  '',
  `Боёв: JS ${js.outcomes.length}, Rust ${rust.outcomes.length}. Ошибок сервера: JS ${js.serverErrors ?? '—'}, Rust ${rust.serverErrors ?? '—'}.`,
  '',
  problems.length ? `## Расхождения и сбои (${problems.length})\n\n${problems.map((line) => `- ${line}`).join('\n')}` : '## Расхождений нет',
  '',
  `## Известные аномалии, одинаковые у обоих (${shared.length})`,
  '',
  ...shared.map((item) => `- ${item.line}`),
  '',
].join('\n')
writeFileSync(join(OUT, 'summary.md'), summary)
console.log(summary)
console.log(`Выдача: ${OUT}`)
process.exitCode = problems.length ? 1 : 0
