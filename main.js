"use strict";

const electron = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const url = require("node:url");
const nodeNet = require("node:net");
const crypto = require("node:crypto");
const steamworks = require("steamworks.js");

const { app, BrowserWindow, Menu, ipcMain, protocol, session, shell, net } =
	electron;

app.setName("Happy Wheels");
app.setPath("userData", path.join(app.getPath("appData"), "HappyWheels"));

const SITE_HOST = "totaljerkface.com";
const SITE_ORIGIN = `https://${SITE_HOST}`;
const ALLOWED_HOSTS = new Set([
	SITE_HOST,
	`www.${SITE_HOST}`,
	`beta.${SITE_HOST}`,
]);

const APP_PATH_PREFIX = "/__hw_app__/";
const APP_BASE_URL = `https://${SITE_HOST}${APP_PATH_PREFIX}`;
const APP_URL = `${APP_BASE_URL}index.html`;

const USER_ENDPOINT = `${SITE_ORIGIN}/user.hw`;
const STEAM_ENDPOINT = `${SITE_ORIGIN}/steam.hw`;

const STEAM_APP_ID = 4705510;
const STEAM_TICKET_IDENTITY = "steam-totaljerkface-hw1";
const FIELD_SEP = "_::_";
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;
const PROGRESS_FILE = "achievement_progress.json";

const MAX_FRIENDS_PER_REQUEST = 5000;
const RETRY_DELAYS_MS = [15e3, 6e4, 3e5, 9e5];
const FRIENDS_POLL_INTERVAL_MS = 45e3;

const DISCORD_CLIENT_ID = "1521562157639139369";
const DISCORD_RECONNECT_MS = 15e3;

const STEAM_CB = {
	PERSONA_STATE_CHANGE: 0,
	NEW_URL_LAUNCH_PARAMETERS: 10,
	GAME_RICH_PRESENCE_JOIN_REQUESTED: 11,
	GAME_OVERLAY_ACTIVATED: 12,
	FRIEND_RICH_PRESENCE_UPDATE: 13,
};

const DEFAULT_ACTIVITY = { screen: "menu", levelName: null, levelId: null };

function activitiesEqual(a, b) {
	return (
		a.screen === b.screen && a.levelName === b.levelName && a.levelId === b.levelId
	);
}

function tjfAccountsEqual(a, b) {
	return a === null || b === null
		? a === b
		: a.userId === b.userId && a.userName === b.userName;
}

function avatarsEqual(a, b) {
	return a === null || b === null
		? a === b
		: a.width === b.width && a.height === b.height && a.rgba === b.rgba;
}

function isSteamId64(s) {
	return /^\d{17}$/.test(s);
}

function joinIds(ids) {
	return Array.from(ids).join(",");
}

function parseSyncResult(text) {
	switch (text.trim()) {
		case "success:true":
			return "success";
		case "failure:not_logged_in":
			return "not_logged_in";
		case "failure:not_linked":
			return "not_linked";
		case "failure:illegal_argument":
			return "illegal_argument";
		case "failure:too_many":
			return "too_many";
		default:
			return "error";
	}
}

function compareFriends(a, b) {
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	return a.steamId64 < b.steamId64 ? -1 : 1;
}

function backoffDelay(attempt, delays) {
	return delays[Math.min(attempt, delays.length - 1)] ?? delays[0] ?? 6e4;
}

let steam = null;
let authTicket = null;
let ticketQueue = Promise.resolve();
const callbackHandles = [];
let statsDirty = false;

function isSteamAvailable() {
	return steam !== null;
}

function getLocalSteamId() {
	if (steam === null) return null;
	try {
		return steam.localplayer.getSteamId().steamId64.toString();
	} catch {
		return null;
	}
}

function getFriendActivity(steamId64) {
	if (steam === null) return DEFAULT_ACTIVITY;
	const friends = steam.friends;
	try {
		const get = (key) => friends.getFriendRichPresence(steamId64, key);
		return activityFromPresence(
			get("screen"),
			get("steam_display"),
			get("levelname"),
			get("connect"),
		);
	} catch {
		return DEFAULT_ACTIVITY;
	}
}

function activityFromPresence(screenKey, steamDisplay, levelNameRaw, connect) {
	const levelName = levelNameRaw.trim();
	let isEditor;
	let isLevel;
	if (screenKey === "editor" || screenKey === "level" || screenKey === "menu") {
		isEditor = screenKey === "editor";
		isLevel = screenKey === "level";
	} else {
		isLevel = levelName !== "";
		isEditor = !isLevel && steamDisplay.trim() !== "";
	}
	if (isEditor) return { screen: "editor", levelName: null, levelId: null };
	if (!isLevel) return DEFAULT_ACTIVITY;

	const match = /^level_id=(\d{1,9})$/.exec(connect.trim());
	const levelId = match === null ? 0 : Number(match[1]);
	return {
		screen: "level",
		levelName: levelName === "" ? null : levelName,
		levelId: levelId > 0 ? levelId : null,
	};
}

function requestFriendRichPresence(steamId64) {
	if (steam === null) return;
	try {
		steam.friends.requestFriendRichPresence(BigInt(steamId64));
	} catch {}
}

function getFriendAvatar(steamId64) {
	if (steam === null) return null;
	try {
		const avatar = steam.friends.getFriendAvatar(BigInt(steamId64));
		return avatar === null
			? null
			: {
					width: avatar.width,
					height: avatar.height,
					rgba: avatar.data.toString("base64"),
				};
	} catch {
		return null;
	}
}

function getStat(name) {
	if (steam === null) return null;
	try {
		return steam.stats.getInt(name);
	} catch {
		return null;
	}
}

function setStat(name, value) {
	if (steam === null) return false;
	if (!Number.isSafeInteger(value)) return false;
	const clamped = Math.min(INT32_MAX, Math.max(INT32_MIN, value));
	try {
		if (!steam.stats.setInt(name, clamped)) return false;
	} catch {
		return false;
	}
	statsDirty = true;
	return true;
}

function storeStats() {
	if (!statsDirty || steam === null) return true;
	let ok = false;
	try {
		ok = steam.stats.store();
	} catch {}
	if (ok) statsDirty = false;
	return ok;
}

