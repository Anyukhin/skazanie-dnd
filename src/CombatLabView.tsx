import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, Square } from 'lucide-react'
import { CombatLabSetup, type ArenaConfig } from './CombatLabSetup'
import { CombatLabBoard } from './CombatLabBoard'
import type { GameEvent, SerializedTacticalMap } from './types'
import './combat-lab.css'

type Actor = { id: string; name: string; side: 'party' | 'enemy'; hp: number; maxHp: number; x: number; y: number; image?: string; conditions?: string[]; arsenal?: { name: string; status: string }[]; resources?: Record<string, {current: number; max: number}> }
type Frame = { index: number; round: number; activeActorId: string | null; actors: Actor[]; map?: SerializedTacticalMap; gameEvents?: GameEvent[]; cells: { x: number; y: number; type: string; difficult?: boolean }[]; events: { id: string; text: string; actorId: string }[] }
type Run = { id: string; status: 'running' | 'passed' | 'failed' | 'cancelled'; scenario: string; seed: number; frames: Frame[]; error?: string }
type Scenario = { id: string; name: string }
const statusText = { running: 'Бой идёт', passed: 'Бой завершён, проверки пройдены', failed: 'Прогон обнаружил ошибку', cancelled: 'Прогон остановлен' }
const RUN_KEY = 'skazanie-combat-lab-run'

class LabRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  const body = await response.json()
  if (!response.ok) throw new LabRequestError(body.error || 'Не удалось связаться с боевым стендом', response.status)
  return body as T
}

