/** Website distribution has no companion host or local clipping bridge. */
export class CompanionHost {
  enabled(): boolean { return false; }
  connected(): boolean { return false; }
  snapshot(): null { return null; }
  diagnosticTools(): Record<string, string> { return {}; }
  async prepareUpdate(): Promise<void> {}
  resumeAfterUpdate(): void {}
  async taskSaved(_task: unknown, _path: string): Promise<void> {}
  stop(): void {}
}
