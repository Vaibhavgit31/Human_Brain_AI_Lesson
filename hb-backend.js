/*
 * Dr. Kaya WebGL backend connection helper.
 * Load this script BEFORE the Unity loader and the existing voice bridge.
 * The original frontend was not supplied. Unity C# UnityWebRequest interception
 * and audible end-to-end playback must still be verified in the actual build.
 *
 * window.HBBackend.connect(code) -> Promise<boolean>
 * window.HBBackend.ready -> boolean (usable public mode or an unexpired session)
 * window.HBBackend.disconnect() clears this tab's stored session.
 * window.HBBackend.refreshStatus() checks public health without generating audio.
 *
 * Only the short-lived signed token is kept in sessionStorage, never the access
 * code or a provider key. HTTP errors do not replay chargeable requests.
 */
(function () {
  "use strict";
  if (window.HBBackend) return;

  const SERVER = "https://dr-kaya-api.vaibhav-996.workers.dev";
  const API_ORIGIN = new URL(SERVER).origin;
  const STORAGE_KEY = "dr-kaya.classroom-session.v1";
  const PROTECTED = new Set(["/api/chat", "/api/coach", "/api/stt", "/api/tts", "/api/memory/sync"]);
  const nativeFetch = window.fetch.bind(window);
  const NativeRequest = window.Request;
  const NativeHeaders = window.Headers;
  let token = "";
  let expiresAt = 0;
  let authRequired = null;
  let accessConfigured = false;
  let connectionState = "checking";
  let message = "Checking Dr. Kaya’s connection…";
  let healthTask = null;
  let expirationTimer = 0;
  let ui = null;
  let connecting = false;
  window.HB_SERVER_URL = SERVER;

  function readStoredSession() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved.token === "string" && /^hb1\./.test(saved.token)
          && saved.token.length <= 2048 && saved.origin === location.origin
          && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) {
        token = saved.token;
        expiresAt = saved.expiresAt;
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* Storage may be disabled: a session can still live in memory. */ }
  }

  function currentToken() {
    if (token && expiresAt <= Date.now()) clearSession("Your classroom session ended. Enter the access code to reconnect.");
    return token;
  }

  function ready() {
    return authRequired === false || (authRequired === true && accessConfigured && !!currentToken());
  }

  function setState(state, text) {
    connectionState = state;
    message = text;
    render();
  }

  function clearSession(text) {
    token = "";
    expiresAt = 0;
    window.clearTimeout(expirationTimer);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Memory-only session. */ }
    if (authRequired !== false) setState("needs_code", text || "Enter the classroom access code to connect Dr. Kaya.");
  }

  function storeSession(session) {
    token = session.token;
    expiresAt = Date.parse(session.expiresAt);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, expiresAt, origin: location.origin })); }
    catch { /* The token remains in this tab's memory when storage is unavailable. */ }
    window.clearTimeout(expirationTimer);
    expirationTimer = window.setTimeout(() => currentToken(), Math.max(1, expiresAt - Date.now() + 50));
  }

  async function jsonOrEmpty(response) {
    try { return await response.json(); } catch { return {}; }
  }

  async function refreshStatus() {
    if (healthTask) return healthTask;
    healthTask = (async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await nativeFetch(SERVER + "/api/health", {
          method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal,
        });
        const health = await jsonOrEmpty(response);
        if (!response.ok || typeof health.auth?.required !== "boolean") throw new Error("health unavailable");
        authRequired = health.auth.required;
        accessConfigured = health.auth.configured === true;
        if (!authRequired) {
          clearSession();
          setState("public", "Dr. Kaya is connected.");
        } else if (!accessConfigured) {
          clearSession();
          setState("configuration", "Classroom access is not set up yet. Ask the presenter to finish the server setup.");
        } else if (currentToken()) {
          setState("connected", "Dr. Kaya connected");
        } else {
          setState("needs_code", "Enter the classroom access code to connect Dr. Kaya.");
        }
        return ready();
      } catch {
        setState("unavailable", "Dr. Kaya’s server could not be reached. Check the connection and try again.");
        return false;
      } finally {
        window.clearTimeout(timeout);
        healthTask = null;
      }
    })();
    return healthTask;
  }

  async function connect(code) {
    if (connecting) return false;
    if (typeof code !== "string" || !code.trim()) {
      setState("needs_code", "Enter the classroom access code.");
      return false;
    }
    connecting = true;
    render();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await nativeFetch(SERVER + "/api/session", {
        method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim() }), signal: controller.signal,
      });
      const session = await jsonOrEmpty(response);
      if (!response.ok) {
        const messages = {
          invalid_access_code: "That access code is incorrect. Check it with the presenter.",
          login_rate_limited: "Too many connection attempts. Wait a minute before trying again.",
          access_not_configured: "Classroom access is not set up yet. Ask the presenter to finish the server setup.",
          origin: "This website has not been allowed to connect to Dr. Kaya yet.",
          session_origin: "This website has not been allowed to connect to Dr. Kaya yet.",
        };
        setState(session.code === "access_not_configured" ? "configuration" : "needs_code", messages[session.code] || "Dr. Kaya could not connect. Please try again.");
        return false;
      }
      if (session.public === true) {
        authRequired = false;
        accessConfigured = true;
        clearSession();
        setState("public", "Dr. Kaya is connected.");
        return true;
      }
      const expiry = Date.parse(session.expiresAt);
      if (typeof session.token !== "string" || !/^hb1\./.test(session.token) || session.token.length > 2048
          || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 13 * 60 * 60 * 1000) {
        throw new Error("unusable session");
      }
      authRequired = true;
      accessConfigured = true;
      storeSession(session);
      setState("connected", "Dr. Kaya connected");
      return true;
    } catch {
      setState("unavailable", "Dr. Kaya’s server could not be reached. Check the connection and try again.");
      return false;
    } finally {
      connecting = false;
      window.clearTimeout(timeout);
      render();
    }
  }

  function isProtectedUrl(input) {
    try {
      const url = new URL(input instanceof NativeRequest ? input.url : String(input), location.href);
      return url.origin === API_ORIGIN && !url.username && !url.password && PROTECTED.has(url.pathname);
    } catch { return false; }
  }

  function sessionRejected() {
    clearSession("Your session needs to be renewed. Enter the classroom access code again.");
  }

  // Requests to all other domains and unrelated routes are passed through with
  // their original arguments. Backend fetches reject redirects so the token
  // cannot be forwarded by a redirect to an unexpected destination.
  window.fetch = function (input, init) {
    if (!isProtectedUrl(input)) return nativeFetch(input, init);
    const active = currentToken();
    if (!active) return nativeFetch(input, init);
    const request = new NativeRequest(input, init);
    const headers = new NativeHeaders(request.headers);
    if (headers.has("Authorization")) return nativeFetch(input, init);
    headers.set("Authorization", "Bearer " + active);
    const authenticated = new NativeRequest(request, { headers, credentials: "omit", redirect: "error" });
    return nativeFetch(authenticated).then((response) => {
      if (response.status === 401) sessionRejected();
      return response;
    });
  };

  // Unity WebGL commonly sends UnityWebRequest through XMLHttpRequest. Keep
  // response types, event handlers, bodies, timeout and cancellation unchanged.
  // Standard browser redirect processing strips Authorization cross-origin.
  if (window.XMLHttpRequest) {
    const prototype = window.XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalHeader = prototype.setRequestHeader;
    const requests = new WeakMap();
    prototype.open = function (method, url) {
      requests.set(this, { protected: isProtectedUrl(url), hasAuthorization: false });
      return originalOpen.apply(this, arguments);
    };
    prototype.setRequestHeader = function (name, value) {
      const state = requests.get(this);
      if (state && String(name).toLowerCase() === "authorization") state.hasAuthorization = true;
      return originalHeader.apply(this, arguments);
    };
    prototype.send = function () {
      const state = requests.get(this);
      const active = state?.protected && !state.hasAuthorization ? currentToken() : "";
      if (active) {
        originalHeader.call(this, "Authorization", "Bearer " + active);
        this.addEventListener("loadend", () => { if (this.status === 401) sessionRejected(); }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }

  function render() {
    if (!ui) return;
    // Public deployments require no access-code interface. While checking, no
    // form is shown until the server explicitly reports auth.required=true.
    ui.host.hidden = authRequired === false || connectionState === "checking";
    const canEnter = authRequired === true && accessConfigured && connectionState !== "connected";
    ui.form.hidden = !canEnter;
    ui.connected.hidden = connectionState !== "connected";
    ui.retry.hidden = connectionState !== "unavailable";
    ui.status.textContent = message;
    ui.submit.disabled = connecting;
    ui.input.disabled = connecting;
    ui.submit.textContent = connecting ? "Connecting…" : "Connect";
  }

  function mount() {
    const host = document.createElement("div");
    host.id = "hb-backend-connection";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:14px/1.4 system-ui,sans-serif;color:#25302e;max-width:min(330px,calc(100vw - 32px))}:host([hidden]){display:none}.card{padding:14px 16px;border:1px solid #ced8d1;border-radius:12px;background:#fffffaf5;box-shadow:0 4px 20px #162d2222}h2{font:600 15px/1.3 system-ui,sans-serif;margin:0 0 6px}p{margin:0 0 10px}label{display:block;margin-bottom:5px}input{box-sizing:border-box;width:100%;font:inherit;border:1px solid #9aaca4;border-radius:6px;padding:8px;background:white;color:#25302e}button{font:600 13px/1.3 system-ui,sans-serif;border:0;border-radius:6px;padding:9px 13px;background:#246553;color:white;cursor:pointer;margin-top:9px}button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible{outline:3px solid #eab767;outline-offset:2px}[hidden]{display:none!important}.subtle{background:#e7eee9;color:#25302e}";
    const card = document.createElement("section");
    card.className = "card";
    card.setAttribute("aria-label", "Connect Dr. Kaya");
    const title = document.createElement("h2"); title.textContent = "Connect Dr. Kaya";
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const form = document.createElement("form"); form.autocomplete = "off";
    const label = document.createElement("label"); label.textContent = "Classroom access code"; label.htmlFor = "hb-classroom-code";
    const input = document.createElement("input"); input.id = "hb-classroom-code"; input.type = "password"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 200; input.required = true;
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "Connect";
    form.append(label, input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = input.value;
      input.value = "";
      connect(code);
    });
    const connected = document.createElement("button"); connected.type = "button"; connected.className = "subtle"; connected.textContent = "Disconnect"; connected.addEventListener("click", () => clearSession());
    const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Check connection"; retry.addEventListener("click", () => refreshStatus());
    card.append(title, status, form, connected, retry);
    shadow.append(style, card);
    host.hidden = true;
    document.body.append(host);
    ui = { host, status, form, input, submit, connected, retry };
    render();
  }

  readStoredSession();
  window.HBBackend = Object.freeze({
    connect,
    disconnect: () => clearSession(),
    refreshStatus,
    get ready() { return ready(); },
    get status() { return connectionState; },
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
  refreshStatus();
})();
