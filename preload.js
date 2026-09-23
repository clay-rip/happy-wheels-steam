"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const hwNative = {
	steam: {
		call: (method, ...args) => ipcRenderer.invoke("native:steam", method, args),
	},

	presence: {
		setState: (state) => ipcRenderer.send("presence:set-state", state),
	},

	cursorPos: () => ipcRenderer.invoke("native:cursorPos"),

	exit: () => ipcRenderer.send("native:exit"),

	loaded: () => ipcRenderer.send("native:loaded"),

	deepLink: {
		pending: () => ipcRenderer.invoke("native:deeplink:pending"),
		onOpen: (callback) => {
			ipcRenderer.on("native:deeplink", (_event, link) => callback(link));
		},
	},

	overlay: {
		onActivated: (callback) => {
			ipcRenderer.on("native:overlayActivated", (_event, active) =>
				callback(Boolean(active)),
			);
		},
	},

	fullscreen: {
		set: (value) => ipcRenderer.send("native:fullscreen:set", value),
		get: () => ipcRenderer.sendSync("native:fullscreen:get") === true,
		onChange: (callback) => {
			ipcRenderer.on("native:fullscreenChanged", (_event, isFullscreen) =>
				callback(Boolean(isFullscreen)),
			);
		},
	},

	auth: {
		login: (email, password) =>
			ipcRenderer.invoke("native:auth:login", email, password),
		getUser: () => ipcRenderer.invoke("native:auth:getUser"),
		logout: () => ipcRenderer.invoke("native:auth:logout"),
		steamLogin: (isAutomatic) =>
			ipcRenderer.invoke("native:auth:steamLogin", isAutomatic),
		linkSteam: () => ipcRenderer.invoke("native:auth:linkSteam"),
	},

	friends: {
		online: () => ipcRenderer.invoke("native:friends:online"),
		onChanged: (callback) => {
			ipcRenderer.on("native:friends:changed", (_event, list) =>
				callback(Array.isArray(list) ? list : []),
			);
		},
		findByTjfName: (name) =>
			ipcRenderer.invoke("native:friends:findByTjfName", name),
		names: () => ipcRenderer.invoke("native:friends:names"),
		onNamesChanged: (callback) => {
			ipcRenderer.on("native:friends:namesChanged", (_event, list) =>
				callback(Array.isArray(list) ? list : []),
			);
		},
	},

	downloads: {
		list: () => ipcRenderer.invoke("native:downloads:list"),
		save: (levelId, meta, bytes) =>
			ipcRenderer.invoke("native:downloads:save", levelId, meta, bytes),
		load: (levelId) => ipcRenderer.invoke("native:downloads:load", levelId),
		delete: (levelId) => ipcRenderer.invoke("native:downloads:delete", levelId),
	},
};

contextBridge.exposeInMainWorld("hwNative", hwNative);
