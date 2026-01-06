/**
 * Twitter Metrics Scraper - Production Ready
 * Uses multiple fallback methods for reliable metric fetching
 * No API key required for basic metrics
 */

const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Scrape tweet metrics from Twitter's public syndication API
 * This is the most reliable method that doesn't require authentication
 */
async function getTweetMetrics(tweetId) {
    try {
        console.log(`🐦 Fetching metrics for tweet ${tweetId}...`);

        // Method 1: Twitter Syndication API (most reliable, no auth needed)
        try {
            const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`;
            const response = await axios.get(syndicationUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 10000
            });

            if (response.data && response.data.favorite_count !== undefined) {
                const metrics = {
                    likes: response.data.favorite_count || 0,
                    retweets: response.data.retweet_count || 0,
                    replies: response.data.reply_count || 0,
                    quotes: response.data.quote_count || 0,
                    bookmarks: response.data.bookmark_count || 0,
                    views: response.data.views?.count || 0
                };

                console.log(`✅ Fetched metrics via Syndication API:`, metrics);
                return metrics;
            }
        } catch (synError) {
            console.log('Syndication API failed, trying alternative...');
        }

        // Method 2: Scrape from Twitter's public page (fallback)
        try {
            const twitterUrl = `https://twitter.com/i/status/${tweetId}`;
            const response = await axios.get(twitterUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });

            // Twitter embeds metrics in the HTML
            const html = response.data;

            // Extract metrics from meta tags or embedded JSON
            const metrics = {
                likes: extractMetricFromHTML(html, 'like') || 0,
                retweets: extractMetricFromHTML(html, 'retweet') || 0,
                replies: extractMetricFromHTML(html, 'reply') || 0,
                quotes: 0,
                bookmarks: 0,
                views: 0
            };

            console.log(`✅ Fetched metrics via HTML scraping:`, metrics);
            return metrics;
        } catch (htmlError) {
            console.log('HTML scraping failed, trying Nitter...');
        }

        // Method 3: Nitter instances (last resort)
        const nitterInstances = [
            'https://nitter.poast.org',
            'https://nitter.privacydev.net',
            'https://nitter.net'
        ];

        for (const instance of nitterInstances) {
            try {
                const url = `${instance}/i/status/${tweetId}`;
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 8000
                });

                const $ = cheerio.load(response.data);

                const metrics = {
                    likes: 0,
                    retweets: 0,
                    replies: 0,
                    quotes: 0,
                    bookmarks: 0,
                    views: 0
                };

                // Parse Nitter's HTML structure
                $('.icon-comment').parent().find('.icon-text').each((i, el) => {
                    metrics.replies = parseMetricText($(el).text().trim());
                });

                $('.icon-retweet').parent().find('.icon-text').each((i, el) => {
                    metrics.retweets = parseMetricText($(el).text().trim());
                });

                $('.icon-heart').parent().find('.icon-text').each((i, el) => {
                    metrics.likes = parseMetricText($(el).text().trim());
                });

                $('.icon-quote').parent().find('.icon-text').each((i, el) => {
                    metrics.quotes = parseMetricText($(el).text().trim());
                });

                if (metrics.likes > 0 || metrics.retweets > 0) {
                    console.log(`✅ Fetched metrics via Nitter (${instance}):`, metrics);
                    return metrics;
                }
            } catch (err) {
                console.log(`Failed with ${instance}, trying next...`);
                continue;
            }
        }

        throw new Error('All methods failed to fetch tweet metrics');

    } catch (error) {
        console.error(`❌ Failed to fetch metrics for tweet ${tweetId}:`, error.message);

        // Return zeros instead of failing completely
        return {
            likes: 0,
            retweets: 0,
            replies: 0,
            quotes: 0,
            bookmarks: 0,
            views: 0
        };
    }
}

/**
 * Extract metric from HTML content
 */
function extractMetricFromHTML(html, metricType) {
    try {
        // Look for patterns like "1,234 Likes" or "5.6K Retweets"
        const patterns = {
            like: /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*(?:Like|Favorite)/i,
            retweet: /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*Retweet/i,
            reply: /(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s*(?:Reply|Repl)/i
        };

        const match = html.match(patterns[metricType]);
        if (match && match[1]) {
            return parseMetricText(match[1]);
        }
        return 0;
    } catch (error) {
        return 0;
    }
}

/**
 * Parse metric text like "1.2K" or "500" to number
 */
function parseMetricText(text) {
    if (!text) return 0;

    text = text.toString().toLowerCase().replace(/,/g, '');

    if (text.includes('k')) {
        return Math.floor(parseFloat(text) * 1000);
    } else if (text.includes('m')) {
        return Math.floor(parseFloat(text) * 1000000);
    } else if (text.includes('b')) {
        return Math.floor(parseFloat(text) * 1000000000);
    }

    return parseInt(text) || 0;
}

/**
 * Extract tweet ID from URL
 */
function extractTweetId(url) {
    const match = url.match(/status\/(\d+)/);
    return match ? match[1] : url;
}

module.exports = {
    getTweetMetrics,
    extractTweetId
};
