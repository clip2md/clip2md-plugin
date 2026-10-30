import { beforeEach, describe, expect, it, vi } from 'vitest';
const request=vi.hoisted(()=>vi.fn());
vi.mock('obsidian',async()=>({...await vi.importActual<Record<string,unknown>>('obsidian'),requestUrl:request}));
import BijiSyncPlugin from './main';
import { SyncService } from './sync';
function fixture(targetFolder='主目录') {
    const p=Object.create(BijiSyncPlugin.prototype) as BijiSyncPlugin;
    p.settings=p['normalizeSettings']({apiKey:'test',targetFolder});
    p.syncService=new SyncService(p.settings);
    Object.assign(p,{app:{vault:{getFileByPath:(path:string)=>({path})}}});
    return p;
}
beforeEach(()=>request.mockReset());
describe('default material folder for recovery before a main note exists',()=>{
    it('uses the main destination or an existing moved note folder',async()=>{
        const p=fixture();
        expect(await p.getRecoveryTargetFolder(42)).toBe('主目录');
        p.syncService.loadTaskFileMap({42:'移动目录/正文.md'});
        expect(await p.getRecoveryTargetFolder(42)).toBe('移动目录');
        expect(request).not.toHaveBeenCalled();
    });
    it('resolves directory variables from actual task metadata',async()=>{
        const p=fixture('主目录/{{created_date}}/{{source_title}}');
        request.mockResolvedValue({status:200,json:{id:42,url:'https://example.com',created_at:'2026-10-24T01:00:00Z',source_title:'来源标题',source:'web',status:'FAILED'}});
        expect(await p.getRecoveryTargetFolder(42)).toBe('主目录/2026-10-24/来源标题');
    });
    it('discards metadata returned after an account switch',async()=>{
        const p=fixture('主目录/{{created_date}}');
        request.mockImplementation(async()=>{p.settings.apiKey='other';return {status:200,json:{id:42,url:'https://example.com',created_at:'2026-10-24T01:00:00Z'}};});
        await expect(p.getRecoveryTargetFolder(42)).rejects.toThrow('绑定已变化');
    });
});
