export const prerender = true;

const pageModules = import.meta.glob("/src/routes/**/+page.svelte");

const pages = Object.keys(pageModules)
  .map((path) => path.replace("/src/routes", "").replace("/+page.svelte", ""))
  .map((path) => path || "/")
  .sort();

const lastmod = new Date().toISOString().split("T")[0];

function priority(page: string): string {
  if (page === "/") return "1.0";
  if (page === "/announcement") return "0.8";
  return "0.5";
}

function changefreq(page: string): string {
  if (page === "/") return "weekly";
  if (page === "/announcement") return "monthly";
  return "yearly";
}

export function GET() {
  const origin = "https://hellofriday.ai";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (page) =>
      `  <url>
    <loc>${origin}${page}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq(page)}</changefreq>
    <priority>${priority(page)}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>`;

  return new Response(xml.trim(), { headers: { "content-type": "application/xml" } });
}
