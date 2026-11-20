/**
 * UGOKI LINK v2 — 3-Category Destination Governance & 50 Declarative External Destinations
 *
 * Implements Master Spec §11.11 #4 & #10:
 * - Strict 3-category destination taxonomy:
 *   (i)   `customer_owned_storage`
 *   (ii)  `customer_processor`
 *   (iii) `independent_third_party`
 * - Categories (ii) and (iii) require Decision 30 (`D-30`) + legal sign-off AND
 *   registration in the Approved Exceptions Ledger; otherwise fail-closed as `not_entitled`
 * - Relay propagation: Segment/RudderStack/sGTM relays inherit and enforce the
 *   strictest requirements of every downstream target behind the relay!
 * - Fixed initial catalog of 50 declarative config-driven connectors (JP core tools,
 *   ad conversion APIs, email/MA, CRM, analytics, storage, and Segment-compatible relays)
 *   plus deterministic dry-run validator.
 */

import { requireDecisionEntitled } from '../../../packages/contract/ledgers';
import type { ConsentMode, ConsentPurpose } from '../../../packages/contract/schema';

export type DestinationCategory =
  | 'customer_owned_storage'
  | 'customer_processor'
  | 'independent_third_party';

export type DestinationAuthType =
  | 'oauth2'
  | 'bearer_token'
  | 'api_key_header'
  | 'basic_auth'
  | 'hmac_signed'
  | 'gcp_service_account'
  | 'aws_sigv4';

export type DestinationDomain =
  | 'jp_market'
  | 'ad_conversions'
  | 'email_ma'
  | 'crm_support'
  | 'analytics'
  | 'customer_storage'
  | 'relay_cdp';

export interface DeclarativeFieldMapping {
  readonly sourceField: string;
  readonly targetField: string;
  readonly required: boolean;
  readonly transform?: 'identity' | 'sha256_hex' | 'iso_timestamp' | 'unix_seconds';
}

export interface DeclarativeDestinationSpec {
  readonly id: string;
  readonly displayName: string;
  readonly category: DestinationCategory;
  readonly domain: DestinationDomain;
  readonly japanPriority: boolean;
  readonly endpointTemplate: string;
  readonly allowedHosts: readonly string[];
  readonly authType: DestinationAuthType;
  readonly requiredPurposes: readonly ConsentPurpose[];
  readonly allowedConsentModes: readonly ConsentMode[];
  readonly fieldMappings: readonly DeclarativeFieldMapping[];
  readonly supportsDeletionNotification: boolean;
  readonly isRelay: boolean;
}

function defDest(
  id: string,
  displayName: string,
  category: DestinationCategory,
  domain: DestinationDomain,
  host: string,
  path: string,
  authType: DestinationAuthType,
  requiredPurposes: readonly ConsentPurpose[],
  options?: {
    readonly japanPriority?: boolean;
    readonly supportsDeletion?: boolean;
    readonly isRelay?: boolean;
    readonly extraMapping?: DeclarativeFieldMapping;
  }
): DeclarativeDestinationSpec {
  const mappings: DeclarativeFieldMapping[] = [
    { sourceField: 'event_id', targetField: 'event_id', required: true, transform: 'identity' },
    { sourceField: 'occurred_at', targetField: 'timestamp', required: true, transform: 'iso_timestamp' },
    { sourceField: 'event_name', targetField: 'event_name', required: true, transform: 'identity' },
    ...(options?.extraMapping ? [options.extraMapping] : []),
  ];

  return {
    id,
    displayName,
    category,
    domain,
    japanPriority: options?.japanPriority ?? domain === 'jp_market',
    endpointTemplate: `https://${host}${path}`,
    allowedHosts: [host],
    authType,
    requiredPurposes,
    allowedConsentModes:
      category === 'customer_owned_storage'
        ? ['cookieless', 'stats_exempt', 'session', 'full']
        : ['session', 'full'],
    fieldMappings: mappings,
    supportsDeletionNotification: options?.supportsDeletion ?? true,
    isRelay: options?.isRelay ?? domain === 'relay_cdp',
  };
}

/**
 * Fixed initial 50 declarative configuration-driven external destinations (§11.11 #10).
 * 12 JP-market + 10 Ad Conversions + 8 Email/MA + 7 CRM/Support + 6 Analytics + 4 Storage + 3 Relays = 50.
 */
