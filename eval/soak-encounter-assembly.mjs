import { setTimeout as sleep } from 'node:timers/promises'

// Скользящее окно rust/crates/sk-server/src/rate_window.rs. Отказ тоже
// занимает место в окне, поэтому повторяем один раз после полного окна.
const ASSEMBLY_RATE_WINDOW_MS = 10 * 60 * 1000

export async function assembleWithRateLimitPause(post, path, options, pause = sleep) {
  const result = await post(path, options)
  if (result.status !== 429 || result.body?.code !== 'ENCOUNTER_ASSEMBLY_RATE_LIMITED') return result
  await pause(ASSEMBLY_RATE_WINDOW_MS)
  return post(path, options)
}
