(function() {
  'use strict';
  
  // 設定
  const CONFIG = {
    apiUrl: 'http://localhost:3001/api/track',
    siteId: null,
    sessionId: null,
    userId: null,
    debug: true
  };

  // セッション管理
  function getSessionId() {
    let sessionId = sessionStorage.getItem('cip_session_id');
    if (!sessionId) {
      sessionId = 'cip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem('cip_session_id', sessionId);
    }
    return sessionId;
  }

  // ユーザーID管理
  function getUserId() {
    let userId = localStorage.getItem('cip_user_id');
    if (!userId) {
      userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('cip_user_id', userId);
    }
    return userId;
  }

  // サイトID取得
  function getSiteId() {
    const script = document.querySelector('script[data-site-id]');
    return script ? script.getAttribute('data-site-id') : null;
  }

  function getApiUrl() {
    const script = document.querySelector('script[data-site-id]');
    const attrUrl = script ? script.getAttribute('data-api-url') : null;
    return attrUrl || CONFIG.apiUrl;
  }

  // データ送信
  function sendData(eventType, data) {
    const payload = {
      siteId: CONFIG.siteId,
      sessionId: CONFIG.sessionId,
      userId: CONFIG.userId,
      eventType: eventType,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      ...data
    };

    if (CONFIG.debug) {
      console.log('ClickInsight Pro - Sending data:', payload);
    }

    // データ送信（実際のAPIエンドポイントに送信）
    fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    }).catch(error => {
      if (CONFIG.debug) {
        console.error('ClickInsight Pro - Failed to send data:', error);
      }
    });
  }

  // クリックイベント
  function trackClick(event) {
    const element = event.target;
    const rect = element.getBoundingClientRect();
    
    sendData('click', {
      element: {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        text: element.textContent ? element.textContent.substring(0, 100) : '',
        href: element.href || null
      },
      position: {
        x: event.clientX,
        y: event.clientY,
        relativeX: event.clientX - rect.left,
        relativeY: event.clientY - rect.top
      },
      elementRect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }
    });
  }

  // スクロールイベント
  let scrollTimeout;
  function trackScroll() {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      sendData('scroll', {
        scrollY: window.scrollY,
        scrollX: window.scrollX,
        maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
        scrollPercentage: Math.round((window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100)
      });
    }, 100);
  }

  // マウス移動イベント
  let mouseTimeout;
  function trackMouseMove(event) {
    clearTimeout(mouseTimeout);
    mouseTimeout = setTimeout(() => {
      sendData('mouse_move', {
        x: event.clientX,
        y: event.clientY,
        movementX: event.movementX,
        movementY: event.movementY
      });
    }, 50);
  }

  // ページ離脱イベント
  function trackPageLeave() {
    sendData('page_leave', {
      timeOnPage: Date.now() - pageStartTime
    });
  }

  // ページビューイベント
  function trackPageView() {
    sendData('page_view', {
      title: document.title,
      path: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash
    });
  }

  // 初期化
  function init() {
    CONFIG.siteId = getSiteId();
    CONFIG.apiUrl = getApiUrl();
    CONFIG.sessionId = getSessionId();
    CONFIG.userId = getUserId();

    if (!CONFIG.siteId) {
      console.error('ClickInsight Pro - Site ID not found. Please check your tracking script.');
      return;
    }

    // イベントリスナー登録
    document.addEventListener('click', trackClick, true);
    window.addEventListener('scroll', trackScroll, true);
    document.addEventListener('mousemove', trackMouseMove, true);
    window.addEventListener('beforeunload', trackPageLeave);
    
    // ページビュー送信
    trackPageView();

    if (CONFIG.debug) {
      console.log('ClickInsight Pro - Tracking initialized for site:', CONFIG.siteId, 'api:', CONFIG.apiUrl);
    }
  }

  // ページ開始時間
  const pageStartTime = Date.now();

  // DOM読み込み完了後に初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // グローバル関数として公開
  window.ClickInsightPro = {
    track: sendData,
    config: CONFIG
  };

})();