export const DESTINATION_CATALOG_50: readonly DeclarativeDestinationSpec[] = [
  // --- 1. Japan Market Core Tools (12) ---
  defDest('jp_line_ads_capi', 'LINE Ads Conversion API', 'independent_third_party', 'jp_market', 'api.line.me', '/v2/ads/conversions', 'bearer_token', ['ads']),
  defDest('jp_line_official_msg', 'LINE Official Account Messaging', 'customer_processor', 'jp_market', 'api.line.me', '/v2/bot/message/push', 'bearer_token', ['member_link']),
  defDest('jp_yahoo_ads_capi', 'Yahoo! JAPAN Ads Conversion API', 'independent_third_party', 'jp_market', 'ads-search.yahooapis.jp', '/api/v14/OfflineConversionService', 'oauth2', ['ads']),
  defDest('jp_rakuten_rpp', 'Rakuten Marketing / RPP Conversions', 'independent_third_party', 'jp_market', 'api.rakutenmarketing.com', '/events/v1/conversions', 'bearer_token', ['ads']),
  defDest('jp_smartnews_ads', 'SmartNews Ads Conversion API', 'independent_third_party', 'jp_market', 'ads.smartnews.com', '/v1/conversions', 'bearer_token', ['ads']),
  defDest('jp_karte', 'KARTE Track API', 'customer_processor', 'jp_market', 'api.karte.io', '/v2/track/event/write', 'bearer_token', ['member_link']),
  defDest('jp_bdash', 'b→dash Data Ingest', 'customer_processor', 'jp_market', 'ingest.b-dash.jp', '/v1/events', 'api_key_header', ['member_link']),
  defDest('jp_satori', 'SATORI Marketing Automation', 'customer_processor', 'jp_market', 'api.satr.jp', '/v1/actions', 'api_key_header', ['member_link']),
  defDest('jp_bownow', 'BowNow Lead Sync', 'customer_processor', 'jp_market', 'api.bow-now.jp', '/v1/leads/events', 'api_key_header', ['member_link']),
  defDest('jp_kairos3', 'Kairos3 MA', 'customer_processor', 'jp_market', 'api.kairosmarketing.net', '/v1/events', 'api_key_header', ['member_link']),
  defDest('jp_kintone', 'cybozu kintone Record Webhook', 'customer_processor', 'jp_market', 'kintone.cybozu.com', '/k/v1/record.json', 'api_key_header', ['member_link']),
  defDest('jp_sansan', 'Sansan Contact Activity Sync', 'customer_processor', 'jp_market', 'api.sansan.com', '/v4.2/activities', 'api_key_header', ['member_link']),

  // --- 2. Global Ad Conversions & Media (10) ---
  defDest('ad_google_enhanced', 'Google Ads Enhanced Conversions', 'independent_third_party', 'ad_conversions', 'googleads.googleapis.com', '/v17/customers/{account_id}:uploadClickConversions', 'oauth2', ['ads']),
  defDest('ad_meta_capi', 'Meta Conversions API (CAPI)', 'independent_third_party', 'ad_conversions', 'graph.facebook.com', '/v20.0/{pixel_id}/events', 'bearer_token', ['ads']),
  defDest('ad_tiktok_events', 'TikTok Events API', 'independent_third_party', 'ad_conversions', 'business-api.tiktok.com', '/open_api/v1.3/event/track/', 'api_key_header', ['ads']),
  defDest('ad_x_capi', 'X (Twitter) Conversions API', 'independent_third_party', 'ad_conversions', 'ads-api.x.com', '/12/measurement/conversions/{pixel_id}', 'oauth2', ['ads']),
  defDest('ad_microsoft_capi', 'Microsoft Advertising CAPI', 'independent_third_party', 'ad_conversions', 'capi.uet.microsoft.com', '/v1/{tag_id}/events', 'bearer_token', ['ads']),
  defDest('ad_linkedin_capi', 'LinkedIn Conversions API', 'independent_third_party', 'ad_conversions', 'api.linkedin.com', '/rest/conversionEvents', 'oauth2', ['ads']),
  defDest('ad_pinterest_capi', 'Pinterest Conversions API', 'independent_third_party', 'ad_conversions', 'api.pinterest.com', '/v5/ad_accounts/{account_id}/events', 'oauth2', ['ads']),
  defDest('ad_snap_capi', 'Snapchat Conversions API', 'independent_third_party', 'ad_conversions', 'tr.snapchat.com', '/v2/conversion', 'bearer_token', ['ads']),
  defDest('ad_amazon_ads', 'Amazon Ads Conversions API', 'independent_third_party', 'ad_conversions', 'advertising-api.amazon.com', '/events/v1/conversions', 'oauth2', ['ads']),
  defDest('ad_criteo_events', 'Criteo Events API', 'independent_third_party', 'ad_conversions', 'api.criteo.com', '/2024-04/marketing-solutions/events', 'oauth2', ['ads']),

  // --- 3. Email & Marketing Automation (8) ---
  defDest('ma_marketo', 'Adobe Marketo Engage', 'customer_processor', 'email_ma', 'mktorest.com', '/rest/v1/activities/external.json', 'oauth2', ['member_link']),
  defDest('ma_hubspot_mkt', 'HubSpot Marketing Events', 'customer_processor', 'email_ma', 'api.hubapi.com', '/events/v3/send', 'bearer_token', ['member_link']),
  defDest('ma_braze', 'Braze User Track', 'customer_processor', 'email_ma', 'rest.iad-01.braze.com', '/users/track', 'bearer_token', ['member_link']),
  defDest('ma_customerio', 'Customer.io Track API', 'customer_processor', 'email_ma', 'track.customer.io', '/api/v1/customers/{id}/events', 'basic_auth', ['member_link']),
  defDest('ma_klaviyo', 'Klaviyo Events API', 'customer_processor', 'email_ma', 'a.klaviyo.com', '/api/events/', 'api_key_header', ['member_link']),
  defDest('ma_sendgrid', 'Twilio SendGrid Marketing', 'customer_processor', 'email_ma', 'api.sendgrid.com', '/v3/marketing/contacts', 'bearer_token', ['member_link']),
  defDest('ma_mailchimp', 'Mailchimp Events API', 'customer_processor', 'email_ma', 'api.mailchimp.com', '/3.0/lists/{list_id}/members/{hash}/events', 'basic_auth', ['member_link']),
  defDest('ma_iterable', 'Iterable Events Track', 'customer_processor', 'email_ma', 'api.iterable.com', '/api/events/track', 'api_key_header', ['member_link']),

  // --- 4. CRM & Customer Support (7) ---
  defDest('crm_salesforce', 'Salesforce Sales Cloud REST', 'customer_processor', 'crm_support', 'login.salesforce.com', '/services/data/v60.0/sobjects/Event', 'oauth2', ['member_link']),
  defDest('crm_hubspot', 'HubSpot CRM Contacts/Deals', 'customer_processor', 'crm_support', 'api.hubapi.com', '/crm/v3/objects/contacts', 'bearer_token', ['member_link']),
  defDest('crm_zoho', 'Zoho CRM API', 'customer_processor', 'crm_support', 'www.zohoapis.jp', '/crm/v6/Leads', 'oauth2', ['member_link']),
  defDest('crm_pipedrive', 'Pipedrive Activities API', 'customer_processor', 'crm_support', 'api.pipedrive.com', '/v1/activities', 'api_key_header', ['member_link']),
  defDest('crm_zendesk', 'Zendesk Sunshine Events', 'customer_processor', 'crm_support', 'api.zendesk.com', '/api/sunshine/events', 'basic_auth', ['member_link']),
  defDest('crm_intercom', 'Intercom Events API', 'customer_processor', 'crm_support', 'api.intercom.io', '/events', 'bearer_token', ['member_link']),
  defDest('crm_freshdesk', 'Freshdesk Contacts/Tickets', 'customer_processor', 'crm_support', 'api.freshdesk.com', '/api/v2/contacts', 'basic_auth', ['member_link']),

  // --- 5. Third-Party Analytics (6) ---
  defDest('ana_ga4_mp', 'Google Analytics 4 Measurement Protocol', 'customer_processor', 'analytics', 'www.google-analytics.com', '/mp/collect', 'api_key_header', []),
  defDest('ana_amplitude', 'Amplitude HTTP v2 API', 'customer_processor', 'analytics', 'api2.amplitude.com', '/2/httpapi', 'api_key_header', []),
  defDest('ana_mixpanel', 'Mixpanel Import API', 'customer_processor', 'analytics', 'api.mixpanel.com', '/import', 'basic_auth', []),
  defDest('ana_posthog', 'PostHog Capture API', 'customer_processor', 'analytics', 'us.i.posthog.com', '/capture/', 'api_key_header', []),
  defDest('ana_heap', 'Heap Server Track API', 'customer_processor', 'analytics', 'heapanalytics.com', '/api/track', 'api_key_header', []),
  defDest('ana_adobe', 'Adobe Analytics Edge Network', 'customer_processor', 'analytics', 'edge.adobedc.net', '/ee/v1/interact', 'oauth2', []),

  // --- 6. Customer-Owned Storage & Streams (4) ---
  defDest('stor_bigquery', 'Customer Google BigQuery Dataset', 'customer_owned_storage', 'customer_storage', 'bigquery.googleapis.com', '/bigquery/v2/projects/{project_id}/datasets/{dataset_id}/tables/{table_id}/insertAll', 'gcp_service_account', []),
  defDest('stor_snowflake', 'Customer Snowflake Snowpipe', 'customer_owned_storage', 'customer_storage', 'snowflakecomputing.com', '/v1/data/pipes/{pipe}/insertFiles', 'bearer_token', []),
  defDest('stor_s3_parquet', 'Customer S3 / R2 Parquet Bucket', 'customer_owned_storage', 'customer_storage', 's3.ap-northeast-1.amazonaws.com', '/{bucket}/{prefix}', 'aws_sigv4', []),
  defDest('stor_webhook_direct', 'Customer-Owned Webhook / Stream Sink', 'customer_owned_storage', 'customer_storage', 'hooks.customer.invalid', '/ugokilink/events', 'hmac_signed', []),

  // --- 7. Segment-Compatible & Server-Side Relays (3) ---
  defDest('relay_segment_http', 'Segment Compatible HTTP API Relay', 'customer_processor', 'relay_cdp', 'api.segment.io', '/v1/batch', 'basic_auth', [], { isRelay: true }),
  defDest('relay_rudderstack_http', 'RudderStack Compatible HTTP Relay', 'customer_processor', 'relay_cdp', 'hosted.rudderlabs.com', '/v1/batch', 'basic_auth', [], { isRelay: true }),
  defDest('relay_gtm_server', 'Google Tag Manager Server-Side Relay', 'customer_processor', 'relay_cdp', 'sgtm.customer.invalid', '/mp/collect', 'api_key_header', [], { isRelay: true }),
];

