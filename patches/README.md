# Document converter security patches

These version-scoped patches are applied by Bun during installation. They preserve
the existing converter APIs; they do not replace the OCR engine or permission logic.

- `node-tesseract-ocr@2.2.1`: replace shell command construction with `execFile`
  and separate literal arguments. Preserve local-file, Buffer, array, URL-stream,
  stdout and error contracts. `binary` is an executable path, not a shell command.
- `markitdown-js@0.0.14`: both distributed ESM and CJS consumers import the directly
  declared maintained `@xmldom/xmldom` LTS package. Iterate attributes through the
  standard array-like `NamedNodeMap` interface, preserving attribute order and
  existing valid XML/RSS/Atom output. Reject parser warnings/errors rather than
  continuing with repaired malformed XML.

The upstream packages still declare their old versions and legacy `xmldom`
dependency. Audit findings can therefore remain visible after mitigation. Nothing
is dismissed or suppressed. The old XML module is not imported by either patched
consumer. Other consumers and advisory paths need their own assessment.

Reproduce with `bun install --frozen-lockfile` and `bun run test:converter-security`.
The tests prohibit shell execution at the mocked process boundary and also use a
real executable fixture to verify literal argv/stdin. They cover both XML module
formats, valid-output golden cases, and malformed/multiple-root rejection.

Where Tesseract is already provisioned, run `bun run test:converter-ocr-runtime`.
This uses a generated test image only, exercising real local-file and Buffer OCR,
error propagation, and the actual ImageConverter OCR call. It performs no install,
provider request or application launch. Metadata and model-description methods
are replaced in that explicit test because they are outside the OCR contract.

Known packaging limit: the existing standalone-server assembly omits MarkItDown
and its large transitive dependency closure. These source-level tests do not prove
that standalone document conversion is available. Treat that packaging gap as a
separate unresolved integration gate; the native-image/MCP package tests alone do
not cover it.
