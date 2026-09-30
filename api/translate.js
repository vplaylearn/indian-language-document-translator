/*
 * Vercel Serverless Function: POST /api/translate
 *
 * Ports the Express translation route (backend/src/routes/translation.js).
 * Browser does OCR via tesseract.js and posts { text, source, target };
 * this function returns a natural translation plus word-by-word pairs,
 * using the free MyMemory translation API.
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

async function translateChunk(text, source, target) {
  const url = new URL(MYMEMORY_API);

  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${source}|${target}`);

  const response = await fetch(url);

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
}

function tokenizeText(text) {
  return text.match(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}\s]/gu) || [];
}

function isWordToken(token) {
  return /[\p{L}\p{M}\p{N}]/u.test(token);
}

async function translateWords(text, source, target) {
  const tokens = tokenizeText(text);
  const words = tokens.filter(isWordToken);

  if (words.length === 0) {
    return [];
  }

  // Deduplicate while preserving order, then cap external calls.
  const uniqueWords = [...new Set(words)];
  const wordsToTranslate = uniqueWords.slice(0, MAX_WORD_TRANSLATIONS);

  const cache = new Map();

  // Sequential on purpose: avoids a burst of external requests.
  for (const word of wordsToTranslate) {
    try {
      cache.set(word, await translateChunk(word, source, target));
    } catch (error) {
      console.error(`Failed to translate word "${word}":`, error.message);
      cache.set(word, word);
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
    // req.body may be an object (Vercel auto-parses JSON) or a raw string.
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

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
    const translatedChunks = [];

    for (const chunk of chunks) {
      translatedChunks.push(
        await translateChunk(chunk, normalizedSource, normalizedTarget)
      );
    }

    const translation = translatedChunks.join("\n");

    const words = await translateWords(
      text,
      normalizedSource,
      normalizedTarget
    );

    return res.status(200).json({
      translation,
      words,
      source: normalizedSource,
      target: normalizedTarget,
      chunks: chunks.length,
    });
  } catch (error) {
    console.error("Translation error:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Translation failed." });
  }
}
