// Twitter/X client for the bot.
//
// Reads (search, profiles, isLoggedIn) go through @the-convocation/twitter-scraper,
// the actively-maintained upstream of agent-twitter-client (which is dead — its
// last release, 0.0.18 from Dec 2024, hits retired api.twitter.com GraphQL
// endpoints and gets 401 "Could not authenticate you").
//
// The upstream scraper is read-only, so tweet posting is implemented here as a
// raw CreateTweet GraphQL call using the scraper's own cookie session plus a
// valid `x-client-transaction-id` header (X rejects requests with missing or
// random transaction IDs on some endpoints).
import { Scraper } from '@the-convocation/twitter-scraper';
import { ClientTransaction, fetchXDocument } from 'x-client-transaction-id';

export { SearchMode } from '@the-convocation/twitter-scraper';

// Authenticated web-client bearer token. This is the SECOND bearer the scraper
// lib uses specifically for logged-in GraphQL calls (bearerToken2). The other,
// more commonly-quoted "FQODgEA..." bearer authenticates REST/1.1 and guest
// requests but gets rejected (error 32 "Could not authenticate you") on
// authenticated GraphQL write endpoints like CreateTweet.
const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Current CreateTweet operation (query ID + features cribbed from rettiwt-api
// 7.1.2, Jun 2026), on the api.x.com/graphql host the scraper lib uses for all
// authenticated GraphQL. If posting starts failing with 404s, this ID is stale.
const CREATE_TWEET_URL =
  'https://api.x.com/graphql/Uf3io9zVp1DsYxrmL5FJ7g/CreateTweet';

// Legacy notifications "Mentions" tab endpoint. Unlike search, this returns
// the authenticated account's mentions directly from X's notification system,
// so it isn't subject to search-index latency. Returns the classic
// globalObjects/timeline v1 shape.
const MENTIONS_URL =
  'https://x.com/i/api/2/notifications/mentions.json?count=40&tweet_mode=extended&include_ext_alt_text=false&include_entities=true';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Official X API v2 mention discovery (optional, paid).
//
// The cookie-session search/notifications paths above can't surface mentions to
// a brand-new/low-reputation account — X throttles mention *discovery* for such
// accounts as anti-spam. The official GET /2/users/:id/mentions endpoint is the
// authoritative source and is immune to that throttling, but it is a paid,
// credit-metered read authenticated with an App Bearer Token (distinct from the
// web cookie session).
//
// This whole path is inert unless X_API_BEARER_TOKEN is set, so the bot runs
// unchanged (cookie-only) until credits + a token are configured.
const X_API_BEARER_TOKEN = process.env.X_API_BEARER_TOKEN;
// Cap the per-call page size (each read costs credits). 5..100 per the API.
const X_API_MAX_RESULTS = Math.min(
  100,
  Math.max(5, parseInt(process.env.X_MENTIONS_MAX_RESULTS || '25', 10) || 25)
);
// Minimum spacing between paid mention reads, so the adaptive fast-poll loop
// (which can drop to a 5s cadence) doesn't multiply API spend. Defaults to 55s.
const X_API_MIN_INTERVAL_MS =
  parseInt(process.env.X_MENTIONS_POLL_MS || '55000', 10) || 55000;

let lastV2FetchAt = 0;
let cachedV2UserId: string | null = process.env.X_API_USER_ID || null;

// Resolve (and cache) the account's numeric id from its username via the v2
// API, so the numeric id doesn't have to be configured by hand.
async function resolveV2UserId(username: string): Promise<string | null> {
  if (cachedV2UserId) return cachedV2UserId;
  const res = await fetch(
    `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`,
    { headers: { authorization: `Bearer ${X_API_BEARER_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`resolveV2UserId failed: HTTP ${res.status}`);
  }
  const body: any = await res.json().catch(() => null);
  cachedV2UserId = body?.data?.id ?? null;
  return cachedV2UserId;
}

const CREATE_TWEET_FEATURES = {
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: true,
  articles_preview_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_profile_redirect_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
};

// The transaction generator needs X's home page document (animation key) to
// derive valid IDs. Cache it for the process lifetime; drop the cache on
// failure so the next call re-initializes.
let transactionPromise: Promise<ClientTransaction> | null = null;
function getClientTransaction(): Promise<ClientTransaction> {
  if (!transactionPromise) {
    transactionPromise = (async () => {
      const document = await fetchXDocument();
      return await ClientTransaction.create(document);
    })().catch((err) => {
      transactionPromise = null;
      throw err;
    });
  }
  return transactionPromise;
}

export class XScraper extends Scraper {
  /**
   * Posts a tweet (optionally as a reply) using the scraper's cookie session.
   * Mirrors the agent-twitter-client sendTweet(text, replyToTweetId) API the
   * bot was written against.
   */
  async sendTweet(text: string, replyToTweetId?: string): Promise<string> {
    const cookies = await this.getCookies();
    const ct0 = cookies.find((c) => c.key === 'ct0')?.value;
    if (!ct0) {
      throw new Error('sendTweet: no ct0 cookie in session (not logged in?)');
    }
    const cookieHeader = cookies.map((c) => `${c.key}=${c.value}`).join('; ');

    const transaction = await getClientTransaction();
    const transactionId = await transaction.generateTransactionId(
      'POST',
      new URL(CREATE_TWEET_URL).pathname
    );

    const res = await fetch(CREATE_TWEET_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        cookie: cookieHeader,
        'x-csrf-token': ct0,
        'x-client-transaction-id': transactionId,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        origin: 'https://x.com',
        referer: 'https://x.com/',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
      },
      body: JSON.stringify({
        variables: {
          tweet_text: text,
          dark_request: false,
          reply: replyToTweetId
            ? {
                in_reply_to_tweet_id: replyToTweetId,
                exclude_reply_user_ids: [],
              }
            : undefined,
          semantic_annotation_ids: [],
        },
        features: CREATE_TWEET_FEATURES,
      }),
    });

    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length) {
      const detail = body?.errors
        ? JSON.stringify(body.errors)
        : `HTTP ${res.status}`;
      throw new Error(`sendTweet failed: ${detail}`);
    }

    const tweetId =
      body?.data?.create_tweet?.tweet_results?.result?.rest_id;
    if (!tweetId) {
      throw new Error(
        `sendTweet: unexpected response shape: ${JSON.stringify(body).slice(0, 300)}`
      );
    }
    return tweetId;
  }

  /**
   * Fetches the authenticated account's recent mentions from the notifications
   * "Mentions" tab. This is independent of X's search index, so it catches
   * mentions that fetchSearchTweets misses (search indexing lags for new or
   * low-reputation sender accounts).
   *
   * Returns the same `{ tweets }` shape as fetchSearchTweets, with each tweet
   * carrying id_str / full_text / entities / created_at / a nested `user`, so
   * the caller can format it identically to a search result.
   */
  async fetchMentions(): Promise<{ tweets: any[] }> {
    const cookies = await this.getCookies();
    const ct0 = cookies.find((c) => c.key === 'ct0')?.value;
    if (!ct0) {
      throw new Error('fetchMentions: no ct0 cookie in session (not logged in?)');
    }
    const cookieHeader = cookies.map((c) => `${c.key}=${c.value}`).join('; ');

    const res = await fetch(MENTIONS_URL, {
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        cookie: cookieHeader,
        'x-csrf-token': ct0,
        'user-agent': USER_AGENT,
        origin: 'https://x.com',
        referer: 'https://x.com/notifications/mentions',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
      },
    });

    if (!res.ok) {
      throw new Error(`fetchMentions failed: HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => null);
    const rawTweets = body?.globalObjects?.tweets ?? {};
    const rawUsers = body?.globalObjects?.users ?? {};

    // Join each tweet to its author (the v1 timeline stores tweets and users
    // separately, keyed by id) so downstream formatting can read tweet.user.*.
    // The mentions feed can also include reply-parent / quoted tweets and the
    // occasional tweet whose author is absent from the users map; drop any we
    // can't attribute to a sender, since a mention with no resolvable author is
    // both unusable (we need the sender to build the payment intent) and would
    // otherwise yield an undefined username downstream.
    const tweets = Object.values(rawTweets)
      .map((t: any) => {
        const user = rawUsers[t.user_id_str];
        if (!user?.screen_name) return null;
        return {
          ...t,
          user: {
            id_str: user.id_str,
            screen_name: user.screen_name,
            name: user.name,
          },
        };
      })
      .filter((t): t is any => t !== null);

    return { tweets };
  }

  /**
   * Fetches mentions via the official X API v2 (GET /2/users/:id/mentions).
   * This is the authoritative source and, unlike cookie-session search /
   * notifications, surfaces mentions even to brand-new accounts that X
   * throttles from discovery. Paid (credit-metered), so:
   *   - inert unless X_API_BEARER_TOKEN is configured, and
   *   - self-throttled to at most one read per X_MENTIONS_POLL_MS.
   *
   * Returns the same `{ tweets }` shape as fetchMentions/fetchSearchTweets.
   *
   * @param username the account whose mentions to fetch (e.g. MY_USERNAME).
   */
  async fetchMentionsV2(username: string): Promise<{ tweets: any[] }> {
    if (!X_API_BEARER_TOKEN) return { tweets: [] };

    // Throttle paid reads independently of the adaptive poll cadence.
    const now = Date.now();
    if (now - lastV2FetchAt < X_API_MIN_INTERVAL_MS) return { tweets: [] };
    lastV2FetchAt = now;

    const userId = await resolveV2UserId(username);
    if (!userId) throw new Error('fetchMentionsV2: could not resolve user id');

    const url =
      `https://api.x.com/2/users/${userId}/mentions` +
      `?max_results=${X_API_MAX_RESULTS}` +
      `&tweet.fields=created_at,conversation_id,entities,author_id,referenced_tweets` +
      `&expansions=author_id` +
      `&user.fields=username,name`;

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${X_API_BEARER_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(
        `fetchMentionsV2 failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`
      );
    }
    const body: any = await res.json().catch(() => null);
    const data: any[] = body?.data ?? [];
    const usersById = new Map<string, any>(
      (body?.includes?.users ?? []).map((u: any) => [u.id, u])
    );

    // Map the v2 shape onto the raw fields the caller's formatter reads
    // (id_str / full_text / entities.user_mentions / user.* / created_at).
    const tweets = data.map((t: any) => {
      const author = usersById.get(t.author_id);
      const repliedTo = (t.referenced_tweets ?? []).find(
        (r: any) => r.type === 'replied_to'
      );
      return {
        id_str: t.id,
        full_text: t.text,
        created_at: t.created_at,
        conversation_id_str: t.conversation_id,
        in_reply_to_status_id_str: repliedTo?.id,
        is_quote_status: (t.referenced_tweets ?? []).some((r: any) => r.type === 'quoted'),
        retweeted_status: (t.referenced_tweets ?? []).some((r: any) => r.type === 'retweeted')
          ? {}
          : undefined,
        entities: {
          user_mentions: (t.entities?.mentions ?? []).map((m: any) => ({
            screen_name: m.username,
          })),
        },
        user: author
          ? { id_str: author.id, screen_name: author.username, name: author.name }
          : undefined,
      };
    });

    return { tweets };
  }
}
