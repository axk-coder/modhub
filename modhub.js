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
    let showActiveOnly = false;
    let activeSession = null;
    let currentUserEmail = null;
    let currentPlayFabId = null;
    let currentUsername = "";
    let isUserAdmin = false;
    let activeTab = "mods";
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
            if (mod && mod.filename === ADMIN_MOD_FILENAME) {
                return rawCode;
            }
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
        try { delete window.ModHubPlayFab; } catch (e) { window.ModHubPlayFab = null; }
        activeSession = null;
        currentUserEmail = null;
        currentPlayFabId = null;
        currentUsername = "";
        isUserAdmin = false;
    }

    async function loginWithCustomId(customId, username) {
        const targetId = (customId && customId.trim()) ? customId.trim() : getOrCreateHardwareId();
        const res = await fetch(PLAYFAB_LOGIN_CUSTOM_ID_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                TitleId: PLAYFAB_TITLE_ID,
                CustomId: targetId,
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
                       targetId;

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
            customId: targetId,
            username: dispName,
            loggedInAt: new Date().toISOString()
        };

        activeSession = session;
        window.ModHubPlayFab = { sessionTicket: session.sessionTicket, playFabId: session.playFabId };
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
        window.ModHubPlayFab = { sessionTicket: session.sessionTicket, playFabId: session.playFabId };
        currentUserEmail = email;
        currentPlayFabId = result.PlayFabId;
        currentUsername = username;
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
                <span class="mod-hub-brand">ACCOUNT SUSPENDED</span>
                <button class="mod-hub-close" id="modHubClose">&times;</button>
            </div>
            <div class="mod-hub-auth-container">
                <div class="mod-hub-auth-card" style="text-align: center;">
                    <div style="font-size: 16px; font-weight: bold; margin-bottom: 12px; color: #fff;">Access Suspended</div>
                    <div style="background: #111; border: 1px solid #282828; border-radius: 6px; padding: 12px; margin-bottom: 16px; text-align: left;">
                        <div style="font-size: 11px; color: #888;">Reason:</div>
                        <div style="font-size: 12px; color: #fff; font-weight: bold; margin-top: 2px;">${escapeHtml(reason)}</div>
                        <div style="font-size: 11px; color: #888; margin-top: 8px;">Duration:</div>
                        <div style="font-size: 12px; color: #fff; font-weight: bold; margin-top: 2px;">${escapeHtml(timeLeft)}</div>
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
        setTimeout(() => { if (hubWindow) { hubWindow.remove(); hubWindow = null; } }, 150);
    }

    function setupDragging(header, windowElement) {
        let dragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input")) return;
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
        version: "2.7.0",
        init() {
            injectStyles();
            createToolbarMenu();
            const saved = getSavedSession();
            if (saved && saved.sessionTicket) {
                activeSession = saved;
                window.ModHubPlayFab = { sessionTicket: saved.sessionTicket, playFabId: saved.playFabId };
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
        const result = await executeCloudScript("getModList", { hwid: activeSession ? activeSession.customId : getOrCreateHardwareId() });
        if (!result || !result.success) throw new Error(result?.error || "Failed to retrieve mod list.");
        isUserAdmin = (result.isAdmin === true);
        currentPlayFabId = result.playFabId || currentPlayFabId;
        if (result.username) currentUsername = result.username;
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
        return result.code;
    }

    function updateHeaderDisplay() {
        const userLabel = document.getElementById("mh-user-display");
        if (userLabel) {
            userLabel.innerHTML = `${escapeHtml(currentUsername || currentUserEmail || "Connected")} ${isUserAdmin ? '<b style="color:#ffffff;">(ADMIN)</b>' : ''}`;
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
            <div class="toolbar-category-dropdown" style="padding: 8px; min-width: 150px; background: #141414; border: 1px solid #2e2e2e; border-radius: 6px; box-shadow: 0 10px 24px rgba(0,0,0,0.6);">
                <button id="mh-open-btn" style="width:100%; text-align:center; padding: 7px 12px; background: #222; border: 1px solid #333; color:#fff; font-weight:600; font-size:12px; border-radius:4px; cursor:pointer;">Open Mod Hub</button>
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

        if (!activeSession || !activeSession.sessionTicket) {
            const hwid = getOrCreateHardwareId();
            loginWithCustomId(hwid).then(() => {
                if (hubWindow) renderMainAppScreen();
            }).catch(() => {
                if (hubWindow) renderAuthScreen("device");
            });
        } else {
            renderMainAppScreen();
        }
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
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #282828; padding-bottom:10px; margin-bottom:14px;">
                    <div style="font-size:14px; font-weight:700; color:#fff;">${escapeHtml(title)}</div>
                    <button class="mod-hub-close" id="mh-modal-close">&times;</button>
                </div>
                <div style="font-size:12px; color:#ccc; line-height:1.6; max-height:320px; overflow-y:auto;">
                    ${contentHtml}
                </div>
                <div style="margin-top:16px; text-align:right;">
                    <button class="mod-hub-add-btn" id="mh-modal-ok" style="padding:6px 18px;">Close</button>
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
            <p>Authentication utilizes hardware or custom identifiers solely to verify account continuity and moderation status. Session authentication tokens are managed within private runtime closures and blocked from mod script environments.</p>
            <p>Uploaded mods and descriptions are public within the community directory.</p>
        `);
    }

    function showTermsOfService() {
        renderModal("Terms of Service", `
            <p>1. By uploading mods to Mod Hub, you confirm the code does not contain malicious exploits, credential harvesters, or damaging routines.</p>
            <p>2. Mods loaded via Mod Hub run in an isolated execution container. Any attempt to bypass sandboxing or hijack authentication cookies will result in an immediate hardware suspension.</p>
            <p>3. All mods on Mod Hub are free and open for community play.</p>
        `);
    }

    function showCredits() {
        renderModal("Credits", `
            <p><b>Owner:</b> Axk</p>
            <p><b>Co-Owner:</b> _pykon20</p>
            <p><b>Game Creator:</b> Barr (Creator of Simbox)</p>
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
                <span class="mod-hub-brand">MOD HUB LOGIN</span>
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
                        <button type="submit" class="mod-hub-auth-submit-btn" id="mh-auth-submit">Connect</button>
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
            <div class="mod-hub-header" id="modHubHeader">
                <div style="display:flex; align-items:center; gap:12px;">
                    <span class="mod-hub-brand">MOD HUB</span>
                    <nav class="mod-hub-top-nav">
                        <button class="mod-hub-nav-tab ${activeTab === 'mods' ? 'active' : ''}" data-tab="mods">Browse Mods</button>
                        <button class="mod-hub-nav-tab ${activeTab === 'installed' ? 'active' : ''}" data-tab="installed">Installed (${loadedMods.size})</button>
                        <button class="mod-hub-nav-tab ${activeTab === 'upload' ? 'active' : ''}" data-tab="upload">+ Upload</button>
                        <button class="mod-hub-nav-tab ${activeTab === 'chat' ? 'active' : ''}" data-tab="chat">Chat</button>
                        <button class="mod-hub-nav-tab ${activeTab === 'about' ? 'active' : ''}" data-tab="about">About</button>
                    </nav>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="mod-hub-user-pill" id="mh-user-display">${escapeHtml(currentUsername || currentUserEmail || "Connected")} ${isUserAdmin ? '<b style="color:#ffffff;">(ADMIN)</b>' : ''}</span>
                    <a href="https://discord.gg/2nSBHCp2sd" target="_blank" rel="noopener noreferrer" class="mod-hub-discord-link" title="Discord">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:block;">
                            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.893.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                        </svg>
                    </a>
                    <button class="mod-hub-logout-btn" id="mh-logout-btn">Logout</button>
                    <button class="mod-hub-close" id="modHubClose">&times;</button>
                </div>
            </div>
            <div class="mod-hub-body" id="mh-body-content"></div>
        `;

        setupDragging(document.getElementById("modHubHeader"), hubWindow);
        document.getElementById("modHubClose").onclick = closeHubWindow;
        document.getElementById("mh-logout-btn").onclick = () => { clearSession(); renderAuthScreen("device"); };

        document.querySelectorAll(".mod-hub-nav-tab").forEach(tabBtn => {
            tabBtn.onclick = () => {
                const tab = tabBtn.getAttribute("data-tab");
                switchTab(tab);
            };
        });

        switchTab(activeTab);
    }

    function switchTab(tab) {
        activeTab = tab;
        document.querySelectorAll(".mod-hub-nav-tab").forEach(b => {
            b.classList.toggle("active", b.getAttribute("data-tab") === tab);
        });

        const container = document.getElementById("mh-body-content");
        if (!container) return;

        if (tab === "mods") {
            renderModsView(container);
        } else if (tab === "installed") {
            renderInstalledView(container);
        } else if (tab === "upload") {
            renderUploadView(container);
        } else if (tab === "chat") {
            renderChatView(container);
        } else if (tab === "about") {
            renderAboutView(container);
        }
    }

    function renderModsView(container) {
        container.innerHTML = `
            <div class="mod-hub-sidebar" id="mh-left-sidebar">
                <div class="mod-hub-sidebar-top">
                    <button class="mod-hub-refresh-btn" id="mh-refresh-btn">Refresh</button>
                    <button class="mod-hub-filter-btn ${showActiveOnly ? 'active' : ''}" id="mh-filter-btn">Active Only</button>
                </div>
                <div class="mod-hub-search-box">
                    <input type="text" class="mod-hub-search-input" id="mh-search-input" placeholder="Search mods, authors, tags..." value="${escapeHtml(searchQuery)}">
                    <button class="mod-hub-search-btn" id="mh-search-btn">Search</button>
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
            <div class="mod-hub-main" id="mh-main-panel"><div class="mod-hub-empty-state">Select a mod to inspect code.</div></div>
        `;

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

    function renderInstalledView(container) {
        const loadedArr = Array.from(loadedMods.entries());
        container.innerHTML = `
            <div class="mod-hub-tab-page" style="padding: 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div>
                        <h2 class="mod-hub-tab-header" style="margin:0;">Installed Sandboxed Mods</h2>
                        <div style="font-size:12px; color:#888; margin-top:2px;">${loadedMods.size} active mod instance(s) running.</div>
                    </div>
                    ${loadedArr.length > 0 ? `<button class="mod-hub-unload-btn" id="mh-unload-all-btn">Unload All</button>` : ''}
                </div>
                ${loadedArr.length === 0 ? `
                    <div class="mod-hub-card" style="text-align:center; padding:36px 20px; color:#777;">
                        <div style="font-size:13px; margin-bottom:8px;">No mods currently running in sandbox container.</div>
                        <button class="mod-hub-add-btn" id="mh-browse-mods-btn">Browse Mods</button>
                    </div>
                ` : `
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        ${loadedArr.map(([fn, id]) => {
                            const modObj = mods.find(m => m.filename === fn);
                            const displayName = modObj ? (modObj.name || fn) : fn;
                            return `
                                <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                                    <div>
                                        <div style="font-size:13px; font-weight:600; color:#fff;">${escapeHtml(displayName)}</div>
                                        <div style="font-family:monospace; font-size:11px; color:#777; margin-top:2px;">${escapeHtml(fn)}</div>
                                    </div>
                                    <button class="mod-hub-unload-btn mh-unload-single-btn" data-fn="${escapeHtml(fn)}">Unload</button>
                                </div>
                            `;
                        }).join("")}
                    </div>
                `}
            </div>
        `;

        if (document.getElementById("mh-browse-mods-btn")) {
            document.getElementById("mh-browse-mods-btn").onclick = () => switchTab("mods");
        }
        if (document.getElementById("mh-unload-all-btn")) {
            document.getElementById("mh-unload-all-btn").onclick = () => {
                Array.from(loadedMods.keys()).forEach(fn => {
                    const modObj = mods.find(m => m.filename === fn) || { filename: fn };
                    unloadModFromGame(modObj);
                });
                renderInstalledView(container);
            };
        }
        container.querySelectorAll(".mh-unload-single-btn").forEach(btn => {
            btn.onclick = () => {
                const fn = btn.getAttribute("data-fn");
                const modObj = mods.find(m => m.filename === fn) || { filename: fn };
                unloadModFromGame(modObj);
                renderInstalledView(container);
            };
        });
    }

    function renderUploadView(container) {
        container.innerHTML = `
            <div class="mod-hub-tab-page" style="padding: 24px; overflow-y:auto;">
                <div class="mod-hub-upload-card" style="max-width:700px; margin:0 auto;">
                    <h2 style="font-size:18px; margin:0 0 14px 0; color:#fff;">Upload a Mod</h2>
                    <form id="mh-upload-form" style="display:flex; flex-direction:column; gap:12px;">
                        <div class="mod-hub-input-group"><label>Mod Name</label><input type="text" id="mh-up-name" required placeholder="e.g. Laser Particle"></div>
                        <div class="mod-hub-input-group"><label>Filename</label><input type="text" id="mh-up-filename" required placeholder="e.g. laser.js"></div>
                        <div class="mod-hub-input-group"><label>Version</label><input type="text" id="mh-up-version" value="1.0.0" required></div>
                        <div class="mod-hub-input-group"><label>Category Tags</label>${renderTagSelector("mh-upload-tags-box")}</div>
                        <div class="mod-hub-input-group"><label>Description</label><textarea id="mh-up-desc" rows="2" required placeholder="What does this mod do?"></textarea></div>
                        <div class="mod-hub-input-group"><label>JavaScript Code</label><textarea id="mh-up-code" rows="8" required style="font-family:monospace; font-size:11px;" placeholder="// Simbox Modding API code..."></textarea></div>
                        <div id="mh-upload-status" class="mod-hub-auth-status"></div>
                        <div style="display:flex; gap:8px;">
                            <button type="submit" class="mod-hub-auth-submit-btn" id="mh-upload-submit" style="flex:1;">Publish Mod</button>
                            <button type="button" class="mod-hub-logout-btn" id="mh-upload-cancel" style="padding:9px 16px;">Cancel</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        setupTagSelectorEvents("mh-upload-tags-box");
        document.getElementById("mh-upload-cancel").onclick = () => switchTab("mods");
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
                setTimeout(() => switchTab("mods"), 1000);
            } catch (err) {
                status.textContent = err.message;
                status.className = "mod-hub-auth-status error";
                btn.disabled = false;
            }
        };
    }

    function renderChatView(container) {
        container.innerHTML = `
            <div class="mod-hub-tab-page" style="height:100%; display:flex; flex-direction:column; padding:20px;">
                <h2 class="mod-hub-tab-header">Community Live Chat</h2>
                <div class="mod-hub-chat-box" id="mh-chat-history">
                    ${chatMessages.map(m => `<div class="mod-hub-chat-msg"><span class="mod-hub-chat-user">${escapeHtml(m.sender)}:</span><span class="mod-hub-chat-text">${escapeHtml(m.text)}</span><span class="mod-hub-chat-time">${m.time}</span></div>`).join("")}
                </div>
                <form id="mh-chat-form" style="display:flex; gap:8px; margin-top:10px;">
                    <input type="text" id="mh-chat-input" placeholder="Type a message..." required style="flex:1; background:#0f0f0f; border:1px solid #282828; border-radius:6px; padding:9px 12px; color:#fff; font-size:12px; outline:none;">
                    <button type="submit" class="mod-hub-add-btn" style="padding:9px 18px;">Send</button>
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
            renderChatView(container);
        };
    }

    function renderAboutView(container) {
        container.innerHTML = `
            <div class="mod-hub-tab-page" style="padding:24px; overflow-y:auto;">
                <div style="max-width:700px; margin:0 auto; display:flex; flex-direction:column; gap:14px;">
                    <div class="mod-hub-card">
                        <div style="font-size:14px; font-weight:700; color:#fff; margin-bottom:8px;">Credits</div>
                        <div style="font-size:12px; color:#ccc; line-height:1.6;">
                            <b>Owner:</b> Axk<br>
                            <b>Co-Owner:</b> _pykon20<br>
                            <b>Game Creator:</b> Barr (Creator of Simbox)<br>
                            <b>Infrastructure:</b> PlayFab Backend Services<br>
                            <b>Community:</b> Custom Element Developers & Mod Authors
                        </div>
                    </div>
                    <div class="mod-hub-card">
                        <div style="font-size:14px; font-weight:700; color:#fff; margin-bottom:8px;">Terms of Service</div>
                        <div style="font-size:12px; color:#ccc; line-height:1.6;">
                            All mods in Mod Hub are free and open for community play. Uploaded code must comply with safety standards. Harvesters, credential stealers, and exploitative routines are strictly prohibited and result in permanent hardware bans.
                        </div>
                    </div>
                    <div class="mod-hub-card">
                        <div style="font-size:14px; font-weight:700; color:#fff; margin-bottom:8px;">Privacy Policy</div>
                        <div style="font-size:12px; color:#ccc; line-height:1.6;">
                            Hardware and custom identifiers are used solely for account authentication and mod verification. Cookies and credentials are protected from sandboxed mod access.
                        </div>
                    </div>
                </div>
            </div>
        `;
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
                    <button type="button" class="mod-hub-tag-pick-btn ${selected.has(cat) ? 'selected' : ''}" data-cat="${cat}" style="background:${selected.has(cat) ? '#2d2d2d' : '#1c1c1c'}; border:1px solid ${selected.has(cat) ? '#666' : '#2c2c2c'}; color:${selected.has(cat) ? '#fff' : '#888'}; border-radius:4px; padding:4px 10px; font-size:10px; font-weight:600; cursor:pointer;">
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
                btn.style.background = isSel ? "#2d2d2d" : "#1c1c1c";
                btn.style.borderColor = isSel ? "#666" : "#2c2c2c";
                btn.style.color = isSel ? "#fff" : "#888";
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

    function renderEditScreen(mod) {
        const main = document.getElementById("mh-main-panel");
        if (!main) return;
        const currentTags = getCategoryList(mod.category);
        main.innerHTML = `
            <div class="mod-hub-upload-card">
                <h2 style="font-size:18px; margin:0 0 14px 0; color:#fff;">Edit Mod: ${escapeHtml(mod.name)}</h2>
                <form id="mh-edit-form" style="display:flex; flex-direction:column; gap:12px;">
                    <div class="mod-hub-input-group"><label>Mod Name</label><input type="text" id="mh-edit-name" value="${escapeHtml(mod.name || '')}" required></div>
                    <div class="mod-hub-input-group"><label>Version</label><input type="text" id="mh-edit-version" value="${escapeHtml(mod.version || '1.0.0')}" required></div>
                    <div class="mod-hub-input-group"><label>Category Tags</label>${renderTagSelector("mh-edit-tags-box", currentTags)}</div>
                    <div class="mod-hub-input-group"><label>Description</label><textarea id="mh-edit-desc" rows="2" required>${escapeHtml(mod.Description || "")}</textarea></div>
                    <div class="mod-hub-input-group"><label>Update Code (Optional)</label><textarea id="mh-edit-code" rows="8" style="font-family:monospace; font-size:11px;" placeholder="Leave empty to keep existing code..."></textarea></div>
                    <div id="mh-edit-status" class="mod-hub-auth-status"></div>
                    <div style="display:flex; gap:8px;">
                        <button type="submit" class="mod-hub-auth-submit-btn" id="mh-edit-submit" style="flex:1;">Save Changes</button>
                        <button type="button" class="mod-hub-logout-btn" id="mh-edit-cancel" style="padding:9px 16px;">Cancel</button>
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
            const isInstalled = loadedMods.has(mod.filename);

            item.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:6px; width:100%; overflow:hidden;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
                        <div class="mod-hub-item-name" title="${escapeHtml(mod.name || mod.filename)}">
                            ${mod.pinned ? '<span class="mod-hub-pinned-badge">PINNED</span> ' : ''}${escapeHtml(mod.name || mod.filename)}
                        </div>
                        <button class="mod-hub-card-action-btn ${isInstalled ? 'installed' : ''}" data-fn="${escapeHtml(mod.filename)}">
                            ${isInstalled ? 'Unload' : 'Add'}
                        </button>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                        <div style="display:flex; flex-wrap:wrap; gap:4px;">
                            ${cats.length > 0 ? cats.map(c => `<span class="mod-hub-cat-badge">${c.toUpperCase()}</span>`).join("") : '<span></span>'}
                        </div>
                        <div class="mod-hub-item-stats">
                            <span>Likes: ${likes}</span>
                            <span>Views: ${views}</span>
                        </div>
                    </div>
                </div>
            `;
            item.onclick = (e) => {
                if (e.target.closest(".mod-hub-card-action-btn")) {
                    e.stopPropagation();
                    if (isInstalled) unloadModFromGame(mod);
                    else addModToGame(mod);
                    return;
                }
                selectMod(mod);
            };
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
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                    <div>
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">
                            <h2 class="mod-hub-detail-title">${escapeHtml(mod.name)}</h2>
                            ${cats.map(c => `<span class="mod-hub-cat-badge">${c.toUpperCase()}</span>`).join("")}
                        </div>
                        <div class="mod-hub-detail-filename">by <span style="color:#aaa;">${escapeHtml(mod.author)}</span> &bull; ${escapeHtml(mod.filename)}</div>
                    </div>
                    <div class="mod-hub-stats-row">
                        <button class="mod-hub-like-btn" id="mh-like-btn">Like (<span id="mh-like-count">${mod.likes || 0}</span>)</button>
                        <span class="mod-hub-stat" id="mh-view-count">Views: ${mod.views || 0}</span>
                    </div>
                </div>
                <div class="mod-hub-detail-desc">${escapeHtml(mod.Description || "")}</div>
                <div class="mod-hub-snippet-label">Code Preview</div>
                <pre class="mod-hub-snippet" id="mh-snippet"><code>Loading preview...</code></pre>
                <div class="mod-hub-detail-status" id="mh-status"></div>
                <div class="mod-hub-btn-row">
                    <button class="mod-hub-add-btn" id="mh-add-btn" ${alreadyAdded ? "disabled" : ""}>${alreadyAdded ? "In Game" : "Add to Game"}</button>
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
                const countEl = document.getElementById("mh-like-count");
                if (countEl) countEl.textContent = res.likes;
            }
        } catch (e) {}
    }

    async function loadSnippet(mod) {
        const snippetEl = document.getElementById("mh-snippet");
        if (!snippetEl) return;
        try {
            let code = codeCache[mod.filename];
            if (!code) {
                code = await fetchModCode(mod.filename);
                codeCache[mod.filename] = code;
            }
            if (!selectedMod || selectedMod.filename !== mod.filename) return;
            const { snippet, truncated } = buildSnippet(code);
            snippetEl.innerHTML = `<code>${escapeHtml(snippet)}${truncated ? "\n…" : ""}</code>`;
        } catch (err) { snippetEl.innerHTML = `<code>Preview unavailable.</code>`; }
    }

    async function addModToGame(mod) {
        if (typeof ModManager === "undefined" || !ModManager) return;
        try {
            let code = codeCache[mod.filename];
            if (!code) {
                code = await fetchModCode(mod.filename);
                codeCache[mod.filename] = code;
            }
            const sandboxedCode = ModSandboxManager.wrapCode(code, mod);
            const reg = ModManager.installBuiltInMod(mod.name || mod.filename, mod.version || "1.0.0", sandboxedCode);
            ModManager.enableMod(reg.id);
            loadedMods.set(mod.filename, reg.id);
            updateNavCounts();
            if (activeTab === "mods") selectMod(mod);
            else if (activeTab === "installed") renderInstalledView(document.getElementById("mh-body-content"));
        } catch (err) { alert(err.message); }
    }

    function unloadModFromGame(mod) {
        const id = loadedMods.get(mod.filename);
        if (id && typeof ModManager !== "undefined") {
            ModManager.disableMod(id);
            loadedMods.delete(mod.filename);
            updateNavCounts();
            if (activeTab === "mods") selectMod(mod);
            else if (activeTab === "installed") renderInstalledView(document.getElementById("mh-body-content"));
        }
    }

    function updateNavCounts() {
        const installedTabBtn = document.querySelector('.mod-hub-nav-tab[data-tab="installed"]');
        if (installedTabBtn) {
            installedTabBtn.textContent = `Installed (${loadedMods.size})`;
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
            .mod-hub-window { position: fixed; top: 10vh; left: 10vw; width: 920px; height: 600px; min-width: 720px; min-height: 480px; background: #141414; border: 1px solid #2e2e2e; border-radius: 8px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.05); color: #eee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; z-index: 100000; display: flex; flex-direction: column; overflow: visible; opacity: 0; transform: scale(0.98); transition: opacity 0.15s ease, transform 0.15s ease; }
            .mod-hub-window.show { opacity: 1; transform: scale(1); }
            .mod-hub-window *::-webkit-scrollbar { width: 6px; height: 6px; }
            .mod-hub-window *::-webkit-scrollbar-track { background: transparent; }
            .mod-hub-window *::-webkit-scrollbar-thumb { background: #2c2c2c; border-radius: 3px; }
            .mod-hub-window *::-webkit-scrollbar-thumb:hover { background: #444; }

            .mod-hub-header { background: #191919; padding: 8px 16px; border-bottom: 1px solid #282828; cursor: move; display: flex; justify-content: space-between; align-items: center; border-top-left-radius: 8px; border-top-right-radius: 8px; user-select: none; }
            .mod-hub-brand { font-size: 13px; font-weight: 700; letter-spacing: 0.5px; color: #fff; }
            .mod-hub-top-nav { display: flex; gap: 4px; }
            .mod-hub-nav-tab { background: transparent; border: 1px solid transparent; border-radius: 5px; color: #888; font-size: 11px; font-weight: 600; padding: 5px 12px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-nav-tab:hover { background: #222; color: #ccc; }
            .mod-hub-nav-tab.active { background: #272727; border-color: #383838; color: #fff; }

            .mod-hub-user-pill { font-size: 11px; color: #aaa; background: #222; border: 1px solid #303030; padding: 3px 8px; border-radius: 4px; font-weight: 500; }
            .mod-hub-discord-link { display: inline-flex; align-items: center; justify-content: center; color: #888; background: #222; border: 1px solid #303030; border-radius: 4px; padding: 4px 6px; text-decoration: none; transition: all 0.12s ease; }
            .mod-hub-discord-link:hover { color: #fff; background: #2a2a2a; border-color: #444; }
            .mod-hub-close { background: #222; border: 1px solid #303030; color: #888; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; font-size: 15px; font-weight: bold; cursor: pointer; line-height: 1; transition: all 0.12s ease; }
            .mod-hub-close:hover { background: #2c2c2c; border-color: #555; color: #fff; }
            .mod-hub-logout-btn { background: #1e1e1e; border: 1px solid #303030; color: #999; border-radius: 4px; font-size: 11px; font-weight: 600; padding: 5px 10px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-logout-btn:hover { background: #282828; color: #ddd; border-color: #444; }

            .mod-hub-body { display: flex; flex: 1; overflow: hidden; position: relative; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px; }
            .mod-hub-sidebar { width: 48%; min-width: 320px; border-right: 1px solid #262626; display: flex; flex-direction: column; background: #131313; }
            .mod-hub-sidebar-top { padding: 10px 12px; border-bottom: 1px solid #202020; display: flex; gap: 8px; }
            .mod-hub-refresh-btn, .mod-hub-filter-btn { padding: 5px 12px; background: #1c1c1c; border: 1px solid #2e2e2e; color: #bbb; border-radius: 6px; font-weight: 500; font-size: 11px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-refresh-btn:hover, .mod-hub-filter-btn:hover { background: #252525; border-color: #3e3e3e; color: #fff; }
            .mod-hub-filter-btn.active { background: #2e2e2e; border-color: #555; color: #fff; }

            .mod-hub-search-box { padding: 8px 12px; display: flex; gap: 8px; background: #151515; border-bottom: 1px solid #202020; }
            .mod-hub-search-input { flex: 1; background: #0e0e0e; border: 1px solid #282828; border-radius: 6px; padding: 6px 10px; color: #eee; font-size: 12px; outline: none; transition: border-color 0.12s ease; }
            .mod-hub-search-input:focus { border-color: #555; }
            .mod-hub-search-btn { background: #1c1c1c; border: 1px solid #2e2e2e; color: #bbb; border-radius: 6px; padding: 6px 12px; font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-search-btn:hover { background: #252525; border-color: #3e3e3e; color: #fff; }

            .mod-hub-cat-pills { padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px; background: #131313; border-bottom: 1px solid #202020; }
            .mod-hub-cat-pill { background: #1b1b1b; border: 1px solid #282828; border-radius: 4px; color: #888; font-size: 10px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; padding: 3px 8px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-cat-pill:hover { background: #242424; border-color: #383838; color: #eee; }
            .mod-hub-cat-pill.active { background: #2d2d2d; border-color: #555; color: #fff; }

            .mod-hub-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
            .mod-hub-item { padding: 10px 12px; background: #181818; border: 1px solid #242424; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; flex-direction: column; gap: 6px; transition: all 0.12s ease; }
            .mod-hub-item:hover { background: #1f1f1f; border-color: #383838; }
            .mod-hub-item.active { background: #242424; border-color: #555; }
            .mod-hub-item-name { font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
            .mod-hub-item-stats { display: flex; gap: 8px; font-size: 11px; color: #777; }
            .mod-hub-pinned-badge { font-size: 9px; font-weight: 700; background: #2a2a2a; border: 1px solid #444; color: #fff; padding: 1px 5px; border-radius: 3px; letter-spacing: 0.4px; }
            .mod-hub-cat-badge { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; letter-spacing: 0.4px; background: #222; color: #999; border: 1px solid #333; text-transform: uppercase; }
            .mod-hub-card-action-btn { background: #222; border: 1px solid #333; color: #ccc; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 4px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-card-action-btn:hover { background: #2c2c2c; color: #fff; border-color: #555; }
            .mod-hub-card-action-btn.installed { background: #333; border-color: #555; color: #ff9999; }

            .mod-hub-main { flex: 1; display: flex; flex-direction: column; background: #151515; padding: 22px; overflow-y: auto; }
            .mod-hub-stats-row { display: flex; align-items: center; gap: 6px; }
            .mod-hub-like-btn, .mod-hub-stat { background: #1f1f1f; border: 1px solid #303030; color: #ccc; border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-like-btn:hover { background: #282828; color: #fff; }
            .mod-hub-stat { color: #888; cursor: default; }

            .mod-hub-detail { display: flex; flex-direction: column; gap: 14px; width: 100%; }
            .mod-hub-detail-title { margin: 0; font-size: 20px; font-weight: 700; color: #fff; letter-spacing: -0.01em; }
            .mod-hub-detail-filename { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: #777; margin-top: 3px; }
            .mod-hub-detail-desc { font-size: 13px; color: #ccc; line-height: 1.6; background: #111; border: 1px solid #222; padding: 12px 14px; border-radius: 6px; white-space: pre-wrap; }
            .mod-hub-snippet-label { font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
            .mod-hub-snippet { background: #0e0e0e; border: 1px solid #222; border-radius: 6px; padding: 10px 14px; max-height: 130px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; color: #bbb; white-space: pre; line-height: 1.45; }
            .mod-hub-btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
            .mod-hub-add-btn { padding: 8px 18px; background: #f0f0f0; border: 1px solid #fff; color: #111; font-weight: 600; font-size: 12px; border-radius: 6px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-add-btn:hover { background: #ffffff; box-shadow: 0 2px 8px rgba(255,255,255,0.12); }
            .mod-hub-add-btn:disabled { background: #242424; border-color: #333; color: #666; cursor: not-allowed; box-shadow: none; }
            .mod-hub-unload-btn, .mod-hub-edit-btn, .mod-hub-pin-toggle-btn { padding: 8px 16px; background: #202020; border: 1px solid #333; color: #ccc; font-weight: 600; font-size: 12px; border-radius: 6px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-unload-btn:hover, .mod-hub-edit-btn:hover, .mod-hub-pin-toggle-btn:hover { background: #2a2a2a; border-color: #444; color: #fff; }

            .mod-hub-tab-page { display: flex; flex-direction: column; width: 100%; height: 100%; box-sizing: border-box; }
            .mod-hub-tab-header { font-size: 18px; font-weight: 700; color: #fff; margin: 0 0 12px 0; }
            .mod-hub-card { background: #161616; border: 1px solid #242424; border-radius: 6px; padding: 14px 16px; }
            .mod-hub-chat-box { flex: 1; min-height: 220px; max-height: 380px; background: #0f0f0f; border: 1px solid #242424; border-radius: 6px; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
            .mod-hub-chat-msg { display: flex; gap: 8px; font-size: 12px; }
            .mod-hub-chat-user { font-weight: 600; color: #fff; }
            .mod-hub-chat-text { color: #ccc; word-break: break-word; }
            .mod-hub-chat-time { font-size: 9px; color: #666; margin-left: auto; }

            .mod-hub-auth-container { flex: 1; display: flex; align-items: center; justify-content: center; background: #111; padding: 24px; }
            .mod-hub-auth-card { background: #171717; border: 1px solid #282828; border-radius: 8px; width: 350px; padding: 24px; box-shadow: 0 12px 30px rgba(0,0,0,0.6); }
            .mod-hub-auth-tabs { display: flex; gap: 6px; margin-bottom: 20px; background: #101010; padding: 4px; border-radius: 6px; border: 1px solid #222; }
            .mod-hub-tab-btn { flex: 1; background: transparent; border: none; color: #777; font-size: 11px; font-weight: 600; padding: 6px 0; cursor: pointer; border-radius: 4px; transition: all 0.12s ease; }
            .mod-hub-tab-btn:hover { color: #bbb; }
            .mod-hub-tab-btn.active { background: #222; color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
            .mod-hub-auth-form, .mod-hub-input-group { display: flex; flex-direction: column; gap: 6px; }
            .mod-hub-input-group label { font-size: 11px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
            .mod-hub-input-group input, .mod-hub-input-group textarea, .mod-hub-input-group select { background: #0f0f0f; border: 1px solid #282828; border-radius: 6px; padding: 8px 10px; color: #fff; font-size: 12px; outline: none; transition: border-color 0.12s ease; }
            .mod-hub-input-group input:focus, .mod-hub-input-group textarea:focus { border-color: #555; }
            .mod-hub-auth-status { font-size: 11px; min-height: 14px; }
            .mod-hub-auth-status.error { color: #ff8888; }
            .mod-hub-auth-status.success { color: #ccc; }
            .mod-hub-auth-submit-btn { background: #f0f0f0; border: 1px solid #fff; color: #111; border-radius: 6px; padding: 9px; font-weight: 600; font-size: 12px; cursor: pointer; transition: all 0.12s ease; }
            .mod-hub-auth-submit-btn:hover { background: #fff; }
            .mod-hub-auth-footer-links { margin-top: 18px; text-align: center; font-size: 11px; color: #555; }
            .mod-hub-auth-footer-links a { color: #777; text-decoration: none; }
            .mod-hub-auth-footer-links a:hover { color: #bbb; text-decoration: underline; }

            .mod-hub-upload-card { background: #161616; border: 1px solid #242424; border-radius: 8px; padding: 20px; }
            .mod-hub-loading, .mod-hub-empty-state { padding: 28px 16px; text-align: center; color: #666; font-size: 12px; }

            .mod-hub-modal-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.75); z-index: 100005; display: flex; align-items: center; justify-content: center; }
            .mod-hub-modal-card { background: #171717; border: 1px solid #2e2e2e; border-radius: 8px; width: 440px; max-width: 90vw; padding: 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.85); }
        `;
        document.head.appendChild(styleTag);
    }
})();
