import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * desktop/build/installer.nsh builds PowerShell commands out of NSIS
 * defines, and only a Windows runner can run them (desktop.yml's smoke test
 * installs over a running copy). This expands the defines as makensis does
 * and holds each command to the shape PowerShell needs, so a command that
 * cannot parse fails here on every system. Once one put assignments inside
 * an `if (...)` condition: the parse error's exit code read as "nothing
 * running", and the installer replaced files under a running app.
 */

const NSH = readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");

/** `!define NAME value`, the value in backticks, double quotes or bare. */
function defines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^!define (\w+) (?:`([^`]*)`|"([^"]*)"|(\S+))$/gm)) out.set(m[1]!, m[2] ?? m[3] ?? m[4]!);
  return out;
}

/** Replaces this file's own `${NAME}`s, again until none is left, then `$$` with `$`, as makensis does. */
function expand(text: string, defs: Map<string, string>): string {
  let out = text;
  for (let i = 0; i < 10 && /\$\{(\w+)\}/.test(out); i++) out = out.replace(/\$\{(\w+)\}/g, (whole, name: string) => defs.get(name) ?? whole);
  return out.replaceAll("$$", "$");
}

/** The PowerShell script each nsExec line passes after -Command, expanded. */
function scripts(text: string): string[] {
  const defs = defines(text);
  return [...text.matchAll(/^\s*nsExec::Exec .*`(.*)`$/gm)]
    .map((m) => expand(m[1]!, defs))
    .filter((cmd) => cmd.includes(" -Command "))
    .map((cmd) => {
      const m = /-Command "(.*)"$/.exec(cmd);
      assert.ok(m, `no quoted script in ${cmd}`);
      return m[1]!;
    });
}

/** The script with single-quoted strings blanked, so their contents never count as code. */
const code = (script: string) => script.replace(/'[^']*'/g, "''");

/** Where each bracket closes, or a problem with the brackets. */
function bracketProblem(script: string): string | null {
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const stack: string[] = [];
  for (const ch of code(script)) {
    if ("({[".includes(ch)) stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return `an unmatched ${ch}`;
  }
  return stack.length > 0 ? `an unclosed ${stack.at(-1)}` : null;
}

/** Each `if (...)` condition's text. PowerShell takes one pipeline there: no statements, no assignment. */
function conditions(script: string): string[] {
  const text = code(script);
  const out: string[] = [];
  for (const m of text.matchAll(/\bif\s*\(/g)) {
    let depth = 0;
    const open = m.index + m[0].length - 1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        out.push(text.slice(open + 1, i));
        break;
      }
    }
  }
  return out;
}

/** Whether a PowerShell condition holds a statement separator or an assignment. */
const notAPipeline = (condition: string) => condition.includes(";") || /\$[\w:]+\s*=(?!=)/.test(condition);

test("the checks see a condition PowerShell cannot parse", () => {
  assert.equal(notAPipeline("$d = $env:X; $n = @(1); Get-CimInstance Win32_Process"), true);
  assert.equal(notAPipeline("$p.Count -gt 0"), false);
  assert.equal(notAPipeline("-not $d"), false);
  assert.deepEqual(conditions("if ($a) { if (@(1).Count -gt 0) { exit 0 } }"), ["$a", "@(1).Count -gt 0"]);
  assert.equal(bracketProblem("try { $p = @(1 }"), "an unmatched }");
  assert.equal(bracketProblem("if ('(' -eq $x) { exit 0 }"), null);
  assert.equal(expand("a ${X} $$b", new Map([["X", "${Y}"], ["Y", "c"]])), "a c $b");
});

test("every PowerShell command the installer runs has a condition PowerShell parses, balanced brackets and no double quote inside", () => {
  const all = scripts(NSH);
  assert.equal(all.length, 2, "the running check and the leftovers' end");
  for (const script of all) {
    assert.ok(!script.includes('"'), `a double quote would end the command line's quoting: ${script}`);
    assert.equal(bracketProblem(script), null, script);
    for (const condition of conditions(script)) assert.ok(!notAPipeline(condition), `if (${condition}) is not one pipeline`);
  }
});

test("the running check tells running, none and could-not-tell apart", () => {
  const check = scripts(NSH).find((s) => s.startsWith("try {"));
  assert.ok(check, "the check runs inside try");
  // Errors stop the script inside try, before the processes are listed, so any of them is exit 2.
  assert.match(check, /^try \{ \$ErrorActionPreference = 'Stop'; \$d = \$env:RACCOONVTT_INSTDIR; if \(-not \$d\) \{ exit 2 \}; \$n = @\('RaccoonVTT\.exe',/);
  assert.match(check, /\$p = @\(Get-CimInstance Win32_Process \| Where-Object \{[^}]*\$_\.ExecutablePath\.StartsWith\(\$d, \[StringComparison\]::OrdinalIgnoreCase\) \}\) \} catch \{ exit 2 \}; if \(\$p\.Count -gt 0\) \{ exit 0 \}; exit 1$/);
  const end = scripts(NSH).find((s) => s.includes("Stop-Process"));
  assert.ok(end?.startsWith("$ErrorActionPreference = 'Stop'; $d = $env:RACCOONVTT_INSTDIR; if (-not $d) { exit 2 }; $n = @("), end);
  assert.match(end ?? "", /; Get-CimInstance Win32_Process \| Where-Object \{.*\} \| ForEach-Object \{ Stop-Process -Id \$_\.ProcessId -Force -ErrorAction SilentlyContinue \}$/);
});

test("the installer goes on only when nothing runs, and stops with words when a program is left or the check fails", () => {
  const body = /!macro customCheckAppRunning\n([\s\S]*?)\n!macroend/.exec(NSH)?.[1];
  assert.ok(body);
  const lines = body.split("\n").map((l) => l.trim());
  assert.match(/!macro raccoonWait[\s\S]*?!macroend/.exec(NSH)?.[0] ?? "", /\$\{If\} \$\{RESULT\} != 0\n\s*\$\{OrIf\} \$R7 >= \$\{SECONDS\}\n\s*\$\{Break\}/);
  const breakAt = lines.indexOf("${Break}");
  assert.equal(lines[breakAt - 1], "${If} $R8 == 1", "only none running leaves the loop");
  const boxes = lines.flatMap((l, i) => (l.startsWith("MessageBox ") ? [i] : []));
  assert.equal(boxes.length, 2, "one for a program still running, one for a check that failed");
  for (const at of boxes) {
    assert.match(lines[at]!, /^MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "[^"]+" \/SD IDCANCEL IDRETRY \+2$/, "a silent install cancels, Retry skips the Quit");
    assert.equal(lines[at + 1], "Quit");
  }
  assert.equal(lines[boxes[0]! - 2], "${ElseIf} $R8 == 0");
  assert.equal(lines[boxes[1]! - 2], "${Else}");
  for (const at of boxes) assert.doesNotMatch(/"([^"]+)"/.exec(lines[at]!)?.[1] ?? "", /[\u2014;]/, "house style in the words");
});
