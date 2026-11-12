/**
 * Minimal Swagger UI page.
 *
 * Loaded from a CDN — this is a developer-facing dev tool on a single-user
 * privacy-first product, so the CDN dependency is opt-in (only fetched when a
 * developer visits /docs). If that ever becomes a concern, vendor the assets
 * locally and serve from /docs/static/*.
 */

export const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>OwnPilot API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        docExpansion: 'none',
      });
    };
  </script>
</body>
</html>`;
