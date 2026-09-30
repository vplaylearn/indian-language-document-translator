import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createWorker, PSM } from "tesseract.js";
import {
  addBookmark,
  bookmarkKey,
  fetchBookmarks,
  getClientId,
  removeBookmark,
  type Bookmark,
} from "./bookmarks";
import "./styles.css";

type Language = "eng" | "hin" | "tam" | "tel" | "kan";

type TranslationLanguage = "en" | "hi" | "ta" | "te" | "kn";

type WordTranslation = {
  source: string;
  target: string;
};

const LANGUAGES: Array<{
  code: Language;
  label: string;
}> = [
  { code: "eng", label: "English" },
  { code: "hin", label: "Hindi" },
  { code: "tam", label: "Tamil" },
  { code: "tel", label: "Telugu" },
  { code: "kan", label: "Kannada" },
];

const TRANSLATION_LANGUAGES: Array<{
  code: TranslationLanguage;
  label: string;
}> = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "kn", label: "Kannada" },
];

const OCR_TO_TRANSLATION: Record<
  Language,
  TranslationLanguage
> = {
  eng: "en",
  hin: "hi",
  tam: "ta",
  tel: "te",
  kan: "kn",
};

const TTS_LANGUAGES: Record<
  TranslationLanguage,
  string
> = {
  en: "en-IN",
  hi: "hi-IN",
  ta: "ta-IN",
  te: "te-IN",
  kn: "kn-IN",
};

const TRANSLATION_API = "/api/translate";

function getLanguageLabel(language: Language): string {
  return (
    LANGUAGES.find(
      (item) => item.code === language
    )?.label ?? language
  );
}

function getTranslationLanguageLabel(
  language: TranslationLanguage
): string {
  return (
    TRANSLATION_LANGUAGES.find(
      (item) => item.code === language
    )?.label ?? language
  );
}

