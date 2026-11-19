// Video Catch — popup logic

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const clearBtn = document.getElementById("clear");
const refreshBtn = document.getElementById("refresh");
const autoPromptEl = document.getElementById("autoPrompt");
const askLocationEl = document.getElementById("askLocation");
const subfolderEl = document.getElementById("subfolder");
const convertMp4El = document.getElementById("convertMp4");
const overlayButtonEl = document.getElementById("overlayButton");
const skipAdsEl = document.getElementById("skipAds");
const captureMp4El = document.getElementById("captureMp4");
const speedEl = document.getElementById("speed");
const settingsEl = document.getElementById("settings");
const settingsBtn = document.getElementById("settingsBtn");
const dlListEl = document.getElementById("dlList");
const dlEmptyEl = document.getElementById("dlEmpty");
const dlCountEl = document.getElementById("dlCount");
const clearDownloadsBtn = document.getElementById("clearDownloads");

let currentTabId = null;

function fmtSize(bytes) {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function shortName(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname);
  } catch {
    return url;
  }
}

function buildCard(entry) {
  const card = document.createElement("div");
  card.className = "card";

  // ---- top: thumb + title + tags ----
  const top = document.createElement("div");
  top.className = "top";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.textContent = entry.type === "video" ? "▶" : "≋";

  const info = document.createElement("div");
  info.className = "info";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = entry.title || shortName(entry.url);
  name.title = entry.url;

  const tags = document.createElement("div");
  tags.className = "tags";
  const isYt = entry.source === "youtube";
  const badge = isYt
    ? `<span class="badge youtube">YouTube</span>`
    : `<span class="badge ${entry.type}">${entry.type}</span>`;
  const size = entry.size ? `<span class="dot">${fmtSize(entry.size)}</span>` : "";
  const srcLabel = isYt
    ? "youtube"
    : entry.source === "reddit"
    ? "reddit"
    : entry.source === "page"
    ? "page"
    : "network";
  const src = `<span class="dot">${srcLabel}</span>`;
  tags.innerHTML = badge + size + src;

  info.appendChild(name);
  info.appendChild(tags);
  top.appendChild(thumb);
  top.appendChild(info);

  // ---- actions: quality select + download + tools ----
  const actions = document.createElement("div");
  actions.className = "actions";

  let qualitySel = null;
  const isStream = entry.type === "hls" || entry.type === "dash";
  const isBlob = entry.url.startsWith("blob:");

  if (entry.type === "hls") {
    qualitySel = document.createElement("select");
    qualitySel.className = "quality";
    qualitySel.innerHTML = `<option value="">Auto (best quality)</option>`;
    chrome.runtime.sendMessage({ type: "probe-hls", url: entry.url }, (res) => {
      if (!res || !res.variants || !res.variants.length) return;
      qualitySel.innerHTML = "";
      res.variants.forEach((v, i) => {
        const o = document.createElement("option");
        o.value = v.url;
        const label = v.height ? `${v.height}p` : `${Math.round(v.bandwidth / 1000)} kbps`;
        o.textContent = i === 0 ? `${label} (best)` : label;
        qualitySel.appendChild(o);
      });
    });
    actions.appendChild(qualitySel);
  }

  const btn = document.createElement("button");
  btn.className = "dl";
  btn.dataset.id = entry.id;
  btn.textContent = isStream ? "Merge & Save" : "Download";
  if (isBlob) {
    btn.disabled = true;
    btn.textContent = "Blob";
    btn.title = "Blob URLs can't be downloaded directly.";
  }

  // Fire a download/convert job in a given mode.
  const fire = (mode, start, end) => {
    const payload = { ...entry, mode };
    if (qualitySel && qualitySel.value) payload.mergeUrl = qualitySel.value;
    if (start != null) payload.start = start;
    if (end != null) payload.end = end;
    chrome.runtime.sendMessage({ type: "download", entry: payload });
    btn.classList.add("busy");
    btn.disabled = true;
    btn.textContent =
      mode === "audio" ? "Audio…" : mode === "gif" ? "GIF…" : mode === "clip" ? "Clip…" : "Starting…";
    if (mode === "video" && !isStream) setTimeout(() => resetBtn(btn, "Download"), 1500);
  };

  btn.addEventListener("click", () => fire("video"));
  actions.appendChild(btn);

  // "tools" toggle (⋯) — only when downloadable
  const moreBtn = document.createElement("button");
  moreBtn.className = "more";
  moreBtn.textContent = "⋯";
  moreBtn.title = "Audio / Clip / GIF";
  if (isBlob) moreBtn.disabled = true;
  actions.appendChild(moreBtn);

  // Subtitles button for HLS streams (probes the master for SUBTITLES tracks).
  if (entry.type === "hls" && !isBlob) {
    const cc = document.createElement("button");
    cc.className = "more cc";
    cc.textContent = "CC";
    cc.title = "Subtitles / transcript";
    cc.addEventListener("click", () =>
      openSubs({ source: "hls", url: entry.url }, entry.title || shortName(entry.url))
    );
    actions.appendChild(cc);
  }

  // Thumbnail/poster grab — only when we actually found a poster/og:image.
  if (entry.poster) {
    const th = document.createElement("button");
    th.className = "more thumb-btn";
    th.textContent = "🖼";
    th.title = "Save thumbnail image";
    th.addEventListener("click", () => {
      th.disabled = true;
      chrome.runtime.sendMessage(
        { type: "grab-thumbnail", url: entry.poster, title: entry.title || shortName(entry.url) },
        (res) => {
          th.disabled = false;
          th.textContent = res && res.ok ? "✓" : "🖼";
          if (res && res.ok) setTimeout(() => (th.textContent = "🖼"), 1500);
        }
      );
    });
    actions.appendChild(th);
  }

  card.appendChild(top);
  card.appendChild(actions);

  // ---- tools panel (MP3 / Clip / GIF) ----
  const tools = document.createElement("div");
  tools.className = "tools hidden";

  const chips = document.createElement("div");
  chips.className = "chips";
  const mp3 = chip("🎵 MP3");
  const clip = chip("✂️ Clip");
  const gif = chip("🎞️ GIF");
  chips.append(mp3, clip, gif);
  tools.appendChild(chips);

  // time inputs (shown for clip/gif)
  const timePanel = document.createElement("div");
  timePanel.className = "time-panel hidden";
  const startIn = mkInput("0:00");
  const endIn = mkInput("0:30");
  const go = document.createElement("button");
  go.className = "go";
  go.textContent = "Create";
  const hint = document.createElement("div");
  hint.className = "time-hint";
  timePanel.append(labelled("From", startIn), labelled("To", endIn), go);
  tools.appendChild(timePanel);
  tools.appendChild(hint);

  let pendingMode = null;
  mp3.addEventListener("click", () => fire("audio"));
  clip.addEventListener("click", () => {
    pendingMode = "clip";
    timePanel.classList.remove("hidden");
    hint.textContent = "Clip just this time range → MP4";
    go.textContent = "Make clip";
  });
  gif.addEventListener("click", () => {
    pendingMode = "gif";
    timePanel.classList.remove("hidden");
    hint.textContent = "Turn this range into a GIF (max 20s)";
    go.textContent = "Make GIF";
  });
  go.addEventListener("click", () => {
    const s = parseTime(startIn.value);
    const e = parseTime(endIn.value);
    if (e <= s) {
      hint.textContent = "End time must be after start time.";
      return;
    }
    fire(pendingMode, s, e);
  });

  moreBtn.addEventListener("click", () => tools.classList.toggle("hidden"));
  card.appendChild(tools);

  return card;
}

