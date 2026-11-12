# Astra landing

Independent, buildless public frontend for the existing Railway `astra-landing` Bun Function. It does not build, deploy or import the agent, WhatsApp, customer dashboard or Ollama.

## Work locally

```sh
cd landing
npm ci --ignore-scripts
npm run build
npm test
npm run dev
```

`dist/railway-function.ts` is the complete production Function source. `dist/build.json` records the release and exact SHA-256 of the public asset bundle. Build output is ignored; production is reproducible from the source and lockfile. The local preview never connects to PostgreSQL or sends requests to the agent; its contact API is unavailable unless a browser test explicitly intercepts it.

## Verification

The independent `astra-landing.yml` workflow runs the API/content tests, Chromium/Firefox/WebKit tests, nine viewport profiles, WCAG AA checks, visual comparisons and a before/after performance experiment. Form success/failure/retry tests use declared synthetic responses; the API contract tests execute the generated runtime against a SQL double in memory. They do not establish real PostgreSQL persistence. Production verification must remain read-only unless explicitly authorized otherwise.

The first workflow run generates candidate screenshot references and immediately repeats the visual tests. Review the uploaded images before committing those references. Subsequent runs compare against committed references without regenerating them. Performance observations use 1.6 Mbps, 150 ms latency and a 4× CPU slowdown, with three samples per viewport/version; they are lab observations, not field Core Web Vitals or a real-user INP claim.

`tests/baseline/bundle.json` contains only the captured public landing assets before this redesign, with asset paths adjusted for local comparison. No authenticated page or customer data is included.

## Scope and deployment

- Railway project: `e2e1a32c-425e-46bc-8b70-25db268f9b78`
- Production environment: `96a29635-81c6-4eef-aee2-11575514ff2a`
- Landing service only: `860efe48-d6f6-41ed-bb1b-815dfccbd54c`
- Public URL: https://astra-landing-production.up.railway.app/
- Checkout: https://pay.cakto.com.br/CubL455

Read the current Function source and release immediately before an update. Deploy the tested generated Function only to the landing service; poll its deployment until `SUCCESS`, then verify the public HTML, assets, links, security headers and `/health`. The Function includes the new public bundle, avoiding separate variable updates. Keep the existing environment variables, origin checks, rate limits, consent, form idempotency and deletion contract intact.

`rollback/production-before-redesign.ts` is the exact Function source read before the work. The older `LANDING_ASSETS_*` environment variables are deliberately preserved, so updating this landing service back to that source restores its prior public bundle. Never roll back another service to recover a landing change.

## Visual assets

The three official brand vectors and the favicon were obtained from the existing production page and are preserved byte for byte. All other UI illustrations are HTML/CSS with explicitly fictional data. No generative logo was used. SVG interface symbols share one stroke system.

DM Sans is self-hosted from `@fontsource-variable/dm-sans@5.3.0`, licensed under the included `FONT_LICENSE.txt`. The public WOFF2 is limited to the weight range 400–750 and the Latin characters used here. `create-social.py` renders the original logo into the share card; it requires Pillow, fontTools with Brotli, and CairoSVG. The committed share image makes those Python packages unnecessary for normal builds.

## Research, 12 November 2026

Primary product pages reviewed: [Meu Assessor](https://meuassessor.com/), [Pierre](https://lp.pierre.finance/), [Jota](https://jota.ai/), [Zapia](https://zapia.com/?lang=pt), [Focca](https://focca-ai.com/), [ZapGastos](https://zapgastos.com/), [Toki](https://toki.com/), [Organizze](https://www.organizze.com.br/), and [Linear](https://linear.app/).

Applied principles: concrete examples before long feature lists; a visible relationship between the conversation and the organized result; progressive explanation; one simple plan; calm typography and spacing; direct, Brazilian language. Competitor statistics, financial integrations, endorsements, discounts and testimonials were not transferred to Astra.

The price copy follows the user's final instruction: display R$ 19,90/mês. No automatic access or unverified delivery time is promised. Live AI is not exposed on the public demonstration because there is no validated, public, abuse-limited demo endpoint in scope.
