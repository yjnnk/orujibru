const epubInput = document.getElementById("epubInput");
const tocList = document.getElementById("tocList");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const rateRange = document.getElementById("rateRange");
const rateValue = document.getElementById("rateValue");
const pauseRange = document.getElementById("pauseRange");
const pauseValue = document.getElementById("pauseValue");
const pitchRange = document.getElementById("pitchRange");
const pitchValue = document.getElementById("pitchValue");
const modelPathInput = document.getElementById("modelPath");
const voicesPathInput = document.getElementById("voicesPath");
const voiceSelect = document.getElementById("voiceSelect");
const langSelect = document.getElementById("langSelect");
const bookInfo = document.getElementById("bookInfo");
const chapterInfo = document.getElementById("chapterInfo");
const progressInfo = document.getElementById("progressInfo");
const errorInfo = document.getElementById("errorInfo");
const currentText = document.getElementById("currentText");
const chapterText = document.getElementById("chapterText");
const tocToggle = document.getElementById("tocToggle");
const fullBookToggle = document.getElementById("fullBookToggle");
const textPanel = document.querySelector(".text-panel");
let lastTextLength = 0;

let book = null;
let currentBookId = null;
let tocItems = [];
let currentChapterIndex = -1;
let segments = [];
let segmentIndex = 0;
let isPlaying = false;
let isPaused = false;
let playbackSessionId = 0;
let currentAudioUrl = null;
let pendingTimeout = null;
let currentAbortController = null;
let currentChapterText = "";
let voices = [];
let selectedVoice = "";
let defaultConfig = null;
let lastServerState = null;
let saveStateTimer = null;
let audioCache = new Map();
let prefetchInFlight = new Map();
let isFullBookView = false;
let fullBookHtml = "";
let fullBookLoading = false;
let tocLabelMap = new Map();
let loadToken = 0;
let isZipBook = false;
let lastRenderedSegmentIndex = -1;
let spineItemsCache = [];

const MAX_SEGMENT_LENGTH = 1000;
const DEFAULT_LANG = "en-us";
const DEFAULT_VOICE = "am_adam";
const PREFETCH_AHEAD = 4;
const MAX_PREFETCH_INFLIGHT = 2;
const LOAD_TIMEOUT_MS = 60000;

const audioPlayer = new Audio();

function updateButtons() {
  const hasBook = !!book;
  playBtn.disabled = !hasBook || segments.length === 0 || (isPlaying && !isPaused);
  pauseBtn.disabled = !hasBook || !isPlaying || isPaused;
  prevBtn.disabled = !hasBook || currentChapterIndex <= 0;
  nextBtn.disabled = !hasBook || currentChapterIndex < 0 || currentChapterIndex >= tocItems.length - 1;
}

function updateStatus() {
  if (!book) {
    bookInfo.textContent = "Nenhum livro carregado";
    chapterInfo.textContent = "Capítulo: —";
    progressInfo.textContent = "Progresso: —";
    currentText.textContent = "—";
    chapterText.textContent = "";
    return;
  }

  bookInfo.textContent = `Livro: ${book?.title || "EPUB"}`;
  if (currentChapterIndex >= 0 && tocItems[currentChapterIndex]) {
    chapterInfo.textContent = `Capítulo: ${tocItems[currentChapterIndex].label}`;
  } else {
    chapterInfo.textContent = "Capítulo: —";
  }
  if (segments.length > 0) {
    progressInfo.textContent = `Progresso: ${segmentIndex + 1}/${segments.length}`;
  } else {
    progressInfo.textContent = lastTextLength > 0 ? `Texto extraído: ${lastTextLength} caracteres` : "Progresso: —";
  }
}

function setError(message) {
  if (!message) {
    errorInfo.textContent = "";
    errorInfo.classList.add("hidden");
    return;
  }
  errorInfo.textContent = message;
  errorInfo.classList.remove("hidden");
}

function saveState() {
  if (!currentBookId) return;
  const state = {
    bookId: currentBookId,
    bookTitle: book?.title || "EPUB",
    chapterIndex: currentChapterIndex,
    segmentIndex,
    lastReadIndex: Math.max(0, segmentIndex - 1),
    rate: Number(rateRange.value),
    pause: Number(pauseRange.value),
    pitch: Number(pitchRange.value),
    modelPath: modelPathInput.value.trim(),
    voicesPath: voicesPathInput.value.trim(),
    voice: selectedVoice || DEFAULT_VOICE,
    lang: langSelect.value || DEFAULT_LANG,
  };
  localStorage.setItem(`audibook_state_${currentBookId}`, JSON.stringify(state));
  queueServerStateSave(state);
}

function loadState(bookId) {
  const raw = localStorage.getItem(`audibook_state_${bookId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function setRateDisplay(value) {
  rateValue.textContent = `${Number(value).toFixed(1)}x`;
}

function setPauseDisplay(value) {
  pauseValue.textContent = `${Number(value)}ms`;
}

function setPitchDisplay(value) {
  pitchValue.textContent = Number(value).toFixed(2);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout ao carregar ${label}.`)), ms);
    }),
  ]);
}

