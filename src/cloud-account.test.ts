// @vitest-environment jsdom
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {CloudAccountDisplay} from './cloud-account';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('obsidian',()=>({requestUrl:request}));
beforeAll(()=>{Object.assign(HTMLElement.prototype,{
 createEl(this:HTMLElement,tag:string,options:{cls?:string;attr?:Record<string,string>;text?:string}={}){const element=document.createElement(tag);element.className=options.cls||'';element.textContent=options.text||'';for(const [key,value]of Object.entries(options.attr||{}))element.setAttribute(key,value);this.appendChild(element);return element;},
 createSpan(this:HTMLElement,options:{cls?:string;attr?:Record<string,string>;text?:string}={}){return this.createEl('span',options);},
});});
beforeEach(()=>{request.mockReset();vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();document.body.replaceChildren();});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){let key='current-key',valid=true;const display=new CloudAccountDisplay(()=>key,()=>valid);const root=document.createElement('div');document.body.appendChild(root);return{display,root,key:(v:string)=>{key=v;display.changed();},valid:(v:boolean)=>{valid=v;display.changed();}};}
describe('shared Clip2MD account nickname',()=>{
 it('shows the authenticated nickname and public account ID on all three pages using one request',async()=>{
  request.mockResolvedValue({status:200,json:{public_id:'clip-account',nickname:'当前登录昵称',api_key:'must-not-display'}});
  const f=fixture();f.display.render(f.root);f.display.render(f.root);f.display.render(f.root);await flush();
  expect(request).toHaveBeenCalledOnce();expect(f.root.querySelectorAll('.clip2md-cloud-account')).toHaveLength(3);
  for(const row of f.root.children)expect(row.textContent).toBe('当前登录昵称clip-account');
  expect(f.root.textContent).not.toContain('must-not-display');f.display.dispose();
 });
 it('does not invent a nickname from the device credential or account ID',async()=>{
  request.mockResolvedValue({status:200,json:{public_id:'clip-account',nickname:null}});const f=fixture();f.display.render(f.root);await flush();
  expect(f.root.textContent).toContain('未设置昵称');expect(f.root.textContent).toContain('clip-account');f.display.dispose();
 });
 it('drops old account responses immediately on credential change',async()=>{
  let finish!:(value:unknown)=>void;request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  request.mockResolvedValue({status:200,json:{public_id:'new-account',nickname:'新账号'}});
  const f=fixture();f.display.render(f.root);f.key('new-key');await flush();
  finish({status:200,json:{public_id:'old-account',nickname:'旧账号'}});await flush();
  expect(f.root.textContent).toContain('新账号');expect(f.root.textContent).not.toContain('旧账号');f.display.dispose();
 });
 it('clears the nickname on unbinding or invalid authorization',async()=>{
  request.mockResolvedValue({status:200,json:{public_id:'clip-account',nickname:'旧昵称'}});const f=fixture();f.display.render(f.root);await flush();
  f.valid(false);expect(f.root.textContent).toContain('登录已失效');expect(f.root.textContent).not.toContain('旧昵称');
  f.key('');expect(f.root.textContent).toContain('未绑定');f.display.dispose();
 });
 it('keeps connection errors separate from absent nicknames and does not background-poll',async()=>{
  request.mockResolvedValue({status:503,json:{}});const f=fixture();const cleanup=f.display.render(f.root);await flush();
  expect(f.root.textContent).toContain('账号信息暂不可用');f.display.render(f.root);await flush();expect(request).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(120000);expect(request).toHaveBeenCalledOnce();cleanup();f.display.dispose();
 });
 it('renders nickname text safely',async()=>{
  request.mockResolvedValue({status:200,json:{public_id:'clip-account',nickname:'<img src=x onerror=alert(1)>'}});const f=fixture();f.display.render(f.root);await flush();
  expect(f.root.querySelector('img')).toBeNull();expect(f.root.textContent).toContain('<img');f.display.dispose();
 });
 it('does not republish a pending nickname after the main plugin unloads',async()=>{
  let finish!:(value:unknown)=>void;request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const f=fixture();f.display.render(f.root);f.display.dispose();finish({status:200,json:{public_id:'old',nickname:'不应显示'}});await flush();
  expect(f.root.textContent).toContain('主插件已停用');expect(f.root.textContent).not.toContain('不应显示');
 });

});
