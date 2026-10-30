/** Website distribution never creates or updates desktop AI document regions. */
export const WEBSITE_LOCAL_AI_REMOVED = true;
export class LocalAIConflict extends Error {}
export const slot = (_name: string, _taskId: number, _index: number, value: string): string => value;
export const identifyLocalAI = async (_content: string, _taskId: number, _id: string, _fields: unknown): Promise<string> => "";
export const updateLocalAI = async (_before: string, _next: string, _taskId: number, _id: string, _fields: unknown, _values: unknown): Promise<string> => _next;
export const localSourceChanged = async (_content: string, _taskId: number): Promise<boolean> => false;
