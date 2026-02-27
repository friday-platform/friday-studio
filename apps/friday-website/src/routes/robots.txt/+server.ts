export const prerender = true;

const BODY = `User-agent: *
Allow: /

Sitemap: https://hellofriday.ai/sitemap.xml
Sitemap: https://docs.hellofriday.ai/sitemap.xml
`;

export function GET() {
  return new Response(BODY, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
