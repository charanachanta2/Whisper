// Post-build step for the web export: PWA tags + locked, fixed-size layout.
const fs = require("fs");
const p = "dist/index.html";
let html = fs.readFileSync(p, "utf8");

const head = `
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Music Chat">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0b0b10">
<style id="lock-layout">
  :root { color-scheme: light dark; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;          /* no rubber-band / pull-to-refresh */
    -webkit-text-size-adjust: 100%;     /* iOS can't resize text */
    text-size-adjust: 100%;
    touch-action: manipulation;         /* no double-tap zoom */
    -webkit-tap-highlight-color: transparent;
    background: #f5f5f7;
  }
  @media (prefers-color-scheme: dark) { html, body { background: #0b0b10; } }
  /* Pin the app to the real screen edges. position:fixed with top/bottom 0
     reaches under the Dynamic Island and the home indicator on iOS (100vh /
     100% can stop short of them in a home-screen app). */
  #root {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    max-width: 520px;                   /* fixed phone-width column on big screens */
    margin: 0 auto;
    display: flex;
  }
  /* iOS zooms the page when a focused input has font-size < 16px */
  input, textarea, select { font-size: 16px !important; }
</style>`;

if (!html.includes("manifest.webmanifest")) html = html.replace("</head>", head + "\n</head>");

// Lock the viewport: no pinch zoom, extend under notch / home indicator.
html = html.replace(/<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">');

// iOS Safari ignores user-scalable=no, so block pinch zoom explicitly (double-tap is handled by touch-action in CSS).
const script = `
<script>
  // iOS home-screen apps can report a viewport that stops above the home
  // indicator. In standalone mode, size the app to the real screen height.
  (function () {
    var standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    if (!standalone) return;
    function fit() {
      var root = document.getElementById("root");
      if (!root) return;
      var portrait = window.innerHeight >= window.innerWidth;
      var screenH = portrait
        ? Math.max(window.screen.width, window.screen.height)
        : Math.min(window.screen.width, window.screen.height);
      root.style.bottom = "auto";
      root.style.height = Math.max(window.innerHeight, screenH) + "px";
    }
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    window.addEventListener("pageshow", fit);
  })();
  ["gesturestart","gesturechange","gestureend"].forEach(function (e) {
    document.addEventListener(e, function (ev) { ev.preventDefault(); }, { passive: false });
  });
  document.addEventListener("touchmove", function (ev) {
    if (ev.touches.length > 1) ev.preventDefault();
  }, { passive: false });
</script>`;
if (!html.includes("gesturestart")) html = html.replace("</body>", script + "\n</body>");

fs.writeFileSync(p, html);
console.log("PWA + locked layout injected into", p);
