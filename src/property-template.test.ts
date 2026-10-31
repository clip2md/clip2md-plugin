import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { applySourceProperties, propertyBindings, renderLocalPropertyValues, sourcePropertyKeys, withSourcePropertyTemplate } from './property-template';
import { preserveLocalTemplateValues } from './desktop-variables';
import { projectLocalProperties } from './local-properties';
import { NEW_DEFAULT_FRONTMATTER_TEMPLATE } from './settings';

const template='---\ntitle: Cloud\n作者: {{local_author}}\n点赞数: {{local_likes}}\n本地素材: {{local_assets}}\n---';
const render=(values:Record<string,unknown>)=>renderLocalPropertyValues(template,values,value=>value)+'\nbody';
const props=(content:string)=>parseDocument(content.match(/^---\n([\s\S]*?)\n---/)![1]).toJS();
describe('editable source property templates',()=>{
    it('adds readable fields without overwriting existing names, values or custom bindings',()=>{
        const customized=NEW_DEFAULT_FRONTMATTER_TEMPLATE.replace('\n---','\n作者: 我指定的作者\ncustom_byline: "{{local_author}}"\n---');
        const next=withSourcePropertyTemplate(customized);
        expect(next).toContain('作者: 我指定的作者');expect(next).toContain('custom_byline: "{{local_author}}"');
        expect(next.match(/local_author/g)).toHaveLength(1);expect(next).not.toContain('clip2md_');
        expect(withSourcePropertyTemplate(next)).toBe(next);expect(sourcePropertyKeys(next)).toContain('custom_byline');
    });
    it('renders local strings, zero values and asset lists as typed and escaped YAML',()=>{
        const values=props(render({local_author:'作者 "引号"\n下一行',local_likes:0,local_assets:['素材/42/音频.mp3']}));
        expect(values).toMatchObject({作者:'作者 "引号"\n下一行',点赞数:0,本地素材:['素材/42/音频.mp3']});
        expect(props(render({}))).toMatchObject({作者:null,点赞数:null,本地素材:[]});
    });
    it('accepts a trailing newline but rejects malformed or flow-style property templates without changing them',()=>{
        expect(withSourcePropertyTemplate(NEW_DEFAULT_FRONTMATTER_TEMPLATE+'\n')).toContain('{{local_author}}');
        expect(renderLocalPropertyValues(template+'\n',{local_author:'作者'},value=>value)).toContain('作者: 作者');
        expect(()=>withSourcePropertyTemplate('title: no-boundaries')).toThrow('边界');
        expect(()=>withSourcePropertyTemplate('---\n{title: Cloud}\n---')).toThrow('分行');
    });
    it('fills empty generated properties, refreshes untouched properties and preserves edited values',()=>{
        const first=applySourceProperties(render({}),template,{author:'原作者',likes:1},{ });
        expect(props(first.content)).toMatchObject({作者:'原作者',点赞数:1});
        const changed=first.content.replace('作者: 原作者','作者: 我修改的作者');
        const next=applySourceProperties(changed,template,{author:'新作者',likes:2},{author:'原作者',likes:1});
        expect(props(next.content)).toMatchObject({作者:'我修改的作者',点赞数:2});expect(next.preserved).toEqual(['author']);
        const resynced=preserveLocalTemplateValues(next.content,render({local_author:'再次采集',local_likes:3}),42,{local_author:'再次采集',local_likes:3},template);
        expect(props(resynced)).toMatchObject({作者:'我修改的作者',点赞数:2});
    });
    it('supports user-renamed property keys and migrates edited legacy prefixed properties',()=>{
        const customized=template.replace('作者:','创作者:');
        const legacy='---\ntitle: Cloud\nclip2md_local_author: 用户改过的旧作者\n---\nbody';
        const result=applySourceProperties(legacy,customized,{author:'新抓取作者'},{author:'旧抓取作者'});
        expect(props(result.content).创作者).toBe('用户改过的旧作者');expect(result.content).not.toContain('clip2md_local_author');
        expect(result.preserved).toEqual(['author']);
    });
    it('preserves a deliberately deleted property on metadata refresh',()=>{
        const result=applySourceProperties('---\ntitle: Cloud\n点赞数: 1\n---\nbody',template,{author:'新作者'},{author:'旧作者'});
        expect(props(result.content)).not.toHaveProperty('作者');expect(result.preserved).toContain('author');
    });
    it('only projects fields authorized by the template and retains cloud text and formatting',()=>{
        const before=render({local_author:'作者',local_likes:1});
        const after=applySourceProperties(before,template,{author:'新作者',likes:2},{author:'作者',likes:1}).content;
        expect(projectLocalProperties(after,sourcePropertyKeys(template))).toBe(projectLocalProperties(before,sourcePropertyKeys(template)));
        expect(propertyBindings(template).map(binding=>binding.field)).toEqual(['author','likes','assets']);
        expect(projectLocalProperties(after)).toContain('作者: 新作者');
    });
});
