# Meeting Summarizer — AI Meeting Intelligence

**Meeting Summarizer** is a full-stack, production-quality internal business application that transforms meeting audio recordings into structured summaries, key discussion points, decisions made, tracked action items (with assignees and deadlines), and downloadable PDF reports using Google Gemini AI and Supabase.

---

## 📑 Table of Contents
1. [Key Features](#-key-features)
2. [Tech Stack](#-tech-stack)
3. [Project Structure](#-project-structure)
4. [Prerequisites](#-prerequisites)
5. [Database & Supabase Setup](#-database--supabase-setup)
6. [Local Development Setup](#-local-development-setup)
   - [Backend (FastAPI)](#1-backend-setup-fastapi)
   - [Frontend (React + Vite)](#2-frontend-setup-react--vite)
7. [Environment Variables Reference](#-environment-variables-reference)
8. [Gemini Model Selection](#-gemini-model-selection)
9. [Deployment Guide (Vercel + Render + Supabase)](#-deployment-guide)
10. [Security & Architecture Notes](#-security--architecture-notes)

---

## ✨ Key Features

- 🎙️ **Audio Ingestion & Validation:** Upload meeting recordings in MP3, WAV, or M4A format with client-side and server-side MIME sniffing, size verification (up to 100MB), and empty file checks.
- 🤖 **Structured AI Analysis:** Leverages Google's official `google-genai` SDK with strict JSON response schemas to extract:
  - Concise Executive Summary
  - Key Discussion Points
  - Formal Decisions Made
  - Action Items (task, owner/assignee, deadline, priority)
  - Unresolved Issues & Open Questions
  - Important Topics & Themes
  - Verbatim Audio Transcript
- ✏️ **Manual Edit & Save:** Inline editable insights allowing humans to adjust any AI-generated decision, task, or summary, with immediate persistence back to Supabase.
- 📋 **Cross-Meeting Action Items:** Dedicated action items dashboard to filter, review, and toggle status (`pending` / `completed`) across all your team meetings.
- 📊 **Real-time Live Dashboard:** Summary cards showing total meetings, pending tasks, completed tasks, and recent discussions.
- 📄 **Professional PDF Export:** Server-side ReportLab document generation producing clean, branded PDF reports from the latest saved meeting data.
- 🔒 **Defense-in-Depth Security:** Supabase Row Level Security (RLS) policies combined with backend JWT authentication ensuring strict multi-tenant user isolation.

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React 19 + Vite + Tailwind CSS | Fast, responsive single-page SaaS interface |
| **Icons & UI** | Lucide React | Clean, modern iconography |
| **Backend** | Python 3.14 + FastAPI + Uvicorn | High-performance asynchronous REST API |
| **AI Intelligence** | Google Gemini API (`google-genai` SDK) | Audio transcription and structured JSON understanding |
| **Database** | Supabase (PostgreSQL) | Relational database with Row Level Security |
| **Auth** | Supabase Auth | Secure authentication & JWT token management |
| **File Storage** | Supabase Storage (`meeting-audio` bucket) | Cloud storage for audio recordings |
| **PDF Engine** | ReportLab Platypus | High-fidelity business report generation |

---

## 📁 Project Structure

```
Meeting-Summarizer/
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI application, CORS, routers & exception handlers
│   │   ├── config.py               # Environment variable loading and validation
│   │   ├── dependencies.py         # Supabase JWT authentication dependency (get_current_user)
│   │   ├── models/
│   │   │   └── schemas.py          # Pydantic models for requests, responses & Gemini schema
│   │   ├── routers/
│   │   │   ├── meetings.py         # Meeting upload, listing, detail, update, delete & PDF
│   │   │   └── action_items.py     # Action items listing, filtering & status updates
│   │   └── services/
│   │       ├── audio_validation.py # Extension & magic bytes validation (MP3/WAV/M4A)
│   │       ├── supabase_service.py # Database queries & Supabase Storage operations
│   │       ├── gemini_service.py   # Gemini File API upload, structured JSON parsing & retries
│   │       └── pdf_service.py      # ReportLab platypus PDF report generator
│   ├── requirements.txt            # Python dependencies
│   └── .env.example                # Backend configuration template
│
├── frontend/
│   ├── src/
│   │   ├── components/             # Reusable UI components (Buttons, Cards, Modals, etc.)
│   │   ├── context/
│   │   │   └── AuthContext.jsx     # Supabase Auth provider & state hook
│   │   ├── lib/
│   │   │   ├── supabaseClient.js   # Supabase JS client configuration
│   │   │   └── apiClient.js        # Axios instance with Bearer JWT interceptor
│   │   ├── pages/                  # All 9 application pages
│   │   ├── App.jsx                 # Route definitions & layout wrappers
│   │   ├── index.css               # Global styles & Tailwind imports
│   │   └── main.jsx                # React DOM root
│   ├── package.json                # Frontend npm dependencies
│   ├── vite.config.js              # Vite bundler configuration
│   └── .env.example                # Frontend environment template
│
├── supabase/
│   └── schema.sql                  # Complete SQL schema: tables, RLS policies, triggers
├── .gitignore                      # Git exclusion rules
└── README.md                       # Comprehensive project documentation
```

---

## 📦 Prerequisites

Ensure you have the following installed on your machine:
- **Node.js** (v18 or higher) — check with `node -v`
- **npm** (v9 or higher) — check with `npm -v`
- **Python** (v3.10 to v3.14) — check with `python --version`
- A free **Supabase account** (https://supabase.com)
- A free **Google AI Studio API Key** (https://aistudio.google.com)

---

## 🗄️ Database & Supabase Setup

### Step 1: Run the Database Schema SQL
1. Open your [Supabase Project Dashboard](https://supabase.com/dashboard).
2. In the left sidebar, click on **SQL Editor**.
3. Click **New Query**.
4. Open the file `supabase/schema.sql` from this repository, copy its entire contents, paste it into the editor, and click **Run**.
   - This creates the `profiles`, `meetings`, and `action_items` tables.
   - It enables **Row Level Security (RLS)** with per-user data isolation.
   - It creates automated triggers for updating timestamps and creating profiles on user signup.

### Step 2: Create the Audio Storage Bucket
1. In the Supabase dashboard, click **Storage** in the left sidebar.
2. Click **New Bucket**.
3. Name the bucket: `meeting-audio`
4. Set the bucket to **Private** (do NOT check "Public bucket").
5. Click **Save**.
*(Note: Storage access policies are already included in `supabase/schema.sql` and were created during Step 1).*

### Step 3: Verify Authentication Settings
1. In the Supabase dashboard, go to **Authentication** > **Providers** > **Email**.
2. Make sure Email provider is **Enabled**.
3. (Optional for local testing): Under **Authentication** > **URL Configuration**, ensure Site URL is `http://localhost:5173`.

---

## 🚀 Local Development Setup

### 1. Backend Setup (FastAPI)

1. Open a terminal and navigate to the `backend/` directory:
   ```bash
   cd backend
   ```

2. Create and activate a Python virtual environment:
   - **Windows (PowerShell):**
     ```powershell
     python -m venv venv
     .\venv\Scripts\Activate.ps1
     ```
   - **macOS / Linux:**
     ```bash
     python3 -m venv venv
     source venv/bin/activate
     ```

3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Create your `.env` configuration file:
   ```bash
   # Copy example template
   cp .env.example .env
   ```
   Fill in your real credentials in `backend/.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...your_gemini_api_key
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...your_service_role_key
   FRONTEND_URL=http://localhost:5173
   PORT=8000
   ```

5. Start the FastAPI development server:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```
   *The backend will start at `http://localhost:8000`. You can visit `http://localhost:8000/docs` for the interactive Swagger documentation or `http://localhost:8000/health` to confirm liveness.*

---

### 2. Frontend Setup (React + Vite)

1. Open a second terminal window and navigate to the `frontend/` directory:
   ```bash
   cd frontend
   ```

2. Install Node dependencies:
   ```bash
   npm install
   ```

3. Create your `.env.local` configuration file:
   ```bash
   # Copy example template
   cp .env.example .env.local
   ```
   Fill in your Supabase public details in `frontend/.env.local`:
   ```env
   VITE_SUPABASE_URL=https://your-project-id.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...your_anon_key
   VITE_API_BASE_URL=http://localhost:8000
   ```
   *(Notice: `GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are NEVER put in the frontend!).*

4. Start the Vite development server:
   ```bash
   npm run dev
   ```
   *Open your browser and navigate to `http://localhost:5173`.*

---

## 🔑 Environment Variables Reference

### Backend (`backend/.env`)
| Variable | Description | Where to find |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Google Gemini AI API key | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `SUPABASE_URL` | Supabase project URL | Supabase Dashboard > Project Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key for server-side operations | Supabase Dashboard > Project Settings > API > `service_role` |
| `FRONTEND_URL` | Allowed frontend origin for CORS | `http://localhost:5173` (local) or Vercel URL (prod) |
| `PORT` | Local port for FastAPI | `8000` |
| `ZOOM_CLIENT_ID` | Zoom OAuth App Client ID | [Zoom Marketplace](https://marketplace.zoom.us/) |
| `ZOOM_CLIENT_SECRET` | Zoom OAuth App Client Secret | [Zoom Marketplace](https://marketplace.zoom.us/) |
| `ZOOM_REDIRECT_URI` | Zoom OAuth production redirect URL | `https://meeting-summarizer-rfrr.onrender.com/api/zoom/callback` |
| `ZOOM_TOKEN_ENCRYPTION_KEY` | Fernet 32-byte url-safe base64 key | Generate via `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |

### Frontend (`frontend/.env.local`)
| Variable | Description | Where to find |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Supabase project URL | Supabase Dashboard > Project Settings > API |
| `VITE_SUPABASE_ANON_KEY` | Supabase public anonymous key | Supabase Dashboard > Project Settings > API > `anon` `public` |
| `VITE_API_BASE_URL` | Backend API URL | `http://localhost:8000` (local) or Render URL (prod) |

---

## 📹 Zoom Cloud Recordings Integration

Meeting Summarizer includes a full, production-ready integration with **Zoom OAuth 2.0** and the **Zoom Cloud Recordings API**.

### How the Zoom Integration Works:
1. **User Connects Zoom:** The user visits **Settings** or the **New Meeting** page and clicks **Connect Zoom**.
2. **Secure OAuth 2.0:** The backend signs a short-lived cryptographic state token (HMAC-SHA256) and redirects the user to Zoom's authorization page.
3. **Token Exchange & Encryption:** After authorization, Zoom redirects back to `https://meeting-summarizer-rfrr.onrender.com/api/zoom/callback`. The backend verifies the state, exchanges the code for access & refresh tokens, and stores them **encrypted at rest** using Fernet symmetric encryption in Supabase (`zoom_connections` table).
4. **Cloud Recordings Browser:** The user opens the **Zoom Cloud Recordings** tab to view their recorded meetings, complete with dates, durations, and transcript availability.
5. **Smart Transcript-First Summarization:**
   - **Priority 1 (WebVTT Transcript):** If a transcript is available, the backend downloads and cleans the WebVTT text into readable dialogue and passes it directly to Gemini AI.
   - **Priority 2 (Audio Recording):** If only audio is available, the backend downloads the audio and runs the full audio pipeline.
   - **Duplicate Protection:** The app tracks `zoom_meeting_uuid` per user to prevent re-processing identical meetings.
6. **Unified Results:** The analyzed Zoom meeting is saved directly into the normal `meetings` and `action_items` tables, making it immediately visible in your **Dashboard**, **Past Meetings**, **Action Items**, and **PDF Export**.

### Verified Zoom OAuth Granular Scopes

Configure these exact scopes in your Zoom App Marketplace dashboard:

| Granular Scope (Current) | Classic Scope Equivalent | Purpose |
| :--- | :--- | :--- |
| `user:read:user` | `user:read` | Read the authorized user's profile and email |
| `cloud_recording:read:list_user_recordings` | `recording:read` | List the user's cloud recordings |
| `cloud_recording:read:recording` | `recording:read` | Retrieve recording files and WebVTT transcripts |

> *Note: In User-level OAuth applications on Zoom Marketplace, adding `cloud_recording:read:list_user_recordings` and `cloud_recording:read:recording` grants permission to view and download recording files and transcripts.*

---

## 🧠 Gemini Model Selection

The application defaults to `gemini-2.5-flash` in `app/config.py` (`GEMINI_MODEL`).
- **Why this model?**
  - Native multimodal audio understanding (supports direct MP3/WAV/M4A ingestion via the Gemini Files API).
  - Native support for `response_schema` + `response_mime_type="application/json"` to guarantee deterministic, type-safe JSON extraction without fragile regex parsing.
  - Highly cost-effective and low-latency processing suitable for long business meetings.
- **Upgrades:** The newer `gemini-3.7-flash` or `gemini-3.6-flash` can be selected anytime simply by setting `GEMINI_MODEL=gemini-3.7-flash` in `backend/.env` without any code changes.

---

## 🚢 Deployment Guide

### 1. Frontend → Vercel
1. Push your repository to GitHub.
2. Sign in to [Vercel](https://vercel.com) and click **Add New Project**.
3. Import your repository and set the **Root Directory** to `frontend`.
4. Build Settings:
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
5. Add Environment Variables:
   - `VITE_SUPABASE_URL` = your Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase Anon Key
   - `VITE_API_BASE_URL` = `https://meeting-summarizer-rfrr.onrender.com`
6. Click **Deploy**.

### 2. Backend → Render
1. Sign in to [Render](https://render.com) and click **New** > **Web Service**.
2. Connect your GitHub repository.
3. Service Settings:
   - **Root Directory:** `backend`
   - **Environment:** Python
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Add Environment Variables:
   - `GEMINI_API_KEY` = your Google AI Studio key
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service role key
   - `FRONTEND_URL` = `https://meeting-summarizer-r.vercel.app`
   - `ZOOM_CLIENT_ID` = your Zoom OAuth App Client ID
   - `ZOOM_CLIENT_SECRET` = your Zoom OAuth App Client Secret
   - `ZOOM_REDIRECT_URI` = `https://meeting-summarizer-rfrr.onrender.com/api/zoom/callback`
   - `ZOOM_TOKEN_ENCRYPTION_KEY` = your 32-byte Fernet base64 key
5. Click **Create Web Service**.

---

## 🛡️ Security & Architecture Notes

- **Zero-Secret Frontend:** The Gemini API key, Zoom Client Secret, Zoom Access Tokens, and Supabase Service Role key live exclusively on the backend server.
- **Encrypted Token Storage:** User Zoom tokens are encrypted before being saved to PostgreSQL using Fernet (`cryptography`).
- **OAuth CSRF Security:** OAuth authorization states are cryptographically signed with HMAC-SHA256 and include an expiration timestamp to prevent CSRF attacks.
- **Double-Layered Tenant Isolation:**
  1. Every incoming backend request authenticates the caller's JWT through Supabase Auth and binds `user_id`. All queries are scoped by `user_id`.
  2. Supabase PostgreSQL tables have Row Level Security enabled (`auth.uid() = user_id`) to prevent unauthorized access at the database layer.
- **Graceful Error Handling:** Backend exceptions and LLM failures are logged server-side and mapped to user-friendly messages, preventing stack traces and internal architecture from leaking to clients.
