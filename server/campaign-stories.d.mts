export type CampaignMode = 'adventure' | 'persistent'
export type CampaignStory = {
  schema_version: 1 | 2
  story_id: string
  story_number: number
  quest_id: string
  title: string
  outcome: 'success' | 'failure' | 'abandoned'
  summary: string
  location_id: string
  location: string
  elapsed_minutes: number
  concluded_at?: string | null
}
export const CAMPAIGN_MODES: readonly CampaignMode[]
export const PERSISTENT_WORLD_OBJECTIVE: string
export function validateCampaignMode(value?: unknown): CampaignMode
export function campaignModeFor(state?: { campaignConcept?: { campaign_mode?: CampaignMode } }): CampaignMode
export function persistentStoryQuest(state?: Record<string, any>): Record<string, any> | null
export function campaignStoryCompletionDraft(state: Record<string, any>, events: Array<Record<string, any>>): {
  event_type: 'CampaignStoryCompleted'; visibility: 'party'; target_ids: string[]; payload: CampaignStory
} | null
export function campaignStoryChronicleEntry(event: Record<string, any>): {
  id: string; speaker: 'narrator'; author: string; text: string; turnConsumed: false
} | null