// "1:23" → 83, "1:02:03" → 3723, "45" → 45
function parseTime(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function chip(text) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = text;
  return b;
}

function mkInput(placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  i.className = "time-in";
  i.placeholder = placeholder;
  return i;
}

function labelled(text, el) {
  const wrap = document.createElement("label");
  wrap.className = "time-field";
  const s = document.createElement("span");
  s.textContent = text;
  wrap.append(s, el);
  return wrap;
}

function resetBtn(btn, text) {
  btn.classList.remove("busy");
  btn.disabled = false;
  btn.textContent = text;
}

// Header count = videos detected on the page PLUS resolved "paste a link" /
// auto-resolve results (which live in a separate list). Without counting both,
// a pasted/resolved video showed a card while the header still said "no videos
// yet".
function updateHeaderCount() {
  const n =
    listEl.querySelectorAll(".card").length + pasteResultsEl.querySelectorAll(".card").length;
  countEl.textContent = n ? `${n} video${n > 1 ? "s" : ""} found` : "no videos yet";
}

function render(media) {
  listEl.innerHTML = "";
  emptyEl.style.display = media.length || pasteResultsEl.querySelectorAll(".card").length ? "none" : "block";
  media.forEach((entry) => listEl.appendChild(buildCard(entry)));
  updateHeaderCount();
}

// ---- Downloads tab ----

