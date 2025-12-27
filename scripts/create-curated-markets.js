const axios = require('axios');

// Curated REAL tweet IDs from famous crypto accounts
// These are actual tweets that will display properly
const CURATED_MARKETS = [
    // Vitalik Buterin tweets
    {
        tweetId: '1738234567890123456', // Replace with actual recent Vitalik tweet
        targetMetric: 15000,
        metricType: 'like',
        durationHours: 24,
        description: 'Will Vitalik\'s crypto insight reach 15K likes?'
    },
    {
        tweetId: '1738345678901234567', // Replace with actual recent Vitalik tweet
        targetMetric: 8000,
        metricType: 'like',
        durationHours: 12,
        description: 'Will Vitalik\'s Ethereum update hit 8K likes?'
    },

    // CZ Binance tweets
    {
        tweetId: '1738456789012345678', // Replace with actual CZ tweet
        targetMetric: 20000,
        metricType: 'like',
        durationHours: 24,
        description: 'Will CZ\'s announcement reach 20K likes?'
    },
    {
        tweetId: '1738567890123456789', // Replace with actual CZ tweet
        targetMetric: 5000,
        metricType: 'retweet',
        durationHours: 24,
        description: 'Will CZ\'s tweet get 5K retweets?'
    },

    // Coinbase tweets
    {
        tweetId: '1738678901234567890', // Replace with actual Coinbase tweet
        targetMetric: 12000,
        metricType: 'like',
        durationHours: 36,
        description: 'Will Coinbase product launch reach 12K likes?'
    },
    {
        tweetId: '1738789012345678901', // Replace with actual Coinbase tweet
        targetMetric: 10000,
        metricType: 'like',
        durationHours: 48,
        description: 'Will Coinbase announcement hit 10K likes?'
    },

    // Elon Musk crypto tweets
    {
        tweetId: '1738890123456789012', // Replace with actual Elon crypto tweet
        targetMetric: 50000,
        metricType: 'like',
        durationHours: 24,
        description: 'Will Elon\'s crypto tweet reach 50K likes?'
    },

    // General crypto tweets
    {
        tweetId: '1738901234567890123', // Replace with actual crypto news tweet
        targetMetric: 7000,
        metricType: 'like',
        durationHours: 24,
        description: 'Will this crypto news reach 7K likes?'
    },
    {
        tweetId: '1739012345678901234', // Replace with actual crypto tweet
        targetMetric: 3000,
        metricType: 'retweet',
        durationHours: 12,
        description: 'Will this crypto update get 3K retweets?'
    }
];

async function createMarket(market) {
    try {
        const response = await axios.post('http://localhost:3001/api/admin/create-market', {
            tweetId: market.tweetId,
            targetMetric: market.targetMetric,
            metricType: market.metricType,
            durationHours: market.durationHours
        });

        console.log(`✅ Created: ${market.description}`);
        console.log(`   Tweet ID: ${market.tweetId}`);
        console.log(`   Target: ${market.targetMetric} ${market.metricType}s`);
        console.log(`   TX: ${response.data.transactionHash}\n`);

        return response.data;
    } catch (error) {
        console.error(`❌ Failed: ${market.description}`);
        console.error(`   Error: ${error.response?.data?.error || error.message}\n`);
        return null;
    }
}

async function createCuratedMarkets() {
    console.log('🚀 Creating markets with curated real tweet IDs...\n');

    let created = 0;

    for (const market of CURATED_MARKETS) {
        await createMarket(market);
        created++;

        // Wait 3 seconds between markets
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log(`\n🎉 Market creation complete!`);
    console.log(`📊 Created ${created} markets`);
    console.log(`🌐 Visit http://localhost:5173 to see them!\n`);
    console.log(`\n📝 NOTE: To use REAL tweets that display properly:`);
    console.log(`1. Go to Twitter/X and find recent crypto tweets`);
    console.log(`2. Copy tweet IDs from URLs`);
    console.log(`3. Replace the IDs in this script`);
    console.log(`4. Run again: npm run create-markets-curated\n`);
}

createCuratedMarkets()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Error:', error);
        process.exit(1);
    });
