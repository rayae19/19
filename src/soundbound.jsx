
import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";

/* ============================================================
   TYPES  (TypeScript interfaces expressed as JSDoc)
   ============================================================ */
/**
 * @typedef {{ id:string, title:string, artist:string, album?:string,
 *   duration?:number, artworkUrl?:string, streamUrl?:string, source?:string }} Track
 * @typedef {{ id:string, name:string, trackIds:string[], createdAt:number }} Playlist
 *
 * PluginManifest — internal normalised shape used for REST servers
 * @typedef {{ name:string, version:string, description?:string,
 *   baseUrl:string, sourceType:'rest'|'sb_extension',
 *   endpoints:{ search:string, stream:string, trending?:string } }} PluginManifest
 *
 * SbSourceEntry — one entry from a Soundbound sources.json array
 * Canonical Soundbound schema: { source_id, source_name, source_version_name, link }
 * Custom server schema (optional): { name, version, baseUrl, search, stream }
 * @typedef {{
 *   source_id?:string, source_name?:string, source_version_name?:string, link?:string,
 *   name?:string, version?:string, baseUrl?:string,
 *   search?:string, stream?:string, trending?:string,
 *   endpoints?:{ search:string, stream:string, trending?:string }
 * }} SbSourceEntry
 *
 * SavedRepo — what gets persisted to localStorage.
 * Two modes:
 *   REST plugin   → manifest is set, pendingSources is undefined
 *   Sources list  → pendingSources populated after fetch, manifest set after user picks one
 * @typedef {{
 *   url:string,
 *   manifest:PluginManifest|null,
 *   pendingSources?:SbSourceEntry[],
 *   activeSourceId?:string,
 *   repoListUrl?:string,
 *   addedAt:number
 * }} SavedRepo
 *
 * @typedef {'idle'|'loading'|'playing'|'paused'|'error'} PlayerStatus
 */

/* ============================================================
   CONSTANTS
   ============================================================ */
const LS = {
  REPOS: "sb_repos_v3",       // bumped: SavedRepo shape changed (pendingSources added)
  PLAYLISTS: "sb_playlists_v2",
  TRACKS_CACHE: "sb_tracks_cache_v2",
};

const ACCENT = "#00e5ff";
const ACCENT2 = "#ff3d6b";
const BG = "#080b10";
const SURFACE = "#0d1117";
const SURFACE2 = "#151b23";
const BORDER = "#1e2733";
const TEXT = "#e6edf3";
const MUTED = "#576882";

/* ============================================================
   SERVICES
   ============================================================ */

// ── storage.service ─────────────────────────────────────────
const StorageService = {
  getRepos() {
    try { return JSON.parse(localStorage.getItem(LS.REPOS) || "[]"); }
    catch { return []; }
  },
  saveRepo(repo) {
    const repos = this.getRepos().filter(r => r.url !== repo.url);
    localStorage.setItem(LS.REPOS, JSON.stringify([...repos, repo]));
  },
  removeRepo(url) {
    localStorage.setItem(LS.REPOS, JSON.stringify(this.getRepos().filter(r => r.url !== url)));
  },
  getPlaylists() {
    try { return JSON.parse(localStorage.getItem(LS.PLAYLISTS) || "[]"); }
    catch { return []; }
  },
  savePlaylists(pls) {
    localStorage.setItem(LS.PLAYLISTS, JSON.stringify(pls));
  },
  getCachedTracks() {
    try { return JSON.parse(localStorage.getItem(LS.TRACKS_CACHE) || "{}"); }
    catch { return {}; }
  },
  cacheTrack(track) {
    const cache = this.getCachedTracks();
    cache[track.id] = track;
    localStorage.setItem(LS.TRACKS_CACHE, JSON.stringify(cache));
  },
};

// ── plugin.service ───────────────────────────────────────────
/**
 * CORS-safe fetch with proxy fallback chain.
 *
 * Attempt order:
 *   1. Direct fetch              — works if the host sends CORS headers
 *   2. Own Render backend        — /api/repo-proxy?url= (set VITE_API_URL at build time)
 *   3. allorigins.win            — public proxy fallback
 *   4. corsproxy.io              — second public proxy fallback
 *
 * In local dev Vite forwards /api/* to localhost:3001 (see vite.config.js).
 * In production VITE_API_URL is set to the Render service URL.
 */

// Resolve the backend base URL once at module load.
// import.meta.env.VITE_API_URL is injected by Vite at build time.
// Falls back to empty string so the path stays relative ("/api/...") in dev.
const _API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) || "";

const CORS_PROXIES = [
  // ① Own backend (Render) — most reliable, no rate-limits
  (u) => `${_API_BASE}/api/repo-proxy?url=${encodeURIComponent(u)}`,
  // ② allorigins.win — wraps payload in { contents: "..." }
  (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
  // ③ corsproxy.io — transparent proxy
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

async function safeFetch(targetUrl) {
  // ── Attempt 1: direct ──────────────────────────────────────
  try {
    console.debug(`[PluginService] Direct fetch: ${targetUrl}`);
    const res = await fetch(targetUrl, { mode: "cors" });
    if (res.ok) {
      const text = await res.text();
      console.debug(`[PluginService] Direct fetch succeeded (${res.status})`);
      return { ok: true, status: res.status, text, usedProxy: null };
    }
    console.warn(`[PluginService] Direct fetch HTTP ${res.status} — will try proxies`);
  } catch (directErr) {
    // TypeError: Failed to fetch  →  CORS blocked or network error
    console.warn(`[PluginService] Direct fetch threw: ${directErr.message}`);
  }

  // ── Attempts 2–3: proxy chain ──────────────────────────────
  for (const makeProxy of CORS_PROXIES) {
    const proxyUrl = makeProxy(targetUrl);
    try {
      console.debug(`[PluginService] Proxy fetch: ${proxyUrl}`);
      const res = await fetch(proxyUrl);
      if (!res.ok) {
        console.warn(`[PluginService] Proxy ${proxyUrl} returned HTTP ${res.status}`);
        continue;
      }
      const raw = await res.text();
      // allorigins wraps payload in { contents: "..." }
      let text = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.contents === "string") text = parsed.contents;
      } catch { /* not allorigins format — use raw text */ }
      console.debug(`[PluginService] Proxy fetch succeeded via ${proxyUrl}`);
      return { ok: true, status: 200, text, usedProxy: proxyUrl };
    } catch (proxyErr) {
      console.warn(`[PluginService] Proxy ${proxyUrl} threw: ${proxyErr.message}`);
    }
  }

  throw new Error(
    `All fetch attempts failed for ${targetUrl}.\n` +
    `Possible causes:\n` +
    `  • The URL is unreachable or returns non-200\n` +
    `  • CORS is blocked and both proxy services are down\n` +
    `  • The host requires authentication\n` +
    `Check the browser console for per-attempt details.`
  );
}

/**
 * Detect whether a URL points directly to a JSON file
 * (e.g. GitLab raw, GitHub raw, any *.json path).
 */
function isDirectJsonUrl(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.endsWith(".json") || pathname.includes("/raw/");
  } catch { return false; }
}

/**
 * Validate that input is a reachable HTTPS/HTTP URL.
 * Returns null if valid, or an error string.
 */
function validateUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return "URL is empty";
  try {
    const { protocol } = new URL(trimmed);
    if (protocol !== "https:" && protocol !== "http:")
      return `URL must start with https:// or http:// (got "${protocol}")`;
    return null;
  } catch {
    return `"${trimmed}" is not a valid URL`;
  }
}

/**
 * Parse one SbSourceEntry into a display-friendly object for the picker UI.
 * Handles both the real Soundbound schema and custom server schemas.
 *
 * Real Soundbound (extensions-lib) schema:
 *   { source_id, source_name, source_version_name, link }
 *   — link is an APK download URL; there are no REST search/stream endpoints.
 *
 * Custom server schema (user's own plugin server):
 *   { name, version, baseUrl, search, stream } or { endpoints: { search, stream } }
 */
