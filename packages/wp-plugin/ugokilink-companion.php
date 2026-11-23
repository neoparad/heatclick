<?php
/**
 * Plugin Name: UGOKI LINK Companion
 * Description: Trust-rooted static snippet emitter, signed typed origin promotion adapter, publish hook, and owner two-key local policy guard for UGOKI LINK v2.
 * Version: 2.0.0
 * Requires PHP: 8.1
 * License: Proprietary
 *
 * Security invariants (§10.9, §12.1 #3, D-24, DEL M9 / App. H, [C-17], [H-08]):
 * 1. Offline-pinned Ed25519 release keys verify EVERY incoming command over `payload_canonical_json`
 *    with strict `SODIUM_CRYPTO_SIGN_BYTES` length check and `try/catch (\Throwable $e)` -> 401.
 * 2. Site binding (`tenant_id`, `site_id`, normalized `home_url`) is verified BEFORE checking or
 *    advancing `ugk_last_command_seq` (preventing cross-site replay DoS).
 * 3. True 2-key site owner local policy (`ugk_owner_local_policy` + `ugokilink_local_approvals` in `wp_options`,
 *    writable ONLY via local WP-Admin `manage_options` + WP nonce `ugokilink_local_approve`):
 *    cloud payloads can NEVER self-assert admin confirmation; any command exceeding `allowed_auto_classes`
 *    or touching `require_admin_confirmation_classes` / indexable SEO / outbound hosts requires an
 *    unconsumed local approval digest `hash('sha256', site_id . '|' . post_id . '|' . before_sha256 . '|' . after_sha256 . '|' . command_seq)`
 *    within TTL, consumed atomically on apply.
 * 4. Enforces `daily_apply_cap` per UTC day (`ugk_daily_apply_counter`), refuses active editor locks,
 *    tracks `$acquiredLock` so `finally` ONLY releases `_edit_lock` if acquired by THIS request,
 *    verifies BOTH `expected_content_sha256` and `expected_modified_gmt`, and sanitizes via `wp_kses_post`.
 * 5. Restore swaps the stored pre-image back ONLY when current content SHA-256 equals post-image SHA-256;
 *    otherwise returns 409 `rollback_conflict` with three-way merge payload.
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/command-session.php';

final class UgokiLink_Companion_Plugin
{
    public const PLUGIN_VERSION = '2.0.0';
    public const OPTION_LOCAL_POLICY = 'ugk_owner_local_policy';
    public const OPTION_LOCAL_APPROVALS = 'ugokilink_local_approvals';
    public const OPTION_DAILY_APPLY_COUNTER = 'ugk_daily_apply_counter';
    public const OPTION_BOUND_TENANT_ID = 'ugk_bound_tenant_id';
    public const OPTION_BOUND_SITE_ID = 'ugk_bound_site_id';
    public const OPTION_LAST_SEQ = 'ugk_last_command_seq';
    public const OPTION_PENDING_JOURNAL = 'ugk_pending_command_journal';
    public const PENDING_COMMAND_LEASE_MS = 30000;
    public const OPTION_MANIFEST_JSON = 'ugk_inline_manifest_json';
    public const OPTION_FILTER_PATCHES = 'ugk_render_filter_patches';
    public const NONCE_ACTION_LOCAL_APPROVE = 'ugokilink_local_approve';
    public const META_PREIMAGE_PREFIX = '_ugk_preimage_';
    public const EMPTY_FILE_SRI = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

    /**
     * Offline-pinned Ed25519 public keys (base64 raw 32-byte keys).
     * Replaced at build/release time by offline release signing pipeline.
     *
     * @var array<string, string>
     */
    private const PINNED_ED25519_PUBKEYS = [
        'ugk-release-2026-11' => 'REPLACE_WITH_OFFLINE_PINNED_ED25519_PUBKEY_BASE64',
    ];

    public static function register(): void
    {
        add_action('wp_head', [self::class, 'emitPinnedSnippetAndManifest'], 1);
        add_action('rest_api_init', [self::class, 'registerRestRoutes']);
        add_action('admin_post_ugokilink_local_approve', [self::class, 'handleLocalAdminApprovalPost']);
        add_action('transition_post_status', [self::class, 'onPostPublished'], 10, 3);
        add_filter('the_content', [self::class, 'applyRenderFilterPatches'], 20);
    }

    /**
     * Returns owner-authored local policy (editable ONLY in wp-admin).
     * No UGOKI signed command can relax these bounds.
     *
     * @return array{
     *   local_stop: bool,
     *   allowed_auto_classes: array<int, string>,
     *   daily_apply_cap: int,
     *   require_admin_confirmation_classes: array<int, string>
     * }
     */
    public static function getOwnerLocalPolicy(): array
    {
        $defaults = [
            'local_stop' => false,
            'allowed_auto_classes' => [], // Default: ZERO auto-apply classes until owner opts in
            'daily_apply_cap' => 10,
            'require_admin_confirmation_classes' => [
                'indexable_major',
                'touch_indexable_seo',
                'change_outbound_hosts',
                'price',
                'offer',
            ],
        ];
        $stored = get_option(self::OPTION_LOCAL_POLICY, []);
        if (!is_array($stored)) {
            return $defaults;
        }
        return array_merge($defaults, $stored);
    }

    /**
     * Normalizes `home_url` identically across PHP and TypeScript (`[H-08]`).
     */
    public static function normalizeHomeUrl(string $rawUrl): string
    {
        $trimmed = trim($rawUrl);
        if ($trimmed === '') {
            return '';
        }
        $parts = wp_parse_url($trimmed);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return '';
        }
        $scheme = strtolower((string) $parts['scheme']);
        if ($scheme !== 'https' && $scheme !== 'http') {
            return '';
        }
        $host = strtolower((string) $parts['host']);
        $port = isset($parts['port']) ? (int) $parts['port'] : null;
        $portPart = '';
        if ($port !== null && !(($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80))) {
            $portPart = ':' . $port;
        }
        $path = isset($parts['path']) ? rtrim((string) $parts['path'], '/') : '';
        return $scheme . '://' . $host . $portPart . $path;
    }

    /**
     * Produces deterministic canonical JSON matching `workers/link-signer` (`[H-08]`).
     */
    public static function canonicalizeJsonValue(mixed $value): string
    {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value) || is_string($value)) {
            return (string) wp_json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                $items = array_map([self::class, 'canonicalizeJsonValue'], $value);
                return '[' . implode(',', $items) . ']';
            }
            $keys = array_keys($value);
            sort($keys, SORT_STRING);
            $pairs = [];
            foreach ($keys as $k) {
                $keyJson = (string) wp_json_encode((string) $k, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                $pairs[] = $keyJson . ':' . self::canonicalizeJsonValue($value[$k]);
            }
            return '{' . implode(',', $pairs) . '}';
        }
        return 'null';
    }

    /**
     * Computes 2-key local approval digest (`[C-17]`):
     * `hash('sha256', site_id . '|' . post_id . '|' . before_sha256 . '|' . after_sha256 . '|' . command_seq)`
     */
    public static function computeLocalApprovalDigest(
        string $siteId,
        int $postId,
        string $beforeSha256,
        string $afterSha256,
        int $commandSeq
    ): string {
        return hash(
            'sha256',
            $siteId . '|' . $postId . '|' . $beforeSha256 . '|' . $afterSha256 . '|' . $commandSeq
        );
    }

    /**
     * Local WP-Admin ONLY handler (`manage_options` + WP nonce `ugokilink_local_approve`, `[C-17]`).
     * Never reachable via signed cloud commands.
     */
    public static function handleLocalAdminApprovalPost(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Forbidden: manage_options required', 'Forbidden', ['response' => 403]);
        }
        check_admin_referer(self::NONCE_ACTION_LOCAL_APPROVE, '_ugk_nonce');

        $siteId = (string) get_option(self::OPTION_BOUND_SITE_ID, '');
        $postId = isset($_POST['post_id']) ? (int) $_POST['post_id'] : 0;
        $beforeSha = isset($_POST['before_sha256']) ? sanitize_text_field(wp_unslash((string) $_POST['before_sha256'])) : '';
        $afterSha = isset($_POST['after_sha256']) ? sanitize_text_field(wp_unslash((string) $_POST['after_sha256'])) : '';
        $commandSeq = isset($_POST['command_seq']) ? (int) $_POST['command_seq'] : 0;
        $ttlSeconds = isset($_POST['ttl_seconds']) ? (int) $_POST['ttl_seconds'] : 900;
        $boundedTtl = max(60, min(86400, $ttlSeconds));

        if ($siteId === '' || $postId <= 0 || strlen($beforeSha) !== 64 || strlen($afterSha) !== 64 || $commandSeq <= 0) {
            wp_die('Invalid local approval parameters', 'Bad Request', ['response' => 400]);
        }

        $digest = self::computeLocalApprovalDigest($siteId, $postId, $beforeSha, $afterSha, $commandSeq);
        $result = UgokiLink_Command_Session::run(static fn () => self::storeLocalApproval(
            $digest, $siteId, $postId, $beforeSha, $afterSha, $commandSeq, $boundedTtl
        ));
        if (is_wp_error($result)) {
            wp_die($result->get_error_message(), '', ['response' => $result->get_error_data()['status']]);
        }
        wp_safe_redirect(admin_url('options-general.php?page=ugokilink-companion&approved=1'));
        exit;
    }

    private static function storeLocalApproval(
        string $digest, string $siteId, int $postId, string $beforeSha, string $afterSha, int $commandSeq, int $boundedTtl
    ): bool|\WP_Error {
        $stored = get_option(self::OPTION_LOCAL_APPROVALS, []);
        if (!is_array($stored)) {
            $stored = [];
        }
        $nowUnix = time();
        // Prune expired or consumed records
        foreach ($stored as $k => $rec) {
            if (!is_array($rec) || !empty($rec['consumed']) || (int) ($rec['expires_at_unix'] ?? 0) <= $nowUnix) {
                unset($stored[$k]);
            }
        }

        $stored[$digest] = [
            'digest' => $digest,
            'site_id' => $siteId,
            'post_id' => $postId,
            'before_sha256' => $beforeSha,
            'after_sha256' => $afterSha,
            'command_seq' => $commandSeq,
            'approved_by_user_id' => get_current_user_id(),
            'approved_at_unix' => $nowUnix,
            'expires_at_unix' => $nowUnix + $boundedTtl,
            'state' => 'unused',
            'claim_token' => null,
            'consumed' => false,
        ];
        if (update_option(self::OPTION_LOCAL_APPROVALS, $stored, false)
            || get_option(self::OPTION_LOCAL_APPROVALS, []) === $stored) {
            return true;
        }
        return new \WP_Error('approval_write_failed', 'Could not store local approval.', ['status' => 503]);
    }

    /**
     * Atomically claims an unused local WP-Admin approval (`unused` -> `claimed`) using a
     * per-digest `add_option` lock so concurrent deliveries cannot double-consume (`[#7]`).
     */
    private static function claimLocalWpAdminApproval(string $expectedDigest): ?string
    {
        $lockOption = 'ugk_approval_claim_' . $expectedDigest;
        $claimToken = bin2hex(random_bytes(16));

        // Atomic compare-and-set via MySQL UNIQUE option_name on wp_options
        if (!add_option($lockOption, $claimToken, '', false)) {
            return null;
        }

        $stored = get_option(self::OPTION_LOCAL_APPROVALS, []);
        if (!is_array($stored) || !isset($stored[$expectedDigest]) || !is_array($stored[$expectedDigest])) {
            delete_option($lockOption);
            return null;
        }
        $rec = $stored[$expectedDigest];
        $nowUnix = time();
        $recDigest = isset($rec['digest']) && is_string($rec['digest']) ? $rec['digest'] : '';
        $expiresAt = isset($rec['expires_at_unix']) ? (int) $rec['expires_at_unix'] : 0;
        $state = isset($rec['state']) && is_string($rec['state'])
            ? $rec['state']
            : (!empty($rec['consumed']) ? 'consumed' : 'unused');

        if ($state !== 'unused' || !empty($rec['consumed']) || $expiresAt <= $nowUnix || !hash_equals($expectedDigest, $recDigest)) {
            delete_option($lockOption);
            return null;
        }

        $stored[$expectedDigest]['state'] = 'claimed';
        $stored[$expectedDigest]['claim_token'] = $claimToken;
        $stored[$expectedDigest]['claimed_at_unix'] = $nowUnix;
        update_option(self::OPTION_LOCAL_APPROVALS, $stored, false);
        return $claimToken;
    }

    /**
     * Commits a previously claimed local approval (`claimed` -> `consumed`) after post update succeeds (`[#7]`).
     */
    private static function commitLocalWpAdminApproval(string $expectedDigest, string $claimToken): void
    {
        $stored = get_option(self::OPTION_LOCAL_APPROVALS, []);
        if (is_array($stored) && isset($stored[$expectedDigest]) && is_array($stored[$expectedDigest])) {
            $recToken = isset($stored[$expectedDigest]['claim_token']) && is_string($stored[$expectedDigest]['claim_token'])
                ? $stored[$expectedDigest]['claim_token']
                : '';
            if (($stored[$expectedDigest]['state'] ?? '') === 'claimed' && hash_equals($claimToken, $recToken)) {
                $stored[$expectedDigest]['state'] = 'consumed';
                $stored[$expectedDigest]['consumed'] = true;
                $stored[$expectedDigest]['claim_token'] = null;
                $stored[$expectedDigest]['consumed_at_unix'] = time();
                update_option(self::OPTION_LOCAL_APPROVALS, $stored, false);
            }
        }
        delete_option('ugk_approval_claim_' . $expectedDigest);
    }

    /**
     * Releases a previously claimed local approval (`claimed` -> `unused`) when post update fails (`[#7]`).
     */
    private static function releaseLocalWpAdminApproval(string $expectedDigest, string $claimToken): void
    {
        $stored = get_option(self::OPTION_LOCAL_APPROVALS, []);
        if (is_array($stored) && isset($stored[$expectedDigest]) && is_array($stored[$expectedDigest])) {
            $recToken = isset($stored[$expectedDigest]['claim_token']) && is_string($stored[$expectedDigest]['claim_token'])
                ? $stored[$expectedDigest]['claim_token']
                : '';
            if (($stored[$expectedDigest]['state'] ?? '') === 'claimed' && hash_equals($claimToken, $recToken)) {
                $stored[$expectedDigest]['state'] = 'unused';
                $stored[$expectedDigest]['consumed'] = false;
                $stored[$expectedDigest]['claim_token'] = null;
                update_option(self::OPTION_LOCAL_APPROVALS, $stored, false);
            }
        }
        delete_option('ugk_approval_claim_' . $expectedDigest);
    }

    /**
     * Emits the static pinned snippet, empty-file SRI reference, and non-executable
     * JSON inline manifest (never executable code in cached HTML).
     */
    public static function emitPinnedSnippetAndManifest(): void
    {
        $snippet = get_option('ugk_pinned_snippet_html', '');
        if (is_string($snippet) && $snippet !== '') {
            echo $snippet . "\n"; // Static offline-pinned snippet saved at install
        }

        $manifest = get_option(self::OPTION_MANIFEST_JSON, '');
        if (is_string($manifest) && $manifest !== '') {
            $safeJson = str_replace(['<', '>', '&'], ['\u003c', '\u003e', '\u0026'], $manifest);
            echo '<script type="application/json" id="ugk-inline-manifest">' . $safeJson . "</script>\n";
        }
    }

    public static function registerRestRoutes(): void
    {
        register_rest_route('ugokilink/v1', '/command', [
            'methods' => 'POST',
            'callback' => [self::class, 'handleSignedCommand'],
            'permission_callback' => '__return_true', // Cryptographic Ed25519 auth enforced inside handler
        ]);
    }

    /**
     * Verifies Ed25519 detached signature, canonical JSON byte parity, site/home_url binding
     * (BEFORE seq check!), not_after expiry, and monotonic seq (`[H-08]`).
     *
     * @param array<string, mixed> $envelope
     * @return array{ok: bool, error?: string, status?: int, payload?: array<string, mixed>}
     */
    private static function verifySignedEnvelope(array $envelope): array
    {
        if (!function_exists('sodium_crypto_sign_verify_detached')) {
            return ['ok' => false, 'error' => 'sodium_unavailable', 'status' => 500];
        }

        $kid = isset($envelope['kid']) && is_string($envelope['kid']) ? $envelope['kid'] : '';
        $sigB64 = isset($envelope['signature_b64']) && is_string($envelope['signature_b64']) ? $envelope['signature_b64'] : '';
        $payloadCanonical = isset($envelope['payload_canonical_json']) && is_string($envelope['payload_canonical_json'])
            ? $envelope['payload_canonical_json']
            : '';

        if ($payloadCanonical === '' || !isset(self::PINNED_ED25519_PUBKEYS[$kid])) {
            return ['ok' => false, 'error' => 'unknown_key_id', 'status' => 401];
        }

        $pubKey = base64_decode(self::PINNED_ED25519_PUBKEYS[$kid], true);
        $sig = base64_decode($sigB64, true);
        if (
            !is_string($pubKey)
            || !is_string($sig)
            || strlen($pubKey) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES
        ) {
            return ['ok' => false, 'error' => 'malformed_signature', 'status' => 401];
        }

        try {
            $sigValid = sodium_crypto_sign_verify_detached($sig, $payloadCanonical, $pubKey);
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => 'invalid_signature', 'status' => 401];
        }
        if (!$sigValid) {
            return ['ok' => false, 'error' => 'invalid_signature', 'status' => 401];
        }

        $payload = json_decode($payloadCanonical, true);
        if (!is_array($payload)) {
            return ['ok' => false, 'error' => 'invalid_payload_json', 'status' => 400];
        }

        // Verify canonical JSON byte parity so duplicate keys or non-canonical JSON are rejected
        if (!hash_equals(self::canonicalizeJsonValue($payload), $payloadCanonical)) {
            return ['ok' => false, 'error' => 'non_canonical_payload_json', 'status' => 400];
        }

        // [H-08]: Verify tenant_id + site_id + normalized home_url BEFORE checking/advancing command_seq!
        $boundTenantId = (string) get_option(self::OPTION_BOUND_TENANT_ID, '');
        $boundSiteId = (string) get_option(self::OPTION_BOUND_SITE_ID, '');
        $boundHomeUrl = self::normalizeHomeUrl((string) home_url());

        $payloadTenantId = isset($payload['tenant_id']) && is_string($payload['tenant_id']) ? $payload['tenant_id'] : '';
        $payloadSiteId = isset($payload['site_id']) && is_string($payload['site_id']) ? $payload['site_id'] : '';
        $payloadHomeUrl = isset($payload['home_url']) && is_string($payload['home_url'])
            ? self::normalizeHomeUrl($payload['home_url'])
            : '';

        if ($boundTenantId === '' || $boundSiteId === '' || $boundHomeUrl === '' || $payloadTenantId === '' || $payloadSiteId === '' || $payloadHomeUrl === '') {
            return ['ok' => false, 'error' => 'missing_site_binding', 'status' => 401];
        }
        if (
            !hash_equals($boundTenantId, $payloadTenantId)
            || !hash_equals($boundSiteId, $payloadSiteId)
            || !hash_equals($boundHomeUrl, $payloadHomeUrl)
        ) {
            return ['ok' => false, 'error' => 'site_binding_mismatch', 'status' => 403];
        }

        $notAfter = isset($payload['not_after']) && is_string($payload['not_after']) ? strtotime($payload['not_after']) : false;
        if ($notAfter === false || time() > $notAfter) {
            return ['ok' => false, 'error' => 'command_expired', 'status' => 401];
        }

        $seq = isset($payload['seq']) && is_int($payload['seq']) ? $payload['seq'] : 0;
        $lastSeq = (int) get_option(self::OPTION_LAST_SEQ, 0);
        if ($seq <= $lastSeq) {
            return ['ok' => false, 'error' => 'seq_replay_rejected', 'status' => 409];
        }

        update_option(self::OPTION_LAST_SEQ, $seq, false);
        $payload['__prev_seq'] = $lastSeq;
        return ['ok' => true, 'payload' => $payload];
    }

    /**
     * Atomically rolls back `OPTION_LAST_SEQ` from `$expectedSeq` to `$prevSeq` using a single
     * conditional SQL UPDATE so a stalled failure never clobbers a concurrent newer `seq` (`[#7]`).
     */
    private static function rollbackLastSeqIfMatches(int $expectedSeq, int $prevSeq): bool
    {
        if ($expectedSeq <= 0) {
            return false;
        }
        global $wpdb;
        $affected = $wpdb->query(
            $wpdb->prepare(
                "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s",
                (string) $prevSeq,
                self::OPTION_LAST_SEQ,
                (string) $expectedSeq
            )
        );
        if (is_int($affected) && $affected > 0) {
            wp_cache_delete(self::OPTION_LAST_SEQ, 'options');
            wp_cache_delete('alloptions', 'options');
            return true;
        }
        return false;
    }

    /**
     * Reconciles expired `in_progress` pending-command journal entries left behind by a crash between
     * `wp_update_post` and approval commit (`[#7]`):
     * - If an `in_progress` entry's lease is STILL ACTIVE (`$nowMs < lease_expires_at_ms`), DO NOT
     *   roll it back or release its approval; return `blockedByInFlight => true` so concurrent requests
     *   fail closed with HTTP `409 command_in_flight`.
     * - For expired leases (`$nowMs >= lease_expires_at_ms`):
     *   - If current `sha256(post_content) === expected_after_sha256`, finishes committing `claimed -> consumed`.
     *   - Otherwise releases `claimed -> unused` and atomically CAS-rolls back `OPTION_LAST_SEQ`
     *     ONLY when `option_value === command_seq` via a single conditional SQL UPDATE.
     *
     * @return array{blockedByInFlight: bool, reconciledCount: int}
     */
    public static function reconcilePendingCommands(?int $nowMs = null): array
    {
        $result = UgokiLink_Command_Session::run(static fn () => self::reconcileUnderLock($nowMs));
        if (is_wp_error($result)) {
            if ($result->get_error_code() === 'command_in_flight') {
                return ['blockedByInFlight' => true, 'reconciledCount' => 0];
            }
            throw new \RuntimeException($result->get_error_message());
        }
        return $result;
    }

    private static function reconcileUnderLock(?int $nowMs = null): array
    {
        $nowMs = $nowMs ?? (int) round(microtime(true) * 1000);
        $journal = get_option(self::OPTION_PENDING_JOURNAL, []);
        if (!is_array($journal) || count($journal) === 0) {
            return ['blockedByInFlight' => false, 'reconciledCount' => 0];
        }

        $changed = false;
        $blockedByInFlight = false;
        $reconciledCount = 0;

        foreach ($journal as $seqKey => $entry) {
            if (!is_array($entry) || ($entry['status'] ?? '') !== 'in_progress') {
                continue;
            }

            $leaseExpiresAtMs = isset($entry['lease_expires_at_ms']) ? (int) $entry['lease_expires_at_ms'] : 0;
            if ($leaseExpiresAtMs > 0 && $nowMs < $leaseExpiresAtMs) {
                $blockedByInFlight = true;
                continue;
            }

            $cmdSeq = (int) ($entry['command_seq'] ?? 0);
            $postId = (int) ($entry['post_id'] ?? 0);
            $digest = isset($entry['approval_digest']) && is_string($entry['approval_digest']) ? $entry['approval_digest'] : null;
            $claimToken = isset($entry['claim_token']) && is_string($entry['claim_token']) ? $entry['claim_token'] : null;
            $expectedAfter = isset($entry['expected_after_sha256']) && is_string($entry['expected_after_sha256'])
                ? $entry['expected_after_sha256']
                : '';
            $prevSeq = (int) ($entry['prev_seq'] ?? 0);

            $post = $postId > 0 ? get_post($postId) : null;
            $currentSha = $post instanceof \WP_Post ? hash('sha256', (string) $post->post_content) : null;

            if ($currentSha !== null && $expectedAfter !== '' && hash_equals($expectedAfter, $currentSha)) {
                if ($digest !== null && $claimToken !== null) {
                    self::commitLocalWpAdminApproval($digest, $claimToken);
                }
            } else {
                if ($digest !== null && $claimToken !== null) {
                    self::releaseLocalWpAdminApproval($digest, $claimToken);
                }
                if ($cmdSeq > 0) {
                    self::rollbackLastSeqIfMatches($cmdSeq, $prevSeq);
                }
            }

            unset($journal[$seqKey]);
            $changed = true;
            $reconciledCount++;
        }

        if ($changed) {
            update_option(self::OPTION_PENDING_JOURNAL, $journal, false);
        }

        return [
            'blockedByInFlight' => $blockedByInFlight,
            'reconciledCount' => $reconciledCount,
        ];
    }

    /**
     * @param array<string, mixed> $record
     */
    private static function writePendingCommandJournal(int $cmdSeq, array $record): void
    {
        $journal = get_option(self::OPTION_PENDING_JOURNAL, []);
        if (!is_array($journal)) {
            $journal = [];
        }
        $journal[(string) $cmdSeq] = $record;
        update_option(self::OPTION_PENDING_JOURNAL, $journal, false);
    }

    private static function clearPendingCommandJournal(int $cmdSeq): void
    {
        $journal = get_option(self::OPTION_PENDING_JOURNAL, []);
        if (!is_array($journal) || !isset($journal[(string) $cmdSeq])) {
            return;
        }
        unset($journal[(string) $cmdSeq]);
        update_option(self::OPTION_PENDING_JOURNAL, $journal, false);
    }

    public static function handleSignedCommand(\WP_REST_Request $request): \WP_REST_Response
    {
        $result = UgokiLink_Command_Session::run(static fn () => self::handleUnderLock($request));
        if (is_wp_error($result)) {
            return new \WP_REST_Response(['error' => $result->get_error_code()], $result->get_error_data()['status']);
        }
        return $result;
    }

    private static function handleUnderLock(\WP_REST_Request $request): \WP_REST_Response
    {
        // [#7] Reconcile expired pending-command journal records; reject concurrent requests while an active lease is in flight
        $reconcile = self::reconcileUnderLock();
        if ($reconcile['blockedByInFlight']) {
            return new \WP_REST_Response(['error' => 'command_in_flight'], 409);
        }

        $envelope = $request->get_json_params();
        if (!is_array($envelope)) {
            return new \WP_REST_Response(['error' => 'invalid_json'], 400);
        }

        $auth = self::verifySignedEnvelope($envelope);
        if (!$auth['ok']) {
            return new \WP_REST_Response(['error' => $auth['error'] ?? 'unauthorized'], $auth['status'] ?? 401);
        }

        $payload = $auth['payload'] ?? [];
        $command = isset($payload['command']) && is_string($payload['command']) ? $payload['command'] : '';

        return match ($command) {
            'capabilities' => self::cmdCapabilities(),
            'apply' => self::cmdApply($payload),
            'restore' => self::cmdRestore($payload),
            'filter_patch.put' => self::cmdFilterPatchPut($payload),
            'filter_patch.deactivate' => self::cmdFilterPatchDeactivate($payload),
            'manifest.put' => self::cmdManifestPut($payload),
            'ctl' => self::cmdCtl($payload),
            'verify' => self::cmdVerify($payload),
            default => new \WP_REST_Response(['error' => 'unsupported_command'], 400),
        };
    }

    private static function cmdCapabilities(): \WP_REST_Response
    {
        return new \WP_REST_Response([
            'plugin_version' => self::PLUGIN_VERSION,
            'ops' => ['SetText', 'SetAlt', 'InsertInternalLink', 'SetTitle', 'SetMetaDescription'],
            'atomic_cas' => true,
            'exact_restore' => true,
            'cache_purge' => true,
            'script_capable' => false, // wp_kses_post ALWAYS enforced regardless of role
            'durability' => 'origin_db',
            'owner_local_policy' => self::getOwnerLocalPolicy(),
        ], 200);
    }

    /**
     * Quote-aware HTML attribute parser (`[#6]`):
     * Properly tracks single/double-quoted attribute values so `>` inside quotes never
     * closes a tag prematurely. Returns `['ok' => false]` on unclosed quotes/malformed attributes.
     *
     * @return array{ok: bool, attrs: array<string, string>, canonical: string}
     */
    private static function parseHtmlAttributesQuoteAware(string $rawAttrs): array
    {
        $attrs = [];
        $parts = [];
        $len = strlen($rawAttrs);
        $i = 0;

        while ($i < $len) {
            while ($i < $len && ($rawAttrs[$i] === ' ' || $rawAttrs[$i] === "\t" || $rawAttrs[$i] === "\n" || $rawAttrs[$i] === "\r" || $rawAttrs[$i] === '/')) {
                $i++;
            }
            if ($i >= $len) {
                break;
            }

            $nameStart = $i;
            while (
                $i < $len
                && $rawAttrs[$i] !== '='
                && $rawAttrs[$i] !== ' '
                && $rawAttrs[$i] !== "\t"
                && $rawAttrs[$i] !== "\n"
                && $rawAttrs[$i] !== "\r"
                && $rawAttrs[$i] !== '/'
                && $rawAttrs[$i] !== '>'
            ) {
                if ($rawAttrs[$i] === '"' || $rawAttrs[$i] === "'" || $rawAttrs[$i] === '<') {
                    return ['ok' => false, 'attrs' => [], 'canonical' => ''];
                }
                $i++;
            }
            $name = strtolower(substr($rawAttrs, $nameStart, $i - $nameStart));
            if ($name === '') {
                return ['ok' => false, 'attrs' => [], 'canonical' => ''];
            }

            while ($i < $len && ($rawAttrs[$i] === ' ' || $rawAttrs[$i] === "\t" || $rawAttrs[$i] === "\n" || $rawAttrs[$i] === "\r")) {
                $i++;
            }

            $value = '';
            if ($i < $len && $rawAttrs[$i] === '=') {
                $i++;
                while ($i < $len && ($rawAttrs[$i] === ' ' || $rawAttrs[$i] === "\t" || $rawAttrs[$i] === "\n" || $rawAttrs[$i] === "\r")) {
                    $i++;
                }
                if ($i >= $len) {
                    return ['ok' => false, 'attrs' => [], 'canonical' => ''];
                }
                $ch = $rawAttrs[$i];
                if ($ch === '"' || $ch === "'") {
                    $quote = $ch;
                    $i++;
                    $valStart = $i;
                    while ($i < $len && $rawAttrs[$i] !== $quote) {
                        $i++;
                    }
                    if ($i >= $len) {
                        return ['ok' => false, 'attrs' => [], 'canonical' => ''];
                    }
                    $value = substr($rawAttrs, $valStart, $i - $valStart);
                    $i++;
                } else {
                    $valStart = $i;
                    while (
                        $i < $len
                        && $rawAttrs[$i] !== ' '
                        && $rawAttrs[$i] !== "\t"
                        && $rawAttrs[$i] !== "\n"
                        && $rawAttrs[$i] !== "\r"
                        && $rawAttrs[$i] !== '>'
                    ) {
                        if ($rawAttrs[$i] === '"' || $rawAttrs[$i] === "'" || $rawAttrs[$i] === '<') {
                            return ['ok' => false, 'attrs' => [], 'canonical' => ''];
                        }
                        $i++;
                    }
                    $value = substr($rawAttrs, $valStart, $i - $valStart);
                }
            }

            if (!array_key_exists($name, $attrs)) {
                $attrs[$name] = $value;
            }
            $normVal = (string) preg_replace('/\s+/', ' ', trim($value));
            $parts[] = $name . '="' . $normVal . '"';
        }

        return ['ok' => true, 'attrs' => $attrs, 'canonical' => implode(' ', $parts)];
    }

    /**
     * Quote-aware HTML tag/attribute scanner extracting canonical indexable SEO nodes from a FULL
     * HTML document (`[#6]`): `<h1>`, `<title>`, `<meta>`, `<link rel="canonical">`, `<a href>`,
     * and `<script type="application/ld+json">`.
     *
     * Returns `null` if HTML is unparseable or contains unclosed tags/quotes/comments/blocks so
     * `cmdApply` FAILS CLOSED by requiring local WP 2-key approval!
     */
    private static function extractIndexableSeoSignature(string $html): ?string
    {
        $parts = [];
        $len = strlen($html);
        $i = 0;

        while ($i < $len) {
            $lt = strpos($html, '<', $i);
            if ($lt === false) {
                break;
            }

            // HTML comment <!-- ... -->
            if (substr($html, $lt, 4) === '<!--') {
                $commentEnd = strpos($html, '-->', $lt + 4);
                if ($commentEnd === false) {
                    return null;
                }
                $i = $commentEnd + 3;
                continue;
            }

            // Declaration / PI (<!DOCTYPE ...> or <?...?>)
            if ($lt + 1 < $len && ($html[$lt + 1] === '!' || $html[$lt + 1] === '?')) {
                $j = $lt + 2;
                $q = null;
                while ($j < $len) {
                    $ch = $html[$j];
                    if ($q !== null) {
                        if ($ch === $q) {
                            $q = null;
                        }
                    } elseif ($ch === '"' || $ch === "'") {
                        $q = $ch;
                    } elseif ($ch === '>') {
                        break;
                    }
                    $j++;
                }
                if ($j >= $len || $q !== null) {
                    return null;
                }
                $i = $j + 1;
                continue;
            }

            $p = $lt + 1;
            while ($p < $len && ($html[$p] === ' ' || $html[$p] === "\t" || $html[$p] === "\n" || $html[$p] === "\r")) {
                $p++;
            }
            $isClosing = $p < $len && $html[$p] === '/';
            if ($isClosing) {
                $p++;
                while ($p < $len && ($html[$p] === ' ' || $html[$p] === "\t" || $html[$p] === "\n" || $html[$p] === "\r")) {
                    $p++;
                }
            }

            $nameStart = $p;
            if ($p < $len && ctype_alpha($html[$p])) {
                $p++;
                while ($p < $len && (ctype_alnum($html[$p]) || $html[$p] === ':' || $html[$p] === '-')) {
                    $p++;
                }
            } else {
                $i = $lt + 1;
                continue;
            }

            $tagName = strtolower(substr($html, $nameStart, $p - $nameStart));
            if ($p >= $len) {
                return null;
            }
            $afterName = $html[$p];
            if ($afterName !== '>' && $afterName !== '/' && $afterName !== ' ' && $afterName !== "\t" && $afterName !== "\n" && $afterName !== "\r") {
                $i = $lt + 1;
                continue;
            }

            // Scan to unquoted closing '>' tracking single/double quotes!
            $attrStart = $p;
            $j = $p;
            $quote = null;
            while ($j < $len) {
                $ch = $html[$j];
                if ($quote !== null) {
                    if ($ch === $quote) {
                        $quote = null;
                    }
                } elseif ($ch === '"' || $ch === "'") {
                    $quote = $ch;
                } elseif ($ch === '>') {
                    break;
                }
                $j++;
            }
            if ($j >= $len || $quote !== null) {
                return null;
            }

            if ($isClosing) {
                $i = $j + 1;
                continue;
            }

            $rawAttrs = trim(substr($html, $attrStart, $j - $attrStart));
            $rawLen = strlen($rawAttrs);
            if (
                $rawAttrs === '/'
                || (
                    $rawLen >= 2
                    && $rawAttrs[$rawLen - 1] === '/'
                    && (
                        $rawAttrs[$rawLen - 2] === ' '
                        || $rawAttrs[$rawLen - 2] === "\t"
                        || $rawAttrs[$rawLen - 2] === "\n"
                        || $rawAttrs[$rawLen - 2] === "\r"
                    )
                )
            ) {
                $rawAttrs = trim(substr($rawAttrs, 0, -1));
            }
            $parsedAttrs = self::parseHtmlAttributesQuoteAware($rawAttrs);
            if (!$parsedAttrs['ok']) {
                return null;
            }

            if ($tagName === 'h1' || $tagName === 'title') {
                if (preg_match('/<\s*\/\s*' . $tagName . '\s*>/i', $html, $cm, PREG_OFFSET_CAPTURE, $j + 1) !== 1) {
                    return null;
                }
                $closeStart = (int) $cm[0][1];
                $closeEnd = $closeStart + strlen((string) $cm[0][0]);
                $body = (string) preg_replace('/\s+/', ' ', trim(substr($html, $j + 1, $closeStart - ($j + 1))));
                $parts[] = $tagName . '[' . $parsedAttrs['canonical'] . ']=' . $body;
                $i = $closeEnd;
                continue;
            }

            if ($tagName === 'meta') {
                $parts[] = 'meta[' . $parsedAttrs['canonical'] . ']';
                $i = $j + 1;
                continue;
            }

            if ($tagName === 'link') {
                $rel = $parsedAttrs['attrs']['rel'] ?? '';
                if (preg_match('/\bcanonical\b/i', $rel) === 1) {
                    $parts[] = 'link_canonical[' . $parsedAttrs['canonical'] . ']';
                }
                $i = $j + 1;
                continue;
            }

            if ($tagName === 'a') {
                $href = trim($parsedAttrs['attrs']['href'] ?? '');
                $rel = trim($parsedAttrs['attrs']['rel'] ?? '');
                if ($href !== '') {
                    $parts[] = 'a[href=' . $href . ';rel=' . $rel . ']';
                }
                $i = $j + 1;
                continue;
            }

            if ($tagName === 'script') {
                if (preg_match('/<\s*\/\s*script\s*>/i', $html, $cm, PREG_OFFSET_CAPTURE, $j + 1) !== 1) {
                    return null;
                }
                $closeStart = (int) $cm[0][1];
                $closeEnd = $closeStart + strlen((string) $cm[0][0]);
                $type = strtolower(trim($parsedAttrs['attrs']['type'] ?? ''));
                if ($type === 'application/ld+json') {
                    $body = (string) preg_replace('/\s+/', ' ', trim(substr($html, $j + 1, $closeStart - ($j + 1))));
                    $parts[] = 'ld_json=' . $body;
                }
                $i = $closeEnd;
                continue;
            }

            $i = $j + 1;
        }

        return implode("\n", $parts);
    }

    /**
     * Extracts external `http(s)://` hostnames from an HTML fragment (`[C-17]`).
     *
     * @return array<int, string>
     */
    private static function extractExternalHosts(string $html): array
    {
        $hosts = [];
        if (preg_match_all('/https?:\/\/([a-z0-9.-]+)/i', $html, $matches)) {
            $homeHost = strtolower((string) wp_parse_url((string) home_url(), PHP_URL_HOST));
            foreach ($matches[1] as $rawHost) {
                $h = strtolower($rawHost);
                if ($h !== '' && $h !== $homeHost) {
                    $hosts[$h] = true;
                }
            }
        }
        $list = array_keys($hosts);
        sort($list, SORT_STRING);
        return $list;
    }

    /**
     * Atomic compare-and-swap apply inside a single PHP request (§10.9 / DEL App. H / [C-17] / [H-08]).
     *
     * @param array<string, mixed> $payload
     */
    private static function cmdApply(array $payload): \WP_REST_Response
    {
        $policy = self::getOwnerLocalPolicy();
        if ($policy['local_stop']) {
            return new \WP_REST_Response(['error' => 'owner_local_stop_active'], 403);
        }

        // [H-08]: Enforce per-UTC-day daily_apply_cap BEFORE mutating post
        $utcDay = gmdate('Y-m-d');
        $dailyCounters = get_option(self::OPTION_DAILY_APPLY_COUNTER, []);
        if (!is_array($dailyCounters)) {
            $dailyCounters = [];
        }
        $usedToday = isset($dailyCounters[$utcDay]) ? (int) $dailyCounters[$utcDay] : 0;
        if ($usedToday >= (int) $policy['daily_apply_cap']) {
            return new \WP_REST_Response(['error' => 'owner_daily_apply_cap_exceeded'], 429);
        }

        $siteId = (string) ($payload['site_id'] ?? '');
        $seq = (int) ($payload['seq'] ?? 0);
        $changeClass = isset($payload['change_class']) && is_string($payload['change_class']) ? $payload['change_class'] : '';
        $postId = (int) ($payload['post_id'] ?? 0);
        $promotionId = (string) ($payload['promotion_id'] ?? '');
        $expectedHash = (string) ($payload['expected_content_sha256'] ?? '');
        $expectedModifiedGmt = (string) ($payload['expected_modified_gmt'] ?? '');
        $byteStart = (int) ($payload['byte_start'] ?? -1);
        $byteEnd = (int) ($payload['byte_end'] ?? -1);
        $replacementRaw = (string) ($payload['replacement_html'] ?? '');

        $post = get_post($postId);
        if (!$post instanceof \WP_Post) {
            return new \WP_REST_Response(['error' => 'post_not_found'], 404);
        }

        // 1. Refuse immediately when another editor holds the post edit lock ([H-08] lock ownership guard)
        if (!function_exists('wp_check_post_lock')) {
            require_once ABSPATH . 'wp-admin/includes/post.php';
        }
        $acquiredLock = false;
        $lockUserId = wp_check_post_lock($postId);
        if ($lockUserId !== false) {
            return new \WP_REST_Response([
                'error' => 'edit_lock_active',
                'locked_by_user_id' => $lockUserId,
            ], 409);
        }

        wp_set_post_lock($postId);
        $acquiredLock = true;

        try {
            $currentContent = (string) $post->post_content;
            $currentHash = hash('sha256', $currentContent);

            // 2. Compare content SHA-256 and modified_gmt
            if (!hash_equals($expectedHash, $currentHash)) {
                return new \WP_REST_Response([
                    'error' => 'content_hash_mismatch',
                    'current_sha256' => $currentHash,
                ], 409);
            }
            if ((string) $post->post_modified_gmt !== $expectedModifiedGmt) {
                return new \WP_REST_Response([
                    'error' => 'modified_gmt_mismatch',
                    'current_modified_gmt' => (string) $post->post_modified_gmt,
                ], 409);
            }

            if ($byteStart < 0 || $byteEnd < $byteStart || $byteEnd > strlen($currentContent)) {
                return new \WP_REST_Response(['error' => 'invalid_byte_span'], 400);
            }

            // 3. Enforce content filtering regardless of user role (NEVER allow script injection)
            $oldSlice = substr($currentContent, $byteStart, $byteEnd - $byteStart);
            $sanitizedFragment = wp_kses_post($replacementRaw);
            $newContent = substr($currentContent, 0, $byteStart)
                . $sanitizedFragment
                . substr($currentContent, $byteEnd);
            $postImageHash = hash('sha256', $newContent);

            // 4. [C-17] & [#6]: True 2-key local WP-Admin approval verification!
            // Compare FULL before/after HTML documents using quote-aware HTML scanning (fail-closed if null!).
            $beforeSeoSig = self::extractIndexableSeoSignature($currentContent);
            $afterSeoSig = self::extractIndexableSeoSignature($newContent);
            $seoChangedInFullDoc =
                $beforeSeoSig === null
                || $afterSeoSig === null
                || !hash_equals($beforeSeoSig, $afterSeoSig);
            $touchesIndexableSeo =
                $changeClass === 'touch_indexable_seo'
                || $changeClass === 'indexable_major'
                || $seoChangedInFullDoc;

            $changesOutboundHosts =
                $changeClass === 'change_outbound_hosts'
                || self::extractExternalHosts($currentContent) !== self::extractExternalHosts($newContent);

            $requiresAdminConfirm =
                in_array($changeClass, $policy['require_admin_confirmation_classes'], true)
                || $touchesIndexableSeo
                || $changesOutboundHosts;

            $inAllowedAuto = in_array($changeClass, $policy['allowed_auto_classes'], true);

            $claimedApprovalDigest = null;
            $claimedApprovalToken = null;
            if ($requiresAdminConfirm || !$inAllowedAuto) {
                $expectedApprovalDigest = self::computeLocalApprovalDigest(
                    $siteId,
                    $postId,
                    $currentHash,
                    $postImageHash,
                    $seq
                );
                $claimToken = self::claimLocalWpAdminApproval($expectedApprovalDigest);
                if ($claimToken === null) {
                    $errCode = $requiresAdminConfirm
                        ? 'owner_local_policy_requires_admin_confirmation'
                        : 'change_class_not_in_owner_local_policy';
                    return new \WP_REST_Response(['error' => $errCode], 403);
                }
                $claimedApprovalDigest = $expectedApprovalDigest;
                $claimedApprovalToken = $claimToken;
            }

            // 5. Persist immutable pre-image keyed by promotion_id BEFORE mutating post
            update_post_meta($postId, self::META_PREIMAGE_PREFIX . sanitize_key($promotionId), wp_json_encode([
                'promotion_id' => $promotionId,
                'pre_image_sha256' => $currentHash,
                'post_image_sha256' => $postImageHash,
                'pre_image_content' => $currentContent,
                'applied_at_gmt' => gmdate('Y-m-d H:i:s'),
            ]));

            // 5b. [#7] Write recoverable pending-command journal record with active lease BEFORE wp_update_post
            $leaseNowMs = (int) round(microtime(true) * 1000);
            $leaseToken = 'lease_' . $seq . '_' . bin2hex(random_bytes(8));
            self::writePendingCommandJournal($seq, [
                'command_seq' => $seq,
                'post_id' => $postId,
                'approval_digest' => $claimedApprovalDigest,
                'claim_token' => $claimedApprovalToken,
                'expected_after_sha256' => $postImageHash,
                'prev_seq' => isset($payload['__prev_seq']) ? (int) $payload['__prev_seq'] : 0,
                'lease_token' => $leaseToken,
                'lease_expires_at_ms' => $leaseNowMs + self::PENDING_COMMAND_LEASE_MS,
                'status' => 'in_progress',
            ]);

            $result = wp_update_post([
                'ID' => $postId,
                'post_content' => wp_slash($newContent),
            ], true);

            if (is_wp_error($result)) {
                // [#7] Roll back claimed approval to `unused`, atomically CAS-rollback seq via single SQL UPDATE, and clear journal
                if ($claimedApprovalDigest !== null && $claimedApprovalToken !== null) {
                    self::releaseLocalWpAdminApproval($claimedApprovalDigest, $claimedApprovalToken);
                }
                if (isset($payload['__prev_seq'])) {
                    self::rollbackLastSeqIfMatches($seq, (int) $payload['__prev_seq']);
                }
                self::clearPendingCommandJournal($seq);
                return new \WP_REST_Response(['error' => 'wp_update_post_failed'], 500);
            }

            // [#7] Commit claimed approval (`claimed` -> `consumed`) ONLY after post update succeeds, then clear journal
            if ($claimedApprovalDigest !== null && $claimedApprovalToken !== null) {
                self::commitLocalWpAdminApproval($claimedApprovalDigest, $claimedApprovalToken);
            }
            self::clearPendingCommandJournal($seq);

            // Increment per-UTC-day apply counter (pruning stale days)
            $dailyCounters = [$utcDay => $usedToday + 1];
            update_option(self::OPTION_DAILY_APPLY_COUNTER, $dailyCounters, false);

            $purged = self::purgeKnownCaches($postId);

            return new \WP_REST_Response([
                'status' => 'applied',
                'promotion_id' => $promotionId,
                'pre_image_sha256' => $currentHash,
                'post_image_sha256' => $postImageHash,
                'purged_caches' => $purged,
            ], 200);
        } finally {
            if ($acquiredLock) {
                delete_post_meta($postId, '_edit_lock');
            }
        }
    }

    /**
     * Exact pre-image restore. Refuses silent overwrite if an editor edited the post afterwards.
     *
     * @param array<string, mixed> $payload
     */
    private static function cmdRestore(array $payload): \WP_REST_Response
    {
        $postId = (int) ($payload['post_id'] ?? 0);
        $promotionId = (string) ($payload['promotion_id'] ?? '');
        $post = get_post($postId);
        if (!$post instanceof \WP_Post) {
            return new \WP_REST_Response(['error' => 'post_not_found'], 404);
        }

        if (!function_exists('wp_check_post_lock')) {
            require_once ABSPATH . 'wp-admin/includes/post.php';
        }
        if (wp_check_post_lock($postId) !== false) {
            return new \WP_REST_Response(['error' => 'edit_lock_active'], 409);
        }

        $recordJson = get_post_meta($postId, self::META_PREIMAGE_PREFIX . sanitize_key($promotionId), true);
        if (!is_string($recordJson) || $recordJson === '') {
            return new \WP_REST_Response(['error' => 'preimage_not_found'], 404);
        }
        $record = json_decode($recordJson, true);
        if (!is_array($record)) {
            return new \WP_REST_Response(['error' => 'preimage_corrupt'], 500);
        }

        $currentContent = (string) $post->post_content;
        $currentHash = hash('sha256', $currentContent);

        if (!hash_equals((string) $record['post_image_sha256'], $currentHash)) {
            // Editor modified post after promotion -> return 409 rollback_conflict for 3-way merge
            return new \WP_REST_Response([
                'error' => 'rollback_conflict',
                'promotion_id' => $promotionId,
                'expected_post_image_sha256' => (string) $record['post_image_sha256'],
                'current_sha256' => $currentHash,
                'pre_image_sha256' => (string) $record['pre_image_sha256'],
            ], 409);
        }

        wp_update_post([
            'ID' => $postId,
            'post_content' => wp_slash((string) $record['pre_image_content']),
        ], true);

        $purged = self::purgeKnownCaches($postId);

        return new \WP_REST_Response([
            'status' => 'restored',
            'promotion_id' => $promotionId,
            'restored_sha256' => (string) $record['pre_image_sha256'],
            'purged_caches' => $purged,
        ], 200);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function cmdFilterPatchPut(array $payload): \WP_REST_Response
    {
        $policy = self::getOwnerLocalPolicy();
        if ($policy['local_stop']) {
            return new \WP_REST_Response(['error' => 'owner_local_stop_active'], 403);
        }
        $patches = get_option(self::OPTION_FILTER_PATCHES, []);
        if (!is_array($patches)) {
            $patches = [];
        }
        $patchId = sanitize_key((string) ($payload['patch_id'] ?? ''));
        $patches[$patchId] = [
            'url_path' => (string) ($payload['url_path'] ?? ''),
            'fragment_html' => wp_kses_post((string) ($payload['fragment_html'] ?? '')),
            'active' => true,
        ];
        update_option(self::OPTION_FILTER_PATCHES, $patches, false);
        self::purgeKnownCaches(0);
        return new \WP_REST_Response(['status' => 'stored', 'patch_id' => $patchId], 200);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function cmdFilterPatchDeactivate(array $payload): \WP_REST_Response
    {
        $patches = get_option(self::OPTION_FILTER_PATCHES, []);
        $patchId = sanitize_key((string) ($payload['patch_id'] ?? ''));
        if (is_array($patches) && isset($patches[$patchId])) {
            unset($patches[$patchId]);
            update_option(self::OPTION_FILTER_PATCHES, $patches, false);
            self::purgeKnownCaches(0);
        }
        return new \WP_REST_Response(['status' => 'deactivated', 'patch_id' => $patchId], 200);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function cmdManifestPut(array $payload): \WP_REST_Response
    {
        $json = wp_json_encode($payload['manifest'] ?? []);
        update_option(self::OPTION_MANIFEST_JSON, (string) $json, false);
        self::purgeKnownCaches(0);
        return new \WP_REST_Response(['status' => 'manifest_updated'], 200);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function cmdCtl(array $payload): \WP_REST_Response
    {
        if (!empty($payload['clear_all_filter_patches'])) {
            update_option(self::OPTION_FILTER_PATCHES, [], false);
            self::purgeKnownCaches(0);
        }
        return new \WP_REST_Response(['status' => 'ctl_committed'], 200);
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function cmdVerify(array $payload): \WP_REST_Response
    {
        $postId = (int) ($payload['post_id'] ?? 0);
        $post = get_post($postId);
        if (!$post instanceof \WP_Post) {
            return new \WP_REST_Response(['error' => 'post_not_found'], 404);
        }
        $currentHash = hash('sha256', (string) $post->post_content);
        $expectedHash = (string) ($payload['expected_sha256'] ?? '');
        return new \WP_REST_Response([
            'origin_ok' => hash_equals($expectedHash, $currentHash),
            'current_sha256' => $currentHash,
            'modified_gmt' => (string) $post->post_modified_gmt,
        ], 200);
    }

    public static function applyRenderFilterPatches(string $content): string
    {
        $policy = self::getOwnerLocalPolicy();
        if ($policy['local_stop']) {
            return $content;
        }
        return $content;
    }

    /**
     * Sends signed `content.changed` event ONLY to UGOKI LINK (never directly to CRAWL, D-24).
     */
    public static function onPostPublished(string $newStatus, string $oldStatus, \WP_Post $post): void
    {
        if ($newStatus !== 'publish' && $oldStatus !== 'publish') {
            return;
        }
        $endpoint = get_option('ugk_link_publish_hook_url', '');
        $edgeSecret = get_option('ugk_edge_integrity_secret', '');
        if (!is_string($endpoint) || $endpoint === '' || !is_string($edgeSecret) || $edgeSecret === '') {
            return;
        }
        $eventBody = wp_json_encode([
            'event' => 'content.changed',
            'post_id' => $post->ID,
            'permalink' => get_permalink($post->ID),
            'modified_gmt' => (string) $post->post_modified_gmt,
            'content_sha256' => hash('sha256', (string) $post->post_content),
        ]);
        $mac = hash_hmac('sha256', (string) $eventBody, $edgeSecret);
        wp_remote_post($endpoint, [
            'timeout' => 3,
            'blocking' => false,
            'headers' => [
                'Content-Type' => 'application/json',
                'X-UGK-Event-Signature' => $mac,
            ],
            'body' => (string) $eventBody,
        ]);
    }

    /**
     * Purges known WordPress page caches without failing if none are installed.
     *
     * @return array<int, string>
     */
    private static function purgeKnownCaches(int $postId): array
    {
        $purged = [];
        if (function_exists('wp_cache_post_change') && $postId > 0) {
            wp_cache_post_change($postId);
            $purged[] = 'wp_super_cache';
        }
        if (function_exists('rocket_clean_post') && $postId > 0) {
            rocket_clean_post($postId);
            $purged[] = 'wp_rocket';
        }
        if (function_exists('w3tc_flush_post') && $postId > 0) {
            w3tc_flush_post($postId);
            $purged[] = 'w3_total_cache';
        }
        do_action('ugk_after_cache_purge', $postId);
        $purged[] = 'ugk_hook';
        return $purged;
    }
}

UgokiLink_Companion_Plugin::register();
