// collect_rhino_acad_cmdlog.mjs
// Turns a Rhino (or AutoCAD) command-history dump into an Obsidian note.
//
// Usage: node collect_rhino_acad_cmdlog.mjs <dump.txt>
//
// - The wiki root is the folder above this script (C:\wiki).
// - Rhino notes go to <wiki>/rhino/command-log/<date>.md
//   (a dump whose file name contains "acad" goes to <wiki>/autocad/command-log/).
// - Rhino's command history covers the whole Rhino session, so when a new dump
//   continues the previous one, the same note is updated instead of a new one.
// - Rhino aliases (ww -> MaxViewport, ...) are read, never written, from the
//   Rhino 8 settings file so an alias and its command count as one step.
//
// Exit code: 0 = note written or nothing new, 1 = error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WIKI_ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(SCRIPT_DIR, ".state");
const RHINO_SETTINGS = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "McNeel", "Rhinoceros", "8.0", "settings", "settings-Scheme__Default.xml"
);

const COMMAND_LINE = /^(?:Command|명령)\s*:\s*(.+?)\s*$/;
const OPENED_FILE = /Successfully read file "([^"]+)"/i;

function fail(message) {
  console.log(`[collect] ${message}`);
  process.exit(1);
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// "! _PointsOn" -> "PointsOn", "'_Zoom _Extents" -> "Zoom", "-_Layer" -> "Layer"
function commandName(text) {
  for (const token of text.trim().split(/\s+/)) {
    const name = token.replace(/^[!'_\-]+/, "");
    if (name) return name;
  }
  return "";
}

function loadRhinoSettings() {
  const aliases = new Map();   // lower-case alias -> macro
  const canonical = new Map(); // lower-case command -> Rhino's own spelling
  let xml;
  try {
    xml = fs.readFileSync(RHINO_SETTINGS, "utf8");
  } catch {
    return { aliases, canonical };
  }
  const aliasBlock = xml.match(/<entry key="AliasDictionary">([\s\S]*?)<\/entry>/);
  if (aliasBlock) {
    for (const m of aliasBlock[1].matchAll(/<value key="([^"]+)">([^<]*)<\/value>/g)) {
      aliases.set(decodeXml(m[1]).toLowerCase(), decodeXml(m[2]));
    }
  }
  const counts = xml.match(/<child key="Command Use Counts"[^>]*>([\s\S]*?)<\/child>/);
  if (counts) {
    for (const m of counts[1].matchAll(/<entry key="([^"]+)">/g)) {
      const name = decodeXml(m[1]).replace(/^[0-9a-f-]{36}\./i, "");
      canonical.set(name.toLowerCase(), name);
    }
  }
  return { aliases, canonical };
}

function parseDump(text, settings) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const raw = [];   // every "Command:" entry as typed; used to recognise the same session
  const steps = []; // { name, alias }
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const opened = lines[i].match(OPENED_FILE);
    if (opened) {
      const base = path.win32.basename(opened[1]);
      if (!files.includes(base)) files.push(base);
      continue;
    }
    const m = lines[i].match(COMMAND_LINE);
    if (!m) continue;
    const typed = m[1];
    raw.push(typed);
    const macro = settings.aliases.get(typed.toLowerCase());
    if (macro !== undefined && commandName(macro)) {
      const target = commandName(macro);
      steps.push({ name: target, alias: typed });
      // Rhino echoes the alias's macro as the next "Command:" line; count it once.
      const next = (lines[i + 1] || "").match(COMMAND_LINE);
      if (next && commandName(next[1]).toLowerCase() === target.toLowerCase()) {
        raw.push(next[1]);
        i++;
      }
    } else {
      const name = commandName(typed);
      if (name) steps.push({ name, alias: null });
    }
  }
  return { raw, steps, files };
}

const pad = (n) => String(n).padStart(2, "0");
const cell = (s) => String(s).replace(/\|/g, "\\|");