function resolvePath(base, relative) {
  if (!relative) return "";
  if (relative.startsWith("/")) return relative.replace(/^\//, "");
  const baseParts = base ? base.split("/") : [];
  baseParts.pop();
  const relParts = relative.split("/");
  const out = [...baseParts];
  relParts.forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") {
      out.pop();
      return;
    }
    out.push(part);
  });
  return out.join("/");
}

function findZipFilePath(zip, matcher) {
  const keys = Object.keys(zip.files || {});
  return keys.find(matcher) || "";
}

async function readZipText(zip, path) {
  const normalized = path.replace(/^\/+/, "");
  let file = zip.file(normalized);
  if (!file) {
    const lower = normalized.toLowerCase();
    const alt = findZipFilePath(zip, (key) => key.toLowerCase() === lower);
    if (alt) file = zip.file(alt);
  }
  if (!file) return "";
  return await file.async("string");
}

function parseXml(text) {
  const parser = new DOMParser();
  return parser.parseFromString(text, "application/xml");
}

function getFirstTextByTag(doc, tagNames) {
  for (const tag of tagNames) {
    const node = doc.getElementsByTagName(tag)[0];
    if (node && node.textContent) {
      const text = node.textContent.trim();
      if (text) return text;
    }
  }
  return "";
}

function buildZipBook(zip, opfPath, opfDoc) {
  const manifest = new Map();
  Array.from(opfDoc.getElementsByTagName("item")).forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type");
    if (id && href) {
      manifest.set(id, {
        id,
        href: resolvePath(opfPath, href),
        mediaType,
        properties: item.getAttribute("properties") || "",
      });
    }
  });

  const spineItems = [];
  Array.from(opfDoc.getElementsByTagName("itemref")).forEach((itemref, index) => {
    const idref = itemref.getAttribute("idref");
    const entry = manifest.get(idref);
    if (entry) {
      spineItems.push({
        idref,
        href: entry.href,
        index,
      });
    }
  });

  return {
    spineItems,
    async loadSection(href) {
      return await readZipText(zip, href);
    },
  };
}

function parseNcx(ncxText, basePath) {
  if (!ncxText) return [];
  const doc = parseXml(ncxText);
  const navPoints = Array.from(doc.getElementsByTagName("navPoint"));
  return navPoints
    .map((point) => {
      const label = getFirstTextByTag(point, ["text"]) || "Seção";
      const content = point.getElementsByTagName("content")[0];
      const src = content?.getAttribute("src") || "";
      if (!src) return null;
      return {
        label,
        href: resolvePath(basePath, src),
      };
    })
    .filter(Boolean);
}

function parseNav(navText, basePath) {
  if (!navText) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(navText, "text/html");
  const nav = doc.querySelector("nav[epub\\:type='toc'], nav#toc, nav.toc");
  if (!nav) return [];
  return Array.from(nav.querySelectorAll("a"))
    .map((a) => {
      const href = a.getAttribute("href");
      const label = a.textContent.trim();
      if (!href) return null;
      return {
        label: label || "Seção",
        href: resolvePath(basePath, href),
      };
    })
    .filter(Boolean);
}

async function loadZipEpub(file) {
  if (!window.JSZip) throw new Error("JSZip nao carregado.");
  const zip = await JSZip.loadAsync(file);
  let opfPath = "";
  const containerText = await readZipText(zip, "META-INF/container.xml");
  if (containerText) {
    const containerDoc = parseXml(containerText);
    const rootfile = containerDoc.getElementsByTagName("rootfile")[0];
    opfPath = rootfile?.getAttribute("full-path") || "";
  }
  if (!opfPath) {
    opfPath = findZipFilePath(zip, (key) => key.toLowerCase().endsWith(".opf"));
  }
  if (!opfPath) throw new Error("OPF nao encontrado.");
  const opfText = await readZipText(zip, opfPath);
  const opfDoc = parseXml(opfText);
  const title =
    getFirstTextByTag(opfDoc, ["dc:title", "title"]) ||
    "EPUB";

  const zipBook = buildZipBook(zip, opfPath, opfDoc);

  let tocItemsLocal = [];
  const navItem = Array.from(opfDoc.getElementsByTagName("item")).find((item) => {
    const properties = (item.getAttribute("properties") || "").split(/\s+/);
    return properties.includes("nav");
  });
  if (navItem) {
    const navHref = resolvePath(opfPath, navItem.getAttribute("href") || "");
    const navText = await readZipText(zip, navHref);
    tocItemsLocal = parseNav(navText, navHref);
  }

  if (!tocItemsLocal.length) {
    const items = Array.from(opfDoc.getElementsByTagName("item"));
    const ncxItem =
      items.find((item) => item.getAttribute("media-type") === "application/x-dtbncx+xml") ||
      items.find((item) => item.getAttribute("id") === "ncx");
    if (ncxItem) {
      const ncxHref = resolvePath(opfPath, ncxItem.getAttribute("href") || "");
      const ncxText = await readZipText(zip, ncxHref);
      tocItemsLocal = parseNcx(ncxText, ncxHref);
    }
  }

  return { title, zipBook, tocItems: tocItemsLocal };
}

