import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  SafeAreaView,
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
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { io } from "socket.io-client";

// Keep this in .env so development, staging, and production can each use
// their own backend. Do not hard-code a deployment URL here: it prevents the
// app from using the backend selected by EXPO_PUBLIC_API_URL.
const API_URL = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000")
  .replace(/\/+$/, "");
// Vercel can serve the REST API but cannot host Socket.IO. Set this to the
// persistent backend (for example, a Render service) in production.
const SOCKET_URL = (process.env.EXPO_PUBLIC_SOCKET_URL || API_URL)
  .replace(/\/+$/, "");

console.log("API URL:", API_URL);
console.log("Socket URL:", SOCKET_URL);

const TOKEN_KEY = "music_chat_token";
const USER_KEY = "music_chat_user";

function api(path, options = {}) {
  return fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
}

// Colorful, deterministic avatar background so names/rooms feel distinct.
const AVATAR_COLORS = ["#6c5ce7", "#00b894", "#0984e3", "#e17055", "#d63031", "#00cec9", "#fdcb6e", "#e84393"];
function colorFor(text = "") {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function App() {
  const [screen, setScreen] = useState("auth");
  const [authMode, setAuthMode] = useState("login");
  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const [roomId, setRoomId] = useState("");
  const [roomName, setRoomName] = useState("");
  const [activeRoomName, setActiveRoomName] = useState("");
  const [roomMembers, setRoomMembers] = useState([]);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [socket, setSocket] = useState(null);
  const [playback, setPlayback] = useState({
    trackId: null,
    title: "Nothing playing",
    artist: "",
    url: "",
    position: 0,
    isPlaying: false,
    updatedBy: null,
  });
  const [spotifyUrl, setSpotifyUrl] = useState("");

  const listRef = useRef(null);

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
          setScreen("rooms");
        } else {
          await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
        }
      } catch (_) {
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!token || !roomId) return;

    const s = io(SOCKET_URL, { auth: { token } });
    setSocket(s);

    s.on("connect_error", (err) => {
      Alert.alert(
        "Connection error",
        err.message || "Could not connect to chat.",
      );
    });
    s.on("room_state", (state) => {
      setMessages(state.messages || []);
      setRoomMembers(state.members || []);
      setPlayback(state.playback || playback);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    });
    s.on("new_message", (m) => {
      setMessages((old) => [...old, m]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    });
    s.on("playback_changed", (p) => setPlayback(p));
    s.on("members_changed", (members) => setRoomMembers(members));

    s.emit("join_room", { roomId });

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [token, roomId]);

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
      await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
      setToken(null);
      setMe(null);
      setScreen("auth");
      Alert.alert("Session expired", "Please sign in again.");
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
      setScreen("rooms");
    } catch (e) {
      Alert.alert(
        "Network error",
        "Check that the backend is running and the API URL is correct.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function createRoom() {
    try {
      const res = await authedApi("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ name: roomName.trim() || "New chat" }),
      });
      if (res.status === 401) return;
      const data = await res.json();
      if (!res.ok) return Alert.alert("Could not create chat", data.error || "Something went wrong.");
      setRoomName("");
      openRoom(data.room);
    } catch (_) {
      Alert.alert("Network error", "Could not create the chat.");
    }
  }

  async function getRooms() {
    const res = await authedApi("/api/rooms");
    if (res.status === 401) return [];
    const data = await res.json();
    return data.rooms || [];
  }

  async function openRoom(room) {
    setRoomId(room.id);
    setActiveRoomName(room.name || "Chat");
    setScreen("chat");
  }

  async function sendMessage(type = "text", extra = {}) {
    if (!socket) return;
    if (type === "text" && !message.trim()) return;

    socket.emit("send_message", {
      roomId,
      type,
      text: message.trim(),
      ...extra,
    });
    setMessage("");
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
    const asset = result.assets[0];
    await sendMessage("media", {
      fileName: asset.fileName || "photo",
      mimeType: asset.mimeType || "image/jpeg",
      uri: asset.uri,
    });
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    await sendMessage("file", {
      fileName: file.name,
      mimeType: file.mimeType || "application/octet-stream",
      uri: file.uri,
      size: file.size || 0,
    });
  }

  function shareSpotify() {
    const value = spotifyUrl.trim();
    if (!value)
      return Alert.alert(
        "Spotify link",
        "Paste a Spotify track, album, or playlist link.",
      );
    if (!/^https?:\/\/(open\.)?spotify\.com\//i.test(value)) {
      return Alert.alert("Invalid link", "Please paste a Spotify URL.");
    }
    sendMessage("music", { url: value, title: "Spotify shared track" });
    setSpotifyUrl("");
  }

  function syncMusic() {
    if (!socket) return;
    const next = {
      ...playback,
      url: playback.url || spotifyUrl.trim(),
      title: playback.title || "Shared music",
      isPlaying: !playback.isPlaying,
      position: playback.position || 0,
    };
    socket.emit("playback_update", { roomId, playback: next });
  }

  async function logout() {
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
    socket?.disconnect();
    setToken(null);
    setMe(null);
    setRoomId("");
    setMessages([]);
    setScreen("auth");
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (screen === "auth") {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.logo}>Music Chat</Text>
        <Text style={styles.subtitle}>
          Private chats for people you invite.
        </Text>

        {authMode === "register" && (
          <>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor="#737b94"
              value={name}
              onChangeText={setName}
            />
            <TextInput
              style={styles.input}
              placeholder="Invitation code"
              placeholderTextColor="#737b94"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
            />
          </>
        )}

        <TextInput
          style={styles.input}
          placeholder="Username"
          placeholderTextColor="#737b94"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#737b94"
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
      </SafeAreaView>
    );
  }

  if (screen === "rooms") {
    return (
      <RoomsScreen
        token={token}
        me={me}
        onOpen={openRoom}
        onLogout={logout}
        onCreated={createRoom}
        roomName={roomName}
        setRoomName={setRoomName}
        getRooms={getRooms}
        onSocial={() => setScreen("social")}
      />
    );
  }

  if (screen === "social") {
    return (
      <SocialScreen
        token={token}
        onBack={() => setScreen("rooms")}
        onOpen={openRoom}
        onExpired={async () => {
          await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
          setToken(null);
          setMe(null);
          setScreen("auth");
          Alert.alert("Session expired", "Please sign in again.");
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            setRoomId("");
            setActiveRoomName("");
            setScreen("rooms");
          }}
        >
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View style={[styles.avatarSm, { backgroundColor: colorFor(activeRoomName || "C") }]}>
          <Text style={styles.avatarText}>{(activeRoomName || "C")[0].toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.titleSmall}>{activeRoomName || "Chat"}</Text>
          <Text style={styles.roomInfo}>
            {roomMembers.length} member{roomMembers.length === 1 ? "" : "s"}
          </Text>
        </View>
        <Text style={styles.live}>● LIVE</Text>
      </View>

      <View style={styles.musicCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardLabel}>LISTEN TOGETHER</Text>
          <Text style={styles.song}>
            {playback.title || "Nothing selected"}
          </Text>
          <Text style={styles.artist}>
            {playback.artist || "Share a Spotify link below"}
          </Text>
        </View>
        <Pressable style={styles.playButton} onPress={syncMusic}>
          <Text style={styles.playText}>{playback.isPlaying ? "Ⅱ" : "▶"}</Text>
        </Pressable>
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
            {item.type === "music" ? (
              <Pressable onPress={() => Linking.openURL(item.url)}>
                <Text style={styles.musicShare}>
                  ♫ {item.title || "Open Spotify"}
                </Text>
                <Text style={styles.link}>Open Spotify ↗</Text>
              </Pressable>
            ) : item.type === "media" ? (
              <Text style={styles.messageText}>
                📷 {item.fileName || "Media attachment"}
                {item.uri ? "\n" + item.uri : ""}
              </Text>
            ) : item.type === "file" ? (
              <Text style={styles.messageText}>
                📎 {item.fileName || "File"}
                {item.size ? ` · ${item.size} bytes` : ""}
              </Text>
            ) : (
              <Text style={styles.messageText}>{item.text}</Text>
            )}
            <Text style={styles.time}>
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
          <Pressable style={styles.iconButton} onPress={pickPhoto}>
            <Text style={styles.icon}>＋</Text>
          </Pressable>
          <Pressable style={styles.iconButton} onPress={pickFile}>
            <Text style={styles.icon}>📎</Text>
          </Pressable>
          <TextInput
            style={styles.messageInput}
            value={message}
            onChangeText={setMessage}
            placeholder="Message…"
            placeholderTextColor="#737b94"
            onSubmitEditing={() => sendMessage("text")}
            returnKeyType="send"
          />
          <Pressable style={styles.send} onPress={() => sendMessage("text")}>
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        </View>
        <View style={styles.spotifyRow}>
          <TextInput
            style={styles.spotifyInput}
            value={spotifyUrl}
            onChangeText={setSpotifyUrl}
            placeholder="Paste Spotify link…"
            placeholderTextColor="#737b94"
            autoCapitalize="none"
          />
          <Pressable style={styles.smallButton} onPress={shareSpotify}>
            <Text style={styles.buttonText}>Share</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RoomsScreen({
  token,
  me,
  onOpen,
  onLogout,
  onCreated,
  roomName,
  setRoomName,
  getRooms,
  onSocial,
}) {
  const [rooms, setRooms] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(true);

  async function refresh() {
    setLoadingRooms(true);
    try {
      setRooms(await getRooms());
    } finally {
      setLoadingRooms(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.titleSmall}>Chats</Text>
          <Text style={styles.roomInfo}>
            Signed in as {me?.name || me?.username}
          </Text>
        </View>
        <Pressable onPress={onLogout}>
          <Text style={styles.link}>Log out</Text>
        </Pressable>
      </View>

      <Pressable style={styles.createBox} onPress={onSocial}>
        <Text style={styles.buttonText}>Discover people, requests & feed</Text>
      </Pressable>

      <View style={styles.createBox}>
        <TextInput
          style={styles.inputInline}
          value={roomName}
          onChangeText={setRoomName}
          placeholder="New private chat name"
          placeholderTextColor="#737b94"
        />
        <Pressable
          style={styles.smallButton}
          onPress={async () => {
            await onCreated();
            refresh();
          }}
        >
          <Text style={styles.buttonText}>New</Text>
        </Pressable>
      </View>

      {loadingRooms ? (
        <ActivityIndicator style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.roomCard, pressed && { opacity: 0.8 }]}
              onPress={() => onOpen(item)}
            >
              <View style={[styles.avatar, { backgroundColor: colorFor(item.name || "C") }]}>
                <Text style={styles.avatarText}>
                  {(item.name || "C")[0].toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.roomTitle}>{item.name}</Text>
                <Text style={styles.roomInfo}>
                  {item.memberCount} member(s)
                </Text>
              </View>
              <Text style={styles.back}>›</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No chats yet. Create one above.</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

function SocialScreen({ token, onBack, onOpen, onExpired }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [posts, setPosts] = useState([]);
  const [text, setText] = useState("");
  const [sentTo, setSentTo] = useState({});
  const [busy, setBusy] = useState(false);
  const headers = { Authorization: `Bearer ${token}` };

  async function guarded(res) {
    if (res.status === 401) { onExpired(); return null; }
    return res;
  }

  const load = async () => {
    const requests = await guarded(await api("/api/friends/requests", { headers }));
    if (!requests) return;
    const feed = await guarded(await api("/api/posts", { headers }));
    if (!feed) return;
    setIncoming((await requests.json()).incoming || []);
    setPosts((await feed.json()).posts || []);
  };
  useEffect(() => { load().catch(() => Alert.alert("Could not load", "Check that the backend is reachable.")); }, []);

  async function findPeople() {
    if (!query.trim()) return;
    const r = await guarded(await api(`/api/users/search?q=${encodeURIComponent(query.trim())}`, { headers }));
    if (!r) return;
    setPeople((await r.json()).users || []);
  }
  async function request(person) {
    const r = await guarded(await api("/api/friends/requests", { method: "POST", headers, body: JSON.stringify({ userId: person.id, username: person.username }) }));
    if (!r) return;
    const d = await r.json();
    if (!r.ok) return Alert.alert("Couldn't send request", d.error || "Something went wrong.");
    setSentTo(old => ({ ...old, [person.id]: true }));
  }
  async function accept(requestId) {
    const r = await guarded(await api(`/api/friends/requests/${requestId}/accept`, { method: "POST", headers }));
    if (!r) return;
    const d = await r.json();
    if (!r.ok) return Alert.alert("Couldn't accept", d.error || "Something went wrong.");
    setIncoming(old => old.filter(i => i.id !== requestId));
    onOpen(d.room);
  }
  async function publish() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await guarded(await api("/api/posts", { method: "POST", headers, body: JSON.stringify({ text: text.trim() }) }));
      if (!r) return;
      const d = await r.json();
      if (!r.ok) return Alert.alert("Couldn't post", d.error || "Something went wrong.");
      setText("");
      setPosts(old => [d.post, ...old]);
    } finally {
      setBusy(false);
    }
  }

  return <SafeAreaView style={styles.container}>
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10}><Text style={styles.back}>‹</Text></Pressable>
      <Text style={[styles.titleSmall, { flex: 1 }]}>Your circle</Text>
    </View>
    <FlatList
      contentContainerStyle={{ padding: 16, paddingTop: 0 }}
      ListHeaderComponent={
        <>
          <View style={styles.searchBox}>
            <TextInput style={styles.inputInline} value={query} onChangeText={setQuery} placeholder="Find a username" placeholderTextColor="#737b94" autoCapitalize="none" onSubmitEditing={findPeople} returnKeyType="search" />
            <Pressable style={styles.smallButton} onPress={findPeople}><Text style={styles.buttonText}>Find</Text></Pressable>
          </View>
          {people.map(person => (
            <View key={person.id} style={styles.roomCard}>
              <View style={[styles.avatar, { backgroundColor: colorFor(person.username) }]}><Text style={styles.avatarText}>{person.name[0].toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.roomTitle}>{person.name}</Text>
                <Text style={styles.roomInfo}>@{person.username}</Text>
              </View>
              <Pressable style={[styles.smallButton, (person.connected || sentTo[person.id]) && styles.smallButtonMuted]} disabled={person.connected || sentTo[person.id]} onPress={() => request(person)}>
                <Text style={styles.buttonText}>{person.connected ? "Friends" : sentTo[person.id] ? "Sent" : "Request"}</Text>
              </Pressable>
            </View>
          ))}
          {people.length === 0 && query.trim().length > 0 && <Text style={styles.empty}>No one matches "{query}" yet.</Text>}

          {incoming.length > 0 && <Text style={styles.sectionLabel}>Requests</Text>}
          {incoming.map(item => (
            <View key={item.id} style={styles.roomCard}>
              <View style={[styles.avatar, { backgroundColor: colorFor(item.from?.username || "?") }]}><Text style={styles.avatarText}>{(item.from?.name || "?")[0].toUpperCase()}</Text></View>
              <Text style={[styles.messageText, { flex: 1 }]}>@{item.from?.username} wants to connect</Text>
              <Pressable style={styles.smallButton} onPress={() => accept(item.id)}><Text style={styles.buttonText}>Accept</Text></Pressable>
            </View>
          ))}

          <Text style={styles.sectionLabel}>Share an update</Text>
          <View style={styles.searchBox}>
            <TextInput style={[styles.inputInline, { minHeight: 44 }]} value={text} onChangeText={setText} placeholder="What's on your mind?" placeholderTextColor="#737b94" multiline />
            <Pressable style={[styles.smallButton, (!text.trim() || busy) && styles.smallButtonMuted]} disabled={!text.trim() || busy} onPress={publish}><Text style={styles.buttonText}>Post</Text></Pressable>
          </View>
        </>
      }
      data={posts}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <View style={styles.message}>
          <View style={styles.postHeader}>
            <View style={[styles.avatarXs, { backgroundColor: colorFor(item.userName) }]}><Text style={styles.avatarTextXs}>{item.userName[0].toUpperCase()}</Text></View>
            <Text style={styles.messageUser}>{item.userName}</Text>
          </View>
          <Text style={styles.messageText}>{item.text}</Text>
          <Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>Friends' posts will appear here.</Text>}
    />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1020" },
  center: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0b1020",
  },
  logo: { color: "white", fontSize: 38, fontWeight: "900", marginBottom: 8 },
  titleSmall: { color: "white", fontSize: 23, fontWeight: "800" },
  subtitle: { color: "#aab2c5", fontSize: 16, marginBottom: 24 },
  muted: { color: "#aab2c5", marginTop: 10, textAlign: "center" },
  input: {
    backgroundColor: "#171e33",
    color: "white",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  inputInline: {
    flex: 1,
    backgroundColor: "#171e33",
    color: "white",
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  button: {
    backgroundColor: "#6c5ce7",
    padding: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  smallButton: {
    backgroundColor: "#6c5ce7",
    paddingVertical: 11,
    paddingHorizontal: 15,
    borderRadius: 11,
    justifyContent: "center",
  },
  buttonText: { color: "white", fontWeight: "800" },
  link: {
    color: "#9c91ff",
    marginTop: 15,
    textAlign: "center",
    fontWeight: "700",
  },
  header: {
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#171e33",
  },
  back: { color: "white", fontSize: 34, lineHeight: 34 },
  roomInfo: { color: "#7f89a3", marginTop: 2 },
  live: { color: "#52d273", fontWeight: "800", fontSize: 11 },
  musicCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 16,
    backgroundColor: "#171e33",
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  cardLabel: {
    color: "#aab2c5",
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 5,
  },
  song: { color: "white", fontSize: 18, fontWeight: "800" },
  artist: { color: "#aab2c5", marginTop: 4 },
  playButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "#6c5ce7",
    alignItems: "center",
    justifyContent: "center",
  },
  playText: { color: "white", fontWeight: "900", fontSize: 18 },
  chat: { flex: 1, padding: 16 },
  message: {
    backgroundColor: "#171e33",
    borderRadius: 14,
    padding: 12,
    marginBottom: 8,
    maxWidth: "88%",
    alignSelf: "flex-start",
  },
  myMessage: { alignSelf: "flex-end", backgroundColor: "#24204b" },
  messageUser: { color: "#9c91ff", fontWeight: "800", marginBottom: 4 },
  messageText: { color: "white", fontSize: 16, lineHeight: 21 },
  time: { color: "#737b94", fontSize: 10, marginTop: 7, alignSelf: "flex-end" },
  empty: { color: "#7f89a3", textAlign: "center", marginTop: 30 },
  attachRow: {
    flexDirection: "row",
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: "#202943",
    gap: 7,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#171e33",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { color: "white", fontSize: 20 },
  messageInput: {
    flex: 1,
    backgroundColor: "#171e33",
    color: "white",
    borderRadius: 12,
    paddingHorizontal: 13,
  },
  send: {
    backgroundColor: "#6c5ce7",
    borderRadius: 12,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  spotifyRow: {
    flexDirection: "row",
    paddingHorizontal: 10,
    paddingBottom: 10,
    gap: 7,
  },
  spotifyInput: {
    flex: 1,
    backgroundColor: "#171e33",
    color: "white",
    borderRadius: 12,
    paddingHorizontal: 13,
  },
  spotifyRowButton: { backgroundColor: "#6c5ce7" },
  musicShare: { color: "white", fontWeight: "800", fontSize: 16 },
  createBox: { flexDirection: "row", padding: 16, gap: 8 },
  roomCard: {
    backgroundColor: "#171e33",
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#6c5ce7",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "white", fontWeight: "900", fontSize: 20 },
  roomTitle: { color: "white", fontWeight: "800", fontSize: 16 },
  avatarSm: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarXs: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  avatarTextXs: { color: "white", fontWeight: "900", fontSize: 11 },
  postHeader: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  searchBox: { flexDirection: "row", gap: 8, marginBottom: 14, alignItems: "center" },
  sectionLabel: {
    color: "#7f89a3",
    fontWeight: "800",
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 10,
    marginTop: 6,
  },
  smallButtonMuted: { backgroundColor: "#2a3350" },
});