function dlAction(label, cls, type, id, extra) {
  const b = document.createElement("button");
  b.className = `dl-btn ${cls}`;
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type, id, ...(extra || {}) });
  });
  return b;
}

const STATUS_LABEL = {
  completed: "Done",
  failed: "Failed",
  canceled: "Canceled",
  paused: "Paused",
  downloading: "Downloading",
};

function renderDownloads(items) {
  dlListEl.innerHTML = "";
  const active = items.filter((d) => d.status === "downloading" || d.status === "paused").length;
  if (active > 0) {
    dlCountEl.textContent = active;
    dlCountEl.classList.remove("hidden");
  } else {
    dlCountEl.classList.add("hidden");
  }
  dlEmptyEl.style.display = items.length ? "none" : "block";

  items.forEach((d) => {
    const item = document.createElement("div");
    item.className = "dl-item";

    const head = document.createElement("div");
    head.className = "dl-head";

    const name = document.createElement("div");
    name.className = "dl-name";
    name.textContent = d.name;
    name.title = d.name;

    const status = document.createElement("span");
    const statusKey = d.status === "paused" ? "downloading" : d.status; // reuse pill colour
    status.className = `status ${statusKey}`;
    status.textContent = STATUS_LABEL[d.status] || d.status;

    head.appendChild(name);
    if (d.priority && (d.status === "downloading" || d.status === "paused")) {
      const pri = document.createElement("span");
      pri.className = "status priority";
      pri.textContent = "⚡ Priority";
      head.appendChild(pri);
    }
    head.appendChild(status);
    item.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "dl-actions";

    const pausable = d.status === "downloading" && d.phase === "fetching";
    // "converting" now carries a REAL byte/ffmpeg progress %, so show a determinate
    // bar (no more blinking indeterminate sweep). Only "queued" (waiting for the
    // convert lock) and "saving" (brief) stay indeterminate.
    const queued = d.phase === "queued";
    const indeterminatePhase = queued || d.phase === "saving";

    if (d.status === "downloading" || d.status === "paused") {
      const known = typeof d.progress === "number" && !indeterminatePhase && d.status !== "paused";
      const bar = document.createElement("div");
      bar.className = known ? "progress" : "progress indeterminate";
      if (d.status === "paused") bar.className = "progress";
      const fill = document.createElement("span");
      fill.style.width = known ? `${d.progress}%` : d.status === "paused" ? `${d.progress || 0}%` : "40%";
      bar.appendChild(fill);
      item.appendChild(bar);

      const sub = document.createElement("div");
      sub.className = "dl-sub";
      sub.textContent =
        d.status === "paused"
          ? `Paused${typeof d.progress === "number" ? ` · ${d.progress}%` : ""}`
          : queued
          ? "Waiting to process…"
          : d.phase === "converting"
          ? `Processing… ${typeof d.progress === "number" ? d.progress + "%" : ""}`.trim()
          : d.phase === "saving"
          ? "Saving…"
          : known
          ? `${d.progress}%`
          : "Starting…";
      item.appendChild(sub);

      // ⚡ Prioritize — first dibs on connection slots + jumps the convert queue.
      // Only meaningful (and shown) when 2+ downloads are competing. Toggles.
      if (d.status === "downloading" && active >= 2) {
        actions.appendChild(
          dlAction(d.priority ? "⚡ Prioritized" : "⚡ Prioritize", d.priority ? "primary" : "neutral", "set-priority", d.id)
        );
      }
      if (d.status === "downloading" && (pausable || d.kind === "browser")) {
        actions.appendChild(dlAction("Pause", "neutral", "pause-download", d.id));
      } else if (d.status === "paused") {
        actions.appendChild(dlAction("Resume", "primary", "resume-download", d.id));
      }
      actions.appendChild(dlAction("Cancel", "danger", "cancel-download", d.id));
    } else if (d.status === "completed") {
      const sub = document.createElement("div");
      sub.className = "dl-sub";
      sub.textContent = d.size ? fmtSize(d.size) + " · saved" : "Saved";
      item.appendChild(sub);
      if (d.dlId != null) {
        actions.appendChild(dlAction("Show in folder", "neutral", "reveal-download", null, { dlId: d.dlId }));
      }
      // A YouTube capture can occasionally save a glitchy file (you only find out
      // on playback) — offer a one-click re-capture right here.
      if (d.type === "youtube" && d.ytReq) {
        actions.appendChild(dlAction("Re-capture", "neutral", "yt-recapture", d.id));
      }
      actions.appendChild(dlAction("Remove", "ghost-btn", "remove-download", d.id));
    } else {
      // failed or canceled
      const sub = document.createElement("div");
      sub.className = "dl-sub";
      sub.textContent =
        d.status === "canceled" ? "Canceled" : d.error ? `Error: ${d.error}` : "Download failed";
      item.appendChild(sub);
      // Retry: normal downloads carry `req`; YouTube captures re-run via ytReq.
      if (d.req) actions.appendChild(dlAction("Retry", "primary", "retry-download", d.id));
      else if (d.type === "youtube" && d.ytReq) actions.appendChild(dlAction("Retry", "primary", "yt-recapture", d.id));
      actions.appendChild(dlAction("Remove", "ghost-btn", "remove-download", d.id));
    }

    if (actions.children.length) item.appendChild(actions);
    dlListEl.appendChild(item);
  });
}

