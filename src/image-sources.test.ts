import { describe, expect, it } from 'vitest';
import { sourceImageRequest } from './image-sources';

describe('source image request policy', () => {
    it('upgrades trusted original image URLs to HTTPS and preserves image query parameters', () => {
        const request = sourceImageRequest('http://wx1.sinaimg.cn:80/large/photo.jpg?crop=1&width=900');
        expect(request?.url).toBe('https://wx1.sinaimg.cn/large/photo.jpg?crop=1&width=900');
        expect(request?.headers.Referer).toBe('https://weibo.com/');
        expect(request?.headers).not.toHaveProperty('Cookie');
        expect(request?.headers).not.toHaveProperty('X-API-Key');
    });

    it.each(['https://sinaimg.cn.evil.example/p.jpg', 'https://evilsinaimg.cn/p.jpg', 'https://sinaimg.cn:8443/p.jpg', 'https://user:password@sinaimg.cn/p.jpg', 'file:///sinaimg.cn/p.jpg', 'data:image/png;base64,x', '/local/p.jpg', 'invalid'])('rejects untrusted destinations: %s', value => {
        expect(sourceImageRequest(value)).toBeNull();
    });
});
