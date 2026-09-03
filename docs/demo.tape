# VHS tape for the README demo GIF.  Render:  vhs docs/demo.tape
# Records the offline protocol self-test + tool list — no Citrix/Windows needed.

Output docs/demo.gif

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 28
Set Theme "Dracula"
Set TypingSpeed 30ms

Hide
Type "export PATH=/opt/homebrew/bin:$PATH; cd /Users/francoischastel/Documents/github.com/FrancoisChastel/RemoteDesktopTerminal; clear"
Enter
Sleep 600ms
Show

Type "# CitrixMCP — drive Windows PowerShell over the Citrix clipboard"
Enter
Sleep 900ms

Type "#   Mac (MCP server)  <-- synced clipboard -->  Windows helper"
Enter
Sleep 1200ms

Type "npm run selftest"
Enter
Sleep 3200ms

Type "#  ^ ping, exec, 5000-byte upload+download, screenshot — all over a clipboard"
Enter
Sleep 1800ms

Type "npm run test:builders | tail -n 5"
Enter
Sleep 2600ms

Type "#  12 MCP tools: run / launch / list_windows / focus / type / mouse / screenshot / upload / download ..."
Enter
Sleep 2600ms
