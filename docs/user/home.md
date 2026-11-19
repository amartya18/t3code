# Home

Home is one agent that works across your projects. Ask it to start threads,
check on them, answer their questions, approve their requests, rename, settle,
snooze or archive them.

You have one Home. It runs on whichever environment you choose: the desktop
app, or a T3 Code server you keep running elsewhere, such as a home server.

## Start Home

Open **Settings → Home** in the desktop app, the web app or the mobile app.
Choose the environment Home runs on, pick a model and turn it on. Home then sits
at the top of the sidebar, labeled with its environment when that is not this
device. Open it from there, from the command palette, or with its keyboard
shortcut.

Home always runs in full access. It can approve requests in your other threads,
so choose a model you trust with that.

## What Home does on its own

- Threads Home starts are normal threads in your sidebar. You can open and steer
  them yourself.
- Home links every thread it mentions. Click a link to open that thread.
- Home hears about the threads it started on its own environment when they
  finish, fail, ask a question or need an approval, even while no app is open.
  You are not notified about those threads; Home tells you what matters in its
  own thread.
- Home leaves the threads you started alone. Ask it to watch a thread, or every
  thread on its environment, when you want it to step in.
- Home cannot delete threads or projects.
- Agents you connect to T3 Code over MCP read Home's latest messages and the
  threads it started with `t3_home_read`, which never wakes it. To give Home a
  task, they use `t3_home_send`, which finds Home's thread for them.
- A message sent to Home while it works, from the app or over MCP, joins its
  current turn at its next tool call instead of cutting off its reply.

## Other environments

Home reaches the environments its own environment is linked to, the same ones
any thread there can use. To let Home work on another machine, link that
machine from Home's environment; see
[Link another environment](./remote-access.md#link-another-environment).

In a linked environment Home can start threads, read them, send messages and
answer questions. Only you can approve requests there. Home is not woken by
threads there; it checks on them when you ask, or waits on them.

## Moving Home

**Settings → Home → Runs on** moves Home to another connected environment, on
desktop and web. The current Home stops, a new Home thread starts on the new
environment with the model you pick, and Home's notes and instructions are
copied over. The old thread stays in the old environment's history. Large or
binary files stay behind, and the move tells you which.

Home can only move while its current environment is reachable. If a move fails
halfway, Home is off; turn it on again. If Home ever ends up on in two places,
Settings → Home lets you keep one.

## Instructions and fresh starts

Home's `AGENTS.md` lives in its folder on the environment it runs on. When that
is this device, **Settings → Home → Instructions** opens it. Add standing
instructions below T3 Code's section, including where Home should keep what it
learns. Its folder is scratch space only.

**Start fresh** clears what Home remembers of its chat. It stays the same
thread, and the history above stays visible, but Home no longer sees it. Its
instructions carry over.

Turning Home off stops it from acting. Its thread stays in your history.
