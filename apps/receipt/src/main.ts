import { mountApp } from './app.ts';

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

mountApp(document, {
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  loadSampleLogo: async () => {
    const res = await fetch('./logo-ejemplo.png');
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  },
  readFile: async (file) => new Uint8Array(await file.arrayBuffer()),
  today,
  debounceMs: 400,
});