function parseSbSourceEntry(entry) {
  // Canonical Soundbound extension entry
  const id      = entry.source_id   ?? entry.id   ?? entry.name ?? "unknown";
  const name    = entry.source_name ?? entry.name  ?? id;
  const version = entry.source_version_name ?? entry.version ?? "?";
  const link    = entry.link ?? null;

  // REST endpoints — present in custom servers, absent in official Soundbound APK list
  const searchEndpoint = entry.endpoints?.search ?? entry.search ?? null;
  const streamEndpoint = entry.endpoints?.stream ?? entry.stream ?? null;
  const baseUrl        = entry.baseUrl ?? entry.base_url ?? (link ? new URL(link).origin : "");

  return { id, name, version, link, baseUrl, searchEndpoint, streamEndpoint,
           hasRestEndpoints: !!(searchEndpoint && streamEndpoint) };
}

/**
 * Convert a parsed SbSourceEntry into a PluginManifest.
 * Only valid for entries that have REST endpoints (custom servers).
 */
function sourceEntryToManifest(entry) {
  const parsed = parseSbSourceEntry(entry);
  return {
    name: parsed.name,
    version: parsed.version,
    description: parsed.link ? `APK: ${parsed.link}` : "",
    baseUrl: parsed.baseUrl,
    sourceType: "sb_extension",
    endpoints: {
      search: parsed.searchEndpoint ?? "",
      stream: parsed.streamEndpoint ?? "",
      trending: entry.endpoints?.trending ?? entry.trending ?? "",
    },
    _sourceId: parsed.id,
    _apkLink: parsed.link,
  };
}

