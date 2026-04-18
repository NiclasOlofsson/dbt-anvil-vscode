# dbt Studio Startup Behavior

This document explains what dbt Studio does automatically during startup, in the order it happens.

Its purpose is to give developers a practical mental model of the startup lifecycle so they can quickly understand where activation is in the process, why a feature may not be ready yet, and where to troubleshoot when something goes wrong.

Use this as an operational startup map: it describes the automatic checks, gates, and bootstrap steps that move the extension from "project opened" to "fully dbt-ready".

## Quick summary

This is what happens during startup to recognize the project and make sure dbt Studio can activate correctly with full dbt-aware features:

1. Detect an open workspace folder and establish [`projectDir`](#step-1-workspace-and-project-root-detection).
2. Detect whether the folder is a dbt project by resolving [`dbt_project.yml`](#step-1-workspace-and-project-root-detection).
3. Detect and prepare the Python environment via [environment detection](#step-2-python-environment-detection-and-preparation), [Python validation](#step-2-python-environment-detection-and-preparation), [env manager check](#step-2-python-environment-detection-and-preparation), and [bootstrap](#step-2-python-environment-detection-and-preparation).
4. Validate dbt working state and ensure base dbt setup is in place via [dbt binary validation](#step-3-dbt-working-state-and-base-setup), [`dbt_packages` readiness](#step-3-dbt-working-state-and-base-setup), and startup [`dbt deps`](#step-3-dbt-working-state-and-base-setup) when needed.
5. Complete manifest/bootstrap readiness by checking [manifest availability](#step-4-manifest-and-bootstrap-readiness), applying [parse gating](#step-4-manifest-and-bootstrap-readiness), running startup [`dbt parse`](#step-4-manifest-and-bootstrap-readiness), and refreshing index-backed capabilities in [Step 5](#step-5-index-readiness-and-feature-activation).

## Full startup sequence (step-by-step)

### Step 1: Workspace and project root detection

#### 1.1 Workspace folder check

- **What happens**
	- dbt Studio reads the list of open workspace folders from VS Code.
	- If no folder is open, activation returns early.
- **How it is detected**
	- dbt Studio checks whether VS Code currently has at least one folder/workspace open. If no folder is open, there is no project context to initialize against.
- **What users see if it fails**
	- A warning in logs and limited extension behavior.

#### 1.2 Project root and dbt project detection

- **What happens**
	- The first workspace folder becomes `projectDir`.
	- dbt Studio loads project config service and checks whether this is a dbt project.
- **How it is detected**
	- dbt Studio checks for a readable `dbt_project.yml` in the project context. If that file is found and valid, the folder is treated as a dbt project.
- **What users see if it fails**
	- dbt-specific features are limited until a valid dbt project is opened.

### Step 2: Python environment detection and preparation

#### 2.1 Python environment type detection

- **What happens**
	- dbt Studio detects environment strategy (venv / uv / poetry / pipenv / conda / system).
- **How it is detected**
	- dbt Studio infers the environment by checking common project markers and runtime context in priority order: local virtual environments (`.venv` / `venv` / `.env`), then lockfiles for `uv`, Poetry, and Pipenv, then active Conda context, and finally system Python as a fallback.
- **What users see if it fails**
	- It still continues, but later validation may fail.

#### 2.2 Python runtime validation

- **What happens**
	- dbt Studio checks whether Python is accessible and working inside the detected environment.
- **How it is detected**
	- For managed environments (uv, pipenv, etc.), this runs through the full managed command — for example `uv run --directory <project> python --version`. This requires **both** the manager CLI to exist **and** the managed environment to already be set up (e.g. `.venv` created). If the environment has never been initialised, this step fails even if the manager itself is correctly installed.
	- If this succeeds, steps 2.3 and 2.4 are skipped entirely.
- **What users see if it fails**
	- Moves to 2.3 to diagnose the cause.

#### 2.3 Environment manager availability check (only when 2.2 fails)

- **What happens**
	- Step 2.2 failed, but that could mean two very different things: either the manager CLI is not installed at all, or the manager is fine but the environment just hasn't been created yet (e.g. fresh clone). Step 2.3 distinguishes between these two cases.
- **How it is detected**
	- dbt Studio probes just the manager CLI itself (for example `uv --version`, `poetry --version`, or `pipenv --version`) — no environment involvement.
	- If the CLI is missing → error shown, startup stops (can't bootstrap without it).
	- If the CLI is present → environment likely just needs to be created, proceed to 2.4.
- **What users see if it fails**
	- Error message prompting install/reload.

#### 2.4 Python environment bootstrap (when applicable)

- **What happens**
	- dbt Studio runs environment install/sync command (for supported managers) to repair/setup Python dependencies.
- **How it is detected**
	- dbt Studio picks the install/sync command for the detected manager and runs it in the project directory. For example: `uv sync --directory <projectDir>` for uv, `pipenv install` for pipenv, or `poetry install --directory <projectDir>` for Poetry. For plain venvs, conda, and system Python there is no lockfile manager, so this step is skipped.
- **What users see if it fails**
	- Error notification; startup continues in degraded mode.

### Step 3: dbt working state and base setup

#### 3.1 dbt binary validation

- **What happens**
	- After Python is ready, dbt Studio validates that `dbt` is available in that environment.
- **How it is detected**
	- dbt Studio runs a dbt version check through the same environment context used for project commands.
- **What users see if it fails**
	- Attempts bootstrap if possible; otherwise shows actionable error and reload guidance.

#### 3.2 `dbt_packages` dependency readiness check

- **What happens**
	- dbt Studio checks if dependencies were already installed.
	- If missing, it queues startup `dbt deps` automatically.
- **How it is detected**
	- dbt Studio checks whether the `dbt_packages/` directory exists inside the project root. If it is absent, packages have never been installed.
- **What users see if it fails**
	- `dbt deps: failed` message; parse bootstrap waits and does not run.

#### 3.3 Startup `dbt deps` execution

- **What happens**
	- Runs `dbt deps` in the execution queue as startup bootstrap work.
	- On success: marks deps-ready and allows bootstrap parse.
- **How it is detected**
	- dbt Studio submits `dbt deps` as a background job and waits for it to complete. Success or failure is determined by the exit code and any error output from dbt.
- **What users see if it fails**
	- Error notification with the failure details from dbt.

### Step 4: Manifest and bootstrap readiness

> **About dbt Studio's internal target directory**
>
> dbt Studio maintains its own isolated dbt output directory, separate from the project's `target/` folder. When dbt Studio runs `dbt parse` or `dbt compile` internally, the output (including `manifest.json`) is written to a private directory inside VS Code's extension storage — not into your workspace. Your own `target/` folder is never touched by dbt Studio's background operations.
>
> This means the manifest dbt Studio uses for model intelligence, lineage, and completions is its own private copy, kept in sync by the extension. It is not the same file that `dbt run` or `dbt build` writes to your project.
>
> The exact location is VS Code's workspace-scoped extension storage, inside a `target/` subfolder. On Windows this is typically `%APPDATA%\Code\User\workspaceStorage\<workspace-hash>\nickeolofsson.dbt-studio\target\`. On macOS/Linux it is under `~/.config/Code/User/workspaceStorage/` with the same structure. The `storageDir` path is also logged to the dbt Studio output channel at startup — search for `storageDir:` to find it.

#### 4.1 Hot start vs cold start

Step 4 branches into two paths depending on whether a manifest already exists in dbt Studio's private target directory:

- **Hot start** — manifest exists from a previous session. dbt Studio loads and indexes it immediately, sets status to ready, and skips `dbt parse` entirely. This is the normal path on every reload after the first.
- **Cold start** — no manifest yet (first ever open, storage was cleared, or workspace hash changed). dbt Studio must generate one from scratch by running `dbt parse` in the background.

> **`dbt parse` vs `dbt compile`**: `dbt parse` only validates the project and generates `manifest.json`. It does not compile SQL or run any models. It is fast and safe to run in the background. `dbt compile` goes further — it renders all Jinja and produces compiled SQL — and is only triggered on demand (e.g. when opening a model file), never as part of the startup sequence.

#### 4.2 Cold start: startup parse gating

- **What happens**
	- Before triggering the background parse, dbt Studio checks that two conditions are met: no manifest exists yet, and deps are ready (either already installed, or startup `dbt deps` just completed). A one-shot guard prevents parse from being triggered more than once per session.
- **How it is detected**
	- Both conditions are checked at the same point. If deps are still running, parse is deferred and will be triggered automatically when deps finish.
- **What users see if it fails**
	- Parse is deferred until deps succeeds.

#### 4.3 Cold start: `dbt parse` execution

- **What happens**
	- dbt Studio runs `dbt parse` as a background job to generate `manifest.json` in its private target directory.
	- On success: rebuilds manifest index, refreshes all views and providers, sets status to ready.
- **How it is detected**
	- dbt Studio submits the parse job and waits for completion. Success is determined by exit code; on failure, the error output from dbt is surfaced.
- **What users see if it fails**
	- Status/error message with parse failure details.

### Step 5: Index readiness and feature activation

- **What happens**
	- **Hot start**: manifest index is built immediately from the cached manifest. Status is set to ready without waiting for any background job.
	- **Cold start**: index is built after the background `dbt parse` completes. All index-backed views (model explorer, lineage graph, test explorer) are refreshed, the database provider is re-initialised, and status is set to ready.
	- **Compile cache warm-up**: once the manifest is ready, dbt Studio kicks off a full `dbt compile` in the background to pre-populate its compile cache. This makes hover, go-to-definition, and column-level features feel instant when you open the first model. If enough compile entries were restored from a previous session, this step is skipped entirely.
- **How it is detected**
	- Hot start: manifest exists check at activation time triggers immediate index build.
	- Cold start: successful parse job completion triggers the same index build + refresh sequence.
	- Compile warm-up: runs unconditionally after the manifest is indexed, unless the restored cache is already large enough.
- **What users see if it fails**
	- dbt Studio may stay partially initialized (for example limited lineage/model intelligence) until parse/index completes successfully.
	- A failed compile warm-up is non-fatal — features still work, but the first hover or compile request may be slower than usual.

### Additional behavior: Optional launch configuration creation

- **What happens**
	- dbt Studio can create/add dbt SQL launch entries in `.vscode/launch.json`.
- **How it is detected**
	- Setting `dbt-studio.ensureLaunchConfig` (default `true`).
- **What users see if it fails**
	- No crash path; launch entries simply are not added.

## Where to look when startup goes wrong

- **Python not detected/invalid**
	- Check selected interpreter/environment and manager CLI availability.

- **dbt not installed**
	- Verify `dbt --version` works in the resolved environment.

- **Deps failed**
	- Check package registry access, auth, network, and package sources.

- **Parse failed**
	- Open dbt Studio output and inspect first compilation/parsing error.

- **No lineage/model intelligence yet**
	- Startup bootstrap parse likely has not completed successfully yet.

