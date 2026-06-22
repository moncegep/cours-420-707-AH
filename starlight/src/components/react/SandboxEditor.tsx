import { useState, useCallback } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { php } from '@codemirror/lang-php';
import { githubLight } from '@uiw/codemirror-theme-github';

// ─────────────────────────────────────────────────────────────────────────────
// MOTEUR PRINCIPAL : php-wasm (du vrai PHP, compilé en WebAssembly)
//
// Charge le runtime depuis le CDN au premier « Exécuter » (≈ plusieurs Mo, une
// seule fois, ensuite mis en cache par le navigateur). Une unique instance est
// partagée par tous les éditeurs de la page (via globalThis) pour ne télécharger
// le binaire qu'une fois ; on appelle refresh() avant chaque exécution pour que
// les exercices restent isolés les uns des autres.
//
// Version épinglée pour la stabilité — relève-la quand tu veux.
// ─────────────────────────────────────────────────────────────────────────────
// '@' via decodeURIComponent : non évalué par esbuild, donc le motif
// « php-wasm@version » n'apparaît dans AUCUN octet (source ni bundle),
// ce qui évite toute réécriture par un filtre d'obfuscation d'e-mail.
const PHP_WASM_AT = decodeURIComponent('%40');
const PHP_WASM_URL = 'https://cdn.jsdelivr.net/npm/php-wasm' + PHP_WASM_AT + '0.1.0/PhpWeb.mjs';

// Import natif du navigateur, masqué derrière new Function pour qu'aucun bundler
// (Vite/Astro) n'essaie de le réécrire ni de le pré-bundler — cause classique du
// « Failed to fetch dynamically imported module » qui faisait basculer en simulé.
const cdnImport: (url: string) => Promise<any> = new Function('u', 'return import(u)') as any;

type PhpBucket = { php: any; out: string[]; err: string[] };

function loadPhp(): Promise<PhpBucket> {
  const g = globalThis as any;
  if (g.__aeh707Php) return g.__aeh707Php as Promise<PhpBucket>;

  g.__aeh707Php = (async (): Promise<PhpBucket> => {
    try {
      const mod: any = await cdnImport(PHP_WASM_URL);
      const PhpWeb = mod.PhpWeb;
      const instance = new PhpWeb();
      const bucket: PhpBucket = { php: instance, out: [], err: [] };

      // Écouteurs posés une seule fois : chaque exécution vide les tampons puis
      // les relit une fois run() résolu.
      instance.addEventListener('output', (e: any) => bucket.out.push(String(e.detail ?? '')));
      instance.addEventListener('error', (e: any) => bucket.err.push(String(e.detail ?? '')));

      return bucket;
    } catch (e) {
      delete g.__aeh707Php; // ne jamais mettre en cache un échec : autorise un nouvel essai
      throw e;
    }
  })();

  return g.__aeh707Php as Promise<PhpBucket>;
}

function phpDejaCharge(): boolean {
  return Boolean((globalThis as any).__aeh707Php);
}

