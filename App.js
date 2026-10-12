import React, { useEffect, useRef, useState } from "react";
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
} from "react-native";
// react-native core's SafeAreaView is iOS-only (it's a no-op on Android),
// which is why the header/status bar area could overlap system content on
// Android. react-native-safe-area-context works correctly on both
// platforms and is the standard replacement.
import { SafeAreaView, SafeAreaProvider } from "react-native-safe-area-context";
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
import { AudioModule } from "expo-audio";
import { useEvent } from "expo";
import { io } from "socket.io-client";
// Neither iOS nor Android has a status bar style set anywhere in this file,
// so both fall back to the OS default -- which is light (white) icons. That
// reads fine on the dark theme's near-black background but makes the clock,
// battery, and signal icons disappear against the light theme's near-white
// background. StatusBar (rendered per-screen below, driven by C.mode) fixes
// that on both platforms.
import { StatusBar } from "expo-status-bar";

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
// Persists the person's chosen appearance ("system" | "light" | "dark") so
// it survives app restarts instead of resetting to the default every time.
const THEME_KEY = "music_chat_theme";
const SCREEN_WIDTH = Dimensions.get("window").width;

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
  if (!res.ok) throw new Error(data.error || "Upload failed.");
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
    </SafeAreaProvider>
  );
}

