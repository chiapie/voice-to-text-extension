(function () {
  const LOG = (...a) => console.log("%c[Spacevoice]", "color:#1a73e8", ...a);
  const WARN = (...a) => console.warn("[Spacevoice]", ...a);
  LOG("content script loaded on", location.href);

  const HOLD_MS = 180;
  const recognizer = window.__VoiceExtRecognizer;
  LOG("recognizer present:", !!recognizer, "supported:", recognizer && recognizer.isSupported());

  let lastEditable = null;
  let lastSelection = null;
  let holdTimer = null;
  let recording = false;
  let spaceDown = false;
  let currentShift = false;
  let pill = null;
  let pillText = null;
  let settings = { lang: navigator.language || "en-US", enabled: true };

  // Live-insertion state: tracks text we've already written into the field
  // during the current recording so we can replace it as interim results
  // update.
  let liveTarget = null;
  let liveStart = 0;
  let liveLength = 0;

  chrome.storage.local.get(["lang", "enabled"]).then((v) => {
    if (v && v.lang) settings.lang = v.lang;
    if (v && typeof v.enabled === "boolean") settings.enabled = v.enabled;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lang) settings.lang = changes.lang.newValue;
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
  });

  // ---------- focus tracking ----------
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "url", "email", "tel", "password", "number", ""].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function captureSelection(el) {
    try {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        return { start: el.selectionStart, end: el.selectionEnd };
      }
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        return { range: sel.getRangeAt(0).cloneRange() };
      }
    } catch (_) {}
    return null;
  }

  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (isEditable(t)) {
        lastEditable = t;
        lastSelection = captureSelection(t);
      }
    },
    true
  );

  // ---------- recording pill ----------
  function ensurePill() {
    if (pill) return;
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .pill {
        font: 500 13px -apple-system, system-ui, sans-serif;
        background: rgba(20,20,20,.92);
        color: #fff;
        padding: 10px 14px;
        border-radius: 999px;
        display: flex; align-items: center; gap: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,.25);
        max-width: 60vw;
      }
      .dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: #ff3b30;
        animation: pulse 1s ease-in-out infinite;
        flex: 0 0 auto;
      }
      .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      @keyframes pulse {
        0%,100% { opacity: 1; transform: scale(1); }
        50% { opacity: .4; transform: scale(.8); }
      }
    `;
    const wrap = document.createElement("div");
    wrap.className = "pill";
    const dot = document.createElement("div");
    dot.className = "dot";
    const txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = "Listening…";
    wrap.appendChild(dot);
    wrap.appendChild(txt);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
    pill = host;
    pillText = txt;
  }

  function updatePill(text, lang) {
    ensurePill();
    const prefix = lang && lang.startsWith("zh") ? "中文 · " : "EN · ";
    pillText.textContent = prefix + (text || "Listening…");
  }

  function hidePill() {
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    pill = null;
    pillText = null;
  }

  // ---------- insertion ----------
  function insertText(el, text) {
    if (!el || !el.isConnected) {
      // fallback: clipboard
      navigator.clipboard.writeText(text).catch(() => {});
      toast("Copied to clipboard (no active field)");
      return;
    }

    try {
      el.focus({ preventScroll: true });
    } catch (_) {}

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const start =
        lastSelection && typeof lastSelection.start === "number"
          ? lastSelection.start
          : el.selectionStart ?? el.value.length;
      const end =
        lastSelection && typeof lastSelection.end === "number"
          ? lastSelection.end
          : el.selectionEnd ?? el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      const needsSpace = before.length > 0 && !/\s$/.test(before) && !/^[\s,.?!，。？！]/.test(text);
      const insert = (needsSpace ? " " : "") + text;
      el.value = before + insert + after;
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (el.isContentEditable) {
      // restore selection if we have one
      if (lastSelection && lastSelection.range) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        try {
          sel.addRange(lastSelection.range);
        } catch (_) {}
      }
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, text);
      } catch (_) {}
      if (!ok) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
        }
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function toast(msg) {
    ensurePill();
    pillText.textContent = msg;
    setTimeout(hidePill, 1600);
  }

  // ---------- Google Docs/Slides special path ----------
  // Detect Docs via the top frame, since Docs hides its text caret in an
  // about:blank iframe whose own location is empty.
  const IS_GOOGLE_DOCS = (() => {
    try {
      const top = window.top;
      if (top && top.location && top.location.hostname === "docs.google.com") {
        return /\/(document|presentation|spreadsheets)\//.test(top.location.pathname);
      }
    } catch (_) {}
    return (
      location.hostname === "docs.google.com" &&
      /\/(document|presentation|spreadsheets)\//.test(location.pathname)
    );
  })();
  LOG("IS_GOOGLE_DOCS =", IS_GOOGLE_DOCS, "frame=", window === window.top ? "top" : "child");

  function pasteIntoDocs(text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    const target = document.activeElement || document.body;
    LOG("pasteIntoDocs target=", target && target.tagName, "text=", JSON.stringify(text));
    target.dispatchEvent(ev);
  }

  // For Docs we can't live-update (interim rewrites would garble the doc).
  // Pill shows live; paste happens only on final commit.
  let docsCommitted = "";

  // ---------- live insertion (standard fields) ----------
  function writeLive(text) {
    if (IS_GOOGLE_DOCS) return; // live shown in pill only

    if (!liveTarget || !liveTarget.isConnected) return;
    const el = liveTarget;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const v = el.value;
      const before = v.slice(0, liveStart);
      const after = v.slice(liveStart + liveLength);
      el.value = before + text + after;
      liveLength = text.length;
      const pos = liveStart + liveLength;
      try {
        el.setSelectionRange(pos, pos);
      } catch (_) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      // Incremental append for contenteditable: compute delta vs prior
      // interim text, use execCommand('delete')/('insertText') to rewrite
      // the tail. Cheap approach: replace last liveLength chars with text.
      try {
        const sel = window.getSelection();
        if (!sel) return;
        // Select liveLength characters ending at the cursor and replace them.
        for (let i = 0; i < liveLength; i++) {
          sel.modify && sel.modify("extend", "backward", "character");
        }
        document.execCommand("insertText", false, text);
        liveLength = text.length;
      } catch (e) {
        WARN("contenteditable live write failed:", e);
      }
    }
  }

  function beginLive(el) {
    docsCommitted = "";
    if (IS_GOOGLE_DOCS) {
      liveTarget = null;
      liveStart = 0;
      liveLength = 0;
      return;
    }
    if (!el) return;
    liveTarget = el;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const start = el.selectionStart ?? el.value.length;
      liveStart = start;
      liveLength = 0;
    } else {
      liveStart = 0;
      liveLength = 0;
    }
  }

  function endLive() {
    liveTarget = null;
    liveStart = 0;
    liveLength = 0;
  }

  // ---------- recording lifecycle ----------
  async function startRecording(shift) {
    LOG("startRecording shift=", shift);
    if (recording) return;
    if (!recognizer || !recognizer.isSupported()) {
      WARN("SpeechRecognition not supported");
      toast("SpeechRecognition not supported in this browser");
      return;
    }
    recording = true;
    const baseLang = settings.lang || "en-US";
    let lang = baseLang;
    // Outside Docs, Shift quick-swaps languages. Inside Docs, Shift is the
    // required arming modifier so it must NOT flip language.
    if (shift && !IS_GOOGLE_DOCS) {
      lang = baseLang.startsWith("zh") ? "en-US" : "zh-TW";
    }
    updatePill("", lang);

    // Target the currently focused editable (preferred) or the last one.
    const target = isEditable(document.activeElement)
      ? document.activeElement
      : lastEditable;
    beginLive(target);

    try {
      LOG("calling recognizer.start lang=", lang);
      const text = await recognizer.start(lang, (partial) => {
        LOG("interim:", partial);
        updatePill(partial, lang);
        writeLive(partial);
      });
      LOG("final text:", text);
      if (IS_GOOGLE_DOCS) {
        if (text && text.trim()) broadcastPaste(text.trim());
      } else {
        if (text) writeLive(text);
        if (liveTarget && liveTarget.isContentEditable && text && text.trim()) {
          // Selection/execCommand path already committed as final via writeLive.
          // Dispatch a final input event for frameworks that need it.
          liveTarget.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
          );
        }
      }
      hidePill();
    } catch (e) {
      WARN("recognizer error:", e);
      toast("Mic error: " + (e.message || "unknown"));
      setTimeout(hidePill, 1800);
    } finally {
      endLive();
      recording = false;
    }
  }

  function stopRecording() {
    if (recognizer && recording) recognizer.stop();
  }

  // ---------- hotkey ----------
  // Strategy: always intercept Space keydown and preventDefault so the page
  // never sees it immediately. If it's released before HOLD_MS it was a tap,
  // so we manually insert a literal space into the focused field. If it's
  // held past HOLD_MS we start recording. This lets dictation work *inside*
  // text fields without conflicting with normal typing.

  function typeSpace(el) {
    if (!el || !el.isConnected) return;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + " " + el.value.slice(end);
      const pos = start + 1;
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      try {
        document.execCommand("insertText", false, " ");
      } catch (_) {}
    }
  }

  // Should this space event arm the hotkey?
  //  - On Google Docs/Slides, use Shift+Space (plain Space must still type a
  //    real space in the document).
  //  - On normal pages, only intercept when a text field is focused (so we
  //    don't break page scrolling when the user isn't typing).
  function shouldArm(e) {
    if (IS_GOOGLE_DOCS) return e.shiftKey;
    return isEditable(document.activeElement);
  }

  const IS_TOP = window === window.top;
  const CHILD_MSG = "__spacevoice_hotkey__";
  let childArmed = false; // child-frame local flag

  // ---------- cross-frame hotkey relay ----------
  // Speech recognition only works in the top frame (child iframes in Docs
  // lack the mic permission-policy). So child frames forward hotkey events
  // to the top via postMessage, and the top runs the state machine.
  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.t !== CHILD_MSG) return;
    if (IS_TOP) {
      const kind = ev.data.kind;
      if (kind === "down") handleDown(ev.data.shift);
      else if (kind === "up") handleUp();
    } else {
      // Only the child frame that actually has document focus should paste.
      // Every frame receives the message since we post via contentWindow, but
      // only one can be the text-input target at a time.
      if (ev.data.kind === "paste" && ev.data.text) {
        if (!document.hasFocus()) {
          LOG("child ignored paste (not focused)");
          return;
        }
        LOG("child received paste:", ev.data.text);
        pasteIntoDocs(ev.data.text);
      }
    }
  });

  // Send a paste to the iframe that currently has focus (if any).
  // If no child iframe is focused, dispatch locally in the top frame.
  function broadcastPaste(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const active = document.activeElement;
    LOG("broadcastPaste active=", active && active.tagName, "text=", JSON.stringify(trimmed));
    if (active && active.tagName === "IFRAME") {
      try {
        active.contentWindow.postMessage(
          { t: CHILD_MSG, kind: "paste", text: trimmed },
          "*"
        );
        LOG("posted to focused iframe");
        return;
      } catch (e) {
        WARN("iframe paste failed:", e);
      }
    }
    // No focused iframe — try every same-origin iframe that reports focus.
    const iframes = document.querySelectorAll("iframe");
    let sent = false;
    iframes.forEach((f) => {
      try {
        if (f.contentDocument && f.contentDocument.hasFocus && f.contentDocument.hasFocus()) {
          f.contentWindow.postMessage(
            { t: CHILD_MSG, kind: "paste", text: trimmed },
            "*"
          );
          LOG("posted to hasFocus iframe");
          sent = true;
        }
      } catch (_) {}
    });
    if (!sent) pasteIntoDocs(trimmed);
  }

  function relayToTop(kind, shift) {
    try {
      window.top.postMessage({ t: CHILD_MSG, kind, shift: !!shift }, "*");
    } catch (e) {
      WARN("relay failed:", e);
    }
  }

  function handleDown(shift) {
    if (spaceDown) return;
    LOG("handleDown shift=", shift);
    spaceDown = true;
    currentShift = shift;
    const active = document.activeElement;
    if (isEditable(active)) {
      lastEditable = active;
      lastSelection = captureSelection(active);
    }
    if (holdTimer) clearTimeout(holdTimer);
    // Shift+Space is an unambiguous dictate signal (no tap-to-type-space
    // conflict), so start recording immediately. Plain Space still uses the
    // HOLD_MS delay so a quick tap inserts a literal space.
    if (shift) {
      startRecording(currentShift);
      return;
    }
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (spaceDown) startRecording(currentShift);
    }, HOLD_MS);
  }

  function handleUp() {
    if (!spaceDown) return;
    spaceDown = false;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
      return;
    }
    if (recording) stopRecording();
  }

  // Block Docs' own input handlers that run on keypress / beforeinput /
  // textInput. preventDefault on keydown alone is not enough — Docs routes
  // text through its own listeners on the contenteditable iframe.
  function hardBlock(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "Space") return;
      if (!settings.enabled) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat) {
        if (recording || holdTimer || spaceDown || childArmed) hardBlock(e);
        return;
      }
      if (!shouldArm(e)) return; // let normal space behavior happen
      LOG("arming; active=", document.activeElement && document.activeElement.tagName);
      hardBlock(e);
      if (IS_TOP) {
        handleDown(e.shiftKey);
      } else {
        childArmed = true;
        relayToTop("down", e.shiftKey);
      }
    },
    true
  );

  // Belt-and-braces: swallow keypress/beforeinput while armed so Docs' own
  // handlers can't insert a space before/while we're recording.
  window.addEventListener(
    "keypress",
    (e) => {
      if (!settings.enabled) return;
      if (e.code !== "Space" && e.key !== " ") return;
      if (recording || holdTimer || spaceDown || childArmed) hardBlock(e);
    },
    true
  );
  window.addEventListener(
    "beforeinput",
    (e) => {
      if (!settings.enabled) return;
      if (!(recording || holdTimer || spaceDown || childArmed)) return;
      // We only care about plain space insertions from the hotkey, not pastes
      // from our own recognizer result.
      if (e.inputType === "insertText" && e.data === " ") hardBlock(e);
    },
    true
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (e.code !== "Space") return;
      if (!settings.enabled) return;
      // Only act if this frame (or the top frame) had armed something.
      if (IS_TOP) {
        if (!spaceDown) return;
        hardBlock(e);
        if (holdTimer && !IS_GOOGLE_DOCS) {
          const active = document.activeElement;
          if (isEditable(active)) typeSpace(active);
        }
        handleUp();
      } else {
        if (!childArmed) return;
        childArmed = false;
        hardBlock(e);
        relayToTop("up");
      }
    },
    true
  );

  // Safety: if window loses focus mid-record, stop
  window.addEventListener("blur", () => {
    spaceDown = false;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (recording) stopRecording();
  });
})();
