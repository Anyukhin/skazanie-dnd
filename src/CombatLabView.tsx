import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, Square } from 'lucide-react'
import { CombatLabSetup, type ArenaConfig } from './CombatLabSetup'
import { CombatLabBoard } from './CombatLabBoard'
import { LabRequestError, labRequest as request } from './combat-lab-client'
import { heroResourceLabel } from './DungeonMap'
import { conditionPresentation } from './tactical-ui'
import type { GameEvent, SerializedTacticalMap } from './types'
import './combat-lab.css'
import './combat-lab-observer.css'

type Actor = {
  id: string
  name: string
  side: 'party' | 'enemy'
  hp: number
  maxHp: number
  x: number
  y: number
  image?: string
  conditions?: string[]
  arsenal?: { name: string; status: string }[]
  resources?: Record<string, { current: number; max: number }>
}
type FrameEvent = { id: string; text: string; actorId: string | null }
type Frame = {
  index: number
  round: number
  activeActorId: string | null
  actors: Actor[]
  map?: SerializedTacticalMap
  gameEvents?: GameEvent[]
  cells: { x: number; y: number; type: string; difficult?: boolean }[]
  events: FrameEvent[]
}
type Run = { id: string; status: 'running' | 'passed' | 'failed' | 'cancelled'; scenario: string; seed: number; frames: Frame[]; error?: string }
type Scenario = { id: string; name: string }
type JournalFilter = 'all' | 'tactics'

const statusText: Record<Run['status'], string> = {
  running: 'Бой идёт',
  passed: 'Бой завершён, проверки пройдены',
  failed: 'Прогон обнаружил ошибку',
  cancelled: 'Прогон остановлен',
}
const RUN_KEY = 'skazanie-combat-lab-run'
const RESOURCE_NAMES: Record<string, string> = {
  action: 'Действие',
  bonus_action: 'Бонусное действие',
  reaction: 'Реакция',
  movement: 'Перемещение',
  hit_dice: 'Кости хитов',
}

function resourceName(key: string) {
  if (key.startsWith('spell_slots_')) return `Ячейка ${key.slice('spell_slots_'.length)} круга`
  return RESOURCE_NAMES[key] ?? heroResourceLabel(key)
}

function actorInitial(name: string) {
  return name.trim().slice(0, 1).toLocaleUpperCase('ru-RU') || '•'
}

function healthPercent(actor: Actor) {
  return Math.round(100 * Math.max(0, Math.min(1, actor.hp / Math.max(1, actor.maxHp))))
}

function isTacticEvent(event: FrameEvent) {
  return event.id.startsWith('tactic-') || event.text.trimStart().startsWith('Тактика:')
}

function arsenalStatus(status: string) {
  if (status === 'verified') return 'Исполняется сервером'
  if (status === 'partial') return 'Частичная поддержка'
  if (status === 'heuristic' || status === 'ruling-only') return 'Не исполняется'
  return status
}