export function CombatLabView() {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [mode, setMode] = useState<'custom' | 'scenarios'>('custom')
  const [config, setConfig] = useState<ArenaConfig | null>(null)
  const [setupOpen, setSetupOpen] = useState(true)
  const [scenario, setScenario] = useState('duel')
  const [seed, setSeed] = useState('1')
  const [run, setRun] = useState<Run | null>(null)
  const [runId, setRunId] = useState<string | null>(() => sessionStorage.getItem(RUN_KEY))
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [delay, setDelay] = useState(800)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const journal = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const abort = new AbortController()
    void request<{ scenarios: Scenario[] }>('/api/admin/combat-lab/scenarios', { signal: abort.signal })
      .then((body) => setScenarios(body.scenarios)).catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message) })
    if (!sessionStorage.getItem(RUN_KEY)) {
      void request<{ activeRun: { id: string } | null }>('/api/admin/combat-lab/runs', { signal: abort.signal })
        .then((body) => { if (body.activeRun && !abort.signal.aborted) { sessionStorage.setItem(RUN_KEY, body.activeRun.id); setRunId(body.activeRun.id) } })
        .catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message) })
    }
    return () => abort.abort()
  }, [])
  useEffect(() => {
    if (!runId) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let receivedThrough = -1
    const poll = async () => {
      try {
        const next = await request<Run>(`/api/admin/combat-lab/runs/${encodeURIComponent(runId)}?after=${receivedThrough}`, { signal: abort.signal })
        if (abort.signal.aborted) return
        receivedThrough = next.frames.at(-1)?.index ?? receivedThrough
        setRun((previous) => ({ ...next, frames: previous?.id === next.id
          ? [...previous.frames, ...next.frames.filter((frame) => frame.index > (previous.frames.at(-1)?.index ?? -1))] : next.frames }))
        setError('')
        if (next.status === 'running') timer = setTimeout(() => void poll(), 500)
      } catch (reason) {
        if (!abort.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Не удалось обновить бой')
          if (reason instanceof LabRequestError && [401, 403, 404].includes(reason.status)) {
            sessionStorage.removeItem(RUN_KEY); setRunId(null); setRun(null); setCursor(0); return
          }
          timer = setTimeout(() => void poll(), 2000)
        }
      }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [runId])
  useEffect(() => {
    if (!playing || !run?.frames.length || cursor >= run.frames.length - 1) return
    const timer = setTimeout(() => setCursor((value) => value + 1), delay)
    return () => clearTimeout(timer)
  }, [playing, cursor, delay, run?.frames.length])
  useEffect(() => { journal.current?.scrollTo({ top: journal.current.scrollHeight }) }, [cursor])

  const start = async () => {
    setBusy(true); setError('')
    try {
      const result = await request<{ id: string }>('/api/admin/combat-lab/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'custom' ? { config, seed: Number(seed) } : { scenario, seed: Number(seed) }),
      })
      sessionStorage.setItem(RUN_KEY, result.id)
      setRun(null); setCursor(0); setPlaying(true); setRunId(result.id); setSetupOpen(false)
    } catch (reason) {
      if (reason instanceof LabRequestError && reason.status === 409) {
        try {
          const current = await request<{ activeRun: { id: string } | null }>('/api/admin/combat-lab/runs')
          if (current.activeRun) {
            sessionStorage.setItem(RUN_KEY, current.activeRun.id)
            setRun(null); setCursor(0); setRunId(current.activeRun.id); setPlaying(true); setSetupOpen(false)
            return
          }
        } catch { /* исходный отказ остаётся видимым */ }
      }
      setError(reason instanceof Error ? reason.message : 'Не удалось запустить бой')
    }
    finally { setBusy(false) }
  }
  const stop = async () => {
    if (!runId) return
    setBusy(true)
    try { await request(`/api/admin/combat-lab/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось остановить бой') }
    finally { setBusy(false) }
  }
  const frame = run?.frames[Math.min(cursor, run.frames.length - 1)]
  const running = Boolean(runId && (!run || run.status === 'running'))
  const seedValid = seed.trim() !== '' && Number.isSafeInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 0xffffffff
  const activeActor = frame?.actors.find((actor) => actor.id === frame.activeActorId)
  return <section className="combat-lab-page">
    <header><h1>Боевой стенд</h1><p>Соберите отряд, выберите врагов и наблюдайте бой на правилах D&D 2014.</p></header>
    <div className="combat-lab-modes"><button aria-pressed={mode === 'custom'} disabled={running || busy} onClick={() => { setMode('custom'); setSetupOpen(true) }}>Своя арена</button><button aria-pressed={mode === 'scenarios'} disabled={running || busy} onClick={() => setMode('scenarios')}>Проверочные сценарии</button>{mode === 'custom' && <button onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? 'Скрыть настройку' : 'Настроить состав и карту'}</button>}</div>
    {mode === 'custom' && <div hidden={!setupOpen}><CombatLabSetup disabled={running || busy} onChange={setConfig} /></div>}
    <div className="combat-lab-controls">
      {mode === 'scenarios' && <label>Сценарий<select value={scenario} onChange={(event) => setScenario(event.target.value)} disabled={running || busy}>{scenarios.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
      <label>Номер бросков<input type="number" min="0" max="4294967295" step="1" value={seed} onChange={(event) => setSeed(event.target.value)} disabled={running || busy} /></label>
      <button onClick={() => void start()} disabled={running || busy || !seedValid || (mode === 'custom' ? !config : !scenarios.length)}><Play size={16} />Запустить бой</button>
      {running && <button onClick={() => void stop()} disabled={busy}><Square size={16} />Остановить прогон</button>}
      {run && run.status !== 'running' && <a href={`/api/admin/combat-lab/runs/${encodeURIComponent(run.id)}/report`} download>Скачать журнал боя</a>}
    </div>
    {error && <p className="combat-lab-error" role="alert">{error}</p>}
    {run?.error && <p className="combat-lab-error" role="alert">{run.error}</p>}
    <p className="combat-lab-status" role="status">{run ? `${run.scenario === 'custom' ? 'Своя арена' : scenarios.find((item) => item.id === run.scenario)?.name ?? run.scenario}, броски ${run.seed}. ${statusText[run.status]}` : running ? 'Подготовка арены…' : 'Подготовьте состав и запустите бой.'}</p>
    {frame && <>
      <div className="combat-lab-playback">
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? 'Приостановить просмотр' : 'Продолжить просмотр'}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? 'Пауза просмотра' : 'Продолжить просмотр'}</button>
        <button aria-label="Предыдущий момент" disabled={cursor === 0} onClick={() => { setPlaying(false); setCursor(cursor - 1) }}><ChevronLeft size={18} /></button>
        <input aria-label="Момент боя" type="range" min="0" max={Math.max(0, (run?.frames.length ?? 1) - 1)} value={cursor} onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)) }} />
        <button aria-label="Следующий момент" disabled={cursor >= (run?.frames.length ?? 1) - 1} onClick={() => { setPlaying(false); setCursor(cursor + 1) }}><ChevronRight size={18} /></button>
        <label>Темп<select value={delay} onChange={(event) => setDelay(Number(event.target.value))}><option value="1400">Медленно</option><option value="800">Обычно</option><option value="250">Быстро</option></select></label>
      </div>
      <div className="combat-lab-layout">
        <div className="combat-lab-arena">
          <h2>Раунд {frame.round || 1}{activeActor ? ` · Ход: ${activeActor.name}` : ''}</h2>
          <CombatLabBoard map={frame.map} cells={frame.cells} actors={frame.actors} activeActorId={frame.activeActorId} events={frame.gameEvents} frameId={`${run?.id}:${frame.index}`} />
          <table><caption>Участники боя</caption><thead><tr><th>Участник</th><th>Сторона</th><th>ОЗ</th></tr></thead><tbody>{frame.actors.map((actor, index) => <tr key={actor.id} className={actor.id === frame.activeActorId ? 'current' : ''}><td>{index + 1}. {actor.name}</td><td>{actor.side === 'party' ? 'Отряд' : 'Противник'}</td><td>{actor.hp} / {actor.maxHp}</td></tr>)}</tbody></table>
          <div className="combat-lab-arsenal">{frame.actors.map((actor) => <details key={actor.id}><summary>{actor.name}: способности и ресурсы</summary><ul>{actor.arsenal?.map((item, index) => <li key={`${item.name}:${index}`}>{item.name}{['heuristic', 'ruling-only'].includes(item.status) ? ' — не исполняется' : item.status === 'partial' ? ' — частичная поддержка' : ''}</li>)}</ul>{Object.entries(actor.resources ?? {}).length > 0 && <p>{Object.entries(actor.resources ?? {}).map(([key, value]) => `${key.startsWith('spell_slots_') ? `Ячейки ${key.slice(12)} круга` : key}: ${value.current}/${value.max}`).join('; ')}</p>}</details>)}</div>
        </div>
        <div className="combat-lab-journal" ref={journal} tabIndex={0} aria-label="Журнал боя"><h2>Журнал боя</h2>{cursor >= 100 && <p>Показаны последние 100 моментов до выбранного. Для более ранних событий переместите ползунок.</p>}{run?.frames.slice(Math.max(0, cursor - 99), cursor + 1).map((moment) => moment.events.length > 0 && <section key={moment.index}><h3>Момент {moment.index + 1} · Раунд {moment.round || 1}</h3><ul>{moment.events.map((event, index) => <li key={`${event.id}:${index}`}>{event.text}</li>)}</ul></section>)}</div>
      </div>
      <p className="combat-lab-note">Момент {cursor + 1} из {run?.frames.length}. Пауза останавливает только просмотр; расчёт боя продолжается.</p>
    </>}
  </section>
}
