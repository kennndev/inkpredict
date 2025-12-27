const axios = require('axios');

// Sample market data
const inkChainMarkets = [
    {
        tweetId: '1738901234567890001',
        targetMetric: 5000,
        metricType: 'like',
        durationHours: 24,
        description: 'Will Ink Chain announcement reach 5K likes?'
    },
    {
        tweetId: '1738901234567890002',
        targetMetric: 10000,
        metricType: 'like',
        durationHours: 48,
        description: 'Will Ink Sepolia testnet launch tweet hit 10K likes?'
    },
    {
        tweetId: '1738901234567890003',
        targetMetric: 3000,
        metricType: 'retweet',
        durationHours: 24,
        description: 'Will Ink Chain partnership announcement get 3K retweets?'
    },
    {
        tweetId: '1738901234567890004',
        targetMetric: 15000,
        metricType: 'like',
        durationHours: 72,
        description: 'Will Ink Chain mainnet launch reach 15K likes?'
    },
    {
        tweetId: '1738901234567890005',
        targetMetric: 50000,
        metricType: 'view',
        durationHours: 24,
        description: 'Will Ink Chain demo video hit 50K views?'
    }
];

const xMarkets = [
    {
        tweetId: '1738901234567890006',
        targetMetric: 20000,
        metricType: 'like',
        durationHours: 24,
        description: 'Will Elon Musk crypto tweet reach 20K likes?'
    },
    {
        tweetId: '1738901234567890007',
        targetMetric: 8000,
        metricType: 'like',
        durationHours: 12,
        description: 'Will Vitalik Buterin latest post hit 8K likes?'
    },
    {
        tweetId: '1738901234567890008',
        targetMetric: 5000,
        metricType: 'retweet',
        durationHours: 24,
        description: 'Will CZ Binance announcement get 5K retweets?'
    },
    {
        tweetId: '1738901234567890009',
        targetMetric: 12000,
        metricType: 'like',
        durationHours: 36,
        description: 'Will Coinbase product launch reach 12K likes?'
    }
];

async function createMarket(market) {
    try {
        const response = await axios.post('http://localhost:3001/api/admin/create-market', market);
        console.log(`✅ Created market: ${market.description}`);
        console.log(`   TX Hash: ${response.data.transactionHash}`);
        return response.data;
    } catch (error) {
        console.error(`❌ Failed to create market: ${market.description}`);
        console.error(`   Error: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

async function createAllMarkets() {
    console.log('🚀 Creating Ink Chain related markets...\n');

    for (const market of inkChainMarkets) {
        await createMarket(market);
        // Wait 3 seconds between markets to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log('\n🐦 Creating X (Twitter) related markets...\n');

    for (const market of xMarkets) {
        await createMarket(market);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log('\n🎉 All markets created!');
    console.log('📊 Visit http://localhost:5173 to see the markets');
}

// Run the script
createAllMarkets()
    .then(() => {
        console.log('\n✅ Market creation complete!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Error creating markets:', error);
        process.exit(1);
    });