export function CombatLabView() {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [mode, setMode] = useState<'custom' | 'scenarios'>('custom')
  const [config, setConfig] = useState<ArenaConfig | null>(null)
  const [setupOpen, setSetupOpen] = useState(() => !sessionStorage.getItem(RUN_KEY))
  const [scenario, setScenario] = useState('duel')
  const [seed, setSeed] = useState('1')
  const [run, setRun] = useState<Run | null>(null)
  const [runId, setRunId] = useState<string | null>(() => sessionStorage.getItem(RUN_KEY))
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [delay, setDelay] = useState(800)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null)
  const [journalFilter, setJournalFilter] = useState<JournalFilter>('all')
  const journal = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const abort = new AbortController()
    void request<{ scenarios: Scenario[] }>('/api/admin/combat-lab/scenarios', { signal: abort.signal })
      .then((body) => setScenarios(body.scenarios))
      .catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message) })
    if (!sessionStorage.getItem(RUN_KEY)) {
      void request<{ activeRun: { id: string } | null }>('/api/admin/combat-lab/runs', { signal: abort.signal })
        .then((body) => {
          if (body.activeRun && !abort.signal.aborted) {
            sessionStorage.setItem(RUN_KEY, body.activeRun.id)
            setRunId(body.activeRun.id)
            setSetupOpen(false)
          }
        })
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
            sessionStorage.removeItem(RUN_KEY)
            setRunId(null)
            setRun(null)
            setCursor(0)
            setSelectedActorId(null)
            setSetupOpen(true)
            return
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

  const frame = run?.frames[Math.min(cursor, run.frames.length - 1)]
  const running = Boolean(runId && (!run || run.status === 'running'))
  const seedValid = seed.trim() !== '' && Number.isSafeInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 0xffffffff
  const activeActor = frame?.actors.find((actor) => actor.id === frame.activeActorId)
  const focusedActor = frame?.actors.find((actor) => actor.id === selectedActorId) ?? activeActor ?? frame?.actors[0]
  const lastFrame = run?.frames.at(-1)
  const outcome = run?.status === 'passed' && frame === lastFrame
    ? lastFrame?.actors.filter((actor) => actor.side === 'enemy').every((actor) => actor.hp <= 0) ? 'Победа отряда'
      : lastFrame?.actors.filter((actor) => actor.side === 'party').every((actor) => actor.hp <= 0) ? 'Отряд выведен из строя' : 'Бой завершён'
    : null
  const scenarioName = run?.scenario === 'custom'
    ? 'Своя арена'
    : scenarios.find((item) => item.id === (run?.scenario ?? scenario))?.name ?? 'Проверочный сценарий'
  const runStatus = run
    ? `${scenarioName}, набор бросков ${run.seed}. ${statusText[run.status]}`
    : running ? 'Синхронизация прогона…' : 'Подготовьте состав и запустите бой.'
  const actorNames = useMemo(() => new Map((frame?.actors ?? []).map((actor, index, actors) => [actor.id,
    actors.filter((other) => other.name === actor.name).length > 1 ? `${actor.name} ${index + 1}` : actor.name])), [frame?.actors])
  const actorLabel = (actor: Actor) => actorNames.get(actor.id) ?? actor.name
  const displayEventText = (text: string) => [...actorNames].sort(([left], [right]) => right.length - left.length)
    .reduce((result, [id, name]) => result.replaceAll(id, name), text)
  const visibleMoments = useMemo(() => {
    const moments = run?.frames.slice(Math.max(0, cursor - 99), cursor + 1) ?? []
    return moments.map((moment) => ({
      ...moment,
      events: moment.events.filter((event) => journalFilter === 'all' || isTacticEvent(event)),
    })).filter((moment) => moment.events.length > 0)
  }, [run?.frames, cursor, journalFilter])
  const visibleEventCount = visibleMoments.reduce((total, moment) => total + moment.events.length, 0)

  useEffect(() => {
    if (!frame) {
      setSelectedActorId(null)
      return
    }
    setSelectedActorId((current) => current && frame.actors.some((actor) => actor.id === current)
      ? current
      : frame.activeActorId ?? frame.actors[0]?.id ?? null)
  }, [frame?.index, frame?.activeActorId, frame?.actors])

  useEffect(() => {
    journal.current?.scrollTo({ top: journal.current.scrollHeight })
  }, [cursor, journalFilter])

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await request<{ id: string }>('/api/admin/combat-lab/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'custom' ? { config, seed: Number(seed) } : { scenario, seed: Number(seed) }),
      })
      sessionStorage.setItem(RUN_KEY, result.id)
      setRun(null)
      setCursor(0)
      setSelectedActorId(null)
      setJournalFilter('all')
      setPlaying(true)
      setRunId(result.id)
      setSetupOpen(false)
    } catch (reason) {
      if (reason instanceof LabRequestError && reason.status === 409) {
        try {
          const current = await request<{ activeRun: { id: string } | null }>('/api/admin/combat-lab/runs')
          if (current.activeRun) {
            sessionStorage.setItem(RUN_KEY, current.activeRun.id)
            setRun(null)
            setCursor(0)
            setSelectedActorId(null)
            setRunId(current.activeRun.id)
            setPlaying(true)
            setSetupOpen(false)
            return
          }
        } catch { /* исходный отказ остаётся видимым */ }
      }
      setError(reason instanceof Error ? reason.message : 'Не удалось запустить бой')
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!runId) return
    setBusy(true)
    try {
      const stopped = await request<Run>(`/api/admin/combat-lab/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
      setRun(stopped)
      setPlaying(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось остановить бой')
    } finally {
      setBusy(false)
    }
  }

  return <section className="combat-lab-page combat-lab-observer-page">
    <header className="combat-lab-observer-header">
      <div>
        <h1>Боевой стенд</h1>
        <p>Соберите отряд, выберите врагов и наблюдайте бой на правилах D&amp;D 2014.</p>
      </div>
      <p className="combat-lab-observer-run-state" role="status">{run ? statusText[run.status] : runId ? 'Подключение к прогону…' : config || mode === 'scenarios' ? 'Готов к запуску' : 'Настройка стычки'}</p>
    </header>

    <nav className="combat-lab-observer-view-tabs" role="tablist" aria-label="Раздел боевого стенда">
      <button type="button" role="tab" aria-selected={setupOpen} aria-controls="combat-lab-setup-panel" onClick={() => setSetupOpen(true)}>
        Настройка
      </button>
      <button type="button" role="tab" aria-selected={!setupOpen} aria-controls="combat-lab-battle-panel" disabled={!runId} onClick={() => setSetupOpen(false)}>
        Бой{run?.status === 'running' ? ' идёт' : ''}
      </button>
    </nav>

    <div className="combat-lab-observer-runbar">
      <div className="combat-lab-observer-runbar-fields">
        {mode === 'scenarios' ? <label>Сценарий
          <select value={scenario} onChange={(event) => setScenario(event.target.value)} disabled={running || busy}>
            {scenarios.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label> : <p className="combat-lab-observer-mode-name"><span>Режим</span><strong>Своя арена</strong></p>}
        <label className="combat-lab-observer-seed" title="Одинаковый номер повторяет последовательность бросков">Набор бросков
          <input type="number" min="0" max="4294967295" step="1" value={seed} onChange={(event) => setSeed(event.target.value)} disabled={running || busy} />
        </label>
      </div>
      <div className="combat-lab-observer-runbar-actions">
        <button type="button" className="combat-lab-primary" onClick={() => void start()} disabled={running || busy || !seedValid || (mode === 'custom' ? !config : !scenarios.length)}>
          <Play size={16} />{busy && !running ? 'Подготовка…' : 'Запустить бой'}
        </button>
        {running && <button type="button" onClick={() => void stop()} disabled={busy}><Square size={16} />Остановить</button>}
        {run && run.status !== 'running' && <a className="combat-lab-observer-report-link" href={`/api/admin/combat-lab/runs/${encodeURIComponent(run.id)}/report`} download>Скачать журнал</a>}
      </div>
      <p className="combat-lab-observer-runbar-status" role="status">{runStatus}</p>
    </div>

    {(error || run?.error) && <div className="combat-lab-observer-alerts">
      {error && <p className="combat-lab-error" role="alert">{error}</p>}
      {run?.error && <p className="combat-lab-error" role="alert">{run.error}</p>}
    </div>}

    <div id="combat-lab-setup-panel" role="tabpanel" aria-label="Настройка боя" hidden={!setupOpen}>
      <div className="combat-lab-observer-mode-tabs" role="tablist" aria-label="Тип прогона">
        <button type="button" role="tab" aria-selected={mode === 'custom'} disabled={running || busy} onClick={() => { setMode('custom'); setSetupOpen(true) }}>Своя арена</button>
        <button type="button" role="tab" aria-selected={mode === 'scenarios'} disabled={running || busy} onClick={() => { setMode('scenarios'); setSetupOpen(true) }}>Проверочные сценарии</button>
      </div>
      <div className="combat-lab-observer-setup-mount" hidden={mode !== 'custom'}>
        <CombatLabSetup disabled={running || busy} onChange={setConfig} />
      </div>
      {mode === 'scenarios' && <div className="combat-lab-observer-scenario-note">
        <h2>Проверочный прогон</h2>
        <p>Сценарий проверяет боевые правила и сохраняет события в журнал. Выберите его в панели запуска выше.</p>
      </div>}
    </div>

    {!setupOpen && <section id="combat-lab-battle-panel" className="combat-lab-observer-battle" role="tabpanel" aria-label="Просмотр боя">
      {!frame ? <div className="combat-lab-observer-loading" role="status"><h2>Загрузка боя</h2><p>Получаю первые подтверждённые моменты прогона…</p></div> : <>
        <div className="combat-lab-observer-battle-heading">
          <div>
            <h2>{outcome ?? 'Просмотр боя'}</h2>
            <p>{`Раунд ${frame.round || 1}${activeActor ? ` · ход: ${actorLabel(activeActor)}` : ''}`}</p>
          </div>
          <p className="combat-lab-observer-frame-count">Момент {cursor + 1} из {run?.frames.length ?? 1}</p>
        </div>
        <div className="combat-lab-observer-playback" aria-label="Управление просмотром боя">
          <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Приостановить просмотр' : 'Продолжить просмотр'}>
            {playing ? <Pause size={16} /> : <Play size={16} />}{playing ? 'Пауза' : 'Продолжить'}
          </button>
          <button type="button" aria-label="Предыдущий момент" disabled={cursor === 0} onClick={() => { setPlaying(false); setCursor((value) => Math.max(0, value - 1)) }}><ChevronLeft size={18} /></button>
          <div className="combat-lab-observer-range">
            <input aria-label="Момент боя" type="range" min="0" max={Math.max(0, (run?.frames.length ?? 1) - 1)} value={cursor} onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)) }} />
            <output>{cursor + 1} / {run?.frames.length ?? 1}</output>
          </div>
          <button type="button" aria-label="Следующий момент" disabled={cursor >= (run?.frames.length ?? 1) - 1} onClick={() => { setPlaying(false); setCursor((value) => Math.min((run?.frames.length ?? 1) - 1, value + 1)) }}><ChevronRight size={18} /></button>
          <label className="combat-lab-observer-speed">Темп
            <select value={delay} onChange={(event) => setDelay(Number(event.target.value))}><option value="1400">Медленно</option><option value="800">Обычно</option><option value="250">Быстро</option></select>
          </label>
          <button type="button" onClick={() => { setPlaying(false); setCursor(Math.max(0, (run?.frames.length ?? 1) - 1)) }}>К последнему</button>
        </div>

        <div className="combat-lab-observer-battle-grid">
          <div className="combat-lab-observer-arena-column">
            <div className="combat-lab-observer-board-heading"><h3>Карта боя</h3><span>{frame.actors.length} участников</span></div>
            <div className="combat-lab-observer-board-shell">
              <CombatLabBoard map={frame.map} cells={frame.cells} actors={frame.actors.map((actor) => ({ ...actor, name: actorLabel(actor) }))} activeActorId={frame.activeActorId} selectedActorId={selectedActorId} onSelectActor={setSelectedActorId} events={frame.gameEvents} frameId={`${run?.id}:${frame.index}`} />
            </div>

            <section className="combat-lab-observer-participants" aria-labelledby="combat-lab-participants-title">
              <div className="combat-lab-observer-panel-heading"><h3 id="combat-lab-participants-title">Участники</h3><span>{frame.actors.length}</span></div>
              <div className="combat-lab-observer-roster">
                {(['party', 'enemy'] as const).map((side) => {
                  const actors = frame.actors.filter((actor) => actor.side === side)
                  if (!actors.length) return null
                  return <section key={side} aria-labelledby={`combat-lab-${side}-title`}>
                    <h4 id={`combat-lab-${side}-title`}>{side === 'party' ? 'Отряд' : 'Противники'} <span>{actors.length}</span></h4>
                    <ul>
                      {actors.map((actor) => {
                        const selected = actor.id === focusedActor?.id
                        return <li key={actor.id}><button type="button" className={`combat-lab-observer-actor-row ${selected ? 'selected' : ''} ${actor.id === frame.activeActorId ? 'active' : ''}`} aria-pressed={selected} onClick={() => setSelectedActorId(actor.id)}>
                          <span className={`combat-lab-observer-actor-mark ${actor.side}`} aria-hidden="true">{actor.image?.startsWith('/assets/') ? <img src={actor.image} alt="" /> : actorInitial(actor.name)}</span>
                          <span className="combat-lab-observer-actor-copy"><strong>{actorLabel(actor)}</strong><span>{actor.id === frame.activeActorId ? 'Ход сейчас' : actor.hp <= 0 ? 'Выведен из боя' : `${actor.hp} / ${actor.maxHp} ОЗ`}</span><span className="combat-lab-observer-hp-bar"><i style={{ width: `${healthPercent(actor)}%` }} /></span></span>
                          <span className="combat-lab-observer-actor-hp">{healthPercent(actor)}%</span>
                        </button></li>
                      })}
                    </ul>
                  </section>
                })}
              </div>
            </section>

            {focusedActor && <article className="combat-lab-observer-actor-details" aria-live="polite">
              <header>
                <span className={`combat-lab-observer-detail-mark ${focusedActor.side}`} aria-hidden="true">{focusedActor.image?.startsWith('/assets/') ? <img src={focusedActor.image} alt="" /> : actorInitial(focusedActor.name)}</span>
                <div><h3>{actorLabel(focusedActor)}</h3><p>{focusedActor.side === 'party' ? 'Отряд' : 'Противник'}{focusedActor.id === frame.activeActorId ? ' · ход сейчас' : ''}</p></div>
                <strong>{focusedActor.hp} / {focusedActor.maxHp} ОЗ</strong>
              </header>
              <dl className="combat-lab-observer-detail-facts"><div><dt>Клетка</dt><dd>{focusedActor.x}, {focusedActor.y}</dd></div><div><dt>Состояние</dt><dd>{focusedActor.hp <= 0 ? 'Выведен из боя' : 'В строю'}</dd></div></dl>
              {focusedActor.conditions && focusedActor.conditions.length > 0 && <p className="combat-lab-observer-conditions"><strong>Состояния</strong> {focusedActor.conditions.map((condition) => conditionPresentation(condition).label).join(', ')}</p>}
              <div className="combat-lab-observer-details-body">
                <section><h4>Способности</h4><ul className="combat-lab-observer-arsenal-list">{focusedActor.arsenal?.length ? focusedActor.arsenal.map((item, index) => <li key={`${item.name}:${index}`}><span>{item.name}</span><em>{arsenalStatus(item.status)}</em></li>) : <li>Способности не переданы в этот кадр.</li>}</ul></section>
                <section><h4>Ресурсы</h4>{Object.entries(focusedActor.resources ?? {}).length ? <dl className="combat-lab-observer-resource-list">{Object.entries(focusedActor.resources ?? {}).map(([key, value]) => <div key={key}><dt>{resourceName(key)}</dt><dd>{value.current} / {value.max}</dd></div>)}</dl> : <p>Отдельные ресурсы не отслеживаются.</p>}</section>
              </div>
            </article>}
          </div>

          <aside className="combat-lab-observer-journal-panel">
            <div className="combat-lab-observer-journal-heading"><div><h2>Журнал боя</h2><p>События до выбранного момента</p></div><strong>{visibleEventCount}</strong></div>
            <div className="combat-lab-observer-journal-filters" role="tablist" aria-label="Фильтр журнала">
              <button type="button" role="tab" aria-selected={journalFilter === 'all'} onClick={() => setJournalFilter('all')}>Все события</button>
              <button type="button" role="tab" aria-selected={journalFilter === 'tactics'} onClick={() => setJournalFilter('tactics')}>Тактики</button>
            </div>
            <div className="combat-lab-journal combat-lab-observer-journal-scroll" ref={journal} tabIndex={0} aria-label="Журнал боя">
              {cursor >= 100 && <p className="combat-lab-observer-journal-note">Показаны последние 100 моментов до выбранного. Для более ранних событий переместите ползунок.</p>}
              {visibleMoments.map((moment) => <section className="combat-lab-observer-journal-moment" key={moment.index}>
                <div className="combat-lab-observer-moment-heading"><h3>Раунд {moment.round || 1}</h3><span>Момент {moment.index + 1}</span></div>
                <ul>{moment.events.map((event, index) => <li key={`${event.id}:${index}`}><span className="combat-lab-observer-event-actor">{event.actorId ? actorNames.get(event.actorId) ?? 'Участник' : 'Система'}</span><p>{displayEventText(event.text)}</p></li>)}</ul>
              </section>)}
              {!visibleEventCount && <p className="combat-lab-observer-journal-empty">До этого момента нет событий выбранного типа.</p>}
            </div>
          </aside>
        </div>
        <p className="combat-lab-note combat-lab-observer-note">Момент {cursor + 1} из {run?.frames.length}. Пауза останавливает только просмотр; расчёт боя продолжается.</p>
      </>}
    </section>}
  </section>
}
