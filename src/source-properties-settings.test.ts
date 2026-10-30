import { describe, expect, it, vi } from 'vitest';
import BijiSyncPlugin from './main';
import { NEW_DEFAULT_FRONTMATTER_TEMPLATE } from './settings';
describe('source property template initialization',()=>{
    it('adds fields once and preserves subsequent template edits across repeated enable requests',async()=>{
        const plugin=new BijiSyncPlugin();
        Object.assign(plugin,{settings:{frontmatterTemplate:NEW_DEFAULT_FRONTMATTER_TEMPLATE},saveSettings:vi.fn(async()=>{})});
        await plugin.enableSourcePropertiesTemplate();
        expect(plugin.settings.frontmatterTemplate).toContain('{{local_author}}');
        plugin.settings.frontmatterTemplate=plugin.settings.frontmatterTemplate.replace('"作者": {{local_author}}','"我的作者": {{local_author}}');
        const edited=plugin.settings.frontmatterTemplate;
        await plugin.enableSourcePropertiesTemplate();
        expect(plugin.settings.frontmatterTemplate).toBe(edited);expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });
    it('rolls back the template and initialization flag if saving fails',async()=>{
        const plugin=new BijiSyncPlugin();
        Object.assign(plugin,{settings:{frontmatterTemplate:NEW_DEFAULT_FRONTMATTER_TEMPLATE},saveSettings:vi.fn(async()=>{throw new Error('disk full');})});
        await expect(plugin.enableSourcePropertiesTemplate()).rejects.toThrow('disk full');
        expect(plugin.settings.frontmatterTemplate).toBe(NEW_DEFAULT_FRONTMATTER_TEMPLATE);expect(plugin.settings.sourcePropertiesTemplateInitialized).toBe(false);
    });
});