function queueServerStateSave(state) {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    fetch("/api/last-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookId: state.bookId,
        bookTitle: state.bookTitle,
        chapterIndex: state.chapterIndex,
        segmentIndex: state.segmentIndex,
        lastReadIndex: state.lastReadIndex,
        updatedAt: Date.now(),
      }),
    }).catch(() => {});
  }, 250);
}

async function loadServerState() {
  try {
    const response = await fetch("/api/last-state", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    lastServerState = data && typeof data === "object" ? data : null;
  } catch (error) {
    lastServerState = null;
  }
  return lastServerState;
}

function getTtsConfig() {
  return {
    modelPath: modelPathInput.value.trim(),
    voicesPath: voicesPathInput.value.trim(),
    voice: selectedVoice || DEFAULT_VOICE,
    lang: langSelect.value || DEFAULT_LANG,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyDefaultConfig(config, force = false) {
  if (!config) return;
  if (config.modelPath && (force || !modelPathInput.value.trim())) {
    modelPathInput.value = String(config.modelPath);
  }
  if (config.voicesPath && (force || !voicesPathInput.value.trim())) {
    voicesPathInput.value = String(config.voicesPath);
  }
  if (config.lang && (force || !langSelect.value)) {
    langSelect.value = String(config.lang);
  }
  if (config.voice && (force || !selectedVoice)) {
    selectedVoice = String(config.voice);
  } else if (force && !selectedVoice) {
    selectedVoice = DEFAULT_VOICE;
  }
}

async function loadLocalConfig() {
  try {
    const response = await fetch("/local-config.json", { cache: "no-store" });
    if (!response.ok) {
      await loadVoices();
      return;
    }
    defaultConfig = await response.json();
    applyDefaultConfig(defaultConfig, true);
    await loadVoices();
  } catch (error) {
    console.warn("Nao foi possivel carregar local-config.json:", error);
    await loadVoices();
  }
}

async function loadVoices() {
  const modelPath = modelPathInput.value.trim();
  const voicesPath = voicesPathInput.value.trim();
  if (!modelPath || !voicesPath) {
    voiceSelect.innerHTML = "<option value=\"\">Informe o modelo e o arquivo de vozes</option>";
    return;
  }

  try {
    const response = await fetch("/api/voices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelPath, voicesPath }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Falha ao carregar vozes");
    }
    const data = await response.json();
    voices = Array.isArray(data.voices) ? data.voices : [];
    voiceSelect.innerHTML = "";
    if (!voices.length) {
      voiceSelect.innerHTML = "<option value=\"\">Nenhuma voz encontrada</option>";
      selectedVoice = "";
      return;
    }
    voices.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice;
      option.textContent = voice;
      voiceSelect.appendChild(option);
    });

    if (!selectedVoice || !voices.includes(selectedVoice)) {
      if (voices.includes(DEFAULT_VOICE)) {
        selectedVoice = DEFAULT_VOICE;
      } else {
        selectedVoice = data.defaultVoice && voices.includes(data.defaultVoice) ? data.defaultVoice : voices[0];
      }
    }
    voiceSelect.value = selectedVoice;
  } catch (error) {
    console.error("Erro ao carregar vozes:", error);
    voiceSelect.innerHTML = "<option value=\"\">Erro ao carregar vozes</option>";
    setError(error.message || "Falha ao carregar vozes.");
  }
}

function stopPlayback() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  cancelPrefetch();
  audioCache.clear();
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  isPlaying = false;
  isPaused = false;
  updateButtons();
}

async function fetchTtsAudio(text) {
  const { modelPath, voicesPath, voice, lang } = getTtsConfig();
  if (!modelPath || !voicesPath) {
    setError("Defina o caminho do modelo e do arquivo de vozes.");
    throw new Error("Kokoro config missing");
  }
  if (!voice) {
    setError("Selecione uma voz antes de iniciar.");
    throw new Error("Kokoro voice missing");
  }

  const controller = new AbortController();
  currentAbortController = controller;
  const cached = audioCache.get(segmentIndex);
  if (cached) return cached;
  const inflight = prefetchInFlight.get(segmentIndex);
  if (inflight?.request) {
    try {
      await inflight.request;
      const cachedAfter = audioCache.get(segmentIndex);
      if (cachedAfter) return cachedAfter;
    } catch (error) {
      prefetchInFlight.delete(segmentIndex);
    }
  }
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      modelPath,
      voicesPath,
      voice,
      speed: Number(rateRange.value),
      lang,
    }),
    signal: controller.signal,
  });
  currentAbortController = null;
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Falha ao gerar áudio");
  }
  const blob = await response.blob();
  audioCache.set(segmentIndex, blob);
  pruneAudioCache(segmentIndex);
  return blob;
}

