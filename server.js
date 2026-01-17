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
const provider = new ethers.providers.JsonRpcProvider(process.env.INK_CHAIN_RPC, {
  chainId: 763373,
  name: 'ink-sepolia'
});
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

// Cache for tweet metrics (10 minute TTL)
const metricsCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

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
  // Skip Twitter fetching for Ink Chain predictions
  if (tweetId.startsWith('ink_')) {
    console.log(`⛓️ Ink Chain prediction detected (${tweetId}), skipping Twitter metrics`);
    return {
      likes: 0,
      retweets: 0,
      replies: 0,
      bookmarks: 0,
      views: 0,
      authorId: 'ink-chain'
    };
  }

  // Check cache first
  const cached = metricsCache.get(tweetId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`📦 Cache hit for tweet ${tweetId}`);
    return cached.data;
  }

  // Try Twitter scraper first (no API limits)
  try {
    const { scrapeTweetMetrics } = require('./twitter-scraper');
    console.log(`🌐 Scraping tweet ${tweetId}...`);
    const metrics = await scrapeTweetMetrics(tweetId);

    // Store in cache
    metricsCache.set(tweetId, {
      data: metrics,
      timestamp: Date.now()
    });

    return metrics;
  } catch (scraperError) {
    console.log(`Scraper failed for ${tweetId}, trying Twitter API...`);
  }

  // Fallback to Twitter API
  try {
    console.log(`🐦 Fetching from Twitter API for tweet ${tweetId}`);
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
    console.error(`❌ Both scraper and API failed for tweet ${tweetId}:`, error.message);

    // Return cached data even if expired, better than nothing
    if (cached) {
      console.log(`⚠️ Using stale cache for tweet ${tweetId}`);
      return cached.data;
    }

    // Return null - let the caller handle it
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
        return { value: blockNumber * 10, blockNumber };
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
          return { value: Math.floor(ethBalance * 1000), unit: 'ETH' };
        }
        return { value: 0, unit: 'ETH' };
      }

      case 'gas_price': {
        const gasPrice = await provider.getGasPrice();
        const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));
        return { value: Math.floor(gwei), unit: 'gwei' };
      }

      case 'active_wallets': {
        // Count unique addresses that have sent transactions in recent blocks
        // This is an approximation - we check the last 100 blocks for unique "from" addresses
        try {
          const latestBlock = await provider.getBlock('latest');
          const blockNumber = latestBlock.number;
          const uniqueAddresses = new Set();

          // Check last 100 blocks (or fewer if chain is shorter)
          const startBlock = Math.max(0, blockNumber - 100);
          const blocksToCheck = Math.min(100, blockNumber + 1);

          console.log(`Checking ${blocksToCheck} blocks (${startBlock} to ${blockNumber}) for active wallets...`);

          // Process blocks in batches to avoid overwhelming the RPC
          const batchSize = 10;
          for (let i = startBlock; i <= blockNumber; i += batchSize) {
            const endBlock = Math.min(i + batchSize - 1, blockNumber);
            const promises = [];

            for (let blockNum = i; blockNum <= endBlock; blockNum++) {
              promises.push(provider.getBlockWithTransactions(blockNum));
            }

            const blocks = await Promise.all(promises);

            for (const block of blocks) {
              if (block && block.transactions) {
                for (const tx of block.transactions) {
                  if (tx.from) {
                    uniqueAddresses.add(tx.from.toLowerCase());
                  }
                }
              }
            }

            // Small delay to avoid rate limiting
            if (i + batchSize <= blockNumber) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }

          const count = uniqueAddresses.size;
          console.log(`Found ${count} unique active wallet addresses in recent blocks`);
          return { value: count, blockRange: `${startBlock}-${blockNumber}` };
        } catch (error) {
          console.error(`Error counting active wallets:`, error.message);
          // Fallback: return a rough estimate based on block number
          const latestBlock = await provider.getBlock('latest');
          return { value: Math.floor(latestBlock.number / 10), note: 'Estimated (fallback)' };
        }
      }

      default:
        // Check if it's a Twitter metric being used for Ink Chain prediction
        const twitterMetrics = ['like', 'likes', 'retweet', 'retweets', 'reply', 'replies', 'view', 'views', 'bookmark', 'bookmarks'];
        if (twitterMetrics.includes(metricType.toLowerCase())) {
          console.error(`⚠️ Twitter metric type "${metricType}" used for Ink Chain prediction. Ink Chain metrics: transactions, block_number, tvl, gas_price, active_wallets`);
          return null;
        }
        console.error(`Unknown metric type: ${metricType}. Supported Ink Chain metrics: transactions, block_number, tvl, gas_price, active_wallets`);
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
 * Update Supabase database after market resolution
 * This function updates predictions, user_bets, and user_stats tables
 */
async function updateSupabaseAfterResolution(marketId, outcome, actualMetric, market) {
  const supabase = require('./supabase-client');
  if (!supabase) {
    console.log('⚠️ Supabase not configured, skipping database update');
    return;
  }

  try {
    // Update prediction
    await supabase
      .from('predictions')
      .update({
        resolved: true,
        outcome: outcome,
        final_metric: actualMetric
      })
      .eq('market_id', marketId);
    console.log('✅ Updated Supabase prediction');

    // Update all bets for this market
    const { data: bets } = await supabase
      .from('user_bets')
      .select('*')
      .eq('market_id', marketId);

    if (bets && bets.length > 0) {
      console.log(`📊 Updating ${bets.length} bets for market ${marketId}...`);

      const totalPool = market.yesPool.add(market.noPool);
      const winningPool = outcome ? market.yesPool : market.noPool;

      // Update each bet with outcome and payout
      for (const bet of bets) {
        const won = bet.position === outcome;
        let payout = 0;

        if (won && winningPool.gt(0)) {
          // Calculate proportional payout
          const betAmountWei = ethers.utils.parseUnits(bet.amount.toString(), 6);
          const share = betAmountWei.mul(ethers.BigNumber.from(10000)).div(winningPool);
          const winnings = totalPool.mul(share).div(10000);

          // Apply 2% platform fee
          const fee = winnings.mul(2).div(100);
          const netWinnings = winnings.sub(fee);

          payout = parseFloat(ethers.utils.formatUnits(netWinnings, 6));
        }

        await supabase
          .from('user_bets')
          .update({ won, payout })
          .eq('id', bet.id);
      }

      // Update user stats for all affected users
      const uniqueUsers = [...new Set(bets.map(b => b.user_address))];
      for (const userAddress of uniqueUsers) {
        const { data: userBets } = await supabase
          .from('user_bets')
          .select('*')
          .eq('user_address', userAddress);

        if (userBets && userBets.length > 0) {
          const totalBets = userBets.length;
          const totalWins = userBets.filter(b => b.won === true).length;
          const totalLosses = userBets.filter(b => b.won === false).length;
          const totalVolume = userBets.reduce((sum, b) => sum + parseFloat(b.amount || 0), 0);
          const totalWinnings = userBets.reduce((sum, b) => sum + parseFloat(b.payout || 0), 0);
          const winRate = totalBets > 0 ? (totalWins / totalBets) * 100 : 0;
          const lastBetAt = userBets.length > 0 ? userBets[userBets.length - 1].created_at : null;

          await supabase
            .from('user_stats')
            .upsert({
              user_address: userAddress,
              total_bets: totalBets,
              total_wins: totalWins,
              total_losses: totalLosses,
              total_volume: totalVolume,
              total_winnings: totalWinnings,
              win_rate: winRate,
              last_bet_at: lastBetAt,
              updated_at: new Date().toISOString()
            }, { onConflict: 'user_address' });
        }
      }

      console.log(`✅ Updated ${bets.length} bets and ${uniqueUsers.length} user stats`);
    }
  } catch (dbError) {
    console.warn('⚠️ Failed to update Supabase:', dbError.message);
    throw dbError;
  }
}

