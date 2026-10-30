import {describe,it,expect,beforeEach,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {slot,identifyLocalAI,updateLocalAI} from './local-ai-document';
import {removeDesktopTokens,desktopTokens,renderLocalToken,renderLocalMedia,renderLocalTranscript,preserveLocalTemplateValues} from './desktop-variables';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
const document=(ai:string,source:string,title:string)=>`---\nsource_title: 原始标题\nclip2md_ai_title: ${title}\nother: 用户属性\n---\n<!-- biji-task-id:42 -->\n${slot('ai',42,0,ai)}\n${slot('source',42,0,source)}\n用户批注：保留\n${slot('title',42,1,title)}`;
describe('AI updates preserve original material',()=>{
 it('updates only AI occurrences and untouched AI properties; preserves edited original bytes and comments',async()=>{
  const first=await identifyLocalAI(document('旧智能笔记','原文：一字不改','旧标题'),42,'input-1',['clip2md_ai_title']);
  const edited=first.replace('原文：一字不改','原文：用户改过但不能覆盖');
  const updated=await updateLocalAI(edited,document('新智能笔记','云端返回的其他原文','新标题'),42,'input-1',['clip2md_ai_title']);
  expect(updated).toContain('新智能笔记');expect(updated).toContain('原文：用户改过但不能覆盖');expect(updated).not.toContain('云端返回的其他原文');expect(updated).toContain('source_title: 原始标题');expect(updated).toContain('用户批注：保留');expect(updated).toContain('clip2md_ai_title: 新标题');
 });
 it('rejects overwritten AI text or AI properties and ambiguous identities',async()=>{
  const first=await identifyLocalAI(document('旧智能笔记','原文','旧标题'),42,'input-1',['clip2md_ai_title']);
  await expect(updateLocalAI(first.replace('旧智能笔记','用户修改AI'),document('新','原文','新'),42,'input-1',['clip2md_ai_title'])).rejects.toThrow('用户修改');
  await expect(updateLocalAI(first.replace('clip2md_ai_title: 旧标题','clip2md_ai_title: 用户标题'),document('新','原文','新'),42,'input-1',['clip2md_ai_title'])).rejects.toThrow('用户修改');
  await expect(updateLocalAI('手写笔记',document('新','原文','新'),42,'input-1',[])).rejects.toThrow('历史笔记');
 });
 it('updates repeated variables independently and rejects reserved marker injection',async()=>{
  const first=await identifyLocalAI(slot('ai',42,0,'旧')+'\n'+slot('ai',42,1,'旧'),42,'i',[]);
  const result=await updateLocalAI(first,slot('ai',42,0,'新')+'\n'+slot('ai',42,1,'新'),42,'i',[]);
  expect(result.match(/ -->新<!--/g)).toHaveLength(2);
  expect(()=>slot('source',42,2,'<!-- clip2md-ai:v1:bad -->')).toThrow('保留');
 });
});
describe('disable only removes registered desktop template fields',()=>{
 it('renders only valid local media and excludes unrelated or unsafe assets',()=>{
  expect(decodeURI(renderLocalMedia('local_cover',['素材/首图.png','素材/次图.png']))).toBe('![](</素材/首图.png>)');
 expect(renderLocalMedia('local_media',['素材/原图.png','素材/视频.mp4','素材/视频.mp4','素材/评论.md'])).toBe('![[素材/视频.mp4]]');
 expect(renderLocalMedia('local_media',['素材/视频.mkv','素材/视频.webm','素材/视频.mov','素材/音频.m4a','素材/音频.opus','素材/流.m3u8'])).toBe(['素材/视频.mkv','素材/视频.webm','素材/视频.mov','素材/音频.m4a','素材/音频.opus','素材/流.m3u8'].map(file=>`![[${file}]]`).join('\n\n'));
  expect(decodeURI(renderLocalMedia('local_gallery',['../secret.png','https://site.test/img.png','/tmp/a.png','bad\nfile.png','素材/正常.png']))).toBe('![](</素材/正常.png>)');
  expect(renderLocalMedia('local_cover','assets/cover #1[ok].png')).toBe('![](</assets/cover%20%231%5Bok%5D.png>)');
 });
 it('preserves cloud array tokens, unrelated properties, punctuation and body text',()=>{
  const raw='---\nsource: "{{source}}"\ntags: {{tags}}\nlocal_author: "{{local_author}}"\nmixed: "保留：{{local_author}}！"\n---';
  const result=removeDesktopTokens(raw,true);
  expect(result).toContain('{{source}}');expect(result).toContain('{{tags}}');expect(result).not.toContain('local_author:');expect(result).toContain('保留：！');
  expect(removeDesktopTokens('正文 {{content}} {{local_transcript}} 保留')).toBe('正文 {{content}}  保留');
  expect(desktopTokens('{{unknown}} {{title}} {{local_transcript}}')).toEqual(['local_transcript']);
 });
 it('refuses invalid YAML instead of overwriting a damaged template',()=>{
  expect(()=>removeDesktopTokens('---\nfield: [invalid\nlocal: "{{local_author}}"\n---',true)).toThrow();
 });
});

it('links transcript cue starts to the first local media file',()=>{
 const rendered=renderLocalTranscript('[00:01:02] 第一段\n\n[01:02] 第二段',['资料/42/演讲.mp4']);
 expect(decodeURI(rendered)).toContain('[00:01:02](<\/资料/42/演讲.mp4#t=62>)');
 expect(decodeURI(rendered)).toContain('[01:02](<\/资料/42/演讲.mp4#t=62>)');
});
it('uses the start of transcript time ranges for media jumps',()=>{
 const rendered=decodeURI(renderLocalTranscript('[00:07:20 - 00:07:55] 两款工具细节\n\n00:08:01,000 --> 00:08:09,500',['资料/42/演讲.mp4']));
 expect(rendered).toContain('[00:07:20 - 00:07:55](</资料/42/演讲.mp4#t=440>)');
 expect(rendered).toContain('[00:08:01,000 --> 00:08:09,500](</资料/42/演讲.mp4#t=481>)');
});

it('preserves collected local text when a mobile/offline sync updates cloud content',()=>{
 const before='旧云端正文\n'+renderLocalToken('local_transcript',42,0,'已采集转写');
 const incoming='新云端正文\n'+renderLocalToken('local_transcript',42,0,'');
 const result=preserveLocalTemplateValues(before,incoming,42);
 expect(result).toContain('新云端正文');expect(result).toContain('已采集转写');
});
