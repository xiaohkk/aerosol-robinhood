import Redis from 'ioredis';
import { XScraper as Scraper, SearchMode } from './xClient';
// @ts-ignore: no declaration file for module 'node-cron'
import cron from 'node-cron';
import { getUsername } from '@/types/username';
import { PrivyClient } from '@privy-io/server-auth';
import dotenv from 'dotenv';
import { Ollama } from "@langchain/ollama";
import { ChatGroq } from "@langchain/groq";
import axios from 'axios';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { connectToSupabase } from '@/config/supabase';
import { v4 as uuidv4 } from 'uuid';
import { getUserBalance, updateUserBalance } from '@/api/routes/user/userBalanceRoutes';
import { NATIVE_SYMBOL, txExplorerUrl } from '@/config/chain';

dotenv.config();

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

async function reconnectWithRetry(service: string, connectFn: () => Promise<any>): Promise<any> {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            console.log(`Attempting to reconnect to ${service} (attempt ${i + 1}/${MAX_RETRIES})`);
            return await connectFn();
        } catch (error) {
            console.error(`Failed to reconnect to ${service}:`, error);
            if (i < MAX_RETRIES - 1) {
                console.log(`Waiting ${RETRY_DELAY}ms before next retry...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                throw new Error(`Failed to reconnect to ${service} after ${MAX_RETRIES} attempts`);
            }
        }
    }
}

// --- Global Error Handlers (Add these VERY FIRST) ---
process.on('uncaughtException', (err, origin) => {
  console.error(`
========================================
PROCESS ENCOUNTERED UNCAUGHT EXCEPTION
========================================
Error:`, err);
  console.error('Origin:', origin);
  console.error('Exiting process...');
  process.exit(1); // Exit on uncaught exception
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`
=============================================
PROCESS ENCOUNTERED UNHANDLED REJECTION
=============================================
Reason:`, reason);
  console.error('At promise:', promise);
  // Recommended: Log the error but DO NOT necessarily exit. 
  // Depending on the app, you might want to attempt recovery or just log.
  // For debugging, we might exit to make it obvious:
  // process.exit(1);
});
// --- End Global Error Handlers ---

dotenv.config();

const app = express();
console.log('[Server Setup] Express app initialized.'); 

const port = process.env.PORT || 3005;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));


app.use(express.json());

interface Tweet {
    id: string;
    conversationId: string;
    mentions: string[];
    name: string;
    permanentUrl: string;
    text: string;
    userId: string;
    username: string;
    isQuoted: boolean;
    isReply: boolean;
    isRetweet: boolean;
    isPin: boolean;
    timeParsed: string;
    timestamp: number;
    html: string;
}

interface UserBalance {
    data: {
        balance: number;
    } | null;
}

interface UserProfile {
    userId: string;
    name: string;
    username: string;
}

const redis = new Redis({
    host: process.env.REDIS_HOST || '',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    username: process.env.REDIS_USERNAME || '',
    password: process.env.REDIS_PASSWORD || '',
    // Railway private networking (redis.railway.internal) is IPv6-only, so
    // ioredis must resolve AAAA records. family: 0 lets it try both v6 and v4.
    // The internal Redis is plaintext, so no TLS here (TLS caused connect ETIMEDOUT).
    family: 0,
});

const LAST_REPLIED_TWEET_KEY = 'lastRepliedTweetId';
const BOT_STARTUP_KEY = 'botStartupTime';

// async function loadLastRepliedTweetId(): Promise<string | null> {
//     return await redis.get(LAST_REPLIED_TWEET_KEY);
// }

// async function saveLastRepliedTweetId(tweetId: string): Promise<void> {
//     await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
// }

// [removed] Solana withdraw handler + /api/withdraw route — withdrawals are now client-side (Privy embedded wallet on Robinhood Chain).

// @ts-ignore - TypeScript error workaround
app.get('/api/userBalance', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ 
        message: 'Missing username',
        error: 'Username parameter is required'
      });
    }
    
    const { supabase } = await connectToSupabase();
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ 
          message: 'User not found',
          data: null
        });
      }
      console.error('Supabase error:', error);
      return res.status(500).json({ 
        message: 'Internal server error',
        error: error.message
      });
    }
    
    return res.status(200).json({
      message: 'User balance found',
      data: {
        balance: user.balance || 0
      }
    });
  } catch (error) {
    console.error('Error fetching user balance:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
});

// @ts-ignore - TypeScript error workaround
app.post('/api/userBalance', async (req, res) => {
  try {
    const { username, balance } = req.body;
    
    if (!username || balance === undefined) {
      return res.status(400).json({ 
        message: 'Missing required fields',
        error: 'Username and balance are required'
      });
    }
    
    const { supabase } = await connectToSupabase();
    
    // Upsert user with balance using Supabase
    const { data: user, error } = await supabase
      .from('users')
      .upsert(
        { username, balance },
        { onConflict: 'username' }
      )
      .select()
      .single();
    
    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ 
        message: 'Internal server error',
        error: error.message
      });
    }
    
    return res.status(200).json({
      message: 'User balance updated successfully',
      data: { username, balance: user.balance }
    });
  } catch (error) {
    console.error('Error updating user balance:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
});

app.get('/health', async (req: express.Request, res: express.Response) => {
    try {
        // Check Supabase connection
        const { supabase } = await connectToSupabase();
        const { error } = await supabase
          .from('users')
          .select('count')
          .limit(1);

        if (error) {
          throw error;
        }

        // Check Redis connection
        await redis.ping();

        // Check memory usage
        const memoryUsage = process.memoryUsage();
        const memoryThreshold = 450 * 1024 * 1024; // 450MB threshold (below 512MB limit)

        const status = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            services: {
                supabase: 'connected',
                redis: 'connected'
            },
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
                rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
                warning: memoryUsage.rss > memoryThreshold ? 'High memory usage' : null
            }
        };

        res.json(status);
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: (error as Error).message
        });
    }
});

// Modified replyToTweet function to generate approval links
async function replyToTweet(
  scraper: Scraper,
  tweet: Tweet,
  privyClient: PrivyClient,
  llm: ChatGroq | Ollama
): Promise<void> {
  try {
    console.log(tweet);
    const tweetText = tweet.text;
    const sender = tweet.username;
    const myUsername = process.env.MY_USERNAME;

    // IMPORTANT: Skip processing if the sender is the bot itself
    if (sender.toLowerCase() === myUsername?.toLowerCase()) {
      console.log(`Skipping tweet ${tweet.id} because it's from our own bot`);
      return;
    }

    // Skip if it's a retweet or quote - only process direct mentions
    if (tweet.isRetweet || tweet.isQuoted) {
      console.log(`Skipping tweet ${tweet.id} because it's a retweet or quote`);
      return;
    }

    // NEW: Check if this is likely a payment intent using improved detection logic
    const containsEthToken = /\b(?:eth|ethereum)\b/i.test(tweetText.toLowerCase());
    const containsActionVerb = /\b(?:send|transfer|pay)\b/i.test(tweetText.toLowerCase());
    const containsToIndicator = /\bto @|\bto\s+@/i.test(tweetText.toLowerCase());

    // Require both action verb AND either ETH or recipient indicator
    const hasPaymentIntent = containsActionVerb && (containsEthToken || containsToIndicator);

    if (!hasPaymentIntent) {
      console.log(`Skipping tweet ${tweet.id} because it doesn't appear to be a payment request`);
      return;
    }

    // Add a more rigorous check to validate overall tweet structure.
    // Looks for patterns like "send X ETH to @user" or "pay @user X ETH".
    // The token (eth) is optional so "send 0.1 to @user" is also accepted.
    const paymentPatterns = [
      /\b(?:send|transfer|pay)\s+(?:\d+(?:\.\d+)?)\s*(?:eth|ethereum)?\s+(?:to\s+@|to@)[a-zA-Z0-9_]+\b/i,
      /\b(?:send|transfer|pay)\s+(?:to\s+@|to@)[a-zA-Z0-9_]+\s+(?:\d+(?:\.\d+)?)\s*(?:eth|ethereum)?\b/i
    ];
    
    const hasValidPaymentStructure = paymentPatterns.some(pattern => pattern.test(tweetText));
    
    if (!hasValidPaymentStructure) {
      console.log(`Skipping tweet ${tweet.id} because it doesn't have a valid payment command structure`);
      return;
    }

    // Parse tweet to get recipient and amount
    const result = await getUsername(tweetText, llm, scraper, tweet.id);
    if (!result) {
      console.log("Could not parse username and amount");
      await scraper.sendTweet(`@${sender} Please format your request as "@${myUsername} send 0.1 to @recipient"`, tweet.id);
      return;
    }
      
    const { username: recipientUsername, amount } = result;
    console.log('Recipient Username:', recipientUsername);
    console.log('Amount:', amount);

    // Additional validation to avoid loops: Don't process if recipient is the bot itself
    if (recipientUsername.toLowerCase() === myUsername?.toLowerCase()) {
      console.log(`Skipping tweet ${tweet.id} because recipient is our own bot`);
      await scraper.sendTweet(`@${sender} I cannot send ${NATIVE_SYMBOL} to myself. Please specify a different recipient.`, tweet.id);
      return;
    }

    // Check if recipient exists and has a wallet
    let recipientUser = await privyClient.getUserByTwitterUsername(recipientUsername);
    let isNewUser = false;
      
    // If recipient doesn't exist, import them
    if (!recipientUser) {
      console.log('Recipient user not found on Privy, attempting to import:', recipientUsername);
      const userDetails = await scraper.getProfile(recipientUsername) as UserProfile;
      if (!userDetails?.userId || !userDetails?.username) {
        console.log('Could not fetch recipient details from Twitter');
        await scraper.sendTweet(`@${sender} Could not fetch details for @${recipientUsername}`, tweet.id);
        return;
      }
          
      try {
        recipientUser = await privyClient.importUser({
          linkedAccounts: [
            {
              type: 'twitter_oauth',
              subject: userDetails.userId,
              name: userDetails.name || null,
              username: userDetails.username || null,
            }
          ],
          createEthereumWallet: true,
          customMetadata: {
            username: userDetails.username
          }
        });
        isNewUser = true;
        console.log('Successfully imported recipient user to Privy:', recipientUsername);
      } catch (importError) {
        console.error('Error importing recipient user to Privy:', importError);
        await scraper.sendTweet(`@${sender} Error setting up recipient @${recipientUsername}`, tweet.id);
        return;
      }
    }

    if (!recipientUser?.wallet?.address) {
      console.log('Recipient user wallet not found (Privy):', recipientUsername);
      await scraper.sendTweet(`@${sender} Could not find or create wallet for @${recipientUsername}`, tweet.id);
      return;
    }

    // Generate a unique transaction ID
    const transactionId = uuidv4();
      
    // Store the transaction intent
    const { supabase } = await connectToSupabase();

    console.log(sender, recipientUsername);
      
    const { error: insertError } = await supabase
      .from('transactions')
      .insert({
        id: transactionId,
        tweet_id: tweet.id,
        sender: sender,
        recipient: recipientUsername,
        recipient_address: recipientUser.wallet.address,
        amount: amount,
        status: 'pending',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });

    if (insertError) {
      console.error('Error inserting transaction:', insertError);
      await scraper.sendTweet(`@${sender} Sorry, an error occurred creating your transaction.`, tweet.id);
      return;
    }
      
    // Create an approval link
    const approvalUrl = `${process.env.FRONTEND_URL}/approve/${transactionId}`;
      
    // Reply with the approval link
    await scraper.sendTweet(
      `@${sender} Ready to send ${amount} ${NATIVE_SYMBOL} to @${recipientUsername}. ` +
      `Click here to approve this transaction: ${approvalUrl} ` +
      `(Link expires in 24 hours)`,
      tweet.id
    );

    console.log(`Created transaction intent ${transactionId} for ${sender} to send ${amount} ${NATIVE_SYMBOL} to ${recipientUsername}`);
  } catch (error) {
    console.error('Error in replyToTweet function for tweet ID:', tweet.id, error);
    try {
      await scraper.sendTweet(`@${tweet.username} Sorry, an error occurred processing your request.`, tweet.id);
    } catch (sendError) {
      console.error('Failed to send error message tweet:', sendError);
    }
  }
}

