import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  Platform,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Share,
  Image,
  Animated,
  Dimensions,
  Appearance,
  ScrollView,
  PanResponder,
  Easing,
} from "react-native";
// react-native core's SafeAreaView is iOS-only (it's a no-op on Android),
// which is why the header/status bar area could overlap system content on
// Android. react-native-safe-area-context works correctly on both
// platforms and is the standard replacement.
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
// SDK 54+ moved the classic read/write functions (readAsStringAsync, etc.)
// behind this legacy subpath -- the new top-level expo-file-system API is a
// different, class-based shape and doesn't have them.
import * as FileSystem from "expo-file-system/legacy";
import { VideoView, useVideoPlayer } from "expo-video";
import { AudioModule, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { useEvent } from "expo";
import { io } from "socket.io-client";
// Neither iOS nor Android has a status bar style set anywhere in this file,
// so both fall back to the OS default -- which is light (white) icons. That
// reads fine on the dark theme's near-black background but makes the clock,
// battery, and signal icons disappear against the light theme's near-white
// background. StatusBar (rendered per-screen below, driven by C.mode) fixes
// that on both platforms.
import { StatusBar } from "expo-status-bar";
import {
  NotificationHost,
  NotificationSettingsRow,
  emitNotification,
  onNotificationOpen,
  startVisibilityHeartbeat,
  initWebNotificationBridge,
  maybePromptForPush,
  syncWebPush,
  disableWebPush,
} from "./notifications";

// Keep this in .env so development, staging, and production can each use
// their own backend. Do not hard-code a deployment URL here: it prevents the
// app from using the backend selected by EXPO_PUBLIC_API_URL.
const API_URL = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000")
  .replace(/\/+$/, "");
// This app runs as a single Render deployment: server/src/index.js serves
// the REST API and the Socket.IO realtime connection together on one
// process, so both URLs should point at that same service. Defaulting to
// API_URL here means a deployment only has to set EXPO_PUBLIC_API_URL.
const SOCKET_URL = (process.env.EXPO_PUBLIC_SOCKET_URL || API_URL)
  .replace(/\/+$/, "");

console.log("API URL:", API_URL);
console.log("Socket URL:", SOCKET_URL);


// --- Web compatibility ---------------------------------------------------
// React Native's Alert.alert is a silent no-op in browsers (react-native-web),
// so every confirm/error dialog would just vanish on the website. Map it to
// window.alert / window.confirm on web only; native iOS/Android is untouched.
if (Platform.OS === "web") {
  Alert.alert = (title, message, buttons) => {
    const text = [title, message].filter(Boolean).join("\n\n");
    if (!buttons || buttons.length <= 1) {
      window.alert(text);
      buttons && buttons[0] && buttons[0].onPress && buttons[0].onPress();
      return;
    }
    const cancel = buttons.find((b) => b.style === "cancel");
    const action = buttons.find((b) => b !== cancel) || buttons[buttons.length - 1];
    if (window.confirm(text)) action.onPress && action.onPress();
    else cancel && cancel.onPress && cancel.onPress();
  };
}

// Reads a picked file as base64. FileSystem.readAsStringAsync is not
// supported on web, so use fetch + FileReader there.
async function readAsBase64(uri) {
  if (Platform.OS !== "web") {
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  }
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read file."));
    r.readAsDataURL(blob);
  });
}

const TOKEN_KEY = "music_chat_token";
const USER_KEY = "music_chat_user";
// Every account signed in on this device (for the account switcher): [{ token, user }].
const ACCOUNTS_KEY = "hush_accounts";
// Persists the person's chosen appearance ("system" | "light" | "dark") so
// it survives app restarts instead of resetting to the default every time.
const THEME_KEY = "music_chat_theme";
// Remembers that the one-time "turn on notifications" pop-up was already shown.
const PUSH_PROMPT_KEY = "music_chat_push_prompted";
const SCREEN_WIDTH = Dimensions.get("window").width;
const SCREEN_HEIGHT = Dimensions.get("window").height;

// Shared adaptive image renderer used everywhere a shared photo shows up
// (chat bubbles and Home posts). Attachments used to render at a fixed
// square size no matter the source photo's real proportions, so a portrait
// phone photo, a landscape screenshot, and a square icon all got squashed
// into the same box and cropped oddly. This measures the real image first
// and picks a size that keeps its natural aspect ratio, capped so it never
// blows up the layout.
// `knownRatio` (width/height) comes from the upload response / picker, so we
// no longer have to download the whole image a second time just to measure it
// (Image.getSize does exactly that). Old messages without it fall back to the probe.
function AdaptiveImage({ uri, maxWidth, maxHeight = 320, minHeight = 120, style, onPress, knownRatio }) {
  const [ratio, setRatio] = useState(knownRatio || 1);
  useEffect(() => {
    if (!uri || knownRatio) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => { if (!cancelled && w > 0 && h > 0) setRatio(w / h); },
      () => {} // Keep the 1:1 fallback ratio if the probe fails; still renders, just not perfectly sized.
    );
    return () => { cancelled = true; };
  }, [uri, knownRatio]);

  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) { height = maxHeight; width = height * ratio; }
  if (height < minHeight) { height = minHeight; width = Math.min(maxWidth, height * ratio); }

  const img = <Image source={{ uri }} style={[style, { width, height }]} resizeMode="cover" />;
  return onPress ? <Pressable onPress={onPress}>{img}</Pressable> : img;
}

function api(path, options = {}) {
  // IMPORTANT: compute headers into its own variable first. Spreading
  // ...options after an inline `headers` key (the old code did
  // `{ headers: {...}, ...options }`) lets a `headers` key coming in from
  // options silently replace the whole object above it -- so any request
  // that arrived here already carrying its own `headers` (every call made
  // through authedApi() below, i.e. every authenticated request in the
  // app) lost "Content-Type: application/json" entirely. Express's JSON
  // body parser only parses the body when that header is present, so the
  // server was receiving these requests with an empty, unparsed body --
  // which is why posting from Home failed with "Write something or attach
  // a photo" even when text (and/or a photo) was clearly there.
  const { headers, ...rest } = options;
  return fetch(`${API_URL}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  });
}

// Uploads a picked photo/video/file to the backend so every member of a
// chat (not just the person who picked it) can actually load it. Sending
// only the local device URI -- what this app used to do -- meant the
// message rendered as a dead link for everyone else, since a file:// path
// only exists on the sender's phone.
// Shrinks a picked photo ON THE PHONE before it is uploaded. A modern camera
// photo is 4000px / several MB; resizing to what the screen can actually show
// (and JPEG-compressing) makes uploads several times faster. Videos, GIFs and
// anything that fails to convert are passed through untouched.
async function prepareImage(asset, maxWidth = 1600) {
  const mime = asset.mimeType || "";
  const isImage = asset.type ? asset.type === "image" : mime.startsWith("image/");
  if (!isImage || mime === "image/gif") return asset;
  try {
    const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri);
    if (!asset.width || asset.width > maxWidth) ctx.resize({ width: maxWidth });
    const ref = await ctx.renderAsync();
    const out = await ref.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.75 });
    return { ...asset, uri: out.uri, width: out.width, height: out.height, fileName: "photo.jpg", mimeType: "image/jpeg" };
  } catch (_) {
    return asset;
  }
}

async function uploadAsset(token, asset, { endpoint = "/api/upload", purpose } = {}) {
  // Both the original FormData {uri,name,type} shape AND the follow-up
  // FileSystem.uploadAsync attempt hit native multipart-encoding code paths
  // that keep breaking across RN/Expo versions ("Unsupported FormDataPart
  // implementation" was the FormData one). Reading the file as base64 and
  // POSTing it as a plain JSON string sidesteps native multipart handling
  // entirely. Because photos are now shrunk first (prepareImage), that base64
  // body is small (typically 100-400KB).
  const name = asset.fileName || asset.name || `upload-${Date.now()}`;
  const type = asset.mimeType || asset.type || "application/octet-stream";
  const base64 = await readAsBase64(asset.uri);
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fileName: name, mimeType: type, data: base64, purpose }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (server replied ${res.status}).`);
  return { ...data, fileName: data.fileName || name };
}

