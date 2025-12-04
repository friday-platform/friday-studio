export const template = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body>
    <div style="color: #181C2F; font-family: ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'; max-width: 600px; margin: 0 auto; padding: 0; -webkit-font-smoothing: antialiased;">
    {{ content }}
    </div>
    <div style="margin-top: 24px; text-align: center; opacity: .5;">
      {{ sender_info }}
      <p style="font-size: 12px;">Powered by Atlas</p>
    </div>
  </body>
</html>`;
