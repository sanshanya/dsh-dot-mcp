# dsh-dot-mcp

> **Expose DSH as one local MCP endpoint.** ChatGPT creates tasks, continues
> sessions, starts and updates native goals, handles approvals, and reads
> results; DSH keeps the agent loop, tools, skills, subagents, sandbox,
> approvals, goal lifecycle and workspace security model.

**The bridge connects the two sides. It does not replace DSH, modify DSH
core, or route DSH model traffic through ChatGPT.**

## What this is

An MCP server bound to `127.0.0.1:<port>` (default `3456`) with **no token and
no auth headers**, serving **21 tools** over four planes:

- **Sessions** — create, list, inspect, continue, cancel.
- **Native goals** — every goal verb is a thin map onto the host's own
  GoalService: `dsh_create_goal` → `create`, `dsh_revise_goal` → `edit`
  (revision CAS via `expected_revision`), `dsh_resume_goal` → `resume`,
  `dsh_pause_goal` → `pause`, `dsh_stop_goal` → `clear`. Wait loops report
  `goal_outcome ∈ ended|no_goal|timeout|action_required` plus the raw native
  goal view.
- **The human in the loop** — approvals and questions park verbatim for the
  remote driver while the host GUI is absent, and settle through `dsh_approve`
  / `dsh_answer_question`; the bridge keeps no policy of its own.
- **The workspace boundary** — one mutable session per workspace, plus the
  request-id maps that make retries safe.

This tree is **v0.7.0** (unpublished) and targets DSH **0.2.0-rc.2**, with peer
and dev dependencies pinned to that graph. The layout, module ownership and wire
vocabulary are mapped in
[ARCHITECTURE.md](ARCHITECTURE.md); the 21 frozen tool names the real-boundary
tiers assert live in exactly one place: `test/integration/frozen-wire.mjs`.

## Install (development tree, `link:`)

```bash
npm run build
dsh plugin --profile web add /path/to/this/tree
```

The profile pins `dsh-dot-mcp` as a `link:` dependency, so rebuilding
this tree refreshes it; the host must recompose (reload/restart) to load new
code.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `transport` | `streamable-http` | `streamable-http` or `stdio` |
| `host` / `port` | `127.0.0.1` / `3456` | MCP HTTP bind (loopback enforced; non-loopback is refused) |
| `resultMaxChars` / `resultMaxItems` | `8000` / `50` | tool-result caps |
| `sessionMaxItems` / `sessionMaxChars` | `20` / `4000` | session-history caps |
| `logLevel` | `info` | bridge log verbosity |
| `autoApproveEscalations` | `false` | Grant every sandbox-escalation ask on a bridge-managed session, to the mode the tool requested (usually `danger-full-access`), instead of parking it for `dsh_approve`/the GUI. See "Auto-granting escalations" below. |

### Auto-granting escalations

`autoApproveEscalations: true` is the unattended mode: nothing waits for a
decision, so `dsh_approve` never sees a pending ask and an attached GUI client
gets no card either. Two consequences worth stating plainly:

- It only covers asks that **exist**. A tool call that never requests a wider
  mode is still refused by the sandbox outright (the denial happens inside the
  sandbox, with no request — the bridge never sees it). To have no refusals at
  all, set the session's permission preset to `danger-full-access` instead;
  that is a host-side knob, not a bridge one.
- Every grant is logged at `warn` and advertised as
  `dsh_health.capabilities.autoApproveEscalations`, so a driver can tell that
  nothing will park. This is the one place the bridge grants instead of
  relaying; off is the shipped default.

## Security notes

- **No authentication**: any local **process** that can reach
  `127.0.0.1:<port>` can drive DSH through all 21 tools. The browser-side wall
  is DNS-rebinding protection: it refuses non-loopback `Host` headers and any
  incoming `Origin` that is not scheme-less-loopback, so malware-served web
  pages cannot drive the endpoint either. Do not bind a public interface (the
  server refuses non-loopback), and if you ever put it behind a reverse
  proxy/tunnel yourself, front it with your own auth — there is no built-in
  credential.
- **No secret scrubbing**: tool outputs and logs carry caller/agent text
  **verbatim**. A pattern-matching redactor was tried and removed — it was a
  screen door (it missed JWT/`ghp_*`/`AKIA*` and misfired on commit SHAs), not a
  boundary. Do not feed credentials into agent output — do not ask an agent to
  `cat .env` or print token-bearing URLs — because anything a session prints can
  reach the model provider you connected.
