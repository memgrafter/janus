---
id: jan-yjlf
status: open
open: true
deps: []
links: []
created: 2026-09-03T13:47:41Z
type: research
priority: 1
assignee: memgrafter
parent: jan-7uv8
tags: [zcode, captcha, browser, constraint]
---
# AppleScript/osascript is BANNED — do not use for browser tab control or inspection

The user has explicitly banned AppleScript/osascript for browser automation ('sketchy'). This applies to BOTH the janus product code AND agent test/inspection commands.

What happened: during keeper-tab debugging, the agent used osascript to (a) count captcha tabs and (b) read the frontmost app to verify no focus-steal. The janus source itself is clean (uses 'open -g' only), but the agent's own shell inspection commands violated the ban.

Rule going forward:
- NEVER use osascript / AppleScript to drive or inspect a browser (open/reload/close tabs, read tab URLs, read frontmost app).
- janus product code: browser interaction is 'open -g <url>' (background tab, no focus steal) only. No AppleScript, no compile-time browser embedding, no headless/fresh-profile browsers (they fail Aliyun traceless verify).
- For inspection, use non-AppleScript means: 'lsof -nP -iTCP:<port>' for connections, the janus debug log, or ask the user.

Constraint context (from the user): no AppleScript, no compile-time browser embedding, no headless/fresh-profile browsers. Local mode stays 'open -g' background tab.