function loadDownloads() {
  chrome.runtime.sendMessage({ type: "get-downloads" }, (res) => {
    if (res && res.downloads) renderDownloads(res.downloads);
  });
}

// ---- Paste a link ----
const pasteUrlEl = document.getElementById("pasteUrl");
const pasteGoEl = document.getElementById("pasteGo");
const pasteMsgEl = document.getElementById("pasteMsg");
const pasteResultsEl = document.getElementById("pasteResults");

function pasteMsg(text, kind) {
  pasteMsgEl.textContent = text || "";
  pasteMsgEl.className = "paste-msg" + (text ? " " + (kind || "info") : " hidden");
}

function resolvePasted() {
  const url = pasteUrlEl.value.trim();
  if (!url) {
    pasteMsg("Paste a video link or page URL first.", "warn");
    return;
  }
  pasteResultsEl.innerHTML = "";
  updateHeaderCount();
  pasteMsg("Looking for video…", "info");
  pasteGoEl.disabled = true;
  pasteGoEl.textContent = "…";
  chrome.runtime.sendMessage({ type: "resolve-link", url, tabId: currentTabId }, (res) => {
    pasteGoEl.disabled = false;
    pasteGoEl.textContent = "Get";
    if (chrome.runtime.lastError || !res) {
      pasteMsg("Something went wrong. Try again.", "warn");
      return;
    }
    if (res.youtube) {
      pasteMsg(res.message, "warn");
      // Surface the capture card if this tab is the YouTube video.
      setupYouTube();
      return;
    }
    if (res.subtitle) {
      pasteMsg("Subtitle file detected — pick a format below.", "ok");
      openSubs({ source: "url", url: res.url }, res.title || "subtitles");
      return;
    }
    if (!res.ok || !res.items || !res.items.length) {
      pasteMsg(res.message || "No video found.", "warn");
      return;
    }
    pasteMsg(
      `Found ${res.items.length} download${res.items.length > 1 ? "s" : ""} — pick one below.`,
      "ok"
    );
    emptyEl.style.display = "none"; // results stand in for the empty state
    res.items.forEach((entry) => pasteResultsEl.appendChild(buildCard(entry)));
    updateHeaderCount();
  });
}

pasteGoEl.addEventListener("click", resolvePasted);
pasteUrlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") resolvePasted();
});

// ---- YouTube capture card ----
const ytCard = document.getElementById("ytCard");
const ytTitle = document.getElementById("ytTitle");
const ytStat = document.getElementById("ytStat");
const ytStart = document.getElementById("ytStart");
let ytPoll = null;

function fmtMB(bytes) {
  return bytes ? (bytes / (1024 * 1024)).toFixed(1) + " MB" : "0 MB";
}

let ytInfo = null;
function setupYouTube() {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: "yt-status", tabId: currentTabId }, (info) => {
    if (chrome.runtime.lastError || !info) {
      ytCard.classList.add("hidden");
      return;
    }
    ytInfo = info;
    ytTitle.textContent = info.title || "YouTube video";
    ytCard.classList.remove("hidden");
    syncRangeUI();
  });
}

// ---- capture range (optional clip window) ----
const ytRangeOn = document.getElementById("ytRangeOn");
const ytRangeFields = document.getElementById("ytRangeFields");
const ytRangeHint = document.getElementById("ytRangeHint");
const ytRangeStart = document.getElementById("ytRangeStart");
const ytRangeEnd = document.getElementById("ytRangeEnd");

function syncRangeUI() {
  const on = ytRangeOn.checked;
  ytRangeFields.classList.toggle("hidden", !on);
  ytRangeHint.classList.toggle("hidden", !on);
  ytStart.textContent = on ? "⬇ Capture this part" : "⬇ Capture full video";
}
ytRangeOn.addEventListener("change", syncRangeUI);