function AppRoot() {
  const [screen, setScreen] = useState("auth"); // auth | main | chat
  const [mainTab, setMainTab] = useState("chats"); // home | chats | discover | profile
  const [authMode, setAuthMode] = useState("login");
  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
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
  const [messages, setMessages] = useState([]);
  const [socket, setSocket] = useState(null);
  const [socketReady, setSocketReady] = useState(false);
  const [roomsRefreshKey, setRoomsRefreshKey] = useState(0);
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

    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
      setSocketReady(false);
    };
  }, [token]);

  // Join/leave the active chat's room as it changes, without touching the
  // underlying socket connection itself.
  useEffect(() => {
    if (!socket || !activeRoom) return;
    setMessages([]);
    setRoomMembers([]);
    socket.emit("join_room", { roomId: activeRoom.id });

    const onRoomState = (state) => {
      setMessages(state.messages || []);
      setRoomMembers(state.members || []);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    };
    const onNewMessage = (m) => {
      setMessages((old) => [...old, m]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    };
    const onMembers = (members) => setRoomMembers(members);
    const onErr = (msg) => Alert.alert("Chat", msg);

    socket.on("room_state", onRoomState);
    socket.on("new_message", onNewMessage);
    socket.on("members_changed", onMembers);
    socket.on("error_message", onErr);

    return () => {
      socket.emit("leave_room", { roomId: activeRoom.id });
      socket.off("room_state", onRoomState);
      socket.off("new_message", onNewMessage);
      socket.off("members_changed", onMembers);
      socket.off("error_message", onErr);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, activeRoom?.id]);

  async function handleExpiredSession() {
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
      setToken(data.token);
      setMe(data.user);
      setScreen("main");
      setMainTab("chats");
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
    // Optimistically clear the box, but put the text back if the server
    // tells us the send failed (or if it times out) so nothing is lost.
    if (outgoingType === "text") setMessage("");

    socket.timeout(8000).emit(
      "send_message",
      { roomId: activeRoom.id, type: outgoingType, text, ...extra },
      (err, ack) => {
        if (err || !ack?.ok) {
          if (outgoingType === "text") setMessage(text);
          Alert.alert(
            "Message not sent",
            err ? "The server didn't respond in time. Please try again." : ack?.error || "Please try again.",
          );
        }
      },
    );
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
      message: `Join me in "${activeRoom.name}" on Music Chat! Send me your username and I'll add you to the chat.`,
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
        <Text style={styles.logo}>Music Chat</Text>
        <Text style={styles.subtitle}>
          Private chats for people you invite.
        </Text>

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
          renderItem={({ item }) => (
            <View
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
              <MessageBody item={item} isMe={item.userId === me?.id} />
              <Text style={[styles.time, item.userId === me?.id && styles.myTime]}>
                {new Date(item.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </View>
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
      <View style={{ flex: 1 }}>
        {mainTab === "home" && <HomeTab authedApi={authedApi} token={token} me={me} />}
        {mainTab === "chats" && (
          <ChatsTab
            authedApi={authedApi}
            onOpen={openRoom}
            onOpenVoice={openVoiceRoom}
            refreshKey={roomsRefreshKey}
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
            onUpdateMe={setMe}
            themeMode={themeMode}
            onChangeTheme={changeThemeMode}
          />
        )}
      </View>
      <TabBar active={mainTab} onChange={setMainTab} incomingCount={incomingCount} />
    </SafeAreaView>
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

function TabBar({ active, onChange, incomingCount }) {
  const tabs = [
    { key: "home", label: "Home", icon: "home-outline", iconActive: "home" },
    { key: "chats", label: "Chats", icon: "chatbubble-outline", iconActive: "chatbubble" },
    { key: "discover", label: "Discover", icon: "search-outline", iconActive: "search" },
    { key: "profile", label: "Profile", icon: "person-outline", iconActive: "person" },
  ];
  return (
    <View style={styles.tabBar}>
      {tabs.map((tab) => {
        const isActive = active === tab.key;
        return (
          <Pressable key={tab.key} style={styles.tabItem} onPress={() => onChange(tab.key)}>
            <View>
              <Ionicons name={isActive ? tab.iconActive : tab.icon} size={22} color={isActive ? C.accent : C.textMuted} />
              {tab.key === "discover" && incomingCount > 0 && <View style={styles.tabBadge} />}
            </View>
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
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

function ChatsTab({ authedApi, onOpen, onOpenVoice, refreshKey }) {
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
      <View style={styles.header}>
        <Text style={styles.titleSmall}>Chats</Text>
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
          contentContainerStyle={{ padding: 16 }}
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
        contentContainerStyle={{ padding: 16, paddingTop: 0 }}
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
  if (src) {
    return <Image source={{ uri: src }} style={[styles.avatarSm, dim, style]} />;
  }
  return (
    <View style={[styles.avatarSm, dim, { backgroundColor: colorFor(name || "?"), alignItems: "center", justifyContent: "center" }, style]}>
      <Text style={[styles.avatarTextXs, { fontSize: size * 0.4 }]}>{(name || "?")[0].toUpperCase()}</Text>
    </View>
  );
}

// A single post, shared by the Home feed and the Profile tab. When the
// viewer owns the post, a three-dot menu offers Edit/Delete; other
// people's posts render the same way with no menu at all.
function PostCard({ item, isOwner, onEdit, onDelete }) {
  function confirmDelete() {
    Alert.alert("Delete post?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => onDelete(item) },
    ]);
  }
  function openMenu() {
    Alert.alert("Post options", undefined, [
      { text: "Edit", onPress: () => onEdit(item) },
      { text: "Delete", style: "destructive", onPress: confirmDelete },
      { text: "Cancel", style: "cancel" },
    ]);
  }
  return (
    <View style={styles.postCard}>
      <View style={styles.postHeader}>
        <UserAvatar name={item.userName} avatarUrl={item.userAvatarUrl} thumbUrl={item.userAvatarThumbUrl} size={24} style={{ marginRight: 8 }} />
        <Text style={[styles.messageUser, { flex: 1 }]}>{item.userName}</Text>
        {isOwner && (
          <Pressable onPress={openMenu} hitSlop={10} style={styles.postMenuBtn}>
            <Ionicons name="ellipsis-horizontal" size={18} color={C.textMuted} />
          </Pressable>
        )}
      </View>
      {!!item.text && <Text style={styles.messageText}>{item.text}</Text>}
      {item.media && (
        item.media.mimeType?.startsWith("video/") ? (
          <PostVideo uri={item.media.url} />
        ) : (
          <AdaptiveImage
            uri={item.media.url}
            knownRatio={item.media.width && item.media.height ? item.media.width / item.media.height : undefined}
            maxWidth={SCREEN_WIDTH - 64}
            maxHeight={420}
            minHeight={160}
            style={styles.postMediaImage}
            onPress={() => Linking.openURL(item.media.url)}
          />
        )
      )}
      <Text style={styles.time}>
        {new Date(item.createdAt).toLocaleString()}
        {item.editedAt ? <Text style={styles.editedTag}> · Edited</Text> : null}
      </Text>
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

function HomeTab({ authedApi, token, me }) {
  const [posts, setPosts] = useState([]);
  const [text, setText] = useState("");
  const [pendingMedia, setPendingMedia] = useState(null); // { url, mimeType, fileName }
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [editingPost, setEditingPost] = useState(null);

  const load = async () => {
    setLoadingPosts(true);
    try {
      const res = await authedApi("/api/posts");
      if (res.status === 401) return;
      const data = await res.json();
      setPosts(data.posts || []);
    } catch (e) {
      Alert.alert("Could not load", "Check that the backend is reachable.");
    } finally {
      setLoadingPosts(false);
    }
  };
  useEffect(() => { load(); }, []);

  async function attachMedia() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Permission needed", "Allow photo access to attach a photo or video.");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.8 });
    if (result.canceled) return;
    setUploading(true);
    try {
      const asset = await prepareImage(result.assets[0], 1600);
      const uploaded = await uploadAsset(token, {
        uri: asset.uri,
        fileName: asset.fileName || (asset.type === "video" ? "video.mp4" : "photo.jpg"),
        mimeType: asset.mimeType || (asset.type === "video" ? "video/mp4" : "image/jpeg"),
      });
      setPendingMedia(uploaded);
    } catch (e) {
      Alert.alert("Upload failed", e.message || "Could not upload that file.");
    } finally {
      setUploading(false);
    }
  }

  async function publish() {
    if ((!text.trim() && !pendingMedia) || busy) return;
    setBusy(true);
    try {
      const res = await authedApi("/api/posts", {
        method: "POST",
        body: JSON.stringify({ text: text.trim(), media: pendingMedia }),
      });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Couldn't post", data.error || "Something went wrong.");
      setText("");
      setPendingMedia(null);
      setPosts((old) => [data.post, ...old]);
    } catch (e) {
      // A network error (unreachable backend, timeout, cold-starting free
      // server, etc.) used to fail silently here -- the button just did
      // nothing and the post never appeared. Now the person actually finds
      // out what happened instead of wondering why "posting" is broken.
      Alert.alert("Couldn't post", "Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const canPost = (text.trim() || pendingMedia) && !busy;

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
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <View style={styles.header}>
        <Text style={styles.titleSmall}>Home</Text>
      </View>
      <FlatList
        contentContainerStyle={{ padding: 16, paddingTop: 0 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <Text style={styles.sectionLabel}>Share an update</Text>
            <View style={styles.searchBox}>
              <TextInput style={[styles.inputInline, { minHeight: 44, textAlignVertical: "top" }]} value={text} onChangeText={setText} placeholder="What's on your mind?" placeholderTextColor={C.textFaint} multiline />
              <Pressable style={styles.iconButtonSm} onPress={attachMedia} disabled={uploading}>
                {uploading ? <ActivityIndicator size="small" /> : <Ionicons name="image-outline" size={19} color={C.text} />}
              </Pressable>
              <Pressable style={[styles.smallButton, !canPost && styles.smallButtonMuted]} disabled={!canPost} onPress={publish}><Text style={[styles.buttonText, !canPost && styles.smallButtonMutedText]}>Post</Text></Pressable>
            </View>
            {pendingMedia && (
              <View style={styles.mediaPreviewWrap}>
                {pendingMedia.mimeType?.startsWith("video/") ? (
                  <View style={[styles.mediaPreviewImage, { alignItems: "center", justifyContent: "center" }]}>
                    <Ionicons name="videocam-outline" size={22} color={C.textMuted} />
                  </View>
                ) : (
                  <Image source={{ uri: pendingMedia.url }} style={styles.mediaPreviewImage} />
                )}
                <Pressable style={styles.removeMediaBtn} onPress={() => setPendingMedia(null)}>
                  <Text style={styles.removeMediaBtnText}>×</Text>
                </Pressable>
              </View>
            )}
          </>
        }
        data={posts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PostCard item={item} isOwner={item.userId === me?.id} onEdit={setEditingPost} onDelete={deletePost} />
        )}
        ListEmptyComponent={loadingPosts ? <ActivityIndicator style={{ marginTop: 30 }} /> : <Text style={styles.empty}>Friends' posts will appear here.</Text>}
      />
      <EditPostModal
        visible={!!editingPost}
        post={editingPost}
        token={token}
        authedApi={authedApi}
        onClose={() => setEditingPost(null)}
        onSaved={(updated) => setPosts((old) => old.map((p) => (p.id === updated.id ? updated : p)))}
      />
    </KeyboardAvoidingView>
  );
}

function PostVideo({ uri }) {
  const player = useVideoPlayer(uri, (p) => { if (p) { p.loop = false; } });
  return <VideoView style={styles.postMediaVideo} player={player} allowsFullscreen nativeControls />;
}

// Theme + account settings, opened from the gear icon on Profile. A modal
// (not a separate tab) since it's a handful of one-off preferences, not
// something someone browses regularly.
function SettingsModal({ visible, onClose, themeMode, onChangeTheme, onLogout }) {
  const options = [
    { key: "system", label: "System", icon: "phone-portrait-outline" },
    { key: "light", label: "Light", icon: "sunny-outline" },
    { key: "dark", label: "Dark", icon: "moon-outline" },
  ];
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHeaderRow}>
            <Text style={styles.titleSmall}>Settings</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={C.textMuted} />
            </Pressable>
          </View>

          <Text style={styles.sectionLabel}>Appearance</Text>
          <View style={styles.themeOptionRow}>
            {options.map((opt) => {
              const active = themeMode === opt.key;
              return (
                <Pressable
                  key={opt.key}
                  style={[styles.themeOption, active && styles.themeOptionActive]}
                  onPress={() => onChangeTheme(opt.key)}
                >
                  <Ionicons name={opt.icon} size={20} color={active ? C.accent : C.textMuted} />
                  <Text style={[styles.themeOptionText, active && styles.themeOptionTextActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.sectionLabel, { marginTop: 22 }]}>Account</Text>
          <Pressable style={styles.logoutRow} onPress={onLogout}>
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </View>
      </View>
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

function ProfileTab({ me, token, authedApi, onLogout, onUpdateMe, themeMode, onChangeTheme }) {
  const [posts, setPosts] = useState([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bioModalOpen, setBioModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

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

  async function changeAvatar() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Permission needed", "Allow photo access to set a profile photo.");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8, allowsEditing: true, aspect: [1, 1] });
    if (result.canceled) return;
    setUploadingAvatar(true);
    try {
      // 512px is plenty for a profile photo. /api/me/avatar resizes, saves it
      // on the profile and removes the old photo in a single request.
      const asset = await prepareImage(result.assets[0], 512);
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
        contentContainerStyle={{ paddingBottom: 24 }}
        data={posts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 16 }}>
            <PostCard item={item} isOwner onEdit={setEditingPost} onDelete={deletePost} />
          </View>
        )}
        ListHeaderComponent={
          <>
            <View style={{ alignItems: "center", marginTop: 20 }}>
              <Pressable onPress={changeAvatar} disabled={uploadingAvatar}>
                <View style={[styles.avatarLarge, { backgroundColor: colorFor(me?.username || "?") }]}>
                  {uploadingAvatar ? (
                    <ActivityIndicator color={C.white} />
                  ) : me?.avatarUrl ? (
                    <Image source={{ uri: me.avatarUrl }} style={styles.avatarLargeImg} />
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
      />
      <EditBioModal
        visible={bioModalOpen}
        initialBio={me?.bio}
        authedApi={authedApi}
        onClose={() => setBioModalOpen(false)}
        onSaved={onUpdateMe}
      />
      <EditPostModal
        visible={!!editingPost}
        post={editingPost}
        token={token}
        authedApi={authedApi}
        onClose={() => setEditingPost(null)}
        onSaved={(updated) => setPosts((old) => old.map((p) => (p.id === updated.id ? updated : p)))}
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
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 22 : Platform.OS === "web" ? "max(12px, env(safe-area-inset-bottom))" : 10,
  },
  tabItem: { flex: 1, alignItems: "center", gap: 2 },
  tabIcon: { fontSize: 22, opacity: 0.45 },
  tabIconActive: { opacity: 1 },
  tabLabel: { color: C.textMuted, fontSize: 11, fontWeight: "700" },
  tabLabelActive: { color: C.accent },
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