function pruneAudioCache(centerIndex) {
  const keys = Array.from(audioCache.keys());
  keys.forEach((key) => {
    if (Math.abs(key - centerIndex) > PREFETCH_AHEAD) {
      audioCache.delete(key);
    }
  });
}

function prefetchSegment(index) {
  if (!segments.length || index < 0 || index >= segments.length) return;
  if (audioCache.has(index) || prefetchInFlight.has(index)) return;
  if (prefetchInFlight.size >= MAX_PREFETCH_INFLIGHT) return;
  const { modelPath, voicesPath, voice, lang } = getTtsConfig();
  if (!modelPath || !voicesPath || !voice) return;
  const controller = new AbortController();
  const text = segments[index];
  const request = fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      modelPath,
      voicesPath,
      voice,
      speed: Number(rateRange.value),
      lang,
    }),
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error("Falha ao pregerar audio");
      return response.blob();
    })
    .then((blob) => {
      audioCache.set(index, blob);
      pruneAudioCache(index);
    })
    .catch(() => {})
    .finally(() => {
      prefetchInFlight.delete(index);
    });

  prefetchInFlight.set(index, { controller, request });
}

function prefetchNextSegments(startIndex) {
  for (let i = 1; i <= PREFETCH_AHEAD; i += 1) {
    prefetchSegment(startIndex + i);
  }
}

function cancelPrefetch() {
  prefetchInFlight.forEach((value) => {
    if (value?.controller) value.controller.abort();
  });
  prefetchInFlight.clear();
}

async function speakCurrentSegment() {
  if (!segments.length || segmentIndex >= segments.length) {
    isPlaying = false;
    isPaused = false;
    updateButtons();
    return;
  }

  const sessionId = playbackSessionId;
  const text = segments[segmentIndex];
  let audioBlob;
  try {
    audioBlob = await fetchTtsAudio(text);
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error("Erro ao gerar áudio:", error);
    setError(error.message || "Falha ao gerar áudio com o Kokoro.");
    isPlaying = false;
    isPaused = false;
    updateButtons();
    return;
  }

  if (sessionId !== playbackSessionId) return;

  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
  }
  currentAudioUrl = URL.createObjectURL(audioBlob);
  audioPlayer.src = currentAudioUrl;
  audioPlayer.playbackRate = Number(rateRange.value);
  prefetchNextSegments(segmentIndex);
  audioPlayer.onended = () => {
    segmentIndex += 1;
    saveState();
    updateStatus();
    updateCurrentText();
    updateReadText();
    prefetchNextSegments(segmentIndex);
    if (isPlaying && !isPaused) {
      const pauseMs = Number(pauseRange.value) || 0;
      if (pauseMs > 0) {
        pendingTimeout = setTimeout(() => {
          if (isPlaying && !isPaused) speakCurrentSegment();
        }, pauseMs);
      } else {
        speakCurrentSegment();
      }
    }
  };
  audioPlayer.onerror = () => {
    isPlaying = false;
    isPaused = false;
    updateButtons();
    setError("Falha ao reproduzir o áudio do Kokoro.");
  };
  try {
    await audioPlayer.play();
  } catch (error) {
    console.error("Erro ao tocar áudio:", error);
    setError("Não foi possível reproduzir o áudio.");
    isPlaying = false;
    isPaused = false;
  }
  updateButtons();
}

function play() {
  if (!segments.length) return;
  if (isPlaying && isPaused) {
    isPaused = false;
    audioPlayer.playbackRate = Number(rateRange.value);
    audioPlayer.play().catch(() => {});
    updateButtons();
    return;
  }
  isPlaying = true;
  isPaused = false;
  playbackSessionId += 1;
  speakCurrentSegment();
}

function pause() {
  if (!isPlaying) return;
  isPaused = true;
  audioPlayer.pause();
  updateButtons();
}

function updateCurrentText() {
  if (!segments.length || segmentIndex >= segments.length) {
    currentText.textContent = "—";
    return;
  }
  currentText.textContent = segments[segmentIndex];
}

function updateReadText() {
  if (!segments.length || segmentIndex >= segments.length) {
    chapterText.textContent = "";
    return;
  }
  if (isFullBookView) return;
  if (!chapterText.querySelector(".segment")) {
    const html = segments
      .map((segment, index) => {
        const safeText = escapeHtml(segment);
        return `<p class="segment unread-text" data-seg-index="${index}">${safeText}</p>`;
      })
      .join("");
    chapterText.innerHTML = html;
  }

  if (lastRenderedSegmentIndex !== segmentIndex) {
    const previous = chapterText.querySelector(`.segment[data-seg-index="${lastRenderedSegmentIndex}"]`);
    if (previous) {
      previous.classList.remove("reading-now");
      previous.classList.add("read-text");
      previous.classList.remove("unread-text");
    }
    const currentNode = chapterText.querySelector(`.segment[data-seg-index="${segmentIndex}"]`);
    if (currentNode) {
      currentNode.classList.add("reading-now");
      currentNode.classList.remove("read-text");
      currentNode.classList.remove("unread-text");
      currentNode.scrollIntoView({ block: "center" });
    }
    lastRenderedSegmentIndex = segmentIndex;
  }
}

function splitSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+\s*/g);
  if (!matches) return [text];
  const tail = text.replace(matches.join(""), "").trim();
  if (tail) matches.push(tail);
  return matches.map((part) => part.trim()).filter(Boolean);
}

function segmentText(text) {
  const rawSegments = text
    .split(/\n{2,}/)
    .map((seg) => seg.trim())
    .filter(Boolean);

  const results = [];
  rawSegments.forEach((seg) => {
    if (seg.length <= MAX_SEGMENT_LENGTH) {
      results.push(seg);
      return;
    }
    const sentences = splitSentences(seg);
    let current = "";
    sentences.forEach((sentence) => {
      if ((current + " " + sentence).trim().length > MAX_SEGMENT_LENGTH) {
        if (current) results.push(current.trim());
        current = sentence;
      } else {
        current = `${current} ${sentence}`.trim();
      }
    });
    if (current) results.push(current.trim());
  });

  return results;
}

function extractTextFromDocument(doc) {
  if (!doc) return "";
  let parsedDoc = doc;
  if (typeof doc === "string") {
    const parser = new DOMParser();
    parsedDoc = parser.parseFromString(doc, "text/html");
  }

  const root = parsedDoc.body || parsedDoc.documentElement;
  if (!root) return "";

  const selectorsToRemove = [
    "nav",
    "footer",
    "aside",
    "script",
    "style",
    "[role=doc-noteref]",
    "[epub\\:type='noteref']",
  ];
  selectorsToRemove.forEach((selector) => {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  });

  const blockTags = new Set([
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "pre",
    "figcaption",
    "table",
    "tr",
    "td",
    "th",
  ]);
  const paragraphs = [];
  let buffer = [];

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
    buffer = [];
  };

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) buffer.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      flush();
      return;
    }
    const isBlock = blockTags.has(tag);
    if (isBlock) flush();
    node.childNodes.forEach((child) => walk(child));
    if (isBlock) flush();
  };

  walk(root);
  if (paragraphs.length) return paragraphs.join("\n\n");

  const bodyText = root.textContent || "";
  return bodyText.replace(/\s+/g, " ").trim();
}

function resolveSection(item, index) {
  if (!book) return null;
  if (item.idref) {
    const byId = book.spine.get(item.idref);
    if (byId) return byId;
  }
  if (item.href) {
    const byHref = book.spine.get(item.href);
    if (byHref) return byHref;
    const normalized = item.href.split("#")[0];
    const byNormalized = book.spine.spineItems.find((sec) => sec.href === normalized || sec.href?.endsWith(normalized));
    if (byNormalized) return byNormalized;
  }
  if (Number.isInteger(index) && book.spine.spineItems[index]) {
    return book.spine.spineItems[index];
  }
  return null;
}

function flattenToc(items, depth = 0) {
  const result = [];
  (items || []).forEach((item) => {
    if (item && (item.href || item.idref)) {
      const prefix = depth > 0 ? "- ".repeat(depth) : "";
      result.push({
        label: `${prefix}${item.label || "Seção"}`,
        href: item.href,
        idref: item.idref,
      });
    }
    if (item?.subitems?.length) {
      result.push(...flattenToc(item.subitems, depth + 1));
    }
  });
  return result;
}

async function loadChapter(index, resumeSegment = 0) {
  if (!book || !tocItems[index]) return;
  stopPlayback();
  setError("");
  lastTextLength = 0;

  const item = tocItems[index];
  let section = null;
  if (!isZipBook) {
    section = resolveSection(item, index);
    if (!section) {
      setError("Não foi possível abrir este capítulo.");
      return;
    }
  }

  let text = "";
  try {
    if (isZipBook) {
      const raw = await book.loadSection(item.href);
      text = extractTextFromDocument(raw);
    } else {
      const doc = await section.load(book.load.bind(book));
      text = extractTextFromDocument(doc);
      section.unload();
    }
  } catch (error) {
    console.error("Erro ao carregar capítulo:", error);
    setError("Falha ao ler o conteúdo do capítulo.");
    return;
  }

  if (!text && !isZipBook) {
    try {
      const raw = await book.load(section.href);
      text = extractTextFromDocument(raw);
    } catch (error) {
      console.error("Erro ao ler HTML bruto:", error);
    }
  }

  if (!text) {
    setError("Capítulo sem texto legível.");
  }

  lastTextLength = text.length;
  currentChapterText = text;
  chapterText.textContent = "";

  segments = segmentText(text);
  segmentIndex = Math.min(resumeSegment, segments.length - 1);
  if (segmentIndex < 0) segmentIndex = 0;
  lastRenderedSegmentIndex = -1;

  currentChapterIndex = index;
  updateCurrentText();
  updateReadText();
  updateStatus();
  updateButtons();
  saveState();
  prefetchSegment(segmentIndex);
  prefetchNextSegments(segmentIndex);
}

