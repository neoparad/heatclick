const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
  images: {
    domains: ['localhost'],
  },
  env: {
    CUSTOM_KEY: process.env.CUSTOM_KEY,
  },
  async headers() {
    return [
      {
        // トラッキングAPI のみ全オリジン許可（外部サイトから呼ばれるため）
        source: '/api/track',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        ],
      },
      {
        // インストール確認API も公開
        source: '/api/install',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
        ],
      },
    ];
  },
};

module.exports = withSentryConfig(nextConfig, {
  // ソースマップをSentryにアップロード（ビルド時）
  silent: true,
  // ブラウザバンドルにSentryのデバッグIDを含めない（軽量化）
  hideSourceMaps: true,
  // クライアントバンドルにSentryのwebpackプラグインを使用
  widenClientFileUpload: true,
  // DSN未設定時はSentryを完全スキップ（ビルドエラー防止）
  disableLogger: true,
});
