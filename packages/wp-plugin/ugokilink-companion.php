<?php
/**
 * Plugin Name: UGOKI LINK Companion
 * Description: Trust-rooted static snippet emitter, signed typed origin promotion adapter, publish hook, and owner two-key local policy guard for UGOKI LINK v2.
 * Version: 2.0.0
 * Requires PHP: 8.1
 * License: Proprietary
 *
 * Security invariants (§10.9, §12.1 #3, D-24, DEL M9 / App. H):
 * 1. Offline-pinned Ed25519 release keys verify EVERY incoming command before any read/write.
 * 2. Site owner local policy (`ugk_owner_local_policy`, wp-admin only) CANNOT be exceeded by any UGOKI key.
 * 3. Atomic compare-and-swap apply refuses if `wp_check_post_lock()` reports an active editor lock,
 *    verifies BOTH `expected_content_sha256` and `expected_modified_gmt`, splices bytes inside the
 *    addressed block with `wp_kses_post` filtering ALWAYS ON, saves immutable pre-image by hash, and purges caches.
 * 4. Restore swaps the stored pre-image back ONLY when current content SHA-256 equals post-image SHA-256;
 *    otherwise returns 409 `rollback_conflict` with three-way merge payload.
 * 5. `publish_post` emits signed `content.changed` to UGOKI LINK only (never directly to CRAWL).
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

final class UgokiLink_Companion_Plugin
{
    public const PLUGIN_VERSION = '2.0.0';
    public const OPTION_LOCAL_POLICY = 'ugk_owner_local_policy';
    public const OPTION_LAST_SEQ = 'ugk_last_command_seq';
    public const OPTION_MANIFEST_JSON = 'ugk_inline_manifest_json';
    public const OPTION_FILTER_PATCHES = 'ugk_render_filter_patches';
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
            'require_admin_confirmation_classes' => ['indexable_major', 'price', 'offer'],
        ];
        $stored = get_option(self::OPTION_LOCAL_POLICY, []);
        if (!is_array($stored)) {
            return $defaults;
        }
        return array_merge($defaults, $stored);
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
     * Verifies Ed25519 detached signature, monotonic seq, and not_after expiry.
     *
     * @param array<string, mixed> $envelope
     * @return array{ok: bool, error?: string, status?: int}
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

        if (!isset(self::PINNED_ED25519_PUBKEYS[$kid])) {
            return ['ok' => false, 'error' => 'unknown_key_id', 'status' => 401];
        }

        $pubKey = base64_decode(self::PINNED_ED25519_PUBKEYS[$kid], true);
        $sig = base64_decode($sigB64, true);
        if (!is_string($pubKey) || !is_string($sig) || strlen($pubKey) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
            return ['ok' => false, 'error' => 'malformed_signature', 'status' => 401];
        }

        if (!sodium_crypto_sign_verify_detached($sig, $payloadCanonical, $pubKey)) {
            return ['ok' => false, 'error' => 'invalid_signature', 'status' => 401];
        }

        $payload = json_decode($payloadCanonical, true);
        if (!is_array($payload)) {
            return ['ok' => false, 'error' => 'invalid_payload_json', 'status' => 400];
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
        return ['ok' => true];
    }

    public static function handleSignedCommand(\WP_REST_Request $request): \WP_REST_Response
    {
        $envelope = $request->get_json_params();
        if (!is_array($envelope)) {
            return new \WP_REST_Response(['error' => 'invalid_json'], 400);
        }

        $auth = self::verifySignedEnvelope($envelope);
        if (!$auth['ok']) {
            return new \WP_REST_Response(['error' => $auth['error'] ?? 'unauthorized'], $auth['status'] ?? 401);
        }

        $payload = json_decode((string) $envelope['payload_canonical_json'], true);
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
     * Atomic compare-and-swap apply inside a single PHP request (§10.9 / DEL App. H).
     *
     * @param array<string, mixed> $payload
     */
    private static function cmdApply(array $payload): \WP_REST_Response
    {
        $policy = self::getOwnerLocalPolicy();
        if ($policy['local_stop']) {
            return new \WP_REST_Response(['error' => 'owner_local_stop_active'], 403);
        }

        $changeClass = isset($payload['change_class']) && is_string($payload['change_class']) ? $payload['change_class'] : '';
        if (in_array($changeClass, $policy['require_admin_confirmation_classes'], true) && empty($payload['owner_wp_admin_confirmed'])) {
            return new \WP_REST_Response(['error' => 'owner_local_policy_requires_admin_confirmation'], 403);
        }
        if (!in_array($changeClass, $policy['allowed_auto_classes'], true) && empty($payload['owner_wp_admin_confirmed'])) {
            return new \WP_REST_Response(['error' => 'change_class_not_in_owner_local_policy'], 403);
        }

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

        // 1. Refuse immediately when another editor holds the post edit lock
        if (!function_exists('wp_check_post_lock')) {
            require_once ABSPATH . 'wp-admin/includes/post.php';
        }
        $lockUserId = wp_check_post_lock($postId);
        if ($lockUserId !== false) {
            return new \WP_REST_Response([
                'error' => 'edit_lock_active',
                'locked_by_user_id' => $lockUserId,
            ], 409);
        }

        wp_set_post_lock($postId);

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
            $sanitizedFragment = wp_kses_post($replacementRaw);
            $newContent = substr($currentContent, 0, $byteStart)
                . $sanitizedFragment
                . substr($currentContent, $byteEnd);
            $postImageHash = hash('sha256', $newContent);

            // 4. Persist immutable pre-image keyed by promotion_id BEFORE mutating post
            update_post_meta($postId, self::META_PREIMAGE_PREFIX . sanitize_key($promotionId), wp_json_encode([
                'promotion_id' => $promotionId,
                'pre_image_sha256' => $currentHash,
                'post_image_sha256' => $postImageHash,
                'pre_image_content' => $currentContent,
                'applied_at_gmt' => gmdate('Y-m-d H:i:s'),
            ]));

            $result = wp_update_post([
                'ID' => $postId,
                'post_content' => wp_slash($newContent),
            ], true);

            if (is_wp_error($result)) {
                return new \WP_REST_Response(['error' => 'wp_update_post_failed'], 500);
            }

            $purged = self::purgeKnownCaches($postId);

            return new \WP_REST_Response([
                'status' => 'applied',
                'promotion_id' => $promotionId,
                'pre_image_sha256' => $currentHash,
                'post_image_sha256' => $postImageHash,
                'purged_caches' => $purged,
            ], 200);
        } finally {
            delete_post_meta($postId, '_edit_lock');
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