function requireApiName(name) {
	if (typeof name !== "string" || name === "") {
		throw new Error("Steam API name must be a non-empty string");
	}
	return name;
}

function unlockAchievement(name) {
	if (steam === null) return false;
	try {
		if (steam.achievement.isActivated(name)) return true;
		const ok = steam.achievement.activate(name);
		if (ok) statsDirty = false;
		return ok;
	} catch {
		return false;
	}
}

function isAchievementUnlocked(name) {
	if (steam === null) return false;
	try {
		return steam.achievement.isActivated(name);
	} catch {
		return false;
	}
}

function addToStat(name, delta) {
	if (!Number.isSafeInteger(delta)) return null;
	const current = getStat(name);
	if (current === null) return null;
	const next = Math.min(INT32_MAX, Math.max(INT32_MIN, current + delta));
	return setStat(name, next) ? next : null;
}

function readCloudProgress() {
	if (steam === null) return null;
	if (!steam.cloud.fileExists(PROGRESS_FILE)) return null;
	return steam.cloud.readFile(PROGRESS_FILE);
}

function writeCloudProgress(data) {
	if (steam === null) return false;
	try {
		return steam.cloud.writeFile(PROGRESS_FILE, data);
	} catch {
		return false;
	}
}

function requireProgressString(value) {
	if (typeof value !== "string" || value === "") {
		throw new Error("progress must be string and not empty");
	}
	return value;
}

const STEAM_API = {
	getPlayerName: (client) => client.localplayer.getName(),
	getAvatar: (client) => {
		const avatar = client.localplayer.getAvatar();
		return avatar === null
			? null
			: {
					width: avatar.width,
					height: avatar.height,
					rgba: avatar.data.toString("base64"),
				};
	},
	getSteamId: (client) => {
		const id = client.localplayer.getSteamId();
		return {
			steamId64: id.steamId64.toString(),
			steamId32: id.steamId32,
			accountId: id.accountId,
		};
	},
	openUserProfile: (client, args) =>
		client.overlay.activateUserProfile(BigInt(String(args[0]))),
	openUserChat: (client, args) =>
		client.overlay.activateUserChat(BigInt(String(args[0]))),
	unlockAchievement: (_client, args) =>
		unlockAchievement(requireApiName(args[0])),
	isAchievementUnlocked: (_client, args) =>
		isAchievementUnlocked(requireApiName(args[0])),
	getStat: (_client, args) => getStat(requireApiName(args[0])),
	setStat: (_client, args) => setStat(requireApiName(args[0]), Number(args[1])),
	addStat: (_client, args) => addToStat(requireApiName(args[0]), Number(args[1])),
	storeStats: () => storeStats(),
	readProgress: () => readCloudProgress(),
	writeProgress: (_client, args) =>
		writeCloudProgress(requireProgressString(args[0])),
};

function callSteamApi(method, args) {
	if (steam === null) throw new Error("Steam is not available");
	const fn = Object.prototype.hasOwnProperty.call(STEAM_API, method)
		? STEAM_API[method]
		: undefined;
	if (fn === undefined) throw new Error(`Unknown Steam method "${method}"`);
	return fn(steam, args);
}

function getLaunchQueryParam(key) {
	if (steam === null) return "";
	try {
		return steam.apps.launchQueryParam(key);
	} catch {
		return "";
	}
}

function createFlag(name) {
	const file = path.join(app.getPath("userData"), "hwdata", "flags", name);
	return {
		get: () => fs.existsSync(file),
		set(value) {
			try {
				if (value) {
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, "1");
				} else {
					fs.rmSync(file, { force: true });
				}
			} catch (err) {
				console.warn(
					`could not save flag '${name}': `,
					err instanceof Error ? err.message : err,
				);
			}
		},
	};
}

const noSteamAutologinFlag = createFlag("no-steam-autologin");
const fullscreenFlag = createFlag("fullscreen");

function parseAccountResponse(text) {
	const [status, userIdStr, steamIdStr, ...usernameParts] = text.split(FIELD_SEP);
	if (
		status !== "success:true" ||
		userIdStr === undefined ||
		steamIdStr === undefined ||
		usernameParts.length === 0
	) {
		return null;
	}
	const userId = parseInt(userIdStr, 10);
	if (!Number.isFinite(userId) || userId <= 0 || !/^\d+$/.test(userIdStr))
		return null;
	if (steamIdStr === "" || /^\d+$/.test(steamIdStr)) {
		return {
			userId,
			steamId: steamIdStr === "" ? null : steamIdStr,
			username: usernameParts.join(FIELD_SEP),
		};
	}
	return null;
}

let currentUser = null;
const userListeners = [];

function setCurrentUser(user) {
	currentUser = user;
	for (const listener of userListeners.slice()) listener(user);
}

let resolveAuthSettled = () => {};
const authSettled = new Promise((resolve) => {
	resolveAuthSettled = resolve;
});

function getSession() {
	return session.defaultSession;
}

async function postForm(endpoint, fields) {
	const response = await getSession().fetch(endpoint, {
		method: "POST",
		headers: new Headers({ "Content-Type": "application/x-www-form-urlencoded" }),
		body: new URLSearchParams(fields).toString(),
		credentials: "include",
		bypassCustomProtocolHandlers: true,
		signal: AbortSignal.timeout(1e4),
	});
	await getSession().cookies.flushStore();
	return response;
}

async function createAuthTicketHex() {
	if (steam === null) throw new Error("Steam is not available");
	authTicket?.cancel();
	authTicket = null;
	authTicket = await steam.auth.getAuthTicketForWebApi(STEAM_TICKET_IDENTITY);
	return authTicket.getBytes().toString("hex");
}

async function steamRequest(action, params = {}) {
	try {
		const run = ticketQueue.then(async () => {
			const ticket = await createAuthTicketHex();
			try {
				const response = await postForm(STEAM_ENDPOINT, { ...params, action, ticket });
				return response.ok
					? { outcome: "ok", body: await response.text() }
					: { outcome: "error" };
			} catch {
				return { outcome: "error" };
			}
		});
		ticketQueue = run.catch(() => {});
		return await run;
	} catch {
		return { outcome: "ticket" };
	}
}

