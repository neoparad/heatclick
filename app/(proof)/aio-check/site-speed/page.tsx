import Stub from '@/components/aiseo/Stub'

export default function SiteSpeedPage() {
  return (
    <Stub
      title="サイトスピード"
      subtitle="AIクローラー・人間どちらにとってもTTFB/CWVが遅いサイトは不利。速度要因を診断。"
      layer="AIO診断"
      willShow="CWVサマリ（LCP/INP/CLS/TTFB、metric別サンプル数・信頼度）・稼働状況・速度要因インベントリ（レンダリングブロックJS/圧縮/キャッシュ/画像形式/リダイレクト等）。"
      dataSource="LINKTH CRAWL のスピード診断（/api/me/speed/*）を読み取り専用で表示。要ログインセッション連携（設計要検討）。"
    />
  )
}
