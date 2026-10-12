// Injects PWA / iOS "Add to Home Screen" tags into the exported index.html.
const fs = require("fs");
const p = "dist/index.html";
let html = fs.readFileSync(p, "utf8");
const tags = `
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Music Chat">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#111111">`;
if (!html.includes("manifest.webmanifest")) {
  html = html.replace("</head>", tags + "\n</head>");
}
// allow content under the notch in standalone mode
html = html.replace(/(<meta name="viewport" content=")([^"]*)"/, (m, a, b) =>
  b.includes("viewport-fit") ? m : `${a}${b}, viewport-fit=cover"`);
fs.writeFileSync(p, html);
console.log("PWA tags injected into", p);
