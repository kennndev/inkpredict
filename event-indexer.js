const { ethers } = require('ethers');
const supabase = require('./supabase-client');

/**
 * Event Indexer for InkPredict Contract
 * Listens to MarketResolved and WinningsClaimed events
 * Updates user_bets and user_stats tables in Supabase
 */

class EventIndexer {
  constructor(contract, provider) {
    this.contract = contract;
    this.provider = provider;
    this.isRunning = false;
  }

  /**
   * Start listening to contract events
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️ Event indexer already running');
      return;
    }

    console.log('🎧 Starting event indexer...');
    
    // Sync historical events first (last 1000 blocks to catch recent activity)
    await this.syncHistoricalEvents(1000);

    // Listen to new events
    this.setupEventListeners();
    
    this.isRunning = true;
    console.log('✅ Event indexer started successfully');
  }

  /**
   * Setup real-time event listeners
   */
  setupEventListeners() {
    // Listen to MarketResolved events
    this.contract.on('MarketResolved', async (marketId, outcome, finalMetric, event) => {
      console.log(`📊 MarketResolved event detected: Market ${marketId}`);
      await this.handleMarketResolved(marketId, outcome, finalMetric, event);
    });

    // Listen to WinningsClaimed events
    this.contract.on('WinningsClaimed', async (marketId, winner, amount, event) => {
      console.log(`💰 WinningsClaimed event detected: ${winner} claimed ${ethers.utils.formatUnits(amount, 6)} USDC`);
      await this.handleWinningsClaimed(marketId, winner, amount, event);
    });

    console.log('👂 Listening for MarketResolved and WinningsClaimed events');
  }

  /**
   * Sync historical events from the blockchain
   */
  async syncHistoricalEvents(blockRange = 1000) {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - blockRange);

      console.log(`🔄 Syncing events from block ${fromBlock} to ${currentBlock}...`);

      // Fetch MarketResolved events
      const resolvedFilter = this.contract.filters.MarketResolved();
      const resolvedEvents = await this.contract.queryFilter(resolvedFilter, fromBlock, currentBlock);
      
      console.log(`Found ${resolvedEvents.length} MarketResolved events`);
      
      for (const event of resolvedEvents) {
        await this.handleMarketResolved(
          event.args.marketId,
          event.args.outcome,
          event.args.finalMetric,
          event
        );
      }

      // Fetch WinningsClaimed events
      const claimedFilter = this.contract.filters.WinningsClaimed();
      const claimedEvents = await this.contract.queryFilter(claimedFilter, fromBlock, currentBlock);
      
      console.log(`Found ${claimedEvents.length} WinningsClaimed events`);
      
      for (const event of claimedEvents) {
        await this.handleWinningsClaimed(
          event.args.marketId,
          event.args.winner,
          event.args.amount,
          event
        );
      }