function renderToc() {
  tocList.innerHTML = "";
  tocItems.forEach((item, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = item.label;
    button.addEventListener("click", () => {
      loadChapter(index, 0).then(() => {
        play();
      });
    });
    li.appendChild(button);
    tocList.appendChild(li);
  });
}

function buildTocLabelMap() {
  tocLabelMap = new Map();
  tocItems.forEach((item) => {
    const href = item.href?.split("#")[0];
    if (href && !tocLabelMap.has(href)) {
      tocLabelMap.set(href, item.label);
    }
  });
}

function getSectionLabel(section, index) {
  const normalized = section?.href?.split("#")[0];
  if (normalized && tocLabelMap.has(normalized)) {
    return tocLabelMap.get(normalized);
  }
  return section?.idref ? `Capítulo ${index + 1}` : `Seção ${index + 1}`;
}

async function loadSpineChapter(spineIndex, resumeSegment = 0) {
  if (!spineItemsCache.length || !spineItemsCache[spineIndex]) return;
  stopPlayback();
  setError("");
  lastTextLength = 0;

  const item = spineItemsCache[spineIndex];
  let text = "";
  try {
    if (isZipBook) {
      const raw = await book.loadSection(item.href);
      text = extractTextFromDocument(raw);
    } else {
      const section = resolveSection(item, spineIndex);
      if (!section) {
        setError("Não foi possível abrir este capítulo.");
        return;
      }
      const doc = await section.load(book.load.bind(book));
      text = extractTextFromDocument(doc);
      section.unload();
    }
  } catch (error) {
    console.error("Erro ao carregar capítulo:", error);
    setError("Falha ao ler o conteúdo do capítulo.");
    return;
  }

  if (!text && !isZipBook) {
    try {
      const section = resolveSection(item, spineIndex);
      const raw = await book.load(section.href);
      text = extractTextFromDocument(raw);
    } catch (error) {
      console.error("Erro ao ler HTML bruto:", error);
    }
  }

  if (!text) {
    setError("Capítulo sem texto legível.");
  }

  lastTextLength = text.length;
  currentChapterText = text;
  chapterText.textContent = "";

  segments = segmentText(text);
  segmentIndex = Math.min(resumeSegment, segments.length - 1);
  if (segmentIndex < 0) segmentIndex = 0;
  lastRenderedSegmentIndex = -1;

  currentChapterIndex = spineIndex;
  updateCurrentText();
  updateReadText();
  updateStatus();
  updateButtons();
  saveState();
  prefetchSegment(segmentIndex);
  prefetchNextSegments(segmentIndex);
}

async function loadFullBookHtml() {
  if (!book) return "";
  if (fullBookHtml || fullBookLoading) return fullBookHtml;
  fullBookLoading = true;
  const parts = [];
  const spineItems = spineItemsCache.length
    ? spineItemsCache
    : isZipBook
      ? book.spineItems
      : book.spine.spineItems;
  spineItemsCache = spineItems;
  for (let i = 0; i < spineItems.length; i += 1) {
    const section = spineItems[i];
    let text = "";
    try {
      if (isZipBook) {
        const raw = await book.loadSection(section.href);
        text = extractTextFromDocument(raw);
      } else {
        const doc = await section.load(book.load.bind(book));
        text = extractTextFromDocument(doc);
        section.unload();
      }
    } catch (error) {
      console.error("Erro ao carregar seção do livro:", error);
      text = "";
    }
    if (!text) continue;
    const label = escapeHtml(getSectionLabel(section, i));
    parts.push(`<h3 class="book-section-title">${label}</h3>`);
    const segs = segmentText(text);
    const paragraphs = segs
      .map(
        (part, segIndex) =>
          `<p class="book-paragraph segment unread-text" data-spine-index="${i}" data-seg-index="${segIndex}">${escapeHtml(part)}</p>`
      )
      .join("");
    parts.push(paragraphs);
  }
  fullBookHtml = parts.join("");
  fullBookLoading = false;
  return fullBookHtml;
}

async function showFullBookView() {
  if (!chapterText) return;
  isFullBookView = true;
  if (textPanel) textPanel.classList.add("full-book");
  chapterText.innerHTML = "<p class=\"book-paragraph\">Carregando livro inteiro...</p>";
  const html = await loadFullBookHtml();
  if (!html) {
    chapterText.innerHTML = "<p class=\"book-paragraph\">Não foi possível carregar o livro inteiro.</p>";
    return;
  }
  chapterText.innerHTML = html;
}

function showChapterView() {
  isFullBookView = false;
  lastRenderedSegmentIndex = -1;
  if (textPanel) textPanel.classList.remove("full-book");
  updateReadText();
}