const PluginService = {
  /**
   * Main entry point. Accepts three URL styles:
   *   A) Direct .json file URL  → fetches, parses; returns {_type:'sources_list'} or {_type:'manifest'}
   *   B) REST server base URL   → appends /manifest.json; returns {_type:'manifest'}
   *   C) Ambiguous              → tries REST first, falls back to direct JSON
   *
   * Callers must check result._type to decide what to do next:
   *   'manifest'     → ready to use as active plugin
   *   'sources_list' → show source picker UI, then call sourceEntryToManifest(selected)
   */
  async fetchManifest(inputUrl) {
    const urlError = validateUrl(inputUrl);
    if (urlError) throw new Error(`Invalid URL — ${urlError}`);

    const cleanUrl = inputUrl.trim().replace(/\/$/, "");
    const isDirect = isDirectJsonUrl(cleanUrl);

    console.info(`[PluginService] fetchManifest — mode: ${isDirect ? "direct-json" : "rest-server"}, url: ${cleanUrl}`);

    if (isDirect) {
      return this._fetchDirectJson(cleanUrl);
    }

    // Try REST manifest.json first; fall back to treating URL as a direct JSON file.
    try {
      return await this._fetchRestManifest(cleanUrl);
    } catch (restErr) {
      console.warn(`[PluginService] REST manifest failed (${restErr.message}), retrying as direct JSON`);
      return this._fetchDirectJson(cleanUrl);
    }
  },

  async _fetchDirectJson(url) {
    const { text } = await safeFetch(url);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Response from ${url} is not valid JSON: ${e.message}`);
    }

    // ── Array → Soundbound sources catalogue ─────────────────
    // Return a discriminated result so the caller can show the picker UI
    // instead of silently picking one entry.
    if (Array.isArray(data)) {
      if (data.length === 0) throw new Error("sources.json is an empty array — nothing to load");
      console.info(`[PluginService] Parsed as Soundbound sources list: ${data.length} entries`);
      data.forEach((e, i) => console.debug(`  [${i}]`, parseSbSourceEntry(e)));
      return { _type: "sources_list", sources: data, url };
    }

    // ── Single object → REST manifest ─────────────────────────
    return this._validateAndNormalise(data, url);
  },

  async _fetchRestManifest(baseUrl) {
    const manifestUrl = `${baseUrl}/manifest.json`;
    const { text } = await safeFetch(manifestUrl);
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(`manifest.json at ${manifestUrl} is not valid JSON: ${e.message}`); }
    return this._validateAndNormalise(data, manifestUrl);
  },

  _validateAndNormalise(raw, resolvedUrl) {
    const issues = [];
    if (!raw.name)                                       issues.push("missing .name");
    if (!raw.endpoints?.search && !raw.search)           issues.push("missing endpoints.search");
    if (!raw.endpoints?.stream && !raw.stream)           issues.push("missing endpoints.stream");
    if (issues.length) {
      console.error("[PluginService] Manifest validation failed:", issues, raw);
      throw new Error(
        `Manifest schema invalid — ${issues.join(", ")}.\n` +
        `Keys present: ${Object.keys(raw).join(", ")}\n\n` +
        `If this is a Soundbound sources list (an array), paste the direct .json file URL instead.`
      );
    }
    return {
      _type: "manifest",
      name: raw.name,
      version: raw.version ?? "1.0",
      description: raw.description ?? "",
      sourceType: "rest",
      baseUrl: raw.baseUrl ?? raw.base_url ?? new URL(resolvedUrl).origin,
      endpoints: {
        search: raw.endpoints?.search ?? raw.search,
        stream: raw.endpoints?.stream ?? raw.stream,
        trending: raw.endpoints?.trending ?? raw.trending ?? "",
      },
      _resolvedUrl: resolvedUrl,
    };
  },

  async search(manifest, query) {
    if (!manifest.endpoints?.search) {
      // Sources-list manifests have no search endpoint in our app — return empty.
      console.info("[PluginService] No search endpoint on manifest, skipping");
      return [];
    }
    const url = `${manifest.baseUrl}${manifest.endpoints.search}?q=${encodeURIComponent(query)}`;
    const { text } = await safeFetch(url);
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(`Search response is not valid JSON: ${e.message}`); }
    const tracks = data.tracks ?? data.results ?? (Array.isArray(data) ? data : []);
    return tracks.map(t => ({ ...t, source: manifest.name }));
  },

  async getStreamUrl(manifest, trackId) {
    if (!manifest.endpoints?.stream) throw new Error("This plugin has no stream endpoint");
    const url = `${manifest.baseUrl}${manifest.endpoints.stream}/${encodeURIComponent(trackId)}`;
    const { text } = await safeFetch(url);
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(`Stream response is not valid JSON: ${e.message}`); }
    const streamUrl = data.url ?? data.streamUrl ?? data.stream;
    if (!streamUrl) throw new Error("Stream endpoint returned no URL field");
    return streamUrl;
  },

  async getTrending(manifest) {
    if (!manifest.endpoints?.trending) return [];
    try {
      const url = `${manifest.baseUrl}${manifest.endpoints.trending}`;
      const { text } = await safeFetch(url);
      const data = JSON.parse(text);
      return (data.tracks ?? (Array.isArray(data) ? data : [])).map(t => ({ ...t, source: manifest.name }));
    } catch (e) {
      console.warn("[PluginService] getTrending failed silently:", e.message);
      return [];
    }
  },
};

// ── audio.service ────────────────────────────────────────────
class AudioService {
  constructor() {
    this._audio = new Audio();
    this._audio.crossOrigin = "anonymous";
    this._listeners = {};
  }
  on(evt, fn) {
    this._listeners[evt] = this._listeners[evt] || [];
    this._listeners[evt].push(fn);
    this._audio.addEventListener(evt, fn);
  }
  off(evt, fn) {
    this._audio.removeEventListener(evt, fn);
  }
  async load(url) {
    this._audio.src = url;
    this._audio.load();
  }
  async play() { await this._audio.play(); }
  pause() { this._audio.pause(); }
  seek(t) { this._audio.currentTime = t; }
  get currentTime() { return this._audio.currentTime; }
  get duration() { return this._audio.duration || 0; }
  get paused() { return this._audio.paused; }
  destroy() {
    this._audio.pause();
    this._audio.src = "";
  }
}

/* ============================================================
   CONTEXT
   ============================================================ */
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

/* ============================================================
   DEMO DATA  (shown when no plugin is connected)
   ============================================================ */
const DEMO_TRACKS = [
  { id:"demo_1", title:"Midnight Protocol", artist:"Axon Drive", album:"Neon Epoch", duration:214, source:"Demo" },
  { id:"demo_2", title:"Subterranean Signal", artist:"Void Circuit", album:"Static Bloom", duration:187, source:"Demo" },
  { id:"demo_3", title:"Glass Canyon", artist:"Pale Infrastructure", album:"Erosion", duration:253, source:"Demo" },
  { id:"demo_4", title:"Thermal Drift", artist:"Axon Drive", album:"Neon Epoch", duration:198, source:"Demo" },
  { id:"demo_5", title:"Spectral Residue", artist:"Korvid", album:"Half-Life", duration:231, source:"Demo" },
  { id:"demo_6", title:"False Horizon", artist:"Void Circuit", album:"Static Bloom", duration:175, source:"Demo" },
  { id:"demo_7", title:"Lattice Burn", artist:"Korvid", album:"Half-Life", duration:242, source:"Demo" },
  { id:"demo_8", title:"Residual Echo", artist:"Pale Infrastructure", album:"Erosion", duration:209, source:"Demo" },
];

/* ============================================================
   UTILITIES
   ============================================================ */
function fmtTime(s) {
  if (!s || isNaN(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  const hue = ((h % 360) + 360) % 360;
  return [`hsl(${hue},55%,18%)`, `hsl(${(hue + 40) % 360},70%,50%)`];
}

function uid() { return Math.random().toString(36).slice(2); }

/* ============================================================
   MICRO COMPONENTS
   ============================================================ */

function Avatar({ title, artist, size = 44 }) {
  const key = (title || "") + (artist || "");
  const [bg, accent] = hashColor(key);
  const letter = (title || "?")[0].toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.18, flexShrink: 0,
      background: bg, display: "flex", alignItems: "center", justifyContent: "center",
      border: `1px solid ${accent}33`,
      fontSize: size * 0.38, fontWeight: 700, color: accent,
      fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
      boxShadow: `0 0 12px ${accent}22`,
    }}>{letter}</div>
  );
}

function LiveBars() {
  return (
    <div style={{ display:"flex", alignItems:"flex-end", gap:2, height:16 }}>
      {[1,2,3,4].map(i => (
        <div key={i} style={{
          width:3, borderRadius:2, background: ACCENT,
          animation:`sbbar ${0.4 + i*0.12}s ease-in-out infinite alternate`,
          animationDelay:`${i*0.07}s`,
          boxShadow:`0 0 6px ${ACCENT}88`,
        }}/>
      ))}
    </div>
  );
}

function Pill({ children, active, onClick, color = ACCENT }) {
  return (
    <button onClick={onClick} style={{
      padding:"5px 13px", borderRadius:20, border:`1px solid ${active ? color : BORDER}`,
      background: active ? `${color}18` : "transparent",
      color: active ? color : MUTED, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif",
      letterSpacing:1, textTransform:"uppercase", cursor:"pointer", transition:"all .15s",
      whiteSpace:"nowrap",
    }}>{children}</button>
  );
}

function IconBtn({ children, onClick, style = {} }) {
  return (
    <button onClick={onClick} style={{
      background:"transparent", border:"none", cursor:"pointer",
      color: MUTED, display:"flex", alignItems:"center", justifyContent:"center",
      padding:6, borderRadius:8, transition:"color .15s", ...style,
    }}
    onMouseEnter={e => e.currentTarget.style.color = TEXT}
    onMouseLeave={e => e.currentTarget.style.color = MUTED}
    >{children}</button>
  );
}

function Spinner() {
  return <div style={{
    width:18, height:18, border:`2px solid ${BORDER}`, borderTopColor:ACCENT,
    borderRadius:"50%", animation:"sbspin .7s linear infinite", flexShrink:0,
  }}/>;
}

function ErrorBanner({ msg, onDismiss }) {
  if (!msg) return null;
  return (
    <div style={{
      background:`${ACCENT2}14`, border:`1px solid ${ACCENT2}44`, borderRadius:8,
      padding:"10px 14px", display:"flex", gap:10, alignItems:"center",
      fontFamily:"'Barlow Condensed',sans-serif", fontSize:13, color: ACCENT2,
    }}>
      <span style={{ flex:1 }}>⚠ {msg}</span>
      <button onClick={onDismiss} style={{ background:"none", border:"none", color:ACCENT2, cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>
    </div>
  );
}

/* ============================================================
   TRACK ROW
   ============================================================ */
function TrackRow({ track, isActive, onPlay, onAddToPlaylist, index }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display:"flex", alignItems:"center", gap:12, padding:"9px 12px",
        borderRadius:10, cursor:"pointer",
        background: isActive ? `${ACCENT}0c` : hover ? "#ffffff06" : "transparent",
        border: `1px solid ${isActive ? ACCENT+"33" : "transparent"}`,
        transition:"all .12s",
      }}
    >
      {/* Index / play indicator */}
      <div style={{ width:20, textAlign:"center", flexShrink:0 }}
        onClick={onPlay}>
        {isActive
          ? <LiveBars />
          : <span style={{ color: hover ? ACCENT : MUTED, fontSize:12, fontFamily:"'Barlow Condensed',sans-serif" }}>
              {hover ? "▶" : String(index + 1).padStart(2, "0")}
            </span>
        }
      </div>

      <Avatar title={track.title} artist={track.artist} size={40} />

      <div style={{ flex:1, minWidth:0 }} onClick={onPlay}>
        <div style={{
          color: isActive ? ACCENT : TEXT, fontSize:14, fontWeight:600,
          fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:.3,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{track.title}</div>
        <div style={{
          color: MUTED, fontSize:12, fontFamily:"'Barlow Condensed',sans-serif",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{track.artist}{track.album ? ` · ${track.album}` : ""}</div>
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
        <span style={{ color:MUTED, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif" }}>
          {fmtTime(track.duration)}
        </span>
        <IconBtn onClick={() => onAddToPlaylist && onAddToPlaylist(track)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </IconBtn>
      </div>
    </div>
  );
}

/* ============================================================
   ADD TO PLAYLIST MODAL
   ============================================================ */
function AddToPlaylistModal({ track, playlists, onAdd, onClose, onCreate }) {
  const [name, setName] = useState("");
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000, display:"flex", alignItems:"flex-end",
      background:"rgba(0,0,0,.7)", backdropFilter:"blur(6px)",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width:"100%", maxWidth:480, margin:"0 auto",
        background: SURFACE2, borderRadius:"16px 16px 0 0",
        border:`1px solid ${BORDER}`, padding:20,
      }}>
        <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, fontWeight:700, marginBottom:14 }}>
          Add "{track.title}" to playlist
        </div>
        {playlists.length === 0 && (
          <div style={{ color:MUTED, fontSize:13, fontFamily:"'Barlow Condensed',sans-serif", marginBottom:14 }}>
            No playlists yet. Create one below.
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:14, maxHeight:220, overflowY:"auto" }}>
          {playlists.map(pl => (
            <button key={pl.id} onClick={() => onAdd(pl.id)} style={{
              background: SURFACE, border:`1px solid ${BORDER}`, borderRadius:8,
              padding:"10px 14px", color:TEXT, textAlign:"left", cursor:"pointer",
              fontFamily:"'Barlow Condensed',sans-serif", fontSize:14,
              display:"flex", justifyContent:"space-between",
            }}>
              <span>{pl.name}</span>
              <span style={{ color:MUTED, fontSize:12 }}>{pl.trackIds.length} tracks</span>
            </button>
          ))}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <input
            value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && name.trim() && onCreate(name.trim())}
            placeholder="New playlist name…"
            style={{
              flex:1, background:SURFACE, border:`1px solid ${BORDER}`, borderRadius:8,
              padding:"9px 12px", color:TEXT, fontSize:13,
              fontFamily:"'Barlow Condensed',sans-serif", outline:"none",
            }}
          />
          <button onClick={() => name.trim() && onCreate(name.trim())} style={{
            background: ACCENT, border:"none", borderRadius:8, padding:"9px 16px",
            color:"#000", fontWeight:700, cursor:"pointer", fontSize:13,
            fontFamily:"'Barlow Condensed',sans-serif",
          }}>Create</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   SEARCH PAGE
   ============================================================ */
function SearchPage() {
  const { repos, nowPlaying, playTrack, playlists, addTrackToPlaylist, createPlaylist } = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(DEMO_TRACKS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [addModal, setAddModal] = useState(null); // track
  const [filter, setFilter] = useState("all");
  const inputRef = useRef();

  const manifests = repos.map(r => r.manifest);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) { setResults(DEMO_TRACKS); return; }
    setLoading(true); setError(null);
    try {
      if (manifests.length === 0) {
        const q_lower = q.toLowerCase();
        setResults(DEMO_TRACKS.filter(t =>
          t.title.toLowerCase().includes(q_lower) ||
          t.artist.toLowerCase().includes(q_lower)
        ));
        return;
      }
      const all = await Promise.allSettled(manifests.map(m => PluginService.search(m, q)));
      const tracks = all.flatMap(r => r.status === "fulfilled" ? r.value : []);
      const failed = all.filter(r => r.status === "rejected");
      if (failed.length) setError(`${failed.length} plugin(s) failed to respond`);
      setResults(tracks);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [manifests]);

  const handleKey = e => { if (e.key === "Enter") doSearch(query); };

  const sources = ["all", ...new Set(results.map(t => t.source || "Unknown"))];
  const filtered = filter === "all" ? results : results.filter(t => t.source === filter);

  return (
    <div style={{ padding:"0 0 140px" }}>
      {/* Search bar */}
      <div style={{ padding:"16px 16px 12px", position:"sticky", top:0, zIndex:10, background:`${BG}ee`, backdropFilter:"blur(12px)" }}>
        <div style={{ display:"flex", gap:8 }}>
          <div style={{
            flex:1, display:"flex", alignItems:"center", gap:10,
            background:SURFACE2, border:`1px solid ${BORDER}`, borderRadius:12,
            padding:"10px 14px",
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              ref={inputRef}
              value={query} onChange={e => setQuery(e.target.value)} onKeyDown={handleKey}
              placeholder="Search tracks, artists…"
              style={{
                flex:1, background:"transparent", border:"none", outline:"none",
                color:TEXT, fontSize:14, fontFamily:"'Barlow Condensed',sans-serif",
              }}
            />
            {query && <button onClick={() => { setQuery(""); setResults(DEMO_TRACKS); }}
              style={{ background:"none", border:"none", color:MUTED, cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>}
          </div>
          <button onClick={() => doSearch(query)} disabled={loading} style={{
            background:`linear-gradient(135deg, ${ACCENT}, #00b8d9)`,
            border:"none", borderRadius:12, padding:"10px 18px",
            color:"#000", fontWeight:700, cursor:"pointer", fontSize:13,
            fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:1, opacity: loading ? .6 : 1,
          }}>
            {loading ? <Spinner/> : "GO"}
          </button>
        </div>

        {/* Source pills */}
        {sources.length > 1 && (
          <div style={{ display:"flex", gap:6, marginTop:10, overflowX:"auto", paddingBottom:2 }}>
            {sources.map(s => <Pill key={s} active={filter === s} onClick={() => setFilter(s)}>{s}</Pill>)}
          </div>
        )}
      </div>

      <div style={{ padding:"0 16px" }}>
        <ErrorBanner msg={error} onDismiss={() => setError(null)} />

        {manifests.length === 0 && (
          <div style={{
            margin:"8px 0 12px", padding:"10px 14px", background:`${ACCENT}0a`,
            border:`1px solid ${ACCENT}22`, borderRadius:8,
            color:MUTED, fontSize:12, fontFamily:"'Barlow Condensed',sans-serif",
          }}>
            ↗ No plugins connected — demo data shown. Add a repo in the <b style={{color:TEXT}}>Plugins</b> tab.
          </div>
        )}

        <div style={{ marginTop:8 }}>
          {filtered.map((track, i) => (
            <TrackRow
              key={track.id} track={track} index={i}
              isActive={nowPlaying?.id === track.id}
              onPlay={() => playTrack(track, filtered)}
              onAddToPlaylist={() => setAddModal(track)}
            />
          ))}
          {filtered.length === 0 && !loading && (
            <div style={{ textAlign:"center", padding:"48px 0", color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:14 }}>
              No results
            </div>
          )}
        </div>
      </div>

      {addModal && (
        <AddToPlaylistModal
          track={addModal}
          playlists={playlists}
          onClose={() => setAddModal(null)}
          onAdd={plId => { addTrackToPlaylist(plId, addModal); setAddModal(null); }}
          onCreate={name => { const id = createPlaylist(name); addTrackToPlaylist(id, addModal); setAddModal(null); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   PLAYLISTS PAGE
   ============================================================ */
function PlaylistsPage() {
  const { playlists, createPlaylist, deletePlaylist, removeTrackFromPlaylist, nowPlaying, playTrack, tracksCache } = useApp();
  const [openId, setOpenId] = useState(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createPlaylist(newName.trim());
    setNewName(""); setCreating(false);
  };

  return (
    <div style={{ padding:"16px 16px 140px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <h2 style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:700, letterSpacing:.5, margin:0 }}>
          YOUR PLAYLISTS
        </h2>
        <button onClick={() => setCreating(c => !c)} style={{
          background: creating ? `${ACCENT2}22` : `${ACCENT}22`,
          border:`1px solid ${creating ? ACCENT2 : ACCENT}44`,
          borderRadius:8, padding:"6px 14px", color: creating ? ACCENT2 : ACCENT,
          fontFamily:"'Barlow Condensed',sans-serif", fontSize:12, letterSpacing:1,
          cursor:"pointer", textTransform:"uppercase",
        }}>{creating ? "Cancel" : "+ New"}</button>
      </div>

      {creating && (
        <div style={{ display:"flex", gap:8, marginBottom:14 }}>
          <input
            autoFocus value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            placeholder="Playlist name…"
            style={{
              flex:1, background:SURFACE2, border:`1px solid ${BORDER}`, borderRadius:10,
              padding:"10px 14px", color:TEXT, fontSize:14,
              fontFamily:"'Barlow Condensed',sans-serif", outline:"none",
            }}
          />
          <button onClick={handleCreate} style={{
            background:ACCENT, border:"none", borderRadius:10, padding:"10px 18px",
            color:"#000", fontWeight:700, cursor:"pointer", fontFamily:"'Barlow Condensed',sans-serif", fontSize:13,
          }}>Create</button>
        </div>
      )}

      {playlists.length === 0 && (
        <div style={{ textAlign:"center", padding:"56px 0", color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:14 }}>
          No playlists yet — create one to get started.
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {playlists.map(pl => {
          const tracks = pl.trackIds.map(id => tracksCache[id]).filter(Boolean);
          const isOpen = openId === pl.id;
          return (
            <div key={pl.id} style={{
              background:SURFACE, border:`1px solid ${BORDER}`, borderRadius:12, overflow:"hidden",
            }}>
              {/* Header */}
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 14px", cursor:"pointer" }}
                onClick={() => setOpenId(isOpen ? null : pl.id)}>
                {/* Mosaic icon */}
                <div style={{
                  width:44, height:44, borderRadius:8, flexShrink:0, overflow:"hidden",
                  background:`linear-gradient(135deg, ${SURFACE2}, ${BORDER})`,
                  display:"grid", gridTemplateColumns:"1fr 1fr",
                }}>
                  {tracks.slice(0,4).map((t,i) => {
                    const [bg] = hashColor(t.title + t.artist);
                    return <div key={i} style={{ background:bg }}/>;
                  })}
                  {tracks.length === 0 && (
                    <div style={{ gridColumn:"span 2", gridRow:"span 2", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="1.5">
                        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                      </svg>
                    </div>
                  )}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:15 }}>{pl.name}</div>
                  <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:12 }}>{pl.trackIds.length} tracks</div>
                </div>
                <div style={{ display:"flex", gap:4 }}>
                  {tracks.length > 0 && (
                    <IconBtn onClick={e => { e.stopPropagation(); playTrack(tracks[0], tracks); }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill={ACCENT}><polygon points="5,3 19,12 5,21"/></svg>
                    </IconBtn>
                  )}
                  <IconBtn onClick={e => { e.stopPropagation(); deletePlaylist(pl.id); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3,6 5,6 21,6"/><path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"/>
                    </svg>
                  </IconBtn>
                  <span style={{ color:MUTED, fontSize:18, alignSelf:"center", transition:"transform .2s",
                    transform: isOpen ? "rotate(90deg)" : "none", display:"inline-block" }}>›</span>
                </div>
              </div>

              {/* Track list */}
              {isOpen && (
                <div style={{ borderTop:`1px solid ${BORDER}`, padding:"8px 0" }}>
                  {tracks.length === 0 && (
                    <div style={{ padding:"12px 20px", color:MUTED, fontSize:13, fontFamily:"'Barlow Condensed',sans-serif" }}>
                      No tracks — search and add tracks to this playlist.
                    </div>
                  )}
                  {tracks.map((track, i) => (
                    <div key={track.id} style={{ display:"flex", alignItems:"center", paddingRight:8 }}>
                      <div style={{ flex:1 }}>
                        <TrackRow
                          track={track} index={i}
                          isActive={nowPlaying?.id === track.id}
                          onPlay={() => playTrack(track, tracks)}
                        />
                      </div>
                      <IconBtn onClick={() => removeTrackFromPlaylist(pl.id, track.id)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </IconBtn>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   SOURCE PICKER MODAL
   Shown when a sources.json array is fetched.
   Each row: name, version, APK/REST badge, select button.
   ============================================================ */
function SourcePickerModal({ sources, repoUrl, onSelect, onCancel }) {
  const parsed = sources.map(parseSbSourceEntry);

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:2000,
      background:"rgba(0,0,0,.82)", backdropFilter:"blur(8px)",
      display:"flex", alignItems:"flex-end",
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        width:"100%", maxWidth:480, margin:"0 auto",
        background:SURFACE2, borderRadius:"18px 18px 0 0",
        border:`1px solid ${BORDER}`, borderBottom:"none",
        maxHeight:"80vh", display:"flex", flexDirection:"column",
      }}>
        {/* Header */}
        <div style={{ padding:"18px 18px 12px", borderBottom:`1px solid ${BORDER}`, flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:17, letterSpacing:.5 }}>
                SELECT A SOURCE
              </div>
              <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:12, marginTop:3 }}>
                {parsed.length} sources found · choose one to activate
              </div>
            </div>
            <button onClick={onCancel} style={{ background:"transparent", border:"none", color:MUTED, cursor:"pointer", fontSize:22, lineHeight:1, padding:"0 0 0 12px" }}>×</button>
          </div>
          {/* URL badge */}
          <div style={{
            marginTop:10, padding:"6px 10px", background:SURFACE, borderRadius:7,
            color:MUTED, fontSize:10, fontFamily:"'Barlow Condensed',sans-serif",
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
          }}>{repoUrl}</div>
        </div>

        {/* Source list */}
        <div style={{ overflowY:"auto", padding:"8px 0 16px" }}>
          {parsed.map((src, i) => (
            <div key={src.id} style={{
              display:"flex", alignItems:"center", gap:12, padding:"11px 18px",
              borderBottom: i < parsed.length - 1 ? `1px solid ${BORDER}44` : "none",
            }}>
              {/* Icon */}
              <div style={{
                width:40, height:40, borderRadius:10, flexShrink:0,
                background: src.hasRestEndpoints ? `${ACCENT}14` : `${ACCENT2}14`,
                border:`1px solid ${src.hasRestEndpoints ? ACCENT : ACCENT2}33`,
                display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                {src.hasRestEndpoints
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={ACCENT2} strokeWidth="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                }
              </div>

              {/* Info */}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:14, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  {src.name}
                  <span style={{ color:MUTED, fontWeight:400, fontSize:11 }}>v{src.version}</span>
                  <span style={{
                    fontSize:9, padding:"1px 6px", borderRadius:10, letterSpacing:.5,
                    background: src.hasRestEndpoints ? `${ACCENT}14` : `${ACCENT2}14`,
                    border:`1px solid ${src.hasRestEndpoints ? ACCENT : ACCENT2}33`,
                    color: src.hasRestEndpoints ? ACCENT : ACCENT2,
                  }}>
                    {src.hasRestEndpoints ? "REST" : "APK"}
                  </span>
                </div>
                <div style={{ color:MUTED, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {src.hasRestEndpoints
                    ? `${src.baseUrl}${src.searchEndpoint}`
                    : (src.link ?? src.id)
                  }
                </div>
              </div>

              {/* Select */}
              <button onClick={() => onSelect(sources[i])} style={{
                background: src.hasRestEndpoints
                  ? `linear-gradient(135deg, ${ACCENT}, #00b8d9)`
                  : SURFACE,
                border:`1px solid ${src.hasRestEndpoints ? "transparent" : BORDER}`,
                borderRadius:8, padding:"7px 14px", flexShrink:0,
                color: src.hasRestEndpoints ? "#000" : MUTED,
                fontWeight:700, cursor:"pointer", fontSize:12,
                fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:.5,
              }}>
                {src.hasRestEndpoints ? "USE" : "SAVE"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   PLUGINS PAGE
   ============================================================ */
function PluginsPage() {
  const { repos, addRepo, removeRepo, updateRepo } = useApp();

  // Input state
  const [url, setUrl]         = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [success, setSuccess] = useState(null);

  // Picker state — shown when fetch returns a sources array
  const [picker, setPicker]   = useState(null); // { sources, repoUrl }

  const urlValidationMsg = url.trim() ? validateUrl(url) : null;

  // ── Step 1: fetch the URL ─────────────────────────────────
  const handleFetch = async () => {
    const trimmed = url.trim();
    const preCheck = validateUrl(trimmed);
    if (preCheck) { setError(preCheck); return; }

    setLoading(true); setError(null); setSuccess(null); setPicker(null);
    try {
      const result = await PluginService.fetchManifest(trimmed);

      if (result._type === "sources_list") {
        // Show picker — do NOT save yet
        setPicker({ sources: result.sources, repoUrl: trimmed });
        setUrl("");
      } else {
        // Direct REST manifest — save immediately
        addRepo({ url: trimmed, manifest: result, pendingSources: undefined,
                  activeSourceId: undefined, addedAt: Date.now() });
        setSuccess(`✓ Plugin "${result.name}" v${result.version} connected`);
        setUrl("");
      }
    } catch (e) {
      console.error("[PluginsPage] fetchManifest error:", e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: user picks a source from the list ─────────────
  const handleSelectSource = (entry) => {
    const parsed  = parseSbSourceEntry(entry);
    const manifest = sourceEntryToManifest(entry);

    // Save as a repo. If no REST endpoints, manifest.endpoints are empty strings —
    // the repo is saved for reference (APK sources don't have web search/stream).
    addRepo({
      url: picker.repoUrl,
      manifest,
      pendingSources: picker.sources,    // keep full list for display
      activeSourceId: parsed.id,
      repoListUrl: picker.repoUrl,
      addedAt: Date.now(),
    });

    const note = parsed.hasRestEndpoints
      ? `✓ "${parsed.name}" connected as active plugin`
      : `✓ "${parsed.name}" saved (APK extension — no web search endpoint)`;
    setSuccess(note);
    setPicker(null);
  };

  return (
    <div style={{ padding:"16px 16px 140px" }}>
      <h2 style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:700, letterSpacing:.5, margin:"0 0 4px" }}>
        PLUGIN SOURCES
      </h2>
      <p style={{ color:MUTED, fontSize:13, fontFamily:"'Barlow Condensed',sans-serif", margin:"0 0 20px", lineHeight:1.5 }}>
        Paste a repo URL or a direct <code style={{ color:ACCENT, background:`${ACCENT}12`, padding:"1px 5px", borderRadius:4 }}>.json</code> file.
        Supports GitLab/GitHub raw links and Soundbound sources arrays.
      </p>

      {/* ── URL input card ─────────────────────────────────── */}
      <div style={{ background:SURFACE2, border:`1px solid ${BORDER}`, borderRadius:12, padding:16, marginBottom:16 }}>
        <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:12, fontWeight:700, marginBottom:10, letterSpacing:1 }}>
          ADD REPOSITORY URL
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ position:"relative" }}>
            <input
              value={url}
              onChange={e => { setUrl(e.target.value); setError(null); setSuccess(null); }}
              onKeyDown={e => e.key === "Enter" && !loading && !urlValidationMsg && handleFetch()}
              placeholder="https://gitlab.com/…/sources.json"
              spellCheck={false}
              autoCapitalize="none"
              style={{
                background:SURFACE, borderRadius:9, padding:"11px 38px 11px 14px",
                color:TEXT, fontSize:13, fontFamily:"'Barlow Condensed',sans-serif",
                outline:"none", width:"100%", boxSizing:"border-box", transition:"border-color .15s",
                border:`1px solid ${urlValidationMsg ? ACCENT2 : url.trim() ? `${ACCENT}55` : BORDER}`,
              }}
            />
            {url.trim() && (
              <button onClick={() => { setUrl(""); setError(null); setSuccess(null); }} style={{
                position:"absolute", right:10, top:"50%", transform:"translateY(-50%)",
                background:"transparent", border:"none", color:MUTED, cursor:"pointer", fontSize:16, lineHeight:1,
              }}>×</button>
            )}
          </div>

          <button
            onClick={handleFetch}
            disabled={loading || !!urlValidationMsg || !url.trim()}
            style={{
              borderRadius:9, padding:"11px",
              fontWeight:700, fontSize:14, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:1,
              display:"flex", alignItems:"center", justifyContent:"center", gap:8,
              transition:"all .15s", border:"1px solid transparent", cursor:"pointer",
              background: (loading || !!urlValidationMsg || !url.trim())
                ? SURFACE : `linear-gradient(135deg, ${ACCENT}, #00b8d9)`,
              color: (loading || !!urlValidationMsg || !url.trim()) ? MUTED : "#000",
              borderColor: (loading || !!urlValidationMsg || !url.trim()) ? BORDER : "transparent",
            }}
          >
            {loading ? <><Spinner/> FETCHING…</> : "LOAD SOURCES"}
          </button>
        </div>

        {loading && (
          <div style={{ marginTop:10, color:MUTED, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif", lineHeight:1.7 }}>
            Trying direct → allorigins.win → corsproxy.io…
          </div>
        )}

        {/* Error — full text verbatim */}
        {error && (
          <div style={{ marginTop:12, padding:"11px 13px", background:`${ACCENT2}0e`, border:`1px solid ${ACCENT2}44`, borderRadius:9 }}>
            <div style={{ color:ACCENT2, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, marginBottom:5, letterSpacing:1 }}>
              FETCH FAILED
            </div>
            <pre style={{
              color:"#fca5a5", fontSize:11, fontFamily:"'Courier New',monospace",
              margin:0, whiteSpace:"pre-wrap", wordBreak:"break-word", lineHeight:1.6,
            }}>{error}</pre>
            <div style={{ marginTop:8, color:MUTED, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif" }}>
              See browser console (F12) for per-attempt logs.
            </div>
          </div>
        )}

        {success && (
          <div style={{ marginTop:12, padding:"10px 13px", background:"#00e67610", border:"1px solid #00e67644", borderRadius:9, color:"#00e676", fontSize:13, fontFamily:"'Barlow Condensed',sans-serif" }}>
            {success}
          </div>
        )}
      </div>

      {/* ── Local dev note ─────────────────────────────────── */}
      <div style={{ background:`${ACCENT}08`, border:`1px solid ${ACCENT}1a`, borderRadius:10, padding:"12px 14px", marginBottom:20 }}>
        <div style={{ color:ACCENT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, fontWeight:700, letterSpacing:1, marginBottom:6 }}>
          LOCAL DEV (npm run dev)
        </div>
        <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:12, lineHeight:1.6 }}>
          Browser blocks cross-origin requests to external URLs. To test locally, add a Vite proxy in <code style={{ color:ACCENT }}>vite.config.ts</code>:
        </div>
        <pre style={{ color:"#7ec8e3", fontSize:11, fontFamily:"'Courier New',monospace", margin:"8px 0 0", background:"#000", padding:10, borderRadius:7, overflowX:"auto", lineHeight:1.7 }}>{`// vite.config.ts
server: {
  proxy: {
    "/plugin-proxy": {
      target: "https://gitlab.com",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\\/plugin-proxy/, ""),
    },
  },
}`}</pre>
        <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:12, marginTop:6 }}>
          Then use <code style={{ color:ACCENT }}>/plugin-proxy/shabinder/…</code> as the URL. In production, the CORS proxy chain handles it automatically.
        </div>
      </div>

      {/* ── Connected plugins ──────────────────────────────── */}
      <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, letterSpacing:2, marginBottom:10 }}>
        CONNECTED PLUGINS ({repos.length})
      </div>

      {repos.length === 0 && (
        <div style={{ textAlign:"center", padding:"32px 0", color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:13 }}>
          No plugins connected
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {repos.map((repo, i) => {
          const m       = repo.manifest;
          const isApk   = m?.sourceType === "sb_extension" && !m.endpoints?.search;
          const hasSources = repo.pendingSources?.length > 0;
          const [expanded, setExpanded] = useState(false);

          return (
            <div key={i} style={{ background:SURFACE, border:`1px solid ${BORDER}`, borderRadius:10, overflow:"hidden" }}>
              {/* Main row */}
              <div style={{ display:"flex", gap:12, alignItems:"center", padding:"13px 14px" }}>
                <div style={{
                  width:38, height:38, borderRadius:9, flexShrink:0,
                  background: isApk ? `${ACCENT2}14` : `${ACCENT}14`,
                  border:`1px solid ${isApk ? ACCENT2 : ACCENT}2a`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                }}>
                  {isApk
                    ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ACCENT2} strokeWidth="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                    : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></svg>
                  }
                </div>

                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:14, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    {m?.name || "Unknown"}
                    {m?.version && <span style={{ color:MUTED, fontWeight:400, fontSize:11 }}>v{m.version}</span>}
                    <span style={{
                      fontSize:9, padding:"1px 6px", borderRadius:10, letterSpacing:.5,
                      background: isApk ? `${ACCENT2}14` : `${ACCENT}14`,
                      border:`1px solid ${isApk ? ACCENT2 : ACCENT}2a`,
                      color: isApk ? ACCENT2 : ACCENT,
                    }}>{isApk ? "APK" : "REST"}</span>
                  </div>
                  <div style={{ color:MUTED, fontSize:11, fontFamily:"'Barlow Condensed',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginTop:1 }}>
                    {repo.url}
                  </div>
                  {repo.activeSourceId && (
                    <div style={{ color:MUTED, fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", marginTop:1 }}>
                      Active source: <span style={{ color: ACCENT }}>{repo.activeSourceId}</span>
                    </div>
                  )}
                </div>

                <div style={{ display:"flex", gap:6, flexShrink:0, alignItems:"center" }}>
                  {hasSources && (
                    <button onClick={() => setExpanded(x => !x)} style={{
                      background:`${ACCENT}14`, border:`1px solid ${ACCENT}2a`, borderRadius:7,
                      padding:"4px 10px", color:ACCENT, cursor:"pointer", fontSize:11,
                      fontFamily:"'Barlow Condensed',sans-serif",
                    }}>{expanded ? "HIDE" : `${repo.pendingSources.length} SRCS`}</button>
                  )}
                  <button onClick={() => removeRepo(repo.url)} style={{
                    background:"transparent", border:`1px solid ${BORDER}`, borderRadius:7,
                    padding:"5px 10px", color:ACCENT2, cursor:"pointer", fontSize:11,
                    fontFamily:"'Barlow Condensed',sans-serif",
                  }}>✕</button>
                </div>
              </div>

              {/* Expandable source list */}
              {expanded && hasSources && (
                <div style={{ borderTop:`1px solid ${BORDER}`, padding:"4px 0 8px" }}>
                  {repo.pendingSources.map((entry, j) => {
                    const s = parseSbSourceEntry(entry);
                    const isActive = s.id === repo.activeSourceId;
                    return (
                      <div key={j} style={{
                        display:"flex", alignItems:"center", gap:10, padding:"8px 14px",
                        background: isActive ? `${ACCENT}08` : "transparent",
                      }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ color: isActive ? ACCENT : TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:13, fontWeight: isActive ? 700 : 400 }}>
                            {s.name} <span style={{ color:MUTED, fontSize:11 }}>v{s.version}</span>
                            {isActive && <span style={{ color:ACCENT, fontSize:10, marginLeft:6 }}>● ACTIVE</span>}
                          </div>
                          <div style={{ color:MUTED, fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {s.hasRestEndpoints ? `${s.baseUrl}${s.searchEndpoint}` : (s.link ?? s.id)}
                          </div>
                        </div>
                        {!isActive && (
                          <button onClick={() => {
                            updateRepo(repo.url, {
                              manifest: sourceEntryToManifest(entry),
                              activeSourceId: s.id,
                            });
                          }} style={{
                            background: s.hasRestEndpoints ? `linear-gradient(135deg,${ACCENT},#00b8d9)` : SURFACE,
                            border:`1px solid ${s.hasRestEndpoints ? "transparent" : BORDER}`,
                            borderRadius:7, padding:"5px 11px", flexShrink:0,
                            color: s.hasRestEndpoints ? "#000" : MUTED,
                            fontWeight:700, cursor:"pointer", fontSize:11,
                            fontFamily:"'Barlow Condensed',sans-serif",
                          }}>USE</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Spec reference ─────────────────────────────────── */}
      <div style={{ marginTop:28, background:SURFACE, border:`1px solid ${BORDER}`, borderRadius:10, padding:16 }}>
        <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, letterSpacing:2, marginBottom:10 }}>SUPPORTED FORMATS</div>
        <pre style={{ color:"#7ec8e3", fontSize:11, fontFamily:"'Courier New',monospace", margin:0, lineHeight:1.8, overflowX:"auto", background:"#000", padding:12, borderRadius:8 }}>{`// ① REST manifest — GET /manifest.json
{ "name":"…", "version":"1.0", "endpoints":{ "search":"/search", "stream":"/stream" } }

// ② Soundbound sources array (GitLab/GitHub raw .json URL)
//    Official schema (APK extensions — no web search/stream):
[{ "source_id":"…", "source_name":"…", "source_version_name":"0.2.1", "link":"….apk" }]

//    Custom server schema (REST extensions):
[{ "name":"…", "version":"1.0", "baseUrl":"https://…", "search":"/search", "stream":"/stream" }]`}</pre>
      </div>

      {/* Picker modal */}
      {picker && (
        <SourcePickerModal
          sources={picker.sources}
          repoUrl={picker.repoUrl}
          onSelect={handleSelectSource}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/* ============================================================
   NOW PLAYING MINI PLAYER
   ============================================================ */
function MiniPlayer({ audio }) {
  const { nowPlaying, playerStatus, togglePlay, queue, queueIndex, playTrack } = useApp();
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const rafRef = useRef();

  useEffect(() => {
    if (!audio) return;
    const onMeta = () => setDuration(audio.duration);
    const onEnd = () => {};
    audio.on("loadedmetadata", onMeta);
    audio.on("durationchange", onMeta);

    const tick = () => {
      setProgress(audio.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      audio.off("loadedmetadata", onMeta);
      audio.off("durationchange", onMeta);
    };
  }, [audio]);

  if (!nowPlaying) return null;

  const pct = duration > 0 ? Math.min((progress / duration) * 100, 100) : 0;
  const isPlaying = playerStatus === "playing";
  const isLoading = playerStatus === "loading";
  const [bg] = hashColor(nowPlaying.title + nowPlaying.artist);

  const skipNext = () => {
    if (queue.length && queueIndex < queue.length - 1) playTrack(queue[queueIndex + 1], queue, queueIndex + 1);
  };
  const skipPrev = () => {
    if (audio.currentTime > 3) { audio.seek(0); return; }
    if (queueIndex > 0) playTrack(queue[queueIndex - 1], queue, queueIndex - 1);
  };

  return (
    <>
      {/* Expanded sheet */}
      {expanded && (
        <div style={{
          position:"fixed", inset:0, zIndex:900, display:"flex", flexDirection:"column",
          background:`radial-gradient(ellipse at top, ${bg}88 0%, ${BG} 55%)`,
          backdropFilter:"blur(30px)", padding:"40px 24px 180px",
          alignItems:"center", animation:"sbfadein .2s ease",
        }}>
          <button onClick={() => setExpanded(false)} style={{
            alignSelf:"flex-end", background:"transparent", border:"none", color:MUTED, cursor:"pointer", fontSize:28,
          }}>‹</button>

          <Avatar title={nowPlaying.title} artist={nowPlaying.artist} size={200} />

          <div style={{ marginTop:28, textAlign:"center", width:"100%" }}>
            <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, fontWeight:800, letterSpacing:.5 }}>
              {nowPlaying.title}
            </div>
            <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, marginTop:4 }}>
              {nowPlaying.artist}{nowPlaying.album ? ` — ${nowPlaying.album}` : ""}
            </div>
          </div>

          {/* Big progress bar */}
          <div style={{ width:"100%", marginTop:32 }}>
            <div style={{ height:4, background:BORDER, borderRadius:2, cursor:"pointer" }}
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                audio.seek(((e.clientX - rect.left) / rect.width) * duration);
              }}>
              <div style={{
                height:"100%", width:`${pct}%`, borderRadius:2,
                background:`linear-gradient(90deg, ${ACCENT}, #00b8d9)`,
                boxShadow:`0 0 8px ${ACCENT}88`, transition:"width .1s linear",
              }}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:6, color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:12 }}>
              <span>{fmtTime(progress)}</span><span>{fmtTime(duration)}</span>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display:"flex", alignItems:"center", gap:24, marginTop:28 }}>
            <IconBtn onClick={skipPrev} style={{ color:TEXT }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="19,20 9,12 19,4"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" strokeWidth="2"/></svg>
            </IconBtn>
            <button onClick={togglePlay} style={{
              width:62, height:62, borderRadius:"50%",
              background:`linear-gradient(135deg, ${ACCENT}, #00b8d9)`,
              border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
              boxShadow:`0 0 24px ${ACCENT}66`,
            }}>
              {isLoading ? <Spinner/> : isPlaying
                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="#000"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                : <svg width="20" height="20" viewBox="0 0 24 24" fill="#000"><polygon points="5,3 19,12 5,21"/></svg>
              }
            </button>
            <IconBtn onClick={skipNext} style={{ color:TEXT }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,4 15,12 5,20"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2"/></svg>
            </IconBtn>
          </div>

          {nowPlaying.source && (
            <div style={{ marginTop:20, color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, letterSpacing:2 }}>
              via {nowPlaying.source.toUpperCase()}
            </div>
          )}
        </div>
      )}

      {/* Mini bar */}
      <div style={{
        position:"fixed", bottom:56, left:0, right:0, zIndex:800,
        padding:"0 10px",
      }}>
        <div style={{
          maxWidth:480, margin:"0 auto",
          background:`${SURFACE2}f0`, backdropFilter:"blur(20px)",
          border:`1px solid ${BORDER}`,
          borderRadius:14, overflow:"hidden",
          boxShadow:`0 -2px 32px rgba(0,229,255,.07)`,
        }}>
          {/* Thin progress */}
          <div style={{ height:2, background:BORDER }}>
            <div style={{
              height:"100%", width:`${pct}%`, transition:"width .1s linear",
              background:`linear-gradient(90deg,${ACCENT},#00b8d9)`,
              boxShadow:`0 0 6px ${ACCENT}`,
            }}/>
          </div>

          <div style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px" }}
            onClick={() => setExpanded(true)}>
            <Avatar title={nowPlaying.title} artist={nowPlaying.artist} size={38} />
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:TEXT, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {nowPlaying.title}
              </div>
              <div style={{ color:MUTED, fontFamily:"'Barlow Condensed',sans-serif", fontSize:11 }}>{nowPlaying.artist}</div>
            </div>
            <div style={{ display:"flex", gap:4 }} onClick={e => e.stopPropagation()}>
              <IconBtn onClick={skipPrev}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={TEXT}><polygon points="19,20 9,12 19,4"/><line x1="5" y1="19" x2="5" y2="5" stroke={TEXT} strokeWidth="2"/></svg>
              </IconBtn>
              <button onClick={togglePlay} style={{
                width:34, height:34, borderRadius:"50%",
                background:`linear-gradient(135deg,${ACCENT},#00b8d9)`,
                border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
              }}>
                {isLoading ? <Spinner/> : isPlaying
                  ? <svg width="12" height="12" viewBox="0 0 24 24" fill="#000"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                  : <svg width="12" height="12" viewBox="0 0 24 24" fill="#000"><polygon points="5,3 19,12 5,21"/></svg>
                }
              </button>
              <IconBtn onClick={skipNext}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={TEXT}><polygon points="5,4 15,12 5,20"/><line x1="19" y1="5" x2="19" y2="19" stroke={TEXT} strokeWidth="2"/></svg>
              </IconBtn>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   BOTTOM NAV
   ============================================================ */
function BottomNav({ tab, setTab }) {
  const tabs = [
    { id:"search", label:"Search", icon:(c) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    )},
    { id:"playlists", label:"Library", icon:(c) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
      </svg>
    )},
    { id:"plugins", label:"Plugins", icon:(c) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2">
        <polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/>
      </svg>
    )},
  ];
  return (
    <nav style={{
      position:"fixed", bottom:0, left:0, right:0, zIndex:700,
      background:`${BG}f5`, backdropFilter:"blur(16px)",
      borderTop:`1px solid ${BORDER}`,
      display:"flex", justifyContent:"space-around", padding:"8px 0 6px",
      maxWidth:480, margin:"0 auto",
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3,
          background:"transparent", border:"none", cursor:"pointer", padding:"4px 0",
        }}>
          {t.icon(tab === t.id ? ACCENT : MUTED)}
          <span style={{
            fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:1,
            color: tab === t.id ? ACCENT : MUTED, textTransform:"uppercase",
          }}>{t.label}</span>
          {tab === t.id && (
            <div style={{ width:4, height:4, borderRadius:"50%", background:ACCENT, boxShadow:`0 0 6px ${ACCENT}` }}/>
          )}
        </button>
      ))}
    </nav>
  );
}

/* ============================================================
   ROOT APP + PROVIDER
   ============================================================ */
export default function App() {
  const [tab, setTab] = useState("search");
  const [repos, setRepos] = useState(() => StorageService.getRepos());
  const [playlists, setPlaylists] = useState(() => StorageService.getPlaylists());
  const [tracksCache, setTracksCache] = useState(() => StorageService.getCachedTracks());
  const [nowPlaying, setNowPlaying] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [playerStatus, setPlayerStatus] = useState("idle"); // idle|loading|playing|paused|error
  const audioRef = useRef(null);

  // Init audio engine once
  useEffect(() => {
    const svc = new AudioService();
    audioRef.current = svc;
    svc.on("ended", () => {
      setPlayerStatus("idle");
      // auto-advance
      setQueue(q => {
        setQueueIndex(qi => {
          if (qi < q.length - 1) {
            const next = q[qi + 1];
            setTimeout(() => playTrackInternal(next, q, qi + 1), 0);
            return qi + 1;
          }
          return qi;
        });
        return q;
      });
    });
    svc.on("error", () => setPlayerStatus("error"));
    return () => svc.destroy();
  }, []);

  // ── play logic ───────────────────────────────────────────
  const playTrackInternal = useCallback(async (track, q, qi) => {
    const audio = audioRef.current;
    setNowPlaying(track);
    setQueue(q);
    setQueueIndex(qi);
    setPlayerStatus("loading");

    // Cache track
    StorageService.cacheTrack(track);
    setTracksCache(prev => ({ ...prev, [track.id]: track }));

    let streamUrl = track.streamUrl;

    if (!streamUrl) {
      const repo = repos.find(r => r.manifest?.name === track.source) || repos[0];
      if (repo) {
        try {
          streamUrl = await PluginService.getStreamUrl(repo.manifest, track.id);
        } catch (e) {
          setPlayerStatus("error");
          return;
        }
      }
    }

    if (streamUrl) {
      await audio.load(streamUrl);
      try {
        await audio.play();
        setPlayerStatus("playing");
      } catch {
        setPlayerStatus("error");
      }
    } else {
      // Demo mode — no actual audio src but still "playing"
      setPlayerStatus("playing");
    }
  }, [repos]);

  const playTrack = useCallback((track, q = [], qi = 0) => {
    const idx = q.findIndex(t => t.id === track.id);
    playTrackInternal(track, q, idx >= 0 ? idx : 0);
  }, [playTrackInternal]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playerStatus === "playing") {
      audio.pause();
      setPlayerStatus("paused");
    } else {
      try {
        await audio.play();
        setPlayerStatus("playing");
      } catch {}
    }
  }, [playerStatus]);

  // ── repos ────────────────────────────────────────────────
  const addRepo = useCallback((repo) => {
    StorageService.saveRepo(repo);
    setRepos(StorageService.getRepos());
  }, []);
  const removeRepo = useCallback((url) => {
    StorageService.removeRepo(url);
    setRepos(StorageService.getRepos());
  }, []);
  /** Merge patch into an existing repo by URL, then persist. */
  const updateRepo = useCallback((url, patch) => {
    const current = StorageService.getRepos();
    const updated = current.map(r => r.url === url ? { ...r, ...patch } : r);
    localStorage.setItem(LS.REPOS, JSON.stringify(updated));
    setRepos(updated);
  }, []);

  // ── playlists ────────────────────────────────────────────
  const createPlaylist = useCallback((name) => {
    const id = uid();
    const updated = [...playlists, { id, name, trackIds: [], createdAt: Date.now() }];
    setPlaylists(updated);
    StorageService.savePlaylists(updated);
    return id;
  }, [playlists]);

  const deletePlaylist = useCallback((id) => {
    const updated = playlists.filter(p => p.id !== id);
    setPlaylists(updated);
    StorageService.savePlaylists(updated);
  }, [playlists]);

  const addTrackToPlaylist = useCallback((plId, track) => {
    StorageService.cacheTrack(track);
    setTracksCache(prev => ({ ...prev, [track.id]: track }));
    const updated = playlists.map(p =>
      p.id === plId && !p.trackIds.includes(track.id)
        ? { ...p, trackIds: [...p.trackIds, track.id] }
        : p
    );
    setPlaylists(updated);
    StorageService.savePlaylists(updated);
  }, [playlists]);

  const removeTrackFromPlaylist = useCallback((plId, trackId) => {
    const updated = playlists.map(p =>
      p.id === plId ? { ...p, trackIds: p.trackIds.filter(id => id !== trackId) } : p
    );
    setPlaylists(updated);
    StorageService.savePlaylists(updated);
  }, [playlists]);

  const ctx = {
    repos, addRepo, removeRepo, updateRepo,
    playlists, createPlaylist, deletePlaylist, addTrackToPlaylist, removeTrackFromPlaylist,
    tracksCache,
    nowPlaying, queue, queueIndex,
    playerStatus, playTrack, togglePlay,
  };

  return (
    <AppCtx.Provider value={ctx}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: ${BG}; color: ${TEXT}; min-height: 100%; overscroll-behavior: none; }
        input, button { font-size: inherit; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${BORDER}; border-radius: 4px; }

        @keyframes sbbar {
          0%   { height: 4px; }
          100% { height: 18px; }
        }
        @keyframes sbspin {
          to { transform: rotate(360deg); }
        }
        @keyframes sbfadein {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div style={{
        maxWidth: 480, margin: "0 auto", minHeight: "100dvh",
        background: BG, position: "relative", display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <header style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 16px 10px",
          background: `${BG}ee`, backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${BORDER}`,
          position: "sticky", top: 0, zIndex: 50,
        }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: `linear-gradient(135deg, ${ACCENT}, #00b8d9)`,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#000">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
          </div>
          <span style={{
            fontSize: 20, fontWeight: 800, fontFamily: "'Barlow Condensed', sans-serif",
            color: TEXT, letterSpacing: 1, textTransform: "uppercase",
          }}>
            Sound<span style={{ color: ACCENT }}>bound</span>
          </span>

          {repos.length > 0 && (
            <span style={{
              marginLeft: "auto", background: `${ACCENT}14`, border: `1px solid ${ACCENT}33`,
              color: ACCENT, fontSize: 10, fontFamily: "'Barlow Condensed', sans-serif",
              padding: "2px 9px", borderRadius: 20, letterSpacing: 1,
            }}>
              {repos.length} PLUGIN{repos.length > 1 ? "S" : ""}
            </span>
          )}

          {playerStatus === "playing" && (
            <div style={{ marginLeft: repos.length ? 8 : "auto" }}>
              <LiveBars />
            </div>
          )}
        </header>

        {/* Main content */}
        <main style={{ flex: 1, overflowY: "auto" }}>
          {tab === "search"    && <SearchPage />}
          {tab === "playlists" && <PlaylistsPage />}
          {tab === "plugins"   && <PluginsPage />}
        </main>

        <MiniPlayer audio={audioRef.current} />
        <BottomNav tab={tab} setTab={setTab} />
      </div>
    </AppCtx.Provider>
  );
}
