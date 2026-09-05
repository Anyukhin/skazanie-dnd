import { useEffect, useRef, useState } from 'react'
import { Mic, Square, LoaderCircle } from 'lucide-react'
import { startSpeechRecording } from './speech-recording'
import './voice-input.css'

/** Запись отправляется только нашему серверу; результат остаётся черновиком. */
export function VoiceInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'processing'>('idle')
  const [message, setMessage] = useState('')
  const latest = useRef({ value, onChange, disabled })
  latest.current = { value, onChange, disabled }
  const recording = useRef<Awaited<ReturnType<typeof startSpeechRecording>> | null>(null)
  const request = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const cancel = () => {
    generation.current++
    pending.current = false
    if (timer.current) clearTimeout(timer.current)
    recording.current?.cancel(); recording.current = null
    request.current?.abort(); request.current = null
  }
  useEffect(() => cancel, [])
  useEffect(() => { if (disabled) { cancel(); setPhase('idle'); setMessage('') } }, [disabled])

  const finish = async () => {
    const capture = recording.current
    if (!capture) return
    recording.current = null
    if (timer.current) clearTimeout(timer.current)
    const run = generation.current
    const controller = new AbortController()
    request.current = controller
    const timeout = setTimeout(() => controller.abort(), 125000)
    setPhase('processing'); setMessage('Распознаю запись на сервере…')
    try {
      const audio = capture.finish()
      const response = await fetch('/api/speech/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal: controller.signal })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось распознать запись.')
      if (generation.current !== run || latest.current.disabled) return
      const text = String(result.text ?? '').trim()
      if (!text) { setMessage('Речь не распознана. Попробуйте ещё раз.'); return }
      latest.current.onChange([latest.current.value.trimEnd(), text].filter(Boolean).join(' '))
      setMessage('Текст добавлен. Проверьте его перед отправкой.')
    } catch (error) {
      if (generation.current === run) setMessage(error instanceof Error && error.name === 'AbortError' ? 'Распознавание заняло слишком много времени. Попробуйте короче.' : error instanceof Error ? error.message : 'Ошибка распознавания.')
    } finally {
      clearTimeout(timeout)
      if (generation.current === run) { pending.current = false; request.current = null; setPhase('idle') }
    }
  }
  const start = async () => {
    if (recording.current) { await finish(); return }
    if (pending.current || disabled) return
    pending.current = true
    const run = ++generation.current
    const controller = new AbortController()
    request.current = controller
    const timeout = setTimeout(() => controller.abort(), 10000)
    setPhase('starting'); setMessage('Подключаю микрофон…')
    try {
      const response = await fetch('/api/speech/status', { signal: controller.signal })
      const status = await response.json()
      if (!response.ok || !status.available) throw new Error('Локальное распознавание ещё не настроено на сервере.')
      clearTimeout(timeout)
      if (generation.current !== run) return
      const capture = await startSpeechRecording()
      if (generation.current !== run || latest.current.disabled) { capture.cancel(); return }
      recording.current = capture
      setPhase('recording'); setMessage('Говорите. Нажмите квадрат, чтобы распознать. Максимум 60 секунд.')
      timer.current = setTimeout(() => { void finish() }, 60000)
    } catch (error) {
      if (generation.current !== run) return
      pending.current = false; setPhase('idle')
      setMessage(error instanceof Error && error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону в браузере и повторите.' : error instanceof Error && error.name === 'NotFoundError' ? 'Микрофон не найден.' : error instanceof Error ? error.message : 'Не удалось включить микрофон.')
    } finally { clearTimeout(timeout) }
  }
  const listening = phase === 'recording'
  const working = phase === 'starting' || phase === 'processing'
  return <span className="voice-input-control">
    <button type="button" className={listening ? 'voice-input-button listening' : 'voice-input-button'} onClick={() => { void start() }} disabled={disabled || working} aria-pressed={listening} aria-label={listening ? 'Остановить голосовой ввод' : 'Голосовой ввод'} title={listening ? 'Остановить запись и распознать' : 'Продиктовать по-русски. Запись распознаётся на сервере игры, отправка текста вручную.'}>{listening ? <Square size={17} /> : working ? <LoaderCircle size={19} /> : <Mic size={19} />}</button>
    {message && <span className="voice-input-message" role="status">{message}</span>}
  </span>
}
