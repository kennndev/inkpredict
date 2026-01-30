const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { ethers } = require('ethers');
const crypto = require('crypto');
const cron = require('node-cron');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
require('dotenv').config();

const CONTRACT_ARTIFACT = require('./abi/InkPredict.json');
const CONTRACT_ABI = CONTRACT_ARTIFACT.abi;

// ============ Setup ============

const app = express();
app.use(express.json());
app.use(cors());

// Enable trust proxy for Vercel/proxies
app.set('trust proxy', 1);

// Rate limiting - Different limits for different endpoint types
// General API rate limiter (more permissive for user endpoints)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Increased to 200 requests per 15 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiter for write operations (POST/PUT/DELETE)
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 write requests per 15 minutes
  message: 'Too many write requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiter to all routes by default
// But skip rate limiting for oracle/cron endpoints (they have their own auth)
app.use((req, res, next) => {
  // Skip rate limiting for oracle endpoints
  if (req.path.startsWith('/api/oracle/')) {
    return next();
  }
  // Apply rate limiter to all other routes
  apiLimiter(req, res, next);
});

// Twitter API client
const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);

// Blockchain connection - Use Alchemy if available, otherwise use standard RPC
let provider;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL;

if (ALCHEMY_API_KEY && ALCHEMY_RPC_URL) {
  // Use Alchemy provider for better performance
  console.log('🔮 Using Alchemy provider for enhanced performance');
  provider = new ethers.providers.JsonRpcProvider(ALCHEMY_RPC_URL, {
    chainId: 763373,
    name: 'ink-sepolia'
  });
} else {
  // Fallback to standard RPC
  provider = new ethers.providers.JsonRpcProvider(process.env.INK_CHAIN_RPC, {
    chainId: 763373,
    name: 'ink-sepolia'
  });
}
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
 * Helper function to find block number at a specific timestamp
 * Uses binary search for efficiency with caching and error handling
 */
const blockTimestampCache = new Map(); // Cache block timestamps to avoid repeated queries