// Add the transaction API endpoints inline
app.get('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      res.status(400).json({ success: false, error: 'Transaction ID is required' });
      return;
    }
    
    const { supabase } = await connectToSupabase();
    
    const { data: transaction, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        res.status(404).json({ success: false, error: 'Transaction not found' });
        return;
      }
      console.error('Supabase error:', error);
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    
    // Check if transaction has expired
    if (transaction.expires_at && new Date() > new Date(transaction.expires_at)) {
      res.status(410).json({ success: false, error: 'Transaction has expired' });
      return;
    }
    
    res.status(200).json({
      success: true,
      transaction: {
        id: transaction.id,
        sender: transaction.sender,
        recipient: transaction.recipient,
        recipientAddress: transaction.recipient_address,
        amount: transaction.amount,
        status: transaction.status
      }
    });
  } catch (error) {
    console.error('Error getting transaction details:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'An unexpected error occurred' 
    });
  }
});

app.post('/api/transactions/complete', async (req, res) => {
  try {
    const { id, signature, senderAddress } = req.body;
    
    if (!id || !signature || !senderAddress) {
      res.status(400).json({ 
        success: false, 
        error: 'Transaction ID, signature, and sender address are required' 
      });
      return;
    }
    
    const { supabase } = await connectToSupabase();
    
    // First get the transaction
    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();
    
    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        res.status(404).json({ success: false, error: 'Transaction not found' });
        return;
      }
      console.error('Supabase error:', fetchError);
      res.status(500).json({ success: false, error: fetchError.message });
      return;
    }
    
    if (transaction.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Transaction is no longer pending' });
      return;
    }
    
    // Check if transaction has expired
    if (transaction.expires_at && new Date() > new Date(transaction.expires_at)) {
      res.status(410).json({ success: false, error: 'Transaction has expired' });
      return;
    }
    
    // Update transaction status
    const { error: updateError } = await supabase
      .from('transactions')
      .update({ 
        status: 'completed', 
        signature, 
        sender_address: senderAddress,
        completed_at: new Date().toISOString()
      })
      .eq('id', id);
    
    if (updateError) {
      console.error('Error updating transaction:', updateError);
      res.status(500).json({ success: false, error: updateError.message });
      return;
    }
    
    // Send confirmation tweet
    try {
      const scraper = (await loginScraperWithCookies()) ?? new Scraper();
      if (!(await scraper.isLoggedIn())) {
        await scraper.login(
          process.env.MY_USERNAME || '',
          process.env.PASSWORD || '',
          process.env.EMAIL || ''
        );
      }

      const explorerUrl = txExplorerUrl(signature);
      const claimUrl = `${process.env.FRONTEND_URL}`;
      await scraper.sendTweet(
        `@${transaction.sender} You've successfully sent ${transaction.amount} ${NATIVE_SYMBOL} to @${transaction.recipient}. ` +
        `Tx: ${explorerUrl} \n\n` +
        `@${transaction.recipient} You've received ${transaction.amount} ${NATIVE_SYMBOL}! Visit ${claimUrl} to claim your ${NATIVE_SYMBOL}.`,
        transaction.tweet_id
      );
    } catch (twitterError) {
      console.error('Error sending confirmation tweet:', twitterError);
      // Continue even if Twitter notification fails
    }
    
    res.status(200).json({ 
      success: true,
      message: 'Transaction completed successfully',
      data: {
        signature,
        explorerUrl: txExplorerUrl(signature)
      }
    });
  } catch (error) {
    console.error('Error completing transaction:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
});

