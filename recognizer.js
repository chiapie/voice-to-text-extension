// Web Speech API wrapper. Swappable with a local-Whisper module later.
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  class Recognizer {
    constructor() {
      this.rec = null;
      this.finalText = "";
      this.interimText = "";
      this.onInterim = null;
      this.resolve = null;
      this.reject = null;
      this.stopped = false;
    }

    isSupported() {
      return !!SR;
    }

    start(lang, onInterim) {
      if (!SR) return Promise.reject(new Error("SpeechRecognition not supported"));
      if (this.rec) this.stop();

      const rec = new SR();
      rec.lang = lang || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      this.rec = rec;
      this.finalText = "";
      this.interimText = "";
      this.onInterim = onInterim;
      this.stopped = false;

      return new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;

        rec.onresult = (ev) => {
          let interim = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const res = ev.results[i];
            const text = res[0].transcript;
            if (res.isFinal) {
              this.finalText += text;
            } else {
              interim += text;
            }
          }
          this.interimText = interim;
          if (this.onInterim) this.onInterim(this.finalText + interim);
        };

        rec.onerror = (ev) => {
          console.warn("[Spacevoice] recognition onerror:", ev.error, ev);
          if (ev.error === "no-speech" || ev.error === "aborted") {
            resolve(this.finalText.trim());
            this.rec = null;
            return;
          }
          reject(new Error(ev.error || "recognition error"));
          this.rec = null;
        };

        rec.onend = () => {
          if (this.resolve) {
            this.resolve((this.finalText + (this.stopped ? "" : this.interimText)).trim());
            this.resolve = null;
          }
          this.rec = null;
        };

        rec.onstart = () => console.log("[Spacevoice] recognition started");
        rec.onaudiostart = () => console.log("[Spacevoice] audio captured");
        rec.onspeechstart = () => console.log("[Spacevoice] speech detected");
        try {
          rec.start();
        } catch (e) {
          console.warn("[Spacevoice] rec.start() threw:", e);
          reject(e);
          this.rec = null;
        }
      });
    }

    stop() {
      this.stopped = true;
      if (this.rec) {
        try {
          this.rec.stop();
        } catch (_) {}
      }
    }

    abort() {
      this.stopped = true;
      if (this.rec) {
        try {
          this.rec.abort();
        } catch (_) {}
      }
    }
  }

  window.__VoiceExtRecognizer = new Recognizer();
})();