      console.log(`✅ Historical sync complete`);
    } catch (error) {
      console.error('Error syncing historical events:', error);
    }
  }

  /**
   * Handle MarketResolved event
   * Updates all bets for this market with outcome and payout
   */
  async handleMarketResolved(marketId, outcome, finalMetric, event) {
    try {
      if (!supabase) {
        console.warn('⚠️ Supabase not available, skipping bet update');
        return;
      }

      const marketIdNum = marketId.toNumber();
      const outcomeWon = outcome; // true = YES won, false = NO won

      console.log(`Resolving market ${marketIdNum}: outcome=${outcomeWon}, finalMetric=${finalMetric}`);

      // Get market data to calculate payouts
      const market = await this.contract.markets(marketId);
      const totalPool = market.yesPool.add(market.noPool);
      const winningPool = outcomeWon ? market.yesPool : market.noPool;
      const losingPool = outcomeWon ? market.noPool : market.yesPool;

      // Update prediction in database
      const { error: predError } = await supabase
        .from('predictions')
        .update({
          resolved: true,
          outcome: outcomeWon,
          final_metric: finalMetric.toNumber()
        })
        .eq('market_id', marketIdNum);

      if (predError) {
        console.error('Error updating prediction:', predError);
      }

      // Get all bets for this market
      const { data: bets, error: betsError } = await supabase
        .from('user_bets')
        .select('*')
        .eq('market_id', marketIdNum);

      if (betsError) {
        console.error('Error fetching bets:', betsError);
        return;
      }

      if (!bets || bets.length === 0) {
        console.log(`No bets found in database for market ${marketIdNum}`);
        return;
      }

      console.log(`Updating ${bets.length} bets for market ${marketIdNum}`);

      // Update each bet with outcome and payout
      for (const bet of bets) {
        const won = bet.position === outcomeWon;
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

        // Update bet record
        const { error: updateError } = await supabase
          .from('user_bets')
          .update({
            won: won,
            payout: payout
          })
          .eq('id', bet.id);

        if (updateError) {
          console.error(`Error updating bet ${bet.id}:`, updateError);
        }
      }

      // Update user stats for all affected users
      const uniqueUsers = [...new Set(bets.map(b => b.user_address))];
      for (const userAddress of uniqueUsers) {
        await this.updateUserStats(userAddress);
      }

      console.log(`✅ Market ${marketIdNum} resolved and ${bets.length} bets updated`);
    } catch (error) {
      console.error('Error handling MarketResolved event:', error);
    }
  }

  /**
   * Handle WinningsClaimed event
   * Marks bet as claimed
   */
  async handleWinningsClaimed(marketId, winner, amount, event) {
    try {
      if (!supabase) {
        console.warn('⚠️ Supabase not available, skipping claim update');
        return;
      }

      const marketIdNum = marketId.toNumber();
      const winnerAddress = winner.toLowerCase();

      // Mark bet as claimed
      const { error } = await supabase
        .from('user_bets')
        .update({ claimed: true })
        .eq('market_id', marketIdNum)
        .eq('user_address', winnerAddress);

      if (error) {
        console.error('Error marking bet as claimed:', error);
      } else {
        console.log(`✅ Bet claimed: Market ${marketIdNum}, User ${winnerAddress}`);
      }
    } catch (error) {
      console.error('Error handling WinningsClaimed event:', error);
    }
  }

  /**
   * Recalculate and update user statistics
   */
  async updateUserStats(userAddress) {
    try {
      if (!supabase) return;

      const address = userAddress.toLowerCase();

      // Get all bets for this user
      const { data: bets, error: betsError } = await supabase
        .from('user_bets')
        .select('*')
        .eq('user_address', address);

      if (betsError) {
        console.error('Error fetching user bets:', betsError);
        return;
      }

      if (!bets || bets.length === 0) {
        return;
      }

      // Calculate stats
      const totalBets = bets.length;
      const totalWins = bets.filter(b => b.won === true).length;
      const totalLosses = bets.filter(b => b.won === false).length;
      const totalVolume = bets.reduce((sum, b) => sum + parseFloat(b.amount || 0), 0);
      const totalWinnings = bets.reduce((sum, b) => sum + parseFloat(b.payout || 0), 0);
      const winRate = totalBets > 0 ? (totalWins / totalBets) * 100 : 0;
      const lastBetAt = bets.length > 0 ? bets[bets.length - 1].created_at : null;

      // Upsert user stats
      const { error: statsError } = await supabase
        .from('user_stats')
        .upsert({
          user_address: address,
          total_bets: totalBets,
          total_wins: totalWins,
          total_losses: totalLosses,
          total_volume: totalVolume,
          total_winnings: totalWinnings,
          win_rate: winRate,
          last_bet_at: lastBetAt,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_address'
        });

      if (statsError) {
        console.error('Error updating user stats:', statsError);
      } else {
        console.log(`📊 Updated stats for ${address}: ${totalWins}W/${totalLosses}L, ${winRate.toFixed(1)}% win rate`);
      }
    } catch (error) {
      console.error('Error updating user stats:', error);
    }
  }

  /**
   * Stop the event indexer
   */
  stop() {
    if (!this.isRunning) return;
    
    this.contract.removeAllListeners('MarketResolved');
    this.contract.removeAllListeners('WinningsClaimed');
    
    this.isRunning = false;
    console.log('🛑 Event indexer stopped');
  }
}

module.exports = EventIndexer;
