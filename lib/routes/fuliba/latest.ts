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

// 模拟 Miniflux 的 nl2br 规则：将 \n 换行符转为 HTML <br> 标签
function nl2br(str: string): string {
    return str.replace(/(\r\n|\n\r|\r|\n)/g, '<br>');
}

async function handler(ctx) {
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit'), 10) : 30;

    const feed = await parser.parseURL('https://fuliba.net/feed');

    const items = feed.items.slice(0, limit).map((item) => {
        let rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';

        // 1. 执行 nl2br，恢复丢失的换行排版
        rawContent = nl2br(rawContent);

        // 2. 使用 cheerio 清除多余图片占位符属性，还原真实图片
        const $ = load(rawContent, null, false);
        $('img').each((_, img) => {
            const $img = $(img);
            const realSrc = $img.attr('data-orig-file') || $img.attr('data-src') || $img.attr('src');
            if (realSrc) {
                $img.attr('src', realSrc);
            }
            $img.removeAttr('srcset').removeAttr('sizes').removeAttr('loading');
        });

        return {
            title: item.title,
            link: item.link,
            guid: item.guid ?? item.link,
            description: $.html(),
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