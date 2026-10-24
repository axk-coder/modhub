(function() {
    const PLAYFAB_TITLE_ID = "1A4B9A";
    const PLAYFAB_LOGIN_CUSTOM_ID_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/LoginWithCustomID`;
    const PLAYFAB_LOGIN_EMAIL_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/LoginWithEmailAddress`;
    const PLAYFAB_REGISTER_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/RegisterPlayFabUser`;
    const PLAYFAB_EXECUTE_CS_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/ExecuteCloudScript`;
    const PLAYFAB_INVENTORY_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/GetUserInventory`;
    const PLAYFAB_UPDATE_NAME_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/UpdateUserTitleDisplayName`;
    const PLAYFAB_ACCOUNT_BANNED_CODE = 1002;
    const BAN_CHECK_INTERVAL_MS = 2000;
    const AUTH_SESSION_KEY = "modhub_playfab_session";
    const HWID_STORAGE_KEY = "modhub_device_hwid_v1";
    const ADMIN_MOD_FILENAME = "admin-tools.js";
    const CHUNK_SIZE = 7500;

    let hubWindow = null;
    let toolbarMenu = null;
    let styleTag = null;
    let toolbarRetries = 0;
    let mods = [];
    let selectedMod = null;
    let loadedMods = new Map();
    let purchasedMods = new Set();
    let showActiveOnly = false;
    let activeSession = null;
    let currentUserEmail = null;
    let currentPlayFabId = null;
    let currentUsername = "";
    let currentBalance = 0;
    let isUploadMode = false;
    let isEditMode = false;
    let isUserAdmin = false;
    let isSidebarOpen = false;
    let activeView = "mods";
    let searchQuery = "";
    let selectedCategory = "all";

    let chatMessages = [
        { sender: "System", text: "Welcome to Mod Hub Global Chat.", time: "Now" }
    ];

    (function protectGlobalHost() {
        try {
            const proto = Document.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, "cookie") || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie");
            if (desc && desc.configurable) {
                const origGet = desc.get;
                const origSet = desc.set;
                Object.defineProperty(proto, "cookie", {
                    get() {
                        const stack = new Error().stack || "";
                        if (stack.includes("__mh_") || stack.includes("ModManager") || stack.includes("installBuiltInMod")) {
                            return "";
                        }
                        const raw = origGet ? origGet.call(this) : "";
                        return raw.split(";").filter(c => {
                            const name = c.split("=")[0].trim().toLowerCase();
                            return !name.startsWith("modhub") && !name.includes("playfab") && !name.includes("session");
                        }).join("; ");
                    },
                    set(val) {
                        const stack = new Error().stack || "";
                        if (stack.includes("__mh_") || stack.includes("ModManager") || stack.includes("installBuiltInMod")) {
                            return;
                        }
                        if (origSet) origSet.call(this, val);
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        } catch (e) {}

        try {
            const storageProto = Storage.prototype;
            const origGetItem = storageProto.getItem;
            storageProto.getItem = function(key) {
                const stack = new Error().stack || "";
                if (typeof key === "string" && key.startsWith("modhub_")) {
                    if (stack.includes("__mh_") || stack.includes("ModManager") || stack.includes("installBuiltInMod")) {
                        return null;
                    }
                }
                return origGetItem.apply(this, arguments);
            };
        } catch (e) {}
    })();

    const ModSandboxManager = (function() {
        const virtualCookies = new Map();
        const virtualStorage = new Map();
        const BLOCKED_HOSTS = ["playfabapi.com", "playfab.com"];

        function isRestrictedHost(url) {
            if (!url) return false;
            try {
                const parsed = new URL(url, window.location.href);
                const host = parsed.hostname.toLowerCase();
                return BLOCKED_HOSTS.some(b => host === b || host.endsWith("." + b));
            } catch (e) {
                return false;
            }
        }

        function cleanHeaders(headers) {
            const out = {};
            if (!headers) return out;
            const blocked = ["x-authorization", "authorization", "cookie", "set-cookie"];
            if (headers instanceof Headers) {
                headers.forEach((v, k) => {
                    if (!blocked.includes(k.toLowerCase())) out[k] = v;
                });
            } else if (Array.isArray(headers)) {
                headers.forEach(([k, v]) => {
                    if (!blocked.includes(k.toLowerCase())) out[k] = v;
                });
            } else if (typeof headers === "object") {
                Object.keys(headers).forEach(k => {
                    if (!blocked.includes(k.toLowerCase())) out[k] = headers[k];
                });
            }
            return out;
        }

        function runModFetch(input, init) {
            const urlStr = typeof input === "string" ? input : (input && input.url ? input.url : "");
            if (isRestrictedHost(urlStr)) {
                return Promise.reject(new Error("Restricted network call blocked."));
            }
            const opts = Object.assign({}, init);
            if (opts.headers) {
                opts.headers = cleanHeaders(opts.headers);
            }
            opts.credentials = "omit";
            return window.fetch(input, opts);
        }

        function createModXHR() {
            const xhr = new XMLHttpRequest();
            const origOpen = xhr.open;
            const origSetHeader = xhr.setRequestHeader;
            let isBlocked = false;

            xhr.open = function(method, url) {
                if (isRestrictedHost(url)) {
                    isBlocked = true;
                    return;
                }
                return origOpen.apply(xhr, arguments);
            };

            xhr.setRequestHeader = function(header, value) {
                if (isBlocked) return;
                const h = header.toLowerCase();
                if (h === "x-authorization" || h === "authorization" || h === "cookie") return;
                return origSetHeader.apply(xhr, arguments);
            };

            const origSend = xhr.send;
            xhr.send = function() {
                if (isBlocked) {
                    setTimeout(() => {
                        if (xhr.onerror) xhr.onerror(new Event("error"));
                    }, 0);
                    return;
                }
                return origSend.apply(xhr, arguments);
            };

            return xhr;
        }

        function getVirtualDoc(modId) {
            return new Proxy(document, {
                get(target, prop) {
                    if (prop === "cookie") {
                        return virtualCookies.get(modId) || "";
                    }
                    if (prop === "defaultView") {
                        return getVirtualWindow(modId);
                    }
                    const val = Reflect.get(target, prop);
                    if (typeof val === "function") return val.bind(target);
                    return val;
                },
                set(target, prop, value) {
                    if (prop === "cookie") {
                        virtualCookies.set(modId, String(value || ""));
                        return true;
                    }
                    return Reflect.set(target, prop, value);
                }
            });
        }

        function getVirtualStorage(modId) {
            if (!virtualStorage.has(modId)) virtualStorage.set(modId, new Map());
            const store = virtualStorage.get(modId);
            return {
                getItem(key) { return store.has(key) ? store.get(key) : null; },
                setItem(key, value) { store.set(String(key), String(value)); },
                removeItem(key) { store.delete(String(key)); },
                clear() { store.clear(); },
                get length() { return store.size; },
                key(idx) { return Array.from(store.keys())[idx] || null; }
            };
        }

        function getVirtualWindow(modId) {
            const doc = getVirtualDoc(modId);
            const storage = getVirtualStorage(modId);
            const win = new Proxy(window, {
                get(target, prop) {
                    if (prop === "document") return doc;
                    if (prop === "cookie") return "";
                    if (prop === "localStorage" || prop === "sessionStorage") return storage;
                    if (prop === "fetch") return runModFetch;
                    if (prop === "XMLHttpRequest") return createModXHR;
                    if (prop === "window" || prop === "globalThis" || prop === "self" || prop === "top" || prop === "parent") return win;
                    if (prop === "ModHubPlayFab" || prop === "sessionTicket" || prop === "activeSession") return undefined;
                    const val = Reflect.get(target, prop);
                    if (typeof val === "function") return val.bind(target);
                    return val;
                },
                set(target, prop, value) {
                    if (prop === "ModHubPlayFab" || prop === "sessionTicket" || prop === "activeSession") return true;
                    return Reflect.set(target, prop, value);
                }
            });
            return win;
        }

        function getContainer(modId) {
            return {
                window: getVirtualWindow(modId),
                document: getVirtualDoc(modId),
                localStorage: getVirtualStorage(modId),
                sessionStorage: getVirtualStorage(modId),
                fetch: runModFetch,
                XMLHttpRequest: createModXHR
            };
        }

        function wrapCode(rawCode, mod) {
            const modId = (mod && (mod.filename || mod.name)) ? String(mod.filename || mod.name).replace(/[^a-zA-Z0-9_]/g, "_") : "mod_" + Date.now();
            return `(function() {
    var __mh_container = window.__mh_get_container(${JSON.stringify(modId)});
    (function(window, document, localStorage, sessionStorage, fetch, XMLHttpRequest, ModHubPlayFab, globalThis, self, top, parent) {
${rawCode}
    })(__mh_container.window, __mh_container.document, __mh_container.localStorage, __mh_container.sessionStorage, __mh_container.fetch, __mh_container.XMLHttpRequest, undefined, __mh_container.window, __mh_container.window, __mh_container.window, __mh_container.window);
})();`;
        }

        window.__mh_get_container = getContainer;

        return {
            wrapCode: wrapCode,
            getContainer: getContainer
        };
    })();

    function getOrCreateHardwareId() {
        try {
            const saved = localStorage.getItem(HWID_STORAGE_KEY);
            if (saved && saved.length > 8) return saved;
        } catch (e) {}

        let parts = [];
        try {
            parts.push(navigator.userAgent || "");
            parts.push(navigator.platform || "");
            parts.push(navigator.language || "");
            parts.push(screen.width + "x" + screen.height);
            parts.push(navigator.hardwareConcurrency || "");
            parts.push(new Date().getTimezoneOffset());
        } catch (e) {
            parts.push("device");
        }

        let hash = 0;
        const str = parts.join("|");
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        const hex = Math.abs(hash).toString(16).padStart(8, "0");
        let rand = "";
        try {
            const buf = new Uint8Array(6);
            crypto.getRandomValues(buf);
            rand = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
        } catch (e) {
            rand = Math.random().toString(16).slice(2, 14);
        }
        const hwid = "DEV-" + hex + "-" + rand;
        try {
            localStorage.setItem(HWID_STORAGE_KEY, hwid);
        } catch (e) {}
        return hwid;
    }

    function saveSession(data) {
        try { localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(data)); } catch (e) {}
    }

    function getSavedSession() {
        try {
            const raw = localStorage.getItem(AUTH_SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function clearSession() {
        try { localStorage.removeItem(AUTH_SESSION_KEY); } catch (e) {}
        activeSession = null;
        currentUserEmail = null;
        currentPlayFabId = null;
        currentUsername = "";
        currentBalance = 0;
        isUserAdmin = false;
        purchasedMods.clear();
    }

    async function loginWithCustomId(customId, username) {
        if (!customId || !customId.trim()) throw new Error("Hardware ID / Device ID required.");
        const cleanId = customId.trim();
        const res = await fetch(PLAYFAB_LOGIN_CUSTOM_ID_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                TitleId: PLAYFAB_TITLE_ID,
                CustomId: cleanId,
                CreateAccount: true,
                InfoRequestParameters: { GetUserAccountInfo: true }
            })
        });
        const data = await res.json();
        if (!res.ok || data.error) {
            if (data.errorCode === PLAYFAB_ACCOUNT_BANNED_CODE) {
                showBanScreen(parseBanError(data).reason, parseBanError(data).timeLeft);
                return;
            }
            throw new Error(data.errorMessage || `HTTP ${res.status}`);
        }
        const result = data.data;
        let dispName = result.InfoResultPayload?.AccountInfo?.TitleInfo?.DisplayName ||
                       result.InfoResultPayload?.AccountInfo?.Username ||
                       cleanId;

        if (username && username.trim() && username.trim() !== dispName) {
            const trimmedName = username.trim();
            if (/^[a-zA-Z0-9_\-]{3,20}$/.test(trimmedName)) {
                try {
                    await fetch(PLAYFAB_UPDATE_NAME_URL, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "X-Authorization": result.SessionTicket },
                        body: JSON.stringify({ DisplayName: trimmedName })
                    });
                    dispName = trimmedName;
                } catch (e) {}
            }
        }

        const session = {
            titleId: PLAYFAB_TITLE_ID,
            sessionTicket: result.SessionTicket,
            playFabId: result.PlayFabId,
            customId: cleanId,
            username: dispName,
            loggedInAt: new Date().toISOString()
        };

        activeSession = session;
        currentUserEmail = null;
        currentPlayFabId = result.PlayFabId;
        currentUsername = dispName;
        saveSession(session);
        startBanPolling();
        return session;
    }

    async function loginWithEmail(email, password) {
        const res = await fetch(PLAYFAB_LOGIN_EMAIL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ TitleId: PLAYFAB_TITLE_ID, Email: email, Password: password, InfoRequestParameters: { GetUserAccountInfo: true } })
        });
        const data = await res.json();
        if (!res.ok || data.error) {
            if (data.errorCode === PLAYFAB_ACCOUNT_BANNED_CODE) {
                showBanScreen(parseBanError(data).reason, parseBanError(data).timeLeft);
                return;
            }
            throw new Error(data.errorMessage || `HTTP ${res.status}`);
        }
        const result = data.data;
        const username = result.InfoResultPayload?.AccountInfo?.TitleInfo?.DisplayName || result.InfoResultPayload?.AccountInfo?.Username || "";
        const session = { titleId: PLAYFAB_TITLE_ID, sessionTicket: result.SessionTicket, playFabId: result.PlayFabId, email: email, username: username, loggedInAt: new Date().toISOString() };
        activeSession = session;
        currentUserEmail = email;
        currentPlayFabId = result.PlayFabId;
        currentUsername = username;
        saveSession(session);
        startBanPolling();
        return session;
    }

    async function registerWithEmail(email, password, username) {
        const payload = { TitleId: PLAYFAB_TITLE_ID, Email: email, Password: password, RequireBothUsernameAndEmail: false };
        if (username && username.trim().length > 0) payload.Username = username.trim();
        const res = await fetch(PLAYFAB_REGISTER_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.errorMessage || `HTTP ${res.status}`);
        const result = data.data;
        const session = { titleId: PLAYFAB_TITLE_ID, sessionTicket: result.SessionTicket, playFabId: result.PlayFabId, email: email, username: result.Username || username || "", loggedInAt: new Date().toISOString() };
        activeSession = session;
        currentUserEmail = email;
        currentPlayFabId = result.PlayFabId;
        currentUsername = session.username;
        saveSession(session);
        startBanPolling();
        return session;
    }

    async function executeCloudScript(functionName, functionParameter = {}) {
        if (!activeSession || !activeSession.sessionTicket) throw new Error("Not logged in.");
        const res = await fetch(PLAYFAB_EXECUTE_CS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Authorization": activeSession.sessionTicket },
            body: JSON.stringify({ FunctionName: functionName, FunctionParameter: functionParameter, GeneratePlayStreamEvent: false })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.errorMessage || `HTTP ${res.status}`);
        if (data.data?.Error) throw new Error(`CloudScript error: ${data.data.Error.Message}`);
        return data.data?.FunctionResult;
    }

    async function streamCodeChunks(code, onProgress) {
        const totalChunks = Math.ceil(code.length / CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
            const chunk = code.substr(i * CHUNK_SIZE, CHUNK_SIZE);
            if (onProgress) onProgress(i + 1, totalChunks);
            const res = await executeCloudScript("uploadCodeChunk", { index: i, chunk: chunk });
            if (!res || !res.success) throw new Error(res?.error || `Chunk ${i + 1} failed.`);
            if (i < totalChunks - 1) await new Promise(r => setTimeout(r, 150));
        }
        return { totalChunks };
    }

    let banCheckTimer = null;
    let banScreenShown = false;

    function parseBanError(data) {
        const reason = (data && data.errorMessage) || "Account banned.";
        let timeLeft = "Unknown";
        if (data && data.errorDetails) {
            for (const key in data.errorDetails) {
                const val = data.errorDetails[key];
                if (Array.isArray(val) && val.length > 0) { timeLeft = String(val[0]); break; }
            }
        }
        return { reason, timeLeft };
    }

    function showBanScreen(reason, timeLeft) {
        if (banScreenShown) return;
        banScreenShown = true;
        if (banCheckTimer) clearInterval(banCheckTimer);
        if (!hubWindow) showHubWindow();
        hubWindow.classList.add("banned");
        hubWindow.innerHTML = `
            <div class="mod-hub-header">
                <div><span style="font-size: 14px; font-weight: bold; color: #fff;">Account Suspended</span></div>
                <button class="mod-hub-close" id="modHubClose">&times;</button>
            </div>
            <div class="mod-hub-auth-container">
                <div class="mod-hub-auth-card" style="text-align: center; border-color: #666;">
                    <h2 style="font-size: 18px; color: #eee; margin: 0 0 10px 0;">Access Suspended</h2>
                    <div style="background: #181818; border: 1px solid #333; border-radius: 4px; padding: 12px; margin-bottom: 12px; text-align: left;">
                        <div style="font-size: 11px; color: #aaa; margin-bottom: 4px;">Reason:</div>
                        <div style="font-size: 12px; color: #fff; font-weight: bold;">${escapeHtml(reason)}</div>
                        <div style="font-size: 11px; color: #aaa; margin-top: 8px; margin-bottom: 4px;">Duration:</div>
                        <div style="font-size: 12px; color: #fff; font-weight: bold;">${escapeHtml(timeLeft)}</div>
                    </div>
                    <button class="mod-hub-auth-submit-btn" id="mh-ban-dismiss" style="width: 100%;">Close</button>
                </div>
            </div>
        `;
        document.getElementById("modHubClose").onclick = closeHubWindow;
        document.getElementById("mh-ban-dismiss").onclick = closeHubWindow;
    }

    function startBanPolling() {
        if (banCheckTimer) return;
        banCheckTimer = setInterval(async () => {
            if (banScreenShown || !activeSession?.sessionTicket) return;
            try {
                const res = await fetch(PLAYFAB_INVENTORY_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Authorization": activeSession.sessionTicket },
                    body: JSON.stringify({})
                });
                const data = await res.json();
                if (!res.ok && data.errorCode === PLAYFAB_ACCOUNT_BANNED_CODE) {
                    showBanScreen(parseBanError(data).reason, parseBanError(data).timeLeft);
                }
            } catch (e) {}
        }, BAN_CHECK_INTERVAL_MS);
    }

    function closeHubWindow() {
        if (!hubWindow) return;
        hubWindow.classList.remove("show");
        setTimeout(() => { if (hubWindow) { hubWindow.remove(); hubWindow = null; } }, 200);
    }

    function setupDragging(header, windowElement) {
        let dragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener("pointerdown", (e) => {
            if (e.target.id === "modHubClose" || e.target.id === "mh-logout-btn" || e.target.id === "mh-toggle-upload-btn") return;
            dragging = true;
            const rect = windowElement.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            let left = Math.max(10, Math.min(e.clientX - offsetX, window.innerWidth - windowElement.offsetWidth - 10));
            let top = Math.max(10, Math.min(e.clientY - offsetY, window.innerHeight - windowElement.offsetHeight - 10));
            windowElement.style.left = left + "px";
            windowElement.style.top = top + "px";
            windowElement.style.transform = "none";
        });
        document.addEventListener("pointerup", () => { dragging = false; });
    }

    registerMod({
        name: "Mod Hub",
        version: "2.2.0",
        init() {
            injectStyles();
            createToolbarMenu();
            const saved = getSavedSession();
            if (saved && saved.sessionTicket) {
                activeSession = saved;
                currentUserEmail = saved.email || null;
                currentPlayFabId = saved.playFabId || null;
                currentUsername = saved.username || "";
                startBanPolling();
            }
        },
        destroy() {
            if (hubWindow) { hubWindow.remove(); hubWindow = null; }
            if (toolbarMenu) { toolbarMenu.remove(); toolbarMenu = null; }
            if (styleTag) { styleTag.remove(); styleTag = null; }
            if (banCheckTimer) { clearInterval(banCheckTimer); banCheckTimer = null; }
            toolbarRetries = 0;
        }
    });

    function parseJsonl(text) {
        const out = [];
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const item = JSON.parse(line);
                item.category = item.category != null ? item.category.toString().toLowerCase().trim() : "";
                out.push(item);
            } catch (err) {}
        }
        out.sort((a, b) => {
            const aP = a.pinned === "true" || a.pinned === true;
            const bP = b.pinned === "true" || b.pinned === true;
            if (aP !== bP) return aP ? -1 : 1;

            const aLikes = parseInt(a.likes || "0", 10) || 0;
            const aViews = parseInt(a.views || "0", 10) || 0;
            const bLikes = parseInt(b.likes || "0", 10) || 0;
            const bViews = parseInt(b.views || "0", 10) || 0;

            const aScore = (aLikes * 3) + aViews;
            const bScore = (bLikes * 3) + bViews;
            return bScore - aScore;
        });
        return out;
    }

    async function fetchModList() {
        const result = await executeCloudScript("getModList");
        if (!result || !result.success) throw new Error(result?.error || "Failed to retrieve mod list.");
        isUserAdmin = (result.isAdmin === true);
        currentBalance = result.balance || 0;
        currentPlayFabId = result.playFabId || currentPlayFabId;
        if (result.username) currentUsername = result.username;
        purchasedMods.clear();
        if (Array.isArray(result.purchasedMods)) result.purchasedMods.forEach(fn => purchasedMods.add(fn));
        updateHeaderDisplay();
        return parseJsonl(result.data);
    }

    async function fetchModCode(filename) {
        const result = await executeCloudScript("getModCode", { filename: filename });
        if (!result || !result.success) throw new Error(result?.error || `Failed to fetch "${filename}".`);
        if (result.views != null && selectedMod && selectedMod.filename === filename) {
            selectedMod.views = String(result.views);
            const viewEl = document.getElementById("mh-view-count");
            if (viewEl) viewEl.textContent = `Views: ${result.views}`;
        }
        return { code: result.code, locked: !!result.locked };
    }

    function updateHeaderDisplay() {
        const balEl = document.getElementById("mh-balance-display");
        if (balEl) balEl.textContent = `${currentBalance} MH`;
        const userLabel = document.getElementById("mh-user-display");
        if (userLabel) {
            userLabel.innerHTML = `${escapeHtml(currentUsername || currentUserEmail || "Logged In")} ${isUserAdmin ? '<b style="color:#ffffff;">(ADMIN)</b>' : ''}`;
        }
    }

    function createToolbarMenu() {
        const toolbar = document.querySelector(".toolbar");
        if (!toolbar) {
            if (toolbarRetries < 100) {
                toolbarRetries++;
                setTimeout(createToolbarMenu, 100);
            } else {
                console.warn("Mod Hub: toolbar not found.");
            }
            return;
        }
        toolbarMenu = document.createElement("details");
        toolbarMenu.className = "toolbar-category";
        toolbarMenu.id = "mod-hub-menu";
        toolbarMenu.innerHTML = `
            <summary>Mod Hub</summary>
            <div class="toolbar-category-dropdown" style="padding: 10px; min-width: 160px; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.6);">
                <button id="mh-open-btn" style="width:100%; text-align:center; padding: 6px 12px; background: #2c2c2c; border: 1px solid #444; color:#fff; font-weight:bold; border-radius:4px; cursor:pointer;">Open Mod Hub</button>
            </div>
        `;
        toolbar.appendChild(toolbarMenu);
        toolbarMenu.addEventListener("toggle", () => {
            if (toolbarMenu.open) document.querySelectorAll(".toolbar-category").forEach(o => { if (o !== toolbarMenu) o.removeAttribute("open"); });
        });
        document.getElementById("mh-open-btn").onclick = () => { toolbarMenu.removeAttribute("open"); showHubWindow(); };
    }

    function showHubWindow() {
        if (hubWindow) {
            hubWindow.classList.remove("show");
            setTimeout(() => hubWindow.classList.add("show"), 10);
            return;
        }
        hubWindow = document.createElement("div");
        hubWindow.className = "mod-hub-window";
        document.body.appendChild(hubWindow);
        if (!activeSession || !activeSession.sessionTicket) renderAuthScreen("device");
        else renderMainAppScreen();
        requestAnimationFrame(() => hubWindow.classList.add("show"));
    }

    function renderModal(title, contentHtml) {
        const existing = document.getElementById("mh-generic-modal");
        if (existing) existing.remove();
        const modal = document.createElement("div");
        modal.id = "mh-generic-modal";
        modal.className = "mod-hub-modal-backdrop";
        modal.innerHTML = `
            <div class="mod-hub-modal-card">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; padding-bottom:8px; margin-bottom:12px;">
                    <div style="font-size:14px; font-weight:bold; color:#fff;">${escapeHtml(title)}</div>
                    <button class="mod-hub-close" id="mh-modal-close">&times;</button>
                </div>
                <div style="font-size:12px; color:#ccc; line-height:1.5; max-height:300px; overflow-y:auto;">
                    ${contentHtml}
                </div>
                <div style="margin-top:14px; text-align:right;">
                    <button class="mod-hub-auth-submit-btn" id="mh-modal-ok" style="padding:6px 16px;">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        document.getElementById("mh-modal-close").onclick = () => modal.remove();
        document.getElementById("mh-modal-ok").onclick = () => modal.remove();
    }

    function showPrivacyPolicy() {
        renderModal("Privacy Policy", `
            <p>Mod Hub does not collect or sell personal information.</p>
            <p>Authentication utilizes hardware or custom identifiers solely to verify account continuity, mod inventory, and moderation status. Session authentication tokens are managed within private runtime closures and blocked from mod script environments.</p>
            <p>Uploaded mods and descriptions are public within the community directory.</p>
        `);
    }

    function showTermsOfService() {
        renderModal("Terms of Service", `
            <p>1. By uploading mods to Mod Hub, you confirm the code does not contain malicious exploits, credential harvesters, or damaging routines.</p>
            <p>2. Mods loaded via Mod Hub run in an isolated execution container. Any attempt to bypass sandboxing or hijack authentication cookies will result in an immediate hardware suspension.</p>
            <p>3. Virtual currency (MH) is an in-game simulated currency with no real-world monetary value.</p>
        `);
    }

    function showCredits() {
        renderModal("Credits", `
            <p><b>Simbox Engine:</b> Core simulation grid and physics platform.</p>
            <p><b>PlayFab Services:</b> Cloud infrastructure and title data storage.</p>
            <p><b>Community Mod Authors:</b> Custom element behaviors and sandbox tools.</p>
        `);
    }

    function renderAuthScreen(mode = "device") {
        if (!hubWindow) return;
        const currentHwid = getOrCreateHardwareId();

        let formFieldsHtml = "";
        if (mode === "device") {
            formFieldsHtml = `
                <div class="mod-hub-input-group">
                    <label>Hardware ID</label>
                    <input type="text" id="mh-auth-hwid" value="${escapeHtml(currentHwid)}" readonly style="color:#aaa;">
                </div>
                <div class="mod-hub-input-group">
                    <label>Username</label>
                    <input type="text" id="mh-auth-username" placeholder="Choose a name" maxlength="20">
                </div>
            `;
        } else if (mode === "custom") {
            formFieldsHtml = `
                <div class="mod-hub-input-group">
                    <label>Custom ID</label>
                    <input type="text" id="mh-auth-customid" placeholder="Enter custom identifier" required maxlength="40">
                </div>
                <div class="mod-hub-input-group">
                    <label>Username</label>
                    <input type="text" id="mh-auth-username" placeholder="Choose a name" maxlength="20">
                </div>
            `;
        } else {
            formFieldsHtml = `
                <div class="mod-hub-input-group">
                    <label>Email Address</label>
                    <input type="email" id="mh-auth-email" required>
                </div>
                <div class="mod-hub-input-group">
                    <label>Password</label>
                    <input type="password" id="mh-auth-password" required>
                </div>
            `;
        }

        hubWindow.innerHTML = `
            <div class="mod-hub-header" id="modHubHeader">
                <div><span style="font-size: 14px; font-weight: bold; color: #fff;">Mod Hub Login</span></div>
                <button class="mod-hub-close" id="modHubClose">&times;</button>
            </div>
            <div class="mod-hub-auth-container">
                <div class="mod-hub-auth-card">
                    <div class="mod-hub-auth-tabs">
                        <button class="mod-hub-tab-btn ${mode === 'device' ? 'active' : ''}" id="mh-tab-device">Device ID</button>
                        <button class="mod-hub-tab-btn ${mode === 'custom' ? 'active' : ''}" id="mh-tab-custom">Custom ID</button>
                        <button class="mod-hub-tab-btn ${mode === 'email' ? 'active' : ''}" id="mh-tab-email">Email</button>
                    </div>
                    <form class="mod-hub-auth-form" id="mh-auth-form">
                        ${formFieldsHtml}
                        <div class="mod-hub-auth-status" id="mh-auth-status"></div>
                        <button type="submit" class="mod-hub-auth-submit-btn" id="mh-auth-submit">Log In</button>
                    </form>
                    <div class="mod-hub-auth-footer-links">
                        <a href="javascript:void(0)" id="mh-link-privacy">Privacy</a> &bull;
                        <a href="javascript:void(0)" id="mh-link-terms">Terms</a> &bull;
                        <a href="javascript:void(0)" id="mh-link-credits">Credits</a>
                    </div>
                </div>
            </div>
        `;

        setupDragging(document.getElementById("modHubHeader"), hubWindow);
        document.getElementById("modHubClose").onclick = closeHubWindow;
        document.getElementById("mh-tab-device").onclick = () => renderAuthScreen("device");
        document.getElementById("mh-tab-custom").onclick = () => renderAuthScreen("custom");
        document.getElementById("mh-tab-email").onclick = () => renderAuthScreen("email");

        document.getElementById("mh-link-privacy").onclick = showPrivacyPolicy;
        document.getElementById("mh-link-terms").onclick = showTermsOfService;
        document.getElementById("mh-link-credits").onclick = showCredits;

        document.getElementById("mh-auth-form").onsubmit = async (e) => {
            e.preventDefault();
            const status = document.getElementById("mh-auth-status");
            const btn = document.getElementById("mh-auth-submit");
            btn.disabled = true;
            status.textContent = "";

            try {
                if (mode === "device") {
                    const hwid = document.getElementById("mh-auth-hwid").value;
                    const u = document.getElementById("mh-auth-username").value;
                    await loginWithCustomId(hwid, u);
                } else if (mode === "custom") {
                    const cid = document.getElementById("mh-auth-customid").value;
                    const u = document.getElementById("mh-auth-username").value;
                    await loginWithCustomId(cid, u);
                } else {
                    const email = document.getElementById("mh-auth-email").value.trim();
                    const password = document.getElementById("mh-auth-password").value;
                    await loginWithEmail(email, password);
                }
                renderMainAppScreen();
            } catch (err) {
                status.textContent = err.message || "Login failed.";
                status.className = "mod-hub-auth-status error";
                btn.disabled = false;
            }
        };
    }

    function renderMainAppScreen() {
        if (!hubWindow) return;
        hubWindow.innerHTML = `
            <div class="mod-hub-sidebar-tab ${isSidebarOpen ? 'open' : ''}" id="mh-sidebar-tab" title="Toggle Menu">
                <span class="mod-hub-sidebar-tab-arrow">&gt;</span>
            </div>
            <div class="mod-hub-header" id="modHubHeader">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size: 14px; font-weight: bold; color: #fff;">Mod Hub</span>
                    <span style="font-size: 9px; color: #888;" id="mh-user-display">${escapeHtml(currentUsername || currentUserEmail || "Logged In")} ${isUserAdmin ? '<b style="color:#ffffff;">(ADMIN)</b>' : ''}</span>
                    <a href="https://discord.gg/2nSBHCp2sd" target="_blank" rel="noopener noreferrer" class="mod-hub-discord-link" title="Discord">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:block;">
                            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.893.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                        </svg>
                    </a>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button class="mod-hub-nav-btn" id="mh-toggle-upload-btn">+ Upload Mod</button>
                    <button class="mod-hub-logout-btn" id="mh-logout-btn">Logout</button>
                    <button class="mod-hub-close" id="modHubClose">&times;</button>
                </div>
            </div>
            <div class="mod-hub-body">
                <div class="mod-hub-sidebar" id="mh-left-sidebar">
                    <div class="mod-hub-sidebar-top">
                        <button class="mod-hub-refresh-btn" id="mh-refresh-btn" title="Refresh">Refresh</button>
                        <button class="mod-hub-filter-btn ${showActiveOnly ? 'active' : ''}" id="mh-filter-btn" title="Filter">Active</button>
                    </div>
                    <div class="mod-hub-search-box">
                        <input type="text" class="mod-hub-search-input" id="mh-search-input" placeholder="Search mods, authors, tags..." value="${escapeHtml(searchQuery)}">
                        <button class="mod-hub-search-btn" id="mh-search-btn" title="Search">Search</button>
                    </div>
                    <div class="mod-hub-cat-pills" id="mh-cat-pills">
                        ${["all", "fun", "cool", "elements", "function", "tool"].map(cat => `
                            <button class="mod-hub-cat-pill ${selectedCategory === cat ? 'active' : ''}" data-cat="${cat}">
                                ${cat.charAt(0).toUpperCase() + cat.slice(1)}
                            </button>
                        `).join("")}
                    </div>
                    <div class="mod-hub-list" id="mh-mod-list"><div class="mod-hub-loading">Loading mods...</div></div>
                </div>
                <div class="mod-hub-main" id="mh-main-panel"><div class="mod-hub-empty-state">Select a mod.</div></div>
                <div class="mod-hub-right-sidebar ${isSidebarOpen ? 'open' : ''}" id="mh-right-sidebar">
                    <button class="mod-hub-side-btn ${activeView === 'mods' ? 'active' : ''}" id="mh-tab-mods">Mods Store</button>
                    <button class="mod-hub-side-btn ${activeView === 'chat' ? 'active' : ''}" id="mh-tab-chat">Chat</button>
                    <button class="mod-hub-side-btn ${activeView === 'community' ? 'active' : ''}" id="mh-tab-community">Community</button>
                    <button class="mod-hub-side-btn ${activeView === 'installed' ? 'active' : ''}" id="mh-tab-installed">Installed</button>
                    <button class="mod-hub-side-btn ${activeView === 'settings' ? 'active' : ''}" id="mh-tab-settings">Settings</button>
                    <button class="mod-hub-side-btn ${activeView === 'about' ? 'active' : ''}" id="mh-tab-about">About</button>
                </div>
            </div>
        `;

        setupDragging(document.getElementById("modHubHeader"), hubWindow);
        document.getElementById("modHubClose").onclick = closeHubWindow;
        document.getElementById("mh-logout-btn").onclick = () => { clearSession(); renderAuthScreen("device"); };

        const tab = document.getElementById("mh-sidebar-tab");
        const sidebar = document.getElementById("mh-right-sidebar");
        tab.onclick = () => { isSidebarOpen = !isSidebarOpen; tab.classList.toggle("open", isSidebarOpen); sidebar.classList.toggle("open", isSidebarOpen); };

        ["mods","chat","community","installed","settings","about"].forEach(v => {
            const btn = document.getElementById(`mh-tab-${v}`);
            if (btn) btn.onclick = () => switchView(v);
        });

        document.getElementById("mh-toggle-upload-btn").onclick = () => {
            isUploadMode = !isUploadMode;
            if (isUploadMode) renderUploadScreen();
            else switchView("mods");
        };
        document.getElementById("mh-refresh-btn").onclick = () => loadModList();
        document.getElementById("mh-filter-btn").onclick = () => {
            showActiveOnly = !showActiveOnly;
            document.getElementById("mh-filter-btn").classList.toggle("active", showActiveOnly);
            renderModList();
        };

        const searchInput = document.getElementById("mh-search-input");
        const triggerSearch = () => { searchQuery = searchInput.value.trim().toLowerCase(); renderModList(); };
        searchInput.addEventListener("input", triggerSearch);
        document.getElementById("mh-search-btn").onclick = triggerSearch;

        document.getElementById("mh-cat-pills").querySelectorAll(".mod-hub-cat-pill").forEach(pill => {
            pill.onclick = () => {
                document.querySelectorAll(".mod-hub-cat-pill").forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
                selectedCategory = pill.getAttribute("data-cat");
                renderModList();
            };
        });

        loadModList();
    }

    function switchView(viewName) {
        activeView = viewName;
        document.querySelectorAll(".mod-hub-side-btn").forEach(b => b.classList.remove("active"));
        const btn = document.getElementById(`mh-tab-${viewName}`);
        if (btn) btn.classList.add("active");

        isSidebarOpen = false;
        const sidebarTab = document.getElementById("mh-sidebar-tab");
        const sidebar = document.getElementById("mh-right-sidebar");
        if (sidebarTab) sidebarTab.classList.remove("open");
        if (sidebar) sidebar.classList.remove("open");

        const leftSidebar = document.getElementById("mh-left-sidebar");
        if (viewName === "mods") {
            if (leftSidebar) leftSidebar.style.display = "flex";
            loadModList();
        } else {
            if (leftSidebar) leftSidebar.style.display = "none";
            renderSectionView(viewName);
        }
    }

    function renderSectionView(viewName) {
        const main = document.getElementById("mh-main-panel");
        if (!main) return;

        if (viewName === "chat") {
            main.innerHTML = `
                <div class="mod-hub-tab-page" style="height:100%; display:flex; flex-direction:column;">
                    <h2 class="mod-hub-tab-header">Community Live Chat</h2>
                    <div class="mod-hub-chat-box" id="mh-chat-history">
                        ${chatMessages.map(m => `<div class="mod-hub-chat-msg"><span class="mod-hub-chat-user">${escapeHtml(m.sender)}:</span><span class="mod-hub-chat-text">${escapeHtml(m.text)}</span><span class="mod-hub-chat-time">${m.time}</span></div>`).join("")}
                    </div>
                    <form id="mh-chat-form" style="display:flex; gap:8px; margin-top:8px;">
                        <input type="text" id="mh-chat-input" placeholder="Type a message..." required style="flex:1; background:#141414; border:1px solid #333; border-radius:4px; padding:8px 10px; color:#fff; font-size:12px; outline:none;">
                        <button type="submit" class="mod-hub-add-btn" style="padding:8px 16px; font-size:11px;">Send</button>
                    </form>
                </div>
            `;
            const chatHistory = document.getElementById("mh-chat-history");
            chatHistory.scrollTop = chatHistory.scrollHeight;
            document.getElementById("mh-chat-form").onsubmit = (e) => {
                e.preventDefault();
                const input = document.getElementById("mh-chat-input");
                if (!input.value.trim()) return;
                chatMessages.push({ sender: currentUsername || "Player", text: input.value.trim(), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
                input.value = "";
                renderSectionView("chat");
            };
        } else if (viewName === "community") {
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Community Profile</h2>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
                        <div class="mod-hub-card">
                            <div style="font-size:12px; font-weight:bold; color:#fff; margin-bottom:6px;">Your Profile</div>
                            <div style="font-size:11px; color:#ccc;">User: <b style="color:#fff;">${escapeHtml(currentUsername || currentUserEmail || "Guest")}</b></div>
                            <div style="font-size:11px; color:#ccc; margin-top:3px;">Status: Online</div>
                        </div>
                        <div class="mod-hub-card">
                            <div style="font-size:12px; font-weight:bold; color:#fff; margin-bottom:6px;">Directory Status</div>
                            <div style="font-size:11px; color:#aaa;">Mods in registry: ${mods.length}</div>
                            <div style="font-size:11px; color:#aaa; margin-top:3px;">Running in sandbox: ${loadedMods.size}</div>
                        </div>
                    </div>
                </div>
            `;
        } else if (viewName === "installed") {
            const loadedArr = Array.from(loadedMods.entries());
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Installed Sandboxed Mods</h2>
                    <div style="display:flex; gap:12px; margin-bottom:12px;">
                        <div class="mod-hub-card" style="flex:1;"><div style="font-size:11px; color:#aaa;">Available Mods</div><div style="font-size:20px; font-weight:bold; color:#fff; margin-top:4px;">${mods.length}</div></div>
                        <div class="mod-hub-card" style="flex:1;"><div style="font-size:11px; color:#aaa;">Active In Sandbox</div><div style="font-size:20px; font-weight:bold; color:#fff; margin-top:4px;">${loadedMods.size}</div></div>
                    </div>
                    <div class="mod-hub-card" style="flex:1;">
                        <div style="font-size:12px; font-weight:bold; color:#fff; margin-bottom:8px;">Running Instances</div>
                        ${loadedArr.length === 0 ? '<div style="font-size:12px; color:#888;">No mods currently running in sandbox container.</div>' : `
                            <div style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto;">
                                ${loadedArr.map(([fn, id]) => `
                                    <div style="display:flex; justify-content:space-between; align-items:center; background:#141414; padding:8px 12px; border-radius:4px; border:1px solid #282828;">
                                        <span style="font-family:monospace; font-size:12px; color:#fff;">${escapeHtml(fn)}</span>
                                        <span style="font-size:10px; color:#fff; background:#383838; padding:2px 6px; border-radius:3px;">RUNNING</span>
                                    </div>
                                `).join("")}
                            </div>
                        `}
                    </div>
                </div>
            `;
        } else if (viewName === "settings") {
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Settings</h2>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:bold; color:#fff;">Sandboxed Containers</div>
                            </div>
                            <span style="color:#fff; font-size:12px; font-weight:bold;">ENABLED</span>
                        </div>
                        <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:bold; color:#fff;">Active Session</div>
                            </div>
                            <button class="mod-hub-logout-btn" id="mh-clear-session-btn" style="padding:6px 12px; font-size:11px;">Clear Session</button>
                        </div>
                        <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:bold; color:#fff;">Loaded Mods (${loadedMods.size})</div>
                            </div>
                            <button class="mod-hub-unload-btn" id="mh-unload-all-btn" style="padding:6px 12px; font-size:11px;">Unload All</button>
                        </div>
                    </div>
                </div>
            `;
            document.getElementById("mh-clear-session-btn").onclick = () => {
                clearSession();
                renderAuthScreen("device");
            };
            document.getElementById("mh-unload-all-btn").onclick = () => {
                try {
                    Array.from(loadedMods.keys()).forEach(fn => {
                        const modObj = mods.find(m => m.filename === fn);
                        if (modObj) unloadModFromGame(modObj);
                    });
                } catch(e){}
                renderSectionView("settings");
            };
        } else if (viewName === "about") {
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">About & Policies</h2>
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <div class="mod-hub-card">
                            <div style="font-size:13px; font-weight:bold; color:#fff; margin-bottom:6px;">Privacy Policy</div>
                            <div style="font-size:11px; color:#ccc; line-height:1.4;">Hardware and custom identifiers are used solely for authentication and mod verification. Cookies and credentials are protected from sandboxed mod access.</div>
                        </div>
                        <div class="mod-hub-card">
                            <div style="font-size:13px; font-weight:bold; color:#fff; margin-bottom:6px;">Terms of Service</div>
                            <div style="font-size:11px; color:#ccc; line-height:1.4;">Uploaded code must comply with safety standards. Harvesters, credential stealers, and exploitative routines are strictly prohibited.</div>
                        </div>
                        <div class="mod-hub-card">
                            <div style="font-size:13px; font-weight:bold; color:#fff; margin-bottom:6px;">Credits</div>
                            <div style="font-size:11px; color:#ccc; line-height:1.4;">Simbox Simulation Engine, PlayFab Backend Services, and Community Mod Creators.</div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            main.innerHTML = `<div class="mod-hub-tab-page"><h2 class="mod-hub-tab-header">${viewName.toUpperCase()}</h2></div>`;
        }
    }

    function getCategoryList(catString) {
        if (!catString) return [];
        return catString.split(/[\s,]+/).map(c => c.trim().toLowerCase()).filter(Boolean);
    }

    function renderTagSelector(containerId, activeTags = []) {
        const allCategories = ["fun", "cool", "elements", "function", "tool"];
        const selected = new Set(activeTags.map(t => t.toLowerCase()));
        return `
            <div id="${containerId}" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:2px;">
                ${allCategories.map(cat => `
                    <button type="button" class="mod-hub-tag-pick-btn ${selected.has(cat) ? 'selected' : ''}" data-cat="${cat}" style="background:${selected.has(cat) ? '#383838' : '#222'}; border:1px solid ${selected.has(cat) ? '#777' : '#383838'}; color:${selected.has(cat) ? '#fff' : '#aaa'}; border-radius:12px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer;">
                        ${selected.has(cat) ? '[X] ' : '[+] '}${cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </button>
                `).join("")}
            </div>
        `;
    }

    function setupTagSelectorEvents(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll(".mod-hub-tag-pick-btn").forEach(btn => {
            btn.onclick = () => {
                const isSel = btn.classList.toggle("selected");
                const cat = btn.getAttribute("data-cat");
                btn.style.background = isSel ? "#383838" : "#222";
                btn.style.borderColor = isSel ? "#777" : "#383838";
                btn.style.color = isSel ? "#fff" : "#aaa";
                btn.textContent = (isSel ? "[X] " : "[+] ") + cat.charAt(0).toUpperCase() + cat.slice(1);
            };
        });
    }

    function getSelectedTagsFromContainer(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return "";
        const tags = [];
        container.querySelectorAll(".mod-hub-tag-pick-btn.selected").forEach(btn => {
            tags.push(btn.getAttribute("data-cat"));
        });
        return tags.join(",");
    }

    function renderUploadScreen() {
        const main = document.getElementById("mh-main-panel");
        if (!main) return;
        main.innerHTML = `
            <div class="mod-hub-upload-card">
                <h2 style="font-size:18px; margin:0 0 6px 0; color:#fff;">Upload a New Mod</h2>
                <form id="mh-upload-form" style="display:flex; flex-direction:column; gap:10px;">
                    <div class="mod-hub-input-group"><label>Mod Name</label><input type="text" id="mh-up-name" required placeholder="e.g. Laser Particle"></div>
                    <div class="mod-hub-input-group"><label>Filename</label><input type="text" id="mh-up-filename" required placeholder="e.g. laser.js"></div>
                    <div class="mod-hub-input-group"><label>Version</label><input type="text" id="mh-up-version" value="1.0.0" required></div>
                    <div class="mod-hub-input-group"><label>Category Tags</label>${renderTagSelector("mh-upload-tags-box")}</div>
                    <div class="mod-hub-input-group"><label>Description</label><textarea id="mh-up-desc" rows="2" required style="background:#141414; border:1px solid #383838; border-radius:4px; padding:8px; color:#fff; font-size:12px; outline:none; resize:none;"></textarea></div>
                    <div class="mod-hub-input-group"><label>JavaScript Code</label><textarea id="mh-up-code" rows="8" required style="background:#141414; border:1px solid #383838; border-radius:4px; padding:8px; color:#fff; font-family:monospace; font-size:11px; outline:none; resize:none;" placeholder="// Mod code here..."></textarea></div>
                    <div id="mh-upload-status" class="mod-hub-auth-status"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="submit" class="mod-hub-auth-submit-btn" id="mh-upload-submit" style="flex:1;">Submit Mod</button>
                        <button type="button" class="mod-hub-logout-btn" id="mh-upload-cancel" style="padding:10px 16px;">Cancel</button>
                    </div>
                </form>
            </div>
        `;
        setupTagSelectorEvents("mh-upload-tags-box");
        document.getElementById("mh-upload-cancel").onclick = () => { isUploadMode = false; switchView("mods"); };
        document.getElementById("mh-upload-form").onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById("mh-upload-submit");
            const status = document.getElementById("mh-upload-status");
            btn.disabled = true;
            status.textContent = "Uploading code...";
            status.className = "mod-hub-auth-status";

            const code = document.getElementById("mh-up-code").value;
            const payload = {
                name: document.getElementById("mh-up-name").value.trim(),
                filename: document.getElementById("mh-up-filename").value.trim(),
                version: document.getElementById("mh-up-version").value.trim(),
                category: getSelectedTagsFromContainer("mh-upload-tags-box"),
                description: document.getElementById("mh-up-desc").value.trim()
            };

            try {
                await streamCodeChunks(code, (curr, tot) => { status.textContent = `Uploading chunk ${curr}/${tot}...`; });
                status.textContent = "Finalizing upload...";
                const res = await executeCloudScript("finalizeChunkedUpload", payload);
                if (!res || !res.success) throw new Error(res?.error || "Finalize failed.");
                status.textContent = "Mod published successfully.";
                status.className = "mod-hub-auth-status success";
                setTimeout(() => { isUploadMode = false; switchView("mods"); }, 1000);
            } catch (err) {
                status.textContent = err.message;
                status.className = "mod-hub-auth-status error";
                btn.disabled = false;
            }
        };
    }

    function renderEditScreen(mod) {
        const main = document.getElementById("mh-main-panel");
        if (!main) return;
        const currentTags = getCategoryList(mod.category);
        main.innerHTML = `
            <div class="mod-hub-upload-card">
                <h2 style="font-size:18px; margin:0 0 6px 0; color:#fff;">Edit Mod: ${escapeHtml(mod.name)}</h2>
                <form id="mh-edit-form" style="display:flex; flex-direction:column; gap:10px;">
                    <div class="mod-hub-input-group"><label>Mod Name</label><input type="text" id="mh-edit-name" value="${escapeHtml(mod.name || '')}" required></div>
                    <div class="mod-hub-input-group"><label>Version</label><input type="text" id="mh-edit-version" value="${escapeHtml(mod.version || '1.0.0')}" required></div>
                    <div class="mod-hub-input-group"><label>Category Tags</label>${renderTagSelector("mh-edit-tags-box", currentTags)}</div>
                    <div class="mod-hub-input-group"><label>Description</label><textarea id="mh-edit-desc" rows="2" required style="background:#141414; border:1px solid #383838; border-radius:4px; padding:8px; color:#fff; font-size:12px; outline:none; resize:none;">${escapeHtml(mod.Description || "")}</textarea></div>
                    <div class="mod-hub-input-group"><label>Update Code (Optional)</label><textarea id="mh-edit-code" rows="8" style="background:#141414; border:1px solid #383838; border-radius:4px; padding:8px; color:#fff; font-family:monospace; font-size:11px; outline:none; resize:none;" placeholder="Leave empty to keep existing code..."></textarea></div>
                    <div id="mh-edit-status" class="mod-hub-auth-status"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="submit" class="mod-hub-auth-submit-btn" id="mh-edit-submit" style="flex:1;">Save Changes</button>
                        <button type="button" class="mod-hub-logout-btn" id="mh-edit-cancel" style="padding:10px 16px;">Cancel</button>
                    </div>
                </form>
            </div>
        `;
        setupTagSelectorEvents("mh-edit-tags-box");
        document.getElementById("mh-edit-cancel").onclick = () => selectMod(mod);
        document.getElementById("mh-edit-form").onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById("mh-edit-submit");
            const status = document.getElementById("mh-edit-status");
            btn.disabled = true;
            status.textContent = "Saving changes...";
            status.className = "mod-hub-auth-status";

            const code = document.getElementById("mh-edit-code").value;
            const payload = {
                filename: mod.filename,
                name: document.getElementById("mh-edit-name").value.trim(),
                version: document.getElementById("mh-edit-version").value.trim(),
                category: getSelectedTagsFromContainer("mh-edit-tags-box"),
                description: document.getElementById("mh-edit-desc").value.trim()
            };

            try {
                if (code && code.trim().length > 0) {
                    await streamCodeChunks(code, (curr, tot) => { status.textContent = `Uploading code chunk ${curr}/${tot}...`; });
                    payload.hasCodeUpdate = true;
                }
                const res = await executeCloudScript("finalizeChunkedEdit", payload);
                if (!res || !res.success) throw new Error(res?.error || "Save failed.");
                status.textContent = "Changes saved.";
                status.className = "mod-hub-auth-status success";
                setTimeout(() => loadModList(), 1000);
            } catch (err) {
                status.textContent = err.message;
                status.className = "mod-hub-auth-status error";
                btn.disabled = false;
            }
        };
    }

    async function togglePinMod(mod) {
        try {
            const res = await executeCloudScript("adminTogglePinMod", { filename: mod.filename });
            if (!res || !res.success) throw new Error(res?.error || "Failed to toggle pin.");
            loadModList();
        } catch (err) { alert(err.message); }
    }

    async function loadModList() {
        const listDiv = document.getElementById("mh-mod-list");
        if (listDiv) listDiv.innerHTML = '<div class="mod-hub-loading">Loading mods...</div>';
        try {
            mods = await fetchModList();
            renderModList();
            if (mods.length > 0 && !selectedMod) selectMod(mods[0]);
        } catch (err) {
            if (listDiv) listDiv.innerHTML = `<div class="mod-hub-empty-state" style="color:#ff9999;">${escapeHtml(err.message)}</div>`;
        }
    }

    function renderModList() {
        const listDiv = document.getElementById("mh-mod-list");
        if (!listDiv) return;
        listDiv.innerHTML = "";

        const visibleMods = mods.filter(m => {
            if (showActiveOnly && !loadedMods.has(m.filename)) return false;
            if (selectedCategory !== "all") {
                const cats = getCategoryList(m.category);
                if (!cats.includes(selectedCategory)) return false;
            }
            if (searchQuery) {
                const q = searchQuery;
                const name = (m.name || "").toLowerCase();
                const fn = (m.filename || "").toLowerCase();
                const author = (m.author || "").toLowerCase();
                const desc = (m.Description || "").toLowerCase();
                const catStr = (m.category || "").toLowerCase();
                if (!name.includes(q) && !fn.includes(q) && !author.includes(q) && !desc.includes(q) && !catStr.includes(q)) {
                    return false;
                }
            }
            return true;
        });

        if (visibleMods.length === 0) {
            listDiv.innerHTML = `<div class="mod-hub-empty-state" style="grid-column: 1 / -1;">No matching mods found.</div>`;
            return;
        }

        visibleMods.forEach(mod => {
            const item = document.createElement("div");
            item.className = "mod-hub-item" + (selectedMod && selectedMod.filename === mod.filename ? " active" : "");
            const likes = parseInt(mod.likes || "0", 10) || 0;
            const views = parseInt(mod.views || "0", 10) || 0;
            const cats = getCategoryList(mod.category);

            item.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:4px; width:100%; overflow:hidden;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:4px;">
                        <div class="mod-hub-item-name" title="${escapeHtml(mod.name || mod.filename)}">
                            ${mod.pinned ? '[Pinned] ' : ''}${escapeHtml(mod.name || mod.filename)}
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                        <div style="display:flex; flex-wrap:wrap; gap:3px;">
                            ${cats.length > 0 ? cats.map(c => `<span class="mod-hub-cat-badge ${c}">${c.toUpperCase()}</span>`).join("") : '<span></span>'}
                        </div>
                        <div class="mod-hub-item-stats">
                            <span title="Likes">Likes: ${likes}</span>
                            <span title="Views">Views: ${views}</span>
                        </div>
                    </div>
                    ${loadedMods.has(mod.filename) ? '<div style="margin-top:2px;"><span class="mod-hub-added-badge">ACTIVE</span></div>' : ''}
                </div>
            `;
            item.onclick = () => selectMod(mod);
            listDiv.appendChild(item);
        });
    }

    const codeCache = {};
    function buildSnippet(code) {
        const lines = code.split(/\r?\n/);
        let snippet = lines.slice(0, 7).join("\n");
        return { snippet, truncated: lines.length > 7 || snippet.length > 500 };
    }

    function selectMod(mod) {
        selectedMod = mod;
        renderModList();
        const main = document.getElementById("mh-main-panel");
        if (!main) return;

        const isOwner = (currentUsername && mod.author && currentUsername.trim().toLowerCase() === mod.author.trim().toLowerCase()) || isUserAdmin;
        const alreadyAdded = loadedMods.has(mod.filename);
        const cats = getCategoryList(mod.category);

        main.innerHTML = `
            <div class="mod-hub-detail">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:2px; flex-wrap:wrap;">
                            <h2 class="mod-hub-detail-title">${escapeHtml(mod.name)}</h2>
                            ${cats.map(c => `<span class="mod-hub-cat-badge ${c}">${c.toUpperCase()}</span>`).join("")}
                        </div>
                        <div class="mod-hub-detail-filename">by <span style="color:#aaa;">${escapeHtml(mod.author)}</span> &bull; ${escapeHtml(mod.filename)}</div>
                    </div>
                    <div class="mod-hub-stats-row">
                        <button class="mod-hub-like-btn" id="mh-like-btn">Like (<span id="mh-like-count">${mod.likes || 0}</span>)</button>
                        <span class="mod-hub-stat" id="mh-view-count">Views: ${mod.views || 0}</span>
                    </div>
                </div>
                <p class="mod-hub-detail-desc">${escapeHtml(mod.Description || "")}</p>
                <div class="mod-hub-snippet-label">Code Preview</div>
                <pre class="mod-hub-snippet" id="mh-snippet"><code>Loading preview...</code></pre>
                <div class="mod-hub-detail-status" id="mh-status"></div>
                <div class="mod-hub-btn-row">
                    <button class="mod-hub-add-btn" id="mh-add-btn" ${alreadyAdded ? "disabled" : ""}>${alreadyAdded ? "Added to Game" : "Add to Game"}</button>
                    <button class="mod-hub-unload-btn" id="mh-unload-btn" style="${alreadyAdded ? "" : "display:none;"}">Unload</button>
                    ${isOwner && mod.filename !== ADMIN_MOD_FILENAME ? `<button class="mod-hub-edit-btn" id="mh-edit-btn">Edit Mod</button>` : ''}
                    ${isUserAdmin && mod.filename !== ADMIN_MOD_FILENAME ? `<button class="mod-hub-pin-toggle-btn" id="mh-pin-toggle-btn">${mod.pinned ? "Unpin" : "Pin"}</button>` : ''}
                </div>
            </div>
        `;

        document.getElementById("mh-add-btn").onclick = () => addModToGame(mod);
        document.getElementById("mh-unload-btn").onclick = () => unloadModFromGame(mod);
        document.getElementById("mh-like-btn").onclick = () => likeMod(mod);
        if (document.getElementById("mh-edit-btn")) document.getElementById("mh-edit-btn").onclick = () => renderEditScreen(mod);
        if (document.getElementById("mh-pin-toggle-btn")) document.getElementById("mh-pin-toggle-btn").onclick = () => togglePinMod(mod);

        loadSnippet(mod);
    }

    async function likeMod(mod) {
        try {
            const res = await executeCloudScript("likeMod", { filename: mod.filename });
            if (res && res.success) {
                mod.likes = res.likes;
                document.getElementById("mh-like-count").textContent = res.likes;
            }
        } catch (e) {}
    }

    async function loadSnippet(mod) {
        const snippetEl = document.getElementById("mh-snippet");
        if (!snippetEl) return;
        try {
            let res = codeCache[mod.filename];
            if (!res) {
                res = await fetchModCode(mod.filename);
                if (!res.locked) codeCache[mod.filename] = res.code;
            } else res = { code: res, locked: false };
            if (!selectedMod || selectedMod.filename !== mod.filename) return;
            const { snippet, truncated } = buildSnippet(res.code);
            snippetEl.innerHTML = `<code>${escapeHtml(snippet)}${truncated ? "\n…" : ""}</code>`;
        } catch (err) { snippetEl.innerHTML = `<code>Preview unavailable.</code>`; }
    }

    async function addModToGame(mod) {
        if (typeof ModManager === "undefined" || !ModManager) return;
        try {
            let code = codeCache[mod.filename];
            if (!code) {
                const res = await fetchModCode(mod.filename);
                if (res.locked) throw new Error("Purchase required to play.");
                code = res.code;
                codeCache[mod.filename] = code;
            }
            const sandboxedCode = ModSandboxManager.wrapCode(code, mod);
            const reg = ModManager.installBuiltInMod(mod.name || mod.filename, mod.version || "1.0.0", sandboxedCode);
            ModManager.enableMod(reg.id);
            loadedMods.set(mod.filename, reg.id);
            selectMod(mod);
        } catch (err) { alert(err.message); }
    }

    function unloadModFromGame(mod) {
        const id = loadedMods.get(mod.filename);
        if (id && typeof ModManager !== "undefined") {
            ModManager.disableMod(id);
            loadedMods.delete(mod.filename);
            selectMod(mod);
        }
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = String(str ?? "");
        return div.innerHTML;
    }

    function injectStyles() {
        styleTag = document.createElement("style");
        styleTag.id = "mod-hub-styles";
        styleTag.innerHTML = `
            .mod-hub-window { position: fixed; top: 10vh; left: 10vw; width: 880px; height: 580px; min-width: 680px; min-height: 440px; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); color: #fff; font-family: sans-serif; z-index: 100000; display: flex; flex-direction: column; overflow: visible; opacity: 0; transform: scale(0.95); transition: opacity 0.15s ease, transform 0.15s ease; }
            .mod-hub-window.show { opacity: 1; transform: scale(1); }
            .mod-hub-sidebar-tab { position: absolute; right: -24px; top: 50%; transform: translateY(-50%); width: 24px; height: 50px; background: #222; border: 1px solid #333; border-left: none; border-top-right-radius: 4px; border-bottom-right-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #888; font-size: 12px; font-weight: bold; user-select: none; z-index: 10; }
            .mod-hub-sidebar-tab:hover { background: #2c2c2c; color: #fff; }
            .mod-hub-sidebar-tab-arrow { transition: transform 0.3s ease; }
            .mod-hub-sidebar-tab.open .mod-hub-sidebar-tab-arrow { transform: rotate(180deg); }
            .mod-hub-right-sidebar { position: absolute; top: 0; right: 0; width: 180px; height: 100%; background: #161616; border-left: 1px solid #333; transform: translateX(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); z-index: 5; display: flex; flex-direction: column; padding: 12px 8px; gap: 6px; overflow-y: auto; }
            .mod-hub-right-sidebar.open { transform: translateX(0); }
            .mod-hub-side-btn { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #222; border: 1px solid #333; border-radius: 4px; color: #ccc; font-size: 12px; font-weight: 600; cursor: pointer; text-align: left; width: 100%; }
            .mod-hub-side-btn:hover { background: #2c2c2c; color: #fff; }
            .mod-hub-side-btn.active { background: #383838; border-color: #666; color: #fff; }
            .mod-hub-tab-page { display: flex; flex-direction: column; width: 100%; }
            .mod-hub-tab-header { font-size: 18px; font-weight: 700; color: #fff; margin: 0 0 10px 0; }
            .mod-hub-card { background: #181818; border: 1px solid #2d2d2d; border-radius: 4px; padding: 12px 14px; }
            .mod-hub-chat-box { flex: 1; min-height: 220px; max-height: 300px; background: #121212; border: 1px solid #2d2d2d; border-radius: 4px; padding: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
            .mod-hub-chat-msg { display: flex; gap: 8px; font-size: 12px; }
            .mod-hub-chat-user { font-weight: bold; color: #fff; }
            .mod-hub-chat-text { color: #eee; word-break: break-word; }
            .mod-hub-chat-time { font-size: 9px; color: #666; margin-left: auto; }
            .mod-hub-header { background: #222; padding: 10px 14px; border-bottom: 1px solid #333; cursor: move; display: flex; justify-content: space-between; align-items: center; border-top-left-radius: 4px; border-top-right-radius: 4px; }
            .mod-hub-discord-link { display: inline-flex; align-items: center; justify-content: center; color: #aaa; background: #282828; border: 1px solid #383838; border-radius: 4px; padding: 3px 5px; text-decoration: none; }
            .mod-hub-discord-link:hover { color: #fff; border-color: #555; }
            .mod-hub-close { background: none; border: none; color: #888; font-size: 20px; font-weight: bold; cursor: pointer; }
            .mod-hub-close:hover { color: #fff; }
            .mod-hub-nav-btn, .mod-hub-logout-btn { background: #2c2c2c; border: 1px solid #444; color: #fff; border-radius: 4px; font-size: 11px; font-weight: bold; padding: 4px 8px; cursor: pointer; }
            .mod-hub-logout-btn { color: #bbb; background: #242424; }
            .mod-hub-auth-container { flex: 1; display: flex; align-items: center; justify-content: center; background: #151515; padding: 20px; }
            .mod-hub-auth-card { background: #202020; border: 1px solid #333; border-radius: 4px; width: 340px; padding: 24px; }
            .mod-hub-auth-tabs { display: flex; gap: 8px; margin-bottom: 18px; border-bottom: 1px solid #333; padding-bottom: 8px; }
            .mod-hub-tab-btn { flex: 1; background: transparent; border: none; color: #888; font-size: 13px; font-weight: bold; padding: 6px 0; cursor: pointer; border-bottom: 2px solid transparent; }
            .mod-hub-tab-btn.active { color: #fff; border-bottom: 2px solid #888; }
            .mod-hub-auth-form, .mod-hub-input-group { display: flex; flex-direction: column; gap: 8px; }
            .mod-hub-input-group label { font-size: 11px; color: #aaa; font-weight: 600; }
            .mod-hub-input-group input, .mod-hub-input-group textarea, .mod-hub-input-group select { background: #141414; border: 1px solid #383838; border-radius: 4px; padding: 8px; color: #fff; font-size: 12px; outline: none; }
            .mod-hub-auth-status { font-size: 11px; min-height: 14px; }
            .mod-hub-auth-status.error { color: #ff9999; }
            .mod-hub-auth-status.success { color: #cccccc; }
            .mod-hub-auth-submit-btn, .mod-hub-add-btn { background: #383838; border: 1px solid #555; color: #fff; border-radius: 4px; padding: 10px; font-weight: bold; font-size: 12px; cursor: pointer; }
            .mod-hub-auth-submit-btn:hover, .mod-hub-add-btn:hover { background: #484848; }
            .mod-hub-auth-footer-links { margin-top: 16px; text-align: center; font-size: 11px; color: #666; }
            .mod-hub-auth-footer-links a { color: #888; text-decoration: none; }
            .mod-hub-auth-footer-links a:hover { color: #fff; text-decoration: underline; }
            
            .mod-hub-body { display: flex; flex: 1; overflow: hidden; position: relative; }
            .mod-hub-sidebar { width: 50%; min-width: 320px; border-right: 1px solid #333; display: flex; flex-direction: column; background: #151515; }
            .mod-hub-sidebar-top { padding: 8px 10px; border-bottom: 1px solid #2a2a2a; display: flex; gap: 6px; }
            .mod-hub-refresh-btn, .mod-hub-filter-btn { padding: 6px 10px; background: #2c2c2c; border: 1px solid #444; color: #fff; border-radius: 4px; font-weight: 600; font-size: 11px; cursor: pointer; }
            .mod-hub-filter-btn.active { background: #444; border-color: #666; color: #fff; }
            
            .mod-hub-search-box { padding: 6px 10px; display: flex; gap: 6px; background: #181818; border-bottom: 1px solid #282828; }
            .mod-hub-search-input { flex: 1; background: #121212; border: 1px solid #333; border-radius: 4px; padding: 6px 8px; color: #fff; font-size: 11px; outline: none; }
            .mod-hub-search-input:focus { border-color: #666; }
            .mod-hub-search-btn { background: #2c2c2c; border: 1px solid #444; color: #fff; border-radius: 4px; padding: 6px 10px; font-size: 11px; cursor: pointer; }
            .mod-hub-search-btn:hover { background: #383838; }
            
            .mod-hub-cat-pills { padding: 6px 10px; display: flex; flex-wrap: wrap; gap: 4px; background: #151515; border-bottom: 1px solid #282828; }
            .mod-hub-cat-pill { background: #222; border: 1px solid #333; border-radius: 12px; color: #aaa; font-size: 10px; font-weight: 600; padding: 3px 8px; cursor: pointer; }
            .mod-hub-cat-pill:hover { background: #2c2c2c; color: #fff; }
            .mod-hub-cat-pill.active { background: #383838; border-color: #666; color: #fff; }
            
            .mod-hub-list { flex: 1; overflow-y: auto; padding: 8px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; align-content: start; }
            .mod-hub-item { padding: 8px 10px; background: #222; border: 1px solid #2d2d2d; border-radius: 4px; cursor: pointer; font-size: 11px; display: flex; flex-direction: column; }
            .mod-hub-item:hover { background: #292929; border-color: #444; }
            .mod-hub-item.active { background: #303030; border-color: #777; }
            .mod-hub-item-name { font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
            .mod-hub-item-stats { display: flex; gap: 6px; font-size: 10px; color: #888; }
            
            .mod-hub-cat-badge { font-size: 8px; font-weight: 800; padding: 2px 5px; border-radius: 3px; letter-spacing: 0.5px; background: #2a2a2a; color: #ccc; border: 1px solid #444; }
            .mod-hub-added-badge { font-size: 8px; font-weight: bold; color: #fff; background: #444; padding: 1px 4px; border-radius: 3px; }
            
            .mod-hub-main { flex: 1; display: flex; flex-direction: column; background: #1a1a1a; padding: 20px; overflow-y: auto; }
            .mod-hub-stats-row { display: flex; align-items: center; gap: 6px; }
            .mod-hub-like-btn, .mod-hub-stat { background: #242424; border: 1px solid #383838; color: #ccc; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer; }
            .mod-hub-stat { color: #aaa; cursor: default; }
            .mod-hub-detail { display: flex; flex-direction: column; gap: 10px; width: 100%; }
            .mod-hub-detail-title { margin: 0; font-size: 18px; font-weight: 700; color: #fff; }
            .mod-hub-detail-filename { font-family: monospace; font-size: 11px; color: #666; }
            .mod-hub-detail-desc { font-size: 12px; color: #ccc; line-height: 1.5; background: #141414; border: 1px solid #282828; padding: 8px 10px; border-radius: 4px; }
            .mod-hub-snippet { background: #111; border: 1px solid #333; border-radius: 4px; padding: 8px 12px; max-height: 120px; overflow: auto; font-family: monospace; font-size: 11px; color: #ddd; white-space: pre; }
            .mod-hub-btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
            .mod-hub-unload-btn { padding: 10px 16px; background: #383838; border: 1px solid #555; color: #ccc; font-weight: 700; font-size: 12px; border-radius: 4px; cursor: pointer; }
            .mod-hub-edit-btn { padding: 10px 14px; background: #2e2e2e; border: 1px solid #444; color: #fff; font-weight: 700; font-size: 12px; border-radius: 4px; cursor: pointer; }
            .mod-hub-pin-toggle-btn { padding: 10px 14px; background: #333; border: 1px solid #555; color: #fff; font-weight: 700; font-size: 12px; border-radius: 4px; cursor: pointer; }

            .mod-hub-modal-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.7); z-index: 100005; display: flex; align-items: center; justify-content: center; }
            .mod-hub-modal-card { background: #1e1e1e; border: 1px solid #383838; border-radius: 4px; width: 440px; max-width: 90vw; padding: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.8); }
        `;
        document.head.appendChild(styleTag);
    }
})();