/**
 * Resolve expired markets
 */
async function resolveExpiredMarkets() {
  console.log('🔮 Checking for expired markets...');

  try {
    const expiredMarketIds = await contract.getUnresolvedExpiredMarkets();

    console.log(`Found ${expiredMarketIds.length} expired markets`);

    if (expiredMarketIds.length === 0) {
      console.log('✅ No expired markets to resolve');
      return { resolved: 0, errors: [] };
    }

    let resolvedCount = 0;
    const errors = [];

    for (const marketId of expiredMarketIds) {
      try {
        const market = await contract.markets(marketId);
        const tweetId = market.tweetId;
        const targetMetric = market.targetMetric.toNumber();
        const metricType = market.metricType;

        console.log(`\n--- Resolving Market #${marketId} ---`);
        console.log(`Tweet ID: ${tweetId}`);
        console.log(`Target: ${targetMetric} ${metricType}s`);

        let actualMetric = 0;

        // Handle Ink Chain predictions
        if (tweetId.startsWith('ink_')) {
          console.log('⛓️ Fetching Ink Chain metrics...');
          const inkMetrics = await getInkChainMetrics(metricType, market.inkContractAddress || null);
          if (inkMetrics && inkMetrics.value !== undefined) {
            actualMetric = typeof inkMetrics.value === 'number' ? inkMetrics.value : parseInt(inkMetrics.value);
          } else {
            console.error(`Failed to fetch Ink Chain metrics for market ${marketId}`);
            errors.push({ marketId, error: 'Failed to fetch Ink Chain metrics' });
            continue;
          }
        } else {
          // Handle Twitter predictions
          console.log('🐦 Fetching Twitter metrics...');
          const metrics = await getTweetMetrics(tweetId);

          if (!metrics) {
            console.error(`Failed to fetch metrics for market ${marketId}`);
            errors.push({ marketId, error: 'Failed to fetch tweet metrics' });
            continue;
          }

          // Map metric type to actual value
          const metricMap = {
            'like': metrics.likes,
            'retweet': metrics.retweets,
            'reply': metrics.replies,
            'view': metrics.views,
            'bookmark': metrics.bookmarks || 0
          };

          actualMetric = metricMap[metricType.toLowerCase()] || 0;
        }

        const outcome = actualMetric >= targetMetric;

        console.log(`Actual: ${actualMetric} ${metricType}s`);
        console.log(`Outcome: ${outcome ? '✅ YES (Target Reached)' : '❌ NO (Target Not Reached)'}`);

        // Resolve on-chain
        console.log('⛓️ Submitting resolution to blockchain...');
        const tx = await oracleContract.resolve(marketId, outcome, actualMetric);
        console.log(`TX Hash: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✅ Market ${marketId} resolved! Gas Used: ${receipt.gasUsed.toString()}`);

        // Update Supabase
        try {
          await updateSupabaseAfterResolution(marketId, outcome, actualMetric, market);
        } catch (dbError) {
          console.warn('⚠️ Failed to update Supabase:', dbError.message);
        }

        resolvedCount++;

        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`❌ Error resolving market ${marketId}:`, error.message);
        errors.push({ marketId, error: error.message });
      }
    }

    console.log(`\n🎉 Resolution complete! Resolved: ${resolvedCount}, Errors: ${errors.length}`);
    return { resolved: resolvedCount, errors };
  } catch (error) {
    console.error('Error resolving markets:', error);
    throw error;
  }
}

// Auto-resolution cron job (configurable via environment variables)
const ENABLE_AUTO_RESOLVE = process.env.ENABLE_AUTO_RESOLVE === 'true';
const AUTO_RESOLVE_INTERVAL = process.env.AUTO_RESOLVE_INTERVAL_MINUTES || 5;

if (ENABLE_AUTO_RESOLVE) {
  // Run every X minutes (default: 5 minutes)
  const cronExpression = `*/${AUTO_RESOLVE_INTERVAL} * * * *`;
  cron.schedule(cronExpression, resolveExpiredMarkets);
  console.log(`✅ Auto-resolution enabled: Running every ${AUTO_RESOLVE_INTERVAL} minute(s)`);
} else {
  console.log('⏸️  Auto-resolution disabled (set ENABLE_AUTO_RESOLVE=true to enable)');
}

// ============ API Endpoints ============

/**
 * POST /api/oracle/resolve - Trigger automatic resolution of expired markets
 * Protected by CRON_SECRET environment variable or Vercel cron header
 */
