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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

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
}