// Deterministic avatar background so names/rooms still feel distinct from
// one another. Muted, desaturated tones rather than saturated rainbow
// colors so a list of avatars reads as calm and professional instead of
// carnival-bright.
const AVATAR_COLORS = ["#5B6CC4", "#3E8E8A", "#B5677A", "#B98A4A", "#4C7FA6", "#5C9A6B", "#8A6BB0", "#B06F4E"];
function colorFor(text = "") {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// SafeAreaProvider must wrap the app once, near the root, so every
// SafeAreaView (and any useSafeAreaInsets() call) below it can measure the
// real notch/status-bar/home-indicator insets on both iOS and Android.
export default function App() {
  return (
    <SafeAreaProvider>
      <AppRoot />
      <NotificationHost colorFor={colorFor} />
    </SafeAreaProvider>
  );
}

// The floating tab bar hides while you scroll down and comes back when you scroll up.
// Every tab's list reports its scrolling through this context.
const ScrollChromeContext = createContext({ onScroll: undefined });
const TAB_SPACE = 96; // room left under lists so the floating bar never covers the last item

function AppRoot() {
  const [screen, setScreen] = useState("auth"); // auth | main | chat
  const [mainTab, setMainTab] = useState("home"); // home | chats | discover | profile
  const [authMode, setAuthMode] = useState("login");
  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  // Accounts saved on this device so the person can switch without retyping passwords.
  const [accounts, setAccounts] = useState([]);
  const [addingAccount, setAddingAccount] = useState(false);
  const accountsRef = useRef([]);
  const meRef = useRef(null);
  meRef.current = me;
  // "system" | "light" | "dark" -- the saved preference. themeTick just
  // exists to force this component (and everything under it) to re-render
  // after applyTheme() reassigns the module-level C/styles bindings, since
  // mutating those objects in place doesn't itself trigger React to redraw.
  const [themeMode, setThemeModeState] = useState("system");
  const [themeTick, setThemeTick] = useState(0);
  const [incomingCount, setIncomingCount] = useState(0);

  const [activeRoom, setActiveRoom] = useState(null); // { id, name, isDirect, otherUser }
  const [roomMembers, setRoomMembers] = useState([]);
  const [activeVoiceRoom, setActiveVoiceRoom] = useState(null); // { id, name }
  const [message, setMessage] = useState("");
  const [replyingTo, setReplyingTo] = useState(null); // message being replied to
  const [actionMsg, setActionMsg] = useState(null); // message whose react/reply/delete sheet is open
  const [deleteTarget, setDeleteTarget] = useState(null); // message awaiting delete confirmation
  const [messages, setMessages] = useState([]);
  const [socket, setSocket] = useState(null);
  const [socketReady, setSocketReady] = useState(false);
  const [roomsRefreshKey, setRoomsRefreshKey] = useState(0);
  const [notifUnread, setNotifUnread] = useState(0);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachAnim = useRef(new Animated.Value(0)).current;

  // Instagram-style expanding attach menu: tapping + expands a row of
  // photo/file/audio options out of the button instead of showing three
  // separate icons permanently crowding the message bar.
  function toggleAttachMenu() {
    const opening = !attachOpen;
    setAttachOpen(opening);
    Animated.timing(attachAnim, {
      toValue: opening ? 1 : 0,
      duration: 220,
      useNativeDriver: false, // animates layout width, which the native driver can't do
    }).start();
  }
  function closeAttachMenu() {
    if (!attachOpen) return;
    setAttachOpen(false);
    Animated.timing(attachAnim, { toValue: 0, duration: 180, useNativeDriver: false }).start();
  }
  function pickWith(action) {
    closeAttachMenu();
    action();
  }

  const listRef = useRef(null);
  // True while a chat is still opening: the list keeps jumping to the newest message as it
  // renders and measures items, then lets go as soon as the person scrolls (or after a moment).
  const pinToBottomRef = useRef(false);
  const pinTimerRef = useRef(null);
  // Latest screen state for notification callbacks (socket handlers are created once per login).
  const screenRef = useRef(screen);
  // Floating tab bar: hidden while scrolling down, back on scroll up (or tap the little handle).
  const tabHide = useRef(new Animated.Value(0)).current; // 0 = shown, 1 = tucked away
  const [tabsHidden, setTabsHiddenState] = useState(false);
  const tabsHiddenRef = useRef(false);
  const lastScrollY = useRef(0);
  const setTabsHidden = useCallback((hide) => {
    if (tabsHiddenRef.current === hide) return;
    tabsHiddenRef.current = hide;
    setTabsHiddenState(hide);
    Animated.timing(tabHide, { toValue: hide ? 1 : 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
  }, [tabHide]);
  const onChromeScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - lastScrollY.current;
    lastScrollY.current = y;
    if (y <= 24) return setTabsHidden(false);
    if (dy > 6) setTabsHidden(true);
    else if (dy < -6) setTabsHidden(false);
  }, [setTabsHidden]);
  const chromeValue = useRef({ onScroll: null }).current;
  chromeValue.onScroll = onChromeScroll;
  const mainTabRef = useRef(mainTab);
  const activeRoomRef = useRef(activeRoom);
  const pendingOpenRef = useRef(null);
  const tokenRef = useRef(null);
  tokenRef.current = token;
  screenRef.current = screen;
  mainTabRef.current = mainTab;
  useEffect(() => { lastScrollY.current = 0; setTabsHidden(false); }, [mainTab]);
  activeRoomRef.current = activeRoom;

  // Recomputes the actual colors to show (light vs dark) for a given saved
  // preference, reassigns the module-level C/styles bindings, then bumps
  // themeTick so React re-renders with them.
  function applyTheme(mode) {
    const effective = mode === "system" ? (Appearance.getColorScheme() || "dark") : mode;
    C = effective === "light" ? LIGHT_C : DARK_C;
    styles = buildStyles(C);
    // On web, paint the page itself (behind the app, under the notch and
    // home indicator) in the app's own background so no strip of a different
    // colour shows when the phone's theme and the app's theme differ.
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.documentElement.style.background = C.bg;
      document.body.style.background = C.bg;
      document.documentElement.style.colorScheme = effective;
      let meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", C.bg);
    }
    setThemeTick((t) => t + 1);
  }
  async function changeThemeMode(mode) {
    setThemeModeState(mode);
    applyTheme(mode);
    try { await AsyncStorage.setItem(THEME_KEY, mode); } catch (_) {}
  }

  useEffect(() => {
    (async () => {
      try {
        const savedTheme = await AsyncStorage.getItem(THEME_KEY);
        const mode = savedTheme || "system";
        setThemeModeState(mode);
        applyTheme(mode);
      } catch (_) {}
    })();
    // Keeps the app in sync if the person flips their OS appearance while
    // on "system" mode, without needing to reopen the app.
    const sub = Appearance.addChangeListener(() => {
      setThemeModeState((current) => {
        if (current === "system") applyTheme("system");
        return current;
      });
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        try {
          const raw = await AsyncStorage.getItem(ACCOUNTS_KEY);
          const list = raw ? JSON.parse(raw) : [];
          if (Array.isArray(list)) { accountsRef.current = list.filter((a) => a && a.token && a.user && a.user.id); setAccounts(accountsRef.current); }
        } catch (_) {}
        const savedToken = await AsyncStorage.getItem(TOKEN_KEY);
        if (!savedToken) return;
        const res = await api("/api/me", {
          headers: { Authorization: `Bearer ${savedToken}` },
        });
        const data = await res.json();
        if (res.ok) {
          setToken(savedToken);
          setMe(data.user);
          setScreen("main");
        } else {
          await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
        }
      } catch (_) {
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // One persistent socket connection per signed-in session, kept alive
  // across screens/tabs instead of being torn down and rebuilt every time a
  // chat is opened. Reconnecting per-room caused race conditions that could
  // surface as spurious "Unauthorized" errors; a single long-lived
  // connection is far more reliable.
  useEffect(() => {
    if (!token) {
      setSocket(null);
      setSocketReady(false);
      return;
    }
    const s = io(SOCKET_URL, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 12000,
    });

    let handledAuthFailure = false;
    s.on("connect", () => {
      setSocketReady(true);
      handledAuthFailure = false;
    });
    s.on("disconnect", () => setSocketReady(false));
    s.on("connect_error", (err) => {
      const msg = err?.message || "Could not connect to chat.";
      setSocketReady(false);
      // Now that REST and sockets are one Render deployment sharing a
      // single SESSION_SECRET, a real "Unauthorized"/"User not found" here
      // does mean the token is actually invalid (expired, or the server
      // restarted with a rotated secret) -- so signing out is correct. Guard
      // against firing repeatedly while socket.io retries the connection.
      if (/unauthorized|user not found/i.test(msg)) {
        if (!handledAuthFailure) {
          handledAuthFailure = true;
          handleExpiredSession();
        }
      } else {
        Alert.alert("Connection error", msg);
      }
    });

    // In-app pop-up for activity elsewhere (new message, friend request, ...).
    s.on("notification", (n) => {
      if (!n) return;
      const viewingThatChat = screenRef.current === "chat" && activeRoomRef.current?.id === n.roomId;
      if (n.kind === "message" && viewingThatChat) {
        // Already looking at it: don't pop up, and don't leave it unread in the bell.
        if (n.notificationId) authedApi("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.notificationId] }) }).catch(() => {});
        return;
      }
      setNotifUnread((c) => c + 1);
      emitNotification(n);
      // A newly accepted friend means a new direct chat: refresh the chat list.
      if (n.kind === "friend_accept") setRoomsRefreshKey((k) => k + 1);
    });
    // Lets the server skip the OS push while the app is on screen.
    let stopHeartbeat = () => {};
    s.on("connect", () => { stopHeartbeat(); stopHeartbeat = startVisibilityHeartbeat(s); });

    setSocket(s);
    return () => {
      stopHeartbeat();
      s.disconnect();
      setSocket(null);
      setSocketReady(false);
    };
  }, [token]);

  // Tapping a pop-up (or an OS notification on the PWA) opens the right screen.
  function openFromNotification(n) {
    if (!n) return;
    if (n.room) return openRoom(n.room);
    if (n.roomId) {
      (async () => {
        try {
          const res = await authedApi("/api/rooms");
          if (!res.ok) return;
          const data = await res.json();
          const room = (data.rooms || []).find((r) => r.id === n.roomId);
          if (room) return room.isVoice ? openVoiceRoom(room) : openRoom(room);
        } catch (_) {}
      })();
      return;
    }
    if (n.kind === "friend_request") { setScreen("main"); setMainTab("discover"); }
    if (n.kind === "post_like" || n.kind === "post_comment" || n.kind === "post_mention" || n.kind === "story_mention") { setScreen("main"); setMainTab("home"); }
  }
  const openFromNotificationRef = useRef(openFromNotification);
  openFromNotificationRef.current = openFromNotification;

  // Listen for taps (pop-up, or OS notification via the service worker). If the
  // app is still signing in, remember the tap and handle it once we are.
  useEffect(() => {
    const unsubscribe = onNotificationOpen((n) => {
      if (tokenRef.current) openFromNotificationRef.current(n);
      else pendingOpenRef.current = n;
    });
    const stopBridge = initWebNotificationBridge();
    return () => { unsubscribe(); stopBridge(); };
  }, []);

  // Keep the bell's unread count fresh: on sign-in, and whenever the person
  // returns to the main screen or switches tab (covers missed live events).
  async function refreshUnread() {
    try {
      const res = await authedApi("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setNotifUnread(data.unreadCount || 0);
    } catch (_) {}
  }
  useEffect(() => {
    if (token && screen === "main") refreshUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, screen, mainTab]);

  // After sign-in: handle a pending tap, re-sync this device's web push, and
  // (once) invite the person to turn on OS notifications.
  useEffect(() => {
    if (!token) return;
    if (pendingOpenRef.current) {
      const n = pendingOpenRef.current;
      pendingOpenRef.current = null;
      setTimeout(() => openFromNotificationRef.current(n), 300);
    }
    syncWebPush(authedApi);
    const t = setTimeout(() => maybePromptForPush(authedApi, AsyncStorage, PUSH_PROMPT_KEY), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Join/leave the active chat's room as it changes, without touching the
  // underlying socket connection itself.
  useEffect(() => {
    if (!socket || !activeRoom) return;
    setMessages([]);
    setRoomMembers([]);
    setReplyingTo(null);
    socket.emit("join_room", { roomId: activeRoom.id });

    const onRoomState = (state) => {
      setMessages(state.messages || []);
      setRoomMembers(state.members || []);
      pinToBottomRef.current = true;
      clearTimeout(pinTimerRef.current);
      pinTimerRef.current = setTimeout(() => { pinToBottomRef.current = false; }, 1500);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    };
    const onNewMessage = (m) => {
      setMessages((old) => [...old, m]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    };
    const onMembers = (members) => setRoomMembers(members);
    const onErr = (msg) => Alert.alert("Chat", msg);
    // Someone deleted a message: drop it, and blank the quote in any replies that pointed at it.
    const onDeleted = ({ messageId, repliesUpdated = [] }) => {
      setMessages((old) =>
        old
          .filter((m) => m.id !== messageId)
          .map((m) => (repliesUpdated.includes(m.id) && m.replyTo ? { ...m, replyTo: { ...m.replyTo, type: "deleted", text: "" } } : m)),
      );
      setReplyingTo((r) => (r && r.id === messageId ? null : r));
      setActionMsg((a) => (a && a.id === messageId ? null : a));
    };
    const onReaction = ({ messageId, reactions }) =>
      setMessages((old) => old.map((m) => (m.id === messageId ? { ...m, reactions: reactions || [] } : m)));

    socket.on("room_state", onRoomState);
    socket.on("new_message", onNewMessage);
    socket.on("members_changed", onMembers);
    socket.on("error_message", onErr);
    socket.on("message_deleted", onDeleted);
    socket.on("message_reaction", onReaction);

    return () => {
      socket.emit("leave_room", { roomId: activeRoom.id });
      socket.off("message_deleted", onDeleted);
      socket.off("message_reaction", onReaction);
      clearTimeout(pinTimerRef.current);
      pinToBottomRef.current = false;
      socket.off("room_state", onRoomState);
      socket.off("new_message", onNewMessage);
      socket.off("members_changed", onMembers);
      socket.off("error_message", onErr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, activeRoom?.id]);

  // ---- Saved accounts / account switcher ----
  function persistAccounts(list) {
    accountsRef.current = list;
    setAccounts(list);
    AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)).catch(() => {});
  }
  function rememberAccount(tok, user) {
    if (!tok || !user || !user.id) return;
    const list = accountsRef.current;
    const i = list.findIndex((a) => a.user.id === user.id);
    persistAccounts(i >= 0 ? list.map((a, k) => (k === i ? { token: tok, user } : a)) : [...list, { token: tok, user }]);
  }
  function removeAccount(userId) { persistAccounts(accountsRef.current.filter((a) => a.user.id !== userId)); }
  // Keeps the saved copy (name, photo, token) current for whoever is signed in.
  useEffect(() => { if (token && me) rememberAccount(token, me); }, [token, me]);

  function resetSessionState() {
    setActiveRoom(null);
    setActiveVoiceRoom(null);
    setMessages([]);
    setRoomMembers([]);
    setMessage("");
    setNotifUnread(0);
    setNotifOpen(false);
    setIncomingCount(0);
  }

  // Switches to another saved account. Returns true on success.
  async function switchAccount(acct, { silent = false } = {}) {
    if (!acct || !acct.user) return false;
    if (acct.user.id === meRef.current?.id && token) { setAddingAccount(false); setScreen("main"); return true; }
    setLoading(true);
    try {
      const res = await api("/api/me", { headers: { Authorization: `Bearer ${acct.token}` } });
      if (res.status === 401) {
        removeAccount(acct.user.id);
        if (!silent) Alert.alert("Sign in again", `@${acct.user.username} was signed out. Please sign in to that account again.`);
        return false;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not switch account.");
      await AsyncStorage.multiSet([[TOKEN_KEY, acct.token], [USER_KEY, JSON.stringify(data.user)]]);
      resetSessionState();
      setToken(acct.token);
      setMe(data.user);
      setAddingAccount(false);
      setScreen("main");
      setMainTab("home");
      return true;
    } catch (e) {
      if (!silent) Alert.alert("Couldn't switch account", "Check your connection and try again.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  function addAccount() {
    setUsername(""); setPassword(""); setName(""); setInviteCode("");
    setAuthMode("login");
    setAddingAccount(true);
    setScreen("auth");
  }
  function cancelAddAccount() { setAddingAccount(false); setScreen("main"); }

  async function handleExpiredSession() {
    const expiredId = meRef.current?.id;
    if (expiredId) removeAccount(expiredId);
    // Another saved account? Move to it instead of dumping the person at sign-in.
    for (const a of accountsRef.current.filter((x) => x.user.id !== expiredId)) {
      if (await switchAccount(a, { silent: true })) { Alert.alert("Session expired", "That account was signed out. Switched to another saved account."); return; }
    }
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
    setToken(null);
    setMe(null);
    setActiveRoom(null);
    setScreen("auth");
    Alert.alert("Session expired", "Please sign in again.");
  }

  // Wraps api() with the auth header and detects an expired/invalid session
  // (the server replies 401 "Unauthorized" / "User not found" once a token
  // no longer matches a real account). Instead of leaving the app stuck
  // showing that error everywhere, we sign the device out cleanly so the
  // person can log back in.
  async function authedApi(path, options = {}) {
    const res = await api(path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (res.status === 401) {
      await handleExpiredSession();
    }
    return res;
  }

  async function loginOrRegister() {
    if (!username.trim() || !password) {
      return Alert.alert(
        "Missing details",
        "Enter your username and password.",
      );
    }
    if (authMode === "register" && !inviteCode.trim()) {
      return Alert.alert(
        "Invitation required",
        "This app is invite-only. Enter your invitation code.",
      );
    }

    setLoading(true);
    try {
      const endpoint =
        authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        authMode === "login"
          ? { username: username.trim(), password }
          : {
              username: username.trim(),
              password,
              name: name.trim() || username.trim(),
              inviteCode: inviteCode.trim(),
            };

      const res = await api(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok)
        return Alert.alert(
          "Unable to continue",
          data.error || "Something went wrong.",
        );

      await AsyncStorage.setItem(TOKEN_KEY, data.token);
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(data.user));
      resetSessionState();
      setToken(data.token);
      setMe(data.user);
      setAddingAccount(false);
      setPassword("");
      setScreen("main");
      setMainTab("home");
    } catch (e) {
      console.error("Auth request failed:", API_URL, e);
      Alert.alert(
        "Network error",
        `Check that the backend is running and the API URL is correct.\n\nTrying: ${API_URL}`,
      );
    } finally {
      setLoading(false);
    }
  }

  // Rooms fetched fresh from the REST API (e.g. right after creating or
  // accepting one) carry the raw "Direct messages" placeholder name; the
  // rooms LIST endpoint already swaps that for the other person's name, but
  // single-room responses (create/accept/dm) don't, so normalize here too.
  function normalizeRoom(room) {
    if (room?.isDirect && room?.otherUser) {
      return { ...room, name: room.otherUser.name };
    }
    return room;
  }

  function openRoom(room) {
    setActiveRoom(normalizeRoom(room));
    setScreen("chat");
  }

  function closeRoom() {
    setScreen("main");
    setActiveRoom(null);
    setMessages([]);
    setRoomsRefreshKey((k) => k + 1);
  }

  function openVoiceRoom(room) {
    setActiveVoiceRoom(room);
    setScreen("voice");
  }

  function closeVoiceRoom() {
    setScreen("main");
    setActiveVoiceRoom(null);
    setRoomsRefreshKey((k) => k + 1);
  }

  // Opens (or creates) the 1:1 chat with a friend. This is the piece that
  // was previously missing end-to-end: search/discover could see a friend
  // was connected but had no action that actually opened a conversation.
  async function messageFriend(person) {
    try {
      const res = await authedApi(`/api/dm/${person.id}`, { method: "POST" });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Couldn't open chat", data.error || "Something went wrong.");
      openRoom(data.room);
    } catch (_) {
      Alert.alert("Network error", "Could not open the chat.");
    }
  }

  async function sendMessage(type = "text", extra = {}) {
    if (!activeRoom) return;
    if (type === "text" && !message.trim()) return;
    // socket can exist but not be connected yet (still handshaking, mid
    // reconnect, etc). Sending on a dead connection used to look like it
    // worked -- the input cleared -- while the message silently vanished,
    // since a socket that never finishes connecting never delivers queued
    // events. Surface that instead of pretending it went through.
    if (!socket || !socketReady) {
      Alert.alert(
        "Not connected",
        "You're not connected to the chat server right now, so this message wasn't sent. Check your connection and try again.",
      );
      return;
    }

    const text = message.trim();
    const outgoingType = type;
    const replyTarget = replyingTo; // keep a copy so we can put it back if the send fails
    if (replyTarget) setReplyingTo(null);
    // Optimistically clear the box, but put the text back if the server
    // tells us the send failed (or if it times out) so nothing is lost.
    if (outgoingType === "text") setMessage("");

    socket.timeout(8000).emit(
      "send_message",
      { roomId: activeRoom.id, type: outgoingType, text, ...(replyTarget ? { replyToId: replyTarget.id } : {}), ...extra },
      (err, ack) => {
        if (err || !ack?.ok) {
          if (outgoingType === "text") setMessage(text);
          if (replyTarget) setReplyingTo(replyTarget);
          Alert.alert(
            "Message not sent",
            err ? "The server didn't respond in time. Please try again." : ack?.error || "Please try again.",
          );
        }
      },
    );
  }

  // ---- Reply / react / delete ----
  function reactTo(msg, emoji) {
    if (!socket || !socketReady || !activeRoom) return Alert.alert("Not connected", "Check your connection and try again.");
    socket.timeout(8000).emit("react_message", { roomId: activeRoom.id, messageId: msg.id, emoji }, (err, ack) => {
      if (err || !ack?.ok) Alert.alert("Couldn't react", err ? "The server didn't respond in time." : ack?.error || "Please try again.");
    });
  }
  function deleteMsg(msg) {
    if (!socket || !socketReady || !activeRoom) return Alert.alert("Not connected", "Check your connection and try again.");
    socket.timeout(8000).emit("delete_message", { roomId: activeRoom.id, messageId: msg.id }, (err, ack) => {
      if (err || !ack?.ok) Alert.alert("Couldn't delete", err ? "The server didn't respond in time." : ack?.error || "Please try again.");
    });
  }
  function scrollToMessage(id) {
    const index = messages.findIndex((m) => m.id === id);
    if (index >= 0) listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted)
      return Alert.alert(
        "Permission needed",
        "Allow photo access to attach images.",
      );
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.8,
    });
    if (result.canceled) return;
    setUploading(true);
    try {
      const asset = await prepareImage(result.assets[0], 1600);
      const uploaded = await uploadAsset(token, {
        uri: asset.uri,
        fileName: asset.fileName || (asset.type === "video" ? "video.mp4" : "photo.jpg"),
        mimeType: asset.mimeType || (asset.type === "video" ? "video/mp4" : "image/jpeg"),
      });
      await sendMessage("media", {
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        uri: uploaded.url,
        thumbUrl: uploaded.thumbUrl,
        width: uploaded.width || asset.width,
        height: uploaded.height || asset.height,
        size: uploaded.size,
      });
    } catch (e) {
      Alert.alert("Upload failed", e.message || "Could not upload that file.");
    } finally {
      setUploading(false);
    }
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setUploading(true);
    try {
      const uploaded = await uploadAsset(token, {
        uri: file.uri,
        fileName: file.name,
        mimeType: file.mimeType || "application/octet-stream",
      });
      // A picked audio file (song, voice memo, etc.) gets a real inline
      // player bubble instead of a plain "open this file" link -- see
      // pickAudio()/AudioAttachment below.
      const isAudio = (uploaded.mimeType || "").startsWith("audio/");
      await sendMessage(isAudio ? "audio" : "file", {
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        uri: uploaded.url,
        size: uploaded.size,
      });
    } catch (e) {
      Alert.alert("Upload failed", e.message || "Could not upload that file.");
    } finally {
      setUploading(false);
    }
  }

  // Shares an actual audio file (a song you have, a voice note, etc.) that
  // gets uploaded to the backend and rendered as a real play/pause card for
  // both people in the chat -- this is different from the Spotify/Apple
  // Music/etc. "Listen together" link card above, which can only sync a
  // play/pause *flag* and open the track in the provider's own app, since
  // no third-party app is allowed to stream that provider's audio directly.
  // An audio file you actually own has no such restriction, so it plays for
  // real, right here, for both members of the room.
  async function pickAudio() {
    const result = await DocumentPicker.getDocumentAsync({
      type: "audio/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setUploading(true);
    try {
      const uploaded = await uploadAsset(token, {
        uri: file.uri,
        fileName: file.name,
        mimeType: file.mimeType || "audio/mpeg",
      });
      await sendMessage("audio", {
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        uri: uploaded.url,
        size: uploaded.size,
      });
    } catch (e) {
      Alert.alert("Upload failed", e.message || "Could not upload that song.");
    } finally {
      setUploading(false);
    }
  }

  // Shares a link to whatever you're currently playing. There is no way
  // for an app to read what's playing inside a *different* app without a
  async function logout() {
    try { await disableWebPush(authedApi); } catch (_) {}
    // Log out of THIS account only; if another is saved on this device, switch to it.
    const leavingId = meRef.current?.id;
    if (leavingId) removeAccount(leavingId);
    for (const a of accountsRef.current.filter((x) => x.user.id !== leavingId)) {
      if (await switchAccount(a, { silent: true })) return;
    }
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
    socket?.disconnect();
    setToken(null);
    setMe(null);
    setActiveRoom(null);
    setMessages([]);
    setScreen("auth");
  }

  function shareRoomInvite() {
    if (!activeRoom) return;
    Share.share({
      message: `Join me in "${activeRoom.name}" on Hush! Send me your username and I'll add you to the chat.`,
    }).catch(() => {});
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <StatusBar style={C.mode === "light" ? "dark" : "light"} />
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (screen === "auth") {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar style={C.mode === "light" ? "dark" : "light"} />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? 40 : 0}
        >
          <ScrollView
            contentContainerStyle={[styles.center, { flexGrow: 1 }]}
            keyboardShouldPersistTaps="handled"
          >
        <Text style={styles.logo}>Hush</Text>
        <Text style={styles.subtitle}>
          Private chats for people you invite.
        </Text>

        {!addingAccount && accounts.length > 0 && (
          <View style={{ width: "100%", marginBottom: 18 }}>
            <Text style={styles.sectionLabel}>Saved accounts</Text>
            {accounts.map((a) => (
              <Pressable key={a.user.id} style={styles.accountRow} onPress={() => switchAccount(a)}>
                <UserAvatar name={a.user.name} avatarUrl={a.user.avatarUrl} size={38} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.accountName} numberOfLines={1}>{a.user.name}</Text>
                  <Text style={styles.roomInfo} numberOfLines={1}>@{a.user.username}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={C.textMuted} />
              </Pressable>
            ))}
            <Text style={[styles.muted, { textAlign: "center", marginTop: 10 }]}>or sign in to another account</Text>
          </View>
        )}

        {authMode === "register" && (
          <>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor={C.textFaint}
              value={name}
              onChangeText={setName}
            />
            <TextInput
              style={styles.input}
              placeholder="Invitation code"
              placeholderTextColor={C.textFaint}
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
            />
          </>
        )}

        <TextInput
          style={styles.input}
          placeholder="Username"
          placeholderTextColor={C.textFaint}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={C.textFaint}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <Pressable
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
          onPress={loginOrRegister}
        >
          <Text style={styles.buttonText}>
            {authMode === "login" ? "Sign in" : "Create account"}
          </Text>
        </Pressable>

        <Pressable
          onPress={() =>
            setAuthMode(authMode === "login" ? "register" : "login")
          }
        >
          <Text style={styles.link}>
            {authMode === "login"
              ? "Have an invitation? Create account"
              : "Already have an account? Sign in"}
          </Text>
        </Pressable>
        {addingAccount && (
          <Pressable onPress={cancelAddAccount} style={{ marginTop: 14 }}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (screen === "chat" && activeRoom) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style={C.mode === "light" ? "dark" : "light"} />
        <View style={styles.header}>
          <Pressable onPress={closeRoom} hitSlop={10}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <View style={[styles.avatarSm, { backgroundColor: colorFor(activeRoom.name || "C") }]}>
            <Text style={styles.avatarText}>{(activeRoom.name || "C")[0].toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.titleSmall}>{activeRoom.name || "Chat"}</Text>
            <Text style={styles.roomInfo}>
              {activeRoom.isDirect
                ? "Direct message"
                : `${roomMembers.length} member${roomMembers.length === 1 ? "" : "s"}`}
            </Text>
          </View>
          {!activeRoom.isDirect && <ChatHeaderActions room={activeRoom} authedApi={authedApi} onMembersAdded={setRoomMembers} onShare={shareRoomInvite} />}
          <Text style={[styles.live, socketReady && styles.liveOn]}>{socketReady ? "● LIVE" : "○ …"}</Text>
        </View>

        <FlatList
          ref={listRef}
          style={styles.chat}
          data={messages}
          keyExtractor={(item) => item.id}
          initialNumToRender={30}
          onContentSizeChange={() => { if (pinToBottomRef.current) listRef.current?.scrollToEnd({ animated: false }); }}
          onScrollBeginDrag={() => { pinToBottomRef.current = false; }}
          onScrollToIndexFailed={(info) =>
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })
          }
          renderItem={({ item }) => (
            <Pressable
              delayLongPress={350}
              onLongPress={() => setActionMsg(item)}
              style={[styles.message, item.userId === me?.id && styles.myMessage]}
            >
              {item.userId !== me?.id && (
                <View style={styles.postHeader}>
                  <View style={[styles.avatarXs, { backgroundColor: colorFor(item.userName) }]}>
                    <Text style={styles.avatarTextXs}>{item.userName[0].toUpperCase()}</Text>
                  </View>
                  <Text style={styles.messageUser}>{item.userName}</Text>
                </View>
              )}
              {item.replyTo ? (
                <ReplyQuote reply={item.replyTo} meId={me?.id} onMine={item.userId === me?.id} onPress={() => scrollToMessage(item.replyTo.id)} />
              ) : null}
              <MessageBody item={item} isMe={item.userId === me?.id} />
              <View style={styles.bubbleFooter}>
                <Pressable hitSlop={10} onPress={() => setActionMsg(item)}>
                  <Ionicons name="ellipsis-horizontal" size={16} color={item.userId === me?.id ? "rgba(255,255,255,0.7)" : C.textFaint} />
                </Pressable>
                <Text style={[styles.time, item.userId === me?.id && styles.myTime, { marginTop: 0 }]}>
                  {new Date(item.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              </View>
              <ReactionChips reactions={item.reactions} meId={me?.id} onMine={item.userId === me?.id} onToggle={(emoji) => reactTo(item, emoji)} />
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No messages yet. Start the conversation.
            </Text>
          }
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {replyingTo ? (
            <View style={styles.replyBar}>
              <View style={{ flex: 1 }}>
                <Text style={styles.replyBarName} numberOfLines={1}>
                  Replying to {replyingTo.userId === me?.id ? "yourself" : replyingTo.userName}
                </Text>
                <Text style={styles.replyBarText} numberOfLines={1}>{quoteText(replyingTo)}</Text>
              </View>
              <Pressable onPress={() => setReplyingTo(null)} hitSlop={10}>
                <Ionicons name="close" size={20} color={C.textMuted} />
              </Pressable>
            </View>
          ) : null}
          <View style={styles.attachRow}>
            <Pressable style={styles.plusButton} onPress={toggleAttachMenu} disabled={uploading} hitSlop={6}>
              {uploading ? (
                <ActivityIndicator size="small" color={C.white} />
              ) : (
                <Animated.Text
                  style={[
                    styles.plusIcon,
                    {
                      transform: [
                        {
                          rotate: attachAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0deg", "45deg"],
                          }),
                        },
                      ],
                    },
                  ]}
                >
                  +
                </Animated.Text>
              )}
            </Pressable>
            <Animated.View
              pointerEvents={attachOpen ? "auto" : "none"}
              style={[
                styles.attachOptionsRow,
                {
                  width: attachAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 148] }),
                  opacity: attachAnim,
                },
              ]}
            >
              <Pressable style={styles.attachOption} onPress={() => pickWith(pickPhoto)}>
                <Ionicons name="image-outline" size={19} color={C.text} />
              </Pressable>
              <Pressable style={styles.attachOption} onPress={() => pickWith(pickFile)}>
                <Ionicons name="attach-outline" size={19} color={C.text} />
              </Pressable>
              <Pressable style={styles.attachOption} onPress={() => pickWith(pickAudio)}>
                <Ionicons name="musical-notes-outline" size={19} color={C.text} />
              </Pressable>
            </Animated.View>
            <TextInput
              style={styles.messageInput}
              value={message}
              onChangeText={setMessage}
              placeholder="Message…"
              placeholderTextColor={C.textFaint}
              onSubmitEditing={() => sendMessage("text")}
              onFocus={closeAttachMenu}
              returnKeyType="send"
            />
            <Pressable style={styles.send} onPress={() => sendMessage("text")}>
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
        <MessageActions
          message={actionMsg}
          meId={me?.id}
          onClose={() => setActionMsg(null)}
          onReact={(emoji) => actionMsg && reactTo(actionMsg, emoji)}
          onReply={() => actionMsg && setReplyingTo(actionMsg)}
          onDelete={() => actionMsg && setDeleteTarget(actionMsg)}
        />
        <ActionSheet
          visible={!!deleteTarget}
          title="Delete this message for everyone?"
          actions={[{ label: "Delete for everyone", icon: "trash-outline", destructive: true, onPress: () => deleteTarget && deleteMsg(deleteTarget) }]}
          onClose={() => setDeleteTarget(null)}
        />
      </SafeAreaView>
    );
  }

  if (screen === "voice" && activeVoiceRoom) {
    return (
      <VoiceRoomScreen
        room={activeVoiceRoom}
        socket={socket}
        socketReady={socketReady}
        me={me}
        onClose={closeVoiceRoom}
      />
    );
  }

  // Main app: an Instagram-style bottom tab bar with a screen per tab.
  // edges omits "bottom" here because TabBar already reserves its own
  // bottom safe-area space (see styles.tabBar's paddingBottom) -- adding it
  // twice would leave a visible gap under the tab bar.
  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <StatusBar style={C.mode === "light" ? "dark" : "light"} />
      <ScrollChromeContext.Provider value={chromeValue}>
      <View style={{ flex: 1 }}>
        {mainTab === "home" && <HomeTab authedApi={authedApi} token={token} me={me} unread={notifUnread} refreshKey={homeRefreshKey} onOpenNotifications={() => setNotifOpen(true)} />}
        {mainTab === "chats" && (
          <ChatsTab
            authedApi={authedApi}
            onOpen={openRoom}
            onOpenVoice={openVoiceRoom}
            refreshKey={roomsRefreshKey}
            unread={notifUnread}
            onOpenNotifications={() => setNotifOpen(true)}
          />
        )}
        {mainTab === "discover" && (
          <DiscoverTab
            authedApi={authedApi}
            onMessage={messageFriend}
            onOpenRoom={openRoom}
            onIncomingCountChange={setIncomingCount}
          />
        )}
        {mainTab === "profile" && (
          <ProfileTab
            me={me}
            token={token}
            authedApi={authedApi}
            onLogout={logout}
            accounts={accounts}
            onSwitchAccount={switchAccount}
            onAddAccount={addAccount}
            onUpdateMe={setMe}
            themeMode={themeMode}
            onChangeTheme={changeThemeMode}
          />
        )}
      </View>
      </ScrollChromeContext.Provider>
      <TabBar active={mainTab} onChange={setMainTab} incomingCount={incomingCount} hide={tabHide} hidden={tabsHidden} onReveal={() => setTabsHidden(false)} />
      <NotificationsModal
        visible={notifOpen}
        authedApi={authedApi}
        onClose={() => { setNotifOpen(false); refreshUnread(); }}
        onUnreadChange={setNotifUnread}
        onOpenItem={(n) => { setNotifOpen(false); openFromNotification(n); }}
        onRequestHandled={() => setRoomsRefreshKey((k) => k + 1)}
        onStoryAdded={() => setHomeRefreshKey((k) => k + 1)}
      />
    </SafeAreaView>
  );
}

// ---- Reply / react helpers ----
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// One-line description of a message (or of the snapshot stored inside a reply).
function quoteText(m) {
  if (!m) return "";
  if (m.type === "deleted") return "This message was deleted";
  if (m.type === "text") return m.text || "";
  if (m.type === "music") return `♫ ${m.title || m.text || "Shared track"}`;
  const mime = m.mimeType || "";
  if (m.type === "audio" || mime.startsWith("audio/")) return "🎧 Audio";
  if (mime.startsWith("image/")) return "📷 Photo";
  if (mime.startsWith("video/")) return "🎬 Video";
  return `📎 ${m.fileName || "File"}`;
}

// The small quoted block shown at the top of a reply bubble. Tap to jump to the original.
function ReplyQuote({ reply, meId, onMine, onPress }) {
  const deleted = reply.type === "deleted";
  return (
    <Pressable onPress={deleted ? undefined : onPress} style={[styles.quote, onMine && styles.quoteMine]}>
      <Text style={[styles.quoteName, onMine && { color: C.white }]} numberOfLines={1}>
        {reply.userId === meId ? "You" : reply.userName}
      </Text>
      <Text style={[styles.quoteText, onMine && { color: "rgba(255,255,255,0.85)" }, deleted && { fontStyle: "italic" }]} numberOfLines={2}>
        {quoteText(reply)}
      </Text>
    </Pressable>
  );
}

// Reactions under a bubble, grouped by emoji with a count. Tap a chip to react the same way / remove yours.
function ReactionChips({ reactions, meId, onMine, onToggle }) {
  if (!Array.isArray(reactions) || !reactions.length) return null;
  const groups = [];
  for (const r of reactions) {
    const g = groups.find((x) => x.emoji === r.emoji);
    if (g) { g.count += 1; if (r.userId === meId) g.mine = true; }
    else groups.push({ emoji: r.emoji, count: 1, mine: r.userId === meId });
  }
  return (
    <View style={styles.reactionRow}>
      {groups.map((g) => (
        <Pressable key={g.emoji} onPress={() => onToggle(g.emoji)} style={[styles.reactionChip, onMine && styles.reactionChipOnMine, g.mine && styles.reactionChipMine]}>
          <Text style={styles.reactionEmoji}>{g.emoji}</Text>
          {g.count > 1 ? <Text style={styles.reactionCount}>{g.count}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

// Long-press (or "..." button) menu for a message: pick an emoji, reply, or delete your own.
function MessageActions({ message, meId, onClose, onReact, onReply, onDelete }) {
  if (!message) return null;
  const mine = message.userId === meId;
  const myReaction = (message.reactions || []).find((r) => r.userId === meId)?.emoji;
  const danger = C.danger || "#E5484D";
  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.modalSheet, { paddingBottom: 24 }]} onPress={() => {}}>
          <View style={styles.emojiRow}>
            {REACTION_EMOJIS.map((e) => (
              <Pressable key={e} onPress={() => { onClose(); onReact(e); }} style={[styles.emojiBtn, myReaction === e && styles.emojiBtnActive]}>
                <Text style={styles.emojiText}>{e}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.sheetRow} onPress={() => { onClose(); onReply(); }}>
            <Ionicons name="arrow-undo-outline" size={20} color={C.text} />
            <Text style={styles.sheetRowText}>Reply</Text>
          </Pressable>
          {mine ? (
            <Pressable style={styles.sheetRow} onPress={() => { onClose(); onDelete(); }}>
              <Ionicons name="trash-outline" size={20} color={danger} />
              <Text style={[styles.sheetRowText, { color: danger }]}>Delete</Text>
            </Pressable>
          ) : null}
          <Pressable style={[styles.sheetRow, { justifyContent: "center", marginTop: 4 }]} onPress={onClose}>
            <Text style={[styles.sheetRowText, { color: C.textMuted }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Renders a message's content by type. Media (photos/videos) render inline
// instead of as a raw filename + link, since the attachment is now a real
// hosted URL rather than a sender-only local file path.
function MessageBody({ item, isMe }) {
  if (item.type === "music") {
    return (
      <Pressable onPress={() => Linking.openURL(item.url)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {item.thumbnail ? <Image source={{ uri: item.thumbnail }} style={styles.musicThumbSm} /> : null}
          <View style={{ flex: 1 }}>
            <Text style={[styles.musicShare, isMe && styles.myMessageText]}>♫ {item.title || "Shared track"}</Text>
            {item.artist ? <Text style={[styles.artistInline, isMe && styles.myMessageText]}>{item.artist}</Text> : null}
            <Text style={[styles.link, isMe && styles.myMessageText]}>Open ↗</Text>
          </View>
        </View>
      </Pressable>
    );
  }
  if (item.type === "media") {
    return <MediaAttachment uri={item.uri} thumbUrl={item.thumbUrl} width={item.width} height={item.height} mimeType={item.mimeType} fileName={item.fileName} />;
  }
  if (item.type === "audio") {
    return <AudioAttachment uri={item.uri} fileName={item.fileName} isMe={isMe} />;
  }
  if (item.type === "file") {
    return (
      <Pressable onPress={() => item.uri && Linking.openURL(item.uri)}>
        <Text style={[styles.messageText, isMe && styles.myMessageText]}>
          📎 {item.fileName || "File"}
          {item.size ? ` · ${Math.round(item.size / 1024)} KB` : ""}
        </Text>
      </Pressable>
    );
  }
  return <Text style={[styles.messageText, isMe && styles.myMessageText]}>{item.text}</Text>;
}

// Inline photo/video rendering. Videos use expo-video's VideoView with a
// muted, non-autoplaying player -- tapping it plays inline instead of
// bouncing out to a browser.
function MediaAttachment({ uri, thumbUrl, width, height, mimeType, fileName }) {
  const isVideo = (mimeType || "").startsWith("video/");
  const player = useVideoPlayer(isVideo ? uri : null, (p) => {
    if (p) { p.loop = false; p.muted = false; }
  });

  if (!uri) {
    return <Text style={styles.messageText}>{fileName || "Attachment"}</Text>;
  }
  if (isVideo) {
    return (
      <VideoView
        style={styles.mediaVideo}
        player={player}
        allowsFullscreen
        allowsPictureInPicture
        nativeControls
      />
    );
  }
  return (
    <AdaptiveImage
      uri={thumbUrl || uri}
      knownRatio={width && height ? width / height : undefined}
      maxWidth={Math.min(260, SCREEN_WIDTH * 0.62)}
      maxHeight={320}
      minHeight={120}
      style={styles.mediaImage}
      onPress={() => Linking.openURL(uri)}
    />
  );
}

// Real, in-app playback for an audio file someone actually shared (as
// opposed to the "Listen together" card, which only syncs a play/pause flag
// for a Spotify/Apple Music/etc. link -- see the note on pickAudio()).
// expo-video's player also drives plain audio sources, so this reuses it
// without needing a visible video surface: just a play/pause button plus a
// live progress bar, kept in sync via the player's own status events.
function AudioAttachment({ uri, fileName, isMe }) {
  const player = useVideoPlayer(uri || null, (p) => {
    if (p) p.loop = false;
  });
  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player?.playing || false });
  const [progress, setProgress] = useState(0);

  // expo-video doesn't push per-frame progress as an event, so poll the
  // player's own currentTime/duration while this bubble is playing -- cheap,
  // and it stops the moment playback pauses or the bubble unmounts.
  useEffect(() => {
    if (!isPlaying || !player) return;
    const t = setInterval(() => {
      const dur = player.duration || 0;
      setProgress(dur > 0 ? Math.min(1, player.currentTime / dur) : 0);
    }, 250);
    return () => clearInterval(t);
  }, [isPlaying, player]);

  if (!uri) {
    return <Text style={[styles.messageText, isMe && styles.myMessageText]}>{fileName || "Audio"}</Text>;
  }

  function toggle() {
    if (isPlaying) {
      player.pause();
    } else {
      const dur = player.duration || 0;
      if (dur > 0 && player.currentTime >= dur - 0.25) {
        player.currentTime = 0;
        setProgress(0);
      }
      player.play();
    }
  }

  return (
    <View style={styles.audioCard}>
      <Pressable style={styles.audioPlayBtn} onPress={toggle}>
        <Text style={styles.audioPlayText}>{isPlaying ? "Ⅱ" : "▶"}</Text>
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={[styles.musicShare, isMe && styles.myMessageText]} numberOfLines={1}>
          🎵 {fileName || "Audio"}
        </Text>
        <View style={styles.audioTrack}>
          <View style={[styles.audioTrackFill, { width: `${progress * 100}%` }]} />
        </View>
      </View>
    </View>
  );
}

function TabBar({ active, onChange, incomingCount, hide, hidden, onReveal }) {
  const insets = useSafeAreaInsets();
  const tabs = [
    { key: "home", label: "Home", icon: "home-outline", iconActive: "home" },
    { key: "chats", label: "Chats", icon: "chatbubble-outline", iconActive: "chatbubble" },
    { key: "discover", label: "Discover", icon: "search-outline", iconActive: "search" },
    { key: "profile", label: "Profile", icon: "person-outline", iconActive: "person" },
  ];
  const bottom = Math.max(insets.bottom, 10) + 6;
  const translateY = hide.interpolate({ inputRange: [0, 1], outputRange: [0, 140] });
  return (
    <>
      <Animated.View pointerEvents={hidden ? "none" : "box-none"} style={[styles.tabPillWrap, { bottom, transform: [{ translateY }] }]}>
        <View style={styles.tabPill}>
          {tabs.map((tab) => {
            const isActive = active === tab.key;
            return (
              <Pressable key={tab.key} accessibilityLabel={tab.label} style={[styles.tabPillItem, isActive && styles.tabPillItemActive]} onPress={() => onChange(tab.key)}>
                <View>
                  <Ionicons name={isActive ? tab.iconActive : tab.icon} size={25} color={isActive ? C.text : C.textMuted} />
                  {tab.key === "discover" && incomingCount > 0 && <View style={styles.tabBadge} />}
                </View>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>
      {/* While the bar is tucked away, this little handle brings it back. */}
      <Animated.View pointerEvents={hidden ? "box-none" : "none"} style={[styles.tabHandleWrap, { bottom: Math.max(insets.bottom, 6) + 2, opacity: hide }]}>
        <Pressable onPress={onReveal} hitSlop={{ top: 14, bottom: 14, left: 40, right: 40 }} accessibilityLabel="Show tabs">
          <View style={styles.tabHandle} />
        </Pressable>
      </Animated.View>
    </>
  );
}

// Lets someone already in a room search for a username and add them --
// this is the "sharing" step that was previously missing from the UI even
// though the backend already supported it.
function AddPeopleModal({ visible, onClose, room, authedApi, onMembersAdded }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setResults([]);
    }
  }, [visible]);

  async function search() {
    if (!query.trim()) return;
    const res = await authedApi(`/api/users/search?q=${encodeURIComponent(query.trim())}`);
    if (res.status === 401) return;
    const data = await res.json();
    setResults(data.users || []);
  }

  async function addPerson(person) {
    setBusyId(person.id);
    try {
      const res = await authedApi(`/api/rooms/${room.id}/invite`, {
        method: "POST",
        body: JSON.stringify({ username: person.username }),
      });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Couldn't add", data.error || "Something went wrong.");
      onMembersAdded?.(data.room.members || []);
      Alert.alert("Added", `${person.name} can now see this chat.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
          <View style={styles.modalHeaderRow}>
            <Text style={styles.titleSmall}>Add people</Text>
            <Pressable onPress={onClose} hitSlop={10}><Text style={styles.back}>×</Text></Pressable>
          </View>
          <View style={styles.searchBox}>
            <TextInput
              style={styles.inputInline}
              value={query}
              onChangeText={setQuery}
              placeholder="Search by username"
              placeholderTextColor={C.textFaint}
              autoCapitalize="none"
              onSubmitEditing={search}
              returnKeyType="search"
            />
            <Pressable style={styles.smallButton} onPress={search}><Text style={styles.buttonText}>Find</Text></Pressable>
          </View>
          <FlatList
            data={results}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <View style={styles.roomCard}>
                <UserAvatar name={item.name} avatarUrl={item.avatarUrl} thumbUrl={item.avatarThumbUrl} size={48} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.roomTitle}>{item.name}</Text>
                  <Text style={styles.roomInfo}>@{item.username}</Text>
                </View>
                <Pressable
                  style={[styles.smallButton, busyId === item.id && styles.smallButtonMuted]}
                  disabled={busyId === item.id}
                  onPress={() => addPerson(item)}
                >
                  <Text style={[styles.buttonText, busyId === item.id && styles.smallButtonMutedText]}>{busyId === item.id ? "…" : "Add"}</Text>
                </Pressable>
              </View>
            )}
            ListEmptyComponent={query.trim() ? <Text style={styles.empty}>No one matches "{query}".</Text> : null}
          />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ChatHeaderActions({ room, authedApi, onMembersAdded, onShare }) {
  const [modalVisible, setModalVisible] = useState(false);
  return (
    <>
      <Pressable style={styles.iconButtonSm} onPress={onShare} hitSlop={8}>
        <Text style={styles.icon}>↗</Text>
      </Pressable>
      <Pressable style={styles.iconButtonSm} onPress={() => setModalVisible(true)} hitSlop={8}>
        <Text style={styles.icon}>＋</Text>
      </Pressable>
      <AddPeopleModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        room={room}
        authedApi={authedApi}
        onMembersAdded={onMembersAdded}
      />
    </>
  );
}

function ChatsTab({ authedApi, onOpen, onOpenVoice, refreshKey, unread = 0, onOpenNotifications }) {
  const chrome = useContext(ScrollChromeContext);
  const [subTab, setSubTab] = useState("direct"); // direct | rooms | voice
  const [rooms, setRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [addPeopleFor, setAddPeopleFor] = useState(null);

  async function refresh() {
    setLoadingRooms(true);
    try {
      const res = await authedApi("/api/rooms");
      if (res.status === 401) return;
      const data = await res.json();
      setRooms(data.rooms || []);
    } finally {
      setLoadingRooms(false);
    }
  }
  useEffect(() => { refresh(); }, [refreshKey]);

  async function createRoom() {
    if (creating) return;
    const isVoice = subTab === "voice";
    setCreating(true);
    try {
      const res = await authedApi("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName.trim() || (isVoice ? "New voice room" : "New chat"), isVoice }),
      });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert(isVoice ? "Could not create voice room" : "Could not create chat", data.error || "Something went wrong.");
      setRoomName("");
      await refresh();
      // Immediately offer the sharing step -- creating a room with nobody
      // in it besides yourself was the original bug.
      setAddPeopleFor(data.room);
    } catch (_) {
      Alert.alert("Network error", isVoice ? "Could not create the voice room." : "Could not create the chat.");
    } finally {
      setCreating(false);
    }
  }

  const directRooms = rooms.filter((r) => r.isDirect);
  const groupRooms = rooms.filter((r) => !r.isDirect && !r.isVoice);
  const voiceRooms = rooms.filter((r) => r.isVoice);
  const list = subTab === "direct" ? directRooms : subTab === "voice" ? voiceRooms : groupRooms;

  function openItem(item) {
    if (item.isVoice) onOpenVoice(item);
    else onOpen(item);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, styles.profileHeaderRow]}>
        <Text style={styles.titleSmall}>Chats</Text>
        <Pressable style={styles.gearButton} onPress={onOpenNotifications} hitSlop={8}>
          <Ionicons name={unread > 0 ? "notifications" : "notifications-outline"} size={19} color={C.text} />
          {unread > 0 && (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>{unread > 99 ? "99+" : unread}</Text>
            </View>
          )}
        </Pressable>
      </View>

      <View style={styles.segmented}>
        <Pressable style={[styles.segment, subTab === "direct" && styles.segmentActive]} onPress={() => setSubTab("direct")}>
          <Text style={[styles.segmentText, subTab === "direct" && styles.segmentTextActive]} numberOfLines={1}>Direct</Text>
        </Pressable>
        <Pressable style={[styles.segment, subTab === "rooms" && styles.segmentActive]} onPress={() => setSubTab("rooms")}>
          <Text style={[styles.segmentText, subTab === "rooms" && styles.segmentTextActive]} numberOfLines={1}>Rooms</Text>
        </Pressable>
        <Pressable style={[styles.segment, subTab === "voice" && styles.segmentActive]} onPress={() => setSubTab("voice")}>
          <Text style={[styles.segmentText, subTab === "voice" && styles.segmentTextActive]} numberOfLines={1}>Voice Room</Text>
        </Pressable>
      </View>

      {(subTab === "rooms" || subTab === "voice") && (
        <View style={styles.createBox}>
          <TextInput
            style={styles.inputInline}
            value={roomName}
            onChangeText={setRoomName}
            placeholder={subTab === "voice" ? "New voice room name" : "New room name"}
            placeholderTextColor={C.textFaint}
          />
          <Pressable style={[styles.smallButton, creating && styles.smallButtonMuted]} disabled={creating} onPress={createRoom}>
            <Text style={[styles.buttonText, creating && styles.smallButtonMutedText]}>{creating ? "…" : "New"}</Text>
          </Pressable>
        </View>
      )}

      {loadingRooms ? (
        <ActivityIndicator style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(r) => r.id}
          onScroll={chrome.onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: 16, paddingBottom: 16 + TAB_SPACE }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.roomCard, pressed && { opacity: 0.8 }]}
              onPress={() => openItem(item)}
            >
              {item.isDirect && item.otherUser?.avatarUrl ? (
                <UserAvatar name={item.name} avatarUrl={item.otherUser.avatarUrl} thumbUrl={item.otherUser.avatarThumbUrl} size={48} />
              ) : (
              <View style={[styles.avatar, { backgroundColor: colorFor(item.name || "C") }]}>
                {item.isVoice ? (
                  <Ionicons name="mic" size={18} color={C.white} />
                ) : (
                  <Text style={styles.avatarText}>{(item.name || "C")[0].toUpperCase()}</Text>
                )}
              </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.roomTitle}>{item.name}</Text>
                <Text style={styles.roomInfo} numberOfLines={1}>
                  {item.isVoice
                    ? `${item.memberCount} member(s) · tap to join`
                    : item.lastMessage
                    ? `${item.lastMessage.userName}: ${item.lastMessage.type === "text" ? item.lastMessage.text : "sent an attachment"}`
                    : item.isDirect
                    ? "Say hi 👋"
                    : `${item.memberCount} member(s)`}
                </Text>
              </View>
              <Text style={styles.back}>›</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {subTab === "direct"
                ? "No direct messages yet. Add a friend in Discover, then tap Message."
                : subTab === "voice"
                ? "No voice rooms yet. Create one above, then add people to it."
                : "No rooms yet. Create one above, then add people to it."}
            </Text>
          }
        />
      )}

      {addPeopleFor && (
        <AddPeopleModal
          visible={Boolean(addPeopleFor)}
          onClose={() => setAddPeopleFor(null)}
          room={addPeopleFor}
          authedApi={authedApi}
          onMembersAdded={() => {}}
        />
      )}
    </View>
  );
}

// Voice Room: a live, joinable audio room shown alongside Direct and
// Rooms in Chats. Presence (who's in the room, muted/sharing state) is
// tracked live over the socket (see voice_join/voice_update on the
// server). Actually mixing and transmitting everyone's microphone audio
// requires real-time media infrastructure (WebRTC + TURN/STUN servers) --
// out of scope for this Socket.io/REST backend -- so this screen handles
// the parts that work today: requesting mic permission, a mute toggle
// visible to the room, and a "sharing audio" flag other members can see.
// True system-wide audio capture (grabbing whatever's playing in another
// app) additionally isn't something iOS or Android allow a normal app to
// do without a native broadcast extension (ReplayKit on iOS,
// MediaProjection on Android), so "sharing audio" here is an honest status
// flag, not a live feed of your phone's audio.
function VoiceRoomScreen({ room, socket, socketReady, me, onClose }) {
  const [participants, setParticipants] = useState([]);
  const [muted, setMuted] = useState(true); // joins muted, like most voice apps
  const [sharingAudio, setSharingAudio] = useState(false);
  const [micGranted, setMicGranted] = useState(false);
  const [joining, setJoining] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await AudioModule.requestRecordingPermissionsAsync();
        if (!cancelled) setMicGranted(Boolean(result?.granted));
      } catch (_) {
        if (!cancelled) setMicGranted(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!socket || !socketReady || !room?.id) return;
    socket.emit("voice_join", { roomId: room.id });
    const onParticipants = (list) => { setParticipants(list || []); setJoining(false); };
    const onErr = (msg) => Alert.alert("Voice room", msg);
    socket.on("voice_participants", onParticipants);
    socket.on("error_message", onErr);
    return () => {
      socket.emit("voice_leave", { roomId: room.id });
      socket.off("voice_participants", onParticipants);
      socket.off("error_message", onErr);
    };
  }, [socket, socketReady, room?.id]);

  function toggleMute() {
    if (!micGranted) {
      return Alert.alert(
        "Microphone access needed",
        "Allow microphone access in your device Settings to unmute and talk in this voice room.",
      );
    }
    const next = !muted;
    setMuted(next);
    socket?.emit("voice_update", { roomId: room.id, muted: next });
  }

  function toggleShareAudio() {
    const next = !sharingAudio;
    setSharingAudio(next);
    socket?.emit("voice_update", { roomId: room.id, sharingAudio: next });
    if (next) {
      Alert.alert(
        "Sharing audio",
        "Everyone here can now see you're sharing audio. Phones don't let apps pull in another app's system audio directly, so this shows as a status to the room rather than streaming your device's sound.",
      );
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style={C.mode === "light" ? "dark" : "light"} />
      <View style={styles.header}>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View style={[styles.avatarSm, { backgroundColor: colorFor(room.name || "V") }]}>
          <Ionicons name="mic" size={16} color={C.white} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.titleSmall}>{room.name || "Voice room"}</Text>
          <Text style={styles.roomInfo}>{participants.length} in the room</Text>
        </View>
      </View>

      {joining ? (
        <ActivityIndicator style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={participants}
          keyExtractor={(p) => p.userId}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <View style={styles.roomCard}>
              <View style={[styles.avatar, { backgroundColor: colorFor(item.name) }]}>
                <Text style={styles.avatarText}>{(item.name || "?")[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.roomTitle}>{item.name}{item.userId === me?.id ? " (you)" : ""}</Text>
                <Text style={styles.roomInfo}>
                  {item.muted ? "Mic muted" : "Mic live"}{item.sharingAudio ? " · Sharing audio" : ""}
                </Text>
              </View>
              <Ionicons name={item.muted ? "mic-off" : "mic"} size={18} color={item.muted ? C.textFaint : C.accent} />
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>You're the first one here.</Text>}
        />
      )}

      <View style={styles.attachRow}>
        <Pressable style={[styles.iconButton, !muted && { backgroundColor: C.accent }]} onPress={toggleMute}>
          <Ionicons name={muted ? "mic-off" : "mic"} size={20} color={muted ? C.text : C.white} />
        </Pressable>
        <Pressable style={[styles.smallButton, sharingAudio && { backgroundColor: C.accent }, { flex: 1 }]} onPress={toggleShareAudio}>
          <Text style={styles.buttonText}>{sharingAudio ? "Stop sharing audio" : "Share audio"}</Text>
        </Pressable>
        <Pressable style={styles.send} onPress={onClose}>
          <Text style={styles.buttonText}>Leave</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function DiscoverTab({ authedApi, onMessage, onOpenRoom, onIncomingCountChange }) {
  const chrome = useContext(ScrollChromeContext);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [sentTo, setSentTo] = useState({});
  const [acceptingId, setAcceptingId] = useState(null);

  const load = async () => {
    const res = await authedApi("/api/friends/requests");
    if (res.status === 401) return;
    const data = await res.json();
    setIncoming(data.incoming || []);
    onIncomingCountChange?.((data.incoming || []).length);
  };
  useEffect(() => { load().catch(() => Alert.alert("Could not load", "Check that the backend is reachable.")); }, []);

  async function findPeople() {
    if (!query.trim()) return;
    const res = await authedApi(`/api/users/search?q=${encodeURIComponent(query.trim())}`);
    if (res.status === 401) return;
    const data = await res.json();
    setPeople(data.users || []);
  }
  async function request(person) {
    const res = await authedApi("/api/friends/requests", {
      method: "POST",
      body: JSON.stringify({ userId: person.id, username: person.username }),
    });
    if (res.status === 401) return;
    const data = await res.json();
    if (!res.ok) return Alert.alert("Couldn't send request", data.error || "Something went wrong.");
    setSentTo((old) => ({ ...old, [person.id]: true }));
  }
  async function decline(requestId) {
    try {
      const res = await authedApi(`/api/friends/requests/${requestId}/decline`, { method: "POST" });
      if (res.status === 401) return;
      setIncoming((old) => {
        const next = old.filter((i) => i.id !== requestId);
        onIncomingCountChange?.(next.length);
        return next;
      });
    } catch (_) { Alert.alert("Network error", "Check your connection and try again."); }
  }
  async function accept(requestId) {
    setAcceptingId(requestId);
    try {
      const res = await authedApi(`/api/friends/requests/${requestId}/accept`, { method: "POST" });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Couldn't accept", data.error || "Something went wrong.");
      setIncoming((old) => {
        const next = old.filter((i) => i.id !== requestId);
        onIncomingCountChange?.(next.length);
        return next;
      });
      onOpenRoom(data.room);
    } finally {
      setAcceptingId(null);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.titleSmall}>Discover</Text>
      </View>
      <FlatList
        onScroll={chrome.onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 16 + TAB_SPACE }}
        ListHeaderComponent={
          <>
            <View style={styles.searchBox}>
              <TextInput style={styles.inputInline} value={query} onChangeText={setQuery} placeholder="Find a username" placeholderTextColor={C.textFaint} autoCapitalize="none" onSubmitEditing={findPeople} returnKeyType="search" />
              <Pressable style={styles.smallButton} onPress={findPeople}><Text style={styles.buttonText}>Find</Text></Pressable>
            </View>
            {people.map((person) => (
              <View key={person.id} style={styles.roomCard}>
                <UserAvatar name={person.name} avatarUrl={person.avatarUrl} thumbUrl={person.avatarThumbUrl} size={48} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.roomTitle}>{person.name}</Text>
                  <Text style={styles.roomInfo}>@{person.username}</Text>
                </View>
                {person.connected ? (
                  <Pressable style={styles.smallButton} onPress={() => onMessage(person)}>
                    <Text style={styles.buttonText}>Message</Text>
                  </Pressable>
                ) : (
                  <Pressable style={[styles.smallButton, sentTo[person.id] && styles.smallButtonMuted]} disabled={sentTo[person.id]} onPress={() => request(person)}>
                    <Text style={[styles.buttonText, sentTo[person.id] && styles.smallButtonMutedText]}>{sentTo[person.id] ? "Sent" : "Request"}</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {people.length === 0 && query.trim().length > 0 && <Text style={styles.empty}>No one matches "{query}" yet.</Text>}

            {incoming.length > 0 && <Text style={styles.sectionLabel}>Requests</Text>}
            {incoming.map((item) => (
              <View key={item.id} style={styles.roomCard}>
                <UserAvatar name={item.from?.name} avatarUrl={item.from?.avatarUrl} thumbUrl={item.from?.avatarThumbUrl} size={48} />
                <Text style={[styles.messageText, { flex: 1 }]}>@{item.from?.username} wants to connect</Text>
                <Pressable style={[styles.smallButton, styles.smallButtonMuted]} disabled={acceptingId === item.id} onPress={() => decline(item.id)}>
                  <Text style={[styles.buttonText, styles.smallButtonMutedText]}>Decline</Text>
                </Pressable>
                <Pressable style={[styles.smallButton, acceptingId === item.id && styles.smallButtonMuted]} disabled={acceptingId === item.id} onPress={() => accept(item.id)}>
                  <Text style={[styles.buttonText, acceptingId === item.id && styles.smallButtonMutedText]}>{acceptingId === item.id ? "…" : "Accept"}</Text>
                </Pressable>
              </View>
            ))}
          </>
        }
        data={[]}
        keyExtractor={(item) => item.id}
        renderItem={() => null}
        ListEmptyComponent={incoming.length === 0 && people.length === 0 ? <Text style={styles.empty}>Search for a username to send a friend request.</Text> : null}
      />
    </View>
  );
}

// Renders a user's avatar as their uploaded photo if they have one, else a
// deterministically-colored circle with their initial -- used everywhere a
// post or profile needs an avatar so photo vs. initials never has to be
// handled twice.
function UserAvatar({ name, avatarUrl, thumbUrl, size = 38, style }) {
  const dim = { width: size, height: size, borderRadius: size / 2 };
  // Small avatars use the 128px thumbnail (a few KB) instead of the full photo.
  const src = size <= 64 ? thumbUrl || avatarUrl : avatarUrl;
  // If the photo fails to load (deleted file, offline), show the initial
  // instead of a blank circle.
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (src && !failed) {
    return <Image source={{ uri: src }} style={[styles.avatarSm, dim, style]} onError={() => setFailed(true)} />;
  }
  return (
    <View style={[styles.avatarSm, dim, { backgroundColor: colorFor(name || "?"), alignItems: "center", justifyContent: "center" }, style]}>
      <Text style={[styles.avatarTextXs, { fontSize: size * 0.4 }]}>{(name || "?")[0].toUpperCase()}</Text>
    </View>
  );
}

// Simple bottom sheet of actions. Alert.alert with 3 buttons can't work on
// the web build (it collapses to window.confirm and only ever reaches the
// first button), so post options use this real modal on every platform.
function ActionSheet({ visible, title, actions, onClose }) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={[styles.modalSheet, { paddingBottom: 24 }]} onPress={() => {}}>
          {!!title && <Text style={[styles.roomInfo, { textAlign: "center", marginBottom: 10 }]}>{title}</Text>}
          {actions.map((a) => (
            <Pressable key={a.label} style={styles.sheetRow} onPress={() => { onClose(); a.onPress && a.onPress(); }}>
              {!!a.icon && <Ionicons name={a.icon} size={20} color={a.destructive ? C.danger || "#E5484D" : C.text} />}
              <Text style={[styles.sheetRowText, a.destructive && { color: C.danger || "#E5484D" }]}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable style={[styles.sheetRow, { justifyContent: "center", marginTop: 4 }]} onPress={onClose}>
            <Text style={[styles.sheetRowText, { color: C.textMuted }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function timeAgo(iso) {
  const sec = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// Comments for one post. `post` is kept fresh by the parent; every change
// the server confirms is handed back through onChanged(updatedPost).
function CommentsModal({ visible, post, me, authedApi, onClose, onChanged }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(null);
  if (!post) return null;
  const comments = post.comments || [];

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const res = await authedApi(`/api/posts/${post.id}/comments`, { method: "POST", body: JSON.stringify({ text: body }) });
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return Alert.alert("Couldn't comment", data.error || "Something went wrong.");
      setText("");
      onChanged(data.post);
    } catch (e) {
      Alert.alert("Couldn't comment", "Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }
  async function remove(comment) {
    try {
      const res = await authedApi(`/api/posts/${post.id}/comments/${comment.id}`, { method: "DELETE" });
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return Alert.alert("Couldn't delete", data.error || "Something went wrong.");
      onChanged(data.post);
    } catch (e) {
      Alert.alert("Couldn't delete", "Check your connection and try again.");
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { maxHeight: "80%" }]}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.titleSmall}>Comments{comments.length ? ` (${comments.length})` : ""}</Text>
              <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={24} color={C.textMuted} /></Pressable>
            </View>
            <FlatList
              style={{ flexGrow: 0, maxHeight: 360 }}
              data={comments}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<Text style={styles.empty}>No comments yet. Be the first.</Text>}
              renderItem={({ item: c }) => {
                const canDelete = c.userId === me?.id || post.userId === me?.id;
                return (
                  <View style={styles.commentRow}>
                    <UserAvatar name={c.userName} avatarUrl={c.userAvatarUrl} size={30} style={{ marginRight: 10 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.commentMeta}><Text style={styles.messageUser}>{c.userName}</Text>  {timeAgo(c.createdAt)}</Text>
                      <Text style={styles.messageText}>{c.text}</Text>
                    </View>
                    {canDelete && (
                      <Pressable hitSlop={10} onPress={() => setDeleting(c)} style={{ padding: 4 }}>
                        <Ionicons name="trash-outline" size={16} color={C.textMuted} />
                      </Pressable>
                    )}
                  </View>
                );
              }}
            />
            <View style={styles.commentInputRow}>
              <TextInput
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                value={text}
                onChangeText={setText}
                placeholder="Add a comment..."
                placeholderTextColor={C.textFaint}
                maxLength={500}
                onSubmitEditing={send}
                returnKeyType="send"
              />
              <Pressable style={[styles.smallButton, (!text.trim() || sending) && styles.smallButtonMuted, { marginLeft: 8 }]} disabled={!text.trim() || sending} onPress={send}>
                {sending ? <ActivityIndicator size="small" color={C.white} /> : <Text style={[styles.buttonText, !text.trim() && styles.smallButtonMutedText]}>Send</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ActionSheet
        visible={!!deleting}
        title="Delete this comment?"
        actions={[{ label: "Delete comment", icon: "trash-outline", destructive: true, onPress: () => deleting && remove(deleting) }]}
        onClose={() => setDeleting(null)}
      />
    </Modal>
  );
}

// Feed photo at its own proportions (clamped to Instagram's 4:5 .. 1.91:1),
// full width. Double-tap to like.
function PostImage({ uri, knownRatio, onDoubleTap, overlays }) {
  const [ratio, setRatio] = useState(knownRatio || 1);
  const lastTap = useRef(0);
  useEffect(() => {
    if (!uri || knownRatio) return;
    let cancelled = false;
    Image.getSize(uri, (w, h) => { if (!cancelled && w > 0 && h > 0) setRatio(w / h); }, () => {});
    return () => { cancelled = true; };
  }, [uri, knownRatio]);
  const r = Math.min(1.91, Math.max(0.8, ratio));
  return (
    <Pressable onPress={() => { const now = Date.now(); if (now - lastTap.current < 300) onDoubleTap && onDoubleTap(); lastTap.current = now; }}>
      <Image source={{ uri }} style={{ width: FEED_W, height: FEED_W / r, backgroundColor: C.surfaceRaised }} resizeMode="cover" />
      <OverlayLayer overlays={overlays} W={FEED_W} H={FEED_W / r} />
    </Pressable>
  );
}

// A single post, shared by the Home feed and the Profile tab. The owner gets
// a three-dot menu (Edit / Delete); everyone gets Like and Comment.
// onChanged(post) receives the server's updated copy after a like/comment.
function PostCard({ item, isOwner, me, authedApi, onEdit, onDelete, onChanged, isActive = false }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [liking, setLiking] = useState(false);

  async function toggleLike() {
    if (liking || !authedApi) return;
    setLiking(true);
    const want = !item.likedByMe;
    // Optimistic update so the heart responds instantly.
    onChanged && onChanged({ ...item, likedByMe: want, likeCount: Math.max(0, (item.likeCount || 0) + (want ? 1 : -1)) });
    try {
      const res = await authedApi(`/api/posts/${item.id}/like`, { method: "POST", body: JSON.stringify({ liked: want }) });
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.post) onChanged && onChanged(data.post);
      else onChanged && onChanged(item); // roll back
    } catch (e) {
      onChanged && onChanged(item);
    } finally {
      setLiking(false);
    }
  }

  return (
    <View style={styles.igPost}>
      <View style={styles.igHeader}>
        <UserAvatar name={item.userName} avatarUrl={item.userAvatarUrl} thumbUrl={item.userAvatarThumbUrl} size={34} style={{ marginRight: 10 }} />
        <Text style={[styles.igName, { flex: 1 }]} numberOfLines={1}>{item.userName}</Text>
        {isOwner && item.audienceCount != null && (
          <View style={{ flexDirection: "row", alignItems: "center", marginRight: 6 }}>
            <Ionicons name="lock-closed-outline" size={14} color={C.textMuted} />
            <Text style={styles.roomInfo}> {item.audienceCount}</Text>
          </View>
        )}
        {isOwner && (
          <Pressable onPress={() => setMenuOpen(true)} hitSlop={10} style={styles.postMenuBtn}>
            <Ionicons name="ellipsis-horizontal" size={20} color={C.text} />
          </Pressable>
        )}
      </View>
      {item.music && <PostMusicBar music={item.music} active={isActive} maxPlaySec={item.duration || null} />}
      {item.media && (
        item.media.mimeType?.startsWith("video/") ? (
          (() => {
            const vr = item.media.width && item.media.height ? Math.min(1.91, Math.max(0.8, item.media.width / item.media.height)) : 1;
            return (
              <View style={{ width: FEED_W, height: FEED_W / vr, backgroundColor: "#000" }}>
                <MediaVideo uri={item.media.url} style={{ width: FEED_W, height: FEED_W / vr }} muted={!!item.music} />
                <OverlayLayer overlays={item.overlays} W={FEED_W} H={FEED_W / vr} />
              </View>
            );
          })()
        ) : (
          <PostImage
            overlays={item.overlays}
            uri={item.media.url}
            knownRatio={item.media.width && item.media.height ? item.media.width / item.media.height : undefined}
            onDoubleTap={() => { if (!item.likedByMe) toggleLike(); }}
          />
        )
      )}
      <View style={styles.igActions}>
        <Pressable style={styles.igAction} onPress={toggleLike} hitSlop={8}>
          <Ionicons name={item.likedByMe ? "heart" : "heart-outline"} size={28} color={item.likedByMe ? "#E5484D" : C.text} />
        </Pressable>
        <Pressable style={styles.igAction} onPress={() => setCommentsOpen(true)} hitSlop={8}>
          <Ionicons name="chatbubble-outline" size={25} color={C.text} />
        </Pressable>
      </View>
      <View style={styles.igBody}>
        {(item.likeCount || 0) > 0 && <Text style={styles.igLikes}>{item.likeCount} {item.likeCount === 1 ? "like" : "likes"}</Text>}
        {!!item.text && (
          <Text style={styles.igCaption}>
            <Text style={styles.igName}>{item.userName}</Text>  {item.text}
          </Text>
        )}
        {(item.mentionUsers || []).length > 0 && (
          <Text style={styles.igMention} numberOfLines={2}>
            With {(item.mentionUsers || []).map((u, i) => `${i ? ", " : ""}@${u.username}`).join("")}
          </Text>
        )}
        {(item.commentCount || 0) > 0 && (
          <Pressable onPress={() => setCommentsOpen(true)}>
            <Text style={styles.igMuted}>View {item.commentCount === 1 ? "1 comment" : `all ${item.commentCount} comments`}</Text>
          </Pressable>
        )}
        <Text style={styles.igTime}>
          {timeAgo(item.createdAt).toUpperCase()}
          {item.editedAt ? " · EDITED" : ""}
        </Text>
      </View>
      <ActionSheet
        visible={menuOpen}
        title="Post options"
        actions={[
          { label: "Edit post", icon: "create-outline", onPress: () => onEdit && onEdit(item) },
          { label: "Delete post", icon: "trash-outline", destructive: true, onPress: () => setTimeout(() => setConfirmOpen(true), 250) },
        ]}
        onClose={() => setMenuOpen(false)}
      />
      <ActionSheet
        visible={confirmOpen}
        title="Delete this post? This can't be undone."
        actions={[{ label: "Yes, delete post", icon: "trash-outline", destructive: true, onPress: () => onDelete && onDelete(item) }]}
        onClose={() => setConfirmOpen(false)}
      />
      <CommentsModal
        visible={commentsOpen}
        post={item}
        me={me}
        authedApi={authedApi}
        onClose={() => setCommentsOpen(false)}
        onChanged={(p) => onChanged && onChanged(p)}
      />
    </View>
  );
}

// Shared edit sheet for a post's text/photo, used from both Home and
// Profile. Owns its own text/media state, seeded from `post` whenever a
// new one is passed in.
function EditPostModal({ visible, post, token, authedApi, onClose, onSaved }) {
  const [text, setText] = useState("");
  const [media, setMedia] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (post) { setText(post.text || ""); setMedia(post.media || null); }
  }, [post?.id]);

  async function changeMedia() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Permission needed", "Allow photo access to attach a photo or video.");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.8 });
    if (result.canceled) return;
    const asset = result.assets[0];
    setUploading(true);
    try {
      const uploaded = await uploadAsset(token, {
        uri: asset.uri,
        fileName: asset.fileName || (asset.type === "video" ? "video.mp4" : "photo.jpg"),
        mimeType: asset.mimeType || (asset.type === "video" ? "video/mp4" : "image/jpeg"),
      });
      setMedia(uploaded);
    } catch (e) {
      Alert.alert("Upload failed", e.message || "Could not upload that file.");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!text.trim() && !media) return Alert.alert("Empty post", "Write something or attach a photo.");
    setSaving(true);
    try {
      const res = await authedApi(`/api/posts/${post.id}`, {
        method: "PUT",
        body: JSON.stringify({ text: text.trim(), media }),
      });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Couldn't save", data.error || "Something went wrong.");
      onSaved(data.post);
      onClose();
    } catch (e) {
      Alert.alert("Couldn't save", "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!post) return null;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.modalHeaderRow}>
            <Text style={styles.titleSmall}>Edit post</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={C.textMuted} />
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            value={text}
            onChangeText={setText}
            placeholder="What's on your mind?"
            placeholderTextColor={C.textFaint}
            multiline
            maxLength={2000}
          />
          {media ? (
            <View style={styles.mediaPreviewWrap}>
              {media.mimeType?.startsWith("video/") ? (
                <View style={[styles.mediaPreviewImage, { alignItems: "center", justifyContent: "center" }]}>
                  <Ionicons name="videocam-outline" size={22} color={C.textMuted} />
                </View>
              ) : (
                <Image source={{ uri: media.url }} style={styles.mediaPreviewImage} />
              )}
              <Pressable style={styles.removeMediaBtn} onPress={() => setMedia(null)}>
                <Text style={styles.removeMediaBtnText}>×</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            style={[styles.smallButton, styles.smallButtonMuted, { marginTop: 12, flexDirection: "row", justifyContent: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 16 }]}
            onPress={changeMedia}
            disabled={uploading}
          >
            {uploading ? <ActivityIndicator size="small" /> : <Ionicons name="image-outline" size={17} color={C.textMuted} />}
            <Text style={styles.smallButtonMutedText}>{media ? "Replace photo" : "Add photo"}</Text>
          </Pressable>
          <Pressable style={[styles.button, { marginTop: 18 }, saving && { opacity: 0.7 }]} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color={C.white} /> : <Text style={styles.buttonText}>Save changes</Text>}
          </Pressable>
          </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const NOTIF_ICONS = { message: "chatbubble", friend_request: "person-add", friend_accept: "people", post_like: "heart", post_comment: "chatbubble-ellipses", post_mention: "at", story_mention: "at" };

// The notification inbox (opened from the bell on Home). Everything stays
// here until the person deletes it; unread ones carry a dot until opened.
function NotificationsModal({ visible, authedApi, onClose, onUnreadChange, onOpenItem, onRequestHandled, onStoryAdded }) {
  const [busyId, setBusyId] = useState(null);
  const [done, setDone] = useState({}); // notification id -> "accepted" | "added"
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await authedApi("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.notifications || []);
      onUnreadChange(data.unreadCount || 0);
    } catch (_) {
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (visible) { setDone({}); load(); } }, [visible]);

  // Accept or decline a friend request right from the notification. Declining is silent: the sender is never told.
  async function respondRequest(n, action) {
    const requestId = n.requestId || String(n.tag || "").replace(/^friend-/, "");
    setBusyId(n.id);
    try {
      const res = await authedApi(`/api/friends/requests/${requestId}/${action}`, { method: "POST" });
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 404) return Alert.alert(action === "accept" ? "Couldn't accept" : "Couldn't decline", data.error || "Something went wrong.");
      onUnreadChange(items.filter((x) => !x.read && x.id !== n.id).length);
      if (res.ok && action === "accept") setDone((d) => ({ ...d, [n.id]: "accepted" }));
      else setItems((old) => old.filter((x) => x.id !== n.id));
      onRequestHandled && onRequestHandled(action, data.room);
    } catch (_) {
      Alert.alert("Network error", "Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }
  // Someone mentioned you in their story: put it on your own story ("add it back").
  async function addToStory(n) {
    setBusyId(n.id);
    try {
      const res = await authedApi(`/api/stories/${n.storyId}/reshare`, { method: "POST" });
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setDone((d) => ({ ...d, [n.id]: "added" })); onStoryAdded && onStoryAdded(data.story); }
      else if (res.status === 409) setDone((d) => ({ ...d, [n.id]: "added" }));
      else Alert.alert("Couldn't add to your story", data.error || "Something went wrong.");
    } catch (_) {
      Alert.alert("Network error", "Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    setItems((old) => old.map((n) => ({ ...n, read: true })));
    onUnreadChange(0);
    try { await authedApi("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }); } catch (_) {}
  }
  async function open(n) {
    if (!n.read) {
      setItems((old) => old.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      onUnreadChange(Math.max(0, items.filter((x) => !x.read).length - 1));
      authedApi("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }).catch(() => {});
    }
    if (n.kind === "friend_request") return; // answered with the buttons on the row itself
    onOpenItem(n);
  }
  async function remove(n) {
    setItems((old) => old.filter((x) => x.id !== n.id));
    if (!n.read) onUnreadChange(Math.max(0, items.filter((x) => !x.read).length - 1));
    try { await authedApi(`/api/notifications/${n.id}`, { method: "DELETE" }); } catch (_) {}
  }
  async function clearAll() {
    setItems([]);
    onUnreadChange(0);
    try { await authedApi("/api/notifications", { method: "DELETE" }); } catch (_) {}
  }

  const hasUnread = items.some((n) => !n.read);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
        <View style={[styles.header, styles.profileHeaderRow]}>
          <Pressable onPress={onClose} hitSlop={10} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name="chevron-back" size={22} color={C.text} />
            <Text style={styles.titleSmall}>Notifications</Text>
          </Pressable>
          {items.length > 0 && (
            <View style={{ flexDirection: "row", gap: 16 }}>
              {hasUnread && (
                <Pressable onPress={markAllRead} hitSlop={8}><Text style={styles.bioEditLabel}>Mark all read</Text></Pressable>
              )}
              <Pressable onPress={() => setConfirmClear(true)} hitSlop={8}><Text style={[styles.bioEditLabel, { color: C.textMuted }]}>Clear all</Text></Pressable>
            </View>
          )}
        </View>
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          ListEmptyComponent={loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : <Text style={styles.empty}>You're all caught up.{"\n"}Likes, comments, messages and friend requests will show up here.</Text>}
          renderItem={({ item: n }) => (
            <Pressable style={[styles.notifRow, !n.read && styles.notifRowUnread]} onPress={() => open(n)}>
              <View style={[styles.notifIcon, { backgroundColor: n.kind === "post_like" ? "#E5484D" : C.accent }]}>
                <Ionicons name={NOTIF_ICONS[n.kind] || "notifications"} size={17} color={C.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.messageUser} numberOfLines={1}>{n.title}</Text>
                <Text style={styles.messageText} numberOfLines={2}>{n.body}</Text>
                <Text style={[styles.time, { alignSelf: "flex-start", marginTop: 4 }]}>{timeAgo(n.createdAt)}</Text>
                {n.kind === "friend_request" && (done[n.id] === "accepted" ? (
                  <Text style={styles.notifDone}>✓ You're now connected</Text>
                ) : (
                  <View style={styles.notifActions}>
                    <Pressable style={[styles.notifBtn, styles.notifBtnPrimary, busyId === n.id && { opacity: 0.6 }]} disabled={busyId === n.id} onPress={() => respondRequest(n, "accept")}>
                      <Text style={styles.notifBtnPrimaryText}>Accept</Text>
                    </Pressable>
                    <Pressable style={[styles.notifBtn, busyId === n.id && { opacity: 0.6 }]} disabled={busyId === n.id} onPress={() => respondRequest(n, "decline")}>
                      <Text style={styles.notifBtnText}>Decline</Text>
                    </Pressable>
                  </View>
                ))}
                {n.kind === "story_mention" && n.storyId && (done[n.id] === "added" || n.actioned ? (
                  <Text style={styles.notifDone}>✓ Added to your story</Text>
                ) : (
                  <View style={styles.notifActions}>
                    <Pressable style={[styles.notifBtn, styles.notifBtnPrimary, busyId === n.id && { opacity: 0.6 }]} disabled={busyId === n.id} onPress={() => addToStory(n)}>
                      <Text style={styles.notifBtnPrimaryText}>{busyId === n.id ? "Adding…" : "Add to your story"}</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
              {!n.read && <View style={styles.notifDot} />}
              <Pressable onPress={() => remove(n)} hitSlop={10} style={{ padding: 6, marginLeft: 4 }}>
                <Ionicons name="close" size={18} color={C.textMuted} />
              </Pressable>
            </Pressable>
          )}
        />
        <ActionSheet
          visible={confirmClear}
          title="Delete all notifications?"
          actions={[{ label: "Clear all", icon: "trash-outline", destructive: true, onPress: clearAll }]}
          onClose={() => setConfirmClear(false)}
        />
      </SafeAreaView>
    </Modal>
  );
}

function HomeTab({ authedApi, token, me, unread = 0, onOpenNotifications, refreshKey = 0 }) {
  const chrome = useContext(ScrollChromeContext);
  const [posts, setPosts] = useState([]);
  const [stories, setStories] = useState([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [creating, setCreating] = useState(null); // null | "post" | "story"
  const [viewer, setViewer] = useState(null); // { userId }
  // Music on a post plays while that post is on screen; it stops while the
  // story viewer, composer or editor is open on top of the feed.
  const activePost = useActivePost(!!creating || !!viewer || !!editingPost);

  const load = async () => {
    try {
      const [pRes, sRes] = await Promise.all([authedApi("/api/posts"), authedApi("/api/stories")]);
      if (pRes.status === 401) return;
      const pData = await pRes.json();
      setPosts(pData.posts || []);
      if (sRes.ok) setStories((await sRes.json()).stories || []);
    } catch (e) {
      Alert.alert("Could not load", "Check that the backend is reachable.");
    } finally {
      setLoadingPosts(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (refreshKey) load(); }, [refreshKey]);

  async function deletePost(post) {
    try {
      const res = await authedApi(`/api/posts/${post.id}`, { method: "DELETE" });
      if (res.status === 401) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return Alert.alert("Couldn't delete", data.error || "Something went wrong.");
      }
      setPosts((old) => old.filter((p) => p.id !== post.id));
    } catch (e) {
      Alert.alert("Couldn't delete", "Check your connection and try again.");
    }
  }

  const groups = groupStories(stories, me);
  const viewable = groups.filter((g) => g.stories.length > 0);
  const viewerIndex = viewer ? viewable.findIndex((g) => g.userId === viewer.userId) : -1;

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, styles.profileHeaderRow]}>
        <Pressable style={styles.gearButton} onPress={() => setCreating("post")} hitSlop={8}>
          <Ionicons name="add" size={24} color={C.text} />
        </Pressable>
        <Text style={styles.brandTitle}>Hush</Text>
        <Pressable style={styles.gearButton} onPress={onOpenNotifications} hitSlop={8}>
          <Ionicons name={unread > 0 ? "notifications" : "notifications-outline"} size={19} color={C.text} />
          {unread > 0 && (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>{unread > 99 ? "99+" : unread}</Text>
            </View>
          )}
        </Pressable>
      </View>
      <FlatList
        contentContainerStyle={{ paddingBottom: 24 + TAB_SPACE }}
        onScroll={chrome.onScroll}
        scrollEventThrottle={16}
        refreshing={refreshing}
        onRefresh={() => { setRefreshing(true); load(); }}
        ListHeaderComponent={
          <View style={styles.storiesWrap}>
            <StoriesBar groups={groups} onView={(g) => setViewer({ userId: g.userId })} onAdd={() => setCreating("story")} />
          </View>
        }
        data={posts}
        keyExtractor={(item) => item.id}
        extraData={activePost.activeId}
        onViewableItemsChanged={activePost.onViewableItemsChanged}
        viewabilityConfig={activePost.viewabilityConfig}
        renderItem={({ item }) => (
          <PostCard item={item} isActive={item.id === activePost.activeId} isOwner={item.userId === me?.id} me={me} authedApi={authedApi} onEdit={setEditingPost} onDelete={deletePost} onChanged={(p) => setPosts((old) => old.map((x) => (x.id === p.id ? p : x)))} />
        )}
        ListEmptyComponent={loadingPosts ? <ActivityIndicator style={{ marginTop: 30 }} /> : <Text style={styles.empty}>Friends' posts will appear here.{"\n"}Tap + to share your first photo.</Text>}
      />
      <EditPostModal
        visible={!!editingPost}
        post={editingPost}
        token={token}
        authedApi={authedApi}
        onClose={() => setEditingPost(null)}
        onSaved={(updated) => setPosts((old) => old.map((p) => (p.id === updated.id ? updated : p)))}
      />
      <CreateMediaModal
        visible={!!creating}
        mode={creating || "post"}
        token={token}
        authedApi={authedApi}
        onClose={() => setCreating(null)}
        onDone={(item) => {
          if (creating === "story") setStories((old) => [...old, item]);
          else setPosts((old) => [item, ...old]);
        }}
      />
      {viewer && viewerIndex >= 0 && (
        <StoryViewer
          groups={viewable}
          startIndex={viewerIndex}
          me={me}
          authedApi={authedApi}
          onClose={() => setViewer(null)}
          onViewed={(st) => setStories((old) => old.map((x) => (x.id === st.id ? { ...x, viewedByMe: true } : x)))}
          onDeleted={(st) => setStories((old) => old.filter((x) => x.id !== st.id))}
          onReshared={(orig, copy) => setStories((old) => [...old.map((x) => (x.id === orig.id ? { ...x, canReshare: false } : x)), ...(copy ? [copy] : [])])}
        />
      )}
    </View>
  );
}

// ===================== Instagram-style media flow =====================
const FEED_W = Math.min(SCREEN_WIDTH, 560);
const EDIT_W = Math.min(SCREEN_WIDTH - 32, 420);

// muted: used when a song is attached, so the song replaces the video's own sound.
function MediaVideo({ uri, style, controls = true, muted = false }) {
  const player = useVideoPlayer(uri, (p) => { if (p) { p.loop = false; p.muted = muted; } });
  useEffect(() => { if (player) player.muted = muted; }, [player, muted]);
  return <VideoView style={style} player={player} contentFit="contain" allowsFullscreen nativeControls={controls} />;
}

// Photo editor: choose a crop shape, drag/zoom inside it, rotate or flip.
// Rendered as a normal view (not a Modal) so it can sit inside the
// create-post / create-story flow.
function MediaEditor({ asset, aspects, title = "Edit", nextLabel = "Next", onBack, onNext }) {
  const [work, setWork] = useState({ uri: asset.uri, width: asset.width || 1, height: asset.height || 1 });
  const [aspectKey, setAspectKey] = useState(aspects[0].key);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const live = useRef({ zoom: 1, x: 0, y: 0, w: 1, h: 1, fw: 1, fh: 1 });
  const dragStart = useRef({ x: 0, y: 0 });

  const w = work.width || 1;
  const h = work.height || 1;
  const spec = aspects.find((a) => a.key === aspectKey) || aspects[0];
  const ratio = spec.ratio || Math.min(1.91, Math.max(0.8, w / h)); // "Original" keeps the photo's own shape (4:5 .. 1.91:1 like Instagram)
  const maxH = SCREEN_HEIGHT * 0.5;
  let fw = EDIT_W;
  let fh = fw / ratio;
  if (fh > maxH) { fh = maxH; fw = fh * ratio; }
  const cover = Math.max(fw / w, fh / h);
  const scale = cover * zoom;
  live.current.w = w; live.current.h = h; live.current.fw = fw; live.current.fh = fh;

  function limits(z) {
    const L = live.current;
    const s = Math.max(L.fw / L.w, L.fh / L.h) * z;
    return { maxX: Math.max(0, (L.w * s - L.fw) / 2), maxY: Math.max(0, (L.h * s - L.fh) / 2) };
  }
  function apply(next) {
    live.current = { ...live.current, ...next };
    setZoom(live.current.zoom);
    setOffset({ x: live.current.x, y: live.current.y });
  }
  useEffect(() => { apply({ zoom: 1, x: 0, y: 0 }); }, [aspectKey, work.uri]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { dragStart.current = { x: live.current.x, y: live.current.y }; },
      onPanResponderMove: (_, g) => {
        const { maxX, maxY } = limits(live.current.zoom);
        const x = Math.min(maxX, Math.max(-maxX, dragStart.current.x + g.dx));
        const y = Math.min(maxY, Math.max(-maxY, dragStart.current.y + g.dy));
        live.current.x = x; live.current.y = y;
        setOffset({ x, y });
      },
    })
  ).current;

  function setZoomTo(z) {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    const { maxX, maxY } = limits(nz);
    apply({ zoom: nz, x: Math.min(maxX, Math.max(-maxX, live.current.x)), y: Math.min(maxY, Math.max(-maxY, live.current.y)) });
  }
  const BAR_W = 160;
  function onBarPress(e) { setZoomTo(1 + (e.nativeEvent.locationX / BAR_W) * (MAX_ZOOM - 1)); }

  async function transform(fn) {
    setBusy(true);
    try {
      const ctx = ImageManipulator.ImageManipulator.manipulate(work.uri);
      fn(ctx);
      const ref = await ctx.renderAsync();
      const out = await ref.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.92 });
      setWork({ uri: out.uri, width: out.width, height: out.height });
    } catch (e) {
      Alert.alert("Couldn't edit", "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      const cw = fw / scale;
      const ch = fh / scale;
      let originX = w / 2 - cw / 2 - offset.x / scale;
      let originY = h / 2 - ch / 2 - offset.y / scale;
      originX = Math.max(0, Math.min(w - cw, originX));
      originY = Math.max(0, Math.min(h - ch, originY));
      const ctx = ImageManipulator.ImageManipulator.manipulate(work.uri);
      ctx.crop({ originX: Math.round(originX), originY: Math.round(originY), width: Math.round(cw), height: Math.round(ch) });
      if (cw > 1080) ctx.resize({ width: 1080 });
      const ref = await ctx.renderAsync();
      const out = await ref.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.88 });
      onNext({ uri: out.uri, width: out.width, height: out.height, fileName: "photo.jpg", mimeType: "image/jpeg", type: "image" });
    } catch (e) {
      Alert.alert("Couldn't save edits", "Please try a different photo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, styles.profileHeaderRow]}>
        <Pressable onPress={onBack} hitSlop={10}><Ionicons name="arrow-back" size={24} color={C.text} /></Pressable>
        <Text style={styles.titleSmall}>{title}</Text>
        <Pressable onPress={confirm} disabled={busy} hitSlop={10}>
          {busy ? <ActivityIndicator size="small" color={C.accent} /> : <Text style={styles.headerAction}>{nextLabel}</Text>}
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingBottom: 30 }}>
        <View style={[styles.cropViewport, { width: fw, height: fh, marginTop: 8 }]} {...pan.panHandlers}>
          <Image
            source={{ uri: work.uri }}
            style={{ position: "absolute", width: w * scale, height: h * scale, left: fw / 2 - (w * scale) / 2 + offset.x, top: fh / 2 - (h * scale) / 2 + offset.y }}
            draggable={false}
          />
          <View pointerEvents="none" style={styles.cropRing} />
        </View>
        <Text style={[styles.roomInfo, { marginTop: 8 }]}>Drag to reposition</Text>
        <View style={styles.editChipsRow}>
          {aspects.map((a) => (
            <Pressable key={a.key} onPress={() => setAspectKey(a.key)} style={[styles.editChip, aspectKey === a.key && styles.editChipActive]}>
              <Text style={[styles.editChipText, aspectKey === a.key && { color: C.white }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.zoomRow}>
          <Pressable style={styles.zoomBtn} onPress={() => setZoomTo(zoom - 0.25)}><Ionicons name="remove" size={22} color={C.text} /></Pressable>
          <Pressable onPress={onBarPress} hitSlop={{ top: 14, bottom: 14 }} style={[styles.zoomTrack, { width: BAR_W }]}>
            <View pointerEvents="none" style={[styles.zoomFill, { width: ((zoom - 1) / (MAX_ZOOM - 1)) * BAR_W }]} />
          </Pressable>
          <Pressable style={styles.zoomBtn} onPress={() => setZoomTo(zoom + 0.25)}><Ionicons name="add" size={22} color={C.text} /></Pressable>
        </View>
        <View style={styles.zoomRow}>
          <Pressable style={styles.editToolBtn} onPress={() => transform((c) => c.rotate(-90))} disabled={busy}>
            <Ionicons name="refresh-outline" size={20} color={C.text} style={{ transform: [{ scaleX: -1 }] }} />
            <Text style={styles.editToolText}>Rotate left</Text>
          </Pressable>
          <Pressable style={styles.editToolBtn} onPress={() => transform((c) => c.rotate(90))} disabled={busy}>
            <Ionicons name="refresh-outline" size={20} color={C.text} />
            <Text style={styles.editToolText}>Rotate right</Text>
          </Pressable>
          <Pressable style={styles.editToolBtn} onPress={() => transform((c) => c.flip("horizontal"))} disabled={busy}>
            <Ionicons name="swap-horizontal-outline" size={20} color={C.text} />
            <Text style={styles.editToolText}>Flip</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const POST_ASPECTS = [
  { key: "orig", label: "Original", ratio: null },
  { key: "sq", label: "1:1", ratio: 1 },
  { key: "port", label: "4:5", ratio: 4 / 5 },
  { key: "wide", label: "16:9", ratio: 16 / 9 },
];
const STORY_ASPECTS = [
  { key: "story", label: "9:16", ratio: 9 / 16 },
  { key: "orig", label: "Original", ratio: null },
  { key: "sq", label: "1:1", ratio: 1 },
];

// Browsers don't tell us a picked video's length, so read it from the file
// itself. Resolves null if it can't be read (we then let the server decide).
function probeVideoSeconds(uri) {
  return new Promise((resolve) => {
    try {
      const v = document.createElement("video");
      let settled = false;
      const done = (n) => { if (!settled) { settled = true; v.removeAttribute("src"); try { v.load(); } catch (_) {} resolve(n); } };
      v.preload = "metadata";
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
      v.onerror = () => done(null);
      setTimeout(() => done(null), 5000);
      v.src = uri;
    } catch (_) { resolve(null); }
  });
}

// "Who can watch": all friends, or only the friends ticked in the list.
function AudiencePicker({ authedApi, mode, onModeChange, ids, onIdsChange, noun = "post" }) {
  const [friends, setFriends] = useState(null); // null = loading
  const [q, setQ] = useState("");
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await authedApi("/api/friends");
        const data = await res.json().catch(() => ({}));
        if (!off) setFriends(res.ok ? data.friends || [] : []);
      } catch (_) { if (!off) setFriends([]); }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chosen = new Set(ids);
  const toggle = (id) => onIdsChange(chosen.has(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const needle = q.trim().toLowerCase();
  const shown = (friends || []).filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.username.includes(needle));
  const Option = ({ value, title, sub }) => (
    <Pressable style={[styles.audienceOption, mode === value && styles.audienceOptionActive]} onPress={() => onModeChange(value)}>
      <Ionicons name={mode === value ? "radio-button-on" : "radio-button-off"} size={22} color={mode === value ? C.accent : C.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={styles.accountName}>{title}</Text>
        <Text style={styles.roomInfo}>{sub}</Text>
      </View>
    </Pressable>
  );
  return (
    <View>
      <Text style={styles.sectionLabel}>Who can watch this {noun}</Text>
      <Option value="all" title="All friends" sub={`Everyone you're connected with can see this ${noun}`} />
      <Option value="some" title="Only selected people" sub={ids.length ? `${ids.length} selected` : `Choose who can see this ${noun}`} />
      {mode === "some" && (
        <View style={{ marginTop: 6 }}>
          {friends === null ? (
            <ActivityIndicator style={{ marginTop: 16 }} />
          ) : friends.length === 0 ? (
            <Text style={[styles.muted, { textAlign: "center", marginTop: 14 }]}>You have no friends yet. Add friends from the Discover tab first.</Text>
          ) : (
            <>
              <TextInput style={[styles.input, { marginTop: 8 }]} placeholder="Search friends" placeholderTextColor={C.textFaint} value={q} onChangeText={setQ} autoCapitalize="none" />
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                <Pressable onPress={() => onIdsChange(friends.map((f) => f.id))}><Text style={styles.link}>Select all</Text></Pressable>
                <Pressable onPress={() => onIdsChange([])}><Text style={styles.link}>Clear</Text></Pressable>
              </View>
              {shown.map((f) => (
                <Pressable key={f.id} style={styles.accountRow} onPress={() => toggle(f.id)}>
                  <UserAvatar name={f.name} avatarUrl={f.avatarUrl} size={38} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.accountName} numberOfLines={1}>{f.name}</Text>
                    <Text style={styles.roomInfo} numberOfLines={1}>@{f.username}</Text>
                  </View>
                  <Ionicons name={chosen.has(f.id) ? "checkbox" : "square-outline"} size={24} color={chosen.has(f.id) ? C.accent : C.textMuted} />
                </Pressable>
              ))}
              {shown.length === 0 && <Text style={[styles.muted, { textAlign: "center", marginTop: 10 }]}>No match.</Text>}
            </>
          )}
        </View>
      )}
    </View>
  );
}

// "Tag people": pick friends to mention. They get a notification, can always see the
// post/story, and for a story they can add it back to their own story.
function MentionPicker({ authedApi, ids, onIdsChange, noun = "post" }) {
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open || friends !== null) return;
    let off = false;
    (async () => {
      try {
        const res = await authedApi("/api/friends");
        const data = await res.json().catch(() => ({}));
        if (!off) setFriends(res.ok ? data.friends || [] : []);
      } catch (_) { if (!off) setFriends([]); }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const chosen = new Set(ids);
  const toggle = (id) => onIdsChange(chosen.has(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const needle = q.trim().toLowerCase();
  const shown = (friends || []).filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.username.includes(needle));
  return (
    <View style={{ marginBottom: 18 }}>
      <Pressable style={styles.mentionHeader} onPress={() => setOpen((o) => !o)}>
        <Ionicons name="at" size={22} color={C.text} />
        <View style={{ flex: 1 }}>
          <Text style={styles.accountName}>Tag people</Text>
          <Text style={styles.roomInfo}>{ids.length ? `${ids.length} tagged` : `Mention friends in this ${noun}`}</Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={20} color={C.textMuted} />
      </Pressable>
      {open && (
        <View style={{ marginTop: 6 }}>
          {friends === null ? (
            <ActivityIndicator style={{ marginTop: 14 }} />
          ) : friends.length === 0 ? (
            <Text style={[styles.muted, { textAlign: "center", marginTop: 12 }]}>You have no friends to tag yet.</Text>
          ) : (
            <>
              <TextInput style={[styles.input, { marginTop: 8 }]} placeholder="Search friends" placeholderTextColor={C.textFaint} value={q} onChangeText={setQ} autoCapitalize="none" />
              {shown.map((f) => (
                <Pressable key={f.id} style={styles.accountRow} onPress={() => toggle(f.id)}>
                  <UserAvatar name={f.name} avatarUrl={f.avatarUrl} size={38} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.accountName} numberOfLines={1}>{f.name}</Text>
                    <Text style={styles.roomInfo} numberOfLines={1}>@{f.username}</Text>
                  </View>
                  <Ionicons name={chosen.has(f.id) ? "checkbox" : "square-outline"} size={24} color={chosen.has(f.id) ? C.accent : C.textMuted} />
                </Pressable>
              ))}
              {shown.length === 0 && <Text style={[styles.muted, { textAlign: "center", marginTop: 10 }]}>No match.</Text>}
            </>
          )}
        </View>
      )}
      {ids.length > 0 && <Text style={[styles.roomInfo, { marginTop: 6 }]}>Tagged people can always see this {noun}, even if it's limited to selected friends.</Text>}
    </View>
  );
}

// Full-screen "new post" / "new story" flow:
//   1. choose Photo or Video   2. edit it   3. write a caption and share.
function CreateMediaModal({ visible, mode = "post", token, authedApi, onClose, onDone }) {
  const isStory = mode === "story";
  const [step, setStep] = useState("pick"); // pick | edit | caption
  const [asset, setAsset] = useState(null); // what the picker returned
  const [edited, setEdited] = useState(null); // ready-to-upload result
  const [caption, setCaption] = useState("");
  const [sharing, setSharing] = useState(false);
  const [overlays, setOverlays] = useState([]); // text stickers on the photo
  const [music, setMusic] = useState(null); // 30s song clip (startSec = where in the clip it begins)
  // How long the post/story plays. Photos: posts 15-30s, stories up to 15s.
  // Videos use their own length (max 60s), measured when the video is picked.
  const [duration, setDuration] = useState(isStory ? 5 : 15);
  const [videoSec, setVideoSec] = useState(null);
  // Who can watch: everyone you're friends with, or only the people picked here.
  const [audienceMode, setAudienceMode] = useState("all"); // "all" | "some"
  const [audienceIds, setAudienceIds] = useState([]);
  const [mentionIds, setMentionIds] = useState([]); // friends tagged in this post/story

  useEffect(() => {
    if (visible) { setMentionIds([]); setAudienceMode("all"); setAudienceIds([]); setStep("pick"); setAsset(null); setEdited(null); setCaption(""); setSharing(false); setOverlays([]); setMusic(null); setDuration(isStory ? 5 : 15); setVideoSec(null); }
  }, [visible]);

  async function pick(kind) {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Permission needed", "Allow photo access to choose a photo or video.");
    const result = await ImagePicker.launchImageLibraryAsync(
      kind === "photo"
        ? { mediaTypes: ["images"], quality: 1 }
        // On iOS/Android the system picker lets you trim the video; browsers can't.
        : { mediaTypes: ["videos"], allowsEditing: Platform.OS !== "web", videoMaxDuration: MAX_VIDEO_SEC, quality: 1 },
    );
    if (result.canceled) return;
    const a = result.assets[0];
    const isVideo = kind === "video";
    // Videos are capped at 60 seconds for both posts and stories. The phone
    // picker trims for us, but browsers can't, so always check the real length.
    let secs = null;
    if (isVideo) {
      secs = a.duration ? a.duration / 1000 : null; // expo-image-picker reports ms
      if (secs == null && Platform.OS === "web") secs = await probeVideoSeconds(a.uri);
      if (secs != null && secs > MAX_VIDEO_SEC + 0.5) {
        return Alert.alert("Video is too long", `Videos can be up to ${MAX_VIDEO_SEC} seconds (this one is ${fmtClock(secs)}). ${Platform.OS === "web" ? "Trim it and try again." : "Trim it to 1:00 or less and try again."}`);
      }
    }
    setVideoSec(secs != null ? Math.max(1, Math.round(secs)) : null);
    setAsset({ ...a, isVideo });
    if (isVideo) setEdited({ uri: a.uri, width: a.width, height: a.height, fileName: a.fileName || "video.mp4", mimeType: a.mimeType || "video/mp4", type: "video" });
    setStep("edit");
  }

  async function share() {
    if (!edited || sharing) return;
    if (audienceMode === "some" && audienceIds.length === 0) return Alert.alert("Choose people", "Pick at least one person, or switch back to All friends.");
    setSharing(true);
    try {
      const uploaded = await uploadAsset(token, { uri: edited.uri, fileName: edited.fileName, mimeType: edited.mimeType });
      const media = { ...uploaded, width: edited.width || undefined, height: edited.height || undefined };
      // Video: its own length. Photo: the length chosen on the previous step.
      const playSec = asset?.isVideo ? (videoSec || MAX_VIDEO_SEC) : duration;
      const seg = music ? musicSegment(music, playSec) : null;
      const musicOut = seg ? { ...music, startSec: seg.start, endSec: seg.end } : null;
      const res = await authedApi(isStory ? "/api/stories" : "/api/posts", { method: "POST", body: JSON.stringify({ text: isStory ? "" : caption.trim(), media, duration: playSec, music: musicOut, overlays: overlays.filter((o) => o.text.trim()), audience: audienceMode === "some" ? audienceIds : null, mentions: mentionIds }) });
      if (res.status === 401) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return Alert.alert("Couldn't share", data.error || "Something went wrong.");
      onDone(isStory ? data.story : data.post);
      onClose();
    } catch (e) {
      Alert.alert("Couldn't share", e.message || "Check your connection and try again.");
    } finally {
      setSharing(false);
    }
  }

  const videoRatio = asset?.isVideo && asset.width && asset.height ? Math.min(1.91, Math.max(0.56, asset.width / asset.height)) : 1;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
        {step === "pick" && (
          <View style={{ flex: 1 }}>
            <View style={[styles.header, styles.profileHeaderRow]}>
              <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={26} color={C.text} /></Pressable>
              <Text style={styles.titleSmall}>{isStory ? "New story" : "New post"}</Text>
              <View style={{ width: 26 }} />
            </View>
            <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 16 }}>
              <Pressable style={styles.pickTile} onPress={() => pick("photo")}>
                <Ionicons name="image-outline" size={34} color={C.accent} />
                <Text style={styles.pickTileTitle}>Photo</Text>
                <Text style={styles.roomInfo}>{isStory ? "Crop and resize. Stays up for up to 15 seconds" : "Crop and resize. Plays for 15 to 30 seconds"}</Text>
              </Pressable>
              <Pressable style={styles.pickTile} onPress={() => pick("video")}>
                <Ionicons name="videocam-outline" size={34} color={C.accent} />
                <Text style={styles.pickTileTitle}>Video</Text>
                <Text style={styles.roomInfo}>{Platform.OS === "web" ? "Up to 60 seconds" : "Up to 60 seconds. Trim it to the part you want"}</Text>
              </Pressable>
            </View>
          </View>
        )}

        {step === "edit" && asset && !asset.isVideo && (
          <MediaEditor
            asset={asset}
            aspects={isStory ? STORY_ASPECTS : POST_ASPECTS}
            title="Edit photo"
            onBack={() => setStep("pick")}
            onNext={(out) => { setEdited(out); setStep("decorate"); }}
          />
        )}

        {step === "edit" && asset && asset.isVideo && (
          <View style={{ flex: 1 }}>
            <View style={[styles.header, styles.profileHeaderRow]}>
              <Pressable onPress={() => setStep("pick")} hitSlop={10}><Ionicons name="arrow-back" size={24} color={C.text} /></Pressable>
              <Text style={styles.titleSmall}>Preview video</Text>
              <Pressable onPress={() => setStep("decorate")} hitSlop={10}><Text style={styles.headerAction}>Next</Text></Pressable>
            </View>
            <View style={{ alignItems: "center", marginTop: 8 }}>
              <MediaVideo uri={asset.uri} style={{ width: EDIT_W, aspectRatio: videoRatio, backgroundColor: "#000", borderRadius: 4 }} />
              <Text style={[styles.roomInfo, { marginTop: 12, textAlign: "center", paddingHorizontal: 24 }]}>
                {videoSec ? `Length ${fmtClock(videoSec)} (max 1:00). ` : "Max length 1:00. "}
                {Platform.OS === "web" ? "Videos are shared as they are. Trimming is available in the phone app." : "Trim the video when you pick it. This is how it will look."}
              </Text>
            </View>
          </View>
        )}

        {step === "decorate" && edited && (
          <DecorateStep
            edited={edited}
            overlays={overlays}
            setOverlays={setOverlays}
            music={music}
            setMusic={setMusic}
            isVideo={!!asset?.isVideo}
            videoSec={videoSec}
            isStory={isStory}
            duration={duration}
            setDuration={setDuration}
            authedApi={authedApi}
            title={isStory ? "Add to story" : "Text & music"}
            nextLabel="Next"
            busy={sharing}
            onBack={() => setStep("edit")}
            onNext={() => (isStory ? setStep("audience") : setStep("caption"))}
          />
        )}

        {step === "audience" && edited && isStory && (
          <View style={{ flex: 1 }}>
            <View style={[styles.header, styles.profileHeaderRow]}>
              <Pressable onPress={() => setStep("decorate")} hitSlop={10} disabled={sharing}><Ionicons name="arrow-back" size={24} color={C.text} /></Pressable>
              <Text style={styles.titleSmall}>Who can watch?</Text>
              <Pressable onPress={share} disabled={sharing} hitSlop={10}>
                {sharing ? <ActivityIndicator size="small" color={C.accent} /> : <Text style={styles.headerAction}>Share</Text>}
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
              <MentionPicker authedApi={authedApi} ids={mentionIds} onIdsChange={setMentionIds} noun="story" />
              <AudiencePicker authedApi={authedApi} mode={audienceMode} onModeChange={setAudienceMode} ids={audienceIds} onIdsChange={setAudienceIds} noun="story" />
              {sharing && <Text style={[styles.roomInfo, { textAlign: "center", marginTop: 20 }]}>Uploading... videos can take a little while.</Text>}
            </ScrollView>
          </View>
        )}

        {step === "caption" && edited && !isStory && (
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={[styles.header, styles.profileHeaderRow]}>
              <Pressable onPress={() => setStep("decorate")} hitSlop={10} disabled={sharing}><Ionicons name="arrow-back" size={24} color={C.text} /></Pressable>
              <Text style={styles.titleSmall}>New post</Text>
              <Pressable onPress={share} disabled={sharing} hitSlop={10}>
                {sharing ? <ActivityIndicator size="small" color={C.accent} /> : <Text style={styles.headerAction}>Share</Text>}
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}>
              <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
                {edited.type === "video" ? (
                  <View style={[styles.captionThumb, { alignItems: "center", justifyContent: "center" }]}><Ionicons name="play-circle-outline" size={30} color={C.textMuted} /></View>
                ) : (
                  <Image source={{ uri: edited.uri }} style={styles.captionThumb} />
                )}
                <TextInput
                  style={[styles.input, { flex: 1, minHeight: 90, textAlignVertical: "top", marginBottom: 0 }]}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Write a caption..."
                  placeholderTextColor={C.textFaint}
                  multiline
                  maxLength={2000}
                  autoFocus={Platform.OS === "web"}
                />
              </View>
              <View style={{ marginTop: 20 }}>
                <MentionPicker authedApi={authedApi} ids={mentionIds} onIdsChange={setMentionIds} noun="post" />
                <AudiencePicker authedApi={authedApi} mode={audienceMode} onModeChange={setAudienceMode} ids={audienceIds} onIdsChange={setAudienceIds} noun="post" />
              </View>
              {sharing && <Text style={[styles.roomInfo, { textAlign: "center", marginTop: 20 }]}>Uploading... videos can take a little while.</Text>}
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ===================== Music + text on photos =====================
const TEXT_COLORS = ["#FFFFFF", "#000000", "#FF4D4F", "#FFC53D", "#52C41A", "#40A9FF", "#F759AB"];
function isLightColor(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}
function overlayTextStyle(o, W) {
  const fs = Math.max(10, W * 0.07 * (o.scale || 1));
  const box = o.style === "box";
  return {
    fontSize: fs,
    fontWeight: "800",
    textAlign: "center",
    color: box ? (isLightColor(o.color) ? "#000" : "#fff") : o.color,
    ...(box
      ? { backgroundColor: o.color, paddingHorizontal: fs * 0.35, paddingVertical: fs * 0.12, borderRadius: fs * 0.25, overflow: "hidden" }
      : { textShadowColor: "rgba(0,0,0,0.65)", textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } }),
  };
}
// Where a text sticker sits inside a W x H frame. x/y are fractions (x = centre).
function overlayWrapStyle(o, W, H) {
  const fs = Math.max(10, W * 0.07 * (o.scale || 1));
  return { position: "absolute", left: 0, width: W, top: o.y * H - fs, alignItems: "center", paddingHorizontal: W * 0.04, transform: [{ translateX: (o.x - 0.5) * W }] };
}

// Read-only text stickers over a photo/video (feed, story viewer, previews).
function OverlayLayer({ overlays, W, H }) {
  if (!overlays || !overlays.length) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: W, height: H, overflow: "hidden" }}>
      {overlays.map((o) => (
        <View key={o.id} style={overlayWrapStyle(o, W, H)}>
          <Text style={overlayTextStyle(o, W)}>{o.text}</Text>
        </View>
      ))}
    </View>
  );
}

// One draggable sticker in the editor. Drag to move; tap to edit.
function DraggableOverlay({ o, W, H, selected, onMove, onTap }) {
  const ref = useRef({});
  ref.current = { o, W, H, onMove, onTap };
  const start = useRef({ x: 0, y: 0 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { start.current = { x: ref.current.o.x, y: ref.current.o.y }; },
      onPanResponderMove: (_, g) => {
        const { W: w, H: h } = ref.current;
        ref.current.onMove(ref.current.o.id, {
          x: Math.min(1, Math.max(0, start.current.x + g.dx / w)),
          y: Math.min(1, Math.max(0, start.current.y + g.dy / h)),
        });
      },
      onPanResponderRelease: (_, g) => { if (Math.abs(g.dx) < 5 && Math.abs(g.dy) < 5) ref.current.onTap(ref.current.o.id); },
    })
  ).current;
  return (
    <View pointerEvents="box-none" style={overlayWrapStyle(o, W, H)}>
      <View {...pan.panHandlers} style={selected ? { borderWidth: 1, borderColor: "rgba(255,255,255,0.9)", borderStyle: "dashed", borderRadius: 6, padding: 2 } : { padding: 3 }}>
        <Text style={overlayTextStyle(o, W)}>{o.text || " "}</Text>
      </View>
    </View>
  );
}

// ---- Short audio clips (song previews) ----
// Browsers only play sound through a real <audio> element (a video player
// that isn't on screen stays silent), so the web build uses one directly;
// phones use expo-audio. play() resolves false if the browser blocks
// autoplay until the person taps something.
//
// A clip can play just a *part* of the 30s preview: it starts at startSec,
// loops back to startSec when it reaches endSec, and (if maxPlaySec is set)
// stops once it has played that many seconds in total -- which is how a
// 15-30s photo post or a 5-15s story gets exactly the music length it needs.
const CLIP_SEC = 30; // iTunes song previews are 30 seconds long
const MIN_MUSIC_WINDOW = 5; // shortest part of a song you can pick
const MAX_VIDEO_SEC = 60; // posts and stories
const POST_PHOTO_SECONDS = [15, 20, 25, 30];
const STORY_PHOTO_SECONDS = [5, 10, 15];

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
// The part of the preview that plays: it starts where the person dragged to
// and runs for as long as the post is long (up to the end of the preview).
function musicSegment(music, durationSec) {
  const win = Math.min(CLIP_SEC, Math.max(MIN_MUSIC_WINDOW, Math.round(durationSec || CLIP_SEC)));
  const start = Math.max(0, Math.min(CLIP_SEC - MIN_MUSIC_WINDOW, Math.round((music && music.startSec) || 0)));
  return { start, end: Math.min(CLIP_SEC, start + win) };
}

function createClip(url, opts, cb) {
  const { startSec = 0, endSec = null, loop = true, maxPlaySec = null, muted = false } = opts || {};
  const { onState = () => {}, onProgress = () => {} } = cb || {};
  let played = 0; // seconds actually played so far, across loops
  let last = 0; // wall-clock ms of the previous tick while playing
  let needSeek = startSec > 0;
  let done = false; // hit maxPlaySec (or ended without looping)
  // Adds the time since the last tick to `played`; true once maxPlaySec is used up.
  function tick(stillPlaying) {
    const now = Date.now();
    if (last) played += (now - last) / 1000;
    last = stillPlaying ? now : 0;
    if (maxPlaySec) onProgress(Math.min(1, played / maxPlaySec));
    return !!maxPlaySec && played >= maxPlaySec;
  }
  function reset() { played = 0; last = 0; done = false; needSeek = true; onProgress(0); }

  if (Platform.OS === "web") {
    const el = new window.Audio(url);
    el.preload = "auto";
    el.muted = !!muted;
    let timer = null;
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
    const rewind = () => { try { el.currentTime = startSec; } catch (_) {} };
    const finish = () => { stopTimer(); done = true; last = 0; el.pause(); onState(false); };
    const startTimer = () => {
      stopTimer();
      last = Date.now();
      timer = setInterval(() => {
        if (el.paused) return;
        if (tick(true)) return finish();
        if (endSec && el.currentTime >= endSec - 0.05) { if (loop) rewind(); else finish(); }
      }, 100);
    };
    el.addEventListener("play", () => { onState(true); startTimer(); });
    el.addEventListener("pause", () => { onState(false); stopTimer(); tick(false); });
    el.addEventListener("ended", () => {
      if (loop && !done) { rewind(); el.play().catch(() => {}); } else onState(false);
    });
    const metadata = new Promise((res) => {
      if (el.readyState >= 1) res();
      else { el.addEventListener("loadedmetadata", () => res(), { once: true }); setTimeout(res, 4000); }
    });
    return {
      play: async () => {
        try {
          if (done) reset();
          if (needSeek) { if (el.readyState < 1) await metadata; rewind(); needSeek = false; }
          await el.play();
          return true;
        } catch (_) { return false; }
      },
      pause: () => el.pause(),
      restart: reset,
      setMuted: (m) => { el.muted = !!m; },
      release: () => { stopTimer(); try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {} },
    };
  }

  try { setAudioModeAsync({ playsInSilentMode: true }); } catch (_) {}
  const p = createAudioPlayer({ uri: url }, { updateInterval: 100 });
  p.loop = false; // we loop the chosen window ourselves
  try { p.muted = !!muted; } catch (_) {}
  const rewind = () => { try { const r = p.seekTo(startSec); if (r && r.catch) r.catch(() => {}); } catch (_) {} };
  const finish = () => { done = true; last = 0; try { p.pause(); } catch (_) {} onState(false); };
  const sub = p.addListener("playbackStatusUpdate", (st) => {
    if (!st) return;
    const playing = !!st.playing;
    onState(playing);
    const t = st.currentTime || 0;
    // The first play() can run before the file is loaded, so a seek may not
    // have stuck -- fix the position as soon as it reports loaded.
    if (needSeek && st.isLoaded) { needSeek = false; if (Math.abs(t - startSec) > 0.5) rewind(); }
    if (playing) {
      if (tick(true)) return finish();
      if (endSec && t >= endSec - 0.05) { if (loop) rewind(); else finish(); }
    } else tick(false);
    if (st.didJustFinish) {
      if (loop && !done) { rewind(); try { p.play(); } catch (_) {} } else onState(false);
    }
  });
  return {
    play: async () => {
      try {
        if (done) reset();
        if (needSeek) { try { await p.seekTo(startSec); needSeek = false; } catch (_) { /* not loaded yet: the status listener retries */ } }
        p.play();
        last = Date.now();
        return true;
      } catch (_) { return false; }
    },
    pause: () => { try { p.pause(); } catch (_) {} },
    restart: reset,
    setMuted: (m) => { try { p.muted = !!m; } catch (_) {} },
    release: () => { try { sub.remove(); } catch (_) {} try { p.remove(); } catch (_) {} },
  };
}

// autoplay + active: the clip plays whenever it's active and pauses when it
// isn't (e.g. the post scrolled out of view). muted keeps it playing silently.
function useClip(url, { startSec = 0, endSec = null, loop = true, maxPlaySec = null, autoplay = false, active = true, muted = false } = {}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 of maxPlaySec
  const clip = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const wantPlay = autoplay && active;

  useEffect(() => {
    if (!url) return;
    setProgress(0);
    const c = createClip(url, { startSec, endSec, loop, maxPlaySec, muted: mutedRef.current }, { onState: setIsPlaying, onProgress: setProgress });
    clip.current = c;
    return () => {
      c.release();
      clip.current = null;
      setIsPlaying(false);
    };
  }, [url, startSec, endSec, loop, maxPlaySec]);

  useEffect(() => { if (clip.current) clip.current.setMuted(muted); }, [muted, url, startSec, endSec, loop, maxPlaySec]);

  useEffect(() => {
    const c = clip.current;
    if (!c || !wantPlay) return;
    let unlock = null;
    c.restart();
    c.play().then((ok) => {
      if (ok) { setBlocked(false); return; }
      if (!(Platform.OS === "web" && typeof document !== "undefined")) return;
      // Autoplay was blocked: start on the very next tap/click anywhere.
      setBlocked(true);
      unlock = () => { c.play().then((o) => { if (o) setBlocked(false); }); };
      document.addEventListener("pointerdown", unlock, { once: true });
    });
    return () => {
      if (unlock) document.removeEventListener("pointerdown", unlock);
      c.pause();
    };
  }, [wantPlay, url, startSec, endSec, loop, maxPlaySec]);

  async function toggle() {
    const c = clip.current;
    if (!c) return;
    if (isPlaying) c.pause();
    else if (await c.play()) setBlocked(false);
  }
  return { isPlaying, blocked, progress, toggle };
}

// Mute for music on *posts* is one shared, remembered switch (like Reels):
// mute one post and the rest stay muted until you turn sound back on.
// Stories deliberately have no equivalent -- their music always plays.
const POSTS_MUTED_KEY = "music_chat_posts_muted";
let postsMuted = false;
const postsMutedListeners = new Set();
AsyncStorage.getItem(POSTS_MUTED_KEY).then((v) => {
  postsMuted = v === "1";
  postsMutedListeners.forEach((f) => f(postsMuted));
}).catch(() => {});
function usePostsMuted() {
  const [muted, setMuted] = useState(postsMuted);
  useEffect(() => {
    postsMutedListeners.add(setMuted);
    setMuted(postsMuted);
    return () => { postsMutedListeners.delete(setMuted); };
  }, []);
  const toggle = useCallback(() => {
    postsMuted = !postsMuted;
    AsyncStorage.setItem(POSTS_MUTED_KEY, postsMuted ? "1" : "0").catch(() => {});
    postsMutedListeners.forEach((f) => f(postsMuted));
  }, []);
  return [muted, toggle];
}

// Which post (that has music) is on screen right now. Only that one plays;
// scrolling to the next one switches the song. `paused` silences everything
// while a full-screen thing (story viewer, composer, editor) is open.
function useActivePost(paused) {
  const [viewableId, setViewableId] = useState(null);
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const hit = (viewableItems || []).find((v) => v.item && v.item.music);
    setViewableId(hit ? hit.item.id : null);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60, minimumViewTime: 300 }).current;
  return { activeId: paused ? null : viewableId, onViewableItemsChanged, viewabilityConfig };
}

// ---- Music ----
function MusicPill({ music, onRemove, onPress, light, trailing }) {
  return (
    <Pressable style={[styles.musicPill, light && styles.musicPillDark]} onPress={onPress} disabled={!onPress}>
      {music.artworkUrl ? <Image source={{ uri: music.artworkUrl }} style={styles.musicArt} /> : <Ionicons name="musical-notes" size={16} color={light ? "#fff" : C.text} />}
      <Text style={[styles.musicPillText, light && { color: "#fff" }]} numberOfLines={1}>{music.title}{music.artist ? ` · ${music.artist}` : ""}</Text>
      {trailing}
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={8}><Ionicons name="close" size={16} color={light ? "#fff" : C.textMuted} /></Pressable>
      )}
    </Pressable>
  );
}

// Search Apple's catalogue (through our backend) and pick a 30-second clip.
function MusicPicker({ visible, authedApi, onClose, onPick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  useClip(previewUrl, { loop: false, autoplay: true });

  useEffect(() => {
    if (!visible) { setPlayingId(null); setPreviewUrl(null); setQuery(""); setResults([]); setError(""); }
  }, [visible]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setError(""); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await authedApi(`/api/music/search?q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setError(data.error || "Search failed."); setResults([]); }
        else { setError(""); setResults(data.results || []); }
      } catch (_) { setError("Check your connection and try again."); }
      finally { setLoading(false); }
    }, 450);
    return () => clearTimeout(t);
  }, [query]);

  function togglePreview(t) {
    if (playingId === t.trackId) { setPlayingId(null); setPreviewUrl(null); return; }
    setPlayingId(t.trackId);
    setPreviewUrl(t.previewUrl);
  }
  function choose(t) {
    setPreviewUrl(null);
    onPick({ trackId: t.trackId, title: t.title, artist: t.artist, artworkUrl: t.artworkUrl, previewUrl: t.previewUrl });
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
        <View style={[styles.header, styles.profileHeaderRow]}>
          <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={26} color={C.text} /></Pressable>
          <Text style={styles.titleSmall}>Add music</Text>
          <View style={{ width: 26 }} />
        </View>
        <View style={{ paddingHorizontal: 16 }}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={18} color={C.textMuted} />
            <TextInput
              style={[styles.inputInline, { marginLeft: 8 }]}
              value={query}
              onChangeText={setQuery}
              placeholder="Search songs or artists"
              placeholderTextColor={C.textFaint}
              autoFocus
              returnKeyType="search"
            />
            {loading && <ActivityIndicator size="small" />}
          </View>
        </View>
        <FlatList
          data={results}
          keyExtractor={(t) => t.trackId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {error || (query.trim() ? (loading ? "" : "No songs found.") : "Search for a song to play a 30-second clip with your post.")}
            </Text>
          }
          renderItem={({ item: t }) => (
            <Pressable style={styles.songRow} onPress={() => choose(t)}>
              {t.artworkUrl ? <Image source={{ uri: t.artworkUrl }} style={styles.songArt} /> : <View style={[styles.songArt, { alignItems: "center", justifyContent: "center" }]}><Ionicons name="musical-notes" size={20} color={C.textMuted} /></View>}
              <View style={{ flex: 1 }}>
                <Text style={styles.messageUser} numberOfLines={1}>{t.title}</Text>
                <Text style={styles.roomInfo} numberOfLines={1}>{t.artist}</Text>
              </View>
              <Pressable style={styles.songPlay} onPress={() => togglePreview(t)} hitSlop={8}>
                <Ionicons name={playingId === t.trackId ? "pause" : "play"} size={18} color={C.white} />
              </Pressable>
            </Pressable>
          )}
        />
      </SafeAreaView>
    </Modal>
  );
}

// Music line on a post in the feed. It starts by itself when the post is on
// screen (and plays the part of the song the author picked); tap the speaker
// to mute, or the song to pause. A thin bar shows how much of the post's
// length has played.
function PostMusicBar({ music, active, maxPlaySec }) {
  const [muted, toggleMute] = usePostsMuted();
  const { isPlaying, progress, toggle } = useClip(music.previewUrl, {
    startSec: music.startSec || 0,
    endSec: music.endSec || null,
    loop: true,
    maxPlaySec: maxPlaySec || null,
    autoplay: true,
    active: !!active,
    muted,
  });
  return (
    <View>
      <View style={styles.postMusicBar}>
        <Pressable onPress={toggle} style={styles.postMusicMain} hitSlop={6}>
          <Ionicons name="musical-notes" size={14} color={C.text} />
          <Text style={styles.postMusicText} numberOfLines={1}>{music.title}{music.artist ? ` · ${music.artist}` : ""}</Text>
          <Ionicons name={isPlaying ? "pause-circle" : "play-circle"} size={22} color={C.accent} />
        </Pressable>
        <Pressable onPress={toggleMute} hitSlop={10} style={styles.postMuteBtn} accessibilityLabel={muted ? "Unmute music" : "Mute music"}>
          <Ionicons name={muted ? "volume-mute" : "volume-high"} size={20} color={muted ? C.textMuted : C.text} />
        </Pressable>
      </View>
      {maxPlaySec ? (
        <View style={styles.postMusicTrack}>
          <View style={[styles.postMusicFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

// A story's song plays by itself while that story is on screen. There is no
// pause or mute here on purpose -- the pill is display-only.
function StoryMusic({ music, maxPlaySec }) {
  const { isPlaying } = useClip(music.previewUrl, {
    startSec: music.startSec || 0,
    endSec: music.endSec || null,
    loop: true,
    maxPlaySec: maxPlaySec || null,
    autoplay: true,
  });
  return (
    <MusicPill
      music={music}
      light
      trailing={<Ionicons name={isPlaying ? "volume-high" : "musical-note"} size={16} color="#fff" />}
    />
  );
}

// Pick which part of the song to use. The 30s preview is drawn as 30 bars (one
// per second); the lit-up bars are what will play. Drag (or tap) to move where
// it starts, or nudge by a second. The play button previews exactly that part.
function MusicTrimmer({ music, durationSec, onChange, width }) {
  const seg = musicSegment(music, durationSec);
  const TW = width - 24;
  const maxStart = CLIP_SEC - MIN_MUSIC_WINDOW;
  const setStart = (sec) => onChange(Math.max(0, Math.min(maxStart, Math.round(sec))));
  const { isPlaying, toggle } = useClip(music.previewUrl, { startSec: seg.start, endSec: seg.end, loop: true, autoplay: false });

  const ref = useRef({});
  ref.current = { TW, setStart };
  const grab = useRef(0);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => { grab.current = e.nativeEvent.locationX; ref.current.setStart((grab.current / ref.current.TW) * CLIP_SEC); },
      onPanResponderMove: (_, g) => ref.current.setStart(((grab.current + g.dx) / ref.current.TW) * CLIP_SEC),
    })
  ).current;

  // Deterministic "waveform" so each song always looks the same.
  const seed = Array.from(String(music.trackId || music.title || "x")).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const bars = Array.from({ length: CLIP_SEC }, (_, i) => {
    const r = Math.sin(seed * 0.001 + i * 1.7) * 43758.5453;
    return 10 + Math.round((r - Math.floor(r)) * 26);
  });

  return (
    <View style={styles.trimBox}>
      <View style={styles.trimHeader}>
        <Pressable style={styles.trimPlay} onPress={toggle} hitSlop={8}>
          <Ionicons name={isPlaying ? "pause" : "play"} size={16} color={C.white} />
        </Pressable>
        <Text style={styles.trimText} numberOfLines={1}>Plays {fmtClock(seg.start)} to {fmtClock(seg.end)}</Text>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.trimNudge} onPress={() => setStart(seg.start - 1)} hitSlop={6}><Ionicons name="remove" size={18} color={C.text} /></Pressable>
        <Pressable style={styles.trimNudge} onPress={() => setStart(seg.start + 1)} hitSlop={6}><Ionicons name="add" size={18} color={C.text} /></Pressable>
      </View>
      <View {...pan.panHandlers} style={[styles.trimTrack, { width: TW }]}>
        {bars.map((h, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={{ width: TW / CLIP_SEC - 2, marginHorizontal: 1, height: h, borderRadius: 2, backgroundColor: i >= seg.start && i < seg.end ? C.accent : C.textFaint, opacity: i >= seg.start && i < seg.end ? 1 : 0.45 }}
          />
        ))}
      </View>
      <Text style={styles.trimHint}>Drag to choose the part of the song to use. It repeats if that part is shorter than the length you picked.</Text>
    </View>
  );
}

// Step between editing the photo and posting: add text stickers and music.
function DecorateStep({ edited, overlays, setOverlays, music, setMusic, isVideo, videoSec, isStory, duration, setDuration, authedApi, title, nextLabel, busy, onBack, onNext }) {
  const [selectedId, setSelectedId] = useState(null);
  const [musicOpen, setMusicOpen] = useState(false);
  const ratio = Math.min(2, Math.max(0.5, (edited.width && edited.height) ? edited.width / edited.height : 1));
  const maxH = SCREEN_HEIGHT * 0.5;
  let fw = EDIT_W;
  let fh = fw / ratio;
  if (fh > maxH) { fh = maxH; fw = fh * ratio; }
  const selected = overlays.find((o) => o.id === selectedId) || null;

  function addText() {
    const o = { id: `t_${Date.now()}`, text: "", color: "#FFFFFF", style: "plain", x: 0.5, y: 0.4, scale: 1 };
    setOverlays([...overlays, o]);
    setSelectedId(o.id);
  }
  function patch(id, p) { setOverlays((old) => old.map((o) => (o.id === id ? { ...o, ...p } : o))); }
  function done() {
    // An empty text sticker is just removed.
    if (selected && !selected.text.trim()) setOverlays(overlays.filter((o) => o.id !== selected.id));
    setSelectedId(null);
  }
  function removeSelected() {
    setOverlays(overlays.filter((o) => o.id !== selectedId));
    setSelectedId(null);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.header, styles.profileHeaderRow]}>
        <Pressable onPress={onBack} hitSlop={10}><Ionicons name="arrow-back" size={24} color={C.text} /></Pressable>
        <Text style={styles.titleSmall}>{title}</Text>
        <Pressable onPress={() => { done(); onNext(); }} disabled={busy} hitSlop={10}>
          {busy ? <ActivityIndicator size="small" color={C.accent} /> : <Text style={styles.headerAction}>{nextLabel}</Text>}
        </Pressable>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ alignItems: "center", paddingBottom: 30 }}>
        <View style={{ width: fw, height: fh, marginTop: 8, backgroundColor: "#000", overflow: "hidden" }}>
          {edited.type === "video" ? (
            <MediaVideo uri={edited.uri} style={{ width: fw, height: fh }} controls={false} />
          ) : (
            <Image source={{ uri: edited.uri }} style={{ width: fw, height: fh }} resizeMode="cover" />
          )}
          <View pointerEvents="box-none" style={{ position: "absolute", left: 0, top: 0, width: fw, height: fh }}>
            {overlays.map((o) => (
              <DraggableOverlay key={o.id} o={o} W={fw} H={fh} selected={o.id === selectedId} onMove={patch} onTap={setSelectedId} />
            ))}
          </View>
        </View>

        <View style={styles.decorateBar}>
          <Pressable style={styles.decorateBtn} onPress={addText}>
            <Text style={styles.decorateAa}>Aa</Text>
            <Text style={styles.editToolText}>Text</Text>
          </Pressable>
          <Pressable style={styles.decorateBtn} onPress={() => setMusicOpen(true)}>
            <Ionicons name="musical-notes-outline" size={22} color={C.text} />
            <Text style={styles.editToolText}>Music</Text>
          </Pressable>
        </View>
        {!isVideo && (
          <View style={[styles.durationBlock, { width: EDIT_W }]}>
            <Text style={styles.durationLabel}>{isStory ? "How long your story shows" : "How long your post plays"}</Text>
            <View style={styles.durationRow}>
              {(isStory ? STORY_PHOTO_SECONDS : POST_PHOTO_SECONDS).map((sec) => (
                <Pressable key={sec} style={[styles.editChip, duration === sec && styles.editChipActive]} onPress={() => setDuration(sec)}>
                  <Text style={[styles.editChipText, duration === sec && { color: C.white }]}>{sec}s</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {isVideo && <Text style={[styles.roomInfo, { marginTop: 10 }]}>Video length {videoSec ? fmtClock(videoSec) : "up to 1:00"} (max 1:00)</Text>}
        {music && (
          <View style={{ marginTop: 10, width: EDIT_W }}>
            <MusicPill music={music} onRemove={() => setMusic(null)} />
            <MusicTrimmer music={music} durationSec={isVideo ? (videoSec || MAX_VIDEO_SEC) : duration} onChange={(startSec) => setMusic({ ...music, startSec })} width={EDIT_W} />
          </View>
        )}
        {!selected && overlays.length > 0 && <Text style={[styles.roomInfo, { marginTop: 10 }]}>Drag text to move it. Tap to edit.</Text>}

        {selected && (
          <View style={[styles.textPanel, { width: EDIT_W }]}>
            <TextInput
              style={[styles.input, { marginBottom: 10 }]}
              value={selected.text}
              onChangeText={(t) => patch(selected.id, { text: t })}
              placeholder="Type something..."
              placeholderTextColor={C.textFaint}
              maxLength={200}
              multiline
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {TEXT_COLORS.map((c) => (
                <Pressable key={c} onPress={() => patch(selected.id, { color: c })} style={[styles.colorDot, { backgroundColor: c }, selected.color === c && styles.colorDotActive]} />
              ))}
            </View>
            <View style={styles.textPanelRow}>
              <Pressable style={[styles.editChip, selected.style === "plain" && styles.editChipActive]} onPress={() => patch(selected.id, { style: "plain" })}>
                <Text style={[styles.editChipText, selected.style === "plain" && { color: C.white }]}>Plain</Text>
              </Pressable>
              <Pressable style={[styles.editChip, selected.style === "box" && styles.editChipActive]} onPress={() => patch(selected.id, { style: "box" })}>
                <Text style={[styles.editChipText, selected.style === "box" && { color: C.white }]}>Box</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable style={styles.zoomBtn} onPress={() => patch(selected.id, { scale: Math.max(0.5, +(selected.scale - 0.2).toFixed(2)) })}><Ionicons name="remove" size={20} color={C.text} /></Pressable>
              <Pressable style={styles.zoomBtn} onPress={() => patch(selected.id, { scale: Math.min(3, +(selected.scale + 0.2).toFixed(2)) })}><Ionicons name="add" size={20} color={C.text} /></Pressable>
            </View>
            <View style={styles.textPanelRow}>
              <Pressable onPress={removeSelected} hitSlop={8}><Text style={{ color: C.danger || "#E5484D", fontWeight: "800" }}>Delete</Text></Pressable>
              <View style={{ flex: 1 }} />
              <Pressable style={styles.smallButton} onPress={done}><Text style={styles.buttonText}>Done</Text></Pressable>
            </View>
          </View>
        )}
      </ScrollView>
      <MusicPicker visible={musicOpen} authedApi={authedApi} onClose={() => setMusicOpen(false)} onPick={(t) => setMusic({ ...t, startSec: 0 })} />
    </KeyboardAvoidingView>
  );
}

// ===================== Stories =====================
function groupStories(stories, me) {
  const map = new Map();
  for (const s of stories) {
    if (!map.has(s.userId)) map.set(s.userId, { userId: s.userId, userName: s.userName, userAvatarUrl: s.userAvatarUrl, stories: [] });
    map.get(s.userId).stories.push(s);
  }
  const mine = map.get(me?.id) || { userId: me?.id, userName: me?.name, userAvatarUrl: me?.avatarUrl, stories: [] };
  map.delete(me?.id);
  const others = [...map.values()].sort((a, b) => {
    const au = a.stories.some((s) => !s.viewedByMe) ? 0 : 1;
    const bu = b.stories.some((s) => !s.viewedByMe) ? 0 : 1;
    return au - bu;
  });
  return [mine, ...others];
}

function StoriesBar({ groups, onView, onAdd }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.storiesRow}>
      {groups.map((g, i) => {
        const isMine = i === 0;
        const has = g.stories.length > 0;
        const unseen = has && g.stories.some((s) => !s.viewedByMe);
        const ringColor = !has ? "transparent" : unseen ? C.accent : C.border;
        return (
          <Pressable key={g.userId || "me"} style={styles.storyItem} onPress={() => (has ? onView(g) : isMine ? onAdd() : null)}>
            <View style={[styles.storyRing, { borderColor: ringColor }]}>
              <UserAvatar name={g.userName} avatarUrl={g.userAvatarUrl} size={58} />
              {isMine && (
                <Pressable style={styles.storyPlus} onPress={onAdd} hitSlop={6}>
                  <Ionicons name="add" size={14} color={C.white} />
                </Pressable>
              )}
            </View>
            <Text style={styles.storyName} numberOfLines={1}>{isMine ? "Your story" : g.userName}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function StoryVideo({ uri, onDuration, muted = false }) {
  const player = useVideoPlayer(uri, (p) => { if (p) { p.loop = false; p.muted = muted; p.play(); } });
  useEffect(() => {
    if (!player || !player.addListener) return;
    const sub = player.addListener("sourceLoad", (e) => { if (e && e.duration) onDuration(e.duration); });
    return () => sub && sub.remove && sub.remove();
  }, [player]);
  return <VideoView style={StyleSheet.absoluteFill} player={player} contentFit="contain" nativeControls={false} />;
}

function StoryViewer({ groups, startIndex, me, authedApi, onClose, onViewed, onDeleted, onReshared }) {
  const firstUnseen = (g) => Math.max(0, g.stories.findIndex((s) => !s.viewedByMe));
  const [gi, setGi] = useState(startIndex);
  const [si, setSi] = useState(() => firstUnseen(groups[startIndex]));
  const [tick, setTick] = useState(0);
  const [vidDur, setVidDur] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [adding, setAdding] = useState(false);
  const [box, setBox] = useState({ w: 1, h: 1 });
  const progress = useRef(new Animated.Value(0)).current;
  const group = groups[gi];
  const story = group?.stories[si];
  const isMine = group?.userId === me?.id;
  const isVideo = story?.media?.mimeType?.startsWith("video/");

  function next() {
    if (si < group.stories.length - 1) setSi(si + 1);
    else if (gi < groups.length - 1) { setGi(gi + 1); setSi(0); }
    else onClose();
  }
  function prev() {
    if (si > 0) setSi(si - 1);
    else if (gi > 0) { setGi(gi - 1); setSi(0); }
    else setTick((t) => t + 1);
  }

  useEffect(() => {
    if (!story) return;
    setVidDur(null);
    if (!isMine && !story.viewedByMe) {
      onViewed(story);
      authedApi(`/api/stories/${story.id}/view`, { method: "POST" }).catch(() => {});
    }
  }, [story?.id]);

  useEffect(() => {
    if (!story || confirmDel) return;
    progress.setValue(0);
    // Photo stories stay up for the length their author chose (3-15s, 5s if
    // unset); video stories play for the video's own length, capped at 60s.
    const ms = isVideo ? (vidDur ? Math.min(vidDur, MAX_VIDEO_SEC) * 1000 : 15000) : Math.min(15, Math.max(3, Number(story.duration) || 5)) * 1000;
    const anim = Animated.timing(progress, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: false });
    anim.start(({ finished }) => { if (finished) next(); });
    return () => anim.stop();
  }, [story?.id, vidDur, tick, confirmDel]);

  async function remove() {
    try {
      const res = await authedApi(`/api/stories/${story.id}`, { method: "DELETE" });
      if (!res.ok) return Alert.alert("Couldn't delete", "Please try again.");
      onDeleted(story);
      onClose();
    } catch (_) { Alert.alert("Couldn't delete", "Check your connection and try again."); }
  }

  // Someone tagged you in this story: put it on your own story.
  async function addToMyStory() {
    if (adding) return;
    setAdding(true);
    try {
      const res = await authedApi(`/api/stories/${story.id}/reshare`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok || res.status === 409) { onReshared && onReshared(story, res.ok ? data.story : null); Alert.alert("Added", "This story is now on your story."); }
      else Alert.alert("Couldn't add to your story", data.error || "Something went wrong.");
    } catch (_) { Alert.alert("Couldn't add to your story", "Check your connection and try again."); }
    finally { setAdding(false); }
  }

  if (!story) return null;
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#000" }} edges={["top", "bottom"]}>
        <View style={{ flex: 1, alignItems: "center" }}>
          <View style={{ flex: 1, width: "100%", maxWidth: 480 }}>
            <View style={StyleSheet.absoluteFill} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
              {(() => {
                const r = story.media?.width && story.media?.height ? story.media.width / story.media.height : 9 / 16;
                let fw = box.w, fh = box.w / r;
                if (fh > box.h) { fh = box.h; fw = box.h * r; }
                return (
                  <View style={{ position: "absolute", left: (box.w - fw) / 2, top: (box.h - fh) / 2, width: fw, height: fh, overflow: "hidden" }}>
                    {isVideo ? (
                      <StoryVideo key={story.id} uri={story.media.url} onDuration={setVidDur} muted={!!story.music} />
                    ) : (
                      <Image source={{ uri: story.media?.url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                    )}
                    <OverlayLayer overlays={story.overlays} W={fw} H={fh} />
                  </View>
                );
              })()}
            </View>
            <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row" }}>
              <Pressable style={{ flex: 1 }} onPress={prev} />
              <Pressable style={{ flex: 2 }} onPress={next} />
            </View>
            <View pointerEvents="box-none" style={styles.storyTop}>
              <View style={{ flexDirection: "row", gap: 4 }}>
                {group.stories.map((s, i) => (
                  <View key={s.id} style={styles.storyBarBg}>
                    <Animated.View style={[styles.storyBarFill, { width: i < si ? "100%" : i === si ? progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) : "0%" }]} />
                  </View>
                ))}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
                <UserAvatar name={group.userName} avatarUrl={group.userAvatarUrl} size={34} style={{ marginRight: 10 }} />
                <Text style={styles.storyHeaderName}>{isMine ? "Your story" : group.userName}</Text>
                <Text style={styles.storyHeaderTime}>  {timeAgo(story.createdAt)}</Text>
                <View style={{ flex: 1 }} />
                {isMine && (
                  <Pressable onPress={() => setConfirmDel(true)} hitSlop={10} style={{ padding: 6 }}>
                    <Ionicons name="trash-outline" size={22} color="#fff" />
                  </Pressable>
                )}
                <Pressable onPress={onClose} hitSlop={10} style={{ padding: 6 }}>
                  <Ionicons name="close" size={28} color="#fff" />
                </Pressable>
              </View>
            </View>
            {story.music && (
              <View pointerEvents="box-none" style={styles.storyMusicWrap}>
                <StoryMusic key={story.id} music={story.music} maxPlaySec={isVideo ? null : Math.min(15, Math.max(3, Number(story.duration) || 5))} />
              </View>
            )}
            {(story.sharedFrom || (story.mentionUsers || []).length > 0 || story.canReshare) && (
              <View pointerEvents="box-none" style={styles.storyTagWrap}>
                {story.sharedFrom ? <Text style={styles.storyTagText}>Shared from @{story.sharedFrom.userName}</Text> : null}
                {!story.sharedFrom && (story.mentionUsers || []).length > 0 ? (
                  <Text style={styles.storyTagText} numberOfLines={2}>{(story.mentionUsers || []).map((u, i) => `${i ? " " : ""}@${u.username}`).join("")}</Text>
                ) : null}
                {story.canReshare ? (
                  <Pressable style={styles.storyAddBtn} onPress={addToMyStory} disabled={adding}>
                    <Ionicons name="add-circle-outline" size={20} color="#fff" />
                    <Text style={styles.storyAddText}>{adding ? "Adding…" : "Add to your story"}</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
            {(!!story.text || isMine) && (
              <View pointerEvents="none" style={styles.storyBottom}>
                {!!story.text && <Text style={styles.storyCaption}>{story.text}</Text>}
                {isMine && <Text style={styles.storyViews}>👁 {story.viewCount || 0} {story.viewCount === 1 ? "view" : "views"}{story.audienceCount != null ? `  ·  🔒 ${story.audienceCount} ${story.audienceCount === 1 ? "person" : "people"}` : ""}</Text>}
              </View>
            )}
          </View>
        </View>
        <ActionSheet
          visible={confirmDel}
          title="Delete this story?"
          actions={[{ label: "Delete story", icon: "trash-outline", destructive: true, onPress: remove }]}
          onClose={() => setConfirmDel(false)}
        />
      </SafeAreaView>
    </Modal>
  );
}

function PostVideo({ uri }) {
  const player = useVideoPlayer(uri, (p) => { if (p) { p.loop = false; } });
  return <VideoView style={styles.postMediaVideo} player={player} allowsFullscreen nativeControls />;
}

// "Settings and activity": full-screen list in the Instagram style -- search box on top,
// grouped rows (icon, title, value, chevron) and the account actions at the bottom.
// Opened from the gear icon on Profile.
function SettingsModal({ visible, onClose, themeMode, onChangeTheme, onLogout, authedApi, accounts = [], currentId, currentUsername, onSwitch, onAddAccount, onEditBio }) {
  const [page, setPage] = useState("main"); // main | accounts | appearance | notifications
  const [q, setQ] = useState("");
  useEffect(() => { if (visible) { setPage("main"); setQ(""); } }, [visible]);
  const themeOptions = [
    { key: "system", label: "System", icon: "phone-portrait-outline" },
    { key: "light", label: "Light", icon: "sunny-outline" },
    { key: "dark", label: "Dark", icon: "moon-outline" },
  ];
  const themeLabel = (themeOptions.find((o) => o.key === themeMode) || themeOptions[0]).label;
  const danger = C.danger || "#E5484D";
  const sections = [
    {
      title: "Your account",
      rows: [
        { key: "accounts", icon: "person-circle-outline", title: "Accounts", sub: "Switch accounts or add another one", value: currentUsername ? `@${currentUsername}` : null, onPress: () => setPage("accounts") },
        ...(onEditBio ? [{ key: "bio", icon: "create-outline", title: "Edit bio", sub: "Change what shows on your profile", onPress: () => { onClose(); onEditBio(); } }] : []),
      ],
    },
    {
      title: "How you use Hush",
      rows: [
        ...(Platform.OS === "web" ? [{ key: "notifications", icon: "notifications-outline", title: "Notifications", sub: "Alerts for messages, likes and requests", onPress: () => setPage("notifications") }] : []),
        { key: "appearance", icon: "contrast-outline", title: "Appearance", sub: "Light, dark or match your phone", value: themeLabel, onPress: () => setPage("appearance") },
      ],
    },
    {
      title: "Login",
      rows: [
        { key: "add", icon: "person-add-outline", title: "Add account", onPress: () => { onClose(); onAddAccount && onAddAccount(); } },
        { key: "logout", icon: "log-out-outline", title: currentUsername ? `Log out @${currentUsername}` : "Log out", destructive: true, onPress: onLogout },
      ],
    },
  ];
  const needle = q.trim().toLowerCase();
  const shownSections = sections
    .map((sec) => ({ ...sec, rows: sec.rows.filter((r) => !needle || `${r.title} ${r.sub || ""}`.toLowerCase().includes(needle)) }))
    .filter((sec) => sec.rows.length);

  const Row = ({ row }) => (
    <Pressable style={({ pressed }) => [styles.setRow, pressed && { opacity: 0.6 }]} onPress={row.onPress}>
      <Ionicons name={row.icon} size={26} color={row.destructive ? danger : C.text} style={{ width: 34 }} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.setRowTitle, row.destructive && { color: danger }]} numberOfLines={1}>{row.title}</Text>
        {!!row.sub && <Text style={styles.setRowSub} numberOfLines={2}>{row.sub}</Text>}
      </View>
      {!!row.value && <Text style={styles.setRowValue} numberOfLines={1}>{row.value}</Text>}
      {!row.destructive && <Ionicons name="chevron-forward" size={20} color={C.textMuted} />}
    </Pressable>
  );

  const titles = { main: "Settings and activity", accounts: "Accounts", appearance: "Appearance", notifications: "Notifications" };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => (page === "main" ? onClose() : setPage("main"))}>
      <SafeAreaView style={styles.container} edges={["top", "left", "right", "bottom"]}>
        <View style={styles.setHeader}>
          <Pressable style={styles.setBack} onPress={() => (page === "main" ? onClose() : setPage("main"))} hitSlop={10}>
            <Ionicons name="chevron-back" size={24} color={C.text} />
          </Pressable>
          <Text style={styles.setHeaderTitle}>{titles[page]}</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {page === "main" && (
            <>
              <View style={styles.setSearch}>
                <Ionicons name="search" size={20} color={C.textMuted} />
                <TextInput style={styles.setSearchInput} value={q} onChangeText={setQ} placeholder="Search" placeholderTextColor={C.textMuted} autoCapitalize="none" autoCorrect={false} />
                {!!q && <Pressable onPress={() => setQ("")} hitSlop={8}><Ionicons name="close-circle" size={18} color={C.textMuted} /></Pressable>}
              </View>
              {shownSections.map((sec, i) => (
                <View key={sec.title}>
                  {i > 0 && <View style={styles.setBand} />}
                  <Text style={styles.setSectionTitle}>{sec.title}</Text>
                  {sec.rows.map((row) => <Row key={row.key} row={row} />)}
                </View>
              ))}
              {shownSections.length === 0 && <Text style={[styles.empty, { marginTop: 40 }]}>No results for "{q}".</Text>}
            </>
          )}

          {page === "accounts" && (
            <View style={{ paddingTop: 8 }}>
              {accounts.map((a) => {
                const active = a.user.id === currentId;
                return (
                  <Pressable key={a.user.id} style={styles.setRow} onPress={() => { if (!active && onSwitch) onSwitch(a); }}>
                    <UserAvatar name={a.user.name} avatarUrl={a.user.avatarUrl} size={42} style={{ marginRight: 12 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.setRowTitle} numberOfLines={1}>{a.user.name}</Text>
                      <Text style={styles.setRowSub} numberOfLines={1}>@{a.user.username}</Text>
                    </View>
                    {active ? <Ionicons name="checkmark-circle" size={24} color={C.accent} /> : <Text style={styles.headerAction}>Switch</Text>}
                  </Pressable>
                );
              })}
              <Row row={{ key: "add2", icon: "add-circle-outline", title: "Add account", onPress: () => { onClose(); onAddAccount && onAddAccount(); } }} />
            </View>
          )}

          {page === "appearance" && (
            <View style={{ paddingTop: 8 }}>
              {themeOptions.map((opt) => {
                const active = themeMode === opt.key;
                return (
                  <Pressable key={opt.key} style={styles.setRow} onPress={() => onChangeTheme(opt.key)}>
                    <Ionicons name={opt.icon} size={26} color={C.text} style={{ width: 34 }} />
                    <Text style={[styles.setRowTitle, { flex: 1 }]}>{opt.label}</Text>
                    <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={24} color={active ? C.accent : C.textMuted} />
                  </Pressable>
                );
              })}
            </View>
          )}

          {page === "notifications" && Platform.OS === "web" && (
            <View style={{ padding: 16 }}>
              <NotificationSettingsRow authedApi={authedApi} colors={C} />
            </View>
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// Bio editor, opened from the pencil next to a (possibly empty) bio on
// Profile. Saves straight to PATCH /api/me and hands the updated user back
// to the caller so the header above it updates immediately.
function EditBioModal({ visible, initialBio, authedApi, onClose, onSaved }) {
  const [bio, setBio] = useState(initialBio || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setBio(initialBio || ""); }, [initialBio, visible]);

  async function save() {
    setSaving(true);
    try {
      const res = await authedApi("/api/me", { method: "PATCH", body: JSON.stringify({ bio: bio.trim() }) });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Couldn't save", data.error || "Something went wrong.");
      onSaved(data.user);
      onClose();
    } catch (e) {
      Alert.alert("Couldn't save", "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.modalHeaderRow}>
            <Text style={styles.titleSmall}>Edit bio</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={C.textMuted} />
            </Pressable>
          </View>
          <TextInput
            style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
            value={bio}
            onChangeText={setBio}
            placeholder="Tell people a bit about yourself…"
            placeholderTextColor={C.textFaint}
            multiline
            maxLength={280}
          />
          <Text style={[styles.muted, { textAlign: "right", marginTop: -6 }]}>{bio.length}/280</Text>
          <Pressable style={[styles.button, { marginTop: 12 }, saving && { opacity: 0.7 }]} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color={C.white} /> : <Text style={styles.buttonText}>Save bio</Text>}
          </Pressable>
          </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Drag to position, +/- (or the bar) to zoom, then "Use photo" crops exactly
// what is inside the circle and resizes it to 512x512.
const CROP_SIZE = Math.min(300, SCREEN_WIDTH - 64);
const MAX_ZOOM = 4;
function AvatarCropModal({ asset, onCancel, onDone }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const live = useRef({ zoom: 1, x: 0, y: 0, w: 1, h: 1 });
  const dragStart = useRef({ x: 0, y: 0 });

  const w = asset?.width || 1;
  const h = asset?.height || 1;
  const cover = CROP_SIZE / Math.min(w, h); // scale at which the photo just fills the circle
  live.current.w = w; live.current.h = h;

  function clamp(x, y, z) {
    const scale = cover * z;
    const maxX = Math.max(0, (w * scale - CROP_SIZE) / 2);
    const maxY = Math.max(0, (h * scale - CROP_SIZE) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  }
  function apply(next) {
    live.current = { ...live.current, ...next };
    setZoom(live.current.zoom);
    setOffset({ x: live.current.x, y: live.current.y });
  }
  useEffect(() => { if (asset) apply({ zoom: 1, x: 0, y: 0 }); }, [asset?.uri]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { dragStart.current = { x: live.current.x, y: live.current.y }; },
      onPanResponderMove: (_, g) => {
        const { zoom: z, w: lw, h: lh } = live.current;
        const scale = (CROP_SIZE / Math.min(lw, lh)) * z;
        const maxX = Math.max(0, (lw * scale - CROP_SIZE) / 2);
        const maxY = Math.max(0, (lh * scale - CROP_SIZE) / 2);
        const x = Math.min(maxX, Math.max(-maxX, dragStart.current.x + g.dx));
        const y = Math.min(maxY, Math.max(-maxY, dragStart.current.y + g.dy));
        live.current.x = x; live.current.y = y;
        setOffset({ x, y });
      },
    })
  ).current;

  function setZoomTo(z) {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    const c = clamp(live.current.x, live.current.y, nz);
    apply({ zoom: nz, ...c });
  }
  // Tap/click anywhere on the bar to jump to that zoom level.
  function onBarPress(e) {
    const x = e.nativeEvent.locationX;
    setZoomTo(1 + (x / BAR_W) * (MAX_ZOOM - 1));
  }
  const BAR_W = 180;

  async function confirm() {
    setBusy(true);
    try {
      const scale = cover * zoom;
      const size = CROP_SIZE / scale; // side of the visible square, in source pixels
      let originX = w / 2 - size / 2 - offset.x / scale;
      let originY = h / 2 - size / 2 - offset.y / scale;
      originX = Math.max(0, Math.min(w - size, originX));
      originY = Math.max(0, Math.min(h - size, originY));
      const ctx = ImageManipulator.ImageManipulator.manipulate(asset.uri);
      ctx.crop({ originX: Math.round(originX), originY: Math.round(originY), width: Math.round(size), height: Math.round(size) });
      ctx.resize({ width: 512, height: 512 });
      const ref = await ctx.renderAsync();
      const out = await ref.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 });
      onDone({ uri: out.uri, fileName: "avatar.jpg", mimeType: "image/jpeg" });
    } catch (e) {
      Alert.alert("Couldn't crop", "Please try a different photo.");
    } finally {
      setBusy(false);
    }
  }

  if (!asset) return null;
  const scale = cover * zoom;
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onCancel}>
      <View style={[styles.modalBackdrop, { justifyContent: "center", padding: 16 }]}>
        <View style={[styles.modalSheet, { borderRadius: 24 }]}>
          <View style={styles.modalHeaderRow}>
            <Text style={styles.titleSmall}>Adjust photo</Text>
            <Pressable onPress={onCancel} hitSlop={10}><Ionicons name="close" size={24} color={C.textMuted} /></Pressable>
          </View>
          <Text style={[styles.roomInfo, { textAlign: "center", marginBottom: 12 }]}>Drag to move, zoom to resize</Text>
          <View style={[styles.cropViewport, { width: CROP_SIZE, height: CROP_SIZE, borderRadius: CROP_SIZE / 2 }]} {...pan.panHandlers}>
            <Image
              source={{ uri: asset.uri }}
              style={{
                position: "absolute",
                width: w * scale,
                height: h * scale,
                left: CROP_SIZE / 2 - (w * scale) / 2 + offset.x,
                top: CROP_SIZE / 2 - (h * scale) / 2 + offset.y,
              }}
              draggable={false}
            />
            <View pointerEvents="none" style={[styles.cropRing, { borderRadius: CROP_SIZE / 2 }]} />
          </View>
          <View style={styles.zoomRow}>
            <Pressable style={styles.zoomBtn} onPress={() => setZoomTo(zoom - 0.25)}><Ionicons name="remove" size={22} color={C.text} /></Pressable>
            <Pressable onPress={onBarPress} hitSlop={{ top: 14, bottom: 14 }} style={[styles.zoomTrack, { width: BAR_W }]}>
              <View pointerEvents="none" style={[styles.zoomFill, { width: ((zoom - 1) / (MAX_ZOOM - 1)) * BAR_W }]} />
            </Pressable>
            <Pressable style={styles.zoomBtn} onPress={() => setZoomTo(zoom + 0.25)}><Ionicons name="add" size={22} color={C.text} /></Pressable>
          </View>
          <Pressable style={[styles.button, { marginTop: 20 }, busy && { opacity: 0.7 }]} onPress={confirm} disabled={busy}>
            {busy ? <ActivityIndicator color={C.white} /> : <Text style={styles.buttonText}>Use photo</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function ProfileTab({ me, token, authedApi, onLogout, accounts = [], onSwitchAccount, onAddAccount, onUpdateMe, themeMode, onChangeTheme }) {
  const chrome = useContext(ScrollChromeContext);
  const [posts, setPosts] = useState([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bioModalOpen, setBioModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const activePost = useActivePost(settingsOpen || bioModalOpen || !!editingPost);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [cropAsset, setCropAsset] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => { setAvatarFailed(false); }, [me?.avatarUrl]);

  const load = async () => {
    setLoadingPosts(true);
    try {
      const res = await authedApi("/api/posts");
      if (res.status === 401) return;
      const data = await res.json();
      setPosts((data.posts || []).filter((p) => p.userId === me?.id));
    } catch (e) {
      // Own posts failing to load isn't worth an alert here -- the empty
      // state below already communicates it, and Home's feed already
      // surfaces connection problems loudly.
    } finally {
      setLoadingPosts(false);
    }
  };
  useEffect(() => { load(); }, [me?.id]);

  // Step 1: pick a photo. Step 2: AvatarCropModal lets the person drag and
  // zoom it inside a circle (the built-in picker editor doesn't exist on
  // web). Step 3: the cropped 512px square is uploaded.
  async function changeAvatar() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Permission needed", "Allow photo access to set a profile photo.");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (result.canceled) return;
    setCropAsset(result.assets[0]);
  }

  async function uploadCropped(cropped) {
    setCropAsset(null);
    setUploadingAvatar(true);
    try {
      const asset = cropped;
      const data = await uploadAsset(token, {
        uri: asset.uri,
        fileName: asset.fileName || "avatar.jpg",
        mimeType: asset.mimeType || "image/jpeg",
      }, { endpoint: "/api/me/avatar", purpose: "avatar" });
      onUpdateMe(data.user);
    } catch (e) {
      Alert.alert("Upload failed", e.message || "Could not upload that photo.");
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function deletePost(post) {
    try {
      const res = await authedApi(`/api/posts/${post.id}`, { method: "DELETE" });
      if (res.status === 401) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return Alert.alert("Couldn't delete", data.error || "Something went wrong.");
      }
      setPosts((old) => old.filter((p) => p.id !== post.id));
    } catch (e) {
      Alert.alert("Couldn't delete", "Check your connection and try again.");
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, styles.profileHeaderRow]}>
        <Text style={styles.titleSmall}>Profile</Text>
        <Pressable style={styles.gearButton} onPress={() => setSettingsOpen(true)} hitSlop={8}>
          <Ionicons name="settings-outline" size={19} color={C.text} />
        </Pressable>
      </View>

      <FlatList
        contentContainerStyle={{ paddingBottom: 24 + TAB_SPACE }}
        onScroll={chrome.onScroll}
        scrollEventThrottle={16}
        data={posts}
        keyExtractor={(item) => item.id}
        extraData={activePost.activeId}
        onViewableItemsChanged={activePost.onViewableItemsChanged}
        viewabilityConfig={activePost.viewabilityConfig}
        renderItem={({ item }) => (
          <View>
            <PostCard item={item} isActive={item.id === activePost.activeId} isOwner me={me} authedApi={authedApi} onEdit={setEditingPost} onDelete={deletePost} onChanged={(p) => setPosts((old) => old.map((x) => (x.id === p.id ? p : x)))} />
          </View>
        )}
        ListHeaderComponent={
          <>
            <View style={{ alignItems: "center", marginTop: 20 }}>
              <Pressable onPress={changeAvatar} disabled={uploadingAvatar}>
                <View style={[styles.avatarLarge, { backgroundColor: colorFor(me?.username || "?") }]}>
                  {uploadingAvatar ? (
                    <ActivityIndicator color={C.white} />
                  ) : me?.avatarUrl && !avatarFailed ? (
                    <Image source={{ uri: me.avatarUrl }} style={styles.avatarLargeImg} onError={() => setAvatarFailed(true)} />
                  ) : (
                    <Text style={[styles.avatarText, { fontSize: 32 }]}>{(me?.name || "?")[0].toUpperCase()}</Text>
                  )}
                </View>
                <View style={styles.avatarEditBadge}>
                  <Ionicons name="camera" size={15} color={C.white} />
                </View>
              </Pressable>
              <Text style={[styles.titleSmall, { marginTop: 14 }]}>{me?.name}</Text>
              <Text style={styles.roomInfo}>@{me?.username}</Text>
            </View>

            <View style={styles.bioBlock}>
              {me?.bio ? (
                <Text style={styles.bioText}>{me.bio}</Text>
              ) : (
                <Text style={styles.bioPlaceholder}>No bio yet.</Text>
              )}
              <Pressable style={styles.bioEditRow} onPress={() => setBioModalOpen(true)}>
                <Ionicons name="pencil-outline" size={13} color={C.accent} />
                <Text style={styles.bioEditLabel}>{me?.bio ? "Edit bio" : "Add a bio"}</Text>
              </Pressable>
            </View>

            <View style={styles.statsRow}>
              <View style={styles.statBlock}>
                <Text style={styles.statNumber}>{posts.length}</Text>
                <Text style={styles.statLabel}>Posts</Text>
              </View>
            </View>

            <View style={styles.divider} />
            <Text style={[styles.sectionLabel, { marginHorizontal: 16 }]}>Your posts</Text>
          </>
        }
        ListEmptyComponent={
          loadingPosts ? (
            <ActivityIndicator style={{ marginTop: 30 }} />
          ) : (
            <Text style={styles.empty}>Posts you share on Home will show up here.</Text>
          )
        }
      />

      <SettingsModal
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeMode={themeMode}
        onChangeTheme={onChangeTheme}
        onLogout={() => { setSettingsOpen(false); onLogout(); }}
        accounts={accounts}
        currentId={me?.id}
        currentUsername={me?.username}
        onSwitch={(a) => { setSettingsOpen(false); onSwitchAccount && onSwitchAccount(a); }}
        onAddAccount={() => { setSettingsOpen(false); onAddAccount && onAddAccount(); }}
        onEditBio={() => setBioModalOpen(true)}
        authedApi={authedApi}
      />
      <EditBioModal
        visible={bioModalOpen}
        initialBio={me?.bio}
        authedApi={authedApi}
        onClose={() => setBioModalOpen(false)}
        onSaved={onUpdateMe}
      />
      <AvatarCropModal asset={cropAsset} onCancel={() => setCropAsset(null)} onDone={uploadCropped} />
      <EditPostModal
        visible={!!editingPost}
        post={editingPost}
        token={token}
        authedApi={authedApi}
        onClose={() => setEditingPost(null)}
        onSaved={(updated) => setPosts((old) => old.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)))}
      />
    </View>
  );

}

// Two restrained, professional palettes -- a near-black/near-white dark
// theme and a soft off-white/charcoal light theme -- built from the same
// small set of roles (bg/surface/text/accent/border) so every screen reads
// as one coherent product in either mode instead of colors picked ad hoc.
// A single desaturated slate-blue accent marks primary actions and active
// states; everything else stays neutral so the accent reads as "the thing
// to tap" instead of competing for attention.
const DARK_C = {
  mode: "dark",
  bg: "#0b0b10",
  surface: "#17161f",
  surfaceRaised: "#201f2c",
  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",
  white: "#ffffff",
  text: "#ffffff",
  textMuted: "#a3a0b0",
  textFaint: "#726f80",
  black: "#000000",
  accent: "#6C7CE0",
  accentSoft: "rgba(108,124,224,0.16)",
  danger: "#E0736C",
};
const LIGHT_C = {
  mode: "light",
  bg: "#f5f5f7",
  surface: "#ffffff",
  surfaceRaised: "#eceef2",
  border: "rgba(15,15,20,0.09)",
  borderStrong: "rgba(15,15,20,0.16)",
  white: "#ffffff",
  text: "#17161f",
  textMuted: "#5c5a68",
  textFaint: "#8b899a",
  black: "#000000",
  accent: "#4D5FD1",
  accentSoft: "rgba(77,95,209,0.10)",
  danger: "#C24A43",
};
// `C`/`styles` are intentionally `let`, not `const`: every component reads
// their properties fresh at render time (e.g. `C.bg`, `styles.container`),
// so reassigning these two module-level bindings when the person changes
// their appearance setting -- see applyTheme() in App() -- repaints the
// whole app without threading a theme prop/context through every screen.
let C = DARK_C;
function buildStyles(C) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: C.bg,
  },
  logo: { color: C.text, fontSize: 38, fontWeight: "900", marginBottom: 8 },
  titleSmall: { color: C.text, fontSize: 23, fontWeight: "800" },
  subtitle: { color: C.textMuted, fontSize: 16, marginBottom: 24 },
  muted: { color: C.textMuted, marginTop: 10, textAlign: "center" },
  input: {
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  inputInline: {
    flex: 1,
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 46,
    borderWidth: 1,
    borderColor: C.border,
  },
  button: {
    backgroundColor: C.accent,
    padding: 15,
    borderRadius: 14,
    alignItems: "center",
    shadowColor: C.accent,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  smallButton: {
    backgroundColor: C.accent,
    paddingVertical: 11,
    paddingHorizontal: 15,
    borderRadius: 12,
    justifyContent: "center",
  },
  buttonText: { color: C.white, fontWeight: "800" },
  link: {
    color: C.accent,
    marginTop: 15,
    textAlign: "center",
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  header: {
    padding: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.surface,
  },
  back: { color: C.text, fontSize: 34, lineHeight: 34 },
  roomInfo: { color: C.textMuted, marginTop: 2 },
  live: { color: C.textFaint, fontWeight: "800", fontSize: 11 },
  liveOn: { color: "#3ddc84" },
  artistInline: { color: C.textMuted, marginTop: 2, fontSize: 13 },
  musicThumbSm: { width: 40, height: 40, borderRadius: 8, backgroundColor: C.surfaceRaised },
  mediaImage: { borderRadius: 14, backgroundColor: C.surfaceRaised },
  mediaVideo: { width: Math.min(280, SCREEN_WIDTH * 0.68), aspectRatio: 16 / 9, borderRadius: 14, backgroundColor: "#000" },
  postMediaImage: { borderRadius: 14, marginTop: 8, backgroundColor: C.surfaceRaised },
  postMediaVideo: { width: "100%", aspectRatio: 16 / 9, borderRadius: 14, marginTop: 8, backgroundColor: "#000" },
  mediaPreviewWrap: { marginHorizontal: 16, marginBottom: 8, position: "relative" },
  mediaPreviewImage: { width: 90, height: 90, borderRadius: 12, backgroundColor: C.surfaceRaised },
  removeMediaBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
  chat: { flex: 1, padding: 16 },
  message: {
    backgroundColor: C.surface,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    maxWidth: "85%",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: C.border,
  },
  myMessage: {
    alignSelf: "flex-end",
    backgroundColor: C.accent,
    borderColor: C.accent,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 6,
  },
  myMessageText: { color: C.white },
  postCard: {
    backgroundColor: C.surface,
    borderRadius: 18,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  messageUser: { color: C.text, fontWeight: "800", marginBottom: 4 },
  messageText: { color: C.text, fontSize: 16, lineHeight: 22 },
  time: { color: C.textFaint, fontSize: 10, marginTop: 8, alignSelf: "flex-end" },
  myTime: { color: "rgba(255,255,255,0.65)" },
  bubbleFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 8 },
  quote: { backgroundColor: C.surfaceRaised, borderLeftWidth: 3, borderLeftColor: C.accent, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, marginBottom: 8 },
  quoteMine: { backgroundColor: "rgba(255,255,255,0.18)", borderLeftColor: C.white },
  quoteName: { color: C.accent, fontSize: 12, fontWeight: "800", marginBottom: 2 },
  quoteText: { color: C.textMuted, fontSize: 13 },
  replyBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.surface },
  replyBarName: { color: C.accent, fontSize: 12, fontWeight: "800" },
  replyBarText: { color: C.textMuted, fontSize: 13, marginTop: 1 },
  reactionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  reactionChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: C.surfaceRaised, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingVertical: 2, paddingHorizontal: 8 },
  reactionChipOnMine: { backgroundColor: "rgba(255,255,255,0.18)", borderColor: "rgba(255,255,255,0.3)" },
  reactionChipMine: { borderColor: C.accent, borderWidth: 1.5 },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { color: C.text, fontSize: 12, fontWeight: "700" },
  emojiRow: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 8, marginBottom: 6 },
  emojiBtn: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  emojiBtnActive: { backgroundColor: C.accentSoft },
  emojiText: { fontSize: 28 },
  empty: { color: C.textMuted, textAlign: "center", marginTop: 30 },
  attachRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    gap: 7,
  },
  plusButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: C.accent,
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  plusIcon: { color: C.white, fontSize: 24, fontWeight: "600", lineHeight: 26, marginTop: -2 },
  attachOptionsRow: {
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  attachOption: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
    marginRight: 7,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  iconButtonSm: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  icon: { color: C.text, fontSize: 20 },
  messageInput: {
    flex: 1,
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 12,
    minHeight: 44,
    borderWidth: 1,
    borderColor: C.border,
  },
  send: {
    backgroundColor: C.accent,
    borderRadius: 14,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  sendDisabled: { backgroundColor: C.surfaceRaised },
  musicShare: { color: C.text, fontWeight: "800", fontSize: 16 },
  audioCard: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 200 },
  audioPlayBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  audioPlayText: { color: C.white, fontWeight: "900", fontSize: 15 },
  audioTrack: { height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.18)", marginTop: 8, overflow: "hidden" },
  audioTrackFill: { height: 4, borderRadius: 2, backgroundColor: C.accent },
  createBox: { flexDirection: "row", padding: 16, gap: 8 },
  roomCard: {
    backgroundColor: C.surface,
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: C.border,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  avatarText: { color: C.white, fontWeight: "900", fontSize: 20 },
  roomTitle: { color: C.text, fontWeight: "800", fontSize: 16 },
  avatarSm: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  avatarXs: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  avatarTextXs: { color: C.white, fontWeight: "900", fontSize: 11 },
  postHeader: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  searchBox: { flexDirection: "row", gap: 8, marginBottom: 14, alignItems: "center" },
  sectionLabel: {
    color: C.textMuted,
    fontWeight: "800",
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 10,
    marginTop: 6,
  },
  smallButtonMuted: { backgroundColor: C.surfaceRaised },
  smallButtonMutedText: { color: C.textMuted },
  setHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  setBack: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surfaceRaised, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.border },
  setHeaderTitle: { color: C.text, fontSize: 17, fontWeight: "800" },
  setSearch: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.surfaceRaised, borderRadius: 14, marginHorizontal: 14, marginTop: 6, marginBottom: 14, paddingHorizontal: 14, height: 48 },
  setSearchInput: { flex: 1, color: C.text, fontSize: 17, paddingVertical: 0 },
  setBand: { height: 8, backgroundColor: C.surfaceRaised, marginTop: 10 },
  setSectionTitle: { color: C.textMuted, fontSize: 14, fontWeight: "600", paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  setRow: { flexDirection: "row", alignItems: "center", paddingVertical: 13, paddingHorizontal: 18 },
  setRowTitle: { color: C.text, fontSize: 17, fontWeight: "500" },
  setRowSub: { color: C.textMuted, fontSize: 14, marginTop: 2, lineHeight: 19 },
  setRowValue: { color: C.textMuted, fontSize: 16, marginRight: 6, maxWidth: 140 },
  mentionHeader: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  igMention: { color: C.accent, fontSize: 14, marginTop: 4 },
  storyTagWrap: { position: "absolute", left: 16, right: 16, bottom: 70, gap: 10, alignItems: "flex-start" },
  storyTagText: { color: "#fff", fontWeight: "700", fontSize: 14, backgroundColor: "rgba(0,0,0,0.45)", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, overflow: "hidden" },
  storyAddBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(255,255,255,0.22)", borderWidth: 1, borderColor: "rgba(255,255,255,0.5)", borderRadius: 22, paddingVertical: 10, paddingHorizontal: 16 },
  storyAddText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  notifActions: { flexDirection: "row", gap: 8, marginTop: 10 },
  notifBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, backgroundColor: C.surfaceRaised, borderWidth: 1, borderColor: C.border },
  notifBtnPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  notifBtnText: { color: C.text, fontWeight: "700", fontSize: 14 },
  notifBtnPrimaryText: { color: C.white, fontWeight: "700", fontSize: 14 },
  notifDone: { color: C.accent, fontWeight: "700", fontSize: 13, marginTop: 8 },
  tabPillWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  tabPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: 6,
    borderRadius: 34,
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
    width: "88%",
    maxWidth: 420,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  tabPillItem: { flex: 1, alignItems: "center", justifyContent: "center", height: 46, borderRadius: 26 },
  tabPillItemActive: { backgroundColor: C.accentSoft },
  tabHandleWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  tabHandle: { width: 44, height: 5, borderRadius: 3, backgroundColor: C.textFaint },
  tabBadge: {
    position: "absolute",
    top: -2,
    right: -4,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: C.accent,
    borderWidth: 1,
    borderColor: C.bg,
  },
  segmented: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: C.surface,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  segment: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center", paddingHorizontal: 2 },
  segmentActive: { backgroundColor: C.accent },
  segmentText: { color: C.textMuted, fontWeight: "700", fontSize: 13 },
  segmentTextActive: { color: C.white },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 16,
    maxHeight: "80%",
    minHeight: "50%",
    borderWidth: 1,
    borderColor: C.border,
    borderBottomWidth: 0,
  },
  modalHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },

  // -- Profile --
  profileHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  gearButton: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  avatarLarge: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.borderStrong,
    overflow: "hidden",
  },
  avatarLargeImg: { width: 92, height: 92, borderRadius: 46 },
  avatarEditBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: C.bg,
  },
  bioBlock: { paddingHorizontal: 28, marginTop: 16, alignItems: "center" },
  bioText: { color: C.text, fontSize: 14, lineHeight: 20, textAlign: "center" },
  bioPlaceholder: { color: C.textFaint, fontSize: 14, fontStyle: "italic" },
  bioEditRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  bioEditLabel: { color: C.accent, fontSize: 13, fontWeight: "700" },
  statsRow: { flexDirection: "row", justifyContent: "center", gap: 36, marginTop: 20 },
  statBlock: { alignItems: "center" },
  statNumber: { color: C.text, fontSize: 18, fontWeight: "800" },
  statLabel: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  divider: { height: 1, backgroundColor: C.border, marginTop: 20 },
  postMenuBtn: { padding: 6, marginLeft: 4 },
  musicPill: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: C.surfaceRaised, alignSelf: "flex-start", maxWidth: "100%" },
  musicPillDark: { backgroundColor: "rgba(0,0,0,0.55)" },
  musicArt: { width: 22, height: 22, borderRadius: 4 },
  musicPillText: { color: C.text, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  storyMusicWrap: { position: "absolute", left: 12, top: 88 },
  postMusicBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8, marginTop: -2 },
  postMusicMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  postMusicText: { color: C.text, fontSize: 13, flex: 1 },
  postMuteBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: C.surfaceRaised },
  postMusicTrack: { height: 2, marginHorizontal: 12, marginBottom: 8, borderRadius: 1, backgroundColor: C.surfaceRaised, overflow: "hidden" },
  postMusicFill: { height: 2, backgroundColor: C.accent },
  durationBlock: { marginTop: 14 },
  durationLabel: { color: C.textMuted, fontSize: 12, fontWeight: "700", marginBottom: 8 },
  durationRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  trimBox: { marginTop: 10, padding: 12, borderRadius: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  trimHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  trimPlay: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  trimText: { color: C.text, fontSize: 13, fontWeight: "700" },
  trimNudge: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.surfaceRaised, alignItems: "center", justifyContent: "center" },
  trimTrack: { height: 44, flexDirection: "row", alignItems: "center", alignSelf: "center" },
  trimHint: { color: C.textMuted, fontSize: 11, marginTop: 8 },
  songRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  songArt: { width: 52, height: 52, borderRadius: 8, backgroundColor: C.surfaceRaised },
  songPlay: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  decorateBar: { flexDirection: "row", gap: 28, marginTop: 16 },
  decorateBtn: { alignItems: "center", gap: 4, minWidth: 56 },
  decorateAa: { color: C.text, fontSize: 21, fontWeight: "900" },
  textPanel: { marginTop: 14, padding: 14, borderRadius: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  textPanelRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  colorDotActive: { borderWidth: 3, borderColor: C.accent },
  brandTitle: { color: C.text, fontSize: 26, fontWeight: "900", letterSpacing: 1, textAlign: "center" },
  headerAction: { color: C.accent, fontSize: 16, fontWeight: "800" },
  storiesWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, marginBottom: 6 },
  storiesRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 14 },
  storyItem: { alignItems: "center", width: 74 },
  storyRing: { width: 70, height: 70, borderRadius: 35, borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  storyPlus: { position: "absolute", right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: C.accent, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: C.bg },
  storyName: { color: C.text, fontSize: 12, marginTop: 5, maxWidth: 70 },
  storyTop: { position: "absolute", left: 0, right: 0, top: 0, paddingHorizontal: 10, paddingTop: 8 },
  storyBarBg: { flex: 1, height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.35)", overflow: "hidden" },
  storyBarFill: { height: 3, backgroundColor: "#fff" },
  storyHeaderName: { color: "#fff", fontWeight: "800", fontSize: 15 },
  storyHeaderTime: { color: "rgba(255,255,255,0.7)", fontSize: 13 },
  storyBottom: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 16, backgroundColor: "rgba(0,0,0,0.35)" },
  storyCaption: { color: "#fff", fontSize: 17, lineHeight: 23 },
  storyViews: { color: "rgba(255,255,255,0.85)", fontSize: 13, marginTop: 8 },
  igPost: { width: FEED_W, alignSelf: "center", marginBottom: 14 },
  igHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 },
  igName: { color: C.text, fontWeight: "800", fontSize: 14 },
  igActions: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 10, gap: 16 },
  igAction: { padding: 2 },
  igBody: { paddingHorizontal: 12, paddingTop: 6, gap: 4 },
  igLikes: { color: C.text, fontWeight: "800", fontSize: 14 },
  igCaption: { color: C.text, fontSize: 14, lineHeight: 20 },
  igMuted: { color: C.textMuted, fontSize: 14 },
  igTime: { color: C.textFaint, fontSize: 10, letterSpacing: 0.4, marginTop: 2 },
  audienceOption: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  audienceOptionActive: { borderColor: C.accent, backgroundColor: C.accentSoft },
  accountRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.surface, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  accountRowActive: { borderColor: C.accent },
  accountName: { color: C.text, fontSize: 15, fontWeight: "700" },
  pickTile: { backgroundColor: C.surface, borderRadius: 20, padding: 24, alignItems: "center", gap: 6, borderWidth: 1, borderColor: C.border },
  pickTileTitle: { color: C.text, fontSize: 18, fontWeight: "800" },
  captionThumb: { width: 84, height: 84, borderRadius: 10, backgroundColor: C.surfaceRaised },
  editChipsRow: { flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap", justifyContent: "center" },
  editChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: C.surfaceRaised },
  editChipActive: { backgroundColor: C.accent },
  editChipText: { color: C.text, fontWeight: "700", fontSize: 13 },
  editToolBtn: { alignItems: "center", gap: 4, paddingHorizontal: 12 },
  editToolText: { color: C.textMuted, fontSize: 11 },
  bellBadge: { position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: "#E5484D", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: C.bg },
  bellBadgeText: { color: "#fff", fontSize: 10, fontWeight: "900" },
  notifRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 16, marginBottom: 8, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  notifRowUnread: { borderColor: C.accent },
  notifIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  notifDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.accent },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 8 },
  sheetRowText: { color: C.text, fontSize: 16, fontWeight: "700" },
  postActionsRow: { flexDirection: "row", alignItems: "center", marginTop: 10, gap: 18 },
  postAction: { flexDirection: "row", alignItems: "center", gap: 6 },
  postActionText: { color: C.textMuted, fontSize: 13, fontWeight: "700" },
  commentRow: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 8 },
  commentMeta: { color: C.textFaint, fontSize: 11, marginBottom: 2 },
  commentInputRow: { flexDirection: "row", alignItems: "center", marginTop: 12 },
  cropViewport: { overflow: "hidden", alignSelf: "center", backgroundColor: "#000" },
  cropRing: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderWidth: 2, borderColor: "rgba(255,255,255,0.9)" },
  zoomRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 16 },
  zoomBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: C.surfaceRaised },
  zoomTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: C.surfaceRaised, maxWidth: 200 },
  zoomFill: { height: 6, borderRadius: 3, backgroundColor: C.accent },
  editedTag: { color: C.textFaint },

  // -- Settings --
  settingsSection: { marginTop: 18, paddingHorizontal: 16 },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  settingsRowLabel: { color: C.text, fontSize: 15, fontWeight: "600" },
  settingsRowSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  themeOptionRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  themeOption: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    gap: 4,
  },
  themeOptionActive: { borderColor: C.accent, backgroundColor: C.accentSoft },
  themeOptionText: { color: C.textMuted, fontSize: 12, fontWeight: "700" },
  themeOptionTextActive: { color: C.accent },
  logoutRow: {
    marginTop: 24,
    marginHorizontal: 16,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  logoutText: { color: C.danger, fontWeight: "700", fontSize: 15 },
  });
}
let styles = buildStyles(C);