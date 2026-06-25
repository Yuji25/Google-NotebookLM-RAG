# NotebookLM RAG — AI Document Chat

A full-stack **Retrieval-Augmented Generation (RAG)** application that lets you upload any document and have a real AI conversation with it — powered by local embeddings, Qdrant vector search, and a plug-and-play LLM backend.

Inspired by Google NotebookLM.

---

## ✨ Features

- **Multi-format ingestion** — Upload **PDF**, **CSV**, or **TXT** files
- **Isolated Notebooks** — Each file gets its own vector collection; chats never cross-contaminate
- **Local Embeddings** — Uses `Xenova/all-MiniLM-L6-v2` via HuggingFace Transformers (no embedding API costs or rate limits)
- **Universal LLM Support** — Built on the OpenAI-compatible SDK; swap providers by changing two `.env` variables (Groq, OpenRouter, Google AI Studio, etc.)
- **Thinking Model Support** — Backend automatically strips `<think>` / `<thought>` tags from reasoning models
- **Corrective RAG** — Retrieval quality is graded (cheap similarity score first, LLM *judge* only in the grey zone); on a bad match the system *rewrites the query and retries* before answering, with an optional **HyDE** step. See [Corrective RAG](#-corrective-rag) below.
- **Request-Efficient** — On free tiers the scarce resource is *requests* (RPM/RPD), not tokens. The LLM judge is gated behind vector-similarity scores so confident-good and clearly-off-topic queries cost **zero** extra LLM calls.
- **Token Budget Guard** — A configurable cap on context tokens keeps generation safely under a provider's TPM (essential for Groq's 12K; a safety net elsewhere)
- **Rate Limit Handling** — Returns a friendly message instead of a raw 429 error
- **Batched Indexing** — Processes large files in chunks of 500 to prevent memory crashes
- **Futuristic UI** — Dark/Light purple theme with glassmorphism, smooth animations, and full responsiveness

---

## 🏗️ Architecture

```
User Upload
    │
    ▼
┌─────────────────────────────────────────────────┐
│                  Express Backend                │
│                                                 │
│  Multer (file upload)                           │
│      │                                          │
│      ▼                                          │
│  Document Loader  (PDF / CSV / TXT)             │
│      │                                          │
│      ▼                                          │
│  RecursiveCharacterTextSplitter                 │
│  (chunkSize: 1000, overlap: 200)                │
│      │                                          │
│      ▼                                          │
│  HuggingFace Embeddings  ◄── runs locally       │
│  (Xenova/all-MiniLM-L6-v2)                      │
│      │                                          │
│      ▼                                          │
│  Qdrant Vector DB  ◄── Cloud or local Docker    │
└─────────────────────────────────────────────────┘

User Query
    │
    ▼
(optional HyDE: LLM writes a hypothetical answer → embed THAT)
    │
    ▼
Embed query → Qdrant similarity search (top-k chunks)
    │
    ▼
┌── GRADE retrieval (score first, LLM judge only if needed) ─┐
│  score ≥ HIGH   → CORRECT  (accept, no LLM call)           │
│  score ≤ LOW    → INCORRECT (reject, no LLM call)          │
│  grey zone      → LLM JUDGE → CORRECT / PARTIAL / INCORRECT│
│     PARTIAL/INCORRECT → rewrite query, retrieve, merge     │
│     still INCORRECT after retries → grounded fallback      │
└────────────────────────────────────────────────────────────┘
    │
    ▼
Token-budget the context (TPM guard) → LLM (OpenAI-compatible API)
    │
    ▼
Sanitize output → Return clean answer + corrective trace to frontend
```

---

## 🔧 Corrective RAG

Plain RAG **assumes retrieval is always good** and answers from whatever the
vector search returns. This project implements **Corrective RAG**: it
*evaluates* retrieval and *corrects* it before answering.

**The loop (in [`ragService.js`](backend/services/ragService.js)):**

1. **Retrieve** top-k chunks from Qdrant *with similarity scores*.
2. **Grade** — decide if retrieval is good. The cheap **similarity score** is
   checked first: a clearly-high top score is accepted and a near-zero one is
   rejected, both **without any LLM call**. Only in the grey zone does a
   lightweight **LLM judge** run, returning `CORRECT` / `PARTIAL` / `INCORRECT`.
   *This is the request-efficiency trick — on free tiers requests, not tokens,
   are the scarce resource.*
3. **Correct** — if not `CORRECT`, an LLM **rewrites the query** (expands
   keywords/synonyms) and retrieves again; new chunks are merged & de-duplicated.
4. **Decide** — if retrieval is still `INCORRECT` after the retries, the system
   returns a grounded *"not in the document"* instead of hallucinating — and
   without wasting a generation call.
5. **(Optional) HyDE** — before step 1, the LLM can write a *hypothetical
   answer* and embed that instead of the short raw query, bridging the
   short-query ↔ long-document semantic gap. Toggle with `ENABLE_HYDE`.

