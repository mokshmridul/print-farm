A tiny, hand-written printer profile set for unit tests and the CI flow test:
the shape the image generates into `/data/printer` (machine, one process per
layer height, `printer.json`), with no filament presets, as a real shop has
none until the owner uploads theirs. Not an OrcaSlicer preset and never
shipped in the image (the Dockerfile drops `test-fixtures`).
