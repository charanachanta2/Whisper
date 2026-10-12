// Notifications for both the native app and the PWA.
//
//  1. In-app pop-up banner  -> native + web. Driven by the "notification"
//     socket event the backend already emits. Pure overlay: absolutely
//     positioned and click-through outside the card, so it never changes the
//     app layout (important for the locked PWA layout).
//  2. OS push (web only)    -> PWA / browser. Free: uses the Web Push standard
//     (no Firebase/Apple account). Needs VAPID keys on the backend.
//
// Nothing here touches the PWA shell CSS in scripts/postbuild-pwa.js.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Animated, PanResponder, Platform, AppState } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

const isWeb = Platform.OS === "web" && typeof window !== "undefined";

// ---------------------------------------------------------------------------
// Tiny event bus so the banner (mounted once at the root) can be driven from
// anywhere without threading props through the whole app.
// ---------------------------------------------------------------------------
const showListeners = new Set();
const openListeners = new Set();
export function emitNotification(payload) { showListeners.forEach((fn) => fn(payload)); }
export function emitOpenNotification(payload) { openListeners.forEach((fn) => fn(payload)); }
export function onNotificationOpen(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Visibility heartbeat: tells the server whether the app is on screen so it
// only sends an OS push when the in-app pop-up can't be seen (no double alerts).
// ---------------------------------------------------------------------------
function appIsVisible() {
  if (isWeb) return document.visibilityState === "visible";
  return AppState.currentState === "active";
}
export function startVisibilityHeartbeat(socket) {
  const send = () => { if (socket && socket.connected) socket.emit("app_visibility", { visible: appIsVisible() }); };
  send();
  const timer = setInterval(send, 5000);
  const appStateSub = isWeb ? null : AppState.addEventListener("change", send);
  if (isWeb) document.addEventListener("visibilitychange", send);
  return () => {
    clearInterval(timer);
    if (appStateSub) appStateSub.remove();
    if (isWeb) document.removeEventListener("visibilitychange", send);
    if (socket && socket.connected) socket.emit("app_visibility", { visible: false });
  };
}

// ---------------------------------------------------------------------------
// Web push helpers (no-ops on native)
// ---------------------------------------------------------------------------
export function webPushSupported() {
  return isWeb && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function isIOSDevice() {
  if (!isWeb) return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  if (!isWeb) return false;
  return Boolean(window.navigator.standalone) || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}
// iPhone only allows web push once the site is installed to the Home Screen.
export function iosNeedsInstall() { return isIOSDevice() && !isStandalone(); }

export async function registerServiceWorker() {
  if (!isWeb || !("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); } catch (_) { return null; }
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function fetchPublicKey(authedApi) {
  try {
    const res = await authedApi("/api/push/public-key");
    if (!res.ok) return null;
    return (await res.json()).publicKey || null;
  } catch (_) { return null; }
}

async function subscribeAndSave(authedApi, publicKey) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = urlBase64ToUint8Array(publicKey);
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (_) {
      return false;
    }
  }
  const res = await authedApi("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  return res.ok;
}

// Must be called straight from a tap (iOS requires a user gesture to ask for permission).
export async function enableWebPush(authedApi) {
  if (!webPushSupported()) return { ok: false, reason: "unsupported" };
  if (iosNeedsInstall()) return { ok: false, reason: "needs-install" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission === "denied" ? "denied" : "dismissed" };
  await registerServiceWorker();
  const publicKey = await fetchPublicKey(authedApi);
  if (!publicKey) return { ok: false, reason: "server-off" };
  const saved = await subscribeAndSave(authedApi, publicKey);
  return saved ? { ok: true } : { ok: false, reason: "failed" };
}

// Silent re-sync after login: if permission was already granted, make sure
// this device is registered for the signed-in person.
export async function syncWebPush(authedApi) {
  if (!webPushSupported() || Notification.permission !== "granted") return;
  try {
    await registerServiceWorker();
    const publicKey = await fetchPublicKey(authedApi);
    if (publicKey) await subscribeAndSave(authedApi, publicKey);
  } catch (_) { /* best effort */ }
}

export async function disableWebPush(authedApi) {
  if (!webPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    if (authedApi) await authedApi("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
  } catch (_) { /* best effort */ }
}

export async function getWebPushStatus(authedApi) {
  if (!isWeb) return "native";
  if (!webPushSupported()) return iosNeedsInstall() ? "needs-install" : "unsupported";
  if (iosNeedsInstall()) return "needs-install";
  if (Notification.permission === "denied") return "denied";
  const publicKey = await fetchPublicKey(authedApi);
  if (!publicKey) return "server-off";
  if (Notification.permission === "granted") {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg && (await reg.pushManager.getSubscription());
      return sub ? "on" : "off";
    } catch (_) { return "off"; }
  }
  return "off";
}

// Shows a one-time, tappable pop-up inviting the person to turn on OS notifications.
export async function maybePromptForPush(authedApi, storage, storageKey) {
  if (!webPushSupported() || iosNeedsInstall() || Notification.permission !== "default") return;
  try {
    if (await storage.getItem(storageKey)) return;
    const publicKey = await fetchPublicKey(authedApi);
    if (!publicKey) return;
    await storage.setItem(storageKey, "1");
    emitNotification({
      kind: "prompt",
      tag: "push-prompt",
      title: "Turn on notifications",
      body: "Tap here to get alerts for new messages, even when the app is closed.",
      onPress: () => { enableWebPush(authedApi); },
    });
  } catch (_) { /* ignore */ }
}

// Bridges a tapped OS notification into the app:
//  - app already open: the service worker posts a message
//  - app was closed: the service worker opens /?room=ID (or ?tab=discover)
export function initWebNotificationBridge() {
  if (!isWeb) return () => {};
  let onMessage = null;
  if ("serviceWorker" in navigator) {
    onMessage = (event) => {
      if (event.data && event.data.type === "open_notification") emitOpenNotification(event.data);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room");
    const tab = params.get("tab");
    if (roomId || tab) {
      window.history.replaceState({}, "", window.location.pathname);
      emitOpenNotification({ roomId: roomId || undefined, kind: tab === "discover" ? "friend_request" : undefined });
    }
  } catch (_) { /* ignore */ }
  return () => {
    if (onMessage) navigator.serviceWorker.removeEventListener("message", onMessage);
  };
}

// ---------------------------------------------------------------------------
// Pop-up banner (mounted once, inside SafeAreaProvider)
// ---------------------------------------------------------------------------
const ICONS = { message: "chatbubble", friend_request: "person-add", friend_accept: "people", post_like: "heart", post_comment: "chatbubble-ellipses", prompt: "notifications" };
const SHOW_MS = 5000;

export function NotificationHost({ colorFor }) {
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(null);
  const queue = useRef([]);
  const busy = useRef(false);
  const timer = useRef(null);
  const y = useRef(new Animated.Value(-160)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const useNative = Platform.OS !== "web";

  function showNext() {
    const next = queue.current.shift();
    if (!next) { busy.current = false; setCurrent(null); return; }
    busy.current = true;
    setCurrent(next);
    y.setValue(-160);
    opacity.setValue(0);
    Animated.parallel([
      Animated.spring(y, { toValue: 0, useNativeDriver: useNative, bounciness: 6, speed: 14 }),
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: useNative }),
    ]).start();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dismiss(), next.kind === "prompt" ? 9000 : SHOW_MS);
  }

  function dismiss(then) {
    clearTimeout(timer.current);
    Animated.parallel([
      Animated.timing(y, { toValue: -160, duration: 180, useNativeDriver: useNative }),
      Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: useNative }),
    ]).start(() => { if (then) then(); showNext(); });
  }

  useEffect(() => {
    const onShow = (payload) => {
      if (!payload) return;
      // Newer alert for the same chat replaces the one still waiting / on screen.
      if (payload.tag) {
        queue.current = queue.current.filter((q) => q.tag !== payload.tag);
        if (busy.current && current && current.tag === payload.tag) {
          setCurrent(payload);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => dismiss(), SHOW_MS);
          return;
        }
      }
      queue.current.push(payload);
      if (queue.current.length > 4) queue.current.shift();
      if (!busy.current) showNext();
    };
    showListeners.add(onShow);
    return () => { showListeners.delete(onShow); clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const pan = useRef(
    PanResponder.create({
      // Only claim the gesture for a real upward swipe, so plain taps still reach the card.
      onMoveShouldSetPanResponder: (_, g) => g.dy < -8 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => { if (g.dy < 0) y.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.dy < -24 || g.vy < -0.5) dismiss();
        else Animated.spring(y, { toValue: 0, useNativeDriver: useNative }).start();
      },
    }),
  ).current;

  if (!current) return null;

  const icon = ICONS[current.kind] || "notifications";
  const isPrompt = current.kind === "prompt";
  const accent = isPrompt || !colorFor ? "#6C7CE0" : colorFor(current.title || "N");

  function onPress() {
    dismiss(() => {
      if (current.onPress) current.onPress();
      else emitOpenNotification(current);
    });
  }

  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 9999, elevation: 50, pointerEvents: "box-none" }}>
      <Animated.View
        {...pan.panHandlers}
        style={{
          marginTop: Math.max(insets.top, 8) + 6,
          marginHorizontal: 12,
          transform: [{ translateY: y }],
          opacity,
          pointerEvents: "auto",
        }}
      >
        <Pressable
          onPress={onPress}
          accessibilityRole="alert"
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: "rgba(24,23,32,0.97)",
            borderColor: "rgba(255,255,255,0.14)",
            borderWidth: 1,
            borderRadius: 18,
            paddingVertical: 12,
            paddingHorizontal: 14,
            shadowColor: "#000",
            shadowOpacity: 0.35,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: accent, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name={icon} size={19} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>{current.title}</Text>
            {!!current.body && (
              <Text numberOfLines={2} style={{ color: "#c9c6d6", fontSize: 14, marginTop: 2 }}>{current.body}</Text>
            )}
          </View>
          <Pressable onPress={() => dismiss()} hitSlop={12} style={{ marginLeft: 8 }}>
            <Ionicons name="close" size={18} color="#a3a0b0" />
          </Pressable>
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Settings row (web/PWA only) to turn OS notifications on or off
// ---------------------------------------------------------------------------
const STATUS_TEXT = {
  unsupported: "This browser doesn't support push notifications. In-app pop-ups still work while the app is open.",
  "needs-install": "On iPhone: tap Share, then Add to Home Screen, and open the app from your Home Screen. Then come back here to turn notifications on.",
  denied: "Notifications are blocked. Allow them for this app in your phone or browser settings, then reopen the app.",
  "server-off": "Push isn't set up on the server yet. In-app pop-ups still work while the app is open.",
  off: "Get alerts for new messages even when the app is closed.",
  on: "Notifications are on for this device.",
};

export function NotificationSettingsRow({ authedApi, colors }) {
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const refresh = async () => setStatus(await getWebPushStatus(authedApi));
  useEffect(() => { refresh(); }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (status === "on") await disableWebPush(authedApi);
      else {
        const result = await enableWebPush(authedApi);
        if (!result.ok && result.reason === "failed") setStatus("unsupported");
      }
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  if (status === "native") return null;
  const canToggle = status === "on" || status === "off";
  return (
    <View>
      <Text style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20 }}>
        {status === "loading" ? "Checking…" : STATUS_TEXT[status]}
      </Text>
      {canToggle && (
        <Pressable
          onPress={toggle}
          style={{
            marginTop: 10,
            paddingVertical: 12,
            borderRadius: 12,
            alignItems: "center",
            backgroundColor: status === "on" ? colors.surfaceRaised : colors.accent,
            borderWidth: status === "on" ? 1 : 0,
            borderColor: colors.border,
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Text style={{ color: status === "on" ? colors.text : "#fff", fontWeight: "700", fontSize: 15 }}>
            {busy ? "Please wait…" : status === "on" ? "Turn off notifications" : "Turn on notifications"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
