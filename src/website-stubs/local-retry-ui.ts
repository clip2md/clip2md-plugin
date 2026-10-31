import type BijiSyncPlugin from "../main";
/** Website distribution has no local recovery queue UI. */
export async function pollLocalRetries(_plugin: BijiSyncPlugin): Promise<void> {}
export async function openLocalRetries(_plugin: BijiSyncPlugin): Promise<void> {}
