import type { CombatAnimationCue } from './combat-animation'

export type Board3DQuality = 'high' | 'balanced' | 'low'

/** Профили меняют только отрисовку, никогда не игровые данные. */
export const BOARD3D_QUALITY = {
  high: { label: 'Высокое', maxDpr: 2, shadows: true, shadowSize: 2048, pointLightShadows: true, idle: true, detail: 'full' },
  balanced: { label: 'Обычное', maxDpr: 1.5, shadows: true, shadowSize: 1024, pointLightShadows: false, idle: true, detail: 'reduced' },
  low: { label: 'Экономное', maxDpr: 1, shadows: false, shadowSize: 512, pointLightShadows: false, idle: false, detail: 'minimal' },
} as const

export function board3DQuality(value: unknown): Board3DQuality {
  return value === 'high' || value === 'low' ? value : 'balanced'
}

export function cueForQuality(cue: CombatAnimationCue, quality: Board3DQuality): CombatAnimationCue {
  const order = { full: 0, reduced: 1, minimal: 2 }
  const detail = BOARD3D_QUALITY[quality].detail
  return { ...cue, detail: cue.detail && order[cue.detail] > order[detail] ? cue.detail : detail }
}