async function clearSiteCookies() {
	try {
		const cookies = await getSession().cookies.get({ url: SITE_ORIGIN });
		for (const cookie of cookies)
			await getSession().cookies.remove(SITE_ORIGIN, cookie.name);
		await getSession().cookies.flushStore();
	} catch {}
}

function parseAccountStatus(text) {
	const trimmed = text.trim();
	if (trimmed === "failure:not_logged_in") return { outcome: "not_logged_in" };
	const user = parseAccountResponse(trimmed);
	return user ? { outcome: "success", user } : { outcome: "error" };
}

async function refreshAccountStatus(clearCookiesIfLoggedOut = true) {
	const result = await (async () => {
		try {
			const response = await postForm(USER_ENDPOINT, { action: "account_status" });
			if (!response.ok) return { user: null, offline: true };
			const parsed = parseAccountStatus(await response.text());
			if (parsed.outcome === "success") {
				setCurrentUser(parsed.user);
				return { user: parsed.user, offline: false };
			}
			if (parsed.outcome === "not_logged_in") {
				setCurrentUser(null);
				if (clearCookiesIfLoggedOut) await clearSiteCookies();
			}
			return { user: null, offline: parsed.outcome === "error" };
		} catch {
			return { user: null, offline: true };
		}
	})();
	if (result.user !== null || result.offline) resolveAuthSettled();
	return result;
}

function parseLoginResponse(text) {
	const [kind, detail] = text.trim().split(":");
	if (kind === "success" && detail === "true") return { outcome: "success" };
	if (kind === "failure" && detail === "userpass") return { outcome: "userpass" };
	if (kind === "lockout") {
		const minutes = parseInt(detail ?? "", 10);
		return { outcome: "lockout", minutes: Number.isFinite(minutes) ? minutes : 5 };
	}
	return { outcome: "error" };
}

async function loginWithPassword(email, password) {
	let response;
	try {
		response = await postForm(USER_ENDPOINT, {
			action: "login",
			login_user_email: email,
			login_user_pass: password,
		});
	} catch {
		return { outcome: "error" };
	}
	if (!response.ok) return { outcome: "error" };

	const parsed = parseLoginResponse(await response.text());
	if (parsed.outcome !== "success") return parsed;

	noSteamAutologinFlag.set(false);
	let { user } = await refreshAccountStatus(false);
	if (!user) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		({ user } = await refreshAccountStatus(false));
	}
	if (user) return { outcome: "success", user };
	await clearSiteCookies();
	return { outcome: "error" };
}

async function logout() {
	const mySteamId = getLocalSteamId();
	const wasSteamLinked =
		currentUser !== null &&
		currentUser.steamId !== null &&
		mySteamId !== null &&
		currentUser.steamId === mySteamId;

	noSteamAutologinFlag.set(true);
	setCurrentUser(null);

	if (wasSteamLinked) {
		try {
			const response = await postForm(STEAM_ENDPOINT, {
				action: "friends_sync",
				friends: "",
			});
			if (response.ok) parseSyncResult(await response.text());
		} catch {}
	}
	try {
		await postForm(USER_ENDPOINT, { action: "logout" });
	} catch {}
	await clearSiteCookies();
}

function parseSteamLoginResponse(text) {
	const trimmed = text.trim();
	switch (trimmed) {
		case "failure:not_linked":
			return { outcome: "not_linked" };
		case "failure:ticket":
			return { outcome: "ticket" };
		case "failure:account":
			return { outcome: "account" };
	}
	const user = parseAccountResponse(trimmed);
	return user ? { outcome: "success", user } : { outcome: "error" };
}

async function loginWithSteam(isAutomatic) {
	try {
		if (!isSteamAvailable()) return { outcome: "unavailable" };
		if (isAutomatic && noSteamAutologinFlag.get()) return { outcome: "suppressed" };

		const res = await steamRequest("steam_login");
		if (res.outcome !== "ok") return { outcome: res.outcome };

		const parsed = parseSteamLoginResponse(res.body);
		if (parsed.outcome === "success") {
			noSteamAutologinFlag.set(false);
			setCurrentUser(parsed.user);
		}
		return parsed;
	} finally {
		if (isAutomatic) resolveAuthSettled();
	}
}

function parseLinkSteamResponse(text) {
	switch (text.trim()) {
		case "success:true":
			return "success";
		case "failure:steam_in_use":
			return "steam_in_use";
		case "failure:ticket":
			return "ticket";
		case "failure:not_logged_in":
			return "not_logged_in";
		default:
			return "error";
	}
}

async function linkSteamAccount() {
	if (!isSteamAvailable()) return "error";
	const res = await steamRequest("link_steam");
	if (res.outcome !== "ok") return res.outcome;

	const result = parseLinkSteamResponse(res.body);
	const mySteamId = getLocalSteamId();
	if (result === "success" && currentUser !== null && mySteamId !== null) {
		setCurrentUser({ ...currentUser, steamId: mySteamId });
	}
	return result;
}

const DISCORD_OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

let presenceStartTime = 0;
let discordEnabled = false;
let discordSocket = null;
let discordReady = false;
let discordRetryTimer = null;
let discordActivity = null;
let lastSentActivityJson = null;

function buildDiscordActivity(state) {
	const activity = {
		type: 0,
		timestamps: { start: presenceStartTime },
		assets: { large_image: "hw_icon_temp", large_text: "Happy Wheels" },
		instance: false,
	};
	const s = state !== null && typeof state === "object" ? state : {};

	if (s.screen === "editor") {
		activity.details = "Building a level";
	} else if (s.screen === "level") {
		if (typeof s.levelName === "string" && s.levelName.trim() !== "") {
			activity.details = s.levelName.slice(0, 128).padEnd(2);
		}
		if (Number.isInteger(s.levelId) && s.levelId > 0) {
			activity.buttons = [
				{
					label: "Play this level",
					url: `https://totaljerkface.com/happy_wheels.tjf?level_id=${s.levelId}`,
				},
			];
		}
	}
	return activity;
}

function scheduleDiscordReconnect() {
	if (discordEnabled && discordRetryTimer === null) {
		discordRetryTimer = setTimeout(() => {
			discordRetryTimer = null;
			connectDiscord();
		}, DISCORD_RECONNECT_MS);
	}
}

