/**
 * UGOKI MAP Event Ingest Worker
 *
 * Cloudflare Workers edge endpoint for tracking events.
 * Receives events from tracking.js, buffers them, and batch-inserts into ClickHouse.
 *
 * Flow:
 *   tracking.js → POST /api/track → Worker (buffer) → ClickHouse HTTP INSERT
 *
 * Design:
 *   - Immediate 200 response to client (non-blocking)
 *   - Events buffered in-memory, flushed via waitUntil()
 *   - Each event is routed to the correct ClickHouse table by event_type
 *   - CORS enabled for cross-origin tracking
 */

export interface Env {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_DB: string;
  ALLOWED_ORIGINS: string;
  BATCH_SIZE: string;
  FLUSH_INTERVAL_MS: string;
}

// ── Event type → table routing ──────────────────────────────────────

const BEHAVIOR_TYPES = new Set([
  'text_copy', 'scroll_reversal', 'tab_return',
  'browser_back', 'pinch_zoom', 'cta_hover',
]);

const FORM_TYPES = new Set([
  'form_view', 'form_field_focus', 'form_field_blur',
  'form_submit', 'form_abandon',
]);

const VIDEO_TYPES = new Set([
  'video_play', 'video_pause', 'video_complete',
  'video_milestone', 'video_summary',
]);

// ── ClickHouse column definitions per table ─────────────────────────

const EVENTS_COLUMNS = [
  'id', 'site_id', 'session_id', 'user_id', 'event_type', 'timestamp',
  'url', 'referrer', 'user_agent', 'viewport_width', 'viewport_height',
  'element_tag_name', 'element_id', 'element_class_name', 'element_text',
  'element_href', 'click_x', 'click_y', 'scroll_y', 'scroll_percentage',
  'read_y', 'read_duration', 'event_revenue',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'conversion_type', 'conversion_value',
  'search_query', 'device_type', 'ga_client_id', 'external_id',
  'element_selector', 'sequence_id',
  'previous_url', 'navigation_trigger',
] as const;

const BEHAVIOR_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url', 'event_type',
  'copied_text', 'copied_length', 'copy_y', // copied_text kept in schema but always null (privacy)
  'reversal_count', 'final_scroll_y',
  'away_duration_ms', 'tab_switch_count', 'return_scroll_y',
  'from_url', 'scroll_y_at_back', 'scroll_depth_at_back',
  'zoom_scale', 'zoom_y', 'target_tag', 'target_src', 'target_alt',
  'pinch_zoom_count', 'hover_duration_ms', 'hover_y', 'hover_clicked',
  'element_path', 'element_text', 'device_type',
] as const;

const IMAGE_VISIBILITY_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url',
  'image_src', 'image_alt', 'image_width', 'image_height',
  'visible_duration_ms', 'max_visible_ratio',
  'viewport_position', 'element_y', 'device_type',
] as const;

const FORM_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url', 'event_type',
  'form_id', 'form_action', 'form_method',
  'field_name', 'field_type', 'field_label',
  'focus_duration_ms', 'field_order', 'total_fields',
  'filled_fields', 'time_to_submit_ms', 'device_type',
] as const;

const VIDEO_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url', 'event_type',
  'video_src', 'video_title', 'video_duration',
  'current_time', 'progress_percent',
  'play_count', 'pause_count', 'total_watch_time_ms',
  'milestone', 'device_type',
] as const;

const ELEMENT_VISIBILITY_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url',
  'element_selector', 'element_tag', 'element_text', 'element_y',
  'visible_duration_ms', 'max_visible_ratio',
  'element_clicked', 'device_type',
] as const;

const SCROLL_TIMELINE_COLUMNS = [
  'site_id', 'session_id', 'page_url', 'timestamp',
  'scroll_y', 'scroll_percentage', 'viewport_height',
  'direction', 'speed', 'dwell_ms', 'device_type',
] as const;

const ELEMENT_VISIBILITY_V2_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url',
  'element_selector', 'element_tag', 'element_text', 'element_href',
  'element_y', 'visible_duration_ms', 'max_visible_ratio',
  'first_visible_at', 'element_clicked',
  'is_cta', 'is_above_fold', 'device_type', 'viewport_height',
] as const;

const WEB_VITALS_COLUMNS = [
  'id', 'site_id', 'session_id', 'page_url',
  'lcp_ms', 'lcp_element', 'cls_score', 'inp_ms',
  'ttfb_ms', 'fcp_ms', 'connection_type', 'downlink_mbps',
  'rtt_ms', 'device_type',
] as const;

// ── Routing logic ───────────────────────────────────────────────────

interface RouteTarget {
  table: string;
  columns: readonly string[];
}

