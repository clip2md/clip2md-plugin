import { parseDocument, isMap, isScalar } from "yaml";

/**
 * Website builds only retain the token cleanup needed to migrate old templates.
 * No local media renderer, transcript linker, or task-value injection is bundled.
 */
export const LOCAL_VARIABLES: Record<string, string> = {};
export const LOCAL_VARIABLE_DESCRIPTIONS: Record<string, string> = {};
export const LOCAL_BODY_VARIABLES: string[] = [];
export function desktopTokens(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map(match => match[1]).filter(name => name.startsWith("local_")))];
}
function strip(template: string): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (token, name: string) => name.startsWith("local_") ? "" : token);
}
export function removeDesktopTokens(template: string, yaml = false): string {
  if (!yaml || !desktopTokens(template).length) return strip(template);
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*)([\s\S]*)$/.exec(template);
  if (!match) throw new Error("属性模板无法安全解析，请先修复 YAML");
  const placeholders: string[] = [];
  const prepared = match[2].replace(/\{\{[a-z_]+\}\}/g, token => {
    const index = placeholders.push(token) - 1;
    return `CLIP2MDTEMPLATEPLACEHOLDER${index}X`;
  });
  const restore = (text: string) => text.replace(/CLIP2MDTEMPLATEPLACEHOLDER(\d+)X/g, (_, index: string) => placeholders[Number(index)]);
  const doc = parseDocument(prepared);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error("属性模板无法安全解析，请先修复 YAML");
  for (const pair of [...doc.contents.items]) {
    if (!isScalar(pair.value) || typeof pair.value.value !== "string") continue;
    const value = restore(pair.value.value);
    if (!desktopTokens(value).length) continue;
    if (!strip(value).trim()) doc.contents.items.splice(doc.contents.items.indexOf(pair), 1);
    else pair.value.value = strip(value);
  }
  return `${match[1]}${restore(doc.toString()).trimEnd()}${match[3]}${strip(match[4])}`;
}
export const renderLocalMedia = (_name: string, _value: unknown): string => "";
export const renderLocalToken = (_name: string, _taskId: number, _index: number, value: string): string => value;
export const renderLocalTranscript = (value: unknown, _media: unknown): string => typeof value === "string" ? value : "";
export const preserveLocalTemplateValues = (_before: string, after: string, _taskId: number, _values: unknown, _template: string): string => after;
