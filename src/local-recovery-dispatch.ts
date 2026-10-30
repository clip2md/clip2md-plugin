import { Notice, Platform, requestUrl } from 'obsidian';
import type BijiSyncPlugin from './main';
import { BUILD_CHANNEL } from './build-channel';
import { CLIP2MD_API_BASE_URL } from './config';
import { directories, replaceStaged } from './persistent-config';
import type { LocalRetryResult } from './companion-protocol';
const ROOT = '/sync/obsidian/local-recovery';
interface Job { id:string; task_id:number; instance_id:string; revision:string; source_url:string; lease_token:string; input_id?:string;run_no?:number; }
interface Draft { taskId:number; revision:string; key:string; result:LocalRetryResult; inputId?:string; submitted?:boolean; }
interface Readiness {ready:boolean;busy:boolean;reason:string;}
class DispatchError extends Error { constructor(readonly status:number, readonly code:string) { super(code); } }
/** Only the host owns authentication. The runtime receives source context, never cloud keys. */
export class LocalRecoveryDispatch {
    private timer:number|null=null;
    private stopped=false;
    private ticking=false;
    private running=false;
    private key='';
    private instance='';
    private active:Job|null=null;
    private epoch=0;
    constructor(private plugin:BijiSyncPlugin) {}
    async instanceId():Promise<string> { await this.tick();return this.instance; }
    start():void { this.stopped=false;this.wake(); }
    wake():void {
        if(this.stopped || this.ticking)return;
        if(this.timer!==null)window.clearTimeout(this.timer);
        this.timer=window.setTimeout(()=>{this.timer=null;void this.tick();},0);
    }
    stop():void {
        this.stopped=true;this.epoch++;
        if(this.timer!==null)window.clearTimeout(this.timer);
        this.plugin.companion?.snapshot()?.cancelLocalRetry?.();
        if(this.key)void this.offline(this.key);
    }
    private async offline(key:string):Promise<void> {
        try { await requestUrl({url:CLIP2MD_API_BASE_URL+ROOT+'/heartbeat',method:'POST',headers:{'X-API-Key':key,'Content-Type':'application/json'},body:JSON.stringify(this.payload({ready:false,busy:false,reason:'stopped'})),throw:false}); }
        catch { /* Expiration also handles exits without a network connection. */ }
    }
    private payload(state:Readiness):Record<string,unknown> {
        const runtime=this.plugin.companion?.snapshot();
        return {client_id:this.plugin.settings.installationId,main_version:this.plugin.manifest.version,desktop_version:runtime?.runtimeVersion||'',channel:BUILD_CHANNEL,
            protocol:runtime?.version||0,desktop:Platform.isDesktopApp===true,enabled:runtime?.enabled===true,verified:state.ready,busy:state.busy,reason:state.reason};
    }
    private async readiness():Promise<Readiness> {
        if(!Platform.isDesktopApp)return {ready:false,busy:false,reason:'mobile'};
        const runtime=this.plugin.companion?.snapshot();
        if(!runtime)return {ready:false,busy:false,reason:'desktop_missing'};
        if(!runtime.enabled)return {ready:false,busy:false,reason:'disabled'};
        if(runtime.version!==1||!runtime.getRecoveryReadiness||!runtime.cancelLocalRetry||!runtime.prepareLocalRetry)return {ready:false,busy:false,reason:'incompatible'};
        if(this.plugin.isUpdatePaused())return {ready:false,busy:false,reason:'updating'};
        return runtime.getRecoveryReadiness();
    }
    private valid(key:string,epoch:number):boolean { return !this.stopped&&this.epoch===epoch&&this.plugin.isLocalRetryCurrent(key); }
    private async request(route:string,key:string,epoch:number,body?:unknown,extra:Record<string,string>={}):Promise<Record<string,unknown>> {
        for(let attempt=0;attempt<3;attempt++) {
            if(!this.valid(key,epoch))throw new DispatchError(409,'binding_changed');
            if(route.startsWith('/tasks/') && (!this.active || !this.plugin.companion?.snapshot()?.enabled || this.plugin.isUpdatePaused()))throw new DispatchError(409,'lease_expired');
            try {
                const response=await requestUrl({url:CLIP2MD_API_BASE_URL+route,method:body===undefined?'GET':'POST',headers:{'X-API-Key':key,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),throw:false});
                if(!this.valid(key,epoch))throw new DispatchError(409,'binding_changed');
                if(response.status>=200&&response.status<300)return response.json as Record<string,unknown>;
                const detail=(response.json as {detail?:{code?:string}})?.detail;
                throw new DispatchError(response.status,response.headers?.['x-error-code'] || response.headers?.['X-Error-Code'] || (typeof detail==='object'&&detail?.code?detail.code:'request_failed'));
            } catch(error) {
                if(error instanceof DispatchError&&error.status<500)throw error;
                if(attempt===2)throw new DispatchError(503,'network');
                await new Promise(resolve=>window.setTimeout(resolve,(attempt+1)*1000));
            }
        }
        throw new DispatchError(503,'network');
    }
    private async tick():Promise<void> {
        if(this.stopped||this.ticking)return;
        this.ticking=true;
        try {
            const nextKey=this.plugin.settings.apiKey;
            if(this.key&&this.key!==nextKey){this.epoch++;this.plugin.companion?.snapshot()?.cancelLocalRetry?.();void this.offline(this.key);this.active=null;this.instance='';}
            this.key=nextKey;
            if(!nextKey)return;
            const epoch=this.epoch,state=await this.readiness();
            const current=this.active;
            const heartbeat=await this.request(ROOT+'/heartbeat',nextKey,epoch,{...this.payload(state),...(current?{job_id:current.id,lease_token:current.lease_token}:{})});
            this.instance=String(heartbeat.instance_id);
            if(current&&(!state.ready||heartbeat.lease_active===false)) {
                this.active=null;this.plugin.companion?.snapshot()?.cancelLocalRetry?.();
            }
            if(!state.ready||state.busy||this.running)return;
            const response=await this.request(ROOT+'/jobs/claim',nextKey,epoch,{instance_id:this.instance});
            const job=response.job as Job|undefined;
            if(job){this.active=job;this.running=true;void this.execute(job,nextKey,epoch).finally(()=>{this.running=false;if(this.active===job)this.active=null;this.wake();});}
        } catch { this.plugin.logger?.log('local_dispatch.heartbeat_failed',{},'warn'); }
        finally {this.ticking=false;if(!this.stopped)this.timer=window.setTimeout(()=>{this.timer=null;void this.tick();},30000);}
    }
    private async execute(job:Job,key:string,epoch:number):Promise<void> {
        const runtime=this.plugin.companion?.snapshot();
        const valid=()=>this.valid(key,epoch)&&this.active===job&&this.plugin.companion?.snapshot()?.enabled===true&&!this.plugin.isUpdatePaused();
        const check=()=>{if(!valid())throw new DispatchError(409,'lease_expired');};
        try {
            const scope=await this.plugin.companion?.bindingScope();check();
            if(!scope||!runtime?.prepareLocalRetry)throw new DispatchError(409,'desktop_unready');
            const folder=`${this.plugin.app.vault.configDir}/clip2md/recovery/${scope}`;
            await directories(this.plugin.app.vault.adapter,folder);
            const file=`${folder}/dispatch-${job.id}.json`;
            const stoppedFile=file+'.stopped';
            if(await this.plugin.app.vault.adapter.exists(stoppedFile)) {
                const stopped=JSON.parse(await this.plugin.app.vault.adapter.read(stoppedFile)) as {run:number;reason:string};
                if(stopped.run===(job.run_no||0))throw new DispatchError(422,stopped.reason);
            }
            let draft:Draft|undefined;
            if(await this.plugin.app.vault.adapter.exists(file))draft=JSON.parse(await this.plugin.app.vault.adapter.read(file)) as Draft;
            if(draft?.revision!==job.revision)draft=undefined;
            if(!draft) {
                draft={taskId:job.task_id,revision:job.revision,key:`dispatch:${job.id}:${job.revision}`,result:{sourceTitle:'',markdown:'',provenance:'',capturedAt:''}};
                await this.save(file,draft);
                const targetFolder=await this.plugin.getRecoveryTargetFolder(job.task_id);check();
                const result=await runtime.prepareLocalRetry({bindingScope:scope,taskId:job.task_id,sourceUrl:job.source_url,revision:job.revision,targetFolder});check();
                draft.result=result;
                await this.save(file,draft);
            }
            check();
            // Revalidate actual tools and lease immediately before the first upload.
            const state=await this.readiness();check();
            if(!state.ready)throw new DispatchError(409,'desktop_unready');
            if(!draft.inputId) {
                const uploaded=await this.request(`/tasks/${job.task_id}/local-retries`,key,epoch,{revision:job.revision,source_title:draft.result.sourceTitle,markdown:draft.result.markdown,provenance:draft.result.provenance,recovery_job_id:job.id,lease_token:job.lease_token},{'Idempotency-Key':draft.key});
                check();draft.inputId=String(uploaded.id);await this.save(file,draft);
            }
            // Existing submission monitor can recover even when commit's response is lost.
            const monitor=`${folder}/${job.task_id}.json`;
            if(await this.plugin.app.vault.adapter.exists(monitor+'.status.json'))await this.plugin.app.vault.adapter.remove(monitor+'.status.json');
            await this.save(monitor,draft);check();
            await this.request(`/tasks/${job.task_id}/local-retries/${draft.inputId}/commit`,key,epoch,{}, {'X-Local-Job-Token':job.lease_token});
            check();draft.submitted=true;await this.save(file,draft);await this.save(monitor,draft);
            this.plugin.logger?.log('local_dispatch.submitted',{taskId:job.task_id});
            new Notice(`任务 #${job.task_id} 本地解析完成，已提交云端生成智能笔记。`);
        } catch(error) {
            if(!valid())return;
            const reason=error instanceof Error&&error.message==='local_authorization_required'?'authorization_required':error instanceof DispatchError?(error.status===403?'quota':error.code==='refund_pending'?'refund_pending':error.code==='network'?'network':error.code==='local_failed'?'local_failed':error.code==='authorization_required'?'authorization_required':'task_changed'):'local_failed';
            try {
                const scope=await this.plugin.companion?.bindingScope();
                if(scope)await this.plugin.app.vault.adapter.write(`${this.plugin.app.vault.configDir}/clip2md/recovery/${scope}/dispatch-${job.id}.json.stopped`,JSON.stringify({run:job.run_no||0,reason}));
            } catch { /* The cloud report remains authoritative when local disk is unavailable. */ }
            try {await this.request(ROOT+`/jobs/${job.id}/state`,key,epoch,{instance_id:job.instance_id,lease_token:job.lease_token,status:reason==='authorization_required'?'WAITING_AUTH':'FAILED',reason});} catch { /* Server fencing or persisted input handles uncertain commit results. */ }
            this.plugin.logger?.log('local_dispatch.stopped',{taskId:job.task_id,code:reason},'warn');
            new Notice(`任务 #${job.task_id} 本地解析已暂停。${reason==='authorization_required'?'请在桌面扩展设置中完成原站授权后手动继续。':'请查看云端任务进度或在失败任务中重试；已获取的原文保留。'}`,10000);
        }
    }
    private async save(file:string,draft:Draft):Promise<void> {
        await this.plugin.app.vault.adapter.write(file+'.tmp',JSON.stringify(draft));
        await replaceStaged(this.plugin.app.vault.adapter,file+'.tmp',file);
    }
}
