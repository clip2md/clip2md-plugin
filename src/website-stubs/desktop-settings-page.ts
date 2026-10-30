import type BijiSyncPlugin from "../main";
/** Website distribution has no local clipping settings UI. */
export const DESKTOP_ENABLED_KEY = "clip2md-desktop-enabled-v1";
export async function setDesktopEnabled(_plugin: BijiSyncPlugin, _enabled: boolean): Promise<boolean> { return false; }
export class DesktopSettingsPage {
  constructor(_plugin: BijiSyncPlugin) {}
  display(): void {}
  hide(): void {}
}
