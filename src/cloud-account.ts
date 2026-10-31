import { requestUrl } from 'obsidian';
import { CLIP2MD_API_BASE_URL } from './config';
interface Identity { nickname:string|null;publicId:string; }
type State='unbound'|'loading'|'ready'|'expired'|'unavailable';
/** Shared, credential-scoped account display. Never persisted or passed a cloud key to companions. */
export class CloudAccountDisplay {
    private key='';
    private allowed=true;
    private epoch=0;
    private identity:Identity|null=null;
    private state:State='unbound';
    private pending?:Promise<void>;
    private rows=new Set<HTMLElement>();
    private stopped=false;
    private lastRequested=0;
    constructor(private credential:()=>string,private valid:()=>boolean) {}
    changed():void {
        if(this.check() && this.rows.size)void this.refresh();
    }
    private check():boolean {
        const key=this.credential(),allowed=this.valid();
        if(key===this.key && allowed===this.allowed)return false;
        this.key=key;this.allowed=allowed;this.epoch++;this.pending=undefined;this.identity=null;this.lastRequested=0;
        this.state=!key?'unbound':allowed?'loading':'expired';this.publish();return true;
    }
    render(container:HTMLElement):()=>void {
        this.check();
        const row=container.createEl('p',{cls:'clip2md-cloud-account',attr:{role:'status','aria-live':'polite'}});
        this.rows.add(row);this.publish();void this.refresh(false);
        return ()=>{this.rows.delete(row);row.remove();};
    }
    async refresh(force=true):Promise<void> {
        this.check();
        if(this.stopped||!this.key||!this.allowed)return;
        if(this.pending)return this.pending;
        if(!force&&this.lastRequested&&Date.now()-this.lastRequested<60000)return;
        this.lastRequested=Date.now();
        const key=this.key,epoch=this.epoch;
        this.state='loading';this.publish();
        const operation=(async()=>{
            try {
                const response=await requestUrl({url:CLIP2MD_API_BASE_URL+'/auth/me',headers:{'X-API-Key':key},throw:false});
                if(this.stopped||epoch!==this.epoch||this.credential()!==key||!this.valid())return;
                if(response.status===401){this.identity=null;this.state='expired';return;}
                const value:unknown=response.json;
                if(response.status!==200||!value||typeof value!=='object')throw new Error('unavailable');
                const data=value as Record<string,unknown>;
                if(typeof data.public_id!=='string'||!data.public_id.trim()||data.public_id.length>100 || (data.nickname!==null&&data.nickname!==undefined&&typeof data.nickname!=='string'))throw new Error('unavailable');
                const name=typeof data.nickname==='string'?data.nickname.trim().slice(0,100):'';
                this.identity={nickname:name||null,publicId:data.public_id};this.state='ready';
            }catch{if(epoch===this.epoch&&!this.stopped){this.identity=null;this.state='unavailable';}}
            finally{if(epoch===this.epoch&&!this.stopped)this.publish();}
        })();
        this.pending=operation;await operation;
        if(this.pending===operation)this.pending=undefined;
    }
    private publish():void {
        const identity=this.identity;
        const text=this.state==='ready'&&identity
            ? `当前账号：${identity.nickname||'未设置昵称'} · ${identity.publicId}`
            :this.state==='unbound'?'当前账号：未绑定'
            :this.state==='expired'?'登录已失效，请重新绑定'
            :this.state==='loading'?'正在获取账号信息…'
            :'账号信息暂不可用，请测试连接';
        for(const row of this.rows){
            row.replaceChildren();
            if(this.state==='ready'&&identity){
                row.createSpan({ text: identity.nickname || '未设置昵称', cls: 'clip2md-account-name' });
                row.createSpan({ text: identity.publicId, cls: 'clip2md-account-id', attr: { 'aria-label': '账号 ID' } });
            }else row.textContent=text;
        }
    }
    dispose():void {this.stopped=true;this.epoch++;this.identity=null;this.pending=undefined;for(const row of this.rows)row.textContent='主插件已停用';this.rows.clear();}
}
