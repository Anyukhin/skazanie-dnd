import type { CombatAnimationCue } from './combat-animation'

export type Board3DQuality = 'high' | 'balanced' | 'low'

/**
 * Профили меняют только отрисовку, никогда не игровые данные.
 * `ambientOcclusion` — мягкое затенение в углах (дорогое, только «Высокое»);
 * `bloom` — свечение огня и заклинаний на половинном разрешении.
 */
export const BOARD3D_QUALITY = {
  high: { label: 'Высокое', maxDpr: 2, shadows: true, shadowSize: 4096, pointLightShadows: true, idle: true, detail: 'full', ambientOcclusion: true, bloom: true },
  balanced: { label: 'Обычное', maxDpr: 1.5, shadows: true, shadowSize: 2048, pointLightShadows: false, idle: true, detail: 'reduced', ambientOcclusion: false, bloom: true },
  low: { label: 'Экономное', maxDpr: 1, shadows: false, shadowSize: 512, pointLightShadows: false, idle: false, detail: 'minimal', ambientOcclusion: false, bloom: false },
} as const

export function board3DQuality(value: unknown): Board3DQuality {
  return value === 'high' || value === 'low' ? value : 'balanced'
}

export function cueForQuality(cue: CombatAnimationCue, quality: Board3DQuality): CombatAnimationCue {
  const order = { full: 0, reduced: 1, minimal: 2 }
  const detail = BOARD3D_QUALITY[quality].detail
  return { ...cue, detail: cue.detail && order[cue.detail] > order[detail] ? cue.detail : detail }
}