app.post('/api/oracle/resolve', async (req, res) => {
  try {

    const isVercelCron = req.headers['x-vercel-cron'] === '1';

    const cronSecret = req.headers['authorization']?.replace('Bearer ', '') || req.query.secret;
    const expectedSecret = process.env.CRON_SECRET;

    if (!isVercelCron && expectedSecret && cronSecret !== expectedSecret) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Missing or invalid cron secret'
      });
    }

    console.log('🔮 Oracle resolution triggered via API');
    const result = await resolveExpiredMarkets();

    res.json({
      success: true,
      resolved: result.resolved,
      errors: result.errors,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in oracle resolution endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/oracle/resolve - Also support GET for easier cron configuration
 */
app.get('/api/oracle/resolve', async (req, res) => {
  try {
    // Verify authentication
    // Option 1: Check for Vercel cron header (automatically added by Vercel)
    const isVercelCron = req.headers['x-vercel-cron'] === '1';

    // Option 2: Check for custom CRON_SECRET
    const cronSecret = req.query.secret;
    const expectedSecret = process.env.CRON_SECRET;

    // Allow if: Vercel cron OR no secret required OR secret matches
    if (!isVercelCron && expectedSecret && cronSecret !== expectedSecret) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Missing or invalid cron secret'
      });
    }

    console.log('🔮 Oracle resolution triggered via API (GET)');
    const result = await resolveExpiredMarkets();

    res.json({
      success: true,
      resolved: result.resolved,
      errors: result.errors,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in oracle resolution endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cron-create-prediction - Auto-create Ink Chain predictions from templates
 * Protected by ADMIN_API_SECRET
 */
app.post('/api/cron-create-prediction', async (req, res) => {
  try {
    // Verify authentication
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = req.headers['authorization'];
    const providedSecret = authHeader?.replace('Bearer ', '');
    const expectedSecret = process.env.ADMIN_API_SECRET;

    if (!isVercelCron && (!expectedSecret || providedSecret !== expectedSecret)) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - Missing or invalid admin secret'
      });
    }

    console.log('🤖 Auto-creation triggered via cron');

    // Templates embedded directly (Vercel serverless doesn't include all files)
    const templates = [
      {
        category: "INK CHAIN",
        question: "Will Ink Chain reach 70,000 active wallets?",
        emoji: "⛓️",
        metricType: "active_wallets",
        targetMetric: 70000,
        durationHours: 48,
        enabled: true
      },
      {
        category: "INK CHAIN",
        question: "Will Ink Chain process 100,000 transactions?",
        emoji: "⚡",
        metricType: "transactions",
        targetMetric: 100000,
        durationHours: 24,
        enabled: true
      },
      {
        category: "INK CHAIN",
        question: "Will Ink Chain reach block number 500,000?",
        emoji: "🔢",
        metricType: "block_number",
        targetMetric: 500000,
        durationHours: 72,
        enabled: true
      },
      {
        category: "INK CHAIN",
        question: "Will Ink Chain gas price drop below 5 gwei?",
        emoji: "⛽",
        metricType: "gas_price",
        targetMetric: 5,
        durationHours: 24,
        enabled: true
      },
      {
        category: "INK CHAIN",
        question: "Will Ink Chain have 50,000 active wallets?",
        emoji: "👛",
        metricType: "active_wallets",
        targetMetric: 50000,
        durationHours: 36,
        enabled: true
      }
    ];

    const enabledTemplates = templates.filter(t => t.enabled !== false);

    if (enabledTemplates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No enabled templates found'
      });
    }

    // Use current day of year to cycle through templates (serverless-friendly)
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));
    const templateIndex = dayOfYear % enabledTemplates.length;
    const template = enabledTemplates[templateIndex];

    console.log(`📋 Creating prediction from template: "${template.question}"`);

    // Create the prediction
    const durationSeconds = template.durationHours * 3600;
    const deadline = Math.floor(Date.now() / 1000) + durationSeconds;

    // Contract expects: createMarket(tweetId, targetMetric, metricType, deadline)
    // For Ink Chain, use question as tweetId
    const tx = await adminContract.createMarket(
      template.question,  // tweetId (use question for Ink Chain)
      template.targetMetric,  // targetMetric
      template.metricType,  // metricType
      deadline  // deadline (unix timestamp)
    );

    const receipt = await tx.wait();
    const marketCreatedEvent = receipt.logs.find(
      log => log.topics[0] === ethers.id('MarketCreated(uint256,string,uint256,uint256)')
    );

    if (!marketCreatedEvent) {
      throw new Error('MarketCreated event not found in transaction receipt');
    }

    const marketId = parseInt(marketCreatedEvent.topics[1], 16);
    const deadlineDate = new Date(Date.now() + template.durationHours * 3600 * 1000);

    // Save to Supabase
    const supabase = require('./supabase-client');
    if (supabase) {
      await supabase.from('predictions').insert([{
        market_id: marketId,
        question: template.question,
        category: template.category,
        emoji: template.emoji,
        tweet_url: template.tweetUrl || null,
        ink_contract_address: template.inkContractAddress || null,
        target_metric: template.targetMetric,
        metric_type: template.metricType,
        deadline: deadlineDate.toISOString(),
        deployed: true,
        resolved: false,
        created_at: new Date().toISOString()
      }]);
    }

    console.log(`✅ Prediction created! Market ID: ${marketId}`);

    res.json({
      success: true,
      marketId,
      question: template.question,
      transactionHash: receipt.hash
    });

  } catch (error) {
    console.error('❌ Error in auto-creation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/markets - Get all active markets (merged from Supabase + Blockchain)
 */
app.get('/api/markets', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    // Fetch active markets from Supabase (has questions, categories, etc.)
    // Only show markets that haven't expired yet (expired unresolved markets are shown in admin endpoint)
    if (supabase) {
      const { data: dbMarkets, error } = await supabase
        .from('predictions')
        .select('*')
        .eq('deployed', true)
        .eq('resolved', false)
        .gt('deadline', new Date().toISOString())
        .order('created_at', { ascending: false });

      if (!error && dbMarkets && dbMarkets.length > 0) {
        const enrichedMarkets = await Promise.all(
          dbMarkets.map(async (dbMarket) => {
            try {
              // Get blockchain data
              const market = await contract.markets(dbMarket.market_id);
              const [yesOdds, noOdds] = await contract.getOdds(dbMarket.market_id);

              // Get current metrics
              let currentMetric = 0;
              if (dbMarket.category === 'TWITTER' && dbMarket.tweet_id) {
                const metrics = await getTweetMetrics(dbMarket.tweet_id);
                if (metrics) {
                  const metricMap = {
                    'like': metrics.likes,
                    'retweet': metrics.retweets,
                    'reply': metrics.replies,
                    'view': metrics.views
                  };
                  currentMetric = metricMap[dbMarket.metric_type] || 0;
                }
              } else if (dbMarket.category === 'INK CHAIN') {
                currentMetric = 0;
              }

              return {
                id: dbMarket.market_id.toString(),
                question: dbMarket.question,
                emoji: dbMarket.emoji,
                category: dbMarket.category,
                tweetId: dbMarket.tweet_id || market.tweetId,
                tweetUrl: dbMarket.tweet_url,
                targetMetric: dbMarket.target_metric.toString(),
                metricType: dbMarket.metric_type,
                deadline: Math.floor(new Date(dbMarket.deadline).getTime() / 1000).toString(),
                yesPool: ethers.utils.formatUnits(market.yesPool, 6),
                noPool: ethers.utils.formatUnits(market.noPool, 6),
                resolved: market.resolved,
                yesOdds: yesOdds,
                noOdds: noOdds,
                currentMetric: currentMetric,
                createdAt: Math.floor(new Date(dbMarket.created_at).getTime() / 1000).toString()
              };
            } catch (err) {
              console.error(`Error enriching market ${dbMarket.market_id}:`, err.message);
              return null;
            }
          })
        );

        // Filter out null values (failed enrichments)
        const validMarkets = enrichedMarkets.filter(m => m !== null);
        return res.json({ success: true, markets: validMarkets });
      }
    }

    // Fallback: fetch from blockchain only (old behavior)
    const activeMarketIds = await contract.getActiveMarkets();
    const markets = [];

    for (const marketId of activeMarketIds) {
      const market = await contract.markets(marketId);
      const metrics = await getTweetMetrics(market.tweetId);
      const [yesOdds, noOdds] = await contract.getOdds(marketId);

      markets.push({
        id: market.id.toString(),
        question: `Will this reach ${market.targetMetric} ${market.metricType}s?`,
        emoji: '🎯',
        category: market.tweetId.startsWith('ink_') ? 'INK CHAIN' : 'TWITTER',
        tweetId: market.tweetId,
        targetMetric: market.targetMetric.toString(),
        metricType: market.metricType,
        deadline: market.deadline.toString(),
        yesPool: ethers.utils.formatUnits(market.yesPool, 6),
        noPool: ethers.utils.formatUnits(market.noPool, 6),
        resolved: market.resolved,
        yesOdds: yesOdds,
        noOdds: noOdds,
        currentMetric: metrics ? (metrics.likes || metrics.retweets || metrics.replies || 0) : 0,
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
 * GET /api/market/:id - Get details for a specific market (merged from Supabase + Blockchain)
 */
app.get('/api/market/:id', async (req, res) => {
  try {
    const marketId = req.params.id;
    const supabase = require('./supabase-client');

    // Try to fetch from Supabase first (has question, category, etc.)
    if (supabase) {
      const { data: dbMarket, error } = await supabase
        .from('predictions')
        .select('*')
        .eq('market_id', marketId)
        .single();

      if (!error && dbMarket) {
        // Enrich with blockchain data
        try {
          const market = await contract.markets(marketId);
          const [yesOdds, noOdds] = await contract.getOdds(marketId);

          // Get current metrics
          let currentMetric = 0;
          if (dbMarket.category === 'TWITTER' && dbMarket.tweet_id) {
            const metrics = await getTweetMetrics(dbMarket.tweet_id);
            if (metrics) {
              const metricMap = {
                'like': metrics.likes,
                'retweet': metrics.retweets,
                'reply': metrics.replies,
                'view': metrics.views
              };
              currentMetric = metricMap[dbMarket.metric_type] || 0;
            }
          } else if (dbMarket.category === 'INK CHAIN') {
            currentMetric = 0;
          }

          const marketData = {
            id: dbMarket.market_id.toString(),
            question: dbMarket.question,
            emoji: dbMarket.emoji,
            category: dbMarket.category,
            tweetId: dbMarket.tweet_id,
            tweetUrl: dbMarket.tweet_url,
            targetMetric: dbMarket.target_metric.toString(),
            metricType: dbMarket.metric_type,
            deadline: Math.floor(new Date(dbMarket.deadline).getTime() / 1000).toString(),
            yesPool: ethers.utils.formatUnits(market.yesPool, 6),
            noPool: ethers.utils.formatUnits(market.noPool, 6),
            resolved: market.resolved,
            outcome: market.outcome,
            yesOdds: yesOdds,
            noOdds: noOdds,
            currentMetric: currentMetric,
            createdAt: Math.floor(new Date(dbMarket.created_at).getTime() / 1000).toString()
          };

          return res.json({ success: true, market: marketData });
        } catch (err) {
          console.error(`Error enriching market ${marketId}:`, err.message);
        }
      }
    }

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
        question: `Will this reach ${market.targetMetric} ${market.metricType}s?`,
        emoji: '🎯',
        category: market.tweetId.startsWith('ink_') ? 'INK CHAIN' : 'TWITTER',
        tweetId: market.tweetId,
        targetMetric: market.targetMetric.toString(),
        metricType: market.metricType,
        deadline: market.deadline.toString(),
        yesPool: ethers.utils.formatUnits(market.yesPool, 6),
        noPool: ethers.utils.formatUnits(market.noPool, 6),
        resolved: market.resolved,
        outcome: market.outcome,
        yesOdds: yesOdds,
        noOdds: noOdds,
        currentMetric: metrics ? (metrics.likes || metrics.retweets || metrics.replies || 0) : 0,
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
    const address = req.params.address.toLowerCase();
    const supabase = require('./supabase-client');

    // Try to fetch from Supabase first (has question, emoji, category)
    if (supabase) {
      // First, get the bets
      const { data: bets, error: betsError } = await supabase
        .from('user_bets')
        .select('*')
        .eq('user_address', address)
        .order('created_at', { ascending: false });

      if (!betsError && bets && bets.length > 0) {
        // Get the prediction_ids from bets
        const predictionIds = bets
          .filter(b => b.prediction_id)
          .map(b => b.prediction_id);

        // Fetch the related predictions
        let predictionsMap = {};
        if (predictionIds.length > 0) {
          const { data: predictions, error: predError } = await supabase
            .from('predictions')
            .select('id, question, emoji, category, tweet_url')
            .in('id', predictionIds);

          if (!predError && predictions) {
            predictions.forEach(p => {
              predictionsMap[p.id] = p;
            });
          }
        }

        // Format the response with merged prediction data
        const formattedBets = bets.map(bet => {
          const prediction = predictionsMap[bet.prediction_id];
          return {
            marketId: bet.market_id.toString(),
            amount: bet.amount,
            position: bet.position,
            claimed: bet.claimed || false,
            resolved: bet.won !== null,
            won: bet.won,
            payout: bet.payout,
            question: prediction?.question || null,
            emoji: prediction?.emoji || null,
            category: prediction?.category || null,
            tweetUrl: prediction?.tweet_url || null,
            createdAt: bet.created_at
          };
        });

        console.log(`✅ Fetched ${formattedBets.length} bets for ${address}`);
        console.log('Sample bet with question:', JSON.stringify(formattedBets[0], null, 2));
        return res.json({ success: true, bets: formattedBets });
      } else if (betsError) {
        console.error('Supabase bets error:', betsError);

        // Fallback: Manual JOIN - fetch bets and predictions separately
        const { data: betsOnly, error: betsError } = await supabase
          .from('user_bets')
          .select('*')
          .eq('user_address', address)
          .order('created_at', { ascending: false });

        if (!betsError && betsOnly && betsOnly.length > 0) {
          // Get unique market_ids
          const marketIds = [...new Set(betsOnly.map(b => b.market_id))];

          // Fetch predictions for these markets
          const { data: predictions, error: predError } = await supabase
            .from('predictions')
            .select('market_id, question, emoji, category, tweet_url')
            .in('market_id', marketIds);

          if (!predError && predictions) {
            // Create a map for quick lookup
            const predMap = {};
            predictions.forEach(p => {
              predMap[p.market_id] = p;
            });

            // Merge the data
            const formattedBets = betsOnly.map(bet => ({
              marketId: bet.market_id.toString(),
              amount: bet.amount,
              position: bet.position,
              claimed: bet.claimed || false,
              resolved: bet.won !== null,
              won: bet.won,
              payout: bet.payout,
              question: predMap[bet.market_id]?.question || null,
              emoji: predMap[bet.market_id]?.emoji || null,
              category: predMap[bet.market_id]?.category || null,
              tweetUrl: predMap[bet.market_id]?.tweet_url || null,
              createdAt: bet.created_at
            }));

            console.log(`✅ Manual JOIN: Fetched ${formattedBets.length} bets for ${address}`);
            return res.json({ success: true, bets: formattedBets });
          }
        }
      }
    }

    // Fallback: fetch from blockchain only (old behavior)
    const marketIds = await contract.getUserMarkets(address);
    const bets = [];

    for (const marketId of marketIds) {
      const market = await contract.markets(marketId);
      const bet = await contract.bets(marketId, address);

      bets.push({
        marketId: marketId.toString(),
        tweetId: market.tweetId,
        amount: ethers.utils.formatUnits(bet.amount, 6),
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
 * GET /api/leaderboard - Top winners (from Supabase)
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        success: true,
        leaderboard: [],
        message: 'Database not available'
      });
    }

    // Query from the leaderboard view
    const { data: leaderboard, error } = await supabase
      .from('leaderboard')
      .select('*')
      .limit(100);

    if (error) {
      console.error('Error fetching leaderboard:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      leaderboard: leaderboard || []
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/stats/platform - Get platform-wide statistics
 */
app.get('/api/stats/platform', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        totalMarkets: 0,
        totalVolume: 0,
        activeUsers: 0
      });
    }

    // Get total markets count
    const { count: totalMarkets } = await supabase
      .from('predictions')
      .select('*', { count: 'exact', head: true })
      .eq('deployed', true);

    // Get total volume from all bets
    const { data: volumeData } = await supabase
      .from('user_bets')
      .select('amount');

    const totalVolume = volumeData?.reduce((sum, bet) => sum + parseFloat(bet.amount || 0), 0) || 0;

    // Get active users count (users who have placed at least one bet)
    const { data: activeUsersData } = await supabase
      .from('user_bets')
      .select('user_address');

    const activeUsers = activeUsersData
      ? new Set(activeUsersData.map(bet => bet.user_address)).size
      : 0;

    res.json({
      totalMarkets: totalMarkets || 0,
      totalVolume: parseFloat(totalVolume.toFixed(2)),
      activeUsers: activeUsers
    });
  } catch (error) {
    console.error('Error fetching platform stats:', error);
    res.json({
      totalMarkets: 0,
      totalVolume: 0,
      activeUsers: 0
    });
  }
});

/**
 * GET /api/user/:address/stats - Get user statistics
 */
app.get('/api/user/:address/stats', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        success: true,
        stats: null,
        message: 'Database not available'
      });
    }

    const address = req.params.address.toLowerCase();

    const { data: stats, error } = await supabase
      .from('user_stats')
      .select('*')
      .eq('user_address', address)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching user stats:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    // Count all bets (including unresolved) from user_bets table
    const { count: totalBets } = await supabase
      .from('user_bets')
      .select('*', { count: 'exact', head: true })
      .eq('user_address', address);

    // Merge stats with actual bet count
    const mergedStats = {
      user_address: address,
      total_bets: totalBets || 0,  // Use actual count from user_bets
      total_wins: stats?.total_wins || 0,
      total_losses: stats?.total_losses || 0,
      total_volume: stats?.total_volume || 0,
      total_winnings: stats?.total_winnings || 0,
      win_rate: stats?.win_rate || 0,
      xp: stats?.xp || 0,
      current_streak: stats?.current_streak || 0,
      longest_streak: stats?.longest_streak || 0
    };

    res.json({
      success: true,
      stats: mergedStats
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/user/bet - Record a bet placement (called from frontend)
 */
app.post('/api/user/bet', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        success: false,
        error: 'Database not available'
      });
    }

    const { userAddress, marketId, amount, position, transactionHash } = req.body;

    // Validate required fields
    if (!userAddress || marketId === undefined || !amount || position === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userAddress, marketId, amount, position'
      });
    }

    // Get prediction_id from market_id
    const { data: prediction, error: predError } = await supabase
      .from('predictions')
      .select('id')
      .eq('market_id', marketId)
      .single();

    // Insert bet record
    const { data: bet, error: betError } = await supabase
      .from('user_bets')
      .insert([{
        user_address: userAddress.toLowerCase(),
        market_id: marketId,
        prediction_id: prediction?.id || null,
        amount: parseFloat(amount),
        position: position,
        claimed: false,
        created_at: new Date().toISOString()
      }])
      .select();

    if (betError) {
      console.error('Error recording bet:', betError);
      return res.status(500).json({ success: false, error: betError.message });
    }

    console.log(`✅ Bet recorded: User ${userAddress}, Market ${marketId}, Amount ${amount} USDC, Position ${position ? 'YES' : 'NO'}`);

    res.json({
      success: true,
      bet: bet[0]
    });
  } catch (error) {
    console.error('Error recording bet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/user/claim - Mark a bet as claimed after user claims winnings on-chain
 */
app.post('/api/user/claim', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    const { userAddress, marketId, transactionHash } = req.body;

    if (!userAddress || marketId === undefined) {
      return res.status(400).json({
        success: false,
        error: 'userAddress and marketId are required'
      });
    }

    console.log(`💰 Claim request: User ${userAddress}, Market #${marketId}, TX: ${transactionHash}`);

    // Update the bet as claimed
    const { data, error } = await supabase
      .from('user_bets')
      .update({ claimed: true })
      .eq('user_address', userAddress.toLowerCase())
      .eq('market_id', parseInt(marketId))
      .eq('won', true)
      .select();

    if (error) {
      console.error('Error updating claim status:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No winning bet found for this user and market'
      });
    }

    console.log(`✅ Bet claimed: Market #${marketId}, User ${userAddress}`);

    res.json({
      success: true,
      message: 'Claim recorded successfully',
      bet: data[0]
    });

  } catch (error) {
    console.error('Error recording claim:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/user/:address/daily-reward - Check daily reward status
 */
app.get('/api/user/:address/daily-reward', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        success: false,
        error: 'Database not available'
      });
    }

    const address = req.params.address.toLowerCase();

    // Get or create daily reward record
    let { data: rewardData, error } = await supabase
      .from('user_daily_rewards')
      .select('*')
      .eq('user_address', address)
      .single();

    // If no record exists, create one
    if (error && error.code === 'PGRST116') {
      const { data: newRecord, error: insertError } = await supabase
        .from('user_daily_rewards')
        .insert([{
          user_address: address,
          current_streak: 0,
          longest_streak: 0,
          last_claim_date: null,
          total_claims: 0,
          total_xp_earned: 0
        }])
        .select()
        .single();

      if (insertError) {
        console.error('Error creating daily reward record:', insertError);
        return res.status(500).json({ success: false, error: insertError.message });
      }

      rewardData = newRecord;
    } else if (error) {
      console.error('Error fetching daily reward:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    // Check if can claim today
    const now = new Date();
    const lastClaimDate = rewardData.last_claim_date ? new Date(rewardData.last_claim_date) : null;

    let canClaim = true;
    let nextClaimTime = null;

    if (lastClaimDate) {
      const todayDate = now.toISOString().split('T')[0];
      const lastClaimDateStr = lastClaimDate.toISOString().split('T')[0];

      if (todayDate === lastClaimDateStr) {
        canClaim = false;
        // Next claim is tomorrow at midnight
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        nextClaimTime = tomorrow.toISOString();
      }
    }

    res.json({
      success: true,
      canClaim,
      currentStreak: rewardData.current_streak || 0,
      longestStreak: rewardData.longest_streak || 0,
      lastClaimed: rewardData.last_claim_date,
      nextClaimTime,
      totalClaims: rewardData.total_claims || 0,
      totalXpEarned: rewardData.total_xp_earned || 0
    });
  } catch (error) {
    console.error('Error checking daily reward:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/user/:address/claim-daily - Claim daily reward
 */
app.post('/api/user/:address/claim-daily', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        success: false,
        error: 'Database not available'
      });
    }

    const address = req.params.address.toLowerCase();

    // Fetch current streak from database BEFORE calculating XP
    const { data: rewardData, error: fetchError } = await supabase
      .from('user_daily_rewards')
      .select('current_streak')
      .eq('user_address', address)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Error fetching reward data:', fetchError);
      return res.status(500).json({ success: false, error: fetchError.message });
    }

    // Calculate day in week based on NEXT claim (current_streak + 1)
    const currentStreak = rewardData?.current_streak || 0;
    const nextStreak = currentStreak + 1;
    const dayInWeek = ((nextStreak - 1) % 7) + 1;
    const xpRewards = [10, 15, 20, 25, 35, 50, 100];
    const xpAmount = xpRewards[dayInWeek - 1];

    console.log(`💰 User ${address} claiming Day ${dayInWeek} reward: ${xpAmount} XP (current streak: ${currentStreak})`);

    const { data, error } = await supabase
      .rpc('claim_daily_reward', {
        p_user_address: address,
        p_xp_amount: xpAmount
      });

    if (error) {
      console.error('Error claiming daily reward:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    const result = data[0];

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.message
      });
    }

    res.json({
      success: true,
      reward: {
        xp: xpAmount,
        day: dayInWeek,
        bonus: dayInWeek === 7 ? 'Mystery Badge 🎁' : null
      },
      newStreak: result.new_streak,
      totalXP: result.total_xp,
      message: result.message
    });
  } catch (error) {
    console.error('Error claiming daily reward:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/user/:address/achievements - Get user's unlocked achievements
 */
app.get('/api/user/:address/achievements', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({
        success: true,
        achievements: [],
        message: 'Database not available'
      });
    }

    const address = req.params.address.toLowerCase();

    const { data: achievements, error } = await supabase
      .from('user_achievements')
      .select('achievement_id, unlocked_at, xp_earned')
      .eq('user_address', address)
      .order('unlocked_at', { ascending: false });

    if (error) {
      console.error('Error fetching achievements:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      achievements: achievements.map(a => a.achievement_id),
      details: achievements
    });
  } catch (error) {
    console.error('Error fetching achievements:', error);
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
      tweetId = `ink_${Date.now()}`;
    }

    const predictionData = {
      category,
      question,
      emoji: emoji || '🎯',
      tweet_id: category === 'TWITTER' ? tweetId : null,
      tweet_url: category === 'TWITTER' ? tweetUrl : null,
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

      // Get the market ID from the MarketCreated event
      let marketId = -1;

      // Try to parse the event from the receipt
      if (receipt.events && receipt.events.length > 0) {
        const marketCreatedEvent = receipt.events.find(e => e.event === 'MarketCreated');
        if (marketCreatedEvent && marketCreatedEvent.args) {
          marketId = marketCreatedEvent.args.marketId.toNumber();
        }
      }

      // Fallback: try to get from logs
      if (marketId === -1 && receipt.logs && receipt.logs.length > 0) {
        try {
          const iface = new ethers.utils.Interface(CONTRACT_ABI);
          for (const log of receipt.logs) {
            try {
              const parsed = iface.parseLog(log);
              if (parsed.name === 'MarketCreated') {
                marketId = parsed.args.marketId.toNumber();
                break;
              }
            } catch (e) {
              // Skip logs that don't match our ABI
            }
          }
        } catch (e) {
          console.error('Error parsing logs:', e.message);
        }
      }

      // Final fallback: use marketCount
      if (marketId === -1) {
        const marketCount = await contract.marketCount();
        marketId = marketCount.toNumber() - 1;
      }

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
 * Now also saves to Supabase for frontend visibility
 */
app.post('/api/admin/create-market', async (req, res) => {
  try {
    const { tweetId, targetMetric, metricType, durationHours, description } = req.body;

    const deadline = Math.floor(Date.now() / 1000) + (durationHours * 3600);
    const deadlineISO = new Date(deadline * 1000).toISOString();

    // Deploy to blockchain first
    const tx = await adminContract.createMarket(
      tweetId,
      targetMetric,
      metricType,
      deadline
    );

    const receipt = await tx.wait();

    // Get the market ID from the contract
    const marketCount = await contract.marketCount();
    const marketId = marketCount.toNumber() - 1;

    console.log(`✅ Market deployed! Market ID: ${marketId}, TX: ${receipt.transactionHash}`);

    const supabase = require('./supabase-client');

    if (supabase) {
      try {
        const predictionData = {
          category: 'TWITTER',
          question: description || `Will this reach ${targetMetric} ${metricType}s?`,
          emoji: '🎯',
          tweet_id: tweetId,
          tweet_url: `https://twitter.com/i/web/status/${tweetId}`,
          target_metric: parseInt(targetMetric),
          metric_type: metricType,
          deadline: deadlineISO,
          market_id: marketId,
          deployed: true,
          resolved: false,
          created_by: 'admin'
        };

        const { error: supabaseError } = await supabase
          .from('predictions')
          .insert([predictionData]);

        if (supabaseError) {
          console.warn('⚠️ Failed to save to Supabase:', supabaseError.message);
        } else {
          console.log('✅ Market saved to Supabase');
        }
      } catch (dbError) {
        console.warn('⚠️ Supabase save failed:', dbError.message);
      }
    }

    res.json({
      success: true,
      marketId: marketId,
      transactionHash: receipt.transactionHash
    });
  } catch (error) {
    console.error('Error creating market:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/markets - Get all markets including expired unresolved ones (for admin dashboard)
 */
app.get('/api/admin/markets', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    // Fetch ALL unresolved markets (including expired ones) for admin
    if (supabase) {
      const { data: dbMarkets, error } = await supabase
        .from('predictions')
        .select('*')
        .eq('deployed', true)
        .eq('resolved', false)
        .order('created_at', { ascending: false });

      if (!error && dbMarkets && dbMarkets.length > 0) {
        // Enrich with blockchain data (pools, odds)
        const enrichedMarkets = await Promise.all(
          dbMarkets.map(async (dbMarket) => {
            try {
              // Get blockchain data
              const market = await contract.markets(dbMarket.market_id);
              const [yesOdds, noOdds] = await contract.getOdds(dbMarket.market_id);

              // Get current metrics
              let currentMetric = 0;
              if (dbMarket.category === 'TWITTER' && dbMarket.tweet_id) {
                const metrics = await getTweetMetrics(dbMarket.tweet_id);
                if (metrics) {
                  const metricMap = {
                    'like': metrics.likes,
                    'retweet': metrics.retweets,
                    'reply': metrics.replies,
                    'view': metrics.views
                  };
                  currentMetric = metricMap[dbMarket.metric_type] || 0;
                }
              } else if (dbMarket.category === 'INK CHAIN') {
                currentMetric = 0;
              }

              const deadlineTimestamp = Math.floor(new Date(dbMarket.deadline).getTime() / 1000);
              const now = Math.floor(Date.now() / 1000);
              const isExpired = deadlineTimestamp < now;

              return {
                id: dbMarket.market_id.toString(),
                question: dbMarket.question,
                emoji: dbMarket.emoji,
                category: dbMarket.category,
                tweetId: dbMarket.tweet_id || market.tweetId,
                tweetUrl: dbMarket.tweet_url,
                targetMetric: dbMarket.target_metric.toString(),
                metricType: dbMarket.metric_type,
                deadline: deadlineTimestamp.toString(),
                yesPool: ethers.utils.formatUnits(market.yesPool, 6),
                noPool: ethers.utils.formatUnits(market.noPool, 6),
                resolved: market.resolved,
                expired: isExpired && !market.resolved,
                yesOdds: yesOdds,
                noOdds: noOdds,
                currentMetric: currentMetric,
                createdAt: Math.floor(new Date(dbMarket.created_at).getTime() / 1000).toString()
              };
            } catch (err) {
              console.error(`Error enriching market ${dbMarket.market_id}:`, err.message);
              return null;
            }
          })
        );

        // Filter out null values (failed enrichments)
        const validMarkets = enrichedMarkets.filter(m => m !== null);
        return res.json({ success: true, markets: validMarkets });
      }
    }

    // Fallback: fetch from blockchain only
    const marketCount = await contract.marketCount();
    const markets = [];

    for (let i = 0; i < marketCount; i++) {
      const market = await contract.markets(i);
      if (market.resolved) continue;

      const metrics = await getTweetMetrics(market.tweetId);
      const [yesOdds, noOdds] = await contract.getOdds(i);
      const now = Math.floor(Date.now() / 1000);
      const isExpired = market.deadline.toNumber() < now;

      markets.push({
        id: market.id.toString(),
        question: `Will this reach ${market.targetMetric} ${market.metricType}s?`,
        emoji: '🎯',
        category: market.tweetId.startsWith('ink_') ? 'INK CHAIN' : 'TWITTER',
        tweetId: market.tweetId,
        targetMetric: market.targetMetric.toString(),
        metricType: market.metricType,
        deadline: market.deadline.toString(),
        yesPool: ethers.utils.formatUnits(market.yesPool, 6),
        noPool: ethers.utils.formatUnits(market.noPool, 6),
        resolved: market.resolved,
        expired: isExpired,
        yesOdds: yesOdds,
        noOdds: noOdds,
        currentMetric: metrics ? (metrics.likes || metrics.retweets || metrics.replies || 0) : 0,
        createdAt: market.createdAt.toString()
      });
    }

    res.json({ success: true, markets });
  } catch (error) {
    console.error('Error fetching admin markets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/resolve-market - Manual market resolution (for testing)
 * Allows admin to resolve a market before deadline for testing purposes
 */
app.post('/api/admin/resolve-market', async (req, res) => {
  try {
    const { marketId } = req.body;

    if (marketId === undefined || marketId === null) {
      return res.status(400).json({
        success: false,
        error: 'Market ID is required'
      });
    }

    console.log(`🔮 Manual resolution requested for market #${marketId}`);

    const market = await contract.markets(marketId);

    if (market.resolved) {
      return res.status(400).json({
        success: false,
        error: 'Market already resolved'
      });
    }

    // Check if market has any bets
    const totalPool = market.yesPool.add(market.noPool);
    if (totalPool.isZero()) {
      return res.status(400).json({
        success: false,
        error: 'Cannot resolve market with no bets. Please wait for users to place bets or delete this market.'
      });
    }

    const tweetId = market.tweetId;
    const targetMetric = market.targetMetric.toNumber();
    const metricType = market.metricType;

    console.log(`Tweet ID: ${tweetId}`);
    console.log(`Target: ${targetMetric} ${metricType}s`);

    let actualMetric = 0;

    if (tweetId.startsWith('ink_')) {
      console.log('⛓️ Fetching Ink Chain metrics...');

      const twitterMetrics = ['like', 'likes', 'retweet', 'retweets', 'reply', 'replies', 'view', 'views', 'bookmark', 'bookmarks'];
      if (twitterMetrics.includes(metricType.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: `Invalid metric type "${metricType}" for Ink Chain prediction. Twitter metrics (like, retweet, etc.) cannot be used for Ink Chain predictions. Use Ink Chain metrics: transactions, block_number, tvl, gas_price, or active_wallets.`
        });
      }

      const inkMetrics = await getInkChainMetrics(metricType, market.inkContractAddress || null);
      if (inkMetrics && inkMetrics.value !== undefined) {
        actualMetric = typeof inkMetrics.value === 'number' ? inkMetrics.value : parseInt(inkMetrics.value);
      } else {
        return res.status(500).json({
          success: false,
          error: `Failed to fetch Ink Chain metrics for type "${metricType}". Supported types: transactions, block_number, tvl, gas_price, active_wallets`
        });
      }
    } else {
      // Twitter metric
      console.log('🐦 Fetching Twitter metrics...');
      const metrics = await getTweetMetrics(tweetId);

      if (!metrics) {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch tweet metrics'
        });
      }

      const metricMap = {
        'like': metrics.likes,
        'retweet': metrics.retweets,
        'reply': metrics.replies,
        'view': metrics.views,
        'bookmark': metrics.bookmarks || 0,
        'users': metrics.likes
      };

      actualMetric = metricMap[metricType.toLowerCase()] || 0;
    }

    console.log(`Actual: ${actualMetric} ${metricType}s`);

    const outcome = actualMetric >= targetMetric;
    console.log(`Result: ${outcome ? '✅ YES (Target Reached)' : '❌ NO (Target Not Reached)'}`);

    console.log('⛓️ Submitting resolution to blockchain...');
    const tx = await oracleContract.resolve(marketId, outcome, actualMetric);
    console.log(`TX Hash: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`✅ Resolved! Gas Used: ${receipt.gasUsed.toString()}`);

    // Update Supabase (predictions, user_bets, user_stats)
    try {
      await updateSupabaseAfterResolution(marketId, outcome, actualMetric, market);
    } catch (dbError) {
      console.warn('⚠️ Failed to update Supabase:', dbError.message);
    }

    res.json({
      success: true,
      marketId: marketId,
      outcome: outcome,
      actualMetric: actualMetric,
      targetMetric: targetMetric,
      transactionHash: receipt.transactionHash
    });

  } catch (error) {
    console.error('Error resolving market:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ Live Activity Feed ============

/**
 * GET /api/activity/recent - Get recent betting activity for live feed
 */
app.get('/api/activity/recent', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({ success: true, activities: [] });
    }

    // Fetch recent bets with prediction data
    const { data: bets, error } = await supabase
      .from('user_bets')
      .select(`
        id,
        user_address,
        market_id,
        amount,
        position,
        won,
        payout,
        created_at,
        predictions (
          question
        )
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Error fetching recent activity:', error);
      return res.json({ success: true, activities: [] });
    }

    // Format activities for the feed
    const activities = bets.map(bet => {
      // Truncate user address for privacy
      const shortAddress = `${bet.user_address.slice(0, 6)}...${bet.user_address.slice(-4)}`;

      const activity = {
        id: bet.id,
        type: bet.won === true ? 'win' : 'bet',
        user: shortAddress,
        position: bet.position,
        amount: bet.amount.toString(),
        marketId: bet.market_id.toString(),
        question: bet.predictions?.question || null,
        timestamp: new Date(bet.created_at).getTime()
      };

      // If they won, add payout info
      if (bet.won === true && bet.payout) {
        activity.amount = bet.payout.toString();
      }

      return activity;
    });

    res.json({ success: true, activities });
  } catch (error) {
    console.error('Error in activity feed:', error);
    res.json({ success: true, activities: [] });
  }
});

/**
 * POST /api/markets/propose - Propose a new market (saved to DB for review)
 */
app.post('/api/markets/propose', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Database service unavailable'
      });
    }

    const {
      creatorAddress,
      category,
      question,
      targetMetric,
      metricType,
      durationHours,
      emoji
    } = req.body;

    // Validation
    if (!creatorAddress || !question || !targetMetric || !metricType || !durationHours) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    if (category !== 'INK CHAIN') {
      return res.status(400).json({
        success: false,
        error: 'Only Ink Chain markets can be proposed at this time'
      });
    }

    // Insert proposal
    const { data, error } = await supabase
      .from('market_proposals')
      .insert([{
        created_by: creatorAddress.toLowerCase(),
        category,
        question,
        target_metric: targetMetric,
        metric_type: metricType,
        duration_hours: durationHours,
        emoji: emoji || '🎯',
        status: 'pending'
      }])
      .select();

    if (error) {
      console.error('Error creating proposal:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to save proposal: ' + error.message
      });
    }

    console.log(`💡 New market proposal from ${creatorAddress}: ${question}`);

    res.json({
      success: true,
      proposal: data[0],
      message: 'Proposal submitted successfully'
    });

  } catch (error) {
    console.error('Error in proposal endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/admin/proposals - Get all pending proposals
 */
app.get('/api/admin/proposals', async (req, res) => {
  try {
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database service unavailable' });
    }

    const { data: proposals, error } = await supabase
      .from('market_proposals')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching proposals:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, proposals: proposals || [] });
  } catch (error) {
    console.error('Error in get proposals endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/proposals/approve - Approve a proposal and deploy market
 */
app.post('/api/admin/proposals/approve', async (req, res) => {
  try {
    const { proposalId } = req.body;
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database service unavailable' });
    }

    // 1. Fetch proposal details
    const { data: proposal, error: fetchError } = await supabase
      .from('market_proposals')
      .select('*')
      .eq('id', proposalId)
      .single();

    if (fetchError || !proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    if (proposal.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Proposal is already ${proposal.status}` });
    }

    // 2. Deploy to blockchain
    // Use placeholder tweet ID for Ink Chain markets if needed
    const tweetId = proposal.tweet_id || `ink_${Date.now()}`;
    const deadline = Math.floor(Date.now() / 1000) + (proposal.duration_hours * 3600);
    const deadlineISO = new Date(deadline * 1000).toISOString();

    console.log(`⛓️ Approving proposal ${proposalId}. Deploying to blockchain...`);

    const tx = await adminContract.createMarket(
      tweetId,
      proposal.target_metric,
      proposal.metric_type,
      deadline
    );

    const receipt = await tx.wait();

    // Get market ID
    let marketId = -1;
    // Try to get from events, fallback to marketCount
    if (receipt.events && receipt.events.length > 0) {
      const marketCreatedEvent = receipt.events.find(e => e.event === 'MarketCreated');
      if (marketCreatedEvent && marketCreatedEvent.args) {
        marketId = marketCreatedEvent.args.marketId.toNumber();
      }
    }

    if (marketId === -1) {
      const marketCount = await contract.marketCount();
      marketId = marketCount.toNumber() - 1;
    }

    console.log(`✅ Market deployed! ID: ${marketId}, TX: ${receipt.transactionHash}`);

    // 3. Create prediction record in DB (Active Market)
    const { error: insertError } = await supabase
      .from('predictions')
      .insert([{
        category: proposal.category,
        question: proposal.question,
        emoji: proposal.emoji,
        // Fix for check_data_source constraint: tweet_id must be NULL for INK CHAIN
        tweet_id: proposal.category === 'INK CHAIN' ? null : tweetId,
        tweet_url: proposal.tweet_url,
        ink_contract_address: proposal.category === 'INK CHAIN' ? (proposal.ink_contract_address || null) : null,
        ink_metric_endpoint: proposal.category === 'INK CHAIN' ? (proposal.ink_metric_endpoint || null) : null,
        // request_id removed as column may not exist
        target_metric: proposal.target_metric,
        metric_type: proposal.metric_type,
        deadline: deadlineISO,
        market_id: marketId,
        deployed: true,
        resolved: false,
        created_by: 'admin' // Officially created by admin
      }]);

    if (insertError) {
      console.error('Error creating prediction record:', insertError);
      // Don't fail the request since blockchain deployment succeeded
    }

    // 4. Update proposal status
    const { error: updateError } = await supabase
      .from('market_proposals')
      .update({
        status: 'approved',
        market_id: marketId,
        updated_at: new Date().toISOString()
      })
      .eq('id', proposalId);

    res.json({
      success: true,
      marketId,
      transactionHash: receipt.transactionHash,
      message: 'Proposal approved and market deployed'
    });

  } catch (error) {
    console.error('Error approving proposal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/proposals/reject - Reject a proposal
 */
app.post('/api/admin/proposals/reject', async (req, res) => {
  try {
    const { proposalId, reason } = req.body;
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database service unavailable' });
    }

    const { error } = await supabase
      .from('market_proposals')
      .update({
        status: 'rejected',
        rejection_reason: reason || 'Rejected by admin',
        updated_at: new Date().toISOString()
      })
      .eq('id', proposalId);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    console.log(`❌ Proposal ${proposalId} rejected`);

    res.json({
      success: true,
      message: 'Proposal rejected'
    });

  } catch (error) {
    console.error('Error rejecting proposal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ Health Check ============

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ Start Server ============

const PORT = process.env.PORT || 3001;

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
