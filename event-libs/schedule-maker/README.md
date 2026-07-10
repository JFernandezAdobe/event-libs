# Schedule Maker

Schedule Maker is a standalone [Document Authoring (DA)](https://da.live) app for building and managing **page schedules** — named collections of timestamped content blocks that drive the [Timing Framework](../v1/features/timing-framework/README.md) on event pages. It runs full-screen inside DA (`da.live/app/{org}/{repo}/schedule-maker`), authenticates through the DA SDK, and persists all data directly to DA sheets on the content repo. There is no build step and no backend of its own.

## Architecture Overview

### Technology

- **Preact + HTM** via `../../v1/deps/htm-preact.js` — components are tagged-template literals (`` html`...` ``), no JSX, no bundler.
- **Spectrum Web Components** — loaded at runtime from Milo libs (`sp-button`, `sp-textfield`, `sp-toast`, etc.).
- **DA SDK** (`https://da.live/nx/utils/sdk.js`) — supplies the auth token and the `{ org, repo }` context that scopes every instance to one content namespace.
- **admin.da.live API** — the only persistence/query surface: `list` (folders/files) and `source` (read/write files). There is **no search API**.

### Core Components

1. **Entry / bootstrap** ([schedule-maker.js](schedule-maker.js), [index.html](index.html))
   - `index.html` mounts `#app` and loads the module.
   - `schedule-maker.js` loads Spectrum components from Milo libs (overridable via `?milolibs=`), then renders the provider tree and root component.

2. **Context providers** (`context/`)
   - **[DAContext](context/DAContext.js)** — initializes the DA SDK, exposes `{ token, org, repo, isLoading, error }`, and pushes the token + authenticated `daFetch` into the controller.
   - **[NavigationContext](context/NavigationContext.js)** — page/mode state and unsaved-changes tracking.
   - **[SchedulesContext](context/SchedulesContext.js)** — the app's state store: schedule list, active schedule, event folder, loading/error/toast flags, and all CRUD + sync operations. Consumed via the `useSchedulesData` / `useSchedulesOperations` / `useSchedulesUI` selector hooks.

3. **DA controller** ([scripts/da-controller.js](scripts/da-controller.js))
   - Wraps `admin.da.live` for all reads/writes: `getSchedules`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `syncSchedules`, `findScheduleReferences`, `refreshScheduleStatus`.
   - Owns the concurrency-safety machinery (ETag optimistic locking) and the parallel document scanner. See [Concurrency & Data Integrity](#concurrency--data-integrity).

4. **UI** ([ScheduleMaker.js](ScheduleMaker.js) → [pages/Schedules.js](pages/Schedules.js))
   - Two-panel layout: a [Sidebar](components/Sidebar.js) (event picker, sync, schedule list with active/draft badges) and a [ScheduleEditor](components/ScheduleEditor.js) (block editing).
   - The Home page is intentionally bypassed — the app always renders the Schedules layout.

### Data Flow

```
DA SDK ──(token, org, repo, daFetch)──▶ DAContext ──▶ da-controller
                                                          │
   UI ◀── SchedulesContext (state) ◀── CRUD / sync ◀──────┘
                                                          │
                                            admin.da.live (list / source)
```

## Data Model

### Folder Structure (per content repo)

Each event lives in its own folder; the folder path is the **event folder** the app is scoped to (`/` is valid and scans the whole repo).

```
{repo}/
  max2025/
    schedules-active.json    ← schedules referenced in ≥1 DA document
    schedules-draft.json     ← schedules not referenced anywhere yet
    schedule-refs.json       ← reverse index (scheduleId → docs), rebuilt each sync
  max2026/
    schedules-active.json
    schedules-draft.json
    schedule-refs.json
```

> DA "sheets" are `.json` files served by `admin.da.live/source`. Each holds `{ ":type": "sheet", "data": [ ...rows ] }`.

### Schedule Row

| Column | Type | Notes |
|--------|------|-------|
| `scheduleId` | string (UUID) | Client-generated on create; stable identity |
| `title` | string | Human-readable name |
| `blocks` | JSON string | Serialized array of Block objects (parsed on read) |
| `createdTime` | ISO 8601 | Set once on creation |
| `modificationTime` | ISO 8601 | Updated on every save |

`status` (`active` / `draft`) is **not stored** — it is derived from which sheet the row lives in.

### Block Object (inside `blocks`)

```json
{
  "id": "uuid",
  "title": "string",
  "fragmentPath": "/path/to/fragment",
  "startDateTime": 1750000000000,
  "includeLiveStream": false,
  "liveStream": { "provider": "MobileRider", "streamId": "string" }
}
```

`startDateTime` is stored as **epoch milliseconds**. A block is "complete" when it has a `title`, `fragmentPath`, and `startDateTime` (and a `streamId` if `includeLiveStream` is set) — incomplete schedules show a warning icon in the sidebar.

## Active vs Draft

A schedule is **active** if its base64-encoded share link (`?schedule=<b64>`) appears in at least one HTML document within the event folder; otherwise it is **draft**.

Because references are created by humans pasting a link into a document — an action outside the app — the **only** way to detect them is to scan the documents. This is what **Sync** does, and it is the source of truth for the active/draft split. (A reverse index can't help here: a paste happens outside the app, so nothing would update the index until a scan runs anyway.)

### Sync Flow ([syncSchedules](scripts/da-controller.js))

1. Recursively `list` all HTML docs under the event folder.
2. Fetch + regex-scan every doc **in parallel** (see [Sync Performance](#sync-performance)), collecting every `scheduleId` found.
3. Reclassify: move sheet rows between `schedules-active.json` / `schedules-draft.json` to match what the docs contain.
4. Any `scheduleId` found in a doc but absent from both sheets is a **new discovery** and is added to active (reconstructed from the link's base64 payload).
5. Write both sheets back under optimistic locking.

`createSchedule` always writes to the **draft** sheet; `updateSchedule` writes in place to whichever sheet the row currently lives in; `refreshScheduleStatus` re-scans a single schedule and moves it if needed.

Sync also records a **reverse index** (`schedule-refs.json`: `scheduleId → [doc paths]`) used by the "Update pages" feature below.

## Propagating edits to pages ("Update pages")

The embedded `?schedule=<base64>` link is a **point-in-time snapshot** — at render time [decorate.js](../v1/utils/decorate.js) decodes it into the chrono-box block. So when you edit a schedule, docs that embed it still render the **old** snapshot until their link is rewritten.

The **"Update pages"** action (in the editor header, next to Save) handles this:

1. Reads the reverse index (`schedule-refs.json`) to list the docs that embed the schedule — instant, no scan.
2. Shows a confirmation with the affected docs.
3. On confirm, rewrites each doc's link (new base64 payload + refreshed link text) via `propagateScheduleToDocs`.

Key properties:
- **Source only — never publishes.** Writes go to `admin.da.live/source`, which updates the document source but does **not** preview or publish. Authors open each page and publish when ready. (The delete flow is likewise source-only.)
- **Conditional + retried** — each doc write uses `If-Match` and retries on 412, same as the sheets.
- **Stale-index-safe** — the button requires a saved schedule (disabled while there are unsaved changes, like Copy link) and each doc is re-checked before writing; a doc whose link was removed since the last sync is **skipped**, not failed. Because the index is only as fresh as the last sync, a link pasted *after* the last sync won't be listed until you Sync again — the modal says so.

## Concurrency & Data Integrity

All writes are full-sheet read-modify-write operations. Without protection, a save racing a sync would silently clobber the other (last-write-wins). To prevent that, every write uses **ETag-based optimistic locking**.

### How it works

1. `readSheet` captures the sheet's `ETag`.
2. `writeSheet` sends it back as `If-Match`. If the sheet changed since the read, `admin.da.live` (R2) responds **412 Precondition Failed** instead of overwriting.
3. On a 412, the operation **re-reads and retries** (up to `MAX_WRITE_RETRIES`), so the change always lands on top of the latest state. Only if retries are exhausted does a conflict surface to the user.

Semantics of the conditional header:

| Situation | Header sent |
|-----------|-------------|
| Existing sheet, ETag known | `If-Match: <etag>` |
| Existing sheet, ETag unavailable | *(none — unconditional, degrades to last-write-wins)* |
| Sheet does not exist yet (create) | `If-None-Match: *` |

### The weak-ETag gotcha

`admin.da.live` sits behind a CDN that **weakens ETags** (`W/"…"`) when it gzips a response. R2 rejects weak validators on a conditional write, so `normalizeEtag()` strips the `W/` prefix to recover the strong validator before sending `If-Match`. Without this, every conditional write returns 412.

## Sync Performance

The per-document `source` fetch is the sync bottleneck. Scanning is done with a **bounded parallel pool** ([mapWithConcurrency](scripts/da-controller.js)) rather than a sequential loop.

- **`SCAN_CONCURRENCY`** (default `50`) — max in-flight fetches. Raise cautiously and watch for `429`s or a latency plateau; lower it if syncs start aborting.
- **`fetchText` retries** on `429` / `5xx` / network errors with exponential backoff (0.3s → 4s), honoring `Retry-After`.
- **Fail loud, not silent** — a document that can't be read after retries is *not* treated as empty. Sync **aborts with an error** rather than risk misclassifying an active schedule as draft. The delete-reference scan does the same, and blocks deletion until the scan succeeds (deleting on an incomplete scan could leave dangling links).

## Key Features

| Feature | Component | Notes |
|---------|-----------|-------|
| **Event folder picker** | [EventPicker](components/EventPicker.js) | Lists folders via `admin.da.live/list`; last folder remembered in `localStorage`. `/` = whole repo. |
| **Fragment path browser** | [FragmentPathBrowser](components/editor/FragmentPathBrowser.js) | Column navigation over folders/HTML; defaults to `/events/events-shared/fragments`, or pre-navigates to the current path. |
| **Epoch datetime input** | [BlockEditor](components/editor/BlockEditor.js) | Local-time picker synced with an epoch-ms field. |
| **Excel import** | [SheetImporter](components/SheetImporter.js) | Imports schedules as drafts into the current event folder. |
| **URL share** | [utils.js](utils.js) | Copies a base64-encoded schedule link for embedding in DA docs. |
| **Update pages** | [UpdatePagesModal](components/UpdatePagesModal.js) | Rewrites the embedded link in referencing docs (from the reverse index) so pages reflect edits. Source only — no publish. |
| **Delete flow** | [DeleteConfirmationModal](components/DeleteConfirmationModal.js) | Scans for referencing docs, warns, then removes the links (source only) and hard-deletes the row. |

## Access Control

The app contains **no custom permission logic**. It relies on DA's native repo permissions surfaced at the API level:

- User with edit access → API calls succeed.
- User without access → `admin.da.live` returns **403**, which the app catches and renders as a clear *"You do not have access to this repo"* state rather than a broken/empty UI.

## Local Development

DA proxies the app to `localhost` when you append `?ref=local` — using the **same path as production** so one URL works both ways:

```
https://da.live/app/adobecom/da-events/tools/da-apps/schedule-maker?ref=local
```

Serve from the **inner repo root** (which contains `tools/`, `schedule-maker/`, and `v1/`) so the entry path and the `../../v1/deps` imports both resolve:

```bash
cd event-libs/event-libs      # the directory that holds schedule-maker/ and v1/
npx serve . --listen 3000
```

- DA requests `/tools/da-apps/schedule-maker` → `serve` returns [tools/da-apps/schedule-maker.html](../tools/da-apps/schedule-maker.html), the local-dev entry.
- That entry loads assets via absolute paths (`/schedule-maker/...`), so its own location and the request's trailing slash don't matter. It loads the **local** code — distinct from the da-events entry, which loads deployed code from aem.live.
- Milo/Spectrum can be pointed at a local Milo with `?milolibs=local` (→ `http://localhost:6456/libs`) or any branch via `?milolibs=<url>`.

## Deployment

- The app **code** is distributed from `adobecom/event-libs` under `schedule-maker/`.
- On aem.live it is served at `https://main--event-libs--adobecom.aem.live/event-libs/schedule-maker/…` (the repo nests content under an `event-libs/` prefix).
- Each content repo (`da-events`, `da-events-fg-pink`, …) registers its **own** entry point (e.g. `tools/da-apps/schedule-maker.html`) that loads the code from event-libs via absolute aem.live URLs and lets the DA SDK scope it to that repo. The entry can read `context.ref` (and an `?eventlibs=<branch>` override) to load the matching event-libs branch. Adding a new repo requires only a new entry point — no app code changes.
- Floodgate content spaces (e.g. `da-events-fg-pink`) share the parent repo's code, so the same entry serves them automatically — no separate file.

## File Structure

```
event-libs/ (inner repo root — served locally)
├── tools/da-apps/schedule-maker.html   # local-dev entry (mirrors the da-events app path)
└── schedule-maker/
    ├── schedule-maker.js       # bootstrap: load Spectrum, render provider tree
    ├── schedule-maker.css      # app styles (imports component CSS)
    ├── ScheduleMaker.js        # root component (loading / error / layout)
    ├── constants.js            # DA origin, default fragment path, page config
    ├── utils.js                # schedule/block validation, (de)serialization, share URL
    ├── htm-wrapper.js          # re-exports html/h from v1 deps
    ├── context/
    │   ├── DAContext.js        # DA SDK init → token + org/repo
    │   ├── NavigationContext.js  # page/mode + unsaved-changes state
    │   └── SchedulesContext.js   # central state store + CRUD/sync operations
    ├── scripts/
    │   └── da-controller.js    # admin.da.live wrapper: CRUD, sync, ETag locking, scanner
    ├── pages/
    │   ├── Home.js             # bypassed
    │   └── Schedules.js        # two-panel layout (Sidebar + Editor)
    └── components/
        ├── Sidebar.js  EventPicker.js  SearchInput.js  SheetImporter.js
        ├── ScheduleEditor.js  Modal.js  DeleteConfirmationModal.js  UpdatePagesModal.js  *Modal.js
        └── editor/
            ├── ScheduleHeader.js  BlockEditor.js  FragmentPathBrowser.js
```

## Error Handling

- Network / API failures are logged via `window.lana` and returned as `{ ok: false, status, error }` from the controller.
- The UI surfaces errors as Spectrum toasts (`toastError` / `toastSuccess`) or, for repo-level access failures, an inline access-error panel.
- Conflict (412) after exhausted retries and unreadable-document aborts both surface actionable "please retry" messages rather than failing silently or corrupting the active/draft split.
