export const prerender = true;

const pageModules = import.meta.glob("/src/routes/**/+page.svelte");

const pages = Object.keys(pageModules)
  .map((path) => path.replace("/src/routes", "").replace("/+page.svelte", ""))
  .map((path) => path || "/")
  .sort();

export function GET() {
  const origin = "https://hellofriday.ai";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((page) => `  <url><loc>${origin}${page}</loc></url>`).join("\n")}
</urlset>`;

  return new Response(xml.trim(), { headers: { "content-type": "application/xml" } });
}
