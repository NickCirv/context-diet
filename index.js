#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { watch } from 'fs';
import { homedir } from 'os';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CONTEXT_WINDOW = 200_000;
const CHARS_PER_TOKEN = 4;
const ALWAYS_LOADED_TOKENS = 2_000; // CLAUDE.md + rules baseline

const ALWAYS_EXCLUDE = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'vendor', '__pycache__', '.tox', 'venv', '.venv',
  'coverage', '.nyc_output', '.cache', 'tmp', 'temp',
  '.DS_Store', 'Thumbs.db',
];

const ALWAYS_EXCLUDE_FILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
];

const EXCLUDE_EXTENSIONS = [
  '.min.js', '.min.css', '.map', '.wasm', '.ico', '.png', '.jpg',
  '.jpeg', '.gif', '.svg', '.webp', '.ttf', '.woff', '.woff2',
  '.eot', '.otf', '.mp4', '.mp3', '.wav', '.zip', '.tar', '.gz',
  '.bin', '.exe', '.dll', '.so', '.dylib', '.pyc', '.class',
];

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;
const bold = (text) => c('bold', text);
const dim = (text) => c('dim', text);

// ─── TOKEN ESTIMATION ────────────────────────────────────────────────────────

function estimateTokens(content) {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function estimateTokensFromSize(bytes) {
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString()}k`;
  return n.toString();
}

function formatNumber(n) {
  return n.toLocaleString();
}

// ─── FILE SYSTEM HELPERS ─────────────────────────────────────────────────────

function loadClaudeIgnore(projectPath) {
  const patterns = new Set(ALWAYS_EXCLUDE);
  const claudeIgnorePath = path.join(projectPath, '.claudeignore');
  const gitIgnorePath = path.join(projectPath, '.gitignore');

  for (const p of [gitIgnorePath, claudeIgnorePath]) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          patterns.add(trimmed.replace(/\/$/, ''));
        }
      }
    }
  }

  return patterns;
}

function isExcluded(filePath, excludePatterns, projectRoot) {
  const rel = path.relative(projectRoot, filePath);
  const parts = rel.split(path.sep);
  const basename = path.basename(filePath);
  const ext = path.extname(filePath);
  const fullExt = basename.includes('.min.') ? '.min' + ext : ext;

  // Check always-exclude extensions
  if (EXCLUDE_EXTENSIONS.some(e => basename.endsWith(e))) return true;

  // Check always-exclude files
  if (ALWAYS_EXCLUDE_FILES.includes(basename)) return true;

  // Check patterns
  for (const pattern of excludePatterns) {
    if (pattern === basename) return true;
    if (parts.some(p => p === pattern)) return true;
    if (rel === pattern) return true;
    if (rel.startsWith(pattern + path.sep)) return true;
    // Glob-ish: *.ext
    if (pattern.startsWith('*.') && basename.endsWith(pattern.slice(1))) return true;
  }

  return false;
}

function walkDirectory(dir, excludePatterns, projectRoot, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return [];

  let entries = [];
  let dirEntries;

  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of dirEntries) {
    const fullPath = path.join(dir, entry.name);

    if (isExcluded(fullPath, excludePatterns, projectRoot)) continue;

    if (entry.isDirectory()) {
      entries = entries.concat(walkDirectory(fullPath, excludePatterns, projectRoot, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        entries.push({ path: fullPath, size: stat.size });
      } catch {
        // skip unreadable
      }
    }
  }

  return entries;
}

function walkDirectoryAll(dir, projectRoot, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return [];

  let entries = [];
  let dirEntries;

  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of dirEntries) {
    const fullPath = path.join(dir, entry.name);

    // Only skip .git for raw totals
    if (entry.name === '.git') continue;

    if (entry.isDirectory()) {
      entries = entries.concat(walkDirectoryAll(fullPath, projectRoot, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        entries.push({ path: fullPath, size: stat.size });
      } catch {
        // skip
      }
    }
  }

  return entries;
}

function categorizeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go',
       '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.swift', '.kt', '.php',
       '.sh', '.bash', '.zsh', '.lua', '.r', '.scala', '.clj', '.ex', '.exs'].includes(ext)) {
    return 'source';
  }
  if (['.md', '.mdx', '.rst', '.txt', '.adoc'].includes(ext)) return 'docs';
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.env.example',
       '.config.js', '.config.ts', '.xml', '.csv'].includes(ext) ||
      basename.includes('config') || basename.includes('.rc')) return 'config';
  if (['.html', '.css', '.scss', '.sass', '.less', '.vue', '.svelte'].includes(ext)) return 'frontend';
  if (ALWAYS_EXCLUDE_FILES.includes(path.basename(filePath))) return 'lockfile';
  return 'other';
}

function getHogCategory(filePath, projectRoot) {
  const rel = path.relative(projectRoot, filePath);
  const topDir = rel.split(path.sep)[0];
  if (topDir === filePath) return path.basename(filePath); // top-level file
  return topDir;
}

// ─── SCAN COMMAND ────────────────────────────────────────────────────────────

function runScan(targetPath) {
  const projectPath = path.resolve(targetPath || '.');
  const projectName = path.basename(projectPath);

  console.log(`\n${c('cyan', '━').repeat(42)}`);
  console.log(`  ${bold('CONTEXT DIET REPORT')}`);
  console.log(`  Project: ${c('yellow', './' + path.relative(process.cwd(), projectPath) || projectName)}`);
  console.log(`${c('cyan', '━').repeat(42)}\n`);

  // Scan ALL files (no exclusions except .git) for total
  const allFiles = walkDirectoryAll(projectPath, projectPath);
  const totalTokensRaw = allFiles.reduce((sum, f) => sum + estimateTokensFromSize(f.size), 0);

  // Group hogs from ALL files
  const hogMap = new Map();
  for (const f of allFiles) {
    const rel = path.relative(projectPath, f.path);
    const topDir = rel.split(path.sep)[0];
    const isDir = topDir !== path.basename(f.path) || fs.statSync(path.join(projectPath, topDir)).isDirectory() === false;
    const key = rel.split(path.sep).length > 1 ? topDir + '/' : path.basename(f.path);
    hogMap.set(key, (hogMap.get(key) || 0) + estimateTokensFromSize(f.size));
  }

  const sortedHogs = [...hogMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Scan CLEAN files (with exclusions)
  const excludePatterns = loadClaudeIgnore(projectPath);
  const cleanFiles = walkDirectory(projectPath, excludePatterns, projectPath);
  const totalTokensClean = cleanFiles.reduce((sum, f) => sum + estimateTokensFromSize(f.size), 0);

  const ratio = totalTokensRaw / CONTEXT_WINDOW;
  const percentFits = Math.round((CONTEXT_WINDOW / totalTokensRaw) * 100);

  // Print budget summary
  console.log(`  ${c('dim', 'Claude\'s context window:')}  ${bold(formatNumber(CONTEXT_WINDOW))} tokens`);

  const rawColor = ratio > 2 ? 'red' : ratio > 1 ? 'yellow' : 'green';
  const ratioStr = ratio > 1 ? ` ${c(rawColor, '← ' + ratio.toFixed(1) + 'x too big')}` : c('green', ' ← fits!');
  console.log(`  ${c('dim', 'Your project (all files):')}  ${c(rawColor, bold(formatNumber(totalTokensRaw)))} tokens${ratioStr}`);

  if (totalTokensClean < totalTokensRaw) {
    const cleanColor = totalTokensClean > CONTEXT_WINDOW ? 'yellow' : 'green';
    console.log(`  ${c('dim', 'After .claudeignore:')}      ${c(cleanColor, bold(formatNumber(totalTokensClean)))} tokens`);
  }

  if (ratio > 1) {
    console.log(`\n  ${c('dim', 'What fits in one session:')} ${c('yellow', percentFits + '%')} of your project`);
  }

  // Top hogs
  console.log(`\n${bold(c('yellow', 'TOP CONTEXT HOGS:'))}`);
  for (const [key, tokens] of sortedHogs) {
    const pct = Math.round((tokens / totalTokensRaw) * 100);
    const isExcludedByDefault = ALWAYS_EXCLUDE.some(e => key.startsWith(e)) ||
      ALWAYS_EXCLUDE_FILES.some(f => key === f);

    let advice = '';
    let icon = '📄';
    if (key.endsWith('/')) {
      icon = '📁';
      if (isExcludedByDefault) advice = c('dim', '→ EXCLUDE (add to .claudeignore)');
      else if (tokens > 50_000) advice = c('dim', '→ Load specific files only');
    } else {
      if (isExcludedByDefault) advice = c('dim', '→ EXCLUDE (not useful in context)');
      else if (tokens > 10_000) advice = c('dim', '→ Too large — use with subagent');
      else if (tokens > 5_000) advice = c('dim', '→ Load on demand only');
    }

    const bar = '█'.repeat(Math.max(1, Math.min(20, Math.round(pct / 5))));
    const barColor = pct > 30 ? 'red' : pct > 10 ? 'yellow' : 'green';
    console.log(`  ${icon} ${key.padEnd(28)} ${c(barColor, formatNumber(tokens).padStart(10))} tokens  (${String(pct).padStart(2)}%)  ${advice}`);
  }

  // Claudeignore recommendations
  const shouldExclude = [];
  for (const [key] of sortedHogs) {
    if (ALWAYS_EXCLUDE.some(e => key.startsWith(e)) || ALWAYS_EXCLUDE_FILES.some(f => key === f)) {
      shouldExclude.push(key.replace(/\/$/, '/'));
    }
  }

  if (shouldExclude.length > 0 || true) {
    console.log(`\n${bold(c('cyan', 'RECOMMENDED .claudeignore:'))}`);
    const recs = [
      'node_modules/', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'dist/', 'build/', '.next/', '.git/', '*.min.js', '*.min.css',
      'coverage/', '*.map', '*.log',
    ];
    for (const r of recs) {
      const exists = allFiles.some(f => {
        const rel = path.relative(projectPath, f.path);
        return rel.startsWith(r.replace('/', path.sep)) || rel === r || path.basename(rel) === r;
      });
      if (exists) {
        console.log(`  ${c('dim', r)}`);
      }
    }
    console.log(`\n  ${c('dim', 'Run:')} ${c('green', 'context-diet diet --write')} ${c('dim', 'to generate .claudeignore')}`);
  }

  // Smart loading strategy from clean files
  if (cleanFiles.length > 0) {
    const srcFiles = cleanFiles
      .filter(f => categorizeFile(f.path) === 'source')
      .sort((a, b) => a.size - b.size);

    const small = srcFiles.filter(f => estimateTokensFromSize(f.size) < 3_000).slice(0, 4);
    const medium = srcFiles.filter(f => {
      const t = estimateTokensFromSize(f.size);
      return t >= 3_000 && t < 8_000;
    }).slice(0, 3);
    const large = srcFiles.filter(f => estimateTokensFromSize(f.size) >= 8_000).slice(0, 3);

    if (small.length || medium.length || large.length) {
      console.log(`\n${bold(c('cyan', 'SMART LOADING STRATEGY:'))}`);

      if (small.length) {
        const smallTokens = small.reduce((s, f) => s + estimateTokensFromSize(f.size), 0);
        const names = small.map(f => path.relative(projectPath, f.path)).join(', ');
        console.log(`  ${c('green', '✓')} ${c('dim', 'Load together (small):')}   ${c('white', names)}  ${c('dim', '[' + formatNumber(smallTokens) + ' tokens]')}`);
      }
      if (medium.length) {
        const medTokens = medium.reduce((s, f) => s + estimateTokensFromSize(f.size), 0);
        const names = medium.map(f => path.relative(projectPath, f.path)).join(', ');
        console.log(`  ${c('yellow', '↗')} ${c('dim', 'Load on demand:')}          ${c('white', names)}  ${c('dim', '[~' + formatTokens(medTokens) + ' tokens]')}`);
      }
      if (large.length) {
        const lgTokens = large.reduce((s, f) => s + estimateTokensFromSize(f.size), 0);
        const names = large.map(f => path.relative(projectPath, f.path)).join(', ');
        console.log(`  ${c('red', '🤖')} ${c('dim', 'Delegate to subagent:')}    ${c('white', names)}  ${c('dim', '[~' + formatTokens(lgTokens) + ' tokens each]')}`);
      }
    }
  }

  // Budget breakdown
  const usableTokens = CONTEXT_WINDOW - ALWAYS_LOADED_TOKENS;
  const coreTokens = Math.min(totalTokensClean, Math.round(usableTokens * 0.05));
  const remainingTokens = usableTokens - coreTokens;
  const sessionsEst = totalTokensClean > 0 ? Math.round(CONTEXT_WINDOW / (totalTokensClean / Math.max(cleanFiles.length, 1) * 20)) : 'N/A';

  console.log(`\n${bold(c('cyan', 'CONTEXT BUDGET:'))} ${c('dim', '(200k total)')}`);
  console.log(`  ${c('dim', 'Rules/CLAUDE.md:')}      ~${formatNumber(ALWAYS_LOADED_TOKENS)} tokens ${c('dim', '(always loaded)')}`);
  console.log(`  ${c('dim', 'Core files (est):')}     ~${formatNumber(coreTokens)} tokens`);
  console.log(`  ${c('dim', 'Remaining budget:')}    ${c('green', bold(formatNumber(remainingTokens)))} tokens`);
  if (typeof sessionsEst === 'number') {
    console.log(`  ${c('dim', 'Sessions before compaction:')} ~${sessionsEst} typical sessions`);
  }

  console.log(`\n${c('cyan', '━').repeat(42)}\n`);
}

// ─── AUDIT COMMAND ───────────────────────────────────────────────────────────

function runAudit() {
  const claudeDir = path.join(homedir(), '.claude');
  const projectsDir = path.join(claudeDir, 'projects');

  console.log(`\n${c('cyan', '━').repeat(42)}`);
  console.log(`  ${bold('CLAUDE CODE SESSION AUDIT')}`);
  console.log(`${c('cyan', '━').repeat(42)}\n`);

  if (!fs.existsSync(claudeDir)) {
    console.log(`  ${c('yellow', '!')} ~/.claude not found — Claude Code not installed or no sessions yet.\n`);
    return;
  }

  // Scan ~/.claude for session/conversation files
  const sessionFiles = [];
  function findJsonl(dir, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) findJsonl(fp, depth + 1);
        else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) {
          try {
            const stat = fs.statSync(fp);
            sessionFiles.push({ path: fp, size: stat.size, mtime: stat.mtimeMs });
          } catch {}
        }
      }
    } catch {}
  }

  findJsonl(path.join(claudeDir, 'projects'));

  if (sessionFiles.length === 0) {
    console.log(`  ${c('yellow', '!')} No session files found in ~/.claude/projects/`);
    console.log(`  ${c('dim', 'Claude Code stores sessions as JSONL files after conversations.')}\n`);
  } else {
    sessionFiles.sort((a, b) => b.mtime - a.mtime);
    const recent = sessionFiles.slice(0, 10);
    const totalSize = sessionFiles.reduce((s, f) => s + f.size, 0);

    console.log(`  ${c('green', '✓')} Found ${sessionFiles.length} session file(s) — ${formatTokens(estimateTokensFromSize(totalSize))} tokens total\n`);

    // Analyze file frequency across sessions
    const fileFrequency = new Map();
    const bashOutputSizes = [];
    let totalMessages = 0;
    let largestOutput = 0;
    let largestOutputFile = '';

    for (const sf of recent) {
      try {
        const content = fs.readFileSync(sf.path, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            totalMessages++;

            // Track tool uses
            if (msg.type === 'tool_use' || (msg.message && msg.message.type === 'tool_use')) {
              const tool = msg.tool_name || (msg.message && msg.message.name);
              const input = msg.input || (msg.message && msg.message.input) || {};
              const filePath = input.file_path || input.path || input.command;
              if (filePath && (tool === 'Read' || tool === 'Write' || tool === 'Edit')) {
                fileFrequency.set(filePath, (fileFrequency.get(filePath) || 0) + 1);
              }
            }

            // Track bash outputs
            if (msg.type === 'tool_result' || (msg.message && msg.message.type === 'tool_result')) {
              const content = msg.content || (msg.message && msg.message.content);
              if (typeof content === 'string' && content.length > 1000) {
                const tokens = estimateTokens(content);
                bashOutputSizes.push(tokens);
                if (tokens > largestOutput) {
                  largestOutput = tokens;
                  largestOutputFile = sf.path;
                }
              }
            }
          } catch {}
        }
      } catch {}
    }

    // Show most frequently accessed files
    if (fileFrequency.size > 0) {
      const sorted = [...fileFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      console.log(`${bold(c('yellow', 'FREQUENTLY LOADED FILES:'))}`);
      for (const [fp, count] of sorted) {
        let size = 0;
        try { size = fs.statSync(fp).size; } catch {}
        const tokens = estimateTokensFromSize(size);
        const sessions = recent.length;
        const pct = Math.round((count / sessions) * 100);
        const flagColor = pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green';
        console.log(`  ${c(flagColor, String(pct + '%').padStart(4))} of sessions  ${path.basename(fp).padEnd(30)} ${c('dim', formatNumber(tokens) + ' tokens')}`);
      }
      console.log();
    }

    // Bash output analysis
    if (bashOutputSizes.length > 0) {
      const avgSize = Math.round(bashOutputSizes.reduce((a, b) => a + b, 0) / bashOutputSizes.length);
      const maxSize = Math.max(...bashOutputSizes);

      console.log(`${bold(c('yellow', 'TOOL OUTPUT ANALYSIS:'))}`);
      console.log(`  ${c('dim', 'Large outputs found:')}  ${bashOutputSizes.length}`);
      console.log(`  ${c('dim', 'Average output size:')} ${formatNumber(avgSize)} tokens`);
      console.log(`  ${c('dim', 'Largest output:')}      ${c('red', formatNumber(maxSize) + ' tokens')}`);

      if (avgSize > 3_000) {
        console.log(`\n  ${c('yellow', '!')} Bash outputs averaged ${formatNumber(avgSize)} tokens`);
        console.log(`  ${c('dim', '→ Consider: context-mode compression plugin for Claude Code')}`);
        console.log(`  ${c('dim', '→ Consider: pipe commands through head/tail to limit output')}`);
      }
      console.log();
    }

    // Session sizes
    console.log(`${bold(c('yellow', 'RECENT SESSION SIZES:'))}`);
    for (const sf of recent.slice(0, 5)) {
      const tokens = estimateTokensFromSize(sf.size);
      const age = Math.round((Date.now() - sf.mtime) / 1000 / 60 / 60);
      const ageStr = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
      const relPath = sf.path.replace(homedir(), '~');
      const color = tokens > 50_000 ? 'red' : tokens > 20_000 ? 'yellow' : 'green';
      console.log(`  ${c(color, formatNumber(tokens).padStart(8))} tokens  ${c('dim', ageStr.padStart(8))}  ${c('dim', relPath)}`);
    }
  }

  // Check for .claudeignore
  const cwd = process.cwd();
  const hasClaudeIgnore = fs.existsSync(path.join(cwd, '.claudeignore'));
  const hasGitIgnore = fs.existsSync(path.join(cwd, '.gitignore'));

  console.log(`\n${bold(c('yellow', 'PROJECT HYGIENE:'))}`);
  console.log(`  ${hasClaudeIgnore ? c('green', '✓') : c('red', '✗')} .claudeignore ${hasClaudeIgnore ? 'found' : c('yellow', 'missing — run: context-diet diet --write')}`);
  console.log(`  ${hasGitIgnore ? c('green', '✓') : c('yellow', '!')} .gitignore ${hasGitIgnore ? 'found' : 'not found'}`);

  console.log(`\n${c('cyan', '━').repeat(42)}\n`);
}

// ─── DIET COMMAND ────────────────────────────────────────────────────────────

function runDiet(writeFile = false) {
  const projectPath = process.cwd();

  console.log(`\n${c('cyan', '━').repeat(42)}`);
  console.log(`  ${bold('CONTEXT DIET RECOMMENDATIONS')}`);
  console.log(`${c('cyan', '━').repeat(42)}\n`);

  const allFiles = walkDirectoryAll(projectPath, projectPath);

  // Detect what exists
  const detectedPatterns = [];
  const recommendations = [];

  // Check for common heavy directories/files
  const checks = [
    { pattern: 'node_modules/', reason: 'Dependencies — never useful in context', tokens: null },
    { pattern: 'vendor/', reason: 'PHP/Ruby dependencies — never useful in context', tokens: null },
    { pattern: '__pycache__/', reason: 'Python cache files', tokens: null },
    { pattern: '.next/', reason: 'Next.js build output', tokens: null },
    { pattern: 'dist/', reason: 'Build output — load source instead', tokens: null },
    { pattern: 'build/', reason: 'Build output — load source instead', tokens: null },
    { pattern: '.git/', reason: 'Git internals — never useful', tokens: null },
    { pattern: 'coverage/', reason: 'Test coverage reports — load on demand', tokens: null },
    { pattern: '*.log', reason: 'Log files — pipe through grep instead', tokens: null },
    { pattern: '*.map', reason: 'Source maps — not needed in context', tokens: null },
    { pattern: '*.min.js', reason: 'Minified JS — load source instead', tokens: null },
    { pattern: '*.min.css', reason: 'Minified CSS — load source instead', tokens: null },
    { pattern: 'package-lock.json', reason: 'Lock file — not useful in context', tokens: null },
    { pattern: 'yarn.lock', reason: 'Lock file — not useful in context', tokens: null },
    { pattern: 'pnpm-lock.yaml', reason: 'Lock file — not useful in context', tokens: null },
    { pattern: 'bun.lockb', reason: 'Lock file — not useful in context', tokens: null },
  ];

  for (const check of checks) {
    const clean = check.pattern.replace('/', '').replace('*.', '');
    const exists = allFiles.some(f => {
      const rel = path.relative(projectPath, f.path);
      if (check.pattern.endsWith('/')) return rel.startsWith(clean + path.sep) || rel.includes(path.sep + clean + path.sep);
      if (check.pattern.startsWith('*.')) return f.path.endsWith(clean);
      return path.basename(f.path) === check.pattern;
    });
    if (exists) {
      detectedPatterns.push(check.pattern);
      recommendations.push(check);
    }
  }

  // Find large files
  const excludePatterns = loadClaudeIgnore(projectPath);
  const cleanFiles = walkDirectory(projectPath, excludePatterns, projectPath);
  const largeFiles = cleanFiles
    .map(f => ({ ...f, tokens: estimateTokensFromSize(f.size) }))
    .filter(f => f.tokens > 8_000)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  if (recommendations.length > 0) {
    console.log(`${bold(c('yellow', 'EXCLUDE FROM CONTEXT:'))}`);
    for (const rec of recommendations) {
      console.log(`  ${c('red', '✗')} ${rec.pattern.padEnd(25)} ${c('dim', rec.reason)}`);
    }
    console.log();
  }

  if (largeFiles.length > 0) {
    console.log(`${bold(c('yellow', 'LARGE FILES — HANDLE WITH CARE:'))}`);
    for (const f of largeFiles) {
      const rel = path.relative(projectPath, f.path);
      console.log(`  ${c('yellow', '!')} ${rel.padEnd(35)} ${c('white', formatNumber(f.tokens))} tokens`);
      console.log(`    ${c('dim', '→ Load only when working on this file; delegate to subagent for analysis')}`);
    }
    console.log();
  }

  // Strategic recommendations
  console.log(`${bold(c('cyan', 'STRATEGIC TIPS:'))}`);
  const tips = [
    ['Use .claudeignore', 'Like .gitignore — tells Claude Code what NOT to load automatically'],
    ['Subagents for large files', 'Files >5k tokens are better read by a subagent that returns a summary'],
    ['context-mode plugin', 'Compresses tool outputs >5KB via FTS5 — install via claude plugin'],
    ['Head/tail bash output', 'Pipe: `git log | head -20` instead of full logs'],
    ['Grep over Read', 'Use Grep tool for search — reads less than opening the full file'],
    ['Summarize node_modules', 'Run `cat package.json` not `ls node_modules/` — same info, 100x smaller'],
  ];
  for (const [title, desc] of tips) {
    console.log(`  ${c('green', '→')} ${bold(title)}`);
    console.log(`    ${c('dim', desc)}`);
  }
  console.log();

  // Generate .claudeignore
  const claudeIgnorePath = path.join(projectPath, '.claudeignore');
  const existingPatterns = fs.existsSync(claudeIgnorePath)
    ? new Set(fs.readFileSync(claudeIgnorePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean))
    : new Set();

  const newPatterns = detectedPatterns.filter(p => !existingPatterns.has(p));

  if (writeFile) {
    const allPatterns = [...existingPatterns, ...newPatterns];
    const content = `# .claudeignore — generated by context-diet
# Like .gitignore but for Claude Code context loading
# Docs: https://github.com/NickCirv/context-diet

# Dependencies
node_modules/
vendor/
.venv/
venv/

# Build output
dist/
build/
.next/
.nuxt/
out/

# Lock files (not useful in context)
package-lock.json
yarn.lock
pnpm-lock.yaml
bun.lockb
composer.lock

# Generated/cache
__pycache__/
*.pyc
.cache/
coverage/
.nyc_output/

# Binary/minified
*.min.js
*.min.css
*.map
*.log
*.wasm

# Media files
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.mp4
*.mp3
*.zip
*.tar.gz
`;
    fs.writeFileSync(claudeIgnorePath, content);
    console.log(`${c('green', '✓')} Generated ${c('white', '.claudeignore')} at ${claudeIgnorePath}`);
    console.log(`  ${c('dim', 'Review and customize for your project.')}\n`);
  } else {
    console.log(`${bold(c('cyan', 'GENERATE .claudeignore:'))}`);
    console.log(`  Run: ${c('green', 'context-diet diet --write')}`);
    if (fs.existsSync(claudeIgnorePath)) {
      console.log(`  ${c('yellow', '!')} .claudeignore already exists — will merge ${newPatterns.length} new patterns`);
    }
    console.log();
  }

  console.log(`${c('cyan', '━').repeat(42)}\n`);
}

// ─── WATCH COMMAND ───────────────────────────────────────────────────────────

function runWatch(targetPath) {
  const projectPath = path.resolve(targetPath || '.');
  let debounceTimer = null;

  function printBudget() {
    const excludePatterns = loadClaudeIgnore(projectPath);
    const files = walkDirectory(projectPath, excludePatterns, projectPath);
    const totalTokens = files.reduce((s, f) => s + estimateTokensFromSize(f.size), 0);

    const now = new Date().toLocaleTimeString();
    const used = totalTokens + ALWAYS_LOADED_TOKENS;
    const pct = Math.round((used / CONTEXT_WINDOW) * 100);
    const barLen = 30;
    const filled = Math.min(barLen, Math.round((used / CONTEXT_WINDOW) * barLen));
    const empty = barLen - filled;
    const barColor = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green';
    const bar = c(barColor, '█'.repeat(filled)) + c('dim', '░'.repeat(empty));

    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `  ${c('dim', now)}  [${bar}]  ${c(barColor, pct + '%')}  ${c('dim', formatNumber(used) + '/' + formatNumber(CONTEXT_WINDOW))} tokens  ${c('dim', files.length + ' files')}`
    );
  }

  console.log(`\n${c('cyan', '━').repeat(42)}`);
  console.log(`  ${bold('CONTEXT BUDGET WATCH')}  ${c('dim', '(Ctrl+C to stop)')}`);
  console.log(`  Watching: ${c('yellow', projectPath)}`);
  console.log(`${c('cyan', '━').repeat(42)}\n`);

  printBudget();

  try {
    watch(projectPath, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules') || filename.includes('.git')) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(printBudget, 300);
    });
  } catch {
    // recursive watch not supported on all platforms
    setInterval(printBudget, 2000);
  }
}

// ─── HELP ────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${bold('context-diet')} ${c('dim', '— Claude context window optimizer')}

${bold('USAGE')}
  context-diet ${c('cyan', 'scan')}   ${c('dim', '[--path <dir>]')}   Scan project and estimate context costs
  context-diet ${c('cyan', 'audit')}                    Audit Claude Code session files
  context-diet ${c('cyan', 'diet')}   ${c('dim', '[--write]')}        Recommendations + .claudeignore generation
  context-diet ${c('cyan', 'watch')}  ${c('dim', '[--path <dir>]')}   Live context budget monitor

${bold('EXAMPLES')}
  ${c('dim', '# Scan current project')}
  context-diet scan

  ${c('dim', '# Scan a specific directory')}
  context-diet scan --path ./my-project

  ${c('dim', '# Generate .claudeignore')}
  context-diet diet --write

  ${c('dim', '# Watch for live budget')}
  context-diet watch

${bold('TOKEN ESTIMATION')}
  ~4 chars = 1 token (rough, works without an API key)
  Claude Code context window: ${formatNumber(CONTEXT_WINDOW)} tokens

${bold('HOW IT WORKS')}
  Pure file analysis — no API key needed. Scans your project,
  estimates token costs per file, and tells you what's burning
  your context budget before you waste it.

  Reads .gitignore and .claudeignore to calculate clean totals.
  Audit mode reads ~/.claude/projects/ for session history.
`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const hasWrite = args.includes('--write');
const pathArg = args.find((a, i) => args[i - 1] === '--path') || args.find((a, i) => i > 0 && !a.startsWith('--'));

switch (command) {
  case 'scan':
    runScan(pathArg);
    break;
  case 'audit':
    runAudit();
    break;
  case 'diet':
    runDiet(hasWrite);
    break;
  case 'watch':
    runWatch(pathArg);
    break;
  case '--help':
  case '-h':
  case 'help':
    printHelp();
    break;
  default:
    if (!command) {
      printHelp();
    } else {
      console.log(`\n${c('red', 'Unknown command:')} ${command}`);
      printHelp();
    }
    break;
}
