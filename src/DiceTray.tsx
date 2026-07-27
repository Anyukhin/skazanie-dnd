import { useEffect, useRef, useState } from 'react'
import { Dices, Wifi } from 'lucide-react'
import type { DiceRollEvent } from './types'
import './dice-tray.css'

type DiceTrayProps = {
  latestRoll?: DiceRollEvent | null
  onRoll: (sides: number) => Promise<DiceRollEvent>
  disabled?: boolean
  /** Значок на карте вместо карточки в колонке: кость и список костей по нажатию. */
  compact?: boolean
}

/* Набор повторяет серверный: подставить произвольную грань клиент не может. */
const DICE = [4, 6, 10, 20, 100] as const

type AnimationPhase = 'idle' | 'rolling' | 'settled'

const ROLL_ANIMATION_MS = 900
const REMOTE_ANIMATION_MS = 760

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  return reduced
}

function wait(duration: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, duration))
}

function timeLabel(rolledAt: number) {
  return new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date(rolledAt))
}

function D20({ value }: { value: number }) {
  return (
    <svg className="dice-tray__polyhedron" viewBox="0 0 120 108" aria-hidden="true">
      <defs>
        <linearGradient id="dice-tray-gold" x1="18" y1="8" x2="101" y2="102" gradientUnits="userSpaceOnUse">
          <stop stopColor="#efc98d" />
          <stop offset=".48" stopColor="#b8783f" />
          <stop offset="1" stopColor="#56331e" />
        </linearGradient>
      </defs>
      <path className="dice-tray__die-shell" d="M60 3 111 35 98 92 60 105 22 92 9 35 60 3Z" />
      <path className="dice-tray__die-face" d="m60 20 31 56H29L60 20Z" />
      <path className="dice-tray__die-lines" d="M60 3v17M9 35l20 41-7 16m89-57L91 76l7 16M60 105 29 76M60 105l31-29M9 35l51-15 51 15M22 92l38-72 38 72" />
      <text x="60" y="68" textAnchor="middle">{value}</text>
    </svg>
  )
}

/**
 * A server-backed free d20 roll. Pass GameState.lastDiceRoll so rolls made by
 * other players animate here too.
 */
