/**
 * Offline unit tests for the PowerShell command builders. These validate the
 * exact commands the GUI tools generate (escaping, guards, flags) with no
 * Windows and no clipboard — the CI-friendly way to cover rdt_type / rdt_mouse
 * / rdt_focus / rdt_list_windows / rdt_launch / rdt_processes.
 *
 * Run:  node scripts/test-builders.mjs   (after npm run build)
 */

import {
  buildFocus, buildLaunch, buildListWindows, buildMouse, buildProcesses,
  buildSendKeys, escapeSendKeys, psSingleQuote,
} from "../dist/psbuilders.js";

let fail = 0;
const count = (s, sub) => s.split(sub).length - 1;
function check(name, cond, detail = "") {
  if (!cond) fail++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

// psSingleQuote
check("psSingleQuote escapes quotes", psSingleQuote("O'Brien") === "'O''Brien'");

// escapeSendKeys
check("escape wraps SendKeys metachars", escapeSendKeys("a+b^c%d~e") === "a{+}b{^}c{%}d{~}e");
check("escape wraps parens/brackets", escapeSendKeys("(x)[y]") === "{(}x{)}{[}y{]}");
check("escape wraps braces", escapeSendKeys("{x}") === "{{}x{}}");
check("escape maps newline/tab", escapeSendKeys("a\nb\tc") === "a{ENTER}b{TAB}c");

// buildLaunch
const launch = buildLaunch({ program: "notepad.exe", args: "-a 'x'", workingDirectory: "C:\\tmp" });
check("launch uses Start-Process -PassThru", launch.includes("Start-Process -PassThru -FilePath 'notepad.exe'"));
check("launch escapes args quote", launch.includes("-ArgumentList '-a ''x'''"));
check("launch sets working dir", launch.includes("-WorkingDirectory 'C:\\tmp'"));
check("launch echoes PID", launch.includes("$p.Id"));

// buildFocus
check("focus by pid", buildFocus({ pid: 1234 }).includes("AppActivate([int]1234"));
check("focus by title escapes", buildFocus({ title: "O'Brien" }).includes("AppActivate('O''Brien')"));

// buildListWindows
const lw = buildListWindows();
check("list_windows filters windowed procs", lw.includes("MainWindowHandle") && lw.includes("MainWindowTitle"));
check("list_windows emits JSON array", lw.includes("ConvertTo-Json") && lw.includes("'[]'"));

// buildProcesses
check("processes honours top", buildProcesses(5).includes("-First 5"));
check("processes clamps to <=200", buildProcesses(9999).includes("-First 200"));
check("processes defaults to 20", buildProcesses(0).includes("-First 20"));

// buildMouse
const mRight = buildMouse({ x: 10, y: 20, button: "right", action: "click" });
check("mouse sets cursor pos", mRight.includes("SetCursorPos(10, 20)"));
check("mouse guards Add-Type", mRight.includes("if (-not ('RdtMouse' -as [type]))"));
// Count the qualified call, not the C# declaration which also says "mouse_event(".
const CALL = "[RdtMouse]::mouse_event(";
check("mouse right button flags", mRight.includes(CALL + "8,") && mRight.includes(CALL + "16,"));
check("mouse click = one down+up pair", count(mRight, CALL) === 2);
check("mouse double = two pairs", count(buildMouse({ x: 1, y: 1, action: "double" }), CALL) === 4);
check("mouse move = no click", count(buildMouse({ x: 1, y: 1, action: "move" }), CALL) === 0);
check("mouse left default flags", buildMouse({ x: 0, y: 0 }).includes(CALL + "2,"));

// buildSendKeys
const sk = buildSendKeys({ keys: "^c", windowTitle: "Notepad" });
check("send_keys activates window", sk.includes("AppActivate('Notepad')"));
check("send_keys calls SendWait", sk.includes("SendKeys]::SendWait('^c')"));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
