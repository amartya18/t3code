# Copy a conversation

The web and desktop clients can copy all completed message text from the active thread.

Select **Copy chat** in the top-right area of the chat header. T3 Code copies a Markdown
transcript to the clipboard. You can paste this transcript into another thread or another text
editor.

The transcript uses `## User` and `## Agent` headings. It keeps the Markdown and code blocks in each
message. It does not include the thread ID, project path, timestamps, tool activity, approvals,
plans, or diffs.

Prompt context that T3 Code sent to the agent stays in the user message text. This context can
include terminal text or selected page elements.

The action is not available while the agent works. Wait until the current turn is complete. T3 Code
does not shorten long transcripts. If the clipboard cannot accept the text, T3 Code shows an error.