function discordSocketPaths() {
	const paths = [];
	if (process.platform === "win32") {
		for (let i = 0; i < 10; i++) paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
		return paths;
	}
	const base = (
		process.env.XDG_RUNTIME_DIR ||
		process.env.TMPDIR ||
		process.env.TMP ||
		process.env.TEMP ||
		"/tmp"
	).replace(/\/$/, "");
	const subdirs = [
		"",
		"/app/com.discordapp.Discord",
		"/app/com.discordapp.DiscordCanary",
		"/app/com.discordapp.DiscordPTB",
		"/app/com.discordapp.DiscordDevelopment",
		"/snap.discord",
	];
	for (const subdir of subdirs) {
		for (let i = 0; i < 10; i++) paths.push(`${base}${subdir}/discord-ipc-${i}`);
	}
	return paths;
}

function parseDiscordFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (buffer.length - offset >= 8) {
		const op = buffer.readInt32LE(offset);
		const length = buffer.readInt32LE(offset + 4);
		if (length < 0 || length > 1048576) return null;
		if (buffer.length - offset - 8 < length) break;
		const json = buffer.subarray(offset + 8, offset + 8 + length).toString("utf8");
		offset += 8 + length;
		let data = null;
		try {
			data = JSON.parse(json);
		} catch {
			data = { _raw: json };
		}
		frames.push({ op, data });
	}
	return { frames, rest: buffer.subarray(offset) };
}

function encodeDiscordFrame(op, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	const header = Buffer.alloc(8);
	header.writeInt32LE(op, 0);
	header.writeInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

function discordSend(op, payload) {
	if (discordSocket !== null)
		discordSocket.write(encodeDiscordFrame(op, payload));
}

function handleDiscordFrame(op, data) {
	if (op === DISCORD_OP.PING) {
		discordSend(DISCORD_OP.PONG, data);
	} else if (op === DISCORD_OP.CLOSE) {
		if (discordSocket !== null) discordSocket.destroy();
	} else if (
		op === DISCORD_OP.FRAME &&
		data !== null &&
		typeof data === "object"
	) {
		if (data.cmd === "DISPATCH" && data.evt === "READY") {
			discordReady = true;
			pushDiscordActivity();
		}
	}
}

function pushDiscordActivity() {
	if (!discordReady || discordActivity === null) return;
	const json = JSON.stringify(discordActivity);
	if (json === lastSentActivityJson) return;
	lastSentActivityJson = json;
	discordSend(DISCORD_OP.FRAME, {
		cmd: "SET_ACTIVITY",
		nonce: crypto.randomUUID(),
		args: { pid: process.pid, activity: discordActivity },
	});
}

function attachDiscordSocket(socket) {
	discordSocket = socket;
	let pending = Buffer.alloc(0);

	socket.on("data", (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		const parsed = parseDiscordFrames(pending);
		if (parsed !== null) {
			pending = parsed.rest;
			for (const { op, data } of parsed.frames) handleDiscordFrame(op, data);
		} else {
			discordSocket?.destroy();
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		discordSocket = null;
		discordReady = false;
		lastSentActivityJson = null;
		scheduleDiscordReconnect();
	});

	discordSend(DISCORD_OP.HANDSHAKE, { v: 1, client_id: DISCORD_CLIENT_ID });
}

function connectDiscord() {
	if (!discordEnabled || discordSocket !== null) return;
	const candidates = discordSocketPaths();
	let index = 0;

	const tryNext = () => {
		if (!discordEnabled) return;
		const socketPath = candidates[index++];
		if (socketPath === undefined) return void scheduleDiscordReconnect();

		const socket = nodeNet.connect(socketPath);
		const onError = () => {
			socket.destroy();
			tryNext();
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.removeListener("error", onError);
			attachDiscordSocket(socket);
		});
	};
	tryNext();
}

let friendsWatcherStarted = false;
let friendsById = new Map();
let friendsLoaded = false;
const tjfAccountBySteamId = new Map();
let onlineFriendsSnapshot = [];
let tjfNamesSnapshot = [];
let friendsRefreshTimer = null;
const presenceRequested = new Set();
const pendingResolve = new Set();
let resolveDelayTimer = null;
let resolveTimer = null;
let resolveEnabled = false;
let resolveInFlight = false;
let resolveFailures = 0;
let syncEnabled = false;
let lastSyncedIds = null;
let syncTimer = null;
let syncInFlight = false;
let syncFailures = 0;

function scheduleFriendsRefresh(delayMs) {
	if (friendsRefreshTimer !== null) {
		if (delayMs > 0) return;
		clearTimeout(friendsRefreshTimer);
	}
	friendsRefreshTimer = setTimeout(() => {
		friendsRefreshTimer = null;
		refreshFriends();
	}, delayMs);
}

function readSteamFriends() {
	if (steam === null) return [];
	try {
		return steam.friends.getFriends().map((friend) => {
			const steamId64 = friend.steamId64.toString();
			const inGameOnline = friend.online && friend.inGame;
			return {
				steamId64,
				name: friend.name,
				online: friend.online,
				inGame: friend.inGame,
				activity: inGameOnline ? getFriendActivity(friend.steamId64) : DEFAULT_ACTIVITY,
			};
		});
	} catch {
		return null;
	}
}

function requestPresenceForInGameFriends(friends) {
	const inGameNow = new Set();
	for (const friend of friends) {
		if (friend.online && friend.inGame) {
			inGameNow.add(friend.steamId64);
			if (!presenceRequested.has(friend.steamId64)) {
				presenceRequested.add(friend.steamId64);
				requestFriendRichPresence(friend.steamId64);
			}
		}
	}
	for (const id of Array.from(presenceRequested)) {
		if (!inGameNow.has(id)) presenceRequested.delete(id);
	}
}

function friendListsEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === undefined || y === undefined) return false;
		if (
			x.steamId64 !== y.steamId64 ||
			x.name !== y.name ||
			!tjfAccountsEqual(x.tjf, y.tjf)
		)
			return false;
		if (
			!activitiesEqual(x.activity, y.activity) ||
			!avatarsEqual(x.avatar, y.avatar)
		)
			return false;
	}
	return true;
}

function broadcast(channel, payload) {
	for (const win of BrowserWindow.getAllWindows())
		win.webContents.send(channel, payload);
}