function setSegment(index, autoplay = false) {
  if (!segments.length) return;
  const clamped = Math.max(0, Math.min(index, segments.length - 1));
  if (clamped === segmentIndex) return;
  segmentIndex = clamped;
  saveState();
  updateStatus();
  updateCurrentText();
  updateReadText();
  if (autoplay) {
    stopPlayback();
    isPlaying = true;
    isPaused = false;
    playbackSessionId += 1;
    speakCurrentSegment();
  }
}

function getBookId(file) {
  return `${file.name}_${file.size}_${file.lastModified}`;
}

async function loadBook(file) {
  stopPlayback();
  setError("");
  try {
    loadToken += 1;
    const token = loadToken;
    currentBookId = getBookId(file);
    bookInfo.textContent = "Carregando livro...";
    isZipBook = false;

    // Prefer JSZip fallback first; it's more reliable for messy EPUBs.
    try {
      await loadBookWithZipFallback(file);
      return;
    } catch (error) {
      console.warn("Fallback JSZip falhou, tentando epub.js:", error);
    }

    book = ePub(file);

    const hardTimeout = setTimeout(() => {
      if (token !== loadToken) return;
      setError("Carregamento demorou demais. Tente novamente ou teste em modo anônimo (sem extensões).");
      updateStatus();
      updateButtons();
    }, LOAD_TIMEOUT_MS);

    const metadataPromise = withTimeout(book.loaded.metadata, LOAD_TIMEOUT_MS, "metadados")
      .then((metadata) => {
        book.title = metadata?.title || "EPUB";
      })
      .catch((error) => {
        console.warn("Falha ao carregar metadados:", error);
        book.title = "EPUB";
      });

    const navPromise = withTimeout(book.loaded.navigation, LOAD_TIMEOUT_MS, "navegação")
      .then((nav) => {
        tocItems = flattenToc(nav.toc || []);
      })
      .catch((error) => {
        console.warn("Falha ao carregar navegação:", error);
        tocItems = [];
      });

    try {
      await withTimeout(book.loaded.spine, LOAD_TIMEOUT_MS, "spine");
      await Promise.all([metadataPromise, navPromise]);
    } catch (error) {
      console.error("Falha ao carregar spine:", error);
      clearTimeout(hardTimeout);
      setError("Falha ao abrir o EPUB. Tente novamente ou use outro arquivo.");
      updateStatus();
      updateButtons();
      return;
    }
    clearTimeout(hardTimeout);

    if (tocItems.length === 0) {
      tocItems = book.spine.spineItems.map((item, index) => ({
        label: item.idref ? `Capítulo ${index + 1}` : `Seção ${index + 1}`,
        href: item.href,
        idref: item.idref,
      }));
    } else {
      const tocHrefs = new Set(tocItems.map((item) => item.href?.split("#")[0]).filter(Boolean));
      book.spine.spineItems.forEach((item, index) => {
        const normalized = item.href?.split("#")[0];
        if (normalized && !tocHrefs.has(normalized)) {
          tocItems.push({
            label: item.idref ? `Capítulo ${index + 1}` : `Seção ${index + 1}`,
            href: item.href,
            idref: item.idref,
          });
          tocHrefs.add(normalized);
        }
      });
    }

    renderToc();
    buildTocLabelMap();
    spineItemsCache = book.spine.spineItems || [];
    fullBookHtml = "";
    isFullBookView = false;
    if (fullBookToggle) {
      fullBookToggle.textContent = "Ver livro inteiro";
    }

    const state = loadState(currentBookId);
    if (!lastServerState) {
      await loadServerState();
    }
    const serverState = lastServerState && lastServerState.bookId === currentBookId ? lastServerState : null;
    if (state) {
      rateRange.value = state.rate || 1;
      pauseRange.value = state.pause ?? 300;
      pitchRange.value = state.pitch ?? 1;
      modelPathInput.value = state.modelPath || modelPathInput.value;
      voicesPathInput.value = state.voicesPath || voicesPathInput.value;
      selectedVoice = state.voice || selectedVoice;
      langSelect.value = state.lang || langSelect.value;
      applyDefaultConfig(defaultConfig, true);
      setRateDisplay(rateRange.value);
      setPauseDisplay(pauseRange.value);
      setPitchDisplay(pitchRange.value);
      await loadVoices();
      await loadChapter(state.chapterIndex ?? 0, state.segmentIndex ?? 0);
    } else if (serverState) {
      await loadVoices();
      await loadChapter(serverState.chapterIndex ?? 0, serverState.segmentIndex ?? 0);
    } else if (tocItems.length > 0) {
      await loadChapter(0, 0);
    }

    updateStatus();
    updateButtons();
  } catch (error) {
    console.error("Erro ao carregar EPUB:", error);
    setError("Falha ao carregar o EPUB. Verifique o console do navegador.");
    updateStatus();
    updateButtons();
  }
}

