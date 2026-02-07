const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
<path d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z" fill="#1171DF"/>
</svg>`;

// Not prerendered — sirv infers Content-Type from the .ico extension (image/x-icon)
// which doesn't match the SVG content. Serving dynamically ensures correct headers.
export function GET() {
  return new Response(FAVICON, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  });
}
