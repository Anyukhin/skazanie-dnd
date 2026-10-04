/*
 * Режимы реакций, как в Baldur's Gate 3: «спрашивать», «сразу», «никогда».
 *
 * Список реакций и текущие режимы приходят с сервера (`player.reactionModes`),
 * здесь их только рисуют и отправляют выбор командой `SetReactionPreference`.
 * Исполняет режим сервер: «сразу» и «никогда» он отвечает за героя в той же
 * команде, что открыла окно реакции, поэтому окно до стола не доходит.
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { CombatIcon } from './CombatIcon'
import type { HeroReactionMode, ReactionMode } from './types'

export const REACTION_MODES: readonly ReactionMode[] = ['ask', 'auto', 'never']

export const REACTION_MODE_LABELS: Record<ReactionMode, string> = {
  ask: 'Спрашивать',
  auto: 'Сразу',
  never: 'Никогда',
}

const REACTION_MODE_HINTS: Record<ReactionMode, string> = {
  ask: 'В ход врага игра остановится и предложит ответить',
  auto: 'Сервер ответит сам, как только появится повод',
  never: 'Повод пройдёт без ответа, реакция останется',
}

/** Иконка реакции: у заклинания — по id заклинания, у действия — по своему id. */
export function reactionIconId(reaction: Pick<HeroReactionMode, 'id' | 'spell_id'>): string {
  return reaction.spell_id ?? reaction.id
}

export function reactionModeTitle(reaction: Pick<HeroReactionMode, 'name' | 'mode'>): string {
  return `${reaction.name} — ${REACTION_MODE_LABELS[reaction.mode].toLowerCase()}`
}

/** Облачко «спрашивать», как в BG3: без него реакция срабатывает сама или выключена. */
export function ReactionAskMark() {
  return <svg className="reaction-ask-mark" width="13" height="12" viewBox="0 0 13 12" aria-hidden="true"><path d="M1 1.5h11v6.5H6.5L3.5 10.5V8H1z" /></svg>
}

type PanelPlacement = { right: number; bottom: number }

/** Панель встаёт над кнопкой, которая её открыла, правым краем к её правому краю. */
function placementFor(anchorElement: HTMLElement, previous: PanelPlacement | null): PanelPlacement | null {
  if (!anchorElement.isConnected) return previous
  const rect = anchorElement.getBoundingClientRect()
  return { right: Math.max(8, window.innerWidth - rect.right), bottom: Math.max(8, window.innerHeight - rect.top + 8) }
}

export function ReactionModesPanel({ heroName, reactions, busy, focusId, anchorElement, onSet, onClose }: {
  heroName: string
  reactions: HeroReactionMode[]
  busy: boolean
  focusId?: string | null
  anchorElement: HTMLElement
  onSet: (reaction: HeroReactionMode, mode: ReactionMode) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  const [placement, setPlacement] = useState<PanelPlacement | null>(() => placementFor(anchorElement, null))
  // Окно меняет размер (экранная клавиатура, поворот, панель браузера) — панель
  // переезжает к своей кнопке, а не закрывается под рукой игрока.
  useEffect(() => {
    const follow = () => setPlacement((previous) => placementFor(anchorElement, previous))
    window.addEventListener('resize', follow)
    return () => window.removeEventListener('resize', follow)
  }, [anchorElement])
  useEffect(() => {
    const root = ref.current
    const row = root?.querySelector<HTMLElement>(`[data-reaction-id="${CSS.escape(String(focusId ?? reactions[0]?.id ?? ''))}"]`)
    row?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const closeOnOutside = (event: PointerEvent) => {
      if (root && event.target instanceof Node && !root.contains(event.target)
        && !(event.target instanceof Element && event.target.closest('[data-reaction-modes-anchor]'))) onClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
    // Фокус ставится один раз при открытии; смена режима его не перескакивает.
  }, [])
  // Стрелки внутри строки выбирают соседний режим, как в обычной группе радиокнопок.
  const onRowKey = (event: ReactKeyboardEvent<HTMLDivElement>, reaction: HeroReactionMode) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const next = REACTION_MODES[(REACTION_MODES.indexOf(reaction.mode) + step + REACTION_MODES.length) % REACTION_MODES.length]
    if (!busy) onSet(reaction, next)
    window.requestAnimationFrame(() => event.currentTarget?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus())
  }
  return <section ref={ref} className="reaction-modes-panel" role="dialog" aria-label={`Режимы реакций: ${heroName}`} style={placement ? { right: placement.right, bottom: placement.bottom } : undefined}>
    <header>
      <strong>Реакции</strong>
      <span>{heroName}</span>
      <button type="button" className="reaction-modes-close" aria-label="Закрыть режимы реакций" onClick={onClose}><X size={16} aria-hidden="true" /></button>
    </header>
    <p>«Спрашивать» в ход врага останавливает игру и даёт выбрать ответ. «Сразу» отвечает без вопроса, «Никогда» пропускает повод.</p>
    <ul>{reactions.map((reaction) => <li key={reaction.id} className={`reaction-mode-row mode-${reaction.mode}`} data-reaction-id={reaction.id}>
      <span className="reaction-mode-icon"><CombatIcon id={reactionIconId(reaction)} kind={reaction.kind === 'spell' ? 'spell' : 'action'} hint={reaction.name} size={34} compact />{reaction.mode === 'ask' && <ReactionAskMark />}</span>
      <span className="reaction-mode-name">{reaction.name}</span>
      <div className="reaction-mode-seg" role="radiogroup" aria-label={`Режим: ${reaction.name}`} onKeyDown={(event) => onRowKey(event, reaction)}>
        {REACTION_MODES.map((mode) => <button key={mode} type="button" role="radio" data-mode={mode} aria-checked={reaction.mode === mode} tabIndex={reaction.mode === mode ? 0 : -1} aria-disabled={busy || undefined} title={REACTION_MODE_HINTS[mode]} onClick={(event) => { event.currentTarget.focus(); if (!busy && reaction.mode !== mode) onSet(reaction, mode) }}>{REACTION_MODE_LABELS[mode]}</button>)}
      </div>
    </li>)}</ul>
  </section>
}