- **Approvals relay verbatim**: the bridge keeps no risk matrix, posture, or
  deny list of its own — the host's own allow/ask/deny hooks decide what asks at
  all, and when the host GUI is absent, every question reaches the remote driver
  (and its model) via `dsh_approve` with the raw tool name and command. Whoever
  you connect as the MCP client *is* the approval authority; connect nothing you
  would not hand that authority to.

## Development — the verification tiers

| Tier | Command | What it proves |
| --- | --- | --- |
| Unit | `npm test` | 161 tests against synthetic contexts; fast, always run |
| Release | `npm run test:release` | Packs this tree, installs the tarball + official `@deepseek-ai/dsh@0.2.0-rc.2` into a throwaway directory, asserts the tarball holds exactly one compiled artifact per source module (a stale `lib/` ghost can no longer ship), and runs the integration lanes there: a real CLI boot (isolated profile, real preset registry, MCP create/read, host web login) and a real in-process host (Cordis + AgentLoop + JSONL persistence + relayed approval) |
| Live | `BRIDGE_DSH_DIR=/path/to/deepseek-harness npm run test:live` | Boots a real harness checkout with the packed artifact and asserts the served 21-tool vocabulary |
| Golden | `npm run test:golden` against a running test instance | Drives all 21 frozen tools over the real MCP wire (real model turns, both relays, the native goal lifecycle) and fails if any frozen tool was never invoked |

## Golden E2E (a real test instance, driven over MCP)

The tiers above isolate their subjects. This lane does not: it stands up a
**separate DSH home**, installs the packed plugin into a profile, boots the
real CLI, and then drives the bridge over its MCP wire exactly as ChatGPT
would — real agent turns against a real model, the approval and question
relays, the native goal lifecycle, idempotency, persistence, and the
fail-closed edges.

```bash
# 1. Build the throwaway instance: own DSH_HOME, reusing the real home's
#    provider credentials + workspace registry, plus its own scratch workspace.
G=/tmp/dsh-golden-home
mkdir -p $G/profiles/golden $G/storages && chmod 700 $G
cp ~/.dsh/.env ~/.dsh/.credentials.yaml $G/          # model access (chmod 600)
cp ~/.dsh/storages/workspace.json $G/storages/       # registered workspaces
npm pack --pack-destination /tmp                     # the artifact under test
# profile: bundles [dsh-base, dsh-web-app, dsh-dot-mcp] + pnpm install
# of the tarball (file:), a patch copying the provider rows, a patch row
# overriding the bridge PORT (the shipped patch pins 3456), and a fixture row
# registering /tmp/golden-workspace. Recipe verified against 0.2.0-rc.2.

# 2. Boot it.
cd <deepseek-harness checkout>
DSH_HOME=/tmp/dsh-golden-home node --import tsx/esm apps/cli/src/bin.ts \
  --profile golden --host 127.0.0.1 --port 0 --no-open

# 3. Drive it (BRIDGE_URL / BRIDGE_WORKSPACE_SUFFIX / BRIDGE_DSH_HOME override
#    the defaults).
npm run test:golden
```

**The lane ends with a frozen-wire coverage ledger.** It compares the tools
actually invoked against `test/integration/frozen-wire.mjs` and fails if a
frozen tool was never driven, so "every tool is covered" is a checked property
of the lane rather than a claim. Each entry is `✔` (happy path proven over the
wire) or `·` (only its fail-closed edge was driven — e.g. the relay stages when
the instance declines to ask). Last measured: **79 pass · 0 fail · 0 skip,
21/21 tools on their happy path**.

Three behaviours are worth knowing when reading the output:

- The approval stages ask the agent to **request the escalation explicitly**
  (`sandbox_permissions`): a wider write without that request is refused by the
  sandbox outright, raising no approval at all. The gate decision itself stays
  the human's — the lane answers it with `dsh_approve` (`approve` then
  `reject`), and asserts both outcomes (the approved write lands in the real
  home directory; the rejected one leaves no file).
- Stages that need the instance to ask at all (approval/question relays) SKIP
  rather than fail with a `danger-full-access` preset: "nothing asked" is not a
  bridge defect, and the ledger then says which tool stayed on its fail-closed
  edge.
- The lane follows the instance's posture: with `autoApproveEscalations: true`
  (see Configuration) the approval stage asserts that NOTHING parks and the
  wider write still lands, reports the `dsh_approve` path as SKIP, and the
  ledger marks that tool fail-closed-only. Last measured: **79 pass · 0 fail ·
  0 skip** with the switch off, **70 pass · 0 fail · 1 skip** with it on.

## License

MIT. See [LICENSE](LICENSE).

---

**Unofficial community project. Not affiliated with or endorsed by OpenAI or DeepSeek.**