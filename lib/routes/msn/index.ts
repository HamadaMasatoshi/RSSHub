import { load } from 'cheerio';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const apiKey = '0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM';
const fetchedArticleContentHtmlImgRegex = /<img data-reference="image" data-document-id="cms\/api\/amp\/image\/([A-Za-z0-9]+)"[^>]*>/g;

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

        // 1. 请求第 1 页（约 12 篇）
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

        const firstPageData = await ofetch<MsnFeedResponse>(firstApiUrl);
        let rawCards = firstPageData.sections?.[0]?.cards ?? [];

        // 2. 利用根节点返回的 nextPageUrl 请求第 2 页，合并至 20+ 篇
        if (firstPageData.nextPageUrl) {
            try {
                const secondPageData = await ofetch<MsnFeedResponse>(firstPageData.nextPageUrl);
                const secondCards = secondPageData.sections?.[0]?.cards ?? [];
                rawCards = [...rawCards, ...secondCards];
            } catch {
                // 若第二页获取失败则保持第一页数据
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

                return {
                    title: card.title,
                    link: card.url,
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