/*
 * Vercel Serverless Function: POST /api/translate
 *
 * Ports the Express translation route (backend/src/routes/translation.js).
 * Browser does OCR via tesseract.js and posts { text, source, target };
 * this function returns a natural translation plus word-by-word pairs,
 * using the free MyMemory translation API.
 *
 * Word-by-word is batched (many words per request) with retry/backoff on
 * HTTP 429 so large OCR documents don't exhaust the public provider.
 *
 * Request body:  { "text": "यह भारत है", "source": "hi", "target": "en" }
 * Response body: { "translation": "This is India", "words": [{ source, target }], ... }
 */

const LANGUAGE_CODES = {
  eng: "en",
  hin: "hi",
  tam: "ta",
  tel: "te",
  kan: "kn",
};

const SUPPORTED_LANGUAGES = new Set(["en", "hi", "ta", "te", "kn"]);

const MYMEMORY_API = "https://api.mymemory.translated.net/get";

const MAX_CHUNK_LENGTH = 400;

const MAX_WORD_TRANSLATIONS = 100;
const WORD_BATCH_SIZE = 35;
const WORD_BATCH_DELAY_MS = 500;

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1500;

function normalizeLanguage(language) {
  if (!language) {
    return null;
  }

  const normalized = String(language).trim().toLowerCase();

  if (LANGUAGE_CODES[normalized]) {
    return LANGUAGE_CODES[normalized];
  }

  if (SUPPORTED_LANGUAGES.has(normalized)) {
    return normalized;
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitByWords(text, maxLength) {
  const words = text.split(/\s+/);

  const chunks = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if (current.length + word.length + 1 <= maxLength) {
      current += ` ${word}`;
    } else {
      chunks.push(current);
      current = word;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitText(text, maxLength = MAX_CHUNK_LENGTH) {
  const normalizedText = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalizedText) {
    return [];
  }

  if (normalizedText.length <= maxLength) {
    return [normalizedText];
  }

  const paragraphs = normalizedText
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      chunks.push(paragraph);
      continue;
    }

    // Sentence boundaries include the Devanagari danda (।) for Indian text.
    const sentences = paragraph.match(/[^.!?।]+[.!?।]?/gu);

    if (!sentences) {
      chunks.push(...splitByWords(paragraph, maxLength));
      continue;
    }

    let current = "";

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();

      if (!trimmedSentence) {
        continue;
      }

      if (current.length + trimmedSentence.length + 1 <= maxLength) {
        current = current
          ? `${current} ${trimmedSentence}`
          : trimmedSentence;
      } else {
        if (current) {
          chunks.push(current);
        }

        if (trimmedSentence.length <= maxLength) {
          current = trimmedSentence;
        } else {
          chunks.push(...splitByWords(trimmedSentence, maxLength));
          current = "";
        }
      }
    }

    if (current) {
      chunks.push(current);
    }
  }

  return chunks;
}

/*
 * MyMemory request with HTTP 429 handling and exponential backoff.
 */
