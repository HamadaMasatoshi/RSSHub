import { load } from 'cheerio';

import got from '@/utils/got';

async function loadArticle(link) {
    let fullDescription = '';
    let pageNum = 1;
    let hasNextPage = true;

    // 逐页获取内容
    while (hasNextPage) {
        const pageUrl = pageNum === 1 ? link : `${link}${pageNum}/`;
        
        try {
            const resp = await got(pageUrl);
            const article = load(resp.body);

            // 提取当前页的图片内容
            const pageImages = article('.wp-block-image')
                .toArray()
                .map((element) => article.html(element))
                .join('');

            fullDescription += pageImages;

            // 检查是否有下一页
            const nextPageLink = article('.page-links')
                .find('a')
                .toArray()
                .find((element) => {
                    const href = article(element).attr('href');
                    return href && href.includes(`/${pageNum + 1}/`);
                });

            hasNextPage = !!nextPageLink;
            pageNum++;

            // 安全检查：最多获取 50 页
            if (pageNum > 50) {
                hasNextPage = false;
            }
        } catch (error) {
            // 如果某一页获取失败，停止继续获取
            hasNextPage = false;
        }
    }

    // 只在第一页获取标题
    const firstResp = await got(link);
    const firstArticle = load(firstResp.body);
    const title = firstArticle('h2.entry-title').text().trim();

    return {
        title,
        description: fullDescription,
        link,
    };
}

export default loadArticle;
