'use client'

import Link from 'next/link'
import { 
  Github, 
  Twitter, 
  Mail,
  ExternalLink
} from 'lucide-react'

export default function Footer() {
  const currentYear = new Date().getFullYear()

  return (
    <footer className="bg-white border-t border-gray-200 w-full">
      <div className="px-4 lg:px-8 py-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* ブランド */}
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">CI</span>
              </div>
              <span className="font-bold text-lg">ClickInsight Pro</span>
            </div>
            <p className="text-gray-600 text-sm mb-4">
              AIによる自動診断と改善提案を行う次世代SEO特化型ヒートマップツール
            </p>
            <div className="flex items-center gap-4">
              <a 
                href="https://github.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="GitHub"
              >
                <Github className="w-5 h-5" />
              </a>
              <a 
                href="https://twitter.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Twitter"
              >
                <Twitter className="w-5 h-5" />
              </a>
              <a 
                href="mailto:support@clickinsight.pro" 
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Email"
              >
                <Mail className="w-5 h-5" />
              </a>
            </div>
          </div>

          {/* 製品 */}
          <div>
            <h3 className="font-semibold text-gray-900 mb-4">製品</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/dashboard" className="text-gray-600 hover:text-gray-900 text-sm transition-colors">
                  ダッシュボード
                </Link>
              </li>
              <li>
                <Link href="/heatmap" className="text-gray-600 hover:text-gray-900 text-sm transition-colors">
                  ヒートマップ
                </Link>
              </li>
              <li>
                <Link href="/ai-insights" className="text-gray-600 hover:text-gray-900 text-sm transition-colors">
                  AI分析
                </Link>
              </li>
              <li>
                <Link href="/reports" className="text-gray-600 hover:text-gray-900 text-sm transition-colors">
                  レポート
                </Link>
              </li>
            </ul>
          </div>

          {/* サポート */}
          <div>
            <h3 className="font-semibold text-gray-900 mb-4">サポート</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/install" className="text-gray-600 hover:text-gray-900 text-sm transition-colors">
                  インストールガイド
                </Link>
              </li>
              <li>
                <a 
                  href="https://docs.clickinsight.pro" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-gray-600 hover:text-gray-900 text-sm transition-colors flex items-center gap-1"
                >
                  ドキュメント
                  <ExternalLink className="w-3 h-3" />
                </a>
              </li>
              <li>
                <a 
                  href="mailto:support@clickinsight.pro" 
                  className="text-gray-600 hover:text-gray-900 text-sm transition-colors"
                >
                  お問い合わせ
                </a>
              </li>
              <li>
                <Link href="/settings" className="text-gray-600 hover:text-gray-900 text-sm transition-colors">
                  設定
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-200 mt-8 pt-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-gray-500 text-sm">
              © {currentYear} ClickInsight Pro. All rights reserved.
            </p>
            <div className="flex items-center gap-6 text-sm text-gray-500">
              <Link href="/terms" className="hover:text-gray-900 transition-colors">
                利用規約
              </Link>
              <Link href="/privacy" className="hover:text-gray-900 transition-colors">
                プライバシーポリシー
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}