async function requestMyMemory(text, source, target, options = {}) {
  const {
    retries = MAX_RETRIES,
    retryDelay = INITIAL_RETRY_DELAY_MS,
  } = options;

  const url = new URL(MYMEMORY_API);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${source}|${target}`);
  // Identifies the requester to the provider.
  url.searchParams.set("de", "local-translator-app@example.com");

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "MultilingualDocumentTranslator/1.0",
        },
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        let waitTime = retryDelay * Math.pow(2, attempt);

        if (retryAfterHeader) {
          const retryAfterSeconds = Number(retryAfterHeader);
          if (Number.isFinite(retryAfterSeconds)) {
            waitTime = retryAfterSeconds * 1000;
          }
        }

        if (attempt < retries) {
          console.warn(
            `MyMemory returned HTTP 429. Retrying in ${Math.round(
              waitTime / 1000
            )}s...`
          );
          await sleep(waitTime);
          continue;
        }

        throw new Error(
          "Translation service is temporarily rate-limiting requests (HTTP 429). Please wait a moment and try again."
        );
      }

      if (!response.ok) {
        throw new Error(
          `Translation provider returned HTTP ${response.status}`
        );
      }

      const data = await response.json();

      if (data.responseStatus && Number(data.responseStatus) !== 200) {
        throw new Error(
          data.responseDetails ||
            "Translation provider rejected the request."
        );
      }

      const translatedText = data?.responseData?.translatedText;

      if (!translatedText) {
        throw new Error("Translation provider returned no translation.");
      }

      return translatedText;
    } catch (error) {
      lastError = error;

      const message =
        error instanceof Error ? error.message : String(error);
      const isRateLimit =
        message.includes("HTTP 429") || message.includes("rate-limiting");

      if (isRateLimit && attempt < retries) {
        const waitTime = retryDelay * Math.pow(2, attempt);
        console.warn(
          `Retrying translation request in ${Math.round(waitTime / 1000)}s...`
        );
        await sleep(waitTime);
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("Translation failed.");
}

async function translateChunk(text, source, target) {
  return requestMyMemory(text, source, target);
}

function tokenizeText(text) {
  return text.match(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}\s]/gu) || [];
}

function isWordToken(token) {
  return /[\p{L}\p{M}\p{N}]/u.test(token);
}

function createWordBatches(words, batchSize = WORD_BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < words.length; i += batchSize) {
    batches.push(words.slice(i, i + batchSize));
  }
  return batches;
}

/*
 * Providers don't always preserve line breaks, so support newline and
 * semicolon separated output.
 */
function parseTranslatedWordBatch(translatedText, expectedCount) {
  if (!translatedText) {
    return [];
  }

  let lines = translatedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 1 && expectedCount > 1 && lines[0].includes(";")) {
    lines = lines[0]
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  // Don't invent mappings if the provider returns fewer than requested.
  return lines;
}

/*
 * One request per batch of words (newline-separated) instead of one per word.
 * Word-by-word is an enhancement: its failure must never fail the sentence
 * translation, so we fall back to the original word on any problem.
 */
async function translateWordBatch(words, source, target) {
  if (!words.length) {
    return [];
  }

  const batchText = words.join("\n");

  try {
    const translated = await translateChunk(batchText, source, target);
    const translatedWords = parseTranslatedWordBatch(translated, words.length);

    if (translatedWords.length === words.length) {
      return words.map((word, index) => ({
        source: word,
        target: translatedWords[index] || word,
      }));
    }

    console.warn(
      `Could not reliably map word batch. Expected ${words.length}, got ${translatedWords.length}.`
    );
    return words.map((word) => ({ source: word, target: word }));
  } catch (error) {
    console.error("Word batch translation failed:", error.message);
    return words.map((word) => ({ source: word, target: word }));
  }
}

async function translateWords(text, source, target) {
  const tokens = tokenizeText(text);
  const words = tokens.filter(isWordToken);

  if (!words.length) {
    return [];
  }

  const uniqueWords = [...new Set(words)];
  const wordsToTranslate = uniqueWords.slice(0, MAX_WORD_TRANSLATIONS);
  const batches = createWordBatches(wordsToTranslate, WORD_BATCH_SIZE);

  const cache = new Map();

  for (let i = 0; i < batches.length; i++) {
    const translatedBatch = await translateWordBatch(
      batches[i],
      source,
      target
    );

    for (const item of translatedBatch) {
      cache.set(item.source, item.target);
    }

    // Give the public provider breathing room between batches.
    if (i < batches.length - 1) {
      await sleep(WORD_BATCH_DELAY_MS);
    }
  }

  return words.map((word) => ({
    source: word,
    target: cache.get(word) || word,
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const { text, source, target } = body;

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required." });
    }

    const normalizedSource = normalizeLanguage(source);
    const normalizedTarget = normalizeLanguage(target);

    if (!normalizedSource) {
      return res.status(400).json({
        error:
          "Unsupported source language. Supported languages: en, hi, ta, te, kn.",
      });
    }

    if (!normalizedTarget) {
      return res.status(400).json({
        error:
          "Unsupported target language. Supported languages: en, hi, ta, te, kn.",
      });
    }

    // Same language: no external call needed.
    if (normalizedSource === normalizedTarget) {
      const words = tokenizeText(text)
        .filter(isWordToken)
        .map((word) => ({ source: word, target: word }));

      return res.status(200).json({
        translation: text.trim(),
        words,
        source: normalizedSource,
        target: normalizedTarget,
        chunks: 1,
      });
    }

    const chunks = splitText(text);

    if (!chunks.length) {
      return res
        .status(400)
        .json({ error: "No translatable text was found." });
    }

    const translatedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      translatedChunks.push(
        await translateChunk(chunks[i], normalizedSource, normalizedTarget)
      );

      // Small delay between sentence chunks to avoid tripping 429.
      if (i < chunks.length - 1) {
        await sleep(300);
      }
    }

    const translation = translatedChunks.join("\n");

    // Word-by-word is best-effort and must not fail the main translation.
    let words = [];
    try {
      words = await translateWords(text, normalizedSource, normalizedTarget);
    } catch (error) {
      console.error("Word-by-word translation failed:", error.message);
      words = [];
    }

    return res.status(200).json({
      translation,
      words,
      source: normalizedSource,
      target: normalizedTarget,
      chunks: chunks.length,
    });
  } catch (error) {
    console.error("Translation error:", error);

    if (
      error?.message?.includes("HTTP 429") ||
      error?.message?.includes("rate-limiting")
    ) {
      return res.status(429).json({
        error:
          "The translation service is temporarily rate-limiting requests. Please wait 15–30 seconds and try again.",
      });
    }

    return res
      .status(500)
      .json({ error: error?.message || "Translation failed." });
  }
}