function refreshFriends() {
	const friends = readSteamFriends();
	if (friends === null) return;

	const previousIds = friendsLoaded ? new Set(friendsById.keys()) : null;
	friendsById = new Map(friends.map((f) => [f.steamId64, f]));
	requestPresenceForInGameFriends(friends);

	if (previousIds === null) {
		friendsLoaded = true;
		queueResolve(Array.from(friendsById.keys()));
		syncIfChanged();
	} else {
		handleFriendListDiff(previousIds);
	}

	const online = friends
		.filter((f) => f.online && f.inGame)
		.map((f) => ({
			steamId64: f.steamId64,
			name: f.name,
			tjf: tjfAccountBySteamId.get(f.steamId64) ?? null,
			activity: f.activity,
			avatar: getFriendAvatar(f.steamId64),
		}))
		.sort(compareFriends);

	if (!friendListsEqual(onlineFriendsSnapshot, online)) {
		onlineFriendsSnapshot = online;
		broadcast("native:friends:changed", onlineFriendsSnapshot);
	}

	const names = [];
	for (const id of friendsById.keys()) {
		const account = tjfAccountBySteamId.get(id);
		if (account != null) names.push(account.userName);
	}
	names.sort();
	const namesChanged =
		tjfNamesSnapshot.length !== names.length ||
		!tjfNamesSnapshot.every((n, i) => n === names[i]);
	if (namesChanged) {
		tjfNamesSnapshot = names;
		broadcast("native:friends:namesChanged", tjfNamesSnapshot);
	}
}

function handleFriendListDiff(previousIds) {
	const currentIds = new Set(friendsById.keys());
	const added = [];
	const removed = [];
	for (const id of currentIds) if (!previousIds.has(id)) added.push(id);
	for (const id of previousIds) if (!currentIds.has(id)) removed.push(id);

	for (const id of removed) {
		tjfAccountBySteamId.delete(id);
		pendingResolve.delete(id);
	}
	if (added.length > 0) {
		queueResolve(Array.from(friendsById.keys()));

		if (resolveDelayTimer !== null) clearTimeout(resolveDelayTimer);
		resolveDelayTimer = setTimeout(() => {
			resolveDelayTimer = null;
			queueResolve(Array.from(friendsById.keys()));
		}, 6e4);
	}
	if (added.length > 0 || removed.length > 0) syncIfChanged();
}

function queueResolve(steamIds) {
	for (const id of steamIds) pendingResolve.add(id);
	if (pendingResolve.size > 0) scheduleResolve(0);
}

function parseResolveResponse(text) {
	const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
	const status = (lines[0] ?? "").trim();
	switch (status) {
		case "failure:ticket":
			return { outcome: "ticket" };
		case "failure:steam_unavailable":
			return { outcome: "steam_unavailable" };
	}
	if (status !== "success:true") return { outcome: "error" };

	const accounts = new Map();
	for (const line of lines.slice(1)) {
		if (line.trim() === "") continue;
		const first = line.indexOf(FIELD_SEP);
		const second = first === -1 ? -1 : line.indexOf(FIELD_SEP, first + 4);
		if (second === -1) return { outcome: "error" };
		const userId = line.slice(0, first);
		const steamId = line.slice(first + 4, second);
		const userName = line.slice(second + 4);
		if (
			!isSteamId64(steamId) ||
			userName === "" ||
			!/^[1-9]\d{0,11}$/.test(userId)
		) {
			return { outcome: "error" };
		}
		accounts.set(steamId, { userId: Number(userId), userName });
	}
	return { outcome: "success", accounts };
}

function scheduleResolve(delayMs) {
	if (resolveEnabled && resolveTimer === null) {
		resolveTimer = setTimeout(() => {
			resolveTimer = null;
			runResolve().catch(() => {});
		}, delayMs);
	}
}

async function runResolve() {
	if (resolveInFlight) return;
	const ids = Array.from(pendingResolve)
		.filter((id) => friendsById.has(id))
		.slice(0, MAX_FRIENDS_PER_REQUEST);
	if (ids.length === 0) return void pendingResolve.clear();

	resolveInFlight = true;
	const res = await steamRequest("friends_resolve", { friends: joinIds(ids) });
	const parsed =
		res.outcome === "ok"
			? parseResolveResponse(res.body)
			: { outcome: res.outcome };
	resolveInFlight = false;

	if (parsed.outcome !== "success") {
		scheduleResolve(backoffDelay(resolveFailures++, RETRY_DELAYS_MS));
		return;
	}
	resolveFailures = 0;
	for (const id of ids) {
		tjfAccountBySteamId.set(id, parsed.accounts.get(id) ?? null);
		pendingResolve.delete(id);
	}
	scheduleFriendsRefresh(0);
	if (pendingResolve.size > 0) scheduleResolve(0);
}

function onUserChanged(user) {
	const mySteamId = getLocalSteamId();
	const linked =
		user !== null &&
		user.steamId !== null &&
		mySteamId !== null &&
		user.steamId === mySteamId;
	const wasSyncing = syncEnabled;
	syncEnabled = linked;
	if (!linked) {
		if (syncTimer !== null) {
			clearTimeout(syncTimer);
			syncTimer = null;
		}
		lastSyncedIds = null;
		return;
	}
	if (!wasSyncing) {
		syncFailures = 0;
		scheduleSync(0);
	}
}

function scheduleSync(delayMs) {
	if (syncTimer !== null) return;
	syncTimer = setTimeout(() => {
		syncTimer = null;
		runSync().catch(() => {});
	}, delayMs);
}

async function runSync() {
	if (!syncEnabled || syncInFlight || !friendsLoaded) return;
	const allIds = Array.from(friendsById.keys());
	const ids =
		allIds.length > MAX_FRIENDS_PER_REQUEST
			? allIds.slice(0, MAX_FRIENDS_PER_REQUEST)
			: allIds;

	syncInFlight = true;
	let result;
	try {
		const response = await postForm(STEAM_ENDPOINT, {
			action: "friends_sync",
			friends: joinIds(ids),
		});
		result = response.ok ? parseSyncResult(await response.text()) : "error";
	} catch {
		result = "error";
	}
	syncInFlight = false;

	switch (result) {
		case "success":
			lastSyncedIds = new Set(allIds);
			syncFailures = 0;
			syncIfChanged();
			break;
		case "not_logged_in":
		case "not_linked":
			syncEnabled = false;
			break;
		default:
			scheduleSync(backoffDelay(syncFailures++, RETRY_DELAYS_MS));
	}
}

