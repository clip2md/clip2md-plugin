function positiveTaskId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const id = Number(value);
        if (Number.isSafeInteger(id) && id > 0) return id;
    }
    return null;
}

export function hasTaskId(content: string, taskId: number): boolean {
    return new RegExp(`<!-- biji-task-id:${taskId}\\s*-->`).test(content)
        || new RegExp(`<!-- clip2md-task-start:${taskId}\\s*-->`).test(content);
}

export function taskIdsInContent(content: string): number[] {
    const ids = new Set<number>();
    for (const match of content.matchAll(/<!-- biji-task-id:(\d+)\s*-->/g)) {
        const id = positiveTaskId(match[1]);
        if (id) ids.add(id);
    }
    for (const match of content.matchAll(/<!-- clip2md-task-start:(\d+)\s*-->/g)) {
        const id = positiveTaskId(match[1]);
        if (id) ids.add(id);
    }
    return [...ids];
}
