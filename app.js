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
const langInput = document.getElementById("langInput");
const bookInfo = document.getElementById("bookInfo");
const chapterInfo = document.getElementById("chapterInfo");
const progressInfo = document.getElementById("progressInfo");
const errorInfo = document.getElementById("errorInfo");
const currentText = document.getElementById("currentText");
const chapterText = document.getElementById("chapterText");
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

const MAX_SEGMENT_LENGTH = 1000;
const DEFAULT_LANG = "pt-br";

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
    chapterIndex: currentChapterIndex,
    segmentIndex,
    rate: Number(rateRange.value),
    pause: Number(pauseRange.value),
    pitch: Number(pitchRange.value),
    modelPath: modelPathInput.value.trim(),
    voicesPath: voicesPathInput.value.trim(),
    voice: selectedVoice,
    lang: langInput.value.trim(),
  };
  localStorage.setItem(`audibook_state_${currentBookId}`, JSON.stringify(state));
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

function getTtsConfig() {
  return {
    modelPath: modelPathInput.value.trim(),
    voicesPath: voicesPathInput.value.trim(),
    voice: selectedVoice,
    lang: langInput.value.trim() || DEFAULT_LANG,
  };
}

function applyDefaultConfig(config, force = false) {
  if (!config) return;
  if (config.modelPath && (force || !modelPathInput.value.trim())) {
    modelPathInput.value = String(config.modelPath);
  }
  if (config.voicesPath && (force || !voicesPathInput.value.trim())) {
    voicesPathInput.value = String(config.voicesPath);
  }
  if (config.lang && (force || !langInput.value.trim())) {
    langInput.value = String(config.lang);
  }
  if (config.voice && (force || !selectedVoice)) {
    selectedVoice = String(config.voice);
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
      selectedVoice = data.defaultVoice && voices.includes(data.defaultVoice) ? data.defaultVoice : voices[0];
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
  return response.blob();
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
  audioPlayer.onended = () => {
    segmentIndex += 1;
    saveState();
    updateStatus();
    updateCurrentText();
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

  const selectorsToRemove = [
    "nav",
    "header",
    "footer",
    "aside",
    "script",
    "style",
    "[role=doc-noteref]",
    "[epub\\:type='noteref']",
  ];
  selectorsToRemove.forEach((selector) => {
    parsedDoc.querySelectorAll(selector).forEach((node) => node.remove());
  });

  const paragraphs = Array.from(parsedDoc.body?.querySelectorAll("p") || [])
    .map((node) => node.textContent.trim())
    .filter(Boolean);

  if (paragraphs.length) {
    return paragraphs.join("\n\n");
  }

  const bodyText = parsedDoc.body?.textContent || parsedDoc.documentElement?.textContent || "";
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

async function loadChapter(index, resumeSegment = 0) {
  if (!book || !tocItems[index]) return;
  stopPlayback();
  setError("");
  lastTextLength = 0;

  const item = tocItems[index];
  const section = resolveSection(item, index);
  if (!section) {
    setError("Não foi possível abrir este capítulo.");
    return;
  }

  let text = "";
  try {
    const doc = await section.load(book.load.bind(book));
    text = extractTextFromDocument(doc);
    section.unload();
  } catch (error) {
    console.error("Erro ao carregar capítulo:", error);
    setError("Falha ao ler o conteúdo do capítulo.");
    return;
  }

  if (!text) {
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
  chapterText.textContent = currentChapterText;

  segments = segmentText(text);
  segmentIndex = Math.min(resumeSegment, segments.length - 1);
  if (segmentIndex < 0) segmentIndex = 0;

  currentChapterIndex = index;
  updateCurrentText();
  updateStatus();
  updateButtons();
  saveState();
}

function renderToc() {
  tocList.innerHTML = "";
  tocItems.forEach((item, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = item.label;
    button.addEventListener("click", () => {
      loadChapter(index, 0);
    });
    li.appendChild(button);
    tocList.appendChild(li);
  });
}

function getBookId(file) {
  return `${file.name}_${file.size}_${file.lastModified}`;
}

async function loadBook(file) {
  stopPlayback();
  setError("");
  try {
    book = ePub(file);
    currentBookId = getBookId(file);
    bookInfo.textContent = "Carregando livro...";

    const metadata = await book.loaded.metadata;
    book.title = metadata?.title || "EPUB";

    const nav = await book.loaded.navigation;
    tocItems = nav.toc || [];

    if (tocItems.length === 0) {
      tocItems = book.spine.spineItems.map((item, index) => ({
        label: item.idref ? `Capítulo ${index + 1}` : `Seção ${index + 1}`,
        href: item.href,
        idref: item.idref,
      }));
    }

    renderToc();

    const state = loadState(currentBookId);
    if (state) {
      rateRange.value = state.rate || 1;
      pauseRange.value = state.pause ?? 300;
      pitchRange.value = state.pitch ?? 1;
      modelPathInput.value = state.modelPath || modelPathInput.value;
      voicesPathInput.value = state.voicesPath || voicesPathInput.value;
      selectedVoice = state.voice || selectedVoice;
      langInput.value = state.lang || langInput.value;
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
  } catch (error) {
    console.error("Erro ao carregar EPUB:", error);
    setError("Falha ao carregar o EPUB. Verifique o console do navegador.");
    updateStatus();
    updateButtons();
  }
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
  loadVoices();
});

voicesPathInput.addEventListener("change", () => {
  saveState();
  loadVoices();
});

voiceSelect.addEventListener("change", (event) => {
  selectedVoice = event.target.value;
  saveState();
});

langInput.addEventListener("change", () => {
  saveState();
});

if (!langInput.value) {
  langInput.value = DEFAULT_LANG;
}

setRateDisplay(rateRange.value);
setPauseDisplay(pauseRange.value);
setPitchDisplay(pitchRange.value);
loadLocalConfig();
updateButtons();
updateStatus();
