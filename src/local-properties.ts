import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  stringify,
  visit,
} from "yaml";
import {
  LOCAL_FIELDS,
  type LocalField,
  type LocalProperties,
} from "./companion-protocol";
const prefix = "clip2md_local_";
const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const allowed = new Set<string>(LOCAL_FIELDS.map((key) => prefix + key));
function parsed(content: string) {
  const match = header.exec(content);
  if (!match) return null;
  const doc = parseDocument(match[1], {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  if (doc.errors.length || (doc.contents && !isMap(doc.contents)))
    throw new Error("笔记属性无效，已保留原文件");
  if (
    isMap(doc.contents) &&
    doc.contents.flow &&
    doc.contents.items.some(
      (pair) => isScalar(pair.key) && allowed.has(String(pair.key.value)),
    )
  )
    throw new Error("本地属性不能使用流式 YAML 映射");
  // A local alias/anchor must never influence the retained cloud projection.
  const hasLocal =
    isMap(doc.contents) &&
    doc.contents.items.some(
      (pair) => isScalar(pair.key) && allowed.has(String(pair.key.value)),
    );
  if (hasLocal) assertNoAliases(doc);
  return { match, doc };
}
function assertNoAliases(doc: ReturnType<typeof parseDocument>): void {
  visit(doc, (_key, node) => {
    if (
      isAlias(node) ||
      (node && typeof node === "object" && "anchor" in node && node.anchor)
    )
      throw new Error("带 YAML 锚点的笔记暂不支持本地属性");
  });
}
export function readLocalProperties(content: string): LocalProperties {
  const data = parsed(content);
  const result: LocalProperties = {};
  if (data && isMap(data.doc.contents))
    for (const pair of data.doc.contents.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      if (allowed.has(key))
        (result as Record<string, unknown>)[key.slice(prefix.length)] = (
          data.doc.toJS() as Record<string, unknown>
        )[key];
    }
  return result;
}
/** Remove only actual, allowlisted top-level YAML nodes; the body remains byte-for-byte. */
export function projectLocalProperties(content: string, extraKeys: string[] = []): string {
  const data = parsed(content);
  if (!data || !isMap(data.doc.contents)) return content;
  const projected = new Set([...allowed, ...extraKeys]);
  if(extraKeys.length) {
    assertNoAliases(data.doc);
    if(data.doc.contents.flow)throw new Error('来源属性不能使用流式 YAML 映射');
  }
  let yaml = data.match[1];
  const originalLength = yaml.length;
  const ranges: Array<[number, number]> = [];
  for (const pair of data.doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : "";
    if (!projected.has(key)) continue;
    if (
      !isScalar(pair.key) ||
      !pair.key.range ||
      !pair.value ||
      !("range" in pair.value) ||
      !pair.value.range
    )
      throw new Error("本地属性结构无效");
    const start = yaml.lastIndexOf("\n", pair.key.range[0] - 1) + 1;
    // Preserve all non-local text, including comments following the value.
    const end = Math.min(yaml.length, pair.value.range[2]);
    ranges.push([start, end]);
  }
  for (const [start, end] of ranges.reverse())
    yaml = yaml.slice(0, start) + yaml.slice(end);
  if (ranges.some(([, end]) => end === originalLength))
    yaml = yaml.replace(/\r?\n$/, "");
  const body = content.slice(data.match[0].length);
  if (!yaml.trim()) return body;
  if (!ranges.length) return content;
  const offset = data.match[0].indexOf(data.match[1]);
  return (
    data.match[0].slice(0, offset) +
    yaml +
    data.match[0].slice(offset + data.match[1].length) +
    body
  );
}
export function withLocalProperties(
  content: string,
  properties: LocalProperties,
): string {
  const fields = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [prefix + key, value]),
  );
  return withNamedLocalProperties(content, fields);
}
export function withNamedLocalProperties(content:string, fields:Record<string,unknown>, extraKeys:string[]=[]):string {
  const clean = projectLocalProperties(content,extraKeys);
  const match = header.exec(clean);
  const data = parsed(clean);
  if (data) {
    if (isMap(data.doc.contents) && data.doc.contents.flow)
      throw new Error("流式 YAML 暂不支持补充本地属性");
    assertNoAliases(data.doc);
  }
  const block = stringify(fields, { lineWidth: 0 }).trimEnd();
  if (!block || block === "{}") return clean;
  if (!match) return `---\n${block}\n---\n${clean}`;
  const yaml = match[1].replace(/\n?$/, "\n") + block;
  const offset = match[0].indexOf(match[1]);
  return (
    match[0].slice(0, offset) +
    yaml +
    match[0].slice(offset + match[1].length) +
    clean.slice(match[0].length)
  );
}
export function preserveLocalProperties(before: string, next: string): string {
  if (Object.keys(readLocalProperties(next)).length)
    throw new Error("云端模板不能写入保留的本地属性");
  const properties = readLocalProperties(before);
  return Object.keys(properties).length
    ? withLocalProperties(next, properties)
    : next;
}
export function mergeLocalProperties(
  current: LocalProperties,
  incoming: LocalProperties,
  previous: LocalProperties,
  replace = false,
) {
  const next = { ...current };
  const preserved: LocalField[] = [];
  for (const field of LOCAL_FIELDS)
    if (incoming[field] !== undefined) {
      if (
        !replace &&
        current[field] !== undefined &&
        JSON.stringify(current[field]) !== JSON.stringify(previous[field])
      )
        preserved.push(field);
      else (next as Record<string, unknown>)[field] = incoming[field];
    }
  return { next, preserved };
}
