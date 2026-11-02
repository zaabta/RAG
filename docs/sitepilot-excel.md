# SitePilot Excel workflow

This local proof of concept imports one explicitly named `.xlsx` file into the isolated PostgreSQL schema `sitepilot_excel_test` and the restricted TypeGraph `sitepilot_excel_test` tenant. It uses the configured local multilingual E5 embedding model; it does not call a paid inference API.

## Configure

Set `DATABASE_URL` in the local environment and set `SITEPILOT_ACCESS_GROUP_ID` to the authenticated analyst group. Do not use a caller supplied group ID in a deployed service: the service must derive it from trusted authentication. The importer refuses to run without a group. The workbook is parsed in memory and sensitive columns are redacted before structured storage or embedding. The Excel file itself is ignored by Git under `test-data/`.

## Commands

```sh
pnpm run sitepilot:excel-inspect -- /path/to/workbook.xlsx reports/sitepilot-excel-inspection.json
pnpm run sitepilot:excel-audit -- /path/to/workbook.xlsx
pnpm run sitepilot:excel-preview -- /path/to/workbook.xlsx
pnpm run sitepilot:excel-import -- --input /path/to/workbook.xlsx
pnpm run sitepilot:excel-query -- exact /path/to/workbook.xlsx 4
pnpm run sitepilot:excel-query -- search /path/to/workbook.xlsx 'Form No 4 hangi ihlal nedeniyle düzenlendi?'
pnpm run sitepilot:excel-query -- analytics /path/to/workbook.xlsx violations
pnpm run sitepilot:excel-query -- analytics /path/to/workbook.xlsx regions
pnpm run sitepilot:excel-query -- analytics /path/to/workbook.xlsx suspensions
pnpm run sitepilot:excel-test
```

Inspection reports include worksheet structure and aggregate relationship match counts, never cell values. Preview is access-group gated. Import is idempotent: unchanged records are not re-embedded, changed records are upserted, and missing records are soft-deleted from the relational store and removed from TypeGraph. Structured filters use fixed parameterized SQL; arbitrary SQL is not exposed.

## Scope and limitations

The parser is bounded to 25 MB, 100,000 rows per worksheet, and 500 columns. Formula expressions are never evaluated; cached results are used with warnings, while formulas without cached values remain unavailable. Row level records are chunks, and long narrative fields can be split with repeated record identity. Sensitive fields are detected by header patterns and values are additionally scrubbed from narrative text. This is a conservative proof of concept, not a substitute for a reviewed data classification policy; validate sensitive headers for each new workbook. The access group configuration is application enforced and must be wired to trusted authentication in production.

PDF, Word, Markdown and plain text parsers, reranking, and graph extraction are not included.
