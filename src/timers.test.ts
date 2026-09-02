import { afterEach, describe, expect, it } from 'vitest';
import { TimerRegistry } from './timers';

describe('TimerRegistry', () => {
    afterEach(() => {
        delete (globalThis as { window?: unknown }).window;
    });

    it('clears timers by purpose and clears all remaining timers', () => {
        (globalThis as { window?: unknown }).window = globalThis;
        const registry = new TimerRegistry();
        registry.setTimeout(() => undefined, 60_000, 'binding');
        registry.setInterval(() => undefined, 60_000, 'network');
        registry.setTimeout(() => undefined, 60_000, 'notice');
        expect(registry.size).toBe(3);
        registry.clearGroup('binding');
        expect(registry.size).toBe(2);
        registry.clearAll();
        expect(registry.size).toBe(0);
    });
});
