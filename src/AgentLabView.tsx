import { useMemo, useState } from 'react'
import { ArrowRight, BrainCircuit, Map, Play, Route, ShieldCheck, Sparkles } from 'lucide-react'
import type { GameState, MapCell, SceneTransition } from './types'
import './agent-lab.css'

type LabStage = { agent: string; status: string; output: Record<string, unknown> | null }
type LabResult = { dry_run: boolean; transition: SceneTransition | null; stages: LabStage[]; narration?: string }

const agentLabels: Record<string, string> = {
  AgentDirector: 'Режиссёр',
  AgentCartographer: 'Картограф',
  WorldEngine: 'Движок мира',
  AgentNarrator: 'Рассказчик',
}

function LabMap({ cells }: { cells: MapCell[] }) {
  const width = Math.max(1, ...cells.map((cell) => cell.x + 1))
  return <div className="lab-map" style={{ gridTemplateColumns: `repeat(${width}, minmax(14px, 1fr))` }}>
    {cells.map((cell) => <span key={`${cell.x}:${cell.y}`} className={`${cell.type} ${cell.revealed ? 'revealed' : 'hidden'} ${cell.feature ? 'feature' : ''}`} title={`${cell.x}:${cell.y}${cell.feature ? ` · ${cell.feature}` : ''}`}>{cell.feature ? '•' : ''}</span>)}
  </div>
}

export function AgentLabView({ state }: { state: GameState }) {
  const [location, setLocation] = useState(state.scene.location || 'Затопленный архив Норвина')
  const [objective, setObjective] = useState(state.scene.objective || 'Исследовать печать архивариуса')
  const [hook, setHook] = useState(state.adventure?.currentHook || 'Печать архивариуса открывает путь к скрытой части архива')
  const [decision, setDecision] = useState('Уходим в город — отступаем и ищем другой путь, сохранив нить с печатью архивариуса')
  const [result, setResult] = useState<LabResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const dimensions = useMemo(() => {
    const cells = result?.transition?.scene.cells ?? []
    return cells.length ? `${Math.max(...cells.map((cell) => cell.x)) + 1} × ${Math.max(...cells.map((cell) => cell.y)) + 1}` : '—'
  }, [result])

  const run = async () => {
    setRunning(true); setError(''); setResult(null)
    try {
      const response = await fetch('/api/agent-lab/scene-transition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: state.sessionCode, decision, scene: { ...state.scene, location, objective }, adventure: { ...state.adventure, currentHook: hook } }),
      })
      const body = await response.json() as LabResult & { error?: string }
      if (!response.ok) throw new Error(body.error || 'Тестовый прогон завершился ошибкой')
      setResult(body)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось выполнить прогон') }
    finally { setRunning(false) }
  }

  return <section className="agent-lab-page">
    <header className="agent-lab-hero">
      <div><span>ИЗОЛИРОВАННАЯ ПЕСОЧНИЦА</span><h1>Лаборатория агентов</h1><p>Свободное решение проходит через тех же агентов, что и настоящий ход, но состояние кампании не сохраняется.</p></div>
      <em><ShieldCheck size={16} />DRY RUN</em>
    </header>

    <div className="agent-lab-layout">
      <aside className="lab-inputs">
        <div className="lab-card-title"><Route size={18} /><span><b>Исходная ситуация</b><small>Любая сцена и любой замысел игроков</small></span></div>
        <label><span>Текущая локация</span><input value={location} onChange={(event) => setLocation(event.target.value)} /></label>
        <label><span>Текущая цель</span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
        <label><span>Незавершённая нить</span><textarea value={hook} onChange={(event) => setHook(event.target.value)} /></label>
        <label><span>Решение группы</span><textarea className="lab-decision" value={decision} onChange={(event) => setDecision(event.target.value)} /></label>
        <button className="lab-run" onClick={() => void run()} disabled={running || !decision.trim()}><Play size={16} />{running ? 'Агенты моделируют сцену…' : 'Запустить свободный прогон'}</button>
        {error && <p className="lab-error">{error}</p>}
      </aside>

      <main className="lab-output">
        {!result && <div className="lab-empty"><BrainCircuit size={34} /><h2>{running ? 'Идёт передача между агентами' : 'Прогон ещё не запущен'}</h2><p>Картограф сам выберет планировку и размер поля на основе решения, а не из списка готовых сценариев.</p></div>}
        {result && <>
          <div className="lab-pipeline">
            {result.stages.map((stage, index) => <div className="lab-stage-wrap" key={`${stage.agent}:${index}`}>
              <article className="lab-stage"><span>{stage.agent === 'AgentCartographer' ? <Map size={17} /> : stage.agent === 'AgentNarrator' ? <Sparkles size={17} /> : <BrainCircuit size={17} />}</span><div><small>ШАГ {index + 1}</small><b>{agentLabels[stage.agent] ?? stage.agent}</b><p>{stage.agent === 'AgentDirector' ? 'Понял фактический выбор группы' : stage.agent === 'AgentCartographer' ? 'Спроектировал новую сцену и карту' : stage.agent === 'WorldEngine' ? 'Создал валидное игровое поле' : 'Связал переход повествованием'}</p></div></article>
              {index < result.stages.length - 1 && <ArrowRight className="lab-arrow" size={16} />}
            </div>)}
          </div>
          {result.transition ? <div className="lab-result-grid">
            <section className="lab-preview"><div className="lab-card-title"><Map size={18} /><span><b>{result.transition.scene.location}</b><small>Карта {dimensions} · {result.transition.scene.cells.length} клеток</small></span></div><LabMap cells={result.transition.scene.cells} /></section>
            <section className="lab-narrative"><span>РЕЗУЛЬТАТ ПЕРЕХОДА</span><h2>{result.transition.scene.title}</h2><p>{result.transition.transition}</p><p>{result.transition.arrival}</p><dl><div><dt>Новая цель</dt><dd>{result.transition.scene.objective}</dd></div><div><dt>Сохранённый крючок</dt><dd>{result.transition.adventure.currentHook}</dd></div></dl></section>
          </div> : <div className="lab-no-transition"><h2>Смена карты не потребовалась</h2><p>{result.narration}</p></div>}
        </>}
      </main>
    </div>
  </section>
}

