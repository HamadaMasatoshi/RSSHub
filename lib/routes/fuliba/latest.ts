import type { Route } from '@/types';
import parser from '@/utils/rss-parser';
import { load } from 'cheerio';

export const route: Route = {
    path: '/latest',
    categories: ['new-media'],
    example: '/fuliba/latest',
    parameters: {},
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['fuliba.net/'],
        },
    ],
    name: '最新',
    maintainers: ['shinemoon'],
    handler,
    url: 'fuliba.net/',
};

async function handler(ctx) {
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit'), 10) : 30;

    // 解析永久域名订阅源
    const feed = await parser.parseURL('https://fuliba.net/feed');

    const items = feed.items.slice(0, limit).map((item) => {
        const rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';

        // 使用 cheerio 修复排版问题
        const $ = load(rawContent, null, false);

        // 剔除干扰阅读的行内样式及 Class 标签
        $('*').removeAttr('style').removeAttr('class').removeAttr('id');

        // 修复 WordPress 缩略图与延迟加载属性
        $('img').each((_, img) => {
            const $img = $(img);
            const src = $img.attr('data-orig-file') || $img.attr('src');
            if (src) {
                $img.attr('src', src);
            }
            $img.removeAttr('srcset').removeAttr('sizes').removeAttr('loading');
        });

        // 压缩连续换行符
        const cleanContent = $.html().replace(/(<br\s*\/?>\s*){2,}/gi, '<br>');

        return {
            title: item.title,
            link: item.link,
            guid: item.guid ?? item.link,
            description: cleanContent,
            pubDate: item.pubDate,
            author: item.creator || item.author || '福利吧',
        };
    });

    return {
        title: feed.title ?? '福利吧',
        link: 'https://fuliba.net',
        item: items,
    };
}