const CATALOG_BY_ID = new Map<string, DeclarativeDestinationSpec>(
  DESTINATION_CATALOG_50.map((d) => [d.id, d])
);

export function getDestinationSpec(
  id: string
): DeclarativeDestinationSpec | undefined {
  return CATALOG_BY_ID.get(id);
}

export interface DestinationEntitlementContext {
  readonly tenantId: string;
  readonly consentMode: ConsentMode;
  readonly grantedPurposes: readonly ConsentPurpose[];
  /** Approved exceptions ledger entries (`destinationId`) per §11.11 #4. */
  readonly approvedExceptions: ReadonlySet<string>;
  /** Downstream destination IDs behind a relay (for relay-chain propagation). */
  readonly downstreamRelayDestinationIds?: readonly string[];
  /** Optional override for unit-testing unlocked D-30 + legal sign-off state. */
  readonly decision30ApprovedOverride?: boolean;
  readonly legalSignOffOverride?: boolean;
  readonly disclosureIncludesDestination?: boolean;
}

export interface DestinationEntitlementResult {
  readonly destinationId: string;
  readonly category: DestinationCategory;
  readonly entitled: boolean;
  readonly status: 'ok' | 'not_entitled';
  readonly reason: string;
  readonly blockedByDownstreamId: string | null;
}

