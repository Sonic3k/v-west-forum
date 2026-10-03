// Image providers: which external service a hotlinked image came from.
// Shared by tools/rescue-images.js (local folders) and the panel (database records).
export const PROVIDERS = [
  ['photobucket', /(^|\.)photobucket\.com$/],
  ['facebook', /(^|\.)(fbcdn\.net|facebook\.com)$|^fbcdn-[\w.-]*\.akamaihd\.net$/],
  ['imageshack', /(^|\.)imageshack\.(us|com)$/],
  ['tinypic', /(^|\.)tinypic\.com$/],
  ['flickr', /(^|\.)(flickr\.com|staticflickr\.com)$/],
  ['google', /(^|\.)(blogspot\.com|googleusercontent\.com|ggpht\.com|blogger\.com)$/],
  ['imgur', /(^|\.)imgur\.com$/],
  ['zing', /(^|\.)(zing\.vn|zdn\.vn)$/],
  ['vcmedia', /(^|\.)vcmedia\.vn$/],
  ['vnexpress', /(^|\.)(vnexpress\.net|vnecdn\.net)$/],
];

export function providerOf(host) {
  const h = String(host || '').toLowerCase();
  const hit = PROVIDERS.find(([, re]) => re.test(h));
  return hit ? hit[0] : 'other';
}
