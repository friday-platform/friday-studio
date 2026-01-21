# Marketing website

## Content Security Policy (CSP)

### CSP header

```
default-src 'self';
script-src 'self' 'report-sample' 'unsafe-eval' 'unsafe-inline' https://app.framerstatic.com/ https://cdn-cookieyes.com https://events.framer.com/script https://framerusercontent.com/sites/ https://framerusercontent.com/modules/ https://framer.com/m/ https://framer.com/edit/ https://framer.com/bootstrap https://static.cloudflareinsights.com/ *.clarity.ms https://c.bing.com https://www.googletagmanager.com/ https://www.google-analytics.com/;
style-src 'self' 'report-sample' 'unsafe-inline' https://app.framerstatic.com https://fonts.googleapis.com;
object-src 'none';
connect-src 'self' https://app.framerstatic.com/ https://api.framer.com/ https://events.framer.com/ https://framer.com/ https://framerusercontent.com https://cdn-cookieyes.com *.cookieyes.com *.clarity.ms https://c.bing.com *.google-analytics.com https://analytics.google.com/ https://*.analytics.google.com https://*.googletagmanager.com;
font-src 'self' data: https://app.framerstatic.com https://fonts.gstatic.com/s/ https://framerusercontent.com/assets/;
form-action 'self';
frame-ancestors 'self';
frame-src 'self' https://framer.com;
img-src 'self' data: https://cdn-cookieyes.com/assets/images/ https://framerusercontent.com/images/ *.google-analytics.com *.googletagmanager.com *.clarity.ms https://c.bing.com;
manifest-src 'self';
media-src 'self' https://framerusercontent.com/assets/;
report-uri https://dm35suqd.uriports.com/reports/report;
report-to default;
upgrade-insecure-requests;
worker-src 'none';
```

### Resource inventory

| Service | Purpose | Domains |
|---------|---------|---------|
| Framer | Website hosting | framer.com, framerusercontent.com, app.framerstatic.com, events.framer.com, api.framer.com |
| Google Analytics | Analytics | www.googletagmanager.com, www.google-analytics.com, analytics.google.com |
| Microsoft Clarity | Session recording | *.clarity.ms |
| CookieYes | Cookie consent | cdn-cookieyes.com, *.cookieyes.com |
| Cloudflare | Web analytics | static.cloudflareinsights.com |
| Bing | Clarity sync | c.bing.com |
| Google Fonts | Typography | fonts.gstatic.com, fonts.googleapis.com |

### Deployment

CSP is deployed via Cloudflare Transform Rules (HTTP Response Header Modification).

**Rule location:** [Cloudflare Dashboard > hellofriday.ai > Rules > Transform Rules](https://dash.cloudflare.com/b0d95e349d41c781b1dd063f9cb220d3/hellofriday.ai/rules/transform-rules/modify-response-header)

**Rule ID:** `2f4ca43e8a824504bc9f8921678831fd`

To update the CSP:
1. Edit the rule in Cloudflare Dashboard, or
2. Use the Cloudflare API to update the ruleset

### CSP violation reporting

Violations are reported to [URIports](https://uriports.com) at `https://dm35suqd.uriports.com/reports/report`.
