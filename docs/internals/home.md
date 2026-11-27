# Home

Home is one agent thread per user that acts with the user's reach across every
project on its host environment and the environments that host links to. User
guide: [Home](../user/home.md).

## Where it runs and who may act

- Any server can host Home. A server's Home is on when `ServerSettings.home`
  has a `threadId`. Servers cannot see each other, so "one per user" is a
  client rule: clients derive the user's Home from every enabled environment's
  settings (`client-runtime/src/state/home.ts`), move it off before on, and show
  a conflict when two hosts are on instead of picking one.
- Its state lives in `ServerSettings.home` so every client gets it with the
  settings stream. Clients cannot patch it: the WebSocket settings update drops
  `home`, and only the Home RPCs and Home's own tools write it.
- The grant is "this thread is `home.threadId`", read on every MCP call in
  `mcp/homeRouting.ts`. Turning Home off revokes the old thread's reach at
  once, then holds its queue (`queue.hold`, under the orchestrator's thread
  lock) and interrupts its active run. Fleet operations check the grant again
  right before they act. No credential carries it.
- Each server keeps at most one unarchived `home:` thread and archives the
  rest. While Home is off it archives only `parkedThreadId`, never every
  `home:` thread: a settings file that fails to decode reads as the defaults,
  which look like Home off while its thread is still live.
- Start fresh keeps the thread and its grant. It interrupts the active run and
  queues a `freshContext` message, which starts a new provider session. It
  never holds the queue, since that would hold the fresh message too.
- Home threads are always full-access. The MCP mode check stops a caller from
  acting on a thread broader than itself, and approvals need the widest mode.
  Every change Home makes is checked with `readHomeChangeCaller`: a live Home
  run in full-access/default mode. A user who switches Home to plan mode makes
  it read-only.
- Home never launches into its own folder. That folder's AGENTS.md tells the
  agent it is Home, so Home must name a project or pass `scratch:true`.
- Home thread ids start with `home:` so any client can label Home's messages
  without knowing which environment sent them.

## Reaching other environments

On its host, Home's routed tools run `FleetService` in process: the user's reach
over every project, no deletes.

Elsewhere, Home uses the host's peer links like any thread. `McpToolAccess`
forwards only `HOME_ROUTED_TOOLS` for Home, so a full-access link cannot skip
Home's no-delete rule. On the peer the call is an ordinary linked caller, so
Home cannot answer approvals there; only Home on its own host can.

## Watches

Home is woken by watched thread changes on its host, not by polling.
`HomeWatcher` reads the orchestrator's domain events, batches the threads they
touch, diffs their shells with the desktop-notification transitions, and calls
`HomeService.report`, which queues one notification message in Home's thread
behind its current turn. Clients show it as a status row, and the provider gets
the full report as its turn. Threads in linked environments are not watched;
Home waits on them over the link.

Watches live in `ServerSettings.home`. Threads Home launches are watched with
reason `launched`. A thread the watcher first sees was either created after the
server started, so its first state is news, or it already existed, so that
first state is only a baseline. A watched thread found already settled,
archived or deleted at start-up ends its watch.

The hub picks the id of every thread Home launches, with the `home-launched:`
prefix, and saves the launch watch before the launch starts. While its host has
Home on, clients skip notifications for prefixed threads. The prefix travels
with the thread, so this does not depend on settings reaching the client before
the thread does.

## Moving

A move is client-driven because servers cannot talk to each other. The client
reads Home's folder from the old host (`projects.listEntries` and
`projects.readFile`), turns Home off there, turns it on at the new host, then
writes the files with `projects.writeFile`. Off comes before on, so a failure
leaves Home off rather than on twice. Git history in the Home folder, which only
holds checkpoints, stays behind.
