export type AtmosphereScreen = 'hero-forge' | 'world-forge' | 'lobby' | 'play'

export const ATMOSPHERE_SCREENS: readonly AtmosphereScreen[]

export function atmosphereScreenFor(flags?: {
  authenticated?: boolean
  campaignListOpen?: boolean
  worldWizardOpen?: boolean
  heroWizardOpen?: boolean
}): AtmosphereScreen

export function atmosphereScreenAttenuation(screen: string): number
