# Tillith client

Tillith uses the Python core in this repository. The responsive client in `mobile/` is built with React, TypeScript, Vite, and Capacitor. Its layout adapts to the available width on phones, tablets, and desktops; native integrations provide platform-specific capabilities.

## Where the core runs

Connection settings offer two modes:

| Mode | Core location | Current status |
| --- | --- | --- |
| Server core | A specified Tillith server | Connection, sessions, `/help`, attachments, and persisted history have been verified against the real local core. No public cloud deployment was made in this iteration. |
| On-device core | Python embedded in the Android application | The embedded entry point, authentication, and persistent identity have been exercised on desktop. Android native dependencies and a working APK have not passed runtime verification. |

A browser cannot start the on-device core. The interface explicitly reports that mode as unavailable when its native bridge is absent. `127.0.0.1` always refers to the current device; the local development address is not a server address that another phone can use.

## Run locally

Run these commands from the repository root. The prepared development environment uses Python 3.12 and the full core dependencies in `.runtime/core`, with persistent runtime data in `.runtime/local`. Build the client before starting the core:

```powershell
cd mobile
npm.cmd ci
npm.cmd run build
cd ..
.runtime\core\Scripts\python.exe scripts/tillith_dev.py start
```

Open `http://127.0.0.1:6195`. The real Python core serves `mobile/dist` directly and listens only on loopback by default. Windows background processes are hidden. The launcher disables metrics uploads and tracing, and prevents the WebUI from updating or restarting the core itself. Startup retrieval of public model metadata has no separate configuration switch; failure to retrieve it does not prevent startup.

Check status, stop the process, or view launcher help:

```powershell
.runtime\core\Scripts\python.exe scripts/tillith_dev.py status
.runtime\core\Scripts\python.exe scripts/tillith_dev.py stop
.runtime\core\Scripts\python.exe scripts/tillith_dev.py --help
```

Rebuild with `npm.cmd run build` after client changes. Runtime directories, credentials, and test data are ignored by Git. The launcher prints only the location of the credential file.

## Connect and use

Choose server mode in connection settings, then enter the Tillith server address and an API key with `chat` and `file` scopes. The client obtains the existing authenticated identity from `/api/v1/tillith/profile` and uses the core's session, WebSocket, and file APIs. It uses the existing user identity system.

After connecting, create a session, send a message or attachment, return to the session list, and view or rename saved conversations. With no model configured, send `/help` to verify a real built-in command exchange. Normal model responses require a separately configured provider. External LLM providers have not been connected or tested in this iteration; a built-in command reply is not evidence of a model call.

## Chat interface

Search conversations by title or message text, and pin, star, or archive sessions. Session flags persist on the core. Drafts and model selections persist on this device, separated by core and account; browser credentials stay in memory and must be entered again after reloading.

The message menu edits the latest user turn, regenerates its response, previews and restores versions, branches from a completed response, and deletes a complete turn. Restoring a version restores both visible messages and model context. Older messages created through the previous WebSocket path have no checkpoint and remain readable and copyable without these context operations.

The Tillith WebSocket bridge uses the canonical checkpoint and run lifecycle. Reconnection resumes by run ID, replaces partial content with a snapshot, and never resends a paid generation request. Completed runs reload durable history. Stop waits for partial-response persistence. Missing token usage is shown as unavailable.

Attachment selection includes camera, photo library, and files. JPEG, PNG, and WebP images over 2 MiB are resized locally to a maximum dimension of 2048 pixels, using the result only when it is smaller. GIFs remain unchanged. The session menu exports visible conversation text as Markdown or JSON, including attachment names but excluding binaries, reasoning, tool traces, and credentials. Android uses the system document picker.

More contains theme, font size, message spacing, and code appearance settings. The browser flow has been verified against an isolated core and synthetic provider, including mutations, versions, branching, search, persistence, export, and reconnection. Synthetic tests do not establish external-provider compatibility. Android background recovery, camera/library selection, and system document saving still require target-device acceptance.

