# Marketing website

## Security Headers

All security headers are deployed via Cloudflare Transform Rules.

**Rule location:** [Cloudflare Dashboard > hellofriday.ai > Rules > Transform Rules](https://dash.cloudflare.com/b0d95e349d41c781b1dd063f9cb220d3/hellofriday.ai/rules/transform-rules/modify-response-header)

### Headers

| Header | Value |
|--------|-------|
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()` |
| `Permissions-Policy-Report-Only` | `camera=();report-to=default, microphone=();report-to=default, geolocation=();report-to=default, payment=();report-to=default, usb=();report-to=default` |
| `Cross-Origin-Embedder-Policy-Report-Only` | `require-corp; report-to="default"` |
| `Cross-Origin-Opener-Policy-Report-Only` | `same-origin; report-to="default"` |
| `Report-To` | `{"group":"default","max_age":10886400,"endpoints":[{"url":"https://dm35suqd.uriports.com/reports"}],"include_subdomains":true}` |
| `NEL` | `{"report_to":"default","max_age":2592000,"include_subdomains":true,"failure_fraction":1.0}` |
| `Reporting-Endpoints` | `default="https://dm35suqd.uriports.com/reports"` |
| `Content-Security-Policy` | See below |

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

## Reporting

All security violations and network errors are reported to [URIports](https://uriports.com):

| Report Type | Endpoint |
|-------------|----------|
| CSP violations | `https://dm35suqd.uriports.com/reports/report` |
| Network errors (NEL) | `https://dm35suqd.uriports.com/reports` |
| Permissions Policy | `https://dm35suqd.uriports.com/reports` |
| COEP/COOP violations | `https://dm35suqd.uriports.com/reports` |
