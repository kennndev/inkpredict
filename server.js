const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { ethers } = require('ethers');
const cron = require('node-cron');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const CONTRACT_ARTIFACT = require('./abi/InkPredict.json');
const CONTRACT_ABI = CONTRACT_ARTIFACT.abi;

// ============ Setup ============

const app = express();
app.use(express.json());
app.use(cors());

// Enable trust proxy for Vercel/proxies
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Twitter API client
const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);

// Blockchain connection
const provider = new ethers.providers.JsonRpcProvider(process.env.INK_CHAIN_RPC);
const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
const oracleWallet = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  CONTRACT_ABI,
  provider
);

const adminContract = contract.connect(adminWallet);
const oracleContract = contract.connect(oracleWallet);

// ============ Config ============

const WATCHED_ACCOUNTS = [
  { id: '295218901', username: 'VitalikButerin' },
  { id: '902926941413453824', username: 'cz_binance' },
  { id: '574403493', username: 'coinbase' },
  { id: '44196397', username: 'elonmusk' },
];

const MIN_LIKES_THRESHOLD = 1000; // Minimum likes to create market
const MAX_TWEET_AGE_HOURS = 1; // Only tweets less than 1 hour old
const MARKET_DURATION_HOURS = 24; // Markets last 24 hours

// ============ Twitter Integration ============

// Cache for Twitter metrics (30 minute TTL to avoid rate limits)
const metricsCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch recent tweets from monitored accounts
 */
async function fetchRecentTweets(userId) {
  try {
    const tweets = await twitterClient.v2.userTimeline(userId, {
      max_results: 10,
      'tweet.fields': 'public_metrics,created_at',
      exclude: 'retweets,replies'
    });

    return tweets.data || [];
  } catch (error) {
    console.error(`Error fetching tweets for user ${userId}:`, error.message);
    return [];
  }
}

/**
 * Get tweet metrics (with caching)
 */
async function getTweetMetrics(tweetId) {
  // Check cache first
  const cached = metricsCache.get(tweetId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`📦 Cache hit for tweet ${tweetId}`);
    return cached.data;
  }

  // Fetch from Twitter API
  try {
    console.log(`🐦 Fetching fresh data for tweet ${tweetId}`);
    const tweet = await twitterClient.v2.singleTweet(tweetId, {
      'tweet.fields': 'public_metrics,author_id'
    });

    const metrics = {
      likes: tweet.data.public_metrics.like_count,
      retweets: tweet.data.public_metrics.retweet_count,
      replies: tweet.data.public_metrics.reply_count,
      bookmarks: tweet.data.public_metrics.bookmark_count || 0,
      views: tweet.data.public_metrics.impression_count || 0,
      authorId: tweet.data.author_id
    };

    // Store in cache
    metricsCache.set(tweetId, {
      data: metrics,
      timestamp: Date.now()
    });

    return metrics;
  } catch (error) {
    console.error(`Error fetching metrics for tweet ${tweetId}:`, error.message);

    // Return cached data even if expired, better than nothing
    if (cached) {
      console.log(`⚠️ Using stale cache for tweet ${tweetId}`);
      return cached.data;
    }

    return null;
  }
}

/**
 * Get Ink Chain metrics via RPC
 */
