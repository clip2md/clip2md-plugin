import { describe, expect, it } from 'vitest';
import { dependencyState, pluginStoreUrl } from './plugin-dependency';

describe('dependency installation and handshake states', () => {
    it('does not mistake installed but not connected for missing', () => {
        expect(dependencyState(true, false, true, false)).toBe('waiting');
        expect(dependencyState(false, false, true, false)).toBe('missing');
        expect(dependencyState(null, false, true, false)).toBe('unknown');
    });
    it('uses the live handshake over stale disk detection', () => {
        expect(dependencyState(false, true, true, false)).toBe('unbound');
        expect(dependencyState(null, true, true, true)).toBe('ready');
        expect(dependencyState(true, true, false, true)).toBe('incompatible');
    });
    it('opens the correct official installation page in both directions', () => {
        expect(pluginStoreUrl('clipmd')).toBe('obsidian://show-plugin?id=clipmd');
        expect(pluginStoreUrl('clipmd-desktop-tools')).toBe('obsidian://show-plugin?id=clipmd-desktop-tools');
    });
});