export function DiceTray({ latestRoll, onRoll, disabled = false, compact = false }: DiceTrayProps) {
  const reducedMotion = usePrefersReducedMotion()
  const [visibleRoll, setVisibleRoll] = useState<DiceRollEvent | null>(() => latestRoll ?? null)
  const [displayValue, setDisplayValue] = useState(() => latestRoll?.value ?? 20)
  const [phase, setPhase] = useState<AnimationPhase>('idle')
  const [error, setError] = useState('')
  const [sides, setSides] = useState(20)
  const [menuOpen, setMenuOpen] = useState(false)
  const ownRollPending = useRef(false)
  const settleTimer = useRef<number | null>(null)

  const clearSettleTimer = () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    settleTimer.current = null
  }

  const showResult = (roll: DiceRollEvent) => {
    clearSettleTimer()
    setVisibleRoll(roll)
    setDisplayValue(roll.value)
    setPhase('settled')
    settleTimer.current = window.setTimeout(() => setPhase('idle'), reducedMotion ? 0 : 420)
  }

  useEffect(() => () => clearSettleTimer(), [])

  useEffect(() => {
    if (phase !== 'rolling' || reducedMotion) return
    const timer = window.setInterval(() => setDisplayValue(Math.floor(Math.random() * sides) + 1), 72)
    return () => window.clearInterval(timer)
  }, [phase, reducedMotion, sides])

  useEffect(() => {
    if (!latestRoll || latestRoll.id === visibleRoll?.id || ownRollPending.current) return
    setError('')
    setPhase('rolling')
    const timer = window.setTimeout(() => showResult(latestRoll), reducedMotion ? 0 : REMOTE_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [latestRoll, reducedMotion, visibleRoll?.id])

  const handleRoll = async (rollSides: number = sides) => {
    if (disabled || phase === 'rolling' || ownRollPending.current) return
    setSides(rollSides)
    setMenuOpen(false)
    ownRollPending.current = true
    setError('')
    setPhase('rolling')
    const startedAt = performance.now()
    try {
      const roll = await onRoll(rollSides)
      const elapsed = performance.now() - startedAt
      if (!reducedMotion && elapsed < ROLL_ANIMATION_MS) await wait(ROLL_ANIMATION_MS - elapsed)
      showResult(roll)
    } catch (reason) {
      clearSettleTimer()
      setPhase('idle')
      setDisplayValue(visibleRoll?.value ?? rollSides)
      setError(reason instanceof Error ? reason.message : `Не удалось бросить d${rollSides}`)
    } finally {
      ownRollPending.current = false
    }
  }

  const rolling = phase === 'rolling'
  const status = error
    ? error
    : rolling
      ? 'Кость катится…'
      : visibleRoll
        ? `${visibleRoll.playerName}: выпало ${visibleRoll.value} на d${visibleRoll.sides ?? sides}`
        : `Свободный бросок d${sides} готов`

  /* На карте — только кость. Список костей открывается по нажатию и закрывается
     выбором, повторным нажатием или щелчком мимо: карточке с подписями на поле
     места нет, а бросок нужен под рукой. */
  if (compact) {
    return (
      <aside className={`dice-tray dice-tray--compact dice-tray--${phase}${error ? ' dice-tray--error' : ''}`} aria-label="Свободный бросок" aria-busy={rolling}>
        {menuOpen && <div className="dice-tray__backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
        <button
          className="dice-tray__chip"
          type="button"
          onClick={() => (rolling ? undefined : setMenuOpen((open) => !open))}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={rolling ? 'Кость катится…' : 'Свободный бросок — выберите кость'}
        >
          <span className="dice-tray__die"><D20 value={displayValue} /></span>
          <b>{rolling ? '…' : visibleRoll ? visibleRoll.value : `d${sides}`}</b>
        </button>
        {menuOpen && <div className="dice-tray__menu" role="menu">
          <small>СВОБОДНЫЙ БРОСОК</small>
          <div>{DICE.map((die) => <button key={die} type="button" role="menuitem" className={die === sides ? 'active' : ''} onClick={() => { void handleRoll(die) }}>d{die}</button>)}</div>
          <em>{visibleRoll ? `${visibleRoll.playerName}: ${visibleRoll.value} · ${timeLabel(visibleRoll.rolledAt)}` : 'Результат увидят все'}</em>
        </div>}
        <span className="dice-tray__sr-status" role="status" aria-live="polite">{status}</span>
      </aside>
    )
  }

  return (
    <aside className={`dice-tray dice-tray--${phase}${error ? ' dice-tray--error' : ''}`} aria-label="Свободный бросок d20" aria-busy={rolling}>
      <button className="dice-tray__button" type="button" onClick={() => { void handleRoll() }} disabled={disabled || rolling} aria-label={rolling ? 'Выполняется бросок d20' : 'Бросить d20'}>
        <span className="dice-tray__die-scene"><span className="dice-tray__die"><D20 value={displayValue} /></span><i /></span>
        <span className="dice-tray__copy">
          <small><Dices size={12} /> СВОБОДНЫЙ БРОСОК</small>
          <strong>{rolling ? 'Кость катится…' : visibleRoll ? `Выпало ${visibleRoll.value}` : 'Бросить d20'}</strong>
          <span className={error ? 'dice-tray__error' : ''}>
            {error || (visibleRoll ? <><Wifi size={10} />{visibleRoll.playerName} · {timeLabel(visibleRoll.rolledAt)}</> : 'Результат увидят все')}
          </span>
        </span>
      </button>
      <span className="dice-tray__sr-status" role="status" aria-live="polite">{status}</span>
    </aside>
  )
}