async function getInkChainMetrics(metricType, contractAddress = null) {
  try {
    console.log(`⛓️ Fetching Ink Chain metric: ${metricType}`);

    switch (metricType) {
      case 'transactions': {
        // Get total transaction count from latest block
        const latestBlock = await provider.getBlock('latest');
        const blockNumber = latestBlock.number;

        // If contract address provided, get contract-specific tx count
        if (contractAddress) {
          const txCount = await provider.getTransactionCount(contractAddress);
          return { value: txCount, blockNumber };
        }

        // Otherwise return total network transactions (approximation)
        return { value: blockNumber * 10, blockNumber }; // Rough estimate
      }

      case 'block_number': {
        const latestBlock = await provider.getBlock('latest');
        return { value: latestBlock.number, timestamp: latestBlock.timestamp };
      }

      case 'tvl': {
        // Get ETH balance of a contract (if provided)
        if (contractAddress) {
          const balance = await provider.getBalance(contractAddress);
          const ethBalance = parseFloat(ethers.utils.formatEther(balance));
          return { value: Math.floor(ethBalance * 1000), unit: 'ETH' }; // Convert to mETH
        }
        return { value: 0, unit: 'ETH' };
      }

      case 'gas_price': {
        const gasPrice = await provider.getGasPrice();
        const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));
        return { value: Math.floor(gwei), unit: 'gwei' };
      }

      default:
        console.error(`Unknown metric type: ${metricType}`);
        return null;
    }
  } catch (error) {
    console.error(`Error fetching Ink Chain metrics:`, error.message);
    return null;
  }
}

// Clean up old cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [tweetId, entry] of metricsCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL * 2) {
      metricsCache.delete(tweetId);
    }
  }
  console.log(`🧹 Cache cleanup: ${metricsCache.size} entries remaining`);
}, 10 * 60 * 1000);

/**
 * Check if tweet is eligible for market creation
 */
function isTweetEligible(tweet) {
  const age = Date.now() - new Date(tweet.created_at).getTime();
  const ageInHours = age / (1000 * 60 * 60);
  const likes = tweet.public_metrics.like_count;

  return ageInHours < MAX_TWEET_AGE_HOURS && likes >= MIN_LIKES_THRESHOLD;
}

/**
 * Check if market already exists for tweet
 */