async function getBlockAtTimestamp(targetTimestamp, maxIterations = 50) {
  try {
    const latestBlock = await provider.getBlock('latest');
    
    // If target is in the future or very recent, return latest
    if (targetTimestamp >= latestBlock.timestamp) {
      return latestBlock.number;
    }
    
    // If target is before genesis, return 0
    if (targetTimestamp <= 0) {
      return 0;
    }
    
    // Binary search for the block with caching
    let low = 0;
    let high = latestBlock.number;
    let bestBlock = 0;
    let iterations = 0;
    
    while (low <= high && iterations < maxIterations) {
      iterations++;
      const mid = Math.floor((low + high) / 2);
      
        // Check cache first
        let block;
        if (blockTimestampCache.has(mid)) {
          block = blockTimestampCache.get(mid);
        } else {
          try {
            block = await provider.getBlock(mid);
          // Cache recent blocks (within last 1000 blocks)
          if (mid > latestBlock.number - 1000) {
            blockTimestampCache.set(mid, block);
            // Limit cache size (remove oldest entries)
            if (blockTimestampCache.size > 100) {
              const keys = Array.from(blockTimestampCache.keys());
              // Remove the oldest (lowest block number)
              const oldestKey = Math.min(...keys);
              blockTimestampCache.delete(oldestKey);
            }
          }
        } catch (error) {
          console.warn(`Error fetching block ${mid}:`, error.message);
          // If block doesn't exist, adjust search
          if (error.message.includes('not found') || error.code === -32000) {
            high = mid - 1;
            continue;
          }
          throw error;
        }
      }
      
      if (block && block.timestamp <= targetTimestamp) {
        bestBlock = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    
    if (iterations >= maxIterations) {
      console.warn(`⚠️ Binary search hit max iterations, using best block ${bestBlock}`);
    }
    
    return bestBlock;
  } catch (error) {
    console.error('Error finding block at timestamp:', error);
    // Fallback: estimate based on average block time
    try {
      const latestBlock = await provider.getBlock('latest');
      const avgBlockTime = 2; // seconds (approximate for Ink Chain)
      const timeDiff = latestBlock.timestamp - targetTimestamp;
      const blocksAgo = Math.floor(timeDiff / avgBlockTime);
      const estimatedBlock = Math.max(0, latestBlock.number - blocksAgo);
      console.log(`📊 Using estimated block ${estimatedBlock} (fallback)`);
      return estimatedBlock;
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      // Last resort: return a safe default
      return 0;
    }
  }
}

/**
 * Helper function to safely convert timestamp (string, number, or BigNumber) to number
 */
function safeTimestampToNumber(timestamp) {
  if (typeof timestamp === 'string') {
    return parseInt(timestamp);
  } else if (typeof timestamp === 'number') {
    return timestamp;
  } else {
    // BigNumber - use toString() to avoid overflow
    return parseInt(timestamp.toString());
  }
}

/**
 * Use Alchemy Enhanced API for faster data fetching
 * Falls back to standard RPC if Alchemy is not available
 */
async function getAlchemyData(method, params = []) {
  if (!ALCHEMY_API_KEY || !ALCHEMY_RPC_URL) {
    return null; // Alchemy not configured
  }

  try {
    const response = await axios.post(ALCHEMY_RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: method,
      params: params
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (response.data && response.data.result) {
      return response.data.result;
    }
    return null;
  } catch (error) {
    console.warn(`⚠️ Alchemy API call failed for ${method}, falling back to RPC:`, error.message);
    return null;
  }
}

/**
 * Get transaction count using Alchemy's enhanced API (much faster)
 */
async function getTransactionCountAlchemy(contractAddress, blockNumber) {
  if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  // Try Alchemy's enhanced API first
  const alchemyResult = await getAlchemyData('eth_getTransactionCount', [contractAddress, `0x${blockNumber.toString(16)}`]);
  if (alchemyResult) {
    return parseInt(alchemyResult, 16);
  }

  // Fallback to standard RPC
  return await provider.getTransactionCount(contractAddress, blockNumber);
}

/**
 * Get unique addresses from blocks using Alchemy's getAssetTransfers (much faster than iterating)
 */
async function getActiveWalletsAlchemy(startBlock, endBlock) {
  if (!ALCHEMY_API_KEY || !ALCHEMY_RPC_URL) {
    return null;
  }

  try {
    // Use Alchemy's getAssetTransfers to get unique addresses quickly
    const response = await axios.post(ALCHEMY_RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromBlock: `0x${startBlock.toString(16)}`,
        toBlock: `0x${endBlock.toString(16)}`,
        category: ['external', 'erc20', 'erc721', 'erc1155'],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: '0x3e8' // 1000 transfers per call
      }]
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (response.data && response.data.result && response.data.result.transfers) {
      const uniqueAddresses = new Set();
      response.data.result.transfers.forEach(transfer => {
        if (transfer.from) uniqueAddresses.add(transfer.from.toLowerCase());
        if (transfer.to) uniqueAddresses.add(transfer.to.toLowerCase());
      });
      return uniqueAddresses.size;
    }
    return null;
  } catch (error) {
    console.warn(`⚠️ Alchemy getAssetTransfers failed, falling back:`, error.message);
    return null;
  }
}

/**
 * Get Ink Chain metrics via RPC
 * @param {string} metricType - Type of metric to fetch
 * @param {string|null} contractAddress - Optional contract address
 * @param {object|null} marketInfo - Optional market info with createdAt and deadline timestamps
 */
async function getInkChainMetrics(metricType, contractAddress = null, marketInfo = null) {
  try {
    console.log(`⛓️ Fetching Ink Chain metric: ${metricType}`);

    switch (metricType) {
      case 'transactions': {
        // Count actual transactions during market period (createdAt to deadline) from blockchain
        try {
          // If contract address provided, get contract-specific transaction count at deadline
          if (contractAddress && contractAddress !== '0x0000000000000000000000000000000000000000') {
            let targetBlock;
            
            if (marketInfo && marketInfo.deadline) {
              const deadlineTimestamp = safeTimestampToNumber(marketInfo.deadline);
              targetBlock = await getBlockAtTimestamp(deadlineTimestamp);
              console.log(`📅 Using block ${targetBlock} at market deadline for contract transactions`);
            } else {
              const latestBlock = await retryWithBackoff(async () => {
                return await provider.getBlock('latest');
              }, 3, 2000);
              targetBlock = latestBlock.number;
            }
            
            // Get actual transaction count from blockchain
            const txCount = await getTransactionCountAlchemy(contractAddress, targetBlock);
            if (txCount !== null && txCount !== undefined) {
              return { value: txCount, blockNumber: targetBlock, note: 'Contract transaction count at deadline' };
            } else {
              // Fallback to standard RPC if Alchemy fails
              const txCountRpc = await provider.getTransactionCount(contractAddress, targetBlock);
              return { value: txCountRpc, blockNumber: targetBlock, note: 'Contract transaction count at deadline (RPC fallback)' };
            }
          }

          // For network-wide transactions, count actual transactions during market period
          if (marketInfo && marketInfo.createdAt && marketInfo.deadline) {
            try {
              const createdAtTimestamp = safeTimestampToNumber(marketInfo.createdAt);
              const deadlineTimestamp = safeTimestampToNumber(marketInfo.deadline);
              
              const startBlock = await getBlockAtTimestamp(createdAtTimestamp);
              const endBlock = await getBlockAtTimestamp(deadlineTimestamp);
              
              console.log(`📅 Counting transactions in blocks ${startBlock} to ${endBlock} (market period)`);
              
              // Try Alchemy API first for fast, accurate results
              if (ALCHEMY_API_KEY && ALCHEMY_RPC_URL) {
                try {
                  // Use Alchemy's getAssetTransfers to count transactions
                  const response = await axios.post(ALCHEMY_RPC_URL, {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'alchemy_getAssetTransfers',
                    params: [{
                      fromBlock: `0x${startBlock.toString(16)}`,
                      toBlock: `0x${endBlock.toString(16)}`,
                      category: ['external'],
                      withMetadata: false,
                      excludeZeroValue: false,
                      maxCount: '0x3e8'
                    }]
                  }, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 15000
                  });

                  if (response.data && response.data.result && response.data.result.transfers) {
                    const txCount = response.data.result.transfers.length;
                    console.log(`✅ Alchemy API: Found ${txCount} transactions in market period`);
                    return { 
                      value: txCount, 
                      blockRange: `${startBlock}-${endBlock}`,
                      blockNumber: endBlock,
                      note: 'Alchemy API - actual transaction count'
                    };
                  }
                } catch (alchemyError) {
                  console.warn(`⚠️ Alchemy API failed, using RPC:`, alchemyError.message);
                }
              }
              
              // Fallback: Sample blocks and count actual transactions
              const blockRange = endBlock - startBlock;
              let totalTxCount = 0;
              
              if (blockRange <= 100) {
                // Small range: count all blocks
                console.log(`📊 Counting transactions in all ${blockRange} blocks...`);
                for (let i = startBlock; i <= endBlock; i++) {
                  try {
                    const block = await provider.getBlock(i);
                    totalTxCount += block.transactions.length;
                  } catch (err) {
                    console.warn(`Error fetching block ${i}:`, err.message);
                  }
                }
              } else {
                // Large range: sample blocks and extrapolate
                const sampleSize = Math.min(50, blockRange);
                const step = Math.max(1, Math.floor(blockRange / sampleSize));
                console.log(`📊 Sampling ${sampleSize} blocks (every ${step} blocks) to estimate transactions...`);
                
                let sampledTxCount = 0;
                let sampledBlocks = 0;
                
                for (let i = startBlock; i <= endBlock; i += step) {
                  try {
                    const block = await provider.getBlock(i);
                    sampledTxCount += block.transactions.length;
                    sampledBlocks++;
                  } catch (err) {
                    console.warn(`Error fetching block ${i}:`, err.message);
                  }
                }
                
                // Extrapolate to full range
                if (sampledBlocks > 0) {
                  const avgTxPerBlock = sampledTxCount / sampledBlocks;
                  totalTxCount = Math.floor(avgTxPerBlock * blockRange);
                  console.log(`📊 Extrapolated: ${totalTxCount} transactions (avg ${avgTxPerBlock.toFixed(2)} per block)`);
                }
              }
              
              return { 
                value: totalTxCount, 
                blockRange: `${startBlock}-${endBlock}`,
                blockNumber: endBlock,
                note: 'Actual transaction count from blockchain'
              };
            } catch (blockError) {
              console.error(`⚠️ Error counting transactions from blockchain:`, blockError.message);
              // Fall through to fallback
            }
          }

          // Fallback: use latest block if no market info (shouldn't happen in normal flow)
          const latestBlock = await provider.getBlock('latest');
          console.log(`⚠️ No market info, using latest block ${latestBlock.number} as fallback`);
          return { value: latestBlock.number, blockNumber: latestBlock.number, note: 'Fallback - no market period' };
        } catch (error) {
          console.error('Error counting transactions:', error);
          const latestBlock = await provider.getBlock('latest');
          return { value: latestBlock.number, blockNumber: latestBlock.number, note: 'Error fallback' };
        }
      }

      case 'block_number': {
        // Use block number at market deadline for deterministic result
        try {
          let targetBlock;
          
          if (marketInfo && marketInfo.deadline) {
            const deadlineTimestamp = safeTimestampToNumber(marketInfo.deadline);
            targetBlock = await getBlockAtTimestamp(deadlineTimestamp);
            const block = await provider.getBlock(targetBlock);
            console.log(`📅 Using block ${targetBlock} at market deadline`);
            return { value: targetBlock, timestamp: block.timestamp };
          } else {
            // Fallback: use latest block
        const latestBlock = await provider.getBlock('latest');
        return { value: latestBlock.number, timestamp: latestBlock.timestamp };
          }
        } catch (error) {
          console.error('Error getting block number:', error);
          const latestBlock = await provider.getBlock('latest');
          return { value: latestBlock.number, timestamp: latestBlock.timestamp };
        }
      }

      case 'tvl': {
        // Get TVL at market deadline for deterministic result
        try {
          let targetBlock;
          
          if (marketInfo && marketInfo.deadline) {
            const deadlineTimestamp = safeTimestampToNumber(marketInfo.deadline);
            targetBlock = await getBlockAtTimestamp(deadlineTimestamp);
            console.log(`📅 Using block ${targetBlock} at market deadline for TVL`);
          } else {
            const latestBlock = await provider.getBlock('latest');
            targetBlock = latestBlock.number;
          }

          // Get ETH balance of a contract (if provided) at target block
        if (contractAddress) {
            // Note: getBalance doesn't support block number directly in ethers v5
            // We'll use the balance at the target block by querying at that block
            const balance = await provider.getBalance(contractAddress, targetBlock);
          const ethBalance = parseFloat(ethers.utils.formatEther(balance));
            return { value: Math.floor(ethBalance * 1000), unit: 'ETH', blockNumber: targetBlock };
          }
          return { value: 0, unit: 'ETH', blockNumber: targetBlock };
        } catch (error) {
          console.error('Error getting TVL:', error);
          return { value: 0, unit: 'ETH', note: 'Error' };
        }
      }

      case 'gas_price': {
        // Get gas price at market deadline for deterministic result
        try {
          let targetBlock;
          
          if (marketInfo && marketInfo.deadline) {
            const deadlineTimestamp = safeTimestampToNumber(marketInfo.deadline);
            targetBlock = await getBlockAtTimestamp(deadlineTimestamp);
            console.log(`📅 Using block ${targetBlock} at market deadline for gas price`);
          } else {
            const latestBlock = await provider.getBlock('latest');
            targetBlock = latestBlock.number;
          }

          // Get gas price at target block
          const block = await provider.getBlock(targetBlock);
          const gasPrice = block.gasPrice || await provider.getGasPrice();
          const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));
          // Ensure we return at least 1 if gas price is very low (not 0)
          const value = Math.max(1, Math.floor(gwei));
          console.log(`Gas price at block ${targetBlock}: ${gwei} gwei → ${value} (rounded)`);
          return { value, unit: 'gwei', blockNumber: targetBlock };
        } catch (error) {
          console.error('Error getting gas price:', error);
          // Fallback
        const gasPrice = await provider.getGasPrice();
        const gwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));
          return { value: Math.max(1, Math.floor(gwei)), unit: 'gwei', note: 'Fallback' };
        }
      }

      case 'active_wallets': {
        // Count actual unique wallet addresses from blockchain during market period
        try {
          let startBlock, endBlock;
          
          if (marketInfo && marketInfo.createdAt && marketInfo.deadline) {
            const createdAtTimestamp = safeTimestampToNumber(marketInfo.createdAt);
            const deadlineTimestamp = safeTimestampToNumber(marketInfo.deadline);
            
            startBlock = await getBlockAtTimestamp(createdAtTimestamp);
            endBlock = await getBlockAtTimestamp(deadlineTimestamp);
            
            console.log(`📅 Counting active wallets in blocks ${startBlock} to ${endBlock} (market period)`);
            
            // Try Alchemy API first for fast, accurate results
            const alchemyCount = await getActiveWalletsAlchemy(startBlock, endBlock);
            if (alchemyCount !== null) {
              console.log(`✅ Alchemy API: Found ${alchemyCount} unique active wallets`);
              return { 
                value: alchemyCount, 
                blockRange: `${startBlock}-${endBlock}`,
                blockNumber: endBlock,
                note: 'Alchemy API - actual wallet count',
                marketPeriod: {
                  createdAt: marketInfo.createdAt,
                  deadline: marketInfo.deadline
                }
              };
            }
            
            // Fallback: Count actual unique addresses from blockchain blocks
            const uniqueAddresses = new Set();
            const blockRange = endBlock - startBlock;
            
            if (blockRange <= 100) {
              // Small range: check all blocks
              console.log(`📊 Checking all ${blockRange} blocks for unique addresses...`);
              for (let i = startBlock; i <= endBlock; i++) {
                try {
                  const block = await provider.getBlockWithTransactions(i);
                  if (block && block.transactions) {
                    for (const tx of block.transactions) {
                      if (tx && tx.from) {
                        uniqueAddresses.add(tx.from.toLowerCase());
                      }
                    }
                  }
                } catch (err) {
                  console.warn(`Error fetching block ${i}:`, err.message);
                }
              }
            } else {
              // Large range: sample blocks efficiently
              const sampleSize = Math.min(100, blockRange);
              const step = Math.max(1, Math.floor(blockRange / sampleSize));
              console.log(`📊 Sampling ${sampleSize} blocks (every ${step} blocks) to count unique addresses...`);
              
              for (let i = startBlock; i <= endBlock; i += step) {
                try {
                  const block = await provider.getBlockWithTransactions(i);
                  if (block && block.transactions) {
                    for (const tx of block.transactions) {
                      if (tx && tx.from) {
                        uniqueAddresses.add(tx.from.toLowerCase());
                      }
                    }
                  }
                } catch (err) {
                  console.warn(`Error fetching block ${i}:`, err.message);
                }
              }
              
              // Extrapolate for large ranges
              if (blockRange > sampleSize) {
                const sampledCount = uniqueAddresses.size;
                const extrapolationFactor = blockRange / sampleSize;
                const estimatedCount = Math.floor(sampledCount * Math.sqrt(extrapolationFactor)); // Use sqrt to account for overlap
                console.log(`📊 Extrapolated: ${estimatedCount} unique wallets (sampled ${sampledCount} from ${sampleSize} blocks)`);
                return {
                  value: estimatedCount,
                  blockRange: `${startBlock}-${endBlock}`,
                  blockNumber: endBlock,
                  note: 'Estimated from sampled blocks',
                  marketPeriod: {
                    createdAt: marketInfo.createdAt,
                    deadline: marketInfo.deadline
                  }
                };
              }
            }
            
            const count = uniqueAddresses.size;
            console.log(`✅ Found ${count} unique active wallet addresses in blocks ${startBlock}-${endBlock}`);
            return { 
              value: count, 
              blockRange: `${startBlock}-${endBlock}`,
              blockNumber: endBlock,
              note: 'Actual wallet count from blockchain',
              marketPeriod: {
                createdAt: marketInfo.createdAt,
                deadline: marketInfo.deadline
              }
            };
          } else {
            // No market info - use last 100 blocks as fallback
            const latestBlock = await provider.getBlock('latest');
            endBlock = latestBlock.number;
            startBlock = Math.max(0, endBlock - 100);
            console.log(`⚠️ No market info, using last 100 blocks (${startBlock}-${endBlock})`);
            
            const uniqueAddresses = new Set();
            for (let i = startBlock; i <= endBlock; i++) {
              try {
                const block = await provider.getBlockWithTransactions(i);
                if (block && block.transactions) {
                  for (const tx of block.transactions) {
                    if (tx && tx.from) {
                      uniqueAddresses.add(tx.from.toLowerCase());
                    }
                  }
                }
              } catch (err) {
                console.warn(`Error fetching block ${i}:`, err.message);
              }
            }
            
            return {
              value: uniqueAddresses.size,
              blockRange: `${startBlock}-${endBlock}`,
              blockNumber: endBlock,
              note: 'Fallback - last 100 blocks'
            };
          }
        } catch (error) {
          console.error(`Error getting active wallets:`, error.message);
          const latestBlock = await provider.getBlock('latest');
          return { value: latestBlock.number, blockNumber: latestBlock.number, note: 'Error fallback' };
        }
      }

      default:
        // Check if it's a Twitter metric being used for Ink Chain prediction
        const twitterMetrics = ['like', 'likes', 'retweet', 'retweets', 'reply', 'replies', 'view', 'views', 'bookmark', 'bookmarks'];
        if (twitterMetrics.includes(metricType.toLowerCase())) {
          console.error(`⚠️ Twitter metric type "${metricType}" used for Ink Chain prediction. Ink Chain metrics: transactions, block_number, tvl, gas_price, active_wallets`);
          return null;
        }
        
        // Try to map common aliases to supported metrics
        const metricAliases = {
          'users': 'active_wallets',
          'user': 'active_wallets',
          'wallets': 'active_wallets',
          'wallet': 'active_wallets',
          'contracts': 'transactions', // Approximate mapping
          'contract': 'transactions',
        };
        
        const mappedMetric = metricAliases[metricType.toLowerCase()];
        if (mappedMetric) {
          console.log(`⚠️ Mapping "${metricType}" to "${mappedMetric}" for Ink Chain prediction`);
          // Recursively call with mapped metric (preserve marketInfo)
          return await getInkChainMetrics(mappedMetric, contractAddress, marketInfo);
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

// COMMENTED OUT: Twitter predictions disabled, focusing on Ink Chain only
// async function createMarketForTweet(tweet) {
//   try {
//     const tweetId = tweet.id;
//     const currentLikes = tweet.public_metrics.like_count;
//     const targetLikes = Math.floor(currentLikes * 5); // Predict 5x growth
//     const deadline = Math.floor(Date.now() / 1000) + (MARKET_DURATION_HOURS * 3600);
//
//     console.log(`Creating market for tweet ${tweetId}`);
//     console.log(`Current likes: ${currentLikes}, Target: ${targetLikes}`);
//
//     const tx = await adminContract.createMarket(
//       tweetId,
//       targetLikes,
//       'like',
//       deadline
//     );
//
//     const receipt = await tx.wait();
//     console.log(`✅ Market created! TX: ${receipt.transactionHash}`);
//
//     return receipt;
//   } catch (error) {
//     console.error('Error creating market:', error.message);
//     return null;
//   }
// }
//
// async function scanAndCreateMarkets() {
//   console.log('🔍 Scanning for trending tweets...');
//
//   for (const account of WATCHED_ACCOUNTS) {
//     const tweets = await fetchRecentTweets(account.id);
//
//     for (const tweet of tweets) {
//       if (isTweetEligible(tweet)) {
//         const exists = await marketExists(tweet.id);
//
//         if (!exists) {
//           await createMarketForTweet(tweet);
//           // Add delay to avoid rate limiting
//           await new Promise(resolve => setTimeout(resolve, 2000));
//         }
//       }
//     }
//   }
//
//   console.log('✅ Scan complete');
// }
//
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
          const resolvedBets = totalWins + totalLosses;
          const winRate = resolvedBets > 0 ? (totalWins / resolvedBets) * 100 : 0;
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

          // Check and award achievements after stats update
          try {
            await checkAndAwardAchievements(supabase, userAddress, {
              total_bets: totalBets,
              total_wins: totalWins,
              total_losses: totalLosses,
              win_rate: winRate
            });
          } catch (achievementError) {
            console.error(`Error checking achievements for ${userAddress}:`, achievementError);
          }
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
/**
 * Retry function with exponential backoff for rate limit errors
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message?.includes('429') || 
                         error.message?.includes('rate limit') ||
                         error.message?.includes('too many requests') ||
                         error.code === 'ECONNRESET' ||
                         error.code === 'ETIMEDOUT';
      
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`⚠️ Rate limit hit, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function resolveExpiredMarkets() {
  console.log('🔮 Checking for expired markets...');

  try {
    // Wrap contract call in retry logic for rate limits
    const expiredMarketIds = await retryWithBackoff(async () => {
      return await contract.getUnresolvedExpiredMarkets();
    });

    console.log(`Found ${expiredMarketIds.length} expired markets`);

    if (expiredMarketIds.length === 0) {
      console.log('✅ No expired markets to resolve');
      return { resolved: 0, errors: [] };
    }

    // Process newest markets first (reverse order) - they're more likely to have bets
    // This prevents old empty markets from blocking newer ones with real bets
    const sortedMarketIds = [...expiredMarketIds].reverse();
    console.log(`Processing newest first: ${sortedMarketIds.slice(0, 5).map(id => id.toString()).join(', ')}...`);

    // With retry logic for rate limits, we can process more markets per run
    // Cron runs every 5 minutes, so we can process 5-7 markets per run safely
    // This allows us to clear the backlog faster while still respecting rate limits
    const MAX_MARKETS_PER_RUN = parseInt(process.env.MAX_MARKETS_PER_RUN) || 5;
    console.log(`📊 Processing up to ${MAX_MARKETS_PER_RUN} markets per run (${expiredMarketIds.length} total unresolved)`);
    
    let resolvedCount = 0;
    const errors = [];

    for (const marketId of sortedMarketIds) {
      // Stop after resolving MAX_MARKETS_PER_RUN markets
      if (resolvedCount >= MAX_MARKETS_PER_RUN) {
        const remaining = expiredMarketIds.length - resolvedCount;
        console.log(`✅ Resolved ${resolvedCount} markets this run (${remaining} remaining, will continue in next run)`);
        break;
      }

      try {
        console.log(`\n--- Processing Market #${marketId} ---`);
        
        // Wrap contract call in retry logic for rate limits
        let market;
        try {
          market = await retryWithBackoff(async () => {
            return await contract.markets(marketId);
          });
        } catch (marketError) {
          // If we can't fetch market data, log and skip
          const errorMsg = marketError.message || marketError.toString();
          console.error(`❌ Failed to fetch market ${marketId} data:`, {
            message: errorMsg,
            code: marketError.code,
            isOverflow: errorMsg.includes('overflow') || marketError.code === 'NUMERIC_FAULT',
            isContractError: errorMsg.includes('CALL_EXCEPTION') || marketError.code === 'CALL_EXCEPTION'
          });
          errors.push({ 
            marketId: marketId.toString(), 
            error: `Failed to fetch market data: ${errorMsg}`,
            code: marketError.code,
            isOverflow: errorMsg.includes('overflow'),
            isContractError: errorMsg.includes('CALL_EXCEPTION')
          });
          continue;
        }
        
        const totalPool = market.yesPool.add(market.noPool);

        // Skip markets with no bets
        if (totalPool.isZero()) {
          console.log(`⏭️  Skipping Market #${marketId}: No bets placed`);
          continue;
        }

        const tweetId = market.tweetId;
        
        // Handle potential overflow errors when converting to number
        let targetMetric;
        try {
          targetMetric = market.targetMetric.toNumber();
        } catch (overflowError) {
          console.error(`❌ Overflow error converting targetMetric for market ${marketId}:`, overflowError.message);
          errors.push({
            marketId: marketId.toString(),
            error: `Overflow error: targetMetric too large`,
            code: overflowError.code,
            isOverflow: true
          });
          continue;
        }
        
        const metricType = market.metricType;

        console.log(`\n--- Resolving Market #${marketId} ---`);
        console.log(`Tweet ID: ${tweetId}`);
        console.log(`Target: ${targetMetric} ${metricType}s`);
        console.log(`Total Pool: ${ethers.utils.formatUnits(totalPool, 6)} USDC`);

        let actualMetric = 0;

        // Detect Ink Chain markets:
        // 1. tweetId starts with 'ink_'
        // 2. metricType is an Ink Chain metric (not Twitter metrics)
        // 3. tweetId is not numeric (Twitter IDs are numeric strings)
        const inkChainMetrics = ['transactions', 'transaction', 'block_number', 'block_number_count', 'tvl', 'tvl_value', 'gas_price', 'gas_prices', 'active_wallets', 'users', 'user', 'wallets', 'wallet', 'contracts', 'contract'];
        const twitterMetrics = ['like', 'likes', 'retweet', 'retweets', 'reply', 'replies', 'view', 'views', 'bookmark', 'bookmarks'];
        const isNumericTweetId = /^\d+$/.test(tweetId);
        
        const isInkChainMarket = 
          tweetId.startsWith('ink_') ||
          (inkChainMetrics.includes(metricType.toLowerCase()) && !twitterMetrics.includes(metricType.toLowerCase())) ||
          (!isNumericTweetId && !twitterMetrics.includes(metricType.toLowerCase()));

        // Handle Ink Chain predictions
        if (isInkChainMarket) {
          console.log('⛓️ Fetching Ink Chain metrics...');
          // Pass market info for time-based metrics (like active_wallets)
          // Use toString() to avoid overflow errors with large BigNumber values
          const marketInfo = {
            createdAt: market.createdAt.toString(),
            deadline: market.deadline.toString()
          };
          // Wrap in retry logic for rate limits
          let inkMetrics;
          try {
            inkMetrics = await retryWithBackoff(async () => {
              return await getInkChainMetrics(metricType, market.inkContractAddress || null, marketInfo);
            }, 3, 2000); // Longer delay for RPC calls
          } catch (metricError) {
            console.error(`❌ Error fetching metrics for market ${marketId}:`, metricError.message);
            errors.push({ 
              marketId: marketId.toString(), 
              error: `Failed to fetch Ink Chain metrics: ${metricError.message}` 
            });
            continue;
          }
          
          if (inkMetrics && inkMetrics.value !== undefined) {
            actualMetric = typeof inkMetrics.value === 'number' ? inkMetrics.value : parseInt(inkMetrics.value);
            console.log(`✅ Fetched metric value: ${actualMetric} (type: ${typeof actualMetric})`);
          } else {
            console.error(`❌ Failed to fetch Ink Chain metrics for market ${marketId}`);
            console.error(`   - inkMetrics:`, inkMetrics);
            console.error(`   - metricType: ${metricType}`);
            console.error(`   - marketInfo:`, marketInfo);
            errors.push({ 
              marketId: marketId.toString(), 
              error: `Failed to fetch Ink Chain metrics - returned: ${JSON.stringify(inkMetrics)}` 
            });
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
        const winningPool = outcome ? market.yesPool : market.noPool;
        // totalPool already declared earlier in the function

        console.log(`Actual: ${actualMetric} ${metricType}s`);
        console.log(`Outcome: ${outcome ? '✅ YES (Target Reached)' : '❌ NO (Target Not Reached)'}`);
        console.log(`Winning Pool: ${ethers.utils.formatUnits(winningPool, 6)} USDC`);
        console.log(`Total Pool: ${ethers.utils.formatUnits(totalPool, 6)} USDC`);

        // Contract requires bets on winning side - skip if none
        if (winningPool.isZero()) {
          console.log(`⚠️ Market #${marketId}: No bets on winning side (contract will revert). Skipping to next market.`);
          continue;
        }
        
        console.log('⛓️ Submitting resolution to blockchain...');
        const tx = await retryWithBackoff(async () => {
          return await oracleContract.resolve(marketId, outcome, actualMetric);
        }, 3, 2000);
        console.log(`TX Hash: ${tx.hash}`);

        const receipt = await retryWithBackoff(async () => {
          return await tx.wait();
        }, 3, 2000);
        console.log(`✅ Market ${marketId} resolved! Gas Used: ${receipt.gasUsed.toString()}`);

        // Update Supabase
        try {
          await updateSupabaseAfterResolution(marketId, outcome, actualMetric, market);
        } catch (dbError) {
          console.warn('⚠️ Failed to update Supabase:', dbError.message);
        }

        resolvedCount++;

        // Delay between markets to avoid rate limits
        // Increased to 2 seconds to give RPC time to recover
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        const errorMsg = error.message || error.toString();
        const errorStack = error.stack || '';
        const errorCode = error.code || '';
        const errorData = error.data || '';
        
        console.error(`❌ Error resolving market ${marketId}:`, {
          message: errorMsg,
          code: errorCode,
          data: errorData ? errorData.substring(0, 200) : undefined,
          stack: errorStack ? errorStack.split('\n').slice(0, 3).join('\n') : undefined
        });
        
        // Check if it's a rate limit error
        const isRateLimit = errorMsg.includes('429') || 
                           errorMsg.includes('rate limit') ||
                           errorMsg.includes('too many requests') ||
                           errorCode === 'ECONNRESET' ||
                           errorCode === 'ETIMEDOUT';
        
        // Check if it's an overflow error (deadline too large)
        const isOverflow = errorMsg.includes('overflow') || 
                          errorMsg.includes('NUMERIC_FAULT') ||
                          errorCode === 'NUMERIC_FAULT';
        
        // Check if it's a contract call error
        const isContractError = errorMsg.includes('CALL_EXCEPTION') ||
                               errorMsg.includes('call revert') ||
                               errorCode === 'CALL_EXCEPTION';
        
        if (isRateLimit) {
          console.warn(`⚠️ Rate limit error for market ${marketId}, will retry in next run`);
        } else if (isOverflow) {
          console.warn(`⚠️ Overflow error for market ${marketId} - deadline value too large, skipping`);
        } else if (isContractError) {
          console.warn(`⚠️ Contract call error for market ${marketId} - may not exist or be invalid`);
        }
        
        errors.push({ 
          marketId: marketId.toString(), 
          error: errorMsg,
          code: errorCode,
          isRateLimit,
          isOverflow,
          isContractError
        });
        
        // Add extra delay after rate limit errors
        if (isRateLimit) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    const remaining = expiredMarketIds.length - resolvedCount;
    console.log(`\n🎉 Resolution complete! Resolved: ${resolvedCount}, Errors: ${errors.length}, Remaining: ${remaining}`);
    
    if (errors.length > 0) {
      const rateLimitErrors = errors.filter(e => e.isRateLimit).length;
      if (rateLimitErrors > 0) {
        console.warn(`⚠️ ${rateLimitErrors} rate limit error(s) - markets will retry in next run`);
      }
    }
    
    return { resolved: resolvedCount, errors, remaining };
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
 * NOTE: This endpoint is excluded from rate limiting (has its own auth)
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
    
    // For free cron services with 30s timeout, process asynchronously
    // Return immediately and process in background
    res.status(202).json({
      success: true,
      message: 'Resolution process started',
      timestamp: new Date().toISOString()
    });

    // Process markets in background (don't await - let it run async)
    resolveExpiredMarkets().catch(error => {
      console.error('Error in background resolution:', error);
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
    
    // For free cron services with 30s timeout, process asynchronously
    // Return immediately and process in background
    res.status(202).json({
      success: true,
      message: 'Resolution process started',
      timestamp: new Date().toISOString()
    });

    // Process markets in background (don't await - let it run async)
    resolveExpiredMarkets().catch(error => {
      console.error('Error in background resolution:', error);
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
 * GET /api/debug/resolution - Debug endpoint to check market resolution status
 */
app.get('/api/debug/resolution', async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Get market count from contract
    const marketCount = await contract.marketCount();
    console.log(`Total markets in contract: ${marketCount.toString()}`);

    // Get expired markets from contract
    const expiredMarketIds = await contract.getUnresolvedExpiredMarkets();
    console.log(`Expired markets returned: ${expiredMarketIds.map(id => id.toString())}`);

    // Check specific markets (79-85)
    const marketsToCheck = [79, 80, 81, 82, 83, 85];
    const marketDetails = [];

    for (const id of marketsToCheck) {
      try {
        if (id < marketCount.toNumber()) {
          const market = await contract.markets(id);
          const deadline = market.deadline.toNumber();
          const isExpired = deadline < now;
          const totalPool = market.yesPool.add(market.noPool);

          marketDetails.push({
            id,
            deadline,
            deadlineDate: new Date(deadline * 1000).toISOString(),
            isExpired,
            resolved: market.resolved,
            yesPool: ethers.utils.formatUnits(market.yesPool, 6),
            noPool: ethers.utils.formatUnits(market.noPool, 6),
            totalPool: ethers.utils.formatUnits(totalPool, 6),
            hasBets: !totalPool.isZero()
          });
        } else {
          marketDetails.push({ id, error: 'Market ID exceeds marketCount' });
        }
      } catch (err) {
        marketDetails.push({ id, error: err.message });
      }
    }

    res.json({
      success: true,
      currentTime: now,
      currentTimeISO: new Date(now * 1000).toISOString(),
      marketCount: marketCount.toString(),
      expiredMarketsFromContract: expiredMarketIds.map(id => id.toString()),
      checkedMarkets: marketDetails
    });
  } catch (error) {
    console.error('Debug resolution error:', error);
    res.status(500).json({ success: false, error: error.message });
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

    console.log(`📋 Creating ${enabledTemplates.length} predictions from templates...`);

    const createdMarkets = [];
    const errors = [];

    // Create all enabled templates
    for (const template of enabledTemplates) {
      try {
        console.log(`� Creating: "${template.question}"`);

        // Create the prediction
        const durationSeconds = template.durationHours * 3600;
        const deadline = Math.floor(Date.now() / 1000) + durationSeconds;

        // Contract expects: createMarket(tweetId, targetMetric, metricType, deadline)
        const tx = await adminContract.createMarket(
          template.question,
          template.targetMetric,
          template.metricType,
          deadline
        );

        const receipt = await tx.wait();

        // Parse events using contract interface
        let marketId;
        for (const log of receipt.logs) {
          try {
            const parsedLog = adminContract.interface.parseLog(log);
            if (parsedLog.name === 'MarketCreated') {
              marketId = parsedLog.args[0].toNumber();
              break;
            }
          } catch (e) {
            continue;
          }
        }

        if (!marketId) {
          throw new Error('MarketCreated event not found');
        }

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

        console.log(`✅ Created Market ID: ${marketId}`);
        createdMarkets.push({
          marketId,
          question: template.question,
          transactionHash: receipt.hash
        });

      } catch (error) {
        console.error(`❌ Error creating "${template.question}":`, error.message);
        errors.push({
          question: template.question,
          error: error.message
        });
      }
    }

    console.log(`\n🎉 Created ${createdMarkets.length} markets successfully!`);
    if (errors.length > 0) {
      console.log(`⚠️ ${errors.length} failed`);
    }

    res.json({
      success: true,
      created: createdMarkets.length,
      markets: createdMarkets,
      errors: errors.length > 0 ? errors : undefined
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
 * Helper function to check and award achievements based on user stats
 */
async function checkAndAwardAchievements(supabase, userAddress, stats) {
  const achievements = [];
  const userAddressLower = userAddress.toLowerCase();

  // Achievement definitions matching Achievements.jsx
  const achievementDefs = {
    // Betting milestones
    first_bet: { threshold: 1, xp: 50, check: () => stats.total_bets >= 1 },
    bet_10: { threshold: 10, xp: 100, check: () => stats.total_bets >= 10 },
    bet_50: { threshold: 50, xp: 250, check: () => stats.total_bets >= 50 },
    bet_100: { threshold: 100, xp: 500, check: () => stats.total_bets >= 100 },
    bet_500: { threshold: 500, xp: 1000, check: () => stats.total_bets >= 500 },
    
    // Winning achievements
    first_win: { threshold: 1, xp: 75, check: () => stats.total_wins >= 1 },
    win_10: { threshold: 10, xp: 200, check: () => stats.total_wins >= 10 },
    win_50: { threshold: 50, xp: 500, check: () => stats.total_wins >= 50 },
    win_rate_60: { 
      threshold: 0.6, 
      xp: 300, 
      check: () => {
        const resolvedBets = stats.total_wins + stats.total_losses;
        return resolvedBets >= 20 && stats.win_rate >= 60;
      }
    }
  };

  // Check each achievement
  for (const [achievementId, def] of Object.entries(achievementDefs)) {
    if (!def.check()) continue;

    // Check if already unlocked
    const { data: existing } = await supabase
      .from('user_achievements')
      .select('achievement_id')
      .eq('user_address', userAddressLower)
      .eq('achievement_id', achievementId)
      .single();

    if (existing) continue; // Already unlocked

    // Award achievement
    const { error: insertError } = await supabase
      .from('user_achievements')
      .insert([{
        user_address: userAddressLower,
        achievement_id: achievementId,
        xp_earned: def.xp,
        unlocked_at: new Date().toISOString()
      }]);

    if (!insertError) {
      // Award XP manually (same approach as referrals)
      const { data: stats } = await supabase
        .from('user_stats')
        .select('xp')
        .eq('user_address', userAddressLower)
        .single();

      const currentXp = stats?.xp || 0;
      const { error: xpError } = await supabase
        .from('user_stats')
        .upsert({
          user_address: userAddressLower,
          xp: currentXp + def.xp,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_address' });

      if (xpError) {
        console.error(`Error awarding XP for ${achievementId}:`, xpError);
      } else {
        console.log(`🏆 Achievement unlocked: ${achievementId} (+${def.xp} XP)`);
        achievements.push({ id: achievementId, xp: def.xp });
      }
    }
  }

  return achievements;
}

/**
 * GET /api/market/:id/comments - Get comments for a specific market
 */
app.get('/api/market/:id/comments', async (req, res) => {
  try {
    const marketId = req.params.id;
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.json({ success: true, comments: [] });
    }

    const { data: comments, error } = await supabase
      .from('market_comments')
      .select('*')
      .eq('market_id', marketId)
      .order('created_at', { ascending: false });

    if (error) {
      // If table doesn't exist, return empty array
      if (error.code === 'PGRST205') {
        return res.json({ success: true, comments: [] });
      }
      console.error('Error fetching comments:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    // Format comments for frontend
    const formattedComments = (comments || []).map(comment => ({
      id: comment.id,
      user: `${comment.user_address.slice(0, 6)}...${comment.user_address.slice(-4)}`,
      content: comment.content,
      timestamp: new Date(comment.created_at).getTime(),
      position: comment.position
    }));

    res.json({ success: true, comments: formattedComments });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/market/:id/comments - Post a comment on a market
 */
app.post('/api/market/:id/comments', async (req, res) => {
  try {
    const marketId = req.params.id;
    const { userAddress, content } = req.body;
    const supabase = require('./supabase-client');

    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database not available' });
    }

    if (!userAddress || !content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'userAddress and content are required' });
    }

    if (content.length > 500) {
      return res.status(400).json({ success: false, error: 'Comment must be 500 characters or less' });
    }

    const userAddressLower = userAddress.toLowerCase();

    // Check if user has bet on this market to determine position
    const { data: userBet } = await supabase
      .from('user_bets')
      .select('position')
      .eq('market_id', marketId)
      .eq('user_address', userAddressLower)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Insert comment
    const { data: comment, error: insertError } = await supabase
      .from('market_comments')
      .insert([{
        market_id: parseInt(marketId),
        user_address: userAddressLower,
        content: content.trim(),
        position: userBet?.position || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insertError) {
      if (insertError.code === 'PGRST205') {
        return res.status(500).json({ success: false, error: 'Comments table not found. Please create the market_comments table.' });
      }
      console.error('Error posting comment:', insertError);
      return res.status(500).json({ success: false, error: insertError.message });
    }

    // Award 5 XP for commenting
    const COMMENT_XP = 5;
    
    // Get current XP
    const { data: userStats } = await supabase
      .from('user_stats')
      .select('xp')
      .eq('user_address', userAddressLower)
      .single();

    const currentXp = userStats?.xp || 0;
    
    // Update XP in user_stats
    const { error: xpError } = await supabase
      .from('user_stats')
      .upsert({
        user_address: userAddressLower,
        xp: currentXp + COMMENT_XP,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_address' });

    if (xpError) {
      console.error('Error awarding XP for comment:', xpError);
    } else {
      console.log(`💬 Comment posted by ${userAddressLower} on market ${marketId} (+${COMMENT_XP} XP)`);
    }

    // Format response
    const formattedComment = {
      id: comment.id,
      user: `${comment.user_address.slice(0, 6)}...${comment.user_address.slice(-4)}`,
      content: comment.content,
      timestamp: new Date(comment.created_at).getTime(),
      position: comment.position
    };

    res.json({ 
      success: true, 
      comment: formattedComment,
      xpAwarded: COMMENT_XP
    });
  } catch (error) {
    console.error('Error posting comment:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/market/:id/bets - Get recent bets for a specific market
 */
app.get('/api/market/:id/bets', async (req, res) => {
  try {
    const marketId = req.params.id;
    const supabase = require('./supabase-client');

    // Try to fetch from Supabase first
    if (supabase) {
      const { data: bets, error: betsError } = await supabase
        .from('user_bets')
        .select('*')
        .eq('market_id', marketId)
        .order('created_at', { ascending: false });
        // No limit - show all bets for complete history

      if (!betsError && bets) {
        const formattedBets = bets.map(bet => ({
          id: bet.id,
          userAddress: bet.user_address,
          amount: bet.amount?.toString() || '0',
          position: bet.position === true || bet.position === 'true' || bet.position === 'YES',
          createdAt: bet.created_at,
          timestamp: bet.created_at ? new Date(bet.created_at).getTime() : Date.now(),
          claimed: bet.claimed || false,
          won: bet.won,
          payout: bet.payout,
          resolved: bet.won !== null && bet.won !== undefined // Market is resolved if won is not null
        }));

        return res.json({ success: true, bets: formattedBets });
      } else if (betsError) {
        console.error('Supabase bets error:', betsError);
      }
    }

    // Fallback: fetch from blockchain (if we have events or need to query contract)
    // For now, return empty array if Supabase fails
    res.json({ success: true, bets: [] });
  } catch (error) {
    console.error('Error fetching recent bets:', error);
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
            id: bet.id, // Include unique ID for React keys
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
              id: bet.id, // Include unique ID for React keys
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

    const timeframe = (req.query.timeframe || 'all').toLowerCase();

    if (timeframe == 'xp') {
      const { data: statsRows, error: statsError } = await supabase
        .from('user_stats')
        .select('user_address, xp, total_wins, total_volume, current_streak, win_rate');

      if (statsError) {
        console.error('Error fetching XP leaderboard stats:', statsError);
        return res.status(500).json({ success: false, error: statsError.message });
      }

      const { data: dailyRows, error: dailyError } = await supabase
        .from('user_daily_rewards')
        .select('user_address, total_xp_earned');

      if (dailyError) {
        console.error('Error fetching daily rewards for XP leaderboard:', dailyError);
        return res.status(500).json({ success: false, error: dailyError.message });
      }

      const dailyMap = new Map();
      for (const row of dailyRows || []) {
        dailyMap.set(row.user_address, row.total_xp_earned || 0);
      }

      const statsMap = new Map();
      for (const row of statsRows || []) {
        statsMap.set(row.user_address, row);
      }

      const merged = [];
      for (const row of statsRows || []) {
        const dailyXp = dailyMap.get(row.user_address) || 0;
        const totalXp = (row.xp || 0) + dailyXp;
        merged.push({
          user_address: row.user_address,
          total_wins: row.total_wins || 0,
          total_volume: row.total_volume || 0,
          current_streak: row.current_streak || 0,
          win_rate: row.win_rate || 0,
          xp: totalXp
        });
      }

      for (const row of dailyRows || []) {
        if (!statsMap.has(row.user_address)) {
          const totalXp = row.total_xp_earned || 0;
          merged.push({
            user_address: row.user_address,
            total_wins: 0,
            total_volume: 0,
            current_streak: 0,
            win_rate: 0,
            xp: totalXp
          });
        }
      }

      const leaderboard = merged
        .filter(entry => (entry.xp || 0) > 0)
        .sort((a, b) => (b.xp || 0) - (a.xp || 0))
        .slice(0, 100)
        .map((entry, index) => ({
          ...entry,
          rank: index + 1
        }));

      return res.json({
        success: true,
        leaderboard
      });
    }

    // Default leaderboard view (sorted by win_rate descending)
    const { data: leaderboard, error } = await supabase
      .from('leaderboard')
      .select('*')
      .order('win_rate', { ascending: false })
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
app.post('/api/user/bet', writeLimiter, async (req, res) => {
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

    // Update user_stats immediately with new bet count
    const userAddressLower = userAddress.toLowerCase();
    let totalBets = 0;
    let achievementUnlocked = null;
    let xpAwarded = 0;

    try {
      // Count all bets for this user (including the one just placed)
      const { count: betCount, error: countError } = await supabase
        .from('user_bets')
        .select('*', { count: 'exact', head: true })
        .eq('user_address', userAddressLower);

      if (countError) {
        console.error('Error counting bets:', countError);
      } else {
        totalBets = betCount || 0;
      }

      // Get existing stats to preserve other fields
      const { data: existingStats } = await supabase
        .from('user_stats')
        .select('total_wins, total_losses, total_volume, win_rate, xp')
        .eq('user_address', userAddressLower)
        .single();

      // Calculate total volume
      const { data: allBets } = await supabase
        .from('user_bets')
        .select('amount')
        .eq('user_address', userAddressLower);

      const totalVolume = allBets?.reduce((sum, b) => sum + parseFloat(b.amount || 0), 0) || 0;

      // Update user_stats with new bet count
      await supabase
        .from('user_stats')
        .upsert({
          user_address: userAddressLower,
          total_bets: totalBets,
          total_wins: existingStats?.total_wins || 0,
          total_losses: existingStats?.total_losses || 0,
          total_volume: totalVolume,
          total_winnings: existingStats?.total_winnings || 0,
          win_rate: existingStats?.win_rate || 0,
          xp: existingStats?.xp || 0,
          current_streak: existingStats?.current_streak || 0,
          longest_streak: existingStats?.longest_streak || 0,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_address' });

      // Check and award achievements based on updated stats
      const achievements = await checkAndAwardAchievements(supabase, userAddress, {
        total_bets: totalBets,
        total_wins: existingStats?.total_wins || 0,
        total_losses: existingStats?.total_losses || 0,
        win_rate: existingStats?.win_rate || 0
      });

      if (achievements.length > 0) {
        // Return the first achievement unlocked (most relevant)
        achievementUnlocked = achievements[0].id;
        xpAwarded = achievements.reduce((sum, a) => sum + a.xp, 0);
        console.log(`🏆 Achievement unlocked: ${achievementUnlocked} (+${xpAwarded} XP)`);
      }
    } catch (achievementFlowError) {
      console.error('Error checking achievements:', achievementFlowError);
    }

    console.log(`✅ Bet recorded: User ${userAddress}, Market ${marketId}, Amount ${amount} USDC, Position ${position ? 'YES' : 'NO'}`);

    res.json({
      success: true,
        bet: bet[0],
        achievementUnlocked,
        xpAwarded
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

    // Validate required fields
    if (!userAddress || typeof userAddress !== 'string' || !userAddress.trim()) {
      return res.status(400).json({
        success: false,
        error: 'userAddress is required and must be a non-empty string'
      });
    }

    if (marketId === undefined || marketId === null || marketId === '') {
      return res.status(400).json({
        success: false,
        error: 'marketId is required'
      });
    }

    const parsedMarketId = parseInt(marketId);
    if (isNaN(parsedMarketId)) {
      return res.status(400).json({
        success: false,
        error: 'marketId must be a valid number'
      });
    }

    console.log(`💰 Claim request: User ${userAddress}, Market #${parsedMarketId}, TX: ${transactionHash || 'N/A'}`);

    // Update the bet as claimed
    // Handle both boolean and string values for 'won' field
    const { data, error, count } = await supabase
      .from('user_bets')
      .update({ claimed: true })
      .eq('user_address', userAddress.toLowerCase())
      .eq('market_id', parsedMarketId)
      .in('won', [true, 'true', 'TRUE', 1, '1'])
      .select();

    if (error) {
      console.error('Error updating claim status:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    if (!data || data.length === 0) {
      // Log diagnostic info to help debug
      const { data: diagnosticData } = await supabase
        .from('user_bets')
        .select('id, won, claimed, user_address, market_id')
        .eq('user_address', userAddress.toLowerCase())
        .eq('market_id', parsedMarketId);
      
      console.warn(`⚠️ No rows updated for claim. Diagnostic:`, {
        userAddress: userAddress.toLowerCase(),
        marketId: parsedMarketId,
        matchingBets: diagnosticData,
        wonValues: diagnosticData?.map(b => ({ id: b.id, won: b.won, wonType: typeof b.won }))
      });

      return res.status(404).json({
        success: false,
        error: 'No winning bet found for this user and market',
        diagnostic: {
          matchingBets: diagnosticData?.length || 0,
          wonValues: diagnosticData?.map(b => ({ id: b.id, won: b.won, wonType: typeof b.won }))
        }
      });
    }

    console.log(`✅ Bet claimed: Market #${parsedMarketId}, User ${userAddress}, Updated ${data.length} row(s)`);

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

    console.log(`💰 User ${address} claiming daily reward...`);

    // Call the database function - it handles ALL streak logic and XP calculation
    const { data, error } = await supabase
      .rpc('claim_daily_reward', {
        p_user_address: address
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

    // The database function returns the actual XP earned and day number
    const dayInWeek = result.day_in_week || 1;
    const xpEarned = result.xp_earned || 10;

    console.log(`✅ User ${address} claimed Day ${dayInWeek} reward: ${xpEarned} XP (new streak: ${result.new_streak})`);

    res.json({
      success: true,
      reward: {
        xp: xpEarned,
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
 * GET /api/referrals/:address - Get referral info for a user
 */
app.get('/api/referrals/:address', async (req, res) => {
  try {
    const supabase = require('./supabase-client');
    const address = req.params.address.toLowerCase();

    if (!supabase) {
      return res.json({
        success: true,
        code: null,
        totalReferrals: 0,
        totalXpEarned: 0
      });
    }

    // Get referral code from referral_codes table (which already has total_referrals and total_xp_earned)
    let { data: referral, error } = await supabase
      .from('referral_codes')
      .select('*')
      .eq('referrer_address', address)
      .single();

    if (error && error.code === 'PGRST116') {
      // No referral code exists yet
      return res.json({
        success: true,
        code: null,
        totalReferrals: 0,
        totalXpEarned: 0
      });
    } else if (error) {
      console.error('Error fetching referral:', error);
      // If table doesn't exist, return empty (will be created on first use)
      if (error.code === 'PGRST205') {
        return res.json({
          success: true,
          code: null,
          totalReferrals: 0,
          totalXpEarned: 0
        });
      }
      return res.status(500).json({ success: false, error: error.message });
    }

    // Use the already calculated values from the database
    res.json({
      success: true,
      code: referral.code,
      totalReferrals: referral.total_referrals || 0,
      totalXpEarned: referral.total_xp_earned || 0
    });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/referrals/create - Create a referral code
 */
app.post('/api/referrals/create', writeLimiter, async (req, res) => {
  try {
    const supabase = require('./supabase-client');
    const { userAddress, signature } = req.body;

    if (!userAddress || !signature) {
      return res.status(400).json({
        success: false,
        error: 'userAddress and signature are required'
      });
    }

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    const address = userAddress.toLowerCase();

    // Verify signature
    const message = `Boink Referral: Create code for ${address}`;
    try {
      const recoveredAddress = ethers.utils.verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== address) {
        return res.status(401).json({
          success: false,
          error: 'Invalid signature'
        });
      }
    } catch (sigError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid signature format'
      });
    }

    // Check if referral code already exists
    let { data: existing, error: checkError } = await supabase
      .from('referral_codes')
      .select('*')
      .eq('referrer_address', address)
      .single();

    if (existing) {
      // Code already exists, return it with current stats
      return res.json({
        success: true,
        code: existing.code,
        totalReferrals: existing.total_referrals || 0,
        totalXpEarned: existing.total_xp_earned || 0
      });
    }

    // Generate unique referral code (first 8 chars of address + random)
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const code = `${address.substring(2, 6).toUpperCase()}${randomSuffix}`;

    // Insert referral code with initial stats
    const { data: newReferral, error: insertError } = await supabase
      .from('referral_codes')
      .insert([{
        referrer_address: address,
        code: code,
        signature: signature,
        total_referrals: 0,
        total_xp_earned: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insertError) {
      console.error('Error creating referral code:', insertError);
      return res.status(500).json({ success: false, error: insertError.message });
    }

    console.log(`✅ Referral code created: ${code} for ${address}`);

    res.json({
      success: true,
      code: newReferral.code,
      totalReferrals: 0,
      totalXpEarned: 0
    });
  } catch (error) {
    console.error('Error creating referral code:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/referrals/status/:address - Check if user has redeemed a referral
 */
app.get('/api/referrals/status/:address', async (req, res) => {
  try {
    const supabase = require('./supabase-client');
    const address = req.params.address.toLowerCase();

    if (!supabase) {
      return res.json({
        success: true,
        redeemed: false
      });
    }

    // Check if user has been referred (is a referee) using referral_uses table
    const { data: referral, error } = await supabase
      .from('referral_uses')
      .select('*')
      .eq('referee_address', address)
      .single();

    if (error && error.code === 'PGRST116') {
      // Not redeemed
      return res.json({
        success: true,
        redeemed: false
      });
    } else if (error) {
      console.error('Error checking referral status:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      redeemed: !!referral
    });
  } catch (error) {
    console.error('Error checking referral status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/referrals/redeem - Redeem a referral code
 */
app.post('/api/referrals/redeem', writeLimiter, async (req, res) => {
  try {
    const supabase = require('./supabase-client');
    const { refereeAddress, code } = req.body;

    if (!refereeAddress || !code) {
      return res.status(400).json({
        success: false,
        error: 'refereeAddress and code are required'
      });
    }

    if (!supabase) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    const address = refereeAddress.toLowerCase();
    const codeUpper = code.trim().toUpperCase();

    // Check if user has already redeemed a referral
    const { data: existingRedeem, error: checkError } = await supabase
      .from('referral_uses')
      .select('*')
      .eq('referee_address', address)
      .single();

    if (existingRedeem) {
      return res.status(400).json({
        success: false,
        error: 'You have already redeemed a referral code'
      });
    }

    // Find referral code
    const { data: referralCode, error: findError } = await supabase
      .from('referral_codes')
      .select('*')
      .eq('code', codeUpper)
      .single();

    if (findError || !referralCode) {
      return res.status(404).json({
        success: false,
        error: 'Invalid referral code'
      });
    }

    // Can't refer yourself
    if (referralCode.referrer_address.toLowerCase() === address) {
      return res.status(400).json({
        success: false,
        error: 'You cannot use your own referral code'
      });
    }

    // Record the referral use (with XP amounts)
    const { error: insertError } = await supabase
      .from('referral_uses')
      .insert([{
        referrer_address: referralCode.referrer_address,
        referee_address: address,
        code: codeUpper,
        xp_referrer: 10,
        xp_referee: 5,
        created_at: new Date().toISOString()
      }]);

    if (insertError) {
      console.error('Error recording referral use:', insertError);
      return res.status(500).json({ success: false, error: insertError.message });
    }

    // Update referral_codes table with new totals
    const newTotalReferrals = (referralCode.total_referrals || 0) + 1;
    const newTotalXpEarned = (referralCode.total_xp_earned || 0) + 10;
    
    await supabase
      .from('referral_codes')
      .update({
        total_referrals: newTotalReferrals,
        total_xp_earned: newTotalXpEarned,
        updated_at: new Date().toISOString()
      })
      .eq('code', codeUpper);

    // Award XP to referee (5 XP)
    const { data: refereeStats } = await supabase
      .from('user_stats')
      .select('xp')
      .eq('user_address', address)
      .single();

    const refereeCurrentXp = refereeStats?.xp || 0;
    await supabase
      .from('user_stats')
      .upsert({
        user_address: address,
        xp: refereeCurrentXp + 5,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_address' });

    // Award XP to referrer (10 XP)
    const { data: referrerStats } = await supabase
      .from('user_stats')
      .select('xp')
      .eq('user_address', referralCode.referrer_address)
      .single();

    const referrerCurrentXp = referrerStats?.xp || 0;
    await supabase
      .from('user_stats')
      .upsert({
        user_address: referralCode.referrer_address,
        xp: referrerCurrentXp + 10,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_address' });

    console.log(`✅ Referral redeemed: Code ${codeUpper}, Referee ${address}, Referrer ${referralCode.referrer_address}`);

    res.json({
      success: true,
      message: 'Referral code redeemed successfully'
    });
  } catch (error) {
    console.error('Error redeeming referral:', error);
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
 * COMMENTED OUT: Twitter predictions disabled, focusing on Ink Chain only
 * Use /api/admin/predictions endpoint for creating Ink Chain predictions instead
 */
/*
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
*/

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

      // Pass market info for time-based metrics (like active_wallets)
      const marketInfo = {
        createdAt: market.createdAt,
        deadline: market.deadline
      };
      const inkMetrics = await getInkChainMetrics(metricType, market.inkContractAddress || null, marketInfo);
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
    console.log(`📊 Contract: ${CONTRACT_ADDRESS}`);
    console.log(`🔗 RPC: ${process.env.INK_CHAIN_RPC}`);
    console.log(`⏰ Oracle running, will check markets every minute`);
    console.log(`🐦 Twitter integration active`);
  });
}

module.exports = app;
module.exports.resolveExpiredMarkets = resolveExpiredMarkets;
module.exports.getInkChainMetrics = getInkChainMetrics;

// ============ Error Handling ============

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});
