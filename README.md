# Iris Inbox Agent

Iris is a private, account-scoped inbox workspace built with Next.js. After Google sign-in, the ranked inbox is the primary workspace; optional onboarding helps users configure the voice profile and importance rules that improve ranking and draft generation.

## Features

- Ranked Gmail inbox with explainable importance scores
- Voice profile built once from up to 1,000 usable sent emails and cached as a compact profile
- Preference training from alternative reply examples
- Account-specific importance goals and rules
- Draft generation guided by the saved voice profile
- Local, isolated workspace for each signed-in Google account
- OpenRouter usage and cost logging

## Tech stack

- Next.js 15 App Router
- React 19 and TypeScript
- Google Identity Services and the Gmail API
- OpenRouter for profile analysis and draft generation

## Prerequisites

- Node.js 20 or newer
- A Google Cloud OAuth 2.0 web client
- An OpenRouter API key for AI-assisted features

## Local setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Copy the environment template:

   ```bash
   cp .env.example .env.local
   ```

   On PowerShell, use `Copy-Item .env.example .env.local`.

3. In Google Cloud Console, create an OAuth 2.0 client with the **Web application** type. Add `http://localhost:3000` to its authorized JavaScript origins. Add each deployed or tunnel origin you use as well.

4. Fill in `.env.local`:

   ```dotenv
   NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-server-only-client-secret
   AUTH_SECRET=replace-with-a-long-random-secret
   OPENROUTER_API_KEY=your-openrouter-key
   ```

   `AUTH_SECRET` should be a cryptographically random value of at least 32 characters. Never expose the OpenRouter key through a `NEXT_PUBLIC_` variable.

5. Start the development server:

   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Yes | Google Identity Services web client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Server-only OAuth code exchange and refresh-token credential |
| `AUTH_SECRET` | Yes | Signs sessions and derives the refresh-token encryption key |
| `OPENROUTER_API_KEY` | For AI features | Server-side OpenRouter credential |
| `OPENROUTER_PROFILE_MODEL` | No | Model used to build the voice profile |
| `OPENROUTER_GOALS_MODEL` | No | Model used to build the importance profile |
| `OPENROUTER_DRAFT_MODEL` | No | Model used to generate drafts and examples |

The model variables default to `google/gemini-2.5-flash-lite` when omitted.

## Available commands

| Command | Description |
| --- | --- |
| `npm run dev` | Run the local development server |
| `npm run build` | Create a production build |
| `npm start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Type-check without emitting files |
| `npm run check` | Run lint and type-check checks |

## Privacy and data handling

- Google identity establishes the signed session and one-time Gmail consent. The refresh token is encrypted per account with AES-256-GCM; short-lived access tokens are refreshed server-side and are never written to disk.
- Each Google account gets a hashed directory under `data/accounts/`.
- Voice profiles, preferences, importance rules, generated-example caches, and draft caches are account-scoped.
- The latest filtered ranked inbox is cached account-locally (up to 100 messages and 4,000 body characters per message) so normal visits do not require rescanning Gmail. Refreshing replaces the prior cache.
- OpenRouter call metadata is appended to `data/openrouter_calls.jsonl`; runtime data is excluded from Git.

The `data/` storage layer is local filesystem storage. Before deploying to a serverless platform or running multiple application instances, replace it with durable shared storage and review the retention policy for account-derived data.

## Repository structure

```text
app/                 Next.js pages, UI, and API route handlers
app/dashboard/       Authenticated inbox and onboarding routes
lib/                 Gmail, session, ranking, model, and storage logic
data/                Ignored local runtime data (`.gitkeep` only in Git)
.github/workflows/   Continuous integration checks
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local validation and pull-request checklist. Security issues should be reported according to [SECURITY.md](SECURITY.md), not in a public issue.
