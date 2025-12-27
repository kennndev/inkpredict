require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

// Contract ABI (only the functions we need)
const CONTRACT_ABI = [
    "function getUnresolvedExpiredMarkets() view returns (uint256[])",
    "function getMarket(uint256 marketId) view returns (tuple(uint256 id, string tweetId, uint256 targetMetric, string metricType, uint256 deadline, uint256 yesPool, uint256 noPool, bool resolved, bool outcome, uint256 createdAt))",
    "function resolve(uint256 marketId, bool outcome, uint256 finalMetric) external"
];

const CONTRACT_ADDRESS = process.env.VITE_CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const RPC_URL = process.env.VITE_INK_CHAIN_RPC || 'https://rpc-gel-sepolia.inkonchain.com';

// Twitter API credentials
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

/**
 * Fetch Twitter engagement metrics for a tweet
 */
async function getTwitterMetrics(tweetId, metricType) {
    try {
        const response = await axios.get(
            `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics`,
            {
                headers: {
                    'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
                }
            }
        );

        const metrics = response.data.data.public_metrics;

        // Map metric type to actual value
        const metricMap = {
            'like': metrics.like_count,
            'retweet': metrics.retweet_count,
            'reply': metrics.reply_count,
            'quote': metrics.quote_count,
            'view': metrics.impression_count || 0
        };

        return metricMap[metricType.toLowerCase()] || 0;
    } catch (error) {
        console.error(`Error fetching Twitter metrics for tweet ${tweetId}:`, error.message);
        throw error;
    }
}

/**
 * Main oracle resolver function
 */
async function resolveExpiredMarkets() {
    console.log('🔮 Oracle Resolver Starting...');
    console.log(`⏰ Time: ${new Date().toISOString()}`);

    // Setup provider and wallet
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

    console.log(`📡 Connected to: ${RPC_URL}`);
    console.log(`🔑 Oracle Address: ${wallet.address}`);
    console.log(`📝 Contract: ${CONTRACT_ADDRESS}`);

    try {
        // Get all unresolved expired markets
        const expiredMarketIds = await contract.getUnresolvedExpiredMarkets();

        if (expiredMarketIds.length === 0) {
            console.log('✅ No markets to resolve');
            return;
        }

        console.log(`\n📊 Found ${expiredMarketIds.length} market(s) to resolve:`);

        // Process each market
        for (const marketId of expiredMarketIds) {
            console.log(`\n--- Market #${marketId} ---`);

            try {
                // Get market details
                const market = await contract.getMarket(marketId);
                const tweetId = market.tweetId;
                const targetMetric = market.targetMetric.toNumber();
                const metricType = market.metricType;

                console.log(`Tweet ID: ${tweetId}`);
                console.log(`Target: ${targetMetric} ${metricType}s`);
                console.log(`Deadline: ${new Date(market.deadline.toNumber() * 1000).toISOString()}`);

                // Fetch actual Twitter metrics
                console.log('🐦 Fetching Twitter data...');
                const actualMetric = await getTwitterMetrics(tweetId, metricType);
                console.log(`Actual: ${actualMetric} ${metricType}s`);

                // Determine outcome
                const outcome = actualMetric >= targetMetric;
                console.log(`Result: ${outcome ? '✅ YES (Target Reached)' : '❌ NO (Target Not Reached)'}`);

                // Resolve on-chain
                console.log('⛓️  Submitting resolution to blockchain...');
                const tx = await contract.resolve(marketId, outcome, actualMetric);
                console.log(`TX Hash: ${tx.hash}`);

                const receipt = await tx.wait();
                console.log(`✅ Resolved! Gas Used: ${receipt.gasUsed.toString()}`);

            } catch (error) {
                console.error(`❌ Error resolving market #${marketId}:`, error.message);
                // Continue with next market
            }
        }

        console.log('\n🎉 Oracle resolution complete!');

    } catch (error) {
        console.error('❌ Fatal error:', error);
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    resolveExpiredMarkets()
        .then(() => {
            console.log('\n✅ Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Script failed:', error);
            process.exit(1);
        });
}

module.exports = { resolveExpiredMarkets };
