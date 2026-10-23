// Mod Hub for Simbox 2.0 (PlayFab Auth, MH Currency, Full 11-Game Casino Suite, Drawer Navigation)
(function() {
    const PLAYFAB_TITLE_ID = "1A4B9A";
    const PLAYFAB_LOGIN_EMAIL_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/LoginWithEmailAddress`;
    const PLAYFAB_REGISTER_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/RegisterPlayFabUser`;
    const PLAYFAB_EXECUTE_CS_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/ExecuteCloudScript`;
    const PLAYFAB_INVENTORY_URL = `https://${PLAYFAB_TITLE_ID}.playfabapi.com/Client/GetUserInventory`;
    const PLAYFAB_ACCOUNT_BANNED_CODE = 1002;
    const BAN_CHECK_INTERVAL_MS = 2000;
    const AUTH_SESSION_KEY = "modhub_playfab_session";
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
        { sender: "System", text: "Welcome to Mod Hub Global Chat!", time: "Now" }
    ];

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
        window.ModHubPlayFab = null;
        currentUserEmail = null;
        currentPlayFabId = null;
        currentUsername = "";
        currentBalance = 0;
        isUserAdmin = false;
        purchasedMods.clear();
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
        const username = result.InfoResultPayload?.AccountInfo?.Username || "";
        const session = { titleId: PLAYFAB_TITLE_ID, sessionTicket: result.SessionTicket, playFabId: result.PlayFabId, email: email, username: username, loggedInAt: new Date().toISOString() };
        window.ModHubPlayFab = session;
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
        window.ModHubPlayFab = session;
        currentUserEmail = email;
        currentPlayFabId = result.PlayFabId;
        currentUsername = session.username;
        saveSession(session);
        startBanPolling();
        return session;
    }

    async function executeCloudScript(functionName, functionParameter = {}) {
        if (!window.ModHubPlayFab || !window.ModHubPlayFab.sessionTicket) throw new Error("Not logged in.");
        const res = await fetch(PLAYFAB_EXECUTE_CS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Authorization": window.ModHubPlayFab.sessionTicket },
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
            <div class="mod-hub-ban-title">You have been banned</div>
            <div class="mod-hub-ban-line">reason:${escapeHtml(reason)}</div>
            <div class="mod-hub-ban-line">time:${escapeHtml(timeLeft)}</div>
            <button class="mod-hub-ban-disable-btn" id="mh-ban-disable-btn">Disable Mod Hub and all Mods</button>
        `;
        document.getElementById("mh-ban-disable-btn").onclick = () => {
            try { Array.from(ModManager.mods.values()).forEach(m => { if (m.enabled) ModManager.disableMod(m.id); }); } catch(e){}
        };
    }

    function startBanPolling() {
        if (banCheckTimer) return;
        banCheckTimer = setInterval(async () => {
            if (banScreenShown || !window.ModHubPlayFab?.sessionTicket) return;
            try {
                const res = await fetch(PLAYFAB_INVENTORY_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Authorization": window.ModHubPlayFab.sessionTicket },
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
        version: "2.1.0",
        init() {
            injectStyles();
            createToolbarMenu();
            const saved = getSavedSession();
            if (saved && saved.sessionTicket) {
                window.ModHubPlayFab = saved;
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
            if (viewEl) viewEl.textContent = `👁️ ${result.views}`;
        }
        return { code: result.code, locked: !!result.locked };
    }

    function updateHeaderDisplay() {
        const balEl = document.getElementById("mh-balance-display");
        if (balEl) balEl.textContent = `🪙 ${currentBalance} MH`;
        const userLabel = document.getElementById("mh-user-display");
        if (userLabel) {
            userLabel.innerHTML = `${escapeHtml(currentUsername || currentUserEmail || "Logged In")} ${isUserAdmin ? '<b style="color:#ef4444;">(ADMIN)</b>' : ''}`;
        }
    }

    function createToolbarMenu() {
        const toolbar = document.querySelector(".toolbar");
        if (!toolbar) {
            if (toolbarRetries < 100) {
                toolbarRetries++;
                setTimeout(createToolbarMenu, 100);
            } else {
                console.warn("Mod Hub: .toolbar element not found after 10 seconds.");
            }
            return;
        }
        toolbarMenu = document.createElement("details");
        toolbarMenu.className = "toolbar-category";
        toolbarMenu.id = "mod-hub-menu";
        toolbarMenu.innerHTML = `
            <summary>Mod Hub</summary>
            <div class="toolbar-category-dropdown" style="padding: 10px; min-width: 160px; background: #1a1a1a; border: 2px solid #333; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.6);">
                <button id="mh-open-btn" style="width:100%; text-align:center; padding: 6px 12px; background: #2c2c2c; border: 1px solid #444; color:#fff; font-weight:bold; border-radius:6px; cursor:pointer;">Open Mod Hub</button>
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
        if (!window.ModHubPlayFab || !window.ModHubPlayFab.sessionTicket) renderAuthScreen();
        else renderMainAppScreen();
        requestAnimationFrame(() => hubWindow.classList.add("show"));
    }

    function renderAuthScreen(mode = "login") {
        if (!hubWindow) return;
        hubWindow.innerHTML = `
            <div class="mod-hub-header" id="modHubHeader">
                <div><span style="font-size: 14px; font-weight: bold; color: #fff;">Mod Hub &mdash; Authentication</span></div>
                <button class="mod-hub-close" id="modHubClose">&times;</button>
            </div>
            <div class="mod-hub-auth-container">
                <div class="mod-hub-auth-card">
                    <div class="mod-hub-auth-tabs">
                        <button class="mod-hub-tab-btn ${mode === 'login' ? 'active' : ''}" id="mh-tab-login">Login</button>
                        <button class="mod-hub-tab-btn ${mode === 'register' ? 'active' : ''}" id="mh-tab-register">Sign Up</button>
                    </div>
                    <form class="mod-hub-auth-form" id="mh-auth-form">
                        ${mode === 'register' ? `<div class="mod-hub-input-group"><label>Username</label><input type="text" id="mh-auth-username" required></div>` : ''}
                        <div class="mod-hub-input-group"><label>Email Address</label><input type="email" id="mh-auth-email" required></div>
                        <div class="mod-hub-input-group"><label>Password</label><input type="password" id="mh-auth-password" required></div>
                        <div class="mod-hub-auth-status" id="mh-auth-status"></div>
                        <button type="submit" class="mod-hub-auth-submit-btn" id="mh-auth-submit">${mode === 'login' ? 'Log In' : 'Create Account'}</button>
                    </form>
                </div>
            </div>
        `;
        setupDragging(document.getElementById("modHubHeader"), hubWindow);
        document.getElementById("modHubClose").onclick = closeHubWindow;
        document.getElementById("mh-tab-login").onclick = () => renderAuthScreen("login");
        document.getElementById("mh-tab-register").onclick = () => renderAuthScreen("register");

        document.getElementById("mh-auth-form").onsubmit = async (e) => {
            e.preventDefault();
            const email = document.getElementById("mh-auth-email").value.trim();
            const password = document.getElementById("mh-auth-password").value;
            const status = document.getElementById("mh-auth-status");
            const btn = document.getElementById("mh-auth-submit");
            btn.disabled = true;
            try {
                if (mode === "login") await loginWithEmail(email, password);
                else await registerWithEmail(email, password, document.getElementById("mh-auth-username").value.trim());
                renderMainAppScreen();
            } catch (err) {
                status.textContent = err.message || "Auth failed.";
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
                    <span style="font-size: 9px; color: #888;" id="mh-user-display">${escapeHtml(currentUsername || currentUserEmail)} ${isUserAdmin ? '<b style="color:#ef4444;">(ADMIN)</b>' : ''}</span>
                    <a href="https://discord.gg/2nSBHCp2sd" target="_blank" rel="noopener noreferrer" class="mod-hub-discord-link" title="Join our Discord">
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
                        <button class="mod-hub-refresh-btn" id="mh-refresh-btn" title="Refresh Mod List">&#8635; Refresh</button>
                        <button class="mod-hub-filter-btn ${showActiveOnly ? 'active' : ''}" id="mh-filter-btn" title="Toggle Active Mods Only">&#9889; Active</button>
                    </div>
                    <div class="mod-hub-search-box">
                        <input type="text" class="mod-hub-search-input" id="mh-search-input" placeholder="Search mods, authors, tags..." value="${escapeHtml(searchQuery)}">
                        <button class="mod-hub-search-btn" id="mh-search-btn" title="Search">🔍</button>
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
                    <button class="mod-hub-side-btn ${activeView === 'friends' ? 'active' : ''}" id="mh-tab-friends">Friends</button>
                    <button class="mod-hub-side-btn ${activeView === 'inventory' ? 'active' : ''}" id="mh-tab-inventory">Inventory</button>
                    <button class="mod-hub-side-btn ${activeView === 'achievements' ? 'active' : ''}" id="mh-tab-achievements">Achievements</button>
                    <button class="mod-hub-side-btn ${activeView === 'settings' ? 'active' : ''}" id="mh-tab-settings">Settings</button>
                </div>
            </div>
        `;
        setupDragging(document.getElementById("modHubHeader"), hubWindow);
        document.getElementById("modHubClose").onclick = closeHubWindow;
        document.getElementById("mh-logout-btn").onclick = () => { clearSession(); renderAuthScreen("login"); };

        const tab = document.getElementById("mh-sidebar-tab");
        const sidebar = document.getElementById("mh-right-sidebar");
        tab.onclick = () => { isSidebarOpen = !isSidebarOpen; tab.classList.toggle("open", isSidebarOpen); sidebar.classList.toggle("open", isSidebarOpen); };

        ["mods","chat","friends","inventory","achievements","settings"].forEach(v => {
            const btn = document.getElementById(`mh-tab-${v}`);
            if (btn) btn.onclick = () => switchView(v);
        });

        document.getElementById("mh-toggle-upload-btn").onclick = () => {
            isUploadMode = !isUploadMode;
            if (isUploadMode) renderUploadScreen();
            else switchView("mods");
        };
        document.getElementById("mh-refresh-btn").onclick = () => loadModList();

        const filterBtn = document.getElementById("mh-filter-btn");
        if (filterBtn) {
            filterBtn.onclick = () => {
                showActiveOnly = !showActiveOnly;
                filterBtn.classList.toggle("active", showActiveOnly);
                renderModList();
            };
        }

        const searchInput = document.getElementById("mh-search-input");
        const searchBtn = document.getElementById("mh-search-btn");
        if (searchInput) {
            searchInput.oninput = (e) => {
                searchQuery = e.target.value;
                renderModList();
            };
            searchInput.onkeydown = (e) => {
                if (e.key === "Enter") {
                    searchQuery = searchInput.value;
                    renderModList();
                }
            };
        }
        if (searchBtn && searchInput) {
            searchBtn.onclick = () => {
                searchQuery = searchInput.value;
                renderModList();
            };
        }

        document.querySelectorAll(".mod-hub-cat-pill").forEach(pill => {
            pill.onclick = () => {
                selectedCategory = pill.getAttribute("data-cat");
                document.querySelectorAll(".mod-hub-cat-pill").forEach(p => p.classList.toggle("active", p.getAttribute("data-cat") === selectedCategory));
                renderModList();
            };
        });

        switchView(activeView);
    }

    function switchView(viewName) {
        activeView = viewName;
        isUploadMode = false;
        document.querySelectorAll(".mod-hub-side-btn").forEach(b => b.classList.remove("active"));
        const btn = document.getElementById(`mh-tab-${viewName}`);
        if (btn) btn.classList.add("active");

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

        if (viewName === "minigames") {
            const games = ["Dice", "Coinflip", "Mines", "Plinko", "Crash", "Limbo", "Slots", "Roulette", "Wheel", "Keno", "Blackjack"];
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Mod Hub Casino Suite 🎰</h2>
                    <p style="color:#aaa; font-size:12px; margin-bottom:10px;">Select a game mode. All rolls & outcomes are strictly server-verified.</p>
                    <div id="mh-casino-selector" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:12px;">
                        ${games.map(g => `<button class="mod-hub-add-btn mh-game-selector-btn" data-game="${g.toLowerCase()}" style="padding:5px 10px; font-size:10px; background:${g.toLowerCase() === 'dice' ? '#2e7d32' : '#2c2c2c'}; border-color:${g.toLowerCase() === 'dice' ? '#388e3c' : '#444'};">${g}</button>`).join("")}
                    </div>
                    <div class="mod-hub-card" id="mh-casino-arena" style="text-align:center; padding:14px;"></div>
                </div>
            `;

            let selectedGame = "dice";
            document.querySelectorAll(".mh-game-selector-btn").forEach(btn => {
                btn.onclick = () => {
                    document.querySelectorAll(".mh-game-selector-btn").forEach(b => { b.style.background = "#2c2c2c"; b.style.borderColor = "#444"; });
                    btn.style.background = "#2e7d32";
                    btn.style.borderColor = "#388e3c";
                    selectedGame = btn.getAttribute("data-game");
                    loadGameUI(selectedGame);
                };
            });
            loadGameUI("dice");
        } else if (viewName === "chat") {
            main.innerHTML = `
                <div class="mod-hub-tab-page" style="height:100%; display:flex; flex-direction:column;">
                    <h2 class="mod-hub-tab-header">Community Live Chat 💬</h2>
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
        } else if (viewName === "friends") {
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Friends & Community 👥</h2>
                    <p style="color:#aaa; font-size:12px; margin-bottom:12px;">Connect with other players and view sandbox community statuses.</p>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
                        <div class="mod-hub-card">
                            <div style="font-size:12px; font-weight:bold; color:#34d399; margin-bottom:6px;">Your Profile</div>
                            <div style="font-size:11px; color:#ccc;">User: <b style="color:#fff;">${escapeHtml(currentUsername || currentUserEmail || "Guest")}</b></div>
                            <div style="font-size:11px; color:#ccc; margin-top:3px;">ID: <span style="font-family:monospace; color:#888;">${escapeHtml(currentPlayFabId || "Local")}</span></div>
                            <div style="font-size:11px; color:#ccc; margin-top:3px;">Status: <span style="color:#34d399;">● Online</span></div>
                        </div>
                        <div class="mod-hub-card">
                            <div style="font-size:12px; font-weight:bold; color:#ffd75e; margin-bottom:6px;">Community Hub</div>
                            <div style="font-size:11px; color:#aaa;">Active players online in sandbox session.</div>
                            <div style="font-size:18px; font-weight:bold; color:#34d399; margin-top:4px;">1 Online</div>
                        </div>
                    </div>
                </div>
            `;
        } else if (viewName === "inventory") {
            const loadedArr = Array.from(loadedMods.entries());
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Installed Mods & Storage 🎒</h2>
                    <div style="display:flex; gap:12px; margin-bottom:12px;">
                        <div class="mod-hub-card" style="flex:1;"><div style="font-size:11px; color:#aaa;">Available Community Mods</div><div style="font-size:20px; font-weight:bold; color:#34d399; margin-top:4px;">${mods.length}</div></div>
                        <div class="mod-hub-card" style="flex:1;"><div style="font-size:11px; color:#aaa;">Active In-Game</div><div style="font-size:20px; font-weight:bold; color:#60a5fa; margin-top:4px;">${loadedMods.size}</div></div>
                    </div>
                    <div class="mod-hub-card" style="flex:1;">
                        <div style="font-size:12px; font-weight:bold; color:#fff; margin-bottom:8px;">Active Mod Instances</div>
                        ${loadedArr.length === 0 ? '<div style="font-size:12px; color:#888;">No mods currently running in sandbox. Browse the Mods Store to load mods!</div>' : `
                            <div style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto;">
                                ${loadedArr.map(([fn, id]) => `
                                    <div style="display:flex; justify-content:space-between; align-items:center; background:#141414; padding:8px 12px; border-radius:4px; border:1px solid #282828;">
                                        <span style="font-family:monospace; font-size:12px; color:#34d399;">${escapeHtml(fn)}</span>
                                        <span style="font-size:10px; color:#fff; background:#2f6b3a; padding:2px 6px; border-radius:3px;">RUNNING</span>
                                    </div>
                                `).join("")}
                            </div>
                        `}
                    </div>
                </div>
            `;
        } else if (viewName === "achievements") {
            const achievementsList = [
                { id: "first_login", name: "Welcome to Simbox", desc: "Log in to Mod Hub successfully", unlocked: true, icon: "🌟" },
                { id: "mod_loader", name: "Mod Enthusiast", desc: "Execute and run a community mod", unlocked: loadedMods.size > 0, icon: "⚙️" },
                { id: "mod_author", name: "Creator", desc: "Publish your own mod to the store", unlocked: false, icon: "🚀" }
            ];
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Achievements 🏆</h2>
                    <p style="color:#aaa; font-size:12px; margin-bottom:12px;">Track your milestones, unlocks, and trophies across the Mod Hub ecosystem.</p>
                    <div style="display:flex; flex-direction:column; gap:8px; max-height:320px; overflow-y:auto;">
                        ${achievementsList.map(a => `
                            <div class="mod-hub-card" style="display:flex; align-items:center; gap:12px; opacity:${a.unlocked ? '1' : '0.5'}; border-color:${a.unlocked ? '#34d39955' : '#2d2d2d'};">
                                <div style="font-size:24px;">${a.icon}</div>
                                <div style="flex:1;">
                                    <div style="font-size:13px; font-weight:bold; color:${a.unlocked ? '#fff' : '#888'};">${a.name} ${a.unlocked ? '<span style="color:#34d399; font-size:10px; font-weight:bold;">✓ UNLOCKED</span>' : '<span style="color:#666; font-size:10px;">LOCKED</span>'}</div>
                                    <div style="font-size:11px; color:#aaa; margin-top:2px;">${a.desc}</div>
                                </div>
                            </div>
                        `).join("")}
                    </div>
                </div>
            `;
        } else if (viewName === "settings") {
            main.innerHTML = `
                <div class="mod-hub-tab-page">
                    <h2 class="mod-hub-tab-header">Preferences & Settings ⚙️</h2>
                    <p style="color:#aaa; font-size:12px; margin-bottom:12px;">Manage Mod Hub configuration and interface settings.</p>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:bold; color:#fff;">Automatic Ban Polling</div>
                                <div style="font-size:11px; color:#888;">Periodically verifies security status and token validity.</div>
                            </div>
                            <span style="color:#34d399; font-size:12px; font-weight:bold;">ENABLED</span>
                        </div>
                        <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:bold; color:#fff;">Session Security Ticket</div>
                                <div style="font-size:11px; color:#888;">Active PlayFab session ticket encrypted in local storage.</div>
                            </div>
                            <button class="mod-hub-logout-btn" id="mh-clear-session-btn" style="padding:6px 12px; font-size:11px;">Clear Session</button>
                        </div>
                        <div class="mod-hub-card" style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:bold; color:#fff;">Installed Sandbox Mods</div>
                                <div style="font-size:11px; color:#888;">Currently loaded: ${loadedMods.size} mod(s).</div>
                            </div>
                            <button class="mod-hub-unload-btn" id="mh-unload-all-btn" style="padding:6px 12px; font-size:11px;">Unload All</button>
                        </div>
                    </div>
                </div>
            `;
            document.getElementById("mh-clear-session-btn").onclick = () => {
                clearSession();
                renderAuthScreen("login");
            };
            document.getElementById("mh-unload-all-btn").onclick = () => {
                try {
                    Array.from(loadedMods.keys()).forEach(fn => {
                        const modObj = mods.find(m => m.filename === fn);
                        if (modObj) disableMod(modObj);
                    });
                } catch(e){}
                renderSectionView("settings");
            };
        } else {
            main.innerHTML = `<div class="mod-hub-tab-page"><h2 class="mod-hub-tab-header">${viewName.toUpperCase()}</h2><p style="color:#888; font-size:12px;">Module operational.</p></div>`;
        }
    }

    function loadGameUI(game) {
        const arena = document.getElementById("mh-casino-arena");
        if (!arena) return;

        let extraHTML = "";
        if (game === "dice") {
            extraHTML = `<div style="display:flex; gap:10px; justify-content:center; margin-bottom:10px; align-items:center;"><label style="font-size:11px; color:#aaa;">Roll Over:</label><input type="number" id="mh-dice-target" min="1" max="98" value="50" style="width:60px; background:#141414; border:1px solid #383838; border-radius:4px; padding:6px; color:#fff; text-align:center;"></div>`;
        } else if (game === "coinflip") {
            extraHTML = `<div style="display:flex; gap:10px; justify-content:center; margin-bottom:10px;"><button class="mod-hub-add-btn" id="mh-cf-heads" style="background:#2e7d32; border-color:#388e3c; padding:6px 14px;">Heads</button><button class="mod-hub-add-btn" id="mh-cf-tails" style="background:#222; border-color:#444; padding:6px 14px;">Tails</button></div>`;
        } else if (game === "limbo" || game === "crash") {
            extraHTML = `<div style="display:flex; gap:8px; justify-content:center; margin-bottom:10px; align-items:center;"><label style="font-size:11px; color:#aaa;">Target Multiplier:</label><input type="number" id="mh-limbo-target" min="1.1" max="100" step="0.1" value="2.0" style="width:60px; background:#141414; border:1px solid #383838; border-radius:4px; padding:6px; color:#fff; text-align:center;"></div>`;
        } else if (game === "roulette") {
            extraHTML = `<div style="display:flex; gap:8px; justify-content:center; margin-bottom:10px;"><button class="mod-hub-add-btn" id="mh-roulette-red" style="background:#7a1818; padding:6px 12px;">Red (2x)</button><button class="mod-hub-add-btn" id="mh-roulette-black" style="background:#222; padding:6px 12px;">Black (2x)</button><button class="mod-hub-add-btn" id="mh-roulette-green" style="background:#205c2c; padding:6px 12px;">Green (35x)</button></div>`;
        } else if (game === "mines") {
            extraHTML = `<div id="mh-mines-grid" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; max-width:200px; margin:0 auto 10px auto;">${[0,1,2,3,4,5,6,7,8].map(i => `<button class="mh-mine-tile" data-id="${i}" style="height:40px; background:#222; border:1px solid #444; border-radius:4px; font-size:14px; cursor:pointer;">❓</button>`).join("")}</div>`;
        }

        arena.innerHTML = `
            <h3 style="font-size:15px; margin:0 0 10px 0; color:#ffd75e; text-transform:capitalize;">${game} Arena</h3>
            <div id="mh-game-display" style="font-size:24px; font-weight:bold; color:#34d399; margin-bottom:10px; min-height:36px; display:flex; align-items:center; justify-content:center;">Ready</div>
            ${extraHTML}
            <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center; justify-content:center;">
                <label style="font-size:11px; color:#aaa;">Bet (MH):</label>
                <input type="number" id="mh-bet-input" min="1" max="1000" value="10" style="width:70px; background:#141414; border:1px solid #383838; border-radius:4px; padding:6px; color:#fff; text-align:center;">
            </div>
            <div id="mh-casino-status" style="font-size:11px; color:#ccc; margin-bottom:10px; min-height:16px;">Place wager and play.</div>
            <button class="mod-hub-add-btn" id="mh-play-game-btn" style="width:100%; justify-content:center; padding:10px;">PLAY ${game.toUpperCase()}</button>
        `;

        let cfGuess = "heads";
        if (game === "coinflip") {
            document.getElementById("mh-cf-heads").onclick = () => { cfGuess = "heads"; document.getElementById("mh-cf-heads").style.background = "#2e7d32"; document.getElementById("mh-cf-tails").style.background = "#222"; };
            document.getElementById("mh-cf-tails").onclick = () => { cfGuess = "tails"; document.getElementById("mh-cf-tails").style.background = "#2e7d32"; document.getElementById("mh-cf-heads").style.background = "#222"; };
        }

        let rColor = "red";
        if (game === "roulette") {
            document.getElementById("mh-roulette-red").onclick = () => { rColor = "red"; document.getElementById("mh-roulette-red").style.outline = "2px solid #fff"; document.getElementById("mh-roulette-black").style.outline = "none"; document.getElementById("mh-roulette-green").style.outline = "none"; };
            document.getElementById("mh-roulette-black").onclick = () => { rColor = "black"; document.getElementById("mh-roulette-black").style.outline = "2px solid #fff"; document.getElementById("mh-roulette-red").style.outline = "none"; document.getElementById("mh-roulette-green").style.outline = "none"; };
            document.getElementById("mh-roulette-green").onclick = () => { rColor = "green"; document.getElementById("mh-roulette-green").style.outline = "2px solid #fff"; document.getElementById("mh-roulette-red").style.outline = "none"; document.getElementById("mh-roulette-black").style.outline = "none"; };
        }

        let minesCount = 0;
        if (game === "mines") {
            document.querySelectorAll(".mh-mine-tile").forEach(tile => {
                tile.onclick = async () => {
                    const bet = parseInt(document.getElementById("mh-bet-input").value, 10) || 10;
                    minesCount++;
                    const res = await executeCloudScript("playCasinoGame", { bet: bet, game: "mines", gems: minesCount }).catch(() => null);
                    if (res && res.success) {
                        currentBalance = res.balance;
                        updateHeaderDisplay();
                        if (res.multiplier === 0) {
                            tile.textContent = "💣"; tile.style.background = "#7a1818";
                            document.getElementById("mh-casino-status").innerHTML = `<span style="color:#ff9999;">BOOM! Lost ${bet} MH.</span>`;
                        } else {
                            tile.textContent = "💎"; tile.style.background = "#205c2c"; tile.disabled = true;
                            document.getElementById("mh-casino-status").innerHTML = `<span style="color:#34d399;">Gem found! Multiplier: ${res.multiplier}x (${res.payout} MH)</span>`;
                        }
                    }
                };
            });
            document.getElementById("mh-play-game-btn").style.display = "none";
            return;
        }

        document.getElementById("mh-play-game-btn").onclick = async () => {
            const bet = parseInt(document.getElementById("mh-bet-input").value, 10) || 10;
            const status = document.getElementById("mh-casino-status");
            const display = document.getElementById("mh-game-display");

            if (currentBalance < bet) { status.textContent = "Insufficient MH!"; status.className = "mod-hub-auth-status error"; return; }

            const payload = { bet: bet, game: game };
            if (game === "dice") payload.threshold = parseFloat(document.getElementById("mh-dice-target").value) || 50;
            if (game === "coinflip") payload.guess = cfGuess;
            if (game === "limbo" || game === "crash") payload.target = parseFloat(document.getElementById("mh-limbo-target").value) || 2.0;
            if (game === "roulette") payload.color = rColor;
            if (game === "keno") payload.hits = Math.floor(Math.random() * 5);

            try {
                const res = await executeCloudScript("playCasinoGame", payload);
                if (!res || !res.success) throw new Error(res?.error || "Play failed.");
                currentBalance = res.balance;
                updateHeaderDisplay();

                display.textContent = `${res.multiplier}x`;
                if (res.net >= 0) status.innerHTML = `<span style="color:#34d399;">Won ${res.payout} MH! (+${res.net} MH)</span>`;
                else status.innerHTML = `<span style="color:#ff9999;">Lost ${bet} MH.</span>`;
            } catch (err) { status.textContent = err.message; status.className = "mod-hub-auth-status error"; }
        };
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
                    <button type="button" class="mod-hub-tag-pick-btn ${selected.has(cat) ? 'selected' : ''}" data-cat="${cat}" style="background:${selected.has(cat) ? '#204d30' : '#222'}; border:1px solid ${selected.has(cat) ? '#34d399' : '#383838'}; color:${selected.has(cat) ? '#34d399' : '#aaa'}; border-radius:12px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer;">
                        ${selected.has(cat) ? '✓ ' : '+ '}${cat.charAt(0).toUpperCase() + cat.slice(1)}
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
                btn.style.background = isSel ? "#204d30" : "#222";
                btn.style.borderColor = isSel ? "#34d399" : "#383838";
                btn.style.color = isSel ? "#34d399" : "#aaa";
                btn.textContent = (isSel ? "✓ " : "+ ") + cat.charAt(0).toUpperCase() + cat.slice(1);
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
                <p style="font-size:11px; color:#aaa; margin-bottom:12px;">Share your custom elements, tools, and creations with the Simbox community.</p>
                <form id="mh-upload-form" style="display:flex; flex-direction:column; gap:10px;">
                    <div class="mod-hub-input-group"><label>Mod Name</label><input type="text" id="mh-up-name" required></div>
                    <div class="mod-hub-input-group"><label>Filename (.js)</label><input type="text" id="mh-up-filename" required></div>
                    <div class="mod-hub-input-group">
                        <label>Tags / Categories (Select all that apply)</label>
                        ${renderTagSelector("mh-up-tags-container", ["fun"])}
                    </div>
                    <div class="mod-hub-input-group"><label>Description</label><textarea id="mh-up-desc" rows="2" required style="background:#141414; border:1px solid #383838; border-radius:4px; padding:8px; color:#fff; font-size:12px; outline:none; resize:none;"></textarea></div>
                    <div class="mod-hub-input-group"><label>JavaScript Code</label><textarea id="mh-up-code" rows="8" required style="background:#111; border:1px solid #383838; border-radius:4px; padding:8px; color:#34d399; font-family:monospace; font-size:11px; outline:none; resize:vertical;"></textarea></div>
                    <div class="mod-hub-auth-status" id="mh-upload-status"></div>
                    <button type="submit" class="mod-hub-add-btn" id="mh-up-submit">Publish Mod</button>
                </form>
            </div>
        `;
        setupTagSelectorEvents("mh-up-tags-container");

        document.getElementById("mh-upload-form").onsubmit = async (e) => {
            e.preventDefault();
            const status = document.getElementById("mh-upload-status");
            status.textContent = "Streaming code chunks...";
            try {
                await streamCodeChunks(document.getElementById("mh-up-code").value, (c, t) => { status.textContent = `Streaming code buffer... (${c}/${t})`; });
                const res = await executeCloudScript("finalizeChunkedUpload", {
                    name: document.getElementById("mh-up-name").value.trim(),
                    filename: document.getElementById("mh-up-filename").value.trim(),
                    category: getSelectedTagsFromContainer("mh-up-tags-container"),
                    price: 0,
                    description: document.getElementById("mh-up-desc").value.trim()
                });
                if (!res || !res.success) throw new Error(res?.error || "Upload rejected.");
                currentBalance = res.balance || currentBalance;
                updateHeaderDisplay();
                status.textContent = "Successfully published!";
                setTimeout(() => switchView("mods"), 1200);
            } catch (err) {
                status.textContent = `Error: ${err.message}`;
                status.className = "mod-hub-auth-status error";
            }
        };
    }

    async function renderEditScreen(mod) {
        const main = document.getElementById("mh-main-panel");
        if (!main) return;
        main.innerHTML = `<div class="mod-hub-loading">Loading code...</div>`;
        let code = codeCache[mod.filename] || "";
        if (!code) {
            try { const res = await fetchModCode(mod.filename); code = res.code; codeCache[mod.filename] = code; } catch (e) { code = "// Error loading code."; }
        }
        const existingTags = getCategoryList(mod.category);
        main.innerHTML = `
            <div class="mod-hub-upload-card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h2 style="font-size:18px; margin:0; color:#fff;">Edit Mod: ${escapeHtml(mod.name)}</h2>
                    <button id="mh-cancel-edit-btn" class="mod-hub-logout-btn">Cancel</button>
                </div>
                <form id="mh-edit-form" style="display:flex; flex-direction:column; gap:10px;">
                    <div class="mod-hub-input-group"><label>Name</label><input type="text" id="mh-edit-name" value="${escapeHtml(mod.name)}" required></div>
                    <div class="mod-hub-input-group">
                        <label>Tags / Categories (Select all that apply)</label>
                        ${renderTagSelector("mh-edit-tags-container", existingTags)}
                    </div>
                    <div class="mod-hub-input-group"><label>Description</label><textarea id="mh-edit-desc" rows="2" required style="background:#141414; border:1px solid #383838; border-radius:4px; padding:8px; color:#fff; font-size:12px; outline:none; resize:none;">${escapeHtml(mod.Description || "")}</textarea></div>
                    <div class="mod-hub-input-group"><label>Code</label><textarea id="mh-edit-code" rows="9" required style="background:#111; border:1px solid #383838; border-radius:4px; padding:8px; color:#34d399; font-family:monospace; font-size:11px; outline:none; resize:vertical;">${escapeHtml(code)}</textarea></div>
                    <div class="mod-hub-auth-status" id="mh-edit-status"></div>
                    <div style="display:flex; gap:10px;"><button type="submit" class="mod-hub-add-btn">Save Changes</button><button type="button" class="mod-hub-unload-btn" id="mh-delete-btn">Delete</button></div>
                </form>
            </div>
        `;
        setupTagSelectorEvents("mh-edit-tags-container");

        document.getElementById("mh-cancel-edit-btn").onclick = () => selectMod(mod);
        document.getElementById("mh-delete-btn").onclick = () => deleteMod(mod);
        document.getElementById("mh-edit-form").onsubmit = async (e) => {
            e.preventDefault();
            const status = document.getElementById("mh-edit-status");
            try {
                await streamCodeChunks(document.getElementById("mh-edit-code").value, (c, t) => { status.textContent = `Streaming code buffer... (${c}/${t})`; });
                const res = await executeCloudScript("finalizeChunkedEdit", {
                    filename: mod.filename,
                    name: document.getElementById("mh-edit-name").value.trim(),
                    category: getSelectedTagsFromContainer("mh-edit-tags-container"),
                    price: 0,
                    description: document.getElementById("mh-edit-desc").value.trim()
                });
                if (!res || !res.success) throw new Error(res?.error || "Edit failed.");
                status.textContent = "Saved successfully!";
                setTimeout(() => loadModList(), 1000);
            } catch (err) { status.textContent = `Error: ${err.message}`; status.className = "mod-hub-auth-status error"; }
        };
    }

    async function deleteMod(mod) {
        if (!confirm(`Permanently delete "${mod.name || mod.filename}"?`)) return;
        try {
            const res = await executeCloudScript("deleteMod", { filename: mod.filename });
            if (!res || !res.success) throw new Error(res?.error || "Delete failed.");
            selectedMod = null;
            loadModList();
        } catch (err) { alert(`Delete error: ${err.message}`); }
    }

    async function loadModList() {
        const listDiv = document.getElementById("mh-mod-list");
        if (!listDiv) return;
        listDiv.innerHTML = `<div class="mod-hub-loading">Loading mods...</div>`;
        try {
            mods = await fetchModList();
            renderModList();
            if (mods.length > 0 && !selectedMod) selectMod(mods[0]);
        } catch (err) {
            listDiv.innerHTML = `<div class="mod-hub-error">Failed to load.<br>${escapeHtml(err.message)}</div>`;
        }
    }

    function renderModList() {
        const listDiv = document.getElementById("mh-mod-list");
        if (!listDiv) return;
        listDiv.innerHTML = "";
        if (mods.length === 0) { listDiv.innerHTML = `<div class="mod-hub-empty-state" style="grid-column: 1 / -1;">No mods found.</div>`; return; }

        const q = (searchQuery || "").trim().toLowerCase();
        let visibleMods = mods.filter(m => {
            if (showActiveOnly && !loadedMods.has(m.filename)) return false;
            const catList = getCategoryList(m.category);
            if (selectedCategory && selectedCategory !== "all") {
                if (!catList.includes(selectedCategory.toLowerCase())) return false;
            }
            if (q) {
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
                            ${mod.pinned ? '📌 ' : ''}${escapeHtml(mod.name || mod.filename)}
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                        <div style="display:flex; flex-wrap:wrap; gap:3px;">
                            ${cats.length > 0 ? cats.map(c => `<span class="mod-hub-cat-badge ${c}">${c.toUpperCase()}</span>`).join("") : '<span></span>'}
                        </div>
                        <div class="mod-hub-item-stats">
                            <span title="Likes">❤️ ${likes}</span>
                            <span title="Views">👁️ ${views}</span>
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
                        <button class="mod-hub-like-btn" id="mh-like-btn">❤️ <span id="mh-like-count">${mod.likes || 0}</span></button>
                        <span class="mod-hub-stat" id="mh-view-count">👁️ ${mod.views || 0}</span>
                    </div>
                </div>
                <p class="mod-hub-detail-desc">${escapeHtml(mod.Description || "")}</p>
                <div class="mod-hub-snippet-label">Code Preview</div>
                <pre class="mod-hub-snippet" id="mh-snippet"><code>Loading preview...</code></pre>
                <div class="mod-hub-detail-status" id="mh-status"></div>
                <div class="mod-hub-btn-row">
                    <button class="mod-hub-add-btn" id="mh-add-btn" ${alreadyAdded ? "disabled" : ""}>${alreadyAdded ? "Added to Game" : "Add to Game"}</button>
                    <button class="mod-hub-unload-btn" id="mh-unload-btn" style="${alreadyAdded ? "" : "display:none;"}">Unload</button>
                    ${isOwner && mod.filename !== ADMIN_MOD_FILENAME ? `<button class="mod-hub-edit-btn" id="mh-edit-btn">Edit Mod ✏️</button>` : ''}
                    ${isUserAdmin && mod.filename !== ADMIN_MOD_FILENAME ? `<button class="mod-hub-pin-toggle-btn" id="mh-pin-toggle-btn">${mod.pinned ? "Unpin" : "Pin 📌"}</button>` : ''}
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

    async function buyMod(mod) {
        try {
            const res = await executeCloudScript("purchaseMod", { filename: mod.filename });
            if (!res || !res.success) throw new Error(res?.error || "Purchase failed.");
            purchasedMods.add(mod.filename);
            delete codeCache[mod.filename];
            currentBalance = res.balance || currentBalance;
            updateHeaderDisplay();
            selectMod(mod);
        } catch (err) { alert(`Purchase error: ${err.message}`); }
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

    async function togglePinMod(mod) {
        try {
            const p = !(mod.pinned === "true" || mod.pinned === true);
            await executeCloudScript("adminTogglePinMod", { filename: mod.filename, pinned: p });
            loadModList();
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
            const reg = ModManager.installBuiltInMod(mod.name || mod.filename, mod.version || "1.0.0", code);
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
            .mod-hub-window { position: fixed; top: 10vh; left: 10vw; width: 880px; height: 580px; min-width: 680px; min-height: 440px; background: #1a1a1a; border: 2px solid #333; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); color: #fff; font-family: sans-serif; z-index: 100000; display: flex; flex-direction: column; overflow: visible; opacity: 0; transform: scale(0.95); transition: opacity 0.15s ease, transform 0.15s ease; }
            .mod-hub-window.show { opacity: 1; transform: scale(1); }
            .mod-hub-sidebar-tab { position: absolute; right: -24px; top: 50%; transform: translateY(-50%); width: 24px; height: 50px; background: #222; border: 2px solid #333; border-left: none; border-top-right-radius: 6px; border-bottom-right-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #888; font-size: 12px; font-weight: bold; user-select: none; z-index: 10; }
            .mod-hub-sidebar-tab:hover { background: #2c2c2c; color: #34d399; }
            .mod-hub-sidebar-tab-arrow { transition: transform 0.3s ease; }
            .mod-hub-sidebar-tab.open .mod-hub-sidebar-tab-arrow { transform: rotate(180deg); }
            .mod-hub-right-sidebar { position: absolute; top: 0; right: 0; width: 180px; height: 100%; background: rgba(22,22,22,0.95); border-left: 2px solid #333; transform: translateX(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); z-index: 5; display: flex; flex-direction: column; padding: 12px 8px; gap: 6px; overflow-y: auto; }
            .mod-hub-right-sidebar.open { transform: translateX(0); }
            .mod-hub-side-btn { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #222; border: 1px solid #333; border-radius: 6px; color: #ccc; font-size: 12px; font-weight: 600; cursor: pointer; text-align: left; width: 100%; }
            .mod-hub-side-btn:hover { background: #2c2c2c; color: #fff; }
            .mod-hub-side-btn.active { background: #383838; border-color: #34d399; color: #34d399; }
            .mod-hub-tab-page { display: flex; flex-direction: column; width: 100%; }
            .mod-hub-tab-header { font-size: 18px; font-weight: 700; color: #fff; margin: 0 0 4px 0; }
            .mod-hub-card { background: #181818; border: 1px solid #2d2d2d; border-radius: 6px; padding: 12px 14px; }
            .mod-hub-chat-box { flex: 1; min-height: 220px; max-height: 300px; background: #121212; border: 1px solid #2d2d2d; border-radius: 6px; padding: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
            .mod-hub-chat-msg { display: flex; gap: 8px; font-size: 12px; }
            .mod-hub-chat-user { font-weight: bold; color: #34d399; }
            .mod-hub-chat-text { color: #eee; word-break: break-word; }
            .mod-hub-chat-time { font-size: 9px; color: #666; margin-left: auto; }
            .mod-hub-header { background: #222; padding: 10px 14px; border-bottom: 2px solid #333; cursor: move; display: flex; justify-content: space-between; align-items: center; border-top-left-radius: 4px; border-top-right-radius: 4px; }
            .mod-hub-discord-link { display: inline-flex; align-items: center; justify-content: center; color: #5865f2; background: #1a1c2e; border: 1px solid #353965; border-radius: 4px; padding: 3px 5px; text-decoration: none; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
            .mod-hub-discord-link:hover { background: #5865f2; color: #fff; border-color: #5865f2; }
            .mod-hub-close { background: none; border: none; color: #888; font-size: 20px; font-weight: bold; cursor: pointer; }
            .mod-hub-close:hover { color: #ef4444; }
            .mod-hub-balance-badge { background: #2b2310; border: 1px solid #705d21; color: #ffd75e; font-size: 11px; font-weight: bold; padding: 4px 8px; border-radius: 4px; }
            .mod-hub-nav-btn, .mod-hub-logout-btn { background: #2c2c2c; border: 1px solid #444; color: #34d399; border-radius: 4px; font-size: 11px; font-weight: bold; padding: 4px 8px; cursor: pointer; }
            .mod-hub-logout-btn { color: #bbb; background: #333; }
            .mod-hub-auth-container { flex: 1; display: flex; align-items: center; justify-content: center; background: #151515; padding: 20px; }
            .mod-hub-auth-card { background: #202020; border: 1px solid #333; border-radius: 8px; width: 340px; padding: 24px; }
            .mod-hub-auth-tabs { display: flex; gap: 8px; margin-bottom: 18px; border-bottom: 1px solid #333; padding-bottom: 8px; }
            .mod-hub-tab-btn { flex: 1; background: transparent; border: none; color: #888; font-size: 13px; font-weight: bold; padding: 6px 0; cursor: pointer; border-bottom: 2px solid transparent; }
            .mod-hub-tab-btn.active { color: #fff; border-bottom: 2px solid #34d399; }
            .mod-hub-auth-form, .mod-hub-input-group { display: flex; flex-direction: column; gap: 8px; }
            .mod-hub-input-group label { font-size: 11px; color: #aaa; font-weight: 600; }
            .mod-hub-input-group input, .mod-hub-input-group textarea, .mod-hub-input-group select { background: #141414; border: 1px solid #383838; border-radius: 4px; padding: 8px; color: #fff; font-size: 12px; outline: none; }
            .mod-hub-auth-status { font-size: 11px; min-height: 14px; }
            .mod-hub-auth-status.error { color: #ff9999; }
            .mod-hub-auth-status.success { color: #34d399; }
            .mod-hub-auth-submit-btn, .mod-hub-add-btn { background: #2e7d32; border: 1px solid #388e3c; color: #fff; border-radius: 4px; padding: 10px; font-weight: bold; font-size: 12px; cursor: pointer; }
            
            /* Body layout & 50% left window */
            .mod-hub-body { display: flex; flex: 1; overflow: hidden; position: relative; }
            .mod-hub-sidebar { width: 50%; min-width: 320px; border-right: 2px solid #333; display: flex; flex-direction: column; background: #151515; }
            .mod-hub-sidebar-top { padding: 8px 10px; border-bottom: 1px solid #2a2a2a; display: flex; gap: 6px; }
            .mod-hub-refresh-btn, .mod-hub-filter-btn { padding: 6px 10px; background: #2c2c2c; border: 1px solid #444; color: #fff; border-radius: 4px; font-weight: 600; font-size: 11px; cursor: pointer; }
            .mod-hub-filter-btn.active { background: #4a4522; border-color: #8a7d2e; color: #ffd75e; }
            
            /* Search & Categories */
            .mod-hub-search-box { padding: 6px 10px; display: flex; gap: 6px; background: #181818; border-bottom: 1px solid #282828; }
            .mod-hub-search-input { flex: 1; background: #121212; border: 1px solid #333; border-radius: 4px; padding: 6px 8px; color: #fff; font-size: 11px; outline: none; }
            .mod-hub-search-input:focus { border-color: #34d399; }
            .mod-hub-search-btn { background: #2c2c2c; border: 1px solid #444; color: #fff; border-radius: 4px; padding: 6px 10px; font-size: 11px; cursor: pointer; }
            .mod-hub-search-btn:hover { background: #383838; }
            
            .mod-hub-cat-pills { padding: 6px 10px; display: flex; flex-wrap: wrap; gap: 4px; background: #151515; border-bottom: 1px solid #282828; }
            .mod-hub-cat-pill { background: #222; border: 1px solid #333; border-radius: 12px; color: #aaa; font-size: 10px; font-weight: 600; padding: 3px 8px; cursor: pointer; transition: all 0.15s ease; }
            .mod-hub-cat-pill:hover { background: #2c2c2c; color: #fff; }
            .mod-hub-cat-pill.active { background: #204d30; border-color: #34d399; color: #34d399; }
            
            /* Side-by-side grid */
            .mod-hub-list { flex: 1; overflow-y: auto; padding: 8px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; align-content: start; }
            .mod-hub-item { padding: 8px 10px; background: #222; border: 1px solid #2d2d2d; border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; flex-direction: column; transition: border-color 0.15s ease, background 0.15s ease; }
            .mod-hub-item:hover { background: #292929; border-color: #444; }
            .mod-hub-item.active { background: #303030; border-color: #34d399; }
            .mod-hub-item-name { font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
            .mod-hub-item-stats { display: flex; gap: 6px; font-size: 10px; color: #888; }
            
            /* Category Badges */
            .mod-hub-cat-badge { font-size: 8px; font-weight: 800; padding: 2px 5px; border-radius: 3px; letter-spacing: 0.5px; }
            .mod-hub-cat-badge.fun { background: #432b68; color: #d8b4fe; border: 1px solid #6b3fb8; }
            .mod-hub-cat-badge.cool { background: #1e3a5f; color: #93c5fd; border: 1px solid #2b5c96; }
            .mod-hub-cat-badge.elements { background: #5c3b1e; color: #fdba74; border: 1px solid #945829; }
            .mod-hub-cat-badge.function { background: #1e4b3e; color: #6ee7b7; border: 1px solid #297a61; }
            .mod-hub-cat-badge.tool { background: #4a4522; color: #fde047; border: 1px solid #756a29; }
            
            .mod-hub-price-badge, .mod-hub-price-tag { font-size: 9px; font-weight: bold; color: #ffd75e; background: #3a2e12; padding: 2px 4px; border-radius: 3px; border: 1px solid #634f19; white-space: nowrap; }
            .mod-hub-price-badge.free { color: #86efac; background: #1b3824; border-color: #276137; }
            .mod-hub-added-badge { font-size: 8px; font-weight: bold; color: #fff; background: #2f6b3a; padding: 1px 4px; border-radius: 3px; }
            
            /* Main panel & details */
            .mod-hub-main { flex: 1; display: flex; flex-direction: column; background: #1a1a1a; padding: 20px; overflow-y: auto; }
            .mod-hub-stats-row { display: flex; align-items: center; gap: 6px; }
            .mod-hub-like-btn, .mod-hub-stat { background: #242424; border: 1px solid #383838; color: #ff7b7b; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; cursor: pointer; }
            .mod-hub-stat { color: #aaa; cursor: default; }
            .mod-hub-detail { display: flex; flex-direction: column; gap: 10px; width: 100%; }
            .mod-hub-detail-title { margin: 0; font-size: 18px; font-weight: 700; color: #fff; }
            .mod-hub-detail-filename { font-family: monospace; font-size: 11px; color: #666; }
            .mod-hub-detail-desc { font-size: 12px; color: #ccc; line-height: 1.5; background: #141414; border: 1px solid #282828; padding: 8px 10px; border-radius: 4px; }
            .mod-hub-snippet { background: #111; border: 1px solid #333; border-radius: 6px; padding: 8px 12px; max-height: 120px; overflow: auto; font-family: monospace; font-size: 11px; color: #34d399; white-space: pre; }
            .mod-hub-btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
            .mod-hub-buy-btn { padding: 10px 18px; background: #856404; border: 1px solid #ffeeba; color: #fff; font-weight: 700; font-size: 12px; border-radius: 6px; cursor: pointer; }
            .mod-hub-unload-btn { padding: 10px 16px; background: #5a2c2c; border: 1px solid #7a3c3c; color: #ff9999; font-weight: 700; font-size: 12px; border-radius: 6px; cursor: pointer; }
            .mod-hub-edit-btn { padding: 10px 14px; background: #2a3a4a; border: 1px solid #3c546b; color: #8bc3ff; font-weight: 700; font-size: 12px; border-radius: 6px; cursor: pointer; }
            .mod-hub-pin-toggle-btn { padding: 10px 14px; background: #3d3416; border: 1px solid #705d21; color: #ffd75e; font-weight: 700; font-size: 12px; border-radius: 6px; cursor: pointer; }
        `;
        document.head.appendChild(styleTag);
    }
})();
