# Secure Chat Supervisor

A TypeScript, Node.js messaging API with private conversations, authenticated Socket.IO delivery, PostgreSQL history, Redis-backed horizontal fan-out, and human/automated moderation.

## Run It

Requirements: Docker Compose and Node.js 20 or newer.

1. Create the local environment file if it does not already exist, then replace `JWT_SECRET` with a unique random value of at least 32 characters and set `POSTGRES_PASSWORD` and the three demo passwords. Keep these local values out of source control.

   ```powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

2. Start the API, PostgreSQL, Redis, and demo seed job.

   ```powershell
   docker compose up --build -d
   ```

3. Install local development dependencies and run the scripted, multi-client walkthrough.

   ```powershell
   npm install
   npm run demo
   ```

The demo logs in Alice, Bob, and a supervisor, then demonstrates human approval, human redaction, automated credential redaction, and automated blocking. The database and Redis volumes retain state across restarts. To reset local demo data, run `docker compose down -v` and start again; this deletes persisted data.

For a host-run development server, start only the dependencies with `docker compose up -d db redis`, set `DATABASE_URL` in `.env` to `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/<POSTGRES_DB>` using the values from that file, run `npm run seed`, then `npm run dev`. The API listens on `http://localhost:3000`. Run core tests with `npm test` and compile with `npm run build`.

## Architecture

- **Transport:** Express exposes the authenticated REST API; Socket.IO carries live chat and moderation events. Socket.IO is used for its acknowledgements, rooms, and Redis adapter support. Clients send their JWT in the Socket.IO handshake `auth.token`, never in a URL.
- **Authentication and authorization:** `/api/auth/login` issues a short-lived signed JWT after bcrypt password verification. The API resolves the account and current role from PostgreSQL on every HTTP request and socket action. Only users can send; only supervisors can review, change supervision mode, or join monitor rooms. There is no public registration endpoint; seed accounts are demo-only.
- **Persistence:** PostgreSQL is the source of truth for identities, conversation membership, messages, moderation outcomes, and global supervision mode. Message insertion locks the supervision row; changing to automated mode and releasing held messages happen in one transaction. Blocked message bodies are discarded. Pending bodies are supervisor-only and are omitted from participant history until a decision is made.
- **Moderation:** Automated rules always inspect content first. Explicit threats are blocked without retaining their body; credential-like values are redacted before persistence or delivery. In human mode, other messages are held until a supervisor approves, blocks, or replaces their content. On a supervisor break, held content is released with an observable handoff reason. On unexpected disconnect, Redis presence leases expire (15-second heartbeat, 45-second lease); the last-session disconnect or lease sweep switches the persisted mode to automated and drains pending messages.
- **Horizontal scaling:** Run any number of API instances against the same PostgreSQL and Redis. `@socket.io/redis-adapter` publishes room events across instances. Redis also stores shared HTTP rate-limit counters, per-user socket rate limits, and expiring supervisor-session leases. No process-local state is authoritative.
- **Operations:** Docker Compose starts the API, PostgreSQL, Redis, and an idempotent demo seed job. Database and demo credentials are supplied through `.env`; its example values are placeholders and must be replaced for any non-local deployment.

## API And Socket Events

HTTP endpoints are under `/api`. Send `Authorization: Bearer <token>` except when logging in.

- `POST /api/auth/login` with `{ "email", "password" }`
- `GET /api/me`
- `GET /api/conversations`, `POST /api/conversations` with `{ "recipientId" }`
- `GET /api/conversations/:id/messages?limit=50`
- Supervisor-only: `GET /api/supervisor/state`, `PUT /api/supervisor/state` with `{ "mode": "human" | "automated" }`, `GET /api/supervisor/pending`
- Supervisor-only: `POST /api/supervisor/messages/:id/review` with `{ "action": "approve" | "block" }` or `{ "action": "redact", "content": "..." }`

After authentication, clients emit `conversation:join` with a conversation ID. Supervisors emit `conversation:monitor` for each conversation they want to monitor; one socket can monitor multiple rooms. Users emit `message:send` with a conversation ID and content. Acknowledgements report the persisted state. Participants receive `message:status` and, once released, `message:delivered`. Monitoring supervisors receive `message:pending`, `message:observed`, and status-only events for blocked messages. Clients can reload durable history over REST after reconnecting.

## Security Assumptions

The threat model includes unauthenticated Internet clients, stolen/expired tokens, privilege escalation attempts, malformed or oversized payloads, brute-force login attempts, message floods, unauthorized conversation joins, and accidental disclosure of obvious credentials in chat. The implementation uses signed expiring tokens, bcrypt hashes, current database role checks, strict Zod validation, parameterized SQL, bounded JSON/socket payloads, Helmet headers, Redis-shared rate limits, membership checks, and role-gated monitor/review operations.

This assessment build assumes the application is deployed behind a TLS-terminating reverse proxy and that PostgreSQL/Redis are private network services. It does not claim protection against a compromised host, database administrator, malicious authorized supervisor, sophisticated secrets embedded in arbitrary text, or all forms of harmful language. The keyword/credential heuristics are deliberately transparent examples, not a substitute for policy-specific moderation. Keep demo credentials out of production and replace the seed-only identity flow with a managed identity provider before deployment.

## Tradeoffs And Next Steps

The scope favors a complete runnable path and explicit security boundaries. Conversation history has a bounded latest-message limit but no cursor UI; the demo is a script rather than a polished chat client; automated moderation uses a small deterministic rule set; and the supervision mode is global rather than assigned per conversation. With more time, the first additions would be an append-only moderation audit log, cursor-based history, supervisor assignment/coverage policies, key rotation and refresh-token revocation, end-to-end operational metrics, and integration tests against disposable PostgreSQL/Redis containers. Production deployment should also add TLS configuration, backups/retention controls, and a formal privacy review for supervisor access.