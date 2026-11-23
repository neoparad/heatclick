<?php
/** Integration test for the WordPress PHPUnit test database (two independent MySQL sessions). */
declare(strict_types=1);

require_once dirname(__DIR__, 2) . '/packages/wp-plugin/command-session.php';

final class UgokiLinkCommandSessionTest extends WP_UnitTestCase
{
    public function test_session_excludes_second_connection_and_releases_after_exception(): void
    {
        global $wpdb;
        $original = $wpdb;
        $writer = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
        $other = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
        $writer->set_prefix($original->prefix);
        $name = hash('sha256', "ugokilink:command\0" . DB_NAME . "\0" . $writer->options);
        $acquire = $other->prepare('SELECT GET_LOCK(%s, 0)', $name);
        $release = $other->prepare('SELECT RELEASE_LOCK(%s)', $name);
        $wpdb = $writer;
        try {
            $this->assertSame('1', (string) $other->get_var($acquire));
            $busy = UgokiLink_Command_Session::run(function () {
                $this->fail('A contending session must not enter the callback.');
            });
            $this->assertInstanceOf(WP_Error::class, $busy);
            $this->assertSame('command_in_flight', $busy->get_error_code());
            $this->assertSame('1', (string) $other->get_var($release));

            $stop = new RuntimeException('end test work');
            try {
                UgokiLink_Command_Session::run(function () use ($other, $acquire, $stop) {
                    $this->assertSame('0', (string) $other->get_var($acquire));
                    throw $stop;
                });
                $this->fail('The callback exception must propagate.');
            } catch (RuntimeException $caught) {
                $this->assertSame($stop, $caught);
            }
            $this->assertSame('1', (string) $other->get_var($acquire));
        } finally {
            $wpdb = $original;
            $other->close();
            $writer->close();
        }
    }
}
