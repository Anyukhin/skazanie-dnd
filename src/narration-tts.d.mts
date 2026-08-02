export type NarrationVoiceMode = 'off' | 'button' | 'auto'

export const NARRATION_VOICE_MODES: readonly NarrationVoiceMode[]

export interface NarrationVoiceLike {
  name?: string
  lang?: string
  localService?: boolean
  default?: boolean
}

export function speakableNarration(value: unknown, maximum?: number): string

export function narrationSpeechChunks(value: unknown, limit?: number): string[]

export function pickNarrationVoice<T extends NarrationVoiceLike>(
  voices: T[],
  preferredName?: string,
): T | null

export function normalizeVoiceMode(value: unknown): NarrationVoiceMode

export function shouldAutoSpeak(
  message: { speaker?: string; text?: string; streaming?: boolean },
  mode: NarrationVoiceMode,
): boolean