async function loadBookWithZipFallback(file) {
  const buffer = await file.arrayBuffer();
  const result = await withTimeout(loadZipEpub(buffer), LOAD_TIMEOUT_MS, "EPUB (JSZip)");
  book = result.zipBook;
  isZipBook = true;
  book.title = result.title || "EPUB";
  tocItems = result.tocItems || [];

  if (tocItems.length === 0) {
    tocItems = book.spineItems.map((item, index) => ({
      label: item.idref ? `Capítulo ${index + 1}` : `Seção ${index + 1}`,
      href: item.href,
      idref: item.idref,
    }));
  }

    renderToc();
    buildTocLabelMap();
    fullBookHtml = "";
    isFullBookView = false;
    spineItemsCache = isZipBook ? book.spineItems : book.spine.spineItems;
    if (fullBookToggle) fullBookToggle.textContent = "Ver livro inteiro";

  const state = loadState(currentBookId);
  if (state) {
    rateRange.value = state.rate || 1;
    pauseRange.value = state.pause ?? 300;
    pitchRange.value = state.pitch ?? 1;
    modelPathInput.value = state.modelPath || modelPathInput.value;
    voicesPathInput.value = state.voicesPath || voicesPathInput.value;
    selectedVoice = state.voice || selectedVoice;
    langSelect.value = state.lang || langSelect.value;
    applyDefaultConfig(defaultConfig, true);
    setRateDisplay(rateRange.value);
    setPauseDisplay(pauseRange.value);
    setPitchDisplay(pitchRange.value);
    await loadVoices();
    await loadChapter(state.chapterIndex ?? 0, state.segmentIndex ?? 0);
  } else if (tocItems.length > 0) {
    await loadChapter(0, 0);
  }

  updateStatus();
  updateButtons();
}

epubInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  loadBook(file);
});

playBtn.addEventListener("click", play);
pauseBtn.addEventListener("click", pause);
prevBtn.addEventListener("click", () => {
  if (currentChapterIndex > 0) {
    loadChapter(currentChapterIndex - 1, 0);
  }
});
nextBtn.addEventListener("click", () => {
  if (currentChapterIndex < tocItems.length - 1) {
    loadChapter(currentChapterIndex + 1, 0);
  }
});

rateRange.addEventListener("input", (event) => {
  setRateDisplay(event.target.value);
  if (isPlaying && !isPaused) {
    audioPlayer.playbackRate = Number(event.target.value);
  }
  audioCache.clear();
  cancelPrefetch();
  saveState();
});

pauseRange.addEventListener("input", (event) => {
  setPauseDisplay(event.target.value);
  saveState();
});

pitchRange.addEventListener("input", (event) => {
  setPitchDisplay(event.target.value);
  saveState();
});

modelPathInput.addEventListener("change", () => {
  saveState();
  audioCache.clear();
  cancelPrefetch();
  loadVoices();
});

voicesPathInput.addEventListener("change", () => {
  saveState();
  audioCache.clear();
  cancelPrefetch();
  loadVoices();
});

voiceSelect.addEventListener("change", (event) => {
  selectedVoice = event.target.value;
  audioCache.clear();
  cancelPrefetch();
  saveState();
});

langSelect.addEventListener("change", () => {
  audioCache.clear();
  cancelPrefetch();
  saveState();
});

if (!langSelect.value) {
  langSelect.value = DEFAULT_LANG;
}

setRateDisplay(rateRange.value);
setPauseDisplay(pauseRange.value);
setPitchDisplay(pitchRange.value);
loadLocalConfig();
loadServerState();
updateButtons();
updateStatus();

if (tocToggle) {
  const section = tocToggle.closest(".chapter-list");
  if (section) {
    const isCollapsed = section.classList.contains("collapsed");
    tocToggle.textContent = isCollapsed ? "Mostrar" : "Ocultar";
  }
  tocToggle.addEventListener("click", () => {
    const section = tocToggle.closest(".chapter-list");
    if (!section) return;
    section.classList.toggle("collapsed");
    const isCollapsed = section.classList.contains("collapsed");
    tocToggle.textContent = isCollapsed ? "Mostrar" : "Ocultar";
  });
}

if (fullBookToggle) {
  fullBookToggle.addEventListener("click", () => {
    if (isFullBookView) {
      showChapterView();
      fullBookToggle.textContent = "Ver livro inteiro";
    } else {
      showFullBookView();
      fullBookToggle.textContent = "Ver só capítulo";
    }
  });
}

if (chapterText) {
  chapterText.addEventListener("click", (event) => {
    const target = event.target.closest("[data-seg-index]");
    if (!target) return;
    const index = Number(target.dataset.segIndex);
    if (Number.isNaN(index)) return;
    if (isFullBookView) {
      const spineIndex = Number(target.dataset.spineIndex);
      if (Number.isNaN(spineIndex)) return;
      loadSpineChapter(spineIndex, index).then(() => {
        play();
      });
      return;
    }
    setSegment(index, true);
  });
}