ytStart.addEventListener("click", () => {
  let rangeStart = 0;
  let rangeEnd = 0;
  if (ytRangeOn.checked) {
    rangeStart = parseTime(ytRangeStart.value);
    rangeEnd = parseTime(ytRangeEnd.value);
    if (!ytRangeEnd.value.trim()) {
      ytStat.textContent = "⚠ Enter an end time (e.g. 4:00) for the part you want.";
      return;
    }
    if (rangeEnd <= rangeStart) {
      ytStat.textContent = "⚠ End time must be after the start time.";
      return;
    }
  }
  chrome.runtime.sendMessage({ type: "yt-capture-start", tabId: currentTabId, rangeStart, rangeEnd });
  ytStart.disabled = true;
  ytStart.textContent = "Capturing…";
  ytStat.textContent = rangeEnd
    ? `Buffering ${fmtClock(rangeStart)}–${fmtClock(rangeEnd)}…`
    : "Fast-forwarding to buffer the whole video…";
});

// 83 → "1:23"
function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function ytReset() {
  ytStart.disabled = false;
  syncRangeUI();
}

// ---- Subtitles / transcripts ----
const subsHost = document.getElementById("subsHost");
const ytSubs = document.getElementById("ytSubs");

function subField(label, el) {
  const wrap = document.createElement("label");
  wrap.className = "subs-field";
  const s = document.createElement("span");
  s.textContent = label;
  wrap.append(s, el);
  return wrap;
}

