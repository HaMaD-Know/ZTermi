import '@fontsource/cascadia-mono/latin-400.css';
import '@fontsource/cascadia-mono/latin-600.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/terminal.css';
import './styles/editor.css';
import { createNativePlatform, createWebPlatform, isNativeIOS } from './platform';
import type { PromptSecretOptions } from './platform/vault';
import { TerminiaApp } from './ui/app';
import { dialog } from './ui/overlays';
import { h } from './ui/dom';

/** Browser preview only: there is no Keychain, so the secret stays in memory for this tab. */
async function webSecretPrompter(options: PromptSecretOptions): Promise<string | null> {
  const result = await dialog({
    title: options.title,
    message: h(
      'div',
      null,
      h('p', null, options.message),
      h('p', { class: 'small muted' }, `Browser preview: kept in memory for this tab only and sent only to ${options.allowedOrigins.join(', ')}. In the iPad app it is stored in the Keychain.`),
    ),
    input: { type: 'password', placeholder: options.placeholder, label: options.label, validate: (v) => (v.trim().length >= 8 ? null : 'That does not look like a token.') },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Save', value: true, kind: 'primary' },
    ],
    cancelValue: false,
  });
  return result.value ? result.text : null;
}

const root = document.getElementById('app');
if (root) {
  const platform = isNativeIOS() ? createNativePlatform() : createWebPlatform(webSecretPrompter);
  new TerminiaApp(root, platform).start().catch((error: unknown) => {
    console.error(error);
    root.textContent = `Terminia could not start: ${(error as Error)?.message ?? String(error)}`;
  });
}