function routeEvent(eventType: string): RouteTarget {
  if (BEHAVIOR_TYPES.has(eventType)) {
    return { table: 'behavior_signals', columns: BEHAVIOR_COLUMNS };
  }
  if (eventType === 'image_visibility') {
    return { table: 'image_visibility', columns: IMAGE_VISIBILITY_COLUMNS };
  }
  if (FORM_TYPES.has(eventType)) {
    return { table: 'form_interactions', columns: FORM_COLUMNS };
  }
  if (VIDEO_TYPES.has(eventType)) {
    return { table: 'video_events', columns: VIDEO_COLUMNS };
  }
  if (eventType === 'element_visibility') {
    return { table: 'element_visibility', columns: ELEMENT_VISIBILITY_COLUMNS };
  }
  if (eventType === 'scroll_timeline') {
    return { table: 'scroll_timeline', columns: SCROLL_TIMELINE_COLUMNS };
  }
  if (eventType === 'element_visibility_v2') {
    return { table: 'element_visibility_v2', columns: ELEMENT_VISIBILITY_V2_COLUMNS };
  }
  if (eventType === 'web_vitals') {
    return { table: 'web_vitals', columns: WEB_VITALS_COLUMNS };
  }
  // Default: main events table
  return { table: 'events', columns: EVENTS_COLUMNS };
}

// ── ClickHouse batch INSERT (JSONEachRow) ───────────────────────────

/**
 * Pick only defined columns from event, dropping undefined/null for
 * non-essential fields so ClickHouse uses DEFAULT values.
 */
function pickColumns(
  event: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    const v = event[col];
    if (v !== undefined && v !== null && v !== '') {
      row[col] = v;
    }
  }
  return row;
}

/**
 * Parse CLICKHOUSE_URL which may contain credentials:
 *   http://user:pass@host:port → { baseUrl: http://host:port, user, password }
 */
function parseClickHouseUrl(raw: string): { baseUrl: string; user: string; password: string } {
  const m = raw.match(/^(https?:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (m) {
    return { baseUrl: `${m[1]}${m[4]}`, user: m[2], password: m[3] };
  }
  return { baseUrl: raw, user: 'default', password: '' };
}

async function flushToClickHouse(
  env: Env,
  events: Record<string, unknown>[],
): Promise<void> {
  const { baseUrl, user, password } = parseClickHouseUrl(env.CLICKHOUSE_URL);

  // Group events by target table
  const groups = new Map<string, { columns: readonly string[]; rows: Record<string, unknown>[] }>();

  for (const event of events) {
    const eventType = String(event.event_type || '');
    if (!event.site_id || !eventType) continue;

    // Map tracking.js field names to table column names
    if (event.url && !event.page_url) {
      event.page_url = event.url;
    }

    // Convert ISO 8601 timestamp to ClickHouse DateTime format (YYYY-MM-DD HH:MM:SS)
    if (event.timestamp && typeof event.timestamp === 'string') {
      const ts = new Date(event.timestamp);
      if (!isNaN(ts.getTime())) {
        event.timestamp = ts.toISOString().replace('T', ' ').slice(0, 19);
      }
    }

    const { table, columns } = routeEvent(eventType);
    let group = groups.get(table);
    if (!group) {
      group = { columns, rows: [] };
      groups.set(table, group);
    }
    group.rows.push(pickColumns(event, columns));
  }

  // INSERT each group using JSONEachRow format
  const promises: Promise<void>[] = [];
  for (const [table, { rows }] of groups) {
    if (rows.length === 0) continue;

    // JSONEachRow: one JSON object per line
    const body = rows.map(r => JSON.stringify(r)).join('\n') + '\n';

    const insertUrl = `${baseUrl}/?database=${env.CLICKHOUSE_DB}`
      + `&user=${encodeURIComponent(user)}`
      + `&password=${encodeURIComponent(password)}`
      + `&query=${encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`)}`
      + `&input_format_skip_unknown_fields=1`;

    promises.push(
      fetch(insertUrl, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
      }).then(async (resp) => {
        if (!resp.ok) {
          const text = await resp.text();
          console.error(`ClickHouse INSERT ${table} failed (${resp.status}): ${text.slice(0, 500)}`);
        } else {
          console.log(`ClickHouse INSERT ${table}: ${rows.length} rows`);
        }
      })
    );
  }

  await Promise.allSettled(promises);
}

// ── CORS helpers ────────────────────────────────────────────────────

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS;
  const respOrigin = allowed === '*' ? '*' : (origin || '*');
  return {
    'Access-Control-Allow-Origin': respOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Request handler ─────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'ugokimap-event-ingest' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Only accept POST /api/track
    if (url.pathname !== '/api/track' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Parse payload
    let events: Record<string, unknown>[];
    try {
      const body = await request.json() as Record<string, unknown>;
      if (Array.isArray(body.events)) {
        events = body.events as Record<string, unknown>[];
      } else if (body.site_id && body.event_type) {
        // Single event (no wrapper)
        events = [body];
      } else {
        return new Response(JSON.stringify({ error: 'Invalid payload' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Validate: must have at least one event with site_id
    const validEvents = events.filter(e => e.site_id && e.event_type);
    if (validEvents.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid events' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Respond immediately, flush in background
    ctx.waitUntil(flushToClickHouse(env, validEvents));

    return new Response(
      JSON.stringify({ success: true, received: validEvents.length }),
      {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      }
    );
  },
};