// Add after the imports
function checkMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const memoryThreshold = 450 * 1024 * 1024; // 450MB threshold
    
    if (memoryUsage.rss > memoryThreshold) {
        console.warn('High memory usage detected:', {
            heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
            rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`
        });
        
        // Force garbage collection if available
        if (global.gc) {
            console.log('Forcing garbage collection...');
            global.gc();
        }
    }
}

async function main(scraper: Scraper, privyClient: PrivyClient, llm: ChatGroq | Ollama): Promise<void> {
  try {
    const myUsername = process.env.MY_USERNAME;
    if (!myUsername) {
      console.error("MY_USERNAME environment variable not set!");
      return;
    }
        
    console.log(`Fetching tweets mentioning @${myUsername}...`);
    const getTweets = await scraper.fetchSearchTweets(
      `@${myUsername}`,
      20,
      SearchMode.Latest
    );
    console.log(`Seen ${getTweets.tweets.length} tweets.`);

    const formattedTweets = getTweets.tweets.map((tweet: any): Tweet => ({
      id: tweet.id_str || tweet.id,
      conversationId: tweet.conversation_id_str || tweet.conversationId,
      mentions: tweet.entities?.user_mentions?.map((m: any) => m.screen_name) || tweet.mentions || [],
      name: tweet.user?.name || tweet.name,
      permanentUrl: `https://twitter.com/${tweet.user?.screen_name || tweet.username}/status/${tweet.id_str || tweet.id}`,
      text: tweet.full_text || tweet.text,
      userId: tweet.user?.id_str || tweet.userId,
      username: tweet.user?.screen_name || tweet.username,
      isQuoted: tweet.is_quote_status || tweet.isQuoted || false,
      isReply: !!tweet.in_reply_to_status_id_str || tweet.isReply || false,
      isRetweet: !!tweet.retweeted_status || tweet.isRetweet || false,
      isPin: tweet.user?.pinned_tweet_ids_str?.includes(tweet.id_str) || tweet.isPin || false,
      timeParsed: tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString(),
      timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() / 1000 : Date.now() / 1000,
      html: tweet.html || ''
    }));

    if (formattedTweets.length > 0) {
      const lastRepliedTweetId = await loadLastRepliedTweetId();
      console.log('Last replied tweet ID from Redis:', lastRepliedTweetId);

      // CRITICAL FIX: When starting fresh (no lastRepliedTweetId), set it to the newest tweet
      // to prevent replying to old tweets
      let lastRepliedTweetIdNum: bigint;
      let latestProcessedTweetId: bigint;
      
      const isFirstStart = await isFirstStartup();
      
      if (!lastRepliedTweetId || isFirstStart) {
        // First startup - find the newest tweet and set that as our baseline
        const newestTweet = formattedTweets.reduce((newest, current) => 
          BigInt(current.id) > BigInt(newest.id) ? current : newest
        );
        lastRepliedTweetIdNum = BigInt(newestTweet.id);
        latestProcessedTweetId = lastRepliedTweetIdNum;
        console.log(`🚀 ${isFirstStart ? 'First startup' : 'No previous state'} detected! Setting baseline to newest tweet: ${newestTweet.id} (${newestTweet.timeParsed})`);
        console.log(`📝 This prevents replying to old tweets. Only NEW tweets after this will be processed.`);
        console.log(`⏰ Additionally, tweets older than 1 hour will be ignored to prevent spam.`);
      } else {
        lastRepliedTweetIdNum = BigInt(lastRepliedTweetId);
        latestProcessedTweetId = lastRepliedTweetIdNum;
      }

      // Sort tweets by timestamp (oldest first) for proper processing order
      formattedTweets.sort((a, b) => a.timestamp - b.timestamp);
      
      // First track all seen tweets to update our ID marker even if we don't reply
      for (const tweet of formattedTweets) {
        const tweetIdNum = BigInt(tweet.id);
        if (tweetIdNum > latestProcessedTweetId) {
          latestProcessedTweetId = tweetIdNum;
        }
      }

      // Create a set of tweets we've already processed to avoid duplicates
      // in case the Twitter API returns the same tweet twice
      const processedTweetIds = new Set<string>();

      for (const tweet of formattedTweets) {
        const tweetIdNum = BigInt(tweet.id);
        console.log(`Processing tweet ID: ${tweet.id} (Num: ${tweetIdNum})`);
        
        // Skip if this tweet has already been processed in this batch
        if (processedTweetIds.has(tweet.id)) {
          console.log(`Tweet ${tweet.id} was already processed in this batch, skipping.`);
          continue;
        }
        
        // Skip tweets from the bot itself to prevent infinite loops
        if (tweet.username.toLowerCase() === myUsername.toLowerCase()) {
          console.log(`Tweet ${tweet.id} is from our own bot, skipping.`);
          processedTweetIds.add(tweet.id);
          continue;
        }

        // NEW: Pre-filter for payment keywords to avoid unnecessary processing
        const paymentKeywords = ['send', 'pay', 'transfer', 'eth', 'to @', 'to@'];
        const hasPaymentIntent = paymentKeywords.some(keyword => 
          tweet.text.toLowerCase().includes(keyword.toLowerCase())
        );

        if (!hasPaymentIntent) {
          console.log(`Tweet ${tweet.id} doesn't contain payment keywords, skipping.`);
          processedTweetIds.add(tweet.id);
          continue;
        }

        if (tweetIdNum > lastRepliedTweetIdNum) {
          // Additional protection: Don't reply to tweets older than 1 hour
          const tweetAge = Date.now() - (tweet.timestamp * 1000);
          const maxAge = 60 * 60 * 1000; // 1 hour in milliseconds
          
          if (tweetAge > maxAge) {
            console.log(`⏰ Tweet ${tweet.id} is too old (${Math.round(tweetAge / 60000)} minutes), skipping to prevent spam.`);
            processedTweetIds.add(tweet.id);
            continue;
          }
          
          // Only process if it's a direct mention and not a retweet/quote
          if (tweet.text.toLowerCase().includes(`@${myUsername.toLowerCase()}`) && 
              !tweet.isRetweet && 
              !tweet.isQuoted) {
            console.log(`✅ Tweet ${tweet.id} is a valid mention with payment intent. Replying...`);
            try {
              await replyToTweet(scraper, tweet, privyClient, llm);
              console.log('Successfully processed and replied to tweet ID:', tweet.id);
              processedTweetIds.add(tweet.id);
            } catch (replyError) {
              console.error('Error replying to tweet ID:', tweet.id, replyError);
            }
          } else {
            console.log(`Tweet ${tweet.id} does not qualify for a reply (retweet, quote, or not direct mention).`);
            processedTweetIds.add(tweet.id);
          }
        } else {
          console.log(`Tweet ID ${tweet.id} is older than or same as last replied (${lastRepliedTweetId}), skipping.`);
          processedTweetIds.add(tweet.id);
        }
      }
            
      // Always update the latest processed tweet ID, even if we didn't reply to any
      if (latestProcessedTweetId > lastRepliedTweetIdNum) {
        console.log(`Updating last replied tweet ID in Redis to: ${latestProcessedTweetId.toString()}`);
        await saveLastRepliedTweetId(latestProcessedTweetId.toString());
      } else {
        console.log("No new tweets processed in this batch requiring update to last replied ID.");
      }
    } else {
      console.log('No new mention tweets found in this batch.');
    }
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

