import { load } from 'cheerio';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const apiKey = '0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM';
const fetchedArticleContentHtmlImgRegex = /<img data-reference="image" data-document-id="cms\/api\/amp\/image\/([A-Za-z0-9]+)"[^>]*>/g;

// 清理 URL 追踪参数并解码 UTF-8 汉字
const cleanAndDecodeUrl = (rawUrl?: string): string => {
    if (!rawUrl) {
        return '';
    }
    try {
        const urlObj = new URL(rawUrl);
        urlObj.search = ''; // 1. 移除 ? 后面的全部追踪参数 (如 ocid, cvid 等)
        const cleanStr = urlObj.toString();
        try {
            return decodeURIComponent(cleanStr); // 2. 解码 %XX 编码为正常中文
        } catch {
            return cleanStr;
        }
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
    example: '/msn/zh-hk/AFP/sr-vid-3kv7h73mtcdhywg28d4f9ihgi4xcniq2ubb83iikdu3qwmbd73pa',
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

        interface MsnFeedResponse {
            nextPageUrl?: string;
            sections?: Array<{
                cards?: Array<{
                    id?: string;
                    articleId?: string;
                    url?: string;
                    title?: string;
                    body?: string;
                    abstract?: string;
                    publishedDateTime?: string;
                    category?: string;
                    providerName?: string;
                    provider?: { name?: string };
                    authors?: Array<{ name?: string }>;
                }>;
            }>;
        }

        // 1. 请求第 1 页
        const firstPageData = await ofetch<MsnFeedResponse>(firstApiUrl);
        let rawCards = firstPageData.sections?.[0]?.cards ?? [];

        // 2. 利用 nextPageUrl 追加第 2 页，合并至 20+ 篇
        if (firstPageData.nextPageUrl) {
            try {
                const secondPageData = await ofetch<MsnFeedResponse>(firstPageData.nextPageUrl);
                const secondCards = secondPageData.sections?.[0]?.cards ?? [];
                rawCards = [...rawCards, ...secondCards];
            } catch {
                // 网络异常降级保留第 1 页
            }
        }

        const items = await Promise.all(
            rawCards.map(async (card) => {
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
                    try {
                        const fetchedArticleContentHtml = await cache.tryGet(`msn:${market}:${cleanId}`, async () => {
                            const articleData = await ofetch<{ body?: string }>(`https://assets.msn.com/content/view/v2/Detail/${market}/${cleanId}`);
                            return articleData?.body ?? '';
                        });

                        if (fetchedArticleContentHtml) {
                            articleContentHtml = fetchedArticleContentHtml.replace(
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

                // 清洗与解码文章 URL
                const cleanLink = cleanAndDecodeUrl(card.url);

                return {
                    title: card.title,
                    link: cleanLink,
                    description: articleContentHtml,
                    author: articleAuthor,
                    pubDate: parseDate(card.publishedDateTime),
                    category: card.category ? [card.category] : [],
                };
            })
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