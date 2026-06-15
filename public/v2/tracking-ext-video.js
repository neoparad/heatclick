/**
 * ClickInsight Pro - Video Tracking Extension
 * Tracks: video_play, video_pause, video_complete, video_milestone, video_summary
 *
 * SaaS B-1 (decisions.md L275 続 14): events are queued through core tracking.js,
 * which enforces data-tenant-id at start-up (sendBeacon abort + console.error on absence).
 * This extension itself does not parse data-tenant-id; consumers must wire it on the
 * <script src="tracking.js"> tag (or via ?tenant_id= query) — see tracking.js header.
  */
(function() {
  'use strict';
  const CI = window.ClickInsight;
  if (!CI) return;

  const videoTracking = {
    tracked: new Map(),

    init() {
      this.observeVideos();
      if ('MutationObserver' in window) {
        const mo = new MutationObserver(() => this.observeVideos());
        mo.observe(document.body, { childList: true, subtree: true });
      }
    },

    observeVideos() {
      for (const video of document.querySelectorAll('video')) {
        if (this.tracked.has(video)) continue;
        const data = {
          src: (video.src || video.querySelector('source')?.src || '').substring(0, 500),
          path: CI.utils.getElementPath(video),
          startTime: 0, totalPlayed: 0, maxProgress: 0,
          interactions: { play: 0, pause: 0, seek: 0, volumechange: 0 },
          duration: 0, completed: false,
        };
        this.tracked.set(video, data);

        video.addEventListener('play', () => {
          data.interactions.play++;
          data.startTime = Date.now();
          data.duration = video.duration || 0;
          CI.track({ event_type: 'video_play', video_src: data.src, element_path: data.path, video_current_time: Math.round(video.currentTime) });
        });
        video.addEventListener('pause', () => {
          data.interactions.pause++;
          if (data.startTime > 0) { data.totalPlayed += Date.now() - data.startTime; data.startTime = 0; }
          if (video.duration > 0) data.maxProgress = Math.max(data.maxProgress, Math.round((video.currentTime / video.duration) * 100));
          CI.track({ event_type: 'video_pause', video_src: data.src, element_path: data.path, video_current_time: Math.round(video.currentTime), video_progress: data.maxProgress });
        });
        video.addEventListener('ended', () => {
          data.completed = true; data.maxProgress = 100;
          if (data.startTime > 0) { data.totalPlayed += Date.now() - data.startTime; data.startTime = 0; }
          CI.track({ event_type: 'video_complete', video_src: data.src, element_path: data.path, video_duration: Math.round(video.duration || 0) });
        });
        video.addEventListener('seeked', () => { data.interactions.seek++; });
        video.addEventListener('volumechange', () => { data.interactions.volumechange++; });

        const milestones = new Set();
        video.addEventListener('timeupdate', CI.utils.throttle(() => {
          if (!video.duration) return;
          const pct = Math.round((video.currentTime / video.duration) * 100);
          data.maxProgress = Math.max(data.maxProgress, pct);
          for (const m of [25, 50, 75]) {
            if (pct >= m && !milestones.has(m)) {
              milestones.add(m);
              CI.track({ event_type: 'video_milestone', video_src: data.src, element_path: data.path, video_milestone: m });
            }
          }
        }, 1000));
      }
    },

    flush() {
      for (const [video, data] of this.tracked) {
        let total = data.totalPlayed;
        if (data.startTime > 0) total += Date.now() - data.startTime;
        if (total < 500 && data.maxProgress === 0) continue;
        CI.track({
          event_type: 'video_summary', video_src: data.src, element_path: data.path,
          video_played_ms: Math.round(total), video_progress: data.maxProgress,
          video_duration: Math.round(data.duration), video_completed: data.completed ? 1 : 0,
          video_interactions: data.interactions.play + data.interactions.pause + data.interactions.seek + data.interactions.volumechange,
        });
      }
    },
  };

  CI.registerExtension(videoTracking);
})();