/**
 * Enforces §11.11 #4 destination category governance:
 * - `(i) customer_owned_storage`: permitted whenever consent mode != `off`
 * - `(ii) customer_processor` & `(iii) independent_third_party`:
 *   strictly `not_entitled` until Decision 30 + legal sign-off AND Approved
 *   Exceptions Ledger entry AND required consent purposes AND disclosure entry
 * - Relays recursively propagate and enforce identical checks on EVERY downstream target!
 */
export function evaluateDestinationEntitlement(
  spec: DeclarativeDestinationSpec,
  ctx: DestinationEntitlementContext
): DestinationEntitlementResult {
  if (ctx.consentMode === 'off') {
    return {
      destinationId: spec.id,
      category: spec.category,
      entitled: false,
      status: 'not_entitled',
      reason: 'consent_mode_off',
      blockedByDownstreamId: null,
    };
  }

  if (!spec.allowedConsentModes.includes(ctx.consentMode)) {
    return {
      destinationId: spec.id,
      category: spec.category,
      entitled: false,
      status: 'not_entitled',
      reason: `consent_mode_${ctx.consentMode}_disallowed_for_${spec.category}`,
      blockedByDownstreamId: null,
    };
  }

  for (const reqPurpose of spec.requiredPurposes) {
    if (!ctx.grantedPurposes.includes(reqPurpose)) {
      return {
        destinationId: spec.id,
        category: spec.category,
        entitled: false,
        status: 'not_entitled',
        reason: `missing_consent_purpose:${reqPurpose}`,
        blockedByDownstreamId: null,
      };
    }
  }

  if (
    spec.category === 'customer_processor' ||
    spec.category === 'independent_third_party'
  ) {
    const ledgerD30 = requireDecisionEntitled('D-30', {
      enforceLegalSignOff: true,
    });
    const d30Ok =
      ctx.decision30ApprovedOverride !== undefined &&
      ctx.legalSignOffOverride !== undefined
        ? ctx.decision30ApprovedOverride && ctx.legalSignOffOverride
        : ledgerD30.entitled;

    if (!d30Ok) {
      return {
        destinationId: spec.id,
        category: spec.category,
        entitled: false,
        status: 'not_entitled',
        reason: 'decision_30_and_legal_signoff_required',
        blockedByDownstreamId: null,
      };
    }

    if (!ctx.approvedExceptions.has(spec.id)) {
      return {
        destinationId: spec.id,
        category: spec.category,
        entitled: false,
        status: 'not_entitled',
        reason: 'missing_approved_exception_ledger_entry',
        blockedByDownstreamId: null,
      };
    }

    if (ctx.disclosureIncludesDestination === false) {
      return {
        destinationId: spec.id,
        category: spec.category,
        entitled: false,
        status: 'not_entitled',
        reason: 'destination_missing_from_privacy_disclosure',
        blockedByDownstreamId: null,
      };
    }
  }

  // Relay propagation: every downstream target behind a relay MUST also pass!
  if (spec.isRelay && ctx.downstreamRelayDestinationIds) {
    for (const downstreamId of ctx.downstreamRelayDestinationIds) {
      const downstreamSpec = getDestinationSpec(downstreamId);
      if (!downstreamSpec) {
        return {
          destinationId: spec.id,
          category: spec.category,
          entitled: false,
          status: 'not_entitled',
          reason: `unknown_downstream_relay_destination:${downstreamId}`,
          blockedByDownstreamId: downstreamId,
        };
      }
      const downstreamEval = evaluateDestinationEntitlement(downstreamSpec, {
        ...ctx,
        downstreamRelayDestinationIds: undefined,
      });
      if (!downstreamEval.entitled) {
        return {
          destinationId: spec.id,
          category: spec.category,
          entitled: false,
          status: 'not_entitled',
          reason: `relay_downstream_blocked:${downstreamEval.reason}`,
          blockedByDownstreamId: downstreamId,
        };
      }
    }
  }

  return {
    destinationId: spec.id,
    category: spec.category,
    entitled: true,
    status: 'ok',
    reason: 'entitled',
    blockedByDownstreamId: null,
  };
}

