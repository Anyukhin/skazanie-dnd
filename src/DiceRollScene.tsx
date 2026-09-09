import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { dieMesh, drawDie } from './dice-geometry'

export type DiceRollResult = { value: number; modifier: number; total: number }

type Props = {
  sides: number
  value: number
  rolling: boolean
  reducedMotion: boolean
  playerName?: string
  title?: string
  actualResult?: DiceRollResult | null
  onClose: () => void
}

export function DiceRollScene({ sides, value, rolling, reducedMotion, playerName, title = 'Свободный бросок', actualResult, onClose }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const angle = useRef(0)
  const titleId = useId()
  const shownValue = actualResult?.value ?? value
  const modifier = actualResult?.modifier ?? 0
  const resultDetails = actualResult
    ? `d${sides} · ${actualResult.value} ${modifier >= 0 ? '+' : '−'} ${Math.abs(modifier)} = ${actualResult.total}`
    : sides === 100 ? 'd100 · десятки и единицы' : `d${sides} · результат виден всем`
  useEffect(() => {
    const element = dialog.current!
    if (!element.open) element.showModal()
    return () => { if (element.open) element.close() }
  }, [])
  useEffect(() => {
    const element = canvas.current!
    const ctx = element.getContext('2d')
    if (!ctx) return
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    element.width = 600 * scale
    element.height = 400 * scale
    ctx.scale(scale, scale)
    const mesh = dieMesh(sides)
    const start = performance.now()
    const initial = angle.current
    const landing = Math.ceil(initial / (Math.PI * 2)) * Math.PI * 2
    let frame = 0
    const render = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / 650, 1)
      angle.current = reducedMotion ? 0 : rolling ? initial + elapsed / 420 : initial + (landing - initial) * (1 - (1 - progress) ** 3)
      ctx.clearRect(0,0,600,400)
      ctx.save()
      const bounce = rolling && !reducedMotion ? -Math.abs(Math.sin(elapsed / 160)) * 28 : 0
      ctx.translate(0,bounce)
      if (sides === 100) {
        drawDie(ctx,mesh,angle.current,rolling ? null : Math.floor(shownValue % 100 / 10) || 10,100,190,105,true)
        drawDie(ctx,mesh,-angle.current,rolling ? null : shownValue % 10 || 10,100,410,105)
      } else drawDie(ctx,mesh,angle.current,rolling ? null : shownValue,sides,300,140)
      ctx.restore()
      if (!reducedMotion && (rolling || progress < 1)) frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [sides, shownValue, rolling, reducedMotion])

  return createPortal(<dialog ref={dialog} className={`dice-cinematic ${rolling ? 'dice-cinematic--rolling' : 'dice-cinematic--result'}`} aria-labelledby={titleId} onCancel={onClose}>
    <button type="button" className="dice-cinematic__close" aria-label="Закрыть бросок" onClick={onClose}><X size={22} /></button>
    <div className="dice-cinematic__heading"><h2 id={titleId}>{title}</h2><p>{playerName || `Кость d${sides}`}</p></div>
    <div className="dice-cinematic__stage"><div className="dice-cinematic__circle" aria-hidden="true" /><canvas ref={canvas} aria-hidden="true" /></div>
    <div className="dice-cinematic__outcome" role="status" aria-live="polite">
      <p>{rolling ? 'Кость катится…' : `Выпало ${shownValue}`}</p>
      <span>{rolling ? `d${sides}` : resultDetails}</span>
    </div>
    <button type="button" className="dice-cinematic__continue" onClick={onClose}>{rolling ? 'Скрыть анимацию' : 'Продолжить'}</button>
  </dialog>, document.body)
}
