// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {LocalRecoveryDispatch} from './local-recovery-dispatch';
import type BijiSyncPlugin from './main';
const api=vi.hoisted(()=>({request:vi.fn(),notice:vi.fn()}));
vi.mock('obsidian',()=>({Platform:{isDesktopApp:true},Notice:class{constructor(message:string){api.notice(message);}},requestUrl:api.request}));
const scope='a'.repeat(64);
function fixture() {
    const files=new Map<string,string>(),calls:Array<{route:string;body:Record<string,unknown>}> = [];
    const job={id:'job-one',task_id:12,instance_id:'instance-one',revision:'b'.repeat(64),source_url:'https://example.test/post',lease_token:'token'};
    let available=true,renew=true,committed=false,commitCalls=0;
    const runtime={enabled:true,runtimeVersion:'0.1.0',version:1,getRecoveryReadiness:vi.fn(async()=>({ready:true,busy:false,reason:'ready'})),cancelLocalRetry:vi.fn(),prepareLocalRetry:vi.fn(async()=>({sourceTitle:'Source title',markdown:'Original source',provenance:'source-page',capturedAt:'2026-10-23T00:00:00Z'}))};
    const plugin={settings:{apiKey:'test-key',installationId:'vault-device'},manifest:{version:'1.0.22'},isLocalRetryCurrent:(key:string)=>plugin.settings.apiKey===key,isUpdatePaused:()=>false,logger:{log:vi.fn()},companion:{snapshot:()=>runtime,bindingScope:async()=>scope},app:{vault:{configDir:'.obsidian',adapter:{exists:async(p:string)=>files.has(p),mkdir:async(p:string)=>{files.set(p,'');},read:async(p:string)=>files.get(p)!,write:async(p:string,v:string)=>{files.set(p,v);},rename:async(a:string,b:string)=>{files.set(b,files.get(a)!);files.delete(a);},remove:async(p:string)=>{files.delete(p);}}}}};
    api.request.mockImplementation(async(options:{url:string;body?:string})=>{
        const route=options.url.replace(/^.*\/api\/v1/,'');
        const body=JSON.parse(options.body||'{}') as Record<string,unknown>;calls.push({route,body});
        if(route.endsWith('/heartbeat'))return {status:200,json:{instance_id:'instance-one',lease_active:renew}};
        if(route.endsWith('/jobs/claim')){const value=available?job:null;available=false;return {status:200,json:{job:value}};}
        if(route.endsWith('/local-retries'))return {status:200,json:{id:'input-one'}};
        if(route.endsWith('/commit')){commitCalls++;committed=true;return {status:200,json:{}};}
        return {status:200,json:{}};
    });
    Object.assign(plugin,{getRecoveryTargetFolder:vi.fn(async()=> '主剪藏目录')});
    const dispatch=new LocalRecoveryDispatch(plugin as unknown as BijiSyncPlugin);
    const tick=()=>dispatch.instanceId();
    const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
    return {plugin,runtime,files,calls,dispatch,tick,flush,job,get committed(){return committed;},get commitCalls(){return commitCalls;},renew:(value:boolean)=>{renew=value;}};
}
beforeEach(()=>{vi.useFakeTimers();api.request.mockReset();api.notice.mockReset();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('credential-owned local recovery executor',()=>{
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
