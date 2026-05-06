/**
 * GameBridge.js
 *
 * Unified interface for Vibration, Audio, and Motion across
 * Android WebView and iOS WKWebView.
 *
 * The game never calls platform APIs directly — it only calls GameBridge.
 * Platform differences are resolved here.
 *
 * Usage:
 *   await GameBridge.init();
 *   GameBridge.vibrate([100, 50, 100]);
 *   GameBridge.audio.play('jump');
 *   GameBridge.motion.on(({ x, y, z }) => { ... });
 */

const GameBridge = (() => {

  // ─── Platform detection ──────────────────────────────────────────────────

  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const IS_ANDROID = /Android/.test(navigator.userAgent);

  /**
   * Send a message to the native app.
   * Android: window.NativeBridge.postMessage(json)  (injected by the app)
   * iOS:     window.webkit.messageHandlers.gameBridge.postMessage(obj)
   */
  function sendToNative(msg) {
    if (IS_IOS) {
      if (!window.webkit?.messageHandlers?.gameBridge) {
        console.warn('[GameBridge] iOS native bridge not available');
        return;
      }
      window.webkit.messageHandlers.gameBridge.postMessage(msg);
    } else if (IS_ANDROID) {
      if (!window.NativeBridge?.postMessage) {
        console.warn('[GameBridge] Android native bridge not available');
        return;
      }
      window.NativeBridge.postMessage(JSON.stringify(msg));
    } else {
      console.warn('[GameBridge] native bridge not available (unsupported platform)');
    }
  }


  // ─── Vibration ───────────────────────────────────────────────────────────

  /**
   * GameBridge.vibrate(pattern)
   *
   * @param {number | number[]} pattern - ms duration or [on, off, on, ...] pattern
   *
   * Android: navigator.vibrate() — works natively in WebView
   * iOS:     postMessage to native (WKWebView has no Vibration API)
   *          Native side calls UIImpactFeedbackGenerator or AudioServicesPlaySystemSound
   */
  function vibrate(pattern) {
    const p = Array.isArray(pattern) ? pattern : [pattern];
    if (IS_IOS) {
      sendToNative({ type: 'vibrate', pattern: p });
    } else {
      navigator.vibrate?.(p);
    }
  }

  /**
   * Cancel any in-progress vibration.
   * Android: navigator.vibrate(0)
   * iOS: sends cancel message to native
   */
  function vibrateCancel() {
    if (IS_IOS) {
      sendToNative({ type: 'vibrateCancel' });
    } else {
      navigator.vibrate?.(0);
    }
  }


  // ─── Audio ───────────────────────────────────────────────────────────────

  /**
   * GameBridge.audio
   *
   * Web Audio API works on both platforms, but the AudioContext must be
   * resumed inside a user gesture. Call GameBridge.audio.unlock() on the
   * first tap/click event before playing any sounds.
   *
   * Sounds are loaded via GameBridge.audio.load(id, url) and played with
   * GameBridge.audio.play(id, options).
   */
  const audio = (() => {
    let ctx = null;
    let buffers = {};
    /** @type {Map<string, Set<{ gain: GainNode, src: AudioBufferSourceNode }>>} */
    const activeNodes = new Map();
    /** @type {Map<string, Promise<void>>} */
    const loading = new Map();

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    function getContext() {
      if (!ctx) {
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (err) {
          console.warn('[GameBridge] AudioContext unavailable', err);
          return null;
        }
      }
      return ctx;
    }

    /**
     * Must be called inside a user gesture (tap, click, keydown).
     * Safe to call multiple times.
     */
    async function unlock() {
      const c = getContext();
      if (!c) return;
      if (c.state === 'suspended') await c.resume();
    }

    /**
     * Preload a sound.
     * @param {string} id    - Identifier used to play the sound later
     * @param {string} url   - URL of the audio file (mp3 / ogg / wav)
     */
    async function load(id, url) {
      if (loading.has(id)) return loading.get(id);
      const promise = (async () => {
        const c = getContext();
        if (!c) throw new Error(`[GameBridge] audio.load("${id}"): AudioContext unavailable`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[GameBridge] audio.load("${id}"): fetch failed (${res.status})`);
        const arrayBuffer = await res.arrayBuffer();
        buffers[id] = await c.decodeAudioData(arrayBuffer);
      })();
      loading.set(id, promise);
      try {
        await promise;
      } finally {
        loading.delete(id);
      }
    }

    /**
     * Play a preloaded sound.
     * @param {string} id
     * @param {{ volume?: number, loop?: boolean }} [opts]
     * @returns {AudioBufferSourceNode} - call .stop() to stop early
     */
    function play(id, { volume = 1, loop = false } = {}) {
      if (!buffers[id]) {
        console.warn(`GameBridge.audio: "${id}" not loaded`);
        return { stop() {}, addEventListener() {}, loop: false, buffer: null };
      }
      const c = getContext();
      if (!c) {
        console.warn('[GameBridge] audio.play: AudioContext unavailable');
        return { stop() {}, addEventListener() {}, loop: false, buffer: null };
      }
      const src = c.createBufferSource();
      src.buffer = buffers[id];
      src.loop = loop;

      const gain = c.createGain();
      gain.gain.value = clamp01(volume);

      if (!activeNodes.has(id)) activeNodes.set(id, new Set());
      const entry = { gain, src };
      activeNodes.get(id).add(entry);

      src.addEventListener('ended', () => {
        activeNodes.get(id)?.delete(entry);
      });

      src.connect(gain);
      gain.connect(c.destination);
      src.start(0);
      return src;
    }

    /**
     * Set the volume of all in-flight instances of a sound by id.
     * @param {string} id
     * @param {number} value  0.0 – 1.0
     */
    function setVolume(id, value) {
      const clamped = clamp01(value);
      const entries = activeNodes.get(id);
      if (entries) entries.forEach(e => { e.gain.gain.value = clamped; });
    }

    /**
     * Unload a sound buffer to free memory.
     * Stops all in-flight instances of the sound.
     * @param {string} id
     */
    function unload(id) {
      const entries = activeNodes.get(id);
      if (entries) {
        entries.forEach(e => { try { e.src.stop(); } catch (_) {} });
        activeNodes.delete(id);
      }
      delete buffers[id];
    }

    /**
     * Stop all in-flight instances of a sound (without unloading).
     * @param {string} id
     */
    function stop(id) {
      const entries = activeNodes.get(id);
      if (entries) {
        entries.forEach(e => { try { e.src.stop(); } catch (_) {} });
        activeNodes.delete(id);
      }
    }

    /** Stop all currently playing sounds. */
    function stopAll() {
      activeNodes.forEach((entries) => {
        entries.forEach(e => { try { e.src.stop(); } catch (_) {} });
      });
      activeNodes.clear();
    }

    function dispose() {
      stopAll();
      buffers = {};
      if (ctx) { ctx.close(); ctx = null; }
    }

    return { unlock, load, play, stop, stopAll, setVolume, unload, dispose };
  })();


  // ─── Motion ──────────────────────────────────────────────────────────────

  /**
   * GameBridge.motion
   *
   * Normalised DeviceMotion interface.
   *
   * Android: DeviceMotionEvent fires without a permission prompt
   * iOS 13+: Must call motion.requestPermission() inside a user gesture
   *          The native app may also need to forward motion events via
   *          postMessage if the WKWebView blocks them (some configs do).
   *
   * Callback receives: { x, y, z }  (accelerationIncludingGravity, m/s²)
   *
   * If the native app is forwarding motion events via postMessage, they
   * should post: { type: 'motion', x, y, z }
   */
  const motion = (() => {
    const MAX_LISTENERS = 20;
    let listeners = [];
    let permitted = false;
    let webListenerAttached = false;

    function emit(data) {
      listeners.forEach(fn => fn(data));
    }

    function attachWebListener() {
      if (webListenerAttached) return;
      webListenerAttached = true;
      window.addEventListener('devicemotion', (e) => {
        const a = e.accelerationIncludingGravity;
        if (!a) return;
        emit({ x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 });
      });
    }

    // Native app may forward motion events over postMessage on some iOS configs
    window.addEventListener('message', (e) => {
      // Only accept messages from the same origin or from null (file:// / WKWebView)
      if (e.origin !== 'null' && e.origin !== window.location.origin) return;
      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (msg?.type === 'motion') emit({ x: msg.x, y: msg.y, z: msg.z });
      } catch (_) {}
    });

    /**
     * Request motion permission (required on iOS 13+).
     * Must be called inside a user gesture (button tap etc.).
     * On Android this resolves immediately with 'granted'.
     *
     * @returns {Promise<'granted'|'denied'|'unavailable'>}
     */
    async function requestPermission() {
      if (typeof DeviceMotionEvent?.requestPermission === 'function') {
        try {
          const result = await DeviceMotionEvent.requestPermission();
          if (result === 'granted') {
            permitted = true;
            attachWebListener();
          }
          return result;
        } catch (err) {
          console.warn('GameBridge.motion: permission error', err);
          return 'denied';
        }
      }

      // Android / older iOS — no prompt needed
      if (window.DeviceMotionEvent) {
        permitted = true;
        attachWebListener();
        return 'granted';
      }

      return 'unavailable';
    }

    /**
     * Register a motion callback.
     * @param {function({ x: number, y: number, z: number }): void} fn
     * @returns {function} - call the returned function to unsubscribe
     */
    function on(fn) {
      listeners.push(fn);
      if (listeners.length > MAX_LISTENERS) {
        console.warn(`[GameBridge] motion: possible listener leak (${listeners.length} registered)`);
      }
      if (!permitted) {
        console.warn('GameBridge.motion: call requestPermission() first (inside a user gesture)');
      }
      return () => { listeners = listeners.filter(l => l !== fn); };
    }

    /** Remove all motion listeners. */
    function off() {
      listeners = [];
    }

    return { requestPermission, on, off };
  })();


  // ─── Init ────────────────────────────────────────────────────────────────

  /**
   * Optional: call once on app start to log detected capabilities.
   * Does NOT request any permissions.
   */
  async function init() {
    const caps = {
      platform: IS_IOS ? 'ios' : IS_ANDROID ? 'android' : 'other',
      vibration: IS_IOS ? 'native-bridge' : !!navigator.vibrate,
      audio: !!(window.AudioContext || window.webkitAudioContext),
      motion: IS_IOS
        ? (typeof DeviceMotionEvent?.requestPermission === 'function' ? 'permission-required' : 'unavailable')
        : !!window.DeviceMotionEvent,
    };
    console.log('[GameBridge] capabilities', caps);
    return caps;
  }

  return { init, vibrate, vibrateCancel, audio, motion };

})();

export default GameBridge;
