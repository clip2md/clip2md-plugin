import { parseDocument, isMap, isScalar } from 'yaml';
import { propertyBindings } from './property-template';
import type { LocalField } from './companion-protocol';
const LOCAL_FIELD_LABELS: Record<`local_${LocalField}`, string> = {
    local_source_title: '原站标题', local_author: '原站作者', local_source_date: '原站发布时间',
    local_duration_seconds: '时长（秒）', local_views: '播放／阅读数', local_likes: '点赞数',
    local_collects: '收藏数', local_comments: '评论数', local_shares: '分享数', local_coins: '投币数',
    local_captured_at: '本地采集时间', local_assets: '本地素材链接',
};
export const LOCAL_VARIABLES: Record<string, string> = {
    ...LOCAL_FIELD_LABELS,
    local_cover: '封面图', local_media: '音视频', local_gallery: '图集',
    local_transcript: '本地转写正文', local_transcript_link: '转写笔记链接',
    local_transcript_language: '转写语言', local_transcript_source: '转写来源', local_transcribed_at: '转写完成时间',
};
export const LOCAL_VARIABLE_DESCRIPTIONS: Record<string, string> = {
    local_cover: '直接显示下载的首张封面或原图；需开启该平台的“封面／原图”。仅用于正文。',
    local_media: '嵌入已下载的音视频，在正文中使用 Obsidian 原生播放器播放；需开启该平台的“视频／音频”。仅用于正文。',
    local_gallery: '逐张显示已下载的封面或原图，包含首张图片；需开启该平台的“封面／原图”。仅用于正文。',
    local_source_title: '本机从原站采集的作品标题，区别于云端生成的智能标题。',
    local_author: '原站显示的作品作者或账号名称。',
    local_source_date: '原站提供的发布时间；具体格式和精度取决于平台。',
    local_duration_seconds: '视频或音频的时长，单位为秒。',
    local_views: '采集时平台返回的播放量或阅读量。',
    local_likes: '采集时作品的点赞数量。',
    local_collects: '采集时作品的收藏数量。',
    local_comments: '采集时作品的评论数量，不代表已下载的评论条数。',
    local_shares: '采集时作品的分享或转发数量。',
    local_coins: '采集时作品的投币数量，主要用于 B 站。',
    local_captured_at: '本机采集来源信息的时间，并非作品发布时间。',
    local_assets: '已保存到知识库的视频、音频、图片等素材链接列表。',
    local_transcript: '本地获取的字幕或语音转写正文；带 [时:分:秒] 时间段时，点击时间可打开播放器并跳到该起点。',
    local_transcript_link: '指向知识库中转写笔记的 Markdown 链接。',
    local_transcript_language: '本地转写的语言设置；auto 表示自动识别。',
    local_transcript_source: '转写内容的来源说明，用于区分原站字幕、音频转写等来源。',
    local_transcribed_at: '本地转写完成的时间。',
};
export const LOCAL_BODY_VARIABLES = ['local_cover', 'local_media', 'local_gallery', 'local_transcript'];

/** Vault-root Markdown embeds use Obsidian's native image/audio/video renderer. */
function mediaPaths(value: string | number | string[]): string[] {
    const paths = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    return [...new Set(paths)].filter(path => path.trim() && !/[\r\n]/.test(path)
        && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path) && !path.split('/').includes('..'));
}
export function renderLocalMedia(name: string, value: string | number | string[]): string {
    const valid = mediaPaths(value);
    const images = valid.filter(path => /\.(?:png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(path));
    const media = valid.filter(path => /\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|mp3|m4a|wav|ogg|oga|flac|opus|aac|3gp|m3u8|ts|flv)$/i.test(path));
    const selected = name === 'local_cover' ? images.slice(0, 1) : name === 'local_gallery' ? images : media;
    return name === 'local_media'
        ? selected.map(path => `![[${path}]]`).join('\n\n')
        : selected.map(path => `![](<${'/' + path.split('/').map(encodeURIComponent).join('/')}>)`).join('\n\n');
}
function timestampSeconds(value: string): number | null {
    const parts = value.replace(/[,.]\d+$/, '').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part) || part < 0) || (parts.length !== 2 && parts.length !== 3)) return null;
    return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}
