# Indian Language Document Translator

A React + TypeScript frontend with a FastAPI backend for translating Hindi, Tamil, Telugu, and Kannada text from uploaded images/PDFs into English.

## Features
- Upload PNG/JPG/JPEG/WebP images or PDF files
- OCR for Hindi (`hin`), Tamil (`tam`), Telugu (`tel`), Kannada (`kan`)
- Automatic OCR fallback for scanned PDFs
- Direct extraction for text PDFs
- Translation through a configurable translation provider
- Page-by-page results
- Browser SpeechSynthesis "Listen" button
- No database required

## Prerequisites
- Python 3.10+
- Node.js 18+
- Tesseract OCR 5.x with language data for `hin`, `tam`, `tel`, `kan`
- Poppler is optional but recommended for PDF rendering

## 1. Backend

### Install system dependencies

Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install tesseract-ocr tesseract-ocr-hin tesseract-ocr-tam tesseract-ocr-tel tesseract-ocr-kan poppler-utils
```

Windows:
1. Install Tesseract OCR.
2. During installation, select/add Hindi, Tamil, Telugu and Kannada language data.
3. If Tesseract is not found automatically, set:
```powershell
$env:TESSERACT_CMD="C:\Program Files\Tesseract-OCR\tesseract.exe"
```
4. Install Poppler and put its `bin` directory on PATH if PDF OCR is needed.

Create a virtual environment:
```bash
cd backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
# source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env`.

The default translation provider is LibreTranslate-compatible. Set:
```env
TRANSLATION_URL=https://libretranslate.com/translate
TRANSLATION_API_KEY=
```
A self-hosted LibreTranslate-compatible server can also be used.

Start:
```bash
uvicorn app.main:app --reload --port 8000
```

## 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal.

## Translation provider

The app calls a LibreTranslate-compatible `/translate` endpoint. If you use another provider, replace `backend/app/translator.py` with the provider implementation you need.

## Notes
OCR quality depends on scan quality, font, rotation, and language model. For mixed-language documents, select a primary language or use auto-detection.

## Deploying to Vercel (single project)

This repo is configured to deploy as one Vercel project with the Vite app and
serverless functions together. In Vercel, set the project **Root Directory** to
`frontend`. Configuration lives in `frontend/vercel.json`.

Serverless functions (in `frontend/api/`):
- `POST /api/translate` — text translation via MyMemory (no key required).
- `/api/bookmarks` — saved words, backed by MongoDB (`GET`/`POST`/`DELETE`).

### Environment variables

The bookmark feature needs MongoDB. Set these in
**Vercel > Project > Settings > Environment Variables** (see
`frontend/.env.example`):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MONGODB_URI` | yes | — | MongoDB connection string (e.g. Atlas). |
| `MONGODB_DB` | no | `indian_translator` | Database name. |
| `MONGODB_BOOKMARKS_COLLECTION` | no | `bookmarks` | Collection name. |

Translation works without any environment variables; only bookmarks require
`MONGODB_URI`.

## Bookmarks

Click the ☆ star next to a word-by-word pair to save it; click ★ to remove it.
Saved words appear in the "Saved Words" list and persist in MongoDB. Bookmarks
are scoped per browser via a random client id kept in `localStorage` (the app
has no login).
