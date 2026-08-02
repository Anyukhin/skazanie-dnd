export type AtmosphereScreen = 'hero-forge' | 'world-forge' | 'lobby' | 'play'

export const ATMOSPHERE_SCREENS: readonly AtmosphereScreen[]

export function atmosphereScreenFor(flags?: {
  authenticated?: boolean
  campaignListOpen?: boolean
  worldWizardOpen?: boolean
  heroWizardOpen?: boolean
}): AtmosphereScreen

export function atmosphereScreenAttenuation(screen: string): number

export const SCREEN_MUSIC_TRACKS: Readonly<Record<string, string>>

export function screenMusicTrack(screen: string): string | null

export function screenMusicVolume(screen: string): number
