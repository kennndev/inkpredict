# Finding Real Tweet IDs for Markets

To make the markets show actual tweets, you need to use real tweet IDs. Here's how:

## How to Get Tweet IDs

### Method 1: From Twitter URL
1. Go to any tweet on Twitter/X
2. Look at the URL: `https://twitter.com/username/status/1234567890123456789`
3. The number at the end is the tweet ID: `1234567890123456789`

### Method 2: Using Twitter API
The backend already has Twitter API integration! You can:
1. Search for tweets from specific accounts
2. Get recent popular tweets
3. Use those tweet IDs in markets

## Example Real Tweet IDs

Here are some recent popular crypto tweets you can use:

**Vitalik Buterin (@VitalikButerin):**
- Check: https://twitter.com/VitalikButerin
- Copy any tweet ID from recent posts

**CZ (@cz_binance):**
- Check: https://twitter.com/cz_binance
- Use recent announcement tweet IDs

**Coinbase (@coinbase):**
- Check: https://twitter.com/coinbase
- Use product launch tweet IDs

## Quick Test

To test with a real tweet right now:

1. Go to any popular crypto tweet
2. Copy the tweet ID from the URL
3. Update one market in `create-sample-markets.js`:

```javascript
{
  tweetId: 'PASTE_REAL_TWEET_ID_HERE',
  targetMetric: 5000,
  metricType: 'like',
  durationHours: 24
}
```

4. Run: `node scripts/create-sample-markets.js`

## The Result

With real tweet IDs, your market cards will show:
- ✅ **The actual tweet** (embedded)
- ✅ **The prediction question**: "Will this tweet reach 5K likes?"
- ✅ **Current progress** vs target
- ✅ **Betting odds** in USDC

Users can see exactly what they're betting on!

## For Production

When you go live, the backend's Twitter integration will:
1. Monitor specific accounts automatically
2. Create markets for trending tweets
3. Use real tweet IDs from the Twitter API
4. Update metrics in real-time

For now, just grab a few real tweet IDs manually to test the display!