function syncIfChanged() {
	if (!syncEnabled) return;
	const current = new Set(friendsById.keys());
	const same =
		lastSyncedIds !== null &&
		lastSyncedIds.size === current.size &&
		Array.from(current).every((id) => lastSyncedIds.has(id));
	if (!same) scheduleSync(0);
}

function findFriendByTjfName(name) {
	const wanted = name.trim().toLowerCase();
	if (wanted === "") return null;
	for (const [steamId64, account] of tjfAccountBySteamId) {
		if (account === null || account.userName.toLowerCase() !== wanted) continue;
		const friend = friendsById.get(steamId64);
		if (friend !== undefined)
			return { steamId64, name: friend.name, avatar: getFriendAvatar(steamId64) };
	}
	return null;
}

function registerSteamCallback(id, handler) {
	if (steam === null) return;
	try {
		callbackHandles.push(steam.callback.register(id, handler));
	} catch {}
}

function startFriendsWatcher() {
	if (friendsWatcherStarted || !isSteamAvailable()) return;
	friendsWatcherStarted = true;

	registerSteamCallback(STEAM_CB.PERSONA_STATE_CHANGE, () =>
		scheduleFriendsRefresh(300),
	);
	registerSteamCallback(STEAM_CB.FRIEND_RICH_PRESENCE_UPDATE, () =>
		scheduleFriendsRefresh(300),
	);

	setInterval(refreshFriends, FRIENDS_POLL_INTERVAL_MS);
	userListeners.push(onUserChanged);
	refreshFriends();
	onUserChanged(currentUser);

	authSettled.then(() => {
		resolveEnabled = true;
		if (pendingResolve.size > 0) scheduleResolve(0);
	});
}

let pendingDeepLink = null;
let rendererReadyForDeepLinks = false;
let deepLinksInitialized = false;

function parsePositiveId(text) {
	if (!/^\d{1,9}$/.test(text)) return null;
	const n = Number(text);
	return n > 0 ? n : null;
}

function getLaunchDeepLink() {
	const levelId = parsePositiveId(getLaunchQueryParam("level_id"));
	if (levelId !== null) return { kind: "level", id: levelId };
	const replayId = parsePositiveId(getLaunchQueryParam("replay_id"));
	return replayId !== null ? { kind: "replay", id: replayId } : null;
}

function parseConnectString(text) {
	const match = /^level_id=(\d{1,9})$/.exec(text.trim());
	if (match === null) return null;
	const id = Number(match[1]);
	return id > 0 ? { kind: "level", id } : null;
}

function getLaunchCommandLine() {
	if (steam === null) return "";
	try {
		return steam.apps.launchCommandLine();
	} catch {
		return "";
	}
}

function deliverDeepLink(link) {
	const [win] = BrowserWindow.getAllWindows();
	if (win) {
		if (win.isMinimized()) win.restore();
		win.focus();
		win.webContents.send("native:deeplink", link);
	}
}

function initDeepLinks(deliver) {
	if (deepLinksInitialized || !isSteamAvailable()) return;
	deepLinksInitialized = true;

	pendingDeepLink =
		getLaunchDeepLink() ?? parseConnectString(getLaunchCommandLine());

	const onLink = (link) => {
		if (link === null) return;
		if (rendererReadyForDeepLinks) deliver(link);
		else pendingDeepLink = link;
	};
	registerSteamCallback(STEAM_CB.NEW_URL_LAUNCH_PARAMETERS, () =>
		onLink(getLaunchDeepLink()),
	);
	registerSteamCallback(STEAM_CB.GAME_RICH_PRESENCE_JOIN_REQUESTED, (e) =>
		onLink(parseConnectString(e.connect)),
	);
}

const LEVEL_ID_RE = /^[1-9][0-9]{0,9}$/;
const META_FILE = "meta.json";
const RECORD_FILE = "record.bin";
const MAX_RECORD_BYTES = 33554432;

function downloadsDir() {
	return path.join(app.getPath("userData"), "hwdata", "downloads");
}

function parseLevelId(value) {
	let text = "";
	if (typeof value === "number") text = String(value);
	else if (typeof value === "string") text = value;
	return LEVEL_ID_RE.test(text) ? Number(text) : null;
}

function levelDir(levelId) {
	return path.join(downloadsDir(), String(levelId));
}

function requireLevelId(value) {
	const id = parseLevelId(value);
	if (id === null) throw new Error("invalid level id");
	return id;
}

function clampString(value, maxLength) {
	return String(value ?? "").slice(0, maxLength);
}

function toFiniteNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function buildMeta(id, raw, downloadedAt, bytes) {
	const o = raw && typeof raw === "object" ? raw : {};
	return {
		id,
		name: clampString(o.name, 256),
		authorId: toFiniteNumber(o.authorId),
		authorName: clampString(o.authorName, 256),
		weightedRating: toFiniteNumber(o.weightedRating),
		votes: toFiniteNumber(o.votes),
		plays: toFiniteNumber(o.plays),
		created: toFiniteNumber(o.created),
		comments: clampString(o.comments, 4096),
		character: toFiniteNumber(o.character),
		downloadedAt,
		bytes,
	};
}

async function writeFileAtomic(file, data) {
	const tmp = `${file}.tmp`;
	await fs.promises.writeFile(tmp, data);
	await fs.promises.rename(tmp, file);
}

async function readMeta(dir, levelId, recordBytes) {
	try {
		const json = await fs.promises.readFile(path.join(dir, META_FILE), "utf8");
		const raw = JSON.parse(json);
		return buildMeta(levelId, raw, toFiniteNumber(raw?.downloadedAt), recordBytes);
	} catch {
		return null;
	}
}

const downloadLocks = new Map();
function withLevelLock(levelId, task) {
	const next = (downloadLocks.get(levelId) ?? Promise.resolve()).then(task, task);
	downloadLocks.set(
		levelId,
		next.catch(() => {}),
	);
	return next;
}

