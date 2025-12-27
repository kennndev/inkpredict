const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

// Initialize Twitter client
const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);

// Famous crypto accounts to monitor
const CRYPTO_ACCOUNTS = [
    { id: '295218901', username: 'VitalikButerin', name: 'Vitalik Buterin' },
    { id: '902926941413453824', username: 'cz_binance', name: 'CZ Binance' },
    { id: '574403493', username: 'coinbase', name: 'Coinbase' },
    { id: '357312062', username: 'SBF_FTX', name: 'SBF' },
    { id: '2312333412', username: 'elonmusk', name: 'Elon Musk' },
];

// Fetch recent tweets from an account
async function fetchRecentTweets(userId, maxResults = 5) {
    try {
        const tweets = await twitterClient.v2.userTimeline(userId, {
            max_results: maxResults,
            'tweet.fields': 'public_metrics,created_at,author_id',
            exclude: 'retweets,replies'
        });

        return tweets.data || [];
    } catch (error) {
        console.error(`Error fetching tweets for user ${userId}:`, error.message);
        return [];
    }
}

// Calculate target based on current metrics
function calculateTarget(currentLikes) {
    if (currentLikes < 1000) return Math.ceil(currentLikes * 3); // 3x for small tweets
    if (currentLikes < 5000) return Math.ceil(currentLikes * 2); // 2x for medium tweets
    return Math.ceil(currentLikes * 1.5); // 1.5x for popular tweets
}

// Create market via backend API
async function createMarket(tweetId, targetMetric, metricType, durationHours, description) {
    try {
        const response = await axios.post('http://localhost:3001/api/admin/create-market', {
            tweetId,
            targetMetric,
            metricType,
            durationHours
        });

        console.log(`✅ Created: ${description}`);
        console.log(`   Tweet ID: ${tweetId}`);
        console.log(`   Target: ${targetMetric} ${metricType}s`);
        console.log(`   TX: ${response.data.transactionHash}\n`);

        return response.data;
    } catch (error) {
        console.error(`❌ Failed to create market for tweet ${tweetId}`);
        console.error(`   Error: ${error.response?.data?.error || error.message}\n`);
        return null;
    }
}

// Main function to auto-create markets
async function autoCreateMarkets() {
    console.log('🤖 Starting automated market creation...\n');
    console.log('📡 Fetching recent tweets from famous crypto accounts...\n');

    let marketsCreated = 0;
    const targetMarketsCount = 9; // Create 9 markets total

    for (const account of CRYPTO_ACCOUNTS) {
        if (marketsCreated >= targetMarketsCount) break;

        console.log(`🔍 Checking @${account.username} (${account.name})...`);

        const tweets = await fetchRecentTweets(account.id, 3);

        for (const tweet of tweets) {
            if (marketsCreated >= targetMarketsCount) break;

            const currentLikes = tweet.public_metrics.like_count;
            const tweetAge = Date.now() - new Date(tweet.created_at).getTime();
            const ageInHours = tweetAge / (1000 * 60 * 60);

            // Only create markets for tweets less than 12 hours old with some engagement
            if (ageInHours < 12 && currentLikes > 100) {
                const targetLikes = calculateTarget(currentLikes);
                const description = `Will @${account.username}'s tweet reach ${(targetLikes / 1000).toFixed(1)}K likes?`;

                await createMarket(
                    tweet.id,
                    targetLikes,
                    'like',
                    24, // 24 hour duration
                    description
                );

                marketsCreated++;

                // Wait 3 seconds between market creations
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }

    console.log(`\n🎉 Automated market creation complete!`);
    console.log(`📊 Created ${marketsCreated} markets`);
    console.log(`🌐 Visit http://localhost:5173 to see them!\n`);
}

// Run the automation
autoCreateMarkets()
    .then(() => {
        console.log('✅ Automation finished successfully!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Automation failed:', error);
        process.exit(1);
    });
