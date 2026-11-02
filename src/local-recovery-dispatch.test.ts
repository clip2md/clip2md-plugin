// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {LocalRecoveryDispatch} from './local-recovery-dispatch';
import type BijiSyncPlugin from './main';
const api=vi.hoisted(()=>({request:vi.fn(),notice:vi.fn()}));
vi.mock('obsidian',()=>({Platform:{isDesktopApp:true},Notice:class{constructor(message:string){api.notice(message);}},requestUrl:api.request}));
const scope='a'.repeat(64);
function fixture() {
    const files=new Map<string,string>(),calls:Array<{route:string;body:Record<string,unknown>}> = [];
    const readBinary=vi.fn(async()=>new Uint8Array([137,80,78,71]).buffer);
    const job={id:'job-one',task_id:12,instance_id:'instance-one',revision:'b'.repeat(64),source_url:'https://example.test/post',lease_token:'token'};
    let available=true,renew=true,committed=false,commitCalls=0;
    const runtime={enabled:true,runtimeVersion:'0.1.0',version:1,getRecoveryReadiness:vi.fn(async()=>({ready:true,busy:false,reason:'ready'})),cancelLocalRetry:vi.fn(),prepareLocalRetry:vi.fn(async()=>({sourceTitle:'Source title',markdown:'Original source',provenance:'source-page',capturedAt:'2026-10-23T00:00:00Z'}))};
    const plugin={settings:{apiKey:'test-key',installationId:'vault-device'},manifest:{version:'1.0.22'},isLocalRetryCurrent:(key:string)=>plugin.settings.apiKey===key,isUpdatePaused:()=>false,logger:{log:vi.fn()},companion:{snapshot:()=>runtime,bindingScope:async()=>scope},app:{vault:{configDir:'.obsidian',adapter:{exists:async(p:string)=>files.has(p),mkdir:async(p:string)=>{files.set(p,'');},read:async(p:string)=>files.get(p)!,write:async(p:string,v:string)=>{files.set(p,v);},rename:async(a:string,b:string)=>{files.set(b,files.get(a)!);files.delete(a);},remove:async(p:string)=>{files.delete(p);}}}}};
    api.request.mockImplementation(async(options:{url:string;body?:string|ArrayBuffer;headers:Record<string,string>})=>{
        const route=options.url.replace(/^.*\/api\/v1/,'');
        const body=options.body instanceof ArrayBuffer?{reference:decodeURIComponent(options.headers['X-Local-Image-Reference']),bytes:[...new Uint8Array(options.body)]}:JSON.parse(options.body||'{}') as Record<string,unknown>;calls.push({route,body});
        if(route.endsWith('/heartbeat'))return {status:200,json:{instance_id:'instance-one',lease_active:renew}};
        if(route.endsWith('/jobs/claim')){const value=available?job:null;available=false;return {status:200,json:{job:value}};}
        if(route.endsWith('/local-retries'))return {status:200,json:{id:'input-one'}};
        if(route.endsWith('/commit')){commitCalls++;committed=true;return {status:200,json:{}};}
        return {status:200,json:{}};
    });
    Object.assign(plugin.app.vault.adapter,{readBinary});
    Object.assign(plugin,{getRecoveryTargetFolder:vi.fn(async()=> '主剪藏目录')});
    const dispatch=new LocalRecoveryDispatch(plugin as unknown as BijiSyncPlugin);
    const tick=()=>dispatch.instanceId();
    const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
    return {plugin,runtime,files,calls,readBinary,dispatch,tick,flush,job,get committed(){return committed;},get commitCalls(){return commitCalls;},renew:(value:boolean)=>{renew=value;}};
}
beforeEach(()=>{vi.useFakeTimers();api.request.mockReset();api.notice.mockReset();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('credential-owned local recovery executor',()=>{
    it('uploads task-owned local image bytes once per reference before committing cloud generation',async()=>{
        const f=fixture(),reference='/Notes/_local/12/one.png';
        f.runtime.prepareLocalRetry.mockResolvedValue({sourceTitle:'商品',markdown:`原文\n![](${reference})\n![重复](${reference})\n![](https://img.example.com/external.jpg)`,provenance:'authenticated-taobao-page',capturedAt:''});
        await f.tick();await f.flush();
        expect(f.readBinary).toHaveBeenCalledOnce();expect(f.readBinary).toHaveBeenCalledWith('Notes/_local/12/one.png');
        const index=f.calls.findIndex(c=>c.route.endsWith('/images'));
        expect(f.calls[index].body).toEqual({reference,bytes:[137,80,78,71]});
        expect(index).toBeLessThan(f.calls.findIndex(c=>c.route.endsWith('/commit')));
        expect(f.committed).toBe(true);f.dispatch.stop();
    });
    it.each(['/Notes/_local/99/image.png','/.obsidian/_local/12/image.png','/Notes/_local/12/%2e%2e/secret.png'])('rejects an unowned or unsafe image path before reading pixels: %s',async reference=>{
        const f=fixture();f.runtime.prepareLocalRetry.mockResolvedValue({sourceTitle:'商品',markdown:`原文\n![](${reference})`,provenance:'source-page',capturedAt:''});
        await f.tick();await f.flush();
        expect(f.readBinary).not.toHaveBeenCalled();expect(f.committed).toBe(false);f.dispatch.stop();
    });
    it('keeps image upload failures uncommitted and preserves the source draft for a later retry',async()=>{
        const f=fixture();f.runtime.prepareLocalRetry.mockResolvedValue({sourceTitle:'商品',markdown:'原文\n![](/Notes/_local/12/missing.png)',provenance:'source-page',capturedAt:''});
        f.readBinary.mockRejectedValue(new Error('file missing'));
        await f.tick();await f.flush();
        expect(f.committed).toBe(false);
        expect(JSON.parse(f.files.get(`.obsidian/clip2md/recovery/${scope}/dispatch-${f.job.id}.json`)!).inputId).toBe('input-one');
        expect(f.plugin.logger.log).toHaveBeenCalledWith('local_dispatch.stopped',expect.objectContaining({stage:'images'}),'warn');
        f.dispatch.stop();
    });
    it('recollects an unfinished draft after a resumed parsing failure instead of uploading its empty placeholder',async()=>{
        const f=fixture();
        f.files.set(`.obsidian/clip2md/recovery/${scope}/dispatch-${f.job.id}.json`,JSON.stringify({taskId:12,revision:f.job.revision,key:'old',result:{sourceTitle:'',markdown:'',provenance:'',capturedAt:''}}));
        await f.tick();await f.flush();
        expect(f.runtime.prepareLocalRetry).toHaveBeenCalledOnce();
        expect(f.calls.find(c=>c.route.endsWith('/local-retries'))?.body.markdown).toBe('Original source');
        expect(f.committed).toBe(true);f.dispatch.stop();
    });
    it('uploads a persisted source once, commits with fencing, and writes the existing sync monitor',async()=>{
        const f=fixture();await f.tick();await f.flush();
        expect(f.committed).toBe(true);
        expect(f.runtime.prepareLocalRetry).toHaveBeenCalledOnce();
        const saved=JSON.parse(f.files.get(`.obsidian/clip2md/recovery/${scope}/12.json`)!);
        expect(saved.submitted).toBe(true);expect(saved.result.markdown).toBe('Original source');
        expect(f.calls.find(c=>c.route.endsWith('/local-retries'))?.body.recovery_job_id).toBe('job-one');
        f.dispatch.stop();
    });
    it('reports a disabled instance without claiming work',async()=>{
        const f=fixture();f.runtime.enabled=false;await f.tick();await f.flush();
        expect(f.calls[0].body.reason).toBe('disabled');
        expect(f.calls.some(c=>c.route.endsWith('/jobs/claim'))).toBe(false);f.dispatch.stop();
    });
    it('aborts and never uploads when the lease is revoked during parsing',async()=>{
        const f=fixture();let finish!:(value:Awaited<ReturnType<typeof f.runtime.prepareLocalRetry>>)=>void;
        f.runtime.prepareLocalRetry.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
        await f.tick();await f.flush();f.renew(false);await f.tick();
        finish({sourceTitle:'Source',markdown:'Original',provenance:'source',capturedAt:''});await f.flush();
        expect(f.runtime.cancelLocalRetry).toHaveBeenCalled();expect(f.committed).toBe(false);
        expect(f.calls.some(c=>c.route.endsWith('/local-retries'))).toBe(false);f.dispatch.stop();
    });
    it('does not apply parsing results after an account switch',async()=>{
        const f=fixture();let finish!:(value:Awaited<ReturnType<typeof f.runtime.prepareLocalRetry>>)=>void;
        f.runtime.prepareLocalRetry.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
        await f.tick();await f.flush();f.plugin.settings.apiKey='other-account';await f.tick();
        finish({sourceTitle:'Source',markdown:'Original',provenance:'source',capturedAt:''});await f.flush();
        expect(f.committed).toBe(false);expect(f.runtime.cancelLocalRetry).toHaveBeenCalled();f.dispatch.stop();
    });
    it('pauses authorization failures without uploading or billing',async()=>{
        const f=fixture();f.runtime.prepareLocalRetry.mockRejectedValue(new Error('local_authorization_required'));
        await f.tick();await f.flush();
        expect(f.calls.find(c=>c.route.endsWith('/state'))?.body).toMatchObject({status:'WAITING_AUTH',reason:'authorization_required'});
        expect(f.committed).toBe(false);f.dispatch.stop();
    });
});