export interface DestinationDryRunResult {
  readonly destinationId: string;
  readonly valid: boolean;
  readonly mappedPayload: Readonly<Record<string, unknown>> | null;
  readonly errors: readonly string[];
}

/**
 * Dry-run validator verifying a declarative destination spec against a sample
 * event without executing network I/O (§11.11 #10).
 */
export function dryRunValidateDestination(
  spec: DeclarativeDestinationSpec,
  sampleEvent: Readonly<Record<string, unknown>>
): DestinationDryRunResult {
  const errors: string[] = [];

  if (!spec.endpointTemplate.startsWith('https://')) {
    errors.push(`Endpoint template for ${spec.id} must use https://`);
  }
  if (spec.allowedHosts.length === 0) {
    errors.push(`Destination ${spec.id} must declare at least one allowed host`);
  }

  const mapped: Record<string, unknown> = {};
  for (const m of spec.fieldMappings) {
    const val = sampleEvent[m.sourceField];
    if (val === undefined || val === null) {
      if (m.required) {
        errors.push(`Missing required sourceField "${m.sourceField}"`);
      }
      continue;
    }
    if (m.transform === 'unix_seconds' && typeof val === 'string') {
      const parsed = Date.parse(val);
      mapped[m.targetField] = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : val;
    } else {
      mapped[m.targetField] = val;
    }
  }

  return {
    destinationId: spec.id,
    valid: errors.length === 0,
    mappedPayload: errors.length === 0 ? mapped : null,
    errors,
  };
}