function subOpt(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function openSubs(req, title) {
  subsHost.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "subs-panel";
  const head = document.createElement("div");
  head.className = "subs-head";
  head.innerHTML = `<span>📝 Subtitles / Transcript</span>`;
  const x = document.createElement("button");
  x.className = "subs-x";
  x.textContent = "✕";
  x.title = "Close";
  x.addEventListener("click", () => (subsHost.innerHTML = ""));
  head.appendChild(x);
  const body = document.createElement("div");
  body.className = "subs-body";
  body.innerHTML = `<div class="subs-msg">Loading available captions…</div>`;
  panel.append(head, body);
  subsHost.appendChild(panel);

  // Error strings can originate from network exceptions — set them as TEXT, never
  // innerHTML, so remote-derived content can't inject markup into the popup.
  const showWarn = (text) => {
    body.innerHTML = "";
    const d = document.createElement("div");
    d.className = "subs-msg warn";
    d.textContent = text;
    body.appendChild(d);
  };
  chrome.runtime.sendMessage({ type: "subs-list", ...req }, (res) => {
    if (chrome.runtime.lastError || !res) {
      showWarn("Couldn't reach the page.");
      return;
    }
    if (!res.ok || !res.tracks || !res.tracks.length) {
      showWarn(res.message || "No subtitles available.");
      return;
    }
    renderSubsForm(body, res, title);
  });
}

function renderSubsForm(body, res, title) {
  body.innerHTML = "";

  const trackSel = document.createElement("select");
  trackSel.className = "subs-select";
  res.tracks.forEach((t, i) =>
    trackSel.appendChild(
      subOpt(String(i), t.label + (t.kind === "auto" ? " (auto)" : "") + (t.lang ? " · " + t.lang : ""))
    )
  );
  // Auto-select the most useful track so a new user isn't stuck on a random
  // language (e.g. Arabic): prefer the browser's language, then English, and a
  // human/manual track over an auto-generated one.
  const uiLang = (navigator.language || "en").slice(0, 2).toLowerCase();
  const trackScore = (t) => {
    const l = (t.lang || "").slice(0, 2).toLowerCase();
    let s = l === uiLang ? 4 : l === "en" ? 2 : 0;
    if (t.kind !== "auto") s += 1;
    return s;
  };
  let bestI = 0, bestS = -1;
  res.tracks.forEach((t, i) => {
    const s = trackScore(t);
    if (s > bestS) { bestS = s; bestI = i; }
  });
  trackSel.value = String(bestI);

  const fmtSel = document.createElement("select");
  fmtSel.className = "subs-select";
  fmtSel.appendChild(subOpt("srt", "SubRip (.srt)"));
  fmtSel.appendChild(subOpt("vtt", "WebVTT (.vtt)"));
  fmtSel.appendChild(subOpt("txt", "Plain-text transcript (.txt)"));

  let tlangSel = null;
  if (res.translation && res.translation.length) {
    tlangSel = document.createElement("select");
    tlangSel.className = "subs-select";
    tlangSel.appendChild(subOpt("", "Original language"));
    res.translation.forEach((l) => tlangSel.appendChild(subOpt(l.code, "Translate → " + l.name)));
  }

  const dl = document.createElement("button");
  dl.className = "subs-dl";
  dl.textContent = "⬇ Download";
  const msg = document.createElement("div");
  msg.className = "subs-msg";

  body.append(subField("Language / track", trackSel), subField("Format", fmtSel));
  if (tlangSel) body.append(subField("Translate", tlangSel));
  body.append(dl, msg);

  // Translation only applies to translatable tracks (YouTube flags this).
  const syncTranslate = () => {
    if (!tlangSel) return;
    const t = res.tracks[+trackSel.value];
    const allow = t && t.translatable !== false;
    tlangSel.disabled = !allow;
    if (!allow) tlangSel.value = "";
  };
  trackSel.addEventListener("change", syncTranslate);
  syncTranslate();

  dl.addEventListener("click", () => {
    const track = res.tracks[+trackSel.value];
    dl.disabled = true;
    dl.textContent = "Fetching…";
    msg.className = "subs-msg";
    msg.textContent = "";
    chrome.runtime.sendMessage(
      { type: "subs-get", track, tabId: currentTabId, format: fmtSel.value, tlang: tlangSel ? tlangSel.value : "", title },
      (res2) => {
        dl.disabled = false;
        dl.textContent = "⬇ Download";
        if (chrome.runtime.lastError || !res2) {
          msg.className = "subs-msg warn";
          msg.textContent = "Something went wrong.";
          return;
        }
        if (!res2.ok) {
          msg.className = "subs-msg warn";
          msg.textContent = res2.message || "Failed.";
          return;
        }
        msg.className = "subs-msg ok";
        msg.textContent = "Saved " + res2.name + " — see the Downloads tab.";
      }
    );
  });
}

ytSubs.addEventListener("click", () => openSubs({ source: "youtube", tabId: currentTabId }, ytTitle.textContent));

const ytThumb = document.getElementById("ytThumb");
ytThumb.addEventListener("click", () => {
  const id = ytInfo && ytInfo.videoId;
  if (!id) return;
  ytThumb.disabled = true;
  ytThumb.textContent = "Saving…";
  chrome.runtime.sendMessage(
    { type: "grab-thumbnail", youtubeId: id, title: ytTitle.textContent },
    (res) => {
      ytThumb.disabled = false;
      ytThumb.textContent = res && res.ok ? "✓ Saved" : "🖼️ Thumbnail";
      if (res && res.ok) setTimeout(() => (ytThumb.textContent = "🖼️ Thumbnail"), 1800);
    }
  );
});

// ---- Onboarding + review banner ----
const bannerEl = document.getElementById("banner");

function refreshBanner() {
  chrome.storage.local.get(["vc_onboarded", "vc_hasSaved", "vc_reviewPrompted"]).then((s) => {
    if (!s.vc_onboarded) return showOnboarding();
    if (s.vc_hasSaved && !s.vc_reviewPrompted) return showReview();
    bannerEl.innerHTML = "";
  });
}

function showOnboarding() {
  bannerEl.innerHTML = `
    <div class="banner-card welcome">
      <div class="banner-title">👋 Welcome to Video Catch</div>
      <ul class="banner-tips">
        <li>▶️ <b>Play a video</b>, then open this popup to grab it.</li>
        <li>🔗 Or <b>paste any link</b> in the box below.</li>
        <li>📝 Pull <b>subtitles / transcripts</b> &amp; 🖼️ <b>thumbnails</b> too.</li>
        <li>🔒 Everything runs <b>100% on your device</b>.</li>
      </ul>
      <button class="banner-btn" id="obDone">Got it</button>
    </div>`;
  document.getElementById("obDone").addEventListener("click", () => {
    chrome.storage.local.set({ vc_onboarded: true });
    bannerEl.innerHTML = "";
  });
}

const SHARE_TEXT =
  "Check out Video Catch — a free, 100% on-device Chrome extension that downloads videos, merges HLS/DASH streams to clean MP4, extracts MP3/GIF/clips, and grabs subtitles & transcripts. No servers, no tracking.";

function showReview() {
  bannerEl.innerHTML = `
    <div class="banner-card cheer">
      <div class="banner-title">🎉 Your first save — nice!</div>
      <div class="banner-text">If Video Catch helped, share it with a friend.</div>
      <div class="banner-actions">
        <button class="banner-btn" id="rvShare">Copy share text</button>
        <button class="banner-btn ghost" id="rvDismiss">Dismiss</button>
      </div>
    </div>`;
  const done = () => {
    chrome.storage.local.set({ vc_reviewPrompted: true });
    bannerEl.innerHTML = "";
  };
  document.getElementById("rvShare").addEventListener("click", () => {
    const btn = document.getElementById("rvShare");
    navigator.clipboard.writeText(SHARE_TEXT).then(
      () => {
        btn.textContent = "✓ Copied!";
        setTimeout(done, 1200);
      },
      () => done()
    );
  });
  document.getElementById("rvDismiss").addEventListener("click", done);
}

function load() {
  refreshBanner();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    currentTabId = tab.id;
    setupYouTube();
    // On an Instagram post/reel/story, auto-resolve via the API (gives a playable
    // progressive MP4) instead of relying on the page's un-playable CDN segments.
    if (tab.url && /instagram\.com\/(?:stories\/|(?:[^/]+\/)?(?:p|reel|reels|tv)\/)/i.test(tab.url)) {
      const isStory = /instagram\.com\/stories\//i.test(tab.url);
      pasteMsg(isStory ? "Fetching this Instagram story…" : "Fetching this Instagram video…", "info");
      chrome.runtime.sendMessage({ type: "resolve-link", url: tab.url, tabId: currentTabId }, (res) => {
        if (res && res.ok && res.items && res.items.length) {
          pasteResultsEl.innerHTML = "";
          pasteMsg(`Found ${res.items.length} download${res.items.length > 1 ? "s" : ""} — pick one below.`, "ok");
          emptyEl.style.display = "none";
          res.items.forEach((entry) => pasteResultsEl.appendChild(buildCard(entry)));
          updateHeaderCount();
        } else {
          pasteMsg((res && res.message) || "Couldn't fetch this Instagram video.", "warn");
        }
      });
    }
    chrome.runtime.sendMessage({ type: "get-media", tabId: currentTabId }, (res) => {
      if (!res) return;
      autoPromptEl.checked = !!(res.settings && res.settings.autoPrompt);
      askLocationEl.checked = !!(res.settings && res.settings.askLocation);
      subfolderEl.value = (res.settings && res.settings.subfolder) || "";
      convertMp4El.checked = res.settings ? res.settings.convertMp4 !== false : true;
      overlayButtonEl.checked = res.settings ? res.settings.overlayButton !== false : true;
      skipAdsEl.checked = res.settings ? res.settings.skipAds !== false : true;
      captureMp4El.checked = res.settings ? res.settings.captureMp4 !== false : true;
      if (res.settings && res.settings.speed) speedEl.value = res.settings.speed;
      render(res.media || []);
    });
  });
  loadDownloads();
}

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    document.getElementById("panel-videos").classList.toggle("hidden", which !== "videos");
    document.getElementById("panel-downloads").classList.toggle("hidden", which !== "downloads");
  });
});

clearDownloadsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear-downloads" });
});

// Settings
settingsBtn.addEventListener("click", () => settingsEl.classList.toggle("hidden"));
const settingsCloseBtn = document.getElementById("settingsClose");
if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", () => settingsEl.classList.add("hidden"));

autoPromptEl.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "autoPrompt", value: autoPromptEl.checked })
);
askLocationEl.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "askLocation", value: askLocationEl.checked })
);
subfolderEl.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "subfolder", value: subfolderEl.value.trim() })
);
convertMp4El.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "convertMp4", value: convertMp4El.checked })
);
overlayButtonEl.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "overlayButton", value: overlayButtonEl.checked })
);
skipAdsEl.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "skipAds", value: skipAdsEl.checked })
);
captureMp4El.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "captureMp4", value: captureMp4El.checked })
);
speedEl.addEventListener("change", () =>
  chrome.runtime.sendMessage({ type: "set-setting", key: "speed", value: speedEl.value })
);

clearBtn.addEventListener("click", () => {
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: "clear", tabId: currentTabId });
  pasteResultsEl.innerHTML = ""; // also drop resolved "paste a link" results
  pasteMsg("");
  render([]); // resets the header count via updateHeaderCount
});

// Reload the actual page — needed when a video was ALREADY playing before the
// popup/extension attached, so the network sniffer never saw its requests.
// (The "Refresh" button only re-scans; it can't catch requests that already
// happened. Reloading replays them from scratch.)
function reloadThePage(btn) {
  if (currentTabId == null) return;
  const prev = btn.textContent;
  btn.textContent = "Reloading…";
  chrome.tabs.reload(currentTabId, {}, () => {
    // Let the page start emitting media, then refresh the list.
    setTimeout(() => {
      load();
      btn.textContent = prev;
    }, 1500);
  });
}
const reloadPageBtn = document.getElementById("reloadPage");
if (reloadPageBtn) reloadPageBtn.addEventListener("click", () => reloadThePage(reloadPageBtn));
const reloadPageLink = document.getElementById("reloadPageLink");
if (reloadPageLink) reloadPageLink.addEventListener("click", () => reloadThePage(reloadPageLink));

