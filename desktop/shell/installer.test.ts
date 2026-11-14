import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parentProblem, POWERSHELL_SCRIPTS, type AclRule } from "../runtime/pgPaths.ts";

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
const PROGRAMDATA = readFileSync(new URL("../build/programdata.ps1", import.meta.url), "utf8");

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

test("the install makes RaccoonVTT's folder in ProgramData with programdata.ps1, run by Windows PowerShell's full path, and the uninstall leaves it", () => {
  const body = /!macro customInstall\n([\s\S]*?)\n!macroend/.exec(NSH)?.[1];
  assert.ok(body);
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith(";"));
  const at = lines.indexOf("InitPluginsDir");
  assert.ok(at >= 0);
  assert.deepEqual(lines.slice(at, at + 7), [
    "InitPluginsDir",
    'File "/oname=$PLUGINSDIR\\raccoonvtt-programdata.ps1" "${BUILD_RESOURCES_DIR}\\programdata.ps1"',
    'nsExec::Exec /TIMEOUT=60000 `"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\raccoonvtt-programdata.ps1"`',
    "Pop $0",
    "${If} $0 != 0",
    'DetailPrint "RaccoonVTT could not make its folder in ProgramData (PowerShell: $0)."',
    "${EndIf}",
  ]);
  const uninstall = /!macro customUnInstall\n([\s\S]*?)\n!macroend/.exec(NSH)?.[1] ?? "";
  assert.doesNotMatch(uninstall.replace(/^\s*;.*$/gm, ""), /ProgramData|RMDir|programdata/i);
});

/** programdata.ps1's code, its comments left out. */
const PS1 = PROGRAMDATA.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