async function listDownloads() {
	const root = downloadsDir();
	const entries = await fs.promises
		.readdir(root, { withFileTypes: true })
		.catch(() => []);
	const results = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const levelId = parseLevelId(entry.name);
		if (levelId === null) continue;
		const dir = path.join(root, entry.name);
		const stat = await fs.promises
			.stat(path.join(dir, RECORD_FILE))
			.catch(() => null);
		if (stat === null || !stat.isFile() || stat.size === 0) continue;
		const meta = await readMeta(dir, levelId, stat.size);
		if (meta !== null) results.push(meta);
	}
	return results.sort((a, b) => b.downloadedAt - a.downloadedAt || b.id - a.id);
}

function saveDownload(levelIdRaw, metaRaw, bytes) {
	const levelId = requireLevelId(levelIdRaw);
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
		throw new Error("invalid record");
	if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("record too large");
	const dir = levelDir(levelId);
	const meta = buildMeta(levelId, metaRaw, Date.now(), bytes.byteLength);
	return withLevelLock(levelId, async () => {
		await fs.promises.mkdir(dir, { recursive: true });
		await writeFileAtomic(path.join(dir, RECORD_FILE), bytes);
		await writeFileAtomic(
			path.join(dir, META_FILE),
			`${JSON.stringify(meta, null, 2)}\n`,
		);
	});
}

async function loadDownload(levelIdRaw) {
	const levelId = requireLevelId(levelIdRaw);
	const buf = await fs.promises.readFile(
		path.join(levelDir(levelId), RECORD_FILE),
	);
	return new Uint8Array(buf);
}

function deleteDownload(levelIdRaw) {
	const levelId = requireLevelId(levelIdRaw);
	const dir = levelDir(levelId);
	return withLevelLock(levelId, () =>
		fs.promises.rm(dir, { recursive: true, force: true }),
	);
}

Menu.setApplicationMenu(null);

const WEBROOT = path.join(
	process.resourcesPath,
	"webroot",
);
app.userAgentFallback = `${app.userAgentFallback} HappyWheels/1.99.1 (2.01; 908184ed)`;

const INDEX_HTML = [
	'<!DOCTYPE html><head><meta http-equiv="content-type" content="text/html; charset=UTF8">',
	'<meta http-equiv="X-UA-Compatible" content="IE=edge">',
	'<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,minimal-ui">',
	"<style>body{overflow:hidden;background-color:#000}</style></head>",
	'<body><div id="og-game-holder"></div>',
	'<script>window.HW_SETTINGS={siteURL:"https://totaljerkface.com/"}</script>',
	'<script src="./js/dependencies.js"></script>',
	'<script src="./js/index.js"></script></body>',
].join("");

function isAppUrl(urlString) {
	let parsed;
	try {
		parsed = new URL(urlString);
	} catch {
		return false;
	}
	return (
		ALLOWED_HOSTS.has(parsed.hostname) &&
		parsed.pathname.startsWith(APP_PATH_PREFIX)
	);
}

function resolveWebrootPath(pathname, root) {
	const relative = decodeURIComponent(pathname.slice(APP_PATH_PREFIX.length));
	const resolved = path.resolve(root, relative);
	const resolvedRoot = path.resolve(root);
	return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)
		? resolved
		: null;
}

