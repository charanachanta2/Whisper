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