/** Link transcript cue starts to an Obsidian media fragment so clicking a cue seeks the player. */
export function renderLocalTranscript(value: string | number | string[], media: string | number | string[]): string {
    const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : '';
    const target = mediaPaths(media).find(path => /\.(?:mp4|m4v|mkv|webm|mov|ogv|mpeg|mpg|mp3|m4a|wav|ogg|oga|flac|opus|aac|3gp|m3u8|ts|flv)$/i.test(path));
    if (!text || !target) return text;
    const link = (clock: string, label = clock) => {
        const seconds = timestampSeconds(clock);
        if (seconds === null) return `[${label}]`;
        const encoded = '/' + target.split('/').map(encodeURIComponent).join('/');
        return `[${label}](<${encoded}#t=${seconds}>)`;
    };
    let rendered = text.replace(/\[((?:\d{1,3}:)?\d{1,2}:\d{2})(?:\s*(?:-->|-|–|—)\s*((?:\d{1,3}:)?\d{1,2}:\d{2}))?\]/g,
        (whole, start: string) => link(start, whole.slice(1, -1)));
    // Also recognize SRT/VTT cue ranges at the start of a line and link the cue's start.
    rendered = rendered.replace(/^(\s*)((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?\s*(?:-->|-|–|—)\s*(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)\s*$/gm,
        (whole, indent: string, range: string) => {
            const start = range.match(/^((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)/)?.[1];
            return start ? `${indent}${link(start, range)}` : whole;
        });
    return rendered;
}
export function desktopTokens(template: string): string[] {
    return [...new Set([...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map(m => m[1]).filter(name => name in LOCAL_VARIABLES))];
}
export function removeDesktopTokens(template: string, yaml = false): string {
    const strip = (text: string) => text.replace(/\{\{([a-z_]+)\}\}/g, (token, name: string) => name in LOCAL_VARIABLES ? '' : token);
    if (!yaml || !desktopTokens(template).length)
        return strip(template);
    const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*)([\s\S]*)$/.exec(template);
    if (!match)
        throw new Error('属性模板无法安全解析，请先修复 YAML');
    // Substitute tokens only inside scalar text; preserve unrelated properties and comments.
    const placeholders: string[] = [];
    const prepared = match[2].replace(/\{\{[a-z_]+\}\}/g, token => { const index = placeholders.push(token) - 1; return `CLIP2MDTEMPLATEPLACEHOLDER${index}X`; });
    const restore = (text: string) => text.replace(/CLIP2MDTEMPLATEPLACEHOLDER(\d+)X/g, (_, index: string) => placeholders[Number(index)]);
    const doc = parseDocument(prepared);
    if (doc.errors.length || !isMap(doc.contents))
        throw new Error('属性模板无法安全解析，请先修复 YAML');
    for (const pair of [...doc.contents.items]) {
        if (!isScalar(pair.value) || typeof pair.value.value !== 'string')
            continue;
        const value = restore(pair.value.value);
        if (!desktopTokens(value).length)
            continue;
        if (!strip(value).trim())
            doc.contents.items.splice(doc.contents.items.indexOf(pair), 1);
        else
            pair.value.value = strip(value);
    }
    const cleaned = `${match[1]}${restore(doc.toString()).trimEnd()}${match[3]}${strip(match[4])}`;
    return cleaned;
}

/** Missing desktop capability must not erase previously collected template values. */
export function renderLocalToken(name:string,taskId:number,index:number,value:string):string {
    if(value.includes('<!-- clip2md-local-variable:')||value.includes('<!-- /clip2md-local-variable:'))throw new Error('本地字段含保留的区域标记');
    const id=`${taskId}:${name}:${index}`;
    return `<!-- clip2md-local-variable:v1:${id} -->${value}<!-- /clip2md-local-variable:${id} -->`;
}
export function preserveLocalTemplateValues(before:string,after:string,taskId:number,values:Record<string,unknown> = {},propertyTemplate=''):string {
    const pattern=new RegExp(`<!-- clip2md-local-variable:v1:(${taskId}:([a-z_]+):\\d+) -->([\\s\\S]*?)<!-- /clip2md-local-variable:\\1 -->`,'g');
    const old=[...before.matchAll(pattern)],incoming=[...after.matchAll(pattern)];
    if(new Set(old.map(m=>m[1])).size!==old.length)throw new Error('本地字段标记重复，已保留笔记');
    for(const prior of old)if(values[prior[2]]===undefined){const target=incoming.find(m=>m[1]===prior[1]);if(target)after=after.replace(target[0],()=>prior[0]);}
    const header=/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
    const prior=header.exec(before),next=header.exec(after);
    if(prior&&next&&desktopTokens(propertyTemplate).length){
        const oldDoc=parseDocument(prior[2]),nextDoc=parseDocument(next[2]);
        if(oldDoc.errors.length||nextDoc.errors.length)throw new Error('属性 YAML 无效，已保留笔记');
        for(const binding of propertyBindings(propertyTemplate)) {
            if(oldDoc.has(binding.key))nextDoc.set(binding.key,oldDoc.get(binding.key));
        }
        after=next[1]+nextDoc.toString().trimEnd()+next[3]+after.slice(next[0].length);
    }
    return after;
}
