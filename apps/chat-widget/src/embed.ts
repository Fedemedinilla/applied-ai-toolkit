// The entry the build emits as embed/chat.js, a classic script with no imports. A site embeds it
// with one tag, and the tag carries the settings:
//
//   <script src="https://widget.example/embed/chat.js" data-tenant="vivero-demo" async></script>
//
// data-api overrides the backend's base URL; without it the backend is the origin of this file.
// document.currentScript is read at the top level, the only moment it points at this tag.

import { mountWidget, optionsFromScript } from './widget.ts';

const script = document.currentScript;
const options = script instanceof HTMLScriptElement ? optionsFromScript(script) : null;
if (options) void mountWidget(options);
else console.warn('chat widget: the script tag needs a valid data-tenant');