Replies render Markdown tables, lists, quotes, and code blocks. Copy a full reply or one code block, and preview uploaded images inside the app. Incoming fragments preserve your position while reading older messages; use the latest-message button to resume following the response. The composer grows with its content and supports Ctrl/Cmd + Enter without interrupting IME composition.

## Providers and server profiles

More → Providers and models uses a separate management API key with `provider` scope. It supports source/model creation, editing, deletion, enablement, model discovery, and actual connection testing. Forms follow the core schema; per-model parameters use `custom_extra_body`. Existing credentials are never returned in full. Blank credentials preserve the stored value, while a new value replaces it.

Connection settings store multiple cloud or device profiles. Android keeps chat and management credentials in separate Keystore-backed slots, deleting the legacy slot only after migration succeeds. Browsers persist profile names and addresses while keeping keys in memory, so reloading requires entering them again. Provider management has passed real loopback requests and a complete browser flow with a synthetic provider; external protocol and Android acceptance remain separate work.

## Personas, worldbooks, and memory

Open More → Personas, worldbooks, and memory. Manage persona prompts, opening messages, display names, folders, and default models for new windows. Continue an existing persona window or create a new one. The chat context control binds a persona and worldbooks; changing the persona after messages exist requires a new window. Worldbook entries support keywords or regular expressions, always-active entries, scan depth, priority, roles, insertion positions, and JSON import/export. Selected books can be removed individually.

Memory management supports persona filters, keyword search, types, stars, editing, trash, and restoration. The message menu can save a memory with its source message attached automatically. Editing, replacing, or deleting that source invalidates the linked memory and excludes it from injection. Recall and model memory tools are separate opt-in switches, both off by default. Recall currently uses keywords; vector search and automatic summaries are not implemented. Context sources shows the worldbook entries and memories actually injected into a run.

The composer quick-phrase button saves, edits, deletes, and inserts reusable text. Phrases stay on this device, separated by core, account, and persona; inserting a phrase does not send it. Separate persona windows retain separate drafts.

The conversation export menu also offers a JSONL conversation backup using the management key's `data` scope. It includes only the selected conversation and is separate from Markdown/JSON text export. Deleting the connected profile immediately disconnects and clears the current identity's interface. Persona management requires `persona`, while provider management requires `provider`. The embedded core supplies a separate management key, preserves the existing chat identity, and does not recreate a revoked management key automatically.

Real-core browser checks with a loopback synthetic model cover persona defaults, worldbook and memory injection, message-linked memories, draft and phrase isolation, individual book removal, JSONL download, persistence after reload, source invalidation, and connected-profile deletion. Management checks cover creation, editing, import/export, trash/restoration, retries after partial saves, and layouts from 320 to 1440 pixels. Native credential slots and file bridge behavior have desktop test coverage; Android device acceptance remains outstanding.

## Android build status

The base mobile core uses `mobile/native-python/mobile-requirements.txt` for chat, personas, SQLite, built-in plugins, APIs, and attachments. The complete upstream server requirements remain in `requirements.txt`. External messaging platforms, Docker, FAISS indexing, and additional document converters require their own dependencies; installing a plugin does not establish Android compatibility. A fresh environment with this profile has passed real startup, message and attachment roundtrips, and database persistence after shutdown.

The Capacitor shell and the embedded entry point in `mobile/native-python` remain under integration. Several Python dependencies require native binaries for the target Android ABI, followed by emulator or device verification. There is no verified working APK yet. A successful embedded-core startup on desktop does not establish that it runs on a phone.

## Reverse proxy and long responses

The server sends a WebSocket `keepalive` event after 20 seconds without output. Clients ignore this event for message/history purposes. Configure nginx to forward WebSocket upgrades and allow long-running reasoning or tool calls:

```nginx
location / {
    proxy_pass http://127.0.0.1:6195;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

Keep the production TLS configuration. A keepalive does not resume a terminated generation or override a load balancer's maximum connection lifetime. Verification behind the actual reverse proxy remains necessary.