async function handleHttpsRequest(request) {
	if (isAppUrl(request.url)) {
		const requestUrl = new URL(request.url);
		if (requestUrl.pathname === `${APP_PATH_PREFIX}index.html`) {
			return new Response(INDEX_HTML, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		const filePath = resolveWebrootPath(requestUrl.pathname, WEBROOT);
		if (filePath === null) return new Response("Forbidden", { status: 403 });
		const stat = await fs.promises.stat(filePath).catch(() => null);
		if (stat === null || stat.isDirectory()) {
			return new Response(`Not found: ${requestUrl.pathname}`, { status: 404 });
		}
		return net.fetch(url.pathToFileURL(filePath).href, {
			bypassCustomProtocolHandlers: true,
		});
	}

	const options = { bypassCustomProtocolHandlers: true };
	try {
		if (ALLOWED_HOSTS.has(new URL(request.url).hostname))
			options.credentials = "include";
	} catch {}
	return net.fetch(request, options);
}

function isTrustedSender(event) {
	return (
		event.senderFrame !== null && event.senderFrame.url.startsWith(APP_BASE_URL)
	);
}

function handleTrusted(channel, handler) {
	ipcMain.handle(channel, (event, ...args) => {
		if (!isTrustedSender(event)) throw new Error(`${channel}: untrusted sender`);
		return handler(event, ...args);
	});
}

function applyRichPresence(state) {
	if (steam === null) return;
	const s = state !== null && typeof state === "object" ? state : {};
	const player = steam.localplayer;

	player.setRichPresence(
		"screen",
		s.screen === "editor" || s.screen === "level" ? s.screen : "menu",
	);

	if (s.screen === "editor") {
		player.setRichPresence("levelname", null);
		player.setRichPresence("steam_display", "#StatusEditor");
	} else if (
		s.screen === "level" &&
		typeof s.levelName === "string" &&
		s.levelName.trim() !== ""
	) {
		player.setRichPresence("levelname", s.levelName.slice(0, 255));
		player.setRichPresence("steam_display", "#StatusLevel");
	} else {
		player.setRichPresence("levelname", null);
		player.setRichPresence("steam_display", null);
	}

	const joinable =
		s.screen === "level" &&
		typeof s.levelId === "number" &&
		Number.isInteger(s.levelId) &&
		s.levelId > 0;
	player.setRichPresence("connect", joinable ? `level_id=${s.levelId}` : null);
}

handleTrusted("native:steam", (_event, method, args) =>
	callSteamApi(String(method), Array.isArray(args) ? args : []),
);

handleTrusted("native:auth:login", (_event, email, password) =>
	loginWithPassword(String(email ?? ""), String(password ?? "")),
);
handleTrusted("native:auth:getUser", () => refreshAccountStatus());
handleTrusted("native:auth:logout", () => logout());
handleTrusted("native:auth:steamLogin", (_event, isAutomatic) =>
	loginWithSteam(Boolean(isAutomatic)),
);
handleTrusted("native:auth:linkSteam", () => linkSteamAccount());

handleTrusted("native:deeplink:pending", () => {
	rendererReadyForDeepLinks = true;
	const link = pendingDeepLink;
	pendingDeepLink = null;
	return link;
});

handleTrusted("native:friends:online", () => onlineFriendsSnapshot);
handleTrusted("native:friends:names", () => tjfNamesSnapshot);
handleTrusted("native:friends:findByTjfName", (_event, name) =>
	findFriendByTjfName(String(name ?? "")),
);

handleTrusted("native:downloads:list", () => listDownloads());
handleTrusted("native:downloads:save", (_event, levelId, meta, bytes) =>
	saveDownload(levelId, meta, bytes),
);
handleTrusted("native:downloads:load", (_event, levelId) =>
	loadDownload(levelId),
);
handleTrusted("native:downloads:delete", (_event, levelId) =>
	deleteDownload(levelId),
);

handleTrusted("native:cursorPos", (event) => {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	const cursor = electron.screen.getCursorScreenPoint();
	const bounds = win.getContentBounds();
	return { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
});

ipcMain.on("presence:set-state", (event, state) => {
	if (!isTrustedSender(event)) return;
	discordActivity = buildDiscordActivity(state);
	pushDiscordActivity();
	applyRichPresence(state);
});

ipcMain.on("native:exit", (event) => {
	if (isTrustedSender(event)) app.quit();
});

ipcMain.on("native:loaded", (event) => {
	if (isTrustedSender(event)) event.sender.setBackgroundThrottling(true);
});

ipcMain.on("native:fullscreen:set", (event, value) => {
	if (isTrustedSender(event))
		BrowserWindow.fromWebContents(event.sender)?.setFullScreen(Boolean(value));
});

ipcMain.on("native:fullscreen:get", (event) => {
	event.returnValue =
		isTrustedSender(event) &&
		(BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
});

function openExternalIfWeb(target) {
	let parsed;
	try {
		parsed = new URL(target);
	} catch {
		return;
	}
	if (parsed.protocol === "https:" || parsed.protocol === "http:")
		shell.openExternal(target);
}

app.on("web-contents-created", (_event, contents) => {
	contents.on("will-navigate", (e) => {
		if (!e.url.startsWith(APP_BASE_URL)) {
			e.preventDefault();
			openExternalIfWeb(e.url);
		}
	});

	contents.on("will-frame-navigate", (e) => {
		if (!e.isMainFrame && !e.url.startsWith(APP_BASE_URL)) e.preventDefault();
	});
	contents.setWindowOpenHandler(({ url: target }) => {
		if (target.startsWith(APP_BASE_URL)) return { action: "allow" };
		openExternalIfWeb(target);
		return { action: "deny" };
	});
});

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

function lockDownPermissions(ses) {
	ses.setPermissionRequestHandler((_webContents, permission, callback) => {
		callback(ALLOWED_PERMISSIONS.has(permission));
	});
	ses.setPermissionCheckHandler((_webContents, permission) =>
		ALLOWED_PERMISSIONS.has(permission),
	);
}

function createWindow() {
	const startFullscreen = fullscreenFlag.get();
	const win = new BrowserWindow({
		title: "Happy Wheels",
		width: 1350,
		height: 750,
		minWidth: 900,
		minHeight: 500,
		useContentSize: true,
		fullscreen: startFullscreen,
		backgroundColor: "#000000",
		show: false,
		...(process.platform === "linux"
			? { icon: path.join(process.resourcesPath, "icon.png") }
			: {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			devTools: false,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			v8CacheOptions: "bypassHeatCheck",
			backgroundThrottling: false,
			spellcheck: false,
			enableWebSQL: false,
			webviewTag: false,
		},
	});

	let maximizeOnLeaveFullscreen = startFullscreen;
	const onFullscreenChange = (isFullscreen) => {
		if (win.isDestroyed()) return;
		fullscreenFlag.set(isFullscreen);
		win.webContents.send("native:fullscreenChanged", isFullscreen);
		if (!isFullscreen && maximizeOnLeaveFullscreen) {
			maximizeOnLeaveFullscreen = false;
			win.maximize();
		}
	};
	win.on("enter-full-screen", () => onFullscreenChange(true));
	win.on("leave-full-screen", () => onFullscreenChange(false));

	win.once("ready-to-show", () => {
		if (!startFullscreen) win.maximize();
		win.show();
	});

	win.loadURL(APP_URL);
	return win;
}

function restartViaSteamIfNecessary() {
	try {
		return steamworks.restartAppIfNecessary(STEAM_APP_ID);
	} catch {
		return false;
	}
}

function initSteam() {
	try {
		steam = steamworks.init(STEAM_APP_ID);
		steam.localplayer.getName();
	} catch {
		steam = null;
	}
}

if (
	app.commandLine.hasSwitch("remote-debugging-port") ||
	app.commandLine.hasSwitch("remote-debugging-pipe") ||
	app.commandLine.hasSwitch("js-flags")
) {
	app.exit(1);
} else if (!restartViaSteamIfNecessary() && app.requestSingleInstanceLock()) {
	if (process.platform === "win32") steamworks.electronEnableSteamOverlay(false);
	initSteam();

	app.on("second-instance", () => {
		const [win] = BrowserWindow.getAllWindows();
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});

	app.whenReady().then(() => {
		protocol.handle("https", handleHttpsRequest);
		lockDownPermissions(session.defaultSession);

		if (!discordEnabled) {
			discordEnabled = true;
			presenceStartTime = Date.now();
			discordActivity = buildDiscordActivity({ screen: "menu" });
			connectDiscord();
		}

		createWindow();
		initDeepLinks(deliverDeepLink);
		startFriendsWatcher();

		registerSteamCallback(STEAM_CB.GAME_OVERLAY_ACTIVATED, (e) => {
			const [win] = BrowserWindow.getAllWindows();
			win?.webContents.send("native:overlayActivated", e.active);
		});

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});

	app.on("will-quit", () => {
		storeStats();
		discordEnabled = false;
		if (discordRetryTimer !== null) {
			clearTimeout(discordRetryTimer);
			discordRetryTimer = null;
		}
		if (discordSocket !== null) discordSocket.destroy();
		if (steam !== null) {
			steam = null;
			steamworks.shutdown();
		}
	});
} else {
	app.quit();
}