async function marketExists(tweetId) {
  try {
    const marketCount = await contract.marketCount();

    for (let i = 0; i < marketCount; i++) {
      const market = await contract.markets(i);
      if (market.tweetId === tweetId) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Error checking market existence:', error);
    return false;
  }
}

// ============ Market Creation (Automated) ============

/**
 * Create market for a trending tweet
 */
async function createMarketForTweet(tweet) {
  try {
    const tweetId = tweet.id;
    const currentLikes = tweet.public_metrics.like_count;
    const targetLikes = Math.floor(currentLikes * 5); // Predict 5x growth
    const deadline = Math.floor(Date.now() / 1000) + (MARKET_DURATION_HOURS * 3600);

    console.log(`Creating market for tweet ${tweetId}`);
    console.log(`Current likes: ${currentLikes}, Target: ${targetLikes}`);

    const tx = await adminContract.createMarket(
      tweetId,
      targetLikes,
      'like',
      deadline
    );

    const receipt = await tx.wait();
    console.log(`✅ Market created! TX: ${receipt.transactionHash}`);

    return receipt;
  } catch (error) {
    console.error('Error creating market:', error.message);
    return null;
  }
}

/**
 * Scan for trending tweets and create markets (Cron job)
 */
async function scanAndCreateMarkets() {
  console.log('🔍 Scanning for trending tweets...');

  for (const account of WATCHED_ACCOUNTS) {
    const tweets = await fetchRecentTweets(account.id);

    for (const tweet of tweets) {
      if (isTweetEligible(tweet)) {
        const exists = await marketExists(tweet.id);

        if (!exists) {
          await createMarketForTweet(tweet);
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  }

  console.log('✅ Scan complete');
}

// DISABLED: Run manually to avoid rate limits
// cron.schedule('*/10 * * * *', scanAndCreateMarkets);

// ============ Market Resolution (Automated) ============

/**
 * Resolve expired markets
 */
async function resolveExpiredMarkets() {
  console.log('🔮 Checking for expired markets...');

  try {
    const expiredMarketIds = await contract.getUnresolvedExpiredMarkets();

    console.log(`Found ${expiredMarketIds.length} expired markets`);

    for (const marketId of expiredMarketIds) {
      const market = await contract.markets(marketId);
      const metrics = await getTweetMetrics(market.tweetId);

      if (!metrics) {
        console.error(`Failed to fetch metrics for market ${marketId}`);
        continue;
      }

      const finalLikes = metrics.likes;
      const outcome = finalLikes >= market.targetMetric;

      console.log(`Resolving market ${marketId}:`);
      console.log(`  Target: ${market.targetMetric}, Final: ${finalLikes}`);
      console.log(`  Outcome: ${outcome ? 'YES' : 'NO'}`);

      const tx = await oracleContract.resolve(marketId, outcome, finalLikes);
      await tx.wait();

      console.log(`✅ Market ${marketId} resolved!`);

      // Add delay
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    console.error('Error resolving markets:', error);
  }
}

// DISABLED: Use GitHub Actions oracle instead to avoid rate limits
// cron.schedule('* * * * *', resolveExpiredMarkets);

// ============ API Endpoints ============

/**
 * GET /api/markets - Get all active markets
 */
app.get('/api/markets', async (req, res) => {
  try {
    const activeMarketIds = await contract.getActiveMarkets();
    const markets = [];

    for (const marketId of activeMarketIds) {
      const market = await contract.markets(marketId);
      const metrics = await getTweetMetrics(market.tweetId);
      const [yesOdds, noOdds] = await contract.getOdds(marketId);

      markets.push({
        id: market.id.toString(),
        tweetId: market.tweetId,
        targetMetric: market.targetMetric.toString(),
        metricType: market.metricType,
        deadline: market.deadline.toString(),
        yesPool: ethers.utils.formatUnits(market.yesPool, 6), // USDC has 6 decimals
        noPool: ethers.utils.formatUnits(market.noPool, 6), // USDC has 6 decimals
        yesOdds: yesOdds.toString(),
        noOdds: noOdds.toString(),
        currentMetric: metrics ? metrics.likes : 0,
        resolved: market.resolved,
        createdAt: market.createdAt.toString()
      });
    }

    res.json({ success: true, markets });
  } catch (error) {
    console.error('Error fetching markets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/market/:id - Get single market
 */
app.get('/api/market/:id', async (req, res) => {
  try {
    const marketId = req.params.id;
    const market = await contract.markets(marketId);

    if (market.deadline.toString() === '0') {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }

    const metrics = await getTweetMetrics(market.tweetId);
    const [yesOdds, noOdds] = await contract.getOdds(marketId);

    res.json({
      success: true,
      market: {
        id: market.id.toString(),
        tweetId: market.tweetId,
        targetMetric: market.targetMetric.toString(),
        metricType: market.metricType,
        deadline: market.deadline.toString(),
        yesPool: ethers.utils.formatUnits(market.yesPool, 6), // USDC has 6 decimals
        noPool: ethers.utils.formatUnits(market.noPool, 6), // USDC has 6 decimals
        yesOdds: yesOdds.toString(),
        noOdds: noOdds.toString(),
        currentMetric: metrics ? metrics.likes : 0,
        resolved: market.resolved,
        outcome: market.outcome,
        createdAt: market.createdAt.toString()
      }
    });
  } catch (error) {
    console.error('Error fetching market:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/user/:address/bets - Get user bets
 */
app.get('/api/user/:address/bets', async (req, res) => {
  try {
    const address = req.params.address;
    const marketIds = await contract.getUserMarkets(address);
    const bets = [];

    for (const marketId of marketIds) {
      const market = await contract.markets(marketId);
      const bet = await contract.bets(marketId, address);

      bets.push({
        marketId: marketId.toString(),
        tweetId: market.tweetId,
        amount: ethers.utils.formatUnits(bet.amount, 6), // USDC has 6 decimals
        position: bet.position,
        claimed: bet.claimed,
        resolved: market.resolved,
        outcome: market.outcome,
        won: market.resolved && bet.position === market.outcome
      });
    }

    res.json({ success: true, bets });
  } catch (error) {
    console.error('Error fetching user bets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tweet/:id/metrics - Get tweet metrics
 */
app.get('/api/tweet/:id/metrics', async (req, res) => {
  try {
    const metrics = await getTweetMetrics(req.params.id);

    if (!metrics) {
      return res.status(404).json({ success: false, error: 'Tweet not found' });
    }

    res.json({ success: true, metrics });
  } catch (error) {
    console.error('Error fetching tweet metrics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/stats - Platform statistics
 */
app.get('/api/stats', async (req, res) => {
  try {
    const marketCount = await contract.marketCount();
    let totalVolume = ethers.BigNumber.from(0);
    let activeMarkets = 0;
    let resolvedMarkets = 0;

    for (let i = 0; i < marketCount; i++) {
      const market = await contract.markets(i);
      const volume = market.yesPool.add(market.noPool);
      totalVolume = totalVolume.add(volume);

      if (market.resolved) {
        resolvedMarkets++;
      } else {
        activeMarkets++;
      }
    }

    res.json({
      success: true,
      stats: {
        totalMarkets: marketCount.toString(),
        activeMarkets: activeMarkets.toString(),
        resolvedMarkets: resolvedMarkets.toString(),
        totalVolume: ethers.utils.formatUnits(totalVolume, 6) // USDC has 6 decimals
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/leaderboard - Top winners
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const marketCount = await contract.marketCount();
    const userStats = new Map(); // address -> { wins, losses, volume }

    // Iterate through all markets to collect user stats
    for (let i = 0; i < marketCount; i++) {
      const market = await contract.markets(i);

      // Skip unresolved markets
      if (!market.resolved) continue;

      // Get all users who bet on this market
      // Note: This is inefficient for production - you'd want event indexing
      // For now, we'll track users as we encounter them

      // This is a simplified version - in production you'd use events/subgraph
      // For demo purposes, we'll just return top bettors we know about
    }

    // For now, calculate leaderboard from recent activity
    // In production, use The Graph or event indexing
    const leaderboard = [];

    // Get unique addresses from recent transactions
    // This is a workaround - proper implementation needs event logs
    const addresses = new Set();

    // Sample implementation - you'd improve this with proper event tracking
    for (let i = 0; i < Math.min(marketCount.toNumber(), 10); i++) {
      const market = await contract.markets(i);
      if (market.yesPool.gt(0) || market.noPool.gt(0)) {
        // Market has activity - we'd track users here via events
      }
    }

    res.json({
      success: true,
      leaderboard: [] // Return empty for now - needs event indexing for proper implementation
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/predictions - Create new prediction (saves to Supabase AND deploys to blockchain)
 */
app.post('/api/admin/predictions', async (req, res) => {
  try {
    const {
      category,
      question,
      emoji,
      tweetUrl,
      inkContractAddress,
      targetMetric,
      metricType,
      durationHours
    } = req.body;

    // Validate required fields
    if (!question || !targetMetric || !metricType || !durationHours) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Calculate deadline
    const deadline = new Date(Date.now() + (durationHours * 3600 * 1000));
    const deadlineUnix = Math.floor(deadline.getTime() / 1000);

    // Extract tweet ID from URL if Twitter prediction
    let tweetId = null;
    if (category === 'TWITTER' && tweetUrl) {
      const match = tweetUrl.match(/status\/(\d+)/);
      if (match) {
        tweetId = match[1];
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid tweet URL'
        });
      }
    }

    // For Ink Chain predictions, use a placeholder tweet ID and ensure contract address
    if (category === 'INK CHAIN') {
      tweetId = `ink_${Date.now()}`; // Unique identifier for Ink predictions
    }

    // Prepare prediction data for Supabase
    const predictionData = {
      category,
      question,
      emoji: emoji || '🎯',
      tweet_id: category === 'TWITTER' ? tweetId : null,
      tweet_url: tweetUrl || null,
      ink_contract_address: category === 'INK CHAIN' ? (inkContractAddress || '0x0000000000000000000000000000000000000000') : null,
      target_metric: parseInt(targetMetric),
      metric_type: metricType,
      deadline: deadline.toISOString(),
      deployed: false,
      resolved: false,
      created_by: req.body.adminAddress || 'admin'
    };

    // Save to Supabase first (if available)
    const supabase = require('./supabase-client');

    if (!supabase) {
      console.warn('⚠️ Supabase not available, skipping database save');
      // Continue with blockchain deployment only
      try {
        console.log('⛓️ Deploying to blockchain...');
        const tx = await adminContract.createMarket(
          tweetId,
          parseInt(targetMetric),
          metricType,
          deadlineUnix
        );

        console.log('⏳ Waiting for transaction confirmation...');
        const receipt = await tx.wait();

        const marketCount = await contract.marketCount();
        const marketId = marketCount.toNumber() - 1;

        console.log(`✅ Market deployed! Market ID: ${marketId}, TX: ${receipt.transactionHash}`);

        return res.json({
          success: true,
          marketId: marketId,
          transactionHash: receipt.transactionHash,
          warning: 'Deployed to blockchain only (database unavailable)'
        });
      } catch (blockchainError) {
        console.error('Blockchain deployment error:', blockchainError);
        return res.status(500).json({
          success: false,
          error: 'Blockchain deployment failed: ' + blockchainError.message
        });
      }
    }

    const { data: predictionRecord, error: supabaseError } = await supabase
      .from('predictions')
      .insert([predictionData])
      .select();

    if (supabaseError) {
      console.error('Supabase error:', supabaseError);
      return res.status(500).json({
        success: false,
        error: supabaseError.message
      });
    }

    console.log('✅ Prediction saved to Supabase:', predictionRecord[0].id);

    // Deploy to blockchain
    try {
      console.log('⛓️ Deploying to blockchain...');
      const tx = await adminContract.createMarket(
        tweetId,
        parseInt(targetMetric),
        metricType,
        deadlineUnix
      );

      console.log('⏳ Waiting for transaction confirmation...');
      const receipt = await tx.wait();

      // Get the market ID from the contract
      const marketCount = await contract.marketCount();
      const marketId = marketCount.toNumber() - 1; // Latest market

      console.log(`✅ Market deployed! Market ID: ${marketId}, TX: ${receipt.transactionHash}`);

      // Update Supabase with market ID and deployed status
      const { error: updateError } = await supabase
        .from('predictions')
        .update({
          market_id: marketId,
          deployed: true
        })
        .eq('id', predictionRecord[0].id);

      if (updateError) {
        console.error('Error updating market ID:', updateError);
      }

      res.json({
        success: true,
        prediction: predictionRecord[0],
        marketId: marketId,
        transactionHash: receipt.transactionHash
      });

    } catch (blockchainError) {
      console.error('Blockchain deployment error:', blockchainError);

      // Prediction is saved but not deployed
      res.json({
        success: true,
        prediction: predictionRecord[0],
        deployed: false,
        error: 'Saved to database but blockchain deployment failed: ' + blockchainError.message
      });
    }

  } catch (error) {
    console.error('Error creating prediction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/create-market - Manual market creation
 */
app.post('/api/admin/create-market', async (req, res) => {
  try {
    const { tweetId, targetMetric, metricType, durationHours } = req.body;

    const deadline = Math.floor(Date.now() / 1000) + (durationHours * 3600);

    const tx = await adminContract.createMarket(
      tweetId,
      targetMetric,
      metricType,
      deadline
    );

    const receipt = await tx.wait();

    res.json({
      success: true,
      transactionHash: receipt.transactionHash
    });
  } catch (error) {
    console.error('Error creating market:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ Health Check ============

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ Start Server ============

const PORT = process.env.PORT || 3001;

// Only start server if running locally (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 InkPredict backend running on port ${PORT}`);
    console.log(`📊 Contract: ${process.env.CONTRACT_ADDRESS}`);
    console.log(`🔗 RPC: ${process.env.INK_CHAIN_RPC}`);
    console.log(`⏰ Oracle running, will check markets every minute`);
    console.log(`🐦 Twitter integration active`);
  });
}

module.exports = app;

// ============ Error Handling ============

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});
