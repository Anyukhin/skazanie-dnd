import { createRoot } from 'react-dom/client'
import { MapProp } from './MapProp'
import type { MapCell } from './types'
import './styles.css'

type PreviewCell = Pick<MapCell, 'x' | 'y' | 'type' | 'material' | 'feature' | 'variant' | 'pattern'>

const key = (x: number, y: number) => `${x},${y}`

function room(): PreviewCell[] {
  const props = new Map<string, MapCell['feature']>([
    [key(1, 1), 'bed'], [key(4, 2), 'table'], [key(3, 2), 'chair'], [key(5, 2), 'chair'],
    [key(7, 1), 'fireplace'], [key(1, 5), 'bookshelf'], [key(7, 5), 'chest'], [key(6, 5), 'barrel'],
  ])
  return Array.from({ length: 7 }, (_, y) => Array.from({ length: 9 }, (_, x): PreviewCell => ({
    x, y, type: x === 0 || y === 0 || x === 8 || y === 6 ? 'wall' : 'floor', material: 'wood',
    feature: props.get(key(x, y)), variant: (x * 3 + y * 5) % 6, pattern: 'small-room',
  }))).flat()
}

function cave(): PreviewCell[] {
  const shape = ['.....####....', '..########...', '.###########.', '############.', '.###########.', '..##########.', '...########..', '....#####....']
  const props = new Map<string, MapCell['feature']>([
    [key(3, 2), 'rock'], [key(9, 2), 'mushroom'], [key(7, 4), 'campfire'], [key(10, 5), 'bones'],
    [key(5, 6), 'rune'], [key(9, 6), 'chest'],
  ])
  const cells: PreviewCell[] = []
  shape.forEach((row, y) => [...row].forEach((char, x) => {
    if (char !== '#') return
    const edge = !shape[y - 1]?.[x]?.includes('#') || !shape[y + 1]?.[x]?.includes('#') || row[x - 1] !== '#' || row[x + 1] !== '#'
    cells.push({ x, y, type: edge ? 'wall' : 'floor', material: 'earth', feature: edge ? undefined : props.get(key(x, y)), variant: (x + y * 2) % 6, pattern: 'cave-cluster' })
  }))
  return cells
}

function forest(): PreviewCell[] {
  const props = new Map<string, MapCell['feature']>([
    [key(2, 1), 'tree'], [key(11, 1), 'tree'], [key(4, 5), 'bush'], [key(10, 6), 'bush'],
    [key(7, 1), 'rock'], [key(9, 5), 'campfire'], [key(12, 5), 'chest'],
  ])
  return Array.from({ length: 8 }, (_, y) => Array.from({ length: 14 }, (_, x): PreviewCell => {
    const trailY = 4 + Math.round(Math.sin((x / 13) * Math.PI * 2) * 1.4)
    const isTrail = Math.abs(y - trailY) <= (x > 7 ? 1 : 0)
    return { x, y, type: 'floor', material: isTrail ? 'earth' : 'grass', feature: props.get(key(x, y)), variant: (x * 2 + y * 3) % 6, pattern: 'natural' }
  })).flat()
}

function Board({ title, subtitle, theme, width, height, cells }: { title: string; subtitle: string; theme: string; width: number; height: number; cells: PreviewCell[] }) {
  const byPosition = new Map(cells.map((cell) => [key(cell.x, cell.y), cell]))
  return <section className="preview-card">
    <header><h2>{title}</h2><p>{subtitle}</p></header>
    <div className="preview-board">
      <div className={`map-stage ${theme}`}>
        <div className={`map-grid ${cells.length < width * height ? 'irregular' : ''}`} style={{ gridTemplateColumns: `repeat(${width}, var(--cell))` }}>
          {Array.from({ length: width * height }, (_, index) => {
            const x = index % width
            const y = Math.floor(index / width)
            const cell = byPosition.get(key(x, y))
            if (!cell) return <span key={key(x, y)} />
            return <span key={key(x, y)} className={`map-cell ${cell.type} revealed material-${cell.material} pattern-${cell.pattern} variant-${cell.variant} parity-${(x + y) % 2 ? 'odd' : 'even'}`}>
              {cell.feature && <span className={`feature ${cell.feature}`}><MapProp feature={cell.feature} /></span>}
            </span>
          })}
        </div>
      </div>
    </div>
  </section>
}

function Preview() {
  return <main className="preview-page">
    <div className="preview-intro"><span>Визуальный тест</span><h1>Рисованные D&amp;D-локации</h1><p>Один набор правил, но разные материалы, силуэты и логичный реквизит для каждой сцены.</p></div>
    <Board title="Жилой дом" subtitle="Доски, кровать, стол, стулья и очаг" theme="map-theme-interior" width={9} height={7} cells={room()} />
    <Board title="Подземная пещера" subtitle="Неровный силуэт, скалы, грибы, кости и костёр" theme="map-theme-cave" width={13} height={8} cells={cave()} />
    <Board title="Лесная тропа" subtitle="Смешение травы и грунта, деревья и кустарник" theme="map-theme-wild" width={14} height={8} cells={forest()} />
  </main>
}

createRoot(document.getElementById('root')!).render(<Preview />)
