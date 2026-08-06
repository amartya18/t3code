# Copy a conversation

The web and desktop clients can copy all completed message text from the active thread.

Select **Copy chat** in the top-right area of the chat header. T3 Code copies a Markdown
transcript to the clipboard. You can paste this transcript into another thread or another text
editor.

The transcript starts with the thread title as a heading. Each message follows under a `## User` or
`## Agent` heading, with the Markdown and code blocks of that message. The transcript does not
include the thread ID, project path, timestamps, tool activity, approvals, plans, or diffs.

## Omitted parts

T3 Code writes a short note in place of content that a transcript cannot carry:

- `_[1 terminal context omitted]_` for terminal text that you attached to a prompt.
- `_[2 page elements omitted]_` for page elements that you selected in the preview.
- `_[1 image attached]_` for an image attachment.

Terminal and page context can be much larger than the conversation, so the transcript keeps only
the prompt text that you wrote.

## While the agent works

You can copy during a turn. The transcript then holds the messages that are complete. The message
that the agent still writes is not in the transcript. Copy again after the turn to get the full
answer.

T3 Code does not shorten long transcripts. If the clipboard cannot accept the text, T3 Code shows an
error.
