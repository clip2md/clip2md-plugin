/** Website distribution no longer bundles the integrated desktop runtime. */
export interface IntegratedDesktopRuntime { unload(): void; }
export async function startIntegratedDesktop(): Promise<null> { return null; }
