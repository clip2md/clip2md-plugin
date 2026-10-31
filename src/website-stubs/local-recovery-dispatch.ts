/** Website distribution has no local recovery dispatcher. */
export class LocalRecoveryDispatch {
  start(): void {}
  stop(): void {}
  wake(): void {}
  async instanceId(): Promise<string> { return ""; }
}
