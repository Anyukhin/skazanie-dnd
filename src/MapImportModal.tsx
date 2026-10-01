import { useMemo, useRef, useState } from 'react'
import { Map as MapIcon, X } from 'lucide-react'
import { CombatLabBoard } from './CombatLabBoard'
import { useDialogEscape } from './app-shared'
import type { GameState, SerializedTacticalMap, WorldMapLocation } from './types'
import './map-import.css'

type ImportedLevel = { index: number; label: string; map: SerializedTacticalMap }
type PreviewResult = {
  location: { id: string; name: string; current: boolean }
  levels: ImportedLevel[]
  stats: Record<string, number>
  warnings: string[]
  source: { version: number; instances: number }
}

const STAT_LABELS: Array<[string, string]> = [
  ['floorCells', 'клеток пола'], ['walls', 'стен'], ['doors', 'дверей'], ['windows', 'окон'],
  ['rails', 'низких ограждений'], ['blockedCells', 'глухих клеток'], ['difficultCells', 'трудной местности'],
  ['props', 'предметов'], ['transitions', 'лестниц между этажами'],
]

/**
 * Предпросмотр рисует этаж целиком: туман войны — забота игроков, а ведущему
 * нужно увидеть всю карту до того, как её получат они.
 */
function revealedForPreview(map: SerializedTacticalMap): SerializedTacticalMap {
  const layers = map.layers as Record<string, unknown> | undefined
  return layers ? { ...map, layers: { ...layers, revealed: layers.present } } : map
}

/**
 * Импорт карты из TaleSpire. Ведущий вставляет строку слэба, смотрит этажи и
 * применяет их к выбранной локации. Вся геометрия считается сервером; окно
 * только показывает его ответ и отправляет подтверждение.
 */
export function MapImportModal({ code, locations, currentLocationId, currentLocationName, onApplied, onClose }: {
  code: string
  locations: WorldMapLocation[]
  currentLocationId: string
  currentLocationName: string
  onApplied: (result: { version?: number; state: GameState; message: string }) => Promise<void> | void
  onClose: () => void
}) {
  useDialogEscape(onClose)
  const [slab, setSlab] = useState('')
  const [locationId, setLocationId] = useState(currentLocationId)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [levelIndex, setLevelIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  // Один ключ на один предпросмотр: повторное нажатие «Применить» после сбоя
  // сети не создаст второго импорта.
  const applyKey = useRef('')

  const options = useMemo(() => {
    const others = locations.filter((location) => location.id !== currentLocationId)
    return [{ id: currentLocationId, name: `${currentLocationName || 'Текущая сцена'} — текущая сцена` }, ...others.map((location) => ({ id: location.id, name: location.name }))]
  }, [locations, currentLocationId, currentLocationName])

  const request = async (mode: 'preview' | 'apply') => {
    const response = await fetch(`/api/campaigns/${encodeURIComponent(code)}/map-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, slab, location_id: locationId, ...(mode === 'apply' ? { idempotency_key: applyKey.current } : {}) }),
    })
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok || !body) throw new Error(String(body?.error || 'Не удалось разобрать слэб'))
    return body
  }

  const runPreview = async () => {
    setBusy(true)
    setError('')
    setDone('')
    try {
      const body = await request('preview') as unknown as PreviewResult
      setPreview(body)
      setLevelIndex(body.levels.some((level) => level.index === 0) ? 0 : body.levels[0]?.index ?? 0)
      applyKey.current = `map-import:${crypto.randomUUID()}`
    } catch (reason) {
      setPreview(null)
      setError(reason instanceof Error ? reason.message : 'Не удалось разобрать слэб')
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      const body = await request('apply')
      const state = body.state as GameState | undefined
      if (!state) throw new Error('Сервер не вернул состояние кампании')
      const message = body.applied_to_scene === true
        ? `Карта «${preview.location.name}» применена к текущей сцене`
        : `Карта «${preview.location.name}» сохранена: она включится, когда отряд туда придёт`
      await onApplied({ version: typeof body.version === 'number' ? body.version : undefined, state, message })
      setPreview(null)
      setSlab('')
      setDone(message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось применить карту')
    } finally {
      setBusy(false)
    }
  }

  const level = preview?.levels.find((entry) => entry.index === levelIndex) ?? preview?.levels[0]
  const target = options.find((option) => option.id === locationId)
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal map-import-modal" role="dialog" aria-modal="true" aria-labelledby="map-import-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть импорт карты" title="Закрыть"><X size={19} /></button>
        <div className="modal-icon"><MapIcon size={23} /></div>
        <span className="eyebrow">ИМПОРТ КАРТЫ</span>
        <h2 id="map-import-title">Карта из TaleSpire</h2>
        <p>В TaleSpire включите строительство, выделите область вместе с полом и нажмите Ctrl+C. Вставьте строку сюда: сервер разберёт этажи, стены, двери и предметы и нарисует их нашими тайлами.</p>
        <label className="map-import-field">
          <span>Локация</span>
          <select value={locationId} onChange={(event) => { setLocationId(event.target.value); setPreview(null) }} disabled={busy}>
            {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <label className="map-import-field">
          <span>Слэб</span>
          <textarea value={slab} onChange={(event) => { setSlab(event.target.value); setPreview(null) }} rows={4} spellCheck={false} placeholder="H4sIAAAAAAAA…" disabled={busy} />
        </label>
        <div className="map-import-actions">
          <button type="button" onClick={() => { void runPreview() }} disabled={busy || !slab.trim()}>{busy && !preview ? 'Разбираем…' : 'Предпросмотр'}</button>
          {preview && <button type="button" className="primary" onClick={() => { void apply() }} disabled={busy}>{busy ? 'Применяем…' : `Применить к «${target?.name.replace(/ — текущая сцена$/u, '') ?? preview.location.name}»`}</button>}
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {done && <p className="map-import-done" role="status">{done}</p>}
        {preview && <>
          <p className="modal-note">{preview.location.current
            ? 'Это карта текущей сцены: после применения отряд встанет у входа, а остальные — на ближайшие свободные клетки. Во время боя карту заменить нельзя.'
            : 'Карта включится, когда отряд придёт в эту локацию. Прежние этажи локации заменятся.'}</p>
          <div className="map-import-levels" role="tablist" aria-label="Этажи карты">
            {preview.levels.map((entry) => <button key={entry.index} type="button" role="tab" aria-selected={entry.index === level?.index} className={entry.index === level?.index ? 'active' : ''} onClick={() => setLevelIndex(entry.index)}>{entry.label}</button>)}
          </div>
          {level && <div className="map-import-preview"><CombatLabBoard key={`${preview.location.id}:${level.index}`} map={revealedForPreview(level.map)} cells={[]} actors={[]} preview /></div>}
          <ul className="map-import-stats">
            {STAT_LABELS.filter(([key]) => (preview.stats[key] ?? 0) > 0).map(([key, label]) => <li key={key}><b>{preview.stats[key]}</b> {label}</li>)}
          </ul>
          {preview.warnings.length > 0 && <ul className="map-import-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        </>}
      </div>
    </div>
  )
}