// php-wasm attend un script PHP complet ; on ajoute la balise si elle manque.
function avecBalisesPhp(code: string): string {
  return /<\?php|<\?=/.test(code) ? code : `<?php\n${code}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTEUR DE SECOURS : interpréteur simulé (hors-ligne)
//
// Utilisé automatiquement si php-wasm ne peut pas se charger (pas de réseau,
// CDN bloqué) ou si l'on passe forceSimulated. Volontairement limité : pas de
// function {…}, foreach/for/if. Pour ces cas, php-wasm est requis.
// ─────────────────────────────────────────────────────────────────────────────
function runPHPSimule(code: string) {
  code = code.replace(/<\?php\b/g, '').replace(/\?>/g, '');
  const lines = code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const vars: Record<string, any> = {};
  const output: string[] = [];
  const errors: string[] = [];

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  function splitConcat(s: string): string[] {
    const out: string[] = [];
    let depth = 0, quote = '', cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (depth === 0 && ch === ' ' && s[i + 1] === '.' && s[i + 2] === ' ') { out.push(cur); cur = ''; i += 2; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function splitArgs(s: string): string[] {
    const out: string[] = [];
    let depth = 0, quote = '', cur = '';
    for (const ch of s) {
      if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  const resolve = (expr: string): any => {
    expr = expr.trim();
    const concatParts = splitConcat(expr);
    if (concatParts.length > 1) {
      return concatParts.map((p) => { const v = resolve(p.trim()); return v !== undefined ? String(v) : ''; }).join('');
    }
    if (expr.startsWith('"') && expr.endsWith('"')) {
      let s = expr.slice(1, -1);
      s = s.replace(/\\n/g, '\n');
      s = s.replace(/\{\$(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : ''));
      s = s.replace(/\$(\w+)\[['"]?(\w+)['"]?\]/g, (_, name, key) => {
        const arr = vars[name];
        return arr && typeof arr === 'object' && arr[key] !== undefined ? String(arr[key]) : '';
      });
      s = s.replace(/\$(\w+)/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `$${name}`));
      return s;
    }
    if (expr.startsWith("'") && expr.endsWith("'")) return expr.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr.startsWith('[') && expr.endsWith(']')) {
      const inner = expr.slice(1, -1).trim();
      if (!inner) return [];
      if (inner.includes('=>')) {
        const obj: Record<string, any> = {};
        inner.split(',').forEach((p) => { const [k, v] = p.split('=>'); if (k && v) obj[resolve(k.trim())] = resolve(v.trim()); });
        return obj;
      }
      return inner.split(',').map((s) => resolve(s.trim()));
    }
    const idxMatch = expr.match(/^\$(\w+)\[['"]?(\w+)['"]?\]$/);
    if (idxMatch) { const arr = vars[idxMatch[1]]; return arr && typeof arr === 'object' ? arr[idxMatch[2]] : undefined; }
    if (expr.includes(' ?? ')) {
      const [left, right] = expr.split(' ?? ');
      const lv = resolve(left.trim());
      return lv !== undefined && lv !== null ? lv : resolve(right.trim());
    }
    if (/^\$\w+$/.test(expr)) return vars[expr.slice(1)];
    const fnMatch = expr.match(/^(\w+)\((.*)?\)$/);
    if (fnMatch) {
      const fn = fnMatch[1];
      const args = fnMatch[2] ? splitArgs(fnMatch[2]).map((a) => resolve(a.trim())) : [];
      switch (fn) {
        case 'strlen': return typeof args[0] === 'string' ? args[0].length : 0;
        case 'count': return Array.isArray(args[0]) ? args[0].length : (typeof args[0] === 'object' && args[0] ? Object.keys(args[0]).length : 0);
        case 'strtoupper': return typeof args[0] === 'string' ? args[0].toUpperCase() : args[0];
        case 'strtolower': return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
        case 'ucfirst': return typeof args[0] === 'string' ? args[0].charAt(0).toUpperCase() + args[0].slice(1) : args[0];
        case 'trim': return typeof args[0] === 'string' ? args[0].trim() : args[0];
        case 'str_repeat': return String(args[0] ?? '').repeat(Math.max(0, Number(args[1]) || 0));
        case 'htmlspecialchars': return esc(String(args[0] ?? ''));
        case 'urlencode': return encodeURIComponent(String(args[0] ?? '')).replace(/%20/g, '+');
        case 'number_format': {
          const n = Number(args[0]) || 0;
          const dec = args[1] !== undefined ? Number(args[1]) : 0;
          const dp = args[2] !== undefined ? String(args[2]) : '.';
          const ts = args[3] !== undefined ? String(args[3]) : ',';
          const fixed = Math.abs(n).toFixed(dec);
          const parts = fixed.split('.');
          parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ts);
          return (n < 0 ? '-' : '') + parts[0] + (parts[1] ? dp + parts[1] : '');
        }
        case 'array_sum': return Array.isArray(args[0]) ? args[0].reduce((a, b) => a + (Number(b) || 0), 0) : 0;
        case 'in_array': return Array.isArray(args[1]) ? args[1].includes(args[0]) : false;
        case 'implode': return Array.isArray(args[1]) ? args[1].join(String(args[0])) : '';
        case 'var_dump': {
          const dump = (v: any): string => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'boolean') return `bool(${v})`;
            if (typeof v === 'number') return Number.isInteger(v) ? `int(${v})` : `float(${v})`;
            if (typeof v === 'string') return `string(${v.length}) "${v}"`;
            if (Array.isArray(v)) return `array(${v.length}) [${v.map(dump).join(', ')}]`;
            if (typeof v === 'object') return `array(${Object.keys(v).length}) {${Object.entries(v).map(([k, val]) => `"${k}" => ${dump(val)}`).join(', ')}}`;
            return String(v);
          };
          output.push(dump(args[0]));
          return null;
        }
        default: return `[fn:${fn}?]`;
      }
    }
    if (/^.+[\+\-\*\/\%].+$/.test(expr) && !expr.includes('"') && !expr.includes("'")) {
      try {
        const resolved = expr.replace(/\$(\w+)/g, (_, n) => { const v = vars[n]; return typeof v === 'number' ? String(v) : '0'; });
        return new Function(`return (${resolved})`)();
      } catch { return NaN; }
    }
    return expr;
  };

  for (const raw of lines) {
    const line = raw.trim().replace(/;$/, '');
    try {
      const appendMatch = line.match(/^\$(\w+)\s*\.=\s*(.+)$/);
      if (appendMatch) { vars[appendMatch[1]] = String(vars[appendMatch[1]] ?? '') + String(resolve(appendMatch[2]) ?? ''); continue; }
      const pushMatch = line.match(/^\$(\w+)\[\]\s*=\s*(.+)$/);
      if (pushMatch) { if (!Array.isArray(vars[pushMatch[1]])) vars[pushMatch[1]] = []; vars[pushMatch[1]].push(resolve(pushMatch[2])); continue; }
      const assignMatch = line.match(/^\$(\w+)\s*=\s*(.+)$/);
      if (assignMatch) { vars[assignMatch[1]] = resolve(assignMatch[2]); continue; }
      const echoMatch = line.match(/^(?:echo|print)\s+(.+)$/);
      if (echoMatch) { output.push(String(resolve(echoMatch[1]) ?? '')); continue; }
      if (/^</.test(line) && !/^<\?/.test(line)) { output.push(raw); continue; }
      if (/^\w+\(.*\)$/.test(line)) { resolve(line); continue; }
      if (line) errors.push(`Ligne non reconnue : ${line}`);
    } catch (e: any) {
      errors.push(`Erreur : ${e.message}`);
    }
  }
  return { output: output.join('\n'), errors: errors.join('\n') };
}

// ─── Thème ───
function palette(accent: string) {
  return { accent, soft: accent + '0d', border: accent + '40' };
}

const css = `
.sbx { background:#f8f9fb; border:1px solid #e2e6ed; border-radius:10px; overflow:hidden; }
.sbx-head { display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:9px 14px; border-bottom:1px solid #e2e6ed; background:#f0f2f5; }
.sbx-title { display:flex; align-items:center; gap:8px; min-width:0; }
.sbx-label { font-family:'Fira Code',monospace; font-size:11px; font-weight:700; letter-spacing:.04em; white-space:nowrap; }
.sbx-engine { font-family:'Fira Code',monospace; font-size:9px; font-weight:700; letter-spacing:.03em;
  padding:2px 6px; border-radius:5px; white-space:nowrap; }
.sbx-engine.wasm { background:#4f46e50d; border:1px solid #4f46e540; color:#4f46e5; }
.sbx-engine.sim { background:#c2410c0d; border:1px solid #c2410c40; color:#c2410c; }
.sbx-actions { display:flex; gap:6px; flex:none; }
.sbx-btn { font-family:'Fira Code',monospace; font-size:11px; font-weight:700;
  padding:5px 12px; border-radius:6px; cursor:pointer; transition:transform .08s, filter .15s;
  background:transparent; }
.sbx-btn:hover { filter:brightness(.95); }
.sbx-btn:active { transform:translateY(1px); }
.sbx-btn:disabled { opacity:.55; cursor:default; }
.sbx-btn:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.sbx-ghost { border:1px solid #d7dce6; color:#6b7280; }
.sbx .cm-editor { font-family:'Fira Code',monospace; }
.sbx .cm-editor.cm-focused { outline:none; }
.sbx-out { border-top:1px solid #e2e6ed; padding:9px 14px; font-family:'Fira Code',monospace;
  font-size:12px; line-height:1.6; background:#fafbfc; white-space:pre-wrap; word-break:break-word; min-height:28px; }
.sbx-out-label { font-size:9.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
  color:#94a3b8; margin-bottom:5px; }
.sbx-empty { color:#94a3b8; }
.sbx-out-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:5px; }
.sbx-seg { display:inline-flex; border:1px solid #d7dce6; border-radius:7px; overflow:hidden; flex:none; }
.sbx-seg button { font-family:'Fira Code',monospace; font-size:10px; font-weight:700; padding:3px 9px;
  border:0; background:transparent; color:#6b7280; cursor:pointer; transition:background .12s; }
.sbx-seg button + button { border-left:1px solid #d7dce6; }
.sbx-seg button:hover { background:#eef0f3; }
.sbx-out-text { white-space:pre-wrap; word-break:break-word; }
.sbx-out-html { font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif; white-space:normal;
  background:#fff; border:1px solid #e2e6ed; border-radius:8px; padding:10px 12px; color:#1c2230; line-height:1.5; }
.sbx-out-html :first-child { margin-top:0; }
.sbx-out-html :last-child { margin-bottom:0; }
.sbx-loading { display:flex; align-items:center; gap:8px; color:#6b7280; font-size:11.5px; }
.sbx-spin { width:13px; height:13px; border:2px solid #cbd5e1; border-top-color:#4f46e5;
  border-radius:50%; animation:sbx-rot .7s linear infinite; }
@keyframes sbx-rot { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sbx-btn { transition:none; } .sbx-spin { animation:none; } }
`;

type Props = {
  /** Code initial affiché dans l'éditeur. */
  initialCode?: string;
  /** Alias rétrocompatible de initialCode. */
  placeholder?: string;
  /** Étiquette de l'en-tête. */
  label?: string;
  /** Couleur d'accent (hex 6 chiffres). */
  accent?: string;
  /** Éditeur en lecture seule. */
  readOnly?: boolean;
  /** Forcer l'interpréteur simulé (utile hors-ligne ou pour de simples instructions). */
  forceSimulated?: boolean;
};

export default function SandboxEditor({
  initialCode,
  placeholder = '',
  label = 'Essayer — PHP',
  accent = '#4f46e5',
  readOnly = false,
  forceSimulated = false,
}: Props) {
  const start = initialCode ?? placeholder;
  const [code, setCode] = useState(start);
  const [result, setResult] = useState<{ output: string; errors: string } | null>(null);
  const [engine, setEngine] = useState<'wasm' | 'sim'>(forceSimulated ? 'sim' : 'wasm');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'running'>('idle');
  const [copied, setCopied] = useState(false);
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [view, setView] = useState<'text' | 'html'>('text');
  const pal = palette(accent);
  const busy = phase !== 'idle';

  const runSimule = useCallback(() => {
    setEngine('sim');
    setResult(runPHPSimule(code));
  }, [code]);

  const handleRun = useCallback(async () => {
    if (forceSimulated) {
      setWasmError(null);
      runSimule();
      return;
    }
    try {
      setWasmError(null);
      setPhase(phpDejaCharge() ? 'running' : 'loading');
      const bucket = await loadPhp();
      setPhase('running');
      // Réinitialise l'état PHP entre deux exécutions (exercices isolés,
      // évite « Cannot redeclare function »). syncfs/locks peut échouer sans
      // persistance : on l'ignore, pib_refresh a déjà réinitialisé l'état.
      if (typeof bucket.php.refresh === 'function') {
        try { await bucket.php.refresh(); } catch { /* ignore */ }
      }
      bucket.out.length = 0;
      bucket.err.length = 0;
      await bucket.php.run(avecBalisesPhp(code));
      await new Promise((r) => setTimeout(r, 0)); // laisse les sorties se vider
      setEngine('wasm');
      setResult({ output: bucket.out.join(''), errors: bucket.err.join('') });
    } catch (e: any) {
      // php-wasm indisponible : on montre la raison ET on dépanne en simulé.
      setWasmError(e?.message ? String(e.message) : String(e));
      runSimule();
    } finally {
      setPhase('idle');
    }
  }, [code, forceSimulated, runSimule]);

  const handleReset = useCallback(() => {
    setCode(start);
    setResult(null);
  }, [start]);

  const handleCopy = useCallback(() => {
    try {
      navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* presse-papiers indisponible */ }
  }, [code]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!busy) handleRun();
    }
  };

  return (
    <div className="sbx" onKeyDown={onKeyDown}>
      <style>{css}</style>

      <div className="sbx-head">
        <div className="sbx-title">
          <span className="sbx-label" style={{ color: pal.accent }}>🧪 {label}</span>
          <span className={`sbx-engine ${engine}`}>{engine === 'wasm' ? 'php-wasm' : 'simulé'}</span>
        </div>
        <div className="sbx-actions">
          <button className="sbx-btn sbx-ghost" onClick={handleCopy} aria-label="Copier le code">
            {copied ? '✓ Copié' : '⧉ Copier'}
          </button>
          {code !== start && (
            <button className="sbx-btn sbx-ghost" onClick={handleReset} aria-label="Réinitialiser le code" disabled={busy}>
              ↺ Réinitialiser
            </button>
          )}
          <button
            className="sbx-btn"
            onClick={handleRun}
            disabled={busy}
            aria-label="Exécuter le code (Ctrl+Entrée)"
            title="Ctrl + Entrée"
            style={{ background: pal.soft, border: `1px solid ${pal.border}`, color: pal.accent }}
          >
            {phase === 'loading' ? '⏳ Chargement…' : phase === 'running' ? '… Exécution' : '▶ Exécuter'}
          </button>
        </div>
      </div>

      <CodeMirror
        value={code}
        onChange={setCode}
        extensions={[php()]}
        theme={githubLight}
        editable={!readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
        }}
        style={{ fontSize: 13.5 }}
      />

      {phase === 'loading' && (
        <div className="sbx-out">
          <div className="sbx-loading">
            <span className="sbx-spin" />
            Premier lancement : téléchargement de PHP (quelques Mo, une seule fois)…
          </div>
        </div>
      )}

      {phase === 'idle' && result && (
        <div className="sbx-out">
          {wasmError && (
            <div style={{ color: '#c2410c', marginBottom: 6, fontSize: 11 }}>
              ⚠ php-wasm indisponible : {wasmError} — exécuté en mode simulé.
            </div>
          )}
          <div className="sbx-out-row">
            <span className="sbx-out-label">Sortie</span>
            {result.output && (
              <div className="sbx-seg" role="group" aria-label="Format d'affichage de la sortie">
                <button
                  onClick={() => setView('text')}
                  style={view === 'text' ? { background: pal.soft, color: pal.accent } : undefined}
                >Texte</button>
                <button
                  onClick={() => setView('html')}
                  style={view === 'html' ? { background: pal.soft, color: pal.accent } : undefined}
                >HTML rendu</button>
              </div>
            )}
          </div>
          {result.output && view === 'text' && (
            <div className="sbx-out-text" style={{ color: '#16a34a' }}>{result.output}</div>
          )}
          {result.output && view === 'html' && (
            <div className="sbx-out-html" dangerouslySetInnerHTML={{ __html: result.output }} />
          )}
          {result.errors && <div className="sbx-out-text" style={{ color: '#dc2626' }}>{result.errors}</div>}
          {!result.output && !result.errors && <span className="sbx-empty">(aucune sortie)</span>}
        </div>
      )}
    </div>
  );
}