<?php
declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

/** Use the same primary DB session as wp_update_post and all option writes. */
final class UgokiLink_Command_Session extends \wpdb
{
    private static bool $held = false;

    public static function run(callable $work): mixed
    {
        global $wpdb;
        if (self::$held) {
            return self::busy();
        }
        // A routing drop-in must provide equivalent connection pinning before it can be used.
        if (get_class($wpdb) !== \wpdb::class || !$wpdb->ready) {
            return self::unavailable();
        }
        $name = hash('sha256', "ugokilink:command\0" . DB_NAME . "\0" . $wpdb->options);
        $retries = $wpdb->reconnect_retries;
        // wpdb must not retry a locked write on a fresh (and therefore unlocked) connection.
        $wpdb->reconnect_retries = 0;
        self::$held = true;
        try {
            $acquired = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', $name));
            if ((string) $acquired !== '1') {
                return (string) $acquired === '0' ? self::busy() : self::unavailable();
            }
            try {
                $result = $work();
            } finally {
                $released = $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $name));
            }
            return (string) $released === '1' ? $result : self::unavailable();
        } finally {
            $wpdb->reconnect_retries = $retries;
            self::$held = false;
        }
    }

    private static function busy(): \WP_Error
    {
        return new \WP_Error('command_in_flight', 'Another command is in progress.', ['status' => 409]);
    }

    private static function unavailable(): \WP_Error
    {
        return new \WP_Error('command_store_unavailable', 'Exclusive database session unavailable.', ['status' => 503]);
    }
}
