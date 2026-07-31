import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Часть экранов вынесена из App.tsx по задаче 0 — сторож читает весь корпус.
const appSource = ['../src/App.tsx', '../src/AppViews.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const sessionSource = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const clientSource = readFileSync(new URL('../src/ai-client.ts', import.meta.url), 'utf8')
const composeSource = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8')
const launcherSource = readFileSync(new URL('../Start-DnD.ps1', import.meta.url), 'utf8')

test('список кампаний различает загрузку, ошибку и настоящее пустое состояние', () => {
  assert.match(appSource, /const \[campaignsLoading, setCampaignsLoading\] = useState\(true\)/u)
  assert.match(appSource, /campaignsLoading && .*Загружаем кампании…/u)
  assert.match(appSource, /!campaignsLoading && !campaigns\.length && !error/u)
  assert.match(appSource, /Повторить загрузку кампаний/u)
})

test('переключение кампании и тактическая команда имеют конечный срок ожидания', () => {
  assert.match(clientSource, /export async function fetchWithTimeout/u)
  assert.match(sessionSource, /fetchWithTimeout\(`\/api\/campaigns\/\$\{encodeURIComponent\(current\.sessionCode\)\}\/commands`/u)
  assert.match(sessionSource, /25_000, 'Сервер слишком долго обрабатывает действие/u)
  assert.match(sessionSource, /20_000,\s*'Кампания не загрузилась вовремя/u)
})

test('индикатор не выдаёт полный ход за одну проверку пути', () => {
  assert.doesNotMatch(appSource, /Сервер проверяет путь/u)
  // Сторож про смысл, а не про буквальную фразу: индикатор обязан говорить про
  // действие целиком, а не про проверку пути. Формулировку сознательно увели от
  // слова «сервер» — игроку про устройство системы читать незачем.
  assert.match(appSource, /Действие идёт, мир отзывается на него…/u)
  assert.doesNotMatch(appSource, /Сервер обрабатывает действие/u)
})

test('проверки готовности не скачивают тяжёлое тело health endpoint', () => {
  assert.match(composeSource, /method:'HEAD'/u)
  assert.match(launcherSource, /-Method Head 'http:\/\/127\.0\.0\.1:8787\/api\/health'/u)
})
