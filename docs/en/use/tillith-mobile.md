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

## Android build status

The Capacitor shell and the embedded entry point in `mobile/native-python` remain under integration. Several Python dependencies require native binaries for the target Android ABI, followed by emulator or device verification. There is no verified working APK yet. A successful embedded-core startup on desktop does not establish that it runs on a phone.
