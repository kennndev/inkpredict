/**
 * Twitter Metrics Scraper
 * Fetches real tweet metrics by scraping public Twitter pages
 * No API key required - uses public HTML parsing
 */

const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Scrape tweet metrics from Twitter's public page
 * @param {string} tweetId - The tweet ID
 * @returns {Promise<Object>} Metrics object with likes, retweets, etc.
 */
async function scrapeTweetMetrics(tweetId) {
    try {
        console.log(`🌐 Scraping tweet ${tweetId} from public page...`);

        // Use nitter.net as a Twitter frontend (no auth required)
        const nitterInstances = [
            'https://nitter.net',
            'https://nitter.1d4.us',
            'https://nitter.kavin.rocks'
        ];

        for (const instance of nitterInstances) {
            try {
                const url = `${instance}/i/status/${tweetId}`;
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 10000
                });

                const $ = cheerio.load(response.data);

                // Parse metrics from Nitter page
                const metrics = {
                    likes: 0,
                    retweets: 0,
                    replies: 0,
                    views: 0
                };

                // Nitter displays metrics in icon-text format
                $('.icon-comment').parent().find('.icon-text').each((i, el) => {
                    const text = $(el).text().trim();
                    metrics.replies = parseMetricText(text);
                });

                $('.icon-retweet').parent().find('.icon-text').each((i, el) => {
                    const text = $(el).text().trim();
                    metrics.retweets = parseMetricText(text);
                });

                $('.icon-heart').parent().find('.icon-text').each((i, el) => {
                    const text = $(el).text().trim();
                    metrics.likes = parseMetricText(text);
                });

                console.log(`✅ Scraped metrics:`, metrics);
                return metrics;

            } catch (err) {
                console.log(`Failed with ${instance}, trying next...`);
                continue;
            }
        }

        throw new Error('All Nitter instances failed');

    } catch (error) {
        console.error(`❌ Scraping failed for tweet ${tweetId}:`, error.message);
        throw error;
    }
}

/**
 * Parse metric text like "1.2K" or "500" to number
 */
function parseMetricText(text) {
    if (!text) return 0;

    text = text.toLowerCase().replace(/,/g, '');

    if (text.includes('k')) {
        return Math.floor(parseFloat(text) * 1000);
    } else if (text.includes('m')) {
        return Math.floor(parseFloat(text) * 1000000);
    }

    return parseInt(text) || 0;
}

module.exports = { scrapeTweetMetrics };