function buildNote({ label, source, sessionStart, stamp, steps, files, display }) {
  const counts = new Map();
  for (const s of steps) {
    const name = display(s.name);
    const entry = counts.get(name) || { count: 0, aliases: new Set() };
    entry.count++;
    if (s.alias) entry.aliases.add(s.alias);
    counts.set(name, entry);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  const pairs = new Map();
  for (let k = 1; k < steps.length; k++) {
    const key = `${display(steps[k - 1].name)} → ${display(steps[k].name)}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  const repeated = [...pairs.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);

  // Collapse runs of the same command: "Scale1D ×2"
  const sequence = [];
  for (const s of steps) {
    const name = display(s.name);
    const last = sequence[sequence.length - 1];
    if (last && last.name === name) {
      last.times++;
      if (s.alias) last.aliases.add(s.alias);
    } else {
      sequence.push({ name, times: 1, aliases: new Set(s.alias ? [s.alias] : []) });
    }
  }

  const out = [];
  out.push("---");
  out.push(`source: ${source}`);
  out.push(`session_start: ${sessionStart}`);
  out.push(`updated: ${stamp}`);
  out.push(`commands: ${steps.length}`);
  out.push(`tags: [${source}, command-log]`);
  out.push("---", "");
  out.push(`# ${label} 작업 기록 ${sessionStart}`, "");
  out.push(`\`rhino_cmd_history_dump.py\`가 자동으로 만든 노트예요. 같은 ${label} 세션에서 다시 실행하면 이 노트가 갱신돼요.`, "");
  if (files.length) out.push(`열었던 파일: ${files.join(", ")}`, "");

  out.push("## 많이 쓴 명령", "");
  out.push("| 명령 | 횟수 | 입력한 별칭 |", "| --- | --- | --- |");
  for (const [name, e] of ranked) {
    out.push(`| ${cell(name)} | ${e.count} | ${cell([...e.aliases].join(", "))} |`);
  }
  out.push("");

  out.push("## 반복된 흐름", "");
  if (repeated.length) {
    for (const [pair, n] of repeated) out.push(`- ${pair} (${n}회)`);
  } else {
    out.push("_두 번 이상 반복된 흐름이 아직 없어요._");
  }
  out.push("");

  out.push("## 작업 순서", "");
  sequence.forEach((s, idx) => {
    const alias = s.aliases.size ? ` \`${[...s.aliases].join(", ")}\`` : "";
    const times = s.times > 1 ? ` ×${s.times}` : "";
    out.push(`${idx + 1}. ${s.name}${times}${alias}`);
  });
  out.push("");
  return out.join("\n");
}

// ---- main ----
const input = process.argv[2];
if (!input) fail("Usage: node collect_rhino_acad_cmdlog.mjs <dump.txt>");
if (!fs.existsSync(input)) fail(`Dump file not found: ${input}`);

const isAcad = /acad/i.test(path.basename(input));
const source = isAcad ? "autocad" : "rhino";
const label = isAcad ? "AutoCAD" : "Rhino";
const settings = isAcad ? { aliases: new Map(), canonical: new Map() } : loadRhinoSettings();
const display = (name) => settings.canonical.get(name.toLowerCase()) || name;

const { raw, steps, files } = parseDump(fs.readFileSync(input, "utf8"), settings);
if (steps.length === 0) {
  console.log("[collect] No commands found in the dump; nothing written.");
  process.exit(0);
}

const stateFile = path.join(STATE_DIR, `${source}_last_session.json`);
let state = null;
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {
  state = null;
}

const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stamp = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const toFs = (rel) => path.join(WIKI_ROOT, ...rel.split("/"));

const sameSession =
  state && Array.isArray(state.raw) && state.raw.length > 0 &&
  state.raw.length <= raw.length &&
  state.raw.every((c, k) => c === raw[k]) &&
  typeof state.note === "string" && fs.existsSync(toFs(state.note));

if (sameSession && state.raw.length === raw.length) {
  console.log(`[collect] No new commands since the last run; ${state.note} unchanged.`);
  process.exit(0);
}

let noteRel;
let sessionStart;
if (sameSession) {
  noteRel = state.note;
  sessionStart = state.sessionStart || today;
} else {
  sessionStart = today;
  const dir = `${source}/command-log`;
  noteRel = `${dir}/${today}.md`;
  for (let n = 2; fs.existsSync(toFs(noteRel)); n++) noteRel = `${dir}/${today}-${n}.md`;
}

const note = buildNote({ label, source, sessionStart, stamp, steps, files, display });
fs.mkdirSync(path.dirname(toFs(noteRel)), { recursive: true });
fs.writeFileSync(toFs(noteRel), note, "utf8");

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ note: noteRel, sessionStart, raw }, null, 2), "utf8");

console.log(`[collect] ${sameSession ? "Updated" : "Created"} ${noteRel} (${steps.length} commands)`);
