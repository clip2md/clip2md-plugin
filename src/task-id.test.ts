import { describe, expect, it } from 'vitest';
import { hasTaskId, taskIdsInContent } from './task-id';

describe('task identity formats', () => {
    it('identifies tasks only by single-note and daily HTML markers', () => {
        const properties = '---\ntask_id: 99\n---\n正文';
        const content = `${properties}\n<!-- biji-task-id:42 -->\n<!-- clip2md-task-start:77 -->\n<!-- biji-task-id:42 -->`;
        expect(hasTaskId(properties, 99)).toBe(false);
        expect(hasTaskId(content, 42)).toBe(true);
        expect(hasTaskId(content, 77)).toBe(true);
        expect(hasTaskId(content, 4)).toBe(false);
        expect(taskIdsInContent(content)).toEqual([42, 77]);
    });
});
