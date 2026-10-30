/** Public source CDNs whose original images may be present instead of hosted assets. */
const SOURCES: Array<[string[], string]> = [
    [['sinaimg.cn', 'sinaimg.com', 'sinajs.cn'], 'https://weibo.com/'],
    [['qpic.cn', 'qlogo.cn'], 'https://mp.weixin.qq.com/'],
    [['zhimg.com'], 'https://www.zhihu.com/'],
    [['hdslb.com'], 'https://www.bilibili.com/'],
    [['xhscdn.com'], 'https://www.xiaohongshu.com/'],
    [['byteimg.com', 'douyinpic.com', 'pstatp.com'], 'https://www.douyin.com/'],
    [['doubanio.com'], 'https://www.douban.com/'],
    [['csdnimg.cn'], 'https://blog.csdn.net/'],
];

export function sourceImageRequest(value: string): { url: string; headers: Record<string, string> } | null {
    try {
        const url = new URL(value.startsWith('//') ? `https:${value}` : value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return null;
        const source = SOURCES.find(([domains]) => domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)));
        if (!source) return null;
        url.protocol = 'https:'; url.port = '';
        return { url: url.href, headers: {
            Referer: source[1],
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        } };
    } catch { return null; }
}
