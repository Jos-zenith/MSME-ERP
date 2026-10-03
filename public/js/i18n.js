// Tiny i18n: English text is the key; other languages live in js/lang/<code>.js as { "English": "translated" }.
// A missing key simply falls back to English, so a partly translated language still works.
export const LANGS = {
  en: 'English',
  hi: 'हिन्दी',
  ta: 'தமிழ்',
  te: 'తెలుగు',
};

let dict = {};
let current = 'en';

export async function setLang(code) {
  if (!LANGS[code]) code = 'en';
  dict = code === 'en' ? {} : (await import(`./lang/${code}.js`)).default;
  current = code;
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  return code;
}
export const getLang = () => current;

export function t(key, vars) {
  let s = dict[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}