refreshBtn.addEventListener("click", () => {
  refreshBtn.textContent = "Refreshing…";
  // Nudge the content script to re-scan the page (e.g. Reddit re-reads its player),
  // then reload the list so the button visibly does something.
  if (currentTabId != null) {
    chrome.tabs.sendMessage(currentTabId, { type: "rescan" }, () => void chrome.runtime.lastError);
  }
  setTimeout(() => {
    load();
    refreshBtn.textContent = "Refresh";
  }, 500);
});

// Feedback / feature requests. No server (privacy-first), so this opens a
// prefilled email. Swap FEEDBACK_EMAIL for a Google Form URL if you'd rather
// collect requests in a form (then change the handler to open that URL).
const feedbackEl = document.getElementById("feedback");
const FEEDBACK_EMAIL = "raghavkejariwal2@gmail.com"; // ← where feature requests are sent
feedbackEl.addEventListener("click", () => {
  const v = chrome.runtime.getManifest().version;
  const subject = encodeURIComponent(`Video Catch — feedback / feature request (v${v})`);
  const body = encodeURIComponent(
    "What would you like added, or what went wrong?\n\n\n" +
      "----------------\n" +
      `Version: ${v}\n` +
      "Site you were on: \n"
  );
  chrome.tabs.create({ url: `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}` });
});

// Live downloads list updates.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "downloads-update") renderDownloads(msg.downloads || []);
});

// Surface the review card the moment the first save lands (background flips
// vc_hasSaved), even while the popup stays open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vc_hasSaved) refreshBanner();
});

// Live YouTube capture progress.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "yt-cap-status-ui") return;
  // Only reflect the capture happening on THIS tab — otherwise a capture running in
  // another tab hijacks this popup's card (wrong title/progress).
  if (msg.tabId != null && currentTabId != null && msg.tabId !== currentTabId) return;
  if (msg.evt === "error") {
    ytStat.textContent = "⚠ " + (msg.reason || "Capture failed.");
    ytReset();
    return;
  }
  if (msg.ad) {
    ytStat.textContent = "⏭ Skipping an ad… (it won't be recorded)";
    return;
  }
  if (msg.evt === "finalizing" || (typeof msg.pct === "number" && msg.pct >= 99)) {
    ytStat.textContent = `Muxing to MP4 (${fmtMB(msg.video)} video + ${fmtMB(msg.audio)} audio)… see Downloads.`;
    return;
  }
  if (typeof msg.pct === "number") {
    const scope = ytRangeOn && ytRangeOn.checked ? "selected part" : "video";
    ytStat.textContent = `Buffering ${scope} ${msg.pct}% · ${fmtMB(msg.video)} — sit tight, it's fast-forwarding.`;
  }
});

// When the captured file finishes (or fails), reset the capture button.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "downloads-update") return;
  const yt = (msg.downloads || []).find((d) => d.type === "youtube");
  if (yt && (yt.status === "completed" || yt.status === "failed" || yt.status === "canceled")) {
    ytStat.textContent = yt.status === "completed" ? "✓ Saved! Check your Downloads." : "Capture " + yt.status + ".";
    ytReset();
  }
});

// Live progress while a stream merges.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.id) return;
  const btn = listEl.querySelector(`button[data-id="${msg.id}"]`);
  if (!btn) return;
  if (msg.type === "hls-progress-ui") {
    btn.classList.add("busy");
    btn.disabled = true;
    btn.textContent = `${Math.round((msg.done / msg.total) * 100)}%`;
  } else if (msg.type === "hls-converting-ui") {
    btn.classList.add("busy");
    btn.disabled = true;
    btn.textContent = "Converting…";
  } else if (msg.type === "hls-done-ui") {
    btn.classList.remove("busy");
    btn.textContent = "Saved ✓";
  } else if (msg.type === "hls-error-ui") {
    resetBtn(btn, "Retry");
  }
});

load();