test("programdata.ps1 makes the folder with its security descriptor in one call, owned by Administrators, with an ACL of its own", () => {
  assert.equal(bracketProblem(PS1), null);
  assert.ok(!/\bNew-Item\b|\bmkdir\b|\bmd\b|Remove-Item|icacls|Test-Path|Set-Acl|SetAccessControl/i.test(PS1), "never made then tightened, never mended in place, never deleted, never found through a link");
  assert.match(PS1, /\[void\]\[System\.IO\.Directory\]::CreateDirectory\(\$path, \$security\)/);
  assert.match(PS1, /\$security\.SetOwner\(\$admins\)/);
  assert.match(PS1, /\$security\.SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(PS1, /Join-Path \(\[Environment\]::GetFolderPath\('CommonApplicationData'\)\) 'RaccoonVTT'/);
  // Anything there that Administrators don't own, or that is a link, is moved aside and the loop makes a new one.
  assert.match(PS1, /Rename-Item -LiteralPath \$path -NewName \('RaccoonVTT\.untrusted-'/);
  assert.match(PS1, /if \(\$item\.Attributes -band \[System\.IO\.FileAttributes\]::ReparsePoint\) \{ return \$false \}/);
  assert.match(PS1, /if \(-not \(\(\$owner -eq \$admins\) -or \(\$owner -eq \$system\)\)\) \{ return \$false \}/);
  // Trusted only with exactly the installer's ACL: protected, as many entries as it gives, each matched in every field, none inherited.
  assert.match(PS1, /if \(-not \$acl\.AreAccessRulesProtected\) \{ return \$false \}/);
  assert.match(PS1, /\$want = @\(\$security\.GetAccessRules\(\$true, \$true, \[System\.Security\.Principal\.SecurityIdentifier\]\)\)/);
  assert.match(PS1, /if \(\$have\.Count -ne \$want\.Count\) \{ return \$false \}/);
  for (const field of ["IdentityReference", "FileSystemRights", "InheritanceFlags", "PropagationFlags", "AccessControlType"]) assert.ok(PS1.includes(`($_.${field} -eq $w.${field})`), field);
  assert.ok(PS1.includes("(-not $_.IsInherited)"));
  assert.match(PS1, /if \(\$same\.Count -ne 1\) \{ return \$false \}/);
  // A folder there is kept only when trusted, and anything else, an Administrators-owned folder with another ACL included, is moved aside.
  assert.match(PS1, /if \(Get-Item -LiteralPath \$path -Force -ErrorAction SilentlyContinue\) \{\n\s*if \(Test-Trusted \$path\) \{ exit 0 \}\n\s*Rename-Item -LiteralPath \$path -NewName \('RaccoonVTT\.untrusted-' \+ \[DateTime\]::UtcNow\.Ticks\)\n\s*continue\n\s*\}/);
  assert.match(PS1, /\nexit 1\n?$/, "a folder never made right ends in failure");
  for (const condition of conditions(PS1)) assert.ok(!notAPipeline(condition), `if (${condition}) is not one pipeline`);
});

test("the ACL programdata.ps1 writes is the one the app accepts", () => {
  const sids: Record<string, string> = {};
  for (const m of PS1.matchAll(/^\$(\w+) = New-Object System\.Security\.Principal\.SecurityIdentifier '([^']+)'$/gm)) sids[m[1]!] = m[2]!;
  const bits: Record<string, number> = {
    FullControl: 0x1f01ff,
    ListDirectory: 0x1,
    WriteData: 0x2,
    CreateDirectories: 0x4,
    ReadExtendedAttributes: 0x8,
    WriteExtendedAttributes: 0x10,
    Traverse: 0x20,
    DeleteSubdirectoriesAndFiles: 0x40,
    ReadAttributes: 0x80,
    WriteAttributes: 0x100,
    Delete: 0x10000,
    ReadPermissions: 0x20000,
    ChangePermissions: 0x40000,
    TakeOwnership: 0x80000,
    Modify: 0x301bf,
    Write: 0x116,
  };
  const rules: AclRule[] = [...PS1.matchAll(/FileSystemAccessRule\(\$(\w+), '([^']+)', (\$all|'None'), '(\w+)', 'Allow'\)/g)].map((m) => ({
    sid: sids[m[1]!]!,
    // .NET adds Synchronize to every allow entry.
    rights: m[2]!.split(", ").reduce((sum, name) => {
      assert.ok(name in bits, `a right this test doesn't know: ${name}`);
      return sum | bits[name]!;
    }, 0x100000),
    inherit: m[3] === "$all" ? 3 : 0,
    propagate: m[4] === "InheritOnly" ? 2 : 0,
    allow: true,
    inherited: false,
  }));
  assert.deepEqual(rules.map((r) => r.sid), ["S-1-5-18", "S-1-5-32-544", "S-1-5-32-545", "S-1-3-0"]);
  assert.ok(rules.every((r) => Number.isFinite(r.rights)));
  assert.equal(parentProblem({ exists: true, directory: true, reparse: false, owner: sids.admins!, protected: true, rules }), null);
  const users = rules.find((r) => r.sid === "S-1-5-32-545")!;
  assert.equal(users.inherit, 0, "users' entry is for the folder itself only");
  assert.equal(users.rights & (0x2 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000), 0, "no file, delete, attribute writes, ACL or owner change");
});

test("the app's PowerShell scripts parse: balanced brackets, conditions that are one pipeline, no double quote, the folder from the environment", () => {
  for (const [name, script] of Object.entries(POWERSHELL_SCRIPTS)) {
    assert.ok(!script.includes('"'), name);
    assert.equal(bracketProblem(script), null, name);
    for (const condition of conditions(script)) assert.ok(!notAPipeline(condition), `${name}: if (${condition}) is not one pipeline`);
    assert.match(script, /\$env:RACCOONVTT_FOLDER/, name);
  }
  const make = POWERSHELL_SCRIPTS.MAKE_FOLDER;
  assert.ok(!/\bNew-Item\b|\bmkdir\b|icacls|Set-Acl/i.test(make), "made with its security descriptor, never tightened after");
  assert.match(make, /\$s\.SetOwner\(\$u\); \$s\.SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(make, /\[void\]\[System\.IO\.Directory\]::CreateDirectory\(\$env:RACCOONVTT_FOLDER, \$s\); \[pscustomobject\]@\{ user = \$u\.Value; facts = \(Facts \$env:RACCOONVTT_FOLDER\) \}/);
  assert.match(make, /\$u = \[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User;[^]*CreateDirectory/, "this user's SID is read before the folder is made");
});
