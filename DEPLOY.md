# Deploy guide

## 1. Website (Vercel or Netlify)
Env vars (set in the host dashboard, NOT committed):
  EXPO_PUBLIC_API_URL    = https://<your-backend>
  EXPO_PUBLIC_SOCKET_URL = https://<your-backend>   (optional if same as API)
Build command: npm run build:web     Output dir: dist
Backend CORS must allow your website origin (Express + Socket.IO both).

## 2. iOS app (same code, native build)
npm i -g eas-cli && eas login
eas build:configure
# put the same EXPO_PUBLIC_* values in eas.json "env" or as EAS secrets
eas build --platform ios --profile production
eas submit --platform ios      # uploads to App Store Connect / TestFlight
Needs: Apple Developer account ($99/yr), unique bundleIdentifier in app.json, 1024x1024 icon.

## Free "app" on iPhone (no Apple Developer account): PWA
1. Deploy the website (section 1) over HTTPS.
2. On the iPhone open the URL in **Safari** -> Share -> **Add to Home Screen**.
3. It launches full-screen with its own icon. Replace public/*.png with your real icon.
Note: PWAs can't be listed on the App Store. Web push works only on iOS 16.4+ once installed.

## Notifications (free tier)
- **In-app pop-up** (native app + PWA): works out of the box. A banner slides in when a message / friend request
  arrives while the app is open; tap to open the chat, swipe up or tap x to dismiss.
- **OS notifications when the app is closed** (PWA / browser only): free via Web Push, no Firebase or Apple account.
  1. Generate keys once: `npx web-push generate-vapid-keys`
  2. Set on the BACKEND host: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com)
  3. Redeploy backend + website. Users turn it on from the one-time pop-up or Profile -> Settings -> Notifications.
  4. iPhone: must first Share -> Add to Home Screen, then open from the Home Screen (iOS 16.4+).
- `public/sw.js` only handles push. It caches nothing, so it can't affect the PWA layout or loading.
- Native iOS/Android OS push (app closed) is not included: iOS needs the paid Apple account, Android needs a
  dev build + Firebase. Add later with expo-notifications if you go that route.
- Tip: point BOTH EXPO_PUBLIC_API_URL and EXPO_PUBLIC_SOCKET_URL at the Render service. Real-time pop-ups need the
  socket server, and Vercel (serverless) has none, so friend-request pop-ups would only arrive as OS push.
