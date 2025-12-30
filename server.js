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

        // Update Supabase if available
        const supabase = require('./supabase-client');
        if (supabase) {
          try {
            await supabase
              .from('predictions')
              .update({
                resolved: true,
                outcome: outcome,
                final_metric: actualMetric
              })
              .eq('market_id', marketId);
            console.log('✅ Updated Supabase');
          } catch (dbError) {
            console.warn('⚠️ Failed to update Supabase:', dbError.message);
          }
        }

        resolvedCount++;

        // Add delay between resolutions
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`❌ Error resolving market ${marketId}:`, error.message);
        errors.push({ marketId, error: error.message });
        // Continue with next market
      }
    }

    console.log(`\n🎉 Resolution complete! Resolved: ${resolvedCount}, Errors: ${errors.length}`);
    return { resolved: resolvedCount, errors };
  } catch (error) {
    console.error('Error resolving markets:', error);
    throw error;
  }
}

// DISABLED: Use GitHub Actions oracle instead to avoid rate limits
// cron.schedule('* * * * *', resolveExpiredMarkets);

// ============ API Endpoints ============

/**
 * POST /api/oracle/resolve - Trigger automatic resolution of expired markets
 * Protected by CRON_SECRET environment variable or Vercel cron header
 */
app.post('/api/oracle/resolve', async (req, res) => {
  try {
    // Verify authentication
    // Option 1: Check for Vercel cron header (automatically added by Vercel)
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    
    // Option 2: Check for custom CRON_SECRET
    const cronSecret = req.headers['authorization']?.replace('Bearer ', '') || req.query.secret;
    const expectedSecret = process.env.CRON_SECRET;

    // Allow if: Vercel cron OR no secret required OR secret matches
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
        .gt('deadline', new Date().toISOString()) // Only active markets
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
                // For Ink Chain, we could fetch current metrics here if needed
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
        question: `Will this reach ${market.targetMetric} ${market.metricType}s?`, // Fallback question
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
            currentMetric = 0; // Could fetch Ink Chain metrics here if needed
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
          // Fall through to blockchain-only fallback
        }
      }
    }

    // Fallback: fetch from blockchain only
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
        question: `Will this reach ${market.targetMetric} ${market.metricType}s?`, // Fallback question
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

    // Save to Supabase (if available)
    const supabase = require('./supabase-client');

    if (supabase) {
      try {
        const predictionData = {
          category: 'TWITTER', // Default to Twitter for backward compatibility
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
        // No deadline filter - show all unresolved markets including expired
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
                // For Ink Chain, we could fetch current metrics here if needed
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
                expired: isExpired && !market.resolved, // True if expired but not yet resolved
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
      if (market.resolved) continue; // Skip resolved markets

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

    // Get market details
    const market = await contract.markets(marketId);

    if (market.resolved) {
      return res.status(400).json({
        success: false,
        error: 'Market already resolved'
      });
    }

    const tweetId = market.tweetId;
    const targetMetric = market.targetMetric.toNumber();
    const metricType = market.metricType;

    console.log(`Tweet ID: ${tweetId}`);
    console.log(`Target: ${targetMetric} ${metricType}s`);

    // Fetch metrics based on prediction type
    let actualMetric = 0;

    if (tweetId.startsWith('ink_')) {
      // Ink Chain metric
      console.log('⛓️ Fetching Ink Chain metrics...');
      const inkMetrics = await getInkChainMetrics(metricType, market.inkContractAddress || null);
      if (inkMetrics && inkMetrics.value !== undefined) {
        actualMetric = typeof inkMetrics.value === 'number' ? inkMetrics.value : parseInt(inkMetrics.value);
      } else {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch Ink Chain metrics'
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

    // Determine outcome
    const outcome = actualMetric >= targetMetric;
    console.log(`Result: ${outcome ? '✅ YES (Target Reached)' : '❌ NO (Target Not Reached)'}`);

    // Resolve on-chain
    console.log('⛓️ Submitting resolution to blockchain...');
    const tx = await oracleContract.resolve(marketId, outcome, actualMetric);
    console.log(`TX Hash: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`✅ Resolved! Gas Used: ${receipt.gasUsed.toString()}`);

    // Update Supabase if available
    const supabase = require('./supabase-client');
    if (supabase) {
      try {
        await supabase
          .from('predictions')
          .update({
            resolved: true,
            outcome: outcome,
            final_metric: actualMetric
          })
          .eq('market_id', marketId);

        console.log('✅ Updated Supabase');
      } catch (dbError) {
        console.warn('⚠️ Failed to update Supabase:', dbError.message);
      }
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