Every answer ships a **trace** of the steps taken, shown as a collapsible
"🔍 Corrective RAG trace" under the reply — so the difference vs. plain RAG is
visible live during the demo.

**Tuning knobs (`.env`):**

| Variable | Default | Purpose |
|---|---|---|
| `ENABLE_CORRECTIVE_RAG` | `true` | Turn the grade→rewrite→retry loop on/off (off = plain RAG) |
| `ENABLE_HYDE` | `false` | Add the HyDE pre-step (1 extra LLM call) |
| `MAX_CORRECTION_RETRIES` | `1` | How many rewrite-and-retry rounds are allowed |
| `RETRIEVAL_K` | `5` | Chunks fetched per search |
| `MAX_CONTEXT_TOKENS` | `8000` | Cap on context tokens → keeps generation under the LLM's TPM |
| `RELEVANCE_HIGH` | `0.5` | Top score ≥ this → accept without the LLM judge |
| `RELEVANCE_LOW` | `0.15` | Top score ≤ this → reject without the LLM judge (grey zone → judge) |

> **Picking a model (free-tier limits).** Tokens are *not* the bottleneck —
> requests are. **Gemma 4 31b** (unlimited TPM, 1.5K RPD) is the most robust for
> larger files since context size can never cause a failure; **Groq
> llama-3.3-70b** (30 RPM, 12K TPM) is the fastest but needs `MAX_CONTEXT_TOKENS`
> kept ~8000 to stay under its TPM; **Gemini 3.1 flash-lite** (250K TPM but only
> 500 RPD) suits low-volume use. Corrective RAG multiplies requests per question,
> which is exactly why the judge is score-gated.

---

## 🗂️ Project Structure

```
Google-NotebookLM-RAG/
├── backend/
│   ├── controllers/
│   │   └── ragController.js     # Upload & chat route handlers
│   ├── services/
│   │   └── ragService.js        # Core RAG pipeline (ingest + retrieve + generate)
│   ├── index.js                 # Express app entry point (also serves frontend)
│   ├── package.json
│   └── .env.example             # Environment variable template
└── frontend/
    ├── index.html               # App shell
    ├── style.css                # Futuristic purple theme + CSS variables
    └── app.js                   # State management, upload flow, chat logic
```

---

## ⚙️ Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express 5 |
| RAG Framework | LangChain (JS) |
| Embeddings | HuggingFace Transformers (local CPU) |
| Vector Database | Qdrant (Cloud or Docker) |
| LLM API | Any OpenAI-compatible provider (Groq, Google AI Studio, etc.) |
| File Parsing | `PDFLoader`, `CSVLoader`, native `fs` for TXT |
| Frontend | Vanilla HTML, CSS, JavaScript |

---

## 🚀 Local Setup

### Prerequisites
- Node.js v18+
- Docker Desktop (for local Qdrant) **OR** a [Qdrant Cloud](https://cloud.qdrant.io) account

### 1. Clone & Install

```bash
git clone https://github.com/Yuji25/Google-NotebookLM-RAG.git
cd Google-NotebookLM-RAG/backend
npm install
```

### 2. Start Local Qdrant (skip if using Qdrant Cloud)

```bash
docker run -p 6333:6333 qdrant/qdrant
```

### 3. Configure Environment

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

```env
PORT=5000

# Qdrant — use localhost for Docker, or your Cloud cluster URL
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=               # Only needed for Qdrant Cloud

# LLM Provider (any OpenAI-compatible API)
API_KEY=your_api_key_here
BASE_URL=https://api.groq.com/openai/v1
MODEL=llama-3.3-70b-versatile

COLLECTION_NAME=notebooklm_rag
```

### 4. Run

```bash
npm run dev
```

Open **`http://localhost:5000`** in your browser.

> ⚠️ Do **not** use Live Server — the frontend must be served by Express to function correctly.

---

## 🌐 Deployment (Render + Qdrant Cloud)

1. Sign up at [Qdrant Cloud](https://cloud.qdrant.io) — create a free cluster, copy the **URL** and **API Key**
2. Push your code to GitHub
3. Create a new **Web Service** on [Render](https://render.com):
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Add all `.env` variables in Render's **Environment** tab (do not add `PORT`)
5. Deploy — your live URL serves both the frontend UI and the API

---

## 🔄 Switching LLM Providers

Just update two variables in `.env` — no code changes needed:

| Provider | `BASE_URL` | Example `MODEL` |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemma-4-31b-it` |
| OpenRouter | `https://openrouter.ai/api/v1` | `mistralai/mistral-7b-instruct` |

---

## 📄 API Endpoints

### `POST /api/upload`
Upload a document for indexing.
- **Body**: `multipart/form-data` with a `file` field (PDF, CSV, or TXT)
- **Response**: `{ success, message, collectionName }`

### `POST /api/chat`
Ask a question about an indexed document.
- **Body**: `{ query: string, collectionName: string }`
- **Response**: `{ success, query, answer, trace }` — `trace` is the array of corrective-RAG steps (`{ step, detail }`) taken to produce the answer
