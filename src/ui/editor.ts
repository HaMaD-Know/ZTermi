import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, StreamLanguage, bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, type LanguageSupport, type StreamParser } from '@codemirror/language';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { kotlin } from '@codemirror/legacy-modes/mode/clike';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basename, extname } from '../core/paths';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.variableName, t.special(t.variableName)], color: 'var(--fg)' },
  { tag: [t.tagName, t.heading], color: 'var(--syn-tag)', fontWeight: '600' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--fg-dim)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--fg-faint)' },
  { tag: t.invalid, color: 'var(--err)' },
  { tag: t.link, color: 'var(--info)', textDecoration: 'underline' },
]);

const legacy = (parser: StreamParser<unknown>) => StreamLanguage.define(parser);

export interface LanguageInfo {
  name: string;
  load: () => LanguageSupport | Extension;
}

const LANGUAGES: Record<string, LanguageInfo> = {
  '.ts': { name: 'TypeScript', load: () => javascript({ typescript: true }) },
  '.tsx': { name: 'TypeScript JSX', load: () => javascript({ typescript: true, jsx: true }) },
  '.mts': { name: 'TypeScript', load: () => javascript({ typescript: true }) },
  '.js': { name: 'JavaScript', load: () => javascript() },
  '.mjs': { name: 'JavaScript', load: () => javascript() },
  '.cjs': { name: 'JavaScript', load: () => javascript() },
  '.jsx': { name: 'JavaScript JSX', load: () => javascript({ jsx: true }) },
  '.json': { name: 'JSON', load: () => json() },
  '.html': { name: 'HTML', load: () => html() },
  '.htm': { name: 'HTML', load: () => html() },
  '.css': { name: 'CSS', load: () => css() },
  '.py': { name: 'Python', load: () => python() },
  '.yml': { name: 'YAML', load: () => yaml() },
  '.yaml': { name: 'YAML', load: () => yaml() },
  '.xml': { name: 'XML', load: () => xml() },
  '.plist': { name: 'Property list', load: () => xml() },
  '.storyboard': { name: 'Storyboard', load: () => xml() },
  '.svg': { name: 'SVG', load: () => xml() },
  '.md': { name: 'Markdown', load: () => markdown() },
  '.ps1': { name: 'PowerShell', load: () => legacy(powerShell) },
  '.psm1': { name: 'PowerShell', load: () => legacy(powerShell) },
  '.psd1': { name: 'PowerShell data', load: () => legacy(powerShell) },
  '.sh': { name: 'Shell', load: () => legacy(shell) },
  '.bash': { name: 'Shell', load: () => legacy(shell) },
  '.toml': { name: 'TOML', load: () => legacy(toml) },
  '.gradle': { name: 'Gradle', load: () => legacy(groovy) },
  '.kts': { name: 'Kotlin script', load: () => legacy(kotlin) },
  '.kt': { name: 'Kotlin', load: () => legacy(kotlin) },
  '.swift': { name: 'Swift', load: () => legacy(swift) },
  '.properties': { name: 'Properties', load: () => legacy(properties) },
  '.ini': { name: 'INI', load: () => legacy(properties) },
};

const BY_NAME: Record<string, LanguageInfo> = {
  dockerfile: { name: 'Dockerfile', load: () => legacy(dockerFile) },
  '.gitignore': { name: 'Ignore file', load: () => legacy(shell) },
  '.terminiaignore': { name: 'Ignore file', load: () => legacy(shell) },
  '.env.example': { name: 'Environment', load: () => legacy(properties) },
  gradlew: { name: 'Shell', load: () => legacy(shell) },
  podfile: { name: 'Podfile', load: () => legacy(shell) },
};

export function languageFor(path: string): LanguageInfo | null {
  return BY_NAME[basename(path).toLowerCase()] ?? LANGUAGES[extname(path)] ?? null;
}

const theme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-content': { caretColor: 'var(--target-local)', padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
});

export function createState(doc: string, path: string, onChange: () => void, onSave: () => void): EditorState {
  const language = languageFor(path);
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(highlight),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      theme,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange();
      }),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': `Editor: ${basename(path)}` }),
      language ? language.load() : [],
    ],
  });
}

export { EditorView };
