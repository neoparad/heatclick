// スクリーンショットを撮るスクリプト
const { chromium } = require('playwright');
const path = require('path');

async function takeScreenshot() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  try {
    // Inngestダッシュボードにアクセス
    console.log('Inngestダッシュボードにアクセス中...');
    await page.goto('https://app.inngest.com', { waitUntil: 'networkidle' });
    
    // ログインが必要な場合は待機
    console.log('ページの読み込みを待機中...');
    await page.waitForTimeout(5000);
    
    // スクリーンショットを撮影
    const screenshotPath = path.join('C:', 'Users', 'linkth', 'aaa.png');
    console.log(`スクリーンショットを保存中: ${screenshotPath}`);
    await page.screenshot({ 
      path: screenshotPath,
      fullPage: true 
    });
    
    console.log('✅ スクリーンショットが保存されました:', screenshotPath);
    
    // ブラウザを開いたままにする（ユーザーが操作できるように）
    console.log('ブラウザは開いたままです。手動で操作してください。');
    console.log('終了するには、このウィンドウを閉じてください。');
    
    // 30秒待機（ユーザーが操作できるように）
    await page.waitForTimeout(30000);
    
  } catch (error) {
    console.error('エラーが発生しました:', error);
  } finally {
    await browser.close();
  }
}

takeScreenshot();

