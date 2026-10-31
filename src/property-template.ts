import { isAlias, isMap, isScalar, parseDocument, visit } from 'yaml';
import { LOCAL_FIELDS, LOCAL_PROPERTY_NAMES, type LocalField, type LocalProperties } from './companion-protocol';
import { readLocalProperties, withNamedLocalProperties } from './local-properties';

export interface PropertyBinding { key:string; names:string[]; field?:LocalField; }
const token=/\{\{([a-z_]+)\}\}/g;
const localName=(name:string)=>name.startsWith('local_');
const body=(template:string)=>template.replace(/^\uFEFF?---\r?\n/,'').replace(/\r?\n---[ \t]*(?:\r?\n)?$/,'');
export function propertyBindings(template:string):PropertyBinding[] {
    if(!template.trim()||!template.includes('{{local_'))return [];
    const tokens:string[]=[];
    const prepared=body(template).replace(token,whole=>`CLIP2MDPROPERTYTOKEN${tokens.push(whole)-1}X`);
    const doc=parseDocument(prepared);
    if(doc.errors.length||!isMap(doc.contents))throw new Error('笔记属性模板 YAML 无效，请先修复后再开启来源属性');
    const result:PropertyBinding[]=[];
    for(const pair of doc.contents.items) {
        if(!isScalar(pair.key)||!isScalar(pair.value)||typeof pair.value.value!=='string')continue;
        const value=pair.value.value.replace(/CLIP2MDPROPERTYTOKEN(\d+)X/g,(_,index:string)=>tokens[Number(index)]);
        const names=[...value.matchAll(token)].map(match=>match[1]).filter(localName);
        if(!names.length)continue;
        const exact=/^\{\{local_([a-z_]+)\}\}$/.exec(value.trim())?.[1];
        result.push({key:String(pair.key.value),names,field:LOCAL_FIELDS.find(field=>field===exact)});
    }
    return result;
}
const sourceBindings=(template:string)=>propertyBindings(template).filter(binding=>binding.field&&!['url','task_id'].includes(binding.key));
export const sourcePropertyKeys=(template:string)=>sourceBindings(template).map(binding=>binding.key);
export function readSourceProperties(content:string,template:string):LocalProperties {
    const result=readLocalProperties(content),match=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    const doc=parseDocument(match?.[1]||'');
    if(doc.errors.length)throw new Error('笔记属性 YAML 无效');
    for(const {key,field} of sourceBindings(template))if(field&&doc.has(key)) {
        const value:unknown=doc.get(key);
        if(value!==null)(result as Record<string,unknown>)[field]=value;
    }
    return result;
}
export function withSourcePropertyTemplate(template:string):string {
    if(!/^\uFEFF?---\r?\n[\s\S]*\r?\n---[ \t]*(?:\r?\n)?$/.test(template))throw new Error('笔记属性模板需使用完整 YAML 边界');
    const bindings=propertyBindings(template);
    const names=new Set(bindings.flatMap(binding=>binding.names));
    const prepared=body(template).replace(token,'VALUE');
    const doc=parseDocument(prepared);
    if(doc.errors.length||!isMap(doc.contents)||doc.contents.flow)throw new Error('笔记属性模板需使用有效的分行 YAML');
    const lines=LOCAL_FIELDS.filter(field=>!names.has(`local_${field}`)&&!doc.has(LOCAL_PROPERTY_NAMES[field]))
        .map(field=>`${JSON.stringify(LOCAL_PROPERTY_NAMES[field])}: {{local_${field}}}`);
    return lines.length?template.replace(/\r?\n---[ \t]*(\r?\n)?$/,(_whole,tail:string)=>`\n${lines.join('\n')}\n---${tail||''}`):template;
}
export function applySourceProperties(content:string,template:string,incoming:LocalProperties,previous:LocalProperties,replace=false):{content:string;preserved:LocalField[]} {
    const bindings=sourceBindings(template),legacy=readLocalProperties(content);
    const match=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    const doc=parseDocument(match?.[1]||'');
    if(doc.errors.length)throw new Error('笔记属性 YAML 无效，已保留原文件');
    const fields=new Map<string,unknown>(),preserved:LocalField[]=[];
    for(const {key,field} of bindings) {
        if(!field)continue;
        const has=doc.has(key),raw:unknown=doc.get(key);
        const current=(raw===null||raw===''||!has)&&legacy[field]!==undefined?legacy[field]:raw;
        if(incoming[field]===undefined){if(has||current!==undefined)fields.set(key,current);continue;}
        const empty=current===undefined||current===null||current==='';
        const deleted=!has&&legacy[field]===undefined&&previous[field]!==undefined;
        const edited=(!empty||previous[field]!==undefined)&&JSON.stringify(current)!==JSON.stringify(previous[field])&&JSON.stringify(current)!==JSON.stringify(incoming[field]);
        if(!replace&&(deleted||edited)) {
            preserved.push(field);if(has||current!==undefined)fields.set(key,current);
        } else fields.set(key,incoming[field]);
    }
    return {content:withNamedLocalProperties(content,Object.fromEntries(fields),bindings.map(binding=>binding.key)),preserved:[...new Set(preserved)]};
}
/** Resolve local scalars structurally so strings, numbers and lists remain valid YAML. */
export function renderLocalPropertyValues(template:string,values:Record<string,unknown>,render:(value:string)=>string):string {
    const bindings=propertyBindings(template);
    if(!bindings.length)return render(template);
    const markers=new Map<string,string>();
    const masked=template.replace(token,(whole,name:string)=>{
        if(!localName(name))return whole;
        const marker=`CLIP2MDLOCALSCALAR${markers.size}X`;markers.set(marker,name);return marker;
    });
    const rendered=render(masked),match=/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n)?)$/.exec(rendered);
    if(!match)throw new Error('笔记属性模板需使用完整 YAML 边界');
    const doc=parseDocument(match[2]);
    if(doc.errors.length||!isMap(doc.contents))throw new Error('笔记属性模板 YAML 无效');
    visit(doc,(_key,node)=>{if(isAlias(node))throw new Error('来源属性模板暂不支持 YAML 别名');});
    for(const binding of bindings) {
        const pair=doc.contents.items.find(pair=>isScalar(pair.key)&&pair.key.value===binding.key);
        if(!pair||!isScalar(pair.value)||typeof pair.value.value!=='string')continue;
        const exact=markers.get(pair.value.value);
        if(exact)doc.set(binding.key,values[exact]??(exact==='local_assets'?[]:null));
        else pair.value.value=pair.value.value.replace(/CLIP2MDLOCALSCALAR\d+X/g,marker=>{
            const value=values[markers.get(marker)!];return value===undefined?'':typeof value==='string'?value:JSON.stringify(value)??'';
        });
    }
    return match[1]+doc.toString().trimEnd()+match[3];
}