// Improved Redis functions for better reliability
async function loadLastRepliedTweetId(): Promise<string | null> {
  try {
    return await redis.get(LAST_REPLIED_TWEET_KEY);
  } catch (error) {
    console.error("Error loading last replied tweet ID from Redis:", error);
    return null; // Return null on error rather than crashing
  }
}

async function saveLastRepliedTweetId(tweetId: string): Promise<void> {
  try {
    await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
    console.log(`Successfully saved tweet ID ${tweetId} to Redis`);
  } catch (error) {
    console.error("Error saving last replied tweet ID to Redis:", error);
    // Continue execution even if Redis write fails
  }
}

async function isFirstStartup(): Promise<boolean> {
  try {
    const startupTime = await redis.get(BOT_STARTUP_KEY);
    if (!startupTime) {
      // First startup - record the startup time
      await redis.set(BOT_STARTUP_KEY, Date.now().toString());
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error checking startup status:", error);
    return true; // Assume first startup on error
  }
}

// Cookie auth: copy the `auth_token` and `ct0` cookies from a browser that is
// logged in as the bot account into TWITTER_AUTH_TOKEN / TWITTER_CT0. This
// bypasses the fragile username/password login flow, which was failing with
// Twitter error 34 ("that page does not exist").
async function loginScraperWithCookies(): Promise<Scraper | null> {
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;
  if (!authToken || !ct0) return null;
  try {
    const scraper = new Scraper();
    // The scraper hits https://x.com internally and its setCookies() stores
    // cookies against that URL, so the session cookies must be scoped to .x.com
    // (a .twitter.com cookie would throw "Cookie not in this host's domain" and
    // abort the whole setCookies call).
    await scraper.setCookies([
      `auth_token=${authToken}; Domain=.x.com; Path=/; Secure; HttpOnly`,
      `ct0=${ct0}; Domain=.x.com; Path=/; Secure`,
    ]);

    // Don't hard-fail on isLoggedIn() — if it passes, great; if not, proceed
    // best-effort and let the first mention poll reveal whether the cookies
    // actually work.
    let loggedIn = false;
    try {
      loggedIn = await scraper.isLoggedIn();
    } catch (e) {
      console.warn('isLoggedIn() check threw (treating as inconclusive):', e);
    }
    if (loggedIn) {
      console.log('✅ Twitter cookie auth successful (isLoggedIn confirmed).');
    } else {
      console.warn('⚠️  Twitter cookie session not confirmed by isLoggedIn(); proceeding best-effort — polling will reveal actual auth state.');
    }
    return scraper;
  } catch (err) {
    console.error('❌ Twitter cookie auth error:', err);
    return null;
  }
}

async function loginWithRetry(
  maxRetries: number = 3,
  delayBetweenRetries: number = 10000 // 10 seconds
): Promise<Scraper | null> {
  // Prefer cookie auth when configured — far more reliable than password login.
  const cookieScraper = await loginScraperWithCookies();
  if (cookieScraper) return cookieScraper;
  if (process.env.TWITTER_AUTH_TOKEN || process.env.TWITTER_CT0) {
    console.warn('Cookie auth configured but failed; falling back to username/password login...');
  }

  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      console.log(`Twitter login attempt ${retryCount + 1}/${maxRetries}...`);
      const scraper = new Scraper();
      
      await scraper.login(
        process.env.MY_USERNAME || '',
        process.env.PASSWORD || '',
        process.env.EMAIL || ''
      );
      
      console.log('Twitter login successful!');
      return scraper;
    } catch (error) {
      retryCount++;
      console.error(`Twitter login failed (attempt ${retryCount}/${maxRetries}):`, error);
      
      if (retryCount >= maxRetries) {
        console.error(`All ${maxRetries} login attempts failed. Twitter functionality will be disabled.`);
        return null;
      }
      
      console.log(`Waiting ${delayBetweenRetries/1000} seconds before retrying...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenRetries));
    }
  }
  
  return null;
}

function validateEnvironmentVariables(): boolean {
  const requiredVars = [
    'MY_USERNAME',
    'PASSWORD',
    'EMAIL',
    'PRIVY_CLIENT_ID',
    'PRIVY_CLIENT_SECRET',
    'GROQ_API_KEY',
    'REDIS_HOST',
    'REDIS_PORT',
    'FRONTEND_URL'
  ];
  
  let allValid = true;
  const missing: string[] = [];
  
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      missing.push(varName);
      allValid = false;
    }
  });
  
  if (!allValid) {
    console.error(`
=================================================
MISSING ENVIRONMENT VARIABLES
=================================================
The following required variables are missing:
${missing.map(v => `- ${v}`).join('\n')}

Please check your .env file and make sure all required
variables are set correctly.
=================================================
`);
  } else {
    console.log('✅ All required environment variables are set.');
  }
  
  return allValid;
}

// Twitter credentials validation function - test the login without trying to use it
async function validateTwitterCredentials(): Promise<boolean> {
  console.log('Testing Twitter credentials...');

  // If cookie auth is configured, validate the cookie session instead of the
  // password flow.
  if (process.env.TWITTER_AUTH_TOKEN && process.env.TWITTER_CT0) {
    const cookieScraper = await loginScraperWithCookies();
    if (cookieScraper) {
      console.log('✅ Twitter cookie session is valid.');
      return true;
    }
    console.error('❌ Twitter cookie session is invalid (auth_token/ct0 expired or wrong).');
    return false;
  }

  try {
    const scraper = new Scraper();

    await scraper.login(
      process.env.MY_USERNAME || '',
      process.env.PASSWORD || '',
      process.env.EMAIL || ''
    );

    console.log('✅ Twitter credentials are valid.');
    return true;
  } catch (error) {
    console.error('❌ Twitter credentials validation failed:');
    
    const errorString = String(error);
    
    // Try to provide more helpful error messages based on the error pattern
    if (errorString.includes('399')) {
      console.error(`
Twitter returned a 399 error, which typically means incorrect username or password.
Please double-check your MY_USERNAME, PASSWORD, and EMAIL environment variables.

Common issues:
1. Password may be incorrect or recently changed
2. Twitter may be requiring a CAPTCHA or additional verification
3. The account may be locked due to suspicious activity

You may need to log in manually on twitter.com first to clear any verification requirements.
`);
    } else if (errorString.includes('401')) {
      console.error(`
Twitter returned a 401 error, which indicates unauthorized access.
Please verify that your credentials are correct and that your account isn't restricted.
`);
    } else if (errorString.includes('rate limit')) {
      console.error(`
Twitter is rate limiting your requests. This may be because:
1. Too many login attempts in a short period
2. The IP address you're using is shared/blocked
3. Twitter's systems have flagged your activity as suspicious

Wait at least 15 minutes before retrying.
`);
    } else {
      console.error('Error details:', error);
    }
    
    return false;
  }
}

// Troubleshooting guide function
function printTwitterTroubleshootingGuide(): void {
  console.log(`
=================================================
TWITTER LOGIN TROUBLESHOOTING GUIDE
=================================================

1. Manual Check:
   - Login to Twitter manually first in your browser
   - Clear any CAPTCHA/verification challenges
   - Make sure the account is in good standing

2. Check Credentials:
   - Verify username has correct capitalization (though it should be case-insensitive)
   - Make sure password is correct (recently changed?)
   - Double-check email matches Twitter account email

3. Rate Limiting:
   - If you've been attempting to login repeatedly, Twitter may temporarily block login attempts
   - Try waiting 15-30 minutes before retrying
   - Consider using a different IP address if possible

4. Login Security:
   - If you use 2FA, make sure it's disabled or you're handling it correctly
   - Check if your account needs to approve new login locations

5. Alternative Approach:
   - Consider using Twitter's API with API keys instead
   - This requires a developer account but is more reliable

=================================================
`);
}

async function start(): Promise<void> {
    console.log('[Start Function] Entered.');
    
    // Add error handlers for uncaught exceptions and unhandled rejections
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught Exception:', error);
        try {
            await reconnectWithRetry('database', connectToSupabase);
        } catch (reconnectError) {
            console.error('Fatal: Could not recover from uncaught exception:', reconnectError);
            process.exit(1);
        }
    });

    process.on('unhandledRejection', async (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        try {
            await reconnectWithRetry('database', connectToSupabase);
        } catch (reconnectError) {
            console.error('Fatal: Could not recover from unhandled rejection:', reconnectError);
            process.exit(1);
        }
    });

    const envValid = validateEnvironmentVariables();
    if (!envValid) {
        console.warn('Missing required environment variables - attempting to continue with available configuration...');
        // Continue execution but with warning
    }
    
    // Validate Twitter credentials specifically
    const twitterValid = await validateTwitterCredentials();
    if (!twitterValid) {
        printTwitterTroubleshootingGuide();
        console.warn('Twitter authentication failed - continuing with limited functionality...');
        // Continue with server only, no Twitter bot
    }
    
    // --- Restore Complex Initializations ---
    try {
        console.log('[Start Function] Connecting to database...');
        await connectToSupabase(); // Connect to DB here
        console.log('[Start Function] Database connection successful (or connection attempt initiated).');
    } catch (dbError) {
        console.error('[Start Function] FATAL: Database connection failed on startup:', dbError);
        process.exit(1); // Exit if DB connection fails critically on start
    }

    // Twitter login is best-effort. If it fails (X guest-token/library issues,
    // rate limiting, or bad credentials) the service must stay up so the HTTP API,
    // health check and database keep working — only Twitter polling is disabled.
    const scraper = await loginWithRetry();
    if (!scraper) {
        console.warn('⚠️  Twitter login failed after retries — starting without the Twitter bot. HTTP API and health check will still run.');
    } else {
        console.log('Twitter login successful!');
    }

    const privyClient = new PrivyClient(
        process.env.PRIVY_CLIENT_ID || '',
        process.env.PRIVY_CLIENT_SECRET || ''
    );
    console.log('Privy client initialized.');

    const llm = new ChatGroq({
        apiKey: process.env.GROQ_API_KEY || '',
        model: "llama3-8b-8192"
    });
    console.log('LLM initialized.');

    // Adaptive polling system for optimal responsiveness
    let pollInterval = 10000; // Start with 10 seconds
    let lastActivityTime = Date.now();
    let consecutiveEmptyRuns = 0;
    let isPolling = false;
    
    const startAdaptivePolling = async (scraper: Scraper) => {
      if (isPolling) return;
      isPolling = true;
      
      console.log(`Starting adaptive polling with ${pollInterval/1000}s interval...`);
      
      const adaptivePoll = async () => {
        try {
          const startTime = Date.now();
          await main(scraper, privyClient, llm);
          const processingTime = Date.now() - startTime;
          
          // Check if we found any tweets to process
          const hasActivity = processingTime > 1000; // If processing took >1s, likely found tweets
          
          if (hasActivity) {
            lastActivityTime = Date.now();
            consecutiveEmptyRuns = 0;
            // Fast polling when there's activity
            pollInterval = Math.max(5000, pollInterval * 0.7); // Minimum 5 seconds
            console.log(`✅ Activity detected! Next poll in ${pollInterval/1000}s (fast mode)`);
          } else {
            consecutiveEmptyRuns++;
            // Slow down gradually when no activity
            if (consecutiveEmptyRuns > 3) {
              pollInterval = Math.min(60000, pollInterval * 1.1); // Max 1 minute
            }
            console.log(`⏳ No activity (${consecutiveEmptyRuns} runs). Next poll in ${pollInterval/1000}s`);
          }
          
        } catch (error) {
          console.error('Error in adaptive polling:', error);
          pollInterval = Math.min(60000, pollInterval * 1.5); // Slow down on errors
        }
        
        setTimeout(adaptivePoll, pollInterval);
      };
      
      adaptivePoll();
    };
    
    // Start the adaptive polling system only when we have an authenticated Twitter session
    if (scraper) {
        startAdaptivePolling(scraper);
    } else {
        console.warn('Twitter polling disabled — no authenticated Twitter session. Service will run API/health only.');
    }

    console.log(`[Start Function] Effective PORT from environment: ${process.env.PORT}`);
    console.log(`[Start Function] Port variable set to: ${port}`);
    console.log('[Start Function] Attempting to start server listener...'); // Log before listen attempt
    
    const server = app.listen(port, () => {
        // This block only runs if listen() is successful
        console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
        console.log(`>>> SERVER LISTENING SUCCESSFULLY ON PORT ${port} <<<`);
        console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
        console.log(`Health check available at GET http://localhost:${port}/health`);
    });

    // Add error handling specifically for the server instance
    server.on('error', (error) => {
        console.error(`
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
SERVER LISTENER ERROR on port ${port}
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(error);
        process.exit(1); // Exit if the server fails to start listening
    });

    console.log('[Start Function] Listener setup initiated (waiting for success/error).'); // Log after initiating listen

    // Add memory check interval
    setInterval(checkMemoryUsage, 60000); // Check every minute
}

app.use((err: Error, req: express.Request, res: express.Response, next: NextFunction) => {
    console.error("[Global Error Handler] Caught an error:", err);
    // Log stack trace for more details
    if (err.stack) {
      console.error(err.stack);
    }
    res.status(500).json({ 
      message: 'Something broke on the server!',
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
});

console.log('[Server Setup] Starting the application...'); // Log before calling start()
start().catch(error => {
    console.error("Fatal error during startup:", error);
    process.exit(1);
}); 