function normalizeWord(word: string): string {
  return word
    .trim()
    .replace(
      /^[.,!?;:"'()[\]{}<>]+|[.,!?;:"'()[\]{}<>]+$/g,
      ""
    )
    .trim();
}

function getWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

function App() {
  const [sourceLanguage, setSourceLanguage] =
    useState<Language>("hin");

  const [targetLanguage, setTargetLanguage] =
    useState<TranslationLanguage>("en");

  const [imageUrl, setImageUrl] =
    useState<string>("");

  const [selectedFile, setSelectedFile] =
    useState<File | null>(null);

  const [ocrText, setOcrText] =
    useState<string>("");

  const [translation, setTranslation] =
    useState<string>("");

  const [wordTranslations, setWordTranslations] =
    useState<WordTranslation[]>([]);

  const [status, setStatus] =
    useState<string>("");

  const [isProcessing, setIsProcessing] =
    useState<boolean>(false);

  const [cameraOpen, setCameraOpen] =
    useState<boolean>(false);

  const [isSourceSpeaking, setIsSourceSpeaking] =
    useState<boolean>(false);

  const [isTranslationSpeaking, setIsTranslationSpeaking] =
    useState<boolean>(false);

  const [bookmarks, setBookmarks] =
    useState<Bookmark[]>([]);

  const [bookmarkBusy, setBookmarkBusy] =
    useState<Set<string>>(new Set());

  const [bookmarksOpen, setBookmarksOpen] =
    useState<boolean>(false);

  const [bookmarkFilter, setBookmarkFilter] =
    useState<string>("");

  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(new Set());

  const clientIdRef =
    useRef<string>("");

  const fileInputRef =
    useRef<HTMLInputElement | null>(null);

  const videoRef =
    useRef<HTMLVideoElement | null>(null);

  const canvasRef =
    useRef<HTMLCanvasElement | null>(null);

  const cameraStreamRef =
    useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();

      if (cameraStreamRef.current) {
        cameraStreamRef.current
          .getTracks()
          .forEach((track) => track.stop());
      }

      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [imageUrl]);

  /*
   * Load this browser's saved bookmarks once on mount.
   */
  useEffect(() => {
    clientIdRef.current = getClientId();

    fetchBookmarks(clientIdRef.current)
      .then(setBookmarks)
      .catch((error) => {
        console.error("Failed to load bookmarks:", error);
      });
  }, []);

  /*
   * Close the bookmarks panel on Escape.
   */
  useEffect(() => {
    if (!bookmarksOpen) {
      return;
    }

    function onKeyDown(
      event: KeyboardEvent
    ) {
      if (event.key === "Escape") {
        setBookmarksOpen(false);
      }
    }

    window.addEventListener(
      "keydown",
      onKeyDown
    );

    return () =>
      window.removeEventListener(
        "keydown",
        onKeyDown
      );
  }, [bookmarksOpen]);

  /*
   * Load browser speech voices.
   *
   * Chrome/Edge may initially return an empty
   * voice list and populate it later through
   * the voiceschanged event.
   */
  useEffect(() => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    const loadVoices = () => {
      const voices =
        window.speechSynthesis.getVoices();

      console.log(
        "Available speech voices:",
        voices.map((voice) => ({
          name: voice.name,
          lang: voice.lang,
          localService: voice.localService,
        }))
      );
    };

    loadVoices();

    window.speechSynthesis.addEventListener(
      "voiceschanged",
      loadVoices
    );

    return () => {
      window.speechSynthesis.removeEventListener(
        "voiceschanged",
        loadVoices
      );
    };
  }, []);

  /*
   * Find the best browser voice for a language.
   */
  function getVoice(
    language: TranslationLanguage
  ): SpeechSynthesisVoice | undefined {
    if (!("speechSynthesis" in window)) {
      return undefined;
    }

    const voices =
      window.speechSynthesis.getVoices();

    const targetLang =
      TTS_LANGUAGES[language].toLowerCase();

    /*
     * First try exact match:
     * hi-IN
     * ta-IN
     * te-IN
     * kn-IN
     * en-IN
     */
    const exactVoice = voices.find(
      (voice) =>
        voice.lang.toLowerCase() ===
        targetLang
    );

    if (exactVoice) {
      return exactVoice;
    }

    /*
     * Then try language prefix:
     * hi
     * ta
     * te
     * kn
     * en
     */
    const languagePrefix =
      language.toLowerCase();

    const prefixVoice = voices.find(
      (voice) =>
        voice.lang
          .toLowerCase()
          .startsWith(languagePrefix)
    );

    if (prefixVoice) {
      return prefixVoice;
    }

    return undefined;
  }

  function handleFileChange(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const file =
      event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setStatus(
        "Please select an image file."
      );
      return;
    }

    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }

    const url =
      URL.createObjectURL(file);

    setSelectedFile(file);
    setImageUrl(url);

    setOcrText("");
    setTranslation("");
    setWordTranslations([]);

    setStatus(
      "Image selected. Click Read & Translate."
    );
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  async function openCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(
          "Camera access is not supported by this browser."
        );
        return;
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
          },
          audio: false,
        });

      cameraStreamRef.current = stream;

      setCameraOpen(true);

      if (videoRef.current) {
        videoRef.current.srcObject =
          stream;

        await videoRef.current.play();
      }

      setStatus(
        "Camera opened. Capture an image."
      );
    } catch (error) {
      console.error(
        "Camera error:",
        error
      );

      setStatus(
        "Unable to access the camera. Please allow camera permission."
      );
    }
  }

  function closeCamera() {
    if (cameraStreamRef.current) {
      cameraStreamRef.current
        .getTracks()
        .forEach((track) => track.stop());

      cameraStreamRef.current = null;
    }

    setCameraOpen(false);
  }

  function captureImage() {
    const video =
      videoRef.current;

    const canvas =
      canvasRef.current;

    if (!video || !canvas) {
      return;
    }

    if (
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      setStatus(
        "Camera is not ready yet."
      );
      return;
    }

    canvas.width =
      video.videoWidth;

    canvas.height =
      video.videoHeight;

    const context =
      canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height
    );

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setStatus(
            "Unable to capture image."
          );
          return;
        }

        const file =
          new File(
            [blob],
            `camera-${Date.now()}.jpg`,
            {
              type: "image/jpeg",
            }
          );

        if (imageUrl) {
          URL.revokeObjectURL(imageUrl);
        }

        const url =
          URL.createObjectURL(file);

        setSelectedFile(file);
        setImageUrl(url);

        setOcrText("");
        setTranslation("");
        setWordTranslations([]);

        setStatus(
          "Image captured. Click Read & Translate."
        );

        closeCamera();
      },
      "image/jpeg",
      0.92
    );
  }

  async function performOCR(
    file: File
  ): Promise<string> {
    const language =
      sourceLanguage;

    setStatus(
      `Reading ${getLanguageLabel(
        language
      )} text from image...`
    );

    /*
     * Tesseract worker.
     */
    const worker =
      await createWorker(language);

    try {
      await worker.setParameters({
        tessedit_pageseg_mode:
          PSM.AUTO,
      });

      const result =
        await worker.recognize(file);

      const detectedText =
        result.data.text.trim();

      return detectedText;
    } finally {
      await worker.terminate();
    }
  }

  async function translateText(
    text: string
  ) {
    setStatus(
      `Translating ${getLanguageLabel(
        sourceLanguage
      )} → ${getTranslationLanguageLabel(
        targetLanguage
      )}...`
    );

    const response =
      await fetch(
        TRANSLATION_API,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            text,
            source:
              OCR_TO_TRANSLATION[
                sourceLanguage
              ],
            target:
              targetLanguage,
          }),
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error ||
          `Translation failed with HTTP ${response.status}`
      );
    }

    setTranslation(
      data.translation || ""
    );

    setWordTranslations(
      Array.isArray(data.words)
        ? data.words
        : []
    );

    return data;
  }

  async function handleReadAndTranslate(
    event?: FormEvent
  ) {
    event?.preventDefault();

    if (!selectedFile) {
      setStatus(
        "Please upload or capture an image first."
      );
      return;
    }

    setIsProcessing(true);

    setOcrText("");
    setTranslation("");
    setWordTranslations([]);

    try {
      /*
       * Step 1:
       * OCR
       */
      const detectedText =
        await performOCR(
          selectedFile
        );

      if (!detectedText) {
        setStatus(
          "No readable text was detected in the image."
        );
        return;
      }

      setOcrText(
        detectedText
      );

      /*
       * Step 2:
       * Translation
       */
      await translateText(
        detectedText
      );

      setStatus(
        "Text detected and translated successfully."
      );
    } catch (error) {
      console.error(
        "Read & Translate error:",
        error
      );

      setStatus(
        error instanceof Error
          ? error.message
          : "Unable to process the image."
      );
    } finally {
      setIsProcessing(false);
    }
  }

  /*
   * Speak arbitrary text.
   */
  function speakText(
    text: string,
    language: TranslationLanguage,
    onStart?: () => void,
    onEnd?: () => void
  ) {
    if (!text.trim()) {
      return;
    }

    if (
      !("speechSynthesis" in window)
    ) {
      setStatus(
        "Text-to-speech is not supported by this browser."
      );
      return;
    }

    /*
     * Stop previous speech.
     */
    window.speechSynthesis.cancel();

    const utterance =
      new SpeechSynthesisUtterance(
        text.trim()
      );

    const ttsLanguage =
      TTS_LANGUAGES[language];

    utterance.lang =
      ttsLanguage;

    utterance.rate = 0.85;
    utterance.pitch = 1;
    utterance.volume = 1;

    const voice =
      getVoice(language);

    if (voice) {
      utterance.voice =
        voice;

      console.log(
        `Using voice: ${voice.name} (${voice.lang})`
      );
    } else {
      console.warn(
        `No browser voice found for ${ttsLanguage}`
      );
    }

    utterance.onstart = () => {
      onStart?.();
    };

    utterance.onend = () => {
      onEnd?.();
    };

    utterance.onerror = (
      event
    ) => {
      console.error(
        "Speech synthesis error:",
        event
      );

      onEnd?.();

      setStatus(
        `Unable to read the text. Browser voice for ${ttsLanguage} may not be available.`
      );
    };

    /*
     * Small delay helps Chrome/Edge initialize
     * the speech engine after cancel().
     */
    window.setTimeout(() => {
      window.speechSynthesis.speak(
        utterance
      );
    }, 100);
  }

  /*
   * Read detected OCR text.
   */
  function speakSourceText() {
    if (!ocrText.trim()) {
      return;
    }

    const source =
      OCR_TO_TRANSLATION[
        sourceLanguage
      ];

    setIsSourceSpeaking(true);

    speakText(
      ocrText,
      source,
      () => {
        setIsSourceSpeaking(true);

        setStatus(
          `Reading detected text in ${getLanguageLabel(
            sourceLanguage
          )}...`
        );
      },
      () => {
        setIsSourceSpeaking(false);
      }
    );
  }

  /*
   * Stop detected-text speech.
   */
  function stopSourceText() {
    if (
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.cancel();
    }

    setIsSourceSpeaking(false);
  }

  /*
   * Read translated text.
   */
  function speakTranslation() {
    if (!translation.trim()) {
      return;
    }

    setIsTranslationSpeaking(true);

    speakText(
      translation,
      targetLanguage,
      () => {
        setIsTranslationSpeaking(
          true
        );

        setStatus(
          `Reading translation in ${getTranslationLanguageLabel(
            targetLanguage
          )}...`
        );
      },
      () => {
        setIsTranslationSpeaking(
          false
        );
      }
    );
  }

  /*
   * Bookmark helpers.
   */
  function findBookmark(
    source: string,
    target: string,
    sourceLang: string,
    targetLang: string
  ): Bookmark | undefined {
    const key = bookmarkKey({
      source,
      target,
      sourceLang,
      targetLang,
    });

    return bookmarks.find(
      (b) =>
        bookmarkKey(b) === key
    );
  }

  async function toggleBookmark(
    source: string,
    target: string,
    sourceLang: string,
    targetLang: string
  ) {
    const clientId =
      clientIdRef.current;

    if (!clientId) {
      return;
    }

    const key = bookmarkKey({
      source,
      target,
      sourceLang,
      targetLang,
    });

    // Ignore rapid double-clicks on the same word while a request is in flight.
    if (bookmarkBusy.has(key)) {
      return;
    }

    setBookmarkBusy((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

    const existing = findBookmark(
      source,
      target,
      sourceLang,
      targetLang
    );

    try {
      if (existing) {
        await removeBookmark(
          clientId,
          existing.id
        );

        setBookmarks((prev) =>
          prev.filter(
            (b) => b.id !== existing.id
          )
        );
      } else {
        const saved = await addBookmark(
          clientId,
          {
            source,
            target,
            sourceLang,
            targetLang,
          }
        );

        if (saved) {
          setBookmarks((prev) =>
            // Guard against a duplicate the server may return.
            prev.some(
              (b) => b.id === saved.id
            )
              ? prev
              : [saved, ...prev]
          );
        }
      }
    } catch (error) {
      console.error(
        "Bookmark toggle failed:",
        error
      );

      setStatus(
        error instanceof Error
          ? error.message
          : "Could not update bookmark."
      );
    } finally {
      setBookmarkBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /*
   * Read individual word.
   */
  function speakWord(
    word: string,
    language: TranslationLanguage
  ) {
    if (!word.trim()) {
      return;
    }

    speakText(word, language);
  }

  /*
   * Search a word's meaning.
   */
  function searchWordMeaning(
    word: string,
    inLanguageLabel?: string
  ) {
    const cleanWord =
      word.trim();

    if (!cleanWord) {
      return;
    }

    // e.g. "हर in English"; falls back to "<word> meaning".
    const query = inLanguageLabel
      ? `${cleanWord} in ${inLanguageLabel}`
      : `${cleanWord} meaning`;

    const searchUrl =
      `https://www.google.com/search?q=${encodeURIComponent(
        query
      )}`;

    window.open(
      searchUrl,
      "_blank",
      "noopener,noreferrer"
    );
  }

  /*
   * Swap source and target languages.
   */
  function swapLanguages() {
    const newSource =
      targetLanguage;

    const newTarget =
      OCR_TO_TRANSLATION[
        sourceLanguage
      ];

    /*
     * Only supported OCR languages
     * can become source languages.
     */
    const matchingOCRLanguage =
      LANGUAGES.find(
        (language) =>
          OCR_TO_TRANSLATION[
            language.code
          ] === newSource
      );

    if (!matchingOCRLanguage) {
      setStatus(
        "This language cannot currently be selected as an OCR source."
      );
      return;
    }

    setSourceLanguage(
      matchingOCRLanguage.code
    );

    setTargetLanguage(
      newTarget
    );

    setOcrText("");
    setTranslation("");
    setWordTranslations([]);

    setStatus(
      `Language direction changed to ${getLanguageLabel(
        matchingOCRLanguage.code
      )} → ${getTranslationLanguageLabel(
        newTarget
      )}.`
    );
  }

  const sourceTranslationLanguage =
    OCR_TO_TRANSLATION[
      sourceLanguage
    ];

  /*
   * Group saved words by their source language, so the sidebar shows
   * one section per language (Hindi, Tamil, ...). Unknown/blank codes
   * fall into an "Other" bucket.
   */
  const groupedBookmarks = (() => {
    const query = bookmarkFilter
      .trim()
      .toLowerCase();

    const filtered = query
      ? bookmarks.filter(
          (b) =>
            b.source
              .toLowerCase()
              .includes(query) ||
            b.target
              .toLowerCase()
              .includes(query)
        )
      : bookmarks;

    const groups = new Map<
      string,
      { lang: string; label: string; items: Bookmark[] }
    >();

    for (const bookmark of filtered) {
      const lang = bookmark.sourceLang || "other";
      const label = bookmark.sourceLang
        ? getTranslationLanguageLabel(
            bookmark.sourceLang as TranslationLanguage
          )
        : "Other";

      if (!groups.has(lang)) {
        groups.set(lang, { lang, label, items: [] });
      }

      groups.get(lang)!.items.push(bookmark);
    }

    return Array.from(groups.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  })();

  /*
   * Star button that toggles a bookmark for a source/target word pair.
   */
  function renderStar(
    source: string,
    target: string,
    sourceLang: string,
    targetLang: string
  ) {
    const saved = Boolean(
      findBookmark(
        source,
        target,
        sourceLang,
        targetLang
      )
    );

    const busy = bookmarkBusy.has(
      bookmarkKey({
        source,
        target,
        sourceLang,
        targetLang,
      })
    );

    return (
      <button
        type="button"
        className={`word-star${
          saved ? " is-saved" : ""
        }`}
        onClick={() =>
          toggleBookmark(
            source,
            target,
            sourceLang,
            targetLang
          )
        }
        disabled={busy}
        aria-pressed={saved}
        title={
          saved
            ? "Remove bookmark"
            : "Bookmark this word"
        }
      >
        {saved ? "★" : "☆"}
      </button>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="container nav">
          <div className="nav-brand">
            <h1>
              Multilingual Image Translator
            </h1>

            <p>
              Read and translate English,
              Hindi, Tamil, Telugu and
              Kannada text from images.
            </p>
          </div>

          <div className="nav-actions">
            <button
              type="button"
              className={`nav-bookmarks-button${
                bookmarksOpen
                  ? " is-open"
                  : ""
              }`}
              onClick={() =>
                setBookmarksOpen(
                  (open) => !open
                )
              }
              aria-expanded={bookmarksOpen}
              title="Saved words"
            >
              ★ Bookmarks
              <span className="nav-bookmarks-count">
                {bookmarks.length}
              </span>
            </button>

            {bookmarksOpen && (
              <div
                className="bookmarks-backdrop"
                onClick={() =>
                  setBookmarksOpen(false)
                }
              />
            )}

            {bookmarksOpen && (
              <div
                className="bookmarks-panel"
                role="dialog"
                aria-label="Saved words"
              >
                <div className="bookmarks-panel-header">
                  <h2>
                    ★ Saved Words
                    <span className="bookmark-count">
                      {bookmarks.length}
                    </span>
                  </h2>

                  <button
                    type="button"
                    className="bookmarks-panel-close"
                    onClick={() =>
                      setBookmarksOpen(
                        false
                      )
                    }
                    title="Close"
                  >
                    ✕
                  </button>
                </div>

                {bookmarks.length > 0 && (
                  <input
                    type="search"
                    className="bookmarks-search"
                    placeholder="Search saved words..."
                    value={bookmarkFilter}
                    onChange={(event) =>
                      setBookmarkFilter(
                        event.target.value
                      )
                    }
                  />
                )}

                {bookmarks.length ===
                0 ? (
                  <p className="bookmarks-empty">
                    No saved words yet.
                    Tap the ☆ next to a
                    word to save it.
                  </p>
                ) : groupedBookmarks.length ===
                  0 ? (
                  <p className="bookmarks-empty">
                    No words match "
                    {bookmarkFilter}".
                  </p>
                ) : (
                  groupedBookmarks.map(
                    (group) => (
                      <div
                        className="bookmark-group"
                        key={group.lang}
                      >
                        <button
                          type="button"
                          className="bookmark-group-title"
                          onClick={() =>
                            setCollapsedGroups(
                              (prev) => {
                                const next =
                                  new Set(
                                    prev
                                  );
                                if (
                                  next.has(
                                    group.lang
                                  )
                                ) {
                                  next.delete(
                                    group.lang
                                  );
                                } else {
                                  next.add(
                                    group.lang
                                  );
                                }
                                return next;
                              }
                            )
                          }
                        >
                          <span className="bookmark-group-caret">
                            {collapsedGroups.has(
                              group.lang
                            ) &&
                            !bookmarkFilter.trim()
                              ? "▸"
                              : "▾"}
                          </span>

                          {group.label}

                          <span className="bookmark-count">
                            {
                              group
                                .items
                                .length
                            }
                          </span>
                        </button>

                        {(!collapsedGroups.has(
                          group.lang
                        ) ||
                          bookmarkFilter.trim()) && (
                        <div className="bookmark-list">
                          {group.items.map(
                            (
                              bookmark
                            ) => (
                              <div
                                className="word-pair saved-word-pair"
                                key={
                                  bookmark.id
                                }
                              >
                                <span className="word-link">
                                  {
                                    bookmark.source
                                  }
                                </span>

                                {bookmark.target && (
                                  <>
                                    <span className="arrow">
                                      →
                                    </span>

                                    <span className="word-link target-word-link">
                                      {
                                        bookmark.target
                                      }
                                    </span>
                                  </>
                                )}

                                <button
                                  type="button"
                                  className="word-star is-saved"
                                  onClick={() =>
                                    toggleBookmark(
                                      bookmark.source,
                                      bookmark.target,
                                      bookmark.sourceLang,
                                      bookmark.targetLang
                                    )
                                  }
                                  disabled={bookmarkBusy.has(
                                    bookmarkKey(
                                      bookmark
                                    )
                                  )}
                                  title="Remove bookmark"
                                >
                                  ★
                                </button>
                              </div>
                            )
                          )}
                        </div>
                        )}
                      </div>
                    )
                  )
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="container">
        <section className="card">
          <h2>
            1. Select Languages
          </h2>

          <div className="language-controls">
            <div className="field">
              <label htmlFor="source-language">
                Source language
              </label>

              <select
                id="source-language"
                value={sourceLanguage}
                onChange={(event) => {
                  setSourceLanguage(
                    event.target.value as Language
                  );

                  setOcrText("");
                  setTranslation("");
                  setWordTranslations([]);
                }}
              >
                {LANGUAGES.map(
                  (language) => (
                    <option
                      key={language.code}
                      value={language.code}
                    >
                      {language.label}
                    </option>
                  )
                )}
              </select>
            </div>

            <button
              type="button"
              className="swap-button"
              onClick={
                swapLanguages
              }
              title="Swap languages"
            >
              ⇄
            </button>

            <div className="field">
              <label htmlFor="target-language">
                Target language
              </label>

              <select
                id="target-language"
                value={targetLanguage}
                onChange={(event) => {
                  setTargetLanguage(
                    event.target.value as TranslationLanguage
                  );

                  setTranslation("");
                  setWordTranslations([]);
                }}
              >
                {TRANSLATION_LANGUAGES.map(
                  (language) => (
                    <option
                      key={language.code}
                      value={language.code}
                    >
                      {language.label}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>
            2. Upload or Capture Image
          </h2>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={
              handleFileChange
            }
            hidden
          />

          <div className="action-buttons">
            <button
              type="button"
              className="primary-button"
              onClick={
                openFilePicker
              }
              disabled={isProcessing}
            >
              📁 Upload Image
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={
                openCamera
              }
              disabled={isProcessing}
            >
              📷 Use Camera
            </button>
          </div>

          {cameraOpen && (
            <div className="camera-container">
              <video
                ref={videoRef}
                className="camera-video"
                autoPlay
                playsInline
                muted
              />

              <div className="camera-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={
                    captureImage
                  }
                >
                  📸 Capture
                </button>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={
                    closeCamera
                  }
                >
                  ✕ Close
                </button>
              </div>
            </div>
          )}

          <canvas
            ref={canvasRef}
            hidden
          />

          {imageUrl && (
            <div className="image-preview">
              <img
                src={imageUrl}
                alt="Selected document"
              />
            </div>
          )}

          {selectedFile && (
            <div className="selected-file">
              <strong>
                Selected:
              </strong>{" "}
              {selectedFile.name}
            </div>
          )}

          <form
            onSubmit={
              handleReadAndTranslate
            }
          >
            <button
              type="submit"
              className="read-translate-button"
              disabled={
                !selectedFile ||
                isProcessing
              }
            >
              {isProcessing
                ? "⏳ Processing..."
                : "▶ Read & Translate"}
            </button>
          </form>

          {status && (
            <div className="status">
              {isProcessing && (
                <span className="spinner" />
              )}

              <span>
                {status}
              </span>
            </div>
          )}
        </section>

        {(ocrText ||
          translation ||
          wordTranslations.length >
            0) && (
          <section className="results">
            <div className="card result-card">
              <div className="result-heading">
                <h2>
                  Detected Text
                </h2>

                {ocrText && (
                  <div className="tts-controls">
                    <button
                      type="button"
                      className="tts-start-button"
                      onClick={
                        speakSourceText
                      }
                      disabled={
                        isSourceSpeaking
                      }
                    >
                      ▶ Start
                    </button>

                    <button
                      type="button"
                      className="tts-stop-button"
                      onClick={
                        stopSourceText
                      }
                      disabled={
                        !isSourceSpeaking
                      }
                    >
                      ■ Stop
                    </button>
                  </div>
                )}
              </div>

              <textarea
                value={ocrText}
                readOnly
                rows={14}
                placeholder="Detected text will appear here..."
              />

              {ocrText && (
                <div className="word-section">
                  <h3>
                    Source Words
                  </h3>

                  <div className="word-line">
                    {getWords(
                      ocrText
                    ).map(
                      (
                        word,
                        index
                      ) => (
                        <div
                          className="word-pair"
                          key={`${word}-${index}`}
                        >
                          <button
                            type="button"
                            className="word-link"
                            onClick={() =>
                              searchWordMeaning(
                                word
                              )
                            }
                            title="Search meaning"
                          >
                            {word}
                          </button>

                          <button
                            type="button"
                            className="word-tts-button"
                            onClick={() =>
                              speakWord(
                                word,
                                sourceTranslationLanguage
                              )
                            }
                            title={`Listen to ${word}`}
                          >
                            🔊
                          </button>

                          {renderStar(
                            word,
                            "",
                            sourceTranslationLanguage,
                            ""
                          )}
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="card result-card">
              <div className="result-heading">
                <h2>
                  Translation
                </h2>

                {translation && (
                  <button
                    type="button"
                    className="translation-read-button"
                    onClick={
                      speakTranslation
                    }
                    disabled={
                      isTranslationSpeaking
                    }
                  >
                    🔊 Read
                  </button>
                )}
              </div>

              <textarea
                value={translation}
                readOnly
                rows={14}
                placeholder="Translation will appear here..."
              />

              {wordTranslations.length >
                0 && (
                <div className="word-section">
                  <h3>
                    Word-by-Word
                    Translation
                  </h3>

                  <div className="word-line">
                    {wordTranslations.map(
                      (
                        item,
                        index
                      ) => (
                        <div
                          className="word-pair"
                          key={`${item.source}-${index}`}
                        >
                          <button
                            type="button"
                            className="word-link"
                            onClick={() =>
                              searchWordMeaning(
                                item.source,
                                getTranslationLanguageLabel(
                                  targetLanguage
                                )
                              )
                            }
                            title={`Search "${item.source}" in ${getTranslationLanguageLabel(
                              targetLanguage
                            )}`}
                          >
                            {
                              item.source
                            }
                          </button>

                          <button
                            type="button"
                            className="word-tts-button"
                            onClick={() =>
                              speakWord(
                                item.source,
                                sourceTranslationLanguage
                              )
                            }
                            title={`Listen to ${item.source}`}
                          >
                            🔊
                          </button>

                          <span className="arrow">
                            →
                          </span>

                          <button
                            type="button"
                            className="word-link target-word-link"
                            onClick={() =>
                              searchWordMeaning(
                                item.target,
                                getTranslationLanguageLabel(
                                  sourceTranslationLanguage
                                )
                              )
                            }
                            title={`Search "${item.target}" in ${getTranslationLanguageLabel(
                              sourceTranslationLanguage
                            )}`}
                          >
                            {
                              item.target
                            }
                          </button>

                          <button
                            type="button"
                            className="word-tts-button"
                            onClick={() =>
                              speakWord(
                                item.target,
                                targetLanguage
                              )
                            }
                            title={`Listen to ${item.target}`}
                          >
                            🔊
                          </button>

                          {renderStar(
                            item.source,
                            item.target,
                            sourceTranslationLanguage,
                            targetLanguage
                          )}
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;