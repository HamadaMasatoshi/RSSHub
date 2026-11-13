import { load } from 'cheerio';
import pMap from 'p-map';

import type { Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

interface MsnCard {
    id?: string;
    articleId?: string;
    url: string;
    title: string;
    body?: string;
    abstract: string;
    publishedDateTime?: string;
    category?: string;
    providerName?: string;
    provider?: { name?: string };
    authors?: Array<{ name?: string }>;
}

interface MsnFeedResponse {
    nextPageUrl?: string;
    sections?: Array<{
        cards?: MsnCard[];
    }>;
}

const apiKey = '0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM';
const fetchedArticleContentHtmlImgRegex = /<img data-reference="image" data-document-id="cms\/api\/amp\/image\/([A-Za-z0-9]+)"[^>]*>/g;

// 清理 URL 追踪参数 (保留完整路径，确保 Telegram / 微信等平台能正常生成网页预览卡片)
const cleanUrl = (rawUrl?: string): string => {
    if (!rawUrl) {
        return '';
    }
    try {
        const urlObj = new URL(rawUrl);
        urlObj.search = ''; // 移除 ?ocid=... 等全部追踪参数
        return urlObj.toString();
    } catch {
        return rawUrl.split('?')[0];
    }
};

export const route: Route = {
    path: '/:market/:name/:id',
    parameters: {
        market: 'Market code. Find it in MSN url, e.g. zh-tw',
        name: 'Name of the channel. Find it in MSN url, e.g. Bloomberg',
        id: 'ID of the channel (always starts with sr-vid). Find it in MSN url, e.g. sr-vid-08gw7ky4u229xjsjvnf4n6n7v67gxm0pjmv9fr4y2x9jjmwcri4s',
    },
    categories: ['traditional-media'],
    example: '/msn/zh-tw/Bloomberg/sr-vid-08gw7ky4u229xjsjvnf4n6n7v67gxm0pjmv9fr4y2x9jjmwcri4s',
    description: 'MSN News',
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportRadar: true,
    },
    radar: [
        {
            source: ['www.msn.com/:market/channel/source/:name/:id'],
            target: '/:market/:name/:id',
        },
    ],
    name: 'News',
    maintainers: ['KTachibanaM'],
    handler: async (ctx) => {
        const { market, name, id } = ctx.req.param();
        let truncatedId = id;
        if (truncatedId.startsWith('sr-')) {
            truncatedId = truncatedId.slice(3);
        }

        const pageData = await ofetch(`https://www.msn.com/${market}/channel/source/${name}/${id}`);
        const $ = load(pageData);

        let requestMuid = '';
        const headElement = $('head');
        const dataClientSettings = headElement.attr('data-client-settings');
        if (dataClientSettings) {
            try {
                const parsedSettings = JSON.parse(dataClientSettings);
                requestMuid = parsedSettings.fd_muid || '';
            } catch {
                // 忽略解析错误
            }
        }
        if (!requestMuid) {
            const muidMatch = pageData.match(/"fd_muid":"([^"]+)"/);
            if (muidMatch) {
                requestMuid = muidMatch[1];
            }
        }

        let firstApiUrl = `https://assets.msn.com/service/news/feed/pages/providerfullpage?market=${market}&query=newest&CommunityProfileId=${truncatedId}&apikey=${apiKey}`;
        if (requestMuid) {
            firstApiUrl += `&user=m-${requestMuid}`;
        }

        // 循环拉取最多 5 页（约 60 篇），覆盖高频更新
        const maxPages = 5;
        let currentApiUrl: string | undefined = firstApiUrl;
        let pageCount = 0;
        let rawCards: MsnCard[] = [];

        while (currentApiUrl && pageCount < maxPages) {
            try {
                const pageResponse = await ofetch<MsnFeedResponse>(currentApiUrl);
                const cards = pageResponse.sections?.[0]?.cards ?? [];
                rawCards = [...rawCards, ...cards];
                currentApiUrl = pageResponse.nextPageUrl;
                pageCount++;
            } catch {
                break; // 遇到网络波动等异常时跳出，保留已获取到的文章
            }
        }

        if (!rawCards.length) {
            throw new Error('MSN returned no articles for this channel. Check the market and source ID on its public page.');
        }

        const items = await pMap(
            rawCards,
            async (card) => {
                let articleContentHtml = card.body || card.abstract || '';

                let rawId = card.id || card.articleId;
                if (!rawId && card.url) {
                    const matched = card.url.match(/ar-([A-Za-z0-9]+)/);
                    if (matched) {
                        rawId = matched[1];
                    }
                }

                if (rawId) {
                    const cleanId = rawId.replace(/^ar-/, '');
                    const articleDetailUrl = `https://assets.msn.com/content/view/v2/Detail/${market}/${cleanId}`;
                    try {
                        const fetchedArticleContentHtml = await cache.tryGet(articleDetailUrl, async () => {
                            const articleData = await ofetch<{ body?: string }>(articleDetailUrl);
                            return articleData?.body ?? '';
                        });

                        if (fetchedArticleContentHtml) {
                            articleContentHtml = fetchedArticleContentHtml.replaceAll(
                                fetchedArticleContentHtmlImgRegex,
                                '<img src="https://img-s-msn-com.akamaized.net/tenant/amp/entityid/$1.img">'
                            );
                        }
                    } catch {
                        // 异常时保留默认摘要
                    }
                }

                const articleAuthor =
                    card.authors?.map((a) => a.name).filter(Boolean).join(', ') ||
                    card.provider?.name ||
                    card.providerName ||
                    name;

                return {
                    title: card.title,
                    link: cleanUrl(card.url),
                    description: articleContentHtml,
                    content: {
                        html: articleContentHtml,
                    },
                    author: articleAuthor,
                    pubDate: card.publishedDateTime ? parseDate(card.publishedDateTime) : undefined,
                    category: card.category ? [card.category] : undefined,
                };
            },
            { concurrency: 3 }
        );

        const channelLink = `https://www.msn.com/${market}/channel/source/${name}/${id}`;
        return {
            title: name,
            image: 'https://www.msn.com/favicon.ico',
            link: channelLink,
            item: items,
        };
    },
};